import { grokObservedRequest, grokObservedUsage } from '../../electron/grok-bot-usage.ts';
import { grokDiagnostic } from '../../shared/grok-usage.ts';
import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { WebAgentResult } from '../../shared/web-bridge.ts';
import type { WebQuota, WebUsageSignature } from '../../shared/external-agents.ts';
import { detectWebLimit, parseWebUsage, parseWebReset } from './config.ts';
import {
  learnUsageSignature,
  mergeWebUsage,
  readLearnedUsage,
  safeUsageRequest,
  usageMetrics,
  usageSignatureSchema,
  partialUsageSamples,
  safeWebUsageRoute,
  type UsageResponse,
} from './usage.ts';

type Options = {
  window: BrowserWindow;
  snapshot(): Promise<{ text: string; notices: string[]; url: string; usageBlocks?: string[] }>;
  reloadUsage?(url: string): Promise<void>;
  blocked(): Promise<boolean>;
  page<T>(code: string): Promise<T>;
  now?: () => number;
  autoTick?: boolean;
  grok?: boolean;
  onGrokResult?(result: WebAgentResult): void;
};
export const webUsageRefreshMs = 10 * 60_000;

/** Watches visible page text and retains only quota numbers, dates and read-only request signatures. */
export class WebUsageMonitor {
  private enabled = true;
  private attached = false;
  private seeded = false;
  private readonly debuggerApi: BrowserWindow['webContents']['debugger'];
  private busy = false;
  private refreshing = false;
  private blocked = false;
  private timer?: NodeJS.Timeout;
  private key?: string;
  private quota?: WebQuota;
  private limit?: WebAgentResult['limit'];
  private signatures: WebUsageSignature[] = [];
  private readonly requests = new Map<string, { response: UsageResponse; ready?: boolean }>();
  private candidates: { response: UsageResponse; at: number }[] = [];
  private finished: { id: string; response: UsageResponse; at: number }[] = [];
  private errors = 0;
  private nextAttempt = 0;
  private lastCapture = -Infinity;
  private usageUrl?: string;
  private configuredUsageUrl?: string;
  private configuredOrigin?: string;
  private configurationVersion?: string;
  private generation = 0;
  private homeUrl?: string;
  private pageUrl?: string;
  /** Where the page sat without usage for two captures (one may be a usage page still loading). A panel opening there has no address to reload. */
  private plainUrl?: string;
  private diagnostics: string[] = [];
  private grokResult?: WebAgentResult;
  private grokEndpoint?: string;
  private grokGeneration = 0;
  private readonly grokRequests = new Map<string, { url: string; status?: number; ready?: boolean }>();
  constructor(private readonly options: Options) {
    this.debuggerApi = options.window.webContents.debugger;
    if (options.autoTick !== false) {
      this.timer = setInterval(() => void this.capture().catch(() => undefined), 3000);
      this.timer.unref();
    }
    this.attach();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private origin() {
    try {
      return new URL(this.options.window.webContents.getURL()).origin;
    } catch {
      return '';
    }
  }
  private visible() {
    return this.currentSite() && (this.options.grok || this.options.window.isVisible());
  }
  private currentSite() {
    return (
      this.enabled &&
      !this.options.window.isDestroyed() &&
      (!this.configuredOrigin || this.configuredOrigin === this.origin())
    );
  }
  private current() {
    const generation = this.generation;
    return () => generation === this.generation && this.currentSite();
  }
  configure(
    enabled: boolean,
    signatures?: WebUsageSignature[],
    usageUrl?: string,
    homeUrl?: string,
    configurationVersion?: string,
  ) {
    const origin = homeUrl ? URL.parse(homeUrl)?.origin : this.configuredOrigin;
    const originChanged = !!origin && origin !== (this.configuredOrigin ?? this.origin());
    const usageChanged = !!usageUrl && usageUrl !== this.usageUrl;
    const versionChanged =
      configurationVersion !== undefined &&
      this.configurationVersion !== undefined &&
      configurationVersion !== this.configurationVersion;
    if (configurationVersion !== undefined) this.configurationVersion = configurationVersion;
    if (originChanged || usageChanged || versionChanged || enabled !== this.enabled) this.generation++;
    if (originChanged || usageChanged || versionChanged) {
      this.quota = undefined;
      this.limit = undefined;
      this.key = undefined;
      this.blocked = false;
      this.signatures = [];
      this.seeded = false;
      this.diagnostics = [];
      this.requests.clear();
      this.candidates = [];
      this.finished = [];
      this.usageUrl = undefined;
      this.configuredUsageUrl = undefined;
      this.errors = 0;
      this.nextAttempt = 0;
      this.lastCapture = -Infinity;
    }
    this.enabled = enabled;
    if (homeUrl) {
      this.homeUrl = homeUrl;
      this.configuredOrigin = origin;
    }
    if (usageUrl !== undefined) {
      this.configuredUsageUrl = usageUrl;
      if (usageUrl || versionChanged)
        this.usageUrl = safeWebUsageRoute(usageUrl, origin ?? this.origin()) ? usageUrl : undefined;
    }
    if (!enabled) {
      this.grokRequests.clear();
      this.requests.clear();
      this.candidates = [];
      this.finished = [];
      return;
    }
    if (!this.seeded && signatures && /^https?:/.test(this.origin())) {
      const accepted = signatures
        .filter((value) => usageSignatureSchema.safeParse(value).success && safeUsageRequest(value, this.origin()))
        .slice(0, 4);
      if (!signatures.length || accepted.length) {
        this.signatures = accepted;
        this.seeded = true;
      }
    }
    this.attach();
  }
  result(): WebAgentResult {
    return {
      ok: true,

      ...(this.quota
        ? {
            quota: {
              ...this.quota,
              ...(this.blocked ? { stale: true } : {}),
            },
          }
        : {}),
      ...(this.limit ? { limit: this.limit } : {}),
      ...(this.seeded || this.signatures.length ? { signatures: this.signatures } : {}),
      ...(this.usageUrl ? { usageUrl: this.usageUrl } : {}),
      usageDiagnostics: this.diagnostics,
      ...(this.options.grok ? this.grokResult : {}),
      ...(this.blocked ? { code: 'human-check' as const } : {}),
    };
  }
  /** Discard old fallback readings before the primary RPC; in-flight bodies belong to the old attempt. */
  beginGrokRead() {
    if (!this.options.grok) return;
    this.grokGeneration++;
    this.grokResult = undefined;
    this.grokRequests.clear();
    this.quota = undefined;
    this.key = undefined;
  }
  clearLimit() {
    this.limit = undefined;
    this.blocked = false;
  }
  close() {
    clearInterval(this.timer);
    this.enabled = false;
    this.generation++;
    this.detach();
  }
  private detach() {
    const debuggerApi = this.debuggerApi;
    try {
      debuggerApi?.removeListener('message', this.network);
      debuggerApi?.removeListener('detach', this.onDetach);
      if (this.attached) debuggerApi.detach();
    } catch {
      /* The closed window may have detached already. */
    }
    this.attached = false;
    this.requests.clear();
    this.grokRequests.clear();
    this.candidates = [];
    this.finished = [];
  }
  private onDetach = () => {
    this.debuggerApi.removeListener('message', this.network);
    this.attached = false;
    this.requests.clear();
    this.finished = [];
  };
  private attach() {
    const debuggerApi = this.debuggerApi;
    if (!this.enabled || this.attached || !debuggerApi || debuggerApi.isAttached()) return;
    try {
      debuggerApi.attach('1.3');
      this.attached = true;
      debuggerApi.on('message', this.network);
      debuggerApi.removeListener('detach', this.onDetach);
      debuggerApi.on('detach', this.onDetach);
      void debuggerApi
        .sendCommand('Network.enable', { maxTotalBufferSize: 262144, maxResourceBufferSize: 131072 })
        .catch(() => this.detach());
    } catch {
      /* DOM capture still works when DevTools owns the debugger. */
    }
  }
  private network = (_event: unknown, method: string, params: any) => {
    if (!this.currentSite() || this.refreshing) return;
    if (this.options.grok) this.observeGrok(method, params);
    if (method === 'Network.requestWillBeSent') {
      try {
        const url = new URL(params.request.url);
        const response: UsageResponse = {
          method: params.request.method,
          origin: url.origin,
          path: url.pathname,
          metrics: [],
        };
        if (safeUsageRequest(response, this.origin())) {
          if (this.requests.size >= 32) this.requests.delete(this.requests.keys().next().value!);
          this.requests.set(params.requestId, { response });
        }
      } catch {
        /* Ignore malformed or unrelated requests. */
      }
    } else if (method === 'Network.responseReceived') {
      const request = this.requests.get(params.requestId);
      if (request) {
        try {
          const url = new URL(params.response.url);
          request.ready =
            url.origin === this.origin() &&
            url.pathname === request.response.path &&
            params.response.status >= 200 &&
            params.response.status < 300 &&
            /json/i.test(params.response.mimeType);
        } catch {
          request.ready = false;
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const request = this.requests.get(params.requestId);
      this.requests.delete(params.requestId);
      if (request?.ready && params.encodedDataLength <= 131072) {
        this.finished = this.finished.filter((item) => this.now() - item.at < 30_000).slice(-15);
        this.finished.push({ id: params.requestId, response: request.response, at: this.now() });
        void this.capture().catch(() => undefined);
      }
    } else if (method === 'Network.loadingFailed') this.requests.delete(params.requestId);
  };
  private publishGrok(result: WebAgentResult) {
    if (!this.enabled || this.options.window.isDestroyed()) return;
    this.grokResult = result;
    this.options.onGrokResult?.(result);
  }
  private observeGrok(method: string, params: any) {
    const pageUrl = this.options.window.webContents.getURL();
    if (method === 'Network.requestWillBeSent') {
      if (params.type === 'Document') {
        this.beginGrokRead();
      }
      this.grokRequests.delete(params.requestId);
      if (grokObservedRequest(params.request?.method, params.request?.url, pageUrl)) {
        if (this.grokRequests.size >= 32) this.grokRequests.delete(this.grokRequests.keys().next().value!);
        this.grokRequests.set(params.requestId, { url: params.request.url });
      }
    } else if (method === 'Network.responseReceived') {
      const entry = this.grokRequests.get(params.requestId);
      if (!entry) return;
      if (params.response?.url !== entry.url) {
        this.grokRequests.delete(params.requestId);
        return;
      }
      entry.status = params.response?.status;
      entry.ready = entry.status! >= 200 && entry.status! < 300 && /json/i.test(params.response?.mimeType);
      if (entry.status! >= 400 && (!this.grokResult?.ok || this.grokEndpoint === entry.url))
        this.publishGrok({ ok: false, grokDiagnostic: grokDiagnostic('refused', 'request', pageUrl, entry.status) });
    } else if (method === 'Network.loadingFailed') {
      if (this.grokRequests.delete(params.requestId))
        this.publishGrok({ ok: false, grokDiagnostic: grokDiagnostic('error', 'request', pageUrl) });
    } else if (method === 'Network.loadingFinished') {
      const entry = this.grokRequests.get(params.requestId);
      this.grokRequests.delete(params.requestId);
      if (!entry?.ready || params.encodedDataLength > 131072) return;
      const generation = this.grokGeneration;
      void this.debuggerApi
        .sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((body) => {
          if (
            generation !== this.grokGeneration ||
            !this.enabled ||
            this.options.window.isDestroyed() ||
            this.options.window.webContents.getURL() !== pageUrl ||
            typeof body.body !== 'string' ||
            body.body.length > 180000
          )
            return;
          const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
          const result = grokObservedUsage(json, pageUrl, entry.status!);
          if (result) {
            this.grokEndpoint = entry.url;
            this.publishGrok(result);
          } else if (!this.grokResult || this.grokEndpoint === entry.url)
            this.publishGrok({ ok: false, grokDiagnostic: grokDiagnostic('no-data', 'parse', pageUrl, entry.status) });
        })
        .catch(() => {
          if (
            generation === this.grokGeneration &&
            this.enabled &&
            !this.options.window.isDestroyed() &&
            this.options.window.webContents.getURL() === pageUrl
          )
            this.publishGrok({ ok: false, grokDiagnostic: grokDiagnostic('error', 'parse', pageUrl, entry.status) });
        });
    }
  }
  private async response(requestId: string, response: UsageResponse, quota: WebQuota) {
    const current = this.current();
    if (!this.visible() || (await this.options.blocked()) || response.origin !== this.origin()) return;
    if (!current()) return;
    const body = await this.debuggerApi.sendCommand('Network.getResponseBody', { requestId });
    if (
      !this.visible() ||
      !current() ||
      response.origin !== this.origin() ||
      typeof body.body !== 'string' ||
      body.body.length > 180000
    )
      return;
    const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
    const metrics = usageMetrics(
      json,
      quota.windows.map((window) => window.label),
    );
    this.candidates = this.candidates.filter((item) => this.now() - item.at < 60_000).slice(-15);
    this.candidates.push({ response: { ...response, metrics }, at: this.now() });
  }
  async capture(force = false) {
    if (!this.visible()) {
      this.key = undefined;
      return;
    }
    if (this.busy) return;
    if (!force && this.now() - this.lastCapture < 3000) return;
    this.lastCapture = this.now();
    this.busy = true;
    const current = this.current();
    try {
      const blocked = await this.options.blocked();
      if (!current()) return;
      this.blocked = blocked;
      if (this.blocked) return;
      const page = await this.options.snapshot();
      if (!current() || !this.visible()) return;
      const settled = page.url === this.pageUrl;
      this.pageUrl = page.url;
      if (this.configuredUsageUrl && page.url !== this.homeUrl && page.url !== this.configuredUsageUrl) return;
      const limit = page.notices.map((text) => detectWebLimit(text, true, this.now())).find(Boolean);
      if (limit && limit.reason !== this.limit?.reason) this.limit = limit;
      else if (!limit) this.limit = undefined;
      const observedNow = this.now();
      const quota = this.parsePage(page, observedNow);
      if (quota.status !== 'known') {
        if (this.options.grok) this.quota = undefined;
        const usageFound =
          !!page.usageBlocks?.length ||
          /每周限额|weekly (?:limit|allowance)|额外的?使用额度|(?:extra|additional) usage/i.test(page.text);
        if (usageFound && this.diagnostics.length && this.quota) this.quota = { ...this.quota, stale: true };
        if (!usageFound) this.homeUrl = page.url;
        if (!usageFound && settled) this.plainUrl = page.url;
        this.key = undefined;
        return;
      }
      if (
        !this.configuredUsageUrl &&
        this.homeUrl &&
        new URL(this.homeUrl).origin === this.origin() &&
        page.url !== this.homeUrl &&
        page.url !== this.plainUrl &&
        safeWebUsageRoute(page.url, this.origin())
      ) {
        this.usageUrl = page.url;
        if (!this.nextAttempt) this.nextAttempt = this.now() + webUsageRefreshMs;
      }
      const relative = /\d\s*(?:天|小时|分钟|秒)\s*后(?:重置|恢复)|resets?\s+in\s+\d/i.test(page.text);
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            windows: quota.windows.map((window) => [
              window.id,
              window.label,
              window.usedPercent,
              relative && window.resetsAt ? Date.parse(window.resetsAt) - observedNow : window.resetsAt,
            ]),
            balances: quota.balances?.map((balance) => [balance.id, balance.usedPercent, balance.remainingTokens]),
          }),
        )
        .digest('hex');
      const changed = key !== this.key || this.quota?.stale;
      if (key !== this.key) {
        this.quota = mergeWebUsage(this.quota, quota);
        this.key = key;
      } else if (this.quota?.stale) {
        this.quota = { ...this.quota, stale: false };
      }
      const finished = this.finished.splice(0).filter((item) => this.now() - item.at < 30_000);
      for (const item of finished) {
        await this.response(item.id, item.response, quota).catch(() => undefined);
        if (!current()) return;
      }
      this.learn(quota);
      // A SPA can render usage after navigation has finished. Publish that late reading too.
      if (changed && this.options.grok && (!this.grokResult || this.grokResult.grokDiagnostic?.code === 'success')) {
        const item = quota.windows.find((item) => item.id === 'grok-bot');
        if (
          item &&
          /^(?:SuperGrok(?: Heavy)?|Grok Bot Plan|(?:Cursor )?(?:Free|Pro|Pro\+|Ultra|Business|Enterprise|Team))$/i.test(
            item.label,
          )
        ) {
          const result = grokObservedUsage(
            { usagePercent: item.usedPercent, grokPlanLabel: item.label, nextResetTimestampUtc: item.resetsAt },
            page.url,
          );
          if (result?.ok) this.options.onGrokResult?.({ ...result, signatures: this.signatures });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private parsePage(page: { text: string; usageBlocks?: string[] }, now: number): WebQuota {
    const blocks = page.usageBlocks?.length ? page.usageBlocks : [page.text];
    const samples = partialUsageSamples(blocks, now, parseWebReset);
    let quota: WebQuota | undefined;
    for (const block of blocks) {
      const parsed = parseWebUsage(block, now, true);
      if (parsed.status === 'known') quota = mergeWebUsage(quota, parsed);
    }
    if (samples.length || quota) this.diagnostics = samples;
    return quota ?? { status: 'unknown', source: '网页用量页', observedAt: new Date(now).toISOString(), windows: [] };
  }
  private learn(quota: WebQuota) {
    this.signatures = this.signatures.filter((signature) => signature.origin === this.origin());
    for (const signature of this.signatures)
      for (const window of signature.windows) {
        const visible = quota.windows.find((item) => item.id === window.id);
        if (visible) window.label = visible.label;
      }
    const responses = this.candidates.filter((item) => this.now() - item.at < 60_000).map((item) => item.response);
    const readings = [
      ...quota.windows.map((window) => ({ ...quota, windows: [window], balances: [] })),
      ...(quota.balances ?? []).map((balance) => ({ ...quota, windows: [], balances: [balance] })),
    ];
    for (const reading of readings) {
      const signature = learnUsageSignature(responses, reading, this.origin());
      if (!signature) continue;
      this.seeded = true;
      const existing = this.signatures.find((item) => item.origin === signature.origin && item.path === signature.path);
      if (existing) {
        existing.windows = [
          ...existing.windows.filter((item) => !signature.windows.some((window) => window.id === item.id)),
          ...signature.windows,
        ];
        existing.balances = [
          ...existing.balances.filter((item) => !signature.balances.some((balance) => balance.id === item.id)),
          ...signature.balances,
        ];
      } else if (this.signatures.length < 4) {
        this.signatures.push(signature);
        this.nextAttempt = this.now() + webUsageRefreshMs;
      }
    }
  }
  async refresh(afterReply = false, force = false): Promise<WebAgentResult> {
    if (this.options.window.isDestroyed()) return { ...this.result(), code: 'closed' };
    if (
      !this.currentSite() ||
      this.busy ||
      (!this.signatures.length && !this.usageUrl) ||
      (!force &&
        (this.errors
          ? this.now() < this.nextAttempt
          : (!afterReply || !this.signatures.length) && this.now() < this.nextAttempt))
    )
      return this.result();
    const current = this.current();
    if (!this.signatures.length && this.visible()) {
      await this.capture(true);
      if (current()) this.nextAttempt = this.now() + webUsageRefreshMs;
      return this.result();
    }
    this.busy = true;
    this.refreshing = true;
    try {
      const blocked = await this.options.blocked();
      if (!current()) return this.result();
      this.blocked = blocked;
      if (this.blocked) return this.result();
      let next: WebQuota | undefined;
      if (!this.signatures.length && this.usageUrl) {
        if (!safeWebUsageRoute(this.usageUrl, this.origin()) || !this.options.reloadUsage) throw new Error('route');
        await this.options.reloadUsage(this.usageUrl);
        if (!current()) return this.result();
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!current()) return this.result();
          if (this.options.window.isDestroyed() || this.options.window.isVisible()) throw new Error('interrupted');
          const blocked = await this.options.blocked();
          if (!current()) return this.result();
          this.blocked = blocked;
          if (this.blocked) throw new Error('blocked');
          const page = await this.options.snapshot();
          if (!current()) return this.result();
          if (page.url !== this.usageUrl) throw new Error('route');
          const parsed = this.parsePage(page, this.now());
          if (parsed.status === 'known') {
            next = parsed;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!next) throw new Error('reading');
      }
      for (const signature of this.signatures) {
        if (!safeUsageRequest(signature, this.origin())) throw new Error('origin');
        const fields = [
          ...signature.windows.flatMap((window) => [
            window.percent,
            ...(window.reset ? [window.reset] : []),
            ...(window.labelPath ? [{ path: window.labelPath, label: true }] : []),
          ]),
          ...signature.balances.flatMap((balance) => [balance.percent, balance.remaining]),
        ];
        const values = await this.options.page<unknown[]>(`(async () => {
          if (location.origin !== ${JSON.stringify(signature.origin)}) throw new Error('origin');
          const response = await fetch(${JSON.stringify(signature.path)}, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error('request');
          const text = await response.text(); if (text.length > 131072) throw new Error('size');
          const json = JSON.parse(text);
          return ${JSON.stringify(fields)}.map(field => {
            let value = json;
            for (const key of field.path) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) || ['__proto__','constructor','prototype'].includes(key)) return null; value = value[key]; }
            if (field.label) return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 ? value.trim() : null;
            return typeof value === 'number' || (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}[T ]/.test(value)) ? value : null;
          });
        })()`);
        if (!current()) return this.result();
        if (signature.origin !== this.origin()) throw new Error('origin');
        const json: Record<string, unknown> = Object.create(null);
        if (!Array.isArray(values) || values.length !== fields.length) throw new Error('shape');
        fields.forEach((field, index) => {
          let object = json;
          for (const key of field.path.slice(0, -1))
            object = (object[key] ??= Object.create(null)) as Record<string, unknown>;
          object[field.path.at(-1)!] = values[index];
        });
        const parsed = readLearnedUsage(json, signature, this.now());
        if (!parsed) {
          this.signatures = [];
          this.candidates = [];
          throw new Error('shape');
        }
        next = mergeWebUsage(next, parsed);
      }
      if (next) this.quota = mergeWebUsage(this.quota, next);
      this.errors = 0;
      this.nextAttempt = this.now() + webUsageRefreshMs;
    } catch {
      if (!current()) return this.result();
      if (this.quota) this.quota = { ...this.quota, stale: true };
      this.errors++;
      this.nextAttempt = this.now() + Math.min(60 * 60_000, webUsageRefreshMs * 2 ** (this.errors - 1));
    } finally {
      this.busy = false;
      this.refreshing = false;
    }
    return this.result();
  }
}
