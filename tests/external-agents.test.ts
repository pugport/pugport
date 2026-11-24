import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import express from 'express';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ExternalAgents, type ExternalAgentsOptions } from '../src/server/external-agents/service.ts';
import { externalAgentRoutes } from '../src/server/external-agents/routes.ts';
import { detectWebLimit } from '../src/server/external-agents/config.ts';
import { parseWebUsage } from '../src/server/external-agents/config.ts';
import { ExternalAgentConfig } from '../src/server/external-agents/config.ts';
import type { WebBridge } from '../src/server/external-agents/web-bridge-client.ts';
import {
  carriesThirdPartyWords,
  externalMention,
  isThirdPartyExchange,
  withoutMention,
  grokBotHandoffNote,
} from '../src/shared/external-agents.ts';
import type { WebAgentRequest, WebAgentResult } from '../src/shared/web-bridge.ts';
import type { Conversation, ConversationMessage, MessageInput, Workflow } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

// Synthetic only: a fake web bridge; no real site or account is touched.
const base: MessageInput = { content: '', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' };

test('ordinary chat skips external-agent settings while explicit selections and mentions keep their checks', () => {
  const agents = Object.create(ExternalAgents.prototype) as ExternalAgents;
  agents.list = () => {
    throw new Error('external-catalog-read');
  };
  agents.view = () => {
    throw new Error('selected-agent-check');
  };
  for (const content of ['你好', '只回复收到', '解释 API', 'mail@example.com @Grok Bot 普通讨论'])
    assert.equal(agents.intercept('synthetic', { ...base, content }), undefined);
  assert.throws(() => agents.intercept('synthetic', { ...base, content: '@@Muse 你好' }), /external-catalog-read/);
  assert.throws(
    () => agents.intercept('synthetic', { ...base, content: '你好', externalAgentId: 'muse' }),
    /selected-agent-check/,
  );
  assert.throws(
    () => agents.intercept('synthetic', { ...base, content: '你好', externalAgentId: 'unknown' }),
    /不认识这个外部智能体/,
  );
});

test('natural-language selection requires a fresh human message and never overrides an explicit device or team', () => {
  const agents = Object.create(ExternalAgents.prototype) as ExternalAgents;
  agents.list = () => {
    throw new Error('natural-agent-catalog-read');
  };
  const input = { ...base, content: '让Muse回答这个问题' };
  assert.equal(agents.intercept('synthetic', input), undefined, 'internal callers do not enable natural invocation');
  for (const change of [
    { deviceId: 'device' },
    { participants: [{ kind: 'external' as const, id: 'grok-bot', name: 'Grok Bot', agent: 'Grok Bot' }] },
    { untrustedContent: true },
    { permissionOrigin: { mode: 'read-only' as const, source: 'role' as const } },
    { content: '解释这份文档', quotes: [{ text: '让Muse回答这个问题' }] },
  ])
    assert.equal(agents.intercept('synthetic', { ...input, ...change }, true), undefined);
  assert.throws(() => agents.intercept('synthetic', input, true), /natural-agent-catalog-read/);
});

test('human natural-language calls reuse configured agent authorization and preserve the entire request', async (t) => {
  const fake = fakeBridge((request) => ({
    ok: true,
    ...(request.action === 'send' ? { reply: 'Synthetic answer' } : {}),
  }));
  const f = fixture(t, { bridge: fake.bridge });
  const conversation = await f.workspace.createGeneralConversation();
  const content = '请m-u-s-e回答这个问题\n背景：这是合成测试。只用题目给出的资料。';
  const input = { ...base, content };
  assert.equal(
    f.agents.intercept(conversation.id, input, true),
    undefined,
    'unconfigured agents stay in normal routing',
  );
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  f.agents.update('muse', { enabled: false });
  assert.equal(f.agents.intercept(conversation.id, input, true), undefined, 'disabled agents are not selected');
  f.agents.update('muse', { enabled: true });
  assert.throws(
    () => f.agents.intercept(conversation.id, { ...input, attachmentIds: ['attachment'] }, true),
    /暂时收不了附件/,
    'existing delivery restrictions still apply',
  );
  const sent = f.agents.intercept(conversation.id, input, true)!;
  assert.equal(sent.message.content, content);
  assert.equal(sent.reply.externalAgent!.agentId, 'muse');
  assert.equal(sent.reply.externalAgent!.request, content);
  assert.equal(f.workspace.store.list<Workflow>('workflow', conversation.id).length, 0);
  await until(() => f.message(sent.reply.id).externalAgent?.status === 'done');
  assert.equal(fake.calls.find((request) => request.action === 'send')?.text, content);
  const explicit = f.agents.intercept(
    conversation.id,
    { ...base, content: 'call Grok Bot to answer this question', externalAgentId: 'muse' },
    true,
  )!;
  assert.equal(explicit.reply.externalAgent!.agentId, 'muse', 'an explicit agent selection wins over prose');
});

test('legacy reply selectors are cleared once, while inputs and newly validated replies survive', (t) => {
  const f = fixture(t);
  const config = new ExternalAgentConfig(join(f.directory, 'data'));
  mkdirSync(join(f.directory, 'data'), { recursive: true });
  writeFileSync(
    config.selectorsFile,
    JSON.stringify({ version: 1, sites: { muse: { input: '#chat', reply: '.history' }, other: { reply: 'aside' } } }),
  );
  assert.equal(config.selectors('muse').reply, undefined);
  assert.equal(config.selectors('muse').input, '#chat');
  assert.equal(config.selectors('other').reply, undefined);
  config.saveSelectors('muse', { reply: '.answer' });
  assert.equal(new ExternalAgentConfig(join(f.directory, 'data')).selectors('muse').reply, '.answer');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

for (const action of ['usage', 'monitor', 'detect'] as const) {
  test(`late web ${action} cannot restore settings or login state after an edit`, async (t) => {
    const entered = deferred<void>();
    const pending = deferred<WebAgentResult>();
    const fake = fakeBridge((request) => {
      if (request.action === action) {
        entered.resolve();
        return pending.promise;
      }
      return { ok: false };
    });
    const f = fixture(t, { bridge: fake.bridge });
    f.agents.update('muse', {
      enabled: true,
      acceptRisk: true,
      url: 'https://fixture.test/chat',
      usageUrl: 'https://fixture.test/usage',
    });
    const read =
      action === 'usage' ? f.agents.readUsage('muse') : action === 'detect' ? f.agents.detect('muse') : f.agents.poll();
    await entered.promise;
    f.agents.update('muse', { usageUrl: 'https://fixture.test/new-usage' });
    const quota = parseWebUsage('20% used', Date.parse('2026-10-11T08:00:00Z'));
    pending.resolve({
      ok: true,
      quota,
      usageUrl: 'https://fixture.test/usage',
      selectors: { input: '#old-site-input' },
      found: { input: true, send: true, reply: true },
      limit: { reason: 'Old site limit', observedAt: quota.observedAt!, resetsAt: null },
    });
    await read;
    const view = f.agents.view('muse');
    assert.equal(view.usageUrl, 'https://fixture.test/new-usage');
    assert.equal(view.quota, undefined);
    assert.equal(view.cooldown, undefined);
    assert.equal(view.detection, undefined);
    assert.notEqual(f.agents.config.selectors('muse').input, '#old-site-input');
    const calls = fake.calls.length;
    await f.agents.readUsage('muse', true);
    for (const call of fake.calls.slice(calls)) {
      assert.equal(call.action, 'usage');
      if (call.action !== 'usage') continue;
      assert.equal(call.background, true, 'a new session is checked only through the silent background path');
      assert.equal(call.usageUrl, 'https://fixture.test/new-usage');
    }
    assert.equal(
      f.agents.config.agent('muse').usageSignedOut,
      undefined,
      'an obsolete result cannot change login state',
    );
  });
}

test('changing a web origin clears its saved site state and rejects an old response even after changing back', async (t) => {
  const entered = deferred<void>();
  const pending = deferred<WebAgentResult>();
  const fake = fakeBridge(() => {
    entered.resolve();
    return pending.promise;
  });
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', {
    enabled: true,
    acceptRisk: true,
    url: 'https://fixture.test/chat',
    usageUrl: 'https://fixture.test/usage',
  });
  const quota = parseWebUsage('20% used', Date.parse('2026-10-11T08:00:00Z'));
  f.agents.config.update('muse', {
    quota,
    cooldown: { reason: 'Old site limit', observedAt: quota.observedAt!, resetsAt: null },
    usageDiagnostics: ['Old site quota'],
    detection: { at: quota.observedAt!, ok: true, note: 'Old site input' },
  });
  f.agents.config.saveSelectors('muse', { input: '#old-input', reply: '#old-answer' });
  const read = f.agents.readUsage('muse');
  await entered.promise;
  f.agents.update('muse', { url: 'https://second.test/chat' });
  const saved = new ExternalAgentConfig(join(f.directory, 'data'));
  assert.equal(saved.agent('muse').usageUrl, undefined);
  assert.equal(saved.agent('muse').quota, undefined);
  assert.equal(saved.agent('muse').cooldown, undefined);
  assert.equal(saved.agent('muse').detection, undefined);
  assert.equal(saved.agent('muse').usageDiagnostics, undefined);
  assert.notEqual(saved.selectors('muse').input, '#old-input');
  assert.equal(saved.selectors('muse').reply, undefined);
  f.agents.update('muse', { url: 'https://fixture.test/chat', usageUrl: 'https://fixture.test/usage' });
  pending.resolve({ ok: true, quota, usageUrl: 'https://fixture.test/usage' });
  assert.equal((await read)?.ok, false);
  assert.equal(f.agents.view('muse').quota, undefined);
  f.agents.config.saveSelectors(
    'muse',
    { input: '#fixture-input', reply: '#fixture-reply' },
    'https://fixture.test/chat',
  );
  assert.equal(f.agents.config.selectors('muse', 'https://fixture.test/chat').input, '#fixture-input');
  assert.notEqual(
    f.agents.config.selectors('muse', 'https://other-origin.test/chat').input,
    '#fixture-input',
    'selectors saved for one origin do not apply to another origin',
  );
  f.agents.update('muse', { url: '' });
  assert.equal(f.agents.view('muse').usageUrl, '');
  assert.notEqual(f.agents.config.selectors('muse', 'https://fixture.test/chat').input, '#fixture-input');
});

test('saved usage signature from a different origin is cleared on settings update', (t) => {
  const f = fixture(t, { bridge: fakeBridge(() => ({ ok: true })).bridge });
  f.agents.update('muse', { url: 'https://fixture.test/chat' });
  f.agents.config.update('muse', {
    usageSignatures: [{ method: 'GET', origin: 'https://other.test', path: '/usage', windows: [], balances: [] }],
  });
  f.agents.update('muse', { url: 'https://fixture.test/chat' });
  assert.equal(f.agents.config.agent('muse').usageSignatures, undefined);
});

test('changing a web site during send preserves the reply without updating or following the new site', async (t) => {
  const entered = deferred<void>();
  const pending = deferred<WebAgentResult>();
  const fake = fakeBridge((request) => {
    if (request.action === 'send') {
      entered.resolve();
      return pending.promise;
    }
    return { ok: true };
  });
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: 'https://fixture.test/chat' });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: 'Question', externalAgentId: 'muse' })!;
  await entered.promise;
  f.agents.update('muse', { url: 'https://second.test/chat' });
  pending.resolve({ ok: true, reply: 'Old site reply', trackerId: 'old-tracker', selectors: { input: '#old' } });
  await until(() => f.message(sent.reply.id).externalAgent!.status !== 'working');
  const message = f.message(sent.reply.id);
  assert.equal(message.externalAgent!.status, 'needs-user');
  assert.match(message.externalAgent!.note!, /原窗口.*重复发送/);
  assert.equal(message.content, 'Old site reply');
  assert.equal(message.externalAgent!.following, undefined);
  assert.equal(f.agents.view('muse').detection, undefined);
  assert.notEqual(f.agents.config.selectors('muse').input, '#old');
  assert.equal(fake.calls.filter((request) => request.action === 'send').length, 1);
  assert.ok(fake.calls.some((request) => request.action === 'stop'));
});

