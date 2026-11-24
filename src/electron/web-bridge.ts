import {
  BrowserWindow,
  clipboard as electronClipboard,
  shell,
  session,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { isAppPageRequest } from '../shared/local-page.ts';
import {
  webAgentIdPattern,
  webAgentPartition,
  webAgentUrl,
  type WebAgentRequest,
  type WebAgentResult,
  type WebSelectors,
} from '../shared/web-bridge.ts';
import { pageHelper } from './web-page-helper.ts';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NetworkDiagnosticRun, observeMuseNetwork } from './network-diagnostic.ts';
import { grokBotDesktopRequest } from './grok-bot-handoff.ts';
import { detectWebLimit, webUsageSnapshot } from '../server/external-agents/config.ts';
import { WebUsageMonitor } from '../server/external-agents/web-usage-monitor.ts';
import {
  mergeWebUsage,
  readLearnedUsage,
  safeUsageRequest,
  safeWebUsageRoute,
  usageSignatureSchema,
} from '../server/external-agents/usage.ts';
import type { WebQuota } from '../shared/external-agents.ts';
import { grokDiagnostic } from '../shared/grok-usage.ts';
import { readGrokBotPageUsage } from './grok-bot-usage.ts';
import {
  grokBotUsageAgentId,
  grokBotUsagePage,
  webUsageInstructions,
  webUsageInvitation,
} from '../shared/external-agents.ts';

/*
 * The desktop side of web agents (Muse): one window per agent with its own lasting sign-in, where the
 * user logs in themselves. PugPort types the message into the site's chat box, waits until the reply stops changing
 * and reads it back as text. It never handles passwords, never reads cookies or storage, and stops at any captcha
 * or sign-in page, bringing the window forward for the user instead.
 */

export type WebBridgeOptions = {
  /** PugPort's own local port: an agent's page may never reach it. */
  port: number;
  dataDir?: string;
  mainWindow?: () => BrowserWindow | undefined;
  windowOptions?: BrowserWindowConstructorOptions;
  /** Brings an agent's window to the front (tests record it instead). */
  present?: (window: BrowserWindow) => void;
  clipboard?: { writeText(text: string): void };
  openExternal?: (url: string) => Promise<void>;
  pollMs?: number;
  loadTimeoutMs?: number;
  followMaxMs?: number;
};
type Found = {
  check: '' | 'human-check' | 'login';
  loginHint: boolean;
  input: boolean;
  send: boolean;
  reply: boolean;
  editable: boolean;
  selectors: WebSelectors;
};
type Status = {
  tracking: boolean;
  generating: boolean;
  quietMs: number | null;
  changed: number;
  inputText: string;
  check: string;
};
type Point = { x: number; y: number };
/** __pugportBridge.reply(): the reply text, or why marked turns could not attribute one. */
type PageReply = { text?: string; selector?: string; truncated?: boolean; code?: 'ambiguous' | 'lost' };
const ambiguousReply = (name: string): WebAgentResult => ({
  ok: false,
  code: 'ambiguous',
  sent: true,
  message: `消息发出去了，但 ${name} 的页面上分不清哪条回复属于这次提问（同样的提问出现了不止一次，或认不出是谁写的）。请到它的窗口里查看；点「重试」只重新读取，不会重发。`,
});

/** The page helper's own JavaScript world: the site's scripts can neither see nor tamper with it. */
const world = 1077;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
/** The chat box holds the message (editors may reflow lines and trim spaces). */
const typed = (value: string, text: string) => {
  const have = norm(value);
  const want = norm(text);
  return have.includes(want.slice(0, 30)) && have.length >= want.length * 0.8;
};
const clamp = (value: number | undefined, low: number, high: number, fallback: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value! : fallback));
class BridgeStop extends Error {
  constructor(readonly result: WebAgentResult) {
    super(result.message);
  }
}

function validate(raw: unknown): WebAgentRequest | string {
  const request = raw as Record<string, unknown> | null;
  if (!request || typeof request !== 'object') return '请求无效。';
  if (
    !['open', 'detect', 'recapture', 'send', 'handoff', 'usage', 'monitor', 'peek', 'stop', 'cancel'].includes(
      String(request.action),
    )
  )
    return '不认识这个操作。';
  if (
    ['peek', 'stop'].includes(String(request.action)) &&
    (typeof request.trackerId !== 'string' || !request.trackerId || request.trackerId.length > 200)
  )
    return '请求无效。';
  if (
    request.action === 'recapture' &&
    request.trackerId !== undefined &&
    (typeof request.trackerId !== 'string' || !request.trackerId || request.trackerId.length > 200)
  )
    return '请求无效。';
  if (request.automatic !== undefined && typeof request.automatic !== 'boolean') return '请求无效。';
  if (request.background !== undefined && typeof request.background !== 'boolean') return '请求无效。';
  if (request.usageSignedOut !== undefined && typeof request.usageSignedOut !== 'boolean') return '请求无效。';
  if (request.action === 'monitor' && typeof request.enabled !== 'boolean') return '请求无效。';
  if (
    request.configurationVersion !== undefined &&
    (typeof request.configurationVersion !== 'string' || request.configurationVersion.length > 64)
  )
    return '请求无效。';
  if (request.navigate !== undefined && typeof request.navigate !== 'boolean') return '请求无效。';
  if (request.afterReply !== undefined && typeof request.afterReply !== 'boolean') return '请求无效。';
  if (request.usageUrl !== undefined && (typeof request.usageUrl !== 'string' || !webAgentUrl(request.usageUrl)))
    return '请求无效。';
  if (
    request.conversationId !== undefined &&
    (typeof request.conversationId !== 'string' || !request.conversationId || request.conversationId.length > 200)
  )
    return '请求无效。';
  if (request.threadUrl !== undefined && (typeof request.threadUrl !== 'string' || !webAgentUrl(request.threadUrl)))
    return '请求无效。';
  if (typeof request.agentId !== 'string' || !webAgentIdPattern.test(request.agentId)) return '智能体编号无效。';
  if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 60) return '名称无效。';
  if (typeof request.url !== 'string' || !webAgentUrl(request.url)) return '网址要以 https:// 开头。';
  if (
    (request.action === 'send' || request.action === 'recapture' || request.action === 'handoff') &&
    (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 100_000)
  )
    return '消息是空的，或者太长。';
  const selectors = request.selectors as Record<string, unknown> | undefined;
  request.selectors =
    selectors && typeof selectors === 'object'
      ? Object.fromEntries(
          ['input', 'send', 'reply', 'stop']
            .map((key) => [key, selectors[key]])
            .filter(([, value]) => typeof value === 'string' && value.length <= 500),
        )
      : {};
  return request as WebAgentRequest;
}

