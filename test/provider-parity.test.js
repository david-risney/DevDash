import test from 'node:test';
import assert from 'node:assert/strict';
import { queryProfile } from '../src/providers.js';
import { validateQueryResult } from '../src/providers/contract.js';

const github = { provider: 'github', resource: 'bugs', repository: 'owner/repo' };
const ado = { provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/org', project: 'Project' };
const issue = number => ({
  number, title: 'Title', state: 'open', repository_url: 'https://api.github.com/repos/owner/repo',
  user: { login: 'alice', id: 12, avatar_url: 'https://example.com/alice' },
  assignees: [{ login: 'bob', id: 13, avatar_url: 'https://example.com/bob' }],
  labels: [{ name: 'bug', color: 'Aa00FF', description: 'PRIVATE' }], comments: 4, state_reason: null,
});
const pr = id => ({
  pullRequestId: id, title: 'PR', status: 'active',
  repository: { name: 'Repo', project: { name: 'Project' } },
});
const flag = (args, name) => args[args.indexOf(name) + 1];
const search = items => ({ items, total_count: items.length, incomplete_results: false });
const details = number => ({
  number, base: { repo: { full_name: 'owner/repo' } }, merged: true,
  merged_at: '2026-10-01T12:00:00Z',
  requested_reviewers: [{ login: 'reviewer', id: 14, avatar_url: 'https://example.com/reviewer' }],
  requested_teams: [{ slug: 'maintainers', description: 'PRIVATE' }], body: 'PRIVATE',
});
const http = value => ({ ok: true, status: 200, json: async () => value });

test('explicit anonymous GitHub REST queries never use gh or send authentication', async () => {
  const query = 'author:alice author:bob label:bug label:urgent';
  const requests = [];
  const anonymous = await queryProfile({ ...github, auth: 'anonymous', query }, {
    runJson: async () => assert.fail('Unexpected authenticated CLI request'),
    fetch: async (url, options) => {
      requests.push(url);
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(url.pathname, '/search/issues');
      assert.equal(url.searchParams.get('q'), `${query} repo:owner/repo is:issue`);
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'GET');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(options.headers, {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      });
      return http(search([issue(1)]));
    },
  });
  const authenticated = await queryProfile(github, { runJson: async () => search([issue(1)]) });
  assert.deepEqual(anonymous, authenticated);
  assert.equal(requests.length, 1);
});

test('anonymous GitHub pagination and bounded PR hydration use the same selected public API host', async () => {
  const paths = [];
  const result = await queryProfile({ ...github, resource: 'prs', auth: 'anonymous',
    hostname: 'github.example.com', limit: 1 }, {
    runJson: async () => assert.fail('Unexpected authenticated CLI request'),
    fetch: async (url, options) => {
      assert.equal(url.origin, 'https://github.example.com');
      assert.equal(options.credentials, 'omit');
      assert.equal(Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)), false);
      paths.push(url.pathname);
      return url.pathname.endsWith('/search/issues')
        ? http(search([1, 2].map(number => ({ ...issue(number), pull_request: {} }))))
        : http(details(1));
    },
  });
  assert.deepEqual(paths, ['/api/v3/search/issues', '/api/v3/repos/owner/repo/pulls/1']);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].providerData.merged, true);
  const pages = [];
  const paginated = await queryProfile({ ...github, auth: 'anonymous' }, {
    fetch: async url => {
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return http({ items: page === 1 ? Array.from({ length: 100 }, (_, i) => issue(i + 1)) : [issue(101)],
        total_count: 101, incomplete_results: false });
    },
    runJson: async () => assert.fail('Unexpected authenticated CLI request'),
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(paginated.items.length, 101);
  assert.equal(paginated.truncated, false);
});

