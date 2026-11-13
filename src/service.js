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
import { readRefreshJob, scheduleRefresh, workerRunning } from './background.js';
import { mapLimit, withProviderSlot } from './concurrency.js';
import { pageOptions, resultPage } from './results.js';
import { fetchAvatar } from './avatars.js';

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
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.scheduleRefresh = dependencies.scheduleRefresh ?? scheduleRefresh;
    this.avatarDependencies = dependencies;
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

  queryRevision(profile, name) {
    if (!profile || !isGroupedProfile(profile) || !Object.hasOwn(profile.queries, name)) return 'missing';
    return hash(JSON.stringify(canonical({
      definition: profile.queries[name],
      refreshSeconds: profile.refreshSeconds,
      presentation: profile.presentation,
    })));
  }

  async queryDefinition(name, query) {
    validateName(name);
    validateName(query);
    const config = await this.config();
    const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : null;
    if (!profile) throw new DevDashError('PROFILE_NOT_FOUND', `No profile named "${name}".`);
    const definition = selectedQuery(profile, query);
    return {
      schemaVersion: 1, profile: name, query, definition,
      effectiveDefinition: selectedQuery(effectiveProfile(profile), query),
      revision: this.queryRevision(profile, query),
    };
  }

  queryCandidate(config, name, query, definition) {
    validateName(name);
    validateName(query);
    const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : null;
    if (profile && !isGroupedProfile(profile)) {
      throw new DevDashError('INVALID_ARGUMENT', 'Query editing requires a grouped profile; existing standalone profiles are not converted implicitly.');
    }
    if (!profile && (!definition || !Number.isInteger(definition.refreshSeconds))) {
      throw new DevDashError('INVALID_ARGUMENT', 'The first query in a new profile requires an explicit refreshSeconds.');
    }
    const candidate = profile
      ? { ...profile, queries: { ...profile.queries, [query]: definition } }
      : { refreshSeconds: definition.refreshSeconds, queries: { [query]: definition } };
    validateConfig({ ...config, profiles: { ...config.profiles, [name]: candidate } });
    return candidate;
  }

  async validateQuery(name, query, definition) {
    return this.diagnostics.run('query.validate', { profile: name, queryName: query }, async () => {
      const config = await readJson(this.paths.config) ?? { version: 1, profiles: {} };
      validateConfig(config);
      const candidate = this.queryCandidate(config, name, query, definition);
      return {
        schemaVersion: 1, profile: name, query, valid: true,
        revision: this.queryRevision(Object.hasOwn(config.profiles, name) ? config.profiles[name] : null, query),
        effectiveDefinition: selectedQuery(effectiveProfile(candidate), query),
      };
    });
  }

  async setQuery(name, query, definition, expectedRevision) {
    return this.diagnostics.run('query.set', { profile: name, queryName: query }, async () => {
      this.validateExpectedRevision(expectedRevision);
      return updateConfig(this.paths.config, config => {
        const current = Object.hasOwn(config.profiles, name) ? config.profiles[name] : null;
        if (this.queryRevision(current, query) !== expectedRevision) {
          throw new DevDashError('REVISION_CONFLICT', 'The query or its inherited defaults changed. Read it again before saving.');
        }
        const candidate = this.queryCandidate(config, name, query, definition);
        config.profiles[name] = candidate;
        return {
          schemaVersion: 1, profile: name, query, definition,
          effectiveDefinition: selectedQuery(effectiveProfile(candidate), query),
          revision: this.queryRevision(candidate, query),
        };
      });
    });
  }

  validateExpectedRevision(value) {
    if (typeof value !== 'string' || (value !== 'missing' && !/^[a-f0-9]{64}$/.test(value))) {
      throw new DevDashError('INVALID_ARGUMENT', 'expectedRevision must be the current query revision, or "missing" when creating a query.');
    }
  }

  async removeQuery(name, query, expectedRevision) {
    return this.diagnostics.run('query.remove', { profile: name, queryName: query }, async () => {
      validateName(name);
      validateName(query);
      this.validateExpectedRevision(expectedRevision);
      const removed = await updateConfig(this.paths.config, config => {
        const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : null;
        if (!profile) throw new DevDashError('PROFILE_NOT_FOUND', `No profile named "${name}".`);
        selectedQuery(profile, query);
        if (this.queryRevision(profile, query) !== expectedRevision) {
          throw new DevDashError('REVISION_CONFLICT', 'The query or its inherited defaults changed. Read it again before removing it.');
        }
        delete profile.queries[query];
        const profileRemoved = Object.keys(profile.queries).length === 0;
        if (profileRemoved) delete config.profiles[name];
        return { schemaVersion: 1, profile: name, removed: query, profileRemoved };
      });
      await this.clearCacheFile(name, query);
      return removed;
    });
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
    return hash('normalized-items-v3\0' + JSON.stringify(canonical(definition)));
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
    if (entry.refreshDurationsMs !== undefined && (!Array.isArray(entry.refreshDurationsMs)
        || entry.refreshDurationsMs.length < 1 || entry.refreshDurationsMs.length > 5
        || entry.refreshDurationsMs.some(value => !Number.isFinite(value) || value < 0))) {
      throw new DevDashError('INVALID_CACHE', `Invalid refresh timing history at ${path}. Run devdash cache clear ${name}.`);
    }
    return entry;
  }

  result(entry, fromCache, profile) {
    const { fingerprint, refreshDurationsMs, ...result } = entry;
    return { ...result, cacheRevision: hash(JSON.stringify(entry)), queryUrl: queryWebUrl(profile), stale: this.now() >= Date.parse(entry.expiresAt), fromCache };
  }

  async get(name, { refresh = false, cachedOnly = false, due = false, query, cacheMode = 'cache-first', fastQueryMs } = {}) {
    return this.diagnostics.run('profile.get', { profile: name, refresh, cachedOnly, due, queryName: query }, () =>
      this.getSnapshot(name, { refresh, cachedOnly, due, query, cacheMode, fastQueryMs }));
  }

  async getPage(name, options = {}) {
    validateName(name);
    if (options.query !== undefined) validateName(options.query);
    selectedQuery(await this.profile(name), options.query);
    const pagination = pageOptions(options, `${this.paths.config}\0${name}\0${options.query ?? ''}`);
    let result;
    try {
      result = await this.get(name, pagination.token
        ? { query: options.query, cachedOnly: true }
        : options);
    } catch (error) {
      if (pagination.token && error.code === 'CACHE_MISS') {
        throw new DevDashError('CURSOR_EXPIRED', 'The cached snapshot was cleared or invalidated. Restart paging without a cursor.');
      }
      throw error;
    }
    return resultPage(result, pagination);
  }

  async startRefresh(name, { query, due = false } = {}) {
    return this.diagnostics.run('refresh.start', { profile: name, queryName: query, due }, async () => {
      if (typeof due !== 'boolean') throw new DevDashError('INVALID_ARGUMENT', 'due must be a boolean.');
      const profile = selectedQuery(await this.profile(name), query);
      const cached = await this.readCache(name, profile, query);
      if (due && cached && this.now() < Date.parse(cached.expiresAt)) {
        return { ...await this.queryCacheStatus(name, profile, query), refreshStatus: 'fresh', jobId: null };
      }

      const job = await this.scheduleRefresh({
        cachePath: this.cachePath(name, query), paths: this.paths, name, queryName: query,
        fingerprint: this.fingerprint(profile), force: !due,
      });
      return {
        ...await this.queryCacheStatus(name, profile, query),
        refreshStatus: job.state, jobId: job.id,
      };
    });
  }

  async avatar(name, { query, itemId, repository, role = 'author', index = 0, cacheRevision } = {}) {
    return this.diagnostics.run('avatar.get', { profile: name, queryName: query }, async () => {
      if (typeof itemId !== 'string' || !itemId || itemId.length > 256 || /[\u0000-\u001f]/.test(itemId) ||
          (repository !== undefined && (typeof repository !== 'string' || !repository.trim() ||
            repository.length > 512 || /[\u0000-\u001f\u007f]/.test(repository))) ||
          !['author', 'assignee', 'reviewer'].includes(role) || !Number.isInteger(index) || index < 0 || index > 1000 ||
          (role === 'author' && index !== 0) ||
          (cacheRevision !== undefined && (typeof cacheRevision !== 'string' || !/^[a-f0-9]{64}$/.test(cacheRevision)))) {
        throw new DevDashError('INVALID_ARGUMENT', 'Select a cached itemId, author/assignee/reviewer role, and valid identity index.');
      }
      const profile = selectedQuery(await this.profile(name), query);
      const cached = await this.get(name, { query, cachedOnly: true });
      if (cacheRevision !== undefined && cacheRevision !== cached.cacheRevision) {
        throw new DevDashError('CURSOR_EXPIRED', 'The cached snapshot changed. Read the updated identity before requesting its avatar.');
      }
      const items = cached.items.filter(item => item.id === itemId &&
        (repository === undefined || item.repository?.toLowerCase() === repository.toLowerCase()));
      if (items.length !== 1) throw new DevDashError('INVALID_ARGUMENT', 'itemId must identify exactly one cached item; include repository when numbers overlap.');
      const identities = items[0].identities;
      const identity = role === 'author' ? identities?.author : identities?.[`${role}s`]?.[index];
      if (!identity) throw new DevDashError('AVATAR_UNAVAILABLE', 'This cached item has no avatar identity for that role.');
      return {
        schemaVersion: 1, profile: name, ...(query === undefined ? {} : { query }),
        itemId, role, index, cacheRevision: cached.cacheRevision,
        ...(repository === undefined ? {} : { repository: items[0].repository }),
        ...await fetchAvatar(identity, profile, this.paths, this.avatarDependencies),
      };
    });
  }

  async getSnapshot(name, options = {}) {
    const { refresh, cachedOnly, query } = options;
    if (refresh && cachedOnly) {
      throw new DevDashError('INVALID_ARGUMENT', 'refresh and cachedOnly cannot be combined.');
    }
    if (!['cache-first', 'adaptive'].includes(options.cacheMode ?? 'cache-first') ||
        (options.cacheMode === 'adaptive' && (refresh || cachedOnly || options.due)) ||
        (options.fastQueryMs !== undefined && (options.cacheMode !== 'adaptive' ||
          !Number.isInteger(options.fastQueryMs) || options.fastQueryMs < 1 || options.fastQueryMs > 60_000))) {
      throw new DevDashError('INVALID_ARGUMENT', 'Adaptive cache mode is only supported by get without cached-only; fastQueryMs must be 1-60000.');
    }
    const profile = await this.profile(name);
    if (query !== undefined || !isGroupedProfile(profile)) {
      return this.getQuerySnapshot(name, selectedQuery(profile, query), query, options);
    }
    const queries = {};
    const entries = Object.entries(profile.queries);
    const resultsByQuery = await mapLimit(entries, 3, async ([queryName, definition]) => {
      try {
        return await this.diagnostics.run('query.get', { queryName }, () =>
          this.getQuerySnapshot(name, definition, queryName, options));
      } catch (error) {
        return {
          profile: name, query: queryName, provider: definition.provider, resource: definition.resource,
          queryUrl: queryWebUrl(definition),
          ...errorJson(error),
        };
      }
    });
    entries.forEach(([queryName], index) => { queries[queryName] = resultsByQuery[index]; });
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

  async getQuerySnapshot(name, profile, queryName, {
    refresh = false, cachedOnly = false, due = false, cacheMode = 'cache-first', fastQueryMs = 500, assertReservation,
  } = {}) {
    const filter = compileFilter(profile.filter, profile);
    const cached = await this.readCache(name, profile, queryName);
    const metadata = { provider: profile.provider, resource: profile.resource };
    const result = (entry, fromCache) => ({
      ...this.result(entry, fromCache, profile),
      ...(cacheMode === 'adaptive' ? { refreshStatus: fromCache ? 'fresh' : 'complete' } : {}),
    });
    await this.diagnostics.log('cache.check', {
      ...metadata,
      outcome: cached ? (this.now() >= Date.parse(cached.expiresAt) ? 'expired' : 'fresh') : 'miss',
    });
    if (cachedOnly) {
      if (!cached) throw new DevDashError('CACHE_MISS', `No matching cache for "${name}"${queryName ? ` query "${queryName}"` : ''}. Run devdash refresh ${name}.`);
      return result(cached, true);
    }
    if (cached && (!refresh || due) && this.now() < Date.parse(cached.expiresAt)) {
      return result(cached, true);
    }
    const timings = cached?.refreshDurationsMs ?? [];
    if (cached && cacheMode === 'adaptive' && !(timings.length >= 3 && timings.every(duration => duration <= fastQueryMs))) {
      const background = await this.scheduleRefresh({
        cachePath: this.cachePath(name, queryName), paths: this.paths, name, queryName, fingerprint: this.fingerprint(profile),
      });
      await this.diagnostics.log('background.refresh.requested', { ...metadata, outcome: background.state });
      return { ...this.result(cached, true, profile), refreshStatus: background.state };
    }
    await this.diagnostics.log('cache.lock.wait', metadata);
    return withLock(this.cachePath(name, queryName), async (checkLock) => {
      await this.diagnostics.log('cache.lock.acquired', metadata);
      await this.assertCurrentQuery(name, profile, queryName);
      const existing = await this.readCache(name, profile, queryName);
      await assertReservation?.();
      if (existing && (!refresh || due) && this.now() < Date.parse(existing.expiresAt)) {
        return result(existing, true);
      }
      let response;
      const started = this.monotonicNow();
      try {
        response = await withProviderSlot(join(this.paths.cache, 'provider-slots', hash(this.paths.config)), profile.provider, () =>
          this.diagnostics.run('provider.query', metadata, () =>
            this.query(providerProfile(profile), { log: (event, data) => this.diagnostics.log(event, data) })));
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
      let items;
      try {
        items = await filterItems(response.items, filter, { now: this.now() });
      } catch (error) {
        await this.diagnostics.log('filter.failed', { ...metadata, code: diagnosticCode(error) });
        await this.diagnostics.log('cache.preserved', {
          ...metadata, code: diagnosticCode(error), outcome: existing ? 'retained' : 'absent',
        });
        throw error;
      }
      if (profile.filter !== undefined) {
        await this.diagnostics.log('filter.complete', {
          ...metadata, sourceCount: response.items.length, count: items.length,
          removedCount: response.items.length - items.length,
        });
      }
      const fetchedAt = this.now();
      const durationMs = Math.max(0, Math.round(this.monotonicNow() - started));
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
        refreshDurationsMs: [...(existing?.refreshDurationsMs ?? []), durationMs].slice(-5),
      };
      await this.assertCurrentQuery(name, profile, queryName);
      await assertReservation?.();
      checkLock();
      await writeJson(this.cachePath(name, queryName), entry);
      await this.diagnostics.log('cache.write', { ...metadata, count: entry.items.length, truncated: entry.truncated });
      return result(entry, false);
    });
  }

  async getAll(options = {}) {
    if (options.query !== undefined) {
      throw new DevDashError('INVALID_ARGUMENT', 'Select a profile when using a named query.');
    }
    const { profiles } = await this.config();
    const results = await mapLimit(Object.keys(profiles), 3, async name => {
      try {
        return await this.get(name, options);
      } catch (error) {
        return { profile: name, ...errorJson(error) };
      }
    });
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
    const savedJob = await readRefreshJob(`${this.cachePath(name, queryName)}.background.json`);
    const job = savedJob?.fingerprint && savedJob.fingerprint !== this.fingerprint(profile) ? null : savedJob;
    const timings = entry?.refreshDurationsMs ?? [];
    return {
      schemaVersion: 1,
      profile: name,
      ...(queryName === undefined ? {} : { query: queryName }),
      cached: entry !== null,
      cacheRevision: entry ? hash(JSON.stringify(entry)) : null,
      stale: entry ? this.now() >= Date.parse(entry.expiresAt) : null,
      fetchedAt: entry?.fetchedAt ?? null,
      expiresAt: entry?.expiresAt ?? null,
      count: entry?.items.length ?? 0,
      truncated: entry?.truncated ?? false,
      refreshTiming: { samples: timings.length, maxMs: timings.length ? Math.max(...timings) : null },
      backgroundRefresh: job ? {
        id: job.id,
        state: job.state === 'running' && !workerRunning(job) ? 'interrupted' : job.state,
        startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
        ...(job.code ? { code: job.code } : {}),
      } : null,
    };
  }

  async clearCacheFile(name, queryName) {
    const path = this.cachePath(name, queryName);
    await withLock(path, async (checkLock) => {
      checkLock();
      await rm(path, { force: true });
      await withLock(`${path}.background.json`, async checkJobLock => {
        checkJobLock();
        await rm(`${path}.background.json`, { force: true });
      });
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
