import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStorage, createDiagnostics, getDiagnosticPageId } from '../runtime-support.js';

test('explicit reload marker survives pagehide and only accepts known reasons', () => {
  const values = new Map();
  const native = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const storage = createBrowserStorage(() => native);
  const first = createDiagnostics({ storage, version: 'test', now: () => 100 });
  first.markReload('private-url');
  assert.equal(first.snapshot().currentPage.programmaticReload, undefined);
  first.markReload('manual-recovery'); first.record('pagehide');
  const next = createDiagnostics({ storage, version: 'test', now: () => 200 });
  assert.deepEqual(next.snapshot().previousPage.programmaticReload, { at: 100, reason: 'manual-recovery' });
  assert.equal(next.snapshot().previousPage.lastEvent, 'pagehide');
});

const diagnosticKey = 'STDOMWindow.compat.diagnostics';
function storageFixture(seed = {}) {
  const values = new Map(Object.entries(seed));
  const raw = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  return { raw, values, storage: createBrowserStorage(() => raw) };
}

test('denied Storage getter falls back to in-page values without throwing', () => {
  const storage = createBrowserStorage(() => { throw new DOMException('Access denied', 'SecurityError'); });
  assert.equal(storage.persistent, false);
  assert.equal(storage.getItem('missing'), null);
  storage.setItem('window', 5); assert.equal(storage.getItem('window'), '5');
  storage.setItem('window', 10); assert.equal(storage.getItem('window'), '10');
  storage.removeItem('window'); assert.equal(storage.getItem('window'), null);
});

test('setItem and removeItem failures preserve latest in-page values', () => {
  const { raw, storage, values } = storageFixture({ window: '5' });
  assert.equal(storage.persistent, true);
  assert.equal(storage.getItem('window'), '5');
  raw.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  raw.removeItem = () => { throw new DOMException('Denied', 'SecurityError'); };
  storage.setItem('window', 12);
  assert.equal(storage.persistent, false);
  assert.equal(storage.getItem('window'), '12');
  assert.equal(values.get('window'), '5', 'failed write did not alter persistent data');
  storage.removeItem('window');
  assert.equal(storage.getItem('window'), null, 'failed removal must not expose stale persistent value');
});

test('read failures do not prevent subsequent in-page settings or diagnostics', () => {
  const { raw, storage } = storageFixture();
  raw.getItem = () => { throw new DOMException('Denied', 'SecurityError'); };
  assert.equal(storage.getItem('missing'), null);
  assert.equal(storage.persistent, false);
  storage.setItem('enabled', true); assert.equal(storage.getItem('enabled'), 'true');
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 100 });
  diagnostics.record('load'); diagnostics.record('enabled', { enabled: true });
  assert.equal(diagnostics.snapshot().currentPage.metrics.enabled, true);
});

test('diagnostics also run when the Storage getter is unavailable throughout', () => {
  const storage = createBrowserStorage(() => { throw new Error('Storage unavailable'); });
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 100 });
  diagnostics.record('load'); diagnostics.checkpoint({ messagesInDom: 5 });
  assert.equal(diagnostics.snapshot().previousPage, null);
  assert.equal(diagnostics.snapshot().currentPage.metrics.messagesInDom, 5);
  const reloaded = createDiagnostics({ storage, version: 'test', now: () => 200 });
  assert.equal(reloaded.snapshot().previousPage.startedAt, 100, 'same wrapper retains its memory fallback');
});

test('malformed JSON and invalid previous record shapes are ignored', () => {
  for (const saved of ['{', 'null', '[]', '42', '"private-chat"', '{"schema":2,"startedAt":100}', '{"schema":1,"startedAt":"private-token"}']) {
    const { storage } = storageFixture({ [diagnosticKey]: saved });
    const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 200 });
    assert.equal(diagnostics.snapshot().previousPage, null, saved);
    assert.doesNotThrow(() => diagnostics.record('load'));
  }
});

test('nonfinite or negative previous start times are ignored; invalid update times fall back', () => {
  for (const startedAt of ['1e999', '-1']) {
    const { storage } = storageFixture({ [diagnosticKey]: `{"schema":1,"startedAt":${startedAt}}` });
    const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 200 });
    assert.equal(diagnostics.snapshot().previousPage, null, startedAt);
  }
  for (const updatedAt of ['1e999', '-1', '"private-url"']) {
    const { storage } = storageFixture({ [diagnosticKey]: `{"schema":1,"startedAt":100,"updatedAt":${updatedAt}}` });
    const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 200 });
    assert.equal(diagnostics.snapshot().previousPage.updatedAt, 100, updatedAt);
  }
});

