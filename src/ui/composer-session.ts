import type { Conversation, ConversationMessage, TasteCandidate, Workflow } from '../shared/types';
import type { MessageQuote } from '../shared/quotes';
import type { DraftAttachment } from './attachments';
import type { DraftQuote } from './Quotes';
import { isExternalAgentId } from '../shared/external-agents';
import { deviceMentionPrefix } from '../shared/devices';
import type { CalledParticipant } from '../shared/participants';
import type { MentionItem } from './Mentions';
import { freeChainMentionId } from '../shared/participants';
import { withParticipant } from '../shared/participants';

export type ComposerDraft = {
  planFirst?: boolean;
  freeChain?: boolean;
  /** Role applies to the next new task; it never changes an already running task. */
  agentPresetId?: string;
  /** A folder on the single called device, never a path on this computer. */
  deviceFolder?: string;
  content: string;
  attachments: DraftAttachment[];
  quotes?: DraftQuote[];
  createdConversation?: Conversation;
  /** A trial writer applies to this draft only and is consumed when the message is sent. */
  writer?: Pick<TasteCandidate, 'runtimeId' | 'model' | 'effort' | 'label'>;
  /**
   * Who was called with @@, in the order they were picked: roles, executors, agents outside
   * PugPort and devices alike. One answers the message itself (a role on the usual executor, an executor with its
   * own defaults, an outside agent or a device), as before; two or more make it a coordinated task. The
   * conversation's own role and the composer's own executor are unchanged either way.
   */
  called?: CalledParticipant[];
  /** A single recipient inherited from the previous send, independent of @names in the new text. */
  stickyCalled?: boolean;
};
export const emptyDraft = (): ComposerDraft => ({ content: '', attachments: [], quotes: [] });

export const sentQuotes = (quotes: DraftQuote[]): MessageQuote[] =>
  quotes.map(({ text, note, messageId, markup }) => ({ text, note, messageId, ...(markup ? { markup } : {}) }));

export function pickDraftMention(draft: ComposerDraft, item: MentionItem, content: string): ComposerDraft {
  if (item.id === freeChainMentionId)
    return { ...draft, content, freeChain: true, called: undefined, stickyCalled: undefined, writer: undefined };
  return {
    ...draft,
    content,
    ...(item.kind === 'device' && !draft.called?.some((entry) => entry.kind === 'device' && entry.id === item.id)
      ? { deviceFolder: undefined }
      : {}),
    freeChain: false,
    stickyCalled: undefined,
    called: withParticipant(draft.stickyCalled ? [] : (draft.called ?? []), item),
  };
}

export function draftAfterSend(draft: ComposerDraft): ComposerDraft {
  const single = draft.called?.length === 1;
  return {
    ...emptyDraft(),
    agentPresetId: draft.agentPresetId,
    ...(single ? { called: draft.called, stickyCalled: true } : {}),
    ...(single && draft.called![0]!.kind === 'device' ? { deviceFolder: draft.deviceFolder } : {}),
  };
}

/** Restore only a recorded call with a successful, attributable answer, never infer a recipient from text. */
export function draftFromHistory(messages: ConversationMessage[], workflows: Workflow[]): ComposerDraft {
  const draft = emptyDraft();
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role !== 'user') index--;
  const user = messages[index];
  if (!user) return draft;
  const replies = messages
    .slice(index + 1)
    .filter(
      (message) =>
        message.role === 'assistant' && message.conversationId === user.conversationId && !message.systemNotice,
    );
  const external = user.externalRequest?.agentId;
  if (external && isExternalAgentId(external)) {
    const reply = replies.find(
      (message) =>
        message.externalAgent?.agentId === external &&
        message.externalAgent.status === 'done' &&
        // Desktop handoff also records done; only a routine reply or a pasted one is an answer from Grok Bot.
        (external !== 'grok-bot' || message.externalAgent.routine?.replied || !!message.externalAgent.importedAt),
    );
    if (reply)
      return {
        ...draft,
        called: [{ kind: 'external', id: external, name: reply.externalAgent!.name }],
        stickyCalled: true,
      };
    return draft;
  }
  const workflow = workflows.find(
    (item) => item.userMessageId === user.id && item.conversationId === user.conversationId && !item.delegation,
  );
  if (!workflow || workflow.status !== 'completed' || workflow.input.participants?.length) return draft;
  const reply = replies.find((message) => message.id === workflow.finalMessageId && message.workflowId === workflow.id);
  if (!reply) return draft;
  const input = workflow.input;
  if (!input.deviceId || reply.device?.id !== input.deviceId) return draft;
  return {
    ...draft,
    called: [{ kind: 'device', id: `${deviceMentionPrefix}${input.deviceId}`, name: reply.device.name }],
    stickyCalled: true,
    deviceFolder: input.deviceFolder,
  };
}

