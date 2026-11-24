import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { AgentBridge, mediaCompletionHandoff } from '../src/server/agent-bridge.ts';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { MediaAnalysisManager, type MediaAnalysisReport } from '../src/server/media-analysis.ts';
import { createMediaDecoder } from '../src/server/media-decoder.ts';
import { inspectQuitWork } from '../src/server/quit-inspection.ts';
import type { ExecuteContext, Project, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import { idleMachineReading } from './helpers/machine-reading.ts';

const request = (args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'analyze_media', arguments: args },
});
function payload(reply: { status: number; body?: unknown }) {
  assert.equal(reply.status, 200);
  const result = (reply.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  assert.ok(result, JSON.stringify(reply.body));
  return { error: !!result.isError, text: result.content[0]!.text };
}
async function until(condition: () => boolean, reason: string) {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(reason);
}
type InternalBridge = {
  mediaManager?: MediaAnalysisManager;
  mediaProgress: (report: MediaAnalysisReport) => void;
  mediaWait: (workflow: Workflow) => Workflow['waitingOn'];
};

test('tray reports local media work without an Agent and closing a paused job keeps its existing records', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const report = await f.bridge.startMedia(f.conversation.id, { folders: [f.projectPath], engine: 'legacy' });
  await until(gate.entered, 'Synthetic local decoder did not start');
  const active = f.controller.trayState();
  assert.equal(active.running, 0);
  assert.equal(active.localRunning, 1);
  assert.equal(active.localTitle, '本地媒体比对');
  f.bridge.mediaAction(f.conversation.id, report.id, 'pause');
  await gate.manager.wait(report.id);
  const paused = f.bridge.statusMedia(f.conversation.id, report.id);
  assert.equal(f.controller.trayState().localRunning, 0);
  const closed = f.bridge.mediaAction(f.conversation.id, report.id, 'close');
  assert.equal(closed.status, 'cancelled');
  assert.equal(closed.counts.files, paused.counts.files);
  assert.equal(f.bridge.listMedia(f.conversation.id).length, 0);
  assert.equal(f.controller.trayState().localRunning, 0);
  assert.equal(f.bridge.statusMedia(f.conversation.id, report.id).status, 'cancelled');
});

test('background progress carries saved checkpoints separately from the resumed inventory check', async (t) => {
  const f = await fixture(t);
  const report = await f.bridge.startMedia(f.conversation.id, { folders: [f.projectPath], engine: 'legacy' });
  const completed = await f.internal.mediaManager!.wait(report.id);
  const resume = { savedFiles: 12948, savedFingerprints: 2225, checkedFiles: 100, checkingFiles: true };
  f.internal.mediaProgress({
    ...completed,
    status: 'running',
    phase: 'scanning',
    counts: { ...completed.counts, files: resume.savedFiles, fingerprinted: resume.savedFingerprints },
    resume,
    steps: [
      { key: 'scan', label: '核对已保存的文件清单', state: 'running', done: 100, total: null },
      { key: 'coarse', label: '本地指纹预筛', state: 'pending', done: 2225, total: 12948 },
    ],
  });
  const task = f.controller.backgroundTaskSource!().find((entry) => entry.id === report.id)!;
  assert.ok(task);
  assert.deepEqual(task.resume, resume);
  assert.equal(task.detail, '继续比对：核对文件清单');
  assert.equal(task.done, 100, 'current inventory validation must remain separate from saved fingerprint progress');
  assert.equal(task.steps?.[1]?.done, 2225);
  assert.equal(f.controller.trayState().localRunning, 1);
  const inspection = () => inspectQuitWork(f.controller.store.db, [], 0, Date.now(), f.controller.backgroundTasks());
  assert.equal(inspection().active, 1);
  f.internal.mediaProgress({ ...completed, status: 'queued' });
  assert.equal(inspection().active, 1, 'Ready-queued local media also blocks quitting');
  f.internal.mediaProgress({ ...completed, status: 'interrupted' });
  assert.equal(inspection().active, 0);
  f.internal.mediaProgress(completed);
  assert.equal(inspection().active, 0, 'Finished local media does not block quitting');
});

