/**
 * `pugport` with no arguments: a terminal chat with the running PugPort, in the current folder's project.
 * Live updates come from the same event stream the desktop app uses (`/api/events`).
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DevicesView } from '../shared/devices.ts';
import type { ExternalAgentView } from '../shared/external-agents.ts';
import { calledFields, freeChainMentionId, namedIn } from '../shared/participants.ts';
import { APP_VERSION } from '../shared/identity.ts';
import type { Locale } from '../shared/i18n/index.ts';
import { quotaLines, quotaTotals } from '../shared/quota-summary.ts';
import type {
  AppState,
  Conversation,
  ConversationMessage,
  Project,
  RunEvent,
  RunRecord,
  Workflow,
} from '../shared/types.ts';
import { BackendError, BackendUnavailable, type PugPortClient, type ServerEvent } from './client.ts';
import { ChatFooter, noteMessage, PugEditor, PugHeader, ReplyBlock, userMessage } from './components.ts';
import {
  applyRunEvent,
  identityLabel,
  liveRunFrom,
  newLiveRun,
  replyView,
  settledStatuses,
  type LiveRun,
  type ReplyView,
} from './conversation-view.ts';
import { chatHelp, slashCommandsIn } from './help.ts';
import { mentionItems, PugAutocomplete, type MentionItem } from './mentions.ts';
import {
  Container,
  isViewportTUI,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  type Terminal,
  type TUI,
} from './pi-tui.ts';
import { quotaReport, totalsSummary, type QuotaView } from './quota.ts';
import { messageRouting } from './routing.ts';
import type { Theme } from './theme.ts';

/** Conversations started from the terminal (and by `pugport ask`) carry this title prefix; --continue finds them. */
export const terminalTitlePrefix = 'Terminal · ';
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** A full state is several megabytes; parse it at most this often (live text comes through run events). */
const stateParseIntervalMs = 500;
const liveRunLimit = 20;

export type ChatOptions = { cwd: string; write: boolean; resume: boolean };
export type ChatDeps = {
  client: PugPortClient;
  theme: Theme;
  /** Starts or focuses the desktop app; false when it cannot be found. */
  openDesktop: () => boolean;
  /** The language of /help and the slash-command descriptions; Chinese, the source text, when not given. */
  locale?: Locale;
  terminal?: Terminal;
  /** Fullscreen like Pi by default; tests pass a main-screen renderer. */
  renderer?: (terminal: Terminal) => TUI;
};
type Tracked = { block: ReplyBlock; view?: ReplyView; finalMessage?: ConversationMessage };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const conversationTitle = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `${terminalTitlePrefix}${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}`;
};

export class TerminalChat {
  readonly ui: TUI;
  private readonly chat = new Container();
  private readonly editor: PugEditor;
  private readonly abort = new AbortController();
  private state?: AppState;
  private items: MentionItem[] = [];
  private outside: MentionItem[] = [];
  private outsideFetchedAt = 0;
  private outsidePending?: Promise<void>;
  private quota = '';
  private offline?: string;
  private project?: Promise<Project>;
  private conversation?: Conversation;
  private readonly replies = new Map<string, Tracked>();
  private readonly live = new Map<string, LiveRun>();
  private readonly messages = new Map<string, ConversationMessage>();
  private pendingState?: string;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private lastParse = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private lastCtrlC = 0;
  private fetching = false;
  private lastFetch = 0;
  private firstState!: () => void;
  private readonly stateReady = new Promise<void>((resolve) => (this.firstState = resolve));
  private finished!: (code: number) => void;
  private readonly done = new Promise<number>((resolve) => (this.finished = resolve));
  private closed = false;

