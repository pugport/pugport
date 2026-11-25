import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cursorModelPool } from '../src/shared/cursor-models.ts';
import { quotaPoolKey, route } from '../src/server/routing.ts';
import { WorkspaceExecutionFields } from '../src/ui/Workspace.tsx';
import type { RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-04T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 120,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/Fixture',
  maxConcurrentRuns: 4,
};
const models = ['auto', 'claude-sonnet-5', 'composer-2.5', 'grok-4.7-high-fast'].map((id) => ({
  id,
  label: id,
  efforts: [],
  quotaPool: cursorModelPool(id),
}));
function snapshot(cursor = 20, other = 40): RuntimeSnapshot {
  return {
    id: 'cursor-native',
    provider: 'cursor',
    label: 'Cursor',
    environment: 'native',
    installed: true,
    status: 'ready',
    models,
    refreshedAt: iso(),
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(),
      windows: [
        {
          id: 'cursor-auto',
          label: 'Cursor Models',
          modelPool: 'cursor',
          usedPercent: cursor,
          resetsAt: iso(3_600_000),
        },
        { id: 'cursor-api', label: 'Other Models', modelPool: 'other', usedPercent: other, resetsAt: iso(3_600_000) },
      ],
    },
  };
}
const choose = (runtime: RuntimeSnapshot, model?: string) =>
  route(
    { prompt: 'Implement a parser', projectPath: 'C:/Fixture', kind: 'general', runtimeId: runtime.id, model },
    [runtime],
    settings,
    new Set(),
    now,
  );

test('Cursor named models use their own pool, so an exhausted sibling pool cannot block them', () => {
  const runtime = snapshot(20, 100);
  assert.equal(choose(runtime, 'composer-2.5').model, 'composer-2.5');
  assert.equal(choose(runtime, 'grok-4.7-high-fast').model, 'grok-4.7-high-fast');
  assert.throws(() => choose(runtime, 'claude-sonnet-5'), /Other Models.*保护阈值/);
  assert.equal(choose(snapshot(100, 20), 'claude-sonnet-5').model, 'claude-sonnet-5');
  const atReserve = snapshot(90, 0);
  atReserve.quota.windows[0]!.resetsAt = iso(7 * 86_400_000);
  assert.throws(() => choose(atReserve, 'composer-2.5'), /Cursor Models.*保护阈值/);
});

test('automatic model choice can use a funded pool, while explicit Auto conservatively checks both', () => {
  assert.equal(choose(snapshot(20, 100)).model, 'composer-2.5');
  assert.equal(choose(snapshot(100, 20)).model, 'claude-sonnet-5');
  assert.throws(() => choose(snapshot(20, 100), 'auto'), /Other Models.*保护阈值/);
  assert.match(choose(snapshot(), 'auto').warnings.join(' '), /实际使用的模型扣费/);
  assert.throws(() => choose(snapshot(100, 100)), /保护阈值/);
});

test('automatic model choice accounts for concurrent reservations before choosing a pool', () => {
  const runtime = snapshot(20, 85);
  runtime.quota.windows[1]!.resetsAt = iso(7 * 86_400_000);
  const input = {
    prompt: 'Implement a parser',
    projectPath: 'C:/Fixture',
    kind: 'general' as const,
    runtimeId: runtime.id,
  };
  const capacity = {
    reservations: new Map([[quotaPoolKey(runtime), 1]]),
    settlingPools: new Set<string>(),
    maxRunsPerPool: 4,
  };
  assert.equal(route(input, [runtime], settings, capacity, now).model, 'composer-2.5');
  assert.throws(() => route({ ...input, model: 'claude-sonnet-5' }, [runtime], settings, capacity, now), /预留/);
});

test('a fresh model pool can still route when a sibling pool has an older observation', () => {
  const runtime = snapshot();
  runtime.quota.windows[1]!.observedAt = iso(-120_000);
  assert.equal(choose(runtime, 'composer-2.5').model, 'composer-2.5');
  assert.equal(choose(runtime).model, 'composer-2.5');
  assert.throws(() => choose(runtime, 'claude-sonnet-5'), /Other Models.*需要更新/);
  assert.throws(() => choose(runtime, 'auto'), /Other Models.*需要更新/);
  runtime.quota.windows[0]!.observedAt = iso(-120_000);
  runtime.quota.windows[1]!.observedAt = iso();
  assert.equal(choose(runtime).model, 'claude-sonnet-5');
  assert.throws(() => choose(runtime, 'composer-2.5'), /Cursor Models.*需要更新/);
});

