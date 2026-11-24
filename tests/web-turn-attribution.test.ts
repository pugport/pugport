import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageFixture } from './helpers/page-dom.ts';

/*
 * Synthetic chat pages for reply attribution. None is recorded from a live site: each models a page structure that
 * capture must survive (changed wrappers, repeated prompts, an author that cannot be placed, a sidebar copy).
 */
type Layout = {
  name: string;
  /** One turn; `wrapper` replaces the element around it, as a site redesign or re-render does. */
  user: (text: string, wrapper?: string) => string;
  assistant: (html: string, wrapper?: string) => string;
};
const wrap = (wrapper: string, inner: string) => `<${wrapper}>${inner}</${wrapper.split(' ')[0]}>`;
const layouts: Layout[] = [
  {
    name: 'data-message-author-role',
    // The author label is too long to sit beside the prompt in one element, so the prompt is found inside the turn.
    user: (text, wrapper = 'div class="row"') =>
      wrap(
        wrapper,
        `<div data-message-author-role="user"><span>You said · 10:42 · edited from another device</span><p>${text}</p><button>Edit</button></div>`,
      ),
    assistant: (html, wrapper = 'div class="row"') =>
      wrap(
        wrapper,
        `<div data-message-author-role="assistant"><div class="markdown">${html}</div><button>Copy</button></div>`,
      ),
  },
  {
    name: 'data-role',
    user: (text, wrapper = 'article class="message"') => wrap(wrapper, `<div data-role="user">${text}</div>`),
    assistant: (html, wrapper = 'article class="message"') =>
      wrap(wrapper, `<div data-role="assistant"><div class="prose">${html}</div></div>`),
  },
];
/** A left history column holding the prompt as a past chat, the thread in its own scroller, then the composer. */
const page = (layout: Layout, sidebar: string, thread = '') =>
  `<div class="history" data-rect="0,0,240,800">${layout.user(sidebar)}<div class="history-item">Older chat</div></div>` +
  `<div id="thread" data-scroll="auto" data-rect="260,0,720,700">${thread}</div>` +
  '<div class="composer"><textarea placeholder="Ask"></textarea><button aria-label="Send">Send</button></div>';
const rerender = (f: ReturnType<typeof pageFixture>, html: string) => {
  const thread = f.doc.querySelectorAll('#thread')[0];
  while (thread.firstChild) thread.removeChild(thread.firstChild);
  f.append('#thread', html);
};

const prompt = 'Summarise the release notes';
const answer = 'Working on it.\n\n## Real answer\n\nAll the details.';
const bubbles = (layout: Layout, wrapper?: string) =>
  layout.assistant('<p>Working on it.</p>', wrapper) +
  layout.assistant('<h2>Real answer</h2><p>All the details.</p>', wrapper);
const history = (layout: Layout, wrapper?: string) =>
  layout.user('Old question', wrapper) + layout.assistant('<p>Old answer about the release notes</p>', wrapper);

