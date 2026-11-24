import { isInvocationDiscussion } from './search-intent.ts';
import { findMentions, withoutMentionName } from './mentions.ts';

/*
 * Agents outside PugPort that the user calls with @@ in a conversation: Muse in its own browser window and Grok Bot through a clipboard and desktop link hand-off.
 */

export const externalAgentIds = ['grok-bot', 'muse'] as const;
export type ExternalAgentId = (typeof externalAgentIds)[number];
export type ExternalAgentKind = 'web' | 'handoff';

export const externalAgentCatalog: Record<
  ExternalAgentId,
  { name: string; kind: ExternalAgentKind; description: string; defaultUrl?: string }
> = {
  'grok-bot': {
    name: 'Grok Bot',
    kind: 'handoff',
    description: '复制消息并打开 Grok Bot，由你粘贴发送；回复不会自动回到 PugPort',
  },
  // Muse's own web chat, as the owner uses it.
  muse: { name: 'Muse', kind: 'web', description: '通过 Meta Muse 网页版提问', defaultUrl: 'https://muse.ai/' },
};

export const isExternalAgentId = (value: unknown): value is ExternalAgentId =>
  typeof value === 'string' && (externalAgentIds as readonly string[]).includes(value);

/** Shown once, before a web agent is turned on. */
export const webAgentRisk = {
  summary: '开启前请了解：',
  points: [
    'PugPort 在它自己的窗口里打字、读取回复。网站改版可能让功能失效。',
    '自动操作可能违反服务的使用条款，账号可能受限。',
    '你在它的窗口里自行登录。PugPort 不会看到或保存你的密码。',
    '回复来自第三方，能用工具的执行器看不到。合并、改稿会另开不带工具的运行；引用回复时，那条消息也不带工具运行。',
  ],
};

/** Words a web agent wrote, or an answer written from them: quoting one makes that message tool-less. */
export const carriesThirdPartyWords = (message: {
  externalAgent?: { untrusted?: boolean };
  combinedFrom?: readonly string[];
  untrustedContent?: boolean;
}) => !!message.externalAgent?.untrusted || !!message.combinedFrom?.length || !!message.untrustedContent;

/** A web agent's reply, an answer written from it, or the user's message to one: kept out of executors' context. */
export const isThirdPartyExchange = (message: {
  externalAgent?: { untrusted?: boolean };
  externalRequest?: { thirdParty?: boolean };
  combinedFrom?: readonly string[];
  untrustedContent?: boolean;
}) => carriesThirdPartyWords(message) || !!message.externalRequest?.thirdParty;

export type ExternalAgentView = {
  id: ExternalAgentId;
  name: string;
  kind: ExternalAgentKind;
  description: string;
  /** Web/handoff agents: explicitly added or retained from a configured legacy entry. */
  added?: boolean;
  enabled: boolean;
  /** Can take a message right now; otherwise `reason` says why. */
  available: boolean;
  routine?: { url: string; keyHint: string };
  reason?: string;
  /** Web agents: the page opened in the agent's window. */
  url?: string;
  usageUrl?: string;
  botId?: string;
  usageEnabled?: boolean;
  usageSource?: 'separate' | 'cursor-editor';
  /** Grok Bot: present with a known usage reading. */
  usageAccount?: import('./grok-usage.ts').GrokUsageAccount;
  quota?: WebQuota;
  usageSignatures?: WebUsageSignature[];
  usageDiagnostics?: string[];
  cooldown?: WebAgentCooldown;
  riskAccepted?: boolean;
  grokDiagnostic?: import('./grok-usage.ts').GrokUsageDiagnostic;
  /** Web agents: the last check of the page (「重新识别」 or a message). */
  detection?: { at: string; ok: boolean; note: string };
  /** Messages waiting for this agent, including the one under way. */
  queued?: number;
};

export type WebAgentCooldown = { reason: string; observedAt: string; resetsAt: string | null };

