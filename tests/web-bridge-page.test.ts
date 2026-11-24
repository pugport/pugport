import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageFixture } from './helpers/page-dom.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { renderMarkdown } from '../src/ui/markdown.tsx';

test('peek retains all answer bubbles in page order, excludes composer and owner, and detects lost/replaced trackers', () => {
  const f = pageFixture(
    '<main id="thread"><p>Old history</p></main><div id="composer"><textarea></textarea><button>Send</button></div>',
  );
  f.bridge.find({});
  const id = f.bridge.track('Question');
  const owner = f.append('#thread', '<p>Question</p>');
  f.append('#thread', '<article class="first"><p>Working on it.</p></article>');
  assert.equal(f.bridge.reply({}).text, 'Working on it.');
  f.append('#thread', '<article class="last"><h2>Real answer</h2><p>All the details.</p></article>');
  const expected = 'Working on it.\n\n## Real answer\n\nAll the details.';
  const composer = f.doc.querySelectorAll('#composer')[0];
  composer.parentNode.removeChild(composer);
  f.append('body', '<div id="composer"><textarea></textarea><button>Send</button><p>Unsent composer hint</p></div>');
  assert.equal(f.bridge.peek(id, {}).reply, expected);
  const last = f.doc.querySelectorAll('.last')[0];
  last.parentNode.removeChild(last);
  f.append('#thread', '<article class="last"><h2>Real answer</h2><p>All the details.</p></article>');
  assert.equal(f.bridge.peek(id, {}).reply, expected);
  owner.parentNode.removeChild(owner);
  assert.equal(f.bridge.peek(id, {}).code, 'lost');
  const next = f.bridge.track('Next');
  assert.notEqual(next, id);
  assert.equal(f.bridge.peek(id, {}).code, 'replaced');
  assert.equal(f.bridge.stop(id), false);
  assert.equal(f.bridge.status({}).tracking, true);
  assert.equal(f.bridge.stop(next), true);
});

test('recapture reads the assistant reply after the sent user prompt without an active tracker', () => {
  const f = pageFixture(
    '<main id="thread"><p>Old history</p><p>Question</p><article class="first"><p>Working on it.</p></article><article class="last"><h2>Real answer</h2><p>All the details.</p></article></main><div id="composer"><textarea></textarea><button>Send</button></div>',
  );
  const recaptured = f.bridge.recapture('Question', {});
  assert.equal(recaptured.ok, true);
  assert.equal(recaptured.reply, 'Working on it.\n\n## Real answer\n\nAll the details.');
  assert.ok(recaptured.trackerId);
  assert.equal(f.bridge.recapture('Missing prompt', {}).code, 'lost');
});

test('recapture refuses repeated prompts and stops a marked answer at the next user turn', () => {
  const repeated = pageFixture(
    '<main id="thread"><p>Question</p><article>First answer</article><p>Question</p><article>Second answer</article></main><div id="composer"><textarea></textarea><button>Send</button></div>',
  );
  assert.equal(repeated.bridge.recapture('Question', {}).code, 'ambiguous');
  const later = pageFixture(
    '<main id="thread"><p data-message-author-role="user">Question</p><article data-message-author-role="assistant">Answer</article><p data-message-author-role="user">Another question</p><article data-message-author-role="assistant">Another answer</article></main><div id="composer"><textarea></textarea><button>Send</button></div>',
  );
  assert.equal(later.bridge.recapture('Question', {}).reply, 'Answer');
  // Without author markers the later turn cannot be told from the answer, so nothing is taken.
  const unmarked = pageFixture(
    '<main id="thread"><p>Question</p><article>Answer</article><p data-role="user">Another question</p></main><div id="composer"><textarea></textarea><button>Send</button></div>',
  );
  assert.equal(unmarked.bridge.recapture('Question', {}).code, 'lost');
});

