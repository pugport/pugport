'use strict';

const Module = require('node:module');

const selfPath = __filename.replace(/\\/g, '/');
const requireFlag = `--require ${selfPath}`;

function offscreenElectronEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const current = env.NODE_OPTIONS || '';
  if (!current.includes(selfPath)) {
    env.NODE_OPTIONS = current ? `${current} ${requireFlag}` : requireFlag;
  }
  return env;
}

function installOffscreenElectron(electron, frameRate = 240) {
  const app = electron?.app;
  if (!app) return;
  // electron-loader.cjs installs the rest for every app but passes 0: many tests count frames in their waits, so a
  // faster frame rate would shorten them. This NODE_OPTIONS preload still raises it for its own apps.
  if (frameRate && !app.__offscreenFrameRate) {
    app.__offscreenFrameRate = frameRate;
    app.on('browser-window-created', (_event, win) => {
      try {
        if (win?.webContents?.isOffscreen?.()) win.webContents.setFrameRate?.(frameRate);
      } catch {}
    });
  }
  if (app.__offscreenInstalled) return;
  app.__offscreenInstalled = true;

  const origExit = app.exit.bind(app);
  let exiting = false;
  app.exit = (exitCode = 0) => {
    if (exiting) return;
    exiting = true;
    const finish = () => origExit(exitCode);
    try {
      if (process.stdout && process.stdout.writable && !process.stdout.writableEnded) {
        const timer = setTimeout(finish, 200);
        timer.unref?.();
        process.stdout.write('', () => {
          clearTimeout(timer);
          finish();
        });
        return;
      }
    } catch {}
    finish();
  };

  app.on('browser-window-created', (_event, win) => {
    if (!win || win.__offscreenPatched) return;
    win.__offscreenPatched = true;
    const wc = win.webContents;
    if (!wc) return;

    let paintWaiters = [];
    wc.on('paint', (_e, _dirty, image) => {
      for (const resolve of paintWaiters.splice(0)) resolve(image);
    });

    let resizedAt = 0;
    for (const method of ['setSize', 'setContentSize']) {
      if (typeof win[method] === 'function') {
        const origResize = win[method].bind(win);
        win[method] = (width, height, animate) => {
          resizedAt = Date.now();
          origResize(width, height, animate);
          try {
            wc.invalidate?.();
          } catch {}
        };
      }
    }

    if (typeof wc.capturePage === 'function') {
      const origCapture = wc.capturePage.bind(wc);
      const waitFrame = async (attempt) => {
        try {
          wc.invalidate?.();
          await Promise.race([
            new Promise((resolve) => paintWaiters.push(resolve)),
            wc.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))').catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 40 * attempt)),
          ]);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      };

      const resilientCapture = async (rect, opts) => {
        const mergedOpts = { stayHidden: true, stayAwake: true, ...(opts || {}) };
        if (Date.now() - resizedAt < 60) {
          await waitFrame(1);
        }
        let lastError;
        for (let attempt = 1; attempt <= 8; attempt++) {
          try {
            const image =
              rect !== undefined ? await origCapture(rect, mergedOpts) : await origCapture(undefined, mergedOpts);
            const size = image?.getSize?.();
            if (size && size.width > 0 && size.height > 0) return image;
          } catch (error) {
            lastError = error;
            if (!String(error).includes('UnknownVizError')) throw error;
          }
          await waitFrame(attempt);
        }
        throw lastError || new Error('UnknownVizError');
      };

      wc.capturePage = resilientCapture;
      win.capturePage = resilientCapture;
    }
  });
}

// Only as the NODE_OPTIONS preload: electron-loader.cjs requires this file too and installs it with its own frame rate.
if (process.versions?.electron && (process.env.NODE_OPTIONS || '').includes(selfPath)) {
  if (!Module.__offscreenLoadHooked) {
    Module.__offscreenLoadHooked = true;
    const origLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain, ...rest) {
      const exported = origLoad.call(this, request, parent, isMain, ...rest);
      if (request === 'electron' && exported && typeof exported === 'object' && exported.app) {
        installOffscreenElectron(exported);
      }
      return exported;
    };
  }
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.app) {
      installOffscreenElectron(electron);
    }
  } catch {}
}

module.exports = {
  offscreenElectronEnv,
  installOffscreenElectron,
  offscreenRequirePath: selfPath,
};