test('anonymous GitHub rejects self identity and invalid hosts before any HTTP or CLI request', async () => {
  for (const patch of [
    { query: 'author:@me' }, { query: 'assignee:"@me"' }, { query: '(-review-requested:@me)' },
    { hostname: 'https://github.com' }, { hostname: 'github.com/path' },
    { repository: 'owner/repo?secret=PRIVATE' },
  ]) await assert.rejects(queryProfile({ ...github, auth: 'anonymous', ...patch }, {
    fetch: async () => assert.fail('Unexpected HTTP request'),
    runJson: async () => assert.fail('Unexpected authenticated CLI request'),
  }), { code: 'INVALID_PROFILE' });
});

test('GitHub HTTP and network failures never fall back to another authentication mode or leak response bodies', async () => {
  for (const [fetch, code] of [
    [async () => ({ ok: false, status: 403, json: async () => assert.fail('Failure body must not be read') }), 'PROVIDER_HTTP'],
    [async () => ({ ok: false, status: 401, json: async () => ({ message: 'PRIVATE_TOKEN' }) }), 'PROVIDER_HTTP'],
    [async () => { throw new Error('PRIVATE_TOKEN'); }, 'PROVIDER_NETWORK'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE_BODY'); } }), 'PROVIDER_RESPONSE'],
    [async () => null, 'PROVIDER_RESPONSE'],
  ]) await assert.rejects(queryProfile({ ...github, auth: 'anonymous' }, {
    fetch, runJson: async () => assert.fail('Unexpected authentication fallback'),
  }), error => error.code === code && !/PRIVATE_/.test(error.message));
  for (const auth of [undefined, 'gh']) {
    let requests = 0;
    await assert.rejects(queryProfile({ ...github, auth }, {
      runJson: async command => { requests++; assert.equal(command, 'gh'); throw new Error('PRIVATE_TOKEN'); },
      fetch: async () => assert.fail('Unexpected anonymous fallback'),
    }), error => error.code === 'CLI_FAILED' && !/PRIVATE_/.test(error.message));
    assert.equal(requests, 1);
  }
});

test('GitHub curates identities, colored labels, comment count and closure reason from search', async () => {
  const { items: [item] } = await queryProfile(github, { runJson: async () => search([issue(1)]) });
  assert.equal(item.author, 'alice');
  assert.deepEqual(item.assignees, ['bob']);
  assert.deepEqual(item.labels, ['bug']);
  assert.deepEqual(item.identities.author, { id: '12', login: 'alice', avatarUrl: 'https://example.com/alice' });
  assert.deepEqual(item.identities.assignees, [{ id: '13', login: 'bob', avatarUrl: 'https://example.com/bob' }]);
  assert.deepEqual(item.labelDetails, [{ name: 'bug', color: '#aa00ff' }]);
  assert.deepEqual(item.providerData, { commentCount: 4, closureReason: null });
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE|avatar_url|state_reason/);
  for (const reason of ['completed', 'not_planned', 'reopened', 'duplicate']) {
    const result = await queryProfile(github, { runJson: async () => search([{ ...issue(1), state_reason: reason }]) });
    assert.equal(result.items[0].providerData.closureReason, reason);
  }
  const nullable = await queryProfile(github, {
    runJson: async () => search([{ ...issue(1), user: {
      id: 12, login: 'alice', name: null, avatar_url: null, email: 'PRIVATE_EMAIL',
    } }]),
  });
  assert.deepEqual(nullable.items[0].identities.author, { id: '12', login: 'alice' });
  assert.doesNotMatch(JSON.stringify(nullable), /PRIVATE_EMAIL|authorIdentity|assigneeIdentities/);
});

