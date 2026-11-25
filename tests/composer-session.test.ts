import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ComposerSession, emptyDraft, sentQuotes } from '../src/ui/composer-session.ts';
import type { MessageMarkup } from '../src/shared/markup.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-03T12:00:00Z';
const conversation = (id: string) => ({ id, projectId: 'project', title: id, createdAt: stamp, updatedAt: stamp });
const state = {
  app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
  projects: [],
  conversations: [conversation('a'), conversation('b')],
  runs: [],
  workflows: [],
  conversationMessages: [],
  targets: [],
  runtimes: [],
  approvals: [],
  plugins: [],
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mount(
  session: ComposerSession,
  api: any,
  selected: any = conversation('a'),
  onConversation = (_: any) => {},
  view: any = state,
  globals: Record<string, unknown> = {},
) {
  const harness = uiHarness(code, globals);
  const props = {
    state: view,
    api,
    conversation: selected,
    project: view.projects?.find((project: any) => project.id === selected?.projectId),
    composerSession: session,
    notify(_notice: any) {},
    onConversation,
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  const node = (check: Parameters<typeof findNode>[1]) => {
    const result = findNode(render(), check);
    assert.ok(result);
    return result;
  };
  return {
    harness,
    props,
    render,
    node,
    input: () => node((value) => value.type === 'textarea' && value.props.id === 'conversation-input'),
    type(text: string) {
      this.input().props.onChange({ target: { value: text } });
    },
    submit() {
      node((value) => value.type === 'form' && value.props.className.includes('conversation-composer')).props.onSubmit({
        preventDefault() {},
      });
    },
    quote(text: string) {
      node((value) => value.type?.name === 'SelectionActions').props.onQuote(text, 'anchor', { left: 100, top: 100 });
      node((value) => value.type?.name === 'QuoteEditor').props.onSave('Explain it');
    },
  };
}
const readApi = async () => ({ messages: [] });
test('image annotations use unique draft names, replace in place and remove their linked attachment', () => {
  const session = new ComposerSession();
  const source = new File(['synthetic'], 'source.png', { type: 'image/png' });
  session.changeDraft('conversation:a', () => ({
    ...emptyDraft(),
    attachments: [{ id: 'source', file: source, previewUrl: 'blob:synthetic-source' }],
  }));
  const view = mount(session, readApi);
  const preview = () => {
    view.node((node) => node.props.className === 'attachment-chip-preview').props.onClick();
    return view.node((node) => node.type?.name === 'ImageViewer');
  };
  const markup: MessageMarkup = {
    version: 1,
    source: { kind: 'image', name: 'source.png', width: 10, height: 10 },
    attachment: 'source-标注.png',
    marks: [{ n: 1, kind: 'rect', color: '#e5322d', box: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
  };
  const result = {
    file: new File(['annotated'], markup.attachment, { type: 'image/png' }),
    markup,
    src: 'blob:synthetic-source',
  };
  try {
    assert.equal(preview().props.markup.onAdd(result, 0), true);
    assert.equal(preview().props.markup.onAdd(result, 0), true);
    const draft = () => session.getSnapshot().drafts['conversation:a']!;
    assert.deepEqual(
      Array.from(draft().attachments, (item) => item.file.name),
      ['source.png', 'source-标注.png', 'source-标注-2.png'],
    );
    assert.deepEqual(
      Array.from(draft().quotes!, (quote) => quote.markup!.attachment),
      ['source-标注.png', 'source-标注-2.png'],
    );
    const first = draft().quotes![0]!;
    view.node((node) => node.type?.name === 'QuoteChips').props.onEdit(first, {});
    const edit = view.node((node) => node.type?.name === 'ImageViewer' && node.props.markup.immediate);
    assert.equal(edit.props.markup.onAdd(result, 0), true);
    assert.equal(draft().attachments.length, 3);
    assert.equal(draft().quotes!.length, 2);
    assert.equal(draft().quotes![0]!.id, first.id);
    view.node((node) => node.type?.name === 'QuoteChips').props.onRemove(first.id);
    assert.equal(draft().attachments.length, 2);
    assert.equal(draft().quotes!.length, 1);
    assert.equal(draft().attachments[0]!.id, 'source');
  } finally {
    session.dispose();
  }
});
test('markup source URLs survive source-chip removal and pending sends until the last owner releases them', () => {
  const session = new ComposerSession();
  const revoked: string[] = [];
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  try {
    const markup: MessageMarkup = {
      version: 1,
      source: { kind: 'image', name: 'source.png', width: 10, height: 10 },
      attachment: 'source-标注.png',
      marks: [{ n: 1, kind: 'rect', color: '#e5322d', box: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    };
    const quote = { id: 'q', text: 'reference', markup, markupSrc: 'blob:source', attachmentDraftId: 'annotated' };
    session.changeDraft('a', () => ({
      ...emptyDraft(),
      attachments: [{ id: 'source', file: new File([''], 'source.png'), previewUrl: 'blob:source' }],
      quotes: [quote],
    }));
    session.changeDraft('a', (draft) => ({ ...draft, attachments: [] }));
    assert.deepEqual(revoked, []);
    const snapshot = session.getSnapshot().drafts.a!;
    session.changePending(() => [
      { id: 'send', scope: 'a', content: '', images: [], quotes: sentQuotes([quote]), sentAt: stamp, snapshot },
    ]);
    session.changeDraft('a', emptyDraft);
    assert.deepEqual(revoked, []);
    assert.deepEqual(sentQuotes([quote]), [{ text: 'reference', note: undefined, messageId: undefined, markup }]);
    session.changePending(() => []);
    assert.deepEqual(revoked, ['blob:source']);
  } finally {
    session.dispose();
    URL.revokeObjectURL = revoke;
  }
});
test('reload protection includes drafts in hidden chats, attachments, quotes and pending sends', () => {
  const session = new ComposerSession();
  assert.equal(session.hasUnsavedWork(), false);
  for (const content of [
    { content: 'Unsaved' },
    { attachments: [{ id: 'attachment', name: 'synthetic.txt' }] },
    { quotes: [{ id: 'quote', text: 'Quoted text' }] },
  ]) {
    session.changeDraft('hidden-chat', () => ({ ...emptyDraft(), ...content }) as any);
    assert.equal(session.hasUnsavedWork(), true);
    session.changeDraft('hidden-chat', emptyDraft);
    assert.equal(session.hasUnsavedWork(), false);
  }
  session.changePending(() => [{ id: 'pending', snapshot: emptyDraft() }] as any);
  assert.equal(session.hasUnsavedWork(), true);
  session.changePending(() => []);
  assert.equal(session.hasUnsavedWork(), false);
  session.dispose();
});
test('refusing verification on a new project conversation creates no empty conversation', async () => {
  const session = new ComposerSession();
  const calls: unknown[] = [];
  const project = { id: 'project', name: 'Synthetic', path: 'C:/synthetic', createdAt: stamp, updatedAt: stamp };
  const view = mount(
    session,
    async (path: string, body: unknown) => {
      if (body) calls.push(path);
      return readApi();
    },
    undefined,
    () => {},
    { ...state, projects: [project] },
    {
      window: {
        comboRunnerDesktop: {
          pickDirectory() {},
          async changePermission(change: unknown) {
            calls.push(JSON.parse(JSON.stringify(change)));
            return false;
          },
        },
      },
    },
  );
  view.props.conversation = undefined;
  view.props.project = project;
  view.type('Synthetic task');
  view.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
  const advancedControl = view.node(
    (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
  );
  if (!advancedControl.props['aria-expanded']) advancedControl.props.onClick();
  view.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('build');
  view
    .node((node) => node.type === 'input' && node.props.placeholder === '完成后运行，如 npm test')
    .props.onChange({ target: { value: 'synthetic exact' } });
  view.submit();
  await nextTurn();
  assert.deepEqual(calls, [{ kind: 'verification', projectId: 'project', command: 'synthetic exact' }]);
  session.dispose();
});
const sent = (id = 'sent') => ({ message: { id, conversationId: 'a', role: 'user', content: 'A', createdAt: stamp } });

test('conversation asks for exact project verification approval before sending; an existing grant skips the dialog', async () => {
  for (const [approved, allow] of [
    [false, false],
    [false, true],
    [true, true],
  ] as const) {
    const session = new ComposerSession();
    const calls: any[] = [];
    const project = {
      id: 'project',
      name: 'Synthetic',
      path: 'C:/synthetic',
      createdAt: stamp,
      updatedAt: stamp,
      approvedVerificationCommands: approved ? ['synthetic exact'] : [],
    };
    const view = mount(
      session,
      async (path: string, body: any) => {
        if (body && path.endsWith('/messages')) {
          calls.push({ kind: 'send', command: body.verificationCommand });
          return sent();
        }
        return readApi();
      },
      conversation('a'),
      () => {},
      { ...state, projects: [project] },
      {
        window: {
          comboRunnerDesktop: {
            pickDirectory() {},
            async changePermission(change: unknown) {
              calls.push(JSON.parse(JSON.stringify(change)));
              return allow;
            },
          },
        },
      },
    );
    view.type('Explain the project.');
    view.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
    const advancedControl = view.node(
      (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
    );
    if (!advancedControl.props['aria-expanded']) advancedControl.props.onClick();
    view.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('build');
    view
      .node((node) => node.type === 'input' && node.props.placeholder === '完成后运行，如 npm test')
      .props.onChange({ target: { value: 'synthetic exact' } });
    view.submit();
    await nextTurn();
    assert.deepEqual(calls, [
      ...(!approved ? [{ kind: 'verification', projectId: 'project', command: 'synthetic exact' }] : []),
      ...(allow ? [{ kind: 'send', command: 'synthetic exact' }] : []),
    ]);
    session.dispose();
  }
});

test('permission, channel and review follow the conversation and the permission label switches the effective mode', async () => {
  const session = new ComposerSession(),
    store = new Map<string, string>(),
    bodies: any[] = [];
  const view = mount(
    session,
    async (path: string, body: any) => {
      if (path.endsWith('/messages')) {
        bodies.push(body);
        return sent(String(bodies.length));
      }
      return readApi();
    },
    conversation('a'),
    () => {},
    state,
    {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    },
  );
  const permission = () =>
    findNode(view.render(), (node) => node.type === 'button' && node.props['aria-label'] === '文件权限');
  assert.equal(permission()!.props.children, '可写入');
  view.node((node) => node.props['aria-label'] === '添加和更多').props.onClick();
  view
    .node(
      (node) => node.props.role === 'menuitemcheckbox' && !!findNode(node, (child) => child.props.children === '只读'),
    )
    .props.onClick();
  assert.equal(permission()!.props.children, '只读');
  view.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
  view
    .node((node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined)
    .props.onClick();
  view.node((node) => node.props.ariaLabel === '执行通道').props.onChange('api-only');
  view.node((node) => node.props['aria-label'] === '添加和更多').props.onClick();
  view
    .node(
      (node) =>
        node.props.role === 'menuitemcheckbox' && !!findNode(node, (child) => child.props.children === '核验模式'),
    )
    .props.onClick();
  view.props.conversation = conversation('b');
  assert.equal(permission()!.props.children, '可写入');
  view.type('B');
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].permissionMode, 'workspace-write');
  assert.equal(bodies[0].executionPolicy, 'cli-first');
  assert.equal(bodies[0].review, undefined);
  view.props.conversation = conversation('a');
  assert.equal(permission()!.props.children, '只读');
  view.type('A');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].permissionMode, 'read-only');
  assert.equal(bodies[1].executionPolicy, 'api-only');
  assert.equal(bodies[1].review, true);
  const route = view.node((node) => node.props['aria-label'] === '调度选项');
  if (!route.props['aria-expanded']) route.props.onClick();
  const advancedControl = view.node(
    (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
  );
  if (!advancedControl.props['aria-expanded']) advancedControl.props.onClick();
  view.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('chat');
  permission()!.props.onClick();
  view.type('Write');
  view.submit();
  await nextTurn();
  assert.equal(bodies[2].mode, 'auto');
  assert.equal(bodies[2].permissionMode, 'workspace-write');
  view.props.conversation = undefined;
  assert.equal(permission()!.props.children, '可写入');
  session.dispose();
});

test('an uncertain HTTP delivery with another Enter never automatically resends the recovered draft', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>();
  let calls = 0;
  const view = mount(session, (path: string) => {
    if (!path.endsWith('/messages')) return readApi();
    calls++;
    return delivery.promise;
  });
  view.type('Correction');
  view.submit();
  await nextTurn();
  view.type('Next correction');
  view.submit();
  delivery.reject(new Error('Delivery uncertain'));
  await nextTurn();
  view.harness.flushTimers();
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(view.input().props.value, 'Next correction');
  assert.equal(session.getSnapshot().pendingSends[0]!.content, 'Correction');
  session.dispose();
});

// A running task with an open steering channel: the composer shows the Enter/Ctrl+Enter shortcuts.
const runningState = {
  ...state,
  runs: [
    {
      id: 'running-run',
      workflowId: 'running',
      stepId: 'step',
      status: 'running',
      steerAvailable: true,
      toolApprovalMode: 'auto',
      startedAt: stamp,
      events: [],
      output: '',
    },
  ],
  workflows: [
    {
      id: 'running',
      conversationId: 'a',
      projectId: 'project',
      userMessageId: 'original',
      input: { content: 'Original', mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
      status: 'running',
      phase: 'execute',
      plan: [],
      runIds: ['running-run'],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
};
function pressEnter(view: ReturnType<typeof mount>, ctrlKey = false) {
  view.input().props.onKeyDown({
    key: 'Enter',
    ctrlKey,
    shiftKey: false,
    altKey: false,
    repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault() {},
  });
}

test('Enter and Ctrl+Enter follow auto-steer only while this conversation has a running task', async (t) => {
  for (const running of [true, false])
    for (const steerOnSend of [undefined, true, false])
      await t.test('running=' + running + ', auto-steer=' + steerOnSend, async () => {
        const session = new ComposerSession(),
          bodies: any[] = [],
          notices: any[] = [];
        const view = mount(
          session,
          async (path: string, body: any) => {
            if (!path.endsWith('/messages')) return readApi();
            bodies.push(body);
            return { ...sent(String(bodies.length)), notice: '权限不同，已保留进度并续接。' };
          },
          conversation('a'),
          () => {},
          {
            ...(running ? runningState : state),
            settings: { ...state.settings, steerOnSend },
          },
        );
        view.props.notify = (notice: any) => notices.push(notice);
        for (const ctrlKey of [false, true]) {
          view.type(ctrlKey ? 'Modified enter' : 'Enter');
          pressEnter(view, ctrlKey);
          await nextTurn();
          assert.equal(bodies.at(-1).queue, running ? (steerOnSend === false ? !ctrlKey : ctrlKey) : undefined);
        }
        const hint = findNode(view.render(), (node) => node.props.className === 'composer-shortcuts');
        assert.equal(hint, undefined);
        if (running) {
          const expected =
            steerOnSend === false
              ? 'Enter：排在后面 · Ctrl+Enter：补充给当前任务'
              : 'Enter：补充给当前任务 · Ctrl+Enter：排在后面';
          assert.ok(view.node((node) => node.props.className === 'send-button').props.title.includes(expected));
          assert.equal(JSON.stringify(view.render()).split(expected).length - 1, 1);
        }
        assert.equal(
          findNode(view.render(), (node) => node.props['aria-label'] === '排在后面'),
          undefined,
        );
        assert.equal(notices[0].message, '权限不同，已保留进度并续接。');
        view.harness.unmount();
        session.dispose();
      });
});

test('a deferred Ctrl+Enter preserves its queue choice even if auto-steer changes before delivery', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>(),
    bodies: any[] = [];
  const view = mount(
    session,
    (path: string, body: any) => {
      if (!path.endsWith('/messages')) return readApi();
      bodies.push(body);
      return bodies.length === 1 ? delivery.promise : Promise.resolve(sent('next'));
    },
    conversation('a'),
    () => {},
    structuredClone(runningState),
  );
  view.type('First correction');
  pressEnter(view);
  await nextTurn();
  view.type('Independent task');
  pressEnter(view, true);
  view.props.state.settings = { ...view.props.state.settings, steerOnSend: false };
  view.render();
  delivery.resolve(sent());
  await nextTurn();
  view.render();
  view.harness.flushTimers();
  await nextTurn();
  assert.deepEqual(
    bodies.map((body) => body.queue),
    [false, true],
  );
  view.harness.unmount();
  session.dispose();
});

test('a single role stays picked for the next message, only in its own conversation', async () => {
  const session = new ComposerSession();
  const bodies: any[] = [];
  const api = async (path: string, body: any) => {
    if (path.endsWith('/messages')) {
      bodies.push(body);
      return sent(String(bodies.length));
    }
    return readApi();
  };
  const view = mount(session, api);
  view.type('@代');
  const menu = view.node((node) => node.type?.name === 'MentionMenu');
  const review = menu.props.items.find((preset: { id: string }) => preset.id === 'code-review');
  assert.ok(review, 'typing @ offers the matching roles');
  assert.ok(!menu.props.items.some((preset: { id: string }) => preset.id === 'standard'));
  menu.props.onPick(review);
  assert.equal(view.input().props.value, '@代码审查 ');
  view.type('@代码审查 Review source');
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].agentPresetId, 'code-review');
  assert.equal(session.getSnapshot().drafts['conversation:a']?.called?.[0]?.id, 'code-review');
  view.type('Review another file');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].agentPresetId, 'code-review');
  view.node((node) => node.props['aria-label'] === '不叫 代码审查').props.onClick();
  view.type('@代');
  view.node((node) => node.type?.name === 'MentionMenu').props.onPick(review);
  view.type('Changed my mind');
  assert.equal(session.getSnapshot().drafts['conversation:a']?.called, undefined, 'deleting @name takes the call back');
  const other = mount(session, api, conversation('b'));
  other.type('Different task');
  other.submit();
  await nextTurn();
  assert.equal(bodies[2].agentPresetId, undefined);
  view.harness.unmount();
  other.harness.unmount();
  session.dispose();
});

test('a single executor stays picked for the next message', async () => {
  const session = new ComposerSession();
  const bodies: any[] = [];
  const api = async (path: string, body: any) => {
    if (path.endsWith('/messages')) {
      bodies.push(body);
      return sent(String(bodies.length));
    }
    return readApi();
  };
  const withGrok = {
    ...state,
    targets: [
      {
        id: 'grok-native',
        provider: 'grok',
        label: 'Grok · 本机',
        command: 'mock',
        enabled: true,
        environment: 'native',
      },
    ],
  };
  const view = mount(session, api, conversation('a'), () => {}, withGrok);
  view.type('@Gr');
  const menu = view.node((node) => node.type?.name === 'MentionMenu');
  const grok = menu.props.items.find((item: { kind: string }) => item.kind === 'executor');
  assert.deepEqual([grok.id, grok.name], ['grok-native', 'Grok']);
  menu.props.onPick(grok);
  view.type('@Grok 你怎么看');
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].runtimeId, 'grok-native');
  assert.equal(bodies[0].model, undefined, 'it answers with its own default model');
  view.type('下一条');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].runtimeId, 'grok-native');
  view.harness.unmount();
  session.dispose();
});

