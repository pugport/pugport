import { readSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { once } from 'node:events';
import { Agent, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSettingsNarrowing, assertTargetCommandNarrowing } from '../src/server/permission-guards.ts';
import { permissionChangeSchema } from '../src/shared/permission-change.ts';
import { normalizeModManifest } from '../src/shared/mods-manifest.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { parseLearningReport } from '../src/server/sandbox/learning-report.ts';
import { electronModule } from './helpers/electron-harness.ts';
import type { Settings } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';

test('settings compare every provider, map omissions, defaults and only changed relaxing values', () => {
  const current = {
    sandbox: { pi: 'enforce', codex: 'learn' },
    sandboxWhenUnavailable: 'stop',
    toolApprovalMode: 'ask',
    autoUseResetCards: false,
  } as Settings;
  for (const patch of [
    { sandbox: { pi: 'learn', codex: 'learn' } },
    { sandbox: { pi: 'enforce' } },
    { sandbox: {} },
    { sandboxWhenUnavailable: 'run-as-today' },
    { toolApprovalMode: 'auto' },
    { autoUseResetCards: true },
  ] as Partial<Settings>[])
    assert.throws(() => assertSettingsNarrowing(current, patch), { status: 403 });
  assertSettingsNarrowing(current, {});
  assertSettingsNarrowing(current, { ...current, sandbox: { pi: 'enforce', codex: 'enforce' }, reservePercent: 30 });
  assertSettingsNarrowing({} as Settings, {
    sandbox: {},
    sandboxWhenUnavailable: 'stop',
    toolApprovalMode: 'ask',
    autoUseResetCards: false,
  });
  const relaxed = {
    sandbox: {},
    sandboxWhenUnavailable: 'run-as-today',
    toolApprovalMode: 'auto',
    autoUseResetCards: true,
  } as Settings;
  assertSettingsNarrowing(relaxed, relaxed);
  assert.equal(
    permissionChangeSchema.safeParse({ kind: 'settings', patch: { externalCallers: { codex: 'write' } } }).success,
    false,
  );
});

test('native settings confirmation names only relaxed protections and cancellation writes nothing', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const settings = {
    sandbox: { pi: 'enforce', codex: 'learn' },
    sandboxWhenUnavailable: 'stop',
    toolApprovalMode: 'ask',
  } as Settings;
  const writes: unknown[] = [];
  const workspace = {
    controller: {
      settings,
      updateSettings(patch: Partial<Settings>) {
        writes.push(patch);
        Object.assign(settings, patch);
      },
    },
  } as unknown as Workspace;
  const frame = { url: 'http://127.0.0.1:4317' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  let response = 0;
  const handler = createPermissionChange(
    () => window,
    frame.url,
    async (_owner: unknown, options: any) => {
      assert.match(options.message, /pi\n强制模式 → 学习模式/);
      assert.match(options.message, /codex\n学习模式 → 关闭沙箱/);
      for (const label of ['沙箱不可用时仍然运行', '工具调用自动批准', '自动使用重置卡'])
        assert.ok(options.message.includes(label));
      return { response };
    },
    (change: unknown, apply: boolean, expected?: string) => desktopPermissionChange(workspace, change, apply, expected),
  );
  const change = {
    kind: 'settings',
    patch: {
      sandbox: { pi: 'learn' },
      sandboxWhenUnavailable: 'run-as-today',
      toolApprovalMode: 'auto',
      autoUseResetCards: true,
    },
  };
  assert.equal(await handler(event, change), false);
  assert.equal(writes.length, 0);
  response = 1;
  assert.equal(await handler(event, change), true);
  assert.equal(writes.length, 1);
  assert.equal(settings.autoUseResetCards, true);
});

test('unchanged executor command and equivalent omitted args need no confirmation', () => {
  const target = { command: 'synthetic', args: ['one'] } as any;
  assertTargetCommandNarrowing(target, { command: 'synthetic', args: ['one'], enabled: false });
  assertTargetCommandNarrowing({ ...target, args: undefined }, { args: [] });
  assert.throws(() => assertTargetCommandNarrowing(target, { command: 'other' }), { status: 403 });
  assert.throws(() => assertTargetCommandNarrowing(target, { args: ['two'] }), { status: 403 });
});

test('every new native permission kind cancels without applying and rejects non-owner frames', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const frame = { url: 'http://127.0.0.1:4317' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  for (const change of [
    { kind: 'target-command', id: 'synthetic', patch: { command: 'synthetic', args: ['one'] } },
    { kind: 'extension-command', action: 'install', token: 'synthetic', keys: ['mcp:0'] },
    { kind: 'extension-command', action: 'configure', id: 'synthetic', values: { SYNTHETIC: 'value' } },
    { kind: 'sandbox-adopt', provider: 'pi', ids: ['a'.repeat(64)] },
    { kind: 'verification', projectId: 'synthetic', command: 'synthetic exact' },
  ]) {
    const calls: boolean[] = [];
    let response = 0;
    const handler = createPermissionChange(
      () => window,
      frame.url,
      async (_owner: unknown, options: any) => {
        assert.equal(options.message, 'synthetic command');
        return { response };
      },
      async (_change: unknown, apply: boolean, expected?: string) => {
        calls.push(apply);
        if (apply) assert.equal(expected, 'synthetic command');
        return 'synthetic command';
      },
    );
    assert.equal(await handler(event, change), false);
    assert.deepEqual(calls, [false]);
    response = 1;
    assert.equal(await handler(event, change), true);
    assert.deepEqual(calls, [false, false, true]);
    await assert.rejects(handler({ ...event, senderFrame: { url: frame.url } }, change), /主窗口/);
    assert.deepEqual(calls, [false, false, true]);
  }
});

test('unchanged native command uses no dialog and still revalidates before applying', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const frame = { url: 'http://127.0.0.1:4317' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const calls: boolean[] = [];
  const handler = createPermissionChange(
    () => window,
    frame.url,
    async () => assert.fail('unchanged commands need no dialog'),
    async (_change: unknown, apply: boolean, expected?: string) => {
      calls.push(apply);
      if (apply) assert.equal(expected, '');
      return '';
    },
  );
  assert.equal(
    await handler(
      { sender: window.webContents, senderFrame: frame },
      { kind: 'target-command', id: 'synthetic', patch: { command: 'synthetic' } },
    ),
    true,
  );
  assert.deepEqual(calls, [false, true]);
});

test(
  'real HTTP refuses relaxing changes; owned desktop IPC applies settings, target, MCP and learning changes',
  { timeout: 60000 },
  async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'pugport-api-security-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_STUDIO_PORT: '0',
      COMBORUNNER_DATA_DIR: join(scratch, 'data'),
      PUGPORT_ROLE: 'node',
      PUGPORT_TEST_CALLER_PROBE: '1',
      PUGPORT_NODE_FEATURES: '',
    };
    for (const name of [
      'COMBORUNNER_SECRETS_DIR',
      'COMBORUNNER_EXTENSIONS_DIR',
      'COMBORUNNER_MEMORY_DIR',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'CURSOR_CONFIG_DIR',
    ]) {
      env[name] = join(scratch, name);
      mkdirSync(env[name]!, { recursive: true });
    }
    const child = fork(resolve('tests/helpers/security-backend.ts'), [], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let diagnostics = '';
    child.stdout?.resume();
    child.stderr?.on('data', (data) => {
      diagnostics += String(data);
    });
    let sessionFile: string | undefined;
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.send('shutdown');
        const timer = setTimeout(() => child.kill(), 10000);
        await exited;
        clearTimeout(timer);
      }
      if (sessionFile) assert.equal(existsSync(sessionFile), false);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    let probeCount = 0;
    child.on('message', (message: any) => {
      if (message.type === 'caller-probe') probeCount++;
    });
    let earlySession: string | undefined;
    let earlyOwner: string | undefined;
    const ready = await new Promise<any>((done, fail) => {
      child.on('message', (message: any) => {
        if (message.type === 'session') {
          earlySession = message.token;
          earlyOwner = message.owner;
        }
        if (message.type === 'ready') done(message);
      });
      child.once('exit', (code) => fail(new Error(`backend exit ${code}: ${diagnostics}`)));
    });
    const base = `http://127.0.0.1:${ready.port}`;
    assert.equal((await fetch(base + '/api/session')).status, 403);
    const session = (await fetch(base + '/api/session', { headers: { 'x-agent-token': earlySession! } }).then(
      (response) => response.json(),
    )) as any;
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-agent-token': earlySession! } })).status, 200);
    assert.equal((await fetch(base + '/api/events')).status, 403);
    sessionFile = join(
      env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']!,
      '.pugport',
      `session-${ready.port}.json`,
    );
    assert.ok(earlySession);
    assert.match(earlyOwner ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(earlyOwner, earlySession);
    assert.doesNotMatch(readFileSync(sessionFile, 'utf8'), new RegExp(earlyOwner!));
    assert.doesNotMatch(JSON.stringify(session), new RegExp(earlyOwner!));
    assert.equal(readSessionToken(ready.port, sessionFile), earlySession);
    assert.equal(session.token, earlySession);
    const apiWrite = (path: string, body: unknown, extra: Record<string, string> = {}, method = 'POST') =>
      fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-agent-token': earlySession!, ...extra },
        body: JSON.stringify(body),
      });
    assert.equal((await apiWrite('/api/settings', {}, {}, 'PATCH')).status, 403);
    assert.equal((await apiWrite('/api/settings', {}, { 'x-pugport-owner': earlyOwner! }, 'PATCH')).status, 200);
    const created = await apiWrite('/api/projects', { path: scratch });
    assert.equal(created.status, 201);
    const gateProject = (await created.json()) as any;
    const gatePath = `/api/projects/${gateProject.id}/gates`;
    const tight = { gates: { version: 1, text: { block: ['synthetic secret'] } } };
    assert.equal((await apiWrite(gatePath, tight, {}, 'PATCH')).status, 403);
    assert.equal((await apiWrite(gatePath, tight, { 'x-pugport-executor': '1' }, 'PATCH')).status, 403);
    const saved = await apiWrite(gatePath, tight, { 'x-pugport-owner': earlyOwner! }, 'PATCH');
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as any).gates.text.block, ['synthetic secret']);
    assert.equal(
      (await apiWrite(gatePath, { gates: { version: 1 } }, { 'x-pugport-owner': earlyOwner! }, 'PATCH')).status,
      403,
    );
    const gateState = (await (
      await fetch(base + '/api/state', { headers: { 'x-agent-token': earlySession! } })
    ).json()) as any;
    assert.deepEqual(gateState.projects.find((item: any) => item.id === gateProject.id).gates.text.block, [
      'synthetic secret',
    ]);

    // The synthetic probe fails, so a file-token caller is not identified here: its owner-level writes are refused
    // for now with a retry hint, an executor keeps its 403, and the desktop window's owner value needs no lookup.
    const refusedForNow = async (path: string, method: string) => {
      const response = await apiWrite(path, {}, {}, method);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get('retry-after'), '2', path);
      assert.match(((await response.json()) as any).error, /could not identify/, path);
    };
    const incognito = (await (await apiWrite('/api/conversations', { incognito: true })).json()) as any;
    const ownerLevelWrites = [
      ['POST', '/api/conversations/00000000-0000-4000-8000-000000000001/messages'],
      ['POST', '/api/conversations/00000000-0000-4000-8000-000000000001/work/lanes'],
      // Soft deletes stay open to local clients for cleanup, never to PugPort's own executors.
      ['DELETE', '/api/conversations/00000000-0000-4000-8000-000000000001'],
      ['DELETE', '/api/projects/00000000-0000-4000-8000-000000000001'],
      ['DELETE', `/api/conversations/${incognito.id}`],
      // Pairing codes, unpairing and cancelling stay open to the owner's terminal, never to executors.
      ['POST', '/api/node/pairing'],
      ['DELETE', '/api/node/peers'],
      ['DELETE', '/api/node/peers/00000000-0000-4000-8000-000000000001'],
      ['POST', '/api/workflows/00000000-0000-4000-8000-000000000001/cancel'],
    ] as const;
    for (const [method, path] of ownerLevelWrites) {
      assert.equal((await apiWrite(path, {}, { 'x-pugport-executor': '1' }, method)).status, 403, path);
      await refusedForNow(path, method);
    }
    for (const path of [
      '/api/conversations/00000000-0000-4000-8000-000000000001/messages',
      '/api/conversations/00000000-0000-4000-8000-000000000001/work/lanes',
    ]) {
      const asOwner = await apiWrite(path, {}, { 'x-pugport-executor': '1', 'x-pugport-owner': earlyOwner! });
      assert.equal([403, 503].includes(asOwner.status), false, path);
    }
    if (process.platform !== 'win32') {
      // With the system tools back, this test process is identified as another local program: its writes reach
      // their handlers again, on new connections and on ones whose earlier lookups failed.
      const probeMode = async (real: boolean) => {
        const switched = new Promise<void>((done) => {
          const listener = (message: any) => {
            if (message.type !== 'caller-probe-mode') return;
            child.off('message', listener);
            done();
          };
          child.on('message', listener);
        });
        child.send({ type: 'caller-probe-mode', real });
        await switched;
      };
      await probeMode(true);
      for (const [method, path] of ownerLevelWrites) {
        const response = await apiWrite(path, {}, {}, method);
        assert.equal(response.status === 503 || response.headers.has('retry-after'), false, path);
        if (path !== `/api/conversations/${incognito.id}`) assert.notEqual(response.status, 403, path);
        // Deleting an incognito chat closes it for good, so it needs the owner.
        else assert.equal(response.status, 403);
      }
      await probeMode(false);
    }
    assert.equal(
      (await apiWrite(`/api/projects/${incognito.projectId}/gates`, tight, { 'x-pugport-owner': earlyOwner! }, 'PATCH'))
        .status,
      400,
    );
    assert.equal(
      (await apiWrite(`/api/conversations/${incognito.id}`, {}, { 'x-pugport-owner': earlyOwner! }, 'DELETE')).status,
      200,
    );
    {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const write = () =>
        new Promise<number>((done, fail) => {
          const req = httpRequest(
            base + '/api/conversations/00000000-0000-4000-8000-000000000001/messages',
            {
              method: 'POST',
              agent,
              headers: { 'content-type': 'application/json', 'x-agent-token': earlySession! },
            },
            (response) => {
              response.resume();
              response.on('end', () => done(response.statusCode!));
            },
          );
          req.on('error', fail);
          req.end('{}');
        });
      const before = probeCount;
      const statuses = [await write(), await write()];
      agent.destroy();
      await new Promise((done) => setTimeout(done, 50));
      // The synthetic probe always fails; a failure is not remembered for the connection.
      assert.equal(probeCount - before, 2, 'a failed probe is asked again on the same socket');
      assert.deepEqual(statuses, [503, 503]);
    }
    // A device node on this computer looks for role: 'desktop' before handing tasks over.
    assert.equal(((await fetch(base + '/api/health').then((response) => response.json())) as any).role, 'node');
    for (const path of [
      '/api/modes/source',
      `/api/modes/source/example.notes/versions/1.0.0/export?revision=${'a'.repeat(40)}`,
    ]) {
      assert.equal((await fetch(base + path)).status, 403);
      assert.equal((await fetch(base + path, { headers: { 'x-agent-token': 'wrong' } })).status, 403);
    }
    const sourceView = await fetch(base + '/api/modes/source', { headers: { 'x-agent-token': session.token } });
    assert.equal(sourceView.status, 200);
    assert.deepEqual(await sourceView.json(), { config: null, status: 'unconfigured', catalog: [] });
    async function http(path: string, body: unknown, method = 'POST') {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-agent-token': session.token, 'x-pugport-owner': earlyOwner! },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    let requestId = 0;
    async function ipc(change: unknown, apply: boolean, expected?: string) {
      const id = ++requestId;
      return new Promise<string>((done, fail) => {
        const listener = (message: any) => {
          if (message.type !== 'permission-change-result' || message.requestId !== id) return;
          child.off('message', listener);
          if (message.error) fail(new Error(message.error));
          else done(message.description);
        };
        child.on('message', listener);
        child.send({ type: 'permission-change', requestId: id, change, apply, expected });
      });
    }
    const desktop = async (change: unknown) => ipc(change, true, await ipc(change, false));
    const state = () =>
      fetch(base + '/api/state', { headers: { 'x-agent-token': session.token } }).then((response) =>
        response.json(),
      ) as Promise<any>;
    assert.equal(
      (
        await http(
          '/api/settings',
          {
            sandbox: { pi: 'enforce', codex: 'learn' },
            toolApprovalMode: 'ask',
            autoUseResetCards: false,
            sandboxWhenUnavailable: 'stop',
          },
          'PATCH',
        )
      ).status,
      200,
    );
    for (const patch of [
      { sandbox: { pi: 'learn', codex: 'learn' } },
      { sandbox: { pi: 'enforce' } },
      { sandboxWhenUnavailable: 'run-as-today' },
      { toolApprovalMode: 'auto' },
      { autoUseResetCards: true },
    ]) {
      const result = await http('/api/settings', patch, 'PATCH');
      assert.equal(result.status, 403);
      assert.match(result.body.error, /桌面应用/);
    }
    await desktop({
      kind: 'settings',
      patch: { sandbox: {}, sandboxWhenUnavailable: 'run-as-today', toolApprovalMode: 'auto', autoUseResetCards: true },
    });
    assert.equal((await state()).settings.autoUseResetCards, true);
    assert.equal((await state()).settings.sandbox.pi, 'off');
    assert.equal((await state()).settings.sandbox.codex, 'off');
    assert.equal((await http('/api/settings', { autoUseResetCards: true, reservePercent: 20 }, 'PATCH')).status, 200);
    const target = (await state()).targets.find(
      (target: any) => target.provider === 'codex' && !target.accountId && target.environment === 'native',
    );
    assert.ok(target);
    const targetPath = `/api/targets/${target.id}`;
    assert.equal((await http(targetPath, { command: target.command, args: target.args ?? [] }, 'PATCH')).status, 200);
    for (const patch of [{ command: 'synthetic-other' }, { args: ['synthetic'] }])
      assert.equal((await http(targetPath, patch, 'PATCH')).status, 403);
    await desktop({
      kind: 'target-command',
      id: target.id,
      patch: { command: 'synthetic-other', args: ['synthetic argument'] },
    });
    assert.equal((await state()).targets.find((item: any) => item.id === target.id).command, 'synthetic-other');
    const preview = (await http('/api/extensions/preview', { input: 'synthetic-mcp <argument>' })).body;
    const install = {
      token: preview.token,
      keys: [preview.drafts[0].key],
      fills: { [preview.drafts[0].key]: { '<argument>': 'one' } },
    };
    assert.equal((await http('/api/extensions/install', install)).status, 403);
    await desktop({ kind: 'extension-command', action: 'install', ...install });
    let items = (await fetch(base + '/api/extensions', { headers: { 'x-agent-token': session.token } }).then(
      (response) => response.json(),
    )) as any;
    const extension = items.items[0];
    assert.equal(extension.command, 'synthetic-mcp');
    // A value typed into an installation placeholder may be a credential: the API shows its placeholder,
    // and the value itself lives only in the private settings file.
    assert.deepEqual(extension.args, ['{{secret:1}}']);
    assert.doesNotMatch(JSON.stringify(items), /"one"/);
    const privateSettings = JSON.parse(
      readFileSync(join(env.COMBORUNNER_SECRETS_DIR!, 'extension-settings.json'), 'utf8'),
    ) as any;
    assert.deepEqual(privateSettings.values[extension.id].args, { '1': 'one' });
    assert.equal(
      (await http(`/api/extensions/${extension.id}`, { values: { NODE_OPTIONS: 'synthetic' } }, 'PATCH')).status,
      403,
    );
    await desktop({
      kind: 'extension-command',
      action: 'configure',
      id: extension.id,
      values: { NODE_OPTIONS: 'synthetic' },
    });
    assert.equal(
      (await http(`/api/extensions/${extension.id}`, { values: { NODE_OPTIONS: 'synthetic' } }, 'PATCH')).status,
      200,
    );
    const unchanged = (
      await http('/api/extensions/preview', {
        input: JSON.stringify({ command: 'synthetic-mcp', args: ['one'], env: { NODE_OPTIONS: 'synthetic' } }),
      })
    ).body;
    assert.equal(
      (
        await http('/api/extensions/install', {
          token: unchanged.token,
          keys: [unchanged.drafts[0].key],
          options: { [unchanged.drafts[0].key]: { replaceId: extension.id } },
        })
      ).status,
      200,
    );
    assert.equal((await http(`/api/extensions/${extension.id}/check`, {})).status, 200);
    const ids = parseLearningReport({
      denials: [{ resource: 'C:/synthetic/allowed.txt', resourceType: 'file', accessType: 'read' }],
    }).entries.map((entry) => entry.id);
    assert.equal((await http('/api/sandbox/learning', { provider: 'pi', ids })).status, 403);
    await desktop({ kind: 'sandbox-adopt', provider: 'pi', ids });
    assert.equal((await http('/api/sandbox/learning', { provider: 'pi', ids })).status, 200);
    assert.equal(
      (await http('/api/runs', { prompt: 'synthetic', projectPath: scratch, verificationCommand: 'synthetic' })).status,
      403,
    );
    const project = (await http('/api/projects', { path: scratch })).body;
    const conversation = (await http('/api/conversations', { projectId: project.id })).body;
    const privateManifest = {
      schemaVersion: 1 as const,
      id: 'example.private',
      version: '1.0.0',
      title: 'Private fixture',
      description: 'Installed private package',
      view: { markdown: 'Private package contents', fields: [], actions: [] },
    };
    assert.equal((await http('/api/modes/import', { manifest: privateManifest })).status, 200);
    assert.equal((await http('/api/modes/example.private/install', { version: '1.0.0' })).status, 200);
    assert.equal(
      (await http(`/api/conversations/${conversation.id}/mode`, { modeId: 'example.private' }, 'PUT')).status,
      200,
    );
    for (const path of [
      '/api/modes',
      '/API/MODES/',
      '/api/modes/example.private/versions/1.0.0/export',
      '/API/MODES/example.private/VERSIONS/1.0.0/EXPORT/',
      `/api/conversations/${conversation.id}/mode`,
      `/API/CONVERSATIONS/${conversation.id}/MODE/`,
    ]) {
      assert.equal((await fetch(base + path)).status, 403);
      assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 403);
      const authorized = await fetch(base + path, { headers: { 'x-agent-token': session.token } });
      assert.equal(authorized.status, 200);
      assert.equal(authorized.headers.get('cache-control'), 'no-store');
      const body = (await authorized.json()) as any;
      if (path.toLowerCase().includes('/export')) assert.deepEqual(body, privateManifest);
      if (path.toLowerCase().includes('/conversations/'))
        assert.deepEqual(body.manifest, normalizeModManifest(privateManifest));
    }
    assert.equal(
      (await http(`/api/projects/${project.id}`, { approvedVerificationCommands: ['synthetic'] }, 'PATCH')).status,
      400,
    );
    await desktop({ kind: 'verification', projectId: project.id, command: 'synthetic exact' });
    assert.deepEqual(
      (await state()).projects.find((item: any) => item.id === project.id).approvedVerificationCommands,
      ['synthetic exact'],
    );
  },
);