test('peek keeps the end of long markdown and repeated assistant content after the owner', () => {
  const f = pageFixture('<main id="thread"><p>A repeated answer from history</p></main>');
  const id = f.bridge.track('Question');
  f.append('#thread', '<p>Question</p>');
  f.append('#thread', '<article>A repeated answer from history</article>');
  assert.equal(f.bridge.peek(id, {}).reply, 'A repeated answer from history');
  assert.equal(f.bridge.peek(id, {}).truncated, undefined);
  f.append('#thread', `<article>${'a'.repeat(100_100)}THE END</article>`);
  const initialReply = f.bridge.reply({});
  assert.equal(initialReply.text.length, 100_000);
  assert.ok(initialReply.text.endsWith('THE END'));
  assert.equal(initialReply.truncated, true);
  assert.equal(f.bridge.peek(id, {}).reply, initialReply.text);
  assert.equal(f.bridge.peek(id, {}).truncated, true);
});

test('freshness is measured once per element per poll and refreshed for the next poll', () => {
  const f = pageFixture('<main id="thread"><p>Old history text</p></main>');
  f.bridge.track('Question');
  f.append('#thread', '<p>Question</p>');
  f.append('#thread', '<article class="answer"><p>New answer with enough text to capture</p></article>');
  const reads = new Map<unknown, number>();
  const walk = f.doc.createTreeWalker;
  f.doc.createTreeWalker = (el: unknown, ...args: unknown[]) => {
    reads.set(el, (reads.get(el) ?? 0) + 1);
    return walk.call(f.doc, el, ...args);
  };
  assert.equal(f.bridge.reply({ reply: '.answer' }).text, 'New answer with enough text to capture');
  assert.ok(reads.size > 0);
  assert.ok([...reads.values()].every((count) => count === 1));
  reads.clear();
  f.changeText('.answer', 'The next poll sees a changed answer');
  assert.equal(f.bridge.reply({ reply: '.answer' }).text, 'The next poll sees a changed answer');
  assert.ok(reads.size > 0);
  assert.ok([...reads.values()].every((count) => count === 1));
});

test('baseline substring checks are cached by line across polls and reset for a new tracking session', () => {
  const old = 'repeated baseline fragment',
    fresh = 'A brand new answer with enough text';
  const f = pageFixture(
    '<main id="thread"><p>History has a repeated baseline fragment for comparison</p></main>',
    `
    document.lookups = new Map();
    const includes = String.prototype.includes;
    String.prototype.includes = function (line, ...args) {
      if (${JSON.stringify([old, fresh])}.includes(line))
        document.lookups.set(line, (document.lookups.get(line) || 0) + 1);
      return includes.call(this, line, ...args);
    };
  `,
  );
  f.bridge.track('Question');
  f.append('#thread', '<p>Question</p>');
  f.append('#thread', `<article class="answer"><p>${old}</p><p>${fresh}</p></article>`);
  for (let poll = 0; poll < 3; poll++) assert.equal(f.bridge.reply({ reply: '.answer' }).text, fresh);
  assert.equal(f.doc.lookups.get(old), 1, 'a baseline match is checked once');
  assert.equal(f.doc.lookups.get(fresh), 1, 'a baseline miss is checked once');
  f.changeText('.answer', 'Another entirely new answer that is long enough');
  assert.match(f.bridge.reply({ reply: '.answer' }).text, /Another entirely new answer/);
  f.bridge.track('Next question');
  f.append('#thread', '<p>Next question</p>');
  f.append('#thread', `<article class="next-answer"><p>${fresh}</p></article>`);
  assert.equal(f.bridge.reply({ reply: '.next-answer' }).text, fresh);
  assert.equal(f.doc.lookups.get(fresh), 2, 'a new baseline gets a new cache');
});

test('captured plain paths and URLs render with their original targets and copy text', () => {
  for (const token of [String.raw`C:\Users\x\my_file.txt`, 'https://example.com/a_b#top', String.raw`\\nas\photos`]) {
    const f = pageFixture('<main id="thread"></main>');
    f.bridge.track('Question');
    f.append('#thread', '<p>Question</p>');
    f.append('#thread', `<article class="answer"><p>Open ${token} now</p></article>`);
    const text = f.bridge.reply({}).text;
    assert.equal(text, `Open ${token} now`, 'stored and copied reply retains the plain token');
    const html = renderToStaticMarkup(createElement('div', {}, renderMarkdown(text)));
    assert.ok(html.includes(`${token.startsWith('https:') ? 'href' : 'data-local-path'}="${token}"`), html);
    if (!token.startsWith('https:')) assert.ok(html.includes(`>${token}</span>`), html);
  }
});

