import { DevDashError } from '../errors.js';

/**
 * @typedef {{items: Object[], truncated: boolean}} QueryResult
 * @typedef {Object} QueryContext
 * @property {function(string, string[], Object=): Promise<unknown>} runJson
 * @typedef {Object} ProviderAdapter
 * @property {string} id Configuration provider identifier.
 * @property {string} cli External command used by this adapter.
 * @property {readonly string[]} resources Supported query resources.
 * @property {function(Object, QueryContext): Promise<QueryResult>} query
 */

/** @param {ProviderAdapter[]} adapters */
export function createProviderRegistry(adapters) {
  if (!Array.isArray(adapters)) {
    throw new DevDashError('INVALID_PROVIDER', 'Provider registry requires an array of adapters.');
  }
  const entries = [];
  const ids = new Set();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.id) ||
        typeof adapter.cli !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.cli) || typeof adapter.query !== 'function' ||
        !Array.isArray(adapter.resources) || !adapter.resources.length ||
        adapter.resources.some(resource => !['bugs', 'prs', 'cls'].includes(resource)) ||
        ids.has(adapter.id)) {
      throw new DevDashError('INVALID_PROVIDER', 'Provider adapters require a unique ID, CLI, resources, and query function.');
    }
    ids.add(adapter.id);
    entries.push([adapter.id, Object.freeze({ ...adapter, resources: Object.freeze([...adapter.resources]) })]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nullableText = value => value === null || nonempty(value);
const strings = value => Array.isArray(value) && value.every(nonempty);
const timestamp = value => value === null ||
  (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const itemKeys = new Set([
  'provider', 'kind', 'id', 'title', 'state', 'url', 'repository', 'author',
  'assignees', 'labels', 'createdAt', 'updatedAt', 'draft', 'providerData',
  'priority', 'severity', 'type',
  'sourceBranch', 'targetBranch', 'reviewers',
]);

function validProviderData(profile, data) {
  if (!isObject(data)) return false;
  const allowed = profile.provider === 'github' ? ['nodeId']
    : profile.provider === 'ado' ? (profile.resource === 'prs' ? ['mergeStatus', 'reviewerVotes'] : [])
    : profile.resource === 'bugs' ? ['component'] : ['changeId'];
  if (Object.keys(data).some(key => !allowed.includes(key))) return false;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'reviewerVotes') {
      if (!Array.isArray(value) || value.some(entry => !isObject(entry) ||
          Object.keys(entry).length !== 3 ||
          !nullableText(entry.reviewer) ||
          !(entry.vote === null || [-10, -5, 0, 5, 10].includes(entry.vote)) ||
          !(entry.required === null || typeof entry.required === 'boolean'))) return false;
    } else if (['component', 'mergeStatus'].includes(key) ? !nullableText(value) : !nonempty(value)) {
      return false;
    }
  }
  return true;
}

export function validateQueryResult(profile, result) {
  const invalid = () => {
    throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'Provider returned an invalid normalized query result.');
  };
  if (!isObject(result) || !Array.isArray(result.items) || typeof result.truncated !== 'boolean' ||
      result.items.length > profile.limit) invalid();
  const kind = { bugs: 'bug', prs: 'pr', cls: 'cl' }[profile.resource];
  const seen = new Set();
  for (const item of result.items) {
    if (!isObject(item) || Object.keys(item).some(key => !itemKeys.has(key)) ||
        item.provider !== profile.provider || item.kind !== kind ||
        typeof item.id !== 'string' || !/^[1-9]\d*$/.test(item.id) || seen.has(item.id) ||
        !nonempty(item.title) || !nonempty(item.state) || !nullableText(item.repository) ||
        !nullableText(item.author) || !strings(item.assignees) || !strings(item.labels) ||
        !timestamp(item.createdAt) || !timestamp(item.updatedAt) ||
        !(item.draft === null || typeof item.draft === 'boolean') ||
        !validProviderData(profile, item.providerData)) invalid();
    seen.add(item.id);
    let url;
    try { url = new URL(item.url); } catch { invalid(); }
    if (typeof item.url !== 'string' || url.protocol !== 'https:' || url.username || url.password) invalid();
    if (Object.hasOwn(item, 'sourceBranch') &&
        (profile.provider !== 'ado' || kind !== 'pr' || !nullableText(item.sourceBranch))) invalid();
    if (Object.hasOwn(item, 'targetBranch') &&
        (!((profile.provider === 'ado' && kind === 'pr') || (profile.provider === 'chromium' && kind === 'cl')) ||
          !nullableText(item.targetBranch))) invalid();
    if (Object.hasOwn(item, 'reviewers') &&
        (profile.provider !== 'ado' || kind !== 'pr' || !strings(item.reviewers))) invalid();
    for (const field of ['priority', 'severity', 'type']) {
      if (Object.hasOwn(item, field) && (kind !== 'bug' || !nullableText(item[field]))) invalid();
    }
  }
  return { items: result.items, truncated: result.truncated };
}
