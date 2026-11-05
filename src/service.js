import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { effectiveProfile, isGroupedProfile, loadConfig, paths, updateConfig, validateConfig, validateName } from './config.js';
import { DevDashError, errorJson } from './errors.js';
import { readJson, withLock, writeJson } from './storage.js';
import { queryProfile, queryWebUrl } from './providers.js';
import { Diagnostics, diagnosticCode } from './diagnostics.js';
import { compileFilter, filterItems } from './filters.js';
import { providerProfile } from './query.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function selectedQuery(profile, name) {
  if (name === undefined) {
    if (isGroupedProfile(profile)) throw new DevDashError('INVALID_ARGUMENT', 'A named query is required for this operation.');
    return profile;
  }
  validateName(name);
  if (!isGroupedProfile(profile)) {
    throw new DevDashError('INVALID_ARGUMENT', '--query requires a profile containing named queries.');
  }
  if (!Object.hasOwn(profile.queries, name)) {
    throw new DevDashError('QUERY_NOT_FOUND', `No query named "${name}" in this profile.`);
  }
  return profile.queries[name];
}

function slots(profile) {
  return profile && isGroupedProfile(profile) ? Object.keys(profile.queries) : profile ? [undefined] : [];
}

export function failedProfiles(results) {
  return results.filter((result) => result.error || result.failed > 0).length;
}

export class DevDash {
  constructor(options = {}, dependencies = {}) {
    this.paths = paths(options, dependencies.env);
    this.query = dependencies.queryProfile ?? queryProfile;
    this.now = dependencies.now ?? Date.now;
    this.diagnostics = dependencies.diagnostics ?? new Diagnostics(this.paths);
  }

  async init() {
    return this.diagnostics.run('config.init', {}, () => this.createConfig());
  }

  async createConfig() {
    await withLock(this.paths.config, async (checkLock) => {
      if (await readJson(this.paths.config) !== null) {
        throw new DevDashError('CONFIG_EXISTS', `Configuration already exists at ${this.paths.config}.`);
      }
      checkLock();
      await writeJson(this.paths.config, { version: 1, profiles: {} });
    });
    return { schemaVersion: 1, config: this.paths.config };
  }

  async config() {
    return loadConfig(this.paths.config);
  }

  async list() {
    const config = await this.config();
    return {
      schemaVersion: 1,
      profiles: Object.entries(config.profiles).map(([name, profile]) => ({ name, ...effectiveProfile(profile) })),
    };
  }

  async profile(name) {
    validateName(name);
    const config = await this.config();
    if (!Object.hasOwn(config.profiles, name)) {
      throw new DevDashError('PROFILE_NOT_FOUND', `No profile named "${name}".`);
    }
    return effectiveProfile(config.profiles[name]);
  }

  async setProfile(name, profile) {
    return this.diagnostics.run('profile.set', { profile: name }, () => this.saveProfile(name, profile));
  }

  async saveProfile(name, profile) {
    validateName(name);
    validateConfig({ version: 1, profiles: { [name]: profile } });
    const previous = await updateConfig(this.paths.config, (config) => {
      const old = Object.hasOwn(config.profiles, name) ? effectiveProfile(config.profiles[name]) : null;
      config.profiles[name] = profile;
      return old;
    });
    const nextSlots = new Set(slots(profile));
    for (const queryName of slots(previous)) {
      if (!nextSlots.has(queryName)) await this.clearCacheFile(name, queryName);
    }
    return { schemaVersion: 1, name, profile: effectiveProfile(profile) };
  }

  async removeProfile(name) {
    return this.diagnostics.run('profile.remove', { profile: name }, () => this.deleteProfile(name));
  }

  async deleteProfile(name) {
    validateName(name);
    const previous = await updateConfig(this.paths.config, (config) => {
      if (!Object.hasOwn(config.profiles, name)) {
        throw new DevDashError('PROFILE_NOT_FOUND', `No profile named "${name}".`);
      }
      const old = effectiveProfile(config.profiles[name]);
      delete config.profiles[name];
      return old;
    });
    for (const queryName of slots(previous)) await this.clearCacheFile(name, queryName);
    return { schemaVersion: 1, removed: name };
  }

  cachePath(name, queryName) {
    validateName(name);
    if (queryName !== undefined) validateName(queryName);
    return join(this.paths.cache, `${hash(`${this.paths.config}\0${name}${queryName === undefined ? '' : `\0${queryName}`}`)}.json`);
  }

  fingerprint(profile) {
    const { presentation, ...definition } = profile;
    return hash('normalized-items-v2\0' + JSON.stringify(canonical(definition)));
  }

