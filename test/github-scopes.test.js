import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryProfile, queryWebUrl } from '../src/providers.js';
import { providerProfile } from '../src/query.js';
import { validateConfig } from '../src/config.js';
import { validateQueryResult } from '../src/providers/contract.js';
import { githubAccountOptions } from '../src/github-auth.js';
import { formatResults } from '../src/format.js';
import { DevDash } from '../src/service.js';
import { preflight } from './helpers/live-e2e.js';

const profile = { provider: 'github', resource: 'bugs', refreshSeconds: 300, limit: 10 };
const issue = (repository, number = 1, extra = {}) => ({
  repository_url: `https://api.github.com/repos/${repository}`, number, title: 'Synthetic issue', state: 'open',
  ...extra,
});
const search = items => ({ items, total_count: items.length, incomplete_results: false });
const validate = definition => validateConfig({ version: 1, profiles: { synthetic: definition } });
const details = repository => ({
  number: 1, base: { repo: { full_name: repository } }, merged: false, merged_at: null,
  requested_reviewers: [], requested_teams: [],
});

test('GitHub schema and runtime accept optional accounts and single, subset or all repository scopes', () => {
  for (const scope of [{}, { repository: 'owner/one' }, { repositories: ['owner/one', 'owner/two', 'another/three'] }]) {
    for (const account of [undefined, 'example-user', 'example_managed']) {
      const definition = { ...profile, ...scope, ...(account === undefined ? {} : { account }) };
      validate(definition);
      assert.deepEqual(providerProfile(definition), definition);
    }
  }
  for (const scope of [
    { repositories: [] }, { repositories: 'owner/one' }, { repositories: ['owner/one', 'OWNER/ONE'] },
    { repositories: ['owner/one', 'bad'] }, { repositories: [null] },
    { repositories: Array.from({ length: 101 }, (_, i) => `owner/repo${i}`) },
    { repository: 'owner/one', repositories: ['owner/two'] }, { repository: null },
    ...['', ' ', '--user=other', 'owner/name', 'one\ntwo', null, [], true].map(account => ({ account })),
    { account: 'example', auth: 'anonymous' },
  ]) {
    assert.throws(() => validate({ ...profile, ...scope }), { code: 'INVALID_CONFIG' });
    assert.throws(() => providerProfile({ ...profile, ...scope }), { code: 'INVALID_PROFILE' });
  }
  assert.throws(() => providerProfile({ provider: 'ado', account: 'example' }), { code: 'INVALID_PROFILE' });
  assert.throws(() => providerProfile({ provider: 'ado', repositories: ['owner/one'] }), { code: 'INVALID_PROFILE' });
});