for (const layout of layouts) {
  test(`${layout.name}: recapture reads only this turn's answer, past a sidebar copy and a later user turn`, () => {
    const f = pageFixture(
      page(
        layout,
        prompt,
        history(layout) +
          layout.user(prompt) +
          bubbles(layout) +
          layout.user('Another question') +
          layout.assistant('<p>Another answer</p>'),
      ),
    );
    const result = f.bridge.recapture(prompt, {});
    assert.equal(result.ok, true);
    assert.equal(result.reply, answer);
    assert.equal(f.bridge.peek(result.trackerId, {}).reply, answer, 'the recaptured turn keeps being followed');
    assert.equal(f.bridge.recapture('Missing prompt', {}).code, 'lost');
  });

  test(`${layout.name}: changed wrappers and a saved bad reply selector never move the answer`, () => {
    const f = pageFixture(page(layout, prompt, history(layout)));
    f.bridge.find({});
    const id = f.bridge.track(prompt);
    f.append('#thread', layout.user(prompt));
    assert.equal(f.bridge.reply({ reply: '.history' }), null, 'nothing answers yet');
    f.append('#thread', layout.assistant('<p>Working on it.</p>'));
    assert.equal(f.bridge.reply({ reply: '.history' }).text, 'Working on it.');
    f.append('#thread', layout.assistant('<h2>Real answer</h2><p>All the details.</p>'));
    assert.equal(f.bridge.reply({ reply: '.history' }).text, answer);

    // The site re-renders the thread with new wrappers after another question was asked in its own window.
    const v2 = 'section class="turn-v2"';
    rerender(
      f,
      history(layout, v2) +
        layout.user(prompt, v2) +
        bubbles(layout, v2) +
        layout.user('Another question', v2) +
        layout.assistant('<p>Another answer</p>', v2),
    );
    assert.equal(f.bridge.peek(id, { reply: '.history' }).reply, answer);
    assert.equal(f.bridge.reply({}).text, answer);
  });

  test(`${layout.name}: a repeated prompt is owned by its one new copy and is ambiguous otherwise`, () => {
    const repeated = 'continue';
    const earlier = layout.user(repeated) + layout.assistant('<p>Old answer</p>');
    const f = pageFixture(page(layout, repeated, earlier));
    f.bridge.find({});
    const id = f.bridge.track(repeated);
    f.append('#thread', layout.user(repeated) + layout.assistant('<p>New answer</p>'));
    assert.equal(f.bridge.reply({}).text, 'New answer');
    // A re-render replaces the owner, which is found again by counting the copies that were there before sending.
    rerender(f, earlier + layout.user(repeated) + layout.assistant('<p>New answer</p>'));
    assert.equal(f.bridge.peek(id, {}).reply, 'New answer');
    // The same question asked again in the site's own window ends this answer; it does not take it over.
    f.append('#thread', layout.user(repeated) + layout.assistant('<p>Third answer</p>'));
    assert.equal(f.bridge.peek(id, {}).reply, 'New answer');
    // Without a tracker the copies cannot be told apart.
    assert.deepEqual({ ...f.bridge.recapture(repeated, {}) }, { ok: false, code: 'ambiguous' });

    // Two new copies at once (also sent from the site's window) leave no single owner.
    const g = pageFixture(page(layout, repeated, earlier));
    g.bridge.find({});
    const gid = g.bridge.track(repeated);
    g.append('#thread', layout.user(repeated) + layout.user(repeated) + layout.assistant('<p>New answer</p>'));
    assert.deepEqual({ ...g.bridge.reply({}) }, { code: 'ambiguous' });
    assert.deepEqual({ ...g.bridge.peek(gid, {}) }, { ok: false, code: 'ambiguous' });
  });

  test(`${layout.name}: an owned prompt that leaves the page is lost, not replaced by a guess`, () => {
    const f = pageFixture(page(layout, prompt, history(layout)));
    f.bridge.find({});
    const id = f.bridge.track(prompt);
    f.append('#thread', layout.user(prompt) + bubbles(layout));
    assert.equal(f.bridge.peek(id, {}).reply, answer);
    rerender(f, history(layout) + layout.assistant('<p>Unrelated text that appeared later</p>'));
    assert.deepEqual({ ...f.bridge.peek(id, {}) }, { ok: false, code: 'lost' });
    assert.deepEqual({ ...f.bridge.reply({}) }, { code: 'lost' });
  });
}

test('a turn whose author cannot be placed makes the answer ambiguous', () => {
  const layout = layouts[0];
  for (const author of ['tool', '']) {
    const unplaced = `<div class="row"><div data-message-author-role="${author}"><p>Search results</p></div></div>`;
    const f = pageFixture(page(layout, prompt, history(layout) + layout.user(prompt) + unplaced + bubbles(layout)));
    assert.deepEqual({ ...f.bridge.recapture(prompt, {}) }, { ok: false, code: 'ambiguous' }, author);

    const g = pageFixture(page(layout, prompt, history(layout)));
    g.bridge.find({});
    const id = g.bridge.track(prompt);
    g.append('#thread', layout.user(prompt) + unplaced + layout.assistant('<p>Answer</p>'));
    assert.deepEqual({ ...g.bridge.reply({}) }, { code: 'ambiguous' }, author);
    assert.equal(g.bridge.peek(id, {}).code, 'ambiguous', author);
  }
});

test('a prompt the marked turns never show as typed is left to the generic capture', () => {
  const layout = layouts[0];
  const f = pageFixture(page(layout, 'Older chat', history(layout)));
  f.bridge.find({});
  f.bridge.track('Use **bold** here');
  // The site renders the sent Markdown, so its user turn never matches the text PugPort typed.
  f.append('#thread', layout.user('Use <strong>bold</strong> here'));
  f.append('#thread', layout.assistant('<p>The bold answer with new details.</p>'));
  assert.equal(f.bridge.reply({}).text, 'The bold answer with new details.');
});
