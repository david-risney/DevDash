import { CrError } from './errors.js';

export const DEFAULT_HOST = 'https://chromium-review.googlesource.com';
const invalid = message => { throw new CrError('PROVIDER_RESPONSE', message); };
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Gerrit expected an object.');
  return value;
}
function text(value, label = 'metadata') {
  if (typeof value !== 'string' || !value.trim()) invalid(`Gerrit ${label}: expected a nonempty string.`);
  return value;
}
function id(value) {
  if (!((Number.isSafeInteger(value) && value > 0) ||
      (typeof value === 'string' && /^[1-9]\d*$/.test(value)))) invalid('Gerrit expected a positive numeric ID.');
  return String(value);
}
function identity(value, keys) {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  object(value);
  for (const key of keys) {
    if (value[key] != null && value[key] !== '') return key === '_account_id' ? id(value[key]) : text(value[key]);
  }
  return null;
}
function date(value) {
  if (value == null) return null;
  text(value, 'timestamp');
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,9})?$/.test(value)) {
    value = value.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1') + 'Z';
  }
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid('Gerrit timestamp: expected a valid date with a UTC offset.');
  }
  return new Date(value).toISOString();
}
function boolean(value) {
  if (value == null) return null;
  if (typeof value !== 'boolean') invalid('Gerrit expected a boolean.');
  return value;
}
function item(row, host) {
  const number = id(row._number), project = text(row.project, 'project');
  const assignee = identity(row.assignee, ['email', 'username', 'name', '_account_id']);
  if (!Array.isArray(row.hashtags ?? [])) invalid('Gerrit hashtags: expected an array.');
  const branch = Object.hasOwn(row, 'branch')
    ? (row.branch == null ? null : text(row.branch, 'branch').replace(/^refs\/heads\//, ''))
    : undefined;
  if (branch === '') invalid('Gerrit branch: expected a nonempty branch name.');
  return {
    provider: 'chromium', kind: 'cl', id: number,
    title: text(row.subject, 'subject'), state: text(row.status, 'status'),
    url: `${host}/c/${project.split('/').map(encodeURIComponent).join('/')}/+/${number}`,
    repository: project, author: identity(row.owner, ['email', 'username', 'name']),
    assignees: assignee ? [assignee] : [],
    labels: (row.hashtags ?? []).map(tag => text(tag, 'hashtag')),
    createdAt: date(row.created), updatedAt: date(row.updated),
    draft: boolean(row.work_in_progress ?? false),
    providerData: row.change_id == null ? {} : { changeId: text(row.change_id, 'change ID') },
    ...(branch === undefined ? {} : { targetBranch: branch }),
  };
}

export function validateGerritOptions(options) {
  const bad = () => { throw new CrError('INVALID_ARGUMENT', 'cr cls requires a nonempty query, an HTTPS origin, a valid optional project, and a limit from 1 to 20000.'); };
  const validText = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!validText(options.query) || !Number.isInteger(options.limit ?? 1000) ||
      (options.limit ?? 1000) < 1 || (options.limit ?? 1000) > 20000) bad();
  let host;
  try { host = new URL(options.host ?? DEFAULT_HOST); } catch { bad(); }
  const rawHost = options.host ?? DEFAULT_HOST;
  if (!validText(rawHost) || rawHost.trim() !== rawHost || !rawHost.startsWith('https://') ||
      rawHost.includes('\\') || host.protocol !== 'https:' || host.username ||
      host.password || host.search || host.hash || host.pathname !== '/') bad();
  if (options.project != null) {
    if (!validText(options.project)) bad();
    for (const token of options.query.match(/(?:[^\s"\\]|\\.|"(?:\\.|[^"\\])*")+/g) ?? []) {
      const match = token.replace(/^\(+|\)+$/g, '').match(/^(-?)project:(?:"([^"]*)"|([^"]+))$/i);
      if (match && ((!match[1] && (match[2] ?? match[3]) !== options.project) ||
          (match[1] && (match[2] ?? match[3]) === options.project))) {
        throw new CrError('INVALID_ARGUMENT', 'Gerrit query conflicts with the requested project.');
      }
    }
  }
  return host.origin;
}

export async function queryGerrit(options, dependencies = {}) {
  const host = validateGerritOptions(options);
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const log = dependencies.log ?? (async () => {});
  const limit = options.limit ?? 1000, items = [], seen = new Set();
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const top = Math.min(100, limit - items.length);
    const url = new URL(`${host}/changes/`);
    url.searchParams.set('q', `${options.query}${options.project ? ` project:${JSON.stringify(options.project)}` : ''}`);
    url.searchParams.set('n', String(top));
    url.searchParams.set('S', String(offset));
    url.searchParams.set('o', 'DETAILED_ACCOUNTS');
    const started = Date.now();
    await log('http.start', { phase: 'gerrit-fetch', count: page + 1 });
    let rows;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'function' ||
          !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        invalid('Gerrit returned an invalid HTTP response.');
      }
      await log('http.response', { phase: 'gerrit-fetch', httpStatus: response.status, durationMs: Date.now() - started });
      if (!response.ok) throw new CrError('PROVIDER_HTTP',
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? `Gerrit returned HTTP ${response.status}.` : 'Gerrit returned an HTTP failure.');
      const body = await response.text();
      if (typeof body !== 'string') invalid('Gerrit response body is not text.');
      try { rows = JSON.parse(body.replace(/^\)\]\}'(?:\r?\n)?/, '')); }
      catch { invalid('Gerrit returned invalid JSON.'); }
    } catch (error) {
      if (error.code === 'LOG_WRITE_FAILED') throw error;
      const failure = error instanceof CrError ? error :
        new CrError('PROVIDER_NETWORK', 'Gerrit request failed or timed out. Check network connectivity.');
      await log('http.failed', { phase: 'gerrit-fetch', code: failure.code, durationMs: Date.now() - started, outcome: 'failed' });
      throw failure;
    }
    if (!Array.isArray(rows)) invalid('Gerrit changes: expected an array.');
    if (rows.length > top) invalid('Gerrit exceeded the requested page size.');
    for (const row of rows) {
      object(row);
      const key = id(row._number);
      if (seen.has(key)) invalid('Gerrit returned duplicate items; pagination did not advance.');
      seen.add(key);
      boolean(row._more_changes);
      if (options.project && row.project !== options.project) invalid('Gerrit returned a change outside the requested project.');
    }
    items.push(...rows.map(row => item(row, host)));
    await log('gerrit.page', { phase: 'gerrit-normalize', count: rows.length, outcome: 'success' });
    if (rows.at(-1)?._more_changes !== true) return { items, truncated: false };
    if (items.length >= limit) return { items, truncated: true };
    offset += rows.length;
  }
  return { items, truncated: true };
}
