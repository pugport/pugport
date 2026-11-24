import type { UsageReport } from './usage.ts';
import type { TaskJudgment, JudgmentUsageReport } from './task-judgment.ts';
import type { MemoryEvidenceReport } from './memory-evidence.ts';
export type Provider = 'codex' | 'claude' | 'grok' | 'cursor' | 'gemini' | 'pi' | 'dsh';
export type TaskKind = 'auto' | 'design' | 'architecture' | 'routine' | 'general';
export type RuntimeTarget = {
  accountId?: string;
  accountHome?: string;
  sharedConfigNote?: string;
  accountFingerprint?: string;
  /** Non-secret connection generation; rotated when API credentials are replaced. */
  responseLatencyEpoch?: string;
  agentDir?: string;
  /** 'magpie' is retained only to recognize retired targets in saved history. */
  gateway?: 'magpie' | 'api';
  /** For gateway 'api': which API platform (see shared/api-providers). */
  apiProvider?: string;
  apiBaseUrl?: string;
  apiConnection?: import('./api-providers.ts').ApiConnection;
  apiMayLog?: boolean;
  apiBudget?: import('./api-providers.ts').ApiBudgetPolicy;
  /** Anthropic: the workspace every request names, for a key that is not scoped to one. Not a secret. */
  apiWorkspaceId?: string;
  id: string;
  provider: Provider;
  label: string;
  command: string;
  args?: string[];
  environment: 'native' | 'wsl';
  enabled: boolean;
  /** Explicit execution opt-out; discovery and login must never clear it. */ executionDisabledByUser?: boolean;
  /** The one-time credit (its startedAt) that already switched this API card off when it expired or ran out. */
  creditEndedClosed?: string;
  commandDiscovery?: 'auto' | 'fixed';
  accountingMode?: 'subscription' | 'usage' | 'auto';
};
export type ModelInfo = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  /** Pi's built-in default for this provider, observed during discovery. */
  catalogDefault?: boolean;
  /** Listed by the provider but absent from Pi's catalog; manual selection only, price unknown. */
  discovered?: boolean;
  lightweight?: boolean;
  /** Cursor's billing pool; dynamic means Auto or an unclassified model may use either pool. */
  quotaPool?: 'cursor' | 'other' | 'dynamic';
  /** The CLI falls back to asking for every tool with this model, so automatic execution cannot use it. */
  noAutoApproval?: boolean;
  /** Catalog price, USD per million tokens, when the runtime publishes one. */
  price?: { input: number; output: number };
  priceSource?: 'user-estimate';
  /** The runtime's catalog says whether this model reads images; absent means the executor's own capability decides. */
  imageInput?: boolean;
};
export type QuotaWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  durationMinutes?: number | null;
  /** Sparse provider updates keep each unchanged window's own observation time for routing freshness. */
  observedAt?: string;
  /** A model-specific pool, not a limit shared by every model on this account. */
  modelPool?: 'cursor' | 'other';
  /** Claude's separate family limit; shared session/week limits still apply to every family. */
  modelFamily?: 'fable' | 'opus' | 'sonnet' | 'haiku';
  /** The provider explicitly returned no reset; does not imply restored quota. */ resetNotReported?: boolean;
  /** When a billing period without a fixed length began (Cursor), so its length is the time to resetsAt. */
  periodStartedAt?: string;
  stale?: boolean;
};
export type ResetCredits = {
  availableCount: number | null;
  details: Array<{
    key?: string;
    kind: 'full' | 'unknown';
    status: 'available' | 'consumed' | 'expired' | 'unknown';
    grantedAt: string | null;
    expiresAt: string | null;
  }> | null;
  source: string;
  observedAt: string;
};
export type CursorCredits = {
  /** Account credit (positive) or an amount owed (negative); null when not reported. */
  accountUsd?: number | null;
  balanceUsd: number | null;
  totalUsd: number | null;
  usedUsd: number | null;
  grants: Array<{ name: string; remainingUsd: number | null; totalUsd: number | null; expiresAt: string | null }>;
  /** Usage-based spending beyond the plan; null when not reported. */
  onDemand: { enabled: boolean; limitUsd: number | null; usedUsd: number | null } | null;
};
export type SubscriptionPlan = { label: string; source: string; observedAt: string };
export type ExecutorCooldown = {
  reason: 'failures';
  streak: number;
  errorCode: string;
  observedAt: string;
  retryAt: string;
  detail?: string;
};
export type RuntimeSnapshot = {
  /** Internal discovery result consumed by the controller. */
  grokHandshakeAttempt?: { passed: boolean };
  executorCooldown?: ExecutorCooldown;
  costTier?: 'free';
  local?: boolean;
  mayLog?: boolean;
  autoResetNotes?: string[];
  gateway?: RuntimeTarget['gateway'];
  apiProvider?: string;
  apiConnection?: import('./api-providers.ts').ApiConnection;
  apiBudgetState?: import('./api-providers.ts').ApiBudgetView;
  subscription?: SubscriptionPlan;
  authMode?: 'chatgpt' | 'apiKey' | 'unknown';
  accountFingerprint?: string;
  availability?: import('./accounts.ts').AccountAvailability;
  /** Last verified CLI identity; hashes only, never credentials or raw account identifiers. */
  cursorVerifiedIdentity?: { fingerprint: string; observedAt: string; emailHash: string; userIdHash?: string };
  /** Historical request evidence; a cooldown ending does not prove recovery. */
  lastRequestFailure?: import('./accounts.ts').AccountRequestFailure;
  /** The account's last quota or rate-limit cooldown ended recently, here; it takes sub-tasks back one at a time. */
  cooldownEndedAt?: string;
  id: string;
  provider: Provider;
  label: string;
  environment: 'native' | 'wsl';
  installed: boolean;
  status: 'ready' | 'unknown' | 'auth-required' | 'error' | 'missing' | 'refreshing';
  version?: string;
  models: ModelInfo[];
  /**
   * API cards: image and video models the platform lists, shown in the model picker's Image and Video groups. Never
   * part of text routing, which reads models only.
   */
  mediaModels?: import('./model-groups.ts').MediaModelInfo[];
  /** Executor-reported default model, when discovery exposes it. */
  defaultModel?: string;
  quota: {
    status: 'known' | 'unknown' | 'error';
    source: string;
    observedAt: string | null;
    windows: QuotaWindow[];
    resetCredits?: ResetCredits;
    subscription?: SubscriptionPlan;
    /** Grok Bot's billing identity and reported period start; never infer a reset from this date. */
    billingBrand?: string;
    currentPeriodStart?: string;
    note?: string;
    /** Cursor only: credit grants and on-demand spending, as cursor.com reports them (USD). */
    cursorCredits?: CursorCredits;
    /** Grok only: prepaid extra usage credits (USD) and whether auto top-up is on; null when not reported. */
    grokCredits?: { extraUsd: number | null; autoTopup: boolean | null };
    /** Grok billing mode and whether its percentage was reported or inferred. */
    grokBilling?: {
      isUnifiedBillingUser: boolean | null;
      percentSource: 'cli-reported' | 'web-reported' | 'legacy-calculated' | 'implicit-zero' | 'unknown';
    };
    /** Explicitly reported by the provider; empty windows alone never imply unlimited usage. */
    unlimited?: boolean;
  };
  /** Same-account last verified reading for display only; never routing or fresh quota evidence. */
  lastKnownQuota?: RuntimeSnapshot['quota'];
  accounting?: { mode: 'subscription' | 'usage' | 'unknown'; source: string; note?: string };
  lastConnectionTest?: { at: string; ok: boolean; model: string; error?: string };
  note?: string;
  errorDetail?: string;
  capabilities: {
    execute: boolean;
    resume: boolean;
    cancel: boolean;
    approvals: boolean;
    steer?: boolean;
    /** The connected adapter can deliver image pixels; absence is not vendor-wide vision support. */
    imageInput?: boolean;
    /**
     * The adapter can run with no file, search, shell, web, MCP or extension tools at all, so the model answers
     * from the given text only. Required for tasks that carry other people's words (`untrustedContent`).
     */
    toolless?: boolean;
  };
  refreshedAt: string;
};
export type TaskSchedule = {
  deadlineAt?: string;
  notBefore?: string;
  priority?: 'normal' | 'high';
  estimatedMinutes?: number;
  preferExpiringQuota?: boolean;
};
export type RunInput = {
  /** Host-only fresh web fact checker; omit native instruction files and memory. */
  factCheck?: boolean;
  /** Host-validated project memory directory, never taken from a model or run API. */
  autoMemoryDirectory?: string;
  /** Host-only: answer from saved search sources without granting another paid Search/Fetch call. */
  searchAlreadyPerformed?: boolean;
  /** Task approval override; device-origin tasks use auto, absent inherits the global setting. */
  toolApprovalMode?: 'auto' | 'ask';
  /** Host-only, consumed by the first successful start after an inline busy-machine choice. */
  bypassMachineLoad?: boolean;
  freeChain?: boolean;
  /** Host-built context allowed on sources that may log prompts. */
  textOnlyPrompt?: string;
  textOnly?: boolean;
  /** Bounded free retry state; never accepted from the public message schema. */
  freeRelayCount?: number;
  /** Host-only background note job; never redeem reset cards for it. */
  memoryDistillation?: boolean;
  /** Card IDs allowed for automatic routing; absent inherits global settings. */
  automaticExecutors?: string[];
  /** Trusted hint: a rule or internal workflow selected the executor, rather than an explicit pin. */
  automaticExecutorSelection?: boolean;
  /** A bounded collaborative task sharing the ordinary router, permissions and audit. */
  swarm?: boolean;
  /** Exact user-authored request, kept separately from the assembled executor prompt. */
  userInput?: string;
  /** Host-verified self-contained reply with an explicit no-tools request; may skip waiting for unrelated MCP servers. */
  selfContainedChat?: boolean;
  /** Host-verified greeting or literal reply with no task dependencies; also guides response-latency routing. */
  latencySensitiveChat?: boolean;
  /** Host-verified current-user speech/recall request explicitly forbids tools; not a routing or privacy hint. */
  explicitNoTools?: boolean;
  /** Host-derived prohibition of actual shell/command execution; never a model permission grant. */
  prohibitCommands?: boolean;
  /** Host-derived from Laya's choices or a pre-read video link: the turn needs local programs; never a grant. */
  needsLocalPrograms?: boolean;
  /** A human executor choice is a preference for technical failover; absent keeps direct callers strict. */
  allowExecutorFallback?: boolean;
  /** runtimeId was read from the message, not pinned in the UI: a preference that never blocks the task. */
  runtimeIdFromMessage?: boolean;
  /** runtimeId came from the chat's saved Navigator route: relaxed like a message preference, with a note. */
  runtimeIdFromMode?: boolean;
  /** Trusted hint for the root task of a work-mode turn; children carry none. */
  workMode?: import('./work-modes.ts').WorkMode;
  agentPreset?: { id: string; name: string };
  /** Per task kind, executors that recently failed most of their tasks of that kind; automatic routing tries others first. */
  struggling?: Partial<Record<TaskKind, string[]>>;
  attachments?: RunAttachment[];
  provider?: Provider;
  relayFromRunId?: string;
  /** Why this run takes over from relayFromRunId: the account ran out, or the executor refused the content. */
  relayReason?: 'content' | 'quota' | 'technical' | 'selection';
  /** A hop of the vendor relay after a provider's policy block; the Codex/Claude content chain leaves it alone. */
  vendorRelay?: boolean;
  /** The pinned choice a technical relay leaves (a sub-task's comes from its caller); the new run says so plainly. */
  relayPin?: { runtimeId?: string; provider?: Provider; byCaller?: boolean };
  relayProvider?: Provider;
  excludeRuntimeIds?: string[];
  /** Never route to these providers (cross-review uses it to force a different vendor). */
  excludeProviders?: Provider[];
  taskJudgment?: TaskJudgment;
  routingRules?: RoutingRuleSet;
  /** Server-owned reviewer role candidates, tried in order before automatic cross-review. */
  verifierCandidates?: RoutingCandidate[];
  /** Host-owned answer route. Verification excludes it before a different-effort fallback. */
  verifierOf?: { provider: Provider; runtimeId: string; model: string; effort?: string };
  category?: { id: string; confidence: 'high' | 'low'; reason: string };
  /** Rules are automatic choices, never human pins (stage 3 checklist hook). */
  routeRule?: { id: string; label: string; index: number; strict: boolean; derived: true };
  confirmedRoute?: { accountFingerprint?: string; runtimeId: string; model: string; effort?: string };
  prompt: string;
  projectPath: string;
  kind: TaskKind;
  /** Server-owned hint: this input executes a model-planned step, including a resumed plan. */
  plannerStep?: boolean;
  /** Server-owned: the whole task's request (with any referenced brief); a step is never routed below it. */
  taskRoutingPrompt?: string;
  runtimeId?: string;
  model?: string;
  effort?: string;
  /** Automatic task or calling executor advice: a selection target, never a human pin. */
  suggestedEffort?: string;
  /** Automatic model-tier advice, bounded by the user's routing goal and hard constraints. */
  suggestedTier?: 'light' | 'standard' | 'strong';
  /** Trusted workflow hint: the main task of a swarm, which plans, splits and merges; it gets a strong model. */
  coordinator?: boolean;
  /** Trusted workflow hint: that coordinator shares out a message in which the user called several participants. */
  calledParticipants?: boolean;
  /** Trusted workflow hint: a read-only sub-task an executor handed over (research, reading, review). */
  readOnlyMember?: boolean;
  resumeRunId?: string;
  /** Trusted workflow hint: reuse only when the normal route still selects the same native account. */
  continuationRunId?: string;
  /** Compact current-turn prompt used only after continuationRunId is validated. */
  continuationPrompt?: string;
  continuationAlternates?: Array<{ runId: string; runtimeId: string; accountFingerprint?: string; prompt: string }>;
  /** Trusted workflow hint: the current message starts new work instead of continuing the previous one. */
  continuationNewTask?: boolean;
  /** Trusted workflow hint: the continued session's context size and when its last run ended (prompt-cache stickiness). */
  continuationContext?: { tokens?: number; endedAt?: string };
  /** Local selection revision, used to rebuild cached native tool catalogs after account changes. */
  connectorRevision?: string;
  allowUnknownQuota?: boolean;
  permissionMode?: 'read-only' | 'workspace-write';
  permissionOrigin?: import('./permission-reason.ts').PermissionOrigin;
  /** Host-only, per run: whether the dispatcher's ceiling lets this run use the network. Never from a public schema. */
  network?: boolean;
  /** Host-only, per run: Git folders a linked worktree needs for local commits. Never persisted or copied. */
  gitWritePaths?: string[];
  /** Host-only: a schedule or peer woke this run; it never gets network or Git paths. */
  backgroundTrigger?: { kind: 'schedule' | 'peer' | 'lane-answer'; id: string };
  /** The prompt carries words written by people other than the user: run tool-less (see MessageInput). */
  untrustedContent?: boolean;
  /** Host-only: a write turn whose context holds PugPort search results; it never gets full access. */
  webDriven?: boolean;
  verificationCommand?: string;
  executionPolicy?: ExecutionPolicy;
  /** The plan step asked for this transport; executionPolicy was narrowed to it as a preference, not a limit. */
  stepTransport?: 'cli' | 'api';
  workflowId?: string;
  stepId?: string;
  schedule?: TaskSchedule;
  routingPrompt?: string;
  /** Workspace execution steps request a truthful outcome report; planners do not. */
  reportTaskOutcome?: boolean;
  /** Workspace workflows confirm file evidence once after all steps and retries. */
  deferFileOutcome?: boolean;
  requiresFileChanges?: boolean;
  /** False skips receipt checks; true checks heuristic expectations without making them blocking. */
  checkFileChanges?: boolean;
  /** Trusted workflow hint: this run may hand work to other executors through the local agent bridge. */
  agentCalls?: boolean;
  /** Host-only, read-only image interpretation; it has no PugPort tool bridge or parent execution budget. */
  visualAssistant?: boolean;
  /** Host-only: make images with the executor's image tool or API and stage them in outputDir. */
  imageGeneration?: import('./image-generation.ts').ImageGenerationRequest;
  /**
   * Public observations supplied by a separately audited visual run; original pixels are not forwarded.
   * by: the executor that described the pictures, named in the routing reason.
   */
  visualContext?: { fromRunId: string; sourceAttachments: string[]; by?: string };
  /** Trusted workflow hint: this run is a sub-task another executor called, and may message its caller. */
  agentChild?: boolean;
  /** Trusted workflow hint: this is novel writing, so the fiction tools (style check) are offered. */
  fiction?: boolean;
  /** Trusted workflow hint: a writing sub-task's caller and declared files; see sideBySide in shared/scope. */
  writeShare?: { callerId: string; scope: readonly string[] };
  /** Trusted workflow hint: the conversation limits skills to these names. */
  skills?: string[];
  /** Host-owned per-conversation relevance checks; never widens the skill allowlist. */
  appliedSkills?: string[];
};
export type RunEvent = {
  /** Host-assigned sequence within this run; older stored events may not have one. */
  seq?: number;
  at: string;
  type: 'text' | 'reasoning' | 'status' | 'tool' | 'usage' | 'session' | 'error' | 'approval' | 'quota';
  text?: string;
  data?: Record<string, unknown>;
};
export type RouteDecision = {
  routeRule?: RunInput['routeRule'];
  /** Internal long-task scarcity result for the selected model's quota windows. */
  shortQuotaLeft?: number;
  /** Which window is that scarce, when it is not the 5-hour session window. */
  shortQuotaWindow?: string;
  /** Internal model-fit ranking used when comparing rule redirect alternatives. */
  modelFit?: number;
  /** The tier the task demanded; the chosen model may differ when that tier was unavailable. */
  targetTier?: 'light' | 'standard' | 'strong';
  accountFingerprint?: string;
  runtimeId: string;
  model: string;
  effort?: string;
  kind: TaskKind;
  reasons: string[];
  warnings: string[];
};
/** Settings confirmed by the native runtime, distinct from the requested route. */
export type EffectiveModelSelection = {
  model: string;
  effort?: string;
  parameters?: Record<string, string>;
  source: string;
};
export type ApprovalKey =
  | { tool: 'Bash'; command: string }
  | { tool: 'Codex file change' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'; paths: string[] };
export type ApprovalRule = { id: string } & (
  | { tool: 'Bash'; command: string }
  | { tool: 'Codex file change' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'; projectPath: string }
);
export type Approval = {
  id: string;
  runId: string;
  tool: string;
  description: string;
  createdAt: string;
  key?: ApprovalKey;
};
/** `summary` marks a broadcast copy whose events were dropped and output trimmed; fetch `/api/runs/:id` for the full record. */
export type SteeringStatus = {
  state: 'starting' | 'ready' | 'waiting' | 'finishing' | 'unsupported';
  /** Static adapter explanation; never raw protocol payloads or user content. */
  reason?: string;
};
/** Delivery progress for one human correction, distinct from whether a channel is available. */
export type SteeringProgress = {
  id: string;
  phase: 'sending' | 'received' | 'resuming' | 'failed';
  at: string;
  mode: 'interrupt' | 'append';
};
/** CLI process that exited before its protocol handshake. */
export type StartupFailure = {
  exitCode: number | null;
  elapsedMs: number;
  firstLine?: string;
};
export type FactCheckReport = {
  status: 'completed' | 'incomplete';
  claims: Array<{
    claim: string;
    status: 'verified' | 'wrong' | 'unverifiable';
    source?: string;
    correction?: string;
    reason?: string;
  }>;
  corrected?: number;
  reason?: string;
};

export type RunRecord = {
  apiProvider?: string;
  context?: { tokens: number; window?: number; at: string };
  textOnly?: boolean;
  /** Actual native tool scope for this run; absence retains the ordinary configured tools. */
  nativeToolMode?: 'none';
  /** Kept across restarts; a missing cost report retains this local reservation. */
  apiBudgetReservation?: { periodStartedAt: string; reservedUsd: number };
  /** Exact originating user message; never reconstructed by parsing a generated prompt. */
  userInput?: string;
  /** Host audit archive preserves every non-text event from the beginning of this run. */
  auditVersion?: 1;
  /** Public model deltas are archived too; absent on older non-text-only archives. */
  auditCapture?: 'public-events';
  /** Computed only when inspecting the complete numbered local archive. */
  auditEventsMissing?: number;
  agentPreset?: { id: string; name: string };
  /** Live input channel exists for this exact native turn; false once it ends. */
  steerAvailable?: boolean;
  /** Native input lifecycle, separate from whether the model supports it. */
  steeringStatus?: SteeringStatus;
  steeringProgress?: SteeringProgress;
  /** Accepted user corrections, retained for safe same-task handoff/retry. */
  steeringInputs?: string[];
  dataInputs?: string[];
  /** Thinking text the CLI streamed, when it exposes any. */
  reasoning?: string;
  summary?: boolean;
  toolApprovalMode?: 'auto' | 'ask';
  connectorRevision?: string;
  /** The tool scope used to create this native session, kept for safe continuation. */
  permissionMode?: 'read-only' | 'workspace-write';
  permissionOrigin?: import('./permission-reason.ts').PermissionOrigin;
  /** Ran with no tools at all, answering from the given text only, because the task carried other people's words. */
  toolless?: boolean;
  taskOutcome?: {
    status: 'completed' | 'partial' | 'blocked' | 'failed' | 'dropped' | 'unverified';
    source: 'executor-tool' | 'executor-report' | 'missing-report' | 'native-permission' | 'file-receipts';
    summary?: string;
    question?: { text: string; options?: string[] };
    verificationLimited?: boolean;
    limitedChecks?: Array<{ id: string; command: string; reason: string }>;
    /** What the executor says it did, each with the evidence it points to (empty when it has none). */
    claims?: Array<{ claim: string; evidence?: string; verified?: boolean; files?: string[] }>;
  };
  /** A heuristic suggested file changes, but receipts did not confirm them. Never a failure. */
  fileChangeNotice?: boolean;
  /** Images an image-generation run staged, with the executor and model that made each one. */
  generatedImages?: import('./image-generation.ts').GeneratedImage[];
  /** Check commands whose last run failed although the executor reported completion. */
  failedChecks?: string[];
  /** Controller's before/after project snapshots, never supplied by an executor. */
  measuredFileChanges?: {
    source: 'pugport-scope-snapshot';
    paths: string[];
    commits?: { before?: string; after: string };
  };
  hadToolActivity?: boolean;
  /** Captured before event retention, from native/bridge search and fetch calls. */
  webInformationUsed?: boolean;
  /** Written by Controller from the complete live native event stream, never inferred from assistant claims. */
  handoffCheckpoint?: {
    version: 1;
    source: 'native-tool-results';
    safe: boolean;
    observedAt: string;
    completedToolIds: string[];
    unconfirmedTools: Array<{ id: string; status: string }>;
    blockedReason?:
      'untrusted-progress' | 'unverified-error' | 'unconfirmed-tool' | 'missing-checkpoint' | 'host-mutation';
  };
  account?: { id: string; label: string; provider: Provider; fingerprint?: string };
  relay?: {
    fromRunId: string;
    fromRuntimeId: string;
    reason: 'quota' | 'authentication' | 'content' | 'technical' | 'selection';
    /** Plain notice when this run left an executor the user (or the calling executor) had pinned. */
    notice?: string;
  };
  id: string;
  prompt: string;
  projectPath: string;
  kind: TaskKind;
  status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  route: RouteDecision;
  effectiveModel?: EffectiveModelSelection;
  startedAt: string;
  endedAt?: string;
  /** Immutable execution transport and supplier captured at launch. */
  executionKind?: 'cli' | 'api';
  /** Adapter boundaries and first public text, independent of the restricted latency sample. */
  adapterStartedAt?: string;
  firstTextAt?: string;
  adapterEndedAt?: string;
  /** Successful, tool-free first-text timing captured by the host before event retention. */
  responseLatency?: import('../server/response-latency.ts').ResponseLatencySample;
  nativeSessionId?: string;
  output: string;
  error?: string;
  /** Stable adapter failure classification, separate from the user-facing diagnostic text. */
  errorCode?: string;
  /** Sanitized provider diagnostic; never used for routing. */
  errorDetail?: string;
  /** Set when the CLI exits before handshake. `error` stays the machine code. */
  startupFailure?: StartupFailure;
  events: RunEvent[];
  /** Number of events removed by retention; absent for legacy records of unknown completeness. */
  eventsDropped?: number;
  checkBaselines?: Array<{ command: string; files: string[] }>;
  verification?: {
    command: string;
    status: 'passed' | 'failed' | 'cancelled' | 'skipped';
    exitCode: number | null;
    output: string;
    receipt?: import('./run-evidence.ts').VerificationEvidenceReceipt;
  };
  parentRunId?: string;
  /** An auxiliary image interpretation, never a continuation session for the main executor. */
  visualAssistant?: boolean;
  visualContext?: { fromRunId: string; sourceAttachments: string[] };
  workflowId?: string;
  stepId?: string;
};
export type PluginInfo = {
  id: string;
  name: string;
  description: string;
  version?: string;
  installed: boolean;
  kind: 'runtime' | 'library' | 'reference';
  homepage: string;
  note?: string;
};
export type Settings = {
  /** Check GitHub for a new PugPort version once daily; absent means enabled. */
  updateCheck?: boolean;
  terminalPathDecided?: boolean;
  /** Share the read-only GitHub connection with executors; off by default. */
  github?: boolean;
  /** Private personal instructions for trusted executor prompts, up to 4000 characters. */
  globalInstructions?: string;
  externalCallers?: Partial<
    Record<import('../server/mcp-connect.ts').ConnectToolId, 'inherit' | 'read-only' | 'write'>
  >;
  /** Background note distillation; absent means disabled. */
  memoryDistillation?: { enabled: boolean; executors?: string[] };
  /** Optional project-scoped Hindsight pilot; disabled unless explicitly configured. */
  hindsight?: import('./hindsight.ts').HindsightSettings;
  sandbox?: Partial<Record<import('./sandbox.ts').SandboxProvider, import('./sandbox.ts').SandboxMode>>;
  sandboxWhenUnavailable?: 'stop' | 'run-as-today';
  /** Executors excluded from automatic routing; absent means every enabled card. */
  excludedExecutors?: string[];
  /** Legacy global checklist, read only during migration. */
  automaticExecutors?: string[];
  agentPresets?: import('./agent-presets.ts').AgentPreset[];
  toolApprovalMode?: 'auto' | 'ask';
  /** Legacy 'jev' values are decoded for migration; all active settings are local. */
  taskJudgment?: 'local' | 'jev';
  /** Voice for Mods: GPT Live on an OpenAI API card (absent = when one exists), or this computer only. */
  modVoiceProvider?: 'gpt-live' | 'local';
  laya?: import('./laya.ts').LayaSettings;
  /** Legacy 'jev' values are decoded for migration; all active evidence checks are local. */
  memoryEvidence?: 'local' | 'jev';
  decisionMode?: 'auto' | 'confirm';
  refreshSeconds: number;
  reservePercent: number;
  maxQuotaAgeSeconds: number;
  /** Only automatic redemption; routing never reads this setting. Off unless explicitly enabled. */
  autoUseResetCards?: boolean;
  preferCli: boolean;
  preferNative?: boolean;
  designProvider: Provider;
  architectureProvider: Provider;
  routineProvider: Provider;
  unknownQuotaPolicy: 'manual-only' | 'allow';
  defaultProjectPath: string;
  /** 0 means no limit on simultaneous tasks. */
  maxConcurrentRuns: number;
  /** Simultaneous tasks on one account; 0 or absent means no limit. */
  maxRunsPerAccount?: number;
  /** Direct Pi uses the API keys in your environment and Pi config; off unless explicitly allowed. */
  allowDirectPiApi?: boolean;
  /** Executors may hand work to another bound executor by its card name; on unless turned off. */
  agentBridge?: boolean;
  /** Ordered platforms per task category (see shared/route-policy.ts); absent categories use the defaults. */
  routePolicy?: Partial<Record<'design' | 'architecture' | 'general' | 'routine' | 'mature', string[]>>;
  /** Global content rules; conversation rules override each category. */
  routingRules?: RoutingRuleSet;
  routingRulesHistory?: RoutingRuleSet[];
  /** Reusable rules chosen explicitly per chat; automatic routing remains the default. */
  routingProfiles?: import('./routing-profiles.ts').RoutingProfile[];
  /** Fixed task-category/platform preferences are opt-in. */
  routePreferencesEnabled?: boolean;
  /** Writable tasks may move files inside the project to the Recycle Bin without asking; on unless turned off. */
  recycleWithoutAsking?: boolean;
  /**
   * Auto-steer is on by default. MessageInput.queue explicitly chooses queueing or steering for one send.
   */
  steerOnSend?: boolean;
  composerSendKey?: 'enter' | 'ctrl-enter';
  appearanceTheme?: 'system' | 'light' | 'dark';
  appearanceAccent?: 'blue' | 'violet' | 'teal' | 'pink';
  locale?: 'zh-CN' | 'zh-TW' | 'en';
  /**
   * Read the Cursor editor's login on this computer to show Cursor's live usage (Cursor has no public
   * balance query). Off unless the user turns it on.
   */
  cursorUsageFromEditor?: boolean;
  /**
   * When every Grok, Claude or Codex account a task is bound to is below the reserve line, run the same model
   * through Cursor (never adult material). On unless the user turns it off.
   */
  cursorFallback?: boolean;
  /** Automatic routing's goal: lighter and cheaper, balanced (default), or the strongest models. */
  routeGoal?: 'save' | 'balanced' | 'quality';
  /** Keep the computer from sleeping while tasks run; on unless turned off. */
  keepAwake?: boolean;
  /** Desktop notification when a task finishes: never, only when the conversation is not in view, or always. */
  notifyOnFinish?: 'never' | 'background' | 'always';
  notifySound?: boolean;
  /** Show the saved executor/model/effort beside automatically routed replies; off by default. */
  showAutomaticReplyIdentity?: boolean;
  /** Show conversations other agents start in the sidebar. Off unless turned on. */
  showAgentConversations?: boolean;
  /** Removed projects removed before this time are hidden from the Settings list; nothing is deleted. */
  removedProjectsClearedAt?: string;
};
export type BackgroundTask = {
  id: string;
  kind?: 'image-search' | 'media-analysis';
  conversationId: string;
  title: string;
  detail: string;
  done: number;
  total: number;
  startedAt: string;
  performance?: {
    observedAt: string;
    cpuPercent?: number;
    memoryPercent: number;
    freeMemoryBytes: number;
    assistBudget: number;
    maxAssistants: number;
    activeAssistedChecks: number;
    activeFrameReadLimit: number;
    reason:
      | 'warming-up'
      | 'balanced'
      | 'cpu-pressure'
      | 'memory-pressure'
      | 'staging-pressure'
      | 'throughput-regression'
      | 'calibrating';
    freshCompleted: number;
    freshChecksPerMinute?: number;
    throughputComparable: boolean;
    staging?: { copying: boolean; pendingPairs: number; activePairs: number; usedBytes: number; maxBytes: number };
  };
  mediaAudit?: {
    scope: 'pending' | 'complete' | 'partial';
    evidenceGroups: number;
    readErrors: number;
  };
  /** Local verifier lanes launched by an explicitly selected executor; model orchestration is separate from decoding. */
  assistance?: {
    maxWorkers: number;
    baseWorkers: number;
    maxFrameReaders: number;
    workers: Array<{
      workerId: string;
      accountLabel: string;
      direction: 'back';
      status: 'running' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'interrupted';
      checked: number;
      startedAt: string;
      updatedAt: string;
      elapsedSeconds: number;
      activePair?: number;
      runtimeId?: string;
      sessionId?: string;
      model?: string;
      effort?: string;
      error?: string;
    }>;
  };
  /** Running, or paused by the user (or cut off by a restart) and waiting to be continued. */
  state?: 'running' | 'paused';
  /** What is being searched: the folders, and the picture (with a URL the interface can show it from). */
  folders?: string[];
  reference?: string;
  previewUrl?: string;
  /** A multi-step job's steps in order; done/total above then belong to the step under way. */
  steps?: Array<{
    key?: string;
    label: string;
    state: 'done' | 'running' | 'pending';
    done: number;
    total: number | null;
    note?: string;
    elapsedSeconds?: number;
    remainingSeconds?: number;
    remainingRange?: import('./progress-estimate.ts').ProgressRemainingRange;
    estimateState?: import('./progress-estimate.ts').ProgressEstimateState;
    estimateNote?: string;
  }>;
  /** Estimated seconds left in the current step. */
  remainingSeconds?: number;
  remainingRange?: import('./progress-estimate.ts').ProgressRemainingRange;
  totalRemainingRange?: { minSeconds: number; maxSeconds?: number };
  estimateScope?: 'current-step' | 'whole-task';
  estimateNote?: string;
  /** Inventory recovery preserves saved features while checking which source files are still current. */
  resume?: {
    savedFiles: number;
    savedFingerprints: number;
    checkedFiles: number;
    checkingFiles: boolean;
    previousPhase?: string;
  };
};
/** How much of the subscriptions' quota got used (server/quota-history.ts). Percentages are whole numbers. */
export type QuotaUtilizationFigure = {
  /** 'ended': average peak of periods that ended in the last 30 days; 'current': none has yet, the share so far. */
  basis: 'ended' | 'current';
  percent: number;
  accounts: number;
  periods: number;
  /** PugPort saw too little of these periods; the real share may be higher. */
  partial: boolean;
};
export type QuotaUtilization = QuotaUtilizationFigure & {
  byProvider: Array<QuotaUtilizationFigure & { provider: Provider }>;
  /** The first reading on record. */
  since: string;
};
export type AppState = {
  problemReportCount?: number;
  account?: import('./account-ui.ts').AccountView;
  inbox?: import('./inbox.ts').InboxSummary;
  sandboxStatus?: import('./sandbox.ts').SandboxStatus;
  /** Subscription quota utilization; small, since state is broadcast often. */
  quotaUtilization?: QuotaUtilization;
  judgmentUsage?: JudgmentUsageReport;
  /** `status` comes from the Windows native updater; `mac` marks an entry from the signed Mac feed. */
  appUpdate?: { version: string; url?: string; status?: 'ready' | 'waiting'; mac?: true };
  app: {
    name: string;
    version: string;
    platform: string;
    dataDir: string;
    commit?: string;
    arch?: string;
    packaged?: boolean;
  };
  runtimes: RuntimeSnapshot[];
  targets: RuntimeTarget[];
  apiProviders?: import('./api-providers.ts').ApiProviderView[];
  /** Work that keeps going after a reply, such as a picture search; shown with its progress above the composer. */
  backgroundTasks?: BackgroundTask[];
  tasteTests?: TasteTest[];
  runs: RunRecord[];
  approvals: Approval[];
  plugins: PluginInfo[];
  settings: Settings;
  refreshing: boolean;
  usage?: UsageReport;
  projects?: Project[];
  removedProjects?: Project[];
  conversations?: Conversation[];
  /** Conversations other agents started that the owner has not written in. The sidebar is the only consumer. */
  agentConversationIds?: string[];
  conversationFolders?: import('./conversation-folders.ts').ConversationFolder[];
  workflows?: Workflow[];
  conversationPresentations?: Record<string, import('./conversation-presentation.ts').ConversationPresentation>;
  conversationPresentationRevisions?: Record<string, string>;
  conversationMessages?: ConversationMessage[];
};
/** An idle native child, owned by one controller and never persisted or shared across controllers. */
export type IdleNativeSession = {
  key: string;
  nativeSessionId: string;
  isAlive(): boolean;
  /** Idempotent, and resolves only when the owned child has stopped. */
  close(): Promise<void>;
};
export type ExecuteContext = {
  /** Host data root, used only to remove private paths from diagnostics. */
  dataDir?: string;
  /** Host-resolved project trust, never accepted from a run request or model prompt. */
  trustedProject?: boolean;
  sandbox?: import('../server/sandbox/policy-builder.ts').SandboxRequest;
  runTemp?: string;
  onSandboxFailure?: (reason: string, phase: 'startup' | 'runtime') => void;
  onSandboxSuccess?: () => void;
  /** Register only while the same native turn can accept additional user input. */
  registerSteer?: (
    handler: ((prompt: string, delivery?: { id: string; mode?: 'interrupt' | 'append' }) => Promise<void>) | undefined,
    status?: SteeringStatus,
  ) => void;
  /** Irreversibly revoke this execution's tools after native completion/error, before asynchronous cleanup. */
  endTools?: () => void;
  commandDenied?: () => boolean;
  approvalMode?: 'auto' | 'ask';
  target: RuntimeTarget;
  input: RunInput;
  route: RouteDecision;
  nativeSessionId?: string;
  /** The caller retains a successful child only after this run's normal settlement gates. */
  takeNativeSession?: (key: string, nativeSessionId?: string) => Promise<IdleNativeSession | undefined>;
  /** A host-observed native configuration digest; absent disables live process reuse. */
  nativeSessionConfiguration?: string;
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
  approve: (tool: string, description: string, key?: ApprovalKey) => Promise<boolean>;
  /** Local MCP endpoint and this run's bearer token, valid only while the run is active. */
  agentBridge?: {
    url: string;
    token: string;
    extraTools?: string[];
    /** Write-capable extension tools that retain native approval in ask mode. */
    askTools?: string[];
  };
  /** Host-owned spending estimate and cutoff, never model-provided. */
  apiBudget?: { maxCostUsd: number; expiresAt?: string };
};
export type ExecuteResult = {
  nativeSessionId?: string;
  idleNativeSession?: IdleNativeSession;
  output: string;
  /** Images an image-generation run staged in its request's outputDir. */
  generatedImages?: import('./image-generation.ts').GeneratedImage[];
  effectiveModel?: EffectiveModelSelection;
  /** Adapter-owned full quota RPC issued after the final native turn; never a stream notification. */
  postTurnQuota?: {
    source: 'codex/account/rateLimits/read';
    complete: true;
    accountFingerprint: string;
    turnCompletedAt: string;
    requestedAt: string;
    receivedAt: string;
    quota: RuntimeSnapshot['quota'];
  };
};
export type DiscoveryOptions = {
  grokHandshake?: { lastPassedVersion?: string; lastPassedSteer?: boolean; afterStartupFailure?: boolean };
  cursorVerifiedIdentity?: RuntimeSnapshot['cursorVerifiedIdentity'];
  cursorLastKnownQuota?: RuntimeSnapshot['quota'];
  /** Maximum age of a provider quota cache; zero requests a fresh observation. */
  quotaMaxAgeMs?: number;
};
export interface Adapter {
  discover(target: RuntimeTarget, options?: DiscoveryOptions): Promise<RuntimeSnapshot>;
  execute(context: ExecuteContext): Promise<ExecuteResult>;
}

export type ExecutionPolicy = 'cli-first' | 'cli-only' | 'api-only';
export type ProjectGates = {
  version: 1;
  updatedAt?: string;
  text?: { allow?: string[]; block?: string[] };
  alwaysAsk?: { paths?: string[]; branches?: string[] };
  windows?: { noMerge?: { from: string; to: string; tz?: string } };
  commitAuthor?: { emails: string[]; onMismatch?: 'refuse' | 'ask' };
};

export type Project = {
  /** Default saved routing profile for future turns in this project; conversations can override it. */
  routingProfileId?: string;
  /** Exact commands approved through the native desktop permission channel, for this project only. */
  approvedVerificationCommands?: string[];
  removedAt?: string;
  /** A permanent purge started and must be retried; such projects stay listed after Clear list. */
  purgePending?: boolean;
  /** Cached folder availability, populated when the project list refreshes. */
  folderMissing?: boolean;
  /** Explicit owner opt-in; absent means sandboxed. Covers descendant project paths. */
  trusted?: boolean;
  /** Installed MCP server IDs: absent inherits global enablement; an empty list disables MCP for this project. */
  mcpServers?: string[];
  /** The user's rules for this project (one each); every task follows them and review checks changes against them. */
  rules?: string[];
  /** Host-enforced GitHub gates. Missing alwaysAsk lists inherit defaults; empty lists disable them. */
  gates?: ProjectGates;
  /** Project-local CLI rules are installed only after explicit enrollment. */
  localMemory?: { exportEnabled: boolean; cliEnabled: boolean };
  /** The executor, model and effort the user picked in a blind taste test, per kind of writing. */
  writingPreferences?: WritingPreference[];
  /** The user asked not to start taste tests on their own in this project; the manual button still works. */
  tasteTestsOff?: boolean;
  /** For a novel: the folder holding the book's current chapters. Checks, writing and memory use only this one. */
  manuscript?: string;
  id: string;
  name: string;
  path: string;
  scope?: 'project' | 'chat';
  /** Created by external dispatch; missing folders can move to Chats automatically. */
  origin?: 'dispatch';
  createdAt: string;
  updatedAt: string;
};
/** Kinds of writing that keep separate preferences: adult material has fewer executors that will write it. */
export type WritingTopic = 'prose' | 'adult';
export type WritingPreference = {
  topic: WritingTopic;
  provider: Provider;
  model: string;
  effort?: string;
  /** e.g. "Claude · Opus 5.5 · xhigh". */
  label: string;
  /** What the user said about the passage they picked; later writing follows it. */
  reason?: string;
  chosenAt: string;
  testId: string;
  /** Provider/model pairs this test compared; a model not among them prompts another test. */
  tested: string[];
};
export type TasteCandidate = {
  key: 'A' | 'B' | 'C';
  provider: Provider;
  runtimeId: string;
  model: string;
  effort?: string;
  /** Shown only after the user picks, so the choice stays blind. */
  label: string;
  status: 'writing' | 'done' | 'failed';
  text?: string;
  error?: string;
  runId?: string;
  effectiveModel?: EffectiveModelSelection;
};
/** Several executors write the same short passage; the user picks one blind and the pick is remembered. */
export type TasteTest = {
  id: string;
  projectId: string;
  conversationId: string;
  topic: WritingTopic;
  /** What every candidate was asked to write. */
  brief: string;
  status: 'writing' | 'ready' | 'chosen' | 'dismissed' | 'failed';
  candidates: TasteCandidate[];
  chosen?: TasteCandidate['key'];
  /** What the pick means: the best of this batch but still not good enough, or good enough. */
  verdict?: 'better' | 'good';
  reason?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type LocalMemorySettings = {
  exportEnabled: boolean;
  cliEnabled: boolean;
  archiveDirectory: string;
  projectDirectory: string;
  dataDirectory: string;
  files: string[];
  legacyFiles?: string[];
  warnings: string[];
};
/** What a routing rule applies to: adult passages, everything else, splitting the work, or merging it. */
export type RoutingTopic = 'adult' | 'other' | 'split' | 'merge';
/** An executor card or a provider; neither means "choose automatically". */
export type RoutingTarget = { provider?: Provider; runtimeId?: string };
export type ConversationRoutingRule = {
  topic: RoutingTopic;
  target: RoutingTarget;
  strict: boolean;
  /** A model of the target executor; absent means that executor's default. */
  model?: string;
  /** Reasoning effort for that model; absent means the model's default. */
  effort?: string;
};
export type LegacyConversationRouting = {
  /** Automatic executor checklist override; absent inherits global settings. */
  automaticExecutors?: string[];
  /** The user's own words, typed or dictated; also given to the coordinator as reference. */
  text: string;
  rules: ConversationRoutingRule[];
  /** One chapter or section per sub-agent, each with a fresh context. */
  chapterAgents: boolean;
  /** Adult passages are replaced with placeholders before a chapter goes to a non-adult executor. */
  mask: boolean;
  updatedAt: string;
};
export type RoutingCandidate = RoutingTarget & { model?: string; effort?: string };
export type RoutingRule = {
  id: string;
  category: string;
  candidates: RoutingCandidate[];
  strict: boolean;
  enabled: boolean;
  clause?: string;
  source: 'parsed' | 'manual' | 'migrated';
};
export type RoutingCategory = { id: string; label: string; description?: string; keywords?: string[] };
export type RoutingRuleSet = {
  roles?: { coordinator?: RoutingCandidate; merger?: RoutingCandidate; verifier?: RoutingCandidate[] };
  /** Existing profiles keep their ordered candidates unless this is explicitly selected. */
  selection?: 'ordered' | 'quota';
  excludeModels?: string[];
  version: 2;
  text: string;
  rules: RoutingRule[];
  unparsed: string[];
  categories?: RoutingCategory[];
  updatedAt: string;
};
export type ConversationRouting = RoutingRuleSet & {
  /** Automatic executor checklist override; absent inherits global settings. */
  automaticExecutors?: string[];
  chapterAgents: boolean;
  mask: boolean;
};
/** Old records remain readable; all PATCH writes are v2. */
export type ConversationRoutingData = ConversationRouting | LegacyConversationRouting;
export type PinnedMessageFollowUpStatus = 'todo' | 'waiting' | 'done';
export type ConversationMessagePin = {
  messageId: string;
  pinnedAt: string;
  /** Follow-up is an explicit human record; it never changes an associated task's execution status. */
  tracking?: 'task' | 'follow-up';
  /** Human status only when tracking a follow-up; actual task status always wins in task mode. */
  followUpStatus?: PinnedMessageFollowUpStatus;
  /**
   * What the pinned message is for. Absent while the background summary is pending; 'extract' is the final local
   * fallback (incognito, or the model gave up). Lives on the pin so it syncs with it.
   */
  summary?: PinnedMessageSummary;
};
export type PinnedMessageSummary = {
  title: string;
  description: string;
  source: 'model' | 'extract';
  at: string;
};
export type Conversation = {
  /** Ordinary chats opt into collaboration; project chats already provide it. */
  collaborationEnabled?: boolean;
  childWorkspaceMode?: 'snapshot' | 'branch';
  lane?: {
    parentConversationId: string;
    sourceWorkflowId: string;
    workspaceId?: string;
    base?: string;
    baseCommit?: string;
    branch?: string;
    files?: string[];
    after?: string[];
    cleanup?: { at: string; status: 'removed' | 'kept'; reason?: string; head?: string };
    /** The coordinator's task-list item (create_lane plan_id) this lane works on. */
    planItem?: string;
    /** GitHub binding; repository is unknown until a PR is opened or watched. */
    github?: { repository?: string; issue?: number; pull?: { number: number; url?: string }; boundAt: string };
    /** Last derived PR state; written only when it changes, never bumps updatedAt. */
    githubState?: {
      state: import('./lane-github.ts').LaneGitHubState;
      headSha: string;
      checks: { passed: number; failed: number; pending: number };
      /** When this state last changed; the last poll time is the monitor job's lastCheckedAt. */
      observedAt: string;
    };
  };
  /** Composer work mode; absent = Normal. Snapshotted onto each task at enqueue. */
  workMode?: import('./work-modes.ts').WorkMode;
  /** Navigator only: the card/model/effort the lead runs on; absent = automatic. A preference that re-routes. */
  navigatorRoute?: { runtimeId: string; model?: string; effort?: string };
  /** Navigator only: the swarm/collaboration flags from before the mode, restored when leaving it. */
  navigatorRestore?: { swarm?: boolean; collaborationEnabled?: boolean };
  /** Mods author: the authoring folder record (mod-workspace) this chat builds in. */
  modWorkspaceId?: string;
  /** Mods author: a loaded local build waits for the user's approval of these permissions. */
  modApproval?: {
    modeId: string;
    version: string;
    title: string;
    permissions: import('./mods-manifest.ts').ModPermission[];
    requestedAt: string;
  };
  modeBinding?: import('./conversation-modes.ts').ModeBinding;
  pendingModeBinding?: import('./conversation-modes.ts').PendingModeBinding;
  modeHidden?: true;
  /** When a Mod model run in this chat last finished; open panels re-read the Mod's state. */
  modeRunsAt?: string;
  memory?: 'off';
  incognito?: boolean;
  closedAt?: string;
  swarm?: boolean;
  /** When false, a busy conversation accepts only immediate native steering. */
  queueingEnabled?: boolean;
  /** Independent conversation; source-chat context is refreshed when submitting questions. */
  sideChat?: {
    parentConversationId: string;
    anchorMessageId?: string;
    quote?: string;
    context: string;
    selection: Pick<MessageInput, 'provider' | 'runtimeId' | 'model' | 'effort' | 'executionPolicy'>;
  };
  grokHistory?: { syncedAt: string; sessions: number; messages: number };
  /** Changes to retained task metadata outside the bounded live workflow list. */
  workflowHistoryRevision?: number;
  /** Visible logical child tasks, derived from retained records rather than the live history page. */
  delegationCount?: number;
  /** Retained archived children remain discoverable after leaving the bounded live workflow list. */
  archivedDelegationCount?: number;
  /** Routing rules the user wrote and confirmed for this conversation; strict rules are enforced by the app. */
  routing?: ConversationRoutingData;
  /** Absent inherits the project profile; null explicitly uses normal global/conversation rules. */
  routingProfileId?: string | null;
  routingHistory?: Array<ConversationRouting | null>;
  /** Names of the installed skills this conversation may use; absent means every enabled skill. */
  skills?: string[];
  /** Skills to assess on each turn in this conversation; other enabled skills remain callable. */
  appliedSkills?: string[];
  deletedAt?: string;
  archivedAt?: string;
  deletedByUser?: boolean;
  /** Only conversations hidden by project removal are restored with it. */
  removedWithProject?: string;
  pinnedAt?: string;
  defaultExternalAgentId?: import('./external-agents.ts').ExternalAgentId;
  /** Messages tracked inside this conversation; separate from the sidebar conversation pin. */
  pinnedMessages?: ConversationMessagePin[];
  /** Advances only when the tracked message list or follow-up markers actually change. */
  pinnedMessagesRevision?: number;
  /** Only ordinary chats can belong to a category; this never changes their filesystem project. */
  folderId?: string;
  /** Explicitly selected external accounts. Omitted means no connector access. */
  connectorIds?: string[];
  approvalRules?: ApprovalRule[];
  connectorRevision?: string;
  /** Other people's words entered this conversation once; every later task in it runs tool-less. */
  untrustedContent?: boolean;
  id: string;
  projectId: string;
  title: string;
  /** Explicit manual rename; missing titles retain conservative automatic-title detection. */
  titleSource?: 'user';
  createdAt: string;
  updatedAt: string;
};
export type ConversationMessage = {
  /** A continuation marker; content contains only the user's new words. */
  resumed?: true;
  webSearch?: {
    query: string;
    /** The bounded, context-resolved query actually sent to Search. */
    searchQuery?: string;
    status: 'running' | 'completed' | 'failed';
    replyId?: string;
    requestId?: string;
    durationMs?: number;
    estimatedCostCny?: number;
    results?: import('./web-search.ts').WebSearchResult[];
    answer?: {
      status: 'starting' | 'started' | 'failed' | 'unavailable';
      workflowId?: string;
      error?: string;
    };
  };
  /** PugPort wording is translated by the UI; executor details stay as written. */
  systemNotice?: import('./system-notices.ts').SystemNotice;
  /** Immutable reply provenance, captured before later runs or routing changes can replace it. */
  replyIdentity?: ReplyExecutionIdentity;
  /** UI correlation only; never a task deduplication key. */
  clientMessageId?: string;
  steering?: {
    runId: string;
    status: 'pending' | 'accepted' | 'failed';
    /** Native acknowledgement time; distinct from when a queued user message was composed. */
    acceptedAt?: string;
    error?: string;
  };
  importedFrom?:
    | {
        provider: 'grok';
        sessionId: string;
        line: number;
        timestampKind: string;
        sourceKey?: string;
        contentHash?: string;
        occurrence?: number;
      }
    | { provider: 'cursor'; composerId: string }
    | {
        provider: 'claude';
        source: 'claude' | 'claude-code';
        fingerprint: string;
        conversationId: string;
        messageId?: string;
        timestampKind: 'source' | 'imported';
        sourceCreatedAt?: string;
        sourceIndex?: number;
      };
  attachments?: Attachment[];
  /** Attachments on this reply that an executor generated, and which executor and model made each. */
  generatedImages?: import('./image-generation.ts').MessageGeneratedImage[];
  /** Quoted passages shown as capsules on the user's message; `content` holds only what they typed. */
  quotes?: import('./quotes.ts').MessageQuote[];
  /** A reply from an agent outside PugPort (a web agent) the user called with @@. */
  externalAgent?: import('./external-agents.ts').ExternalAgentMessage;
  /** The user's message that called such an agent; with a web agent it is left out of executors' context too. */
  externalRequest?: { agentId: import('./external-agents.ts').ExternalAgentId; thirdParty?: boolean };
  /** An answer written without tools after reading third-party text; kept out of executors' context. */
  untrustedContent?: boolean;
  /**
   * The final answer of a message that called web agents, written with no tools from their replies (these names) and
   * the other results: it carries third-party words, so executors never get it as context, as with the replies.
   */
  combinedFrom?: string[];
  /** The coordinator's own answer, which the combined answer (this id) replaced in the conversation. */
  replacedBy?: string;
  /** A reply that came from one of the owner's device nodes: which one, and which of its executors answered. */
  device?: { id: string; name: string; executor?: string; model?: string };
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  workflowId?: string;
};
export type ReplyExecutionIdentity = {
  automatic: boolean;
  kind: 'model' | 'system';
  runs: Array<{
    runId: string;
    runtimeId: string;
    accountLabel?: string;
    model: string;
    effort?: string;
    /** True only when the runtime reported its effective settings, otherwise these are launch settings. */
    confirmed: boolean;
  }>;
};
export type AutoNoteItem = {
  section: 'facts' | 'decisions' | 'pitfalls';
  text: string;
  status: 'verified' | 'inferred';
  source: string;
  at: string;
};
/** Machine-authored memory is stored independently of the owner's hand-written memory. */
export type ProjectMemoryAuto = {
  projectId: string;
  content: string;
  items?: AutoNoteItem[];
  updatedAt: string;
  sourceRuntimeId: string;
  runId: string;
};
export type MemoryAutoView = { note?: ProjectMemoryAuto; sourceLabel?: string; eligible: boolean; reason?: string };
export type ProjectMemory = { projectId: string; content: string; revision: number; updatedAt: string };
export type MessageInput = {
  /** Host-owned routing advice; never accepted by public message schemas. */
  routeDecision?: import('./laya-route-decision.ts').LayaRouteDecision;
  /** Host-derived restriction; public message schemas do not grant or widen this field. */
  prohibitCommands?: boolean;
  /** Host-only trigger provenance; never accepted by the public message schema. */
  backgroundTrigger?: { kind: 'schedule' | 'peer' | 'lane-answer'; id: string };
  childWorkspaceMode?: 'snapshot' | 'branch';
  /** Trusted internal search follow-up; never accepted from the public message schema. */
  searchAlreadyPerformed?: boolean;
  /** Server-set: this turn uses a scratch directory while the original project folder is unavailable. */
  folderMissing?: boolean;
  /** Task approval override; device-origin tasks use auto, absent inherits the global setting. */
  toolApprovalMode?: 'auto' | 'ask';
  freeChain?: boolean;
  automaticExecutors?: string[];
  /** Trusted internal selection provenance, retained through child tasks and continuations. */
  automaticExecutorSelection?: boolean;
  uiLocale?: import('./i18n/index.ts').Locale;
  /** Explicit reply language, retained across permission corrections and native continuations. */
  replyLanguageOverride?: string;
  /** The phrase that narrowed this request to read-only, computed by PugPort. */
  readOnlyTrigger?: string;
  /** Message restrictions passed to the executor without changing file permission. */
  scopeNote?: string;
  permissionOrigin?: import('./permission-reason.ts').PermissionOrigin;
  /** Explicit composer/API/build grant; false preserves automatic-mode provenance after resolution. */
  explicitWrite?: boolean;
  /** Structured write-task contract from dispatch/routines, separate from permission to write. */
  expectsFileChanges?: boolean;
  /** Set only by a new user permission choice, never by the saved/default composer state. */
  permissionReauthorized?: boolean;
  swarm?: boolean;
  /**
   * Several participants the user called with @@ in this one message (resolved by the server): the task is a
   * coordinated one, whose coordinator hands each of them the part the user's words give it.
   */
  participants?: import('./participants.ts').Participant[];
  /** Runs on another owner computer; deviceFolder is resolved there, never as a local project path. */
  deviceId?: string;
  deviceFolder?: string;
  /** Local files queued for streaming to the chosen device before dispatch. */
  deviceFiles?: string[];
  /** Set false only for a caller that explicitly requires its selected executor without technical failover. */
  allowExecutorFallback?: boolean;
  agentPresetId?: string;
  /** Conversation work mode at enqueue (server-set, never from the message schema); immutable for the task. */
  workMode?: import('./work-modes.ts').WorkMode;
  /** runtimeId came from the chat's saved Navigator route (server-set): a preference that never blocks. */
  runtimeIdFromMode?: boolean;
  /** Preserves the optimistic message's identity through server broadcasts. */
  clientMessageId?: string;
  /** Passages quoted from the conversation, each with the user's note; sent to executors as numbered references. */
  quotes?: import('./quotes.ts').MessageQuote[];
  /**
   * The user's own words when content also carries quoted material (their message and the notes on each
   * quote): what intent and permission are judged on, so a quote's wording never decides what may be done.
   */
  intentText?: string;
  /** Review mode: another executor checks the finished result and the work is redone or escalated if needed. */
  review?: boolean;
  /** Explicitly send an independent task behind the running task. */
  queue?: boolean;
  attachmentIds?: string[];
  provider?: Provider;
  excludeProviders?: Provider[];
  content: string;
  mode: 'auto' | 'chat' | 'build';
  planFirst?: boolean;
  permissionMode: 'read-only' | 'workspace-write';
  /**
   * The content includes words written by people other than the user (a Slack thread, a pasted email). Such a
   * task runs tool-less: no file, search, shell, web, MCP or extension tools and none of PugPort's local context,
   * so those words cannot steer an executor into reading this computer. Implies read-only.
   */
  untrustedContent?: boolean;
  /**
   * Those words are only in quoted passages (a web agent's reply), which later messages never see (they keep the
   * typed text alone): this task runs tool-less, while the conversation keeps its tools.
   */
  untrustedQuotesOnly?: boolean;
  executionPolicy: ExecutionPolicy;
  allowUnknownQuota?: boolean;
  runtimeId?: string;
  model?: string;
  effort?: string;
  /** Host-only effort target for automatic selection, never a pin; public message schemas drop it. */
  suggestedEffort?: string;
  autoEscalate?: boolean;
  verificationCommand?: string;
  schedule?: TaskSchedule;
};
export type WorkflowStep = {
  id: string;
  title: string;
  instruction: string;
  writes?: boolean;
  kind: TaskKind;
  transport: 'auto' | 'cli' | 'api';
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  runIds: string[];
  acceptance?: string;
};
export type Delegation = {
  parentId: string;
  role: 'scout' | 'worker' | 'reviewer';
  requestId: string;
  /** Stable batch name and host-resolved dependency workflow IDs. */
  taskId?: string;
  dependsOn?: string[];
  batchId?: string;
  acceptance?: { criteria?: string; command?: string };
  dependencyBlock?: {
    code: 'dependency-failed' | 'dependency-unverified' | 'parent-closed' | 'dependency-missing';
    reason: string;
    dependencyId?: string;
    recoveryCondition: string;
    at: string;
  };
  /** Reviewer only: the provider that produced the parent result, and whether another one was available. */
  crossCheck?: { of: Provider; sameProvider?: boolean };
  /** An automatic review of the parent's result (review mode); its verdict is acted on, not just shown. */
  review?: { round: number; factCheck?: boolean };
  /** Requested by a running executor through the agent bridge, for the card named here (none: PugPort chooses). */
  agent?: {
    label: string;
    provider?: Provider;
    runtimeId?: string;
    deviceId?: string;
    /** A role (agent preset) the sub-task works in; routing still picks the executor unless one is named too. */
    presetId?: string;
    /** An agent outside PugPort the user called with @@ (a web agent) answers this part itself. */
    externalAgentId?: import('./external-agents.ts').ExternalAgentId;
    caller?: string;
  };
  /** The calling executor's suggested effort: a target for automatic selection, never a pin. */
  suggestedEffort?: string;
  /** The calling executor's suggested model tier: a target for automatic selection, never a pin. */
  suggestedTier?: 'light' | 'standard' | 'strong';
  /** The item of the caller's task list this sub-task works on. */
  planItem?: string;
  /** A writing subtask's declared files and folders (project-relative); overlapping subtasks take turns. */
  scope?: string[];
  /** Files changed while it ran that lie outside its scope (and outside any other running subtask's). */
  outOfScope?: string[];
  /** Progress the subtask reported (latest last): what is done, what comes next, what it is stuck on. */
  checkpoints?: Array<{ at: string; progress: string; next?: string; blocker?: string }>;
};
export type RemoteProgress = {
  lastActivityAt?: string;
  toolCalls?: number;
  toolCallsAtLeast?: boolean;
  step?: { kind: 'tool' | 'writing' | 'approval'; tool?: string; status?: string };
  planStep?: { index: number; total: number };
};

export type Workflow = {
  /** Server-owned difficulty context from the preceding task; never executor instructions or a permission grant. */
  priorTaskRouting?: { prompt: string; briefUnreadable: boolean };
  executionMemoryDirectory?: string;
  /** Host-owned execution binding; projectId continues to own routing, permissions and connectors. */
  executionWorkspaceId?: string;
  executionWorkspace?: import('./managed-worktrees.ts').ManagedWorktree;
  /** Read-only helpers use their parent's checkout without owning its delivery. */
  inheritedExecutionWorkspace?: boolean;
  executionWorkspaceMode?: 'isolated' | 'inherited' | 'shared';
  deliveryPendingReason?: string;
  /** A receipt for a previous logical-task attempt does not deliver later continuation edits. */
  executionDeliveryWorkflowId?: string;
  /** Host-classified blocked recovery; changing these conditions does not grant permissions. */
  recovery?: { failureCode: string; reason: string; recoveryCondition: string; conditionKey: string; at: string };
  modeSnapshot?: import('./conversation-modes.ts').WorkflowModeSnapshot;
  remoteProgress?: RemoteProgress;
  /** Retained until the device confirms the outcome; retries recover this same task. */
  deviceTask?: {
    requestId?: string;
    requestStartedAt?: number;
    taskId?: string;
    task?: string;
    repo?: { top: string; snapshot: string; head: string; trip: string; projectPath: string };
    writeAttempted?: boolean;
    uncertain?: boolean;
    stopRequested?: boolean;
  };
  /** Composer admission policy, consumed on first run. pending/once/cancelled are legacy saved values. */
  machineLoadChoice?: 'ask' | 'pending' | 'wait' | 'once' | 'cancelled';
  /** Bounded pressure/admission transitions; measurements never grant permission by themselves. */
  machineLoadObservations?: import('./machine-load.ts').MachineLoadObservation[];
  /** Persisted so retries and later steps emit only one fallback notice. */
  freeFallbackNotice?: boolean;
  modelFallbackNotice?: boolean;
  /** Snapshot inherited by sub-tasks; reviewers also inherit the parent's category. */
  routingContext?: Pick<RunInput, 'routingRules' | 'category'> & {
    profile?: { id: string; name: string; updatedAt: string };
  };
  continuation?: { originalRequest: string; supplements: string[] };
  selectionSwitch?: {
    state: 'switching' | 'continued' | 'blocked';
    runtimeLabel: string;
    requestedAt: string;
    selection: Pick<MessageInput, 'runtimeId' | 'provider' | 'model' | 'effort'>;
    fromRunId?: string;
  };
  /** Immutable selection at enqueue; later role edits/deletes do not alter this task. */
  agentPreset?: import('./agent-presets.ts').AgentPreset;
  /**
   * Set when the executor ended its turn unfinished only because a local background job is still running; the
   * task continues by itself when that job finishes. Nothing failed, so this is shown as waiting, not an error.
   */
  waitingOn?: { kind: 'media-analysis'; jobId: string; done: number; total: number };
  /**
   * A message that called web agents: the coordinator's own answer, which their replies are combined with in a last
   * tool-less step. Kept so that a reply arriving after the round can still be combined, once.
   */
  webCombine?: { answerId: string };
  /**
   * A part given to an agent outside PugPort whose reply arrived after the part had settled unanswered (the Grok Bot
   * routine stops waiting after 30 minutes). Recorded once, so a repeated callback never takes the part up again.
   */
  lateReply?: { messageId: string; at: string; state: 'pending' | 'combined' | 'not-combined' };
  /** Review mode: what the automatic reviewer of this result decided, and what was done about it. */
  review?: {
    round: number;
    factCheck?: FactCheckReport;
    /** queued: reviewed once it finishes (an automatic fix carries its round here). */
    status: 'queued' | 'reviewing' | 'passed' | 'fixing' | 'stopped';
    /** The reviewer's check of each claim, and of each project rule against the change. */
    claims?: Array<{ claim: string; status: 'verified' | 'unverified' | 'false'; note?: string }>;
    rules?: Array<{ rule: string; ok: boolean; note?: string }>;
    /** The reviewer's graded notes; only must and should go back to the executor. */
    findings?: Array<{ severity: 'must' | 'should' | 'nit'; text: string }>;
    verdict?: 'pass' | 'redo' | 'stronger';
    reason?: string;
    reviewerId?: string;
    successorId?: string;
  };
  /** The user stopped this task while it was running; unlike an abandoned task it can be resumed. */
  stopped?: boolean;
  userCancelled?: boolean;
  /** User-controlled order within one conversation's waiting messages. */
  queueOrder?: number;
  /** A text correction sent before this exact native input channel was ready. */
  pendingSteer?: { workflowId: string; runId: string };
  /** Removing a task card preserves its messages, native runs and audit history. */
  deletedAt?: string;
  /** Hides only the stopped attention row; preserves task state and continuation. */
  attentionDismissedAt?: string;
  /** A later top-level workflow hides stopped attention without removing continuation. */
  supersededAt?: string;
  /** Hides a settled child from normal lists without changing completion, delivery or family budgets. */
  archivedAt?: string;
  archivedBy?: 'auto' | 'user';
  /** A later user message or explicit continuation has taken over the conversation. */
  followUp?: { workflowId: string; kind: 'message' | 'continue'; at: string };
  memoryRetrieval?: {
    evidence?: MemoryEvidenceReport;
    status: 'found' | 'empty' | 'error';
    excerpts: number;
    verifiedPaths: string[];
    elapsedMs: number;
    error?: string;
  };
  delegation?: Delegation;
  /** A swarm coordinator's task list (set_plan); item states come from the members linked to each item. */
  taskList?: import('./swarm.ts').TaskList;
  /** ask_user: shown under the reply until the user's next message answers it. */
  userQuestion?: {
    text: string;
    options: string[];
    askedAt: string;
    relay?: { conversationId: string; title: string };
    answeredMessageId?: string;
  };
  taskJudgment?: TaskJudgment;
  /** Explicit inputs and continuations retain rule-based handling. */
  rulesOnlyHandling?: boolean;
  handlingSource?: 'laya' | 'rules';
  originalIntent?: Pick<MessageInput, 'mode' | 'permissionMode' | 'verificationCommand'>;
  /** Local-model advice is separate from permission grants and historical cloud judgments. */
  laya?: {
    inference: Omit<import('./laya.ts').LayaInference, 'raw'>;
    policy: import('./laya.ts').LayaPolicy;
    assessment?: import('./laya.ts').LayaRouteAssessment;
  };
  layaReviewIds?: string[];
  /**
   * The executor, model and effort the user picked themselves, before conversation routing rules filled them in.
   * Turning a queued message into an interjection compares these, not what the rules chose for a new task.
   */
  ownSelection?: Pick<MessageInput, 'provider' | 'runtimeId' | 'model' | 'effort'>;
  /** Display provenance only; an automatic task stays automatic when continuation pins its native session. */
  replyRouting?: 'auto' | 'manual';
  id: string;
  conversationId: string;
  projectId: string;
  userMessageId: string;
  /** A resend keeps this attempt and its runs, but shows the replacement in the timeline. */
  supersededBy?: string;
  /** Resend order for this user message; legacy workflows are the first attempt. */
  attempt?: number;
  input: MessageInput;
  requiresConfirmation?: boolean;
  routingReview?: {
    id: string;
    status: 'pending' | 'approved';
    proposal: RouteDecision;
    proposedAt: string;
    approvedAt?: string;
    original: { runtimeId?: string; model?: string; effort?: string };
  };
  status:
    | 'queued'
    | 'waiting-resource'
    | 'waiting-confirmation'
    | 'planning'
    | 'running'
    | 'waiting-approval'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  phase: 'queue' | 'plan' | 'route' | 'execute' | 'verify' | 'summarize';
  plan: WorkflowStep[];
  planReview?: 'pending' | 'approved';
  planning?: { strategy: 'direct' | 'native' | 'model' | 'resume'; reason: string };
  activeStepId?: string;
  runIds: string[];
  /** Auxiliary runs remain in runIds for diagnostics but use their own bounded budget. */
  visualRunIds?: string[];
  /** Valid only for the same immutable image ids and the current user-authored objective. */
  visualAnalysis?: { key: string; runId: string; report: string; sourceAttachments: string[]; by?: string };
  finalMessageId?: string;
  /** Completed answer with a non-blocking file note; the user may explicitly continue. */
  fileChangeNotice?: boolean;
  /** Check commands whose last run failed although the executor reported completion. */
  failedChecks?: string[];
  error?: string;
  memoryRevision: number;
  memoryExcerpt: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  /**
   * Git state PugPort measured when this task started: HEAD and the uncommitted files with their modification
   * times. The handoff note compares against it (server/handoff-note.ts); a continued task keeps its parent's.
   */
  handoffBase?: { at: string; head?: string; dirty?: Record<string, number>; dirtyTruncated?: boolean };
  parentWorkflowId?: string;
  scheduling?: {
    reason: string;
    nextAttemptAt?: string;
    deadlineRisk?: boolean;
    estimatedMinutes: number;
    lastEvaluatedAt: string;
  };
};

export type Attachment = { id: string; name: string; mimeType: string; size: number; kind: 'image' | 'file' };
export type RunAttachment = Attachment & {
  path: string;
  text?: string;
  width?: number;
  height?: number;
  fitted?: { path: string; mimeType: string; size: number; width?: number; height?: number };
};
