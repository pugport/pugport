import { APP_VERSION } from '../shared/identity.ts';
import type { Locale } from '../shared/i18n/index.ts';
import { translateFor } from './locale.ts';
import { pugFace } from './pug-logo.ts';
import type { Theme } from './theme.ts';

// Every Chinese string in this file is a key of the translation catalog (scripts/i18n-extract.mjs reads this
// file), so each is written as one plain string: no template strings with Chinese in them.

/** The chat's slash commands, shown in completion and in /help. */
export const slashCommands = [
  { name: 'new', description: '开始新对话' },
  { name: 'status', description: '查看各账号剩余额度' },
  { name: 'open', description: '打开 PugPort 桌面应用' },
  { name: 'help', description: '显示帮助' },
  { name: 'quit', description: '退出' },
];

/** The slash commands with their descriptions in the given language; the names never change. */
export function slashCommandsIn(locale: Locale) {
  const t = translateFor(locale);
  return slashCommands.map((command) => ({ name: command.name, description: t(command.description) }));
}

export function chatHelp(locale: Locale) {
  const t = translateFor(locale);
  return [
    t('在下面输入问题，回车发送；Shift+Enter 或 Alt+Enter 换行。'),
    t('每条消息都由 PugPort 按剩余额度自动挑选账号回答。'),
    t('@名字：叫一个角色或执行器来回答这一条（Tab 或方向键选择）；叫好几位时写清谁做什么，PugPort 会替你分工。'),
    ...slashCommandsIn(locale).map((command) => `/${command.name}  ${command.description}`),
    t('Esc：取消正在进行的回复 · Ctrl+C：清空输入，连按两次退出 · Ctrl+D：退出'),
  ].join('\n');
}

/** A command or flag and what it does; a left side with a placeholder in it (<任务>) is translated too. */
type Row = [left: string, description: string];

const usage: Row[] = [
  ['pugport', '打开终端对话（当前文件夹作为项目，默认只读）'],
  ['pugport ask "<任务>"', '交给 PugPort 做一件事，显示进度，打印结果后退出'],
  ['pugport status', '查看各账号剩余额度'],
  ['pugport agents', '查看执行器'],
  ['pugport tasks', '列出任务'],
  ['pugport wait <任务ID>…', '等到任务结束或需要主人处理'],
  ['pugport cancel <任务ID>', '取消任务'],
  ['pugport doctor', '检查桌面应用、PATH 和执行器'],
  ['pugport open', '打开 PugPort 桌面应用（已打开则切到前面）'],
  ['pugport node …', '设备节点（Linux / macOS）：add、install、pair、status、uninstall'],
];

const options: Row[] = [
  ['-w, --write', '允许修改当前文件夹里的文件'],
  ['-c, --continue', '接着这个文件夹里上次从终端开始的对话'],
  ['    --agent <名字>', '只用于 ask：指定执行器，例如 Claude、Codex'],
  ['    --json', 'ask、wait、status、agents、tasks、cancel 输出 JSON'],
  ['    --timeout <时长>', '只用于 wait：最长等多久，例如 90s、25m，默认 9m'],
  ['    --port <端口>', '只用于 wait：指定 PugPort 端口'],
  ['-r, --resume <对话ID>', 'ask 中继续指定对话'],
  ['-', 'ask 中读取标准输入，追加到任务后'],
  ['-h, --help', '显示这段说明'],
  ['-v, --version', '显示版本'],
];

const cjk = /[㐀-鿿]/;
/** Terminal columns: a Chinese character takes two. */
const columns = (text: string) => [...text].reduce((width, char) => width + (cjk.test(char) ? 2 : 1), 0);

export function cliHelp(theme: Theme, locale: Locale) {
  const t = translateFor(locale);
  const rows = (list: Row[]) =>
    list
      .map(([source, description]) => {
        const left = cjk.test(source) ? t(source) : source;
        return `  ${left}${' '.repeat(Math.max(1, 24 - columns(left)))}${t(description)}`;
      })
      .join('\n');
  const title = `${theme.fg('accent', pugFace)} ${theme.bold('PugPort')} ${theme.fg('dim', APP_VERSION)}  ${t('在终端里用 PugPort：按剩余额度自动挑账号回答')}`;
  return `${title}

${theme.bold(t('用法'))}
${rows(usage)}

${theme.bold(t('选项'))}
${rows(options)}

${theme.bold(t('对话里'))}
  ${t('/new 新对话 · /status 额度 · /open 桌面应用 · /help 帮助 · /quit 退出')}
  ${t('@ 叫角色或执行器，@@ 叫设备或 Bot · Esc 取消回复 · Ctrl+C 连按两次退出')}

${t('PugPort 桌面应用没开时，pugport 会先把它打开（wait 除外）。')}
${t('退出码：0 完成；1 失败、取消或请求失败；2 用法或输入错误；3 暂停；130 Ctrl+C。')}
${t('wait 退出码：0 有任务结束；3 有任务需要主人处理；124 超时；1 出错。')}
${t('ask 等待批准或确认没有超时，脚本应自行设置 timeout。')}
`;
}
