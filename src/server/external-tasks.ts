import { isApiHarness, providerSpec } from '../shared/provider-registry.ts';
import { messageAuthor } from './message-author.ts';
import type { Express, Request, Response } from 'express';
import { verificationLimitedChecks } from '../shared/verification-limited.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { refuseUnknownCaller, type CallerKind } from './caller-identity.ts';
import { mentionItems } from '../cli/mentions.ts';
import { messageRouting } from '../cli/routing.ts';
import { externalAgentCatalog, isExternalAgentId, isThirdPartyExchange } from '../shared/external-agents.ts';
import { calledFields, freeChainMentionId, namedIn } from '../shared/participants.ts';
import type {
  Approval,
  Conversation,
  ConversationMessage,
  MessageInput,
  Project,
  RunRecord,
  RuntimeTarget,
  RemoteProgress,
  Workflow,
} from '../shared/types.ts';
import { safeToolEventText, safeToolName } from '../shared/tool-event-data.ts';
import { toolCallOrdinals } from '../shared/tool-call-ordinals.ts';
import { stripHistoryMarkers } from './run-detail.ts';
import { taskExecutors } from './executor-checklist.ts';
import { automaticExecutorAllowed, executorCards } from '../shared/automatic-executors.ts';
import { agentModelLine } from '../shared/agent-models.ts';
import { resolveAgent, type NamedAgent } from './agent-names.ts';
import { noToollessExecutor } from './routing.ts';
import type { SlackTaskRunner } from './slack-gateway.ts';
import type { Workspace } from './workspace.ts';
import { callerWrite, inheritedCeiling, narrowCeiling } from './caller-ceiling.ts';
import { noteCollected, settled, type ExternalConversation } from './dispatch-conversations.ts';
import type { CallerContext } from '../shared/caller-signals.ts';
import { sendFileLine, validateFiles } from './node/peer-files.ts';
import { peerTaskProgressSchema } from './node/peer-protocol.ts';
import { routingProfileIdSchema } from '../shared/routing-profiles.ts';
import { ConversationActions } from './conversation-actions.ts';
import { failureNotice } from '../shared/system-notices.ts';
import { saveMemberResult, summaryLimit } from './member-results.ts';

const maxResultWaitSeconds = 50;
/** Which external caller opened a conversation; a record of its own, so conversations need no new field. */
const ownerKind = 'external-conversation';
/** What one message may add to a read_conversation answer; longer ones are cut. */
const maxMessageChars = 4000;
const snippet = (text: string, length = 120) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

/** A bounded view of live public activity, without loading audit history or exposing tool payloads. */
function taskProgress(
  workflow: Workflow,
  run: RunRecord | undefined,
  targets: readonly RuntimeTarget[],
  approvals: Iterable<{ value: Approval }>,
  includeOutput = false,
):
  | (RemoteProgress & {
      recentOutput?: string;
      relayedFrom?: { label: string; reason: string };
      outcome?: { status: string; summary?: string };
    })
  | undefined {
  const done = settled.has(workflow.status);
  if (!run) return !done ? peerTaskProgressSchema.safeParse(workflow.remoteProgress).data : undefined;
  let step: { kind: 'tool' | 'writing' | 'approval'; tool?: string; status?: string } | undefined;
  if (!done && run.status === 'waiting-approval') {
    const approval = [...approvals].find(({ value }) => value.runId === run.id)?.value;
    // Only Claude Code and Codex store a real tool name; ACP executors (Gemini, Cursor, Pi) store the request title,
    // which can be a bare command or path.
    const provider = targets.find((target) => target.id === run.route.runtimeId)?.provider ?? run.account?.provider;
    step = {
      kind: 'approval',
      tool: provider === 'claude' || provider === 'codex' ? safeToolName(approval) : undefined,
    };
  } else if (!done && run.status === 'running') {
    const event = [...run.events].reverse().find((event) => event.type === 'tool' || event.type === 'text');
    if (event?.type === 'tool')
      step = {
        kind: 'tool',
        tool: safeToolName(event.data),
        ...(typeof event.data?.status === 'string' ? { status: snippet(event.data.status, 30).slice(0, 30) } : {}),
      };
    else if (event) step = { kind: 'writing' };
  }
  const index = workflow.activeStepId ? workflow.plan.findIndex((step) => step.id === workflow.activeStepId) : -1;
  // Redact the whole stored output (at most runOutputLimit characters) before cutting: some rules hide a span from
  // its opening tag (<thinking>, a private key), and a cut that drops the tag would expose the rest of the span.
  const recentOutput = includeOutput && step ? stripHistoryMarkers(safeToolEventText(run.output)).slice(-300) : '';
  return {
    lastActivityAt: snippet(run.events.at(-1)?.at ?? run.startedAt),
    toolCalls: toolCallOrdinals(run.events).size,
    ...(run.eventsDropped && run.eventsDropped > 0 ? { toolCallsAtLeast: true } : {}),
    ...(step ? { step } : {}),
    ...(index >= 0 ? { planStep: { index: index + 1, total: workflow.plan.length } } : {}),
    ...(run.relay
      ? {
          relayedFrom: {
            label: snippet(
              targets.find((target) => target.id === run.relay!.fromRuntimeId)?.label ?? run.relay.fromRuntimeId,
            ),
            reason: snippet(run.relay.reason),
          },
        }
      : {}),
    ...(recentOutput ? { recentOutput } : {}),
    ...(done && run.taskOutcome
      ? {
          outcome: {
            status: snippet(run.taskOutcome.status),
            ...(run.taskOutcome.summary
              ? { summary: snippet(safeToolEventText(run.taskOutcome.summary), 300).slice(0, 300) }
              : {}),
          },
        }
      : {}),
  };
}

const modelFields = {
  model: z.string().trim().min(1).max(300).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
};
const executorNames = z.array(z.string().trim().min(1).max(100)).max(200).optional();
export const callerContextSchema = z
  .object({
    client: z.enum(['claude', 'codex', 'gemini', 'grok', 'cursor', 'unknown', 'terminal']),
    version: z.string().max(100).optional(),
    mode: z.enum(['write', 'read-only', 'write-anywhere', 'unknown']),
    network: z.boolean().optional(),
    roots: z.array(z.string().min(1).max(4000)).max(100),
    cwd: z.string().min(1).max(4000).optional(),
    evidence: z.array(z.string().max(100)).max(32),
    verified: z.boolean(),
  })
  .strict();
