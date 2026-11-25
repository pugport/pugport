/**
 * PugPort's local API refuses an owner-level write whose caller it could not identify with HTTP 503, `Retry-After`
 * and this code in the JSON body. The refusal is sent before any handler runs, so nothing was started and the same
 * request can be sent again; PugPort's own clients do that once. Any other 503 is not this refusal and is never resent.
 */
export const callerUnknownCode = 'caller-unknown';
export const callerUnknownRetrySeconds = 2;
const longestWaitSeconds = 5;

/** How long to wait before the one resend, in milliseconds; undefined when the answer is not that refusal. */
export function callerUnknownRetryMs(
  status: number,
  body: unknown,
  retryAfter: string | null | undefined,
): number | undefined {
  if (status !== 503 || (body as { code?: unknown } | null | undefined)?.code !== callerUnknownCode) return undefined;
  // Whole seconds only; an HTTP date or anything else unreadable falls back to the default.
  const seconds = /^\d{1,9}$/.test(retryAfter?.trim() ?? '') ? Number(retryAfter) : callerUnknownRetrySeconds;
  return Math.min(seconds, longestWaitSeconds) * 1000;
}
