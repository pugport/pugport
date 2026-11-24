import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import {
  formatPeerAddress,
  parsePeerAddress,
  peerRequest,
  PeerRefused,
  PeerUnreachable,
  resolvePeer,
} from '../src/server/devices/peer-client.ts';
import { Devices } from '../src/server/devices/service.ts';
import { externalTaskRunner } from '../src/server/node/peer-tasks.ts';
import type { ExternalTasks } from '../src/server/external-tasks.ts';
import * as peerProtocol from '../src/server/node/peer-protocol.ts';
import { SshTunnels } from '../src/server/devices/ssh-tunnel.ts';
import { downloadsFolder, validateFiles } from '../src/server/node/peer-files.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { deviceNameProblem } from '../src/shared/devices.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';
import { fakeRunner, startPeer, temporaryFolder } from './helpers/fake-peer.ts';
import { PeerListener } from '../src/server/node/peer-listener.ts';
import { fetchPortAllowed, listenForFetch } from './helpers/fetch-port.ts';
import { peerTaskStatusSchema } from '../src/server/node/peer-protocol.ts';
import { permissionLine } from '../src/shared/permission-reason.ts';
import { inheritedCeiling } from '../src/server/caller-ceiling.ts';
import { ExternalAgents } from '../src/server/external-agents/service.ts';
import type { CallerContext } from '../src/shared/caller-signals.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import { deviceRoutes } from '../src/server/devices/routes.ts';
import type { Express, RequestHandler } from 'express';
import type { GitHubHostRequest } from '../src/server/node/peer-protocol.ts';
import { hostGit } from '../src/server/managed-worktrees.ts';
import { createRepoImporter } from '../src/server/node/peer-repos.ts';
import { memoryRecordStore } from './helpers/record-store.ts';

test('repo shuttle: writable project snapshots and failed device work both return a local branch', async (t) => {
  for (const outcome of ['completed', 'failed', 'bad-bundle']) {
    const failed = outcome === 'failed';
    await t.test(outcome, async (t) => {
      const w = workspaceFixture(t);
      const importer = createRepoImporter(
        memoryRecordStore(),
        fakeRunner().runner,
        temporaryFolder(t, 'device-shuttle-home-'),
      );
      const importingPeer = await startPeer(t, { importRepo: importer });
      let dispatchedPath = '';
      const f = devicesFor(t, {
        fetch: async (input, init) => {
          if (String(input).endsWith('/peer/v1/tasks'))
            dispatchedPath = JSON.parse(String(init?.body)).projectPath ?? '';
          return fetch(input, init);
        },
      });
      const device = (
        await f.devices.add({
          address: importingPeer.address,
          code: importingPeer.registry.createCode().code,
          name: 'shuttle-box',
        })
      ).devices[0]!;
      w.workspace.remote = f.devices;
      const directory = temporaryFolder(t, 'device-shuttle-project-');
      const git = (args: string[]) => hostGit(directory, args, { readUserConfig: true });
      await git(['init', '-q']);
      writeFileSync(join(directory, 'a.txt'), 'original\n');
      mkdirSync(join(directory, 'sub'));
      writeFileSync(join(directory, 'sub', 'anchor.txt'), 'synthetic\n');
      await git(['add', '.']);
      await git(['commit', '-qm', 'initial']);
      writeFileSync(join(directory, 'a.txt'), 'owner draft\n');
      const project = await w.workspace.createProject(join(directory, 'sub'));
      const conversation = w.workspace.createConversation(project.id);
      let captured = false;
      let downloaded = '';
      let returned: Awaited<ReturnType<typeof validateFiles>> = [];
      importingPeer.runner.file = (_taskId, fileId) => returned.find((file) => file.id === fileId);
      const originalResult = importingPeer.runner.result;
      t.mock.method(importingPeer.runner, 'result', async (...args: Parameters<typeof originalResult>) => {
        const result = await originalResult(...args);
        return result && ['completed', 'blocked'].includes(result.status)
          ? { ...result, files: returned.map(({ id, name, size }) => ({ id, name, size })) }
          : result;
      });
      const sent = await w.workspace.send(conversation.id, {
        content: 'Change the project',
        deviceId: device.id,
        mode: 'chat',
        permissionMode: 'workspace-write',
        executionPolicy: 'cli-first',
        explicitWrite: true,
      });
      const done = await finish(w.workspace, sent.workflow.id, async () => {
        if (captured) return;
        const entry = [...importingPeer.tasks.entries()][0];
        if (!entry) return;
        captured = true;
        const [taskId, task] = entry;
        const remote = task.input.projectPath!;
        assert.ok(
          remote,
          JSON.stringify({ input: task.input, workflow: w.workspace.store.get('workflow', sent.workflow.id) }),
        );
        assert.match(remote.replaceAll('\\', '/'), /PugPort-Workspace\/repos\//);
        assert.match(dispatchedPath, /\/sub$/);
        assert.match(task.input.task, /当前分支 pugport\//);
        const snapshot = (await hostGit(remote, ['rev-parse', 'HEAD'], { readUserConfig: true })).stdout.trim();
        writeFileSync(join(remote, 'returned.txt'), 'device change\n');
        await hostGit(remote, ['add', '.'], { readUserConfig: true });
        await hostGit(remote, ['commit', '-qm', 'device change'], { readUserConfig: true });
        const remoteName = `pugport-back-${taskId}.bundle`;
        const collision = join(downloadsFolder(), 'PugPort', device.name, remoteName);
        mkdirSync(join(downloadsFolder(), 'PugPort', device.name), { recursive: true });
        writeFileSync(collision, 'keep existing download');
        const back = join(temporaryFolder(t, 'device-shuttle-back-'), remoteName);
        if (outcome === 'bad-bundle') writeFileSync(back, 'invalid synthetic bundle');
        else await hostGit(remote, ['bundle', 'create', back, `^${snapshot}`, 'HEAD'], { readUserConfig: true });
        returned = await validateFiles([back]);
        if (failed) importingPeer.fail(taskId, 'synthetic failure');
        else importingPeer.finish(taskId, 'done');
      });
      assert.ok(captured, JSON.stringify(done));
      assert.equal(done.status, failed ? 'blocked' : 'completed');
      const message = w.workspace.store.allMessages(conversation.id).find((m) => m.id === done.finalMessageId)!;
      if (outcome === 'bad-bundle') {
        assert.match(message.content, /设备改动没有落到本地分支，bundle 保留在/);
        downloaded = /bundle 保留在 (.*\.bundle)：/.exec(message.content)![1]!;
        assert.equal(readFileSync(downloaded, 'utf8'), 'invalid synthetic bundle');
        rmSync(downloaded);
        assert.equal((await git(['for-each-ref', '--format=%(refname)', 'refs/heads/device/'])).stdout, '');
      } else {
        assert.match(message.content, /device\/[^\s]+/);
        assert.match(message.content, /git apply/);
        assert.match(
          (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/device/'])).stdout,
          /refs\/heads\/device\//,
        );
      }
      assert.doesNotMatch(message.content, /收到来自.*\.bundle/);
      if (failed) assert.match(message.content, /任务没有完成，但已把设备上的改动放到分支/);
      assert.equal((await git(['for-each-ref', '--format=%(refname)', 'refs/pugport/shuttle/'])).stdout, '');
      assert.equal(readFileSync(join(directory, 'a.txt'), 'utf8'), 'owner draft\n');
    });
  }
});

for (const receiptKind of ['task', 'taskId', 'missing-object', 'legacy'] as const) {
  test(`repo shuttle resume keeps the imported baseline: ${receiptKind}`, async (t) => {
    const { snapshotRepository } = await import('../src/server/devices/repo-shuttle.ts');
    const w = workspaceFixture(t);
    const peer = await startPeer(t);
    const f = devicesFor(t);
    const device = (
      await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'resume-box' })
    ).devices[0]!;
    w.workspace.remote = f.devices;
    const directory = temporaryFolder(t, 'shuttle-resume-');
    const git = (args: string[]) => hostGit(directory, args, { readUserConfig: true });
    await git(['init', '-q']);
    writeFileSync(join(directory, 'a.txt'), 'original\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'initial']);
    writeFileSync(join(directory, 'a.txt'), 'sent draft\n');
    const project = await w.workspace.createProject(directory);
    const conversation = w.workspace.createConversation(project.id);
    const sent = await w.workspace.send(conversation.id, {
      content: 'Resume edit',
      deviceId: device.id,
      mode: 'chat',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
      explicitWrite: true,
    });
    const snapshot = await snapshotRepository(directory, sent.workflow.id);
    assert.ok(snapshot.ok);
    t.after(() => rmSync(snapshot.bundle, { force: true }));
    const remote = temporaryFolder(t, 'shuttle-resume-node-');
    const nodeGit = (args: string[]) => hostGit(remote, args, { readUserConfig: true });
    await nodeGit(['init', '-q']);
    await nodeGit(['fetch', snapshot.bundle, snapshot.ref]);
    await nodeGit(['checkout', snapshot.snapshot]);
    writeFileSync(join(remote, 'returned.txt'), 'device edit\n');
    await nodeGit(['add', '.']);
    await nodeGit(['commit', '-qm', 'device edit']);
    const back = join(temporaryFolder(t, 'shuttle-resume-back-'), 'back.bundle');
    await nodeGit(['bundle', 'create', back, `^${snapshot.snapshot}`, 'HEAD']);
    const savedRepo = {
      top: snapshot.top,
      snapshot: snapshot.snapshot,
      head: snapshot.head,
      trip: sent.workflow.id,
      projectPath: remote,
    };
    sent.workflow.deviceTask = JSON.parse(
      JSON.stringify({
        ...(receiptKind === 'taskId' ? { taskId: 'existing-task' } : { task: 'Already imported task' }),
        ...(receiptKind === 'legacy' ? {} : { repo: savedRepo }),
      }),
    );
    w.workspace.store.save('workflow', sent.workflow.id, project.id, sent.workflow);
    writeFileSync(join(directory, 'a.txt'), 'later owner edit\n');
    if (receiptKind === 'missing-object') {
      await git(['update-ref', '-d', snapshot.ref]);
      await git(['reflog', 'expire', '--expire=now', '--all']);
      await git(['gc', '--prune=now']);
      assert.notEqual(
        (await hostGit(directory, ['cat-file', '-e', snapshot.snapshot], { readUserConfig: true, allowFailure: true }))
          .code,
        0,
      );
    }
    let suppliedRepo: unknown;
    t.mock.method(f.devices, 'run', async (...args: Parameters<Devices['run']>) => {
      suppliedRepo = args[5];
      return { text: 'done', name: device.name, backBundle: back };
    });
    const done = await finish(w.workspace, sent.workflow.id);
    const message = w.workspace.store.allMessages(conversation.id).find((m) => m.id === done.finalMessageId)!;
    assert.equal(suppliedRepo, undefined, 'a resumed task must never create or send another snapshot');
    assert.equal(readFileSync(join(directory, 'a.txt'), 'utf8'), 'later owner edit\n');
    if (receiptKind === 'missing-object' || receiptKind === 'legacy') {
      assert.match(message.content, /bundle 保留在/);
      assert.ok(message.content.includes(back));
      assert.doesNotMatch(message.content, /git (?:apply|merge|diff)/);
      assert.ok(readFileSync(back).length);
      assert.equal((await git(['for-each-ref', '--format=%(refname)', 'refs/heads/device/'])).stdout, '');
    } else {
      assert.match(message.content, /1 个提交，1 个文件/);
      assert.ok(message.content.includes(`git diff --binary ${snapshot.snapshot.slice(0, 8)}`));
      const branch = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/device/'])).stdout.trim();
      assert.equal((await git(['diff', '--name-only', snapshot.snapshot, branch])).stdout.trim(), 'returned.txt');
    }
  });
}

test('repo shuttle resume persists import metadata and resends into the same project folder', async (t) => {
  const remote = temporaryFolder(t, 'shuttle-receipt-node-');
  mkdirSync(join(remote, 'sub'));
  let imports = 0;
  const peer = await startPeer(t, {
    importRepo: async (_peer, body) => {
      imports++;
      return { path: remote, head: body.snapshot };
    },
  });
  const f = devicesFor(t);
  const id = (
    await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'receipt-box' })
  ).devices[0]!.id;
  const bundle = join(temporaryFolder(t, 'shuttle-receipt-'), 'project.bundle');
  writeFileSync(bundle, 'synthetic import');
  const workflow = workflowFor(id, 'Edit', { permissionMode: 'workspace-write' });
  const repo = {
    bundle,
    snapshot: 'a'.repeat(40),
    head: 'b'.repeat(40),
    top: 'synthetic-local-top',
    trip: workflow.id,
    key: '0123456789abcdef',
    subpath: 'sub',
  };
  const running = f.devices.run(workflow, new AbortController().signal, () => {}, [], undefined, repo);
  const first = await waitFor(() => [...peer.tasks.keys()][0]);
  peer.finish(first, 'done');
  await running;
  const receipt = JSON.parse(JSON.stringify(workflow.deviceTask));
  assert.deepEqual(receipt.repo, {
    snapshot: repo.snapshot,
    head: repo.head,
    top: repo.top,
    trip: repo.trip,
    projectPath: `${remote}/sub`,
  });
  delete receipt.taskId;
  peer.tasks.clear();
  workflow.deviceTask = receipt;
  const retry = f.devices.run(workflow, new AbortController().signal, () => {});
  const next = await waitFor(() => [...peer.tasks.keys()][0]);
  peer.finish(next, 'done again');
  await retry;
  assert.equal(peer.tasks.get(next)!.input.projectPath, resolve(remote, 'sub'));
  assert.equal(imports, 1);
});

test('repo shuttle falls back after upload, old node, no-git, busy, write-off and timeout failures', async (t) => {
  for (const failure of ['upload', 'old-node', 'no-git', 'busy', 'write-off', 'timeout'])
    await t.test(failure, async (t) => {
      const peer = await startPeer(t);
      const f = devicesFor(t, {
        fetch: async (input, init) => {
          const url = String(input);
          if (failure === 'upload' && init?.method === 'PUT' && url.includes('/peer/v1/files'))
            return new Response('{"error":"synthetic upload refusal"}', { status: 400 });
          if (url.includes('/repos/')) {
            if (failure === 'timeout') throw new Error('synthetic timeout');
            const status = failure === 'old-node' ? 404 : failure === 'busy' ? 409 : 400;
            return new Response(JSON.stringify({ error: failure === 'no-git' ? 'no-git' : `synthetic ${failure}` }), {
              status,
            });
          }
          return fetch(input, init);
        },
      });
      const id = (
        await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'fallback-box' })
      ).devices[0]!.id;
      const bundle = join(temporaryFolder(t, 'shuttle-fallback-'), 'project.bundle');
      writeFileSync(bundle, 'synthetic payload, importer refuses before reading it');
      const workflow = workflowFor(id, 'Do the work');
      workflow.input.permissionMode = 'workspace-write';
      const running = f.devices.run(workflow, new AbortController().signal, () => {}, [], undefined, {
        bundle,
        snapshot: 'a'.repeat(40),
        top: 'synthetic-local-top',
        head: 'b'.repeat(40),
        trip: 'fallback',
        key: '0123456789abcdef',
        subpath: 'sub',
      });
      const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
      const task = peer.tasks.get(taskId)!;
      assert.equal(task.input.write, true);
      assert.doesNotMatch(task.input.task, /用户项目的副本/);
      assert.doesNotMatch(task.input.projectPath ?? '', /\/repos\//);
      peer.finish(taskId, 'fallback finished');
      const answer = await running;
      assert.match(answer.text, /^项目没有带到设备上：.+。\n\nfallback finished$/);
      assert.equal(answer.backBundle, undefined);
    });
});

