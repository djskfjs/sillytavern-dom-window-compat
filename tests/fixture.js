const params = new URLSearchParams(location.search);
if (params.has('noUUID')) Object.defineProperty(crypto, 'randomUUID', { value: undefined });
sessionStorage.setItem('fixture.boots', String(Number(sessionStorage.getItem('fixture.boots') || 0) + 1));
const delay = Number(params.get('delay') ?? 35);
const legacy = params.get('api') === 'legacy';
const count = Number(params.get('count') || 337);
const tailHeight = Number(params.get('tailHeight') || 110);
const releaseDelay = Number(params.get('releaseDelay') || 0);
const frameHeight = Number(params.get('frameHeight') || 110);
if (params.has('seed')) localStorage.setItem('STDOMWindow', '1');
if (params.has('preload')) localStorage.setItem('STDOMWindow.compat.preload', params.get('preload'));
let token = 1, initializing = true, active = 0;
const listeners = new Map(), runtimes = new Map();
const ctx = {
  chat: [], powerUserSettings: { chat_truncation: 20 },
  extensionSettings: JSON.parse(localStorage.getItem('fixture.settings') || 'null') ||
    { tavern_helper: { render: { enabled: true, depth: Number(params.get('helperDepth') || 0), allow_streaming: params.has('helperStreaming') } } },
  event_types: Object.fromEntries(['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
    'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED', 'SETTINGS_UPDATED'].map(name => [name, name])),
  eventSource: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    async emit(name, ...args) { for (const fn of [...(listeners.get(name) || [])]) await fn(...args); },
  },
  saveSettingsDebounced() { window.stats.settingSaves++; },
  saveChat() { throw Error('扩展不应保存或修改测试聊天'); },
};
// Helper has its own live reactive copy; changing extensionSettings alone does
// not change its renderer until the next page load.
const liveRenderSettings = structuredClone(ctx.extensionSettings.tavern_helper.render);
function makeMessages(size) {
  return Array.from({ length: size }, (_, id) => Object.freeze({
    mes: params.get('raw') === 'html' ? `<html><body>${token}:${id}</body></html>` : `<scene data-id="${id}">场景 ${token}:${id}</scene>`,
    name: '测试角色', is_user: false, swipe_id: 0, extra: Object.freeze({ token }),
  }));
}
function widget(id) {
  return `<!doctype html><html><head><style>body{margin:0;padding:12px;color:#18233d;background:#b6dddf;font:16px system-ui}.card{border:1px solid #577c80;padding:10px}</style></head><body><div class="card">前端已渲染 · ${token}:${id}</div></body></html>`;
}
function format(id, node) {
  node.replaceChildren();
  const p = document.createElement('p'); p.textContent = `测试楼层 ${token}:${id}`;
  const pre = document.createElement('pre'), code = document.createElement('code');
  code.className = 'language-html'; code.textContent = widget(id); pre.append(code); node.append(p, pre);
  if (params.has('sourceHeight')) pre.style.height = `${Number(params.get('sourceHeight'))}px`;
}
function destroyRuntime(id) {
  const runtime = runtimes.get(Number(id)); if (!runtime) return;
  runtime.frame.remove(); runtimes.delete(Number(id)); window.stats.destroyed++;
}
function clearRuntimes() { for (const id of [...runtimes.keys()]) destroyRuntime(id); }
function addRuntime(element) {
  const id = Number(element.getAttribute('mesid'));
  if (runtimes.has(id) || window.failRefreshId === id) return;
  const text = element.querySelector('.mes_text'); if (!text?.querySelector('pre code')) return;
  const frame = document.createElement('iframe');
  frame.id = `TH-message--${id}--0`;
  frame.title = `前端 ${token}:${id}`; frame.dataset.id = id; frame.dataset.token = token;
  frame.dataset.instance = String(++window.stats.started); frame.srcdoc = widget(id);
  frame.style.height = `${frameHeight}px`;
  if (id === ctx.chat.length - 1) frame.style.height = `${tailHeight}px`;
  text.append(frame); text.querySelector('pre').style.display = 'none';
  runtimes.set(id, { id, token, element, frame });
  window.stats.starts.push({ id, token, instance: window.stats.started });
  window.stats.runtimePeak = Math.max(window.stats.runtimePeak, runtimes.size);
}
function auditRuntimes(render = true) {
  window.stats.runtimeAudits++;
  const elements = [...document.querySelectorAll('#chat > .mes')];
  const first = elements.length ? Math.min(...elements.map(el => Number(el.getAttribute('mesid')))) : Infinity;
  const tail = ctx.chat.length - 1;
  // Faithful to helper's ID-range audit: no isConnected or DOM identity check.
  for (const [id, runtime] of runtimes) if (runtime.token !== token || id < first || id > tail) destroyRuntime(id);
  if (!render || !liveRenderSettings.enabled || liveRenderSettings.allow_streaming) return;
  const depth = liveRenderSettings.depth;
  for (const element of elements) {
    const id = Number(element.getAttribute('mesid')); if (!depth || id >= ctx.chat.length - depth) addRuntime(element);
  }
}
ctx.addOneMessage = (message, opts = {}) => {
  const id = opts.forceId ?? ctx.chat.indexOf(message);
  if (window.failMountId === id) { window.failMountId = null; throw Error('fixture mount failure'); }
  const el = document.createElement('div'); el.className = 'mes'; el.setAttribute('mesid', id);
  if (params.has('flex')) el.style.flexShrink = '0';
  const text = document.createElement('div'); text.className = 'mes_text'; el.append(text); format(id, text);
  const root = document.querySelector('#chat');
  const before = typeof opts.insertBefore === 'number' && (!legacy || opts.insertBefore) ? root.querySelector(`.mes[mesid="${opts.insertBefore}"]`) : null;
  const after = typeof opts.insertAfter === 'number' && (!legacy || opts.insertAfter) ? root.querySelector(`.mes[mesid="${opts.insertAfter}"]`) : null;
  if (before) before.before(el); else if (after) after.after(el); else root.append(el);
  root.querySelectorAll('.last_mes').forEach(e => e.classList.remove('last_mes')); root.querySelector('.mes:last-child')?.classList.add('last_mes');
  return legacy ? undefined : $(el);
};
ctx.printMessages = () => {
  clearRuntimes(); const root = document.querySelector('#chat'); root.replaceChildren();
  const size = ctx.powerUserSettings.chat_truncation || ctx.chat.length;
  if (ctx.chat.length > size) { const more = document.createElement('button'); more.id = 'show_more_messages'; more.textContent = '显示更多历史'; root.append(more); }
  for (let id = Math.max(0, ctx.chat.length - size); id < ctx.chat.length; id++) ctx.addOneMessage(ctx.chat[id], { forceId: id });
  root.scrollTop = root.scrollHeight;
};
window.stats = { calls: [], maxConcurrent: 0, settingSaves: 0, started: 0, starts: [], destroyed: 0,
  releaseEvents: [], recoveryEvents: [], runtimePeak: 0, runtimeAudits: 0 };