export class WebBridge {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly trackers = new Map<string, { id: string; timer: NodeJS.Timeout }>();
  private readonly cancelledSends = new Set<string>();
  private readonly activeConversations = new Map<string, string>();
  private readonly conversationUrls = new Map<string, string>();
  private readonly hardened = new Set<string>();
  private readonly usagePages = new Set<string>();
  private readonly monitors = new Map<string, WebUsageMonitor>();
  private readonly pageSelectors = new Map<string, WebSelectors>();
  private disposed = false;
  private grokLast?: WebAgentResult;
  private grokLoginPending = false;
  private grokBusy = false;
  private grokFallback = false;
  private grokPrimaryFailure?: WebAgentResult;
  private readonly networkDiagnostic?: NetworkDiagnosticRun;
  constructor(private readonly options: WebBridgeOptions) {
    if (options.dataDir) {
      const directory = join(options.dataDir, 'diagnostics');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      let created = false;
      this.networkDiagnostic = new NetworkDiagnosticRun({
        markerExists: () => existsSync(join(directory, 'muse-network.on')),
        append: (line) => {
          // A same-second restart must not append into another run's budget.
          appendFileSync(join(directory, `muse-network-${stamp}.jsonl`), line, {
            mode: 0o600,
            flag: created ? 'a' : 'wx',
          });
          created = true;
        },
      });
    }
  }

  handle(raw: unknown): Promise<WebAgentResult> {
    const candidate = raw as { agentId?: unknown; action?: unknown } | null;
    if (candidate?.action === 'desktop-start-minimized') {
      if (candidate.agentId !== 'grok-bot') return Promise.resolve({ ok: false, code: 'error' });
      if (this.disposed) return Promise.resolve({ ok: false, code: 'closed' });
      const window = this.options.mainWindow?.();
      const focusedHandle =
        window && !window.isDestroyed() && window.isFocused() ? window.getNativeWindowHandle() : undefined;
      // Loaded on first use: its platform helpers read `process` at load, which the renderer test harness lacks.
      return import('./grok-bot-launch.ts')
        .then(({ startGrokBot }) => startGrokBot(undefined, undefined, focusedHandle))
        .then(
          () => ({ ok: true }),
          // Matched by name: importing the error class here would load the platform helpers too early.
          (error: unknown) => ({
            ok: false,
            code: (error as { name?: unknown } | null)?.name === 'GrokBotNotInstalledError' ? 'not-installed' : 'error',
          }),
        );
    }
    if (candidate?.agentId === 'grok-bot' || ['desktop-open', 'desktop-handoff'].includes(String(candidate?.action)))
      return this.disposed
        ? Promise.resolve({ ok: false, code: 'closed' })
        : grokBotDesktopRequest(raw, {
            clipboard: this.options.clipboard ?? electronClipboard,
            openExternal: this.options.openExternal ?? ((url) => shell.openExternal(url)),
          });
    const request = validate(raw);
    if (typeof request === 'string') return Promise.resolve({ ok: false, code: 'error', message: request });
    if (
      request.agentId === grokBotUsageAgentId &&
      (request.url !== grokBotUsagePage || !['open', 'usage', 'monitor'].includes(request.action))
    )
      return Promise.resolve({ ok: false, code: 'error' });
    const run = () =>
      this.run(request).catch((error: unknown): WebAgentResult => {
        if (request.agentId === grokBotUsageAgentId) {
          const current = this.windows.get(request.agentId);
          const code =
            !current || current.isDestroyed() ? 'closed' : error instanceof BridgeStop ? error.result.code : 'error';
          const result: WebAgentResult = {
            ok: false,
            code,
            grokDiagnostic: grokDiagnostic(
              code === 'load-failed' || code === 'closed' ? code : 'error',
              'navigation',
              this.windows.get(request.agentId)?.webContents.getURL(),
            ),
          };
          this.grokLast = result;
          return result;
        }
        if (error instanceof BridgeStop) return error.result;
        const window = this.windows.get(request.agentId);
        if (!window || window.isDestroyed())
          return { ok: false, code: 'closed', message: `${request.name} 的窗口被关掉了，这条没有完成。` };
        return {
          ok: false,
          code: 'error',
          message:
            request.agentId === grokBotUsageAgentId
              ? '暂时无法读取 Grok Bot 用量，稍后会自动重试。'
              : error instanceof Error
                ? error.message
                : String(error),
        };
      });
    // Opening the window or handing a message over never types into the page, so it does not wait its turn.
    if (
      request.action === 'open' ||
      request.action === 'handoff' ||
      request.action === 'monitor' ||
      request.action === 'peek' ||
      request.action === 'stop' ||
      request.action === 'cancel'
    )
      return run();
    // One message at a time per agent: the next one starts after the previous reply was read.
    const next = (this.queues.get(request.agentId) ?? Promise.resolve()).then(run, run);
    this.queues.set(request.agentId, next);
    return next;
  }