test('captured backslashes round trip as plain text while a real UNC remains clickable', () => {
  for (const token of [String.raw`\n`, 'Ctrl+\\', String.raw`(\d+)`, String.raw`\\nas\share\x`]) {
    const f = pageFixture('<main id="thread"></main>');
    f.bridge.track('Question');
    f.append('#thread', '<p>Question</p>');
    const expected = `Use ${token} in this answer`;
    f.append('#thread', `<article class="answer"><p>${expected}</p></article>`);
    const text = f.bridge.reply({}).text;
    assert.equal(text, expected);
    const html = renderToStaticMarkup(createElement('div', {}, renderMarkdown(text, { relativePaths: true })));
    if (token.startsWith('\\\\')) assert.ok(html.includes(`data-local-path="${token}"`), html);
    else assert.equal(html, `<div><p>${expected}</p></div>`);
  }
});

test('only visible captcha iframes require a human check', () => {
  for (const hidden of ['', ' hidden="hidden"', ' data-rect="0,0,0,0"']) {
    const f = pageFixture(`<iframe src="https://challenges.cloudflare.com/turnstile"${hidden}></iframe>`);
    const frame = f.doc.querySelectorAll('iframe')[0];
    // The synthetic DOM has no browser URL property getters.
    frame.src = frame.getAttribute('src');
    assert.equal(f.bridge.find({}).check, hidden ? '' : 'human-check');
  }
});

test('status reports login redirects and password prompts during reply wait', () => {
  const f = pageFixture('<main id="thread"></main><div id="composer"><textarea></textarea><button>Send</button></div>');
  f.bridge.find({});
  f.bridge.track('Question');
  assert.equal(f.bridge.status({}).check, '');
  const composer = f.doc.querySelectorAll('#composer')[0];
  composer.parentNode.removeChild(composer);
  f.append('body', '<form><input type="password" /></form>');
  assert.equal(f.bridge.status({}).check, 'login');
});

test('human-verification phrases inside user prompts, assistant replies, or the composer do not trigger human-check while real challenge chrome still stops', () => {
  const f = pageFixture(
    '<main id="thread"></main><div id="composer"><textarea>Are you a robot?</textarea><button>Send</button></div>',
  );
  assert.equal(f.bridge.find({}).check, '');
  const id = f.bridge.track('Why do sites say "Verify you are human" or "请完成安全验证"?');
  f.append('#thread', '<div class="user">Why do sites say "Verify you are human" or "请完成安全验证"?</div>');
  f.append(
    '#thread',
    '<article class="answer"><p>A site asks "Verify that you are human" or "验证你是真人" during unusual traffic.</p></article>',
  );
  assert.equal(f.bridge.status({ reply: '.answer' }).check, '');
  assert.match(f.bridge.reply({ reply: '.answer' }).text, /Verify that you are human/);
  assert.equal(f.bridge.peek(id, { reply: '.answer' }).ok, true);

  // A real challenge overlay outside chat turns still stops the flow
  f.append('body', '<div role="dialog" class="challenge"><p>Verify you are human</p></div>');
  assert.equal(f.bridge.find({ reply: '.answer' }).check, 'human-check');
  assert.equal(f.bridge.status({ reply: '.answer' }).check, 'human-check');
});

test('composer detection rejects search, navigation, and account fields even when passed as saved selectors', () => {
  for (const markup of [
    '<input id="q" type="search" placeholder="Search" />',
    '<input id="q" type="text" placeholder="搜索历史对话" />',
    '<textarea id="q" aria-label="Search chats"></textarea>',
    '<header><textarea id="q" placeholder="Quick jump"></textarea></header>',
    '<input id="q" type="text" name="email" placeholder="Enter your email" />',
  ]) {
    const f = pageFixture(markup);
    assert.equal(f.bridge.find({}).input, false, markup);
    assert.equal(f.bridge.find({ input: '#q' }).input, false, `saved selector: ${markup}`);
    assert.equal(f.bridge.prepare(), null, `prepare: ${markup}`);
  }
  const withComposer = pageFixture(
    '<input id="q" type="text" placeholder="搜索对话" /><main><textarea id="chat-box" placeholder="Ask Muse"></textarea><button>Send</button></main>',
  );
  const found = withComposer.bridge.find({ input: '#q' });
  assert.equal(found.input, true);
  assert.equal(found.selectors.input, 'textarea[placeholder="Ask Muse"]');
});

