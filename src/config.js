import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import Ajv from 'ajv';
import schema from '../config.schema.json' with { type: 'json' };
import presentationSchema from '../presentation.schema.json' with { type: 'json' };
import { DevDashError } from './errors.js';
import { readJson, withLock, writeJson } from './storage.js';
import { compileFilter } from './filters.js';
import { providerProfile } from './query.js';

const validate = new Ajv({ allErrors: true, strict: false }).addSchema(presentationSchema).compile(schema);
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function paths(options = {}, env = process.env) {
  const home = resolve(options.home ?? env.DEVDASH_HOME ?? join(homedir(), '.devdash'));
  return {
    home,
    config: resolve(options.config ?? join(home, 'config.json')),
    userConfig: resolve(options['user-config'] ?? join(home, 'user.config.json')),
    cache: join(home, 'cache'),
    logs: join(home, 'logs'),
  };
}

export function validateName(name) {
  if (typeof name !== 'string' || !namePattern.test(name)) {
    throw new DevDashError('INVALID_PROFILE', 'Profile names must be 1-80 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.');
  }
}

function httpsUrl(value, label, originOnly = false) {
  let url;
  try { url = new URL(value); } catch {
    throw new DevDashError('INVALID_CONFIG', `${label} must be an HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== '/')) {
    throw new DevDashError('INVALID_CONFIG', `${label} must be an HTTPS ${originOnly ? 'origin' : 'URL'} without credentials, query, or fragment.`);
  }
}

export function validateConfig(config) {
  if (!validate(config)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new DevDashError('INVALID_CONFIG', `Configuration does not match config.schema.json: ${details}`);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const queries = isGroupedProfile(profile) ? Object.entries(profile.queries) : [[null, profile]];
    for (const [queryName, query] of queries) {
      validateQueryValues(query, queryName === null ? name : `${name}.queries.${queryName}`);
    }
  }
  return config;
}

function validateQueryValues(query, label) {
  for (const [key, value] of Object.entries(query)) {
    if (key === 'filter') continue;
    if (typeof value === 'string' && (!value.trim() || /[\u0000-\u001f]/.test(value))) {
      // WIQL commonly uses newlines; other control characters are never valid arguments.
      if (key !== 'query' || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        throw new DevDashError('INVALID_CONFIG', `${label}.${key} contains an empty value or invalid control characters.`);
      }
    }
  }
  if (query.provider === 'ado') httpsUrl(query.organization, `${label}.organization`);
  if (query.provider === 'chromium' && query.host) httpsUrl(query.host, `${label}.host`, true);
  try { providerProfile(query); } catch (error) {
    if (!(error instanceof DevDashError) || error.code !== 'INVALID_PROFILE') throw error;
    throw new DevDashError('INVALID_CONFIG', error.message);
  }
  compileFilter(query.filter, query);
}

export function isGroupedProfile(profile) {
  return Object.hasOwn(profile, 'queries');
}

export function effectiveProfile(profile) {
  if (isGroupedProfile(profile)) {
    return {
      refreshSeconds: profile.refreshSeconds,
      ...(profile.presentation === undefined ? {} : { presentation: profile.presentation }),
      queries: Object.fromEntries(Object.entries(profile.queries).map(([name, query]) =>
        [name, { limit: 1000, refreshSeconds: profile.refreshSeconds, ...query }])),
    };
  }
  return { limit: 1000, ...profile };
}

export async function loadConfig(path) {
  const config = await readJson(path);
  if (config === null) {
    throw new DevDashError('CONFIG_NOT_FOUND', `No configuration at ${path}. Run devdash init or profile set.`);
  }
  return validateConfig(config);
}

export async function updateConfig(path, update) {
  return withLock(path, async (checkLock) => {
    const current = await readJson(path);
    const config = current === null ? { version: 1, profiles: {} } : validateConfig(current);
    const result = await update(config);
    validateConfig(config);
    checkLock();
    await writeJson(path, config);
    return result;
  });
}