  /** Session partitions this run has used, so their stored data can be written out before an early exit. */
  get partitions(): string[] {
    return [...this.hardened];
  }
  dispose() {
    this.disposed = true;
    for (const tracker of this.trackers.values()) clearTimeout(tracker.timer);
    this.trackers.clear();
    for (const monitor of this.monitors.values()) monitor.close();
    this.monitors.clear();
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }

  private async run(request: WebAgentRequest): Promise<WebAgentResult> {
    if (
      request.action === 'desktop-open' ||
      request.action === 'desktop-handoff' ||
      request.action === 'desktop-start-minimized'
    )
      return { ok: false, code: 'error' };
    if (this.disposed) return { ok: false, code: 'closed', message: 'PugPort 正在退出。' };
    if (request.action === 'cancel') {
      this.cancelledSends.add(request.agentId);
      return { ok: true };
    }
    if (request.action === 'peek' || request.action === 'stop') {
      const window = this.windows.get(request.agentId);
      if (!window || window.isDestroyed()) return { ok: false, code: 'closed' };
      if (request.action === 'stop') {
        await this.stopTracker(request.agentId, request.trackerId, window.webContents);
        return { ok: true };
      }
      const result = await this.page<WebAgentResult>(
        window.webContents,
        `__pugportBridge.peek(${JSON.stringify(request.trackerId)}, ${JSON.stringify(request.selectors ?? {})})`,
      );
      if (!result.ok) return result;
      const limit = await this.limit(window.webContents, request.selectors);
      return limit ?? result;
    }
    if ((request.action === 'usage' || request.action === 'detect') && this.trackers.has(request.agentId))
      return { ok: false, code: 'error', message: '正在跟进回复，请稍后重试。' };
    if (request.selectors) this.pageSelectors.set(request.agentId, request.selectors);
    if (request.action === 'monitor') {
      const monitor = this.monitors.get(request.agentId);
      if (request.agentId === grokBotUsageAgentId) {
        monitor?.configure(request.enabled, request.signatures, grokBotUsagePage, grokBotUsagePage);
        if (!request.enabled) this.grokLoginPending = false;
        return this.grokLast ?? { ok: false };
      }
      if (!monitor) return { ok: false, code: 'closed' };
      monitor.configure(
        request.enabled,
        request.signatures,
        request.usageUrl ?? '',
        request.url,
        request.configurationVersion,
      );
      if (request.agentId === 'muse' && request.usageSignedOut) {
        const window = this.windows.get(request.agentId);
        if (!window || window.isDestroyed()) return { ok: false, code: 'closed' };
        const found = await this.page<Found>(window.webContents, '__pugportBridge.find({})');
        return { ...monitor.result(), authenticated: !!found.input && !found.check && !found.loginHint };
      }
      return monitor.result();
    }
    if (request.action === 'open') {
      const window = this.window(request);
      if (request.agentId === grokBotUsageAgentId) {
        this.grokLoginPending = true;
        this.grokLast = undefined;
        this.grokFallback = false;
      }
      this.present(window);
      await this.load(window, request.url, request.name);
      if (request.agentId === grokBotUsageAgentId) await this.grokUsage({ ...request, action: 'usage' });
      this.monitors.get(request.agentId)?.configure(true, undefined, undefined, window.webContents.getURL());
      return { ok: true };
    }
    if (request.action === 'handoff') {
      (this.options.clipboard ?? electronClipboard).writeText(request.text);
      const window = this.window(request);
      this.present(window);
      await this.load(window, request.url, request.name).catch(() => undefined);
      return { ok: true, message: `已复制到剪贴板，并打开了 ${request.name} 窗口。` };
    }
    if (request.action === 'detect') {
      const result = await this.detect(request);
      if (result.ok && !result.limit) this.monitors.get(request.agentId)?.clearLimit();
      return result;
    }
    if (request.action === 'recapture') {
      const result = await this.recapture(request);
      if (result.ok && result.reply) this.monitors.get(request.agentId)?.clearLimit();
      return result;
    }
    if (request.action === 'usage')
      return request.agentId === grokBotUsageAgentId ? this.grokUsage(request) : this.usage(request);
    const result = await this.send(request);
    if (result.ok && result.reply) this.monitors.get(request.agentId)?.clearLimit();
    return result;
  }