const trialWriter = { runtimeId: 'writer', model: 'story-model', effort: 'high', label: 'Trial writer · high' };
const writerState = {
  ...state,
  targets: [
    { id: 'writer', provider: 'claude', label: 'Writer', command: 'mock', enabled: true, environment: 'native' },
  ],
  runtimes: [
    {
      id: 'writer',
      provider: 'claude',
      status: 'ready',
      models: [{ id: 'story-model', label: 'Story', efforts: ['high'] }],
    },
  ],
};
test('a trial writer belongs only to its draft and is consumed by one successful send without saving a default', async () => {
  const session = new ComposerSession(),
    bodies: any[] = [],
    saved: string[] = [];
  session.changeDraft('conversation:a', (draft) => ({ ...draft, content: 'First', writer: trialWriter }));
  const view = mount(
    session,
    async (path: string, body: any) => {
      if (path.endsWith('/messages')) {
        bodies.push(body);
        return sent();
      }
      return readApi();
    },
    conversation('a'),
    () => {},
    writerState,
    { localStorage: { getItem: () => null, setItem: (_: string, value: string) => saved.push(value) } },
  );
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].runtimeId, 'writer');
  assert.equal(bodies[0].effort, 'high');
  assert.equal(session.getSnapshot().drafts['conversation:a']?.writer, undefined);
  view.type('Second');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].runtimeId, undefined);
  assert.equal(bodies[1].model, undefined);
  assert.ok(saved.every((value) => JSON.parse(value).runtimeId === ''));
  session.dispose();
});
test('a failed send retains its trial writer for retry and does not apply it in another conversation', async () => {
  const session = new ComposerSession(),
    bodies: any[] = [];
  session.changeDraft('conversation:a', (draft) => ({ ...draft, content: 'Try', writer: trialWriter }));
  const view = mount(
    session,
    async (path: string, body: any) => {
      if (path.endsWith('/messages')) {
        bodies.push(body);
        if (bodies.length === 1) throw Error('Fixture failure');
        return sent();
      }
      return readApi();
    },
    conversation('a'),
    () => {},
    writerState,
  );
  view.submit();
  await nextTurn();
  assert.equal(session.getSnapshot().drafts['conversation:a']?.writer?.runtimeId, 'writer');
  const other = mount(
    session,
    async (path: string, body: any) => {
      if (path.endsWith('/messages')) {
        bodies.push(body);
        return sent();
      }
      return readApi();
    },
    conversation('b'),
    () => {},
    writerState,
  );
  other.type('Other');
  other.submit();
  await nextTurn();
  assert.equal(bodies[1].runtimeId, undefined);
  view.submit();
  await nextTurn();
  assert.equal(bodies[2].runtimeId, 'writer');
  session.dispose();
});

