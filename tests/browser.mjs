import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.env.DOM_WINDOW_BASELINE || path.resolve(root, '../upstream');
const previousSource = process.env.DOM_WINDOW_PREVIOUS || path.resolve(root, '../dom-window-compat');
const output = process.env.DOM_WINDOW_TEST_OUTPUT || path.resolve(root, '../test-results-moving');
await mkdir(output, { recursive: true }); await mkdir(path.join(output, 'temp'), { recursive: true });
const findings = []; let browser;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); let target;
    if (url.pathname === '/') target = path.join(root, 'tests/fixture.html');
    else if (url.pathname === '/fixture.js') target = path.join(root, 'tests/fixture.js');
    else if (url.pathname === '/jquery.js') target = path.join(root, 'tests/vendor/jquery.min.js');
    else if (url.pathname.startsWith('/extension/')) {
      const name = url.pathname.slice('/extension/'.length);
      if (path.basename(name) !== name || !/\.(js|css|html)$/.test(name)) { res.writeHead(404).end(); return; }
      const original = url.searchParams.get('variant') === 'baseline' || req.headers.referer?.includes('variant=baseline');
      const previous = url.searchParams.get('variant') === 'previous' || req.headers.referer?.includes('variant=previous');
      target = path.join(original ? baseline : previous ? previousSource : root, name);
    } else { res.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
    res.setHeader('Content-Type', (types[path.extname(target)] || 'application/octet-stream') + '; charset=utf-8');
    res.end(await readFile(target));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function open(query) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?' + query); await page.waitForFunction(() => window.fixtureReady);
  await page.locator('#dom_window_autostart').waitFor(); return { page, errors };
}
async function enable(page) { await page.locator('#dom_window_autostart').check(); }
async function idle(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#chat'), audit = window.STDOMWindow.audit();
    const rows = [...root.querySelectorAll(':scope > .mes')], viewport = root.getBoundingClientRect();
    const visible = rows.filter(el => { const r = el.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom; });
    return typeof audit.applying === 'boolean' && (!audit.enabled || audit.mounted) && !audit.applying && audit.renderQueue?.running === 0 && audit.renderQueue?.pending === 0 &&
      rows.length > 0 && visible.length > 0 && rows.every(el => window.failRefreshId === Number(el.getAttribute('mesid')) ||
        !!el.querySelector('iframe')?.contentDocument?.querySelector('.card'));
  }, null, { timeout: 20000 });
}
async function state(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#chat'), r = root.getBoundingClientRect(), rows = [...root.querySelectorAll(':scope > .mes')];
    const visible = rows.filter(el => { const m = el.getBoundingClientRect(); return m.bottom > r.top && m.top < r.bottom; });
    const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ids: rows.map(el => Number(el.getAttribute('mesid'))),
      frames: [...root.querySelectorAll(':scope > .mes iframe')].map(el => ({ id: Number(el.dataset.id), token: Number(el.dataset.token), instance: el.dataset.instance })),
      visibleIds: visible.map(el => Number(el.getAttribute('mesid'))), centerInSpacer: !!center?.closest('.dom-window-spacer'),
      data: JSON.stringify(window.fixture.ctx.chat), audit: window.STDOMWindow.audit(), stats: { ...window.stats },
      waiting: root.querySelectorAll('.dom-window-render-pending').length, tail: root.querySelector('.last_mes')?.getAttribute('mesid') };
  });
}
function windowValid(data, size) {
  assert.equal(new Set(data.ids).size, data.ids.length, 'no duplicate message ids');
  const range = Array.from({ length: data.audit.end - data.audit.start + 1 }, (_, i) => data.audit.start + i);
  const expected = [...range]; if (!expected.includes(data.audit.pinnedId)) expected.push(data.audit.pinnedId);
  assert.deepEqual(data.ids, expected, 'complete reading window plus optional pinned tail');
  assert.equal(range.length, Math.min(size, JSON.parse(data.data).length));
  assert(data.ids.length <= size + 1); assert(data.visibleIds.length > 0, 'empty viewport cannot pass');
  assert.equal(data.centerInSpacer, false, 'viewport center cannot remain blank');
  assert.equal(data.audit.renderQueue.pending, 0); assert.equal(data.waiting, 0);
  assert.equal(data.stats.detachedRuntimeCount, 0, 'no detached helper runtime references');
  assert.deepEqual(data.stats.runtimeIds, data.frames.map(frame => frame.id).sort((a, b) => a - b));
  assert(data.stats.runtimeIds.length <= size + 1);
}
async function pass(name, page, errors, extra = {}) {
  assert.deepEqual(errors, []); findings.push({ case: name, result: 'passed', ...extra });
  console.log('PASS', name); await page.close();
}
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.DOM_WINDOW_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  {
    const { page, errors } = await open('variant=compat&count=37');
    const held = await page.evaluate(async () => {
      document.querySelector('#chat > .mes[mesid="30"]').remove(); window.fixture.auditRuntimes(false);
      const retained = window.stats.runtimeIds.includes(30) && window.stats.detachedRuntimeCount === 1;
      await window.fixture.ctx.eventSource.emit('TH_REQUEST_RENDER_MESSAGE', 30);
      return { retained, released: !window.stats.runtimeIds.includes(30) && window.stats.detachedRuntimeCount === 0 };
    });
    assert.deepEqual(held, { retained: true, released: true }); await pass('模型复现助手强引用残留及目标回收', page, errors);
  }
  if (existsSync(path.join(baseline, 'index.js'))) {
    const { page, errors } = await open('variant=baseline&count=337&noRecovery=1'); await enable(page); await page.waitForTimeout(600);
    assert.equal((await state(page)).frames.length, 0); await pass('隔离原版HTML标记检查（关闭助手DOM恢复监听）', page, errors);
  } else console.log('SKIP historical upstream comparison: set DOM_WINDOW_BASELINE to its source checkout');
  if (existsSync(path.join(previousSource, 'index.js')) && previousSource !== root) {
    const { page, errors } = await open('variant=previous&count=2601&preload=10'); await enable(page); await page.waitForTimeout(700);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.4)); await page.waitForTimeout(500); const data = await state(page);
    assert.equal(data.visibleIds.length, 0, 'previous published build reproduces an empty viewport after a single jump');
    assert(data.stats.detachedRuntimeCount > 0, 'previous build leaves removed floor runtimes retained');
    await pass('已发布compat.1：复现跨占位空白与后台引用残留', page, errors, { detached: data.stats.detachedRuntimeCount });
  }
  {
    const { page, errors } = await open('variant=compat&count=37');
    const result = await page.evaluate(async () => {
      const ctx = window.fixture.ctx, root = document.querySelector('#chat');
      const { createRenderQueue } = await import('/extension/render-queue.js');
      ctx.addOneMessage(ctx.chat[16], { forceId: 16, insertBefore: 17 });
      const queue = createRenderQueue({ getRoot: () => root, getChat: () => ctx.chat,
        refresh: (id, el) => window.TavernHelper.refreshOneMessage(id, window.jQuery(el)), markSelfRender: () => {} });
      queue.enqueue([16]); root.querySelector('.mes[mesid="30"]').remove();
      await ctx.eventSource.emit('TH_REQUEST_RENDER_MESSAGE', 30);
      const instance = root.querySelector('.mes[mesid="16"] iframe').dataset.instance;
      await queue.whenIdle();
      const reused = instance === root.querySelector('.mes[mesid="16"] iframe').dataset.instance;
      const result = { reused, calls: window.stats.calls.length, pending: queue.snapshot().pending };
      queue.dispose(); return result;
    });
    assert.deepEqual(result, { reused: true, calls: 0, pending: 0 }); await pass('清理事件批量创建前端后，队列复用已有iframe', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=37&preload=10');
    await page.evaluate(() => {
      document.querySelector('.mes[mesid="30"]').remove(); window.fixture.ctx.addOneMessage(window.fixture.ctx.chat[30], { forceId: 30, insertBefore: 31 });
    });
    await page.waitForFunction(() => window.stats.recoveryEvents.includes(30));
    await enable(page); await idle(page);
    const count = await page.evaluate(() => window.stats.recoveryEvents.length);
    await page.evaluate(() => window.fixture.scrollUp(4)); await idle(page);
    assert.equal(await page.evaluate(() => window.stats.recoveryEvents.length), count);
    await pass('助手DOM替换监听已生效，正常窗口移动不重复替换楼层', page, errors);
  }
  for (const api of ['modern', 'legacy']) {
    const { page, errors } = await open('variant=compat&count=337&api=' + api), before = await state(page);
    await enable(page); await idle(page); windowValid(await state(page), 5);
    await page.evaluate(() => window.fixture.scrollUp(12)); await idle(page); let data = await state(page);
    windowValid(data, 5); assert(data.audit.start < 332); assert.equal(data.data, before.data); assert(data.stats.maxConcurrent <= 1);
    await page.evaluate(() => window.fixture.scrollToFraction(1)); await idle(page); data = await state(page);
    windowValid(data, 5); assert.deepEqual(data.ids, [332, 333, 334, 335, 336]);
    await page.locator('#dom_window_autostart').uncheck(); await idle(page); data = await state(page);
    assert.equal(data.ids.length, 20); assert.equal(data.frames.length, 20); assert.equal(data.audit.enabled, false);
    assert.equal(data.data, before.data); await pass(`${api} API：5层上下阅读和关闭恢复`, page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10'), before = await state(page);
    await enable(page); await idle(page); const data = await state(page); windowValid(data, 10);
    assert.deepEqual(data.ids, Array.from({ length: 10 }, (_, i) => 2591 + i)); assert.equal(data.frames.length, 10);
    assert.equal(data.data, before.data); await pass('设置10层：10个前端全部完成', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10&delay=15'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.4)); await idle(page); let data = await state(page); windowValid(data, 10);
    assert(data.audit.start < 1800 && data.audit.start > 100); const earlier = data.audit.start;
    await page.screenshot({ path: path.join(output, '2601-moving-window.png'), fullPage: true });
    await page.evaluate(() => window.fixture.jumpBottomSpacer(0.7)); await idle(page); data = await state(page); windowValid(data, 10);
    assert(data.audit.start > earlier + 100); const starts = data.stats.started;
    await page.waitForTimeout(500); assert.equal((await state(page)).stats.started, starts);
    await pass('单次跨上下巨大占位后停手：非空视口且10层恢复', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10&delay=250'); await enable(page); await idle(page);
    await page.evaluate(async () => { for (const f of [0.1, 0.82, 0.25, 0.74, 0.35]) await window.fixture.scrollToFraction(f); });
    await idle(page); const data = await state(page); windowValid(data, 10); assert(data.stats.maxConcurrent <= 1);
    await pass('慢前端和快速反向：旧任务不滞留', page, errors, { discarded: data.audit.renderQueue.discarded });
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10&tailHeight=12000'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.3)); await idle(page); let data = await state(page); windowValid(data, 10);
    const range = [data.audit.start, data.audit.end];
    await page.evaluate(() => document.querySelector('#chat').dispatchEvent(new Event('scroll'))); await idle(page); data = await state(page);
    windowValid(data, 10); assert.deepEqual([data.audit.start, data.audit.end], range);
    await pass('12000px末楼不会错误拉动历史窗口', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10&releaseDelay=8&delay=5'); await enable(page); await idle(page);
    await page.evaluate(async () => { for (const f of [0.12, 0.82, 0.25, 0.72]) await window.fixture.scrollToFraction(f); });
    await idle(page); const data = await state(page); windowValid(data, 10);
    assert(data.audit.start > 1600 && data.audit.start < 2200, 'latest gesture wins while old cleanup awaits');
    await pass('异步回收期间继续滑动：最终手势接管位置', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.35)); await idle(page); const before = await state(page);
    const instances = Object.fromEntries(before.frames.map(frame => [frame.id, frame.instance]));
    await page.evaluate(() => window.fixture.appendMessage()); await idle(page); const data = await state(page); windowValid(data, 10);
    assert.deepEqual([data.audit.start, data.audit.end], [before.audit.start, before.audit.end]); assert.equal(data.tail, '2601');
    for (const frame of data.frames.filter(frame => frame.id <= before.audit.end)) assert.equal(frame.instance, instances[frame.id]);
    await pass('历史阅读时追加消息：区间和重叠实例保留', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.45)); await idle(page); const before = await state(page);
    const instances = Object.fromEntries(before.frames.map(frame => [frame.id, frame.instance]));
    await page.evaluate(() => window.fixture.scrollUp(1)); await idle(page); const data = await state(page); windowValid(data, 10);
    assert(data.audit.start < before.audit.start); const overlap = data.frames.filter(frame => instances[frame.id] && frame.id !== 2600);
    assert(overlap.length); for (const frame of overlap) assert.equal(frame.instance, instances[frame.id]);
    await pass('相邻窗口复用重叠iframe', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=2601&preload=10&delay=0'), before = await state(page);
    await enable(page); await idle(page); await page.evaluate(() => window.fixture.resetRuntimePeak());
    for (let turn = 0; turn < 120; turn++) {
      await page.evaluate(f => window.fixture.scrollToFraction(f), [0.03, 0.19, 0.38, 0.57, 0.76, 0.91, 0.43, 0.08][turn % 8]);
      await idle(page); const data = await state(page); windowValid(data, 10); assert(data.stats.runtimePeak <= 11, `round ${turn}`);
    }
    const data = await state(page); assert.equal(data.data, before.data); assert(data.stats.started > 120);
    assert(data.stats.releaseEvents.every(event => !event.hadElement));
    await pass('120轮跨历史滚动：后台最多11个实例，无脱离DOM引用', page, errors, { rounds: 120, runtimePeak: data.stats.runtimePeak, detached: data.stats.detachedRuntimeCount });
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10&delay=180'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.jumpTopSpacer(0.3)); await page.waitForFunction(() => window.STDOMWindow.audit().renderQueue.running === 1);
    await page.evaluate(() => window.fixture.switchChat(53)); await idle(page); const data = await state(page); windowValid(data, 10);
    assert(data.frames.every(frame => frame.token === 2)); assert.equal(data.tail, '52'); await pass('恢复时切换聊天：无旧前端污染', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.appendMessage()); await idle(page); const data = await state(page); windowValid(data, 10);
    assert.deepEqual(data.ids, Array.from({ length: 10 }, (_, i) => 328 + i)); await pass('底部追加：最近10层继续移动', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10'); await enable(page); await idle(page);
    await page.evaluate(async () => { window.failRefreshId = 0; await window.fixture.scrollToFraction(0); }); await idle(page);
    const data = await state(page); assert.equal(data.audit.renderQueue.errors, 1); assert.equal(data.waiting, 0);
    assert.equal(data.stats.detachedRuntimeCount, 0); await pass('单个恢复失败后继续其他楼层', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10'); await enable(page); await idle(page);
    await page.evaluate(async () => { window.failMountId = 0; await window.fixture.scrollToFraction(0); });
    await page.waitForFunction(() => window.STDOMWindow.audit().paused); const data = await state(page);
    assert.equal(data.audit.enabled, true); assert(data.ids.length <= 11); assert(data.ids.includes(336));
    assert.equal(data.stats.detachedRuntimeCount, 0); await pass('挂载异常后暂停并保留末楼，不批量恢复', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&seed=legacy'); await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.STDOMWindow.enabled), false); await enable(page); await idle(page);
    await page.evaluate(async () => { window.firstInstance = window.STDOMWindow; await import('/extension/index.js?duplicate=1'); });
    assert.equal(await page.evaluate(() => window.firstInstance === window.STDOMWindow), true); assert.equal(await page.locator('#dom_window_settings').count(), 1);
    await pass('旧开关不自动继承，重复加载保护', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337'); await enable(page); await idle(page);
    await page.evaluate(() => window.fixture.entryModule.disable());
    assert.equal(await page.evaluate(() => typeof window.STDOMWindow), 'undefined'); assert.equal(await page.locator('#dom_window_settings').count(), 0);
    assert.equal(await page.evaluate(() => window.stats.detachedRuntimeCount), 0);
    await page.evaluate(async () => { window.fixture.entryModule = await import('/extension/index.js?reinstall=1'); });
    await page.locator('#dom_window_autostart').waitFor(); await page.locator('#dom_window_autostart').uncheck(); await enable(page); await idle(page);
    windowValid(await state(page), 5); await pass('扩展卸载与重新加载', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10&helperVersion=4.10.0'), before = await state(page);
    await page.evaluate(() => window.STDOMWindow.enable({ minWindow: 10, maxWindow: 10 })); const data = await state(page);
    assert.equal(data.audit.enabled, false); assert.deepEqual(data.ids, before.ids); assert.equal(data.data, before.data);
    await pass('低于 4.11.0 的助手版本拒绝启动，避免半成品回收', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10&helperVersion=4.12.1');
    await enable(page); await idle(page);
    const data = await state(page); windowValid(data, 10);
    assert.equal(data.audit.enabled, true);
    await pass('4.12.1 等更高助手版本按同一信号开启窗口', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=337&preload=10'); await enable(page); await idle(page);
    assert.equal(await page.evaluate(() => window.STDOMWindow.getMessageElement(15)?.getAttribute('mesid')), '15');
    await idle(page); const data = await state(page); windowValid(data, 10); assert(data.ids.includes(15));
    await pass('同步查找旧楼层时移动完整窗口', page, errors);
  }
  {
    const { page, errors } = await open('variant=compat&count=37');
    await page.evaluate(async () => {
      const { createRenderQueue } = await import('/extension/render-queue.js');
      window.stallCalls = 0;
      window.stallQueue = createRenderQueue({ getRoot: () => document.querySelector('#chat'), getChat: () => window.fixture.ctx.chat,
        markSelfRender: () => {}, settleMs: 0, stallMs: 60,
        refresh: () => { window.stallCalls++; return new Promise(resolve => { window.finishStall = resolve; }); } });
      window.stallQueue.enqueue([30, 31], { force: true });
    });
    await page.waitForFunction(() => window.stallQueue.snapshot().running === 1);
    const result = await page.evaluate(async () => {
      window.stallQueue.cancel();
      let errorName; try { await window.stallQueue.whenIdle(); } catch (error) { errorName = error.name; }
      window.stallQueue.enqueue([31], { force: true });
      return { errorName, pending: window.stallQueue.snapshot().pending, calls: window.stallCalls, stalled: window.stallQueue.snapshot().stalled };
    });
    assert.deepEqual(result, { errorName: 'TimeoutError', pending: 0, calls: 1, stalled: true });
    await page.evaluate(() => window.finishStall()); await page.waitForFunction(() => window.stallQueue.snapshot().running === 0);
    await page.evaluate(() => window.stallQueue.dispose()); await pass('挂起恢复取消后仍有超时守护，不启动第二个恢复调用', page, errors);
  }
  await writeFile(path.join(output, 'test-report.json'), JSON.stringify({ date: new Date().toISOString(), engine: 'Chrome headless', findings,
    limitation: '合成聊天及模拟助手强引用模型；不是真实 iOS Safari 长期测试' }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: findings.length, findings }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
