import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyFileOutcome,
  confirmFileOutcome,
  requestsFileChanges,
  mergeFileOutcome,
} from '../src/server/task-file-outcome.ts';
import { cursorToolEventData } from '../src/server/adapters/cursor.ts';
import { toolEventDetails } from '../src/shared/tool-event-data.ts';
import type { RunRecord } from '../src/shared/types.ts';

const run = (projectPath: string): RunRecord => ({
  id: 'fixture',
  projectPath,
  prompt: 'Move files',
  kind: 'routine',
  status: 'completed',
  startedAt: '',
  route: { runtimeId: 'mock', model: 'mock', kind: 'routine', reasons: [], warnings: [] },
  output: 'All files moved.',
  events: [],
});

test('receipt confirmation never grants prose or step-position exemptions', async () => {
  for (const output of [
    'Inspected test style.',
    'No files were modified.',
    '已修改 a.ts',
    '检查完成，下一步需要修改 source.ts。',
  ]) {
    const record: RunRecord = {
      ...run(tmpdir()),
      output,
      measuredFileChanges: { source: 'pugport-scope-snapshot', paths: [] },
      taskOutcome: { status: 'completed', source: 'executor-report' },
    };
    assert.equal((await confirmFileOutcome(record)).status, 'unverified');
    record.measuredFileChanges!.paths = ['a.ts'];
    assert.equal((await confirmFileOutcome(record)).status, 'completed');
  }
});

test('outside-project write receipts neither confirm nor contradict project changes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'outside-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectPath = join(directory, 'project');
  const outside = join(directory, 'adapter-temp-report.md');
  for (const exists of [false, true]) {
    if (exists) writeFileSync(outside, 'Synthetic report');
    for (const status of ['completed', 'failed', 'inProgress']) {
      for (const data of [
        { tool: 'Write', input: { file_path: outside } },
        { tool: 'Edit', input: { file_path: '../adapter-temp-report.md' } },
        { kind: 'fileChange', input: { changes: [{ path: outside, kind: { type: 'add' } }] } },
      ]) {
        const record: RunRecord = {
          ...run(projectPath),
          events: [{ at: '', type: 'tool', data: { itemId: 'write', status, ...data } }],
        };
        assert.equal((await confirmFileOutcome(record)).status, 'unverified');
        record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['source.ts'] };
        assert.equal((await confirmFileOutcome(record)).status, 'completed');
      }
    }
  }
  const mixed: RunRecord = {
    ...run(projectPath),
    measuredFileChanges: { source: 'pugport-scope-snapshot', paths: ['source.ts'] },
    events: [
      {
        at: '',
        type: 'tool',
        data: {
          itemId: 'mixed',
          kind: 'fileChange',
          status: 'completed',
          input: {
            changes: [
              { path: outside, kind: { type: 'add' } },
              { path: 'missing.ts', kind: { type: 'add' } },
            ],
          },
        },
      },
    ],
  };
  assert.equal((await confirmFileOutcome(mixed)).status, 'unverified');
});

test('non-final shell and unlisted tool writes cannot claim no change without a host snapshot', async () => {
  for (const tool of ['Bash', 'NotebookEdit', 'create_file', 'str_replace']) {
    const record: RunRecord = {
      ...run(tmpdir()),
      workflowId: 'workflow',
      stepId: 'inspect',
      output: '改了，改成新的结构。Refactored.',
      taskOutcome: { status: 'completed', source: 'executor-report' },
      events: [{ at: '', type: 'tool', data: { kind: 'nativeToolCall', tool, status: 'completed', exitCode: 0 } }],
    };
    assert.equal((await confirmFileOutcome(record)).status, 'unverified', tool);
  }
});

test('non-final steps retain strict receipt checks for every write attempt', async () => {
  for (const data of [
    { kind: 'fileChange', status: 'failed' },
    { tool: 'Write', status: 'inProgress' },
    { tool: 'Write', status: 'completed' },
    { kind: 'fileChange', status: 'completed', input: { changes: [] } },
    { hostAudit: true, kind: 'pugportToolCall', tool: 'organize_files' },
  ]) {
    const record: RunRecord = {
      ...run(tmpdir()),
      workflowId: 'workflow',
      stepId: 'inspect',
      output: '检查完成',
      taskOutcome: { status: 'completed', source: 'executor-report' },
      measuredFileChanges: { source: 'pugport-scope-snapshot', paths: [] },
      events: [{ at: '', type: 'tool', data: { itemId: 'write', ...data } }],
    };
    assert.equal((await confirmFileOutcome(record)).status, 'unverified', JSON.stringify(data));
  }
});

