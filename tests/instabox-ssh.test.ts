import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstaboxSsh } from '../src/server/instabox-ssh.ts';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RemoteServerMonitor, remoteServerRoutes } from '../src/server/remote-servers.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'pugport-instabox-ssh-'));
  const data = join(home, 'data');
  await mkdir(join(home, '.ssh'));
  const original = '# owner config\r\nHost personal\r\n  HostName example.invalid\r\n';
  await writeFile(join(home, '.ssh/config'), original);
  let calls = 0;
  const monitor = {
    fresh: async () => monitor.view(),
    view: async () => ({
      machines: [{ machineId: 'm_fixture1', name: 'Box', state: 'running', checkedAt: new Date().toISOString() }],
    }),
    sshConfig: async () => {
      calls++;
      return { id: 'm_fixture1', config: 'Host original\n  HostName box.invalid\n  User fixture\n  Port 22\n' };
    },
  };
  const ssh = new InstaboxSsh(data, monitor as never, home, async () => true);
  return { ssh, home, data, original, calls: () => calls };
}

test('managed SSH is idempotent and restores exact config', async () => {
  const f = await fixture();
  assert.equal(f.calls(), 0);
  assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), f.original);
  const first = await f.ssh.prepare('m_fixture1');
  const second = await f.ssh.prepare('m_fixture1');
  assert.equal(first.ssh, second.ssh);
  assert.ok(first.ssh.length <= 24);
  const config = await readFile(join(f.home, '.ssh/config'), 'utf8');
  assert.equal(config.match(/Include/g)?.length, 1);
  assert.ok(config.endsWith(f.original));
  const managed = await readFile(join(f.home, '.ssh/pugport-instabox.conf'), 'utf8');
  assert.equal(managed.match(/^Host /gm)?.length, 1);
  await f.ssh.remove();
  assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), f.original);
  await assert.rejects(access(join(f.home, '.ssh/pugport-instabox.conf')));
});

test('Round 2 automatic SSH prepare needs no consent and stores no consent flag', async () => {
  const f = await fixture();
  await f.ssh.prepare('m_fixture1');
  const state = JSON.parse(await readFile(join(f.data, 'instabox-ssh.json'), 'utf8'));
  assert.equal('allowed' in state, false);
  await f.ssh.remove();
  assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), f.original);
});

test('Round 2 SSH rejects non-plain values before writing', async () => {
  for (const line of [
    'IdentitiesOnly yes ProxyCommand x',
    'IdentityFile C:\\keys\\',
    'Port 2.2e1',
    'IdentityFile bad\tpath',
  ]) {
    const f = await fixture();
    f.ssh.monitor.sshConfig = async () => ({
      id: 'm_fixture1',
      config: `Host original\n HostName box.invalid\n User fixture\n ${line}\n`,
    });
    await assert.rejects(f.ssh.prepare('m_fixture1'), /Invalid|Unsupported/);
    assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), f.original);
    await assert.rejects(access(join(f.home, '.ssh/pugport-instabox.conf')));
  }
});

test('managed SSH remains removable when CLI listing is unavailable', async () => {
  const f = await fixture();
  await f.ssh.prepare('m_fixture1');
  const view = await f.ssh.decorate(undefined);
  assert.equal(view?.sshManaged, true);
  assert.deepEqual(view?.machines, []);
  await f.ssh.remove();
  assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), f.original);
  assert.equal(await f.ssh.decorate(undefined), undefined);
});

test('managed aliases reject paused, stale and missing machines before opening SSH', async () => {
  const f = await fixture();
  const server = await f.ssh.prepare('m_fixture1');
  await f.ssh.assertReachable(server.ssh);
  for (const patch of [{ state: 'paused' }, { stale: true }, { pendingAction: 'pause' as const }]) {
    f.ssh.monitor.view = async () => ({
      machines: [
        {
          source: 'instabox',
          machineId: 'm_fixture1',
          name: 'Box',
          state: 'running',
          checkedAt: new Date().toISOString(),
          ...patch,
        },
      ],
    });
    await assert.rejects(f.ssh.assertReachable(server.ssh), /paused/);
  }
  f.ssh.monitor.view = async () => ({ machines: [] });
  await assert.rejects(f.ssh.assertReachable(server.ssh), /paused/);
  await f.ssh.assertReachable('ordinary-owner-alias');
});

