import { callerUnknownRetryMs } from '../src/shared/caller-unknown.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { dispatchSchema, followSchema } from '../src/server/external-tasks.ts';
import { permissionLine } from '../src/shared/permission-reason.ts';
import { agentModelLine } from '../src/shared/agent-models.ts';
import { createCallerContext } from '../src/mcp/caller-context.ts';
import { createClientRoots } from '../src/mcp/client-roots.ts';

// All I/O is replaced in memory: no app process, listening port, credential file or network request.
function loadServer(probe: () => Promise<unknown> = async () => ({ chain: [], envNames: [] })) {
  const handlers = new Map<string, (line: string) => void>();
  const replies: any[] = [];
  const posts: any[] = [];
  const source = readFileSync(new URL('../src/mcp/pugport-mcp.ts', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  runInNewContext(code, {
    exports: {},
    module: { exports: {} },
    require(name: string) {
      if (name.endsWith('/desktop-endpoint.ts')) return { readSessionToken: () => 'synthetic' };
      // The wait command looks for a built CLI shim; this fixture has none, so replies carry no command.
      if (name.endsWith('/cli/launch.ts')) return { appRoot: () => '/synthetic-app' };
      if (name === 'node:fs') return { existsSync: () => false };
      if (name === 'node:path') return { resolve: (...parts: string[]) => parts.join('/') };
      if (name.endsWith('/cli/client.ts')) return { backendPort: () => 54321 };
      if (name === 'node:readline')
        return {
          createInterface: () => ({
            on: (name: string, callback: (line: string) => void) => handlers.set(name, callback),
          }),
        };
      if (name.endsWith('/agent-models.ts')) return { agentModelLine };
      if (name.endsWith('/identity.ts')) return { APP_VERSION: 'fixture' };
      if (name.endsWith('/permission-reason.ts')) return { permissionLine };
      if (name.endsWith('/caller-context.ts')) return { createCallerContext };
      if (name.endsWith('/client-roots.ts')) return { createClientRoots };
      if (name.endsWith('/caller-probe.ts')) return { probeCaller: probe };
      if (name.endsWith('/caller-unknown.ts')) return { callerUnknownRetryMs };
      throw new Error(`Unexpected import ${name}`);
    },
    process: {
      env: {},
      ppid: 123,
      stdin: {},
      stdout: { on() {}, write: (line: string) => replies.push(JSON.parse(line)) },
    },
    console,
    AbortController,
    AbortSignal,
    URLSearchParams,
    fetch: async (_url: string, init: any) => {
      if (init.method === 'POST') posts.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () =>
          init.method === 'POST'
            ? { taskId: 'task', conversationId: 'conversation', status: 'queued' }
            : { token: 'synthetic' },
      };
    },
  });
  const line = (message: Record<string, unknown>) =>
    handlers.get('line')!(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const send = async (method: string, params: any = {}) => {
    line({ id: replies.length + 1, method, params });
    await new Promise<void>((done) => setImmediate(done));
    return replies.at(-1);
  };
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { handlers, replies, posts, line, send, settle };
}

test('executor checklist: MCP schemas describe precedence and both tools forward filters unchanged', async () => {
  const { handlers, posts, send } = loadServer();
  const list = await send('tools/list');
  for (const name of ['dispatch_task', 'send_message']) {
    const tool = list.result.tools.find((tool: any) => tool.name === name);
    assert.equal(tool.inputSchema.properties.executors.type, 'array');
    assert.equal(tool.inputSchema.properties.exclude.items.type, 'string');
    assert.match(tool.inputSchema.properties.executors.description, /Overrides the conversation\/global/);
    assert.match(tool.inputSchema.properties.exclude.description, /Explicit agent\/@\@ pins/);
  }
  const filters = { executors: ['Codex', 'Codex B'], exclude: ['claude'] };
  await send('tools/call', { name: 'dispatch_task', arguments: { task: 'Read this', ...filters } });
  await send('tools/call', {
    name: 'send_message',
    arguments: { conversation_id: 'conversation', message: 'Read this too', ...filters },
  });
  assert.deepEqual(
    posts.map(({ executors, exclude }) => ({ executors, exclude })),
    [filters, filters],
  );
  assert.deepEqual(dispatchSchema.parse({ task: 'Read this', ...filters }).executors, filters.executors);
  assert.deepEqual(followSchema.parse({ message: 'Read this too', ...filters }).exclude, filters.exclude);
  assert.throws(() => dispatchSchema.parse({ task: 'x', executors: 'codex' }));
  assert.throws(() => followSchema.parse({ message: 'x', exclude: [42] }));
  handlers.get('close')!('');
});

test('executor checklist: Claude Code roots reach the dispatch body; other clients are never asked', async () => {
  const windows = process.platform === 'win32';
  const cwd = windows ? 'C:\\synthetic\\repo' : '/synthetic/repo';
  const added = windows ? 'C:\\synthetic\\added' : '/synthetic/added';
  const probe = async () => ({ chain: [{ exe: 'claude', args: [] }], envNames: [], cwd });
  for (const name of ['claude-code', 'synthetic-client']) {
    const server = loadServer(probe);
    await server.send('initialize', { capabilities: { roots: {} }, clientInfo: { name } });
    server.line({ method: 'notifications/initialized' });
    server.line({ id: 'call', method: 'tools/call', params: { name: 'dispatch_task', arguments: { task: 'Write' } } });
    const asks = () => server.replies.filter((reply) => reply.method === 'roots/list');
    if (name === 'claude-code') {
      await server.settle(() => asks().length > 0);
      for (const ask of asks()) server.line({ id: ask.id, result: { roots: [{ uri: pathToFileURL(added).href }] } });
    }
    // Without the answer routed back, the call would wait out the roots timeout and post no added folder.
    await server.settle(() => server.posts.length > 0);
    assert.equal(server.posts.length, 1, name);
    assert.deepEqual(server.posts[0].callerContext.roots, name === 'claude-code' ? [cwd, added] : [cwd]);
    if (name !== 'claude-code') assert.equal(asks().length, 0);
    server.handlers.get('close')!('');
  }
});