test('repo shuttle receives a back bundle when stopping finds the task already completed', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const id = (
    await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'stop-bundle-box' })
  ).devices[0]!.id;
  const folder = temporaryFolder(t, 'shuttle-stop-back-');
  let file: Awaited<ReturnType<typeof validateFiles>>[number];
  peer.runner.file = () => file;
  const original = peer.runner.result;
  t.mock.method(peer.runner, 'result', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    return result?.status === 'completed'
      ? { ...result, files: [{ id: file.id, name: file.name, size: file.size }] }
      : result;
  });
  const abort = new AbortController();
  const workflow = workflowFor(id, 'Inspect');
  const running = f.devices.run(workflow, abort.signal, () => {});
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  const path = join(folder, `pugport-back-${taskId}.bundle`);
  writeFileSync(path, 'synthetic return bytes');
  file = (await validateFiles([path]))[0]!;
  abort.abort(new Error('synthetic stop'));
  peer.finish(taskId, 'finished before stop');
  const answer = await running;
  assert.equal(answer.text, 'finished before stop');
  assert.ok(answer.backBundle);
  assert.equal(readFileSync(answer.backBundle, 'utf8'), 'synthetic return bytes');
  assert.equal(workflow.deviceTask?.uncertain, undefined);
});

test('repo shuttle retains the import warning when the device also refuses the fallback task', async (t) => {
  const peer = await startPeer(t, {
    allowWrite: false,
    importRepo: async () => {
      throw new Error('must not import');
    },
  });
  const f = devicesFor(t);
  const id = (
    await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'write-off-box' })
  ).devices[0]!.id;
  const bundle = join(temporaryFolder(t, 'shuttle-write-off-'), 'project.bundle');
  writeFileSync(bundle, 'synthetic payload');
  const workflow = workflowFor(id, 'Write', { permissionMode: 'workspace-write' });
  await assert.rejects(
    f.devices.run(workflow, new AbortController().signal, () => {}, [], undefined, {
      bundle,
      snapshot: 'a'.repeat(40),
      top: 'synthetic-local-top',
      head: 'b'.repeat(40),
      trip: 'write-off',
      key: '0123456789abcdef',
      subpath: '',
    }),
    /^Error: 项目没有带到设备上：.*已关闭写入/s,
  );
  assert.equal(peer.tasks.size, 0);
});

test('repo shuttle skips read-only, general chats inside a repo, and non-git projects', async (t) => {
  const w = workspaceFixture(t);
  const gitProject = temporaryFolder(t, 'shuttle-skips-git-');
  for (const path of [gitProject, w.directory]) {
    await hostGit(path, ['init', '-q'], { readUserConfig: true });
    writeFileSync(join(path, 'tracked.txt'), 'synthetic');
    await hostGit(path, ['add', 'tracked.txt'], { readUserConfig: true });
    await hostGit(path, ['commit', '-qm', 'initial'], { readUserConfig: true });
  }
  let imports = 0;
  const peer = await startPeer(t, {
    importRepo: async () => {
      imports++;
      throw new Error('unexpected import');
    },
  });
  const f = devicesFor(t);
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'skip-box' }))
    .devices[0]!.id;
  w.workspace.remote = f.devices;
  const project = await w.workspace.createProject(gitProject);
  const plain = await w.workspace.createProject(temporaryFolder(t, 'shuttle-skips-plain-'));
  const scenarios = [
    { conversation: w.workspace.createConversation(project.id), permissionMode: 'read-only' as const },
    { conversation: await w.workspace.createGeneralConversation(), permissionMode: 'workspace-write' as const },
    { conversation: w.workspace.createConversation(plain.id), permissionMode: 'workspace-write' as const },
  ];
  for (const { conversation, permissionMode } of scenarios) {
    const sent = await w.workspace.send(conversation.id, {
      content: 'Inspect',
      deviceId: id,
      mode: 'chat',
      permissionMode,
      explicitWrite: permissionMode === 'workspace-write',
      executionPolicy: 'cli-first',
    });
    assert.equal(sent.workflow.input.permissionMode, permissionMode);
    const done = await finish(w.workspace, sent.workflow.id, () => {
      for (const [taskId, task] of peer.tasks) if (task.status === 'running') peer.finish(taskId, 'done');
    });
    assert.equal(done.status, 'completed', done.error ?? '');
    const message = w.workspace.store.allMessages(conversation.id).find((m) => m.id === done.finalMessageId)!;
    assert.doesNotMatch(message.content, /项目没有带到/);
  }
  assert.equal(imports, 0);
  assert.ok([...peer.tasks.values()].every(({ input }) => !input.task.includes('用户项目的副本')));
});

test('repo shuttle serializes folderless writes across projects on the same device', async (t) => {
  const w = workspaceFixture(t);
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'queue-box' }))
    .devices[0]!.id;
  w.workspace.remote = f.devices;
  const sent: Workflow[] = [];
  for (let i = 0; i < 2; i++) {
    const project = await w.workspace.createProject(temporaryFolder(t, 'shuttle-queue-project-'));
    const conversation = w.workspace.createConversation(project.id);
    sent.push(
      (
        await w.workspace.send(conversation.id, {
          content: 'Write a file',
          deviceId: id,
          mode: 'chat',
          permissionMode: 'workspace-write',
          explicitWrite: true,
          executionPolicy: 'cli-first',
        })
      ).workflow,
    );
  }
  await w.workspace.tickQueue();
  await waitFor(() => (peer.tasks.size === 1 ? true : undefined));
  await w.workspace.tickQueue();
  assert.equal(peer.tasks.size, 1);
  const waiting = w.workspace.store.get<Workflow>('workflow', sent[1]!.id)!;
  assert.equal(waiting.status, 'waiting-resource');
  assert.equal(waiting.scheduling?.reason, '等待同一设备上的另一条可写任务完成。');
  peer.finish([...peer.tasks.keys()][0]!, 'first done');
  await finish(w.workspace, sent[0]!.id);
  await finish(w.workspace, sent[1]!.id, () => {
    for (const [taskId, task] of peer.tasks) if (task.status === 'running') peer.finish(taskId, 'second done');
  });
  assert.equal(peer.tasks.size, 2);
});

test('fake peers discard Fetch-blocked OS-assigned ports before pairing', async (t) => {
  const boundPort = PeerListener.prototype.boundPort;
  let rejected: PeerListener | undefined;
  t.mock.method(PeerListener.prototype, 'boundPort', function (this: PeerListener) {
    rejected ??= this;
    return this === rejected ? 6665 : boundPort.call(this);
  });
  const peer = await startPeer(t);
  assert.notEqual(peer.listener, rejected);
  assert.equal(boundPort.call(rejected!), undefined, 'the rejected listener was closed');
  assert.equal(fetchPortAllowed(peer.port), true);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  assert.equal((await f.devices.add({ address: peer.address, code })).devices[0]!.online, true);
});

test('HTTP fixtures rebind Fetch-blocked OS-assigned ports before making requests', async (t) => {
  const server = createServer((_req, res) => res.end('{"ok":true}'));
  t.after(() => server.close());
  let binds = 0;
  server.on('listening', () => binds++);
  const address = server.address.bind(server);
  t.mock.method(server, 'address', () => {
    const actual = address() as AddressInfo;
    return binds === 1 ? { ...actual, port: 6665 } : actual;
  });
  await listenForFetch(server);
  assert.ok(binds >= 2, 'the blocked port was released and a new port allocated');
  const port = (address() as AddressInfo).port;
  assert.deepEqual(
    await peerRequest({ host: '127.0.0.1', port }, { path: '/x', schema: z.object({ ok: z.literal(true) }) }),
    { ok: true },
  );
});

test('device addresses: Tailscale addresses and names only, a pasted http:// is fine', async () => {
  assert.deepEqual(parsePeerAddress('100.101.102.103'), { host: '100.101.102.103', port: 4318 });
  assert.deepEqual(parsePeerAddress(' http://100.101.102.103:5000/ '), { host: '100.101.102.103', port: 5000 });
  assert.deepEqual(parsePeerAddress('[fd7a:115c:a1e0::5]:4318'), { host: 'fd7a:115c:a1e0::5', port: 4318 });
  assert.deepEqual(parsePeerAddress('fd7a:115c:a1e0::5'), { host: 'fd7a:115c:a1e0::5', port: 4318 });
  assert.deepEqual(parsePeerAddress('Ubuntu.tail1234.ts.net.'), { host: 'ubuntu.tail1234.ts.net', port: 4318 });
  for (const bad of ['', 'a b', 'user@host', 'host:99999', 'host/path', '-bad', 'host:', '[::1', 'x'.repeat(301)])
    assert.equal(parsePeerAddress(bad), undefined, bad);
  assert.equal(formatPeerAddress({ host: '100.1.2.3', port: 4318 }), '100.1.2.3');
  assert.equal(formatPeerAddress({ host: 'fd7a:115c:a1e0::5', port: 5000 }), '[fd7a:115c:a1e0::5]:5000');

  await assert.rejects(resolvePeer({ host: '192.168.1.20', port: 4318 }), /只能连接 Tailscale/);
  assert.deepEqual(await resolvePeer({ host: '100.64.0.9', port: 4318 }), { host: '100.64.0.9', port: 4318 });
  assert.deepEqual(await resolvePeer({ host: '127.0.0.1', port: 1 }), { host: '127.0.0.1', port: 1 });
  // A name must lead to a Tailscale address; a LAN answer is refused before anything is sent.
  const lookup = async (host: string) => (host === 'ubuntu' ? ['192.168.1.20', '100.88.1.2'] : ['192.168.1.30']);
  assert.deepEqual(await resolvePeer({ host: 'ubuntu', port: 4318 }, lookup), { host: '100.88.1.2', port: 4318 });
  await assert.rejects(resolvePeer({ host: 'printer', port: 4318 }, lookup), /不是 Tailscale 里的地址/);
  await assert.rejects(
    resolvePeer({ host: 'gone', port: 4318 }, async () => {
      throw new Error('ENOTFOUND');
    }),
    PeerUnreachable,
  );
  assert.equal(deviceNameProblem('家里的Ubuntu'), undefined);
  assert.match(deviceNameProblem('有 空格')!, /空格/);
  assert.match(deviceNameProblem('x'.repeat(25))!, /24/);
});

test('server transfer messages use the English catalog without changing file paths', () => {
  const translate = createTranslator(
    JSON.parse(readFileSync(new URL('../src/shared/i18n/en.json', import.meta.url), 'utf8')),
  );
  assert.equal(translate('正在传送文件…'), 'Transferring files…');
  assert.equal(translate('附件已改变。'), 'The attachment changed.');
  assert.equal(
    translate('收到来自「fixture」的文件：<C:/synthetic/file.txt>'),
    'Received from fixture: <C:/synthetic/file.txt>',
  );
  assert.equal(translate('文件下载失败：synthetic error'), 'Files could not be downloaded: synthetic error');
});

test('a peer call: timeouts and refusals in plain words, oversized or odd replies refused', async (t) => {
  let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end('{}');
  const server = createServer((_req, res) => reply(res));
  await listenForFetch(server);
  t.after(() => server.close());
  const address = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const schema = z.object({ ok: z.literal(true) });
  reply = (res) => res.end('{"ok":true}');
  assert.deepEqual(await peerRequest(address, { path: '/x', schema }), { ok: true });
  reply = (res) => {
    res.statusCode = 403;
    res.end('{"error":"配对码不对。"}');
  };
  await assert.rejects(peerRequest(address, { path: '/x', schema }), (error: unknown) => {
    assert.ok(error instanceof PeerRefused);
    assert.equal(error.status, 403);
    assert.equal(error.message, '配对码不对。');
    return true;
  });
  reply = (res) => res.end('<html>');
  await assert.rejects(peerRequest(address, { path: '/x', schema }), /无法读取/);
  reply = (res) => res.end('{"ok":"yes"}');
  await assert.rejects(peerRequest(address, { path: '/x', schema }), /版本可能差太多/);
  reply = (res) => res.end(`{"ok":true,"pad":"${'x'.repeat(1_100_000)}"}`);
  await assert.rejects(peerRequest(address, { path: '/x', schema }), /太长/);
  reply = () => undefined;
  await assert.rejects(peerRequest(address, { path: '/x', schema, timeoutMs: 100 }), /没有及时回应/);
  await assert.rejects(
    peerRequest({ host: '127.0.0.1', port: 1 }, { path: '/x', schema, timeoutMs: 2000 }),
    PeerUnreachable,
  );
});

function devicesFor(t: TestContext, options: Partial<ConstructorParameters<typeof Devices>[0]> = {}) {
  const folder = temporaryFolder(t, 'devices-test-');
  const standby: (string | undefined)[] = [];
  const devices = new Devices({
    file: join(folder, 'devices.json'),
    selfName: 'desk-1',
    reservedNames: () => ['Claude B', 'Muse'],
    slack: {
      config: async () => ({
        appToken: 'xapp-1-fixture-app-token-0000',
        botToken: 'xoxb-fixture-bot-token-0000',
        users: [{ id: 'U12345', pairedAt: '2026-10-11T08:00:00Z' }],
      }),
      standby: async (hostedBy) => void standby.push(hostedBy),
    },
    helperTimeoutMs: 15_000,
    resultWaitSeconds: 1,
    retryDelaysMs: [20],
    offlineLimitMs: 300,
    ...options,
  });
  t.after(() => devices.close());
  return { devices, folder, standby, file: join(folder, 'devices.json') };
}

async function githubDevices(t: TestContext) {
  const calls: GitHubHostRequest[] = [];
  const local: (string | null | undefined)[] = [];
  const events: string[] = [];
  const peer = await startPeer(t, {
    github: {
      async set(request) {
        calls.push(request);
        events.push(request.host ? 'peer:start' : 'peer:stop');
        peer.setGitHubHost(request.host);
        return { githubHost: request.host };
      },
      async status() {
        throw new Error('unused');
      },
      outbox: () => [],
      resolve: async () => false,
    },
  });
  const config = {
    repository: 'example/project',
    gates: { version: 1 as const, alwaysAsk: { paths: ['private/**'] } },
    stage: 0,
    requiredChecks: ['ci'],
    suiteConfigured: true,
  };
  const f = devicesFor(t, {
    github: {
      config: async () => config,
      standby: async (name) => {
        local.push(name ?? f.devices.store.current().githubHost ?? null);
        events.push(f.devices.store.current().githubHost === 'self' ? 'self:start' : 'self:stop');
      },
    },
  });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code })).devices[0]!.id;
  return { ...f, peer, id, config, calls, local, events };
}

test('GitHub hosting defaults to none, transfers configuration, and releases for self or none', async (t) => {
  const f = await githubDevices(t);
  assert.equal((await f.devices.view()).githubHost, null);
  assert.equal((await f.devices.setGitHubHost(f.id)).githubHost, f.id);
  assert.deepEqual(f.calls.at(-1), { ...f.config, host: true, hostedBy: 'desk-1', leaseMinutes: 360 });
  assert.equal(f.local.at(-1), 'ubuntu-box');
  assert.equal((await f.devices.setGitHubHost('self')).githubHost, 'self');
  assert.equal(f.local.at(-1), 'self');
  assert.deepEqual(f.calls.at(-1), { host: false });
  await f.devices.setGitHubHost(f.id);
  assert.equal((await f.devices.setGitHubHost(null)).githubHost, null);
  assert.equal(f.local.at(-1), null);
  assert.deepEqual(f.calls.at(-1), { host: false });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).githubHost, undefined);
});

test('GitHub switches release the previous host before starting the next', async (t) => {
  const f = await githubDevices(t);
  await f.devices.setGitHubHost(f.id);
  f.events.length = 0;
  await f.devices.setGitHubHost('self');
  assert.deepEqual(f.events, ['peer:stop', 'self:start']);
  f.events.length = 0;
  await f.devices.setGitHubHost(f.id);
  assert.deepEqual(f.events, ['self:stop', 'peer:start', 'self:stop']);
});

