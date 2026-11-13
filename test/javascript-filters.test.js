import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, filterItems } from '../src/filters.js';

const js = (expression, params) => ({ language: 'javascript', expression, ...(params === undefined ? {} : { params }) });
const rows = [
  { title: 'Fix cache', state: 'open', draft: false, updatedAt: '2026-01-01T00:00:00Z',
    providerData: { votes: [{ reviewer: 'Alice', vote: 0 }, { reviewer: 'Bob', vote: 10 }], metadata: '{"ready":true}' } },
  { title: 'Other change', state: 'closed', draft: true, updatedAt: '2025-01-01T00:00:00Z',
    providerData: { votes: [{ reviewer: 'Alice', vote: 10 }, { reviewer: 'Bob', vote: 0 }], metadata: '{"ready":false}' } },
];
const matches = (expression, items = rows, params, options) => filterItems(items, compileFilter(js(expression, params)), options);

test('JavaScript filters use Boolean logic, nested arrays with same-element correlation, and explicit params', async () => {
  const expression = "item.state === 'open' && !item.draft && item.providerData.votes.some(v => v.reviewer === params.me && v.vote === 0)";
  assert.deepEqual(await matches(expression, rows, { me: 'Alice' }), [rows[0]]);
  assert.deepEqual(await matches('item.providerData.votes.some(v => v.reviewer === params.me && v.vote === 0)', rows, { me: 'Alice' }), [rows[0]]);
  assert.deepEqual(await matches('JSON.parse(item.providerData.metadata).ready'), [rows[0]]);
  assert.deepEqual(await matches("params.groups.includes(item.state)", rows, { groups: ['closed'] }), [rows[1]]);
});

test('hasText preserves recursive NFC-normalized case-insensitive value substring matching', async () => {
  const items = [{ title: 'caf\u00e9', nested: { propertyName: ['REGRESSION', 123, false, null] } }];
  for (const expression of [
    'hasText(item.title, params.text)', "hasText(item.nested, 'gress')",
    "hasText(item.nested, '23')", "hasText(item.nested, 'ALS')",
    "!hasText(item.nested, 'propertyName')", "!hasText(null, 'null')", "!hasText(item.missing, '')",
  ]) assert.deepEqual(await matches(expression, items, { text: 'CAFE\u0301' }), items, expression);
});

test('now is one fixed epoch-millisecond timestamp for all items and params are snapshotted at compile time', async () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const options = { now };
  assert.deepEqual(await matches('now - Date.parse(item.updatedAt) < params.day', rows, { day: 2 * 86400_000 }, options), [rows[0]]);
  assert.deepEqual(await matches('now === params.time', rows, { time: now }, options), rows);
  const params = { text: 'cache' };
  const compiled = compileFilter(js('hasText(item.title, params.text)', params));
  params.text = 'other';
  assert.deepEqual(await filterItems(rows, compiled), [rows[0]]);
});

test('sandbox has no host APIs, credentials, module loading, or host constructor escape', async () => {
  const expression = `[
    typeof process, typeof require, typeof fetch, typeof console, typeof Buffer,
    typeof setTimeout, typeof WebAssembly, typeof workerData, typeof parentPort,
    typeof global, typeof Deno, typeof Bun,
    ({}).constructor.constructor('return typeof process')()
  ].every(value => value === 'undefined')`;
  assert.deepEqual(await matches(expression), rows);
  for (const expression of ["process.env.SECRET", "require('node:fs')", "fetch('https://example.com')"]) {
    await assert.rejects(matches(expression), { code: 'FILTER_FAILED' });
  }
  await assert.rejects(matches("import('node:fs')"), { code: 'FILTER_RESULT' });
});

test('each item has independent globals and built-ins and JSON inputs are deeply read-only', async () => {
  const snapshot = structuredClone(rows);
  assert.deepEqual(await matches(`(() => {
    if (globalThis.seen || Array.prototype.injected) return false;
    globalThis.seen = true;
    Array.prototype.injected = true;
    return true;
  })()`), rows);
  assert.deepEqual(await matches('Object.isFrozen(item) && Object.isFrozen(item.providerData.votes) && Object.isFrozen(params.nested)', rows,
    { nested: { text: 'cache' } }), rows);
  for (const expression of ["(item.title = 'changed', true)", "(params.nested.text = 'changed', true)",
    '(item.providerData.votes.push({vote: 0}), true)']) {
    await assert.rejects(matches(expression, rows, { nested: { text: 'cache' } }), { code: 'FILTER_FAILED' });
  }
  assert.deepEqual(rows, snapshot);
});

