import { setTimeout as sleep } from 'node:timers/promises';
import { currentHost, type Host } from '../platform/host.ts';
import { grokBotDesktopChecked, grokBotRunning } from '../platform/grok-bot.ts';

export const grokDesktopRequiredNote = 'Grok Bot 桌面应用没有运行，回复送不回来。请先打开 Grok Bot 再重试。';
export const grokDesktopMissingNote = '这台电脑上没有找到 Grok Bot 桌面应用，回复送不回来。请先安装 Grok Bot 再重试。';

export async function ensureGrokBotRunning(
  options: {
    /** The machine whose Grok Bot app is checked (default: this one). */
    host?: Host;
    /** Replaces the host's platform (tests). */
    platform?: NodeJS.Platform;
    isRunning?: () => Promise<boolean>;
    start?: () => Promise<void>;
    stopped?: () => boolean;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (options.stopped?.()) return false;
  const machine = options.host ?? currentHost();
  const host = options.platform ? { ...machine, platform: options.platform } : machine;
  if (!grokBotDesktopChecked(host)) return true;
  const running = options.isRunning ?? (() => grokBotRunning(host));
  const wait = options.sleep ?? sleep;
  const now = options.now ?? (() => performance.now());
  try {
    if (await running()) return !options.stopped?.();
    if (!options.start || options.stopped?.()) return false;
    await options.start();
    const deadline = now() + 20_000;
    while (now() < deadline) {
      if (options.stopped?.()) return false;
      const up = await running();
      if (options.stopped?.()) return false;
      if (up) {
        await wait(5000);
        if (options.stopped?.()) return false;
        return (await running()) && !options.stopped?.();
      }
      await wait(Math.min(1000, Math.max(0, deadline - now())));
    }
  } catch {
    // Do not bill a routine when its desktop reply path is unavailable.
  }
  return false;
}
