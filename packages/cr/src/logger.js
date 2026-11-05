import { randomUUID } from 'node:crypto';
import { mkdir, open, stat, rename, rm, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';
import { CrError, ERROR_CODES } from './errors.js';

export const VERSION = '0.1.0';
export const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['cli.start', 'cli.complete', 'cli.failed', 'browser.start', 'browser.ready',
  'browser.failed', 'browser.close', 'chromium.bug.start', 'chromium.bug.http', 'chromium.bug.complete',
  'chromium.bug.failed', 'chromium.search.start', 'chromium.search.page', 'chromium.search.complete',
  'chromium.search.failed', 'http.start', 'http.response', 'http.failed', 'gerrit.page']);
const PHASES = new Set(['command', 'launch', 'import', 'context', 'page', 'goto', 'ready', 'extract',
  'normalize', 'page-close', 'context-close', 'browser-close', 'gerrit-fetch', 'gerrit-normalize',
  'search-page', 'search-goto', 'search-ready', 'search-extract', 'search-next', 'search-close']);
const REASONS = new Set(['invalid-date', 'login', 'restricted', 'captcha', 'not-found', 'missing-title', 'missing-state']);

function safeFields(fields) {
  const output = {};
  if (PHASES.has(fields.phase)) output.phase = fields.phase;
  if (ERROR_CODES.has(fields.code)) output.code = fields.code;
  if (REASONS.has(fields.reason)) output.reason = fields.reason;
  if (['success', 'failed'].includes(fields.outcome)) output.outcome = fields.outcome;
  if (typeof fields.bugId === 'string' && /^[1-9]\d{0,15}$/.test(fields.bugId)) output.bugId = fields.bugId;
  for (const key of ['httpStatus', 'durationMs', 'count']) {
    if (Number.isSafeInteger(fields[key]) && fields[key] >= 0 &&
        (key !== 'httpStatus' || (fields[key] >= 100 && fields[key] <= 599))) output[key] = fields[key];
  }
  return output;
}

export function createLogger(options = {}, env = process.env) {
  const home = resolve(options.home ?? env.CR_HOME ?? join(homedir(), '.cr'));
  const logs = join(home, 'logs');
  const file = join(logs, 'cr.jsonl'), sessionId = randomUUID();
  const requestId = UUID.test(env.CR_REQUEST_ID ?? '') ? env.CR_REQUEST_ID : randomUUID();
  async function locked(action) {
    let release, compromised = false;
    try {
      await mkdir(logs, { recursive: true, mode: 0o700 });
      release = await lockfile.lock(file, {
        realpath: false, stale: 10000,
        retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 200 },
        onCompromised: () => { compromised = true; },
      });
      const result = await action(() => {
        if (compromised) throw new Error('lock compromised');
      });
      if (compromised) throw new Error('lock compromised');
      return result;
    } catch {
      throw new CrError('LOG_WRITE_FAILED', 'cr diagnostic log write or lock failed. Check the cr home directory permissions.');
    } finally {
      if (release) {
        try { await release(); }
        catch { throw new CrError('LOG_WRITE_FAILED', 'cr diagnostic log lock could not be released.'); }
      }
    }
  }
  return {
    home, logs, file, sessionId, requestId,
    async log(event, fields = {}) {
      if (!EVENTS.has(event)) return;
      const line = JSON.stringify({
        timestamp: new Date().toISOString(), sessionId, requestId, event,
        appVersion: VERSION, nodeVersion: process.version, ...safeFields(fields),
      }) + '\n';
      await locked(async check => {
        let size = 0;
        try { size = (await stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (size + Buffer.byteLength(line) > MAX_BYTES) {
          await rm(`${file}.4`, { force: true });
          for (let index = 3; index >= 0; index--) {
            try { await rename(index ? `${file}.${index}` : file, `${file}.${index + 1}`); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        check();
        await appendFile(file, line, { mode: 0o600 });
      });
    },
    async tail(lines = 100, errors = false) {
      if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new CrError('INVALID_ARGUMENT', '--lines must be from 1 to 1000.');
      const records = [];
      try {
        for (let index = 4; index >= 0; index--) {
          let handle;
          try {
            handle = await open(index ? `${file}.${index}` : file, 'r');
            const size = (await handle.stat()).size;
            const start = Math.max(0, size - MAX_BYTES);
            const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            for (const line of text.split('\n').slice(start ? 1 : 0)) {
              if (!line) continue;
              let record;
              try { record = JSON.parse(line); } catch { continue; }
              if (!EVENTS.has(record.event) || !UUID.test(record.sessionId ?? '') || !UUID.test(record.requestId ?? '')) continue;
              if (errors && !ERROR_CODES.has(record.code) && record.outcome !== 'failed') continue;
              records.push({
                timestamp: typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))
                  ? new Date(record.timestamp).toISOString() : null,
                sessionId: record.sessionId, requestId: record.requestId, event: record.event,
                ...safeFields(record),
              });
              if (records.length > lines) records.shift();
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          finally { await handle?.close(); }
        }
        return records;
      } catch { throw new CrError('LOG_READ_FAILED', 'cr diagnostic logs could not be read.'); }
    },
  };
}