  constructor(
    private readonly options: ChatOptions,
    private readonly deps: ChatDeps,
  ) {
    const terminal = deps.terminal ?? new ProcessTerminal();
    const theme = deps.theme;
    this.ui = deps.renderer
      ? deps.renderer(terminal)
      : new TuiAltScreen(terminal, false, undefined, {
          scrollToEndIndicator: () => theme.bg('userBg', ' ↓ 回到最新消息 · End '),
        });
    this.editor = new PugEditor(this.ui, theme.editor(), { paddingX: 1, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(
      new PugAutocomplete(
        slashCommandsIn(deps.locale ?? 'zh-CN'),
        () => [...this.items, ...this.outside],
        () => this.loadOutside(),
      ),
    );
    this.editor.onSubmit = (text) => void this.submit(text);
    this.editor.onEscape = () => this.cancelRunning();
    this.editor.onCtrlC = () => this.ctrlC();
    this.editor.onCtrlD = () => this.quit();
    this.editor.status = () => this.statusLine();
    const header = new PugHeader(theme, () => ({ version: APP_VERSION, write: options.write, quota: this.quota }));
    const footer = new ChatFooter(theme, () => ({
      cwd: options.cwd,
      write: options.write,
      ...(this.conversation ? { title: this.conversation.title } : {}),
      quota: this.quota,
      ...(this.lastLabel() ? { last: this.lastLabel() } : {}),
      ...(this.offline ? { offline: this.offline } : {}),
    }));
    const document = new Container();
    document.addChild(header);
    document.addChild(this.chat);
    if (isViewportTUI(this.ui)) {
      // Pi's fullscreen layout: the conversation scrolls, the editor and footer stay docked at the bottom.
      this.ui.addChild(document);
      this.ui.addChild(this.editor);
      this.ui.addChild(footer);
      this.ui.setLayoutRoot(
        new VStack([
          {
            component: new ScrollView(document, {
              follow: 'end',
              primary: true,
              overscroll: 'chain',
              scrollbarTrackStyle: (text) => theme.fg('border', text),
              scrollbarThumbStyle: (text) => theme.fg('muted', text),
            }),
            basis: 0,
            grow: 1,
            shrink: 1,
            minSize: 1,
          },
          {
            component: new VStack([
              { component: this.editor, shrink: 1, minSize: 3 },
              { component: footer, shrink: 1, minSize: 0 },
            ]),
            basis: 'auto',
            grow: 0,
            shrink: 1,
            minSize: 1,
          },
        ]),
      );
    } else {
      this.ui.addChild(document);
      this.ui.addChild(this.editor);
      this.ui.addChild(footer);
    }
    this.ui.setFocus(this.editor);
  }

  /** Runs until the user quits; resolves with the exit code. */
  async run(): Promise<number> {
    this.ui.terminal.setTitle(`PugPort · ${basename(this.options.cwd) || this.options.cwd}`);
    this.ui.start();
    void this.followTerminalColors();
    void this.connect();
    if (this.options.resume) void this.resume();
    return this.done;
  }

  quit(code = 0) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.stateTimer);
    clearInterval(this.spinnerTimer);
    this.abort.abort();
    const running = this.running().length;
    this.ui.stop();
    // Leaving the terminal does not stop the work: PugPort keeps the task going.
    if (running)
      this.ui.terminal.write(
        `还有 ${running} 条回复在 PugPort 里继续进行，可以在桌面应用里查看，或用 pugport --continue 回来。\r\n`,
      );
    this.finished(code);
  }

  private render() {
    if (!this.closed) this.ui.requestRender();
  }

  private note(text: string, tone?: 'muted' | 'error' | 'warning' | 'plain') {
    this.chat.addChild(noteMessage(this.deps.theme, text, tone));
    this.render();
  }

  private async followTerminalColors() {
    try {
      const colors = await this.ui.queryTerminalColors({ timeoutMs: 200 });
      if (!colors.background || this.closed) return;
      this.deps.theme.useTerminalBackground(colors.background);
      this.ui.invalidate();
      this.render();
    } catch {
      // Terminals that do not report colours keep the dark palette.
    }
  }

  // ---- live updates -------------------------------------------------------------------------------------

