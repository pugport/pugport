import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import {
  createNativeAccount,
  defaultGrokAccountFingerprint,
  defaultGrokHome,
  defaultNativeAccountFingerprint,
  defaultNativeAccountHome,
  launchAccountLogin,
  nativeAccountEnvironment,
  nativeAccountFingerprint,
  nativeAccountLoginPending,
} from '../src/server/native-accounts.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const base: RuntimeTarget = {
  id: 'grok-native',
  provider: 'grok',
  label: 'Grok',
  command: process.execPath,
  args: ['--config', 'previous-profile-config'],
  environment: 'native',
  enabled: true,
};
const codexBase: RuntimeTarget = { ...base, id: 'codex-native', provider: 'codex', label: 'Codex' };
const codexArgs = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];

test('native identity and login markers refuse high-bit file replacements', async (t) => {
  const target = await createNativeAccount(directory(t), base, 'Synthetic identity check');
  const auth = join(target.accountHome!, 'auth.json');
  const marker = join(target.accountHome!, '.comborunner-login.json');
  writeFileSync(auth, JSON.stringify({ main: { auth_mode: 'web_login', user_id: 'synthetic-file-id-user' } }));
  writeFileSync(
    marker,
    JSON.stringify({
      version: 1,
      nonce: '11111111-1111-4111-8111-111111111111',
      phase: 'finished',
      ownerPid: process.pid,
      helperPid: 0,
      pid: 0,
    }),
  );
  const ids = mockFileIds(t, [
    [auth, largeFileId],
    [marker, largeFileId],
  ]);
  assert.match(nativeAccountFingerprint(target)!, /^[a-f0-9]{64}$/);
  assert.equal(nativeAccountLoginPending(target), false);
  ids.opened(auth, largeFileId + 1n);
  ids.opened(marker, largeFileId + 1n);
  assert.equal(nativeAccountFingerprint(target), undefined);
  assert.equal(nativeAccountLoginPending(target), true);
});
// All new creation/launch mirroring reads stay inside a disposable fixture.
const defaults = mkdtempSync(join(tmpdir(), 'pugport-native-defaults-'));
const originalConfig = process.env.CODEX_HOME;
process.env.CODEX_HOME = join(defaults, 'codex');
after(() => {
  if (originalConfig === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalConfig;
  assert.ok(resolve(defaults).startsWith(resolve(tmpdir()) + sep));
  rmSync(defaults, { recursive: true, force: true });
});
const idToken = (accountId?: string, extra: Record<string, unknown> = {}) =>
  [
    Buffer.from(JSON.stringify({ alg: 'fixture-only' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { ...(accountId ? { chatgpt_account_id: accountId } : {}), ...extra },
      }),
    ).toString('base64url'),
    Buffer.from('fixture-not-a-real-signature').toString('base64url'),
  ].join('.');
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-native-accounts-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('comborunner-native-accounts-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  return realpathSync.native(root);
}

test('two native accounts receive distinct empty homes and fixed isolated sockets', async (t) => {
  const root = directory(t);
  const first = await createNativeAccount(root, base, '  账号一  ');
  const second = await createNativeAccount(root, base, '账号二');
  assert.equal(first.label, '账号一');
  assert.notEqual(first.accountId, second.accountId);
  assert.notEqual(first.accountHome, second.accountHome);
  for (const target of [first, second]) {
    assert.equal(target.id, `grok-account-${target.accountId}`);
    assert.equal(target.accountHome, join(root, 'accounts', target.accountId!));
    assert.equal(target.commandDiscovery, 'fixed');
    assert.equal(target.enabled, false);
    assert.deepEqual(target.args, ['--leader-socket', join(target.accountHome!, 'leader.sock')]);
    assert.deepEqual(readdirSync(target.accountHome!), []);
    assert.equal(nativeAccountFingerprint(target), undefined);
  }
});

test('isolated environment clears inherited credentials without mutating system environment', async (t) => {
  const target = await createNativeAccount(directory(t), base, 'Account');
  const source = {
    Path: 'system-path',
    USERPROFILE: 'system-user',
    HOME: 'system-home',
    SystemRoot: 'system-root',
    GROK_HOME: 'old-home',
    GROK_AUTH_PATH: 'old-auth',
    GROK_MODELS_BASE_URL: 'old-endpoint',
    XAI_API_KEY: 'fixture-key',
    xai_api_key: 'lowercase-key',
    OPENAI_API_KEY: 'fixture-key',
    CODEX_HOME: 'old-home',
    ANTHROPIC_API_KEY: 'fixture-key',
    CLAUDE_CONFIG_DIR: 'old-home',
  };
  const original = { ...source };
  const isolated = nativeAccountEnvironment(target, source);
  assert.deepEqual(source, original);
  assert.deepEqual(isolated, {
    Path: 'system-path',
    USERPROFILE: 'system-user',
    HOME: 'system-home',
    SystemRoot: 'system-root',
    GROK_HOME: target.accountHome,
    GROK_AUTH_PATH: join(target.accountHome!, 'auth.json'),
  });
  const defaultEnv = nativeAccountEnvironment(base, source);
  assert.deepEqual(defaultEnv, source);
  assert.notEqual(defaultEnv, source);
  assert.throws(() => nativeAccountEnvironment({ ...target, accountHome: undefined }, source), /目录无效/);
  assert.throws(() => nativeAccountEnvironment({ ...target, id: 'other-target' }, source), /目录无效/);
});

test('unsupported providers, wrappers and linked account directories fail before creating a profile', async (t) => {
  const root = directory(t);
  for (const provider of ['pi', 'dsh'] as const) {
    await assert.rejects(createNativeAccount(root, { ...base, provider }, 'Account'), /仅支持 Grok/);
  }
  await assert.rejects(createNativeAccount(root, { ...base, environment: 'wsl' }, 'Account'), /仅支持 Grok/);
  await assert.rejects(createNativeAccount(root, { ...base, command: join(root, 'grok.cmd') }, 'Account'), /包装脚本/);
  await assert.rejects(createNativeAccount(root, base, '\n'), /账号名称/);
  assert.deepEqual(readdirSync(root), []);
  const outside = directory(t);
  symlinkSync(outside, join(root, 'accounts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createNativeAccount(root, base, 'Account'), /目录无效/);
  assert.deepEqual(readdirSync(outside), []);
});

test('Codex creates empty provider-specific homes, pins file credentials and isolates all inherited CLI auth variables', async (t) => {
  const root = directory(t);
  const first = await createNativeAccount(root, codexBase, 'GPT account one');
  const second = await createNativeAccount(root, codexBase, 'GPT account two');
  for (const target of [first, second]) {
    assert.equal(target.id, `codex-account-${target.accountId}`);
    assert.equal(target.provider, 'codex');
    assert.equal(target.accountHome, join(root, 'accounts', target.accountId!));
    assert.deepEqual(target.args, codexArgs);
    assert.equal(target.commandDiscovery, 'fixed');
    assert.equal(target.enabled, false);
    assert.deepEqual(readdirSync(target.accountHome!), []);
    assert.equal(nativeAccountFingerprint(target), undefined);
  }
  assert.notEqual(first.accountHome, second.accountHome);
  const env = {
    PATH: 'system-path',
    USERPROFILE: 'system-home',
    SystemRoot: 'system-root',
    CODEX_HOME: 'inherited-home',
    CODEX_API_KEY: 'fixture-key',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'fixture-origin',
    OPENAI_API_KEY: 'fixture-key',
    OpenAI_Base_Url: 'fixture-endpoint',
    GROK_HOME: 'inherited-grok',
    GROK_AUTH_PATH: 'inherited-auth',
    XAI_API_KEY: 'fixture-key',
    ANTHROPIC_API_KEY: 'fixture-key',
    CLAUDE_CONFIG_DIR: 'inherited-claude',
  };
  const before = { ...env };
  assert.deepEqual(nativeAccountEnvironment(first, env), {
    PATH: 'system-path',
    USERPROFILE: 'system-home',
    SystemRoot: 'system-root',
    CODEX_HOME: first.accountHome,
  });
  assert.deepEqual(env, before);
  // The CLI's own login keeps its environment, except OpenAI key variables that would switch it to API billing.
  const { OPENAI_API_KEY: _openAiKey, CODEX_API_KEY: _codexKey, ...subscriptionOnly } = before;
  assert.deepEqual(
    nativeAccountEnvironment(codexBase, env),
    subscriptionOnly,
    'the existing Codex account is unchanged',
  );
  assert.throws(() => nativeAccountEnvironment({ ...first, id: `grok-account-${first.accountId}` }, env), /目录无效/);
});

test('new managed Codex profiles follow an automatic base CLI while preserving fixed custom bases', async (t) => {
  const root = directory(t);
  for (const mode of ['auto', 'fixed', undefined] as const) {
    const source = { ...codexBase, commandDiscovery: mode },
      before = structuredClone(source),
      managed = await createNativeAccount(root, source, 'Synthetic account');
    assert.equal(managed.commandDiscovery, mode === 'auto' ? 'auto' : 'fixed');
    assert.equal(managed.command, source.command);
    assert.deepEqual(managed.args, codexArgs);
    assert.equal(managed.enabled, false);
    assert.deepEqual(readdirSync(managed.accountHome!), []);
    assert.deepEqual(source, before);
  }
});

test('Codex fingerprints official account IDs, remain stable through token refresh and reject conflicts or other authentication modes', async (t) => {
  const first = await createNativeAccount(directory(t), codexBase, 'GPT account');
  const path = join(first.accountHome!, 'auth.json');
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  const auth = (tokens: Record<string, unknown>, other: Record<string, unknown> = {}) => ({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens,
    ...other,
  });
  write(
    auth({
      account_id: 'fixture-account-one',
      id_token: idToken('fixture-account-one'),
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
    }),
  );
  const expected = nativeAccountFingerprint(first);
  assert.match(expected!, /^[0-9a-f]{64}$/);
  for (const tokens of [
    { account_id: 'fixture-account-one' },
    { id_token: idToken('fixture-account-one') },
    {
      account_id: 'fixture-account-one',
      id_token: idToken('fixture-account-one', { chatgpt_user_id: 'fixture-user', chatgpt_plan_type: 'pro' }),
      access_token: 'fixture-refreshed-access',
      refresh_token: 'fixture-refreshed-token',
    },
  ]) {
    write(auth(tokens));
    assert.equal(nativeAccountFingerprint(first), expected);
  }
  write({ tokens: { account_id: 'fixture-account-one', id_token: idToken('fixture-account-one') } });
  assert.equal(nativeAccountFingerprint(first), expected, 'legacy ChatGPT files may omit auth_mode');
  write(auth({ account_id: 'fixture-account-two', id_token: idToken('fixture-account-two') }));
  assert.notEqual(nativeAccountFingerprint(first), expected);
  for (const invalid of [
    auth({ account_id: 'fixture-account-one', id_token: idToken('fixture-account-two') }),
    auth({ account_id: 'fixture-account-one', id_token: 'malformed-token' }),
    auth({ account_id: 'fixture-account-one', id_token: { chatgpt_account_id: 'fixture-account-one' } }),
    auth({ account_id: 'fixture-account-one' }, { auth_mode: 'apikey' }),
    auth({ account_id: 'fixture-account-one' }, { auth_mode: 'future-auth-mode' }),
    auth({ account_id: 'fixture-account-one' }, { OPENAI_API_KEY: 'fixture-api-key' }),
    auth({ account_id: ' invalid-whitespace ' }),
    auth({ id_token: idToken(undefined, { email: 'fixture@example.invalid', chatgpt_user_id: 'fixture-user-only' }) }),
    auth({ access_token: 'fixture-token-only', refresh_token: 'fixture-refresh-only' }),
  ]) {
    write(invalid);
    assert.equal(nativeAccountFingerprint(first), undefined);
  }
  writeFileSync(path, ' '.repeat(256 * 1024 + 1));
  assert.equal(nativeAccountFingerprint(first), undefined);
});

test('default native Codex discovery respects CODEX_HOME and never reads a Grok auth override or imports credentials', (t) => {
  const root = directory(t),
    ordinaryHome = join(root, '.codex'),
    configuredHome = join(root, 'separate-codex');
  mkdirSync(ordinaryHome);
  mkdirSync(configuredHome);
  const ordinaryFile = join(ordinaryHome, 'auth.json'),
    configuredFile = join(configuredHome, 'auth.json');
  const first = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: 'fixture-one', id_token: idToken('fixture-one') },
  });
  const second = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: 'fixture-two', id_token: idToken('fixture-two') },
  });
  writeFileSync(ordinaryFile, first);
  writeFileSync(configuredFile, second);
  const env = { USERPROFILE: root, HOME: root };
  const overridden = { ...env, CODEX_HOME: configuredHome, GROK_AUTH_PATH: ordinaryFile };
  assert.equal(defaultNativeAccountHome(codexBase, env), ordinaryHome);
  assert.equal(defaultNativeAccountHome(codexBase, overridden), configuredHome);
  const initial = defaultNativeAccountFingerprint(codexBase, env);
  const configured = defaultNativeAccountFingerprint(codexBase, overridden);
  assert.match(initial!, /^[0-9a-f]{64}$/);
  assert.match(configured!, /^[0-9a-f]{64}$/);
  assert.notEqual(initial, configured);
  assert.equal(readFileSync(ordinaryFile, 'utf8'), first);
  assert.equal(readFileSync(configuredFile, 'utf8'), second);
  assert.equal(defaultGrokAccountFingerprint(codexBase, env), undefined);
  assert.equal(defaultNativeAccountHome(base, env), defaultGrokHome(env));
  for (const target of [
    { ...codexBase, id: 'other' },
    { ...codexBase, accountId: 'managed' },
    { ...codexBase, environment: 'wsl' as const },
    { ...base, provider: 'claude' as const },
  ]) {
    assert.equal(defaultNativeAccountHome(target, env), undefined);
    assert.equal(defaultNativeAccountFingerprint(target, env), undefined);
  }
});