test('previous diagnostics retain only allowed metadata, event names and scalar metrics', () => {
  const saved = { schema: 1, version: 'private-token', startedAt: 100, updatedAt: 120,
    lastEvent: 'private-chat', chat: 'private-chat', url: 'private-url', token: 'private-token',
    events: [{ event: 'private-chat', token: 'private-token' }],
    metrics: { enabled: true, messagesInDom: 5, chat: 'private-chat', url: 'private-url', token: 'private-token',
      framesInChat: { token: 'private-token' }, chatLength: 'private-chat', paused: null, pending: -1 } };
  const { storage } = storageFixture({ [diagnosticKey]: JSON.stringify(saved) });
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 200 });
  assert.deepEqual(diagnostics.snapshot().previousPage, { schema: 1, startedAt: 100, updatedAt: 120, lastEvent: 'unknown',
    metrics: { enabled: true, messagesInDom: 5 } });
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-(chat|url|token)/);
});

test('record and checkpoint filter arbitrary fields, nested values and invalid numbers', () => {
  const { storage, values } = storageFixture();
  let now = 100;
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => now++ });
  diagnostics.record('enabled', { enabled: true, messagesInDom: 5, chat: 'private-chat', url: 'private-url',
    token: 'private-token', framesInChat: NaN, framesInPage: Infinity, pending: -1, paused: { token: 'private-token' } });
  assert.deepEqual(diagnostics.snapshot().currentPage.metrics, { enabled: true, messagesInDom: 5 });
  const before = diagnostics.snapshot();
  diagnostics.record('private-token', { token: 'private-token', enabled: false });
  assert.deepEqual(diagnostics.snapshot(), before, 'unknown event must not update or persist anything');
  diagnostics.checkpoint({ background: false, chatLength: 37, chat: 'private-chat', url: 'private-url', token: 'private-token',
    messagesInDom: 'private-chat', running: [] });
  assert.deepEqual(diagnostics.snapshot().currentPage.metrics, { background: false, chatLength: 37 });
  assert.doesNotMatch(values.get(diagnosticKey), /private-(chat|url|token)/);
});

test('event history is capped at the latest 24 entries in memory and persistent storage', () => {
  const { storage, values } = storageFixture();
  let now = 100;
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => now++ });
  const expected = [];
  for (let i = 0; i < 80; i++) {
    const event = i % 2 ? 'visible' : 'hidden';
    diagnostics.record(event, { background: i % 2 === 0 });
    expected.push({ at: now - 1, event, metrics: { background: i % 2 === 0 } });
  }
  assert.deepEqual(diagnostics.snapshot().currentPage.events, expected.slice(-24));
  assert.deepEqual(JSON.parse(values.get(diagnosticKey)).currentPage.events, expected.slice(-24));
  assert.equal(diagnostics.snapshot().currentPage.lastEvent, 'visible');
});

test('exported snapshots do not allow callers to mutate future diagnostic records', () => {
  const { storage } = storageFixture();
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 100 });
  diagnostics.record('enabled', { enabled: true });
  const exported = diagnostics.snapshot();
  exported.currentPage.metrics.token = 'private-token';
  exported.currentPage.events.push({ event: 'private-chat' });
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-(chat|token)/);
});

test('reload preserves event-time counts, build and last event time independently of checkpoints', () => {
  const { storage } = storageFixture();
  let time = 100;
  const first = createDiagnostics({ storage, version: '0.4.3-compat.6', build: '本地预览-20261108-诊断复制与预设追踪', now: () => time });
  first.record('preset-before', { framesOutsideChat: 4, helperScriptFrames: 4 });
  time = 200;
  first.record('preset-after', { framesOutsideChat: 7, helperScriptFrames: 7 });
  time = 400;
  first.checkpoint({ framesOutsideChat: 3, helperScriptFrames: 3 });
  const next = createDiagnostics({ storage, version: '0.4.3-compat.6', now: () => 500 }).snapshot().previousPage;
  assert.equal(next.version, '0.4.3-compat.6');
  assert.equal(next.build, '本地预览-20261108-诊断复制与预设追踪');
  assert.equal(next.lastEventAt, 200);
  assert.equal(next.updatedAt, 400);
  assert.equal(next.metrics.helperScriptFrames, 3);
  assert.deepEqual(next.events.map(entry => entry.metrics.helperScriptFrames), [4, 7]);
});

