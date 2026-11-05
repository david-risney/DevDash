import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { queryChromiumBugs } from './bugs.js';
import { validateBugSearch } from './bug-search.js';
import { queryGerrit, validateGerritOptions, DEFAULT_HOST } from './gerrit.js';
import { CrError, safeError } from './errors.js';
import { createLogger, VERSION } from './logger.js';

const HELP = {
  schemaVersion: 1, name: 'cr', version: VERSION,
  commands: [
    'cr bugs view <id-or-url>... [--limit N] [--pretty]',
    'cr bugs list --query <issue-tracker-query> [--limit N] [--pretty]',
    'cr cls list --query <gerrit-query> [--project <project>] [--host <https-origin>] [--limit N] [--pretty]',
    'cr doctor', 'cr logs path', 'cr logs tail [--lines N] [--errors]',
    'cr --help', 'cr --version',
  ],
  options: { home: '--home <path> (any command); otherwise CR_HOME or ~/.cr', limit: '1..20000; default 1000', lines: '1..1000; default 100' },
  browserInstall: 'npx playwright install chromium --only-shell',
};
const bad = message => { throw new CrError('INVALID_ARGUMENT', message); };

export function parseBugId(value) {
  if (/^[1-9]\d{0,15}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { bad('Bug IDs must be 1-16 digits or strict HTTPS URLs on crbug.com or issues.chromium.org.'); }
  if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.search || url.hash || !/^https:\/\/(?:crbug\.com|issues\.chromium\.org)\//.test(value)) {
    bad('Bug URLs must use HTTPS on an official host without credentials, port, query, or fragment.');
  }
  const match = url.hostname === 'crbug.com'
    ? url.pathname.match(/^\/([1-9]\d{0,15})$/)
    : url.hostname === 'issues.chromium.org'
      ? url.pathname.match(/^\/(?:u\/\d+\/)?issues\/([1-9]\d{0,15})$/) : null;
  if (!match || /[\\%]/.test(value)) bad('Bug URL must identify a numeric issue on an official host.');
  return match[1];
}

function parse(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value))) {
    bad('cr arguments must not contain control characters.');
  }
  const options = {}, positionals = [];
  const values = new Set(['--home', '--query', '--project', '--host', '--limit', '--lines']);
  const flags = new Set(['--pretty', '--errors', '--help', '--version']);
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const arg = equals < 0 ? raw : raw.slice(0, equals);
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (!values.has(arg) && !flags.has(arg)) bad('Unknown cr option. Run cr --help.');
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) bad('Duplicate cr options are not supported.');
    if (flags.has(arg)) {
      if (equals >= 0) bad('Boolean cr options do not accept values.');
      options[key] = true;
      continue;
    }
    const value = equals < 0 ? args[++index] : raw.slice(equals + 1);
    if (!value || (equals < 0 && value.startsWith('--')) || !value.trim()) bad('A cr option is missing its value.');
    options[key] = value;
  }
  if (options.home === '') bad('--home requires a directory path.');
  for (const name of ['limit', 'lines']) {
    if (options[name] !== undefined) {
      if (!/^[1-9]\d*$/.test(options[name])) bad(`--${name} requires a positive integer.`);
      options[name] = Number(options[name]);
      if (!Number.isSafeInteger(options[name]) || options[name] > (name === 'lines' ? 1000 : 20000)) {
        bad(`--${name} exceeds the supported range.`);
      }
    }
  }
  return { options, positionals };
}

function allowedOptions(options, allowed) {
  const universal = ['home', 'pretty', 'help', 'version'];
  if (Object.keys(options).some(key => !universal.includes(key) && !allowed.includes(key))) {
    bad('This option is not supported by the cr command. Run cr --help.');
  }
}

