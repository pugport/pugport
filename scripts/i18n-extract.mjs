// Collects every interface string written in Simplified Chinese (the source language) from the UI and the
// server messages it shows, as the keys of the translation tables in src/shared/i18n/.
//   node scripts/i18n-extract.mjs          → writes src/shared/i18n/keys.json and the Traditional table
//   node scripts/i18n-extract.mjs --check  → checks catalog freshness and translations without writing
// Template strings become patterns: `${n} 个任务` → "{0} 个任务". Agent prompts (long texts sent to executors,
// never shown as interface text) are left out by length.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'shared', 'i18n');
const cjk = /[㐀-鿿]/;
const maxLength = 260;

/** The same normalisation the runtime applies to a text node: collapse whitespace, trim. */
export const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : files(path);
    return /\.(tsx?|mts)$/.test(entry.name) ? [path] : [];
  });
}

const keys = new Map();
// Files that only write agent prompts, memory files or keyword rules — never interface text.
const promptOnly =
  /src\/shared\/markup-text\.ts$|src\/server\/(local-memory(?:-cli|-runtime)?|memory-[^/]*|task-outcome|agent-bridge|side-chat-context|one-for-all-policy|task-judgment|image-search|image-match|file-manager|photo-date|content-refusal|conversation-routing|style-check|grok-history|pi-extension|video-transcript)\.m?ts$/;
const add = (key, file) => {
  const text = normalize(key);
  if (!text || !cjk.test(text) || text.length > maxLength || promptOnly.test(file)) return;
  // Regular-expression sources and Markdown headings are not interface text.
  if (/\(\?|\\[sdwb]|^#|\[\^/.test(text)) return;
  if (!keys.has(text)) keys.set(text, file);
};

/** JSX text as React renders it: lines trimmed, blank lines dropped, joined with spaces. */
const jsxText = (raw) =>
  raw
    .split(/\r?\n/)
    .map((line, index, all) =>
      index === 0 ? line.trimEnd() : index === all.length - 1 ? line.trimStart() : line.trim(),
    )
    .filter(Boolean)
    .join(' ');

for (const file of [
  ...files(join(root, 'src', 'ui')),
  ...files(join(root, 'src', 'shared')),
  ...files(join(root, 'src', 'server')),
  ...files(join(root, 'src', 'electron')),
  // Only the terminal command's two help texts are translated; its other messages are not interface keys.
  join(root, 'src', 'cli', 'help.ts'),
]) {
  const ast = parse(readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: [file.endsWith('x') ? 'jsx' : null, 'typescript'].filter(Boolean),
  });
  const relativeFile = file.slice(root.length + 1).replaceAll('\\', '/');
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    // Language detection writes keyword rules; reply-language guidance is included in the catalog.
    if (
      relativeFile === 'src/server/workspace.ts' &&
      node.type === 'FunctionDeclaration' &&
      node.id?.name === 'explicitReplyLanguage'
    )
      return;
    if (
      relativeFile === 'src/server/file-manager.ts' &&
      node.type === 'CallExpression' &&
      (node.callee?.name === 'traceToolStep' || node.callee?.name === 'startToolStep') &&
      node.arguments?.[2]?.type === 'StringLiteral'
    )
      add(node.arguments[2].value, 'src/shared/trajectory.ts');
    if (
      relativeFile === 'src/server/image-search.ts' &&
      ((node.type === 'ObjectProperty' && node.key?.name === 'detail') ||
        (node.type === 'AssignmentExpression' &&
          node.left?.type === 'MemberExpression' &&
          node.left.object?.name === 'task' &&
          node.left.property?.name === 'detail'))
    ) {
      const collect = (sub) => {
        if (!sub || typeof sub !== 'object') return;
        if (sub.type === 'StringLiteral') add(sub.value, 'src/ui/BackgroundTasks.tsx');
        for (const k of Object.keys(sub)) {
          if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
          const v = sub[k];
          if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === 'object') collect(v);
        }
      };
      collect(node.value ?? node.right);
    }
    if (
      relativeFile === 'src/server/local-memory.ts' &&
      ((node.type === 'NewExpression' && node.callee?.name === 'Error') ||
        (node.type === 'CallExpression' &&
          node.callee?.type === 'MemberExpression' &&
          node.callee.property?.name === 'push'))
    ) {
      for (const arg of node.arguments ?? []) {
        if (arg.type === 'StringLiteral') add(arg.value, '');
        else if (arg.type === 'TemplateLiteral') {
          const parts = arg.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
          add(parts.map((part, index) => (index ? `{${index - 1}}${part}` : part)).join(''), '');
          if (parts.length > 1) for (const part of parts) add(part, '');
        }
      }
    }
    if (node.type === 'StringLiteral') add(node.value, relativeFile);
    else if (node.type === 'JSXText') add(jsxText(node.value), relativeFile);
    else if (node.type === 'TemplateLiteral') {
      // `a${x}b${y}c` → "a{0}b{1}c"; also each literal part on its own, for text split by JSX.
      const parts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
      add(parts.map((part, index) => (index ? `{${index - 1}}${part}` : part)).join(''), relativeFile);
      if (parts.length > 1) for (const part of parts) add(part, relativeFile);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program);
}

const sorted = [...keys.keys()].sort();
const checking = process.argv.includes('--check');
const saveCatalog = (name, value) => {
  const path = join(out, name);
  const content = JSON.stringify(value, null, 2) + '\n';
  if (!checking) writeFileSync(path, content);
  else if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
    console.error(`${name} is outdated; run npm run i18n.`);
    process.exitCode = 1;
  }
};
saveCatalog('keys.json', sorted);

// Traditional Chinese is generated with OpenCC (Taiwan phrasing), then a few product terms are fixed.
const { Converter } = require('opencc-js');
const toTraditional = Converter({ from: 'cn', to: 'twp' });
const fixes = [
  ['賬號', '帳號'],
  ['賬戶', '帳戶'],
  ['設定檔案', '設定檔'],
];
const hant = Object.fromEntries(
  sorted.map((key) => {
    let value = toTraditional(key);
    for (const [from, to] of fixes) value = value.replaceAll(from, to);
    return [key, value];
  }),
);
saveCatalog('zh-Hant.json', hant);

const english = existsSync(join(out, 'en.json')) ? JSON.parse(readFileSync(join(out, 'en.json'), 'utf8')) : {};
const missing = sorted.filter((key) => typeof english[key] !== 'string');
console.log(
  `${sorted.length} keys; ${sorted.length - missing.length} translated to English; ${missing.length} missing.`,
);
if (process.argv.includes('--missing'))
  writeFileSync(join(out, 'missing-en.json'), JSON.stringify(missing, null, 2) + '\n');
if (process.argv.includes('--check') && missing.length) process.exit(1);
