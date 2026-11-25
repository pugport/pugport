import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Express, Request } from 'express';
import type { InstaboxMonitor } from './instabox.ts';
import { instaboxActionSchema } from './instabox.ts';
import type { InstaboxSsh } from './instabox-ssh.ts';
import { z } from 'zod';
import { refuseUnknownCaller, type CallerKind } from './caller-identity.ts';
import { servicePatternSchema, serviceUnitPattern, type PeerServerStatus } from './node/peer-protocol.ts';
import { PeerRefused, PeerUnreachable } from './devices/peer-client.ts';
import {
  calendarDay,
  type RemoteServer,
  type RemoteServerLive,
  type RemoteServersView,
} from '../shared/remote-servers.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
export const serverSchema = z
  .object({
    name: text(60),
    enrollmentDisabled: z.boolean().optional(),
    provider: text(60).optional(),
    region: text(60).optional(),
    spec: text(120).optional(),
    purpose: text(200).optional(),
    expiresOn: z
      .string()
      .refine((value) => calendarDay(value) !== undefined)
      .optional(),
    credit: text(60).optional(),
    note: text(300).optional(),
    // Never an option (-oProxyCommand=…): a plain Host alias.
    ssh: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/)
      .optional(),
    services: z.array(servicePatternSchema).max(8).optional(),
    statusCommand: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\0\r\n]+$/)
      .optional(),
  })
  // A misspelt field (expiresAt) fails loudly instead of showing a box as having no expiry.
  .strict();
const fileSchema = z.object({ servers: z.array(serverSchema).max(50) }).strict();

/** The hand-written list; a missing file is an empty list, a broken one says where instead of throwing. */
export async function readRemoteServers(file: string): Promise<RemoteServersView> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], file };
    return { servers: [], file, error: '无法读取远程服务器列表。' };
  }
  let data: unknown;
  try {
    // Windows PowerShell and old Notepad save UTF-8 with a byte-order mark.
    data = JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    return { servers: [], file, error: '远程服务器列表格式无效。' };
  }
  const parsed = fileSchema.safeParse(data);
  if (parsed.success) return { servers: parsed.data.servers, file };
  const at = parsed.error.issues[0]?.path.join('.');
  return { servers: [], file, error: '远程服务器列表格式无效。', ...(at ? { errorAt: at } : {}) };
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One read-only pass on the box: two CPU samples a second apart, memory, root disk, services, the status line. */
export function probeScript(server: Pick<RemoteServer, 'services' | 'statusCommand'>): string {
  return [
    'export LC_ALL=C',
    'head -n1 /proc/stat',
    'sleep 1',
    'head -n1 /proc/stat',
    `awk '/^MemTotal:/{print "memory-total", $2} /^MemAvailable:/{print "memory-available", $2}' /proc/meminfo`,
    `df -Pk / | awk 'NR==2{print "disk", $2, $4}'`,
    'echo "cores $(nproc)"',
    'echo "arch $(uname -m)"',
    ...(server.services ?? []).map(
      (pattern) =>
        `systemctl list-units --type=service --all --no-legend --plain ${quote(serviceUnitPattern(pattern))} | awk '{print "service", $1, $3}'`,
    ),
    // Its own stdin, or a command that reads it would swallow the rest of this script.
    ...(server.statusCommand
      ? [`echo "status $(timeout 5 sh -c ${quote(server.statusCommand)} </dev/null 2>/dev/null | head -n1)"`]
      : []),
    'exit 0',
    '',
  ].join('\n');
}

/** A runner's unit name is long (actions.runner.<owner>-<repo>.<runner>.service): show the runner. */
const serviceName = (unit: string) => {
  const name = unit.replace(/\.service$/, '');
  return name.startsWith('actions.runner.') ? name.slice(name.lastIndexOf('.') + 1) : name;
};

