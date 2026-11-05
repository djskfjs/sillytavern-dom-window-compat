import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.DOM_WINDOW_TEST_SOURCE || root;
const output = process.env.DOM_WINDOW_TEST_OUTPUT || path.resolve(root, '../scroll-results');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    const files = { '/': 'tests/fixture.html', '/fixture.js': 'tests/fixture.js', '/jquery.js': 'tests/vendor/jquery.min.js' };
    let file = files[name] && path.join(root, files[name]);
    if (name.startsWith('/extension/') && path.basename(name) === name.slice(11)) file = path.join(source, name.slice(11));
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DOM_WINDOW_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
async function idle(page) {
  await page.waitForFunction(() => { const a = window.STDOMWindow?.audit(); return a?.mounted && !a.applying && !a.renderQueue.pending && !a.renderQueue.running; });
  await page.waitForTimeout(100);
}
async function run(name, query, test) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/?variant=compat&count=337&preload=10&${query}`);
    await page.waitForFunction(() => window.fixtureReady);
    await page.locator('#dom_window_autostart').check(); await idle(page);
    const detail = await test(page);
    assert.deepEqual(errors, []);
    results.push({ name, passed: true, detail });
  } catch (error) { results.push({ name, passed: false, error: error.message }); }
  await page.close(); console.log(JSON.stringify(results.at(-1)));
}
try {
  await run('No scroll write for a resize below the reader', 'frameHeight=900', async page => {
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.5)); await idle(page);
    const result = await page.evaluate(async () => {
      const root = document.querySelector('#chat');
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      const writes = [];
      Object.defineProperty(root, 'scrollTop', { configurable: true, get() { return descriptor.get.call(this); },
        set(value) { writes.push({ before: descriptor.get.call(this), value }); descriptor.set.call(this, value); } });
      const tail = root.querySelector('.last_mes iframe');
      tail.style.height = `${tail.getBoundingClientRect().height + 200}px`;
      await new Promise(resolve => setTimeout(resolve, 100));
      delete root.scrollTop;
      return writes;
    });
    assert.equal(result.length, 0, JSON.stringify(result)); return result;
  });
  await run('Continuous scrolling cannot starve visible frontend recovery', '', async page => {
    const result = await page.evaluate(async () => {
      const { createRenderQueue } = await import('/extension/render-queue.js');
      const root = document.querySelector('#chat'), ctx = window.fixture.ctx;
      const node = root.querySelector('.last_mes'); node.querySelectorAll('iframe').forEach(el => el.remove());
      let started = null; const since = performance.now();
      const queue = createRenderQueue({ getRoot: () => root, getChat: () => ctx.chat, markSelfRender: () => {},
        refresh: async () => { started = performance.now() - since; } });
      queue.enqueue([336], { force: true });
      const timer = setInterval(() => queue.defer(), 25);
      await new Promise(resolve => setTimeout(resolve, 800));
      clearInterval(timer); const observed = started; queue.dispose(); return observed;
    });
    assert(result !== null && result <= 400, `recovery start: ${result}`); return result;
  });
  await run('Slow helper cleanup keeps the overlapping row stationary', 'frameHeight=900&releaseDelay=60', async page => {
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.5)); await idle(page);
    const result = await page.evaluate(async () => {
      const root = document.querySelector('#chat'), a = window.STDOMWindow.audit();
      const row = root.querySelector(`.mes[mesid="${a.end - 2}"]`);
      root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top + 50;
      const expected = row.getBoundingClientRect().top;
      const samples = [];
      const until = performance.now() + 900;
      await new Promise(resolve => {
        function sample() {
          samples.push(Math.abs(row.getBoundingClientRect().top - expected));
          if (performance.now() < until) requestAnimationFrame(sample); else resolve();
        } requestAnimationFrame(sample);
      });
      return { maxShift: Math.max(...samples), samples: samples.length };
    });
    assert(result.maxShift < 2, JSON.stringify(result)); return result;
  });
  await run('Native scroll anchoring is disabled only while the window is enabled', 'nativeAnchor=1&flex=1', async page => {
    const active = await page.evaluate(() => getComputedStyle(document.querySelector('#chat')).overflowAnchor);
    assert.equal(active, 'none');
    await page.locator('#dom_window_autostart').uncheck();
    const restored = await page.evaluate(() => getComputedStyle(document.querySelector('#chat')).overflowAnchor);
    assert.equal(restored, 'auto'); return { active, restored };
  });
  await run('Long hidden source does not become a giant blank row', 'frameHeight=900&sourceHeight=18000&delay=250', async page => {
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.4));
    await page.waitForFunction(() => window.STDOMWindow.audit().renderQueue.pending > 0);
    const heights = await page.evaluate(() => [...document.querySelectorAll('#chat > .dom-window-render-pending')].map(el => el.getBoundingClientRect().height));
    assert(heights.length && Math.max(...heights) <= 1000, JSON.stringify(heights));
    await idle(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#chat > .mes[style*="min-height"]').length), 0);
    return { maxPendingHeight: Math.max(...heights) };
  });
  await run('Small upward wheel gestures keep making progress', 'frameHeight=900&nativeAnchor=1&flex=1&releaseDelay=25', async page => {
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.6)); await idle(page);
    const position = () => page.evaluate(() => {
      const root = document.querySelector('#chat'), r = root.getBoundingClientRect(), y = r.top + root.clientHeight / 2;
      const row = [...root.querySelectorAll(':scope > .mes')].find(el => { const b=el.getBoundingClientRect(); return b.top<=y && b.bottom>=y; });
      if (!row) return null;
      const b=row.getBoundingClientRect(); return Number(row.getAttribute('mesid')) + (y-b.top)/b.height;
    });
    const before = await position(), box = await page.locator('#chat').boundingBox(), samples = [];
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    for (let step=0; step<60; step++) { await page.mouse.wheel(0,-80); await page.waitForTimeout(20); samples.push(await position()); }
    await idle(page); const after = await position();
    assert(samples.every(value => value !== null), 'no blank viewport during small gestures');
    assert(before - after > 4, JSON.stringify({ before, after }));
    const backtracks = samples.slice(1).filter((value,i) => value > samples[i] + 0.02).length;
    assert.equal(backtracks, 0, JSON.stringify(samples));
    return { before, after, backtracks };
  });
  await run('Changing 10 to 15 to 5 floors preserves the reader without reload', 'frameHeight=900', async page => {
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.55)); await idle(page);
    const before = await page.evaluate(() => {
      const root=document.querySelector('#chat'), y=root.getBoundingClientRect().top+root.clientHeight/2;
      const row=[...root.querySelectorAll(':scope > .mes')].find(el=>{const r=el.getBoundingClientRect();return r.top<=y&&r.bottom>=y;});
      return { id:row.getAttribute('mesid'), top:row.getBoundingClientRect().top, instance:row.querySelector('iframe').dataset.instance,
        boots:sessionStorage.getItem('fixture.boots'), data:JSON.stringify(window.fixture.ctx.chat) };
    });
    const reports=[];
    for (const size of [15,5]) {
      await page.locator('#dom_window_preload').fill(String(size)); await page.locator('#dom_window_preload_save').click(); await idle(page);
      const after=await page.evaluate(id=>{
        const row=document.querySelector(`#chat > .mes[mesid="${id}"]`);
        return {top:row?.getBoundingClientRect().top,instance:row?.querySelector('iframe').dataset.instance,audit:window.STDOMWindow.audit(),
          boots:sessionStorage.getItem('fixture.boots'),data:JSON.stringify(window.fixture.ctx.chat)};
      },before.id);
      assert.equal(after.boots,before.boots); assert.equal(after.data,before.data); assert.equal(after.instance,before.instance);
      assert.equal(after.audit.end-after.audit.start+1,size); assert(Math.abs(after.top-before.top)<2,JSON.stringify({before,after}));
      reports.push({size,shift:after.top-before.top});
    }
    return reports;
  });
  await run('One activation adapts both helper settings and closing restores them', 'helperDepth=8&helperStreaming=1', async page => {
    const adapted=await page.evaluate(()=>({boots:Number(sessionStorage.getItem('fixture.boots')),settings:window.fixture.ctx.extensionSettings}));
    assert.equal(adapted.boots,2); assert.equal(adapted.settings.tavern_helper.render.depth,0);
    assert.equal(adapted.settings.tavern_helper.render.allow_streaming,false);
    assert.deepEqual(Object.values(adapted.settings.STDOMWindow_helper_backup)[0].original,{depth:8,allow_streaming:true});
    await page.locator('#dom_window_autostart').uncheck();
    await page.waitForFunction(()=>Number(sessionStorage.getItem('fixture.boots'))===3&&window.fixtureReady&&!window.STDOMWindow?.enabled);
    const restored=await page.evaluate(()=>window.fixture.ctx.extensionSettings);
    assert.equal(restored.tavern_helper.render.depth,8); assert.equal(restored.tavern_helper.render.allow_streaming,true);
    assert.equal(restored.STDOMWindow_helper_backup,undefined);
    return {activationReloads:1,closingReloads:1,restoredDepth:8,restoredStreaming:true};
  });
  await run('Interrupted shutdown recovers the saved helper preferences on reload', 'helperDepth=6', async page => {
    await page.evaluate(()=>localStorage.setItem('STDOMWindow.scrollfix.enabled','0')); await page.reload();
    await page.waitForFunction(()=>Number(sessionStorage.getItem('fixture.boots'))===4&&window.fixtureReady&&!window.STDOMWindow?.enabled);
    const restored=await page.evaluate(()=>window.fixture.ctx.extensionSettings);
    assert.equal(restored.tavern_helper.render.depth,6); assert.equal(restored.STDOMWindow_helper_backup,undefined);
    return {restoredDepth:6};
  });
  await run('Missing randomUUID and changing capacity while closed require no reload', 'noUUID=1', async page => {
    const boots=await page.evaluate(()=>sessionStorage.getItem('fixture.boots'));
    await page.locator('#dom_window_autostart').uncheck(); await page.locator('#dom_window_preload').fill('12');
    await page.locator('#dom_window_preload_save').click();
    const state=await page.evaluate(()=>({boots:sessionStorage.getItem('fixture.boots'),owner:localStorage.getItem('STDOMWindow.compat.device'),size:localStorage.getItem('STDOMWindow.compat.preload')}));
    assert.equal(state.boots,boots); assert.equal(state.size,'12'); assert.match(state.owner,/^dw-/);
    return {reloads:0,savedSize:12};
  });
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'scroll-report.json'), JSON.stringify({ source, results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
