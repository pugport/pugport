import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { WebUsageMonitor } from '../src/server/external-agents/web-usage-monitor.ts';
import { EventEmitter } from 'node:events';
import { electronModule } from './helpers/electron-harness.ts';
import { grokObservedUsage, grokObservedRequest } from '../src/electron/grok-bot-usage.ts';
import {
  cleanGrokDiagnostic,
  grokDiagnostic,
  grokDiagnosticLine,
  grokDiagnosticMessages,
  grokPlanMismatch,
  grokUsageAccountLine,
  type GrokUsageAccount,
} from '../src/shared/grok-usage.ts';
import { webAgentPartition } from '../src/shared/web-bridge.ts';
import { grokBotUsageAgentId, grokBotUsagePage } from '../src/shared/external-agents.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchGrokBotUsage, grokBotUsageEndpoint, parseGrokBotUsage } from '../src/server/cursor-usage.ts';
import { grokBotDesktopRequest } from '../src/electron/grok-bot-handoff.ts';
import {
  externalAgentCatalog,
  grokBotUrl,
  grokBotUsageUrl,
  type ExternalAgentView,
} from '../src/shared/external-agents.ts';
import { webQuotaLines } from '../src/shared/quota-summary.ts';
import { resolveParticipants, participantsNote } from '../src/server/participants.ts';
import { GrokBotControls, WebAgentQuotaRows } from '../src/ui/ExternalAgents.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const now = Date.parse('2026-10-12T08:00:00Z');
const reset = '2026-10-18T08:00:00.000Z';
const payload = { usagePercent: 27.5, nextResetTimestampUtc: reset, grokPlanLabel: 'SuperGrok' };
const session = { userId: 'synthetic', token: 'FAKE_SESSION_TOKEN' };
const reading = (extra: Partial<ExternalAgentView> = {}): ExternalAgentView => ({
  id: 'grok-bot',
  name: 'Grok Bot',
  kind: 'handoff',
  description: externalAgentCatalog['grok-bot'].description,
  enabled: false,
  available: false,
  reason: '已关闭',
  usageEnabled: true,
  quota: parseGrokBotUsage(payload),
  ...extra,
});

test('Grok Bot JSON reading preserves exact used/left, reset and plan; unknown fields never become values', () => {
  for (const timestamp of [
    reset,
    Date.parse(reset),
    String(Date.parse(reset)),
    Date.parse(reset) / 1000,
    String(Date.parse(reset) / 1000),
  ]) {
    const quota = parseGrokBotUsage({ ...payload, nextResetTimestampUtc: timestamp });
    assert.equal(quota.status, 'known');
    assert.equal(100 - quota.windows[0]!.usedPercent!, 72.5);
    assert.equal(quota.windows[0]!.resetsAt, reset);
    assert.equal(quota.subscription?.label, 'SuperGrok');
  }
  for (const invalid of [
    null,
    {},
    [],
    { data: payload },
    { ...payload, usagePercent: -1 },
    { ...payload, usagePercent: 101 },
    { ...payload, usagePercent: '27.5' },
    { ...payload, usagePercent: NaN },
  ]) {
    const quota = parseGrokBotUsage(invalid);
    assert.equal(quota.status, 'unknown');
    assert.deepEqual(quota.windows, []);
  }
  for (const usagePercent of [0, 100])
    assert.equal(parseGrokBotUsage({ ...payload, usagePercent }).windows[0]?.usedPercent, usagePercent);
});

