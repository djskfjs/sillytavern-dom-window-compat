/** DOM Window compatibility patch. Distributed under the accompanying LICENSE. */
export function hasFrontendCandidate(message, element) {
  // Regexes and display formatting can generate frontends absent from message.mes.
  // Let Tavern Helper decide whether a displayed code block is renderable.
  if (element?.querySelector('.mes_text pre code')) return true;
  return /PlaceHolder|<html[\s>]|<head[\s>]|<body[\s>]/i.test(String(message?.mes || ''));
}

export function createRenderQueue({ getRoot, getChat, refresh, markSelfRender,
  beforeRefresh = () => null, afterRefresh = () => {}, onError = () => {}, settleMs = 160 }) {
  const pending = new Map();
  let generation = 0;
  let active = null;
  let timer = 0;
  let disposed = false;
  let scrollSettledAt = 0;
  let completed = 0;
  let discarded = 0;
  let errors = 0;
  const waiters = new Set();

  function valid(item) {
    const root = getRoot();
    const message = getChat()[item.id];
    return item.generation === generation && root?.isConnected && root.contains(item.element) &&
      root.querySelector(`:scope > .mes[mesid="${item.id}"]`) === item.element &&
      message === item.message && message?.mes === item.text && message?.swipe_id === item.swipe;
  }

  function priority(item) {
    const root = getRoot();
    const viewport = root.getBoundingClientRect();
    const rect = item.element.getBoundingClientRect();
    if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) return 0;
    if (item.id === getChat().length - 1) return 1;
    if (item.force) return 2 + Math.abs(rect.top - viewport.top);
    const margin = root.clientHeight * 2;
    if (rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin) return Infinity;
    return 2 + Math.min(Math.abs(rect.top - viewport.bottom), Math.abs(rect.bottom - viewport.top));
  }

  function notifyIdle() {
    if (active || pending.size) return;
    for (const resolve of waiters) resolve();
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
  }

  function schedule(delay = 0) {
    if (disposed || active || !pending.size) { notifyIdle(); return; }
    clearTimeout(timer);
    timer = setTimeout(pump, Math.max(delay, scrollSettledAt - performance.now(), 0));
  }

  async function pump() {
    timer = 0;
    if (disposed || active) return;
    if (performance.now() < scrollSettledAt) { schedule(); return; }
    let next;
    let best = Infinity;
    for (const [id, item] of pending) {
      if (!valid(item)) { clearWaiting(item); pending.delete(id); discarded++; continue; }
      const value = priority(item);
      if (value < best) { next = item; best = value; }
    }
    // Far but still mounted jobs remain pending until scrolling makes them visible.
    if (!next) { notifyIdle(); return; }
    pending.delete(next.id);
    active = next;
    const anchor = beforeRefresh(next);
    try {
      markSelfRender(next.id);
      await refresh(next.id, next.element);
      if (valid(next)) {
        completed++;
        markSelfRender(next.id);
        afterRefresh(next, anchor);
      } else discarded++;
    } catch (error) {
      if (valid(next)) { errors++; onError(next.id, error); }
    } finally {
      clearWaiting(next);
      active = null;
      schedule();
    }
  }

  return {
    enqueue(ids, { force = false, owns = () => true } = {}) {
      if (disposed) return;
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
      scrollSettledAt = performance.now() + settleMs;
      schedule();
    },
    cancel() {
      generation++;
      discarded += pending.size;
      for (const item of pending.values()) clearWaiting(item);
      if (active) clearWaiting(active);
      pending.clear();
      clearTimeout(timer);
      timer = 0;
      scrollSettledAt = 0;
      notifyIdle();
    },
    isRendering(id) { return active?.id === Number(id) && valid(active); },
    snapshot() { return { pending: pending.size, ready: [...pending.values()].filter(item => valid(item) && Number.isFinite(priority(item))).length,
      running: active ? 1 : 0, completed, discarded, errors }; },
    whenIdle() {
      if (!active && !pending.size) return Promise.resolve();
      return new Promise(resolve => waiters.add(resolve));
    },
    dispose() {
      this.cancel();
      disposed = true;
    },
  };
}
