import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { BrowserWindow } from 'electron';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseWebUsage, parseWebReset } from '../src/server/external-agents/config.ts';
import {
  learnUsageSignature,
  usageMetrics,
  readLearnedUsage,
  parseTokenAmount,
  safeUsageRequest,
  partialUsageSamples,
  redactedUsageSample,
  safeWebUsageRoute,
} from '../src/server/external-agents/usage.ts';
import { WebUsageMonitor, webUsageRefreshMs } from '../src/server/external-agents/web-usage-monitor.ts';
import { webQuotaLines } from '../src/shared/quota-summary.ts';
import type { ExternalAgentView } from '../src/shared/external-agents.ts';
import { WebAgentQuotaRows } from '../src/ui/ExternalAgents.tsx';
import { trayPopupHtml } from '../src/electron/tray-popup.ts';

const now = new Date(2026, 9, 11, 8).getTime();
const grok = 'SuperGrok 9% 4 天后重置 更改限额';
const muse = '免费版 已使用 87% 每周限额将在 10月14日重置 额外的使用额度 已使用 0%（剩余 259 亿个词元） 从不过期';
const origin = 'https://fixture.test';
const reset = new Date(now + 4 * 86_400_000).toISOString();

test('exact Grok menu formats in Chinese and English preserve the plan, used percentage and relative reset', () => {
  for (const text of [grok, 'SuperGrok 9% Resets in 4 days Change limit']) {
    const quota = parseWebUsage(text, now);
    assert.equal(quota.windows[0]!.label, 'SuperGrok');
    assert.equal(100 - quota.windows[0]!.usedPercent!, 91);
    assert.equal(quota.windows[0]!.resetsAt, reset);
  }
});

test('exact Muse weekly and deposit formats, English equivalents and local next-occurrence dates', () => {
  const english =
    'Free plan Used 87% Weekly limit resets on October 14 Extra usage allowance Used 0% (25.9B tokens remaining) Never expires';
  for (const text of [
    muse,
    english,
    '免费版\n每周限额将在 10月14日重置\n已使用 87%\n额外的使用额度\n已使用 0%（剩余 259 亿个词元）\n从不过期',
    'Free plan\nWeekly limit resets on October 14\n87% used\nExtra usage allowance\nUsed 0% (25.9B tokens remaining)\nNever expires',
    '每周限额将在 10月14日重置\n免费版\n已使用 87%\n额外的使用额度\n已使用 0%（剩余 259 亿个词元）\n从不过期',
  ]) {
    const quota = parseWebUsage(text, now);
    assert.equal(quota.windows[0]!.label, text.includes('免费版') ? '免费版' : 'Free plan');
    assert.equal(quota.windows[0]!.durationMinutes, 10080);
    assert.equal(100 - quota.windows[0]!.usedPercent!, 13);
    assert.equal(quota.windows[0]!.resetsAt, new Date(2026, 9, 14).toISOString());
    assert.equal(quota.balances![0]!.remainingTokens, 25.9e9);
    assert.equal(quota.balances![0]!.usedPercent, 0);
    assert.equal('resetsAt' in quota.balances![0]!, false);
  }
  assert.equal(
    parseWebUsage(muse, new Date(2026, 9, 15).getTime()).windows[0]!.resetsAt,
    new Date(2027, 9, 14).toISOString(),
  );
  for (const plan of ['Power', 'Max'])
    assert.equal(parseWebUsage(muse.replace('免费版', plan), now).windows[0]!.label, plan);
  assert.equal(parseWebUsage('已使用 87% 每周限额将在 10月14日重置', now).windows[0]!.usedPercent, 87);
  assert.equal(parseWebUsage('已使用 0%（剩余 259 亿个词元） 从不过期', now).balances![0]!.remainingTokens, 25.9e9);
});

test('token magnitude parsing supports Chinese 万/亿 and English K/M/B without inventing unknown balances', () => {
  for (const [text, expected] of [
    ['259 亿个词元', 25.9e9],
    ['2.5 万个词元', 25000],
    ['2.5K tokens', 2500],
    ['25.9M tokens', 25.9e6],
    ['25.9B tokens', 25.9e9],
    ['25.9 billion tokens', 25.9e9],
  ] as const)
    assert.equal(parseTokenAmount(text), expected);
  assert.equal(parseTokenAmount('Unlimited tokens'), undefined);
});

test('partial usage diagnostics reconstruct only labels, numbers and dates from the usage block', () => {
  const block =
    'PRIVATE_NAME private@example.test CSRF_secret 免费版 每周限额将在 10月14日重置 Chat: confidential 12345';
  assert.deepEqual(partialUsageSamples([block], now, parseWebReset), ['免费版 · 每周限额 · 10月14日']);
  assert.equal(redactedUsageSample('private@example.test CSRF_secret confidential 12345'), '');
  assert.deepEqual(partialUsageSamples([muse], now, parseWebReset), []);
  assert.deepEqual(
    partialUsageSamples(['额外的使用额度 已使用 0%（剩余 7 兆个词元） 从不过期 PRIVATE_BODY'], now, parseWebReset),
    ['额外的使用额度 · 已使用 0% · 从不过期'],
  );
});