test('clearing a route learned since the last desktop poll sends a new configuration version', async (t) => {
  const fake = fakeBridge((request) =>
    request.action === 'usage'
      ? {
          ok: true,
          quota: parseWebUsage('20% used', Date.parse('2026-10-11T08:00:00Z')),
          usageUrl: 'https://fixture.test/usage',
        }
      : { ok: true },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: 'https://fixture.test/chat' });
  await f.agents.readUsage('muse');
  const usage = fake.calls.find((request) => request.action === 'usage')!;
  assert.equal(usage.action, 'usage');
  if (usage.action !== 'usage') return;
  assert.ok(usage.configurationVersion);
  assert.equal(f.agents.view('muse').usageUrl, 'https://fixture.test/usage');
  f.agents.update('muse', { usageUrl: '' });
  f.agents.config.saveSelectors('muse', { input: '#current-input', reply: '#current-answer' });
  await f.agents.poll();
  const monitor = fake.calls.find((request) => request.action === 'monitor' && request.agentId === 'muse')!;
  assert.equal(monitor.action, 'monitor');
  if (monitor.action !== 'monitor') return;
  assert.ok(monitor.configurationVersion);
  assert.notEqual(monitor.configurationVersion, usage.configurationVersion);
  assert.equal(monitor.usageUrl, undefined);
  assert.equal(monitor.selectors?.reply, '#current-answer');
  assert.equal(f.agents.view('muse').usageUrl, '');
});

test('web reply timeout needs the user, retains handoff and stores no unrelated page text', async (t) => {
  const fake = fakeBridge(() => ({ ok: false, code: 'timeout', message: '没找到它的回复，请在它的窗口里查看。' }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: 'Question', externalAgentId: 'muse' })!;
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'needs-user');
  const message = f.message(sent.reply.id);
  assert.equal(message.externalAgent!.handoff, true);
  assert.match(message.externalAgent!.note!, /没找到它的回复/);
  assert.doesNotMatch(message.content, /Old history|sidebar/);
});

test('a still-generating timeout keeps partial reply text and displays its timeout explanation', async (t) => {
  const note = '它还在回复，已超过等待时间；请在它的窗口里查看';
  const fake = fakeBridge(() => ({ ok: true, reply: 'Already captured reply text', partial: true, message: note }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: 'Question', externalAgentId: 'muse' })!;
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'done');
  assert.equal(f.message(sent.reply.id).content, 'Already captured reply text');
  assert.equal(f.message(sent.reply.id).externalAgent!.note, note);
});

test('sending an @agent message unarchives the conversation and includes live replies in state', async (t) => {
  const fake = fakeBridge(() => ({ ok: true, reply: 'Synthetic live reply' }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  f.workspace.archiveConversation(conversation.id, true);
  assert.throws(() => f.agents.intercept(conversation.id, { ...base, content: '@@Muse' }), /写上要它做的事/);
  assert.ok(f.workspace.conversation(conversation.id).conversation.archivedAt);
  const sent = f.agents.intercept(conversation.id, { ...base, content: '@@Muse Synthetic question' })!;
  assert.equal(f.workspace.conversation(conversation.id).conversation.archivedAt, undefined);
  assert.ok(f.workspace.state().conversations?.some((value) => value.id === conversation.id));
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'done');
  assert.equal(
    f.workspace.state().conversationMessages?.find((value) => value.id === sent.reply.id)?.content,
    'Synthetic live reply',
  );
});

test('derived and combined answers share third-party trust checks while plain replies stay trusted', () => {
  for (const message of [
    { untrustedContent: true },
    { combinedFrom: ['Muse'] },
    { externalAgent: { untrusted: true } },
  ]) {
    assert.equal(carriesThirdPartyWords(message), true);
    assert.equal(isThirdPartyExchange(message), true);
  }
  assert.equal(isThirdPartyExchange({ externalRequest: { thirdParty: true } }), true);
  for (const message of [{}, { untrustedContent: false }, { combinedFrom: [] }]) {
    assert.equal(carriesThirdPartyWords(message), false);
    assert.equal(isThirdPartyExchange(message), false);
  }
});

function fixture(t: TestContext, options: ExternalAgentsOptions = {}) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'external-agents-test-')));
  const previous = {
    memory: process.env.COMBORUNNER_MEMORY_DIR,
  };
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  let clock = Date.parse('2026-10-11T08:00:00Z');
  const open = (agentOptions: ExternalAgentsOptions = {}) => {
    const controller = new Controller(directory, join(directory, 'data'));
    clearInterval(controller.timer);
    controller.targets = [];
    controller.snapshots = [];
    t.mock.method(controller, 'refresh', async () => {});
    const workspace = new Workspace(controller, { autoTick: false });
    const agents = new ExternalAgents(workspace, join(directory, 'data'), {
      autoPoll: false,
      now: () => clock,
      bridge: options.bridge,
      grokUsage: options.grokUsage ?? { session: async () => undefined },
      ...agentOptions,
    });
    return { controller, workspace, agents };
  };
  const f = { ...open(), directory };
  const close = async () => {
    f.agents.close();
    await f.workspace.close();
    await f.controller.close();
  };
  t.after(async () => {
    await close();
    for (const [key, value] of [['COMBORUNNER_MEMORY_DIR', previous.memory]] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('external-'));
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return Object.assign(f, {
    tick: (ms = 1000) => (clock += ms),
    restart: async (agentOptions?: ExternalAgentsOptions) => {
      await close();
      Object.assign(f, open(agentOptions));
    },
    message: (id: string) => f.workspace.store.get<ConversationMessage>('message', id)!,
  });
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((done) => setTimeout(done, 10));
  }
}