test(
  'Codex login uses device auth with the same forced file-store flags and the existing lifecycle lock',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const target = await createNativeAccount(directory(t), codexBase, 'GPT account');
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const child = new EventEmitter() as ChildProcess;
    let ready!: () => void;
    const started = new Promise<void>((done) => {
      ready = done;
    });
    const opening = launchAccountLogin(target, (command, args, options) => {
      invocation = { command, args, options };
      ready();
      return child;
    });
    assert.equal(nativeAccountLoginPending(target), true);
    await assert.rejects(
      launchAccountLogin(target, () => {
        throw new Error('duplicate login');
      }),
      /登录仍在进行/,
    );
    await started;
    child.emit('close', 0);
    await opening;
    assert.equal(invocation!.options.env!.CODEX_HOME, target.accountHome);
    assert.equal(invocation!.options.env!.GROK_HOME, undefined);
    const helper = Buffer.from(invocation!.args.at(-1)!, 'base64').toString('utf16le');
    const encodedScript = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(helper)![1];
    const script = Buffer.from(encodedScript, 'base64').toString('utf16le');
    assert.ok(
      script.includes(
        "'-c' 'cli_auth_credentials_store=\"file\"' '-c' 'forced_login_method=\"chatgpt\"' 'login' '--device-auth'",
      ),
    );
    assert.ok(!script.includes('--leader-socket'));
    assert.ok(!script.includes('logout'));
    assert.ok(script.includes("finally { [void](Set-LoginPhase 'finished') }"));
    const file = join(target.accountHome!, '.comborunner-login.json');
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), phase: 'finished', pid: process.pid }),
    );
    assert.equal(nativeAccountLoginPending(target), false);
  },
);

