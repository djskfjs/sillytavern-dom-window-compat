/** DOM Window compatibility patch. Distributed under the accompanying LICENSE. */
export function hasFrontendCandidate(message, element) {
  // Regexes and display formatting can generate frontends absent from message.mes.
  // Let Tavern Helper decide whether a displayed code block is renderable.
  if (element?.querySelector('.mes_text pre code')) return true;
  return /PlaceHolder|<html[\s>]|<head[\s>]|<body[\s>]/i.test(String(message?.mes || ''));
}

export function createRenderQueue({ getRoot, getChat, refresh, markSelfRender,
  beforeRefresh = () => null, afterRefresh = () => {}, onError = () => {},
  onStall = () => {}, settleMs = 160, stallMs = 15000 }) {
  const pending = new Map();
  let generation = 0;
  let active = null;
  let timer = 0;
  let stallTimer = 0;
  let stalled = false;
  let disposed = false;
  let scrollSettledAt = 0;
  let completed = 0;
  let discarded = 0;
  let errors = 0;
  const waiters = new Set();

  function valid(item) {
    const root = getRoot();
    const message = getChat()[item.id];
    return !item.invalidated && item.generation === generation && root?.isConnected && root.contains(item.element) &&
      root.querySelector(`:scope > .mes[mesid="${item.id}"]`) === item.element &&
      message === item.message && message?.mes === item.text && message?.swipe_id === item.swipe;
  }

  function priority(item) {
    const root = getRoot();
    const viewport = root.getBoundingClientRect();
    const rect = item.element.getBoundingClientRect();
    if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) return 0;
    if (item.id === getChat().length - 1) return 1;
    const distance = item.force ? Math.abs(rect.top - viewport.top)
      : Math.min(Math.abs(rect.top - viewport.bottom), Math.abs(rect.bottom - viewport.top));
    return Number.isFinite(distance) ? 2 + distance : Number.MAX_SAFE_INTEGER;
  }

  function notifyIdle() {
    if (active || pending.size) return;
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  }

  function markWaiting(item) {
    item.element.classList.add('dom-window-render-pending');
    const text = item.element.querySelector('.mes_text');
    if (!text) return;
    const hint = item.element.ownerDocument.createElement('span');
    hint.className = 'dom-window-render-hint';
    hint.textContent = '正在恢复前端界面…';
    text.prepend(hint);
    item.hint = hint;
  }

  function clearWaiting(item) {
    const replacement = pending.get(item.id);
    if (!replacement || replacement === item || replacement.element !== item.element) {
      item.element.classList.remove('dom-window-render-pending');
    }
    item.hint?.remove();
    item.hint = null;
  }

  function clearPending() {
    discarded += pending.size;
    for (const item of pending.values()) clearWaiting(item);
    pending.clear();
  }

  function prune() {
    let removed = 0;
    for (const [id, item] of pending) {
      if (valid(item)) continue;
      pending.delete(id); clearWaiting(item); removed++;
    }
    discarded += removed;
    if (active && !valid(active)) clearWaiting(active);
    notifyIdle();
    return removed;
  }

  function discard(ids) {
    let removed = 0;
    for (const value of ids) {
      const id = Number(value), item = pending.get(id);
      if (item) { pending.delete(id); clearWaiting(item); removed++; }
      if (active?.id === id) { active.invalidated = true; clearWaiting(active); }
    }
    discarded += removed; schedule();
    return removed;
  }

  function armStallTimer(item) {
    clearTimeout(stallTimer);
    if (!Number.isFinite(stallMs) || stallMs <= 0) return;
    stallTimer = setTimeout(() => {
      stallTimer = 0;
      if (disposed || active !== item) return;
      stalled = true; item.invalidated = true;
      clearPending(); clearWaiting(item); clearTimeout(timer); timer = 0; errors++;
      const error = new Error('Frontend refresh did not finish within the allowed time');
      error.name = 'TimeoutError';
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
      // The original promise is still running. Never start another refresh.
      try { onStall(item.id, error); } catch (callbackError) {
        console.warn('[DOMWindow]', 'stall callback failed', callbackError);
      }
    }, stallMs);
  }

  function schedule(delay = 0) {
    if (disposed || active || stalled || !pending.size) {
      clearTimeout(timer); timer = 0; notifyIdle(); return;
    }
    clearTimeout(timer);
    timer = setTimeout(pump, Math.max(delay, scrollSettledAt - performance.now(), 0));
  }

  async function pump() {
    timer = 0;
    if (disposed || active || stalled) return;
    if (performance.now() < scrollSettledAt) { schedule(); return; }
    let next;
    let best = Infinity;
    for (const [id, item] of pending) {
      if (!valid(item)) { clearWaiting(item); pending.delete(id); discarded++; continue; }
      // Helper's normal range audit may have rendered other queued floors.
      // Reuse those runtimes instead of replacing their iframe a second time.
      if (!item.force && item.element.querySelector('iframe[id^="TH-message--"]')) {
        pending.delete(id); clearWaiting(item); completed++; continue;
      }
      const value = priority(item);
      if (value < best) { next = item; best = value; }
    }
    if (!next) { notifyIdle(); return; }
    pending.delete(next.id);
    active = next;
    try {
      const anchor = beforeRefresh(next);
      markSelfRender(next.id);
      armStallTimer(next);
      await refresh(next.id, next.element);
      if (valid(next)) {
        completed++;
        markSelfRender(next.id);
        afterRefresh(next, anchor);
      } else discarded++;
    } catch (error) {
      if (valid(next)) {
        errors++;
        try { onError(next.id, error); } catch (callbackError) {
          console.warn('[DOMWindow]', 'error callback failed', callbackError);
        }
      }
    } finally {
      clearTimeout(stallTimer); stallTimer = 0;
      clearWaiting(next);
      active = null;
      stalled = false;
      schedule();
    }
  }

  return {
    enqueue(ids, { force = false, owns = () => true } = {}) {
      prune();
      if (disposed || stalled) return;
      const root = getRoot();
      for (const value of ids) {
        const id = Number(value);
        if (!Number.isInteger(id) || id < 0) continue;
        const element = root?.querySelector(`:scope > .mes[mesid="${id}"]`);
        const message = getChat()[id];
        if (!message || !element || (!force && !owns(element)) || !hasFrontendCandidate(message, element)) continue;
        if (active?.id === id && active.element === element && valid(active)) continue;
        const previous = pending.get(id);
        if (previous) clearWaiting(previous);
        const item = { id, element, message, text: message.mes, swipe: message.swipe_id, generation, force };
        pending.set(id, item);
        markWaiting(item);
      }
      schedule(settleMs);
    },
    defer() {
      prune();
      scrollSettledAt = performance.now() + settleMs;
      schedule();
    },
    prune,
    discard,
    cancel() {
      generation++;
      clearPending();
      if (active) clearWaiting(active);
      clearTimeout(timer);
      timer = 0;
      if (!active) { clearTimeout(stallTimer); stallTimer = 0; stalled = false; }
      scrollSettledAt = 0;
      notifyIdle();
    },
    isRendering(id) { return active?.id === Number(id) && valid(active); },
    snapshot() { return { pending: pending.size, ready: [...pending.values()].filter(item => valid(item) && Number.isFinite(priority(item))).length,
      running: active ? 1 : 0, completed, discarded, errors, stalled }; },
    whenIdle() {
      if (stalled) { const error = new Error('Frontend refresh stalled; reload is required'); error.name = 'TimeoutError'; return Promise.reject(error); }
      if (!active && !pending.size) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.add({ resolve, reject }));
    },
    dispose() {
      this.cancel();
      disposed = true;
      clearTimeout(stallTimer); stallTimer = 0;
    },
  };
}
