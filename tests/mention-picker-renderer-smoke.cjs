// Hidden Workspace renderer with in-memory API mocks: the @@ picker, the 「+」 entry and a message calling several.
// Never opens the desktop app, a native CLI, a website or the network.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const screenshots = process.env.FACT_CHECK_ARTIFACTS ?? path.join(root, 'reports/mention-picker');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-mention-picker-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      // Every stylesheet the app loads, in its order: layout wrappers such as the Mod workspace body live in them.
      const names = (await fs.readFile(path.join(root, 'src/ui/main.tsx'), 'utf8'))
        .split('\n')
        .map((line) => /^import '\.\/([^']+\.css)';/.exec(line)?.[1])
        .filter(Boolean);
      const sheets = await Promise.all(names.map((name) => fs.readFile(path.join(root, 'src/ui', name), 'utf8')));
      await fs.writeFile(path.join(fixture, 'style.css'), sheets.join('\n'));
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationWorkspace } from './src/ui/Workspace';
const stamp='2026-10-11T12:00:00.000Z';
const card=(id,provider,label)=>({id,provider,label,command:'fixture',environment:'native',enabled:true});
localStorage.setItem('pugport.mention-usage', JSON.stringify({'executor:codex-b':{count:6,last:3},'code-review':{count:4,last:5},'external:muse':{count:2,last:4}}));
window.fixture={state:{app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',defaultProjectPath:'C:/Fixture',maxConcurrentRuns:1},targets:[card('claude','claude','Claude · 本机'),card('codex-b','codex','Codex B'),card('grok','grok','Grok · 本机')],runtimes:[],approvals:[],plugins:[],refreshing:false,projects:[{id:'project',name:'Fixture',scope:'chat',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp}],conversations:[{id:'main',projectId:'project',title:'Fixture',createdAt:stamp,updatedAt:stamp}],workflows:[],runs:[],conversationMessages:[]}};
window.calls=[];window.notices=[];
const root=createRoot(document.getElementById('root'));
const api=async(path,body,method)=>{
 window.calls.push({path,body,method});const state=window.fixture.state;
 if(path==='/api/external-agents')return {agents:[
  {id:'muse',name:'Muse',kind:'web',description:'通过 Meta Muse 网页版提问',enabled:true,available:true}]};
 if(path==='/api/devices')return {devices:[{id:'6f9619ff-8b86-4d11-b42d-00c04fc964ff',name:'家里的Ubuntu',address:'home',online:true}]};
 if(path.endsWith('/messages')){const message={id:'sent-'+window.calls.length,conversationId:'main',role:'user',content:body.content,createdAt:stamp};state.conversationMessages.push(message);window.renderFixture();return {message};}
 if(method==='GET')return {messages:state.conversationMessages};
 return {};
};
window.renderFixture=()=>flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={{...window.fixture.state,conversationMessages:[...window.fixture.state.conversationMessages]}} api={api} project={window.fixture.state.projects[0]} conversation={window.fixture.state.conversations[0]} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>));
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, PUGPORT_MENTION_PICKER_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      // Hosted macOS paints offscreen frames slowly and a passing run there takes 40-46 s, so 45 s killed passing runs.
      // Stay under renderer-smoke's 175 s limit so this launcher still cleans up and reports.
      const timeout = setTimeout(() => child.kill(), 150_000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-mention-picker-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_MENTION_PICKER_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-mention-picker-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      console.error('Failed fixture evaluation:', source.slice(0, 200));
      throw error;
    });
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const settle = async () => {
    for (let i = 0; i < 4; i++) await frame();
  };
  const fill = async (value) => {
    await evaluate(
      `(()=>{const input=document.querySelector('#conversation-input');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await settle();
  };
  const key = async (name) => {
    await evaluate(
      `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true}))`,
    );
    await settle();
  };
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const capture = async () => {
    try {
      return await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    } catch (error) {
      // Native resizing can transiently reject a hidden software snapshot.
      if (!String(error).includes('UnknownVizError')) throw error;
      await frame();
      return win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    }
  };
  const shot = async (name) => {
    await settle();
    await fs.writeFile(path.join(screenshots, `${name}.png`), (await capture()).toPNG());
  };
  const theme = (name) => evaluate(`document.documentElement.dataset.theme=${JSON.stringify(name)}`);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  void app.whenReady().then(async () => {
    try {
      await fs.mkdir(screenshots, { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 760,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      // Hidden windows need focus emulation for Chromium's native keyboard focus rings.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await settle();

      const plus = '[aria-label="添加和更多"]';
      const openPlus = async () => {
        await evaluate(`document.querySelector('${plus}').focus()`);
        await press('Enter');
      };
      const menuIndex = () =>
        evaluate(
          `[...document.querySelectorAll('.composer-menu [role^="menuitem"]:not(:disabled)')].indexOf(document.activeElement)`,
        );
      const focusMenuItem = async (label) => {
        const index = await evaluate(
          `[...document.querySelectorAll('.composer-menu [role^="menuitem"]:not(:disabled)')].findIndex(item=>item.textContent.includes(${JSON.stringify(label)}))`,
        );
        assert.ok(index >= 0, `Menu item is available: ${label}`);
        await press('Home');
        for (let at = 0; at < index; at++) await press('Down');
        assert.equal(await menuIndex(), index);
      };
      const inside = (selector) => evaluate(`document.querySelector('${selector}').contains(document.activeElement)`);
      const cycleDialog = async (selector) => {
        assert.equal(await inside(selector), true, 'opening moves focus inside');
        assert.equal(await evaluate(`document.querySelector('${selector}').getAttribute('aria-modal')`), 'true');
        await evaluate(
          `window.focusControls=[...document.querySelector('${selector}').querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el=>el.tabIndex>=0&&!el.matches(':disabled')&&el.getClientRects().length)`,
        );
        await evaluate('window.focusControls.at(-1).focus()');
        await press('Tab');
        assert.equal(await evaluate('document.activeElement===window.focusControls[0]'), true, 'Tab wraps to first');
        await press('Tab', ['shift']);
        assert.equal(
          await evaluate('document.activeElement===window.focusControls.at(-1)'),
          true,
          'Shift+Tab wraps to last',
        );
        await press('Tab', ['shift']);
        assert.equal(await inside(selector), true);
      };
      for (const appearance of ['light', 'dark']) {
        await theme(appearance);
        await evaluate(`document.querySelector('#conversation-input').focus()`);
        await press('Left');
        assert.equal(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'none');
        await shot(`a11y-composer-focus-${appearance}`);
        await openPlus();
        assert.equal(await menuIndex(), 0);
        assert.equal(await evaluate(`document.querySelectorAll('.composer-menu [aria-label]').length`), 0);
        await press('Up');
        const last = await menuIndex();
        assert.equal(
          last,
          await evaluate(`document.querySelectorAll('.composer-menu button:not(:disabled)').length-1`),
        );
        await press('Down');
        assert.equal(await menuIndex(), 0);
        await press('End');
        assert.equal(await menuIndex(), last);
        await press('Home');
        await press('Down');
        assert.equal(await menuIndex(), 1);
        assert.equal(await evaluate(`document.activeElement.matches(':focus-visible')`), true);
        await shot(`a11y-menu-focus-${appearance}`);
        await focusMenuItem('核验模式');
        assert.equal(await evaluate(`document.activeElement.getAttribute('role')`), 'menuitemcheckbox');
        await press('Escape');
        assert.equal(
          await evaluate(`document.activeElement.matches('${plus}') && !document.querySelector('.composer-menu')`),
          true,
        );
        await openPlus();
        await press('Tab');
        assert.equal(
          await evaluate(
            `!document.querySelector('.composer-menu') && document.activeElement!==document.body && !document.activeElement.matches('${plus}')`,
          ),
          true,
          'Tab closes and advances',
        );
        await openPlus();
        await focusMenuItem('时间安排');
        await press('Enter');
        await cycleDialog('.schedule-popover');
        await shot(`a11y-schedule-focus-${appearance}`);
        await press('Escape');
        assert.equal(
          await evaluate(
            `document.activeElement.id==='conversation-input' && !document.querySelector('.schedule-popover')`,
          ),
          true,
          'removed menu trigger falls back to input',
        );
        await evaluate(`document.querySelector('[aria-label="调度选项"]').focus()`);
        await press('Enter');
        await cycleDialog('.route-popover');
        await openPlus();
        assert.equal(
          await evaluate(`!!document.querySelector('.composer-menu') && !document.querySelector('.route-popover')`),
          true,
          'composer popovers do not compete for focus',
        );
        await press('Escape');
        await evaluate(`document.querySelector('[aria-label="调度选项"]').focus()`);
        await press('Enter');
        await evaluate(`document.querySelector('.chip-value').focus()`);
        await press('Down');
        assert.equal(await evaluate(`!!document.querySelector('.chip-menu')`), true);
        await press('Escape');
        assert.equal(
          await evaluate(`!document.querySelector('.chip-menu') && !!document.querySelector('.route-popover')`),
          true,
          'Esc closes only the chip list',
        );
        await shot(`a11y-chip-focus-${appearance}`);
        await evaluate(
          `[...document.querySelectorAll('.route-popover button')].find(el=>el.textContent==='高级' && el.getAttribute('aria-expanded')!=='true')?.click()`,
        );
        await settle();
        // The first hint under 高级 is the task-understanding note (the 省钱 row was removed on purpose).
        assert.match(await text('.route-popover small'), /自动理解任务/);
        assert.equal(await evaluate(`!!document.querySelector('.composer-recovery-choice small')`), true);
        assert.equal(
          await evaluate(
            `!![...document.querySelectorAll('.composer-recovery-choice small')].find(el=>el.textContent==='订阅没有报告剩余额度时，仍然用它运行这一次。')`,
          ),
          true,
        );
        await evaluate(`document.querySelector('.chip-input input').focus()`);
        await press('Left');
        assert.deepEqual(
          await evaluate(
            `(()=>{const input=document.activeElement;return [input.matches(':focus-visible'),getComputedStyle(input).outlineColor,getComputedStyle(input).boxShadow,getComputedStyle(input.closest('.chip-select')).outlineStyle]})()`,
          ),
          [true, 'rgba(0, 0, 0, 0)', 'none', 'solid'],
          'acceptance command has one focus ring on its chip',
        );
        await shot(`a11y-chip-input-focus-${appearance}`);
        await evaluate(
          `[...document.querySelectorAll('.composer-recovery-choice')].at(-1).scrollIntoView({block:'nearest'})`,
        );
        await shot(`a11y-descriptions-${appearance}`);
        win.setSize(420, 760);
        await settle();
        assert.equal(
          await evaluate(
            `(()=>{const p=document.querySelector('.route-popover');const b=p.getBoundingClientRect();return b.top>=0&&b.left>=0&&b.right<=innerWidth&&p.scrollWidth<=p.clientWidth})()`,
          ),
          true,
          'executor options and descriptions fit a narrow window',
        );
        await shot(`a11y-descriptions-${appearance}-narrow`);
        win.setSize(1000, 760);
        await press('Escape');
        assert.equal(await evaluate(`document.activeElement.matches('[aria-label="调度选项"]')`), true);
      }
      // The plus menu opens tier 1 with one @.
      await evaluate(`document.querySelector('[aria-label="添加和更多"]').click()`);
      await settle();
      assert.match(await text('.composer-menu'), /叫一个角色或智能体/);
      assert.doesNotMatch(await text('.composer-menu'), /连接器/);
      for (const theme of ['dark', 'light']) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'`);
        await shot(`plus-menu-${theme}`);
        win.setSize(420, 760);
        await shot(`plus-menu-${theme}-narrow`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        win.setSize(1000, 760);
      }
      await evaluate("document.documentElement.dataset.theme='dark'");
      await evaluate(
        `[...document.querySelectorAll('.composer-menu button')].find(item=>item.textContent.includes('叫一个角色或智能体')).click()`,
      );
      await settle();
      assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), '@');
      let groups = await evaluate(
        `[...document.querySelectorAll('.mention-group')].map(group=>group.getAttribute('aria-label'))`,
      );
      assert.ok(groups.includes('角色') && groups.includes('执行器'));
      assert.ok(!groups.includes('设备') && !groups.includes('外部智能体'));
      assert.doesNotMatch(await text('.mention-group[aria-label="常用"]'), /Muse/);
      assert.deepEqual(groups, ['常用', '角色', '执行器']);
      await shot('picker-tier1-dark');
      await theme('light');
      await shot('picker-tier1-light');
      // Up from the top wraps to the last row, and the list scrolls to keep it in sight; down comes back.
      await key('ArrowUp');
      const inSight = await evaluate(
        `(()=>{const menu=document.querySelector('.mention-menu').getBoundingClientRect();const row=document.querySelector('.mention-row[aria-selected="true"]').getBoundingClientRect();return row.top>=menu.top-1&&row.bottom<=menu.bottom+1&&document.querySelector('.mention-menu').scrollTop>0;})()`,
      );
      assert.ok(inSight, 'the active row scrolls into view');
      await key('ArrowDown');
      // Keyboard: down past the end of 常用 into 角色, Enter picks it.
      await key('ArrowDown');
      await key('ArrowDown');
      await key('ArrowDown');
      assert.equal(
        await evaluate(
          `document.querySelector('.mention-row[aria-selected="true"]').closest('.mention-group').getAttribute('aria-label')`,
        ),
        '角色',
      );
      const keyboardPicked = await evaluate(
        `document.querySelector('.mention-row[aria-selected="true"] strong').textContent`,
      );
      await key('Enter');
      assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), `@${keyboardPicked} `);

      // A second call after Chinese punctuation; the first is marked and not offered again.
      await fill(`@${keyboardPicked} 先列出风险，@`);
      assert.equal(await evaluate(`document.querySelectorAll('.mention-row.called').length`), 1);
      assert.match(await text('.mention-row.called'), /已叫/);
      await theme('dark');
      await evaluate(`document.querySelector('.mention-row.called').scrollIntoView({block:'center'})`);
      await shot('picker-called-dark');
      await fill(`@${keyboardPicked} 先列出风险，@co`);
      assert.deepEqual(
        await evaluate(`[...document.querySelectorAll('.mention-group')].map(group=>group.getAttribute('aria-label'))`),
        ['常用'],
        'typing filters every group; empty groups hide',
      );
      await shot('picker-filtered-dark');
      await fill('');

      // A second @ switches tiers and keeps its prefix when selecting a device.
      await fill('@@');
      groups = await evaluate(
        `[...document.querySelectorAll('.mention-group')].map(group=>group.getAttribute('aria-label'))`,
      );
      assert.ok(groups.includes('设备'));
      assert.ok(!groups.includes('角色') && !groups.includes('执行器'));
      assert.match(await text('.mention-menu'), /Muse/);
      assert.doesNotMatch(await text('.mention-menu'), /Codex B|代码审查/);
      await shot('picker-tier2-dark');
      await evaluate(
        `[...document.querySelectorAll('.mention-row')].find(row=>row.textContent.includes('家里的Ubuntu')).click()`,
      );
      await settle();
      const deviceValue = await evaluate(`document.querySelector('#conversation-input').value`);
      assert.equal(deviceValue, '@@家里的Ubuntu ');
      await fill(`${deviceValue}跑一下`);
      assert.match(await text('.composer-tag.mention'), /家里的Ubuntu/);
      await fill('@家里的Ubuntu 跑一下');
      assert.equal(await evaluate(`document.querySelectorAll('.composer-tag.mention').length`), 0);

      // Pick a role and an executor, then send them together.
      await fill('@');
      await evaluate(`document.querySelector('.mention-group[aria-label="角色"] .mention-row').click()`);
      await settle();
      const first = await evaluate(`document.querySelector('#conversation-input').value`);
      const picked = first.trim().slice(1);
      await fill(`${first}先列出风险，@co`);
      await evaluate(
        `[...document.querySelectorAll('.mention-row')].find(row=>row.textContent.includes('Codex B')).click()`,
      );
      await settle();
      const value = await evaluate(`document.querySelector('#conversation-input').value`);
      assert.equal(value, `@${picked} 先列出风险，@Codex B `);
      await fill(`${value}再改代码`);
      assert.equal(await evaluate(`document.querySelectorAll('.composer-tag.mention').length`), 2);
      await shot('composer-tags-dark');
      await theme('light');
      await shot('composer-tags-light');

      // A narrow window: the list spans the composer.
      win.setSize(420, 760);
      await theme('dark');
      await fill(`${value}再改代码 @@`);
      await shot('picker-narrow-dark');
      const box = await evaluate(
        `(()=>{const menu=document.querySelector('.mention-menu').getBoundingClientRect();return {left:menu.left,right:menu.right,top:menu.top,width:window.innerWidth};})()`,
      );
      assert.ok(
        box.left >= 0 && box.right <= box.width && box.top >= 0,
        `the list stays inside the window: ${JSON.stringify(box)}`,
      );
      await key('Escape');
      assert.equal(await evaluate(`document.querySelector('.mention-menu')`), null);

      // Sending: one coordinated message with both, in the order picked.
      await fill(`${value}再改代码`);
      await key('Enter');
      await settle();
      const sent = await evaluate(`window.calls.filter(call=>call.path.endsWith('/messages')).map(call=>call.body)`);
      assert.equal(sent.length, 1);
      assert.deepEqual(
        sent[0].participants.map((item) => item.kind),
        ['role', 'executor'],
      );
      assert.equal(sent[0].participants[1].id, 'codex-b');
      assert.equal(sent[0].runtimeId, undefined);
      await evaluate(
        `window.fixture.state.targets.push({id:'api-ollama',provider:'pi',label:'Ollama',command:'fixture',environment:'native',enabled:true,gateway:'api',apiProvider:'ollama'});window.renderFixture()`,
      );
      await fill('@免费');
      assert.equal(await text('.mention-row strong'), '免费');
      assert.equal(await evaluate(`!!document.querySelector('.mention-row svg')`), true);
      await shot('free-chain-picker-dark');
      await theme('light');
      await shot('free-chain-picker-light');
      await key('Enter');
      await fill('@免费 Say hello');
      await key('Enter');
      await settle();
      const freeSent = await evaluate(`window.calls.filter(call=>call.path.endsWith('/messages')).at(-1).body`);
      assert.equal(freeSent.freeChain, true);
      assert.equal(freeSent.runtimeId, undefined);
      assert.equal(freeSent.participants, undefined);
      await evaluate(`window.fixture.state.targets.at(-1).enabled=false;window.renderFixture()`);
      await fill('@免费');
      assert.equal(await evaluate(`document.querySelectorAll('.mention-row').length`), 0);
      console.log(`mention picker smoke passed; screenshots in ${screenshots}`);
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
