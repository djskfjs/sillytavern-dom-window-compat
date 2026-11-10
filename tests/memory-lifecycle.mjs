// Synthetic browser regression for detached rows retained by height reservations.
// This checks strong references, not process memory or an iPhone Jetsam threshold.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const engines = createRequire(import.meta.url)('playwright');
const engine = process.env.DOM_WINDOW_ENGINE || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('DOM_WINDOW_ENGINE must be chromium, firefox, or webkit');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.env.DOM_WINDOW_TEST_SOURCE || repository);
const output = path.resolve(process.env.DOM_WINDOW_TEST_OUTPUT || path.join(repository, '../memory-lifecycle'));
const reproduce = process.env.DOM_WINDOW_REPRODUCE === '1';
const only = process.env.DOM_WINDOW_ONLY ? new Set(process.env.DOM_WINDOW_ONLY.split(',')) : null;
await mkdir(path.join(output, 'temp'), { recursive: true });

function instrument(text) {
  const mapDeclaration = '  const reservations = new Map();';
  const applyDeclaration = '  function apply(force = false) {';
  assert(text.includes(mapDeclaration) && text.includes(applyDeclaration), 'moving-window instrumentation anchors exist');
  // Inject read-only numeric inspection into the response, never the source file.
  // The getter does not keep another array, DOM node, or WeakRef alive.
  return text.replace(mapDeclaration, mapDeclaration + `
  let testApplyCalls = 0;
  window.__memoryLifecycleAudit = () => ({
    reservations: reservations.size,
    detached: [...reservations.keys()].filter(element => !element.isConnected).length,
    outsideChat: [...reservations.keys()].filter(element => !root()?.contains(element)).length,
    currentReservations: [...reservations.keys()].filter(element => root()?.contains(element)).length,
    applyCalls: testApplyCalls,
    matches: matches() ? 1 : 0,
  });`).replace(applyDeclaration, applyDeclaration + '\n    testApplyCalls++;');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file;
    if (url.pathname === '/') file = path.join(repository, 'tests/fixture.html');
    else if (url.pathname === '/fixture.js') file = path.join(repository, 'tests/fixture.js');
    else if (url.pathname === '/jquery.js') file = path.join(repository, 'tests/vendor/jquery.min.js');
    else if (url.pathname.startsWith('/extension/')) {
      const name = url.pathname.slice('/extension/'.length);
      if (path.basename(name) !== name || !/\.(js|css|html)$/.test(name)) { res.writeHead(404).end(); return; }
      file = path.join(source, name);
    } else { res.writeHead(404).end(); return; }
    let text = await readFile(file, 'utf8');
    if (path.basename(file) === 'moving-window.js') text = instrument(text);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(file)] || 'text/plain') + '; charset=utf-8');
    res.end(text);
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
let browser;

async function idle(page, { empty = false, afterApply = -1 } = {}) {
  await page.waitForFunction(({ empty, afterApply }) => {
    const a = window.STDOMWindow?.audit(), memory = window.__memoryLifecycleAudit?.();
    return a?.enabled && !a.applying && !a.paused && !a.generating &&
      a.renderQueue.running === 0 && a.renderQueue.pending === 0 && memory?.applyCalls > afterApply &&
      (empty ? a.chatLength === 0 : a.mounted && memory.matches === 1);
  }, { empty, afterApply }, { timeout: 22000 });
}
async function inspect(page) {
  return page.evaluate(() => ({
    ...window.__memoryLifecycleAudit(),
    currentRows: document.querySelectorAll('#chat > .mes').length,
    connectedFrames: document.querySelectorAll('#chat iframe').length,
    helperDetachedRuntimes: window.stats.detachedRuntimeCount,
    queue: window.STDOMWindow.audit().renderQueue,
  }));
}
async function open(query = '') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?variant=compat&count=337&preload=5&delay=1500' + query);
  await page.waitForFunction(() => window.fixtureReady && window.__memoryLifecycleAudit);
  await page.locator('#dom_window_autostart').check();
  await idle(page);
  return { context, page, errors };
}
async function run(name, action) {
  if (only && !only.has(name)) return;
  let context, page;
  const history = [];
  try {
    const opened = await open();
    ({ context, page } = opened);
    await action(page, history);
    assert.deepEqual(opened.errors, []);
    results.push({ name, passed: true, history });
    console.log(reproduce ? 'BASELINE' : 'PASS', name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error.stack || error), history,
      last: page ? await inspect(page).catch(() => null) : null });
    console.log('FAIL', name, error.message);
    process.exitCode = 1;
  } finally { await context?.close(); }
}
async function createPendingRows(page) {
  await page.evaluate(() => window.fixture.jumpTopSpacer(0.45));
  await page.waitForFunction(() => {
    const a = window.STDOMWindow.audit(), memory = window.__memoryLifecycleAudit();
    return !a.applying && memory.currentReservations > 0 && a.renderQueue.pending + a.renderQueue.running > 0;
  }, null, { timeout: 15000 });
}
async function switchChat(page, length) {
  const before = await page.evaluate(() => window.__memoryLifecycleAudit().applyCalls);
  await page.evaluate(length => window.fixture.switchChat(length), length);
  await idle(page, { empty: length === 0, afterApply: before });
}
function assertReleased(snapshot, label) {
  assert.equal(snapshot.detached, 0, `${label}: detached rows must not remain in height reservations`);
  assert.equal(snapshot.outsideChat, 0, `${label}: reservations belong to the current chat DOM`);
  assert.equal(snapshot.helperDetachedRuntimes, 0, `${label}: fixture helper runtimes are also released`);
}