test('environment evidence never erases unrelated executor partial results', () => {
  const record = run(tmpdir());
  const outcome = {
    status: 'completed' as const,
    source: 'file-receipts' as const,
    verificationLimited: true,
    limitedChecks: [{ id: 'test', command: 'test', reason: 'listen EPERM' }],
  };
  for (const summary of [
    'B not done because the install failed',
    'Tests could not run in the sandbox',
    'listen EPERM',
  ]) {
    record.taskOutcome = { status: 'partial', source: 'executor-report', summary };
    const merged = mergeFileOutcome(record, outcome);
    assert.equal(merged.status, 'partial');
    assert.deepEqual(merged.limitedChecks, outcome.limitedChecks);
    assert.equal(merged.verificationLimited, undefined);
  }
});

test('measured changes and only environment-blocked commands complete with limited checks', async () => {
  const record = run(tmpdir());
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['synthetic.ts'] };
  record.events = [
    'listen EACCES: permission denied',
    'EPERM: junction',
    'spawn EPERM',
    'network access denied',
    'operation not permitted',
    'sandbox refused the command',
  ].map((output, index) => ({
    at: '',
    type: 'tool',
    data: {
      kind: 'commandExecution',
      itemId: `exec-${index}`,
      status: 'failed',
      exitCode: 1,
      input: { command: `check-${index}` },
      output,
    },
  }));
  const outcome = await confirmFileOutcome(record);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.verificationLimited, true);
  assert.equal(outcome.limitedChecks?.length, 6);
  assert.equal(outcome.limitedChecks?.[1]?.command, 'check-1');
  for (const patch of [
    { measuredFileChanges: undefined },
    { measuredFileChanges: { source: 'pugport-scope-snapshot' as const, paths: ['../outside-project.txt'] } },
    { errorCode: 'quota-or-rate-limit' },
    { status: 'cancelled' as const },
  ]) {
    const strict = await confirmFileOutcome({ ...record, ...patch });
    assert.notEqual(strict.status, 'completed');
    assert.equal(strict.verificationLimited, undefined);
  }
  for (const data of [
    { kind: 'fileChange', status: 'failed', output: 'EPERM: junction' },
    { tool: 'Write', status: 'inProgress', output: 'EPERM: junction' },
  ]) {
    const strict = await confirmFileOutcome({
      ...record,
      events: [...record.events, { at: '', type: 'tool', data: { itemId: 'unsafe', ...data } }],
    });
    assert.notEqual(strict.status, 'completed', JSON.stringify(data));
    assert.equal(strict.verificationLimited, undefined);
  }
});