function fakeBridge(handler: (request: WebAgentRequest) => Promise<WebAgentResult> | WebAgentResult) {
  let active = 0;
  const state = { calls: [] as WebAgentRequest[], maxActive: 0, available: true };
  const bridge: WebBridge = {
    available: () => state.available,
    async request(request) {
      state.calls.push(request);
      active++;
      state.maxActive = Math.max(state.maxActive, active);
      try {
        return await handler(request);
      } finally {
        active--;
      }
    },
  };
  return Object.assign(state, { bridge });
}

test('web quota: persisted cooldown blocks queued and new messages, then expires without routing', async (t) => {
  let calls = 0;
  const fake = fakeBridge(() =>
    ++calls === 1
      ? {
          ok: false,
          limit: detectWebLimit(
            "You've reached your limit. Try again in 3 hours",
            true,
            Date.parse('2026-10-11T08:00:00Z'),
          ),
        }
      : { ok: true, reply: '恢复了' },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const first = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 一' })!;
  const second = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 二' })!;
  await until(() => f.message(second.reply.id).externalAgent?.status === 'failed');
  assert.match(f.message(first.reply.id).content, /已用完 · 3 小时 0 分钟后重置/);
  assert.equal(f.message(first.reply.id).externalAgent?.note, undefined);
  assert.equal(fake.calls.length, 1, 'the queued message never reaches the browser');
  await f.restart();
  const third = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 三' })!;
  await until(() => f.message(third.reply.id).externalAgent?.status === 'failed');
  assert.equal(fake.calls.length, 1, 'cooldown survives a restart');
  f.tick(3 * 3_600_000);
  assert.equal(f.agents.view('muse').cooldown, undefined);
  f.agents.retry(third.reply.id);
  await until(() => f.message(third.reply.id).externalAgent?.status === 'done');
  assert.equal(fake.calls.length, 2);
  assert.equal(f.agents.config.agent('muse').cooldown, undefined, 'successful reply clears the persisted cooldown');
  assert.equal(f.workspace.store.list<Workflow>('workflow', conversation.id).length, 0);
});

test('web quota: limit with no reported reset time stays active while limit remains on page, then clears on recheck or send once removed', async (t) => {
  let limited = true;
  const fake = fakeBridge((request) => {
    if (limited) {
      return {
        ok: false,
        limit: detectWebLimit("You've reached your limit.", true, Date.parse('2026-10-11T08:00:00Z')),
      };
    }
    if (request.action === 'detect') return { ok: true, found: { input: true, send: true, reply: false } };
    if (request.action === 'usage')
      return {
        ok: true,
        quota: parseWebUsage('Used 25%. Resets on 2026-10-18T08:00:00Z', Date.parse('2026-10-11T08:05:00Z')),
      };
    return { ok: true, reply: '恢复可用' };
  });
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const first = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 一' })!;
  const second = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 二' })!;
  await until(() => f.message(second.reply.id).externalAgent?.status === 'failed');
  assert.equal(f.agents.view('muse').cooldown?.resetsAt, null);
  assert.match(f.message(first.reply.id).content, /已用完 · 重置时间未知/);
  assert.equal(fake.calls.length, 1, 'queued message in same batch fails without hitting the browser');

  // While the limit is still present on the page, recheck and retry keep the cooldown active
  assert.equal((await f.agents.detect('muse')).ok, false);
  assert.equal(f.agents.view('muse').cooldown?.resetsAt, null);
  f.agents.retry(second.reply.id);
  await until(() => f.message(second.reply.id).externalAgent?.status === 'failed' && fake.calls.length === 3);
  assert.equal(f.agents.view('muse').cooldown?.resetsAt, null);

  // Remove the limit from the page: detect clears the no-reset cooldown
  limited = false;
  assert.equal((await f.agents.detect('muse')).ok, true);
  assert.equal(f.agents.view('muse').cooldown, undefined);

  // Re-trigger no-reset limit, then remove it and verify retry/send also recovers directly
  limited = true;
  f.agents.retry(second.reply.id);
  await until(() => !!f.agents.view('muse').cooldown);
  assert.equal(f.agents.view('muse').cooldown?.resetsAt, null);
  limited = false;
  f.agents.retry(second.reply.id);
  await until(() => f.message(second.reply.id).externalAgent?.status === 'done');
  assert.equal(f.message(second.reply.id).content, '恢复可用');
  assert.equal(f.agents.view('muse').cooldown, undefined);
});

test('Muse background cadence survives restart and signed-out failures preserve the last reading', async (t) => {
  let human = false;
  const fake = fakeBridge((request) =>
    request.action === 'usage'
      ? human
        ? { ok: false, code: 'human-check' }
        : {
            ok: true,
            quota: parseWebUsage('Used 25%. Resets on 2026-10-18T08:00:00Z', Date.parse('2026-10-11T08:00:00Z')),
          }
      : request.action === 'detect'
        ? { ok: true, found: { input: true, send: true, reply: false } }
        : { ok: false, code: 'closed' },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', {
    enabled: true,
    acceptRisk: true,
    url: 'https://fixture.test/chat',
    usageUrl: 'https://fixture.test/usage',
  });
  const count = () => fake.calls.filter((request) => request.action === 'usage').length;
  await f.agents.poll();
  assert.equal(count(), 1, 'startup reads do not require an existing window');
  const quota = f.agents.config.agent('muse').quota;
  assert.equal(quota?.windows[0]?.usedPercent, 25);
  await f.restart();
  f.tick(12 * 3_600_000 - 1);
  await f.agents.poll();
  assert.equal(count(), 1);
  f.tick(1);
  human = true;
  await f.agents.poll();
  assert.equal(count(), 2);
  assert.deepEqual(f.agents.config.agent('muse').quota, quota);
  await f.restart();
  f.tick(24 * 3_600_000);
  await f.agents.poll();
  assert.equal(count(), 2, 'signed-out state persists and suppresses automatic reads');
  human = false;
  await f.agents.detect('muse');
  await f.agents.poll();
  assert.equal(count(), 3);
  for (const call of fake.calls.filter((call) => call.action === 'usage')) {
    assert.equal(call.background, true);
    assert.equal(call.automatic, true);
  }
});

