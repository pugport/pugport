import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addMissingCursorTarget,
  defaultTargets,
  findCursorExecutable,
  findExecutable,
  refreshManagedTargets,
} from '../src/server/discovery.ts';
import { accountSnapshot } from '../src/server/accounting.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import type { RuntimeTarget, RuntimeSnapshot } from '../src/shared/types.ts';
const directory = join(tmpdir(), 'studio-managed-codex');

test('discovery ignores installed Gemini and Antigravity executables and the Gemini npm bundle', (t) => {
  const f = managedFixture(t);
  const bin = join(f.root, 'bin');
  for (const name of ['gemini', 'agy', 'node'])
    f.binary(join(bin, name + (process.platform === 'win32' ? '.exe' : '')));
  f.binary(join(f.root, 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'));
  environment(t, {
    ...process.env,
    HOME: f.root,
    USERPROFILE: f.root,
    APPDATA: f.root,
    LOCALAPPDATA: f.root,
    PATH: bin,
  });
  const targets = defaultTargets();
  assert.ok(targets.length > 0);
  assert.ok(targets.every((target) => target.provider !== 'gemini' && !/gemini|agy/i.test(target.command)));
});
const target = (command = join(directory, 'old', 'codex.exe')): RuntimeTarget => ({
  id: 'codex-native',
  provider: 'codex',
  environment: 'native',
  enabled: true,
  label: 'Codex',
  command,
});
function managedFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-managed-codex-')),
    codexRoot = join(root, 'OpenAI', 'Codex', 'bin'),
    accountId = '12345678-1234-4234-8234-123456789abc',
    oldCommand = join(codexRoot, 'faa963e871dd422c', 'codex.exe'),
    newCommand = join(codexRoot, 'c6fe824d725f02d7', 'codex.exe');
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('comborunner-managed-codex-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const binary = (command: string) => {
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(command, 'Synthetic executable fixture; never run.');
    // macOS and Linux accept only files with execute permission (no effect on Windows).
    chmodSync(command, 0o755);
  };
  binary(newCommand);
  const managed: RuntimeTarget = {
    ...target(oldCommand),
    id: `codex-account-${accountId}`,
    accountId,
    accountHome: join(root, 'accounts', accountId),
    accountFingerprint: 'synthetic-stable-identity',
    args: ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'],
    commandDiscovery: 'fixed',
    enabled: false,
    executionDisabledByUser: true,
  };
  return { managed, root, codexRoot, oldCommand, newCommand, latest: target(newCommand), binary };
}
function environment(t: TestContext, env: NodeJS.ProcessEnv) {
  const previous = process.env;
  process.env = env;
  t.after(() => {
    process.env = previous;
  });
}
test('legacy managed Codex version paths are rediscovered after app updates', () => {
  const old = target(),
    latest = target(join(directory, 'new', 'codex.exe'));
  assert.equal(refreshManagedTargets([old], [latest], 'win32', directory), true);
  assert.equal(old.command, latest.command);
  assert.equal(old.commandDiscovery, 'auto');
  assert.equal(refreshManagedTargets([old], [latest], 'win32', directory), false);
});
test('discovery preserves custom paths, fixed commands and explicit argument lists', () => {
  const latest = target(join(directory, 'new', 'codex.exe'));
  for (const old of [
    target(join(directory, '..', 'custom', 'codex.exe')),
    { ...target(), commandDiscovery: 'fixed' as const },
    { ...target(), args: ['custom'] },
  ]) {
    const original = { ...old };
    assert.equal(refreshManagedTargets([old], [latest], 'win32', directory), false);
    assert.deepEqual(old, original);
  }
});

test('missing legacy managed Codex desktop binaries migrate without changing account isolation or enablement', (t) => {
  const f = managedFixture(t),
    before = structuredClone(f.managed),
    args = f.managed.args;
  assert.equal(refreshManagedTargets([f.managed], [f.latest], 'win32', f.codexRoot), true);
  assert.deepEqual(f.managed, { ...before, command: f.newCommand, commandDiscovery: 'auto' });
  assert.equal(f.managed.args, args);
  assert.equal(refreshManagedTargets([f.managed], [f.latest], 'win32', f.codexRoot), false);
});

test('managed Codex auto discovery follows the current binary despite required isolated arguments', (t) => {
  const f = managedFixture(t);
  f.binary(f.oldCommand);
  f.managed.commandDiscovery = 'auto';
  const before = structuredClone(f.managed);
  assert.equal(refreshManagedTargets([f.managed], [f.latest], 'win32', f.codexRoot), true);
  assert.deepEqual(f.managed, { ...before, command: f.newCommand });
});

test('managed Codex repair preserves existing fixed binaries and unrecognized custom paths', (t) => {
  const f = managedFixture(t);
  f.binary(f.oldCommand);
  for (const command of [
    f.oldCommand,
    join(f.root, 'custom', 'faa963e871dd422c', 'codex.exe'),
    join(f.codexRoot + '-custom', 'faa963e871dd422c', 'codex.exe'),
    join(f.codexRoot, 'custom', 'codex.exe'),
    join(f.codexRoot, 'faa963e871dd422c', 'nested', 'codex.exe'),
    join(f.codexRoot, 'faa963e871dd422c', 'codex.cmd'),
    join('faa963e871dd422c', 'codex.exe'),
  ]) {
    const managed = { ...f.managed, command },
      before = structuredClone(managed);
    assert.equal(refreshManagedTargets([managed], [f.latest], 'win32', f.codexRoot), false);
    assert.deepEqual(managed, before);
  }
});

test('managed Codex repair rejects absent binaries, wrappers and unrelated targets', (t) => {
  const f = managedFixture(t),
    wrapper = join(f.root, 'codex.cmd');
  f.binary(wrapper);
  for (const command of [join(f.root, 'missing', 'codex.exe'), wrapper]) {
    const before = structuredClone(f.managed);
    assert.equal(refreshManagedTargets([f.managed], [target(command)], 'win32', f.codexRoot), false);
    assert.deepEqual(f.managed, before);
  }
  for (const managed of [
    { ...f.managed, id: 'custom-codex' },
    { ...f.managed, accountId: undefined },
    { ...f.managed, environment: 'wsl' as const },
    { ...f.managed, provider: 'grok' as const },
    { ...f.managed, gateway: 'magpie' as const },
  ]) {
    const before = structuredClone(managed);
    assert.equal(refreshManagedTargets([managed], [f.latest], 'win32', f.codexRoot), false);
    assert.deepEqual(managed, before);
  }
  assert.equal(refreshManagedTargets([f.managed], [f.latest], 'linux', f.codexRoot), false);
});
test('statistical usage mode does not assert an API billing identity or invent a balance', () => {
  const snapshot = { provider: 'pi', quota: { status: 'unknown' } } as RuntimeSnapshot;
  const actual = accountSnapshot(snapshot, { ...target(), provider: 'pi' });
  assert.equal(actual.accounting?.mode, 'usage');
  assert.equal(actual.quota.status, 'unknown');
  const subscription = accountSnapshot(snapshot, { ...target(), accountingMode: 'subscription' });
  assert.equal(subscription.accounting?.mode, 'subscription');
});

test('automatic Claude discovery updates official CLI paths but preserves fixed commands and arguments', () => {
  const old: RuntimeTarget = {
    id: 'claude-native',
    provider: 'claude',
    environment: 'native',
    label: 'Claude',
    command: 'old-wrapper.cmd',
    enabled: true,
    commandDiscovery: 'auto',
  };
  const direct = { ...old, command: 'official-claude.exe' };
  assert.equal(refreshManagedTargets([old], [direct]), true);
  assert.equal(old.command, direct.command);
  for (const custom of [
    { ...old, command: 'custom.cmd', commandDiscovery: 'fixed' as const },
    { ...old, command: 'custom.cmd', args: ['custom-config'] },
  ]) {
    const before = { ...custom };
    assert.equal(refreshManagedTargets([custom], [direct]), false);
    assert.deepEqual(custom, before);
  }
});

test('Cursor is added once to saved installations and discovery preserves custom commands and disabled state', () => {
  const cursor: RuntimeTarget = {
    id: 'cursor-native',
    provider: 'cursor',
    label: 'Cursor',
    command: 'official-cursor-agent.cmd',
    commandDiscovery: 'auto',
    environment: 'native',
    enabled: true,
  };
  const targets = [target('custom-codex.exe')];
  assert.equal(addMissingCursorTarget(targets, [cursor]), true);
  assert.equal(targets.length, 2);
  assert.equal(addMissingCursorTarget(targets, [cursor]), false);
  assert.equal(refreshManagedTargets([target('fixture-codex')], [cursor]), false);
  const stored = targets[1]!;
  stored.enabled = false;
  stored.executionDisabledByUser = true;
  assert.equal(refreshManagedTargets(targets, [{ ...cursor, command: 'new-cursor-agent.cmd' }]), true);
  assert.equal(stored.command, 'new-cursor-agent.cmd');
  assert.equal(stored.enabled, false);
  assert.equal(stored.executionDisabledByUser, true);
  for (const custom of [
    { ...stored, commandDiscovery: 'fixed' as const },
    { ...stored, args: ['custom'] },
    { ...stored, gateway: 'api' as const },
  ]) {
    const before = structuredClone(custom);
    assert.equal(refreshManagedTargets([custom], [cursor]), false);
    assert.deepEqual(custom, before);
  }
  assert.notEqual(cursor.command, 'agent');
});

test('failed rediscovery keeps installed native launchers and their saved state', (t) => {
  const f = managedFixture(t);
  for (const [provider, fallback] of [
    ['cursor', 'cursor-agent'],
    ['claude', 'claude'],
    ['codex', 'codex'],
  ] as const) {
    const command = join(f.root, 'installed with spaces', `${fallback}.cmd`);
    f.binary(command);
    const saved: RuntimeTarget = {
      ...target(command),
      id: `${provider}-native`,
      provider,
      commandDiscovery: 'auto',
      enabled: false,
      executionDisabledByUser: true,
    };
    for (const unavailable of [fallback, join(f.root, 'disappeared', `${fallback}.exe`)]) {
      const before = structuredClone(saved);
      assert.equal(refreshManagedTargets([saved], [{ ...saved, command: unavailable }]), false);
      assert.deepEqual(saved, before);
    }
    const updated = join(f.root, 'new installed version', `${fallback}.cmd`);
    f.binary(updated);
    assert.equal(refreshManagedTargets([saved], [{ ...saved, command: updated }]), true);
    assert.equal(saved.command, updated);
    assert.equal(saved.enabled, false);
    assert.equal(saved.executionDisabledByUser, true);
  }
});

test('a removed Cursor launcher can fall back and recover on a later search', (t) => {
  const f = managedFixture(t);
  const saved: RuntimeTarget = {
    ...target(join(f.root, 'removed', 'cursor-agent.cmd')),
    id: 'cursor-native',
    provider: 'cursor',
    commandDiscovery: 'auto',
  };
  assert.equal(refreshManagedTargets([saved], [{ ...saved, command: 'cursor-agent' }]), true);
  assert.equal(saved.command, 'cursor-agent');
  const command = join(f.root, 'installed', 'cursor-agent.cmd');
  f.binary(command);
  assert.equal(refreshManagedTargets([saved], [{ ...saved, command }]), true);
  assert.equal(saved.command, command);
  assert.equal(refreshManagedTargets([saved], [{ ...saved, command }]), false);
});

test('executable search supports quoted PATH entries, rejects directories and does not cache misses', (t) => {
  const f = managedFixture(t),
    name = basename(f.root),
    first = join(f.root, 'directory match'),
    second = join(f.root, 'installed with spaces'),
    extension = process.platform === 'win32' ? '.cmd' : '',
    command = join(second, name + extension);
  environment(t, { ...process.env, PATH: `"${first}"${delimiter}"${second}"` });
  assert.equal(findExecutable(name), undefined);
  mkdirSync(join(first, name + extension), { recursive: true });
  assert.equal(findExecutable(name), undefined);
  f.binary(command);
  assert.equal(findExecutable(name), command);
});

test(
  'macOS and Linux managed Codex follows a linked npm or Homebrew binary but never a non-executable file',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = managedFixture(t),
      real = join(f.root, 'Cellar', 'codex', '1.2.3', 'codex'),
      link = join(f.root, 'bin', 'codex');
    f.binary(real);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    f.managed.commandDiscovery = 'auto';
    assert.equal(refreshManagedTargets([f.managed], [target(link)], process.platform, f.codexRoot), true);
    assert.equal(f.managed.command, link, 'the link is kept, so a later upgrade is followed');
    const plain = join(f.root, 'plain', 'codex');
    mkdirSync(dirname(plain), { recursive: true });
    writeFileSync(plain, 'not executable');
    const before = structuredClone(f.managed);
    assert.equal(refreshManagedTargets([f.managed], [target(plain)], process.platform, f.codexRoot), false);
    assert.deepEqual(f.managed, before);
  },
);