export function parseProbe(output: string): Omit<RemoteServerLive, 'online' | 'checkedAt' | 'lastSeenAt' | 'reason'> {
  const reading: ReturnType<typeof parseProbe> = {};
  const cpu: number[][] = [];
  const services: { name: string; state: string }[] = [];
  const number = (value: string | undefined) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const bytes = (kib: string | undefined) => {
    const value = number(kib);
    return value === undefined ? undefined : value * 1024;
  };
  for (const line of output.split(/\r?\n/)) {
    const [key = '', ...words] = line.trim().split(/\s+/);
    const rest = line.trim().slice(key.length).trim();
    if (key === 'cpu') cpu.push(words.slice(0, 8).map(Number));
    else if (key === 'memory-total') reading.memoryTotal = bytes(words[0]);
    else if (key === 'memory-available') reading.memoryAvailable = bytes(words[0]);
    else if (key === 'disk') [reading.diskTotal, reading.diskFree] = [bytes(words[0]), bytes(words[1])];
    else if (key === 'cores') reading.cores = number(words[0]);
    else if (key === 'arch' && rest) reading.arch = rest.slice(0, 40);
    else if (key === 'service' && words[0] && words[1]) services.push({ name: serviceName(words[0]), state: words[1] });
    else if (key === 'status' && rest) reading.status = rest.slice(0, 200);
  }
  // Busy share between the two samples: everything but idle and iowait.
  const [first, second] = cpu;
  if (first?.length === 8 && second?.length === 8 && [...first, ...second].every(Number.isFinite)) {
    const total = second.reduce((sum, value) => sum + value, 0) - first.reduce((sum, value) => sum + value, 0);
    const idle = second[3] + second[4] - first[3] - first[4];
    if (total > 0) reading.cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
  }
  if (services.length) reading.services = services.slice(0, 16);
  return reading;
}

/** The same reading from the server's node (GET /peer/v1/status), with service names shortened alike. */
export function nodeReading(status: PeerServerStatus): ReturnType<typeof parseProbe> {
  const { observedAt: _observedAt, services, ...reading } = status;
  const defined = Object.fromEntries(Object.entries(reading).filter(([, value]) => value !== undefined));
  return {
    ...defined,
    ...(services?.length
      ? { services: services.map((service) => ({ name: serviceName(service.name), state: service.state })) }
      : {}),
  };
}

export type SshRun = (alias: string, script: string) => Promise<string>;

/** The owner's own ssh client and config: key login only (no prompts), short timeouts, no window. */
export const sshRun: SshRun = (alias, script) =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', alias, 'sh', '-s'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error(`ssh exited ${code}`), { code }));
    });
    child.stdin.end(script);
  });

const failure = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  // The node's answer (offline, refused, not upgraded yet) and tunnel failures are already in plain words.
  if (error instanceof PeerUnreachable || error instanceof PeerRefused || Object.hasOwn(Object(error), 'sshOutput'))
    return (error as Error).message.slice(0, 200);
  return code === 'ETIMEDOUT'
    ? '检查超时'
    : code === 'ENOENT'
      ? '找不到 ssh 命令。'
      : code === 255
        ? '连不上：SSH 登录失败或主机没响应。'
        : '检查失败';
};

/** Each box is checked at most this often, and only while the page asks. */
export const remoteCheckIntervalMs = 3 * 60_000;

/** How this computer reaches a box: its own SSH alias, and/or the paired node over the account's access key. */
export type RemoteServerAccess = {
  isSelfServer?: (alias: string) => boolean;
  sshAvailable?: (alias: string) => boolean;
  /** The node can be reached without this computer's own SSH (account-bound access). */
  accountRoute?: (alias: string) => boolean;
  nodeReading?: (alias: string, services: string[]) => Promise<PeerServerStatus>;
};

