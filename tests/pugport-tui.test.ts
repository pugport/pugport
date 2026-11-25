import { publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { TerminalChat, conversationTitle } from '../src/cli/chat.ts';
import { PugPortClient } from '../src/cli/client.ts';
import { ChatFooter, PugEditor, PugHeader, ReplyBlock, shortPath } from '../src/cli/components.ts';
import { applyRunEvent, newLiveRun, replyView } from '../src/cli/conversation-view.ts';
import { stripTerminalSequences, TuiMainScreen, visibleWidth, type Terminal, type TUI } from '../src/cli/pi-tui.ts';
import { pugLogoLines, pugLogoWidth } from '../src/cli/pug-logo.ts';
import { Theme } from '../src/cli/theme.ts';
import { terminalCommandRoutes } from '../src/server/terminal-command.ts';
import type { RunRecord, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const plain = new Theme(false);
const colored = new Theme(true, 'dark', 'truecolor');
const text = (lines: readonly string[]) => stripTerminalSequences(lines.join('\n'));

/** An in-memory terminal: records what the TUI writes and lets the test type. */
class FakeTerminal implements Terminal {
  output = '';
  title = '';
  private onInput?: (data: string) => void;
  constructor(
    readonly columns = 100,
    readonly rows = 40,
  ) {}
  start(onInput: (data: string) => void) {
    this.onInput = onInput;
  }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.output += data;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(title: string) {
    this.title = title;
  }
  setProgress() {}
  setProgramStatus() {}
  type(data: string) {
    this.onInput?.(data);
  }
  get screen() {
    return stripTerminalSequences(this.output);
  }
}

async function until(check: () => boolean, what: string, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('the pug: half-block pixels in colour, a line drawing without colour, always the same width', () => {
  const drawn = pugLogoLines({ color: true, mode: 'truecolor' });
  assert.equal(drawn.length, 9);
  assert.ok(drawn.join('').includes('▀'));
  assert.ok(drawn.every((line) => stripTerminalSequences(line).length === pugLogoWidth));
  const line = pugLogoLines({ color: false });
  assert.ok(line.every((row) => !row.includes('\x1b') && row.length === pugLogoWidth));
  assert.match(line.join('\n'), /\(@\) {2}\(@\)/);
});

test('header: the pug beside name, quota and mode; one line face on narrow terminals; no colour codes with NO_COLOR', () => {
  const info = () => ({ version: '9.9.9', write: false, quota: 'Claude 60% · Codex 140%' });
  const wide = new PugHeader(colored, info).render(100);
  assert.ok(wide.length >= 9, 'logo height');
  assert.ok(wide.join('').includes('▀'));
  const shown = text(wide);
  assert.match(shown, /PugPort v9\.9\.9/);
  assert.match(shown, /额度 Claude 60% · Codex 140%/);
  assert.match(shown, /只读/);
  assert.match(shown, /Esc 取消回复/);
  const narrow = new PugHeader(plain, () => ({ ...info(), write: true })).render(50);
  // Only the plain reset that ends a cut line; no colours.
  assert.equal(narrow.join('\n').replaceAll('\x1b[0m', '').includes('\x1b'), false);
  assert.match(narrow[0]!, /\(•ᴥ•\) PugPort v9\.9\.9/);
  assert.match(narrow.join('\n'), /可修改这个文件夹里的文件/);
  assert.ok(narrow.every((row) => visibleWidth(row) <= 50));
});

test('footer: folder and mode, then quota on the left and the account that answered last on the right', () => {
  const home = process.env.USERPROFILE || process.env.HOME || '/home/user';
  assert.equal(shortPath(join(home, 'code', 'app'), home), join('~', 'code', 'app'));
  assert.equal(shortPath(home, home), '~');
  assert.equal(shortPath(join(home, '..', 'elsewhere'), home), join(home, '..', 'elsewhere'));
  const footer = new ChatFooter(plain, () => ({
    cwd: join(home, 'code', 'app'),
    write: true,
    title: 'Terminal · hi',
    quota: 'Claude 60%',
    last: 'Claude B · opus-test',
  })).render(80);
  assert.equal(footer.length, 2);
  assert.match(footer[0]!, /code.app • 可改文件 • Terminal · hi/);
  assert.match(footer[1]!, /^额度 Claude 60% +上一条：Claude B · opus-test$/);
  assert.equal(visibleWidth(footer[1]!), 80);

  // A long folder is cut from the front, here through a wide character; the mode and a lost connection stay.
  const [place] = new ChatFooter(plain, () => ({
    cwd: join(home, 'Projects', 'a-very-long-folder-name', '.claude', '工作树', 'some-task-4293f7'),
    write: true,
    title: 'Terminal · hi',
    quota: '',
    offline: '正在重新连接 PugPort…',
  })).render(60);
  assert.match(text([place!]), /^….*some-task-4293f7 • 可改文件 • 正在重新连接 PugPort… • …$/);
  assert.equal(visibleWidth(place!), 60);
});

test('a reply: who answered, its tool calls, then the answer as Markdown; failures show the reason', () => {
  const live = newLiveRun();
  applyRunEvent(live, {
    seq: 1,
    at: '',
    type: 'tool',
    text: 'Read',
    data: { toolCallId: 't1', tool: 'Read', path: 'src/a.ts', status: 'inProgress' },
  });
  applyRunEvent(live, { seq: 2, at: '', type: 'tool', text: 'Read', data: { toolCallId: 't1', status: 'completed' } });
  applyRunEvent(live, { seq: 3, at: '', type: 'text', text: '## Done\n\nAll **good**.' });
  // A replayed event is ignored.
  assert.equal(applyRunEvent(live, { seq: 3, at: '', type: 'text', text: 'again' }), false);
  const workflow = {
    id: 'w1',
    conversationId: 'c1',
    status: 'running',
    phase: 'execute',
    runIds: ['r1'],
    agentPreset: { id: 'investigation', name: '只读调查' },
  } as unknown as Workflow;
  const runs = [
    { id: 'r1', route: { runtimeId: 'claude-b', model: 'opus-test' }, output: '', events: [] },
  ] as unknown as RunRecord[];
  const targets: RuntimeTarget[] = [
    { id: 'claude-b', label: 'Claude B', provider: 'claude', enabled: true, command: '', environment: 'native' },
  ];
  const view = replyView({ workflow, runs, live: new Map([['r1', live]]), targets });
  assert.equal(view.label, '只读调查 · Claude B · opus-test');
  assert.equal(view.activity, 'Claude B · opus-test 正在回复');
  assert.deepEqual(view.tools, [{ id: 't1', name: 'Read', detail: 'src/a.ts', status: 'done' }]);
  const block = new ReplyBlock(plain);
  block.update(view);
  const shown = text(block.render(60));
  assert.match(shown, /● PugPort · 只读调查 · Claude B · opus-test/);
  assert.match(shown, /✓ Read src\/a\.ts/);
  assert.match(shown, /Done/);
  assert.match(shown, /All good\./);

  const failed = replyView({
    workflow: { ...workflow, status: 'failed', error: '额度用完了' } as Workflow,
    runs,
    live: new Map(),
    targets,
  });
  block.update(failed);
  assert.match(text(block.render(60)), /额度用完了/);
});

test('editor: the working status sits in the top rule; Esc and Ctrl+C reach the chat first', () => {
  const terminal = new FakeTerminal(60, 20);
  const ui = new TuiMainScreen(terminal);
  const editor = new PugEditor(ui, plain.editor(), { paddingX: 1 });
  assert.match(editor.render(40)[0]!, /^─{40}$/);
  editor.status = () => '⠋ Claude B 正在回复 · Esc 取消';
  assert.match(editor.render(40)[0]!, /^── ⠋ Claude B 正在回复 · Esc 取消 ─+$/);
  const seen: string[] = [];
  editor.onEscape = () => (seen.push('esc'), true);
  editor.onCtrlC = () => seen.push('ctrl+c');
  editor.handleInput('\x1b');
  editor.handleInput('\x03');
  assert.deepEqual(seen, ['esc', 'ctrl+c']);
});

/** A fake backend for the chat: projects, conversations, messages, cancel and the live event stream. */
async function fakeChatBackend(t: TestContext) {
  const token = 'fixture-session-token-chat';
  const posts: Array<{ url: string; token?: string; body: any }> = [];
  const streams = new Set<ServerResponse>();
  const now = new Date().toISOString();
  const target = {
    id: 'claude-b',
    provider: 'claude',
    label: 'Claude B',
    enabled: true,
    command: 'x',
    environment: 'native',
  };
  const runtime = {
    id: 'claude-b',
    provider: 'claude',
    label: 'Claude B',
    status: 'ready',
    models: [],
    quota: { windows: [{ label: '5h', usedPercent: 40, durationMinutes: 300 }], observedAt: now },
  };
  const state: Record<string, any> = {
    app: { name: 'PugPort', version: 'test', platform: process.platform, dataDir: '' },
    runtimes: [runtime],
    targets: [target],
    settings: { agentPresets: [] },
    runs: [],
    workflows: [],
    conversationMessages: [],
    projects: [],
    // Earlier terminal conversations in this folder, for --continue; the newest one wins.
    conversations: [
      { id: 'c-old', projectId: 'p1', title: 'Terminal · older', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'c0', projectId: 'p1', title: 'Terminal · earlier', createdAt: now, updatedAt: now },
      { id: 'c-app', projectId: 'p1', title: 'Started in the app', createdAt: now, updatedAt: '2099-01-01' },
    ],
  };
  const earlier = {
    conversation: state.conversations[1],
    messages: [
      { id: 'h1', conversationId: 'c0', role: 'user', content: 'earlier question', createdAt: now },
      {
        id: 'h2',
        conversationId: 'c0',
        role: 'assistant',
        content: 'earlier answer',
        createdAt: now,
        replyIdentity: {
          automatic: true,
          kind: 'model',
          runs: [{ runId: 'r0', runtimeId: 'claude-b', model: 'opus-old', confirmed: true }],
        },
      },
    ],
    workflows: [],
  };
  const send = (event: string, value: unknown) => {
    for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    if (req.method === 'GET') return next();
    posts.push({ url: req.url, token: req.header('x-agent-token'), body: req.body });
    if (req.header('x-agent-token') !== token) return res.status(403).json({ error: 'Local session token required' });
    next();
  });
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  });
  app.post('/api/projects', (req, res) => res.status(201).json({ id: 'p1', name: 'app', path: req.body.path }));
  app.get('/api/conversations/c0', (_req, res) => res.json(earlier));
  app.post('/api/workflows/:id/cancel', (_req, res) => res.json({ ok: true }));
  app.post('/api/conversations/c0/messages', (req, res) =>
    res.status(201).json({ message: { id: 'm9', role: 'user', content: req.body.content } }),
  );
  app.post('/api/conversations', (req, res) =>
    res
      .status(201)
      .json({ id: 'c1', projectId: req.body.projectId, title: req.body.title, createdAt: now, updatedAt: now }),
  );
  app.post('/api/conversations/c1/messages', (req, res) => {
    const workflow = {
      id: 'w1',
      conversationId: 'c1',
      status: 'running',
      phase: 'execute',
      runIds: ['r1'],
      input: req.body,
    };
    res.status(201).json({ message: { id: 'm1', role: 'user', content: req.body.content }, workflow });
    // The reply streams in, then the workflow settles with its saved final message.
    setTimeout(() => {
      state.workflows = [workflow];
      state.runs = [
        {
          id: 'r1',
          workflowId: 'w1',
          route: { runtimeId: 'claude-b', model: 'opus-test' },
          output: '',
          events: [],
          status: 'running',
        },
      ];
      send('state', state);
      send('run', { runId: 'r1', event: { seq: 1, at: now, type: 'text', text: 'Streaming hello ' } });
      send('run', { runId: 'r1', event: { seq: 2, at: now, type: 'text', text: 'from Claude' } });
    }, 50);
    setTimeout(() => {
      state.workflows = [{ ...workflow, status: 'completed', phase: 'summarize', finalMessageId: 'm2' }];
      state.conversationMessages = [
        {
          id: 'm2',
          conversationId: 'c1',
          role: 'assistant',
          content: 'Final hello from Claude.',
          createdAt: now,
          workflowId: 'w1',
          replyIdentity: {
            automatic: true,
            kind: 'model',
            runs: [{ runId: 'r1', runtimeId: 'claude-b', model: 'opus-test', confirmed: true }],
          },
        },
      ];
      send('state', state);
    }, 1200);
  });
  const server = await listenForFetch(app);
  t.after(() => {
    for (const res of streams) res.end();
    server.closeAllConnections();
    server.close();
  });
  t.after(publishSessionToken(token, (server.address() as AddressInfo).port));
  return { port: (server.address() as AddressInfo).port, posts, token };
}

