import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryProfile } from '../src/providers.js';
import { validateConfig } from '../src/config.js';
import { providerProfile } from '../src/query.js';
import { validateQueryResult } from '../src/providers/contract.js';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';

const profile = {
  provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/example',
  project: 'Project', repository: 'Repo', limit: 2, refreshSeconds: 300,
  include: { properties: ['ReviewMetadata'] },
};
const row = number => ({
  pullRequestId: number, title: `PR ${number}`, status: 'active', isDraft: false,
  repository: { id: 'repository-id', name: 'Repo', project: { name: 'Project' } },
  createdBy: { uniqueName: 'author@example.com' }, creationDate: null, reviewers: [],
});
const property = value => ({ $type: 'System.String', $value: JSON.stringify(value) });
const envelope = value => ({ count: Object.keys(value).length, value });

test('PR property enrichment is opt-in, selected-only, bounded to retained PRs, and precedes filtering', async () => {
  const calls = [];
  const runJson = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'repos') return [row(1), row(2), row(3)];
    const number = Number(args.find(arg => arg.startsWith('pullRequestId=')).split('=')[1]);
    return envelope({
      ReviewMetadata: property({ pending: number === 2 }),
      UnrequestedProperty: property({ private: 'NOT_PERSISTED' }),
    });
  };
  const result = await queryProfile({
    ...profile,
    filter: { language: 'javascript', expression: 'JSON.parse(item.providerData.properties[params.key].$value).pending', params: { key: 'ReviewMetadata' } },
  }, { runJson });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map(item => item.id), ['2']);
  assert.deepEqual(Object.keys(result.items[0].providerData.properties), ['ReviewMetadata']);
  const requests = calls.filter(call => call.args[0] === 'devops');
  assert.equal(requests.length, 2);
  for (const { command, args } of requests) {
    assert.equal(command, 'az');
    for (const token of ['pullRequestProperties', 'GET', '7.1', 'project=Project',
      'repositoryId=repository-id', 'keys=ReviewMetadata', profile.organization, '--detect', 'false']) {
      assert.ok(args.includes(token), token);
    }
    assert.equal(args.includes('pullRequestId=3'), false);
  }
  const plainCalls = [];
  const { include, ...plain } = profile;
  const plainResult = await queryProfile(plain, { runJson: async (...args) => { plainCalls.push(args); return [row(1)]; } });
  assert.equal(plainCalls.length, 1);
  assert.equal(Object.hasOwn(plainResult.items[0].providerData, 'properties'), false);
});

