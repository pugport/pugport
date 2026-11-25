import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { findInstabox, InstaboxMonitor, instaboxState } from '../src/server/instabox.ts';
import { RemoteServerMonitor, remoteCheckIntervalMs, remoteServerRoutes } from '../src/server/remote-servers.ts';
import { localApiGuard, ownerApiGuard } from '../src/server/local-api-guard.ts';
import { fakeHost, fakeTree, type FakeRun } from './helpers/fake-host.ts';

const machine = {
  id: 'm_fixture1',
  name: 'Fixture',
  state: 'running',
  desiredState: 'running',
  spec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
  template: { id: 'agent-browser' },
  free: true,
};
const host = (run: FakeRun) =>
  fakeHost('linux', { env: { PATH: '/fixture' }, fs: fakeTree({ '/fixture/instabox': 'exec' }), run });

test('discovery skips Windows wrappers and finds the local install or later PATH executable', () => {
  const base = 'C:\\Local';
  const local = `${base}\\Programs\\instabox\\instabox.exe`;
  const cases: Record<string, 'file'>[] = [
    { 'C:\\first\\instabox.cmd': 'file', [local]: 'file' },
    { 'C:\\first\\instabox.bat': 'file', 'C:\\second\\instabox.exe': 'file' },
  ];
  for (const entries of cases) {
    const result = findInstabox(
      fakeHost('win32', { env: { PATH: 'C:\\first;C:\\second', LOCALAPPDATA: base }, fs: fakeTree(entries) }),
    );
    assert.equal(result, local in entries ? local : 'C:\\second\\instabox.exe');
  }
  assert.equal(
    findInstabox(
      fakeHost('win32', { env: { PATH: 'C:\\first' }, fs: fakeTree({ 'C:\\first\\instabox.cmd': 'file' }) }),
    ),
    undefined,
  );
});

test('macOS and Linux discovery use user dirs, follow links, and require execute permission', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const home = platform === 'darwin' ? '/Users/fixture' : '/home/fixture';
    const file = `${home}/.local/bin/instabox`;
    const fixture = fakeHost(platform, {
      env: { PATH: '/first' },
      fs: fakeTree({ '/first/instabox': 'file', [file]: { link: '/actual/instabox' }, '/actual/instabox': 'exec' }),
    });
    assert.equal(findInstabox(fixture), file);
    assert.equal(findInstabox(fakeHost(platform, { fs: fakeTree({ [file]: 'file' }) })), undefined);
  }
});

test('missing binary and signed-out results hide the group and are throttled', async () => {
  assert.equal(await new InstaboxMonitor(fakeHost('linux')).view(true), undefined);
  let calls = 0;
  const monitor = new InstaboxMonitor(
    host(() => {
      calls++;
      throw new Error('not signed in');
    }),
  );
  assert.equal(await monitor.view(true), undefined);
  assert.equal(await monitor.view(true), undefined);
  assert.equal(calls, 1);
});

test('states follow transition targets and preserve unknown strings', () => {
  for (const [state, expected] of [
    ['running', 'running'],
    ['suspended', 'paused'],
    ['paused', 'paused'],
    ['stopped', 'stopped'],
    ['starting', 'starting'],
    ['resuming', 'starting'],
    ['future-state', 'future-state'],
  ])
    assert.equal(instaboxState({ state }), expected);
  for (const [desiredState, expected] of [
    ['running', 'starting'],
    ['suspended', 'pausing'],
    ['paused', 'pausing'],
    ['stopped', 'stopping'],
  ]) {
    assert.equal(instaboxState({ state: desiredState, desiredState, operationId: 'op' }), expected);
    assert.equal(instaboxState({ state: 'different', desiredState }), expected);
  }
});

