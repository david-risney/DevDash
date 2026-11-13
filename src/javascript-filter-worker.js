import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { DevDashError } from './errors.js';

const bootstrap = `((itemJson, paramsJson, now) => {
  "use strict";
  const freeze = value => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const item = freeze(JSON.parse(itemJson));
  const params = freeze(JSON.parse(paramsJson));
  const fold = value => String(value).normalize("NFC").toLowerCase();
  const hasText = (value, text) => {
    const needle = fold(text);
    const search = value => {
      if (value == null) return false;
      if (typeof value === "object") return Object.values(value).some(search);
      return ["string", "number", "boolean"].includes(typeof value) && fold(value).includes(needle);
    };
    return search(value);
  };
  return (
`;

async function evaluate() {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  // Wall time includes unrelated CPU contention. Use thread CPU time when Node
  // provides it, or the conservative process-wide CPU counter on older Node 22.
  const cpuTime = () => {
    const usage = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage();
    return usage.user + usage.system;
  };
  const batchDeadline = cpuTime() + 5_000_000;
  let itemDeadline = batchDeadline;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted = cpuTime() >= Math.min(batchDeadline, itemDeadline);
    return interrupted;
  });
  const indices = [];
  try {
    for (let index = 0; index < workerData.itemJson.length; index++) {
      itemDeadline = cpuTime() + 100_000;
      if (cpuTime() >= batchDeadline) throw new DevDashError('FILTER_LIMIT', 'JavaScript filter exceeded its 5-second CPU budget.');
      // Each item gets fresh globals and intrinsics: predicates cannot carry state to the next item.
      const context = runtime.newContext();
      try {
        const source = `${bootstrap}${workerData.expression}\n);\n})(${JSON.stringify(workerData.itemJson[index])}, ${JSON.stringify(workerData.paramsJson)}, ${workerData.now})`;
        const result = context.evalCode(source, 'devdash-filter.js', { type: 'global', strict: true });
        interrupted ||= cpuTime() >= Math.min(batchDeadline, itemDeadline);
        if (result.error) {
          result.error.dispose();
          throw new DevDashError(interrupted ? 'FILTER_LIMIT' : 'FILTER_FAILED',
            interrupted
              ? `JavaScript filter exceeded its execution budget at item ${index + 1}.`
              : `JavaScript filter failed at item ${index + 1}; check required fields, JSON parsing, and memory/stack limits.`);
        }
        try {
          if (interrupted) throw new DevDashError('FILTER_LIMIT', `JavaScript filter exceeded its execution budget at item ${index + 1}.`);
          if (context.typeof(result.value) !== 'boolean' || runtime.hasPendingJob()) {
            throw new DevDashError('FILTER_RESULT', `JavaScript filter must return a synchronous Boolean at item ${index + 1}.`);
          }
          if (context.dump(result.value)) indices.push(index);
        } finally {
          result.value.dispose();
        }
      } finally {
        context.dispose();
      }
    }
    return indices;
  } finally {
    runtime.dispose();
  }
}

try {
  parentPort.postMessage({ indices: await evaluate() });
} catch (error) {
  parentPort.postMessage({ error: error instanceof DevDashError
    ? { code: error.code, message: error.message }
    : { code: 'FILTER_FAILED', message: 'JavaScript filter worker failed or exhausted its resources.' } });
}
