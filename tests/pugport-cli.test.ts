import { publishDesktopPort, publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from '../src/cli/args.ts';
import { runAsk } from '../src/cli/ask.ts';
import { run } from '../src/cli/run.ts';
import { APP_VERSION } from '../src/shared/identity.ts';
import { Theme } from '../src/cli/theme.ts';
import {
  BackendError,
  BackendUnavailable,
  notRunningMessage,
  parseEventStream,
  PugPortClient,
} from '../src/cli/client.ts';
import { desktopLaunchPlan, ensureBackend } from '../src/cli/launch.ts';
import { mentionItems, PugAutocomplete, rankMentions } from '../src/cli/mentions.ts';
import { namedIn, calledFields } from '../src/shared/participants.ts';
import { askRequest, messageRouting } from '../src/cli/routing.ts';

test('writable ask recognizes AI ancestors and uses terminal for empty probes', async () => {
  const { askCallerContext } = await import('../src/cli/routing.ts');
  const claude = await askCallerContext('/synthetic/repo', async () => ({
    chain: [{ exe: 'claude', args: [] }],
    envNames: [],
    cwd: '/synthetic/repo',
  }));
  assert.equal(claude.client, 'claude');
  const terminal = await askCallerContext('/synthetic/repo', async () => ({ chain: [], envNames: [] }));
  assert.equal(terminal.client, 'terminal');
  assert.deepEqual(terminal.roots, ['/synthetic/repo']);
  const { inheritedCeiling, callerWrite } = await import('../src/server/caller-ceiling.ts');
  assert.throws(() => callerWrite(inheritedCeiling(claude, '/synthetic/repo', 'read-only'), true), /设为只读/);
});

test('runAsk sends probed identity only for writable requests', async () => {
  const { runAsk } = await import('../src/cli/ask.ts');
  const { createTheme } = await import('../src/cli/theme.ts');
  const bodies: any[] = [];
  let probes = 0;
  const client = {
    post: async (_path: string, body: unknown) => {
      bodies.push(body);
      return { taskId: 'x', status: 'queued' };
    },
    get: async (path: string) =>
      path.includes('/result?') ? { status: 'completed', result: 'ok' } : { status: 'running' },
  } as any;
  const output = { write: (_text: string) => {}, isTTY: false };
  const deps = {
    client,
    cwd: '/synthetic/repo',
    theme: createTheme(output),
    stdout: output,
    stderr: output,
    probe: async () => {
      probes++;
      return { chain: [{ exe: 'claude', args: [] }], envNames: [], cwd: '/synthetic/repo' };
    },
  };
  await runAsk({ task: 'write', write: true }, deps);
  await runAsk({ task: 'read', write: false }, deps);
  await runAsk({ task: 'terminal', write: true }, { ...deps, probe: async () => ({ chain: [], envNames: [] }) });
  assert.equal(bodies[0].callerContext.client, 'claude');
  assert.equal(Object.hasOwn(bodies[1], 'callerContext'), false);
  assert.equal(bodies[2].callerContext.client, 'terminal');
  assert.deepEqual(bodies[2].callerContext.roots, ['/synthetic/repo']);
  assert.equal(probes, 1);
});
import type { RuntimeTarget } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// A synthetic session token: it must reach the fake PugPort, and never the terminal.
const token = 'fixture-session-token-91d4e7';

test('wait arguments validate task ids, timeout and port, and help explains exit codes', async () => {
  assert.deepEqual(parseArgs(['wait', 'a', 'b', '--timeout', '25m', '--json']), {
    kind: 'wait',
    taskIds: ['a', 'b'],
    timeoutMs: 1_500_000,
    json: true,
  });
  assert.deepEqual(parseArgs(['wait', 'a']), { kind: 'wait', taskIds: ['a'], timeoutMs: 540000 });
  assert.deepEqual(parseArgs(['wait', 'a', '--timeout', '90', '--port', '4318']), {
    kind: 'wait',
    taskIds: ['a'],
    timeoutMs: 90000,
    port: 4318,
  });
  assert.deepEqual(parseArgs(['wait']), { kind: 'error', message: 'pugport wait 需要任务 ID。' });
  assert.deepEqual(parseArgs(['tasks', '--timeout', '1m']), {
    kind: 'error',
    message: '--timeout 只用于 pugport wait。',
  });
  for (const duration of ['2d', '0', '86401', '25h', '-1', 'NaN', '']) {
    assert.deepEqual(parseArgs(['wait', 'a', '--timeout', duration]), {
      kind: 'error',
      message: '--timeout 的格式是 90s、25m 或 2h，最长 24h。',
    });
  }
  for (const duration of ['1', '90s', '2h', '24h'])
    assert.equal(parseArgs(['wait', 'a', '--timeout', duration]).kind, 'wait');
  for (const args of [
    ['a/b'],
    ['a'.repeat(81)],
    Array(21).fill('a'),
    ['a', '--write'],
    ['a', '--continue'],
    ['a', '--conversation', 'c'],
    ['a', '--port', '0'],
    ['a', '--port', '65536'],
  ])
    assert.equal(parseArgs(['wait', ...args]).kind, 'error');
  assert.equal(parseArgs(['wait', ...Array(20).fill('a')]).kind, 'wait');
  assert.equal(parseArgs(['tasks', '--port', '4318']).kind, 'error');
  let help = '';
  assert.equal(
    await run(
      { kind: 'help' },
      {
        locale: 'zh-CN',
        stdout: {
          write: (text) => {
            help += text;
          },
        },
      },
    ),
    0,
  );
  assert.match(help, /pugport wait <任务ID>…/);
  assert.match(help, /wait 退出码：0 有任务结束；3 有任务需要主人处理；124 超时；1 出错。/);
});

const card = (id: string, provider: RuntimeTarget['provider'], label: string, enabled = true): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled,
});