test('draft text, files and quotes survive pane unmount and another conversation before returning', () => {
  const session = new ComposerSession();
  const first = mount(session, readApi);
  first.type('Unsent A');
  first.quote('Quoted A');
  first
    .node((value) => value.type === 'input' && value.props.type === 'file')
    .props.onChange({
      currentTarget: { files: [new File(['picture'], 'image.png', { type: 'image/png' })], value: '' },
    });
  const preview = session.getSnapshot().drafts['conversation:a']!.attachments[0]!.previewUrl;
  first.harness.unmount();
  const other = mount(session, readApi, conversation('b'));
  other.type('Unsent B');
  other.harness.unmount();
  const reopened = mount(session, readApi);
  assert.equal(reopened.input().props.value, 'Unsent A');
  assert.equal(session.getSnapshot().drafts['conversation:a']!.quotes?.[0]?.text, 'Quoted A');
  assert.equal(session.getSnapshot().drafts['conversation:a']!.attachments[0]!.previewUrl, preview);
  assert.equal(session.getSnapshot().drafts['conversation:b']!.content, 'Unsent B');
  session.dispose();
});

test('creating a conversation transfers the next text and quote draft to its assigned ID', async () => {
  const session = new ComposerSession(),
    creation = deferred<any>(),
    delivery = deferred<any>();
  let selected: any;
  const api = (path: string) =>
    path === '/api/conversations' ? creation.promise : path.endsWith('/messages') ? delivery.promise : readApi();
  const first = mount(session, api, undefined, (value) => {
    selected = value;
  });
  // Explicit undefined selects the new-composer scope rather than mount's default fixture conversation.
  first.props.conversation = undefined;
  first.type('First task');
  first.submit();
  await nextTurn();
  first.type('Next task');
  first.quote('Next quoted reference');
  creation.resolve(conversation('created'));
  await nextTurn();
  delivery.resolve(sent());
  await nextTurn();
  assert.equal(selected.id, 'created');
  first.harness.unmount();
  const reopened = mount(session, api, selected);
  assert.equal(reopened.input().props.value, 'Next task');
  assert.equal(session.getSnapshot().drafts['conversation:created']!.quotes?.[0]?.text, 'Next quoted reference');
  assert.equal(session.getSnapshot().drafts['new:chat'], undefined);
  session.dispose();
});