test('startup automatically resumes shutdown media in its original conversation without a new agent run', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const report = await f.bridge.startMedia(f.conversation.id, { folders: [f.projectPath], engine: 'legacy' });
  await until(gate.entered, 'Synthetic local decoder did not start');
  await f.bridge.close();
  const reopened = new AgentBridge(f.workspace, f.controller, f.root);
  try {
    await until(
      () => ['running', 'queued', 'completed'].includes(reopened.statusMedia(f.conversation.id, report.id).status),
      'Saved job did not automatically resume',
    );
    const manager = (reopened as unknown as InternalBridge).mediaManager!;
    const done = await manager.wait(report.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.id, report.id);
    assert.equal(done.owner?.conversationId, f.conversation.id);
    assert.equal(f.calls.length, 0, 'local recovery must never launch a native model');
  } finally {
    await reopened.close();
  }
});

test('startup respects explicit pause and rejects recovery after project scope changes', async (t) => {
  for (const mode of ['pause', 'scope-change'] as const) {
    await t.test(mode, async (child) => {
      const f = await fixture(child);
      const gate = f.installGatedDecoder();
      const report = await f.bridge.startMedia(f.conversation.id, { folders: [f.projectPath], engine: 'legacy' });
      await until(gate.entered, 'Synthetic local decoder did not start');
      if (mode === 'pause') f.bridge.mediaAction(f.conversation.id, report.id, 'pause');
      await f.bridge.close();
      if (mode === 'scope-change') {
        f.workspace.store.save('project', f.project.id, f.project.id, {
          ...f.project,
          path: join(f.root, 'other-scope'),
        });
      }
      const reopened = new AgentBridge(f.workspace, f.controller, f.root);
      try {
        await new Promise((done) => setTimeout(done, 20));
        const saved = (reopened as unknown as InternalBridge).mediaManager!.status(report.id);
        assert.equal(saved.status, 'interrupted', mode);
        assert.equal(saved.recovery?.resumeWanted, false, mode);
        assert.equal(f.calls.length, 0);
      } finally {
        await reopened.close();
      }
    });
  }
});