test('measured project changes survive unrelated failed commands while limited checks remain disclosed', async () => {
  const record: RunRecord = {
    ...run(tmpdir()),
    measuredFileChanges: { source: 'pugport-scope-snapshot', paths: ['source.ts'] },
    events: [
      {
        at: '',
        type: 'tool',
        data: {
          itemId: 'limited',
          kind: 'commandExecution',
          status: 'failed',
          exitCode: 1,
          input: { command: 'test' },
          output: 'listen EACCES',
        },
      },
      {
        at: '',
        type: 'tool',
        data: {
          itemId: 'unrelated',
          kind: 'commandExecution',
          status: 'failed',
          exitCode: 1,
          input: { command: 'rg missing optional-file' },
          output: 'file not found',
        },
      },
    ],
  };
  const outcome = await confirmFileOutcome(record);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.verificationLimited, true);
  assert.deepEqual(
    outcome.limitedChecks?.map((check) => check.id),
    ['limited'],
  );
  assert.equal((await confirmFileOutcome({ ...record, measuredFileChanges: undefined })).status, 'unverified');
  for (const command of [
    'npm test',
    'npm run "test"',
    'npm.cmd run "test:unit"',
    'npm --silent test',
    'npm run --silent typecheck',
    'npx --no-install eslint src',
    'npm --prefix "project folder" run lint',
    'pnpm --filter=app test',
    'go test ./...',
    'cargo test',
    'dotnet build',
    'make test',
    'cd project && npm run build',
    'npm run build',
    'npm run typecheck',
    'npm run lint',
    'npx tsc --noEmit',
    'node --test tests/example.test.ts',
    'pytest',
  ]) {
    const failure = {
      at: '',
      type: 'tool' as const,
      data: {
        itemId: 'real-check',
        kind: 'commandExecution',
        status: 'failed',
        exitCode: 1,
        input: { command },
        output: 'AssertionError: expected true',
      },
    };
    for (const events of [[failure], [...record.events, failure]]) {
      assert.equal((await confirmFileOutcome({ ...record, events })).status, 'unverified', command);
      const retry = {
        ...failure,
        data: { ...failure.data, itemId: 'retry', status: 'completed', exitCode: 0, output: 'passed' },
      };
      assert.equal((await confirmFileOutcome({ ...record, events: [...events, retry] })).status, 'completed', command);
    }
  }
  for (const command of [
    'rg test missing-file',
    'rg lint missing-file',
    'rg build missing-file',
    'npm --prefix test install',
    'echo "some text; npm test"',
  ]) {
    const events = record.events.map((event) =>
      event.data?.itemId === 'unrelated' ? { ...event, data: { ...event.data, input: { command } } } : event,
    );
    assert.equal((await confirmFileOutcome({ ...record, events })).status, 'completed', command);
  }
  assert.equal(
    (
      await confirmFileOutcome({
        ...record,
        verification: { status: 'failed', command: 'test', exitCode: 1, output: 'AssertionError' },
      })
    ).status,
    'unverified',
  );
  assert.equal(
    (
      await confirmFileOutcome({
        ...record,
        events: [
          ...record.events,
          {
            at: '',
            type: 'tool',
            data: { itemId: 'write', tool: 'Write', status: 'failed', input: { file_path: 'missing.ts' } },
          },
        ],
      })
    ).status,
    'unverified',
  );
});

test('native shell names and host verification use actual error output', async () => {
  for (const data of [
    { kind: 'nativeToolCall', tool: 'Bash' },
    { kind: 'execute', nativeTool: 'run_command' },
    { kind: 'nativeToolCall', tool: 'exec_command' },
  ]) {
    const record = run(tmpdir());
    record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['synthetic.ts'] };
    record.events = [
      {
        at: '',
        type: 'tool',
        data: {
          ...data,
          toolCallId: 'check',
          status: 'completed',
          isError: true,
          output: 'listen EACCES',
          input: { command: 'test' },
        },
      },
    ];
    assert.equal((await confirmFileOutcome(record)).verificationLimited, true);
    record.events = [];
    record.verification = { status: 'failed', command: 'check', exitCode: 1, output: 'spawn EPERM' };
    assert.equal((await confirmFileOutcome(record)).verificationLimited, undefined);
  }
});

test('only requested file changes need receipts; analysis and prose remain ordinary completions', () => {
  for (const text of [
    '移动文件到分类目录',
    '整理文件并去重',
    'Save the report to result.txt',
    'Write result.txt',
    '那你倒是移动啊',
    '将文件移到分类目录',
    '按类型给这些文件分类',
    'Deduplicate the files.',
  ])
    assert.equal(requestsFileChanges(text), true, text);
  for (const text of [
    '检查重复文件并给出建议',
    '分析移动文件的影响',
    'Write a plan for moving files',
    '不要改文件，给我方案',
    'Explain how to edit files',
    'Write a short story',
    '检查文件分类是否正确',
    '如何整理文件',
    'Only inspect the architecture and report findings.',
    'Inspect the task',
  ])
    assert.equal(requestsFileChanges(text), false, text);
});

