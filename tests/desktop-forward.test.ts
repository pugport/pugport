import { memoryRecordStore as memoryStore } from './helpers/record-store.ts';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { externalTaskRoutes, type ExternalTasks } from '../src/server/external-tasks.ts';
import { desktopApp, DesktopClosed, DesktopUncertain } from '../src/server/node/desktop-app.ts';
import { publishForwardToken, publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import { externalTaskRunner } from '../src/server/node/peer-tasks.ts';
import { temporaryFolder } from './helpers/fake-peer.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

type Seen = { method: string; path: string; token?: string; forwardToken?: string; body?: Record<string, unknown> };

/** A stand-in for the desktop app's local API; `routes` answers by "METHOD /path". */
async function fakeDesktop(
  t: TestContext,
  routes: Record<
    string,
    (seen: Seen) => { status?: number; body: unknown; headers?: Record<string, string> } | 'hang up'
  >,
  /** The port of a desktop app that was open before (it opens again). */
  port?: number,
) {
  const tokenFile = join(temporaryFolder(t, 'forward-token-'), 'token.json');
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const path = (req.url ?? '').split('?')[0]!;
    const entry: Seen = {
      method: req.method ?? '',
      path: req.url ?? '',
      ...(typeof req.headers['x-pugport-device-token'] === 'string'
        ? { forwardToken: req.headers['x-pugport-device-token'] }
        : {}),
      ...(typeof req.headers['x-agent-token'] === 'string' ? { token: req.headers['x-agent-token'] } : {}),
      ...(text ? { body: JSON.parse(text) } : {}),
    };
    seen.push(entry);
    const route = routes[`${req.method} ${path}`];
    const reply = route ? route(entry) : { status: 404, body: { error: 'Task not found.' } };
    if (reply === 'hang up') return void req.socket.destroy();
    res.statusCode = reply.status ?? 200;
    res.setHeader('content-type', 'application/json');
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    res.end(JSON.stringify(reply.body));
  });
  if (port) await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  else await listenForFetch(server);
  t.after(() => void (server.listening && server.close()));
  publishForwardToken('synthetic-forward', (server.address() as AddressInfo).port, tokenFile);
  t.after(publishSessionToken('synthetic-token', (server.address() as AddressInfo).port));
  /** The desktop app quits: its port closes and open connections drop. */
  const quit = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  return { port: (server.address() as AddressInfo).port, seen, quit, tokenFile };
}

/** A port nothing listens on: the desktop app is not running. */
async function closedPort() {
  const server = createServer();
  await listenForFetch(server);
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

const health =
  (extra: Record<string, unknown> = {}) =>
  () => ({ body: { ok: true, name: 'PugPort', version: '0.0.34', ...extra } });

test('the desktop probe tells a current desktop, an older desktop, a node and nothing apart', async (t) => {
  const current = await fakeDesktop(t, { 'GET /api/health': health({ role: 'desktop' }) });
  assert.equal(await desktopApp({ port: current.port, forwardTokenFile: current.tokenFile }).probe(), 'device');
  assert.equal(
    await desktopApp({ port: current.port, forwardTokenFile: current.tokenFile + '.missing' }).probe(),
    'external',
  );
  const elsewhere = await fakeDesktop(t, { 'GET /api/health': health({ role: 'desktop' }) });
  assert.equal(
    await desktopApp({ port: current.port, forwardTokenFile: elsewhere.tokenFile }).probe(),
    'external',
    'the token of a desktop process on another port (a dev or test backend) is ignored',
  );
  const older = await fakeDesktop(t, { 'GET /api/health': health() });
  assert.equal(await desktopApp({ port: older.port, forwardTokenFile: older.tokenFile }).probe(), 'external');
  const node = await fakeDesktop(t, { 'GET /api/health': health({ role: 'node' }) });
  assert.equal(
    await desktopApp({ port: node.port, forwardTokenFile: node.tokenFile }).probe(),
    undefined,
    'a node never takes forwarded tasks',
  );
  const other = await fakeDesktop(t, { 'GET /api/health': () => ({ body: { ok: true, name: 'Something else' } }) });
  assert.equal(await desktopApp({ port: other.port, forwardTokenFile: other.tokenFile }).probe(), undefined);
  assert.equal(await desktopApp({ port: await closedPort() }).probe(), undefined);
});

test('a forwarded task carries the session token and only fields every desktop build knows', async (t) => {
  const desktop = await fakeDesktop(t, {
    'POST /api/external/tasks': () => ({
      status: 201,
      body: { taskId: 'desk-1', status: 'queued', conversationId: 'c' },
    }),
  });
  const app = desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile });
  const input = {
    task: 'synthetic task',
    caller: '设备 · Desk',
    projectPath: '/fixture',
    write: true,
    untrusted: false,
  };
  assert.deepEqual(await app.dispatch(input, 'device'), { taskId: 'desk-1', status: 'queued' });
  const posted = desktop.seen.find((entry) => entry.method === 'POST')!;
  assert.equal(posted.token, 'synthetic-token');
  assert.equal(posted.forwardToken, 'synthetic-forward');
  assert.deepEqual(posted.body, {
    task: 'synthetic task',
    caller: '设备 · Desk',
    projectPath: '/fixture',
    write: true,
    source: 'device',
  });

  await app.dispatch({ ...input, write: false, untrusted: true }, 'external');
  const older = desktop.seen.filter((entry) => entry.method === 'POST').at(-1)!.body!;
  assert.deepEqual(Object.keys(older).sort(), ['caller', 'projectPath', 'task', 'untrusted', 'write']);
});

