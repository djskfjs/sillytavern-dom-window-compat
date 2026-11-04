import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require=createRequire(import.meta.url);
const { chromium }=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baseline=process.env.DOM_WINDOW_BASELINE || path.resolve(root,'../upstream');
const output=process.env.DOM_WINDOW_TEST_OUTPUT || path.resolve(root,'../test-results');
await mkdir(output,{recursive:true});await mkdir(path.join(output,'temp'),{recursive:true});
const findings=[];let browser;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    let target;
    if(url.pathname==='/')target=path.join(root,'tests/fixture.html');
    else if(url.pathname==='/fixture.js')target=path.join(root,'tests/fixture.js');
    else if(url.pathname==='/jquery.js')target=path.join(root,'tests/vendor/jquery.min.js');
    else if(url.pathname.startsWith('/extension/')){
      const name=url.pathname.slice('/extension/'.length);
      if(!['index.js','render-queue.js','style.css','settings.html'].includes(name)){res.writeHead(404).end();return;}
      const variant=url.searchParams.get('variant')==='baseline'||req.headers.referer?.includes('variant=baseline');
      target=path.join(variant?baseline:root,name);
    }else{res.writeHead(404).end();return;}
    const types={'.js':'text/javascript','.html':'text/html','.css':'text/css'};
    res.setHeader('Content-Type',(types[path.extname(target)]||'application/octet-stream')+'; charset=utf-8');res.end(await readFile(target));
  }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function open(query){
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const applied=[];page.on('console',msg=>{if(msg.text().includes('[DOMWindow] applied'))applied.push(msg.text());});
  await page.goto(origin+'/?'+query);await page.waitForFunction(()=>window.fixtureReady);
  await page.locator('#dom_window_autostart').waitFor();
  return {page,errors,applied};
}
async function enable(page){await page.locator('#dom_window_autostart').check();}
async function idle(page){await page.waitForFunction(()=>{
  const audit=window.STDOMWindow.audit();
  return audit.renderQueue?.running===0 && audit.renderQueue?.ready===0 && [...document.querySelectorAll('#chat>.mes')].filter(el=>{
    const r=el.getBoundingClientRect(),v=document.querySelector('#chat').getBoundingClientRect();return r.bottom>=v.top&&r.top<=v.bottom;
  }).every(el=>el.querySelector('iframe')||window.failRefreshId===Number(el.getAttribute('mesid')));
},null,{timeout:15000});}
function cleanIds(data){assert.equal(new Set(data.ids).size,data.ids.length,'no duplicate message ids');assert.deepEqual(data.ids,[...data.ids].sort((a,b)=>a-b),'DOM order matches message ids');}
async function state(page){return page.evaluate(()=>({ids:[...document.querySelectorAll('#chat>.mes')].map(el=>Number(el.getAttribute('mesid'))),
  frames:[...document.querySelectorAll('#chat>.mes iframe')].map(el=>({id:Number(el.dataset.id),token:Number(el.dataset.token)})),
  data:JSON.stringify(window.fixture.ctx.chat),audit:window.STDOMWindow.audit(),stats:window.stats,
  waiting:document.querySelectorAll('.dom-window-render-pending').length,tail:document.querySelector('#chat .last_mes')?.getAttribute('mesid')}));}
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.DOM_WINDOW_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    env:{...process.env,TEMP:path.join(output,'temp'),TMP:path.join(output,'temp')}});
  {
    const {page,errors}=await open('variant=baseline&count=337');
    await enable(page);await page.waitForTimeout(600);const data=await state(page);
    assert.equal(data.frames.length,0,'baseline reproduces generated frontend not refreshed');assert.equal(data.stats.calls.length,0);
    findings.push({case:'原版：复现原始消息无HTML标记时的前端漏渲染',result:'confirmed',frames:data.frames.length});assert.deepEqual(errors,[]);await page.close();
  }
  for(const api of ['modern','legacy']){
    const {page,errors,applied}=await open('variant=compat&count=337&api='+api);
    const before=await state(page);assert.equal(before.ids.length,20);assert.equal(before.frames.length,20);
    await enable(page);await idle(page);let data=await state(page);
    assert(data.frames.length>0);assert.equal(data.data,before.data);assert.equal(data.stats.maxConcurrent,1);cleanIds(data);
    await page.evaluate(()=>window.fixture.scrollUp(28));await idle(page);data=await state(page);cleanIds(data);assert.equal(data.data,before.data);assert.equal(data.stats.maxConcurrent,1);assert.equal(applied.length,1);
    await page.evaluate(()=>window.fixture.scrollDown(28));await idle(page);data=await state(page);cleanIds(data);assert.equal(data.tail,'336');assert.equal(applied.length,1);
    await page.locator('#dom_window_autostart').uncheck();await page.waitForFunction(()=>document.querySelectorAll('#chat>.mes iframe').length===20);
    data=await state(page);assert.equal(data.audit.enabled,false);assert.equal(data.data,before.data);assert.equal(data.waiting,0);assert.equal(await page.evaluate(()=>window.fixture.ctx.powerUserSettings.chat_truncation),20);
    findings.push({case:`${api} API：上翻/回底/关闭恢复，数据不变`,result:'passed',maxConcurrent:data.stats.maxConcurrent});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors,applied}=await open('variant=compat&count=2601&delay=55');const before=await state(page);
    await enable(page);await idle(page);
    await page.evaluate(()=>window.fixture.scrollUp(60));await idle(page);let data=await state(page);cleanIds(data);assert.equal(data.data,before.data);assert.equal(data.stats.maxConcurrent,1);assert.equal(applied.length,1);
    const callCount=data.stats.calls.length;await page.waitForTimeout(600);data=await state(page);assert.equal(data.stats.calls.length,callCount,'no stationary re-render loop');
    await page.screenshot({path:path.join(output,'2601-message-mobile-preview.png'),fullPage:true});
    await page.evaluate(()=>window.fixture.scrollDown(60));await idle(page);data=await state(page);cleanIds(data);assert.equal(data.tail,'2600');assert.equal(applied.length,1);
    assert(data.audit.renderQueue.discarded>0);
    findings.push({case:'2601层：快速上下滚动、静止无循环',result:'passed',mounted:data.ids.length,discarded:data.audit.renderQueue.discarded,maxConcurrent:data.stats.maxConcurrent});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors}=await open('variant=compat&count=337&delay=180');await enable(page);
    await page.waitForFunction(()=>window.STDOMWindow.audit().renderQueue.running===1);
    await page.evaluate(()=>window.fixture.switchChat(53));await page.waitForTimeout(400);await idle(page);const data=await state(page);cleanIds(data);
    assert(data.frames.every(f=>f.token===2),'no old chat frontend in current chat');assert.equal(data.tail,'52');assert.equal(data.stats.maxConcurrent,1);
    findings.push({case:'补渲染过程中切换聊天，旧任务不污染新聊天',result:'passed',discarded:data.audit.renderQueue.discarded});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors,applied}=await open('variant=compat&count=337');await enable(page);await idle(page);
    await page.evaluate(()=>window.fixture.appendMessage());await page.waitForTimeout(400);await idle(page);const data=await state(page);cleanIds(data);assert.equal(data.tail,'337');assert.equal(applied.length,1);
    const callCount=data.stats.calls.length;await page.waitForTimeout(400);assert.equal((await state(page)).stats.calls.length,callCount);
    findings.push({case:'新消息增量追加，不整窗重建',result:'passed'});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors}=await open('variant=compat&count=337');await page.evaluate(()=>window.failRefreshId=336);await enable(page);await idle(page);
    const data=await state(page);assert.equal(data.audit.renderQueue.errors,1);assert.equal(data.audit.renderQueue.running,0);
    assert.equal(await page.locator('#chat>.mes[mesid="336"]').evaluate(el=>el.classList.contains('dom-window-render-pending')),false);
    assert(data.frames.length>0);findings.push({case:'单层前端失败后继续处理其他楼层，解除等待遮罩',result:'passed'});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors}=await open('variant=compat&count=337');await page.evaluate(()=>window.failMountId=334);await enable(page);
    await page.waitForFunction(()=>!window.STDOMWindow.enabled&&window.STDOMWindow.audit().renderQueue.running===0&&window.STDOMWindow.audit().renderQueue.pending===0);
    const data=await state(page);assert.equal(data.audit.enabled,false);assert.equal(data.ids.length,20);assert.equal(data.waiting,0);
    findings.push({case:'窗口挂载异常时关闭窗口模式并恢复普通展示',result:'passed'});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors}=await open('variant=compat&count=337&seed=legacy');await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(()=>window.STDOMWindow.enabled),false,'legacy autostart is not inherited');
    await enable(page);await idle(page);const before=await state(page);
    await page.evaluate(async()=>{window.firstInstance=window.STDOMWindow;await import('/extension/index.js?duplicate=1');});
    assert.equal(await page.evaluate(()=>window.firstInstance===window.STDOMWindow),true);
    assert.equal(await page.locator('#dom_window_settings').count(),1);assert.equal((await state(page)).data,before.data);
    findings.push({case:'旧版开关不自动继承，重复加载不覆盖运行实例',result:'passed'});assert.deepEqual(errors,[]);await page.close();
  }
  {
    const {page,errors}=await open('variant=compat&count=337');const before=await state(page);await enable(page);await idle(page);
    await page.evaluate(()=>window.fixture.entryModule.disable());
    assert.equal(await page.evaluate(()=>typeof window.STDOMWindow),'undefined');assert.equal(await page.locator('#dom_window_settings').count(),0);
    assert.equal(await page.locator('#chat>.mes iframe').count(),20);assert.equal(await page.evaluate(()=>JSON.stringify(window.fixture.ctx.chat)),before.data);
    await page.evaluate(async()=>{window.fixture.entryModule=await import('/extension/index.js?reinstall=1');});
    await page.locator('#dom_window_autostart').waitFor();await page.locator('#dom_window_autostart').uncheck();await enable(page);await idle(page);
    assert.equal(await page.locator('#dom_window_settings').count(),1);
    findings.push({case:'停用扩展清理接口和面板，重新加载可正常开启',result:'passed'});assert.deepEqual(errors,[]);await page.close();
  }
  await writeFile(path.join(output,'test-report.json'),JSON.stringify({date:new Date().toISOString(),engine:'Chrome headless',findings,limitation:'合成聊天和模拟酒馆助手；不等同于真实 iOS Safari 或真实前端长期测试'},null,2)+'\n');
  console.log(JSON.stringify({passed:findings.length,findings},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
