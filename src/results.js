import { createHash } from 'node:crypto';
import { DevDashError } from './errors.js';

export const RESULT_FIELDS = [
  'provider', 'kind', 'id', 'title', 'state', 'url', 'repository', 'author', 'assignees', 'labels',
  'createdAt', 'updatedAt', 'draft', 'priority', 'severity', 'type', 'sourceBranch', 'targetBranch',
  'reviewers', 'providerData', 'identities', 'labelDetails',
];
const REQUIRED_FIELDS = ['provider', 'kind', 'id', 'url'];
const MAX_PAGE_BYTES = 768 * 1024;
const scopeHash = value => createHash('sha256').update(value).digest('hex');
const invalid = message => { throw new DevDashError('INVALID_ARGUMENT', message); };

export function pageOptions({ pageSize = 50, cursor, fields } = {}, scope) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) invalid('pageSize must be an integer from 1 to 200.');
  if (fields !== undefined && (!Array.isArray(fields) || !fields.length || fields.length > RESULT_FIELDS.length ||
      fields.some(key => !RESULT_FIELDS.includes(key)) || new Set(fields).size !== fields.length)) {
    invalid('fields must be a nonempty array of unique normalized result field names.');
  }
  const projection = fields ? [...new Set([...REQUIRED_FIELDS, ...fields])].sort() : null;
  const scopeId = scopeHash(scope);
  let token;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid('Invalid page cursor.');
    try { token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalid('Invalid page cursor.'); }
    if (!token || token.version !== 1 || token.scope !== scopeId ||
        typeof token.revision !== 'string' || !/^[a-f0-9]{64}$/.test(token.revision) ||
        !Number.isInteger(token.offset) || token.offset < 1 || token.offset > 20000 ||
        token.size !== pageSize || JSON.stringify(token.fields) !== JSON.stringify(projection)) {
      invalid('Cursor scope, page size, or field projection does not match this request.');
    }
  }
  return { pageSize, fields: projection, scopeId, token };
}

export function resultPage(result, options) {
  const { pageSize, fields, scopeId, token } = options;
  if (token && token.revision !== result.cacheRevision) {
    throw new DevDashError('CURSOR_EXPIRED', 'The cached snapshot changed. Restart paging without a cursor.');
  }
  const offset = token?.offset ?? 0;
  if (offset > result.items.length) invalid('Page cursor offset exceeds the snapshot size.');
  const selected = result.items.slice(offset, offset + pageSize).map(item =>
    fields ? Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) : item);
  const page = count => ({
    ...result,
    items: selected.slice(0, count),
    page: {
      offset, size: count, total: result.items.length, fields,
      nextCursor: offset + count < result.items.length
        ? Buffer.from(JSON.stringify({
          version: 1, scope: scopeId, revision: result.cacheRevision, offset: offset + count, size: pageSize, fields,
        })).toString('base64url')
        : null,
    },
  });
  let count = selected.length;
  let output = page(count);
  while (count > 0 && Buffer.byteLength(JSON.stringify(output)) > MAX_PAGE_BYTES) {
    output = page(--count);
  }
  if ((selected.length && !count) || Buffer.byteLength(JSON.stringify(output)) > MAX_PAGE_BYTES) {
    throw new DevDashError('MESSAGE_TOO_LARGE', 'One result exceeds the page byte budget. Request a smaller field projection.');
  }
  return output;
}
