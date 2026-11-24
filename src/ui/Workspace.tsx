import { openProblemReport, ReportProblemAction } from './ProblemReport';
import { ConversationTaskDock } from './ConversationTaskDock';
import { useConversationPresentations } from './conversation-presentations';
import { RotateCcw } from 'lucide-react';
import { ConversationTurn, ReasoningTail } from './ConversationTurn';
import { ConversationBackground } from './ConversationBackground';
import { requestTurnInspection } from './turn-inspection';
import { resumedMessage } from '../shared/task-request';
import {
  formatGateLines,
  parseGateLines,
  gateLoosening,
  normalizeGates,
  type GateLineError,
} from '../shared/project-gates';
import { DelegationTree } from './DelegationTree';
import { LayaFirstUseNotice } from './LayaFirstUseNotice';
import type { SettingsCategory } from './settings-categories';
import { effectiveRoutingProfileId, type RoutingProfile } from '../shared/routing-profiles';
import { ProjectRoutingDefault } from './ProjectRoutingDefault';
import type { GitHubStatus } from '../server/github';
import { useUiUpdateBlocker } from './ui-update-guard';
import type { ExtensionView } from '../shared/extensions';
import { isApiHarness } from '../shared/provider-registry';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { WebSearchReply } from './WebSearchReply';
import { ModToolbarButton } from './mods/ModToolbarButton';
import { ModPanel } from './mods/ModPanel';
import { ModFrame, ModLoading, ModFailure } from './mods/ModFrame';
import { ModWorkspaceBar } from './mods/ModWorkspaceBar';
import { resolveModLayout, modChatPlacement } from './mods/mod-layout';
import { friendlyModError } from './mod-errors';
import { useModHost } from './mods/use-mod-host';
import { browserVoiceDevices } from './mods/mod-voice';
import { createPortal } from 'react-dom';
import { useConversationMode } from './conversation-mode-session';
import { canAttachMod } from '../shared/conversation-modes';
import { canUseConversationCollaboration } from '../shared/conversation-collaboration';
import { ConversationWorkPanel } from './ConversationWorkPanel';
import { IncognitoLabel } from './IncognitoLabel';
import { composerEnterAction } from '../shared/composer-enter';
import { insertFileReference, type FileReference } from './FileMentions';
import { mentionPrefix, mentionPrefixAt } from '../shared/mentions';
import { SlashCommands, filterSlashCommands, slashCommandAt, type SlashCommand } from './SlashCommands';
import { archiveConversation } from './ConversationArchive';
import { MemoryTabs, MemoryAutoPanel } from './MemoryAuto';
import { FindBar } from './FindBar';
import type { MemoryAutoView } from '../shared/types';
import { permissionLine } from '../shared/permission-reason.ts';
import { verificationLimitedChecks } from '../shared/verification-limited.ts';
import {
  lazy,
  Suspense,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from 'react';
import { cursorModelForPin } from '../shared/model-family';
import { executorSelectionStatus } from './executor-selection';
import { listAgentPresets } from '../shared/agent-presets';
import { useMenuKeys } from './use-menu-keys';
import { useFocusTrap } from './use-focus-trap';
import { useDismiss } from './use-dismiss';
import { leaveSwarm } from './swarm-switch';
import {
  MentionMenu,
  executorMentionName,
  mentionItems as mentionChoicesFor,
  mentionSections,
  readMentionUsage,
  recordMentionUse,
  shownMentionName,
  type MentionItem,
} from './Mentions';
import {
  CombinedReplyNote,
  ExternalReplyPanel,
  externalPersona,
  externalReplyIsNotice,
  useExternalAgents,
} from './ExternalAgents';
import {
  ConversationExchange,
  MentionText,
  ParticipantBody,
  ParticipantHeading,
  participantIdentity,
  participantKind,
  participantStyle,
  type ParticipantIdentity,
} from './ParticipantReply';
import {
  externalAgentCatalog,
  externalAgentIds,
  externalInvocation,
  type ExternalAgentId,
} from '../shared/external-agents';
import { useDevices } from './Devices';
import { ServerEnroll } from './ServerEnroll';
import { wakeInstabox } from './instabox';
import type { InstaboxMachineView, RemoteServerView, RemoteServersView } from '../shared/remote-servers';
import { deviceMentionPrefix } from '../shared/devices';
import { calledFields, participantKey, stillNamed, withParticipant, withoutCalledName } from '../shared/participants';
import { AgentPresetDialog } from './AgentPresets';
import { SwarmPlanPanel, SwarmWorkspace, conversationPlan, type SwarmChatLine } from './SwarmWorkspace';
import { captureReplyIdentity, namedIdentity, replyIdentity } from '../shared/reply-identity';
import { ReplyIdentity } from './ReplyIdentity';
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Circle,
  Clock,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Square,
  SquareTerminal,
  X,
  ClipboardCheck,
  Maximize2,
  Minimize2,
  Quote,
  SquareDashed,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { delegationLabel, delegationRoleLabels, providerNames } from '../shared/delegation';
import { loadComposerSelection, saveComposerSelection } from './composer-memory';
import {
  ComposerSession,
  pickDraftMention,
  emptyDraft,
  draftAfterSend,
  draftFromHistory,
  hasDraftContent,
  composerMessageKey,
  mergePendingMessages,
  type ComposerDraft,
  type PendingComposerSend,
} from './composer-session';
import { composerEfforts, EffortSlider, ModeChip, ModeMenu, SchedulePanel } from './ComposerControls';
import type { WorkMode } from '../shared/work-modes';
import { QuestionCard, openQuestion } from './QuestionCard';
import { ModApprovalCard } from './ModApprovalCard';
import { modDebugDraft, type ModDebugInfo } from './mods/ModDebugMenu';
import { MOD_APPROVAL_PERMISSIONS } from '../shared/mods-manifest';
import { effortName } from '../shared/effort';
import { requestModReload, useModDebug } from './mods/mod-debug-store';
import { useLocalModBuild, useModDiagnosticsUpload, useModWorkspaceFolder } from './mods/use-mod-debug';
import { PlanReview } from './PlanReview';
import {
  queuedSteeringRun,
  resolveComposerSteering,
  steerFirstQueuedMessage,
  steerQueuedWorkflow,
} from './composer-steering';
import { conversationQueuedMessages, representedQueueHeadId } from './message-queue';
import { ConversationQueue, setConversationQueueing } from './ConversationQueue';
import { MessageBranchActions, SentMessageEditor } from './MessageBranchActions';
import { BackgroundTasks, remainingLabel } from './BackgroundTasks';
import { MediaWorkflowDialog } from './MediaWorkflows';
import { ImageViewer, type ViewerMarkup } from './ImageViewer';
import { generatedImageCaption, MessageAttachments } from './MessageAttachments';
import type { MarkupResult } from './ImageMarkup';
import { markupQuoteText } from '../shared/markup-text';
import { MAX_QUOTES, MAX_QUOTE_LENGTH } from '../shared/quotes';
import { sentQuotes } from './composer-session';
import { ClaimsCheck, FactCheck, StepReport } from './ClaimsCheck';
import { continuedPredecessors, conversationTimeline, type SteeringStage } from './conversation-timeline';
import { replyAttempts, selectedReplyAttempt } from './reply-attempts';
import { conversationTrajectoryRunId } from './conversation-trajectory';
import { ConversationTrace } from './ConversationTrace';
import { ContextUsage, conversationContextRun } from './ContextUsage';
import { DelegationProgress, shownAgentLabel } from './DelegationProgress';
import { WorkflowElapsed } from './WorkflowElapsed';
import { SideChatPanel } from './SideChatPanel';
import { ConversationPanel, type PanelTab } from './ConversationPanel';
import { TasteTestCard } from './TasteTest';
import { SideChatHistory } from './SideChatHistory';
import { SelectionActions } from './SelectionActions';
import { MessageQuotes, QuoteChips, QuoteEditor, type DraftQuote } from './Quotes';
import { ConversationRail } from './ConversationRail';
import { PinnedMessages, type PinUpdate } from './PinnedMessages';
import { PinnedRail, useMessageGutter } from './PinnedRail';
import { PinnedMessageWindow } from './PinnedMessageWindow';
import { pinRailLayout } from '../shared/pinned-messages';
import { ContextMenu, type MenuItem } from './DesktopFeatures';
import { conversationSelection } from './quotation';
import { savedSideChatLaunch, sideChatHistory, type SideChatLaunch } from './side-chat';
import { inheritSideChatSelection } from './side-chat-selection';
import type {
  AppState,
  Attachment,
  Conversation,
  ConversationMessage,
  ConversationMessagePin,
  MessageInput,
  LocalMemorySettings,
  Project,
  ProjectMemory,
  RunRecord,
  Workflow,
} from '../shared/types';
import { desktopBridge } from './desktop';
import { TaskJudgmentCard } from './TaskJudgment';
import { MemoryEvidenceCard } from './MemoryEvidence';
import { ApprovalCard, dateLabel } from './App';
import { currentLocale, shownName, shownTitle, translateInterfaceText, withNames } from './i18n';
import {
  executorGroup,
  executorGroupLabels,
  modelGroupLabels,
  modelGroupLabelsEn,
  splitOlderModels,
  unsupportedMediaTitle,
  type ModelModality,
} from '../shared/model-groups';
import {
  failureNotice,
  localizeNoticeDetails,
  noticeMessage,
  systemNoticeText,
  type SystemNotice,
} from '../shared/system-notices';
import { SteeringProgress } from './SteeringProgress';
import { renderMarkdown } from './markdown';
import { ReplyPaths, useProjectPaths, type ReplyPathOpener } from './ReplyPaths';
import { ChipSelect } from './ChipSelect';
import { cursorModelPoolLabel } from '../shared/cursor-models';
import { newModelTitle } from './model-options';
import { availableCoreTargets, runtimeIdentity, unavailableRuntimeLabel } from './core-runtime';
import { webSearchCommand } from '../shared/web-search';
import {
  canCancelWorkflow,
  canContinueWorkflow,
  canDeleteWorkflow,
  composerMessageSchedule,
  deadlineRiskLabel,
  estimatedDuration,
  isActiveWorkflow,
  isExecutingWorkflow,
  isWaitingWorkflow,
  needsContinuation,
  queueDate,
  workflowDisplayStatus,
  workflowFollowUp,
  workflowContinuation,
} from './queue-utils';
import {
  AttachmentScopeChanged,
  attachmentContentUrl,
  attachmentSize,
  copyAttachmentImage,
  filesFromTransfer,
  isAttachmentImage,
  selectAttachmentFiles,
  textOnlyRecipients,
  uploadDraftAttachments,
  pastedAttachmentFiles,
  type DraftAttachment,
} from './attachments';

import { StartChecklist } from './StartChecklist';
import { AccountWelcomeCard } from './AccountSettings';

export type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;
export { MessageAttachments };
// A pane can remount before its new-chat request returns; keep creation with the window-owned draft session.
const draftConversationRequestsBySession = new WeakMap<ComposerSession, Map<string, Promise<Conversation>>>();
export type Notice = {
  tone: 'error' | 'success' | 'info';
  onDismiss?: () => Promise<void>;
  message: string;
  /** A temporary API-busy warning clears when that account can be edited again. */
  resolveWhenApiIdle?: string;
  /** Names people chose, filled into the message's {0}, {1}… as written (never translated). */
  names?: readonly string[];
  action?: { label: string; run: () => unknown };
  secondaryAction?: { label: string; run: () => unknown };
};
export type Notify = (notice: Notice) => void;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const live = isActiveWorkflow;
/** One line on a task card in review mode: what the automatic reviewer decided and what happens next. */
function reviewLabel(workflow: Workflow): string | undefined {
  const review = workflow.review;
  if (review?.factCheck) return undefined;
  if (!review) return workflow.input.review && !workflow.delegation ? '完成后自动核验' : undefined;
  const round = review.round ? `（第 ${review.round + 1} 轮）` : '';
  switch (review.status) {
    case 'queued':
      return `核验后的自动修正${round}，完成后再次核验`;
    case 'reviewing':
      return `正在独立核验${round}`;
    case 'passed':
      return `核验通过${review.reason ? `：${review.reason}` : ''}`;
    case 'fixing':
      return `核验未通过，已自动${review.verdict === 'stronger' ? '换用更强的推理重做' : '按意见修改'}${review.reason ? `：${review.reason}` : ''}`;
    case 'stopped':
      return `核验结束${review.reason ? `：${review.reason}` : ''}`;
  }
}

export type GrokHistorySyncResult = {
  conversationId: string;
  sessions: number;
  addedMessages: number;
  retainedMessages: number;
  incompleteLines: number;
  changed: boolean;
  warnings: string[];
};

export async function syncWorkspaceGrokHistory(api: Api, projectId: string) {
  const result = await api<GrokHistorySyncResult>(
    `/api/projects/${encodeURIComponent(projectId)}/grok-history/sync`,
    {},
    'POST',
  );
  try {
    const history = await api<{ messages: ConversationMessage[]; workflows?: Workflow[] }>(
      `/api/conversations/${encodeURIComponent(result.conversationId)}`,
      undefined,
      'GET',
    );
    return { result, messages: history.messages, workflows: history.workflows ?? [] };
  } catch (error) {
    throw new Error(`Grok 记录已同步，但完整历史读取失败：${errorText(error)}`);
  }
}

export function GrokHistorySync({
  conversation,
  pending = false,
  result,
  error,
  onSync,
}: {
  conversation?: Conversation;
  pending?: boolean;
  result?: GrokHistorySyncResult;
  error?: string;
  onSync: () => void;
}) {
  const history = conversation?.grokHistory;
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    if (!result) return;
    setAnnounce(true);
    const timer = setTimeout(() => setAnnounce(false), 6000);
    return () => clearTimeout(timer);
  }, [result]);
  if (!history) return null;
  return (
    <div className={`toolbar-item ${error ? 'toolbar-error' : ''}`}>
      <button
        type="button"
        className="toolbar-button"
        aria-label={pending ? '正在同步 Grok 记录…' : '同步 Grok 记录'}
        disabled={pending}
        aria-busy={pending}
        onClick={onSync}
      >
        <RefreshCw size={15} className={pending ? 'spinning' : ''} />
      </button>
      <div className={`toolbar-tip ${error || announce ? 'show' : ''}`}>
        <strong>{pending ? '正在同步 Grok 记录…' : '同步 Grok 记录'}</strong>
        <small>
          上次同步 <time dateTime={history.syncedAt}>{queueDate(history.syncedAt)}</time> · {history.sessions} 个会话 ·{' '}
          {history.messages} 条记录
        </small>
        {result && (
          <small role="status">
            {result.changed ? `新增 ${result.addedMessages} 条记录` : '记录没有变化'} · 保留 {result.retainedMessages}{' '}
            条消息
            {result.incompleteLines > 0 && ` · 暂跳过 ${result.incompleteLines} 行未完成记录`}
          </small>
        )}
        {result?.warnings.length ? <small role="status">{result.warnings.join(' ')}</small> : null}
        {error && <small role="alert">{error}</small>}
      </div>
    </div>
  );
}

const routingProfilePrefix = 'routing-profile:';
const projectRoutingChoice = 'routing-project-default';

/** Native account IDs are the only values passed as runtimeId to the server. */
export function workspaceRouteFields(selection: string): { runtimeId?: string } {
  return selection ? { runtimeId: selection } : {};
}

export function workspaceExecutionSelection(
  state: Pick<AppState, 'targets' | 'runtimes'>,
  policy: MessageInput['executionPolicy'],
  selection: string,
) {
  const targets = availableCoreTargets(state.targets, policy);
  const chosenRuntime = state.runtimes.find((runtime) => runtime.id === selection);
  const unavailable = Boolean(selection && !targets.some((target) => target.id === selection));
  return {
    targets,
    chosenRuntime,
    models: chosenRuntime ? chosenRuntime.models.map((model) => ({ ...model, efforts: [...model.efforts] })) : [],
    /** Image and video models, listed in their own groups; they never enter text routing. */
    mediaModels: chosenRuntime?.mediaModels ?? [],
    unavailable,
    label: unavailable ? unavailableRuntimeLabel(state, selection) : chosenRuntime?.label,
  };
}

const modelGroupLabel = (modality: ModelModality) =>
  currentLocale() === 'en' ? modelGroupLabelsEn[modality] : modelGroupLabels[modality];

type NavigatorRoute = NonNullable<Conversation['navigatorRoute']>;

/** "Opus 5.5 · High": the saved Navigator route as the chip and the menu show it; nothing when automatic. */
export function navigatorRouteLabel(state: Pick<AppState, 'runtimes'>, route: NavigatorRoute | undefined) {
  if (!route) return undefined;
  const runtime = state.runtimes.find((item) => item.id === route.runtimeId);
  const name = runtime?.models.find((item) => item.id === route.model)?.label ?? route.model ?? runtime?.label;
  return (
    <>
      <span translate="no">{name ?? route.runtimeId}</span>
      {route.effort && <> · {effortName(route.effort)}</>}
    </>
  );
}

/**
 * Navigator › Runs on: the same executor, model and effort controls as a message's route, saved on the chat. A
 * card that cannot take a turn is re-routed with a note, so nothing here ever blocks.
 */
export function NavigatorRoutePopover({
  state,
  policy,
  route,
  onChange,
  popoverRef,
}: {
  state: Pick<AppState, 'targets' | 'runtimes'>;
  policy: MessageInput['executionPolicy'];
  route: NavigatorRoute | undefined;
  onChange: (route: NavigatorRoute | null) => void;
  popoverRef?: RefObject<HTMLDivElement | null>;
}) {
  const runtime = state.runtimes.find((item) => item.id === route?.runtimeId);
  const efforts = composerEfforts(runtime, route?.model ?? '');
  return (
    <div
      className="composer-popover route-popover navigator-route-popover"
      ref={popoverRef}
      role="dialog"
      aria-label="领航员使用"
    >
      <p className="composer-menu-hint">领航员使用的执行器；不可用时自动改派，并在记录里说明</p>
      <div className="composer-chips">
        <WorkspaceExecutionFields
          state={state}
          policy={policy}
          selection={route?.runtimeId ?? ''}
          model={route?.model ?? ''}
          onSelection={(value) => onChange(value ? { runtimeId: value } : null)}
          onModel={(value) => route && onChange({ runtimeId: route.runtimeId, ...(value ? { model: value } : {}) })}
        >
          {route && efforts.levels.length > 0 && (
            <EffortSlider
              levels={efforts.levels}
              title={efforts.title}
              value={route.effort ?? ''}
              onChange={(value) =>
                onChange({
                  runtimeId: route.runtimeId,
                  ...(route.model ? { model: route.model } : {}),
                  ...(value ? { effort: value } : {}),
                })
              }
            />
          )}
        </WorkspaceExecutionFields>
      </div>
    </div>
  );
}

