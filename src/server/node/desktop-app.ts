import { trayExecutors } from './node-runtimes.ts';
import type { PeerExecutor } from './peer-protocol.ts';
import { APP_NAME } from '../../shared/identity.ts';
import { peerTaskStatusSchema, type PeerTaskStatus } from './peer-protocol.ts';
import { readDesktopPort, readForwardToken, readSessionToken } from '../platform/desktop-endpoint.ts';
import { callerUnknownRetryMs } from '../../shared/caller-unknown.ts';

/*
 * The PugPort desktop app on the node's own computer, reached through its local API on 127.0.0.1 (the same calls the
 * pugport MCP server makes). While it runs, the node hands it the tasks its paired PugPorts send, so they use the
 * desktop's accounts and show up in its history. Discovery is per user; the node's own port is never used here.
 */

export const desktopPort = 4317;

/**
 * 'device': a build that keeps a forwarded task's device trust and account permissions.
 * 'external': an older build, which would treat the task as an unknown outside caller: fine for reading only.
 */
export type DesktopKind = 'device' | 'external';
export type DesktopDispatch = {
  task: string;
  caller: string;
  projectPath?: string;
  write: boolean;
  untrusted: boolean;
};
/** `sendFiles`: the PUGPORT_SEND_FILE lines of every step, not only the final answer; older builds leave it out. */
export type DesktopResult = { status: string; result?: string; error?: string; sendFiles?: string[] };

export type DesktopApp = {
  tray(): Promise<PeerExecutor[]>;
  /** What answers on the desktop port now; undefined when nothing does, or it is not a desktop PugPort. */
  probe(): Promise<DesktopKind | undefined>;
  /** undefined when the desktop app was gone before the task reached it, so running it on the node is safe. */
  dispatch(input: DesktopDispatch, kind: DesktopKind): Promise<{ taskId: string; status: string } | undefined>;
  /** undefined when the desktop no longer has the task. */
  status(taskId: string): Promise<PeerTaskStatus | undefined>;
  result(taskId: string, waitSeconds: number, signal?: AbortSignal): Promise<DesktopResult | undefined>;
  cancel(taskId: string): Promise<boolean>;
};

/** Nothing listens on the desktop port: the app is not running (any more). */
export class DesktopClosed extends Error {
  constructor() {
    super('设备上的 PugPort 桌面版在任务完成前关闭了，任务没有重跑。');
  }
}

/** The desktop app may have taken the task before it stopped answering: it must not be sent a second time. */
export class DesktopUncertain extends Error {
  constructor() {
    super('设备上的 PugPort 桌面版在接收任务时没有回应。请先在设备上检查它的任务，再重新发送。');
  }
}

const refused = (error: unknown) =>
  (error as { cause?: { code?: unknown } } | undefined)?.cause?.code === 'ECONNREFUSED';

