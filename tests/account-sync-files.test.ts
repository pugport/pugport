import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import { SyncEngine } from '../src/server/account-sync.ts';
import { AccountSyncFiles } from '../src/server/account-sync-files.ts';
import { MemorySyncRemote } from '../src/server/account-sync-remote.ts';
import { createDataKey, readLocalSealKey } from '../src/server/account-sync-crypto.ts';
import { ServerEnrollments } from '../src/server/server-enrollments.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { Devices } from '../src/server/devices/service.ts';
import type { StoredDevice } from '../src/server/devices/store.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' };
const paired = (name: string): StoredDevice => ({
  id: randomUUID(),
  name,
  enrolledServer: name,
  address: '100.100.1.1',
  token: Buffer.alloc(32, name.charCodeAt(0)).toString('base64url'),
  peerId: randomUUID(),
  pairedAt: '2026-11-01T00:00:00Z',
});
function computer(
  t: TestContext,
  remote: MemorySyncRemote,
  entries: StoredDevice[] = [],
  servers: { name: string; ssh?: string }[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-files-test-'));
  const file = join(dir, 'devices.json');
  const serversFile = join(dir, 'remote-servers.json');
  writeFileSync(file, JSON.stringify({ version: 1, devices: entries }));
  writeFileSync(serversFile, JSON.stringify({ servers }));
  let authorization = '';
  const devices = new Devices({
    file,
    selfName: 'synthetic',
    sshAvailable: () => false,
    fetch: (async (_url, init) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch,
  });
  const db = new DatabaseSync(join(dir, 'studio.sqlite'));
  const workspace = new WorkspaceStore(db, { recoverInterrupted: false });
  const local = new SyncStore(workspace, dir);
  const files = new AccountSyncFiles(devices.store, serversFile);
  const sealKey = createDataKey();
  const engine = new SyncEngine({ local, remote, deviceId: randomUUID(), config, files, sealKey });
  t.after(async () => {
    engine.stop();
    await engine.drain();
    await devices.close();
    db.close();
  });
  return { dir, file, serversFile, devices, db, local, engine, remote, sealKey, authorization: () => authorization };
}
async function enable(d: ReturnType<typeof computer>, userId = 'user', allowAccountChange = false) {
  await d.engine.enable({ userId, generation: d.remote.generation, allowAccountChange });
  assert.equal(d.engine.status, 'idle');
}
async function cycle(...computers: ReturnType<typeof computer>[]) {
  for (const computer of computers) {
    await computer.engine.syncNow();
    assert.equal(computer.engine.status, 'idle');
  }
}
test('first pull materializes servers and secrets, devices callable without pairing; no plaintext token in database or views', async (t) => {
  const remote = new MemorySyncRemote();
  const first = paired('alpha'),
    second = paired('beta');
  first.tunnel = { ssh: 'missing', remotePort: 4318 };
  const a = computer(t, remote, [first, second], [{ name: 'one', ssh: 'missing' }, { name: 'two' }]);
  const b = computer(t, remote);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  assert.deepEqual(
    (await b.devices.store.read()).devices.sort((a, b) => a.name.localeCompare(b.name)),
    [first, second],
  );
  assert.equal(JSON.parse(readFileSync(b.serversFile, 'utf8')).servers.length, 2);
  assert.deepEqual(
    await b.devices.request(first.id, { path: '/peer/v1/test', schema: z.object({ ok: z.boolean() }) }),
    { ok: true },
  );
  assert.equal(b.authorization(), `Bearer ${first.token}`);
  for (const d of [a, b]) {
    const tables = d.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const dump = tables
      .map(({ name }) => JSON.stringify(d.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()))
      .join('\n');
    const view = JSON.stringify(await d.devices.view());
    const workspace = Object.assign(Object.create(Workspace.prototype), {
      store: d.local.workspace,
      controller: { dataDir: d.dir },
      folderAvailability: new Map(),
      tastes: { list: () => [] },
    }) as Workspace;
    const state = JSON.stringify(workspace.state());
    for (const device of [first, second]) {
      assert.ok(!dump.includes(device.token));
      assert.ok(!readFileSync(join(d.dir, 'studio.sqlite')).includes(Buffer.from(device.token)));
      assert.ok(!view.includes(device.token));
      assert.ok(!state.includes(device.token));
      assert.ok(!JSON.stringify([...remote.records.values()]).includes(device.token));
    }
  }
  // The pairing token rides beside the record (Vault), never inside the cloud body.
  for (const device of [first, second]) {
    const record = [...remote.records.values()].find((r) => r.kind === 'server-node' && r.id === device.id)!;
    assert.equal(Object.hasOwn(record.body.value, 'token'), false);
    assert.deepEqual(remote.secrets.get(JSON.stringify(['server-node', device.id])), { token: device.token });
    assert.equal(b.devices.store.current().devices.find((d) => d.id === device.id)?.token, device.token);
  }
});
test('lost or untracked sealing keys purge only mirrors and recollect files and cloud-only rows', async (t) => {
  for (const tracked of [true, false]) {
    const remote = new MemorySyncRemote();
    const first = paired('alpha');
    const a = computer(t, remote, [first], [{ name: 'one' }]);
    await enable(a);
    await cycle(a);
    const core = { owner: '', value: { id: 'keep', content: 'keep' }, deleted: false };
    a.local.suppress(() => a.local.apply('memory', 'keep', core));
    a.local.setBase('memory', 'keep', 1, core, 'old');
    const api = { owner: '', value: { id: 'api', key: 'synthetic-api-key' }, deleted: false };
    a.local.suppress(() => a.local.apply('api-provider', 'api', api));
    a.local.enqueue('api-provider', 'api', api);
    a.local.setBase('api-provider', 'api', 2, api, 'old');
    a.local.suppress(() => a.local.apply('api-provider', 'api', { ...api, deleted: true }));
    const manifest = a.local.workspace.get('account-sync-files', 'manifest');
    a.engine.stop();
    await a.engine.drain();
    if (!tracked) a.local.workspace.deleteRecord('account-sync-local', 'seal');
    // The original key is absent in this new secrets directory, as after a lost key file.
    const replacement = await readLocalSealKey(join(a.dir, 'replacement-secrets'));
    assert.deepEqual(await readLocalSealKey(join(a.dir, 'replacement-secrets')), replacement);
    const local = new SyncStore(a.local.workspace, a.dir);
    local.setSealKey(replacement);
    for (const table of ['workspace_records', 'sync_outbox', 'sync_base', 'sync_retained'])
      assert.equal(
        a.db.prepare('SELECT COUNT(*) AS n FROM ' + table + " WHERE kind IN ('server-node','api-provider')").get()!.n,
        0,
      );
    assert.equal(local.cursor, 0);
    assert.deepEqual(local.base('memory', 'keep')?.value, core.value);
    assert.deepEqual(local.workspace.get('account-sync-files', 'manifest'), manifest);
    assert.deepEqual(a.devices.store.current().devices, [first]);
    // A cloud-only mirror must be downloaded even when its seq predates the old cursor.
    const extra = paired('beta');
    const b = computer(t, remote, [extra]);
    await enable(b);
    await cycle(b);
    local.cursor = 9999;
    local.setSealKey(replacement);
    assert.equal(local.cursor, 9999, 'same fingerprint must not purge again');
    local.cursor = 0;
    const engine = new SyncEngine({
      local,
      remote,
      config,
      deviceId: 'replacement',
      sealKey: replacement,
      files: new AccountSyncFiles(a.devices.store, a.serversFile),
    });
    try {
      await engine.enable({ userId: 'user', generation: remote.generation });
      await engine.syncNow();
      assert.equal(engine.status, 'idle');
      assert.equal(local.pending().length, 0);
      assert.equal(a.devices.store.current().devices.length, 2);
      assert.equal(local.current('server-node', first.id)?.value.token, first.token);
      assert.equal(local.current('server-node', extra.id)?.value.token, extra.token);
      assert.deepEqual(local.current('memory', 'keep')?.value, core.value);
    } finally {
      engine.stop();
      await engine.drain();
    }
  }
});

test('delete and re-pair propagate; distinct existing local entries merge', async (t) => {
  const remote = new MemorySyncRemote();
  const first = paired('alpha'),
    second = paired('beta'),
    third = paired('gamma');
  const a = computer(t, remote, [first, second], [{ name: 'one' }, { name: 'two' }]);
  const b = computer(t, remote, [third]);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b, a);
  assert.equal(a.devices.store.current().devices.length, 3);
  await a.devices.store.update((data) => {
    data.devices = data.devices.filter((d) => d.id !== second.id);
    Object.assign(
      data.devices.find((d) => d.id === first.id)!,
      { token: 'Z'.repeat(43), peerId: 'new-peer', pairedAt: '2026-11-02T00:00:00Z' },
    );
  });
  writeFileSync(a.serversFile, JSON.stringify({ servers: [{ name: 'two' }] }));
  await cycle(a, b);
  const entries = b.devices.store.current().devices;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((d) => d.id === first.id)?.token, 'Z'.repeat(43));
  assert.equal(entries.find((d) => d.id === first.id)?.peerId, 'new-peer');
  assert.deepEqual(JSON.parse(readFileSync(b.serversFile, 'utf8')).servers, [{ name: 'two' }]);
});
test('sync off leaves local edits alone; re-enable captures them', async (t) => {
  const remote = new MemorySyncRemote();
  const a = computer(t, remote, [paired('alpha')]);
  await enable(a);
  await cycle(a);
  a.engine.stop();
  const extra = paired('beta');
  await a.devices.store.update((data) => {
    data.devices.push(extra);
  });
  await a.engine.syncNow();
  assert.equal(remote.records.size, 1);
  await enable(a);
  await cycle(a);
  assert.equal(remote.records.size, 2);
});
test('malformed incoming device is rejected before advancing cursor or writing secrets', async (t) => {
  const remote = new MemorySyncRemote();
  const a = computer(t, remote);
  await remote.push(remote.generation, [
    {
      kind: 'server-node',
      id: randomUUID(),
      last_seq: 0,
      device_id: 'bad',
      deleted: false,
      body: { owner: '', value: { id: 'different-id', token: 'secret' }, deleted: false },
    },
  ]);
  await enable(a);
  await a.engine.syncNow();
  assert.match(a.engine.status, /^error:/);
  assert.equal(a.local.cursor, 0);
  assert.deepEqual(a.devices.store.current().devices, []);
});
test('local deletion during a pull is queued next cycle, never resurrected', async (t) => {
  const remote = new MemorySyncRemote();
  const first = paired('alpha');
  const a = computer(t, remote, [first], [{ name: 'server' }]);
  await enable(a);
  await cycle(a);
  const pull = remote.pull.bind(remote);
  let changed = false;
  remote.pull = async (...args) => {
    if (!changed) {
      changed = true;
      await a.devices.store.update((data) => {
        data.devices = [];
      });
      writeFileSync(a.serversFile, JSON.stringify({ servers: [] }));
    }
    return pull(...args);
  };
  await cycle(a, a);
  assert.equal(a.devices.store.current().devices.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(a.serversFile, 'utf8')).servers, []);
  assert.ok([...remote.records.values()].every((record) => record.deleted));
});
test('switch account does not upload former account devices or servers', async (t) => {
  const remote = new MemorySyncRemote();
  const a = computer(t, remote, [paired('alpha')], [{ name: 'private-server' }]);
  await enable(a);
  await cycle(a);
  a.engine.stop();
  writeFileSync(a.serversFile, JSON.stringify({ servers: [{ name: 'private-server', ssh: 'edited' }] }));
  const nextRemote = new MemorySyncRemote(undefined, 'other');
  const next = new SyncEngine({
    local: a.local,
    remote: nextRemote,
    deviceId: 'next',
    config,
    files: new AccountSyncFiles(a.devices.store, a.serversFile),
    sealKey: a.sealKey,
  });

  await next.enable({ userId: 'other', generation: nextRemote.generation, allowAccountChange: true });
  assert.equal(next.status, 'idle');
  await next.syncNow();
  assert.equal(next.status, 'idle');
  assert.equal(nextRemote.records.size, 0);
  next.stop();
  assert.deepEqual(a.devices.store.current().devices, []);
  assert.deepEqual(JSON.parse(readFileSync(a.serversFile, 'utf8')).servers, []);
});
test('cloud reset rebuilds the server mirror from local files', async (t) => {
  const remote = new MemorySyncRemote();
  const original = paired('alpha');
  const a = computer(t, remote, [original]);
  await enable(a);
  await cycle(a);
  a.engine.stop();
  await remote.deleteMyCloudData();
  a.local.resetAfterCloudDeletion();
  await enable(a);
  await cycle(a);
  assert.equal(remote.records.size, 1);
  assert.deepEqual([...remote.secrets.values()], [{ token: original.token }]);
  assert.equal(a.devices.store.current().devices[0].token, original.token);
});
test('old local pairing ids converge by authenticated node identity without replacing local routing ids', async (t) => {
  const remote = new MemorySyncRemote();
  const nodeId = randomUUID();
  const first = { ...paired('alpha'), nodeId };
  const newer = { ...paired('beta'), nodeId, pairedAt: '2026-11-02T00:00:00Z' };
  const a = computer(t, remote, [first]);
  const b = computer(t, remote, [newer]);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b, a, b);
  assert.equal(remote.records.size, 1);
  assert.equal(a.devices.store.current().devices.length, 1);
  assert.equal(b.devices.store.current().devices.length, 1);
  assert.equal(a.devices.store.current().devices[0].id, first.id);
  assert.equal(b.devices.store.current().devices[0].id, newer.id);
  assert.equal(a.devices.store.current().devices[0].token, newer.token);
  assert.equal(b.devices.store.current().devices[0].token, newer.token);
});
test('already synced legacy ids migrate to one stable node record with old tombstones', async (t) => {
  const remote = new MemorySyncRemote();
  const original = paired('alpha');
  const a = computer(t, remote, [original]);
  const b = computer(t, remote);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  const nodeId = randomUUID();
  await a.devices.store.update((data) => {
    data.devices[0].nodeId = nodeId;
  });
  await cycle(a, b, a, b);
  assert.equal([...remote.records.values()].filter((r) => !r.deleted).length, 1);
  assert.equal([...remote.records.values()].find((r) => r.id === original.id)?.deleted, true);
  assert.equal(a.devices.store.current().devices.length, 1);
  assert.equal(b.devices.store.current().devices.length, 1);
  assert.equal(a.devices.store.current().devices[0].id, original.id);
  assert.equal(b.devices.store.current().devices[0].nodeId, nodeId);
});