test('a desktop that is gone takes nothing; one that hangs up may have it; its errors come in its words', async (t) => {
  assert.equal(
    await desktopApp({ port: await closedPort() }).dispatch(
      { task: 'x', caller: 'Desk', write: false, untrusted: false },
      'device',
    ),
    undefined,
  );
  const desktop = await fakeDesktop(t, {
    'POST /api/external/tasks': () => ({ status: 400, body: { error: 'write: true needs projectPath.' } }),
  });
  await assert.rejects(
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }).dispatch(
      { task: 'x', caller: 'Desk', write: true, untrusted: false },
      'device',
    ),
    /write: true needs projectPath/,
  );
  const hangsUp = await fakeDesktop(t, {
    'POST /api/external/tasks': () => 'hang up',
  });
  await assert.rejects(
    desktopApp({ port: hangsUp.port, forwardTokenFile: hangsUp.tokenFile }).dispatch(
      { task: 'x', caller: 'Desk', write: true, untrusted: false },
      'device',
    ),
    DesktopUncertain,
  );
});

test('a forward refused because the desktop could not identify the node is sent once more, and only then', async (t) => {
  const input = { task: 'Edit', caller: 'Desk', projectPath: '/synthetic', write: true, untrusted: false };
  const unidentified = {
    status: 503,
    headers: { 'retry-after': '0' },
    body: { error: 'PugPort could not identify the program making this request.', code: 'caller-unknown' },
  };
  const forward = async (answers: { status?: number; body: unknown; headers?: Record<string, string> }[]) => {
    const desktop = await fakeDesktop(t, { 'POST /api/external/tasks': () => answers.shift()! });
    const result = await desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile })
      .dispatch(input, 'device')
      .catch((error: Error) => error);
    return { result, seen: desktop.seen };
  };
  const accepted = { status: 201, body: { taskId: 'desk-1', status: 'queued' } };
  const recovered = await forward([unidentified, accepted]);
  assert.deepEqual(recovered.result, { taskId: 'desk-1', status: 'queued' });
  assert.equal(recovered.seen.length, 2);
  assert.deepEqual(recovered.seen[1], recovered.seen[0], 'the same request, token and body');
  assert.equal(recovered.seen[1]!.body?.source, 'device');

  const stillRefused = await forward([unidentified, unidentified, accepted]);
  assert.match((stillRefused.result as Error).message, /could not identify/);
  assert.equal(stillRefused.seen.length, 2, 'one resend, never more');

  // Any other 503, with or without Retry-After, is not that refusal.
  for (const other of [
    { status: 503, headers: { 'retry-after': '0' }, body: { error: 'synthetic outage' } },
    { status: 503, body: { error: 'synthetic outage', code: 'something-else' } },
    { status: 500, headers: { 'retry-after': '0' }, body: { error: 'synthetic outage', code: 'caller-unknown' } },
  ]) {
    const failed = await forward([other, accepted]);
    assert.match((failed.result as Error).message, /synthetic outage/);
    assert.equal(failed.seen.length, 1);
  }
});

