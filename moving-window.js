import { hasFrontendCandidate } from './render-queue.js?v=0.4.3-compat.8';

/** Continuous reading window; chat data and saved message IDs are untouched. */
export function createMovingWindow({ state, config, getRoot, getChat, mountMessage,
  renderQueue, refreshMessages, lifecycle, onFailure, onRangeChanged = () => {}, beforeMount = () => {} }) {
  const references = new WeakMap();
  let fallbackHeight = 0;
  let generation = 0;
  let changing = false;
  let target = null;
  let layoutAnchor = null;
  let correction = null;
  let lastScrollTop = 0;
  let observer = null;
  let transitionGeometry = null;
  let originalScrollAnchor = null;
  const reservations = new Map();
  const transitionSlots = new Set();
  const settledDuringTransition = new Set();
  const root = () => getRoot();
  const running = () => state.enabled && !state.paused && !state.background && !state.generating;
  const rows = () => [...(root()?.querySelectorAll(':scope > .mes') || [])];
  const size = () => Math.min(getChat().length, Math.max(1, Math.trunc(Number(config.minWindow) || 5)));
  const idOf = element => Number(element.getAttribute('mesid'));
  const elementOf = id => root()?.querySelector(`:scope > .mes[mesid="${id}"]`);

  function height(element) {
    const css = getComputedStyle(element);
    const gap = Number.parseFloat(getComputedStyle(root()).rowGap) || 0;
    return Math.max(1, element.getBoundingClientRect().height +
      (Number.parseFloat(css.marginTop) || 0) + (Number.parseFloat(css.marginBottom) || 0) + gap);
  }
  function measure() {
    let changed = false;
    for (const element of rows()) {
      const value = height(element), id = idOf(element);
      if (!Number.isInteger(id)) continue;
      if (Math.abs(value - (state.heights.get(id) || 0)) > 0.5) {
        state.heights.set(id, value); changed = true;
      }
    }
    // Freeze the unknown-floor estimate for this chat. Recomputing a global
    // average after every iframe resize moves millions of pixels of spacers.
    if (!fallbackHeight && state.heights.size) {
      fallbackHeight = [...state.heights.values()].reduce((a, b) => a + b, 0) / state.heights.size;
    }
    return changed;
  }
  const estimatedHeight = id => state.heights.get(id) || fallbackHeight || config.defaultHeight || 4800;
  function sum(from, to) {
    let value = 0;
    for (let id = from; id <= to; id++) value += estimatedHeight(id);
    return value;
  }
  function layout() {
    const chat = root();
    if (!chat || !state.topSpacer || !state.bottomSpacer) return;
    if (chat.firstElementChild !== state.topSpacer) chat.prepend(state.topSpacer);
    const pinned = elementOf(state.pinnedId);
    if (pinned && pinned.previousElementSibling !== state.bottomSpacer) pinned.before(state.bottomSpacer);
    state.topSpacer.style.height = `${sum(0, state.start - 1)}px`;
    state.bottomSpacer.style.height = `${sum(state.end + 1, state.pinnedId - 1)}px`;
  }
  function scrollTo(value) {
    const chat = root();
    value = Math.max(0, Math.min(value, chat.scrollHeight - chat.clientHeight));
    // Even assigning the current value can cancel WebKit's touch momentum.
    if (Math.abs(chat.scrollTop - value) < 0.5) return;
    chat.scrollTop = value;
    correction = chat.scrollTop;
    lastScrollTop = chat.scrollTop;
  }
  function captureAnchor() {
    const chat = root();
    if (!chat) return null;
    const top = chat.getBoundingClientRect().top;
    const element = rows().find(el => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > top && rect.top < top + chat.clientHeight;
    });
    return { element, top: element?.getBoundingClientRect().top,
      atBottom: chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40,
      revision: state.scrollRevision };
  }
  function restoreAnchor(anchor) {
    if (!anchor || anchor.revision !== state.scrollRevision) return;
    // A touch scroll can land before its scroll event is dispatched.
    if (Math.abs(root().scrollTop - lastScrollTop) > 1) return;
    if (anchor.atBottom) scrollTo(root().scrollHeight);
    else if (anchor.element?.isConnected && anchor.top !== undefined) {
      scrollTo(root().scrollTop + anchor.element.getBoundingClientRect().top - anchor.top);
    }
  }
  function reserveHeight(element, id) {
    if (!hasFrontendCandidate(getChat()[id], element) || reservations.has(element)) return;
    const css = getComputedStyle(element);
    const outside = (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0) +
      (parseFloat(getComputedStyle(root()).rowGap) || 0);
    const padding = css.boxSizing === 'border-box' ? 0 :
      (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0) +
      (parseFloat(css.borderTopWidth) || 0) + (parseFloat(css.borderBottomWidth) || 0);
    reservations.set(element, { value: element.style.getPropertyValue('min-height'), priority: element.style.getPropertyPriority('min-height') });
    element.style.setProperty('min-height', `${Math.max(parseFloat(css.minHeight) || 0, estimatedHeight(id) - outside - padding)}px`);
    element.classList.add('dom-window-render-pending');
  }
  function releaseHeight(element) {
    const saved = reservations.get(element);
    if (!saved) return;
    if (saved.value) element.style.setProperty('min-height', saved.value, saved.priority);
    else element.style.removeProperty('min-height');
    reservations.delete(element);
  }
  function afterRefresh(item, anchor) {
    if (!state.enabled) return;
    if (changing || !running()) { settledDuringTransition.add(item.element); return; }
    anchor = layoutAnchor?.revision === state.scrollRevision ? layoutAnchor : anchor;
    releaseHeight(item.element);
    measure(); layout(); restoreAnchor(anchor);
    layoutAnchor = captureAnchor();
    onRangeChanged();
  }
  function observeRows() {
    if (!observer && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (!running() || changing || !state.mounted) return;
        if (!measure()) return;
        layout(); restoreAnchor(layoutAnchor); layoutAnchor = captureAnchor();
      });
    }
    rows().forEach(element => observer?.observe(element));
  }
  function createSpacer(side) {
    const element = document.createElement('div');
    element.className = `dom-window-spacer dom-window-${side}`;
    element.style.cssText = 'display:block;width:100%;flex:0 0 auto;pointer-events:none;';
    return element;
  }
  function holdRemovedSpace(element) {
    const css = getComputedStyle(element), slot = document.createElement('div');
    slot.className = 'dom-window-transition';
    slot.style.cssText = 'box-sizing:border-box;flex:0 0 auto;pointer-events:none;';
    slot.style.height = `${element.getBoundingClientRect().height}px`;
    slot.style.marginTop = css.marginTop; slot.style.marginBottom = css.marginBottom;
    element.before(slot); transitionSlots.add(slot);
  }
  function desiredRange(id, atBottom = false) {
    const length = getChat().length, capacity = size();
    const start = atBottom ? Math.max(0, length - capacity)
      : Math.max(0, Math.min(length - capacity, id - Math.floor(capacity / 2)));
    return { start, end: Math.min(length - 1, start + capacity - 1) };
  }
  function locateInSpacer(spacer, from, to, y) {
    let offset = Math.max(0, y - spacer.getBoundingClientRect().top);
    for (let id = from; id <= to; id++) {
      const value = estimatedHeight(id);
      if (offset < value || id === to) return { id, fraction: Math.min(0.95, offset / value), screenY: y };
      offset -= value;
    }
    return null;
  }
  function readPosition() {
    const chat = root(), viewport = chat.getBoundingClientRect();
    const y = viewport.top + chat.clientHeight / 2;
    const actual = rows().find(el => {
      const rect = el.getBoundingClientRect(); return rect.top <= y && rect.bottom >= y;
    });
    if (actual) return { id: idOf(actual), element: actual, top: actual.getBoundingClientRect().top };
    const topRect = state.topSpacer?.getBoundingClientRect();
    if (topRect && topRect.top <= y && topRect.bottom >= y && state.start > 0) {
      return locateInSpacer(state.topSpacer, 0, state.start - 1, y);
    }
    const bottomRect = state.bottomSpacer?.getBoundingClientRect();
    if (bottomRect && bottomRect.top <= y && bottomRect.bottom >= y && state.end < state.pinnedId - 1) {
      return locateInSpacer(state.bottomSpacer, state.end + 1, state.pinnedId - 1, y);
    }
    const visible = rows().find(el => {
      const rect = el.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    return visible ? { id: idOf(visible), element: visible, top: visible.getBoundingClientRect().top } : null;
  }
  function captureGeometry() {
    const chat = root(), viewport = chat.getBoundingClientRect();
    return [...chat.children].filter(el => el.matches('.mes, .dom-window-spacer')).map(el => {
      const r = el.getBoundingClientRect();
      const from = el === state.topSpacer ? 0 : el === state.bottomSpacer ? state.end + 1 : idOf(el);
      const to = el === state.topSpacer ? state.start - 1 : el === state.bottomSpacer ? state.pinnedId - 1 : idOf(el);
      return { from, to, top: r.top - viewport.top + chat.scrollTop, height: r.height };
    });
  }
  function positionDuringTransition() {
    const chat = root(), y = chat.scrollTop + chat.clientHeight / 2;
    const segment = transitionGeometry?.find(item => item.to >= item.from && y >= item.top && y <= item.top + item.height);
    if (!segment) return null;
    let offset = y - segment.top;
    for (let id = segment.from; id <= segment.to; id++) {
      const h = estimatedHeight(id);
      if (offset < h || id === segment.to) return { id, fraction: Math.min(0.95, offset / h),
        screenY: chat.getBoundingClientRect().top + chat.clientHeight / 2 };
      offset -= h;
    }
    return null;
  }
  async function changeRange(next) {
    const chat = root(), data = getChat(), epoch = generation;
    if (!chat || !data.length) return;
    const compatibility = lifecycle.inspect?.();
    if (compatibility && !compatibility.ok) throw new Error('Helper lifecycle is unavailable');
    transitionGeometry = captureGeometry();
    changing = true; state.applying = true;
    try {
      const removed = [];
      for (const element of rows()) {
        const id = idOf(element);
        const wanted = (id >= next.start && id <= next.end) || id === data.length - 1;
        if (wanted && (!references.has(element) || references.get(element) === data[id])) continue;
        state.heights.set(id, height(element));
        renderQueue.discard([id]); observer?.unobserve(element);
        // Removing rows before the asynchronous helper cleanup used to collapse
        // the document, move the reader, and clamp scrollTop at the new bottom.
        holdRemovedSpace(element); releaseHeight(element);
        if (window.jQuery) window.jQuery(element).remove(); else element.remove();
        removed.push(id);
      }
      // Release Vue runtimes BEFORE adding the new range. Missing-floor signals
      // cannot cause helper's range audit to batch-start the new iframes here.
      await lifecycle.release(removed);
      await beforeMount();
      if (epoch !== generation || !state.enabled || data !== getChat()) return;
      state.start = next.start; state.end = next.end; state.pinnedId = data.length - 1;
      const created = [];
      const wanted = new Set();
      for (let id = next.start; id <= next.end; id++) wanted.add(id);
      wanted.add(state.pinnedId);
      for (const id of wanted) {
        let element = elementOf(id);
        if (!element) {
          const following = rows().find(el => idOf(el) > id);
        const preceding = rows().filter(el => idOf(el) < id);
        const previous = preceding[preceding.length - 1];
          const result = mountMessage(id, following ? { beforeId: idOf(following) }
            : previous ? { afterId: idOf(previous) } : {});
          element = result?.el;
          if (!element) throw new Error(`Cannot mount floor ${id}`);
          reserveHeight(element, id);
          if (result.created) created.push(id);
        }
        references.set(element, data[id]);
      }
      chat.querySelector('#show_more_messages')?.remove();
      state.topSpacer ||= createSpacer('top'); state.bottomSpacer ||= createSpacer('bottom');
      if (!state.topSpacer.isConnected) chat.prepend(state.topSpacer);
      if (!state.bottomSpacer.isConnected) elementOf(state.pinnedId).before(state.bottomSpacer);
      chat.querySelectorAll('.last_mes').forEach(el => {
        if (idOf(el) !== state.pinnedId) el.classList.remove('last_mes');
      });
      elementOf(state.pinnedId).classList.add('last_mes');
      measure(); layout();
      transitionSlots.forEach(slot => slot.remove()); transitionSlots.clear();
      const anchor = next.anchor;
      if (!running()) { /* Leave background scroll position untouched. */ }
      else if (anchor?.revision === state.scrollRevision && anchor.atBottom) scrollTo(chat.scrollHeight);
      else if (anchor?.revision === state.scrollRevision && anchor.element?.isConnected) scrollTo(chat.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top);
      else if (anchor?.revision === state.scrollRevision && Number.isFinite(anchor.fraction)) {
        const element = elementOf(anchor.id);
        if (element) scrollTo(chat.scrollTop + element.getBoundingClientRect().top +
          element.getBoundingClientRect().height * anchor.fraction - anchor.screenY);
      }
      state.mounted = true; state.tailRef = data[state.pinnedId];
      observeRows(); renderQueue.prune();
      const needsRefresh = [...wanted].filter(id => !elementOf(id)?.querySelector('iframe[id^="TH-message--"]'));
      refreshMessages(needsRefresh, { owns: () => true });
      layoutAnchor = captureAnchor();
      onRangeChanged();
    } finally {
      transitionSlots.forEach(slot => slot.remove()); transitionSlots.clear();
      changing = false; state.applying = false; transitionGeometry = null;
      if (settledDuringTransition.size) {
        const anchor = captureAnchor();
        settledDuringTransition.forEach(releaseHeight); settledDuringTransition.clear();
        if (running() && state.mounted) {
          measure(); layout(); restoreAnchor(anchor); layoutAnchor = captureAnchor();
        }
      }
    }
  }
  async function drain() {
    if (changing) return;
    while (target && running()) {
      const next = target; target = null;
      try { await changeRange(next); } catch (error) { target = null; onFailure(error); break; }
    }
  }
  function requestRange(range, anchor) {
    if (!running() || renderQueue.snapshot().stalled) return;
    if (!changing && range.start === state.start && range.end === state.end && matches()) return;
    target = { ...range, anchor: { ...anchor, revision: state.scrollRevision } };
    void drain();
  }
  function matches() {
    if (!state.mounted || state.tailRef !== getChat()[getChat().length - 1] ||
      !state.topSpacer?.isConnected || !state.bottomSpacer?.isConnected) return false;
    const expected = state.end - state.start + 1 + (state.pinnedId > state.end ? 1 : 0);
    return rows().length === expected && rows().every(el => references.get(el) === getChat()[idOf(el)]) &&
      Array.from({ length: state.end - state.start + 1 }, (_, n) => state.start + n).every(id => elementOf(id));
  }
  function apply(force = false) {
    if (!running() || !getChat().length || (!force && matches())) return false;
    generation++; target = null;
    if (!originalScrollAnchor) {
      const element = root();
      originalScrollAnchor = { element, value: element.style.getPropertyValue('overflow-anchor'), priority: element.style.getPropertyPriority('overflow-anchor') };
      element.style.setProperty('overflow-anchor', 'none');
    }
    renderQueue.cancel(); observer?.disconnect();
    state.heights.clear(); fallbackHeight = 0; measure();
    requestRange(desiredRange(getChat().length - 1, true), { atBottom: true });
    console.debug('[DOMWindow] applied', { start: Math.max(0, getChat().length - size()), windowSize: size() });
    return true;
  }
  function syncTail() {
    if (!running() || !state.mounted || state.pinnedId >= getChat().length - 1) return false;
    const anchor = layoutAnchor || captureAnchor();
    requestRange(anchor?.atBottom ? desiredRange(getChat().length - 1, true)
      : { start: state.start, end: state.end }, anchor);
    return true;
  }
  function resize() {
    if (!running() || !state.mounted || !getChat().length) return false;
    const position = changing ? positionDuringTransition() : readPosition();
    const atBottom = root().scrollHeight - root().scrollTop - root().clientHeight < 40;
    requestRange(desiredRange(position?.id ?? state.end, atBottom), { ...(position || captureAnchor()), atBottom });
    return true;
  }
  function onScroll() {
    if (!running()) return;
    if (correction !== null && Math.abs(root().scrollTop - correction) < 1) { correction = null; return; }
    correction = null; state.scrollRevision++;
    const direction = Math.sign(root().scrollTop - lastScrollTop);
    lastScrollTop = root().scrollTop;
    renderQueue.defer();
    if (changing) {
      const position = positionDuringTransition();
      if (position) target = { ...desiredRange(position.id), anchor: { ...position, revision: state.scrollRevision } };
      return;
    }
    if (state.scrollRaf) return;
    state.scrollRaf = requestAnimationFrame(() => {
      state.scrollRaf = 0;
      if (!running() || !state.mounted) return;
      const position = readPosition();
      if (!position) return;
      layoutAnchor = captureAnchor();
      const atBottom = root().scrollHeight - root().scrollTop - root().clientHeight < 40;
      const guard = Math.min(2, Math.floor(size() / 4));
      const inside = position.id >= state.start && position.id <= state.end;
      const viewport = root().getBoundingClientRect();
      const visible = rows().filter(el => {
        const r = el.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom;
      }).map(idOf);
      const first = Math.min(...visible), last = Math.max(...visible);
      const nearEdge = (direction < 0 && state.start > 0 && first <= state.start + guard) ||
        (direction > 0 && state.end < state.pinnedId && last >= state.end - guard);
      if (!inside || nearEdge || (atBottom && state.end !== state.pinnedId)) {
        const leading = nearEdge ? (direction < 0 ? first : last) : position.id;
        let range = desiredRange(leading, atBottom);
        // Keep every already-visible floor while shifting the buffer, when the
        // configured capacity can cover them. This also avoids edge oscillation.
        if (inside && visible.length && last - first < size()) {
          range.start = Math.max(0, Math.min(getChat().length - size(),
            Math.max(last - size() + 1, Math.min(first, range.start))));
          range.end = range.start + size() - 1;
        }
        requestRange(range, { ...position, atBottom });
      }
    });
  }
  async function clear() {
    generation++; target = null; observer?.disconnect(); layoutAnchor = null;
    const ids = rows().map(idOf);
    renderQueue.cancel();
    rows().forEach(el => { if (window.jQuery) window.jQuery(el).remove(); else el.remove(); });
    for (const element of reservations.keys()) releaseHeight(element);
    settledDuringTransition.clear();
    transitionSlots.forEach(slot => slot.remove()); transitionSlots.clear();
    if (originalScrollAnchor) {
      const { element, value, priority } = originalScrollAnchor;
      if (value) element.style.setProperty('overflow-anchor', value, priority);
      else element.style.removeProperty('overflow-anchor');
      originalScrollAnchor = null;
    }
    state.topSpacer?.remove(); state.bottomSpacer?.remove();
    state.topSpacer = null; state.bottomSpacer = null; state.mounted = false;
    await lifecycle.release(ids);
  }
  function getMessageElement(id) {
    const existing = elementOf(id);
    if (existing) return existing;
    if (running() && !renderQueue.snapshot().stalled && Number.isInteger(id) && id >= 0 && id < getChat().length) {
      const compatibility = lifecycle.inspect?.();
      if (compatibility && !compatibility.ok) { onFailure(new Error('Helper lifecycle is unavailable')); return null; }
      // Preserve the synchronous lookup contract. The complete range follows
      // through the same bounded transition; only this requested node is added
      // before the asynchronous helper cleanup finishes.
      const following = rows().find(el => idOf(el) > id);
      const preceding = rows().filter(el => idOf(el) < id);
      const previous = preceding[preceding.length - 1];
      const result = mountMessage(id, following ? { beforeId: idOf(following) }
        : previous ? { afterId: idOf(previous) } : {});
      if (result?.el) references.set(result.el, getChat()[id]);
      requestRange(desiredRange(id), { id, fraction: 0, screenY: root().getBoundingClientRect().top });
      return result?.el || null;
    }
    return null;
  }
  function suspend() {
    target = null; observer?.disconnect(); layoutAnchor = null;
    for (const element of reservations.keys()) {
      releaseHeight(element); element.classList.remove('dom-window-render-pending');
    }
    settledDuringTransition.clear();
  }
  function resume() {
    if (!running() || changing) return;
    settledDuringTransition.forEach(releaseHeight); settledDuringTransition.clear();
    // A cancelled refresh can finish while generation holds the queue. Its
    // iframe is reusable, but its temporary height still needs releasing.
    for (const element of reservations.keys()) {
      if (!element.isConnected || element.querySelector('iframe[id^="TH-message--"]')) releaseHeight(element);
    }
    measure(); layout(); layoutAnchor = captureAnchor(); observeRows();
    if (target) void drain();
    else if (matches()) onScroll();
    refreshMessages(rows().filter(el => !el.querySelector('iframe[id^="TH-message--"]')).map(idOf), { owns: () => true });
  }
  return { apply, syncTail, resize, onScroll, getMessageElement, clear, matches, measure, layout,
    captureAnchor, afterRefresh, size, suspend, resume,
    integrity: () => { if (running() && !changing && !matches()) requestRange({ start: state.start, end: state.end }, captureAnchor()); } };
}
