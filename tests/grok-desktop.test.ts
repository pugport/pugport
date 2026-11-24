import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nativeSpawn } from 'node:child_process';
import { ensureGrokBotRunning } from '../src/server/external-agents/grok-desktop.ts';
import { grokWindowAction, startGrokBot } from '../src/electron/grok-bot-launch.ts';
import type { SpawnOptions, spawn } from '../src/server/platform/test-process.ts';
import { currentHost, type Host } from '../src/server/platform/host.ts';
import { fakeHost, fakeTree } from './helpers/fake-host.ts';
import { electronModule } from './helpers/electron-harness.ts';

test('main launches only the default Grok Bot path with a clean detached environment and a bounded hidden minimizer', async () => {
  const executable = 'C:\\Synthetic\\Programs\\Grok Bot\\Grok Bot.exe';
  const host = fakeHost('win32', {
    env: {
      LOCALAPPDATA: 'C:\\Synthetic',
      electron_run_as_node: '1',
      PUGPORT_WEB_BRIDGE: '1',
      COMBORUNNER_PORT: '4317',
      AGENT_STUDIO_PORT: '4317',
      Path: 'synthetic',
    },
    fs: fakeTree({ [executable]: 'file' }),
  });
  let unrefs = 0;
  let helpers = 0;
  const launch = ((command: string, args: readonly string[] | undefined, options?: SpawnOptions) => {
    assert.deepEqual(options?.env, { LOCALAPPDATA: 'C:\\Synthetic', Path: 'synthetic' });
    if (command === executable) {
      assert.equal(options?.stdio, 'ignore');
      assert.deepEqual(args, []);
      assert.equal(options?.detached, true);
      assert.equal(options?.windowsHide, undefined);
    } else {
      helpers++;
      assert.equal(options?.windowsHide, true);
      assert.match(command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.equal(options?.detached, undefined);
      assert.equal(options?.timeout, 40_000);
      assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'ignore']);
      assert.deepEqual(args?.slice(0, -1), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
      ]);
      const script = Buffer.from(args!.at(-1)!, 'base64').toString('utf16le');
      assert.match(script, /Get-Process -Id 123/);
      assert.match(script, /ToUnixTimeMilliseconds/);
      assert.match(script, /AddSeconds\(25\)/);
      assert.match(script, /ShowWindow\(\$hwnd, 7\)/);
      assert.match(script, /GetForegroundWindow\(\) -eq \$foreground/);
    }
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      unref: () => {
        unrefs++;
      },
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof spawn;
  await startGrokBot(host, launch);
  assert.equal(unrefs, 2);
  assert.equal(helpers, 1);
  assert.equal(host.env.electron_run_as_node, '1');
  await assert.rejects(
    startGrokBot(host, (() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('synthetic launch failure')));
      return child;
    }) as unknown as typeof spawn),
    /synthetic launch failure/,
  );
  await assert.rejects(
    startGrokBot(fakeHost('win32'), () => assert.fail('missing executable must not launch')),
    /not found/,
  );
});

for (const phase of ['before check', 'during check', 'poll', 'reconnect'] as const) {
  test(`stopping ${phase} cancels desktop preflight without further starts or polls`, async () => {
    let stopped = phase === 'before check';
    let checks = 0;
    let starts = 0;
    let clock = 0;
    assert.equal(
      await ensureGrokBotRunning({
        platform: 'win32',
        stopped: () => stopped,
        isRunning: async () => {
          checks++;
          if (phase === 'during check') stopped = true;
          return phase === 'reconnect' && checks > 1;
        },
        start: async () => {
          starts++;
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          stopped = true;
        },
      }),
      false,
    );
    assert.equal(starts, phase === 'poll' || phase === 'reconnect' ? 1 : 0);
    assert.equal(checks, phase === 'before check' ? 0 : phase === 'during check' ? 1 : 2);
    assert.equal(clock, phase === 'poll' ? 1000 : phase === 'reconnect' ? 5000 : 0);
  });
}