test('a rejected send stays recoverable while the next text or quote draft is preserved', async () => {
  for (const quoted of [false, true]) {
    const session = new ComposerSession(),
      delivery = deferred<any>();
    const api = (path: string) => (path.endsWith('/messages') ? delivery.promise : readApi());
    const first = mount(session, api);
    first.type('Rejected original');
    first.submit();
    await nextTurn();
    if (quoted) first.quote('Next quote');
    else first.type('Next text');
    delivery.reject(new Error('Fixture 409'));
    await nextTurn();
    assert.equal(session.getSnapshot().pendingSends[0]!.content, 'Rejected original');
    assert.match(session.getSnapshot().pendingSends[0]!.error!, /409/);
    assert.equal(first.input().props.value, quoted ? '' : 'Next text');
    if (quoted) assert.equal(session.getSnapshot().drafts['conversation:a']!.quotes?.length, 1);
    first.harness.unmount();
    const reopened = mount(session, api);
    const history = () => reopened.node((value) => Array.isArray(value.props.pendingMessages));
    assert.equal(history().props.recoverPendingDisabled, true);
    session.changeDraft('conversation:a', () => ({ content: '', attachments: [], quotes: [] }));
    assert.equal(history().props.recoverPendingDisabled, false);
    history().props.onRecoverPending(session.getSnapshot().pendingSends[0]);
    assert.equal(reopened.input().props.value, 'Rejected original');
    assert.equal(session.getSnapshot().pendingSends.length, 0);
    session.dispose();
  }
});