test('an unreachable previous GitHub host does not block switching and reports its lease', async (t) => {
  const f = await githubDevices(t);
  await f.devices.setGitHubHost(f.id);
  await f.peer.listener.close();
  const result = await f.devices.setGitHubHost('self');
  assert.equal(result.githubHost, 'self');
  assert.match(result.note!, /previous GitHub host is offline.*six-hour lease expires/);
  assert.equal(f.local.at(-1), 'self');
});

test('GitHub lease renews at desktop start, successful probe and every thirty minutes; stale hosts stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await githubDevices(t);
  await f.devices.setGitHubHost(f.id);
  const before = f.calls.length;
  await f.devices.load();
  assert.equal(f.calls.length, before + 1);
  await f.devices.check(f.id);
  assert.equal(f.calls.length, before + 2);
  t.mock.timers.tick(30 * 60_000);
  await waitFor(() => f.calls.length === before + 3 || undefined);
  assert.equal(f.calls.at(-1)?.host, true);
  await f.devices.setGitHubHost(null);
  f.peer.setGitHubHost(true);
  await f.devices.check(f.id);
  assert.deepEqual(f.calls.at(-1), { host: false });
  await f.devices.close();
  const stopped = f.calls.length;
  t.mock.timers.tick(30 * 60_000);
  await f.devices.renewGitHubHosting();
  assert.equal(f.calls.length, stopped);
});

test('removing the GitHub host releases it before unpairing', async (t) => {
  const f = await githubDevices(t);
  await f.devices.setGitHubHost(f.id);
  const result = await f.devices.remove(f.id);
  assert.deepEqual(f.calls.at(-1), { host: false });
  assert.equal(result.githubHost, null);
  assert.equal(result.devices.length, 0);
  assert.equal(f.peer.registry.list().length, 0);
});

test('GitHub host selection validates input behind the executor guard', async () => {
  const routes = new Map<string, RequestHandler[]>();
  const app = {
    get() {},
    post() {},
    delete() {},
    put(path: string, ...handlers: RequestHandler[]) {
      routes.set(path, handlers);
    },
  };
  const calls: unknown[] = [];
  const guard: RequestHandler = (_req, res) => {
    res.status(403).json({ error: 'executor refused' });
  };
  deviceRoutes(
    app as unknown as Express,
    {
      setGitHubHost: async (id: unknown) => {
        calls.push(id);
        return {};
      },
    } as unknown as Devices,
    guard,
  );
  const handlers = routes.get('/api/devices/github-host')!;
  assert.equal(handlers[0], guard);
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {},
  };
  await handlers[0]!({} as never, res as never, () => {});
  assert.equal(status, 403);
  assert.deepEqual(calls, []);
  for (const deviceId of ['self', null, '123e4567-e89b-42d3-a456-426614174000'])
    await handlers[1]!({ body: { deviceId } } as never, res as never, () => {});
  assert.equal(calls.length, 3);
  await assert.rejects(async () => handlers[1]!({ body: { deviceId: 'invalid' } } as never, res as never, () => {}));
  assert.equal(calls.length, 3);
});

async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

const workflowFor = (deviceId: string, content: string, extra: Partial<MessageInput> = {}) =>
  ({
    id: randomUUID(),
    input: { content, mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first', deviceId, ...extra },
  }) as Workflow;

test('round6 a capacity refusal after a lost reply needs confirmed cancellation', async (t) => {
  const peer = await startPeer(t);
  let posts = 0;
  let cancelled = false;
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        if (++posts === 1) throw new Error('Synthetic lost refusal');
        return new Response(
          JSON.stringify({ error: '请求记录已达上限，这条没有发出去。', code: 'PEER_REQUEST_NOT_SENT' }),
          { status: 409 },
        );
      }
      const response = await fetch(input, init);
      if (String(input).endsWith('/cancel')) cancelled = response.ok;
      return response;
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
  const workflow = workflowFor(id, 'Synthetic');
  await assert.rejects(
    f.devices.run(workflow, new AbortController().signal, () => {}),
    /没有发出去/,
  );
  assert.notEqual(workflow.deviceTask?.uncertain, true);
  assert.equal(posts, 2);
  assert.equal(cancelled, true, 'capacity refusal alone cannot settle an unknown send');
  assert.equal(peer.tasks.size, 0);
});

test('round5 retry deadline survives a later run and forbids resending the id', async (t) => {
  const peer = await startPeer(t);
  let now = Date.now();
  let posts = 0;
  const f = devicesFor(t, {
    now: () => now,
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        posts++;
        throw new Error('Synthetic request never arrived');
      }
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
  const workflow = workflowFor(id, 'Synthetic');
  await assert.rejects(
    f.devices.run(workflow, new AbortController().signal, () => {}),
    /未知/,
  );
  const restored = structuredClone(workflow);
  // A known refusal also retains the id; later manual retries must obey the same deadline.
  delete restored.deviceTask!.uncertain;
  now += 2 * 86400_000;
  assert.ok(peerProtocol.peerRequestRetryMs < 2 * 86400_000);
  await assert.rejects(
    f.devices.run(restored, new AbortController().signal, () => {}),
    /重试期限/,
  );
  assert.equal(posts, 2, 'no POST after the persisted retry deadline');
});

test('adding a device: the code is exchanged once, the token stays in the private file, the view shows quota', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  await assert.rejects(f.devices.add({ address: peer.address, code: 'AAAA-AAAA' }), /没有在等配对/);
  const { code } = peer.registry.createCode();
  await assert.rejects(f.devices.add({ address: peer.address, code, name: 'claudeB' }), /重名/);
  await assert.rejects(f.devices.add({ address: peer.address, code, name: '有 空格' }), /空格/);
  await assert.rejects(f.devices.add({ address: '192.168.1.5', code }), /Tailscale/);
  const view = await f.devices.add({ address: peer.address, code });
  assert.equal(view.devices.length, 1);
  const device = view.devices[0]!;
  assert.equal(device.name, 'ubuntu-box', 'named after its host name');
  assert.equal(device.online, true);
  assert.equal(device.platform, 'linux');
  assert.equal(device.executors?.[0]?.label, 'Claude 测试号');
  assert.deepEqual(device.executors?.[0]?.windows, [
    { name: '5h', remaining: 80 },
    { name: '周', remaining: 62 },
  ]);
  assert.equal(peer.registry.list()[0]!.name, 'desk-1');
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.match(saved.devices[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(view).includes(saved.devices[0].token), 'the view never carries the token');
  assert.ok(!JSON.stringify(await f.devices.view(true)).includes(saved.devices[0].token));
  await assert.rejects(f.devices.add({ address: peer.address, code }), /已经添加过/);
  assert.deepEqual(f.devices.find('设备「Ubuntu-Box」'), { id: device.id, name: 'ubuntu-box' });
  assert.equal(f.devices.find('codex'), undefined);
});

test('a message for a device preserves permissions and attachments, and refuses offline devices', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: '家里的Ubuntu' })).devices[0]!.id;
  const base: MessageInput = {
    content: '@家里的Ubuntu 查一下磁盘空间',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-only',
    runtimeId: 'claude',
    review: true,
  };
  const picked = (await f.devices.messageFor(base, id))!;
  assert.equal(picked.deviceId, id);
  assert.equal(picked.mode, 'build');
  assert.equal(picked.permissionMode, 'workspace-write');
  assert.equal(picked.runtimeId, undefined);
  assert.equal(picked.review, undefined);
  assert.equal(picked.content, base.content, 'the user message keeps what they typed');
  assert.equal(
    (await f.devices.messageFor({ ...base, content: '@@家里的Ubuntu 查一下磁盘空间' }))!.deviceId,
    id,
    'typed out in full with @@',
  );
  assert.equal(
    (await f.devices.messageFor({ ...base, content: '请@@家里的Ubuntu 查一下磁盘空间' }))!.deviceId,
    id,
    'a mention immediately after Chinese text now calls the device',
  );
  assert.equal(await f.devices.messageFor(base), undefined, 'a single @ typed in passing is plain text');
  assert.equal(await f.devices.messageFor({ ...base, content: '写邮件给 a@家里的Ubuntu' }), undefined);
  assert.equal(await f.devices.messageFor({ ...base, content: '普通问题' }), undefined);
  assert.deepEqual(
    (
      await f.devices.messageFor(
        { ...base, deviceFolder: '/remote/work', attachmentIds: ['6f9619ff-8b86-4d11-b42d-00c04fc964ff'] },
        id,
      )
    )?.attachmentIds,
    ['6f9619ff-8b86-4d11-b42d-00c04fc964ff'],
  );
  await assert.rejects(f.devices.messageFor({ ...base, content: '@家里的Ubuntu' }, id), /后面写上/);
  await assert.rejects(f.devices.messageFor(base, '6f9619ff-8b86-4d11-b42d-00c04fc964ff'), /没有这台设备/);
  await peer.listener.close();
  // A recent good look is trusted briefly; a fresh check finds it offline.
  const later = devicesFor(t);
  const store = JSON.parse(readFileSync(f.file, 'utf8'));
  await later.devices.store.update((data) => {
    data.devices = store.devices;
  });
  await assert.rejects(later.devices.messageFor(base, id), /现在连不上/);
});

test('running a task on a device: status notes, the answer, stopping it there, and plain failures', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: '家里的Ubuntu' })).devices[0]!.id;
  const notes: string[] = [];
  const running = f.devices.run(
    workflowFor(id, '@家里的Ubuntu 总结一下今天的新闻', { untrustedContent: true }),
    new AbortController().signal,
    (note) => notes.push(note),
  );
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  assert.equal(peer.tasks.get(taskId)!.input.task, '总结一下今天的新闻', 'the mention is not sent');
  assert.equal(peer.tasks.get(taskId)!.input.untrusted, true);
  assert.equal(peer.tasks.get(taskId)!.input.caller, '设备 · desk-1');
  setTimeout(() => peer.finish(taskId, '今天的新闻是……'), 50);
  assert.deepEqual(await running, {
    text: '今天的新闻是……',
    name: '家里的Ubuntu',
    executor: 'Claude 测试号',
    model: 'fake-model',
  });
  assert.ok(notes.includes('正在交给设备「家里的Ubuntu」…'));
  assert.ok(notes.some((note) => note.startsWith('设备「家里的Ubuntu」：正在处理 · Claude 测试号')));

  // Stopping here stops it there.
  const abort = new AbortController();
  const stopped = f.devices.run(workflowFor(id, '慢慢想'), abort.signal, () => undefined);
  const second = await waitFor(() => [...peer.tasks.keys()][1]);
  abort.abort();
  await assert.rejects(stopped);
  await waitFor(() => (peer.tasks.get(second)!.status === 'cancelled' ? true : undefined));

  // It finished without an answer: told as it is.
  const failing = f.devices.run(workflowFor(id, '做不到的事'), new AbortController().signal, () => undefined);
  const third = await waitFor(() => [...peer.tasks.keys()][2]);
  peer.fail(third, '没有可用的执行器。');
  await assert.rejects(failing, /设备「家里的Ubuntu」上没有完成：没有可用的执行器。/);

  // The connection is lost midway: retried briefly, then given up, never left hanging.
  const lost = f.devices.run(workflowFor(id, '等等'), new AbortController().signal, () => undefined);
  await waitFor(() => [...peer.tasks.keys()][3]);
  await peer.listener.close();
  await assert.rejects(lost, /断开太久，没拿回结果/);
  // Offline from the start: fails at once.
  const started = Date.now();
  await assert.rejects(
    f.devices.run(workflowFor(id, '再试'), new AbortController().signal, () => undefined),
    /发送结果未知/,
  );
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(f.devices.ensureReachable(id), /现在连不上/);
  assert.equal(f.devices.directory()[0]!.online, false);
});

test('removing a device revokes it there too, or says what to do when it is offline', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  let { code } = peer.registry.createCode();
  const first = (await f.devices.add({ address: peer.address, code, name: 'one' })).devices[0]!;
  const removed = await f.devices.remove(first.id);
  assert.equal(removed.devices.length, 0);
  assert.equal(removed.note, undefined);
  assert.equal(peer.registry.list().length, 0, 'the node forgot this computer too');

  ({ code } = peer.registry.createCode());
  const second = (await f.devices.add({ address: peer.address, code, name: 'two' })).devices[0]!;
  await peer.listener.close();
  const offline = await f.devices.remove(second.id);
  assert.equal(offline.devices.length, 0);
  assert.match(offline.note!, /pugport node unpair/);
});

test('Slack switch confirms release before starting the next host, including failed releases', async (t) => {
  const events: string[] = [];
  let live = 'desktop';
  let failRelease = false;
  const peer = await startPeer(t, {
    slack: async (request) => {
      events.push(request.host ? 'node:start' : 'node:stop');
      if (request.host) {
        assert.equal(live, '', 'desktop must close before node starts');
        live = 'node';
      } else {
        if (failRelease) throw new Error('synthetic release failure');
        live = '';
      }
      return { slackHost: request.host };
    },
  });
  const f = devicesFor(t, {
    slack: {
      config: async () => ({
        appToken: 'xapp-1-fixture-app-token-0000',
        botToken: 'xoxb-fixture-bot-token-0000',
        users: [],
      }),
      standby: async (host) => {
        events.push(host ? 'desktop:stop' : 'desktop:start');
        if (host) {
          if (failRelease) throw new Error('synthetic local release failure');
          live = '';
        } else {
          assert.equal(live, '', 'node must close before desktop starts');
          live = 'desktop';
        }
      },
    },
  });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'box' })).devices[0]!.id;
  failRelease = true;
  await assert.rejects(f.devices.setSlackHost(id));
  assert.deepEqual(events, ['desktop:stop']);
  failRelease = false;
  events.length = 0;
  await f.devices.setSlackHost(id);
  assert.deepEqual(events, ['desktop:stop', 'node:start']);
  failRelease = true;
  events.length = 0;
  const blocked = await f.devices.setSlackHost(null);
  assert.ok(blocked.note);
  assert.equal(blocked.slackHost, id);
  assert.equal(live, 'node');
  assert.deepEqual(events, ['node:stop']);
  failRelease = false;
  events.length = 0;
  await f.devices.setSlackHost(null);
  assert.deepEqual(events, ['node:stop', 'desktop:start']);
});

test('only one PugPort runs Slack: handing it to a device and taking it back', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'box' })).devices[0]!.id;
  const handed = await f.devices.setSlackHost(id);
  assert.equal(handed.slackHost, id);
  assert.deepEqual(peer.slackCalls.at(-1), {
    host: true,
    appToken: 'xapp-1-fixture-app-token-0000',
    botToken: 'xoxb-fixture-bot-token-0000',
    users: [{ id: 'U12345', pairedAt: '2026-10-11T08:00:00Z' }],
  });
  assert.deepEqual(f.standby, ['box']);
  // After a restart this computer stays off Slack.
  const restarted = devicesFor(t, { file: f.file });
  await restarted.devices.load();
  assert.deepEqual(restarted.standby, ['box']);

  const back = await f.devices.setSlackHost(null);
  assert.equal(back.slackHost, null);
  assert.deepEqual(peer.slackCalls.at(-1), { host: false });
  assert.deepEqual(f.standby, ['box', undefined]);

  // A device that still runs Slack although it was not chosen is told to stop when it is next seen.
  peer.setSlackHost(true);
  const calls = peer.slackCalls.length;
  await f.devices.probe(id);
  await waitFor(() => (peer.slackCalls.length > calls ? true : undefined));
  assert.deepEqual(peer.slackCalls.at(-1), { host: false });

  const noTokens = devicesFor(t, {
    file: f.file,
    slack: { config: async () => ({ users: [] }), standby: async () => undefined },
  });
  await assert.rejects(noTokens.devices.setSlackHost(id), /填好两个 Token/);
});