async function doctor(dependencies) {
  let installed = false, executable = null;
  try {
    const chromium = dependencies.chromium ?? (await import('playwright')).chromium;
    const full = chromium.executablePath();
    let folder = dirname(full);
    while (!/^chromium-\d+$/.test(basename(folder)) && dirname(folder) !== folder) folder = dirname(folder);
    const revision = basename(folder).match(/^chromium-(\d+)$/)?.[1];
    const platform = process.platform === 'win32' ? 'win64' : process.platform === 'darwin'
      ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : 'linux64';
    const shell = revision ? join(dirname(folder), `chromium_headless_shell-${revision}`,
      `chrome-headless-shell-${platform}`, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell') : null;
    for (const candidate of [shell, full].filter(Boolean)) {
      try {
        await (dependencies.access ?? access)(candidate, constants.X_OK);
        installed = true; executable = candidate; break;
      } catch {}
    }
  } catch {}
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
  return {
    schemaVersion: 1, status: installed && nodeSupported ? 'ok' : 'failed',
    appVersion: VERSION, nodeVersion: process.version,
    checks: {
      node: { status: nodeSupported ? 'ok' : 'failed', required: '>=22' },
      browser: {
        status: installed ? 'ok' : 'failed', executable,
        ...(installed ? {} : { code: 'BROWSER_NOT_INSTALLED', install: 'npx playwright install chromium --only-shell' }),
      },
    },
    providers: { bugs: { endpoint: 'https://issues.chromium.org', access: 'anonymous-rendered' }, cls: { endpoint: DEFAULT_HOST, access: 'anonymous-http' } },
  };
}

export async function executeCommand(args, dependencies = {}) {
  let logger, parsed;
  try {
    parsed = parse(args);
    logger = dependencies.logger ?? createLogger({ home: parsed.options.home }, dependencies.env ?? process.env);
    await logger.log('cli.start', { phase: 'command' });
    const { options, positionals } = parsed;
    let output, exitCode = 0;
    if (options.help || !args.length) output = HELP;
    else if (options.version) output = { schemaVersion: 1, name: 'cr', version: VERSION };
    else if (positionals[0] === 'bugs' && positionals[1] === 'view') {
      allowedOptions(options, ['limit']);
      const bugIds = positionals.slice(2).map(parseBugId);
      if (bugIds.length < 1 || bugIds.length > 100 || new Set(bugIds).size !== bugIds.length) {
        bad('cr bugs view requires 1-100 unique bug IDs.');
      }
      const result = await (dependencies.queryBugs ?? queryChromiumBugs)({
        provider: 'chromium', resource: 'bugs', bugIds, limit: options.limit ?? 1000,
      }, { ...dependencies, log: logger.log });
      output = { schemaVersion: 1, ...result };
    } else if (positionals.join(' ') === 'bugs list') {
      allowedOptions(options, ['query', 'limit']);
      try { validateBugSearch(options.query); } catch {
        bad('cr bugs list requires a nonempty --query of at most 32768 characters without control characters.');
      }
      const result = await (dependencies.queryBugs ?? queryChromiumBugs)({
        provider: 'chromium', resource: 'bugs', query: options.query, limit: options.limit ?? 1000,
      }, { ...dependencies, log: logger.log });
      output = { schemaVersion: 1, ...result };
    } else if (positionals.join(' ') === 'cls list') {
      allowedOptions(options, ['query', 'project', 'host', 'limit']);
      const request = { query: options.query, project: options.project, host: options.host, limit: options.limit ?? 1000 };
      validateGerritOptions(request);
      const result = await (dependencies.queryCls ?? queryGerrit)(request, { ...dependencies, log: logger.log });
      output = { schemaVersion: 1, ...result };
    } else if (positionals.join(' ') === 'doctor') {
      allowedOptions(options, []);
      output = await doctor(dependencies);
      exitCode = output.status === 'failed' ? 2 : 0;
    } else if (positionals.join(' ') === 'logs path') {
      allowedOptions(options, []);
      output = { schemaVersion: 1, path: logger.file };
    } else if (positionals.join(' ') === 'logs tail') {
      allowedOptions(options, ['lines', 'errors']);
      output = { schemaVersion: 1, items: await logger.tail(options.lines ?? 100, options.errors ?? false) };
    } else bad('Unknown cr command. Run cr --help.');
    await logger.log('cli.complete', { phase: 'command', outcome: exitCode ? 'failed' : 'success', ...(output.items ? { count: output.items.length } : {}) });
    return { output, exitCode, pretty: options.pretty ?? false, diagnosticId: logger.requestId };
  } catch (error) {
    let failure = safeError(error);
    logger ??= dependencies.logger ?? createLogger({}, dependencies.env ?? process.env);
    failure.diagnosticId = logger.requestId;
    try { await logger.log('cli.failed', { phase: 'command', code: failure.code, outcome: 'failed' }); }
    catch (logError) { failure = safeError(logError); failure.diagnosticId = logger.requestId; }
    throw failure;
  }
}

export async function runCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const { output, exitCode, pretty } = await executeCommand(args, dependencies);
    stdout.write(JSON.stringify(output, null, pretty ? 2 : undefined) + '\n');
    return exitCode;
  } catch (error) {
    const failure = safeError(error);
    stderr.write(JSON.stringify({ error: {
      code: failure.code, message: failure.message, diagnosticId: failure.diagnosticId ?? randomUUID(),
    } }) + '\n');
    return 1;
  }
}
