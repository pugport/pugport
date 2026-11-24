import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { ensureGrokBotRunning } from '../src/server/external-agents/grok-desktop.ts';
import { startGrokBot } from '../src/electron/grok-bot-launch.ts';
import { GrokBotNotInstalledError, grokBotBundleId, grokBotRunning } from '../src/server/platform/grok-bot.ts';
import type { spawn } from '../src/server/platform/test-process.ts';
import { fakeHost, type FakeRun } from './helpers/fake-host.ts';

const lsappinfo = '/usr/bin/lsappinfo';
const open = '/usr/bin/open';
// What `lsappinfo find` prints for one running app, and what `open -b` prints when no app has the bundle id.
const runningLine = 'ASN:0x0-0x2c42c4-"Grok Bot":\n';
const notFound = `LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier ${grokBotBundleId}.\n`;
const commandFailed = (file: string, stderr: string, extra = {}) =>
  Object.assign(new Error(`Command failed: ${file}`), { code: 1, stdout: '', stderr, ...extra });
const noSpawn = (() => assert.fail('macOS starts Grok Bot through LaunchServices, never by spawning')) as typeof spawn;

/**
 * A fake Mac with a clock that moves only when the preflight sleeps. `events` records each program run and sleep;
 * `stopAt` stops the routine while that numbered event is in progress.
 */