export const followSchema = z
  .object({
    message: z.string().trim().min(1).max(50000),
    ...modelFields,
    write: z.boolean().optional(),
    callerContext: callerContextSchema.optional(),
    executors: executorNames,
    exclude: executorNames,
  })
  .strict();
/** What typing a message in a conversation does in the app (main.ts): external agents, devices, then the router. */
export type TypedSend = (conversationId: string, body: unknown) => Promise<unknown>;
type Sent = {
  message?: ConversationMessage;
  reply?: ConversationMessage;
  workflow?: Workflow;
  steered?: boolean;
  notice?: string;
};

export const dispatchSchema = z
  .object({
    task: z.string().trim().min(1).max(50000),
    projectPath: z.string().trim().min(1).max(4000).optional(),
    routingProfileId: routingProfileIdSchema.optional(),
    executors: executorNames,
    exclude: executorNames,
    agent: z.string().trim().min(1).max(100).optional(),
    ...modelFields,
    device: z.string().trim().min(1).max(24).optional(),
    files: z.array(z.string().min(1).max(4000)).max(16).optional(),
    write: z.boolean().optional(),
    /** The task quotes words written by other people (a chat, an email): answer from the text only, no tools. */
    untrusted: z.boolean().optional(),
    caller: z.string().trim().min(1).max(60).optional(),
    callerContext: callerContextSchema.optional(),
    /**
     * A task from a paired PugPort, run with the owner's own trust; a device node on this computer forwards these.
     * Self-declared like everything here: any local process can read the session token and set it.
     */
    source: z.literal('device').optional(),
  })
  .strict();
/** In-process only: whether the HTTP caller descends from this backend or one of its executors, when that is known. */
type FromExecutor = { fromExecutor?: () => Promise<CallerKind> };
const slackOwner = Symbol('host-verified-slack-owner');
type DispatchInput = z.infer<typeof dispatchSchema> & {
  [slackOwner]?: true;
  ownerVisible?: true;
  title?: string;
  readOnly?: boolean;
  conversationId?: string;
  /**
   * In-process only (the maintainer's pinned judge): exactly this card and model. The run is never moved to another
   * executor, relayed or escalated; when routing cannot place it there, it fails instead.
   */
  pin?: { runtimeId: string; model: string };
} & FromExecutor;
/** A writable task asked for by one of PugPort's own executors; the route answers 403. */
export class ExecutorRefused extends Error {}
/** A writable task whose caller could not be identified; the route answers 503 and the caller may try again. */
export class CallerUnknown extends Error {}
/** Asked only once write is known, so read-only tasks never run the process lookup. */
async function writeCaller(input: FromExecutor) {
  const caller = await input.fromExecutor?.();
  if (caller === 'executor') throw new ExecutorRefused();
  if (caller === 'unknown') throw new CallerUnknown();
}

/**
 * Tasks handed in by AI agents outside PugPort (Claude Code, Codex …) through the pugport MCP server. Each task
 * is a new conversation the user can watch; PugPort routes it by quota like anything typed in the app.
 */
export class ExternalTasks {
  private waiters = new Set<() => void>();
  private readonly onState = () => {
    for (const check of [...this.waiters]) check();
  };
  constructor(private readonly workspace: Workspace) {}