test('a Grok Bot process that exits during reconnect does not pass preflight', async () => {
  const states = [false, true, false];
  const waits: number[] = [];
  assert.equal(
    await ensureGrokBotRunning({
      platform: 'win32',
      isRunning: async () => states.shift()!,
      start: async () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    false,
  );
  assert.deepEqual(waits, [5000]);
});

for (const failure of ['throw', 'error', 'timeout'] as const) {
  test(`window helper ${failure} does not delay or reject the successful desktop launch`, async () => {
    const executable = 'C:\\Synthetic\\Programs\\Grok Bot\\Grok Bot.exe';
    const host = fakeHost('win32', {
      env: { LOCALAPPDATA: 'C:\\Synthetic' },
      fs: fakeTree({ [executable]: 'file' }),
    });
    let helper: EventEmitter | undefined;
    let posts = 0;
    const started = startGrokBot(host, ((command: string) => {
      if (command !== executable && failure === 'throw') throw new Error('synthetic helper failure');
      const child = Object.assign(new EventEmitter(), {
        pid: 123,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        unref() {},
      });
      if (command === executable) queueMicrotask(() => child.emit('spawn'));
      else helper = child;
      return child;
    }) as unknown as typeof spawn).then(() => {
      posts++;
    });
    await started;
    assert.equal(posts, 1, 'the send path continues before the helper finishes');
    if (failure === 'error') helper!.emit('error', new Error('synthetic PowerShell failure'));
    if (failure === 'timeout') helper!.emit('exit', null, 'SIGTERM');
    helper?.emit('close');
  });
}

for (const scenario of ['appears', 'old', 'focus', 'switched', 'switched back', 'background', 'new name'] as const) {
  test(`fake window management: ${scenario}`, async () => {
    const executable = 'C:\\Synthetic\\Programs\\Grok Bot\\Grok Bot.exe';
    const host = fakeHost('win32', { env: { LOCALAPPDATA: 'C:\\Synthetic' }, fs: fakeTree({ [executable]: 'file' }) });
    const commands: { window?: string; pid?: number; refocus: boolean }[] = [];
    const helper = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      unref() {},
      kill() {
        assert.fail('valid fake snapshots must not kill the helper');
      },
    });
    helper.stdin.on('data', (line) => commands.push(JSON.parse(line.toString())));
    await startGrokBot(
      host,
      ((command: string) => {
        if (command !== executable) return helper;
        const child = Object.assign(new EventEmitter(), { pid: 123, unref() {} });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }) as unknown as typeof spawn,
      scenario === 'background' ? undefined : Buffer.from([200, 1, 0, 0]),
    );
    const foregroundPid = ['focus', 'switched back', 'background'].includes(scenario)
      ? 123
      : scenario === 'switched'
        ? 999
        : 456;
    const foreground = foregroundPid === 123 ? '789' : foregroundPid === 999 ? '999' : '456';
    if (scenario === 'switched back')
      helper.stdout.write(JSON.stringify({ foreground: '999', foregroundPid: 999, processes: [] }) + '\n');
    const target = {
      pid: scenario === 'old' || scenario === 'new name' ? 222 : 123,
      name: 'Grok Bot',
      startedAt: scenario === 'old' ? 0 : Date.now() + 1000,
      window: '789',
    };
    helper.stdout.write(
      JSON.stringify({
        foreground,
        foregroundPid,
        processes: [
          { pid: 222, name: 'Grok Bot', startedAt: 0, window: '111' },
          { ...target, window: '0' },
        ],
      }) + '\n',
    );
    helper.stdout.write(JSON.stringify({ foreground, foregroundPid, processes: [target] }) + '\n');
    helper.stdout.write(JSON.stringify({ foreground, foregroundPid, processes: [target] }) + '\n');
    const minimized = commands.filter((action) => action.window);
    assert.equal(minimized.length, scenario === 'old' ? 0 : 1);
    if (scenario !== 'old')
      assert.deepEqual(minimized[0], { window: '789', pid: target.pid, refocus: scenario === 'focus' });
    assert.equal(commands.filter((action) => action.refocus).length, scenario === 'focus' ? 1 : 0);
    helper.emit('close');
  });
}

test('a similarly named process is not a newly launched Grok Bot', () => {
  assert.equal(
    grokWindowAction(123, 1000, '456', true, {
      foreground: '456',
      foregroundPid: 456,
      processes: [{ pid: 999, name: 'Other Grok Bot', startedAt: 2000, window: '789' }],
    }).target,
    undefined,
  );
});

