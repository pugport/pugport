import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJudgeConfig, parseVerdict, provenanceLine, renderJudgePrompt } from '../src/server/judge-config.ts';

const sha = 'abcdef0123456789abcdef0123456789abcdef01';

test('judge config defaults with and without front matter', () => {
  assert.deepEqual(parseJudgeConfig('Judge {{sha}}\n'), {
    executor: 'codex',
    network: false,
    timeoutMinutes: 60,
    template: 'Judge {{sha}}\n',
  });
  assert.deepEqual(
    parseJudgeConfig(
      '---\nexecutor: claude\nmodel: claude-opus-5-5\neffort: high\naccount: Work card\nnetwork: true\ntimeout_minutes: 240\nbase: origin/main\n---\nBody\n',
    ),
    {
      executor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      account: 'Work card',
      network: true,
      timeoutMinutes: 240,
      base: 'origin/main',
      template: 'Body\n',
    },
  );
  assert.equal(parseJudgeConfig('---\r\n---\r\nBody').template, 'Body');
});

test('judge config rejects unknown keys and bad values', () => {
  assert.throws(
    () => parseJudgeConfig('---\nverdicts: X=pass\n---\n'),
    /^Error: \.pugport\/judge\.md 的 verdicts 无效：/,
  );
  for (const line of [
    'executor: gemini',
    'effort: huge',
    'timeout_minutes: 0',
    'timeout_minutes: 241',
    'model: gpt 6',
  ]) {
    const key = line.split(':')[0];
    assert.throws(() => parseJudgeConfig(`---\n${line}\n---\n`), new RegExp(`judge\\.md 的 ${key} 无效：`), line);
  }
  assert.throws(() => parseJudgeConfig('---\nexecutor: codex\nBody'), /judge\.md 的 front matter 无效：/);
});

test('judge prompt template is rendered in one pass', () => {
  assert.equal(
    renderJudgePrompt('{{sha}} {{pr}}|{{base}}|{{repository}} {{mode}} {{x}}\n{{claim}}', {
      sha,
      claim: 'claim mentions {{base}} and {{sha}}',
      repository: 'C:/repo',
      mode: 'dry',
    }),
    `${sha} ||C:/repo dry {{x}}\nclaim mentions {{base}} and {{sha}}`,
  );
});

test('judge verdict maps the fixed words and checks the commit', () => {
  for (const [word, verdict] of [
    ['APPROVED', 'pass'],
    ['REFUTED', 'fail'],
    ['INCONCLUSIVE', 'blocked'],
  ]) {
    assert.equal(parseVerdict(`${word} @ ${sha}\nbody`, sha).verdict, verdict);
  }
  assert.deepEqual(parseVerdict('PASS @ ABCDEF0', sha), { verdict: 'pass', firstLine: 'PASS @ ABCDEF0' });
  assert.equal(parseVerdict('PASS @ abcdef1', sha).verdict, 'invalid');
  assert.equal(parseVerdict('PASS @ abcdef', sha).verdict, 'invalid');
  assert.equal(parseVerdict(`pass @ ${sha}`, sha).verdict, 'invalid');
  assert.equal(parseVerdict(`MAYBE @ ${sha}`, sha).verdict, 'invalid');
  // Spaces and tabs before and after the verdict are accepted presentation; blank lines before it stay accepted.
  assert.equal(parseVerdict(`  PASS @ ${sha}`, sha).verdict, 'pass');
  assert.deepEqual(parseVerdict(`  PASS @ ${sha}`, sha), { verdict: 'pass', firstLine: `PASS @ ${sha}` });
  assert.equal(parseVerdict(`\tFAIL @ ${sha}  `, sha).verdict, 'fail');
  assert.deepEqual(parseVerdict(`\tFAIL @ ${sha}  `, sha), { verdict: 'fail', firstLine: `FAIL @ ${sha}` });
  assert.deepEqual(parseVerdict(`PASS @ ${sha}  \nbody`, sha), { verdict: 'pass', firstLine: `PASS @ ${sha}` });
  assert.equal(parseVerdict(`**PASS @ ${sha}**`, sha).verdict, 'invalid');
  assert.equal(parseVerdict('`' + `PASS @ ${sha}` + '`', sha).verdict, 'invalid');
  assert.equal(parseVerdict(`> PASS @ ${sha}`, sha).verdict, 'invalid');
  assert.equal(parseVerdict(`- PASS @ ${sha}`, sha).verdict, 'invalid');
  assert.deepEqual(
    parseVerdict(`\r\n  \r\nFAIL @ ${sha.slice(0, 12)}\r\nwhy\r\nJUDGE: first\r\nJUDGE: context=zero\r\n`, sha),
    {
      verdict: 'fail',
      firstLine: `FAIL @ ${sha.slice(0, 12)}`,
      signature: 'JUDGE: context=zero',
    },
  );
  assert.equal(parseVerdict(`BLOCKED @ ${sha}\nno signature`, sha).signature, undefined);
  assert.deepEqual(parseVerdict('', sha), { verdict: 'invalid', firstLine: '' });
});

test('judge provenance line names every field and no prompt text', () => {
  const line = provenanceLine({
    id: 'jg-20261027-0123abcd',
    userDocs: true,
    configTracked: false,
    executor: 'codex',
    cliVersion: '0.50.0',
    sha,
    flags: ['ignore-user-config', 'ignore-rules', 'ephemeral', 'disable-hooks'],
  });
  assert.equal(
    line,
    `PUGPORT-JUDGE: id=jg-20261027-0123abcd mode=dry context=zero isolation=flags-only user-docs=present config=untracked executor=codex cli=0.50.0 model=default host=local checkout=detached@${sha} repo-docs=on flags=ignore-user-config,ignore-rules,ephemeral,disable-hooks`,
  );
  const claude = provenanceLine({
    id: 'jg-1',
    userDocs: false,
    configTracked: true,
    executor: 'claude',
    model: 'claude-opus-5-5',
    sha,
    flags: ['restricted'],
  });
  assert.match(claude, / user-docs=absent config=tracked executor=claude cli=unknown model=claude-opus-5-5 /);
  assert.match(claude, / repo-docs=off flags=restricted$/);
  assert.doesNotMatch(line + claude, /claim|prompt|\{\{/);
});
