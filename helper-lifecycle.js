/**
 * Compatibility signal audited against JS-Slash-Runner 4.12.0 (40e4b72).
 * message_recovery.ts defines TH_REQUEST_RENDER_MESSAGE; message.ts removes
 * the requested runtime when its message DOM is absent. Vue then unmounts
 * Iframe.vue and releases its resize listener and Blob URL.
 * This is an internal signal, not a documented unload API. Refuse unknown
 * versions rather than pretending that removing a DOM node releases Vue.
 */
export function createHelperLifecycle({ getRoot, getHelper, getContext, beforeRelease = () => {} }) {
  function inspect() {
    const ctx = getContext();
    const render = ctx?.extensionSettings?.tavern_helper?.render;
    const helper = getHelper();
    if (!helper) {
      // Settings can arrive before Helper has finished loading its public API.
      // Treating that gap as text-only would remove message DOM without
      // releasing the Helper runtimes which are about to attach to it.
      if (render && render.enabled !== false) {
        return { ok: false, pending: true, version: null, reason: '正在等待酒馆助手启动…' };
      }
      return { ok: true, version: null, reason: '纯文字窗口' };
    }
    let version;
    try { version = helper.getTavernHelperVersion?.(); } catch {}
    if (version !== '4.12.0') return { ok: false, version,
      reason: `检测到酒馆助手 ${typeof version === 'string' && version ? version : '版本未读到'}；当前已适配 4.12.0。未修改助手设置。` };
    if (typeof ctx?.eventSource?.emit !== 'function') return { ok: false, version, reason: '未找到前端回收所需的酒馆事件接口。' };
    if (typeof helper.refreshOneMessage !== 'function') return { ok: false, version,
      reason: '未找到酒馆助手的前端恢复接口，已保留原聊天显示。' };
    if (!render) return { ok: false, version, reason: '无法读取酒馆助手渲染设置，请保持窗口关闭。' };
    const adjustments = [];
    if (render.depth !== 0) adjustments.push('渲染深度设为 0');
    if (render.allow_streaming !== false) adjustments.push('关闭流式渲染');
    if (adjustments.length) return { ok: false, canConfigure: true, version, adjustments,
      reason: `开启时将自动配置：${adjustments.join('、')}；关闭后还原。` };
    return { ok: true, version, reason: '前端回收条件已验证' };
  }
  async function release(ids = []) {
    const check = inspect();
    if (!check.ok) throw new Error(check.reason);
    if (!check.version) return;
    for (const id of new Set(ids)) {
      if (!Number.isInteger(id) || id < 0) continue;
      await beforeRelease();
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