function mac(reply: (file: string, clock: number) => ReturnType<FakeRun>, stopAt = Infinity) {
  const events: string[] = [];
  const state = { clock: 0, stopped: stopAt === 0 };
  const record = (event: string) => {
    events.push(event);
    if (events.length === stopAt) state.stopped = true;
  };
  const host = fakeHost('darwin', {
    env: { HOME: '/Users/fixture', PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', PUGPORT_WEB_BRIDGE: '1' },
    run: (file, args, options) => {
      record(file === open ? 'open' : 'lsappinfo');
      if (file === open) assert.deepEqual(args, ['-g', '-j', '-b', grokBotBundleId]);
      else assert.deepEqual(args, ['find', `bundleid=${grokBotBundleId}`]);
      assert.equal(options?.timeout, 10_000);
      if (file === open) assert.deepEqual(options?.env, { HOME: '/Users/fixture', PATH: '/usr/bin:/bin' });
      return reply(file, state.clock);
    },
  });
  const preflight = () =>
    ensureGrokBotRunning({
      host,
      start: () => startGrokBot(host, noSpawn),
      stopped: () => state.stopped,
      now: () => state.clock,
      sleep: async (ms) => {
        record(`wait:${ms}`);
        state.clock += ms;
      },
    });
  return { host, events, state, preflight };
}

/** Grok Bot is installed and stopped; LaunchServices lists it two seconds after `open` returns. */
const installed = () => {
  let openedAt: number | undefined;
  return (file: string, clock: number) => {
    if (file === open) openedAt = clock;
    return { stdout: openedAt !== undefined && clock >= openedAt + 2000 ? runningLine : '', stderr: '' };
  };
};

test('macOS: a running Grok Bot passes with one LaunchServices query and is not started', async () => {
  const { preflight, events } = mac(() => ({ stdout: runningLine, stderr: '' }));
  assert.equal(await preflight(), true);
  assert.deepEqual(events, ['lsappinfo']);
});

test('macOS: only a line for Grok Bot itself counts as running', async () => {
  for (const stdout of ['', '\n', 'no ASN:0x0-0x1-"Other":\n'])
    assert.equal(await grokBotRunning(fakeHost('darwin', { run: () => ({ stdout, stderr: '' }) })), false);
  assert.equal(
    await grokBotRunning(fakeHost('darwin', { run: () => ({ stdout: `\n${runningLine}`, stderr: '' }) })),
    true,
  );
});

// One full start, then a stop during each step of it: nothing runs after the stop, and the routine is not ready.
const fullStart = [
  'lsappinfo',
  'open',
  'lsappinfo',
  'wait:1000',
  'lsappinfo',
  'wait:1000',
  'lsappinfo',
  'wait:5000',
  'lsappinfo',
];
for (let stopAt = 0; stopAt <= fullStart.length + 1; stopAt++) {
  const ready = stopAt > fullStart.length;
  test(
    ready
      ? 'macOS: an installed but stopped Grok Bot is opened hidden by bundle id, waited for and rechecked'
      : stopAt
        ? `macOS: a stop during step ${stopAt} (${fullStart[stopAt - 1]}) cancels the preflight`
        : 'macOS: a stop before the first check cancels the preflight',
    async () => {
      const { preflight, events, host } = mac(installed(), ready ? Infinity : stopAt);
      assert.equal(await preflight(), ready);
      assert.deepEqual(events, fullStart.slice(0, stopAt));
      assert.equal(host.env.ELECTRON_RUN_AS_NODE, '1', 'the host environment itself is left alone');
    },
  );
}

test('macOS: a missing Grok Bot fails as not installed, without waiting for it', async () => {
  const reply = (file: string) => {
    if (file === open) throw commandFailed(open, notFound);
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(startGrokBot(mac(reply).host, noSpawn), (error: unknown) => {
    assert.ok(error instanceof GrokBotNotInstalledError);
    assert.equal(error.name, 'GrokBotNotInstalledError');
    return true;
  });
  const { preflight, events } = mac(reply);
  assert.equal(await preflight(), false);
  assert.deepEqual(events, ['lsappinfo', 'open']);
});

test('macOS: any other open failure, a timeout included, passes on unchanged and is not ready', async () => {
  const failure = commandFailed(open, '', { killed: true, signal: 'SIGTERM', code: null });
  const reply = (file: string) => {
    if (file === open) throw failure;
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(startGrokBot(mac(reply).host, noSpawn), (error: unknown) => error === failure);
  const { preflight, events } = mac(reply);
  assert.equal(await preflight(), false);
  assert.deepEqual(events, ['lsappinfo', 'open']);
});

test('macOS: a Grok Bot that never appears times out after twenty seconds', async () => {
  const { preflight, events, state } = mac(() => ({ stdout: '', stderr: '' }));
  assert.equal(await preflight(), false);
  assert.equal(state.clock, 20_000);
  assert.deepEqual(events.slice(0, 3), ['lsappinfo', 'open', 'lsappinfo']);
  assert.equal(events.filter((event) => event === 'wait:1000').length, 20);
  assert.equal(events.filter((event) => event === 'lsappinfo').length, 21);
});

test('macOS: a LaunchServices query that fails or times out neither passes nor starts the app', async () => {
  const { preflight, events } = mac(() => {
    throw commandFailed(lsappinfo, '', { killed: true, signal: 'SIGTERM', code: null });
  });
  assert.equal(await preflight(), false);
  assert.deepEqual(events, ['lsappinfo']);
});

test('Windows keeps its tasklist check through the host, and other systems skip the check', async () => {
  const calls: string[] = [];
  const windows = fakeHost('win32', {
    env: { SystemRoot: 'C:\\Windows' },
    run: (file, args, options) => {
      calls.push(file);
      assert.deepEqual(args, ['/FI', 'IMAGENAME eq Grok Bot.exe', '/FO', 'CSV', '/NH']);
      assert.deepEqual(options, { windowsHide: true, timeout: 10_000 });
      return { stdout: '"Grok Bot.exe","123","Console","1","10,000 K"', stderr: '' };
    },
  });
  assert.equal(await ensureGrokBotRunning({ host: windows }), true);
  assert.deepEqual(calls, ['C:\\Windows\\System32\\tasklist.exe']);
  const linux = fakeHost('linux', { run: () => assert.fail('no desktop app to check') });
  assert.equal(await ensureGrokBotRunning({ host: linux, start: async () => assert.fail('nothing to start') }), true);
});

test(
  "this Mac's open names the bundle identifier when no app has it",
  { skip: process.platform !== 'darwin' && 'macOS only' },
  async () => {
    // A bundle id no app can have, so nothing opens. This pins the wording the missing-app check relies on.
    const missing = 'invalid.pugport.tests.no-such-app';
    const { failed, stderr } = await new Promise<{ failed: boolean; stderr: string }>((resolve) =>
      execFile(open, ['-g', '-j', '-b', missing], { timeout: 10_000 }, (error, _stdout, text) =>
        resolve({ failed: !!error, stderr: text }),
      ),
    );
    assert.ok(failed, 'open must fail for a bundle id with no app');
    assert.ok(stderr.includes(`bundle identifier ${missing}`), stderr);
  },
);