test('fingerprint uses stable official identity, survives token refresh and rejects ambiguous identities', async (t) => {
  const root = directory(t);
  const first = await createNativeAccount(root, base, 'Account one');
  const second = await createNativeAccount(root, base, 'Account two');
  const write = (target: RuntimeTarget, entries: unknown) =>
    writeFileSync(join(target.accountHome!, 'auth.json'), JSON.stringify(entries));
  const session = {
    auth_mode: 'web_login',
    user_id: 'fixture-person-one',
    email: 'one@example.invalid',
    key: 'fixture-token-one',
  };
  write(first, { 'https://accounts.x.ai/sign-in': session });
  const fingerprint = nativeAccountFingerprint(first);
  assert.match(fingerprint!, /^[0-9a-f]{64}$/);
  assert.ok(!fingerprint!.includes(session.user_id));
  write(second, {
    'https://accounts.x.ai/sign-in': {
      ...session,
      key: 'fixture-refreshed-token',
      refresh_token: 'fixture-refresh',
      email: 'renamed@example.invalid',
    },
  });
  assert.equal(nativeAccountFingerprint(second), fingerprint);
  write(second, { login: { ...session, user_id: 'fixture-person-two' } });
  assert.notEqual(nativeAccountFingerprint(second), fingerprint);
  write(second, { login: session, other: { ...session, user_id: 'fixture-person-two' } });
  assert.equal(nativeAccountFingerprint(second), undefined);
  write(second, { login: session, legacy: { ...session, auth_mode: 'grok' } });
  assert.equal(nativeAccountFingerprint(second), fingerprint);
  write(first, { login: { auth_mode: 'web_login', email: ' One@Example.Invalid ' } });
  write(second, { login: { auth_mode: 'web_login', email: 'one@example.invalid' } });
  assert.equal(nativeAccountFingerprint(first), nativeAccountFingerprint(second));
  assert.match(nativeAccountFingerprint(first)!, /^[0-9a-f]{64}$/);
  for (const entries of [
    { login: { auth_mode: 'web_login', key: 'fixture-token-only' } },
    { api: { auth_mode: 'api_key', user_id: 'fixture-person-one', key: 'fixture-api-key' } },
    { unknown: { auth_mode: 'future-mode', user_id: 'fixture-person-one' } },
    [],
  ]) {
    write(second, entries);
    assert.equal(nativeAccountFingerprint(second), undefined);
  }
  assert.equal(nativeAccountFingerprint(base), undefined);
});

