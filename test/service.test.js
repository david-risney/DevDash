import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';

const profile = {
  provider: 'github',
  resource: 'bugs',
  repository: 'owner/repo',
  refreshSeconds: 10,
};

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  let queries = 0;
  const service = new DevDash({ home }, {
    now: () => now,
    queryProfile: async () => {
      queries++;
      return { items: [{ id: String(queries) }], truncated: false };
    },
    ...overrides,
  });
  await service.setProfile('bugs', profile);
  return { home, service, setNow: (value) => { now = value; }, queries: () => queries };
}

test('profiles create config, support constructor names, and preserve other profiles', async (t) => {
  const { service } = await fixture(t);
  await service.setProfile('constructor', { ...profile, resource: 'prs' });
  assert.equal((await service.profile('constructor')).resource, 'prs');
  assert.equal((await service.list()).profiles.length, 2);
  await service.removeProfile('constructor');
  assert.equal((await service.list()).profiles.length, 1);
  await assert.rejects(service.profile('constructor'), { code: 'PROFILE_NOT_FOUND' });
});

test('init never overwrites configuration', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.init(), { code: 'CONFIG_EXISTS' });
  assert.equal((await service.profile('bugs')).repository, 'owner/repo');
});

test('fresh reads reuse cache, expiry boundary refreshes, and force refresh queries', async (t) => {
  const { service, setNow, queries } = await fixture(t);
  const first = await service.get('bugs');
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(first.expiresAt, '2026-01-01T00:00:10.000Z');
  assert.equal((await service.get('bugs')).fromCache, true);
  setNow(Date.parse(first.expiresAt));
  assert.equal((await service.get('bugs')).fromCache, false);
  await service.get('bugs', { refresh: true });
  assert.equal(queries(), 3);
});

test('due refresh reuses fresh cache and cached-only marks stale without querying', async (t) => {
  const { service, setNow, queries } = await fixture(t);
  await assert.rejects(service.get('bugs', { cachedOnly: true }), { code: 'CACHE_MISS' });
  await service.get('bugs');
  assert.equal((await service.get('bugs', { refresh: true, due: true })).fromCache, true);
  setNow(Date.parse('2026-01-01T00:00:11Z'));
  assert.equal((await service.get('bugs', { cachedOnly: true })).stale, true);
  assert.equal(queries(), 1);
  await service.get('bugs', { refresh: true, due: true });
  assert.equal(queries(), 2);
});

test('fresh and cached snapshots expose query web links without changing existing cache files', async t => {
  const { service, queries } = await fixture(t);
  const refreshed = await service.get('bugs');
  const path = service.cachePath('bugs');
  const original = await readFile(path, 'utf8');
  assert.ok(!JSON.parse(original).queryUrl);
  const cached = await service.get('bugs', { cachedOnly: true });
  assert.equal(cached.queryUrl, refreshed.queryUrl);
  assert.equal(new URL(cached.queryUrl).searchParams.get('q'), 'state:open repo:owner/repo is:issue');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(queries(), 1);
  assert.equal((await service.get('bugs')).queryUrl, cached.queryUrl);
  assert.equal((await service.get('bugs', { refresh: true, due: true })).queryUrl, cached.queryUrl);
});

test('grouped empty and failed query snapshots retain their configured web destinations', async t => {
  const { service } = await fixture(t, {
    queryProfile: async definition => {
      if (definition.provider === 'ado') throw new DevDashError('CLI_FAILED', 'Provider unavailable.');
      return { items: [], truncated: false };
    },
  });
  await service.setProfile('group', { refreshSeconds: 300, queries: {
    empty: { provider: 'github', resource: 'bugs', repository: 'owner/repo' },
    failed: {
      provider: 'ado', resource: 'bugs', organization: 'https://dev.azure.com/example', project: 'Project',
      query: { queryId: '01234567-89ab-cdef-0123-456789abcdef' },
    },
  } });
  const result = await service.get('group');
  assert.equal(result.failed, 1);
  assert.equal(result.queries.empty.items.length, 0);
  assert.equal(new URL(result.queries.empty.queryUrl).searchParams.get('q'), 'state:open repo:owner/repo is:issue');
  assert.equal(result.queries.failed.error.code, 'CLI_FAILED');
  assert.equal(result.queries.failed.queryUrl,
    'https://dev.azure.com/example/Project/_queries/query/01234567-89ab-cdef-0123-456789abcdef');
});

test('fingerprint is independent of JSON key order and invalidates changed configuration', async (t) => {
  const { service, queries } = await fixture(t);
  await service.get('bugs');
  await service.setProfile('bugs', Object.fromEntries(Object.entries(profile).reverse()));
  assert.equal((await service.get('bugs')).fromCache, true);
  await service.setProfile('bugs', { ...profile, query: 'label:bug' });
  await assert.rejects(service.get('bugs', { cachedOnly: true }), { code: 'CACHE_MISS' });
  assert.equal((await service.cacheStatus('bugs')).cached, false);
  await service.get('bugs');
  assert.equal(queries(), 2);
});

