import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compactResetLabel } from '../src/ui/UsageQuota.tsx';
import { MentionMenu, mentionItems, rankMentions } from '../src/ui/Mentions.tsx';
import { externalAgentStatus, externalReplyIsNotice, WebAgentQuotaRows } from '../src/ui/ExternalAgents.tsx';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import {
  MentionText,
  ConversationExchange,
  ParticipantBody,
  ParticipantHeading,
  participantKind,
  participantIdentity,
  participantStyle,
} from '../src/ui/ParticipantReply.tsx';
import { grokBotHandoffNote, type ExternalAgentView } from '../src/shared/external-agents.ts';
import type { AppState, ConversationMessage, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

// In-memory rendering with fake APIs only.
const agents: ExternalAgentView[] = [
  {
    id: 'grok-bot',
    name: 'Grok Bot',
    kind: 'handoff',
    description: '复制消息并打开 Grok Bot，由你粘贴发送；回复不会自动回到 PugPort',
    enabled: true,
    available: true,
    url: 'https://x.ai/bot',
    riskAccepted: true,
    queued: 0,
  },
  {
    id: 'muse',
    name: 'Muse',
    kind: 'web',
    description: '通过 Meta Muse 网页版提问',
    enabled: false,
    available: false,
    reason: '已关闭',
    url: '',
    queued: 0,
  },
];

const button = (tree: unknown, label: string) =>
  findNode(
    tree,
    (node) => node.type === 'button' && (text(node).trim() === label || node.props['aria-label'] === label),
  );
/** Objects made inside the in-memory renderer come from another realm; compare their plain values. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('web quota cards render reported resets or the honest missing-reset note without borrowing dates', () => {
  const now = Date.parse('2026-10-14T08:00:00Z');
  const resetsAt = '2026-10-18T08:00:00Z';
  for (const compact of [false, true])
    for (const agent of [agents[0]!, agents[1]!]) {
      for (const resetNotReported of [false, true])
        for (const reset of [resetsAt, null]) {
          const html = renderToStaticMarkup(
            createElement(WebAgentQuotaRows, {
              compact,
              now,
              agents: [
                {
                  ...agent,
                  available: true,
                  enabled: true,
                  quota: {
                    status: 'known',
                    source: 'fixture',
                    observedAt: new Date(now).toISOString(),
                    currentPeriodStart: '2040-01-01T00:00:00Z',
                    windows: [{ id: 'fixture', label: 'Quota', usedPercent: 20, resetsAt: reset, resetNotReported }],
                  },
                },
              ],
            }),
          );
          const label = compactResetLabel(resetsAt, now);
          assert.equal(html.includes(label), !!reset);
          const cursorNote = agent.id === 'grok-bot' && resetNotReported;
          assert.equal(html.includes('Cursor 没有提供重置时间'), !reset && cursorNote);
          assert.equal(html.includes('重置时间未知'), !reset && !cursorNote);
          assert.ok(!html.includes('2040'));
          if (!reset) {
            assert.ok(!html.includes('10/18'));
            assert.ok(!html.includes('10月18'));
          }
        }
    }
});

test('balance-only Muse usage update renders the retained weekly bar as stale while the updated balance stays fresh', () => {
  const t0 = Date.parse('2026-10-14T08:00:00Z');
  const t1 = Date.parse('2026-10-14T08:02:00Z');
  const html = renderToStaticMarkup(
    createElement(WebAgentQuotaRows, {
      now: t1,
      agents: [
        {
          ...agents[1]!,
          available: true,
          enabled: true,
          quota: {
            status: 'known',
            source: '网页自动刷新',
            observedAt: new Date(t1).toISOString(),
            windows: [
              {
                id: 'muse-weekly',
                label: '免费版',
                usedPercent: 87,
                resetsAt: '2026-10-18T08:00:00Z',
                observedAt: new Date(t0).toISOString(),
                durationMinutes: 10080,
                stale: true,
              },
            ],
            balances: [
              {
                id: 'muse-token-pack',
                label: '额外的使用额度',
                usedPercent: 10,
                remainingTokens: 20_000_000_000,
                observedAt: new Date(t1).toISOString(),
              },
            ],
          },
        },
      ],
    }),
  );
  assert.match(html, /quota-window warning" style="opacity:0\.55" title="上次读数"/);
  assert.match(html, /剩余 200 亿词元 · 从不过期/);
  assert.doesNotMatch(html, /上次读数 · 剩余 200 亿词元/);
});

test('11-minute-old Muse reading without learned refresh dims the bar and shows the settings hint and refresh button in normal and compact layouts', () => {
  const observedAt = Date.parse('2026-10-14T08:00:00Z');
  const now = observedAt + 11 * 60_000;
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(WebAgentQuotaRows, {
        compact,
        now,
        onRead() {},
        agents: [
          {
            ...agents[1]!,
            available: true,
            enabled: true,
            quota: {
              status: 'known',
              source: '网页自动刷新',
              observedAt: new Date(observedAt).toISOString(),
              windows: [
                {
                  id: 'muse-weekly',
                  label: '免费版',
                  usedPercent: 25,
                  resetsAt: '2026-10-18T08:00:00Z',
                  observedAt: new Date(observedAt).toISOString(),
                  durationMinutes: 10080,
                },
              ],
            },
          },
        ],
      }),
    );
    assert.match(html, /style="opacity:0\.55" title="上次读数"/);
    assert.match(html, /在 Muse 窗口打开 设置 → 通用 → 使用情况 即可刷新/);
    assert.match(html, /aria-label="Muse 读取用量"/);
  }
});

test('Grok empty usage never presents a saved success as a current reading and only hints at applicable login', () => {
  for (const compact of [false, true])
    for (const busy of [false, true])
      for (const usageEnabled of [false, true])
        for (const usageSource of ['separate', 'cursor-editor'] as const) {
          const html = renderToStaticMarkup(
            createElement(WebAgentQuotaRows, {
              agents: [
                {
                  ...agents[0]!,
                  usageEnabled,
                  usageSource,
                  grokDiagnostic: { code: 'success', step: 'parse', path: '/dashboard/spending' },
                },
              ],
              now: Date.parse('2026-10-14T08:00:00Z'),
              compact,
              busy,
            }),
          );
          assert.match(html, /没读到用量/);
          assert.doesNotMatch(html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, ''), /已读取用量/);
          assert.equal(
            html.includes('点击「登录用量账号」打开用量窗口'),
            usageEnabled && usageSource !== 'cursor-editor',
          );
        }
});

let cardCode: string;
let workspaceCode: string;
let participantCode: string;
before(async () => {
  cardCode = await uiBundle('tests/helpers/confirmation-fixture.ts');
  workspaceCode = await uiBundle('src/ui/Workspace.tsx');
  participantCode = await uiBundle('src/ui/ParticipantReply.tsx');
});

test('participants use distinct named hues in both themes and stable external IDs across display aliases', () => {
  const named = [
    ['Muse', 'muse', 'violet'],
    ['Grok Bot', 'grok-bot', 'amber'],
  ];
  for (const [name, id, hue] of named) {
    const expected = { '--participant-accent': `var(--participant-${hue})` };
    assert.deepEqual(participantStyle(name!), expected);
    assert.deepEqual(participantStyle('Renamed · Account', { id, category: 'external' }), expected);
  }
  const css = readFileSync(new URL('../src/ui/ParticipantReply.css', import.meta.url), 'utf8');
  const themes = [css.match(/:root\s*\{([^}]+)\}/)![1]!, css.match(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/)![1]!];
  for (const theme of themes) {
    const colors = ['violet', 'amber', 'blue', 'teal', 'slate', 'rose'].map(
      (hue) => theme.match(new RegExp(`--participant-${hue}:\\s*(#[\\da-f]+)`))?.[1],
    );
    assert.ok(colors.every(Boolean));
    assert.equal(new Set(colors).size, 6);
  }
});

test('device and role metadata override display names while external agent identity overrides a role preset', () => {
  const device = { ...reply(undefined), device: { id: 'device-a', name: 'Muse' } };
  const identities = [
    [participantIdentity(device, 'reviewer'), 'slate'],
    [participantIdentity(reply(undefined), 'reviewer'), 'rose'],
    [
      participantIdentity(
        reply({ agentId: 'muse', name: 'Alias', status: 'done', request: '', updatedAt: 'x' }),
        'reviewer',
      ),
      'violet',
    ],
  ] as const;
  for (const [identity, hue] of identities) {
    const style = participantStyle('Muse', identity);
    assert.deepEqual(style, { '--participant-accent': `var(--participant-${hue})` });
    const html = renderToStaticMarkup(
      createElement(ParticipantHeading, { name: 'Muse', identity, at: device.createdAt }),
    );
    assert.ok(html.includes(`style="--participant-accent:var(--participant-${hue})"`));
  }
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [device],
      workflows: [],
      state: { runs: [], targets: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.equal(
    (html.match(/--participant-accent:var\(--participant-slate\)/g) ?? []).length,
    2,
    'device card accent and avatar both use device identity',
  );
  const exchange = renderToStaticMarkup(
    createElement(ConversationExchange, {
      names: ['Muse', 'Grok Bot'],
      identities: [identities[0][0], identities[1][0]],
      count: 1,
      at: device.createdAt,
      preview: 'last',
      children: 'turn',
    }),
  );
  assert.equal((exchange.match(/--participant-accent:var\(--participant-slate\)/g) ?? []).length, 2);
  assert.match(exchange, /--participant-accent:var\(--participant-rose\)/);
});

test('unknown agents hash their stable ID into the shared palette rather than their display name', () => {
  const first = participantStyle('Muse', { id: 'unknown-a', category: 'external' });
  assert.deepEqual(first, participantStyle('New display name', { id: 'unknown-a', category: 'external' }));
  assert.notDeepEqual(first, participantStyle('Muse', { id: 'unknown-b', category: 'external' }));
  assert.match(
    String((first as Record<string, unknown>)['--participant-accent']),
    /var\(--participant-(violet|amber|blue|teal|slate|rose)\)/,
  );
});

test('pending delegated exchanges use device or external target identity before any role preset', () => {
  const stamp = '2026-10-11T08:00:00Z';
  const parent: Workflow = {
    id: 'parent',
    conversationId: 'a',
    projectId: 'project',
    userMessageId: 'user-parent',
    input: { content: 'Synthetic task', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'running',
    phase: 'execute',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
  for (const [target, hue] of [
    [{ deviceId: 'device-a' }, 'slate'],
    [{ externalAgentId: 'muse' as const }, 'violet'],
  ] as const) {
    const child: Workflow = {
      ...parent,
      id: 'child',
      userMessageId: 'user-child',
      delegation: {
        parentId: parent.id,
        role: 'reviewer',
        requestId: 'request',
        agent: { label: 'Renamed target', presetId: 'reviewer', ...target },
      },
    };
    const h = uiHarness(workspaceCode);
    const tree = h.render('ConversationHistory', {
      messages: [parent, child].map((workflow) => ({
        id: workflow.userMessageId,
        workflowId: workflow.id,
        conversationId: workflow.conversationId,
        role: 'user',
        content: workflow.input.content,
        createdAt: stamp,
      })),
      workflows: [parent, child],
      state: { runs: [], targets: [], runtimes: [], settings: {} },
      api: async () => ({}),
      notify() {},
      onInspect() {},
    });
    const exchange = findNode(tree, (node) => node.type?.name === 'ConversationExchange')!;
    assert.ok(exchange, 'pending delegation has an exchange header');
    assert.deepEqual(plain(participantStyle(exchange.props.names[1], exchange.props.identities[1])), {
      '--participant-accent': `var(--participant-${hue})`,
    });
    h.unmount();
  }
});

test('short replies reserve no expand slot and opened exchanges hide only the collapsed preview', () => {
  const html = renderToStaticMarkup(createElement(ParticipantBody, { children: 'Short turn' }));
  assert.match(html, /Short turn/);
  assert.doesNotMatch(html, /participant-expand-slot/);
  const css = readFileSync(new URL('../src/ui/ParticipantReply.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /participant-expand-slot|participant-body-content/);
  assert.match(css, /\.conversation-exchange\[open\] > summary \.exchange-preview\s*\{\s*display: none;/);
  assert.doesNotMatch(css, /border-left: [23]px solid var\(--participant-accent\)/);
});

test('known single and double mentions become chips; unknown names and email addresses stay intact', () => {
  const html = renderToStaticMarkup(
    createElement(MentionText, {
      text: '@@Muse 请看 @Grok Bot 的回答。 @Unknown a@Muse.test',
      names: ['Muse', 'Grok Bot'],
    }),
  );
  assert.equal((html.match(/class="participant-mention"/g) ?? []).length, 2);
  assert.match(html, /→ Muse/);
  assert.match(html, /→ Grok Bot/);
  assert.match(html, /@Unknown a@Muse.test/);
  assert.deepEqual(participantStyle('Muse'), participantStyle('Muse · Account'));
});

test('handoff wording is one compact status line inside the participant card, with labelled actions', () => {
  const message = reply({
    agentId: 'grok-bot',
    name: 'Grok Bot',
    status: 'needs-user',
    request: 'Task',
    updatedAt: 'x',
    handoff: true,
    note: '已复制到剪贴板并打开 Grok Bot',
  });
  message.content = 'Large duplicate status';
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message],
      workflows: [],
      state: { runs: [], targets: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /participant-card/);
  assert.match(html, /external-reply-note" role="status"/);
  assert.match(html, /已复制到剪贴板并打开 Grok Bot/);
  assert.doesNotMatch(html, /Large duplicate status/);
  assert.match(html, /aria-label="重试"/);
  assert.match(html, /aria-label="交给它"/);
});

test('long participant replies render every paragraph without an expand control', () => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => 'Reply paragraph ' + (index + 1));
  const html = renderToStaticMarkup(
    createElement(ParticipantBody, {
      children: createElement(MentionText, { text: paragraphs.join('\n\n'), names: [] }),
    }),
  );
  assert.equal((html.match(/<p>/g) ?? []).length, 30);
  for (const paragraph of paragraphs) assert.ok(html.includes(paragraph));
  assert.doesNotMatch(html, /participant-body-content|participant-expand-slot|展开全部|收起|<button/);
});

test('explicit peer exchanges group by pair, stay collapsed and preserve every turn and addressee', () => {
  const lines = Array.from({ length: 4 }, (_, i) => ({
    id: `turn-${i}`,
    at: `2026-10-11T08:0${i}:00Z`,
    from: i % 2 ? 'Muse' : 'Grok Bot',
    to: i % 2 ? 'Grok Bot' : 'Muse',
    text: `Turn ${i}`,
  }));
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [],
      workflows: [],
      peerLines: lines,
      state: { runs: [], targets: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  // Names and what was said are shown as written; the turn count stays interface text.
  assert.match(html, /<span translate="no">Grok Bot ↔ Muse<\/span> · 4 轮/);
  assert.match(html, /对话串/);
  assert.match(html, /exchange-preview" translate="no">Turn 3/);
  assert.equal((html.match(/class="exchange-turn"/g) ?? []).length, 4);
  assert.match(html, /participant-addressee" translate="no">→ Muse/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  // Native details/summary exposes all children on expansion, with no extra behaviour or fetch.
  const element = ConversationExchange({
    names: ['A', 'B'],
    count: 2,
    at: lines[0]!.at,
    preview: 'last',
    children: 'turn content',
  });
  assert.equal(element.type, 'details');
  assert.equal(element.props.children[0].type, 'summary');
  assert.equal(element.props.children[1].props.children, 'turn content');
});

test('the @@ list offers only external agents that are ready to answer, as a third kind', () => {
  const items = mentionItems([], [], agents);
  assert.deepEqual(
    items.map((item) => [item.kind, item.name]),
    [['external', 'Grok Bot']],
  );
  assert.match(items[0]!.description!, /粘贴/);
  const ranked = rankMentions(items, 'grok', { 'external:grok-bot': { count: 2, last: 9 } });
  assert.deepEqual(
    ranked.map((item) => item.id),
    ['grok-bot'],
  );
  const html = renderToStaticMarkup(
    createElement(MentionMenu, { items, active: 0, onHover() {}, onPick() {}, onCreate() {} }),
  );
  assert.match(html, /外部/);
  assert.doesNotMatch(html, /Muse/);
  assert.equal(externalAgentStatus(agents[1]!), '已关闭');
  assert.equal(
    externalAgentStatus({ ...agents[0]!, detection: { at: 'x', ok: true, note: '能找到输入框' } }),
    '回复不会回到这里',
  );
  assert.equal(
    externalAgentStatus({ ...agents[0]!, routine: { url: 'https://synthetic.invalid/routine', keyHint: 'fixture' } }),
    '可以使用',
  );
});

test('the 外部智能体 card: one-time risk confirmation, sign-in and page check', async () => {
  const calls: Array<{ path: string; body?: any; method?: string }> = [];
  let list = structuredClone(agents).map((agent) =>
    agent.id === 'muse' ? { ...agent, enabled: false, riskAccepted: false, available: false, reason: '已关闭' } : agent,
  );
  const api = async (path: string, body?: any, method?: string) => {
    calls.push({ path, body, method });
    if (method === 'PATCH') {
      list = list.map((agent) =>
        path.endsWith(agent.id) ? { ...agent, ...body, available: true, riskAccepted: true } : agent,
      );
      return { agents: list };
    }
    if (path.endsWith('/login')) return { message: '已打开 Muse 窗口' };
    if (path.endsWith('/detect')) return { ok: true, message: '找到了输入框和发送按钮。', agents: list };
    return { agents: list };
  };
  const notices: any[] = [];
  const h = uiHarness(cardCode);
  const store = h.exports.confirmationStore;
  const props = { api, notify: (notice: unknown) => notices.push(notice) };
  h.render('ExternalAgentsCard', props);
  await nextTurn();
  let tree = h.render('ExternalAgentsCard', props);
  assert.match(text(tree), /外部智能体/);
  assert.doesNotMatch(text(tree), /Codex 云端/);
  assert.match(text(tree), /Grok Bot/);
  assert.match(text(tree), /Muse/);
  assert.equal((text(tree).match(/它们的回复来自第三方，只作参考。/g) ?? []).length, 1);
  assert.ok(findNode(tree, (node) => node.type === 'h2' && !!findNode(node, (child) => child.type === 'small')));
  const museUrl = findNode(tree, (node) => node.props['aria-label'] === 'Muse 网址')!;
  assert.equal(museUrl.props.value, '', 'Muse starts with an empty address to fill in');

  const toggle = () =>
    findNode(h.render('ExternalAgentsCard', props), (node) => node.props['aria-label'] === '开启 Muse')!;
  toggle().props.onChange({ currentTarget: { checked: true } });
  const question = store.snapshot();
  assert.equal(question.options.title, '开启 Muse？');
  assert.equal(question.options.action, '开启 Muse');
  assert.equal(question.options.points.length, 4);
  assert.match(question.options.points.join('\n'), /使用条款/);
  assert.match(question.options.points.join('\n'), /不会看到或保存你的密码/);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0, 'waiting: nothing changes');
  store.resolve(question.id, false);
  await nextTurn();
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0, 'cancelled: nothing changes');
  toggle().props.onChange({ currentTarget: { checked: true } });
  store.resolve(store.snapshot().id, true);
  await nextTurn();
  const patch = calls.find((call) => call.method === 'PATCH')!;
  assert.equal(patch.path, '/api/external-agents/muse');
  assert.deepEqual(plain(patch.body), { enabled: true, acceptRisk: true });

  tree = h.render('ExternalAgentsCard', props);
  await button(tree, '登录')!.props.onClick();
  await nextTurn();
  assert.ok(calls.some((call) => call.path === '/api/external-agents/muse/login'));
  tree = h.render('ExternalAgentsCard', props);
  await findNode(tree, (node) => node.type === 'button' && text(node).includes('重新识别'))!.props.onClick();
  await nextTurn();
  assert.ok(calls.some((call) => call.path === '/api/external-agents/muse/detect'));
  assert.equal(notices.at(-1).message, '找到了输入框和发送按钮。');

  // An address is saved when the field is left.
  tree = h.render('ExternalAgentsCard', props);
  findNode(tree, (node) => node.props['aria-label'] === 'Muse 网址')!.props.onChange({
    target: { value: 'https://muse.example.test/' },
  });
  findNode(h.render('ExternalAgentsCard', props), (node) => node.props['aria-label'] === 'Muse 网址')!.props.onBlur();
  await nextTurn();
  assert.deepEqual(plain(calls.filter((call) => call.method === 'PATCH').at(-1)), {
    path: '/api/external-agents/muse',
    body: { url: 'https://muse.example.test/' },
    method: 'PATCH',
  });
  h.unmount();
});

test('Grok desktop enable goes straight to the API without web risk confirmation or website controls', async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const h = uiHarness(cardCode);
  const grok = { ...agents[0]!, enabled: false, available: false, riskAccepted: false };
  const props = {
    api: async (path: string, body?: any) => {
      calls.push({ path, body });
      return { agents: [{ ...grok, ...body }] };
    },
    notify() {},
  };
  h.render('ExternalAgentsCard', props);
  await nextTurn();
  const tree = h.render('ExternalAgentsCard', props);
  findNode(tree, (node) => node.props['aria-label'] === '开启 Grok Bot')!.props.onChange({
    currentTarget: { checked: true },
  });
  await nextTurn();
  assert.equal(h.exports.confirmationStore.snapshot(), undefined);
  assert.deepEqual(plain(calls.at(-1)), { path: '/api/external-agents/grok-bot', body: { enabled: true } });
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === 'Grok Bot 网址'),
    undefined,
  );
  assert.equal(button(tree, '重新识别'), undefined);
  const controls = findNode(tree, (node) => node.type?.name === 'GrokBotControls')!;
  assert.equal(controls.props.agent.id, 'grok-bot');
  const settings = controls.type(controls.props);
  assert.ok(findNode(settings, (node) => node.props['aria-label'] === 'Grok Bot 标识'));
  assert.ok(findNode(settings, (node) => node.props['aria-label'] === 'Grok Bot 用量来源'));
  assert.match(text(settings), /打开 Grok Bot.*打开用量设置.*登录用量账号.*读取 Grok Bot 用量/);
  h.unmount();
});

const reply = (externalAgent: ConversationMessage['externalAgent']): ConversationMessage => ({
  id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
  conversationId: 'a',
  role: 'assistant',
  content: '…',
  createdAt: '2026-10-11T08:00:00Z',
  externalAgent,
});

test('an old Codex Cloud reply renders its history label and saved diff without actions', async () => {
  const message = reply({
    agentId: 'codex-cloud' as unknown as NonNullable<ConversationMessage['externalAgent']>['agentId'],
    name: 'Codex Cloud',
    status: 'done',
    request: 'Synthetic change',
    updatedAt: 'x',
    task: {
      id: 'task_e_1',
      state: 'ready',
      projectPath: 'D:/repo',
      diff: 'diff --git a/a b/a\n+hello',
      files: 1,
      added: 1,
      removed: 0,
    },
  });
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message],
      workflows: [],
      state: { runs: [], targets: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /<strong translate="no">Codex Cloud<\/strong>/);
  assert.equal(participantKind(message), '历史消息');
  assert.match(html, /\+hello/);
  assert.doesNotMatch(
    html,
    /aria-label="(?:\u91cd\u8bd5|\u4ea4\u7ed9\u5b83|\u5e94\u7528\u5230\u672c\u5730|\u5237\u65b0\u72b6\u6001)"/,
  );
  const h = uiHarness(cardCode);
  const tree = h.render('ExternalReplyPanel', {
    message,
    api: async () => {
      assert.fail('retired reply must not call API');
    },
    notify() {},
  });
  assert.match(text(tree), /\+hello/);
  assert.equal(
    findNode(tree, (node) => node.type === 'button'),
    undefined,
  );
  h.unmount();
});

test('a web agent reply: third-party label when done; retry and hand-off when it could not answer', async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    return { ok: true };
  };
  const h = uiHarness(cardCode);
  const base = { agentId: 'grok-bot' as const, name: 'Grok Bot', request: '你好', updatedAt: 'x', untrusted: true };
  const done = h.render('ExternalReplyPanel', { api, notify() {}, message: reply({ ...base, status: 'done' }) });
  assert.match(text(done), /第三方回复/);
  assert.equal(button(done, '重试'), undefined);
  const failed = h.render('ExternalReplyPanel', {
    api,
    notify() {},
    message: reply({ ...base, status: 'needs-user', handoff: true, note: '页面要求人机验证。' }),
  });
  assert.match(text(failed), /人机验证/);
  await button(failed, '交给它')!.props.onClick();
  await nextTurn();
  await button(
    h.render('ExternalReplyPanel', { api, notify() {}, message: reply({ ...base, status: 'failed', handoff: true }) }),
    '重试',
  )!.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, [
    '/api/external-agents/messages/6f9619ff-8b86-4d11-b42d-00c04fc964ff/handoff',
    '/api/external-agents/messages/6f9619ff-8b86-4d11-b42d-00c04fc964ff/retry',
  ]);
  h.unmount();
});

test('a Grok Bot reply PugPort never received is pasted back once, from a form that can be cancelled', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { ok: true };
  };
  const base = { agentId: 'grok-bot' as const, name: 'Grok Bot', request: '你好', updatedAt: 'x' };
  const textarea = (tree: unknown) => findNode(tree, (node) => node.type === 'textarea');
  const handedOff = { ...reply({ ...base, status: 'done', awaitingReply: true }), content: grokBotHandoffNote };
  assert.equal(externalReplyIsNotice(handedOff), true, 'a handoff is a notice, not an answer');
  const h = uiHarness(cardCode);
  const props = { api, notify() {}, message: handedOff };
  let tree = h.render('ExternalReplyPanel', props);
  assert.match(text(tree), /已交接，等你带回回复/);
  assert.equal(textarea(tree), undefined);
  button(tree, '粘贴回复')!.props.onClick();
  tree = h.render('ExternalReplyPanel', props);
  assert.match(text(tree), /复制它对这条消息的回复.*只能附上一次/);
  assert.equal(button(tree, '附到这条消息')!.props.disabled, true, 'nothing pasted yet');
  button(tree, '取消')!.props.onClick();
  tree = h.render('ExternalReplyPanel', props);
  assert.equal(textarea(tree), undefined);
  button(tree, '粘贴回复')!.props.onClick();
  tree = h.render('ExternalReplyPanel', props);
  textarea(tree)!.props.onChange({ target: { value: '合成回复' } });
  tree = h.render('ExternalReplyPanel', props);
  await button(tree, '附到这条消息')!.props.onClick();
  await nextTurn();
  assert.deepEqual(plain(calls), [
    {
      path: '/api/external-agents/messages/6f9619ff-8b86-4d11-b42d-00c04fc964ff/import-reply',
      body: { text: '合成回复' },
    },
  ]);
  h.unmount();

  // A routine whose reply never arrived says what is missing; a pasted answer says where it came from.
  const routine = { replyHash: 'synthetic', sentAt: 'x' };
  const waiting = uiHarness(cardCode);
  const waitingProps = { api, notify() {}, message: reply({ ...base, status: 'needs-user', routine }) };
  button(waiting.render('ExternalReplyPanel', waitingProps), '粘贴回复')!.props.onClick();
  const explained = text(waiting.render('ExternalReplyPanel', waitingProps));
  assert.match(explained, /读不到 Grok Bot 里的结果/);
  assert.match(explained, /任务不会重新运行/);
  assert.doesNotMatch(explained, /已交接/);
  waiting.unmount();
  const pasted = uiHarness(cardCode).render('ExternalReplyPanel', {
    api,
    notify() {},
    message: reply({ ...base, status: 'done', untrusted: true, importedAt: 'x', routine }),
  });
  assert.match(text(pasted), /由你从 Grok Bot 复制过来/);
  assert.match(text(pasted), /第三方回复/);
  // Nothing reached Grok Bot after a failed or stopped handoff: retry and hand off again, no paste.
  const failed = uiHarness(cardCode).render('ExternalReplyPanel', {
    api,
    notify() {},
    message: reply({ ...base, status: 'failed', handoff: true }),
  });
  assert.equal(button(pasted, '粘贴回复'), undefined);
  assert.equal(button(failed, '粘贴回复'), undefined);
  assert.ok(button(failed, '重试'));
  assert.ok(button(failed, '交给它'));
  assert.equal(calls.length, 1);
});

test('a following reply keeps its body and trust note visible and offers stop following', async () => {
  const h = uiHarness(cardCode);
  const calls: string[] = [];
  const message = reply({
    agentId: 'muse',
    name: 'Muse',
    request: 'Question',
    updatedAt: 'x',
    status: 'done',
    untrusted: true,
    following: { trackerId: 'one' },
  });
  assert.equal(externalReplyIsNotice(message), false);
  const props = {
    message,
    api: async (path: string) => {
      calls.push(path);
      return { ok: true };
    },
    notify() {},
  };
  const tree = h.render('ExternalReplyPanel', props);
  assert.match(text(tree), /第三方回复/);
  assert.match(text(tree), /正在留意 Muse 的后续回复/);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'spinning'),
    undefined,
  );
  await button(tree, '停止跟进')!.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, [`/api/external-agents/messages/${message.id}/stop-following`]);
  const done = h.render('ExternalReplyPanel', {
    ...props,
    message: { ...message, externalAgent: { ...message.externalAgent, following: undefined, status: 'done' } },
  });
  assert.equal(button(done, '停止跟进'), undefined);
  assert.doesNotMatch(text(done), /正在留意/);
  h.unmount();
});

test('in the composer, an external agent picked with @@ answers that message itself', async () => {
  const stamp = '2026-10-11T08:00:00Z';
  const conversation = { id: 'a', projectId: 'project', title: 'a', createdAt: stamp, updatedAt: stamp };
  const answer = reply({
    agentId: 'grok-bot',
    name: 'Grok Bot',
    status: 'done',
    request: '你好',
    updatedAt: stamp,
    untrusted: true,
  });
  const state = {
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [],
    conversations: [conversation],
    runs: [],
    workflows: [],
    conversationMessages: [answer],
    targets: [],
    runtimes: [],
    approvals: [],
    plugins: [],
    settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
  };
  const bodies: any[] = [];
  const api = async (path: string, body: any) => {
    if (path === '/api/external-agents') return { agents };
    if (path.endsWith('/messages')) {
      bodies.push(body);
      return { message: { id: 'sent', conversationId: 'a', role: 'user', content: body.content, createdAt: stamp } };
    }
    return { messages: [answer] };
  };
  const session = new ComposerSession();
  const h = uiHarness(workspaceCode);
  const props = {
    state,
    api,
    conversation,
    composerSession: session,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => h.render('ConversationWorkspace', props);
  const input = () => findNode(render(), (node) => node.type === 'textarea' && node.props.id === 'conversation-input')!;
  input().props.onChange({ target: { value: '@@Gro' } });
  await nextTurn();
  // The agent list is asked for only once the @@ menu is open, so it arrives a moment later.
  render();
  await nextTurn();
  const menu = findNode(render(), (node) => node.type?.name === 'MentionMenu')!;
  const grok = menu.props.items.find(
    (item: { kind: string; id: string }) => item.kind === 'external' && item.id === 'grok-bot',
  );
  assert.ok(grok, 'the agent is offered');
  menu.props.onPick(grok);
  assert.equal(input().props.value, '@@Grok Bot ');
  input().props.onChange({ target: { value: '@@Grok Bot 你好' } });
  findNode(
    render(),
    (node) => node.type === 'form' && node.props.className.includes('conversation-composer'),
  )!.props.onSubmit({
    preventDefault() {},
  });
  await nextTurn();
  assert.equal(bodies[0].externalAgentId, 'grok-bot');
  assert.equal(bodies[0].content, '@@Grok Bot 你好');
  h.unmount();
  session.dispose();
});

test('an external agent reply is labelled with its name in the conversation', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [
        reply({
          agentId: 'grok-bot',
          name: 'Grok Bot',
          status: 'done',
          request: '你好',
          updatedAt: 'x',
          untrusted: true,
        }),
      ],
      workflows: [],
      state: { runs: [], workflows: [], targets: [], runtimes: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /participant-card/);
  assert.match(html, /<strong translate="no">Grok Bot<\/strong>/);
  assert.match(html, /participant-kind">桌面应用/);
  assert.match(html, /<time dateTime="2026-10-11T08:00:00Z"/);
  assert.match(html, /第三方回复/);
});

test('Grok handoff offers connector setup and reply source comes from that message', () => {
  let opened = 0;
  const h = uiHarness(cardCode);
  const base = {
    agentId: 'grok-bot' as const,
    name: 'Grok Bot',
    status: 'needs-user' as const,
    handoff: true,
    request: 'Synthetic',
    updatedAt: 'x',
  };
  for (const routine of [undefined, { replyHash: 'synthetic', sentAt: 'x' }]) {
    const message = reply({ ...base, routine });
    const tree = h.render('ExternalReplyPanel', {
      api: async () => ({}),
      notify() {},
      message,
      onManageConnectors: (id: string) => {
        assert.equal(id, 'grok-bot');
        opened++;
      },
    });
    const setup = button(tree, '设置例程，让回复回到 PugPort');
    assert.equal(!!setup, !routine);
    setup?.props.onClick();
    assert.equal(participantKind(message), routine ? '例程' : '桌面应用');
    const html = renderToStaticMarkup(
      createElement(ConversationHistory, {
        messages: [message],
        workflows: [],
        state: { runs: [], targets: [], settings: {} } as unknown as AppState,
        api: async <T>() => ({}) as T,
        notify() {},
        onInspect() {},
        onManageConnectors() {},
      }),
    );
    assert.ok(html.includes(`participant-kind">${routine ? '例程' : '桌面应用'}`));
    assert.equal(html.includes('设置例程，让回复回到 PugPort'), !routine);
  }
  assert.equal(opened, 1);
  h.unmount();
});

test('retired agent content remains plain text with neutral identity and no retry or handoff', async () => {
  const message = {
    id: 'old-dot',
    conversationId: 'c',
    role: 'assistant',
    content: 'OLD_DOT_CONTENT',
    createdAt: '2026-10-14T00:00:00Z',
    externalAgent: { agentId: 'dot', name: 'dot', status: 'failed', handoff: true, request: 'old request' },
  } as unknown as ConversationMessage;
  assert.equal(participantKind(message), '历史消息');
  assert.equal(externalReplyIsNotice(message), false);
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message],
      workflows: [],
      state: { runs: [], targets: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /OLD_DOT_CONTENT/);
  assert.match(html, /participant-kind">历史消息/);
  assert.doesNotMatch(html, /aria-label="(?:重试|交给它)"/);
  const h = uiHarness(await uiBundle('src/ui/ExternalAgents.tsx'));
  assert.equal(h.render('ExternalReplyPanel', { message, notify() {} }), null);
  h.unmount();
});
