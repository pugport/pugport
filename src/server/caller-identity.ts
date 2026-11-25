import { execFile } from 'node:child_process';
import type { Request, RequestHandler, Response } from 'express';
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { callerUnknownCode, callerUnknownRetrySeconds } from '../shared/caller-unknown.ts';

export { callerUnknownRetrySeconds };

const exec = promisify(execFile);
let warned = false;
export const chainHasExecutor = (chain: number[], selfPid: number, owns: (pid: number) => boolean) =>
  chain.some((pid) => pid === selfPid || owns(pid));
// Every process holding the client end counts: a socket shared after fork is listed under each of them.
const candidates = (values: number[]) => [...new Set(values.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
/** `netstat -ano -p tcp`: the client end of the loopback connection (each one is listed in both directions). */
export function parseNetstat(output: string, client: string, remotePort: number, localPort: number): number[] {
  return candidates(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) =>
          fields[0] === 'TCP' && fields[1] === `${client}:${remotePort}` && fields[2] === `127.0.0.1:${localPort}`,
      )
      .map((fields) => Number(fields[4])),
  );
}
export function parseSs(output: string, client: string, remotePort: number, localPort: number): number[] {
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[2] === `${client}:${remotePort}` && fields[3] === `127.0.0.1:${localPort}`)
      for (const match of line.matchAll(/pid=(\d+)/g)) matches.push(Number(match[1]));
  }
  return candidates(matches);
}
/** A macOS endpoint, "127.0.0.1.4317" (netstat, nettop tcp6) or "127.0.0.1:4317" (nettop tcp4), as "127.0.0.1:4317". */
function darwinEndpoint(address: string | undefined) {
  const match = /^(.*)[.:](\d+)$/.exec(address ?? '');
  return match ? `${match[1]!.replace(/^::ffff:/i, '')}:${match[2]}` : '';
}
/**
 * macOS `netstat -anv -p tcp`: the client end of the loopback connection, owned by the process in the `pid` column
 * (macOS 15: "pid epid") or the `process:pid` column (other releases: "node:12345"). The column is found from the
 * header, so either layout works; a client on a dual-stack socket appears as tcp6/tcp46 with a "::ffff:" address.
 */
export function parseDarwinNetstat(output: string, client: string, remotePort: number, localPort: number): number[] {
  let column = -1;
  let named = false;
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line
      .trim()
      .replace(/(Local|Foreign) Address/g, '$1')
      .split(/\s+/);
    if (fields[0] === 'Proto') {
      column = fields.findIndex((field) => field === 'pid' || field === 'process:pid');
      named = fields[column] === 'process:pid';
      continue;
    }
    if (column < 0 || !/^tcp(4|6|46)?$/.test(fields[0] ?? '')) continue;
    if (
      darwinEndpoint(fields[3]) !== `${client}:${remotePort}` ||
      darwinEndpoint(fields[4]) !== `127.0.0.1:${localPort}`
    )
      continue;
    // A process name may contain spaces, which shifts the fields after it; its pid ends the first "name:pid" field.
    const owner = named
      ? fields
          .slice(column)
          .find((field) => /:\d+$/.test(field))
          ?.replace(/^.*:/, '')
      : fields[column];
    matches.push(Number(owner));
  }
  return candidates(matches);
}
/**
 * macOS `nettop -L 1 -n -m tcp -t loopback -J state`: a "name.pid" row for each process, followed by one
 * "tcp4 local<->remote" row per socket it owns, each ending in the state column.
 */
export function parseNettop(output: string, client: string, remotePort: number, localPort: number): number[] {
  let pid: number | undefined;
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Dropping the state column from the end keeps a process name that contains a comma whole.
    const field = line.replace(/,[^,]*,?$/, '');
    const socket = /(?:^|,)tcp\d* (\S+)<->(\S+)$/.exec(field);
    if (!socket) {
      const owner = /\.(\d+)$/.exec(field);
      pid = owner ? Number(owner[1]) : undefined;
    } else if (
      pid !== undefined &&
      darwinEndpoint(socket[1]) === `${client}:${remotePort}` &&
      darwinEndpoint(socket[2]) === `127.0.0.1:${localPort}`
    )
      matches.push(pid);
  }
  return candidates(matches);
}
export function parseLsof(output: string, client: string, remotePort: number, localPort: number): number[] {
  let pid: number | undefined;
  const matches: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line === `n${client}:${remotePort}->127.0.0.1:${localPort}`) matches.push(pid);
  }
  return candidates(matches);
}
/**
 * Up to 8 ancestors from a "pid ppid" table. Only processes still in the table join the chain (an exited parent's
 * pid may already belong to someone else), except the peer itself, which holds the live connection.
 */
