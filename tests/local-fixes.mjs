// Regression checks for the 2026-11-09 local preview: truncation restore after
// an automatic reload, generation hold watchdog and closed-window diagnostics.
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
const output = path.resolve(process.env.DOM_WINDOW_TEST_OUTPUT || path.join(repository, '../test-results-local-fixes'));
const only = process.env.DOM_WINDOW_ONLY ? new Set(process.env.DOM_WINDOW_ONLY.split(',')) : null;
await mkdir(path.join(output, 'temp'), { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let target;
    if (url.pathname === '/') target = path.join(repository, 'tests/fixture.html');
    else if (url.pathname === '/fixture.js') target = path.join(repository, 'tests/fixture.js');
    else if (url.pathname === '/jquery.js') target = path.join(repository, 'tests/vendor/jquery.min.js');
    else if (url.pathname.startsWith('/extension/')) {
      const name = url.pathname.slice('/extension/'.length);
      if (path.basename(name) !== name || !/\.(js|css|html)$/.test(name)) { res.writeHead(404).end(); return; }
      target = path.join(source, name);
    } else { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(target)] || 'application/octet-stream') + '; charset=utf-8');
    res.end(await readFile(target));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
let browser;

async function idle(page) {
  await page.waitForFunction(() => {
    const a = window.STDOMWindow?.audit();
    return a?.enabled && a.mounted && !a.applying && !a.paused && !a.generating && a.renderQueue.running === 0 && a.renderQueue.pending === 0;
  }, null, { timeout: 22000 });
}
async function open(query = '', { enable = true, seed } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (seed) {
    await context.addInitScript(values => {
      if (sessionStorage.getItem('local-fixes.seeded')) return;
      sessionStorage.setItem('local-fixes.seeded', '1');
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, seed);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?variant=compat&count=337&preload=5' + query);
  await page.waitForFunction(() => window.fixtureReady);
  if (enable) { await page.locator('#dom_window_autostart').check(); await idle(page); }
  return { context, page, errors };
}
async function run(name, body) {
  if (only && !only.has(name)) return;
  try {
    const detail = await body();
    results.push({ name, passed: true, ...(detail ? { detail } : {}) });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error?.stack || error) });
    console.log('FAIL', name, error?.message);
    process.exitCode = 1;
  }
}
const generating = page => page.evaluate(() => window.STDOMWindow.audit().generating);
const events = page => page.evaluate(() => window.STDOMWindow.diagnostics().currentPage.events.map(entry => entry.event));
const closed = page => page.waitForFunction(() => !window.STDOMWindow.audit().enabled && !window.STDOMWindow.audit().applying);