test('status keeps only the peer fields; a missing task and a closed desktop are told apart', async (t) => {
  const desktop = await fakeDesktop(t, {
    'GET /api/external/tasks/desk-1': () => ({
      body: {
        taskId: 'desk-1',
        conversationId: 'private-conversation',
        status: 'running',
        phase: 'executing',
        executor: 'Claude · Mac',
        permissionOrigin: { mode: 'workspace-write', source: 'device' },
        progress: { toolCalls: 2, secret: 'dropped' },
        note: 'n'.repeat(5000),
      },
    }),
  });
  const app = desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile });
  const status = await app.status('desk-1');
  assert.deepEqual(Object.keys(status!).sort(), ['executor', 'note', 'phase', 'progress', 'status', 'taskId']);
  assert.equal(status!.note!.length, 4000);
  assert.deepEqual(status!.progress, { toolCalls: 2 });
  assert.equal(await app.status('desk-2'), undefined);
  await assert.rejects(desktopApp({ port: await closedPort() }).status('desk-1'), DesktopClosed);
});

test('results ask for every step’s file lines, and cancel passes through with the session token', async (t) => {
  const desktop = await fakeDesktop(t, {
    'GET /api/external/tasks/desk-1/result': () => ({
      body: {
        status: 'completed',
        result: 'final',
        sendFiles: ['PUGPORT_SEND_FILE: /fixture/a.txt', 7],
        permissionOrigin: {},
      },
    }),
    'GET /api/external/tasks/old-1/result': () => ({ body: { status: 'completed', result: 'final only' } }),
    'POST /api/external/tasks/desk-1/cancel': () => ({ body: { taskId: 'desk-1', status: 'cancelled' } }),
  });
  const app = desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile });
  assert.deepEqual(await app.result('desk-1', 0), {
    status: 'completed',
    result: 'final',
    sendFiles: ['PUGPORT_SEND_FILE: /fixture/a.txt'],
  });
  assert.match(desktop.seen.at(-1)!.path, /\?wait=0&sendFiles=1$/);
  assert.deepEqual(await app.result('old-1', 0), { status: 'completed', result: 'final only' });
  assert.equal(await app.result('desk-9', 0), undefined);
  assert.equal(await app.cancel('desk-1'), true);
  assert.equal(desktop.seen.at(-1)!.token, 'synthetic-token');
  assert.equal(await app.cancel('desk-9'), false);
});

/** The node's own task service: records what would have run here instead of on the desktop. */
function nodeTasks() {
  const ran: Record<string, unknown>[] = [];
  const tasks = {
    dispatch: async (input: Record<string, unknown>) => {
      ran.push(input);
      return { taskId: `node-${ran.length}`, status: 'queued' };
    },
    cancel: () => true,
  } as unknown as ExternalTasks;
  return { tasks, ran };
}

const desktopRoutes = (extra: Parameters<typeof fakeDesktop>[1] = {}): Parameters<typeof fakeDesktop>[1] => ({
  'GET /api/health': health({ role: 'desktop' }),
  'POST /api/external/tasks': () => ({ status: 201, body: { taskId: 'desk-1', status: 'queued' } }),
  ...extra,
});

async function until(check: () => boolean) {
  // Windows takes about a second to refuse a connection to a closed loopback port.
  for (const end = Date.now() + 5000; !check() && Date.now() < end;) await new Promise((done) => setTimeout(done, 20));
  assert.ok(check(), 'condition reached');
}

const peerTask = {
  task: 'Tidy the notes\n\nFiles sent to this computer:\n/fixture/Received/notes.txt',
  write: true,
  untrusted: false,
  projectPath: '/fixture/project',
  caller: '设备 · Desk',
};