/** Compact chips, left to right in choice order: executor, then model once an executor is chosen, then children. */
export function WorkspaceExecutionFields({
  state,
  policy,
  selection,
  model,
  onSelection,
  onModel,
  disabled = false,
  children,
  onModelsOpen,
  routingProfiles = [],
  routingProfileId,
  inheritProjectRouting = false,
  projectRoutingLabel,
}: {
  state: Pick<AppState, 'targets' | 'runtimes'>;
  policy: MessageInput['executionPolicy'];
  selection: string;
  model: string;
  onSelection: (value: string) => void;
  onModel: (value: string) => void;
  disabled?: boolean;
  children?: ReactNode;
  onModelsOpen?: () => void;
  routingProfiles?: RoutingProfile[];
  routingProfileId?: string;
  inheritProjectRouting?: boolean;
  projectRoutingLabel?: string;
}) {
  const choice = workspaceExecutionSelection(state, policy, selection);
  const selectedModel = cursorModelForPin(choice.models, model);
  // A long list keeps older generations and dated snapshots in a collapsed More models group.
  const textModels = splitOlderModels(choice.models);
  return (
    <>
      <ChipSelect
        label="执行器"
        ariaLabel="任务执行器"
        value={
          inheritProjectRouting && !selection
            ? projectRoutingChoice
            : routingProfileId
              ? `${routingProfilePrefix}${routingProfileId}`
              : selection
        }
        disabled={disabled}
        onChange={onSelection}
        groupMemory="executor"
      >
        {projectRoutingLabel && <option value={projectRoutingChoice}>{`项目默认（${projectRoutingLabel}）`}</option>}
        <option value="">{projectRoutingLabel ? '自动（全局与对话规则）' : '自动'}</option>
        {!!routingProfiles.length && (
          <optgroup label="自定义路由" data-group="routes">
            {routingProfiles.map((profile) => (
              <option key={profile.id} value={`${routingProfilePrefix}${profile.id}`}>
                {profile.name}
              </option>
            ))}
          </optgroup>
        )}
        {routingProfileId && !routingProfiles.some((profile) => profile.id === routingProfileId) && (
          <option value={`${routingProfilePrefix}${routingProfileId}`} disabled>
            路由方案不可用
          </option>
        )}
        {choice.unavailable && (
          <option value={selection} disabled>
            {choice.label}
          </option>
        )}
        {(['cli', 'api'] as const).map((group) => {
          const targets = choice.targets.filter((target) => executorGroup(target.provider) === group);
          return targets.length ? (
            <optgroup key={group} label={executorGroupLabels[group]} data-group={group}>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </ChipSelect>
      {selection && (
        <ChipSelect
          label="模型"
          ariaLabel="任务模型"
          onOpen={onModelsOpen}
          value={model}
          disabled={disabled || choice.unavailable}
          onChange={onModel}
          groupMemory={`model.${selection}`}
        >
          <option value="">自动</option>
          {model &&
            !choice.models.some((item) => item.id === model) &&
            !choice.mediaModels.some((item) => item.id === model) && (
              <option value={model}>{selectedModel?.label ?? model}</option>
            )}
          {/* Text, More models, Image, Video; a group with no models is hidden (a Codex card lists Text only). */}
          {(
            [
              ['text', modelGroupLabel('text'), textModels.current, undefined],
              ['text-more', '更多模型', textModels.older, '更早一代的模型和带日期的快照版本'],
            ] as const
          ).map(([group, groupLabel, listed, groupTitle]) =>
            listed.length ? (
              <optgroup key={group} label={groupLabel} data-group={group} title={groupTitle}>
                {listed.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    data-discovered={item.discovered}
                    title={item.discovered ? newModelTitle : undefined}
                  >
                    {item.label}
                    {item.quotaPool ? ` · ${cursorModelPoolLabel(item.quotaPool)}` : ''}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
          {(['image', 'video'] as const).map((modality) => {
            const listed = choice.mediaModels.filter((item) => item.modality === modality);
            return listed.length ? (
              <optgroup key={modality} label={modelGroupLabel(modality)} data-group={modality}>
                {listed.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={item.unsupported}
                    title={item.unsupported ? unsupportedMediaTitle[modality] : undefined}
                  >
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </ChipSelect>
      )}
      {children}
    </>
  );
}

/** Replies render as Markdown: headings, lists, tables, links and code. */
const MessageText = memo(function MessageText({ text }: { text: string }) {
  const relativePaths = useProjectPaths();
  return (
    <div className="message-text markdown" data-path-scope>
      {renderMarkdown(text, { relativePaths: relativePaths || undefined })}
    </div>
  );
});

export function ProjectDialog({
  defaultPath,
  api,
  onClose,
  onCreated,
  notify,
}: {
  defaultPath: string;
  api: Api;
  onClose: () => void;
  onCreated: (project: Project) => void;
  notify: Notify;
}) {
  const [path, setPath] = useState(defaultPath);
  const [name, setName] = useState('');
  const [createDirectory, setCreateDirectory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState('');
  const pickerPending = useRef(false);
  const ref = useRef<HTMLDialogElement>(null);
  const desktop = desktopBridge();
  const busy = saving || picking;
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function pickDirectory() {
    if (!desktop || saving || pickerPending.current) return;
    pickerPending.current = true;
    setPicking(true);
    setPickError('');
    try {
      const selected = await desktop.pickDirectory();
      if (typeof selected === 'string' && selected.trim()) setPath(selected);
    } catch (error) {
      setPickError(`无法选择文件夹：${errorText(error)}。请重试或手动输入路径。`);
    } finally {
      pickerPending.current = false;
      setPicking(false);
    }
  }
  async function submit() {
    if (saving || pickerPending.current || !path.trim()) return;
    setSaving(true);
    try {
      const project = await api<Project>('/api/projects', {
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        createDirectory,
      });
      onCreated(project);
      onClose();
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="native-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-title">
          <h2>添加项目</h2>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭添加项目">
            <X size={18} />
          </button>
        </div>
        <p>连接一个本地文件夹，让对话、文件与项目记忆留在一起。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor="project-directory-path">文件夹绝对路径</label>
            <div className="project-directory-row">
              <input
                id="project-directory-path"
                aria-label="项目文件夹路径"
                autoFocus
                required
                value={path}
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
                placeholder="C:\Projects\my-project"
                spellCheck={false}
              />
              {desktop && (
                <button
                  type="button"
                  className="button secondary"
                  aria-label="选择项目文件夹"
                  disabled={busy}
                  onClick={() => void pickDirectory()}
                >
                  {picking ? <Loader2 className="spinning" size={15} /> : <FolderOpen size={15} />}
                  {picking ? '正在选择…' : '选择文件夹'}
                </button>
              )}
            </div>
          </div>
          {pickError && (
            <p className="directory-picker-error" role="alert">
              {pickError}
            </p>
          )}
          <label className="field">
            <span>
              项目名称 <small>可选</small>
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="默认使用文件夹名称"
              maxLength={120}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={createDirectory}
              onChange={(event) => setCreateDirectory(event.target.checked)}
            />
            <span>文件夹不存在时创建它</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button className="button primary" disabled={busy || !path.trim()}>
              {saving ? <Loader2 className="spinning" size={15} /> : <Plus size={15} />}添加项目
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

/** Which CLIs read a generated pointer file, so a `.claude` path does not look like Claude-only memory. */
function ruleReader(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'agents.md') return '供 Grok、Codex、Cursor 读取';
  if (name === 'agents.override.md') return '供 Codex 读取';
  return name === 'claude.md' || /[\\/]\.claude[\\/]/i.test(path) ? '供 Claude Code 读取（Claude 不读 AGENTS.md）' : '';
}

export function LocalMemoryControls({
  settings,
  exportEnabled,
  cliEnabled,
  saving,
  onExport,
  onCli,
  onCleanup,
}: {
  settings: LocalMemorySettings;
  exportEnabled: boolean;
  cliEnabled: boolean;
  saving: boolean;
  onExport: (value: boolean) => void;
  onCli: (value: boolean) => void;
  onCleanup: () => void;
}) {
  return (
    <details className="target-advanced">
      <summary>高级设置：本地历史与 CLI 记忆</summary>
      <fieldset className="local-memory-settings" disabled={saving}>
        <legend>本地历史与 CLI 记忆</legend>
        <p>
          上面的项目规则和项目记忆对所有执行器通用。这里只管：在项目外直接打开 Grok、Codex、Claude 等 CLI
          时，能不能查到以前的对话。
        </p>
        <label>
          <input type="checkbox" checked={exportEnabled} onChange={(event) => onExport(event.target.checked)} />
          在应用数据目录保存完整历史副本
        </label>
        <p>完整历史以明文保存在应用目录，不写入项目；关闭只停止更新，已有记录保留。</p>
        <label>
          <input
            type="checkbox"
            checked={cliEnabled}
            disabled={!exportEnabled}
            onChange={(event) => onCli(event.target.checked)}
          />
          为此项目启用 CLI 记忆
        </label>
        <p>
          默认关闭。开启后在项目里加入 .comborunner 索引和 AGENTS.md 指引，让 CLI 能查到以前的对话；会产生 Git
          改动，关闭后自动清理。
        </p>
        <p>目录在 OneDrive、Dropbox 等同步盘时会同步到云端。</p>
        <dl>
          <dt>应用数据目录</dt>
          <dd>
            <code>{settings.dataDirectory}</code>
          </dd>
          <dt>完整历史副本</dt>
          <dd>
            <code>{settings.archiveDirectory}</code>
          </dd>
          <dt>项目路径索引</dt>
          <dd>
            <code>{settings.projectDirectory}</code>
          </dd>
        </dl>
        {settings.files.length > 0 && (
          <div>
            <p>本次修改的指引文件</p>
            <ul>
              {settings.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                  {ruleReader(path) && <small className="rule-reader"> · {ruleReader(path)}</small>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(settings.legacyFiles?.length ?? 0) > 0 && (
          <div>
            <p>发现旧版指引；清理只移除完整且可识别的生成内容，保留用户规则。</p>
            <ul>
              {settings.legacyFiles?.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            <button className="button secondary" onClick={onCleanup}>
              清理旧 CLI 指引并关闭
            </button>
          </div>
        )}
        {settings.warnings.length > 0 && (
          <div className="inline-error" role="status">
            <ul>
              {settings.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
    </details>
  );
}

export function ProjectTrustControl({
  trusted,
  disabled,
  onChange,
}: {
  trusted: boolean;
  disabled: boolean;
  onChange: (trusted: boolean) => void;
}) {
  return (
    <div className="local-memory-settings">
      <label>
        <input
          type="checkbox"
          checked={trusted}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        信任此项目（Codex 不使用沙箱）
      </label>
      <p>在你自己的项目里，测试可以开端口、联网；别人的文字和只读任务不受影响</p>
    </div>
  );
}

export function ProjectMcpControl({
  servers,
  selected,
  disabled,
  onChange,
}: {
  servers: Pick<ExtensionView, 'id' | 'name' | 'enabled'>[];
  selected?: string[];
  disabled: boolean;
  onChange: (ids: string[] | undefined) => void;
}) {
  const id = useId();
  const effective = servers.filter((server) => server.enabled && (!selected || selected.includes(server.id)));
  const missing = selected?.filter((key) => !servers.some((server) => server.id === key)) ?? [];
  return (
    <fieldset className="local-memory-settings" disabled={disabled}>
      <legend>项目 MCP 工具</legend>
      <label htmlFor={id}>使用范围</label>
      <select
        id={id}
        value={selected === undefined ? 'inherit' : 'selected'}
        onChange={(event) =>
          onChange(
            event.target.value === 'inherit'
              ? undefined
              : servers.filter((server) => server.enabled).map((server) => server.id),
          )
        }
      >
        <option value="inherit">继承全局已启用的 MCP</option>
        <option value="selected">仅使用本项目选择的 MCP</option>
      </select>
      <p>全局启用后，本项目的选择才会生效；不影响技能设置。</p>
      <p>当前生效：{effective.map((server) => server.name).join('、') || '无'}</p>
      <button type="button" className="button secondary" onClick={() => onChange([])}>
        禁用本项目全部 MCP
      </button>
      {selected !== undefined && selected.length === 0 && <p>本项目已禁用全部 MCP。</p>}
      {servers.map((server) => (
        <label key={server.id}>
          <input
            type="checkbox"
            disabled={selected === undefined}
            checked={selected?.includes(server.id) ?? server.enabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...(selected ?? []), server.id].sort()
                  : selected?.filter((key) => key !== server.id),
              )
            }
          />
          {server.name}
          {!server.enabled && <small>（全局已停用，当前不生效）</small>}
        </label>
      ))}
      {missing.map((key) => (
        <label key={key}>
          <input type="checkbox" checked onChange={() => onChange(selected?.filter((value) => value !== key))} />
          {key} <small>（已卸载，请取消选择）</small>
        </label>
      ))}
    </fieldset>
  );
}

/** Project rules, project memory and local history settings; used by the memory dialog and the conversation panel. */
export function MemoryEditor({
  project,
  api,
  notify,
  onCancel,
  onSavingChange,
  autoFocus = true,
}: {
  project: Project;
  api: Api;
  notify: Notify;
  onCancel?: () => void;
  onSavingChange?: (saving: boolean) => void;
  autoFocus?: boolean;
}) {
  const [memory, setMemory] = useState<ProjectMemory>();
  const [localMemory, setLocalMemory] = useState<LocalMemorySettings>();
  const [exportEnabled, setExportEnabled] = useState(true);
  const [cliEnabled, setCliEnabled] = useState(false);
  const [trusted, setTrusted] = useState(project.trusted === true);
  const [githubConnected, setGithubConnected] = useState(false);
  const [savedRouting, setSavedRouting] = useState(project.routingProfileId ?? '');
  const [routingProfileId, setRoutingProfileId] = useState(savedRouting);
  useEffect(() => {
    setSavedRouting(project.routingProfileId ?? '');
    setRoutingProfileId(project.routingProfileId ?? '');
  }, [project.id, project.routingProfileId]);
  useEffect(() => {
    let active = true;
    setGithubConnected(false);
    if (project.scope !== 'chat')
      void api<GitHubStatus>('/api/github', undefined, 'GET')
        .then((status) => {
          if (active) setGithubConnected(status.enabled && status.state === 'connected');
        })
        .catch(() => {
          if (active) setGithubConnected(false);
        });
    return () => {
      active = false;
    };
  }, [api, project.id, project.scope]);
  useEffect(() => setTrusted(project.trusted === true), [project.id, project.trusted]);
  const savedMcp = JSON.stringify(project.mcpServers ?? null);
  const [mcpServers, setMcpServers] = useState<string[] | undefined>(project.mcpServers);
  const [extensions, setExtensions] = useState<ExtensionView[]>();
  const [mcpLoadError, setMcpLoadError] = useState('');
  const [mcpReload, setMcpReload] = useState(0);
  useEffect(() => setMcpServers(JSON.parse(savedMcp) ?? undefined), [project.id, savedMcp]);
  const mcpChanged = JSON.stringify(mcpServers ?? null) !== savedMcp;
  useEffect(() => {
    let mounted = true;
    setExtensions(undefined);
    setMcpLoadError('');
    void api<{ items: ExtensionView[] }>('/api/extensions', undefined, 'GET')
      .then((installed) => {
        if (mounted) setExtensions(installed.items);
      })
      .catch((error) => {
        if (mounted) setMcpLoadError(errorText(error));
      });
    return () => {
      mounted = false;
    };
  }, [project.id, api, mcpReload]);
  const [content, setContent] = useState('');
  const savedRules = (project.rules ?? []).join('\n');
  const [rules, setRules] = useState(savedRules);
  const savedGates = formatGateLines(project.gates);
  const [gatesText, setGatesText] = useState(savedGates);
  const [gateErrors, setGateErrors] = useState<GateLineError[]>([]);
  useEffect(() => {
    setGatesText(savedGates);
    setGateErrors([]);
  }, [project.id, savedGates]);
  const [saving, setSavingState] = useState(false);
  const saveRequest = useRef<symbol | undefined>(undefined);
  const editorProject = useRef(project.id);
  editorProject.current = project.id;
  useEffect(() => {
    saveRequest.current = undefined;
    setSavingState(false);
    return () => {
      saveRequest.current = undefined;
    };
  }, [project.id]);
  const [loadError, setLoadError] = useState('');
  useUiUpdateBlocker(() => saving || !!saveRequest.current || routingProfileId !== savedRouting, 'project-routing');
  const setSaving = (value: boolean) => {
    setSavingState(value);
    onSavingChange?.(value);
  };
  useEffect(() => {
    let mounted = true;
    setMemory(undefined);
    setLocalMemory(undefined);
    setLoadError('');
    void Promise.all([
      api<ProjectMemory>(`/api/projects/${project.id}/memory`, undefined, 'GET'),
      api<LocalMemorySettings>(`/api/projects/${project.id}/local-memory`, undefined, 'GET'),
    ])
      .then(([value, settings]) => {
        if (mounted) {
          setMemory(value);
          setContent(value.content);
          setLocalMemory(settings);
          setExportEnabled(settings.exportEnabled);
          setCliEnabled(settings.cliEnabled);
        }
      })
      .catch((error) => {
        if (mounted) setLoadError(errorText(error));
      });
    return () => {
      mounted = false;
    };
  }, [project.id, api]);
  async function save() {
    if (!memory || !localMemory || saveRequest.current) return;
    const parsed = project.scope !== 'chat' ? parseGateLines(gatesText) : undefined;
    if (parsed?.errors.length) {
      setGateErrors(parsed.errors);
      return;
    }
    const request = Symbol(project.id);
    saveRequest.current = request;
    const current = () => editorProject.current === project.id && saveRequest.current === request;
    setSaving(true);
    let gatesCancelled = false;
    try {
      if (project.scope !== 'chat' && routingProfileId !== savedRouting) {
        const saved = await api<Project>(
          `/api/projects/${encodeURIComponent(project.id)}/routing-profile`,
          { profileId: routingProfileId || null },
          'PATCH',
        );
        if (!current()) return;
        if (saved.id !== project.id) throw new Error('服务器返回了其他项目的设置，请刷新核对。');
        setSavedRouting(saved.routingProfileId ?? '');
        setRoutingProfileId(saved.routingProfileId ?? '');
      }
      if (mcpChanged && extensions)
        await api(`/api/projects/${project.id}`, { mcpServers: mcpServers ?? null }, 'PATCH');
      if (trusted !== (project.trusted === true)) {
        if (trusted) {
          const change = desktopBridge()?.changePermission;
          if (!change) throw new Error('请在桌面应用中修改权限。');
          if (!(await change({ kind: 'project', id: project.id, trusted }))) setTrusted(false);
        } else await api(`/api/projects/${project.id}`, { trusted: false }, 'PATCH');
      }
      if (rules !== savedRules) await api(`/api/projects/${project.id}/rules`, { rules: rules.split('\n') }, 'PATCH');
      if (content !== memory.content) {
        const next = await api<ProjectMemory>(
          `/api/projects/${project.id}/memory`,
          { content, revision: memory.revision },
          'PATCH',
        );
        setMemory(next);
      }
      if (exportEnabled !== localMemory.exportEnabled || cliEnabled !== localMemory.cliEnabled) {
        const settings = await api<LocalMemorySettings>(
          `/api/projects/${project.id}/local-memory`,
          { exportEnabled, cliEnabled },
          'PATCH',
        );
        setLocalMemory(settings);
        setExportEnabled(settings.exportEnabled);
        setCliEnabled(settings.cliEnabled);
      }
      // Last, so a refused or cancelled rule change leaves everything above saved.
      if (parsed?.gates && gatesText !== savedGates) {
        if (gateLoosening(project.gates, normalizeGates(parsed.gates)).length) {
          const change = desktopBridge()?.changePermission;
          if (!change) throw new Error('请在桌面应用中修改权限。');
          if (!(await change({ kind: 'project-gates', projectId: project.id, gates: parsed.gates })))
            gatesCancelled = true;
        } else await api(`/api/projects/${project.id}/gates`, { gates: parsed.gates }, 'PATCH');
        if (!gatesCancelled) setGatesText(formatGateLines(normalizeGates(parsed.gates)));
      }
      if (!current()) return;
      notify({
        tone: gatesCancelled ? 'info' : 'success',
        message: gatesCancelled ? '其他设置已保存，GitHub 规则未改。' : '项目记忆已保存，将从下一条消息开始使用。',
      });
    } catch (error) {
      if (current()) notify({ tone: 'error', message: errorText(error) });
    } finally {
      if (current()) {
        saveRequest.current = undefined;
        setSaving(false);
      }
    }
  }
  async function cleanLegacy() {
    setSaving(true);
    try {
      const settings = await api<LocalMemorySettings>(
        `/api/projects/${project.id}/local-memory`,
        { cliEnabled: false },
        'PATCH',
      );
      setLocalMemory(settings);
      setCliEnabled(settings.cliEnabled);
      notify({
        tone: settings.warnings.length ? 'info' : 'success',
        message: '已检查并清理旧 CLI 指引，请查看文件与提示。',
      });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setSaving(false);
    }
  }
  if (loadError) return <div className="inline-error">{loadError}</div>;
  if (!memory || !localMemory)
    return (
      <div className="dialog-loading">
        <Loader2 className="spinning" size={18} />
        读取记忆…
      </div>
    );
  return (
    <>
      <label className="memory-rules-label" htmlFor={`project-rules-${project.id}`}>
        项目规则 <small>一行一条。每个任务都会遵守；开启核验模式时会逐条检查改动，违反就打回重做。</small>
      </label>
      <textarea
        id={`project-rules-${project.id}`}
        className="memory-rules"
        value={rules}
        onChange={(event) => setRules(event.target.value)}
        rows={4}
        placeholder={'例如：游戏引擎不准引用界面代码\n改了规则必须补上对应的测试'}
      />
      {project.scope !== 'chat' && githubConnected && (
        <>
          <label className="memory-rules-label" htmlFor={`project-gates-${project.id}`}>
            GitHub 规则 <small>一行一条，写 GitHub 时强制执行</small>
          </label>
          <textarea
            id={`project-gates-${project.id}`}
            className="memory-rules"
            rows={7}
            placeholder={'no-merge 22:00-07:00\nauthor name@example.com ask\nallow label\nblock label'}
            spellCheck={false}
            aria-invalid={gateErrors.length > 0}
            value={gatesText}
            onChange={(event) => {
              setGatesText(event.target.value);
              if (gateErrors.length) setGateErrors(parseGateLines(event.target.value).errors);
            }}
          />
          {gateErrors.length > 0 && (
            <div role="alert">
              {gateErrors.slice(0, 3).map((error, index) => (
                <p key={index} className="inline-error">
                  {error.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      <label className="memory-rules-label" htmlFor={`project-memory-${project.id}`}>
        项目记忆
      </label>
      <textarea
        id={`project-memory-${project.id}`}
        autoFocus={autoFocus}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        maxLength={20000}
        rows={14}
        placeholder="例如：使用 TypeScript；界面保持简洁；运行 npm test 验证修改。"
      />
      {content.length >= 18000 && (
        <div className="memory-meta">
          <span>{content.length.toLocaleString()} / 20,000</span>
        </div>
      )}
      <LocalMemoryControls
        settings={localMemory}
        exportEnabled={exportEnabled}
        cliEnabled={cliEnabled}
        saving={saving}
        onExport={(value) => {
          setExportEnabled(value);
          if (!value) setCliEnabled(false);
        }}
        onCli={setCliEnabled}
        onCleanup={() => void cleanLegacy()}
      />
      <details className="memory-advanced">
        <summary>高级</summary>
        {extensions ? (
          <ProjectMcpControl
            servers={extensions.filter((item) => item.kind === 'mcp')}
            selected={mcpServers}
            disabled={saving}
            onChange={setMcpServers}
          />
        ) : (
          <div className="local-memory-settings">
            <strong>项目 MCP 工具</strong>
            {mcpLoadError ? (
              <>
                <p role="alert">MCP 列表暂时无法读取，项目选择未更改。可继续编辑项目记忆。</p>
                <p>{mcpLoadError}</p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={saving}
                  onClick={() => setMcpReload((value) => value + 1)}
                >
                  重试读取 MCP 列表
                </button>
              </>
            ) : (
              <p>正在读取 MCP 列表…</p>
            )}
          </div>
        )}
        {project.scope !== 'chat' && <ProjectTrustControl trusted={trusted} disabled={saving} onChange={setTrusted} />}
        {project.scope !== 'chat' && (
          <ProjectRoutingDefault
            key={project.id}
            project={project}
            api={api}
            selected={routingProfileId}
            onChange={setRoutingProfileId}
            disabled={saving}
          />
        )}
      </details>
      <div className="dialog-actions">
        {onCancel && (
          <button className="button secondary" onClick={onCancel}>
            取消
          </button>
        )}
        <button
          className="button primary"
          disabled={
            saving ||
            (content === memory.content &&
              rules === savedRules &&
              (project.scope === 'chat' || gatesText === savedGates) &&
              (!mcpChanged || !extensions) &&
              trusted === (project.trusted === true) &&
              routingProfileId === savedRouting &&
              exportEnabled === localMemory.exportEnabled &&
              cliEnabled === localMemory.cliEnabled)
          }
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="spinning" size={15} /> : <Check size={15} />}保存记忆与设置
        </button>
      </div>
    </>
  );
}

export function MemoryDialog({
  project,
  api,
  notify,
  onClose,
}: {
  project: Project;
  api: Api;
  notify: Notify;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [pane, setPane] = useState<'owner' | 'auto'>('owner');
  const [autoView, setAutoView] = useState<MemoryAutoView>();
  const [autoError, setAutoError] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  useEffect(() => {
    if (pane !== 'auto') return;
    let live = true;
    const refresh = () =>
      api<MemoryAutoView>('/api/projects/' + project.id + '/memory-auto')
        .then((view) => {
          if (live) {
            setAutoView(view);
            setAutoError('');
          }
        })
        .catch((error) => {
          if (live) setAutoError(errorText(error));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pane, project.id, api]);
  async function changeAuto(method: 'POST' | 'DELETE') {
    setAutoBusy(true);
    try {
      setAutoView(await api<MemoryAutoView>('/api/projects/' + project.id + '/memory-auto', {}, method));
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setAutoBusy(false);
    }
  }
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="native-dialog memory-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-title">
          <h2>{project.name} · 项目记忆</h2>
          <button className="icon-button" aria-label="关闭项目记忆" onClick={onClose} disabled={saving}>
            <X size={18} />
          </button>
        </div>
        <p>记录项目目标、约定与偏好。每次问答和创建都会带上这份记忆。</p>
        <MemoryTabs value={pane} disabled={saving} onChange={setPane} />
        <div role="tabpanel" aria-label="我写的" hidden={pane !== 'owner'}>
          <MemoryEditor
            key={project.id}
            project={project}
            api={api}
            notify={notify}
            onCancel={onClose}
            onSavingChange={setSaving}
          />
        </div>
        <div role="tabpanel" aria-label="自动整理" hidden={pane !== 'auto'}>
          {autoError && <p className="inline-error">{autoError}</p>}
          {autoView ? (
            <MemoryAutoPanel
              view={autoView}
              busy={autoBusy}
              onRun={() => void changeAuto('POST')}
              onClear={() => void changeAuto('DELETE')}
            />
          ) : (
            <p>读取记忆…</p>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** A task that is only waiting for a local background job: live progress, and no error styling. */
function BackgroundWait({ workflow, state }: { workflow: Workflow; state: AppState }) {
  const wait = workflow.waitingOn!;
  const task = state.backgroundTasks?.find((item) => item.id === wait.jobId);
  const done = (task?.done ?? wait.done).toLocaleString(),
    total = (task?.total ?? wait.total).toLocaleString();
  return (
    <div className="workflow-waiting">
      <p>
        {task?.state === 'paused'
          ? `后台的本地媒体比对已暂停（${done} / ${total}）。在下方后台任务栏点「继续」，跑完后这个任务会自动接着做。`
          : `在等后台的本地媒体比对跑完（${task?.steps ? `${task.detail}，` : ''}${done} / ${total}${
              task?.remainingSeconds !== undefined ? `，${remainingLabel(task.remainingSeconds)}` : ''
            }）。跑完后会自动接着做，不用手动点继续。`}
      </p>
      {workflow.error && (
        <details>
          <summary>执行器这一轮的说明</summary>
          <p>{workflow.error}</p>
        </details>
      )}
    </div>
  );
}

type CachedWorkflowReply = { key: string; text: string };

function workflowReplyState(workflow: Workflow, latest?: RunRecord, stage?: SteeringStage, lastReplyAt?: string) {
  const stageEvents =
    stage && latest?.startedAt && Date.parse(latest.startedAt) < Date.parse(stage.at)
      ? latest.events.filter((event) => Date.parse(event.at) >= Date.parse(stage.at))
      : undefined;
  const streamOutput = stageEvents
    ? stageEvents
        .filter((event) => event.type === 'text')
        .map((event) => event.text ?? '')
        .join('')
    : latest?.output;
  const answerStep = workflow.plan.find((step) => step.id === latest?.stepId && step.runIds.includes(latest.id));
  const publicAnswerStep =
    answerStep &&
    (answerStep.id === 'reply' ||
      (workflow.plan.length > 1 &&
        answerStep === workflow.plan.at(-1) &&
        workflow.plan.every((step) => step === answerStep || ['completed', 'skipped'].includes(step.status))));
  const mainReply =
    !workflow.delegation &&
    workflow.input.mode !== 'build' &&
    ['running', 'waiting-approval', 'completed'].includes(workflow.status) &&
    ['execute', 'summarize'].includes(workflow.phase) &&
    workflow.selectionSwitch?.state !== 'switching' &&
    latest?.id === workflow.runIds.at(-1) &&
    latest?.workflowId === workflow.id &&
    publicAnswerStep &&
    (!workflow.activeStepId || workflow.activeStepId === answerStep.id) &&
    ['running', 'waiting-approval', 'completed'].includes(latest.status) &&
    Boolean(answerStep);
  const hasCurrentReply =
    lastReplyAt !== undefined &&
    Date.parse(lastReplyAt) >=
      Math.max(Date.parse(latest?.startedAt ?? workflow.createdAt), Date.parse(stage?.at ?? workflow.createdAt));
  const replyKey = JSON.stringify([workflow.id, latest?.id, stage?.id]);
  return { mainReply, hasCurrentReply, replyKey, streamOutput, stageEvents };
}

function rememberWorkflowReply(
  reply: ReturnType<typeof workflowReplyState>,
  latest: RunRecord | undefined,
  previous: CachedWorkflowReply | undefined,
): CachedWorkflowReply | undefined {
  if (!reply.mainReply || reply.hasCurrentReply) return undefined;
  if (latest?.summary) return previous?.key === reply.replyKey ? previous : undefined;
  return reply.streamOutput ? { key: reply.replyKey, text: reply.streamOutput } : undefined;
}

export function WorkflowTrace({
  workflow,
  state,
  api,
  notify,
  onInspect,
  onTrace,
  stage,
  onJumpMessage,
  sourceMessageIds,
  hasSystemNotice,
  lastReplyAt,
  cachedReply,
}: {
  workflow: Workflow;
  state: AppState;
  api: Api;
  notify: Notify;
  onInspect: (id: string) => void;
  onTrace?: () => void;
  stage?: SteeringStage;
  onJumpMessage?: (messageId: string) => void;
  sourceMessageIds?: ReadonlySet<string>;
  hasSystemNotice?: boolean;
  lastReplyAt?: string;
  cachedReply?: CachedWorkflowReply;
}) {
  state = useConversationPresentations(api, state, [workflow], stage ? [] : [workflow]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const lastDisplayedReply = useRef<CachedWorkflowReply | undefined>(undefined);
  const runs = workflow.runIds
    .map((id) => state.runs.find((run) => run.id === id && (!run.workflowId || run.workflowId === workflow.id)))
    .filter((run): run is RunRecord => Boolean(run));
  const latest = runs[runs.length - 1];
  const lastClaimRun = runs.filter((run) => run.taskOutcome?.claims?.length).at(-1);
  const lastClaimStep = lastClaimRun && workflow.plan.find((step) => step.runIds.includes(lastClaimRun.id));
  const reply = workflowReplyState(workflow, latest, stage, lastReplyAt);
  const { mainReply, hasCurrentReply, replyKey, streamOutput, stageEvents } = reply;
  const retainedReply = cachedReply?.key === replyKey ? cachedReply : lastDisplayedReply.current;
  // Completed-run broadcasts drop events and trim output before the saved message necessarily arrives.
  const publicReplyText = latest?.summary
    ? retainedReply?.key === replyKey
      ? retainedReply.text
      : undefined
    : streamOutput;
  useEffect(() => {
    lastDisplayedReply.current = rememberWorkflowReply(reply, latest, lastDisplayedReply.current);
  }, [mainReply, hasCurrentReply, replyKey, latest?.summary, streamOutput]);
  const displayStatus = workflowDisplayStatus(workflow, state.runs);
  const followUp = workflowFollowUp(workflow);
  const continuation = workflowContinuation(workflow);
  const softFileNote = workflow.status === 'completed' && workflow.fileChangeNotice;
  const showOutcome =
    !continuation &&
    (softFileNote || needsContinuation(workflow) || (workflow.status === 'cancelled' && workflow.stopped));
  const nextWorkflow = followUp
    ? state.workflows?.find(
        (item) => item.id === followUp.workflowId && item.conversationId === workflow.conversationId && !item.deletedAt,
      )
    : undefined;
  const waiting = isWaitingWorkflow(workflow);
  const queueSteeringRun = queuedSteeringRun(state, workflow);
  const confirmation =
    workflow.status === 'waiting-confirmation' && workflow.routingReview?.status === 'pending'
      ? workflow.routingReview
      : undefined;
  const proposedTarget = confirmation
    ? state.targets.find((target) => target.id === confirmation.proposal.runtimeId)
    : undefined;
  const risk = deadlineRiskLabel(workflow, Date.now());
  const readOnly = workflow.input.permissionMode === 'read-only';
  const origin = workflow.input.permissionOrigin ?? {
    mode: workflow.input.permissionMode,
    source: workflow.input.readOnlyTrigger || workflow.input.scopeNote ? ('text' as const) : ('user' as const),
    note: workflow.input.readOnlyTrigger || workflow.input.scopeNote,
  };
  const limitedChecks = verificationLimitedChecks(workflow, state.runs);
  const denied =
    !live(workflow) &&
    latest &&
    latest.id === workflow.runIds.at(-1) &&
    !['queued', 'running', 'waiting-approval'].includes(latest.status)
      ? [...latest.events].reverse().find((event) => event.data?.kind === 'native-denied')
      : undefined;
  const denialReason = typeof denied?.data?.reason === 'string' ? denied.data.reason : '额外权限请求';
  const deviceTask = !!workflow.input.deviceId && !workflow.delegation;
  const canRerunWrite =
    readOnly &&
    !live(workflow) &&
    !continuation &&
    !workflow.input.untrustedContent &&
    !workflow.input.untrustedQuotesOnly &&
    (deviceTask ||
      (Boolean(workflow.input.readOnlyTrigger) &&
        !workflow.input.deviceId &&
        !workflow.delegation?.agent?.deviceId &&
        !workflow.delegation?.agent?.externalAgentId &&
        !['scout', 'reviewer'].includes(workflow.delegation?.role ?? '') &&
        (!workflow.delegation ||
          state.workflows?.some(
            (parent) =>
              parent.id === workflow.delegation!.parentId &&
              parent.conversationId === workflow.conversationId &&
              parent.projectId === workflow.projectId &&
              !parent.stopped &&
              !parent.deletedAt &&
              parent.status !== 'cancelled' &&
              parent.input.permissionMode === 'workspace-write',
          )) &&
        (workflow.agentPreset?.permissionMode !== 'read-only' || workflow.input.agentPresetId === 'auto')));
  async function action(kind: 'cancel' | 'continue' | 'confirm' | 'delete' | 'steer' | 'rerun-write' | 'rerun-ask') {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (kind === 'steer') {
        await steerQueuedWorkflow(api, workflow.id);
        notify({ tone: 'success', message: '已插入当前任务，排队任务已移除，消息记录保留。' });
        return;
      }
      const result = await api<Workflow>(
        `/api/workflows/${workflow.id}${kind === 'delete' ? '' : `/${kind}`}`,
        kind === 'delete'
          ? undefined
          : kind === 'confirm'
            ? { proposalId: workflow.routingReview?.id }
            : kind === 'rerun-write'
              ? { permissionMode: 'workspace-write', permissionReauthorized: true, uiLocale: currentLocale() }
              : kind === 'continue' || kind === 'rerun-ask'
                ? { uiLocale: currentLocale() }
                : {},
        kind === 'delete' ? 'DELETE' : undefined,
      );
      if (kind === 'delete') notify({ tone: 'info', message: '任务已移除，聊天与执行记录保留。' });
      if (kind === 'rerun-write') notify({ tone: 'info', message: '已授权写入，正在重跑同一请求。' });
      if (kind === 'rerun-ask') notify({ tone: 'info', message: '已改为逐次确认，正在重跑同一请求。' });
      if (kind === 'confirm')
        notify({
          tone: 'info',
          message:
            result.status === 'queued'
              ? '已确认执行路径，等待资源检查后开始。'
              : '资源状态已变化，请查看更新后的建议。',
        });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  if (workflow.deletedAt) return null;
  const presentation = !stage && !continuation ? state.conversationPresentations?.[workflow.id] : undefined;
  return (
    <div
      id={`workflow-${workflow.id}`}
      className={`workflow-trace workflow-${workflow.status}${presentation ? ' has-turn-display' : ''}`}
    >
      {presentation && (
        <ConversationTurn
          workflow={workflow}
          runs={runs}
          projection={presentation}
          liveReply={
            workflow.status !== 'completed' && mainReply && !hasCurrentReply && latest && publicReplyText
              ? { runId: latest.id, text: publicReplyText }
              : undefined
          }
          targets={state.targets}
          loadDetail={() => api(`/api/workflows/${workflow.id}/presentation`)}
          inspect={(id, key) => {
            requestTurnInspection(id, key);
            onInspect(id);
          }}
          renderText={(text) => <MessageText text={text} />}
        />
      )}
      {(origin.source !== 'user' || canRerunWrite) && (
        <div className="workflow-read-only" role="status">
          <p>{permissionLine(origin)}</p>
          {canRerunWrite && (
            <button
              type="button"
              className="button tiny secondary"
              disabled={pending}
              onClick={() => void action('rerun-write')}
            >
              {pending ? <Loader2 size={12} className="spinning" /> : <RefreshCw size={12} />}
              按可写入重新执行
            </button>
          )}
          {canRerunWrite && deviceTask && (
            <p>{`将在设备「${state.conversationMessages?.find((message) => message.id === workflow.finalMessageId)?.device?.name ?? '设备'}」上以可写入重跑（可运行命令、改文件）`}</p>
          )}
        </div>
      )}
      {denied && (
        <div className="workflow-read-only" role="status">
          <p>{`Codex 自动模式拒绝了额外权限：${denialReason}`}</p>
          {!continuation && (
            <button
              type="button"
              className="button tiny secondary"
              disabled={pending}
              onClick={() => void action('rerun-ask')}
            >
              {pending ? <Loader2 size={12} className="spinning" /> : <RefreshCw size={12} />}
              按逐次确认重跑
            </button>
          )}
        </div>
      )}
      {limitedChecks.length > 0 && (
        <div className="workflow-verification-limited" role="status">
          <p>{`代码已改完；有 ${limitedChecks.length} 项检查在沙箱里没法运行，请在本机补跑`}</p>
          <details>
            <summary>查看受限检查</summary>
            <ul>
              {limitedChecks.map((check, index) => (
                <li key={`${check.id}-${index}`}>
                  <code translate="no">{check.command}</code>
                  <pre translate="no">{check.reason}</pre>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {workflow.delegation && <p className="delegation-label">{delegationLabel(workflow.delegation)}</p>}
      {workflow.delegation?.scope && (
        <p className="delegation-scope" title="这个子任务只改这些文件；范围重叠的子任务会排队">
          只改：{workflow.delegation.scope.map((entry) => entry || '整个项目').join('、')}
        </p>
      )}
      {workflow.delegation?.checkpoints?.length
        ? (() => {
            const last = workflow.delegation.checkpoints.at(-1)!;
            // Checkpoints are the agent's words: the tooltip listing them sits on protected text, with only
            // its "stuck on" wording translated.
            return (
              <p className={`delegation-progress ${last.blocker ? 'stuck' : ''}`}>
                <span>
                  进度：
                  <span
                    translate="no"
                    title={workflow.delegation.checkpoints
                      .map(
                        (item) =>
                          `${item.progress}${item.next ? ` → ${item.next}` : ''}${item.blocker ? withNames('（卡在：{0}）', [item.blocker]) : ''}`,
                      )
                      .join('\n')}
                  >
                    {last.progress}
                  </span>
                </span>
                {last.next ? (
                  <span>
                    下一步：<span translate="no">{last.next}</span>
                  </span>
                ) : null}
                {last.blocker ? (
                  <span>
                    卡在：<span translate="no">{last.blocker}</span>
                  </span>
                ) : null}
              </p>
            );
          })()
        : null}
      {workflow.delegation?.outOfScope?.length ? (
        <p className="delegation-scope outside" role="status">
          它运行期间，范围外有 {workflow.delegation.outOfScope.length} 个文件被改动：
          {workflow.delegation.outOfScope.slice(0, 6).join('、')}
          {workflow.delegation.outOfScope.length > 6 ? ' 等' : ''}
        </p>
      ) : null}
      {reviewLabel(workflow) && (
        <p className={`review-label review-${workflow.review?.status ?? 'queued'}`}>
          <ClipboardCheck size={12} />
          {reviewLabel(workflow)}
        </p>
      )}
      {workflow.status === 'waiting-confirmation' && workflow.planReview === 'pending' && (
        <PlanReview key={workflow.id} workflow={workflow} api={api} notify={notify} />
      )}
      <details open={Boolean(confirmation)}>
        <summary>
          {presentation ? (
            <span>任务详情</span>
          ) : (
            <>
              <span className="workflow-status">
                {['failed', 'interrupted', 'blocked'].includes(workflow.status) ? (
                  <AlertCircle size={14} className="workflow-status-failed" />
                ) : waiting && ['pending', 'wait'].includes(workflow.machineLoadChoice ?? '') ? (
                  <Loader2 size={14} className="spinning" />
                ) : waiting || workflow.status === 'waiting-approval' ? (
                  <Clock size={14} />
                ) : isExecutingWorkflow(workflow) ? (
                  <Loader2 size={14} className="spinning" />
                ) : displayStatus.verified ? (
                  <Check size={14} />
                ) : workflow.status === 'completed' && workflow.input.mode === 'chat' ? (
                  <MessageSquare size={14} />
                ) : (
                  <Circle size={12} />
                )}
                {displayStatus.label}
              </span>
              <WorkflowElapsed workflow={workflow} runs={runs} />
              <ChevronDown size={14} />
            </>
          )}
        </summary>
        <div className="trace-body">
          <TaskJudgmentCard judgment={workflow.taskJudgment} />
          <MemoryEvidenceCard
            report={workflow.memoryRetrieval?.evidence}
            onJumpMessage={onJumpMessage}
            sourceMessageIds={sourceMessageIds}
          />
          <ClaimsCheck workflow={workflow} runs={runs} />
          {confirmation && (
            <section className="routing-confirmation" aria-label="运行前确认">
              <strong>本次调度建议</strong>
              <dl>
                <div>
                  <dt>执行器</dt>
                  <dd>{proposedTarget?.label ?? confirmation.proposal.runtimeId}</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{confirmation.proposal.model}</dd>
                </div>
                <div>
                  <dt>思考强度</dt>
                  <dd>{confirmation.proposal.effort ?? '模型默认'}</dd>
                </div>
              </dl>
              <p>确认后才开始规划与执行；本次固定这组选择。资源不可用时会重新提出建议。</p>
              <details>
                <summary>选择依据</summary>
                <ul>
                  {confirmation.proposal.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                  {confirmation.proposal.warnings.map((warning, index) => (
                    <li key={`warning-${index}`}>{warning}</li>
                  ))}
                </ul>
              </details>
              <button
                type="button"
                className="button primary"
                disabled={pending}
                onClick={() => void action('confirm')}
              >
                {pending ? <Loader2 size={14} className="spinning" /> : <Check size={14} />}确认并运行
              </button>
            </section>
          )}
          {(workflow.scheduling || workflow.input.schedule || waiting) && (
            <div className="trace-scheduling">
              {(workflow.scheduling?.reason || waiting) && (
                <p>{workflow.scheduling?.reason ?? '等待调度器检查开始时间与资源。'}</p>
              )}
              <div className="queue-brief">
                {(workflow.input.mode === 'build' || workflow.input.schedule?.estimatedMinutes) && (
                  <span>规划耗时估计：{estimatedDuration(workflow)}</span>
                )}
                {workflow.input.schedule?.deadlineAt && (
                  <span>期限：{queueDate(workflow.input.schedule.deadlineAt)}</span>
                )}
                {workflow.input.schedule?.notBefore && (
                  <span>最早开始：{queueDate(workflow.input.schedule.notBefore)}</span>
                )}
                {waiting && workflow.scheduling?.nextAttemptAt && (
                  <span>下次检查：{queueDate(workflow.scheduling.nextAttemptAt)}</span>
                )}
                {risk && <span className="queue-risk">{risk}</span>}
              </div>
            </div>
          )}
          {workflow.plan.length ? (
            <ol className="plan-list">
              {workflow.plan.map((step, index) => (
                <li key={step.id} className={`step-${step.status}`}>
                  <span className="step-marker">
                    {step.status === 'completed' ? (
                      displayStatus.verified ? (
                        <Check size={12} />
                      ) : (
                        <Circle size={8} />
                      )
                    ) : step.status === 'running' && !waiting ? (
                      <Loader2 size={12} className="spinning" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    {state.settings?.showAutomaticReplyIdentity !== false &&
                      step.status === 'completed' &&
                      step.runIds.length > 0 && (
                        <ReplyIdentity
                          identity={namedIdentity(
                            captureReplyIdentity(
                              workflow,
                              runs.filter((run) => step.runIds.includes(run.id)),
                            ),
                            state.targets,
                          )}
                        />
                      )}
                    {step.acceptance && <p>{step.acceptance}</p>}
                    <StepReport workflow={workflow} step={step} runs={runs} open={lastClaimStep?.id === step.id} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="trace-placeholder">
              {waiting
                ? '任务尚未开始，计划将在资源可用时生成。'
                : isExecutingWorkflow(workflow)
                  ? '正在读取上下文并生成计划…'
                  : '暂无执行步骤。'}
            </p>
          )}
          {onTrace && (
            <button type="button" className="button tiny quiet trace-link" onClick={onTrace}>
              查看轨迹
            </button>
          )}
          {workflow.status === 'blocked' && workflow.waitingOn ? (
            <BackgroundWait workflow={workflow} state={state} />
          ) : (
            workflow.error && !hasSystemNotice && <SystemNoticeView notice={failureNotice(workflow, runs)} />
          )}
          {isExecutingWorkflow(workflow) && latest && (
            <div className="stream-preview">
              <SteeringProgress run={latest} />
              {!mainReply && streamOutput ? (
                <MessageText text={streamOutput} />
              ) : (
                !mainReply &&
                (!latest.reasoning?.trim() || stageEvents) && (
                  <p className="stream-waiting">
                    <Loader2 size={13} className="spinning" />
                    {stageEvents ? '等待收到补充后的输出…' : workflow.delegation ? '等待执行器报告进展…' : '正在思考…'}
                  </p>
                )
              )}
            </div>
          )}
          <div className="trace-actions">
            {canCancelWorkflow(workflow) && (waiting || (workflow.status === 'blocked' && !!workflow.waitingOn)) && (
              <button className="button tiny quiet" disabled={pending} onClick={() => void action('cancel')}>
                <Square size={11} />
                取消
              </button>
            )}
            {canContinueWorkflow(workflow) && !showOutcome && (
              <button className="button tiny secondary" disabled={pending} onClick={() => void action('continue')}>
                {pending ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}继续
              </button>
            )}
            {canDeleteWorkflow(workflow) && (
              <button
                className="button tiny quiet"
                disabled={pending}
                title="移除任务卡，聊天与执行记录保留"
                onClick={() => void action('delete')}
              >
                删除任务
              </button>
            )}
          </div>
        </div>
      </details>
      {workflow.status === 'failed' && !showOutcome && <ReportProblemAction taskId={workflow.id} />}
      {showOutcome && (
        <div className="workflow-outcome" role="status">
          {!hasSystemNotice && (
            <p>{softFileNote ? systemNoticeText.noFileChanges : failureNotice(workflow, runs).text}</p>
          )}
          <button
            type="button"
            className="button tiny primary"
            disabled={pending}
            onClick={() => void action('continue')}
          >
            {pending ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}继续
          </button>
          {workflow.status === 'failed' && <ReportProblemAction taskId={workflow.id} />}
        </div>
      )}
      {/* After a steering correction the reasoning still holds the earlier stage, so the new stage shows none. */}
      {!presentation && isExecutingWorkflow(workflow) && !stageEvents && latest?.reasoning?.trim() && (
        <ReasoningTail workflow={workflow} runs={runs} targets={state.targets} />
      )}
      {(!presentation || workflow.status === 'completed') &&
        mainReply &&
        !hasCurrentReply &&
        publicReplyText?.trim() && (
          <article
            key={`${latest!.id}:${stage?.id ?? ''}`}
            className="conversation-message message-assistant live-main-reply"
            aria-busy="true"
            data-run-id={latest!.id}
          >
            <div className="message-heading">
              <span>PugPort</span>
              <Loader2 size={12} className="spinning" aria-hidden="true" />
            </div>
            <MessageText text={publicReplyText} />
          </article>
        )}
      {workflow.selectionSwitch && (
        <p className="queue-note executor-selection-status" role="status">
          {workflow.selectionSwitch.state === 'switching' && <Loader2 size={12} className="spinning" />}
          {workflow.selectionSwitch.state === 'blocked'
            ? `切换需要处理 · ${workflow.selectionSwitch.runtimeLabel}`
            : executorSelectionStatus({
                state: workflow.selectionSwitch.state,
                runtimeLabel: workflow.selectionSwitch.runtimeLabel,
              })}
        </p>
      )}
      {queueSteeringRun && (
        <div className="trace-actions">
          <button
            type="button"
            className="button tiny secondary"
            disabled={pending}
            title="将这条排队消息补充到当前运行任务"
            onClick={() => void action('steer')}
          >
            {pending ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}
            插入当前任务（steer）
          </button>
        </div>
      )}
      {followUp && (
        <p className="queue-note">
          原执行记录保留。
          {nextWorkflow && <a href={`#workflow-${encodeURIComponent(nextWorkflow.id)}`}>查看后续任务</a>}
        </p>
      )}
      {workflow.memoryRetrieval?.status === 'error' && (
        <p className="retrieval-warning">本次未带历史上下文：{workflow.memoryRetrieval.error}</p>
      )}
    </div>
  );
}

const LazyProjectTools = lazy(() => import('./ProjectTools').then((module) => ({ default: module.ProjectTools })));

// Window-session preferences survive pane remounts; they are never persisted.
const modChatSessions = new Map<string, boolean>();
const modSeenReplies = new Map<string, string | undefined>();

export function ConversationWorkspace({
  state,
  api,
  reload = async () => undefined,
  project,
  conversation,
  notify,
  onConversation,
  onBeforeSend,
  onAddProject,
  onNewExternalChat,
  onInspect,
  traceRequest,
  onSideChat,
  onManageConnectors,
  onOpenSettings,
  onOpenModeStore,
  onModDetails,
  modSurfaces = true,
  modSidebarTarget,
  onRemoveMod,
  removingMod = false,
  onConversationMenu,
  paneActions,
  composerSession,
  searchTarget,
}: {
  searchTarget?: { messageId: string; requestId: number };
  /** Extra toolbar buttons when shown in a split pane (close pane). */
  paneActions?: ReactNode;
  /** Owned by the window, so replacing a split pane cannot discard its drafts. */
  composerSession?: ComposerSession;
  state: AppState;
  api: Api;
  reload?: () => Promise<void>;
  project?: Project;
  conversation?: Conversation;
  notify: Notify;
  onConversation: (conversation: Conversation) => void;
  onBeforeSend?: () => Promise<boolean>;
  onAddProject: () => void;
  onNewExternalChat?: (agentId: ExternalAgentId) => void;
  onMemory: () => void;
  onInspect: (id: string) => void;
  /** Opens this chat's Trace on a run, e.g. from Run history. A new nonce reopens it. */
  traceRequest?: { runId: string; nonce: number };
  onSideChat?: (workflow: Workflow) => void;
  onManageConnectors?: () => void;
  onOpenSettings?: (category: SettingsCategory, focusId?: string) => void;
  onOpenModeStore?: (conversationId: string) => void;
  onModDetails?: (modId: string) => void;
  /** Only the first pane displaying a conversation mounts its Mod surface. */
  modSurfaces?: boolean;
  modSidebarTarget?: HTMLElement | null;
  onRemoveMod?: () => void;
  removingMod?: boolean;
  onConversationMenu?: MouseEventHandler<HTMLElement>;
}) {
  const scope = conversation ? `conversation:${conversation.id}` : `new:${project?.id ?? 'chat'}`;
  const experience = useConversationMode(api, conversation);
  const scopeRef = useRef(scope);
  const scopeVersion = useRef(0);
  if (scopeRef.current !== scope) scopeVersion.current++;
  scopeRef.current = scope;
  const mounted = useRef(true);
  const [ownComposerSession] = useState(() => new ComposerSession());
  const session = composerSession ?? ownComposerSession;
  const { drafts, pendingSends } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draft = drafts[scope] ?? emptyDraft();
  const agentPresets = useMemo(() => listAgentPresets(state.settings.agentPresets), [state.settings.agentPresets]);
  const [manageRoles, setManageRoles] = useState(false);
  const [traceFor, setTraceFor] = useState<string>();
  const [traceSelection, setTraceSelection] = useState<{ workflowId: string; runId?: string }>();
  const traceOpen = Boolean(conversation && traceFor === conversation.id);
  useEffect(() => {
    setTraceFor(undefined);
    setTraceSelection(undefined);
  }, [conversation?.id]);
  useEffect(() => setManageRoles(false), [scope]);
  const { content, attachments } = draft;
  const quotes = draft.quotes ?? [];
  // Two sizes, not one more line per line typed: compact, or tall once the text gets long (or on request).
  const [composerSize, setComposerSize] = useState<'auto' | 'compact' | 'tall'>('auto');
  const [draftPreview, setDraftPreview] = useState<string>();
  const [markupEdit, setMarkupEdit] = useState<DraftQuote>();
  useEffect(() => {
    setDraftPreview(undefined);
    setMarkupEdit(undefined);
  }, [scope]);
  /** Stop pauses a background search, continue resumes it, close ends it. */
  const backgroundTask = (id: string, action: 'pause' | 'resume' | 'close') => {
    const media = state.backgroundTasks?.find((task) => task.id === id)?.kind === 'media-analysis';
    void api(
      `/api/${media ? 'media-analysis' : 'background-tasks'}/${encodeURIComponent(id)}${action === 'close' ? '' : `/${action}`}`,
      media ? { conversationId: conversation?.id } : action === 'close' ? undefined : {},
      action === 'close' ? 'DELETE' : 'POST',
    ).catch((error) => notify({ tone: 'error', message: errorText(error) }));
  };
  const draftImages = attachments.filter((item) => item.previewUrl);
  const longText = content.split('\n').length > 6 || content.length > 360;
  const tallComposer = composerSize === 'tall' || (composerSize === 'auto' && longText);
  useLayoutEffect(() => {
    if (!content) setComposerSize('auto');
  }, [content === '']);
  // The note box for a new quote (from a selection) or an existing capsule (with its id).
  const [quoteEditor, setQuoteEditor] = useState<{
    id?: string;
    text: string;
    note: string;
    messageId?: string;
    left: number;
    top: number;
  }>();
  function saveQuote(note: string) {
    const editor = quoteEditor;
    if (!editor) return;
    changeDraft(scope, (previous) => {
      const list = previous.quotes ?? [];
      return {
        ...previous,
        quotes: editor.id
          ? list.map((quote) => (quote.id === editor.id ? { ...quote, note: note || undefined } : quote))
          : [
              ...list,
              {
                id: crypto.randomUUID(),
                text: editor.text,
                ...(note ? { note } : {}),
                ...(editor.messageId ? { messageId: editor.messageId } : {}),
              },
            ].slice(0, 10),
      };
    });
    setQuoteEditor(undefined);
    inputRef.current?.focus();
  }
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const replyPathsRef = useRef<ReplyPathOpener>(null);
  function removeQuote(id: string) {
    changeDraft(scope, (previous) => ({
      ...previous,
      attachments: previous.attachments.filter(
        (item) => item.id !== previous.quotes?.find((quote) => quote.id === id)?.attachmentDraftId,
      ),
      quotes: (previous.quotes ?? []).filter((quote) => quote.id !== id),
    }));
  }
  function addMarkup(targetScope: string, result: MarkupResult, replaceId?: string): boolean {
    const previous = draftsRef.current[targetScope] ?? emptyDraft();
    const existing = replaceId ? previous.quotes?.find((quote) => quote.id === replaceId) : undefined;
    const others = previous.attachments.filter((item) => item.id !== existing?.attachmentDraftId);
    if (!existing && (previous.quotes?.length ?? 0) >= MAX_QUOTES) {
      notify({ tone: 'error', message: '引用最多 10 条，请先移除一条。' });
      return false;
    }
    let name = result.file.name;
    const stem = name.replace(/\.png$/i, '');
    for (let number = 2; others.some((item) => item.file.name === name); number++) {
      const suffix = `-${number}.png`;
      name = `${stem.slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF]$/, '')}${suffix}`;
    }
    const file = name === result.file.name ? result.file : new File([result.file], name, { type: 'image/png' });
    const { accepted, errors } = selectAttachmentFiles(others, [file]);
    if (!accepted.length) {
      notify({ tone: 'error', message: errors.join(' ') });
      return false;
    }
    const attachment: DraftAttachment = { id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) };
    const markup = { ...result.markup, attachment: name };
    const quote: DraftQuote = {
      id: existing?.id ?? crypto.randomUUID(),
      text: markupQuoteText(markup).slice(0, MAX_QUOTE_LENGTH),
      markup,
      attachmentDraftId: attachment.id,
      markupSrc: result.src,
    };
    changeDraft(targetScope, (draft) => ({
      ...draft,
      attachments: [...others, attachment],
      quotes: existing
        ? (draft.quotes ?? []).map((item) => (item.id === existing.id ? quote : item))
        : [...(draft.quotes ?? []), quote],
    }));
    inputRef.current?.focus();
    return true;
  }
  function imageMarkup(linked?: DraftQuote): ViewerMarkup {
    return {
      kind: linked?.markup?.source.kind ?? 'image',
      ...(linked?.markup && linked.markupSrc
        ? {
            initial: linked.markup.marks,
            source: { src: linked.markupSrc, name: linked.markup.source.name, metadata: linked.markup.source },
          }
        : {}),
      onAdd: (result) => addMarkup(scope, result, linked?.id),
    };
  }
  const changeDraft = (key: string, update: (value: ComposerDraft) => ComposerDraft) => {
    session.changeDraft(key, update);
    draftsRef.current = session.getSnapshot().drafts;
  };
  const setPendingSends = session.changePending.bind(session);
  const setContent = (value: string) => changeDraft(scope, (previous) => ({ ...previous, content: value }));
  const [sideChats, setSideChats] = useState<Record<string, { launch: SideChatLaunch; open: boolean }>>({});
  // Clicking the open settings button closes its panel.
  const [panelTab, setPanelTab] = useState<PanelTab>();
  const [toolsPane, setToolsPane] = useState<'desktop' | 'work'>();
  const [toolsConversation, setToolsConversation] = useState<Conversation>();
  const [toolsDesktopOpened, setToolsDesktopOpened] = useState(false);
  const [toolsWorkOpened, setToolsWorkOpened] = useState(false);
  useLayoutEffect(() => setPanelTab(undefined), [scope]);
  const draftConversationRequests = useMemo(() => {
    let requests = draftConversationRequestsBySession.get(session);
    if (!requests) {
      requests = new Map();
      draftConversationRequestsBySession.set(session, requests);
    }
    return requests;
  }, [session]);
  const [closedTastes, setClosedTastes] = useState<ReadonlySet<string>>(new Set());
  // Settings before the first message need a saved conversation; sending must reuse that same creation.
  const createdForDraft = draft.createdConversation
    ? (state.conversations?.find((item) => item.id === draft.createdConversation!.id) ?? draft.createdConversation)
    : undefined;
  const settingsConversation = conversation ?? createdForDraft;
  const ensureDraftConversation = () => {
    const key = scope;
    const saved = conversation ?? session.getSnapshot().drafts[key]?.createdConversation;
    if (saved) return Promise.resolve(saved);
    const pending = draftConversationRequests.get(key);
    if (pending) return pending;
    const request = api<Conversation>('/api/conversations', inProject ? { projectId: project.id } : {})
      .then((created) => {
        changeDraft(key, (previous) => ({ ...previous, createdConversation: created }));
        saveComposerSelection(created.id, remembered);
        return created;
      })
      .finally(() => draftConversationRequests.delete(key));
    draftConversationRequests.set(key, request);
    return request;
  };
  const togglePanel = async (tab: PanelTab) => {
    if (panelTab === tab) return setPanelTab(undefined);
    const version = scopeVersion.current;
    const isCurrent = () => mounted.current && scopeVersion.current === version;
    try {
      if (!settingsConversation) await ensureDraftConversation();
      if (isCurrent()) setPanelTab(tab);
    } catch (error) {
      if (isCurrent()) notify({ tone: 'error', message: errorText(error) });
    }
  };
  const sideChat = sideChats[scope];
  const savedSideChats = conversation ? sideChatHistory(state.conversations ?? [], conversation.id) : [];
  const restoreSelection = () =>
    loadComposerSelection(
      conversation?.id,
      (id) => state.targets.some((target) => target.id === id && target.enabled),
      conversation?.createdAt,
    );
  const [composerSelection, setComposerSelection] = useState(() => ({ scope, value: restoreSelection() }));
  if (composerSelection.scope !== scope) setComposerSelection({ scope, value: restoreSelection() });
  const remembered = composerSelection.scope === scope ? composerSelection.value : restoreSelection();
  const { mode, permission, policy, review } = remembered;
  const changeSelection = (patch: Partial<typeof remembered>) => {
    const value = { ...remembered, ...patch };
    saveComposerSelection(conversation?.id, value);
    setComposerSelection({ scope, value });
  };
  const setMode = (mode: MessageInput['mode']) => changeSelection({ mode });
  const setPolicy = (policy: MessageInput['executionPolicy']) => changeSelection({ policy });
  const setReview = (review: boolean) => changeSelection({ review });
  const [options, setOptions] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [mediaWorkflowDialog, setMediaWorkflowDialog] = useState<{
    scope: string;
    projectId?: string;
    folder?: string;
    key: string;
  }>();
  const mediaWorkflowAdopted = useRef<{ scope: string; projectId: string } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!mediaWorkflowDialog) return;
    const adopted = mediaWorkflowAdopted.current;
    const matchesCreatedConversation = adopted?.scope === scope && (!project || project.id === adopted.projectId);
    if (
      !matchesCreatedConversation &&
      (mediaWorkflowDialog.scope !== scope || mediaWorkflowDialog.projectId !== project?.id)
    )
      setMediaWorkflowDialog(undefined);
  }, [scope, project?.id, mediaWorkflowDialog]);
  const closeMediaWorkflowDialog = () => {
    setMediaWorkflowDialog(undefined);
    mediaWorkflowAdopted.current = undefined;
  };
  const ensureMediaConversation = async () => {
    const capturedScope = scope;
    const target = await ensureDraftConversation();
    if (!mounted.current || scopeRef.current !== capturedScope)
      throw new Error('当前对话已改变，请在新对话中重新开始本地分析。');
    if (!conversation) {
      const destination = `conversation:${target.id}`;
      saveComposerSelection(target.id, remembered);
      changeDraft(capturedScope, (previous) => ({ ...previous, createdConversation: target }));
      session.moveScope(capturedScope, destination);
      mediaWorkflowAdopted.current = { scope: destination, projectId: target.projectId };
      onConversation(target);
    }
    return target.id;
  };
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
  // Side chats and work lanes are their own thing; they never take a mode.
  const modeChip = !conversation?.sideChat && !conversation?.lane;
  const [navigatorRouteOpen, setNavigatorRouteOpen] = useState(false);
  const navigatorRouteRef = useRef<HTMLDivElement>(null);
  useDismiss(navigatorRouteOpen, navigatorRouteRef, () => setNavigatorRouteOpen(false));
  const saveNavigatorRoute = (route: NavigatorRoute | null) => {
    if (!conversation) return;
    void api(`/api/conversations/${conversation.id}`, { navigatorRoute: route }, 'PATCH')
      .then(() => reload())
      .catch((error) => notify({ tone: 'error', message: errorText(error) }));
  };
  const modFolder = useModWorkspaceFolder(api, conversation);
  // Mods author › Change…: an empty folder or one with the author layout; projects and PugPort data are refused.
  const changeModFolder = desktopBridge()?.pickDirectory
    ? () => {
        setModeOpen(false);
        void (async () => {
          try {
            const path = await desktopBridge()?.pickDirectory();
            if (!path) return;
            const id = conversation?.id ?? (await ensureMediaConversation());
            await api('/api/mod-workspaces', { conversationId: id, path });
            await reload();
          } catch (error) {
            notify({ tone: 'error', message: errorText(error) });
          }
        })();
      }
    : undefined;
  const pickMode = (next: WorkMode | null) => {
    setModeOpen(false);
    if ((conversation?.workMode ?? null) === next) return;
    setModeBusy(true);
    void (async () => {
      try {
        const id = conversation?.id ?? (await ensureMediaConversation());
        await api(`/api/conversations/${id}`, { workMode: next }, 'PATCH');
        await reload();
      } catch (error) {
        notify({ tone: 'error', message: errorText(error) });
      } finally {
        setModeBusy(false);
      }
    })();
  };
  const [mentionQuery, setMentionQuery] = useState<ReturnType<typeof mentionPrefixAt>>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileQuery, setFileQuery] = useState<{ start: number; query: string }>();
  const [fileItems, setFileItems] = useState<FileReference[]>([]);
  const [fileResultKey, setFileResultKey] = useState('');
  const [fileError, setFileError] = useState('');
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashText, setSlashText] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItems = slashOpen ? filterSlashCommands(slashText, conversation?.incognito) : [];
  function updateSlashMenu(value: string, caret: number) {
    const prefix = slashCommandAt(value, caret);
    setSlashText(prefix ?? '');
    setSlashOpen(prefix !== undefined);
    setSlashIndex(0);
  }
  const fileProject = project ?? state.projects?.find((item) => item.id === conversation?.projectId);
  useEffect(() => {
    setFileItems([]);
    setFileError('');
    if (!fileQuery || !fileProject || fileProject.scope === 'chat') return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<FileReference[]>(
        `/api/projects/${encodeURIComponent(fileProject.id)}/files?q=${encodeURIComponent(fileQuery.query)}`,
        undefined,
        'GET',
        controller.signal,
      )
        .then((items) => {
          if (current) {
            setFileItems(items);
            setFileResultKey(JSON.stringify([fileProject.id, fileQuery.query]));
          }
        })
        .catch(() => {
          if (current) {
            setFileError('无法读取项目文件');
            setFileResultKey(JSON.stringify([fileProject.id, fileQuery.query]));
          }
        });
    }, 120);
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, fileProject?.id, fileQuery, scope]);
  useEffect(() => {
    setMentionQuery(undefined);
    setFileQuery(undefined);
    setSlashOpen(false);
  }, [scope]);

  // Read availability when opening the picker or a bound chat.
  const { agents: externalAgents, status: externalAgentsStatus } = useExternalAgents(
    api,
    !!conversation?.defaultExternalAgentId ||
      (!!mentionQuery && mentionQuery.tier === 2) ||
      // Whether a request like "让 Muse 解释…" reaches Muse depends on Muse being ready.
      (!!attachments.length &&
        !!externalInvocation(
          content,
          externalAgentIds.map((id) => ({ id, name: externalAgentCatalog[id].name })),
        )),
    !!conversation?.defaultExternalAgentId,
  );
  const boundAgentId = conversation?.defaultExternalAgentId;
  const boundAgent = externalAgents.find((agent) => agent.id === boundAgentId);
  const boundAgentReason = externalAgentsStatus
    ? externalAgentsStatus === 'loading'
      ? '正在读取智能体状态'
      : '无法读取智能体状态'
    : !boundAgent
      ? '尚未添加'
      : !boundAgent.enabled
        ? '已关闭'
        : !boundAgent.available
          ? (boundAgent.reason ?? '现在不能用')
          : undefined;
  const [unbinding, setUnbinding] = useState(false);
  const unbindPending = useRef(false);
  async function unbindExternalAgent() {
    if (!conversation || unbindPending.current) return;
    unbindPending.current = true;
    setUnbinding(true);
    const capturedScope = scope;
    try {
      const updated = await api<Conversation>(
        `/api/conversations/${conversation.id}`,
        { defaultExternalAgentId: null },
        'PATCH',
      );
      if (scopeRef.current === capturedScope && mounted.current) onConversation(updated);
      await reload();
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      unbindPending.current = false;
      if (mounted.current) setUnbinding(false);
    }
  }
  const availableDevices = useDevices(
    api,
    !conversation?.incognito &&
      ((!!mentionQuery && mentionQuery.tier >= 2) || !!draft.called?.some((item) => item.kind === 'device')),
  );
  const devices = conversation?.incognito ? [] : availableDevices;
  const [remoteView, setRemoteView] = useState<RemoteServersView>();
  const [serverEnrollment, setServerEnrollment] = useState<{
    server: RemoteServerView & { machine?: InstaboxMachineView };
    at: NonNullable<typeof mentionQuery>;
    scope: string;
  }>();
  useEffect(() => {
    if (mentionQuery?.tier !== 3 || conversation?.incognito) return;
    let live = true;
    void api<RemoteServersView>('/api/remote-servers?refresh=instabox', undefined, 'GET')
      .then((value) => {
        if (live) setRemoteView(value);
      })
      .catch(() => {
        if (live) setRemoteView(undefined);
      });
    return () => {
      live = false;
    };
  }, [api, mentionQuery?.tier, conversation?.incognito]);
  const unconnectedServers = useMemo(() => {
    if (mentionQuery?.tier !== 3 || conversation?.incognito) return [];
    const query = mentionQuery.query.toLowerCase();
    const servers: (RemoteServerView & { machine?: InstaboxMachineView; machineId?: string; note?: string })[] = [
      ...(remoteView?.servers ?? []).filter((server) => server.ssh),
      ...(remoteView?.instabox?.machines ?? []).map((machine) => ({
        name: machine.name,
        ssh: machine.ssh,
        machineId: machine.machineId,
        machine,
        note: machine.ssh ? undefined : '未接入 · 点一下接入',
      })),
    ];
    return servers.filter(
      (server) =>
        (!server.ssh || !devices.some((device) => device.tunnel?.ssh === server.ssh)) &&
        (!query || server.name.toLowerCase().includes(query) || server.ssh?.toLowerCase().includes(query)),
    );
  }, [mentionQuery?.tier, mentionQuery?.query, conversation?.incognito, remoteView, devices]);
  const pickServer = (server: (typeof unconnectedServers)[number]) => {
    if (mentionQuery) setServerEnrollment({ server, at: mentionQuery, scope });
    setMentionQuery(undefined);
  };
  const mentionChoices = useMemo(
    () => mentionChoicesFor(agentPresets, availableCoreTargets(state.targets), externalAgents, devices, state.targets),
    [agentPresets, state.targets, externalAgents, devices],
  );
  // Everyone this message calls, in the order they were picked; the list marks them instead of offering them again.
  const called = useMemo(() => draft.called ?? [], [draft.called]);
  const textOnly = textOnlyRecipients(attachments.length, called, content, externalAgents, boundAgentId);
  const textOnlyNames = textOnly ? [new Intl.ListFormat(currentLocale()).format(textOnly.names)] : [];
  const textOnlyNotice = textOnly?.mixed
    ? '{0} 只能收文字，收不到附件；其他参与者照常可以用附件。'
    : '{0} 只能收文字，收不到附件。要发附件，请换个参与者。';
  const calledDevice = called.length === 1 && called[0]?.kind === 'device' ? called[0] : undefined;
  const selectedDevice = devices.find((device) => `${deviceMentionPrefix}${device.id}` === calledDevice?.id);
  const deviceFolder = calledDevice ? (draft.deviceFolder?.trim() ?? '') : '';
  const deviceFolderList = useId();
  const deviceWriteReason =
    calledDevice && selectedDevice?.allowWrite === false ? '这台设备已关闭写入，请在设备上开启后刷新。' : '';
  const composerReadOnly = !!deviceWriteReason || mode === 'chat' || permission === 'read-only';
  const draftRole = agentPresets.find((preset) => preset.id === draft.agentPresetId);
  const canPlanFirst =
    !conversation?.swarm &&
    called.length <= 1 &&
    !called.some((item) => item.kind === 'device' || item.kind === 'external');
  const calledKeys = useMemo(() => new Set(called.map(participantKey)), [called]);
  const mentionGroups = useMemo(
    () =>
      mentionQuery
        ? mentionSections(
            mentionQuery.query.length <= 24
              ? mentionChoices.filter((item) =>
                  mentionQuery.tier === 1
                    ? item.kind === 'role' || item.kind === 'executor'
                    : mentionQuery.tier === 2
                      ? (item.kind === 'device' && item.tier !== 3) || item.kind === 'external'
                      : item.kind === 'device' && item.tier === 3,
                )
              : [],
            mentionQuery.query,
            mentionQuery.tier === 3 ? {} : readMentionUsage(),
            calledKeys,
          )
        : [],
    [mentionQuery, mentionChoices, calledKeys],
  );
  const mentionItems = useMemo(
    () =>
      mentionGroups
        .flatMap((section) => section.items)
        .map((item) => {
          const device = devices.find((d) => `${deviceMentionPrefix}${d.id}` === item.id);
          const machine = remoteView?.instabox?.machines.find((m) => m.ssh && m.ssh === device?.tunnel?.ssh);
          return machine && machine.state === 'paused' ? { ...item, description: '已暂停 · 发送时唤醒' } : item;
        }),
    [mentionGroups, devices, remoteView],
  );
  const frequentMentions = mentionGroups[0]?.id === 'frequent' ? mentionGroups[0].items.length : 0;
  const fileResultCurrent =
    !!fileQuery && !!fileProject && fileResultKey === JSON.stringify([fileProject.id, fileQuery.query]);
  const visibleFiles =
    mentionQuery?.tier === 1 && fileProject && fileProject.scope !== 'chat' && fileResultCurrent ? fileItems : [];
  const mentionCount = mentionItems.length + visibleFiles.length + unconnectedServers.length;
  const selectableMention = (index: number) =>
    index >= mentionItems.length || !calledKeys.has(participantKey(mentionItems[index]!));
  const nextIndex = (from: number, step: 1 | -1) => {
    for (let offset = 1; offset <= mentionCount; offset++) {
      const index = (from + step * offset + mentionCount * 2) % mentionCount;
      if (selectableMention(index)) return index;
    }
    return -1;
  };
  const boundedIndex = Math.min(mentionIndex, mentionCount - 1);
  const activeMention =
    boundedIndex < 0 ? -1 : selectableMention(boundedIndex) ? boundedIndex : nextIndex(boundedIndex, 1);
  const routeRef = useRef<HTMLDivElement>(null);
  const scheduleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const routeFocus = useFocusTrap(options, routeRef);
  const scheduleFocus = useFocusTrap(scheduleOpen, scheduleRef);
  useMenuKeys(plusOpen, plusRef, () => setPlusOpen(false));
  useMenuKeys(modeOpen, modeRef, () => setModeOpen(false));
  useDismiss(modeOpen, modeRef, () => setModeOpen(false));
  // Every composer popover floats over the text and closes on Escape or a click elsewhere.
  useDismiss(plusOpen, plusRef, () => setPlusOpen(false));
  useDismiss(
    options,
    routeRef,
    () => setOptions(false),
    () => (routeFocus.current?.isConnected ? routeFocus.current : inputRef.current),
  );
  useDismiss(
    scheduleOpen,
    scheduleRef,
    () => setScheduleOpen(false),
    () => (scheduleFocus.current?.isConnected ? scheduleFocus.current : inputRef.current),
  );
  const [swarmBusy, setSwarmBusy] = useState(false);
  /** The swarm member open in the middle column; none shows the conversation itself. */
  const [swarmLines, setSwarmLines] = useState<{ conversationId: string; lines: SwarmChatLine[] }>();
  const [deadline, setDeadline] = useState('');
  const [notBefore, setNotBefore] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [preferExpiringQuota, setPreferExpiringQuota] = useState(true);
  const savedRoute = {
    runtimeId: remembered.runtimeId,
    model: remembered.model,
    effort: remembered.effort,
  };
  const [profileSelection, setProfileSelection] = useState({ scope, id: settingsConversation?.routingProfileId });
  const [changingProfile, setChangingProfile] = useState(false);
  const changingProfileRequest = useRef(false);
  useEffect(() => {
    setProfileSelection({ scope, id: settingsConversation?.routingProfileId });
  }, [scope, settingsConversation?.routingProfileId]);
  const routingProfileOverride =
    profileSelection.scope === scope ? profileSelection.id : settingsConversation?.routingProfileId;
  const routingProfileId = effectiveRoutingProfileId({ routingProfileId: routingProfileOverride }, project);
  const inheritProjectRouting = project?.scope !== 'chat' && Boolean(project) && routingProfileOverride === undefined;
  const routingProfiles = state.settings.routingProfiles ?? [];
  const projectRoutingLabel =
    project && project.scope !== 'chat'
      ? project.routingProfileId
        ? (routingProfiles.find((item) => item.id === project.routingProfileId)?.name ?? '路由方案不可用')
        : '自动'
      : undefined;
  const routingProfile = routingProfiles.find((profile) => profile.id === routingProfileId);
  const unavailableProfile = !!routingProfileId && !routingProfile;
  const {
    runtimeId,
    model,
    effort = '',
  } = routingProfileId ? { runtimeId: '', model: '', effort: '' } : (draft.writer ?? savedRoute);
  const [modelFallback, setModelFallback] = useState('');
  const selectRoute = (patch: Partial<typeof savedRoute>) => {
    setModelFallback('');
    changeSelection({ runtimeId, model, effort, ...patch });
    changeDraft(scope, ({ writer: _writer, ...previous }) => previous);
  };
  async function selectExecutionChoice(value: string) {
    if (changingProfileRequest.current) return;
    const inherit = value === projectRoutingChoice;
    const profileId = value.startsWith(routingProfilePrefix) ? value.slice(routingProfilePrefix.length) : undefined;
    if (!inherit && !profileId && !routingProfileId && !inheritProjectRouting) {
      selectRoute({ runtimeId: value, model: '', effort: '' });
      return;
    }
    changingProfileRequest.current = true;
    setChangingProfile(true);
    const version = scopeVersion.current;
    const key = scope;
    const isCurrent = () => mounted.current && scopeVersion.current === version;
    try {
      const target = await ensureDraftConversation();
      if (!isCurrent()) return;
      const saved = await api<Conversation>(
        `/api/conversations/${encodeURIComponent(target.id)}/routing-profile`,
        inherit ? { inheritProject: true } : { profileId: profileId ?? null },
        'PATCH',
      );
      if (!mounted.current) return;
      changeDraft(key, (previous) =>
        previous.createdConversation?.id === saved.id ? { ...previous, createdConversation: saved } : previous,
      );
      if (!isCurrent()) return;
      setProfileSelection({ scope: key, id: saved.routingProfileId });
      selectRoute({ runtimeId: profileId || inherit ? '' : value, model: '', effort: '' });
    } catch (error) {
      if (isCurrent()) notify({ tone: 'error', message: errorText(error) });
    } finally {
      changingProfileRequest.current = false;
      if (mounted.current) setChangingProfile(false);
    }
  }
  // Set when the user switches to writable in this composer: a continue may then take the new permission.
  const permissionReauthorized = useRef(false);
  const setComposerPermission = (next: MessageInput['permissionMode']) => {
    permissionReauthorized.current = next === 'workspace-write';
    const autoMode = next === 'workspace-write' && mode === 'chat';
    changeSelection({ permission: next, ...(autoMode ? { mode: 'auto' } : {}) });
  };
  useEffect(() => {
    saveComposerSelection(conversation?.id, remembered);
  }, [conversation?.id, remembered]);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [escalate, setEscalate] = useState(true);
  const [verification, setVerification] = useState('');
  const [sendingMessage, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendAfter = useRef<{ scope: string; queue?: boolean; answer?: string } | undefined>(undefined);
  const sendLatest = useRef<(scope: string, queue?: boolean, answer?: string) => void>(() => undefined);
  const emptySteerRequests = useRef(new Map<string, symbol>());
  const [emptySteerScopes, setEmptySteerScopes] = useState<string[]>([]);
  const sending = sendingMessage || emptySteerScopes.includes(scope);
  const [queuePending, setQueuePending] = useState(false);
  const queuePendingRef = useRef(false);
  const queueingRequests = useRef(new Set<string>());
  const [queueingScopes, setQueueingScopes] = useState<string[]>([]);
  const queueingPending = queueingScopes.includes(scope);
  const [sendingLabel, setSendingLabel] = useState('');
  const wakingInstabox = useRef(false);
  /**
   * Messages shown the moment the user presses Enter, before the server has them: the composer clears at
   * once and the request finishes in the background. Each disappears when the real message arrives.
   */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  // Long conversations render their latest rows first and grow upward as the user scrolls back.
  const rowStep = 60;
  const [shownRows, setShownRows] = useState(rowStep);
  const growFrom = useRef<number | undefined>(undefined);
  useEffect(() => setShownRows(rowStep), [conversation?.id]);
  function showEarlier() {
    const el = scrollRef.current;
    if (!el || growFrom.current !== undefined || el.querySelector('.show-earlier') === null) return;
    growFrom.current = el.scrollHeight;
    setShownRows((count) => count + rowStep);
  }
  // Keep the view where it was when earlier rows are added above it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && growFrom.current !== undefined) el.scrollTop += el.scrollHeight - growFrom.current;
    growFrom.current = undefined;
  }, [shownRows]);
  const composition = useRef({ active: false, endedAt: -Infinity });
  const [loadedHistory, setLoadedHistory] = useState<{
    id: string;
    messages: ConversationMessage[];
    workflows: Workflow[];
    usageRuns?: import('../shared/usage').UsageRun[];
    conversationPresentationRevisions?: Record<string, string>;
  }>();
  const historyRequest = useRef(0);
  const syncRequest = useRef({ scope, token: 0, pending: false });
  if (syncRequest.current.scope !== scope)
    syncRequest.current = { scope, token: syncRequest.current.token + 1, pending: false };
  const [grokSync, setGrokSync] = useState<{
    scope: string;
    token: number;
    pending: boolean;
    result?: GrokHistorySyncResult;
    error?: string;
  }>();
  const currentGrokSync =
    grokSync?.scope === scope && grokSync.token === syncRequest.current.token ? grokSync : undefined;
  useEffect(() => {
    setGrokSync(undefined);
    return () => {
      syncRequest.current.token++;
      syncRequest.current.pending = false;
    };
  }, [scope]);
  useEffect(() => {
    let alive = true;
    const request = ++historyRequest.current;
    const id = conversation?.id;
    if (id)
      void api<{
        messages: ConversationMessage[];
        workflows?: Workflow[];
        usageRuns?: import('../shared/usage').UsageRun[];
        conversationPresentationRevisions?: Record<string, string>;
      }>('/api/conversations/' + encodeURIComponent(id), undefined, 'GET')
        .then((value) => {
          if (alive && request === historyRequest.current)
            setLoadedHistory({
              id,
              messages: value.messages,
              workflows: value.workflows ?? [],
              usageRuns: value.usageRuns,
              conversationPresentationRevisions: value.conversationPresentationRevisions,
            });
        })
        .catch(() => {
          if (alive && request === historyRequest.current)
            notify({ tone: 'error', message: '完整历史读取失败，现有记录已保留。请重新打开对话。' });
        });
    return () => {
      alive = false;
    };
  }, [conversation?.id, conversation?.workflowHistoryRevision, conversation?.grokHistory?.syncedAt, api]);
  const messages = useMemo(() => {
    const messageMap = new Map(
      (loadedHistory?.id === conversation?.id ? (loadedHistory?.messages ?? []) : []).map((message) => [
        message.id,
        message,
      ]),
    );
    for (const message of state.conversationMessages ?? [])
      if (message.conversationId === conversation?.id) messageMap.set(message.id, message);
    return [...messageMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [loadedHistory, state.conversationMessages, conversation?.id]);
  const latestMessages = useRef(messages);
  latestMessages.current = [...(state.conversationMessages ?? []), ...messages];
  const workflows = useMemo(() => {
    // Broadcasts contain only bounded recent/active tasks. Full per-conversation metadata keeps old and
    // deleted children identifiable; a late broadcast must never revive an already deleted task card.
    const workflowMap = new Map(
      (loadedHistory?.id === conversation?.id ? (loadedHistory?.workflows ?? []) : [])
        .filter((workflow) => workflow.conversationId === conversation?.id)
        .map((workflow) => [workflow.id, workflow]),
    );
    for (const workflow of state.workflows ?? []) {
      if (workflow.conversationId !== conversation?.id) continue;
      const saved = workflowMap.get(workflow.id);
      if (!saved?.deletedAt && (!saved || saved.updatedAt <= workflow.updatedAt))
        workflowMap.set(workflow.id, workflow);
    }
    return [...workflowMap.values()];
  }, [loadedHistory, state.workflows, conversation?.id]);
  const latestPresentationWorkflow = [...workflows]
    .filter((workflow) => !workflow.deletedAt && !workflow.parentWorkflowId && !workflow.delegation)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const presentationRequests = workflows.filter(
    (workflow) => workflow === latestPresentationWorkflow || live(workflow),
  );
  const presentationState = useMemo(
    () => ({
      ...state,
      workflows: [
        ...(state.workflows ?? []).filter((workflow) => workflow.conversationId !== conversation?.id),
        ...workflows,
      ],
      usage: state.usage && {
        ...state.usage,
        perRun: [
          ...new Map(
            [
              ...(loadedHistory?.id === conversation?.id ? (loadedHistory?.usageRuns ?? []) : []),
              ...state.usage.perRun,
            ].map((run) => [run.runId, run]),
          ).values(),
        ],
      },
      conversationPresentationRevisions: {
        ...(loadedHistory?.id === conversation?.id ? loadedHistory?.conversationPresentationRevisions : {}),
        ...state.conversationPresentationRevisions,
      },
    }),
    [state, workflows, loadedHistory, conversation?.id],
  );
  const displayState = useConversationPresentations(api, presentationState, workflows, presentationRequests);
  const observedModel = [...state.runs]
    .filter((run) => workflows.some((w) => w.runIds.includes(run.id)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.effectiveModel;
  const ownApprovals = (state.approvals ?? []).filter((approval) =>
    workflows.some((workflow) => workflow.runIds.includes(approval.runId)),
  );
  useEffect(() => {
    // An existing draft also records an explicit removal; late history must never overwrite it.
    if (!conversation || loadedHistory?.id !== conversation.id || session.getSnapshot().drafts[scope]) return;
    session.changeDraft(scope, () => draftFromHistory(messages, workflows));
  }, [conversation?.id, loadedHistory, scope, session, messages, workflows]);
  // A message that called several participants shows its team as a swarm does, in any conversation.
  const groupView =
    !!conversation &&
    canUseConversationCollaboration(project, conversation) &&
    (conversation.swarm === true ||
      workflows.some(
        (workflow) => !workflow.delegation && !workflow.deletedAt && (workflow.input.participants?.length ?? 0) > 1,
      ));
  const peerLines = groupView && swarmLines?.conversationId === conversation?.id ? swarmLines.lines : undefined;
  // Lane tasks live in other conversations, so the broadcast window adds them to this chat's full history.
  const plan = useMemo(
    () =>
      conversation && !groupView
        ? conversationPlan(
            [...workflows, ...(state.workflows ?? []).filter((item) => item.conversationId !== conversation.id)],
            state.conversations ?? [],
            conversation.id,
          )
        : undefined,
    [conversation?.id, groupView, workflows, state.workflows, state.conversations],
  );
  const trajectoryRunId = conversationTrajectoryRunId(conversation?.id, workflows, state.runs);
  useEffect(() => {
    const workflow = traceRequest && workflows.find((item) => item.runIds.includes(traceRequest.runId));
    if (!conversation || !workflow) return;
    setTraceSelection({ workflowId: workflow.id, runId: traceRequest!.runId });
    setTraceFor(conversation.id);
  }, [traceRequest?.nonce, conversation?.id, Boolean(workflows.length)]);
  const contextRun = conversationContextRun(conversation?.id, workflows, state.runs);
  const timelineRows = useMemo(() => conversationTimeline(messages, workflows), [messages, workflows]);
  const railMessages = useMemo(
    () => timelineRows.flatMap((row) => (row.kind === 'message' ? [row.message] : [])),
    [timelineRows],
  );
  const [pinSnapshot, setPinSnapshot] = useState<Conversation>();
  const [pinBusy, setPinBusy] = useState(false);
  const pinBusyRef = useRef(false);
  const [jumpMessageId, setJumpMessageId] = useState<string>();
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The pinned message window: one at a time, never moving the history when it opens. */
  const [pinWindow, setPinWindow] = useState<{ open?: string; last?: string; recent?: string }>({});
  const pinRecentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setPinSnapshot(undefined);
    setJumpMessageId(undefined);
    setPinWindow({});
    clearTimeout(highlightTimer.current);
    clearTimeout(pinRecentTimer.current);
    return () => {
      clearTimeout(highlightTimer.current);
      clearTimeout(pinRecentTimer.current);
    };
  }, [conversation?.id]);
  function openPin(messageId: string) {
    clearTimeout(pinRecentTimer.current);
    setPinWindow({ open: messageId, last: messageId });
  }
  function closePin(minimized: boolean) {
    clearTimeout(pinRecentTimer.current);
    setPinWindow((value) => ({ last: value.open ?? value.last, recent: minimized ? value.open : undefined }));
    if (minimized)
      pinRecentTimer.current = setTimeout(() => setPinWindow((value) => ({ ...value, recent: undefined })), 1200);
  }
  const pins: readonly ConversationMessagePin[] =
    pinSnapshot &&
    conversation &&
    pinSnapshot.id === conversation.id &&
    (pinSnapshot.pinnedMessagesRevision ?? 0) > (conversation.pinnedMessagesRevision ?? 0)
      ? (pinSnapshot.pinnedMessages ?? [])
      : (conversation?.pinnedMessages ?? []);
  const pinnedIds = new Set(pins.map((pin) => pin.messageId));
  const pinGutter = useMessageGutter(scrollRef, `${conversation?.id}:${messages.length > 0}`);
  const openPinned = pinWindow.open ? pins.find((pin) => pin.messageId === pinWindow.open) : undefined;
  const openPinnedMessage = openPinned && messages.find((message) => message.id === openPinned.messageId);
  async function updatePin(messageId: string, update: PinUpdate) {
    const id = conversation?.id;
    if (!id || pinBusyRef.current) return;
    pinBusyRef.current = true;
    setPinBusy(true);
    try {
      const value = await api<Conversation>(
        `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/pin`,
        update,
        'PATCH',
      );
      if (scopeRef.current === `conversation:${id}` && mounted.current) setPinSnapshot(value);
    } catch (error) {
      if (mounted.current) notify({ tone: 'error', message: errorText(error) });
    } finally {
      pinBusyRef.current = false;
      if (mounted.current) setPinBusy(false);
    }
  }
  async function refreshPins() {
    const id = conversation?.id;
    if (!id || pinBusyRef.current) return;
    pinBusyRef.current = true;
    setPinBusy(true);
    try {
      const value = await api<{
        conversation: Conversation;
        messages: ConversationMessage[];
        workflows: Workflow[];
        usageRuns?: import('../shared/usage').UsageRun[];
        conversationPresentationRevisions?: Record<string, string>;
      }>(`/api/conversations/${encodeURIComponent(id)}`, undefined, 'GET');
      if (scopeRef.current === `conversation:${id}` && mounted.current) {
        setPinSnapshot(value.conversation);
        setLoadedHistory({
          id,
          messages: value.messages,
          workflows: value.workflows ?? [],
          usageRuns: value.usageRuns,
          conversationPresentationRevisions: value.conversationPresentationRevisions,
        });
      }
    } catch (error) {
      if (mounted.current) notify({ tone: 'error', message: errorText(error) });
    } finally {
      pinBusyRef.current = false;
      if (mounted.current) setPinBusy(false);
    }
  }
  function jumpToMessage(id: string) {
    const timeline = conversationTimeline(messages, workflows, state.runs);
    const index = timeline.findIndex((row) =>
      row.kind === 'message'
        ? row.message.id === id
        : row.kind === 'delegation-group' &&
          row.children.some((child) => child.messages.some((item) => item.id === id)),
    );
    if (index < 0) return notify({ tone: 'info', message: '原消息暂未载入，请刷新置顶状态。' });
    setFollowing(false);
    growFrom.current = undefined;
    setShownRows((count) => Math.max(count, timeline.length - index));
    setJumpMessageId(id);
  }
  const handledSearch = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (!searchTarget || handledSearch.current === searchTarget || loadedHistory?.id !== conversation?.id) return;
    handledSearch.current = searchTarget;
    jumpToMessage(searchTarget.messageId);
  }, [searchTarget, loadedHistory, conversation?.id]);
  useLayoutEffect(() => {
    if (!jumpMessageId || !scrollRef.current) return;
    const target = [...scrollRef.current.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (node) => node.dataset.messageId === jumpMessageId,
    );
    if (!target) return;
    let ancestor: HTMLElement | null = target;
    while (ancestor && ancestor !== scrollRef.current) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
    target.classList.add('pinned-jump-highlight');
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => target.classList.remove('pinned-jump-highlight'), 1600);
    setJumpMessageId(undefined);
  }, [jumpMessageId, shownRows]);
  function viewPinnedTask(id: string) {
    const workflow = workflows.find((item) => item.id === id);
    const runId = workflow?.runIds.at(-1);
    if (runId) onInspect(runId);
    else if (workflow) jumpToMessage(workflow.userMessageId);
  }
  const { active, steeringRun, caption: steeringCaption } = resolveComposerSteering(state, conversation?.id);
  const stopTarget =
    workflows
      .filter((workflow) => !workflow.delegation && isExecutingWorkflow(workflow))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ??
    (active && isExecutingWorkflow(active) ? active : undefined);
  const running = Boolean(active && isExecutingWorkflow(active));
  const autoSteer = state.settings.steerOnSend !== false;
  const ctrlEnter = state.settings.composerSendKey === 'ctrl-enter';
  const modifier = state.app.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const sendShortcut = ctrlEnter ? `${modifier}+Enter` : 'Enter';
  const queueShortcut = ctrlEnter ? `${modifier}+Shift+Enter` : `${modifier}+Enter`;
  const shortcutHintText =
    running && ctrlEnter
      ? autoSteer
        ? 'Ctrl+Enter：补充给当前任务 · Ctrl+Shift+Enter：排在后面'
        : 'Ctrl+Enter：排在后面 · Ctrl+Shift+Enter：补充给当前任务'
      : running
        ? autoSteer
          ? 'Enter：补充给当前任务 · Ctrl+Enter：排在后面'
          : 'Enter：排在后面 · Ctrl+Enter：补充给当前任务'
        : undefined;
  const shortcutHint = shortcutHintText && translateInterfaceText(shortcutHintText).replaceAll('Ctrl+', `${modifier}+`);
  const hasSchedule = Boolean(deadline || notBefore || priority === 'high' || !preferExpiringQuota);
  const emptyComposer = !content.trim() && !attachments.length && !quotes.length;
  const firstQueued = conversation ? conversationQueuedMessages(state.workflows ?? [], conversation.id)[0] : undefined;
  const emptySteerAvailable =
    emptyComposer && !hasSchedule && !verification.trim() && Boolean(steeringRun && firstQueued);
  const hint = [
    state.settings.decisionMode === 'confirm' ? '运行前先确认执行方案' : '',
    composerReadOnly ? '只读：这次不会改文件' : '',
  ]
    .filter(Boolean)
    .map(translateInterfaceText)
    .join(' · ');
  const execution = workspaceExecutionSelection(state, policy, runtimeId);
  const directSearch =
    webSearchCommand(content) !== undefined &&
    !(
      draft.called?.length ||
      draft.freeChain ||
      (draft.agentPresetId && !['standard', 'auto'].includes(draft.agentPresetId))
    );
  const chosenRuntime = execution.chosenRuntime;
  const selectedModel = cursorModelForPin(execution.models, model);
  const mediaModelChosen = execution.mediaModels.some((item) => item.id === model);
  useEffect(() => setModelFallback(''), [scope]);
  useEffect(() => {
    if (
      draft.writer ||
      !model ||
      state.refreshing ||
      chosenRuntime?.status !== 'ready' ||
      !execution.models.length ||
      selectedModel ||
      mediaModelChosen
    )
      return;
    selectRoute({ model: '', effort: '' });
    setModelFallback('所选模型已不可用，已改为自动。');
  }, [scope, draft.writer, runtimeId, model, state.refreshing, chosenRuntime, selectedModel?.id, mediaModelChosen]);
  const proposal = state.workflows?.find(
    (workflow) =>
      workflow.conversationId === conversation?.id &&
      workflow.status === 'waiting-confirmation' &&
      workflow.input.content === content &&
      workflow.routingReview?.original.runtimeId === runtimeId &&
      (workflow.routingReview.original.model ?? '') === model,
  )?.routingReview?.proposal;
  const effortChoice = composerEfforts(chosenRuntime, model, proposal);
  const unavailableRuntime = execution.unavailable;
  const inProject = project && project.scope !== 'chat';
  useEffect(() => {
    queuePendingRef.current = false;
    setQueuePending(false);
    setDeadline('');
    setNotBefore('');
    setPriority('normal');
    setPreferExpiringQuota(true);
    setFollowing(true);
    setDragging(false);
    dragDepth.current = 0;
    composition.current = { active: false, endedAt: -Infinity };
    inputRef.current?.focus();
  }, [conversation?.id, project?.id]);
  useEffect(() => {
    mounted.current = true;
    if (!composerSession) ownComposerSession.activate();
    return () => {
      mounted.current = false;
      sendAfter.current = undefined;
      if (!composerSession) ownComposerSession.dispose();
    };
  }, [composerSession, ownComposerSession]);
  // Follow new rows before paint, including optimistic sends and the composer shrinking after Enter.
  useLayoutEffect(() => {
    if (following && scrollRef.current && !scrollRef.current.dataset.turnFolding)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pendingSends, state.runs, state.workflows, following, tallComposer, attachments.length, quotes.length]);
  async function syncGrokHistory() {
    if (!conversation?.grokHistory || syncRequest.current.pending) return;
    const capturedScope = scope;
    const token = ++syncRequest.current.token;
    const isCurrent = () => syncRequest.current.scope === capturedScope && syncRequest.current.token === token;
    syncRequest.current.pending = true;
    setGrokSync({ scope: capturedScope, token, pending: true });
    try {
      const synced = await syncWorkspaceGrokHistory(api, conversation.projectId);
      if (!isCurrent()) return;
      historyRequest.current++;
      setLoadedHistory((previous) => ({
        id: synced.result.conversationId,
        messages: synced.messages,
        workflows: synced.workflows,
        usageRuns: previous?.id === synced.result.conversationId ? previous.usageRuns : undefined,
      }));
      setGrokSync({ scope: capturedScope, token, pending: false, result: synced.result });
    } catch (error) {
      if (!isCurrent()) return;
      const message = `${errorText(error)}。现有记录已保留，请重试同步。`;
      setGrokSync({ scope: capturedScope, token, pending: false, error: message });
      notify({ tone: 'error', message });
    } finally {
      if (isCurrent()) syncRequest.current.pending = false;
    }
  }
  async function toggleQueueing() {
    if (!conversation || sendingRef.current || queuePendingRef.current || queueingRequests.current.has(scope)) return;
    const capturedScope = scope;
    const enabled = conversation.queueingEnabled === false;
    queueingRequests.current.add(capturedScope);
    setQueueingScopes([...queueingRequests.current]);
    try {
      await setConversationQueueing(api, conversation.id, enabled);
      notify({
        tone: 'success',
        message: enabled ? '已开启消息排队。' : '已关闭排队；现有排队消息保留。',
      });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      queueingRequests.current.delete(capturedScope);
      setQueueingScopes([...queueingRequests.current]);
    }
  }
  async function steerEmptyComposer() {
    if (
      !emptyComposer ||
      hasSchedule ||
      verification.trim() ||
      sendingRef.current ||
      emptySteerRequests.current.has(scope) ||
      queuePendingRef.current ||
      !steeringRun
    )
      return;
    const capturedScope = scope;
    const token = Symbol();
    emptySteerRequests.current.set(capturedScope, token);
    setEmptySteerScopes([...emptySteerRequests.current.keys()]);
    setSendingLabel('正在插入首条排队消息…');
    try {
      if (await steerFirstQueuedMessage(api, state, conversation?.id))
        notify({ tone: 'success', message: '首条排队消息已插入当前任务，消息记录保留。' });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      if (emptySteerRequests.current.get(capturedScope) === token) {
        emptySteerRequests.current.delete(capturedScope);
        setEmptySteerScopes([...emptySteerRequests.current.keys()]);
      }
    }
  }
  function pickFile(item: FileReference) {
    if (!fileQuery) return;
    const next = insertFileReference(content, fileQuery, item);
    setContent(next.text);
    setFileQuery(undefined);
    setMentionQuery(undefined);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }
  async function runSlash(command: SlashCommand) {
    setSlashOpen(false);
    const capturedScope = scope;
    const remaining = content.slice(slashText.length);
    if (command === '搜索') {
      const prefix = '/搜索 ';
      changeDraft(capturedScope, (previous) =>
        previous.content === content ? { ...previous, content: prefix + remaining } : previous,
      );
      setTimeout(() => {
        if (scopeRef.current !== capturedScope) return;
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(prefix.length, prefix.length);
      });
      return;
    }
    try {
      if (command === 'new') {
        const created = await api<Conversation>('/api/conversations', fileProject ? { projectId: fileProject.id } : {});
        if (scopeRef.current === capturedScope) onConversation(created);
      } else if (command === 'plan') {
        if (canPlanFirst) changeDraft(capturedScope, (previous) => ({ ...previous, planFirst: true }));
      } else if (command === 'side') {
        if (!conversation) return;
        openSideChat();
      }
      changeDraft(capturedScope, (previous) =>
        previous.content === content ? { ...previous, content: remaining } : previous,
      );
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    }
  }
  function pickMention(item: MentionItem) {
    const at = mentionQuery;
    if (!at || calledKeys.has(participantKey(item))) return;
    const before = content.slice(0, at.start) + `${'@'.repeat(at.tier)}${item.name} `;
    const next = before + content.slice(at.start + at.tier + at.query.length).replace(/^ /, '');
    changeDraft(scope, (previous) => pickDraftMention(previous, item, next));
    setMentionQuery(undefined);
    // After React has put the new text in the box, park the caret right after the name.
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(before.length, before.length);
    });
  }
  /** The 「+」 menu's way in: puts @ at the caret (after a space if needed) and opens the list there. */
  function callSomeone() {
    const box = inputRef.current;
    const start = Math.min(box?.selectionStart ?? content.length, content.length);
    const end = Math.max(start, Math.min(box?.selectionEnd ?? start, content.length));
    const before = content.slice(0, start);
    const inserted = `${before && !/\s$/u.test(before) ? ' ' : ''}@`;
    const caret = start + inserted.length;
    changeDraft(scope, (previous) => ({ ...previous, content: before + inserted + content.slice(end) }));
    setMentionQuery({ start: caret - 1, tier: 1, query: '' });
    setFileQuery({ start: caret - 1, query: '' });
    setMentionIndex(0);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }
  function submitComposer(ctrlKey = false, textOnlyChosen = false) {
    const queue = running ? (autoSteer ? ctrlKey : !ctrlKey) : undefined;
    return emptyComposer ? (queue ? undefined : steerEmptyComposer()) : send(queue, undefined, textOnlyChosen);
  }
  /**
   * `typed` is the composer's text, or a question card's answer (only offered while the composer is empty).
   * `textOnlyChosen`: the user chose to send a text-only agent the words alone, without the files.
   */
  async function send(queue?: boolean, typed = content, textOnlyChosen = false) {
    if (typed.trim() === '/bug') {
      openProblemReport();
      changeDraft(scope, (previous) => ({ ...previous, content: '' }));
      return;
    }
    if (changingProfileRequest.current) return;
    if ((!typed.trim() && !attachments.length && !quotes.length) || emptySteerRequests.current.has(scope)) return;
    // Enter pressed while the previous message is still going out is kept and sent right after it, not lost.
    if (sendingRef.current) {
      if (wakingInstabox.current) {
        notify({ tone: 'info', message: '正在唤醒服务器，请稍候。' });
        return;
      }
      // A card answer is kept; composer text is read again when the replay runs.
      sendAfter.current = { scope, queue, ...(typed !== content ? { answer: typed } : {}) };
      return;
    }
    // Another mount of this conversation can still have a request awaiting its response.
    if (session.getSnapshot().pendingSends.some((item) => item.scope === scope && !item.messageId && !item.error))
      return;
    if (directSearch && attachments.length) {
      notify({ tone: 'error', message: '直接搜索暂不支持文件或图片附件，请先移除附件。' });
      return;
    }
    // A mixed group still goes out: the server gives the agent the words and the others the files.
    if (!directSearch && textOnly && !textOnly.mixed && !textOnlyChosen) {
      notify({ tone: 'error', message: textOnlyNotice, names: textOnlyNames });
      return;
    }
    const outgoing = textOnly && !textOnly.mixed ? [] : attachments;
    if (unavailableProfile) {
      notify({ tone: 'error', message: '所选路由方案不可用，请选择自动或另一套路由方案。' });
      return;
    }
    if (unavailableRuntime && !directSearch) {
      notify({ tone: 'error', message: '所选执行器不可用，请明确选择其他执行器或自动调度。' });
      return;
    }
    if (!conversation && onBeforeSend) {
      sendingRef.current = true;
      try {
        if (!(await onBeforeSend()) || scopeRef.current !== scope || !mounted.current) return;
      } finally {
        sendingRef.current = false;
      }
    }
    if (
      !queue &&
      !directSearch &&
      called.some(
        (item) =>
          item.kind === 'device' &&
          item.tier === 3 &&
          devices.some(
            (device) =>
              item.id === deviceMentionPrefix + device.id && device.tunnel?.ssh.startsWith('pugport-instabox-'),
          ),
      )
    ) {
      sendingRef.current = true;
      wakingInstabox.current = true;
      setSending(true);
      try {
        const currentView = await api<RemoteServersView>('/api/remote-servers?refresh=instabox', undefined, 'GET');
        if (scopeRef.current !== scope || !mounted.current) return;
        for (const machine of currentView.instabox?.machines ?? []) {
          if (
            !machine.ssh ||
            (machine.state === 'running' && !machine.pendingAction) ||
            !called.some(
              (item) =>
                item.kind === 'device' &&
                item.tier === 3 &&
                devices.some(
                  (device) => `${deviceMentionPrefix}${device.id}` === item.id && device.tunnel?.ssh === machine.ssh,
                ),
            )
          )
            continue;
          setSendingLabel(withNames('正在唤醒 {0}…', [machine.name]));
          try {
            await wakeInstabox(api, machine);
          } catch (error) {
            if (scopeRef.current === scope && mounted.current)
              notify({
                tone: 'error',
                message:
                  error instanceof Error && /60|504/.test(error.message)
                    ? '{0} 60 秒内没醒来，消息没有发出。'
                    : '没能唤醒 {0}，消息没有发出。',
                names: [machine.name],
              });
            return;
          }
          if (scopeRef.current !== scope || !mounted.current) return;
        }
      } catch (error) {
        if (scopeRef.current === scope && mounted.current)
          notify({ tone: 'error', message: error instanceof Error ? error.message : '操作没有完成，请重试。' });
        return;
      } finally {
        sendingRef.current = false;
        wakingInstabox.current = false;
        sendAfter.current = undefined;
        setSending(false);
        setSendingLabel('');
      }
    }
    sendingRef.current = true;
    // Only uploading files keeps the composer busy; a plain message goes out without a wait.
    setSending(outgoing.length > 0);
    setSendingLabel(outgoing.length ? '正在上传附件…' : '');
    const capturedScope = scope;
    const isCurrent = () => mounted.current && scopeRef.current === capturedScope;
    const text = typed.trim() || (quotes.length ? '' : '请查看所附文件或图片，并说明内容与可协助的事项。');
    // Show it now and clear the composer; the draft comes back if sending fails.
    const snapshot = draftsRef.current[capturedScope] ?? draft;
    const pendingId = crypto.randomUUID();
    setPendingSends((list) => [
      ...list,
      {
        id: pendingId,
        scope: capturedScope,
        conversationId: conversation?.id ?? draft.createdConversation?.id,
        content: typed.trim(),
        images: outgoing.flatMap((item) => (item.previewUrl ? [item.previewUrl] : [])),
        quotes: sentQuotes(quotes),
        sentAt: new Date().toISOString(),
        snapshot,
      },
    ]);
    changeDraft(capturedScope, () => ({
      ...draftAfterSend(snapshot),
      createdConversation: snapshot.createdConversation,
    }));
    setFollowing(true);
    let sentConversation = conversation ?? draft.createdConversation;
    const finalizeSend = (target: Conversation, message?: ConversationMessage) => {
      // The pending bubble stays until the real message is in the conversation (or a few seconds pass).
      setPendingSends((list) =>
        list.map((item) =>
          item.id === pendingId
            ? {
                ...item,
                conversationId: target.id,
                messageId: message?.id,
                confirmedMessage: message ? { ...message, clientMessageId: pendingId } : undefined,
              }
            : item,
        ),
      );
      setTimeout(() => {
        setPendingSends((list) => list.filter((item) => item.id !== pendingId));
      }, 60_000);
      changeDraft(capturedScope, (previous) => {
        if (hasDraftContent(previous)) return previous;
        const { createdConversation: _created, ...next } = previous;
        return next;
      });
      if (isCurrent()) {
        setDeadline('');
        setNotBefore('');
        setPriority('normal');
        setPreferExpiringQuota(true);
        setFollowing(true);
        if (!conversation) {
          const destination = `conversation:${target.id}`;
          if (sendAfter.current?.scope === capturedScope) sendAfter.current.scope = destination;
          session.moveScope(capturedScope, destination);
          onConversation(target);
        }
      } else if (!conversation) {
        changeDraft(capturedScope, (previous) => ({ ...previous, called: undefined, stickyCalled: undefined }));
      }
    };
    try {
      const schedule = directSearch
        ? undefined
        : composerMessageSchedule(deadline, notBefore, priority, preferExpiringQuota);
      // One called answers the message itself, as always; several make it one coordinated task (participants).
      const calledNow = snapshot.called ?? [];
      const { agentPresetId: calledRole, runtimeId: calledRuntime, ...outside } = calledFields(calledNow);
      const planFirst =
        snapshot.planFirst &&
        !conversation?.swarm &&
        calledNow.length <= 1 &&
        !outside.deviceId &&
        !outside.externalAgentId;
      const body: MessageInput = directSearch
        ? {
            clientMessageId: pendingId,
            content: text,
            ...(quotes.length ? { quotes: sentQuotes(quotes) } : {}),
            mode: 'chat',
            permissionMode: composerReadOnly ? 'read-only' : 'workspace-write',
            executionPolicy: policy,
          }
        : {
            ...((calledRole ?? snapshot.agentPresetId) ? { agentPresetId: calledRole ?? snapshot.agentPresetId } : {}),
            clientMessageId: pendingId,
            content: text,
            ...(quotes.length ? { quotes: sentQuotes(quotes) } : {}),
            mode: deviceWriteReason ? 'chat' : planFirst ? 'build' : mode,
            ...(outside.deviceId && deviceFolder ? { deviceFolder } : {}),
            ...(planFirst ? { planFirst: true } : {}),
            permissionMode: composerReadOnly ? 'read-only' : 'workspace-write',
            explicitWrite: !composerReadOnly,
            ...(permissionReauthorized.current && !composerReadOnly ? { permissionReauthorized: true } : {}),
            executionPolicy: policy,
            freeChain: snapshot.freeChain,
            allowUnknownQuota: allowUnknown,
            autoEscalate: escalate,
            ...(queue !== undefined ? { queue } : {}),
            ...(review ? { review: true } : {}),
            ...(schedule ? { schedule } : {}),
            // An executor called with @ answers this one message with its own default model and effort.
            ...(snapshot.freeChain ? {} : workspaceRouteFields(calledRuntime ?? runtimeId)),
            ...(model && !calledRuntime && !snapshot.freeChain ? { model } : {}),
            ...(effort && !calledRuntime && !snapshot.freeChain ? { effort } : {}),
            ...(mode !== 'chat' && verification.trim() ? { verificationCommand: verification.trim() } : {}),
          };
      for (const item of calledNow) recordMentionUse(item);
      let target = conversation ?? draft.createdConversation;
      if (body.verificationCommand) {
        const projectId = target?.projectId ?? (inProject ? project.id : undefined);
        if (!projectId) throw new Error('请先选择项目，再批准验收命令。');
        const verificationProject = state.projects?.find((project) => project.id === projectId);
        if (!verificationProject?.approvedVerificationCommands?.includes(body.verificationCommand)) {
          const change = desktopBridge()?.changePermission;
          if (!change) throw new Error('请在桌面应用中修改权限。');
          if (!(await change({ kind: 'verification', projectId, command: body.verificationCommand })))
            throw new Error('验收命令未获批准，消息未发送。');
        }
      }
      if (!target) {
        target = await ensureDraftConversation();
        const created = target;
        snapshot.createdConversation = created;
        changeDraft(capturedScope, (previous) => ({ ...previous, createdConversation: created }));
      }
      const targetId = target.id;
      if (!conversation) saveComposerSelection(targetId, remembered);
      sentConversation = target;
      const attachmentIds = await uploadDraftAttachments(api, targetId, outgoing, isCurrent, (id, attachment) => {
        snapshot.attachments = snapshot.attachments.map((item) =>
          item.id === id ? { ...item, uploaded: { conversationId: targetId, attachment } } : item,
        );
      });
      if (!isCurrent()) throw new AttachmentScopeChanged();
      setSendingLabel('正在发送…');
      if (body.permissionReauthorized) permissionReauthorized.current = false;
      const sent = await api<{ message: ConversationMessage; notice?: string }>(
        `/api/conversations/${encodeURIComponent(targetId)}/messages`,
        {
          ...body,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          // An external agent called with @ answers this message itself, instead of PugPort's executors; a device
          // called with @ takes it to another computer; several called go to a coordinator together.
          ...outside,
        },
      );
      if (sent.message?.steering?.status === 'failed') {
        sendAfter.current = undefined;
        notify({ tone: 'error', message: sent.message.steering.error || '补充未确认送达，请核对当前任务。' });
      }
      if (sent.notice) notify({ tone: 'info', message: sent.notice });
      finalizeSend(target, sent.message);
    } catch (error) {
      // A broadcast can confirm delivery before the HTTP response fails, including a newly created chat.
      sendAfter.current = undefined;
      const confirmed =
        session.confirmedMessage(pendingId, sentConversation?.id) ??
        latestMessages.current.find(
          (message) => message.conversationId === sentConversation?.id && message.clientMessageId === pendingId,
        );
      if (confirmed && sentConversation) {
        finalizeSend(sentConversation, confirmed);
        notify({ tone: 'error', message: errorText(error) });
        return;
      }
      const nextDraft = session.getSnapshot().drafts[capturedScope] ?? emptyDraft();
      if (hasDraftContent(nextDraft)) {
        // Keep the failed message available without overwriting the next unsent message.
        setPendingSends((list) =>
          list.map((item) => (item.id === pendingId ? { ...item, error: errorText(error) } : item)),
        );
      } else {
        changeDraft(capturedScope, () => snapshot);
        setPendingSends((list) => list.filter((item) => item.id !== pendingId));
      }
      notify({ tone: error instanceof AttachmentScopeChanged ? 'info' : 'error', message: errorText(error) });
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingLabel('');
      if (sendAfter.current) {
        const next = sendAfter.current;
        sendAfter.current = undefined;
        // The next message waits for this render, so it reads the composer as it is now.
        setTimeout(() => sendLatest.current(next.scope, next.queue, next.answer), 0);
      }
    }
  }
  sendLatest.current = (expectedScope, queue, answer) => {
    if (scope === expectedScope) void send(queue, answer);
  };
  function addFiles(files: readonly File[], targetScope = scope) {
    if (!files.length) return;
    const previous = draftsRef.current[targetScope] ?? emptyDraft();
    const { accepted, errors } = selectAttachmentFiles(previous.attachments, files);
    if (accepted.length) {
      const additions: DraftAttachment[] = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        ...(isAttachmentImage(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
      }));
      changeDraft(targetScope, (value) => ({ ...value, attachments: [...value.attachments, ...additions] }));
      inputRef.current?.focus();
    }
    if (errors.length) notify({ tone: 'error', message: errors.join(' ') });
  }
  function removeAttachment(id: string) {
    changeDraft(scope, (previous) => ({
      ...previous,
      attachments: previous.attachments.filter((value) => value.id !== id),
      quotes: previous.quotes?.filter((quote) => quote.attachmentDraftId !== id),
    }));
  }
  async function cancelActive() {
    if (!stopTarget || cancelling) return;
    setCancelling(true);
    try {
      await api(`/api/workflows/${stopTarget.id}/cancel`, {});
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setCancelling(false);
    }
  }
  /** Closes the side panel when it shows a side chat that was just moved or deleted. */
  function closeSavedSideChat(id: string) {
    setSideChats((previous) => {
      if (previous[scope]?.launch.existingConversationId !== id) return previous;
      const next = { ...previous };
      delete next[scope];
      return next;
    });
  }
  function openSavedSideChat(saved: Conversation) {
    if (!conversation) return;
    const launch = savedSideChatLaunch(saved, conversation.id);
    setSideChats((previous) => ({ ...previous, [scope]: { launch, open: true } }));
  }
  function openSideChat(quote?: string, anchorMessageId?: string, forceNew = false) {
    if (!conversation) return;
    if (!quote && !forceNew && sideChat) {
      setSideChats((previous) => ({ ...previous, [scope]: { ...previous[scope], open: true } }));
      return;
    }
    if (!quote && !forceNew && savedSideChats.length) {
      openSavedSideChat(savedSideChats.at(-1)!);
      return;
    }
    const launch: SideChatLaunch = {
      requestId: crypto.randomUUID(),
      parentConversationId: conversation.id,
      anchorMessageId,
      quote,
      selection: inheritSideChatSelection(state, conversation.id, {
        ...workspaceRouteFields(runtimeId),
        model: model || undefined,
        effort: effort || undefined,
        executionPolicy: policy,
      }),
    };
    setSideChats((previous) => ({ ...previous, [scope]: { launch, open: true } }));
  }
  const queuedSideChat = (workflow: Workflow) => {
    onSideChat?.(workflow);
    openSideChat(workflow.input.content, workflow.userMessageId);
  };
  // This conversation's taste test: while it is written and waits for a pick, and its result for a while after.
  const tasteTest =
    conversation && !conversation.incognito
      ? (state.tasteTests ?? []).find(
          (test) =>
            test.conversationId === conversation.id &&
            !closedTastes.has(test.id) &&
            (test.status === 'writing' ||
              test.status === 'ready' ||
              test.status === 'failed' ||
              (test.status === 'chosen' && Date.now() - Date.parse(test.updatedAt) < 10 * 60_000)),
        )
      : undefined;
  const pendingItems = useMemo(
    () =>
      pendingSends.filter((item) => (conversation ? item.conversationId === conversation.id : item.scope === scope)),
    [pendingSends, conversation?.id, scope],
  );
  const recoverPending = (item: PendingComposerSend) => {
    if (hasDraftContent(session.getSnapshot().drafts[item.scope] ?? emptyDraft())) return;
    changeDraft(item.scope, () => item.snapshot);
    setPendingSends((list) => list.filter((value) => value.id !== item.id));
    inputRef.current?.focus();
  };
  const modsAllowed = modSurfaces && canAttachMod(conversation);
  const modBinding = experience.view ? experience.view.binding : conversation?.modeBinding;
  const modHidden = conversation?.modeHidden === true;
  const modLayout = resolveModLayout(
    experience.view?.manifest,
    modHidden,
    !!sideChat?.open,
    modsAllowed && !!modBinding,
  );
  const hasModSurface = modLayout.hasSurface;
  const modWorkspace = modLayout.main === 'mod' || (modsAllowed && !!modBinding && !modHidden && !experience.view);
  const pinLayout = pinRailLayout(modWorkspace ? 0 : pinGutter, pins.length);
  const modMetadata =
    experience.view?.manifest ??
    experience.catalog?.catalog.find((item) => item.id === modBinding?.modeId && item.version === modBinding?.version);
  const modMetadataRequests = useRef(new Set<string>());
  useEffect(() => {
    if (!modWorkspace || !experience.error || experience.view || experience.catalog || !modBinding) return;
    const key = `${modBinding.modeId}:${modBinding.version}`;
    if (modMetadataRequests.current.has(key)) return;
    modMetadataRequests.current.add(key);
    void experience.loadCatalog();
  }, [modWorkspace, experience.error, experience.view, experience.catalog, modBinding?.modeId, modBinding?.version]);
  const [, redrawModChat] = useState(0);
  const modChatOpen = modWorkspace && modChatSessions.get(scope) === true;
  const modWorkspaceRef = useRef<HTMLDivElement>(null);
  const modBodyRef = useRef<HTMLDivElement>(null);
  const modDrawerRef = useRef<HTMLElement>(null);
  const modChatToggle = useRef<HTMLButtonElement>(null);
  const modChatGeneration = useRef(0);
  const modChatId = useId();
  const [modPlacement, setModPlacement] = useState<'beside' | 'over'>('over');
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  const modHistoryReady = !!conversation && loadedHistory?.id === conversation.id;
  if (modHistoryReady && !modSeenReplies.has(scope)) modSeenReplies.set(scope, lastAssistant);
  const modUnread =
    !modChatOpen &&
    modSeenReplies.has(scope) &&
    lastAssistant !== undefined &&
    modSeenReplies.get(scope) !== lastAssistant;
  const setModChat = (open: boolean) => {
    const returnFocus = !open && !!modDrawerRef.current?.contains(document.activeElement);
    modChatSessions.set(scope, open);
    modChatGeneration.current++;
    if (open && modHistoryReady) modSeenReplies.set(scope, lastAssistant);
    redrawModChat((value) => value + 1);
    if (returnFocus) modChatToggle.current?.focus();
  };
  useEffect(() => {
    if (modChatOpen && modHistoryReady) modSeenReplies.set(scope, lastAssistant);
  }, [scope, lastAssistant, modChatOpen, modHistoryReady]);
  useEffect(() => {
    if (!modWorkspace || !modBodyRef.current) return;
    const body = modBodyRef.current;
    const measure = () => setModPlacement(modChatPlacement(body.clientWidth, window.innerWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [modWorkspace]);
  useEffect(() => {
    if (!modWorkspace) return;
    const key = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'j'
      ) {
        event.preventDefault();
        setModChat(!modChatOpen);
      }
    };
    const workspace = modWorkspaceRef.current;
    workspace?.addEventListener('keydown', key);
    return () => workspace?.removeEventListener('keydown', key);
  }, [modWorkspace, modChatOpen, scope, lastAssistant]);
  useEffect(() => {
    if (!modChatOpen) return;
    inputRef.current?.focus();
    const drawer = modDrawerRef.current;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      const generation = modChatGeneration.current;
      // Let document-level menu/picker handlers consume Escape before the drawer reacts.
      setTimeout(() => {
        if (
          !event.defaultPrevented &&
          generation === modChatGeneration.current &&
          scopeRef.current === scope &&
          modDrawerRef.current === drawer &&
          modChatSessions.get(scope) === true &&
          drawer?.contains(document.activeElement)
        )
          setModChat(false);
      }, 0);
    };
    drawer?.addEventListener('keydown', key);
    return () => drawer?.removeEventListener('keydown', key);
  }, [modChatOpen, scope]);
  const insertModDraft = (text: string, mode: 'append' | 'replace' = 'append') => {
    if (modWorkspace) setModChat(true);
    changeDraft(scope, (previous) => ({
      ...previous,
      content: mode === 'replace' ? text : [previous.content, text].filter(Boolean).join('\n\n'),
    }));
    requestAnimationFrame(() => {
      if (scopeRef.current === scope) inputRef.current?.focus();
    });
  };
  const modVoiceDevices = useMemo(() => browserVoiceDevices(api), [api]);
  const modHost = useModHost({
    enabled: modsAllowed,
    conversation,
    project,
    view: experience.view,
    hostVersion: state.app.version,
    messages,
    read: experience.readState,
    save: experience.saveState,
    insert: insertModDraft,
    chat: setModChat,
    toggleChat: () => setModChat(!modChatOpen),
    notify: (title, message) => notify({ tone: 'info', message: '{0} · {1}', names: [title, message] }),
    runModel: experience.runModel,
    cancelModel: experience.cancelModel,
    voiceDevices: modVoiceDevices,
    api,
  });
  const modWeb = modHost
    ? {
        host: modHost,
        chatOpen: modChatOpen,
        onOpenChat: () => setModChat(true),
        running,
        state: experience.view?.instance
          ? { revision: experience.view.instance.revision, values: experience.view.instance.state }
          : undefined,
        messages: { count: messages.length, ...(messages.length ? { lastId: messages[messages.length - 1]!.id } : {}) },
        runs: experience.view?.runs,
      }
    : undefined;
  const localModBuild = useLocalModBuild(api, conversation, state.runs, workflows);
  useModDiagnosticsUpload(api, localModBuild?.id, conversation?.id);
  const modDebugState = useModDebug(conversation?.id);
  const debugManifest = experience.view?.manifest;
  const declaredPermissions = debugManifest?.permissions ?? [];
  const modDebug: ModDebugInfo | undefined =
    localModBuild && debugManifest && conversation
      ? {
          errors: modDebugState.errors,
          logs: modDebugState.logs,
          entries: modDebugState.entries,
          permissions: {
            declared: declaredPermissions,
            approval: conversation.modApproval
              ? 'waiting'
              : declaredPermissions.some((item) => MOD_APPROVAL_PERMISSIONS.includes(item))
                ? 'approved'
                : 'none',
          },
          ...(localModBuild.lastLoad
            ? {
                validation: {
                  ok: localModBuild.lastLoad.ok,
                  warnings: localModBuild.lastLoad.warnings ?? [],
                  issues: localModBuild.lastLoad.issues ?? [],
                },
              }
            : {}),
          onReload: () => requestModReload(conversation.id),
          onSendToChat: () => {
            insertModDraft(modDebugDraft(debugManifest.title, debugManifest.version, modDebugState.entries), 'append');
            setModChat(true);
          },
        }
      : undefined;
  const modToolbar = modsAllowed && conversation && (
    <ModToolbarButton
      installed={
        experience.catalog?.catalog.filter((item) =>
          experience.catalog?.installed.some(
            (installed) => installed.modeId === item.id && installed.version === item.version,
          ),
        ) ??
        (experience.view?.installed && experience.view.manifest
          ? [{ ...experience.view.manifest, compatible: true }]
          : [])
      }
      binding={modBinding}
      pendingBinding={experience.view ? experience.view.pending : conversation.pendingModeBinding}
      mode={experience.view?.manifest ?? undefined}
      hidden={modHidden}
      hasSurface={hasModSurface}
      busy={experience.busy || removingMod || !!conversation.closedAt}
      loading={experience.loading}
      error={experience.error}
      onRetry={() => {
        void experience.reload().catch((error) => notify({ tone: 'error', message: friendlyModError(error).text }));
      }}
      onOpen={() => void experience.loadCatalog()}
      onStore={() => onOpenModeStore?.(conversation.id)}
      onToggle={() => {
        void experience
          .setHidden(!modHidden)
          .then(() => reload())
          .catch((error) => notify({ tone: 'error', message: friendlyModError(error).text }));
      }}
      onSelect={(modeId) => {
        const version = experience.catalog?.installed.find((item) => item.modeId === modeId)?.version;
        void experience
          .select(modeId, version)
          .then(async (view) => {
            if (!mounted.current || scopeRef.current !== scope) return;
            if (view.pending) notify({ tone: 'info', message: '本轮结束后切换' });
            await reload();
          })
          .catch((error) => notify({ tone: 'error', message: friendlyModError(error).text }));
      }}
    />
  );
  return (
    <div
      className={`conversation-with-side-chat ${modWorkspace ? 'mod-workspace-active' : sideChat?.open ? 'side-chat-open' : ''}`}
      ref={modWorkspaceRef}
    >
      {modWorkspace && (
        <ModWorkspaceBar
          mode={modMetadata ?? undefined}
          chatOpen={modChatOpen}
          unread={modUnread}
          running={running}
          mac={state.app.platform === 'darwin'}
          chatId={modChatId}
          chatToggle={modChatToggle}
          busy={experience.busy || removingMod || experience.view?.pending?.binding === null}
          onChat={() => setModChat(!modChatOpen)}
          onDetails={() =>
            modBinding && (onModDetails ? onModDetails(modBinding.modeId) : onOpenModeStore?.(conversation!.id))
          }
          onHide={() =>
            void experience
              .setHidden(true)
              .then(() => reload())
              .catch((error) => notify({ tone: 'error', message: friendlyModError(error).text }))
          }
          onRemove={() => onRemoveMod?.()}
          debug={modDebug}
        />
      )}
      <div
        className={modWorkspace ? 'mod-workspace-body' : 'mod-workspace-body-normal'}
        ref={modBodyRef}
        data-chat={modPlacement}
      >
        {(modLayout.mainView.mounted || modWorkspace) && (
          <div className="mod-workspace-surface" hidden={!modWorkspace}>
            {modWeb && modLayout.mainView.mounted ? (
              <ModFrame
                key={`${conversation!.id}:${modHost!.instanceId}:main`}
                {...modWeb}
                slot="mainView"
                hidden={!modWorkspace}
              />
            ) : experience.error ? (
              <ModFailure
                mode={modMetadata ?? undefined}
                onReload={() => void experience.reload().catch(() => undefined)}
                onOpenChat={() => setModChat(true)}
              />
            ) : (
              <ModLoading title={modMetadata?.title ?? 'Mod'} />
            )}
          </div>
        )}
        <section
          ref={modDrawerRef}
          id={modChatId}
          hidden={modWorkspace && !modChatOpen}
          role={modWorkspace ? 'region' : undefined}
          className={`conversation-workspace ${modWorkspace ? 'mod-chat-drawer' : ''} ${dragging ? 'attachment-dragging' : ''}`}
          aria-label={modWorkspace ? '聊天' : inProject ? '项目对话' : '日常对话'}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              if (--dragDepth.current <= 0) {
                dragDepth.current = 0;
                setDragging(false);
              }
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              dragDepth.current = 0;
              setDragging(false);
              addFiles(filesFromTransfer(event.dataTransfer));
            }
          }}
        >
          {dragging && (
            <div className="attachment-drop-hint" aria-hidden="true">
              <Paperclip size={22} />
              <strong>松开以添加文件或图片</strong>
              <span>最多 8 个 · 每个 50 MB · 合计 200 MB</span>
            </div>
          )}
          <div className="conversation-toolbar" hidden={modWorkspace} onContextMenu={onConversationMenu}>
            <div className="conversation-heading">
              <div className="conversation-title-line">
                <strong title={shownTitle(conversation?.title ?? '新对话')} translate="no">
                  {shownTitle(conversation?.title ?? '新对话')}
                </strong>
                {conversation?.incognito && <IncognitoLabel />}
                {conversation && !groupView && canUseConversationCollaboration(project, conversation) && (
                  <DelegationTree
                    key={conversation.id}
                    conversation={conversation}
                    liveWorkflows={(state.workflows ?? []).filter((item) => item.conversationId === conversation.id)}
                    state={state}
                    active
                    api={api}
                    reload={reload}
                    notify={notify}
                    onActivate={async () => true}
                    onInspect={onInspect}
                  />
                )}
                <ContextUsage
                  context={contextRun?.context}
                  executor={
                    contextRun?.account?.label ??
                    state.runtimes.find((r) => r.id === contextRun?.route.runtimeId)?.label ??
                    contextRun?.route.runtimeId ??
                    ''
                  }
                />
                {conversation?.swarm && (
                  <button
                    type="button"
                    className={`conversation-trajectory-button ${conversation?.swarm ? 'open' : ''}`}
                    aria-label={conversation?.swarm ? '切回普通对话' : '打开蜂群模式'}
                    title={
                      conversation?.swarm
                        ? '回到普通对话；正在工作的成员会继续做完'
                        : '蜂群模式：主 agent 可以招募多个成员分工协作，你能看到并直接指挥每个成员'
                    }
                    aria-pressed={conversation?.swarm ?? false}
                    disabled={swarmBusy}
                    onClick={() => {
                      const enabled = !conversation?.swarm;
                      setSwarmBusy(true);
                      void (async () => {
                        try {
                          const id = conversation?.id ?? (await ensureMediaConversation());
                          let message = '已进入蜂群模式：左边是成员，右边是协作图，在下方给主 agent 布置任务。';
                          if (enabled) await api(`/api/conversations/${id}`, { swarm: true }, 'PATCH');
                          else message = await leaveSwarm(api, id, state.workflows);
                          await reload();
                          notify({ tone: 'success', message });
                        } catch (error) {
                          notify({ tone: 'error', message: errorText(error) });
                        } finally {
                          setSwarmBusy(false);
                        }
                      })();
                    }}
                  >
                    <GitBranch size={14} aria-hidden="true" />
                    {conversation?.swarm ? '退出蜂群' : '蜂群'}
                  </button>
                )}
              </div>
              {conversation?.archivedAt && (
                <span>
                  已归档 ·{' '}
                  <button
                    type="button"
                    className="archive-text-button"
                    onClick={() => void archiveConversation(api, notify, conversation, false)}
                  >
                    取消归档
                  </button>
                </span>
              )}
              {inProject && (
                <span title={project.path}>
                  <FolderOpen size={12} />
                  {project.name}
                </span>
              )}
            </div>
            <div className="toolbar-actions">
              {modToolbar}
              {conversation && !conversation.incognito && (
                <>
                  {savedSideChats.length > 0 && (
                    <SideChatHistory
                      key={conversation.id}
                      conversations={savedSideChats}
                      onOpen={openSavedSideChat}
                      onNew={() => openSideChat(undefined, undefined, true)}
                      onRename={(item, title) =>
                        api(`/api/conversations/${item.id}`, { title }, 'PATCH').catch((error) =>
                          notify({ tone: 'error', message: errorText(error) }),
                        )
                      }
                      onPromote={async (item) => {
                        try {
                          await api(`/api/conversations/${item.id}`, { promote: true }, 'PATCH');
                          closeSavedSideChat(item.id);
                          notify({ tone: 'success', message: '已移到主对话所在的文件夹，可在左侧找到。' });
                        } catch (error) {
                          notify({ tone: 'error', message: errorText(error) });
                        }
                      }}
                      onDelete={async (item) => {
                        try {
                          await api(`/api/conversations/${item.id}`, {}, 'DELETE');
                          closeSavedSideChat(item.id);
                        } catch (error) {
                          notify({ tone: 'error', message: errorText(error) });
                        }
                      }}
                    />
                  )}
                  <div className="toolbar-item">
                    <button type="button" className="toolbar-button" aria-label="新侧聊" onClick={() => openSideChat()}>
                      <MessageSquarePlus size={15} />
                    </button>
                    <div className="toolbar-tip">
                      <strong>新侧聊</strong>
                      <small>在旁边单独提问，不打断这条对话</small>
                    </div>
                  </div>
                </>
              )}
              <GrokHistorySync
                conversation={conversation}
                pending={currentGrokSync?.pending}
                result={currentGrokSync?.result}
                error={currentGrokSync?.error}
                onSync={() => void syncGrokHistory()}
              />
              {(project || !conversation?.sideChat) && (
                <div className="toolbar-item">
                  <button
                    type="button"
                    className={`toolbar-button ${panelTab ? 'open' : ''}`}
                    aria-label="对话设置"
                    aria-pressed={Boolean(panelTab)}
                    onClick={() => void togglePanel(panelTab ?? (conversation?.sideChat ? 'memory' : 'routing'))}
                  >
                    <SlidersHorizontal size={15} />
                    {(routingProfileId || settingsConversation?.routing) && (
                      <span className="toolbar-dot" aria-hidden="true" />
                    )}
                  </button>
                  <div className="toolbar-tip">
                    <strong>对话设置</strong>
                    <small>
                      {routingProfileId || settingsConversation?.routing
                        ? '路由规则已启用。也可以管理 Skills 和记忆'
                        : inProject
                          ? '路由规则、Skills 和项目记忆'
                          : '路由规则、Skills 和对话记忆'}
                    </small>
                  </div>
                </div>
              )}
              {workflows.length > 0 && (
                <div className="toolbar-item">
                  <button
                    type="button"
                    className={`toolbar-button ${traceOpen ? 'open' : ''}`}
                    aria-label="查看当前对话轨迹"
                    aria-pressed={traceOpen}
                    onClick={() => {
                      setTraceSelection(undefined);
                      setTraceFor(traceOpen ? undefined : conversation?.id);
                    }}
                  >
                    <Activity size={15} aria-hidden="true" />
                  </button>
                  <div className="toolbar-tip">
                    <strong>轨迹</strong>
                    <small>看这条对话每一步做了什么</small>
                  </div>
                </div>
              )}
              <div className="toolbar-item">
                <button
                  type="button"
                  className="toolbar-button conversation-tools-button"
                  aria-label="终端和浏览器"
                  aria-pressed={toolsPane === 'desktop'}
                  onClick={() => {
                    if (toolsPane === 'desktop') {
                      setToolsDesktopOpened(false);
                      setToolsPane(toolsWorkOpened ? 'work' : undefined);
                      return;
                    }
                    void ensureDraftConversation()
                      .then((target) => {
                        if (toolsConversation?.id !== target.id) setToolsWorkOpened(false);
                        setToolsConversation(target);
                        setToolsDesktopOpened(true);
                        setToolsPane('desktop');
                      })
                      .catch((error) => notify({ tone: 'error', message: errorText(error) }));
                  }}
                >
                  <SquareTerminal size={15} aria-hidden="true" />
                </button>
                <div className="toolbar-tip">
                  <strong>终端 / 网页</strong>
                  <small>终端和浏览器</small>
                </div>
              </div>
              <div className="toolbar-item">
                <button
                  type="button"
                  className="toolbar-button conversation-tools-button"
                  aria-label="协作与后台工作"
                  aria-pressed={toolsPane === 'work'}
                  onClick={() => {
                    if (toolsPane === 'work') {
                      setToolsWorkOpened(false);
                      setToolsPane(toolsDesktopOpened ? 'desktop' : undefined);
                      return;
                    }
                    void ensureDraftConversation()
                      .then((target) => {
                        if (toolsConversation?.id !== target.id) setToolsDesktopOpened(false);
                        setToolsConversation(target);
                        setToolsWorkOpened(true);
                        setToolsPane('work');
                      })
                      .catch((error) => notify({ tone: 'error', message: errorText(error) }));
                  }}
                >
                  <Users size={15} aria-hidden="true" />
                </button>
                <div className="toolbar-tip">
                  <strong>协作</strong>
                  <small>工作线、对话消息、定时和 PR 监控</small>
                </div>
              </div>
              {paneActions}
            </div>
          </div>
          {!modWorkspace && (toolsDesktopOpened || toolsWorkOpened) && toolsConversation && (
            <aside className="conversation-tools-dock">
              {toolsDesktopOpened && (
                <div hidden={toolsPane !== 'desktop'} className="conversation-tool-surface">
                  <Suspense fallback={<p>正在打开桌面工具…</p>}>
                    <LazyProjectTools
                      key={toolsConversation.id}
                      conversationId={toolsConversation.id}
                      visible={toolsPane === 'desktop'}
                      // Before the first message the composer still drafts under new:…; the tools only created its conversation.
                      onMarkup={(r) =>
                        addMarkup(
                          toolsConversation.id === settingsConversation?.id
                            ? scope
                            : `conversation:${toolsConversation.id}`,
                          r,
                        )
                      }
                      onClose={() => {
                        setToolsDesktopOpened(false);
                        setToolsPane(toolsWorkOpened ? 'work' : undefined);
                      }}
                    />
                  </Suspense>
                </div>
              )}
              {toolsWorkOpened && (
                <div hidden={toolsPane !== 'work'} className="conversation-tool-surface">
                  <ConversationWorkPanel
                    key={toolsConversation.id}
                    conversation={
                      state.conversations?.find((item) => item.id === toolsConversation.id) ?? toolsConversation
                    }
                    project={state.projects?.find((item) => item.id === toolsConversation.projectId) ?? project}
                    workflows={workflows}
                    api={api}
                    reload={reload}
                    notify={notify}
                    onConversation={(value) => {
                      setToolsConversation(value);
                      onConversation(value);
                    }}
                    onClose={() => {
                      setToolsWorkOpened(false);
                      setToolsPane(toolsDesktopOpened ? 'desktop' : undefined);
                    }}
                  />
                </div>
              )}
            </aside>
          )}
          {!modWorkspace && conversation && !pinLayout.rail && (
            <PinnedMessages
              conversationId={conversation.id}
              pins={pins}
              messages={messages}
              workflows={workflows}
              backgroundTasks={state.backgroundTasks}
              pending={pinBusy}
              incognito={conversation.incognito}
              onUpdate={(id, update) => void updatePin(id, update)}
              onOpen={openPin}
              onTask={viewPinnedTask}
              onRefresh={() => void refreshPins()}
            />
          )}
          {!modWorkspace && conversation && groupView && canUseConversationCollaboration(project, conversation) && (
            <SwarmWorkspace
              state={state}
              conversation={conversation}
              api={api}
              reload={reload}
              notify={notify}
              onInspect={onInspect}
              onLines={(lines) => setSwarmLines({ conversationId: conversation.id, lines })}
              onExample={conversation.swarm ? setContent : undefined}
            />
          )}
          {!modWorkspace && plan && <SwarmPlanPanel plan={plan} />}
          {conversation && (
            <FindBar
              containerRef={scrollRef}
              conversationId={conversation.id}
              open={findOpen}
              onOpenChange={(open) => {
                setFindOpen(open);
                if (open) setFollowing(false);
              }}
            />
          )}
          <div className="conversation-scroll-wrap">
            {conversation && (
              <ConversationBackground
                key={conversation.id}
                state={displayState}
                conversationId={conversation.id}
                load={(id) => api(`/api/workflows/${id}/presentation`)}
                inspect={onInspect}
                openConversation={(id) => {
                  const target = state.conversations?.find((item) => item.id === id);
                  if (target) onConversation(target);
                }}
              />
            )}
            <ReplyPaths ref={replyPathsRef} scope={scope} projectPath={project?.path} api={api} notify={notify}>
              <div
                className="conversation-scroll"
                inert={!modWorkspace && traceOpen}
                ref={scrollRef}
                onContextMenu={(event) => {
                  const pathTarget = (event.target as Element).closest('[data-local-path], [data-relative-path]');
                  const editorItems: MenuItem[] =
                    pathTarget && desktopBridge()?.openEditor
                      ? [
                          {
                            label: '用 VS Code 打开',
                            onSelect: () => void replyPathsRef.current?.(pathTarget, 'vscode'),
                          },
                          {
                            label: '用 Cursor 打开',
                            onSelect: () => void replyPathsRef.current?.(pathTarget, 'cursor'),
                          },
                        ]
                      : [];
                  const container = scrollRef.current;
                  const selected = container && conversationSelection(container, document.getSelection());
                  const messageId =
                    selected?.anchorMessageId ??
                    (event.target as Element).closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
                  const pinItem: MenuItem | undefined =
                    messageId && messages.some((item) => item.id === messageId)
                      ? {
                          label: pinnedIds.has(messageId) ? '取消置顶' : '置顶消息',
                          icon: pinnedIds.has(messageId) ? <PinOff size={14} /> : <Pin size={14} />,
                          onSelect: () => void updatePin(messageId, { pinned: !pinnedIds.has(messageId) }),
                        }
                      : undefined;
                  if (!selected) {
                    if (!pinItem && !editorItems.length) return onConversationMenu?.(event);
                    event.preventDefault();
                    return setSelectionMenu({
                      x: event.clientX,
                      y: event.clientY,
                      items: [...editorItems, ...(pinItem ? [pinItem] : [])],
                    });
                  }
                  event.preventDefault();
                  setSelectionMenu({
                    x: event.clientX,
                    y: event.clientY,
                    items: [
                      ...editorItems,
                      ...(pinItem ? [pinItem, 'separator' as const] : []),
                      {
                        label: '复制',
                        icon: <Copy size={14} />,
                        onSelect: () => void navigator.clipboard?.writeText(selected.text).catch(() => undefined),
                      },
                      {
                        label: '引用',
                        icon: <Quote size={14} />,
                        onSelect: () =>
                          setQuoteEditor({
                            text: selected.text,
                            note: '',
                            messageId: selected.anchorMessageId,
                            left: event.clientX,
                            top: event.clientY + 12,
                          }),
                      },
                      ...(!conversation?.incognito
                        ? [
                            {
                              label: '侧聊',
                              icon: <MessageSquare size={14} />,
                              onSelect: () => openSideChat(selected.text, selected.anchorMessageId),
                            },
                          ]
                        : []),
                      'separator',
                      {
                        label: '全选',
                        icon: <SquareDashed size={14} />,
                        onSelect: () => {
                          const range = document.createRange();
                          range.selectNodeContents(container);
                          document.getSelection()?.removeAllRanges();
                          document.getSelection()?.addRange(range);
                        },
                      },
                    ],
                  });
                }}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
                  if (el.scrollTop < 240) showEarlier();
                }}
              >
                {!messages.length && !pendingItems.length ? (
                  modWorkspace ? (
                    <div className="mod-chat-empty">有问题，在这里问。</div>
                  ) : (
                    <div className="conversation-empty">
                      <h1>{inProject ? `在 ${project.name} 中开始` : '今天想完成什么？'}</h1>
                      <StartChecklist
                        visible={modLayout.main !== 'mod'}
                        state={state}
                        api={api}
                        reload={reload}
                        notify={notify}
                      />
                      <AccountWelcomeCard />
                    </div>
                  )
                ) : (
                  <ConversationHistory
                    onAnswer={
                      emptyComposer ? (answer) => void send(running ? !autoSteer : undefined, answer) : undefined
                    }
                    onManageConnectors={onManageConnectors}
                    messages={messages}
                    workflows={workflows}
                    state={displayState}
                    api={api}
                    notify={notify}
                    onInspect={onInspect}
                    onTrace={(workflow) => {
                      setTraceSelection({ workflowId: workflow.id, runId: workflow.runIds.at(-1) });
                      setTraceFor(conversation?.id);
                    }}
                    onConversation={conversation?.incognito ? undefined : onConversation}
                    limit={findOpen ? Math.max(500, shownRows) : shownRows}
                    onShowEarlier={showEarlier}
                    onJumpMessage={jumpToMessage}
                    pendingMessages={pendingItems}
                    onRecoverPending={recoverPending}
                    recoverPendingDisabled={!emptyComposer}
                    pinnedIds={pinnedIds}
                    pinBusy={pinBusy}
                    onPinMessage={(id) => void updatePin(id, { pinned: !pinnedIds.has(id) })}
                    peerLines={peerLines}
                    knownMentionNames={devices.map((device) => device.name)}
                    onMarkup={(result) => addMarkup(scope, result)}
                    onQuoteMessage={(message) =>
                      setQuoteEditor({
                        text: message.content,
                        note: '',
                        messageId: message.id,
                        left: window.innerWidth / 2,
                        top: 120,
                      })
                    }
                  />
                )}
                {conversation?.modApproval && (
                  <ModApprovalCard
                    key={`${conversation.modApproval.modeId}@${conversation.modApproval.version}`}
                    request={conversation.modApproval}
                    onAnswer={async (answer) => {
                      try {
                        await api(`/api/conversations/${conversation.id}/mod-approval`, answer);
                        await reload();
                      } catch (error) {
                        notify({ tone: 'error', message: errorText(error) });
                      }
                    }}
                  />
                )}
              </div>
            </ReplyPaths>
            {!modWorkspace && <ConversationRail scrollRef={scrollRef} messages={railMessages} />}
            {!modWorkspace && conversation && (
              <PinnedRail
                pins={pins}
                messages={messages}
                workflows={workflows}
                backgroundTasks={state.backgroundTasks}
                gutter={pinGutter}
                incognito={conversation.incognito}
                openId={pinWindow.open}
                recentId={pinWindow.recent}
                lastId={pinWindow.last}
                pending={pinBusy}
                onOpen={openPin}
                onUnpin={(id) => void updatePin(id, { pinned: false })}
              />
            )}
            {!modWorkspace && conversation && openPinned && (
              <PinnedMessageWindow
                pin={openPinned}
                message={openPinnedMessage}
                workflows={workflows}
                backgroundTasks={state.backgroundTasks}
                incognito={conversation.incognito}
                anchorX={pinLayout.rail ? 12 + pinLayout.width + 16 : undefined}
                pending={pinBusy}
                body={
                  openPinnedMessage && (
                    <>
                      {Boolean(openPinnedMessage.attachments?.length) && (
                        <MessageAttachments
                          conversationId={openPinnedMessage.conversationId}
                          attachments={openPinnedMessage.attachments!}
                        />
                      )}
                      {openPinnedMessage.content && <MessageText text={openPinnedMessage.content} />}
                    </>
                  )
                }
                onMinimize={() => closePin(true)}
                onClose={() => closePin(false)}
                onLocate={() => {
                  closePin(true);
                  jumpToMessage(openPinned.messageId);
                }}
                onUpdate={(update) => {
                  if (update.pinned === false) closePin(false);
                  void updatePin(openPinned.messageId, update);
                }}
                onTask={viewPinnedTask}
                onRefresh={() => void refreshPins()}
              />
            )}
            {selectionMenu && <ContextMenu {...selectionMenu} onClose={() => setSelectionMenu(undefined)} />}
            {!modWorkspace && traceOpen && conversation && (
              <ConversationTrace
                conversation={conversation}
                workflows={workflows}
                messages={messages}
                state={state}
                api={api}
                notify={notify}
                initialWorkflowId={traceSelection?.workflowId}
                initialRunId={traceSelection ? traceSelection.runId : trajectoryRunId}
                onClose={() => setTraceFor(undefined)}
                onInspect={onInspect}
              />
            )}
          </div>
          <SelectionActions
            containerRef={scrollRef}
            onQuote={(text, messageId, at) =>
              setQuoteEditor({
                text,
                note: '',
                messageId,
                left: at?.left ?? window.innerWidth / 2,
                top: at?.top ?? 120,
              })
            }
            onSideChat={conversation?.incognito ? undefined : (text, messageId) => openSideChat(text, messageId)}
          />
          <div className="conversation-composer-wrap" hidden={!modWorkspace && traceOpen}>
            {!following && messages.length > 0 && (
              <button
                className="scroll-latest icon-button"
                onClick={() => {
                  setFollowing(true);
                  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
                }}
                aria-label="回到最新消息"
              >
                <ArrowDown size={17} />
              </button>
            )}
            {ownApprovals.length > 0 && (
              <div className="conversation-approvals">
                {ownApprovals.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} api={api} notify={notify} />
                ))}
              </div>
            )}
            {conversation && (
              <ConversationQueue
                key={conversation.id}
                conversation={conversation}
                state={state}
                api={api}
                notify={notify}
                onSideChat={conversation.incognito ? undefined : queuedSideChat}
                externalPending={sending || queueingPending}
                representedHeadId={representedQueueHeadId(
                  conversationQueuedMessages(state.workflows ?? [], conversation.id),
                  timelineRows.slice(-(findOpen ? Math.max(500, shownRows) : shownRows)),
                )}
                onBusyChange={(busy) => {
                  if (scopeRef.current === scope) {
                    queuePendingRef.current = busy;
                    setQueuePending(busy);
                  }
                }}
              />
            )}
            {conversation && (
              <BackgroundTasks
                tasks={state.backgroundTasks}
                conversationId={conversation.id}
                onPause={(id) => backgroundTask(id, 'pause')}
                onResume={(id) => backgroundTask(id, 'resume')}
                onClose={(id) => backgroundTask(id, 'close')}
              />
            )}
            {tasteTest && (
              <TasteTestCard
                key={tasteTest.id}
                test={tasteTest}
                project={state.projects?.find((item) => item.id === tasteTest.projectId)}
                api={api}
                notify={notify}
                onClose={() => setClosedTastes((previous) => new Set(previous).add(tasteTest.id))}
                onUseWriter={(candidate) => {
                  changeDraft(scope, (previous) => ({
                    ...previous,
                    ...(previous.stickyCalled ? { called: undefined, stickyCalled: undefined } : {}),
                    writer: {
                      runtimeId: candidate.runtimeId,
                      model: candidate.model,
                      effort: candidate.effort,
                      label: candidate.label,
                    },
                  }));
                  notify({ tone: 'success', message: '下一条消息会交给 {0}。', names: [shownName(candidate.label)] });
                }}
              />
            )}
            {currentGrokSync?.result && (
              <p className="memory-meta" role="status">
                已同步。继续输入任务会携带近期记录；不会接管原 CLI 进程。
              </p>
            )}
            {onOpenSettings && !conversation?.incognito && <LayaFirstUseNotice onOpenSettings={onOpenSettings} />}
            <ConversationTaskDock workflows={workflows} state={displayState} />
            <div className="composer-anchor">
              {slashOpen && (
                <SlashCommands
                  incognito={conversation?.incognito}
                  text={slashText}
                  active={slashIndex}
                  onHover={setSlashIndex}
                  onRun={(command) => void runSlash(command)}
                />
              )}

              {mentionQuery && (
                <MentionMenu
                  externalAgentsStatus={mentionQuery.tier === 2 ? externalAgentsStatus : undefined}
                  unconnectedServers={unconnectedServers}
                  onPickServer={(server) => {
                    const selected = unconnectedServers.find((item) =>
                      server.machineId
                        ? item.machineId === server.machineId
                        : item.ssh === server.ssh && item.name === server.name,
                    );
                    if (selected) pickServer(selected);
                  }}
                  tier={mentionQuery.tier}
                  files={
                    mentionQuery.tier === 1 && fileProject && fileProject.scope !== 'chat' ? visibleFiles : undefined
                  }
                  fileError={fileResultCurrent ? fileError : ''}
                  onPickFile={pickFile}
                  items={mentionItems}
                  frequent={frequentMentions}
                  called={calledKeys}
                  active={activeMention}
                  onHover={setMentionIndex}
                  onPick={pickMention}
                  onCreate={() => {
                    setMentionQuery(undefined);
                    setManageRoles(true);
                  }}
                />
              )}
              {serverEnrollment && (
                <ServerEnroll
                  api={api}
                  server={serverEnrollment.server}
                  machine={serverEnrollment.server.machine}
                  onClose={(device) => {
                    const selected = serverEnrollment;
                    setServerEnrollment(undefined);
                    if (!device) return;
                    changeDraft(selected.scope, (previous) => {
                      const at = selected.at;
                      const marker = `${'@'.repeat(at.tier)}${at.query}`;
                      if (previous.content.slice(at.start, at.start + marker.length) !== marker) return previous;
                      const next =
                        previous.content.slice(0, at.start) +
                        `@@@${device.name} ` +
                        previous.content.slice(at.start + marker.length).replace(/^ /, '');
                      return pickDraftMention(
                        previous,
                        { kind: 'device', id: `${deviceMentionPrefix}${device.id}`, name: device.name, tier: 3 },
                        next,
                      );
                    });
                    setTimeout(() => inputRef.current?.focus());
                  }}
                />
              )}
              {modeOpen && modeChip && (
                <ModeMenu
                  mode={conversation?.workMode}
                  menuRef={modeRef}
                  onPick={pickMode}
                  route={navigatorRouteLabel(state, conversation?.navigatorRoute)}
                  folder={modFolder && <span translate="no">{modFolder}</span>}
                  onChangeFolder={changeModFolder}
                  onChooseRoute={
                    conversation
                      ? () => {
                          setModeOpen(false);
                          setNavigatorRouteOpen(true);
                        }
                      : undefined
                  }
                />
              )}
              {navigatorRouteOpen && modeChip && conversation?.workMode === 'navigator' && (
                <NavigatorRoutePopover
                  state={state}
                  policy={policy}
                  route={conversation.navigatorRoute}
                  onChange={saveNavigatorRoute}
                  popoverRef={navigatorRouteRef}
                />
              )}
              {plusOpen && (
                <div className="composer-menu" role="menu" ref={plusRef}>
                  <p className="composer-menu-hint">@ 叫角色或执行器 · @@ 叫设备或 Bot · /search 联网搜索</p>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setPlusOpen(false);
                      onAddProject();
                    }}
                  >
                    <FolderOpen size={15} />
                    <span>关联项目文件夹</span>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    tabIndex={-1}
                    aria-checked={composerReadOnly}
                    disabled={!!deviceWriteReason}
                    title={deviceWriteReason || '切换后仅影响后续消息'}
                    onClick={() => {
                      setPlusOpen(false);
                      setComposerPermission(composerReadOnly ? 'workspace-write' : 'read-only');
                    }}
                  >
                    <span>只读</span>
                    {composerReadOnly && <Check size={14} className="composer-menu-check" />}
                  </button>
                  {onNewExternalChat &&
                    (['grok-bot', 'muse'] as const).map((agentId) => (
                      <button
                        key={agentId}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        onClick={() => {
                          setPlusOpen(false);
                          onNewExternalChat(agentId);
                        }}
                      >
                        <AtSign size={15} />
                        <span>{agentId === 'grok-bot' ? '打开 Grok Bot 对话' : '打开 Muse 对话'}</span>
                      </button>
                    ))}
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={attachments.length >= 8}
                    onClick={() => {
                      setPlusOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <Paperclip size={15} />
                    <span>添加文件或图片</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setPlusOpen(false);
                      callSomeone();
                    }}
                  >
                    <AtSign size={15} />
                    <span>叫一个角色或智能体</span>
                    <small>可以叫好几位，写清谁做什么</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setPlusOpen(false);
                      setScheduleOpen(true);
                      setOptions(false);
                    }}
                  >
                    <Clock size={15} />
                    <span>时间安排</span>
                    <small>延后开始、完成期限</small>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    tabIndex={-1}
                    aria-checked={review}
                    onClick={() => {
                      setPlusOpen(false);
                      setReview(!review);
                    }}
                  >
                    <ClipboardCheck size={15} />
                    <span>核验模式</span>
                    <small>由另一家厂商复核结果和网络事实</small>
                    {review && <Check size={14} className="composer-menu-check" />}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setPlusOpen(false);
                      mediaWorkflowAdopted.current = undefined;
                      setMediaWorkflowDialog({
                        scope,
                        projectId: project?.id,
                        folder: inProject ? project.path : undefined,
                        key: crypto.randomUUID(),
                      });
                    }}
                  >
                    <FolderOpen size={15} />
                    <span>本地流程</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setPlusOpen(false);
                      setManageRoles(true);
                    }}
                  >
                    <Users size={15} />
                    <span>管理角色</span>
                    <small>输入 @ 就能叫出来</small>
                  </button>
                </div>
              )}
              {options && (
                <div
                  className="composer-popover route-popover"
                  ref={routeRef}
                  role="dialog"
                  aria-label="执行器与任务选项"
                  aria-modal="true"
                >
                  <div className="composer-chips">
                    <WorkspaceExecutionFields
                      state={state}
                      policy={policy}
                      selection={runtimeId}
                      model={model}
                      routingProfiles={routingProfiles}
                      routingProfileId={routingProfileId}
                      inheritProjectRouting={inheritProjectRouting}
                      projectRoutingLabel={projectRoutingLabel}
                      disabled={changingProfile || undefined}
                      onModelsOpen={() => {
                        if (runtimeId.startsWith('api-'))
                          void api(`/api/api-providers/${encodeURIComponent(runtimeId)}/models`, {}).catch(
                            () => undefined,
                          );
                      }}
                      onSelection={(value) => {
                        void selectExecutionChoice(value);
                      }}
                      onModel={(value) => {
                        void selectRoute({ model: value, effort: '' });
                      }}
                    >
                      {runtimeId && effortChoice.levels.length > 0 && (
                        <EffortSlider
                          levels={effortChoice.levels}
                          title={effortChoice.title}
                          value={effort}
                          disabled={unavailableRuntime}
                          onChange={(value) => void selectRoute({ effort: value })}
                        />
                      )}
                    </WorkspaceExecutionFields>
                    <button
                      type="button"
                      className={`chip-more ${advanced ? 'active' : ''}`}
                      aria-expanded={advanced}
                      onClick={() => setAdvanced(!advanced)}
                    >
                      高级
                    </button>
                    {advanced && (
                      <div className="composer-advanced">
                        <ChipSelect
                          label="任务"
                          ariaLabel="任务理解方式"
                          value={mode}
                          onChange={(value) => setMode(value as MessageInput['mode'])}
                        >
                          <option value="auto">{runtimeId ? '直接执行' : '自动判断'}</option>
                          <option value="chat">只问答</option>
                          <option value="build">创建或修改</option>
                        </ChipSelect>
                        <small className="composer-option-hint">
                          {runtimeId
                            ? '直接交给所选执行器；继续携带对话上下文并检查文件权限与额度。执行器会自行理解和规划任务。'
                            : '自动理解任务，并根据能力与额度选择执行器。'}
                        </small>
                        {canPlanFirst && (
                          <label className="chip-check composer-plan-choice">
                            <span>
                              先计划<small>先整理计划，确认后再执行</small>
                            </span>
                            <span className="switch">
                              <input
                                type="checkbox"
                                role="switch"
                                aria-label="先计划"
                                checked={!!draft.planFirst}
                                onChange={(event) =>
                                  changeDraft(scope, (previous) => ({ ...previous, planFirst: event.target.checked }))
                                }
                              />
                              <span />
                            </span>
                          </label>
                        )}
                        <ChipSelect
                          label="账号"
                          ariaLabel="执行通道"
                          value={policy}
                          onChange={(value) => setPolicy(value as MessageInput['executionPolicy'])}
                        >
                          <option value="cli-first">订阅账号优先，API 补充</option>
                          <option value="cli-only">只用订阅账号</option>
                          <option value="api-only">只用 API 账号</option>
                        </ChipSelect>
                        {mode !== 'chat' && (
                          <label className="chip-select chip-input">
                            <span>验收命令</span>
                            <input
                              value={verification}
                              onChange={(event) => setVerification(event.target.value)}
                              placeholder="完成后运行，如 npm test"
                              spellCheck={false}
                            />
                          </label>
                        )}
                        <label className="chip-check composer-recovery-choice">
                          <input
                            type="checkbox"
                            checked={escalate}
                            onChange={(event) => setEscalate(event.target.checked)}
                          />
                          <span>
                            失败时自动恢复
                            <small>额度或登录受限且还没执行任何操作时换账号；验收失败时提高思考强度重试。</small>
                          </span>
                        </label>
                        {chosenRuntime?.accounting?.mode !== 'usage' && (
                          <label className="chip-check composer-recovery-choice">
                            <input
                              type="checkbox"
                              checked={state.settings.unknownQuotaPolicy === 'allow' || allowUnknown}
                              disabled={state.settings.unknownQuotaPolicy === 'allow'}
                              onChange={(event) => setAllowUnknown(event.target.checked)}
                            />
                            <span>
                              允许额度未知
                              <small>订阅没有报告剩余额度时，仍然用它运行这一次。</small>
                            </span>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {scheduleOpen && (
                <div
                  className="composer-popover schedule-popover"
                  ref={scheduleRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label="时间安排"
                >
                  <div className="composer-schedule">
                    <SchedulePanel
                      notBefore={notBefore}
                      deadline={deadline}
                      priority={priority}
                      preferExpiringQuota={preferExpiringQuota}
                      onNotBefore={setNotBefore}
                      onDeadline={setDeadline}
                      onPriority={setPriority}
                      onPreferExpiringQuota={setPreferExpiringQuota}
                    />
                  </div>
                </div>
              )}
              <form
                className={`conversation-composer ${tallComposer ? 'tall' : ''}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitComposer();
                }}
              >
                {project?.folderMissing && (
                  <div className="composer-once-writer composer-missing-folder" role="status">
                    <span>这个项目的文件夹现在找不到了。可以照常发消息，先按聊天回复；文件夹回来后自动恢复。</span>
                  </div>
                )}
                {boundAgentId && (
                  <div className="composer-once-writer" role="status">
                    <span translate="no">
                      {boundAgentReason
                        ? withNames('{0} 当前不可用：{1}', [
                            externalAgentCatalog[boundAgentId].name,
                            translateInterfaceText(boundAgentReason),
                          ])
                        : withNames('发送给 {0}', [externalAgentCatalog[boundAgentId].name])}
                    </span>
                    <button
                      type="button"
                      className="button ghost tiny"
                      disabled={unbinding}
                      onClick={() => void unbindExternalAgent()}
                    >
                      解除绑定
                    </button>
                  </div>
                )}
                {draft.writer && (
                  <div className="composer-once-writer" role="status">
                    <span>
                      仅下一条 · <span translate="no">{shownName(draft.writer.label)}</span>
                    </span>
                    <button
                      type="button"
                      className="button ghost tiny"
                      onClick={() => changeDraft(scope, ({ writer: _writer, ...previous }) => previous)}
                    >
                      取消临时写手
                    </button>
                  </div>
                )}
                {modelFallback && (
                  <p className="queue-note" role="status">
                    {modelFallback}
                  </p>
                )}
                {deviceWriteReason && (
                  <p className="queue-note" role="status">
                    {deviceWriteReason}
                  </p>
                )}
                {unavailableProfile && (
                  <p className="unavailable-runtime" role="alert">
                    所选路由方案不可用，请选择自动或另一套路由方案。
                  </p>
                )}
                {unavailableRuntime && !directSearch && (
                  <p className="unavailable-runtime" role="alert">
                    {execution.label}。请选择其他执行器或自动调度后发送。
                  </p>
                )}
                {!directSearch && textOnly && (
                  <div className="unavailable-runtime attachment-text-only" role={textOnly.mixed ? 'status' : 'alert'}>
                    <span translate="no">{withNames(textOnlyNotice, textOnlyNames)}</span>
                    {!textOnly.mixed && (
                      <button
                        type="button"
                        className="button ghost tiny"
                        translate="no"
                        disabled={sending || (!content.trim() && !quotes.length)}
                        onClick={() => void submitComposer(false, true)}
                      >
                        {withNames('只把文字发给 {0}', textOnlyNames)}
                      </button>
                    )}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="attachment-drafts" aria-label="待发送附件">
                    {attachments.map((item) => (
                      <div
                        className={`attachment-chip ${item.previewUrl ? 'attachment-chip-image' : ''}`}
                        key={item.id}
                      >
                        {item.previewUrl ? (
                          <button
                            type="button"
                            className="attachment-chip-preview"
                            title={`${item.file.name} · ${attachmentSize(item.file.size)}${item.uploaded ? ` ${translateInterfaceText('· 已上传，待发送')}` : ''}`}
                            data-names
                            onClick={() => setDraftPreview(item.id)}
                          >
                            <AttachmentThumbnail src={item.previewUrl} />
                          </button>
                        ) : (
                          <FileText size={20} />
                        )}
                        {!item.previewUrl && (
                          <span>
                            <strong title={item.file.name} translate="no">
                              {item.file.name}
                            </strong>
                            <small>
                              {attachmentSize(item.file.size)}
                              {item.uploaded ? ' · 已上传，待发送' : ''}
                            </small>
                          </span>
                        )}
                        <button
                          type="button"
                          className="icon-button attachment-remove"
                          onClick={() => removeAttachment(item.id)}
                          aria-label={withNames('移除附件 {0}', [item.file.name])}
                          data-names
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {draftPreview !== undefined && draftImages.some((item) => item.id === draftPreview) && (
                  <ImageViewer
                    images={draftImages.map((item) => ({
                      src: item.previewUrl!,
                      name: item.file.name,
                      detail: attachmentSize(item.file.size),
                    }))}
                    index={draftImages.findIndex((item) => item.id === draftPreview)}
                    onIndex={(index) => setDraftPreview(draftImages[index]?.id)}
                    onClose={() => setDraftPreview(undefined)}
                    markup={imageMarkup(quotes.find((quote) => quote.attachmentDraftId === draftPreview))}
                  />
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  multiple
                  aria-label="选择附件文件"
                  onChange={(event) => {
                    addFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
                <QuoteChips
                  quotes={quotes}
                  disabled={sending}
                  onEdit={(quote, anchor) =>
                    quote.markup && quote.markupSrc
                      ? setMarkupEdit(quote)
                      : setQuoteEditor({
                          id: quote.id,
                          text: quote.text,
                          note: quote.note ?? '',
                          left: anchor.left + anchor.width / 2,
                          top: anchor.bottom + 8,
                        })
                  }
                  onRemove={removeQuote}
                />
                {markupEdit?.markup && markupEdit.markupSrc && (
                  <ImageViewer
                    images={[{ src: markupEdit.markupSrc, name: markupEdit.markup.source.name }]}
                    index={0}
                    onIndex={() => {}}
                    onClose={() => setMarkupEdit(undefined)}
                    markup={{ ...imageMarkup(markupEdit), immediate: true }}
                  />
                )}
                {quoteEditor && (
                  <QuoteEditor
                    key={quoteEditor.id ?? quoteEditor.text}
                    {...quoteEditor}
                    editing={!!quoteEditor.id}
                    onSave={saveQuote}
                    onCancel={() => setQuoteEditor(undefined)}
                    onRemove={
                      quoteEditor.id
                        ? () => {
                            removeQuote(quoteEditor.id!);
                            setQuoteEditor(undefined);
                          }
                        : undefined
                    }
                  />
                )}
                <button
                  type="button"
                  className="icon-button composer-size"
                  title={tallComposer ? '收起输入框' : '展开输入框'}
                  aria-label={tallComposer ? '收起输入框' : '展开输入框'}
                  aria-pressed={tallComposer}
                  onClick={() => {
                    setComposerSize(tallComposer ? 'compact' : 'tall');
                    inputRef.current?.focus();
                  }}
                >
                  {tallComposer ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
                <label className="sr-only" htmlFor="conversation-input">
                  给 Agent 发消息
                </label>
                <textarea
                  ref={inputRef}
                  id="conversation-input"
                  value={content}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Deleting an @name also takes back the call it made.
                    changeDraft(scope, ({ called: previousCalls, ...previous }) => {
                      const hasPrefix = mentionPrefix.test(value);
                      const kept = previous.stickyCalled
                        ? hasPrefix
                          ? []
                          : (previousCalls ?? [])
                        : stillNamed(previousCalls ?? [], value);
                      return {
                        ...previous,
                        ...(hasPrefix ? { stickyCalled: undefined } : {}),
                        content: value,
                        freeChain: previous.freeChain && /@免费(?:\s|$)/u.test(value),
                        ...(kept.length ? { called: kept } : {}),
                      };
                    });
                    const caret = event.target.selectionStart ?? value.length;
                    const prefix = mentionPrefixAt(value, caret);
                    setMentionQuery(prefix);
                    setMentionIndex(0);
                    setFileQuery(prefix?.tier === 1 ? prefix : undefined);
                    updateSlashMenu(value, caret);
                    if (prefix || slashCommandAt(value, caret) !== undefined) {
                      setOptions(false);
                      setPlusOpen(false);
                      setScheduleOpen(false);
                    }
                  }}
                  onSelect={(event) =>
                    updateSlashMenu(event.currentTarget.value, event.currentTarget.selectionStart ?? content.length)
                  }
                  onPaste={(event) => {
                    const files = filesFromTransfer(event.clipboardData);
                    if (files.length) {
                      event.preventDefault();
                      const pasteScope = scope;
                      void pastedAttachmentFiles(files).then((recovered) => addFiles(recovered, pasteScope));
                    }
                  }}
                  placeholder="想做什么？"
                  rows={3}
                  onCompositionStart={() => {
                    composition.current = { active: true, endedAt: -Infinity };
                  }}
                  onCompositionEnd={() => {
                    composition.current = { active: false, endedAt: performance.now() };
                  }}
                  onBlur={() => {
                    composition.current = { active: false, endedAt: -Infinity };
                    setMentionQuery(undefined);
                    setFileQuery(undefined);
                    setSlashOpen(false);
                  }}
                  onKeyDown={(event) => {
                    const composing =
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229 ||
                      composition.current.active ||
                      performance.now() - composition.current.endedAt < 40;
                    if (!composing && slashOpen) {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setSlashOpen(false);
                        setFileQuery(undefined);
                        return;
                      }
                      const count = slashItems.length;
                      const index = slashIndex;
                      if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                        event.preventDefault();
                        const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
                        setSlashIndex(next);
                        return;
                      }
                      if (
                        count &&
                        (event.key === 'Enter' || event.key === 'Tab') &&
                        !event.shiftKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey &&
                        !event.repeat
                      ) {
                        event.preventDefault();
                        void runSlash(slashItems[index]!.id);
                        return;
                      }
                    }
                    if (
                      !composing &&
                      event.key === 'ArrowUp' &&
                      !event.shiftKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.altKey &&
                      content === '' &&
                      !attachments.length &&
                      !quotes.length
                    ) {
                      const last = mergePendingMessages(
                        messages,
                        pendingSends.filter((item) => item.scope === scope && !!item.messageId && !item.error),
                      )
                        .filter(
                          (message) =>
                            message.role === 'user' &&
                            !workflows.find((item) => item.id === message.workflowId)?.delegation,
                        )
                        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                        .at(-1);
                      if (last) {
                        event.preventDefault();
                        setContent(last.content);
                      }
                      return;
                    }
                    if (mentionQuery && !event.nativeEvent.isComposing) {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setMentionQuery(undefined);
                        return;
                      }
                      // Across the groups, skipping the ones this message already calls.
                      if (activeMention >= 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                        event.preventDefault();
                        setMentionIndex(nextIndex(activeMention, event.key === 'ArrowDown' ? 1 : -1));
                        return;
                      }
                      if (
                        activeMention >= 0 &&
                        (event.key === 'Enter' || event.key === 'Tab') &&
                        !event.shiftKey &&
                        !event.ctrlKey &&
                        !event.metaKey
                      ) {
                        event.preventDefault();
                        if (activeMention < mentionItems.length) pickMention(mentionItems[activeMention]!);
                        else if (activeMention < mentionItems.length + visibleFiles.length)
                          pickFile(visibleFiles[activeMention - mentionItems.length]!);
                        else {
                          const server = unconnectedServers[activeMention - mentionItems.length - visibleFiles.length];
                          if (server) pickServer(server);
                          setMentionQuery(undefined);
                        }
                        return;
                      }
                    }
                    const action = composerEnterAction(
                      {
                        key: event.key,
                        shiftKey: event.shiftKey,
                        ctrlKey: event.ctrlKey,
                        metaKey: event.metaKey,
                        altKey: event.altKey,
                        repeat: event.repeat,
                        isComposing: event.nativeEvent.isComposing,
                        keyCode: event.nativeEvent.keyCode,
                      },
                      composition.current,
                      performance.now(),
                      state.settings.composerSendKey,
                    );
                    if (action === 'send' || action === 'ignore') event.preventDefault();
                    if (action === 'send')
                      void submitComposer(ctrlEnter ? event.shiftKey : event.ctrlKey || event.metaKey);
                  }}
                  onKeyUp={(event) => {
                    if (event.key === 'Enter' && !composition.current.active) composition.current.endedAt = -Infinity;
                  }}
                />
                <div className="composer-bottom">
                  <div className="composer-controls">
                    <button
                      type="button"
                      className={`composer-plus ${plusOpen ? 'open' : ''}`}
                      aria-label="添加和更多"
                      aria-expanded={plusOpen}
                      aria-haspopup="menu"
                      title="添加和更多"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        setPlusOpen(!plusOpen);
                        setModeOpen(false);
                        setOptions(false);
                        setScheduleOpen(false);
                      }}
                    >
                      <Plus size={17} />
                    </button>
                    {modeChip && (
                      <ModeChip
                        mode={conversation?.workMode}
                        open={modeOpen}
                        disabled={running || modeBusy}
                        onToggle={() => {
                          setModeOpen(!modeOpen);
                          setPlusOpen(false);
                          setOptions(false);
                          setScheduleOpen(false);
                        }}
                        onClear={() => pickMode(null)}
                        detail={
                          conversation?.workMode === 'navigator'
                            ? navigatorRouteLabel(state, conversation.navigatorRoute)
                            : undefined
                        }
                      />
                    )}
                    {called.map((item) => (
                      <span
                        key={participantKey(item)}
                        className={`composer-tag mention${calledDevice && item.kind === 'device' ? ' device-folder-tag' : ''}`}
                        title={
                          called.length > 1
                            ? '这一条交给几位分工完成：按你写的谁做什么来分'
                            : '后续消息继续交给它，点 × 取消'
                        }
                      >
                        <span translate="no">@{shownMentionName(item)}</span>
                        {calledDevice && item.kind === 'device' && (
                          <>
                            <input
                              className="device-folder-input"
                              aria-label="设备上的文件夹"
                              placeholder="文件夹（可不填）"
                              title="输入设备上的路径，例如 ~/project；不会选择本机目录。"
                              list={deviceFolderList}
                              value={draft.deviceFolder ?? ''}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(event) =>
                                changeDraft(scope, (previous) => ({ ...previous, deviceFolder: event.target.value }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.preventDefault();
                              }}
                            />
                            <datalist id={deviceFolderList}>
                              {(selectedDevice?.folders ?? []).slice(0, 10).map((folder) => (
                                <option key={folder} value={folder} />
                              ))}
                            </datalist>
                          </>
                        )}
                        <button
                          type="button"
                          aria-label={withNames('不叫 {0}', [shownMentionName(item)])}
                          data-names
                          onClick={() =>
                            changeDraft(scope, ({ called: calls, ...previous }) => {
                              const rest = (calls ?? []).filter(
                                (entry) => participantKey(entry) !== participantKey(item),
                              );
                              return {
                                ...previous,
                                stickyCalled: undefined,
                                content: withoutCalledName(previous.content, item.name, calls ?? []),
                                ...(rest.length ? { called: rest } : {}),
                              };
                            })
                          }
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    {draft.agentPresetId && !['standard', 'auto'].includes(draft.agentPresetId) && (
                      <span className="composer-tag" title="这个对话的新任务默认用这个角色">
                        {draftRole ? (
                          <span translate="no">{shownMentionName({ kind: 'role', ...draftRole })}</span>
                        ) : (
                          '角色已移除'
                        )}
                        <button
                          type="button"
                          aria-label="改回自动角色"
                          onClick={() => changeDraft(scope, ({ agentPresetId: _role, ...previous }) => previous)}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    )}
                    {hasSchedule && (
                      <button
                        type="button"
                        className="composer-tag live"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setScheduleOpen(!scheduleOpen);
                          setOptions(false);
                          setPlusOpen(false);
                        }}
                        title={
                          [
                            notBefore && `最早开始 ${queueDate(notBefore)}`,
                            deadline && `期限 ${queueDate(deadline)}`,
                            priority === 'high' && '高优先级',
                          ]
                            .filter(Boolean)
                            .join(' · ') || '已调整调度偏好'
                        }
                      >
                        <Clock size={11} />
                        已定时
                      </button>
                    )}
                    {review && (
                      <span className="composer-tag" title="由另一家厂商复核结果和网络事实">
                        <ClipboardCheck size={11} />
                        核验模式
                        <button type="button" aria-label="关闭核验模式" onClick={() => setReview(false)}>
                          <X size={11} />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="composer-submit-actions">
                    <button
                      type="button"
                      className={`composer-route ${options ? 'active' : ''}`}
                      onMouseDown={(event) => event.stopPropagation()}
                      aria-expanded={options}
                      aria-label="调度选项"
                      title="选择执行器、模型和思考强度"
                      onClick={() => {
                        setOptions(!options);
                        setScheduleOpen(false);
                        setPlusOpen(false);
                      }}
                    >
                      <span>
                        {(inheritProjectRouting && !runtimeId
                          ? withNames('项目默认 · {0}', [projectRoutingLabel ?? translateInterfaceText('自动')])
                          : routingProfile?.name) ??
                          (unavailableProfile ? '路由方案不可用' : undefined) ??
                          execution.label ??
                          (settingsConversation?.routing
                            ? '按路由规则'
                            : state.settings.decisionMode === 'confirm'
                              ? '建议后确认'
                              : '自动')}
                        {runtimeId && model
                          ? ` · ${observedModel?.model ?? selectedModel?.label ?? model}${(observedModel?.effort ?? effort) ? ` · ${observedModel?.effort ?? effort}` : ''}`
                          : ''}
                        {/* On 自动, a model shows only while a task runs (what it is using now), never as if picked. */}
                        {observedModel && stopTarget && (!runtimeId || !model) && (
                          <span translate="no">{` · ${observedModel.model}${observedModel.effort ? ` · ${observedModel.effort}` : ''}`}</span>
                        )}
                      </span>
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                    {sending && (
                      <span className="attachment-upload-status" role="status">
                        {sendingLabel}
                      </span>
                    )}
                    {stopTarget && (
                      <button
                        type="button"
                        className="icon-button composer-stop"
                        disabled={cancelling}
                        onClick={() => void cancelActive()}
                        aria-label="停止最近进行中的任务"
                        title="停止最近进行中的任务"
                      >
                        {cancelling ? (
                          <Loader2 size={14} className="spinning" />
                        ) : (
                          <Square size={13} fill="currentColor" />
                        )}
                      </button>
                    )}
                    {
                      <button
                        type="button"
                        className="composer-route composer-read-only"
                        aria-label="文件权限"
                        title={deviceWriteReason || '切换后仅影响后续消息'}
                        disabled={!!deviceWriteReason}
                        onClick={() => setComposerPermission(composerReadOnly ? 'workspace-write' : 'read-only')}
                      >
                        {composerReadOnly ? '只读' : '可写入'}
                      </button>
                    }
                    <button
                      type="submit"
                      className="send-button"
                      disabled={
                        sending ||
                        changingProfile ||
                        unavailableProfile ||
                        (emptyComposer
                          ? !emptySteerAvailable || (running && !autoSteer) || queuePending
                          : unavailableRuntime && !directSearch)
                      }
                      aria-label={emptySteerAvailable ? '插入首条排队消息' : '发送消息'}
                      title={
                        emptySteerAvailable
                          ? `插入首条排队消息 · ${autoSteer ? sendShortcut : queueShortcut}`
                          : [
                              running ? shortcutHint : `${translateInterfaceText('发送')} · ${sendShortcut}`,
                              steeringCaption,
                              translateInterfaceText('Shift+Enter 换行'),
                            ]
                              .filter(Boolean)
                              .join(' · ')
                      }
                    >
                      {sending ? <Loader2 size={17} className="spinning" /> : <ArrowUp size={19} />}
                    </button>
                  </div>
                </div>
              </form>
            </div>
            <ConversationTaskDock workflows={workflows} state={displayState} stats />
            {/* Persistent hints only describe confirmation and read-only mode. */}
            {hint && (
              <div className="composer-caption">
                <span className="composer-shortcuts">{hint}</span>
              </div>
            )}
          </div>
        </section>
      </div>
      {!modWorkspace && settingsConversation && panelTab && (
        <div className="conversation-panel-slot">
          <ConversationPanel
            tab={panelTab}
            onTab={setPanelTab}
            onClose={() => setPanelTab(undefined)}
            conversation={settingsConversation}
            state={state}
            api={api}
            notify={notify}
            onManageConnectors={onManageConnectors}
            onOpenSettings={onOpenSettings}
            memory={
              project ? (
                <MemoryEditor key={project.id} project={project} api={api} notify={notify} autoFocus={false} />
              ) : undefined
            }
          />
        </div>
      )}
      {mediaWorkflowDialog && (
        <MediaWorkflowDialog
          key={mediaWorkflowDialog.key}
          api={api}
          notify={notify}
          conversationId={conversation?.id}
          defaultFolder={mediaWorkflowDialog.folder}
          ensureConversation={ensureMediaConversation}
          onClose={closeMediaWorkflowDialog}
          onStarted={closeMediaWorkflowDialog}
        />
      )}
      {manageRoles && (
        <AgentPresetDialog
          key={scope}
          presets={agentPresets}
          api={api}
          notify={notify}
          onClose={() => setManageRoles(false)}
          onSaved={(preset) => {
            if (preset) changeDraft(scope, (previous) => ({ ...previous, agentPresetId: preset.id }));
          }}
        />
      )}
      {modLayout.rightPanel.mounted &&
        conversation &&
        modBinding &&
        experience.view?.instance &&
        experience.view.manifest && (
          <ModPanel
            key={`${conversation.id}:${experience.view.instance.id}`}
            view={experience.view}
            hidden={!modLayout.rightPanel.visible}
            web={modWeb}
            busy={experience.busy || removingMod}
            error={experience.error}
            onSave={experience.save}
            onReload={experience.reload}
            onRemove={() => onRemoveMod?.()}
            onCompose={insertModDraft}
            onStore={() => onOpenModeStore?.(conversation.id)}
          />
        )}
      {modSidebarTarget &&
        modWeb &&
        modLayout.sidebarPanel.mounted &&
        createPortal(
          <ModFrame
            key={`${conversation!.id}:${modHost!.instanceId}:sidebar`}
            {...modWeb}
            slot="sidebarPanel"
            hidden={!modLayout.sidebarPanel.visible}
          />,
          modSidebarTarget,
        )}
      {sideChat && (
        <div className="side-chat-slot" hidden={modWorkspace || !sideChat.open}>
          <SideChatPanel
            key={sideChat.launch.requestId}
            state={state}
            api={api}
            launch={sideChat.launch}
            notify={notify}
            onClose={() =>
              setSideChats((previous) => ({
                ...previous,
                [scope]: { ...previous[scope], open: false },
              }))
            }
          />
        </div>
      )}
    </div>
  );
}

type TimelineRow = ReturnType<typeof conversationTimeline>[number];
const rowTime = (row: TimelineRow): string | undefined =>
  row.kind === 'message'
    ? row.message.createdAt
    : row.kind === 'steering-stage'
      ? row.stage.at
      : row.kind === 'workflow'
        ? row.workflow.createdAt
        : (row.parent ?? row.children[0]?.workflow)?.createdAt;

/** Puts swarm members' messages between the conversation rows by time; work still running stays last. */
function withPeerLines(
  rows: TimelineRow[],
  lines: SwarmChatLine[] | undefined,
  render: (row: TimelineRow) => ReactNode,
): ReactNode[] {
  if (!lines?.length) return rows.map(render);
  // Lines older than the first row shown belong with the earlier, folded history.
  const start = rows.map(rowTime).find(Boolean);
  const sorted = lines.filter((line) => !start || line.at >= start).sort((a, b) => a.at.localeCompare(b.at));
  const out: ReactNode[] = [];
  let next = 0;
  const flush = (until?: string) => {
    while (next < sorted.length && (until === undefined || sorted[next]!.at <= until)) {
      const line = sorted[next++]!;
      const pair = [line.from, line.to].sort().join('\0');
      const turns = [line];
      while (
        next < sorted.length &&
        (until === undefined || sorted[next]!.at <= until) &&
        [sorted[next]!.from, sorted[next]!.to].sort().join('\0') === pair
      )
        turns.push(sorted[next++]!);
      const last = turns.at(-1)!;
      out.push(
        <ConversationExchange
          key={`peer:${line.id}`}
          names={[line.from, line.to]}
          count={turns.length}
          at={last.at}
          preview={last.text}
        >
          {turns.map((turn) => (
            <div className="exchange-turn" key={turn.id} style={participantStyle(turn.from)}>
              <ParticipantHeading name={turn.from} to={turn.to} at={turn.at} />
              <ParticipantBody>
                <MessageText text={turn.text} />
              </ParticipantBody>
            </div>
          ))}
        </ConversationExchange>,
      );
    }
  };
  for (const row of rows) {
    const live = (row.kind === 'workflow' || row.kind === 'delegation-group') && row.live;
    flush(live ? undefined : (rowTime(row) ?? ''));
    out.push(render(row));
  }
  flush();
  return out;
}

const noPendingMessages: PendingComposerSend[] = [];

function messageDay(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return;
  const key = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    key: key(date),
    label:
      key(date) === key(today)
        ? translateInterfaceText('今天')
        : key(date) === key(yesterday)
          ? translateInterfaceText('昨天')
          : date.toLocaleDateString(currentLocale(), {
              month: 'long',
              day: 'numeric',
              ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
            }),
  };
}

export const ConversationHistory = memo(function ConversationHistory({
  messages,
  workflows,
  state,
  api,
  notify,
  onInspect,
  onTrace,
  limit,
  onShowEarlier,
  pendingMessages = noPendingMessages,
  onRecoverPending,
  recoverPendingDisabled,
  pinnedIds,
  onPinMessage,
  pinBusy,
  onJumpMessage,
  peerLines,
  onQuoteMessage,
  onMarkup,
  knownMentionNames = [],
  onConversation,
  onManageConnectors,
  onAnswer,
}: {
  messages: ConversationMessage[];
  workflows: Workflow[];
  state: AppState;
  api: Api;
  notify: Notify;
  onInspect: (id: string) => void;
  onTrace?: (workflow: Workflow) => void;
  /** Render only the latest rows; a long imported history would otherwise put every message on the page. */
  limit?: number;
  onShowEarlier?: () => void;
  pendingMessages?: PendingComposerSend[];
  onRecoverPending?: (item: PendingComposerSend) => void;
  recoverPendingDisabled?: boolean;
  pinnedIds?: ReadonlySet<string>;
  onPinMessage?: (id: string) => void;
  pinBusy?: boolean;
  onJumpMessage?: (messageId: string) => void;
  /** Swarm members' messages to each other, shown in time order like lines in a group chat. */
  peerLines?: SwarmChatLine[];
  onQuoteMessage?: (message: ConversationMessage) => void;
  onMarkup?: (result: MarkupResult) => boolean;
  knownMentionNames?: string[];
  onConversation?: (conversation: Conversation) => void;
  onManageConnectors?: () => void;
  /** A question card's button: sent like a typed message. */
  onAnswer?: (text: string) => void;
}) {
  const byId = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow])), [workflows]);
  const attempts = useMemo(() => replyAttempts(workflows), [workflows]);
  const [selectedAttempts, setSelectedAttempts] = useState<Record<string, string>>({});
  const replyCache = useRef(new Map<string, CachedWorkflowReply>());
  const timelineRunIds = useMemo(() => new Set(workflows.flatMap((workflow) => workflow.runIds)), [workflows]);
  const timelineRunKey = JSON.stringify(
    state.runs
      .filter((run) => timelineRunIds.has(run.id))
      .map((run) => [
        run.id,
        run.workflowId,
        run.endedAt,
        run.status,
        run.visualAssistant,
        run.taskOutcome?.source,
        run.taskOutcome?.status,
        run.taskOutcome?.claims?.length,
        run.taskOutcome?.verificationLimited,
        run.taskOutcome?.limitedChecks,
      ]),
  );
  const completedContinuations = useMemo(() => continuedPredecessors(workflows), [workflows]);
  const byFinalMessage = useMemo(
    () =>
      new Map(
        workflows.filter((workflow) => workflow.finalMessageId).map((workflow) => [workflow.finalMessageId!, workflow]),
      ),
    [workflows],
  );
  const displayMessages = useMemo(
    () =>
      messages.flatMap((original) => {
        const owner = (original.workflowId && byId.get(original.workflowId)) || byFinalMessage.get(original.id);
        const message = noticeMessage(resumedMessage(original), owner, state.runs);
        if (
          message.role !== 'assistant' ||
          !owner ||
          owner.conversationId !== message.conversationId ||
          !completedContinuations.has(owner.id)
        )
          return [message];
        if (
          externalReplyIsNotice(message) ||
          (message.replyIdentity?.kind === 'system' && !message.systemNotice && !message.device) ||
          !message.content.trim() ||
          message.content.trim() === message.systemNotice?.text.trim()
        )
          return [];
        return [
          {
            ...message,
            systemNotice: undefined,
            replyIdentity: message.replyIdentity?.kind === 'system' ? undefined : message.replyIdentity,
          },
        ];
      }),
    // Notices read only finished runs of these tasks; stream text alone must not rebuild history.
    [messages, byId, byFinalMessage, completedContinuations, timelineRunKey],
  );
  // Card visibility also follows claims and limited checks; stream text still renders from current state below.
  const currentTimeline = useMemo(
    () => conversationTimeline(mergePendingMessages(displayMessages, pendingMessages), workflows, state.runs),
    [displayMessages, pendingMessages, workflows, timelineRunKey],
  );
  const timeline = useMemo(
    () =>
      Object.keys(selectedAttempts).length
        ? conversationTimeline(
            mergePendingMessages(displayMessages, pendingMessages),
            workflows,
            state.runs,
            selectedAttempts,
          )
        : currentTimeline,
    [displayMessages, pendingMessages, workflows, currentTimeline, selectedAttempts],
  );
  const lastUserMessageId = displayMessages
    .filter(
      (message) =>
        message.role === 'user' &&
        (!message.resumed || !!message.content.trim()) &&
        !byId.get(message.workflowId ?? '')?.delegation,
    )
    .at(-1)?.id;
  const running = workflows.some(
    (workflow) =>
      !workflow.deletedAt && !['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(workflow.status),
  );
  const lastReplyAt = new Map<string, string>();
  for (const message of displayMessages) {
    if (message.role !== 'assistant') continue;
    const owner = message.workflowId ? byId.get(message.workflowId) : byFinalMessage.get(message.id);
    if (!owner || owner.conversationId !== message.conversationId) continue;
    if (
      owner.finalMessageId !== message.id &&
      (message.systemNotice || message.replyIdentity?.kind === 'system' || externalReplyIsNotice(message))
    )
      continue;
    if (!lastReplyAt.has(owner.id) || Date.parse(message.createdAt) > Date.parse(lastReplyAt.get(owner.id)!))
      lastReplyAt.set(owner.id, message.createdAt);
  }
  // Keep streaming replies alive while version selection unmounts their rows; saved replies release the cache.
  useEffect(() => {
    const next = new Map<string, CachedWorkflowReply>();
    for (const row of currentTimeline) {
      if (row.kind !== 'workflow') continue;
      const workflow = row.workflow;
      const latest = state.runs.find((run) => run.id === workflow.runIds.at(-1));
      const reply = workflowReplyState(workflow, latest, row.stage, lastReplyAt.get(workflow.id));
      const cached = rememberWorkflowReply(reply, latest, replyCache.current.get(workflow.id));
      if (cached) next.set(workflow.id, cached);
    }
    replyCache.current = next;
  });
  const sourceMessageIds = new Set(messages.map((message) => message.id));
  const pendingById = new Map(pendingMessages.filter((item) => !item.messageId).map((item) => [item.id, item]));
  // Keep empty resume anchors through timeline placement, then omit them before pagination and day labels.
  const visibleTimeline = timeline.filter(
    (row) => row.kind !== 'message' || !row.message.resumed || !!row.message.content.trim(),
  );
  const hidden = limit !== undefined ? Math.max(0, visibleTimeline.length - limit) : 0;
  const noticeWorkflows = new Set(
    displayMessages
      .filter((message) => message.role === 'assistant' && message.systemNotice)
      .map((message) => message.workflowId ?? byFinalMessage.get(message.id)?.id),
  );
  const shown = visibleTimeline.slice(hidden);
  const shownDays = new Set<string>();
  const mentionNames = [
    ...knownMentionNames,
    ...Object.values(externalAgentCatalog).map((agent) => agent.name),
    ...(state.settings.agentPresets ?? []).map((preset) => preset.name),
    ...state.targets.map((target) => target.label),
    ...messages.flatMap((message) => (message.device ? [message.device.name] : [])),
  ];
  const render = (row: (typeof shown)[number]) => {
    if (row.kind === 'steering-stage')
      return (
        <div className="steering-stage" key={row.stage.id} data-stage-id={row.stage.id}>
          <strong title={dateLabel(row.stage.at)}>阶段 {row.stage.number} · 补充已接收</strong>
          <span>后续活动从这里继续</span>
          <time dateTime={row.stage.at}>{dateLabel(row.stage.at, true)}</time>
        </div>
      );
    if (row.kind === 'delegation-group') {
      return (
        <div key={`delegations:${row.id}`} className="delegation-group-list">
          {row.children.map(({ workflow, messages: childMessages, sequence, historical }) => {
            const caller = byId.get(workflow.delegation!.parentId) ?? row.parent;
            const route = delegatedParties(
              childMessages.find((message) => message.role === 'assistant'),
              workflow,
              caller,
              state,
            );
            const turns = [...childMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const last = turns.at(-1);
            if (completedContinuations.has(workflow.id))
              return turns.map((message) => render({ kind: 'message', message }));
            return (
              <ConversationExchange
                key={workflow.id}
                className="delegation-group"
                names={[route.from, route.to]}
                identities={[route.fromIdentity, route.toIdentity]}
                count={turns.length}
                at={last?.createdAt ?? workflow.createdAt}
                preview={last ? delegatedPreview(shownContent(last)) : ''}
              >
                <DelegationProgress
                  workflow={workflow}
                  state={state}
                  sequence={sequence!}
                  historical={historical}
                  messages={childMessages}
                  since={row.stage?.at}
                />
                {turns.map((message) => (
                  <DelegatedMessage
                    key={message.id}
                    message={message}
                    workflow={workflow}
                    caller={caller}
                    state={state}
                    pinned={pinnedIds?.has(message.id)}
                    onPinMessage={onPinMessage}
                    pinBusy={pinBusy}
                    onQuoteMessage={onQuoteMessage}
                    notify={notify}
                    api={api}
                    onConversation={onConversation}
                  />
                ))}
                {!workflow.deletedAt && !historical && (
                  <details className="delegation-execution-details">
                    <summary>执行详情</summary>
                    <WorkflowTrace
                      workflow={workflow}
                      state={state}
                      api={api}
                      notify={notify}
                      onInspect={onInspect}
                      onTrace={onTrace ? () => onTrace(workflow) : undefined}
                      stage={row.stage}
                      onJumpMessage={onJumpMessage}
                      sourceMessageIds={sourceMessageIds}
                      hasSystemNotice={noticeWorkflows.has(workflow.id)}
                    />
                  </details>
                )}
              </ConversationExchange>
            );
          })}
        </div>
      );
    }
    if (row.kind === 'workflow')
      return (
        <WorkflowTrace
          key={`workflow:${row.workflow.id}`}
          workflow={row.workflow}
          state={state}
          api={api}
          notify={notify}
          onInspect={onInspect}
          onTrace={onTrace ? () => onTrace(row.workflow) : undefined}
          stage={row.stage}
          onJumpMessage={onJumpMessage}
          sourceMessageIds={sourceMessageIds}
          hasSystemNotice={noticeWorkflows.has(row.workflow.id)}
          lastReplyAt={lastReplyAt.get(row.workflow.id)}
          cachedReply={replyCache.current.get(row.workflow.id)}
        />
      );
    const owner = row.message.workflowId ? byId.get(row.message.workflowId) : undefined;
    return owner?.delegation && !row.message.steering && !completedContinuations.has(owner.id) ? (
      <DelegatedMessage
        key={`message:${row.message.id}`}
        message={row.message}
        onManageConnectors={onManageConnectors}
        onConversation={onConversation}
        workflow={owner}
        caller={byId.get(owner.delegation.parentId)}
        state={state}
        pinned={pinnedIds?.has(row.message.id)}
        onPinMessage={onPinMessage}
        pinBusy={pinBusy}
        api={api}
        notify={notify}
        onQuoteMessage={onQuoteMessage}
      />
    ) : (
      <Message
        key={composerMessageKey(row.message)}
        message={row.message}
        searchWorkflow={byId.get(row.message.webSearch?.answer?.workflowId ?? '')}
        onManageConnectors={onManageConnectors}
        onConversation={onConversation}
        lastUserMessage={row.message.id === lastUserMessageId}
        running={running}
        ownMessage={!owner?.delegation}
        api={api}
        participantIdentity={participantIdentity(row.message, owner?.agentPreset?.id)}
        persona={
          row.message.role === 'assistant'
            ? (externalPersona(row.message) ??
              ([
                owner?.agentPreset && owner.agentPreset.id !== 'standard'
                  ? shownMentionName({ kind: 'role', ...owner.agentPreset })
                  : undefined,
                owner?.input.runtimeId
                  ? (() => {
                      const target = state.targets.find((item) => item.id === owner.input.runtimeId);
                      return target && shownName(executorMentionName(target));
                    })()
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · ') ||
                undefined))
            : undefined
        }
        identity={
          state.settings?.showAutomaticReplyIdentity !== false
            ? namedIdentity(replyIdentity(row.message, owner, state.runs), state.targets)
            : undefined
        }
        notify={notify}
        pending={row.message.id.startsWith('pending:') ? pendingById.get(row.message.clientMessageId!) : undefined}
        onRecoverPending={onRecoverPending}
        recoverPendingDisabled={recoverPendingDisabled}
        pinned={pinnedIds?.has(row.message.id)}
        onPinMessage={onPinMessage}
        pinBusy={pinBusy}
        onQuoteMessage={onQuoteMessage}
        onMarkup={onMarkup}
        mentionNames={mentionNames}
      />
    );
  };
  return (
    <div className="message-list">
      {hidden > 0 && (
        <button type="button" className="show-earlier" onClick={onShowEarlier}>
          显示更早的 {hidden} 条
        </button>
      )}
      {withPeerLines(shown, peerLines, (row) => {
        // An open question sits under the task's final reply, or under its card when there is no reply.
        const owner =
          row.kind === 'message'
            ? byFinalMessage.get(row.message.id)
            : row.kind === 'workflow' && !row.workflow.finalMessageId
              ? row.workflow
              : undefined;
        const question = openQuestion(owner);
        const versions = owner && attempts.get(owner.id);
        const selected = versions && selectedReplyAttempt(versions, selectedAttempts);
        const versionIndex = versions?.completed.findIndex((item) => item.id === selected?.id) ?? -1;
        const versionRunning =
          !!versions &&
          !['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(versions.latest.status);
        const previous = versions?.completed[versionIndex < 0 ? versions.completed.length - 1 : versionIndex - 1];
        const next =
          versions &&
          (versions.completed[versionIndex + 1] ?? (selected?.id !== versions.latest.id ? versions.latest : undefined));
        const showVersions =
          versions &&
          (versions.completed.length > 1 || (versions.completed.length > 0 && versions.latest.status !== 'completed'));
        const selectVersion = (id: string) =>
          setSelectedAttempts((current) => ({ ...current, [versions!.latest.id]: id }));
        const day = row.kind === 'message' ? messageDay(row.message.createdAt) : undefined;
        const showDay = day && !shownDays.has(day.key);
        if (day) shownDays.add(day.key);
        return [
          showDay && (
            <div
              className="message-day"
              data-today={day.key === messageDay(new Date().toISOString())?.key}
              role="separator"
              key={`day:${day.key}`}
            >
              {day.label}
            </div>
          ),
          render(row),
          row.kind === 'message' && row.message.role === 'assistant' && owner?.review?.factCheck && (
            <FactCheck key={`fact-check:${owner.id}`} result={owner.review.factCheck} />
          ),
          showVersions && (
            <div className="reply-versions" key={`versions:${versions.latest.id}`}>
              <button
                type="button"
                className="icon-button"
                title="上一个版本"
                aria-label="上一个版本"
                disabled={!previous}
                onClick={() => previous && selectVersion(previous.id)}
              >
                ‹
              </button>
              {/* A rerun still in progress is the newest version (2/2 while it runs); a failed one stays unnumbered. */}
              <span title={versionIndex < 0 ? '当前执行' : undefined}>
                {versionIndex < 0 ? (versionRunning ? versions.completed.length + 1 : '–') : versionIndex + 1}/
                {versions.completed.length + (versionRunning ? 1 : 0)}
              </span>
              <button
                type="button"
                className="icon-button"
                title={next && next.status !== 'completed' ? '返回最新执行' : '下一个版本'}
                aria-label={next && next.status !== 'completed' ? '返回最新执行' : '下一个版本'}
                disabled={!next || versionIndex < 0}
                onClick={() => next && selectVersion(next.id)}
              >
                ›
              </button>
            </div>
          ),
          question && <QuestionCard key={`question:${owner!.id}`} question={question} onAnswer={onAnswer} />,
        ];
      }).flat()}
    </div>
  );
});

/** The card a workflow ran on most recently, e.g. "Grok B". */
function executorOf(workflow: Workflow | undefined, state: AppState): string | undefined {
  if (!workflow) return undefined;
  const runId = workflow.runIds.at(-1);
  const run = state.runs.find((run) => run.id === runId && (!run.workflowId || run.workflowId === workflow.id));
  const runtimeId = run?.route.runtimeId ?? workflow.input.runtimeId;
  return (
    run?.account?.label ??
    state.targets.find((target) => target.id === runtimeId)?.label ??
    (workflow.input.provider ? providerNames[workflow.input.provider] : undefined)
  );
}
/** The first line worth reading of a sub-task's instructions or result, without the standard preamble. */
function delegatedPreview(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  // A result opens with its heading line ("子任务 · 审查 … · 已完成（父任务 …）").
  const body = /^子任务 · .*已完成（父任务 \w+）$/.test(lines[0] ?? '') ? lines.slice(1) : lines;
  const meaningful = body.filter(Boolean);
  // Instructions open with "Grok B 请你完成以下子任务：" or "子任务（审查）：", then the task itself.
  const first = (meaningful[0] ?? '').replace(/^.*?请你?完成以下子任务：/, '').replace(/^子任务（[^）]+）：/, '');
  return (first || meaningful[1] || '').slice(0, 120);
}
/**
 * A message's words as shown: PugPort's own notices (including an outside agent's status while it has no reply)
 * translate, what agents and people wrote stays as written.
 */
const shownContent = (message: ConversationMessage) =>
  message.systemNotice
    ? translateInterfaceText(message.systemNotice.text)
    : externalReplyIsNotice(message) || (message.replyIdentity?.kind === 'system' && !message.device)
      ? translateInterfaceText(message.content)
      : message.content;
/**
 * Who asked and who answered a subtask, to show as written: accounts, roles and devices people named stay as written;
 * PugPort's default account names, built-in roles, outside agents and its fallbacks translate.
 */
function delegatedParties(
  message: ConversationMessage | undefined,
  workflow: Workflow,
  caller: Workflow | undefined,
  state: AppState,
) {
  const delegation = workflow.delegation!;
  const callerLabel = delegation.agent?.caller ?? executorOf(caller, state);
  const from = callerLabel ? shownName(callerLabel) : translateInterfaceText('主任务');
  const account =
    (message?.role === 'assistant' ? message.replyIdentity?.runs.at(-1)?.accountLabel : undefined) ??
    (workflow.runIds.length ? executorOf(workflow, state) : undefined);
  const shownAccount = account && shownName(account);
  const roleName =
    delegation.agent?.presetId && workflow.agentPreset
      ? shownMentionName({ kind: 'role', ...workflow.agentPreset })
      : undefined;
  const to =
    (message?.externalAgent ? translateInterfaceText(message.externalAgent.name) : undefined) ??
    (roleName && shownAccount ? `${roleName} · ${shownAccount}` : (roleName ?? shownAccount)) ??
    (delegation.agent ? shownAgentLabel(delegation.agent) : translateInterfaceText('自动选择的执行器'));
  return {
    from,
    to,
    fromIdentity: participantIdentity(undefined, caller?.agentPreset?.id),
    toIdentity:
      participantIdentity(message) ??
      (delegation.agent?.deviceId
        ? { id: delegation.agent.deviceId, category: 'device' as const }
        : delegation.agent?.externalAgentId
          ? { id: delegation.agent.externalAgentId, category: 'external' as const }
          : participantIdentity(undefined, delegation.agent?.presetId ?? workflow.agentPreset?.id)),
  };
}
/** One turn inside an existing delegation's folded exchange. */
function DelegatedMessage({
  message,
  workflow,
  caller,
  state,
  pinned,
  onPinMessage,
  pinBusy,
  api,
  notify,
  onQuoteMessage,
  onConversation,
  onManageConnectors,
}: {
  onConversation?: (conversation: Conversation) => void;
  onManageConnectors?: () => void;
  message: ConversationMessage;
  workflow: Workflow;
  caller?: Workflow;
  state: AppState;
  pinned?: boolean;
  onPinMessage?: (id: string) => void;
  pinBusy?: boolean;
  /** For an outside agent's reply: its retry and hand-over buttons. */
  api?: Api;
  notify?: Notify;
  onQuoteMessage?: (message: ConversationMessage) => void;
}) {
  message = resumedMessage(message);
  const delegation = workflow.delegation!;
  const { from, to, fromIdentity, toIdentity } = delegatedParties(message, workflow, caller, state);
  const result = message.role === 'assistant';
  const speakerIdentity = result ? toIdentity : fromIdentity;
  const role = delegationRoleLabels[delegation.role];
  const bubble = (
    <article
      className={`delegated-message participant-card ${result ? 'result' : 'task'}`}
      style={participantStyle(result ? to : from, speakerIdentity)}
      data-message-id={message.id}
    >
      <ParticipantHeading
        name={result ? to : from}
        identity={speakerIdentity}
        to={result ? from : to}
        kind={result ? participantKind(message) : `子任务 · ${role}`}
        at={message.createdAt}
      ></ParticipantHeading>
      <div className="delegated-body">
        {state.settings?.showAutomaticReplyIdentity !== false && (
          <ReplyIdentity identity={namedIdentity(replyIdentity(message, workflow, state.runs), state.targets)} />
        )}
        {externalReplyIsNotice(message) ? null : message.systemNotice ? (
          <>
            <SystemNoticeView notice={message.systemNotice} />
            {message.content.trim() && message.content !== message.systemNotice.text && (
              <ParticipantBody>
                <MessageText text={message.content} />
              </ParticipantBody>
            )}
          </>
        ) : message.role === 'assistant' && message.webSearch ? (
          <WebSearchReply
            message={message}
            workflow={state.workflows?.find((item) => item.id === message.webSearch?.answer?.workflowId)}
            api={api}
            notify={notify}
          />
        ) : message.replyIdentity?.kind === 'system' && !message.device ? (
          <p className="system-notice-text">{translateInterfaceText(message.content)}</p>
        ) : (
          <ParticipantBody>
            <MessageText text={message.content} />
          </ParticipantBody>
        )}
        {message.externalAgent && notify && (
          <ExternalReplyPanel message={message} api={api} notify={notify} onManageConnectors={onManageConnectors} />
        )}
      </div>
      <div className="message-actions">
        {api && notify && onConversation && (
          <MessageBranchActions message={message} api={api} notify={notify} onConversation={onConversation} />
        )}
        {onQuoteMessage && (
          <button
            type="button"
            className="icon-button"
            title="引用"
            aria-label="引用"
            onClick={() => onQuoteMessage(message)}
          >
            <Quote size={13} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="复制"
          aria-label="复制回复"
          onClick={() =>
            void navigator.clipboard
              .writeText(message.content)
              .catch(() => notify?.({ tone: 'error', message: '无法复制，请选择文本后复制。' }))
          }
        >
          <Copy size={13} />
        </button>
        {onPinMessage && (
          <button
            type="button"
            className={`icon-button delegated-pin ${pinned ? 'message-pin-active' : ''}`}
            aria-label={pinned ? '取消置顶' : '置顶消息'}
            aria-pressed={Boolean(pinned)}
            disabled={pinBusy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPinMessage(message.id);
            }}
          >
            <Pin size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
  return message.resumed && !message.content.trim() ? null : bubble;
}

function Message({
  message,
  searchWorkflow,
  api,
  persona,
  participantIdentity: speakerIdentity,
  identity,
  notify,
  pending,
  onRecoverPending,
  recoverPendingDisabled,
  pinned,
  onPinMessage,
  pinBusy,
  mentionNames = [],
  onQuoteMessage,
  onMarkup,
  onConversation,
  onManageConnectors,
  lastUserMessage,
  running,
  ownMessage = true,
}: {
  onConversation?: (conversation: Conversation) => void;
  onManageConnectors?: () => void;
  lastUserMessage?: boolean;
  running?: boolean;
  ownMessage?: boolean;
  message: ConversationMessage;
  searchWorkflow?: Workflow;
  /** For an external agent's reply: its actions (apply, retry, hand over). */
  api?: Api;
  /** The role that answered, when it was not the default assistant; already shown (ParticipantHeading). */
  persona?: string;
  participantIdentity?: ParticipantIdentity;
  identity?: ConversationMessage['replyIdentity'];
  notify: Notify;
  pending?: PendingComposerSend;
  onRecoverPending?: (item: PendingComposerSend) => void;
  recoverPendingDisabled?: boolean;
  pinned?: boolean;
  onPinMessage?: (id: string) => void;
  pinBusy?: boolean;
  mentionNames?: string[];
  onQuoteMessage?: (message: ConversationMessage) => void;
  onMarkup?: (result: MarkupResult) => boolean;
}) {
  message = resumedMessage(message);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const participant = message.role === 'assistant' && Boolean(persona);
  const actions = (
    <div className="message-actions">
      {api && onConversation && !pending && !message.id.startsWith('pending:') && (
        <MessageBranchActions
          message={message}
          api={api}
          notify={notify}
          onConversation={onConversation}
          onEdit={
            message.role === 'user' && ownMessage && !message.externalRequest ? () => setEditing(true) : undefined
          }
          lastUserMessage={lastUserMessage}
          running={running}
          // A branch starts from an answer; the user's own message is edited or resent instead.
          fork={message.role !== 'user'}
        />
      )}

      {participant && onQuoteMessage && message.content && !externalReplyIsNotice(message) && (
        <button
          type="button"
          className="icon-button"
          title="引用"
          aria-label="引用"
          onClick={() => onQuoteMessage(message)}
        >
          <Quote size={13} />
        </button>
      )}
      {onPinMessage && !pending && !message.id.startsWith('pending:') && (
        <button
          type="button"
          className={`icon-button ${pinned ? 'message-pin-active' : ''}`}
          title={pinned ? '取消置顶' : '置顶消息'}
          aria-label={pinned ? '取消置顶' : '置顶消息'}
          aria-pressed={Boolean(pinned)}
          disabled={pinBusy}
          onClick={() => onPinMessage(message.id)}
        >
          <Pin size={13} />
        </button>
      )}
      {(message.role === 'assistant' || message.role === 'user') && message.content && (
        <button
          type="button"
          className="icon-button"
          title="复制"
          aria-label={message.role === 'user' ? '复制消息' : '复制回复'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify({ tone: 'error', message: '无法复制，请选择文本后复制。' });
    }
  }
  const bubble = (
    <article
      className={`conversation-message message-${message.role}${pending ? ' pending-send' : ''}${participant ? ' participant-card' : ''}`}
      style={participant ? participantStyle(persona!, speakerIdentity) : undefined}
      data-message-id={message.id}
    >
      {participant ? (
        <div className="message-participant-heading" title={dateLabel(message.createdAt)}>
          <ParticipantHeading
            name={persona!}
            identity={speakerIdentity}
            kind={participantKind(message)}
            at={message.createdAt}
          >
            <ReplyIdentity identity={identity} />
          </ParticipantHeading>
        </div>
      ) : (
        <div className="message-heading">
          <span title={dateLabel(message.createdAt)}>{message.role === 'user' ? '你' : (persona ?? 'PugPort')}</span>
          <time dateTime={message.createdAt}>{dateLabel(message.createdAt, true)}</time>
          <ReplyIdentity identity={identity} />
          {pending && !pending.error && (
            <small className="pending-send-state" role="status">
              <Loader2 size={11} className="spinning" />
              发送中
            </small>
          )}
        </div>
      )}
      {pending?.error && (
        <div className="pending-send-error" role="alert">
          <p>{pending.error}</p>
          <button
            type="button"
            className="button secondary tiny"
            disabled={recoverPendingDisabled}
            onClick={() => onRecoverPending?.(pending)}
          >
            恢复到输入框
          </button>
        </div>
      )}
      {pending?.images.length ? (
        <div className="pending-send-images">
          {pending.images.map((src) => (
            <AttachmentThumbnail key={src} src={src} />
          ))}
        </div>
      ) : null}
      {Boolean(message.attachments?.length) && (
        <MessageAttachments
          conversationId={message.conversationId}
          attachments={message.attachments!}
          onMarkup={onMarkup}
        />
      )}
      {message.generatedImages?.length ? (
        <small className="generated-image-source" translate="no">
          {generatedImageCaption(message.generatedImages)}
        </small>
      ) : null}
      {message.quotes?.length ? <MessageQuotes quotes={message.quotes} /> : null}
      {editing && api && onConversation ? (
        <SentMessageEditor
          message={message}
          api={api}
          notify={notify}
          onConversation={onConversation}
          onCancel={() => setEditing(false)}
        />
      ) : externalReplyIsNotice(message) ? null : message.systemNotice ? (
        <>
          <SystemNoticeView notice={message.systemNotice} />
          {message.content.trim() && message.content !== message.systemNotice.text && (
            <MessageText text={message.content} />
          )}
        </>
      ) : message.role === 'assistant' && message.webSearch ? (
        <WebSearchReply message={message} workflow={searchWorkflow} api={api} notify={notify} />
      ) : message.replyIdentity?.kind === 'system' && !message.device ? (
        <p className="system-notice-text">{translateInterfaceText(message.content)}</p>
      ) : message.content ? (
        participant ? (
          <ParticipantBody>
            <MessageText text={message.content} />
          </ParticipantBody>
        ) : message.role === 'user' && /@{1,3}/.test(message.content) ? (
          <MentionText text={message.content} names={mentionNames} />
        ) : (
          <MessageText text={message.content} />
        )
      ) : null}
      {message.combinedFrom?.length ? <CombinedReplyNote names={message.combinedFrom} /> : null}
      {message.externalAgent && (
        <ExternalReplyPanel message={message} api={api} notify={notify} onManageConnectors={onManageConnectors} />
      )}
      {message.steering && (
        <p className={`steering-status steering-${message.steering.status}`} role="status">
          {message.steering.status === 'pending'
            ? '正在补充到当前任务…'
            : message.steering.status === 'accepted'
              ? '执行器已接收补充（steer）'
              : message.steering.error || '无法确认补充是否送达，请核对当前任务后决定是否重发。'}
        </p>
      )}
      {actions}
    </article>
  );
  return message.resumed && !message.content.trim() ? null : bubble;
}

export function SystemNoticeView({ notice }: { notice: SystemNotice }) {
  const received = notice.details
    ?.split('\n')
    .filter((line) => /^(?:收到来自「[^\r\n]+」的文件：|Received from [^\r\n]+: )<[^\r\n]+>$/.test(line));
  return (
    <div className="system-notice" role="status">
      <p className="system-notice-text">{translateInterfaceText(notice.text)}</p>
      {notice.stop?.step !== undefined && (
        <p className="system-notice-stop" translate="no">
          {withNames('停在第 {0} 步：{1}', [String(notice.stop.step), notice.stop.title ?? ''])}
        </p>
      )}
      {notice.stop?.reason && (
        <blockquote className="system-notice-reason">
          <span>执行器的说明：</span>
          <span translate="no">{notice.stop.reason}</span>
        </blockquote>
      )}
      {received?.length ? <MessageText text={received.join('\n')} /> : null}
      {notice.details && (
        <details className="system-notice-details">
          <summary>详情</summary>
          <pre translate="no">
            {localizeNoticeDetails(
              notice.details,
              (text) => {
                const translated = translateInterfaceText(text);
                return translated === text ? undefined : translated;
              },
              currentLocale() !== 'en',
            )}
          </pre>
        </details>
      )}
    </div>
  );
}