export function walkTable(table: string, pid: number): number[] {
  const parents = new Map<number, number>();
  for (const line of table.split(/\r?\n/)) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(child) && Number.isSafeInteger(parent)) parents.set(child!, parent!);
  }
  const chain = [pid];
  for (let current = parents.get(pid); current && parents.has(current) && chain.length < 8;) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}
type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;
// Settles only once the program has exited: a timeout sends SIGKILL, but a process blocked in the kernel lives on.
const system: Run = async (file, args, timeoutMs) =>
  (await exec(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true })).stdout;
const LSOF_TIMEOUT_MS = 2000;
const lsofRuns = new WeakMap<Run, Promise<string>>();
/**
 * lsof inspects every open file and can block in the kernel on a mount that does not answer (an automounted /home, a
 * gone network volume), where no signal ends it. One probe at a time: callers share the running one, and a new one
 * starts only after it has exited, so a hung lsof never multiplies.
 */
function lsofOnce(run: Run, timeoutMs: number) {
  let probe = lsofRuns.get(run);
  if (!probe) {
    probe = run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn'], timeoutMs).finally(() => lsofRuns.delete(run));
    lsofRuns.set(run, probe);
  }
  return probe;
}
// One CIM query for every process is much faster here than one per ancestor (each start costs about a second).
const windowsTable =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

/**
 * Whether the program on the other end of this loopback connection descends from this backend or from one of its
 * executors. Any failure, missing tool or timeout answers undefined: the caller could not be identified, which is
 * neither answer. Each consumer decides what that means and nobody remembers it.
 */