// ---- The workspace: an @ message and a delegated sub-task run on the device.

const card = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled: true,
});

function workspaceFixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'devices-workspace-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [card('codex', 'codex', 'Codex B')];
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  const behavior: { codex?: (ctx: ExecuteContext) => Promise<string> } = {};
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    return {
      output: behavior.codex ? await behavior.codex(ctx) : 'local answer',
      nativeSessionId: `s-${calls.length}`,
    };
  });
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    // Only after the database is closed: Windows keeps an open file from being removed.
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep));
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { controller, workspace, bridge, behavior, calls, directory };
}

async function finish(workspace: Workspace, id: string, onTick?: () => void | Promise<void>) {
  for (let i = 0; i < 1000; i++) {
    await workspace.tickQueue();
    await onTick?.();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((done) => setTimeout(done, 10));
  }
  const pending = workspace.store.get<Workflow>('workflow', id)!;
  throw new Error(
    `fixture workflow did not finish: ${JSON.stringify({ status: pending.status, error: pending.error, scheduling: pending.scheduling, deviceTask: pending.deviceTask })}`,
  );
}

test('peer progress is optional and malformed newer progress drops without losing status', () => {
  for (const progress of [
    undefined,
    { step: { kind: 'thinking' } },
    { step: { kind: 'tool', status: 'x'.repeat(31) } },
    { step: { kind: 'tool', tool: 'unsafe tool input' } },
    { lastActivityAt: 'x'.repeat(41) },
    { planStep: { index: 1, total: 1001 } },
    { toolCalls: -1 },
    { toolCalls: 1.5 },
    { planStep: { index: 0, total: 2 } },
  ]) {
    const status = peerTaskStatusSchema.parse({ taskId: 'synthetic', status: 'running', progress });
    assert.equal(status.status, 'running');
    assert.equal(status.progress, undefined);
  }
});

test('device polling reports plan/activity-only changes, uses wait=5, and tolerates newer or old nodes', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t, { resultWaitSeconds: undefined });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'Mac-mini' })).devices[0]!.id;
  const base = {
    lastActivityAt: '2026-10-20T10:32:00Z',
    toolCalls: 12,
    step: { kind: 'tool', tool: 'Edit' },
    planStep: { index: 1, total: 3 },
  };
  const sequence = [
    base,
    base,
    { ...base, planStep: { index: 2, total: 3 } },
    { ...base, planStep: { index: 2, total: 3 }, lastActivityAt: '2026-10-20T10:33:00Z' },
    { ...base, step: { kind: 'thinking' } },
    undefined,
  ];
  let index = 0;
  t.mock.method(
    peer.runner,
    'status',
    (taskId: string) =>
      ({ taskId, status: 'running', executor: 'Claude', progress: sequence[index] }) as ReturnType<
        typeof peer.runner.status
      >,
  );
  const waits: number[] = [];
  t.mock.method(peer.runner, 'result', async (_id: string, wait: number) => {
    waits.push(wait);
    return ++index < sequence.length ? { status: 'running' } : { status: 'completed', result: 'synthetic answer' };
  });
  const reports: Array<{ note: string; progress?: Workflow['remoteProgress'] }> = [];
  const answer = await f.devices.run(workflowFor(id, 'Inspect'), new AbortController().signal, (note, progress) =>
    reports.push({ note, progress }),
  );
  assert.equal(answer.text, 'synthetic answer');
  assert.deepEqual(waits, Array(sequence.length).fill(5));
  assert.deepEqual(
    reports.filter(({ progress }) => progress).map(({ progress }) => progress),
    [sequence[0], sequence[2], sequence[3]],
  );
  assert.equal(
    reports.filter(({ note }) => note.includes('正在处理')).length,
    4,
    'duplicate skipped; invalid progress clears it; old-node empty stays unchanged',
  );
  assert.ok(!reports.some(({ note }) => note.includes('重连')));
});

test('device workflow stores public progress, translates each scheduling segment, then clears on settlement', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'Mac-mini' })).devices[0]!.id;
  const w = workspaceFixture(t);
  w.workspace.remote = f.devices;
  const progress = {
    lastActivityAt: '2026-10-20T10:32:00Z',
    toolCalls: 12,
    step: { kind: 'tool' as const, tool: 'Edit' },
  };
  t.mock.method(peer.runner, 'status', (taskId: string) => ({
    taskId,
    status: 'running',
    executor: 'Claude',
    progress,
  }));
  const conversation = await w.workspace.createGeneralConversation();
  const sent = await w.workspace.send(
    conversation.id,
    (await f.devices.messageFor(
      { content: 'Inspect', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
      id,
    ))!,
  );
  await w.workspace.tickQueue();
  const live = await waitFor(() => {
    const workflow = w.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
    return workflow.remoteProgress ? workflow : undefined;
  });
  assert.deepEqual(live.remoteProgress, progress);
  assert.match(live.scheduling!.reason, /正在 Edit · 已 12 次工具调用 · 最近活动 \d\d:\d\d/);
  const translate = createTranslator(
    JSON.parse(readFileSync(new URL('../src/shared/i18n/en.json', import.meta.url), 'utf8')),
  );
  assert.match(translate(live.scheduling!.reason)!, /Using Edit · 12 tool calls · Last activity \d\d:\d\d/);
  assert.ok(!/[\u3400-\u9fff]/u.test(translate(live.scheduling!.reason)!));
  const taskId = [...peer.tasks.keys()][0]!;
  peer.finish(taskId, 'Synthetic answer');
  const done = await finish(w.workspace, sent.workflow.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.remoteProgress, undefined);
  assert.ok(!done.scheduling!.reason.includes('12'));

  // A chat-only device task often calls no tools: a zero count is not shown.
  Object.assign(progress, { toolCalls: 0, step: { kind: 'writing' as const } });
  const again = await w.workspace.send(conversation.id, { ...sent.workflow.input, content: 'Again' });
  await w.workspace.tickQueue();
  const chatting = await waitFor(() => {
    const workflow = w.workspace.store.get<Workflow>('workflow', again.workflow.id);
    return workflow?.remoteProgress ? workflow : undefined;
  });
  assert.ok(!chatting.scheduling!.reason.includes('工具调用'), chatting.scheduling!.reason);
  peer.fail([...peer.tasks.keys()][1]!, 'Synthetic failure');
  const failed = await finish(w.workspace, again.workflow.id);
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.remoteProgress, undefined);
  assert.equal(failed.scheduling?.reason, failed.error);
});

test('an @ message runs on the device: no executor here, the answer labelled with the device', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: '家里的Ubuntu' })).devices[0]!.id;
  const w = workspaceFixture(t);
  w.workspace.remote = f.devices;
  const conversation = await w.workspace.createGeneralConversation();
  const input = (await f.devices.messageFor(
    { content: '@家里的Ubuntu 看看磁盘', mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-only' },
    id,
  ))!;
  const sent = await w.workspace.send(conversation.id, input);
  const done = await finish(w.workspace, sent.workflow.id, () => {
    for (const [taskId, task] of peer.tasks) if (task.status === 'running') peer.finish(taskId, '磁盘还剩 120 GB。');
  });
  assert.equal(done.status, 'completed');
  assert.equal(w.calls.length, 0, 'no executor on this computer ran');
  assert.match(done.scheduling!.reason, /由设备「家里的Ubuntu」完成 · Claude 测试号/);
  const reply = w.workspace.store.allMessages(conversation.id).find((message) => message.id === done.finalMessageId)!;
  assert.equal(reply.content, '磁盘还剩 120 GB。');
  assert.deepEqual(reply.device, { id, name: '家里的Ubuntu', executor: 'Claude 测试号', model: 'fake-model' });
  assert.equal(w.workspace.store.allMessages(conversation.id)[0]!.content, '@家里的Ubuntu 看看磁盘');

  // Offline: the task ends with a plain reason instead of waiting.
  await peer.listener.close();
  const again = await w.workspace.send(conversation.id, { ...input, content: '@家里的Ubuntu 再看看' });
  const failed = await finish(w.workspace, again.workflow.id);
  assert.equal(failed.status, 'blocked');
  assert.match(failed.error!, /发送结果未知/);
});