test('fingerprint refuses oversized, malformed and linked credential files', async (t) => {
  const target = await createNativeAccount(directory(t), base, 'Account');
  const auth = join(target.accountHome!, 'auth.json');
  writeFileSync(auth, '{broken');
  assert.equal(nativeAccountFingerprint(target), undefined);
  writeFileSync(auth, ' '.repeat(256 * 1024 + 1));
  assert.equal(nativeAccountFingerprint(target), undefined);
  unlinkSync(auth);
  const external = join(dirname(target.accountHome!), 'external-fixture.json');
  writeFileSync(external, JSON.stringify({ login: { auth_mode: 'web_login', user_id: 'fixture-person' } }));
  linkSync(external, auth);
  assert.equal(nativeAccountFingerprint(target), undefined);
});

test('existing Grok profile discovery respects home and auth overrides without modifying credentials', (t) => {
  const root = directory(t);
  const ordinaryHome = join(root, '.grok');
  const configuredHome = join(root, 'configured-home');
  mkdirSync(ordinaryHome);
  mkdirSync(configuredHome);
  const ordinaryAuth = join(ordinaryHome, 'auth.json');
  const configuredAuth = join(configuredHome, 'auth.json');
  const explicitAuth = join(root, 'alternate-auth.json');
  const fixture = (identity: string) =>
    JSON.stringify({ login: { auth_mode: 'web_login', user_id: identity, key: 'fixture-token' } });
  writeFileSync(ordinaryAuth, fixture('fixture-one'));
  writeFileSync(configuredAuth, fixture('fixture-two'));
  writeFileSync(explicitAuth, fixture('fixture-three'));
  const env = { USERPROFILE: root, HOME: root };
  assert.equal(defaultGrokHome(env), ordinaryHome);
  assert.equal(defaultGrokHome({ ...env, GROK_HOME: configuredHome }), configuredHome);
  const ordinary = defaultGrokAccountFingerprint(base, env);
  const configured = defaultGrokAccountFingerprint(base, { ...env, GROK_HOME: configuredHome });
  const overrideEnv = { ...env, GROK_HOME: configuredHome, GROK_AUTH_PATH: explicitAuth };
  const before = { ...overrideEnv };
  const overridden = defaultGrokAccountFingerprint(base, overrideEnv);
  for (const value of [ordinary, configured, overridden]) assert.match(value!, /^[0-9a-f]{64}$/);
  assert.equal(new Set([ordinary, configured, overridden]).size, 3);
  assert.deepEqual(overrideEnv, before);
  assert.equal(readFileSync(explicitAuth, 'utf8'), fixture('fixture-three'));
  assert.equal(defaultGrokAccountFingerprint(base, { ...env, GROK_AUTH_PATH: join(root, 'missing.json') }), undefined);
  for (const target of [
    { ...base, id: 'other' },
    { ...base, environment: 'wsl' as const },
    { ...base, provider: 'codex' as const },
    { ...base, accountId: 'managed-account' },
  ]) {
    assert.equal(defaultGrokAccountFingerprint(target, env), undefined);
  }
  const linkedParent = join(root, 'linked-home');
  symlinkSync(configuredHome, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(defaultGrokAccountFingerprint(base, { ...env, GROK_HOME: linkedParent }), undefined);
});

test(
  'login opens an interactive console through a hidden helper without redirecting its standard streams',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const target = await createNativeAccount(directory(t), base, 'Account');
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const result = await launchAccountLogin(target, (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('close', 0);
      });
      return child;
    });
    assert.deepEqual(result, { opened: true });
    assert.match(invocation!.command, /powershell\.exe$/i);
    assert.deepEqual(invocation!.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const helper = Buffer.from(invocation!.args.at(-1)!, 'base64').toString('utf16le');
    assert.ok(helper.includes('Start-Process -FilePath'));
    assert.ok(helper.includes('-WindowStyle Normal'));
    assert.ok(helper.includes('-PassThru'));
    assert.ok(helper.includes('$opened.Id'));
    assert.ok(helper.includes("'-NoExit'"));
    assert.ok(!/Redirect|NoNewWindow|UseNewEnvironment/.test(helper));
    const encodedScript = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(helper)![1];
    const script = Buffer.from(encodedScript, 'base64').toString('utf16le');
    assert.ok(script.includes("'login' '--device-auth'"));
    assert.ok(script.includes("finally { [void](Set-LoginPhase 'finished') }"));
    assert.ok(script.includes('$state.nonce -ne $loginNonce'));
    assert.ok(script.includes('$state.pid = $PID'));
    assert.ok(script.includes('[System.IO.File]::Replace'));
    assert.ok(invocation!.args.join(' ').length < 30_000, 'the real helper must fit Windows command-line limits');
    const parseOnly =
      "$ErrorActionPreference = 'Stop'\n$sources = [Console]::In.ReadToEnd() | ConvertFrom-Json\nforeach ($source in $sources) { $tokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { throw 'Generated PowerShell syntax is invalid' } }";
    // Hosted Windows runners can exceed ten seconds on a cold PowerShell start.
    // This subprocess only parses the two generated sources; it never runs a login.
    execFileSync(
      invocation!.command,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parseOnly, 'utf16le').toString('base64')],
      { input: JSON.stringify([helper, script]), windowsHide: true, stdio: 'pipe', timeout: 30_000 },
    );
    assert.ok(script.includes(join(target.accountHome!, 'leader.sock')));
    assert.ok(!script.includes('logout'));
    assert.ok(!script.includes('previous-profile-config'));
    assert.equal(invocation!.options.cwd, target.accountHome);
    assert.equal(invocation!.options.windowsHide, true);
    assert.equal(invocation!.options.detached, false);
    assert.equal(invocation!.options.shell, false);
    assert.equal(invocation!.options.env!.GROK_HOME, target.accountHome);
    assert.equal(invocation!.options.env!.GROK_AUTH_PATH, join(target.accountHome!, 'auth.json'));
  },
);

