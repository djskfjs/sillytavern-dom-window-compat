import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const engines = createRequire(import.meta.url)('playwright');
const engine = process.env.DOM_WINDOW_ENGINE || 'chromium';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.DOM_WINDOW_TEST_OUTPUT || path.join(repository, '../diagnostics-tests'));
await mkdir(path.join(output, 'temp'), { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.slice('/extension/'.length);
    const file = url.pathname === '/' ? path.join(repository, 'tests/fixture.html')
      : url.pathname === '/fixture.js' ? path.join(repository, 'tests/fixture.js')
      : url.pathname === '/jquery.js' ? path.join(repository, 'tests/vendor/jquery.min.js')
      : url.pathname.startsWith('/extension/') && path.basename(name) === name && /\.(js|css|html)$/.test(name)
        ? path.join(repository, name) : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[path.extname(file)] || 'text/plain') + '; charset=utf-8');
    res.end(await readFile(file));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
let browser;
async function open() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?variant=compat&count=37&preload=5');
  await page.waitForFunction(() => window.fixtureReady && document.getElementById('dom_window_diagnostics'));
  return { context, page, errors };
}
async function run(name, action) {
  if (process.env.DOM_WINDOW_DIAGNOSTIC_CASE && !name.includes(process.env.DOM_WINDOW_DIAGNOSTIC_CASE)) return;
  const { context, page, errors } = await open();
  try {
    await action(page);
    assert.deepEqual(errors, []);
    results.push({ name, passed: true });
  } finally { await context.close(); }
}
try {
  browser = await engines[engine].launch({ headless: true,
    ...(process.env.DOM_WINDOW_BROWSER ? { executablePath: process.env.DOM_WINDOW_BROWSER }
      : engine === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}),
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  for (const mode of ['legacy', 'modern', 'missing', 'rejected', 'throws', 'pending', 'getter-throws']) {
    await run(`clipboard ${mode}: truthful result and selectable complete report`, async page => {
      await page.evaluate(mode => {
        window.copyCalls = [];
        document.execCommand = command => {
          window.copyCalls.push(command);
          window.copied = document.querySelector('#dom_window_diagnostics_output').value;
          return mode === 'legacy';
        };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
          if (mode === 'getter-throws') throw new DOMException('Denied', 'SecurityError');
          return mode === 'missing' ? undefined : { writeText(text) {
            window.copyCalls.push('writeText'); window.modernCopied = text;
            if (mode === 'throws') throw new DOMException('Denied', 'NotAllowedError');
            if (mode === 'pending') return new Promise(() => {});
            return mode === 'modern' ? Promise.resolve() : Promise.reject(new DOMException('Denied', 'NotAllowedError'));
          } };
        } });
      }, mode);
      await page.locator('#dom_window_diagnostics').click();
      await page.waitForFunction(() => !document.querySelector('#dom_window_diagnostics').disabled);
      const feedback = await page.locator('#dom_window_diagnostics_feedback').textContent();
      assert.match(feedback, ['legacy', 'modern'].includes(mode) ? /已复制/ : /未允许自动复制/);
      const calls = await page.evaluate(() => window.copyCalls);
      assert.equal(calls[0], 'copy', 'fallback runs synchronously during the click');
      if (mode === 'legacy') assert.deepEqual(calls, ['copy']);
      await page.locator('#dom_window_diagnostics_select').click();
      const selection = await page.locator('#dom_window_diagnostics_output').evaluate(el => ({
        start: el.selectionStart, end: el.selectionEnd, text: el.value,
        css: getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect, font: getComputedStyle(el).fontSize,
      }));
      assert.equal(selection.start, 0); assert.equal(selection.end, selection.text.length);
      assert.equal(JSON.parse(selection.text).format, 3);
      assert.equal(selection.css, 'text'); assert.equal(selection.font, '16px');
      if (mode === 'modern') assert.equal(await page.evaluate(() => window.modernCopied), selection.text);
      if (mode === 'legacy') assert.equal(await page.evaluate(() => window.copied), selection.text);
      if (mode === 'rejected') {
        const downloading = page.waitForEvent('download');
        await page.locator('#dom_window_diagnostics_download').click();
        const download = await downloading;
        assert.equal(download.suggestedFilename(), 'DOM-Window-诊断.json');
        const saved = path.join(output, 'download.json'); await download.saveAs(saved);
        assert.equal(await readFile(saved, 'utf8'), selection.text);
        await page.screenshot({ path: path.join(output, 'manual-copy-mobile.png'), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout fits viewport');
      }
    });
  }
  await run('real browser copy event receives the selected report', async page => {
    await page.evaluate(() => {
      document.addEventListener('copy', event => {
        const output = document.querySelector('#dom_window_diagnostics_output');
        window.copyEventText = output.value.slice(output.selectionStart, output.selectionEnd);
        event.clipboardData.setData('text/plain', window.copyEventText);
        event.preventDefault();
      });
    });
    await page.locator('#dom_window_diagnostics').click();
    await page.waitForFunction(() => !document.querySelector('#dom_window_diagnostics').disabled);
    assert.match(await page.locator('#dom_window_diagnostics_feedback').textContent(), /已复制/);
    assert.equal(await page.evaluate(() => window.copyEventText), await page.locator('#dom_window_diagnostics_output').inputValue());
  });
  await run('modern clipboard remains usable when text selection throws', async page => {
    await page.evaluate(() => {
      document.querySelector('#dom_window_diagnostics_output').setSelectionRange = () => { throw new Error('Selection unavailable'); };
      document.execCommand = () => { throw new Error('Must not copy an unknown selection'); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText(text) { window.modernCopied = text; return Promise.resolve(); },
      } });
    });
    await page.locator('#dom_window_diagnostics').click();
    await page.waitForFunction(() => !document.querySelector('#dom_window_diagnostics').disabled);
    assert.match(await page.locator('#dom_window_diagnostics_feedback').textContent(), /已复制/);
    assert.equal(await page.evaluate(() => window.modernCopied), await page.locator('#dom_window_diagnostics_output').inputValue());
    await page.locator('#dom_window_diagnostics_select').click();
    assert.match(await page.locator('#dom_window_diagnostics_feedback').textContent(), /未能全选/);
  });
  await run('empty chat: preset samples capture script frames while window disabled, survive reload', async page => {
    await page.evaluate(async () => {
      const ctx = window.fixture.ctx;
      ctx.chat = []; ctx.printMessages();
      await ctx.eventSource.emit(ctx.event_types.CHAT_CHANGED);
      for (let i = 0; i < 4; i++) {
        const frame = document.createElement('iframe'); frame.id = `TH-script--private-name--${i}`;
        frame.srcdoc = '<p>private-content</p>'; frame.hidden = true; document.body.append(frame);
      }
      const select = document.createElement('select'); select.id = 'settings_preset_openai'; document.body.append(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await ctx.eventSource.emit('oai_preset_changed_before', { presetName: 'private-name', preset: { key: 'private-key' } });
      document.querySelector('iframe[id^="TH-script--"]').remove();
      await ctx.eventSource.emit('oai_preset_changed_after');
      await ctx.eventSource.emit('preset_changed', { name: 'private-name' });
    });
    await page.waitForFunction(() => window.STDOMWindow.diagnostics().currentPage.lastPreset?.events.some(entry => entry.event === 'preset-settled'));
    const before = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.equal(before.currentPage.metrics.chatLength, 0);
    assert.equal(before.currentPage.metrics.enabled, false);
    const selected = before.currentPage.lastPreset.events.find(entry => entry.event === 'preset-selected');
    assert.equal(selected.metrics.framesOutsideChat, 4); assert.equal(selected.metrics.helperScriptFrames, 4);
    const after = before.currentPage.lastPreset.events.find(entry => entry.event === 'preset-after');
    assert.equal(after.metrics.helperScriptFrames, 3); assert.equal(after.metrics.framesInChat, 0);
    assert.doesNotMatch(JSON.stringify(before), /private-/);
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const previous = await page.evaluate(() => window.STDOMWindow.diagnostics().previousPage);
    assert.deepEqual(previous.lastPreset, before.currentPage.lastPreset);
    assert(previous.events.some(entry => entry.event === 'preset-before'));
    assert.equal(previous.programmaticReload, undefined, 'test reload does not fabricate an extension reload request');
  });
  await run('enabled window: programmatic preset changes preserve chat, frames and settings', async page => {
    await page.locator('#dom_window_autostart').check();
    await page.waitForFunction(() => {
      const audit = window.STDOMWindow.audit();
      return audit.mounted && !audit.applying && !audit.renderQueue.running && !audit.renderQueue.pending;
    });
    await page.evaluate(async () => {
      window.beforePreset = {
        chat: JSON.stringify(window.fixture.ctx.chat), settings: JSON.stringify(window.fixture.ctx.extensionSettings),
        frames: [...document.querySelectorAll('#chat iframe')], calls: window.stats.calls.length,
        releases: window.stats.releaseEvents.length, boots: sessionStorage.getItem('fixture.boots'),
      };
      const select = document.createElement('select'); select.id = 'settings_preset_openai'; document.body.append(select);
      window.jQuery(select).on('change', () => window.fixture.ctx.eventSource.emit('oai_preset_changed_before'));
      window.jQuery(select).trigger('change');
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_after');
      await window.fixture.ctx.eventSource.emit('preset_changed', { apiId: 'openai', name: 'private-name' });
    });
    await page.waitForFunction(() => window.STDOMWindow.diagnostics().currentPage.lastPreset?.events.some(entry => entry.event === 'preset-settled'));
    const result = await page.evaluate(() => ({
      sameChat: window.beforePreset.chat === JSON.stringify(window.fixture.ctx.chat),
      sameSettings: window.beforePreset.settings === JSON.stringify(window.fixture.ctx.extensionSettings),
      sameFrames: window.beforePreset.frames.every(frame => frame.isConnected),
      sameCalls: window.beforePreset.calls === window.stats.calls.length,
      sameReleases: window.beforePreset.releases === window.stats.releaseEvents.length,
      sameBoots: window.beforePreset.boots === sessionStorage.getItem('fixture.boots'),
      diagnostic: window.STDOMWindow.diagnostics(),
    }));
    for (const key of ['sameChat', 'sameSettings', 'sameFrames', 'sameCalls', 'sameReleases', 'sameBoots']) assert.equal(result[key], true, key);
    assert.equal(result.diagnostic.currentPage.lastPreset.events[0].event, 'preset-before');
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /private-/);
  });
  await run('new preset selection cancels delayed samples from the preceding selection', async page => {
    await page.evaluate(async () => {
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_before');
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_after');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => window.fixture.ctx.eventSource.emit('oai_preset_changed_before'));
    await page.waitForTimeout(3200);
    const events = await page.evaluate(() => window.STDOMWindow.diagnostics().currentPage.lastPreset.events);
    assert.deepEqual(events.map(entry => entry.event), ['preset-before']);
  });
  await run('diagnostic storage denied is reported independently of settings storage', async page => {
    await page.goto(origin + '/?variant=compat&count=37&noDiagnosticStorage=1');
    await page.waitForFunction(() => window.fixtureReady && document.getElementById('dom_window_diagnostics'));
    const result = await page.evaluate(async () => {
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_before');
      return window.STDOMWindow.diagnostics();
    });
    assert.equal(result.storageAvailable, false);
    assert.equal(result.settingsStorageAvailable, true);
    assert.equal(result.diagnosticStorageAvailable, false);
    assert.equal(result.currentPage.lastEvent, 'preset-before');
    await page.locator('#dom_window_diagnostics').click();
    assert.equal(JSON.parse(await page.locator('#dom_window_diagnostics_output').inputValue()).diagnosticStorageAvailable, false);
    assert.equal(result.diagnosticBackupAvailable, true);
  });
  await run('identical page counts still produce distinct reports and retain preceding page identities', async page => {
    const first = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.equal(first.recovery.observation, 'no-previous-record');
    assert.match(await page.locator('#dom_window_diagnostics_summary').textContent(), /没有取得本标签页的上次记录/);
    const another = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.notEqual(first.reportId, another.reportId);
    assert.equal(first.currentPage.pageId, another.currentPage.pageId);
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const second = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.notEqual(first.currentPage.pageId, second.currentPage.pageId);
    assert.equal(second.previousPage.pageId, first.currentPage.pageId);
    assert.equal(first.currentPage.metrics.framesInPage, second.currentPage.metrics.framesInPage);
    assert.equal(second.recovery.cause, 'unknown');
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const third = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.deepEqual(third.previousPages.map(record => record.pageId), [second.currentPage.pageId, first.currentPage.pageId]);
    await page.locator('#dom_window_diagnostics').click();
    await page.waitForFunction(() => !document.querySelector('#dom_window_diagnostics').disabled);
    const shown = JSON.parse(await page.locator('#dom_window_diagnostics_output').inputValue());
    assert.equal(shown.recovery.retainedPreviousPages, 2);
    const summary = await page.locator('#dom_window_diagnostics_summary').textContent();
    assert.match(summary, /保留 2 次历史页面记录/);
    assert(summary.includes(third.currentPage.pageId.slice(-8)));
    assert(summary.includes(second.currentPage.pageId.slice(-8)));
    await page.screenshot({ path: path.join(output, 'reload-history-mobile.png'), fullPage: true });
  });
  await run('session report loss recovers the matching browser backup', async page => {
    const first = await page.evaluate(() => window.STDOMWindow.diagnostics());
    await page.addInitScript(() => sessionStorage.removeItem('STDOMWindow.compat.diagnostics'));
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const after = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.equal(after.recovery.source, 'browser-backup');
    assert.equal(after.previousPage.pageId, first.currentPage.pageId);
  });
  await run('lost session and tab identity expose backup records as unlinked rather than declaring a restart', async page => {
    const first = await page.evaluate(() => window.STDOMWindow.diagnostics());
    await page.addInitScript(() => {
      sessionStorage.removeItem('STDOMWindow.compat.diagnostics');
      sessionStorage.removeItem('STDOMWindow.compat.diagnosticTab');
    });
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    const after = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.equal(after.previousPage, null);
    assert.equal(after.recovery.observation, 'no-previous-record');
    assert.equal(after.unlinkedBrowserPages[0].pageId, first.currentPage.pageId);
    assert.match(after.recovery.message, /不能判断/);
  });
  await run('extension reloading within one document keeps the same page and prior evidence', async page => {
    const first = await page.evaluate(() => window.STDOMWindow.diagnostics());
    await page.evaluate(async () => {
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_before');
      await window.fixture.entryModule.disable();
      window.fixture.entryModule = await import('/extension/index.js?reinitialize-history');
    });
    await page.waitForFunction(() => !!window.STDOMWindow && !!document.getElementById('dom_window_diagnostics'));
    const after = await page.evaluate(() => window.STDOMWindow.diagnostics());
    assert.equal(after.currentPage.pageId, first.currentPage.pageId);
    assert.equal(after.currentPage.startedAt, first.currentPage.startedAt);
    assert.equal(after.previousPage, null);
    assert(after.currentPage.events.some(entry => entry.event === 'extension-reloaded'));
    assert(after.currentPage.lastPreset.events.some(entry => entry.event === 'preset-before'));
  });
  if (engine === 'chromium') await run('renderer process crash retains pre-crash evidence without a pagehide event', async page => {
    await page.evaluate(() => window.fixture.ctx.eventSource.emit('oai_preset_changed_before'));
    const before = await page.evaluate(() => window.STDOMWindow.diagnostics());
    const devtools = await page.context().newCDPSession(page);
    const crashed = page.waitForEvent('crash', { timeout: 10000 });
    void devtools.send('Page.crash').catch(() => {});
    await crashed;
    // Playwright marks its Page as crashed permanently. Use the still-connected
    // target's DevTools session to reload and inspect the same browser tab.
    async function reloadCrashedTab(previousId) {
      await devtools.send('Page.reload');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const evaluated = await devtools.send('Runtime.evaluate', {
            expression: 'JSON.stringify(window.fixtureReady && window.STDOMWindow ? window.STDOMWindow.diagnostics() : null)',
            returnByValue: true,
          });
          const report = JSON.parse(evaluated.result.value || 'null');
          if (report && report.currentPage.pageId !== previousId) return report;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Crashed tab did not load a new diagnostic page');
    }
    const after = await reloadCrashedTab(before.currentPage.pageId);
    assert.equal(after.previousPage.pageId, before.currentPage.pageId);
    assert.notEqual(after.currentPage.pageId, before.currentPage.pageId);
    assert.equal(after.previousPage.lastPreset.events[0].event, 'preset-before');
    assert.equal(after.previousPage.pageExit, undefined);
    assert.equal(after.recovery.observation, 'no-page-exit-recorded');
    assert.equal(after.recovery.cause, 'unknown', 'evidence does not identify the cause of a crash');
    assert.equal(after.previousPage.metrics.framesInPage, after.currentPage.metrics.framesInPage);
    const next = await reloadCrashedTab(after.currentPage.pageId);
    assert(next.previousPages.some(record => record.pageId === before.currentPage.pageId));
    await writeFile(path.join(output, 'renderer-crash-evidence.json'), JSON.stringify({
      environment: 'Desktop Chrome synthetic test; renderer terminated through DevTools Page.crash. Not an iPhone crash reproduction.',
      before: { pageId: before.currentPage.pageId, startedAt: before.currentPage.startedAt,
        frames: before.currentPage.metrics.framesInPage, lastEvent: before.currentPage.lastEvent },
      after: { pageId: after.currentPage.pageId, startedAt: after.currentPage.startedAt,
        frames: after.currentPage.metrics.framesInPage, recovery: after.recovery, previousPage: after.previousPage },
      afterSecondReload: { pageId: next.currentPage.pageId, retainedPageIds: next.previousPages.map(record => record.pageId) },
    }, null, 2));
    await devtools.detach();
  });
  await run('disposing removes preset diagnostics listeners', async page => {
    await page.evaluate(async () => {
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_after');
      await window.fixture.entryModule.disable();
      window.savedDiagnostic = sessionStorage.getItem('STDOMWindow.compat.diagnostics');
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_before');
      await window.fixture.ctx.eventSource.emit('oai_preset_changed_after');
    });
    assert.equal(await page.evaluate(() => !!window.STDOMWindow), false);
    // Cover pending preset samples and the periodic rebind/checkpoint timer.
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('STDOMWindow.compat.diagnostics')), await page.evaluate(() => window.savedDiagnostic));
  });
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `diagnostics-${engine}.json`), JSON.stringify({ engine, results }, null, 2));
}
console.log(JSON.stringify({ engine, passed: results.length, results }));
