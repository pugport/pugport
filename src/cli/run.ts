/** What each `pugport` command does; pugport.ts is only the entry point, so tests can import this. */
import { networkInterfaces } from 'node:os';
import { APP_VERSION } from '../shared/identity.ts';
import type { Locale } from '../shared/i18n/index.ts';
import { currentHost } from '../server/platform/host.ts';
import type { CliCommand } from './args.ts';
import { runAsk, type Output } from './ask.ts';
import { runWait } from './wait.ts';
import { TerminalChat } from './chat.ts';
import { PugPortClient } from './client.ts';
import { cliHelp } from './help.ts';
import { cliLocale } from './locale.ts';
import { appRoot, desktopLaunchPlan, ensureBackend, launchDesktop } from './launch.ts';
import { nodeBackendPort, runNode } from './node.ts';
import { runNodeAdd } from '../server/node-enroll.ts';
import { quotaReport, type QuotaView } from './quota.ts';
import { createTheme } from './theme.ts';

function openDesktop() {
  const plan = desktopLaunchPlan(appRoot());
  if (!plan) return false;
  launchDesktop(plan);
  return true;
}

export async function run(
  command: CliCommand,
  // Tests pass a fake backend, stdin and output; the command uses the real ones.
  deps: {
    client?: PugPortClient;
    ensure?: typeof ensureBackend;
    stdin?: AsyncIterable<string | Buffer>;
    stdout?: Output;
    stderr?: Output;
    /** The help language; by default the terminal's (see cliLocale). */
    locale?: Locale;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const out = (text: string) => stdout.write(text);
  const err = (text: string) => stderr.write(text);
  switch (command.kind) {
    case 'error':
      err(`${command.message}\n`);
      return 2;
    case 'help':
      out(cliHelp(createTheme(stdout), deps.locale ?? cliLocale(process.env)));
      return 0;
    case 'version':
      out(`${APP_VERSION}\n`);
      return 0;
    case 'open':
      if (!openDesktop()) {
        err('找不到 PugPort 桌面应用。请从开始菜单或安装目录打开 PugPort。\n');
        return 1;
      }
      out('正在打开 PugPort…\n');
      return 0;
    case 'node': {
      // A device node runs headless: these commands never start the desktop app.
      const host = currentHost();
      const nodeDeps = {
        host,
        // `node add` drives the desktop app on this computer; the others reach the node here, not the desktop app.
        client: new PugPortClient(command.action === 'add' ? undefined : nodeBackendPort(host)),
        root: appRoot(),
        execPath: process.execPath,
        electron: Boolean(process.versions.electron),
        nodeVersion: process.version,
        interfaces: networkInterfaces,
        out,
        err,
      };
      return command.action === 'add' ? runNodeAdd(command, nodeDeps) : runNode(command, nodeDeps);
    }
    case 'doctor': {
      const client = deps.client ?? new PugPortClient();
      if (!(await client.health())) {
        err('PugPort 没有在运行。\n');
        return 1;
      }
      const health = await client.get<{ version?: string }>('/api/health');
      const path = await client.get<{ installed: boolean }>('/api/external/terminal-command');
      const agents = await client.get<{ agents: { label: string; status?: string }[] }>('/api/external/agents');
      out(`桌面 ${health.version ?? '未知'} · 命令 ${APP_VERSION}\nPATH ${path.installed ? '已安装' : '未安装'}\n`);
      for (const agent of agents.agents) out(`${agent.label}: ${agent.status ?? '未知'}\n`);
      return health.version === APP_VERSION &&
        path.installed &&
        agents.agents.every((agent) => agent.status !== 'error' && agent.status !== 'auth-required')
        ? 0
        : 1;
    }
  }
  if (command.kind === 'ask') {
    if (command.stdin) {
      let input = '';
      for await (const chunk of deps.stdin ?? process.stdin.setEncoding('utf8')) input += chunk;
      input = input.replace(/^\uFEFF/, '');
      command.task = command.task ? `${command.task}\n\n${input}` : input;
    }
    if (command.task.trim().length > 50000 || !command.task.trim()) {
      err('任务不能为空或超过 50000 字符。\n');
      return 2;
    }
  }
  if ('write' in command && command.write && process.env.PUGPORT_EXECUTOR === '1') {
    err("You are inside one of PugPort's executors; change files with your own tools instead of pugport --write.\n");
    return 1;
  }
  if (command.kind === 'wait') {
    const client = deps.client ?? new PugPortClient(command.port);
    try {
      // Never starts the desktop; a running one that is slow to answer (a busy machine) is waited for.
      await (deps.ensure ?? ensureBackend)(client, { launch: () => false });
    } catch (error) {
      err(`连不上 PugPort：${error instanceof Error ? error.message : String(error)}\n`);
      if (command.json) out(JSON.stringify({ outcome: 'error', waitedSeconds: 0, tasks: [] }) + '\n');
      return 1;
    }
    return runWait(client, command, { stdout, stderr });
  }
  let client = deps.client ?? new PugPortClient();
  // A computer that only runs a device node: use the node, as before it moved off the desktop app's port.
  if (!(await client.health())) {
    const node = new PugPortClient(nodeBackendPort(currentHost()));
    if (await node.health()) client = node;
  }
  await (deps.ensure ?? ensureBackend)(client, {
    onStarting: () => err('PugPort 还没打开，正在启动它…\n'),
    // For scripts and tests that must never start the desktop app.
    ...(process.env.PUGPORT_NO_START ? { launch: () => false } : {}),
  });
  if (command.kind === 'status') {
    const quota = await client.get<QuotaView>('/api/tray');
    out(`${command.json ? JSON.stringify(quota) : quotaReport(quota, createTheme(stdout))}\n`);
    return 0;
  }
  if (command.kind === 'agents' || command.kind === 'tasks' || command.kind === 'cancel') {
    const result =
      command.kind === 'cancel'
        ? await client.post(`/api/external/tasks/${encodeURIComponent(command.taskId)}/cancel`)
        : await client.get(`/api/external/${command.kind}`);
    out(`${JSON.stringify(result, null, command.json ? undefined : 2)}\n`);
    return 0;
  }
  if (command.kind === 'ask') {
    const interrupt = new AbortController();
    const onInterrupt = () => interrupt.abort(new Error('cancelled'));
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    try {
      return await runAsk(command, {
        client,
        cwd: process.cwd(),
        theme: createTheme(stderr),
        stdout,
        stderr,
        signal: interrupt.signal,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
    }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    err('pugport 对话需要在终端窗口里运行。在脚本里请用 pugport ask "<任务>"。\n');
    return 2;
  }
  return new TerminalChat(
    { cwd: process.cwd(), write: command.write, resume: command.continueLast },
    { client, theme: createTheme(process.stdout), openDesktop, locale: deps.locale ?? cliLocale(process.env) },
  ).run();
}