test('a successful ACK preserves a quote-only next draft', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>();
  const first = mount(session, (path: string) => (path.endsWith('/messages') ? delivery.promise : readApi()));
  first.type('First message');
  first.submit();
  await nextTurn();
  first.quote('Next quote');
  delivery.resolve(sent());
  await nextTurn();
  assert.equal(first.input().props.value, '');
  assert.equal(session.getSnapshot().drafts['conversation:a']!.quotes?.[0]?.text, 'Next quote');
  session.dispose();
});

test('an empty next draft restores the failure directly and preserves the created conversation for retry', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>();
  let creations = 0;
  const first = mount(session, (path: string) => {
    if (path === '/api/conversations') {
      creations++;
      return Promise.resolve(conversation('created'));
    }
    return path.endsWith('/messages') ? delivery.promise : readApi();
  });
  first.props.conversation = undefined;
  first.type('Retry me');
  first.submit();
  await nextTurn();
  delivery.reject(new Error('Fixture failure'));
  await nextTurn();
  assert.equal(first.input().props.value, 'Retry me');
  assert.equal(session.getSnapshot().drafts['new:chat']!.createdConversation?.id, 'created');
  assert.equal(session.getSnapshot().pendingSends.length, 0);
  first.submit();
  await nextTurn();
  assert.equal(creations, 1);
  session.dispose();
});

test('a deferred send cannot submit the draft of a different conversation after switching scopes', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>(),
    submissions: string[] = [];
  const first = mount(session, (path: string) => {
    if (!path.endsWith('/messages')) return readApi();
    submissions.push(path);
    return delivery.promise;
  });
  first.type('First A');
  first.submit();
  await nextTurn();
  first.type('Second A');
  first.submit();
  first.props.conversation = conversation('b');
  first.render();
  first.type('Private unsent B');
  delivery.resolve(sent());
  await nextTurn();
  first.render();
  first.harness.flushTimers();
  await nextTurn();
  assert.deepEqual(submissions, ['/api/conversations/a/messages']);
  assert.equal(first.input().props.value, 'Private unsent B');
  assert.equal(session.getSnapshot().drafts['conversation:a']!.content, 'Second A');
  session.dispose();
});