test('Muse weekly and extra rows render in usage and tray, with a deposit balance and dimmed past readings', () => {
  const agent: ExternalAgentView = {
    id: 'muse',
    name: 'Muse',
    kind: 'web',
    description: '',
    enabled: true,
    available: true,
    quota: parseWebUsage(muse, now),
  };
  const html = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now }));
  for (const pattern of [/免费版/, /剩余 13%<\/strong>/, /259 亿词元/, /从不过期/, /打开设置时刷新用量/])
    assert.match(html, pattern);
  assert.equal((html.match(/progressbar/g) ?? []).length, 1, 'deposit tokens are a secondary balance line');
  const tray = trayPopupHtml({ running: 0, lines: webQuotaLines([agent], now), totals: [] }, now);
  assert.match(tray, /免费版.*13%/);
  assert.match(tray, /额外的使用额度.*259 亿个词元.*从不过期/);
  const later = new Date(2026, 9, 15).getTime();
  const stale = renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now: later }));
  assert.match(stale, /上次读数/);
  assert.match(stale, /opacity:0.55/);
  assert.match(
    trayPopupHtml({ running: 0, lines: webQuotaLines([agent], later), totals: [] }, later),
    /reference.*上次读数/s,
  );
  assert.equal(webQuotaLines([agent], later)[0]!.windows[0]!.remaining, 13);
});

test('learning chooses matching same-origin quota fields, handles fractional percentages and rejects decoys', () => {
  const quota = parseWebUsage(grok, now);
  const response = (path: string, json: unknown, responseOrigin = origin) => ({
    method: 'GET',
    origin: responseOrigin,
    path,
    metrics: usageMetrics(json),
  });
  const right = response('/rest/usage', {
    weekly: { used_fraction: 0.09, reset_at: reset },
    token: 'PRIVATE_MARK',
    cookies: 'PRIVATE_COOKIE',
  });
  const decoy = response('/rest/other', {
    unrelated: { used_percent: 9, reset_at: new Date(now + 40 * 86_400_000).toISOString() },
  });
  const signature = learnUsageSignature(
    [
      decoy,
      right,
      response('/rest/usage', { weekly: { used_fraction: 0.09, reset_at: reset } }, 'https://foreign.test'),
    ],
    quota,
    origin,
  )!;
  assert.equal(signature.path, '/rest/usage');
  assert.deepEqual(signature.windows[0]!.percent, { path: ['weekly', 'used_fraction'], scale: 100 });
  assert.deepEqual(signature.windows[0]!.reset!.path, ['weekly', 'reset_at']);
  assert.doesNotMatch(JSON.stringify(right), /PRIVATE_MARK|PRIVATE_COOKIE/);
  assert.equal(
    readLearnedUsage({ weekly: { used_fraction: 0.12, reset_at: reset } }, signature, now)!.windows[0]!.usedPercent,
    12,
  );
  assert.equal(readLearnedUsage({ weekly: { changed: 0.12, reset_at: reset } }, signature, now), undefined);
  assert.equal(
    learnUsageSignature([right, { ...right, path: '/rest/decoy' }], quota, origin),
    undefined,
    'ambiguous duplicate matches must not be guessed',
  );
});

test('Muse learning can map both rows, and unsafe or cross-origin request signatures cannot be replayed', () => {
  const quota = parseWebUsage(muse, now);
  const signature = learnUsageSignature(
    [
      {
        method: 'GET',
        origin,
        path: '/api/usage',
        metrics: usageMetrics({
          weekly: { used_percent: 87, reset_at: quota.windows[0]!.resetsAt },
          extra: { used_percent: 0, remaining_tokens: 25.9e9 },
        }),
      },
    ],
    quota,
    origin,
  )!;
  assert.equal(signature.windows.length, 1);
  assert.equal(signature.balances.length, 1);
  assert.deepEqual(signature.balances[0]!.remaining.path, ['extra', 'remaining_tokens']);
  for (const value of [
    { ...signature, origin: 'https://foreign.test' },
    { ...signature, path: '//foreign.test/usage' },
    { ...signature, path: '/usage?token=secret' },
    { ...signature, path: '/logout' },
    { ...signature, method: 'POST' },
  ])
    assert.equal(safeUsageRequest(value, origin), false);
});

