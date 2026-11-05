import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, delimiter, join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { DevDashError } from './errors.js';
import { diagnosticCode, logEvent } from './diagnostics.js';

const execute = promisify(execFile);

const crCodes = new Set([
  'INVALID_ARGUMENT', 'INVALID_PROFILE', 'PROVIDER_RESPONSE', 'PROVIDER_HTTP', 'PROVIDER_NETWORK',
  'LOG_WRITE_FAILED', 'BROWSER_NOT_INSTALLED', 'BROWSER_FAILED', 'BROWSER_CLEANUP_FAILED',
  'BUG_UNAVAILABLE', 'BUG_TIMEOUT', 'BUG_HTTP', 'BUG_RESPONSE', 'BUG_EXTRACTION_FAILED',
  'BUG_ACCESS_DENIED', 'BUG_NOT_FOUND', 'BUG_RENDER_FAILED',
]);

export function chromiumProcessFailure(error) {
  if (error.killed || !Number.isInteger(error.code) || typeof error.stderr !== 'string' ||
      Buffer.byteLength(error.stderr) > 1024 * 1024) return undefined;
  let value;
  try { value = JSON.parse(error.stderr); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !crCodes.has(value.error?.code)) return undefined;
  const failure = new DevDashError(value.error.code,
    `cr Chromium query failed (${value.error.code}). Inspect cr diagnostics or run the query directly with cr.`);
  if (typeof value.error.diagnosticId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.error.diagnosticId)) {
    failure.diagnosticId = value.error.diagnosticId;
  }
  return failure;
}