test('image previews remain live through pending send and draft recovery, then release once at window disposal', () => {
  const session = new ComposerSession(),
    revoked: string[] = [],
    original = URL.revokeObjectURL;
  URL.revokeObjectURL = (value) => {
    revoked.push(value);
  };
  try {
    const file = new File(['picture'], 'image.png', { type: 'image/png' });
    const draft = { content: 'A', attachments: [{ id: 'image', file, previewUrl: 'blob:fixture' }], quotes: [] };
    session.changeDraft('new:chat', () => draft);
    session.changePending(() => [
      {
        id: 'send',
        scope: 'new:chat',
        content: 'A',
        images: ['blob:fixture'],
        quotes: [],
        sentAt: stamp,
        snapshot: draft,
      },
    ]);
    session.changeDraft('new:chat', () => ({ content: '', attachments: [], quotes: [] }));
    session.moveScope('new:chat', 'conversation:created');
    session.changeDraft('conversation:created', () => draft);
    session.changePending(() => []);
    assert.deepEqual(revoked, []);
    session.dispose();
    assert.deepEqual(revoked, ['blob:fixture']);
    session.changeDraft('conversation:created', () => draft);
    assert.equal(
      Object.keys(session.getSnapshot().drafts).length,
      0,
      'late completions cannot revive a disposed window',
    );
  } finally {
    URL.revokeObjectURL = original;
  }
});

test('recovering an attachment send failure reuses its completed upload on retry', async () => {
  const session = new ComposerSession();
  let uploads = 0,
    messages = 0;
  const first = mount(session, async (path: string) => {
    if (path.endsWith('/attachments')) {
      uploads++;
      return {
        id: 'saved-image',
        conversationId: 'a',
        kind: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        size: 7,
        createdAt: stamp,
      };
    }
    if (path.endsWith('/messages')) {
      if (++messages === 1) throw new Error('Fixture message rejected after upload');
      return sent();
    }
    return readApi();
  });
  first.type('Read this image');
  first
    .node((value) => value.type === 'input' && value.props.type === 'file')
    .props.onChange({
      currentTarget: { files: [new File(['picture'], 'image.png', { type: 'image/png' })], value: '' },
    });
  first.submit();
  await nextTurn();
  assert.equal(first.input().props.value, 'Read this image');
  assert.equal(session.getSnapshot().drafts['conversation:a']!.attachments[0]!.uploaded?.attachment.id, 'saved-image');
  first.submit();
  await nextTurn();
  assert.equal(uploads, 1);
  assert.equal(messages, 2);
  session.dispose();
});

const grokPick = { kind: 'external' as const, id: 'grok-bot', name: 'Grok Bot' };
const grokHistory = [
  {
    id: 'request',
    conversationId: 'a',
    role: 'user',
    content: '现在呢？',
    createdAt: stamp,
    externalRequest: { agentId: 'grok-bot' },
  },
  {
    id: 'reply',
    conversationId: 'a',
    role: 'assistant',
    content: 'Synthetic reply',
    createdAt: stamp,
    externalAgent: {
      agentId: 'grok-bot',
      name: 'Grok Bot',
      status: 'done',
      request: '现在呢？',
      updatedAt: stamp,
      routine: { replyHash: 'synthetic', sentAt: stamp, replied: true },
    },
  },
];

test('sticky Grok sends punctuation, survives switching, replaces on pick and removes with the chip', async () => {
  const session = new ComposerSession(),
    bodies: any[] = [];
  session.changeDraft('conversation:a', () => ({
    ...emptyDraft(),
    content: '@@Grok Bot 现在呢？',
    called: [grokPick],
  }));
  const view = mount(session, async (path: string, body: any) => {
    if (body && path.endsWith('/messages')) {
      bodies.push(body);
      return sent(String(bodies.length));
    }
    return readApi();
  });
  view.submit();
  await nextTurn();
  assert.equal(session.getSnapshot().drafts['conversation:a']?.called?.[0]?.id, 'grok-bot');
  view.node((node) => node.props['aria-label'] === '不叫 Grok Bot');
  view.type('现在呢？');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].content, '现在呢？');
  assert.equal(bodies[1].externalAgentId, 'grok-bot');
  view.props.conversation = conversation('b');
  view.type('Other chat');
  view.submit();
  await nextTurn();
  assert.equal(bodies[2].externalAgentId, undefined);
  view.props.conversation = conversation('a');
  view.node((node) => node.props['aria-label'] === '不叫 Grok Bot');
  view.type('@代');
  const menu = view.node((node) => node.type?.name === 'MentionMenu');
  menu.props.onPick(menu.props.items.find((item: any) => item.id === 'code-review'));
  assert.deepEqual(
    Array.from(session.getSnapshot().drafts['conversation:a']!.called!, (item) => item.id),
    ['code-review'],
  );
  view.submit();
  await nextTurn();
  view.node((node) => node.props['aria-label'] === '不叫 代码审查').props.onClick();
  view.type('现在呢？');
  view.submit();
  await nextTurn();
  assert.equal(bodies.at(-1).agentPresetId, undefined);
  assert.equal(bodies.at(-1).externalAgentId, undefined);
  view.harness.unmount();
  session.dispose();
});