test('presentation-only edits preserve cache identity and do not reach providers or cache files', async t => {
  const { service, queries } = await fixture(t);
  const before = await service.get('bugs');
  const path = service.cachePath('bugs');
  const cache = await readFile(path, 'utf8');
  const presentation = { ansi: { table: { header: { background: '#123456' } } } };
  await service.setProfile('bugs', { ...profile, presentation });
  const after = await service.get('bugs', { cachedOnly: true });
  assert.equal(queries(), 1);
  assert.deepEqual(after, { ...before, fromCache: true });
  assert.equal(await readFile(path, 'utf8'), cache);
  assert.ok(!JSON.stringify(after).includes('presentation'));
  service.query = async definition => {
    assert.ok(!Object.hasOwn(definition, 'presentation'));
    return { items: [], truncated: false };
  };
  await service.get('bugs', { refresh: true });
});

test('configuration files sharing a data directory have independent caches', async (t) => {
  const { service, home } = await fixture(t);
  await service.get('bugs');
  const other = new DevDash({ home, config: join(home, 'second.json') });
  await other.setProfile('bugs', profile);
  await assert.rejects(other.get('bugs', { cachedOnly: true }), { code: 'CACHE_MISS' });
});

test('pre-providerData snapshots are cache misses until refreshed, without migrating history', async t => {
  const { service, queries } = await fixture(t);
  const first = await service.get('bugs');
  const effective = await service.profile('bugs');
  const path = service.cachePath('bugs');
  const entry = JSON.parse(await readFile(path, 'utf8'));
  const ordered = Object.fromEntries(Object.keys(effective).sort().map(key => [key, effective[key]]));
  entry.fingerprint = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  await writeFile(path, JSON.stringify(entry));
  await assert.rejects(service.get('bugs', { cachedOnly: true }), { code: 'CACHE_MISS' });
  assert.equal((await service.cacheStatus('bugs')).cached, false);
  assert.equal(queries(), 1);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(entry));
  const refreshed = await service.get('bugs');
  assert.equal(refreshed.fromCache, false);
  assert.notDeepEqual(refreshed.items, first.items);
  assert.equal(queries(), 2);
  assert.equal((await service.get('bugs', { cachedOnly: true })).fromCache, true);
});

test('refresh failure preserves the last good cache and is never success-shaped', async (t) => {
  const { service, setNow } = await fixture(t);
  const first = await service.get('bugs');
  setNow(Date.parse(first.expiresAt) + 1);
  service.query = async () => { throw new DevDashError('CLI_FAILED', 'Authentication failed.'); };
  await assert.rejects(service.get('bugs'), { code: 'CLI_FAILED' });
  const stale = await service.get('bugs', { cachedOnly: true });
  assert.deepEqual(stale.items, first.items);
  assert.equal(stale.stale, true);
});

test('concurrent cache misses are coalesced and config edits do not lose profiles', async (t) => {
  const { service, queries } = await fixture(t);
  const results = await Promise.all([service.get('bugs'), service.get('bugs'), service.get('bugs')]);
  assert.equal(queries(), 1);
  assert.equal(results.filter((result) => !result.fromCache).length, 1);
  await Promise.all(['a', 'b', 'c'].map((name) => service.setProfile(name, profile)));
  assert.equal((await service.list()).profiles.length, 4);
});

test('changed profile during query prevents outdated cache commit', async (t) => {
  const { service } = await fixture(t);
  service.query = async () => {
    await service.setProfile('bugs', { ...profile, query: 'is:closed' });
    return { items: [], truncated: false };
  };
  await assert.rejects(service.get('bugs'), { code: 'PROFILE_CHANGED' });
  assert.equal((await service.cacheStatus('bugs')).cached, false);
});

test('partial batch failures report their profile and preserve successes', async (t) => {
  const { service } = await fixture(t);
  await service.setProfile('bad', { ...profile, repository: 'owner/bad' });
  service.query = async (query) => {
    if (query.repository === 'owner/bad') throw new DevDashError('CLI_FAILED', 'Bad query.');
    return { items: [], truncated: true };
  };
  const result = await service.getAll();
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].truncated, true);
  assert.equal(result.results[1].profile, 'bad');
  assert.equal(result.results[1].error.code, 'CLI_FAILED');
});

test('clear and remove clean up only the selected profile cache', async (t) => {
  const { service } = await fixture(t);
  await service.setProfile('prs', { ...profile, resource: 'prs' });
  await service.getAll();
  await service.clearCache('bugs');
  assert.equal((await service.cacheStatus('bugs')).cached, false);
  assert.equal((await service.cacheStatus('prs')).cached, true);
  await service.removeProfile('prs');
  await assert.rejects(readFile(service.cachePath('prs')), { code: 'ENOENT' });
});

test('malformed config and cache are explicit errors, not silently replaced', async (t) => {
  const { service } = await fixture(t);
  await service.get('bugs');
  await writeFile(service.cachePath('bugs'), '{"items":[]}');
  await assert.rejects(service.get('bugs'), { code: 'INVALID_CACHE' });
  await service.clearCache('bugs');
  await writeFile(service.paths.config, '{broken');
  await assert.rejects(service.setProfile('new', profile), { code: 'INVALID_JSON' });
  assert.equal(await readFile(service.paths.config, 'utf8'), '{broken');
});

test('invalid provider response is not persisted', async (t) => {
  const { service } = await fixture(t, { queryProfile: async () => ({ items: [] }) });
  await assert.rejects(service.get('bugs'), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.equal((await service.cacheStatus('bugs')).cached, false);
});