test('personal pairs never enter sync storage or cloud and remain local with host references', async (t) => {
  const remote = new MemorySyncRemote();
  const personal = paired('personal');
  delete personal.enrolledServer;
  personal.tunnel = { ssh: 'same-alias', remotePort: 4318 };
  const server = paired('enrolled');
  server.tunnel = { ssh: 'same-alias', remotePort: 4318 };
  const a = computer(t, remote, [personal, server], [{ name: server.enrolledServer!, ssh: 'same-alias' }]);
  const b = computer(t, remote);
  await a.devices.store.update((data) => {
    data.slackHost = personal.id;
    data.githubHost = personal.id;
  });
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b, a);
  assert.deepEqual(
    b.devices.store.current().devices.map((d) => d.id),
    [server.id],
  );
  assert.equal(a.devices.store.current().slackHost, personal.id);
  assert.equal(a.devices.store.current().githubHost, personal.id);
  assert.ok(a.devices.store.current().devices.some((d) => d.id === personal.id));
  for (const table of ['workspace_records', 'sync_outbox', 'sync_base', 'sync_retained', 'sync_alias']) {
    const dump = JSON.stringify(a.db.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(!dump.includes(personal.id), table);
    assert.ok(!dump.includes(personal.token), table);
  }
  assert.ok(!JSON.stringify([...remote.records.values()]).includes(personal.id));
  assert.ok([...remote.records.values()].every((r) => r.kind !== 'device'));
});

