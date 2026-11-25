import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { GrokRoutineStore, grokReplyHash } from '../src/server/external-agents/grok-routine.ts';
import { ExternalAgents, type ExternalAgentsOptions } from '../src/server/external-agents/service.ts';
import { externalAgentRoutes } from '../src/server/external-agents/routes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { canImportReply, grokBotHandoffNote } from '../src/shared/external-agents.ts';
import type { WebAgentRequest, WebAgentResult } from '../src/shared/web-bridge.ts';
import type { ConversationMessage, MessageInput, Workflow } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

// pugport/pugport#10 and #11: a Grok Bot answer PugPort never received is pasted back into its own message, once.
// Synthetic only: a fake webhook and a fake desktop bridge; no Grok Bot account or provider is contacted.

const url = 'https://api2.cursor.sh/automations/webhook/synthetic-id';
const key = 'crsr_SYNTHETIC_SECRET_1234';
const input: MessageInput = {
  content: '@@Grok Bot 总结这份合成报告',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
};

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function fixture(
  t: TestContext,
  options: { routine?: boolean; fetch?: typeof fetch; bridge?: (request: WebAgentRequest) => Promise<WebAgentResult> },
) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'external-reply-import-')));
  const db = new DatabaseSync(':memory:');
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
  if (options.routine) await routineStore.save(url, key);
  const bridgeCalls: WebAgentRequest[] = [];
  const agents = new ExternalAgents(workspace, dir, {
    autoPoll: false,
    routineStore,
    routineDesktop: { isRunning: async () => true },
    routinePost: { fetch: options.fetch ?? (async () => assert.fail('no routine is configured')) },
    bridge: {
      available: () => true,
      request: async (request) => {
        bridgeCalls.push(request);
        return options.bridge ? options.bridge(request) : { ok: true };
      },
    },
  } satisfies ExternalAgentsOptions);
  agents.update('grok-bot', { enabled: true, usageEnabled: false });
  t.after(() => {
    agents.close();
    db.close();
    assert.equal(dirname(dir), realpathSync.native(tmpdir()));
    assert.ok(basename(dir).startsWith('external-reply-import-'));
    rmSync(dir, { recursive: true, force: true });
  });
  const message = (id: string) => store.get<ConversationMessage>('message', id)!;
  return { agents, store, bridgeCalls, message, agent: (id: string) => message(id).externalAgent! };
}

/** A webhook that records every run it starts and answers with the given outcome. */
function webhook(outcome: () => Promise<Response>) {
  const runs: { message: string; replyId: string }[] = [];
  const fetch = (async (_target: unknown, init?: RequestInit) => {
    runs.push(JSON.parse(String(init?.body)));
    return outcome();
  }) as typeof globalThis.fetch;
  return { runs, fetch };
}

test('#10 an uncertain routine delivery takes the pasted answer once, and the routine never runs again', async (t) => {
  const hook = webhook(async () => {
    throw new TypeError('synthetic network timeout');
  });
  const f = await fixture(t, { routine: true, fetch: hook.fetch });
  const sent = f.agents.intercept('conversation', input)!;
  await until(() => f.agent(sent.reply.id).status === 'needs-user');
  assert.match(f.agent(sent.reply.id).note!, /没能确认例程是否启动/);
  assert.equal(canImportReply(f.agent(sent.reply.id)), true);
  // Getting the answer never means sending the task again.
  assert.throws(() => f.agents.retry(sent.reply.id), /例程已尝试发送/);

  f.agents.importReply(sent.reply.id, '  合成答案\r\n第二行  ');
  const answered = f.message(sent.reply.id);
  assert.equal(answered.content, '合成答案\n第二行');
  assert.equal(answered.externalAgent?.status, 'done');
  assert.equal(answered.externalAgent?.untrusted, true, 'a pasted Grok Bot answer stays third-party words');
  assert.ok(answered.externalAgent?.importedAt);
  assert.equal(answered.externalAgent?.note, undefined);
  assert.equal(canImportReply(answered.externalAgent!), false);

  // Repeated import, and a callback for the same run arriving afterwards, leave the first answer alone.
  assert.throws(() => f.agents.importReply(sent.reply.id, '第二次粘贴'), /已经有回复/);
  assert.equal(f.agents.receiveGrokReply(hook.runs[0]!.replyId, '迟到的回调'), 200);
  assert.equal(f.message(sent.reply.id).content, '合成答案\n第二行');
  assert.throws(() => f.agents.retry(sent.reply.id));
  assert.equal(hook.runs.length, 1, 'the routine ran exactly once');
});

