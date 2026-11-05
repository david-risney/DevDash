import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { watchProfiles } from '../src/watch.js';

const profile = { provider: 'github', resource: 'prs', repository: 'owner/repo', refreshSeconds: 3 };

test('watch respects per-profile expiry, picks up new profiles, and skips fresh output', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-watch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  let queries = 0;
  const service = new DevDash({ home }, {
    now: () => now,
    queryProfile: async () => { queries++; return { items: [], truncated: false }; },
  });
  await service.setProfile('first', profile);
  const events = [];
  const controller = new AbortController();
  let ticks = 0;
  await watchProfiles(service, { signal: controller.signal }, (event) => events.push(event), {
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 1000);
      ticks++;
      now += milliseconds;
      if (ticks === 2) await service.setProfile('second', { ...profile, refreshSeconds: 10 });
      if (ticks === 4) controller.abort();
    },
  });
  assert.equal(queries, 3);
  assert.deepEqual(events.map((event) => event.profile), ['first', 'second', 'first']);
  assert.equal(events.every((event) => event.event === 'refreshed' && !event.fromCache), true);
});

test('watch reports errors, preserves cache, and retries on a later poll', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-watch-error-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let attempts = 0;
  const service = new DevDash({ home }, {
    queryProfile: async () => {
      attempts++;
      if (attempts === 1) throw new DevDashError('CLI_FAILED', 'Not authenticated.');
      return { items: [], truncated: false };
    },
  });
  await service.setProfile('first', profile);
  const events = [];
  const controller = new AbortController();
  let ticks = 0;
  await watchProfiles(service, { profile: 'first', interval: 5, signal: controller.signal },
    (event) => events.push(event), {
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 5000);
        if (++ticks === 2) controller.abort();
      },
    });
  assert.deepEqual(events.map((event) => event.event), ['error', 'refreshed']);
  assert.equal((await service.get('first', { cachedOnly: true })).items.length, 0);
});

test('watch does not hide unexpected sleep errors', async () => {
  const service = { config: async () => ({}), getAll: async () => ({ results: [] }) };
  await assert.rejects(watchProfiles(service, {}, () => {}, {
    sleep: async () => { throw new Error('Unexpected timer failure.'); },
  }), /Unexpected timer failure/);
});