async function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-media-bridge-')));
  const home = join(root, 'home'),
    projectPath = join(root, 'project');
  mkdirSync(home);
  mkdirSync(projectPath);
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    GROK_HOME: join(home, 'grok'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    COMBORUNNER_MEMORY_DIR: join(root, 'memory'),
    COMBORUNNER_IMAGE_INDEX_DIR: join(root, 'image-index'),
    COMBORUNNER_IMAGE_BACKGROUND: '0',
    PATH: '',
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  const target: RuntimeTarget = {
    id: 'codex-fixture',
    provider: 'codex',
    label: 'Synthetic Codex',
    command: 'never-spawn',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'synthetic-account',
  };
  const data = join(root, 'data');
  const seed = new Store(data);
  seed.setConfig('targets', [target]);
  seed.close();
  const controller = new Controller(root, data, {
    readAccountIdentity: () => 'synthetic-account',
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.targets = [target];
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  const snapshot: RuntimeSnapshot = {
    ...target,
    installed: true,
    status: 'ready',
    accountFingerprint: 'synthetic-account',
    authMode: 'chatgpt',
    models: [{ id: 'fixture', label: 'Fixture', efforts: ['low'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.snapshots = [snapshot];
  t.mock.method(codexAdapter, 'discover', async () => snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  // Admission reads this computer's free memory: below the reserve a start queues by design, so a busy host
  // would hold the synthetic run past every wait below. The fixture describes an idle machine instead.
  t.mock.method(controller, 'machineReading', idleMachineReading);
  const calls: Array<{ ctx: ExecuteContext; finish: () => void; fail: (error: Error) => void }> = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    await new Promise<void>((resolve, reject) => {
      calls.push({ ctx, finish: resolve, fail: reject });
      const cancel = () => reject(new Error('synthetic executor stopped'));
      ctx.signal.addEventListener('abort', cancel, { once: true });
      if (ctx.signal.aborted) cancel();
    });
    return { output: 'Synthetic inspection completed.', nativeSessionId: `synthetic-session-${calls.length}` };
  });
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller, root);
  const internal = bridge as unknown as InternalBridge;
  const project = await workspace.createProject(projectPath);
  const conversation = workspace.createConversation(project.id);
  const other = workspace.createConversation(project.id);
  const startRun = async (conversationId = conversation.id) => {
    const before = calls.length;
    const sent = await workspace.send(conversationId, {
      content: '仅分析测试图片，不改动文件。',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      runtimeId: target.id,
      model: 'fixture',
      effort: 'low',
      autoEscalate: false,
    });
    await workspace.tickQueue();
    await until(() => calls.length > before, 'Synthetic executor did not start').catch(() => {
      const workflow = workspace.store.get<Workflow>('workflow', sent.workflow.id);
      throw new Error(
        `Synthetic executor did not start: ${workflow?.status} ${workflow?.error ?? ''} ${JSON.stringify(workflow?.scheduling)}`,
      );
    });
    const call = calls[before]!;
    assert.ok(call.ctx.agentBridge?.token);
    return { ...call, workflowId: sent.workflow.id, auth: `Bearer ${call.ctx.agentBridge!.token}` };
  };
  const installGatedDecoder = () => {
    assert.equal(internal.mediaManager, undefined);
    let unblock!: () => void,
      entered = false,
      first = true;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const actual = createMediaDecoder(root);
    const manager = new MediaAnalysisManager(data, {
      appRoot: root,
      onUpdate: (report) => internal.mediaProgress(report),
      decoder: {
        ...actual,
        image: async (path, signal) => {
          if (first) {
            first = false;
            entered = true;
            await Promise.race([
              gate,
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('synthetic decoder interrupted')), {
                  once: true,
                });
                if (signal.aborted) reject(new Error('synthetic decoder interrupted'));
              }),
            ]);
          }
          signal.throwIfAborted();
          return actual.image(path, signal);
        },
      },
    });
    internal.mediaManager = manager;
    return { manager, unblock, entered: () => entered };
  };
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 100, b: 180 } } })
    .png()
    .toFile(join(projectPath, 'a.png'));
  await copyFile(join(projectPath, 'a.png'), join(projectPath, 'b.png'));
  t.after(async () => {
    try {
      await Promise.allSettled([bridge.close(), workspace.close()]);
      await controller.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(root).startsWith('pugport-media-bridge-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    data,
    project,
    projectPath,
    workspace,
    bridge,
    internal,
    controller,
    conversation,
    other,
    calls,
    startRun,
    installGatedDecoder,
  };
}

test('media bridge uses real Sharp fixtures, scopes results to the conversation, and rejects expired native tokens', async (t) => {
  const f = await fixture(t);
  const first = await f.startRun();
  const created = payload(
    await f.bridge.handle(
      first.auth,
      request({ action: 'start', folders: [f.projectPath], owner: { conversationId: f.other.id } }),
    ),
  );
  assert.equal(created.error, false, created.text);
  const job = JSON.parse(created.text) as MediaAnalysisReport;
  assert.equal(job.owner?.conversationId, f.conversation.id, 'model-supplied owner must be ignored');
  const completed = await f.internal.mediaManager!.wait(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.results[0]?.classification, 'exact-bytes');
  assert.equal(completed.results[0]?.deleteEligible, false);
  const allowed = payload(await f.bridge.handle(first.auth, request({ action: 'status', job_id: job.id, limit: 1 })));
  assert.equal(allowed.error, false);
  const second = await f.startRun(f.other.id);
  const denied = payload(await f.bridge.handle(second.auth, request({ action: 'status', job_id: job.id })));
  assert.equal(denied.error, true);
  assert.match(denied.text, /没有这个媒体/);
  assert.throws(() => f.bridge.mediaAction(f.other.id, job.id, 'pause'), /没有这个媒体/);
  first.finish();
  await until(() => !f.controller.agentBridgeCaller(first.ctx.agentBridge!.token), 'Native token was not revoked');
  assert.equal((await f.bridge.handle(first.auth, request({ action: 'status', job_id: job.id }))).status, 401);
  const changed: Project = { ...f.project, path: f.root };
  f.workspace.store.save('project', changed.id, '', changed);
  assert.throws(() => f.bridge.mediaAction(f.conversation.id, job.id, 'resume'), /项目范围已变化/);
});

test('quota failure ends the native token but does not cancel local media work', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const run = await f.startRun();
  const started = payload(await f.bridge.handle(run.auth, request({ action: 'start', folders: [f.projectPath] })));
  assert.equal(started.error, false, started.text);
  const job = JSON.parse(started.text) as MediaAnalysisReport;
  await until(gate.entered, 'Local decoder did not start');
  run.fail(new Error('quota-exhausted'));
  await until(() => !f.controller.agentBridgeCaller(run.ctx.agentBridge!.token), 'Failed run retained its token');
  await until(
    () => ['blocked', 'failed'].includes(f.workspace.store.get<Workflow>('workflow', run.workflowId)?.status ?? ''),
    'Workflow did not pause after synthetic quota failure',
  );
  assert.equal(gate.manager.status(job.id).status, 'running');
  gate.unblock();
  assert.equal((await gate.manager.wait(job.id)).status, 'completed');
  assert.ok(f.workspace.store.messages(f.conversation.id).some((message) => message.content.includes(job.id)));
});

test('user stop pauses local media, and explicit UI resume detaches the stopped workflow', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const run = await f.startRun();
  const started = payload(await f.bridge.handle(run.auth, request({ action: 'start', folders: [f.projectPath] })));
  assert.equal(started.error, false, started.text);
  const job = JSON.parse(started.text) as MediaAnalysisReport;
  await until(gate.entered, 'Local decoder did not start');
  f.workspace.cancel(run.workflowId);
  await until(() => gate.manager.status(job.id).status === 'interrupted', 'User stop did not pause local analysis');
  await gate.manager.wait(job.id);
  f.bridge.mediaAction(f.conversation.id, job.id, 'resume');
  await until(
    () => ['completed', 'failed'].includes(gate.manager.status(job.id).status),
    'Explicit media resume was paused again by the old stopped workflow',
  );
  assert.equal(gate.manager.status(job.id).status, 'completed');
  assert.equal(gate.manager.status(job.id).owner?.workflowId, undefined);
  gate.manager.pause(job.id);
  const successor = await f.startRun();
  const resumed = payload(await f.bridge.handle(successor.auth, request({ action: 'resume', job_id: job.id })));
  assert.equal(resumed.error, false, resumed.text);
  await until(
    () => gate.manager.status(job.id).status === 'completed',
    'Current native caller could not resume the earlier job',
  );
  assert.equal(gate.manager.status(job.id).owner?.workflowId, successor.workflowId);
  assert.equal(gate.manager.status(job.id).owner?.runId, f.controller.activeRunFor(successor.workflowId));
});