test('an executor delegates a read-only sub-task to a device by its name; writes and offline devices are explained', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  await f.devices.add({ address: peer.address, code, name: 'box' });
  const w = workspaceFixture(t);
  w.workspace.remote = f.devices;
  w.controller.deviceNames = () => f.devices.directory().map((device) => device.name);
  const project = await w.workspace.createProject(w.directory);
  const conversation = w.workspace.createConversation(project.id);
  const replies: string[] = [];
  const answer = setInterval(() => {
    for (const [taskId, task] of peer.tasks)
      if (task.status === 'running') peer.finish(taskId, `结论：box 查到了（${task.input.task.length} 字的任务）`);
  }, 20);
  t.after(() => clearInterval(answer));
  const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const text = (reply: { body?: unknown }) =>
    (reply.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
  w.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    assert.match(ctx.input.prompt, /box.*可以接可写子任务/);
    const auth = `Bearer ${ctx.agentBridge.token}`;
    replies.push(text(await w.bridge.handle(auth, call('list_agents', {}))));
    replies.push(text(await w.bridge.handle(auth, call('delegate', { agent: 'box', task: '查一下', write: true }))));
    replies.push(
      text(
        await w.bridge.handle(auth, call('delegate', { agent: 'box', task: '查一下 box 上的日志', wait_seconds: 30 })),
      ),
    );
    return 'parent finished';
  };
  const parent = await w.workspace.send(conversation.id, {
    content: '让 box 帮我查一下日志',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  assert.equal((await finish(w.workspace, parent.workflow.id)).status, 'completed');
  assert.match(replies[0]!, /- box：设备（另一台电脑上的 PugPort/);
  assert.ok(replies[1]!.includes(permissionLine({ mode: 'read-only', source: 'parent' })), replies[1]);
  assert.match(replies[2]!, /设备「box」 已完成/);
  assert.match(replies[2]!, /结论：box 查到了/);
  const child = w.workspace.store
    .workflows(conversation.id)
    .find((workflow) => workflow.delegation?.parentId === parent.workflow.id)!;
  assert.equal(child.delegation?.agent?.label, '设备「box」');
  assert.equal(child.input.permissionMode, 'read-only');
  assert.ok(child.input.deviceId);
  const sent = [...peer.tasks.values()].at(-1)!.input.task;
  assert.match(sent, /查一下 box 上的日志/);
  assert.match(sent, /看不到用户这台电脑上的项目文件/);
  assert.doesNotMatch(sent, /report_progress/);
  assert.equal(w.calls.length, 1, 'only the parent ran here');
});

// Keep the caller running until assertions finish, so queue tests cannot pass by ending its write lease.
async function deviceDelegationFixture(t: TestContext, input: Partial<MessageInput> = {}, web = false, quote = false) {
  let release = () => {};
  let cleanupPeer = () => {};
  t.after(() => {
    release();
    cleanupPeer();
  });
  const peer = await startPeer(t);
  cleanupPeer = () => {
    for (const [id, task] of peer.tasks) if (task.status === 'running') peer.finish(id, 'Synthetic cleanup');
  };
  const f = devicesFor(t);
  const device = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'box' }))
    .devices[0]!;
  const w = workspaceFixture(t);
  w.workspace.remote = f.devices;
  const project = await w.workspace.createProject(w.directory);
  const conversation = w.workspace.createConversation(project.id);
  if (web) {
    const user = w.workspace.store.addMessage(conversation.id, 'user', '/search synthetic');
    const reply = w.workspace.store.addMessage(conversation.id, 'assistant', 'Synthetic search sources');
    w.workspace.store.save('message', user.id, conversation.id, {
      ...user,
      webSearch: { query: 'synthetic', status: 'completed', replyId: reply.id },
    });
    w.workspace.store.save('message', reply.id, conversation.id, {
      ...reply,
      webSearch: { query: 'synthetic', status: 'completed' },
      replyIdentity: { automatic: false, kind: 'system', runs: [] },
    });
  }
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  w.behavior.codex = async () => {
    if (w.calls.length === 1) await held;
    return 'Synthetic local result';
  };
  if (quote) {
    const agents = new ExternalAgents(w.workspace, join(w.directory, 'data'), { autoPoll: false });
    t.after(() => agents.close());
    const quoted = w.workspace.store.addMessage(conversation.id, 'assistant', 'Synthetic third-party text');
    w.workspace.store.save('message', quoted.id, conversation.id, { ...quoted, untrustedContent: true });
    input = agents.taint({
      content: 'Update the synthetic file on box',
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-only',
      ...input,
      quotes: [{ messageId: quoted.id, text: quoted.content }],
    });
  }
  const parent = await w.workspace.send(conversation.id, {
    content: 'Update the synthetic file on box',
    mode: 'build',
    permissionMode: 'workspace-write',
    explicitWrite: true,
    runtimeId: 'codex',
    executionPolicy: 'cli-only',
    autoEscalate: false,
    ...input,
  });
  await w.workspace.tickQueue();
  const execution = await waitFor(() => w.calls[0]);
  const ctx = execution.agentBridge;
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await w.bridge.handle(`Bearer ${ctx!.token}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: name === 'delegate' ? { wait_seconds: 0, ...args } : args },
    });
    return (reply.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
  };
  const children = () =>
    w.workspace.store.workflows(conversation.id).filter((flow) => flow.delegation?.parentId === parent.workflow.id);
  return { ...w, peer, device, parent, conversation, call, children, release };
}

for (const scenario of ['writable', 'read-only', 'graph', 'web', 'ask', 'caller-no-network'] as const) {
  test(`device write delegation respects ${scenario} ceiling`, async (t) => {
    const w = await deviceDelegationFixture(
      t,
      scenario === 'read-only' || scenario === 'graph'
        ? { mode: 'chat', permissionMode: 'read-only', explicitWrite: false }
        : scenario === 'caller-no-network'
          ? { permissionOrigin: { mode: 'workspace-write', source: 'caller', network: false } }
          : {},
      scenario === 'web',
    );
    try {
      if (scenario === 'ask') w.controller.settings.toolApprovalMode = 'ask';
      const options = { agent: 'box', task: 'Update a synthetic remote file', write: true, files: ['/remote/a.txt'] };
      const reply = await w.call(
        scenario === 'graph' ? 'delegate_many' : 'delegate',
        scenario === 'graph' ? { tasks: [{ id: 'a', plan_id: 'remote-part', ...options }] } : options,
      );
      const child = w.children()[0];
      assert.ok(child, reply);
      const write = scenario === 'writable';
      assert.equal(child.input.permissionMode, write ? 'workspace-write' : 'read-only');
      assert.equal(child.delegation?.role, write ? 'worker' : 'scout');
      assert.equal(child.delegation?.scope, undefined, 'remote paths never become local write scopes');
      assert.equal(child.input.permissionOrigin?.source, 'device');
      if (scenario === 'graph')
        assert.equal(
          w.workspace.store
            .get<Workflow>('workflow', w.parent.workflow.id)!
            .taskList?.items.find((item) => item.id === 'remote-part')?.kind,
          'read',
        );
      if (!write) {
        const line =
          scenario === 'web'
            ? '只读 · 当前任务包含网页或搜索结果'
            : scenario === 'ask'
              ? '只读 · 工具审批设为每次询问'
              : scenario === 'caller-no-network'
                ? '只读 · 没有网络权限'
                : permissionLine({ mode: 'read-only', source: 'parent' });
        assert.equal(reply.split(line).length - 1, 1, reply);
        if (scenario === 'graph') assert.ok(reply.startsWith('1.') && reply.includes(`\n   ${line}`), reply);
      }
      const done = await finish(w.workspace, child.id, () => {
        for (const [id, task] of w.peer.tasks)
          if (task.status === 'running') w.peer.finish(id, 'Synthetic remote result');
      });
      assert.equal(done.status, 'completed', done.error ?? '');
      const sent = [...w.peer.tasks.values()].at(-1)!.input;
      assert.equal(sent.write, write);
      if (write) assert.equal(sent.requestId, child.id);
      assert.match(sent.task, /优先看这些文件：\/remote\/a.txt/);
      if (write) {
        assert.match(sent.task, /不安装软件/);
        assert.doesNotMatch(sent.task, /看不到用户这台电脑上的项目文件/);
      }
    } finally {
      w.release();
    }
  });
}

// Round 2: exercise the bridge, queue and real peer payload, never a real device.
for (const graph of [false, true]) {
  for (const identity of ['declared', 'unknown', 'verified', 'owner-setting'] as const) {
    test(`round2 caller ${identity} graph=${graph}`, async (t) => {
      const w = await deviceDelegationFixture(t, {
        permissionOrigin: { mode: 'workspace-write', source: 'caller', network: true },
      });
      const context: CallerContext = {
        client: identity === 'unknown' ? 'unknown' : 'codex',
        mode: 'write',
        verified: identity === 'verified',
        network: true,
        roots: [w.directory],
        evidence: [],
      };
      if (identity === 'owner-setting') w.controller.settings.externalCallers = { codex: 'write' };
      const ceiling = inheritedCeiling(context, w.directory, identity === 'owner-setting' ? 'write' : 'inherit');
      w.workspace.store.save('external-conversation', w.conversation.id, w.conversation.id, { context, ceiling });
      const options = { agent: 'box', task: 'Synthetic remote update', write: true };
      const reply = await w.call(
        graph ? 'delegate_many' : 'delegate',
        graph ? { tasks: [{ id: 'a', ...options }] } : options,
      );
      const child = w.children()[0]!;
      const writable = identity === 'verified';
      assert.equal(child.input.permissionMode, writable ? 'workspace-write' : 'read-only', reply);
      if (!writable) assert.match(reply, /只读.*调用方/);
      await finish(w.workspace, child.id, () => {
        for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
      });
      assert.equal([...w.peer.tasks.values()].at(-1)!.input.write, writable);
    });
  }
}

function changeDeviceParent(w: Awaited<ReturnType<typeof deviceDelegationFixture>>, change: string) {
  const parent = w.workspace.store.get<Workflow>('workflow', w.parent.workflow.id)!;
  if (change === 'web') {
    const user = w.workspace.store.get<import('../src/shared/types.ts').ConversationMessage>(
      'message',
      parent.userMessageId,
    )!;
    w.workspace.store.save('message', user.id, user.conversationId, {
      ...user,
      webSearch: { query: 'synthetic', status: 'completed' },
    });
  } else if (change === 'ask') w.controller.settings.toolApprovalMode = 'ask';
  else if (change === 'network')
    parent.input.permissionOrigin = { mode: 'workspace-write', source: 'caller', network: false };
  else if (change === 'quotes') parent.input.untrustedQuotesOnly = true;
  else if (change === 'untrusted') parent.input.untrustedContent = true;
  else parent.input.permissionMode = 'read-only';
  w.workspace.store.save('workflow', parent.id, parent.conversationId, parent);
}

for (const phase of ['queued', 'continue', 'wake'] as const) {
  for (const change of ['web', 'ask', 'network', 'quotes', 'untrusted', 'read-only']) {
    test(`round2 recheck ${change} at ${phase}`, async (t) => {
      const w = await deviceDelegationFixture(t);
      await w.call('delegate', { agent: 'box', task: 'Synthetic remote edit', write: true });
      const child = w.children()[0]!;
      assert.equal(child.input.permissionMode, 'workspace-write');
      const answer = () => {
        for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
      };
      if (phase !== 'queued') assert.equal((await finish(w.workspace, child.id, answer)).status, 'completed');
      changeDeviceParent(w, change);
      let id = child.id;
      if (phase === 'continue') id = (await w.workspace.continue(child.id, 'Continue synthetic work')).workflow.id;
      if (phase === 'wake') id = (await w.workspace.sendSwarmMessage(child.id, 'Check synthetic follow-up')).workflowId;
      const done = await finish(w.workspace, id, answer);
      assert.equal([...w.peer.tasks.values()].at(-1)!.input.write, false, `${change} ${phase} sent write=true`);
      assert.equal(done.input.permissionMode, 'read-only');
      assert.match(done.input.permissionOrigin?.note ?? '', /只读/);
      assert.ok(w.workspace.takeNotices(w.parent.workflow.id).some((note) => /只读/.test(note)));
      await waitFor(() =>
        !(w.workspace as unknown as { active: Map<string, unknown> }).active.has(id) ? true : undefined,
      );
      assert.doesNotThrow(
        () => w.workspace.archiveWorkflow(id, true),
        'a narrowed continuation retains its member identity',
      );
    });
  }
}

for (const flags of ['content', 'quotes', 'both'] as const) {
  test(`round3 untrusted conversation input ${flags}`, async (t) => {
    const w = await deviceDelegationFixture(
      t,
      flags === 'content' ? { untrustedContent: true } : flags === 'quotes' ? { untrustedQuotesOnly: true } : {},
      false,
      flags === 'both',
    );
    if (flags === 'both') {
      assert.equal(w.parent.workflow.input.untrustedContent, true);
      assert.equal(w.parent.workflow.input.untrustedQuotesOnly, true);
      const message = w.workspace.store
        .allMessages(w.conversation.id)
        .find((m) => m.id === w.parent.workflow.userMessageId)!;
      assert.equal(message.quotes?.length, 1, 'the UI quote is preserved on the actual parent turn');
    }
    const created = await w.workspace.delegateToAgent(
      w.parent.workflow.id,
      { label: 'box', deviceId: w.device.id },
      'Synthetic edit',
      { write: true },
    );
    const child = created.workflow;
    assert.equal(child.input.permissionMode, 'read-only');
    assert.match(child.input.permissionOrigin?.note ?? '', /别人写的文字|不可信/);
    await finish(w.workspace, child.id, () => {
      for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
    });
    assert.equal([...w.peer.tasks.values()].at(-1)!.input.write, false);
  });
}

for (const end of ['failure', 'cancel'] as const) {
  test(`round2 device ${end} releases its queue slot`, async (t) => {
    const w = await deviceDelegationFixture(t);
    await w.call('delegate', { agent: 'box', task: 'Synthetic remote edit', write: true });
    const child = w.children()[0]!;
    if (end === 'failure')
      t.mock.method(w.workspace.remote!, 'run', async () => {
        throw new Error('Synthetic start failure');
      });
    await w.workspace.tickQueue();
    if (end === 'cancel') {
      await waitFor(() => w.peer.tasks.size || undefined);
      w.workspace.cancel(child.id);
    }
    const done = await finish(w.workspace, child.id);
    assert.equal(done.status, end === 'cancel' ? 'cancelled' : 'blocked');
    await waitFor(() =>
      !(w.workspace as unknown as { active: Map<string, unknown> }).active.has(child.id) ? true : undefined,
    );
    const leases = (w.controller as unknown as { leases: Map<string, string> }).leases;
    assert.ok(![...leases.values()].includes(child.id));
    const sibling = await w.workspace.delegateToAgent(
      w.parent.workflow.id,
      { label: 'Local', runtimeId: 'codex', provider: 'codex' },
      'Edit a.txt',
      { write: true, files: ['a.txt'] },
    );
    await w.workspace.tickQueue();
    await waitFor(() => (w.calls.length === 2 ? true : undefined));
    assert.doesNotMatch(
      w.workspace.store.get<Workflow>('workflow', sibling.workflow.id)!.scheduling?.reason ?? '',
      /等待.*重叠/,
    );
  });
}

test('round2 overlapping local writers still serialize', async (t) => {
  let release = () => {};
  t.after(() => release());
  const w = await deviceDelegationFixture(t);
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  w.behavior.codex = async () => {
    await held;
    return 'Synthetic result';
  };
  const local = { label: 'Local', runtimeId: 'codex', provider: 'codex' as const };
  const first = await w.workspace.delegateToAgent(w.parent.workflow.id, local, 'Edit a.txt first', {
    write: true,
    files: ['a.txt'],
  });
  const second = await w.workspace.delegateToAgent(w.parent.workflow.id, local, 'Edit a.txt second', {
    write: true,
    files: ['a.txt'],
  });
  await w.workspace.tickQueue();
  await waitFor(() => (w.calls.length === 2 ? true : undefined));
  assert.match(
    w.workspace.store.get<Workflow>('workflow', second.workflow.id)!.scheduling?.reason ?? '',
    /等待.*重叠的文件/,
  );
  assert.equal(w.calls.length, 2);
  release();
  await finish(w.workspace, first.workflow.id);
  await finish(w.workspace, second.workflow.id);
  assert.equal(w.calls.length, 3);
});

for (const readonly of [false, true]) {
  test(`round2 message sender ceiling readonly=${readonly}`, async (t) => {
    let release = () => {};
    t.after(() => release());
    const w = await deviceDelegationFixture(t);
    await w.call('delegate', { agent: 'box', task: 'Synthetic remote edit', write: true });
    const child = w.children()[0]!;
    const answer = () => {
      for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
    };
    await finish(w.workspace, child.id, answer);
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.behavior.codex = async () => {
      await held;
      return 'Synthetic result';
    };
    const sender = await w.workspace.delegateToAgent(
      w.parent.workflow.id,
      { label: 'Local sender', runtimeId: 'codex', provider: 'codex' },
      'Synthetic local sender',
      { write: !readonly, files: ['a.txt'] },
    );
    await w.workspace.tickQueue();
    await waitFor(() => (w.calls.length === 2 ? true : undefined));
    const run = w.controller.activeRunFor(sender.workflow.id)!;
    const resumed = await w.workspace.messageSwarmAgent(sender.workflow.id, child.id, 'SYNTHETIC_FOLLOW_UP', run);
    const done = await finish(w.workspace, resumed.workflowId, answer);
    assert.equal(done.input.permissionMode, readonly ? 'read-only' : 'workspace-write');
    assert.equal([...w.peer.tasks.values()].at(-1)!.input.write, !readonly);
    assert.match([...w.peer.tasks.values()].at(-1)!.input.task, /SYNTHETIC_FOLLOW_UP/);
    assert.equal(
      w.workspace.store.get<Workflow>('workflow', child.id)!.input.permissionMode,
      'workspace-write',
      'completed permissions are historical',
    );
  });
}

test('round2 rechecks after asynchronous device preparation', async (t) => {
  const w = await deviceDelegationFixture(t);
  await w.call('delegate', { agent: 'box', task: 'Synthetic remote edit', write: true });
  const child = w.children()[0]!;
  const devices = w.workspace.remote as Devices;
  const read = devices.store.read.bind(devices.store);
  t.mock.method(devices.store, 'read', async () => {
    const result = await read();
    changeDeviceParent(w, 'ask');
    return result;
  });
  const done = await finish(w.workspace, child.id, () => {
    for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
  });
  assert.equal(done.input.permissionMode, 'read-only');
  assert.equal([...w.peer.tasks.values()].at(-1)!.input.write, false);
});

test('a task from a device cannot delegate to another device', async (t) => {
  const w = await deviceDelegationFixture(t, { permissionOrigin: { mode: 'workspace-write', source: 'device' } });
  try {
    for (const write of [false, true]) {
      const reply = await w.call('delegate', { agent: 'box', task: 'Synthetic part', write });
      assert.match(reply, /不能再交给另一台设备/);
    }
    assert.equal(w.peer.tasks.size, 0);
    assert.equal(w.children().length, 0);
  } finally {
    w.release();
  }
});

test('a device writer starts beside its running parent and does not hold a local sibling scope', async (t) => {
  const w = await deviceDelegationFixture(t);
  try {
    const reply = await w.call('delegate', { agent: 'box', task: 'Synthetic remote edit', write: true });
    const child = w.children()[0];
    assert.ok(child, reply);
    await w.workspace.tickQueue();
    await waitFor(() => w.peer.tasks.size || undefined);
    assert.equal(w.workspace.store.get<Workflow>('workflow', w.parent.workflow.id)!.status, 'running');
    assert.ok(
      [...w.controller.active.values()].some((entry) => entry.run.workflowId === w.parent.workflow.id && !entry.parked),
    );
    assert.equal([...w.peer.tasks.values()][0]!.status, 'running');
    const sibling = await w.workspace.delegateToAgent(
      w.parent.workflow.id,
      { label: 'Synthetic local', runtimeId: 'codex', provider: 'codex' },
      'Edit a.txt',
      { write: true, files: ['a.txt'] },
    );
    await w.workspace.tickQueue();
    const saved = w.workspace.store.get<Workflow>('workflow', sibling.workflow.id)!;
    assert.doesNotMatch(saved.scheduling?.reason ?? '', /等待.*改完重叠的文件/);
    await waitFor(() => (w.calls.length === 2 ? true : undefined));
    assert.equal(w.calls.length, 2);
    assert.equal([...w.peer.tasks.values()][0]!.status, 'running');
    w.peer.finish([...w.peer.tasks.keys()][0]!, 'Synthetic remote result');
    assert.equal((await finish(w.workspace, child.id)).status, 'completed');
    const siblingDone = await finish(w.workspace, sibling.workflow.id);
    // A delegated permission grant alone is not a file-change expectation.
    assert.equal(siblingDone.status, 'completed');
  } finally {
    w.release();
  }
});

test('a completed top-level read-only device task reruns writable without changing the old task', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t);
  const device = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'box' }))
    .devices[0]!;
  const w = workspaceFixture(t);
  w.workspace.remote = f.devices;
  const conversation = await w.workspace.createGeneralConversation();
  const sent = await w.workspace.send(conversation.id, {
    content: 'Synthetic original request',
    deviceId: device.id,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
  });
  const answer = () => {
    for (const [id, task] of peer.tasks) if (task.status === 'running') peer.finish(id, 'Synthetic result');
  };
  assert.equal((await finish(w.workspace, sent.workflow.id, answer)).status, 'completed');
  const rerun = await w.workspace.rerunWrite(sent.workflow.id);
  assert.equal(rerun.workflow.input.permissionMode, 'workspace-write');
  assert.equal(rerun.workflow.input.deviceId, device.id);
  assert.equal(rerun.workflow.parentWorkflowId, sent.workflow.id);
  assert.equal((await finish(w.workspace, rerun.workflow.id, answer)).status, 'completed');
  const remote = [...peer.tasks.values()].at(-1)!.input;
  assert.equal(remote.write, true);
  assert.match(remote.task, /Synthetic original request/);
  assert.equal(w.workspace.store.get<Workflow>('workflow', sent.workflow.id)!.input.permissionMode, 'read-only');
});

test('a delegated read-only device task cannot rerun writable', async (t) => {
  const w = await deviceDelegationFixture(t);
  try {
    const reply = await w.call('delegate', { agent: 'box', task: 'Synthetic read' });
    const child = w.children()[0];
    assert.ok(child, reply);
    await finish(w.workspace, child.id, () => {
      for (const [id, task] of w.peer.tasks) if (task.status === 'running') w.peer.finish(id, 'Synthetic result');
    });
    await assert.rejects(w.workspace.rerunWrite(child.id), /没有因消息内容改为只读|安全边界/);
  } finally {
    w.release();
  }
});

test('device file sends stream private copies without a task; writable tasks keep remote folders and attachments', async (t) => {
  const peer = await startPeer(t, { projectFolder: (path) => (path === '/remote/work' ? path : undefined) });
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'file-box' })).devices[0]!.id;
  const local = join(f.folder, 'synthetic.txt');
  writeFileSync(local, 'synthetic file contents');
  const first = await f.devices.sendFiles(id, await validateFiles([local]));
  const second = await f.devices.sendFiles(id, await validateFiles([local]));
  assert.equal(peer.tasks.size, 0, 'sending files alone never creates a task');
  assert.notEqual(first[0]!.path, second[0]!.path, 'repeat transfers never overwrite existing files');
  assert.equal(readFileSync(first[0]!.path, 'utf8'), 'synthetic file contents');
  await f.devices.store.update((data) => {
    data.devices[0]!.folders = Array.from({ length: 10 }, (_, index) => `/old/${index}`);
  });
  const workflow = workflowFor(id, 'x'.repeat(50000), {
    deviceFolder: '/remote/work',
    permissionMode: 'workspace-write',
    explicitWrite: true,
  });
  workflow.conversationId = 'synthetic-conversation';
  const notes: string[] = [];
  const running = f.devices.run(workflow, new AbortController().signal, (note) => notes.push(note), [
    { path: local, name: 'original.txt', size: 23 },
  ]);
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  const input = peer.tasks.get(taskId)!.input;
  assert.equal(input.projectPath, '/remote/work');
  assert.equal(input.write, true);
  assert.equal(input.requestId, workflow.id);
  assert.match(input.task, /Files sent to this computer:/);
  assert.match(input.task, /original\.txt/);
  assert.equal(input.task.length, 50000, 'the manifest survives a maximum-length request');
  assert.ok(notes.includes('正在传送文件…'), 'upload announces progress before dispatch');
  peer.finish(taskId, 'Done');
  assert.equal((await running).text, 'Done');
  assert.deepEqual((await f.devices.view()).devices[0]!.folders, [
    '/remote/work',
    ...Array.from({ length: 9 }, (_, index) => `/old/${index}`),
  ]);
});

test('chat asks to update a strict old node that refuses requestId', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        const oldSchema = z
          .object({ task: z.string(), title: z.string().optional(), write: z.boolean().optional() })
          .strict();
        if (!oldSchema.safeParse(JSON.parse(String(init.body))).success)
          return new Response('{"error":"Unrecognized key: requestId"}', { status: 400 });
      }
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'old-chat' }))
    .devices[0]!.id;
  const running = f.devices.run(workflowFor(id, 'Hello'), new AbortController().signal, () => {});
  await assert.rejects(running, /请先更新设备/);
  assert.equal(peer.tasks.size, 0, 'never drop the request id to bypass deduplication');
});

test('a refused folder stays online while an unreachable dispatch marks the device offline', async (t) => {
  const peer = await startPeer(t, { projectFolder: () => undefined });
  let unreachable = false;
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (unreachable && init?.method === 'POST' && String(input).endsWith('/tasks'))
        throw new Error('synthetic unreachable');
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
  const run = () =>
    f.devices.run(
      workflowFor(id, 'Write', { deviceFolder: '/missing', permissionMode: 'workspace-write' }),
      new AbortController().signal,
      () => {},
    );
  await assert.rejects(run(), /没有这个文件夹/);
  assert.equal((await f.devices.view()).devices[0]!.online, true);
  unreachable = true;
  await assert.rejects(run(), /发送结果未知/);
  assert.equal((await f.devices.view()).devices[0]!.online, false);
});

for (const edit of [false, true])
  test(`resend retains device write consent and file paths (edit=${edit})`, async (t) => {
    const w = workspaceFixture(t);
    const conversation = await w.workspace.createGeneralConversation();
    const runs: MessageInput[] = [];
    w.workspace.remote = {
      run: async (workflow: Workflow) => {
        runs.push(structuredClone(workflow.input));
        return { text: 'Done', name: 'synthetic' };
      },
    } as unknown as Devices;
    const path = join(w.directory, 'attachment.txt');
    writeFileSync(path, 'synthetic');
    const sent = await w.workspace.send(conversation.id, {
      content: 'Write on device',
      deviceId: '00000000-0000-4000-8000-000000000001',
      deviceFolder: '/remote',
      deviceFiles: [path],
      mode: 'chat',
      permissionMode: 'workspace-write',
      explicitWrite: true,
      executionPolicy: 'cli-first',
    });
    await finish(w.workspace, sent.workflow.id);
    const message = w.workspace.store.allMessages(conversation.id).find((item) => item.role === 'user')!;
    const resent = edit
      ? await w.workspace.editAndResend(conversation.id, message.id, 'Edit the remote file')
      : await w.workspace.resendMessage(conversation.id, message.id);
    assert.ok('workflow' in resent && resent.workflow);
    await finish(w.workspace, resent.workflow.id);
    assert.equal(runs.length, 2);
    for (const input of runs) {
      assert.equal(input.permissionMode, 'workspace-write');
      assert.equal(input.explicitWrite, true);
      assert.equal(input.deviceFolder, '/remote');
      assert.deepEqual(input.deviceFiles, [path]);
    }
  });

test('write dispatch retries an unreachable POST once with exactly the same body', async (t) => {
  const peer = await startPeer(t, { projectFolder: (path) => path });
  const bodies: string[] = [];
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        bodies.push(String(init.body));
        if (bodies.length === 1) throw new Error('synthetic lost connection');
      }
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'retry-box' }))
    .devices[0]!.id;
  const running = f.devices.run(
    workflowFor(id, 'Write', { deviceFolder: '/remote', permissionMode: 'workspace-write' }),
    new AbortController().signal,
    () => {},
  );
  const taskId = await Promise.race([waitFor(() => [...peer.tasks.keys()][0]), running.then(() => '')]);
  peer.finish(taskId, 'Done');
  assert.equal((await running).text, 'Done');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('round2 a lost writable reply followed by revocation cancels the recovered task', async (t) => {
  const peer = await startPeer(t);
  const dispatch = peer.runner.dispatch.bind(peer.runner);
  t.mock.method(peer.runner, 'dispatch', async (...args: Parameters<typeof dispatch>) => {
    const [input] = args;
    const prior = [...peer.tasks].find(([, task]) => input.requestId && task.input.requestId === input.requestId);
    return prior ? { taskId: prior[0], status: prior[1].status } : dispatch(...args);
  });
  const bodies: { write: boolean; requestId?: string }[] = [];
  let revoked = false;
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        const response = await fetch(input, init);
        if (bodies.length === 1) {
          await response.text();
          revoked = true;
          throw new Error('Synthetic lost accepted reply');
        }
        return response;
      }
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'retry-box' }))
    .devices[0]!.id;
  const workflow = workflowFor(id, 'Synthetic edit', { permissionMode: 'workspace-write' });
  const running = f.devices.run(
    workflow,
    new AbortController().signal,
    () => {},
    [],
    () => {
      if (revoked) workflow.input.permissionMode = 'read-only';
    },
  );
  const rejected = assert.rejects(running, /权限已收窄.*停止请求/);
  void rejected.catch(() => {});
  await waitFor(() => (bodies.length === 2 ? true : undefined));
  // Let the baseline finish rather than leaving the test waiting on its unsafe writable task.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [taskId, task] of peer.tasks) if (task.status === 'running') peer.finish(taskId, 'Synthetic result');
  await rejected;
  assert.equal(peer.tasks.size, 1, 'never dispatch a duplicate');
  assert.deepEqual(
    bodies.map((body) => body.write),
    [true, false],
  );
  assert.equal(bodies[0]!.requestId, bodies[1]!.requestId);
  assert.equal([...peer.tasks.values()][0]!.status, 'cancelled');
});

test('round2 user cancellation retains an unconfirmed remote stop', async (t) => {
  const peer = await startPeer(t);
  const dispatch = peer.runner.dispatch.bind(peer.runner);
  t.mock.method(peer.runner, 'dispatch', async (...args: Parameters<typeof dispatch>) => {
    const [input] = args;
    const prior = [...peer.tasks].find(([, task]) => input.requestId && task.input.requestId === input.requestId);
    return prior ? { taskId: prior[0], status: prior[1].status } : dispatch(...args);
  });
  const w = workspaceFixture(t);
  let workflowId = '';
  let attempts = 0;
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/cancel')) throw new Error('Synthetic stop failure');
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        const response = await fetch(input, init);
        if (++attempts === 1) {
          await response.text();
          w.workspace.cancel(workflowId);
          throw new Error('Synthetic lost accepted reply');
        }
        return response;
      }
      return fetch(input, init);
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code, name: 'cancel-box' }))
    .devices[0]!.id;
  w.workspace.remote = f.devices;
  const conversation = await w.workspace.createGeneralConversation();
  const sent = await w.workspace.send(conversation.id, {
    content: 'Synthetic edit',
    deviceId: id,
    mode: 'build',
    permissionMode: 'workspace-write',
    explicitWrite: true,
    executionPolicy: 'cli-only',
  });
  workflowId = sent.workflow.id;
  await finish(w.workspace, workflowId);
  assert.equal((w.workspace as unknown as { active: Map<string, unknown> }).active.has(workflowId), true);
  const done = w.workspace.store.get<Workflow>('workflow', workflowId)!;
  assert.match(done.error ?? '', /停止请求未确认/);
  assert.match(
    w.workspace.store.allMessages(conversation.id).find((message) => message.id === done.finalMessageId)!.systemNotice!
      .text,
    /停止请求未确认/,
  );
  assert.equal(peer.tasks.size, 1);
  assert.equal([...peer.tasks.values()][0]!.status, 'running', 'the remote task really has not stopped');
});

test('returned files download to safe unique paths and one failed retry stays in the answer', async (t) => {
  const peer = await startPeer(t);
  const payload = new TextEncoder().encode('synthetic returned file');
  const attempts = new Map<string, number>();
  const notes: string[] = [];
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('/files/')) {
        assert.equal(notes.at(-1), '正在传送文件…', 'download announces progress before fetching');
        const id = url.split('/').at(-1)!;
        const count = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, count);
        if (id === 'missing' || (id === 'first' && count === 1)) return new Response('', { status: 500 });
        return new Response(payload);
      }
      return fetch(input, init);
    },
  });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'return-box' })).devices[0]!.id;
  const originalResult = peer.runner.result;
  t.mock.method(peer.runner, 'result', async (...args: Parameters<typeof originalResult>) => {
    const result = await originalResult(...args);
    return result?.status === 'completed'
      ? {
          ...result,
          files: [
            { id: 'first', name: '../report.txt', size: payload.length },
            { id: 'second', name: '../report.txt', size: payload.length },
            { id: 'missing', name: 'missing.txt', size: payload.length },
          ],
        }
      : result;
  });
  const running = f.devices.run(workflowFor(id, 'Prepare files'), new AbortController().signal, (note) =>
    notes.push(note),
  );
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  peer.finish(taskId, 'Prepared');
  const answer = await running;
  const saved = answer.text.split('\n').flatMap((line) => {
    const match = /^收到来自「return-box」的文件：<(.+)>$/.exec(line);
    return match ? [match[1]!] : [];
  });
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0], saved[1]);
  assert.ok(saved.every((path) => path.startsWith(join(downloadsFolder(), 'PugPort', 'return-box') + sep)));
  assert.equal(readFileSync(saved[0]!, 'utf8'), 'synthetic returned file');
  assert.match(answer.text, /文件 missing.txt 下载失败/);
  assert.deepEqual(
    [...attempts],
    [
      ['first', 2],
      ['second', 1],
      ['missing', 2],
    ],
  );
});

test('a failed settled task still delivers files and keeps its failure in the reply', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t, {
    fetch: async (input, init) => (String(input).includes('/files/') ? new Response('partial') : fetch(input, init)),
  });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'partial-box' })).devices[0]!.id;
  const original = peer.runner.result;
  t.mock.method(peer.runner, 'result', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    return result?.status === 'blocked'
      ? { ...result, files: [{ id: 'partial', name: 'partial.txt', size: 7 }] }
      : result;
  });
  const running = f.devices.run(workflowFor(id, 'Prepare partial file'), new AbortController().signal, () => {});
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  peer.fail(taskId, 'synthetic failure');
  await assert.rejects(running, (error: Error) => {
    assert.match(error.message, /synthetic failure/);
    const path = /收到来自「partial-box」的文件：<(.+)>/.exec(error.message)?.[1];
    assert.ok(path);
    assert.equal(readFileSync(path, 'utf8'), 'partial');
    return true;
  });
});

test('an older strict node gives an update command instead of losing write intent', async (t) => {
  const peer = await startPeer(t);
  const f = devicesFor(t, {
    fetch: async (input, init) =>
      String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'Unrecognized key: requestId (old schema)' }), { status: 400 })
        : fetch(input, init),
  });
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'old-box' })).devices[0]!.id;
  await assert.rejects(
    f.devices.run(
      workflowFor(id, 'Make a change', { deviceFolder: '/remote/work', permissionMode: 'workspace-write' }),
      new AbortController().signal,
      () => {},
    ),
    /请先更新设备「old-box」上的 PugPort：pugport node add <ssh target> --now/,
  );
  assert.equal(peer.tasks.size, 0);
});

test('a failed recent-folder save still tracks the accepted remote task', async (t) => {
  const peer = await startPeer(t, { projectFolder: (path) => path });
  const f = devicesFor(t);
  const { code } = peer.registry.createCode();
  const id = (await f.devices.add({ address: peer.address, code, name: 'history-box' })).devices[0]!.id;
  let attempts = 0;
  t.mock.method(f.devices.store, 'update', async () => {
    attempts++;
    throw new Error('Synthetic disk failure');
  });
  const running = f.devices.run(
    workflowFor(id, 'Make a synthetic change', { deviceFolder: '/remote/work', permissionMode: 'workspace-write' }),
    new AbortController().signal,
    () => {},
  );
  const taskId = await waitFor(() => [...peer.tasks.keys()][0]);
  peer.finish(taskId, 'Accepted task finished');
  assert.equal((await running).text, 'Accepted task finished');
  assert.equal(attempts, 1);
});

test('remote workspace writes allow no folder and respect an explicit false write floor', async (t) => {
  const w = workspaceFixture(t);
  const conversation = await w.workspace.createGeneralConversation();
  const base: MessageInput = {
    content: 'Synthetic remote task',
    deviceId: '00000000-0000-4000-8000-000000000001',
    deviceFolder: '/remote/work',
    mode: 'build',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  };
  const denied = await w.workspace.send(conversation.id, { ...base, explicitWrite: false });
  assert.equal(denied.workflow.input.permissionMode, 'read-only');
  assert.equal(denied.workflow.input.mode, 'chat');
  const writable = await w.workspace.send(conversation.id, base);
  assert.equal(writable.workflow.input.permissionMode, 'workspace-write');
  const folderless = await w.workspace.send(conversation.id, {
    ...base,
    deviceFolder: undefined,
    mode: 'auto',
    permissionMode: 'workspace-write',
    explicitWrite: true,
  });
  assert.equal(folderless.workflow.input.permissionMode, 'workspace-write');
  assert.equal(folderless.workflow.input.mode, 'build', 'auto resolves the explicit writable action to build');
});

function mockStoredDevice(t: TestContext, devices: Devices, name: string) {
  const device = {
    id: '00000000-0000-4000-8000-000000000001',
    name,
    address: '100.64.0.9',
    token: 'synthetic-token',
    peerId: 'synthetic-peer',
    pairedAt: '2026-10-21T00:00:00Z',
  };
  const data = { version: 1 as const, devices: [device] };
  t.mock.method(devices.store, 'read', async () => data);
  t.mock.method(devices.store, 'current', () => data);
  return device.id;
}

test('folderless device writes send write and a dedupe key without projectPath', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ taskId: 'synthetic-task', status: 'queued' });
      }
      return Response.json(
        String(input).endsWith('/result')
          ? { status: 'completed', result: 'Installed' }
          : { taskId: 'synthetic-task', status: 'completed' },
      );
    },
  });
  const id = mockStoredDevice(t, f.devices, 'folderless-box');
  const workflow = workflowFor(id, 'Install synthetic software', { permissionMode: 'workspace-write' });
  const running = f.devices.run(workflow, new AbortController().signal, () => {});
  assert.equal((await running).text, 'Installed');
  assert.equal(bodies[0]!.write, true);
  assert.equal(bodies[0]!.requestId, workflow.id);
  assert.equal(Object.hasOwn(bodies[0]!, 'projectPath'), false);
});

test('only the legacy folderless write refusal is translated to an update instruction', async (t) => {
  let refusal = '这台设备只接受只读任务（不改文件）。';
  const f = devicesFor(t, {
    fetch: async () => new Response(JSON.stringify({ error: refusal }), { status: 400 }),
  });
  const id = mockStoredDevice(t, f.devices, 'old-box');
  const run = () =>
    f.devices.run(
      workflowFor(id, 'Install synthetic software', {
        permissionMode: 'workspace-write',
      }),
      new AbortController().signal,
      () => {},
    );
  await assert.rejects(run(), /请先更新设备「old-box」/);
  refusal = '这台设备已关闭写入（PUGPORT_PEER_READ_ONLY=1）。';
  await assert.rejects(run(), /已关闭写入/);
});

test('a device write runs while its local conversation folder has a write lock', async (t) => {
  const w = workspaceFixture(t);
  const conversation = await w.workspace.createGeneralConversation();
  const project = w.workspace.store.projects().find((project) => project.id === conversation.projectId)!;
  w.controller.reserveProject(project.path, 'synthetic-local-writer', 'workspace-write');
  w.workspace.remote = { run: async () => ({ text: 'remote wrote', name: 'synthetic' }) } as unknown as Devices;
  const sent = await w.workspace.send(conversation.id, {
    content: 'Write on device',
    deviceId: '00000000-0000-4000-8000-000000000001',
    deviceFolder: '/remote',
    mode: 'chat',
    permissionMode: 'workspace-write',
    explicitWrite: true,
    executionPolicy: 'cli-first',
  });
  assert.equal((await finish(w.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(w.calls.length, 0);
});

test('device readings survive offline and restart; cache excludes secrets and addresses and removal persists', async (t) => {
  const folder = temporaryFolder(t, 'device-cache-');
  const file = join(folder, 'devices.json');
  const cacheFile = join(folder, 'status.json');
  let now = Date.parse('2026-10-21T00:00:00Z');
  const hardware = {
    os: 'Synthetic Ubuntu',
    cpu: 'Synthetic CPU',
    memoryTotal: 16000,
    memoryAvailable: 9000,
    readAt: new Date(now).toISOString(),
  };
  let runtimeFailure = false;
  let hardwarePending = false;
  const resources = {
    cpuPercent: 39,
    gpuPercent: 12,
    memoryUsed: 7000,
    memoryTotal: 16000,
    observedAt: new Date(now).toISOString(),
  };
  const info = () => ({
    name: 'PugPort',
    version: '0.0.test',
    role: 'node' as const,
    hostname: 'fixture',
    peerName: 'Synthetic owner',
    platform: 'linux',
    arch: 'x64',
    capabilities: {},
    slackHost: false,
    hardware: hardwarePending ? undefined : hardware,
    resources,
  });
  const peer = await startPeer(t, {
    info,
    runtimes: async () => {
      if (runtimeFailure) throw new Error('temporary');
      return {
        executors: [
          {
            label: 'Codex',
            provider: 'codex',
            status: 'ready',
            plan: 'Plus',
            stale: true,
            windows: [{ name: '5h', remaining: 80, resetsAt: '2026-10-22T00:00:00Z' }],
            observedAt: new Date(now).toISOString(),
          },
        ],
        running: 0,
      };
    },
  });
  const options = { file, cacheFile, selfName: 'Synthetic', now: () => now, helperTimeoutMs: 15000 };
  const devices = new Devices(options);
  const added = (await devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!;
  assert.deepEqual(added.hardware, hardware);
  assert.deepEqual(added.resources, resources);
  assert.equal(added.executors![0]!.plan, 'Plus');
  const cached = readFileSync(cacheFile, 'utf8');
  assert.doesNotMatch(cached, /resources|cpuPercent|gpuPercent/);
  assert.doesNotMatch(cached, /token|address|127\.0\.0\.1|peerName|hostname|Synthetic owner/);
  assert.deepEqual(Object.keys(JSON.parse(cached)[added.id].info).sort(), [
    'arch',
    'hardware',
    'platform',
    'slackHost',
    'version',
  ]);
  const restarted = new Devices(options);
  await restarted.load();
  const restored = (await restarted.view()).devices[0]!;
  assert.equal(restored.online, undefined);
  assert.equal(restored.resources, undefined);
  assert.deepEqual(restored.hardware, hardware);
  assert.deepEqual(restored.executors, added.executors);
  assert.equal(restored.hostname, 'fixture', 'cached cards use the paired hostname');
  runtimeFailure = true;
  hardwarePending = true;
  now += 1000;
  await devices.probe(added.id);
  assert.deepEqual((await devices.view()).devices[0]!.executors, added.executors);
  assert.deepEqual((await devices.view()).devices[0]!.hardware, hardware, 'a restarting node keeps the last hardware');
  const latestSeen = (await devices.view()).devices[0]!.lastSeenAt;
  await peer.listener.close();
  now += 1000;
  await devices.probe(added.id);
  const offline = (await devices.view()).devices[0]!;
  assert.equal(offline.online, false);
  assert.deepEqual(offline.hardware, hardware);
  assert.equal(offline.resources, undefined);
  assert.doesNotMatch(readFileSync(cacheFile, 'utf8'), /resources|cpuPercent|gpuPercent/);
  assert.deepEqual(offline.executors, added.executors);
  assert.equal(offline.lastSeenAt, latestSeen);
  const afterOffline = new Devices(options);
  await afterOffline.load();
  assert.equal((await afterOffline.view()).devices[0]!.lastSeenAt, latestSeen);
  await devices.remove(added.id);
  assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')), {});
});

test('a successful probe before load preserves other cached devices and strips old cached identity fields', async (t) => {
  const folder = temporaryFolder(t, 'device-cache-race-');
  const options = {
    file: join(folder, 'devices.json'),
    cacheFile: join(folder, 'status.json'),
    selfName: 'Synthetic',
    helperTimeoutMs: 15000,
  };
  const firstPeer = await startPeer(t);
  const secondPeer = await startPeer(t);
  const devices = new Devices(options);
  const first = (
    await devices.add({ address: firstPeer.address, code: firstPeer.registry.createCode().code, name: 'First' })
  ).devices[0]!;
  const second = (
    await devices.add({ address: secondPeer.address, code: secondPeer.registry.createCode().code, name: 'Second' })
  ).devices[1]!;
  const saved = JSON.parse(readFileSync(options.cacheFile, 'utf8'));
  saved.orphan = saved[second.id];
  saved[second.id].info.hostname = 'Old synthetic hostname';
  saved[second.id].info.peerName = 'Old synthetic owner';
  writeFileSync(options.cacheFile, JSON.stringify(saved));
  const restarted = new Devices(options);
  await restarted.store.read();
  await restarted.probe(first.id);
  const afterProbe = readFileSync(options.cacheFile, 'utf8');
  assert.deepEqual(JSON.parse(afterProbe)[second.id].runtimes.executors, second.executors);
  assert.doesNotMatch(afterProbe, /token|address|peerName|hostname|Old synthetic/);
  await restarted.load();
  assert.deepEqual((await restarted.view()).devices[1]!.executors, second.executors);
  await restarted.remove(first.id);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(options.cacheFile, 'utf8'))), [second.id]);
});

test('old nodes and malformed hardware stay online, corrupt cache is ignored and load keeps fresher probes', async (t) => {
  const folder = temporaryFolder(t, 'device-cache-old-');
  const options = {
    file: join(folder, 'devices.json'),
    cacheFile: join(folder, 'status.json'),
    selfName: 'Synthetic',
    helperTimeoutMs: 15000,
  };
  let hardware: unknown;
  let resources: unknown;
  const peer = await startPeer(t, {
    info: () => ({
      name: 'PugPort',
      version: '1',
      role: 'node',
      hostname: 'fixture',
      platform: 'linux',
      arch: 'x64',
      capabilities: {},
      slackHost: false,
      hardware: hardware as never,
      resources: resources as never,
    }),
  });
  const devices = new Devices(options);
  const added = (await devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!;
  assert.equal(added.online, true);
  assert.equal(added.hardware, undefined);
  assert.equal(added.resources, undefined);
  resources = { cpuPercent: 101, observedAt: new Date().toISOString() };
  hardware = { os: 42 };
  await devices.probe(added.id);
  assert.equal((await devices.view()).devices[0]!.online, true);
  assert.equal((await devices.view()).devices[0]!.resources, undefined);
  hardware = { os: 'New reading', readAt: '2026-10-21T00:00:00Z' };
  await devices.probe(added.id);
  await devices.load();
  assert.deepEqual((await devices.view()).devices[0]!.hardware, hardware);
  writeFileSync(options.cacheFile, 'broken json');
  const restarted = new Devices(options);
  await restarted.load();
  assert.equal((await restarted.view()).devices[0]!.hardware, undefined);
});

test('only tunnel devices strip the local suffix from executors, task status and routing notes', async () => {
  for (const tunnel of [undefined, { ssh: 'fixture-box', remotePort: 4318 }]) {
    const tunnels = new SshTunnels();
    tunnels.isOpen = () => true;
    tunnels.ensure = async () => 47003;
    let statuses = 0;
    const devices = new Devices({
      file: 'unused',
      selfName: 'synthetic',
      tunnels,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/peer/v1/info')
          return Response.json({
            name: 'PugPort',
            version: '1',
            role: 'node',
            hostname: 'fixture',
            platform: 'linux',
            arch: 'x64',
            capabilities: {},
            slackHost: false,
          });
        if (path === '/peer/v1/runtimes')
          return Response.json({
            executors: ['Codex · 本机', 'Claude· 本机', '本机 helper'].map((label) => ({
              label,
              provider: 'codex',
              status: 'ready',
              windows: [],
              observedAt: null,
            })),
            running: 1,
          });
        if (path === '/peer/v1/tasks') return Response.json({ taskId: 'fixture-task', status: 'queued' });
        if (path === '/peer/v1/tasks/fixture-task') {
          statuses++;
          return Response.json({
            taskId: 'fixture-task',
            status: statuses === 1 ? 'waiting-resource' : 'running',
            executor: 'Codex · 本机',
            model: 'fixture-model',
            note: 'Codex · 本机 和 Claude · 本机 正在忙',
          });
        }
        if (path === '/peer/v1/tasks/fixture-task/result')
          return Response.json({
            taskId: 'fixture-task',
            status: statuses === 1 ? 'running' : 'completed',
            result: 'done',
          });
        throw new Error('Unexpected fixture request: ' + path);
      },
    });
    const saved = {
      version: 1 as const,
      devices: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'fixture-box',
          address: '127.0.0.1:47003',
          token: 'a'.repeat(64),
          peerId: 'peer',
          pairedAt: '',
          ...(tunnel ? { tunnel } : {}),
        },
      ],
    };
    devices.store.read = async () => saved;
    devices.store.current = () => saved;
    const view = (await devices.view(true)).devices[0]!;
    assert.equal(view.online, true);
    assert.equal(view.running, 1);
    assert.deepEqual(
      view.executors!.map((executor) => executor.label),
      tunnel ? ['Codex', 'Claude', '本机 helper'] : ['Codex · 本机', 'Claude· 本机', '本机 helper'],
    );
    const notes: string[] = [];
    const result = await devices.run(workflowFor(view.id, 'Synthetic task'), new AbortController().signal, (note) =>
      notes.push(note),
    );
    const label = tunnel ? 'Codex' : 'Codex · 本机';
    assert.equal(result.executor, label);
    assert.ok(notes.includes('设备「fixture-box」：正在处理 · ' + label + '（fixture-model）'));
    assert.ok(
      notes.includes(
        tunnel
          ? '设备「fixture-box」：排队中，Codex 和 Claude 正在忙'
          : '设备「fixture-box」：排队中，Codex · 本机 和 Claude · 本机 正在忙',
      ),
    );
  }
});

test('refresh skips recently offline devices but keeps online and unknown devices live', async (t) => {
  let now = 0;
  const calls: string[] = [];
  const f = devicesFor(t, {
    now: () => now,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.port + url.pathname);
      if (url.port === '4318') throw new Error('synthetic offline');
      return Response.json(
        url.pathname.endsWith('/info')
          ? {
              name: 'PugPort',
              version: '1',
              role: 'node',
              hostname: 'fixture',
              platform: 'linux',
              arch: 'x64',
              capabilities: {},
              slackHost: false,
              peerName: 'fixture',
            }
          : { executors: [], running: 0 },
      );
    },
  });
  writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      devices: [4318, 4319].map((port, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i}`,
        name: `fixture-${i}`,
        address: `127.0.0.1:${port}`,
        token: 'f'.repeat(43),
        peerId: 'fixture',
        pairedAt: new Date(0).toISOString(),
      })),
    }),
  );
  const first = await f.devices.view(true);
  assert.deepEqual(
    first.devices.map((d) => d.online),
    [false, true],
  );
  assert.equal(calls.length, 4, 'both unknown devices are probed');
  calls.length = 0;
  now = 29_999;
  await f.devices.view(true);
  assert.deepEqual(calls.sort(), ['4319/peer/v1/info', '4319/peer/v1/runtimes']);
  calls.length = 0;
  now = 30_000;
  await f.devices.view(true);
  assert.equal(calls.length, 4, 'offline devices are retried at thirty seconds');
});