test('web quota: only one usage read globally, manual unknown keeps the address and no fake window', async (t) => {
  let finish: ((value: WebAgentResult) => void) | undefined;
  const fake = fakeBridge(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture(t, { bridge: fake.bridge });
  for (const id of ['muse'] as const)
    f.agents.update(id, { enabled: true, acceptRisk: true, usageUrl: 'https://fixture.test/usage' });
  const first = f.agents.readUsage('muse');
  const second = await f.agents.readUsage('muse');
  assert.match(second.message, /正在处理/);
  assert.equal(fake.calls.length, 1);
  finish!({ ok: true, usageText: 'Welcome', pageUrl: 'https://fixture.test/usage' });
  assert.match((await first).message, /没读到用量：https:\/\/fixture.test\/usage/);
  assert.deepEqual(f.agents.view('muse').quota?.windows, []);
  assert.equal(f.agents.view('muse').quota?.status, 'unknown');
  assert.throws(() => f.agents.update('muse', { usageUrl: 'https://name:password@fixture.test' }), /网址/);
});

test('web quota: a successful in-flight reply clears a newly observed cooldown before its reset time', async (t) => {
  let finish: ((value: WebAgentResult) => void) | undefined;
  const fake = fakeBridge((request) =>
    request.action === 'send'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ok: true },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 你好' })!;
  await until(() => !!finish);
  f.agents.config.update('muse', {
    cooldown: detectWebLimit('已达上限，3小时后重置', true, Date.parse('2026-10-11T08:00:00Z')),
  });
  assert.ok(f.agents.view('muse').cooldown);
  finish!({ ok: true, reply: '成功回复' });
  await until(() => f.message(sent.reply.id).externalAgent?.status === 'done');
  assert.equal(f.agents.view('muse').cooldown, undefined);
});

test('web quota: visible monitor readings and learned paths persist and remain separate from CLI quota', async (t) => {
  const clock = Date.parse('2026-10-11T08:00:00Z');
  const quota = parseWebUsage('SuperGrok 9% 4 天后重置', clock);
  const signatures = [
    {
      method: 'GET' as const,
      origin: 'https://x.ai',
      path: '/rest/usage',
      windows: [
        {
          id: 'muse',
          label: 'SuperGrok',
          percent: { path: ['used_percent'], scale: 1 },
          reset: { path: ['reset_at'], scale: 1 },
        },
      ],
      balances: [],
    },
  ];
  const fake = fakeBridge((request) => (request.agentId === 'muse' ? { ok: true, quota, signatures } : { ok: true }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  await f.agents.poll();
  assert.equal(f.agents.view('muse').quota!.windows[0]!.usedPercent, 9);
  assert.equal(f.agents.view('muse').quota!.windows[0]!.label, 'SuperGrok');
  assert.equal(f.controller.snapshots.length, 0, 'DOM observations never become CLI/router snapshots');
  await f.restart();
  assert.deepEqual(f.agents.view('muse').usageSignatures, signatures);
  assert.equal(f.agents.view('muse').quota!.windows[0]!.usedPercent, 9);
});

test('web quota: Muse route and redacted diagnostics persist, and a route refresh needs no GET signature', async (t) => {
  const clock = Date.parse('2026-10-11T08:00:00Z');
  const quota = parseWebUsage(
    '免费版 每周限额将在 10月14日重置 已使用 87% 额外的使用额度 已使用 0%（剩余 259 亿个词元） 从不过期',
    clock,
  );
  const route = 'https://fixture.test/settings/usage';
  const fake = fakeBridge((request) =>
    request.agentId === 'muse'
      ? {
          ok: true,
          quota,
          signatures: [],
          usageUrl: route,
          usageDiagnostics: ['PRIVATE_NAME private@example.test 免费版 每周限额 10月14日 CSRF_secret'],
        }
      : { ok: true },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: 'https://fixture.test/chat' });
  await f.agents.poll();
  const view = f.agents.view('muse');
  assert.equal(view.usageUrl, route);
  assert.equal(!!view.quota!.stale, false);
  assert.deepEqual(view.usageDiagnostics, ['免费版 · 每周限额 · 10月14日']);
  assert.ok(
    fake.calls.some((request) => request.action === 'usage' && request.automatic && request.usageUrl === route),
  );
  await f.restart();
  assert.equal(f.agents.view('muse').usageUrl, route);
  assert.deepEqual(f.agents.view('muse').usageDiagnostics, ['免费版 · 每周限额 · 10月14日']);
});

test('web quota: balance-only update keeps weekly window original observation time and marks it stale while balance stays fresh', async (t) => {
  const t0 = Date.parse('2026-10-11T08:00:00Z');
  const t1 = Date.parse('2026-10-11T08:03:00Z');
  let step = 0;
  const fake = fakeBridge((request) =>
    request.agentId === 'muse'
      ? {
          ok: true,
          quota:
            ++step === 1
              ? parseWebUsage(
                  '免费版 每周限额将在 10月14日重置 已使用 87% 额外的使用额度 已使用 0%（剩余 259 亿个词元） 从不过期',
                  t0,
                )
              : parseWebUsage('额外的使用额度 已使用 10%（剩余 200 亿个词元） 从不过期', t1),
        }
      : { ok: true },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: 'https://fixture.test/chat' });
  await f.agents.poll();
  f.tick(3 * 60_000);
  await f.agents.poll();
  const quota = f.agents.view('muse').quota!;
  assert.equal(quota.observedAt, new Date(t1).toISOString());
  assert.equal(quota.windows[0]?.observedAt, new Date(t0).toISOString());
  assert.equal(quota.windows[0]?.stale, true);
  assert.equal(quota.balances?.[0]?.observedAt, new Date(t1).toISOString());
  assert.equal(quota.balances?.[0]?.stale, undefined);
  assert.equal(quota.balances?.[0]?.remainingTokens, 20_000_000_000);
});

test('web quota: same-agent post-reply triggers coalesce into the in-flight read', async (t) => {
  let finish: ((value: WebAgentResult) => void) | undefined;
  const fake = fakeBridge((request) =>
    request.action === 'usage' && !finish
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ok: true, usageText: 'Used 25%' },
  );
  const f = fixture(t, { bridge: fake.bridge });
  for (const id of ['muse'] as const) {
    f.agents.update(id, { enabled: true, acceptRisk: true });
    f.agents.config.update(id, {
      usageSignatures: [
        {
          method: 'GET',
          origin: 'https://fixture.test',
          path: '/usage',
          windows: [
            {
              id: 'web-usage',
              label: '用量',
              percent: { path: ['percent'], scale: 1 },
              reset: { path: ['reset'], scale: 1 },
            },
          ],
          balances: [],
        },
      ],
    });
    await f.agents.detect(id);
  }
  const first = f.agents.readUsage('muse', true, true);
  await f.agents.readUsage('muse', true, true);
  assert.equal(fake.calls.filter((request) => request.action === 'usage').length, 1);
  finish!({ ok: true, usageText: 'Used 25%' });
  await first;
  assert.equal(fake.calls.filter((request) => request.action === 'usage').length, 1);
  assert.equal(fake.maxActive, 1);
});

test('mentions name an external agent at a word start, and the name is taken out of the request', () => {
  const agents = [
    { id: 'grok-bot', name: 'Grok Bot' },
    { id: 'muse', name: 'Muse' },
  ];
  assert.equal(externalMention('@@Grok Bot 你好', agents)?.id, 'grok-bot');
  assert.equal(externalMention('请 @@Muse 修一下', agents)?.id, 'muse');
  // A single @ typed in passing must not send the message to a third party.
  assert.equal(externalMention('@Grok Bot 那个功能挺好', agents), undefined);
  assert.equal(externalMention('mail@Grok Bot', agents), undefined);
  assert.equal(externalMention('@Grok Botty hi', agents), undefined);
  assert.equal(withoutMention('@@Grok Bot 写一首诗', 'Grok Bot'), '写一首诗');
});

test('web agents: off by default, a one-time risk confirmation, and unavailable without the desktop app', async (t) => {
  const fake = fakeBridge(() => ({ ok: true, reply: 'hi' }));
  const f = fixture(t, { bridge: fake.bridge });
  assert.equal(f.agents.view('muse').enabled, false);
  assert.equal(f.agents.view('grok-bot').kind, 'handoff');
  assert.equal(f.agents.view('muse').url, 'https://muse.ai/', "Muse's own web chat is the starting address");
  assert.throws(() => f.agents.update('muse', { enabled: true }), /风险提示/);
  assert.throws(() => f.agents.update('muse', { url: 'javascript:alert(1)' }), /https/);
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  f.agents.update('muse', { enabled: false });
  assert.equal(f.agents.update('muse', { enabled: true }).enabled, true, 'asked once only');
  f.agents.update('muse', { enabled: false });
  assert.equal(f.agents.view('muse').reason, '已关闭');
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: '' });
  assert.equal(f.agents.view('muse').reason, '还没填网址', 'a cleared address is reported, not guessed');
  fake.available = false;
  f.agents.update('muse', { url: 'https://muse.ai/' });
  assert.equal(f.agents.view('muse').reason, '只能在 PugPort 桌面版里使用');
  const conversation = await f.workspace.createGeneralConversation();
  assert.throws(
    () => f.agents.intercept(conversation.id, { ...base, content: '你好', externalAgentId: 'muse' }),
    /桌面版/,
  );
  // An explicit typed mention fails before saving, just like a selection from the picker.
  f.agents.update('muse', { enabled: false });
  assert.throws(() => f.agents.intercept(conversation.id, { ...base, content: '@@Muse 你好' }), /已关闭/);
  fake.available = true;
  assert.throws(() => f.agents.intercept(conversation.id, { ...base, content: '@@Muse 你好' }), /已关闭/);
  assert.equal(f.agents.intercept(conversation.id, { ...base, content: '@@Codex 云端 你好' }), undefined);
});

