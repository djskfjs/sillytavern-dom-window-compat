/** Small, bounded browser utilities. No chat text, URLs or credentials are recorded. */
export function createBrowserStorage(getStorage) {
  const memory = new Map();
  let persistent = true;
  try {
    const storage = getStorage(), probe = 'STDOMWindow.storage-probe';
    storage.setItem(probe, '1'); storage.removeItem(probe);
  } catch { persistent = false; }
  return {
    get persistent() { return persistent; },
    getItem(key) {
      if (memory.has(key)) return memory.get(key);
      try { const value = getStorage().getItem(key); memory.set(key, value); return value; }
      catch { persistent = false; return null; }
    },
    setItem(key, value) {
      memory.set(key, String(value));
      try { getStorage().setItem(key, String(value)); } catch { persistent = false; }
    },
    removeItem(key) {
      memory.set(key, null);
      try { getStorage().removeItem(key); } catch { persistent = false; }
    },
  };
}

export function createDiagnostics({ storage, version, now = Date.now }) {
  const key = 'STDOMWindow.compat.diagnostics';
  const codes = new Set(['load', 'enabled', 'disabled', 'hidden', 'visible', 'pagehide', 'pageshow',
    'freeze', 'resume', 'render-timeout', 'render-error', 'window-error', 'reload-requested',
    'reload-deferred', 'settings-pending', 'helper-unavailable', 'generation-start', 'generation-end']);
  const fields = new Set(['enabled', 'paused', 'background', 'chatLength', 'messagesInDom',
    'framesInChat', 'framesInPage', 'running', 'pending', 'stalled', 'persisted', 'generating']);
  const reloadReasons = new Set(['helper-configured', 'helper-restored', 'manual-recovery']);
  const clean = data => Object.fromEntries(Object.entries(data || {}).filter(([name, value]) =>
    fields.has(name) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && value >= 0))));
  let previous = null;
  try {
    const saved = JSON.parse(storage.getItem(key));
    if (saved?.schema === 1 && Number.isFinite(saved.startedAt) && saved.startedAt >= 0) {
      previous = { startedAt: saved.startedAt, updatedAt: Number.isFinite(saved.updatedAt) && saved.updatedAt >= 0 ? saved.updatedAt : saved.startedAt,
        lastEvent: codes.has(saved.lastEvent) ? saved.lastEvent : 'unknown', metrics: clean(saved.metrics) };
      if (reloadReasons.has(saved.programmaticReload?.reason) && Number.isFinite(saved.programmaticReload.at) && saved.programmaticReload.at >= 0) {
        previous.programmaticReload = { at: saved.programmaticReload.at, reason: saved.programmaticReload.reason };
      }
    }
  } catch {}
  const current = { schema: 1, version, startedAt: now(), updatedAt: now(), lastEvent: 'load', metrics: {}, events: [] };
  const persist = () => storage.setItem(key, JSON.stringify(current));
  return {
    markReload(reason) {
      if (!reloadReasons.has(reason)) return;
      current.programmaticReload = { at: now(), reason }; persist();
    },
    record(code, metrics) {
      if (!codes.has(code)) return;
      current.updatedAt = now(); current.lastEvent = code;
      current.metrics = { ...current.metrics, ...clean(metrics) };
      current.events.push({ at: current.updatedAt, event: code });
      current.events = current.events.slice(-24); persist();
    },
    checkpoint(metrics) {
      current.updatedAt = now(); current.metrics = clean(metrics); persist();
    },
    snapshot() { return JSON.parse(JSON.stringify({ previousPage: previous, currentPage: current })); },
  };
}