test('terminal chat: sends through automatic routing, streams the reply with who answered, Ctrl+C on idle exits', async (t) => {
  const backend = await fakeChatBackend(t);
  const terminal = new FakeTerminal(100, 40);
  const opened: string[] = [];
  const chat = new TerminalChat(
    { cwd: process.cwd(), write: false, resume: false },
    {
      client: new PugPortClient(backend.port),
      theme: new Theme(false),
      openDesktop: () => (opened.push('open'), true),
      terminal,
      renderer: (term): TUI => new TuiMainScreen(term),
    },
  );
  // A failed assertion must not leave the chat reconnecting forever and the test file never exiting.
  t.after(() => chat.quit());
  const finished = chat.run();
  await until(() => terminal.screen.includes('额度 Claude 60%'), 'the quota from the first state');
  assert.match(terminal.title, /^PugPort · /);
  for (const key of 'hello pug') terminal.type(key);
  terminal.type('\r');
  await until(() => terminal.screen.includes('Streaming hello from Claude'), 'the streamed reply');
  assert.match(terminal.screen, /PugPort · Claude B · opus-test/);
  assert.match(terminal.screen, /Claude B · opus-test 正在回复 · Esc 取消/);
  // Esc while it runs asks PugPort to cancel that reply.
  terminal.type('\x1b');
  await until(() => backend.posts.some((post) => post.url === '/api/workflows/w1/cancel'), 'the cancel request');
  await until(() => terminal.screen.includes('Final hello from Claude.'), 'the final answer');
  await until(() => terminal.screen.includes('上一条：Claude B · opus-test'), 'the footer label');

  const urls = backend.posts.map((post) => post.url);
  assert.deepEqual(urls, [
    '/api/projects',
    '/api/conversations',
    '/api/conversations/c1/messages',
    '/api/workflows/w1/cancel',
  ]);
  assert.deepEqual(backend.posts[0]!.body, { path: process.cwd() });
  assert.equal(backend.posts[1]!.body.title, conversationTitle('hello pug'));
  assert.match(backend.posts[1]!.body.title, /^Terminal · hello pug$/);
  const { clientMessageId, ...body } = backend.posts[2]!.body;
  assert.match(clientMessageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, {
    content: 'hello pug',
    mode: 'auto',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    allowUnknownQuota: false,
    autoEscalate: true,
  });
  assert.ok(backend.posts.every((post) => post.token === backend.token));
  assert.equal(terminal.output.includes(backend.token), false);

  // Slash commands stay in the terminal.
  for (const key of '/open') terminal.type(key);
  terminal.type('\x1b'); // close the completion list
  terminal.type('\r');
  await until(() => terminal.screen.includes('正在打开 PugPort 桌面应用'), 'the /open note');
  assert.deepEqual(opened, ['open']);

  terminal.type('\x03');
  assert.equal(await finished, 0);
});