try {
  browser = await engines[engine].launch({ headless: true,
    ...(process.env.DOM_WINDOW_BROWSER ? { executablePath: process.env.DOM_WINDOW_BROWSER }
      : engine === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}),
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });

  for (const waitForCompletion of [false, true]) {
    await run(waitForCompletion ? 'switch-after-complete' : 'switch-while-pending', async (page, history) => {
      for (let cycle = 1; cycle <= 3; cycle++) {
        await createPendingRows(page);
        if (waitForCompletion) await idle(page);
        history.push({ phase: `cycle-${cycle}-before-switch`, ...await inspect(page) });
        await switchChat(page, 337);
        history.push({ phase: `cycle-${cycle}-after-switch`, ...await inspect(page) });
      }
      const after = history.filter(entry => entry.phase.endsWith('-after-switch'));
      if (reproduce && !waitForCompletion) {
        const counts = after.map(entry => entry.detached);
        assert(counts[0] > 0 && counts[1] > counts[0] && counts[2] > counts[1], 'baseline retains more detached rows each cycle');
      } else {
        after.forEach(entry => assertReleased(entry, entry.phase));
      }
      // Existing recovery helps distinguish retained references from a claim
      // that they can never be released. Start alone does not resume the window.
      await page.evaluate(async () => {
        window.fixtureGenerating = true;
        await window.fixture.ctx.eventSource.emit('generation_after_commands', 'normal', {}, false);
      });
      history.push({ phase: 'generation-start', ...await inspect(page) });
      assert.equal(history.at(-1).detached, after.at(-1).detached);
      await page.evaluate(async () => {
        window.fixtureGenerating = false;
        await window.fixture.ctx.eventSource.emit('generation_ended');
      });
      await idle(page);
      history.push({ phase: 'generation-resume', ...await inspect(page) });
      assertReleased(history.at(-1), 'generation resume');
    });
  }

  await run('switch-to-empty-chat-while-pending', async (page, history) => {
    await createPendingRows(page);
    history.push({ phase: 'before-empty-chat', ...await inspect(page) });
    await switchChat(page, 0);
    history.push({ phase: 'empty-chat', ...await inspect(page) });
    assert.equal(history.at(-1).currentRows, 0);
    if (reproduce) assert(history.at(-1).detached > 0, 'baseline retains pending rows on its empty-chat early return');
    else assertReleased(history.at(-1), 'empty chat');
    await switchChat(page, 337);
    history.push({ phase: 'chat-reopened', ...await inspect(page) });
    if (!reproduce) assertReleased(history.at(-1), 'chat reopened');
  });

  await run('repeated-generation-append-and-history-scroll', async (page, history) => {
    const originalLength = await page.evaluate(() => window.fixture.ctx.chat.length);
    for (let cycle = 1; cycle <= 3; cycle++) {
      await page.evaluate(async () => {
        const ctx = window.fixture.ctx;
        window.fixtureGenerating = true;
        await ctx.eventSource.emit('generation_after_commands', 'normal', {}, false);
        const id = ctx.chat.length;
        ctx.chat.push({ mes: '<html><body>streaming</body></html>', is_user: false, swipe_id: 0 });
        ctx.addOneMessage(ctx.chat[id], { forceId: id });
      });
      await page.evaluate(() => window.fixture.jumpTopSpacer(0.65));
      history.push({ phase: `cycle-${cycle}-generating`, ...await inspect(page) });
      assertReleased(history.at(-1), 'while generating');
      assert.equal(history.at(-1).queue.suspended, true);
      await page.evaluate(async () => {
        const ctx = window.fixture.ctx;
        window.fixtureGenerating = false;
        await ctx.eventSource.emit(ctx.event_types.CHARACTER_MESSAGE_RENDERED, ctx.chat.length - 1);
        await ctx.eventSource.emit('generation_ended', ctx.chat.length);
      });
      await idle(page);
      history.push({ phase: `cycle-${cycle}-completed`, ...await inspect(page) });
      assertReleased(history.at(-1), 'after generation');
      assert(history.at(-1).currentRows <= 6, 'window remains bounded after appending');
      await page.evaluate(() => window.fixture.jumpTopSpacer(0.35));
      await idle(page);
      history.push({ phase: `cycle-${cycle}-history`, ...await inspect(page) });
      assertReleased(history.at(-1), 'history window');
      assert(history.at(-1).currentRows <= 6, 'window remains bounded after scrolling');
    }
    assert.equal(await page.evaluate(() => window.fixture.ctx.chat.length), originalLength + 3, 'chat data retains all generated messages');
  });
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `memory-lifecycle-${engine}.json`), JSON.stringify({
    engine, source, reproduce,
    environment: 'Synthetic browser fixture; no iPhone or process-memory claim. Numeric auditing injected only into served test responses.',
    results,
  }, null, 2));
}