test(
  'hidden PowerShell adapter skips an exited process and uses fake window APIs to minimize and refocus once',
  {
    // On GitHub's Windows runners PowerShell stalls before its first snapshot (issue #54).
    skip: process.platform !== 'win32' ? true : process.env.CI ? 'stalls on GitHub runners, see #54' : false,
  },
  async () => {
    const executable = 'C:\\Synthetic\\Programs\\Grok Bot\\Grok Bot.exe';
    const host = fakeHost('win32', { env: { LOCALAPPDATA: 'C:\\Synthetic' }, fs: fakeTree({ [executable]: 'file' }) });
    let finished!: Promise<void>;
    let calls = '';
    await startGrokBot(
      host,
      ((command: string, args: readonly string[], options: SpawnOptions) => {
        if (command === executable) {
          const child = Object.assign(new EventEmitter(), { pid: 123, unref() {} });
          queueMicrotask(() => child.emit('spawn'));
          return child;
        }
        // A PowerShell class stands in for the native window class, so the test needs no C# compiler
        // (Add-Type alone took over 10 s on CI runners).
        const script = Buffer.from(args.at(-1)!, 'base64')
          .toString('utf16le')
          .replace(
            /Add-Type @'[\s\S]*?'@/,
            () => `class GrokWindow {
  static [bool] IsWindowVisible([IntPtr]$hwnd) { return $hwnd.ToInt64() -eq 789 }
  static [IntPtr] GetForegroundWindow() { return [IntPtr]::new(789) }
  static [uint32] GetWindowThreadProcessId([IntPtr]$hwnd, [ref]$processId) { $processId.Value = [uint32]123; return 1 }
  static [bool] ShowWindow([IntPtr]$hwnd, [int]$command) { [Console]::Error.WriteLine('minimize=' + $hwnd + ':' + $command); return $true }
  static [bool] SetForegroundWindow([IntPtr]$hwnd) { [Console]::Error.WriteLine('focus=' + $hwnd); return $true }
}`,
          )
          .replace(
            /  \$targets = .*\r?\n/,
            `  $exited = [PSCustomObject]@{ Id = 999; ProcessName = 'Grok Bot'; MainWindowHandle = [IntPtr]::new(789) }
  $exited | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw 'synthetic process exited' }
  $targets = @($exited, [PSCustomObject]@{ Id = 123; ProcessName = 'Grok Bot'; StartTime = [DateTime]::Now; MainWindowHandle = [IntPtr]::new(789) })
`,
          );
        assert.doesNotMatch(script, /DllImport|user32|Get-Process/);
        assert.equal(options.windowsHide, true);
        const started = Date.now();
        let snapshots = 0;
        const child = nativeSpawn(command, [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')], {
          ...options,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        child.stdout.on('data', () => snapshots++);
        child.stderr.on('data', (data) => {
          calls += data.toString();
        });
        finished = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) resolve();
            // No stdout means PowerShell never reached the window loop; otherwise the loop stalled.
            else
              reject(
                new Error(
                  `fake PowerShell exited ${code} after ${Date.now() - started} ms, ${snapshots} stdout chunks: ${calls}`,
                ),
              );
          });
        });
        return child;
      }) as unknown as typeof spawn,
      Buffer.from([200, 1, 0, 0]),
    );
    await finished;
    assert.deepEqual(
      calls
        .trim()
        .split(/\r?\n/)
        .filter((line) => /^(minimize|focus)=/.test(line)),
      ['minimize=789:7', 'focus=456'],
    );
  },
);

test('tasklist allows ten seconds, matches the exact image and never launches without a main callback', async (t) => {
  let output = '"Grok Bot.exe","123","Console","1","10,000 K"';
  const run = t.mock.method(currentHost(), 'run', (async (file, args, options) => {
    assert.match(file, /System32[\\/]tasklist\.exe$/);
    assert.deepEqual(args, ['/FI', 'IMAGENAME eq Grok Bot.exe', '/FO', 'CSV', '/NH']);
    assert.equal(options?.timeout, 10_000);
    assert.equal(options?.windowsHide, true);
    return { stdout: output, stderr: '' };
  }) satisfies Host['run']);
  assert.equal(await ensureGrokBotRunning({ platform: 'win32' }), true);
  output = '"Other Grok Bot.exe","123"';
  assert.equal(await ensureGrokBotRunning({ platform: 'win32' }), false);
  assert.equal(run.mock.calls.length, 2);
});

test('test mode refuses the real Grok Bot launcher', async () => {
  await assert.rejects(startGrokBot(), /refused Grok Bot launch/);
});

test('main bridge dispatches minimized start without opening a protocol or a browser', async () => {
  let launches = 0;
  let fail: string | undefined;
  const { WebBridge } = await electronModule(
    'src/electron/web-bridge.ts',
    {
      shell: {
        openExternal() {
          assert.fail('must not activate protocol');
        },
      },
      BrowserWindow: class {
        constructor() {
          assert.fail('must not create browser');
        }
      },
    },
    {
      syntheticLaunch: async (_host: unknown, _launch: unknown, handle: Buffer) => {
        assert.equal(handle.readUInt32LE(), 456);
        launches++;
        if (fail) throw Object.assign(new Error('synthetic failure'), { name: fail });
      },
    },
    {
      './grok-bot-launch.ts': 'export const startGrokBot = globalThis.syntheticLaunch;',
    },
  );
  const bridge = new WebBridge({
    port: 1234,
    mainWindow: () => ({
      isDestroyed: () => false,
      isFocused: () => true,
      getNativeWindowHandle: () => Buffer.from([200, 1, 0, 0]),
    }),
  });
  const request = { action: 'desktop-start-minimized', agentId: 'grok-bot', url: 'arbitrary ignored input' };
  assert.equal((await bridge.handle(request)).ok, true);
  fail = 'Error';
  assert.deepEqual({ ...(await bridge.handle(request)) }, { ok: false, code: 'error' });
  fail = 'GrokBotNotInstalledError';
  assert.deepEqual({ ...(await bridge.handle(request)) }, { ok: false, code: 'not-installed' });
  assert.equal((await bridge.handle({ ...request, agentId: 'muse' })).ok, false);
  bridge.dispose();
  assert.equal((await bridge.handle(request)).code, 'closed');
  assert.equal(launches, 3);
});
