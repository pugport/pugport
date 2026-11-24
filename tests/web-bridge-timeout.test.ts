import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

let bridgeCode: string;
before(async () => {
  bridgeCode = await uiBundle('src/electron/web-bridge.ts');
});

/** Exercise the send/wait/result path with a fake page and clock; never create an Electron window. */
async function timeoutResult(generating: boolean, reply?: string, expire = false, defaults = false) {
  let clock = 0;
  let expiry: (() => void) | undefined;
  const fake = { unref() {} };
  const stops: string[] = [];
  class FakeDate extends Date {
    static override now() {
      clock += 4000;
      return clock;
    }
  }
  const h = uiHarness(bridgeCode, {
    Date: FakeDate,
    setTimeout: (fn: () => void, ms: number) => {
      if (ms === 123456 || ms > 600_000) {
        assert.equal(ms, defaults ? 31 * 60_000 : 123456);
        expiry = fn;
        return fake;
      }
      return setImmediate(fn);
    },
    clearTimeout: (h: NodeJS.Immediate | typeof fake) => h !== fake && clearImmediate(h as NodeJS.Immediate),
  });
  const bridge = new h.exports.WebBridge({ port: 1, followMaxMs: defaults ? undefined : 123456 });
  const window = { webContents: { focus() {}, async insertText() {} }, isDestroyed: () => false };
  bridge.window = () => window;
  bridge.load = async () => {};
  bridge.waitForPage = async () => ({
    input: true,
    send: true,
    editable: false,
    selectors: {},
    check: '',
    loginHint: false,
  });
  bridge.limit = async () => null;
  bridge.click = () => {};
  bridge.wasSent = async () => true;
  bridge.status = async () => ({ tracking: true, generating, quietMs: 10_000, changed: 0, inputText: '', check: '' });
  bridge.page = async (_contents: unknown, script: string) => {
    if (script.includes('.prepare(') || script.includes('.sendTarget(')) return { x: 1, y: 1, disabled: false };
    if (script.includes('.value(')) return 'Question';
    if (script.includes('.reply(')) return reply ? { text: reply, selector: '.answer' } : null;
    if (script.includes('.track(')) return 'tracker-1';
    if (script.includes('.stop(')) {
      stops.push(script);
      return true;
    }
    throw new Error(`Unexpected fake page call: ${script}`);
  };
  const result = await bridge.send({
    action: 'send',
    agentId: 'fixture',
    name: 'Fixture',
    url: 'https://fixture.test/',
    text: 'Question',
    timeoutMs: 3000,
  });
  if (reply) assert.equal(stops.length, 0, 'the first reply must leave its tracker alive');
  else assert.equal(stops.length, 1, 'a failed first reply releases its tracker');
  if (expire) {
    assert.ok(expiry);
    expiry();
    assert.equal(stops.length, 1);
    assert.equal(stops[0], '__pugportBridge.stop("tracker-1")');
  }
  return result;
}

test('timeout distinguishes an ongoing generation without captured text from no valid reply', async () => {
  const ongoing = await timeoutResult(true);
  assert.equal(ongoing.ok, false);
  assert.equal(ongoing.code, 'timeout');
  assert.equal(ongoing.sent, true);
  assert.equal(ongoing.reply, undefined);
  assert.equal(ongoing.message, '它还在回复，已超过等待时间；请在它的窗口里查看');
  const missing = await timeoutResult(false);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'timeout');
  assert.equal(missing.sent, true);
  assert.equal(missing.reply, undefined);
  assert.equal(missing.message, '没找到它的回复，请在它的窗口里查看。');
});

test('an ongoing generation keeps captured partial text with the timeout note', async () => {
  const result = await timeoutResult(true, 'Partial answer', true);
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Partial answer');
  assert.equal(result.partial, true);
  assert.equal(result.trackerId, 'tracker-1');
  assert.equal(result.message, '它还在回复，已超过等待时间；请在它的窗口里查看');
});

test('the default Electron tracker expires at 31 minutes, after the server cap', async () => {
  assert.equal((await timeoutResult(true, 'Answer', true, true)).ok, true);
});

