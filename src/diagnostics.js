import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DevDashError } from './errors.js';
import { withLock } from './storage.js';

const context = new AsyncLocalStorage();
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;
const codes = new Set([
  'FILTER_FAILED', 'FILTER_RESULT', 'FILTER_LIMIT',
  'INVALID_PROFILE', 'INVALID_CONFIG', 'INVALID_FILTER', 'INVALID_ARGUMENT', 'INVALID_JSON', 'INVALID_INPUT', 'INVALID_PRESENTATION', 'INPUT_TOO_LARGE',
  'CONFIG_NOT_FOUND', 'CONFIG_EXISTS', 'PROFILE_NOT_FOUND', 'QUERY_NOT_FOUND', 'INVALID_CACHE', 'CACHE_MISS',
  'PROFILE_CHANGED', 'INVALID_PROVIDER_RESPONSE', 'PROVIDER_RESPONSE', 'PROVIDER_HTTP',
  'PROVIDER_NETWORK', 'CLI_FAILED', 'CLI_NOT_FOUND', 'GITHUB_SSO_REQUIRED', 'UNSUPPORTED_PROVIDER', 'UNSUPPORTED_QUERY',
  'UNSUPPORTED_AZ_LAUNCHER', 'UNSUPPORTED_CR_LAUNCHER', 'INVALID_PROVIDER', 'INVALID_REQUEST', 'MESSAGE_TOO_LARGE', 'INVALID_FRAME', 'BUSY',
  'LOCK_LOST', 'LOG_WRITE_FAILED', 'INVALID_LOG', 'BROWSER_NOT_INSTALLED', 'BROWSER_FAILED',
  'BACKGROUND_START_FAILED', 'BACKGROUND_CANCELLED', 'REVISION_CONFLICT', 'CURSOR_EXPIRED',
  'AVATAR_UNAVAILABLE', 'AVATAR_TOO_LARGE', 'AVATAR_FAILED',
  'NATIVE_REGISTRATION_CONFLICT', 'NATIVE_REGISTRATION_FAILED', 'NATIVE_NOT_INSTALLED', 'UNSUPPORTED_PLATFORM', 'SOURCE_CHECKOUT_REQUIRED',
  'BUG_UNAVAILABLE', 'BUG_TIMEOUT', 'BUG_HTTP', 'BUG_RESPONSE', 'BUG_EXTRACTION_FAILED',
  'BROWSER_CLEANUP_FAILED', 'BUG_ACCESS_DENIED', 'BUG_NOT_FOUND', 'BUG_RENDER_FAILED',
  'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EPIPE', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ETIMEDOUT',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
]);
const safeSlug = (value) => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,79}$/.test(value);

export function diagnosticCode(error) {
  return codes.has(error?.code) ? error.code : 'UNEXPECTED_ERROR';
}

export function safeCommand(positionals) {
  const commands = new Set(['init', 'config', 'profile', 'get', 'refresh', 'format', 'cache', 'watch',
    'doctor', 'hello', 'query', 'avatar', 'native', 'native-host', 'native-manifest', 'logs']);
  if (!commands.has(positionals[0])) return 'invalid';
  const command = positionals[0];
  if (!['config', 'profile', 'query', 'cache', 'logs'].includes(command)) return command;
  const actions = new Set(['show', 'validate', 'list', 'get', 'set', 'remove', 'status', 'clear', 'tail', 'path']);
  return `${command}.${actions.has(positionals[1]) ? positionals[1] : 'invalid'}`;
}

export function diagnosticPathsOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break;
    for (const key of ['home', 'config']) {
      if (args[index].startsWith(`--${key}=`)) {
        const value = args[index].slice(key.length + 3);
        if (value) result[key] = value;
      } else if (args[index] === `--${key}` && args[index + 1] && !args[index + 1].startsWith('-')) {
        result[key] = args[index + 1];
      }
    }
  }
  return result;
}

function safeDetails(details) {
  const output = {};
  for (const [key, value] of Object.entries(details)) {
    if (['durationMs', 'count', 'sourceCount', 'removedCount', 'failed', 'httpStatus', 'exitCode', 'page', 'bytes', 'limit'].includes(key)
        && Number.isFinite(value)) output[key] = value;
    if (['cachedOnly', 'refresh', 'due', 'stale', 'truncated', 'killed'].includes(key)
        && typeof value === 'boolean') output[key] = value;
    if (['profile', 'queryName'].includes(key) && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
      output[key] = value;
    }
    if (['phase', 'reason', 'outcome', 'operation', 'command', 'signal'].includes(key) && safeSlug(value)) output[key] = value;
    if (key === 'provider' && ['github', 'ado', 'chromium'].includes(value)) output[key] = value;
    if (key === 'resource' && ['bugs', 'prs', 'cls'].includes(value)) output[key] = value;
    if (key === 'bugId' && typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) output[key] = value;
    if (key === 'code' && (codes.has(value) || value === 'UNEXPECTED_ERROR')) output[key] = value;
    if (key === 'providerCode' && typeof value === 'string' && /^TF\d{5,8}$/.test(value)) output[key] = value;
  }
  return output;
}

