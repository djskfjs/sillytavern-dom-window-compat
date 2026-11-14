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

function copyFixture(value = '{"format":3,"message":"诊断信息"}') {
  const output = textareaFixture(value);
  const created = [];
  const documentObject = output.ownerDocument;
  documentObject.createElement = tag => {
    const field = { tagName: tag.toUpperCase(), ownerDocument: documentObject, value: '', attributes: {}, style: { cssText: '' },
      selectionStart: 0, selectionEnd: 0, removed: false,
      setAttribute(name, v) { this.attributes[name] = String(v); },
      hasAttribute(name) { return name in this.attributes; },
      focus() { documentObject.activeElement = this; },
      select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      remove() { this.removed = true; } };
    created.push(field);
    return field;
  };
  documentObject.body = { appendChild() {} };
  return { output, created, documentObject };
}

test('copies through a temporary field, never the readonly report', async () => {
  const { output, created, documentObject } = copyFixture();
  let copied = null, source = null;
  documentObject.execCommand = command => {
    assert.equal(command, 'copy');
    source = documentObject.activeElement;
    copied = source.value.slice(source.selectionStart, source.selectionEnd);
    return true;
  };
  assert.equal(await copyDiagnosticText(output, {}), true);
  assert.equal(source, created[0], 'the copy source is the temporary field');
  assert.equal(copied, output.value);
  assert.equal(created[0].removed, true, 'the temporary field is removed');
});

test('a refused field copy falls back to the Clipboard API', async () => {
  const { output, created, documentObject } = copyFixture();
  documentObject.execCommand = () => false;
  let written = null;
  const result = copyDiagnosticText(output, { clipboard: { writeText(text) { written = text; return Promise.resolve(); } } });
  assert.equal(await result, true);
  assert.equal(written, output.value);
  assert.equal(created[0].removed, true);
});

test('missing or empty reports are never copied', async () => {
  const { output, documentObject } = copyFixture('');
  let calls = 0;
  documentObject.execCommand = () => { calls++; return true; };
  assert.equal(await copyDiagnosticText(output, {}), false);
  assert.equal(await copyDiagnosticText(null, {}), false);
  assert.equal(calls, 0);
});

test('invalid temporary selections skip legacy copy and still try the Clipboard API synchronously', async t => {
  const failures = {
    'silent no-op': field => { field.select = () => {}; field.setSelectionRange = () => {}; },
    'lost focus': field => { field.focus = () => {}; },
    'partial selection': field => { field.setSelectionRange = () => { field.selectionEnd = 1; }; },
    'selection exception': field => { field.select = () => { throw new Error('Unavailable'); }; },
  };
  for (const [name, fail] of Object.entries(failures)) {
    await t.test(name, async () => {
      const { output, created, documentObject } = copyFixture();
      const createElement = documentObject.createElement;
      documentObject.createElement = tag => { const field = createElement(tag); fail(field); return field; };
      let calls = 0, written = null;
      documentObject.execCommand = () => { calls++; return true; };
      assert.equal(await copyDiagnosticText(output, {}), false);
      const result = copyDiagnosticText(output, { clipboard: {
        writeText(text) { written = text; return Promise.resolve(); },
      } });
      assert.equal(written, output.value, 'Clipboard API runs before the first await');
      assert.equal(calls, 0, 'an unverified selection is never copied');
      assert.equal(await result, true);
      assert(created.every(field => field.removed), 'temporary fields are removed on either path');
    });
  }
});

test('no available clipboard reports failure without throwing', async () => {
  const { output, documentObject } = copyFixture();
  documentObject.execCommand = () => false;
  assert.equal(await copyDiagnosticText(output, {}), false);
  assert.equal(await copyDiagnosticText(output, { clipboard: { writeText: () => Promise.reject(new Error('Denied')) } }), false);
  assert.equal(await copyDiagnosticText(output, { clipboard: { writeText: () => { throw new Error('Denied'); } } }), false);
  assert.equal(await copyDiagnosticText(output, { get clipboard() { throw new Error('Denied'); } }), false);
});

test('a document without a usable body still tries the Clipboard API', async () => {
  const { output, documentObject } = copyFixture();
  documentObject.body = { appendChild() { throw new Error('No body'); } };
  documentObject.execCommand = () => { throw new Error('Must not copy without a field'); };
  let written = null;
  const result = copyDiagnosticText(output, { clipboard: { writeText(text) { written = text; return Promise.resolve(); } } });
  assert.equal(await result, true);
  assert.equal(written, output.value);
});

test('a failed copy leaves the report selected for manual copying', async () => {
  const { output, documentObject } = copyFixture();
  documentObject.execCommand = () => false;
  assert.equal(await copyDiagnosticText(output, {}), false);
  assert.equal(output.hidden, false);
  assert.equal(documentObject.activeElement, output);
  assert.equal(output.selectionStart, 0);
  assert.equal(output.selectionEnd, output.value.length);
});
