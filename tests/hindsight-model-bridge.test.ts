import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import type { RunInput, RunRecord } from '../src/shared/types.ts';
import { HindsightModelBridge, type HindsightBridgeHost } from '../src/server/hindsight-model-bridge.ts';

async function fixture(
  options: { dailyModelCalls?: number; output?: string; fail?: boolean; delay?: boolean; modelTimeoutMs?: number } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pugport-hindsight-bridge-'));
  const settings = {
    ...defaultHindsightSettings,
    enabled: true,
    runtimeId: 'managed-api',
    projectIds: ['project'],
    dailyModelCalls: options.dailyModelCalls ?? 20,
  };
  const calls: RunInput[] = [];
  const cancelled: string[] = [];
  const targets = [
    { id: 'managed-api', enabled: true, gateway: 'api', apiProvider: 'synthetic', apiBudget: { perRunUsd: 0.1 } },
  ] as HindsightBridgeHost['controller']['targets'];
  let beforeRun: (() => void) | undefined;
  let projectState: 'active' | 'removed' | 'purging' | 'missing' = 'active';
  const controller = {
    targets,
    preview() {},
    async start(
      input: RunInput,
      _lease: unknown,
      _signal: AbortSignal,
      before: () => void,
      created: (run: RunRecord) => void,
    ) {
      beforeRun?.();
      before();
      calls.push(input);
      const db = new DatabaseSync(join(stateDir, 'model-calls.sqlite'));
      assert.equal((db.prepare("SELECT count(*) AS n FROM calls WHERE status='reserved'").get() as { n: number }).n, 1);
      db.close();
      if (options.fail) throw new Error('synthetic private provider error');
      const run = {
        id: `run-${calls.length}`,
        status: options.delay ? 'running' : 'completed',
        output: options.output ?? '{"facts":["synthetic"]}',
        endedAt: options.delay ? undefined : new Date().toISOString(),
      } as RunRecord;
      created(run);
      return run;
    },
    cancel(id: string) {
      cancelled.push(id);
    },
  } as unknown as HindsightBridgeHost['controller'];
  const host: HindsightBridgeHost = {
    stateDir,
    controller,
    getSettings: () => settings,
    projectActive: (id) => id === 'project' && projectState === 'active',
    modelTimeoutMs: options.modelTimeoutMs,
  };
  let bridge = new HindsightModelBridge(host);
  let url = await bridge.start();
  const job = { projectId: 'project', projectPath: stateDir, workflowId: 'workflow', sourceId: 'source' };
  const body = { model: 'pugport-memory', messages: [{ role: 'user', content: 'Extract synthetic facts.' }] };
  return {
    stateDir,
    settings,
    calls,
    cancelled,
    targets,
    job,
    body,
    get bridge() {
      return bridge;
    },
    beforeRun(fn: () => void) {
      beforeRun = fn;
    },
    projectState(value: typeof projectState) {
      projectState = value;
    },
    request(value: unknown = body, token = bridge.token, path = '/chat/completions') {
      return fetch(`${url}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    },
    async restart() {
      await bridge.stop();
      bridge = new HindsightModelBridge(host);
      url = await bridge.start();
    },
    async close() {
      await bridge.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('bridge rejects unauthenticated, unscoped, tool, streaming and oversized requests without starting models', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(f.body, 'wrong')).status, 401);
    assert.equal((await f.request()).status, 403);
    await f.bridge.withJob(f.job, async () => {
      assert.equal((await f.request({ ...f.body, tools: [] })).status, 400);
      assert.equal((await f.request({ ...f.body, stream: true })).status, 400);
      assert.equal((await f.request({ ...f.body, messages: [{ role: 'tool', content: 'no' }] })).status, 400);
      assert.equal((await f.request(f.body, f.bridge.token, '/responses')).status, 404);
      assert.equal((await f.request({ ...f.body, padding: 'a'.repeat(300_000) })).status, 413);
    });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('every model call in one job rechecks its live project owner before reserving or starting a new run', async () => {
  const f = await fixture();
  try {
    await f.bridge.withJob(f.job, async () => {
      assert.equal((await f.request()).status, 200);
      for (const state of ['removed', 'purging', 'missing'] as const) {
        f.projectState(state);
        assert.equal((await f.request()).status, 403);
      }
      assert.equal(f.calls.length, 1);
      const db = new DatabaseSync(join(f.stateDir, 'model-calls.sqlite'));
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get()!.n, 1);
      } finally {
        db.close();
      }
    });
  } finally {
    await f.close();
  }
});

test('bridge reserves durably and uses only the registered project and normal toolless managed route', async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    await f.bridge.withJob({ ...f.job, onModelRun: (id) => ids.push(id) }, async () => {
      const response = await f.request({
        ...f.body,
        projectPath: '/malicious',
        runtimeId: 'other',
        permissionMode: 'workspace-write',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'facts',
            schema: {
              type: 'object',
              required: ['facts'],
              properties: { facts: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, '{"facts":["synthetic"]}');
    });
    assert.deepEqual(ids, ['run-1']);
    const input = f.calls[0];
    assert.equal(input.projectPath, f.stateDir);
    assert.equal(input.runtimeId, 'managed-api');
    assert.equal(input.workflowId, 'workflow');
    assert.equal(input.permissionMode, 'read-only');
    assert.equal(input.untrustedContent, true);
    assert.equal(input.memoryDistillation, true);
    assert.equal(input.agentCalls, false);
    assert.equal(input.allowExecutorFallback, false);
    assert.deepEqual(input.automaticExecutors, ['managed-api']);
    const db = new DatabaseSync(join(f.stateDir, 'model-calls.sqlite'));
    assert.deepEqual(
      { ...db.prepare('SELECT project_id, workflow_id, source_id, run_id, status FROM calls').get() },
      { project_id: 'project', workflow_id: 'workflow', source_id: 'source', run_id: 'run-1', status: 'completed' },
    );
    db.close();
  } finally {
    await f.close();
  }
});

test('failed calls count against the durable daily cap across bridge restart', async () => {
  const f = await fixture({ dailyModelCalls: 1, fail: true });
  try {
    await f.bridge.withJob(f.job, async () => {
      const response = await f.request();
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /private provider/);
    });
    await f.restart();
    await f.bridge.withJob(f.job, async () => assert.equal((await f.request()).status, 429));
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('bridge rechecks settings and rejects expired, unbudgeted or unmanaged routes', async () => {
  const f = await fixture();
  try {
    f.targets[0].apiBudget = undefined;
    await assert.rejects(
      f.bridge.withJob(f.job, async () => {}),
      /per-run budget/,
    );
    f.targets[0].apiBudget = { perRunUsd: 0.1, expiresAt: '2000-01-01' } as NonNullable<
      (typeof f.targets)[0]['apiBudget']
    >;
    await assert.rejects(
      f.bridge.withJob(f.job, async () => {}),
      /expired/,
    );
    f.targets[0].apiBudget.expiresAt = undefined;
    f.targets[0].gateway = undefined;
    await assert.rejects(
      f.bridge.withJob(f.job, async () => {}),
      /per-run budget/,
    );
    f.targets[0].gateway = 'api';
    f.beforeRun(() => {
      f.settings.enabled = false;
    });
    await f.bridge.withJob(f.job, async () => assert.equal((await f.request()).status, 403));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('schema-invalid responses fail closed and still consume the reserved call', async () => {
  const f = await fixture({ output: '{"facts":42}', dailyModelCalls: 1 });
  try {
    await f.bridge.withJob(f.job, async () => {
      assert.equal(
        (
          await f.request({
            ...f.body,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'facts',
                schema: { type: 'object', required: ['facts'], properties: { facts: { type: 'array' } } },
              },
            },
          })
        ).status,
        502,
      );
      assert.equal((await f.request()).status, 429);
    });
  } finally {
    await f.close();
  }
});

test('concurrent model requests are bounded and timeout cancels the ordinary run', async () => {
  // With the default timeout only cancelJob ends the first call, so a slow runner cannot free it before the second.
  const bounded = await fixture({ delay: true });
  try {
    await bounded.bridge.withJob(bounded.job, async () => {
      const first = bounded.request();
      while (!bounded.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await bounded.request()).status, 429);
      bounded.bridge.cancelJob();
      assert.equal((await first).status, 504);
    });
  } finally {
    await bounded.close();
  }
  const f = await fixture({ delay: true, modelTimeoutMs: 100 });
  try {
    await f.bridge.withJob(f.job, async () => assert.equal((await f.request()).status, 504));
    assert.deepEqual(f.cancelled, ['run-1']);
    assert.equal((await f.request()).status, 403);
  } finally {
    await f.close();
  }
});

test('foreground preemption cancels only the active memory model run', async () => {
  const f = await fixture({ delay: true });
  try {
    f.bridge.cancelJob();
    assert.deepEqual(f.cancelled, []);
    await f.bridge.withJob(f.job, async () => {
      const pending = f.request();
      while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
      f.bridge.cancelJob();
      assert.equal((await pending).status, 504);
      assert.deepEqual(f.cancelled, ['run-1']);
      assert.equal((await f.request()).status, 403);
    });
    f.bridge.cancelJob();
    assert.deepEqual(f.cancelled, ['run-1']);
  } finally {
    await f.close();
  }
});
