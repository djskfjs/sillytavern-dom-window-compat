import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperSetup, HELPER_BACKUP_KEY } from '../helper-setup.js';
import { createHelperLifecycle } from '../helper-lifecycle.js';

function fixture(initial = { depth: 8, allow_streaming: true, enabled: true, use_blob_url: true }) {
  const callbacks = new Set(); let saves = 0, confirm = true, version = '4.12.0', generating = false;
  const ctx = { extensionSettings: { tavern_helper: { render: structuredClone(initial), audio: { volume: 17 } }, unrelated: 42 },
    event_types: { SETTINGS_UPDATED: 'settings_updated' },
    eventSource: { on(_event, fn) { callbacks.add(fn); }, off(_event, fn) { callbacks.delete(fn); },
      async emit() { for (const fn of callbacks) await fn(); } } };
  const helper = { getTavernHelperVersion: () => version, refreshOneMessage: async () => {}, builtin: {
    duringGenerating: () => generating,
    async saveSettings() { saves++; if (confirm) await ctx.eventSource.emit(); },
  } };
  const create = (owner = 'test-device') => createHelperSetup({ getHelper: () => helper, getContext: () => ctx, owner, saveTimeoutMs: 35 });
  return { ctx, helper, create, setup: create(), callbacks, get saves() { return saves; },
    set confirm(value) { confirm = value; }, set version(value) { version = value; }, set generating(value) { generating = value; } };
}
test('adapts both settings in one confirmed save, preserving unrelated preferences', async () => {
  const f = fixture(); assert.equal(await f.setup.configure(), true);
  assert.deepEqual(f.ctx.extensionSettings.tavern_helper.render, { depth: 0, allow_streaming: false, enabled: true, use_blob_url: true });
  assert.deepEqual(f.ctx.extensionSettings[HELPER_BACKUP_KEY]['test-device'].original, { depth: 8, allow_streaming: true });
  assert.equal(f.ctx.extensionSettings.unrelated, 42); assert.equal(f.ctx.extensionSettings.tavern_helper.audio.volume, 17);
  assert.equal(f.saves, 1); assert.equal(f.callbacks.size, 0);
});
test('restore survives a new controller after reload', async () => {
  const f = fixture(), before = structuredClone(f.ctx.extensionSettings);
  await f.setup.configure(); const reloaded = f.create();
  assert.equal(reloaded.hasBackup(), true); assert.equal(await reloaded.restore(), true);
  assert.deepEqual(f.ctx.extensionSettings, before); assert.equal(f.saves, 2);
});
test('no successful settings event means rollback, even when the save promise resolves', async () => {
  const f = fixture(), before = structuredClone(f.ctx.extensionSettings); f.confirm = false;
  await assert.rejects(f.setup.configure(), /未确认保存/);
  assert.deepEqual(f.ctx.extensionSettings, before); assert.equal(f.callbacks.size, 0);
});
test('failed restoration retains the backup and adapted values for retry', async () => {
  const f = fixture(); await f.setup.configure(); const before = structuredClone(f.ctx.extensionSettings); f.confirm = false;
  await assert.rejects(f.setup.restore(), /未确认保存/); assert.deepEqual(f.ctx.extensionSettings, before);
  f.confirm = true; await f.setup.restore(); assert.equal(f.ctx.extensionSettings.tavern_helper.render.depth, 8);
});
test('restoration preserves a preference manually changed after adaptation', async () => {
  const f = fixture(); await f.setup.configure(); f.ctx.extensionSettings.tavern_helper.render.depth = 3;
  await f.setup.restore(); assert.equal(f.ctx.extensionSettings.tavern_helper.render.depth, 3);
  assert.equal(f.ctx.extensionSettings.tavern_helper.render.allow_streaming, true);
});
test('repeated activation is idempotent and keeps the original restore point', async () => {
  const f = fixture(); const first = f.setup.configure(), second = f.setup.configure();
  assert.equal(first, second); await first; assert.equal(await f.setup.configure(), false);
  assert.equal(f.saves, 1); assert.equal(f.ctx.extensionSettings[HELPER_BACKUP_KEY]['test-device'].original.depth, 8);
});
test('a helper below 4.11.0 does not change settings or create a backup', async () => {
  const f = fixture(), before = structuredClone(f.ctx.extensionSettings); f.version = '4.10.9';
  await assert.rejects(f.setup.configure(), /4\.11\.0 或更高版本/); assert.deepEqual(f.ctx.extensionSettings, before); assert.equal(f.saves, 0);
});
test('ongoing generation is not interrupted by automatic reload setup', async () => {
  const f = fixture(), before = structuredClone(f.ctx.extensionSettings); f.generating = true;
  await assert.rejects(f.setup.configure(), /生成结束/); assert.deepEqual(f.ctx.extensionSettings, before);
});
test('malformed existing backup is never overwritten', async () => {
  const f = fixture(); f.ctx.extensionSettings[HELPER_BACKUP_KEY] = { 'test-device': { schema: 99, original: { depth: 40 } } };
  const before = structuredClone(f.ctx.extensionSettings);
  await assert.rejects(f.setup.configure(), /备份无法识别/); assert.deepEqual(f.ctx.extensionSettings, before);
});
test('every helper version from 4.11.0 up reports the same adjustments, older ones identify themselves', () => {
  const f = fixture(); const lifecycle = createHelperLifecycle({ getHelper: () => f.helper, getContext: () => f.ctx });
  for (const version of ['4.11.0', '4.11.9', '4.12.0', '4.12.1', '4.13.0']) {
    f.version = version;
    const check = lifecycle.inspect();
    assert.deepEqual(check.adjustments, ['渲染深度设为 0', '关闭流式渲染'], version);
    assert.equal(check.canConfigure, true, version);
  }
  for (const version of ['4.10.9', '4.9.0', '3.12.0', 'abc', '']) {
    f.version = version;
    assert.equal(lifecycle.inspect().ok, false, `rejects ${version}`);
    assert.equal(lifecycle.inspect().canConfigure, undefined, version);
    assert.match(lifecycle.inspect().reason, version ? new RegExp(version.replace(/\./g, '\\.')) : /版本未读到/);
  }
});
test('another browser cannot restore or clear this browser restore point', async () => {
  const f = fixture(); await f.setup.configure(); const other = f.create('other-browser');
  assert.equal(other.hasBackup(), false); assert.equal(await other.restore(), false);
  assert.equal(await other.configure(), false); assert.equal(f.setup.hasBackup(), true);
  await f.setup.restore(); assert.equal(f.ctx.extensionSettings.tavern_helper.render.depth, 8);
});