test('a peer task goes to the desktop app on this computer, keeping write, folder, file lines and trust', async (t) => {
  const folder = temporaryFolder(t, 'desktop-forward-');
  const early = join(folder, 'early.txt');
  await writeFile(early, 'synthetic');
  const desktop = await fakeDesktop(
    t,
    desktopRoutes({
      'GET /api/external/tasks/desk-1': () => ({ body: { taskId: 'desk-1', status: 'running', executor: 'Claude' } }),
      'GET /api/external/tasks/desk-1/result': () => ({
        body: { status: 'completed', result: 'Done.', sendFiles: [`PUGPORT_SEND_FILE: ${early}`] },
      }),
    }),
  );
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  const input = { ...peerTask, requestId: 'retry-1' };
  const [first, second] = await Promise.all([runner.dispatch(input, 'peer-1'), runner.dispatch(input, 'peer-1')]);
  assert.deepEqual(first, { taskId: 'desk-1', status: 'queued' });
  assert.deepEqual(second, first, 'the request id is still deduplicated on the node');
  assert.equal(node.ran.length, 0, 'nothing ran on the node');
  const posts = desktop.seen.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 1);
  const body = posts[0]!.body!;
  assert.deepEqual(
    { ...body, task: undefined },
    { task: undefined, caller: '设备 · Desk', projectPath: '/fixture/project', write: true, source: 'device' },
  );
  assert.match(String(body.task), /Files sent to this computer:\n\/fixture\/Received\/notes\.txt/);
  assert.match(String(body.task), /PUGPORT_SEND_FILE: <absolute path on this computer>$/);
  assert.equal(runner.owner('desk-1'), 'peer-1');

  assert.equal(runner.status('desk-1')?.status, 'queued');
  await until(() => runner.status('desk-1')?.status === 'running');
  assert.equal(runner.status('desk-1')?.executor, 'Claude');

  const result = await runner.result('desk-1', 0);
  assert.equal(result?.status, 'completed');
  assert.equal(result?.result, 'Done.');
  assert.equal(result?.files?.length, 1, 'a file named in an earlier step is sent back');
  assert.equal(runner.file!('desk-1', result!.files![0]!.id)?.path, early);
  assert.equal(runner.status('desk-1')?.status, 'completed');
});