test('model claims and a successful shell alone cannot confirm file changes', async () => {
  const record = run(tmpdir());
  record.events.push({
    at: '',
    type: 'tool',
    data: { kind: 'commandExecution', itemId: 'shell', status: 'completed', exitCode: 0 },
  });
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('host verification confirms an already correct file result without changes or receipts', async () => {
  const record = run(tmpdir());
  record.output = 'The files are already correct; verification passed.';
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: [] };
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  record.verification = { command: 'test', status: 'passed', exitCode: 0, output: 'Verified by PugPort.' };
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  record.verification.status = 'failed';
  record.verification.exitCode = 1;
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  record.verification.status = 'cancelled';
  record.verification.exitCode = null;
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('organize receipts retain partial successes and require the actual target state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'moved.txt');
  writeFileSync(target, 'synthetic');
  const record = run(directory);
  record.verification = { command: 'test', status: 'passed', exitCode: 0, output: 'Verified by PugPort.' };
  const receipt = {
    status: 'partial',
    operationIds: ['operation-1'],
    requested: 2,
    succeeded: 1,
    failed: 1,
    skipped: 0,
    moves: [{ from: join(directory, 'source.txt'), to: target }],
    recycled: [],
  };
  record.events.push({
    at: '',
    type: 'tool',
    data: {
      hostAudit: true,
      source: 'pugport',
      kind: 'pugportToolCall',
      tool: 'organize_files',
      toolCallId: 'batch-1',
      status: 'partial',
      result: { structuredContent: receipt },
    },
  });
  const partial = await confirmFileOutcome(record);
  assert.equal(partial.status, 'partial');
  assert.match(partial.summary!, /成功 1 项，失败 1 项/);
  receipt.status = 'completed';
  receipt.failed = 0;
  receipt.requested = 1;
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  rmSync(target);
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('zero-success receipts override completion prose and do not disappear', async () => {
  const record = run(tmpdir());
  record.verification = { command: 'test', status: 'passed', exitCode: 0, output: 'Verified by PugPort.' };
  record.events.push({
    at: '',
    type: 'tool',
    data: {
      hostAudit: true,
      kind: 'pugportToolCall',
      tool: 'organize_files',
      toolCallId: 'batch-zero',
      status: 'failed',
      result: {
        structuredContent: {
          status: 'failed',
          operationIds: ['zero'],
          requested: 2,
          succeeded: 0,
          failed: 2,
          skipped: 0,
          moves: [],
          recycled: [],
        },
      },
    },
  });
  assert.equal((await confirmFileOutcome(record)).status, 'blocked');
});

test('native file receipts combine started arguments with terminal status and check current files', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  for (const tool of ['codex', 'claude']) {
    const record = run(directory);
    record.events = [
      {
        at: '',
        type: 'tool',
        data:
          tool === 'codex'
            ? {
                kind: 'fileChange',
                itemId: 'write',
                status: 'inProgress',
                input: { changes: [{ path: 'result.txt', kind: { type: 'add' } }] },
              }
            : {
                kind: 'nativeToolCall',
                tool: 'Write',
                toolCallId: 'write',
                status: 'inProgress',
                input: { file_path: 'result.txt' },
              },
      },
      {
        at: '',
        type: 'tool',
        data:
          tool === 'codex' ? { itemId: 'write', status: 'completed' } : { toolCallId: 'write', status: 'completed' },
      },
    ];
    assert.equal((await confirmFileOutcome(record)).status, 'completed', tool);
  }
});

test('successful receipts cannot hide another unsettled write or a capture gap', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const record = run(directory);
  record.verification = { command: 'test', status: 'passed', exitCode: 0, output: 'Verified by PugPort.' };
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        kind: 'fileChange',
        itemId: 'success',
        status: 'completed',
        input: { changes: [{ path: 'result.txt', kind: { type: 'add' } }] },
      },
    },
    {
      at: '',
      type: 'tool',
      data: {
        kind: 'fileChange',
        itemId: 'uncertain',
        status: 'inProgress',
        input: { changes: [{ path: 'other.txt', kind: { type: 'add' } }] },
      },
    },
  ];
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  record.events.pop();
  record.auditEventsMissing = 1;
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('Cursor, Grok and Pi completed edit paths are accepted; missing completion and read tools are not', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const cursor = cursorToolEventData({
    toolCallId: 'cursor-edit',
    kind: 'edit',
    toolName: 'edit_file',
    status: 'completed',
    rawInput: { path: 'result.txt' },
  });
  const grok = {
    toolCallId: 'grok-write',
    kind: 'edit',
    tool: 'Write',
    nativeTool: 'Write',
    status: 'completed',
    ...toolEventDetails({ rawInput: { file_path: 'result.txt' } }),
  };
  const pi = {
    toolCallId: 'pi-write',
    kind: 'nativeToolCall',
    tool: 'write',
    status: 'completed',
    ...toolEventDetails({ args: { path: 'result.txt' } }),
  };
  for (const data of [cursor, grok, pi]) {
    const record = run(directory);
    record.events = [{ at: '', type: 'tool', data }];
    assert.equal((await confirmFileOutcome(record)).status, 'completed');
    record.events[0]!.data = { ...data, status: 'inProgress' };
    assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  }
  const record = run(directory);
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        toolCallId: 'read',
        tool: 'read',
        kind: 'nativeToolCall',
        status: 'completed',
        input: { path: 'result.txt' },
      },
    },
  ];
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('host measurements combine with receipts without double counting and cannot hide contradictory receipts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const record = run(directory);
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['result.txt'] };
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        kind: 'nativeToolCall',
        tool: 'write',
        toolCallId: 'write',
        status: 'completed',
        input: { path: 'result.txt' },
      },
    },
  ];
  assert.match((await confirmFileOutcome(record)).summary!, /已确认 1 项/);
  record.events[0]!.data!.input = { path: 'missing.txt' };
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        hostAudit: true,
        kind: 'pugportToolCall',
        tool: 'organize_files',
        toolCallId: 'contradiction',
        status: 'completed',
        result: {
          structuredContent: {
            status: 'completed',
            operationIds: ['op'],
            succeeded: 1,
            failed: 0,
            moves: [{ from: 'source.txt', to: 'missing.txt' }],
            recycled: [],
          },
        },
      },
    },
  ];
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('ordinary failed commands, failed reads and anonymous tools do not invalidate file receipts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const record = run(directory);
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        itemId: 'write',
        kind: 'fileChange',
        status: 'completed',
        input: { changes: [{ path: 'result.txt', kind: { type: 'add' } }] },
      },
    },
    ...[
      { itemId: 'search', kind: 'commandExecution', command: 'rg absent', status: 'completed', exitCode: 1 },
      {
        itemId: 'test-fail',
        kind: 'commandExecution',
        command: 'npm test',
        status: 'completed',
        exitCode: 1,
        output: 'AssertionError',
      },
      { itemId: 'test-pass', kind: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 },
      { itemId: 'read', tool: 'Read', status: 'failed' },
      { kind: 'fileChange', status: 'failed' },
    ].map((data) => ({ at: '', type: 'tool' as const, data })),
  ];
  const outcome = await confirmFileOutcome(record);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.verificationLimited, undefined);
});