try {
  browser = await engines[engine].launch({ headless: true,
    ...(process.env.DOM_WINDOW_BROWSER ? { executablePath: process.env.DOM_WINDOW_BROWSER }
      : engine === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}),
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });

  await run('truncation-after-auto-reload', async () => {
    // State left by a page that enabled the window and was then reloaded
    // without closing it: ST kept the reduced value, localStorage the original.
    const { context, page, errors } = await open('&truncation=15', { enable: false,
      seed: { 'STDOMWindow.scrollfix.enabled': '1', 'STDOMWindow.compat.originalTruncation': '40' } });
    try {
      await idle(page);
      assert.equal(await page.evaluate(() => window.fixture.ctx.powerUserSettings.chat_truncation), 15);
      await page.locator('#dom_window_autostart').uncheck();
      await closed(page);
      const after = await page.evaluate(() => ({ truncation: window.fixture.ctx.powerUserSettings.chat_truncation,
        stored: localStorage.getItem('STDOMWindow.compat.originalTruncation') }));
      assert.equal(after.truncation, 40, 'closing restores the user original, not the value left by the extension');
      assert.equal(after.stored, null);
      assert.deepEqual(errors, []);
      return after;
    } finally { await context.close(); }
  });

  await run('truncation-first-enable-unchanged', async () => {
    const { context, page, errors } = await open('&truncation=33');
    try {
      const during = await page.evaluate(() => ({ truncation: window.fixture.ctx.powerUserSettings.chat_truncation,
        stored: localStorage.getItem('STDOMWindow.compat.originalTruncation') }));
      assert.equal(during.truncation, 15);
      assert.equal(during.stored, '33');
      await page.locator('#dom_window_autostart').uncheck();
      await closed(page);
      assert.equal(await page.evaluate(() => window.fixture.ctx.powerUserSettings.chat_truncation), 33);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await run('slash-command-start-does-not-hold', async () => {
    const { context, page, errors } = await open();
    try {
      await page.evaluate(() => window.fixture.ctx.eventSource.emit('generation_started', 'normal', {}, false));
      assert.equal(await generating(page), false, 'a slash command stops before AFTER_COMMANDS and must not freeze the window');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await run('watchdog-releases-orphaned-start', async () => {
    const { context, page, errors } = await open();
    try {
      await page.evaluate(async () => {
        window.STDOMWindow.config.generationWatchdogMs = 1500;
        // Like a failed server ping: past the commands step, never ended.
        await window.fixture.ctx.eventSource.emit('generation_after_commands', 'normal', {}, false);
      });
      assert.equal(await generating(page), true);
      await page.evaluate(() => window.fixture.jumpTopSpacer(0.5));
      await page.waitForTimeout(400);
      const held = await page.evaluate(() => window.STDOMWindow.audit());
      assert.equal(held.generating, true);
      await page.waitForFunction(() => !window.STDOMWindow.audit().generating, null, { timeout: 6000 });
      await page.evaluate(() => window.fixture.jumpTopSpacer(0.5));
      await idle(page);
      const after = await page.evaluate(() => window.STDOMWindow.audit());
      assert(after.start < held.start, 'history above the held window mounts after the watchdog');
      assert((await events(page)).includes('generation-watchdog'));
      assert.deepEqual(errors, []);
      return { heldStart: held.start, afterStart: after.start };
    } finally { await context.close(); }
  });

  await run('watchdog-keeps-real-generation', async () => {
    const { context, page, errors } = await open();
    try {
      await page.evaluate(async () => {
        window.STDOMWindow.config.generationWatchdogMs = 1500;
        window.fixtureGenerating = true;
        await window.fixture.ctx.eventSource.emit('generation_after_commands', 'normal', {}, false);
      });
      await page.waitForTimeout(3600);
      assert.equal(await generating(page), true, 'Helper duringGenerating keeps the hold');
      await page.evaluate(() => { window.fixtureGenerating = false; document.body.dataset.generating = 'true'; });
      await page.waitForTimeout(3600);
      assert.equal(await generating(page), true, 'ST body[data-generating] keeps the hold');
      await page.evaluate(() => {
        delete document.body.dataset.generating;
        return window.fixture.ctx.eventSource.emit('generation_ended', 0);
      });
      await idle(page);
      assert(!(await events(page)).includes('generation-watchdog'));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await run('watchdog-rearms-for-late-request', async () => {
    const { context, page, errors } = await open();
    try {
      await page.evaluate(async () => {
        window.STDOMWindow.config.generationWatchdogMs = 1200;
        await window.fixture.ctx.eventSource.emit('generation_after_commands', 'normal', {}, false);
      });
      await page.waitForFunction(() => !window.STDOMWindow.audit().generating, null, { timeout: 6000 });
      // A very long prompt build: the request becomes visible only now.
      await page.evaluate(() => { document.body.dataset.generating = 'true'; });
      await page.waitForFunction(() => window.STDOMWindow.audit().generating, null, { timeout: 3000 });
      await page.evaluate(() => {
        delete document.body.dataset.generating;
        return window.fixture.ctx.eventSource.emit('generation_ended', 0);
      });
      await idle(page);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await run('closed-window-records-generation', async () => {
    const { context, page, errors } = await open('', { enable: false });
    try {
      await page.waitForTimeout(1300);
      const recorded = await page.evaluate(async () => {
        const source = window.fixture.ctx.eventSource;
        await source.emit('generation_started', 'normal', {}, true);
        const afterDryRun = window.STDOMWindow.diagnostics().currentPage.events.map(entry => entry.event);
        await source.emit('generation_started', 'normal', {}, false);
        await source.emit('generation_ended', 0);
        const report = window.STDOMWindow.diagnostics();
        return { afterDryRun, events: report.currentPage.events.map(entry => entry.event),
          enabled: window.STDOMWindow.enabled, domNodes: report.currentPage.metrics.domNodes,
          build: document.getElementById('dom_window_build')?.textContent };
      });
      assert.equal(recorded.enabled, false);
      assert(!recorded.afterDryRun.includes('generation-start'), 'dry runs are not recorded');
      assert.deepEqual(recorded.events.slice(-2), ['generation-start', 'generation-end']);
      assert(recorded.domNodes > 100);
      assert.equal(recorded.build, '2026-11-14 · 助手版本与复制修复');
      assert.deepEqual(errors, []);
      return recorded;
    } finally { await context.close(); }
  });

  await run('open-window-records-generation-once', async () => {
    const { context, page, errors } = await open();
    try {
      const recorded = await page.evaluate(async () => {
        const source = window.fixture.ctx.eventSource;
        await source.emit('generation_started', 'normal', {}, false);
        await source.emit('generation_after_commands', 'normal', {}, false);
        await source.emit('generation_ended', 0);
        await new Promise(resolve => setTimeout(resolve, 600));
        return window.STDOMWindow.diagnostics().currentPage.events.map(entry => entry.event);
      });
      assert.equal(recorded.filter(event => event === 'generation-start').length, 1);
      assert.equal(recorded.filter(event => event === 'generation-end').length, 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `local-fixes-${engine}.json`), JSON.stringify({ engine, source,
    environment: 'Synthetic SillyTavern page and Helper 4.12.0 model; not a phone crash reproduction.', results }, null, 2));
}