export type WebTokenBalance = {
  id: string;
  label: string;
  usedPercent: number;
  remainingTokens: number;
  observedAt: string;
  stale?: boolean;
};
export type WebQuota = import('./types.ts').RuntimeSnapshot['quota'] & {
  balances?: WebTokenBalance[];
  stale?: boolean;
};
export type WebUsageField = { path: string[]; scale: number; zeroOnly?: true };
export type WebUsageSignature = {
  method: 'GET';
  origin: string;
  path: string;
  windows: { id: string; label: string; labelPath?: string[]; percent: WebUsageField; reset?: WebUsageField }[];
  balances: { id: string; label: string; percent: WebUsageField; remaining: WebUsageField }[];
};
export const webUsageInvitation = '打开一次用量，PugPort 会学会自动刷新';
export function webUsageNeedsLearning(agent: Pick<ExternalAgentView, 'quota' | 'usageSignatures' | 'usageUrl'>) {
  if (agent.usageUrl) return false;
  const signatures = agent.usageSignatures ?? [];
  return (
    !signatures.length ||
    !!agent.quota?.windows.some(
      (window) => !signatures.some((signature) => signature.windows.some((item) => item.id === window.id)),
    ) ||
    !!agent.quota?.balances?.some(
      (balance) => !signatures.some((signature) => signature.balances.some((item) => item.id === balance.id)),
    )
  );
}
export const webUsageInstructions = '在这个窗口里打开用量（Muse：设置 → 通用 → 使用情况），PugPort 会自动记下';

export const grokBotHandoffNote = '已复制到剪贴板并打开 Grok Bot，在它的窗口里粘贴发送；它的回复不会自动回到 PugPort';
export const grokBotIdPattern = /^[\w-]{1,200}$/;
export const grokBotUsageUrl = 'grokbot://app/v1/settings?id=usage';
export const grokBotUsagePage = 'https://cursor.com/dashboard/spending';
export const grokBotUsageAgentId = 'grok-bot-usage';
export function grokBotUrl(botId = '') {
  if (botId && !grokBotIdPattern.test(botId)) throw new Error('Bot ID 只能包含字母、数字、下划线和连字符。');
  return botId ? `grokbot://app/v1/agent?id=${encodeURIComponent(botId)}` : 'grokbot://';
}
export function webQuotaWindowStale(
  window: WebQuota['windows'][number],
  quota: WebQuota | undefined,
  now = Date.now(),
) {
  const observed = Date.parse(window.observedAt ?? quota?.observedAt ?? '');
  return (
    !!quota?.stale ||
    !!window.stale ||
    !!(window.resetsAt && Date.parse(window.resetsAt) <= now) ||
    (Number.isFinite(observed) && (observed > now || now - observed >= 10 * 60_000))
  );
}
export function webQuotaBalanceStale(balance: WebTokenBalance, quota: WebQuota | undefined, now = Date.now()) {
  const observed = Date.parse(balance.observedAt || quota?.observedAt || '');
  return (
    !!quota?.stale ||
    !!balance.stale ||
    (Number.isFinite(observed) && (observed > now || now - observed >= 10 * 60_000))
  );
}
export function webQuotaStale(quota: WebQuota | undefined, now = Date.now()) {
  if (!quota) return false;
  const observed = Date.parse(quota.observedAt ?? '');
  return (
    !!quota.stale ||
    (Number.isFinite(observed) && (observed > now || now - observed >= 10 * 60_000)) ||
    quota.windows.some((window) => webQuotaWindowStale(window, quota, now)) ||
    !!quota.balances?.some((balance) => webQuotaBalanceStale(balance, quota, now))
  );
}
/** The plan a web agent reports ("SuperGrok", "免费版"); generic window names are not plans. */
export function webPlanLabel(quota: WebQuota | undefined): string | undefined {
  const windows = quota?.status === 'known' ? quota.windows : [];
  const reported =
    quota?.subscription?.label ??
    windows.find((window) => window.id === 'muse-weekly' || window.id === 'grok-bot')?.label;
  if (!reported || ['每周额度', '额度', '未报告套餐'].includes(reported)) return undefined;
  return /^Free(?: plan)?$/i.test(reported) ? '免费版' : reported;
}
export function webTokenLabel(tokens: number) {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(tokens >= 1e8 ? tokens / 1e8 : tokens >= 1e4 ? tokens / 1e4 : tokens)}${tokens >= 1e8 ? ' 亿' : tokens >= 1e4 ? ' 万' : ''}个词元`;
}

export function webResetLabel(resetsAt: string | null | undefined, now = Date.now()): string {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return '重置时间未知';
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (minutes <= 0) return '等待新读数';
  // Whole sentences, so the English window translates each one as a whole ("Resets in 1 h 0 min").
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置` : `${minutes} 分钟后重置`;
}