test('results must be synchronous primitive Booleans rather than truthy values or promises', async () => {
  for (const expression of ['1', 'null', 'undefined', '"true"', '[]', '{}', 'new Boolean(true)',
    'Promise.resolve(true)', '(async () => true)()', '(Promise.resolve().then(() => true), true)']) {
    await assert.rejects(matches(expression), { code: 'FILTER_RESULT' }, expression);
  }
  assert.deepEqual(await matches('false'), []);
  assert.deepEqual(await matches('true'), rows);
  assert.deepEqual(await matches('true', []), []);
});

test('syntax is validated as a single expression without executing it or revealing source', () => {
  for (const expression of [
    '', ' ', 'item.', 'item.title ===', 'return true', 'await true', 'true; false',
    "true); throw new Error('SECRET_FILTER_VALUE'); (true",
    "'SECRET_FILTER_VALUE' +", 'x'.repeat(32769),
  ]) assert.throws(() => compileFilter(js(expression)), error =>
    error.code === 'INVALID_FILTER' && !error.message.includes('SECRET_FILTER_VALUE'));
  assert.doesNotThrow(() => compileFilter(js('(() => { throw new Error("not executed"); })()')));
  assert.doesNotThrow(() => compileFilter(js('true // trailing comment')));
  for (const filter of [{ language: 'js', expression: 'true' }, { ...js('true'), extra: true },
    js('true', null), js('true', []), js('true', { bad: undefined }), js('true', { bad: NaN }),
    js('true', { bad: new Date() }), js('true', { text: 'x'.repeat(65536) })]) {
    assert.throws(() => compileFilter(filter), { code: 'INVALID_FILTER' });
  }
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => compileFilter(js('true', cycle)), { code: 'INVALID_FILTER' });
  assert.throws(() => compileFilter(js('true', { values: Array(10_001).fill(0) })), { code: 'INVALID_FILTER' });
});

test('runtime failures, required-data mistakes, and malformed JSON are explicit redacted errors', async () => {
  for (const expression of [
    'item.missing.length > 0', 'JSON.parse("SECRET_INVALID_JSON").ready',
    '(() => { throw new Error("SECRET_FILTER_VALUE"); })()',
    '(() => { throw { get message() { for (;;) {} } }; })()',
  ]) {
    await assert.rejects(matches(expression), error =>
      error.code === 'FILTER_FAILED' && !error.message.includes('SECRET'));
  }
  // JavaScript has no automatic unknown-data semantics; callers must guard required fields.
  assert.deepEqual(await matches('!item.missing'), rows);
  assert.deepEqual(await matches('item.providerData.votes.every(v => v.vote === 0)', [{ providerData: { votes: [] } }]),
    [{ providerData: { votes: [] } }]);
});

test('infinite loops, recursion, and memory exhaustion are bounded and later evaluations still work', async () => {
  await assert.rejects(matches('(() => { for (;;) {} })()'), { code: 'FILTER_LIMIT' });
  for (const expression of [
    '(function recur() { return recur(); })()',
    '(() => { const chunks = []; for (;;) chunks.push("x".repeat(1024 * 1024)); })()',
  ]) await assert.rejects(matches(expression), error => ['FILTER_FAILED', 'FILTER_LIMIT'].includes(error.code));
  assert.deepEqual(await matches('true'), rows);
});

test('pathological regular expressions cannot bypass the worker wall-clock deadline', { timeout: 15_000 }, async () => {
  const started = performance.now();
  await assert.rejects(matches('/(a+)+b/.test("a".repeat(40))'), { code: 'FILTER_LIMIT' });
  assert.ok(performance.now() - started < 14_000);
});

test('serialized input bounds are measured in bytes and reject rather than silently dropping rows', async () => {
  await assert.rejects(matches('true', [{ title: '\u00e9'.repeat(524288) }]), { code: 'FILTER_LIMIT' });
  const row = { title: 'x'.repeat(900_000) };
  await assert.rejects(matches('true', Array(19).fill(row)), { code: 'FILTER_LIMIT' });
  await assert.rejects(matches('true', Array(20_001).fill({})), { code: 'FILTER_LIMIT' });
  await assert.rejects(matches('true', rows, {}, { now: NaN }), { code: 'INVALID_FILTER' });
});
