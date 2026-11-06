import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStorage, createDiagnostics } from '../runtime-support.js';

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
  assert.deepEqual(diagnostics.snapshot().previousPage, { startedAt: 100, updatedAt: 120, lastEvent: 'unknown',
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
    expected.push({ at: now - 1, event });
  }
  assert.deepEqual(diagnostics.snapshot().currentPage.events, expected.slice(-24));
  assert.deepEqual(JSON.parse(values.get(diagnosticKey)).events, expected.slice(-24));
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
