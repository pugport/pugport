import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import test from 'node:test';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

const checks: Record<string, RegExp> = {
  'background-tasks-ui.cjs': /"passed":true/,
  'composer-a67-renderer-smoke.cjs': /"passed":[1-9]\d*,"failed":0/,
  'confirm-keyboard-renderer-smoke.cjs': /PASS confirmation keyboard: false,true/,
  'coordinator-ui-renderer-smoke.cjs': /PASS coordinator UI renderer:/,
  'conversation-creation-renderer-smoke.cjs': /PASS Studio creation renderer/,
  'conversation-queue-renderer-smoke.cjs': /PASS queue renderer/,
  'conversation-screenshots-renderer-smoke.cjs': /PASS conversation screenshots renderer:/,
  'conversation-timeline-renderer-smoke.cjs': /PASS timeline renderer/,
  'conversation-trace-renderer-smoke.cjs': /Conversation Trace renderer smoke passed/,
  'empty-composer-renderer-smoke.cjs': /PASS empty composer Enter/,
  'extensions-store-renderer-smoke.cjs': /PASS extensions renderer/,
  'external-agents-renderer-smoke.cjs': /PASS external agents renderer/,
  'hindsight-settings-renderer-smoke.cjs':
    /Hindsight renderer: collapsed default, configuration save, explicit enable, missing dependency, explicit project forgetting, narrow layout and screenshots passed\./,
  'incognito-renderer-smoke.cjs': /PASS incognito renderer: \d+ checks, 0 failures/,
  'media-workflows-ui.cjs': /PASS media workflow UI/,
  'mention-picker-renderer-smoke.cjs': /mention picker smoke passed/,
  'message-branch-renderer-smoke.cjs': /PASS renderer: render, cancel/,
  'model-discovery-renderer-smoke.cjs': /PASS exact manual picker ID/,
  'model-picker-renderer-smoke.cjs': /PASS long model picker renderer/,
  'permission-reasons-renderer-smoke.cjs': /PASS: read-only role/,
  'pinned-messages-renderer-smoke.cjs': /PASS pinned messages renderer/,
  'pinned-rail-renderer-smoke.cjs': /PASS pinned rail renderer/,
  'project-removal-renderer-smoke.cjs': /PASS project renderer/,
  'quick-chat-renderer-smoke.cjs': /Quick chat renderer smoke: \d+ passed, 0 failed/,
  'quota-stability-ui.cjs': /"passed":true/,
  'reasoning-stream-renderer-smoke.cjs': /Reasoning renderer smoke passed/,
  'resume-marker-renderer-smoke.cjs': /PASS: traceless completed continuation/,
  'search-renderer-smoke.cjs': /PASS search renderer/,
  'server-enroll-renderer-smoke.cjs': /Hidden server enrollment renderer passed/,
  'settings-categories-renderer-smoke.cjs': /PASS settings categories renderer/,
  'submit-renderer-smoke.cjs': /PASS submit renderer/,
  'table-reader-ui.cjs': /"passed":true/,
  'trace-context-renderer-smoke.cjs': /Trace Context renderer smoke passed/,
  'tray-resources-renderer-smoke.cjs': /"passed":true/,
  'ui-polish-renderer-smoke.cjs': /PASS ui-polish renderer/,
  'web-bridge-renderer-smoke.cjs': /PASS web bridge/,
  'web-search-settings-renderer-smoke.cjs': /PASS web search settings renderer:/,
  'workflow-elapsed-renderer-smoke.cjs': /Workflow elapsed renderer smoke passed/,
  'workspace-side-chat-renderer-smoke.cjs': /PASS workspace side-chat mount/,
};

assert.deepEqual(
  Object.keys(checks).sort(),
  readdirSync('tests')
    .filter((name) => name.endsWith('.cjs'))
    .sort(),
  'Every standalone renderer check must be registered in the default suite.',
);

for (const [script, success] of Object.entries(checks)) {
  test(`Electron: ${script}`, { timeout: 180000, concurrency: false }, async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [`tests/${script}`], {
      cwd: process.cwd(),
      env: offscreenElectronEnv(),
      windowsHide: true,
      timeout: 175000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.match(stdout, success, `${script} must finish its checks, not only exit cleanly.`);
    assert.doesNotMatch(stderr, /AssertionError|TypeError|ReferenceError/);
  });
}