test('#10 two similar outstanding routine tasks: each answer reaches only its own run', async (t) => {
  const hook = webhook(async () => Response.json({ success: true }));
  const f = await fixture(t, { routine: true, fetch: hook.fetch });
  const first = f.agents.intercept('conversation', input)!;
  await until(() => hook.runs.length === 1);
  const second = f.agents.intercept('conversation', input)!;
  await until(() => hook.runs.length === 2);
  assert.equal(hook.runs[0]!.message.endsWith('总结这份合成报告'), true);
  assert.equal(hook.runs[1]!.message.endsWith('总结这份合成报告'), true);
  assert.notEqual(hook.runs[0]!.replyId, hook.runs[1]!.replyId);
  for (const sent of [first, second]) assert.equal(canImportReply(f.agent(sent.reply.id)), true);

  f.agents.importReply(second.reply.id, '第二条的答案');
  assert.equal(f.message(second.reply.id).content, '第二条的答案');
  assert.equal(f.agent(first.reply.id).status, 'working', 'the other task keeps waiting');
  assert.equal(f.message(first.reply.id).content, f.agent(first.reply.id).note);

  // The second run's own callback cannot replace the pasted answer; the first run's lands only in the first message.
  assert.equal(f.agents.receiveGrokReply(hook.runs[1]!.replyId, '第二条的回调'), 200);
  assert.equal(f.agents.receiveGrokReply(hook.runs[0]!.replyId, '第一条的回调'), 200);
  assert.equal(f.message(first.reply.id).content, '第一条的回调');
  assert.equal(f.message(second.reply.id).content, '第二条的答案');
  assert.equal(f.agent(first.reply.id).importedAt, undefined);
  // A run that has its callback answer takes no paste.
  assert.throws(() => f.agents.importReply(first.reply.id, '粘贴'), /已经有回复/);
  assert.equal(hook.runs.length, 2);
});

test('#10 an answer pasted while the webhook is still responding is not overwritten by the response', async (t) => {
  let respond!: () => void;
  const responded = new Promise<void>((resolve) => {
    respond = resolve;
  });
  const hook = webhook(async () => {
    await responded;
    return Response.json({ success: true, runUuid: '12345678-1234-1234-1234-123456789abc' });
  });
  const f = await fixture(t, { routine: true, fetch: hook.fetch });
  const sent = f.agents.intercept('conversation', input)!;
  await until(() => hook.runs.length === 1);
  f.agents.importReply(sent.reply.id, '先粘贴的答案');
  respond();
  // The webhook response is recorded (its run id) without touching the pasted answer.
  await until(() => !!f.agent(sent.reply.id).routine?.runUuid);
  assert.equal(f.agent(sent.reply.id).status, 'done');
  assert.equal(f.agent(sent.reply.id).note, undefined);
  assert.equal(f.message(sent.reply.id).content, '先粘贴的答案');
});

test('#10 a coordinated routine part waiting for its callback finishes with the pasted answer', async (t) => {
  const hook = webhook(async () => Response.json({ success: true }));
  const f = await fixture(t, { routine: true, fetch: hook.fetch });
  const workflow = {
    id: 'workflow',
    conversationId: 'conversation',
    delegation: { agent: { externalAgentId: 'grok-bot' } },
    input: { content: '只做这一部分' },
  } as Workflow;
  const finished = f.agents.run(workflow, new AbortController().signal, () => {});
  await until(() => hook.runs.length === 1);
  const part = f.store.messages('conversation').find((message) => message.workflowId === 'workflow')!;
  f.agents.importReply(part.id, '这一部分的答案');
  const result = await finished;
  assert.equal(result.ok, true);
  assert.equal(result.messageId, part.id);
  assert.equal(f.message(part.id).content, '这一部分的答案');
  assert.equal(hook.runs.length, 1);
});

test('#11 a desktop handoff shows it is awaiting an answer, takes one pasted reply and is never handed off over it', async (t) => {
  const f = await fixture(t, {});
  const sent = f.agents.intercept('conversation', input)!;
  await until(() => f.agent(sent.reply.id).status === 'done');
  const handedOff = f.agent(sent.reply.id);
  assert.equal(f.message(sent.reply.id).content, grokBotHandoffNote);
  assert.equal(handedOff.awaitingReply, true);
  assert.equal(handedOff.untrusted, undefined);
  assert.equal(canImportReply(handedOff), true);
  assert.deepEqual(
    f.bridgeCalls.map((call) => call.action),
    ['desktop-handoff'],
  );

  assert.throws(() => f.agents.importReply(sent.reply.id, ' \n '), /回复是空的/);
  assert.throws(() => f.agents.importReply(sent.reply.id, 'x'.repeat(100_001)), /回复太长/);
  assert.equal(f.agent(sent.reply.id).awaitingReply, true, 'a refused paste changes nothing');
  f.agents.importReply(sent.reply.id, 'Grok Bot 的合成回复');
  const answered = f.agent(sent.reply.id);
  assert.equal(f.message(sent.reply.id).content, 'Grok Bot 的合成回复');
  assert.equal(answered.status, 'done');
  assert.equal(answered.untrusted, true);
  assert.equal(answered.awaitingReply, undefined);
  assert.ok(answered.importedAt);

  assert.throws(() => f.agents.importReply(sent.reply.id, '再贴一次'), /已经有回复/);
  await assert.rejects(f.agents.handoff(sent.reply.id), /已经有回复/);
  assert.throws(() => f.agents.retry(sent.reply.id));
  assert.equal(f.message(sent.reply.id).content, 'Grok Bot 的合成回复');
  assert.equal(f.bridgeCalls.length, 1);
});