function fixture(
  options: {
    debuggerFail?: boolean;
    apiBody?: () => unknown;
    snapshot?: () => Promise<{ text: string; notices: string[]; url: string }>;
  } = {},
) {
  let clock = now,
    visible = true,
    blocked = false,
    text = grok,
    url = `${origin}/chat`,
    fail = false,
    shape = false;
  const reloads: string[] = [];
  let attached = false,
    detached = 0,
    captures = 0;
  const calls: { url: string; options: any }[] = [];
  const bodies = new Map<string, unknown>();
  const bodyReads: string[] = [];
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
      detached++;
    },
    sendCommand: async (method: string, params: any) => {
      if (method === 'Network.enable' && options.debuggerFail) throw new Error('fixture unavailable');
      if (method === 'Network.getResponseBody') {
        bodyReads.push(params.requestId);
        return { body: JSON.stringify(bodies.get(params.requestId)), base64Encoded: false };
      }
      return {};
    },
  });
  const window = {
    isVisible: () => visible,
    isDestroyed: () => false,
    webContents: { getURL: () => url, debugger: debuggerApi },
  } as unknown as BrowserWindow;
  const monitor = new WebUsageMonitor({
    window,
    autoTick: false,
    now: () => clock,
    blocked: async () => blocked,
    snapshot: async () => {
      captures++;
      if (options.snapshot) return options.snapshot();
      return { text, notices: [], url };
    },
    page: async <T>(code: string) =>
      (await runInNewContext(code, {
        location: { origin: new URL(url).origin },
        AbortSignal,
        fetch: async (request: string, fetchOptions: unknown) => {
          calls.push({ url: request, options: fetchOptions });
          if (fail) throw new Error('fixture failure');
          return {
            ok: true,
            text: async () =>
              JSON.stringify(
                shape
                  ? { changed: 9 }
                  : ((await options.apiBody?.()) ?? { weekly: { used_percent: 10, reset_at: reset } }),
              ),
          };
        },
      })) as T,
    reloadUsage: async (route) => {
      if (fail) throw new Error('fixture failure');
      reloads.push(route);
      url = route;
    },
  });
  const response = async (
    id: string,
    body: unknown,
    responseUrl = `${origin}/rest/usage?nonce=123`,
    method = 'GET',
  ) => {
    clock += 3000;
    bodies.set(id, body);
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: id,
      request: { url: responseUrl, method, headers: { Cookie: 'PRIVATE_COOKIE' } },
    });
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: id,
      response: { url: responseUrl, mimeType: 'application/json', status: 200 },
    });
    debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: id, encodedDataLength: 100 });
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    monitor,
    calls,
    reloads,
    bodyReads,
    response,
    now: () => clock,
    tick: (ms: number) => {
      clock += ms;
    },
    visible: (value: boolean) => {
      visible = value;
    },
    blocked: (value: boolean) => {
      blocked = value;
    },
    text: (value: string) => {
      text = value;
    },
    url: (value: string) => {
      url = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    shape: () => {
      shape = true;
    },
    detached: () => detached,
    captures: () => captures,
  };
}

test('web configuration changes clear cached readings and old pages cannot repopulate them', async () => {
  const f = fixture();
  f.monitor.configure(true, [], `${origin}/usage`, `${origin}/chat`);
  await f.monitor.capture(true);
  assert.ok(f.monitor.result().quota);
  f.monitor.configure(true, [], `${origin}/new-usage`, `${origin}/chat`);
  assert.equal(f.monitor.result().quota, undefined);
  assert.equal(f.monitor.result().usageUrl, `${origin}/new-usage`);
  f.url(`${origin}/usage`);
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().quota, undefined, 'the old usage page is not the newly selected route');
  assert.equal(f.monitor.result().usageUrl, `${origin}/new-usage`);
  f.monitor.configure(true, [], '', 'https://new-site.test/chat');
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().quota, undefined, 'the old open window belongs to another site');
  assert.equal(f.monitor.result().usageUrl, undefined);
  assert.deepEqual(f.monitor.result().signatures ?? [], []);
  f.url('https://new-site.test/chat');
  await f.monitor.capture(true);
  assert.ok(f.monitor.result().quota, 'the new site can supply its own reading');
  f.monitor.close();
});

test('clearing a newly learned route before it was echoed back invalidates desktop cache', async () => {
  const f = fixture();
  f.monitor.configure(true, [], '', `${origin}/chat`, 'initial-settings');
  f.text('Chat');
  await f.monitor.capture(true);
  f.url(`${origin}/usage`);
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().usageUrl, `${origin}/usage`);
  assert.ok(f.monitor.result().quota);
  f.monitor.configure(true, [], '', `${origin}/chat`, 'cleared-settings');
  assert.equal(f.monitor.result().usageUrl, undefined);
  assert.equal(f.monitor.result().quota, undefined);
  assert.deepEqual(f.monitor.result().signatures ?? [], []);
  f.monitor.close();
});

test('manual reading immediately after clearing an explicit route can learn the current usage page', async () => {
  const f = fixture();
  f.monitor.configure(true, [], `${origin}/old-usage`, `${origin}/chat`, 'explicit-route');
  f.monitor.configure(true, undefined, undefined, `${origin}/chat`, 'cleared-route');
  f.url(`${origin}/new-usage`);
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().usageUrl, `${origin}/new-usage`);
  assert.equal(f.monitor.result().quota?.windows[0]?.usedPercent, 87);
  f.monitor.close();
});