test('terminal chat --continue: picks the newest terminal conversation in this folder and shows its history', async (t) => {
  const backend = await fakeChatBackend(t);
  const terminal = new FakeTerminal(100, 40);
  const chat = new TerminalChat(
    { cwd: process.cwd(), write: true, resume: true },
    {
      client: new PugPortClient(backend.port),
      theme: new Theme(false),
      openDesktop: () => false,
      terminal,
      renderer: (term): TUI => new TuiMainScreen(term),
    },
  );
  t.after(() => chat.quit());
  const finished = chat.run();
  await until(() => terminal.screen.includes('接着上次的对话：Terminal · earlier'), 'the resumed conversation');
  assert.match(terminal.screen, /earlier question/);
  assert.match(terminal.screen, /PugPort · Claude B · opus-old/);
  assert.match(terminal.screen, /earlier answer/);
  assert.match(terminal.screen, /可改文件/);
  // The next message goes into that conversation, writable.
  for (const key of 'and now?') terminal.type(key);
  terminal.type('\r');
  await until(() => backend.posts.some((post) => post.url === '/api/conversations/c0/messages'), 'the follow-up');
  const followUp = backend.posts.find((post) => post.url === '/api/conversations/c0/messages')!;
  assert.equal(followUp.body.permissionMode, 'workspace-write');
  assert.equal(followUp.body.content, 'and now?');
  assert.equal(
    backend.posts.some((post) => post.url === '/api/conversations'),
    false,
  );
  chat.quit();
  assert.equal(await finished, 0);
});