test('concurrent polls share one ls for every machine and deletions disappear next round', async () => {
  let now = 0;
  let rows = [machine, { ...machine, id: 'm_fixture2' }];
  const calls: string[][] = [];
  const monitor = new InstaboxMonitor(
    host(async (_file, args, options) => {
      calls.push([...args]);
      assert.deepEqual(options, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
      await Promise.resolve();
      return { stdout: JSON.stringify(rows), stderr: '' };
    }),
    () => now,
  );
  assert.equal(await monitor.view(false), undefined);
  const [view] = await Promise.all([monitor.view(true), monitor.view(true)]);
  assert.equal(view?.machines.length, 2);
  assert.equal(view?.machines[0].source, 'instabox');
  assert.equal(view?.machines[0].machineId, machine.id);
  await monitor.view(true);
  assert.deepEqual(calls, [['ls', '--json']]);
  rows = [];
  now += remoteCheckIntervalMs;
  assert.deepEqual(await monitor.view(true), { machines: [] });
  assert.deepEqual(calls, [
    ['ls', '--json'],
    ['ls', '--json'],
  ]);
});

test('network, timeout and malformed JSON keep stale states and checked times without leaking output', async () => {
  let now = 0;
  let reply: string | Error = JSON.stringify([machine]);
  const monitor = new InstaboxMonitor(
    host(() => {
      if (reply instanceof Error) throw reply;
      return { stdout: reply, stderr: '' };
    }),
    () => now,
  );
  const first = await monitor.view(true);
  for (const failure of [
    new Error('network secret-org'),
    Object.assign(new Error('timeout secret-org'), { code: 'ETIMEDOUT' }),
    '{secret-org',
  ]) {
    reply = failure;
    now += remoteCheckIntervalMs;
    const view = await monitor.view(true);
    assert.equal(view?.error, '无法连接 instabox');
    assert.equal(view?.machines[0].state, 'running');
    assert.equal(view?.machines[0].stale, true);
    assert.equal(view?.machines[0].checkedAt, first?.machines[0].checkedAt);
    assert.doesNotMatch(JSON.stringify(view), /secret-org/);
  }
});

test('actions reject invalid inputs before the runner and use only fixed suspend/resume argv', async () => {
  const calls: string[][] = [];
  let state = 'running';
  const monitor = new InstaboxMonitor(
    host((_file, args) => {
      calls.push([...args]);
      return { stdout: JSON.stringify([{ ...machine, state, desiredState: state }]), stderr: '' };
    }),
  );
  await monitor.view(true);
  calls.length = 0;
  for (const input of [
    { machineId: '-bad', action: 'pause' },
    { machineId: machine.id, action: 'ssh' },
    { machineId: machine.id, action: 'pause', extra: true },
    { machineId: machine.id, action: 'wake', extra: true },
    { machineId: '-bad', action: 'wake' },
    { machineId: 'm_unknown', action: 'pause' },
  ])
    await assert.rejects(monitor.action(input));
  assert.equal(calls.length, 0);
  state = 'suspended';
  await monitor.action({ machineId: machine.id, action: 'pause' });
  state = 'running';
  await monitor.action({ machineId: machine.id, action: 'resume' });
  assert.deepEqual(calls, [
    ['suspend', machine.id, '--no-wait'],
    ['ls', '--json'],
    ['resume', machine.id, '--no-wait'],
    ['ls', '--json'],
  ]);
});

test('action waits for older lists, bypasses cache and holds pending state until confirmed', async () => {
  let now = 0;
  let release!: (result: { stdout: string; stderr: string }) => void;
  let listCount = 0;
  const calls: string[][] = [];
  let state = 'running';
  const monitor = new InstaboxMonitor(
    host((_file, args) => {
      calls.push([...args]);
      if (args[0] === 'ls' && ++listCount === 2)
        return new Promise((resolve) => {
          release = resolve;
        });
      return { stdout: JSON.stringify([{ ...machine, state, desiredState: state }]), stderr: '' };
    }),
    () => now,
  );
  await monitor.view(true);
  now += remoteCheckIntervalMs;
  const old = monitor.view(true);
  const action = monitor.action({ machineId: machine.id, action: 'pause' });
  await assert.rejects(monitor.action({ machineId: machine.id, action: 'pause' }), { status: 409 });
  assert.equal(calls.length, 2);
  release({ stdout: JSON.stringify([machine]), stderr: '' });
  await Promise.all([old, action]);
  assert.deepEqual(calls.slice(2), [
    ['suspend', machine.id, '--no-wait'],
    ['ls', '--json'],
  ]);
  assert.equal((await monitor.view(false))?.machines[0].pendingAction, 'pause');
  await assert.rejects(monitor.action({ machineId: machine.id, action: 'pause' }), { status: 409 });
  state = 'suspended';
  now += remoteCheckIntervalMs;
  assert.equal((await monitor.view(true))?.machines[0].pendingAction, undefined);
});

test('HTTP actions require session, origin and owner and refuse executor even with owner', async () => {
  const calls: string[][] = [];
  const monitor = new InstaboxMonitor(
    host((_file, args) => {
      calls.push([...args]);
      return { stdout: JSON.stringify([machine]), stderr: '' };
    }),
  );
  await monitor.view(true);
  calls.length = 0;
  const app = express();
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const authority = `127.0.0.1:${address.port}`;
  app.use(localApiGuard('session', new Set([authority]), new Set([`http://${authority}`])));
  app.use(ownerApiGuard('owner'));
  app.use(express.json());
  remoteServerRoutes(
    app,
    new RemoteServerMonitor(
      'synthetic-missing.json',
      async () => {
        throw new Error('SSH must not run');
      },
      undefined,
      monitor,
    ),
    async (req) => {
      if (req.headers['x-synthetic-lookup'] === 'throws') throw new Error('synthetic lookup failure');
      if (req.headers['x-synthetic-lookup'] === 'unknown') return 'unknown';
      return req.headers['x-pugport-executor'] === '1' ? 'executor' : 'other';
    },
  );
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 400).json({ error: 'Rejected' });
  });
  const post = (headers: Record<string, string>, action = 'pause') =>
    fetch(`http://${authority}/api/remote-servers/instabox/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ machineId: machine.id, action }),
    });
  try {
    const deniedHeaders: Record<string, string>[] = [
      {},
      { 'x-agent-token': 'session' },
      { 'x-agent-token': 'session', 'x-pugport-owner': 'wrong' },
      { 'x-agent-token': 'session', 'x-pugport-executor': '1' },
      { 'x-agent-token': 'session', 'x-pugport-owner': 'owner', 'x-pugport-executor': '1' },
      { 'x-agent-token': 'session', 'x-pugport-owner': 'owner', origin: 'http://evil.invalid' },
    ];
    for (const headers of deniedHeaders) {
      assert.equal((await post(headers)).status, 403);
      assert.equal((await post(headers, 'wake')).status, 403);
    }
    // The owner value from a caller that cannot be identified: refused for now with a retry hint, nothing runs.
    for (const lookup of ['unknown', 'throws']) {
      const refused = await post(
        { 'x-agent-token': 'session', 'x-pugport-owner': 'owner', 'x-synthetic-lookup': lookup },
        'wake',
      );
      assert.equal(refused.status, 503, lookup);
      assert.equal(refused.headers.get('retry-after'), '2');
      assert.match((await refused.json()).error, /could not identify/);
      // Without the owner value the answer stays 403 and no lookup is needed.
      assert.equal((await post({ 'x-agent-token': 'session', 'x-synthetic-lookup': lookup })).status, 403);
    }
    assert.equal(calls.length, 0);
    assert.equal((await post({ 'x-agent-token': 'session', 'x-pugport-owner': 'owner' }, 'wake')).status, 200);
    assert.deepEqual(calls, [['ls', '--json']]);
    calls.length = 0;
    const response = await post({ 'x-agent-token': 'session', 'x-pugport-owner': 'owner' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).instabox.machines.length, 1);
    assert.deepEqual(calls, [
      ['suspend', machine.id, '--no-wait'],
      ['ls', '--json'],
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Discovery runs on a page refresh, so it must not start a login shell or npm.
test('discovery starts no process on any platform', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const spawned: string[] = [];
    const fixture = fakeHost(platform, {
      env: { PATH: '' },
      run: (file) => {
        spawned.push(file);
        return { stdout: '', stderr: '' };
      },
      runSync: (file) => {
        spawned.push(file);
        return '/fixture/bin';
      },
    });
    findInstabox(fixture);
    assert.deepEqual(spawned, [], platform);
  }
});

test('a resumed box that paused itself again before the next list stops showing Resuming', async () => {
  let now = 0;
  const monitor = new InstaboxMonitor(
    host(() => ({
      stdout: JSON.stringify([{ ...machine, state: 'suspended', desiredState: 'suspended' }]),
      stderr: '',
    })),
    () => now,
  );
  await monitor.view(true);
  await monitor.action({ machineId: machine.id, action: 'resume' });
  assert.equal((await monitor.view(false))?.machines[0].pendingAction, 'resume');
  now += remoteCheckIntervalMs;
  const view = await monitor.view(true);
  assert.deepEqual([view?.machines[0].state, view?.machines[0].pendingAction], ['paused', undefined]);
});

test('a failed action refreshes the list at once', async () => {
  const calls: string[][] = [];
  const monitor = new InstaboxMonitor(
    host((_file, args) => {
      calls.push([...args]);
      if (args[0] === 'suspend') throw Object.assign(new Error('timeout'), { stderr: '' });
      return { stdout: JSON.stringify([machine]), stderr: '' };
    }),
    () => 0,
  );
  await monitor.view(true);
  await assert.rejects(monitor.action({ machineId: machine.id, action: 'pause' }), { status: 502 });
  assert.deepEqual(calls, [
    ['ls', '--json'],
    ['suspend', machine.id, '--no-wait'],
    ['ls', '--json'],
  ]);
});
