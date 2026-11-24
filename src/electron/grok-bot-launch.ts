import { createInterface } from 'node:readline';
import { currentHost, type Host } from '../server/platform/host.ts';
import { isDirectExecutable } from '../server/platform/executables.ts';
import { grokBotOpensByBundleId, openGrokBot } from '../server/platform/grok-bot.ts';
import { spawn } from '../server/platform/test-process.ts';
import { underTest, UnderTestError } from '../server/platform/under-test.ts';

type WindowSnapshot = {
  foreground: string;
  foregroundPid: number;
  processes: { pid: number; name: string; startedAt: number; window: string }[];
};

/** Keep the user's focus choice sticky while waiting for the newly launched app. */
export function grokWindowAction(
  pid: number,
  launchedAt: number,
  parent: string,
  restore: boolean,
  snapshot: WindowSnapshot,
) {
  const targets = snapshot.processes.filter(
    (process) => process.pid === pid || (process.name === 'Grok Bot' && process.startedAt >= launchedAt),
  );
  const grokFocused = targets.some((process) => process.pid === snapshot.foregroundPid);
  restore = restore && (snapshot.foreground === parent || grokFocused);
  const target = targets.find((process) => process.window !== '0');
  return { restore, target, refocus: !!target && restore && grokFocused };
}

// Only native handles and the PID we just started enter this script; never shell input or a user path.
function minimizeWindow(pid: number, parent: string) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GrokWindow {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
$parentWindow = [IntPtr]::new(${parent})
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) {
  $targets = @(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) + @(Get-Process -Name 'Grok Bot' -ErrorAction SilentlyContinue)
  $processes = @($targets | Sort-Object -Property Id -Unique | ForEach-Object {
    try {
      $hwnd = $_.MainWindowHandle
      if (![GrokWindow]::IsWindowVisible($hwnd)) { $hwnd = [IntPtr]::Zero }
      @{ pid = $_.Id; name = $_.ProcessName; startedAt = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds(); window = $hwnd.ToInt64().ToString() }
    } catch {}
  })
  $foreground = [GrokWindow]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  [void][GrokWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  @{ foreground = $foreground.ToInt64().ToString(); foregroundPid = $foregroundPid; processes = $processes } | ConvertTo-Json -Compress -Depth 3
  $line = [Console]::ReadLine()
  if ($null -eq $line) { exit }
  $action = $line | ConvertFrom-Json
  if ($action.window) {
    $hwnd = [IntPtr]::new([long]$action.window)
    [uint32]$owner = 0
    [void][GrokWindow]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -ne $action.pid -or ![GrokWindow]::IsWindowVisible($hwnd)) { exit }
    $refocus = $action.refocus -and [GrokWindow]::GetForegroundWindow() -eq $foreground
    [void][GrokWindow]::ShowWindow($hwnd, 7) # SW_SHOWMINNOACTIVE
    if ($refocus) { [void][GrokWindow]::SetForegroundWindow($parentWindow) }
    exit
  }
  Start-Sleep -Milliseconds 250
}
`;
}

/** Grok Bot's environment: without PugPort's own variables or Electron's run-as-Node switch. */
function launchEnv(host: Host) {
  const env = { ...host.env };
  for (const key of Object.keys(env))
    if (/^(?:ELECTRON_RUN_AS_NODE|PUGPORT_.*|COMBORUNNER_.*|AGENT_STUDIO_.*)$/i.test(key)) delete env[key];
  return env;
}

/** Launch from main, outside the backend's kill-on-close Windows Job (macOS: through LaunchServices). */
export async function startGrokBot(host: Host = currentHost(), launch: typeof spawn = spawn, focusedWindow?: Buffer) {
  if (underTest() && host === currentHost()) throw new UnderTestError('Grok Bot launch');
  // macOS opens the app hidden and behind PugPort, so no window helper follows.
  if (grokBotOpensByBundleId(host)) return openGrokBot(launchEnv(host), host);
  if (host.platform !== 'win32' || !host.env.LOCALAPPDATA) throw new Error('Grok Bot executable not found');
  const executable = host.path.join(host.env.LOCALAPPDATA, 'Programs', 'Grok Bot', 'Grok Bot.exe');
  if (!isDirectExecutable(executable, host)) throw new Error('Grok Bot executable not found');
  const env = launchEnv(host);
  const launchedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    // Run from its own folder so Grok Bot never holds PugPort's folder (or a test folder) open.
    const child = launch(executable, [], { env, cwd: host.path.dirname(executable), detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
      // Window management is best effort and must never delay or fail the routine send.
      if (!child.pid) return;
      try {
        const parent = focusedWindow
          ? (focusedWindow.length === 8 ? focusedWindow.readBigUInt64LE() : focusedWindow.readUInt32LE()).toString()
          : '0';
        const script = minimizeWindow(child.pid, parent);
        const helper = launch(
          host.path.join(
            host.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          // The 25 s window loop starts only after Add-Type compiles; leave room for a slow compile.
          { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 40_000 },
        );
        helper.on('error', () => {});
        helper.stdin!.on('error', () => {});
        const lines = createInterface({ input: helper.stdout! });
        let restore = !!focusedWindow;
        let done = false;
        lines.on('line', (line) => {
          if (done) return;
          try {
            const action = grokWindowAction(child.pid!, launchedAt, parent, restore, JSON.parse(line));
            restore = action.restore;
            done = !!action.target;
            helper.stdin!.write(
              JSON.stringify({ window: action.target?.window, pid: action.target?.pid, refocus: action.refocus }) +
                '\n',
            );
          } catch {
            done = true;
            helper.kill();
          }
        });
        helper.once('close', () => lines.close());
        helper.unref();
      } catch {
        // The desktop process is already running; leave its reply path available.
      }
    });
  });
}