test('connect settings: install, remove and retry use the persisted PATH API', async () => {
  const code = await uiBundle('src/ui/Extensions.tsx');
  const h = uiHarness(code, { Error });
  let installed = false;
  let fail = false;
  const methods: string[] = [];
  const props = {
    notify() {},
    api: async (_path: string, _body: unknown, method: string) => {
      methods.push(method);
      if (fail) throw new Error('synthetic access denied');
      if (method === 'POST') installed = true;
      if (method === 'DELETE') installed = false;
      return { folder: 'C:/Synthetic/PugPort/dist/bin', platform: 'win32', installed, automatic: true };
    },
  };
  const initial = h.render('TerminalCommand', props);
  assert.equal(initial.props.control.props.disabled, true);
  assert.equal(initial.props.control.props.children[1], '正在检查…');
  await nextTurn();
  let tree = h.render('TerminalCommand', props);
  assert.equal(tree.props.control.props.children[1], '加入 PATH');
  tree.props.control.props.onClick();
  await nextTurn();
  tree = h.render('TerminalCommand', props);
  assert.equal(tree.props.status, '已加入');
  assert.equal(tree.props.control, undefined);
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === '加入 PATH 的命令'),
    undefined,
  );
  const remove = findNode(tree, (node) => node.type === 'button' && node.props.children === '从 PATH 移除')!;
  assert.ok(remove);
  fail = true;
  remove.props.onClick();
  await nextTurn();
  tree = h.render('TerminalCommand', props);
  assert.equal(findNode(tree, (node) => node.props.role === 'alert')!.props.children, 'synthetic access denied');
  assert.equal(tree.props.control.props.children, '重试');
  fail = false;
  tree.props.control.props.onClick();
  await nextTurn();
  tree = h.render('TerminalCommand', props);
  assert.equal(tree.props.status, undefined);
  assert.deepEqual(methods, ['GET', 'POST', 'DELETE', 'DELETE']);
  h.unmount();
});

test('the server returns the persisted terminal installation status through an injected reader', async (t) => {
  const root = join('C:', 'PugPort', 'resources', 'app');
  const folder = join(root, 'dist', 'bin');
  const app = express();
  terminalCommandRoutes(app, {
    root: join('C:', 'nowhere'),
    path: async () => ({ folder, platform: 'win32', installed: false, automatic: true }),
  });
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external/terminal-command`,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).installed, false);
});
