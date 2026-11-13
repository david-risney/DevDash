import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { providerProfile } from '../src/query.js';
import { validateConfig, effectiveProfile } from '../src/config.js';
import { queryWebUrl } from '../src/providers.js';

const scope = { provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/org', project: 'Project', repository: 'Repo', refreshSeconds: 300 };
const saved = '01234567-89ab-cdef-0123-456789abcdef';
const validate = profile => validateConfig({ version: 1, profiles: { test: profile } });

test('GitHub authentication is explicitly gh or anonymous and never stores a PAT', () => {
  const github = { provider: 'github', resource: 'bugs', repository: 'owner/repo', refreshSeconds: 300 };
  for (const auth of ['gh', 'anonymous']) {
    const profile = { ...github, auth };
    validate(profile);
    assert.equal(providerProfile(profile).auth, auth);
    validate({ refreshSeconds: 300, queries: { public: profile } });
  }
  for (const auth of ['pat', 'PRIVATE_TOKEN', '', null, {}, true]) {
    assert.throws(() => validate({ ...github, auth }), { code: 'INVALID_CONFIG' });
    assert.throws(() => providerProfile({ ...github, auth }), { code: 'INVALID_PROFILE' });
  }
  assert.throws(() => validate({ ...github, auth: 'anonymous', token: 'PRIVATE_TOKEN' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validate({ ...scope, auth: 'anonymous' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => providerProfile({ ...scope, auth: 'anonymous' }), { code: 'INVALID_PROFILE' });
});

test('ADO OR identity arrays and workItemTypes agree between schema and provider lowering', () => {
  const query = { author: ['Alice', 'Bob'], reviewer: ['Carol', 'Dave'], status: 'active' };
  validate({ ...scope, query });
  assert.deepEqual(providerProfile({ ...scope, query }), {
    ...scope, creator: query.author, reviewer: query.reviewer, status: 'active',
  });
  const bugScope = { ...scope, resource: 'bugs', repository: undefined,
    query: { wiql: 'SELECT [System.Id] FROM WorkItems' }, workItemTypes: ['Bug', 'Task', 'User Story'] };
  validate(JSON.parse(JSON.stringify(bugScope)));
  assert.deepEqual(providerProfile(bugScope).workItemTypes, bugScope.workItemTypes);
  for (const value of [[], ['Alice', 'Alice'], [''], [' '], ['Alice\nBob'], [1], null, Array.from({ length: 21 }, (_, i) => String(i))]) {
    for (const field of ['author', 'reviewer']) {
      assert.throws(() => validate({ ...scope, query: { [field]: value } }), { code: 'INVALID_CONFIG' });
      assert.throws(() => providerProfile({ ...scope, query: { [field]: value } }), { code: 'INVALID_PROFILE' });
    }
    assert.throws(() => validate(JSON.parse(JSON.stringify({ ...bugScope, workItemTypes: value }))), { code: 'INVALID_CONFIG' });
    assert.throws(() => providerProfile({ ...bugScope, workItemTypes: value }), { code: 'INVALID_PROFILE' });
  }
  assert.throws(() => validate({ ...scope, workItemTypes: ['Bug'] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => providerProfile({ ...scope, workItemTypes: ['Bug'] }), { code: 'INVALID_PROFILE' });
});

test('query web links preserve native search scope and use honest closest pages for unsupported web filters', () => {
  const gh = { provider: 'github', resource: 'prs', repository: 'owner/repo', query: 'author:@me "memory leak"', filter: 'title:local' };
  const before = structuredClone(gh);
  const url = new URL(queryWebUrl(gh));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'author:@me "memory leak" repo:owner/repo is:pr');
  assert.equal(url.searchParams.get('type'), 'pullrequests');
  assert.ok(!url.href.includes('local'));
  assert.deepEqual(gh, before);
  const bugs = new URL(queryWebUrl({ ...gh, hostname: 'github.example.com', resource: 'bugs', query: undefined }));
  assert.equal(bugs.origin, 'https://github.example.com');
  assert.equal(bugs.searchParams.get('q'), 'state:open repo:owner/repo is:issue');
  assert.equal(bugs.searchParams.get('type'), 'issues');
  const ado = { ...scope, project: 'Project space', repository: 'Repo space' };
  assert.equal(queryWebUrl({ ...ado, resource: 'bugs', query: { queryId: saved } }),
    `https://dev.azure.com/org/Project%20space/_queries/query/${saved}`);
  assert.equal(queryWebUrl({ ...ado, resource: 'bugs', queryId: saved }),
    `https://dev.azure.com/org/Project%20space/_queries/query/${saved}`);
  assert.equal(queryWebUrl({ ...ado, resource: 'bugs', query: { wiql: 'SELECT [System.Id] FROM WorkItems' } }),
    'https://dev.azure.com/org/Project%20space/_queries');
  assert.equal(queryWebUrl({ ...ado, query: { author: 'Alice', status: 'completed' } }),
    'https://dev.azure.com/org/Project%20space/_git/Repo%20space/pullrequests');
  assert.equal(queryWebUrl({ ...ado, repository: undefined }), 'https://dev.azure.com/org/Project%20space/_git/pullrequests');
  const chromium = { provider: 'chromium', resource: 'bugs', query: 'type:bug status:open "memory leak"' };
  const search = new URL(queryWebUrl(chromium));
  assert.equal(search.origin, 'https://issues.chromium.org');
  assert.equal(search.searchParams.get('q'), chromium.query);
  assert.equal(queryWebUrl({ ...chromium, query: { bugIds: ['1'] } }), 'https://issues.chromium.org/issues/1');
  assert.equal(queryWebUrl({ ...chromium, query: { bugIds: ['1', '2'] } }), 'https://issues.chromium.org/issues');
  const gerrit = queryWebUrl({ provider: 'chromium', resource: 'cls', host: 'https://gerrit.example.com/', project: 'example/src', query: 'owner:Alice status:open' });
  assert.equal(gerrit, 'https://gerrit.example.com/q/' + encodeURIComponent('owner:Alice status:open project:"example/src"'));
});

test('structured native queries lower to provider arguments without local filter leakage or mutation', () => {
  const profile = { ...scope, query: { author: 'Alice', reviewer: 'Bob', sourceBranch: 'feature/cache', targetBranch: 'main', status: 'all' }, filter: 'title:cache' };
  const snapshot = structuredClone(profile);
  assert.deepEqual(providerProfile(profile), {
    ...scope, creator: 'Alice', reviewer: 'Bob', sourceBranch: 'feature/cache', targetBranch: 'main', status: 'all',
  });
  assert.deepEqual(profile, snapshot);
  assert.deepEqual(providerProfile({ ...scope, query: {} }), scope);
  assert.deepEqual(providerProfile({ ...scope, resource: 'bugs', query: { wiql: 'SELECT [System.Id]\nFROM WorkItems' } }),
    { ...scope, resource: 'bugs', query: 'SELECT [System.Id]\nFROM WorkItems' });
  assert.deepEqual(providerProfile({ ...scope, resource: 'bugs', query: { queryId: saved } }),
    { ...scope, resource: 'bugs', queryId: saved });
  assert.deepEqual(providerProfile({ provider: 'chromium', resource: 'bugs', query: { bugIds: ['1'] }, filter: 'state:open' }),
    { provider: 'chromium', resource: 'bugs', bugIds: ['1'] });
  assert.deepEqual(providerProfile({ provider: 'chromium', resource: 'bugs', query: 'type:bug status:open', filter: 'priority:p2' }),
    { provider: 'chromium', resource: 'bugs', query: 'type:bug status:open' });
});

test('schema accepts provider-specific query shapes, filters, and unchanged legacy definitions', () => {
  for (const profile of [
    { ...scope, query: { author: 'you@example.com', sourceBranch: 'feature/x', targetBranch: 'main', status: 'active' }, filter: 'title:cache draft:false' },
    { ...scope, query: {} },
    { ...scope, creator: 'you@example.com', reviewer: 'other', status: 'all', filter: '' },
    { ...scope, resource: 'bugs', repository: undefined, query: { wiql: 'SELECT [System.Id]\nFROM WorkItems' }, filter: 'tags:security' },
    { ...scope, resource: 'bugs', repository: undefined, query: { queryId: saved } },
    { ...scope, resource: 'bugs', repository: undefined, queryId: saved },
    { provider: 'chromium', resource: 'bugs', query: { bugIds: ['1', '2'] }, filter: 'priority:p2', refreshSeconds: 900 },
    { provider: 'chromium', resource: 'bugs', bugIds: ['1'], refreshSeconds: 900 },
    { provider: 'chromium', resource: 'bugs', query: 'type:bug status:open', filter: 'priority:p2', refreshSeconds: 900 },
    { provider: 'chromium', resource: 'cls', query: 'status:open (owner:Alice OR reviewer:Alice)', filter: 'subject:cache branch:main', refreshSeconds: 300 },
    { provider: 'github', resource: 'prs', repository: 'owner/repo', query: 'is:open author:@me', filter: 'state:open "memory leak"', refreshSeconds: 120 },
  ]) assert.doesNotThrow(() => validate(JSON.parse(JSON.stringify(profile))));
  const group = { refreshSeconds: 300, queries: { prs: { ...scope, refreshSeconds: undefined, query: { author: 'Alice' }, filter: 'title:cache' } } };
  validate(JSON.parse(JSON.stringify(group)));
  assert.equal(effectiveProfile(group).queries.prs.filter, 'title:cache');
});

test('unsupported, conflicting, ill-typed and empty native query options cannot widen a search', () => {
  for (const profile of [
    { ...scope, query: 'author:Alice' }, { ...scope, query: { title: 'cache' } },
    { ...scope, query: { author: '' } }, { ...scope, query: { author: '  ' } },
    { ...scope, query: { author: 'Alice\nBob' } }, { ...scope, query: { author: 'Alice\u007f' } },
    { ...scope, query: { targetBranch: 1 } }, { ...scope, query: { status: 'open' } },
    { ...scope, query: { author: 'Alice' }, creator: 'Alice' },
    { ...scope, query: {}, reviewer: 'Bob' }, { ...scope, query: {}, status: 'all' },
    { ...scope, resource: 'bugs', repository: undefined, query: {} },
    { ...scope, resource: 'bugs', repository: undefined, query: { wiql: 'SELECT', queryId: saved } },
    { ...scope, resource: 'bugs', repository: undefined, query: { wiql: 'SELECT' }, queryId: saved },
    { ...scope, resource: 'bugs', repository: undefined, query: { queryId: 'not-guid' } },
    { provider: 'chromium', resource: 'bugs', query: { bugIds: [] }, refreshSeconds: 900 },
    { provider: 'chromium', resource: 'bugs', query: { bugIds: ['1', '1'] }, refreshSeconds: 900 },
    { provider: 'chromium', resource: 'bugs', query: { bugIds: ['1'] }, bugIds: ['1'], refreshSeconds: 900 },
    ...['', ' ', 'type:bug\nstatus:open', 'type:bug\u007f'].map(query =>
      ({ provider: 'chromium', resource: 'bugs', query, refreshSeconds: 900 })),
    { provider: 'chromium', resource: 'bugs', query: 'type:bug', bugIds: ['1'], refreshSeconds: 900 },
    { provider: 'github', resource: 'prs', repository: 'owner/repo', query: { author: 'Alice' }, refreshSeconds: 300 },
  ]) assert.throws(() => validate(JSON.parse(JSON.stringify(profile))), { code: 'INVALID_CONFIG' });
  for (const query of [{ unknown: 'SECRET_QUERY' }, { author: null }, { author: ' ' }, { status: 'open' }, null, []]) {
    assert.throws(() => providerProfile({ ...scope, query }), { code: 'INVALID_PROFILE' });
  }
  assert.throws(() => providerProfile({ ...scope, query: {}, creator: 'Alice' }), { code: 'INVALID_PROFILE' });
});

test('filter validation is provider-aware for grouped and flat configuration and never echoes values', () => {
  for (const filter of ['reviewer:', 'unknown:SECRET_FILTER_VALUE', 'priority:p2', 'title:"unfinished', 'branch:main']) {
    assert.throws(() => validate({ ...scope, filter }), error =>
      error.code === 'INVALID_FILTER' && !error.message.includes('SECRET_FILTER_VALUE'));
  }
  assert.throws(() => validate({ refreshSeconds: 300, queries: { prs: { ...scope, filter: 'title:' } } }),
    { code: 'INVALID_FILTER' });
});

test('JavaScript filter objects validate in flat/grouped profiles and never reach provider-native queries', () => {
  const filter = {
    language: 'javascript',
    expression: 'item.providerData.votes.some(v => v.reviewer === params.me && v.vote === 0)',
    params: { me: 'Alice', nested: { enabled: true, values: [null, 1, 'text'] } },
  };
  assert.doesNotThrow(() => validate({ ...scope, filter }));
  assert.doesNotThrow(() => validate({ refreshSeconds: 300, queries: { prs: { ...scope, filter } } }));
  assert.equal(Object.hasOwn(providerProfile({ ...scope, filter }), 'filter'), false);
  for (const bad of [{ ...filter, language: 'js' }, { ...filter, extra: true }, { ...filter, params: null },
    { ...filter, params: [] }, { expression: 'true' }]) {
    assert.throws(() => validate({ ...scope, filter: bad }), { code: 'INVALID_CONFIG' });
  }
  for (const expression of ['item.', 'true; false', "'SECRET_FILTER_VALUE' +"]) {
    assert.throws(() => validate({ ...scope, filter: { language: 'javascript', expression } }), error =>
      error.code === 'INVALID_FILTER' && !error.message.includes('SECRET_FILTER_VALUE'));
  }
});

test('canonical standalone examples and the grouped filter example match the configuration schema', async () => {
  for (const name of ['edge', 'filtered', 'javascript-filter', 'chromium-bugs', 'chromium-bug-search', 'github-prs']) {
    const profile = JSON.parse(await readFile(new URL(`../examples/${name}.profile.json`, import.meta.url), 'utf8'));
    assert.doesNotThrow(() => validate(profile), name);
  }
  const live = JSON.parse(await readFile(new URL('../examples/e2e.config.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateConfig(live));
});