test('typing an unpicked double-at name clears the sticky chip and leaves name resolution to the server', async () => {
  const session = new ComposerSession(),
    bodies: any[] = [];
  session.changeDraft('conversation:a', () => ({ ...emptyDraft(), called: [grokPick], stickyCalled: true }));
  const view = mount(session, async (path: string, body: any) => {
    if (body && path.endsWith('/messages')) {
      bodies.push(body);
      return sent();
    }
    return readApi();
  });
  view.node((node) => node.props['aria-label'] === '不叫 Grok Bot');
  view.type('@@Muse 你好');
  assert.equal(
    findNode(view.render(), (node) => node.props['aria-label'] === '不叫 Grok Bot'),
    undefined,
  );
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].content, '@@Muse 你好');
  assert.equal(bodies[0].externalAgentId, undefined);
  assert.equal(bodies[0].participants, undefined);
  view.harness.unmount();
  session.dispose();
});

test('pasting a single-at name clears the sticky chip and leaves name resolution to the server', async () => {
  const session = new ComposerSession(),
    bodies: any[] = [];
  session.changeDraft('conversation:a', () => ({ ...emptyDraft(), called: [grokPick], stickyCalled: true }));
  const view = mount(session, async (path: string, body: any) => {
    if (body && path.endsWith('/messages')) {
      bodies.push(body);
      return sent();
    }
    return readApi();
  });
  view.node((node) => node.props['aria-label'] === '不叫 Grok Bot');
  view.type('@Codex 看下');
  assert.equal(
    findNode(view.render(), (node) => node.props['aria-label'] === '不叫 Grok Bot'),
    undefined,
  );
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].content, '@Codex 看下');
  assert.equal(bodies[0].externalAgentId, undefined);
  assert.equal(bodies[0].participants, undefined);
  view.harness.unmount();
  session.dispose();
});

test('leaving a new conversation during its first send clears the next new draft recipient', async () => {
  const session = new ComposerSession(),
    delivery = deferred<any>(),
    bodies: any[] = [];
  let selections = 0;
  session.changeDraft('new:chat', () => ({ ...emptyDraft(), content: '你好', called: [grokPick] }));
  const view = mount(
    session,
    async (path: string, body: any) => {
      if (path === '/api/conversations') return conversation('created');
      if (body && path.endsWith('/messages')) {
        bodies.push(body);
        return bodies.length === 1 ? delivery.promise : sent('next');
      }
      return readApi();
    },
    undefined,
    () => {
      selections++;
    },
  );
  view.props.conversation = undefined;
  view.submit();
  await nextTurn();
  assert.equal(bodies.length, 1);
  assert.equal(session.getSnapshot().drafts['new:chat']?.stickyCalled, true);
  view.props.conversation = conversation('b');
  view.type('另一个对话的草稿');
  delivery.resolve(sent());
  await nextTurn();
  assert.equal(selections, 0);
  assert.equal(session.getSnapshot().drafts['new:chat']?.called, undefined);
  assert.equal(session.getSnapshot().drafts['new:chat']?.stickyCalled, undefined);
  assert.equal(view.input().props.value, '另一个对话的草稿');
  view.props.conversation = undefined;
  view.type('全新的消息');
  view.submit();
  await nextTurn();
  assert.equal(bodies[1].externalAgentId, undefined);
  view.harness.unmount();
  session.dispose();
});

test('using a taste-test writer replaces a sticky recipient for the next send', async (t) => {
  for (const pick of [
    grokPick,
    { kind: 'executor' as const, id: 'card', name: 'Synthetic card' },
    { kind: 'role' as const, id: 'code-review', name: '代码审查' },
    { kind: 'device' as const, id: 'device:remote', name: 'Synthetic device' },
  ]) {
    await t.test(pick.kind, async () => {
      const session = new ComposerSession(),
        bodies: any[] = [];
      session.changeDraft('conversation:a', () => ({ ...emptyDraft(), called: [pick], stickyCalled: true }));
      const view = mount(
        session,
        async (path: string, body: any) => {
          if (body && path.endsWith('/messages')) {
            bodies.push(body);
            return sent();
          }
          return readApi();
        },
        conversation('a'),
        () => {},
        {
          ...writerState,
          tasteTests: [{ id: 'taste', conversationId: 'a', status: 'ready', candidates: [trialWriter] }],
        },
      );
      view.node((node) => node.type?.name === 'TasteTestCard').props.onUseWriter(trialWriter);
      assert.equal(session.getSnapshot().drafts['conversation:a']?.called, undefined);
      assert.equal(session.getSnapshot().drafts['conversation:a']?.stickyCalled, undefined);
      assert.equal(
        findNode(view.render(), (node) => node.props['aria-label'] === `不叫 ${pick.name}`),
        undefined,
      );
      view.type('请继续写');
      view.submit();
      await nextTurn();
      assert.equal(bodies[0].runtimeId, trialWriter.runtimeId);
      assert.equal(bodies[0].model, trialWriter.model);
      assert.equal(bodies[0].effort, trialWriter.effort);
      assert.equal(bodies[0].externalAgentId, undefined);
      assert.equal(bodies[0].deviceId, undefined);
      assert.equal(bodies[0].agentPresetId, undefined);
      view.harness.unmount();
      session.dispose();
    });
  }
});