test('limited checks exclude only identical commands that succeeded later, including interleaved completions', async () => {
  const record = run(tmpdir());
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['synthetic.ts'] };
  const event = (itemId: string, command: string, status: string, exitCode?: number, output?: string) => ({
    at: '',
    type: 'tool' as const,
    data: { itemId, kind: 'commandExecution', input: { command }, status, exitCode, output },
  });
  record.events = [
    event('rerun', '  npm test\r\n', 'inProgress'),
    event('denied', 'npm test', 'failed', 1, 'listen EACCES'),
    event('rerun', '  npm test\r\n', 'completed', 0),
  ];
  assert.equal((await confirmFileOutcome(record)).verificationLimited, undefined);
  record.events.push(event('later-denied', 'npm test', 'failed', 1, 'listen EACCES'));
  assert.deepEqual(
    (await confirmFileOutcome(record)).limitedChecks?.map((check) => check.id),
    ['later-denied'],
  );
  record.events.push(event('different', 'npm test --other', 'completed', 0));
  assert.equal((await confirmFileOutcome(record)).limitedChecks?.length, 1);
  record.verification = { command: 'npm test', status: 'passed', exitCode: 0, output: 'ok' };
  assert.equal((await confirmFileOutcome(record)).verificationLimited, undefined);
  record.verification = undefined;
  record.events = [event('running', 'npm test', 'inProgress', undefined, 'listen EACCES')];
  assert.equal((await confirmFileOutcome(record)).verificationLimited, undefined);
});

test('host measurement confirms only matching failed or inconsistent receipts', async () => {
  for (const [measured, data, expected] of [
    ['b.ts', { kind: 'fileChange', status: 'failed', input: { changes: [{ path: 'b.ts' }] } }, 'completed'],
    ['a.ts', { kind: 'fileChange', status: 'failed', input: { changes: [{ path: 'b.ts' }] } }, 'unverified'],
    ['a.ts', { kind: 'edit', status: 'completed', input: { path: 'b.ts' } }, 'unverified'],
    ['b.ts', { kind: 'edit', status: 'completed', input: { path: 'b.ts' } }, 'completed'],
    ['b.ts', { kind: 'fileChange', status: 'failed' }, 'unverified'],
  ] as const) {
    const record = run(join(tmpdir(), 'synthetic-nonexistent-project'));
    record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: [measured] };
    record.events = [{ at: '', type: 'tool', data: { itemId: 'one', ...data } }];
    assert.equal((await confirmFileOutcome(record)).status, expected, JSON.stringify(data));
  }
});