test('upgrade purges all legacy device mirrors before activation and ignores old cloud values and tombstones', async (t) => {
  const remote = new MemorySyncRemote();
  const personal = paired('personal');
  delete personal.enrolledServer;
  const a = computer(t, remote, [personal]);
  await enable(a);
  a.engine.stop();
  a.local.suppress(() => {
    a.local.workspace.save('device', personal.id, '', personal);
    a.local.enqueue('device', personal.id, { owner: '', value: personal, deleted: false });
    a.local.setBase('device', personal.id, 1, { owner: '', value: personal, deleted: false }, 'old');
    a.db
      .prepare('INSERT INTO sync_retained VALUES(?,?,?)')
      .run('device', personal.id, JSON.stringify({ owner: '', value: personal, deleted: false }));
    a.db.prepare('INSERT INTO sync_alias VALUES(?,?,?)').run('device', personal.id, 'old-id');
    a.local.workspace.save('account-sync-files', 'manifest', '', {
      account: 'user',
      entries: { [JSON.stringify(['device', personal.id])]: 'old-hash' },
    });
  });
  for (const deleted of [false, true])
    await remote.push(remote.generation, [
      {
        kind: 'device',
        id: personal.id + deleted,
        last_seq: 0,
        device_id: 'old',
        deleted,
        body: { owner: '', value: deleted ? {} : personal, deleted },
      },
    ]);
  await enable(a);
  await cycle(a);
  assert.equal(a.local.cursor, 2);
  for (const table of ['workspace_records', 'sync_outbox', 'sync_base', 'sync_retained', 'sync_alias'])
    assert.equal(a.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE kind='device'`).get()!.n, 0);
  assert.ok(!JSON.stringify(a.local.workspace.get('account-sync-files', 'manifest')).includes(personal.id));
  assert.deepEqual(a.devices.store.current().devices, [personal]);
  assert.equal(remote.records.size, 2);
});

test('authenticated server-node without explicit enrollment is rejected', async (t) => {
  const remote = new MemorySyncRemote();
  const personal = paired('personal');
  delete personal.enrolledServer;
  const a = computer(t, remote);
  await remote.push(remote.generation, [
    {
      kind: 'server-node',
      id: personal.id,
      last_seq: 0,
      device_id: 'old',
      deleted: false,
      body: { owner: '', value: personal, deleted: false },
    },
  ]);
  await enable(a);
  await a.engine.syncNow();
  assert.equal(a.engine.status, 'error: INVALID_RECORD');
  assert.equal(a.local.cursor, 0);
  assert.deepEqual(a.devices.store.current().devices, []);
});

test('remote server ids are keyed per account and stable across computers', async (t) => {
  const remote = new MemorySyncRemote();
  const a = computer(t, remote, [], [{ name: 'private-server' }]);
  const b = computer(t, remote);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  const { createHash } = await import('node:crypto');
  const id = [...remote.records.values()][0].id;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(id, 'private-server');
  assert.notEqual(id, createHash('sha256').update('private-server').digest('hex'));
  assert.equal(id, b.local.opaqueId('remote-server', 'private-server'));
  const other = computer(t, new MemorySyncRemote(undefined, 'other'), [], [{ name: 'private-server' }]);
  await enable(other, 'other');
  assert.notEqual(id, other.local.opaqueId('remote-server', 'private-server'));
});

test('upgrade replaces plaintext server ids and old cloud replay preserves one server', async (t) => {
  const remote = new MemorySyncRemote();
  const servers = [{ name: 'legacy-server', ssh: 'synthetic' }];
  const a = computer(t, remote, [], servers);
  const b = computer(t, remote, [], servers);
  const payload = { owner: '', value: servers[0], deleted: false };
  await remote.push(remote.generation, [
    {
      kind: 'remote-server',
      id: servers[0].name,
      last_seq: 0,
      device_id: 'old',
      deleted: false,
      body: payload,
    },
  ]);
  for (const d of [a, b]) {
    await d.local.activate('user');
    d.local.suppress(() => {
      d.local.apply('remote-server', servers[0].name, payload);
      d.local.setBase('remote-server', servers[0].name, 1, payload, 'old');
      d.local.workspace.save('account-sync-files', 'manifest', '', {
        account: 'user',
        entries: { [JSON.stringify(['remote-server', servers[0].name])]: 'legacy' },
      });
    });
  }
  await enable(a);
  await cycle(a);
  assert.equal([...remote.records.values()].find((r) => r.id === servers[0].name)?.deleted, true);
  assert.equal([...remote.records.values()].filter((r) => !r.deleted).length, 1);
  await enable(b);
  await cycle(b, a, b);
  for (const d of [a, b]) assert.deepEqual(JSON.parse(readFileSync(d.serversFile, 'utf8')).servers, servers);
  const fresh = computer(t, remote);
  await enable(fresh);
  await cycle(fresh);
  assert.deepEqual(JSON.parse(readFileSync(fresh.serversFile, 'utf8')).servers, servers);
});

test('one-time local purge drops mirrors sealed with the old cloud key and recaptures them from files', async (t) => {
  const remote = new MemorySyncRemote();
  const node = paired('alpha');
  const a = computer(t, remote, [node], [{ name: 'server' }]);
  await enable(a);
  await cycle(a);
  a.engine.stop();
  // Simulate a database written by the end-to-end encrypted build: unreadable seals and old server ids.
  const stale = { sealedDevice: { v: 1, nonce: 'AAAAAAAAAAAAAAAA', ciphertext: '', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' } };
  a.local.suppress(() => {
    a.db.prepare("UPDATE workspace_records SET value=? WHERE kind='server-node'").run(JSON.stringify(stale));
    a.local.setBase('remote-server', 'f'.repeat(64), 1, { owner: '', value: { name: 'server' }, deleted: false }, 'x');
  });
  a.local.workspace.deleteRecord('account-sync-local', 'format');
  const reopened = new SyncStore(a.local.workspace, a.dir);
  for (const table of ['workspace_records', 'sync_outbox', 'sync_base', 'sync_retained'])
    assert.equal(
      a.db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE kind IN ('server-node','api-provider','remote-server')`)
        .get()!.n,
      0,
      table,
    );
  assert.deepEqual(reopened.workspace.get('account-sync-local', 'format'), { v: 2 });
  assert.equal(a.local.state()?.account, 'user', 'the purge keeps the account and its cursor');
  await enable(a);
  await cycle(a);
  assert.equal(a.local.current('server-node', node.id)?.value.token, node.token);
  assert.deepEqual(a.devices.store.current().devices, [node]);
  assert.deepEqual(JSON.parse(readFileSync(a.serversFile, 'utf8')).servers, [{ name: 'server' }]);
  assert.equal([...remote.records.values()].filter((r) => !r.deleted).length, 2);
});