  async readCache(name, profile, queryName) {
    const path = this.cachePath(name, queryName);
    const entry = await readJson(path);
    if (entry === null) return null;
    if (entry.schemaVersion !== 1 || typeof entry.fingerprint !== 'string'
        || entry.profile !== name || entry.query !== queryName || !Array.isArray(entry.items)
        || typeof entry.truncated !== 'boolean' || !Number.isFinite(Date.parse(entry.fetchedAt))
        || !Number.isFinite(Date.parse(entry.expiresAt))) {
      throw new DevDashError('INVALID_CACHE', `Invalid cache at ${path}. Run devdash cache clear ${name}.`);
    }
    if (entry.fingerprint !== this.fingerprint(profile)) return null;
    return entry;
  }

  result(entry, fromCache, profile) {
    const { fingerprint, ...result } = entry;
    return { ...result, queryUrl: queryWebUrl(profile), stale: this.now() >= Date.parse(entry.expiresAt), fromCache };
  }

  async get(name, { refresh = false, cachedOnly = false, due = false, query } = {}) {
    return this.diagnostics.run('profile.get', { profile: name, refresh, cachedOnly, due, queryName: query }, () =>
      this.getSnapshot(name, { refresh, cachedOnly, due, query }));
  }

  async getSnapshot(name, options = {}) {
    const { refresh, cachedOnly, query } = options;
    if (refresh && cachedOnly) {
      throw new DevDashError('INVALID_ARGUMENT', 'refresh and cachedOnly cannot be combined.');
    }
    const profile = await this.profile(name);
    if (query !== undefined || !isGroupedProfile(profile)) {
      return this.getQuerySnapshot(name, selectedQuery(profile, query), query, options);
    }
    const queries = {};
    for (const [queryName, definition] of Object.entries(profile.queries)) {
      try {
        queries[queryName] = await this.diagnostics.run('query.get', { queryName }, () =>
          this.getQuerySnapshot(name, definition, queryName, options));
      } catch (error) {
        queries[queryName] = {
          profile: name, query: queryName, provider: definition.provider, resource: definition.resource,
          queryUrl: queryWebUrl(definition),
          ...errorJson(error),
        };
      }
    }
    const results = Object.values(queries);
    return {
      schemaVersion: 1,
      profile: name,
      queries,
      failed: results.filter((result) => result.error).length,
      stale: results.some((result) => result.error || result.stale),
      fromCache: results.every((result) => result.fromCache === true),
    };
  }

  async assertCurrentQuery(name, profile, queryName) {
    let current;
    try {
      current = selectedQuery(await this.profile(name), queryName);
    } catch (error) {
      if (!(error instanceof DevDashError) || !['PROFILE_NOT_FOUND', 'QUERY_NOT_FOUND', 'INVALID_ARGUMENT'].includes(error.code)) throw error;
      throw new DevDashError('PROFILE_CHANGED', `Profile "${name}" or its selected query was removed or replaced during the request.`);
    }
    if (this.fingerprint(current) !== this.fingerprint(profile)) {
      throw new DevDashError('PROFILE_CHANGED', `Profile "${name}" or its selected query changed during the request; results were not cached.`);
    }
  }