export const hasDraftContent = (draft: ComposerDraft) =>
  Boolean(draft.content.trim() || draft.attachments.length || draft.quotes?.length || draft.writer);
export type PendingComposerSend = {
  id: string;
  scope: string;
  conversationId?: string;
  content: string;
  images: string[];
  quotes: MessageQuote[];
  sentAt: string;
  messageId?: string;
  confirmedMessage?: ConversationMessage;
  error?: string;
  snapshot: ComposerDraft;
};

export const composerMessageKey = (message: ConversationMessage) =>
  message.role === 'user' && message.clientMessageId ? `client:${message.clientMessageId}` : `message:${message.id}`;

/** Reconcile by request identity, never by content: two identical messages remain two messages. */
export function mergePendingMessages(
  messages: ConversationMessage[],
  pending: PendingComposerSend[],
): ConversationMessage[] {
  const ids = new Set(messages.map((message) => message.id));
  const clients = new Set(
    messages.filter((message) => message.role === 'user').map((message) => message.clientMessageId),
  );
  return [
    ...messages,
    ...pending
      .filter((item) => !(item.messageId && ids.has(item.messageId)) && !clients.has(item.id))
      .map(
        (item): ConversationMessage =>
          item.confirmedMessage ?? {
            id: item.messageId ?? `pending:${item.id}`,
            clientMessageId: item.id,
            conversationId: item.conversationId ?? '',
            role: 'user',
            content: item.content,
            quotes: item.quotes,
            createdAt: item.sentAt,
          },
      ),
  ];
}
type Snapshot = { drafts: Record<string, ComposerDraft>; pendingSends: PendingComposerSend[] };

/** Window-owned drafts survive pane replacement, page changes and new-conversation ID assignment. */
export class ComposerSession {
  private snapshot: Snapshot = { drafts: {}, pendingSends: [] };
  private confirmed = new Map<string, ConversationMessage>();
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Effect setup also runs after React's development-only cleanup/setup cycle. */
  activate() {
    this.disposed = false;
  }
  getSnapshot = () => this.snapshot;
  hasUnsavedWork = () =>
    this.snapshot.pendingSends.length > 0 || Object.values(this.snapshot.drafts).some(hasDraftContent);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  /** Window-level SSE evidence survives navigating away from the composer while its POST is pending. */
  observeMessages(messages: ConversationMessage[]) {
    const pending = new Set(this.snapshot.pendingSends.map((item) => item.id));
    for (const id of this.confirmed.keys()) if (!pending.has(id)) this.confirmed.delete(id);
    for (const message of messages)
      if (message.role === 'user' && message.clientMessageId && pending.has(message.clientMessageId))
        this.confirmed.set(message.clientMessageId, message);
  }
  confirmedMessage(id: string, conversationId?: string) {
    const message = this.confirmed.get(id);
    return message?.conversationId === conversationId ? message : undefined;
  }
  private urls(value: Snapshot) {
    return new Set(
      [...Object.values(value.drafts), ...value.pendingSends.map((item) => item.snapshot)].flatMap((draft) => [
        ...draft.attachments.flatMap((item) => (item.previewUrl ? [item.previewUrl] : [])),
        ...(draft.quotes ?? []).flatMap((quote) => (quote.markupSrc?.startsWith('blob:') ? [quote.markupSrc] : [])),
      ]),
    );
  }
  private update(next: Snapshot) {
    if (this.disposed) return;
    const retained = this.urls(next);
    for (const url of this.urls(this.snapshot)) if (!retained.has(url)) URL.revokeObjectURL(url);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  changeDraft(scope: string, update: (draft: ComposerDraft) => ComposerDraft) {
    this.update({
      ...this.snapshot,
      drafts: { ...this.snapshot.drafts, [scope]: update(this.snapshot.drafts[scope] ?? emptyDraft()) },
    });
  }
  changePending(update: (items: PendingComposerSend[]) => PendingComposerSend[]) {
    this.update({ ...this.snapshot, pendingSends: update(this.snapshot.pendingSends) });
  }
  moveScope(from: string, to: string) {
    if (from === to) return;
    const drafts = { ...this.snapshot.drafts };
    if (drafts[from]) {
      drafts[to] = drafts[from];
      delete drafts[from];
    }
    this.update({
      drafts,
      pendingSends: this.snapshot.pendingSends.map((item) => (item.scope === from ? { ...item, scope: to } : item)),
    });
  }
  dispose() {
    for (const url of this.urls(this.snapshot)) URL.revokeObjectURL(url);
    this.snapshot = { drafts: {}, pendingSends: [] };
    this.disposed = true;
    this.listeners.clear();
    this.confirmed.clear();
  }
}
