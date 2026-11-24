import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Workflow } from '../src/shared/types.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

const task = (id: string, conversationId: string) => ({ id, conversationId }) as Workflow;

for (const notifySound of [undefined, true, false]) {
  test(`finish notification silent follows notifySound=${notifySound}`, async () => {
    const notices: NotificationOptions[] = [];
    const code = await uiBundle('src/ui/DesktopFeatures.tsx');
    const h = uiHarness(
      `${code}\nmodule.exports.fixture = (props) => useFinishNotifications(props.workflows, [], props.mode, props.settings, () => false, () => {});`,
      {
        Notification: class {
          constructor(_title: string, options: NotificationOptions) {
            notices.push(options);
          }
        },
      },
    );
    const props = {
      workflows: [{ ...task('one', 'chat'), status: 'running' }],
      mode: 'always',
      settings: { notifySound },
    };
    h.render('fixture', props);
    assert.equal(notices.length, 0);
    props.workflows = [{ ...task('one', 'chat'), status: 'completed' }];
    h.render('fixture', props);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.silent, notifySound === false);
    h.unmount();
  });
}

test('Run history counts only its selected task as seen, so other tasks in that chat still notify', async () => {
  const { taskShown } = uiHarness(await uiBundle('src/ui/DesktopFeatures.tsx')).exports as {
    taskShown: (selected: string | undefined, conversations: readonly string[]) => (workflow: Workflow) => boolean;
  };
  const selected = task('selected', 'chat');
  const sibling = task('sibling', 'chat');
  const elsewhere = task('elsewhere', 'other');
  // The selected task's own sub-tasks (delegations, swarm members) are part of its record in Run history.
  const child = { ...task('child', 'chat'), delegation: { parentId: 'selected' } } as Workflow;
  // Run history: a sibling task waiting for confirmation in the same conversation is not on screen.
  const runs = taskShown('selected', []);
  assert.deepEqual([runs(selected), runs(child), runs(sibling), runs(elsewhere)], [true, true, false, false]);
  // A chat pane shows every task of its conversation.
  const chat = taskShown(undefined, ['chat']);
  assert.deepEqual([chat(selected), chat(sibling), chat(elsewhere)], [true, true, false]);
});

test('the finish notification title keeps a named conversation and falls back to a singular Chat when untitled', async () => {
  const harness = uiHarness(await uiBundle('src/ui/DesktopFeatures.tsx'));
  const { finishNotificationTitle } = harness.exports as {
    finishNotificationTitle: (conversationTitle?: string) => string;
  };
  // The untitled fallback is the singular Chat, not the plural Chats navigation heading.
  assert.equal(finishNotificationTitle(undefined), '聊天');
  // A conversation with a real title keeps its own title.
  assert.equal(finishNotificationTitle('修复登录页'), '修复登录页');
  assert.equal(english['聊天'], 'Chat');
  assert.equal(english['对话'], 'Chats');
});
