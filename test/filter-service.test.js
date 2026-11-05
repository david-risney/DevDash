import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { executeCommand } from '../src/commands.js';
import { frameMessage } from '../src/native.js';

const execute = promisify(execFile);
const base = {
  id: '1', title: 'Fix cache memory leak', state: 'open', url: 'https://example.com/1',
  author: 'Alice', assignees: [], labels: ['regression'], repository: 'owner/repo',
  createdAt: null, updatedAt: null, draft: false, providerData: {},
};
const githubRows = [
  { ...base, provider: 'github', kind: 'bug' },
  { ...base, id: '2', provider: 'github', kind: 'bug', state: 'closed', labels: ['enhancement'] },
];
const adoRows = [
  { ...base, provider: 'ado', kind: 'pr', sourceBranch: 'feature/cache', targetBranch: 'main', reviewers: ['Bob'],
    providerData: { mergeStatus: 'succeeded', reviewerVotes: [{ reviewer: 'Bob', vote: 0, required: true }] } },
  { ...base, id: '2', provider: 'ado', kind: 'pr', draft: true, sourceBranch: 'feature/other', targetBranch: 'main', reviewers: [] },
];
const chromiumRows = [
  { ...base, provider: 'chromium', kind: 'bug', id: '411731002', priority: 'P2', severity: 'S2', type: 'Bug', providerData: { component: 'UI' } },
  { ...base, provider: 'chromium', kind: 'bug', id: '411731003', priority: 'P1', severity: 'S1', type: 'Bug', providerData: { component: null } },
];
const grouped = () => ({
  refreshSeconds: 300,
  queries: {
    github: { provider: 'github', resource: 'bugs', repository: 'owner/repo', query: 'sort:updated',
      filter: 'title:cache labels:regression' },
    ado: { provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/org', project: 'Project',
      query: { author: 'Alice', targetBranch: 'main' }, filter: 'draft:false source-branch:cache reviewer:Bob' },
    chromium: { provider: 'chromium', resource: 'bugs', query: { bugIds: ['411731002', '411731003'] },
      filter: 'priority:p2 providerData.component:ui', refreshSeconds: 900 },
  },
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-filter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let fail = false;
  const service = new DevDash({ home }, {
    queryProfile: async profile => {
      calls.push(structuredClone(profile));
      assert.equal(Object.hasOwn(profile, 'filter'), false);
      if (fail) throw new DevDashError('CLI_FAILED', 'SECRET_PROVIDER_FAILURE');
      const items = { github: githubRows, ado: adoRows, chromium: chromiumRows }[profile.provider];
      return { items, truncated: profile.provider === 'ado' };
    },
  });
  return { home, service, calls, setFail: value => { fail = value; } };
}

test('filters run on normalized provider results before each named cache, keeping provider truncation', async t => {
  const { service, calls } = await fixture(t);
  await service.setProfile('dashboard', grouped());
  const fresh = await service.get('dashboard');
  assert.equal(fresh.failed, 0);
  assert.deepEqual(fresh.queries.github.items, [githubRows[0]]);
  assert.deepEqual(fresh.queries.ado.items, [adoRows[0]]);
  assert.deepEqual(fresh.queries.chromium.items, [chromiumRows[0]]);
  assert.equal(fresh.queries.ado.truncated, true);
  assert.equal(fresh.queries.github.truncated, false);
  assert.equal(calls[1].creator, 'Alice');
  assert.equal(calls[1].targetBranch, 'main');
  assert.equal(calls[1].query, undefined);
  assert.deepEqual(calls[2].bugIds, ['411731002', '411731003']);
  const cached = await service.get('dashboard');
  assert.equal(cached.fromCache, true);
  assert.equal(calls.length, 3);
  const disk = JSON.parse(await readFile(service.cachePath('dashboard', 'ado'), 'utf8'));
  assert.deepEqual(disk.items, [adoRows[0]]);
  assert.equal((await service.cacheStatus('dashboard', { query: 'ado' })).count, 1);
  const entries = (await service.diagnostics.tail({ lines: 1000 })).entries.filter(entry => entry.event === 'filter.complete');
  assert.equal(entries.length, 3);
  assert.ok(entries.every(entry => entry.sourceCount === 2 && entry.count === 1 && entry.removedCount === 1));
  const logs = await readFile(service.diagnostics.file, 'utf8');
  assert.equal(logs.includes('priority:p2'), false);
  assert.equal(logs.includes('draft:false'), false);
  assert.equal(logs.includes(base.title), false);
  await service.setProfile('no-matches', {
    ...grouped().queries.ado, refreshSeconds: 300, filter: 'title:no-matches',
  });
  const empty = await service.get('no-matches');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.truncated, true);
});

