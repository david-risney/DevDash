import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { effectiveProfile, validateConfig } from '../src/config.js';
import { executeCommand, validateWatch } from '../src/commands.js';
import { watchProfiles } from '../src/watch.js';

const ado = { provider: 'ado', organization: 'https://dev.azure.com/example-org', project: 'Example Project' };
const edge = {
  refreshSeconds: 300,
  queries: {
    bugs: { ...ado, resource: 'bugs', queryId: '11111111-1111-1111-1111-111111111111' },
    'security-bugs': { ...ado, resource: 'bugs', queryId: '22222222-2222-2222-2222-222222222222' },
    'my-prs': { ...ado, resource: 'prs', repository: 'example-repository', creator: 'you@example.com', refreshSeconds: 120 },
    'review-prs': { ...ado, resource: 'prs', repository: 'example-repository', reviewer: 'you@example.com', refreshSeconds: 120 },
  },
};
const config = (profile) => ({ version: 1, profiles: { edge: profile } });

async function fixture(t, profile = edge) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-groups-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const calls = [];
  const service = new DevDash({ home }, {
    now: () => now,
    queryProfile: async (query) => {
      calls.push(query);
      return { items: [{ id: '1', title: query.queryId ?? query.creator ?? query.reviewer }], truncated: false };
    },
  });
  await service.setProfile('edge', profile);
  return { service, calls, setNow: (value) => { now = value; } };
}

test('group schema requires named nonempty flat queries and resolves refresh defaults without mutation', () => {
  assert.doesNotThrow(() => validateConfig(config(edge)));
  const normalized = effectiveProfile(edge);
  assert.equal(normalized.queries.bugs.refreshSeconds, 300);
  assert.equal(normalized.queries['my-prs'].refreshSeconds, 120);
  assert.equal(normalized.queries.bugs.limit, 1000);
  assert.equal(edge.queries.bugs.refreshSeconds, undefined);
  assert.equal(normalized.limit, undefined);
  const badQuery = { ...edge.queries.bugs, queryId: undefined };
  for (const profile of [
    { queries: edge.queries },
    { refreshSeconds: 300, queries: {} },
    { ...edge, provider: 'ado' },
    { ...edge, queries: { '../escape': edge.queries.bugs } },
    { ...edge, queries: { bugs: { ...edge.queries.bugs, refreshSeconds: 0 } } },
    { ...edge, queries: { bugs: edge } },
    { ...edge, queries: { bugs: badQuery } },
    { ...edge, queries: { bugs: { ...edge.queries.bugs, organization: 'https://user:token@example.com' } } },
    { ...edge, queries: { bugs: { ...edge.queries.bugs, queryId: undefined, query: ' ' } } },
    { ...edge, queries: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, edge.queries.bugs])) },
  ]) {
    assert.throws(() => validateConfig(config(JSON.parse(JSON.stringify(profile)))), { code: 'INVALID_CONFIG' });
  }
});

test('a grouped profile returns exactly four independent named lists with provider-specific scopes', async (t) => {
  const { service, calls } = await fixture(t);
  const result = await service.get('edge');
  assert.deepEqual(Object.keys(result.queries), ['bugs', 'security-bugs', 'my-prs', 'review-prs']);
  assert.equal(result.items, undefined);
  assert.equal(result.profile, 'edge');
  assert.equal(result.failed, 0);
  assert.equal(result.fromCache, false);
  assert.equal(result.stale, false);
  assert.equal(calls.length, 4);
  for (const [name, query] of Object.entries(result.queries)) {
    assert.equal(query.profile, 'edge');
    assert.equal(query.query, name);
    assert.equal(query.provider, 'ado');
    assert.equal(query.items.length, 1);
    assert.equal(query.items[0].id, '1');
    assert.equal(query.fromCache, false);
    assert.equal(query.resource, name.includes('prs') ? 'prs' : 'bugs');
  }
  assert.equal(result.queries.bugs.expiresAt, '2026-01-01T00:05:00.000Z');
  assert.equal(result.queries['my-prs'].expiresAt, '2026-01-01T00:02:00.000Z');
  assert.equal(calls[2].creator, 'you@example.com');
  assert.equal(calls[3].reviewer, 'you@example.com');
  assert.equal((await service.get('edge')).fromCache, true);
  assert.equal(calls.length, 4);
});

