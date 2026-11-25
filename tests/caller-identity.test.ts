import assert from 'node:assert/strict';
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { Agent, createServer as createHttpServer, request } from 'node:http';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  callerGuards,
  callerUnknownError,
  callerUnknownRetrySeconds,
  chainHasExecutor,
  executorCaller,
  parseLsof,
  parseNetstat,
  parseNettop,
  parseSs,
  perConnection,
  parseDarwinNetstat,
  walkTable,
} from '../src/server/caller-identity.ts';

// Synthetic `netstat -anv -p tcp` output in the two macOS layouts: a "pid epid" pair, or a "process:pid" column.
const darwinHeader = (owner: string) =>
  'Active Internet connections (including servers)\n' +
  `Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat  ${owner} state  options\n`;
const darwinRow = (proto: string, local: string, foreign: string, owner: string) =>
  `${proto}       0      0  ${local.padEnd(22)} ${foreign.padEnd(22)} ESTABLISHED         1200          800  131072  131072  ${owner} 00102 00000008\n`;
const darwinPid =
  darwinHeader('  pid   epid') +
  darwinRow('tcp4', '127.0.0.1.4317', '127.0.0.2.5000', '   99      0') +
  darwinRow('tcp4', '127.0.0.2.5000', '127.0.0.1.4317', '   42      0') +
  darwinRow('tcp6', 'fd00:1234:5678:9.50123', 'fd00:1234:5678:9.443', '   77      0') +
  darwinRow('tcp4', '*.4317', '*.*', '   99      0');
const darwinNamed =
  darwinHeader('process:pid') +
  darwinRow('tcp4', '127.0.0.1.4317', '127.0.0.2.5000', 'node:99') +
  darwinRow('tcp4', '127.0.0.2.5000', '127.0.0.1.4317', 'curl:42') +
  darwinRow('tcp6', '::ffff:127.0.0.2.5000', '::ffff:127.0.0.1.4317', 'Code Helper:43') +
  darwinRow('tcp6', '::1.5001', '::1.4317', 'node:77');