test('last preset evidence survives unrelated event churn but resets for the next selection', () => {
  const { storage } = storageFixture();
  let time = 100;
  const first = createDiagnostics({ storage, version: 'test', now: () => time++ });
  first.record('preset-selected', { helperScriptFrames: 4 });
  first.record('preset-before', { helperScriptFrames: 4 });
  first.record('preset-after', { helperScriptFrames: 8 });
  for (let i = 0; i < 40; i++) first.record('visible', { background: false });
  const next = createDiagnostics({ storage, version: 'test', now: () => time++ }).snapshot().previousPage;
  assert.equal(next.events.length, 24);
  assert.deepEqual(next.lastPreset.events.map(entry => entry.event), ['preset-selected', 'preset-before', 'preset-after']);
  first.record('preset-before', { helperScriptFrames: 1 });
  assert.equal(first.snapshot().currentPage.lastPreset.events.length, 1);
  first.record('preset-after');
  for (let i = 0; i < 30; i++) first.record('preset-sample');
  assert.equal(first.snapshot().currentPage.lastPreset.events.length, 8);
  assert.equal(first.snapshot().currentPage.lastPreset.events[0].event, 'preset-before');
  const reloaded = createDiagnostics({ storage, version: 'test', now: () => time++ }).snapshot().previousPage;
  assert.equal(reloaded.lastPreset.events[0].event, 'preset-before');
  assert.equal(reloaded.lastPreset.events[0].metrics.helperScriptFrames, 1);
});

test('old schema-one event history remains readable without invented new evidence', () => {
  const { storage } = storageFixture({ [diagnosticKey]: JSON.stringify({ schema: 1, version: '0.4.3-compat.6',
    startedAt: 100, updatedAt: 300, lastEvent: 'generation-end', metrics: { framesInPage: 4 },
    events: [{ at: 100, event: 'load' }, { at: 200, event: 'generation-end' }] }) });
  const previous = createDiagnostics({ storage, version: 'test' }).snapshot().previousPage;
  assert.equal(previous.events.length, 2);
  assert.equal(previous.lastEventAt, undefined, 'old heartbeat time is not the event time');
  assert.equal(previous.lastPreset, undefined);
});

test('saved events and preset evidence are sanitized before being re-exported', () => {
  const bad = { at: 110, event: 'preset-before', name: 'private-name', metrics: {
    helperScriptFrames: 4, token: 'private-token', framesOutsideChat: 'private-url' } };
  const { storage } = storageFixture({ [diagnosticKey]: JSON.stringify({ schema: 1, startedAt: 100,
    events: [bad, { at: -1, event: 'preset-after' }, { at: 120, event: 'private-name' }],
    lastPreset: { startedAt: 110, name: 'private-name', events: [bad, { at: 120, event: 'load' }] } }) });
  const snapshot = createDiagnostics({ storage, version: 'test' }).snapshot();
  assert.deepEqual(snapshot.previousPage.lastPreset.events, [{ at: 110, event: 'preset-before', metrics: { helperScriptFrames: 4 } }]);
  assert.deepEqual(snapshot.previousPage.events, snapshot.previousPage.lastPreset.events);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
});

test('first run reports missing previous evidence, not a normal or successful restart', () => {
  const { storage } = storageFixture();
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 100 });
  diagnostics.record('load');
  const report = diagnostics.snapshot();
  assert.equal(report.recovery.observation, 'no-previous-record');
  assert.equal(report.recovery.cause, 'unknown');
  assert.equal(report.recovery.previousStartedAt, null);
  assert.deepEqual(report.previousPages, []);
});

test('same counts after abrupt interruption retain distinct pages and three generations of history', () => {
  const { raw } = storageFixture();
  const backup = storageFixture();
  const ids = [];
  let report;
  for (const time of [100, 200, 300, 400]) {
    const diagnostics = createDiagnostics({ storage: createBrowserStorage(() => raw), backupStorage: backup.storage,
      version: '0.4.3-compat.7', build: '重载记录留存', now: () => time });
    diagnostics.record('preset-before', { framesInPage: 4, chatLength: 0 });
    report = diagnostics.snapshot(); ids.push(report.currentPage.pageId);
  }
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(report.previousPages.map(page => page.startedAt), [300, 200, 100]);
  assert(report.previousPages.every(page => page.version === '0.4.3-compat.7' && page.build === '重载记录留存'));
  assert.equal(report.previousPages.at(-1).lastPreset.events[0].event, 'preset-before');
  assert.equal(report.recovery.observation, 'no-page-exit-recorded');
  assert.equal(report.recovery.cause, 'unknown');
  assert.equal(report.currentPage.metrics.framesInPage, report.previousPage.metrics.framesInPage);
  const last = createDiagnostics({ storage: createBrowserStorage(() => raw), backupStorage: backup.storage,
    version: '0.4.3-compat.7', build: '重载记录留存', now: () => 500 });
  last.record('load');
  assert.deepEqual(last.snapshot().previousPages.map(page => page.startedAt), [400, 300, 200]);
  assert.equal(JSON.parse(backup.values.get('STDOMWindow.compat.diagnosticHistory')).pages.length, 4);
});