test('a login redirect during reply wait returns login immediately without waiting for timeout and preserves trackerId', async () => {
  let clock = 0;
  const stops: string[] = [];
  class FakeDate extends Date {
    static override now() {
      clock += 100;
      return clock;
    }
  }
  const h = uiHarness(bridgeCode, {
    Date: FakeDate,
    setTimeout: (fn: () => void, ms: number) => (ms > 600_000 ? { unref() {} } : setImmediate(fn)),
    clearTimeout: () => {},
  });
  const bridge = new h.exports.WebBridge({ port: 1, present() {} });
  const window = { webContents: { focus() {}, async insertText() {} }, isDestroyed: () => false };
  bridge.window = () => window;
  bridge.load = async () => {};
  bridge.waitForPage = async () => ({
    input: true,
    send: true,
    editable: false,
    selectors: {},
    check: '',
    loginHint: false,
  });
  bridge.limit = async () => null;
  bridge.click = () => {};
  bridge.wasSent = async () => true;
  bridge.status = async () => ({
    tracking: true,
    generating: false,
    quietMs: 0,
    changed: 0,
    inputText: '',
    check: 'login',
  });
  bridge.page = async (_contents: unknown, script: string) => {
    if (script.includes('.prepare(') || script.includes('.sendTarget(')) return { x: 1, y: 1, disabled: false };
    if (script.includes('.value(')) return 'Question';
    if (script.includes('.track(')) return 'tracker-login';
    if (script.includes('.stop(')) {
      stops.push(script);
      return true;
    }
    throw new Error(`Unexpected fake page call: ${script}`);
  };
  const result = await bridge.send({
    action: 'send',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://fixture.test/',
    text: 'Question',
    timeoutMs: 180_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'login');
  assert.equal(result.trackerId, 'tracker-login');
  assert.equal(stops.length, 0, 'sent-turn tracker stays alive for post-login recovery');
  assert.ok(clock < 5_000, 'returns immediately without waiting for timeout');
});

test('an unattributable reply ends the wait at once, and the retry only reads the page', async () => {
  let clock = 0;
  class FakeDate extends Date {
    static override now() {
      clock += 100;
      return clock;
    }
  }
  const h = uiHarness(bridgeCode, {
    Date: FakeDate,
    setTimeout: (fn: () => void, ms: number) => (ms > 600_000 ? { unref() {} } : setImmediate(fn)),
    clearTimeout: () => {},
  });
  const bridge = new h.exports.WebBridge({ port: 1 });
  const window = { webContents: { focus() {}, async insertText() {} }, isDestroyed: () => false };
  bridge.window = () => window;
  bridge.load = async () => {};
  bridge.waitForPage = async () => ({
    input: true,
    send: true,
    editable: false,
    selectors: {},
    check: '',
    loginHint: false,
  });
  bridge.limit = async () => null;
  bridge.click = () => {};
  bridge.wasSent = async () => true;
  // The page reloads once after sending, so the prompt is already on it when tracking starts again.
  let tracking = false;
  bridge.status = async () => {
    const status = { tracking, generating: false, quietMs: 10_000, changed: 1, inputText: '', check: '' };
    tracking = true;
    return status;
  };
  const scripts: string[] = [];
  bridge.page = async (_contents: unknown, script: string) => {
    scripts.push(script);
    if (script.includes('.prepare(') || script.includes('.sendTarget(')) return { x: 1, y: 1, disabled: false };
    if (script.includes('.value(')) return 'Question';
    if (script.includes('.track(')) return 'tracker-ambiguous';
    if (script.includes('.reply(')) return { code: 'ambiguous' };
    if (script.includes('.recapture(')) return { ok: false, code: 'ambiguous' };
    if (script.includes('.stop(')) return true;
    throw new Error(`Unexpected fake page call: ${script}`);
  };
  const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/' };
  const sent = await bridge.send({ ...target, action: 'send', text: 'Question', timeoutMs: 180_000 });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'ambiguous');
  assert.equal(sent.sent, true, 'a retry only recaptures');
  assert.equal(sent.trackerId, undefined, 'the released tracker is not handed back');
  assert.match(sent.message, /^消息发出去了，但 Muse 的页面上分不清哪条回复属于这次提问.*不会重发。$/);
  assert.ok(clock < 5_000, 'returns without waiting for the timeout');
  assert.deepEqual(
    scripts.filter((script) => script.includes('.track(')),
    ['__pugportBridge.track("Question")', '__pugportBridge.track("Question", true)'],
  );
  assert.ok(scripts.includes('__pugportBridge.stop("tracker-ambiguous")'));

  scripts.length = 0;
  const recaptured = await bridge.recapture({ ...target, action: 'recapture', text: 'Question' });
  assert.equal(recaptured.code, 'ambiguous');
  assert.equal(recaptured.sent, true);
  assert.equal(recaptured.message, sent.message);
  assert.deepEqual(scripts, ['__pugportBridge.recapture("Question", {})'], 'reads without typing or sending');
});

test('peek and stop bypass the send queue and a pending peek never delays a new send', async () => {
  const h = uiHarness(bridgeCode);
  const bridge = new h.exports.WebBridge({ port: 1 });
  const target = { agentId: 'fixture', name: 'Fixture', url: 'https://fixture.test/' };
  let release!: (value: unknown) => void;
  let sends = 0;
  bridge.run = async (r: { action: string }) => {
    if (r.action === 'peek')
      return new Promise((resolve) => {
        release = resolve;
      });
    if (r.action === 'send') sends++;
    return { ok: true };
  };
  const pending = bridge.handle({ ...target, action: 'peek', trackerId: 'old' });
  assert.equal((await bridge.handle({ ...target, action: 'send', text: 'Next' })).ok, true);
  assert.equal(sends, 1);
  assert.equal((await bridge.handle({ ...target, action: 'stop', trackerId: 'old' })).ok, true);
  release({ ok: true, reply: 'Old' });
  await pending;
  bridge.queues.set('fixture', new Promise(() => {}));
  const peek = bridge.handle({ ...target, action: 'peek', trackerId: 'old' });
  release({ ok: false, code: 'replaced' });
  assert.equal((await peek).code, 'replaced');
  assert.equal((await bridge.handle({ ...target, action: 'cancel' })).ok, true);
});