test('macOS netstat output: the owner column comes from the header, IPv4 and mapped IPv6 rows both count', () => {
  assert.deepEqual(parseDarwinNetstat(darwinPid, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseDarwinNetstat(darwinPid, '127.0.0.1', 4317, 5000), [], 'only the client end, by address');
  assert.deepEqual(parseDarwinNetstat(darwinPid, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(parseDarwinNetstat(darwinNamed, '127.0.0.2', 5000, 4317), [42, 43], 'a name with a space');
  assert.deepEqual(parseDarwinNetstat(darwinNamed, '127.0.0.1', 5001, 4317), [], 'the backend listens on IPv4');
  assert.deepEqual(
    parseDarwinNetstat(darwinRow('tcp4', '127.0.0.2.5000', '127.0.0.1.4317', '42'), '127.0.0.2', 5000, 4317),
    [],
    'no header, no owner column',
  );
  assert.deepEqual(parseDarwinNetstat('', '127.0.0.2', 5000, 4317), []);
});

// Synthetic `nettop -L 1 -n -m tcp -t loopback -J state` output: each process row is followed by its sockets.
const nettop =
  ',state,\n' +
  'node.99,,\n' +
  'tcp4 127.0.0.1:4317<->*:*,Listen,\n' +
  'tcp4 127.0.0.1:4317<->127.0.0.2:5000,Established,\n' +
  'curl.42,,\n' +
  'tcp4 127.0.0.2:5000<->127.0.0.1:4317,Established,\n' +
  'Code Helper, beta.43,,\n' +
  'tcp6 ::ffff:127.0.0.2.5000<->::ffff:127.0.0.1.4317,Established,\n' +
  'tcp6 ::1.5001<->::1.4317,Established,\n';

test('macOS nettop output: a socket belongs to the process row above it, IPv4 and mapped IPv6 rows both count', () => {
  assert.deepEqual(parseNettop(nettop, '127.0.0.2', 5000, 4317), [42, 43], 'a name with a space and a comma');
  assert.deepEqual(parseNettop(nettop, '127.0.0.1', 4317, 5000), [], 'only the client end, by address');
  assert.deepEqual(parseNettop(nettop, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(parseNettop(nettop, '127.0.0.1', 5001, 4317), [], 'the backend listens on IPv4');
  assert.deepEqual(
    parseNettop('tcp4 127.0.0.2:5000<->127.0.0.1:4317,Established,\n', '127.0.0.2', 5000, 4317),
    [],
    'no process row, no owner',
  );
  assert.deepEqual(
    parseNettop(
      'time,,state,\n12:00:00.1,curl.42,,\n12:00:00.2,tcp4 127.0.0.2:5000<->127.0.0.1:4317,Established,\n',
      '127.0.0.2',
      5000,
      4317,
    ),
    [42],
    'a leading time column',
  );
  assert.deepEqual(parseNettop('', '127.0.0.2', 5000, 4317), []);
});

test('on macOS netstat names the caller, and lsof runs only when it cannot, one probe at a time', async () => {
  const options = { remotePort: 5000, localPort: 4317, remoteAddress: '127.0.0.2', platform: 'darwin' as const };
  const table = '42 12\n12 7\n7 1\n';
  const started: string[] = [];
  const netstatFirst = async (file: string) => {
    started.push(file);
    if (file === 'lsof') throw new Error('lsof must not run');
    return file.endsWith('netstat') ? darwinNamed : table;
  };
  assert.equal(await executorCaller({ ...options, owns: (pid) => pid === 7, run: netstatFirst }), true);
  assert.deepEqual(started.sort(), ['/usr/sbin/netstat', 'ps']);

  // An empty netstat table (macOS 27 under an ad-hoc signed ancestor): nettop names the caller, still without lsof.
  started.length = 0;
  const blindNetstat = async (file: string) => {
    started.push(file);
    if (file === 'lsof') throw new Error('lsof must not run');
    return file.endsWith('nettop') ? nettop : file === 'ps' ? table : '';
  };
  assert.equal(await executorCaller({ ...options, owns: (pid) => pid === 7, run: blindNetstat }), true);
  assert.deepEqual(started.sort(), ['/usr/bin/nettop', '/usr/sbin/netstat', 'ps']);

  // A netstat without an owner column falls back to lsof.
  const lsofOutput = 'p42\nn127.0.0.2:5000->127.0.0.1:4317\n';
  const fallback = async (file: string) => (file === 'lsof' ? lsofOutput : file === 'ps' ? table : 'Proto Local');
  assert.equal(await executorCaller({ ...options, owns: (pid) => pid === 12, run: fallback, timeoutMs: 1000 }), true);

  // lsof hangs on an unanswering mount: every request still answers by its deadline, and while that lsof is running
  // no request starts another one.
  let lsofs = 0;
  let exit!: (output: string) => void;
  const hung = (file: string) => {
    if (file !== 'lsof') return Promise.resolve(file === 'ps' ? table : '');
    lsofs++;
    return new Promise<string>((done) => {
      exit = done;
    });
  };
  const began = Date.now();
  const answers = await Promise.all(
    [1, 2, 3].map(() => executorCaller({ ...options, owns: () => true, run: hung, timeoutMs: 50 })),
  );
  assert.deepEqual(answers, [undefined, undefined, undefined]);
  assert.ok(Date.now() - began < 2000, 'answered by the deadline');
  assert.equal(await executorCaller({ ...options, owns: () => true, run: hung, timeoutMs: 50 }), undefined);
  assert.equal(lsofs, 1, 'requests share the running lsof');
  exit('');
  await new Promise((r) => setImmediate(r));
  assert.equal(await executorCaller({ ...options, owns: () => true, run: hung, timeoutMs: 50 }), undefined);
  assert.equal(lsofs, 2, 'a new lsof starts once the old one has exited');
});

test('process output parsers select the peer direction and address, keeping every candidate', () => {
  const netstat =
    '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n' +
    '  TCP    127.0.0.1:4317         127.0.0.2:5000         ESTABLISHED     99\r\n' +
    '  TCP    127.0.0.2:5000         127.0.0.1:4317         ESTABLISHED     42\r\n';
  assert.deepEqual(parseNetstat(netstat, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseNetstat(netstat, '127.0.0.1', 5000, 4317), []);
  assert.deepEqual(parseNetstat(netstat, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(
    parseNetstat(netstat + '  TCP    127.0.0.2:5000  127.0.0.1:4317  ESTABLISHED  43\r\n', '127.0.0.2', 5000, 4317),
    [42, 43],
  );
  const ss =
    '0 0 127.0.0.1:4317 127.0.0.2:5000 users:(("node",pid=99,fd=3))\n' +
    '0 0 127.0.0.2:5000 127.0.0.1:4317 users:(("node",pid=42,fd=3))';
  assert.deepEqual(parseSs(ss, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseSs(ss, '127.0.0.1', 5000, 4317), []);
  assert.deepEqual(parseSs(ss + ',("other",pid=43,fd=4))', '127.0.0.2', 5000, 4317), [42, 43]);
  const lsof = 'p99\nn127.0.0.1:4317->127.0.0.2:5000\np42\nn127.0.0.2:5000->127.0.0.1:4317\n';
  assert.deepEqual(parseLsof(lsof, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseLsof(lsof, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(parseLsof(lsof + 'p43\nf4\nn127.0.0.2:5000->127.0.0.1:4317\n', '127.0.0.2', 5000, 4317), [42, 43]);
});

test('the ancestor walk keeps only live processes and stops at an exited parent', () => {
  // 42 (curl) <- 12 (shell) <- 7 (executor) <- 3 (backend) <- 900, whose parent 4 has exited.
  const table = '42 12\r\n12 7\r\n7 3\r\n3 900\r\n900 4\r\n';
  assert.deepEqual(walkTable(table, 42), [42, 12, 7, 3, 900]);
  assert.deepEqual(walkTable('1 0\n', 1), [1]);
  assert.deepEqual(walkTable('', 42), [42], 'the peer holds the live connection, so it always counts');
  assert.equal(walkTable(Array.from({ length: 20 }, (_, i) => `${i + 1} ${i + 2}`).join('\n'), 1).length, 8);
});

test('chain matches only the backend or an owned process', () => {
  assert.equal(
    chainHasExecutor([2, 3], 3, () => false),
    true,
  );
  assert.equal(
    chainHasExecutor([2, 3], 4, (pid) => pid === 2),
    true,
  );
  assert.equal(
    chainHasExecutor([2, 3], 4, () => false),
    false,
  );
});

test('caller lookup finds an executor ancestor and gives no definite answer on errors, odd addresses and timeouts', async () => {
  const options = { remotePort: 5000, localPort: 4317, remoteAddress: '127.0.0.2', owns: () => false, timeoutMs: 20 };
  assert.equal(
    await executorCaller({
      ...options,
      run: async () => {
        throw new Error('fixture');
      },
    }),
    undefined,
  );
  assert.equal(await executorCaller({ ...options, run: () => new Promise(() => {}) }), undefined);
  const windows = async (file: string) =>
    file.endsWith('netstat.exe')
      ? '  TCP    127.0.0.2:5000   127.0.0.1:4317   ESTABLISHED   42\r\n  TCP    127.0.0.2:5000   127.0.0.1:4317   ESTABLISHED   43\r\n'
      : '42 12\r\n12 1\r\n43 7\r\n7 1\r\n';
  const win = { ...options, platform: 'win32' as const, run: windows };
  assert.equal(await executorCaller({ ...win, owns: (pid) => pid === 7 }), true, 'any sharing process counts');
  assert.equal(await executorCaller({ ...win, owns: () => false }), false);
  assert.equal(await executorCaller({ ...win, owns: () => true, run: async () => 'invalid' }), undefined);
  for (const remoteAddress of [undefined, '::1', '127.0.0.256', "127.0.0.1'; calc"])
    assert.equal(await executorCaller({ ...win, remoteAddress, owns: () => true }), undefined, String(remoteAddress));
});

test('a connection keeps a definite answer and asks again after a failed lookup', async () => {
  const answers: (boolean | undefined)[] = [undefined, true, false];
  let asked = 0;
  const check = perConnection(async (_connection: object) => answers[asked++]);
  const first = {};
  assert.equal(await check(first), 'unknown', 'a failure is its own answer, not "not an executor"');
  assert.deepEqual(
    await Promise.all([check(first), check(first)]),
    ['executor', 'executor'],
    'concurrent requests share one lookup',
  );
  assert.equal(await check(first), 'executor');
  const second = {};
  assert.equal(await check(second), 'other');
  assert.equal(await check(second), 'other');
  assert.equal(asked, 3);
  const failing = perConnection(async (_connection: object) => {
    asked++;
    throw new Error('synthetic lookup failure');
  });
  assert.equal(await failing(first), 'unknown');
  assert.equal(await failing(first), 'unknown');
  assert.equal(asked, 5, 'a lookup that throws is asked again too');
});

test('owner-level writes pass identified callers, refuse executors and ask unidentified callers to retry', async (t) => {
  // What the next lookup answers; 'hang' is a lookup that gives up the way executorCaller's own timeout does.
  let next: boolean | undefined | 'throw' | 'hang' = false;
  let lookups = 0;
  const { callerKind, ownerLevelCaller, refuseExecutors } = callerGuards(async () => {
    lookups++;
    if (next === 'throw') throw new Error('synthetic lookup failure');
    if (next === 'hang')
      return executorCaller({
        remotePort: 5000,
        localPort: 4317,
        remoteAddress: '127.0.0.1',
        owns: () => true,
        run: () => new Promise(() => {}),
        timeoutMs: 20,
      });
    return next;
  });
  const app = express();
  app.use((req, res, done) => {
    res.locals.owner = req.headers['x-pugport-owner'] === 'synthetic-owner';
    done();
  });
  // Mounted the way the backend mounts them: path guards first, then the handlers.
  app.use('/api/conversations/:id/work', refuseExecutors);
  app.delete('/api/conversations/:id', refuseExecutors);
  app.all('/api/conversations/:id/work/lanes', (_req, res) => void res.json({ ok: true }));
  app.delete('/api/conversations/:id', (_req, res) => void res.json({ ok: true }));
  app.post('/api/conversations/:id/messages', async (req, res) => {
    if (!(await ownerLevelCaller(req, res, "PugPort's own executors cannot send messages as the owner."))) return;
    res.status(201).json({ ok: true });
  });
  app.get('/kind', async (req, res) => void res.json({ kind: await callerKind(req) }));
  const server = createHttpServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => {
    agent.destroy();
    server.close();
  });
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; retryAfter?: string; error?: string; code?: string }>((done, fail) => {
      const req = request(
        { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method, agent, headers },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            done({
              status: res.statusCode!,
              retryAfter: res.headers['retry-after'],
              error: (JSON.parse(body) as { error?: string }).error,
              code: (JSON.parse(body) as { code?: string }).code,
            }),
          );
        },
      );
      req.on('error', fail);
      req.end();
    });
  const guarded = [
    ['POST', '/api/conversations/c1/work/lanes', 200],
    ['PATCH', '/api/conversations/c1/work/lanes', 200],
    ['DELETE', '/api/conversations/c1', 200],
    ['POST', '/api/conversations/c1/messages', 201],
  ] as const;
  const fresh = () => agent.destroy();

  // Not identified: refused for now, on every guarded write, and asked again each time on the same connection.
  for (const failure of [undefined, 'throw', 'hang'] as const) {
    next = failure;
    fresh();
    const before = lookups;
    for (const [method, path] of guarded) {
      const refused = await call(method, path);
      assert.equal(refused.status, 503, `${String(failure)} ${method} ${path}`);
      assert.equal(refused.retryAfter, String(callerUnknownRetrySeconds));
      assert.equal(refused.error, callerUnknownError);
      assert.equal(refused.code, 'caller-unknown', 'the code PugPort’s own clients resend on');
    }
    assert.equal(lookups - before, guarded.length, 'an unknown answer is never kept');
    assert.equal((await call('GET', '/kind')).status, 200);
  }
  // The same connection is looked up again and, once identified, goes through.
  next = false;
  const before = lookups;
  for (const [method, path, ok] of guarded) assert.equal((await call(method, path)).status, ok, path);
  assert.equal(lookups - before, 1, 'a definite answer is kept for the connection');

  // An identified executor keeps its 403, by lookup or by its own header.
  next = true;
  fresh();
  for (const [method, path] of guarded) {
    const refused = await call(method, path);
    assert.equal(refused.status, 403, path);
    assert.match(refused.error!, /own executors cannot (act|send messages) as the owner/);
    assert.equal(refused.retryAfter, undefined);
    assert.equal(refused.code, undefined, 'an executor is refused for good');
  }
  next = undefined;
  fresh();
  for (const [method, path] of guarded)
    assert.equal((await call(method, path, { 'x-pugport-executor': '1' })).status, 403, path);

  // The desktop window's owner value needs no lookup, and reads are never held up.
  const asked = lookups;
  for (const [method, path, ok] of guarded)
    assert.equal((await call(method, path, { 'x-pugport-owner': 'synthetic-owner' })).status, ok, path);
  assert.equal((await call('GET', '/api/conversations/c1/work/lanes')).status, 200);
  assert.equal(lookups, asked);
});

test('a real loopback connection from this process is found with the system tools', async (t) => {
  const server = createServer((socket) => socket.on('error', () => {}));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const serverPort = (server.address() as AddressInfo).port;
  const client: Socket = connect(serverPort, '127.0.0.1');
  t.after(() => {
    client.destroy();
    server.close();
  });
  await new Promise<void>((done, fail) => client.once('connect', done).once('error', fail));
  assert.equal(
    await executorCaller({
      remotePort: client.localPort,
      localPort: serverPort,
      remoteAddress: '127.0.0.1',
      owns: () => false,
      timeoutMs: 15000,
    }),
    true,
    'the peer is this test process, which counts as the backend itself',
  );
});

test(
  'on macOS the system tools name a client in another process, without lsof, from a Node parent',
  // A client that never connects would otherwise leave this waiting for its port forever.
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async (t) => {
    // macOS 27 gives netstat an empty table under this ad-hoc signed Node, so this checks the probe that still works.
    const server = createServer((socket) => socket.on('error', () => {}));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const serverPort = (server.address() as AddressInfo).port;
    const client = spawn(
      process.execPath,
      [
        '-e',
        `const s = require('node:net').connect(${serverPort}, '127.0.0.1', () => console.log(s.localPort)); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    t.after(() => {
      client.kill();
      server.close();
    });
    const clientPort = Number(await new Promise<Buffer>((done) => client.stdout.once('data', done)));
    const exec = promisify(execFile);
    const asked: number[] = [];
    const answer = await executorCaller({
      remotePort: clientPort,
      localPort: serverPort,
      remoteAddress: '127.0.0.1',
      owns: (pid) => {
        asked.push(pid);
        return false;
      },
      // lsof stands in for the probe that blocks on an unanswering mount.
      run: async (file, args, timeoutMs) => {
        if (file === 'lsof') throw new Error('lsof must not be needed');
        return (await exec(file, args, { timeout: timeoutMs })).stdout;
      },
      timeoutMs: 15000,
    });
    assert.equal(answer, true, 'the client descends from this test process');
    assert.equal(asked[0], client.pid, 'the peer is the client process');
  },
);