test('successful missing properties stay explicitly empty; read, shape, and partial-collection failures are errors', async () => {
  const execute = response => queryProfile(profile, {
    runJson: async (_command, args) => {
      if (args[0] === 'repos') return [row(1)];
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.deepEqual((await execute(envelope({}))).items[0].providerData.properties, {});
  for (const response of [
    null, {}, { count: 1, value: {} }, { count: 0, value: [] },
    { count: 0, value: {}, continuation_token: 'more' },
    envelope({ ReviewMetadata: { $type: 'System.String' } }),
    envelope({ ReviewMetadata: { $type: 'System.String', $value: {} } }),
    envelope({ ReviewMetadata: { $type: 'System.String', $value: 'x'.repeat(1024 * 1024) } }),
    new DevDashError('CLI_FAILED', 'SECRET_PROVIDER_TEXT'),
  ]) await assert.rejects(execute(response), error =>
    ['CLI_FAILED', 'PROVIDER_RESPONSE', 'INVALID_PROVIDER_RESPONSE'].includes(error.code) &&
      !error.message.includes('SECRET_PROVIDER_TEXT'));
});

test('property hydration preserves ordering with at most four requests in flight', async () => {
  let running = 0, maximum = 0, requests = 0;
  const result = await queryProfile({ ...profile, limit: 8 }, {
    runJson: async (_command, args) => {
      if (args[0] === 'repos') return Array.from({ length: 9 }, (_, index) => row(index + 1));
      requests++;
      maximum = Math.max(maximum, ++running);
      await new Promise(resolve => setTimeout(resolve, 10));
      running--;
      return envelope({ ReviewMetadata: property({ ready: true }) });
    },
  });
  assert.equal(maximum, 4);
  assert.equal(requests, 8);
  assert.deepEqual(result.items.map(item => item.id), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(result.truncated, true);
});

test('property references must have explicit repository identity and cannot widen the configured repository', async () => {
  for (const repository of [
    { name: 'Repo', project: { name: 'Project' } },
    { id: 'other-id', name: 'Other', project: { name: 'Project' } },
  ]) {
    let calls = 0;
    await assert.rejects(queryProfile(profile, {
      runJson: async () => { calls++; return [{ ...row(1), repository }]; },
    }), { code: 'PROVIDER_RESPONSE' });
    assert.equal(calls, 1);
  }
});

test('schema and provider validation reject malformed include scopes before requests', () => {
  validateConfig({ version: 1, profiles: { reviews: profile } });
  assert.deepEqual(providerProfile(profile).include, profile.include);
  for (const include of [null, [], {}, { properties: [] }, { properties: ['x', 'x'] },
    { properties: ['a,b'] }, { properties: ['x\n'] }, { properties: ['x'.repeat(257)] },
    { properties: [' '] }, { properties: ['x'], extra: true }]) {
    assert.throws(() => providerProfile({ ...profile, include }), { code: 'INVALID_PROFILE' });
    assert.throws(() => validateConfig({ version: 1, profiles: { reviews: { ...profile, include } } }), { code: 'INVALID_CONFIG' });
  }
  for (const scope of [{ provider: 'ado', resource: 'bugs', query: 'SELECT [System.Id] FROM WorkItems' },
    { provider: 'github', resource: 'prs' }]) {
    assert.throws(() => providerProfile({ ...profile, ...scope }), { code: 'INVALID_PROFILE' });
  }
});

test('normalized properties require explicit opt-in and typed scalar envelopes only', async () => {
  const item = (await queryProfile(profile, { runJson: async (_command, args) =>
    args[0] === 'repos' ? [row(1)] : envelope({ ReviewMetadata: property({ ready: true }) }) })).items[0];
  for (const $value of [null, true, false, 1, 'text']) {
    assert.doesNotThrow(() => validateQueryResult(profile, { items: [
      { ...item, providerData: { properties: { ReviewMetadata: { $type: 'Example.Scalar', $value } } } },
    ], truncated: false }));
  }
  const { include, ...plain } = profile;
  assert.throws(() => validateQueryResult(plain, { items: [item], truncated: false }), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => validateQueryResult(profile, { items: [{ ...item, providerData: {} }], truncated: false }),
    { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('property failures preserve existing cache bytes and include edits invalidate the snapshot', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-property-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let failed = false;
  const service = new DevDash({ home }, {
    queryProfile: definition => queryProfile(definition, {
      runJson: async (_command, args) => {
        if (args[0] === 'repos') return [row(1)];
        if (failed) throw new DevDashError('CLI_FAILED', 'SECRET_PROPERTY_FAILURE');
        return envelope({ ReviewMetadata: property({ ready: true }) });
      },
    }),
  });
  await service.setProfile('reviews', profile);
  await service.get('reviews');
  const before = await readFile(service.cachePath('reviews'), 'utf8');
  failed = true;
  await assert.rejects(service.get('reviews', { refresh: true }), { code: 'CLI_FAILED' });
  assert.equal(await readFile(service.cachePath('reviews'), 'utf8'), before);
  const logs = await readFile(service.diagnostics.file, 'utf8');
  assert.ok(!logs.includes('SECRET_PROPERTY_FAILURE') && !logs.includes('ReviewMetadata'));
  await service.setProfile('reviews', { ...profile, include: { properties: ['OtherMetadata'] } });
  await assert.rejects(service.get('reviews', { cachedOnly: true }), { code: 'CACHE_MISS' });
});