test('rerendered left and right history, semantic panels and a saved bad selector never become replies', () => {
  for (const sidebar of [
    '<div id="history" data-rect="0,0,220,800">',
    '<div id="history" data-rect="780,0,220,800">',
    ...['nav', 'aside', 'header', 'footer'].map((tag) => `<${tag} id="history">`),
    ...['navigation', 'complementary', 'menu', 'menubar', 'listbox', 'tablist', 'tree', 'dialog'].map(
      (role) => `<div id="history" role="${role}">`,
    ),
  ]) {
    const close = sidebar.match(/^<(\w+)/)![1];
    const f = pageFixture(
      `${sidebar}<p>Old history entries</p></${close}><main id="thread" data-scroll="auto" data-rect="250,0,700,750"></main>`,
    );
    f.bridge.track('Question');
    f.append(
      '#history',
      '<div class="history-item">Old history entries</div><p>New unrelated navigation notification</p>',
    );
    f.append('#thread', '<div class="user">Question</div>');
    f.append('#thread', '<div class="answer"><p>Actual response with new information</p></div>');
    const answer = f.bridge.reply({ reply: '#history' });
    assert.equal(answer.text, 'Actual response with new information', sidebar);
    assert.notEqual(answer.selector, '#history');
  }
});

test('freshness rejects old text in new wrappers and saved reply selectors', () => {
  const f = pageFixture('<main id="thread"><p>Already seen long history item with many old characters</p></main>');
  f.bridge.track('Question');
  f.append('#thread', '<div class="user">Question</div>');
  f.append(
    '#thread',
    '<div class="stale"><span>Already seen long history item</span><span> with many old characters</span></div>',
  );
  assert.equal(f.bridge.reply({ reply: '.stale' }), null);
  assert.equal(f.bridge.status({}).changed, 0);
});

test('new short acknowledgements after the user are captured even when already present on the page', () => {
  for (const text of ['好的', 'OK']) {
    const f = pageFixture(`<main id="thread" data-scroll="auto"><p>${text}</p></main>`);
    f.bridge.track('Question');
    f.append('#thread', '<div class="user">Question</div>');
    f.append('#thread', `<div class="answer"><p>${text}</p></div>`);
    assert.equal(f.bridge.reply({ reply: '.answer' }).text, text);
  }
});

test('short repeated text still requires a new node after the user in the same non-sidebar scroller', () => {
  const f = pageFixture(
    '<div id="history" data-rect="0,0,220,800"><p>好的</p></div><div id="other" data-scroll="auto"></div><main id="thread" data-scroll="auto"><p class="old">好的</p></main>',
  );
  f.bridge.track('Question');
  f.append('#thread', '<div class="before">好的</div>');
  f.append('#thread', '<div class="user">Question</div>');
  f.append('#history', '<div class="answer">好的</div>');
  f.append('#other', '<div class="answer">好的</div>');
  f.changeText('.old', '好的');
  assert.equal(f.bridge.reply({ reply: '#history, .old, .before, #other' }), null);
});

test('a multiline answer preserves its repeated earlier line while most of its text is new', () => {
  const f = pageFixture('<main id="thread" data-scroll="auto"><p>已有进展</p></main>');
  f.bridge.track('Question');
  f.append('#thread', '<div class="user">Question</div>');
  f.append('#thread', '<div class="answer"><p>已有进展</p><p>这次又完成了新的验证，现在可以继续下一步工作。</p></div>');
  assert.equal(f.bridge.reply({}).text, '已有进展\n\n这次又完成了新的验证，现在可以继续下一步工作。');
});