  /**
   * In-process callers (the Slack gateway) may also name the conversation, force read-only, and continue a general
   * conversation they started earlier; the HTTP route keeps its narrower schema.
   */
  async dispatchSlack(input: Parameters<SlackTaskRunner['dispatch']>[0]) {
    const previous = input.conversationId ? this.ownConversation(input.conversationId, input.caller) : undefined;
    if (previous && this.untrusted(previous)) input = { ...input, untrusted: true, readOnly: true };
    const writable = input.owner === true && !input.readOnly && !input.untrusted;
    return this.dispatch({
      ownerVisible: true,
      task: input.task,
      caller: input.caller,
      title: 'Slack · ' + input.title,
      readOnly: !writable,
      untrusted: input.untrusted,
      conversationId: input.conversationId,
      ...(writable
        ? {
            [slackOwner]: true as const,
            write: true,
            projectPath: this.workspace.controller.settings.defaultProjectPath,
          }
        : {}),
    });
  }
  /** Host-verified GitHub owner requests share the desktop write ceiling only in the matched local project. */
  async dispatchGithub(input: {
    task: string;
    caller: string;
    title: string;
    readOnly: boolean;
    owner: boolean;
    untrusted: boolean;
    projectPath?: string;
  }) {
    const writable = input.owner && !input.readOnly && !input.untrusted && !!input.projectPath;
    return this.dispatch({
      task: input.task,
      caller: input.caller,
      title: input.title,
      ownerVisible: true,
      readOnly: !writable,
      untrusted: input.untrusted,
      ...(writable ? { [slackOwner]: true as const, write: true, projectPath: input.projectPath } : {}),
    });
  }
  async dispatch(input: DispatchInput, send?: TypedSend) {
    if (input.pin) {
      if (
        input.agent !== undefined ||
        input.executors !== undefined ||
        input.exclude !== undefined ||
        input.model !== undefined ||
        input.effort !== undefined ||
        input.device !== undefined ||
        input.routingProfileId !== undefined
      )
        throw new Error('A pinned task names only its executor and model.');
      if (!executorCards(this.workspace.controller.targets).some((card) => card.id === input.pin!.runtimeId))
        throw new Error(`Pinned executor ${input.pin.runtimeId} is not available.`);
    }
    if (input.routingProfileId !== undefined) {
      routingProfileIdSchema.parse(input.routingProfileId);
      if (input.device) throw new Error('Device tasks cannot use a local routing profile.');
      if (!this.workspace.controller.settings.routingProfiles?.some((profile) => profile.id === input.routingProfileId))
        throw new Error('此路由方案已不可用，请选择自动或另一套路由方案。');
    }
    if (input.device && (input.model || input.effort)) throw new Error('Device tasks do not support model or effort.');
    // A device's task stays on this computer: never passed on to another device (no loops).
    if (input.device && input.source === 'device') throw new Error('A task from a device cannot go to another device.');
    let device: { id: string; name: string } | undefined;
    if (input.device) {
      if (input.agent !== undefined || input.executors !== undefined || input.exclude !== undefined)
        throw new Error('Device tasks choose their own executor; omit agent, executors and exclude.');
      if (!this.workspace.remote) throw new Error('This PugPort is a device node and has no device list.');
      device = this.workspace.remote.find(input.device);
      if (!device) throw new Error(`Unknown device: ${input.device}.`);
      await this.workspace.remote.ensureReachable(device.id);
      if (!send) throw new Error('Device dispatch needs the typed-message path.');
    }
    if (input.files?.length && !device) throw new Error('files requires a device.');
    const files = input.files?.length ? await validateFiles(input.files) : undefined;
    const deviceFolder = device ? input.projectPath : undefined;
    const untrusted = input.untrusted === true;
    if (untrusted && input.write === true && input.readOnly !== true)
      throw new Error('untrusted: true runs without any tools, so it cannot be combined with write: true.');
    // Other people's words live in a general conversation, outside the project's memory.
    if (untrusted) input = { ...input, projectPath: undefined };
    let conversation =
      (!input.projectPath || device || input[slackOwner]) && input.conversationId
        ? this.ownConversation(input.conversationId, input.caller)
        : undefined;
    if (
      conversation &&
      input[slackOwner] &&
      this.workspace.store.get<Project>('project', conversation.projectId)?.path !== input.projectPath
    )
      conversation = undefined;
    const owner = conversation ? this.workspace.store.get<ExternalConversation>(ownerKind, conversation.id) : undefined;
    // readOnly always wins: a caller that forwards other people's words must never get file writes.
    const context = input.callerContext;
    const override =
      context && context.client !== 'unknown' && context.client !== 'terminal' && context.client !== 'gemini'
        ? this.workspace.controller.settings.externalCallers?.[context.client]
        : undefined;
    const ceiling =
      input.readOnly === true
        ? {
            mode: 'read-only' as const,
            origin: {
              mode: 'read-only' as const,
              source: input.source === 'device' ? ('device' as const) : ('external' as const),
            },
            reason: '外部来源仅允许只读任务',
          }
        : input[slackOwner] && !untrusted
          ? narrowCeiling(
              {
                mode: 'workspace-write' as const,
                origin: { mode: 'workspace-write' as const, source: 'external' as const },
              },
              owner?.ceiling,
            )
          : input.source === 'device'
            ? {
                mode: 'workspace-write' as const,
                origin: { mode: 'workspace-write' as const, source: 'device' as const },
              }
            : narrowCeiling(
                inheritedCeiling(
                  context,
                  device ? undefined : input.projectPath,
                  override,
                  (path) => this.workspace.controller.isTrustedProjectPath?.(path) === true,
                ),
                owner?.ceiling,
              );
    const write =
      input.readOnly !== true &&
      !untrusted &&
      callerWrite(ceiling, input.write) &&
      (input.write === true || (!device && !!input.projectPath));
    if (write) await writeCaller(input);
    // Refused rather than quietly run read-only: the caller would otherwise believe files were changed.
    if (write && !device && !input.projectPath)
      throw new Error('write: true needs projectPath (the folder to change).');
    if (conversation && !owner?.ceiling)
      this.workspace.store.save(ownerKind, conversation.id, conversation.id, { ...owner, context, ceiling });
    // Resolved before anything is created, so an unknown name leaves no empty conversation behind.
    const agent = input.agent ? resolveAgent(input.agent, this.workspace.controller.targets) : undefined;
    const deviceWrite = input.source === 'device' && write;
    if (deviceWrite && agent && !providerSpec(agent.provider)?.runsCommands)
      throw new Error('Device write tasks require an executor that can run commands automatically.');
    const automaticExecutors = taskExecutors(
      deviceWrite
        ? {
            ...input,
            exclude: [
              ...(input.exclude ?? []),
              ...executorCards(this.workspace.controller.targets)
                .filter((card) => !providerSpec(card.provider)?.runsCommands)
                .map((card) => card.id),
            ],
          }
        : input,
      this.workspace.controller.targets,
      conversation?.routing?.automaticExecutors ??
        this.workspace.controller.targets
          .filter((target) => !this.workspace.controller.settings.excludedExecutors?.includes(target.id))
          .map((target) => target.id),
      !!agent,
    );
    const selection = this.modelSelection(
      input,
      agent,
      automaticExecutors ??
        conversation?.routing?.automaticExecutors ??
        this.workspace.controller.targets
          .filter((target) => !this.workspace.controller.settings.excludedExecutors?.includes(target.id))
          .map((target) => target.id),
    );
    if (!conversation) {
      const snippet = input.task.replace(/\s+/g, ' ');
      const title =
        input.title?.replace(/\s+/g, ' ').trim().slice(0, 150) ||
        `${input.caller ?? '外部 AI'} · ${snippet.length > 40 ? `${snippet.slice(0, 40)}…` : snippet}`;
      conversation =
        input.projectPath && !device
          ? this.workspace.createConversation(
              (await this.workspace.createProject(input.projectPath, undefined, false, { origin: 'dispatch' })).id,
              title,
            )
          : await this.workspace.createGeneralConversation(title);
      this.workspace.store.save(ownerKind, conversation.id, conversation.id, {
        ...(!input.ownerVisible ? { dispatched: true } : {}),
        caller: input.caller,
        context,
        ceiling,
        ...(device ? { deviceId: device.id, deviceFolder, write } : {}),
      });
    }
    if (input.routingProfileId !== undefined)
      conversation = new ConversationActions(this.workspace).setRoutingProfile(conversation.id, input.routingProfileId);
    const message: MessageInput = {
      content: input.task,
      ...(automaticExecutors ? { automaticExecutors } : {}),
      mode: write ? 'build' : 'chat',
      permissionMode: write ? 'workspace-write' : 'read-only',
      explicitWrite: write,
      expectsFileChanges: write,
      ...(input.source === 'device' ? { toolApprovalMode: 'auto' as const } : {}),
      permissionOrigin: { ...ceiling.origin, mode: write ? 'workspace-write' : 'read-only' },
      ...(untrusted ? { untrustedContent: true } : {}),
      // Subscriptions first, API keys only when no subscription can take it; no runtime pinned unless named.
      executionPolicy: 'cli-first',
      autoEscalate: true,
      allowExecutorFallback: true,
      ...selection,
      ...(agent ? (agent.runtimeId ? { runtimeId: agent.runtimeId } : { provider: agent.provider }) : {}),
      ...(input.pin
        ? {
            runtimeId: input.pin.runtimeId,
            model: input.pin.model,
            allowExecutorFallback: false,
            autoEscalate: false,
          }
        : {}),
    };
    // A busy conversation queues the message, exactly as when it is typed in the app.
    const { workflow } = device
      ? ((await send!(conversation.id, {
          ...message,
          deviceId: device.id,
          deviceFolder,
          ...(files?.length ? { deviceFiles: files.map((file) => file.path) } : {}),
        })) as Sent)
      : await this.workspace.send(conversation.id, message);
    if (!workflow) throw new Error('The message did not create a task.');
    return {
      taskId: workflow.id,
      conversationId: conversation.id,
      title: conversation.title,
      status: workflow.status,
      ...(input.routingProfileId ? { routingProfileId: input.routingProfileId } : {}),
      readOnlyTrigger: workflow.input.readOnlyTrigger,
      scopeNote: workflow.input.scopeNote,
      permissionOrigin: workflow.input.permissionOrigin,
    };
  }