for (const source of ['DOM', 'API'] as const) {
  test(`web ${source} result started before a configuration change cannot restore cached quota`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const f = fixture({
      ...(source === 'DOM'
        ? {
            snapshot: async () => {
              entered();
              await blocked;
              return { text: grok, notices: [], url: `${origin}/chat` };
            },
          }
        : {
            apiBody: async () => {
              entered();
              await blocked;
              return { weekly: { used_percent: 91, reset_at: reset } };
            },
          }),
    });
    f.monitor.configure(true, [], `${origin}/usage`, `${origin}/chat`);
    if (source === 'API') await f.response('right', { weekly: { used_percent: 9, reset_at: reset } });
    const reading = source === 'DOM' ? f.monitor.capture(true) : f.monitor.refresh(true);
    await ready;
    f.monitor.configure(true, [], `${origin}/new-usage`, `${origin}/chat`);
    release();
    await reading;
    assert.equal(f.monitor.result().quota, undefined);
    assert.equal(f.monitor.result().usageUrl, `${origin}/new-usage`);
    f.monitor.close();
  });
}

test('fresh DOM capture stays fresh when hidden or when settings close; partial blocks retain safe diagnostics', async () => {
  const f = fixture();
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(!!f.monitor.result().quota!.stale, false);
  f.visible(false);
  await f.monitor.capture();
  assert.equal(!!f.monitor.result().quota!.stale, false);
  f.visible(true);
  f.text('Settings closed PRIVATE_CHAT private@example.test');
  await f.monitor.capture(true);
  assert.equal(!!f.monitor.result().quota!.stale, false);
  f.text('免费版 每周限额将在 10月14日重置 PRIVATE_NAME private@example.test');
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().quota!.stale, true);
  assert.deepEqual(f.monitor.result().usageDiagnostics, ['免费版 · 每周限额 · 10月14日']);
  f.text('Settings closed PRIVATE_CHAT');
  await f.monitor.capture(true);
  assert.deepEqual(f.monitor.result().usageDiagnostics, ['免费版 · 每周限额 · 10月14日']);
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(!!f.monitor.result().quota!.stale, false);
  assert.deepEqual(f.monitor.result().usageDiagnostics, []);
  f.monitor.close();
});

test('Muse learns a separate settings route and reloads its hidden DOM every ten minutes without POST replay', async () => {
  const f = fixture();
  f.text('Chat PRIVATE_CHAT');
  await f.monitor.capture(true);
  f.url(`${origin}/settings/usage`);
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().usageUrl, `${origin}/settings/usage`);
  await f.response('graphql', { CSRF: 'PRIVATE_TOKEN' }, `${origin}/graphql`, 'POST');
  assert.deepEqual(f.bodyReads, []);
  assert.equal(f.monitor.result().signatures?.length ?? 0, 0);
  f.visible(false);
  await f.monitor.capture();
  f.url(`${origin}/chat`);
  await f.monitor.refresh();
  assert.equal(f.reloads.length, 0);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh();
  assert.deepEqual(f.reloads, [`${origin}/settings/usage`]);
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 87);
  assert.equal(f.monitor.result().quota!.balances![0]!.remainingTokens, 25.9e9);
  assert.equal(!!f.monitor.result().quota!.stale, false);
  assert.equal(f.calls.length, 0);
  f.fail(true);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh();
  assert.equal(f.monitor.result().quota!.stale, true);
  f.fail(false);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh();
  assert.equal(!!f.monitor.result().quota!.stale, false);
  f.visible(true);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh();
  assert.equal(f.reloads.length, 2, 'visible settings are captured without navigating the user');
  f.monitor.close();
});

