import { isSupportedHelperVersion, readHelperVersion, MIN_HELPER_VERSION } from './helper-lifecycle.js';
/** Persist only the two compatibility settings; Helper reads them on reload. */
export const HELPER_BACKUP_KEY = 'STDOMWindow_helper_backup';
const TARGET = Object.freeze({ depth: 0, allow_streaming: false });

export function createHelperSetup({ getHelper, getContext, owner, saveTimeoutMs = 8000 }) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(owner)) throw new Error('Invalid helper settings owner');
  let pending = null;
  const settings = () => getContext()?.extensionSettings;
  const backup = () => settings()?.[HELPER_BACKUP_KEY]?.[owner];
  function putBackup(all, value) {
    const existing = all[HELPER_BACKUP_KEY];
    if (existing != null && (typeof existing !== 'object' || Array.isArray(existing))) throw new Error('已有设置备份格式无法识别。');
    const records = { ...existing };
    if (value === undefined) delete records[owner]; else records[owner] = value;
    if (Object.keys(records).length) all[HELPER_BACKUP_KEY] = records; else delete all[HELPER_BACKUP_KEY];
  }
  function validBackup(value) {
    return value?.schema === 1 && isSupportedHelperVersion(value.helperVersion) && value.original && !Array.isArray(value.original) &&
      Object.keys(value.original).length > 0 &&
      Object.entries(value.original).every(([key, v]) => key === 'depth'
        ? Number.isFinite(v) && v >= 0 : key === 'allow_streaming' && typeof v === 'boolean');
  }
  function checkAccess() {
    const helper = getHelper(), ctx = getContext();
    if (!isSupportedHelperVersion(readHelperVersion(helper))) throw new Error(`需要酒馆助手 ${MIN_HELPER_VERSION} 或更高版本，未修改助手设置。`);
    if (helper.builtin?.duringGenerating?.()) throw new Error('请等本次回复生成结束，再开启或关闭；自动适配需要刷新页面。');
    const source = ctx?.eventSource;
    const event = (ctx?.event_types || ctx?.eventTypes)?.SETTINGS_UPDATED;
    if (typeof helper.builtin?.saveSettings !== 'function' || !event ||
      typeof source?.on !== 'function' || (typeof source.off !== 'function' && typeof source.removeListener !== 'function')) {
      throw new Error('酒馆的设置保存接口尚未就绪，请刷新后重试。');
    }
    if (!settings()?.tavern_helper?.render) throw new Error('助手设置尚未加载，请稍后重试。');
    return { helper, source, event };
  }
  async function saveConfirmed({ helper, source, event }, validate) {
    // saveSettings catches HTTP errors internally and may return early while
    // settings load. Only SETTINGS_UPDATED confirms a successful save.
    let timer, handler;
    try {
      await new Promise((resolve, reject) => {
        handler = () => { if (validate()) resolve(); };
        source.on(event, handler);
        timer = setTimeout(() => reject(new Error('助手设置未确认保存，已取消自动刷新；请检查连接后重试。')), saveTimeoutMs);
        Promise.resolve().then(() => helper.builtin.saveSettings()).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      if (typeof source.off === 'function') source.off(event, handler);
      else source.removeListener(event, handler);
    }
  }
  function serialize(action) {
    if (pending) return pending;
    pending = Promise.resolve().then(action).finally(() => { pending = null; });
    return pending;
  }
  return {
    hasBackup: () => validBackup(backup()),
    checkAccess,
    configure() { return serialize(async () => {
      const access = checkAccess(), all = settings(), render = all.tavern_helper.render;
      const oldBackup = backup();
      if (oldBackup != null && !validBackup(oldBackup)) throw new Error('已有的助手设置备份无法识别，未覆盖原值。');
      const original = { ...(oldBackup?.original || {}) }, changed = {};
      for (const [key, value] of Object.entries(TARGET)) {
        if (render[key] === value) continue;
        if (key === 'depth' ? !Number.isFinite(render[key]) || render[key] < 0 : typeof render[key] !== 'boolean') {
          throw new Error('助手设置格式无法识别，未修改原值。');
        }
        // If the user changed an adapted value later, that becomes their new
        // preference. Do not restore an older preference over it.
        original[key] = render[key]; changed[key] = render[key];
      }
      if (!Object.keys(changed).length) return false;
      const nextBackup = { schema: 1, helperVersion: readHelperVersion(access.helper) || MIN_HELPER_VERSION, original };
      try {
        putBackup(all, nextBackup);
        for (const key of Object.keys(changed)) render[key] = TARGET[key];
        await saveConfirmed(access, () => backup() === nextBackup &&
          Object.keys(changed).every(key => settings()?.tavern_helper?.render?.[key] === TARGET[key]));
      } catch (error) {
        const current = all.tavern_helper.render;
        for (const [key, value] of Object.entries(changed)) if (current?.[key] === TARGET[key]) current[key] = value;
        if (all[HELPER_BACKUP_KEY]?.[owner] === nextBackup) putBackup(all, oldBackup);
        throw error;
      }
      return true;
    }); },
    restore() { return serialize(async () => {
      const saved = backup();
      if (!saved) return false;
      if (!validBackup(saved)) throw new Error('原助手设置备份无法识别，未修改现有设置。');
      const access = checkAccess(), all = settings(), render = all.tavern_helper.render, changed = {};
      try {
        for (const [key, value] of Object.entries(saved.original)) {
          // Preserve any preference the user changed while the window was active.
          if (render[key] !== TARGET[key]) continue;
          changed[key] = render[key]; render[key] = value;
        }
        putBackup(all, undefined);
        await saveConfirmed(access, () => !backup() &&
          Object.keys(changed).every(key => settings()?.tavern_helper?.render?.[key] === saved.original[key]));
      } catch (error) {
        const current = all.tavern_helper.render;
        for (const [key, value] of Object.entries(changed)) if (current?.[key] === saved.original[key]) current[key] = value;
        if (!all[HELPER_BACKUP_KEY]?.[owner]) putBackup(all, saved);
        throw error;
      }
      return Object.keys(changed).length > 0;
    }); },
  };
}