test('probe starts info and runtimes together, keeps runtimes on failure and marks info failure offline', async (t) => {
  const pending = new Map<string, (response: Response) => void>();
  const f = devicesFor(t, {
    fetch: (input) =>
      new Promise<Response>((resolve) => {
        pending.set(new URL(String(input)).pathname, resolve);
      }),
  });
  const id = '00000000-0000-4000-8000-000000000000';
  writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      devices: [
        {
          id,
          name: 'fixture',
          address: '127.0.0.1:4318',
          token: 'f'.repeat(43),
          peerId: 'fixture',
          pairedAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  await f.devices.load();
  const info = {
    name: 'PugPort',
    version: '1',
    role: 'node',
    hostname: 'fixture',
    platform: 'linux',
    arch: 'x64',
    capabilities: {},
    slackHost: false,
    peerName: 'fixture',
  };
  const runtimes = {
    executors: [{ label: 'Fixture', provider: 'codex', status: 'ready', windows: [], observedAt: null }],
    running: 1,
  };
  for (const failure of ['none', 'runtimes', 'info']) {
    pending.clear();
    const probe = f.devices.probe(id);
    assert.equal(f.devices.probe(id), probe, 'concurrent probes share requests');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      [...pending.keys()].sort(),
      ['/peer/v1/info', '/peer/v1/runtimes'],
      'neither request waits for the other',
    );
    pending.get('/peer/v1/runtimes')!(
      failure === 'runtimes' ? new Response('{}', { status: 500 }) : Response.json(runtimes),
    );
    pending.get('/peer/v1/info')!(failure === 'info' ? new Response('{}', { status: 500 }) : Response.json(info));
    assert.equal((await probe).online, failure !== 'info');
    const device = (await f.devices.view()).devices[0]!;
    assert.deepEqual(device.executors, runtimes.executors);
    assert.equal(device.online, failure !== 'info');
  }
});

for (const outcome of ['failure', 'timeout', 'pending', 'confirmed'] as const) {
  test(`round3 cancel ${outcome} waits for a terminal device state and retains the lease otherwise`, async (t) => {
    const peer = await startPeer(t);
    const w = workspaceFixture(t);
    const released: string[] = [];
    const release = w.controller.releaseProject.bind(w.controller);
    t.mock.method(w.controller, 'releaseProject', (path: string, owner: string) => {
      released.push(owner);
      release(path, owner);
    });
    let allowStop = false;
    let cancelRequested = false;
    const f = devicesFor(t, {
      stopTimeoutMs: 250,
      fetch: async (input, init) => {
        if (String(input).endsWith('/cancel') && !allowStop) {
          cancelRequested = true;
          if (outcome === 'failure') throw new Error('Synthetic cancel failure');
          if (outcome === 'timeout')
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
            });
          if (outcome === 'pending') return new Response('{"ok":true}');
          return new Response('{"ok":true}');
        }
        return fetch(input, init);
      },
    });
    const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
    w.workspace.remote = f.devices;
    const conversation = await w.workspace.createGeneralConversation();
    const sent = await w.workspace.send(conversation.id, {
      content: 'Synthetic edit',
      deviceId: id,
      mode: 'build',
      permissionMode: 'workspace-write',
      explicitWrite: true,
      executionPolicy: 'cli-only',
    });
    await w.workspace.tickQueue();
    await waitFor(() => (peer.tasks.size ? true : undefined));
    w.workspace.cancel(sent.workflow.id);
    await waitFor(() => (cancelRequested ? true : undefined));
    assert.notEqual(
      w.workspace.store.get<Workflow>('workflow', sent.workflow.id)!.status,
      'cancelled',
      'cancel ACK is not a terminal state',
    );
    if (outcome === 'confirmed') for (const id of peer.tasks.keys()) peer.runner.cancel(id);
    const done = await finish(w.workspace, sent.workflow.id);
    if (outcome === 'confirmed') {
      assert.equal(done.status, 'cancelled');
      assert.equal(done.stopped, true);
      await waitFor(() => (released.includes(done.id) ? true : undefined));
    } else {
      assert.equal(done.status, 'blocked', 'an unconfirmed stop must not be reported as stopped');
      assert.notEqual(done.stopped, true);
      assert.match(done.error ?? '', /停止.*未确认/);
      assert.equal(released.includes(done.id), false, 'retain the device task lease');
      assert.equal(
        (w.workspace as unknown as { active: Map<string, unknown> }).active.has(done.id),
        true,
        'retain the active device slot',
      );
      assert.equal([...peer.tasks.values()][0]!.status, 'running');
      allowStop = true;
      w.workspace.cancel(done.id);
      const confirmed = await finish(w.workspace, done.id);
      assert.equal(confirmed.status, 'cancelled');
      assert.equal(peer.tasks.size, 1, 'retry stop never dispatches another task');
    }
  });
}

