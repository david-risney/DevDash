import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { createTestProvider, testItem } from './helpers/test-provider.js';

const profile = { provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 60 };
const response = items => ({ items, truncated: false });

test('reusable synthetic adapter traverses validation, filtering, cache refresh, and failure preservation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-test-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = testItem();
  const second = testItem({ id: '2', title: 'Synthetic feature', labels: [] });
  const provider = createTestProvider({ responses: [response([first, second]), response([second])] });
  const service = new DevDash({ home }, { queryProfile: provider.queryProfile });
  await service.setProfile('synthetic', { ...profile, filter: 'labels:regression' });
  assert.deepEqual((await service.get('synthetic')).items, [first]);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].filter, undefined);
  assert.deepEqual((await service.get('synthetic', { cachedOnly: true })).items, [first]);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual((await service.get('synthetic', { refresh: true })).items, []);
  provider.enqueue(new DevDashError('CLI_FAILED', 'Synthetic failure.'));
  await assert.rejects(service.get('synthetic', { refresh: true }), { code: 'CLI_FAILED' });
  assert.deepEqual((await service.get('synthetic', { cachedOnly: true })).items, []);
});

test('synthetic providers exercise the real result contract and explicitly reject missing responses', async () => {
  const provider = createTestProvider({ responses: [response([testItem({ id: 1 })])] });
  await assert.rejects(provider.queryProfile(profile), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(provider.queryProfile(profile), { code: 'TEST_RESPONSE_MISSING' });
  provider.enqueue(response([testItem()]));
  assert.equal((await provider.queryProfile(profile)).items.length, 1);
  assert.equal(provider.calls.length, 3);
});
