import { underTest, UnderTestError } from '../server/platform/under-test.ts';
import { readDesktopPort, readSessionToken } from '../server/platform/desktop-endpoint.ts';
import { callerUnknownRetryMs } from '../shared/caller-unknown.ts';
/** Talks to the PugPort backend running on this machine (the desktop app's local server). */

export const notRunningMessage = 'PugPort 没有在运行。请先打开 PugPort 桌面应用，再试一次。';

/** The backend could not be reached at all. */
export class BackendUnavailable extends Error {
  constructor(message = notRunningMessage) {
    super(message);
  }
}
/** The backend answered with an error; the message is PugPort's own plain-language reason. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function backendPort(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.PUGPORT_PORT || env.COMBORUNNER_PORT || env.AGENT_STUDIO_PORT;
  const discovered = configured ? undefined : readDesktopPort();
  if (underTest() && !configured && !discovered) throw new UnderTestError('default port 4317');
  const port = Number(configured || discovered || 4317);
  if (underTest() && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    throw new UnderTestError('invalid backend port');
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : 4317;
}

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ServerEvent = { event: string; data: string };

export class PugPortClient {
  #port: number;
  get port() {
    return this.#port;
  }
  get base() {
    return `http://127.0.0.1:${this.#port}`;
  }
  /** The local session token, kept in memory only and sent back to this backend alone; never printed or saved. */
  #token: string | undefined;
  #tokenBase: string | undefined;
  constructor(private readonly configuredPort?: number) {
    this.#port = configuredPort ?? backendPort();
  }

  private refreshBase() {
    // The desktop may have been launched or restarted after this client was created.
    const port = this.configuredPort ?? backendPort();
    if (this.#port !== port) {
      this.#port = port;
      this.#token = undefined;
    }
    return this.base;
  }

  async health(timeoutMs = 2000): Promise<boolean> {
    try {
      const response = await fetch(`${this.refreshBase()}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(process.env.PUGPORT_EXECUTOR === '1' ? { headers: { 'x-pugport-executor': '1' } } : {}),
      });
      const body = (await response.json().catch(() => undefined)) as { ok?: unknown; name?: unknown } | undefined;
      return response.ok && body?.ok === true;
    } catch {
      return false;
    }
  }

  get<T>(path: string, options: RequestOptions = {}) {
    return this.request<T>('GET', path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>('POST', path, body, options);
  }
  delete<T>(path: string, options: RequestOptions = {}) {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * The session header from the session file, or none: the request still goes out, so a stopped desktop reads as
   * not running and a running one answers with why it wants the token.
   */
  private async session(base: string): Promise<Record<string, string>> {
    if (!this.#token || this.#tokenBase !== base) {
      this.#token = readSessionToken(Number(new URL(base).port));
      this.#tokenBase = base;
    }
    return this.#token ? { 'x-agent-token': this.#token } : {};
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    options: RequestOptions,
    retried = false,
    base = this.refreshBase(),
    resent = false,
  ): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const headers: Record<string, string> = await this.session(base);
    if (process.env.PUGPORT_EXECUTOR === '1') headers['x-pugport-executor'] = '1';
    if (method === 'POST') headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        signal,
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if ((error as Error).name === 'TimeoutError') throw new BackendError('PugPort 没有及时回应，请稍后再试。', 504);
      throw new BackendUnavailable();
    }
    const data = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!response.ok) {
      // PugPort could not identify this program and refused before any handler ran: the same request goes once more.
      const wait = resent
        ? undefined
        : callerUnknownRetryMs(response.status, data, response.headers.get('retry-after'));
      if (wait !== undefined) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, wait);
          options.signal?.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
        });
        if (options.signal?.aborted) throw options.signal.reason;
        return this.request<T>(method, path, body, options, retried, base, true);
      }
      const reason = typeof data?.error === 'string' ? data.error : `PugPort 返回了错误（HTTP ${response.status}）。`;
      // A restarted backend rewrites its session file; read it again and try once more if the token changed.
      if (response.status === 403 && !retried && /session token/i.test(reason)) {
        const stale = this.#token;
        this.#token = undefined;
        if (readSessionToken(Number(new URL(base).port)) !== stale)
          return this.request<T>(method, path, body, options, true, base);
      }
      throw new BackendError(reason, response.status);
    }
    if (data === undefined) throw new BackendError('PugPort 的回复无法读取。', response.status);
    return data as T;
  }

  /**
   * The live event stream the desktop app listens to (`/api/events`, server-sent events). Ends when the
   * connection drops or `signal` aborts; the caller reconnects.
   */
  async *events(signal: AbortSignal): AsyncGenerator<ServerEvent> {
    let response: Response;
    try {
      const base = this.refreshBase();
      response = await fetch(`${base}/api/events`, {
        signal,
        headers: {
          accept: 'text/event-stream',
          ...(await this.session(base)),
          ...(process.env.PUGPORT_EXECUTOR === '1' ? { 'x-pugport-executor': '1' } : {}),
        },
      });
      if (response.status === 403) {
        this.#token = undefined;
        response = await fetch(`${base}/api/events`, {
          signal,
          headers: {
            accept: 'text/event-stream',
            ...(await this.session(base)),
            ...(process.env.PUGPORT_EXECUTOR === '1' ? { 'x-pugport-executor': '1' } : {}),
          },
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error instanceof Error && error.name === 'AbortError' ? error : new BackendUnavailable();
    }
    if (!response.ok || !response.body)
      throw new BackendError(`实时连接失败（HTTP ${response.status}）。`, response.status);
    yield* parseEventStream(response.body, signal);
  }
}

/**
 * Server-sent events from a byte stream. A state event can be several megabytes on one line, so line pieces
 * are collected and joined once instead of growing one string chunk by chunk.
 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pieces: string[] = [];
  let event = '';
  let data: string[] = [];
  const line = function* (text: string): Generator<ServerEvent> {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
    } else if (text.startsWith('data:')) data.push(text.slice(text[5] === ' ' ? 6 : 5));
    else if (text.startsWith('event:')) event = text.slice(6).trim();
    // Comments (": heartbeat"), id and retry fields carry nothing PugPort uses.
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || signal?.aborted) return;
      let text = decoder.decode(value, { stream: true });
      let end: number;
      while ((end = text.indexOf('\n')) >= 0) {
        pieces.push(text.slice(0, end));
        text = text.slice(end + 1);
        const complete = pieces.length === 1 ? pieces[0]! : pieces.join('');
        pieces = [];
        yield* line(complete);
      }
      if (text) pieces.push(text);
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    // Closes the connection too when the reader stops early.
    void reader.cancel().catch(() => undefined);
  }
}