test(
  'Windows PowerShell 5.1 really runs the generated login script through running and finished with a local fake executable',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = directory(t);
    const executable = join(root, 'login-state-probe.exe');
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const source = `using System;
using System.IO;
public class LoginStateProbe {
  public static int Main(string[] args) {
    var home = Environment.GetEnvironmentVariable("COMBORUNNER_LOGIN_FIXTURE_HOME");
    File.Copy(Path.Combine(home, ".comborunner-login.json"), Path.Combine(home, "observed-running.json"), true);
    File.WriteAllLines(Path.Combine(home, "observed-arguments.txt"), args);
    return 0;
  }
}`;
    const sourceFile = join(root, 'LoginStateProbe.cs');
    writeFileSync(sourceFile, source);
    const compiler = join(
      process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    );
    // Compiling only builds the probe; this test does not measure it. A cold csc.exe on a busy hosted runner has
    // taken over 20 s, so the limit only stops a hung compiler from holding the shard.
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, sourceFile], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 120_000,
    });
    for (const original of [base, codexBase]) {
      const target = await createNativeAccount(
        root,
        { ...original, command: executable },
        `${original.provider} fixture`,
      );
      let invocation: { args: string[]; options: SpawnOptions } | undefined;
      await launchAccountLogin(target, (_command, args, options) => {
        invocation = { args, options };
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });
      const marker = join(target.accountHome!, '.comborunner-login.json');
      const initial = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(initial.phase, 'starting');
      const helper = Buffer.from(invocation!.args.at(-1)!, 'base64').toString('utf16le');
      const generatedScript = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(helper)![1];
      // Execute the unmodified generated script, not merely Parser.ParseInput. The
      // only executable it can call is the temporary probe compiled above.
      // Like the parse-only check, allow a cold PowerShell/.NET startup under the
      // full suite's Windows memory pressure. This tests the actual state transitions,
      // not login latency; every running/finished/nonce/PID assertion below still applies.
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', generatedScript], {
        cwd: target.accountHome,
        env: { ...invocation!.options.env, COMBORUNNER_LOGIN_FIXTURE_HOME: target.accountHome },
        windowsHide: true,
        stdio: 'pipe',
        timeout: 30_000,
      });
      const running = JSON.parse(readFileSync(join(target.accountHome!, 'observed-running.json'), 'utf8'));
      const finished = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(running.phase, 'running', 'the fake CLI must observe the successfully replaced running marker');
      assert.equal(finished.phase, 'finished', 'finally must really replace the marker after the CLI exits');
      assert.equal(running.nonce, initial.nonce);
      assert.equal(finished.nonce, initial.nonce);
      assert.ok(Number.isSafeInteger(running.pid) && running.pid > 0 && running.pid !== process.pid);
      assert.equal(finished.pid, running.pid);
      assert.equal(nativeAccountLoginPending(target), false);
      const actualArgs = readFileSync(join(target.accountHome!, 'observed-arguments.txt'), 'utf8')
        .trim()
        .split(/\r?\n/);
      assert.deepEqual(actualArgs.slice(-2), ['login', '--device-auth']);
      if (target.provider === 'codex') {
        assert.ok(
          actualArgs.includes('cli_auth_credentials_store=file') ||
            actualArgs.includes('cli_auth_credentials_store="file"'),
        );
        assert.ok(
          actualArgs.includes('forced_login_method=chatgpt') || actualArgs.includes('forced_login_method="chatgpt"'),
        );
      } else assert.deepEqual(actualArgs.slice(0, 2), ['--leader-socket', join(target.accountHome!, 'leader.sock')]);
    }
  },
);

