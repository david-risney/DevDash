import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { queryProfile } from '../src/providers.js';
import { runJson } from '../src/process.js';

const item = {
  provider: 'chromium', kind: 'bug', id: '411731002', title: 'PUBLIC_BUG_CONTENT',
  state: 'Fixed', url: 'https://issues.chromium.org/issues/411731002',
  repository: null, author: null, assignees: [], labels: [],
  createdAt: null, updatedAt: null, draft: null,
  priority: null, severity: null, type: null, providerData: { component: null },
};
const chromium = { provider: 'chromium', resource: 'bugs', bugIds: ['411731002'] };

test('Grouped Chromium CLI adapter, independent caches, failures, and correlated diagnostics remain integrated', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-cr-integration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let fail = false;
  const service = new DevDash({ home }, {
    queryProfile: (profile) => queryProfile(profile, {
      runJson: async (command, args, options) => {
        calls.push({ command, args, options });
        if (fail) throw new DevDashError('BUG_ACCESS_DENIED', 'Private issue or anonymous login required.');
        return { schemaVersion: 1, items: [item], truncated: false };
      },
    }),
  });

  await service.setProfile('public-chromium', {
    refreshSeconds: 900, queries: { bugs: chromium, tracked: { ...chromium, refreshSeconds: 120 } },
  });
  const fresh = await service.get('public-chromium');
  assert.equal(fresh.failed, 0);
  assert.deepEqual(fresh.queries.bugs.items, [item]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.command === 'cr' && call.options.env.CR_HOME === join(service.paths.logs, 'cr')));
  assert.ok(calls.every(call => /^[0-9a-f-]{36}$/.test(call.options.env.CR_REQUEST_ID)));
  assert.deepEqual(await service.get('public-chromium', { query: 'bugs' }), {
    ...fresh.queries.bugs, fromCache: true,
  });
  assert.equal(calls.length, 2);
  fail = true;
  const partial = await service.get('public-chromium', { refresh: true });
  assert.equal(partial.failed, 2);
  assert.equal(partial.queries.bugs.error.code, 'BUG_ACCESS_DENIED');
  assert.equal(typeof partial.queries.bugs.error.diagnosticId, 'string');
  assert.deepEqual((await service.get('public-chromium', { cachedOnly: true, query: 'bugs' })).items, [item]);
  const logs = await readFile(service.diagnostics.file, 'utf8');
  assert.equal(logs.includes('PUBLIC_BUG_CONTENT'), false);
  assert.equal(logs.includes('Private issue'), false);
  assert.ok(logs.includes('BUG_ACCESS_DENIED'));
  assert.equal(service.diagnostics.pathInfo().providers.cr.file,
    join(service.paths.logs, 'cr', 'logs', 'cr.jsonl'));
});

test('Actual cr executable accepts adapter flags and reports correlated network failures without HTTP access', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-cr-executable-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const localBins = fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));
  const service = new DevDash({ home }, {
    queryProfile: profile => queryProfile(profile, {
      runJson: (command, args, options) => runJson(command, args, {
        ...options,
        env: { ...options?.env, PATH: [localBins, process.env.PATH ?? process.env.Path].join(delimiter) },
      }),
    }),
  });

  // Fetch refuses port 1 before opening a socket.
  for (const query of ['status:merged', '-status:merged']) {
    await service.setProfile('closed-port', {
      provider: 'chromium', resource: 'cls', host: 'https://127.0.0.1:1',
      project: '-project', query, refreshSeconds: 300, limit: 1,
    });
    await assert.rejects(service.get('closed-port'), { code: 'PROVIDER_NETWORK' });
  }
  const childLogs = await readFile(service.diagnostics.pathInfo().providers.cr.file, 'utf8');
  const rootEntries = (await readFile(service.diagnostics.file, 'utf8')).trim().split('\n').map(JSON.parse);
  const childEntries = childLogs.trim().split('\n').map(JSON.parse);
  const rootFailures = rootEntries.filter(entry => entry.event === 'provider.query.failed');
  assert.equal(rootFailures.length, 2);
  assert.ok(rootFailures.every(failure => childEntries.some(entry =>
    entry.code === 'PROVIDER_NETWORK' && entry.requestId === failure.requestId)));
  assert.equal(childLogs.includes('status:merged'), false);
  assert.equal(childLogs.includes('127.0.0.1'), false);
});

test('Chromium search has independent filtered caches, invalidation and failure preservation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-cr-search-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let fail = false;
  const service = new DevDash({ home }, {
    queryProfile: profile => queryProfile(profile, { runJson: async (command, args) => {
      calls.push({ command, args });
      if (fail) throw new DevDashError('BUG_TIMEOUT', 'Search timed out.');
      return { schemaVersion: 1, items: [item], truncated: args[1] === 'list' };
    } }),
  });
  const profile = { refreshSeconds: 900, queries: {
    tracked: chromium,
    search: { provider: 'chromium', resource: 'bugs', query: 'type:bug title:PRIVATE_SEARCH', filter: 'state:fixed' },
  } };
  await service.setProfile('bugs', profile);
  const first = await service.get('bugs');
  assert.equal(first.failed, 0);
  assert.deepEqual(first.queries.search.items, [item]);
  assert.equal(first.queries.search.truncated, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.find(call => call.args[1] === 'list').args,
    ['bugs', 'list', '--query=type:bug title:PRIVATE_SEARCH', '--limit', '1000']);
  fail = true;
  await assert.rejects(service.get('bugs', { query: 'search', refresh: true }), { code: 'BUG_TIMEOUT' });
  assert.deepEqual((await service.get('bugs', { query: 'search', cachedOnly: true })).items, [item]);
  profile.queries.search.query = 'type:bug title:OTHER_SEARCH';
  await service.setProfile('bugs', profile);
  await assert.rejects(service.get('bugs', { query: 'search', cachedOnly: true }), { code: 'CACHE_MISS' });
  assert.deepEqual((await service.get('bugs', { query: 'tracked', cachedOnly: true })).items, [item]);
  assert.doesNotMatch(await readFile(service.diagnostics.file, 'utf8'), /PRIVATE_SEARCH|OTHER_SEARCH|PUBLIC_BUG_CONTENT/);
});