export function activeWebCooldown(cooldown: WebAgentCooldown | undefined, now = Date.now()) {
  return cooldown && (!cooldown.resetsAt || Date.parse(cooldown.resetsAt) > now) ? cooldown : undefined;
}

export function webQuotaLabel(agent: Pick<ExternalAgentView, 'cooldown' | 'quota'>, now = Date.now()) {
  const cooldown = activeWebCooldown(agent.cooldown, now);
  // Pieces joined with " · ", each one a whole sentence the English window translates on its own.
  if (cooldown) return ['已用完', webResetLabel(cooldown.resetsAt, now)].join(' · ');
  const window = agent.quota?.windows[0];
  if (agent.quota?.status !== 'known' || typeof window?.usedPercent !== 'number') return '没读到用量';
  return [
    ...(webQuotaWindowStale(window, agent.quota, now) ? ['上次读数'] : []),
    `剩余 ${Math.round(100 - window.usedPercent)}%`,
    ...(window.resetNotReported ? [] : [webResetLabel(window.resetsAt, now)]),
  ].join(' · ');
}

export type ExternalReplyStatus = 'queued' | 'working' | 'done' | 'failed' | 'needs-user';

export type GrokReplyPart = {
  part?: number;
  hash: string;
  text: string;
  more?: boolean;
};

/** Kept on the agent's reply message: what was asked and where it stands. */
export type ExternalAgentMessage = {
  agentId: ExternalAgentId;
  name: string;
  status: ExternalReplyStatus;
  /** What is going on, in plain words. */
  note?: string;
  following?: { trackerId: string };
  /** Keep queued messages on the transport selected when the user sent them. */
  routineRequested?: true;
  routine?: {
    replyHash: string;
    sentAt: string;
    runUuid?: string;
    replied?: boolean;
    lastPartHash?: string;
    parts?: GrokReplyPart[];
  };
  /** The text sent to the agent, kept for 「重试」 and 「交给它」. */
  request: string;
  /** True once the prompt has been submitted to the web page, so 「重试」 recaptures instead of resending. */
  sent?: boolean;
  /** What the page actually received when it differs from request (earlier turns packed in), for recapture. */
  sentText?: string;
  /** Retained tracker ID when a sent web turn needs user intervention or recapture before completing. */
  trackerId?: string;
  /** The web thread URL associated with this conversation's exchange. */
  threadUrl?: string;
  /** Written by a third party: shown as its reply; executors only ever see it without tools. */
  untrusted?: boolean;
  /** True when a long web reply exceeded the 100,000-character capture cap. */
  truncated?: boolean;
  /** Offer 「交给它」: copy the request and bring the agent's window to the front. */
  handoff?: boolean;
  /** Handed off to the desktop app: the request went out, and its answer only comes back when the user pastes it. */
  awaitingReply?: true;
  /** When the user pasted the answer for this request; nothing else may answer it after that. */
  importedAt?: string;
  /** Read-only fields retained for old Codex Cloud replies. */
  task?: {
    id?: string;
    url?: string;
    state: 'submitting' | 'pending' | 'ready' | 'applied' | 'error';
    title?: string;
    checkedAt?: string;
    /** False once PugPort stopped checking on its own (too long, or unreadable answers). */
    polling?: boolean;
    /** Where 「应用到本地」 runs; absent in a conversation without a project folder. */
    projectPath?: string;
    diff?: string;
    diffTruncated?: boolean;
    files?: number;
    added?: number;
    removed?: number;
    applied?: { at: string; ok: boolean; output: string };
  };
  updatedAt: string;
};

