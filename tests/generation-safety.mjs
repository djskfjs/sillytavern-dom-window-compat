import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const engines = createRequire(import.meta.url)('playwright');
const engine = process.env.DOM_WINDOW_ENGINE || 'chromium';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.env.DOM_WINDOW_TEST_SOURCE || repository);
const output = path.resolve(process.env.DOM_WINDOW_TEST_OUTPUT || path.join(repository, '../generation-safety'));
const reproduce = process.env.DOM_WINDOW_REPRODUCE === '1';
await mkdir(path.join(output, 'temp'), { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.slice('/extension/'.length);
    const file = url.pathname === '/' ? path.join(repository, 'tests/fixture.html')
      : url.pathname === '/fixture.js' ? path.join(repository, 'tests/fixture.js')
      : url.pathname === '/jquery.js' ? path.join(repository, 'tests/vendor/jquery.min.js')
      : url.pathname.startsWith('/extension/') && path.basename(name) === name && /\.(js|css|html)$/.test(name)
        ? path.join(source, name) : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(file)] || 'text/plain') + '; charset=utf-8');
    res.end(await readFile(file));
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
async function open(query = '') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?variant=compat&count=337&preload=5' + query);
  await page.waitForFunction(() => window.fixtureReady);
  await page.locator('#dom_window_autostart').check();
  await idle(page);
  await page.evaluate(() => {
    const ctx = window.fixture.ctx;
    for (const name of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED']) ctx.event_types[name] = name.toLowerCase();
    window.generationStats = { refreshes: 0, releases: 0 };
    const refresh = window.TavernHelper.refreshOneMessage;
    window.TavernHelper.refreshOneMessage = (...args) => {
      if (window.fixtureGenerating) window.generationStats.refreshes++;
      return refresh(...args);
    };
    ctx.eventSource.on('TH_REQUEST_RENDER_MESSAGE', () => {
      if (window.fixtureGenerating) window.generationStats.releases++;
    });
    window.beginStreaming = async (type = 'normal') => {
      window.fixtureGenerating = true;
      await ctx.eventSource.emit('generation_started', type, {}, false);
      await ctx.eventSource.emit('generation_after_commands', type, {}, false);
      const id = ctx.chat.length;
      ctx.chat.push({ mes: '<html><body>streaming</body></html>', is_user: false, swipe_id: 0 });
      ctx.addOneMessage(ctx.chat[id], { forceId: id });
      window.streamingElement = document.querySelector(`#chat > .mes[mesid="${id}"]`);
      const root = document.querySelector('#chat');
      root.scrollTop = root.scrollHeight;
      root.dispatchEvent(new Event('scroll'));
      return { id, starts: window.stats.started, data: JSON.stringify(ctx.chat) };
    };
    window.finishStreaming = async (event = 'generation_ended') => {
      const id = ctx.chat.length - 1;
      window.fixtureGenerating = false;
      await ctx.eventSource.emit(ctx.event_types.CHARACTER_MESSAGE_RENDERED, id);
      await ctx.eventSource.emit(event, ctx.chat.length);
    };
  });
  return { context, page, errors };
}
async function state(page) {
  return page.evaluate(() => ({
    audit: window.STDOMWindow.audit(), stats: { ...window.generationStats }, starts: window.stats.started,
    streamingFrames: window.streamingElement?.querySelectorAll('iframe').length || 0,
    data: JSON.stringify(window.fixture.ctx.chat), boots: Number(sessionStorage.getItem('fixture.boots')),
    retained: window.streamingElement === document.querySelector('#chat > .last_mes'),
    detached: window.stats.detachedRuntimeCount,
    ids: [...document.querySelectorAll('#chat > .mes')].map(el => Number(el.getAttribute('mesid'))),
  }));
}
try {
  browser = await engines[engine].launch({ headless: true,
    ...(process.env.DOM_WINDOW_BROWSER ? { executablePath: process.env.DOM_WINDOW_BROWSER } : engine === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}),
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  for (const scrollHistory of [false, true]) {
    const { context, page, errors } = await open();
    try {
      const before = await page.evaluate(() => window.beginStreaming());
      if (scrollHistory) await page.evaluate(() => window.fixture.jumpTopSpacer(0.7));
      await page.waitForTimeout(700);
      const during = await state(page);
      if (!reproduce) {
        assert.equal(during.streamingFrames, 0, 'unfinished reply must not start a helper frontend');
        assert.deepEqual(during.stats, { refreshes: 0, releases: 0 }, 'no recovery audit while generating');
        assert.equal(during.starts, before.starts);
        assert.equal(during.data, before.data);
        assert.equal(during.retained, true);
      }
      await page.evaluate(() => window.finishStreaming());
      await idle(page);
      const after = await state(page);
      if (!reproduce) {
        assert(after.ids.length <= 6, 'window resumes and trims after generation');
        assert.equal(after.streamingFrames, 1, 'native completion frontend is retained');
        assert.equal(after.detached, 0);
        assert.equal(after.boots, 1);
        assert.equal(after.retained, true);
        assert.equal(after.data, before.data);
        assert.deepEqual(errors, []);
      }
      results.push({ case: scrollHistory ? 'scroll history during streaming' : 'streaming append and native auto-scroll', before, during, after });
      console.log(reproduce ? 'BASELINE' : 'PASS', results.at(-1).case, JSON.stringify(during.stats), 'prematureFrames=' + during.streamingFrames);
    } finally { await context.close(); }
  }
  if (!reproduce) {
    {
      const { context, page, errors } = await open();
      try {
        await page.evaluate(() => {
          const refresh = window.TavernHelper.refreshOneMessage;
          window.TavernHelper.refreshOneMessage = async (...args) => {
            if (!window.finishHeldRefresh) await new Promise(resolve => { window.finishHeldRefresh = resolve; });
            return refresh(...args);
          };
        });
        await page.evaluate(() => window.fixture.jumpTopSpacer(0.7));
        await page.waitForFunction(() => !!window.finishHeldRefresh);
        await page.evaluate(async () => {
          window.fixtureGenerating = true;
          await window.fixture.ctx.eventSource.emit('generation_started', 'continue', {}, false);
          window.finishHeldRefresh();
        });
        await page.waitForTimeout(300);
        assert.equal((await state(page)).audit.renderQueue.suspended, true);
        await page.evaluate(() => window.finishStreaming());
        await idle(page);
        assert.equal(await page.locator('#chat > .mes[style*="min-height"]').count(), 0, 'completed in-flight recovery releases reserved height');
        assert.equal(await page.locator('.dom-window-render-pending, .dom-window-render-hint').count(), 0);
        assert.deepEqual(errors, []);
        results.push({ case: 'generation interrupts in-flight frontend recovery' }); console.log('PASS', results.at(-1).case);
      } finally { await context.close(); }
    }
    {
      const { context, page, errors } = await open();
      try {
        await page.evaluate(async () => {
          const source = window.fixture.ctx.eventSource;
          await source.emit('generation_started', 'normal', {}, true);
          await source.emit('generation_after_commands', 'quiet', {}, false);
          await source.emit('generation_started', 'impersonate', {}, false);
        });
        assert.equal((await state(page)).audit.generating, false);
        await page.evaluate(() => window.fixture.jumpTopSpacer(0.7)); await idle(page);
        assert.deepEqual(errors, []);
        results.push({ case: 'dry-run, quiet and impersonation do not hold the reading window' }); console.log('PASS', results.at(-1).case);
      } finally { await context.close(); }
    }
    for (const ending of ['stop-before-final-render', 'background', 'back-to-back', 'enable-during-generation']) {
      const { context, page, errors } = await open();
      try {
        if (ending === 'enable-during-generation') await page.evaluate(() => window.STDOMWindow.disable());
        await page.evaluate(() => window.beginStreaming());
        if (ending === 'enable-during-generation') await page.evaluate(() => window.STDOMWindow.enable({ minWindow: 5 }));
        if (ending === 'stop-before-final-render') {
          await page.evaluate(() => window.fixture.ctx.eventSource.emit('generation_stopped'));
          await page.waitForTimeout(450);
          assert.equal((await state(page)).audit.generating, true, 'STOP must not race remaining native streaming updates');
        }
        if (ending === 'background') await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.evaluate(() => window.finishStreaming());
        if (ending === 'back-to-back') {
          await page.evaluate(() => window.beginStreaming());
          await page.waitForTimeout(450);
          const during = await state(page);
          assert.equal(during.audit.generating, true);
          assert.deepEqual(during.stats, { refreshes: 0, releases: 0 });
          assert.equal(during.streamingFrames, 0);
          await page.evaluate(() => window.finishStreaming());
        }
        if (ending === 'background') {
          await page.waitForTimeout(450);
          assert.equal((await state(page)).audit.renderQueue.suspended, true);
          await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
            document.dispatchEvent(new Event('visibilitychange'));
          });
        }
        await idle(page);
        const after = await state(page);
        assert(after.ids.length <= 6);
        assert.equal(after.streamingFrames, 1);
        assert.equal(after.detached, 0);
        assert.equal(after.boots, 1);
        assert.equal(after.retained, true);
        assert.deepEqual(errors, []);
        results.push({ case: ending, after }); console.log('PASS', ending);
      } finally { await context.close(); }
    }
    {
      const { context, page, errors } = await open();
      try {
        await page.evaluate(() => {
          const source = window.fixture.ctx.eventSource;
          const emit = source.emit.bind(source);
          window.releaseCalls = 0;
          source.emit = async (name, ...args) => {
            if (name === 'TH_REQUEST_RENDER_MESSAGE') {
              window.releaseCalls++;
              if (window.releaseCalls === 1) await new Promise(resolve => { window.finishRelease = resolve; });
            }
            return emit(name, ...args);
          };
        });
        await page.evaluate(() => window.fixture.jumpTopSpacer(0.7));
        await page.waitForFunction(() => !!window.finishRelease);
        await page.evaluate(() => window.beginStreaming());
        await page.evaluate(() => window.finishRelease());
        await page.waitForTimeout(450);
        assert.equal(await page.evaluate(() => window.releaseCalls), 1, 'an in-flight cleanup must not chain additional audits into generation');
        assert.equal((await state(page)).stats.refreshes, 0);
        await page.evaluate(() => window.finishStreaming());
        await idle(page);
        const after = await state(page);
        assert(after.ids.length <= 6);
        assert.equal(after.detached, 0);
        assert.equal(after.boots, 1);
        assert.equal(after.retained, true);
        assert.deepEqual(errors, []);
        results.push({ case: 'generation interrupts asynchronous cleanup', after });
        console.log('PASS', results.at(-1).case);
      } finally { await context.close(); }
    }
    {
      const { context, page, errors } = await open();
      try {
        for (let turn = 0; turn < 30; turn++) {
          const before = await page.evaluate(() => window.beginStreaming());
          await page.evaluate(() => window.fixture.jumpTopSpacer(0.7));
          await page.waitForTimeout(40);
          const during = await state(page);
          assert.equal(during.streamingFrames, 0);
          assert.equal(during.data, before.data);
          assert.deepEqual(during.stats, { refreshes: 0, releases: 0 });
          await page.evaluate(() => window.finishStreaming());
          await idle(page);
          const after = await state(page);
          assert(after.ids.length <= 6);
          assert.equal(after.detached, 0);
          assert.equal(after.retained, true);
          assert.equal(after.boots, 1);
          assert.equal(after.data, before.data);
        }
        assert.deepEqual(errors, []);
        results.push({ case: '30 streaming turns with history scrolling', after: await state(page) });
        console.log('PASS', results.at(-1).case);
      } finally { await context.close(); }
    }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `generation-safety-${engine}.json`), JSON.stringify({ engine, source,
    environment: 'Synthetic SillyTavern streaming DOM and Helper 4.12.0 lifecycle; not a phone crash reproduction.', results }, null, 2));
}