test('mixed provider queries remain separate and can use prototype property names safely', async (t) => {
  const { service, calls } = await fixture(t, {
    refreshSeconds: 60,
    queries: {
      constructor: { provider: 'github', resource: 'prs', repository: 'owner/repo', query: 'is:open' },
      'chromium-bugs': { provider: 'chromium', resource: 'bugs', bugIds: ['411731002'] },
      cls: { provider: 'chromium', resource: 'cls', query: 'status:open' },
    },
  });
  const result = await service.get('edge');
  assert.equal(result.queries.constructor.provider, 'github');
  assert.equal(result.queries['chromium-bugs'].resource, 'bugs');
  assert.equal(result.queries.cls.resource, 'cls');
  assert.deepEqual(calls.map((query) => query.provider), ['github', 'chromium', 'chromium']);
  assert.notEqual(service.cachePath('edge', 'constructor'), service.cachePath('edge'));
});

test('per-query expiry and due refresh do not requery fresh siblings', async (t) => {
  const { service, calls, setNow } = await fixture(t);
  await service.get('edge');
  setNow(Date.parse('2026-01-01T00:02:00Z'));
  const result = await service.get('edge', { refresh: true, due: true });
  assert.equal(result.queries.bugs.fromCache, true);
  assert.equal(result.queries['security-bugs'].fromCache, true);
  assert.equal(result.queries['my-prs'].fromCache, false);
  assert.equal(result.queries['review-prs'].fromCache, false);
  assert.equal(calls.length, 6);
  await service.get('edge', { refresh: true });
  assert.equal(calls.length, 10);
});

