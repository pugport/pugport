/**
 * Guard: direct platform checks must not spread outside src/server/platform/.
 *
 * The scan and the comparison live in scripts/platform-baseline.mjs (its --check mode runs the same checkBaseline());
 * the committed per-file counts are in tests/fixtures/platform-branch-baseline.json. What counts, deliberately:
 * - Scanned: src/**\/*.{ts,tsx,mts,mjs} except src/server/platform/, the one place platform branches belong.
 * - A hit is a source line matching one of PATTERNS: process.platform, os.platform(), a quoted 'win32' / 'darwin' /
 *   'linux', a PowerShell program name ('powershell', powershell.exe), Windows %VARIABLE% syntax, APPDATA,
 *   LOCALAPPDATA or USERPROFILE. A line counts once however many patterns it matches.
 * - Windows variable names ignore case, so env.appdata, env['UserProfile'], %AppData% and %ErrorLevel% count. Other
 *   %name% forms and the bare words count only in upper case: lower-case %x% is mostly git formats and SQL, and
 *   appData is a common identifier (Electron's app.getPath('appData') works on every system).
 * - Comments do not count: explaining a platform's behaviour is not a branch, and counting it would punish documentation.
 * - String literals do count: 'powershell.exe', '%APPDATA%' and 'win32' in strings are platform-specific code.
 * - Not counted as false positives: shell-name recognisers (/(?:cmd|powershell|pwsh)/), git formats (%H%x00),
 *   URL escapes (%3A) and SQL LIKE patterns ('%task_id%').
 * - Tests and test helpers (tests/**) are out of scope: they must branch on process.platform to skip and pass fake
 *   platforms. No test-only helper lives in src/ outside src/server/platform/ (under-test.*, test-process.ts are
 *   inside it); one added elsewhere in src/ counts like shipped code.
 * - i18n catalogs (src/shared/i18n/*.json) are not scanned: they are generated copies of source strings that are
 *   already counted where they are written.
 * A file may only lose hits. When counts drop the test passes and prints the refresh command.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BASELINE,
  ROOT,
  checkBaseline,
  compare,
  platformHits,
  readBaseline,
  scanTree,
  writeBaseline,
} from '../scripts/platform-baseline.mjs';

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

test('src/ adds no direct platform checks outside src/server/platform/', (t) => {
  const result = checkBaseline();
  if (result.hint) t.diagnostic(result.hint);
  t.diagnostic(`${result.totals.hits} hits in ${result.totals.files} files`);
  assert.ok(result.ok, result.message);
});

test('code and strings count; comments, recognisers and percent escapes do not', () => {
  const source = [
    "if (process.platform === 'win32') run();", // 1
    '// process.platform is read once at startup', // 2
    '/* on Windows we call powershell.exe and', // 3
    "   read %APPDATA% */ const os = require('os');", // 4
    'const name = os.platform();', // 5
    "spawn('powershell', ['-NoProfile']);", // 6
    "const target = `${process.env.APPDATA}\\npm`; const local = env('LOCALAPPDATA');", // 7
    "const helper = 'exit /b %errorlevel%';", // 8
    'const home = env.USERPROFILE ?? env.HOME;', // 9
    'const shell = /^(?:cmd|powershell|pwsh)(?:\\.exe)?$/i;', // 10
    "const format = '--format=%H%x00%an%x00%B';", // 11
    'const cookie = `id=${user}%3A%3A${token}`;', // 12
    "const sql = \"value LIKE '%task_id%' OR value LIKE '%backgroundTaskId%'\";", // 13
    'const label = `Platform: ${"darwin"}`;', // 14
    "const prose = 'Open PowerShell or Terminal';", // 15
    "const cmd = 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -NoProfile';", // 16
    'const roaming = process.env.appdata ?? host.env?.LocalAppData;', // 17
    "const profile = env['UserProfile'] || env?.['userprofile'];", // 18
    "const script = 'cd /d %AppData% & exit /b %ErrorLevel%';", // 19
    "const dir = join(app.getPath('appData'), 'App'); const appData = options.appData;", // 20
    "const skip = segment === 'appdata' || key.endsWith('/AppData/Local/Temp');", // 21
  ].join('\n');
  assert.deepEqual(
    platformHits(source).map((hit) => hit.line),
    [1, 5, 6, 7, 8, 9, 14, 16, 17, 18, 19],
  );
  for (const line of [
    'process.env.appdata',
    'env.localappdata',
    'env?.UserProfile',
    "env['APPDATA']",
    'env?.[`localAppData`]',
    '%appdata%',
    '%LocalAppData%',
    '%errorlevel%',
  ])
    assert.equal(platformHits(line).length, 1, line);
  for (const line of ['const appdataDir = 1;', 'environment.appdata', 'env.appdataPath', '%appdatax%', '%systemroot%'])
    assert.equal(platformHits(line).length, 0, line);
  assert.equal(platformHits(source)[0].text, "if (process.platform === 'win32') run();");
});