export class RemoteServerMonitor {
  private readonly live = new Map<string, RemoteServerLive>();
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    private readonly file: string,
    private readonly run: SshRun = sshRun,
    private readonly clock = () => Date.now(),
    readonly instabox?: InstaboxMonitor,
    readonly instaboxSsh?: InstaboxSsh,
    private readonly access?: RemoteServerAccess,
  ) {}
  private ownSsh(alias: string) {
    return this.access?.sshAvailable?.(alias) !== false;
  }
  private viaNode(server: RemoteServer) {
    return !!this.access?.nodeReading && !!this.access.accountRoute?.(server.ssh!);
  }

  /** The list with the last readings; with refresh, boxes not checked for a while are checked first. */
  async view(refresh: boolean | 'instabox'): Promise<RemoteServersView> {
    const view = await readRemoteServers(this.file);
    view.servers = view.servers.filter((server) => !server.ssh || !this.access?.isSelfServer?.(server.ssh));
    const boxes = await this.instabox?.view(refresh !== false, refresh === true);
    const instabox = this.instaboxSsh ? await this.instaboxSsh.decorate(boxes) : boxes;
    const key = (server: RemoteServer) => JSON.stringify([server.ssh, server.services, server.statusCommand]);
    if (refresh === true)
      await Promise.all(
        view.servers
          .filter(
            (server) =>
              server.ssh &&
              (this.ownSsh(server.ssh) || this.viaNode(server)) &&
              !server.ssh.startsWith('pugport-instabox-'),
          )
          .map((server) => this.check(server, key(server))),
      );
    return {
      ...view,
      ...(this.instabox ? { instabox } : {}),
      servers: view.servers.map((server) => {
        const live = server.ssh ? this.live.get(key(server)) : undefined;
        if (server.ssh && !this.ownSsh(server.ssh) && !this.viaNode(server))
          return { ...server, missingSsh: server.ssh };
        return live ? { ...server, live } : server;
      }),
    };
  }

  private check(server: RemoteServer, key: string): Promise<void> {
    const last = this.live.get(key);
    if (last && this.clock() - Date.parse(last.checkedAt) < remoteCheckIntervalMs) return Promise.resolve();
    const alias = server.ssh!;
    const ssh = () => this.run(alias, probeScript(server)).then(parseProbe);
    // The node needs no shell here; a status command does, so it keeps the owner's own SSH where that exists.
    const read =
      this.viaNode(server) && !(server.statusCommand && this.ownSsh(alias))
        ? () =>
            this.access!.nodeReading!(alias, server.services ?? [])
              .then(nodeReading)
              .catch((error) => (this.ownSsh(alias) ? ssh() : Promise.reject(error)))
        : ssh;
    const pending =
      this.running.get(key) ??
      read()
        .then((reading) => {
          const at = new Date(this.clock()).toISOString();
          this.live.set(key, { ...reading, online: true, checkedAt: at, lastSeenAt: at });
        })
        .catch((error) => {
          this.live.set(key, {
            ...this.live.get(key),
            online: false,
            checkedAt: new Date(this.clock()).toISOString(),
            reason: failure(error),
          });
        })
        .finally(() => this.running.delete(key));
    this.running.set(key, pending);
    return pending;
  }
}

/** Mounted behind main's localhost and origin guards; reads go without the session token, like /api/devices. */
export function remoteServerRoutes(
  app: Express,
  monitor: RemoteServerMonitor,
  callerKind: (req: Request) => Promise<CallerKind> = async () => 'executor',
) {
  app.get('/api/remote-servers', async (req, res) => {
    const { refresh } = z.object({ refresh: z.enum(['0', '1', 'instabox']).optional() }).parse(req.query);
    res.json(await monitor.view(refresh === 'instabox' ? 'instabox' : refresh === '1'));
  });
  app.post('/api/remote-servers/instabox/action', async (req, res) => {
    // The owner value comes first; a holder that is an executor, or cannot be told apart from one, is still refused.
    const caller = res.locals.owner ? await callerKind(req).catch((): CallerKind => 'unknown') : 'executor';
    if (caller !== 'other') {
      if (caller === 'unknown') refuseUnknownCaller(res);
      else res.status(403).json({ error: 'Only the PugPort desktop window can do this.' });
      return;
    }
    if (!monitor.instabox) {
      res.status(404).json({ error: '找不到 instabox 机器' });
      return;
    }
    try {
      const input = instaboxActionSchema.parse(req.body);
      if (input.action === 'wake')
        await monitor.instabox.wake(
          input.machineId,
          monitor.instaboxSsh ? (remaining) => monitor.instaboxSsh!.afterWake(input.machineId, remaining) : undefined,
        );
      else await monitor.instabox.action(input);
      res.json(await monitor.view(false));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      res.status(status).json({ error: status === 400 ? 'instabox 操作参数无效' : (error as Error).message });
    }
  });
  const owner = async (req: Request, res: import('express').Response) => {
    // The owner value comes first; a holder that is an executor, or cannot be told apart from one, is still refused.
    const caller = res.locals.owner ? await callerKind(req).catch((): CallerKind => 'unknown') : 'executor';
    if (caller !== 'other') {
      if (caller === 'unknown') refuseUnknownCaller(res);
      else res.status(403).json({ error: 'Only the PugPort desktop window can do this.' });
      return false;
    }
    if (!monitor.instaboxSsh) {
      res.status(404).json({ error: '找不到 instabox 机器' });
      return false;
    }
    return true;
  };
  app.post('/api/remote-servers/instabox/ssh', async (req, res) => {
    if (!(await owner(req, res))) return;
    const { machineId } = z
      .object({ machineId: z.string().regex(/^m_[a-z0-9]+$/) })
      .strict()
      .parse(req.body);
    await monitor.instaboxSsh!.prepare(machineId);
    res.json(await monitor.view(false));
  });
  app.delete('/api/remote-servers/instabox/ssh', async (req, res) => {
    if (!(await owner(req, res))) return;
    await monitor.instaboxSsh!.remove();
    res.json(await monitor.view(false));
  });
}