test('Grok Bot uses the Cursor Bearer only on the fixed JSON RPC, never logs or returns it', async (t) => {
  const logs: unknown[] = [];
  for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const calls: [unknown, RequestInit | undefined][] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push([url, init]);
    return Response.json(payload);
  };
  const quota = await fetchGrokBotUsage(session, { fetch: fakeFetch, now: () => now });
  assert.equal(quota.status, 'known');
  assert.equal(calls[0]![0], grokBotUsageEndpoint);
  const request = calls[0]![1]!;
  assert.equal(request.method, 'POST');
  assert.equal(request.body, '{}');
  const headers = new Headers(request.headers);
  assert.equal(headers.get('authorization'), `Bearer ${session.token}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('connect-protocol-version'), '1');
  assert.equal(headers.has('cookie'), false);
  assert.equal(request.redirect, 'error');
  assert.equal(quota.observedAt, new Date(now).toISOString());
  const results = [quota];
  for (const status of [401, 403, 500])
    results.push(
      await fetchGrokBotUsage(session, {
        fetch: async () => new Response(session.token, { status }),
      }),
    );
  for (const response of [Response.json({}), new Response(''), new Response(session.token)])
    results.push(await fetchGrokBotUsage(session, { fetch: async () => response }));
  results.push(
    await fetchGrokBotUsage(session, {
      fetch: async () => {
        throw new Error(session.token);
      },
    }),
  );
  results.push(
    await fetchGrokBotUsage(session, {
      fetch: async () => Response.json({ ...payload, grokPlanLabel: session.token }),
    }),
  );
  results.push(
    await fetchGrokBotUsage(undefined, {
      fetch: async () => {
        assert.fail('missing login must not fetch');
      },
    }),
  );
  for (const result of results.slice(1)) {
    assert.notEqual(result.status, 'known');
    assert.deepEqual(result.windows, []);
  }
  assert.doesNotMatch(JSON.stringify(results), /FAKE_SESSION_TOKEN/);
  assert.deepEqual(logs, []);
});

test('the shared eight-second deadline bounds both fetch and JSON, even if a fake ignores cancellation', async () => {
  for (const fake of [
    async () => new Promise<Response>(() => {}),
    async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response,
  ]) {
    const quota = await fetchGrokBotUsage(session, { fetch: fake, timeoutMs: 10 });
    assert.equal(quota.status, 'error');
    assert.deepEqual(quota.windows, []);
  }
});

test('desktop hand-off copies before opening only the allowed Grok links, and sanitizes shell failures', async () => {
  const calls: string[] = [];
  const dependencies = {
    clipboard: { writeText: (text: string) => calls.push(`copy:${text}`) },
    openExternal: async (url: string) => {
      calls.push(`open:${url}`);
    },
  };
  for (const id of ['', 'bot_123-abc']) {
    calls.length = 0;
    const result = await grokBotDesktopRequest(
      { agentId: 'grok-bot', action: 'desktop-handoff', url: grokBotUrl(id), text: 'hello\nworld' },
      dependencies,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      'copy:hello\nworld',
      `open:${id ? 'grokbot://app/v1/agent?id=bot_123-abc' : 'grokbot://'}`,
    ]);
  }
  calls.length = 0;
  await grokBotDesktopRequest({ agentId: 'grok-bot', action: 'desktop-open', url: grokBotUsageUrl }, dependencies);
  assert.deepEqual(calls, [`open:${grokBotUsageUrl}`]);
  for (const url of [
    'https://x.ai/bot',
    'file:///C:/',
    'grokbot://app/v1/agent?id=abc&message=hello',
    'grokbot://app/v1/thread?id=x',
    'grokbot://app/v1/settings?id=billing',
  ]) {
    calls.length = 0;
    assert.equal(
      (
        await grokBotDesktopRequest(
          { agentId: 'grok-bot', action: 'desktop-handoff', url, text: 'hello' },
          dependencies,
        )
      ).ok,
      false,
    );
    assert.deepEqual(calls, []);
  }
  assert.throws(() => grokBotUrl('abc&message=hello'), /Bot ID/);
  const failed = await grokBotDesktopRequest(
    { agentId: 'grok-bot', action: 'desktop-open', url: grokBotUrl() },
    {
      ...dependencies,
      openExternal: async () => {
        throw new Error(session.token);
      },
    },
  );
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_SESSION_TOKEN/);
});

test('coordinators receive a delivery-only notice and do not expect a Grok reply or a web combine step', () => {
  const participants = resolveParticipants(
    [
      { kind: 'external', id: 'grok-bot' },
      { kind: 'executor', id: 'codex' },
    ],
    {
      presets: [],
      targets: [
        { id: 'codex', label: 'Codex', provider: 'codex', command: 'fixture', environment: 'native', enabled: true },
      ],
      externals: [reading({ enabled: true, available: true })],
    },
  );
  assert.equal(participants[0]?.handoff, true);
  assert.equal(participants[0]?.thirdParty, undefined);
  assert.match(participantsNote(participants), /不会收到它的回复/);
  assert.doesNotMatch(participantsNote(participants), /不带工具的执行器读它的回复/);
});

test('the unified Grok quota card and tray show usage while chat is off, and show unknown without a bar', () => {
  const agent = reading();
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now, compact }));
    assert.match(html, /SuperGrok/);
    assert.match(html, compact ? /73%<\/strong>/ : /剩余 73%<\/strong>/);
    assert.match(html, /6 天后重置/);
    assert.doesNotMatch(
      html,
      /Bot ID|机器人标识|打开 Grok Bot|打开用量设置|用量来源|读取 Grok Bot 用量|grok-bot-controls/,
    );
    assert.doesNotMatch(html, /重新识别|用量签名|已关闭/);
    const unknown = renderToStaticMarkup(
      createElement(WebAgentQuotaRows, { agents: [reading({ quota: parseGrokBotUsage({}) })], now, compact }),
    );
    assert.match(unknown, /没读到用量/);
    assert.equal((unknown.match(/>没读到用量</g) ?? []).length, 1);
    assert.match(unknown, /登录用量账号/);
    assert.doesNotMatch(unknown, /请登录|格式无法识别/);
    assert.doesNotMatch(unknown, /role="progressbar"/);
  }
  assert.equal(webQuotaLines([agent], now)[0]?.tightest, 73);
  assert.deepEqual(webQuotaLines([reading({ usageEnabled: false })], now), []);
});

test('Grok card controls save Bot ID and an independent usage switch, and open each action through the API', async () => {
  const h = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'));
  const patches: unknown[] = [],
    opened: boolean[] = [];
  const props = {
    agent: reading(),
    onPatch: (body: unknown) => patches.push(body),
    onOpen: (settings: boolean) => opened.push(settings),
    onLogin: () => opened.push(true),
  };
  const tree = h.render('GrokBotControls', props);
  findNode(tree, (node) => node.props['aria-label'] === 'Grok Bot 标识')!.props.onBlur({
    currentTarget: { value: 'bot-1' },
  });
  findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({
    target: { checked: false },
  });
  const text = (node: unknown): string =>
    Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object'
        ? text((node as UiNode).props?.children)
        : typeof node === 'string'
          ? node
          : '';
  findNode(tree, (node) => node.type === 'button' && text(node) === '打开 Grok Bot')!.props.onClick();
  findNode(tree, (node) => node.type === 'button' && text(node) === '打开用量设置')!.props.onClick();
  const source = findNode(tree, (node) => node.type === 'select')!;
  assert.equal(source.props.value, 'separate');
  source.props.onChange({ target: { value: 'cursor-editor' } });
  findNode(tree, (node) => node.type === 'button' && text(node) === '登录用量账号')!.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [
    { botId: 'bot-1' },
    { usageEnabled: false },
    { usageSource: 'cursor-editor' },
  ]);
  assert.deepEqual(opened, [false, true, true]);
  h.unmount();
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    return { agents: [reading()], message: 'opened' };
  };
  const page = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'));
  page.render('WebAgentQuotas', { api, now });
  await nextTurn();
  const rows = findNode(
    page.render('WebAgentQuotas', { api, now }),
    (node) => node.type?.name === 'WebAgentQuotaRows',
  )!;
  assert.equal(rows.props.onOpen, undefined);
  assert.equal(rows.props.onPatch, undefined);
  await rows.props.onLogin(reading());
  await nextTurn();
  assert.ok(calls.includes('/api/external-agents/grok-bot/login'));
  page.unmount();
});

test('real Grok Bot shape has a percentage without a reset; fallback plan, brand and period remain explicit', () => {
  const real = {
    usagePercent: 0,
    currentPeriodStart: '2026-10-08T00:00:00Z',
    hasAvailableUsage: true,
    hasNonZeroIncludedLimit: true,
    grokPlanLabel: 'Grok Bot Plan',
    cursorPlanName: 'Pro',
    billingBrand: 'SAND_BILLING_BRAND_CURSOR',
    upgradeRecommendations: [],
    onDemandSettings: { visible: true, eligible: true },
  };
  const quota = parseGrokBotUsage(real);
  assert.equal(quota.status, 'known');
  assert.equal(quota.windows[0]?.usedPercent, 0);
  assert.equal(quota.windows[0]?.resetsAt, null);
  assert.equal(quota.windows[0]?.resetNotReported, true);
  assert.equal(quota.subscription?.label, 'Grok Bot Plan · Cursor');
  assert.equal(quota.billingBrand, real.billingBrand);
  assert.equal(quota.currentPeriodStart, '2026-10-08T00:00:00.000Z');
  assert.equal(parseGrokBotUsage({ ...real, grokPlanLabel: '' }).subscription?.label, 'Pro · Cursor');
  assert.equal(parseGrokBotUsage({ ...real, usagePercent: undefined }).status, 'unknown');
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [reading({ quota })], now, compact }));
    assert.match(html, /100%/);
    assert.match(html, /Grok Bot Plan · Cursor/);
    if (!compact) {
      assert.match(html, /读到的是 Cursor 账号自带的 Grok Bot 计划/);
      assert.match(html.split('<details')[1]!, /10\/8/);
    } else assert.doesNotMatch(html, /SAND_BILLING_BRAND_CURSOR|10\/8/);
    assert.doesNotMatch(html, /后重置|重置时间未知|等待新读数/);
  }
  assert.equal(webQuotaLines([reading({ quota })], now)[0]?.detail, undefined);
});

test('observed Grok readings project safe fields and never replay cross-origin or arbitrary POST requests', () => {
  const url = grokBotUsagePage;
  assert.equal(grokObservedRequest('POST', grokBotUsageEndpoint, url), false);
  assert.equal(grokObservedRequest('POST', 'https://cursor.com/api/change-plan', url), false);
  assert.equal(
    grokObservedRequest('POST', 'https://cursor.com/aiserver.v1.DashboardService/GetSandUsageStatus', url),
    true,
  );
  assert.equal(grokObservedRequest('GET', 'https://cursor.com/api/usage?token=SECRET', url), false);
  const result = grokObservedUsage(
    { ...payload, privateToken: session.token, email: 'secret@example.test' },
    url,
    200,
  )!;
  assert.equal(result.quota?.windows[0]?.usedPercent, 27.5);
  assert.equal(result.grokDiagnostic?.code, 'success');
  const echoed = grokObservedUsage(
    { ...payload, grokPlanLabel: session.token, currentPeriodStart: session.token },
    url,
    200,
  );
  assert.doesNotMatch(JSON.stringify([result, echoed]), /FAKE_SESSION_TOKEN|secret@example/);
  assert.equal(grokObservedUsage({}, url, 200), undefined);
  assert.equal(
    grokObservedUsage(
      { usagePercent: null, grokPlanLabel: '', hasNonZeroIncludedLimit: false, hasAvailableUsage: false },
      url,
      200,
    )?.grokDiagnostic?.code,
    'no-plan',
  );
  assert.equal(grokObservedUsage({ usagePercent: null, grokPlanLabel: '' }, url, 200)?.grokDiagnostic?.code, 'no-data');
});

test('every Grok diagnostic is bounded and strips secrets from path, status and extra fields', () => {
  for (const code of Object.keys(grokDiagnosticMessages) as (keyof typeof grokDiagnosticMessages)[]) {
    const result = cleanGrokDiagnostic({
      ...grokDiagnostic(code, 'request', 'https://cursor.com/dashboard/spending?token=SECRET#email', 401),
      body: 'SECRET',
      cookie: 'SECRET',
    })!;
    assert.equal(result.code, code);
    assert.equal(result.path, '/dashboard/spending');
    assert.equal(result.status, 401);
    assert.match(grokDiagnosticLine(result), /401/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|cookie|body|email/);
  }
  assert.equal(grokDiagnostic('error', 'parse', '/dashboard/secret@example.test').path, '/dashboard/…');
  assert.equal(grokDiagnostic('error', 'parse', '/SECRET', NaN).status, undefined);
  assert.equal(cleanGrokDiagnostic({ code: 'SECRET', step: 'parse' }), undefined);
});

test('login auto-read uses the active RPC first, its success wins, and passive spending fallback runs only on failure', async () => {
  const windows: FakeWindow[] = [];
  const timers: (() => Promise<void>)[] = [];
  const attempts: string[] = [];
  const pageEvents: string[] = [];
  let active: unknown = { outcome: 'success', status: 200, payload };
  let check = 'login',
    reads = 0,
    dom = '',
    visible = false;
  class FakeWindow extends EventEmitter {
    url = '';
    destroyed = false;
    constructor(readonly options: any) {
      super();
      windows.push(this);
    }
    webContents = Object.assign(new EventEmitter(), {
      session: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
        get cookies() {
          throw new Error('must not read cookies');
        },
      },
      setWindowOpenHandler: (handler: any) => {
        this.popup = handler;
      },
      getURL: () => this.url,
      isLoading: () => false,
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        const code = scripts[0]!.code;
        if (code.endsWith('__pugportBridge.find({})')) {
          pageEvents.push('check');
          return { check, loginHint: check === 'login', input: false };
        }
        if (code.includes(grokBotUsageEndpoint)) {
          attempts.push('active');
          return active;
        }
        attempts.push('fallback');
        reads++;
        return { text: dom, notices: [], url: this.url };
      },
    });
    popup: any;
    async loadURL(url: string) {
      pageEvents.push('load');
      this.url = url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return visible;
    }
    setTitle() {}
    hide() {
      visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const loaded = await electronModule(
    'src/electron/web-bridge.ts',
    { BrowserWindow: FakeWindow },
    {
      setInterval: (callback: () => Promise<void>) => {
        timers.push(callback);
        return { unref() {} };
      },
      clearInterval() {},
    },
    {},
  );
  const bridge = new loaded.WebBridge({
    port: 1234,
    present: () => {},
    windowOptions: { webPreferences: { partition: 'must-not-override' } },
  });
  try {
    const target = { agentId: grokBotUsageAgentId, name: 'Grok Bot', url: grokBotUsagePage };
    assert.equal((await bridge.handle({ ...target, action: 'open' })).ok, true);
    const window = windows[0]!;
    assert.equal(window.options.webPreferences.partition, 'persist:pugport-grokbot-usage');
    assert.equal(window.options.webPreferences.partition, webAgentPartition(grokBotUsageAgentId));
    assert.notEqual(window.options.webPreferences.partition, webAgentPartition('cursor'));
    assert.notEqual(window.options.webPreferences.partition, webAgentPartition('muse'));
    assert.equal(
      window.popup({ url: 'https://accounts.example.test/login' }).overrideBrowserWindowOptions.webPreferences
        .partition,
      window.options.webPreferences.partition,
    );
    for (check of ['login', 'human-check']) {
      const result = await bridge.handle({ ...target, action: 'usage', automatic: true });
      assert.equal(result.code, check);
      assert.equal(result.grokDiagnostic.step, check);
      assert.equal(reads, 0);
      assert.equal(attempts.length, 0, 'a human check or login must stop the active API too');
    }
    assert.equal(window.options.title, '登录 Cursor 账号 · 用于读取 Grok Bot 用量');
    check = '';
    dom = 'Grok Bot Plan Used 99%';
    visible = true;
    window.url = 'https://cursor.com/dashboard';
    window.webContents.emit('did-finish-load');
    await new Promise((resolve) => setTimeout(resolve, 900));
    const read = await bridge.handle({ ...target, action: 'monitor', enabled: true });
    assert.equal(read.quota.windows[0].usedPercent, 27.5);
    assert.deepEqual(attempts, ['active'], 'a successful primary RPC never consumes fallback DOM');
    assert.equal(visible, false, 'successful post-login reading closes the visible window');
    assert.equal(window.url, grokBotUsagePage);
    assert.equal(read.quota.subscription.label, 'SuperGrok');
    assert.match(read.quota.source, /独立登录/);
    pageEvents.length = 0;
    attempts.length = 0;
    check = 'human-check';
    const blocked = await bridge.handle({ ...target, action: 'usage', automatic: true });
    assert.equal(blocked.code, 'human-check');
    assert.deepEqual(pageEvents, ['load', 'check'], 'reload once before checking a stale automatic page');
    assert.deepEqual(attempts, [], 'never call the usage API or fallback while blocked');
    check = '';
    await bridge.handle({ ...target, action: 'usage' });
    await timers[0]!();
    const afterPassive = await bridge.handle({ ...target, action: 'monitor', enabled: true });
    assert.equal(
      afterPassive.quota.windows[0].usedPercent,
      27.5,
      'late passive capture cannot replace primary success',
    );
    attempts.length = 0;
    active = { outcome: 'unreachable' };
    dom = 'SuperGrok Used 9%';
    visible = false;
    const fallback = await bridge.handle({ ...target, action: 'usage' });
    assert.deepEqual(attempts, ['active', 'fallback']);
    assert.equal(fallback.quota.windows[0].usedPercent, 9);
    assert.equal(fallback.quota.windows[0].resetsAt, null);
    assert.equal(fallback.quota.subscription.label, 'SuperGrok');
    assert.equal(fallback.grokDiagnostic.code, 'success');
    dom = 'FAKE_SESSION_TOKEN 9% Resets in 4 days';
    const echo = await bridge.handle({ ...target, action: 'usage' });
    assert.equal(echo.ok, false);
    assert.equal(echo.grokDiagnostic.code, 'unreachable');
    assert.doesNotMatch(JSON.stringify(echo), /FAKE_SESSION_TOKEN/);
    for (const status of [401, 403]) {
      active = { outcome: 'refused', status };
      const rejected = await bridge.handle({ ...target, action: 'usage' });
      assert.equal(rejected.grokDiagnostic.code, 'refused');
      assert.equal(rejected.grokDiagnostic.status, status, 'failed fallback preserves the active HTTP diagnostic');
    }
    assert.equal((await bridge.handle({ ...target, action: 'send', text: 'no' })).ok, false);
    assert.equal((await bridge.handle({ ...target, action: 'usage', url: 'https://other.test' })).ok, false);
    check = 'login';
    await bridge.handle({ ...target, action: 'open' });
    window.destroy();
    await bridge.handle({ ...target, action: 'usage', automatic: true });
    pageEvents.length = 0;
    const afterClose = await bridge.handle({ ...target, action: 'usage', automatic: true });
    assert.equal(afterClose.code, 'login');
    assert.deepEqual(pageEvents, ['load', 'check'], 'closing an unfinished login restores automatic pre-check reload');
  } finally {
    bridge.dispose();
  }
});

test('CDP observes same-origin read-only responses and reports status without storing secrets or replaying POSTs', async () => {
  let body: unknown = payload,
    reads = 0;
  const results: unknown[] = [];
  let pendingBody: Promise<{ body: string }> | undefined;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => false,
    attach() {},
    detach() {},
    async sendCommand(method: string) {
      if (method === 'Network.getResponseBody') {
        reads++;
        if (pendingBody) return pendingBody;
        return { body: JSON.stringify(body) };
      }
      return {};
    },
  });
  const window = {
    isVisible: () => false,
    isDestroyed: () => false,
    webContents: { getURL: () => grokBotUsagePage, debugger: debuggerApi },
  } as unknown as BrowserWindow;
  const monitor = new WebUsageMonitor({
    window,
    grok: true,
    autoTick: false,
    blocked: async () => false,
    snapshot: async () => ({ text: '', notices: [], url: grokBotUsagePage }),
    page: async () => {
      throw new Error('must not replay POST');
    },
    onGrokResult: (result) => results.push(result),
  });
  const response = async (
    status: number,
    method = 'POST',
    url = 'https://cursor.com/aiserver.v1.DashboardService/GetSandUsageStatus',
  ) => {
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'test',
      request: { method, url, headers: { authorization: 'SECRET' }, postData: 'SECRET' },
    });
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'test',
      response: { url, status, mimeType: 'application/json' },
    });
    debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: 'test', encodedDataLength: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    return monitor.result();
  };
  try {
    body = { ...payload, grokPlanLabel: 'Grok Bot Plan', token: 'SECRET' };
    assert.equal((await response(200)).quota?.subscription?.label, 'Grok Bot Plan');
    for (const status of [401, 403, 429, 500]) {
      const result = await response(status);
      assert.equal(result.grokDiagnostic?.code, 'refused');
      assert.equal(result.grokDiagnostic?.status, status);
      assert.equal(result.quota, undefined);
    }
    body = {};
    assert.equal((await response(200)).grokDiagnostic?.code, 'no-data');
    body = { usagePercent: 0, grokPlanLabel: '', hasAvailableUsage: false, hasNonZeroIncludedLimit: false };
    assert.equal((await response(200)).grokDiagnostic?.code, 'no-plan');
    const before = reads;
    await response(200, 'POST', 'https://cursor.com/api/billing/change');
    await response(200, 'POST', grokBotUsageEndpoint);
    assert.equal(reads, before);
    let rejectOld!: (error: Error) => void;
    pendingBody = new Promise((_resolve, reject) => {
      rejectOld = reject;
    });
    await response(200);
    monitor.beginGrokRead();
    pendingBody = undefined;
    body = payload;
    await response(200);
    rejectOld(new Error('SECRET'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      monitor.result().grokDiagnostic?.code,
      'success',
      'an old failed body read cannot replace the new reading',
    );
    assert.doesNotMatch(JSON.stringify(results), /SECRET|authorization|postData|token/);
  } finally {
    monitor.close();
  }
});

test('late hidden DOM usage is published once and does not continually reset the refresh cadence', async () => {
  let text = '',
    readings = 0;
  const window = {
    isVisible: () => false,
    isDestroyed: () => false,
    webContents: { getURL: () => grokBotUsagePage },
  } as unknown as BrowserWindow;
  const monitor = new WebUsageMonitor({
    window,
    grok: true,
    autoTick: false,
    blocked: async () => false,
    snapshot: async () => ({ text, notices: [], url: grokBotUsagePage }),
    page: async () => {
      throw new Error('unexpected replay');
    },
    onGrokResult: (result) => {
      readings++;
      assert.equal(result.grokDiagnostic?.status, undefined);
    },
  });
  try {
    await monitor.capture(true);
    text = 'SuperGrok Used 7%';
    await monitor.capture(true);
    await monitor.capture(true);
    assert.equal(readings, 1);
  } finally {
    monitor.close();
  }
});

test('unknown usage still shows one diagnostic line and a mismatched plan explains the account difference', () => {
  const diagnostic = grokDiagnostic('refused', 'request', grokBotUsagePage, 401);
  const unknown = renderToStaticMarkup(
    createElement(WebAgentQuotaRows, { agents: [reading({ quota: undefined, grokDiagnostic: diagnostic })], now }),
  );
  assert.match(unknown, /用量接口拒绝 \(401\)/);
  assert.match(unknown, /读取详情/);
  assert.match(unknown, /看不到聊天记录/);
  const html = renderToStaticMarkup(
    createElement(WebAgentQuotaRows, {
      agents: [reading({ quota: parseGrokBotUsage({ ...payload, grokPlanLabel: 'Grok Bot Plan' }) })],
      now,
    }),
  );
  assert.ok(html.includes(grokPlanMismatch));
  const superGrok = renderToStaticMarkup(
    createElement(WebAgentQuotaRows, { agents: [reading({ quota: parseGrokBotUsage(payload) })], now }),
  );
  assert.ok(!superGrok.includes(grokPlanMismatch));
});

test('the Grok usage account shows in settings and on the card; only an identified account not yet confirmed can be confirmed', async () => {
  const states: Record<string, GrokUsageAccount> = {
    'no identity': { status: 'unverified' },
    unconfirmed: { status: 'unverified', fingerprint: 'a'.repeat(64) },
    matches: { status: 'matches', fingerprint: 'a'.repeat(64) },
    different: { status: 'different', fingerprint: 'b'.repeat(64) },
  };
  const button = /<button([^>]*)>这是我在 Grok Bot 里用的账号<\/button>/;
  for (const [name, usageAccount] of Object.entries(states)) {
    const line = grokUsageAccountLine(usageAccount);
    const agent = reading({ usageAccount });
    const confirmable = name === 'unconfirmed' || name === 'different';
    for (const html of [
      renderToStaticMarkup(createElement(GrokBotControls, { agent, onPatch() {} })),
      renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now, onConfirmAccount() {} })),
    ]) {
      assert.ok(html.includes(line), name);
      assert.equal(html.match(button)?.[1].includes('disabled'), confirmable ? false : undefined, name);
    }
    for (const compact of [false, true]) {
      const card = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now, compact }));
      // Another account's usage is an error in both layouts; the other states and the button are on the full card.
      assert.equal(card.includes(line), name === 'different' || !compact, `${name}, compact: ${compact}`);
      if (name === 'different' && !compact) assert.ok(card.includes(`usage-error">${line}`));
      if (compact) assert.doesNotMatch(card, button);
    }
  }
  const note = (node: UiNode) => node.type?.name === 'GrokUsageAccountNote';
  const h = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'));
  const patches: unknown[] = [];
  findNode(
    h.render('GrokBotControls', {
      agent: reading({ usageAccount: states.different }),
      onPatch: (body: unknown) => patches.push(body),
    }),
    note,
  )!.props.onConfirm();
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ usageAccountConfirmed: 'b'.repeat(64) }]);
  const confirmed: unknown[] = [];
  findNode(
    h.render('WebAgentQuotaRows', {
      agents: [reading({ usageAccount: states.unconfirmed })],
      now,
      onConfirmAccount: (item: ExternalAgentView) => confirmed.push(item.usageAccount?.fingerprint),
    }),
    note,
  )!.props.onConfirm();
  assert.deepEqual(confirmed, ['a'.repeat(64)]);
  h.unmount();
  const plain = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [reading()], now }));
  assert.ok(
    Object.values(states).every((state) => !plain.includes(grokUsageAccountLine(state))),
    'no reading, no account line',
  );

  const unconfirmed = reading({ usageAccount: states.unconfirmed });
  const calls: unknown[] = [];
  const api = async (path: string, body?: unknown, method?: string) => {
    calls.push([path, body, method]);
    return { agents: [method === 'PATCH' ? reading({ usageAccount: states.matches }) : unconfirmed] };
  };
  const page = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'));
  page.render('WebAgentQuotas', { api, now });
  await nextTurn();
  const rows = findNode(
    page.render('WebAgentQuotas', { api, now }),
    (node) => node.type?.name === 'WebAgentQuotaRows',
  )!;
  await rows.props.onConfirmAccount(unconfirmed);
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), [
    '/api/external-agents/grok-bot',
    { usageAccountConfirmed: 'a'.repeat(64) },
    'PATCH',
  ]);
  const after = findNode(
    page.render('WebAgentQuotas', { api, now }),
    (node) => node.type?.name === 'WebAgentQuotaRows',
  )!;
  assert.equal(after.props.agents[0].usageAccount.status, 'matches', 'the card shows the confirmed reading');
  page.unmount();
});

test('empty Grok cards explain login and human checks outside the details in both layouts', () => {
  for (const compact of [false, true])
    for (const code of ['login', 'human-check'] as const) {
      const html = renderToStaticMarkup(
        createElement(WebAgentQuotaRows, {
          agents: [reading({ quota: undefined, grokDiagnostic: grokDiagnostic(code, code, grokBotUsagePage) })],
          now,
          compact,
          onLogin() {},
        }),
      ).replace(/<details[\s\S]*?<\/details>/g, '');
      assert.ok(html.includes(grokDiagnosticMessages[code]));
      assert.match(html, /点击「登录用量账号」打开用量窗口/);
      assert.match(html, /<button[^>]*>登录用量账号<\/button>/);
      assert.doesNotMatch(html, /没读到用量/);
    }
});
