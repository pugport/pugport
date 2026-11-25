// Real Studio and in-app confirmation in a hidden Electron window, with synthetic fetch/SSE only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchStudioFixture, openStudioFixture } = require('./helpers/studio-fixture-app.cjs');
const root = path.resolve(__dirname, '..');
const english = require(path.join(root, 'src/shared/i18n/en.json'));
if (!process.versions.electron) launchStudioFixture({ script: __filename, name: 'settings-categories' });
else {
  void openStudioFixture().then(async (studio) => {
    const { app, win, fixture, rendererErrors, evaluate, frame, click, pointer, screenshot, nav, fits, category } =
      studio;
    try {
      const model = () => evaluate('document.querySelector(\'select[aria-label="任务模型"]\').value');
      const choose = async (label, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector('select[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await frame();
      };
      const extension = async (tab) => {
        if (!(await evaluate("!!document.querySelector('.extensions-home')"))) await click('.sidebar-extensions');
        await click('#extensions-tab-' + tab);
        await evaluate("document.querySelector('.management-main').scrollTop = 0");
        await frame();
        if (tab === 'skills' || tab === 'connections') {
          assert.equal(
            await evaluate(`(()=>{
            const heading=document.querySelector('.extensions-heading');
            const action=document.querySelector('.settings-add > button');
            return heading.contains(action);
          })()`),
            true,
            'add control belongs to the Extensions heading',
          );
        }
      };
      const currentExtension = () =>
        evaluate(
          "document.querySelector('.extensions-home [role=tab][aria-selected=true]').id.replace('extensions-tab-','')",
        );
      const key = async (keyCode) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        if (keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await frame();
      };
      const roving = async (selector) => {
        assert.deepEqual(
          await evaluate(
            `Array.from(document.querySelectorAll('${selector} [role=radio]'), el => [el.tabIndex, el.getAttribute('aria-checked')])`,
          ),
          await evaluate(
            `Array.from(document.querySelectorAll('${selector} [role=radio]'), el => [el.getAttribute('aria-checked') === 'true' ? 0 : -1, el.getAttribute('aria-checked')])`,
          ),
        );
        assert.equal(await evaluate(`document.querySelectorAll('${selector} [role=radio][tabindex="0"]').length`), 1);
      };
      const current = () =>
        evaluate("document.querySelector('[data-settings-category][aria-current=page]').dataset.settingsCategory");
      const counts = () =>
        evaluate('[...window.activeIntervals.values()].filter(ms=>[4000,5000,30000].includes(ms)).sort((a,b)=>a-b)');
      const setText = async (selector, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await frame();
      };
      if (process.env.PUGPORT_UI_SIMPLIFY_B) {
        await require('./helpers/ui-simplify-settings-renderer.cjs')({
          win,
          evaluate,
          frame,
          click,
          category,
          choose,
          fits,
          screenshot,
          english,
        });
        assert.deepEqual(rendererErrors, []);
        await new Promise((resolve) =>
          process.stdout.write('PASS UI simplify B: settings interactions and screenshots\n', resolve),
        );
        win.destroy();
        app.exit(0);
        return;
      }
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.sidebar-tools button')].map(b=>b.textContent)"),
        ['扩展', '任务列表', '用量与连接', '设置'],
      );
      const extensionReads = await evaluate("window.fixture.calls.filter(c=>c.path==='/api/extensions').length");
      await extension('mods');
      assert.equal(await evaluate("!!document.querySelector('.mode-store')"), true);
      assert.equal(await evaluate("[...document.querySelectorAll('h1')].some(h=>h.textContent==='Mods Store')"), false);
      assert.equal(await evaluate("!!document.querySelector('[data-settings-item=skills]')"), false);
      assert.equal(await evaluate("window.fixture.calls.filter(c=>c.path==='/api/extensions').length"), extensionReads);
      await nav('设置');
      assert.equal(await evaluate("document.querySelectorAll('[data-settings-category]').length"), 7);
      assert.equal(
        await evaluate(
          "!!document.querySelector('[data-settings-category=extensions],[data-settings-category=connect]')",
        ),
        false,
      );
      assert.deepEqual(await counts(), []);
      assert.equal(
        await evaluate(
          "window.fixture.calls.some(c=>['/api/external/connections','/api/devices','/api/external-agents'].includes(c.path))",
        ),
        false,
      );
      await click('.conversation-link');
      await setText('#conversation-input', 'Unsaved language-switch draft');
      await nav('设置');
      await category('general');
      await evaluate(
        "[...document.querySelectorAll('.language-options button')].find(b=>b.textContent==='English').click()",
      );
      await frame();
      assert.equal(await evaluate("localStorage.getItem('comborunner.locale')"), 'zh-CN');
      assert.match(await evaluate("document.querySelector('.notice-info').textContent"), /草稿/);
      await click('.conversation-link');
      assert.equal(
        await evaluate("document.querySelector('#conversation-input').value"),
        'Unsaved language-switch draft',
      );
      await setText('#conversation-input', '');
      await nav('设置');
      await category('general');
      const terminalRow = async (theme, width) => {
        const row =
          "[...document.querySelectorAll('.settings-row')].find(r=>r.querySelector('.settings-row-expand')?.textContent==='终端')";
        const button = async (label) => {
          await evaluate(
            `(()=>{const row=${row};const button=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing terminal action');button.click();})()`,
          );
          await frame();
        };
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-before-${width}.png`);
        await button('加入 PATH');
        assert.equal(await evaluate(`(${row}).textContent.includes('已加入')`), true);
        assert.equal(
          await evaluate(`(${row}).textContent.includes('新开一个终端窗口后可用（已打开的 VS Code 需要重启）')`),
          true,
        );
        await button('终端');
        await fits();
        await screenshot(`${theme}-terminal-after-${width}.png`);
        await evaluate('window.fixture.terminalError=true');
        await button('从 PATH 移除');
        assert.equal(await evaluate(`(${row}).querySelector('[role=alert]').textContent`), 'Synthetic PATH denied');
        await screenshot(`${theme}-terminal-error-${width}.png`);
        await evaluate('window.fixture.terminalError=false');
        await button('重试');
        assert.equal(await evaluate(`(${row}).textContent.includes('已加入')`), false);
        await button('终端');
        await category('general');
        await evaluate('window.fixture.terminalInstalled=true');
        await extension('connections');
        assert.equal(await evaluate(`(${row}).textContent.includes('新开一个终端窗口')`), false);
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-persisted-${width}.png`);
        await category('general');
        await evaluate('window.fixture.terminalInstalled=false;window.fixture.holdTerminal=true');
        await extension('connections');
        assert.equal(await evaluate(`(${row}).querySelector('.settings-row-actions button').disabled`), true);
        assert.equal(await evaluate(`(${row}).textContent.includes('正在检查…')`), true);
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-checking-${width}.png`);
        await evaluate('window.fixture.holdTerminal=false;window.fixture.releaseTerminal()');
        await frame();
        await category('general');
        await evaluate('window.fixture.manualTerminal=true');
        await extension('connections');
        assert.equal(
          await evaluate(`(${row}).querySelector('.settings-row-actions button').textContent.trim()`),
          '复制命令',
        );
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await fits();
        await screenshot(`${theme}-terminal-manual-${width}.png`);
        await category('general');
        await evaluate('window.fixture.manualTerminal=false');
        await extension('connections');
      };
      for (const theme of ['light', 'dark']) {
        win.setContentSize(1280, 800);
        await frame();
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        for (const id of ['general', 'personal', 'conversation', 'routing', 'devices', 'permissions', 'advanced']) {
          await category(id);
          await fits();
          assert.equal(await current(), id);
          assert.deepEqual(await counts(), id === 'devices' ? [30000] : []);
          assert.equal(await evaluate("!!document.querySelector('.agent-connect')"), false);
          assert.equal(await evaluate("!!document.querySelector('.devices')"), id === 'devices');
          assert.equal(
            await evaluate("!!document.querySelector('.settings-content [data-settings-item=skills]')"),
            false,
          );
          await screenshot(theme + '-' + id + '-1280.png');
        }
        for (const tab of ['mods', 'skills', 'connections']) {
          await extension(tab);
          await fits();
          assert.equal(await currentExtension(), tab);
          assert.deepEqual(await counts(), tab === 'connections' ? [4000, 5000] : []);
          assert.equal(
            await evaluate("!!document.querySelector('.settings-add > button')"),
            ['skills', 'connections'].includes(tab),
          );
          assert.equal(
            await evaluate("document.querySelector('#extensions-body').getAttribute('aria-labelledby')"),
            'extensions-tab-' + tab,
          );
          assert.equal(await evaluate("!!document.querySelector('[data-settings-item=slack]')"), tab === 'connections');
          assert.equal(await evaluate("!!document.querySelector('.devices')"), false);
          assert.equal(
            await evaluate(`(()=>{
            const heading=document.querySelector('.extensions-heading');
            const tabs=document.querySelector('.extensions-home > .page-tabs');
            const body=document.querySelector('.extensions-body');
            return Math.abs(heading.getBoundingClientRect().left-tabs.getBoundingClientRect().left)<1 && Math.abs(heading.getBoundingClientRect().left-body.getBoundingClientRect().left)<1;
          })()`),
            true,
            'Extensions title, tabs and body share one left edge',
          );
          await screenshot(theme + '-extensions-' + tab + '-1280.png');
          if (tab === 'connections') await terminalRow(theme, '1280');
        }
        await category('general');
        for (const width of [1280, 1600, 1920]) {
          win.setContentSize(width, 800);
          await frame();
          await fits();
          assert.equal(
            await evaluate(`(()=>{
              const main=document.querySelector('.management-main');
              const shell=document.querySelector('.settings-shell');
              return Math.round(shell.getBoundingClientRect().left-main.getBoundingClientRect().left)===parseFloat(getComputedStyle(main).paddingLeft);
            })()`),
            true,
            `settings starts at the normal left padding at ${width}px`,
          );
          assert.equal(
            await evaluate("document.querySelector('.settings-content').getBoundingClientRect().width<=680"),
            true,
          );
          await screenshot(`${theme}-settings-${width}.png`);
        }
        win.setContentSize(1280, 800);
        await frame();
        await roving('.theme-options');
        await key('Tab');
        await evaluate("document.querySelector('.theme-options [aria-checked=true]').focus()");
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await key('Left');
        await roving('.theme-options');
        assert.equal(await evaluate("document.activeElement.matches(':focus-visible')"), true);
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        await screenshot(theme + '-theme-keyboard.png');
        await key('Tab');
        assert.equal(await evaluate("document.activeElement.closest('.accent-options') !== null"), true);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.accent-options');
        await key('Tab');
        assert.equal(await evaluate("document.activeElement.closest('[aria-label=界面语言]') !== null"), true);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('[aria-label=界面语言]');
        await evaluate("document.querySelector('[aria-label=界面语言] [aria-checked=true]').focus()");
        await key('Left');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'false');
        assert.equal(
          await evaluate("document.querySelector('[aria-label=界面语言] [aria-checked=true]').textContent"),
          '简体中文',
        );
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('[aria-label=界面语言]');
        await category('routing');
        await roving('.goal-picker');
        const writesBefore = await evaluate("window.fixture.calls.filter(c=>c.path==='/api/settings').length");
        await evaluate("document.querySelector('.goal-picker [aria-checked=true]').focus()");
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'false');
        assert.equal(await evaluate("window.fixture.calls.filter(c=>c.path==='/api/settings').length"), writesBefore);
        await key('Enter');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.goal-picker');
        await key('Right');
        await key('Space');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.goal-picker');
        await evaluate(
          "window.fixture.agentsError=true;window.fixture.slack={enabled:true,status:'connected',appTokenHint:'synthetic',botTokenHint:'synthetic',users:[{id:'synthetic',name:'Alice',pairedAt:'2026-10-15T12:00:00Z'}],activeTasks:0}",
        );
        await extension('connections');
        assert.equal(
          await evaluate(
            "document.querySelector('.external-agents [role=alert]').textContent.includes('Synthetic offline')",
          ),
          true,
        );
        await evaluate("document.querySelector('.external-agents [role=alert]').scrollIntoView({block:'center'})");
        await frame();
        await screenshot(theme + '-external-agents-error.png');
        win.setContentSize(380, 800);
        await frame();
        await evaluate("document.querySelector('.external-agents [role=alert]').scrollIntoView({block:'center'})");
        await fits();
        await screenshot(theme + '-external-agents-error-380.png');
        win.setContentSize(1280, 800);
        await frame();
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), false);
        await click('[data-settings-item="slack"] .settings-row-actions button');
        assert.equal(await evaluate('!!document.querySelector(\'.side-sheet[aria-label="Slack"]\')'), true);
        const guideStep = () =>
          evaluate("document.querySelector('.slack-steps > [aria-current=step] h4')?.textContent");
        const setSlack = async (view) => {
          await evaluate(`window.fixture.slack=${JSON.stringify(view)};window.pollSlack()`);
          await frame();
        };
        const slack = { enabled: false, status: 'off', users: [], activeTasks: 0 };
        await evaluate("document.querySelector('.notice .icon-button')?.click()");
        await setSlack(slack);
        assert.equal(await guideStep(), '创建 Slack 应用并填入 Token');
        assert.equal(await evaluate("document.querySelector('.slack-steps > li > div + div').hidden"), false);
        const stepColors = await evaluate(`(()=>{
          const step=document.querySelector('.slack-steps > [aria-current=step]');
          const later=document.querySelector('.slack-steps > [data-later=true] h4');
          const probe=document.createElement('span');step.append(probe);
          probe.style.color='var(--accent-text)';const accent=getComputedStyle(probe).color;
          probe.style.color='var(--muted)';const muted=getComputedStyle(probe).color;
          probe.style.backgroundColor='var(--panel)';const background=getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {marker:getComputedStyle(step,'::marker').color,accent,later:getComputedStyle(later).color,muted,background};
        })()`);
        assert.equal(stepColors.marker, stepColors.accent, 'current step number uses the text accent');
        assert.equal(stepColors.later, stepColors.muted, 'later titles use muted text');
        const luminance = (color) => {
          const channels = color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              const value = n / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const levels = [luminance(stepColors.later), luminance(stepColors.background)].sort((a, b) => a - b);
        assert.ok((levels[1] + 0.05) / (levels[0] + 0.05) >= 4.5, `${theme}: later titles pass 4.5:1`);
        // Later panels remain mounted but have no visible or focusable controls.
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.slack-steps > li:not([aria-current]) button')].every(b=>!b.getClientRects().length)",
          ),
          true,
        );
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-step-1-${width}.png`);
        }
        win.setContentSize(1280, 800);
        slack.appTokenHint = 'synthetic';
        slack.botTokenHint = 'synthetic';
        await setSlack(slack);
        assert.equal(await guideStep(), '打开连接');
        assert.match(
          await evaluate("document.querySelector('.slack-guide .slack-note').textContent"),
          /第 2 步，共 3 步/,
        );
        await click('.slack-steps > li:first-child button[aria-controls]');
        assert.equal(
          await evaluate("document.querySelector('.slack-steps button[aria-controls]').getAttribute('aria-expanded')"),
          'true',
        );
        assert.equal(await evaluate("document.querySelector('.slack-check').getClientRects().length>0"), true);
        await click('.slack-steps > li:first-child button[aria-controls]');
        await click('.slack-steps > li:nth-child(2) .primary');
        assert.equal(
          await evaluate("window.fixture.calls.some(c=>c.path==='/api/slack'&&c.method==='PATCH'&&c.body.enabled)"),
          true,
        );
        assert.equal(await guideStep(), '和机器人配对');
        await setSlack({ ...slack, enabled: true, status: 'error', error: 'Synthetic offline' });
        assert.equal(await guideStep(), '和机器人配对', 'a connection error does not move the step back');
        assert.match(
          await evaluate('document.querySelector(\'.side-sheet[aria-label="Slack"] .slack-note\').textContent'),
          /出错：Synthetic offline/,
        );
        await evaluate('window.fixture.slackHttpError=true;window.pollSlack()');
        await frame();
        assert.match(
          await evaluate("document.querySelector('[data-settings-item=slack]').previousElementSibling.textContent"),
          /读不到 Slack 设置：Synthetic request failed/,
        );
        await evaluate('window.fixture.slackHttpError=false');
        await setSlack({ ...slack, enabled: true, status: 'connected' });
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-step-3-${width}.png`);
        }
        await setSlack({
          ...slack,
          enabled: true,
          status: 'connected',
          users: [{ id: 'synthetic', name: 'Alice', pairedAt: '2026-10-15T12:00:00Z' }],
        });
        assert.equal(await guideStep(), undefined);
        assert.equal(await evaluate("document.querySelector('.slack-steps').getClientRects().length"), 0);
        assert.match(
          await evaluate("document.querySelector('.slack-guide-summary').textContent"),
          /已设置好 ·.*查看步骤/s,
        );
        assert.equal(
          await evaluate('document.querySelector(\'button[aria-label="移除 Alice"]\').getClientRects().length>0'),
          true,
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.slack-people button')].some(b=>b.textContent==='生成配对码'&&b.getClientRects().length)",
          ),
          true,
        );
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-done-${width}.png`);
        }
        win.setContentSize(1280, 800);
        await frame();
        await click('.slack-guide-summary button');
        assert.equal(await evaluate("document.querySelector('.slack-steps > li > div + div').hidden"), false);
        assert.match(await evaluate("document.querySelector('.slack-guide .slack-note').textContent"), /3 步都已完成/);
        await evaluate("[...document.querySelectorAll('.slack-guide button')].find(b=>b.textContent==='收起').click()");
        await frame();
        assert.equal(await evaluate("document.querySelector('.slack-steps').getClientRects().length"), 0);
        await click('.slack-guide-summary button');
        await screenshot(theme + '-expanded-row.png');
        assert.equal(await evaluate("document.querySelector('.slack-check input').checked"), false);
        assert.equal(
          await evaluate("getComputedStyle(document.querySelector('.slack-check input')).colorScheme"),
          theme,
          'native checkboxes follow the theme token even if the root inline scheme differs',
        );
        const checkboxBounds = await evaluate(`(()=>{
          const input=document.querySelector('.slack-check input');
          input.scrollIntoView({block:'center'});
          const r=input.getBoundingClientRect();
          return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};
        })()`);
        await frame();
        const center =
          (Math.floor(checkboxBounds.height / 2) * checkboxBounds.width + Math.floor(checkboxBounds.width / 2)) * 4;
        let bitmap = (await win.webContents.capturePage(checkboxBounds)).toBitmap();
        for (
          let attempt = 0;
          attempt < 10 && !(theme === 'light' ? bitmap[center] > 180 : bitmap[center] < 150);
          attempt++
        ) {
          win.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 20));
          bitmap = (await win.webContents.capturePage(checkboxBounds)).toBitmap();
        }
        assert.ok(
          theme === 'light' ? bitmap[center] > 180 : bitmap[center] < 150,
          'unchecked box has an empty center in both themes',
        );
        await click('button[aria-label="移除 Alice"]');
        await screenshot(theme + '-slack-remove-confirm.png');
        await key('Escape');
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), true);
        await click('button[aria-label="移除 Alice"]');
        await click('.confirm-dialog .button.danger');
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), false);
        assert.equal(await guideStep(), '和机器人配对');
        assert.equal(
          await evaluate("window.fixture.calls.some(c=>c.path==='/api/slack/users/synthetic'&&c.method==='DELETE')"),
          true,
        );
        await evaluate('window.fixture.agentsError=false');
        await click('.conversation-link');
        await click('button[aria-label="对话设置"]');
        await evaluate(
          "[...document.querySelectorAll('.conversation-panel [role=tab]')].find(b=>b.textContent==='Skills').click()",
        );
        await frame();
        await screenshot(theme + '-skills-empty.png');
        await evaluate(
          "[...document.querySelectorAll('.conversation-panel button')].find(b=>b.textContent==='安装 Skills').click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'skills');
        assert.equal(
          await evaluate(
            '(()=>{const r=document.querySelector("#extensions-tab-skills").getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()',
          ),
          true,
        );
        await evaluate("document.querySelector('.settings-add > button').focus()");
        await key('Enter');
        assert.equal(await evaluate('document.activeElement.textContent'), '从链接或文件夹添加…');
        await key('Down');
        assert.equal(await evaluate('document.activeElement.textContent'), '从其他 AI 应用导入…');
        await key('Up');
        await screenshot(theme + '-add-menu.png');
        win.setContentSize(380, 800);
        await frame();
        await fits();
        await screenshot(theme + '-add-menu-380.png');
        win.setContentSize(1280, 800);
        await frame();
        await key('Escape');
        assert.equal(await evaluate("document.activeElement.matches('.settings-add > button')"), true);
        assert.equal(await evaluate("!!document.querySelector('[role=menu]')"), false);
        await key('Enter');
        await key('Enter');
        assert.equal(await evaluate('document.activeElement.id'), 'extension-input');
        assert.equal(await evaluate('!!document.querySelector(\'.side-sheet[aria-label="添加扩展"]\')'), true);
        await click('.side-sheet-head button[aria-label="关闭"]');
        win.setContentSize(380, 800);
        await frame();
        await nav('设置');
        if (await evaluate("document.querySelector('.settings-shell').dataset.view !== 'list'"))
          await click('.settings-back');
        await fits();
        assert.equal(await evaluate("document.querySelector('.settings-shell').dataset.view"), 'list');
        await screenshot(theme + '-list-380.png');
        for (const id of ['general', 'personal', 'conversation', 'routing', 'devices', 'permissions', 'advanced']) {
          await category(id);
          await fits();
          assert.equal(
            await evaluate("getComputedStyle(document.querySelector('.settings-navigation')).display"),
            'none',
          );
          await screenshot(theme + '-' + id + '-380.png');
          await click('.settings-back');
          assert.equal(await evaluate('document.activeElement.dataset.settingsCategory'), id);
          assert.deepEqual(await counts(), []);
          assert.equal(await evaluate("!!document.querySelector('.settings-category-body')"), false);
          {
            // Re-enter with a remembered category while narrow: no initial hidden mount or request.
            await click('.conversation-link');
            const before = await evaluate('window.fixture.calls.length');
            await nav('设置');
            assert.equal(await current(), id);
            assert.deepEqual(await counts(), []);
            assert.equal(
              await evaluate(
                `window.fixture.calls.slice(${before}).some(c=>['/api/external/connections','/api/devices','/api/external-agents'].includes(c.path))`,
              ),
              false,
            );
          }
        }
        for (const tab of ['mods', 'skills', 'connections']) {
          await extension(tab);
          await fits();
          assert.equal(await currentExtension(), tab);
          await screenshot(theme + '-extensions-' + tab + '-380.png');
          if (tab === 'connections') await terminalRow(theme, '380');
        }
        win.setContentSize(1280, 800);
        await frame();
        await click('.conversation-link');
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'connections');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          false,
        );
        assert.equal(await evaluate('document.activeElement.getClientRects().length > 0'), true);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await frame();
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] input[type=checkbox]').checked"),
          true,
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot]').classList.contains('is-target')"),
          true,
        );
        await screenshot(theme + '-grok-deep-link.png');
        await click('[data-settings-item=grok-bot] .settings-row-expand');
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          true,
        );
        await click('.conversation-link');
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
      }
      // The same keyboard handler used by the desktop restores the last category.
      await category('advanced');
      await click('.conversation-link');
      await evaluate(
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true,cancelable:true}))",
      );
      await frame();
      assert.equal(await current(), 'advanced');
      assert.equal(await evaluate("localStorage.getItem('pugport-settings-category')"), 'advanced');
      // Text blur and immediate selects use partial settings writes.
      await category('personal');
      await setText('#global-instructions', 'Synthetic instructions');
      await evaluate('window.fixture.holdSettings=true');
      const memorySwitch = '.settings-fields .switch input';
      await pointer(memorySwitch, 'mouseDown');
      assert.equal(await evaluate('document.querySelector(".settings-fields").matches(":disabled")'), false);
      assert.equal(await evaluate(`document.querySelector('${memorySwitch}').matches(':disabled')`), false);
      await pointer(memorySwitch, 'mouseUp');
      assert.equal(await evaluate(`document.querySelector('${memorySwitch}').checked`), true);
      await evaluate('window.fixture.holdSettings=false;window.fixture.releaseSettings()');
      await frame();
      assert.equal(await evaluate('window.fixture.state.settings.memoryDistillation.enabled'), true);
      await category('general');
      assert.equal(
        await evaluate(
          "window.fixture.calls.some(c=>c.path==='/api/settings'&&c.body?.globalInstructions==='Synthetic instructions'&&Object.keys(c.body).length===1)",
        ),
        true,
      );
      await evaluate(
        "document.querySelector('select[aria-label=任务完成通知]').value='never';document.querySelector('select[aria-label=任务完成通知]').dispatchEvent(new Event('change',{bubbles:true}))",
      );
      await frame();
      assert.equal(await evaluate('window.fixture.state.settings.notifyOnFinish'), 'never');
      // Bank and Mod data controls live with installed Mods, not Settings.
      assert.equal(await evaluate("!!document.querySelector('[data-settings-category=data]')"), false);
      assert.equal(await evaluate("!!document.querySelector('[data-settings-item=plaid-keys]')"), false);
      await category('permissions');
      await evaluate(
        "const el=document.querySelector('select[aria-label=工具确认方式]');el.value='auto';el.dispatchEvent(new Event('change',{bubbles:true}))",
      );
      await frame();
      assert.equal(await evaluate("document.querySelector('select[aria-label=工具确认方式]').value"), 'ask');
      assert.deepEqual(await evaluate('window.permissionCalls.at(-1)'), {
        kind: 'settings',
        patch: { toolApprovalMode: 'auto' },
      });
      assert.equal(
        await evaluate("window.fixture.calls.some(c=>c.path==='/api/settings'&&c.body?.toolApprovalMode)"),
        false,
      );
      // Tabbing during the refresh write keeps the next numeric field ready for typing.
      await category('advanced');
      await setText('input[max="600"]', '90');
      await evaluate('window.fixture.holdSettings=true');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await frame();
      assert.equal(await evaluate('document.activeElement.max'), '1800');
      await win.webContents.insertText('91');
      await frame();
      assert.equal(await evaluate('document.activeElement.value'), '91');
      await evaluate('window.fixture.holdSettings=false;window.fixture.releaseSettings()');
      await frame();
      assert.equal(await evaluate('document.activeElement.value'), '91');
      // Emulate the actual media feature, so this verifies the CSS suppression.
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await click('.conversation-link');
      await evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
      );
      await frame();
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
      assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.is-target')).boxShadow"), 'none');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
      await win.loadFile(path.join(fixture, 'index.html'), { query: { view: 'conversation', id: 'chat' } });
      for (
        let i = 0;
        i < 30 &&
        !(await evaluate(
          "!!document.querySelector('.solo-shell .conversation-workspace,.solo-shell .conversation-pane')",
        ));
        i++
      )
        await frame();
      for (const theme of ['light', 'dark']) {
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'connections');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          false,
        );
        assert.equal(await evaluate('document.activeElement.getClientRects().length > 0'), true);
        await screenshot(theme + '-popout.png');
        await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='返回对话').click()");
        await frame();
        assert.equal(await evaluate("!!document.querySelector('.extensions-home')"), false);
      }
      win.setContentSize(380, 800);
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      await nav('\u8bbe\u7f6e');
      await evaluate('window.english()');
      await category('conversation');
      await click(`input[aria-label="${english['自动插话']}"]`);
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.notice-success')")); i++) await frame();
      const switchToast = await evaluate("document.querySelector('.notice-success').textContent");
      assert.ok(switchToast.includes(english['自动插话']), switchToast);
      assert.doesNotMatch(switchToast, /[㐀-鿿]/);
      await screenshot('en-copy-switch-toast-380.png');
      await click('.settings-back');
      for (const theme of ['light', 'dark']) {
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        for (const id of ['devices']) {
          await category(id);
          await evaluate("document.querySelector('.settings-back').style.paddingBlock='20px'");
          await frame();
          await fits();
          assert.equal(await evaluate('document.documentElement.lang'), 'en');
          assert.match(await evaluate("document.querySelector('.settings-header-action').textContent"), /Add/);
          await screenshot(theme + '-' + id + '-380-en.png');
          assert.equal(
            await evaluate(`(()=>{
            const action=document.querySelector('.settings-header-action');
            const back=document.querySelector('.settings-back');
            return action.getBoundingClientRect().top>=back.getBoundingClientRect().bottom;
          })()`),
            true,
          );
          await click('.settings-back');
        }
        await extension('skills');
        assert.equal(await evaluate('document.documentElement.lang'), 'en');
        assert.match(
          await evaluate("document.querySelector('.extensions-heading .settings-header-action').textContent"),
          /Add/,
        );
        await screenshot(theme + '-extensions-skills-380-en.png');
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await fits();
          assert.equal(
            await evaluate(`(()=>{
            const title=document.querySelector('.extensions-heading h1').getBoundingClientRect();
            const action=document.querySelector('.extensions-heading .settings-header-action button').getBoundingClientRect();
            return action.top<title.bottom && action.bottom>title.top && title.right<=action.left &&
              action.left>=0 && action.right<=innerWidth;
          })()`),
            true,
            'Extensions title and action share a row without overlap, and the action is visible',
          );
        }
      }
      win.setContentSize(1280, 800);
      await win.loadFile(path.join(fixture, 'index.html'), { query: { locale: 'zh-CN' } });
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      await nav('设置');
      await category('general');
      await evaluate(
        "history.replaceState(null,'',location.pathname);[...document.querySelectorAll('.language-options button')].find(b=>b.textContent==='English').click()",
      );
      for (
        let i = 0;
        i < 60 &&
        !(await evaluate("document.documentElement.lang==='en' && !!document.querySelector('.project-more')"));
        i++
      )
        await frame();
      assert.equal(await evaluate('document.documentElement.lang'), 'en', 'empty drafts allow the locale reload');
      assert.deepEqual(rendererErrors, []);
      await new Promise((resolve) =>
        process.stdout.write(
          'PASS settings categories renderer: light/dark and narrow screenshots, mount/unmount, deep links, radio keyboard, blur, native cancel and pop-out\n',
          resolve,
        ),
      );
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(1);
    }
  });
}
