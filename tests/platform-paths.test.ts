import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CLASSES,
  RESERVED,
  classOf,
  classify,
  globToRegExp,
  parseChanges,
  unquote,
} from '../scripts/platform-paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/platform-paths.mjs', import.meta.url));

const examples: Record<string, string[]> = {
  windows: [
    'src/server/platform/powershell.ts',
    'src/electron/windows-backend-guard.ts',
    'src/electron/taskbar-identity.ts',
    'src/server/sandbox/mxc-runtime.ts',
    'launchers/Start-Web.cmd',
    'launchers/Start-PugPort.vbs',
    'Start-PugPort.cmd',
    'bin/pugport.cmd',
    'Setup-Windows.ps1',
    'scripts/create-windows-launcher.mjs',
    'scripts/create-windows-launcher.d.mts',
    'tests/windows-launcher.test.ts',
    'tests/platform-windows-pins.test.ts',
  ],
  mac: [
    'launchers/setup-macos.sh',
    'launchers/start-macos.command',
    'scripts/laya-mac-bench.py',
    'tests/macos-account-login.test.ts',
    'services/laya-cloud/deploy/com.pugport.laya.plist',
  ],
  posix: [
    'src/server/platform/posix-task.ts',
    'src/electron/posix-backend-guard.ts',
    'tests/posix-backend-guard.test.ts',
  ],
  linux: ['launchers/start-linux.sh'],
  'platform-core': [
    'src/server/platform/host.ts',
    'src/server/platform/dirs.ts',
    'src/server/platform/executables.ts',
    'src/server/platform/trash.ts',
    'src/server/platform/protected-roots.ts',
    'src/server/platform/terminal-path.ts',
    'src/server/platform/service.ts',
    'tests/helpers/fake-host.ts',
  ],
  'docs-only': [
    'docs/PLATFORMS.md',
    'docs/validation/assets/run/screen.png',
    'docs/references/botverse-jev/LICENSE',
    'README.md',
    'AGENTS.md',
    'launchers/README.md',
    '.github/CONTRIBUTING.md',
  ],
  shared: [
    'src/server/controller.ts',
    'src/server/platform/secure-file.ts',
    'src/server/platform/hosts.ts',
    'src/server/platform/darwin/dock.ts',
    'src/server/sandbox/execution.ts',
    'scripts/machine-load-bench.mjs',
    'scripts/platform-paths.mjs',
    'tests/platform-posix.test.ts',
    'tests/sandbox-mxc-child.test.ts',
    'tests/fixtures/notes.md',
    'docs/examples/mods/reading-notes/manifest.json',
    'docs/DEPENDENCY-LICENSES.json',
    'THIRD_PARTY_NOTICES.md',
    'assets/skills/skill-doctor/SKILL.md',
    'licenses/npm/sharp-libvips-1.3.4/upstream-darwin-arm64-README.md',
    'package.json',
  ],
};

test('each class takes its own paths; the first matching class wins', () => {
  assert.deepEqual(
    Object.keys(examples),
    CLASSES.map((entry) => entry.name),
  );
  for (const [name, paths] of Object.entries(examples))
    for (const path of paths) assert.equal(classOf(path), name, path);
  assert.equal(classOf('LAUNCHERS/START-WEB.CMD'), 'windows');
  assert.equal(classOf('launchers/Setup-MacOS.sh'), 'mac');
});

test('each class needs the documented OS checks', () => {
  const checks = Object.fromEntries(CLASSES.map((entry) => [entry.name, classify(examples[entry.name]).checks]));
  assert.deepEqual(checks, {
    windows: ['windows'],
    mac: ['macos'],
    posix: ['macos', 'linux'],
    linux: ['linux'],
    'platform-core': ['windows', 'macos'],
    'docs-only': [],
    shared: ['windows', 'macos'],
  });
});

test('every class pattern still matches a tracked file it owns, except the reserved ones', (t) => {
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    t.skip('git ls-files is unavailable (not a Git checkout)');
    return;
  }
  const expand = (glob: string): string[] => {
    const brace = /\{([^{}]*)\}/.exec(glob);
    return brace ? brace[1].split(',').flatMap((option) => expand(glob.replace(brace[0], option))) : [glob];
  };
  for (const entry of CLASSES)
    for (const pattern of entry.patterns.flatMap(expand)) {
      const owned = tracked.filter((file) => globToRegExp(pattern).test(file) && classOf(file) === entry.name);
      assert.equal(owned.length > 0, !RESERVED.includes(pattern), `${entry.name}: ${pattern}`);
    }
});

test('globs: * stays in a folder, ** crosses folders, braces choose, dots are literal', () => {
  assert.equal(globToRegExp('tests/windows-*.test.ts').test('tests/windows-a.test.ts'), true);
  assert.equal(globToRegExp('tests/windows-*.test.ts').test('tests/x/windows-a.test.ts'), false);
  assert.equal(globToRegExp('launchers/*.cmd').test('launchers/sub/a.cmd'), false);
  assert.equal(globToRegExp('**/*.md').test('README.md'), true);
  assert.equal(globToRegExp('**/*.md').test('a/b/c.md'), true);
  assert.equal(globToRegExp('docs/**').test('docs/a/b/c.png'), true);
  assert.equal(globToRegExp('docs/**').test('docsx/a.md'), false);
  assert.equal(globToRegExp('src/{a,b}.ts').test('src/b.ts'), true);
  assert.equal(globToRegExp('src/{a,b}.ts').test('src/c.ts'), false);
  assert.equal(globToRegExp('scripts/create-windows-launcher.*').test('scripts/create-windows-launcherXmjs'), false);
  assert.equal(globToRegExp('a,b').test('a,b'), true);
});