for (const cancel of [false, true]) {
  test(`round3 two lost write replies stay unknown and retry the same task (cancel=${cancel})`, async (t) => {
    const peer = await startPeer(t);
    const dispatch = peer.runner.dispatch.bind(peer.runner);
    t.mock.method(peer.runner, 'dispatch', async (...args: Parameters<typeof dispatch>) => {
      const prior = [...peer.tasks].find(([, task]) => task.input.requestId === args[0].requestId);
      return prior ? { taskId: prior[0], status: prior[1].status } : dispatch(...args);
    });
    const w = workspaceFixture(t);
    let workflowId = '';
    const ids: string[] = [];
    let recovering = false;
    const f = devicesFor(t, {
      fetch: async (input, init) => {
        if (String(input).includes('/peer/v1/requests/') && !recovering)
          throw new Error('Synthetic recovery connection lost');
        const response = await fetch(input, init);
        if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
          ids.push(JSON.parse(String(init.body)).requestId);
          if (ids.length <= 2) {
            await response.text();
            if (cancel && ids.length === 1) w.workspace.cancel(workflowId);
            throw new Error('Synthetic lost accepted reply');
          }
        }
        return response;
      },
    });
    const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
    w.workspace.remote = f.devices;
    const conversation = await w.workspace.createGeneralConversation();
    const sent = await w.workspace.send(conversation.id, {
      content: 'Synthetic edit',
      deviceId: id,
      mode: 'build',
      permissionMode: 'workspace-write',
      explicitWrite: true,
      executionPolicy: 'cli-only',
    });
    workflowId = sent.workflow.id;
    const done = await finish(w.workspace, workflowId);
    assert.match(done.error ?? '', cancel ? /停止.*未确认/ : /结果.*未知/, 'an attempted write may have executed');
    assert.doesNotMatch(done.error ?? '', /没有发出去|已停止/);
    assert.equal(done.status, 'blocked');
    assert.notEqual(done.stopped, true);
    recovering = true;
    if (cancel) w.workspace.cancel(done.id);
    else {
      const retried = await w.workspace.continue(done.id);
      assert.equal(retried.workflow.id, done.id, 'safe retry keeps the original dedupe identity');
    }
    const retried = await finish(w.workspace, done.id, () => {
      if (!cancel) for (const [id, task] of peer.tasks) if (task.status === 'running') peer.finish(id, 'Recovered');
    });
    assert.equal(retried.status, cancel ? 'cancelled' : 'completed', retried.error ?? '');
    assert.equal(ids.length, cancel ? 1 : 2, 'recovery only looks up or cancels the original request');
    assert.deepEqual([...new Set(ids)], [workflowId]);
    assert.equal(peer.tasks.size, 1, 'the device dedupes every retry');
  });
}

