import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import {
  GrokRoutineStore,
  grokReplyHash,
  grokRoutineInstructions,
  postGrokRoutine,
  validGrokWebhook,
} from '../src/server/external-agents/grok-routine.ts';
import { ExternalAgents } from '../src/server/external-agents/service.ts';
import { grokDesktopMissingNote, grokDesktopRequiredNote } from '../src/server/external-agents/grok-desktop.ts';
import { secretsDirectory } from '../src/server/api-providers.ts';
import { appDirs } from '../src/server/platform/dirs.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { ConversationMessage, Workflow } from '../src/shared/types.ts';
import { participantsNote, resolveParticipants } from '../src/server/participants.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { mentionItems } from '../src/ui/Mentions.tsx';
import { listenForFetch } from './helpers/fetch-port.ts';
import { fakeHost } from './helpers/fake-host.ts';

const url = 'https://api2.cursor.sh/automations/webhook/synthetic-id';
const key = 'crsr_SYNTHETIC_SECRET_1234';

test('tests never reach the owner real secrets or the real routine webhook', async () => {
  // A saved routine once received real test messages: tests must use a private secrets folder and never send.
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  delete process.env.COMBORUNNER_SECRETS_DIR;
  try {
    assert.equal(process.env.PUGPORT_UNDER_TEST, '1');
    const dir = secretsDirectory();
    assert.ok(dir.startsWith(realpathSync.native(tmpdir()) + sep), dir);
    assert.equal(dir, appDirs().secrets);
    assert.ok(new GrokRoutineStore().view() === undefined);
  } finally {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  }
  const result = await postGrokRoutine({ url, key }, 'never sent', 'b'.repeat(32));
  assert.equal(result.ok, false);
  assert.match(result.note!, /PugPort under test: refused network request/);
});
const replyId = 'a'.repeat(32);
const runUuid = '12345678-1234-1234-1234-123456789abc';
function temporary(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'grok-routine-test-')));
  t.after(() => {
    assert.equal(dirname(dir).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(dir).startsWith('grok-routine-test-'));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
}

test('routine validation, private persistence, masked view and removal', async (t) => {
  const file = join(temporary(t), 'private', 'grok-routine.json');
  const store = new GrokRoutineStore(file);
  for (const bad of [
    'http://api2.cursor.sh/automations/webhook/id',
    'https://evil.test/automations/webhook/id',
    'https://api2.cursor.sh.evil.test/automations/webhook/id',
    'https://api2.cursor.sh:444/automations/webhook/id',
    'https://user:pass@api2.cursor.sh/automations/webhook/id',
    url + '?x=1',
    url + '#x',
    'https://api2.cursor.sh/automations/webhook/',
    'https://api2.cursor.sh/elsewhere/id',
  ]) {
    assert.throws(() => validGrokWebhook(bad));
  }
  await store.save(url, key);
  assert.deepEqual(new GrokRoutineStore(file).view(), { url, keyHint: '…1234' });
  assert.ok(readFileSync(file, 'utf8').includes(key));
  assert.ok(!JSON.stringify(store.view()).includes(key));
  await store.save(url);
  assert.equal(store.read()?.key, key);
  await assert.rejects(store.save(url, 'bad\nkey'));
  await store.save('');
  assert.equal(store.view(), undefined);
});

test('parseable invalid routine settings can be replaced or cleared; malformed JSON stays intact', async (t) => {
  const file = join(temporary(t), 'routine.json');
  const store = new GrokRoutineStore(file);
  for (const value of [{ url: 'https://old.example/webhook/id', key }, { url, key: 'bad' }, {}, null, 42]) {
    writeFileSync(file, JSON.stringify(value));
    assert.equal(store.view(), undefined);
    await store.save(url, key);
    assert.equal(store.read()?.url, url);
    writeFileSync(file, JSON.stringify(value));
    await store.save('');
    assert.equal(store.read(), undefined);
  }
  writeFileSync(file, '{broken');
  assert.throws(() => store.view(), /格式无效/);
  await assert.rejects(store.save(''), /格式无效/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('local fake webhook: shape, status notes, one retry, redirect refusal, timeout and no key leakage', async (t) => {
  let statuses = [200],
    hits = 0,
    delayed = false;
  const requests: { path?: string; auth?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    const status = statuses[Math.min(hits++, statuses.length - 1)]!;
    if (delayed) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(status === 302 ? { location: '/redirect-target' } : {}),
    });
    res.end(JSON.stringify(status === 200 ? { success: true, runUuid } : { error: key }));
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const logs: unknown[] = [];
  for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const)
    t.mock.method(console, name, (...args: unknown[]) => logs.push(args));
  const localFetch: typeof fetch = (target, init) => {
    assert.equal(String(target), url);
    assert.equal(init?.redirect, 'error');
    assert.match(new Headers(init?.headers).get('content-type')!, /application\/json/);
    return fetch(`http://127.0.0.1:${port}${new URL(String(target)).pathname}`, init);
  };
  const send = (timeoutMs = 2_000) =>
    postGrokRoutine({ url, key }, '你好，任务完整到达', replyId, { fetch: localFetch, timeoutMs });
  assert.deepEqual(await send(), { ok: true, runUuid });
  assert.deepEqual(requests[0], {
    path: '/automations/webhook/synthetic-id',
    auth: `Bearer ${key}`,
    body: { message: '你好，任务完整到达', replyId },
  });
  for (const status of [401, 403, 404, 400, 429, 500, 503, 302]) {
    statuses = [status];
    hits = 0;
    const before = requests.length;
    const result = await send();
    assert.equal(result.ok, false);
    assert.equal(hits, status === 429 ? 2 : 1);
    if (status >= 500) assert.equal(requests.length - before, 1);
    assert.equal(
      result.note,
      status === 401 || status === 403
        ? '密钥无效或已过期'
        : status === 404
          ? '这个例程的网址不对'
          : status === 302 || status >= 500
            ? '没能确认例程是否启动，请到 Grok Bot 窗口查看，避免重复计费。'
            : 'Grok Bot 例程启动失败，请稍后查看。',
    );
    assert.ok(!JSON.stringify(result).includes(key));
  }
  statuses = [500, 200];
  hits = 0;
  assert.equal((await send()).ok, false);
  assert.equal(hits, 1);
  statuses = [429, 200];
  hits = 0;
  assert.equal((await send()).ok, true);
  assert.equal(hits, 2);
  delayed = true;
  hits = 0;
  assert.equal((await send(100)).ok, false);
  assert.equal(hits, 1);
  assert.deepEqual(logs, []);
});

test('sent routine survives restart, injectable 30-minute wait settles, late replies append until 24h', async (t) => {
  const dir = temporary(t);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('conversation', 'conversation', 'project', {
    id: 'conversation',
    projectId: 'project',
    title: 'Synthetic',
  });
  store.save('project', 'project', '', { id: 'project', scope: 'project', path: dir });
  const workspace = {
    store,
    controller: { targets: [], broadcast() {} },
    notifyConversationChanged() {},
  } as unknown as Workspace;
  const routineStore = new GrokRoutineStore(join(dir, 'private.json'));
  await routineStore.save(url, key);
  let now = Date.parse('2026-10-14T12:00:00Z');
  let immediateReply = false;
  const bodies: { message: string; replyId: string }[] = [];
  const options = {
    autoPoll: false,
    routineStore,
    routineDesktop: { isRunning: async () => true },
    now: () => now,
    bridge: { available: () => false, request: async () => ({ ok: false as const, code: 'unavailable' as const }) },
    cli: async () => ({ code: 1, stdout: '', stderr: '' }),
    routinePost: {
      fetch: async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (immediateReply) agents.receiveGrokReply(bodies.at(-1)!.replyId, '快速回复');
        return Response.json({ success: true, runUuid });
      },
    },
  };
  let agents = new ExternalAgents(workspace, dir, options);
  t.after(() => agents.close());
  agents.update('grok-bot', { enabled: true, usageEnabled: false });
  const sent = agents.intercept('conversation', {
    content: '@@Grok Bot 你好',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  })!;
  await nextTurn();
  const get = () => store.get<ConversationMessage>('message', sent.reply.id)!;
  assert.equal(sent.message.externalRequest?.thirdParty, true);
  assert.equal(get().externalAgent?.untrusted, true);
  assert.match(bodies[0]!.replyId, /^[a-f0-9]{32}$/);
  assert.deepEqual(bodies[0], { message: '你好', replyId: bodies[0]!.replyId });
  assert.equal(get().externalAgent?.routine?.replyHash, grokReplyHash(bodies[0]!.replyId));
  assert.ok(!JSON.stringify(db.prepare('SELECT value FROM workspace_records').all()).includes(bodies[0]!.replyId));
  assert.ok(!JSON.stringify(db.prepare('SELECT value FROM workspace_records').all()).includes(key));
  agents.close();
  agents = new ExternalAgents(workspace, dir, options);
  assert.equal(get().externalAgent?.status, 'working');
  now += 30 * 60_000 - 1;
  await agents.poll();
  assert.equal(get().externalAgent?.status, 'working');
  now++;
  await agents.poll();
  assert.equal(get().externalAgent?.status, 'needs-user');
  assert.equal(get().externalAgent?.note, 'Grok Bot 还没回，可以到它的窗口看看');
  assert.equal(agents.receiveGrokReply(bodies[0]!.replyId, '中文答案'), 200);
  assert.equal(agents.receiveGrokReply(bodies[0]!.replyId, '追加'), 200);
  assert.equal(get().content, '中文答案\n\n追加');
  assert.equal(agents.receiveGrokReply(bodies[0]!.replyId, 'x'.repeat(100_000)), 413);
  assert.equal(get().content, '中文答案\n\n追加');
  assert.equal(get().externalAgent?.status, 'done');
  now += 24 * 60 * 60_000;
  assert.equal(agents.receiveGrokReply(bodies[0]!.replyId, '过期'), 404);

  const participants = resolveParticipants(
    [
      { kind: 'external', id: 'grok-bot' },
      { kind: 'executor', id: 'local' },
    ],
    {
      presets: [],
      targets: [
        { id: 'local', label: 'Local', provider: 'codex', enabled: true, environment: 'native', command: 'unused' },
      ],
      externals: agents.list(),
    },
  );
  assert.equal(participants[0]?.thirdParty, true);
  assert.equal(participants[0]?.handoff, undefined);
  const mention = mentionItems([], [], [agents.view('grok-bot')])[0]!;
  assert.equal(mention.name, 'Grok Bot');
  assert.match(mention.description!, /第三方/);
  assert.match(participantsNote(participants), /不附项目文件内容、本机路径/);
  const workflow = {
    id: 'workflow',
    conversationId: 'conversation',
    delegation: { agent: { externalAgentId: 'grok-bot' } },
    input: { content: '只发送这项任务' },
  } as Workflow;
  const finished = agents.run(workflow, new AbortController().signal, () => {});
  await nextTurn();
  assert.ok(bodies[1]!.message.includes(get().content));
  assert.ok(bodies[1]!.message.endsWith(workflow.input.content));
  assert.ok(!JSON.stringify(bodies[1]).includes(dir));
  let settled = false;
  void finished.then(() => {
    settled = true;
  });
  assert.equal(agents.receiveGrokReply(bodies[1]!.replyId, '第一段\r\n下一行', true), 200);
  await nextTurn();
  assert.equal(settled, false, 'coordinator waits for final part');
  assert.equal(agents.receiveGrokReply(bodies[1]!.replyId, '第一段\n下一行', true), 200);
  const multipart = () =>
    store
      .messages('conversation')
      .find((m) => m.externalAgent?.routine?.replyHash === grokReplyHash(bodies[1]!.replyId))!;
  assert.equal(multipart().content, '第一段\n下一行', 'normalized duplicate is ignored');
  assert.equal(multipart().externalAgent?.status, 'working');
  assert.equal(agents.receiveGrokReply(bodies[1]!.replyId, '最后一段'), 200);
  assert.equal(multipart().content, '第一段\n下一行\n\n最后一段');
  assert.equal(multipart().externalAgent?.status, 'done');
  assert.equal(agents.receiveGrokReply(bodies[1]!.replyId, '重跑的第一段', true), 200);
  assert.equal(multipart().externalAgent?.status, 'done');
  await nextTurn();
  assert.equal(settled, true);
  now += 30 * 60_000;
  await agents.poll();
  assert.equal(multipart().externalAgent?.status, 'done');
  assert.equal((await finished).thirdParty, true);
  assert.equal(agents.receiveGrokReply(bodies[1]!.replyId, '晚到答案'), 200);
  assert.throws(() => agents.retry(sent.reply.id));
  immediateReply = true;
  const fast = agents.intercept('conversation', {
    content: '@@Grok Bot fast',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  })!;
  await nextTurn();
  assert.equal(store.get<ConversationMessage>('message', fast.reply.id)?.content, '快速回复');
  assert.equal(store.get<ConversationMessage>('message', fast.reply.id)?.externalAgent?.status, 'done');
});

for (const scenario of [
  'running',
  'starts',
  'start fails',
  'never appears',
  'check fails',
  'non-Windows',
  'main starts',
  'main fails',
  'main missing',
  'main unavailable',
  'mac running',
  'mac starts',
] as const) {
  test(`routine desktop preflight: ${scenario}`, async (t) => {
    const dir = temporary(t);
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    store.save('conversation', 'conversation', 'project', {
      id: 'conversation',
      projectId: 'project',
      title: 'Synthetic',
    });
    const routineStore = new GrokRoutineStore(join(dir, 'private.json'));
    await routineStore.save(url, key);
    let clock = 0;
    let started = false;
    const events: string[] = [];
    const isRunning = async () => {
      events.push('check');
      if (scenario === 'check fails') throw new Error('synthetic process check failure');
      return scenario.endsWith('running') || (scenario.endsWith('starts') && started && clock >= 2000);
    };
    // A Mac answers through LaunchServices' list of running apps.
    const mac = fakeHost('darwin', {
      run: async (file) => {
        assert.equal(file, '/usr/bin/lsappinfo');
        return { stdout: (await isRunning()) ? 'ASN:0x0-0x1-"Grok Bot":\n' : '', stderr: '' };
      },
    });
    const agents = new ExternalAgents(
      {
        store,
        controller: { targets: [], broadcast() {} },
        notifyConversationChanged() {},
      } as unknown as Workspace,
      dir,
      {
        autoPoll: false,
        routineStore,
        routineDesktop: {
          ...(scenario.startsWith('mac ')
            ? { host: mac }
            : { platform: scenario === 'non-Windows' ? 'linux' : 'win32', isRunning }),
          ...(!scenario.startsWith('main ') &&
            !scenario.startsWith('mac ') && {
              start: async () => {
                events.push('start');
                if (scenario === 'start fails') throw new Error('synthetic launch failure');
                started = true;
              },
            }),
          now: () => clock,
          sleep: async (ms) => {
            events.push(`wait:${ms}`);
            clock += ms;
          },
        },
        routinePost: {
          fetch: async () => {
            events.push('post');
            return Response.json({ success: true });
          },
        },
        bridge: {
          available: () => true,
          request: async (request, timeout) => {
            assert.equal(request.action, 'desktop-start-minimized');
            assert.equal(request.agentId, 'grok-bot');
            assert.equal(timeout, 10_000);
            events.push('start');
            started = true;
            if (scenario === 'main missing') return { ok: false, code: 'not-installed' };
            if (scenario === 'main unavailable') return { ok: false, code: 'unavailable' };
            return { ok: scenario !== 'main fails' };
          },
        },
      },
    );
    t.after(() => agents.close());
    agents.update('grok-bot', { enabled: true, usageEnabled: false });
    const sent = agents.intercept('conversation', {
      content: '@@Grok Bot synthetic',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
    })!;
    await nextTurn();
    const message = store.get<ConversationMessage>('message', sent.reply.id)!;
    if (
      ['start fails', 'never appears', 'check fails', 'main fails', 'main missing', 'main unavailable'].includes(
        scenario,
      )
    ) {
      // Only a start that main reports as a missing app names it; every other failure keeps the usual note.
      const note = scenario === 'main missing' ? grokDesktopMissingNote : grokDesktopRequiredNote;
      assert.equal(events.includes('post'), false);
      assert.equal(message.externalAgent?.status, 'needs-user');
      assert.equal(message.externalAgent?.note, note);
      assert.equal(message.content, note);
      assert.equal(message.externalAgent?.routine, undefined);
      if (scenario === 'never appears') assert.equal(clock, 20_000);
    } else {
      assert.equal(message.externalAgent?.status, 'working');
      if (scenario.endsWith('running')) assert.deepEqual(events, ['check', 'post']);
      if (scenario === 'non-Windows') assert.deepEqual(events, ['post']);
      if (scenario.endsWith('starts')) {
        assert.deepEqual(events, [
          'check',
          'start',
          'check',
          'wait:1000',
          'check',
          'wait:1000',
          'check',
          'wait:5000',
          'check',
          'post',
        ]);
        assert.equal(clock, 7000);
      }
    }
  });
}

for (const ready of [true, false]) {
  test(`stop during desktop preflight settles as failed without posting (ready=${ready})`, async (t) => {
    const dir = temporary(t);
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    store.save('conversation', 'conversation', 'project', { id: 'conversation', projectId: 'project' });
    const routineStore = new GrokRoutineStore(join(dir, 'private.json'));
    await routineStore.save(url, key);
    let release!: (value: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const agents = new ExternalAgents(
      {
        store,
        controller: { targets: [], broadcast() {} },
        notifyConversationChanged() {},
      } as unknown as Workspace,
      dir,
      {
        autoPoll: false,
        routineStore,
        routineDesktop: {
          platform: 'win32',
          isRunning: async () => {
            checks++;
            return waiting;
          },
          start: async () => {
            assert.fail('stopped routine must never start Grok Bot');
          },
        },
        routinePost: { fetch: async () => assert.fail('stopped routine must never post') },
      },
    );
    t.after(() => agents.close());
    agents.update('grok-bot', { enabled: true, usageEnabled: false });
    const controller = new AbortController();
    const finished = agents.run(
      {
        id: 'synthetic-stop',
        conversationId: 'conversation',
        delegation: { agent: { externalAgentId: 'grok-bot' } },
        input: { content: 'Synthetic' },
      } as Workflow,
      controller.signal,
      () => {},
    );
    const rejected = assert.rejects(finished, /Synthetic stop/);
    await nextTurn();
    assert.equal(checks, 1);
    const message = store.messages('conversation').find((message) => message.externalAgent)!;
    assert.equal(message.externalAgent?.status, 'queued');
    controller.abort(new Error('Synthetic stop'));
    await rejected;
    release(ready);
    await nextTurn();
    const stopped = store.get<ConversationMessage>('message', message.id)!;
    assert.equal(stopped.externalAgent?.status, 'failed');
    assert.equal(stopped.externalAgent?.note, '已停止，这条没有发出去。');
    assert.equal(stopped.content, 'Grok Bot 这次没有回复。');
    assert.equal(stopped.externalAgent?.routine, undefined);
  });
}

test('a late routine reply replaces needs-user with done and clears the wait note', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const message = store.addMessage('conversation', 'assistant', 'Synthetic waiting message');
  message.externalAgent = {
    agentId: 'grok-bot',
    name: 'Grok Bot',
    request: 'Synthetic',
    status: 'needs-user',
    updatedAt: new Date().toISOString(),
    note: 'Grok Bot 还没回，可以到它的窗口看看',
    routine: { replyHash: grokReplyHash(replyId), sentAt: new Date(Date.now() - 23 * 60 * 60_000).toISOString() },
  };
  store.save('message', message.id, 'conversation', message);
  const dir = temporary(t);
  const agents = new ExternalAgents(
    { store, controller: { targets: [], broadcast() {} } } as unknown as Workspace,
    dir,
    {
      autoPoll: false,
      routineStore: new GrokRoutineStore(join(dir, 'private.json')),
    },
  );
  t.after(() => agents.close());
  assert.equal(store.get<ConversationMessage>('message', message.id)?.externalAgent?.status, 'needs-user');
  assert.equal(agents.receiveGrokReply(replyId, 'Synthetic late reply'), 200);
  const received = store.get<ConversationMessage>('message', message.id)!;
  assert.equal(received.content, 'Synthetic late reply');
  assert.equal(received.externalAgent?.status, 'done');
  assert.equal(received.externalAgent?.note, undefined);
  assert.equal(received.externalAgent?.routine?.replied, true);
});

test('multipart replies deduplicate retried earlier parts, order sequenced parts, allow repeated numbered chunks, and finalize when more flips to false', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const dir = temporary(t);
  const agents = new ExternalAgents(
    { store, controller: { targets: [], broadcast() {} }, notifyConversationChanged() {} } as unknown as Workspace,
    dir,
    {
      autoPoll: false,
      routineStore: new GrokRoutineStore(join(dir, 'private.json')),
    },
  );
  t.after(() => agents.close());
  const makeWaiting = (idHex: string) => {
    const message = store.addMessage('conversation', 'assistant', 'waiting');
    message.externalAgent = {
      agentId: 'grok-bot',
      name: 'Grok Bot',
      request: 'Synthetic',
      status: 'working',
      updatedAt: new Date().toISOString(),
      routine: { replyHash: grokReplyHash(idHex), sentAt: new Date().toISOString() },
    };
    store.save('message', message.id, 'conversation', message);
    return message.id;
  };

  // 1. Unnumbered: retry of part 1 after part 2 arrived, and finalization when part 2 is resent with more=false
  const id1 = '1'.repeat(32);
  const msg1 = makeWaiting(id1);
  assert.equal(agents.receiveGrokReply(id1, '第一部分', true), 200);
  assert.equal(agents.receiveGrokReply(id1, '第二部分', true), 200);
  assert.equal(agents.receiveGrokReply(id1, '第一部分', true), 200);
  assert.equal(store.get<ConversationMessage>('message', msg1)?.content, '第一部分\n\n第二部分');
  assert.equal(store.get<ConversationMessage>('message', msg1)?.externalAgent?.status, 'working');
  assert.equal(agents.receiveGrokReply(id1, '第二部分', false), 200);
  assert.equal(store.get<ConversationMessage>('message', msg1)?.content, '第一部分\n\n第二部分');
  assert.equal(store.get<ConversationMessage>('message', msg1)?.externalAgent?.status, 'done');

  // 2. Numbered: out-of-order delivery (part 2 with more=false arrives before part 1 with more=true) and retry of part 1
  const id2 = '2'.repeat(32);
  const msg2 = makeWaiting(id2);
  assert.equal(agents.receiveGrokReply(id2, '第二段', false, 2), 200);
  assert.equal(store.get<ConversationMessage>('message', msg2)?.content, '第二段');
  assert.equal(store.get<ConversationMessage>('message', msg2)?.externalAgent?.status, 'working');
  assert.equal(agents.receiveGrokReply(id2, '第一段', true, 1), 200);
  assert.equal(store.get<ConversationMessage>('message', msg2)?.content, '第一段\n\n第二段');
  assert.equal(store.get<ConversationMessage>('message', msg2)?.externalAgent?.status, 'done');
  assert.equal(agents.receiveGrokReply(id2, '第一段', true, 1), 200);
  assert.equal(store.get<ConversationMessage>('message', msg2)?.content, '第一段\n\n第二段');

  // 3. Numbered: legitimate identical adjacent parts and finalization when more flips from true to false
  const id3 = '3'.repeat(32);
  const msg3 = makeWaiting(id3);
  assert.equal(agents.receiveGrokReply(id3, '重复段落', true, 1), 200);
  assert.equal(agents.receiveGrokReply(id3, '重复段落', true, 2), 200);
  assert.equal(store.get<ConversationMessage>('message', msg3)?.content, '重复段落\n\n重复段落');
  assert.equal(store.get<ConversationMessage>('message', msg3)?.externalAgent?.status, 'working');
  assert.equal(agents.receiveGrokReply(id3, '重复段落', false, 2), 200);
  assert.equal(store.get<ConversationMessage>('message', msg3)?.content, '重复段落\n\n重复段落');
  assert.equal(store.get<ConversationMessage>('message', msg3)?.externalAgent?.status, 'done');
});