test('a same-page usage panel is never a route or a POST replay; its kept reading goes stale until the panel reopens', async () => {
  const f = fixture();
  // The bridge reconfigures with the agent's home address on every poll, while the chat sits at another address.
  const poll = () => f.monitor.configure(true, undefined, '', `${origin}/`, 'synthetic');
  poll();
  f.text('Chat PRIVATE_CHAT');
  await f.monitor.capture(true);
  f.tick(3000);
  await f.monitor.capture();
  poll();
  // Settings open over the chat without changing the address; the panel's numbers arrive by POST.
  f.text(muse);
  await f.response(
    'graphql',
    {
      data: {
        weekly: { used_percent: 87, reset_at: parseWebUsage(muse, now).windows[0]!.resetsAt },
        extra: { used_percent: 0, remaining_tokens: 25.9e9 },
      },
    },
    `${origin}/graphql`,
    'POST',
  );
  await f.monitor.capture(true);
  const first = f.monitor.result();
  assert.equal(first.usageUrl, undefined, 'reloading the chat address would not show the panel');
  assert.deepEqual(first.signatures ?? [], []);
  assert.deepEqual(f.bodyReads, [], 'POST bodies are neither read nor kept for replay');
  assert.equal(first.quota!.balances![0]!.remainingTokens, 25.9e9);
  f.text('Chat');
  await f.monitor.capture(true);
  f.visible(false);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh(true);
  await f.monitor.refresh(false, true);
  assert.deepEqual([f.reloads, f.calls], [[], []]);
  assert.deepEqual(f.monitor.result().quota, first.quota, 'the last valid reading survives the closed panel');
  const agent: ExternalAgentView = {
    id: 'muse',
    name: 'Muse',
    kind: 'web',
    description: '',
    enabled: true,
    available: true,
    quota: f.monitor.result().quota,
    usageSignatures: [],
  };
  const card = renderToStaticMarkup(
    createElement(WebAgentQuotaRows, { agents: [agent], now: f.now(), onRead: () => undefined }),
  );
  for (const pattern of [/上次读数/, /aria-label="Muse 读取用量"/, /设置 → 通用 → 使用情况 即可刷新/])
    assert.match(card, pattern);
  assert.doesNotMatch(card, /每 10 分钟自动刷新/);
  f.visible(true);
  f.text(muse.replace('87%', '90%').replace('259 亿', '250 亿'));
  await f.monitor.capture(true);
  const reopened = f.monitor.result().quota!;
  assert.equal(reopened.windows[0]!.usedPercent, 90);
  assert.equal(reopened.balances![0]!.remainingTokens, 25e9);
  assert.equal(reopened.observedAt, new Date(f.now()).toISOString());
  assert.equal(f.monitor.result().usageUrl, undefined);
  // A separate route still loading at the first capture is still learned.
  f.url(`${origin}/settings/usage`);
  f.text('Loading');
  f.tick(3000);
  await f.monitor.capture(true);
  poll();
  f.text(muse);
  await f.monitor.capture(true);
  assert.equal(f.monitor.result().usageUrl, `${origin}/settings/usage`);
  for (const route of [
    `${origin}/settings?csrf=SECRET`,
    `${origin}/settings#token=SECRET`,
    'https://foreign.test/settings',
    `${origin}/settings/user-123`,
  ])
    assert.equal(safeWebUsageRoute(route, origin), false);
  assert.equal(safeWebUsageRoute(`${origin}/?tab=usage`, origin), true);
  assert.equal(safeWebUsageRoute(`${origin}/#/settings/usage`, origin), true);
  f.monitor.close();
});

test('visible DOM capture learns from CDP responses, retains no bodies or volatile query and detaches on close', async () => {
  const f = fixture();
  await f.monitor.capture();
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 9);
  await f.response('foreign', { weekly: { used_percent: 9, reset_at: reset } }, 'https://foreign.test/rest/usage');
  await f.response('right', { weekly: { used_percent: 9, reset_at: reset }, secret: 'PRIVATE_BODY' });
  assert.deepEqual(f.bodyReads, ['right']);
  assert.equal(f.monitor.result().signatures![0]!.path, '/rest/usage');
  assert.doesNotMatch(JSON.stringify(f.monitor.result()), /PRIVATE_BODY|PRIVATE_COOKIE|nonce/);
  f.visible(false);
  await f.monitor.capture();
  const count = f.captures();
  await f.monitor.capture();
  assert.equal(f.captures(), count);
  f.monitor.close();
  assert.equal(f.detached(), 1);
});

test('learned refresh uses page credentials on schedule and after replies, serializes and skips human checks', async () => {
  const f = fixture();
  await f.response('right', { weekly: { used_percent: 9, reset_at: reset } });
  await f.monitor.refresh();
  assert.equal(f.calls.length, 0);
  f.tick(webUsageRefreshMs - 1);
  await f.monitor.refresh();
  assert.equal(f.calls.length, 0);
  f.tick(1);
  await Promise.all([f.monitor.refresh(), f.monitor.refresh()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, '/rest/usage');
  assert.equal(f.calls[0]!.options.credentials, 'same-origin');
  assert.equal(f.calls[0]!.options.redirect, 'error');
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 10);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 2);
  f.blocked(true);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 2);
  f.blocked(false);
  f.monitor.configure(false);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 2);
  f.monitor.close();
});

test('refresh errors back off even after replies, shape changes mark stale and allow DOM fallback', async () => {
  const f = fixture();
  await f.response('right', { weekly: { used_percent: 9, reset_at: reset } });
  f.fail(true);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.monitor.result().quota!.stale, true);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 1);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh();
  assert.equal(f.calls.length, 2);
  f.tick(webUsageRefreshMs);
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 2, 'second error backs off for twenty minutes');
  f.tick(webUsageRefreshMs);
  f.fail(false);
  f.shape();
  await f.monitor.refresh();
  assert.equal(f.calls.length, 3);
  assert.equal(f.monitor.result().signatures!.length, 0);
  assert.equal(f.monitor.result().quota!.stale, true);
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 9, 'shape changes never invent a number');
  f.text('SuperGrok 11% 4 天后重置');
  await f.monitor.capture();
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 11);
  f.monitor.close();
});

