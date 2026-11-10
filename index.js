/**
 * DOM Window 0.4.3-compat.9 — browser compatibility build
 *
 * 只窗口化 ST 的消息 DOM，不改 chat 数据。
 * - chat 数组保持完整，AI 上下文、存档、消息 ID 不变。
 * - #chat 里只保留视口附近的 .mes，远处用上下占位撑住滚动高度。
 * - 最后一条消息固定挂载，保证 .last_mes 相关功能正常。
 * - 默认不启用；兼容版使用独立开关，不继承原版的自动开启状态。
 *
 * 兼容接口：
 * - STDOMWindow.getChat() 返回完整 chat
 * - STDOMWindow.getMessageElement(mesid) 按需挂载某一层
 */
import { createRenderQueue } from './render-queue.js?v=0.4.3-compat.9';
import { createMovingWindow } from './moving-window.js?v=0.4.3-compat.9';
import { createHelperLifecycle } from './helper-lifecycle.js?v=0.4.3-compat.9';
import { createHelperSetup } from './helper-setup.js?v=0.4.3-compat.9';
import { createBrowserStorage, createDiagnostics, createDiagnosticId, getDiagnosticPageId, copyDiagnosticText, selectDiagnosticText } from './runtime-support.js?v=0.4.3-compat.9';

let disposeExtension = () => {};
export function disable() { return disposeExtension(); }