for (const write of [false, true]) {
  for (const trigger of ['lookup', 'capacity'] as const) {
    for (const outcome of ['confirmed', 'unreachable', 'old-node', 'budget-full'] as const) {
      test(`${outcome === 'budget-full' ? 'round7' : 'round6'} late POST after ${trigger} (${write}, ${outcome})`, async (t) => {
        const peer = await startPeer(t);
        const w = workspaceFixture(t);
        const released: string[] = [];
        const release = w.controller.releaseProject.bind(w.controller);
        t.mock.method(w.controller, 'releaseProject', (path: string, owner: string) => {
          released.push(owner);
          release(path, owner);
        });
        let posts = 0;
        let cancels = 0;
        let lookedUp = false;
        let cancelCode: string | undefined;
        let deliverLate!: () => Promise<Response>;
        let allowCancel!: () => void;
        const cancelGate = new Promise<void>((resolve) => {
          allowCancel = resolve;
        });
        t.after(() => allowCancel());
        const f = devicesFor(t, {
          stopTimeoutMs: outcome === 'budget-full' ? 10_000 : 1000,
          fetch: async (input, init) => {
            const url = String(input);
            if (url.endsWith('/peer/v1/tasks') && init?.method === 'POST') {
              posts++;
              deliverLate ??= () => fetch(input, init);
              if (trigger === 'capacity' && posts === 2)
                return new Response(JSON.stringify({ error: '没有发出去', code: 'PEER_REQUEST_NOT_SENT' }), {
                  status: 409,
                });
              throw new Error('Synthetic POST delayed in transit');
            }
            if (url.includes('/peer/v1/requests/')) {
              if (url.endsWith('/cancel')) {
                cancels++;
                await cancelGate;
                if (outcome === 'unreachable') throw new Error('Synthetic node unreachable');
                if (outcome === 'old-node') return new Response('{}', { status: 404 });
              } else lookedUp = true;
            }
            const response = await fetch(input, init);
            if (outcome === 'budget-full' && url.endsWith('/cancel')) cancelCode = (await response.clone().json()).code;
            return response;
          },
        });
        const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!
          .id;
        if (outcome === 'budget-full') {
          const node = externalTaskRunner({} as ExternalTasks, w.workspace.store);
          // Fill the budget before the timed cancel: 1000 commits inside it outlasted the 10 s stop timeout on hosted Windows.
          for (let i = 0; i < 1000; i++) await node.cancelRequest(`synthetic-${i}`, peer.registry.list()[0]!.id);
          t.mock.method(peer.runner, 'cancelRequest', (requestId: string, peerId: string) =>
            node.cancelRequest(requestId, peerId),
          );
        }
        w.workspace.remote = f.devices;
        const conversation = await w.workspace.createGeneralConversation();
        const sent = await w.workspace.send(conversation.id, {
          content: 'Synthetic delayed request',
          deviceId: id,
          mode: 'chat',
          permissionMode: write ? 'workspace-write' : 'read-only',
          explicitWrite: write,
          executionPolicy: 'cli-only',
        });
        if (trigger === 'lookup') {
          assert.equal((await finish(w.workspace, sent.workflow.id)).deviceTask?.uncertain, true);
          await w.workspace.continue(sent.workflow.id);
        }
        await w.workspace.tickQueue();
        await waitFor(() => (cancels > 0 || released.includes(sent.workflow.id) ? true : undefined));
        const before = w.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
        assert.doesNotMatch(before.error ?? '', /没有发出去/, 'no not-sent claim before confirmed cancel');
        assert.equal(cancels, 1, 'lookup absence or capacity refusal must request cancellation');
        assert.equal(released.includes(before.id), false, 'slot stays held until cancellation is confirmed');
        assert.equal((w.workspace as unknown as { active: Map<string, unknown> }).active.has(before.id), true);
        assert.equal(lookedUp, trigger === 'lookup');
        allowCancel();
        const done = await finish(w.workspace, before.id);
        if (outcome === 'budget-full') assert.equal(cancelCode, 'PEER_CANCEL_UNCONFIRMED');
        assert.equal(posts, 2, 'recovery never sends a new task');
        if (outcome === 'confirmed') {
          assert.match(done.error ?? '', /没有发出去/);
          assert.notEqual(done.deviceTask?.uncertain, true);
          await waitFor(() => (released.includes(done.id) ? true : undefined));
          assert.equal((w.workspace as unknown as { active: Map<string, unknown> }).active.has(done.id), false);
          assert.equal((await deliverLate()).status, 409, 'confirmed tombstone refuses the late original POST');
          assert.equal(peer.tasks.size, 0);
        } else {
          assert.match(done.error ?? '', /未知/);
          assert.doesNotMatch(done.error ?? '', /没有发出去/);
          assert.equal(done.deviceTask?.uncertain, true);
          assert.equal(released.includes(done.id), false);
          assert.equal((w.workspace as unknown as { active: Map<string, unknown> }).active.has(done.id), true);
        }
      });
    }
  }
  for (const action of ['retry', 'cancel', 'old-node', 'completed'] as const) {
    test(`round4 unknown send resolves without creating a task (${write}, ${action})`, async (t) => {
      const peer = await startPeer(t);
      const w = workspaceFixture(t);
      let recovering = false;
      const posts: string[] = [];
      const requests: string[] = [];
      const released: string[] = [];
      const release = w.controller.releaseProject.bind(w.controller);
      t.mock.method(w.controller, 'releaseProject', (path: string, owner: string) => {
        released.push(owner);
        release(path, owner);
      });
      const f = devicesFor(t, {
        stopTimeoutMs: 250,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.includes('/peer/v1/requests/')) {
            requests.push(url);
            if (action === 'old-node') return new Response('{"error":"No route"}', { status: 404 });
          }
          if (url.endsWith('/peer/v1/tasks') && init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)).requestId);
            if (!recovering) {
              if (action === 'completed' && peer.tasks.size === 0) {
                await (await fetch(input, init)).text();
                peer.finish([...peer.tasks.keys()][0]!, 'Already finished');
              }
              throw new Error('Synthetic request or reply lost');
            }
          }
          return fetch(input, init);
        },
      });
      const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
      w.workspace.remote = f.devices;
      const conversation = await w.workspace.createGeneralConversation();
      const sent = await w.workspace.send(conversation.id, {
        content: 'Synthetic round4 request',
        deviceId: id,
        mode: 'chat',
        permissionMode: write ? 'workspace-write' : 'read-only',
        explicitWrite: write,
        executionPolicy: 'cli-only',
      });
      const unknown = await finish(w.workspace, sent.workflow.id);
      assert.equal(unknown.deviceTask?.uncertain, true);
      recovering = true;
      if (action === 'retry') await w.workspace.continue(unknown.id);
      else w.workspace.cancel(unknown.id);
      const done = await finish(w.workspace, unknown.id, () => {
        // Keep a broken baseline from hanging after it accidentally dispatches.
        for (const [taskId, task] of peer.tasks)
          if (task.status === 'running') peer.finish(taskId, 'Accidental dispatch');
      });
      assert.equal(posts.length, 2, 'recovery must not POST another task');
      assert.deepEqual([...new Set(posts)], [sent.workflow.id], 'every send carries the same request id');
      assert.ok(requests.every((url) => url.includes(sent.workflow.id)) && requests.length > 0);
      if (action === 'old-node') {
        assert.equal(done.status, 'blocked');
        assert.match(done.error ?? '', /停止.*未确认/);
        assert.equal(done.deviceTask?.uncertain, true);
        assert.equal(released.includes(done.id), false);
      } else {
        assert.equal(done.status, action === 'completed' ? 'completed' : action === 'cancel' ? 'cancelled' : 'blocked');
        if (action === 'retry') assert.match(done.error ?? '', /没有发出去/);
        if (action === 'completed') {
          assert.notEqual(done.stopped, true);
          assert.equal(done.error, undefined, 'a confirmed result clears the old unknown-send error');
          assert.equal(
            w.workspace.store.get<{ content: string }>('message', done.finalMessageId!)!.content,
            'Already finished',
          );
        }
        assert.notEqual(done.deviceTask?.uncertain, true);
        await waitFor(() => (released.includes(done.id) ? true : undefined));
        assert.equal((w.workspace as unknown as { active: Map<string, unknown> }).active.has(done.id), false);
      }
      assert.equal(peer.tasks.size, action === 'completed' ? 1 : 0, 'lookup and stop must never create a task');
    });
  }
}

test('round4 read-only lost reply retries the same request id and creates only one task', async (t) => {
  const peer = await startPeer(t);
  const ids: string[] = [];
  const f = devicesFor(t, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
        ids.push(JSON.parse(String(init.body)).requestId);
        if (ids.length === 1) {
          await response.text();
          throw new Error('Synthetic lost reply');
        }
      }
      return response;
    },
  });
  const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
  const workflow = workflowFor(id, 'Synthetic read');
  const running = f.devices.run(workflow, new AbortController().signal, () => {});
  const settled = running.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await waitFor(() => (peer.tasks.size ? true : undefined));
  for (const taskId of peer.tasks.keys()) peer.finish(taskId, 'Recovered');
  const result = await settled;
  assert.ok('value' in result, 'a lost read-only reply must be recoverable');
  assert.equal(result.value.text, 'Recovered');
  assert.deepEqual(ids, [workflow.id, workflow.id]);
  assert.equal(peer.tasks.size, 1);
});

for (const stopAfter of [1, 2]) {
  test(`round4 cancellation during lost send ${stopAfter} looks up without dispatching`, async (t) => {
    const peer = await startPeer(t);
    const abort = new AbortController();
    let posts = 0;
    let lookups = 0;
    const f = devicesFor(t, {
      fetch: async (input, init) => {
        if (String(input).endsWith('/peer/v1/tasks') && init?.method === 'POST') {
          if (++posts === stopAfter) abort.abort();
          throw new Error('Synthetic request never arrived');
        }
        if (String(input).includes('/peer/v1/requests/')) lookups++;
        return fetch(input, init);
      },
    });
    const id = (await f.devices.add({ address: peer.address, code: peer.registry.createCode().code })).devices[0]!.id;
    const workflow = workflowFor(id, 'Synthetic read');
    await assert.rejects(
      f.devices.run(workflow, abort.signal, () => {}),
      (error) => error === abort.signal.reason,
    );
    assert.equal(posts, stopAfter);
    assert.equal(lookups, 1);
    assert.equal(peer.tasks.size, 0);
    assert.notEqual(workflow.deviceTask?.uncertain, true);
  });
}
