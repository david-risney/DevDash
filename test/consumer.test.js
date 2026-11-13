import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DevDash } from '../src/service.js';
import { executeCommand } from '../src/commands.js';
import { frameMessage, serveNative } from '../src/native.js';
import { createTestProvider, testItem } from './helpers/test-provider.js';
import { compileFilter, filterItems } from '../src/filters.js';

const definition = { provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 300 };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic consumer gate timed out.')), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, dependencies = {}) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-consumer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = new DevDash({ home }, {
    queryProfile: async () => ({ items: Array.from({ length: 5 }, (_, i) => testItem({ id: String(i + 1) })), truncated: false }),
    env: {}, ...dependencies,
  });
  return { home, service };
}

function decode(buffer) {
  const results = [];
  while (buffer.length) {
    const length = endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
    results.push(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
    buffer = buffer.subarray(length + 4);
  }
  return results;
}

async function native(requests, dependencies) {
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
  await serveNative(Readable.from(requests.map(frameMessage)), output, dependencies);
  return decode(Buffer.concat(chunks));
}

test('query validation is read-only and the first save requires explicit freshness and a missing revision', async t => {
  const { service, home } = await fixture(t);
  const validation = await service.validateQuery('widgets', 'bugs', definition);
  assert.equal(validation.revision, 'missing');
  assert.equal(validation.valid, true);
  assert.deepEqual((await readdir(home)).sort(), ['logs']);
  await assert.rejects(service.setQuery('widgets', 'bugs', definition), { code: 'INVALID_ARGUMENT' });
  const saved = await service.setQuery('widgets', 'bugs', definition, 'missing');
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual((await service.queryDefinition('widgets', 'bugs')).definition, definition);
  await assert.rejects(service.setQuery('widgets', 'bugs', definition, 'missing'), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.setQuery('new', 'bugs', { ...definition, refreshSeconds: undefined }, 'missing'), { code: 'INVALID_ARGUMENT' });
});

test('query revisions protect the target and inherited defaults without conflicting on sibling edits', async t => {
  const { service } = await fixture(t);
  const first = await service.setQuery('widgets', 'bugs', definition, 'missing');
  await service.setQuery('widgets', 'prs', { ...definition, resource: 'prs' }, 'missing');
  assert.equal((await service.queryDefinition('widgets', 'bugs')).revision, first.revision);
  const settled = await Promise.allSettled([
    service.setQuery('widgets', 'bugs', { ...definition, query: 'label:a' }, first.revision),
    service.setQuery('widgets', 'bugs', { ...definition, query: 'label:b' }, first.revision),
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const current = await service.queryDefinition('widgets', 'bugs');
  const group = await service.profile('widgets');
  await service.setProfile('widgets', { ...group, refreshSeconds: 600 });
  await assert.rejects(service.setQuery('widgets', 'bugs', definition, current.revision), { code: 'REVISION_CONFLICT' });
  assert.equal((await service.queryDefinition('widgets', 'prs')).definition.resource, 'prs');
});

test('query removal clears only its cache and removes the group only after its last query', async t => {
  const { service } = await fixture(t);
  const bugs = await service.setQuery('widgets', 'bugs', definition, 'missing');
  const prs = await service.setQuery('widgets', 'prs', { ...definition, resource: 'prs' }, 'missing');
  await service.get('widgets');
  await service.removeQuery('widgets', 'bugs', bugs.revision);
  assert.equal((await service.get('widgets', { query: 'prs', cachedOnly: true })).items.length, 5);
  await assert.rejects(service.queryDefinition('widgets', 'bugs'), { code: 'QUERY_NOT_FOUND' });
  const removed = await service.removeQuery('widgets', 'prs', prs.revision);
  assert.equal(removed.profileRemoved, true);
  await assert.rejects(service.profile('widgets'), { code: 'PROFILE_NOT_FOUND' });
});

test('query editing never implicitly converts standalone profiles or saves invalid definitions', async t => {
  const { service } = await fixture(t);
  await service.setProfile('single', definition);
  await assert.rejects(service.setQuery('single', 'bugs', definition, 'missing'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.validateQuery('widgets', 'bugs', { ...definition, repository: 'bad' }), { code: 'INVALID_CONFIG' });
  assert.equal((await service.profile('single')).repository, definition.repository);
});

test('CLI and native query editing share validation, revisions, and stdin definitions', async t => {
  const { service } = await fixture(t);
  const deps = { service, stdin: Readable.from([JSON.stringify(definition)]) };
  const saved = await executeCommand(['query', 'set', 'widgets', 'bugs', '--file', '-', '--expected-revision', 'missing'], deps);
  const [read] = await native([{ command: 'query-get', profile: 'widgets', query: 'bugs' }], { service });
  assert.equal(read.revision, saved.output.revision);
  const [changed] = await native([{
    command: 'query-set', profile: 'widgets', query: 'bugs',
    definition: { ...definition, query: 'label:synthetic' }, expectedRevision: read.revision,
  }], { service });
  assert.notEqual(changed.revision, read.revision);
  const [conflict] = await native([{
    command: 'query-remove', profile: 'widgets', query: 'bugs', expectedRevision: read.revision,
  }], { service });
  assert.equal(conflict.error.code, 'REVISION_CONFLICT');
});

test('paged reads preserve complete query truncation metadata and return stable, projected snapshots', async t => {
  const { service } = await fixture(t);
  await service.setProfile('bugs', definition);
  const options = { pageSize: 2, fields: ['title'] };
  const first = await service.getPage('bugs', options);
  assert.equal(first.page.total, 5);
  assert.equal(first.page.offset, 0);
  assert.equal(first.truncated, false);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['id', 'kind', 'provider', 'title', 'url']);
  const second = await service.getPage('bugs', { ...options, cursor: first.page.nextCursor });
  const third = await service.getPage('bugs', { ...options, cursor: second.page.nextCursor });
  assert.equal(second.fromCache, true);
  assert.equal(second.cacheRevision, first.cacheRevision);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), ['1', '2', '3', '4', '5']);
  assert.equal(third.page.nextCursor, null);
});

test('paging rejects changed snapshots, cleared caches, mismatched scopes and invalid projections', async t => {
  const { service } = await fixture(t);
  await service.setProfile('bugs', definition);
  await service.setProfile('other', definition);
  const first = await service.getPage('bugs', { pageSize: 2 });
  for (const options of [
    { pageSize: 0 }, { pageSize: 201 }, { pageSize: 2, fields: ['secret'] },
    { pageSize: 2, fields: ['title', 'title'] }, { pageSize: 3, cursor: first.page.nextCursor },
    { pageSize: 2, fields: ['title'], cursor: first.page.nextCursor }, { cursor: 'not-json' },
  ]) await assert.rejects(service.getPage('bugs', options), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.getPage('other', { pageSize: 2, cursor: first.page.nextCursor }), { code: 'INVALID_ARGUMENT' });
  service.query = async () => ({ items: [testItem({ title: 'Changed' })], truncated: false });
  await service.get('bugs', { refresh: true });
  await assert.rejects(service.getPage('bugs', { pageSize: 2, cursor: first.page.nextCursor }), { code: 'CURSOR_EXPIRED' });
  await service.clearCache('bugs');
  await assert.rejects(service.getPage('bugs', { pageSize: 2, cursor: first.page.nextCursor }), { code: 'CURSOR_EXPIRED' });
});

test('page byte limits shrink pages without skipping results and oversized single items require projection', async t => {
  const { service } = await fixture(t, {
    queryProfile: async () => ({ items: Array.from({ length: 4 }, (_, i) => testItem({ id: String(i + 1), title: 'x'.repeat(300_000) })), truncated: true }),
  });
  await service.setProfile('bugs', definition);
  const first = await service.getPage('bugs', { pageSize: 4 });
  assert.equal(first.items.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 768 * 1024);
  const second = await service.getPage('bugs', { pageSize: 4, cursor: first.page.nextCursor });
  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].id, '3');
  service.query = async () => ({ items: [testItem({ title: 'x'.repeat(800_000) })], truncated: false });
  await service.get('bugs', { refresh: true });
  await assert.rejects(service.getPage('bugs'), { code: 'MESSAGE_TOO_LARGE' });
  assert.equal((await service.getPage('bugs', { fields: ['id'] })).items.length, 1);
});

