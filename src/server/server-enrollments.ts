import { readFile } from 'node:fs/promises';
import { writePrivateConfig } from './private-config.ts';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { refuseUnknownCaller, type CallerKind } from './caller-identity.ts';
import { deviceNameProblem, type DeviceView, type DevicesView } from '../shared/devices.ts';
import type { NodeClient, NodeDeps } from '../cli/node.ts';
import { currentHost, type Host } from './platform/host.ts';
import { manualCommand, runNodeAdd, type EnrollStage } from './node-enroll.ts';
import { readRemoteServers } from './remote-servers.ts';
import type { Devices } from './devices/service.ts';
import type { InstaboxSsh } from './instabox-ssh.ts';
import { removeAccessLines } from './devices/managed-access.ts';

export type ServerEnrollment = {
  id: string;
  server: string;
  stage: EnrollStage;
  status: 'running' | 'completed' | 'failed' | 'needs-command';
  log: string;
  command?: string;
  device?: DeviceView;
};

type DeviceAccess = Pick<
  Devices,
  'view' | 'addEnrolled' | 'remove' | 'enrolledServerDevice' | 'markEnrolledServer' | 'removeLegacyServer'
> &
  Partial<Pick<Devices, 'needsAccessUpgrade' | 'upgradeAccess' | 'serverReach'>>;
const backoffMs = [600_000, 3_600_000, 21_600_000];
type Runner = (
  alias: string,
  progress: (stage: EnrollStage) => void,
  log: (text: string) => void,
  client: NodeClient,
) => Promise<number>;