test('changing to a foreign origin blocks replay and invisible windows never learn network responses', async () => {
  const f = fixture();
  await f.response('right', { weekly: { used_percent: 9, reset_at: reset } });
  f.url('https://foreign.test/chat');
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 0);
  f.visible(false);
  await f.response('hidden', { weekly: { used_percent: 9, reset_at: reset } }, 'https://foreign.test/rest/usage');
  assert.deepEqual(f.bodyReads, ['right']);
  f.monitor.close();
});

test('responses are read only when a visible usage view supplies matching text, including a delayed menu render', async () => {
  const f = fixture();
  f.text('Welcome');
  await f.response('before-menu', { weekly: { used_percent: 9, reset_at: reset } });
  assert.deepEqual(f.bodyReads, []);
  f.text(grok);
  f.tick(3000);
  await f.monitor.capture();
  assert.deepEqual(f.bodyReads, ['before-menu']);
  assert.equal(f.monitor.result().signatures![0]!.path, '/rest/usage');
  f.monitor.close();
});

test('debugger failure keeps DOM fallback alive, and zero-only percentage learning never guesses its units', async () => {
  const f = fixture({ debuggerFail: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.monitor.capture();
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 9);
  f.monitor.close();
  const quota = parseWebUsage('额外的使用额度 已使用 0%（剩余 259 亿个词元） 从不过期', now);
  const signature = learnUsageSignature(
    [
      {
        method: 'GET',
        origin,
        path: '/usage',
        metrics: usageMetrics({ extra: { used: 0, remaining_tokens: 25.9e9 } }),
      },
    ],
    quota,
    origin,
  )!;
  assert.equal(signature.balances[0]!.percent.zeroOnly, true);
  assert.equal(readLearnedUsage({ extra: { used: 0.1, remaining_tokens: 20e9 } }, signature, now), undefined);
  assert.equal(
    readLearnedUsage({ extra: { used: 0, remaining_tokens: 20e9 } }, signature, now)!.balances![0]!.remainingTokens,
    20e9,
  );
});

test('DOM checks are throttled and unrelated page changes cannot slide a relative reset or replace newer readings', async () => {
  const f = fixture();
  await f.monitor.capture();
  f.tick(2999);
  await f.monitor.capture();
  assert.equal(f.captures(), 1);
  f.tick(1);
  await f.monitor.capture();
  assert.equal(f.captures(), 2);
  f.text(`${grok} menu clock changed`);
  f.tick(3000);
  await f.monitor.capture();
  assert.equal(f.monitor.result().quota!.windows[0]!.resetsAt, reset);
  assert.equal(f.monitor.result().quota!.observedAt, new Date(now).toISOString());
  f.monitor.close();
});

test('a learned Muse response refreshes both the weekly percentage and the non-expiring deposit', async () => {
  const quota = parseWebUsage(muse, now);
  const f = fixture({
    apiBody: () => ({
      weekly: { used_percent: 90, reset_at: quota.windows[0]!.resetsAt },
      extra: { used_percent: 0, remaining_tokens: 20e9 },
    }),
  });
  f.text(muse);
  await f.response('muse', {
    weekly: { used_percent: 87, reset_at: quota.windows[0]!.resetsAt },
    extra: { used_percent: 0, remaining_tokens: 25.9e9 },
  });
  await f.monitor.refresh(true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 90);
  assert.equal(f.monitor.result().quota!.balances![0]!.remainingTokens, 20e9);
  assert.equal('resetsAt' in f.monitor.result().quota!.balances![0]!, false);
  f.monitor.close();
});

test('structural parsing accepts unseen Chinese and English plan labels and varying usage values', () => {
  for (const [text, label, used] of [
    ['导航\n星际套餐 α 22%\n7 天后重置', '星际套餐 α', 22],
    ['Account\nUsage Pro 51.5%\nResets in 2 hours', 'Usage Pro', 51.5],
    ['设置\n企业定制方案 L2\n已使用 62%\n每周限额将在 12月31日重置', '企业定制方案 L2', 62],
    ['Settings\nReset Pro\n38% used\nWeekly allowance resets on December 31', 'Reset Pro', 38],
  ] as const) {
    const window = parseWebUsage(text, now, true).windows[0]!;
    assert.equal(window.label, label);
    assert.equal(window.usedPercent, used);
  }
});

test('learning matches fresh screen values and learns only the corresponding plan label path', () => {
  const quota = parseWebUsage('实验套餐 15%\n6 天后重置', now, true);
  const resetsAt = quota.windows[0]!.resetsAt;
  const response = (path: string, used: number) => ({
    method: 'GET',
    origin,
    path,
    metrics: usageMetrics(
      { weekly: { plan_name: '实验套餐', used_percent: used, reset_at: resetsAt }, account_name: 'PRIVATE_ACCOUNT' },
      ['实验套餐'],
    ),
  });
  const signature = learnUsageSignature([response('/old', 9), response('/current', 15)], quota, origin)!;
  assert.equal(signature.path, '/current');
  assert.deepEqual(signature.windows[0]!.labelPath, ['weekly', 'plan_name']);
  assert.doesNotMatch(JSON.stringify(response('/current', 15)), /PRIVATE_ACCOUNT/);
  assert.equal(
    readLearnedUsage({ weekly: { plan_name: null, used_percent: 40, reset_at: resetsAt } }, signature, now),
    undefined,
  );
});

function displayed(f: ReturnType<typeof fixture>, id: 'grok-bot' | 'muse') {
  const agent: ExternalAgentView = {
    id,
    name: id,
    kind: 'web',
    enabled: true,
    available: true,
    description: '',
    quota: f.monitor.result().quota,
    usageSignatures: f.monitor.result().signatures,
  };
  return {
    usage: renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents: [agent], now: f.now() })),
    tray: trayPopupHtml({ running: 0, lines: webQuotaLines([agent], f.now()), totals: [] }, f.now()),
  };
}