test('filter edits invalidate only the selected query and zero matches are an explicit complete list', async t => {
  const { service, calls } = await fixture(t);
  await service.setProfile('dashboard', grouped());
  await service.get('dashboard');
  const changed = grouped();
  changed.queries.github.filter = 'state:closed';
  await service.setProfile('dashboard', changed);
  await assert.rejects(service.get('dashboard', { cachedOnly: true, query: 'github' }), { code: 'CACHE_MISS' });
  assert.equal((await service.get('dashboard', { cachedOnly: true, query: 'ado' })).fromCache, true);
  const result = await service.get('dashboard');
  assert.deepEqual(result.queries.github.items, [githubRows[1]]);
  assert.equal(result.queries.ado.fromCache, true);
  assert.equal(calls.length, 4);
  changed.queries.github.filter = 'title:does-not-exist';
  await service.setProfile('dashboard', changed);
  const empty = await service.get('dashboard', { query: 'github' });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.truncated, false);
});

test('invalid filters preserve configuration, partial provider failures preserve filtered snapshots', async t => {
  const { service, calls, setFail } = await fixture(t);
  await service.setProfile('dashboard', grouped());
  await service.get('dashboard');
  const before = await readFile(service.paths.config, 'utf8');
  const changed = grouped();
  changed.queries.ado.filter = 'unsupported:SECRET_FILTER_VALUE';
  await assert.rejects(service.setProfile('dashboard', changed), { code: 'INVALID_FILTER' });
  assert.equal(await readFile(service.paths.config, 'utf8'), before);
  assert.equal(calls.length, 3);
  setFail(true);
  const failure = await executeCommand(['refresh', 'dashboard'], { service });
  assert.equal(failure.exitCode, 2);
  assert.equal(failure.output.failed, 3);
  assert.equal(failure.output.queries.ado.error.code, 'CLI_FAILED');
  const cached = await service.get('dashboard', { cachedOnly: true });
  assert.deepEqual(cached.queries.ado.items, [adoRows[0]]);
  const logs = await readFile(service.diagnostics.file, 'utf8');
  assert.equal(logs.includes('SECRET_FILTER_VALUE'), false);
  assert.equal(logs.includes('SECRET_PROVIDER_FAILURE'), false);
});

test('changing only a filter during a refresh prevents an obsolete result being cached', async t => {
  const { home } = await fixture(t);
  let start;
  let release;
  const started = new Promise(resolve => { start = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const service = new DevDash({ home }, {
    queryProfile: async () => { start(); await blocked; return { items: githubRows, truncated: false }; },
  });
  const profile = { ...grouped().queries.github, refreshSeconds: 300 };
  await service.setProfile('bugs', profile);
  const refresh = service.get('bugs');
  await started;
  await service.setProfile('bugs', { ...profile, filter: 'state:closed' });
  release();
  await assert.rejects(refresh, { code: 'PROFILE_CHANGED' });
  await assert.rejects(service.get('bugs', { cachedOnly: true }), { code: 'CACHE_MISS' });
});

test('CLI and native consumers share filtered cached lists while definitions keep query and filter separate', async t => {
  const { home, service } = await fixture(t);
  await service.setProfile('dashboard', grouped());
  await service.get('dashboard');
  const env = { ...process.env, DEVDASH_HOME: home };
  const cli = fileURLToPath(new URL('../bin/devdash.js', import.meta.url));
  const native = fileURLToPath(new URL('../bin/devdash-native.js', import.meta.url));
  const output = await execute(process.execPath, [cli, 'get', 'dashboard', '--cached-only'], { env, windowsHide: true });
  assert.equal(output.stderr, '');
  assert.deepEqual(JSON.parse(output.stdout).queries.ado.items, [adoRows[0]]);
  const definition = await execute(process.execPath, [cli, 'profile', 'get', 'dashboard'], { env, windowsHide: true });
  const profile = JSON.parse(definition.stdout).profile;
  assert.equal(profile.queries.ado.query.author, 'Alice');
  assert.equal(profile.queries.ado.creator, undefined);
  assert.equal(profile.queries.ado.filter, grouped().queries.ado.filter);
  const child = execute(process.execPath, [native], { env, windowsHide: true, encoding: 'buffer' });
  child.child.stdin.end(frameMessage({ command: 'get', profile: 'dashboard', query: 'chromium', cachedOnly: true }));
  const result = await child;
  assert.equal(result.stderr.length, 0);
  const size = endianness() === 'LE' ? result.stdout.readUInt32LE() : result.stdout.readUInt32BE();
  assert.equal(result.stdout.length, size + 4);
  assert.deepEqual(JSON.parse(result.stdout.subarray(4).toString('utf8')).items, [chromiumRows[0]]);
});
