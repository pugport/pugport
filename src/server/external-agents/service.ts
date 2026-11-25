import { packExternalContext } from './context-pack.ts';
import { GrokRoutineStore, grokReplyHash, grokWaitingNote, postGrokRoutine } from './grok-routine.ts';
import { ensureGrokBotRunning, grokDesktopMissingNote, grokDesktopRequiredNote } from './grok-desktop.ts';
import { cleanGrokDiagnostic, grokDiagnostic } from '../../shared/grok-usage.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Conversation, ConversationMessage, MessageInput, Workflow } from '../../shared/types.ts';
import { normalizeAgentName } from '../agent-names.ts';
import {
  carriesThirdPartyWords,
  isThirdPartyAgent,
  activeWebCooldown,
  webQuotaLabel,
  webQuotaStale,
  webUsageInvitation,
  externalAgentCatalog,
  externalAgentIds,
  externalMention,
  externalInvocation,
  isExternalAgentId,
  withoutMention,
  grokBotUrl,
  grokBotUsageUrl,
  grokBotUsagePage,
  grokBotUsageAgentId,
  grokBotHandoffNote,
  canImportReply,
  type ExternalAgentId,
  type ExternalAgentMessage,
  type ExternalAgentView,
} from '../../shared/external-agents.ts';
import { webAgentUrl, type WebAgentResult } from '../../shared/web-bridge.ts';
import type { Workspace } from '../workspace.ts';
import { ExternalAgentConfig, invalidExternalAgentConfigMessage, parseWebUsage, type AgentSettings } from './config.ts';
import {
  mergeWebUsage,
  redactedUsageSample,
  safeWebUsageRoute,
  usageSignatureSchema,
  webQuotaSchema,
} from './usage.ts';
import { desktopWebBridge, type WebBridge } from './web-bridge-client.ts';
import {
  cursorIdentityHash,
  fetchGrokBotUsage,
  readCursorEditorSession,
  type CursorEditorSession,
} from '../cursor-usage.ts';

export type ExternalAgentsOptions = {
  routineStore?: GrokRoutineStore;
  routinePost?: Parameters<typeof postGrokRoutine>[3];
  routineDesktop?: Parameters<typeof ensureGrokBotRunning>[0];
  bridge?: WebBridge;
  now?: () => number;
  /** Check web replies and usage on a timer (tests call poll() themselves). */
  autoPoll?: boolean;
  /** Web replies: the overall wait, and how long the page must stay still before the reply counts as finished. */
  webTimeoutMs?: number;
  webStableMs?: number;
  webFollowPollMs?: number;
  webFollowSilenceMs?: number;
  webFollowMaxMs?: number;
  grokUsage?: Parameters<typeof fetchGrokBotUsage>[1] & { session?: () => Promise<CursorEditorSession | undefined> };
};
export type ExternalAgentPatch = {
  added?: true;
  enabled?: boolean;
  acceptRisk?: true;
  url?: string;
  usageUrl?: string;
  botId?: string;
  usageEnabled?: boolean;
  usageSource?: 'separate' | 'cursor-editor';
  /** Confirms the account behind the reading the user saw; any other value is refused. */
  usageAccountConfirmed?: string;
};

const hour = 3_600_000;
function zUsageSignatures(raw: unknown[]) {
  if (raw.length > 4) return;
  const parsed = raw.map((value) => usageSignatureSchema.safeParse(value));
  if (parsed.some((value) => !value.success)) return;
  return parsed.map((value) => value.data!);
}
function webFailure(code: WebAgentResult['code'], name: string): string {
  switch (code) {
    case 'human-check':
      return `页面要求人机验证。已打开 ${name} 窗口，请在那里完成，然后点「重试」。`;
    case 'login':
      return `需要先登录 ${name}。已打开它的窗口，请登录后点「重试」。`;
    case 'not-detected':
      return `没认出 ${name} 页面上的输入框。可以在设置里点「重新识别」，或点「交给它」自己粘贴发送。`;
    case 'not-sent':
      return '没能把消息发出去。可以点「重试」，或点「交给它」自己粘贴发送。';
    case 'timeout':
      return `${name} 太久没有回复完。可以点「重试」，或到它的窗口里查看。`;
    case 'load-failed':
      return `打不开 ${name} 的网页，请检查网址和网络。`;
    case 'closed':
      return `${name} 的窗口被关掉了，这条没有发完。可以点「重试」。`;
    case 'unavailable':
      return '网页智能体只能在 PugPort 桌面版里使用。';
    default:
      return `${name} 出错了，请稍后重试。`;
  }
}

/**
 * Agents outside PugPort the user calls with @@: a message naming one is answered here instead of by the router.
 * Web agents take one message at a time each, and their replies are third-party words.
 */
