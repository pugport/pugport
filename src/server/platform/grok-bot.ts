import { currentHost, type Host } from './host.ts';

/*
 * The Grok Bot desktop app, which must be running for a routine's reply to come back.
 *  - Windows: the image name `Grok Bot.exe` in tasklist; started from its default install folder (grok-bot-launch.ts).
 *  - macOS: the bundle identifier, looked up in LaunchServices' list of running apps and started with `open -b`.
 *  - Elsewhere there is no desktop app to check.
 */

/** `CFBundleIdentifier` of Grok Bot.app. */
export const grokBotBundleId = 'com.anysphere.sand';

/** Whether a routine first makes sure the Grok Bot desktop app is running on this system. */
export function grokBotDesktopChecked(host: Host = currentHost()): boolean {
  return host.platform === 'win32' || host.platform === 'darwin';
}

/** Whether the Grok Bot desktop app is running. Rejects when the check itself cannot run. */
export async function grokBotRunning(host: Host = currentHost()): Promise<boolean> {
  if (host.platform === 'darwin') {
    // Matched on the bundle id, not a (localised) name; prints `ASN:…` per running app, exits 0 either way.
    const { stdout } = await host.run('/usr/bin/lsappinfo', ['find', `bundleid=${grokBotBundleId}`], {
      timeout: 10_000,
    });
    return /^ASN:/m.test(stdout);
  }
  const { stdout } = await host.run(
    host.path.join(host.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
    ['/FI', 'IMAGENAME eq Grok Bot.exe', '/FO', 'CSV', '/NH'],
    {
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return /^"Grok Bot\.exe",/im.test(stdout);
}

/** macOS starts Grok Bot through LaunchServices by bundle id; Windows runs its executable directly. */
export function grokBotOpensByBundleId(host: Host = currentHost()): boolean {
  return host.platform === 'darwin';
}

/** No installed app has Grok Bot's bundle id: the user has to install it before a routine can be sent. */
export class GrokBotNotInstalledError extends Error {
  constructor() {
    super(`Grok Bot app not found: no installed app has the bundle id ${grokBotBundleId}`);
    this.name = 'GrokBotNotInstalledError';
  }
}

/**
 * macOS: starts Grok Bot hidden (-j) and behind the current app (-g), so PugPort keeps the focus, as Windows does by
 * minimizing the new window. `open` returns once the launch has begun; the caller waits for the app to appear.
 */
export async function openGrokBot(env: NodeJS.ProcessEnv, host: Host = currentHost()): Promise<void> {
  try {
    await host.run('/usr/bin/open', ['-g', '-j', '-b', grokBotBundleId], { env, timeout: 10_000 });
  } catch (error) {
    // `open` names the bundle identifier only when LaunchServices has no app for it; other failures pass on.
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    if (typeof stderr === 'string' && stderr.includes(`bundle identifier ${grokBotBundleId}`))
      throw new GrokBotNotInstalledError();
    throw error;
  }
}