  agents() {
    const controller = this.workspace.controller;
    const lines = controller.trayState().lines;
    return {
      agents: executorCards(controller.targets).map((card) => {
        const snapshot = controller.snapshots.find((item) => item.id === card.id);
        return {
          label: card.label,
          provider: card.provider,
          status: snapshot?.status,
          models: (snapshot?.models ?? []).map(({ id, label, efforts }) => ({ id, label, efforts })),
          quota: lines.find((line) => line.id === card.id),
        };
      }),
    };
  }

  private modelSelection(
    input: { model?: string; effort?: string },
    agent: Pick<NamedAgent, 'runtimeId' | 'provider'> | undefined,
    automaticExecutors: string[] | undefined,
  ): Partial<MessageInput> {
    if (input.effort && !input.model) throw new Error('effort requires model; see list_agents.');
    if (!input.model) return {};
    if (!agent && input.model.toLowerCase() === 'default')
      throw new Error('Model default requires agent; see list_agents.');
    const controller = this.workspace.controller;
    const cards = executorCards(controller.targets).filter(
      (card) =>
        (agent?.runtimeId ? card.id === agent.runtimeId : !agent?.provider || card.provider === agent.provider) &&
        (agent || (!card.gateway && !isApiHarness(card.provider))) &&
        automaticExecutorAllowed({ ...agent, automaticExecutors }, controller.settings, card.id),
    );
    const catalogs = cards.map((card) => ({
      card,
      models: controller.snapshots.find((snapshot) => snapshot.id === card.id)?.models ?? [],
    }));
    for (const { models } of catalogs) {
      const model = models.find((model) => model.id.toLowerCase() === input.model!.toLowerCase());
      const effort = model?.efforts.find((effort) => effort.toLowerCase() === input.effort?.toLowerCase());
      if (model && (!input.effort || effort))
        return {
          model: model.id,
          ...(effort ? { effort } : {}),
          allowExecutorFallback: false,
          ...(!agent ? { executionPolicy: 'cli-only' as const } : {}),
        };
    }
    // One card with an empty catalog must not hide the models the others offer.
    const unloaded = catalogs.every(({ models }) => !models.length) ? catalogs[0] : undefined;
    if (unloaded)
      throw new Error(`model list for ${unloaded.card.label} not loaded yet, try again shortly; see list_agents.`);
    const available = catalogs
      .flatMap(({ card, models }) => models.map((model) => agentModelLine(card, model)))
      .join('\n');
    throw new Error(
      `Unsupported model or effort. Available models:\n${available.slice(0, 2800)}\nsee list_agents for the full catalog.`,
    );
  }

  private ownConversation(id: string, caller?: string) {
    const conversation = this.workspace.store.get<Conversation>('conversation', id);
    const owner = this.workspace.store.get<{ caller: string }>(ownerKind, id);
    return caller && conversation && !conversation.incognito && !conversation.deletedAt && owner?.caller === caller
      ? conversation
      : undefined;
  }

  /** The task, or the continuation the user started in PugPort after it paused. */
  find(id: string): Workflow | undefined {
    let workflow = this.workspace.store.get<Workflow>('workflow', id);
    const conversation = workflow && this.workspace.store.get<Conversation>('conversation', workflow.conversationId);
    if (!workflow || workflow.deletedAt || conversation?.incognito || conversation?.deletedAt) return undefined;
    for (let hops = 0; workflow.followUp?.kind === 'continue' && hops < 20; hops++) {
      const next: Workflow | undefined = this.workspace.store.get<Workflow>('workflow', workflow.followUp.workflowId);
      if (!next || next.deletedAt || next.conversationId !== workflow.conversationId) break;
      workflow = next;
    }
    return workflow;
  }

  status(id: string) {
    const workflow = this.find(id);
    if (!workflow) return undefined;
    const run = this.lastRun(workflow);
    const progress = taskProgress(
      workflow,
      run,
      this.workspace.controller.targets,
      this.workspace.controller.approvals.values(),
      true,
    );
    return {
      ...this.describe(workflow, id, run),
      ...(progress ? { progress } : {}),
      ...(workflow.input.untrustedContent ? { otherPeople: true } : {}),
    };
  }

  /** The last non-visual run. `summary` reads the stored summary (no events, output tail only), enough for labels. */
  private lastRun(workflow: Workflow, summary = false) {
    const id = workflow.runIds.filter((id) => !workflow.visualRunIds?.includes(id)).at(-1);
    const controller = this.workspace.controller;
    return id
      ? (controller.active.get(id)?.run ??
          (summary ? controller.store.storedRunSummary(id) : controller.store.storedRun(id)))
      : undefined;
  }

