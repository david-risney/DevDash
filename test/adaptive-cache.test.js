import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { testItem } from './helpers/test-provider.js';

const profile = { provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 10 };
const adaptive = { cacheMode: 'adaptive' };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-adaptive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z'), elapsed = 0, duration = 100, queries = 0;
  const scheduled = [];
  const dependencies = {
    now: () => now,
    monotonicNow: () => elapsed,
    queryProfile: async () => {
      queries++;
      elapsed += duration;
      return { items: [testItem({ id: String(queries) })], truncated: false };
    },
    scheduleRefresh: async request => { scheduled.push(request); return { state: 'scheduled' }; },
  };
  const service = new DevDash({ home }, dependencies);
  await service.setProfile('bugs', profile);
  return {
    service, home, dependencies, scheduled, queries: () => queries,
    advance: milliseconds => { now += milliseconds; },
    duration: value => { duration = value; },
  };
}

test('adaptive misses fetch directly, fresh caches do nothing, and exact expiry schedules unknown-speed refresh', async t => {
  const f = await fixture(t);
  const first = await f.service.get('bugs', adaptive);
  assert.equal(first.fromCache, false);
  assert.equal(first.refreshStatus, 'complete');
  assert.ok(!Object.hasOwn(first, 'refreshDurationsMs'));
  f.advance(9999);
  const fresh = await f.service.get('bugs', adaptive);
  assert.equal(fresh.fromCache, true);
  assert.equal(fresh.refreshStatus, 'fresh');
  assert.equal(f.scheduled.length, 0);
  f.advance(1);
  const stale = await f.service.get('bugs', adaptive);
  assert.equal(stale.refreshStatus, 'scheduled');
  assert.equal(stale.fromCache, true);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.items, first.items);
  assert.equal(f.queries(), 1);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].fingerprint, f.service.fingerprint(await f.service.profile('bugs')));
  assert.equal(f.scheduled[0].paths.config, f.service.paths.config);
});

test('at least three samples are required and the threshold includes its exact boundary', async t => {
  const f = await fixture(t);
  for (const duration of [100, 500, 300]) {
    f.duration(duration);
    await f.service.get('bugs', { refresh: true });
  }
  const reconstructed = new DevDash({ home: f.home }, f.dependencies);
  assert.deepEqual((await reconstructed.cacheStatus('bugs')).refreshTiming, { samples: 3, maxMs: 500 });
  f.advance(10000);
  const foreground = await reconstructed.get('bugs', adaptive);
  assert.equal(foreground.fromCache, false);
  assert.equal(foreground.refreshStatus, 'complete');
  assert.equal(f.queries(), 4);
  assert.equal(f.scheduled.length, 0);
  f.advance(10000);
  const background = await reconstructed.get('bugs', { ...adaptive, fastQueryMs: 499 });
  assert.equal(background.fromCache, true);
  assert.equal(f.scheduled.length, 1);
});

test('slow recent history stays in the background until five newer samples replace it', async t => {
  const f = await fixture(t);
  for (const duration of [100, 501, 100, 100, 100]) {
    f.duration(duration);
    await f.service.get('bugs', { refresh: true });
  }
  f.advance(10000);
  assert.equal((await f.service.get('bugs', adaptive)).fromCache, true);
  assert.equal(f.queries(), 5);
  await f.service.get('bugs', { refresh: true });
  await f.service.get('bugs', { refresh: true });
  f.advance(10000);
  assert.equal((await f.service.get('bugs', adaptive)).fromCache, false);
  assert.equal((await f.service.cacheStatus('bugs')).refreshTiming.samples, 5);
});

test('legacy caches without timings revalidate in the background, and changed query definitions never return old data', async t => {
  const f = await fixture(t);
  await f.service.get('bugs');
  const path = f.service.cachePath('bugs');
  const entry = JSON.parse(await readFile(path, 'utf8'));
  delete entry.refreshDurationsMs;
  await writeFile(path, JSON.stringify(entry));
  f.advance(10000);
  assert.equal((await f.service.get('bugs', adaptive)).refreshStatus, 'scheduled');
  await f.service.setProfile('bugs', { ...profile, query: 'label:changed' });
  assert.equal((await f.service.get('bugs', adaptive)).fromCache, false);
  assert.equal(f.queries(), 2);
});

test('default, cached-only and forced-refresh policies are unchanged by timing history', async t => {
  const f = await fixture(t);
  f.duration(5000);
  await f.service.get('bugs');
  f.advance(10000);
  assert.equal((await f.service.get('bugs', { cachedOnly: true })).stale, true);
  assert.equal(f.queries(), 1);
  assert.equal((await f.service.get('bugs')).fromCache, false);
  assert.equal((await f.service.get('bugs', { refresh: true })).fromCache, false);
  assert.equal(f.queries(), 3);
  assert.equal(f.scheduled.length, 0);
});