test('web agents: one message at a time, replies labelled third-party and kept out of executors’ context', async (t) => {
  let n = 0;
  const fake = fakeBridge(async (request) => {
    if (request.action !== 'send') return { ok: true };
    await new Promise((done) => setTimeout(done, 30));
    return { ok: true, reply: `回复 ${++n}：${request.text}`, selectors: { input: '#box', reply: 'div.answer' } };
  });
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const folder = join(f.directory, 'repo');
  mkdirSync(folder);
  const conversation = f.workspace.createConversation((await f.workspace.createProject(folder)).id);
  const first = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 第一条' })!;
  const second = f.agents.intercept(conversation.id, { ...base, content: '第二条', externalAgentId: 'muse' })!;
  assert.match(f.message(second.reply.id).externalAgent!.note!, /前面还有 1 条/);
  await until(() => f.message(second.reply.id).externalAgent!.status === 'done');
  assert.equal(fake.maxActive, 1, 'never two at once for one agent');
  assert.equal((fake.calls[0] as { text: string }).text, first.reply.externalAgent!.request);
  assert.ok((fake.calls[1] as { text: string }).text.includes(first.message.content));
  assert.ok((fake.calls[1] as { text: string }).text.endsWith(second.reply.externalAgent!.request));
  const reply = f.message(first.reply.id);
  assert.equal(reply.content, '回复 1：第一条');
  assert.equal(reply.externalAgent!.name, 'Muse');
  assert.equal(reply.externalAgent!.untrusted, true);
  assert.equal(f.message(first.message.id).externalRequest?.thirdParty, true);
  assert.equal(
    f.workspace.store.get<Conversation>('conversation', conversation.id)!.untrustedContent,
    undefined,
    'the conversation keeps its tools',
  );
  assert.equal(f.agents.config.selectors('muse').reply, 'div.answer', 'what worked is kept for the site');
  assert.ok(existsSync(join(f.directory, 'data', 'web-agent-selectors.json')));
  assert.equal(f.agents.view('muse').detection?.ok, true);

  // A later message to PugPort's own executors: normal tools, and neither side of the exchange in its context.
  const next = await f.workspace.send(conversation.id, { ...base, content: '总结一下项目' });
  assert.equal(next.workflow.input.untrustedContent, undefined);
  const context = f.workspace.store.contextMessages(conversation.id, next.message.id);
  assert.deepEqual(context, [], 'the web exchange is not context for executors');
  // Quoting a web reply makes that one message tool-less, and only that one.
  const elsewhere = f.workspace.createConversation(conversation.projectId);
  const quoted = f.agents.taint({
    ...base,
    content: '看这段',
    quotes: [{ text: '回复 1', messageId: first.reply.id }],
  });
  assert.equal(quoted.untrustedContent, true);
  assert.equal(f.agents.taint({ ...base, content: '普通' }).untrustedContent, undefined);
  assert.equal((await f.workspace.send(elsewhere.id, quoted)).workflow.input.untrustedContent, true);
  assert.equal(f.workspace.store.get<Conversation>('conversation', elsewhere.id)!.untrustedContent, undefined);
  // History search, which feeds other tasks' prompts on its own, never offers a web agent's words.
  const third = f.workspace.createConversation(conversation.projectId);
  const asked = await f.workspace.send(third.id, { ...base, content: '之前的回复说了什么' });
  const hits = f.workspace.store.searchMemory(conversation.projectId, third.id, asked.message.id, ['回复', '项目']);
  assert.ok(hits.length > 0, 'the search itself works');
  assert.ok(!hits.some((hit) => hit.messageId === first.reply.id || hit.messageId === second.reply.id));
  assert.ok(!f.workspace.store.memoryIndexRows(conversation.projectId).some((row) => row.messageId === first.reply.id));
});

test('web agents: a captcha or sign-in page stops and asks the user; retry and hand-off work', async (t) => {
  let page: WebAgentResult = { ok: false, code: 'human-check', message: '页面要求人机验证。' };
  const fake = fakeBridge((request) => (request.action === 'send' ? page : { ok: true }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: '你好', externalAgentId: 'muse' })!;
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'needs-user');
  assert.match(f.message(sent.reply.id).externalAgent!.note!, /人机验证/);
  assert.equal(
    f.workspace.store.get<Conversation>('conversation', conversation.id)!.untrustedContent,
    undefined,
    'nothing from the third party came in',
  );

  await f.agents.handoff(sent.reply.id);
  const handoff = fake.calls.find((call) => call.action === 'handoff') as { text: string };
  assert.equal(handoff.text, '你好');
  assert.match(f.message(sent.reply.id).externalAgent!.note!, /剪贴板/);

  page = { ok: false, code: 'not-detected', message: '没认出输入框。' };
  f.agents.retry(sent.reply.id);
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'failed');
  assert.equal(f.message(sent.reply.id).externalAgent!.handoff, true);
  assert.equal(f.agents.view('muse').detection?.ok, false);

  page = { ok: true, reply: '你好呀', partial: true };
  f.agents.retry(sent.reply.id);
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'done');
  assert.equal(f.message(sent.reply.id).content, '你好呀');
  assert.match(f.message(sent.reply.id).externalAgent!.note!, /不完整/);
  assert.throws(() => f.agents.retry(sent.reply.id), /还没结束|不用重试/);

  let recaptureResult: WebAgentResult = {
    ok: false,
    sent: true,
    code: 'not-detected',
    message: '消息发出去了，但没认出 Muse 的回复。请到它的窗口里查看。',
  };
  page = recaptureResult;
  const second = f.agents.intercept(conversation.id, { ...base, content: '第二问', externalAgentId: 'muse' })!;
  await until(() => f.message(second.reply.id).externalAgent!.status === 'failed');
  assert.equal(f.message(second.reply.id).externalAgent!.sent, true);
  const sendsBeforeRetry = fake.calls.filter((call) => call.action === 'send').length;
  recaptureResult = { ok: true, sent: true, reply: 'Recaptured reply without resending', trackerId: 'recaptured-1' };
  const originalImpl = fake.bridge.request;
  fake.bridge.request = async (request, timeoutMs) => {
    if (request.action === 'recapture') {
      fake.calls.push(request);
      return recaptureResult;
    }
    return originalImpl(request, timeoutMs);
  };
  f.agents.retry(second.reply.id);
  await until(() => f.message(second.reply.id).externalAgent!.status === 'done');
  assert.equal(
    fake.calls.filter((call) => call.action === 'send').length,
    sendsBeforeRetry,
    'retry after sent prompt never resends',
  );
  // No saved thread here, so the send packed the earlier turns; recapture looks for exactly what the page received.
  const secondSend = fake.calls.filter((call) => call.action === 'send').at(-1)!;
  assert.match(secondSend.text!, /只作背景[\s\S]*这次的消息：\n第二问$/);
  assert.equal(
    fake.calls.some((call) => call.action === 'recapture' && call.text === secondSend.text),
    true,
  );
  assert.equal(f.message(second.reply.id).content, 'Recaptured reply without resending');
});

test('web agents: a message cut off by a restart is reported, never re-sent', async (t) => {
  let recapturedReply = '';
  const fake = fakeBridge((request) => {
    if (request.action === 'send') return new Promise<WebAgentResult>(() => {});
    if (request.action === 'recapture') {
      return recapturedReply
        ? { ok: true, sent: true, reply: recapturedReply, trackerId: 'recovered-1' }
        : { ok: false, sent: true, code: 'not-detected' };
    }
    return { ok: true };
  });
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true, url: 'https://muse.example.test/chat' });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: '@@Muse 在吗' })!;
  await until(() => f.message(sent.reply.id).externalAgent!.status === 'working');
  assert.equal(fake.calls.length, 1);
  await f.restart();
  const after = f.message(sent.reply.id);
  assert.equal(after.externalAgent!.status, 'failed');
  assert.equal(after.externalAgent!.sent, true);
  assert.match(after.externalAgent!.note!, /应用重启/);
  assert.equal(after.externalAgent!.handoff, true);

  recapturedReply = 'Recovered after restart without resending';
  await f.agents.poll();
  assert.equal(
    fake.calls.filter((call) => call.action === 'send').length,
    1,
    'never resends a working message after restart',
  );
  assert.equal(
    fake.calls.some((call) => call.action === 'recapture' && call.text === '在吗'),
    true,
  );
  assert.equal(f.message(sent.reply.id).externalAgent!.status, 'done');
  assert.equal(f.message(sent.reply.id).content, 'Recovered after restart without resending');
});

test('Grok desktop migration ignores old web URL, risk and quota while preserving enabled; @@ only hands off', async (t) => {
  const fake = fakeBridge(() => ({ ok: true, reply: 'must never become a chat reply' }));
  const f = fixture(t, { bridge: fake.bridge });
  writeFileSync(
    f.agents.config.file,
    JSON.stringify({
      version: 1,
      agents: {
        'grok-bot': {
          enabled: true,
          riskAccepted: true,
          riskAcceptedAt: '2026-10-01T00:00:00Z',
          url: 'https://old.invalid',
          quota: parseWebUsage('Used 80%', Date.parse('2026-10-11T08:00:00Z')),
        },
      },
    }),
  );
  const view = f.agents.view('grok-bot');
  assert.equal(view.enabled, true);
  assert.equal(view.available, true);
  assert.equal(view.kind, 'handoff');
  assert.equal(view.url, undefined);
  assert.equal(view.riskAccepted, undefined);
  assert.deepEqual(view.quota?.windows, []);
  assert.equal(f.agents.update('grok-bot', { url: 'javascript:ignored' }).url, undefined);
  const conversation = await f.workspace.createGeneralConversation();
  const first = f.agents.intercept(conversation.id, { ...base, content: '@@Grok Bot 第一条\n第二行' })!;
  await until(() => f.message(first.reply.id).externalAgent?.status === 'done');
  assert.equal(f.message(first.reply.id).content, grokBotHandoffNote);
  assert.equal(f.message(first.reply.id).externalAgent?.untrusted, undefined);
  assert.equal(f.message(first.reply.id).externalAgent?.task, undefined);
  assert.equal(fake.calls[0]!.action, 'desktop-handoff');
  assert.equal(fake.calls[0]!.url, 'grokbot://');
  assert.equal((fake.calls[0] as { text: string }).text, '第一条\n第二行');
  f.agents.update('grok-bot', { botId: 'bot-123' });
  const second = f.agents.intercept(conversation.id, { ...base, content: 'my part', externalAgentId: 'grok-bot' })!;
  await until(() => f.message(second.reply.id).externalAgent?.status === 'done');
  assert.equal(fake.calls[1]!.url, 'grokbot://app/v1/agent?id=bot-123');
  f.agents.update('grok-bot', { enabled: false });
  await f.agents.openDesktop('grok-bot');
  await f.agents.openDesktop('grok-bot', true);
  assert.equal(fake.calls[2]!.action, 'desktop-open');
  assert.equal(fake.calls[3]!.url, 'grokbot://app/v1/settings?id=usage');
  assert.ok(fake.calls.every((request) => request.action === 'desktop-handoff' || request.action === 'desktop-open'));
  await assert.rejects(() => f.agents.detect('grok-bot'), /不是网页智能体/);
  await f.restart();
  assert.equal(f.agents.view('grok-bot').enabled, false);
  assert.equal(f.agents.view('grok-bot').botId, 'bot-123');
});