test('cached-only exposes each cache miss or stale state without querying', async (t) => {
  const { service, calls, setNow } = await fixture(t);
  await service.get('edge', { query: 'bugs' });
  const missing = await service.get('edge', { cachedOnly: true });
  assert.equal(missing.failed, 3);
  assert.equal(missing.queries.bugs.fromCache, true);
  assert.equal(missing.queries['my-prs'].error.code, 'CACHE_MISS');
  assert.equal(missing.fromCache, false);
  assert.equal(missing.stale, true);
  assert.equal(calls.length, 1);
  setNow(Date.parse('2026-01-01T00:05:00Z'));
  const stale = await service.get('edge', { query: 'bugs', cachedOnly: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.fromCache, true);
  assert.equal(calls.length, 1);
});

test('changing one query invalidates only its cache and inherited defaults affect only relevant queries', async (t) => {
  const { service, calls } = await fixture(t);
  await service.get('edge');
  const changed = structuredClone(edge);
  changed.queries.bugs.queryId = '33333333-3333-3333-3333-333333333333';
  await service.setProfile('edge', changed);
  const result = await service.get('edge');
  assert.equal(result.queries.bugs.fromCache, false);
  assert.equal(result.queries['security-bugs'].fromCache, true);
  assert.equal(result.queries['my-prs'].fromCache, true);
  assert.equal(calls.length, 5);
  await service.setProfile('edge', { ...changed, refreshSeconds: 600 });
  const changedDefault = await service.get('edge');
  assert.equal(changedDefault.queries.bugs.fromCache, false);
  assert.equal(changedDefault.queries['security-bugs'].fromCache, false);
  assert.equal(changedDefault.queries['my-prs'].fromCache, true);
  assert.equal(changedDefault.queries['review-prs'].fromCache, true);
  assert.equal(calls.length, 7);
});

test('query failures preserve old snapshots, continue sibling refreshes and propagate batch failure counts', async (t) => {
  const { service } = await fixture(t);
  const first = await service.get('edge');
  const old = await readFile(service.cachePath('edge', 'security-bugs'));
  service.query = async (query) => {
    if (query.queryId === edge.queries['security-bugs'].queryId) throw new DevDashError('CLI_FAILED', 'SECRET_QUERY_DETAILS');
    return { items: [{ id: '2' }], truncated: true };
  };
  const result = await service.get('edge', { refresh: true });
  assert.equal(result.failed, 1);
  assert.equal(result.queries['security-bugs'].error.code, 'CLI_FAILED');
  assert.equal(result.queries.bugs.items[0].id, '2');
  assert.equal(result.queries.bugs.truncated, true);
  assert.deepEqual(await readFile(service.cachePath('edge', 'security-bugs')), old);
  assert.deepEqual((await service.get('edge', { query: 'security-bugs', cachedOnly: true })).items, first.queries['security-bugs'].items);
  assert.equal((await executeCommand(['refresh', 'edge'], { service })).exitCode, 2);
  const all = await executeCommand(['refresh', '--all'], { service });
  assert.equal(all.exitCode, 2);
  assert.equal(all.output.failed, 1);
  assert.equal(all.output.results[0].failed, 1);
  assert.equal((await service.getAll({ refresh: true })).failed, 1);
  await assert.rejects(executeCommand(['refresh', 'edge', '--query', 'security-bugs'], { service }), { code: 'CLI_FAILED' });
});

test('selected queries, status and selective clearing are consistent across commands', async (t) => {
  const { service, calls } = await fixture(t);
  const one = await executeCommand(['get', 'edge', '--query', 'my-prs'], { service });
  assert.equal(one.output.query, 'my-prs');
  assert.equal(one.output.queries, undefined);
  assert.equal(calls.length, 1);
  const status = await service.cacheStatus('edge');
  assert.equal(status.cached, false);
  assert.equal(status.stale, true);
  assert.equal(status.queries['my-prs'].cached, true);
  await service.get('edge');
  assert.equal((await service.cacheStatus('edge')).cached, true);
  await executeCommand(['cache', 'clear', 'edge', '--query', 'my-prs'], { service });
  assert.equal((await service.cacheStatus('edge', { query: 'my-prs' })).cached, false);
  assert.equal((await service.cacheStatus('edge', { query: 'bugs' })).cached, true);
  await service.clearCache('edge');
  assert.equal((await service.cacheStatus('edge', { query: 'bugs' })).cached, false);
  await assert.rejects(service.get('edge', { query: 'missing' }), { code: 'QUERY_NOT_FOUND' });
  await assert.rejects(service.get('edge', { query: '../escape' }), { code: 'INVALID_PROFILE' });
  await assert.rejects(executeCommand(['get', '--all', '--query', 'bugs'], { service }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.getAll({ query: 'bugs' }), { code: 'INVALID_ARGUMENT' });
  await service.setProfile('flat', { ...edge.queries['my-prs'], refreshSeconds: 120 });
  await assert.rejects(service.get('flat', { query: 'my-prs' }), { code: 'INVALID_ARGUMENT' });
});

test('cache corruption is local to one query and selected clear repairs it', async (t) => {
  const { service } = await fixture(t);
  await service.get('edge');
  await writeFile(service.cachePath('edge', 'bugs'), '{"bad":true}');
  const result = await service.get('edge', { cachedOnly: true });
  assert.equal(result.failed, 1);
  assert.equal(result.queries.bugs.error.code, 'INVALID_CACHE');
  assert.equal(result.queries['my-prs'].fromCache, true);
  const status = await executeCommand(['cache', 'status', '--all'], { service });
  assert.equal(status.exitCode, 2);
  assert.equal(status.output.failed, 1);
  await service.clearCache('edge', { query: 'bugs' });
  assert.equal((await service.get('edge')).failed, 0);
});

test('removing queries, replacing profile shape and removing profile clean only obsolete slots', async (t) => {
  const { service } = await fixture(t);
  await service.get('edge');
  const reduced = structuredClone(edge);
  delete reduced.queries['security-bugs'];
  await service.setProfile('edge', reduced);
  await assert.rejects(readFile(service.cachePath('edge', 'security-bugs')), { code: 'ENOENT' });
  assert.equal((await service.get('edge', { query: 'bugs' })).fromCache, true);
  const flat = { ...edge.queries.bugs, refreshSeconds: 300 };
  await service.setProfile('edge', flat);
  for (const name of Object.keys(reduced.queries)) {
    await assert.rejects(readFile(service.cachePath('edge', name)), { code: 'ENOENT' });
  }
  await service.get('edge');
  await service.setProfile('edge', edge);
  await assert.rejects(readFile(service.cachePath('edge')), { code: 'ENOENT' });
  await service.get('edge');
  await service.removeProfile('edge');
  for (const name of Object.keys(edge.queries)) {
    await assert.rejects(readFile(service.cachePath('edge', name)), { code: 'ENOENT' });
  }
});

test('unrelated query changes during refresh are allowed but selected query changes prevent commits', async (t) => {
  const { service } = await fixture(t);
  service.query = async () => {
    const changed = structuredClone(edge);
    changed.queries['my-prs'].creator = 'other@example.com';
    await service.setProfile('edge', changed);
    return { items: [], truncated: false };
  };
  assert.equal((await service.get('edge', { query: 'bugs' })).fromCache, false);
  service.query = async () => {
    const changed = structuredClone(edge);
    changed.queries.bugs.queryId = '33333333-3333-3333-3333-333333333333';
    await service.setProfile('edge', changed);
    return { items: [{ id: 'outdated' }], truncated: false };
  };
  await assert.rejects(service.get('edge', { query: 'bugs', refresh: true }), { code: 'PROFILE_CHANGED' });
  assert.equal((await service.cacheStatus('edge', { query: 'bugs' })).cached, false);
});

test('concurrent grouped reads coalesce independently per query and diagnostic names never expose query text', async (t) => {
  const { service, calls } = await fixture(t);
  const results = await Promise.all([service.get('edge'), service.get('edge')]);
  assert.equal(calls.length, 4);
  assert.equal(results.every((result) => result.failed === 0), true);
  const { entries } = await service.diagnostics.tail({ lines: 1000 });
  const providerStarts = entries.filter((entry) => entry.event === 'provider.query.start');
  assert.deepEqual(new Set(providerStarts.map((entry) => entry.queryName)), new Set(Object.keys(edge.queries)));
  assert.equal(JSON.stringify(entries).includes(edge.queries.bugs.queryId), false);
});

test('removing an in-flight named query prevents its cache commit and cleans its slot', async (t) => {
  const { service } = await fixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  service.query = async () => {
    entered();
    await gate;
    return { items: [{ id: 'obsolete' }], truncated: false };
  };
  const refresh = assert.rejects(service.get('edge', { query: 'bugs' }), { code: 'PROFILE_CHANGED' });
  await started;
  let cleanupEntered;
  const cleanupStarted = new Promise((resolve) => { cleanupEntered = resolve; });
  const clear = service.clearCacheFile.bind(service);
  service.clearCacheFile = async (name, queryName) => {
    cleanupEntered();
    return clear(name, queryName);
  };
  const reduced = structuredClone(edge);
  delete reduced.queries.bugs;
  const replacement = service.setProfile('edge', reduced);
  await cleanupStarted;
  resume();
  await Promise.all([refresh, replacement]);
  await assert.rejects(readFile(service.cachePath('edge', 'bugs')), { code: 'ENOENT' });
  assert.equal(Object.hasOwn((await service.profile('edge')).queries, 'bugs'), false);
});

test('a slow query does not hold a sibling query cache lock', async (t) => {
  const { service } = await fixture(t);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  service.query = async (query) => {
    if (query.queryId === edge.queries.bugs.queryId) {
      entered();
      await gate;
    }
    return { items: [], truncated: false };
  };
  const slow = service.get('edge', { query: 'bugs' });
  try {
    await started;
    const sibling = await service.get('edge', { query: 'my-prs' });
    assert.equal(sibling.query, 'my-prs');
    assert.equal(sibling.fromCache, false);
  } finally {
    resume();
    await slow;
  }
});

test('watch refreshes grouped queries on their individual schedules and emits partial failures as errors', async (t) => {
  const { service, calls, setNow } = await fixture(t);
  const controller = new AbortController();
  const events = [];
  let ticks = 0;
  await watchProfiles(service, { profile: 'edge', signal: controller.signal }, (event) => events.push(event), {
    sleep: async () => {
      ticks++;
      if (ticks === 1) setNow(Date.parse('2026-01-01T00:01:00Z'));
      if (ticks === 2) setNow(Date.parse('2026-01-01T00:02:00Z'));
      if (ticks === 3) controller.abort();
    },
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'refreshed');
  assert.equal(events[1].queries.bugs.fromCache, true);
  assert.equal(events[1].queries['my-prs'].fromCache, false);
  assert.equal(calls.length, 6);
  const failController = new AbortController();
  service.query = async () => { throw new DevDashError('CLI_FAILED', 'Query failed.'); };
  setNow(Date.parse('2026-01-01T00:10:00Z'));
  const failures = [];
  await watchProfiles(service, { profile: 'edge', signal: failController.signal }, (event) => failures.push(event), {
    sleep: async () => failController.abort(),
  });
  assert.equal(failures[0].event, 'error');
  assert.equal(failures[0].failed, 4);
  assert.equal(validateWatch(['watch', 'edge', '--query', 'my-prs']).values.query, 'my-prs');
  assert.throws(() => validateWatch(['watch', '--query', 'my-prs']), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(watchProfiles(service, { profile: 'edge', query: 'missing' }, () => {}), { code: 'QUERY_NOT_FOUND' });
});
