import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project, Workflow } from '../src/shared/types.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { GrokHistorySyncWorker } from '../src/server/grok-history-worker-client.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const PROBE_TIMEOUT_MS = 5000;

function removeFixtureDirectory(root: string) {
  const target = realpathSync.native(root);
  const temporaryRoot = realpathSync.native(tmpdir());
  const withinTemporaryRoot = relative(temporaryRoot, target);
  assert.ok(
    withinTemporaryRoot &&
      withinTemporaryRoot !== '..' &&
      !withinTemporaryRoot.startsWith(`..${sep}`) &&
      !isAbsolute(withinTemporaryRoot),
    'Fixture directory must remain inside the canonical temporary directory',
  );
  assert.ok(basename(target).startsWith('comborunner-history-worker-test-'), 'Unexpected fixture directory name');
  rmSync(target, { recursive: true, force: true });
}

async function closeHttpServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}

async function closeFixture(
  root: string,
  worker: Pick<GrokHistorySyncWorker, 'close'>,
  db: DatabaseSync,
  servers: Iterable<Server>,
) {
  // Every owned handle closes before a containment assertion can reject cleanup.
  const closed = await Promise.allSettled([worker.close(), ...Array.from(servers, closeHttpServer)]);
  db.close();
  for (const result of closed) if (result.status === 'rejected') throw result.reason;
  removeFixtureDirectory(root);
}

function fixture(t: TestContext, options: { sessions?: number; messages?: number; timeoutMs?: number } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-history-worker-test-')));
  const dataDir = join(root, 'data');
  const projectPath = join(root, 'project');
  const grokHome = join(root, 'grok');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE runs(id TEXT PRIMARY KEY,value TEXT)');
  const store = new WorkspaceStore(db);
  const project: Project = {
    id: 'fixture-project',
    name: 'Synthetic project',
    path: realpathSync.native(projectPath),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  store.save('project', project.id, project.id, project);
  for (let session = 0; session < (options.sessions ?? 1); session++) {
    const sessionId = `${(session + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    const folder = join(grokHome, 'sessions', encodeURIComponent(project.path), sessionId);
    mkdirSync(folder, { recursive: true });
    const messages = Array.from({ length: options.messages ?? 2 }, (_, line) => ({
      type: line % 2 ? 'assistant' : 'user',
      content: `Synthetic session ${session} message ${line}: ${'Durable historical context. '.repeat(35)}`,
    }));
    writeFileSync(
      join(folder, 'summary.json'),
      JSON.stringify({ info: { cwd: project.path }, created_at: project.createdAt, updated_at: project.updatedAt }),
    );
    writeFileSync(
      join(folder, 'chat_history.jsonl'),
      messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    );
  }
  const worker = new GrokHistorySyncWorker({ timeoutMs: options.timeoutMs });
  const servers = new Set<Server>();
  const job = { projectId: project.id, dataDir, appRoot: process.cwd(), grokHomes: [grokHome] };
  t.after(() => closeFixture(root, worker, db, servers));
  return { worker, job, store, db, project, dataDir, servers };
}

test('fixture removal canonicalizes a temporary directory alias before checking containment and removing it', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-history-worker-test-')));
  const alias = `${root}-alias`;
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    removeFixtureDirectory(alias);
    assert.equal(existsSync(root), false, 'cleanup must remove the canonical fixture, not only its alias');
  } finally {
    unlinkSync(alias);
    if (existsSync(root)) removeFixtureDirectory(root);
  }
});

test('a rejected cleanup safety check still closes every fixture-owned handle and preserves the rejected directory', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-history-worker-test-')));
  const rejected = join(root, 'unapproved-directory');
  mkdirSync(rejected);
  const db = new DatabaseSync(join(root, 'cleanup.sqlite'));
  const server = createServer((_request, response) => response.end('fixture'));
  let workerClosed = false;
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    await assert.rejects(
      closeFixture(rejected, { close: async () => void (workerClosed = true) }, db, [server]),
      /Unexpected fixture directory name/,
    );
    assert.equal(workerClosed, true);
    assert.equal(db.isOpen, false);
    assert.equal(server.listening, false);
    assert.equal(existsSync(rejected), true, 'an unapproved directory must never be removed');
  } finally {
    await closeHttpServer(server);
    if (db.isOpen) db.close();
    removeFixtureDirectory(root);
  }
});

test('persistent Grok history worker coalesces one project and makes imported records visible to the live app connection', async (t) => {
  const f = fixture(t);
  const first = f.worker.execute(f.job);
  const second = f.worker.execute(f.job);
  assert.equal(first, second, 'simultaneous sends share the same pre-enqueue import');
  const result = await first;
  assert.equal(result.addedMessages, 2);
  assert.equal(f.store.allMessages(result.conversationId).length, 2);
  const unchanged = await f.worker.execute(f.job);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.conversationId, result.conversationId);
  assert.equal(f.store.conversations(f.project.id).length, 1);
});

test('large Grok history import keeps timers and HTTP requests responsive on the main event loop', async (t) => {
  const f = fixture(t, { sessions: 17, messages: 160 });
  const server = createServer((_request, response) => response.end('main event loop alive'));
  f.servers.add(server);
  await listenForFetch(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let importing = true;
  let ticks = 0;
  let repliesWhileImporting = 0;
  const timer = setInterval(() => ticks++, 10);
  // One probe in flight at a time: the next starts 10 ms after the previous reply. A request every 10 ms
  // regardless of replies piles up loopback connections on a busy host and fails with "fetch failed".
  const probe = (async () => {
    while (importing) {
      const body: string = await fetch(`http://127.0.0.1:${address.port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }).then((response) => response.text());
      assert.equal(body, 'main event loop alive');
      if (importing) repliesWhileImporting++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  try {
    const result = await f.worker.execute(f.job);
    importing = false;
    assert.equal(result.retainedMessages, 2720);
    assert.ok(ticks >= 2, 'the main-thread timer runs before the full import finishes');
    assert.ok(repliesWhileImporting >= 2, 'HTTP responses complete while native logs are being parsed');
  } finally {
    importing = false;
    clearInterval(timer);
    // Settle the single in-flight probe and wait at most PROBE_TIMEOUT_MS so teardown cannot hang on a stalled reply.
    await Promise.race([probe, new Promise<void>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS).unref())]);
  }
});

