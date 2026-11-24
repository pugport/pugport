// Which platform class each changed path belongs to, and which OS checks the change must pass (docs/PLATFORMS.md).
//   git -c core.quotePath=false diff --name-status main...HEAD | node scripts/platform-paths.mjs
//   node scripts/platform-paths.mjs launchers/setup-macos.sh src/server/controller.ts
// Reads plain paths or `git diff --name-status` lines (both sides of a rename or copy count) from the arguments or,
// without arguments, from stdin. Prints JSON: { "classes": [...], "checks": [...], "files": [{ "path", "class" }] }.
import { pathToFileURL } from 'node:url';

export const OS_CHECKS = ['windows', 'macos', 'linux'];

/**
 * First match wins. Globs: `*` stays inside one folder, `**` crosses folders, `{a,b}` is either; matching ignores
 * case. `except` patterns send a path on to the next class.
 */
export const CLASSES = [
  {
    name: 'windows',
    checks: ['windows'],
    patterns: [
      'src/server/platform/powershell.ts',
      'src/electron/windows-backend-guard.ts',
      'src/electron/taskbar-identity.ts',
      'src/server/sandbox/mxc-*',
      'launchers/*.cmd',
      'launchers/*.vbs',
      'Start-PugPort.cmd',
      'bin/*.cmd',
      'Setup-Windows.ps1',
      'scripts/create-windows-launcher.*',
      'tests/windows-*.test.ts',
      'tests/platform-windows-*.test.ts',
    ],
  },
  {
    name: 'mac',
    checks: ['macos'],
    // Not scripts/*mac*: that would also take scripts/machine-*.
    patterns: ['launchers/*macos*', 'scripts/*-mac-*', 'tests/*macos*.test.ts', '**/*.plist'],
  },
  {
    name: 'posix',
    checks: ['macos', 'linux'],
    patterns: ['src/server/platform/posix-*.ts', 'src/electron/posix-backend-guard.ts', 'tests/posix-*.test.ts'],
  },
  { name: 'linux', checks: ['linux'], patterns: ['launchers/*linux*'] },
  {
    name: 'platform-core',
    checks: ['windows', 'macos'],
    patterns: [
      'src/server/platform/{host,dirs,executables,trash,protected-roots,terminal-path,service}.ts',
      'tests/helpers/fake-host.ts',
    ],
  },
  {
    name: 'docs-only',
    checks: [],
    patterns: ['docs/**', '**/*.md'],
    // Read by tests or license checks, or shipped with the app: not documentation-only.
    except: [
      'docs/examples/**',
      'docs/*.json',
      'THIRD_PARTY_NOTICES.md',
      'assets/**',
      'licenses/**',
      'src/**',
      'tests/**',
    ],
  },
  { name: 'shared', checks: ['windows', 'macos'], patterns: ['**'] },
];

/** Patterns that match no file yet; kept so the first such file is classed correctly. Tests keep this list honest. */
export const RESERVED = ['launchers/*linux*'];

export function globToRegExp(glob) {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces) {
      braces--;
      source += ')';
    } else if (char === ',' && braces) source += '|';
    else source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

const compiled = CLASSES.map((entry) => ({
  ...entry,
  include: entry.patterns.map(globToRegExp),
  exclude: (entry.except ?? []).map(globToRegExp),
}));

/** Repository-relative, /-separated, without a leading ./ */
export function normalizePath(value) {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

export function classOf(value) {
  const path = normalizePath(value);
  return compiled.find(
    (entry) => entry.include.some((re) => re.test(path)) && !entry.exclude.some((re) => re.test(path)),
  ).name;
}

/** Undoes git's C-style quoting ("caf\303\251.md") used for unusual file names. */
export function unquote(value) {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes = [];
  for (const token of value.slice(1, -1).match(/\\[0-7]{1,3}|\\.|[^\\]+/gs) ?? []) {
    if (/^\\[0-7]/.test(token)) bytes.push(parseInt(token.slice(1), 8));
    else if (token.startsWith('\\')) bytes.push(escapes[token[1]] ?? token.charCodeAt(1));
    else bytes.push(...Buffer.from(token, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Paths from plain lines or `git diff --name-status` lines; a rename or copy yields its old and new path. */
export function parseChanges(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    const status = /^[ACDMRTUXB]+[0-9]{0,3}\t(.+)$/.exec(line);
    return (status ? status[1].split('\t') : [line]).map((path) => normalizePath(unquote(path.trim())));
  });
}

/** For changed paths: the classes they touch (in CLASSES order) and the OS checks the change must pass. */
export function classify(paths) {
  const files = [...new Set(paths.map(normalizePath).filter(Boolean))].map((path) => ({ path, class: classOf(path) }));
  const touched = new Set(files.map((file) => file.class));
  const classes = CLASSES.filter((entry) => touched.has(entry.name));
  const needed = new Set(classes.flatMap((entry) => entry.checks));
  return {
    classes: classes.map((entry) => entry.name),
    checks: OS_CHECKS.filter((check) => needed.has(check)),
    files,
  };
}

async function main(args) {
  let text = args.join('\n');
  if (!args.length) for await (const chunk of process.stdin) text += chunk;
  console.log(JSON.stringify(classify(parseChanges(text)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