  private window(target: { agentId: string; name: string; url: string }) {
    const existing = this.windows.get(target.agentId);
    if (existing && !existing.isDestroyed()) return existing;
    const partition = webAgentPartition(target.agentId);
    const window = new BrowserWindow({
      width: 1100,
      height: 860,
      show: false,
      autoHideMenuBar: true,
      title:
        target.agentId === grokBotUsageAgentId
          ? '登录 Cursor 账号 · 用于读取 Grok Bot 用量'
          : `${target.name} · PugPort`,
      ...this.options.windowOptions,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // A hidden window keeps running timers and rendering, so streamed replies arrive while nobody watches.
        backgroundThrottling: false,
        spellcheck: false,
        ...this.options.windowOptions?.webPreferences,
        partition,
      },
    });
    if (target.agentId === 'muse' && this.networkDiagnostic) {
      const stop = observeMuseNetwork({
        run: this.networkDiagnostic,
        debugger: window.webContents.debugger,
        origin: target.url,
        currentUrl: () => window.webContents.getURL(),
      });
      window.once('closed', stop);
    }
    this.harden(window, partition);
    window.on('page-title-updated', (event, title) => {
      event.preventDefault();
      window.setTitle(
        target.agentId === grokBotUsageAgentId
          ? '登录 Cursor 账号 · 用于读取 Grok Bot 用量'
          : `${target.name} · ${title} · PugPort`,
      );
    });
    if (target.agentId === grokBotUsageAgentId) {
      let navigationTimer: NodeJS.Timeout | undefined;
      const read = () => {
        clearTimeout(navigationTimer);
        navigationTimer = setTimeout(() => {
          if (!this.disposed && !window.isDestroyed() && this.grokLoginPending) {
            if (this.grokBusy) read();
            else void this.handle({ ...target, url: grokBotUsagePage, action: 'usage' });
          }
        }, 250);
      };
      window.webContents.on('did-finish-load', read);
      window.webContents.on('did-navigate-in-page', read);
      window.on('closed', () => {
        clearTimeout(navigationTimer);
        this.grokLoginPending = false;
        if (!this.grokLast?.ok)
          this.grokLast = { ok: false, grokDiagnostic: grokDiagnostic('closed', 'navigation', grokBotUsagePage) };
      });
    }
    window.on('closed', () => {
      clearTimeout(this.trackers.get(target.agentId)?.timer);
      this.trackers.delete(target.agentId);
      this.monitors.get(target.agentId)?.close();
      this.monitors.delete(target.agentId);
      if (this.windows.get(target.agentId) === window) this.windows.delete(target.agentId);
    });
    this.windows.set(target.agentId, window);
    this.monitors.set(
      target.agentId,
      new WebUsageMonitor({
        window,
        grok: target.agentId === grokBotUsageAgentId,
        onGrokResult: (result) => {
          if (target.agentId === grokBotUsageAgentId && this.grokFallback && !this.grokBusy)
            this.finishGrok(
              window,
              result.ok || result.grokDiagnostic?.code === 'no-plan' ? result : (this.grokPrimaryFailure ?? result),
            );
        },
        snapshot: () => this.snapshot(window.webContents, this.pageSelectors.get(target.agentId), true),
        blocked: async () => {
          const found = await this.page<Found>(window.webContents, '__pugportBridge.find({})');
          return !!found.check || (target.agentId !== grokBotUsageAgentId && !found.input && found.loginHint);
        },
        page: (code) => this.page(window.webContents, code),
        reloadUsage: (url) => this.load(window, url, target.name, true, true),
      }),
    );
    return window;
  }

  private harden(window: BrowserWindow, partition: string, background = false) {
    const contents = window.webContents;
    if (!this.hardened.has(partition)) {
      this.hardened.add(partition);
      const session = contents.session;
      // No camera, microphone, location or notifications for a site PugPort drives.
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      // Never PugPort's own local server or this computer's files.
      session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: details.url.startsWith('file:') || isAppPageRequest(details.url, this.options.port) }),
      );
    }
    // Sign-in pop-ups (e.g. "continue with Google") stay in the same isolated profile.
    contents.setWindowOpenHandler(({ url }) =>
      !background && webAgentUrl(url)
        ? {
            action: 'allow',
            overrideBrowserWindowOptions: {
              autoHideMenuBar: true,
              webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
            },
          }
        : { action: 'deny' },
    );
    contents.on('will-navigate', (event, url) => {
      if (!webAgentUrl(url)) event.preventDefault();
    });
  }

  private present(window: BrowserWindow) {
    if (this.options.present) return this.options.present(window);
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
  }

  /** Opens the agent's page unless the window is already on that site (the user may be in a particular chat). */
  private async load(window: BrowserWindow, url: string, name: string, exact = false, reload = false) {
    const contents = window.webContents;
    let origin = '';
    try {
      origin = new URL(contents.getURL()).origin;
    } catch {
      /* Nothing loaded yet. */
    }
    if (reload || origin !== new URL(url).origin || (exact && contents.getURL() !== url)) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          // A redirect while loading (to a sign-in page, say) aborts the first navigation; that is not a failure.
          window.loadURL(url).catch((error: unknown) => {
            if (!/ERR_ABORTED|\(-3\)/.test(String(error))) throw error;
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), this.options.loadTimeoutMs ?? 45_000);
          }),
        ]);
      } catch {
        throw new BridgeStop({ ok: false, code: 'load-failed', message: `打不开 ${name} 的网页，请检查网址和网络。` });
      } finally {
        clearTimeout(timer);
      }
    }
    const until = Date.now() + 15_000;
    while (!window.isDestroyed() && contents.isLoading() && Date.now() < until) await pause(200);
    await pause(400);
  }

  private page<T>(contents: WebContents, code: string): Promise<T> {
    return contents.executeJavaScriptInIsolatedWorld(world, [{ code: `${pageHelper};\n${code}` }]) as Promise<T>;
  }
  private status(contents: WebContents, selectors?: WebSelectors) {
    return this.page<Status>(contents, `__pugportBridge.status(${JSON.stringify(selectors ?? {})})`);
  }
  private snapshot(contents: WebContents, selectors?: WebSelectors, includeText = false) {
    return this.page<{ notices: string[]; text: string; url: string }>(
      contents,
      webUsageSnapshot(selectors?.reply, includeText),
    );
  }
  private async limit(contents: WebContents, selectors?: WebSelectors): Promise<WebAgentResult | undefined> {
    const page = await this.snapshot(contents, selectors);
    const limit = page.notices.map((text) => detectWebLimit(text, true)).find(Boolean);
    return limit ? { ok: false, limit, message: '已用完，请等待额度重置。' } : undefined;
  }
  private finishGrok(window: BrowserWindow, result: WebAgentResult) {
    this.grokLast = result;
    if (result.ok && result.quota?.status === 'known' && this.grokLoginPending) {
      this.grokLoginPending = false;
      // Hide immediately; retain the page and learned GET signatures for background refresh.
      if (!window.isDestroyed()) window.hide();
    }
    return result;
  }
  private async grokUsage(request: Extract<WebAgentRequest, { action: 'usage' }>): Promise<WebAgentResult> {
    if (this.grokBusy) return this.grokLast ?? { ok: false };
    this.grokBusy = true;
    this.grokFallback = false;
    this.grokPrimaryFailure = undefined;
    const window = this.window(request);
    const contents = window.webContents;
    const fail = (code: 'login' | 'human-check' | 'no-data') =>
      this.finishGrok(window, {
        ok: false,
        ...(code !== 'no-data' ? { code } : {}),
        grokDiagnostic: grokDiagnostic(code, code === 'no-data' ? 'parse' : code, contents.getURL()),
      });
    try {
      const monitor = this.monitors.get(request.agentId)!;
      monitor.configure(true, request.signatures, grokBotUsagePage, grokBotUsagePage);
      monitor.beginGrokRead();
      if (!contents.getURL()) await this.load(window, grokBotUsagePage, request.name, true);
      else if (request.automatic && !this.grokLoginPending)
        await this.load(window, grokBotUsagePage, request.name, true, true);
      let found = await this.page<Found>(contents, '__pugportBridge.find({})');
      let url = new URL(contents.getURL());
      if (found.check || url.origin !== 'https://cursor.com' || !/^\/dashboard(?:\/|$)/.test(url.pathname))
        return fail(found.check || 'login');
      if (url.pathname !== '/dashboard/spending') await this.load(window, grokBotUsagePage, request.name, true);
      found = await this.page<Found>(contents, '__pugportBridge.find({})');
      url = new URL(contents.getURL());
      if (found.check || url.origin !== 'https://cursor.com' || !/^\/dashboard(?:\/|$)/.test(url.pathname))
        return fail(found.check || 'login');
      const active = await readGrokBotPageUsage((code) => this.page(contents, code), contents.getURL());
      if (window.isDestroyed())
        return this.finishGrok(window, {
          ok: false,
          code: 'closed',
          grokDiagnostic: grokDiagnostic('closed', 'navigation', grokBotUsagePage),
        });
      if (active.ok) return this.finishGrok(window, active);
      this.grokPrimaryFailure = active;
      this.grokFallback = true;
      await monitor.capture(true);
      const result = monitor.result();
      if (result.grokDiagnostic && result.grokDiagnostic.code !== 'success')
        return this.finishGrok(
          window,
          result.grokDiagnostic.code === 'no-plan' ? { ...result, ok: false, quota: undefined } : active,
        );
      const quota = result.quota;
      const grokWindow = quota?.windows.find(
        (w) =>
          w.id === 'grok-bot' &&
          /^(?:SuperGrok(?: Heavy)?|Grok Bot Plan|(?:Cursor )?(?:Free|Pro|Pro\+|Ultra|Business|Enterprise|Team))$/i.test(
            w.label,
          ),
      );
      if (quota?.status === 'known' && !quota.stale && grokWindow)
        return this.finishGrok(window, {
          ...result,
          ok: true,
          grokDiagnostic:
            result.grokDiagnostic?.code === 'success'
              ? result.grokDiagnostic
              : grokDiagnostic('success', 'parse', contents.getURL()),
          quota: {
            ...quota,
            windows: [grokWindow],
            balances: undefined,
            source: '独立登录 · Grok Bot 用量',
            subscription: {
              label: quota.subscription?.label ?? grokWindow.label,
              source: '独立登录 · Grok Bot 用量',
              observedAt: quota.observedAt!,
            },
          },
        });
      return this.finishGrok(window, active);
    } finally {
      this.grokBusy = false;
    }
  }
  private async usage(request: Extract<WebAgentRequest, { action: 'usage' }>): Promise<WebAgentResult> {
    if (request.background) return this.backgroundUsage(request);
    const existing = this.windows.get(request.agentId);
    if (request.automatic && (!existing || existing.isDestroyed())) return { ok: false, code: 'login' };
    const window = this.window(request);
    const monitor = this.monitors.get(request.agentId)!;
    if (request.automatic) {
      monitor.configure(true, undefined, request.usageUrl, request.url, request.configurationVersion);
      const result = await monitor.refresh(request.afterReply);
      if (result.usageUrl && window.webContents.getURL() === result.usageUrl) this.usagePages.add(request.agentId);
      return { ...result, message: result.signatures?.length || result.usageUrl ? undefined : webUsageInvitation };
    }
    const contents = window.webContents;
    const previous = contents.getURL();
    monitor.configure(true, undefined, request.usageUrl, request.url, request.configurationVersion);
    if (previous) {
      const found = await this.page<Found>(contents, '__pugportBridge.find({})');
      if (found.check || (!found.input && found.loginHint))
        return this.needsUser(window, found.check || 'login', request.name);
    }
    this.present(window);
    if (request.navigate || !webAgentUrl(previous))
      await this.load(window, request.url, request.name, request.navigate === true);
    if (request.navigate) this.usagePages.add(request.agentId);
    const found = await this.page<Found>(contents, '__pugportBridge.find({})');
    if (found.check || found.loginHint) return this.needsUser(window, found.check || 'login', request.name);
    await monitor.capture(true);
    return {
      ...monitor.result(),
      message: request.navigate ? undefined : webUsageInstructions,
      pageUrl: contents.getURL(),
    };
  }
  /** This path owns only a temporary usage window; it can never present the user's chat window. */
  private async backgroundUsage(request: Extract<WebAgentRequest, { action: 'usage' }>): Promise<WebAgentResult> {
    const partition = webAgentPartition(request.agentId);
    const origin = new URL(request.url).origin;
    const controller = new AbortController();
    let window: BrowserWindow | undefined;
    let monitor: WebUsageMonitor | undefined;
    let timer: NodeJS.Timeout | undefined;
    const read = async (): Promise<WebAgentResult> => {
      const signatures = (request.signatures ?? [])
        .filter((value) => usageSignatureSchema.safeParse(value).success && safeUsageRequest(value, origin))
        .slice(0, 4);
      if (signatures.length) {
        let quota: WebQuota | undefined;
        for (const signature of signatures) {
          const url = new URL(signature.path, origin).href;
          if (controller.signal.aborted || this.disposed || isAppPageRequest(url, this.options.port))
            return { ok: false, code: 'closed' };
          const response = await session.fromPartition(partition).fetch(url, {
            method: 'GET',
            credentials: 'include',
            redirect: 'manual',
            cache: 'no-store',
            signal: controller.signal,
          });
          if (
            response.status === 401 ||
            (response.status >= 300 &&
              response.status < 400 &&
              /(?:^|\/)(?:login|signin|sign-in|auth|oauth)(?:\/|$)/i.test(
                new URL(response.headers.get('location') ?? '', url).pathname,
              ))
          )
            return { ok: false, code: 'login' };
          if (!response.ok) return { ok: false, code: 'load-failed' };
          const text = await response.text();
          if (text.length > 131072) return { ok: false, code: 'error' };
          const parsed = readLearnedUsage(JSON.parse(text), signature, Date.now());
          if (!parsed) return { ok: false, code: 'error' };
          quota = mergeWebUsage(quota, parsed);
        }
        return { ok: true, quota };
      }
      const url = request.usageUrl || request.url;
      if (!safeWebUsageRoute(url, origin)) return { ok: false, code: 'error' };
      window = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          partition,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          disableDialogs: true,
        },
      });
      this.harden(window, partition, true);
      const contents = window.webContents;
      let blocked: 'login' | 'human-check' | undefined;
      monitor = new WebUsageMonitor({
        window,
        autoTick: false,
        snapshot: () => this.snapshot(contents, request.selectors, true),
        blocked: async () => {
          const found = await this.page<Found>(contents, '__pugportBridge.find({})');
          blocked = found.check || (found.loginHint ? 'login' : undefined);
          return !!blocked;
        },
        page: (code) => this.page(contents, code),
        reloadUsage: (route) => this.load(window!, route, request.name, true),
      });
      await this.load(window, url, request.name, true);
      if (controller.signal.aborted || this.disposed) return { ok: false, code: 'closed' };
      const found = await this.page<Found>(contents, '__pugportBridge.find({})');
      if (found.check || found.loginHint) return { ok: false, code: found.check || 'login' };
      const loaded = new URL(contents.getURL());
      if (loaded.origin !== origin || /(?:^|\/)(?:login|signin|sign-in|auth|oauth)(?:\/|$)/i.test(loaded.pathname))
        return { ok: false, code: 'login' };
      monitor.configure(true, [], url, request.url, request.configurationVersion);
      const result = await monitor.refresh(false, true);
      if (blocked) return { ok: false, code: blocked };
      return result.quota?.status === 'known' && !result.quota.stale
        ? { ok: true, quota: result.quota }
        : { ok: false, code: 'error' };
    };
    try {
      return await Promise.race([
        read(),
        new Promise<WebAgentResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ ok: false, code: 'timeout' });
          }, 60_000);
        }),
      ]);
    } catch {
      return { ok: false, code: 'error' };
    } finally {
      clearTimeout(timer);
      controller.abort();
      monitor?.close();
      if (window && !window.isDestroyed()) window.destroy();
    }
  }
  /** Single-page apps draw the chat box a moment after loading. */
  private async waitForPage(contents: WebContents, selectors: WebSelectors | undefined, ms: number) {
    const until = Date.now() + ms;
    let found: Found;
    do {
      found = await this.page<Found>(contents, `__pugportBridge.find(${JSON.stringify(selectors ?? {})})`);
      if (found.input || found.check) return found;
      await pause(500);
    } while (Date.now() < until);
    return found;
  }
  private needsUser(window: BrowserWindow, check: 'human-check' | 'login', name: string): WebAgentResult {
    this.present(window);
    return check === 'human-check'
      ? {
          ok: false,
          code: 'human-check',
          message: `${name} 的页面要求人机验证。已把它的窗口放到最前面：请在那里完成，再回到 PugPort 点「重试」。`,
        }
      : {
          ok: false,
          code: 'login',
          message: `需要先登录 ${name}。已把它的窗口放到最前面：请在那里登录，再回到 PugPort 点「重试」。`,
        };
  }
  private notDetected(name: string): WebAgentResult {
    return {
      ok: false,
      code: 'not-detected',
      message: `没认出 ${name} 页面上的输入框。可以在设置里点「重新识别」，或点「交给它」自己粘贴发送。`,
      found: { input: false, send: false, reply: false },
    };
  }

  private async detect(request: Extract<WebAgentRequest, { action: 'detect' }>): Promise<WebAgentResult> {
    const window = this.window(request);
    await this.load(window, request.url, request.name);
    const found = await this.waitForPage(window.webContents, request.selectors, 10_000);
    if (found.check || (!found.input && found.loginHint))
      return this.needsUser(window, found.check || 'login', request.name);
    const limit = await this.limit(window.webContents, found.selectors);
    if (limit) return limit;
    if (!found.input) return this.notDetected(request.name);
    return {
      ok: true,
      found: { input: found.input, send: found.send, reply: found.reply },
      selectors: found.selectors,
    };
  }

  private async loadConversation(
    window: BrowserWindow,
    request: { agentId: string; name: string; url: string; conversationId?: string; threadUrl?: string },
  ) {
    const previousConversationId = this.activeConversations.get(request.agentId);
    const switchedConversation = Boolean(
      request.conversationId && previousConversationId && previousConversationId !== request.conversationId,
    );
    if (request.conversationId) this.activeConversations.set(request.agentId, request.conversationId);
    const savedThreadUrl =
      request.threadUrl ??
      (request.conversationId ? this.conversationUrls.get(`${request.agentId}:${request.conversationId}`) : undefined);
    const targetUrl =
      savedThreadUrl && URL.parse(savedThreadUrl)?.origin === URL.parse(request.url)?.origin
        ? savedThreadUrl
        : request.url;
    await this.load(
      window,
      targetUrl,
      request.name,
      this.usagePages.has(request.agentId) || switchedConversation || Boolean(savedThreadUrl),
      switchedConversation && !savedThreadUrl,
    );
    this.usagePages.delete(request.agentId);
  }

  private rememberConversationUrl(
    contents: WebContents,
    request: { agentId: string; conversationId?: string },
  ): string | undefined {
    const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (!currentUrl || !webAgentUrl(currentUrl)) return undefined;
    if (request.conversationId) this.conversationUrls.set(`${request.agentId}:${request.conversationId}`, currentUrl);
    return currentUrl;
  }

  private async recapture(request: Extract<WebAgentRequest, { action: 'recapture' }>): Promise<WebAgentResult> {
    const window = this.window(request);
    const contents = window.webContents;
    await this.loadConversation(window, request);
    if (request.trackerId) {
      const peeked = await this.page<WebAgentResult>(
        contents,
        `__pugportBridge.peek(${JSON.stringify(request.trackerId)}, ${JSON.stringify(request.selectors ?? {})})`,
      );
      if (peeked.ok && peeked.reply?.trim()) {
        const limit = await this.limit(contents, request.selectors);
        return limit ? { ...limit, sent: true } : { ...peeked, sent: true };
      }
    }
    const found = await this.waitForPage(contents, request.selectors, 10_000);
    if (found.check || (!found.input && found.loginHint))
      return { ...this.needsUser(window, found.check || 'login', request.name), sent: true };
    const limit = await this.limit(contents, { ...found.selectors, ...request.selectors });
    if (limit) return { ...limit, sent: true };
    const result = await this.page<WebAgentResult>(
      contents,
      `__pugportBridge.recapture(${JSON.stringify(request.text)}, ${JSON.stringify(request.selectors ?? {})})`,
    );
    if (result.trackerId) {
      clearTimeout(this.trackers.get(request.agentId)?.timer);
      const timer = setTimeout(
        () => void this.stopTracker(request.agentId, result.trackerId!, contents).catch(() => undefined),
        this.options.followMaxMs ?? 31 * 60_000,
      );
      timer.unref?.();
      this.trackers.set(request.agentId, { id: result.trackerId, timer });
    }
    if (result.ok && result.reply?.trim()) return { ...result, sent: true };
    if (result.code === 'ambiguous') return ambiguousReply(request.name);
    if (result.code === 'human-check' || result.code === 'login')
      return {
        ...this.needsUser(window, result.code, request.name),
        sent: true,
        ...(result.trackerId ? { trackerId: result.trackerId } : {}),
      };
    return {
      ok: false,
      sent: true,
      code: 'not-detected',
      ...(result.trackerId ? { trackerId: result.trackerId } : {}),
      message: `消息发出去了，但没认出 ${request.name} 的回复。请到它的窗口里查看。`,
    };
  }

  private click(contents: WebContents, at: Point) {
    contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  private enter(contents: WebContents, shift = false) {
    const modifiers: Array<'shift'> = shift ? ['shift'] : [];
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers });
    contents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers });
  }
  /** Sent once the box let go of the text, the page changed, or the site shows it is answering. */
  private async wasSent(contents: WebContents, selectors: WebSelectors | undefined, text: string, ms = 3000) {
    const until = Date.now() + ms;
    do {
      const status = await this.status(contents, selectors);
      const limit = await this.limit(contents, selectors);
      if (limit) {
        throw new BridgeStop(limit);
      }
      if (status.check === 'human-check' || status.check === 'login')
        throw new BridgeStop({ ok: false, code: status.check, message: '页面需要你先完成人机验证或登录。' });
      if (status.changed > 0 || status.generating || !typed(status.inputText, text)) return true;
      await pause(250);
    } while (Date.now() < until);
    return false;
  }

  private async send(request: Extract<WebAgentRequest, { action: 'send' }>): Promise<WebAgentResult> {
    this.cancelledSends.delete(request.agentId);
    const checkCancelledBeforeSend = () => {
      if (this.cancelledSends.delete(request.agentId))
        throw new BridgeStop({ ok: false, code: 'not-sent', message: '已停止，这条没有发出去。' });
    };
    const window = this.window(request);
    const contents = window.webContents;
    const selectors = request.selectors;
    await this.loadConversation(window, request);
    checkCancelledBeforeSend();
    const found = await this.waitForPage(contents, selectors, 12_000);
    checkCancelledBeforeSend();
    if (found.check || (!found.input && found.loginHint))
      return this.needsUser(window, found.check || 'login', request.name);
    const limit = await this.limit(contents, { ...found.selectors, ...selectors });
    if (limit) return limit;
    if (!found.input) return this.notDetected(request.name);
    const text = request.text;
    const notSent: WebAgentResult = {
      ok: false,
      code: 'not-sent',
      message: '没能把消息放进输入框并发出去。可以点「重试」，或点「交给它」自己粘贴发送。',
    };

    // Type: through the browser, as a person would, so the site's editor sees ordinary input.
    let trackerId = await this.page<string>(contents, `__pugportBridge.track(${JSON.stringify(text)})`);
    clearTimeout(this.trackers.get(request.agentId)?.timer);
    const timer = setTimeout(
      () => void this.stopTracker(request.agentId, trackerId, contents).catch(() => undefined),
      this.options.followMaxMs ?? 31 * 60_000,
    );
    timer.unref?.();
    this.trackers.set(request.agentId, { id: trackerId, timer });
    let following = false;
    try {
      checkCancelledBeforeSend();
      const at = await this.page<Point | null>(contents, '__pugportBridge.prepare()');
      if (!at) return this.notDetected(request.name);
      this.click(contents, at);
      await pause(120);
      checkCancelledBeforeSend();
      await this.page(contents, '__pugportBridge.prepare()');
      contents.focus();
      if (found.editable) {
        // Rich editors take a line at a time; Shift+Enter starts a new line without sending.
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (index) this.enter(contents, true);
          if (line) await contents.insertText(line);
        }
      } else await contents.insertText(text);
      await pause(200);
      if (!typed(await this.page<string>(contents, '__pugportBridge.value()'), text)) {
        await this.page(contents, `__pugportBridge.setValue(${JSON.stringify(text)})`);
        await pause(200);
        if (!typed(await this.page<string>(contents, '__pugportBridge.value()'), text)) return notSent;
      }
      const beforeSend = await this.limit(contents, { ...found.selectors, ...selectors });
      if (beforeSend) return beforeSend;
      checkCancelledBeforeSend();

      // Send: the send button once the site enables it, otherwise Enter. A second way is tried only when the first
      // clearly did nothing (the text still sits in the box and the page did not change), so nothing is sent twice.
      let button: (Point & { disabled: boolean }) | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        checkCancelledBeforeSend();
        button = await this.page(contents, `__pugportBridge.sendTarget(${JSON.stringify(selectors ?? {})})`);
        if (!button?.disabled) break;
        await pause(200);
      }
      checkCancelledBeforeSend();
      if (button && !button.disabled) this.click(contents, button);
      else this.enter(contents);
      if (!(await this.wasSent(contents, selectors, text))) {
        checkCancelledBeforeSend();
        this.enter(contents);
        if (!(await this.wasSent(contents, selectors, text))) {
          checkCancelledBeforeSend();
          await this.page(contents, '__pugportBridge.pressEnter()');
          if (!(await this.wasSent(contents, selectors, text))) return notSent;
        }
      }

      // Wait: the reply has started, the site no longer shows it is answering, and nothing changed for a while.
      const timeoutMs = clamp(request.timeoutMs, 3000, 600_000, 180_000);
      const stableMs = clamp(request.stableMs, 300, 30_000, 3000);
      const started = Date.now();
      let timedOut = false;
      let timedOutGenerating = false;
      for (;;) {
        if (window.isDestroyed()) throw new Error('closed');
        if (this.cancelledSends.delete(request.agentId)) {
          return {
            ok: false,
            code: 'timeout',
            sent: true,
            trackerId,
            message: '已停止等待；这条消息已经发出，请到它的窗口查看，避免重复发送。',
          };
        }
        const status = await this.status(contents, selectors);
        if (status.check === 'human-check' || status.check === 'login') {
          following = true;
          return { ...this.needsUser(window, status.check, request.name), sent: true, trackerId };
        }
        const limit = await this.limit(contents, { ...found.selectors, ...selectors });
        if (limit) return { ...limit, sent: true };
        if (!status.tracking) {
          if (!this.trackers.has(request.agentId)) return { ok: false, code: 'replaced', sent: true };
          // The page reloaded after sending: the prompt is already on it.
          trackerId = await this.page<string>(contents, `__pugportBridge.track(${JSON.stringify(text)}, true)`);
          this.trackers.set(request.agentId, { id: trackerId, timer });
        }
        const quiet = status.quietMs ?? Date.now() - started;
        if (status.changed > 0 && !status.generating && quiet >= stableMs) {
          const candidate = await this.page<PageReply | null>(
            contents,
            `__pugportBridge.reply(${JSON.stringify(selectors ?? {})})`,
          );
          // The page is settled, so an unattributable reply will not sort itself out by waiting.
          if (candidate?.text || candidate?.code) break;
        }
        if (Date.now() - started > timeoutMs) {
          timedOut = true;
          timedOutGenerating = status.generating;
          break;
        }
        await pause(this.options.pollMs ?? 400);
      }
      const reply = await this.page<PageReply | null>(
        contents,
        `__pugportBridge.reply(${JSON.stringify(selectors ?? {})})`,
      );
      if (reply?.code === 'ambiguous') return ambiguousReply(request.name);
      const timeoutMessage = timedOutGenerating
        ? '它还在回复，已超过等待时间；请在它的窗口里查看'
        : '没找到它的回复，请在它的窗口里查看。';
      if (!reply?.text)
        return timedOut
          ? { ok: false, code: 'timeout', sent: true, message: timeoutMessage }
          : {
              ok: false,
              code: 'not-detected',
              sent: true,
              message: `消息发出去了，但没认出 ${request.name} 的回复。请到它的窗口里查看。`,
            };
      following = true;
      const pageUrl = this.rememberConversationUrl(contents, request);
      return {
        ok: true,
        sent: true,
        trackerId,
        reply: reply.text,
        ...(pageUrl ? { pageUrl } : {}),
        ...(reply.truncated ? { truncated: true } : {}),
        ...(timedOut ? { partial: true, ...(timedOutGenerating ? { message: timeoutMessage } : {}) } : {}),
        selectors: { ...found.selectors, ...(reply.selector ? { reply: reply.selector } : {}) },
        found: { input: true, send: found.send, reply: true },
      };
    } finally {
      if (!following) await this.stopTracker(request.agentId, trackerId, contents).catch(() => undefined);
    }
  }
  private async stopTracker(agentId: string, trackerId: string, contents: WebContents) {
    if (this.trackers.get(agentId)?.id === trackerId) {
      clearTimeout(this.trackers.get(agentId)!.timer);
      this.trackers.delete(agentId);
    }
    await this.page(contents, `__pugportBridge.stop(${JSON.stringify(trackerId)})`);
  }
}