test('SSH config preserves BOM and CRLF and removal does not overwrite later owner edits', async () => {
  const f = await fixture();
  const original = '\uFEFF' + f.original;
  await writeFile(join(f.home, '.ssh/config'), original);
  await f.ssh.prepare('m_fixture1');
  const configured = await readFile(join(f.home, '.ssh/config'), 'utf8');
  assert.ok(configured.startsWith('\uFEFFInclude '));
  await writeFile(join(f.home, '.ssh/config'), configured + '# later edit\r\n');
  await f.ssh.remove();
  assert.equal(await readFile(join(f.home, '.ssh/config'), 'utf8'), original + '# later edit\r\n');
});

test('managed SSH rejects unmanaged files and proxy commands without overwriting owner data', async () => {
  const f = await fixture();
  const file = join(f.home, '.ssh/pugport-instabox.conf');
  await writeFile(file, 'owner contents');
  await assert.rejects(f.ssh.prepare('m_fixture1'), /ownership/);
  await f.ssh.remove();
  assert.equal(await readFile(file, 'utf8'), 'owner contents');
  const other = await fixture();
  other.ssh.monitor.sshConfig = async () => ({ id: 'm_fixture1', config: 'Host box\n ProxyCommand anything' });
  await assert.rejects(other.ssh.prepare('m_fixture1'), /proxy/);
  assert.equal(await readFile(join(other.home, '.ssh/config'), 'utf8'), other.original);
});

test('SSH prepare and removal routes deny non-owners and executors before mutation', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.owner = req.headers['x-owner'] === 'yes';
    next();
  });
  const monitor = new RemoteServerMonitor(
    join(f.home, 'missing.json'),
    async () => {
      throw new Error('unexpected SSH');
    },
    undefined,
    f.ssh.monitor,
    f.ssh,
  );
  remoteServerRoutes(app, monitor, async (req) => (req.headers['x-executor'] === 'yes' ? 'executor' : 'other'));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    for (const headers of [{}, { 'x-owner': 'yes', 'x-executor': 'yes' }] as Record<string, string>[]) {
      for (const [path, method, body] of [
        ['ssh', 'POST', { machineId: 'm_fixture1' }],
        ['ssh', 'DELETE', {}],
      ] as const) {
        const result = await fetch(`http://127.0.0.1:${address.port}/api/remote-servers/instabox/${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        assert.equal(result.status, 403);
      }
    }
    assert.equal(f.calls(), 0);
    await assert.rejects(access(join(f.data, 'instabox-ssh.json')));
    const allowed = await fetch(`http://127.0.0.1:${address.port}/api/remote-servers/instabox/ssh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner': 'yes' },
      body: JSON.stringify({ machineId: 'm_fixture1' }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('managed entries survive another machine and a rename, and readiness forgets only after wake', async () => {
  const f = await fixture();
  f.ssh.monitor.sshConfig = async (id) => ({ id, config: 'Host old\n HostName box.invalid\n User fixture\n Port 22' });
  const first = await f.ssh.prepare('m_fixture1');
  const second = await f.ssh.prepare('m_fixture2');
  assert.notEqual(first.ssh, second.ssh);
  assert.equal((await f.ssh.prepare('m_fixture1')).ssh, first.ssh);
  const config = await readFile(join(f.home, '.ssh/pugport-instabox.conf'), 'utf8');
  assert.equal(config.match(/^Host /gm)?.length, 2);
  const calls: string[] = [];
  const ready = new InstaboxSsh(
    f.data,
    f.ssh.monitor,
    f.home,
    async (alias) => {
      calls.push('ready:' + alias);
      return true;
    },
    (alias) => calls.push('forget:' + alias),
  );
  assert.deepEqual(calls, []);
  assert.equal(await ready.afterWake('m_fixture1', 10_000), true);
  assert.deepEqual(calls, ['forget:' + first.ssh, 'ready:' + first.ssh]);
});