export class ExternalAgents {
  readonly config: ExternalAgentConfig;
  readonly routineStore: GrokRoutineStore;
  private readonly bridge: WebBridge;
  private readonly queues = new Map<ExternalAgentId, string[]>();
  private readonly running = new Map<ExternalAgentId, string>();
  private readonly routineReplies = new Map<string, number>();
  private readonly follows = new Map<
    string,
    {
      agentId: ExternalAgentId;
      trackerId: string;
      token: string;
      started: number;
      changed: number;
      next: number;
      busy: boolean;
    }
  >();
  private readonly interruptedFollows = new Map<
    string,
    {
      agentId: ExternalAgentId;
      trackerId: string;
      started: number;
    }
  >();
  private readonly cancelled = new Set<string>();
  /** Parts of a coordinated task waiting for their reply to finish (run). */
  private readonly waiters = new Map<string, (agent: ExternalAgentMessage) => void>();
  private checking = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private readonly loggedIn = new Set<ExternalAgentId>();
  private readonly webRevisions = new Map<ExternalAgentId, number>();
  private readonly conversationThreads = new Map<string, string>();
  private readonly webRevisionPrefix = randomUUID();
  private readonly usageCheckedAt = new Map<ExternalAgentId, number>();
  private readingUsage = false;
  private readingUsageAgent?: ExternalAgentId;
  private museTaskUsageAt?: number;
  private readonly pendingUsage = new Set<ExternalAgentId>();
  private grokDiagnostic?: ExternalAgentView['grokDiagnostic'];
  private grokBridgeResult = '';
  private grokQuota?: ExternalAgentView['quota'];
  /** Hash of the account behind `grokQuota`, when its usage source reports one. */
  private grokAccount?: string;
  private grokReading?: Promise<void>;
  private grokController?: AbortController;
  constructor(
    private readonly workspace: Workspace,
    dataDir: string,
    private readonly options: ExternalAgentsOptions = {},
  ) {
    this.config = new ExternalAgentConfig(dataDir);
    this.routineStore = options.routineStore ?? new GrokRoutineStore();
    this.bridge = options.bridge ?? desktopWebBridge;
    this.resume();
    if (options.autoPoll !== false) {
      this.timer = setInterval(() => void this.poll(), 5000);
      this.timer.unref();
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private stamp() {
    return new Date(this.now()).toISOString();
  }
  private webCurrent(id: ExternalAgentId) {
    const revision = this.webRevisions.get(id);
    return () => !this.closed && this.webRevisions.get(id) === revision;
  }
  private webVersion(id: ExternalAgentId) {
    return `${this.webRevisionPrefix}:${this.webRevisions.get(id) ?? 0}`;
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [messageId, follow] of this.follows) {
      this.stopTracker(follow.agentId, follow.trackerId);
      this.follows.delete(messageId);
    }
    this.interruptedFollows.clear();
    this.pendingUsage.clear();
    this.grokController?.abort();
  }

  list(): ExternalAgentView[] {
    return externalAgentIds.map((id) => this.view(id));
  }
  view(id: ExternalAgentId): ExternalAgentView {
    const meta = externalAgentCatalog[id];
    const configInvalid = this.config.hasError();
    const saved = this.config.agent(id);
    const base = { id, name: meta.name, kind: meta.kind, description: meta.description, enabled: !!saved.enabled };
    if (meta.kind === 'handoff') {
      const routine = this.routineStore.view();
      const reason = configInvalid
        ? invalidExternalAgentConfigMessage.replace(/。$/, '')
        : !saved.enabled
          ? '已关闭'
          : !routine && !this.bridge.available()
            ? '只能在 PugPort 桌面版里使用'
            : undefined;
      return {
        ...base,
        added: !!saved.added || !!routine,
        routine,
        ...(routine ? { description: '通过例程发送任务，回复回到 PugPort' } : {}),
        grokDiagnostic: this.grokDiagnostic ?? saved.grokDiagnostic,
        botId: saved.botId ?? '',
        usageEnabled: saved.usageEnabled,
        usageSource: saved.usageSource ?? 'separate',
        ...(saved.usageEnabled && this.grokQuota?.status === 'known'
          ? {
              usageAccount: !this.grokAccount
                ? { status: 'unverified' as const }
                : {
                    status:
                      saved.usageAccountConfirmed === this.grokAccount
                        ? ('matches' as const)
                        : saved.usageAccountConfirmed
                          ? ('different' as const)
                          : ('unverified' as const),
                    fingerprint: this.grokAccount,
                  },
            }
          : {}),
        quota: saved.usageEnabled
          ? (this.grokQuota ?? {
              status: 'unknown',
              windows: [],
              source:
                saved.usageSource === 'cursor-editor' ? 'Cursor 登录 · Grok Bot 用量' : '独立登录 · Grok Bot 用量',
              observedAt: null,
              note: '没读到用量 · 请登录 Grok Bot 用的账号',
            })
          : {
              status: 'unknown',
              windows: [],
              source:
                saved.usageSource === 'cursor-editor' ? 'Cursor 登录 · Grok Bot 用量' : '独立登录 · Grok Bot 用量',
              observedAt: null,
              note: '已关闭 Grok Bot 用量读取。',
            },
        available: !reason,
        ...(reason ? { reason } : {}),
      };
    }
    const url = saved.url ?? '';
    const reason = configInvalid
      ? invalidExternalAgentConfigMessage.replace(/。$/, '')
      : !saved.enabled
        ? '已关闭'
        : !url
          ? '还没填网址'
          : !webAgentUrl(url)
            ? '网址不对，要以 https:// 开头'
            : !saved.riskAcceptedAt
              ? '还没确认风险提示'
              : !this.bridge.available()
                ? '只能在 PugPort 桌面版里使用'
                : undefined;
    return {
      ...base,
      added: !!saved.added,
      url,
      usageUrl: saved.usageUrl ?? '',
      ...(saved.quota
        ? {
            quota: { ...saved.quota, ...(webQuotaStale(saved.quota, this.now()) ? { stale: true } : {}) },
          }
        : {}),
      usageSignatures: saved.usageSignatures ?? [],
      usageDiagnostics: saved.usageDiagnostics ?? [],
      ...(activeWebCooldown(saved.cooldown, this.now()) ? { cooldown: saved.cooldown } : {}),
      riskAccepted: !!saved.riskAcceptedAt,
      available: !reason,
      ...(reason ? { reason } : {}),
      ...(saved.detection ? { detection: saved.detection } : {}),
      queued: (this.queues.get(id)?.length ?? 0) + (this.running.has(id) ? 1 : 0),
    };
  }

  update(id: ExternalAgentId, patch: ExternalAgentPatch): ExternalAgentView {
    if (this.config.hasError()) throw new Error(invalidExternalAgentConfigMessage);
    const meta = externalAgentCatalog[id];
    const saved = this.config.agent(id);
    const next: AgentSettings = {};
    const usageSourceChanged =
      patch.usageSource !== undefined && patch.usageSource !== (saved.usageSource ?? 'separate');
    const usageEnabledChanged = patch.usageEnabled !== undefined && patch.usageEnabled !== saved.usageEnabled;
    if (patch.usageAccountConfirmed !== undefined) {
      if (usageSourceChanged || patch.usageAccountConfirmed !== this.view(id).usageAccount?.fingerprint)
        throw new Error('用量账号已变化，请看过新的读数后再确认。');
      next.usageAccountConfirmed = patch.usageAccountConfirmed;
    }
    if (patch.botId !== undefined) {
      if (id !== 'grok-bot') throw new Error('这个智能体没有 Bot ID。');
      const botId = patch.botId.trim();
      grokBotUrl(botId);
      next.botId = botId;
    }
    if (patch.usageSource !== undefined) {
      if (id !== 'grok-bot' || !['separate', 'cursor-editor'].includes(patch.usageSource))
        throw new Error('用量来源无效。');
      next.usageSource = patch.usageSource;
      if (usageSourceChanged) {
        next.usageAccountConfirmed = undefined;
        next.grokDiagnostic = undefined;
        this.grokController?.abort();
        this.grokQuota = undefined;
        this.grokDiagnostic = undefined;
        this.grokBridgeResult = '';
        this.usageCheckedAt.delete(id);
      }
    }
    if (patch.usageEnabled !== undefined) {
      if (id !== 'grok-bot') throw new Error('这个智能体没有此用量开关。');
      next.usageEnabled = patch.usageEnabled;
      if (usageEnabledChanged) {
        next.grokDiagnostic = undefined;
        this.grokDiagnostic = undefined;
        this.grokBridgeResult = '';
        this.grokController?.abort();
        this.grokController = undefined;
        this.grokQuota = undefined;
        this.usageCheckedAt.delete(id);
      }
    }
    if (patch.usageUrl !== undefined) {
      if (meta.kind !== 'web') throw new Error(`${meta.name} 没有用量页面。`);
      const usageUrl = patch.usageUrl.trim();
      if (usageUrl && !webAgentUrl(usageUrl)) throw new Error('用量页面网址要以 https:// 开头。');
      next.usageUrl = usageUrl;
      if (usageUrl !== (saved.usageUrl ?? '')) {
        next.quota = undefined;
        next.usageSignatures = undefined;
        next.usageDiagnostics = undefined;
        this.usageCheckedAt.delete(id);
      }
    }
    if (patch.url !== undefined && meta.kind !== 'handoff') {
      if (meta.kind !== 'web') throw new Error(`${meta.name} 没有网址可填。`);
      const url = patch.url.trim();
      if (url && !webAgentUrl(url)) throw new Error('网址要以 https:// 开头。');
      next.url = url;
    }
    if (patch.enabled === true && meta.kind === 'web' && !saved.riskAcceptedAt) {
      if (patch.acceptRisk !== true) throw new Error('开启前要先确认风险提示。');
      next.riskAcceptedAt = this.stamp();
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.added === true || Object.keys(next).length > 0) next.added = true;
    const urlChanged = next.url !== undefined && next.url !== saved.url;
    const nextOrigin = URL.parse(next.url ?? saved.url ?? '')?.origin;
    const savedOrigins = [
      URL.parse(saved.url ?? '')?.origin,
      URL.parse(saved.usageUrl ?? '')?.origin,
      ...(saved.usageSignatures ?? []).map((sig) => sig.origin),
    ].filter(Boolean);
    const siteChanged =
      urlChanged || (nextOrigin !== undefined && savedOrigins.some((origin) => origin !== nextOrigin));
    if (siteChanged) {
      if (patch.usageUrl === undefined) next.usageUrl = undefined;
      next.quota = undefined;
      next.cooldown = undefined;
      next.detection = undefined;
      next.usageSignatures = undefined;
      next.usageDiagnostics = undefined;
      next.usageAttemptedAt = undefined;
      next.usageSignedOut = undefined;
      this.config.resetSelectors(id);
      for (const key of this.conversationThreads.keys())
        if (key.startsWith(`${id}:`)) this.conversationThreads.delete(key);
    }
    if (patch.enabled === false || (next.url !== undefined && next.url !== saved.url)) this.loggedIn.delete(id);
    this.config.update(id, next);
    if (
      meta.kind === 'web' &&
      (urlChanged ||
        (patch.usageUrl !== undefined && next.usageUrl !== (saved.usageUrl ?? '')) ||
        (next.enabled !== undefined && next.enabled !== saved.enabled))
    ) {
      this.webRevisions.set(id, (this.webRevisions.get(id) ?? 0) + 1);
      this.usageCheckedAt.delete(id);
      if (urlChanged || !this.view(id).enabled) {
        this.pendingUsage.delete(id);
        for (const [messageId, follow] of this.follows)
          if (follow.agentId === id)
            this.endFollowing(messageId, '网页设置已更改；这条消息可能已发送，请到原窗口查看，避免重复发送。', false);
      }
    }
    if (meta.kind === 'handoff' && saved.usageLoginCreated && (usageEnabledChanged || usageSourceChanged))
      void this.bridge
        .request(
          {
            action: 'monitor',
            agentId: grokBotUsageAgentId,
            name: meta.name,
            url: grokBotUsagePage,
            enabled:
              (next.usageEnabled ?? saved.usageEnabled) === true &&
              (next.usageSource ?? saved.usageSource ?? 'separate') === 'separate',
          },
          10_000,
        )
        .catch(() => undefined);
    return this.view(id);
  }

  requireAvailable(id: ExternalAgentId) {
    const view = this.view(id);
    const reason =
      view.added === false
        ? '尚未添加'
        : !view.enabled
          ? '已关闭'
          : !view.available
            ? (view.reason ?? '现在不能用')
            : undefined;
    if (reason) throw new Error(`${view.name} 当前不可用：${reason}`);
    return view;
  }

  /**
   * A message that calls an external agent (picked from the @@ list, or typed out in full for one that is ready)
   * is answered by that agent. Returns undefined for every other message, which goes to the router as usual.
   */
  intercept(conversationId: string, input: MessageInput & { externalAgentId?: string }, allowNaturalLanguage = false) {
    const natural =
      allowNaturalLanguage &&
      !input.externalAgentId &&
      !input.deviceId &&
      !input.participants?.length &&
      !input.permissionOrigin &&
      !input.untrustedContent &&
      externalInvocation(
        input.intentText ?? input.content,
        externalAgentIds.map((id) => ({ id, name: externalAgentCatalog[id].name })),
      );
    if (input.externalAgentId === undefined && !input.content.includes('@@') && !natural) return undefined;
    let id: ExternalAgentId | undefined;
    if (input.externalAgentId !== undefined) {
      if (!isExternalAgentId(input.externalAgentId)) throw new Error('不认识这个外部智能体。');
      id = input.externalAgentId;
    } else if (input.content.includes('@@')) id = externalMention(input.content, this.list())?.id;
    else if (natural)
      id = this.list().find((agent) => agent.id === natural.id && agent.enabled && agent.available && agent.added)?.id;
    if (!id) return undefined;
    const view = this.requireAvailable(id);
    if (input.attachmentIds?.length) throw new Error(`${view.name} 暂时收不了附件，请去掉附件再发。`);
    const store = this.workspace.store;
    const conversation = store.get<Conversation>('conversation', conversationId);
    if (!conversation || conversation.deletedAt) throw new Error('对话不存在。');
    const request = [
      natural && !input.content.includes('@@') ? input.content : withoutMention(input.content, view.name),
      ...(input.quotes ?? []).map(
        (quote) => `> ${quote.text.replace(/\n/g, '\n> ')}${quote.note ? `\n${quote.note}` : ''}`,
      ),
    ]
      .filter((part) => part.trim())
      .join('\n\n')
      .trim();
    if (!request) throw new Error(`请在 @${view.name} 后面写上要它做的事。`);
    const message = store.addMessage(conversationId, 'user', input.content);
    if (input.clientMessageId) message.clientMessageId = input.clientMessageId;
    if (input.quotes?.length) message.quotes = input.quotes;
    // An exchange with a web agent stays between the user and that agent: PugPort's executors never get it as
    // context, so the conversation keeps its tools.
    message.externalRequest = { agentId: id, ...(isThirdPartyAgent(view) ? { thirdParty: true } : {}) };
    store.save('message', message.id, conversationId, message);
    const reply = store.addMessage(
      conversationId,
      'assistant',
      view.kind === 'web' ? `已交给 ${view.name}，排队中…` : `正在把任务交给 ${view.name}…`,
    );
    reply.externalAgent = {
      agentId: id,
      name: view.name,
      status: 'queued',
      request,
      updatedAt: this.stamp(),
      ...(view.routine ? { routineRequested: true } : {}),
      ...(isThirdPartyAgent(view) ? { untrusted: true } : {}),
    };
    store.save('message', reply.id, conversationId, reply);
    if (conversation.title === '新对话') conversation.title = input.content.replace(/\s+/g, ' ').slice(0, 48);
    conversation.updatedAt = this.stamp();
    delete conversation.archivedAt;
    store.save('conversation', conversation.id, conversation.projectId, conversation);
    this.workspace.notifyConversationChanged(conversationId);
    this.enqueue(id, reply.id);
    return { message, reply };
  }

  /**
   * Quoting a web agent's reply (or an answer combined from such replies) brings third-party words into that one
   * message: it runs tool-less. Later messages keep only the typed text, so the rest of the conversation keeps its tools.
   */
  taint<T extends MessageInput>(input: T): T {
    const quoted = input.quotes?.some((quote) => {
      const message = quote.messageId && this.workspace.store.get<ConversationMessage>('message', quote.messageId);
      return !!message && carriesThirdPartyWords(message);
    });
    return quoted ? { ...input, untrustedContent: true, untrustedQuotesOnly: true } : input;
  }

  private message(messageId: string) {
    const message = this.workspace.store.get<ConversationMessage>('message', messageId);
    if (!message?.externalAgent) throw new Error('找不到这条外部智能体的回复。');
    if (!isExternalAgentId(message.externalAgent.agentId)) throw new Error('这个智能体已移除，不能再操作旧消息。');
    return message as ConversationMessage & { externalAgent: ExternalAgentMessage };
  }
  private patch(
    messageId: string,
    change: (agent: ExternalAgentMessage, message: ConversationMessage) => void,
    broadcast = true,
  ) {
    const message = this.workspace.store.get<ConversationMessage>('message', messageId);
    if (!message?.externalAgent) {
      this.routineReplies.delete(messageId);
      return undefined;
    }
    change(message.externalAgent, message);
    message.externalAgent.updatedAt = this.stamp();
    this.workspace.store.save('message', message.id, message.conversationId, message);
    if (broadcast) this.workspace.controller.broadcast();
    // A part of a coordinated task ends when its reply has: answered, given up, or no longer checked on its own.
    const agent = message.externalAgent;
    if (agent.routine && agent.status === 'working')
      this.routineReplies.set(messageId, Date.parse(agent.routine.sentAt));
    else this.routineReplies.delete(messageId);
    const waiter = this.waiters.get(messageId);
    if (
      typeof waiter === 'function' &&
      !agent.following &&
      (['done', 'failed', 'needs-user'].includes(agent.status) || agent.task?.polling === false)
    )
      waiter(agent);
    return message;
  }

  /** By its name or id, for a coordinator's `delegate`; whether the user called it is checked by the workspace. */
  find(name: string) {
    const wanted = normalizeAgentName(name);
    const id = externalAgentIds.find(
      (candidate) => candidate === name.trim() || normalizeAgentName(externalAgentCatalog[candidate].name) === wanted,
    );
    if (!id) return undefined;
    const view = this.view(id);
    return { id, name: view.name, available: view.available, ...(view.reason ? { reason: view.reason } : {}) };
  }

  /**
   * The part of a coordinated task a coordinator gave to an agent the user called: sent like a direct call, its
   * reply shown in the conversation under the agent's name (and linked to the sub-task). Resolves once the agent
   * has answered or given up. A web agent's reply stays a third party's words, kept out of every executor's view.
   */
  async run(workflow: Workflow, signal: AbortSignal, report: (note: string) => void) {
    signal.throwIfAborted();
    const id = workflow.delegation?.agent?.externalAgentId;
    if (!isExternalAgentId(id)) throw new Error('不认识这个外部智能体。');
    const view = this.view(id);
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    const request = workflow.input.content.trim();
    if (!request) throw new Error(`没有要交给 ${view.name} 的内容。`);
    const store = this.workspace.store;
    const conversation = store.get<Conversation>('conversation', workflow.conversationId);
    if (!conversation || conversation.deletedAt) throw new Error('对话不存在。');
    const web = isThirdPartyAgent(view);
    const reply = store.addMessage(
      workflow.conversationId,
      'assistant',
      web ? `已交给 ${view.name}，排队中…` : `正在把任务交给 ${view.name}…`,
      workflow.id,
    );
    reply.externalAgent = {
      agentId: id,
      name: view.name,
      status: 'queued',
      request,
      updatedAt: this.stamp(),
      ...(view.routine ? { routineRequested: true } : {}),
      ...(web ? { untrusted: true } : {}),
    };
    store.save('message', reply.id, workflow.conversationId, reply);
    this.workspace.notifyConversationChanged(workflow.conversationId);
    const finished = this.settled(id, reply.id, signal);
    report(
      view.kind === 'handoff' && !view.routine
        ? `正在交接到 ${view.name}，回复不会自动回到 PugPort。`
        : `已交给 ${view.name}，等它回复…`,
    );
    this.enqueue(id, reply.id);
    const agent = await finished;
    return {
      messageId: reply.id,
      ok: agent.status === 'done',
      ...(view.kind === 'handoff' && !view.routine && agent.status === 'done' ? { note: grokBotHandoffNote } : {}),
      ...(agent.note ? { note: agent.note } : {}),
      name: view.name,
      thirdParty: web,
      handoff: view.kind === 'handoff' && !view.routine,
    };
  }
  /** Waits for a reply to finish; a stop takes a message still waiting in the queue back unsent. */
  private settled(id: ExternalAgentId, messageId: string, signal: AbortSignal) {
    return new Promise<ExternalAgentMessage>((resolve, reject) => {
      const stop = () => {
        this.waiters.delete(messageId);
        if (this.follows.has(messageId)) this.stopFollowing(messageId);
        else if (this.running.get(id) === messageId) {
          this.cancelled.add(messageId);
          const view = this.view(id);
          if (view.kind === 'web' && view.url)
            void this.bridge
              .request({ action: 'cancel', agentId: id, name: view.name, url: view.url }, 10_000)
              .catch(() => undefined);
        }
        const queue = this.queues.get(id);
        const index = queue?.indexOf(messageId) ?? -1;
        if (index >= 0) {
          queue!.splice(index, 1);
          this.patch(messageId, (agent, message) => {
            agent.status = 'failed';
            agent.note = '已停止，这条没有发出去。';
            message.content = `${agent.name} 这次没有回复。`;
          });
          this.notePositions(id);
          this.scheduleTaskUsage(id);
        }
        reject(signal.reason instanceof Error ? signal.reason : new Error('已停止。'));
      };
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      this.waiters.set(messageId, (agent) => {
        signal.removeEventListener('abort', stop);
        this.waiters.delete(messageId);
        resolve(agent);
      });
    });
  }

  // ---- Web agents: one message at a time per agent.

  private packedRequest(message: ConversationMessage & { externalAgent: ExternalAgentMessage }) {
    // A coordinator's part is self-contained, and its sub-task messages are internal: neither goes out as background.
    const delegated = (id?: string) => !!id && !!this.workspace.store.get<Workflow>('workflow', id)?.delegation;
    if (delegated(message.workflowId)) return message.externalAgent.request;
    return packExternalContext(
      this.workspace.store.allMessages(message.conversationId).filter((item) => !delegated(item.workflowId)),
      message.id,
      message.externalAgent.request,
    );
  }

  private async sendRoutine(messageId: string) {
    const message = this.message(messageId);
    if (this.workspace.store.get<Conversation>('conversation', message.conversationId)?.deletedAt) return;
    const routine = this.routineStore.read();
    if (!routine || !this.view('grok-bot').available) throw new Error('Grok Bot 例程不可用。');
    let missing = false;
    const running = await ensureGrokBotRunning({
      start: async () => {
        const result = await this.bridge.request(
          { action: 'desktop-start-minimized', agentId: 'grok-bot', name: 'Grok Bot', url: grokBotUrl() },
          10_000,
        );
        missing = result.code === 'not-installed';
        if (!result.ok) throw new Error('Grok Bot 例程不可用。');
      },
      ...this.options.routineDesktop,
      stopped: () => this.closed || this.cancelled.has(messageId),
    });
    if (this.closed || this.workspace.store.get<Conversation>('conversation', message.conversationId)?.deletedAt)
      return;
    if (this.cancelled.has(messageId)) {
      this.patch(messageId, (agent, current) => {
        agent.status = 'failed';
        agent.note = '已停止，这条没有发出去。';
        current.content = `${agent.name} 这次没有回复。`;
      });
      return;
    }
    if (!running) {
      const note = missing ? grokDesktopMissingNote : grokDesktopRequiredNote;
      this.patch(messageId, (agent, current) => {
        agent.status = 'needs-user';
        agent.note = note;
        current.content = note;
      });
      return;
    }
    const replyId = randomBytes(16).toString('hex');
    this.patch(messageId, (agent, current) => {
      agent.routine = { replyHash: grokReplyHash(replyId), sentAt: this.stamp() };
      agent.status = 'working';
      agent.untrusted = true;
      delete agent.handoff;
      agent.note = grokWaitingNote;
      current.content = grokWaitingNote;
    });
    const result = await postGrokRoutine(routine, this.packedRequest(message), replyId, this.options.routinePost);
    this.patch(messageId, (agent) => {
      if (result.runUuid) agent.routine!.runUuid = result.runUuid;
      // A fast callback (or the user's pasted answer) can arrive before the webhook response.
      if (agent.routine?.replied || agent.importedAt) return;
      agent.status = result.ok ? 'working' : 'needs-user';
      agent.note = result.ok ? grokWaitingNote : result.note;
    });
  }

  receiveGrokReply(replyId: string, text: string, more = false, part?: number): 200 | 404 | 413 {
    const row = this.workspace.store.db
      .prepare(
        `SELECT value FROM workspace_records WHERE kind='message'
       AND json_extract(value,'$.externalAgent.agentId')='grok-bot'
       AND json_extract(value,'$.externalAgent.routine.replyHash')=? LIMIT 1`,
      )
      .get(grokReplyHash(replyId)) as { value: string } | undefined;
    if (!row) return 404;
    const message = JSON.parse(row.value) as ConversationMessage;
    // The user already pasted this run's answer: it is answered once.
    if (message.externalAgent?.importedAt) return 200;
    const routine = message.externalAgent?.routine;
    if (
      !routine ||
      !Number.isFinite(Date.parse(routine.sentAt)) ||
      this.now() - Date.parse(routine.sentAt) >= 86_400_000
    )
      return 404;
    text = text.replaceAll('\r\n', '\n');
    const partHash = grokReplyHash(text);
    const parts = routine.parts
      ? routine.parts.map((item) => ({ ...item }))
      : routine.replied
        ? [
            {
              hash: routine.lastPartHash ?? grokReplyHash(message.content),
              text: message.content,
              more: message.externalAgent?.status === 'working',
            },
          ]
        : [];
    if (part !== undefined) {
      const existing = parts.find((item) => item.part === part);
      if (existing) {
        if (existing.hash === partHash && existing.more && !more) {
          existing.more = false;
        } else {
          return 200;
        }
      } else {
        parts.push({ part, hash: partHash, text, more });
      }
    } else {
      const existing = parts.find((item) => item.part === undefined && item.hash === partHash);
      if (existing || routine.lastPartHash === partHash) {
        if (existing && existing.more && !more) {
          existing.more = false;
        } else if (!existing && message.externalAgent?.status === 'working' && !more) {
          parts.forEach((item) => {
            item.more = false;
          });
        } else {
          return 200;
        }
      } else {
        parts.push({ hash: partHash, text, more });
      }
    }
    const numbered = parts.filter((item) => item.part !== undefined).sort((a, b) => a.part! - b.part!);
    const unnumbered = parts.filter((item) => item.part === undefined);
    const ordered = [...numbered, ...unnumbered];
    const content = ordered.map((item) => item.text).join('\n\n');
    if (content.length > 100_000) return 413;
    const stillWorking =
      numbered.length > 0 && unnumbered.length === 0
        ? numbered.length < numbered.at(-1)!.part! || !!numbered.at(-1)!.more
        : more;
    // Nobody waits for it any more: the part of a coordinated task it answers had already settled unanswered.
    const late = message.externalAgent?.status !== 'done' && !this.waiters.has(message.id);
    const saved = this.patch(message.id, (agent, current) => {
      agent.routine!.replied = true;
      agent.routine!.lastPartHash = partHash;
      agent.routine!.parts = ordered;
      agent.status = stillWorking && agent.status !== 'done' ? 'working' : 'done';
      agent.untrusted = true;
      delete agent.note;
      current.content = content;
    });
    if (late && saved?.workflowId && saved.externalAgent?.status === 'done')
      void this.workspace.resumeLateExternalReply(saved.id).catch(() => undefined);
    return 200;
  }

  private pollRoutineReplies() {
    for (const [messageId, sentAt] of this.routineReplies) {
      if (this.now() - sentAt < 30 * 60_000) continue;
      this.patch(messageId, (agent) => {
        agent.status = 'needs-user';
        agent.note = 'Grok Bot 还没回，可以到它的窗口看看';
      });
    }
  }

  private async sendDesktop(messageId: string) {
    const message = this.message(messageId);
    if (message.externalAgent.routineRequested || message.externalAgent.routine)
      throw new Error('这条消息使用例程，请到 Grok Bot 窗口查看。');
    if (this.workspace.store.get<Conversation>('conversation', message.conversationId)?.deletedAt) return;
    const view = this.view(message.externalAgent.agentId);
    if (view.kind !== 'handoff' || !view.available) throw new Error(`${view.name} 现在不能交接。`);
    this.patch(messageId, (agent) => {
      agent.status = 'working';
      agent.note = undefined;
    });
    const result = await this.bridge.request(
      {
        action: 'desktop-handoff',
        agentId: view.id,
        name: view.name,
        url: grokBotUrl(view.botId),
        text: this.packedRequest(message),
      },
      60_000,
    );
    if (!result.ok) throw new Error(`${view.name} 桌面交接失败。`);
    this.patch(messageId, (agent, current) => {
      agent.status = 'done';
      agent.note = undefined;
      agent.awaitingReply = true;
      delete agent.untrusted;
      delete agent.task;
      delete agent.handoff;
      current.content = grokBotHandoffNote;
    });
  }

  /** The answer the user copied out of Grok Bot, attached to the request it answers. */
  importReply(messageId: string, text: string) {
    const agent = this.message(messageId).externalAgent;
    if (!canImportReply(agent))
      throw new Error(agent.importedAt || agent.routine?.replied ? '这条已经有回复了。' : '这条消息没有在等回复。');
    const reply = text.replaceAll('\r\n', '\n').trim();
    if (!reply) throw new Error('回复是空的。');
    if (reply.length > 100_000) throw new Error('回复太长，最多 100000 个字符。');
    this.patch(messageId, (current, message) => {
      current.status = 'done';
      current.importedAt = this.stamp();
      // Grok Bot's words, whichever way they arrived.
      current.untrusted = true;
      delete current.awaitingReply;
      delete current.note;
      message.content = reply;
    });
  }

  async openDesktop(id: ExternalAgentId, usageSettings = false) {
    const view = this.view(id);
    if (view.kind !== 'handoff') throw new Error('这个智能体不支持桌面交接。');
    if (!this.bridge.available()) throw new Error('只能在 PugPort 桌面版里使用。');
    const result = await this.bridge
      .request(
        {
          action: 'desktop-open',
          agentId: id,
          name: view.name,
          url: usageSettings ? grokBotUsageUrl : grokBotUrl(view.botId),
        },
        60_000,
      )
      .catch(() => ({ ok: false }));
    if (!result.ok) throw new Error(`没能打开 ${view.name}，请确认已安装。`);
    if (view.added === false) this.config.update(id, { added: true }, { background: true });
    return { ok: true, message: usageSettings ? '已打开 Grok Bot 用量设置。' : `已打开 ${view.name}。` };
  }

  private cursorSession() {
    return readCursorEditorSession();
  }

  private recordGrokResult(result: WebAgentResult) {
    const saved = this.config.agent('grok-bot');
    const diagnostic =
      cleanGrokDiagnostic(result.grokDiagnostic) ??
      grokDiagnostic(
        result.ok && result.quota?.status === 'known'
          ? 'success'
          : result.code === 'login' ||
              result.code === 'human-check' ||
              result.code === 'closed' ||
              result.code === 'load-failed' ||
              result.code === 'error' ||
              result.code === 'unavailable'
            ? result.code
            : 'no-data',
        result.code === 'login' || result.code === 'human-check' ? result.code : 'parse',
        grokBotUsagePage,
      );
    const parsed = result.quota && webQuotaSchema.safeParse(result.quota);
    const quota: ExternalAgentView['quota'] =
      result.ok && parsed?.success
        ? parsed.data
        : { status: 'unknown', windows: [], observedAt: null, source: '独立登录 · Grok Bot 用量' };
    const signatures = result.signatures && zUsageSignatures(result.signatures);
    const diagnosticChanged = JSON.stringify(saved.grokDiagnostic) !== JSON.stringify(diagnostic);
    const signaturesChanged = signatures && JSON.stringify(saved.usageSignatures) !== JSON.stringify(signatures);
    const changed =
      JSON.stringify(this.grokDiagnostic ?? saved.grokDiagnostic) !== JSON.stringify(diagnostic) ||
      JSON.stringify(this.grokQuota) !== JSON.stringify(quota) ||
      signaturesChanged;
    if (diagnosticChanged || signaturesChanged)
      this.config.update(
        'grok-bot',
        {
          grokDiagnostic: diagnostic,
          ...(signaturesChanged ? { usageSignatures: signatures } : {}),
        },
        { background: true },
      );
    this.grokDiagnostic = diagnostic;
    this.grokQuota = quota;
    this.grokAccount = undefined; // The separate login's reading carries no account identity.
    if (result.ok) this.usageCheckedAt.set('grok-bot', this.now());
    if (changed) this.workspace.controller.broadcast();
  }
  private async collectGrokLogin() {
    const saved = this.config.agent('grok-bot');
    if (
      this.view('grok-bot').added === false ||
      !saved.usageLoginCreated ||
      !saved.usageEnabled ||
      (saved.usageSource ?? 'separate') !== 'separate' ||
      !this.bridge.available()
    )
      return;
    const source = saved.usageSource;
    const result = await this.bridge
      .request(
        { action: 'monitor', agentId: grokBotUsageAgentId, name: 'Grok Bot', url: grokBotUsagePage, enabled: true },
        10_000,
      )
      .catch(() => undefined);
    if (
      !result?.grokDiagnostic ||
      this.closed ||
      !this.config.agent('grok-bot').usageEnabled ||
      this.config.agent('grok-bot').usageSource !== source
    )
      return;
    const key = JSON.stringify(result);
    if (key !== this.grokBridgeResult) {
      this.grokBridgeResult = key;
      this.recordGrokResult(result);
    }
  }
  private async readGrokUsage(automatic: boolean) {
    if (
      !this.closed &&
      (!automatic || this.view('grok-bot').added !== false) &&
      this.config.agent('grok-bot').usageEnabled
    ) {
      const cadence = 10 * 60_000;
      if (this.grokReading) await this.grokReading;
      else if (!automatic || this.now() - (this.usageCheckedAt.get('grok-bot') ?? -Infinity) >= cadence) {
        const controller = new AbortController();
        this.grokController = controller;
        const read = async () => {
          const saved = this.config.agent('grok-bot');
          if ((saved.usageSource ?? 'separate') === 'separate') {
            if (!saved.usageLoginCreated || !this.bridge.available()) {
              this.grokDiagnostic = grokDiagnostic('unavailable', 'login');
              return;
            }
            const result = await this.bridge
              .request(
                {
                  action: 'usage',
                  agentId: grokBotUsageAgentId,
                  name: 'Grok Bot',
                  url: grokBotUsagePage,
                  automatic,
                  signatures: saved.usageSignatures,
                },
                90_000,
              )
              .catch((): WebAgentResult => ({ ok: false, code: 'error' }));
            if (this.closed || controller.signal.aborted || this.grokController !== controller) return;
            this.usageCheckedAt.set('grok-bot', this.now());
            this.recordGrokResult(result);
            return;
          }
          this.usageCheckedAt.set('grok-bot', this.now());
          let session: CursorEditorSession | undefined;
          try {
            session = await (this.options.grokUsage?.session ?? (() => this.cursorSession()))();
          } catch {
            /* Fixed missing-login reason; no credential-bearing errors. */
          }
          if (controller.signal.aborted) return;
          const quota = await fetchGrokBotUsage(session, {
            ...this.options.grokUsage,
            now: () => this.now(),
            signal: controller.signal,
          });
          if (
            !this.closed &&
            this.grokController === controller &&
            !controller.signal.aborted &&
            this.config.agent('grok-bot').usageEnabled
          ) {
            this.grokQuota = quota;
            this.grokAccount = session && cursorIdentityHash(session.userId);
            this.workspace.controller.broadcast();
          }
        };
        const pending = read();
        this.grokReading = pending;
        try {
          await pending;
        } finally {
          if (this.grokReading === pending) this.grokReading = undefined;
        }
      }
    }
    const agent = this.view('grok-bot');
    return {
      ok: agent.quota?.status === 'known',
      message: agent.quota?.status === 'known' ? '已读取用量。' : `没读到用量：${agent.quota?.note ?? ''}`,
      agent,
    };
  }

  private enqueue(id: ExternalAgentId, messageId: string) {
    const incomingConversationId = this.workspace.store.get<ConversationMessage>('message', messageId)?.conversationId;
    for (const [oldId, follow] of this.follows) {
      if (follow.agentId !== id) continue;
      const oldMessage = this.workspace.store.get<ConversationMessage>('message', oldId);
      if (
        incomingConversationId &&
        oldMessage?.conversationId &&
        oldMessage.conversationId !== incomingConversationId
      ) {
        this.interruptedFollows.set(oldId, {
          agentId: id,
          trackerId: follow.trackerId,
          started: follow.started,
        });
      }
      this.endFollowing(oldId, undefined, false);
    }
    const queue = this.queues.get(id) ?? [];
    queue.push(messageId);
    this.queues.set(id, queue);
    this.notePositions(id);
    void this.pump(id);
  }
  private isRunning(id: ExternalAgentId) {
    return this.running.has(id) || [...this.follows.values()].some((follow) => follow.agentId === id);
  }
  private followConversationActive(messageId: string) {
    const message = this.workspace.store.get<ConversationMessage>('message', messageId);
    const conversation = message && this.workspace.store.get<Conversation>('conversation', message.conversationId);
    return !!conversation && !conversation.deletedAt && !conversation.archivedAt;
  }
  private stopTracker(id: ExternalAgentId, trackerId: string) {
    const view = this.view(id);
    return this.bridge
      .request({ action: 'stop', agentId: id, name: view.name, url: view.url!, trackerId }, 10_000)
      .catch(() => undefined);
  }
  stopFollowing(messageId: string) {
    this.endFollowing(messageId, '已停止跟进');
  }
  private scheduleTaskUsage(id: ExternalAgentId) {
    // One pending read for a burst of completions; an active read already covers the trigger.
    if (id === 'muse' && !this.closed && this.readingUsageAgent !== id) this.museTaskUsageAt = this.now() + 3000;
  }
  private endFollowing(messageId: string, note?: string, readUsage = true) {
    const follow = this.follows.get(messageId);
    if (!follow) return;
    this.follows.delete(messageId);
    this.patch(messageId, (agent) => {
      agent.status = 'done';
      delete agent.following;
      agent.note = note ?? agent.note;
    });
    void this.stopTracker(follow.agentId, follow.trackerId).then(() => {
      if (follow.agentId === 'muse') {
        this.scheduleTaskUsage(follow.agentId);
        return;
      }
      if (readUsage && !this.closed && !this.isRunning(follow.agentId) && !this.queues.get(follow.agentId)?.length)
        void this.readUsage(follow.agentId, true, true).catch(() => undefined);
    });
  }
  private async pollFollows() {
    if (this.closed) return;
    await Promise.all(
      [...this.follows].map(async ([messageId, follow]) => {
        const current = () => !this.closed && this.follows.get(messageId)?.token === follow.token;
        if (!this.followConversationActive(messageId)) return this.endFollowing(messageId, undefined, false);
        if (
          this.now() - follow.changed >= (this.options.webFollowSilenceMs ?? 2 * 60_000) ||
          this.now() - follow.started >= (this.options.webFollowMaxMs ?? 30 * 60_000)
        )
          return this.endFollowing(messageId);
        if (follow.busy || this.now() < follow.next) return;
        follow.busy = true;
        follow.next = this.now() + (this.options.webFollowPollMs ?? 5000);
        const view = this.view(follow.agentId);
        const settingsCurrent = this.webCurrent(follow.agentId);
        const result = await this.bridge
          .request(
            {
              action: 'peek',
              agentId: follow.agentId,
              name: view.name,
              url: view.url!,
              trackerId: follow.trackerId,
              selectors: this.config.selectors(follow.agentId, view.url),
            },
            10_000,
          )
          .catch((): WebAgentResult => ({ ok: false, code: 'error' }));
        if (!current()) return;
        follow.busy = false;
        if (!settingsCurrent()) return;
        if (!this.followConversationActive(messageId)) return this.endFollowing(messageId, undefined, false);
        if ((result.code === 'error' || result.code === 'timeout') && !result.limit) return;
        if (result.limit || !result.ok) {
          try {
            this.recordWebState(follow.agentId, result);
          } finally {
            this.endFollowing(
              messageId,
              result.code === 'closed'
                ? `${view.name} 的窗口关了，后面的回复请在它的窗口查看`
                : '跟进已中断，可到它的窗口查看后续',
              false,
            );
          }
          return;
        }
        const rawReply = result.reply?.trim() ?? '';
        const text = rawReply.slice(-100_000);
        const truncated = Boolean(result.truncated || rawReply.length > 100_000);
        if (
          text &&
          (text !== this.message(messageId).content ||
            Boolean(this.message(messageId).externalAgent.truncated) !== truncated)
        ) {
          follow.changed = this.now();
          this.patch(messageId, (agent, message) => {
            agent.untrusted = true;
            if (truncated) agent.truncated = true;
            else delete agent.truncated;
            agent.note = undefined;
            message.content = text;
          });
        }
      }),
    );
    for (const [messageId, interrupted] of this.interruptedFollows) {
      if (this.closed) break;
      if (this.now() - interrupted.started >= (this.options.webFollowMaxMs ?? 30 * 60_000)) {
        this.interruptedFollows.delete(messageId);
        continue;
      }
      if (!this.followConversationActive(messageId)) {
        this.interruptedFollows.delete(messageId);
        continue;
      }
      if (this.running.has(interrupted.agentId) || (this.queues.get(interrupted.agentId)?.length ?? 0) > 0) continue;
      const savedMessage = this.workspace.store.get<ConversationMessage>('message', messageId);
      if (!savedMessage?.externalAgent) {
        this.interruptedFollows.delete(messageId);
        continue;
      }
      const view = this.view(interrupted.agentId);
      if (!view.available || !view.url) continue;
      const threadKey = `${interrupted.agentId}:${savedMessage.conversationId}`;
      const savedThreadUrl = savedMessage.externalAgent.threadUrl ?? this.conversationThreads.get(threadKey);
      const result = await this.bridge
        .request(
          {
            action: 'recapture',
            agentId: interrupted.agentId,
            name: view.name,
            url: view.url,
            selectors: this.config.selectors(interrupted.agentId, view.url),
            text: savedMessage.externalAgent.sentText ?? savedMessage.externalAgent.request,
            ...(interrupted.trackerId ? { trackerId: interrupted.trackerId } : {}),
            conversationId: savedMessage.conversationId,
            ...(savedThreadUrl ? { threadUrl: savedThreadUrl } : {}),
          },
          10_000,
        )
        .catch((): WebAgentResult => ({ ok: false, code: 'error' }));
      if (!result.ok) {
        if (result.code && !['error', 'timeout', 'not-detected'].includes(result.code))
          this.interruptedFollows.delete(messageId);
        continue;
      }
      const rawReply = result.reply?.trim() ?? '';
      const text = rawReply.slice(-100_000);
      if (text && (text !== savedMessage.content || savedMessage.externalAgent.status !== 'done')) {
        const truncated = Boolean(result.truncated || rawReply.length > 100_000);
        this.patch(messageId, (agent, current) => {
          agent.status = 'done';
          agent.sent = true;
          delete agent.handoff;
          agent.untrusted = true;
          if (truncated) agent.truncated = true;
          else delete agent.truncated;
          agent.note = undefined;
          current.content = text;
        });
        this.interruptedFollows.delete(messageId);
      }
    }
  }
  private notePositions(id: ExternalAgentId) {
    const queue = this.queues.get(id) ?? [];
    queue.forEach((messageId, index) => {
      const ahead = index + (this.running.has(id) ? 1 : 0);
      this.patch(
        messageId,
        (agent) => {
          agent.status = 'queued';
          agent.note = ahead ? `排队中：前面还有 ${ahead} 条` : '马上开始';
        },
        false,
      );
    });
    // One update for the whole queue: every broadcast carries the full app state.
    if (queue.length) this.workspace.controller.broadcast();
  }
  private async pump(id: ExternalAgentId) {
    if (this.running.has(id) || this.closed) return;
    const messageId = this.queues.get(id)?.shift();
    if (!messageId) return;
    this.running.set(id, messageId);
    try {
      if (id === 'grok-bot' && this.message(messageId).externalAgent.routineRequested)
        await this.sendRoutine(messageId);
      else if (externalAgentCatalog[id].kind === 'handoff') await this.sendDesktop(messageId);
      else await this.sendWeb(id, messageId);
    } catch (error) {
      if (this.follows.has(messageId)) {
        this.endFollowing(messageId, '跟进已中断，可到它的窗口查看后续', false);
        return;
      }
      this.patch(messageId, (agent, message) => {
        agent.status = 'failed';
        agent.handoff = !agent.routineRequested;
        agent.note = agent.routineRequested
          ? 'Grok Bot 例程不可用。'
          : externalAgentCatalog[id].kind === 'handoff'
            ? `没能交接到 ${agent.name}，请确认已安装后重试。`
            : error instanceof Error && error.message
              ? error.message
              : webFailure('error', agent.name);
        message.content = `${agent.name} 这次没有回复。`;
      });
    } finally {
      this.cancelled.delete(messageId);
      this.running.delete(id);
      this.notePositions(id);
      void this.pump(id);
      if (id === 'muse' && !this.follows.has(messageId)) this.scheduleTaskUsage(id);
      if (
        id !== 'muse' &&
        !this.closed &&
        !this.isRunning(id) &&
        this.workspace.store.get<ConversationMessage>('message', messageId)?.externalAgent?.status === 'done'
      )
        void this.readUsage(id, true, true).catch(() => undefined);
    }
  }
  private async sendWeb(id: ExternalAgentId, messageId: string) {
    const message = this.message(messageId);
    // Deleted while it waited: nothing to send it for.
    if (this.workspace.store.get<Conversation>('conversation', message.conversationId)?.deletedAt) return;
    const view = this.view(id);
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    if (view.cooldown?.resetsAt) {
      this.patch(messageId, (agent, current) => {
        agent.status = 'failed';
        agent.note = undefined;
        delete agent.handoff;
        current.content = `${view.name}：${webQuotaLabel(view, this.now())}`;
      });
      return;
    }
    const alreadySent = !!message.externalAgent.sent;
    this.patch(messageId, (agent, current) => {
      agent.status = 'working';
      agent.note = alreadySent ? `正在从 ${agent.name} 页面读取回复…` : `正在交给 ${agent.name}，等它回复…`;
      delete agent.handoff;
      current.content = `正在等 ${agent.name} 回复…`;
    });
    const timeoutMs = this.options.webTimeoutMs ?? 180_000;
    const started = this.now();
    const current = this.webCurrent(id);
    const threadKey = `${id}:${message.conversationId}`;
    const savedThreadUrl = message.externalAgent.threadUrl ?? this.conversationThreads.get(threadKey);
    const threadUrl =
      savedThreadUrl && URL.parse(savedThreadUrl)?.origin === URL.parse(view.url!)?.origin ? savedThreadUrl : undefined;
    // A fresh thread gets the earlier turns; the page then shows that packed text, so 「重试」 must look for it.
    const text = alreadySent
      ? (message.externalAgent.sentText ?? message.externalAgent.request)
      : threadUrl
        ? message.externalAgent.request
        : this.packedRequest(message);
    if (!alreadySent && text !== message.externalAgent.request)
      this.patch(messageId, (agent) => (agent.sentText = text), false);
    const result = await this.bridge.request(
      alreadySent
        ? {
            action: 'recapture',
            agentId: id,
            name: view.name,
            url: view.url!,
            selectors: this.config.selectors(id, view.url),
            text,
            conversationId: message.conversationId,
            ...(threadUrl ? { threadUrl } : {}),
            ...(message.externalAgent.trackerId ? { trackerId: message.externalAgent.trackerId } : {}),
          }
        : {
            action: 'send',
            agentId: id,
            name: view.name,
            url: view.url!,
            selectors: this.config.selectors(id, view.url),
            text,
            conversationId: message.conversationId,
            ...(threadUrl ? { threadUrl } : {}),
            timeoutMs,
            stableMs: this.options.webStableMs ?? 3000,
          },
      // The reply wait, plus loading the page, finding the box and sending.
      alreadySent ? 60_000 : timeoutMs + 120_000,
    );
    if (this.closed) {
      if (result.trackerId) void this.stopTracker(id, result.trackerId);
      return;
    }
    if (!current()) {
      if (result.trackerId) void this.stopTracker(id, result.trackerId);
      this.patch(messageId, (agent, currentMessage) => {
        agent.status = 'needs-user';
        agent.note = '网页设置已更改；这条消息可能已发送，请到原窗口查看，避免重复发送。';
        delete agent.handoff;
        delete agent.following;
        if (result.reply?.trim()) {
          agent.untrusted = true;
          currentMessage.content = result.reply.trim().slice(-100_000);
        }
      });
      return;
    }
    this.recordDetection(id, result);
    this.recordWebState(id, result);
    if (result.limit) {
      const label = `${view.name}：${webQuotaLabel(this.view(id), this.now())}`;
      for (const targetId of [messageId, ...(result.limit.resetsAt ? [] : (this.queues.get(id) ?? []).splice(0))]) {
        this.patch(targetId, (agent, current) => {
          agent.status = 'failed';
          agent.note = undefined;
          delete agent.handoff;
          current.content = label;
        });
      }
      return;
    }
    const reply = result.reply?.trim();
    if (result.ok && reply) {
      this.config.update(id, { cooldown: undefined }, { background: true });
      const following = result.trackerId ? { trackerId: result.trackerId } : undefined;
      if (following)
        this.follows.set(messageId, {
          ...following,
          token: randomUUID(),
          agentId: id,
          started,
          changed: this.now(),
          next: this.now() + (this.options.webFollowPollMs ?? 5000),
          busy: false,
        });
      const resolvedThreadUrl =
        result.pageUrl && URL.parse(result.pageUrl)?.origin === URL.parse(view.url!)?.origin
          ? result.pageUrl
          : threadUrl;
      if (resolvedThreadUrl) this.conversationThreads.set(threadKey, resolvedThreadUrl);
      this.patch(messageId, (agent, current) => {
        agent.status = 'done';
        agent.sent = true;
        delete agent.trackerId;
        if (resolvedThreadUrl) agent.threadUrl = resolvedThreadUrl;
        agent.following = following;
        agent.untrusted = true;
        if (result.truncated || reply.length > 100_000) agent.truncated = true;
        else delete agent.truncated;
        agent.note = result.partial ? (result.message ?? '等太久了，回复可能不完整。') : undefined;
        current.content = reply.slice(-100_000);
      });
      if (
        this.cancelled.delete(messageId) ||
        this.queues.get(id)?.length ||
        !this.followConversationActive(messageId)
      ) {
        const nextQueuedId = this.queues.get(id)?.[0];
        const nextConvId =
          nextQueuedId && this.workspace.store.get<ConversationMessage>('message', nextQueuedId)?.conversationId;
        if (following && nextConvId && nextConvId !== message.conversationId) {
          this.interruptedFollows.set(messageId, {
            agentId: id,
            trackerId: following.trackerId,
            started,
          });
        }
        this.endFollowing(messageId, undefined, false);
      }
      return;
    }
    const needsUser = ['human-check', 'login', 'timeout'].includes(result.code ?? '');
    const wasSent = Boolean(alreadySent || result.sent || result.ok || result.trackerId);
    this.patch(messageId, (agent, current) => {
      agent.status = needsUser ? 'needs-user' : 'failed';
      if (wasSent) {
        agent.sent = true;
        if (result.trackerId) agent.trackerId = result.trackerId;
      }
      agent.handoff = true;
      agent.note = result.ok
        ? `没读到 ${agent.name} 的回复：可以到它的窗口里查看，或点「重试」。`
        : result.message || webFailure(result.code, agent.name);
      current.content = needsUser ? `${agent.name} 需要你先处理一下它的页面。` : `${agent.name} 这次没有回复。`;
    });
  }
  /** What the last look at the page found, shown on the settings card; working selectors go into the site config. */
  private recordDetection(id: ExternalAgentId, result: WebAgentResult) {
    if (result.ok) {
      if (result.selectors) this.config.saveSelectors(id, result.selectors, this.config.agent(id).url);
      this.config.update(
        id,
        { detection: { at: this.stamp(), ok: true, note: '能找到输入框，可以正常使用' } },
        { background: true },
      );
    } else if (result.code === 'not-detected' || result.code === 'not-sent')
      this.config.update(
        id,
        {
          detection: {
            at: this.stamp(),
            ok: false,
            note: (result.message || webFailure(result.code, id)).slice(0, 400),
          },
        },
        { background: true },
      );
  }

  private recordWebState(id: ExternalAgentId, result: WebAgentResult) {
    if (result.code === 'human-check' || result.code === 'login' || result.code === 'closed') this.loggedIn.delete(id);
    else if (result.ok || result.limit) this.loggedIn.add(id);
    if (id === 'muse') {
      if (result.code === 'login' || result.code === 'human-check')
        this.config.update(id, { usageSignedOut: true }, { background: true });
      else if (result.ok && !result.code && this.config.agent(id).usageSignedOut)
        this.config.update(id, { usageSignedOut: false }, { background: true });
    }
    if (result.limit) this.config.update(id, { cooldown: result.limit }, { background: true });
    else if (result.ok && !result.code && this.config.agent(id).cooldown)
      this.config.update(id, { cooldown: undefined }, { background: true });
  }

  private recordUsage(id: ExternalAgentId, result: WebAgentResult) {
    const saved = this.config.agent(id);
    const patch: AgentSettings = {};
    if (result.usageUrl && safeWebUsageRoute(result.usageUrl) && result.usageUrl !== saved.usageUrl)
      patch.usageUrl = result.usageUrl;
    if (result.usageDiagnostics) {
      const samples = result.usageDiagnostics.slice(0, 4).map(redactedUsageSample).filter(Boolean);
      if (JSON.stringify(samples) !== JSON.stringify(saved.usageDiagnostics ?? [])) patch.usageDiagnostics = samples;
    }
    const quota = result.quota && webQuotaSchema.safeParse(result.quota);
    if (quota && quota.success && JSON.stringify(quota.data) !== JSON.stringify(saved.quota)) patch.quota = quota.data;
    if (result.limit) patch.cooldown = result.limit;
    else if (
      saved.cooldown &&
      !result.code &&
      quota &&
      quota.success &&
      quota.data.status === 'known' &&
      !quota.data.stale &&
      (!saved.cooldown.resetsAt ||
        (quota.data.windows.length > 0 &&
          quota.data.windows.every((window) => typeof window.usedPercent === 'number' && window.usedPercent < 100)))
    )
      patch.cooldown = undefined;
    const signatures = result.signatures && zUsageSignatures(result.signatures);
    if (signatures && JSON.stringify(signatures) !== JSON.stringify(saved.usageSignatures ?? []))
      patch.usageSignatures = signatures;
    if (Object.keys(patch).length) {
      this.config.update(id, patch, { background: true });
      this.workspace.controller.broadcast();
    }
    if (
      !result.code &&
      quota &&
      quota.success &&
      quota.data.status === 'known' &&
      !quota.data.stale &&
      quota.data.observedAt !== saved.quota?.observedAt
    ) {
      this.loggedIn.add(id);
      if (id === 'muse' && saved.usageSignedOut)
        this.config.update(id, { usageSignedOut: false }, { background: true });
    }
  }

  /** One usage read across all agents; Muse background reads never present a login window. */
  async readUsage(id: ExternalAgentId, automatic = false, afterReply = false) {
    const view = this.view(id);
    if (view.kind === 'handoff') {
      if (!automatic && view.added === false) this.config.update(id, { added: true }, { background: true });
      return this.readGrokUsage(automatic);
    }
    if (view.kind !== 'web') throw new Error('只有网页智能体可以读取用量。');
    if (!view.available || (automatic && view.added === false)) {
      if (automatic) return { ok: false, message: '没读到用量', agent: view };
      throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    }
    if (!automatic && view.added === false) this.config.update(id, { added: true }, { background: true });
    if (this.readingUsage || this.isRunning(id)) {
      if (automatic && afterReply && (id !== 'muse' || this.readingUsageAgent !== id)) this.pendingUsage.add(id);
      return { ok: false, message: '正在处理，请稍后读取用量。', agent: view };
    }
    const background = automatic && id === 'muse';
    const saved = this.config.agent(id);
    if (background && this.museTaskUsageAt !== undefined) {
      if (this.now() < this.museTaskUsageAt) return { ok: false, message: '', agent: view };
      afterReply = true;
    }
    const lastAttempt =
      this.usageCheckedAt.get(id) ??
      (background && saved.usageAttemptedAt ? Date.parse(saved.usageAttemptedAt) : -Infinity);
    if (
      automatic &&
      ((background ? saved.usageSignedOut : !this.loggedIn.has(id)) ||
        (background && this.now() - lastAttempt < 10 * 60_000) ||
        (!afterReply && this.now() - lastAttempt < (background ? 12 * hour : 10 * 60_000)))
    )
      return { ok: false, message: '暂不自动读取用量。', agent: view };
    if (automatic && !background && !view.usageSignatures?.length && !view.usageUrl)
      return { ok: false, message: webUsageInvitation, agent: view };
    if (background) this.museTaskUsageAt = undefined;
    this.readingUsage = true;
    this.readingUsageAgent = id;
    const current = this.webCurrent(id);
    this.pendingUsage.delete(id);
    this.usageCheckedAt.set(id, this.now());
    if (id === 'muse') this.config.update(id, { usageAttemptedAt: this.stamp() }, { background: true });
    try {
      const result = await this.bridge.request(
        {
          action: 'usage',
          agentId: id,
          name: view.name,
          url: background ? view.url! : view.usageUrl || view.url!,
          automatic,
          ...(background ? { background: true, signatures: view.usageSignatures } : {}),
          navigate: !automatic && !!view.usageUrl,
          afterReply,
          usageUrl: view.usageUrl || undefined,
          configurationVersion: this.webVersion(id),
          selectors: this.config.selectors(id, view.url),
        },
        90_000,
      );
      if (!current()) return { ok: false, message: '网页设置已更改，请重试。', agent: this.view(id) };
      if (background) {
        if (result.code === 'login' || result.code === 'human-check')
          this.config.update(id, { usageSignedOut: true }, { background: true });
        const parsed = webQuotaSchema.safeParse(result.quota);
        if (!result.ok || result.code || !parsed.success || parsed.data.status !== 'known' || parsed.data.stale)
          return { ok: false, message: '', agent: this.view(id) };
        this.recordUsage(id, { ...result, quota: mergeWebUsage(saved.quota, parsed.data) });
        return { ok: true, message: '', agent: this.view(id) };
      }
      this.recordWebState(id, result);
      const parsed = result.quota ?? parseWebUsage(result.ok ? (result.usageText ?? '') : '', this.now());
      const previous = this.config.agent(id).quota;
      const quota =
        parsed.status === 'known' ? mergeWebUsage(previous, parsed) : previous ? { ...previous, stale: true } : parsed;
      this.recordUsage(id, { ...result, quota });
      this.workspace.controller.broadcast();
      return {
        ok: result.ok && quota.status === 'known' && !quota.stale,
        message:
          result.message ||
          (quota.status === 'known' && !quota.stale
            ? '已读取用量。'
            : `没读到用量：${result.pageUrl ?? view.usageUrl ?? view.url}`),
        agent: this.view(id),
      };
    } catch (error) {
      if (background) return { ok: false, message: '', agent: this.view(id) };
      throw error;
    } finally {
      this.readingUsage = false;
      this.readingUsageAgent = undefined;
      for (const pending of this.pendingUsage) {
        if (this.closed || this.readingUsage) break;
        if (this.isRunning(pending)) continue;
        this.pendingUsage.delete(pending);
        void this.readUsage(pending, true, true).catch(() => undefined);
      }
    }
  }

  retry(messageId: string) {
    const message = this.message(messageId);
    const agent = message.externalAgent;
    if (agent.status !== 'failed' && agent.status !== 'needs-user') throw new Error('这条还没结束，不用重试。');
    if (agent.routine) throw new Error('这条例程已尝试发送，请到 Grok Bot 查看；需要重发时请发一条新消息。');
    const view = this.view(agent.agentId);
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    this.enqueue(agent.agentId, messageId);
  }

  /** The fallback when the page cannot be driven: the request goes on the clipboard and the window comes forward. */
  async handoff(messageId: string) {
    const message = this.message(messageId);
    const agent = message.externalAgent;
    if (externalAgentCatalog[agent.agentId].kind === 'handoff') {
      if (this.isRunning(agent.agentId)) throw new Error('正在处理，请稍后重试。');
      if (agent.importedAt) throw new Error('这条已经有回复了。');
      try {
        await this.sendDesktop(messageId);
      } catch {
        this.patch(messageId, (current) => {
          current.status = 'failed';
          current.note = '没能交接到 Grok Bot，请确认已安装后重试。';
        });
        throw new Error('没能交接到 Grok Bot，请确认已安装后重试。');
      }
      return;
    }
    if (externalAgentCatalog[agent.agentId].kind !== 'web') throw new Error('只有网页智能体可以这样交给它。');
    const url = this.config.agent(agent.agentId).url ?? '';
    if (!webAgentUrl(url)) throw new Error(`请先在设置里填好 ${agent.name} 的网址。`);
    if (!this.bridge.available()) throw new Error('只能在 PugPort 桌面版里使用。');
    const result = await this.bridge.request(
      { action: 'handoff', agentId: agent.agentId, name: agent.name, url, text: agent.request },
      60_000,
    );
    if (!result.ok) throw new Error(result.message || `没能打开 ${agent.name} 的窗口。`);
    this.patch(messageId, (current) => {
      current.note = `已把这条消息复制到剪贴板，并打开了 ${current.name} 窗口：粘贴后发送即可。它的回复不会自动回到这里。`;
    });
  }

  /** Opens the agent's own window so the user signs in there; PugPort never sees what is typed into it. */
  async login(id: ExternalAgentId) {
    if (this.config.hasError()) throw new Error(invalidExternalAgentConfigMessage);
    const view = this.view(id);
    if (id === 'grok-bot') {
      if (!this.bridge.available()) throw new Error('只能在 PugPort 桌面版里使用。');
      const result = await this.bridge
        .request({ action: 'open', agentId: grokBotUsageAgentId, name: view.name, url: grokBotUsagePage }, 60_000)
        .catch((): WebAgentResult => ({ ok: false }));
      if (!result.ok) throw new Error('没能打开用量登录窗口。');
      this.config.update(id, {
        added: true,
        usageLoginCreated: true,
        usageSource: 'separate',
        usageEnabled: true,
        usageAccountConfirmed: undefined,
      });
      this.grokController?.abort();
      this.grokQuota = undefined;
      this.grokDiagnostic = undefined;
      this.grokBridgeResult = '';
      this.usageCheckedAt.delete(id);
      this.workspace.controller.broadcast();
      await this.readGrokUsage(false);
      return { message: '请在用量窗口登录 Grok Bot 用的账号，登录后会自动读取用量。' };
    }
    if (view.kind !== 'web') throw new Error(`${view.name} 不需要在这里登录。`);
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    const current = this.webCurrent(id);
    const result = await this.bridge.request({ action: 'open', agentId: id, name: view.name, url: view.url! }, 60_000);
    if (!current()) return { message: '网页设置已更改，请重试。' };
    if (!result.ok) throw new Error(result.message || webFailure(result.code, view.name));
    return { message: `已打开 ${view.name} 窗口，请在里面登录。登录信息只保存在它自己的窗口里。` };
  }

  /** 「重新识别」: looks at the open page again and keeps what it finds. */
  async detect(id: ExternalAgentId) {
    const view = this.view(id);
    if (view.kind !== 'web') throw new Error(`${view.name} 不是网页智能体。`);
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    if (this.running.has(id)) throw new Error(`${view.name} 正在处理消息，等这条结束后再点「重新识别」。`);
    if (this.isRunning(id)) throw new Error(`${view.name} 还在跟进上一条回复，先点「停止跟进」再重新识别`);
    const current = this.webCurrent(id);
    const result = await this.bridge.request(
      // From scratch: after a site change the saved selectors may point at the wrong box; what is found replaces them.
      { action: 'detect', agentId: id, name: view.name, url: view.url!, selectors: {} },
      90_000,
    );
    if (!current()) return { ok: false, message: '网页设置已更改，请重试。', agent: this.view(id) };
    this.recordWebState(id, result);
    if (result.ok && result.selectors) this.config.saveSelectors(id, result.selectors, view.url);
    const ok = result.ok && !!result.found?.input;
    const note = ok
      ? `找到了输入框${result.found?.send ? '和发送按钮' : '（没有发送按钮，会按回车发送）'}。`
      : result.message || webFailure(result.ok ? 'not-detected' : result.code, view.name);
    if (ok || result.code === 'not-detected')
      this.config.update(id, { detection: { at: this.stamp(), ok, note: note.slice(0, 400) } }, { background: true });
    return { ok, message: note, agent: this.view(id) };
  }

  /** Check web replies and usage without overlapping polls. */
  async poll() {
    if (this.checking || this.closed) return;
    this.checking = true;
    try {
      this.pollRoutineReplies();
      await this.pollFollows().catch(() => undefined);
      await this.collectGrokLogin();
      for (const id of externalAgentIds) {
        if (this.closed) break;
        if (id === 'grok-bot') await this.readGrokUsage(true);
        if (externalAgentCatalog[id].kind === 'web') {
          const view = this.view(id);
          if (view.added === false) continue;
          if (this.bridge.available() && view.url && webAgentUrl(view.url) && !this.isRunning(id)) {
            const current = this.webCurrent(id);
            const result = await this.bridge
              .request(
                {
                  action: 'monitor',
                  agentId: id,
                  usageSignedOut: this.config.agent(id).usageSignedOut,
                  name: view.name,
                  url: view.url,
                  enabled: view.enabled && view.available,
                  signatures: view.usageSignatures,
                  usageUrl: view.usageUrl || undefined,
                  configurationVersion: this.webVersion(id),
                  selectors: this.config.selectors(id, view.url),
                },
                10_000,
              )
              .catch((): WebAgentResult => ({ ok: false, code: 'error' }));
            if (!current()) continue;
            if (id === 'muse') {
              if (result.authenticated && this.config.agent(id).usageSignedOut) {
                this.config.update(id, { usageSignedOut: false }, { background: true });
              } else if (!result.authenticated && (result.code === 'login' || result.code === 'human-check'))
                this.config.update(id, { usageSignedOut: true }, { background: true });
              this.recordUsage(id, {
                ...result,
                quota:
                  result.ok && !result.code && result.quota?.status === 'known' && !result.quota.stale
                    ? mergeWebUsage(this.config.agent(id).quota, result.quota)
                    : undefined,
              });
            } else {
              if (result.limit || result.code) this.recordWebState(id, result);
              this.recordUsage(id, result);
            }
          }
          await this.readUsage(id, true).catch(() => undefined);
        }
      }
    } finally {
      this.checking = false;
    }
  }
  /** After a restart: unfinished web messages are reported, never re-sent. */
  private resume() {
    const rows = this.workspace.store.db
      .prepare(
        `SELECT value FROM workspace_records WHERE kind='message' AND instr(value,'"externalAgent"')>0
         AND (json_extract(value,'$.externalAgent.status') IN ('queued','working')
              OR json_extract(value,'$.externalAgent.following') IS NOT NULL)`,
      )
      .all() as { value: string }[];
    for (const row of rows) {
      const message = JSON.parse(row.value) as ConversationMessage & { externalAgent: ExternalAgentMessage };
      const agent = message.externalAgent;
      if (!isExternalAgentId(agent.agentId)) continue;
      if (agent.agentId === 'grok-bot' && agent.routine) {
        if (agent.status === 'working') this.routineReplies.set(message.id, Date.parse(agent.routine.sentAt));
        continue;
      }
      if (agent.following) {
        const trackerId = agent.following.trackerId;
        this.stopTracker(agent.agentId, trackerId);
        this.patch(message.id, (current) => {
          current.status = 'done';
          current.sent = true;
          current.trackerId = trackerId;
          delete current.following;
          current.note = '跟进已中断，可到它的窗口查看后续';
        });
        if (externalAgentCatalog[agent.agentId].kind === 'web') {
          this.interruptedFollows.set(message.id, {
            agentId: agent.agentId,
            trackerId,
            started: this.now(),
          });
        }
        continue;
      }
      const wasWorkingWeb = externalAgentCatalog[agent.agentId].kind === 'web' && agent.status === 'working';
      this.patch(message.id, (current, saved) => {
        current.status = 'failed';
        if (wasWorkingWeb) current.sent = true;
        current.handoff = true;
        current.note = '应用重启，这条没有完成。可以点「重试」，或点「交给它」。';
        saved.content = `${current.name} 这次没有回复。`;
      });
      if (wasWorkingWeb) {
        this.interruptedFollows.set(message.id, {
          agentId: agent.agentId,
          trackerId: agent.trackerId ?? '',
          started: this.now(),
        });
      }
    }
  }
}
