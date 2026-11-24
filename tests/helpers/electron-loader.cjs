'use strict';
// Tests start every Electron app through this file (electronArgs in electron-app.cjs). Electron's built-in default
// app opens a modal "Error launching app" box on the owner's desktop when the app it is given is missing or throws
// while loading, and Electron opens another box for an uncaught main-process error. Here each is printed and the
// process exits with code 1 instead, so a broken test can never leave a window behind.
let failed = false;
let app;
function fail(error) {
  if (failed) return;
  failed = true;
  const exit = () => (app ? app.exit(1) : process.exit(1));
  setTimeout(exit, 1000);
  process.stderr.write(`electron-loader: ${error?.stack ?? error}\n`, exit);
}
process.on('uncaughtException', fail);
// 'electron/main', not 'electron': offscreen-electron.cjs, preloaded through NODE_OPTIONS from this same folder,
// resolves 'electron' before Electron serves its API, and Node then hands this file the npm package's path instead.
const electron = require('electron/main');
app = electron.app;
// Every test app gets the shared offscreen capture handling, not only those started with offscreenElectronEnv. Hosted
// macOS paints offscreen frames slowly, and a capture just after a resize then fails with UnknownVizError unless it
// waits. 0 keeps each window's own frame rate.
require('./offscreen-electron.cjs').installOffscreenElectron(electron, 0);
// A new window is shrunk to the display's work area. Hosted Windows runners have a 1024x768 screen, so a test that
// asked for a 1300x760 or 1120x1100 page got a 1024x728 one, and its layout and screenshot checks measured a size
// nobody asked for. Every window keeps the size its test gave; later setSize calls are not shrunk.
// A construct trap, not a subclass: callers still get a plain BrowserWindow, and static methods such as
// getAllWindows behave exactly as Electron's own.
const RequestedSizeWindow = new Proxy(electron.BrowserWindow, {
  construct(target, args, newTarget) {
    const window = Reflect.construct(target, args, newTarget === RequestedSizeWindow ? target : newTarget);
    const options = args[0] ?? {};
    const resize = options.useContentSize ? 'ContentSize' : 'Size';
    const [width, height] = window[`get${resize}`]();
    const wanted = [options.width ?? width, options.height ?? height];
    if (wanted[0] !== width || wanted[1] !== height) window[`set${resize}`](...wanted);
    return window;
  },
});
// Electron's exports cannot be redefined, so the app is handed a view of them that serves this BrowserWindow.
const electronForApp = new Proxy(electron, {
  get: (target, name) => (name === 'BrowserWindow' ? RequestedSizeWindow : Reflect.get(target, name)),
});
const Module = require('node:module');
const load = Module._load;
Module._load = function loadElectronForApp(request, ...rest) {
  const exported = load.call(this, request, ...rest);
  return exported === electron ? electronForApp : exported;
};
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
// An app (or the code it tests) may still call the error box itself; a test that wants to see it replaces this.
electron.dialog.showErrorBox = (title, content) => fail(`${title}\n${content}`);
// The app sees the arguments it would get if Electron had started it directly: [electron, app, ...rest].
process.argv.splice(1, 1);
const target = process.argv[1];
try {
  if (!target) throw new Error('no app given');
  const path = resolve(target);
  const file = require.resolve(path);
  // As Electron's default app does: a folder's package.json names the app, and the app path is the folder (or the
  // script's own folder), not this loader's.
  const manifest = join(path, 'package.json');
  if (existsSync(manifest)) {
    const { name, productName, version } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (version) app.setVersion(version);
    if (productName || name) app.name = productName || name;
  }
  app.setAppPath(existsSync(manifest) ? path : dirname(file));
  require(file);
} catch (error) {
  fail(error);
}