test('provider slots bound concurrent query work across service instances sharing one configuration', async t => {
  const started = deferred(), release = deferred();
  let active = 0, maximum = 0, calls = 0;
  const { service, home } = await fixture(t, { queryProfile: async () => {
    active++;
    maximum = Math.max(active, maximum);
    if (++calls === 2) started.resolve();
    await release.promise;
    active--;
    return { items: [], truncated: false };
  } });
  for (const name of ['a', 'b', 'c', 'd']) await service.setProfile(name, definition);
  const other = new DevDash({ home }, { queryProfile: service.query, env: {} });
  const pending = Promise.all([service.get('a'), other.get('b'), service.get('c'), other.get('d')]);
  try { await waitFor(started.promise); assert.equal(maximum, 2); } finally { release.resolve(); await pending; }
  assert.equal(maximum, 2);
  assert.equal(calls, 4);
});

test('native request IDs allow independent replies without exceeding four active requests', async () => {
  const firstFour = deferred(), release = deferred();
  let active = 0, maximum = 0, calls = 0;
  const exchange = native(Array.from({ length: 8 }, (_, i) => ({ id: String(i), command: 'hello' })), {
    executeCommand: async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (++calls === 4) firstFour.resolve();
      await release.promise;
      active--;
      return { output: { ready: true } };
    },
  });
  try { await waitFor(firstFour.promise); assert.equal(maximum, 4); } finally { release.resolve(); await exchange; }
  const replies = await exchange;
  assert.equal(replies.length, 8);
  assert.equal(new Set(replies.map(result => result.id)).size, 8);
  assert.ok(replies.every(result => result.result.ready));
  assert.equal(maximum, 4);
});