export function desktopApp(
  options: { port?: number; forwardTokenFile?: string; sessionTokenFile?: string } = {},
): DesktopApp {
  const targetPort = () => options.port ?? readDesktopPort() ?? desktopPort;
  const baseOf = (port: number) => `http://127.0.0.1:${port}`;
  const call = async (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: string;
      forwardToken?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      base: string;
    },
    resent = false,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const timeout = AbortSignal.timeout(init.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${init.base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.token ? { 'x-agent-token': init.token } : {}),
          ...(init.forwardToken ? { 'x-pugport-device-token': init.forwardToken } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    } catch (error) {
      if (refused(error)) throw new DesktopClosed();
      throw error;
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // The desktop could not identify this node and refused before any handler ran, so no task exists there yet:
    // the same request goes once more.
    const wait = resent ? undefined : callerUnknownRetryMs(response.status, body, response.headers.get('retry-after'));
    if (wait !== undefined) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, wait);
        init.signal?.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
      });
      return call(path, init, true);
    }
    return { status: response.status, body: body && typeof body === 'object' ? body : {} };
  };
  const failure = (reply: { status: number; body: Record<string, unknown> }) =>
    new Error(
      typeof reply.body.error === 'string'
        ? reply.body.error.slice(0, 1000)
        : `设备上的 PugPort 桌面版回复了 HTTP ${reply.status}。`,
    );
  // The desktop makes a new session token each time it starts; it is only sent back to it, never kept.
  const token = (port: number) => readSessionToken(port, options.sessionTokenFile);
  const task = (taskId: string) => `/api/external/tasks/${encodeURIComponent(taskId)}`;

  return {
    async tray() {
      const port = targetPort();
      const deadline = Date.now() + 2000;
      const session = token(port);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Desktop tray timed out');
      const reply = await call('/api/tray', { timeoutMs: remaining, base: baseOf(port), token: session });
      if (reply.status !== 200) throw failure(reply);
      return trayExecutors(reply.body);
    },
    async probe() {
      const port = targetPort();
      try {
        const { status, body } = await call('/api/health', { timeoutMs: 1500, base: baseOf(port) });
        if (status !== 200 || body.ok !== true || body.name !== APP_NAME || body.role === 'node') return undefined;
        return body.role === 'desktop' && readForwardToken(options.forwardTokenFile, port) ? 'device' : 'external';
      } catch {
        return undefined;
      }
    },
    async dispatch(input, kind) {
      const port = targetPort();
      const target = baseOf(port);
      const session = token(port);
      if (!session) return undefined;
      let reply;
      try {
        reply = await call('/api/external/tasks', {
          method: 'POST',
          base: target,
          token: session,
          forwardToken: kind === 'device' ? readForwardToken(options.forwardTokenFile, port) : undefined,
          timeoutMs: 60_000,
          // Only fields every desktop build knows (its schema refuses others), and never `device`: no loops.
          body: {
            task: input.task,
            caller: input.caller,
            ...(input.projectPath ? { projectPath: input.projectPath } : {}),
            write: input.write,
            ...(input.untrusted ? { untrusted: true } : {}),
            ...(kind === 'device' ? { source: 'device' } : {}),
          },
        });
      } catch (error) {
        // Refused: nothing reached the desktop. Anything else may have left the task with it.
        if (error instanceof DesktopClosed) return undefined;
        throw new DesktopUncertain();
      }
      if (reply.status === 201 && typeof reply.body.taskId === 'string')
        return { taskId: reply.body.taskId, status: String(reply.body.status ?? 'queued') };
      if (reply.status === 201) throw new DesktopUncertain();
      if (reply.status === 403 && typeof reply.body.error === 'string' && /session token/i.test(reply.body.error))
        return undefined;
      throw failure(reply);
    },
    async status(taskId) {
      const port = targetPort();
      const reply = await call(task(taskId), { timeoutMs: 10_000, base: baseOf(port), token: await token(port) });
      if (reply.status === 404) return undefined;
      if (reply.status !== 200) throw failure(reply);
      const { error, note } = reply.body;
      // The same fields the node sends for its own tasks: no conversation ids, paths or permissions.
      return peerTaskStatusSchema.parse({
        ...reply.body,
        taskId,
        ...(typeof error === 'string' ? { error: error.slice(0, 4000) } : {}),
        ...(typeof note === 'string' ? { note: note.slice(0, 4000) } : {}),
      });
    },
    async result(taskId, waitSeconds, signal) {
      const port = targetPort();
      const reply = await call(`${task(taskId)}/result?wait=${waitSeconds}&sendFiles=1`, {
        base: baseOf(port),
        token: await token(port),
        timeoutMs: (waitSeconds + 15) * 1000,
        ...(signal ? { signal } : {}),
      });
      if (reply.status === 404) return undefined;
      if (reply.status !== 200 || typeof reply.body.status !== 'string') throw failure(reply);
      const { status, result, error, sendFiles } = reply.body;
      return {
        status,
        ...(typeof result === 'string' ? { result } : {}),
        ...(typeof error === 'string' ? { error } : {}),
        ...(Array.isArray(sendFiles) ? { sendFiles: sendFiles.filter((line) => typeof line === 'string') } : {}),
      };
    },
    async cancel(taskId) {
      const port = targetPort();
      const target = baseOf(port);
      const reply = await call(`${task(taskId)}/cancel`, {
        method: 'POST',
        token: await token(port),
        timeoutMs: 10_000,
        base: target,
      });
      if (reply.status === 404) return false;
      if (reply.status !== 200) throw failure(reply);
      return true;
    },
  };
}