test(
  'terminal launch failures return a fixed error without leaking subprocess details',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const target = await createNativeAccount(directory(t), base, 'Account');
    await assert.rejects(
      launchAccountLogin(target, () => {
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() => child.emit('error', new Error('fixture-sensitive-detail')));
        return child;
      }),
      (error) => error instanceof Error && error.message === '无法打开独立账号登录终端。',
    );
    await assert.rejects(
      launchAccountLogin(target, () => {
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('close', 1);
        });
        return child;
      }),
      /无法打开独立账号登录终端/,
    );
    assert.equal(nativeAccountLoginPending(target), false);
  },
);

test('login status survives reconstruction, follows actual process liveness and never uses elapsed time as success', async (t) => {
  const target = await createNativeAccount(directory(t), base, 'Account');
  const file = join(target.accountHome!, '.comborunner-login.json');
  const nonce = '11111111-1111-4111-8111-111111111111';
  const state = { version: 1, nonce, phase: 'starting', ownerPid: process.pid, helperPid: 0, pid: 0 };
  const write = (patch: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...state, ...patch }));
  assert.equal(nativeAccountLoginPending(target), false);
  assert.equal(nativeAccountLoginPending(base), false);
  assert.equal(nativeAccountLoginPending({ ...target, accountHome: 'synthetic-non-account-home' }), false);
  write({});
  assert.equal(nativeAccountLoginPending(target), true, 'an initial launch owned by a live process remains locked');
  write({ phase: 'running', pid: process.pid, observedAt: '2000-01-01T00:00:00Z' });
  assert.equal(
    nativeAccountLoginPending(structuredClone(target)),
    true,
    'a reconstructed target is locked even if a timestamp is old',
  );
  write({ phase: 'finished', pid: process.pid });
  assert.equal(nativeAccountLoginPending(target), false, 'a completed login may leave its console open');
  write({ phase: 'running', pid: 2_147_483_647 });
  assert.equal(nativeAccountLoginPending(target), false, 'force-closing the terminal is recoverable without finally');
  write({ helperPid: 2_147_483_647 });
  assert.equal(
    nativeAccountLoginPending(target),
    false,
    'a helper that exited before opening a terminal does not leave a permanent lock',
  );
  const pidFile = join(target.accountHome!, `.comborunner-login-${nonce}.pid`);
  writeFileSync(pidFile, String(process.pid));
  assert.equal(
    nativeAccountLoginPending(target),
    true,
    'the helper records the terminal before exiting, covering startup before running is written',
  );
  writeFileSync(pidFile, '2147483647');
  assert.equal(nativeAccountLoginPending(target), false);
  write({});
  writeFileSync(join(target.accountHome!, `.comborunner-login-${nonce}.helper.pid`), '2147483647');
  assert.equal(
    nativeAccountLoginPending(target),
    false,
    'a completed helper sidecar overrides the still-live application owner',
  );
  writeFileSync(file, '{malformed');
  assert.equal(nativeAccountLoginPending(target), true, 'an unreadable marker never authorizes execution');
});

test(
  'a second login is refused while the first is launching; completion permits a new isolated login',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const target = await createNativeAccount(directory(t), base, 'Account');
    const child = new EventEmitter() as ChildProcess;
    const launched = launchAccountLogin(target, () => child);
    assert.equal(nativeAccountLoginPending(target), true);
    await assert.rejects(
      launchAccountLogin(target, () => {
        throw new Error('a duplicate must never launch');
      }),
      /登录仍在进行/,
    );
    child.emit('close', 0);
    await launched;
    const file = join(target.accountHome!, '.comborunner-login.json');
    const first = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...first, phase: 'finished', pid: process.pid }));
    assert.equal(nativeAccountLoginPending(target), false);
    const reopened = await launchAccountLogin(target, () => {
      const replacement = new EventEmitter() as ChildProcess;
      const second = JSON.parse(readFileSync(file, 'utf8'));
      assert.notEqual(second.nonce, first.nonce);
      writeFileSync(file, JSON.stringify({ ...second, phase: 'finished', pid: process.pid }));
      queueMicrotask(() => replacement.emit('close', 0));
      return replacement;
    });
    assert.deepEqual(reopened, { opened: true });
    assert.equal(nativeAccountLoginPending(target), false);
  },
);