test('cancel before submission aborts send without typing or clicking send', async () => {
  const h = uiHarness(bridgeCode, {
    setTimeout: (fn: () => void, ms: number) => (ms > 600_000 ? { unref() {} } : setImmediate(fn)),
    clearTimeout: () => {},
  });
  const bridge = new h.exports.WebBridge({ port: 1 });
  let typedCount = 0;
  let clickedCount = 0;
  const window = {
    webContents: {
      focus() {},
      async insertText() {
        typedCount++;
      },
    },
    isDestroyed: () => false,
  };
  bridge.window = () => window;
  bridge.load = async () => {
    await bridge.handle({ action: 'cancel', agentId: 'muse', name: 'Muse', url: 'https://fixture.test/' });
  };
  bridge.waitForPage = async () => ({
    input: true,
    send: true,
    editable: false,
    selectors: {},
    check: '',
    loginHint: false,
  });
  bridge.click = () => {
    clickedCount++;
  };
  const result = await bridge.handle({
    action: 'send',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://fixture.test/',
    text: 'Question',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-sent');
  assert.equal(result.sent, undefined);
  assert.equal(typedCount, 0);
  assert.equal(clickedCount, 0);
});

test('switching PugPort conversations reloads a clean thread for a new conversation and restores saved thread URLs', async () => {
  const h = uiHarness(bridgeCode, {
    setTimeout: (fn: () => void, ms: number) => (ms > 600_000 ? { unref() {} } : setImmediate(fn)),
    clearTimeout: () => {},
  });
  const bridge = new h.exports.WebBridge({ port: 1 });
  let currentUrl = 'https://fixture.test/';
  const loads: Array<{ url: string; exact: boolean; reload: boolean }> = [];
  const window = {
    webContents: {
      focus() {},
      async insertText() {},
      getURL: () => currentUrl,
    },
    isDestroyed: () => false,
  };
  bridge.window = () => window;
  bridge.load = async (_w: unknown, url: string, _name: string, exact = false, reload = false) => {
    loads.push({ url, exact, reload });
    currentUrl = url === 'https://fixture.test/' ? `https://fixture.test/t/${loads.length}` : url;
  };
  bridge.waitForPage = async () => ({
    input: true,
    send: true,
    editable: false,
    selectors: {},
    check: '',
    loginHint: false,
  });
  bridge.limit = async () => null;
  bridge.click = () => {};
  bridge.wasSent = async () => true;
  bridge.status = async () => ({
    tracking: true,
    generating: false,
    quietMs: 5000,
    changed: 1,
    inputText: '',
    check: '',
  });
  bridge.page = async (_contents: unknown, script: string) => {
    if (script.includes('.prepare(') || script.includes('.sendTarget(')) return { x: 1, y: 1, disabled: false };
    if (script.includes('.value(')) return 'Question';
    if (script.includes('.reply(')) return { text: `Reply on ${currentUrl}`, selector: '.answer' };
    if (script.includes('.track(')) return `tracker-${loads.length}`;
    if (script.includes('.stop(')) return true;
    throw new Error(`Unexpected fake page call: ${script}`);
  };

  const firstA = await bridge.send({
    action: 'send',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://fixture.test/',
    text: 'Question',
    conversationId: 'conv-a',
  });
  assert.equal(firstA.pageUrl, 'https://fixture.test/t/1');
  assert.deepEqual(loads[0], { url: 'https://fixture.test/', exact: false, reload: false });

  const firstB = await bridge.send({
    action: 'send',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://fixture.test/',
    text: 'Question',
    conversationId: 'conv-b',
  });
  assert.equal(firstB.pageUrl, 'https://fixture.test/t/2');
  assert.deepEqual(loads[1], { url: 'https://fixture.test/', exact: true, reload: true });

  const secondA = await bridge.send({
    action: 'send',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://fixture.test/',
    text: 'Question',
    conversationId: 'conv-a',
  });
  assert.equal(secondA.pageUrl, 'https://fixture.test/t/1');
  assert.deepEqual(loads[2], { url: 'https://fixture.test/t/1', exact: true, reload: false });
});

test('peek returns closed without creating a window and stale trackers are replaced after reload', async () => {
  const h = uiHarness(bridgeCode);
  const bridge = new h.exports.WebBridge({ port: 1 });
  const request = {
    action: 'peek',
    agentId: 'fixture',
    name: 'Fixture',
    url: 'https://fixture.test/',
    trackerId: 'old',
  };
  assert.equal((await bridge.handle(request)).code, 'closed');
  bridge.windows.set('fixture', { isDestroyed: () => false, webContents: {} });
  bridge.page = async () => ({ ok: false, code: 'replaced' });
  assert.equal((await bridge.handle(request)).code, 'replaced');
});
