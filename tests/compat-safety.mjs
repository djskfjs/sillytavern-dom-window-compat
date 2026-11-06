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
const output = path.resolve(process.env.DOM_WINDOW_TEST_OUTPUT || path.join(repository, '../test-results-compat-safety'));
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
let browser;
const results = [];
async function snapshot(page) {
  return page.evaluate(() => {
    const ctx = window.fixture.ctx;
    const root = document.querySelector('#chat');
    return {
      boots: Number(sessionStorage.getItem('fixture.boots')),
      audit: window.STDOMWindow.audit(),
      backup: !!ctx.extensionSettings.STDOMWindow_helper_backup,
      render: { ...ctx.extensionSettings.tavern_helper.render },
      ids: [...root.querySelectorAll(':scope > .mes')].map(el => Number(el.getAttribute('mesid'))),
      frames: root.querySelectorAll('iframe').length,
      printCalls: window.safetyPrintCalls,
      tailRetained: window.safetyTail === root.querySelector('.last_mes'),
      heldCalls: window.safetyHeldCalls || 0,
    };
  });
}
async function idle(page) {
  await page.waitForFunction(() => {
    const a = window.STDOMWindow?.audit();
    return a?.enabled && a.mounted && !a.applying && !a.paused && a.renderQueue.running === 0 && a.renderQueue.pending === 0;
  }, null, { timeout: 22000 });
}
async function open(needsAdaptation = true) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?variant=compat&count=337&preload=5' + (needsAdaptation ? '&helperDepth=8&helperStreaming=1' : ''));
  await page.waitForFunction(() => window.fixtureReady);
  await page.locator('#dom_window_autostart').check();
  await idle(page);
  await page.evaluate(() => {
    const print = window.fixture.ctx.printMessages;
    window.safetyPrintCalls = 0;
    window.fixture.ctx.printMessages = (...args) => { window.safetyPrintCalls++; return print(...args); };
    window.safetyTail = document.querySelector('#chat > .last_mes');
  });
  const before = await snapshot(page);
  assert.equal(before.backup, needsAdaptation);
  assert.equal(before.boots, needsAdaptation ? 2 : 1, 'initial configuration reload is counted separately');
  return { context, page, errors, before };
}
async function hidden(page, value) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}
async function stall(page) {
  await page.evaluate(async () => {
    const original = window.TavernHelper.refreshOneMessage;
    let held = false;
    window.safetyHeldCalls = 0;
    window.TavernHelper.refreshOneMessage = (...args) => {
      if (held) return original(...args);
      held = true;
      window.safetyHeldCalls++;
      return new Promise(resolve => { window.safetyFinish = async () => { await original(...args); resolve(); }; });
    };
    await window.fixture.scrollToFraction(0);
  });
  await page.waitForFunction(() => window.STDOMWindow.audit().renderQueue.running === 1);
}
function preserved(after, before) {
  assert.equal(after.boots, before.boots, 'fault must not navigate');
  assert.equal(after.audit.enabled, true, 'fault retains the selected window mode');
  assert.equal(after.audit.paused, true, 'fault pauses further work');
  assert.equal(after.backup, before.backup, 'fault must not silently restore helper settings');
  assert.deepEqual(after.render, before.render);
  assert.equal(after.printCalls, 0, 'fault must not expand to ordinary full rendering');
  assert.equal(after.tailRetained, true, 'the existing last message remains mounted');
  assert(after.ids.length > 0 && after.ids.length <= 6, 'fault keeps the bounded remaining window');
}
async function run(name, callback) {
  if (process.env.DOM_WINDOW_SAFETY_CASE && !process.env.DOM_WINDOW_SAFETY_CASE.split('|').some(part => name.includes(part))) return;
  const started = Date.now();
  try {
    const details = await callback();
    const result = { case: name, result: 'passed', elapsedMs: Date.now() - started, ...details };
    results.push(result);
    console.log('PASS', name);
  } catch (error) {
    results.push({ case: name, result: 'failed', elapsedMs: Date.now() - started, error: String(error.stack || error) });
    console.error('FAIL', name, error.message);
    process.exitCode = 1;
  }
}
try {
  const executablePath = process.env.DOM_WINDOW_BROWSER || (engine === 'chromium' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  browser = await engines[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  await Promise.all([
    ...[true, false].map(needsAdaptation => run(`15-second stall preserves page and ${needsAdaptation ? 'adapted' : 'already compatible'} helper settings`, async () => {
      const { context, page, errors, before } = await open(needsAdaptation);
      try {
        await stall(page);
        const pending = await snapshot(page);
        await page.waitForFunction(() => window.STDOMWindow?.audit().paused === true, null, { timeout: 22000 });
        // Include two recovery sweeps: an indirect restore must not reload later.
        await page.waitForTimeout(2200);
        const after = await snapshot(page);
        preserved(after, before);
        assert.deepEqual(after.ids, pending.ids, 'timeout does not tear down the mounted window');
        assert.equal(after.heldCalls, 1);
        assert.deepEqual(errors, []);
        if (needsAdaptation) await page.screenshot({ path: path.join(output, `paused-window-${engine}.png`) });
        return { before, after };
      } finally { await context.close(); }
    })),
    run('mount failure pauses without automatic restoration or navigation', async () => {
      const { context, page, errors, before } = await open();
      try {
        await page.evaluate(async () => { window.failMountId = 0; await window.fixture.scrollToFraction(0); });
        await page.waitForFunction(() => window.STDOMWindow?.audit().paused === true);
        await page.waitForTimeout(2200);
        const after = await snapshot(page);
        preserved(after, before);
        await page.locator('#dom_window_autostart').uncheck();
        await page.waitForFunction(boots => Number(sessionStorage.getItem('fixture.boots')) > boots && window.fixtureReady && window.STDOMWindow?.enabled === false,
          before.boots);
        const closed = await snapshot(page);
        assert.equal(closed.boots, before.boots + 1, 'an explicit close still restores and reloads once');
        assert.equal(closed.backup, false);
        assert.equal(closed.render.depth, 8);
        assert.equal(closed.render.allow_streaming, true);
        assert.deepEqual(errors, []);
        return { before, after, closed };
      } finally { await context.close(); }
    }),
    run('hidden page pauses pending work and resumes the requested reading position', async () => {
      const { context, page, errors, before } = await open();
      try {
        await page.evaluate(() => { window.safetyFrames = [...document.querySelectorAll('#chat iframe')]; });
        await hidden(page, true);
        await page.waitForTimeout(150);
        await hidden(page, false);
        await idle(page);
        assert.equal(await page.evaluate(() => {
          const frames = [...document.querySelectorAll('#chat iframe')];
          return frames.length === window.safetyFrames.length && frames.every((frame, i) => frame === window.safetyFrames[i]);
        }), true, 'returning to a stationary page reuses iframe instances');
        await hidden(page, true);
        await page.evaluate(() => window.fixture.scrollToFraction(0));
        await page.waitForTimeout(400);
        const background = await snapshot(page);
        assert.equal(background.audit.renderQueue.suspended, true);
        assert.deepEqual(background.ids, before.ids, 'background scroll does not recycle or mount a new window');
        assert.equal(background.frames, before.frames);
        assert.equal(background.boots, before.boots);
        await hidden(page, false);
        await page.waitForFunction(() => window.STDOMWindow.audit().start === 0);
        await idle(page);
        const after = await snapshot(page);
        assert.equal(after.audit.renderQueue.suspended, false);
        assert.equal(after.audit.paused, false);
        assert.equal(after.boots, before.boots);
        assert(after.ids.includes(0));
        assert.deepEqual(errors, []);
        return { before, background, after };
      } finally { await context.close(); }
    }),
    run('background time does not consume an active frontend timeout or cause a second call', async () => {
      const { context, page, errors, before } = await open();
      try {
        await stall(page);
        await hidden(page, true);
        await page.waitForTimeout(16000);
        const background = await snapshot(page);
        assert.equal(background.audit.renderQueue.suspended, true);
        assert.equal(background.audit.renderQueue.stalled, false);
        assert.equal(background.audit.paused, false);
        assert.equal(background.heldCalls, 1);
        assert.equal(background.boots, before.boots);
        await hidden(page, false);
        await page.waitForTimeout(200);
        const resumed = await snapshot(page);
        assert.equal(resumed.audit.paused, false, 'foreground gets the unspent timeout budget');
        assert.equal(resumed.heldCalls, 1);
        await page.evaluate(() => window.safetyFinish());
        await idle(page);
        const after = await snapshot(page);
        assert.equal(after.boots, before.boots);
        assert.equal(after.audit.paused, false);
        assert.equal(after.audit.renderQueue.running, 0);
        assert.deepEqual(errors, []);
        return { before, background, after };
      } finally { await context.close(); }
    }),
    run('diagnostic data omits chat, credentials and page URL, including display output', async () => {
      const { context, page, errors, before } = await open();
      try {
        const report = await page.evaluate(() => {
          const ctx = window.fixture.ctx;
          ctx.chat[0] = { ...ctx.chat[0], mes: 'PRIVATE_CHAT_SENTINEL', name: 'PRIVATE_CHARACTER_SENTINEL' };
          ctx.extensionSettings.unrelated = { apiKey: 'PRIVATE_KEY_SENTINEL', baseUrl: 'https://private-sentinel.invalid/api' };
          history.replaceState(null, '', '/?private=PRIVATE_URL_SENTINEL');
          return window.STDOMWindow.diagnostics();
        });
        const encoded = JSON.stringify(report);
        for (const value of ['PRIVATE_CHAT_SENTINEL', 'PRIVATE_CHARACTER_SENTINEL', 'PRIVATE_KEY_SENTINEL',
          'private-sentinel.invalid', 'PRIVATE_URL_SENTINEL', origin]) assert.equal(encoded.includes(value), false, value);
        assert.equal(report.version, before.audit.version);
        await page.locator('#dom_window_diagnostics').click();
        const displayed = await page.locator('#dom_window_diagnostics_output').inputValue();
        assert.doesNotThrow(() => JSON.parse(displayed));
        for (const value of ['PRIVATE_', 'private-sentinel.invalid', origin]) assert.equal(displayed.includes(value), false, value);
        assert.equal((await snapshot(page)).boots, before.boots);
        assert.deepEqual(errors, []);
        return { fields: Object.keys(report), bytes: encoded.length };
      } finally { await context.close(); }
    }),
    run('manual reload is blocked during generation and works after it finishes', async () => {
      const { context, page, errors, before } = await open();
      try {
        await page.evaluate(async () => { window.failMountId = 0; await window.fixture.scrollToFraction(0); });
        await page.waitForFunction(() => window.STDOMWindow?.audit().paused === true);
        await page.evaluate(() => { window.fixtureGenerating = true; });
        await page.locator('#dom_window_reload').click();
        await page.waitForTimeout(300);
        const blocked = await snapshot(page);
        assert.equal(blocked.boots, before.boots);
        assert.equal(blocked.audit.paused, true);
        assert.equal(blocked.backup, true);
        await page.evaluate(() => { window.fixtureGenerating = false; });
        await page.locator('#dom_window_reload').click();
        await page.waitForFunction(boots => Number(sessionStorage.getItem('fixture.boots')) > boots && window.fixtureReady, before.boots);
        await idle(page);
        const after = await snapshot(page);
        assert.equal(after.boots, before.boots + 1);
        assert.equal(after.audit.paused, false);
        assert.equal(after.backup, true, 'manual refresh resumes the selected window, without undoing its configuration');
        assert.deepEqual(errors, []);
        return { before, blocked, after };
      } finally { await context.close(); }
    }),
    run('blocked browser storage keeps initialization usable and does not orphan helper backups', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.addInitScript(() => {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function(key, ...args) {
            if (this === window.localStorage && String(key).startsWith('STDOMWindow')) throw new DOMException('Storage blocked for test', 'SecurityError');
            return original.call(this, key, ...args);
          };
        }
      });
      try {
        await page.goto(origin + '/?variant=compat&count=37&helperDepth=8&helperStreaming=1');
        await page.waitForFunction(() => window.fixtureReady && !!window.STDOMWindow);
        await page.locator('#dom_window_autostart').click();
        await page.waitForFunction(() => document.querySelector('#dom_window_autostart').disabled === false);
        const blocked = await snapshot(page);
        assert.equal(blocked.boots, 1);
        assert.equal(blocked.audit.enabled, false, 'cannot persist an owner: do not auto-adapt settings');
        assert.equal(blocked.backup, false, 'no unreachable restoration backup is created');
        assert.equal(blocked.render.depth, 8);
        assert.equal(blocked.render.allow_streaming, true);
        assert.equal(await page.evaluate(() => window.STDOMWindow.diagnostics().storageAvailable), false);
        // Already compatible settings need no persistent backup, so memory-only
        // window preferences can still be used within the current page.
        await page.goto(origin + '/?variant=compat&count=37');
        await page.waitForFunction(() => window.fixtureReady && !!window.STDOMWindow);
        await page.locator('#dom_window_autostart').check();
        await idle(page);
        const compatible = await snapshot(page);
        assert.equal(compatible.audit.enabled, true);
        assert.equal(compatible.backup, false);
        assert(compatible.ids.length <= 6);
        assert.deepEqual(errors, []);
        return { blocked, compatible };
      } finally { await context.close(); }
    }),
    ...[true, false].map(needsAdaptation => run(`extension unload restores ordinary rows with a suspended frontend and ${needsAdaptation ? 'adapted' : 'already compatible'} helper`, async () => {
      const { context, page, errors, before } = await open(needsAdaptation);
      try {
        await stall(page);
        await hidden(page, true);
        const unloaded = await page.evaluate(async () => {
          const previous = window.STDOMWindow;
          const result = await Promise.race([
            window.fixture.entryModule.disable().then(() => ({ finished: true })),
            new Promise(resolve => setTimeout(() => resolve({ finished: false }), 2500)),
          ]);
          return { ...result, present: !!window.STDOMWindow,
            boots: Number(sessionStorage.getItem('fixture.boots')),
            queue: previous.audit().renderQueue, calls: window.safetyHeldCalls,
            settingsPanel: !!document.querySelector('#dom_window_settings'),
            spacers: document.querySelectorAll('#chat .dom-window-spacer').length,
            rows: document.querySelectorAll('#chat > .mes').length,
            render: { ...window.fixture.ctx.extensionSettings.tavern_helper.render },
            backup: !!window.fixture.ctx.extensionSettings.STDOMWindow_helper_backup };
        });
        assert.equal(unloaded.finished, true, 'unload must not wait forever for the unabortable helper promise');
        assert.equal(unloaded.present, false);
        assert.equal(unloaded.settingsPanel, false);
        assert.equal(unloaded.boots, before.boots);
        assert.equal(unloaded.queue.pending, 0);
        assert.equal(unloaded.calls, 1);
        assert.equal(unloaded.spacers, 0, 'unload removes the window spacers even if configuration restoration needs a later reload');
        assert.equal(unloaded.rows, 20, 'unload restores the fixture default ordinary message count');
        assert.equal(unloaded.backup, false);
        assert.equal(unloaded.render.depth, needsAdaptation ? 8 : 0);
        assert.equal(unloaded.render.allow_streaming, needsAdaptation);
        await hidden(page, false);
        await page.evaluate(() => window.safetyFinish());
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(() => ({ present: !!window.STDOMWindow,
          boots: Number(sessionStorage.getItem('fixture.boots')), calls: window.safetyHeldCalls,
          spacers: document.querySelectorAll('#chat .dom-window-spacer').length,
          rows: document.querySelectorAll('#chat > .mes').length })),
          { present: false, boots: before.boots, calls: 1, spacers: 0, rows: 20 });
        assert.deepEqual(errors, []);
        return { before, unloaded };
      } finally { await context.close(); }
    })),
  ]);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `compat-safety-${engine}.json`), JSON.stringify({ engine, source,
    environment: 'Desktop engine with repository synthetic chat and helper fixture. Visibility events are simulated; this is not an iPhone or actual memory-pressure test.', results }, null, 2));
}