test('assisted verifier controls retain explicit account and reject cross-conversation access', async (t) => {
  const f = await fixture(t);
  const job = await f.bridge.startMedia(f.conversation.id, { folders: [f.projectPath], engine: 'legacy' });
  const manager = f.internal.mediaManager!;
  const target: RuntimeTarget = {
    id: 'grok-b-fixture',
    provider: 'grok',
    label: 'Grok B',
    command: 'never-spawn',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountId: 'synthetic-grok-b',
    accountHome: join(f.root, 'synthetic-grok-home'),
  };
  f.controller.targets.push(target);
  const metadata = {
    workerId: 'b155bd27-655f-4e3b-a75f-330b67e0f7c8',
    runtimeId: target.id,
    model: 'grok-4.7-build-fast',
    effort: 'low',
  };
  const report = {
    ...metadata,
    accountLabel: 'Grok B',
    direction: 'back' as const,
    status: 'running' as const,
    checked: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedSeconds: 0,
  };
  let attached = 0,
    stopped = 0;
  t.mock.method(manager, 'attachAssistedWorker', (_id: string, input: { accountLabel: string }) => {
    attached++;
    assert.equal(input.accountLabel, 'Grok B');
    return report;
  });
  t.mock.method(manager, 'assistedWorkerStatus', () => report);
  t.mock.method(manager, 'stopAssistedWorker', () => {
    stopped++;
    return { ...report, status: 'stopped' as const };
  });
  assert.equal(f.bridge.attachMediaAssistant(f.conversation.id, job.id, metadata).runtimeId, target.id);
  assert.equal(
    (f.bridge.statusMediaAssistants(f.conversation.id, job.id, metadata.workerId) as typeof report).workerId,
    metadata.workerId,
  );
  assert.throws(() => f.bridge.attachMediaAssistant(f.other.id, job.id, metadata), /这条对话/);
  assert.throws(() => f.bridge.statusMediaAssistants(f.other.id, job.id, metadata.workerId), /这条对话/);
  assert.throws(() => f.bridge.stopMediaAssistant(f.other.id, job.id, metadata.workerId), /这条对话/);
  assert.throws(
    () => f.bridge.attachMediaAssistant(f.conversation.id, job.id, { ...metadata, runtimeId: 'codex-fixture' }),
    /Grok/,
  );
  target.enabled = false;
  assert.throws(() => f.bridge.attachMediaAssistant(f.conversation.id, job.id, metadata), /Grok/);
  assert.equal(attached, 1);
  assert.equal(f.bridge.stopMediaAssistant(f.conversation.id, job.id, metadata.workerId).status, 'stopped');
  assert.equal(stopped, 1);
});