test('empty routine wait map performs no database scan and invalid settings do not block conversations', async (t) => {
  const dir = temporary(t);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const file = join(dir, 'routine.json');
  writeFileSync(file, JSON.stringify({ url: 'https://old.example/webhook/id', key }));
  const agents = new ExternalAgents({ store, controller: { targets: [] } } as unknown as Workspace, dir, {
    autoPoll: false,
    routineStore: new GrokRoutineStore(file),
    bridge: { available: () => false, request: async () => ({ ok: false as const, code: 'unavailable' as const }) },
  });
  t.after(() => agents.close());
  assert.equal(agents.list().find((agent) => agent.id === 'grok-bot')?.routine, undefined);
  assert.equal(agents.intercept('unused', { content: 'ordinary conversation' } as never), undefined);
  const prepare = t.mock.method(db, 'prepare', () => assert.fail('empty wait map must not query messages'));
  (agents as unknown as { pollRoutineReplies(): void }).pollRoutineReplies();
  assert.equal(prepare.mock.callCount(), 0);
});

test('adding a routine while handoffs are queued never converts those messages to cloud calls', async (t) => {
  const dir = temporary(t);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('conversation', 'conversation', 'project', {
    id: 'conversation',
    projectId: 'project',
    title: 'Synthetic',
  });
  const workspace = {
    store,
    controller: { targets: [], broadcast() {} },
    notifyConversationChanged() {},
  } as unknown as Workspace;
  const routineStore = new GrokRoutineStore(join(dir, 'private.json'));
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const agents = new ExternalAgents(workspace, dir, {
    autoPoll: false,
    routineStore,
    bridge: {
      available: () => true,
      request: async () => {
        calls++;
        await paused;
        return { ok: true };
      },
    },
    routinePost: {
      fetch: async () => {
        assert.fail('a queued handoff must never call the webhook');
      },
    },
  });
  t.after(() => agents.close());
  agents.update('grok-bot', { enabled: true, usageEnabled: false });
  const input = {
    content: '@@Grok Bot synthetic',
    mode: 'chat' as const,
    permissionMode: 'read-only' as const,
    executionPolicy: 'cli-first' as const,
  };
  agents.intercept('conversation', input);
  const queued = agents.intercept('conversation', input)!;
  await routineStore.save(url, key);
  release();
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(store.get<ConversationMessage>('message', queued.reply.id)?.externalAgent?.status, 'done');
  assert.equal(store.get<ConversationMessage>('message', queued.reply.id)?.externalAgent?.routine, undefined);
});

