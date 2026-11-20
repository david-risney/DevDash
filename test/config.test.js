import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSources, loadConfig, validateConfig, validateName, paths } from '../src/config.js';
import { DevDash } from '../src/service.js';
import { loadPresentation } from '../src/presentation.js';

const github = { provider: 'github', resource: 'bugs', repository: 'owner/repo', refreshSeconds: 300 };
const ado = { provider: 'ado', resource: 'bugs', organization: 'https://dev.azure.com/org', project: 'project', query: 'SELECT [System.Id] FROM WorkItems', refreshSeconds: 300 };
const chromium = { provider: 'chromium', resource: 'cls', query: 'status:open', refreshSeconds: 60 };
const config = (profile) => ({ version: 1, profiles: { test: profile } });

test('all example profiles match the public JSON schema', async () => {
  const examples = JSON.parse(await readFile(new URL('../examples/config.json', import.meta.url), 'utf8'));
  assert.equal(validateConfig(examples), examples);
});

test('valid supported profiles include WIQL, saved queries, and PR filters', () => {
  for (const profile of [github, ado, chromium, { ...chromium, resource: 'bugs' }, {
    provider: 'chromium', resource: 'bugs', bugIds: ['411731002'], refreshSeconds: 300,
  }, {
    ...ado, query: undefined, queryId: '01234567-89ab-cdef-0123-456789abcdef',
  }, {
    provider: 'ado', resource: 'prs', organization: ado.organization, project: ado.project,
    status: 'all', repository: 'repo', reviewer: 'someone', refreshSeconds: 60,
  }]) {
    // JSON files cannot contain undefined.
    assert.doesNotThrow(() => validateConfig(config(JSON.parse(JSON.stringify(profile)))));
  }
  assert.doesNotThrow(() => validateConfig(config({ ...ado, query: 'SELECT [System.Id]\nFROM WorkItems' })));
});

test('unknown fields, wrong types, unsupported resources and empty strings are rejected', () => {
  for (const profile of [
    { ...github, token: 'secret' },
    { ...github, refreshSeconds: 0 },
    { ...github, refreshSeconds: '300' },
    { ...github, limit: 20001 },
    { ...github, resource: 'cls' },
    { ...github, repository: 'repo' },
    { ...github, query: ' ' },
    { ...github, query: 'test\u0000' },
    { provider: 'chromium', resource: 'bugs', refreshSeconds: 60 },
    { provider: 'chromium', resource: 'bugs', bugIds: [], refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: [411731002], refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: ['0'], refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: ['1', '1'], refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: ['1'], host: 'https://example.com', refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: ['1'], query: 'status:open', refreshSeconds: 300 },
    { provider: 'chromium', resource: 'bugs', bugIds: Array.from({ length: 101 }, (_, i) => String(i + 1)), refreshSeconds: 300 },
    { ...chromium, host: 'http://localhost' },
    { ...chromium, host: 'https://example.com/path' },
    { ...ado, organization: 'https://user:secret@example.com' },
    { ...ado, queryId: '01234567-89ab-cdef-0123-456789abcdef' },
    { ...ado, repository: 'repo' },
    { ...ado, resource: 'prs' },
  ]) {
    assert.throws(() => validateConfig(config(profile)), { code: 'INVALID_CONFIG' });
  }
});

test('invalid names and unsupported config versions fail validation', () => {
  for (const name of ['../oops', '-flag', '__proto__', '', 'a'.repeat(81), 'two words']) {
    assert.throws(() => validateName(name), { code: 'INVALID_PROFILE' });
  }
  for (const value of [null, [], {}, { version: 2, profiles: {} }, { version: 1, profiles: { '../oops': github } }]) {
    assert.throws(() => validateConfig(value), { code: 'INVALID_CONFIG' });
  }
});

test('explicit home overrides environment without changing user settings', () => {
  assert.match(paths({}, { DEVDASH_HOME: 'test-data' }).home, /test-data$/);
  assert.match(paths({ home: 'explicit' }, { DEVDASH_HOME: 'test-data' }).home, /explicit$/);
});

