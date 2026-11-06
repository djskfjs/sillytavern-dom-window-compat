import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderQueue } from '../render-queue.js';

// A foreground clock lets the tests cross long background intervals without
// timing margins or real sleeps. Promise completion remains asynchronous.
function clockFor(t) {
  let now = 0, serial = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay = 0) => {
    const id = ++serial;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(performance, 'now', () => now);
  async function microtasks() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
  return {
    get pending() { return timers.size; },
    async tick(ms) {
      const until = now + ms;
      await microtasks();
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until)
          .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id); now = timer.at; timer.callback();
        await microtasks();
      }
      now = until;
      await microtasks();
    },
  };
}

function fixture(options = {}) {
  const chat = Array.from({ length: 3 }, (_, id) => ({ mes: `<html>${id}</html>`, swipe_id: 0 }));
  const elements = chat.map((_, id) => {
    const classes = new Set(), hints = new Set();
    const text = { prepend: hint => hints.add(hint) };
    return {
      id, hints,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
      querySelector: selector => selector === '.mes_text' ? text : null,
      ownerDocument: { createElement: () => { const hint = { remove: () => hints.delete(hint) }; return hint; } },
      getBoundingClientRect: () => ({ top: id * 100, bottom: id * 100 + 100 }),
    };
  });
  const root = {
    isConnected: true,
    contains: element => elements.includes(element),
    querySelector: selector => elements[Number(selector.match(/mesid="(\d+)"/)?.[1])] || null,
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
  };
  const calls = [], releases = new Map(), stalls = [];
  let concurrent = 0, maxConcurrent = 0;
  const queue = createRenderQueue({
    getRoot: () => root, getChat: () => chat, markSelfRender: () => {},
    settleMs: 0, maxWaitMs: 0, stallMs: 100,
    refresh: id => {
      calls.push(id); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise(resolve => releases.set(id, () => { concurrent--; resolve(); }));
    },
    onStall: (id, error) => stalls.push({ id, name: error.name }),
    ...options,
  });
  return { queue, calls, stalls, elements, finish: id => releases.get(id)?.(), get maxConcurrent() { return maxConcurrent; } };
}

test('foreground timeout still stops pending work and never overlaps refresh calls', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0, 1], { force: true }); await clock.tick(0);
  const idle = assert.rejects(f.queue.whenIdle(), { name: 'TimeoutError' });
  await clock.tick(99); assert.equal(f.stalls.length, 0);
  await clock.tick(1); await idle;
  assert.deepEqual(f.stalls, [{ id: 0, name: 'TimeoutError' }]);
  assert.equal(f.queue.snapshot().stalled, true);
  assert.equal(f.queue.snapshot().pending, 0);
  f.queue.enqueue([1], { force: true }); await clock.tick(1000);
  assert.deepEqual(f.calls, [0]);
  f.finish(0); await clock.tick(0);
  assert.equal(f.queue.snapshot().running, 0);
  f.queue.dispose();
});

test('suspension before startup holds scheduled and newly queued work', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0], { force: true });
  f.queue.setSuspended(true);
  f.queue.enqueue([1], { force: true }); await clock.tick(10000);
  assert.equal(f.queue.snapshot().suspended, true);
  assert.equal(f.queue.snapshot().pending, 2);
  assert.deepEqual(f.calls, []);
  f.queue.setSuspended(false); await clock.tick(0);
  assert.deepEqual(f.calls, [0]);
  f.finish(0); await clock.tick(0);
  assert.deepEqual(f.calls, [0, 1]);
  f.finish(1); await clock.tick(0); await f.queue.whenIdle();
  assert.equal(f.maxConcurrent, 1);
  f.queue.dispose();
});

test('hidden time and repeated visibility signals do not consume or reset remaining timeout', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0], { force: true }); await clock.tick(0);
  await clock.tick(30); f.queue.setSuspended(true);
  await clock.tick(10000); f.queue.setSuspended(true); await clock.tick(10000);
  assert.equal(f.stalls.length, 0);
  f.queue.setSuspended(false); await clock.tick(20); f.queue.setSuspended(false);
  f.queue.setSuspended(true); await clock.tick(10000);
  assert.equal(f.stalls.length, 0);
  f.queue.setSuspended(false); await clock.tick(49);
  assert.equal(f.stalls.length, 0);
  await clock.tick(1); assert.equal(f.stalls.length, 1);
  assert.deepEqual(f.calls, [0]);
  f.finish(0); await clock.tick(0); f.queue.dispose();
});

test('an in-flight refresh may finish hidden but the next one waits for foreground', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0, 1], { force: true }); await clock.tick(0);
  await clock.tick(60); f.queue.setSuspended(true);
  f.finish(0); await clock.tick(10000);
  assert.deepEqual(f.calls, [0]);
  assert.equal(f.queue.snapshot().running, 0);
  assert.equal(f.queue.snapshot().pending, 1);
  assert.equal(f.stalls.length, 0);
  f.queue.setSuspended(false); await clock.tick(0);
  assert.deepEqual(f.calls, [0, 1]);
  await clock.tick(99); assert.equal(f.stalls.length, 0, 'new work receives a fresh budget');
  f.finish(1); await clock.tick(0); await f.queue.whenIdle();
  assert.equal(f.maxConcurrent, 1); f.queue.dispose();
});

test('cancel while hidden preserves the in-flight lock and foreground stall guard', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0, 1], { force: true }); await clock.tick(0);
  await clock.tick(25); f.queue.setSuspended(true); f.queue.cancel();
  f.queue.enqueue([2], { force: true }); await clock.tick(10000);
  assert.deepEqual(f.calls, [0]);
  assert.equal(f.queue.snapshot().pending, 1);
  f.queue.setSuspended(false); await clock.tick(74);
  assert.equal(f.stalls.length, 0); assert.deepEqual(f.calls, [0]);
  await clock.tick(1); assert.equal(f.stalls.length, 1);
  f.finish(0); await clock.tick(0);
  assert.deepEqual(f.calls, [0]);
  assert.equal(f.queue.snapshot().pending, 0);
  f.queue.dispose();
});

test('dispose releases idle waiters and prevents suspended tasks or timers restarting', async t => {
  const clock = clockFor(t), f = fixture();
  f.queue.enqueue([0, 1], { force: true }); await clock.tick(0);
  const idle = assert.rejects(f.queue.whenIdle(), { name: 'AbortError' });
  f.queue.setSuspended(true); f.queue.dispose(); await idle;
  f.queue.setSuspended(false); await clock.tick(10000);
  assert.equal(clock.pending, 0); assert.deepEqual(f.calls, [0]);
  assert.equal(f.stalls.length, 0);
  await assert.rejects(f.queue.whenIdle(), { name: 'AbortError' });
  f.finish(0); await clock.tick(0);
  assert.equal(clock.pending, 0); assert.equal(f.queue.snapshot().running, 0);
  assert(f.elements.every(element => element.hints.size === 0));
});

test('disabled stall guard remains disabled across suspension', async t => {
  const clock = clockFor(t), f = fixture({ stallMs: 0 });
  f.queue.enqueue([0], { force: true }); await clock.tick(10000);
  f.queue.setSuspended(true); await clock.tick(10000);
  f.queue.setSuspended(false); await clock.tick(10000);
  assert.equal(f.stalls.length, 0);
  f.finish(0); await clock.tick(0); await f.queue.whenIdle();
  f.queue.dispose(); assert.equal(clock.pending, 0);
});