test('a fast native status reply is not blocked by a slow correlated request', async () => {
  const release = deferred(), fast = deferred();
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) {
    chunks.push(chunk);
    if (decode(chunk)[0].id === 'status') fast.resolve();
    callback();
  } });
  const pending = serveNative(Readable.from([
    frameMessage({ id: 'slow', command: 'get', profile: 'bugs' }),
    frameMessage({ id: 'status', command: 'status', profile: 'bugs' }),
  ]), output, { executeCommand: async args => {
    if (args[0] === 'get') await release.promise;
    return { output: { ready: true } };
  } });
  try { await waitFor(fast.promise); assert.equal(decode(Buffer.concat(chunks))[0].id, 'status'); } finally { release.resolve(); await pending; }
  assert.equal(decode(Buffer.concat(chunks))[1].id, 'slow');
});

test('native capabilities need no provider calls and bounded errors retain their request ID', async t => {
  const { service } = await fixture(t, { queryProfile: async () => assert.fail('Unexpected provider call') });
  const [hello] = await native([{ id: 'hello', command: 'hello' }], { service });
  assert.equal(hello.result.capabilities.events, false);
  assert.equal(hello.result.capabilities.backgroundRefresh, true);
  const [oversized] = await native([{ id: 'large', command: 'hello' }], {
    executeCommand: async () => ({ output: { value: 'x'.repeat(1024 * 1024) } }),
  });
  assert.equal(oversized.id, 'large');
  assert.equal(oversized.error.code, 'MESSAGE_TOO_LARGE');
});

