import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError, PugPortClient } from '../src/cli/client.ts';
import { publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import { callerUnknownCode, callerUnknownRetryMs } from '../src/shared/caller-unknown.ts';

test('only the caller-unknown refusal is resent, after Retry-After seconds within bounds', () => {
  const refusal = { error: 'synthetic', code: callerUnknownCode };
  assert.equal(callerUnknownRetryMs(503, refusal, '2'), 2000);
  assert.equal(callerUnknownRetryMs(503, refusal, '0'), 0);
  assert.equal(callerUnknownRetryMs(503, refusal, ' 3 '), 3000);
  assert.equal(callerUnknownRetryMs(503, refusal, '3600'), 5000, 'never longer than five seconds');
  for (const garbage of [
    undefined,
    null,
    '',
    'soon',
    '-1',
    '1.5',
    '1e3',
    'Wed, 21 Oct 2026 07:28:00 GMT',
    '9'.repeat(40),
  ])
    assert.equal(callerUnknownRetryMs(503, refusal, garbage), 2000, String(garbage));
  for (const body of [undefined, null, 'caller-unknown', {}, { error: 'synthetic' }, { code: 'other' }, { code: 1 }])
    assert.equal(callerUnknownRetryMs(503, body, '0'), undefined, JSON.stringify(body));
  for (const status of [200, 403, 429, 500, 502, 504])
    assert.equal(callerUnknownRetryMs(status, refusal, '0'), undefined);
});

test('the pugport command resends a write once when its caller could not be identified', async (t) => {
  t.after(publishSessionToken('synthetic', 1));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const unidentified = () =>
    Response.json(
      { error: 'PugPort could not identify the program making this request.', code: callerUnknownCode },
      { status: 503, headers: { 'retry-after': '0' } },
    );
  const run = async (answers: (() => Response)[]) => {
    const seen: { url: string; method?: string; token: string | null; body: unknown }[] = [];
    globalThis.fetch = async (url, init) => {
      seen.push({
        url: String(url),
        method: init?.method,
        token: new Headers(init?.headers).get('x-agent-token'),
        body: init?.body,
      });
      return answers.shift()!();
    };
    const result = await new PugPortClient(1)
      .post<{ ok: boolean }>('/api/conversations/c1/messages', { content: 'synthetic' })
      .catch((error: unknown) => error);
    return { result, seen };
  };

  const recovered = await run([unidentified, () => Response.json({ ok: true }, { status: 201 })]);
  assert.deepEqual(recovered.result, { ok: true });
  assert.equal(recovered.seen.length, 2);
  assert.deepEqual(recovered.seen[1], recovered.seen[0], 'the same request, token and body');
  assert.equal(recovered.seen[0]!.body, JSON.stringify({ content: 'synthetic' }));

  const stillRefused = await run([unidentified, unidentified, () => Response.json({ ok: true })]);
  assert.ok(stillRefused.result instanceof BackendError);
  assert.equal(stillRefused.result.status, 503);
  assert.match(stillRefused.result.message, /could not identify/);
  assert.equal(stillRefused.seen.length, 2, 'one resend, never more');

  const outage = await run([
    () => Response.json({ error: 'synthetic outage' }, { status: 503, headers: { 'retry-after': '0' } }),
    () => Response.json({ ok: true }),
  ]);
  assert.ok(outage.result instanceof BackendError);
  assert.match(outage.result.message, /synthetic outage/);
  assert.equal(outage.seen.length, 1, 'a 503 without the code is never resent');

  // Retry-After is honoured: the second asked for means the resend does not go out at once.
  const started = Date.now();
  const waited = await run([
    () =>
      Response.json({ error: 'synthetic', code: callerUnknownCode }, { status: 503, headers: { 'retry-after': '1' } }),
    () => Response.json({ ok: true }),
  ]);
  assert.deepEqual(waited.result, { ok: true });
  assert.ok(Date.now() - started >= 950, 'waited about the second the server asked for');
});