test('executable search also accepts a Windows Path environment key', { skip: process.platform !== 'win32' }, (t) => {
  const f = managedFixture(t),
    name = basename(f.root),
    command = join(f.root, `${name}.cmd`);
  const env: NodeJS.ProcessEnv = { ...process.env, Path: f.root };
  delete env.PATH;
  environment(t, env);
  f.binary(command);
  assert.equal(findExecutable(name), command);
});

test(
  'Windows Cursor discovery uses the user home when LOCALAPPDATA is missing',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const f = managedFixture(t),
      command = join(f.root, 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd');
    f.binary(command);
    const discovery = new URL('../src/server/discovery.ts', import.meta.url).href;
    const result = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import {findCursorExecutable} from ${JSON.stringify(discovery)}; process.stdout.write(findCursorExecutable() || '');`,
      ],
      {
        env: { ...process.env, LOCALAPPDATA: '', USERPROFILE: f.root, HOME: f.root, PATH: '' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(result, command);
  },
);

test(
  'Windows discovers and launches Cursor cmd wrappers outside PATH, including paths with spaces',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const f = managedFixture(t),
      localAppData = join(f.root, 'Local AppData'),
      install = join(localAppData, 'cursor-agent'),
      command = join(install, 'cursor-agent.cmd');
    mkdirSync(join(install, 'cursor-agent.exe'), { recursive: true });
    writeFileSync(
      command,
      '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*\r\n',
    );
    writeFileSync(join(install, 'cursor-agent.ps1'), '[Console]::Out.WriteLine($args -join "|")\r\nexit 0\r\n');
    environment(t, { ...process.env, LOCALAPPDATA: localAppData, PATH: '' });
    assert.equal(findCursorExecutable(), command, 'prefer the installed launcher over PATH and directory matches');
    // The wrapper starts through Windows PowerShell, which a cold or busy hosted runner can delay past ten seconds;
    // the Cursor adapter's own metadata captures allow thirty.
    const result = await captureTarget({ ...target(command), id: 'cursor-native', provider: 'cursor' }, ['--version'], {
      timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), '--version');
  },
);