test('JSX text, template literals and CRLF line endings keep line numbers', () => {
  const tsx =
    "const A = () => <p>// not a comment {process.platform}</p>;\r\n// 'darwin'\r\nconst b = `\r\n'linux'`;\r\n";
  assert.deepEqual(
    platformHits(tsx, 'view.tsx').map((hit) => hit.line),
    [1, 4],
  );
  const mjs = "/** 'win32' */\nexport const isWindows = (platform) => platform === 'win32';\n";
  assert.deepEqual(
    platformHits(mjs, 'helper.mjs').map((hit) => hit.line),
    [2],
  );
});

test('the scan covers src/ only, skips src/server/platform/ and non-source files, and keys by / paths', (t) => {
  const root = tree({
    'src/server/platform/host.ts': "export const windows = process.platform === 'win32';",
    'src/server/platform/nested/x.ts': "export const mac = process.platform === 'darwin';",
    'src/server/feature.ts': "export const windows = process.platform === 'win32';\nexport const ok = 1;",
    'src/ui/View.tsx': "export const mac = (p: string) => p === 'darwin';",
    'src/cli/tool.mts': 'export const home = process.env.USERPROFILE;',
    'src/server/pi.mjs': "export const tools = ['bash', 'powershell'];",
    'src/shared/i18n/en.json': '{ "PowerShell": "%APPDATA%" }',
    'src/ui/style.css': '/* win32 */ .a { content: "win32"; }',
    'src/server/clean.ts': 'export const nothing = true;',
    'tests/feature.test.ts': "const skip = process.platform !== 'win32';",
    'scripts/build.mjs': "if (process.platform === 'win32') {}",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = scanTree(root);
  assert.deepEqual(Object.keys(found).sort(), [
    'src/cli/tool.mts',
    'src/server/feature.ts',
    'src/server/pi.mjs',
    'src/ui/View.tsx',
  ]);
  assert.deepEqual(found['src/server/feature.ts'], [
    { line: 1, text: "export const windows = process.platform === 'win32';" },
  ]);
});

test('an increase or a new file fails with the file, its lines and where the logic belongs', () => {
  const hits = (...lines: number[]) => lines.map((line) => ({ line, text: `check ${line}` }));
  const result = compare(
    { 'src/a.ts': hits(3, 9), 'src/b.ts': hits(4), 'src/new.ts': hits(12, 20) },
    { 'src/a.ts': 1, 'src/b.ts': 1 },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map(({ file, count, baseline }) => [file, count, baseline]),
    [
      ['src/a.ts', 2, 1],
      ['src/new.ts', 2, 0],
    ],
  );
  assert.match(result.message, /src\/a\.ts: 2 \(baseline 1\), lines 3, 9\n {4}3: check 3\n {4}9: check 9/);
  assert.match(result.message, /src\/new\.ts: 2 \(not in the baseline\), lines 12, 20/);
  assert.match(result.message, /Move the platform-specific logic into a helper under src\/server\/platform\//);
  assert.doesNotMatch(result.message, /src\/b\.ts/);
  assert.equal(result.hint, '');
});

test('a decrease or a removed file passes and prints how to refresh the baseline', () => {
  const result = compare({ 'src/a.ts': [{ line: 1, text: 'x' }] }, { 'src/a.ts': 3, 'src/gone.ts': 2 });
  assert.equal(result.ok, true);
  assert.equal(result.message, '');
  assert.deepEqual(
    result.decreases.map(({ file, count, baseline }) => [file, baseline, count]),
    [
      ['src/a.ts', 3, 1],
      ['src/gone.ts', 2, 0],
    ],
  );
  assert.match(result.hint, /src\/a\.ts 3 → 1, src\/gone\.ts 2 → 0/);
  assert.match(result.hint, /node scripts\/platform-baseline\.mjs --write$/);
});

test('--write lowers counts, refuses increases unless allowed, and --check exits by result', (t) => {
  const root = tree({
    'src/a.ts': "process.platform;\nprocess.platform;\n'win32';",
    'src/b.ts': "'darwin';",
    [BASELINE]: JSON.stringify({ files: { 'src/a.ts': 3, 'src/old.ts': 1 } }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/platform-baseline.mjs'), ...args, `--root=${root}`], {
      encoding: 'utf8',
    });

  let run = cli('--check');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /src\/b\.ts: 1 \(not in the baseline\), lines 1/);
  assert.match(run.stdout, /src\/old\.ts 1 → 0/);

  assert.equal(writeBaseline(root).written, false);
  run = cli('--write');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Baseline not written/);
  assert.deepEqual(readBaseline(root), { 'src/a.ts': 3, 'src/old.ts': 1 });

  writeFileSync(join(root, 'src/b.ts'), 'export {};');
  writeFileSync(join(root, 'src/a.ts'), "process.platform;\n'win32';");
  run = cli('--write');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readBaseline(root), { 'src/a.ts': 2 });
  assert.match(
    readFileSync(join(root, BASELINE), 'utf8'),
    /^\{\n {2}"about": .+\n {2}"files": \{\n {4}"src\/a\.ts": 2\n {2}\}\n\}\n$/,
  );
  assert.equal(cli('--check').status, 0);

  writeFileSync(join(root, 'src/c.ts'), "'linux';");
  assert.equal(cli('--write', '--allow-increase').status, 0);
  assert.deepEqual(readBaseline(root), { 'src/a.ts': 2, 'src/c.ts': 1 });
  assert.equal(cli('--chek').status, 2);
});