test('mixed changes need every check their classes need', () => {
  assert.deepEqual(classify(['launchers/setup-macos.sh', 'docs/MAC-PORT.md']), {
    classes: ['mac', 'docs-only'],
    checks: ['macos'],
    files: [
      { path: 'launchers/setup-macos.sh', class: 'mac' },
      { path: 'docs/MAC-PORT.md', class: 'docs-only' },
    ],
  });
  assert.deepEqual(classify(['Setup-Windows.ps1', 'src/server/platform/posix-task.ts']).checks, [
    'windows',
    'macos',
    'linux',
  ]);
  assert.deepEqual(classify(['src/server/controller.ts', 'launchers/Start-Web.cmd']).classes, ['windows', 'shared']);
  assert.deepEqual(classify(['docs/PLATFORMS.md', 'README.md', 'README.md']), {
    classes: ['docs-only'],
    checks: [],
    files: [
      { path: 'docs/PLATFORMS.md', class: 'docs-only' },
      { path: 'README.md', class: 'docs-only' },
    ],
  });
  assert.deepEqual(classify([]), { classes: [], checks: [], files: [] });
});

test('renamed, copied and deleted paths classify both sides by name, without touching the disk', () => {
  const changes = [
    'R087\ttests/windows-launcher.test.ts\ttests/launcher.test.ts',
    'D\tlaunchers/no-longer-here-macos.sh',
    'C100\tsrc/server/platform/posix-task.ts\tsrc/server/platform/posix-group.ts',
    'M\tdocs/PLATFORMS.md',
    'A\t"docs/caf\\303\\251 \\"draft\\".md"',
    '',
  ].join('\r\n');
  const paths = parseChanges(changes);
  assert.deepEqual(paths, [
    'tests/windows-launcher.test.ts',
    'tests/launcher.test.ts',
    'launchers/no-longer-here-macos.sh',
    'src/server/platform/posix-task.ts',
    'src/server/platform/posix-group.ts',
    'docs/PLATFORMS.md',
    'docs/café "draft".md',
  ]);
  assert.deepEqual(classify(paths).classes, ['windows', 'mac', 'posix', 'docs-only', 'shared']);
  assert.deepEqual(classify(parseChanges('D\tlaunchers/Start-Pi.cmd')).checks, ['windows']);
  assert.deepEqual(classify(parseChanges('R100\tlaunchers/a.cmd\tlaunchers/b.cmd')).classes, ['windows']);
  assert.deepEqual(classify(parseChanges('R100\tlaunchers/Start-Web.cmd\tsrc/server/web.ts')).checks, [
    'windows',
    'macos',
  ]);
});

test('Windows separators, ./ prefixes and git quoting are normalised', () => {
  assert.deepEqual(classify(['.\\launchers\\Start-Web.cmd', './docs//PLATFORMS.md', '  ']).files, [
    { path: 'launchers/Start-Web.cmd', class: 'windows' },
    { path: 'docs/PLATFORMS.md', class: 'docs-only' },
  ]);
  assert.equal(unquote('plain/path.md'), 'plain/path.md');
  assert.equal(unquote('"tab\\there\\\\x"'), 'tab\there\\x');
  assert.deepEqual(parseChanges('"src/\\346\\226\\207.ts"\nlaunchers/Start-Pi.cmd'), [
    'src/文.ts',
    'launchers/Start-Pi.cmd',
  ]);
});

test('the CLI prints JSON for paths from stdin or from its arguments', () => {
  const fromStdin = spawnSync(process.execPath, [script], {
    input: 'M\tlaunchers/setup-macos.sh\nR090\tSetup-Windows.ps1\tdocs/setup.md\n',
    encoding: 'utf8',
  });
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.deepEqual(JSON.parse(fromStdin.stdout), {
    classes: ['windows', 'mac', 'docs-only'],
    checks: ['windows', 'macos'],
    files: [
      { path: 'launchers/setup-macos.sh', class: 'mac' },
      { path: 'Setup-Windows.ps1', class: 'windows' },
      { path: 'docs/setup.md', class: 'docs-only' },
    ],
  });
  const fromArgs = spawnSync(process.execPath, [script, 'tests/helpers/fake-host.ts'], { encoding: 'utf8' });
  assert.equal(fromArgs.status, 0, fromArgs.stderr);
  assert.deepEqual(JSON.parse(fromArgs.stdout).classes, ['platform-core']);
  const empty = spawnSync(process.execPath, [script], { input: '', encoding: 'utf8' });
  assert.deepEqual(JSON.parse(empty.stdout), { classes: [], checks: [], files: [] });
});