test('with no desktop app, a node in its place, or an older desktop asked to write, the node runs the task', async (t) => {
  const node = nodeTasks();
  const store = memoryStore();
  const nobody = externalTaskRunner(node.tasks, store, desktopApp({ port: await closedPort() }));
  assert.deepEqual(await nobody.dispatch(peerTask, 'peer-1'), { taskId: 'node-1', status: 'queued' });
  assert.equal(node.ran[0]!.source, 'device');
  assert.equal(node.ran[0]!.write, true);

  const other = await fakeDesktop(t, desktopRoutes({ 'GET /api/health': health({ role: 'node' }) }));
  await externalTaskRunner(
    node.tasks,
    store,
    desktopApp({ port: other.port, forwardTokenFile: other.tokenFile }),
  ).dispatch(peerTask, 'peer-1');
  assert.equal(node.ran.length, 2);
  assert.equal(other.seen.filter((entry) => entry.method === 'POST').length, 0);

  const older = await fakeDesktop(t, desktopRoutes({ 'GET /api/health': health() }));
  const runner = externalTaskRunner(
    node.tasks,
    store,
    desktopApp({ port: older.port, forwardTokenFile: older.tokenFile }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  assert.equal(node.ran.length, 3, 'an older desktop would take a write as an unknown caller');
  assert.deepEqual(await runner.dispatch({ ...peerTask, write: false }, 'peer-1'), {
    taskId: 'desk-1',
    status: 'queued',
  });
  assert.equal(node.ran.length, 3, 'reading is fine there');
  assert.equal('source' in older.seen.at(-1)!.body!, false);
  const missing = await fakeDesktop(t, desktopRoutes({ 'GET /api/health': health({ role: 'desktop' }) }));
  await externalTaskRunner(
    node.tasks,
    store,
    desktopApp({ port: missing.port, forwardTokenFile: missing.tokenFile + '.missing' }),
  ).dispatch(peerTask, 'peer-1');
  assert.equal(node.ran.length, 4);
  assert.equal(missing.seen.filter((entry) => entry.method === 'POST').length, 0);
});

test('cancel passes through to the desktop app', async (t) => {
  const desktop = await fakeDesktop(
    t,
    desktopRoutes({
      'POST /api/external/tasks/desk-1/cancel': () => ({ body: { taskId: 'desk-1', status: 'cancelled' } }),
    }),
  );
  const runner = externalTaskRunner(
    nodeTasks().tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  assert.equal(runner.cancel('desk-1'), true);
  await until(() => desktop.seen.at(-1)?.path === '/api/external/tasks/desk-1/cancel');
  assert.equal(desktop.seen.at(-1)!.token, 'synthetic-token');
});

test('the desktop app quitting mid-task fails the task with a plain reason and never reruns it', async (t) => {
  const desktop = await fakeDesktop(
    t,
    desktopRoutes({
      'GET /api/external/tasks/desk-1': () => ({
        body: { taskId: 'desk-1', status: 'running', startedAt: '2026-10-20T00:00:00.000Z' },
      }),
    }),
  );
  const node = nodeTasks();
  const store = memoryStore();
  const runner = externalTaskRunner(
    node.tasks,
    store,
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  await until(() => runner.status('desk-1')?.status === 'running');
  await desktop.quit();
  await until(() => runner.status('desk-1')?.status === 'failed');
  assert.match(runner.status('desk-1')!.error!, /关闭了，任务没有重跑/);
  assert.deepEqual(await runner.result('desk-1', 0), {
    status: 'failed',
    error: '设备上的 PugPort 桌面版在任务完成前关闭了，任务没有重跑。',
  });
  assert.equal(node.ran.length, 0, 'not run again on the node');
  // A restarted node still knows how it ended.
  assert.equal(
    externalTaskRunner(
      node.tasks,
      store,
      desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
    ).status('desk-1')?.status,
    'failed',
  );
});

test('a hand-over the desktop app may have taken is never sent a second time', async (t) => {
  const desktop = await fakeDesktop(t, desktopRoutes({ 'POST /api/external/tasks': () => 'hang up' }));
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  const input = { ...peerTask, requestId: 'uncertain-1' };
  await assert.rejects(runner.dispatch(input, 'peer-1'), DesktopUncertain);
  await assert.rejects(runner.dispatch(input, 'peer-1'), /不确定/);
  assert.equal(node.ran.length, 0);
  assert.equal(desktop.seen.filter((entry) => entry.method === 'POST').length, 1);
});

test('the desktop result route adds every step’s file lines for a device node once the task has ended', async (t) => {
  let status = 'running';
  const tasks = {
    result: async () => ({ status, result: 'final' }),
    fullOutputs: () => [
      'step\nPUGPORT_SEND_FILE: /fixture/a.txt\nmore',
      'PUGPORT_SEND_FILE: C:\\fixture\\b.txt\r\nfinal',
    ],
  } as unknown as ExternalTasks;
  const app = express();
  externalTaskRoutes(app, tasks, { root: '.', port: 4317 });
  const server = createServer(app);
  await listenForFetch(server);
  t.after(() => server.close());
  const result = (query: string) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external/tasks/desk-1/result${query}`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
  assert.equal('sendFiles' in (await result('?wait=0&sendFiles=1')), false, 'not before it ends');
  status = 'completed';
  assert.deepEqual(
    ((await result('?wait=0&sendFiles=1')).sendFiles as string[]).map((line) => line.trim()),
    ['PUGPORT_SEND_FILE: /fixture/a.txt', 'PUGPORT_SEND_FILE: C:\\fixture\\b.txt'],
  );
  assert.deepEqual(await result('?wait=0'), { status: 'completed', result: 'final' }, 'other callers see no change');
});

test('a task still waiting when the desktop app closes keeps waiting, and a cancel reaches it when it is back', async (t) => {
  const routes = desktopRoutes({
    'GET /api/external/tasks/desk-1': () => ({ body: { taskId: 'desk-1', status: 'waiting-resource' } }),
    'POST /api/external/tasks/desk-1/cancel': () => ({ body: { taskId: 'desk-1', status: 'cancelled' } }),
  });
  const desktop = await fakeDesktop(t, routes);
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
    { retryMs: 20 },
  );
  await runner.dispatch(peerTask, 'peer-1');
  await until(() => runner.status('desk-1')?.status === 'waiting-resource');
  await desktop.quit();
  // Its queue is saved: the task runs when the app opens again, so it is neither failed nor run here.
  await until(() => /还没开始/.test(runner.status('desk-1')?.note ?? ''));
  assert.equal(runner.status('desk-1')?.status, 'waiting-resource');
  assert.deepEqual(await runner.result('desk-1', 0), { status: 'waiting-resource' });
  assert.equal(runner.cancel('desk-1'), true);
  const reopened = await fakeDesktop(t, routes, desktop.port);
  await until(() => reopened.seen.some((entry) => entry.path === '/api/external/tasks/desk-1/cancel'));
  assert.equal(node.ran.length, 0);
});

test('an error while reading the result never passes for a finished task without its answer', async (t) => {
  const desktop = await fakeDesktop(
    t,
    desktopRoutes({
      'GET /api/external/tasks/desk-1': () => ({
        body: { taskId: 'desk-1', status: 'completed', startedAt: '2026-10-20T00:00:00.000Z' },
      }),
      'GET /api/external/tasks/desk-1/result': () => ({ status: 500, body: { error: 'synthetic failure' } }),
    }),
  );
  const runner = externalTaskRunner(
    nodeTasks().tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  await until(() => runner.status('desk-1')?.status === 'completed');
  assert.deepEqual(await runner.result('desk-1', 0), { status: 'running' });
});

test('a task too long for the desktop app’s API stays on the node whole', async (t) => {
  const desktop = await fakeDesktop(t, desktopRoutes());
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  const task = `${'x'.repeat(49_990)}\nFiles sent to this computer:\n/fixture/a.txt`;
  await runner.dispatch({ ...peerTask, task }, 'peer-1');
  assert.equal(node.ran.length, 1);
  assert.match(String(node.ran[0]!.task), /Files sent to this computer:\n\/fixture\/a\.txt/);
  assert.equal(desktop.seen.filter((entry) => entry.method === 'POST').length, 0);
});

test('desktop tray drops junk lines, rejects junk replies, and uses the session token', async (t) => {
  let body: unknown = {
    lines: [
      { label: 'Codex Work', provider: 'codex', windows: [], observedAt: null },
      { label: 'junk', windows: false },
    ],
  };
  const desktop = await fakeDesktop(t, {
    'GET /api/health': health({ role: 'desktop' }),
    'GET /api/tray': () => ({ body }),
  });
  const client = desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile });
  assert.equal(await client.probe(), 'device');
  assert.equal((await client.tray()).length, 1);
  assert.equal(desktop.seen.find((request) => request.path === '/api/tray')?.token, 'synthetic-token');
  body = { lines: 'junk' };
  await assert.rejects(client.tray());
  body = { lines: [] };
  assert.deepEqual(await client.tray(), []);
  await desktop.quit();
  await assert.rejects(client.tray());
  await assert.rejects(desktopApp({ port: await closedPort() }).tray(), DesktopClosed);
});

test('desktop tray timeout rejects within its two second deadline', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/api/tray') setTimeout(() => res.end(JSON.stringify({ lines: [] })), 3000);
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const started = Date.now();
  await assert.rejects(desktopApp({ port: (server.address() as AddressInfo).port }).tray());
  assert.ok(Date.now() - started < 3000);
});

test('desktop requests prefer the session file and unavailable sessions leave dispatch local', async (t) => {
  const desktop = await fakeDesktop(t, {
    'POST /api/external/tasks': () => ({ status: 201, body: { taskId: 't', status: 'queued' } }),
    'GET /api/tray': () => ({ body: { lines: [] } }),
    'GET /api/external/tasks/t': () => ({ body: { status: 'running' } }),
    'GET /api/external/tasks/t/result': () => ({ body: { status: 'completed' } }),
    'POST /api/external/tasks/t/cancel': () => ({ body: {} }),
  });
  const file = desktop.tokenFile + '.session';
  t.after(publishSessionToken('synthetic-session', desktop.port, file));
  const app = desktopApp({ port: desktop.port, sessionTokenFile: file });
  await app.dispatch({ task: 'x', caller: 'x', write: false, untrusted: false }, 'external');
  await app.tray();
  await app.status('t');
  await app.result('t', 0);
  await app.cancel('t');
  assert.ok(desktop.seen.every((r) => r.token === 'synthetic-session' && r.path !== '/api/session'));
  const denied = await fakeDesktop(t, {
    'GET /api/health': health({ role: 'desktop' }),
  });
  assert.equal(
    await desktopApp({ port: denied.port, sessionTokenFile: file + '.missing' }).dispatch(
      { task: 'x', caller: 'x', write: false, untrusted: false },
      'external',
    ),
    undefined,
  );
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: denied.port, forwardTokenFile: denied.tokenFile, sessionTokenFile: file + '.missing' }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  assert.equal(node.ran.length, 1);
});

test('session-token rejection of a node POST leaves the task on the node', async (t) => {
  const desktop = await fakeDesktop(
    t,
    desktopRoutes({
      'POST /api/external/tasks': () => ({ status: 403, body: { error: 'Local session token required' } }),
    }),
  );
  const node = nodeTasks();
  const runner = externalTaskRunner(
    node.tasks,
    memoryStore(),
    desktopApp({ port: desktop.port, forwardTokenFile: desktop.tokenFile }),
  );
  await runner.dispatch(peerTask, 'peer-1');
  assert.equal(node.ran.length, 1);
});
