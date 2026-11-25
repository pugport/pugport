import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { localApiGuard, ownerApiGuard } from '../src/server/local-api-guard.ts';
import { ServerEnrollments, serverEnrollmentRoutes } from '../src/server/server-enrollments.ts';
import { Devices } from '../src/server/devices/service.ts';
import { SshTunnels } from '../src/server/devices/ssh-tunnel.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { removeAccessLines } from '../src/server/devices/managed-access.ts';

const session = 'synthetic-session-token';
const id = 'f0000000-0000-4000-8000-000000000001';
const nodeToken = 'a'.repeat(64);

// Express receives real IncomingMessage and ServerResponse objects over an in-memory duplex, never a socket.
async function request(
  app: express.Express,
  method: string,
  url: string,
  body: object,
  token?: string,
  headers: Record<string, string> = {},
) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const req = new IncomingMessage(socket as Socket);
  req.method = method;
  req.url = url;
  const input = JSON.stringify(body);
  req.headers = {
    host: '127.0.0.1:4317',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(input)),
    ...(token ? { 'x-agent-token': token, 'x-pugport-owner': token } : {}),
    ...headers,
  };
  const res = new ServerResponse(req);
  res.assignSocket(socket as Socket);
  const finished = new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  app(req, res);
  req.complete = true;
  req.push(input);
  req.push(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('request timed out: ' + method + ' ' + url)), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const wire = Buffer.concat(chunks).toString();
  const bodyText = wire.slice(wire.indexOf('\r\n\r\n') + 4);
  return { status: res.statusCode, body: bodyText };
}

test('HTTP guard rejects missing session token and disconnect revokes, closes, and retries uninstall', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-enroll-http-'));
  const file = join(dir, 'remote-servers.json');
  writeFileSync(file, JSON.stringify({ servers: [{ name: 'box', ssh: 'fake-box' }] }));
  const events: string[] = [];
  const tunnels = new SshTunnels();
  tunnels.isOpen = () => true;
  tunnels.ensure = async (alias, port) => {
    events.push(`open:${alias}:${port}`);
    return 47003;
  };
  tunnels.close = async (alias) => {
    events.push('close:' + alias);
  };
  let revoked = false;
  const devices = new Devices({
    file: 'unused',
    selfName: 'synthetic',
    tunnels,
    fetch: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:47003/peer/v1/pairing');
      assert.equal(init?.method, 'DELETE');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer ' + nodeToken);
      events.push('revoke');
      revoked = true;
      return Response.json({ ok: true });
    },
  });
  const data = {
    version: 1 as const,
    devices: [
      {
        id,
        name: 'box',
        enrolledServer: 'box',
        address: '127.0.0.1',
        token: nodeToken,
        peerId: 'peer',
        pairedAt: '',
        tunnel: { ssh: 'fake-box', remotePort: 4318 },
      },
    ],
  };
  devices.store.read = async () => structuredClone(data);
  devices.store.current = () => structuredClone(data);
  devices.store.update = async (mutate) => mutate(data);
  let attempts = 0;
  const host = fakeHost('win32', {
    run: async (command, args, options) => {
      assert.equal(command, 'ssh');
      assert.equal(args.at(-2), 'fake-box');
      assert.equal(
        options?.input,
        [
          'set -eu',
          '(',
          'set -eu',
          ...removeAccessLines(),
          ") || echo 'PugPort access key line could not be removed from authorized_keys.' >&2",
          '~/pugport/bin/pugport node uninstall',
          'rm -rf ~/pugport ~/.local/share/pugport',
        ].join('\n'),
      );
      events.push('uninstall');
      if (++attempts === 1) throw new Error('synthetic offline');
      return { stdout: '', stderr: '' };
    },
  });
  const app = express();
  app.use(
    localApiGuard(
      session,
      new Set(['127.0.0.1:4317', 'localhost:4317']),
      new Set(['http://127.0.0.1:4317', 'http://localhost:4317']),
    ),
  );
  app.use(express.json());
  app.use(ownerApiGuard(session));
  serverEnrollmentRoutes(
    app,
    new ServerEnrollments(file, devices, '/fake', host, async (_alias, _progress, log) => {
      log('synthetic failure');
      return 1;
    }),
    async () => 'other',
  );
  for (const path of ['/api/remote-servers/enrollments', '/api/remote-servers/disconnect']) {
    assert.equal((await request(app, 'POST', path, { name: 'box', purge: true })).status, 403);
    assert.equal((await request(app, 'POST', path, { name: 'box', purge: true }, 'wrong')).status, 403);
  }
  assert.equal(
    (await request(app, 'GET', '/api/remote-servers/enrollments/f0000000-0000-4000-8000-000000000001', {})).status,
    403,
  );
  assert.deepEqual(events, []);
  const first = await request(app, 'POST', '/api/remote-servers/disconnect', { name: 'box', purge: true }, session);
  assert.equal(first.status, 200);
  assert.match(first.body, /synthetic offline/);
  assert.equal(revoked, true);
  assert.deepEqual(events, ['open:fake-box:4318', 'revoke', 'close:fake-box', 'uninstall']);
  assert.equal(data.devices.length, 0);
  const second = await request(app, 'POST', '/api/remote-servers/disconnect', { name: 'box', purge: true }, session);
  assert.equal(second.status, 200);
  assert.doesNotMatch(second.body, /synthetic offline/);
  assert.deepEqual(events, ['open:fake-box:4318', 'revoke', 'close:fake-box', 'uninstall', 'uninstall']);
  const started = await request(app, 'POST', '/api/remote-servers/enrollments', { name: 'box' }, session);
  assert.equal(started.status, 202);
  const job = JSON.parse(started.body).enrollment;
  const progress = await request(app, 'GET', '/api/remote-servers/enrollments/' + job.id, {}, session);
  assert.equal(progress.status, 200);
  assert.equal(JSON.parse(progress.body).enrollment.status, 'failed');
});

test('guard preserves allowed host and origin behavior when the listening port changes', async () => {
  const hosts = new Set(['127.0.0.1:4317', 'localhost:4317']);
  const origins = new Set(['http://127.0.0.1:4317', 'http://localhost:4317']);
  const app = express();
  app.use(localApiGuard(session, hosts, origins));
  app.get('/api/fixture', (_req, res) => res.json({ ok: true }));
  assert.equal((await request(app, 'GET', '/api/fixture', {}, undefined, { host: 'evil.example:4317' })).status, 403);
  assert.equal(
    (await request(app, 'GET', '/api/fixture', {}, undefined, { origin: 'http://evil.example:4317' })).status,
    403,
  );
  assert.equal(
    (
      await request(app, 'GET', '/api/fixture', {}, session, {
        host: 'localhost:4317',
        origin: 'http://localhost:4317',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app, 'GET', '/api/fixture', {}, undefined, {
        host: '127.0.0.1:5555',
        origin: 'http://127.0.0.1:5555',
      })
    ).status,
    403,
  );
  hosts.add('127.0.0.1:5555');
  hosts.add('localhost:5555');
  origins.add('http://127.0.0.1:5555');
  origins.add('http://localhost:5555');
  for (const hostname of ['127.0.0.1', 'localhost']) {
    assert.equal(
      (
        await request(app, 'GET', '/api/fixture', {}, session, {
          host: hostname + ':5555',
          origin: 'http://' + hostname + ':5555',
        })
      ).status,
      200,
    );
  }
});