test('foreground failures retain the previous cache and background startup failures are explicit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.service.get('bugs', { refresh: true });
  f.advance(10000);
  const before = await readFile(f.service.cachePath('bugs'), 'utf8');
  f.service.query = async () => { throw new DevDashError('CLI_FAILED', 'Synthetic failure.'); };
  await assert.rejects(f.service.get('bugs', adaptive), { code: 'CLI_FAILED' });
  assert.equal(await readFile(f.service.cachePath('bugs'), 'utf8'), before);
  f.service.scheduleRefresh = async () => { throw new DevDashError('BACKGROUND_START_FAILED', 'Synthetic startup failure.'); };
  await assert.rejects(f.service.get('bugs', { ...adaptive, fastQueryMs: 1 }), { code: 'BACKGROUND_START_FAILED' });
});

test('adaptive mode applies independently to grouped queries and reports timing status', async t => {
  const f = await fixture(t);
  await f.service.setProfile('group', { refreshSeconds: 10, queries: {
    fast: { ...profile, refreshSeconds: 10 }, slow: { ...profile, refreshSeconds: 10 },
    fresh: { ...profile, refreshSeconds: 30 }, missing: { ...profile, refreshSeconds: 10 },
  } });
  for (let i = 0; i < 3; i++) await f.service.get('group', { query: 'fast', refresh: true });
  await f.service.get('group', { query: 'slow' });
  await f.service.get('group', { query: 'fresh' });
  f.advance(10000);
  const result = await f.service.get('group', adaptive);
  assert.equal(result.queries.fast.refreshStatus, 'complete');
  assert.equal(result.queries.slow.refreshStatus, 'scheduled');
  assert.equal(result.queries.fresh.refreshStatus, 'fresh');
  assert.equal(result.queries.missing.refreshStatus, 'complete');
  assert.equal(result.failed, 0);
  assert.equal(f.scheduled[0].queryName, 'slow');
});

test('invalid cache policies, thresholds and persisted timing values are rejected', async t => {
  const f = await fixture(t);
  for (const options of [
    { cacheMode: 'unknown' }, { ...adaptive, cachedOnly: true }, { ...adaptive, refresh: true }, { ...adaptive, due: true },
    { fastQueryMs: 500 }, { ...adaptive, fastQueryMs: 0 }, { ...adaptive, fastQueryMs: 60001 }, { ...adaptive, fastQueryMs: 2.5 },
  ]) await assert.rejects(f.service.get('bugs', options), { code: 'INVALID_ARGUMENT' });
  await f.service.get('bugs');
  const path = f.service.cachePath('bugs');
  const entry = JSON.parse(await readFile(path, 'utf8'));
  for (const values of [[], [-1], ['100'], Array(6).fill(100)]) {
    await writeFile(path, JSON.stringify({ ...entry, refreshDurationsMs: values }));
    await assert.rejects(f.service.get('bugs', adaptive), { code: 'INVALID_CACHE' });
  }
});

test('malformed worker state is explicit and cache clear repairs state and resets history', async t => {
  const f = await fixture(t);
  await f.service.get('bugs');
  const jobPath = `${f.service.cachePath('bugs')}.background.json`;
  await writeFile(jobPath, JSON.stringify({ state: 'running', pid: -1 }));
  await assert.rejects(f.service.cacheStatus('bugs'), { code: 'INVALID_CACHE' });
  await f.service.clearCache('bugs');
  const cleared = await f.service.cacheStatus('bugs');
  assert.equal(cleared.cached, false);
  assert.equal(cleared.backgroundRefresh, null);
  assert.deepEqual(cleared.refreshTiming, { samples: 0, maxMs: null });
});

test('a cleared worker reservation prevents both queued provider work and an obsolete cache commit', async t => {
  const f = await fixture(t);
  await f.service.get('bugs');
  f.advance(10000);
  const before = await readFile(f.service.cachePath('bugs'), 'utf8');
  const definition = await f.service.profile('bugs');
  for (const cancelAt of [1, 2]) {
    let checks = 0;
    await assert.rejects(f.service.getQuerySnapshot('bugs', definition, undefined, {
      refresh: true, due: true,
      assertReservation: async () => {
        if (++checks === cancelAt) throw new DevDashError('BACKGROUND_CANCELLED', 'Synthetic cleared reservation.');
      },
    }), { code: 'BACKGROUND_CANCELLED' });
    assert.equal(checks, cancelAt);
    assert.equal(await readFile(f.service.cachePath('bugs'), 'utf8'), before);
  }
  assert.equal(f.queries(), 2);
});