test('server enrollment opt-out and explicit re-enable sync to another computer', async (t) => {
  const remote = new MemorySyncRemote();
  const a = computer(t, remote, [], [{ name: 'one', ssh: 'one' }]);
  const b = computer(t, remote);
  await enable(a);
  await enable(b);
  await cycle(a, b);
  writeFileSync(a.serversFile, JSON.stringify({ servers: [{ name: 'one', ssh: 'one', enrollmentDisabled: true }] }));
  await cycle(a, b);
  assert.equal(JSON.parse(readFileSync(b.serversFile, 'utf8')).servers[0].enrollmentDisabled, true);
  writeFileSync(b.serversFile, JSON.stringify({ servers: [{ name: 'one', ssh: 'one', enrollmentDisabled: false }] }));
  await cycle(b, a);
  assert.equal(JSON.parse(readFileSync(a.serversFile, 'utf8')).servers[0].enrollmentDisabled, false);
});

test('automatic enrollment on A syncs three callable server names to B without SSH or repeat enrollment', async (t) => {
  const remote = new MemorySyncRemote();
  const names = ['one', 'two', 'three'];
  const a = computer(
    t,
    remote,
    [],
    names.map((name) => ({ name, ssh: name })),
  );
  const b = computer(t, remote);
  await enable(a);
  await enable(b);
  let active = 0,
    peak = 0,
    calls = 0;
  const originalAdd = a.devices.addEnrolled;
  a.devices.addEnrolled = async (value) => {
    const device = paired(value.name!);
    device.tunnel = { ssh: value.name!, remotePort: 4318 };
    await a.devices.store.update((data) => {
      data.devices.push(device);
    });
    return { deviceId: device.id, view: await a.devices.view(), pairingProof: '' };
  };
  const fake = fakeHost('win32');
  const options = { sshAvailable: () => true, delay: async () => {} };
  const jobs = new ServerEnrollments(
    a.serversFile,
    a.devices,
    '/fake',
    fake,
    async (alias, _p, _l, client) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await client.post('/api/devices', { name: alias });
      active--;
      return 0;
    },
    undefined,
    options,
  );
  await jobs.runAutomatic();
  a.devices.addEnrolled = originalAdd;
  assert.equal(calls, 3);
  assert.equal(peak, 1);
  assert.ok(jobs.list().every((job) => job.status === 'completed'));
  await cycle(a, b);
  const other = new ServerEnrollments(
    b.serversFile,
    b.devices,
    '/fake',
    fake,
    async () => {
      calls++;
      return 1;
    },
    undefined,
    options,
  );
  await other.runAutomatic();
  assert.equal(calls, 3);
  // The enrollment push can land while an automatic cycle is still in flight, and a cycle that joined it can capture
  // the pre-enrollment state; repeat the cycle until computer B lists all three servers.
  const listedAt = Date.now();
  while (names.some((name) => b.devices.find(name) === undefined)) {
    const missing = names.filter((name) => b.devices.find(name) === undefined);
    assert.ok(
      Date.now() - listedAt < 10_000,
      `computer B had not listed ${missing.join(', ')} within 10 s after the sync`,
    );
    await delay(10);
    await cycle(a, b);
  }
  assert.equal(calls, 3);
  for (const name of names) {
    const target = b.devices.find(name);
    assert.ok(target);
    assert.deepEqual(
      await b.devices.request(target.id, { path: '/peer/v1/test', schema: z.object({ ok: z.boolean() }) }),
      { ok: true },
    );
  }
});

