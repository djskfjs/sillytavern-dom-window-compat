/**
 * DOM Window 0.4.3-compat.4 — compatibility test build
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
import { createRenderQueue } from './render-queue.js';
import { createMovingWindow } from './moving-window.js';
import { createHelperLifecycle } from './helper-lifecycle.js';
import { createHelperSetup } from './helper-setup.js';

let disposeExtension = () => {};
export function disable() { return disposeExtension(); }

(() => {
  'use strict';

  const VERSION = '0.4.3-compat.4';
  const LOG = '[DOMWindow]';
  let extensionDisposed = false;
  let restoring = null;
  let reenableOptions = null;
  let preparing = null;
  let requestedEnable = false;
  let recoveryAttempted = false;
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
  const FALLBACK_EVENTS = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
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
    debug: false,
  };

  const state = {
    enabled: false,
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
      state.lastRenderError = '助手前端恢复未响应，已暂停新的恢复任务。请关闭扩展后刷新。';
      setAutoEnabled(false);
      const checkbox = document.getElementById('dom_window_autostart');
      if (checkbox) checkbox.checked = false;
      updateStatusPanel();
      void disable();
    },
    onError: (id, error) => {
      state.lastRenderError = `第 ${id} 层前端恢复失败（${error?.name || 'Error'}），可关闭窗口模式重新进入。`;
      console.warn(LOG, '前端恢复失败', id, error?.name || 'Error');
      updateStatusPanel();
    },
  });

  const helperLifecycle = createHelperLifecycle({ getRoot: getChatEl, getHelper: () => window.TavernHelper, getContext: getCtx });
  const deviceKey = 'STDOMWindow.compat.device';
  const settingsOwner = localStorage.getItem(deviceKey) || globalThis.crypto?.randomUUID?.() ||
    `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(deviceKey, settingsOwner);
  const helperSetup = createHelperSetup({ getHelper: () => window.TavernHelper, getContext: getCtx, owner: settingsOwner });
  const movingWindow = createMovingWindow({ state, config, getRoot: getChatEl, getChat, mountMessage, renderQueue,
    refreshMessages: refreshMountedMessages, lifecycle: helperLifecycle,
    onRangeChanged: () => updateStatusPanel(),
    onFailure: error => {
      state.lastRenderError = '窗口恢复失败，已关闭并恢复普通展示。';
      console.warn(LOG, state.lastRenderError, error?.name);
      void disable();
    },
  });

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

  function apply(force = false) { return movingWindow.apply(force); }

  function scheduleApply(delay = 120, force = false) {
    if (!state.enabled) return;
    state.forceApply = state.forceApply || force;
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
    on('MESSAGE_UPDATED', id => {
      refreshMountedMessages([id]);
      measureMounted();
      updateSpacers();
      checkWindowIntegrity();
    });
    on('MESSAGE_SWIPED', id => {
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

  async function enable(options = {}) {
    requestedEnable = true;
    if (extensionDisposed) return false;
    if (preparing) return preparing;
    if (renderQueue.snapshot().stalled) { window.toastr?.warning('前端恢复未响应，请刷新酒馆后再试。'); return false; }
    if (restoring) { reenableOptions = options; return true; }
    if (state.enabled) return true;
    const ctx = getCtx();
    if (!ctx?.chat) {
      clearTimeout(state.enableTimer);
      state.enableTimer = setTimeout(() => { state.enableTimer = 0; enable(options); }, 200);
      return true;
    }

    const lifecycleCheck = helperLifecycle.inspect();
    if (!lifecycleCheck.ok) {
      if (lifecycleCheck.canConfigure) {
        preparing = (async () => {
          state.lastRenderError = '正在自动适配助手设置，保存成功后会刷新一次…';
          updateStatusPanel();
          try {
            await helperSetup.configure();
            if (!requestedEnable) await helperSetup.restore();
            setAutoEnabled(requestedEnable);
            location.reload();
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
      window.toastr?.warning(lifecycleCheck.reason);
      updateStatusPanel();
      return false;
    }
    Object.assign(config, options || {});
    config.minWindow = Math.max(1, Math.min(MAX_PRELOAD, Math.trunc(Number(config.minWindow) || DEFAULT_PRELOAD)));
    config.maxWindow = config.minWindow;
    state.enabled = true;
    state.lastRenderError = '';
    state.pinnedId = ctx.chat.length - 1;
    clearSelfRenders();

    if (config.manageTruncation) {
      const current = ctx.powerUserSettings?.chat_truncation ?? null;
      state.originalTruncation = current;
      if (current != null && localStorage.getItem(TRUNCATION_KEY) == null) {
        localStorage.setItem(TRUNCATION_KEY, String(current));
      }
      if (ctx.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = config.maxWindow + 10;
        ctx.saveSettingsDebounced?.();
      }
    }

    bindEvents();
    apply();
    updateStatusPanel();
    return true;
  }

  function disable() {
    requestedEnable = false;
    if (preparing) return preparing.then(() => undefined);
    clearTimeout(state.enableTimer);
    state.enableTimer = 0;
    clearTimeout(state.autoStartTimer);
    state.autoStartTimer = 0;
    if (!state.enabled) { reenableOptions = null; return restoring || Promise.resolve(); }
    state.enabled = false;
    renderQueue.cancel();
    clearSelfRenders();
    clearTimeout(state.applyTimer);
    state.applyTimer = 0;
    state.forceApply = false;
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = 0;
    unbindEvents();
    restoring = (async () => {
      try { await clearWindow(); } catch (error) { console.warn(LOG, 'release failed', error?.name); }
      state.mounted = false; state.heights.clear();
      const ctx = getCtx();
      let restore = state.originalTruncation;
      if (restore == null) {
        const stored = localStorage.getItem(TRUNCATION_KEY);
        if (stored != null && Number.isFinite(Number(stored))) restore = Number(stored);
      }
      if (restore != null && ctx?.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = restore;
        ctx.saveSettingsDebounced?.(); state.originalTruncation = null;
        localStorage.removeItem(TRUNCATION_KEY);
      }
      if (helperSetup.hasBackup()) {
        try {
          const changed = await helperSetup.restore();
          setAutoEnabled(false);
          if (changed) { location.reload(); return; }
        } catch (error) {
          state.lastRenderError = error.message;
          recoveryAttempted = true;
          window.toastr?.warning(error.message);
        }
      }
      const printed = safe(() => ctx?.printMessages?.(), 'restore rendering');
      if (printed?.then) await printed;
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

  function audit() {
    const chatEl = getChatEl();
    const chat = getChat();
    return {
      version: VERSION,
      enabled: state.enabled,
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
    getChat,
    getMessageElement,
    get enabled() {
      return state.enabled;
    },
  };

  window.STDOMWindow = api;

  function getPreloadSize() {
    const raw = Number(localStorage.getItem(PRELOAD_KEY));
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PRELOAD;
    return Math.min(MAX_PRELOAD, Math.trunc(raw));
  }

  function getAutoOptions() {
    const size = getPreloadSize();
    return { minWindow: size, maxWindow: size, batch: 2, manageTruncation: true };
  }

  function isAutoEnabled() {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }

  function setAutoEnabled(on) {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
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

      const checkbox = document.getElementById('dom_window_autostart');
      if (!checkbox) return;
      checkbox.checked = isAutoEnabled();
      checkbox.addEventListener('change', async () => {
        const on = checkbox.checked;
        checkbox.disabled = true;
        setAutoEnabled(on);
        try {
          if (on && !await enable(getAutoOptions())) { checkbox.checked = false; setAutoEnabled(false); }
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
          localStorage.setItem(PRELOAD_KEY, String(size));
          config.minWindow = size; config.maxWindow = size;
          if (state.enabled) movingWindow.resize();
          window.toastr?.info(state.enabled ? `阅读窗口已调整为 ${size} 层` : '已保存，开启窗口时直接生效');
          updateStatusPanel();
        });
      }
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

  function updateStatusPanel() {
    const statusEl = document.getElementById('dom_window_status');
    if (!statusEl) return;

    const chat = getChat();
    const chatEl = getChatEl();
    const mounted = chatEl?.querySelectorAll(':scope > .mes').length ?? 0;
    const enabled = state.enabled;
    const active = enabled && state.mounted && state.pinnedId != null && state.pinnedId >= 0;
    const range = active ? `${state.start}–${state.pinnedId}（${mounted} 层）` : '—';
    const memory = performance.memory?.usedJSHeapSize;
    const queue = renderQueue.snapshot();
    const nodes = document.getElementsByTagName('*').length;
    const stateText = preparing ? '正在自动适配' : !enabled ? '已关闭' : active ? '已开启' : '等待挂载';
    const compatibility = document.getElementById('dom_window_compatibility');
    if (compatibility) {
      const check = helperLifecycle.inspect();
      compatibility.textContent = !check.ok ? check.reason : helperSetup.hasBackup()
        ? '助手已自动适配；关闭窗口后会还原原设置并刷新。' : '开启即可使用，无需另改助手设置。';
    }

    document.getElementById('dom_window_timer').textContent =
      `运行 ${formatDuration(performance.now() - statusStartedAt)}`;
    document.getElementById('dom_window_state').textContent = stateText;
    statusEl.dataset.enabled = String(enabled);
    document.getElementById('dom_window_metrics').textContent =
      `窗口 ${range} · 已加载 ${mounted}/${chat.length} 层\nDOM ${nodes} · 堆内存 ${formatMemory(memory)}` +
      `\n前端恢复：运行 ${queue.running} · 等待 ${queue.pending}` +
      (state.lastRenderError ? `\n${state.lastRenderError}` : '');

    const badge = document.getElementById('dom_window_header_state');
    if (badge) badge.textContent = !enabled ? '已关闭' : active ? `已开启 · ${mounted} 层` : '等待挂载';
  }

  const statusInterval = setInterval(() => {
    if (!document.hidden) updateStatusPanel();
    // Recover this browser's interrupted shutdown using its account-scoped
    // backup. Another browser opening the account must not undo adaptation.
    if (!state.enabled && !isAutoEnabled() && !preparing && !restoring && !recoveryAttempted &&
      helperSetup.hasBackup() && window.TavernHelper?.builtin?.saveSettings && !window.TavernHelper.builtin.duringGenerating?.()) {
      recoveryAttempted = true;
      preparing = helperSetup.restore().then(changed => { if (changed) location.reload(); })
        .catch(error => { state.lastRenderError = error.message; })
        .finally(() => { preparing = null; updateStatusPanel(); });
    }
  }, 1000);
  updateStatusPanel();

  disposeExtension = async () => {
    extensionDisposed = true;
    clearInterval(statusInterval);
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