test('reopen restores only the last successful explicit external call and respects an edited draft', async (t) => {
  for (const scenario of [
    'done',
    'failed',
    'queued',
    'working',
    'needs-user',
    'handoff-only',
    'pasted',
    'wrong-agent',
    'no-pick',
    'draft',
    'cleared',
    'late-history',
    'retired-cloud',
  ] as const) {
    await t.test(scenario, async () => {
      const session = new ComposerSession();
      const history: any[] = structuredClone(grokHistory);
      if (['failed', 'queued', 'working', 'needs-user'].includes(scenario)) history[1].externalAgent.status = scenario;
      if (scenario === 'wrong-agent') history[1].externalAgent.agentId = 'muse';
      if (scenario === 'retired-cloud') {
        history[0].externalRequest.agentId = 'codex-cloud';
        history[1].externalAgent.agentId = 'codex-cloud';
        history[1].externalAgent.name = 'Codex Cloud';
      }
      if (scenario === 'handoff-only' || scenario === 'pasted') delete history[1].externalAgent.routine;
      // A handoff whose answer the user pasted back is an answer from Grok Bot too.
      if (scenario === 'pasted') history[1].externalAgent.importedAt = stamp;
      if (scenario === 'no-pick') history.push({ ...history[0], id: 'new', externalRequest: undefined });
      if (scenario === 'draft') session.changeDraft('conversation:a', () => ({ ...emptyDraft(), content: 'Unsent' }));
      if (scenario === 'cleared') session.changeDraft('conversation:a', emptyDraft);
      const delivery = deferred<any>();
      const view = mount(session, async () => (scenario === 'late-history' ? delivery.promise : { messages: history }));
      view.render();
      if (scenario === 'late-history') {
        view.type('Typed while loading');
        delivery.resolve({ messages: history });
      }
      await nextTurn();
      view.render();
      const restored = session.getSnapshot().drafts['conversation:a'];
      assert.equal(restored?.called?.[0]?.id, scenario === 'done' || scenario === 'pasted' ? 'grok-bot' : undefined);
      if (scenario === 'done') {
        view.node((node) => node.props['aria-label'] === '不叫 Grok Bot').props.onClick();
        view.render();
        assert.equal(session.getSnapshot().drafts['conversation:a']?.called, undefined);
        view.props.conversation = conversation('b');
        view.render();
        await nextTurn();
        view.props.conversation = conversation('a');
        view.render();
        await nextTurn();
        view.render();
        assert.equal(session.getSnapshot().drafts['conversation:a']?.called, undefined, 'removed choice stays removed');
      }
      if (scenario === 'late-history') assert.equal(restored?.content, 'Typed while loading');
      view.harness.unmount();
      session.dispose();
    });
  }
});

test('history restoration restores devices but never roles or executors', async (t) => {
  const { draftFromHistory } = await import('../src/ui/composer-session.ts');
  const user: any = {
    id: 'user',
    role: 'user',
    conversationId: 'a',
    content: '现在呢？',
    createdAt: stamp,
    workflowId: 'task',
  };
  const reply: any = {
    id: 'answer',
    role: 'assistant',
    conversationId: 'a',
    content: 'Synthetic answer',
    createdAt: stamp,
    workflowId: 'task',
    replyIdentity: {
      kind: 'model',
      automatic: false,
      runs: [{ runId: 'run', runtimeId: 'card', model: 'mock', confirmed: true }],
    },
  };
  const task: any = {
    id: 'task',
    userMessageId: 'user',
    finalMessageId: 'answer',
    conversationId: 'a',
    status: 'completed',
    input: {},
    runIds: ['run'],
    plan: [],
  };
  const restore = (input: any, changes: any = {}, answer: any = reply) =>
    draftFromHistory([user, answer], [{ ...task, input, ...changes }]);
  const deviceReply = {
    ...reply,
    replyIdentity: { kind: 'system', runs: [] },
    device: { id: 'remote', name: 'Synthetic device' },
  };
  const device = restore(
    { deviceId: 'remote', deviceFolder: '~/project', permissionMode: 'workspace-write', explicitWrite: true },
    {},
    deviceReply,
  );
  assert.equal(device.called?.[0]?.id, 'device:remote');
  assert.equal(device.deviceFolder, '~/project');
  assert.equal(restore({ deviceId: 'wrong' }, {}, deviceReply).called, undefined);
  await t.test('a dropdown executor is not a called recipient', () => {
    assert.equal(restore({ runtimeId: 'card' }, { ownSelection: { runtimeId: 'card' } }).called, undefined);
  });
  assert.equal(restore({ runtimeId: 'card' }, { ownSelection: {}, replyRouting: 'auto' }).called, undefined);
  assert.equal(restore({ runtimeId: 'wrong' }).called, undefined);
  await t.test('a conversation role is not a called recipient', () => {
    assert.equal(
      restore({ agentPresetId: 'code-review' }, { agentPreset: { id: 'code-review', name: '代码审查' } }).called,
      undefined,
    );
  });
  assert.equal(
    restore({ agentPresetId: 'auto' }, { agentPreset: { id: 'code-review', name: '代码审查' } }).called,
    undefined,
  );
  assert.equal(
    restore({
      runtimeId: 'card',
      participants: [
        { kind: 'role', id: 'code-review' },
        { kind: 'executor', id: 'card' },
      ],
    }).called,
    undefined,
  );
  assert.equal(restore({ runtimeId: 'card' }, { status: 'failed' }).called, undefined);
  assert.equal(restore({ runtimeId: 'card' }, {}, { ...reply, systemNotice: { text: 'Failed' } }).called, undefined);
  assert.equal(restore({ runtimeId: 'card' }, {}, { ...reply, workflowId: 'other' }).called, undefined);
  assert.equal(
    restore({ runtimeId: 'card' }, {}, { ...reply, replyIdentity: { kind: 'system', runs: [] } }).called,
    undefined,
  );
});