test('missing session report recovers matching-tab browser backup', () => {
  const session = storageFixture(), backup = storageFixture();
  const first = createDiagnostics({ storage: session.storage, backupStorage: backup.storage, version: 'test', now: () => 100 });
  first.record('preset-before', { helperScriptFrames: 4 });
  session.raw.removeItem(diagnosticKey);
  const next = createDiagnostics({ storage: createBrowserStorage(() => session.raw), backupStorage: backup.storage,
    version: 'test', now: () => 200 });
  assert.equal(next.recovery().source, 'browser-backup');
  assert.equal(next.snapshot().previousPage.pageId, first.snapshot().currentPage.pageId);
  assert.equal(next.snapshot().previousPage.lastPreset.events[0].metrics.helperScriptFrames, 4);
});

test('lost tab identity never misattributes another browser record as this page predecessor', () => {
  const session = storageFixture(), backup = storageFixture();
  const first = createDiagnostics({ storage: session.storage, backupStorage: backup.storage, version: 'test', now: () => 100 });
  first.record('preset-before');
  const next = createDiagnostics({ storage: storageFixture().storage, backupStorage: backup.storage, version: 'test', now: () => 200 });
  const report = next.snapshot();
  assert.equal(report.previousPage, null);
  assert.equal(report.recovery.observation, 'no-previous-record');
  assert.equal(report.recovery.unlinkedBrowserPages, 1);
  assert.equal(report.unlinkedBrowserPages[0].pageId, first.snapshot().currentPage.pageId);
});

test('fresh shared backup reads preserve two tabs without mixing their preceding pages', () => {
  const sessionA = storageFixture(), sessionB = storageFixture(), backup = storageFixture();
  let timeA = 100, timeB = 200;
  const a = createDiagnostics({ storage: sessionA.storage, backupStorage: createBrowserStorage(() => backup.raw),
    version: 'test', now: () => timeA });
  a.record('load');
  const b = createDiagnostics({ storage: sessionB.storage, backupStorage: createBrowserStorage(() => backup.raw),
    version: 'test', now: () => timeB });
  b.record('load');
  timeA = 300; a.record('preset-before');
  timeB = 400; b.record('preset-before');
  assert.equal(JSON.parse(backup.values.get('STDOMWindow.compat.diagnosticHistory')).pages.length, 2);
  sessionA.raw.removeItem(diagnosticKey);
  const nextA = createDiagnostics({ storage: createBrowserStorage(() => sessionA.raw), backupStorage: backup.storage,
    version: 'test', now: () => 500 });
  assert.equal(nextA.snapshot().previousPage.pageId, a.snapshot().currentPage.pageId);
  assert.notEqual(nextA.snapshot().previousPage.pageId, b.snapshot().currentPage.pageId);
});

test('reinitializing the extension in the same document does not fabricate another page load', () => {
  const { storage } = storageFixture();
  const documentA = {}, documentB = {};
  assert.equal(getDiagnosticPageId(documentA), getDiagnosticPageId(documentA));
  assert.notEqual(getDiagnosticPageId(documentA), getDiagnosticPageId(documentB));
  const first = createDiagnostics({ storage, version: 'test', pageId: getDiagnosticPageId(documentA), now: () => 100 });
  first.record('preset-before');
  const reloadExtension = createDiagnostics({ storage, version: 'test', pageId: getDiagnosticPageId(documentA), now: () => 200 });
  reloadExtension.record('extension-reloaded');
  assert.equal(reloadExtension.resumed, true);
  assert.equal(reloadExtension.snapshot().currentPage.startedAt, 100);
  assert.equal(reloadExtension.snapshot().previousPage, null);
  assert.equal(reloadExtension.snapshot().currentPage.lastPreset.events[0].event, 'preset-before');
});

test('page exit survives event churn but returning from back-forward cache clears the exit', () => {
  const { storage } = storageFixture();
  const first = createDiagnostics({ storage, version: 'test', pageId: 'page-first', now: () => 100 });
  first.record('pagehide', { persisted: true });
  for (let i = 0; i < 40; i++) first.record('hidden');
  const next = createDiagnostics({ storage, version: 'test', now: () => 200 });
  assert.equal(next.recovery().observation, 'page-exit-recorded');
  first.record('pageshow', { persisted: true });
  const afterReturn = createDiagnostics({ storage, version: 'test', now: () => 300 });
  assert.equal(afterReturn.recovery().observation, 'no-page-exit-recorded');
  assert.equal(afterReturn.recovery().cause, 'unknown');
});