test('cross-repository searches retain actual repositories and overlapping numbers through validation and formatting', async () => {
  const result = await queryProfile(profile, { runJson: async (command, args) => {
    assert.ok(args.includes('q=state:open is:issue'));
    return search([issue('owner/one'), issue('owner/two')]);
  } });
  assert.deepEqual(result.items.map(item => [item.id, item.repository, item.url]), [
    ['1', 'owner/one', 'https://github.com/owner/one/issues/1'],
    ['1', 'owner/two', 'https://github.com/owner/two/issues/1'],
  ]);
  assert.deepEqual(validateQueryResult(profile, result), result);
  for (const format of ['ansi', 'text', 'markdown']) {
    const output = formatResults({ ...result, provider: 'github', resource: 'bugs' }, format);
    assert.equal(output.failed, 0);
    assert.ok(output.output.includes('owner/one'));
    assert.ok(output.output.includes('owner/two'));
  }
  assert.throws(() => validateQueryResult(profile, { items: [result.items[0], result.items[0]], truncated: false }),
    { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(queryProfile(profile, { runJson: async () => search([issue('owner/one'), issue('OWNER/ONE')]) }),
    { code: 'PROVIDER_RESPONSE' });
});

test('repository subsets use native repeated repo qualifiers without widening narrower native queries', async () => {
  const subset = { ...profile, repositories: ['owner/one', 'owner/two', 'another/three'] };
  for (const [query, expected] of [
    [undefined, 'state:open repo:owner/one repo:owner/two repo:another/three is:issue'],
    ['is:open repo:"owner/one"', 'is:open repo:"owner/one" is:issue'],
    ['is:open -repo:owner/one', 'is:open -repo:owner/one repo:owner/one repo:owner/two repo:another/three is:issue'],
  ]) {
    const definition = { ...subset, ...(query === undefined ? {} : { query }) };
    const result = await queryProfile(definition, { runJson: async (command, args) => {
      assert.ok(args.includes(`q=${expected}`));
      return search([]);
    } });
    assert.equal(result.items.length, 0);
    assert.equal(new URL(queryWebUrl(definition)).searchParams.get('q'), expected);
  }
  await assert.rejects(queryProfile({ ...subset, query: 'repo:outside/repo' }), { code: 'INVALID_PROFILE' });
  await assert.rejects(queryProfile(subset, { runJson: async () => search([issue('outside/repo')]) }),
    { code: 'PROVIDER_RESPONSE' });
  const native = 'is:open repo:owner/one repo:owner/two';
  await queryProfile({ ...profile, query: native }, { runJson: async (command, args) => {
    assert.ok(args.includes(`q=${native} is:issue`));
    return search([issue('owner/one'), issue('owner/two')]);
  } });
});

test('PR hydration uses each search row repository and rejects mismatched detail responses', async () => {
  const requested = [];
  const definition = { ...profile, resource: 'prs' };
  const result = await queryProfile(definition, { runJson: async (command, args) => {
    const endpoint = args[3];
    requested.push(endpoint);
    if (endpoint === 'search/issues') return search([
      issue('owner/one', 1, { pull_request: {}, draft: false }),
      issue('owner/two', 1, { pull_request: {}, draft: true }),
    ]);
    return details(endpoint.split('/').slice(1, 3).join('/'));
  } });
  assert.deepEqual(requested, ['search/issues', 'repos/owner/one/pulls/1', 'repos/owner/two/pulls/1']);
  assert.deepEqual(result.items.map(item => item.url), [
    'https://github.com/owner/one/pull/1', 'https://github.com/owner/two/pull/1',
  ]);
  await assert.rejects(queryProfile(definition, { runJson: async (command, args) => args[3] === 'search/issues'
    ? search([issue('owner/one', 1, { pull_request: {} })]) : details('owner/other') }),
  { code: 'PROVIDER_RESPONSE' });
});

test('explicit accounts use independent credential environments on identity, search and hydration without switching gh', async () => {
  const original = Object.fromEntries(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
    .map(name => [name, process.env[name]]));
  const operations = [];
  await Promise.all(['example-one', 'example-two'].map(async account => {
    const definition = { ...profile, account, resource: 'prs', query: 'author:@me label:"author:@me"' };
    const result = await queryProfile(definition, {
      env: { GH_TOKEN: 'wrong-token', GITHUB_TOKEN: 'wrong-fallback', GH_ENTERPRISE_TOKEN: 'wrong-enterprise' },
      runText: async (command, args, options) => {
        operations.push(args.slice(0, 2).join(' '));
        assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com', '--user', account]);
        assert.equal(options.env.GH_TOKEN, '');
        assert.equal(options.env.GITHUB_TOKEN, '');
        return `synthetic-${account}\n`;
      },
      runJson: async (command, args, options) => {
        operations.push(args.slice(0, 2).join(' '));
        assert.ok(args.includes('--hostname') && args.includes('github.com'));
        assert.equal(options.env.GH_TOKEN, `synthetic-${account}`);
        assert.equal(options.env.GITHUB_TOKEN, '');
        assert.equal(options.env.GH_ENTERPRISE_TOKEN, '');
        if (args[3] === 'user') return { login: account };
        if (args[3] === 'search/issues') {
          assert.ok(args.includes(`q=author:${account} label:"author:@me" is:pr`));
          return search([issue('owner/one', 1, { pull_request: {}, draft: false })]);
        }
        return details('owner/one');
      },
    });
    assert.equal(result.items.length, 1);
    assert.ok(!JSON.stringify(result).includes('synthetic-example'));
    assert.equal(new URL(queryWebUrl(definition)).searchParams.get('q'),
      `author:${account} label:"author:@me" is:pr`);
  }));
  assert.ok(operations.every(operation => ['auth token', 'api --method'].includes(operation)));
  for (const [name, value] of Object.entries(original)) assert.equal(process.env[name], value);
});

test('omitted account uses ordinary gh identity and never requests or overrides credentials', async () => {
  const result = await queryProfile({ ...profile, query: 'assignee:@me' }, {
    runText: async () => assert.fail('Default account must remain owned by gh'),
    runJson: async (command, args, options) => {
      assert.equal(options, undefined);
      if (args[3] === 'user') return { login: 'active-example' };
      assert.ok(args.includes('q=assignee:active-example is:issue'));
      return search([]);
    },
  });
  assert.equal(result.items.length, 0);
});

test('account credentials, missing accounts and identity mismatches fail explicitly without secret output or fallback', async () => {
  for (const output of ['', '\n', 'one\ntwo', 'one two', 'x'.repeat(16385), {}, null]) {
    await assert.rejects(queryProfile({ ...profile, account: 'example' }, {
      runText: async () => output,
      runJson: async () => assert.fail('Invalid credentials must not reach GitHub'),
    }), { code: 'CLI_FAILED' });
  }
  await assert.rejects(queryProfile({ ...profile, account: 'example' }, {
    runText: async () => { throw new Error('SECRET_CREDENTIAL'); },
    runJson: async () => assert.fail('Missing accounts must not use the active account'),
  }), error => error.code === 'CLI_FAILED' && !JSON.stringify(error).includes('SECRET_CREDENTIAL'));
  await assert.rejects(queryProfile({ ...profile, account: 'example' }, {
    runText: async () => 'synthetic-only-token',
    runJson: async (command, args) => {
      assert.equal(args[3], 'user');
      return { login: 'wrong-account' };
    },
  }), { code: 'CLI_FAILED' });
  for (const [hostname, variable] of [['github.com', 'GH_TOKEN'], ['example.ghe.com', 'GH_TOKEN'],
    ['github.example.com', 'GH_ENTERPRISE_TOKEN']]) {
    const options = await githubAccountOptions({ account: 'example', hostname }, {
      env: {}, runText: async (command, args) => {
        assert.ok(args.includes(hostname));
        return 'synthetic-only-token';
      },
    });
    assert.equal(options.env[variable], 'synthetic-only-token');
  }
});

test('anonymous global and subset queries remain credential-free', async () => {
  for (const scope of [{}, { repositories: ['owner/one', 'owner/two'] }]) {
    const result = await queryProfile({ ...profile, ...scope, auth: 'anonymous' }, {
      runJson: async () => assert.fail('Anonymous search must not use gh'),
      runText: async () => assert.fail('Anonymous search must not request credentials'),
      fetch: async (url, options) => {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.credentials, 'omit');
        return { ok: true, status: 200, json: async () => search([issue('owner/two')]) };
      },
    });
    assert.equal(result.items[0].repository, 'owner/two');
  }
});

test('account and scope edits invalidate caches while cache-only reads need no credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-account-scope-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let queries = 0;
  const service = new DevDash({ home }, { queryProfile: async definition => {
    queries++;
    return queryProfile(definition, {
      runText: async () => 'synthetic-only-token',
      runJson: async (command, args) => args[3] === 'user' ? { login: definition.account }
        : search([issue('owner/one'), issue('owner/two')]),
    });
  } });
  const selected = { ...profile, account: 'example-one' };
  await service.setProfile('work', selected);
  const first = await service.get('work');
  assert.equal(first.items.length, 2);
  assert.equal((await service.getPage('work', { cachedOnly: true, pageSize: 1 })).page.total, 2);
  assert.equal((await service.get('work', { cachedOnly: true })).cacheRevision, first.cacheRevision);
  assert.equal(queries, 1);
  for (const patch of [{ account: 'example-two' }, { repository: 'owner/one' },
    { repositories: ['owner/one', 'owner/two'] }]) {
    await service.setProfile('work', { ...selected, ...patch });
    await assert.rejects(service.get('work', { cachedOnly: true }), { code: 'CACHE_MISS' });
  }
  const logs = await readFile(join(home, 'logs', 'devdash.jsonl'), 'utf8');
  assert.ok(!logs.includes('synthetic-only-token'));
  assert.ok(!(await readFile(service.cachePath('work'), 'utf8')).includes('synthetic-only-token'));
});

test('live preflight checks each selected account without combining identities or requiring gh for anonymous queries', async () => {
  let checks = 0;
  await preflight({ profiles: { synthetic: { queries: {
    one: { ...profile, account: 'example-one' }, two: { ...profile, account: 'example-two' },
    same: { ...profile, account: 'example-one' }, anonymous: { ...profile, auth: 'anonymous' },
  } } } }, {
    env: {},
    runProviderText: async (command, args) => `synthetic-${args.at(-1)}`,
    runProvider: async (command, args, options) => {
      checks++;
      return { login: options.env.GH_TOKEN.replace('synthetic-', '') };
    },
  });
  assert.equal(checks, 2);
});