test('GitHub hydrates only selected PRs and preserves native author OR and labels AND', async () => {
  const query = '(author:alice OR author:bob) label:bug label:urgent';
  const calls = [];
  const result = await queryProfile({ ...github, resource: 'prs', query, limit: 1, hostname: 'github.example.com' }, {
    runJson: async (command, args) => {
      calls.push(args);
      assert.equal(command, 'gh');
      assert.equal(flag(args, '--hostname'), 'github.example.com');
      if (args.includes('search/issues')) {
        assert.ok(args.includes(`q=${query} repo:owner/repo is:pr`));
        return search([1, 2].map(number => ({ ...issue(number), pull_request: {} })));
      }
      assert.ok(args.includes('repos/owner/repo/pulls/1'));
      return details(1);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items[0].reviewers, ['reviewer']);
  assert.deepEqual(result.items[0].identities.reviewers, [{
    id: '14', login: 'reviewer', avatarUrl: 'https://example.com/reviewer',
  }]);
  assert.deepEqual(result.items[0].providerData, {
    commentCount: 4, merged: true, mergedAt: '2026-10-01T12:00:00.000Z',
    requestedReviewers: ['reviewer'], requestedTeams: ['maintainers'],
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|base|requested_reviewers/);
  const native = 'author:alice author:bob label:bug label:urgent';
  await queryProfile({ ...github, query: native }, {
    runJson: async (command, args) => {
      assert.ok(args.includes(`q=${native} repo:owner/repo is:issue`));
      return search([issue(1)]);
    },
  });
});

test('GitHub hydration is bounded to four concurrent requests and restores search ordering', async () => {
  let active = 0, maximum = 0, hydrated = 0;
  const result = await queryProfile({ ...github, resource: 'prs', limit: 9 }, {
    runJson: async (command, args) => {
      if (args.includes('search/issues')) return search(Array.from({ length: 10 }, (_, n) =>
        ({ ...issue(n + 1), pull_request: {} })));
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      hydrated++;
      return details(Number(args.find(arg => arg.startsWith('repos/')).split('/').at(-1)));
    },
  });
  assert.equal(maximum, 4);
  assert.equal(hydrated, 9);
  assert.deepEqual(result.items.map(item => item.id), Array.from({ length: 9 }, (_, n) => String(n + 1)));
});

test('GitHub rejects malformed optional metadata and out-of-scope hydration', async () => {
  for (const patch of [
    { comments: -1 }, { comments: '4' }, { state_reason: 'unknown' },
    { labels: [{ name: 'bug', color: 'red' }] },
    { user: { login: 'alice', avatar_url: 'http://example.com/avatar' } },
    { user: { login: 'alice', id: 1.5 } },
  ]) await assert.rejects(queryProfile(github, { runJson: async () => search([{ ...issue(1), ...patch }]) }),
    { code: 'PROVIDER_RESPONSE' });
  for (const patch of [
    { number: 2 }, { base: { repo: { full_name: 'other/repo' } } },
    { merged: 'true' }, { requested_reviewers: null }, { requested_teams: {} }, { merged_at: 'invalid' },
  ]) {
    await assert.rejects(queryProfile({ ...github, resource: 'prs' }, {
      runJson: async (command, args) => args.includes('search/issues')
        ? search([{ ...issue(1), pull_request: {} }]) : { ...details(1), ...patch },
    }), { code: 'PROVIDER_RESPONSE' });
  }
});

test('ADO author/reviewer OR arrays form a Cartesian union, deduped by ID within one project', async () => {
  const calls = [];
  const result = await queryProfile({ ...ado, query: { author: ['alice', 'bob'], reviewer: ['c', 'd'], status: 'all' } }, {
    runJson: async (command, args) => {
      calls.push(args);
      assert.equal(command, 'az');
      assert.equal(flag(args, '--project'), 'Project');
      assert.equal(flag(args, '--organization'), ado.organization);
      assert.equal(flag(args, '--detect'), 'false');
      assert.equal(flag(args, '--status'), 'all');
      return [pr(1), pr(calls.length + 1)];
    },
  });
  assert.deepEqual(calls.map(args => [flag(args, '--creator'), flag(args, '--reviewer')]),
    [['alice', 'c'], ['alice', 'd'], ['bob', 'c'], ['bob', 'd']]);
  assert.deepEqual(result.items.map(item => item.id), ['1', '2', '3', '4', '5']);
  assert.equal(result.truncated, false);
});

test('ADO union limits count unique PRs, probing remaining streams even at exact limit', async () => {
  for (const [second, truncated] of [[[pr(1)], false], [[pr(1), pr(2)], true]]) {
    const calls = [];
    const result = await queryProfile({ ...ado, query: { author: ['alice', 'bob'] }, limit: 1 }, {
      runJson: async (command, args) => {
        calls.push(args);
        const rows = flag(args, '--creator') === 'alice' ? [pr(1)] : second;
        const skip = Number(flag(args, '--skip'));
        return rows.slice(skip, skip + Number(flag(args, '--top')));
      },
    });
    assert.equal(result.truncated, truncated);
    assert.equal(result.items.length, 1);
  }
});

test('ADO union paginates through overlapping full pages and rejects scope/pagination failures', async () => {
  const calls = [];
  const result = await queryProfile({ ...ado, query: { reviewer: ['alice', 'bob'] }, limit: 1 }, {
    runJson: async (command, args) => {
      calls.push(args);
      if (flag(args, '--reviewer') === 'alice') return [pr(1)];
      return flag(args, '--skip') === '0' ? [pr(1)] : [pr(2)];
    },
  });
  assert.equal(result.truncated, true);
  assert.equal(flag(calls.at(-1), '--skip'), '1');
  await assert.rejects(queryProfile({ ...ado, query: { author: ['a', 'b'] } }, {
    runJson: async () => [{ ...pr(1), repository: { name: 'Repo', project: { name: 'Other' } } }],
  }), { code: 'PROVIDER_RESPONSE' });
});

test('ADO executes every Cartesian selector even for the maximum empty union', async () => {
  let requests = 0;
  const selectors = Array.from({ length: 20 }, (_, i) => `user-${i}`);
  assert.deepEqual(await queryProfile({ ...ado, query: { author: selectors, reviewer: selectors } }, {
    runJson: async () => { requests++; return []; },
  }), { items: [], truncated: false });
  assert.equal(requests, 400);
});

test('ADO IDs support authenticated avatar lookup while nullable identity fields are omitted', async () => {
  const result = await queryProfile(ado, {
    runJson: async () => [{ ...pr(1),
      createdBy: { id: 'author-id', uniqueName: null, displayName: null, imageUrl: null },
      reviewers: [{ id: 'reviewer-id', displayName: 'Reviewer', imageUrl: null }],
    }],
  });
  assert.deepEqual(result.items[0].identities, {
    author: { id: 'author-id' },
    reviewers: [{ id: 'reviewer-id', displayName: 'Reviewer' }],
  });
  assert.equal(result.items[0].author, 'author-id');
  assert.deepEqual(result.items[0].reviewers, ['Reviewer']);
});

test('ADO work-item type selection exposes type, priority, severity and identity refs without raw blobs', async () => {
  const workItem = (id, type) => ({
    id, fields: {
      'System.Title': 'Title', 'System.State': 'Active', 'System.WorkItemType': type, 'System.TeamProject': 'Project',
      'System.CreatedBy': { id: 'ado-author', uniqueName: 'a@example.com', displayName: 'Alice', imageUrl: 'https://example.com/a' },
      'System.AssignedTo': { id: 'ado-assignee', uniqueName: 'b@example.com', displayName: 'Bob' },
      'System.Tags': '', 'System.CreatedDate': null, 'System.ChangedDate': null,
      'Microsoft.VSTS.Common.Priority': 2, 'Microsoft.VSTS.Common.Severity': '1 - Critical',
      'System.Description': 'PRIVATE',
    },
  });
  const profile = { ...ado, resource: 'bugs', query: { wiql: 'SELECT [System.Id] FROM WorkItems' }, limit: 1 };
  const rows = [workItem(1, 'Task'), workItem(2, 'Bug')];
  const selected = await queryProfile({ ...profile, workItemTypes: ['Task'] }, { runJson: async () => rows });
  assert.equal(selected.items[0].type, 'Task');
  assert.equal(selected.items[0].priority, '2');
  assert.equal(selected.items[0].severity, '1 - Critical');
  assert.deepEqual(selected.items[0].identities.author,
    { id: 'ado-author', login: 'a@example.com', displayName: 'Alice', avatarUrl: 'https://example.com/a' });
  assert.deepEqual(selected.items[0].identities.assignees,
    [{ id: 'ado-assignee', login: 'b@example.com', displayName: 'Bob' }]);
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE|System.Description/);
  const defaults = await queryProfile(profile, { runJson: async () => rows });
  assert.equal(defaults.items[0].id, '2');
  assert.equal(defaults.items[0].type, 'Bug');
  assert.equal(defaults.truncated, false);
  const hydrated = await queryProfile(profile, {
    runJson: async (command, args) => {
      const wiql = flag(args, '--wiql');
      if (wiql === 'SELECT [System.Id] FROM WorkItems') return [{ id: 1 }, { id: 2 }];
      assert.match(wiql, /\[Microsoft.VSTS.Common.Priority\]/);
      assert.match(wiql, /\[Microsoft.VSTS.Common.Severity\]/);
      return wiql.endsWith('IN (1)') ? [rows[0]] : [rows[1]];
    },
  });
  assert.equal(hydrated.items[0].id, '2');
  assert.equal(hydrated.truncated, false);
  for (const patch of [
    { 'Microsoft.VSTS.Common.Priority': [] }, { 'Microsoft.VSTS.Common.Severity': {} },
    { 'System.CreatedBy': { uniqueName: 'a', imageUrl: 'javascript:alert(1)' } },
  ]) await assert.rejects(queryProfile(profile, {
    runJson: async () => [{ ...rows[1], fields: { ...rows[1].fields, ...patch } }],
  }), { code: 'PROVIDER_RESPONSE' });
});

test('normalized optional shapes and providerData strictly reject unknown keys and malformed values', async () => {
  const { items: [item] } = await queryProfile(github, { runJson: async () => search([issue(1)]) });
  const check = patch => validateQueryResult({ ...github, limit: 1 }, { items: [{ ...item, ...patch }], truncated: false });
  for (const patch of [
    { identities: {} }, { identities: { author: {} } }, { identities: { author: { id: 12 } } },
    { identities: { author: { login: 'a', raw: {} } } },
    { identities: { author: { avatarUrl: 'https://user:password@example.com/a' } } },
    { identities: { assignees: [null] } }, { identities: { reviewers: [] } },
    { identities: { author: { login: null } } }, { identities: { author: null } },
    { identities: { owner: { login: 'a' } } }, { identities: { author: { email: 'a@example.com' } } },
    { authorIdentity: { login: 'legacy' } },
    { labelDetails: [{ name: 'not-a-label', color: '#ffffff' }] },
    { labelDetails: [{ name: 'bug', color: 'ffffff' }] },
    { labelDetails: [{ name: 'bug', raw: {} }] },
    { providerData: { commentCount: null } }, { providerData: { closureReason: 'unknown' } },
    { providerData: { merged: true } }, { providerData: { raw: {} } },
  ]) assert.throws(() => check(patch), { code: 'INVALID_PROVIDER_RESPONSE' });
  const { labelDetails, ...base } = item;
  const cl = { ...base, provider: 'chromium', kind: 'cl', providerData: {} };
  const clProfile = { provider: 'chromium', resource: 'cls', limit: 1 };
  for (const providerData of [
    { insertions: -1 }, { deletions: 1.5 }, { unresolvedCommentCount: '1' },
    { codeReviewScores: [{}] }, { codeReviewScores: [{ reviewer: 'a', score: 3 }] },
    { codeReviewScores: [{ reviewer: 'a', score: 2, raw: {} }] }, { commentCount: 1 },
  ]) assert.throws(() => validateQueryResult(clProfile, { items: [{ ...cl, providerData }], truncated: false }),
    { code: 'INVALID_PROVIDER_RESPONSE' });
  validateQueryResult(clProfile, { items: [{ ...cl, providerData: {
    insertions: 0, deletions: 2, unresolvedCommentCount: 0,
    codeReviewScores: [{ reviewer: null, score: -2 }],
  } }], truncated: false });
});