test('an enabled helper with settings but no loaded API waits before touching message runtimes', async () => {
  const f = fixture({ depth: 0, allow_streaming: false, enabled: true });
  let available = false, rootReads = 0;
  const lifecycle = createHelperLifecycle({ getHelper: () => available ? f.helper : undefined,
    getContext: () => f.ctx, getRoot: () => { rootReads++; return null; } });
  assert.deepEqual(lifecycle.inspect(), { ok: false, pending: true, version: null, reason: '正在等待酒馆助手启动…' });
  await assert.rejects(lifecycle.release([1]), /等待酒馆助手启动/);
  assert.equal(rootReads, 0);
  assert.equal(f.saves, 0);
  available = true;
  assert.equal(lifecycle.inspect().ok, true);
  assert.equal(lifecycle.inspect().pending, undefined);
});

test('a missing helper is text-only only when render settings are absent or explicitly disabled', () => {
  let ctx = { extensionSettings: {} };
  const lifecycle = createHelperLifecycle({ getHelper: () => undefined, getContext: () => ctx });
  assert.deepEqual(lifecycle.inspect(), { ok: true, version: null, reason: '纯文字窗口' });
  ctx = { extensionSettings: { tavern_helper: { render: { enabled: false } } } };
  assert.equal(lifecycle.inspect().ok, true);
  ctx.extensionSettings.tavern_helper.render = {};
  assert.equal(lifecycle.inspect().pending, true);
});

test('a helper below 4.11.0 never sends the private runtime release signal', async () => {
  const f = fixture({ depth: 0, allow_streaming: false, enabled: true });
  let emissions = 0;
  f.ctx.eventSource.emit = async () => { emissions++; };
  f.version = '4.10.0';
  const lifecycle = createHelperLifecycle({ getHelper: () => f.helper, getContext: () => f.ctx,
    getRoot: () => ({ isConnected: true, querySelector: () => null }) });
  assert.equal(lifecycle.inspect().ok, false);
  assert.equal(lifecycle.inspect().canConfigure, undefined);
  assert.match(lifecycle.inspect().reason, /4\.10\.0/);
  await assert.rejects(lifecycle.release([0, 1]), /4\.10\.0/);
  assert.equal(emissions, 0);
  assert.equal(f.saves, 0);
});

test('4.11.0 and later release floors through the same audited signal', async () => {
  for (const version of ['4.11.0', '4.12.1', '4.13.0']) {
    const f = fixture({ depth: 0, allow_streaming: false, enabled: true });
    const emitted = [];
    f.ctx.eventSource.emit = async (event, id) => { emitted.push([event, id]); };
    f.version = version;
    const lifecycle = createHelperLifecycle({ getHelper: () => f.helper, getContext: () => f.ctx,
      getRoot: () => ({ isConnected: true, querySelector: () => null }) });
    assert.equal(lifecycle.inspect().ok, true, version);
    await lifecycle.release([0, 1]);
    assert.deepEqual(emitted, [['TH_REQUEST_RENDER_MESSAGE', 0], ['TH_REQUEST_RENDER_MESSAGE', 1]], version);
  }
});

test('a known helper without its refresh API cannot begin automatic adaptation or release', async () => {
  const f = fixture();
  delete f.helper.refreshOneMessage;
  const before = structuredClone(f.ctx.extensionSettings);
  const lifecycle = createHelperLifecycle({ getHelper: () => f.helper, getContext: () => f.ctx });
  const check = lifecycle.inspect();
  assert.equal(check.ok, false);
  assert.equal(check.canConfigure, undefined);
  assert.match(check.reason, /前端恢复接口/);
  await assert.rejects(lifecycle.release([1]), /前端恢复接口/);
  assert.deepEqual(f.ctx.extensionSettings, before);
  assert.equal(f.saves, 0);
});

test('missing release event support prevents automatic adaptation', () => {
  const f = fixture();
  delete f.ctx.eventSource.emit;
  const check = createHelperLifecycle({ getHelper: () => f.helper, getContext: () => f.ctx }).inspect();
  assert.equal(check.ok, false);
  assert.equal(check.canConfigure, undefined);
  assert.match(check.reason, /事件接口/);
  assert.equal(f.saves, 0);
});
