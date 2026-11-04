/**
 * Compatibility signal audited against JS-Slash-Runner 4.12.0 (40e4b72).
 * message_recovery.ts defines TH_REQUEST_RENDER_MESSAGE; message.ts removes
 * the requested runtime when its message DOM is absent. Vue then unmounts
 * Iframe.vue and releases its resize listener and Blob URL.
 * This is an internal signal, not a documented unload API. Refuse unknown
 * versions rather than pretending that removing a DOM node releases Vue.
 */
export function createHelperLifecycle({ getRoot, getHelper, getContext }) {
  function inspect() {
    const helper = getHelper();
    if (!helper) return { ok: true, version: null, reason: '纯文字窗口' };
    let version;
    try { version = helper.getTavernHelperVersion?.(); } catch {}
    if (version !== '4.12.0') return { ok: false, version, reason: '当前仅验证酒馆助手 4.12.0 的前端回收机制，请保持窗口关闭。' };
    const ctx = getContext();
    const render = ctx?.extensionSettings?.tavern_helper?.render;
    if (typeof ctx?.eventSource?.emit !== 'function') return { ok: false, version, reason: '未找到前端回收所需的酒馆事件接口。' };
    if (!render) return { ok: false, version, reason: '无法读取酒馆助手渲染设置，请保持窗口关闭。' };
    if (render.depth !== 0) return { ok: false, version, reason: '酒馆助手的渲染深度需为 0；阅读窗口层数由本扩展控制。' };
    if (render.allow_streaming !== false) return { ok: false, version, reason: '请先关闭酒馆助手的流式渲染。' };
    return { ok: true, version, reason: '前端回收条件已验证' };
  }
  async function release(ids = []) {
    const check = inspect();
    if (!check.ok) throw new Error(check.reason);
    if (!check.version) return;
    for (const id of new Set(ids)) {
      if (!Number.isInteger(id) || id < 0) continue;
      const current = inspect();
      if (!current.ok) throw new Error(current.reason);
      const root = getRoot();
      if (!root?.isConnected) return;
      // Never signal a currently mounted floor, including after a chat switch.
      if (root.querySelector(`:scope > .mes[mesid="${id}"]`)) continue;
      await getContext().eventSource.emit('TH_REQUEST_RENDER_MESSAGE', id);
      await Promise.resolve();
    }
  }
  return { inspect, release };
}
