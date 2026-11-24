import { currentLocale } from './i18n';
import { ExecutorActivity } from './ExecutorActivity';
import {
  grokDiagnosticLine,
  grokDiagnosticMessages,
  grokUsageAccountLine,
  grokUsageHint,
  grokPlanMismatch,
  type GrokUsageAccount,
} from '../shared/grok-usage';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardCopy,
  FileDiff,
  Loader2,
  LogIn,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Info,
} from 'lucide-react';
import {
  externalAgentCatalog,
  isExternalAgentId,
  webAgentRisk,
  webQuotaLabel,
  activeWebCooldown,
  webPlanLabel,
  webQuotaBalanceStale,
  webQuotaStale,
  webQuotaWindowStale,
  webTokenLabel,
  webUsageInvitation,
  webUsageNeedsLearning,
  type ExternalAgentId,
  type ExternalAgentView,
  grokBotHandoffNote,
} from '../shared/external-agents';
import type { ConversationMessage } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { SettingsRow } from './SettingsRow';
import { confirmDialog } from './confirm-dialog';
import { CompactQuotaSlots, UsageBar, compactResetLabel } from './UsageQuota';
import { shownName, translateInterfaceText } from './i18n';
import { dateLabel } from './App';

type Notify = (notice: Notice) => void;
type AgentList = { agents: ExternalAgentView[] };
const failure = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试。');

let cachedExternalAgents: ExternalAgentView[] | undefined;

/** Read when the @@ menu or a bound chat opens; ordinary chats send no extra request. */
export function useExternalAgents(api: Api, open: boolean, watch = false) {
  const [agents, setAgents] = useState(cachedExternalAgents);
  const [status, setStatus] = useState<'loading' | 'retrying' | 'failed'>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setAgents(cachedExternalAgents);
    setStatus('loading');
    const refresh = async (retry: boolean) => {
      if (!live) return;
      try {
        const value = await api<AgentList>('/api/external-agents', undefined, 'GET');
        if (!Array.isArray(value?.agents)) throw new Error('Invalid external agents list');
        cachedExternalAgents = value.agents;
        if (live) {
          setAgents(value.agents);
          setStatus(undefined);
          if (watch) timer = setTimeout(() => void refresh(true), 5000);
        }
      } catch {
        if (live) {
          setStatus(retry ? 'retrying' : 'failed');
          if (retry || watch) timer = setTimeout(() => void refresh(false), retry ? 2000 : 5000);
        }
      }
    };
    void refresh(true);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, open, watch]);
  return {
    agents: (agents ?? []).filter((agent) => agent.added !== false),
    status: watch || agents === undefined ? status : undefined,
  };
}

export function externalAgentStatus(agent: ExternalAgentView): string {
  if (!agent.enabled) return '已关闭';
  if (!agent.available) return agent.reason ?? '现在不能用';
  if (activeWebCooldown(agent.cooldown)) return webQuotaLabel(agent);
  const queued = agent.queued ? ` · 正在处理 ${agent.queued} 条` : '';
  if (agent.kind === 'handoff') return agent.routine ? '可以使用' : '回复不会回到这里';
  if (!agent.detection) return `已开启：先点「登录」，在它的窗口里登录${queued}`;
  return `${agent.detection.ok ? `可以使用 · ${agent.detection.note}` : `上次没认出页面：${agent.detection.note}`}${queued}`;
}

