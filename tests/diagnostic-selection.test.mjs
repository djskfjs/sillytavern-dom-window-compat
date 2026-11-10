import assert from 'node:assert/strict';
import test from 'node:test';
import { copyDiagnosticText, selectDiagnosticText } from '../runtime-support.js';

function textareaFixture(value = '{"format":3,"message":"诊断信息"}') {
  const ownerDocument = { activeElement: null };
  const output = {
    value, hidden: true, ownerDocument, selectionStart: 0, selectionEnd: 0,
    focus() { ownerDocument.activeElement = this; },
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  return output;
}

test('full report selection succeeds only with the report focused', () => {
  const output = textareaFixture();
  assert.equal(selectDiagnosticText(output), true);
  assert.equal(output.hidden, false);
  assert.equal(output.ownerDocument.activeElement, output);
  assert.equal(output.selectionStart, 0);
  assert.equal(output.selectionEnd, output.value.length);
});

test('selection methods silently doing nothing do not report success', () => {
  const output = textareaFixture();
  output.select = () => {};
  output.setSelectionRange = () => {};
  assert.equal(selectDiagnosticText(output), false);
});

test('a partial selection does not report the full report selected', () => {
  const output = textareaFixture();
  output.setSelectionRange = function () { this.selectionStart = 1; };
  assert.equal(selectDiagnosticText(output), false);
  output.setSelectionRange = function () { this.selectionEnd = this.value.length - 1; };
  assert.equal(selectDiagnosticText(output), false);
});

test('silently rejected focus does not validate an otherwise complete selection', () => {
  const output = textareaFixture();
  output.focus = () => {};
  assert.equal(selectDiagnosticText(output), false);
  assert.equal(output.selectionEnd, output.value.length);
});

test('focus stolen while selecting does not validate the report selection', () => {
  const output = textareaFixture();
  const setSelectionRange = output.setSelectionRange;
  output.setSelectionRange = function (start, end) {
    setSelectionRange.call(this, start, end);
    this.ownerDocument.activeElement = { id: 'another-input' };
  };
  assert.equal(selectDiagnosticText(output), false);
});

test('missing or empty reports do not report a successful selection', () => {
  assert.equal(selectDiagnosticText(null), false);
  assert.equal(selectDiagnosticText(textareaFixture('')), false);
});

test('selection exceptions return failure', async t => {
  for (const method of ['focus', 'select', 'setSelectionRange']) {
    await t.test(method, () => {
      const output = textareaFixture();
      output[method] = () => { throw new Error('Selection unavailable'); };
      assert.equal(selectDiagnosticText(output), false);
    });
  }
});

test('legacy copy runs synchronously after a verified complete selection', async () => {
  const output = textareaFixture();
  let copied = null;
  output.ownerDocument.execCommand = command => {
    assert.equal(command, 'copy');
    copied = output.value.slice(output.selectionStart, output.selectionEnd);
    return true;
  };
  const result = copyDiagnosticText(output, {});
  assert.equal(copied, output.value);
  assert.equal(await result, true);
});

test('invalid selections never invoke legacy copy on an unrelated selection', async t => {
  const failures = {
    'silent no-op': output => { output.select = () => {}; output.setSelectionRange = () => {}; },
    'lost focus': output => { output.focus = () => {}; },
    'empty report': output => { output.value = ''; },
    'selection exception': output => { output.select = () => { throw new Error('Unavailable'); }; },
  };
  for (const [name, fail] of Object.entries(failures)) {
    await t.test(name, async () => {
      const output = textareaFixture();
      fail(output);
      let legacyCalls = 0;
      output.ownerDocument.execCommand = () => { legacyCalls++; return true; };
      assert.equal(await copyDiagnosticText(output, {}), false);
      assert.equal(legacyCalls, 0);
    });
  }
});

test('Clipboard API remains available synchronously when selection silently fails', async () => {
  const output = textareaFixture();
  output.select = () => {};
  output.setSelectionRange = () => {};
  let legacyCalls = 0;
  output.ownerDocument.execCommand = () => { legacyCalls++; return true; };
  let written = null;
  const result = copyDiagnosticText(output, { clipboard: {
    writeText(text) { written = text; return Promise.resolve(); },
  } });
  assert.equal(written, output.value);
  assert.equal(legacyCalls, 0);
  assert.equal(await result, true);
});