test('Grok quota uses ten-minute cadence with explicitly selected Cursor login while chat is disabled; failed reads remove the previous values', async (t) => {
  let calls = 0,
    status = 200;
  const f = fixture(t, {
    grokUsage: {
      session: async () => ({ userId: 'fake', token: 'SYNTHETIC_TOKEN' }),
      fetch: async () => {
        calls++;
        return status === 200
          ? Response.json({
              usagePercent: 20,
              nextResetTimestampUtc: '2026-10-18T08:00:00Z',
              grokPlanLabel: 'SuperGrok',
            })
          : new Response('SYNTHETIC_TOKEN', { status });
      },
    },
  });
  f.controller.settings.refreshSeconds = 60;
  f.agents.update('grok-bot', { usageEnabled: true, usageSource: 'cursor-editor' });
  assert.equal(f.agents.view('grok-bot').enabled, false);
  await f.agents.poll();
  assert.equal(calls, 1);
  assert.equal(f.agents.view('grok-bot').quota?.status, 'known');
  f.tick(599_000);
  await f.agents.poll();
  assert.equal(calls, 1);
  status = 403;
  f.tick(1000);
  await f.agents.poll();
  assert.equal(calls, 2);
  assert.deepEqual(f.agents.view('grok-bot').quota?.windows, []);
  assert.match(f.agents.view('grok-bot').quota?.note ?? '', /登录失效或无权/);
  assert.doesNotMatch(JSON.stringify(f.agents.list()), /SYNTHETIC_TOKEN/);
  assert.doesNotMatch(readFileSync(f.agents.config.file, 'utf8'), /SYNTHETIC_TOKEN/);
  f.agents.update('grok-bot', { usageEnabled: false });
  f.tick(60_000);
  await f.agents.poll();
  assert.equal(calls, 2);
  assert.match((await f.agents.readUsage('grok-bot')).message, /没读到用量.*已关闭/);
  f.agents.update('grok-bot', { usageEnabled: true });
  status = 200;
  await f.agents.poll();
  assert.equal(calls, 3);
  assert.equal(f.agents.view('grok-bot').quota?.status, 'known');
});

test('Grok quota setting cancels an in-flight read and never restores its values after disabling', async (t) => {
  let started = false;
  const f = fixture(t, {
    grokUsage: {
      session: async () => ({ userId: 'fake', token: 'SYNTHETIC_TOKEN' }),
      fetch: async () => {
        started = true;
        return new Promise<Response>(() => {});
      },
    },
  });
  f.agents.update('grok-bot', { usageSource: 'cursor-editor' });
  const pending = f.agents.readUsage('grok-bot');
  await until(() => started);
  f.agents.update('grok-bot', { usageEnabled: false });
  await pending;
  assert.equal(f.agents.view('grok-bot').quota?.status, 'unknown');
  assert.deepEqual(f.agents.view('grok-bot').quota?.windows, []);
});