(() => {
  'use strict';

  const VERSION = '0.4.3-compat.9';
  const BUILD = '旧楼层引用释放与全选校验';
  const LOG = '[DOMWindow]';
  let extensionDisposed = false;
  let restoring = null;
  let reenableOptions = null;
  let preparing = null;
  let requestedEnable = false;
  let skipUnloadRefresh = false;
  let pendingReload = '';
  let helperWaitStarted = 0;
  let lastCheckpoint = 0;
  let pageAway = false;
  let frozen = false;
  let generationResumeTimer = 0;
  let generationEventActive = false;
  let generationIdleSince = 0;
  let watchdogReleased = false;
  const generationWaiters = new Set();
  if (window.STDOMWindow) {
    console.warn(LOG, '检测到另一个 DOM Window 实例，兼容版未重复加载。请只启用一个版本。');
    return;
  }
  const EXTENSION_BASE = new URL('.', import.meta.url).href;
  const STORAGE_KEY = 'STDOMWindow.scrollfix.enabled';
  const TRUNCATION_KEY = 'STDOMWindow.compat.originalTruncation';
  const PRELOAD_KEY = 'STDOMWindow.compat.preload';
  const DEFAULT_PRELOAD = 5;
  const MAX_PRELOAD = 100;
  const storage = createBrowserStorage(() => window.localStorage);
  const diagnosticStorage = createBrowserStorage(() => window.sessionStorage);
  const diagnosticBackupStorage = createBrowserStorage(() => window.localStorage);
  const diagnostics = createDiagnostics({ storage: diagnosticStorage, backupStorage: diagnosticBackupStorage,
    version: VERSION, build: BUILD, pageId: getDiagnosticPageId() });
  diagnostics.record(diagnostics.resumed ? 'extension-reloaded' : 'load');
  const FALLBACK_EVENTS = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
  };

  const config = {
    minWindow: 5,
    maxWindow: 9,
    batch: 2,
    defaultHeight: 4800,
    nearViewportFactor: 1.5,
    // 回收视口外楼层时需要留出的安全距离（视口高度的倍数）。
    // 太小会让刚挂上的楼层立刻被回收，形成反复重建。
    trimFactor: 2,
    manageTruncation: false,
    // The hold starts on GENERATION_AFTER_COMMANDS, so slash commands never freeze
    // the window. ST 1.14 can still exit after that event (server ping, backend
    // checks) without emitting GENERATION_ENDED. Release the
    // hold once neither ST nor Helper reports a generation for this long.
    generationWatchdogMs: 20000,
    debug: false,
  };

  const state = {
    enabled: false,
    paused: false,
    background: document.hidden,
    generating: false,
    mounted: false,
    chatEl: null,
    topSpacer: null,
    bottomSpacer: null,
    heights: new Map(),
    start: 0,
    end: 0,
    pinnedId: null,
    scrollRaf: 0,
    applyTimer: 0,
    eventSource: null,
    eventTypes: null,
    listeners: [],
    originalTruncation: null,
    applying: false,
    forceApply: false,
    tailRef: null,
    // 自己刷新补发的 message_rendered：楼层号 -> 过期时刻。
    // 用一个固定时长的总计时器靠不住——机器忙、iframe 多时事件会晚到，
    // 漏判一次就会重排，重排又刷新，形成源码/渲染来回闪的死循环。
    selfRenders: new Map(),
    sweepTimer: 0,
    scrollRevision: 0,
    enableTimer: 0,
    autoStartTimer: 0,
    lastRenderError: '',
  };

  const SELF_RENDER_TTL = 20000;
  const SWEEP_INTERVAL = 5000;

  const log = (...args) => console.debug(LOG, ...args);

  function getCtx() {
    try {
      return window.SillyTavern?.getContext?.() || null;
    } catch {
      return null;
    }
  }

  function getChat() {
    return getCtx()?.chat || [];
  }

  function getChatEl() {
    return state.chatEl || document.querySelector('#chat');
  }

  function safe(fn, label = 'task') {
    try {
      return fn();
    } catch (err) {
      console.warn(LOG, label, err);
      return undefined;
    }
  }

  function createSpacer(side) {
    const el = document.createElement('div');
    el.className = `dom-window-spacer dom-window-${side}`;
    el.setAttribute('data-dom-window', side);
    el.style.cssText = 'display:block;width:100%;flex:0 0 auto;pointer-events:none;';
    return el;
  }

  // 记下由本插件亲手挂上去的楼层元素：这些才需要补发渲染事件。
  // 酒馆自己渲染的新楼层已经完整拉过一次界面，再刷新就是白白闪一次。
  const mountedByUs = new WeakSet();

  const renderQueue = createRenderQueue({
    getRoot: getChatEl,
    getChat,
    refresh: (id, element) => {
      const helper = window.TavernHelper;
      if (typeof helper?.refreshOneMessage !== 'function') {
        throw new Error('未找到酒馆助手的楼层刷新接口');
      }
      return helper.refreshOneMessage(id, window.jQuery ? window.jQuery(element) : undefined);
    },
    markSelfRender: id => {
      state.selfRenders.set(Number(id), Date.now() + SELF_RENDER_TTL);
      armSweep();
    },
    beforeRefresh: () => movingWindow.captureAnchor(),
    afterRefresh: (item, anchor) => movingWindow.afterRefresh(item, anchor),
    onStall: () => {
      pauseWindow('render-timeout', '这一层加载时间过长，窗口已暂停。当前页面已保留，可在方便时点击“刷新页面”。');
    },
    onError: (id, error) => {
      state.lastRenderError = `第 ${id} 层前端恢复失败（${error?.name || 'Error'}），可关闭窗口模式重新进入。`;
      console.warn(LOG, '前端恢复失败', id, error?.name || 'Error');
      diagnostics.record('render-error');
      updateStatusPanel();
    },
  });

  const helperLifecycle = createHelperLifecycle({ getRoot: getChatEl, getHelper: () => window.TavernHelper,
    getContext: getCtx, beforeRelease: waitForGeneration });
  const deviceKey = 'STDOMWindow.compat.device';
  let settingsOwner = storage.getItem(deviceKey);
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(settingsOwner || '')) {
    try { settingsOwner = globalThis.crypto?.randomUUID?.(); } catch {}
    settingsOwner ||= `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    storage.setItem(deviceKey, settingsOwner);
  }
  const helperSetup = createHelperSetup({ getHelper: () => window.TavernHelper, getContext: getCtx, owner: settingsOwner });
  const movingWindow = createMovingWindow({ state, config, getRoot: getChatEl, getChat, mountMessage, renderQueue,
    refreshMessages: refreshMountedMessages, lifecycle: helperLifecycle, beforeMount: waitForGeneration,
    onRangeChanged: () => updateStatusPanel(),
    onFailure: error => {
      console.warn(LOG, '窗口已暂停', error?.name);
      pauseWindow('window-error', '窗口遇到兼容问题，已暂停并保留当前页面。可导出诊断信息，再点击“刷新页面”。');
    },
  });

  function nativeGenerating() {
    const ctx = getCtx();
    try {
      return !!(window.TavernHelper?.builtin?.duringGenerating?.() ||
        (typeof ctx?.isGenerating === 'function' ? ctx.isGenerating() : ctx?.isGenerating === true));
    } catch { return false; }
  }

  function waitForGeneration() {
    if (!state.generating || extensionDisposed) return;
    return new Promise(resolve => generationWaiters.add(resolve));
  }

  function beginGeneration(type, _options, dryRun) {
    if (dryRun || type === 'quiet' || type === 'impersonate' || !state.enabled) return;
    generationEventActive = true;
    holdGeneration();
  }

  function holdGeneration() {
    clearTimeout(generationResumeTimer); generationResumeTimer = 0;
    generationIdleSince = 0; watchdogReleased = false;
    if (state.generating) return;
    state.generating = true;
    clearTimeout(state.applyTimer); state.applyTimer = 0;
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = 0;
    // Helper's cleanup signal audits every mounted floor. During streaming
    // even a cleanup of an OLD floor can start the unfinished NEW frontend.
    renderQueue.cancel();
    renderQueue.setSuspended(true);
    diagnostics.record('generation-start', diagnosticMetrics());
    updateStatusPanel();
  }

  function endGeneration() {
    if (!state.generating) return;
    generationEventActive = false;
    clearTimeout(generationResumeTimer);
    // Stop/error events can precede the final message render. Let that event
    // chain finish, and let a following group/tool generation keep the hold.
    generationResumeTimer = setTimeout(finishGeneration, 200);
  }

  function onGenerationEnded() {
    watchdogReleased = false;
    endGeneration();
  }

  // ST 1.14 sets body[data-generating] only once the request really starts
  // (deactivateSendButtons) and removes it when the send buttons return.
  function nativeBusy() {
    return nativeGenerating() || document.body?.dataset?.generating === 'true';
  }

  function checkGenerationWatchdog(now = Date.now()) {
    if (extensionDisposed || !state.enabled) { generationIdleSince = 0; return; }
    if (!state.generating) {
      // A request that only became visible after a long prompt build: hold again.
      if (watchdogReleased && nativeBusy()) {
        watchdogReleased = false; generationEventActive = true; holdGeneration();
      }
      return;
    }
    if (generationResumeTimer || nativeBusy()) { generationIdleSince = 0; return; }
    generationIdleSince ||= now;
    const limit = Number(config.generationWatchdogMs);
    if (!Number.isFinite(limit) || limit <= 0 || now - generationIdleSince < limit) return;
    generationIdleSince = 0; watchdogReleased = true;
    diagnostics.record('generation-watchdog', diagnosticMetrics());
    endGeneration();
  }

  function finishGeneration() {
    generationResumeTimer = 0;
    if (extensionDisposed || !state.enabled || generationEventActive) return;
    if (nativeGenerating()) { endGeneration(); return; }
    state.generating = false;
    for (const resolve of generationWaiters) resolve();
    generationWaiters.clear();
    renderQueue.setSuspended(state.background || state.paused);
    diagnostics.record('generation-end', diagnosticMetrics());
    if (!state.background && !state.paused) {
      movingWindow.resume();
      if (state.forceApply || (!windowMatchesChat() && !syncTail())) scheduleApply(0, state.forceApply);
    }
    updateStatusPanel();
  }

  function pauseWindow(reason, message) {
    if (!state.enabled || state.paused) return;
    state.paused = true;
    state.lastRenderError = message;
    clearTimeout(state.applyTimer); state.applyTimer = 0;
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = 0;
    renderQueue.cancel();
    renderQueue.setSuspended(true);
    movingWindow.suspend();
    diagnostics.record(reason, diagnosticMetrics());
    updateStatusPanel();
  }

  function diagnosticMetrics() {
    const ctx = getCtx(), root = document.querySelector('#chat'), queue = renderQueue.snapshot();
    const frames = [...document.querySelectorAll('iframe')];
    const framesInChat = frames.filter(frame => root?.contains(frame)).length;
    const helperScriptFrames = frames.filter(frame => frame.id.startsWith('TH-script--')).length;
    const helperMessageFrames = frames.filter(frame => frame.id.startsWith('TH-message--')).length;
    return { enabled: state.enabled, paused: state.paused, background: state.background, generating: state.generating,
      contextAvailable: !!ctx, chatRootConnected: !!root?.isConnected,
      chatLength: ctx?.chat?.length || 0, messagesInDom: root?.querySelectorAll(':scope > .mes').length || 0,
      framesInChat, framesInPage: frames.length, framesOutsideChat: frames.length - framesInChat,
      helperScriptFrames, helperMessageFrames, otherFrames: frames.length - helperScriptFrames - helperMessageFrames,
      domNodes: document.getElementsByTagName('*').length,
      running: queue.running, pending: queue.pending, stalled: queue.stalled };
  }

  function getDiagnostics() {
    diagnostics.checkpoint(diagnosticMetrics());
    const check = helperLifecycle.inspect();
    return { format: 3, reportId: createDiagnosticId(), generatedAt: Date.now(), recovery: diagnostics.recovery(),
      version: VERSION, build: BUILD,
      browser: navigator.userAgent, storageAvailable: storage.persistent && diagnosticStorage.persistent,
      settingsStorageAvailable: storage.persistent, diagnosticStorageAvailable: diagnosticStorage.persistent,
      diagnosticBackupAvailable: diagnosticBackupStorage.persistent,
      helperVersion: typeof check.version === 'string' && /^[\w.+-]{1,40}$/.test(check.version) ? check.version : null,
      helperCompatible: check.ok, windowSize: config.minWindow,
      navigation: performance.getEntriesByType?.('navigation')?.[0]?.type || 'unknown',
      ...diagnostics.snapshot() };
  }

  // Observe preset changes even with the reading window disabled or no chat
  // open. Never retain event payloads: they contain names, prompts and settings.
  let diagnosticSource = null;
  const diagnosticListeners = [];
  const presetTimers = new Set();
  function clearPresetSamples() {
    presetTimers.forEach(timer => clearTimeout(timer)); presetTimers.clear();
  }
  function recordPreset(code) {
    if (extensionDisposed) return;
    diagnostics.record(code, diagnosticMetrics());
    if (code === 'preset-selected' || code === 'preset-before') clearPresetSamples();
    if (code !== 'preset-after' && code !== 'preset-complete') return;
    clearPresetSamples();
    // A few bounded samples catch asynchronous script replacement. No page-wide
    // MutationObserver or permanent high-frequency polling is needed.
    for (const delay of [0, 250, 1000, 3000]) {
      const timer = setTimeout(() => {
        presetTimers.delete(timer);
        if (!extensionDisposed) diagnostics.record(delay === 3000 ? 'preset-settled' : 'preset-sample', diagnosticMetrics());
      }, delay);
      presetTimers.add(timer);
    }
  }
  function unbindDiagnosticEvents() {
    for (const { event, handler } of diagnosticListeners) {
      if (typeof diagnosticSource?.removeListener === 'function') diagnosticSource.removeListener(event, handler);
      else diagnosticSource?.off?.(event, handler);
    }
    diagnosticListeners.length = 0; diagnosticSource = null;
  }
  function bindDiagnosticEvents() {
    const ctx = getCtx(), source = ctx?.eventSource || window.eventSource;
    if (!source?.on || diagnosticSource === source) return;
    unbindDiagnosticEvents(); diagnosticSource = source;
    const types = ctx?.event_types || ctx?.eventTypes || {};
    for (const [key, fallback, code] of [
      ['OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before', 'preset-before'],
      ['OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after', 'preset-after'],
      ['PRESET_CHANGED', 'preset_changed', 'preset-complete'],
      ['CHAT_CHANGED', FALLBACK_EVENTS.CHAT_CHANGED, 'chat-changed'],
    ]) {
      const event = types[key] || fallback;
      const handler = () => safe(() => code === 'chat-changed'
        ? diagnostics.record(code, diagnosticMetrics()) : recordPreset(code), 'diagnostic-event');
      source.on(event, handler); diagnosticListeners.push({ event, handler });
    }
    // With the window open, holdGeneration/finishGeneration record these.
    // Closed, they still show whether a reload happened during a reply.
    for (const [key, code] of [['GENERATION_STARTED', 'generation-start'],
      ['GENERATION_ENDED', 'generation-end'], ['GENERATION_STOPPED', 'generation-end']]) {
      const event = types[key] || FALLBACK_EVENTS[key];
      const handler = (_type, _options, dryRun) => safe(() => {
        if (state.enabled || extensionDisposed || (code === 'generation-start' && dryRun === true)) return;
        diagnostics.record(code, diagnosticMetrics());
      }, 'diagnostic-generation');
      source.on(event, handler); diagnosticListeners.push({ event, handler });
    }
  }
  function presetSelected(event) {
    if (event.target?.id === 'settings_preset_openai') safe(() => recordPreset('preset-selected'), 'preset-selected');
  }
  let lastPageError = 0;
  function recordPageError(event) {
    if (Date.now() - lastPageError < 1000) return;
    lastPageError = Date.now();
    safe(() => diagnostics.record(event.type === 'unhandledrejection' ? 'unhandled-rejection' : 'page-error', diagnosticMetrics()), 'page-error');
  }
  document.addEventListener('change', presetSelected, true);
  window.addEventListener('error', recordPageError);
  window.addEventListener('unhandledrejection', recordPageError);
  bindDiagnosticEvents();

  function requestReload(reason, interactive = false) {
    const generating = state.generating || nativeGenerating();
    if (!interactive || document.hidden || pageAway || frozen || generating) {
      pendingReload = reason;
      state.lastRenderError = generating ? '请等回复生成结束，再点击“刷新页面”。'
        : '设置已保存；请在方便时点击“刷新页面”使其生效。';
      diagnostics.record('reload-deferred');
      updateStatusPanel();
      return false;
    }
    diagnostics.markReload(reason);
    diagnostics.record('reload-requested', diagnosticMetrics());
    location.reload();
    return true;
  }

  function updateVisibility(event) {
    if (event.type === 'pagehide') pageAway = true;
    if (event.type === 'pageshow') pageAway = false;
    if (event.type === 'freeze') frozen = true;
    if (event.type === 'resume') frozen = false;
    const wasBackground = state.background;
    state.background = document.hidden || pageAway || frozen;
    renderQueue.setSuspended(state.background || state.paused || state.generating);
    diagnostics.record(event.type === 'visibilitychange' ? (state.background ? 'hidden' : 'visible') : event.type,
      { ...diagnosticMetrics(), persisted: !!event.persisted });
    if (state.background) {
      clearTimeout(state.applyTimer); state.applyTimer = 0;
      if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
      state.scrollRaf = 0;
    } else if (wasBackground && state.enabled && !state.paused && !state.generating) {
      const check = helperLifecycle.inspect();
      if (!check.ok) pauseWindow('helper-unavailable', `${check.reason} 窗口已暂停，当前页面已保留。`);
      else {
        movingWindow.resume();
        if (!windowMatchesChat()) {
          const appended = getChat().length > state.pinnedId + 1 && getChat()[state.pinnedId] === state.tailRef;
          if (state.forceApply || !appended || !syncTail()) scheduleApply(0, state.forceApply);
        }
      }
    }
    if (!state.background) updateStatusPanel();
  }
  const pageEvents = ['pagehide', 'pageshow'];
  const documentEvents = ['visibilitychange', 'freeze', 'resume'];
  pageEvents.forEach(name => window.addEventListener(name, updateVisibility));
  documentEvents.forEach(name => document.addEventListener(name, updateVisibility));
  renderQueue.setSuspended(state.background);

  function mountMessage(id, { beforeId, afterId } = {}) {
    const ctx = getCtx();
    const mes = ctx?.chat?.[id];
    if (!mes) return null;
    // 酒馆可能已经把这一层挂上去了（新消息就是它自己渲染的），
    // 再 addOneMessage 一次会出两个同 mesid 的楼层。
    const existing = getChatEl()?.querySelector(`:scope > .mes[mesid="${id}"]`);
    if (existing) return { el: existing, created: false };
    const opts = { forceId: id, scroll: false };
    if (typeof beforeId === 'number') opts.insertBefore = beforeId;
    else if (typeof afterId === 'number') opts.insertAfter = afterId;
    const result = ctx.addOneMessage(mes, opts);
    // ST 1.14 mounts the element but returns undefined; 1.18 returns jQuery.
    const el = result?.[0] || result?.get?.(0) ||
      getChatEl()?.querySelector(`:scope > .mes[mesid="${id}"]`) || null;
    if (el) {
      // Old ST versions treated insertion next to message 0 as a falsy option.
      const root = getChatEl();
      const before = typeof beforeId === 'number' ? root.querySelector(`:scope > .mes[mesid="${beforeId}"]`) : null;
      const after = typeof afterId === 'number' ? root.querySelector(`:scope > .mes[mesid="${afterId}"]`) : null;
      if (before && before !== el && el.nextElementSibling !== before) before.before(el);
      else if (after && after !== el && el.previousElementSibling !== after) after.after(el);
      const tail = root.querySelector(`:scope > .mes[mesid="${getChat().length - 1}"]`);
      if (tail && !tail.classList.contains('last_mes')) {
        root.querySelectorAll('.last_mes').forEach(node => node.classList.remove('last_mes'));
        tail.classList.add('last_mes');
      }
      mountedByUs.add(el);
    }
    return el ? { el, created: true } : null;
  }

  // addOneMessage 只重建正文，不会补发消息渲染事件；酒馆助手的楼层界面
  // 依赖该事件生成 iframe，所以重新挂载后要主动刷新一次。
  function refreshMountedMessages(ids, { force = false, owns = element => mountedByUs.has(element) } = {}) {
    if (state.paused || state.generating) return;
    renderQueue.enqueue(ids, { force, owns });
  }

  // 每条自刷新独立记时（不是整批共用一个定时器），过期后清掉，避免长期占用内存。
  function armSweep() {
    if (state.sweepTimer) return;
    state.sweepTimer = setInterval(() => {
      const now = Date.now();
      let alive = 0;
      for (const [key, expires] of state.selfRenders) {
        if (expires > now) alive++;
        else state.selfRenders.delete(key);
      }
      if (!alive) {
        clearInterval(state.sweepTimer);
        state.sweepTimer = 0;
      }
    }, SWEEP_INTERVAL);
  }

  function isSelfRender(id) {
    if (renderQueue.isRendering(id)) return true;
    const key = Number(id);
    const expires = state.selfRenders.get(key);
    if (expires == null) return false;
    if (expires < Date.now()) {
      state.selfRenders.delete(key);
      return false;
    }
    return true;
  }

  function clearSelfRenders() {
    state.selfRenders.clear();
    clearInterval(state.sweepTimer);
    state.sweepTimer = 0;
  }

  function refreshAllMounted() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const ids = [...chatEl.querySelectorAll(':scope > .mes')]
      .map(el => Number(el.getAttribute('mesid')))
      .filter(Number.isFinite);
    refreshMountedMessages(ids, { force: true });
  }

  function measureMounted() { return movingWindow.measure(); }

  function estimateHeight() {
    if (!state.heights.size) return config.defaultHeight;
    let total = 0;
    for (const height of state.heights.values()) total += height;
    return total / state.heights.size;
  }

  function sumHeights(from, to) {
    if (to < from) return 0;
    const fallback = estimateHeight();
    let total = 0;
    for (let i = from; i <= to; i++) total += state.heights.get(i) ?? fallback;
    return total;
  }

  function updateSpacers() { movingWindow.layout(); }

  function clearWindow() { return movingWindow.clear(); }

  function windowMatchesChat() { return movingWindow.matches(); }

  function apply(force = false) {
    if (state.paused || state.background || state.generating) return false;
    return movingWindow.apply(force);
  }

  function scheduleApply(delay = 120, force = false) {
    if (!state.enabled || state.paused) return;
    state.forceApply = state.forceApply || force;
    if (state.background || state.generating) return;
    clearTimeout(state.applyTimer);
    state.applyTimer = setTimeout(() => {
      state.applyTimer = 0;
      const forced = state.forceApply;
      state.forceApply = false;
      apply(forced);
    }, delay);
  }

  // 追加新楼层时只补挂尾部，不整窗重建。
  // 整窗重建会先删掉所有 .mes 再逐个 addOneMessage，画面就是「源码 → 渲染」闪一次；
  // 每来一条回复都闪一次太难看，所以窗口完好、只多了几层时走这条路。
  function syncTail() { return movingWindow.syncTail(); }

  function handleExternalRender(id) {
    if (state.paused || state.background || state.generating) return;
    if (!state.mounted) {
      scheduleApply(250);
      return;
    }
    const length = getChat().length;
    if (length > state.pinnedId + 1) {
      if (!syncTail()) scheduleApply(250);
      return;
    }
    if (length < state.pinnedId + 1) {
      scheduleApply(250);
      return;
    }
    if (Number(id) < state.start) return;
    measureMounted();
    updateSpacers();
  }











  function onScroll() { movingWindow.onScroll(); }

  function getMessageElement(mesid) { return movingWindow.getMessageElement(Number(mesid)); }

  function checkWindowIntegrity() { movingWindow.integrity(); }

  function bindEvents() {
    const ctx = getCtx();
    const chatEl = getChatEl();
    if (!ctx || !chatEl) return;
    state.chatEl = chatEl;
    state.eventSource = ctx.eventSource || window.eventSource || null;
    state.eventTypes = ctx.event_types || ctx.eventTypes || {};
    if (!state.eventSource?.on) {
      console.warn(LOG, 'eventSource unavailable, window will only work on manual apply');
      return;
    }

    const on = (key, handler) => {
      const event = state.eventTypes?.[key] || FALLBACK_EVENTS[key];
      if (!event) return;
      state.eventSource.on(event, handler);
      state.listeners.push({ event, handler });
    };

    // 进入聊天时 ST 也会发 CHAT_CHANGED，但那时挂的就是这份 chat；
    // 只有最后一层换了对象才是真的换聊天，才值得强制重建。
    on('CHAT_CHANGED', () => {
      const ctx = getCtx();
      const last = ctx?.chat?.[ctx.chat.length - 1] ?? null;
      scheduleApply(300, last !== state.tailRef);
    });
    on('CHARACTER_MESSAGE_RENDERED', id => {
      if (!isSelfRender(id)) handleExternalRender(id);
    });
    on('USER_MESSAGE_RENDERED', id => {
      if (!isSelfRender(id)) handleExternalRender(id);
    });
    on('MESSAGE_DELETED', () => scheduleApply(250));
    on('MORE_MESSAGES_LOADED', () => scheduleApply(250));
    on('GENERATION_AFTER_COMMANDS', beginGeneration);
    on('GENERATION_ENDED', onGenerationEnded);
    on('GENERATION_STOPPED', onGenerationEnded);
    on('MESSAGE_UPDATED', id => {
      if (state.generating) return;
      refreshMountedMessages([id]);
      measureMounted();
      updateSpacers();
      checkWindowIntegrity();
    });
    on('MESSAGE_SWIPED', id => {
      if (state.generating) return;
      refreshMountedMessages([id]);
      measureMounted();
      updateSpacers();
      checkWindowIntegrity();
    });

    chatEl.addEventListener('scroll', onScroll, { passive: true });
  }

  function unbindEvents() {
    for (const { event, handler } of state.listeners) {
      safe(() => {
        if (typeof state.eventSource?.removeListener === 'function') {
          state.eventSource.removeListener(event, handler);
        } else if (typeof state.eventSource?.off === 'function') {
          state.eventSource.off(event, handler);
        }
      }, 'unbind');
    }
    state.listeners = [];
    safe(() => getChatEl()?.removeEventListener('scroll', onScroll), 'unbind-scroll');
  }

  async function enable(options = {}, { interactive = false } = {}) {
    requestedEnable = true;
    if (extensionDisposed) return false;
    if (preparing) return preparing;
    if (pendingReload) { updateStatusPanel(); return true; }
    if (renderQueue.snapshot().stalled) { window.toastr?.warning('前端恢复未响应，请刷新酒馆后再试。'); return false; }
    if (restoring) { reenableOptions = options; return true; }
    if (state.enabled) return true;
    const ctx = getCtx();
    if (!ctx?.chat) {
      clearTimeout(state.enableTimer);
      state.enableTimer = setTimeout(() => { state.enableTimer = 0; void enable(options, { interactive }); }, 500);
      return true;
    }

    const lifecycleCheck = helperLifecycle.inspect();
    if (!lifecycleCheck.ok) {
      if (lifecycleCheck.pending) {
        helperWaitStarted ||= Date.now();
        state.lastRenderError = lifecycleCheck.reason;
        if (Date.now() - helperWaitStarted < 20000) {
          clearTimeout(state.enableTimer);
          state.enableTimer = setTimeout(() => { state.enableTimer = 0; void enable(options, { interactive: false }); }, 500);
          updateStatusPanel();
          return true;
        }
        state.lastRenderError = '酒馆助手尚未启动，窗口未开启。助手就绪后可重新勾选，原聊天保持显示。';
        setAutoEnabled(false);
        const checkbox = document.getElementById('dom_window_autostart');
        if (checkbox) checkbox.checked = false;
        updateStatusPanel(); return false;
      }
      if (lifecycleCheck.canConfigure) {
        if (!storage.persistent) {
          state.lastRenderError = '浏览器未允许保存网站数据，无法安全备份助手设置。请允许保存后再开启。';
          updateStatusPanel(); return false;
        }
        preparing = (async () => {
          state.lastRenderError = '正在自动适配助手设置，保存成功后会刷新一次…';
          updateStatusPanel();
          try {
            await helperSetup.configure();
            if (!requestedEnable) await helperSetup.restore();
            setAutoEnabled(requestedEnable);
            pendingReload = 'helper-configured';
            requestReload(pendingReload, interactive);
            return requestedEnable;
          } catch (error) {
            state.lastRenderError = error.message;
            window.toastr?.warning(error.message);
            setAutoEnabled(false);
            return false;
          } finally { preparing = null; updateStatusPanel(); }
        })();
        return preparing;
      }
      state.lastRenderError = lifecycleCheck.reason;
      helperWaitStarted = 0;
      setAutoEnabled(false);
      const checkbox = document.getElementById('dom_window_autostart');
      if (checkbox) checkbox.checked = false;
      diagnostics.record('helper-unavailable');
      window.toastr?.warning(lifecycleCheck.reason);
      updateStatusPanel();
      return false;
    }
    Object.assign(config, options || {});
    helperWaitStarted = 0;
    config.minWindow = Math.max(1, Math.min(MAX_PRELOAD, Math.trunc(Number(config.minWindow) || DEFAULT_PRELOAD)));
    config.maxWindow = config.minWindow;
    state.enabled = true;
    state.paused = false;
    renderQueue.setSuspended(state.background);
    state.lastRenderError = '';
    state.pinnedId = ctx.chat.length - 1;
    clearSelfRenders();

    if (config.manageTruncation) {
      const current = ctx.powerUserSettings?.chat_truncation ?? null;
      // A stored value means an earlier page changed truncation and never got
      // to restore it (for example an automatic reload). The live value is then
      // this extension's own setting, not the user's original.
      const stored = storage.getItem(TRUNCATION_KEY);
      const saved = stored != null && stored !== '' && Number.isFinite(Number(stored)) ? Number(stored) : null;
      state.originalTruncation = saved ?? current;
      if (saved == null && current != null) storage.setItem(TRUNCATION_KEY, String(current));
      if (ctx.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = config.maxWindow + 10;
        ctx.saveSettingsDebounced?.();
      }
    }

    bindEvents();
    // Enabling in an already-running generation misses its STARTED event.
    if (nativeGenerating()) { holdGeneration(); endGeneration(); }
    apply();
    diagnostics.record('enabled', diagnosticMetrics());
    updateStatusPanel();
    return true;
  }

  function disable() {
    requestedEnable = false;
    helperWaitStarted = 0;
    if (preparing) return preparing.then(() => undefined);
    clearTimeout(state.enableTimer);
    state.enableTimer = 0;
    clearTimeout(state.autoStartTimer);
    state.autoStartTimer = 0;
    if (!state.enabled) {
      reenableOptions = null;
      if (!restoring && helperSetup.hasBackup()) return restoreSettings();
      return restoring || Promise.resolve();
    }
    state.enabled = false;
    state.paused = false;
    state.generating = false;
    generationEventActive = false;
    clearTimeout(generationResumeTimer); generationResumeTimer = 0;
    generationIdleSince = 0; watchdogReleased = false;
    for (const resolve of generationWaiters) resolve();
    generationWaiters.clear();
    renderQueue.setSuspended(state.background);
    diagnostics.record('disabled');
    renderQueue.cancel();
    clearSelfRenders();
    clearTimeout(state.applyTimer);
    state.applyTimer = 0;
    state.forceApply = false;
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = 0;
    unbindEvents();
    restoring = (async () => {
      const ctx = getCtx();
      let cleared = false;
      const clearDisplay = async () => {
        try { await clearWindow(); } catch (error) { console.warn(LOG, 'release failed', error?.name); }
        state.mounted = false; state.heights.clear(); cleared = true;
      };
      // A background unload cannot wait for a manual reload after its UI is gone.
      // Release while the current helper settings still describe its live renderer.
      if (extensionDisposed && skipUnloadRefresh) await clearDisplay();
      let restore = state.originalTruncation;
      if (restore == null) {
        const stored = storage.getItem(TRUNCATION_KEY);
        if (stored != null && Number.isFinite(Number(stored))) restore = Number(stored);
      }
      if (restore != null && ctx?.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = restore;
        ctx.saveSettingsDebounced?.(); state.originalTruncation = null;
        storage.removeItem(TRUNCATION_KEY);
      }
      if (helperSetup.hasBackup()) {
        try {
          const changed = await helperSetup.restore();
          setAutoEnabled(false);
          if (changed) {
            const navigating = requestReload('helper-restored', true);
            if (navigating || !extensionDisposed) return;
          }
        } catch (error) {
          state.lastRenderError = error.message;
          window.toastr?.warning(error.message);
          if (!extensionDisposed) return;
        }
      }
      if (!cleared) await clearDisplay();
      const printed = safe(() => ctx?.printMessages?.(), 'restore rendering');
      if (printed?.then) await printed;
      if (skipUnloadRefresh) return;
      refreshAllMounted();
      try { await renderQueue.whenIdle(); } catch (error) {
        state.lastRenderError = '前端恢复未响应，窗口已关闭，请刷新酒馆恢复展示。';
        console.warn(LOG, state.lastRenderError, error?.name);
      }
    })().finally(() => {
      restoring = null;
      const options = reenableOptions; reenableOptions = null;
      if (options && !extensionDisposed) enable(options);
    });
    return restoring;
  }

  function restoreSettings() {
    if (preparing) return preparing;
    preparing = helperSetup.restore().then(changed => {
      setAutoEnabled(false);
      if (changed || pendingReload) requestReload('helper-restored', true);
    }).catch(error => { state.lastRenderError = error.message; })
      .finally(() => { preparing = null; updateStatusPanel(); });
    return preparing;
  }

  function audit() {
    const chatEl = getChatEl();
    const chat = getChat();
    return {
      version: VERSION,
      enabled: state.enabled,
      paused: state.paused,
      background: state.background,
      generating: state.generating,
      pendingReload: !!pendingReload,
      mounted: state.mounted,
      applying: state.applying || !!restoring || !!preparing,
      chatLength: chat.length,
      start: state.start,
      end: state.end,
      pinnedId: state.pinnedId,
      messagesInDom: chatEl?.querySelectorAll(':scope > .mes').length ?? 0,
      topSpacer: state.topSpacer?.offsetHeight ?? 0,
      bottomSpacer: state.bottomSpacer?.offsetHeight ?? 0,
      heightCache: state.heights.size,
      domNodes: document.querySelectorAll('*').length,
      lastMes: chatEl?.querySelector('.last_mes')?.getAttribute('mesid') ?? null,
      renderQueue: renderQueue.snapshot(),
      windowSize: movingWindow.size(),
      helperLifecycle: helperLifecycle.inspect(),
    };
  }

  const api = {
    version: VERSION,
    config,
    enable,
    disable,
    apply,
    audit,
    diagnostics: getDiagnostics,
    getChat,
    getMessageElement,
    get enabled() {
      return state.enabled;
    },
  };

  window.STDOMWindow = api;

  function getPreloadSize() {
    const raw = Number(storage.getItem(PRELOAD_KEY));
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PRELOAD;
    return Math.min(MAX_PRELOAD, Math.trunc(raw));
  }

  function getAutoOptions() {
    const size = getPreloadSize();
    return { minWindow: size, maxWindow: size, batch: 2, manageTruncation: true };
  }

  function isAutoEnabled() {
    return storage.getItem(STORAGE_KEY) === '1';
  }

  function setAutoEnabled(on) {
    storage.setItem(STORAGE_KEY, on ? '1' : '0');
  }

  async function initSettingsPanel() {
    if (extensionDisposed || document.getElementById('dom_window_settings')) return;
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    try {
      const response = await fetch(`${EXTENSION_BASE}settings.html`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (extensionDisposed) return;
      container.insertAdjacentHTML('beforeend', html);
      // settings.html is fetched without cache; show the build of the script
      // that is actually running, so a cached index.js cannot pass unnoticed.
      const buildLabel = document.getElementById('dom_window_build');
      if (buildLabel) buildLabel.textContent = BUILD.startsWith('本地预览-')
        ? BUILD.replace(/^本地预览-(\d{4})(\d{2})(\d{2})-/, '本地预览 · $1-$2-$3 · ') : `2026-11-10 · ${BUILD}`;

      const checkbox = document.getElementById('dom_window_autostart');
      if (!checkbox) return;
      checkbox.checked = isAutoEnabled();
      checkbox.addEventListener('change', async () => {
        const on = checkbox.checked;
        checkbox.disabled = true;
        setAutoEnabled(on);
        try {
          if (on && !await enable(getAutoOptions(), { interactive: true })) { checkbox.checked = false; setAutoEnabled(false); }
          else if (!on) await disable();
        } finally { checkbox.disabled = false; updateStatusPanel(); }
      });

      const preloadInput = document.getElementById('dom_window_preload');
      const saveButton = document.getElementById('dom_window_preload_save');
      if (preloadInput) preloadInput.value = String(getPreloadSize());
      if (saveButton && preloadInput) {
        saveButton.addEventListener('click', () => {
          const raw = Number(preloadInput.value);
          const size = Number.isFinite(raw) && raw >= 1
            ? Math.min(MAX_PRELOAD, Math.trunc(raw))
            : DEFAULT_PRELOAD;
          preloadInput.value = String(size);
          storage.setItem(PRELOAD_KEY, String(size));
          config.minWindow = size; config.maxWindow = size;
          if (state.enabled) movingWindow.resize();
          window.toastr?.info(state.enabled ? `阅读窗口已调整为 ${size} 层` : '已保存，开启窗口时直接生效');
          updateStatusPanel();
        });
      }
      document.getElementById('dom_window_reload')?.addEventListener('click', () => requestReload(pendingReload || 'manual-recovery', true));
      document.getElementById('dom_window_restore')?.addEventListener('click', () => { void restoreSettings(); });
      const diagnosticButton = document.getElementById('dom_window_diagnostics');
      const diagnosticOutput = document.getElementById('dom_window_diagnostics_output');
      const diagnosticFeedback = document.getElementById('dom_window_diagnostics_feedback');
      diagnosticButton?.addEventListener('click', async () => {
        const content = JSON.stringify(getDiagnostics(), null, 2);
        updateDiagnosticSummary();
        diagnosticOutput.value = content; diagnosticOutput.hidden = false;
        document.getElementById('dom_window_diagnostics_tools').hidden = false;
        diagnosticFeedback.hidden = false; diagnosticFeedback.textContent = '正在复制…';
        diagnosticButton.disabled = true;
        try {
          const copied = await copyDiagnosticText(diagnosticOutput);
          diagnosticFeedback.textContent = copied ? '诊断信息已复制，可以直接粘贴。'
            : '浏览器未允许自动复制。点“全选文本”后长按文字，选择“复制”；也可以下载诊断文件。';
        } finally { diagnosticButton.disabled = false; }
      });
      document.getElementById('dom_window_diagnostics_select')?.addEventListener('click', () => {
        const selected = selectDiagnosticText(diagnosticOutput);
        diagnosticFeedback.textContent = selected ? '已选中文本。长按文字选择“复制”，或使用系统复制快捷键。'
          : '浏览器未能全选。请长按下方文字手动选择，或下载诊断文件。';
      });
      document.getElementById('dom_window_diagnostics_download')?.addEventListener('click', () => {
        // Save the report already shown, keeping copy and download identical.
        let url, link;
        try {
          url = URL.createObjectURL(new Blob([diagnosticOutput.value], { type: 'application/json;charset=utf-8' }));
          link = document.createElement('a'); link.href = url; link.download = 'DOM-Window-诊断.json';
          document.body.append(link); link.click();
          diagnosticFeedback.textContent = '已请求下载诊断文件，请查看浏览器的下载列表。';
        } catch {
          diagnosticFeedback.textContent = '浏览器未能下载文件，请全选下方文本后复制。';
        } finally {
          link?.remove();
          if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
      });
      updateStatusPanel();
    } catch (err) {
      console.warn(LOG, 'settings panel failed', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsPanel);
  } else {
    initSettingsPanel();
  }

  const statusStartedAt = performance.now();

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  }

  function formatMemory(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    return `${Math.round(bytes / 1048576)} MB`;
  }

  function updateDiagnosticSummary() {
    const output = document.getElementById('dom_window_diagnostics_summary');
    if (!output) return;
    const info = diagnostics.recovery();
    const time = value => value == null ? '未取得' : new Date(value).toLocaleString();
    const id = value => value ? value.slice(-8) : '无编号';
    const text = `${info.message}\n本页 ${id(info.currentPageId)}：${time(info.currentStartedAt)}。` +
      `\n上次 ${id(info.previousPageId)}：${time(info.previousStartedAt)}；最后记录：${time(info.previousLastRecordedAt)}。` +
      `\n保留 ${info.retainedPreviousPages} 次历史页面记录。` +
      (info.source === 'browser-backup' ? ' 上次记录来自浏览器本地备份。' : '') +
      (info.unlinkedBrowserPages ? ` 另有 ${info.unlinkedBrowserPages} 份来源未确认的浏览器记录，可能属于其他标签页。` : '') +
      (!info.sessionStorageAvailable && !info.browserBackupAvailable ? ' 浏览器未允许持久保存，离开页面后记录可能丢失。' : '');
    if (output.textContent !== text) output.textContent = text;
  }

  function updateStatusPanel() {
    const statusEl = document.getElementById('dom_window_status');
    if (!statusEl) return;
    updateDiagnosticSummary();

    const chat = getChat();
    const chatEl = getChatEl();
    const mounted = chatEl?.querySelectorAll(':scope > .mes').length ?? 0;
    const enabled = state.enabled;
    const active = enabled && state.mounted && state.pinnedId != null && state.pinnedId >= 0;
    const range = active ? `${state.start}–${state.end}${state.end < state.pinnedId ? ' + 末楼' : ''}` : '—';
    const memory = performance.memory?.usedJSHeapSize;
    const queue = renderQueue.snapshot();
    const nodes = document.getElementsByTagName('*').length;
    const stateText = preparing ? '正在保存设置' : pendingReload ? '等待刷新' : state.paused ? '已暂停'
      : state.enableTimer && helperWaitStarted ? '等待助手'
      : !enabled ? '已关闭' : state.background ? '后台暂停' : state.generating ? '生成中，暂缓回收' : active ? '已开启' : '等待挂载';
    const compatibility = document.getElementById('dom_window_compatibility');
    if (compatibility) {
      const check = helperLifecycle.inspect();
      compatibility.textContent = !storage.persistent ? '浏览器未允许保存网站数据，窗口设置只在本次页面内保留。' : !check.ok ? check.reason : helperSetup.hasBackup()
        ? '助手已自动适配；关闭窗口后会还原原设置并刷新。' : '开启即可使用，无需另改助手设置。';
    }

    document.getElementById('dom_window_timer').textContent =
      `运行 ${formatDuration(performance.now() - statusStartedAt)}`;
    document.getElementById('dom_window_state').textContent = stateText;
    statusEl.dataset.enabled = String(enabled);
    document.getElementById('dom_window_metrics').textContent =
      `窗口 ${range} · 已加载 ${mounted}/${chat.length} 层\n页面元素 ${nodes} · 聊天内前端 ${chatEl?.querySelectorAll('iframe').length || 0}` +
      (Number.isFinite(memory) ? `\n脚本堆 ${formatMemory(memory)}（不含页面全部内存）` : '') +
      `\n前端恢复：运行 ${queue.running} · 等待 ${queue.pending}` +
      (state.lastRenderError ? `\n${state.lastRenderError}` : '');

    const badge = document.getElementById('dom_window_header_state');
    if (badge) badge.textContent = state.paused || pendingReload || preparing || state.background || state.generating ? stateText
      : !enabled ? '已关闭' : active ? `已开启 · ${mounted} 层` : '等待挂载';
    const reloadButton = document.getElementById('dom_window_reload');
    if (reloadButton) reloadButton.hidden = !state.paused && !pendingReload;
    const restoreButton = document.getElementById('dom_window_restore');
    if (restoreButton) { restoreButton.hidden = state.enabled || isAutoEnabled() || !helperSetup.hasBackup(); restoreButton.disabled = !!preparing; }
  }

  let lastSample = 0;
  const statusInterval = setInterval(() => {
    bindDiagnosticEvents();
    safe(() => checkGenerationWatchdog(), 'generation-watchdog');
    if (!document.hidden) updateStatusPanel();
    if (!document.hidden && Date.now() - lastCheckpoint >= 10000) {
      // Every third checkpoint also keeps a small trend sample (30 at most).
      const sample = Date.now() - lastSample >= 30000;
      lastCheckpoint = Date.now(); if (sample) lastSample = lastCheckpoint;
      diagnostics.checkpoint(diagnosticMetrics(), { sample });
    }
  }, 1000);
  updateStatusPanel();

  disposeExtension = async () => {
    extensionDisposed = true;
    skipUnloadRefresh = state.background || state.paused || renderQueue.snapshot().running > 0;
    if (skipUnloadRefresh) renderQueue.dispose();
    clearInterval(statusInterval);
    clearPresetSamples(); unbindDiagnosticEvents();
    document.removeEventListener('change', presetSelected, true);
    window.removeEventListener('error', recordPageError);
    window.removeEventListener('unhandledrejection', recordPageError);
    pageEvents.forEach(name => window.removeEventListener(name, updateVisibility));
    documentEvents.forEach(name => document.removeEventListener(name, updateVisibility));
    document.getElementById('dom_window_settings')?.remove();
    await disable();
    renderQueue.dispose();
    if (window.STDOMWindow === api) delete window.STDOMWindow;
  };

  if (location.search.includes('domwindow=1') || isAutoEnabled()) {
    state.autoStartTimer = setTimeout(() => {
      state.autoStartTimer = 0;
      if (location.search.includes('domwindow=1') || isAutoEnabled()) {
        void enable(getAutoOptions()).then(ok => {
          if (!ok) { setAutoEnabled(false); const checkbox = document.getElementById('dom_window_autostart'); if (checkbox) checkbox.checked = false; }
        });
      }
    }, 1200);
  }

  log('loaded', VERSION);
})();
