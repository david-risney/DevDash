#!/usr/bin/env node
import { DevDash } from '../src/service.js';
import { serveNative } from '../src/native.js';
import { errorJson } from '../src/errors.js';

const service = new DevDash();
try {
  await service.diagnostics.run('native.host', {}, () => serveNative(process.stdin, process.stdout, { service }));
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorJson(error))}\n`);
  process.exitCode = 1;
}