test('ordered file overlays merge objects, replace arrays, and preserve presentation layer semantics', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-config-layers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = join(home, 'base.json'), second = join(home, 'override.json');
  await writeFile(first, JSON.stringify({
    version: 1, presentation: { theme: 'chevron-tab', ansi: { table: {
      header: { background: '#123456' }, status: { labels: { OPEN: 'Pending' } },
    } } },
    profiles: { work: { refreshSeconds: 300, queries: {
      bugs: { ...github, repositories: ['owner/one', 'owner/two'], repository: undefined },
      prs: { ...github, resource: 'prs' },
    } } },
  }));
  await writeFile(second, JSON.stringify({
    presentation: { theme: 'half-block', ansi: { table: { status: { labels: { open: 'Ready' } } } } },
    profiles: { work: { queries: { bugs: { repositories: ['owner/three'], query: 'is:open' } } } },
  }));
  const service = new DevDash({ home, config: [first, second] });
  const merged = await service.config();
  assert.deepEqual(merged.profiles.work.queries.bugs.repositories, ['owner/three']);
  assert.equal(merged.profiles.work.queries.bugs.provider, 'github');
  assert.equal(merged.profiles.work.queries.bugs.query, 'is:open');
  assert.equal(merged.profiles.work.queries.prs.resource, 'prs');
  const { presentation } = await loadPresentation(service.paths, merged);
  assert.equal(presentation.theme, 'half-block');
  assert.equal(presentation.ansi.table.header.background, 'p:header', 'Changing themes resets the earlier frame style');
  assert.deepEqual(presentation.ansi.table.status.labels, { open: 'Ready' });
  assert.ok(!JSON.stringify(merged).includes('configurationLayers'));
  assert.notDeepEqual((await loadConfig([second, first])).profiles.work.queries.bugs.repositories, ['owner/three']);
  for (const action of [
    () => service.init(), () => service.setProfile('another', github), () => service.removeProfile('work'),
    () => service.setQuery('work', 'bugs', github, 'missing'),
    () => service.removeQuery('work', 'bugs', 'a'.repeat(64)),
  ]) await assert.rejects(action(), { code: 'CONFIG_READ_ONLY' });
  assert.equal((await service.validateQuery('work', 'bugs', github)).valid, true);
  assert.equal(JSON.parse(await readFile(second, 'utf8')).profiles.work.queries.bugs.provider, undefined);
});

test('configuration source order scopes caches and URLs never become filesystem paths', () => {
  const local = join(tmpdir(), 'devdash-one.json');
  const url = 'https://example.com/config.json?ref=main';
  const ordered = paths({ config: [local, url] }), reversed = paths({ config: [url, local] });
  assert.deepEqual(ordered.configs, [local, url]);
  assert.notEqual(ordered.config, reversed.config);
  assert.equal(paths({ config: local }).config, paths({ config: [local] }).config);
  assert.notEqual(paths({ config: url }).config, local);
  for (const value of [[], '', null, [local, 1], 'file:///config.json', 'https://user:password@example.com/config.json', 'https://example.com/config.json#fragment']) {
    assert.throws(() => configSources(value), { code: 'INVALID_ARGUMENT' });
  }
});

test('URL overlays are bounded JSON reads without credentials, redirects or leaked server content', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-config-url-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = join(home, 'base.json');
  await writeFile(base, JSON.stringify(config(github)));
  const url = 'https://example.com/override.json?ref=main';
  const calls = [];
  const fetch = async (source, options) => {
    calls.push(source);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('\uFEFF{"profiles":{"test":{"query":"is:open"}}}');
  };
  const merged = await loadConfig([base, url], { fetch });
  assert.equal(merged.profiles.test.query, 'is:open');
  assert.deepEqual(calls, [url]);
  const remote = new DevDash({ home, config: url }, { fetch: async () => new Response(JSON.stringify(config(github))) });
  assert.equal((await remote.config()).profiles.test.provider, 'github');
  await assert.rejects(remote.setProfile('test', github), { code: 'CONFIG_READ_ONLY' });
  for (const [response, code] of [
    [() => new Response('SECRET_SERVER_CONTENT', { status: 403 }), 'CONFIG_FETCH_FAILED'],
    [() => new Response('SECRET_SERVER_CONTENT'), 'INVALID_JSON'],
    [() => new Response('null'), 'INVALID_CONFIG'],
    [() => new Response('[]'), 'INVALID_CONFIG'],
    [() => new Response('{"version":2}'), 'INVALID_CONFIG'],
    [() => new Response(null, { status: 204 }), 'CONFIG_FETCH_FAILED'],
    [() => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }), 'CONFIG_TOO_LARGE'],
    [() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(600 * 1024)); controller.enqueue(new Uint8Array(600 * 1024)); controller.close();
    } })), 'CONFIG_TOO_LARGE'],
    [() => { throw new Error('SECRET_NETWORK_DETAILS'); }, 'CONFIG_FETCH_FAILED'],
  ]) {
    await assert.rejects(loadConfig(url, { fetch: async () => response() }),
      error => error.code === code && !error.message.includes('SECRET') && !error.message.includes(url));
  }
  await assert.rejects(loadConfig([base, join(home, 'missing.json')], { required: false }), { code: 'CONFIG_NOT_FOUND' });
});