test('worker never recovers or mutates a live running workflow and rejects a busy project before import writes', async (t) => {
  const f = fixture(t);
  const workflow: Workflow = {
    id: 'live-workflow',
    projectId: f.project.id,
    conversationId: 'live-conversation',
    userMessageId: 'live-message',
    input: {
      content: 'Keep this live task running',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
    },
    status: 'running',
    phase: 'execute',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: f.project.createdAt,
    updatedAt: f.project.updatedAt,
  };
  f.store.save('workflow', workflow.id, workflow.conversationId, workflow);
  const before = f.db.prepare('SELECT * FROM workspace_records ORDER BY kind,id').all();
  await assert.rejects(f.worker.execute(f.job), /未结束|等待|取消/);
  assert.deepEqual(f.db.prepare('SELECT * FROM workspace_records ORDER BY kind,id').all(), before);
  assert.equal(f.store.get<Workflow>('workflow', workflow.id)?.status, 'running');
  assert.equal(existsSync(join(f.dataDir, 'imports')), false);
});

test('history worker deadline rejects promptly and remains safely closable', async (t) => {
  const f = fixture(t, { timeoutMs: 1, sessions: 17, messages: 100 });
  await assert.rejects(f.worker.execute(f.job), /超时/);
  await f.worker.close();
  await assert.rejects(f.worker.execute(f.job), /已关闭/);
});

test('closing rejects active and queued imports without starting another job', async (t) => {
  const f = fixture(t, { sessions: 17, messages: 100 });
  const first = f.worker.execute(f.job);
  const next = f.worker.execute({ ...f.job, projectId: 'another-project' });
  const firstRejected = assert.rejects(first, /已关闭/);
  const nextRejected = assert.rejects(next, /已关闭/);
  await f.worker.close();
  await Promise.all([firstRejected, nextRejected]);
  assert.equal(existsSync(join(f.dataDir, 'imports')), false);
});