test('scoped health checks respect anonymous GitHub profiles and only probe required tools', async t => {
  const { service } = await fixture(t);
  await service.setQuery('widgets', 'public', { ...definition, auth: 'anonymous' }, 'missing');
  await service.setQuery('widgets', 'private', definition, 'missing');
  const operations = [];
  const dependencies = {
    service,
    runText: async (command, args) => { operations.push([command, ...args]); return 'synthetic version'; },
    runJson: async () => assert.fail('Unexpected provider dependency check'),
  };
  const [anonymous] = await native([{ command: 'health', profile: 'widgets', query: 'public' }], dependencies);
  assert.equal(anonymous.failed, 0);
  assert.deepEqual(anonymous.checks, []);
  assert.deepEqual(operations, []);
  const [authenticated] = await native([{ command: 'health', profile: 'widgets', query: 'private' }], dependencies);
  assert.equal(authenticated.failed, 0);
  assert.deepEqual(authenticated.checks, [{ name: 'gh', available: true }]);
  assert.deepEqual(operations, [['gh', '--version']]);
});

test('curated provider metadata survives contract validation, cache, paging, and separate native avatars', async t => {
  const provider = createTestProvider({ responses: [{
    items: [testItem({
      identities: { author: { id: '1', login: 'example-user', displayName: 'Example User', avatarUrl: 'https://avatars.githubusercontent.com/u/1' } },
      labelDetails: [{ name: 'regression', color: '#aabbcc' }],
      providerData: { commentCount: 3, closureReason: null },
    })], truncated: false,
  }] });
  const { service } = await fixture(t, {
    queryProfile: provider.queryProfile,
    runText: async () => assert.fail('Unexpected credential request'),
    fetch: async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
  });
  await service.setQuery('widgets', 'bugs', definition, 'missing');
  const [reply] = await native([{
    id: 'page', command: 'get', profile: 'widgets', query: 'bugs', pageSize: 10,
    fields: ['title', 'identities', 'labelDetails', 'providerData'],
  }], { service });
  assert.equal(reply.result.items[0].identities.author.displayName, 'Example User');
  assert.equal(reply.result.items[0].labelDetails[0].color, '#aabbcc');
  assert.equal(reply.result.items[0].providerData.commentCount, 3);
  const [avatar] = await native([{
    id: 'avatar', command: 'avatar', profile: 'widgets', query: 'bugs', itemId: '1', cacheRevision: reply.result.cacheRevision,
  }], { service });
  assert.ok(avatar.result.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(provider.calls.length, 1);
});

test('new native operations reject storage overrides, malformed revisions, arbitrary avatar URLs, and invalid paging', async () => {
  for (const request of [
    { command: 'hello', home: 'outside' },
    { command: 'health', file: 'outside' },
    { command: 'query-set', profile: 'widgets', query: 'bugs', definition },
    { command: 'query-get', profile: 'widgets' },
    { command: 'query-validate', profile: 'widgets', query: 'bugs', definition: [] },
    { command: 'refresh-start', all: true },
    { command: 'avatar', profile: 'bugs', itemId: '1', url: 'https://example.com' },
    { command: 'get', profile: 'bugs', pageSize: 201 },
    { command: 'get', all: true, pageSize: 50 },
    { command: 'get', profile: 'bugs', fields: ['unknown'] },
    { command: 'hello', id: {} },
  ]) {
    const [result] = await native([request], { executeCommand: async () => assert.fail('Invalid request dispatched') });
    assert.equal(result.error.code, 'INVALID_REQUEST');
  }
});

test('new metadata participates in normalized identity and ADO field filters', () => {
  const item = testItem({
    provider: 'ado', author: 'example@example.com', severity: '2 - High', priority: '1', type: 'Task',
    identities: { author: { displayName: 'Example Person' } },
  });
  const terms = compileFilter('author:"Example Person" severity:high priority:1 type:task', { provider: 'ado', resource: 'bugs' });
  assert.deepEqual(filterItems([item], terms), [item]);
  const pull = testItem({
    kind: 'pr', reviewers: ['reviewer@example.com'], identities: { reviewers: [{ displayName: 'Reviewer Name', avatarUrl: 'https://avatars.githubusercontent.com/u/1.png' }] },
    labelDetails: [{ name: 'bug', color: '#ff0000' }], providerData: { commentCount: 3, merged: false, requestedTeams: ['example-team'] },
  });
  assert.deepEqual(filterItems([pull], compileFilter('reviewer:"Reviewer Name" providerData.commentCount:3 providerData.requestedTeams:example labelDetails:ff0000',
    { provider: 'github', resource: 'prs' })), [pull]);
  assert.deepEqual(filterItems([pull], compileFilter('reviewer:png', { provider: 'github', resource: 'prs' })), []);
});

test('avatars are selected from cached identities, returned separately, and reused without provider requests', async t => {
  let fetched = 0;
  const { service } = await fixture(t, {
    queryProfile: async () => ({ items: [testItem({ identities: { author: {
      id: '1', login: 'example', avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    } } })], truncated: false }),
    fetch: async (url, options) => {
      fetched++;
      assert.equal(options.headers.Authorization, undefined);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
    runText: async () => assert.fail('Public GitHub avatars must not request credentials'),
  });
  await service.setProfile('bugs', definition);
  const cached = await service.get('bugs');
  const options = { itemId: '1', cacheRevision: cached.cacheRevision };
  const first = await service.avatar('bugs', options);
  assert.ok(first.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(first.fromCache, false);
  assert.equal((await service.avatar('bugs', options)).fromCache, true);
  assert.equal(fetched, 1);
  await assert.rejects(service.avatar('bugs', { itemId: 'missing' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.avatar('bugs', { itemId: '1', role: 'assignee' }), { code: 'AVATAR_UNAVAILABLE' });
  await assert.rejects(service.avatar('bugs', { ...options, cacheRevision: '0'.repeat(64) }), { code: 'CURSOR_EXPIRED' });
});

test('GitHub-origin private avatars keep CLI credentials internal and scoped to the configured host', async t => {
  const { service, home } = await fixture(t, {
    queryProfile: async () => ({ items: [testItem({ identities: { author: {
      id: '1', avatarUrl: 'https://github.example/avatars/1',
    } } })], truncated: false }),
    runText: async (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.example']);
      return 'synthetic-only-github-credential\n';
    },
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-only-github-credential');
      assert.equal(options.redirect, 'error');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  await service.setProfile('bugs', { ...definition, hostname: 'github.example' });
  await service.get('bugs');
  const result = await service.avatar('bugs', { itemId: '1' });
  assert.ok(!JSON.stringify(result).includes('synthetic-only-github-credential'));
  assert.ok(!(await readFile(join(home, 'logs', 'devdash.jsonl'), 'utf8')).includes('synthetic-only-github-credential'));
});

test('cross-repository avatar selection disambiguates numbers and isolates selected-account credentials and caches', async t => {
  let credentialRequests = 0, imageRequests = 0;
  const { service, home } = await fixture(t, {
    queryProfile: async () => ({ items: ['owner/one', 'owner/two'].map(repository => testItem({
      repository, url: `https://github.example/${repository}/issues/1`,
      identities: { author: { avatarUrl: 'https://github.example/avatars/1' } },
    })), truncated: false }),
    runText: async (command, args, options) => {
      credentialRequests++;
      assert.equal(command, 'gh');
      assert.deepEqual(args.slice(0, 5), ['auth', 'token', '--hostname', 'github.example', '--user']);
      assert.equal(options.env.GH_TOKEN, '');
      return `synthetic-avatar-${args.at(-1)}`;
    },
    fetch: async (url, options) => {
      imageRequests++;
      assert.ok(options.headers.Authorization.startsWith('Bearer synthetic-avatar-example-'));
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  const selected = { ...definition, repository: undefined, hostname: 'github.example', account: 'example-one' };
  await service.setProfile('bugs', selected);
  await service.get('bugs');
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'INVALID_ARGUMENT' });
  const [reply] = await native([{
    command: 'avatar', profile: 'bugs', itemId: '1', repository: 'owner/two',
  }], { service });
  assert.equal(reply.repository, 'owner/two');
  assert.equal(reply.fromCache, false);
  const cached = await executeCommand(['avatar', 'bugs', '--item-id', '1', '--repository', 'OWNER/TWO'], { service });
  assert.equal(cached.output.fromCache, true);
  await service.setProfile('bugs', { ...selected, account: 'example-two' });
  await service.get('bugs');
  assert.equal((await service.avatar('bugs', { itemId: '1', repository: 'owner/two' })).fromCache, false);
  assert.equal(credentialRequests, 2);
  assert.equal(imageRequests, 2);
  assert.ok(!(await readFile(join(home, 'logs', 'devdash.jsonl'), 'utf8')).includes('synthetic-avatar-'));
});

test('ADO avatars obtain credentials internally and never expose them in responses or logs', async t => {
  let requests = 0;
  const { service, home } = await fixture(t, {
    queryProfile: async () => ({ items: [testItem({ provider: 'ado', identities: { author: {
      id: '1', avatarUrl: 'https://dev.azure.com/example/_apis/identity/1/avatar',
    } } })], truncated: false }),
    runJson: async (command, args) => {
      assert.equal(command, 'az');
      assert.ok(args.includes('get-access-token'));
      return { accessToken: 'synthetic-only-avatar-credential' };
    },
    fetch: async (url, options) => {
      requests++;
      assert.equal(options.headers.Authorization, 'Bearer synthetic-only-avatar-credential');
      assert.equal(options.redirect, 'error');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  await service.setProfile('bugs', {
    provider: 'ado', resource: 'bugs', organization: 'https://dev.azure.com/example', project: 'Example',
    query: 'SELECT [System.Id] FROM WorkItems', refreshSeconds: 300,
  });
  await service.get('bugs');
  const result = await service.avatar('bugs', { itemId: '1' });
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(result).includes('synthetic-only-avatar-credential'));
  assert.ok(!(await readFile(join(home, 'logs', 'devdash.jsonl'), 'utf8')).includes('synthetic-only-avatar-credential'));
});

test('legacy ADO collection URLs can retrieve tenant-root avatars without sending credentials to another tenant', async t => {
  let avatarUrl = 'https://other.visualstudio.com/_api/_common/identityImage?id=1';
  let requested = 0;
  const { service } = await fixture(t, {
    queryProfile: async () => ({ items: [testItem({ provider: 'ado', identities: { author: { id: '1', avatarUrl } } })], truncated: false }),
    runJson: async () => ({ accessToken: 'synthetic-only-avatar-credential' }),
    fetch: async () => { requested++; return new Response(png, { headers: { 'content-type': 'image/png' } }); },
  });
  await service.setProfile('bugs', {
    provider: 'ado', resource: 'bugs', organization: 'https://example.visualstudio.com/DefaultCollection', project: 'Example',
    query: 'SELECT [System.Id] FROM WorkItems', refreshSeconds: 300,
  });
  await service.get('bugs');
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'AVATAR_UNAVAILABLE' });
  assert.equal(requested, 0);
  avatarUrl = 'https://example.visualstudio.com/_api/_common/identityImage?id=1';
  await service.get('bugs', { refresh: true });
  assert.equal((await service.avatar('bugs', { itemId: '1' })).mimeType, 'image/png');
  assert.equal(requested, 1);
});

test('avatar fetches reject outside destinations, active image formats, and oversized payloads explicitly', async t => {
  let url = 'https://outside.example/image.png';
  let response = () => new Response(png, { headers: { 'content-type': 'image/png' } });
  let calls = 0;
  const { service } = await fixture(t, {
    queryProfile: async () => ({ items: [testItem({ identities: { author: { avatarUrl: url } } })], truncated: false }),
    fetch: async () => { calls++; return response(); },
  });
  await service.setProfile('bugs', definition);
  await service.get('bugs');
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'AVATAR_UNAVAILABLE' });
  assert.equal(calls, 0);
  url = 'https://avatars.githubusercontent.com/u/1';
  await service.get('bugs', { refresh: true });
  response = () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'AVATAR_FAILED' });
  response = () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(128 * 1024 + 1) } });
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'AVATAR_TOO_LARGE' });
  response = () => new Response(Buffer.alloc(128 * 1024 + 1), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(service.avatar('bugs', { itemId: '1' }), { code: 'AVATAR_TOO_LARGE' });
});
