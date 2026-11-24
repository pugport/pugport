import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('hidden turn states, disclosures, inspector, motion and localized screenshots', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thinking-row-'));
  const screenshots = resolve('.oil-ui/thinking-row');
  await mkdir(screenshots, { recursive: true });
  await mkdir(directory, { recursive: true });
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationTurn,ReasoningTail} from './src/ui/ConversationTurn';
import {renderMarkdown} from './src/ui/markdown';
import {TrajectoryPanel} from './src/ui/Trajectory';
import {requestTurnInspection} from './src/ui/turn-inspection';
import {buildConversationPresentation} from './src/server/conversation-presentation';
import {applyInterfaceLocale} from './src/ui/i18n';
import './src/ui/studio.css';
const root=createRoot(document.getElementById('root'));
const at=n=>new Date(Date.now()-72000+n*1000).toISOString();
let id=0, mode='running', inspector=false, last;
const tool=(name,n,args,result)=>({at:at(n),seq:n,type:'tool',data:{tool:name,toolCallId:name,status:'completed',arguments:args,output:result,exitCode:0}});
const data=()=>{
const run={id:'r',workflowId:'w',status:mode==='running'?'running':'completed',route:{runtimeId:'api-anthropic',model:'model-large',kind:'routine',reasons:[],warnings:[]},startedAt:at(0),endedAt:at(72),output:'',prompt:'Synthetic task',projectPath:'',kind:'routine',events:[
{at:at(1),seq:1,type:'text',text:'I will inspect the files and verify the change.'},tool('Read',2,{path:'src/example.ts'},'export const value = 1;'),
{at:at(3),seq:3,type:'reasoning',text:'**Check the boundary**\nKeep unrelated behavior intact.'},
{at:at(4),seq:4,type:'text',text:'The boundary is clear. I am applying the focused change.'},tool('Edit',5,{path:'src/example.ts'},'- const value = 1;\n+ const value = 2;'),
{at:at(6),seq:6,type:'text',text:'Now I will run the focused tests.'},tool('exec_command',7,{command:'node --test synthetic.test.ts'},'PASS 12 tests\n0 failures\nSynthetic output only.'),
{at:at(8),seq:8,type:'text',text:'The requested change is ready. All focused checks passed.'}]};
if(mode==='running')run.events[6].data.status='running';
if(mode==='failed'){run.events[6].data.status='failed';run.events[6].data.exitCode=1;run.events[7].text='The command could not finish.';}
if(mode==='stopped')run.events[7].text='Work was stopped before the remaining checks.';
if(mode==='waiting')run.events[7].text='Please choose the folder to continue.';
if(mode==='handoff')run.relay={fromRunId:'old',fromRuntimeId:'Executor B',reason:'quota'};
if(['thinking','fallback'].includes(mode)){run.reasoning='**Latest headline**\nHidden body\n\nPartial';run.events.push({at:at(9),seq:9,type:'reasoning',text:run.reasoning});run.status='running';}
const workflow={id:'w',status:['running','handoff','thinking','fallback'].includes(mode)?'running':mode==='failed'?'failed':mode==='stopped'?'cancelled':mode==='waiting'?'waiting-approval':'completed',startedAt:at(0),updatedAt:at(72),runIds:['r'],input:{content:'Synthetic task'},plan:[]};
if(mode==='waiting')workflow.userQuestion={text:'Which folder should I use?',options:['Source','Archive'],askedAt:at(8)};
return {run,workflow};};
function render(){const {run,workflow}=data();last={run,workflow};const compact=buildConversationPresentation(workflow,[run]);root.render(<main className="conversation-scroll" style={{height:'100vh',overflow:'auto',padding:'32px 40px',background:'var(--surface-1)',color:'var(--text)'}}><div style={{maxWidth:900,margin:'auto'}}><h2>Conversation</h2>{mode==='fallback'?<ReasoningTail workflow={workflow} runs={[run]} targets={[{id:'api-anthropic',label:'My card'}]}/>:<ConversationTurn targets={[{id:"api-anthropic",label:"My card"}]} key={id} workflow={workflow} runs={[run]} projection={compact} loadDetail={async()=>{window.detailCalls=(window.detailCalls||0)+1;if(window.failDetails)throw new Error('synthetic offline');return {...buildConversationPresentation(workflow,[run],[],!window.limitDetails),...(window.limitDetails?{detailLimited:true}:{})};}} inspect={(runId,key)=>{window.inspected={runId,key};requestTurnInspection(runId,key);inspector=true;render();}} renderText={text=><div className="markdown">{renderMarkdown(text)}</div>}/> }{workflow.status==='completed'&&<article className="conversation-message"><p>The requested change is ready. All focused checks passed.</p></article>}{mode==='failed'&&<p role="alert">Synthetic command failed. <button>继续</button></p>}{mode==='waiting'&&<div><button>Source</button><button>Archive</button></div>}{inspector&&<TrajectoryPanel run={run}/>}</div></main>);}
window.configure=async(next,locale,theme)=>{mode=next;id++;inspector=false;document.documentElement.dataset.theme=theme;await applyInterfaceLocale(locale);render();};
window.complete=()=>{mode='collapsed';render();};
window.ready=true;
`,
    },
    bundle: true,
    format: 'iife',
    outfile: join(directory, 'turn.js'),
    loader: { '.woff2': 'file', '.png': 'file', '.svg': 'file' },
    logLevel: 'silent',
  });
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="turn.css"><div id="root"></div><script src="turn.js"></script>',
  );
  const runner = join(directory, 'turn-runner.cjs');
  await writeFile(
    runner,
    `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',path.join(${JSON.stringify(directory)},'profile'));
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:false,nodeIntegration:false}});
// Hosted Windows runners turn animations off, which Chromium reports as prefers-reduced-motion: reduce. The motion
// checks below need animations; the reduced-motion checks further down set reduce themselves.
const motion=value=>win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]});
await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
win.webContents.debugger.attach('1.3');await motion('no-preference');
const evaluate=code=>win.webContents.executeJavaScript(code);const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Folding finishes on animation frames, which hosted runners without a GPU paint slowly; wait for the state, not a fixed time.
const waitFor=async(code,expected,message)=>{let actual;for(const end=Date.now()+10000;(actual=await evaluate(code))!==expected&&Date.now()<end;)await pause(20);assert.equal(actual,expected,message);};
for(let i=0;i<100&&!await evaluate('window.ready');i++)await pause(20);
await evaluate('window.configure("running","zh-CN","light")');await pause(500);
assert.equal(await evaluate('document.querySelectorAll(".turn-group").length'),3);
assert.match(await evaluate('document.querySelector(".turn-tail").textContent'),/处理中，用时 [0-9]+ 分 [0-9]+ 秒…$/);
await evaluate('window.complete()');
await waitFor('document.querySelector(".turn-status").getAttribute("aria-expanded")','false');
assert.equal(await evaluate('document.querySelectorAll(".turn-tool").length'),0);
await evaluate('document.querySelector(".turn-status").click()');await pause(100);
assert.equal(await evaluate('document.querySelectorAll(".turn-tool").length'),3);
assert.equal(await evaluate('document.querySelectorAll(".turn-tool[open]").length'),0);
assert.deepEqual(await evaluate('[...document.querySelectorAll(".turn-tool-title")].map(node=>node.textContent)'),['读取 src/example.ts','修改 src/example.ts','运行 node --test synthetic.test.ts']);
assert.deepEqual(await evaluate('[...document.querySelectorAll(".turn-tool > summary small")].map(node=>node.textContent)'),['','+1 −1','']);
await evaluate('document.querySelectorAll(".turn-tool")[1].open=true');
assert.equal(await evaluate('document.querySelectorAll(".turn-tool")[1].querySelectorAll("pre").length'),1,'edit body contains only the diff');
assert.equal(await evaluate('document.querySelectorAll(".turn-tool")[1].querySelector(".turn-tool-body-head small").textContent'),'src/example.ts');
assert.match(await evaluate('getComputedStyle(document.querySelector(".turn-output")).fontFamily'),/Cascadia Code.*Consolas.*ui-monospace.*monospace/);
assert.ok(await evaluate('(()=>{const h=document.querySelectorAll(".turn-tool")[1].querySelector(".turn-tool-body-head");return Math.abs(h.getBoundingClientRect().right-h.querySelector("button").getBoundingClientRect().right)<2})()'),'inspector link sits at the right edge of the body header');
await evaluate('document.querySelectorAll(".turn-tool")[2].open=true;document.querySelectorAll(".turn-inspect")[2].click()');await pause(100);
assert.equal(await evaluate('window.inspected.key'),'r:tool:native:exec_command');
assert.ok(await evaluate('document.querySelector(".trajectory-detail") || document.body.innerText.includes("sourceEvents")'));
for(const width of [1280,760])for(const locale of ['zh-CN','en'])for(const theme of ['light','dark'])for(const state of ['running','collapsed','expanded','failed','stopped','waiting','handoff','thinking','fallback']){
win.setSize(width,900);await evaluate('window.configure('+JSON.stringify(state)+','+JSON.stringify(locale)+','+JSON.stringify(theme)+')');await pause(300);
if(state==='expanded'){await evaluate('document.querySelector(".turn-status").click()');await pause(150);await evaluate('document.querySelectorAll(".turn-tool")[2].open=true;document.querySelectorAll(".turn-tool")[1].open=true');await pause(100);assert.equal(await evaluate('document.querySelectorAll(".turn-tool[open]").length'),2);}
if(['thinking','fallback'].includes(state)){assert.match(await evaluate('document.querySelector(".turn-tail").textContent'),/Latest headline/);assert.doesNotMatch(await evaluate('document.body.innerText'),/Hidden body|Partial/);}
if(state==='expanded'){await evaluate('document.querySelector(".turn-reasoning").open=true');await pause(50);assert.equal(await evaluate('document.querySelector(".turn-reasoning strong").textContent'),'Check the boundary');}
if(state==='collapsed')assert.equal(await evaluate('document.querySelectorAll(".turn-narration,.turn-reasoning,.turn-tool").length'),0);
if(state==='running')assert.ok((await evaluate('document.querySelector(".turn-tail").textContent')).endsWith('…'));
assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
await fs.writeFile(path.join(${JSON.stringify(screenshots)},state+'-'+locale+'-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}
await evaluate('window.configure("failed","en","light")');await pause(250);await evaluate('document.querySelectorAll(".turn-group > button")[2].click()');await pause(50);
assert.equal(await evaluate('document.querySelector(".turn-tool-failed small").textContent'),'Exit code 1');
await evaluate('window.configure("running","en","light")');await pause(250);
await evaluate('window.complete()');await pause(30);await evaluate('document.querySelector(".turn-status").click()');await pause(20);await evaluate('document.querySelector(".turn-status").click()');await pause(250);
assert.equal(await evaluate('document.querySelector(".turn-status").getAttribute("aria-expanded")'),'true','explicit expansion overrides completion folding');
assert.equal(await evaluate('getComputedStyle(document.querySelector(".turn-process")).opacity'),'1');
await evaluate('window.configure("running","en","light")');await pause(250);
await evaluate('document.querySelector(".conversation-scroll").style.height="250px";document.querySelector(".conversation-scroll > div").style.paddingBottom="1000px";document.querySelector(".conversation-scroll").scrollTop=300;window.complete()');
await pause(20);const anchorTop=await evaluate('document.querySelector(".conversation-message").getBoundingClientRect().top');await pause(250);
assert.ok(Math.abs(await evaluate('document.querySelector(".conversation-message").getBoundingClientRect().top')-anchorTop)<3,'fold preserves the visible answer anchor '+JSON.stringify({reduce:await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),anchorTop,after:await evaluate('document.querySelector(".conversation-message").getBoundingClientRect().top'),scroll:await evaluate('document.querySelector(".conversation-scroll").scrollTop')}));
await waitFor('document.body.innerText.split("The requested change is ready.").length-1',1,'completion keeps one final answer');
win.webContents.setBackgroundThrottling(false);
await motion('reduce');
await evaluate('window.configure("running","en","dark")');await pause(250);assert.equal(await evaluate('getComputedStyle(document.querySelector(".turn-shimmer")).animationName'),'none');
await evaluate('window.complete()');await pause(50);assert.equal(await evaluate('document.querySelector(".turn-status").getAttribute("aria-expanded")'),'false');
await evaluate("window.originalTimeout=window.setTimeout;window.noticeDelays=[];window.setTimeout=(fn,ms,...args)=>{if(ms===30000){window.noticeDelays.push(ms);return window.originalTimeout(fn,180,...args);}return window.originalTimeout(fn,ms,...args);};window.failDetails=true;window.detailCalls=0;window.configure('stopped','zh-CN','light');");
await pause(80);
assert.equal(await evaluate('document.querySelectorAll(".turn-process > [role=status]").length'),0,'transient failure stays quiet');
assert.ok(await evaluate('document.querySelectorAll(".turn-group").length > 0'),'projection remains visible');
await pause(200);
assert.deepEqual(await evaluate('window.noticeDelays'),[30000],'notice uses the thirty second threshold');
assert.equal(await evaluate('document.querySelectorAll(".turn-process > [role=status]").length'),1);
assert.equal(await evaluate('document.querySelectorAll(".turn-process > button").length'),0,'failure is not a large retry button');
// The preceding folding test intentionally shrinks this same scroll container to 250px.
// React retains that manual style when the next fixture has identical virtual styles.
await evaluate('(()=>{const scroller=document.querySelector(".conversation-scroll");scroller.style.height="100vh";scroller.firstElementChild.style.paddingBottom="0px";scroller.scrollTop=0;document.querySelector(".turn-detail-notice").scrollIntoView({block:"nearest"});})()');
await pause(150);
assert.ok(await evaluate('(()=>{const notice=document.querySelector(".turn-detail-notice"),rect=notice.getBoundingClientRect(),clip=notice.closest(".conversation-scroll").getBoundingClientRect();return rect.height>0&&rect.top>=Math.max(0,clip.top)&&rect.bottom<=Math.min(innerHeight,clip.bottom)&&getComputedStyle(notice).visibility!=="hidden";})()'),'notice is inside the visible scroll viewport');
await fs.writeFile(path.join(${JSON.stringify(directory)},'detail-recovery-notice.png'),(await win.webContents.capturePage()).toPNG());
await evaluate('window.failDetails=false');await pause(1000);
assert.equal(await evaluate('document.querySelectorAll(".turn-process > [role=status]").length'),0,'successful retry removes notice');
assert.ok(await evaluate('window.detailCalls>=2'));
await evaluate('window.setTimeout=window.originalTimeout;void 0');
await evaluate('window.limitDetails=true;window.configure("stopped","en","light");');await pause(250);
assert.equal(await evaluate('document.querySelectorAll(".turn-detail-notice").length'),1);
assert.match(await evaluate('document.querySelector(".turn-detail-notice").textContent'),/Showing a summary.*full record is still retained/);
assert.ok(await evaluate('document.querySelectorAll(".turn-group").length>0'),'limited details keep the summary projection');
await fs.writeFile(path.join(${JSON.stringify(directory)},'detail-limited-summary.png'),(await win.webContents.capturePage()).toPNG());
await evaluate('window.limitDetails=false;window.configure("stopped","en","light");');await pause(250);
assert.equal(await evaluate('document.querySelectorAll(".turn-detail-notice").length'),0,'unlimited details do not claim truncation');
console.log('PASS: 72 screenshots, states, tool disclosures, inspector, auto-collapse and reduced motion; detail failure recovery');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
    env,
    windowsHide: true,
    timeout: 170000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.match(result.stdout, /PASS: 72 screenshots/);
});