/**
 * The agent or device a typed message calls by name: only an explicit `@@名字` counts (`@@@` too), and the first one
 * in the text wins. A single `@名字` stays plain text — otherwise a passing mention ("@Muse 那个功能挺好") would send
 * the message to a third-party site. Picking from the @@ menu passes the id explicitly and does not rely on this.
 */
export function externalMention<T extends { id: string; name: string }>(text: string, agents: readonly T[]) {
  return findMentions(
    text,
    agents.map((agent) => ({ agent, name: agent.name, minTier: 2 as const })),
  )[0]?.item.agent;
}

const invocationAliases: Record<ExternalAgentId, readonly string[]> = {
  muse: ['Muse', 'M-U-S-E'],
  'grok-bot': ['Grok Bot', 'grok-bot'],
};

/** Only a leading, direct request can select an existing agent; quoted instructions and name discussions cannot. */
export function externalInvocation<T extends { id: string; name: string }>(content: string, agents: readonly T[]) {
  const text = content.trim();
  if (
    /(?:不要|不用|无需|不需要|不能|不可|不允许|不准|禁止|别|不)\s*(?:调用|使用|用|让|叫|call|ask|use|invoke|联网|上网|访问(?:网络|互联网))|\b(?:do not|don't|cannot|can't|must not|without|never)\s+(?:call|ask|use|invoke|go online)\b/i.test(
      text,
    )
  )
    return undefined;
  const matches = agents.filter((agent) => {
    if (!isExternalAgentId(agent.id)) return false;
    const aliases = [...new Set([agent.name, ...invocationAliases[agent.id]])]
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const name = `(?:${aliases})(?![a-zA-Z0-9_.-])`;
    const match =
      text.match(
        new RegExp(`^(?:请\\s*)?(?:帮我\\s*)?(?:让|叫|调用|使用|用)\\s*${name}\\s*[,，:：]?\\s*([\\s\\S]+)$`, 'i'),
      ) ??
      text.match(
        new RegExp(
          `^(?:please\\s+|(?:(?:我(?:要|想要|想)|请)\\s*)?(?:帮我\\s*)?)(?:call|ask|use|invoke)(?:\\s+|\\s*一下\\s*)(?:这个\\s*)?${name}\\s*[,，:：]?\\s*([\\s\\S]+)$`,
          'i',
        ),
      ) ??
      text.match(
        new RegExp(
          `^(?:请\\s*)?${name}\\s*[,，:：]?\\s*((?:帮我|来)?\\s*(?:回答|解释|分析|检查|写|总结|对比|比较|answer\\b|explain\\b|summari[sz]e\\b)[\\s\\S]+)$`,
          'i',
        ),
      );
    const request = match?.[1]?.trim();
    return (
      !!request &&
      /[\p{L}\p{N}]/u.test(request) &&
      !isInvocationDiscussion(request) &&
      !/^(?:和|或|以及|方法|用法|怎么|如何|这(?:句话|条命令|个(?:操作|功能))|不要|不用|无需|不需要|不能|禁止|别|and\b|or\b|means?\b|what\b)/i.test(
        request,
      ) &&
      !/[，,；;\n]\s*(?:再|然后)?\s*(?:请\s*)?(?:调用|让|叫|call\s+|ask\s+|invoke\s+)(?:Muse|M-U-S-E|Grok Bot|grok-bot)/i.test(
        request,
      )
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** The message without the `@名字` that called the agent. */
export function withoutMention(text: string, name: string): string {
  return withoutMentionName(text, name)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Grok Bot got (or may have got) this exact request and PugPort has no answer for it: the user may paste the answer
 * once. PugPort cannot read results inside Grok Bot, and never runs the request again to get one.
 */
export const canImportReply = (agent: ExternalAgentMessage) =>
  agent.agentId === 'grok-bot' &&
  !agent.importedAt &&
  (agent.routine
    ? !agent.routine.replied && (agent.status === 'working' || agent.status === 'needs-user')
    : !!agent.awaitingReply && agent.status === 'done');

export const isThirdPartyAgent = (agent: Pick<ExternalAgentView, 'kind' | 'routine'>) =>
  agent.kind === 'web' || !!agent.routine;