test('#11 a cancelled or failed handoff is not awaiting an answer and stays actionable', async (t) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let launch: WebAgentResult = { ok: true };
  let calls = 0;
  const f = await fixture(t, {
    bridge: async () => {
      if (++calls === 1) await paused;
      return launch;
    },
  });
  // A coordinated part queued behind a handoff in progress is stopped before it goes out.
  const busy = f.agents.intercept('conversation', input)!;
  await until(() => calls === 1);
  const stop = new AbortController();
  const workflow = {
    id: 'workflow',
    conversationId: 'conversation',
    delegation: { agent: { externalAgentId: 'grok-bot' } },
    input: { content: '停掉的这一部分' },
  } as Workflow;
  const stopped = f.agents.run(workflow, stop.signal, () => {});
  const part = f.store.messages('conversation').find((message) => message.workflowId === 'workflow')!;
  stop.abort();
  await assert.rejects(stopped);
  assert.equal(f.agent(part.id).status, 'failed');
  assert.match(f.agent(part.id).note!, /已停止/);
  assert.equal(canImportReply(f.agent(part.id)), false);
  assert.throws(() => f.agents.importReply(part.id, '不该附上'), /没有在等回复/);

  // While the first handoff is still opening Grok Bot, nothing can be pasted into it either.
  assert.equal(f.agent(busy.reply.id).status, 'working');
  assert.throws(() => f.agents.importReply(busy.reply.id, '太早'), /没有在等回复/);
  launch = { ok: false, code: 'error', message: 'synthetic launch failure' };
  release();
  await until(() => f.agent(busy.reply.id).status === 'failed');
  assert.equal(f.agent(busy.reply.id).handoff, true, 'a failed launch offers 「交给它」 again');
  assert.equal(canImportReply(f.agent(busy.reply.id)), false);
  assert.throws(() => f.agents.importReply(busy.reply.id, '不该附上'), /没有在等回复/);
  assert.equal(f.message(part.id).content, 'Grok Bot 这次没有回复。');

  // Trying again after either one hands off normally, and only then waits for a pasted answer.
  launch = { ok: true };
  f.agents.retry(busy.reply.id);
  f.agents.retry(part.id);
  await until(() => f.agent(busy.reply.id).status === 'done' && f.agent(part.id).status === 'done');
  for (const id of [busy.reply.id, part.id]) assert.equal(canImportReply(f.agent(id)), true);
  assert.equal(
    f.bridgeCalls.filter((call) => call.action === 'desktop-handoff').length,
    3,
    'the stopped part was never handed off',
  );
});

test('#10 #11 the import route validates its body and answers a repeat with the reason', async (t) => {
  const f = await fixture(t, {});
  const sent = f.agents.intercept('conversation', input)!;
  await until(() => f.agent(sent.reply.id).status === 'done');
  const app = express();
  app.use(express.json());
  externalAgentRoutes(app, f.agents);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error instanceof z.ZodError ? 'invalid' : (error as Error).message });
  });
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const post = (id: string, body: unknown) =>
    fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/external-agents/messages/${id}/import-reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  assert.equal((await post('not-a-message', { text: 'x' })).status, 400);
  assert.equal((await post(sent.reply.id, { text: 'x', replyId: 'a'.repeat(32) })).status, 400);
  assert.equal((await post(sent.reply.id, { text: 42 })).status, 400);
  assert.equal(f.agent(sent.reply.id).awaitingReply, true);
  const accepted = await post(sent.reply.id, { text: '经路由附上的回复' });
  assert.deepEqual(await accepted.json(), { ok: true });
  const repeated = await post(sent.reply.id, { text: '第二次' });
  assert.equal(repeated.status, 400);
  assert.deepEqual(await repeated.json(), { error: '这条已经有回复了。' });
  assert.equal(f.message(sent.reply.id).content, '经路由附上的回复');
});

test('only Grok Bot messages that reached it and have no answer take a pasted reply', () => {
  const base = { agentId: 'grok-bot' as const, name: 'Grok Bot', request: 'x', updatedAt: 'x' };
  const routine = { replyHash: grokReplyHash('a'.repeat(32)), sentAt: '2026-11-21T00:00:00Z' };
  assert.equal(canImportReply({ ...base, status: 'working', routine }), true);
  assert.equal(canImportReply({ ...base, status: 'needs-user', routine }), true);
  assert.equal(canImportReply({ ...base, status: 'working', routine: { ...routine, replied: true } }), false);
  assert.equal(canImportReply({ ...base, status: 'needs-user', routine, importedAt: 'x' }), false);
  assert.equal(canImportReply({ ...base, status: 'done', awaitingReply: true }), true);
  // An older handoff recorded before this state existed, a queued one and a failed one: nothing reached Grok Bot.
  for (const status of ['done', 'queued', 'failed'] as const) assert.equal(canImportReply({ ...base, status }), false);
  assert.equal(canImportReply({ ...base, status: 'failed', awaitingReply: true }), false);
  assert.equal(canImportReply({ ...base, agentId: 'muse', name: 'Muse', status: 'done', awaitingReply: true }), false);
});