export class ServerEnrollments {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sweep?: Promise<void>;
  private readonly retries = new Map<string, { failures: number; next: number }>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, ServerEnrollment>();
  private readonly active = new Set<string>();
  private readonly running = new Map<string, string>();
  private readonly runner: Runner;
  constructor(
    private readonly file: string,
    private readonly devices: DeviceAccess | undefined,
    root: string,
    private readonly host: Host = currentHost(),
    runner?: Runner,
    private readonly instaboxSsh?: InstaboxSsh,
    private readonly automatic: {
      sshAvailable: (alias: string) => boolean | Promise<boolean>;
      refresh?: () => Promise<boolean>;
      now?: () => number;
      delay?: () => Promise<void>;
    } = { sshAvailable: async () => false },
  ) {
    this.runner =
      runner ??
      ((alias, progress, log, client) => {
        const deps: NodeDeps & { progress: (stage: EnrollStage) => void } = {
          host,
          client,
          root,
          execPath: process.execPath,
          electron: !!process.versions.electron,
          nodeVersion: process.version,
          interfaces: networkInterfaces,
          out: log,
          err: log,
          progress,
        };
        return runNodeAdd(
          { kind: 'node', action: 'add', target: alias, name: alias, tunnel: true, now: false, dryRun: false },
          deps,
        );
      });
  }
  list(): ServerEnrollment[] {
    const latest = new Map<string, ServerEnrollment>();
    for (const job of this.jobs.values()) latest.set(job.server, { ...job });
    return [...latest.values()];
  }
  startAutomatic() {
    const loop = async () => {
      await this.runAutomatic().catch(() => {});
      if (!this.stopped) {
        this.timer = setTimeout(loop, 30_000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(loop, 1000 + Math.random() * 4000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.sweep;
    await Promise.all(this.completions.values());
  }
  runAutomatic(): Promise<void> {
    if (this.sweep) return this.sweep;
    this.sweep = this.autoPass().finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }
  private async autoPass() {
    if (this.stopped || !this.devices) return;
    const view = await readRemoteServers(this.file);
    if (view.error) return;
    const boxes = await this.instaboxSsh?.decorate(await this.instaboxSsh.monitor.fresh());
    const machineIds = new Set(boxes?.machines.map((box) => box.machineId));
    const candidates = view.servers
      .filter((s) => s.ssh && !s.enrollmentDisabled && !machineIds.has(s.name))
      .map((s) => ({ name: s.name, ssh: s.ssh!, machineId: undefined as string | undefined }));
    for (const box of boxes?.machines ?? []) {
      if (
        box.ssh &&
        box.state === 'running' &&
        !box.stale &&
        !box.pendingAction &&
        !view.servers.find((s) => s.name === box.machineId)?.enrollmentDisabled
      )
        candidates.push({ name: box.machineId, ssh: box.ssh, machineId: box.machineId });
    }
    for (const server of candidates) {
      if (this.stopped) return;
      const now = this.automatic.now?.() ?? Date.now();
      if (!(await this.automatic.sshAvailable(server.ssh))) continue;
      const enrolledId = await this.devices.enrolledServerDevice(server.name);
      if (enrolledId) {
        await this.upgradeAccess(server.name, enrolledId);
        continue;
      }
      if ((this.retries.get(server.name)?.next ?? 0) > now) continue;
      await (this.automatic.delay?.() ??
        new Promise<void>((resolve) => setTimeout(resolve, 500 + Math.random() * 2500)));
      if (this.stopped) return;
      if (this.automatic.refresh && !(await this.automatic.refresh())) return;
      const latest = await readRemoteServers(this.file);
      if (latest.error || latest.servers.find((s) => s.name === server.name)?.enrollmentDisabled) continue;
      if (!server.machineId && !latest.servers.some((s) => s.name === server.name && s.ssh === server.ssh)) continue;
      if (await this.devices.enrolledServerDevice(server.name)) continue;
      try {
        const job = await this.start(server.name, server.machineId, true);
        await this.completions.get(job.id);
        if (this.jobs.get(job.id)?.status !== 'completed') throw new Error('Enrollment failed');
        this.retries.delete(server.name);
      } catch (error) {
        const failures = (this.retries.get(server.name)?.failures ?? 0) + 1;
        this.retries.set(server.name, {
          failures,
          next: (this.automatic.now?.() ?? Date.now()) + backoffMs[Math.min(failures - 1, 2)],
        });
        if (!this.list().some((j) => j.server === server.name)) {
          const job: ServerEnrollment = {
            id: randomUUID(),
            server: server.name,
            stage: 'preflight',
            status: 'failed',
            log: error instanceof Error ? error.message : 'Enrollment failed',
          };
          this.jobs.set(job.id, job);
        }
      }
    }
  }
  /**
   * Gives an enrolled server the account's tunnel-only key from this computer (which has its own SSH alias), then
   * syncs, so the owner's other computers can reach it without their own SSH setup. Failures wait like enrollment.
   */
  private async upgradeAccess(name: string, id: string) {
    const key = `access:${name}`;
    if (this.stopped || !this.devices?.needsAccessUpgrade?.(id)) return;
    if ((this.retries.get(key)?.next ?? 0) > (this.automatic.now?.() ?? Date.now())) return;
    try {
      if (await this.devices.upgradeAccess!(id)) await this.automatic.refresh?.();
      this.retries.delete(key);
    } catch {
      const failures = (this.retries.get(key)?.failures ?? 0) + 1;
      this.retries.set(key, {
        failures,
        next: (this.automatic.now?.() ?? Date.now()) + backoffMs[Math.min(failures - 1, 2)],
      });
    }
  }
  private async optOut(name: string, disabled: boolean, ssh?: string) {
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const view = await readRemoteServers(this.file);
    if (view.error) throw new Error(view.error);
    let server = view.servers.find((s) => s.name === name);
    if (!server) {
      if (!disabled) return;
      server = { name, ssh };
      view.servers.push(server);
    }
    if (!!server.enrollmentDisabled === disabled) return;
    server.enrollmentDisabled = disabled;
    await writePrivateConfig(this.file, JSON.stringify({ servers: view.servers }, null, 2) + '\n', text);
  }
  private required(): DeviceAccess {
    if (!this.devices) throw new Error('设备节点本身不能再添加设备。');
    return this.devices;
  }
  private async server(name: string, machineId?: string) {
    if (machineId) {
      if (!this.instaboxSsh) throw new Error('Unknown instabox machine');
      return this.instaboxSsh.server(machineId);
    }
    const view = await readRemoteServers(this.file);
    if (view.error) throw new Error(view.error);
    const matches = view.servers.filter((s) => s.name === name);
    if (matches.length !== 1 || !matches[0].ssh) throw new Error('未知服务器或服务器没有 SSH 别名。');
    return matches[0] as (typeof matches)[0] & { ssh: string };
  }
  async start(name: string, machineId?: string, auto = false): Promise<ServerEnrollment> {
    this.required();
    const server = await this.server(name, machineId);
    await this.instaboxSsh?.assertReachable(server.ssh);
    if (!auto) await this.optOut(server.name, false);
    const nameProblem = deviceNameProblem(server.ssh);
    if (nameProblem) throw new Error(nameProblem);
    const existing = this.running.get(server.ssh);
    if (existing) return { ...this.jobs.get(existing)! };
    if (this.active.has(server.ssh)) throw new Error('服务器接入正在进行。');
    const before = await this.required().view();
    const enrolledId = await this.required().enrolledServerDevice(server.name);
    if (auto && !enrolledId) {
      await this.required().removeLegacyServer(server.ssh);
    }
    if (!auto && before.devices.some((device) => device.tunnel?.ssh === server.ssh && device.id !== enrolledId))
      throw new Error(
        'This SSH alias is already paired as a personal device. Remove that pairing before enrolling the server.',
      );
    if (this.active.has(server.ssh)) throw new Error('Server enrollment is already running.');
    this.active.add(server.ssh);
    const job: ServerEnrollment = { id: randomUUID(), server: name, stage: 'preflight', status: 'running', log: '' };
    for (const [id, previous] of this.jobs) {
      if (this.jobs.size < 40) break;
      if (previous.status !== 'running') this.jobs.delete(id);
    }
    this.jobs.set(job.id, job);
    this.running.set(server.ssh, job.id);
    const completion = (async () => {
      try {
        let pairedId: string | undefined;
        let pairingProof: string | undefined;
        const client: NodeClient = {
          health: async () => !!this.devices,
          get: async <T>(path: string) => {
            if (path === '/api/devices') return (await this.required().view()) as T;
            if (path === '/api/remote-servers') return (await readRemoteServers(this.file)) as T;
            throw new Error('Unsupported enrollment request');
          },
          post: async <T>(path: string, body?: unknown) => {
            if (path !== '/api/devices') throw new Error('Unsupported enrollment request');
            const paired = await this.required().addEnrolled(body as Parameters<Devices['add']>[0]);
            pairedId = paired.deviceId;
            pairingProof = paired.pairingProof;
            return paired.view as T;
          },
          delete: async <T>() => {
            throw new Error('Unsupported enrollment request');
          },
        };
        const code = await this.runner(
          server.ssh,
          (stage) => {
            job.stage = stage;
          },
          (line) => {
            job.log = (job.log + line).slice(-8000);
          },
          client,
        );
        if (code !== 0) {
          if (job.log.includes('Run on the server: ' + manualCommand)) {
            job.status = 'needs-command';
            job.command = manualCommand;
          } else job.status = 'failed';
          return;
        }
        const view = await this.required().view();
        const device = view.devices.find(
          (item) => item.tunnel?.ssh === server.ssh && item.id === (pairedId ?? enrolledId),
        );
        if (!device) throw new Error('接入完成，但找不到已配对设备。');
        if (
          auto &&
          (await readRemoteServers(this.file)).servers.find((s) => s.name === server.name)?.enrollmentDisabled
        ) {
          await this.required().remove(device.id);
          throw new Error('Server enrollment was disabled.');
        }
        await this.required().markEnrolledServer(device.id, server.name, pairingProof);
        job.device = device;
        job.stage = 'done';
        job.status = 'completed';
        void this.upgradeAccess(server.name, device.id);
      } catch (error) {
        job.status = 'failed';
        job.log = (job.log + '\n' + (error instanceof Error ? error.message : '接入失败。')).slice(-8000);
      } finally {
        this.running.delete(server.ssh);
        this.active.delete(server.ssh);
      }
    })();
    this.completions.set(job.id, completion);
    void completion.finally(() => this.completions.delete(job.id));
    return { ...job };
  }
  progress(id: string): ServerEnrollment | undefined {
    const job = this.jobs.get(id);
    return job && { ...job };
  }
  async disconnect(name: string, purge: boolean, machineId?: string): Promise<DevicesView & { note?: string }> {
    const server = await this.server(name, machineId);
    if (this.devices?.serverReach?.(server.ssh).ownSsh === false)
      throw new Error(
        '断开要在服务器上卸载 PugPort 节点，这需要一台有完整 SSH 权限（自己的 SSH 配置）的电脑。这台电脑只通过账号直连使用它，没有做任何改动。',
      );
    await this.instaboxSsh?.assertReachable(server.ssh);
    if (this.active.has(server.ssh)) throw new Error('服务器接入正在进行。');
    await this.optOut(server.name, true, server.ssh);
    this.active.add(server.ssh);
    try {
      const devices = this.required();
      const view = await devices.view();
      const enrolledId = await devices.enrolledServerDevice(server.name);
      // Servers enrolled before the marker existed are found the way their card shows them: by SSH alias.
      const device =
        view.devices.find((item) => item.id === enrolledId) ??
        view.devices.find((item) => item.tunnel?.ssh === server.ssh);
      const result: DevicesView & { note?: string } = device ? await devices.remove(device.id) : view;
      const script = [
        'set -eu',
        // The account's access key goes with the node; a failure here never blocks the uninstall.
        '(',
        'set -eu',
        ...removeAccessLines(),
        ") || echo 'PugPort access key line could not be removed from authorized_keys.' >&2",
        '~/pugport/bin/pugport node uninstall',
        ...(purge ? ['rm -rf ~/pugport ~/.local/share/pugport'] : []),
      ].join('\n');
      try {
        await this.host.run(
          'ssh',
          ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', server.ssh, '/bin/sh -s'],
          { input: script, timeout: 90_000 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'SSH 卸载失败。';
        return { ...result, note: [result.note, `服务器卸载失败：${message}`].filter(Boolean).join('\n') };
      }
      return result;
    } finally {
      this.active.delete(server.ssh);
    }
  }
}

/** Mount behind localhost, origin and session-token checks, including progress reads. */
export function serverEnrollmentRoutes(
  app: Express,
  enrollments: ServerEnrollments,
  callerKind: (req: Request) => Promise<CallerKind> = async () => 'executor',
) {
  const owner = async (req: Request, res: Response) => {
    // The owner value comes first; a holder that is an executor, or cannot be told apart from one, is still refused.
    const caller = res.locals.owner ? await callerKind(req).catch((): CallerKind => 'unknown') : 'executor';
    if (caller !== 'other') {
      if (caller === 'unknown') refuseUnknownCaller(res);
      else res.status(403).json({ error: 'Only the PugPort desktop window can do this.' });
      return false;
    }
    return true;
  };
  const target = z.union([
    z.object({ name: z.string().trim().min(1).max(60) }).strict(),
    z.object({ machineId: z.string().regex(/^m_[a-z0-9]+$/) }).strict(),
  ]);
  app.post('/api/remote-servers/enrollments', async (req, res) => {
    if (!(await owner(req, res))) return;
    const value = target.parse(req.body);
    res.status(202).json({
      enrollment: await enrollments.start(
        'name' in value ? value.name : value.machineId,
        'machineId' in value ? value.machineId : undefined,
      ),
    });
  });
  app.get('/api/remote-servers/enrollments', (_req, res) => res.json({ enrollments: enrollments.list() }));
  app.get('/api/remote-servers/enrollments/:id', (req, res) => {
    const job = enrollments.progress(z.string().uuid().parse(req.params.id));
    if (!job) {
      res.status(404).json({ error: '找不到接入任务。' });
      return;
    }
    res.json({ enrollment: job });
  });
  app.post('/api/remote-servers/disconnect', async (req, res) => {
    if (!(await owner(req, res))) return;
    const { purge, ...rest } = z.object({ purge: z.boolean() }).passthrough().parse(req.body);
    const value = target.parse(rest);
    res.json(
      await enrollments.disconnect(
        'name' in value ? value.name : value.machineId,
        purge,
        'machineId' in value ? value.machineId : undefined,
      ),
    );
  });
}
