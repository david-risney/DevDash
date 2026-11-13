import { parse } from 'acorn';
import { Worker } from 'node:worker_threads';
import { DevDashError } from './errors.js';

const invalid = message => { throw new DevDashError('INVALID_FILTER', message); };
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_PARAMS_BYTES = 64 * 1024;

function jsonParams(params) {
  let count = 0;
  const visit = (value, depth) => {
    if (++count > 10_000 || depth > 32) invalid('JavaScript filter params exceed the size or nesting limit.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object'
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
          && Object.getPrototypeOf(value) !== null)) invalid('JavaScript filter params must contain only JSON values.');
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('JavaScript filter params must be a JSON object.');
  visit(params, 0);
  const json = JSON.stringify(params);
  if (Buffer.byteLength(json) > MAX_PARAMS_BYTES) invalid('JavaScript filter params must not exceed 64 KiB.');
  return json;
}

export function compileJavaScriptFilter(filter) {
  if (filter.language !== 'javascript' || Object.keys(filter).some(key => !['language', 'expression', 'params'].includes(key))) {
    invalid('Use a JavaScript filter with language, expression, and optional params only.');
  }
  const { expression } = filter;
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 32768) {
    invalid('JavaScript filter expression must contain 1 to 32768 characters.');
  }
  try {
    const program = parse(`"use strict"; (\n${expression}\n)`, { ecmaVersion: 2024 });
    if (program.body.length !== 2 || program.body[1].type !== 'ExpressionStatement') {
      invalid('JavaScript filter must be a single expression.');
    }
  } catch {
    invalid('JavaScript filter must be a valid, single JavaScript expression.');
  }
  return { language: 'javascript', expression, paramsJson: jsonParams(filter.params === undefined ? {} : filter.params) };
}

export async function filterJavaScriptItems(items, filter, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) invalid('JavaScript filter evaluation time must be a finite timestamp.');
  let bytes = 0;
  if (items.length > 20_000) throw new DevDashError('FILTER_LIMIT', 'JavaScript filters support at most 20000 items per query.');
  const itemJson = items.map((item, index) => {
    const json = JSON.stringify(item);
    const size = typeof json === 'string' ? Buffer.byteLength(json) : MAX_ITEM_BYTES + 1;
    bytes += size;
    if (size > MAX_ITEM_BYTES || bytes > MAX_INPUT_BYTES) {
      throw new DevDashError('FILTER_LIMIT', `JavaScript filter input exceeds 1 MiB per item or 16 MiB per query at item ${index + 1}.`);
    }
    return json;
  });
  if (!items.length) return items;
  const worker = new Worker(new URL('./javascript-filter-worker.js', import.meta.url), {
    workerData: { itemJson, expression: filter.expression, paramsJson: filter.paramsJson, now },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    // Do not inherit inspector, test-runner, or stdin-only flags in the isolated worker.
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    const indices = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DevDashError('FILTER_LIMIT', 'JavaScript filter exceeded its 10-second worker deadline.')), 10_000);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      worker.once('message', finish(message => {
        if (message.error) {
          reject(new DevDashError(message.error.code, message.error.message));
        } else {
          resolve(message.indices);
        }
      }));
      worker.once('error', finish(() => reject(new DevDashError('FILTER_FAILED', 'JavaScript filter worker failed or exhausted its resources.'))));
      worker.once('exit', finish(() => reject(new DevDashError('FILTER_FAILED', 'JavaScript filter worker exited without a result.'))));
    });
    return indices.map(index => items[index]);
  } finally {
    await worker.terminate();
  }
}