test('capture gaps require in-project measurement and commit summaries identify the commit', async () => {
  const record = run(join(tmpdir(), 'synthetic-outcome-project'));
  record.auditEventsMissing = 1;
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['../outside.ts'] };
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths: ['inside.ts'] };
  assert.doesNotMatch((await confirmFileOutcome(record)).summary ?? '', /含提交/);
  record.measuredFileChanges.commits = { after: '1234567890123456789012345678901234567890' };
  assert.match((await confirmFileOutcome(record)).summary ?? '', /含提交 1234567/);
});

test('a later verified write retires an earlier failure, and a mismatched receipt stays unverified', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const change = (itemId: string, path: string, status: string, output?: string) => ({
    at: '',
    type: 'tool' as const,
    data: {
      kind: 'fileChange',
      itemId,
      status,
      ...(output ? { output } : {}),
      input: { changes: [{ path, kind: { type: 'add' } }] },
    },
  });
  const recovered = run(directory);
  recovered.events = [
    change('fail', 'result.txt', 'failed', 'EPERM: denied token=secret'),
    change('ok', 'result.txt', 'completed'),
  ];
  assert.equal((await confirmFileOutcome(recovered)).status, 'completed');
  const stuck = run(directory);
  stuck.events = [change('fail', 'result.txt', 'failed', 'EPERM: denied token=secret')];
  const unsettled = await confirmFileOutcome(stuck);
  assert.equal(unsettled.status, 'unverified');
  assert.match(unsettled.summary ?? '', /EPERM/);
  assert.doesNotMatch(unsettled.summary ?? '', /token=secret/);
  const mismatched = run(directory);
  mismatched.events = [change('missing', 'missing.txt', 'completed')];
  const unknown = await confirmFileOutcome(mismatched);
  assert.equal(unknown.status, 'unverified');
  assert.match(unknown.summary ?? '', /不一致/);
});

test('host evidence confirms the task while outside-project claims remain unverified', async () => {
  const record: RunRecord = {
    ...run(tmpdir()),
    taskOutcome: {
      status: 'completed',
      source: 'executor-report',
      claims: [{ claim: 'Done', files: ['a.ts', 'b.ts'] }],
    },
    measuredFileChanges: { source: 'pugport-scope-snapshot', paths: ['a.ts'] },
  };
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  record.measuredFileChanges!.paths.push('b.ts');
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  record.taskOutcome!.claims![0]!.files!.push('../outside.ts');
  record.measuredFileChanges!.paths.push('../outside.ts');
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});

test('tool-reported file claims still require real matching receipts', async () => {
  const record = run(tmpdir());
  record.taskOutcome = {
    status: 'completed',
    source: 'executor-tool',
    summary: 'Done',
    claims: [{ claim: 'Changed file', files: ['synthetic-missing-file.ts'] }],
  };
  await applyFileOutcome(record, {});
  assert.equal(record.taskOutcome.status, 'unverified');
  assert.equal(record.taskOutcome.source, 'file-receipts');
});

// A failed check is evidence for the executor to explain (a pre-existing failure, a baseline comparison):
// its structured completion report stands and the failed commands stay visible; without a report it blocks.
test('a failed check keeps a reported completion visible, and blocks only without a structured report', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-file-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'result.txt'), 'synthetic');
  const failing = (record: RunRecord) => {
    record.events = [
      {
        at: '',
        type: 'tool',
        data: {
          itemId: 'write',
          kind: 'fileChange',
          status: 'completed',
          input: { changes: [{ path: 'result.txt', kind: { type: 'add' } }] },
        },
      },
      {
        at: '',
        type: 'tool',
        data: { itemId: 'test', kind: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 1 },
      },
    ];
    return record;
  };
  const reported = failing(run(directory));
  reported.taskOutcome = { status: 'completed', source: 'executor-tool', summary: 'Known baseline failure' };
  assert.equal((await confirmFileOutcome(reported)).status, 'completed');
  assert.deepEqual(reported.failedChecks, ['npm test']);
  const silent = failing(run(directory));
  assert.equal((await confirmFileOutcome(silent)).status, 'unverified');
  const partial = failing(run(directory));
  partial.taskOutcome = { status: 'partial', source: 'executor-report' };
  assert.equal((await confirmFileOutcome(partial)).status, 'unverified');
});