/** The 外部智能体 card in 设置 → 连接: on/off, address, sign-in and page check. */
export function ExternalAgentsCard({
  api,
  notify,
  mode = 'all',
  refreshKey = 0,
}: {
  api: Api;
  notify: Notify;
  mode?: 'all' | 'bots';
  refreshKey?: number;
}) {
  const [agents, setAgents] = useState<ExternalAgentView[]>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [usageDrafts, setUsageDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const value = await api<AgentList>('/api/external-agents', undefined, 'GET');
      if (current === sequence.current) {
        setAgents(value.agents);
        setLoadError('');
      }
    } catch (error) {
      if (current === sequence.current) setLoadError(failure(error));
      throw error;
    }
  }, [api]);
  useEffect(() => {
    void load().catch(() => undefined);
    const timer = setInterval(() => void load().catch(() => undefined), 5000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [load, refreshKey]);
  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  const patch = (agent: ExternalAgentView, body: Record<string, unknown>) =>
    run(agent.id, async () => {
      const value = await api<AgentList>(`/api/external-agents/${agent.id}`, body, 'PATCH');
      setAgents(value.agents);
    });
  const toggle = async (agent: ExternalAgentView, enabled: boolean) => {
    // The risks are read and accepted once, before a web agent is first turned on.
    if (enabled && agent.kind === 'web' && !agent.riskAccepted) {
      if (!(await confirmDialog({ title: `开启 ${agent.name}？`, ...webAgentRisk, action: `开启 ${agent.name}` })))
        return;
      return patch(agent, { enabled: true, acceptRisk: true });
    }
    return patch(agent, { enabled });
  };
  const save = (agent: ExternalAgentView) => {
    const value = drafts[agent.id];
    if (value === undefined) return;
    const clear = () =>
      setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== agent.id)));
    if (value.trim() === (agent.url ?? '')) return clear();
    void patch(agent, { url: value.trim() }).then(clear);
  };
  const login = (agent: ExternalAgentView) =>
    run(`login:${agent.id}`, async () => {
      const result = await api<{ message: string }>(`/api/external-agents/${agent.id}/login`, {});
      notify({ tone: 'info', message: result.message });
      await load();
    });
  const detect = (agent: ExternalAgentView) =>
    run(`detect:${agent.id}`, async () => {
      const result = await api<AgentList & { ok: boolean; message: string }>(
        `/api/external-agents/${agent.id}/detect`,
        {},
      );
      setAgents(result.agents);
      notify({ tone: result.ok ? 'success' : 'error', message: result.message });
    });
  const saveUsage = (agent: ExternalAgentView) => {
    const value = usageDrafts[agent.id];
    if (value === undefined || value.trim() === (agent.usageUrl ?? '')) return;
    void patch(agent, { usageUrl: value.trim() });
  };
  const visibleAgents = agents?.filter((agent) => agent.added !== false);
  if (mode === 'bots' && visibleAgents?.length === 0 && !loadError) return null;
  return (
    <section className="exec-group external-agents">
      <h2>
        {mode === 'bots' ? 'Bot' : '外部智能体'}
        <small>在对话里输入 @@ 叫它们回答这一条。它们的回复来自第三方，只作参考。</small>
      </h2>
      <div className="settings-group-box">
        {loadError && (
          <div className="inline-error" role="alert">
            读不到外部智能体：{loadError}
            <button type="button" className="button secondary tiny" onClick={() => void load().catch(() => undefined)}>
              重试
            </button>
          </div>
        )}
        {!agents && !loadError && (
          <p className="ext-loading" role="status">
            <Loader2 size={14} className="spinning" />
            正在加载…
          </p>
        )}
        {visibleAgents?.map((agent) => (
          <SettingsRow
            key={agent.id}
            title={agent.name}
            itemId={agent.id}
            className={agent.enabled ? '' : 'off'}
            description={
              agent.kind === 'handoff'
                ? '把消息交给 Grok Bot。设置例程后，回复会回到 PugPort。'
                : agent.description || `用你登录的 ${agent.name} 网页回答问题。`
            }
            status={
              agent.kind === 'handoff'
                ? externalAgentStatus(agent)
                : !agent.enabled
                  ? '已关闭'
                  : !agent.available
                    ? '现在不能用'
                    : '可以使用'
            }
            tone={agent.enabled && agent.available ? 'live' : agent.enabled ? 'warning' : undefined}
            defaultExpanded={agent.kind === 'handoff' ? !agent.routine : agent.enabled && !agent.detection}
            control={
              <label className="switch" title={agent.enabled ? '关闭' : '开启'}>
                <input
                  type="checkbox"
                  checked={agent.enabled}
                  disabled={!!busy}
                  aria-label={agent.enabled ? `关闭 ${agent.name}` : `开启 ${agent.name}`}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void toggle(agent, input.checked).finally(() => {
                      if (input.isConnected) requestAnimationFrame(() => input.isConnected && input.focus());
                    });
                  }}
                />
                <span />
              </label>
            }
          >
            {agent.kind !== 'handoff' && <p className="quota-note">{externalAgentStatus(agent)}</p>}
            {agent.kind === 'handoff' ? (
              <GrokBotControls
                agent={agent}
                api={api}
                notify={notify}
                onRoutineSaved={setAgents}
                busy={!!busy}
                onPatch={(body) => void patch(agent, body)}
                onLogin={() => void login(agent)}
                onOpen={(settings) =>
                  void run(`open:${agent.id}`, async () => {
                    const result = await api<{ message: string }>(
                      `/api/external-agents/${agent.id}/${settings ? 'usage-settings' : 'open'}`,
                      {},
                    );
                    notify({ tone: 'info', message: result.message });
                  })
                }
              />
            ) : (
              <div className="external-agent-fields">
                <label className="field">
                  <span>{`${agent.name} 网址`}</span>
                  <input
                    aria-label={`${agent.name} 网址`}
                    type="url"
                    spellCheck={false}
                    placeholder={agent.id === 'muse' ? 'Muse 网页版的网址（请自己填写）' : 'https://…'}
                    value={drafts[agent.id] ?? agent.url ?? ''}
                    disabled={busy === agent.id}
                    onChange={(event) => setDrafts({ ...drafts, [agent.id]: event.target.value })}
                    onBlur={() => save(agent)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') save(agent);
                    }}
                  />
                </label>
                {agent.kind === 'web' && (
                  <>
                    <button
                      type="button"
                      className="button secondary tiny"
                      disabled={!agent.available || !!busy}
                      title="在它自己的窗口里登录；PugPort 不会看到密码"
                      onClick={() => void login(agent)}
                    >
                      {busy === `login:${agent.id}` ? <Loader2 size={12} className="spinning" /> : <LogIn size={12} />}
                      登录
                    </button>
                    <button
                      type="button"
                      className="button secondary tiny"
                      disabled={!agent.available || !!busy}
                      title="网站改版后，重新找输入框和发送按钮"
                      onClick={() => void detect(agent)}
                    >
                      {busy === `detect:${agent.id}` ? (
                        <Loader2 size={12} className="spinning" />
                      ) : (
                        <ScanSearch size={12} />
                      )}
                      重新识别
                    </button>
                  </>
                )}
              </div>
            )}
            {agent.kind === 'web' && (
              <div className="external-agent-fields">
                <label className="field">
                  <span>{`${agent.name} 用量页面`}</span>
                  <input
                    aria-label={`${agent.name} 用量页面`}
                    type="url"
                    spellCheck={false}
                    placeholder="用量页面网址（可选）"
                    value={usageDrafts[agent.id] ?? agent.usageUrl ?? ''}
                    disabled={!!busy}
                    onChange={(event) => setUsageDrafts({ ...usageDrafts, [agent.id]: event.target.value })}
                    onBlur={() => saveUsage(agent)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveUsage(agent);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="button secondary tiny"
                  disabled={!agent.available || !!busy}
                  onClick={() =>
                    void run(`usage:${agent.id}`, async () => {
                      const result = await api<AgentList & { ok: boolean; message: string }>(
                        `/api/external-agents/${agent.id}/usage`,
                        {},
                      );
                      setAgents(result.agents);
                      notify({ tone: result.ok ? 'success' : 'info', message: result.message });
                    })
                  }
                >
                  读取用量
                </button>
              </div>
            )}
          </SettingsRow>
        ))}
      </div>
    </section>
  );
}