export async function executorCaller(options: {
  remotePort?: number;
  localPort?: number;
  /** The client's own address: it may bind any 127.x address, while the backend listens on 127.0.0.1. */
  remoteAddress?: string;
  owns: (pid: number) => boolean;
  run?: Run;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<boolean | undefined> {
  const { remotePort, localPort, owns } = options;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5000;
  const run = options.run ?? system;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const valid = (port?: number) => Number.isInteger(port) && port! > 0 && port! < 65536;
    if (!valid(remotePort) || !valid(localPort)) throw new Error('invalid socket ports');
    const client = options.remoteAddress ?? '';
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(client) || client.split('.').some((part) => Number(part) > 255))
      throw new Error(`unexpected peer address: ${client}`);
    const found = (peers: number[]) => {
      if (!peers.length) throw new Error('peer not found');
      return peers;
    };
    const work = async (): Promise<number[][]> => {
      if (platform === 'win32') {
        const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        const [connections, table] = await Promise.all([
          run(join(system32, 'netstat.exe'), ['-ano', '-p', 'tcp'], timeoutMs),
          run(
            join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-Command', windowsTable],
            timeoutMs,
          ),
        ]);
        return found(parseNetstat(connections, client, remotePort!, localPort!)).map((pid) => walkTable(table, pid));
      }
      if (platform === 'darwin') {
        // netstat and nettop read sockets from the kernel without lsof's walk over mounted file systems; lsof is the
        // fallback when neither names an owner.
        const [connections, table] = await Promise.all([
          run('/usr/sbin/netstat', ['-anv', '-p', 'tcp'], timeoutMs).catch(() => ''),
          run('ps', ['-axo', 'pid=,ppid='], timeoutMs),
        ]);
        let peers = parseDarwinNetstat(connections, client, remotePort!, localPort!);
        // macOS 27 hands netstat an empty table when an ad-hoc signed process, such as PugPort's own build, is among
        // its live ancestors; nettop still lists every socket.
        if (!peers.length)
          peers = parseNettop(
            await run(
              '/usr/bin/nettop',
              ['-L', '1', '-n', '-m', 'tcp', '-t', 'loopback', '-J', 'state'],
              timeoutMs,
            ).catch(() => ''),
            client,
            remotePort!,
            localPort!,
          );
        if (!peers.length)
          peers = parseLsof(await lsofOnce(run, Math.min(timeoutMs, LSOF_TIMEOUT_MS)), client, remotePort!, localPort!);
        return found(peers).map((pid) => walkTable(table, pid));
      }
      const peers = found(
        parseSs(
          await run(
            'ss',
            ['-tnpH', 'state', 'established', `( sport = :${remotePort} and dport = :${localPort} )`],
            timeoutMs,
          ),
          client,
          remotePort!,
          localPort!,
        ),
      );
      return Promise.all(
        peers.map(async (peer) => {
          const chain: number[] = [];
          for (let pid: number | undefined = peer; pid && pid > 0 && chain.length < 8;) {
            const stat: string = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
            if (!stat) break;
            chain.push(pid);
            const parent: string | undefined = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
            pid = /^\d+$/.test(parent ?? '') ? Number(parent) : undefined;
          }
          return chain;
        }),
      );
    };
    const chains = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return chains.some((chain) => chainHasExecutor(chain, process.pid, owns));
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn('Could not identify external caller:', error);
    }
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Who is on the other end of a local request: one of PugPort's own executors, another program, or not known. */
export type CallerKind = 'executor' | 'other' | 'unknown';
export const callerUnknownError =
  'PugPort could not identify the program making this request, so it was not carried out. Try again in a moment.';
/** The answer for an owner-level write whose caller could not be identified: refused for now, safe to send again. */
export function refuseUnknownCaller(res: Response) {
  res.setHeader('Retry-After', String(callerUnknownRetrySeconds));
  res.status(503).json({ error: callerUnknownError, code: callerUnknownCode });
}

/** Asks once per connection and keeps a definite answer; a failed lookup answers 'unknown' and is asked again. */
export function perConnection<T extends object>(lookup: (connection: T) => Promise<boolean | undefined>) {
  const answers = new WeakMap<T, Promise<CallerKind>>();
  return (connection: T) => {
    let answer = answers.get(connection);
    if (!answer) {
      answer = lookup(connection)
        .catch(() => undefined)
        .then((found): CallerKind => {
          if (typeof found !== 'boolean') {
            answers.delete(connection);
            return 'unknown';
          }
          return found ? 'executor' : 'other';
        });
      answers.set(connection, answer);
    }
    return answer;
  };
}

/**
 * The checks the HTTP routes share, over one per-connection lookup. 'unknown' never means "not an executor": each
 * consumer refuses, allows or retries it by its own rule.
 */
export function callerGuards(lookup: (socket: Socket) => Promise<boolean | undefined>) {
  const socketCaller = perConnection(lookup);
  /** PugPort's own clients say so themselves when an executor runs them; everyone else is looked up. */
  const callerKind = (req: Request): Promise<CallerKind> =>
    req.headers['x-pugport-executor'] === '1' ? Promise.resolve('executor') : socketCaller(req.socket);
  /**
   * File-token writes that act as the owner: PugPort's own executors are refused (403 with `refusal`), and so is a
   * caller that could not be identified (503, try again). The desktop window's owner value needs no lookup.
   * Answers whether the request may go on; when it may not, the response has been sent.
   */
  const ownerLevelCaller = async (req: Request, res: Response, refusal: string) => {
    if (res.locals.owner) return true;
    const caller = await callerKind(req);
    if (caller === 'other') return true;
    if (caller === 'executor') res.status(403).json({ error: refusal });
    else refuseUnknownCaller(res);
    return false;
  };
  const refuseExecutors: RequestHandler = async (req, res, next) => {
    if (
      req.method === 'GET' ||
      req.method === 'HEAD' ||
      (await ownerLevelCaller(req, res, "PugPort's own executors cannot act as the owner."))
    )
      next();
  };
  return { callerKind, ownerLevelCaller, refuseExecutors };
}