test('arguments: chat by default, ask with its task, status/open/help/version, and plain errors', () => {
  assert.deepEqual(parseArgs([]), { kind: 'chat', write: false, continueLast: false });
  assert.deepEqual(parseArgs(['--write', '-c']), { kind: 'chat', write: true, continueLast: true });
  assert.deepEqual(parseArgs(['ask', '总结', '这个项目']), { kind: 'ask', task: '总结 这个项目', write: false });
  assert.deepEqual(parseArgs(['ask', '-w', '--agent', 'Claude', 'fix it']), {
    kind: 'ask',
    task: 'fix it',
    write: true,
    agent: 'Claude',
  });
  assert.deepEqual(parseArgs(['ask', '--agent=Codex', '--', '--not-an-option']), {
    kind: 'ask',
    task: '--not-an-option',
    write: false,
    agent: 'Codex',
  });
  assert.deepEqual(parseArgs(['status']), { kind: 'status' });
  assert.deepEqual(parseArgs(['open']), { kind: 'open' });
  assert.deepEqual(parseArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseArgs(['help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['ask', '--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--version']), { kind: 'version' });
  for (const argv of [['ask'], ['--bogus'], ['hello'], ['--agent', 'x'], ['status', '--write'], ['ask', '--agent']])
    assert.equal(parseArgs(argv).kind, 'error', argv.join(' '));
  assert.match((parseArgs(['hello', 'world']) as { message: string }).message, /pugport ask "hello world"/);
});

test('scriptable arguments', () => {
  assert.deepEqual(parseArgs(['ask', '--json', '-r', 'abc', 'hello', '-']), {
    kind: 'ask',
    task: 'hello',
    write: false,
    json: true,
    resumeId: 'abc',
    stdin: true,
  });
  assert.deepEqual(parseArgs(['ask', '-']), { kind: 'ask', task: '', write: false, stdin: true });
  for (const kind of ['status', 'agents', 'tasks'] as const)
    assert.deepEqual(parseArgs([kind, '--json']), { kind, json: true });
  assert.deepEqual(parseArgs(['cancel', 't', '--json']), { kind: 'cancel', taskId: 't', json: true });
  assert.equal(parseArgs(['cancel', 't', '--agent', 'Claude']).kind, 'error');
  assert.deepEqual(parseArgs(['doctor']), { kind: 'doctor' });
  assert.equal(parseArgs(['ask', '-r']).kind, 'error');
});

test('ask JSON, resume path and settled exit codes', async () => {
  for (const [status, expected] of [
    ['completed', 0],
    ['failed', 1],
    ['cancelled', 1],
    ['blocked', 3],
    ['interrupted', 3],
  ] as const) {
    let path = '';
    let output = '';
    const client = {
      post: async (url: string) => {
        path = url;
        return { taskId: 'task', conversationId: 'a/b' };
      },
      get: async (url: string) =>
        url.includes('/result?') ? { status, result: 'answer' } : { status, executor: 'Claude', model: 'model' },
    } as unknown as PugPortClient;
    const code = await runAsk(
      { task: 'hello', write: false, json: true, resumeId: 'a/b' },
      {
        client,
        cwd: '.',
        theme: new Theme(false),
        stdout: {
          write: (text) => {
            output += text;
          },
        },
        stderr: { write: () => {} },
      },
    );
    assert.equal(path, '/api/external/conversations/a%2Fb/messages');
    assert.equal(code, expected);
    assert.deepEqual(JSON.parse(output), {
      taskId: 'task',
      conversationId: 'a/b',
      status,
      executor: 'Claude',
      model: 'model',
      result: 'answer',
    });
  }
});

test('ask JSON refreshes executor and model after a fast task settles', async () => {
  let reads = 0;
  const client = {
    post: async () => ({ taskId: 'fast', conversationId: 'c' }),
    get: async (path: string) =>
      path.includes('/result?')
        ? { status: 'completed', result: 'ok' }
        : ++reads === 1
          ? { status: 'running' }
          : { status: 'completed', executor: 'Claude', model: 'model' },
  } as unknown as PugPortClient;
  const stdout = captured();
  const stderr = captured();
  assert.equal(
    await runAsk(
      { task: 'hi', write: false, json: true },
      { client, cwd: '.', theme: new Theme(false), stdout, stderr },
    ),
    0,
  );
  assert.equal(reads, 2);
  assert.equal(JSON.parse(stdout.text).executor, 'Claude');
  assert.equal(JSON.parse(stdout.text).model, 'model');
  assert.match(stderr.text, /任务 fast\n/);
});

/** A fake backend client for `run`: records every call, answers from `routes` (by "METHOD path"). */
function fakeClient(routes: Record<string, unknown>, healthy = true) {
  const calls: string[] = [];
  const answer = (call: string) => {
    calls.push(call);
    if (!(call in routes)) throw new Error(`unexpected ${call}`);
    return Promise.resolve(routes[call]);
  };
  const client = {
    health: async () => healthy,
    get: (path: string) => answer(`GET ${path}`),
    post: (path: string, body?: unknown) => {
      calls.push(`body ${JSON.stringify(body)}`);
      return answer(`POST ${path}`);
    },
  } as unknown as PugPortClient;
  return { client, calls };
}
function captured() {
  let text = '';
  return {
    write: (chunk: string) => {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

test('ask -: stdin is the task or follows it after a blank line; over 50 000 characters exits 2 without a request', async () => {
  const done = { status: 'completed', result: 'ok' };
  for (const [argv, input, task] of [
    [['ask', '-'], 'whole task\n', 'whole task\n'],
    [['ask', 'summarize', '-'], 'the log', 'summarize\n\nthe log'],
  ] as const) {
    const { client, calls } = fakeClient({
      'POST /api/external/tasks': { taskId: 't1' },
      'GET /api/external/tasks/t1': done,
      'GET /api/external/tasks/t1/result?wait=5': done,
    });
    const stdout = captured();
    const code = await run(parseArgs(argv), {
      client,
      ensure: async () => {},
      stdin: Readable.from([input.slice(0, 3), input.slice(3)]),
      stdout,
      stderr: captured(),
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, 'ok\n');
    assert.equal(JSON.parse(calls[0]!.slice('body '.length)).task, task);
  }
  // 'x' plus the blank line is 3 characters: the combined length is what counts.
  for (const [argv, input] of [
    [['ask', '-'], 'y'.repeat(50_001)],
    [['ask', 'x', '-'], 'y'.repeat(49_998)],
  ] as const) {
    const { client, calls } = fakeClient({});
    let ensured = false;
    const stderr = captured();
    const code = await run(parseArgs(argv), {
      client,
      ensure: async () => {
        ensured = true;
      },
      stdin: Readable.from([input]),
      stdout: captured(),
      stderr,
    });
    assert.equal(code, 2);
    assert.match(stderr.text, /50000/);
    assert.deepEqual(calls, []);
    assert.equal(ensured, false);
  }
});

test('SIGINT and SIGTERM cancel the external task', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const posts: string[] = [];
    const client = {
      health: async () => true,
      post: async (path: string) => {
        posts.push(path);
        return path === '/api/external/tasks' ? { taskId: 'task/1' } : {};
      },
      get: async () => {
        process.emit(signal, signal);
        throw new Error('aborted');
      },
    } as unknown as PugPortClient;
    const code = await run(parseArgs(['ask', 'hi']), {
      client,
      ensure: async () => {},
      stdout: captured(),
      stderr: captured(),
    });
    assert.equal(code, 130);
    assert.deepEqual(posts, ['/api/external/tasks', '/api/external/tasks/task%2F1/cancel']);
  }
});

test('stdin BOM is removed and the limit uses trimmed combined input', async () => {
  const done = { status: 'completed', result: 'ok' };
  const { client, calls } = fakeClient({
    'POST /api/external/tasks': { taskId: 't1' },
    'GET /api/external/tasks/t1': done,
    'GET /api/external/tasks/t1/result?wait=5': done,
  });
  const code = await run(parseArgs(['ask', '-']), {
    client,
    ensure: async () => {},
    stdin: Readable.from(['\uFEFF ', 'x'.repeat(50000), ' ']),
    stdout: captured(),
    stderr: captured(),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(calls[0]!.slice('body '.length)).task, ` ${'x'.repeat(50000)} `);
});

test('doctor: reports without starting PugPort; 0 when all fine, 1 when one check is not', async () => {
  const healthy = {
    'GET /api/health': { ok: true, version: APP_VERSION },
    'GET /api/external/terminal-command': { installed: true },
    'GET /api/external/agents': { agents: [{ label: 'Claude', status: 'ready' }] },
  };
  for (const [routes, expected] of [
    [healthy, 0],
    [{ ...healthy, 'GET /api/external/terminal-command': { installed: false } }, 1],
    [{ ...healthy, 'GET /api/health': { ok: true, version: '0.0.0-other' } }, 1],
    [{ ...healthy, 'GET /api/external/agents': { agents: [{ label: 'Codex', status: 'auth-required' }] } }, 1],
    [{ ...healthy, 'GET /api/external/agents': { agents: [{ label: 'Codex', status: 'error' }] } }, 1],
    ...['missing', 'unknown', 'refreshing'].map(
      (status) => [{ ...healthy, 'GET /api/external/agents': { agents: [{ label: 'Codex', status }] } }, 0] as const,
    ),
  ] as const) {
    const { client } = fakeClient(routes);
    const stdout = captured();
    const code = await run(
      { kind: 'doctor' },
      {
        client,
        ensure: () => assert.fail('doctor must not start the desktop app'),
        stdout,
        stderr: captured(),
      },
    );
    assert.equal(code, expected, stdout.text);
  }
  const stderr = captured();
  const down = await run(
    { kind: 'doctor' },
    {
      client: fakeClient({}, false).client,
      ensure: () => assert.fail('doctor must not start the desktop app'),
      stdout: captured(),
      stderr,
    },
  );
  assert.equal(down, 1);
  assert.match(stderr.text, /没有在运行/);
});

test('ask --resume: a reply without taskId prints its note on stderr, exits 0 and does not poll', async () => {
  const { client, calls } = fakeClient({
    'POST /api/external/conversations/conv%201/messages': { conversationId: 'conv 1', note: 'sent to the Mac mini' },
  });
  const stdout = captured();
  const stderr = captured();
  const code = await runAsk(
    { task: 'next', write: true, resumeId: 'conv 1' },
    { client, cwd: '.', theme: new Theme(false), stdout, stderr, probe: async () => ({ chain: [], envNames: [] }) },
  );
  assert.equal(code, 0);
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /对话 conv 1\nsent to the Mac mini\n/);
  // A writable follow-up carries the caller context, like a new writable ask.
  assert.deepEqual(calls, [
    'body {"message":"next","write":true,"callerContext":{"client":"terminal","mode":"write","roots":["."],"cwd":".","evidence":["identity: pugport command"],"verified":false}}',
    'POST /api/external/conversations/conv%201/messages',
  ]);
});

test('ask --resume --json reports queued and handed-off replies without polling', async () => {
  for (const reply of [
    { conversationId: 'conv 1', note: 'queued', queued: true },
    { conversationId: 'conv 1', handedTo: 'Mac mini' },
  ]) {
    const { client, calls } = fakeClient({ 'POST /api/external/conversations/conv%201/messages': reply });
    const stdout = captured();
    const stderr = captured();
    const code = await runAsk(
      { task: 'next', write: false, resumeId: 'conv 1', json: true },
      { client, cwd: '.', theme: new Theme(false), stdout, stderr },
    );
    assert.equal(code, 0);
    assert.equal(stdout.text.trimEnd().includes('\n'), false);
    assert.deepEqual(JSON.parse(stdout.text), reply);
    assert.match(stderr.text, /对话 conv 1/);
    if (reply.note) assert.match(stderr.text, /queued/);
    assert.deepEqual(calls, [
      'body {"message":"next","write":false}',
      'POST /api/external/conversations/conv%201/messages',
    ]);
  }
});

test('agents, tasks and cancel: request paths, and --json prints one parsable line', async () => {
  for (const [argv, call] of [
    [['agents', '--json'], 'GET /api/external/agents'],
    [['tasks', '--json'], 'GET /api/external/tasks'],
    [['cancel', 'task/1', '--json'], 'POST /api/external/tasks/task%2F1/cancel'],
    [['agents'], 'GET /api/external/agents'],
  ] as const) {
    const value = { rows: [{ id: 'synthetic', status: 'ready' }] };
    const { client, calls } = fakeClient({ [call]: value });
    const stdout = captured();
    const code = await run(parseArgs(argv), { client, ensure: async () => {}, stdout, stderr: captured() });
    assert.equal(code, 0);
    assert.equal(calls.at(-1), call);
    assert.deepEqual(JSON.parse(stdout.text), value);
    assert.equal(stdout.text.trimEnd().includes('\n'), !(argv as readonly string[]).includes('--json'));
  }
});

test('status --json returns the quota response and rejects cancel with --agent', async () => {
  const quota = { running: 1, lines: [{ id: 'fixture', label: 'Fixture' }], totals: [] };
  const { client, calls } = fakeClient({ 'GET /api/tray': quota });
  const stdout = captured();
  assert.equal(
    await run(parseArgs(['status', '--json']), { client, ensure: async () => {}, stdout, stderr: captured() }),
    0,
  );
  assert.deepEqual(JSON.parse(stdout.text), quota);
  assert.deepEqual(calls, ['GET /api/tray']);

  const rejected = fakeClient({});
  const stderr = captured();
  assert.equal(
    await run(parseArgs(['cancel', 'x', '--agent', 'y']), {
      client: rejected.client,
      ensure: () => assert.fail('must not connect'),
      stdout: captured(),
      stderr,
    }),
    2,
  );
  assert.match(stderr.text, /--agent/);
  assert.deepEqual(rejected.calls, []);
});

test('routing: every message goes through automatic routing unless @ pins a role or an executor', () => {
  const auto = messageRouting({ write: false });
  // The desktop composer's default 自动 state: no runtime, model or effort.
  assert.deepEqual(auto, {
    mode: 'auto',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    allowUnknownQuota: false,
    autoEscalate: true,
  });
  for (const key of ['runtimeId', 'model', 'effort', 'provider']) assert.equal(key in auto, false);
  assert.equal(messageRouting({ write: true }).permissionMode, 'workspace-write');
  assert.deepEqual(
    {
      ...auto,
      ...calledFields([
        { kind: 'role', id: 'investigation', name: '只读调查' },
        { kind: 'executor', id: 'claude-b', name: 'Claude B' },
      ]),
    },
    {
      ...auto,
      participants: [
        { kind: 'role', id: 'investigation' },
        { kind: 'executor', id: 'claude-b' },
      ],
    },
  );
  assert.deepEqual(askRequest({ task: 'hi', projectPath: 'C:\\p', write: false }), {
    task: 'hi',
    projectPath: 'C:\\p',
    caller: 'Terminal',
  });
  assert.deepEqual(askRequest({ task: 'hi', projectPath: '/p', write: true, agent: 'Grok' }), {
    task: 'hi',
    projectPath: '/p',
    caller: 'Terminal',
    write: true,
    callerContext: {
      client: 'terminal',
      mode: 'write',
      roots: ['/p'],
      cwd: '/p',
      evidence: ['identity: pugport command'],
      verified: false,
    },
    agent: 'Grok',
  });
});

test('mentions: roles and enabled executors, ranked by name, found in the text, completed in the editor', async () => {
  const items = mentionItems(
    [],
    [
      card('claude', 'claude', 'Claude · 本机'),
      card('codex-b', 'codex', 'Codex B'),
      card('off', 'grok', 'Grok', false),
    ],
  );
  assert.ok(items.some((item) => item.kind === 'role' && item.id === 'investigation'));
  assert.equal(
    items.some((item) => item.id === 'standard'),
    false,
  );
  const executors = items.filter((item) => item.kind === 'executor').map((item) => item.name);
  assert.deepEqual(executors, ['Claude', 'Codex B']);
  // Names starting with the text first, then ids or names containing it (code-review).
  assert.deepEqual(
    rankMentions(items, 'co').map((item) => item.name),
    ['Codex B', '代码审查'],
  );
  assert.equal(namedIn('请 @Codex B 看看', items)[0]?.id, 'codex-b');
  assert.equal(namedIn('@claude 你好', items)[0]?.id, 'claude');
  assert.equal(namedIn('mail me at a@claude.com', items)[0], undefined);
  assert.equal(namedIn('@只读调查 查一下', items)[0]?.id, 'investigation');

  const provider = new PugAutocomplete(
    [
      { name: 'new', description: '开始新对话' },
      { name: 'status', description: '额度' },
    ],
    () => items,
  );
  const slash = await provider.getSuggestions(['/st'], 0, 3);
  assert.deepEqual(slash, { items: [{ value: '/status', label: '/status', description: '额度' }], prefix: '/st' });
  const at = await provider.getSuggestions(['hi @Cod'], 0, 7);
  assert.equal(at?.prefix, '@Cod');
  assert.equal(at?.items[0]?.value, '@Codex B');
  assert.equal(await provider.getSuggestions(['hi @@Cod'], 0, 8), null);
  let loads = 0;
  const outside = new PugAutocomplete(
    [],
    () => [
      ...items,
      { kind: 'device', id: 'mac', name: 'Mac-mini' },
      { kind: 'external', id: 'muse', name: 'Muse' },
      { kind: 'device', id: 'server', name: 'Fixture-server', tier: 3 },
    ],
    async () => {
      loads++;
    },
  );
  assert.equal((await outside.getSuggestions(['@@Mac'], 0, 5))?.items[0]?.value, '@@Mac-mini');
  assert.equal((await outside.getSuggestions(['@@Muse'], 0, 6))?.items[0]?.value, '@@Muse');
  assert.equal(await outside.getSuggestions(['@@@Muse'], 0, 7), null);
  assert.equal((await outside.getSuggestions(['@@@Fixture'], 0, 10))?.items[0]?.value, '@@@Fixture-server');
  assert.equal(await outside.getSuggestions(['@@Fixture'], 0, 9), null);
  assert.equal(await outside.getSuggestions(['@@@@Muse'], 0, 8), null);
  assert.equal(loads, 5);
  assert.deepEqual(
    namedIn('@Codex B test @@Mac-mini test', [...items, { kind: 'device', id: 'mac', name: 'Mac-mini' }]).map(
      (item) => item.id,
    ),
    ['codex-b', 'mac'],
  );
  assert.equal(await provider.getSuggestions(['plain text'], 0, 10), null);
  assert.deepEqual(provider.applyCompletion(['hi @Cod later'], 0, 7, at!.items[0]!, '@Cod'), {
    lines: ['hi @Codex B later'],
    cursorLine: 0,
    cursorCol: 12,
  });
});

type Seen = { method: string; url: string; token?: string; body?: any };
/** A stand-in for the PugPort backend with recorded requests; `routes` answers anything beyond the session. */
async function fakePugPort(
  t: TestContext,
  routes: (
    req: IncomingMessage,
    body: any,
    reply: (status: number, value: unknown) => void,
    res: ServerResponse,
  ) => boolean | void,
  onStale?: () => void,
) {
  const seen: Seen[] = [];
  let currentToken = token;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const supplied = req.headers['x-agent-token'];
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, url: req.url!, token: typeof supplied === 'string' ? supplied : undefined, body });
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`)
      return reply(403, { error: 'Invalid host' });
    if (req.url === '/api/health') return reply(200, { ok: true, name: 'PugPort', version: 'test' });
    if (supplied !== currentToken) {
      onStale?.();
      return reply(403, { error: 'Local session token required' });
    }
    if (routes(req, body, reply, res) !== true) return;
    reply(404, { error: 'Not found.' });
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  let remove = publishSessionToken(token, port);
  t.after(() => remove());
  return {
    port,
    seen,
    rotate(next: string) {
      currentToken = next;
      remove();
      remove = publishSessionToken(next, port);
    },
  };
}

test('client: the session token goes only on writes, is renewed after a backend restart, and errors stay plain', async (t) => {
  const backend = await fakePugPort(t, (req, body, reply) => {
    if (req.url === '/api/echo') return reply(200, { ok: true, method: req.method, body });
    if (req.url === '/api/broken') return reply(500, { error: '会话不存在或已删除。' });
    return true;
  });
  const client = new PugPortClient(backend.port);
  assert.equal(await client.health(), true);
  assert.deepEqual(await client.get('/api/echo'), { ok: true, method: 'GET' });
  assert.deepEqual(await client.post('/api/echo', { a: 1 }), { ok: true, method: 'POST', body: { a: 1 } });
  backend.rotate('fixture-session-token-rotated');
  assert.deepEqual(await client.post('/api/echo', { b: 2 }), { ok: true, method: 'POST', body: { b: 2 } });
  await assert.rejects(client.post('/api/broken'), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.message, '会话不存在或已删除。');
    return true;
  });
  assert.ok(backend.seen.every((item) => item.url !== '/api/session'));
  assert.ok(
    backend.seen
      .filter((item) => item.method === 'GET' && item.url !== '/api/session' && item.url !== '/api/health')
      .every((item) => item.token),
  );
  const writes = backend.seen.filter((item) => item.method === 'POST');
  assert.deepEqual(
    writes.map((item) => item.token),
    [token, token, 'fixture-session-token-rotated', 'fixture-session-token-rotated'],
  );

  // Nothing listening and no session file (a stopped desktop removes it): one plain sentence, no stack or address.
  const down = new PugPortClient(1);
  assert.equal(await down.health(300), false);
  await assert.rejects(
    down.get('/api/tray'),
    (error: unknown) => error instanceof BackendUnavailable && error.message === notRunningMessage,
  );
});

test('client: server-sent events split across chunks, including one very long data line', async () => {
  const big = JSON.stringify({ runs: 'x'.repeat(300_000), text: '中文' });
  const raw = `: heartbeat\n\nevent: state\ndata: ${big}\n\nevent: run\r\ndata: {"runId":"r1"}\r\n\r\n`;
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Cut inside the multi-byte characters and the line breaks too.
      for (let index = 0; index < bytes.length; index += 7_001) controller.enqueue(bytes.slice(index, index + 7_001));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseEventStream(stream)) events.push(event);
  assert.deepEqual(events, [
    { event: 'state', data: big },
    { event: 'run', data: '{"runId":"r1"}' },
  ]);
});

test('starting the app: start it when the backend is down, wait briefly, otherwise one plain sentence', async (t) => {
  const backend = await fakePugPort(t, () => true);
  let launched = 0;
  await ensureBackend(new PugPortClient(backend.port), { launch: () => (launched++, true) });
  assert.equal(launched, 0, 'a running backend is used as it is');

  await assert.rejects(ensureBackend(new PugPortClient(1), { launch: () => false }), (error: unknown) => {
    return error instanceof BackendUnavailable && error.message === notRunningMessage;
  });
  let starting = 0;
  await assert.rejects(
    ensureBackend(new PugPortClient(1), {
      launch: () => (launched++, true),
      onStarting: () => starting++,
      waitMs: 50,
      sleep: () => new Promise((done) => setTimeout(done, 10)),
    }),
    BackendUnavailable,
  );
  assert.equal(launched, 1);
  assert.equal(starting, 1);
});

test('starting the app: a running desktop that is slow to answer is waited for, never started again', async (t) => {
  // A second start would only bring the owner's window to the front.
  let launched = 0;
  const launch = () => (launched++, true);
  await assert.rejects(
    ensureBackend(new PugPortClient(1), {
      launch,
      running: () => true,
      waitMs: 50,
      sleep: () => new Promise((done) => setTimeout(done, 10)),
    }),
    (error: unknown) => error instanceof BackendError && error.status === 504,
  );
  assert.equal(launched, 0);
  const backend = await fakePugPort(t, () => true);
  const client = new PugPortClient(backend.port);
  const health = client.health.bind(client);
  let checks = 0;
  client.health = async (timeoutMs?: number) => (++checks < 3 ? false : health(timeoutMs));
  await ensureBackend(client, { launch, running: () => true, sleep: async () => {} });
  assert.equal(launched, 0);
  assert.equal(checks, 3);
});

test('starting the app: installed exe, development Electron with the bundled Node, or nothing', () => {
  const { join, delimiter } = win32;
  const env = { ELECTRON_RUN_AS_NODE: '1', Path: 'C:\\Windows', OTHER: 'kept' };
  // Run by the installed PugPort.exe (acting as Node): that same exe opens the app, without the Node flag.
  const installed = desktopLaunchPlan('C:\\PugPort\\resources\\app', {
    platform: 'win32',
    execPath: 'C:\\PugPort\\PugPort.exe',
    electron: true,
    env,
    exists: () => false,
  });
  assert.deepEqual(installed, {
    command: 'C:\\PugPort\\PugPort.exe',
    args: [],
    cwd: 'C:\\PugPort',
    env: { Path: 'C:\\Windows', OTHER: 'kept' },
  });
  // Source checkout run by .runtime\node.exe: the development Electron opens the folder.
  const repo = join('C:', 'repo');
  const files = new Set([
    join(repo, 'node_modules', 'electron', 'path.txt'),
    join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(repo, '.runtime'),
  ]);
  const dev = desktopLaunchPlan(repo, {
    platform: 'win32',
    execPath: join(repo, '.runtime', 'node.exe'),
    electron: false,
    env,
    exists: (path) => files.has(path),
    read: () => 'electron.exe\n',
  });
  assert.equal(dev?.command, join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'));
  assert.deepEqual(dev?.args, [repo]);
  assert.equal(dev?.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(dev?.env.Path, [join(repo, '.runtime'), 'C:\\Windows'].join(delimiter));
  // Installed app run by a plain Node: the exe two folders above the app.
  const exe = join('C:', 'PugPort', 'PugPort.exe');
  const viaNode = desktopLaunchPlan(join('C:', 'PugPort', 'resources', 'app'), {
    platform: 'win32',
    execPath: 'node',
    electron: false,
    env: {},
    exists: (path) => path === exe,
  });
  assert.equal(viaNode?.command, exe);
  assert.equal(desktopLaunchPlan(repo, { execPath: 'node', electron: false, env: {}, exists: () => false }), undefined);
});

test('starting the Mac app: bundled runtime and plain Node resolve the executable inside Contents/MacOS', () => {
  const root = '/Applications/PugPort.app/Contents/Resources/app';
  const executable = '/Applications/PugPort.app/Contents/MacOS/PugPort';
  for (const electron of [false, true]) {
    const plan = desktopLaunchPlan(root, {
      platform: 'darwin',
      execPath: electron ? executable : '/usr/local/bin/node',
      electron,
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin', OTHER: 'kept' },
      exists: (path) => path === executable,
    });
    assert.deepEqual(plan, {
      command: executable,
      args: [],
      cwd: '/Applications/PugPort.app/Contents/MacOS',
      env: { PATH: '/usr/bin', OTHER: 'kept' },
    });
  }
});

type Run = { code: number | null; stdout: string; stderr: string };
// By path, since ask runs from a folder outside the repository.
const tsxLoader = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
function cli(
  t: TestContext,
  args: string[],
  options: { port: number; cwd?: string; executor?: boolean; home?: string },
): Promise<Run> {
  const noFetch = `data:text/javascript;base64,${Buffer.from('globalThis.fetch = () => { process.exit(88); }').toString('base64')}`;
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'pugport-cli-home-'));
  if (!options.home) {
    t.after(() => rmSync(home, { recursive: true, force: true }));
    t.after(publishSessionToken(token, options.port, join(home, '.pugport', `session-${options.port}.json`)));
  }
  const child = spawn(
    process.execPath,
    [
      '--import',
      tsxLoader,
      ...(options.executor ? ['--import', noFetch] : []),
      join(root, 'src', 'cli', 'pugport.ts'),
      ...args,
    ],
    {
      cwd: options.cwd ?? root,
      // PUGPORT_NO_START: the test must never open the real desktop app.
      env: {
        ...process.env,
        PUGPORT_EXECUTOR: options.executor ? '1' : undefined,
        PUGPORT_PORT: String(options.port),
        PUGPORT_NO_START: '1',
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

test('executor cannot ask for a writable task before contacting the backend', async (t) => {
  for (const args of [['ask', '--write', 'synthetic'], ['--write']]) {
    const result = await cli(t, args, { port: 1, executor: true });
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /inside one of PugPort's executors/);
  }
});

test('pugport ask: dispatches as "Terminal" from this folder, shows who took it, prints only the answer', async (t) => {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-ask-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let polls = 0;
  const backend = await fakePugPort(t, (req, body, reply) => {
    if (req.method === 'POST' && req.url === '/api/external/tasks')
      return reply(201, {
        taskId: body.task === 'fail please' ? 'task-2' : 'task-1',
        conversationId: 'conv-1',
        title: `Terminal · ${body.task}`,
        status: 'queued',
      });
    if (req.url === '/api/external/tasks/task-1' || req.url === '/api/external/tasks/task-2')
      return reply(200, {
        taskId: 'task-1',
        status: 'running',
        phase: 'execute',
        executor: 'Claude B',
        model: 'opus-test',
      });
    if (req.url?.startsWith('/api/external/tasks/task-1/result'))
      return reply(200, ++polls < 2 ? { status: 'running' } : { status: 'completed', result: 'the answer' });
    if (req.url?.startsWith('/api/external/tasks/task-2/result'))
      return reply(200, { status: 'failed', error: 'quota ran out' });
    return true;
  });
  const done = await cli(t, ['ask', '--agent', 'Claude', 'hello there'], { port: backend.port, cwd: folder });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout, 'the answer\n');
  assert.match(done.stderr, /已交给 PugPort：Terminal · hello there/);
  assert.match(done.stderr, /Claude B · opus-test/);
  const dispatched = backend.seen.find((item) => item.url === '/api/external/tasks')!;
  assert.deepEqual(dispatched.body, { task: 'hello there', projectPath: folder, caller: 'Terminal', agent: 'Claude' });
  assert.equal(dispatched.token, token);
  assert.ok(backend.seen.some((item) => /result\?wait=\d+/.test(item.url)));

  const home = mkdtempSync(join(tmpdir(), 'pugport-cli-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const removeSession = publishSessionToken(
    token,
    backend.port,
    join(home, '.pugport', `session-${backend.port}.json`),
  );
  t.after(removeSession);
  backend.seen.length = 0;
  const fromFile = await cli(t, ['ask', 'hello there'], { port: backend.port, cwd: folder, home });
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.ok(
    backend.seen.every((item) => item.url === '/api/health' || (item.url !== '/api/session' && item.token === token)),
  );
  assert.ok(backend.seen.some((item) => item.method === 'POST'));
  assert.ok(backend.seen.some((item) => item.method === 'GET' && item.url !== '/api/health'));

  const written = await cli(t, ['ask', '--write', 'synthetic'], { port: backend.port, cwd: folder });
  assert.equal(written.code, 0, written.stderr);
  const postedWrite = backend.seen.find((item) => item.body?.task === 'synthetic')!;
  assert.deepEqual(postedWrite.body.callerContext, {
    client: 'terminal',
    mode: 'write',
    roots: [folder],
    cwd: folder,
    evidence: ['identity: pugport command'],
    verified: false,
  });
  assert.equal(Object.hasOwn(dispatched.body, 'callerContext'), false);

  const failed = await cli(t, ['ask', 'fail please'], { port: backend.port, cwd: folder });
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /没有完成：quota ran out/);
  for (const run of [done, failed]) assert.equal(`${run.stdout}${run.stderr}`.includes(token), false);
});

test('pugport status prints the tray quota; with no backend every command says so in one line', async (t) => {
  const backend = await fakePugPort(t, (req, _body, reply) => {
    if (req.url === '/api/tray')
      return reply(200, {
        running: 1,
        lines: [
          {
            id: 'claude-b',
            label: 'Claude B',
            provider: 'claude',
            windows: [
              { name: '5h', remaining: 60 },
              { name: '周', remaining: 8 },
            ],
            tightest: 8,
            observedAt: new Date().toISOString(),
          },
        ],
        totals: [{ provider: 'claude', accounts: 1, known: 1, total: 0.08 }],
      });
    return true;
  });
  const status = await cli(t, ['status'], { port: backend.port });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /剩余额度 {2}Claude 8%/);
  assert.match(status.stdout, /1 个任务正在运行/);
  assert.match(status.stdout, /Claude B {2}5h 60% · 周 8% {2}刚刚/);
  assert.equal(status.stdout.includes('\x1b['), false, 'NO_COLOR output has no colour codes');

  // Nothing listens on port 1.
  for (const args of [['status'], ['ask', 'hi']]) {
    const down = await cli(t, args, { port: 1 });
    assert.equal(down.code, 1);
    assert.equal(down.stderr.trim(), notRunningMessage);
  }
});

test('client reads the file first and retries POST and GET after rotation', async (t) => {
  const backend = await fakePugPort(t, (req, _body, reply) => {
    if (req.url === '/api/echo') return reply(200, { ok: true });
    return true;
  });
  let remove = publishSessionToken(token, backend.port);
  t.after(() => remove());
  const client = new PugPortClient(backend.port);
  await client.post('/api/echo');
  backend.rotate('rotated-post');
  remove();
  remove = publishSessionToken('rotated-post', backend.port);
  await client.post('/api/echo');
  backend.rotate('rotated-get');
  remove();
  remove = publishSessionToken('rotated-get', backend.port);
  await client.get('/api/echo');
  assert.deepEqual(
    backend.seen.map((r) => (r.url === '/api/session' ? 'session' : r.token)),
    [token, token, 'rotated-post', 'rotated-post', 'rotated-get'],
  );
});

test('client recovers from a live PID stale file token and events reconnect after rotation', async (t) => {
  let file = '';
  const backend = await fakePugPort(
    t,
    (req, _body, reply, res) => {
      if (req.url === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: rotated\n\n');
        return;
      }
      if (req.method === 'POST') return reply(201, { taskId: 't', status: 'queued' });
      if (req.url?.includes('/result')) return reply(200, { status: 'completed', result: 'done' });
      reply(200, { taskId: 't', status: 'running' });
    },
    () => {
      if (file) publishSessionToken(token, backend.port, file);
    },
  );
  const home = mkdtempSync(join(tmpdir(), 'pugport-cli-stale-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  file = join(home, '.pugport', `session-${backend.port}.json`);
  t.after(publishSessionToken('wrong', backend.port, file));
  const result = await cli(t, ['ask', 'synthetic'], { port: backend.port, home });
  assert.ok(backend.seen.some((r) => r.token === 'wrong'));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(backend.seen.some((r) => r.method === 'POST' && r.token === token));
  assert.ok(backend.seen.every((r) => r.url !== '/api/session'));
  const client = new PugPortClient(backend.port);
  await client.get('/fixture');
  backend.rotate('rotated');
  const events = [];
  for await (const event of client.events(new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ event: 'message', data: 'rotated' }]);
});

test('events reconnect after a cached token rotates', async (t) => {
  const backend = await fakePugPort(t, (req, _body, reply, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: rotated\n\n');
      return;
    }
    reply(200, { ok: true });
  });
  const client = new PugPortClient(backend.port);
  await client.get('/fixture');
  backend.rotate('rotated');
  const events = [];
  for await (const event of client.events(new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ event: 'message', data: 'rotated' }]);
});

test('client without a session file still asks PugPort, which says why, and does not retry the same token', async (t) => {
  const backend = await fakePugPort(t, () => true);
  const home = mkdtempSync(join(tmpdir(), 'pugport-cli-missing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await cli(t, ['ask', 'synthetic'], { port: backend.port, home });
  assert.ok(result.stderr.includes('Local session token required'));
  assert.ok(backend.seen.every((r) => r.url !== '/api/session' && r.token === undefined));
  assert.equal(backend.seen.filter((r) => r.method === 'POST').length, 1);
});

async function waitFixture(
  get: (path: string, signal: AbortSignal) => Promise<Record<string, unknown>>,
  options: {
    ids?: string[];
    json?: boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    parentAlive?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  const { runWait } = await import('../src/cli/wait.ts');
  let stdout = '',
    stderr = '';
  const calls: string[] = [];
  const client = {
    get: async (path: string, request: { signal: AbortSignal }) => {
      calls.push(path);
      return get(path, request.signal);
    },
    post: async () => {
      assert.fail('wait must never cancel or post');
    },
  } as unknown as PugPortClient;
  const code = await runWait(
    client,
    { taskIds: options.ids ?? ['t1'], timeoutMs: options.timeoutMs ?? 540000, json: options.json },
    {
      now: options.now ?? (() => Date.parse('2026-10-28T12:00:00Z')),
      sleep: options.sleep,
      parentAlive: options.parentAlive ?? (() => true),
      signal: options.signal,
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
    },
  );
  return { code, stdout, stderr, calls };
}

const oldApproval = { status: 'waiting-approval', startedAt: '2026-10-28T11:55:00Z' };
const pendingWait = (signal: AbortSignal): Promise<Record<string, unknown>> =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('wait keeps old approval baseline and aborts concurrent requests on new approval', async () => {
  let aborted = false;
  const result = await waitFixture(
    async (path, signal) => {
      if (path.endsWith('/t1')) return oldApproval;
      if (path.endsWith('/t2')) return { status: 'running' };
      assert.ok(path.endsWith('/result?wait=50'));
      if (path.includes('/t1/')) {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return pendingWait(signal);
      }
      return { status: 'waiting-approval' };
    },
    { ids: ['t1', 't2'] },
  );
  assert.equal(result.code, 3);
  assert.equal(aborted, true);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    't2 waiting-approval — 等主人在 PugPort 里批准',
    't1 waiting-approval — 等主人在 PugPort 里批准（开始等待前就在等）',
  ]);
});

test('wait returns immediately for completed tasks and fresh approval, with attention winning', async () => {
  for (const [status, expected] of [
    ['completed', 0],
    ['failed', 0],
    ['cancelled', 0],
    ['blocked', 3],
    ['interrupted', 3],
    ['waiting-approval', 3],
    ['waiting-confirmation', 3],
  ] as const) {
    const result = await waitFixture(async () => ({
      status,
      startedAt: '2026-10-28T11:59:50Z',
      executor: 'Synthetic',
      model: 'test-model',
    }));
    assert.equal(result.code, expected, status);
    assert.equal(result.calls.length, 1);
  }
  const both = await waitFixture(async (path) => ({ status: path.endsWith('t1') ? 'completed' : 'blocked' }), {
    ids: ['t1', 't2'],
  });
  assert.equal(both.code, 3);
});

test('wait times out with current progress and ignores waiting-resource', async () => {
  let now = Date.parse('2026-10-28T12:00:00Z');
  const result = await waitFixture(
    async (path) => {
      if (path.includes('/result?')) now += 540001;
      return { status: 'waiting-resource' };
    },
    { now: () => now },
  );
  assert.equal(result.code, 124);
  assert.match(result.stdout, /t1 waiting-resource — 在等有额度的账号/);
  assert.equal(result.stderr, '等了 9 分钟，没有任务需要你。\n');
});

test('wait retries backend outages with backoff and keeps the old approval baseline', async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await waitFixture(
    async (path) => {
      if (!path.includes('/result?')) return oldApproval;
      attempts++;
      if (attempts <= 2) throw new BackendUnavailable();
      if (attempts === 3) return oldApproval;
      return { status: 'completed' };
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(result.stderr, 'PugPort 暂时连不上，继续等…\n');
});

test('wait preserves 403 messages and names missing tasks', async () => {
  for (const [status, message] of [
    [404, 't1 找不到这个任务。'],
    [403, 'synthetic refusal'],
  ] as const) {
    const result = await waitFixture(
      async () => {
        throw new BackendError('synthetic refusal', status);
      },
      { json: true },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `${message}\n`);
    assert.equal(JSON.parse(result.stdout).outcome, 'error');
  }
});

test('wait exits silently when its parent dies before the next request', async () => {
  let alive = false;
  const empty = await waitFixture(
    async () => {
      assert.fail('orphan made a request');
    },
    { parentAlive: () => alive },
  );
  assert.equal(empty.code, 124);
  assert.equal(empty.stdout + empty.stderr, '');
  alive = true;
  const result = await waitFixture(
    async () => {
      alive = false;
      return { status: 'running' };
    },
    { parentAlive: () => alive },
  );
  assert.equal(result.code, 124);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout + result.stderr, '');
});

test('wait JSON includes all task fields and marks old attention as seen', async () => {
  const result = await waitFixture(
    async (path) =>
      path.endsWith('t1')
        ? oldApproval
        : {
            status: 'completed',
            conversationId: 'c2',
            executor: 'Synthetic',
            model: 'test-model',
          },
    { ids: ['t1', 't2'], json: true },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    outcome: 'done',
    waitedSeconds: 0,
    tasks: [
      {
        taskId: 't2',
        conversationId: 'c2',
        status: 'completed',
        need: 'done',
        new: true,
        executor: 'Synthetic',
        model: 'test-model',
        error: null,
      },
      {
        taskId: 't1',
        conversationId: null,
        status: 'waiting-approval',
        need: 'attention',
        new: false,
        executor: null,
        model: null,
        error: null,
      },
    ],
  });
});

test('wait notices an old approval changing away and back', async () => {
  let replies = 0;
  const result = await waitFixture(async () => (++replies === 2 ? { status: 'running' } : oldApproval));
  assert.equal(result.code, 3);
  assert.equal(replies, 3);
  assert.doesNotMatch(result.stdout, /开始等待前/);
});

test('wait SIGINT aborts requests without cancelling the task', async () => {
  const interrupt = new AbortController();
  let aborted = false;
  const result = await waitFixture(
    async (path, signal) => {
      if (!path.includes('/result?')) return { status: 'running' };
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      const pending = pendingWait(signal);
      interrupt.abort();
      return pending;
    },
    { signal: interrupt.signal },
  );
  assert.equal(result.code, 130);
  assert.equal(aborted, true);
});

test('wait deadline aborts an in-flight request', async () => {
  let aborted = false;
  const result = await waitFixture(
    async (path, signal) => {
      if (!path.includes('/result?')) return { status: 'running' };
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return pendingWait(signal);
    },
    { timeoutMs: 10 },
  );
  assert.equal(result.code, 124);
  assert.equal(aborted, true);
});

test('wait aborts a slow initial lookup as soon as another task is completed', async () => {
  let aborted = false;
  const result = await waitFixture(
    async (path, signal) => {
      if (path.endsWith('/t1')) return { status: 'completed' };
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return pendingWait(signal);
    },
    { ids: ['t1', 't2'], timeoutMs: 50 },
  );
  assert.equal(result.code, 0);
  assert.equal(aborted, true);
  assert.equal(result.calls.length, 2);
});

test('wait run never launches the desktop, keeps the running check, and reports the real reason', async () => {
  let stderr = '';
  const code = await run(parseArgs(['wait', 't1', '--port', '4318']), {
    ensure: async (client, options) => {
      assert.equal(client.port, 4318);
      assert.equal(options?.launch?.(), false);
      assert.equal(options?.running, undefined, 'a running desktop is detected as usual');
      throw new BackendUnavailable();
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
  });
  assert.equal(code, 1);
  assert.match(stderr, /^连不上 PugPort：PugPort 没有在运行/);
});

test('pugport wait waits for a running desktop that is slow to answer, through the real client', async (t) => {
  let healthChecks = 0;
  const server = createServer((req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/health') {
      // The first check outlasts the client's 2 s health timeout, as on a busy machine.
      const answer = () => reply(200, { ok: true, name: 'PugPort', version: 'test' });
      if (++healthChecks === 1) return void setTimeout(answer, 2600);
      return answer();
    }
    if (req.url === '/api/external/tasks/busy-task')
      return reply(200, { taskId: 'busy-task', status: 'completed', executor: 'Synthetic', model: 'synthetic-model' });
    reply(404, { error: 'Not found.' });
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  // The files a running desktop publishes: its endpoint (this live process) and its session token.
  t.after(publishSessionToken(token, port));
  t.after(publishDesktopPort(port));
  let stdout = '';
  let stderr = '';
  const code = await run(parseArgs(['wait', 'busy-task', '--port', String(port), '--timeout', '30s']), {
    stdout: { write: (text: string) => ((stdout += text), true) },
    stderr: { write: (text: string) => ((stderr += text), true) },
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^busy-task completed/);
  assert.ok(healthChecks >= 2);
});
