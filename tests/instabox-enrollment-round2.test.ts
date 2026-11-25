import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ServerEnrollments, serverEnrollmentRoutes } from '../src/server/server-enrollments.ts';
import { fakeHost } from './helpers/fake-host.ts';

test('Round 2 enrollment mutations refuse non-owners and executors before side effects', async () => {
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.owner = req.headers['x-owner'] === 'yes';
    next();
  });
  serverEnrollmentRoutes(
    app,
    {
      start: async () => {
        calls.push('start');
        return {};
      },
      disconnect: async () => {
        calls.push('disconnect');
        return {};
      },
    } as unknown as ServerEnrollments,
    async (req) => (req.headers['x-executor'] === 'yes' ? 'executor' : req.headers['x-executor'] ? 'unknown' : 'other'),
  );
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const path of ['enrollments', 'disconnect']) {
      for (const headers of [{}, { 'x-owner': 'yes', 'x-executor': 'yes' }] as Record<string, string>[]) {
        const result = await fetch(`${base}/api/remote-servers/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ machineId: 'm_fixture1', ...(path === 'disconnect' ? { purge: false } : {}) }),
        });
        assert.equal(result.status, 403);
      }
      // The owner value from a caller that cannot be identified is refused for now, not let through.
      const unknown = await fetch(`${base}/api/remote-servers/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner': 'yes', 'x-executor': 'unknown' },
        body: JSON.stringify({ name: 'fixture', ...(path === 'disconnect' ? { purge: false } : {}) }),
      });
      assert.equal(unknown.status, 503);
      assert.equal(unknown.headers.get('retry-after'), '2');
    }
    assert.deepEqual(calls, []);
    for (const path of ['enrollments', 'disconnect']) {
      const result = await fetch(`${base}/api/remote-servers/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner': 'yes' },
        body: JSON.stringify({ name: 'fixture', ...(path === 'disconnect' ? { purge: false } : {}) }),
      });
      assert.equal(result.status, path === 'enrollments' ? 202 : 200);
    }
    assert.deepEqual(calls, ['start', 'disconnect']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Round 2 enrollment start and disconnect each check reachability once', async () => {
  let checks = 0;
  const devices = {
    enrolledServerDevice: async () => undefined,
    view: async () => ({ devices: [] }),
    remove: async () => ({ devices: [] }),
  };
  const jobs = new ServerEnrollments(
    join(mkdtempSync(join(tmpdir(), 'instabox-enroll-')), 'servers.json'),
    devices as never,
    'fixture',
    fakeHost('win32', {
      run: async () => ({ stdout: '', stderr: '' }),
    }),
    async () => 1,
    {
      server: async (id: string) => {
        assert.equal(id, 'm_fixture1');
        return { name: id, ssh: 'pugport-instabox-1234567' };
      },
      assertReachable: async () => {
        checks++;
      },
    } as never,
  );
  await jobs.start('display name', 'm_fixture1');
  assert.equal(checks, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await jobs.disconnect('display name', false, 'm_fixture1');
  assert.equal(checks, 2);
});