test('new and old browser history only re-export known fields and bounded records', () => {
  const backup = storageFixture({ 'STDOMWindow.compat.diagnosticHistory': JSON.stringify({ schema: 1,
    pages: Array.from({ length: 15 }, (_, i) => ({ schema: 1, pageId: `page-id-${i}`, tabId: 'private-token/invalid',
      startedAt: 100 + i, updatedAt: 120 + i, chat: 'private-chat', url: 'private-url',
      pageExit: { at: -1, persisted: 'private-key' }, metrics: { framesInPage: 4, token: 'private-token' } })) }) });
  const diagnostics = createDiagnostics({ storage: storageFixture().storage, backupStorage: backup.storage,
    version: 'test', now: () => 200 });
  const report = diagnostics.snapshot();
  assert.equal(report.unlinkedBrowserPages.length, 4);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
  diagnostics.record('load');
  assert.doesNotMatch(backup.values.get('STDOMWindow.compat.diagnosticHistory'), /private-/);
});

test('fresh storage reads see other writers and preserve in-page data when denied', () => {
  const { storage, raw } = storageFixture({ value: 'first' });
  assert.equal(storage.getItem('value'), 'first');
  raw.setItem('value', 'second');
  assert.equal(storage.getItem('value', { fresh: true }), 'second');
  raw.getItem = () => { throw new Error('Denied'); };
  assert.equal(storage.getItem('value', { fresh: true }), 'second');
  assert.equal(storage.persistent, false);
});

test('trend samples are bounded, keep only counts and survive a reload', () => {
  const { storage, values } = storageFixture();
  let time = 1000;
  const build = '本地预览-20261109-截断恢复与生成兜底';
  const first = createDiagnostics({ storage, version: '0.4.3-compat.7', build, now: () => time });
  first.checkpoint({ domNodes: 900, framesInPage: 2 });
  assert.equal(first.snapshot().currentPage.samples, undefined, 'plain checkpoints do not add samples');
  for (let i = 0; i < 45; i++) {
    time += 30000;
    first.checkpoint({ domNodes: 1000 + i, framesInPage: 3 + i, chatLength: 50, generating: i % 2 === 0,
      enabled: true, running: 1, url: 'private-url', token: 'private-token' }, { sample: true });
  }
  const samples = first.snapshot().currentPage.samples;
  assert.equal(samples.length, 30);
  assert.equal(samples.at(-1).metrics.domNodes, 1044);
  assert.equal(samples[0].metrics.domNodes, 1015);
  assert.deepEqual(Object.keys(samples.at(-1).metrics).sort(), ['chatLength', 'domNodes', 'framesInPage', 'generating']);
  assert.doesNotMatch(values.get(diagnosticKey), /private-/);
  const previous = createDiagnostics({ storage, version: '0.4.3-compat.7', build, now: () => time + 1 }).snapshot().previousPage;
  assert.equal(previous.build, build);
  assert.equal(previous.samples.length, 30);
  assert.equal(previous.samples.at(-1).metrics.domNodes, 1044);
});

test('saved samples are sanitized and capped when read back', () => {
  const saved = { schema: 1, startedAt: 100, updatedAt: 200, metrics: {},
    samples: [...Array.from({ length: 40 }, (_, i) => ({ at: 100 + i, metrics: { domNodes: i, url: 'private-url', enabled: true } })),
      { at: -5, metrics: { domNodes: 1 } }, null, 'private-chat'] };
  const { storage } = storageFixture({ [diagnosticKey]: JSON.stringify(saved) });
  const previous = createDiagnostics({ storage, version: 'test', now: () => 300 }).snapshot().previousPage;
  assert(previous.samples.length <= 30);
  assert(previous.samples.every(sample => sample.at >= 0 && Object.keys(sample.metrics).every(name => name === 'domNodes')));
  assert.doesNotMatch(JSON.stringify(previous), /private-/);
});

test('generation watchdog is a recorded event and domNodes is an allowed metric', () => {
  const { storage } = storageFixture();
  const diagnostics = createDiagnostics({ storage, version: 'test', now: () => 100 });
  diagnostics.record('generation-watchdog', { generating: true, domNodes: 1234 });
  const page = diagnostics.snapshot().currentPage;
  assert.equal(page.lastEvent, 'generation-watchdog');
  assert.equal(page.metrics.domNodes, 1234);
});