async function size(path) {
  try { return (await stat(path)).size; } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export class Diagnostics {
  constructor(paths, options = {}) {
    this.directory = paths.logs;
    this.file = join(this.directory, 'devdash.jsonl');
    this.configId = createHash('sha256').update(paths.config).digest('hex').slice(0, 16);
    this.sessionId = randomUUID();
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_FILES;
    this.now = options.now ?? Date.now;
  }

  async log(event, details = {}) {
    if (!safeSlug(event)) throw new DevDashError('INVALID_ARGUMENT', 'Invalid diagnostic event name.');
    const scope = context.getStore();
    const record = {
      schemaVersion: 1,
      timestamp: new Date(this.now()).toISOString(),
      level: event.endsWith('.failed') || event.endsWith('.error') || details.failed > 0 || details.exitCode > 0 ? 'error' : 'info',
      sessionId: this.sessionId,
      requestId: scope?.requestId ?? this.sessionId,
      spanId: scope?.spanId ?? this.sessionId,
      ...(scope?.parentSpanId ? { parentSpanId: scope.parentSpanId } : {}),
      pid: process.pid,
      nodeVersion: process.version,
      appVersion: '0.1.0',
      configId: this.configId,
      event,
      ...safeDetails(scope?.details ?? {}),
      ...safeDetails(details),
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      await withLock(this.file, async (checkLock) => {
        if (await size(this.file) + Buffer.byteLength(line) > this.maxBytes) {
          await rm(`${this.file}.${this.maxFiles - 1}`, { force: true });
          for (let index = this.maxFiles - 2; index >= 0; index--) {
            const source = index === 0 ? this.file : `${this.file}.${index}`;
            try {
              checkLock();
              await rename(source, `${this.file}.${index + 1}`);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
        }
        checkLock();
        await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
      });
    } catch (error) {
      throw new DevDashError('LOG_WRITE_FAILED', `Cannot write DevDash diagnostics (${diagnosticCode(error)}). Check the data directory permissions and free space.`, { cause: error });
    }
  }

  async run(operation, details, action, { newRequest = false } = {}) {
    const parent = context.getStore();
    const scope = {
      requestId: newRequest ? randomUUID() : parent?.requestId ?? randomUUID(),
      spanId: randomUUID(),
      parentSpanId: parent?.spanId,
      details: { ...parent?.details, ...details },
      logger: this,
    };
    return context.run(scope, async () => {
      const started = this.now();
      await this.log(`${operation}.start`);
      try {
        const result = await action();
        await this.log(`${operation}.complete`, {
          durationMs: this.now() - started,
          ...(Array.isArray(result?.items) ? { count: result.items.length, truncated: result.truncated } : {}),
          ...(Number.isInteger(result?.failed ?? result?.output?.failed) ? { failed: result.failed ?? result.output.failed } : {}),
          ...(Number.isInteger(result?.exitCode) ? { exitCode: result.exitCode } : {}),
        });
        return result;
      } catch (error) {
        if (error instanceof Error) error.diagnosticId = scope.requestId;
        if (error.code !== 'LOG_WRITE_FAILED') {
          try {
            await this.log(`${operation}.failed`, { code: diagnosticCode(error), durationMs: this.now() - started });
          } catch (loggingError) {
            const failure = new DevDashError('LOG_WRITE_FAILED',
              `Could not record ${diagnosticCode(error)}: ${loggingError.message}`, { cause: error });
            failure.diagnosticId = scope.requestId;
            throw failure;
          }
        }
        throw error;
      }
    });
  }

  async tail({ lines = 100, errorsOnly = false } = {}) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
      throw new DevDashError('INVALID_ARGUMENT', '--lines must be an integer from 1 to 1000.');
    }
    return withLock(this.file, async () => {
      const entries = [];
      for (let index = this.maxFiles - 1; index >= 0; index--) {
        const path = index === 0 ? this.file : `${this.file}.${index}`;
        let text;
        try { text = await readFile(path, 'utf8'); } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        for (const line of text.split('\n')) {
          if (!line) continue;
          let value;
          try { value = JSON.parse(line); } catch {
            throw new DevDashError('INVALID_LOG', 'Diagnostic log contains an incomplete or invalid JSON record.');
          }
          if (!value || Array.isArray(value) || value.schemaVersion !== 1 || !safeSlug(value.event)
              || !['info', 'error'].includes(value.level) || typeof value.configId !== 'string') {
            throw new DevDashError('INVALID_LOG', 'Diagnostic log contains an invalid record shape.');
          }
          if (value.configId !== this.configId || (errorsOnly && value.level !== 'error')) continue;
          entries.push(value);
          if (entries.length > lines) entries.shift();
        }
      }
      return { schemaVersion: 1, entries };
    });
  }

  pathInfo() {
    return {
      schemaVersion: 1, directory: this.directory, file: this.file,
      maxBytes: this.maxBytes, maxFiles: this.maxFiles,
      providers: { cr: { home: join(this.directory, 'cr'), file: join(this.directory, 'cr', 'logs', 'cr.jsonl') } },
    };
  }
}

export async function logEvent(event, details) {
  const logger = context.getStore()?.logger;
  if (logger) await logger.log(event, details);
}

export function providerProcessOptions() {
  const scope = context.getStore();
  return scope?.logger ? {
    env: { CR_HOME: join(scope.logger.directory, 'cr'), CR_REQUEST_ID: scope.requestId },
  } : {};
}
