/*
 * The part of the web bridge that runs inside a web agent's page, in an isolated JavaScript world: the page's own
 * scripts cannot see or change it. It only looks at the page's structure and visible text, types into the chat box
 * through the browser, and never reads cookies, storage or form values other than the chat box itself.
 *
 * Kept as plain JavaScript text (it is evaluated in the page); call it as `__pugportBridge.<name>(...)`.
 */
export const pageHelper = String.raw`(() => {
  if (globalThis.__pugportBridge) return true;
  const SEND = /(^|[^a-z])(send|submit)([^a-z]|$)|发送|提交|送出|傳送/i;
  const STOP = /(^|[^a-z])stop([^a-z]|$)|停止|中止|取消生成/i;
  const LOGIN = /(^|[^a-z])(log ?in|sign ?in|sign ?up|continue with)([^a-z]|$)|登录|登入|注册/i;
  const HUMAN = /verify (that )?you are (a )?human|are you a robot|not a robot|unusual traffic|checking your browser|just a moment\.\.\.|人机验证|验证您是真人|验证你是真人|请完成安全验证|安全验证/i;
  const ACCOUNT = /e-?mail|邮箱|user ?name|用户名|phone|手机|password|密码|验证码|one-time|\botp\b|current-password|\btel\b/i;
  const SEARCH = /(^|[^a-z])(search|filter)([^a-z]|$)|搜索|查找|筛选/i;
  const CHROME = /^(copy|copied|复制|已复制|share|分享|regenerate|重新生成|retry|重试|edit|编辑|like|dislike|good response|bad response|read aloud|朗读)$/i;
  const S = { input: null, send: null, tracker: null };
  const visible = (el) => {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05;
  };
  const all = (selector) => { if (!selector) return []; try { return Array.from(document.querySelectorAll(selector)); } catch (e) { return []; } };
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('name'), el.getAttribute('type') === 'submit' ? 'submit' : '', textOf(el).slice(0, 40)].filter(Boolean).join(' ');
  const isField = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  const editable = (el) => el.isContentEditable || (isField(el) && !el.disabled && !el.readOnly);
  const valueOf = (el) => (el ? (isField(el) ? el.value : el.innerText || '') : '');
  const center = (el) => { el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const gap = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return Math.hypot(Math.max(0, x.left - y.right, y.left - x.right), Math.max(0, x.top - y.bottom, y.top - x.bottom)); };
  const quote = (v) => '"' + v.replace(/["\\]/g, '\\$&') + '"';
  const stableClass = (c) => /^[a-zA-Z][\w-]{2,40}$/.test(c) && !/\d{3,}|^(css|sc|jsx|tw|svelte|emotion)-|__[a-zA-Z0-9]{5,}$/.test(c);
  /** A selector for this element that a later visit can reuse; ids only where one element is meant. */
  const signature = (el, allowId) => {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-message-author-role', 'data-role', 'aria-label', 'name', 'placeholder', 'id']) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 60 || /\d{4,}/.test(v) || (attr === 'id' && !allowId)) continue;
      const selector = attr === 'id' ? '#' + CSS.escape(v) : tag + '[' + attr + '=' + quote(v) + ']';
      const found = all(selector);
      if (found.includes(el) && (allowId ? found.length === 1 : found[found.length - 1] === el)) return selector;
    }
    const classes = Array.from(el.classList).filter(stableClass).slice(0, 3);
    if (classes.length) {
      const selector = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
      const found = all(selector);
      if (found.length && found[found.length - 1] === el && (!allowId || found.length === 1)) return selector;
    }
    return '';
  };
  const CHAT_TURN = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [class*="chat-message" i], [class*="assistant-message" i], [class*="user-message" i], [class*="markdown" i], [class*="answer" i], [class*="reply" i], [class*="user" i], [class*="turn" i], article, main, #thread, [id*="thread" i], [class*="thread" i], textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], pre, code';
  const humanCheck = (selectors) => {
    const frames = all('iframe').filter(visible).map((f) => f.src || '').join(' ');
    if (/captcha|hcaptcha|recaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(frames)) return 'human-check';
    if (all('[class*="captcha" i], [id*="captcha" i], #challenge-form, #cf-challenge-running, [data-sitekey]').some(visible)) return 'human-check';
    const replySel = selectors && selectors.reply;
    const composer = S.tracker && S.tracker.composer;
    const inChat = (el) =>
      !el.closest('[role="dialog"], [role="alert"], [class*="challenge" i]') &&
      (!!el.closest(CHAT_TURN) ||
        !!(replySel && el.closest(replySel)) ||
        !!(S.input && related(el, S.input)) ||
        !!(composer && related(el, composer)));
    const chrome = all('body, div, section, p, h1, h2, h3, span, form, [role="dialog"], [role="alert"]')
      .filter((el) => visible(el) && !inChat(el) && !el.querySelector(CHAT_TURN))
      .map((el) => textOf(el))
      .join('\n')
      .slice(0, 20000);
    if (HUMAN.test(chrome)) return 'human-check';
    if (all('input[type="password"]').some(visible)) return 'login';
    if (/\/(login|signin|sign-in|sign_in|auth|oauth|sso)(\/|$)/i.test(location.pathname)) return 'login';
    return '';
  };
  const validInput = (el) => {
    if (!visible(el) || !editable(el)) return false;
    const type = el.getAttribute('type');
    if (el.tagName === 'INPUT' && type && !/^text$/i.test(type)) return false;
    if (el.getAttribute('role') === 'searchbox' || el.closest('[role="search"], nav, aside, header, [role="navigation"], [role="complementary"], [role="menu"]')) return false;
    for (let p = el; p && p !== document.body; p = p.parentElement) if (sidebar(p)) return false;
    const hint = [labelOf(el), el.getAttribute('placeholder'), el.getAttribute('autocomplete'), el.getAttribute('id')].filter(Boolean).join(' ');
    if (ACCOUNT.test(hint) || SEARCH.test(hint)) return false;
    const form = el.closest('form');
    if (form && (form.querySelector('input[type="password"]') || form.getAttribute('role') === 'search')) return false;
    return true;
  };
  const findInput = (saved) => {
    const pick = all(saved).filter(validInput);
    if (pick.length) return pick[pick.length - 1];
    const candidates = all('textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')
      .filter((el) => validInput(el) && !(el.parentElement && el.parentElement.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')));
    let best = null, bestScore = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      let score = Math.min(r.width * Math.max(r.height, 20), 400000) * (0.5 + Math.min(1, Math.max(0, r.top / Math.max(1, innerHeight))));
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) score *= 1.5;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  };
  const buttons = () => all('button, [role="button"], input[type="submit"]').filter(visible);
  const findSend = (saved, input) => {
    const pick = all(saved).filter((el) => visible(el) && !STOP.test(labelOf(el)));
    if (pick.length) return input ? pick.sort((a, b) => gap(a, input) - gap(b, input))[0] : pick[pick.length - 1];
    let options = buttons().filter((el) => SEND.test(labelOf(el)) && !STOP.test(labelOf(el)));
    if (!options.length && input && input.closest('form'))
      options = Array.from(input.closest('form').querySelectorAll('button[type="submit"], input[type="submit"]')).filter(visible);
    if (!options.length) return null;
    return input ? options.sort((a, b) => gap(a, input) - gap(b, input))[0] : options[options.length - 1];
  };
  const findStop = (saved, input) => {
    const near = (el) => !input || gap(el, input) < 200;
    const pick = all(saved).filter((el) => visible(el) && near(el));
    if (pick.length) return pick[0];
    return buttons().find((el) => STOP.test(labelOf(el)) && near(el)) || null;
  };
  /** The box around the chat input and its buttons; changes inside it are typing, not the reply. */
  const composerOf = (input, send) => {
    let node = input;
    for (let depth = 0; node && depth < 6; depth++) {
      if ((send && node.contains(send)) || node.tagName === 'FORM') break;
      node = node.parentElement;
    }
    if (!node) return input.parentElement || input;
    const r = node.getBoundingClientRect();
    return r.width * r.height > innerWidth * innerHeight * 0.6 ? input.parentElement || input : node;
  };
  const locate = (selectors) => {
    S.input = findInput(selectors && selectors.input);
    S.send = S.input ? findSend(selectors && selectors.send, S.input) : null;
    return S.input;
  };
  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  const REGIONS = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="tree"], [role="dialog"]';
  const OMIT = 'button, [role="button"], [role="toolbar"], input, textarea, [contenteditable="true"], script, style, noscript, [hidden], [aria-hidden="true"]';
  const sidebar = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.width <= innerWidth * .32 && r.height >= innerHeight * .7 &&
      r.top <= innerHeight * .15 && r.bottom >= innerHeight * .85 &&
      (r.left <= 24 || r.right >= innerWidth - 24);
  };
  const excluded = (el) => {
    if (el.closest(REGIONS + ', ' + OMIT)) return true;
    for (let p = el; p && p !== document.body; p = p.parentElement) if (sidebar(p)) return true;
    return false;
  };
  const scrollOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
    return document.scrollingElement || document.documentElement;
  };
  // Text nodes plus rendered lines survive re-rendering and changes to wrapper elements.
  const textParts = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const p = node.parentElement;
      if (p && visible(p) && !p.closest(OMIT))
        parts.push(...node.textContent.split(/\r?\n/).map(norm).filter(Boolean));
    }
    return parts;
  };
  const freshText = (el) => {
    const cache = S.tracker.fresh;
    if (!cache.has(el)) cache.set(el, measureFreshText(el));
    return cache.get(el);
  };
  const measureFreshText = (el) => {
    const t = S.tracker, parts = textParts(el), before = t.before;
    let total = 0, fresh = 0;
    for (const part of parts) {
      total += part.length;
      if (before.has(part)) continue;
      if (part.length >= 12 && !t.beforeMatches.has(part)) t.beforeMatches.set(part, t.beforeText.includes(part));
      if (!t.beforeMatches.get(part)) fresh += part.length;
    }
    // A new, short turn can legitimately repeat an acknowledgement from earlier in the thread.
    // Mutating an old node, moving a sidebar or updating another scroller cannot use this exception.
    if (total > 0 && norm(textOf(el)).length < 24 && t.added.has(el)) {
      const bubble = userBubble();
      if (bubble && (bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && scrollOf(el) === scrollOf(bubble)) return true;
    }
    return total > 0 && fresh / total >= .6;
  };
  const eligible = (el, fresh = true) => visible(el) && !excluded(el) && !el.querySelector(REGIONS) &&
    !Array.from(el.children).some(sidebar) &&
    !(S.tracker.composer && related(el, S.tracker.composer)) && notMine(el) && (!fresh || freshText(el));
  const escapeMD = (s) => s.replace(/(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\)[^\s<>|"\x60]+|[*_\[\]#>|~\x60]/g, (token) => token.length > 1 ? token : '\\' + token).replace(/^(\s*\d+)\./gm, '$1\\.').replace(/^(\s*)([-+])/gm, '$1\\$2');
  /** Serialize visible DOM only. Never return page HTML or executable link schemes. */
  const fullMarkdown = (root) => {
    const tick = String.fromCharCode(96);
    const rawCode = (node) => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || excluded(node)) return '';
      if (node.tagName === 'BR') return '\n';
      if (!visible(node)) return '';
      return Array.from(node.childNodes).map(rawCode).join('') + (node.tagName === 'DIV' ? '\n' : '');
    };
    const walk = (node, depth = 0, inCard = false) => {
      if (node.nodeType === 3) return escapeMD(node.textContent.replace(/\s+/g, ' '));
      if (node.nodeType !== 1 || excluded(node) || CHROME.test(textOf(node))) return '';
      const tag = node.tagName;
      if (tag === 'BR') return visible(node.parentElement) ? '\n' : '';
      if (!visible(node)) return '';
      const children = () => Array.from(node.childNodes).map((child) => walk(child, depth, inCard)).join('');
      if (tag === 'IMG') return escapeMD(node.getAttribute('alt') || '[图片]');
      if (tag === 'PRE' || tag === 'CODE') {
        const raw = rawCode(node);
        const fence = tick.repeat(Math.max(tag === 'PRE' ? 3 : 1, ...Array.from(raw.matchAll(/\x60+/g), (m) => m[0].length + 1)));
        return tag === 'PRE' ? '\n\n' + fence + '\n' + raw.trimEnd() + '\n' + fence + '\n\n' : fence + ' ' + raw + ' ' + fence;
      }
      if (tag === 'UL' || tag === 'OL') {
        const items = Array.from(node.children).filter((child) => child.tagName === 'LI' && visible(child));
        return '\n' + items.map((li, i) => {
          const body = Array.from(li.childNodes).map((child) => walk(child, depth + 1)).join('').trim().replace(/\n{2,}/g, '\n');
          return '  '.repeat(depth) + (tag === 'OL' ? (i + 1) + '. ' : '- ') + body;
        }).join('\n') + '\n';
      }
      if (tag === 'TABLE') {
        const rows = Array.from(node.querySelectorAll('tr')).filter(visible).map((row) =>
          Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.tagName)).map((cell) => walk(cell).trim().replace(/\n+/g, ' ')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row) => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
        return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
      }
      const body = children();
      if (tag === 'A') {
        if (!node.getAttribute('href')) return body;
        try { const url = new URL(node.getAttribute('href'), location.href);
          if (/^https?:$/.test(url.protocol)) return '[' + body.trim() + '](' + url.href.replace(/[()<>\\]/g, (c) => '%' + c.charCodeAt(0).toString(16)) + ')';
        } catch {}
        return body;
      }
      if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + body.trim() + '\n\n';
      if (/^(STRONG|B)$/.test(tag)) return '**' + body.trim() + '**';
      if (/^(EM|I)$/.test(tag)) return '*' + body.trim() + '*';
      if (tag === 'BLOCKQUOTE') return '\n\n' + body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
      if (!inCard && (tag === 'DIV' || tag === 'SECTION')) {
        const cards = Array.from(node.children).filter((child) => visible(child) && !excluded(child));
        const key = (el) => el.tagName + '.' + Array.from(el.classList).filter(stableClass).sort().join('.');
        if (cards.length >= 3 && Array.from(node.childNodes).every((child) => child.nodeType !== 3 || !child.textContent.trim())) {
          const groups = []; let converted = false;
          for (let i = 0; i < cards.length;) {
            let end = i + 1;
            while (end < cards.length && key(cards[end]) === key(cards[i])) end++;
            const run = cards.slice(i, end);
            if (run.length >= 3 && /^(DIV|ARTICLE|SECTION)$/.test(cards[i].tagName)) {
              converted = true;
              groups.push(run.map((child) => '- ' + walk(child, depth, true).trim().split(/\n+/).map((s) => s.trim()).filter(Boolean).join(' · ')).join('\n'));
            } else groups.push(run.map((child) => walk(child, depth)).join(''));
            i = end;
          }
          if (converted) return '\n\n' + groups.join('\n\n') + '\n\n';
        }
      }
      return /^(P|DIV|SECTION|ARTICLE)$/.test(tag) ? '\n\n' + body.trim() + '\n\n' : body;
    };
    return walk(root).replace(/\n{3,}/g, '\n\n').trim();
  };
  const markdown = (root) => fullMarkdown(root).slice(-100000);
  const joined = (roots) => roots.map((el) => fullMarkdown(el)).filter(Boolean).join('\n\n');
  /** Shows exactly this normalized prompt; a short label or time may sit beside it. */
  const shows = (el, full) => {
    const have = norm(textOf(el));
    return !!have && (have === full || (have.includes(full) && have.length <= full.length + 40));
  };
  // Author markers chat pages put on each turn. Another data-message-author-role value (tool, system) is an author
  // PugPort cannot place in the answer.
  // shortcut: pages without these markers keep the generic ranking, which cannot end an answer at a later question or
  // tell a repeated prompt apart after a re-render; add the site's real markers here once its markup is recorded.
  const TURN = '[data-message-author-role], [data-role="user"], [data-role="assistant"]';
  const markedTurns = () => {
    const marked = all(TURN).filter((el) => visible(el) && !excluded(el));
    return marked
      .filter((el) => !marked.some((other) => other !== el && el.contains(other)))
      .map((el) => ({ el, author: el.getAttribute('data-message-author-role') || el.getAttribute('data-role') }));
  };
  /** A user turn holding the prompt: it, or an element inside it, shows it, so a long author label may sit beside it. */
  const holds = (turn, full) => turn.author === 'user' && norm(textOf(turn.el)).includes(full) &&
    (shows(turn.el, full) || Array.from(turn.el.querySelectorAll('*')).some((child) => shows(child, full)));
  /**
   * The answer on a page that marks each turn's author: the assistant turns after the prompt's user turn, up to the
   * next user turn. known is the user turn found before; while it is on the page it stays the owner. Otherwise seen
   * counts the copies of the prompt that were on the page before sending, so exactly one new copy owns the answer.
   * More copies, or a turn whose author cannot be placed, are 'ambiguous'. Undefined when the page marks no user and
   * assistant turns or shows no new copy of the prompt: the generic capture below applies.
   */
  const ownedTurns = (full, seen, known) => {
    const turns = markedTurns();
    if (!turns.some((turn) => turn.author === 'user') || !turns.some((turn) => turn.author === 'assistant')) return;
    const owners = turns.filter((turn) => holds(turn, full)).map((turn) => turn.el);
    const owner = known && owners.includes(known) ? known : owners.length === seen + 1 ? owners[seen] : null;
    if (!owner) return owners.length > seen ? { code: 'ambiguous' } : undefined;
    const thread = scrollOf(owner), answer = [];
    for (const turn of turns) {
      if (!(owner.compareDocumentPosition(turn.el) & Node.DOCUMENT_POSITION_FOLLOWING) || scrollOf(turn.el) !== thread) continue;
      if (turn.author === 'user') break;
      if (turn.author !== 'assistant') return { code: 'ambiguous' };
      answer.push(turn.el);
    }
    return { owner, answer };
  };
  /** ownedTurns for the tracked prompt. Once a marked turn owned it, losing that turn never falls back to a guess. */
  const trackedTurns = (t) => {
    const owned = ownedTurns(t.full, t.seen, t.owner);
    if (owned && owned.owner) t.owner = owned.owner;
    return owned || (t.owner ? { code: 'lost' } : undefined);
  };
  /** The user's own message as the page shows it: what appeared with exactly the text that was sent. */
  const userBubble = () => {
    const t = S.tracker;
    if (t.user !== undefined && (!t.user || t.user.isConnected)) return t.user;
    let best = null;
    for (const el of t.nodes) {
      if (!el.isConnected || excluded(el)) continue;
      if (shows(el, t.full) && (!best || best.contains(el))) best = el;
    }
    t.user = best;
    return best;
  };
  /** Neither the user's message nor anything holding it; without a match, nothing quoting its opening words. */
  const notMine = (el) => {
    const t = S.tracker;
    const bubble = userBubble();
    return bubble ? !related(el, bubble) : !(t.key && norm(textOf(el)).includes(t.key));
  };
  const changedNodes = () => {
    const t = S.tracker;
    if (!t) return [];
    return Array.from(t.nodes).filter((el) => el.isConnected && textOf(el) && eligible(el));
  };
  globalThis.__pugportBridge = {
    find(selectors) {
      const input = locate(selectors);
      const check = humanCheck(selectors);
      const loginHint = !input && buttons().some((el) => LOGIN.test(labelOf(el)));
      const reply = !!(selectors && selectors.reply && all(selectors.reply).some((el) => visible(el) && !excluded(el)));
      return {
        check,
        loginHint,
        input: !!input,
        send: !!S.send,
        reply,
        editable: !!(input && input.isContentEditable),
        selectors: { input: signature(input, true), send: signature(S.send, true) },
      };
    },
    /** Focuses the chat box and selects what is in it, so typing replaces it. */
    prepare() {
      const input = S.input && S.input.isConnected ? S.input : locate();
      if (!input) return null;
      const at = center(input);
      input.focus();
      if (isField(input)) input.select();
      else { const range = document.createRange(); range.selectNodeContents(input); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      return at;
    },
    value() { return valueOf(S.input); },
    /** Fallback when typing did not reach the box: set it the way a paste would. */
    setValue(text) {
      const input = S.input;
      if (!input) return false;
      input.focus();
      if (isField(input)) {
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const range = document.createRange(); range.selectNodeContents(input); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('insertText', false, text);
      }
      return true;
    },
    sendTarget(selectors) {
      const send = findSend(selectors && selectors.send, S.input) || S.send;
      if (!send) return null;
      S.send = send;
      const disabled = !!send.disabled || send.getAttribute('aria-disabled') === 'true';
      return Object.assign(center(send), { disabled });
    },
    /** Enter as the page sees it, for sites that ignore the browser's own key events in a hidden window. */
    pressEnter() {
      const input = S.input;
      if (!input) return false;
      input.focus();
      for (const type of ['keydown', 'keypress', 'keyup'])
        input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return true;
    },
    /**
     * Starts watching the page for what changes after sending, outside the chat box. Copies of the prompt already in
     * marked user turns are counted, unless it was sent before tracking (a recapture, or a reload while waiting).
     */
    track(text, sent) {
      if (S.tracker) S.tracker.observer.disconnect();
      const composer = S.input ? composerOf(S.input, S.send) : null;
      const before = new Set([...textParts(document.body), ...textOf(document.body).split(/\r?\n/).map(norm)]);
      const full = norm(text), seen = sent ? 0 : markedTurns().filter((turn) => holds(turn, full)).length;
      const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), nodes: new Set(), added: new Set(), last: 0, full, key: full.slice(0, 50), composer, before, beforeText: norm(textOf(document.body)), beforeMatches: new Map(), fresh: new Map(), seen, owner: null };
      t.observer = new MutationObserver((records) => {
        t.user = undefined;
        for (const record of records) {
          if (record.type === 'childList') for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            t.added.add(node);
            for (const child of node.querySelectorAll('*')) t.added.add(child);
          }
          const targets = record.type === 'characterData' ? [record.target.parentElement] : Array.from(record.addedNodes).map((node) => (node.nodeType === 1 ? node : node.parentElement));
          for (const el of targets) {
            if (!el || excluded(el) || (t.composer && t.composer.contains(el))) continue;
            t.last = Date.now();
            t.nodes.add(el);
            for (const child of el.querySelectorAll('*')) if (!excluded(child)) t.nodes.add(child);
          }
        }
      });
      t.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      S.tracker = t;
      return t.id;
    },
    status(selectors) {
      if (S.tracker) S.tracker.fresh.clear();
      const input = S.input && S.input.isConnected ? S.input : locate(selectors);
      const stop = findStop(selectors && selectors.stop, input);
      const disabled = !!input && (!!input.disabled || input.getAttribute('aria-disabled') === 'true' || input.getAttribute('contenteditable') === 'false');
      const check = humanCheck(selectors) || (!input && !stop && buttons().some((el) => LOGIN.test(labelOf(el))) ? 'login' : '');
      return {
        tracking: !!S.tracker,
        generating: !!stop || disabled,
        quietMs: S.tracker && S.tracker.last ? Date.now() - S.tracker.last : null,
        changed: changedNodes().length,
        inputText: valueOf(input),
        check,
      };
    },
    /**
     * The reply: what appeared after sending, outside the chat box and the user's own message. Once marked turns own
     * the prompt, only their answer counts, or { code } when it cannot be told; a saved reply selector never overrides.
     */
    reply(selectors) {
      const t = S.tracker;
      if (!t) return null;
      const owned = trackedTurns(t);
      if (owned) {
        if (owned.code) return { code: owned.code };
        const full = joined(owned.answer);
        return full ? Object.assign({ text: full.slice(-100000) }, full.length > 100000 ? { truncated: true } : null) : null;
      }
      t.fresh.clear();
      const changed = changedNodes();
      const candidates = new Set(changed);
      for (const el of changed) for (let up = el.parentElement; up && up !== document.body && eligible(up); up = up.parentElement) candidates.add(up);
      const saved = new Set(all(selectors && selectors.reply).filter((el) => eligible(el) && changed.some((node) => related(el, node))));
      for (const el of saved) candidates.add(el);
      const bubble = userBubble(), thread = bubble && scrollOf(bubble);
      const score = (el) => {
        const same = thread && scrollOf(el) === thread;
        const after = bubble && !!(bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const container = scrollOf(el), r = el.getBoundingClientRect(), bounds = container.getBoundingClientRect();
        const bottom = Math.max(0, 1 - Math.abs(bounds.bottom - r.bottom) / Math.max(1, container.clientHeight));
        return (same ? 10000 : 0) + (after ? 5000 : 0) + bottom * 100 + Math.min(textOf(el).length, 4000) + (saved.has(el) ? 50 : 0);
      };
      for (const best of Array.from(candidates).sort((a, b) => score(b) - score(a))) {
        const full = fullMarkdown(best);
        const text = full.slice(-100000);
        if (text) return Object.assign({ text, selector: signature(best, false) }, full.length > 100000 ? { truncated: true } : null);
      }
      return null;
    },
    peek(id, selectors) {
      const t = S.tracker;
      if (!t || t.id !== id) return { ok: false, code: 'replaced' };
      const found = this.find(selectors);
      if (found.check || (!found.input && found.loginHint)) return { ok: false, code: found.check || 'login' };
      if (S.input) t.composer = composerOf(S.input, S.send);
      // Bound retained nodes even when a site repeatedly replaces its whole thread.
      for (const nodes of [t.nodes, t.added]) for (const el of nodes) if (!el.isConnected) nodes.delete(el);
      const owned = trackedTurns(t);
      if (owned) {
        if (owned.code) return { ok: false, code: owned.code };
        const full = joined(owned.answer);
        return Object.assign({ ok: true, reply: full.slice(-100000), trackerId: id }, full.length > 100000 ? { truncated: true } : null);
      }
      const bubble = userBubble();
      if (!bubble) return { ok: false, code: 'lost' };
      t.fresh.clear();
      const after = (el) => eligible(el, false) && scrollOf(el) === scrollOf(bubble) &&
        !!(bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const candidates = new Set(Array.from(t.nodes).filter(after));
      for (const el of candidates) for (let up = el.parentElement; up && up !== document.body && after(up); up = up.parentElement) candidates.add(up);
      const roots = Array.from(candidates).filter((el) => {
        for (let up = el.parentElement; up; up = up.parentElement) if (candidates.has(up)) return false;
        return true;
      });
      roots.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      const full = joined(roots);
      return Object.assign({ ok: true, reply: full.slice(-100000), trackerId: id }, full.length > 100000 ? { truncated: true } : null);
    },
    /** Reads the reply to a prompt sent earlier, without an active tracker; never types or sends. */
    recapture(text, selectors) {
      const found = this.find(selectors);
      if (found.check || (!found.input && found.loginHint)) return { ok: false, code: found.check || 'login' };
      const full = norm(text);
      const owned = ownedTurns(full, 0);
      if (owned) {
        if (owned.code) return { ok: false, code: owned.code };
        const id = this.track(text, true);
        S.tracker.user = S.tracker.owner = owned.owner;
        const reply = joined(owned.answer);
        if (!reply) return { ok: false, code: 'not-detected', trackerId: id };
        return Object.assign({ ok: true, reply: reply.slice(-100000), trackerId: id, selectors: found.selectors }, reply.length > 100000 ? { truncated: true } : null);
      }
      const composer = S.input ? composerOf(S.input, S.send) : null;
      let bubble = null;
      for (const el of document.body.querySelectorAll('*')) {
        if (!visible(el) || excluded(el) || (composer && related(el, composer))) continue;
        if (shows(el, full)) {
          // Two copies of the prompt: no way to tell which one this reply answers.
          if (bubble && !related(bubble, el)) return { ok: false, code: 'ambiguous' };
          if (!bubble || bubble.contains(el)) bubble = el;
        }
      }
      if (!bubble) return { ok: false, code: 'lost' };
      if (all('[data-message-author-role="user"], [data-role="user"]').some((el) =>
        visible(el) && !related(el, bubble) && scrollOf(el) === scrollOf(bubble) &&
        !!(bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      )) return { ok: false, code: 'lost' };
      const id = this.track(text, true);
      S.tracker.user = bubble;
      const after = (el) =>
        visible(el) &&
        !excluded(el) &&
        !el.querySelector(REGIONS) &&
        !Array.from(el.children).some(sidebar) &&
        !(composer && related(el, composer)) &&
        !related(el, bubble) &&
        scrollOf(el) === scrollOf(bubble) &&
        !!(bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const candidates = new Set();
      for (const el of document.body.querySelectorAll('*')) {
        if (after(el)) {
          candidates.add(el);
          S.tracker.nodes.add(el);
        }
      }
      const roots = Array.from(candidates).filter((el) => {
        for (let up = el.parentElement; up; up = up.parentElement) if (candidates.has(up)) return false;
        return true;
      });
      roots.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const fullReply = joined(roots);
      if (!fullReply) return { ok: false, code: 'not-detected', trackerId: id };
      return Object.assign(
        {
          ok: true,
          reply: fullReply.slice(-100000),
          trackerId: id,
          selectors: Object.assign({}, found.selectors, roots[0] ? { reply: signature(roots[0], false) } : null),
        },
        fullReply.length > 100000 ? { truncated: true } : null,
      );
    },
    stop(id) { if (id && (!S.tracker || S.tracker.id !== id)) return false; if (S.tracker) S.tracker.observer.disconnect(); S.tracker = null; return true; },
  };
  return true;
})()`;