  private async connect() {
    let delay = 1000;
    while (!this.closed) {
      try {
        for await (const event of this.deps.client.events(this.abort.signal)) {
          if (this.offline) {
            this.offline = undefined;
            this.render();
          }
          delay = 1000;
          this.onEvent(event);
        }
      } catch {
        // Reconnect below.
      }
      if (this.closed) return;
      this.offline = '正在重新连接 PugPort…';
      this.render();
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private onEvent({ event, data }: ServerEvent) {
    if (event === 'state') {
      this.pendingState = data;
      if (this.stateTimer) return;
      const wait = Math.max(0, this.lastParse + stateParseIntervalMs - Date.now());
      this.stateTimer = setTimeout(() => {
        this.stateTimer = undefined;
        const text = this.pendingState;
        this.pendingState = undefined;
        this.lastParse = Date.now();
        if (text === undefined || this.closed) return;
        try {
          this.applyState(JSON.parse(text) as AppState);
        } catch {
          // A broken frame is replaced by the next one.
        }
      }, wait);
    } else if (event === 'run') {
      // Other conversations stream too; only keep runs while this terminal waits for a reply.
      if (!this.running().length) return;
      let value: { runId?: string; event?: RunEvent };
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof value.runId !== 'string' || !value.event) return;
      let run = this.live.get(value.runId);
      if (!run) {
        run = newLiveRun();
        this.live.set(value.runId, run);
        while (this.live.size > liveRunLimit) this.live.delete(this.live.keys().next().value!);
      }
      if (applyRunEvent(run, value.event)) this.refreshReplies();
    }
  }

  private async loadOutside(): Promise<void> {
    if (this.outsidePending) return this.outsidePending;
    if (Date.now() - this.outsideFetchedAt < 30_000) return;
    this.outsidePending = (async () => {
      const [devices, agents] = await Promise.all([
        this.deps.client.get<DevicesView>('/api/devices', { signal: this.abort.signal }),
        this.deps.client.get<{ agents: ExternalAgentView[] }>('/api/external-agents', { signal: this.abort.signal }),
      ]);
      this.outside = mentionItems([], [], agents.agents, devices.devices).filter(
        (item) => item.kind === 'device' || item.kind === 'external',
      );
      this.outsideFetchedAt = Date.now();
    })().finally(() => {
      this.outsidePending = undefined;
    });
    return this.outsidePending;
  }

  private applyState(state: AppState) {
    this.state = state;
    this.items = mentionItems(state.settings?.agentPresets, state.targets);
    this.quota =
      totalsSummary(quotaTotals(quotaLines(state.runtimes ?? [], state.targets ?? [])), this.deps.theme) ||
      this.deps.theme.fg('dim', '还没有订阅账号');
    for (const message of state.conversationMessages ?? [])
      if (message.conversationId === this.conversation?.id) this.messages.set(message.id, message);
    // Joining a run that is already streaming (or catching up after a reconnect): take the state's copy.
    const tracked = new Set(
      (state.workflows ?? [])
        .filter((workflow) => this.replies.has(workflow.id))
        .flatMap((workflow) => workflow.runIds),
    );
    for (const record of state.runs ?? []) {
      if (!tracked.has(record.id) || record.summary || !record.events?.length) continue;
      const latest = record.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
      const live = this.live.get(record.id);
      if (!live || latest > live.lastSeq) this.live.set(record.id, liveRunFrom(record));
    }
    this.firstState();
    this.refreshReplies();
  }

  private workflow(id: string): Workflow | undefined {
    return this.state?.workflows?.find((workflow) => workflow.id === id);
  }

  private refreshReplies() {
    let missingFinal = false;
    for (const [id, tracked] of this.replies) {
      if (tracked.view?.settled && tracked.finalMessage) continue;
      const workflow = this.workflow(id);
      if (!workflow) continue;
      const finalMessage = workflow.finalMessageId ? this.messages.get(workflow.finalMessageId) : undefined;
      if (settledStatuses.has(workflow.status) && workflow.finalMessageId && !finalMessage) missingFinal = true;
      const view = replyView({
        workflow,
        runs: (this.state?.runs ?? []) as RunRecord[],
        live: this.live,
        targets: this.state?.targets ?? [],
        ...(finalMessage ? { finalMessage } : {}),
      });
      tracked.view = view;
      if (finalMessage) tracked.finalMessage = finalMessage;
      tracked.block.update(view);
    }
    if (missingFinal) void this.fetchMessages();
    this.syncSpinner();
    this.render();
  }

  /** The final answer is not always in the state's recent messages; read the conversation (at most every 3 s). */
  private async fetchMessages() {
    if (this.fetching || !this.conversation || Date.now() - this.lastFetch < 3000) return;
    this.fetching = true;
    this.lastFetch = Date.now();
    try {
      const detail = await this.deps.client.get<{ messages: ConversationMessage[] }>(
        `/api/conversations/${encodeURIComponent(this.conversation.id)}`,
        { signal: this.abort.signal },
      );
      for (const message of detail.messages ?? []) this.messages.set(message.id, message);
    } catch {
      return;
    } finally {
      this.fetching = false;
    }
    this.refreshReplies();
  }

  private running() {
    return [...this.replies.entries()].filter(([, tracked]) => !tracked.view?.settled);
  }

  private syncSpinner() {
    const busy = this.running().length > 0;
    if (busy && !this.spinnerTimer)
      this.spinnerTimer = setInterval(() => {
        this.frame = (this.frame + 1) % spinner.length;
        this.render();
      }, 100);
    else if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private statusLine() {
    const running = this.running();
    if (!running.length) return undefined;
    const { theme } = this.deps;
    const view = running.at(-1)![1].view;
    const more = running.length > 1 ? ` （另有 ${running.length - 1} 条在排队）` : '';
    return `${theme.fg('accent', spinner[this.frame]!)} ${theme.fg('muted', `${view?.activity ?? '已发送，等 PugPort 接手'}${more}`)}${theme.fg('dim', ' · Esc 取消')}`;
  }

  private lastLabel() {
    const views = [...this.replies.values()].map((tracked) => tracked.view).filter((view) => view?.label);
    return ([...views].reverse().find((view) => view!.settled) ?? views.at(-1))?.label;
  }

  // ---- sending --------------------------------------------------------------------------------------------

  private ensureProject() {
    this.project ??= this.deps.client
      .post<Project>('/api/projects', { path: this.options.cwd }, { signal: this.abort.signal })
      .catch((error: unknown) => {
        this.project = undefined;
        throw error;
      });
    return this.project;
  }

  private async ensureConversation(firstMessage: string) {
    if (this.conversation) return this.conversation;
    const project = await this.ensureProject();
    this.conversation = await this.deps.client.post<Conversation>(
      '/api/conversations',
      { projectId: project.id, title: conversationTitle(firstMessage) },
      { signal: this.abort.signal },
    );
    return this.conversation;
  }

  private track(workflow: Workflow) {
    if (this.replies.has(workflow.id)) return false;
    const block = new ReplyBlock(this.deps.theme);
    this.replies.set(workflow.id, { block });
    this.chat.addChild(block);
    block.update(replyView({ workflow, runs: [], live: this.live, targets: this.state?.targets ?? [] }));
    this.refreshReplies();
    return true;
  }

  private async submit(input: string) {
    const text = input.trim();
    if (!text) return;
    this.editor.addToHistory(text);
    if (/^\/[a-z]+$/i.test(text)) {
      await this.command(text.slice(1).toLowerCase());
      return;
    }
    this.chat.addChild(userMessage(this.deps.theme, text));
    this.render();
    try {
      const conversation = await this.ensureConversation(text);
      // One called answers the message itself; several share it out through a coordinator, as in the desktop app.
      if (text.includes('@@')) await this.loadOutside().catch(() => undefined);
      const called = namedIn(text, [...this.items, ...this.outside]);
      const freeChain = called.some((item) => item.id === freeChainMentionId);
      const fields = freeChain ? { freeChain: true } : calledFields(called);
      const sent = await this.deps.client.post<{
        message?: ConversationMessage;
        workflow?: Workflow;
        steered?: boolean;
      }>(
        `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {
          clientMessageId: randomUUID(),
          content: text,
          ...messageRouting({ write: this.options.write }),
          ...fields,
        },
        { signal: this.abort.signal, timeoutMs: 60_000 },
      );
      if (sent.workflow && !this.track(sent.workflow) && sent.steered) this.note('已补充给正在进行的回复。');
    } catch (error) {
      if (this.closed) return;
      this.note(
        error instanceof BackendUnavailable ? `没有发出去：${error.message}` : `没有发出去：${errorText(error)}`,
        'error',
      );
    }
  }

  private async command(name: string) {
    const { theme, client } = this.deps;
    if (name === 'quit' || name === 'exit') return this.quit();
    if (name === 'help') return this.note(chatHelp(this.deps.locale ?? 'zh-CN'));
    if (name === 'new') {
      this.conversation = undefined;
      this.replies.clear();
      this.chat.clear();
      this.syncSpinner();
      return this.note('开始新对话。下一条消息会新建一个对话。');
    }
    if (name === 'open')
      return this.note(
        this.deps.openDesktop() ? '正在打开 PugPort 桌面应用…' : '找不到 PugPort 桌面应用，请手动打开。',
      );
    if (name === 'status') {
      try {
        this.note(quotaReport(await client.get<QuotaView>('/api/tray', { signal: this.abort.signal }), theme), 'plain');
      } catch (error) {
        this.note(`读不到额度：${errorText(error)}`, 'error');
      }
      return;
    }
    this.note(`没有 /${name} 这个命令。输入 /help 查看可用命令。`, 'warning');
  }

  /** Esc: stop every reply this terminal is still waiting for. */
  private cancelRunning() {
    const running = this.running();
    if (!running.length) return false;
    for (const [id] of running)
      void this.deps.client
        .post(`/api/workflows/${encodeURIComponent(id)}/cancel`, {}, { signal: this.abort.signal })
        .catch((error: unknown) => {
          if (!this.closed && !(error instanceof BackendError && error.status === 404))
            this.note(`取消没有成功：${errorText(error)}`, 'error');
        });
    this.note('正在取消…');
    return true;
  }

  /** Ctrl+C: cancel a running reply or clear the input; twice in a row, or on an empty idle prompt, quit. */
  private ctrlC() {
    const now = Date.now();
    const again = now - this.lastCtrlC < 1000;
    this.lastCtrlC = now;
    if (again) return this.quit();
    if (this.cancelRunning()) return this.note('再按一次 Ctrl+C 退出。');
    if (this.editor.getText()) {
      this.editor.setText('');
      return this.render();
    }
    this.quit();
  }

  // ---- --continue ------------------------------------------------------------------------------------------

  private async resume() {
    try {
      const project = await this.ensureProject();
      // Unref'd so a chat that quits early does not keep the process alive for the rest of the wait.
      await Promise.race([this.stateReady, new Promise((resolve) => setTimeout(resolve, 15_000).unref())]);
      const latest = (this.state?.conversations ?? [])
        .filter(
          (conversation) =>
            conversation.projectId === project.id &&
            conversation.title.startsWith(terminalTitlePrefix) &&
            !conversation.deletedAt &&
            !conversation.sideChat,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!latest) return this.note('这个文件夹里还没有从终端开始的对话，下一条消息会新建一个。');
      const detail = await this.deps.client.get<{
        conversation: Conversation;
        messages: ConversationMessage[];
        workflows: Workflow[];
      }>(`/api/conversations/${encodeURIComponent(latest.id)}`, { signal: this.abort.signal });
      if (this.closed || this.conversation) return;
      this.conversation = detail.conversation;
      const targets = this.state?.targets ?? [];
      for (const message of detail.messages) {
        this.messages.set(message.id, message);
        if (message.role === 'user') this.chat.addChild(userMessage(this.deps.theme, message.content));
        else {
          const block = new ReplyBlock(this.deps.theme);
          const label = identityLabel(message.replyIdentity, targets);
          block.update({
            workflowId: message.workflowId ?? message.id,
            status: 'completed',
            settled: true,
            ...(label ? { label } : {}),
            activity: '完成',
            text: message.content,
            tools: [],
          });
          this.chat.addChild(block);
        }
      }
      for (const workflow of detail.workflows)
        if (!settledStatuses.has(workflow.status) && !workflow.deletedAt) this.track(workflow);
      this.note(`接着上次的对话：${detail.conversation.title}`);
    } catch (error) {
      if (!this.closed) this.note(`没能接上次的对话：${errorText(error)}`, 'error');
    }
  }
}