  async getQuerySnapshot(name, profile, queryName, { refresh = false, cachedOnly = false, due = false } = {}) {
    const filter = compileFilter(profile.filter, profile);
    const cached = await this.readCache(name, profile, queryName);
    const metadata = { provider: profile.provider, resource: profile.resource };
    await this.diagnostics.log('cache.check', {
      ...metadata,
      outcome: cached ? (this.now() >= Date.parse(cached.expiresAt) ? 'expired' : 'fresh') : 'miss',
    });
    if (cachedOnly) {
      if (!cached) throw new DevDashError('CACHE_MISS', `No matching cache for "${name}"${queryName ? ` query "${queryName}"` : ''}. Run devdash refresh ${name}.`);
      return this.result(cached, true, profile);
    }
    if (cached && (!refresh || due) && this.now() < Date.parse(cached.expiresAt)) {
      return this.result(cached, true, profile);
    }
    await this.diagnostics.log('cache.lock.wait', metadata);
    return withLock(this.cachePath(name, queryName), async (checkLock) => {
      await this.diagnostics.log('cache.lock.acquired', metadata);
      await this.assertCurrentQuery(name, profile, queryName);
      const existing = await this.readCache(name, profile, queryName);
      if (existing && (!refresh || due) && this.now() < Date.parse(existing.expiresAt)) {
        return this.result(existing, true, profile);
      }
      let response;
      try {
        response = await this.diagnostics.run('provider.query', metadata, () =>
          this.query(providerProfile(profile), { log: (event, data) => this.diagnostics.log(event, data) }));
      } catch (error) {
        if (error.code !== 'LOG_WRITE_FAILED') {
          await this.diagnostics.log('cache.preserved', {
            ...metadata, code: diagnosticCode(error), outcome: existing ? 'retained' : 'absent',
          });
        }
        throw error;
      }
      if (!response || !Array.isArray(response.items) || typeof response.truncated !== 'boolean') {
        throw new DevDashError('INVALID_PROVIDER_RESPONSE', `${profile.provider} did not return items and truncation metadata.`);
      }
      const items = filterItems(response.items, filter);
      if (profile.filter !== undefined) {
        await this.diagnostics.log('filter.complete', {
          ...metadata, sourceCount: response.items.length, count: items.length,
          removedCount: response.items.length - items.length,
        });
      }
      const fetchedAt = this.now();
      const entry = {
        schemaVersion: 1,
        fingerprint: this.fingerprint(profile),
        profile: name,
        ...(queryName === undefined ? {} : { query: queryName }),
        provider: profile.provider,
        resource: profile.resource,
        fetchedAt: new Date(fetchedAt).toISOString(),
        expiresAt: new Date(fetchedAt + profile.refreshSeconds * 1000).toISOString(),
        truncated: response.truncated,
        items,
      };
      await this.assertCurrentQuery(name, profile, queryName);
      checkLock();
      await writeJson(this.cachePath(name, queryName), entry);
      await this.diagnostics.log('cache.write', { ...metadata, count: entry.items.length, truncated: entry.truncated });
      return this.result(entry, false, profile);
    });
  }

  async getAll(options = {}) {
    if (options.query !== undefined) {
      throw new DevDashError('INVALID_ARGUMENT', 'Select a profile when using a named query.');
    }
    const { profiles } = await this.config();
    const results = [];
    // Sequential queries avoid multiplying provider rate limits across consumers.
    for (const name of Object.keys(profiles)) {
      try {
        results.push(await this.get(name, options));
      } catch (error) {
        results.push({ profile: name, ...errorJson(error) });
      }
    }
    return { schemaVersion: 1, results, failed: failedProfiles(results) };
  }

  async cacheStatus(name, { query } = {}) {
    return this.diagnostics.run('cache.status', { profile: name, queryName: query }, () =>
      this.cacheStatusSnapshot(name, query));
  }

  async cacheStatusSnapshot(name, query) {
    const profile = await this.profile(name);
    if (query !== undefined || !isGroupedProfile(profile)) {
      return this.queryCacheStatus(name, selectedQuery(profile, query), query);
    }
    const queries = {};
    for (const [queryName, definition] of Object.entries(profile.queries)) {
      try {
        queries[queryName] = await this.diagnostics.run('query.status', { queryName }, () =>
          this.queryCacheStatus(name, definition, queryName));
      } catch (error) {
        queries[queryName] = { profile: name, query: queryName, ...errorJson(error) };
      }
    }
    const results = Object.values(queries);
    return {
      schemaVersion: 1, profile: name, queries,
      failed: results.filter((result) => result.error).length,
      cached: results.every((result) => result.cached === true),
      stale: results.some((result) => result.error || !result.cached || result.stale),
    };
  }

  async queryCacheStatus(name, profile, queryName) {
    const entry = await this.readCache(name, profile, queryName);
    return {
      schemaVersion: 1,
      profile: name,
      ...(queryName === undefined ? {} : { query: queryName }),
      cached: entry !== null,
      stale: entry ? this.now() >= Date.parse(entry.expiresAt) : null,
      fetchedAt: entry?.fetchedAt ?? null,
      expiresAt: entry?.expiresAt ?? null,
      count: entry?.items.length ?? 0,
      truncated: entry?.truncated ?? false,
    };
  }

  async clearCacheFile(name, queryName) {
    const path = this.cachePath(name, queryName);
    await withLock(path, async (checkLock) => {
      checkLock();
      await rm(path, { force: true });
      await this.diagnostics.log('cache.cleared', { profile: name, queryName });
    });
  }

  async clearCache(name, { query } = {}) {
    return this.diagnostics.run('cache.clear', { profile: name, queryName: query }, async () => {
      const profile = await this.profile(name);
      if (query !== undefined) selectedQuery(profile, query);
      for (const queryName of query === undefined ? slots(profile) : [query]) {
        await this.clearCacheFile(name, queryName);
      }
      return { schemaVersion: 1, cleared: name, ...(query === undefined ? {} : { query }) };
    });
  }
}
