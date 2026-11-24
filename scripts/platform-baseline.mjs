// Ratchet for direct platform checks outside src/server/platform/ (see docs/PLATFORMS.md).
//   node scripts/platform-baseline.mjs --check    → compare src/ with the baseline; exit 1 when a file has more hits
//   node scripts/platform-baseline.mjs --write    → lower the baseline after hits were removed (refuses increases)
//   node scripts/platform-baseline.mjs --write --allow-increase → also record new hits (owner-approved only)
// tests/platform-branch-guard.test.ts runs the same checkBaseline() as --check and documents what counts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'tests/fixtures/platform-branch-baseline.json';
export const EXEMPT = 'src/server/platform/';
const SCANNED = /\.(?:ts|tsx|mts|mjs)$/;

/** One source line counts once when any of these match after comments are blanked out. */
export const PATTERNS = [
  /\bprocess\.platform\b/,
  /\bos\.platform\s*\(/,
  /['"`](?:win32|darwin|linux)['"`]/,
  // A PowerShell program name as a whole string, or powershell.exe anywhere. Not the bare word: shell-name
  // recognisers such as /(?:cmd|powershell|pwsh)/ and prose run on every system.
  /['"`]powershell(?:\.exe)?['"`]|\bpowershell\.exe\b/i,
  // Windows variable syntax. Upper case so git formats (%H%x00), URL escapes (%3A%3A) and SQL LIKE patterns
  // ('%task_id%') do not count.
  /%[A-Z_][A-Z0-9_]+%/,
  /\b(?:LOCAL)?APPDATA\b|\bUSERPROFILE\b/,
  // Windows variable names ignore case, so env.appdata, env['UserProfile'], %AppData% and %ErrorLevel% count too. The
  // bare words above stay upper case: appData is a common variable name, and Electron's app.getPath('appData') runs
  // on every system.
  /(?:\benv(?:\??\.|(?:\?\.)?\[\s*['"`])|%)(?:(?:local)?appdata|userprofile)\b|%errorlevel%/i,
];

const OPTIONS = ['--check', '--write', '--allow-increase'];
const REFRESH = 'node scripts/platform-baseline.mjs --write';
const ADVICE =
  'Move the platform-specific logic into a helper under src/server/platform/ that takes a Host, test it with ' +
  'tests/helpers/fake-host.ts, and call the helper here. See docs/PLATFORMS.md.';

/** Replaces every comment with spaces, keeping line breaks so line numbers stay put. */
export function stripComments(text, file = 'file.ts') {
  let comments;
  try {
    const plugins = [file.endsWith('x') ? 'jsx' : null, file.endsWith('.mjs') ? null : 'typescript'];
    comments = parse(text, { sourceType: 'module', errorRecovery: true, plugins: plugins.filter(Boolean) }).comments;
  } catch {
    return text; // Unparseable source still gets scanned; typecheck reports the syntax error.
  }
  let out = '';
  let at = 0;
  for (const comment of comments) {
    out += text.slice(at, comment.start) + text.slice(comment.start, comment.end).replace(/[^\r\n]/g, ' ');
    at = comment.end;
  }
  return out + text.slice(at);
}

/** Lines of one source file that contain a direct platform check: [{ line, text }], line numbers from 1. */
export function platformHits(text, file = 'file.ts') {
  const original = text.split(/\r?\n/);
  return stripComments(text, file)
    .split(/\r?\n/)
    .flatMap((code, index) =>
      PATTERNS.some((pattern) => pattern.test(code)) ? [{ line: index + 1, text: original[index].trim() }] : [],
    );
}

/** Every scanned file under root/src with at least one hit, keyed by its /-separated repository path. */
export function scanTree(root = ROOT) {
  const found = {};
  const walk = (relative) => {
    const entries = readdirSync(path.join(root, ...relative.split('/')), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (`${child}/` !== EXEMPT && entry.name !== 'node_modules') walk(child);
      } else if (entry.isFile() && SCANNED.test(entry.name)) {
        const hits = platformHits(readFileSync(path.join(root, ...child.split('/')), 'utf8'), entry.name);
        if (hits.length) found[child] = hits;
      }
    }
  };
  if (existsSync(path.join(root, 'src'))) walk('src');
  return found;
}

export function readBaseline(root = ROOT) {
  const file = path.join(root, BASELINE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).files : {};
}

export function totals(counts) {
  const values = Object.values(counts);
  return { files: values.filter((count) => count > 0).length, hits: values.reduce((sum, count) => sum + count, 0) };
}

/** Compares scanned hits with baseline counts. Only increases and new files fail. */
export function compare(found, baseline) {
  const failures = Object.entries(found)
    .filter(([file, hits]) => hits.length > (baseline[file] ?? 0))
    .map(([file, hits]) => ({ file, count: hits.length, baseline: baseline[file] ?? 0, hits }));
  const decreases = Object.entries(baseline)
    .filter(([file, count]) => (found[file]?.length ?? 0) < count)
    .map(([file, count]) => ({ file, count: found[file]?.length ?? 0, baseline: count }));
  const lines = failures.map(
    ({ file, count, baseline, hits }) =>
      `  ${file}: ${count} (${baseline ? `baseline ${baseline}` : 'not in the baseline'}), lines ` +
      `${hits.map((hit) => hit.line).join(', ')}\n${hits.map((hit) => `    ${hit.line}: ${hit.text.slice(0, 160)}`).join('\n')}`,
  );
  const message = failures.length
    ? `Direct platform checks outside ${EXEMPT} increased:\n${lines.join('\n')}\n${ADVICE}`
    : '';
  const hint = decreases.length
    ? `Platform checks went down in ${decreases.length} file(s): ` +
      `${decreases.map(({ file, count, baseline }) => `${file} ${baseline} → ${count}`).join(', ')}. ` +
      `Lock in the lower counts with: ${REFRESH}`
    : '';
  return { ok: failures.length === 0, failures, decreases, message, hint };
}

/** What --check does: scan root/src and compare it with the committed baseline. */
export function checkBaseline(root = ROOT) {
  const found = scanTree(root);
  const counts = Object.fromEntries(Object.entries(found).map(([file, hits]) => [file, hits.length]));
  return { ...compare(found, readBaseline(root)), counts, totals: totals(counts) };
}

/** What --write does. Without allowIncrease it refuses to record any increase over the current baseline. */
export function writeBaseline(root = ROOT, { allowIncrease = false } = {}) {
  const result = checkBaseline(root);
  if (!result.ok && !allowIncrease) return { ...result, written: false };
  const files = Object.fromEntries(Object.entries(result.counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const about = `Direct platform checks per file outside ${EXEMPT}. Counts may only go down; regenerate with ${REFRESH}.`;
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify({ about, files }, null, 2)}\n`);
  return { ...result, written: true };
}

function main(args) {
  const rootArg = args.find((arg) => arg.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : ROOT;
  const summary = ({ totals }) => `${totals.hits} direct platform checks in ${totals.files} files outside ${EXEMPT}.`;
  const unknown = args.filter((arg) => !OPTIONS.includes(arg) && arg !== rootArg);
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}. Use --check, --write or --write --allow-increase.`);
    return 2;
  }
  if (args.includes('--write')) {
    const result = writeBaseline(root, { allowIncrease: args.includes('--allow-increase') });
    if (!result.written) {
      console.error(
        `${result.message}\nBaseline not written. Only an owner-approved exception may add --allow-increase.`,
      );
      return 1;
    }
    if (result.failures.length) console.log(`Recorded increases in: ${result.failures.map((f) => f.file).join(', ')}`);
    console.log(`Wrote ${BASELINE}: ${summary(result)}`);
    return 0;
  }
  const result = checkBaseline(root);
  if (!result.ok) console.error(result.message);
  if (result.hint) console.log(result.hint);
  console.log(summary(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