test('bridge close interrupts and releases the checkpoint database without losing the scoped job', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const run = await f.startRun();
  const started = payload(await f.bridge.handle(run.auth, request({ action: 'start', folders: [f.projectPath] })));
  const job = JSON.parse(started.text) as MediaAnalysisReport;
  await until(gate.entered, 'Local decoder did not start');
  const listeners = f.controller.listenerCount('state');
  await f.bridge.close();
  assert.equal(f.controller.listenerCount('state'), listeners - 1);
  const reopened = new MediaAnalysisManager(f.data, { appRoot: f.root });
  try {
    const saved = reopened.status(job.id);
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.owner?.conversationId, f.conversation.id);
    assert.equal(saved.owner?.projectPath, f.projectPath);
  } finally {
    await reopened.close();
  }
});

for (const deletion of ['workflow', 'conversation'] as const)
  test(`deleting the ${deletion} pauses media even after the native run has completed`, async (t) => {
    const f = await fixture(t);
    const gate = f.installGatedDecoder();
    const run = await f.startRun();
    const started = payload(await f.bridge.handle(run.auth, request({ action: 'start', folders: [f.projectPath] })));
    const job = JSON.parse(started.text) as MediaAnalysisReport;
    await until(gate.entered, 'Local decoder did not start');
    run.finish();
    await until(
      () => f.workspace.store.get<Workflow>('workflow', run.workflowId)?.status === 'completed',
      'Synthetic task did not finish',
    );
    assert.equal(gate.manager.status(job.id).status, 'running');
    if (deletion === 'workflow') f.workspace.deleteWorkflow(run.workflowId);
    else f.workspace.deleteConversation(f.conversation.id);
    await until(
      () => gate.manager.status(job.id).status === 'interrupted',
      `Deleted ${deletion} did not pause its media analysis`,
    );
  });

test('a task that ended its turn to wait for a media job continues by itself once the job finishes', async (t) => {
  const f = await fixture(t);
  const gate = f.installGatedDecoder();
  const run = await f.startRun();
  const started = payload(await f.bridge.handle(run.auth, request({ action: 'start', folders: [f.projectPath] })));
  assert.equal(started.error, false, started.text);
  const job = JSON.parse(started.text) as MediaAnalysisReport;
  await until(gate.entered, 'Local decoder did not start');
  run.finish();
  await until(
    () => f.workspace.store.get<Workflow>('workflow', run.workflowId)?.status === 'completed',
    'Synthetic turn did not end',
  );
  // As seen live: the executor reports the step unfinished because the named job is still reading.
  const workflow = f.workspace.store.get<Workflow>('workflow', run.workflowId)!;
  const record = f.controller.store.run(workflow.runIds.at(-1)!)!;
  f.controller.store.saveRun({
    ...record,
    taskOutcome: {
      status: 'partial',
      source: 'executor-report',
      summary: `全库任务 ${job.id.slice(0, 8)} 仍在运行，没有证据可以分组。`,
    },
  });
  // The task is recorded as waiting for this job, which the interface shows as waiting rather than an error.
  assert.equal(f.internal.mediaWait(workflow)?.jobId, job.id);
  f.workspace.store.save('workflow', workflow.id, workflow.conversationId, {
    ...workflow,
    status: 'blocked',
    waitingOn: f.internal.mediaWait(workflow),
  });
  const continued: string[] = [];
  t.mock.method(f.workspace, 'continue', async (id: string, content?: string) => {
    continued.push(id);
    assert.match(content ?? '', new RegExp(job.id));
    assert.match(content ?? '', /full-file-sha256-equal/);
    assert.match(content ?? '', /"deleteEligible":false/);
    assert.match(content ?? '', /"needsMoreEvidence":false/);
    assert.match(content ?? '', /不重复执行同一抽样计划/);
    return {} as never;
  });
  gate.unblock();
  assert.equal((await gate.manager.wait(job.id)).status, 'completed');
  await until(() => continued.length > 0, 'The waiting task was not continued');
  assert.deepEqual(continued, [workflow.id]);
  f.internal.mediaProgress(gate.manager.status(job.id));
  assert.deepEqual(continued, [workflow.id], 'duplicate completion must not wake the task twice');
});

