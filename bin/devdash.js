#!/usr/bin/env node
import { DevDash } from '../src/service.js';
import { executeCommand, parseCommand, validateWatch } from '../src/commands.js';
import { DevDashError, errorJson } from '../src/errors.js';
import { nativeManifest, serveNative } from '../src/native.js';
import { watchProfiles } from '../src/watch.js';
import { diagnosticCode, diagnosticPathsOptions } from '../src/diagnostics.js';
import { formatDocument, formatResults } from '../src/format.js';
import { loadPresentation, resolvePresentation } from '../src/presentation.js';
import { parseArgs } from 'node:util';
import { repositoryConfiguration } from '../src/repository.js';
import { themeExamples } from '../src/themes.js';

let service;
let presentation;
let outputOptions = {};
let nativeProtocol = false;

function print(value, pretty = false, stream = process.stdout) {
  return new Promise((resolve, reject) => stream.write(
    `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, error => error ? reject(error) : resolve()));
}

async function present(output, options, { queryResults = false, themes = false, title = 'DevDash', stream = process.stdout } = {}) {
  const format = options.format ?? 'ansi';
  if (format === 'json') {
    await print(output, options.pretty, stream);
    return;
  }
  const renderer = { ansi: 'ansi', ascii: 'text', md: 'markdown' }[format];
  if (themes) {
    const result = output.themes.length ? formatResults(themeExamples(output.themes), renderer, {
      columns: stream.columns ?? 100, ...presentation,
      presentationFor: section => resolvePresentation(presentation?.presentationFor?.(section) ?? presentation?.presentation,
        { theme: section.profile }),
    }) : formatDocument({ message: 'No themes match the supplied glob.' }, renderer, { title: 'Themes', ...presentation });
    await new Promise((resolve, reject) => stream.write(result.output, error => error ? reject(error) : resolve()));
    return;
  }
  const result = (queryResults ? formatResults : formatDocument)(output,
    renderer,
    { columns: stream.columns ?? 100, ...presentation, title });
  await new Promise((resolve, reject) => stream.write(result.output, error => error ? reject(error) : resolve()));
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
        output => present(output.profile === null && (values.format ?? 'ansi') !== 'json'
          ? { ...output, profile: undefined } : output, { ...values, pretty: false }, { queryResults: true })));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  const args = process.argv.slice(2);
  // Preserve explicit machine output even when strict command validation fails.
  let loose;
  try {
    loose = parseArgs({ args, allowPositionals: true, strict: false,
      options: { format: { type: 'string' } } });
  } catch (error) {
    throw new DevDashError('INVALID_ARGUMENT', error.message);
  }
  outputOptions = loose.values;
  nativeProtocol = loose.positionals[0] === 'native-host';
  service = new DevDash(diagnosticPathsOptions(args));
  const parsed = parseCommand(args);
  outputOptions = parsed.values;
  nativeProtocol = parsed.positionals[0] === 'native-host';
  service = new DevDash(parsed.values);
  if ((parsed.values.format ?? 'ansi') !== 'json' && !parsed.values.help && !parsed.values.version &&
      (parsed.positionals[0] || parsed.values.themes !== undefined) && !nativeProtocol) {
    const config = parsed.positionals[0] === 'repo'
      ? await repositoryConfiguration(service, { required: parsed.values.config !== undefined })
      : ['get', 'refresh', 'watch'].includes(parsed.positionals[0]) ||
      (parsed.positionals[0] === 'format' || parsed.values.themes !== undefined) && parsed.values.config
        ? await service.config() : undefined;
    presentation = await loadPresentation(service.paths, config, { required: parsed.values['user-config'] !== undefined });
  }
  if (parsed.values.help || parsed.values.version) {
    const { output } = await executeCommand(args);
    await present(output, parsed.values, { title: parsed.values.version ? 'Version' : 'Help' });
  } else if (parsed.positionals[0] === 'watch') {
    await watch(args);
  } else if (parsed.positionals[0] === 'native-host') {
    if (parsed.positionals.length !== 1 || Object.keys(parsed.values).some((key) =>
      !['home', 'config', 'format'].includes(key))) {
      throw new DevDashError('INVALID_ARGUMENT', 'native-host accepts only --home, --config, and --format json.');
    }
    await service.diagnostics.run('native.host', {}, () => serveNative(process.stdin, process.stdout, { service }));
  } else if (parsed.positionals[0] === 'native-manifest') {
    if (parsed.positionals.length !== 1 || Object.keys(parsed.values).some((key) =>
      !['extension-id', 'launcher', 'pretty', 'format'].includes(key))) {
      throw new DevDashError('INVALID_ARGUMENT', 'native-manifest accepts only --extension-id, --launcher, --format, and --pretty.');
    }
    const manifest = await service.diagnostics.run('command', { command: 'native-manifest' }, () =>
      nativeManifest(parsed.values['extension-id'], parsed.values.launcher));
    await present(manifest, parsed.values, { title: 'Native host manifest' });
  } else {
    const { output, exitCode } = await executeCommand(args, { service });
    if (parsed.positionals[0] === 'repo' && output.matched === false &&
        parsed.values.format !== 'json' && !parsed.values['resolve-only']) return;
    const queryResults = (['get', 'refresh', 'format'].includes(parsed.positionals[0]) ||
      (parsed.positionals[0] === 'repo' && !parsed.values['resolve-only'])) &&
      !parsed.values.background && parsed.values['page-size'] === undefined &&
      parsed.values.cursor === undefined && parsed.values.fields === undefined;
    await present(output, parsed.values, { queryResults,
      themes: parsed.values.themes !== undefined,
      title: parsed.positionals.slice(0, 2).join(' ') || 'Help' });
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
  await present(errorJson(reported), { format: nativeProtocol || outputOptions.format === 'json' ? 'json'
    : ['ascii', 'md'].includes(outputOptions.format) ? outputOptions.format : 'ansi' },
  { title: 'Error', stream: process.stderr });
  process.exitCode = 1;
}
