// Real HTTP/IPC boundary with synthetic learning observations and no executor or MCP launches.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { Controller } from '../../src/server/controller.ts';
import { ExtensionHub } from '../../src/server/extensions.ts';
import { LearningStore } from '../../src/server/sandbox/learning-store.ts';
import { parseLearningReport } from '../../src/server/sandbox/learning-report.ts';

if (process.env.PUGPORT_TEST_CALLER_PROBE === '1') {
  // The tools that find the peer of a connection fail here on every platform, so the caller is never identified,
  // until the test asks for the real ones ({ type: 'caller-probe-mode', real: true }; not used on Windows).
  let real = false;
  process.on('message', (message: any) => {
    if (message?.type !== 'caller-probe-mode') return;
    real = message.real === true;
    process.send?.({ type: 'caller-probe-mode', real });
  });
  const original = childProcess.execFile;
  const fails = (file: string) => {
    if (real || !/netstat\.exe$|powershell\.exe$|^\/usr\/sbin\/netstat$|^\/usr\/bin\/nettop$|^lsof$|^ss$/.test(file))
      return false;
    if (/netstat(\.exe)?$|^ss$/.test(file)) process.send?.({ type: 'caller-probe' });
    return true;
  };
  const patched = (file: string, ...args: any[]) => {
    if (fails(file)) {
      setImmediate(() => args.at(-1)(new Error('synthetic probe failure'), '', ''));
      return {};
    }
    return (original as any)(file, ...args);
  };
  // promisify(execFile) answers { stdout, stderr } through this; without it the real tools' output would be lost.
  (patched as any)[promisify.custom] = (file: string, ...args: any[]) =>
    fails(file) ? Promise.reject(new Error('synthetic probe failure')) : (promisify(original) as any)(file, ...args);
  (childProcess as any).execFile = patched;
  syncBuiltinESMExports();
}
Controller.prototype.refresh = async () => {};
ExtensionHub.prototype.check = async () => [];
const selection = LearningStore.prototype.selection;
LearningStore.prototype.selection = function (provider, ids) {
  this.record({
    provider: 'pi',
    observedAt: 'synthetic',
    groups: [],
    ...parseLearningReport({
      denials: [{ resource: 'C:/synthetic/allowed.txt', resourceType: 'file', accessType: 'read' }],
    }),
  });
  return selection.call(this, provider, ids);
};
await import('../../src/server/main.ts');