test('instructions preserve the exact PowerShell command and real port; UI clears saved key and copies safely', async () => {
  const text = grokRoutineInstructions(54321, 'win32');
  assert.ok(!text.includes('Yutong'));
  assert.match(text, /超过约 8000 字符时，在段落边界分成/);
  assert.ok(text.includes("\n'@}"));
  assert.ok(text.includes("回答里如有一行以 '@ 开头，在它前面加一个空格"));
  assert.match(text, /8000[\s\S]*more=\$true/);
  assert.ok(
    text.includes(
      "$b=[Text.Encoding]::UTF8.GetBytes((@{replyId='<replyId>';text=@'\n<final answer>\n'@} | ConvertTo-Json -Compress)); Invoke-RestMethod -Method Post -Uri \"http://127.0.0.1:$pugportPort/api/external/grok-bot/replies\" -ContentType 'application/json; charset=utf-8' -Body $b",
    ),
  );
  assert.ok(!text.includes(key));
  const copies: string[] = [],
    calls: unknown[] = [];
  const harness = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'), {
    navigator: { clipboard: { writeText: async (value: string) => copies.push(value) } },
  });
  let agent = { id: 'grok-bot', routine: { url, keyHint: '…1234' } };
  const props = {
    agent,
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return path.endsWith('routine-instructions') ? { text } : { agents: [agent] };
    },
    onSaved() {},
  };
  const render = () => harness.render('GrokRoutineControls', props);
  const input = () => findNode(render(), (n) => n.props['aria-label'] === '例程密钥')!;
  assert.equal(input().props.type, 'password');
  assert.equal(input().props.placeholder, '…1234');
  input().props.onChange({ target: { value: key } });
  findNode(render(), (n) => n.type === 'button' && n.props.children === '保存例程')!.props.onClick();
  await nextTurn();
  assert.equal(input().props.value, '');
  findNode(render(), (n) => n.type === 'button' && n.props.children === '复制例程说明')!.props.onClick();
  await nextTurn();
  assert.deepEqual(copies, [text]);
  assert.ok(!copies[0]!.includes(key));
  assert.equal(calls.length, 2);
});
