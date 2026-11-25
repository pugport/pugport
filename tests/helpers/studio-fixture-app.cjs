'use strict';

// The shared half of the Studio renderer checks: the real Studio in a hidden Electron window, with synthetic
// fetch/SSE only. A check script calls launchStudioFixture() from Node and openStudioFixture() inside Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./electron-app.cjs');

const root = path.resolve(__dirname, '../..');
const FIXTURE_ENV = 'PUGPORT_STUDIO_FIXTURE';

/**
 * Node side. Builds the Studio fixture page in a temporary folder named after `name`, runs `script` in Electron
 * against it, sets the exit code from that run and removes the folder.
 */
function launchStudioFixture({ script, name }) {
  const prefix = 'pugport-' + name + '-';
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: require('fs')
            .readFileSync(path.join(root, 'src/ui/main.tsx'), 'utf8')
            .split('\n')
            .filter((line) => /^import ['"].*(?:css|fontsource).*['"];/.test(line))
            .map((line) => '@import ' + line.slice(7))
            .join('\n'),
          resolveDir: path.join(root, 'src/ui'),
          loader: 'css',
        },
        bundle: true,
        outfile: path.join(fixture, 'style.css'),
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
      });
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {ImageViewer} from './src/ui/ImageViewer';
window.previewImage=()=>{const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const close=()=>{root.unmount();host.remove()};const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440"><rect width="720" height="440" fill="#85b8b0"/><circle cx="360" cy="190" r="90" fill="#f3ead8"/><path d="M0 440L240 240L420 440L600 290L720 440" fill="#325d66"/></svg>');root.render(<ImageViewer images={[{src,name:'Synthetic landscape.svg'}]} index={0} onIndex={()=>{}} onClose={close}/>);};
import {startInterfaceLanguage} from './src/ui/i18n';
window.english=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
import { extensionCatalog } from './src/shared/extensions';
const stamp='2026-10-13T20:00:00.000Z';
const project={id:'project',name:'示例项目',path:'C:/Synthetic',createdAt:stamp,updatedAt:stamp};
const chat={id:'chat',projectId:'project',title:'示例对话',createdAt:stamp,updatedAt:stamp};
localStorage.setItem('agent-studio-conversation','chat');
localStorage.setItem('agent-studio-project','project');
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale') || localStorage.getItem('comborunner.locale') || 'zh-CN');
window.fixture={calls:[],state:{app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},
settings:{designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',automaticExecutors:['claude'],toolApprovalMode:'ask',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,defaultProjectPath:'C:/Synthetic',maxConcurrentRuns:1},
targets:[{id:'claude',provider:'claude',label:'Anthropic',enabled:true,command:'fixture',environment:'native'}],runtimes:[{id:'claude',provider:'claude',label:'Anthropic',status:'ready',models:[{id:'opus',label:'Opus 5.5',efforts:['high','max']},{id:'sonnet',label:'Sonnet 5.5',efforts:['high']},...Array.from({length:16},(_,i)=>({id:'synthetic-'+i,label:'Synthetic model '+i,efforts:[]}))]}],runs:[],approvals:[],plugins:[],refreshing:false,projects:[project],removedProjects:[],conversations:[chat],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]}};
const f=window.fixture;
const originalInterval=window.setInterval, originalClear=window.clearInterval;
window.activeIntervals=new Map();
window.setInterval=(fn,ms,...args)=>{ const id=originalInterval(fn,ms,...args);window.activeIntervals.set(id,ms);if(ms===4000)window.pollSlack=fn;return id; };
window.clearInterval=id=>{window.activeIntervals.delete(id);originalClear(id);};
window.permissionCalls=[];window.allowPermission=false;
window.comboRunnerDesktop={pickDirectory:async()=>null,launchAtLogin:async(value)=>value??false,blackout:async()=>{},blackoutShortcut:async(value)=>({shortcut:value??'Ctrl+Alt+B',registered:true}),quickChatSettings:async(patch)=>({enabled:true,shortcut:'Alt+Space',target:'everyday',registered:true,...patch}),changePermission:async change=>{window.permissionCalls.push(change);return window.allowPermission;}};
const grokMessage={id:'grok-reply',conversationId:'chat',role:'assistant',content:'Grok Bot 需要设置例程。',createdAt:stamp,externalAgent:{agentId:'grok-bot',name:'Grok Bot',status:'needs-user',handoff:true,untrusted:true,request:'Synthetic',updatedAt:stamp}};
f.state.conversationMessages=JSON.parse(localStorage.getItem('batch1a-preview') || 'null') ?? [grokMessage];
f.models=f.state.runtimes[0].models;
window.broadcast=()=>f.listeners.state({data:JSON.stringify(f.state)});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';f.calls.push({path:url,method,body:init.body?JSON.parse(init.body):undefined});
 if(url==='/api/settings' && method==='PATCH'){if(f.holdSettings)await new Promise(done=>f.releaseSettings=done);Object.assign(f.state.settings,JSON.parse(init.body));return response({});}
 if(url==='/api/laya/status')return response({settings:f.state.settings.laya||{},status:{state:'disabled',modelVersion:'pugport-laya-v4'},training:{directory:'C:/Synthetic/routing-training',recording:f.state.settings.laya?.recordTraining!==false}});
 if(url==='/api/app-info')return response({paths:{dataDir:'C:/Synthetic',memoryDir:'C:/Synthetic/memory'},tools:{}});
 if(url==='/api/web-search')return response({provider:'deepseek',enabled:false,configured:false,monthlyLimitCny:5,month:'2026-10',usage:{requests:0,billableRequests:0,uncertainRequests:0,estimatedCostCny:0,reservedCny:0}});
 if(url==='/api/session')return response({token:'synthetic'});
 if(url==='/api/sandbox/learning')return response([]);
 if(url.includes('archived-conversations') || url.includes('deleted-conversations') || url.includes('scheduled-tasks'))return response([]);
 if(url==='/api/state')return response(f.state);
 if(url==='/api/external-agents' && f.agentsError)return new Response(JSON.stringify({error:'Synthetic offline'}),{status:503,headers:{'Content-Type':'application/json'}});
 if(url==='/api/external-agents')return response({agents:[
 {id:'grok-bot',name:'Grok Bot',kind:'handoff',description:'发给 Grok Bot，回复后回来粘贴',enabled:true,available:true,routine:{url:'https://synthetic.invalid/routine'}},
 {id:'muse',name:'Muse',kind:'web',description:'',enabled:false,available:false,url:'https://synthetic.invalid'}]});
 if(url==='/api/external/connections')return response({tools:[{id:'codex',name:'Codex',detected:true,state:'connected',method:'file',configPath:'/synthetic/config.toml',server:'pugport',manual:'synthetic'}],snippet:'synthetic'});
 if(url==='/api/external/terminal-command') {
  if(f.holdTerminal)await new Promise(done=>f.releaseTerminal=done);
  if(f.terminalError)return new Response(JSON.stringify({error:'Synthetic PATH denied'}),{status:500,headers:{'Content-Type':'application/json'}});
  if(method==='POST')f.terminalInstalled=true;
  if(method==='DELETE')f.terminalInstalled=false;
  return response({folder:'C:/Synthetic/PugPort/dist/bin',automatic:!f.manualTerminal,manualLine:f.manualTerminal?'fish_add_path -- /synthetic/PugPort/dist/bin':undefined,installed:!!f.terminalInstalled});
 }
 if(url==='/api/slack'){
  if(f.slackHttpError)return new Response(JSON.stringify({...f.slack,error:'Synthetic request failed'}),{status:503,headers:{'Content-Type':'application/json'}});
  if(method==='PATCH')Object.assign(f.slack,JSON.parse(init.body));
  return response(f.slack || {enabled:false,status:'off',users:[],activeTasks:0});
 }
 if(url.startsWith('/api/slack/users/') && method==='DELETE'){f.slack.users=[];return response(f.slack);}
 if(url.startsWith('/api/devices'))return response({devices:[{id:'mac-build',name:'Mac 构建机',address:'synthetic.invalid',pairedAt:stamp,platform:'darwin',online:true,executors:[]},{id:'linux-home',name:'家里的电脑',address:'synthetic.invalid',pairedAt:stamp,online:false,reason:'设备未连接'}],slackHost:null});
 if(url==='/api/extensions' || url.startsWith('/api/extensions?'))return response({items:[],catalog:extensionCatalog});
 if(url==='/api/modes')return response({catalog:[{id:'example.finance',title:'个人财务',permissions:['connections:read']}],installed:[]});
 if(url==='/api/bank/settings')return response({configured:true,environment:'sandbox',clientIdEnding:'0001',sandboxSecret:true,productionSecret:false});
 if(url==='/api/bank/connections')return response({connections:[
  {id:'conn_synthetic01',provider:'plaid',environment:'sandbox',institution:{id:'ins_1',name:'Synthetic Credit Union'},status:'connected',lastSyncedAt:stamp,products:['transactions','liabilities'],modIds:['example.finance']},
  {id:'conn_synthetic02',provider:'plaid',environment:'sandbox',institution:{id:'ins_2',name:'Synthetic Card Bank'},status:'reauth_required',lastSyncedAt:stamp,error:{code:'ITEM_LOGIN_REQUIRED',message:'The bank needs you to sign in again.'},products:['transactions'],modIds:[]}]});
 if(url==='/api/mod-data')return response({mods:[{modId:'example.finance',items:1840,bytes:2400000}]});
 if(url==='/api/tool-installations')return response({installations:[]});
 if(url==='/api/slack/admission' || url==='/api/github/admission')return response({version:1,rules:[]});
 if(url==='/api/conversations/chat')return response({conversation:chat,messages:f.state.conversationMessages,workflows:[],runs:[]});
 return response({});
};
window.EventSource=class {constructor(){f.listeners={}}addEventListener(name,fn){f.listeners[name]=fn}close(){}};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<><Studio/><ConfirmDialogHost/></>));
`,
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, [FIXTURE_ENV]: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(script), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      const timer = setTimeout(() => child.kill(), 120000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith(prefix));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/**
 * Electron side. Opens the fixture page in a hidden window and resolves with the window and its page helpers once
 * the Studio has mounted. The caller runs its checks and ends the process with `app.exit`. When the window cannot
 * be opened this prints the error and exits 1 itself.
 */
function openStudioFixture() {
  // 'electron/main', not 'electron': from this folder the bare name can resolve to the npm package's path (see
  // electron-loader.cjs).
  const { app, BrowserWindow } = require('electron/main');
  const fixture = process.env[FIXTURE_ENV];
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', (event) => event.preventDefault());
  return app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        useContentSize: true,
        width: 1200,
        height: 820,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.setFrameRate(240);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      const rendererErrors = [];
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 3) {
          rendererErrors.push(event.message);
          console.error(event.message);
        }
      });
      const evaluate = (source) =>
        win.webContents.executeJavaScript(source).catch((error) => {
          console.error(source);
          throw error;
        });
      const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const click = async (selector) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));})()`,
        );
        await frame();
      };
      const pointer = async (selector, type) => {
        const point = await evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
        );
        win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
        await frame();
      };
      const screenshotsDir = path.join(
        root,
        process.env.PUGPORT_UI_SIMPLIFY_B ? 'artifacts/ui-simplify-b' : 'reports/settings-categories',
      );
      let captured = false;
      const screenshot = async (name) => {
        await frame();
        const expected = { width: win.getContentBounds().width, height: 800 };
        if (!process.env.PUGPORT_SETTINGS_SCREENSHOTS && captured) {
          let size = await evaluate('({width:innerWidth,height:innerHeight})');
          for (
            let attempt = 0;
            attempt < 15 && (size.width !== expected.width || size.height !== expected.height);
            attempt++
          ) {
            await frame();
            size = await evaluate('({width:innerWidth,height:innerHeight})');
          }
          assert.deepEqual(size, expected);
          return;
        }
        // Repaint the whole hidden window; partial offscreen paints can omit unchanged controls.
        win.webContents.invalidate();
        if (process.env.PUGPORT_UI_SIMPLIFY_B) await new Promise((resolve) => setTimeout(resolve, 150));
        let capture = await win.webContents.capturePage();
        for (
          let attempt = 0;
          attempt < 15 && (capture.getSize().width !== expected.width || capture.getSize().height !== expected.height);
          attempt++
        ) {
          win.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 20));
          capture = await win.webContents.capturePage();
        }
        assert.deepEqual(capture.getSize(), expected);
        captured = true;
        if (process.env.PUGPORT_SETTINGS_SCREENSHOTS) {
          await fs.mkdir(screenshotsDir, { recursive: true });
          await fs.writeFile(path.join(screenshotsDir, name), capture.toPNG());
        }
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (let i = 0; i < 20 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      const nav = async (label) => {
        await evaluate(
          "[...document.querySelectorAll('.sidebar-tools button')].find(b=>b.textContent===" +
            JSON.stringify(label) +
            ').click()',
        );
        await frame();
      };
      const fits = async () => assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      const category = async (id) => {
        if (!(await evaluate("!!document.querySelector('.settings-shell')"))) {
          await evaluate("document.querySelector('.sidebar-tools button:last-child').click()");
          await frame();
        }
        await click('[data-settings-category="' + id + '"]');
        await evaluate("document.querySelector('.management-main').scrollTop = 0");
        await frame();
        if (id === 'devices') {
          assert.equal(
            await evaluate(`(()=>{
              const heading=document.querySelector('.settings-category-heading');
              const action=document.querySelector('.settings-header-action .external-agent-head > button');
              const group=document.querySelector('.settings-content .settings-group');
              return heading.contains(action) && action.getBoundingClientRect().top>=heading.getBoundingClientRect().top && action.getBoundingClientRect().bottom<=heading.getBoundingClientRect().bottom && group.getBoundingClientRect().top>=heading.getBoundingClientRect().bottom;
            })()`),
            true,
            'add control shares the category heading row, above the groups',
          );
        }
      };
      return { app, win, fixture, rendererErrors, evaluate, frame, click, pointer, screenshot, nav, fits, category };
    } catch (error) {
      console.error(error);
      app.exit(1);
      return new Promise(() => {});
    }
  });
}

module.exports = { launchStudioFixture, openStudioFixture };