  fullOutputs(taskId: string): string[] {
    const workflow = this.find(taskId);
    if (!workflow) return [];
    return workflow.runIds
      .filter((id) => !workflow.visualRunIds?.includes(id))
      .flatMap((id) => {
        const run = this.workspace.controller.runWithAudit(id);
        if (!run) return [];
        const text: string[] = [];
        for (const [index, event] of run.events.entries()) {
          if (event.type !== 'text' || typeof event.text !== 'string') continue;
          const previous = run.events[index - 1];
          const boundary = previous && (previous.type !== 'text' || previous.data?.itemId !== event.data?.itemId);
          text.push(text.length && boundary ? `\n${event.text}` : event.text);
        }
        return [text.length ? text.join('') : run.output];
      });
  }

  private executorLabel(run: RunRecord | undefined) {
    return run
      ? (this.workspace.controller.targets.find((target) => target.id === run.route.runtimeId)?.label ??
          run.account?.label ??
          run.route.runtimeId)
      : undefined;
  }

  private describe(
    workflow: Workflow,
    taskId = workflow.id,
    run = this.lastRun(workflow),
  ): {
    taskId: string;
    conversationId: string;
    status: Workflow['status'];
    phase: Workflow['phase'];
    planReview?: Workflow['planReview'];
    executor?: string;
    model?: string;
    startedAt?: string;
    endedAt?: string;
    error?: string;
    note?: string;
    readOnlyTrigger?: string;
    scopeNote?: string;
    permissionOrigin?: MessageInput['permissionOrigin'];
    verificationLimited?: boolean;
    limitedChecks?: ReturnType<typeof verificationLimitedChecks>;
  } {
    const done = settled.has(workflow.status);
    const limitedChecks = verificationLimitedChecks(
      workflow,
      workflow.runIds.flatMap((id) => {
        const run = this.workspace.controller.run(id);
        return run ? [run] : [];
      }),
    );
    return {
      taskId,
      conversationId: workflow.conversationId,
      status: workflow.status,
      phase: workflow.phase,
      planReview: workflow.planReview,
      readOnlyTrigger: workflow.input.readOnlyTrigger,
      scopeNote: workflow.input.scopeNote,
      permissionOrigin: workflow.input.permissionOrigin,
      ...(limitedChecks.length ? { verificationLimited: true, limitedChecks } : {}),
      executor: this.executorLabel(run),
      model: run ? (run.effectiveModel?.model ?? run.route.model) : undefined,
      startedAt: workflow.startedAt,
      endedAt: done ? (run?.endedAt ?? workflow.updatedAt) : undefined,
      ...(workflow.error
        ? { error: workflow.error }
        : !done && workflow.scheduling?.reason
          ? { note: workflow.scheduling.reason }
          : {}),
    };
  }

  async result(id: string, waitSeconds = 0, signal?: AbortSignal) {
    if (!this.find(id)) return undefined;
    await this.waitSettled(id, Math.min(maxResultWaitSeconds, Math.max(0, waitSeconds)) * 1000, signal);
    const workflow = this.find(id);
    if (!workflow) return undefined;
    const description = this.describe(workflow, id);
    const readOnly = {
      permissionOrigin: workflow.input.permissionOrigin,
      ...(description.verificationLimited
        ? {
            verificationLimited: true,
            limitedChecks: description.limitedChecks,
          }
        : {}),
      ...(workflow.input.readOnlyTrigger ? { readOnlyTrigger: workflow.input.readOnlyTrigger } : {}),
      ...(workflow.input.scopeNote ? { scopeNote: workflow.input.scopeNote } : {}),
    };
    if (!settled.has(workflow.status))
      return {
        status: workflow.status,
        ...(workflow.planReview ? { planReview: workflow.planReview } : {}),
        ...readOnly,
      };
    const final = workflow.finalMessageId
      ? this.workspace.store.get<ConversationMessage>('message', workflow.finalMessageId)
      : undefined;
    const text = final?.role === 'assistant' && final.conversationId === workflow.conversationId ? final.content : '';
    const resultPath =
      (workflow.status === 'completed' || !workflow.error) &&
      text.length > summaryLimit &&
      final &&
      !isThirdPartyExchange(final)
        ? saveMemberResult(this.workspace.controller.dataDir, workflow.conversationId, workflow.id, text)
        : undefined;
    const savedResult = resultPath ? { resultPath } : {};
    if (!signal?.aborted && noteCollected(this.workspace.store, workflow, new Date().toISOString()))
      this.workspace.archiveSettledDispatches([workflow.conversationId]);
    if (workflow.status === 'completed') return { status: workflow.status, result: text, ...savedResult, ...readOnly };
    const runs = workflow.runIds
      .map((runId) => this.workspace.controller.run(runId))
      .filter((run): run is RunRecord => !!run);
    const reason = failureNotice(workflow, runs).stop?.reason;
    const host = workflow.error ?? text;
    const error = reason && !host.includes(reason) ? [host, reason].filter(Boolean).join('\n') : host;
    return { status: workflow.status, error, ...savedResult, ...readOnly };
  }

  /** Stops the task (or the continuation it became); false when there is no such task. */
  cancel(id: string): boolean {
    const workflow = this.find(id);
    if (!workflow) return false;
    if (!settled.has(workflow.status)) this.workspace.cancel(workflow.id);
    return true;
  }

  private conversationOf(id: string, cache = new Map<string, Conversation | undefined>()) {
    if (!cache.has(id)) {
      const conversation = this.workspace.store.get<Conversation>('conversation', id);
      cache.set(id, conversation && !conversation.incognito && !conversation.deletedAt ? conversation : undefined);
    }
    return cache.get(id);
  }

  /** Other people's words entered it (a Slack thread, a pasted email): every task in it runs without tools. */
  private untrusted(conversation: Conversation) {
    const parent = conversation.sideChat?.parentConversationId;
    return (
      !!conversation.untrustedContent ||
      (!!parent && !!this.workspace.store.get<Conversation>('conversation', parent)?.untrustedContent)
    );
  }

