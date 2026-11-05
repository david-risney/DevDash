#!/usr/bin/env node
import { DevDash } from '../src/service.js';
import { executeCommand, parseCommand, validateWatch } from '../src/commands.js';
import { DevDashError, errorJson } from '../src/errors.js';
import { nativeManifest, serveNative } from '../src/native.js';
import { watchProfiles } from '../src/watch.js';
import { diagnosticCode, diagnosticPathsOptions } from '../src/diagnostics.js';
import { formatResults } from '../src/format.js';
import { loadPresentation } from '../src/presentation.js';

let service;
let presentation;

function print(value, pretty = false, stream = process.stdout) {
  return new Promise((resolve, reject) => stream.write(
    `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, error => error ? reject(error) : resolve()));
}

async function present(output, options) {
  const format = options.format ?? 'json';
  if (format === 'json') {
    await print(output, options.pretty);
    return;
  }
  const result = formatResults(output, { ansi: 'ansi', ascii: 'text', md: 'markdown' }[format],
    { columns: process.stdout.columns ?? 100, ...presentation });
  await new Promise((resolve, reject) => process.stdout.write(result.output, error => error ? reject(error) : resolve()));
}

async function watch(args) {
  const { positionals, interval, values } = validateWatch(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await service.diagnostics.run('watch', { command: 'watch', profile: positionals[1], queryName: values.query }, () =>
      watchProfiles(service, { profile: positionals[1], query: values.query, interval, signal: controller.signal },
        output => present(output.profile === null && values.format && values.format !== 'json'
          ? { ...output, profile: undefined } : output, { ...values, pretty: false })));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  const args = process.argv.slice(2);
  service = new DevDash(diagnosticPathsOptions(args));
  const parsed = parseCommand(args);
  service = new DevDash(parsed.values);
  if (parsed.values.format && parsed.values.format !== 'json' && !parsed.values.help && !parsed.values.version) {
    const config = parsed.positionals[0] !== 'format' || parsed.values.config ? await service.config() : undefined;
    presentation = await loadPresentation(service.paths, config, { required: parsed.values['user-config'] !== undefined });
  }
  if (parsed.values.help || parsed.values.version) {
    const { output } = await executeCommand(args);
    await present(output, { ...parsed.values, format: 'json' });
  } else if (parsed.positionals[0] === 'watch') {
    await watch(args);
  } else if (parsed.positionals[0] === 'native-host') {
    if (parsed.positionals.length !== 1 || Object.keys(parsed.values).some((key) =>
      !['home', 'config', 'format'].includes(key))) {
      throw new DevDashError('INVALID_ARGUMENT', 'native-host accepts only --home and --config.');
    }
    await service.diagnostics.run('native.host', {}, () => serveNative(process.stdin, process.stdout, { service }));
  } else if (parsed.positionals[0] === 'native-manifest') {
    if (parsed.positionals.length !== 1 || Object.keys(parsed.values).some((key) =>
      !['extension-id', 'launcher', 'pretty', 'format'].includes(key))) {
      throw new DevDashError('INVALID_ARGUMENT', 'native-manifest accepts only --extension-id, --launcher, and --pretty.');
    }
    const manifest = await service.diagnostics.run('command', { command: 'native-manifest' }, () =>
      nativeManifest(parsed.values['extension-id'], parsed.values.launcher));
    await print(manifest, parsed.values.pretty);
  } else {
    const { output, exitCode } = await executeCommand(args, { service });
    await present(output, parsed.values);
    process.exitCode = exitCode;
  }
}

try {
  process.stdout.on('error', () => { process.exitCode = 1; });
  await main();
} catch (error) {
  let reported = error;
  if (service && !error.diagnosticId && error.code !== 'LOG_WRITE_FAILED') {
    try { await service.diagnostics.log('command.failed', { code: diagnosticCode(error) }); } catch (loggingError) {
      reported = new DevDashError('LOG_WRITE_FAILED', `Could not record ${diagnosticCode(error)}: ${loggingError.message}`);
    }
  }
  if (service && !reported.diagnosticId) reported.diagnosticId = service.diagnostics.sessionId;
  await print(errorJson(reported), false, process.stderr);
  process.exitCode = 1;
}