test('media completion handoff bounds evidence, preserves sampled checks and paginates without deletion permission', () => {
  const visual = {
    matches: 12,
    samplesA: 12,
    samplesB: 12,
    offsetSeconds: 40,
    matchedFractionA: 1,
    matchedFractionB: 1,
    spanA: [0, 20],
    spanB: [40, 60],
    positions: [],
    coverage: 'partial-overlap',
    fineCheck: { planned: 12, decoded: 12, matches: 12, failed: 0 },
    sampledContainment: {
      kind: 'sampled-contained',
      contained: 'a',
      container: 'b',
      containedSpan: [0, 20],
      containerSpan: [40, 60],
      matchedSamples: 12,
      plannedSamples: 12,
      unverified: ['between-sample-frames', 'audio', 'subtitles', 'quality'],
    },
  };
  const report = {
    id: 'synthetic-job',
    offset: 0,
    nextOffset: null,
    counts: { files: 40, fingerprinted: 40, errors: 0, results: 10 },
    results: Array.from({ length: 10 }, (_, i) => ({
      a: `synthetic-a-${i}.mp4`,
      b: `synthetic-b-${i}.mp4`,
      classification: 'partial-overlap',
      deleteEligible: false,
      observedAt: 'synthetic-time',
      visual,
      mediaA: { durationSeconds: 20, width: 100, height: 100 },
      mediaB: { durationSeconds: 80, width: 200, height: 200 },
    })),
  } as unknown as MediaAnalysisReport;
  const prompt = mediaCompletionHandoff(report);
  const payload = JSON.parse(prompt.split('\n')[1]!);
  assert.equal(payload.evidence.length, 8);
  assert.deepEqual(payload.pagination.nextRequest, { action: 'status', job_id: report.id, offset: 8, limit: 8 });
  assert.equal(payload.pagination.needsMoreEvidence, true);
  assert.equal(payload.deleteEligible, false);
  assert.equal(payload.evidence[0].deleteEligible, false);
  assert.equal(payload.evidence[0].mediaA.durationSeconds, 20);
  assert.equal(payload.evidence[0].visual.offsetSeconds, 40);
  assert.deepEqual(payload.evidence[0].visual.sampledContainment, visual.sampledContainment);
  assert.deepEqual(payload.evidence[0].checksDone, ['aligned-visual-sampling']);
  assert.ok(payload.evidence[0].missingChecks.includes('unique-audio-and-subtitles'));
  assert.equal(payload.evidence[0].authorizationStatus, 'not-evaluated-by-analysis');
  assert.ok(!payload.evidence[0].missingChecks.includes('user-authorization'));
  assert.match(prompt, /不增加用户授权/);
  assert.match(prompt, /复用对话中已有的明确授权，不重复询问/);
  assert.match(prompt, /不再用长 sleep/);
  const old = mediaCompletionHandoff({
    ...report,
    results: [{ ...report.results[0]!, mediaA: undefined, mediaB: undefined }],
    nextOffset: 1,
  });
  const oldPayload = JSON.parse(old.split('\n')[1]!);
  assert.equal(oldPayload.evidence[0].mediaA, null);
  assert.ok(oldPayload.evidence[0].missingChecks.includes('media-metadata'));
  assert.equal(oldPayload.pagination.nextOffset, 1);
});

test('desktop workflow runs the fixed program without an agent, exposes scoped pages and persists the selected recipe', async (t) => {
  const f = await fixture(t);
  const started = await f.bridge.startMedia(f.conversation.id, {
    folders: [f.projectPath],
    engine: 'legacy',
    topK: 4,
    videoSampleSeconds: 30,
    recipeId: 'builtin-legacy-backup',
  });
  const report = await f.internal.mediaManager!.wait(started.id);
  assert.equal(report.status, 'completed');
  assert.equal(f.calls.length, 0, 'the desktop media program must not start an executor');
  assert.equal(f.bridge.listMedia(f.conversation.id)[0]?.id, started.id);
  assert.deepEqual(f.bridge.listMedia(f.conversation.id)[0]?.results, []);
  assert.deepEqual(f.bridge.listMedia(f.other.id), []);
  assert.equal(
    f.bridge.statusMedia(f.conversation.id, started.id, { limit: 1 }).results[0]?.classification,
    'exact-bytes',
  );
  assert.throws(() => f.bridge.statusMedia(f.other.id, started.id), /没有这个媒体/);
  assert.throws(() => f.bridge.mediaAction(f.other.id, started.id, 'resume'), /没有这个媒体/);
  const replacement = { ...f.project, path: join(f.root, 'changed-scope') };
  f.workspace.store.save('project', replacement.id, replacement.id, replacement);
  assert.deepEqual(f.bridge.listMedia(f.conversation.id), [], 'old project scope cannot leak results');
  assert.throws(() => f.bridge.statusMedia(f.conversation.id, started.id), /项目范围已变化/);
  assert.throws(() => f.bridge.mediaAction(f.conversation.id, started.id, 'resume'), /项目范围已变化/);
});