test('Grok hand-off failure allows a manual retry without exposing bridge errors or a fictional reply', async (t) => {
  let ok = false;
  const fake = fakeBridge(() => (ok ? { ok: true } : { ok: false, message: 'SYNTHETIC_TOKEN' }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('grok-bot', { enabled: true });
  const conversation = await f.workspace.createGeneralConversation();
  const sent = f.agents.intercept(conversation.id, { ...base, content: '@@Grok Bot hello' })!;
  await until(() => f.message(sent.reply.id).externalAgent?.status === 'failed');
  assert.doesNotMatch(JSON.stringify(f.message(sent.reply.id)), /SYNTHETIC_TOKEN/);
  ok = true;
  f.agents.retry(sent.reply.id);
  await until(() => f.message(sent.reply.id).externalAgent?.status === 'done');
  assert.equal(f.message(sent.reply.id).content, grokBotHandoffNote);
  assert.ok(fake.calls.every((request) => request.action === 'desktop-handoff'));
});

test('web agents: 重新识别 looks at the page from scratch and keeps what it found', async (t) => {
  let found: WebAgentResult = {
    ok: true,
    found: { input: true, send: false, reply: false },
    selectors: { input: 'textarea[placeholder="Ask"]' },
  };
  const fake = fakeBridge((request) => (request.action === 'detect' ? found : { ok: true }));
  const f = fixture(t, { bridge: fake.bridge });
  await assert.rejects(() => f.agents.detect('muse'), /已关闭/);
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  const seen = await f.agents.detect('muse');
  assert.equal(seen.ok, true);
  assert.match(seen.message, /回车/);
  assert.deepEqual((fake.calls[0] as { selectors: unknown }).selectors, {}, 'saved selectors may be stale');
  assert.equal(f.agents.config.selectors('muse').input, 'textarea[placeholder="Ask"]');
  assert.equal(f.agents.view('muse').detection?.ok, true);
  found = { ok: false, code: 'not-detected', message: '没认出输入框。' };
  const missed = await f.agents.detect('muse');
  assert.equal(missed.ok, false);
  assert.equal(missed.message, '没认出输入框。');
  assert.equal(f.agents.view('muse').detection?.ok, false);
  const opened = await f.agents.login('muse');
  assert.match(opened.message, /登录/);
  assert.equal(fake.calls.at(-1)!.action, 'open');
});

test('Grok usage defaults to independent login; source persists, never silently reads the editor and refreshes every ten minutes', async (t) => {
  let editorReads = 0,
    blocked = true;
  const quota = {
    status: 'known' as const,
    source: '独立登录 · Grok Bot 用量',
    observedAt: '2026-10-11T08:00:00Z',
    windows: [{ id: 'grok-bot', label: 'SuperGrok', usedPercent: 9, resetsAt: null, resetNotReported: true }],
    subscription: { label: 'SuperGrok', source: '独立登录', observedAt: '2026-10-11T08:00:00Z' },
  };
  const fake = fakeBridge((request) =>
    request.action === 'usage'
      ? blocked
        ? { ok: false, code: 'login', message: 'SYNTHETIC_TOKEN' }
        : { ok: true, quota }
      : { ok: true },
  );
  const f = fixture(t, {
    bridge: fake.bridge,
    grokUsage: {
      session: async () => {
        editorReads++;
        return undefined;
      },
    },
  });
  assert.equal(f.agents.view('grok-bot').usageSource, 'separate');
  await f.agents.poll();
  assert.equal(editorReads, 0);
  assert.equal(fake.calls.filter((request) => request.agentId.startsWith('grok-bot')).length, 0);
  assert.match(f.agents.view('grok-bot').quota?.note ?? '', /请登录 Grok Bot 用的账号/);
  await f.agents.login('grok-bot');
  const opened = fake.calls.find((request) => request.agentId === 'grok-bot-usage')!;
  assert.equal(opened.action, 'open');
  assert.equal(opened.url, 'https://cursor.com/dashboard/spending');
  await f.agents.poll();
  assert.equal(f.agents.view('grok-bot').quota?.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(f.agents.list()), /SYNTHETIC_TOKEN/);
  blocked = false;
  f.tick(600_000);
  await f.agents.poll();
  assert.equal(f.agents.view('grok-bot').quota?.subscription?.label, 'SuperGrok');
  const count = () => fake.calls.filter((request) => request.action === 'usage').length;
  const before = count();
  f.tick(599_999);
  await f.agents.poll();
  assert.equal(count(), before);
  f.tick(1);
  await f.agents.poll();
  assert.equal(count(), before + 1);
  await f.agents.readUsage('grok-bot');
  assert.equal(count(), before + 2);
  f.agents.update('grok-bot', { usageSource: 'cursor-editor' });
  await f.agents.readUsage('grok-bot');
  assert.equal(editorReads, 1);
  await f.restart();
  assert.equal(f.agents.view('grok-bot').usageSource, 'cursor-editor');
  await f.agents.login('grok-bot');
  assert.equal(f.agents.view('grok-bot').usageSource, 'separate');
  await f.restart();
  await f.agents.poll();
  assert.equal(f.agents.view('grok-bot').quota?.subscription?.label, 'SuperGrok');
  assert.equal(editorReads, 1);
  f.agents.update('grok-bot', { usageEnabled: false });
  const stopped = count();
  f.tick(600_000);
  await f.agents.poll();
  assert.equal(count(), stopped);
  assert.doesNotMatch(readFileSync(f.agents.config.file, 'utf8'), /SYNTHETIC_TOKEN/);
});

test('Grok usage account: matches only the confirmed account, differs for another, stays unverified without an identity, and a source change drops the confirmation', async (t) => {
  // Two synthetic Cursor logins; their ids and tokens must never leave the server.
  const accounts = {
    a: { userId: 'user_SYNTHETIC_A', token: 'SYNTHETIC_TOKEN_A' },
    b: { userId: 'user_SYNTHETIC_B', token: 'SYNTHETIC_TOKEN_B' },
  };
  let signedIn: keyof typeof accounts | undefined = 'a';
  const grokUsage = {
    session: async () => (signedIn ? accounts[signedIn] : undefined),
    fetch: async () => Response.json({ usagePercent: 20, grokPlanLabel: 'SuperGrok' }),
  };
  const fake = fakeBridge((request) =>
    request.action === 'usage'
      ? {
          ok: true,
          quota: {
            status: 'known',
            source: '独立登录 · Grok Bot 用量',
            observedAt: '2026-10-11T08:00:00Z',
            windows: [{ id: 'grok-bot', label: 'SuperGrok', usedPercent: 9, resetsAt: null }],
          },
        }
      : { ok: true },
  );
  const f = fixture(t, { bridge: fake.bridge, grokUsage });
  const account = () => f.agents.view('grok-bot').usageAccount;
  const app = express();
  app.use(express.json());
  externalAgentRoutes(app, f.agents);
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const confirm = async (fingerprint: string) =>
    (
      await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/external-agents/grok-bot`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usageAccountConfirmed: fingerprint }),
      })
    ).status;

  assert.equal(account(), undefined, 'no reading yet, nothing to verify');
  await f.agents.login('grok-bot');
  assert.deepEqual(account(), { status: 'unverified' }, 'the separate login reports no comparable identity');
  assert.throws(() => f.agents.update('grok-bot', { usageAccountConfirmed: '0'.repeat(64) }), /用量账号已变化/);

  f.agents.update('grok-bot', { usageSource: 'cursor-editor' });
  await f.agents.readUsage('grok-bot');
  const a = account()!;
  assert.equal(a.status, 'unverified');
  assert.match(a.fingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.equal(await confirm(a.fingerprint!), 200);
  assert.deepEqual(account(), { status: 'matches', fingerprint: a.fingerprint });
  await f.restart({ bridge: fake.bridge, grokUsage });
  await f.agents.readUsage('grok-bot');
  assert.equal(account()?.status, 'matches', 'the confirmation survives a restart');

  signedIn = 'b';
  await f.agents.readUsage('grok-bot');
  const b = account()!;
  assert.equal(b.status, 'different');
  assert.notEqual(b.fingerprint, a.fingerprint);
  assert.throws(() => f.agents.update('grok-bot', { usageAccountConfirmed: a.fingerprint }), /用量账号已变化/);
  assert.throws(
    () => f.agents.update('grok-bot', { usageSource: 'separate', usageAccountConfirmed: b.fingerprint }),
    /用量账号已变化/,
  );
  assert.equal(f.agents.view('grok-bot').usageSource, 'cursor-editor', 'a refused patch changes nothing');
  signedIn = undefined;
  await f.agents.readUsage('grok-bot');
  assert.equal(account(), undefined, 'a failed read is not attributed to any account');
  signedIn = 'a';
  await f.agents.readUsage('grok-bot');
  assert.equal(account()?.status, 'matches');

  f.agents.update('grok-bot', { usageSource: 'separate' });
  await f.agents.readUsage('grok-bot');
  assert.deepEqual(account(), { status: 'unverified' }, 'the editor account is not carried over to this reading');
  f.agents.update('grok-bot', { usageSource: 'cursor-editor' });
  await f.agents.readUsage('grok-bot');
  assert.deepEqual(
    account(),
    { status: 'unverified', fingerprint: a.fingerprint },
    'switching back does not revive it',
  );

  f.agents.update('grok-bot', { usageAccountConfirmed: a.fingerprint });
  await f.agents.login('grok-bot');
  assert.equal(f.agents.config.agent('grok-bot').usageAccountConfirmed, undefined, 'login switches the source too');

  const exposed = JSON.stringify(f.agents.list()) + readFileSync(f.agents.config.file, 'utf8');
  assert.doesNotMatch(exposed, /SYNTHETIC_(?:A|B|TOKEN)/);
});

test('login enables Grok usage and immediately reads; later navigation results bypass the ten-minute failure cooldown', async (t) => {
  let successful = false;
  const signatures = [
    {
      method: 'GET' as const,
      origin: 'https://fixture.test',
      path: '/usage',
      windows: [{ id: 'grok-bot', label: 'SuperGrok', percent: { path: ['used_percent'], scale: 1 } }],
      balances: [],
    },
  ];
  const quota = {
    status: 'known' as const,
    windows: [{ id: 'grok-bot', label: 'SuperGrok', usedPercent: 7, resetsAt: null }],
    observedAt: '2026-10-12T00:00:00Z',
    source: '独立登录',
  };
  const fake = fakeBridge((request) =>
    request.action === 'open'
      ? { ok: true }
      : successful
        ? {
            ok: true,
            quota,
            signatures,
            grokDiagnostic: { code: 'success', step: 'parse', path: '/dashboard/spending', status: 200 },
          }
        : { ok: false, grokDiagnostic: { code: 'no-data', step: 'parse', path: '/dashboard/spending' } },
  );
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('grok-bot', { usageEnabled: false });
  let broadcasts = 0;
  t.mock.method(f.controller, 'broadcast', () => {
    broadcasts++;
  });
  await f.agents.login('grok-bot');
  assert.equal(f.agents.view('grok-bot').usageEnabled, true);
  assert.equal(fake.calls.filter((call) => call.action === 'usage').length, 1);
  assert.equal(f.agents.view('grok-bot').grokDiagnostic?.code, 'no-data');
  successful = true;
  await f.agents.poll();
  assert.equal(f.agents.view('grok-bot').quota?.windows[0]?.usedPercent, 7);
  assert.equal(f.agents.view('grok-bot').grokDiagnostic?.code, 'success');
  assert.equal(f.agents.config.agent('grok-bot').grokDiagnostic?.code, 'success');
  assert.deepEqual(f.agents.config.agent('grok-bot').usageSignatures, signatures);
  assert.ok(broadcasts > 1);
  const before = broadcasts;
  const writes = t.mock.method(f.agents.config, 'update');
  await f.agents.readUsage('grok-bot');
  assert.equal(writes.mock.callCount(), 0, 'identical diagnostics and signatures do not rewrite config');
  assert.equal(broadcasts, before, 'identical successful readings do not broadcast');
  quota.windows[0]!.usedPercent = 8;
  await f.agents.readUsage('grok-bot');
  assert.equal(writes.mock.callCount(), 0, 'quota-only changes do not rewrite config');
  assert.equal(broadcasts, before + 1);
  assert.equal(f.agents.view('grok-bot').quota?.windows[0]?.usedPercent, 8);
});

for (const code of ['human-check', 'login'] as const)
  test(`Grok ${code} waits ten minutes, keeps unknown freshness null and skips unchanged writes and broadcasts`, async (t) => {
    const fake = fakeBridge((request) =>
      request.action === 'open'
        ? { ok: true }
        : { ok: false, code, grokDiagnostic: { code, step: code, path: '/dashboard/spending' } },
    );
    const f = fixture(t, { bridge: fake.bridge });
    f.controller.targets = [];
    await f.agents.login('grok-bot');
    assert.equal(f.agents.view('grok-bot').quota?.observedAt, null);
    assert.equal(f.agents.view('grok-bot').grokDiagnostic?.step, code);
    const writes = t.mock.method(ExternalAgentConfig.prototype, 'update');
    const broadcasts = t.mock.method(f.controller, 'broadcast', () => {});
    const reads = () => fake.calls.filter((call) => call.action === 'usage').length;
    assert.equal(reads(), 1);
    for (const elapsed of [5_000, 594_999]) {
      f.tick(elapsed);
      await f.agents.poll();
      assert.equal(reads(), 1);
    }
    f.tick(1);
    await f.agents.poll();
    assert.equal(reads(), 2);
    await f.agents.readUsage('grok-bot');
    assert.equal(reads(), 3, 'manual refresh bypasses the automatic interval');
    assert.equal(f.agents.view('grok-bot').quota?.observedAt, null);
    assert.equal(writes.mock.calls.filter((call) => call.arguments[0] === 'grok-bot').length, 0);
    assert.equal(broadcasts.mock.callCount(), 0);
  });

for (const retiredId of ['dot', 'codex-cloud'])
  test(`retired ${retiredId} settings and queued messages survive restart without dispatch or retry`, async (t) => {
    const f = fixture(t);
    const conversation = await f.workspace.createGeneralConversation();
    const message = f.workspace.store.addMessage(conversation.id, 'assistant', 'OLD_DOT_CONTENT');
    message.externalAgent = {
      agentId: retiredId,
      name: retiredId,
      status: 'queued',
      request: 'old request',
      handoff: true,
      updatedAt: message.createdAt,
    } as unknown as NonNullable<ConversationMessage['externalAgent']>;
    f.workspace.store.save('message', message.id, conversation.id, message);
    writeFileSync(
      join(f.directory, 'data', 'external-agents.json'),
      JSON.stringify({
        version: 1,
        agents: {
          'codex-cloud': { enabled: true, environment: 'old-environment' },
          muse: { enabled: false },
          dot: { enabled: true },
          unknown: { enabled: 'obsolete-invalid-value' },
        },
      }),
    );
    await f.restart();
    assert.equal(
      f.agents.list().some((agent) => String(agent.id) === retiredId),
      false,
    );
    assert.equal(f.agents.view('muse').enabled, false, 'unknown entries cannot invalidate known settings');
    assert.equal(
      f.agents.list().some((agent) => String(agent.id) === 'codex-cloud'),
      false,
    );
    assert.equal(f.message(message.id).content, 'OLD_DOT_CONTENT');
    assert.throws(() => f.agents.retry(message.id), /智能体已移除/);
    await assert.rejects(f.agents.handoff(message.id), /智能体已移除/);
  });

test('Codex Cloud is absent from the catalog and API, and its apply and refresh routes are gone', async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.agents.list().map((agent) => agent.id),
    ['grok-bot', 'muse'],
  );
  assert.equal(f.agents.find('Codex 云端'), undefined);
  const token = 'synthetic-retirement-session';
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-agent-token'] !== token) {
      res.status(403).json({ error: 'Local session token required' });
      return;
    }
    next();
  });
  externalAgentRoutes(app, f.agents);
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const listed = (await (await fetch(`http://127.0.0.1:${port}/api/external-agents`)).json()) as {
    agents: { id: string }[];
  };
  assert.deepEqual(
    listed.agents.map((agent) => agent.id),
    ['grok-bot', 'muse'],
  );
  for (const action of ['apply', 'refresh']) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/external-agents/messages/6f9619ff-8b86-4d11-b42d-00c04fc964ff/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': token },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    assert.equal(response.status, 404, action);
  }
});

test('malformed or schema-invalid settings files are preserved instead of being silently overwritten', async (t) => {
  const f = fixture(t);
  const dataDir = join(f.directory, 'data');
  mkdirSync(dataDir, { recursive: true });
  const configFile = join(dataDir, 'external-agents.json');
  const selectorsFile = join(dataDir, 'web-agent-selectors.json');

  for (const invalidConfig of ['{ broken-json', JSON.stringify({ version: 99, agents: {} })]) {
    writeFileSync(configFile, invalidConfig);
    assert.equal(f.agents.view('muse').enabled, false);
    assert.equal(f.agents.view('muse').available, false);
    assert.match(f.agents.view('muse').reason ?? '', /external-agents\.json/);
    assert.throws(() => f.agents.update('muse', { enabled: true, acceptRisk: true }), /external-agents\.json/);
    await f.agents.poll();
    assert.equal(readFileSync(configFile, 'utf8'), invalidConfig);
  }

  const invalidSelectors = '{ broken-selectors';
  writeFileSync(selectorsFile, invalidSelectors);
  assert.equal(typeof f.agents.config.selectors('muse').input, 'string');
  f.agents.config.saveSelectors('muse', { input: '#custom-input' });
  f.agents.config.resetSelectors('muse');
  assert.equal(readFileSync(selectorsFile, 'utf8'), invalidSelectors);
});

test('bound chat lookup excludes private and side chats and releases a failed creation lock', async (t) => {
  const f = fixture(t);
  const create = t.mock.method(f.workspace, 'createGeneralConversation', async () => {
    throw new Error('Synthetic creation failure');
  });
  await assert.rejects(f.workspace.openExternalAgentConversation('muse'), /Synthetic creation failure/);
  create.mock.restore();
  let chat = await f.workspace.openExternalAgentConversation('muse');
  const original = chat.id;
  chat.incognito = true;
  f.workspace.store.save('conversation', chat.id, chat.projectId, chat);
  chat = await f.workspace.openExternalAgentConversation('muse');
  assert.notEqual(chat.id, original);
  const second = chat.id;
  chat.sideChat = { parentConversationId: original } as NonNullable<Conversation['sideChat']>;
  f.workspace.store.save('conversation', chat.id, chat.projectId, chat);
  chat = await f.workspace.openExternalAgentConversation('muse');
  assert.notEqual(chat.id, second);
  assert.equal(chat.incognito, undefined);
  assert.equal(chat.sideChat, undefined);
  await f.restart();
  assert.equal((await f.workspace.openExternalAgentConversation('muse')).id, chat.id);
});

test('explicit external requests reject not-added, disabled and unavailable agents before saving messages', async (t) => {
  const f = fixture(t, { bridge: fakeBridge(() => ({ ok: true })).bridge });
  const chat = await f.workspace.createGeneralConversation();
  for (const unavailable of [
    { added: false, enabled: true, available: true, expected: /尚未添加/ },
    { added: true, enabled: false, available: true, expected: /已关闭/ },
    { added: true, enabled: true, available: false, reason: 'Synthetic offline', expected: /Synthetic offline/ },
  ]) {
    const mock = t.mock.method(f.agents, 'view', () => ({
      id: 'muse' as const,
      name: 'Muse',
      kind: 'web' as const,
      description: '',
      ...unavailable,
    }));
    for (const input of [
      { ...base, content: 'Synthetic message', externalAgentId: 'muse' },
      { ...base, content: '@@Muse synthetic' },
    ])
      assert.throws(() => f.agents.intercept(chat.id, input), unavailable.expected);
    assert.equal(f.workspace.store.allMessages(chat.id).length, 0);
    assert.equal(f.workspace.store.list<Workflow>('workflow', chat.id).length, 0);
    mock.mock.restore();
  }
});
test('fresh web and desktop sends pack history, saved web threads send the bare request', async (t) => {
  const fake = fakeBridge((request) => ({
    ok: true,
    ...(request.action === 'send' ? { reply: 'earlier reply', pageUrl: 'https://muse.ai/chat/synthetic' } : {}),
  }));
  const f = fixture(t, { bridge: fake.bridge });
  f.agents.update('muse', { enabled: true, acceptRisk: true });
  f.agents.update('grok-bot', { enabled: true });
  const conversation = await f.workspace.createGeneralConversation();
  f.workspace.store.addMessage(conversation.id, 'user', 'earlier question');
  f.workspace.store.addMessage(conversation.id, 'assistant', 'earlier answer');
  const first = f.agents.intercept(conversation.id, { ...base, content: 'first', externalAgentId: 'muse' })!;
  await until(() => f.message(first.reply.id).externalAgent?.status === 'done');
  assert.match(fake.calls.find((r) => r.action === 'send')!.text!, /earlier question[\s\S]*earlier answer/);
  const second = f.agents.intercept(conversation.id, { ...base, content: 'second', externalAgentId: 'muse' })!;
  await until(() => f.message(second.reply.id).externalAgent?.status === 'done');
  assert.equal(fake.calls.filter((r) => r.action === 'send').at(-1)!.text, 'second');
  const desktop = f.agents.intercept(conversation.id, { ...base, content: 'desktop', externalAgentId: 'grok-bot' })!;
  await until(() => f.message(desktop.reply.id).externalAgent?.status === 'done');
  assert.match(fake.calls.find((r) => r.action === 'desktop-handoff')!.text!, /earlier question[\s\S]*earlier reply/);
  assert.equal(f.message(desktop.reply.id).externalAgent?.request, 'desktop');
});