  /** Running and waiting tasks first, then finished ones, newest first; sub-tasks are not listed on their own. */
  list(options: { limit?: number; activeOnly?: boolean; executor?: string } = {}) {
    const conversations = new Map<string, Conversation | undefined>();
    const executor = options.executor?.trim().toLowerCase();
    const workflows = this.workspace.store
      .visibleWorkflows()
      .filter(
        (workflow) =>
          !workflow.delegation &&
          (!options.activeOnly || !settled.has(workflow.status)) &&
          this.conversationOf(workflow.conversationId, conversations) &&
          // Last: the cheap checks above drop most tasks before any run is read, and only summaries are read.
          (executor === undefined ||
            this.executorLabel(this.lastRun(workflow, true))?.trim().toLowerCase() === executor),
      )
      // A stable sort keeps visibleWorkflows' newest-first order inside each group.
      .sort((a, b) => Number(settled.has(a.status)) - Number(settled.has(b.status)));
    return {
      total: workflows.length,
      tasks: workflows.slice(0, options.limit ?? 20).map((workflow) => {
        const run = this.lastRun(workflow);
        const progress = taskProgress(
          workflow,
          run,
          this.workspace.controller.targets,
          this.workspace.controller.approvals.values(),
        );
        return {
          ...this.describe(workflow, workflow.id, run),
          ...(progress ? { progress } : {}),
          conversation: conversations.get(workflow.conversationId)!.title,
          request: snippet(workflow.input.intentText ?? workflow.input.content),
          updatedAt: workflow.updatedAt,
          ...(workflow.input.untrustedContent ? { otherPeople: true } : {}),
        };
      }),
    };
  }

  /** Recent conversations (side chats stay with their conversation), optionally only titles containing `query`. */
  conversations(options: { limit?: number; query?: string } = {}) {
    const busy = new Map<string, number>();
    for (const workflow of this.workspace.store.visibleWorkflows())
      if (!settled.has(workflow.status) && !workflow.delegation)
        busy.set(workflow.conversationId, (busy.get(workflow.conversationId) ?? 0) + 1);
    const wanted = options.query?.trim().toLowerCase();
    const list = this.workspace.store
      .conversations()
      .filter(
        (conversation) =>
          !conversation.incognito &&
          (!conversation.archivedAt ||
            this.workspace.store.get<ExternalConversation>(ownerKind, conversation.id)?.dispatched) &&
          !conversation.sideChat &&
          (!wanted || conversation.title.toLowerCase().includes(wanted)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: list.length,
      conversations: list.slice(0, options.limit ?? 20).map((conversation) => {
        const project = this.workspace.store.get<Project>('project', conversation.projectId);
        return {
          conversationId: conversation.id,
          title: conversation.title,
          ...(project && project.scope !== 'chat' ? { project: project.path } : {}),
          lastActivity: conversation.updatedAt,
          activeTasks: busy.get(conversation.id) ?? 0,
          ...(conversation.pinnedAt ? { pinned: true } : {}),
          ...(this.untrusted(conversation) ? { otherPeople: true } : {}),
        };
      }),
    };
  }

  /**
   * The latest messages of a conversation, each with who wrote it. A web agent's reply is a third party's words
   * and a message that quoted a Slack thread or an email holds other people's words; both are marked as such.
   */
  read(id: string, limit = 20) {
    const conversation = this.conversationOf(id);
    if (!conversation) return undefined;
    const store = this.workspace.store;
    const project = store.get<Project>('project', conversation.projectId);
    const messages = store.allMessages(id);
    const workflows = new Map(store.conversationWorkflows(id).map((workflow) => [workflow.id, workflow]));
    const label = (runtimeId: string) =>
      this.workspace.controller.targets.find((target) => target.id === runtimeId)?.label;
    return {
      conversationId: id,
      title: conversation.title,
      ...(project && project.scope !== 'chat' ? { project: project.path } : {}),
      ...(this.untrusted(conversation) ? { otherPeople: true } : {}),
      total: messages.length,
      messages: messages.slice(-limit).map((message) => {
        const author = messageAuthor(message, label);
        const input = message.workflowId ? workflows.get(message.workflowId)?.input : undefined;
        const agentId = message.externalRequest?.agentId;
        return {
          messageId: message.id,
          role: message.role,
          author,
          at: message.createdAt,
          content:
            message.content.length > maxMessageChars
              ? `${message.content.slice(0, maxMessageChars)}…`
              : message.content,
          ...(message.content.length > maxMessageChars ? { truncated: true } : {}),
          ...(message.role === 'user' && message.workflowId ? { taskId: message.workflowId } : {}),
          ...(message.externalAgent?.untrusted ? { thirdParty: true } : {}),
          ...(message.role === 'user' && input?.untrustedContent && !input.untrustedQuotesOnly
            ? { otherPeople: true }
            : {}),
          ...(agentId && isExternalAgentId(agentId) ? { to: externalAgentCatalog[agentId].name } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments.map((file) => file.name) } : {}),
        };
      }),
    };
  }

