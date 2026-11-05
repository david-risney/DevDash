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