test('known unlimited Cursor usage is not demoted below known limited providers or sibling accounts', () => {
  const cursor = snapshot();
  cursor.quota = { ...cursor.quota, windows: [], unlimited: true };
  const codex: RuntimeSnapshot = {
    ...snapshot(),
    id: 'codex-native',
    provider: 'codex',
    label: 'Codex',
    models: [{ id: 'gpt-fixture', label: 'GPT', efforts: [] }],
    quota: {
      ...cursor.quota,
      unlimited: undefined,
      windows: [{ id: 'week', label: 'Weekly', usedPercent: 80, resetsAt: iso(3_600_000) }],
    },
  };
  const input = {
    prompt: 'Implement a parser',
    projectPath: 'C:/Fixture',
    kind: 'routine' as const,
    schedule: { preferExpiringQuota: false },
  };
  const configured = { ...settings, routineProvider: 'cursor' as const, routePreferencesEnabled: true };
  assert.equal(route(input, [codex, cursor], configured, new Set(), now).runtimeId, cursor.id);
  const sibling = { ...snapshot(), id: 'cursor-second' };
  assert.equal(route(input, [sibling, cursor], configured, new Set(), now).runtimeId, cursor.id);
});

test('model scoping preserves unknown, missing, stale and shared limit protection', () => {
  const runtime = snapshot();
  runtime.quota.windows[1]!.usedPercent = null;
  assert.equal(choose(runtime, 'composer-2.5').model, 'composer-2.5');
  assert.throws(() => choose(runtime, 'claude-sonnet-5'), /Other Models.*未知/);
  runtime.quota.windows = [runtime.quota.windows[0]!];
  assert.throws(() => choose(runtime, 'claude-sonnet-5'), /额度窗口缺失/);
  runtime.quota.windows.push({ id: 'shared', label: 'Shared', usedPercent: 100, resetsAt: iso(3_600_000) });
  assert.throws(() => choose(runtime, 'composer-2.5'), /Shared.*保护阈值/);
  runtime.quota = { ...snapshot().quota, observedAt: iso(-120_000) };
  assert.throws(() => choose(runtime, 'composer-2.5'), /额度数据已过期/);
});

test('only explicit, fresh unlimited usage is accepted with no quota windows', () => {
  const runtime = snapshot();
  runtime.quota.windows = [];
  assert.throws(() => choose(runtime, 'composer-2.5'), /额度窗口缺失/);
  runtime.quota.unlimited = true;
  const decision = choose(runtime, 'composer-2.5');
  assert.equal(decision.model, 'composer-2.5');
  assert.match(decision.reasons.join(' '), /不限量/);
  assert.doesNotMatch(decision.reasons.join(' '), /undefined|Infinity/);
  runtime.quota.observedAt = iso(-120_000);
  assert.throws(() => choose(runtime, 'composer-2.5'), /额度数据已过期/);
});

test('the Cursor picker labels billing pools without changing exact CLI model slugs', () => {
  const runtime = snapshot();
  const markup = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state: { targets: [{ ...runtime, enabled: true, command: 'fixture' }], runtimes: [runtime] },
      policy: 'cli-only',
      selection: runtime.id,
      model: 'composer-2.5',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.match(markup, /value="composer-2.5" selected="">composer-2.5 · Cursor Models/);
  assert.match(markup, /value="claude-sonnet-5">claude-sonnet-5 · Other Models/);
  assert.match(markup, /value="auto">auto · 按实际模型扣费/);
  assert.equal(cursorModelPool('cursor-grok-4.6-high'), 'cursor');
  assert.equal(cursorModelPool('gpt-5.6-luna-low'), 'other');
  assert.equal(cursorModelPool('gemini-4-argon'), 'other');
  assert.equal(cursorModelPool('grok-4.70-high'), 'dynamic');
  assert.equal(cursorModelPool('future-model'), 'dynamic');
});

test('canonical Cursor selection preserves explicit effort and old variant pins keep their parameters', () => {
  const runtime = snapshot();
  runtime.models = [
    { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['low', 'medium', 'high'], quotaPool: 'cursor' },
    { id: 'claude-opus-5', label: 'Opus 5', efforts: ['low', 'medium', 'high', 'max'], quotaPool: 'other' },
  ];
  const decide = (model: string, effort?: string) =>
    route(
      {
        prompt: 'Implement a parser',
        projectPath: 'C:/Fixture',
        kind: 'general',
        runtimeId: runtime.id,
        model,
        effort,
      },
      [runtime],
      settings,
      new Set(),
      now,
    );
  const canonical = decide('grok-4.7', 'high');
  assert.deepEqual([canonical.model, canonical.effort], ['grok-4.7', 'high']);
  const fast = decide('grok-4.7-high-fast');
  assert.deepEqual([fast.model, fast.effort], ['grok-4.7-high-fast', 'high']);
  const thinking = decide('claude-opus-5-thinking-max');
  assert.deepEqual([thinking.model, thinking.effort], ['claude-opus-5-thinking-max', 'max']);
  assert.throws(() => decide('grok-4.7-high-fast', 'low'), /不支持 low/);
  assert.throws(() => decide('grok-4.7-max-fast'), /未发现指定模型/);
  assert.throws(() => decide('grok-4.7', 'max'), /不支持 max/);
});
