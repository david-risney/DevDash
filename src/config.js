import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import schema from '../config.schema.json' with { type: 'json' };
import presentationSchema from '../presentation.schema.json' with { type: 'json' };
import { DevDashError } from './errors.js';
import { readJson, withLock, writeJson } from './storage.js';
import { compileFilter } from './filters.js';
import { providerProfile } from './query.js';
import { isRemoteProfile, validateRemoteProfile } from './profile-templates.js';

const validate = new Ajv({ allErrors: true, strict: false }).addSchema(presentationSchema).compile(schema);
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Preserve presentation scope order without exposing source layers in JSON output.
export const configurationLayers = Symbol('configurationLayers');

export function configSources(value) {
  const sources = Array.isArray(value) ? value : [value];
  if (!sources.length) throw new DevDashError('INVALID_ARGUMENT', 'Specify at least one configuration source.');
  return sources.map(source => {
    if (typeof source !== 'string' || !source.trim() || /[\u0000-\u001f\u007f]/u.test(source)) {
      throw new DevDashError('INVALID_ARGUMENT', 'Configuration sources must be file paths or HTTP(S) URLs.');
    }
    if (!/^[A-Za-z]:[\\/]/u.test(source) && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(source)) {
      let url;
      try { url = new URL(source); } catch {
        throw new DevDashError('INVALID_ARGUMENT', 'Invalid configuration URL.');
      }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new DevDashError('INVALID_ARGUMENT', 'Configuration URLs must use HTTP(S) without embedded credentials or fragments.');
      }
      return url.href;
    }
    return resolve(source);
  });
}

export function paths(options = {}, env = process.env) {
  const home = resolve(options.home ?? env.DEVDASH_HOME ?? join(homedir(), '.devdash'));
  const configs = configSources(options.config ?? join(home, 'config.json'));
  const config = configs.length === 1 && !/^https?:/u.test(configs[0]) ? configs[0]
    : join(home, 'cache', 'config-stacks', `${createHash('sha256').update(JSON.stringify(configs)).digest('hex')}.json`);
  return {
    home,
    config, configs,
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
    if (isRemoteProfile(profile)) {
      validateRemoteProfile(profile);
      continue;
    }
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
      ...(profile.remoteUrls === undefined ? {} : { remoteUrls: profile.remoteUrls }),
      ...(profile.presentation === undefined ? {} : { presentation: profile.presentation }),
      queries: Object.fromEntries(Object.entries(profile.queries).map(([name, query]) =>
        [name, { limit: 1000, refreshSeconds: profile.refreshSeconds, ...query }])),
    };
  }
  return { limit: 1000, ...profile };
}

function mergeConfig(base, override) {
  if (!object(override)) return structuredClone(override);
  return Object.fromEntries([...new Set([...Object.keys(object(base) ? base : {}), ...Object.keys(override)])].map(key => [
    key, Object.hasOwn(override, key) ? mergeConfig(base?.[key], override[key]) : structuredClone(base[key]),
  ]));
}

async function remoteConfig(url, fetch) {
  const limit = 1024 * 1024;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DevDashError('CONFIG_FETCH_FAILED', `Configuration retrieval failed (HTTP ${response.status}).`);
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new DevDashError('CONFIG_TOO_LARGE', 'Remote configuration exceeds 1 MiB.');
    }
    if (!response.body) throw new DevDashError('CONFIG_FETCH_FAILED', 'Configuration response has no body.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new DevDashError('CONFIG_TOO_LARGE', 'Remote configuration exceeds 1 MiB.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '')); } catch {
      throw new DevDashError('INVALID_JSON', 'Remote configuration must contain valid JSON.');
    }
  } catch (error) {
    if (error instanceof DevDashError) throw error;
    throw new DevDashError('CONFIG_FETCH_FAILED', 'Configuration retrieval failed or timed out. Use a direct JSON URL; redirects are not followed.', { cause: error });
  }
}

export async function loadConfig(sources, { required = true, fetch = globalThis.fetch } = {}) {
  let config = { version: 1, profiles: {} };
  const layers = [];
  const normalized = configSources(sources);
  for (const source of normalized) {
    const remote = /^https?:/u.test(source);
    const layer = remote ? await remoteConfig(source, fetch) : await readJson(source);
    if (layer === null && !remote) {
      if (!required && normalized.length === 1) return null;
      throw new DevDashError('CONFIG_NOT_FOUND', 'A configuration file does not exist. Run devdash init or specify an existing --config source.');
    }
    if (!object(layer) || (Object.hasOwn(layer, 'version') && layer.version !== 1)) {
      throw new DevDashError('INVALID_CONFIG', 'Configuration sources must be JSON objects using version 1.');
    }
    config = mergeConfig(config, layer);
    layers.push(layer);
  }
  validateConfig(config);
  return Object.defineProperty(config, configurationLayers, { value: layers });
}

export async function updateConfig(path, update) {
  return withLock(path, async (checkLock) => {
    const current = await readJson(path);
    const config = current === null ? { version: 1, profiles: {} }
      : validateConfig(mergeConfig({ version: 1, profiles: {} }, current));
    const result = await update(config);
    validateConfig(config);
    checkLock();
    await writeJson(path, config);
    return result;
  });
}
