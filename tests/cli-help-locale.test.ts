import assert from 'node:assert/strict';
import test from 'node:test';
import { chatHelp, cliHelp, slashCommands, slashCommandsIn } from '../src/cli/help.ts';
import { cliLocale } from '../src/cli/locale.ts';
import { run } from '../src/cli/run.ts';
import { Theme } from '../src/cli/theme.ts';
import type { Locale } from '../src/shared/i18n/index.ts';

const cjk = /[㐀-鿿]/;
const all: Locale[] = ['en', 'zh-CN', 'zh-TW'];
const commands = [
  'pugport ask',
  'pugport status',
  'pugport agents',
  'pugport tasks',
  'pugport wait',
  'pugport cancel',
  'pugport doctor',
  'pugport open',
  'pugport node',
];
const flags = [
  '-w, --write',
  '-c, --continue',
  '--agent',
  '--json',
  '--timeout',
  '--port',
  '-r, --resume',
  '-h, --help',
  '-v, --version',
];
const examples = ['Claude', 'Codex', '90s', '25m', '9m', 'add', 'install', 'pair', 'uninstall', 'Linux / macOS'];

test('the terminal locale picks the help language: LC_ALL, LC_MESSAGES, LANG, then the system locale', () => {
  const system = () => 'fr-FR';
  assert.equal(cliLocale({ LANG: 'zh_CN.UTF-8' }, system), 'zh-CN');
  assert.equal(cliLocale({ LANG: 'en_US.UTF-8' }, system), 'en');
  assert.equal(cliLocale({ LANG: 'de_DE.UTF-8' }, system), 'en');
  assert.equal(cliLocale({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }, system), 'en');
  assert.equal(cliLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, system), 'zh-CN');
  assert.equal(cliLocale({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' }, system), 'zh-TW');
  for (const tag of ['zh_TW.UTF-8', 'zh_HK', 'zh_MO', 'zh-Hant', 'zh_Hant_TW', 'zh-TW'])
    assert.equal(cliLocale({ LANG: tag }, system), 'zh-TW', tag);
  for (const tag of ['zh', 'zh_SG.UTF-8', 'zh-Hans', 'zh_CN.GB18030@pinyin'])
    assert.equal(cliLocale({ LANG: tag }, system), 'zh-CN', tag);

  // Empty, C and POSIX say nothing about the language: the next variable, then the system, decides.
  assert.equal(cliLocale({ LC_ALL: 'C', LC_MESSAGES: '', LANG: 'zh_CN.UTF-8' }, system), 'zh-CN');
  assert.equal(
    cliLocale({ LC_ALL: 'POSIX', LANG: 'C.UTF-8' }, () => 'zh-CN'),
    'zh-CN',
  );
  assert.equal(
    cliLocale({ LC_ALL: 'C', LANG: 'POSIX' }, () => 'zh-Hant-HK'),
    'zh-TW',
  );
  assert.equal(
    cliLocale({}, () => 'zh-Hans-CN'),
    'zh-CN',
  );
  assert.equal(
    cliLocale({}, () => 'en-GB'),
    'en',
  );
  assert.equal(cliLocale({}, system), 'en');
  // A named locale wins over the system's.
  assert.equal(
    cliLocale({ LANG: 'en_US.UTF-8' }, () => 'zh-CN'),
    'en',
  );
  // The real system locale is some language we have.
  assert.ok(all.includes(cliLocale({})));
});

test('pugport --help reads in English and in Chinese with the same commands, flags, examples and exit codes', () => {
  const plain = new Theme(false);
  const help = Object.fromEntries(all.map((locale) => [locale, cliHelp(plain, locale)])) as Record<Locale, string>;

  assert.match(help['zh-CN'], /用法\n {2}pugport {17}打开终端对话（当前文件夹作为项目，默认只读）\n/);
  assert.match(help['zh-CN'], /\n {2}pugport ask "<任务>" {4}交给 PugPort 做一件事/);
  assert.match(help['zh-CN'], /\n {6}--agent <名字> {6}只用于 ask：指定执行器，例如 Claude、Codex\n/);
  assert.match(help['zh-CN'], /退出码：0 完成；1 失败、取消或请求失败；2 用法或输入错误；3 暂停；130 Ctrl\+C。/);
  assert.match(help['zh-TW'], /選項\n {2}-w, --write {13}允許修改/);
  assert.match(help['zh-TW'], /退出碼：0 完成/);
  assert.match(help.en, /Usage\n {2}pugport {17}Open the terminal chat/);
  assert.match(help.en, /\n {2}pugport ask "<task>" {4}Hand PugPort one task/);
  assert.match(help.en, /\n {6}--agent <name> {6}ask only: pick the executor, for example Claude or Codex\n/);
  assert.match(help.en, /\nOptions\n/);
  assert.match(help.en, /\nIn the chat\n/);
  assert.doesNotMatch(help.en, cjk, 'the English help has no untranslated text');

  for (const locale of all) {
    const text = help[locale];
    for (const command of commands) assert.ok(text.includes(`\n  ${command}`), `${locale}: ${command}`);
    for (const flag of flags) assert.match(text, new RegExp(`\\n {2,6}${flag}[ \\n]`), `${locale}: ${flag}`);
    assert.match(text, /\n {2}- {2,}\S/, `${locale}: stdin dash`);
    for (const example of examples) assert.ok(text.includes(example), `${locale}: ${example}`);
    for (const name of slashCommands.map((command) => `/${command.name}`)) assert.ok(text.includes(name), name);
    // Exit codes, in order: the general ones, then wait's.
    const codes = text.split('\n').slice(-4, -2);
    assert.deepEqual(
      codes.map((line) => line.match(/\d+/g)),
      [
        ['0', '1', '2', '3', '130'],
        ['0', '3', '124', '1'],
      ],
      locale,
    );
    assert.equal(text.split('\n').length, help['zh-CN'].split('\n').length, `${locale}: same lines`);
  }
  // The command and flag columns are the same bytes in every language once placeholders (<…>) are set aside.
  const left = (text: string) =>
    text
      .split('\n')
      .filter((line) => /^ {2,6}(pugport|-)/.test(line))
      .map((line) => line.replace(/["<].*$/, '').replace(/ {2,}\S.*$/, ''));
  assert.equal(left(help['zh-CN']).length, 20);
  assert.deepEqual(left(help.en), left(help['zh-CN']));
  assert.deepEqual(left(help['zh-TW']), left(help['zh-CN']));

  // Colours wrap the same pieces in every language.
  const colored = new Theme(true);
  const escapes = (text: string) => text.match(/\x1b\[[0-9;]*m/g);
  assert.ok((escapes(cliHelp(colored, 'en')) ?? []).length >= 8);
  assert.deepEqual(escapes(cliHelp(colored, 'en')), escapes(cliHelp(colored, 'zh-CN')));
  assert.equal(cliHelp(colored, 'en').replace(/\x1b\[[0-9;]*m/g, ''), help.en);
});

test('/help in the chat reads in English and in Chinese with the same slash commands and keys', () => {
  const zh = chatHelp('zh-CN');
  const en = chatHelp('en');
  const hant = chatHelp('zh-TW');
  assert.match(zh, /^在下面输入问题，回车发送；Shift\+Enter 或 Alt\+Enter 换行。\n/);
  assert.match(zh, /\n\/new {2}开始新对话\n\/status {2}查看各账号剩余额度\n/);
  assert.match(hant, /\n\/new {2}開始新對話\n/);
  assert.match(en, /^Type your question below and press Enter to send/);
  assert.match(en, /\n\/new {2}Start a new chat\n\/status {2}Show each account's usage left\n/);
  assert.doesNotMatch(en, cjk);
  for (const text of [zh, en, hant]) {
    assert.equal(text.split('\n').length, 9);
    for (const command of slashCommands) assert.match(text, new RegExp(`\\n/${command.name} {2}\\S`));
    for (const key of ['Shift+Enter', 'Alt+Enter', 'Tab', 'Esc', 'Ctrl+C', 'Ctrl+D', 'PugPort', '@'])
      assert.ok(text.includes(key), key);
  }
  for (const locale of all)
    assert.deepEqual(
      slashCommandsIn(locale).map((command) => command.name),
      ['new', 'status', 'open', 'help', 'quit'],
    );
  assert.deepEqual(slashCommandsIn('zh-CN'), slashCommands);
  assert.equal(slashCommandsIn('en').at(-1)?.description, 'Quit');
});

test('pugport --help exits 0 in each language and prints that language', async () => {
  for (const [locale, heading] of [
    ['en', 'Usage'],
    ['zh-CN', '用法'],
    ['zh-TW', '選項'],
  ] as const) {
    let printed = '';
    const code = await run({ kind: 'help' }, { locale, stdout: { write: (text) => void (printed += text) } });
    assert.equal(code, 0);
    assert.ok(printed.includes(`\n${heading}\n`), locale);
    assert.ok(printed.includes('pugport wait'));
  }
  // Without a given locale the terminal's decides; whichever it is, help still succeeds.
  let printed = '';
  assert.equal(await run({ kind: 'help' }, { stdout: { write: (text) => void (printed += text) } }), 0);
  assert.match(printed, /pugport ask/);
});