Object.defineProperties(window.stats, {
  runtimeIds: { enumerable: true, get: () => [...runtimes.keys()].sort((a, b) => a - b) },
  detachedRuntimeCount: { enumerable: true, get: () => [...runtimes.values()].filter(runtime => !runtime.element.isConnected).length },
});
window.SillyTavern = { getContext: () => ctx };
window.TavernHelper = {
  getTavernHelperVersion: () => params.get('helperVersion') || '4.12.0',
  builtin: {
    duringGenerating: () => !!window.fixtureGenerating,
    async saveSettings() {
      window.stats.settingSaves++;
      if (params.has('saveFailure')) return;
      localStorage.setItem('fixture.settings', JSON.stringify(ctx.extensionSettings));
      await ctx.eventSource.emit(ctx.event_types.SETTINGS_UPDATED);
    },
  },
  async refreshOneMessage(id, $mes) {
    const node = $mes?.[0] || document.querySelector(`#chat > .mes[mesid="${id}"]`), targetToken = token;
    const tracked = !initializing;
    if (tracked) { active++; window.stats.maxConcurrent = Math.max(window.stats.maxConcurrent, active); window.stats.calls.push({ id, token: targetToken }); }
    try {
      if (tracked) await new Promise(resolve => setTimeout(resolve, delay));
      if (window.failRefreshId === id) throw new TypeError('fixture refresh failure');
      if (!node?.isConnected || targetToken !== token) return;
      format(id, node.querySelector('.mes_text'));
      await ctx.eventSource.emit(ctx.event_types.CHARACTER_MESSAGE_RENDERED, id);
    } finally { if (tracked) active--; }
  },
};
for (const event of [ctx.event_types.CHARACTER_MESSAGE_RENDERED, ctx.event_types.USER_MESSAGE_RENDERED]) ctx.eventSource.on(event, id => { destroyRuntime(id); auditRuntimes(); });
ctx.eventSource.on('TH_REQUEST_RENDER_MESSAGE', async id => {
  if (releaseDelay) await new Promise(resolve => setTimeout(resolve, releaseDelay));
  window.stats.releaseEvents.push({ id, hadElement: !!document.querySelector(`#chat > .mes[mesid="${id}"]`) });
  destroyRuntime(id);
  auditRuntimes();
});
// Model helper's direct-child replacement recovery, independently from the
// explicit cleanup signal: replacing the same mesid starts its runtime again.
if (!params.has('noRecovery')) new MutationObserver(records => {
  const removed = new Set(), added = new Set();
  for (const record of records) for (const [nodes, ids] of [[record.removedNodes, removed], [record.addedNodes, added]]) {
    for (const node of nodes) if (node.nodeType === 1 && node.matches('.mes')) ids.add(Number(node.getAttribute('mesid')));
  }
  for (const id of added) if (removed.has(id)) {
    window.stats.recoveryEvents.push(id); void ctx.eventSource.emit('TH_REQUEST_RENDER_MESSAGE', id);
  }
}).observe(document.querySelector('#chat'), { childList: true });
const twoFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const contentTop = (element, root) => element.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
window.fixture = {
  ctx, auditRuntimes,
  resetRuntimePeak() { window.stats.runtimePeak = runtimes.size; },
  async switchChat(size) {
    token++; ctx.chat = makeMessages(size); initializing = true; ctx.printMessages(); auditRuntimes();
    initializing = false; await ctx.eventSource.emit(ctx.event_types.CHAT_CHANGED, String(token));
  },
  async appendMessage() {
    const id = ctx.chat.length;
    ctx.chat.push(Object.freeze({ mes: `<scene>${token}:${id}</scene>`, name: '测试角色', is_user: false, swipe_id: 0, extra: Object.freeze({ token }) }));
    ctx.addOneMessage(ctx.chat[id], { forceId: id }); await ctx.eventSource.emit(ctx.event_types.CHARACTER_MESSAGE_RENDERED, id); return id;
  },
  async jumpTopSpacer(fraction = 0.5) {
    const root = document.querySelector('#chat'), spacer = root.querySelector('.dom-window-top');
    root.scrollTop = contentTop(spacer, root) + spacer.offsetHeight * fraction; await twoFrames();
  },
  async jumpBottomSpacer(fraction = 0.5) {
    const root = document.querySelector('#chat'), spacer = root.querySelector('.dom-window-bottom');
    root.scrollTop = contentTop(spacer, root) + spacer.offsetHeight * fraction; await twoFrames();
  },
  async scrollToFraction(fraction) {
    const root = document.querySelector('#chat'); root.scrollTop = (root.scrollHeight - root.clientHeight) * fraction; await twoFrames();
  },
  async scrollUp(steps = 20) {
    const root = document.querySelector('#chat');
    for (let i = 0; i < steps; i++) {
      const top = root.querySelector('.dom-window-top'); if (!top) break;
      root.scrollTop = Math.max(0, contentTop(top, root) + top.offsetHeight - 70); await twoFrames();
    }
  },
  async scrollDown(steps = 20) {
    const root = document.querySelector('#chat');
    for (let i = 0; i < steps; i++) {
      const bottom = root.querySelector('.dom-window-bottom'); if (!bottom) break;
      root.scrollTop = Math.max(0, contentTop(bottom, root) - root.clientHeight + 70); await twoFrames();
    }
  },
};
ctx.chat = makeMessages(count); ctx.printMessages(); auditRuntimes();
if (params.has('nativeAnchor')) document.querySelector('#chat').style.overflowAnchor = 'auto';
if (params.has('flex')) Object.assign(document.querySelector('#chat').style, { display: 'flex', flexDirection: 'column' });
initializing = false; window.stats.calls = []; window.stats.maxConcurrent = 0;
window.fixture.entryModule = await import('/extension/index.js?variant=' + params.get('variant'));
window.fixtureReady = true;