  /**
   * A follow-up in an existing conversation, sent the way the terminal sends what the user types: PugPort's own
   * routing, `@名字` for a role or executor, and `@@名字` for an external agent or a device (resolved by `send`).
   * Inherits the stored caller ceiling; a conversation holding other people's words never gets write access.
   */
  async follow(
    conversationId: string,
    input: z.infer<typeof followSchema> & FromExecutor,
    send: TypedSend = (id, body) => this.workspace.send(id, body as MessageInput),
  ) {
    const conversation = this.conversationOf(conversationId);
    if (!conversation) return undefined;
    // Refused rather than quietly run without tools: the caller would otherwise believe files were changed.
    if (input.write && this.untrusted(conversation))
      throw new Error(
        'This conversation holds text written by other people, so PugPort answers in it without any tools; write: true is not possible here.',
      );
    const project = this.workspace.store.get<Project>('project', conversation.projectId);
    const owner = this.workspace.store.get<ExternalConversation>(ownerKind, conversationId);
    // Narrow each call against the original grant without changing it for later callers.
    const context = input.callerContext;
    const override =
      context && context.client !== 'unknown' && context.client !== 'terminal' && context.client !== 'gemini'
        ? this.workspace.controller.settings.externalCallers?.[context.client]
        : undefined;
    const controller = this.workspace.controller;
    // Everyone the message calls by name, as the desktop composer reads it: `@` roles and executors, `@@` devices
    // and outside agents.
    const servers = (this.workspace.remote?.directory() ?? []).filter((device) => device.tunnel);
    if (
      servers.some((device) => device.id === owner?.deviceId) ||
      namedIn(
        input.message,
        servers.map(({ id, name }) => ({ kind: 'device' as const, id, name, tier: 3 as const })),
      ).length
    )
      throw new Error('MCP follow cannot send messages to servers.');
    const called = namedIn(input.message, [
      ...mentionItems(controller.settings.agentPresets, controller.targets),
      ...Object.entries(externalAgentCatalog).map(([id, agent]) => ({
        kind: 'external' as const,
        id,
        name: agent.name,
      })),
      ...(this.workspace.remote?.directory() ?? [])
        .filter((device) => !device.tunnel)
        .map(({ id, name }) => ({ kind: 'device' as const, id, name })),
    ]);
    const mentionedDevice = called.some((item) => item.kind === 'device');
    const ceiling = narrowCeiling(
      inheritedCeiling(
        context,
        owner?.deviceId || mentionedDevice || project?.scope === 'chat' ? undefined : project?.path,
        override,
        (path) => this.workspace.controller.isTrustedProjectPath?.(path) === true,
      ),
      owner?.ceiling,
    );
    const chat = project?.scope === 'chat' && !owner?.deviceId && !mentionedDevice;
    if (chat && input.write === true) throw new Error('write: true needs projectPath (the folder to change).');
    const write =
      !chat &&
      !this.untrusted(conversation) &&
      callerWrite(ceiling, input.write ?? (owner?.deviceId ? owner.write : undefined));
    if (write) await writeCaller(input);
    // A device mention's narrower ceiling applies to that message only, not to the conversation's later local work.
    if (!owner?.ceiling && !mentionedDevice)
      this.workspace.store.save(ownerKind, conversationId, conversationId, { ...owner, context, ceiling });
    // A device's own conversation keeps going to that device, whoever the text names.
    const freeChain = !owner?.deviceId && called.some((item) => item.id === freeChainMentionId);
    const fields = owner?.deviceId || freeChain ? {} : calledFields(called);
    if (
      (input.model || input.effort) &&
      (owner?.deviceId || called.some((item) => item.kind === 'external' || item.kind === 'device'))
    )
      throw new Error('A message to a device or external agent cannot specify model or effort.');
    const automaticExecutors = taskExecutors(
      input,
      controller.targets,
      conversation.routing?.automaticExecutors ??
        controller.targets
          .filter((target) => !controller.settings.excludedExecutors?.includes(target.id))
          .map((target) => target.id),
      called.some((item) => item.kind === 'executor' && item.id !== freeChainMentionId),
    );
    const target = fields.runtimeId ? controller.targets.find((card) => card.id === fields.runtimeId) : undefined;
    const selection = this.modelSelection(
      input,
      target ? { runtimeId: target.id, provider: target.provider } : undefined,
      automaticExecutors ??
        conversation.routing?.automaticExecutors ??
        controller.targets
          .filter((target) => !controller.settings.excludedExecutors?.includes(target.id))
          .map((target) => target.id),
    );
    const sent = (await send(conversationId, {
      clientMessageId: randomUUID(),
      content: input.message,
      ...(automaticExecutors ? { automaticExecutors } : {}),
      ...messageRouting({ write }),
      ...fields,
      ...(freeChain ? { freeChain: true } : {}),
      ...(owner?.deviceId ? { deviceId: owner.deviceId, deviceFolder: owner.deviceFolder } : {}),
      ...selection,
      explicitWrite: write,
      expectsFileChanges: write,
      permissionOrigin: { ...ceiling.origin, mode: write ? 'workspace-write' : 'read-only' },
    })) as Sent;
    const workflow = sent.workflow;
    return {
      conversationId,
      ...(sent.message ? { messageId: sent.message.id } : {}),
      ...(workflow
        ? {
            taskId: workflow.id,
            status: workflow.status,
            // What PugPort decided, which can be narrower than what was asked (a device, a tool-less conversation).
            permission: workflow.input.untrustedContent ? 'no tools' : workflow.input.permissionMode,
            readOnlyTrigger: workflow.input.readOnlyTrigger,
            scopeNote: workflow.input.scopeNote,
            permissionOrigin: workflow.input.permissionOrigin,
          }
        : {}),
      ...(sent.steered ? { steered: true } : {}),
      ...(sent.notice ? { note: sent.notice, queued: true } : {}),
      ...(sent.reply?.externalAgent
        ? {
            handedTo: sent.reply.externalAgent.name,
            permissionOrigin: { mode: 'read-only' as const, source: 'external' as const },
          }
        : {}),
    };
  }

