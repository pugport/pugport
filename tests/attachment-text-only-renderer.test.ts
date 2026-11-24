import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from '../src/server/platform/test-process.ts';
import { build } from 'esbuild';
import express from 'express';
import { listenForFetch } from './helpers/fetch-port.ts';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'composer names a text-only agent before an explicit, inferred or mixed message with a file goes out',
  { timeout: 60000 },
  async (t) => {
    const root = process.cwd(),
      fixture = await mkdtemp(join(tmpdir(), 'pugport-text-only-renderer-'));
    const artifacts = resolve('artifacts/composer-text-only');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationWorkspace} from './src/ui/Workspace';
import {ComposerSession} from './src/ui/composer-session';
import {startInterfaceLanguage} from './src/ui/i18n';
import './src/ui/studio.css';
import './src/ui/composer.css';
import './src/ui/mods/mods.css';
import './src/ui/ConversationModeView.css';
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale')||'zh-CN');
const stamp='2026-11-21T12:00:00Z';
const project={id:'project',name:'Synthetic project',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:'chat',projectId:'project',title:'附件预检',routingProfileId:null,createdAt:stamp,updatedAt:stamp};
const state={app:{name:'Fixture',version:'test',platform:'darwin',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],conversations:[conversation],targets:[],runtimes:[],runs:[],workflows:[],approvals:[],plugins:[],conversationMessages:[]};
const muse={id:'muse',name:'Muse',kind:'web',description:'Synthetic',added:true,enabled:true,available:true};
window.notices=[];window.requests=[];window.agentReads=0;
const api=async(path,body)=>{
 if(body instanceof File)return {id:crypto.randomUUID(),name:body.name,mimeType:body.type,size:body.size,kind:'image'};
 if(path==='/api/external-agents'){window.agentReads++;return {agents:[muse]};}
 if(path.endsWith('/messages')&&body){window.requests.push(body);return {message:{id:'sent-'+window.requests.length,conversationId:conversation.id,role:'user',content:body.content,createdAt:stamp}};}
 return {messages:[],workflows:[]};
};
const session=new ComposerSession();
const scope='conversation:'+conversation.id;
window.draft=()=>session.getSnapshot().drafts[scope];
window.setDraft=(content,called)=>session.changeDraft(scope,()=>({content,attachments:[],quotes:[],...(called?{called}:{})}));
window.addImage=async()=>{
 const canvas=new OffscreenCanvas(80,60);canvas.getContext('2d').fillStyle='#3686bb';canvas.getContext('2d').fillRect(0,0,80,60);
 const transfer=new DataTransfer();transfer.items.add(new File([await canvas.convertToBlob({type:'image/png'})],'screenshot.png',{type:'image/png'}));
 const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
};
void startInterfaceLanguage().then(()=>{window.languageReady=true;});
createRoot(document.getElementById('root')).render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} composerSession={session} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>);
`,
      },
      bundle: true,
      outfile: join(fixture, 'fixture.js'),
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    const app = express();
    app.use(express.static(fixture));
    const server = await listenForFetch(app);
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1040,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith(${JSON.stringify(base)})&&!details.url.startsWith('blob:')&&!details.url.startsWith('data:')}));
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  // Offscreen paint already supplies the frame; capturePage races Chromium's copy-output surface after resize.
  const paint=()=>new Promise(resolve=>{win.webContents.once('paint',(_event,_dirty,image)=>resolve(image));win.webContents.invalidate();});
  const shot=async name=>{
   // A theme change fades the buttons; wait for it, or they are caught halfway.
   await evaluate('Promise.all(document.getAnimations().map(animation=>animation.finished))');
   const expected=await evaluate('({width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio),rgb:getComputedStyle(document.documentElement).backgroundColor.match(/[0-9]+/g).slice(0,3).map(Number)})');
   for(let attempt=0;attempt<20;attempt++){
    await frame();const image=await paint(),size=image.getSize();
    if(size.width===expected.width&&size.height===expected.height&&image.toBitmap().subarray(0,3).equals(Buffer.from(expected.rgb).reverse()))
     return fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),image.toPNG());
   }
   throw Error('Offscreen frame did not reach the requested size and theme');
  };
  const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+expression);};
  const text=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent.trim()');
  const enter=()=>evaluate('document.querySelector("#conversation-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  const prepare=async(content,called)=>{
   await evaluate('window.setDraft('+JSON.stringify(content)+','+JSON.stringify(called)+');window.addImage()');
   await wait('document.querySelector(".attachment-chip-preview img")?.naturalWidth>0');
  };
  const muse={kind:'external',id:'muse',name:'Muse'},codex={kind:'executor',id:'codex',name:'Codex'};
  const explicitNote='Muse 只能收文字，收不到附件。要发附件，请换个参与者。';

  await win.loadURL(${JSON.stringify(base)});
  await wait('window.languageReady && !!document.querySelector("#conversation-input")');
  // Explicit: the agent picked from the @@ list. Enter is refused, the draft and its file stay.
  await prepare('@@Muse 这张图里是什么？',[muse]);
  await wait('!!document.querySelector(".attachment-text-only")');
  assert.equal(await text('.attachment-text-only > span'),explicitNote);
  assert.equal(await text('.attachment-text-only button'),'只把文字发给 Muse');
  for(const theme of ['light','dark'])for(const width of [1040,380]){
   win.setSize(width,760);await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   await shot('explicit-'+theme+'-'+width);
  }
  win.setSize(1040,760);await evaluate('document.documentElement.dataset.theme="light"');
  await enter();await frame();
  assert.equal(await evaluate('window.requests.length'),0);
  assert.deepEqual(await evaluate('window.notices.at(-1)'),{tone:'error',message:'{0} 只能收文字，收不到附件。要发附件，请换个参与者。',names:['Muse']});
  assert.equal(await evaluate('window.draft().attachments.length+":"+window.draft().content'),'1:@@Muse 这张图里是什么？');
  // A text-only handoff sends the words to the agent and leaves the file behind.
  await evaluate('document.querySelector(".attachment-text-only button").click()');
  await wait('window.requests.length===1');
  const explicit=await evaluate('window.requests[0]');
  assert.equal(explicit.externalAgentId,'muse');assert.equal(explicit.content,'@@Muse 这张图里是什么？');
  assert.equal('attachmentIds' in explicit,false);

  // Inferred: a leading request to a ready agent goes to it, so the same choice comes first.
  await prepare('让 Muse 解释这张图里的文字');
  await wait('window.agentReads>0 && !!document.querySelector(".attachment-text-only")');
  assert.equal(await text('.attachment-text-only > span'),explicitNote);
  await evaluate('document.querySelector(".attachment-text-only button").click()');
  await wait('window.requests.length===2');
  const inferred=await evaluate('window.requests[1]');
  assert.equal(inferred.content,'让 Muse 解释这张图里的文字');
  assert.equal('attachmentIds' in inferred||'externalAgentId' in inferred||'participants' in inferred,false);

  // Mixed: a note only; Enter sends as before, the executor keeps the file and the agent gets the words.
  await prepare('@Codex @@Muse 各自看看这张图',[codex,muse]);
  await wait('!!document.querySelector(".attachment-text-only")');
  assert.equal(await text('.attachment-text-only > span'),'Muse 只能收文字，收不到附件；其他参与者照常可以用附件。');
  assert.equal(await evaluate('!!document.querySelector(".attachment-text-only button")'),false);
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('mixed-'+theme+'-1040');}
  await evaluate('document.documentElement.dataset.theme="light"');
  const notices=await evaluate('window.notices.length');
  await enter();await wait('window.requests.length===3');
  assert.equal(await evaluate('window.notices.length'),notices);
  const mixed=await evaluate('window.requests[2]');
  assert.equal(mixed.attachmentIds.length,1);
  assert.deepEqual(mixed.participants,[{kind:'executor',id:'codex'},{kind:'external',id:'muse'}]);

  // File-capable: no note, Enter sends the file as before.
  await prepare('看看这张图');
  assert.equal(await evaluate('!!document.querySelector(".attachment-text-only")'),false);
  await enter();await wait('window.requests.length===4');
  assert.equal(await evaluate('window.requests[3].attachmentIds.length'),1);

  // English copy, as the glossary words it.
  await win.loadURL(${JSON.stringify(base)}+'/?locale=en');
  await wait('window.languageReady && !!document.querySelector("#conversation-input")');
  await prepare('@@Muse 这张图里是什么？',[muse]);
  await wait('!!document.querySelector(".attachment-text-only")');
  assert.equal(await text('.attachment-text-only > span'),'Muse can only receive text, not attachments. To send the attachments, choose another participant.');
  assert.equal(await text('.attachment-text-only button'),'Send only the text to Muse');
  await shot('explicit-en-light-1040');
  await prepare('@Codex @@Muse 各自看看这张图',[codex,muse]);
  await wait('document.querySelector(".attachment-text-only > span")?.textContent.includes("other participants")');
  assert.equal(await text('.attachment-text-only > span'),'Muse can only receive text, not attachments. The other participants can still use them.');
  await shot('mixed-en-light-1040');
  console.log('PASS: explicit, inferred, mixed and file-capable sends; 8 screenshots');
 }catch(error){console.error(error.stack||String(error));process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
    );
    const require = createRequire(import.meta.url),
      environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill(), 50000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS: explicit, inferred, mixed and file-capable/);
    } finally {
      clearTimeout(timer);
    }
  },
);