test('short text uses exact lines rather than substrings of longer earlier phrases', () => {
  const f = pageFixture(
    '<div id="other" data-scroll="auto"><p>之前记录：OK, already acknowledged.</p><div class="answer"></div></div><main id="thread" data-scroll="auto"></main>',
  );
  f.bridge.track('Question');
  f.append('#thread', '<div class="user">Question</div>');
  // This preexisting node is outside the thread, so only the normal exact-line freshness rule applies.
  f.changeText('.answer', 'OK');
  assert.equal(f.bridge.reply({}).text, 'OK');
});

test('same-thread after-user position outranks longer changes before the question or in another scroller', () => {
  const f = pageFixture('<div id="other" data-scroll="auto"></div><main id="thread" data-scroll="auto"></main>');
  f.bridge.track('Question');
  f.append('#thread', '<div class="before">Earlier changed text that should not win</div>');
  f.append('#thread', '<div class="user">Question</div>');
  f.append('#other', '<div class="other-answer">' + 'Unrelated content '.repeat(300) + '</div>');
  f.append('#thread', '<div class="answer">The answer</div>');
  assert.equal(f.bridge.reply({ reply: '.other-answer' }).text, 'The answer');
});

test('paragraph-wrapped nested lists, code chrome and links without addresses stay readable', () => {
  const f = pageFixture('<main id="thread"></main>');
  f.bridge.track('Question');
  f.append('#thread', '<p>Question</p>');
  f.append(
    '#thread',
    '<article class="answer"><ul><li><p>First</p><ul><li><p>Nested</p></li></ul></li></ul><pre><code>safe code</code><button>Copy</button></pre><p><a>Label only</a></p></article>',
  );
  const text = f.bridge.reply({}).text;
  assert.match(text, /- First\n  - Nested/);
  assert.match(text, /```\nsafe code\n```/);
  assert.match(text, /Label only/);
  assert.doesNotMatch(text, /Copy|fixture.test\/null|\[Label only\]/);
});

test('DOM Markdown preserves structure and card lists, drops chrome, escapes text and never renders raw HTML', () => {
  const f = pageFixture('<main id="thread"></main>');
  f.bridge.track('Question');
  f.append('#thread', '<p>Question</p>');
  f.append(
    '#thread',
    '<article class="answer"><h2>Heading</h2><p><strong>Bold</strong> and <em>italic</em><br/>Next <code>x &lt; y</code></p><ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul><ol><li>Numbered</li></ol><pre>const x = 1;\nconsole.log(x);</pre><blockquote><p>Quote</p></blockquote><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><p><a href="https://example.test/news">Safe</a><a href="javascript:alert(1)">Unsafe</a></p><div class="cards"><div class="card"><div>Title A</div><div>Summary A</div><div>09:00</div></div><div class="card"><div>Title B</div><div>Summary B</div><div>10:00</div></div><div class="card"><div>Title C</div><div>Summary C</div><div>11:00</div></div></div><p>literal *stars* [brackets] #hash &lt;img src=x onerror=alert(1)&gt;</p><img alt="Diagram"/><img/><button>Copy</button><div role="toolbar">Toolbar junk</div><p hidden="hidden">Hidden junk</p></article>',
  );
  const text = f.bridge.reply({}).text;
  assert.match(text, /## Heading/);
  assert.match(text, /\*\*Bold\*\* and \*italic\*\nNext/);
  assert.match(text, /- First\n  - Nested\n- Second/);
  assert.match(text, /1\. Numbered/);
  assert.match(text, /```\nconst x = 1;\nconsole.log\(x\);\n```/);
  assert.match(text, /> Quote/);
  assert.match(text, /\| Name \| Value \|\n\| --- \| --- \|/);
  assert.match(text, /\[Safe\]\(https:\/\/example.test\/news\)/);
  assert.match(text, /Unsafe/);
  assert.match(text, /- Title A · Summary A · 09:00/);
  assert.match(text, /Diagram/);
  assert.match(text, /\\\[图片\\\]/);
  assert.doesNotMatch(text, /javascript:|Toolbar junk|Hidden junk|Copy|<h2>/);
  const html = renderToStaticMarkup(createElement('div', {}, renderMarkdown(text)));
  assert.doesNotMatch(html, /<img|<script|href="javascript:|<em>stars/);
  assert.match(html, /literal \*stars\* \[brackets\]/);
});