export function GrokBotControls({
  api,
  notify,
  onRoutineSaved,
  agent,
  busy,
  onPatch,
  onOpen,
  onLogin,
}: {
  agent: ExternalAgentView;
  busy?: boolean;
  api?: Api;
  notify?: Notify;
  onRoutineSaved?: (agents: ExternalAgentView[]) => void;
  onPatch?: (body: Record<string, unknown>) => void;
  onOpen?: (settings: boolean) => void;
  onLogin?: () => void;
}) {
  const save = (value: string) => {
    if (value.trim() !== (agent.botId ?? '')) onPatch?.({ botId: value.trim() });
  };
  return (
    <div className="grok-bot-controls">
      <GrokRoutineControls agent={agent} api={api} notify={notify} onSaved={onRoutineSaved} />
      <p className="quota-note">{grokUsageHint}</p>
      <div className="external-agent-fields">
        <label className="field">
          <span>Grok Bot 标识</span>
          <input
            key={agent.botId}
            aria-label="Grok Bot 标识"
            placeholder="机器人标识（可选）"
            defaultValue={agent.botId ?? ''}
            disabled={busy || !onPatch}
            maxLength={200}
            onBlur={(event) => save(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save(event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !onOpen}
          onClick={() => onOpen?.(false)}
        >
          打开 Grok Bot
        </button>
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !onOpen}
          onClick={() => onOpen?.(true)}
        >
          打开用量设置
        </button>
      </div>
      <button type="button" className="button secondary tiny" disabled={busy || !onLogin} onClick={onLogin}>
        登录用量账号
      </button>
      <label className="quota-note">
        Grok Bot 用量来自：
        <select
          aria-label="Grok Bot 用量来源"
          value={agent.usageSource ?? 'separate'}
          disabled={busy || !onPatch}
          onChange={(event) => onPatch?.({ usageSource: event.target.value })}
        >
          <option value="separate">独立登录（推荐）</option>
          <option value="cursor-editor">Cursor 编辑器登录</option>
        </select>
      </label>
      {agent.usageAccount && (
        <GrokUsageAccountNote
          account={agent.usageAccount}
          disabled={busy}
          onConfirm={onPatch && (() => onPatch({ usageAccountConfirmed: agent.usageAccount!.fingerprint }))}
        />
      )}
      <label className="quota-note">
        <input
          type="checkbox"
          checked={!!agent.usageEnabled}
          disabled={busy || !onPatch}
          onChange={(event) => onPatch?.({ usageEnabled: event.target.checked })}
        />
        读取 Grok Bot 用量
      </label>
    </div>
  );
}

/** The usage account's status; an identified account that isn't confirmed yet can be confirmed here. */
function GrokUsageAccountNote({
  account,
  disabled,
  onConfirm,
}: {
  account: GrokUsageAccount;
  disabled?: boolean;
  onConfirm?: () => void;
}) {
  return (
    <p className={account.status === 'different' ? 'quota-note usage-error' : 'quota-note'}>
      {grokUsageAccountLine(account)}{' '}
      {account.fingerprint && account.status !== 'matches' && (
        <button type="button" className="button secondary tiny" disabled={disabled || !onConfirm} onClick={onConfirm}>
          这是我在 Grok Bot 里用的账号
        </button>
      )}
    </p>
  );
}

export function GrokRoutineControls({
  agent,
  api,
  notify,
  onSaved,
}: {
  agent: ExternalAgentView;
  api?: Api;
  notify?: Notify;
  onSaved?: (agents: ExternalAgentView[]) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notify?.({ tone: 'error', message: failure(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grok-routine-controls">
      <strong>例程对话</strong>
      {!agent.routine && (
        <p className="quota-note">未设置例程时会复制消息并打开 Grok Bot；在这里设置后，回复会回到 PugPort。</p>
      )}
      <div className="external-agent-fields">
        <label className="field">
          <span>例程 webhook 网址</span>
          <input
            data-settings-focus
            aria-label="例程 webhook 网址"
            type="url"
            spellCheck={false}
            placeholder="https://api2.cursor.sh/automations/webhook/…"
            value={url ?? agent.routine?.url ?? ''}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy || !api}
          />
        </label>
        <label className="field">
          <span>例程密钥</span>
          <input
            aria-label="例程密钥"
            type="password"
            autoComplete="new-password"
            placeholder={agent.routine?.keyHint ?? '粘贴例程密钥'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy || !api}
          />
        </label>
      </div>
      <div className="external-agent-actions">
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !api}
          onClick={() =>
            void act(async () => {
              const value = await api!<AgentList>(
                '/api/external-agents/grok-bot/routine',
                { url: url ?? agent.routine?.url ?? '', ...(key ? { key } : {}) },
                'PUT',
              );
              setKey('');
              setUrl(undefined);
              onSaved?.(value.agents);
              notify?.({ tone: 'success', message: '例程设置已保存。' });
            })
          }
        >
          保存例程
        </button>
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !api}
          onClick={() =>
            void act(async () => {
              const value = await api!<{ text: string }>(
                '/api/external-agents/grok-bot/routine-instructions',
                undefined,
                'GET',
              );
              await navigator.clipboard.writeText(value.text);
              notify?.({ tone: 'success', message: '例程说明已复制，请粘贴到 Grok Bot 例程的编辑面板。' });
            })
          }
        >
          复制例程说明
        </button>
      </div>
      <p className="quota-note">每条消息消耗一次例程运行。留空网址并保存可恢复桌面交接。</p>
      <p className="quota-note">
        回复需要允许 Grok Bot 在这台电脑上运行命令。选择「始终允许（Always allow）」后，它可以不询问就运行任何命令；这是
        Grok Bot 自己的设置，由你决定。
      </p>
    </div>
  );
}

export function WebAgentQuotaRows({
  agents,
  now,
  onRead,
  busy,
  compact = false,
  onLogin,
  onConfirmAccount,
}: {
  agents: ExternalAgentView[];
  now: number;
  onRead?: (agent: ExternalAgentView) => void;
  busy?: boolean;
  compact?: boolean;
  onLogin?: (agent: ExternalAgentView) => void;
  onConfirmAccount?: (agent: ExternalAgentView) => void;
}) {
  const usageAgents = agents.filter(
    (agent) => agent.added !== false && (agent.kind === 'web' || agent.id === 'grok-bot'),
  );
  if (!usageAgents.length) return null;
  return (
    <section aria-label="外部智能体" className={compact ? 'web-compact-section' : 'resource-grid web-quota-section'}>
      <h2>外部智能体</h2>
      {usageAgents.map((agent) => {
        const cooldown = activeWebCooldown(agent.cooldown, now);
        const windows = agent.quota?.status === 'known' ? agent.quota.windows : [];
        const balances = agent.quota?.balances ?? [];
        const plan = webPlanLabel(agent.quota);
        const shown = cooldown
          ? [{ id: 'cooldown', label: '额度', usedPercent: 100, resetsAt: cooldown.resetsAt }]
          : windows;
        // One bar per web account, matching the tray's weekly reading.
        const selected = shown.find((window) => window.durationMinutes === 10080) ?? shown[0];
        const balanceLine = balances
          .map(
            (balance) =>
              `${webQuotaBalanceStale(balance, agent.quota, now) ? '上次读数 · ' : ''}剩余 ${webTokenLabel(balance.remainingTokens).replace('个词元', '词元')} · 从不过期`,
          )
          .join(' · ');
        const readings = (compact ? (selected ? [selected] : []) : shown).map((window) => ({
          label: window.id === 'muse-weekly' ? '每周额度' : window.id === 'grok-bot' ? '额度' : window.label,
          left: window.usedPercent === null ? undefined : Math.max(0, Math.round(100 - window.usedPercent)),
          reset: window.resetsAt
            ? compactResetLabel(window.resetsAt, now)
            : agent.id === 'grok-bot' && window.resetNotReported
              ? 'Cursor 没有提供重置时间'
              : '重置时间未知',
          resetTitle: window.resetsAt ? dateLabel(window.resetsAt) : undefined,
          stale: !cooldown && webQuotaWindowStale(window, agent.quota, now),
        }));
        const learned = !webUsageNeedsLearning(agent);
        const desktop = agent.kind === 'handoff';
        const emptyGrok = desktop && !readings.length;
        const main = desktop
          ? agent.grokDiagnostic && agent.grokDiagnostic.code !== 'success'
            ? grokDiagnosticMessages[agent.grokDiagnostic.code]
            : '没读到用量'
          : webQuotaLabel(agent, now);
        const hint =
          emptyGrok && agent.usageEnabled && agent.usageSource !== 'cursor-editor'
            ? '点击「登录用量账号」打开用量窗口'
            : agent.id === 'muse' && webQuotaStale(agent.quota, now) && !learned
              ? '在 Muse 窗口打开 设置 → 通用 → 使用情况 即可刷新'
              : undefined;
        const footerLine = desktop
          ? '每 10 分钟自动刷新'
          : agent.usageUrl
            ? '每 10 分钟自动刷新用量页面'
            : learned
              ? '每 10 分钟自动刷新'
              : readings.length
                ? '打开设置时刷新用量'
                : webUsageInvitation;
        const learningAction = !desktop &&
          !learned &&
          (!readings.length || webQuotaStale(agent.quota, now)) &&
          onRead && (
            <button
              type="button"
              className="icon-button"
              aria-label={`${agent.name} 读取用量`}
              title={`${agent.name} 读取用量`}
              disabled={busy || !agent.available}
              onClick={() => onRead(agent)}
            >
              <RefreshCw size={12} />
            </button>
          );
        const errors = [
          !desktop && agent.quota?.status === 'error' ? agent.quota.note || '额度读取失败' : undefined,
          cooldown?.reason,
          !desktop && !agent.available ? agent.reason : undefined,
          compact && agent.usageAccount?.status === 'different' ? grokUsageAccountLine(agent.usageAccount) : undefined,
        ].filter(Boolean);
        const loginAction = desktop && (
          <button
            type="button"
            className="button tiny quiet"
            disabled={busy || !onLogin}
            onClick={() => onLogin?.(agent)}
          >
            登录用量账号
          </button>
        );
        return (
          <article
            key={agent.id}
            data-runtime-id={agent.id}
            className={`quota-card ${compact ? 'compact-quota-card web-compact-card' : ''} ${desktop ? 'grok-bot-card' : ''} ${emptyGrok ? 'grok-usage-empty' : ''}`}
            title={compact && balanceLine ? balanceLine : undefined}
          >
            {compact ? (
              <CompactQuotaSlots
                activity={
                  <ExecutorActivity
                    id={agent.id}
                    error={!desktop && !agent.available ? agent.reason || '连接异常' : undefined}
                  />
                }
                name={translateInterfaceText(agent.name)}
                plan={plan}
                readings={readings}
                main={!readings.length ? main : undefined}
                chips={
                  <footer
                    className="web-quota-footer-line"
                    title={[footerLine, hint, ...errors].filter(Boolean).join(' · ')}
                  >
                    {errors[0] && <span>{errors[0]}</span>}
                    {loginAction}
                    {learningAction}
                  </footer>
                }
              />
            ) : (
              <>
                <div className="quota-heading">
                  <div>
                    <h3>{agent.name}</h3>
                    <ExecutorActivity
                      id={agent.id}
                      error={!desktop && !agent.available ? agent.reason || '连接异常' : undefined}
                    />
                  </div>
                  {plan && <span className="plan-badge">{plan}</span>}
                </div>
                <div className="quota-body">
                  {readings.map((reading, index) => (
                    <UsageBar key={index} account={translateInterfaceText(agent.name)} {...reading} />
                  ))}
                  {balanceLine && <p className="quota-note">{balanceLine}</p>}
                  {!readings.length && <span className="quiet-text">{main}</span>}
                  {errors.map((error, index) => (
                    <p key={index} className="quota-note usage-error">
                      {error}
                    </p>
                  ))}
                  {desktop && (
                    <>
                      <p className="quota-note">{grokUsageHint}</p>
                      {agent.usageAccount && (
                        <GrokUsageAccountNote
                          account={agent.usageAccount}
                          disabled={busy}
                          onConfirm={onConfirmAccount && (() => onConfirmAccount(agent))}
                        />
                      )}
                      {agent.quota?.status === 'known' &&
                        agent.quota.subscription?.label &&
                        !/^SuperGrok/i.test(agent.quota.subscription.label) &&
                        agent.quota.subscription.label !== '未报告套餐' && (
                          <p className="quota-note">{grokPlanMismatch}</p>
                        )}
                      {agent.grokDiagnostic && (
                        <details className="quota-details">
                          <summary>读取详情</summary>
                          <p className="quota-note">{grokDiagnosticLine(agent.grokDiagnostic)}</p>
                        </details>
                      )}
                    </>
                  )}
                </div>
                <footer className="quota-footer">
                  <>
                    <div className="quota-footer-line" title={footerLine}>
                      {loginAction}
                      {learningAction}
                    </div>
                    <details className="quota-details">
                      <summary>详情</summary>
                      {desktop && agent.quota?.currentPeriodStart && (
                        <p className="quota-note">
                          本期从{' '}
                          {new Date(agent.quota.currentPeriodStart).toLocaleDateString(currentLocale(), {
                            month: 'numeric',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}{' '}
                          开始
                        </p>
                      )}

                      <p className="quota-note">
                        {desktop ? (
                          agent.quota?.source
                        ) : (
                          <>
                            {agent.quota?.source ?? '网页用量页'} · {agent.usageSignatures?.length ?? 0} 个用量签名
                          </>
                        )}
                      </p>
                      {agent.usageUrl && (
                        <p className="quota-note" title={agent.usageUrl}>
                          {agent.usageUrl}
                        </p>
                      )}
                      {agent.usageDiagnostics?.map((sample, index) => (
                        <p className="quota-note" key={index}>
                          {sample}
                        </p>
                      ))}
                    </details>
                  </>
                </footer>
              </>
            )}
            {hint && <p className="quota-note">{hint}</p>}
          </article>
        );
      })}
    </section>
  );
}

export function WebAgentQuotas({
  api,
  now,
  compact = false,
  onUpdated,
}: {
  api: Api;
  now: number;
  compact?: boolean;
  onUpdated?: (at: string | undefined) => void;
}) {
  const [agents, setAgents] = useState<ExternalAgentView[]>([]);
  useEffect(() => {
    const latest = agents
      .map((agent) => agent.quota?.observedAt)
      .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    onUpdated?.(latest);
  }, [agents, onUpdated]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const latestApi = useRef(api);
  latestApi.current = api;
  useEffect(() => {
    let live = true;
    let pending = false;
    const load = () => {
      if (pending) return;
      pending = true;
      void latestApi
        .current<AgentList>('/api/external-agents', undefined, 'GET')
        .then((value) => {
          if (live && Array.isArray(value?.agents)) setAgents(value.agents);
        })
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const read = async (agent: ExternalAgentView) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const result = await api<AgentList & { message: string }>(`/api/external-agents/${agent.id}/usage`, {});
      setAgents(result.agents);
      setNote(result.message);
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const confirmAccount = async (agent: ExternalAgentView) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const result = await api<AgentList>(
        `/api/external-agents/${agent.id}`,
        { usageAccountConfirmed: agent.usageAccount?.fingerprint },
        'PATCH',
      );
      setAgents(result.agents);
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const login = async (agent: ExternalAgentView) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const result = await api<{ message: string }>(`/api/external-agents/${agent.id}/login`, {});
      setNote(result.message);
      const value = await latestApi.current<AgentList>('/api/external-agents', undefined, 'GET');
      setAgents(value.agents);
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <WebAgentQuotaRows
        agents={agents}
        now={now}
        onRead={(agent) => void read(agent)}
        busy={busy}
        compact={compact}
        onLogin={(agent) => void login(agent)}
        onConfirmAccount={(agent) => void confirmAccount(agent)}
      />
      {note && <p role="status">{note}</p>}
    </>
  );
}

/**
 * The reply label of a message an external agent or a device answered ("家里的Ubuntu · Claude B"), to show as written:
 * the agent's name and a default account name translate, the device's name and accounts people named do not.
 */
export const externalPersona = (message: ConversationMessage) =>
  (message.externalAgent ? translateInterfaceText(message.externalAgent.name) : undefined) ??
  (message.device
    ? [message.device.name, message.device.executor && shownName(message.device.executor)].filter(Boolean).join(' · ')
    : undefined);

export const externalReplyIsNotice = (message: ConversationMessage) =>
  Boolean(
    message.externalAgent &&
    isExternalAgentId(message.externalAgent.agentId) &&
    ((message.externalAgent.status !== 'done' && !message.externalAgent.following) ||
      message.content === grokBotHandoffNote),
  );

/** Under an answer combined from web agents' replies: where its words came from, and what that means next. */
export function CombinedReplyNote({ names }: { names: readonly string[] }) {
  return (
    <p className="external-reply-trust">
      <ShieldAlert size={12} aria-hidden="true" />
      这条答复用到了 {names.join('、')}{' '}
      的第三方回复，只作参考。之后的消息不会把它交给执行器；要接着改它，请引用它（那一条消息不带工具运行）。
    </p>
  );
}

/** Under an external agent's reply: saved changes, current status and available actions. */
export function ExternalReplyPanel({
  message,
  api,
  notify,
  onManageConnectors,
}: {
  message: ConversationMessage;
  api?: Api;
  notify: Notify;
  onManageConnectors?: (focusId?: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const agent = message.externalAgent;
  const task = agent?.task;
  // Old Codex Cloud replies retain their saved diff, without any live actions.
  const diff = task?.diff ? (
    <details className="external-reply-diff">
      <summary>
        <FileDiff size={12} aria-hidden="true" />
        查看改动{task.files ? `（${task.files} 个文件，+${task.added ?? 0} −${task.removed ?? 0}）` : ''}
      </summary>
      <pre>{task.diff}</pre>
      {task.diffTruncated && <small>改动太长，这里只显示前一部分；完整内容请打开任务查看。</small>}
    </details>
  ) : null;
  if (!agent || !isExternalAgentId(agent.agentId)) return diff;
  const kind = externalAgentCatalog[agent.agentId as ExternalAgentId]?.kind;
  const web = kind === 'web' || kind === 'handoff';
  const working = !agent.following && (agent.status === 'queued' || agent.status === 'working');
  const ended = agent.status === 'failed' || agent.status === 'needs-user';
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    if (busy || !api) return;
    setBusy(action);
    try {
      const result = await api<{ message?: string; ok?: boolean }>(
        `/api/external-agents/messages/${encodeURIComponent(message.id)}/${action}`,
        body,
      );
      if (result?.message) notify({ tone: result.ok === false ? 'error' : 'success', message: result.message });
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  const spinner = (action: string) => busy === action && <Loader2 size={12} className="spinning" />;
  return (
    <div className={`external-reply ${agent.status}`}>
      {(agent.following || agent.note || working || ended || externalReplyIsNotice(message)) && (
        <p className="external-reply-note" role="status">
          {working ? <Loader2 size={12} className="spinning" /> : <Info size={12} aria-hidden="true" />}
          {agent.following
            ? `正在留意 ${agent.name} 的后续回复`
            : (agent.note ?? (agent.status === 'queued' ? '排队中…' : working ? '处理中…' : message.content))}
        </p>
      )}
      {agent.untrusted && (agent.status === 'done' || agent.following) && (
        <p className="external-reply-trust">
          <ShieldAlert size={12} aria-hidden="true" />
          第三方回复，只作参考。PugPort 的执行器看不到它；引用它时，那一条消息不带工具运行。
        </p>
      )}
      {agent.truncated && (
        <p className="external-reply-note">
          <Info size={12} aria-hidden="true" />
          回复太长，这里只显示最后一部分；完整内容请到它的窗口查看。
        </p>
      )}
      {diff}
      {task?.applied && (
        <details className="external-reply-diff">
          <summary>{task.applied.ok ? '已应用到本地' : '应用到本地没有成功'}</summary>
          {task.applied.output ? <pre>{task.applied.output}</pre> : <small>（没有输出）</small>}
        </details>
      )}
      {api && (
        <div className="external-reply-actions">
          {agent.agentId === 'grok-bot' && agent.handoff && !agent.routine && onManageConnectors && (
            <button type="button" className="button tiny quiet" onClick={() => onManageConnectors('grok-bot')}>
              设置例程，让回复回到 PugPort
            </button>
          )}
          {agent.following && (
            <button
              type="button"
              className="button tiny quiet"
              disabled={!!busy}
              onClick={() => void act('stop-following')}
            >
              {spinner('stop-following')}停止跟进
            </button>
          )}
          {ended && !agent.routine && (
            <button
              type="button"
              className="icon-button"
              title="重试"
              aria-label="重试"
              disabled={!!busy}
              onClick={() => void act('retry')}
            >
              {spinner('retry') || <RotateCcw size={12} />}
            </button>
          )}
          {web && ended && agent.handoff && (
            <button
              type="button"
              className="icon-button"
              aria-label="交给它"
              disabled={!!busy}
              title="把这条消息复制到剪贴板，并打开它的窗口，由你粘贴发送"
              onClick={() => void act('handoff')}
            >
              {spinner('handoff') || <ClipboardCopy size={12} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