test('one Grok agent refreshes three changing percentages, plans and reset dates, retaining expired readings until refresh', async () => {
  let body = { weekly: { plan_name: '探索方案', used_percent: 9, reset_at: reset } };
  const f = fixture({ apiBody: () => body });
  f.text('探索方案 9%\n4 天后重置');
  await f.response('learn', body);
  assert.deepEqual(f.monitor.result().signatures![0]!.windows[0]!.labelPath, ['weekly', 'plan_name']);
  f.visible(false);
  const rolledReset = new Date(Date.parse(reset) + 7 * 86_400_000).toISOString();
  for (const [index, reading] of [
    { plan_name: '探索方案', used_percent: 9, reset_at: reset },
    { plan_name: 'Team Nova', used_percent: 15, reset_at: reset },
    { plan_name: '升级方案 β', used_percent: 40, reset_at: rolledReset },
  ].entries()) {
    if (index === 1) f.tick(webUsageRefreshMs);
    if (index === 2) {
      f.tick(Date.parse(reset) - f.now() + 1);
      const stale = displayed(f, 'grok-bot');
      assert.match(stale.usage, /上次读数/);
      assert.match(stale.usage, /opacity:0.55/);
      assert.match(stale.tray, /reference.*上次读数/s);
      assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 15);
    }
    body = { weekly: reading };
    await f.monitor.refresh(index === 0);
    const quota = f.monitor.result().quota!;
    assert.equal(quota.windows[0]!.usedPercent, reading.used_percent);
    assert.equal(quota.windows[0]!.label, reading.plan_name);
    assert.equal(quota.windows[0]!.resetsAt, reading.reset_at);
    assert.equal(quota.observedAt, new Date(f.now()).toISOString());
    const html = displayed(f, 'grok-bot');
    assert.match(html.usage, new RegExp(`剩余 ${100 - reading.used_percent}%</strong>`));
    assert.ok(html.tray.replace(/<[^>]*>/g, '').includes(`${reading.plan_name} ${100 - reading.used_percent}%`));
    assert.doesNotMatch(html.usage + html.tray, /上次读数/);
  }
  assert.equal(f.calls.length, 3);
  f.monitor.close();
});