export async function resolveWindowsCr(env) {
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue;
    const location = directory.replace(/^"|"$/g, '');
    const executable = join(location, 'cr.exe');
    try {
      await access(executable);
      return { command: executable, prefix: [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let text;
    const launcher = join(location, 'cr.cmd');
    try { text = await readFile(launcher, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const entry = text.match(/"%dp0%\\([^"\r\n%]+\.js)"\s+%\*/i)?.[1];
    if (!entry) {
      throw new DevDashError('UNSUPPORTED_CR_LAUNCHER', 'Unsupported cr launcher. Install the standalone @devdash/cr package using npm.');
    }
    const script = resolve(location, ...entry.split(/[\\/]/));
    const packageRoot = resolve(dirname(script), '..');
    let metadata;
    try { metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')); } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
      throw new DevDashError('UNSUPPORTED_CR_LAUNCHER', 'cr launcher does not resolve to an installed @devdash/cr package.');
    }
    if (basename(script) !== 'cr.js' || metadata?.name !== '@devdash/cr' ||
        metadata.bin?.cr !== 'bin/cr.js' || script !== resolve(packageRoot, 'bin', 'cr.js')) {
      throw new DevDashError('UNSUPPORTED_CR_LAUNCHER', 'cr launcher does not match the standalone @devdash/cr executable.');
    }
    await access(script);
    return { command: process.execPath, prefix: [script] };
  }
  throw new DevDashError('CLI_NOT_FOUND', 'Chromium CLI not found. Install @devdash/cr and ensure cr is on PATH.');
}

export function processFailureDetails(error) {
  const stderr = typeof error.stderr === 'string' ? error.stderr.slice(0, 1024 * 1024) : '';
  const status = stderr.match(/(?:HTTP(?:\/[\d.]+)?|status(?:\s+code)?)[:\s]+(401|403|404|429|5\d\d)\b/i);
  const providerCode = stderr.match(/\bTF\d{5,8}\b/)?.[0];
  const reason = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
    : error.killed ? 'timeout'
    : error.code === 'ENOENT' ? 'not-found'
    : status?.[1] === '401' || /bad credentials|authentication failed|not logged in|gh auth login|az login|TF400813|VS30063/i.test(stderr) ? 'authentication'
    : status?.[1] === '403' || /access denied|permission denied|not authorized|forbidden/i.test(stderr) ? 'permission'
    : status?.[1] === '429' || /rate limit|too many requests/i.test(stderr) ? 'rate-limit'
    : /syntax error|invalid (?:query|wiql)|unrecognized arguments|TF51005|TF401232/i.test(stderr) ? 'invalid-query'
    : 'exit';
  return {
    code: Number.isInteger(error.code) ? 'CLI_FAILED' : diagnosticCode(error),
    ...(Number.isInteger(error.code) ? { exitCode: error.code } : {}),
    killed: error.killed === true,
    reason,
    ...(status ? { httpStatus: Number(status[1]) } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(typeof error.signal === 'string' ? { signal: error.signal.toLowerCase() } : {}),
  };
}

async function resolveWindowsAz(env) {
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue;
    const executable = join(directory.replace(/^"|"$/g, ''), 'az.exe');
    try {
      await access(executable);
      return { command: executable, prefix: [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const launcher = join(directory.replace(/^"|"$/g, ''), 'az.cmd');
    let text;
    try { text = await readFile(launcher, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const python = resolve(dirname(launcher), '..', 'python.exe');
    if (!text.includes('azure.cli') || !text.includes('%~dp0\\..\\python.exe')) {
      throw new DevDashError('UNSUPPORTED_AZ_LAUNCHER', `Unsupported Azure CLI launcher at ${launcher}; install the official Azure CLI MSI or provide az.exe on PATH.`);
    }
    await access(python);
    return { command: python, prefix: ['-IBm', 'azure.cli'], env: { ...env, AZ_INSTALLER: 'MSI' } };
  }
  throw new DevDashError('CLI_NOT_FOUND', 'Azure CLI not found. Install az and the azure-devops extension.');
}

export async function runText(command, args, options = {}) {
  const started = Date.now();
  const operation = command === 'gh'
    ? `gh.${args[0] === 'api' ? 'api' : 'check'}`
    : command === 'az'
      ? `az.${['boards', 'repos', 'devops', 'extension', 'version'].includes(args[0]) ? args[0] : 'check'}`
      : command === 'cr'
        ? `cr.${['bugs', 'cls', 'doctor', 'logs'].includes(args[0]) ? args[0] : 'check'}`
        : 'external';
  await logEvent('process.start', { operation });
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    AZURE_CORE_NO_COLOR: '1',
    AZURE_CORE_COLLECT_TELEMETRY: '0',
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
    ...options.env,
  };
  try {
    const executable = process.platform === 'win32' && command === 'az'
      ? await resolveWindowsAz(env)
      : process.platform === 'win32' && command === 'cr'
        ? await resolveWindowsCr(env)
      : { command, prefix: [] };
    const { stdout } = await execute(executable.command, [...executable.prefix, ...args], {
      encoding: 'utf8',
      timeout: options.timeout ?? 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env: executable.env ?? env,
    });
    await logEvent('process.complete', { operation, durationMs: Date.now() - started, bytes: Buffer.byteLength(stdout) });
    return stdout;
  } catch (error) {
    if (error.code === 'LOG_WRITE_FAILED') throw error;
    const crFailure = command === 'cr' ? chromiumProcessFailure(error) : undefined;
    await logEvent('process.failed', {
      operation,
      durationMs: Date.now() - started,
      ...processFailureDetails(error),
      ...(crFailure ? { code: crFailure.code } : {}),
    });
    if (crFailure) throw crFailure;
    if (error instanceof DevDashError) throw error;
    if (error.code === 'ENOENT') {
      throw new DevDashError('CLI_NOT_FOUND', `${command} not found; install it and ensure it is on PATH.`);
    }
    // Do not echo provider stderr: it may contain tokens, query contents, or private server diagnostics.
    const reason = error.killed ? 'timed out or exceeded the output limit' : `exited with code ${error.code ?? 'unknown'}`;
    throw new DevDashError('CLI_FAILED', `${command} ${reason}. Check CLI authentication and query permissions directly.`);
  }
}

export async function runJson(command, args, options) {
  const text = await runText(command, args, options);
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    await logEvent('process.json.failed', { code: 'INVALID_PROVIDER_RESPONSE' });
    throw new DevDashError('INVALID_PROVIDER_RESPONSE', `${command} returned invalid JSON.`);
  }
}
