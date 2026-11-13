import { DevDashError } from '../errors.js';

export const PAGE_SIZE = 100;
export const MAX_PAGES = 200;

export function invalid(message) {
  throw new DevDashError('PROVIDER_RESPONSE', message);
}

export function object(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${context}: expected an object.`);
  return value;
}

export function text(value, context) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${context}: expected a nonempty string.`);
  return value;
}

export function id(value, context) {
  if (!((Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))) {
    invalid(`${context}: expected a positive numeric ID.`);
  }
  return String(value);
}

export function array(value, context) {
  if (!Array.isArray(value)) invalid(`${context}: expected an array.`);
  return value;
}

export function optionalText(value, context) {
  return value == null || value === '' ? null : text(value, context);
}

export function identity(value, keys) {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  object(value, 'Identity');
  for (const key of keys) {
    if (value[key] != null && value[key] !== '') {
      return key === '_account_id' ? id(value[key], 'Account ID') : optionalText(value[key], 'Identity');
    }
  }
  return null;
}

export function date(value) {
  if (value == null) return null;
  text(value, 'Timestamp');
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid('Timestamp: expected a valid date with a UTC offset.');
  }
  return new Date(value).toISOString();
}

export function boolean(value, context) {
  if (value == null) return null;
  if (typeof value !== 'boolean') invalid(`${context}: expected a boolean.`);
  return value;
}

export function uniquePage(rows, seen, getId) {
  for (const row of rows) {
    object(row, 'Result item');
    const key = getId(row);
    if (seen.has(key)) invalid('Provider returned duplicate items; pagination did not advance.');
    seen.add(key);
  }
}

export function httpsReference(value, context) {
  text(value, context);
  let url;
  try { url = new URL(value); } catch { invalid(`${context}: expected an HTTPS reference.`); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid(`${context}: expected an HTTPS reference.`);
  return value;
}

// Keep display metadata separate from the stable strings used by filters and callers.
export function identityDetails(value, provider) {
  if (value == null || typeof value === 'string') return null;
  object(value, 'Identity');
  const fields = provider === 'ado'
    ? { id: 'id', uniqueName: 'login', displayName: 'displayName', imageUrl: 'avatarUrl' }
    : { id: 'id', login: 'login', name: 'displayName', avatar_url: 'avatarUrl' };
  const result = {};
  for (const [source, target] of Object.entries(fields)) {
    if (value[source] == null) continue;
    result[target] = target === 'avatarUrl' ? httpsReference(value[source], 'Identity avatar')
      : target === 'id' && provider === 'github' ? id(value[source], 'Identity ID')
      : text(value[source], 'Identity metadata');
  }
  return Object.keys(result).some(key => key !== 'login') ? result : null;
}

export function identityMetadata(author, assignees, provider, reviewers = []) {
  const authorIdentity = identityDetails(author, provider);
  const assigneeIdentities = assignees.map(person => identityDetails(person, provider)).filter(Boolean);
  const reviewerIdentities = reviewers.map(person => identityDetails(person, provider)).filter(Boolean);
  const identities = {
    ...(authorIdentity ? { author: authorIdentity } : {}),
    ...(assigneeIdentities.length ? { assignees: assigneeIdentities } : {}),
    ...(reviewerIdentities.length ? { reviewers: reviewerIdentities } : {}),
  };
  return Object.keys(identities).length ? { identities } : {};
}

export function count(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${context}: expected a nonnegative integer.`);
  return value;
}