test('one Muse agent refreshes three changing weekly readings, plans and decreasing deposit balances in usage and tray', async () => {
  const firstReset = new Date(2026, 9, 16).toISOString();
  let body = {
    plan_name: '实验方案',
    weekly: { used_percent: 9, reset_at: firstReset },
    extra: { used_percent: 10, remaining_tokens: 45e9 },
  };
  const f = fixture({ apiBody: () => body });
  f.text('实验方案\n已使用 9%\n每周限额将在 10月16日重置\n额外的使用额度\n已使用 10%（剩余 450 亿个词元）\n从不过期');
  await f.response('learn', body);
  assert.deepEqual(f.monitor.result().signatures![0]!.windows[0]!.labelPath, ['plan_name']);
  f.visible(false);
  const rolledReset = new Date(2026, 9, 23).toISOString();
  for (const [index, reading] of [
    body,
    {
      plan_name: 'Research 2',
      weekly: { used_percent: 15, reset_at: firstReset },
      extra: { used_percent: 30, remaining_tokens: 35e9 },
    },
    {
      plan_name: '企业方案 新版',
      weekly: { used_percent: 40, reset_at: rolledReset },
      extra: { used_percent: 80, remaining_tokens: 10e9 },
    },
  ].entries()) {
    if (index === 1) f.tick(webUsageRefreshMs);
    if (index === 2) {
      f.tick(Date.parse(firstReset) - f.now() + 1);
      assert.match(displayed(f, 'muse').usage, /上次读数/);
    }
    body = reading;
    await f.monitor.refresh(index === 0);
    const quota = f.monitor.result().quota!;
    assert.equal(quota.windows[0]!.usedPercent, reading.weekly.used_percent);
    assert.equal(quota.windows[0]!.label, reading.plan_name);
    assert.equal(quota.windows[0]!.resetsAt, reading.weekly.reset_at);
    assert.equal(quota.balances![0]!.remainingTokens, reading.extra.remaining_tokens);
    assert.equal(quota.balances![0]!.usedPercent, reading.extra.used_percent);
    assert.equal('resetsAt' in quota.balances![0]!, false);
    const html = displayed(f, 'muse');
    assert.match(html.usage, new RegExp(`剩余 ${100 - reading.weekly.used_percent}%</strong>`));
    assert.ok(html.tray.replace(/<[^>]*>/g, '').includes(`${reading.plan_name} ${100 - reading.weekly.used_percent}%`));
    for (const rendered of [html.usage, html.tray]) {
      assert.ok(rendered.includes(rendered === html.usage ? '剩余 ' : `已使用 ${reading.extra.used_percent}%`));
      assert.ok(
        rendered.includes(`${reading.extra.remaining_tokens / 1e8} 亿${rendered === html.usage ? '' : '个'}词元`),
      );
      assert.match(rendered, /从不过期/);
      assert.doesNotMatch(rendered, /上次读数/);
    }
  }
  assert.equal(f.calls.length, 3);
  f.monitor.close();
});

test('changed page wording, units or row layout stays unknown or retains a stale last reading', async () => {
  const invalid = [
    '探索方案\nConsumption 40 percent\nRestarts tomorrow',
    '探索方案\n每周限额将在 12月31日重置\n消耗了 40%',
    '额外的使用额度\n已使用 30%（剩余 7 兆个词元）\n从不过期',
    '4 天后重置\n探索方案 40%',
  ];
  const f = fixture();
  await f.monitor.capture();
  const previous = f.monitor.result().quota!;
  let failed = false;
  for (const text of invalid) {
    assert.equal(parseWebUsage(text, now, true).status, 'unknown');
    f.text(text);
    f.tick(3000);
    await f.monitor.capture();
    const quota = f.monitor.result().quota!;
    failed ||= !!f.monitor.result().usageDiagnostics?.length;
    assert.equal(!!quota.stale, failed);
    assert.equal(quota.observedAt, previous.observedAt);
    assert.equal(quota.windows[0]!.usedPercent, previous.windows[0]!.usedPercent);
  }
  f.monitor.close();
  const unknown = fixture();
  unknown.text(invalid[0]!);
  await unknown.monitor.capture();
  assert.equal(unknown.monitor.result().quota, undefined);
  assert.match(displayed(unknown, 'grok-bot').usage, /没读到用量/);
  unknown.monitor.close();
});

test('a plan captured from the page stays current when the response has no plan field', async () => {
  const f = fixture();
  await f.response('learn', { weekly: { used_percent: 9, reset_at: reset } });
  assert.equal(f.monitor.result().signatures![0]!.windows[0]!.labelPath, undefined);
  f.text('自定义新套餐 18%\n4 天后重置');
  f.tick(3000);
  await f.monitor.capture();
  f.visible(false);
  await f.monitor.refresh(true);
  assert.equal(f.monitor.result().quota!.windows[0]!.label, '自定义新套餐');
  assert.equal(f.monitor.result().quota!.windows[0]!.usedPercent, 10);
  f.monitor.close();
});

test('Grok no-reset DOM learns only a matching plan and percent on a safe GET; refresh leaves reset unknown', async () => {
  const f = fixture({ apiBody: () => ({ grokPlanLabel: 'SuperGrok', usagePercent: 17, token: 'PRIVATE_TOKEN' }) });
  try {
    f.text('SuperGrok Used 9%');
    await f.response('no-reset', { grokPlanLabel: 'SuperGrok', usagePercent: 9, token: 'PRIVATE_TOKEN' });
    const signature = f.monitor.result().signatures?.[0];
    assert.ok(signature);
    assert.equal(signature.windows[0]?.reset, undefined);
    f.visible(false);
    f.tick(webUsageRefreshMs);
    await f.monitor.refresh();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.options.credentials, 'same-origin');
    assert.equal(f.monitor.result().quota?.windows[0]?.usedPercent, 17);
    assert.equal(f.monitor.result().quota?.windows[0]?.resetsAt, null);
    assert.equal(f.monitor.result().quota?.windows[0]?.resetNotReported, true);
    assert.doesNotMatch(JSON.stringify(f.monitor.result()), /PRIVATE_TOKEN/);
  } finally {
    f.monitor.close();
  }
});