test('an account access key syncs beside the token: the next computer gets it, never in a body or database', async (t) => {
  const remote = new MemorySyncRemote();
  const server = paired('gamma');
  server.tunnel = { ssh: 'gamma', remotePort: 47820 };
  const a = computer(t, remote, [server], [{ name: 'gamma', ssh: 'gamma' }]);
  const b = computer(t, remote);
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  assert.equal(b.devices.store.current().devices[0]?.access, undefined);

  // Computer A upgrades the server; B, with no SSH setup of its own, receives the key with the pairing.
  const access = JSON.stringify({ version: 1, key: 'SYNTHETIC-PRIVATE-KEY-MARKER' });
  await a.devices.store.update((data) => {
    data.devices[0]!.access = access;
  });
  await cycle(a, b);
  assert.equal(b.devices.store.current().devices[0]?.access, access);
  const record = [...remote.records.values()].find((r) => r.kind === 'server-node' && r.id === server.id)!;
  assert.equal(Object.hasOwn(record.body.value, 'access'), false);
  assert.deepEqual(remote.secrets.get(JSON.stringify(['server-node', server.id])), { token: server.token, access });
  for (const d of [a, b])
    assert.ok(!readFileSync(join(d.dir, 'studio.sqlite')).includes('SYNTHETIC-PRIVATE-KEY-MARKER'));

  // Disconnecting removes the pairing everywhere and the cloud secret with it.
  await a.devices.store.update((data) => {
    data.devices = [];
  });
  await cycle(a, b);
  assert.equal(remote.secrets.has(JSON.stringify(['server-node', server.id])), false);
  assert.deepEqual(b.devices.store.current().devices, []);
});