  /** Every workflow change is broadcast, so a waiting caller wakes on that instead of polling the store. */
  private waitSettled(id: string, ms: number, signal?: AbortSignal) {
    const finished = () => {
      const workflow = this.find(id);
      return !workflow || settled.has(workflow.status);
    };
    if (ms <= 0 || signal?.aborted || finished()) return Promise.resolve();
    const controller = this.workspace.controller;
    return new Promise<void>((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        clearInterval(fallback);
        signal?.removeEventListener('abort', finish);
        this.waiters.delete(check);
        if (!this.waiters.size) controller.off('state', this.onState);
        resolveWait();
      };
      const check = () => {
        if (finished()) finish();
      };
      const timer = setTimeout(finish, ms);
      // Only covers a change saved without a broadcast; the state event normally wakes the wait first.
      const fallback = setInterval(check, 5000);
      // One shared listener, however many callers wait.
      if (!this.waiters.size) controller.on('state', this.onState);
      this.waiters.add(check);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

/**
 * The Slack gateway's view of these tasks: always read-only, titled as coming from Slack, and with PugPort's own
 * statuses folded into the words Slack keeps waiting on. Anything else ends Slack's wait and is shown as the outcome.
 */
export function slackTaskRunner(tasks: ExternalTasks): SlackTaskRunner {
  return {
    async dispatch(input) {
      const created = await tasks.dispatchSlack(input);
      return { taskId: created.taskId, conversationId: created.conversationId };
    },
    async result(taskId, waitSeconds) {
      const outcome = await tasks.result(taskId, waitSeconds);
      if (!outcome) return { status: 'failed', error: '这条任务在 PugPort 里已不存在。' };
      // Slack says this in the requester's language instead of the router's Chinese reason.
      if ('error' in outcome && outcome.error?.trim() === noToollessExecutor)
        return { ...outcome, code: 'no-safe-executor' as const };
      if (settled.has(outcome.status)) return outcome;
      // Planning, running, or waiting for quota or for the owner to confirm or approve in PugPort: still under way.
      return {
        status: outcome.status === 'queued' ? 'queued' : outcome.status.startsWith('waiting') ? 'waiting' : 'running',
      };
    },
  };
}

/** How to start the pugport MCP server on this machine: the runtime running this backend, and its bundled script. */
export function mcpCommand(
  root: string,
  port: number,
  execPath = process.execPath,
  electron = Boolean(process.versions.electron),
  discoverDesktop = process.env.PUGPORT_DESKTOP_DISCOVERY === '1',
) {
  const env = {
    // Under the desktop app the runtime is the PugPort/Electron executable, which only acts as Node with this set.
    ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(!discoverDesktop && port !== 4317 ? { PUGPORT_PORT: String(port) } : {}),
  };
  return {
    command: execPath,
    args: [join(root, 'dist', 'server', 'pugport-mcp.js')],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

export function externalTaskRoutes(
  app: Express,
  tasks: ExternalTasks,
  options: {
    root: string;
    port: number;
    /** Typing in a conversation, as the app's own message route does it. */
    send?: TypedSend;
    /** Whether a process id is one of PugPort's own executors. */
    ownsProcess?: (pid: number) => boolean;
    deviceToken?: () => string | undefined;
    fromExecutor?: (req: Request) => Promise<CallerKind>;
  },
) {
  const executorError =
    "This is one of PugPort's own executors: it already has PugPort's built-in tools and cannot use the pugport MCP server.";
  // Checked inside dispatch/follow once write is known, so read-only tasks never run the process lookup.
  const fromExecutor = (req: Request) =>
    options.fromExecutor
      ? {
          fromExecutor: () =>
            Promise.resolve()
              .then(() => options.fromExecutor!(req))
              .catch((): CallerKind => 'unknown'),
        }
      : {};
  const refuse = (res: Response, error: unknown) => {
    if (error instanceof CallerUnknown) return refuseUnknownCaller(res);
    if (!(error instanceof ExecutorRefused)) throw error;
    res.status(403).json({ error: executorError });
  };
  // The pugport MCP server names the process that started it. When that is an executor PugPort itself runs (its
  // user config also lists the server), the executor would be handing work back to PugPort in a loop.
  app.use(['/api/external/tasks', '/api/external/conversations', '/api/external/agents'], (req, res, next) => {
    const parent = Number(req.headers['x-pugport-mcp-parent']);
    if (
      req.headers['x-pugport-executor'] === '1' ||
      (Number.isSafeInteger(parent) && parent > 0 && options.ownsProcess?.(parent))
    ) {
      res.status(403).json({
        error: executorError,
      });
      return;
    }
    next();
  });
  const limit = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
  app.get('/api/external/mcp-command', (_req, res) => res.json(mcpCommand(options.root, options.port)));
  app.get('/api/external/agents', (_req, res) => res.json(tasks.agents()));
  app.get('/api/external/tasks', (req, res) => {
    const query = z
      .object({
        limit: limit(20, 100),
        active: z.enum(['0', '1']).optional(),
        executor: z.string().max(100).optional(),
      })
      .parse(req.query);
    res.json(tasks.list({ limit: query.limit, activeOnly: query.active === '1', executor: query.executor }));
  });
  app.post('/api/external/tasks', async (req, res) => {
    const input = dispatchSchema.parse(req.body);
    if (input.source === 'device') {
      const expected = options.deviceToken?.();
      const supplied = req.header('x-pugport-device-token');
      const a = Buffer.from(expected ?? '');
      const b = Buffer.from(supplied ?? '');
      if (!expected || !supplied || a.length !== b.length || !timingSafeEqual(a, b)) {
        if (input.write) {
          res.status(403).json({
            error:
              "source: 'device' is only accepted from the PugPort device node on this computer. Update PugPort on the node, or send the task without source: 'device'.",
          });
          return;
        }
        delete input.source;
      }
    }
    try {
      res.status(201).json(await tasks.dispatch({ ...input, ...fromExecutor(req) }, options.send));
    } catch (error) {
      refuse(res, error);
    }
  });
  app.post('/api/external/tasks/:id/cancel', (req, res) => {
    if (tasks.cancel(req.params.id)) res.json(tasks.status(req.params.id));
    else res.status(404).json({ error: 'Task not found.' });
  });
  app.get('/api/external/conversations', (req, res) => {
    const query = z.object({ limit: limit(20, 100), query: z.string().max(200).optional() }).parse(req.query);
    res.json(tasks.conversations(query));
  });
  app.get('/api/external/conversations/:id', (req, res) => {
    const { limit: count } = z.object({ limit: limit(20, 50) }).parse(req.query);
    const conversation = tasks.read(req.params.id, count);
    if (conversation) res.json(conversation);
    else res.status(404).json({ error: 'Conversation not found.' });
  });
  app.post('/api/external/conversations/:id/messages', async (req, res) => {
    let sent;
    try {
      sent = await tasks.follow(req.params.id, { ...followSchema.parse(req.body), ...fromExecutor(req) }, options.send);
    } catch (error) {
      return refuse(res, error);
    }
    if (sent) res.status(201).json(sent);
    else res.status(404).json({ error: 'Conversation not found.' });
  });
  app.get('/api/external/tasks/:id', (req, res) => {
    const status = tasks.status(req.params.id);
    if (status) res.json(status);
    else res.status(404).json({ error: 'Task not found.' });
  });
  app.get('/api/external/tasks/:id/result', async (req, res) => {
    const { wait, sendFiles } = z
      .object({ wait: z.coerce.number().finite().nonnegative().optional(), sendFiles: z.literal('1').optional() })
      .parse(req.query);
    // Stop waiting as soon as the caller hangs up.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const result = await tasks.result(req.params.id, wait, abort.signal);
    if (abort.signal.aborted) return;
    if (!result) return void res.status(404).json({ error: 'Task not found.' });
    // A device node on this computer sends back the files named in any step, not only in the final answer.
    res.json(
      sendFiles && settled.has(result.status)
        ? { ...result, sendFiles: tasks.fullOutputs(req.params.id).flatMap((text) => text.match(sendFileLine) ?? []) }
        : result,
    );
  });
}
