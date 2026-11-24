/*
 * The request/response channel between the backend and the desktop app's web bridge (src/electron/web-bridge.ts):
 * the desktop app owns a browser window per web agent, the backend decides what to send and keeps the messages.
 */

/** Where things are on a chat site; any of them may be missing, and heuristics fill the gaps. */
export type WebSelectors = { input?: string; send?: string; reply?: string; stop?: string };

export type WebAgentTarget = { agentId: string; name: string; url: string; selectors?: WebSelectors };
export type WebAgentRequest =
  | ({ action: 'desktop-start-minimized' } & WebAgentTarget)
  | ({ action: 'desktop-open' } & WebAgentTarget)
  | ({ action: 'desktop-handoff'; text: string } & WebAgentTarget)
  | ({ action: 'open' } & WebAgentTarget)
  | ({ action: 'detect' } & WebAgentTarget)
  | ({
      action: 'recapture';
      text: string;
      trackerId?: string;
      conversationId?: string;
      threadUrl?: string;
    } & WebAgentTarget)
  | ({ action: 'peek'; trackerId: string } & WebAgentTarget)
  | ({ action: 'stop'; trackerId: string } & WebAgentTarget)
  | ({ action: 'cancel' } & WebAgentTarget)
  | ({
      action: 'usage';
      automatic?: boolean;
      /** Read-only, non-presenting usage capture, including when no chat window exists. */
      background?: boolean;
      navigate?: boolean;
      afterReply?: boolean;
      signatures?: import('./external-agents.ts').WebUsageSignature[];
      usageUrl?: string;
      configurationVersion?: string;
    } & WebAgentTarget)
  | ({
      action: 'monitor';
      enabled: boolean;
      /** Check an existing Muse chat for sign-in only while automatic usage reads are paused. */
      usageSignedOut?: boolean;
      signatures?: import('./external-agents.ts').WebUsageSignature[];
      usageUrl?: string;
      configurationVersion?: string;
    } & WebAgentTarget)
  | ({
      action: 'send';
      text: string;
      timeoutMs?: number;
      stableMs?: number;
      conversationId?: string;
      threadUrl?: string;
    } & WebAgentTarget)
  | ({ action: 'handoff'; text: string } & WebAgentTarget);

export type WebAgentResult = {
  ok: boolean;
  /** An existing Muse page has a usable chat input and no sign-in or verification wall. */
  authenticated?: boolean;
  /**
   * human-check: a captcha or verification page; login: a sign-in wall; not-detected: no chat box found;
   * not-sent: the text could not be put in or sent; closed: the user closed the window meanwhile;
   * not-installed: the desktop app to start is not installed.
   */
  code?:
    | 'human-check'
    | 'login'
    | 'not-detected'
    | 'not-sent'
    | 'timeout'
    | 'load-failed'
    | 'closed'
    | 'replaced'
    | 'lost'
    | 'unavailable'
    | 'not-installed'
    | 'error';
  limit?: { reason: string; observedAt: string; resetsAt: string | null };
  grokDiagnostic?: import('./grok-usage.ts').GrokUsageDiagnostic;
  usageText?: string;
  pageUrl?: string;
  quota?: import('./external-agents.ts').WebQuota;
  signatures?: import('./external-agents.ts').WebUsageSignature[];
  usageUrl?: string;
  usageDiagnostics?: string[];
  /** Plain-language explanation for the user. */
  message?: string;
  /** True once the user prompt has been submitted to the page; retries must only recapture. */
  sent?: boolean;
  reply?: string;
  truncated?: boolean;
  trackerId?: string;
  /** The reply was still changing when the time ran out. */
  partial?: boolean;
  /** Selectors that worked on this page, for the per-site config. */
  selectors?: WebSelectors;
  found?: { input: boolean; send: boolean; reply: boolean };
};

/** Each web agent keeps its own sign-in, apart from PugPort's window and from every other agent. */
export const webAgentPartition = (agentId: string) =>
  agentId === 'grok-bot-usage' ? 'persist:pugport-grokbot-usage' : `persist:pugport-web-${agentId}`;

export const webAgentIdPattern = /^[a-z0-9-]{1,40}$/;

export function webAgentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}
