// Real Studio conversation captures in a hidden Electron window, with synthetic fetch/SSE only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchStudioFixture, openStudioFixture } = require('./helpers/studio-fixture-app.cjs');
const root = path.resolve(__dirname, '..');
const english = require(path.join(root, 'src/shared/i18n/en.json'));
if (!process.versions.electron) launchStudioFixture({ script: __filename, name: 'conversation-screenshots' });
else {
  void openStudioFixture().then(async (studio) => {
    const { app, win, fixture, rendererErrors, evaluate, frame, click, screenshot, nav, fits, category } = studio;
    try {
      // Batch 1a: the real Studio, with synthetic messages and an isolated clipboard.
      for (const locale of ['zh-CN', 'en']) {
        for (const theme of ['light', 'dark']) {
          for (const width of [1280, 380]) {
            win.setContentSize(width, 800);
            await evaluate(`(()=>{
              const stamp='2026-10-15T12:00:00.000Z';
              const en=${JSON.stringify(locale)}==='en';
              const message=(id,role,content)=>({id,role,content,conversationId:'chat',createdAt:stamp});
              const messages=[
                message('design-user','user',en?'Please review this layout.':'请检查这个布局。'),
                message('design-reply','assistant',(en?'The layout is ready.':'布局已准备好。')+'\\n\\n'+
                  '~~~ts\\nconst width = 380;\\n~~~\\n\\n'+(en?'| Width | Result |\\n|---|---|\\n| 1280 | Ready |\\n| 380 | Ready |':'| 宽度 | 结果 |\\n|---|---|\\n| 1280 | 就绪 |\\n| 380 | 就绪 |')),
                {...message('design-review','assistant',en?'The controls and reading surface are clear.':'控件和阅读区域清晰。'),externalAgent:{agentId:'muse',name:en?'Review assistant':'审查助手',status:'completed',updatedAt:stamp}}
              ];
              localStorage.setItem('batch1a-preview',JSON.stringify(messages));
            })()`);
            await win.loadFile(path.join(fixture, 'index.html'), { query: { locale } });
            for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++)
              await frame();
            await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
            await evaluate(`(()=>{
              window.codeCopies=[];
              Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.failCopy)throw Error('synthetic denied');window.codeCopies.push(value)}}});
            })()`);
            await frame();
            await click('.conversation-link');
            if (locale === 'en') {
              await frame();
              assert.equal(
                await evaluate("document.querySelector('.conversation-composer textarea').placeholder"),
                english['想做什么？'],
              );
            }
            for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.message-code-head')")); i++)
              await frame();
            await evaluate("document.querySelector('.conversation-scroll').scrollTop=0");
            const prefix = 'batch1a-' + locale + '-' + theme + '-' + width;
            await fits();
            assert.equal(await evaluate("!!document.querySelector('.participant-card')"), true);
            assert.equal(
              await evaluate("getComputedStyle(document.querySelector('.participant-card')).borderLeftWidth"),
              '1px',
            );
            assert.equal(
              await evaluate("document.querySelector('.message-code-head button').textContent"),
              locale === 'en' ? 'Copy' : '复制',
            );
            await screenshot(prefix + '-conversation.png');
            await click('.conversation-message.message-user button:has(.lucide-pencil)');
            assert.ok(
              await evaluate(
                `(()=>{const editor=document.querySelector('.sent-message-editor');return Math.abs(editor.getBoundingClientRect().width-editor.parentElement.clientWidth)<2})()`,
              ),
              'sent editor fills the message width',
            );
            await screenshot(prefix + '-sent-edit.png');
            await click('.sent-message-editor button[type=button]');
            if (locale === 'en' && theme === 'light' && width === 1280) {
              await evaluate('window.previewImage()');
              await frame();
              assert.equal(
                await evaluate("getComputedStyle(document.querySelector('.image-viewer')).backgroundColor"),
                'rgba(0, 0, 0, 0.86)',
              );
              await screenshot(prefix + '-image-viewer.png');
              await click('.image-viewer-close');
            }

            await evaluate("document.querySelector('.conversation-scroll').scrollTop=9999");
            await screenshot(prefix + '-conversation-detail.png');
            await click('.message-code-head button');
            assert.deepEqual(await evaluate('window.codeCopies'), ['const width = 380;']);
            assert.equal(
              await evaluate("document.querySelector('.message-code-head button').textContent"),
              locale === 'en' ? 'Copied' : '已复制',
            );
            if (locale === 'en' && theme === 'light' && width === 1280) {
              const resetDeadline = Date.now() + 5000;
              while (
                Date.now() < resetDeadline &&
                (await evaluate("document.querySelector('.message-code-head button').textContent")) !== 'Copy'
              )
                await frame();
              assert.equal(await evaluate("document.querySelector('.message-code-head button').textContent"), 'Copy');
            }
            await evaluate('window.failCopy=true');
            await click('.message-code-head button');
            assert.match(
              await evaluate("document.querySelector('.notice-error').textContent"),
              locale === 'en' ? /Couldn't copy/ : /无法复制/,
            );
            await click('.notice-error button');
            await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})");
            await click('.message-code-head button');
            assert.equal(await evaluate("!!document.querySelector('.notice-error')"), true);
            await click('.notice-error button');
            if (width === 380) await evaluate("document.querySelector('.studio-sidebar').classList.add('mobile-open')");
            await screenshot(prefix + '-sidebar.png');
            if (width === 380)
              await evaluate("document.querySelector('.studio-sidebar').classList.remove('mobile-open')");
            await nav(locale === 'en' ? 'Settings' : '设置');
            for (const id of ['general', 'conversation']) {
              await category(id);
              await fits();
              if (locale === 'en' && id === 'conversation') {
                assert.equal(
                  await evaluate(`(()=>{
                  const select=document.querySelector('select[aria-label="${english['发送快捷键']}"]');
                  const style=getComputedStyle(select), context=document.createElement('canvas').getContext('2d');
                  context.font=style.font;
                  return [...select.options].every(option=>context.measureText(option.textContent).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)<=select.getBoundingClientRect().width);
                })()`),
                  true,
                  'send shortcut labels fit without clipping',
                );
                const headings = await evaluate(
                  "[...document.querySelectorAll('.settings-content h2')].map(e=>e.textContent)",
                );
                assert.equal(new Set(headings).size, headings.length, 'chat settings headings are distinct');
              }
              await screenshot(prefix + '-settings-' + id + '.png');
              if (width === 380) await click('.settings-back');
            }
          }
        }
      }
      assert.deepEqual(rendererErrors, []);
      await new Promise((resolve) =>
        process.stdout.write('PASS conversation screenshots renderer: locale, theme and size matrix passed\n', resolve),
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
