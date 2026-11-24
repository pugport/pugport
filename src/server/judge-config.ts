import { effortLevels } from '../shared/effort.ts';
import { checkedArgument } from './adapters/claude.ts';

/**
 * The repository's `.pugport/judge.md`: optional front matter (`key: value` lines between two `---` lines)
 * followed by the prompt template. PugPort only runs the judge; prompt, model and timeout live in the file.
 */
export type JudgeExecutor = 'codex' | 'claude';
export type JudgeConfig = {
  executor: JudgeExecutor;
  model?: string;
  effort?: string;
  account?: string;
  network: boolean;
  timeoutMinutes: number;
  base?: string;
  template: string;
};
export type JudgeVerdict = 'pass' | 'fail' | 'blocked' | 'invalid';

const invalid = (key: string, reason: string) => new Error(`.pugport/judge.md 的 ${key} 无效：${reason}`);

export function parseJudgeConfig(text: string): JudgeConfig {
  const config: JudgeConfig = { executor: 'codex', network: false, timeoutMinutes: 60, template: text };
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return config;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw invalid('front matter', '缺少结束的 ---');
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/);
    if (!match) throw invalid(line.trim(), '应为 key: value');
    const [, key, value] = match;
    if (!value) throw invalid(key, '不能为空');
    if (key === 'executor') {
      if (value !== 'codex' && value !== 'claude') throw invalid(key, '应为 codex 或 claude');
      config.executor = value;
    } else if (key === 'model') {
      try {
        config.model = checkedArgument(value, 'model ID');
      } catch {
        throw invalid(key, '含有不允许的字符');
      }
    } else if (key === 'effort') {
      if (!effortLevels.includes(value)) throw invalid(key, `应为 ${effortLevels.join('、')} 之一`);
      config.effort = value;
    } else if (key === 'account') config.account = value;
    else if (key === 'network') {
      if (value !== 'true' && value !== 'false') throw invalid(key, '应为 true 或 false');
      config.network = value === 'true';
    } else if (key === 'timeout_minutes') {
      const minutes = Number(value);
      if (!/^\d+$/.test(value) || minutes < 1 || minutes > 240) throw invalid(key, '应为 1–240 的整数');
      config.timeoutMinutes = minutes;
    } else if (key === 'base') config.base = value;
    else throw invalid(key, '未知设置');
  }
  // Keep the template's own line endings: rejoin from the original text after the closing line.
  config.template = text
    .split(/(?<=\n)/)
    .slice(end + 1)
    .join('');
  return config;
}

/** One pass, so placeholders inside the (untrusted) claim are never expanded. Unknown ones stay literal. */
export function renderJudgePrompt(
  template: string,
  values: Partial<Record<'sha' | 'pr' | 'repository' | 'claim' | 'base' | 'mode', string>>,
): string {
  return template.replace(
    /\{\{(sha|pr|repository|claim|base|mode)\}\}/g,
    (_, name: keyof typeof values) => values[name] ?? '',
  );
}

const verdictWords: Record<string, Exclude<JudgeVerdict, 'invalid'>> = {
  PASS: 'pass',
  CONFIRMED: 'pass',
  APPROVED: 'pass',
  FAIL: 'fail',
  REFUTED: 'fail',
  REJECTED: 'fail',
  BLOCKED: 'blocked',
  UNVERIFIABLE: 'blocked',
  INCONCLUSIVE: 'blocked',
};

/**
 * First non-empty line `<VERDICT> @ <sha prefix>`; whitespace such as spaces and tabs before and after the verdict is accepted
 * presentation, but anything else around it makes the verdict invalid. The last `JUDGE:` line is returned verbatim,
 * never trusted.
 */
export function parseVerdict(
  text: string,
  sha: string,
): { verdict: JudgeVerdict; firstLine: string; signature?: string } {
  const lines = text.split(/\r?\n/);
  // The first non-empty line is trimmed, so accepted presentation whitespace never reaches the verdict.
  const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
  const match = firstLine.match(/^([A-Z][A-Z_-]{1,31})\s*@\s*([0-9a-fA-F]{7,64})\b/);
  const word = match && sha.toLowerCase().startsWith(match[2].toLowerCase()) ? verdictWords[match[1]] : undefined;
  const signature = [...lines].reverse().find((line) => /^JUDGE:\s*(.+)$/.test(line));
  return { verdict: word ?? 'invalid', firstLine, ...(signature ? { signature } : {}) };
}

/** PugPort's own line appended to every verdict: what it actually did, not what the model claims. */
export function provenanceLine(fields: {
  id: string;
  userDocs: boolean;
  configTracked: boolean;
  executor: JudgeExecutor;
  cliVersion?: string;
  model?: string;
  sha: string;
  flags: string[];
}): string {
  return [
    `PUGPORT-JUDGE: id=${fields.id}`,
    'mode=dry',
    'context=zero',
    'isolation=flags-only',
    `user-docs=${fields.userDocs ? 'present' : 'absent'}`,
    `config=${fields.configTracked ? 'tracked' : 'untracked'}`,
    `executor=${fields.executor}`,
    `cli=${fields.cliVersion?.replace(/\s+/g, '_') || 'unknown'}`,
    `model=${fields.model ?? 'default'}`,
    'host=local',
    `checkout=detached@${fields.sha}`,
    `repo-docs=${fields.executor === 'codex' ? 'on' : 'off'}`,
    `flags=${fields.flags.join(',')}`,
  ].join(' ');
}
