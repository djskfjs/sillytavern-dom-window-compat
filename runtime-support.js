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
    getItem(key, { fresh = false } = {}) {
      if (!fresh && memory.has(key)) return memory.get(key);
      try { const value = getStorage().getItem(key); memory.set(key, value); return value; }
      catch { persistent = false; return memory.get(key) ?? null; }
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

export function selectDiagnosticText(output) {
  if (!output) return false;
  output.hidden = false;
  try {
    output.focus({ preventScroll: true });
    output.select();
    // iOS does not consistently select readonly textareas with select() alone.
    output.setSelectionRange(0, output.value.length);
    return output.value.length > 0 && output.ownerDocument.activeElement === output
      && output.selectionStart === 0 && output.selectionEnd === output.value.length;
  } catch { return false; }
}

export async function copyDiagnosticText(output, navigatorObject = globalThis.navigator) {
  if (!output) return false;
  const selected = selectDiagnosticText(output);
  // Keep the fallback inside the original tap. Waiting for a rejected Clipboard
  // promise first can lose Safari's transient user activation.
  try { if (selected && output.ownerDocument.execCommand('copy')) return true; } catch {}
  let timer;
  try {
    const clipboard = navigatorObject?.clipboard;
    if (!clipboard?.writeText) return false;
    const writing = clipboard.writeText(output.value);
    return await Promise.race([
      Promise.resolve(writing).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function createDiagnosticId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getDiagnosticPageId(documentObject = globalThis.document) {
  // The same document can unload/reload this extension without navigating.
  const key = Symbol.for('STDOMWindow.diagnosticPageId');
  return documentObject[key] ||= createDiagnosticId();
}

export function createDiagnostics({ storage, backupStorage, version, build, pageId = createDiagnosticId(), now = Date.now }) {
  const key = 'STDOMWindow.compat.diagnostics';
  const tabKey = 'STDOMWindow.compat.diagnosticTab';
  const backupKey = 'STDOMWindow.compat.diagnosticHistory';
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
  const codes = new Set(['load', 'enabled', 'disabled', 'hidden', 'visible', 'pagehide', 'pageshow',
    'freeze', 'resume', 'render-timeout', 'render-error', 'window-error', 'reload-requested',
    'reload-deferred', 'settings-pending', 'helper-unavailable', 'generation-start', 'generation-end',
    'chat-changed', 'preset-selected', 'preset-before', 'preset-after', 'preset-complete', 'preset-sample',
    'preset-settled', 'page-error', 'unhandled-rejection', 'extension-reloaded', 'generation-watchdog']);
  const presetCodes = new Set(['preset-selected', 'preset-before', 'preset-after', 'preset-complete', 'preset-sample', 'preset-settled']);
  const fields = new Set(['enabled', 'paused', 'background', 'chatLength', 'messagesInDom',
    'framesInChat', 'framesInPage', 'running', 'pending', 'stalled', 'persisted', 'generating',
    'contextAvailable', 'chatRootConnected', 'framesOutsideChat', 'helperScriptFrames', 'helperMessageFrames', 'otherFrames',
    'domNodes']);
  // Trend samples keep only counts that can grow during a long chat.
  const sampleFields = new Set(['generating', 'background', 'chatLength', 'messagesInDom', 'framesInChat',
    'framesInPage', 'helperScriptFrames', 'helperMessageFrames', 'domNodes']);
  const SAMPLE_LIMIT = 30;
  const reloadReasons = new Set(['helper-configured', 'helper-restored', 'manual-recovery']);
  const clean = data => Object.fromEntries(Object.entries(data || {}).filter(([name, value]) =>
    fields.has(name) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && value >= 0))));
  const validTime = value => Number.isFinite(value) && value >= 0;
  const cleanSamples = samples => Array.isArray(samples) ? samples.slice(-SAMPLE_LIMIT)
    .filter(entry => entry && validTime(entry.at))
    .map(entry => ({ at: entry.at, metrics: Object.fromEntries(Object.entries(clean(entry.metrics))
      .filter(([name]) => sampleFields.has(name))) })) : [];
  // Keep the start of a preset transition even if delayed completion events
  // create more than one sampling batch. A trailing-only ring loses the before counts.
  const limitPresetEvents = events => events.length > 8 ? [...events.slice(0, 2), ...events.slice(-6)] : events;
  const cleanEvents = (events, allowed = codes, limit = 24) => Array.isArray(events) ?
    (allowed === presetCodes ? limitPresetEvents(events) : events.slice(-limit))
    .filter(entry => entry && validTime(entry.at) && allowed.has(entry.event))
    .map(entry => ({ at: entry.at, event: entry.event, ...(entry.metrics ? { metrics: clean(entry.metrics) } : {}) })) : [];
  const cleanPage = saved => {
    if (saved?.schema !== 1 || !validTime(saved.startedAt)) return null;
    const previous = { schema: 1, startedAt: saved.startedAt, updatedAt: validTime(saved.updatedAt) ? saved.updatedAt : saved.startedAt,
      lastEvent: codes.has(saved.lastEvent) ? saved.lastEvent : 'unknown', metrics: clean(saved.metrics) };
    if (validId(saved.pageId)) previous.pageId = saved.pageId;
    if (validId(saved.tabId)) previous.tabId = saved.tabId;
    if (validTime(saved.lastEventAt)) previous.lastEventAt = saved.lastEventAt;
    if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(saved.version || '')) previous.version = saved.version;
    if (['生成期间暂停前端回收', '本地预览-20261108-诊断复制与预设追踪', '本地预览-20261108-重载记录留存', '重载记录留存',
      '本地预览-20261109-截断恢复与生成兜底', '截断恢复与生成兜底',
      '旧楼层引用释放与全选校验'].includes(saved.build)) previous.build = saved.build;
    const events = cleanEvents(saved.events);
    if (events.length) previous.events = events;
    const samples = cleanSamples(saved.samples);
    if (samples.length) previous.samples = samples;
    const presetEvents = cleanEvents(saved.lastPreset?.events, presetCodes, 8);
    if (presetEvents.length && validTime(saved.lastPreset.startedAt)) {
      previous.lastPreset = { startedAt: saved.lastPreset.startedAt, events: presetEvents };
    }
    if (reloadReasons.has(saved.programmaticReload?.reason) && validTime(saved.programmaticReload.at)) {
      previous.programmaticReload = { at: saved.programmaticReload.at, reason: saved.programmaticReload.reason };
    }
    if (validTime(saved.pageExit?.at) && typeof saved.pageExit.persisted === 'boolean') {
      previous.pageExit = { at: saved.pageExit.at, persisted: saved.pageExit.persisted };
    }
    return previous;
  };
  const read = (target, name) => {
    try { return JSON.parse(target?.getItem(name, { fresh: true })); } catch { return null; }
  };
  const pageKey = page => page.pageId || `legacy-${page.startedAt}`;
  const mergePages = (pages, limit) => {
    const unique = new Map();
    for (const value of pages) {
      const page = cleanPage(value);
      if (!page) continue;
      const old = unique.get(pageKey(page));
      if (!old || old.updatedAt <= page.updatedAt) unique.set(pageKey(page), page);
    }
    return [...unique.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  };
  const readBackup = () => {
    const saved = read(backupStorage, backupKey);
    return saved?.schema === 1 && Array.isArray(saved.pages) ? saved.pages.slice(0, 4) : [];
  };
  let tabId = storage.getItem(tabKey);
  const knownTab = validId(tabId);
  if (!knownTab) { tabId = createDiagnosticId(); storage.setItem(tabKey, tabId); }
  const saved = read(storage, key);
  const savedCurrent = cleanPage(saved?.schema === 2 ? saved.currentPage : saved);
  const resumed = !!savedCurrent?.pageId && savedCurrent.pageId === pageId;
  const savedHistory = saved?.schema === 2 && Array.isArray(saved.previousPages) ? saved.previousPages.slice(0, 3) : [];
  const sessionPages = mergePages([...(resumed ? [] : [savedCurrent]), ...savedHistory], 3)
    .filter(page => page.pageId !== pageId);
  const backupPages = mergePages(readBackup(), 4).filter(page => page.pageId !== pageId);
  const matchingBackup = knownTab ? backupPages.filter(page => page.tabId === tabId) : [];
  const previousPages = mergePages([...sessionPages, ...matchingBackup], 3);
  const previous = previousPages[0] || null;
  // Without a tab identity, local data may belong to another open tab. Export it
  // separately as unverified evidence; never call it this page's predecessor.
  const unlinkedBrowserPages = previous ? [] : backupPages.filter(page => !knownTab || page.tabId !== tabId);
  const fromSession = previous && sessionPages.some(page => pageKey(page) === pageKey(previous)
    && page.updatedAt >= previous.updatedAt);
  const source = !previous ? 'none' : fromSession ? 'session' : 'browser-backup';
  const startedAt = now();
  const current = resumed ? { ...savedCurrent, events: savedCurrent.events || [], version, ...(build ? { build } : {}) }
    : { schema: 1, version, ...(build ? { build } : {}), pageId, tabId, startedAt, updatedAt: startedAt,
      lastEvent: 'load', lastEventAt: startedAt, metrics: {}, events: [] };
  const persist = () => {
    storage.setItem(key, JSON.stringify({ schema: 2, currentPage: current, previousPages }));
    if (backupStorage) {
      // Read afresh to preserve bounded records written by other tabs.
      const pages = mergePages([...readBackup(), ...previousPages, current], 4);
      backupStorage.setItem(backupKey, JSON.stringify({ schema: 1, pages }));
    }
  };
  function recovery() {
    const hasExit = previous?.pageExit || previous?.lastEvent === 'pagehide';
    const observation = !previous ? 'no-previous-record' : previous.programmaticReload ? 'extension-reload-requested'
      : hasExit ? 'page-exit-recorded' : 'no-page-exit-recorded';
    const messages = {
      'no-previous-record': '没有取得本标签页的上次记录，不能判断上次白屏原因。',
      'extension-reload-requested': '上次记录包含本扩展的刷新请求；这不等于确认了白屏原因。',
      'page-exit-recorded': '已取得上次页面记录，其中有页面离开事件；白屏原因仍未确认。',
      'no-page-exit-recorded': '已取得上次页面记录，但没有页面离开事件。可能发生中断，也可能未触发离开事件，不能据此确定崩溃原因。',
    };
    return { source, observation, cause: 'unknown', message: messages[observation],
      currentPageId: current.pageId, currentStartedAt: current.startedAt,
      previousPageId: previous?.pageId || null, previousStartedAt: previous?.startedAt ?? null,
      previousLastRecordedAt: previous?.updatedAt ?? null, retainedPreviousPages: previousPages.length,
      unlinkedBrowserPages: unlinkedBrowserPages.length,
      sessionStorageAvailable: storage.persistent, browserBackupAvailable: !!backupStorage?.persistent };
  }
  return {
    resumed,
    recovery,
    markReload(reason) {
      if (!reloadReasons.has(reason)) return;
      current.programmaticReload = { at: now(), reason }; persist();
    },
    record(code, metrics) {
      if (!codes.has(code)) return;
      current.updatedAt = now(); current.lastEvent = code;
      current.lastEventAt = current.updatedAt;
      current.metrics = { ...current.metrics, ...clean(metrics) };
      const entry = { at: current.updatedAt, event: code, ...(metrics ? { metrics: clean(metrics) } : {}) };
      current.events.push(entry);
      current.events = current.events.slice(-24);
      if (code === 'pagehide') current.pageExit = { at: current.updatedAt, persisted: metrics?.persisted === true };
      if (code === 'pageshow') delete current.pageExit;
      if (presetCodes.has(code)) {
        const previousPresetEvent = current.lastPreset?.events.at(-1);
        const followsSelection = code === 'preset-before' && previousPresetEvent?.event === 'preset-selected'
          && current.updatedAt - previousPresetEvent.at < 2000;
        if (!current.lastPreset || code === 'preset-selected' || (code === 'preset-before' && !followsSelection)) {
          current.lastPreset = { startedAt: current.updatedAt, events: [] };
        }
        current.lastPreset.events.push(entry);
        current.lastPreset.events = limitPresetEvents(current.lastPreset.events);
      }
      persist();
    },
    checkpoint(metrics, { sample = false } = {}) {
      current.updatedAt = now(); current.metrics = clean(metrics);
      if (sample) current.samples = cleanSamples([...(current.samples || []), { at: current.updatedAt, metrics: current.metrics }]);
      persist();
    },
    snapshot() { return JSON.parse(JSON.stringify({ recovery: recovery(), previousPage: previous,
      previousPages, unlinkedBrowserPages, currentPage: current })); },
  };
}