test('commit evidence remains visible with limited or passed verification', async () => {
  const record = run(tmpdir());
  const after = '1234567890abcdef1234567890abcdef12345678';
  record.measuredFileChanges = {
    source: 'pugport-scope-snapshot',
    paths: [],
    commits: { before: 'abcdef1234567890abcdef1234567890abcdef12', after },
  };
  record.events = [
    {
      at: '',
      type: 'tool',
      data: {
        kind: 'commandExecution',
        itemId: 'limited',
        status: 'failed',
        exitCode: 1,
        input: { command: 'npm test' },
        output: 'spawn EPERM',
      },
    },
  ];
  const limited = await confirmFileOutcome(record);
  assert.equal(limited.status, 'completed');
  assert.equal(limited.verificationLimited, true);
  assert.ok(limited.summary?.includes(after.slice(0, 7)));
  record.events = [];
  record.verification = { status: 'passed', exitCode: 0, command: 'npm test', output: 'ok' };
  const passed = await confirmFileOutcome(record);
  assert.equal(passed.status, 'completed');
  assert.ok(passed.summary?.includes(after.slice(0, 7)));
});

test('workflow Git evidence accepts unchanged paths in a completion report', async () => {
  for (const commits of [undefined, { before: 'a'.repeat(40), after: 'b'.repeat(40) }]) {
    const record = run(tmpdir());
    record.taskOutcome = {
      status: 'completed',
      source: 'executor-tool',
      claims: [{ claim: 'Updated and verified outputs', files: ['unchanged.png'] }],
    };
    record.measuredFileChanges = {
      source: 'pugport-scope-snapshot',
      paths: commits ? [] : ['changed.txt'],
      ...(commits ? { commits } : {}),
    };
    assert.equal((await confirmFileOutcome(record)).status, 'completed');
  }
});

test('claimed ignored output changed during run counts; stale, outside and dependency files do not', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ignored-outcome-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'reports'));
  mkdirSync(join(directory, 'node_modules'));
  writeFileSync(join(directory, '.gitignore'), 'reports/\n');
  writeFileSync(join(directory, 'reports/result.txt'), 'synthetic');
  // Windows file times and Date.now() come from different clocks, so a file written just now can look a few ms in
  // the future. Date the write inside the run instead of comparing it with the current millisecond.
  const during = new Date(Date.now() - 1000);
  utimesSync(join(directory, 'reports/result.txt'), during, during);
  writeFileSync(join(directory, 'node_modules/result.txt'), 'synthetic');
  const record = { ...run(directory), startedAt: new Date(Date.now() - 2000).toISOString() };
  assert.equal((await confirmFileOutcome(record, ['reports/result.txt'])).status, 'completed');
  assert.equal((await confirmFileOutcome(record, ['node_modules/result.txt'])).status, 'unverified');
  assert.equal((await confirmFileOutcome(record, ['../result.txt'])).status, 'unverified');
  assert.equal(
    (await confirmFileOutcome({ ...record, endedAt: record.startedAt }, ['reports/result.txt'])).status,
    'unverified',
  );
  utimesSync(join(directory, 'reports/result.txt'), new Date(0), new Date(0));
  assert.equal((await confirmFileOutcome(record, ['reports/result.txt'])).status, 'unverified');
});
test('native check baseline exempts old failures but new failures still block confirmation', async () => {
  const command = 'npm run format:check';
  const record = {
    ...run(tmpdir()),
    checkBaselines: [{ command, files: ['old.ts'] }],
    measuredFileChanges: { source: 'pugport-scope-snapshot' as const, paths: ['result.txt'] },
    events: [
      {
        at: '',
        type: 'tool' as const,
        data: {
          itemId: 'check',
          kind: 'commandExecution',
          status: 'completed',
          exitCode: 1,
          input: { command },
          output:
            'Checking formatting...\n[warn] old.ts\n[warn] Code style issues found in 1 file. Run Prettier with --write to fix.',
        },
      },
    ],
  };
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  record.events[0]!.data.output = record.events[0]!.data.output.replace('old.ts', 'new.ts');
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
});
