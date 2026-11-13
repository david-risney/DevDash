import { DevDashError } from '../errors.js';

/**
 * @typedef {{items: Object[], truncated: boolean}} QueryResult
 * @typedef {Object} QueryContext
 * @property {function(string, string[], Object=): Promise<unknown>} runJson
 * @property {typeof globalThis.fetch} fetch Credential-free HTTP transport for explicit anonymous queries.
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
  'identities', 'labelDetails',
]);

const exactKeys = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const httpsReference = value => {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};
const detailedIdentity = value => exactKeys(value, ['id', 'login', 'displayName', 'avatarUrl']) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, entry]) => key === 'avatarUrl' ? httpsReference(entry) : nonempty(entry));
const identities = value => Array.isArray(value) && value.every(detailedIdentity);

function validProviderData(profile, data) {
  if (!isObject(data)) return false;
  const allowed = profile.provider === 'github' ? ['nodeId', 'commentCount',
    ...(profile.resource === 'prs' ? ['merged', 'mergedAt', 'requestedReviewers', 'requestedTeams'] : ['closureReason'])]
    : profile.provider === 'ado' ? (profile.resource === 'prs'
      ? ['mergeStatus', 'reviewerVotes', ...(profile.include ? ['properties'] : [])] : [])
    : profile.resource === 'bugs' ? ['component'] : ['changeId', 'codeReviewScores', 'insertions', 'deletions', 'unresolvedCommentCount'];
  if (Object.keys(data).some(key => !allowed.includes(key))) return false;
  if (profile.include && !Object.hasOwn(data, 'properties')) return false;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'properties') {
      if (!isObject(value) || Object.entries(value).some(([name, entry]) =>
        !profile.include.properties.includes(name) || !exactKeys(entry, ['$type', '$value']) ||
        Object.keys(entry).length !== 2 || !nonempty(entry.$type) ||
        !(entry.$value === null || ['string', 'boolean'].includes(typeof entry.$value) ||
          (typeof entry.$value === 'number' && Number.isFinite(entry.$value)))) ||
        Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return false;
    } else if (key === 'reviewerVotes') {
      if (!Array.isArray(value) || value.some(entry => !isObject(entry) ||
          Object.keys(entry).length !== 3 ||
          !nullableText(entry.reviewer) ||
          !(entry.vote === null || [-10, -5, 0, 5, 10].includes(entry.vote)) ||
          !(entry.required === null || typeof entry.required === 'boolean'))) return false;
    } else if (['commentCount', 'insertions', 'deletions', 'unresolvedCommentCount'].includes(key)) {
      if (!count(value)) return false;
    } else if (key === 'codeReviewScores') {
      if (!Array.isArray(value) || value.some(entry =>
        !exactKeys(entry, ['reviewer', 'score']) || Object.keys(entry).length !== 2 ||
        !nullableText(entry.reviewer) || !Number.isSafeInteger(entry.score) || entry.score < -2 || entry.score > 2)) return false;
    } else if (key === 'merged') {
      if (typeof value !== 'boolean') return false;
    } else if (key === 'mergedAt') {
      if (!timestamp(value)) return false;
    } else if (key === 'closureReason') {
      if (value !== null && !['completed', 'not_planned', 'reopened', 'duplicate'].includes(value)) return false;
    } else if (['requestedReviewers', 'requestedTeams'].includes(key)) {
      if (!strings(value)) return false;
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
    const identity = profile.provider === 'github'
      ? `${typeof item?.repository === 'string' ? item.repository.toLowerCase() : ''}\0${item?.id}` : item?.id;
    if (!isObject(item) || Object.keys(item).some(key => !itemKeys.has(key)) ||
        item.provider !== profile.provider || item.kind !== kind ||
        typeof item.id !== 'string' || !/^[1-9]\d*$/.test(item.id) || seen.has(identity) ||
        !nonempty(item.title) || !nonempty(item.state) || !nullableText(item.repository) ||
        !nullableText(item.author) || !strings(item.assignees) || !strings(item.labels) ||
        !timestamp(item.createdAt) || !timestamp(item.updatedAt) ||
        !(item.draft === null || typeof item.draft === 'boolean') ||
        !validProviderData(profile, item.providerData)) invalid();
    seen.add(identity);
    let url;
    try { url = new URL(item.url); } catch { invalid(); }
    if (typeof item.url !== 'string' || url.protocol !== 'https:' || url.username || url.password) invalid();
    if (Object.hasOwn(item, 'sourceBranch') &&
        (profile.provider !== 'ado' || kind !== 'pr' || !nullableText(item.sourceBranch))) invalid();
    if (Object.hasOwn(item, 'targetBranch') &&
        (!((profile.provider === 'ado' && kind === 'pr') || (profile.provider === 'chromium' && kind === 'cl')) ||
          !nullableText(item.targetBranch))) invalid();
    if (Object.hasOwn(item, 'reviewers') &&
        (!['ado', 'github'].includes(profile.provider) || kind !== 'pr' || !strings(item.reviewers))) invalid();
    if (Object.hasOwn(item, 'identities')) {
      const metadata = item.identities;
      if (!exactKeys(metadata, ['author', 'assignees', 'reviewers']) || !Object.keys(metadata).length) invalid();
      if (Object.hasOwn(metadata, 'author') && !detailedIdentity(metadata.author)) invalid();
      for (const field of ['assignees', 'reviewers']) {
        if (Object.hasOwn(metadata, field) && (!identities(metadata[field]) ||
            (field === 'reviewers' && !['pr', 'cl'].includes(kind)))) invalid();
      }
    }
    if (Object.hasOwn(item, 'labelDetails') &&
        (profile.provider !== 'github' || !Array.isArray(item.labelDetails) ||
          item.labelDetails.some(label => !exactKeys(label, ['name', 'color']) ||
            !nonempty(label.name) || !item.labels.includes(label.name) ||
            (Object.hasOwn(label, 'color') && !/^#[0-9a-f]{6}$/i.test(label.color))))) invalid();
    for (const field of ['priority', 'severity', 'type']) {
      if (Object.hasOwn(item, field) && (kind !== 'bug' || !nullableText(item[field]))) invalid();
    }
  }
  return { items: result.items, truncated: result.truncated };
}
