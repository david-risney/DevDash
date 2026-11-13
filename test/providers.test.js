import test from 'node:test';
import assert from 'node:assert/strict';
import { queryProfile, createProviderRegistry, providerRegistry } from '../src/providers.js';
import { DevDashError } from '../src/errors.js';
import { validateQueryResult } from '../src/providers/contract.js';

const ghProfile = { provider: 'github', resource: 'bugs', repository: 'owner/repo' };
const adoProfile = { provider: 'ado', resource: 'bugs', organization: 'https://dev.azure.com/org/', project: 'My Project', query: 'SELECT [System.Id] FROM WorkItems' };
const adoPrProfile = { ...adoProfile, resource: 'prs', query: undefined };
const clProfile = { provider: 'chromium', resource: 'cls', query: 'status:open' };
const timestamp = '2026-10-06T19:00:00Z';
const ghItem = number => ({
  number, title: `Issue ${number}`, state: 'open', user: { login: 'author' },
  repository_url: 'https://api.github.com/repos/owner/repo',
  assignees: [{ login: 'assignee' }], labels: [{ name: 'bug' }],
  created_at: timestamp, updated_at: timestamp, body: 'not exposed',
});
const bug = number => ({
  id: number, fields: {
    'System.Title': `Bug ${number}`, 'System.State': 'Active', 'System.WorkItemType': 'Bug',
    'System.TeamProject': 'My Project', 'System.CreatedBy': { uniqueName: 'author@example.com' },
    'System.AssignedTo': 'Assigned User', 'System.Tags': 'tag1; tag2; ',
    'System.CreatedDate': timestamp, 'System.ChangedDate': timestamp,
  },
});
const pr = number => ({
  pullRequestId: number, title: `PR ${number}`, status: 'active',
  repository: { name: 'Repo Name', project: { name: 'My Project' } },
  createdBy: { uniqueName: 'author@example.com' }, creationDate: timestamp,
  isDraft: false, reviewers: [{ uniqueName: 'reviewer@example.com' }],
  url: 'https://dev.azure.com/org/_apis/git/repositories/id/pullRequests/1',
});
const ghResponse = (items, total = items.length, incomplete = false) => ({
  items, total_count: total, incomplete_results: incomplete,
});
function fakeCli(responses) {
  const calls = [];
  return {
    calls,
    runJson: async (command, args) => {
      calls.push({ command, args });
      assert.ok(responses.length, 'Unexpected CLI request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const flag = (args, name) => args[args.indexOf(name) + 1];
const normalizedKeys = ['provider', 'kind', 'id', 'title', 'state', 'url', 'repository',
  'author', 'assignees', 'labels', 'createdAt', 'updatedAt', 'draft', 'providerData'];

test('GitHub uses JSON search arguments and normalizes only public fields', async () => {
  const cli = fakeCli([ghResponse([ghItem(1)])]);
  const result = await queryProfile(ghProfile, cli);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.items[0]), normalizedKeys);
  assert.deepEqual(result.items[0], {
    provider: 'github', kind: 'bug', id: '1', title: 'Issue 1', state: 'open',
    url: 'https://github.com/owner/repo/issues/1', repository: 'owner/repo',
    author: 'author', assignees: ['assignee'], labels: ['bug'],
    createdAt: '2026-10-06T19:00:00.000Z', updatedAt: '2026-10-06T19:00:00.000Z', draft: null,
    providerData: {},
  });
  assert.equal(cli.calls[0].command, 'gh');
  assert.equal(flag(cli.calls[0].args, '--method'), 'GET');
  assert.ok(cli.calls[0].args.includes('q=state:open repo:owner/repo is:issue'));
  assert.ok(cli.calls[0].args.includes('per_page=100'));
});

test('GitHub PRs use pull web URLs, draft, custom host and query', async () => {
  const cli = fakeCli([ghResponse([{ ...ghItem(2), pull_request: {}, draft: true }]), {
    number: 2, base: { repo: { full_name: 'owner/repo' } },
    merged: false, merged_at: null, requested_reviewers: [], requested_teams: [],
  }]);
  const { items } = await queryProfile({ ...ghProfile, resource: 'prs', hostname: 'git.example.com', query: 'label:"needs review"' }, cli);
  assert.equal(items[0].kind, 'pr');
  assert.equal(items[0].url, 'https://git.example.com/owner/repo/pull/2');
  assert.equal(items[0].draft, true);
  assert.equal(flag(cli.calls[0].args, '--hostname'), 'git.example.com');
  assert.ok(cli.calls[0].args.includes('q=label:"needs review" repo:owner/repo is:pr'));
});

test('GitHub providerData includes only the node ID, never raw search fields', async () => {
  const row = { ...ghItem(1), node_id: 'I_example', body: 'PRIVATE_BODY', token: 'PRIVATE_TOKEN' };
  const { items } = await queryProfile(ghProfile, fakeCli([ghResponse([row])]));
  assert.deepEqual(items[0].providerData, { nodeId: 'I_example' });
  assert.doesNotMatch(JSON.stringify(items), /PRIVATE_|node_id/);
  for (const node_id of ['', ' ', 1, {}]) {
    await assert.rejects(queryProfile(ghProfile, fakeCli([ghResponse([{ ...ghItem(1), node_id }])])),
      { code: 'PROVIDER_RESPONSE' });
  }
});

test('ADO providerData curates merge status and reviewer votes without moving shared fields', async () => {
  const row = { ...pr(1), sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded', description: 'PRIVATE_BODY', reviewers: [
      { uniqueName: 'reviewer@example.com', vote: 10, isRequired: true, imageUrl: 'https://example.com/avatar' },
      { displayName: 'Another reviewer', vote: -5, isRequired: false },
      { id: 'reviewer-id' },
    ] };
  const { items: [item] } = await queryProfile(adoPrProfile, fakeCli([[row]]));
  assert.equal(item.sourceBranch, 'feature');
  assert.equal(item.targetBranch, 'main');
  assert.deepEqual(item.reviewers, ['reviewer@example.com', 'Another reviewer', 'reviewer-id']);
  assert.deepEqual(item.providerData, {
    mergeStatus: 'succeeded',
    reviewerVotes: [
      { reviewer: 'reviewer@example.com', vote: 10, required: true },
      { reviewer: 'Another reviewer', vote: -5, required: false },
      { reviewer: 'reviewer-id', vote: null, required: null },
    ],
  });
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE_|imageUrl|description/);
  for (const vote of [-10, -5, 0, 5, 10, null]) {
    const result = await queryProfile(adoPrProfile, fakeCli([[{ ...pr(1), reviewers: [{ vote }] }]]));
    assert.equal(result.items[0].providerData.reviewerVotes[0].vote, vote);
  }
  for (const patch of [
    { mergeStatus: {} }, { reviewers: [{ vote: '10' }] }, { reviewers: [{ vote: 1 }] },
    { reviewers: [{ isRequired: 'true' }] },
  ]) {
    await assert.rejects(queryProfile(adoPrProfile, fakeCli([[{ ...pr(1), ...patch }]])),
      { code: 'PROVIDER_RESPONSE' });
  }
  const absent = await queryProfile(adoPrProfile, fakeCli([[{ ...pr(1), reviewers: null, mergeStatus: null }]]));
  assert.deepEqual(absent.items[0].providerData, { mergeStatus: null, reviewerVotes: [] });
});

test('providerData has a strict provider/resource-specific contract, not an arbitrary payload escape hatch', () => {
  const item = {
    provider: 'github', kind: 'bug', id: '1', title: 'Bug', state: 'open',
    url: 'https://github.com/owner/repo/issues/1', repository: 'owner/repo', author: null,
    assignees: [], labels: [], createdAt: null, updatedAt: null, draft: null, providerData: {},
  };
  const check = (profile, row) => validateQueryResult({ ...profile, limit: 1 }, { items: [row], truncated: false });
  for (const providerData of [undefined, null, [], 'x', { raw: {} }, { token: 'PRIVATE' },
    { changeId: 'I_other_provider' }, { nodeId: {} }, { nodeId: null }]) {
    assert.throws(() => check(ghProfile, { ...item, providerData }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  assert.throws(() => check(ghProfile, { ...item, details: {} }), { code: 'INVALID_PROVIDER_RESPONSE' });
  check(ghProfile, { ...item, priority: 'P2', severity: null, type: 'Bug' });
  const adoItem = { ...item, provider: 'ado', kind: 'pr' };
  for (const providerData of [
    { reviewerVotes: {} }, { reviewerVotes: [{}] },
    { reviewerVotes: [{ reviewer: null, vote: 0, required: null, raw: {} }] },
    { reviewerVotes: [{ reviewer: null, vote: 3, required: null }] },
    { reviewerVotes: [{ reviewer: null, vote: null, required: 'true' }] },
    { component: 'UI' },
  ]) assert.throws(() => check(adoPrProfile, { ...adoItem, providerData }), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => check(adoProfile, { ...adoItem, kind: 'bug', providerData: { mergeStatus: 'succeeded' } }),
    { code: 'INVALID_PROVIDER_RESPONSE' });
  const chromiumItem = { ...item, provider: 'chromium', providerData: { component: 'UI' }, priority: 'P2' };
  const chromiumProfile = { provider: 'chromium', resource: 'bugs' };
  check(chromiumProfile, chromiumItem);
  for (const patch of [{ priority: 2 }, { severity: [] }, { type: '' }, { providerData: { component: {} } }]) {
    assert.throws(() => check(chromiumProfile, { ...chromiumItem, ...patch }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  assert.throws(() => check(clProfile, { ...chromiumItem, kind: 'cl' }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('GitHub paginates and stops at total_count', async () => {
  const cli = fakeCli([
    ghResponse(Array.from({ length: 100 }, (_, n) => ghItem(n + 1)), 101),
    ghResponse([ghItem(101)], 101),
  ]);
  const result = await queryProfile(ghProfile, cli);
  assert.equal(result.items.length, 101);
  assert.equal(result.truncated, false);
  assert.ok(cli.calls[1].args.includes('page=2'));
});

test('GitHub limit, incomplete search and short pages explicitly truncate', async () => {
  for (const [profile, response] of [
    [{ ...ghProfile, limit: 1 }, ghResponse([ghItem(1), ghItem(2)], 2)],
    [ghProfile, ghResponse([], 0, true)],
    [ghProfile, ghResponse([ghItem(1)], 2)],
  ]) {
    assert.equal((await queryProfile(profile, fakeCli([response]))).truncated, true);
  }
});

test('GitHub search never requests above the 1000-result API ceiling', async () => {
  const cli = fakeCli(Array.from({ length: 10 }, (_, page) =>
    ghResponse(Array.from({ length: 100 }, (_, n) => ghItem(page * 100 + n + 1)), 1200)));
  const result = await queryProfile({ ...ghProfile, limit: 20000 }, cli);
  assert.equal(result.items.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(cli.calls.length, 10);
});

test('GitHub empty result is complete', async () => {
  assert.deepEqual(await queryProfile(ghProfile, fakeCli([ghResponse([])])), { items: [], truncated: false });
});

test('GitHub rejects conflicting scope qualifiers before making CLI requests', async () => {
  for (const query of [
    'is:pr', 'type:pr', 'repo:other/repo', 'repo:"other/repo"',
    '(repo:other/repo OR label:bug)', '-is:issue', '-repo:owner/repo',
  ]) {
    const cli = fakeCli([]);
    await assert.rejects(queryProfile({ ...ghProfile, query }, cli), { code: 'INVALID_PROFILE' });
    assert.equal(cli.calls.length, 0);
  }
  await assert.rejects(queryProfile({ ...ghProfile, resource: 'prs', query: 'is:issue' }, fakeCli([])),
    { code: 'INVALID_PROFILE' });
});

test('GitHub permits matching qualifiers, exclusions and qualifier-like quoted labels', async () => {
  for (const query of [
    'repo:OWNER/REPO is:issue', '-is:pr', '-repo:other/repo', 'label:"not is:pr"',
  ]) {
    assert.deepEqual(await queryProfile({ ...ghProfile, query }, fakeCli([ghResponse([])])),
      { items: [], truncated: false });
  }
});

test('GitHub resolves @me once per profile and uses the selected hostname on every request', async () => {
  const cli = fakeCli([
    { login: 'current-user', email: 'not exposed' },
    ghResponse(Array.from({ length: 100 }, (_, n) => ghItem(n + 1)), 101),
    ghResponse([ghItem(101)], 101),
  ]);
  const result = await queryProfile({ ...ghProfile, hostname: 'git.example.com',
    query: 'is:open author:@me assignee:"@me" (-commenter:@me OR involves:@me)' }, cli);
  assert.equal(result.items.length, 101);
  assert.equal(cli.calls.length, 3);
  assert.deepEqual(cli.calls[0].args.slice(0, 4), ['api', '--method', 'GET', 'user']);
  for (const call of cli.calls) {
    assert.equal(call.command, 'gh');
    assert.equal(flag(call.args, '--hostname'), 'git.example.com');
  }
  for (const call of cli.calls.slice(1)) {
    assert.ok(call.args.includes('q=is:open author:current-user assignee:current-user (-commenter:current-user OR involves:current-user) repo:owner/repo is:issue'));
  }
});

test('GitHub expands only valid user qualifiers and leaves quoted literals untouched', async () => {
  const qualifiers = ['author', 'assignee', 'mentions', 'commenter', 'involves',
    'reviewed-by', 'review-requested', 'user-review-requested', 'user'];
  const query = qualifiers.map(name => `${name}:@me`).join(' ') +
    ' label:"author:@me" "mentions:@me" org:@me team-review-requested:@me milestone:@me @me';
  const cli = fakeCli([{ login: 'current-user' }, ghResponse([])]);
  await queryProfile({ ...ghProfile, query }, cli);
  const actual = cli.calls[1].args.find(arg => arg.startsWith('q='));
  for (const qualifier of qualifiers) assert.ok(actual.includes(`${qualifier}:current-user`));
  assert.ok(actual.includes('label:"author:@me" "mentions:@me" org:@me team-review-requested:@me milestone:@me @me'));
});

test('GitHub skips identity lookups for non-qualifier @me literals', async () => {
  for (const query of [
    'label:"author:@me" "@me" @me commenter:somebody',
    String.raw`label:"text \" author:@me \" end"`,
    String.raw`label:"text \" repo:other/repo \" end"`,
  ]) {
    const cli = fakeCli([ghResponse([])]);
    await queryProfile({ ...ghProfile, query }, cli);
    assert.equal(cli.calls.length, 1);
    assert.ok(cli.calls[0].args.includes('search/issues'));
    assert.ok(cli.calls[0].args.includes(`q=${query} repo:owner/repo is:issue`));
  }
});

test('GitHub validates authenticated user shapes and sanitizes lookup failures', async () => {
  for (const user of [null, {}, { login: '' }, { login: 'unsafe author:other' }]) {
    const cli = fakeCli([user]);
    await assert.rejects(queryProfile({ ...ghProfile, query: 'author:@me' }, cli),
      { code: 'PROVIDER_RESPONSE' });
    assert.equal(cli.calls.length, 1);
  }
  await assert.rejects(queryProfile({ ...ghProfile, query: 'author:@me' },
    fakeCli([new DevDashError('CLI_FAILED', 'private-token')])),
  error => error.code === 'CLI_FAILED' && !error.message.includes('private-token'));
});

test('GitHub validates actual response resource and repository even for OR searches', async () => {
  for (const row of [
    { ...ghItem(1), pull_request: {} },
    { ...ghItem(1), repository_url: 'https://api.github.com/repos/other/repo' },
    { ...ghItem(1), repository_url: 'invalid URL' },
  ]) {
    await assert.rejects(queryProfile(ghProfile, fakeCli([ghResponse([row])])),
      { code: 'PROVIDER_RESPONSE' });
  }
  await assert.rejects(queryProfile({ ...ghProfile, resource: 'prs' }, fakeCli([ghResponse([ghItem(1)])])),
    { code: 'PROVIDER_RESPONSE' });
});

test('GitHub exact page and search-cap matches are not falsely truncated', async () => {
  for (const count of [100, 1000]) {
    const cli = fakeCli(Array.from({ length: count / 100 }, (_, page) =>
      ghResponse(Array.from({ length: 100 }, (_, n) => ghItem(page * 100 + n + 1)), count)));
    const result = await queryProfile({ ...ghProfile, limit: count }, cli);
    assert.equal(result.items.length, count);
    assert.equal(result.truncated, false);
    assert.equal(cli.calls.length, count / 100);
  }
});

test('ADO boards list normalization and WIQL flags', async () => {
  const cli = fakeCli([[bug(1)]]);
  const result = await queryProfile(adoProfile, cli);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.items[0]), [...normalizedKeys, 'type']);
  assert.equal(result.items[0].url, 'https://dev.azure.com/org/My%20Project/_workitems/edit/1');
  assert.equal(result.items[0].repository, null);
  assert.deepEqual(result.items[0].labels, ['tag1', 'tag2']);
  assert.deepEqual(result.items[0].assignees, ['Assigned User']);
  assert.equal(flag(cli.calls[0].args, '--wiql'), adoProfile.query);
  assert.equal(flag(cli.calls[0].args, '--query'), 'not_null(@, `[]`)');
  assert.equal(flag(cli.calls[0].args, '--detect'), 'false');
  assert.equal(flag(cli.calls[0].args, '--output'), 'json');
  assert.ok(cli.calls[0].args.includes('--only-show-errors'));
});

test('ADO saved query uses --id and official null no-match shape', async () => {
  const cli = fakeCli([{ queryType: 'flat' }, null]);
  assert.deepEqual(await queryProfile({ ...adoProfile, query: undefined, queryId: 'query-guid' }, cli),
    { items: [], truncated: false });
  assert.equal(flag(cli.calls[0].args, '--resource'), 'queries');
  assert.ok(cli.calls[0].args.includes('query=query-guid'));
  assert.equal(flag(cli.calls[1].args, '--id'), 'query-guid');
  assert.ok(!cli.calls[1].args.includes('--wiql'));
});

test('ADO saved folders, trees and link queries are rejected instead of appearing empty', async () => {
  for (const query of [{ queryType: 'tree' }, { queryType: 'oneHop' }, { isFolder: true }]) {
    const cli = fakeCli([query]);
    await assert.rejects(queryProfile({ ...adoProfile, queryId: 'query-guid', query: undefined }, cli),
      { code: 'UNSUPPORTED_QUERY' });
    assert.equal(cli.calls.length, 1);
  }
  assert.deepEqual(await queryProfile({ ...adoProfile,
    query: "SELECT [System.Id] FROM WorkItems WHERE [System.Title] = 'FROM WorkItemLinks'" },
  fakeCli([[]])), { items: [], truncated: false });
  await assert.rejects(queryProfile({ ...adoProfile, queryId: 'query-guid', query: undefined }, fakeCli([{}])),
    { code: 'PROVIDER_RESPONSE' });
  for (const query of ['SELECT [System.Id] FROM WorkItemLinks', 'SELECT [System.Id] FROM [WorkItemLinks]']) {
    const cli = fakeCli([]);
    await assert.rejects(queryProfile({ ...adoProfile, query }, cli), { code: 'UNSUPPORTED_QUERY' });
    assert.equal(cli.calls.length, 0);
  }
});

test('ADO malformed non-null query output is never converted to empty success', async () => {
  for (const response of [false, 0, '', {}, { workItemRelations: [] }]) {
    await assert.rejects(queryProfile(adoProfile, fakeCli([response])), { code: 'PROVIDER_RESPONSE' });
  }
});

test('ADO WIQL is flat SELECT from WorkItems and binds @project to the named profile', async () => {
  const cli = fakeCli([[]]);
  const profile = { ...adoProfile, project: "Project's Name",
    query: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project AND [System.Title] <> \'@project\' AND [System.Tags] <> "@project"' };
  await queryProfile(profile, cli);
  assert.equal(flag(cli.calls[0].args, '--wiql'),
    'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = \'Project\'\'s Name\' AND [System.Title] <> \'@project\' AND [System.Tags] <> "@project"');
  for (const query of ['FROM WorkItems', 'SELECT [System.Id] FROM OtherTable']) {
    const invalidCli = fakeCli([]);
    await assert.rejects(queryProfile({ ...adoProfile, query }, invalidCli), { code: 'INVALID_PROFILE' });
    assert.equal(invalidCli.calls.length, 0);
  }
});

test('Every ADO work-item request disables detection and explicitly names organization and project', async () => {
  const cli = fakeCli([{ queryType: 'flat' }, [{ id: 1 }], [bug(1)]]);
  await queryProfile({ ...adoProfile, queryId: 'query-guid', query: undefined }, cli);
  assert.equal(cli.calls.length, 3);
  for (const { command, args } of cli.calls) {
    assert.equal(command, 'az');
    assert.equal(flag(args, '--organization'), adoProfile.organization);
    assert.equal(flag(args, '--detect'), 'false');
    if (args[0] === 'boards') assert.equal(flag(args, '--project'), adoProfile.project);
    else assert.ok(args.includes(`project=${adoProfile.project}`));
  }
});

test('ADO hydrates selected WIQL columns in batches and restores query ordering', async () => {
  const rows = Array.from({ length: 201 }, (_, n) => ({ id: n + 1, fields: { 'System.Title': 'Selected' } }));
  const cli = fakeCli([rows, rows.slice(0, 200).reverse().map(row => bug(row.id)), [bug(201)]]);
  const result = await queryProfile(adoProfile, cli);
  assert.equal(result.items.length, 201);
  assert.equal(result.items[0].id, '1');
  assert.equal(result.items.at(-1).id, '201');
  assert.equal(cli.calls.length, 3);
  assert.deepEqual(cli.calls[1].args.slice(0, 2), ['boards', 'query']);
  const firstHydration = flag(cli.calls[1].args, '--wiql');
  assert.ok(firstHydration.endsWith('AND [System.Id] IN (' + rows.slice(0, 200).map(row => row.id).join(',') + ')'));
  assert.ok(firstHydration.includes("[System.TeamProject] = 'My Project'"));
  for (const field of ['System.Title', 'System.WorkItemType', 'System.AssignedTo', 'System.Tags']) {
    assert.ok(firstHydration.includes(`[${field}]`));
  }
  assert.ok(flag(cli.calls[2].args, '--wiql').endsWith('AND [System.Id] IN (201)'));
  assert.equal(flag(cli.calls[1].args, '--project'), 'My Project');
  assert.equal(flag(cli.calls[1].args, '--query'), 'not_null(@, `[]`)');
});

test('ADO top-level work-item ID survives projected fields without System.Id', async () => {
  const cli = fakeCli([[{
    id: 1, fields: { 'System.Title': 'Selected title', 'System.State': 'Active' },
  }], [bug(1)]]);
  const result = await queryProfile(adoProfile, cli);
  assert.equal(result.items[0].id, '1');
  assert.equal(result.truncated, false);
  await assert.rejects(queryProfile(adoProfile, fakeCli([[{ fields: { 'System.Id': 1 } }]])),
    { code: 'PROVIDER_RESPONSE' });
});

test('ADO hydration respects URL length as well as the maximum batch count', async () => {
  const rows = Array.from({ length: 200 }, (_, n) => ({ id: 1000000000 + n }));
  const batches = [];
  const result = await queryProfile(adoProfile, {
    runJson: async (command, args) => {
      if (flag(args, '--wiql') === adoProfile.query) return rows;
      assert.deepEqual(args.slice(0, 2), ['boards', 'query']);
      const ids = flag(args, '--wiql').match(/\[System.Id\] IN \(([\d,]+)\)$/)[1].split(',').map(Number);
      batches.push(ids);
      return ids.map(bug);
    },
  });
  assert.equal(result.items.length, 200);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), rows.map(row => row.id));
  assert.ok(batches.every(batch => batch.length <= 200));
});

test('ADO hydrates only items within the requested limit and marks truncation', async () => {
  const cli = fakeCli([[{ id: 1 }, { id: 2 }], [bug(1)]]);
  const result = await queryProfile({ ...adoProfile, limit: 1 }, cli);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, true);
  assert.ok(flag(cli.calls[1].args, '--wiql').endsWith('AND [System.Id] IN (1)'));
});

test('ADO hydrates omitted optional fields rather than losing tags and assignment', async () => {
  const selected = bug(1);
  delete selected.fields['System.AssignedTo'];
  delete selected.fields['System.Tags'];
  const cli = fakeCli([[selected], [bug(1)]]);
  const result = await queryProfile(adoProfile, cli);
  assert.deepEqual(result.items[0].labels, ['tag1', 'tag2']);
  assert.deepEqual(result.items[0].assignees, ['Assigned User']);
  assert.equal(cli.calls.length, 2);
});

test('ADO hydration rejects missing, duplicate, unexpected and malformed rows without a success fallback', async () => {
  for (const response of [null, [], [bug(2)], [bug(1), bug(1)], { value: [bug(1)] }]) {
    await assert.rejects(queryProfile(adoProfile, fakeCli([[{ id: 1 }], response])), { code: 'PROVIDER_RESPONSE' });
  }
  const cli = fakeCli([[{ id: 1 }], [bug(1)]]);
  await queryProfile({ ...adoProfile, project: "Project's Name" }, cli);
  assert.ok(flag(cli.calls[1].args, '--wiql').includes("[System.TeamProject] = 'Project''s Name'"));
});

test('ADO work-item ceiling is conservatively flagged, including exactly 1000', async () => {
  const result = await queryProfile({ ...adoProfile, limit: 20000 },
    fakeCli([Array.from({ length: 1000 }, (_, n) => bug(n + 1))]));
  assert.equal(result.items.length, 1000);
  assert.equal(result.truncated, true);
  const overshoot = await queryProfile({ ...adoProfile, limit: 20000 },
    fakeCli([Array.from({ length: 1100 }, (_, n) => bug(n + 1))]));
  assert.equal(overshoot.items.length, 1000);
  assert.equal(overshoot.truncated, true);
});

test('ADO bugs omit non-bug query matches', async () => {
  const row = bug(1);
  row.fields['System.WorkItemType'] = 'Task';
  assert.deepEqual(await queryProfile(adoProfile, fakeCli([[row]])), { items: [], truncated: false });
});

test('ADO PRs paginate with valid CLI filters and canonical URLs', async () => {
  const cli = fakeCli([
    Array.from({ length: 100 }, (_, n) => pr(n + 1)),
    [pr(101)],
  ]);
  const result = await queryProfile({ ...adoPrProfile, repository: 'Repo Name',
    status: 'all', creator: 'author', reviewer: 'reviewer' }, cli);
  assert.equal(result.items.length, 101);
  assert.equal(result.truncated, false);
  assert.equal(result.items[0].url, 'https://dev.azure.com/org/My%20Project/_git/Repo%20Name/pullrequest/1');
  assert.equal(result.items[0].updatedAt, null);
  assert.deepEqual(result.items[0].assignees, []);
  assert.equal(flag(cli.calls[0].args, '--status'), 'all');
  assert.equal(flag(cli.calls[0].args, '--creator'), 'author');
  assert.equal(flag(cli.calls[0].args, '--reviewer'), 'reviewer');
  assert.equal(flag(cli.calls[0].args, '--repository'), 'Repo Name');
  assert.equal(flag(cli.calls[1].args, '--skip'), '100');
});

test('ADO PR limit detects an extra item instead of truncating exact matches', async () => {
  for (const [rows, truncated] of [[[pr(1)], false], [[pr(1), pr(2)], true]]) {
    const cli = fakeCli([rows]);
    const result = await queryProfile({ ...adoPrProfile, limit: 1 }, cli);
    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, truncated);
    assert.equal(flag(cli.calls[0].args, '--top'), '2');
  }
});

test('ADO PR empty result is complete and uses active status by default', async () => {
  const cli = fakeCli([[]]);
  assert.deepEqual(await queryProfile(adoPrProfile, cli), {
    items: [], truncated: false,
  });

  test('ADO PR object queries forward only supported native parameters on every page and existence probe', async () => {
    const cli = fakeCli([Array.from({ length: 100 }, (_, n) => pr(n + 1)), []]);
    const query = { author: 'author@example.com', reviewer: 'reviewer@example.com',
      sourceBranch: 'feature/cache & literal', targetBranch: 'refs/heads/main', status: 'all' };
    const result = await queryProfile({ ...adoProfile, resource: 'prs', repository: 'Repo Name', limit: 100,
      query, filter: 'title:PR' }, cli);
    assert.equal(result.items.length, 100);
    assert.equal(result.truncated, false);
    assert.equal(cli.calls.length, 2);
    for (const { command, args } of cli.calls) {
      assert.equal(command, 'az');
      assert.equal(flag(args, '--creator'), query.author);
      assert.equal(flag(args, '--reviewer'), query.reviewer);
      assert.equal(flag(args, '--source-branch'), query.sourceBranch);
      assert.equal(flag(args, '--target-branch'), query.targetBranch);
      assert.equal(flag(args, '--status'), query.status);
      assert.equal(flag(args, '--repository'), 'Repo Name');
      assert.equal(args.includes('title:PR'), false);
      assert.equal(args.includes('--query'), false);
    }
    assert.equal(flag(cli.calls[1].args, '--top'), '1');
  });

  test('ADO PR branch and reviewer concepts are normalized independently of assignees', async () => {
    const row = { ...pr(1), sourceRefName: 'refs/heads/feature/cache', targetRefName: 'refs/heads/main',
      reviewers: [{ uniqueName: 'first@example.com' }, { displayName: 'Second Person' }, { id: 'reviewer-id' }] };
    const result = await queryProfile({ ...adoProfile, resource: 'prs', query: {},
      filter: 'source-branch:cache targetBranch:main reviewer:second author:author' }, fakeCli([[row]]));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sourceBranch, 'feature/cache');
    assert.equal(result.items[0].targetBranch, 'main');
    assert.deepEqual(result.items[0].reviewers, ['first@example.com', 'Second Person', 'reviewer-id']);
    assert.deepEqual(result.items[0].assignees, []);
    const nullable = await queryProfile({ ...adoProfile, resource: 'prs', query: {} },
      fakeCli([[{ ...pr(1), sourceRefName: null, targetRefName: null, reviewers: null }]]));
    assert.equal(nullable.items[0].sourceBranch, null);
    assert.equal(nullable.items[0].targetBranch, null);
    assert.deepEqual(nullable.items[0].reviewers, []);
    for (const update of [{ sourceRefName: {} }, { targetRefName: '' }, { targetRefName: 'refs/heads/' }, { reviewers: 'someone' }]) {
      await assert.rejects(queryProfile({ ...adoProfile, resource: 'prs', query: {} },
        fakeCli([[{ ...pr(1), ...update }]])), { code: 'PROVIDER_RESPONSE' });
    }
  });

  test('ADO structured bugs support WIQL and saved IDs without passing generic filter terms to az', async () => {
    const wiql = fakeCli([[bug(1), bug(2)]]);
    const result = await queryProfile({ ...adoProfile, query: { wiql: adoProfile.query }, filter: 'title:"Bug 2"' }, wiql);
    assert.deepEqual(result.items.map(item => item.id), ['2']);
    assert.equal(flag(wiql.calls[0].args, '--wiql'), adoProfile.query);
    assert.ok(!wiql.calls[0].args.includes('title:"Bug 2"'));
    const saved = fakeCli([{ queryType: 'flat' }, [bug(1)]]);
    await queryProfile({ ...adoProfile, query: { queryId: '01234567-89ab-cdef-0123-456789abcdef' } }, saved);
    assert.equal(flag(saved.calls[1].args, '--id'), '01234567-89ab-cdef-0123-456789abcdef');
  });

  test('Invalid native options and filter properties fail before running external provider commands', async () => {
    for (const update of [
      { query: { unsupported: 'SECRET_QUERY' } }, { query: { status: 'open' } }, { query: 'author:someone' },
    ]) {
      const cli = fakeCli([]);
      await assert.rejects(queryProfile({ ...adoProfile, resource: 'prs', ...update }, cli), { code: 'INVALID_PROFILE' });
      assert.equal(cli.calls.length, 0);
    }
    const cli = fakeCli([]);
    await assert.rejects(queryProfile({ ...ghProfile, filter: 'sourceBranch:main' }, cli), { code: 'INVALID_FILTER' });
    assert.equal(cli.calls.length, 0);
  });
  assert.equal(flag(cli.calls[0].args, '--status'), 'active');
});

test('Project-wide ADO PR pagination never infers a repository from cwd or CLI defaults', async () => {
  const cli = fakeCli([Array.from({ length: 100 }, (_, n) => pr(n + 1)), []]);
  await queryProfile(adoPrProfile, cli);
  assert.equal(cli.calls.length, 2);
  for (const { command, args } of cli.calls) {
    assert.equal(command, 'az');
    assert.equal(flag(args, '--detect'), 'false');
    assert.equal(flag(args, '--organization'), adoProfile.organization);
    assert.equal(flag(args, '--project'), adoProfile.project);
    assert.equal(flag(args, '--status'), 'active');
    assert.ok(!args.includes('--repository'));
    assert.ok(!args.includes('--creator'));
    assert.ok(!args.includes('--reviewer'));
  }
});

test('ADO PR default and maximum exact limits include the final existence probe', async () => {
  for (const limit of [1000, 20000]) {
    const cli = fakeCli([
      ...Array.from({ length: limit / 100 }, (_, page) =>
        Array.from({ length: 100 }, (_, n) => pr(page * 100 + n + 1))),
      [],
    ]);
    const result = await queryProfile({ ...adoPrProfile, limit }, cli);
    assert.equal(result.items.length, limit);
    assert.equal(result.truncated, false);
    assert.equal(cli.calls.length, limit / 100 + 1);
    assert.equal(flag(cli.calls.at(-1).args, '--skip'), String(limit));
    assert.equal(flag(cli.calls.at(-1).args, '--top'), '1');
  }
});

test('Optional absent metadata stays null or empty and dates convert offsets to UTC', async () => {
  const row = { number: 1, title: 'Bare issue', state: 'open', repository_url: 'https://api.github.com/repos/owner/repo', created_at: '2026-10-06T12:00:00-07:00' };
  const github = await queryProfile(ghProfile, fakeCli([ghResponse([row])]));
  assert.equal(github.items[0].createdAt, '2026-10-06T19:00:00.000Z');
  assert.equal(github.items[0].updatedAt, null);
  assert.equal(github.items[0].author, null);
  assert.deepEqual(github.items[0].assignees, []);
});

test('Malformed CLI shapes fail explicitly', async () => {
  const cases = [
    [ghProfile, null],
    [ghProfile, {}],
    [ghProfile, { ...ghResponse([]), incomplete_results: 'false' }],
    [ghProfile, ghResponse([{ title: 'Missing ID' }])],
    [ghProfile, ghResponse([{ ...ghItem(1), updated_at: 'yesterday' }])],
    [ghProfile, ghResponse([{ ...ghItem(1), labels: {} }])],
    [{ ...ghProfile, resource: 'prs' }, ghResponse([{ ...ghItem(1), draft: 'false' }])],
    [adoProfile, { workItems: [{ id: 1 }] }],
    [adoProfile, '[]'],
    [adoPrProfile, null],
    [adoPrProfile, [{ ...pr(1), repository: null }]],
  ];
  for (const [profile, response] of cases) {
    await assert.rejects(queryProfile(profile, fakeCli([response])), { code: 'PROVIDER_RESPONSE' });
  }
});

test('Hydration rejects missing, duplicate and unexpected work items', async () => {
  for (const response of [{}, { value: [] }, { value: [bug(2)] }, { value: [bug(1), bug(1)] }]) {
    await assert.rejects(queryProfile(adoProfile, fakeCli([[{ id: 1 }], response])),
      { code: 'PROVIDER_RESPONSE' });
  }
});

test('Provider pagination rejects repeats rather than looping', async () => {
  const rows = Array.from({ length: 100 }, (_, n) => ghItem(n + 1));
  await assert.rejects(queryProfile(ghProfile, fakeCli([ghResponse(rows, 200), ghResponse(rows, 200)])),
    { code: 'PROVIDER_RESPONSE' });
});

test('CLI failures do not disclose stderr, query contents or user tokens', async () => {
  for (const error of [
    new DevDashError('CLI_FAILED', 'secret-token in stderr'),
    new Error('secret-token in stderr'),
  ]) {
    await assert.rejects(queryProfile(ghProfile, fakeCli([error])), actual =>
      actual.code === 'CLI_FAILED' && !actual.message.includes('secret-token'));
  }
});

test('Invalid Chromium bug profiles and invalid limits are rejected', async () => {
  await assert.rejects(queryProfile({ provider: 'chromium', resource: 'bugs' }), { code: 'INVALID_PROFILE' });
  for (const limit of [0, -1, 20001, 1.5, '100']) {
    await assert.rejects(queryProfile({ ...ghProfile, limit }), { code: 'INVALID_PROFILE' });
  }
});

const chromiumItem = (id = '1', kind = 'cl') => ({
  provider: 'chromium', kind, id, title: 'Public item', state: 'NEW',
  url: kind === 'cl'
    ? `https://chromium-review.googlesource.com/c/chromium/src/+/${id}`
    : `https://issues.chromium.org/issues/${id}`,
  repository: kind === 'cl' ? 'chromium/src' : null, author: null,
  assignees: [], labels: [], createdAt: null, updatedAt: null, draft: null, providerData: {},
});
const crResponse = (items = [], truncated = false) => ({ schemaVersion: 1, items, truncated });

test('All providers implement the common external CLI adapter contract', () => {
  assert.deepEqual(Object.values(providerRegistry).map(({ id, cli, resources }) => ({ id, cli, resources })), [
    { id: 'github', cli: 'gh', resources: ['bugs', 'prs'] },
    { id: 'ado', cli: 'az', resources: ['bugs', 'prs'] },
    { id: 'chromium', cli: 'cr', resources: ['bugs', 'cls'] },
  ]);
  assert.ok(Object.isFrozen(providerRegistry));
  assert.ok(Object.values(providerRegistry).every(adapter =>
    Object.isFrozen(adapter) && Object.isFrozen(adapter.resources) && typeof adapter.query === 'function'));
  for (const adapters of [undefined, null, {}, 'gh']) {
    assert.throws(() => createProviderRegistry(adapters), { code: 'INVALID_PROVIDER' });
  }
  for (const adapters of [[{}], [providerRegistry.github, providerRegistry.github],
    [{ cli: 'gh', resources: ['bugs'], query: async () => ({ items: [], truncated: false }) }],
    [{ id: 'github', resources: ['bugs'], query: async () => ({ items: [], truncated: false }) }],
  ]) {
    assert.throws(() => createProviderRegistry(adapters), { code: 'INVALID_PROVIDER' });
  }
});

test('Provider registry is injectable and enforces CLI, resource, limit, and result contracts', async () => {
  for (const profile of [undefined, null, [], 'github']) {
    await assert.rejects(queryProfile(profile), { code: 'INVALID_PROFILE' });
  }
  const providers = createProviderRegistry([{
    id: 'github', cli: 'gh', resources: ['bugs'],
    query: async (profile, context) => {
      assert.equal(profile.limit, 1000);
      await context.runJson('gh', ['--version']);
      return { items: [], truncated: false };
    },
  }]);
  assert.deepEqual(await queryProfile(ghProfile, { providers, runJson: async () => ({}) }),
    { items: [], truncated: false });
  await assert.rejects(queryProfile({ ...ghProfile, resource: 'prs' }, { providers }), { code: 'UNSUPPORTED_PROVIDER' });
  await assert.rejects(queryProfile({ ...ghProfile, provider: 'constructor' }), { code: 'UNSUPPORTED_PROVIDER' });
  const mismatched = createProviderRegistry([{
    id: 'github', cli: 'gh', resources: ['bugs'],
    query: (profile, context) => context.runJson('az', []),
  }]);
  await assert.rejects(queryProfile(ghProfile, { providers: mismatched }), { code: 'INVALID_PROVIDER' });
});

test('Chromium CL adapter invokes cr with explicit query, project, host, and limit', async () => {
  const profile = { ...clProfile, project: 'chromium/src', host: 'https://review.example.com', limit: 1,
    query: 'status:open owner:"name with spaces" & no-shell' };
  const item = { ...chromiumItem(), url: 'https://review.example.com/c/chromium/src/+/1' };
  const cli = fakeCli([crResponse([item], true)]);
  const result = await queryProfile(profile, cli);
  assert.deepEqual(result, { items: [item], truncated: true });
  assert.deepEqual(cli.calls, [{
    command: 'cr', args: ['cls', 'list', `--query=${profile.query}`, `--project=${profile.project}`,
      `--host=${profile.host}`, '--limit', '1'],
  }]);
});

test('Gerrit exclusion queries and project names starting with a dash are unambiguous CLI values', async () => {
  const cli = fakeCli([crResponse()]);
  await queryProfile({ ...clProfile, query: '-status:merged', project: '-project' }, cli);
  assert.deepEqual(cli.calls[0].args, [
    'cls', 'list', '--query=-status:merged', '--project=-project', '--limit', '1000',
  ]);
});

test('Chromium bugs invoke the external cr CLI and use a bounded per-request timeout', async () => {
  const profile = { provider: 'chromium', resource: 'bugs', bugIds: ['1', '2'], limit: 1 };
  const result = await queryProfile(profile, {
    runJson: async (command, args, options) => {
      assert.equal(command, 'cr');
      assert.deepEqual(args, ['bugs', 'view', '1', '2', '--limit', '1']);
      assert.equal(options.timeout, 195_000);
      return crResponse([chromiumItem('1', 'bug')], true);
    },
  });

  test('Chromium structured bug selectors and generic filters stay separate from the cr command', async () => {
    const items = [chromiumItem('1', 'bug'), { ...chromiumItem('2', 'bug'), title: 'Match this bug' }];
    const cli = fakeCli([crResponse(items)]);
    const result = await queryProfile({ provider: 'chromium', resource: 'bugs',
      query: { bugIds: ['1', '2'] }, filter: 'title:match' }, cli);
    assert.deepEqual(result.items.map(item => item.id), ['2']);
    assert.deepEqual(cli.calls[0], { command: 'cr', args: ['bugs', 'view', '1', '2', '--limit', '1000'] });
  });
  assert.equal(result.truncated, true);
  for (const bugIds of [undefined, [], [1], ['0'], ['1', '1'], ['2', 'x'], Array(101).fill('1')]) {
    await assert.rejects(queryProfile({ ...profile, bugIds }), { code: 'INVALID_PROFILE' });
  }
});

test('Chromium native bug searches use cr list and preserve truncation after local filtering', async () => {
  const profile = { provider: 'chromium', resource: 'bugs', query: '-status:closed title:"memory & cache"', limit: 2,
    filter: 'title:match' };
  let calls = 0;
  const result = await queryProfile(profile, { runJson: async (command, args, options) => {
    calls++;
    assert.equal(command, 'cr');
    assert.deepEqual(args, ['bugs', 'list', `--query=${profile.query}`, '--limit', '2']);
    assert.equal(options.timeout, 330_000);
    return crResponse([chromiumItem('1', 'bug'), { ...chromiumItem('2', 'bug'), title: 'Match' }], true);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.items.map(item => item.id), ['2']);
  assert.equal(result.truncated, true);
  const zero = await queryProfile({ ...profile, filter: 'title:no-match' },
    fakeCli([crResponse([chromiumItem('1', 'bug')], true)]));
  assert.deepEqual(zero, { items: [], truncated: true });
  assert.deepEqual(await queryProfile(profile, fakeCli([crResponse()])), { items: [], truncated: false });
  for (const query of ['', ' ', 'type:bug\n', 'type:bug\u007f']) {
    await assert.rejects(queryProfile({ ...profile, query }, { runJson: () => assert.fail('Unexpected provider execution') }),
      { code: 'INVALID_PROFILE' });
  }
  await assert.rejects(queryProfile({ ...profile, bugIds: ['1'] }), { code: 'INVALID_PROFILE' });
});

test('Cr schema, normalized metadata, requested IDs, duplicate items, and scope are validated', async () => {
  const valid = chromiumItem();
  for (const response of [
    null, [], {}, { items: [], truncated: false }, { schemaVersion: 2, items: [], truncated: false },
    crResponse([], 'false'), crResponse([valid, valid]),
    crResponse([{ ...valid, provider: 'github' }]), crResponse([{ ...valid, kind: 'bug' }]),
    crResponse([{ ...valid, id: 1 }]), crResponse([{ ...valid, title: '' }]),
    crResponse([{ ...valid, url: 'http://unsafe.example/1' }]),
    crResponse([{ ...valid, url: 'https://token@unsafe.example/1' }]),
    crResponse([{ ...valid, updatedAt: 'yesterday' }]),
    crResponse([{ ...valid, updatedAt: '2026-10-06T19:00:00Z' }]),
    crResponse([{ ...valid, updatedAt: '2026-02-31T19:00:00.000Z' }]),
    crResponse([{ ...valid, assignees: 'person' }]),
    crResponse([{ ...valid, raw: 'unrequested provider content' }]),
    crResponse([{ ...valid, details: {} }]),
  ]) {
    await assert.rejects(queryProfile(clProfile, fakeCli([response])), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  await assert.rejects(queryProfile({ ...clProfile, project: 'other/project' },
    fakeCli([crResponse([valid])])), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(queryProfile({ ...clProfile, limit: 1 },
    fakeCli([crResponse([valid, chromiumItem('2')])])), { code: 'INVALID_PROVIDER_RESPONSE' });
  const bugs = { provider: 'chromium', resource: 'bugs', bugIds: ['1'] };
  for (const items of [[], [chromiumItem('2', 'bug')]]) {
    await assert.rejects(queryProfile(bugs, fakeCli([crResponse(items)])), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  await assert.rejects(queryProfile(bugs, fakeCli([crResponse([chromiumItem('1', 'bug')], true)])),
    { code: 'INVALID_PROVIDER_RESPONSE' });
  for (const response of [
    crResponse([chromiumItem('1', 'bug'), chromiumItem('1', 'bug')]),
    crResponse([chromiumItem('1', 'cl')]),
    crResponse([{ ...chromiumItem('1', 'bug'), url: 'https://other.example/issues/1' }]),
  ]) await assert.rejects(queryProfile({ provider: 'chromium', resource: 'bugs', query: 'type:bug' }, fakeCli([response])),
    { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(queryProfile(clProfile, fakeCli([crResponse([{
    ...valid, url: 'https://other.example/c/chromium/src/+/1',
  }])])), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('Cr failure codes and safe diagnostic IDs survive the provider abstraction', async () => {
  const failure = new DevDashError('BUG_NOT_FOUND', 'cr could not find the public bug.');
  failure.diagnosticId = '628940ce-0dea-49cc-acb3-1da801367e32';
  await assert.rejects(queryProfile(clProfile, fakeCli([failure])), error =>
    error === failure && error.diagnosticId === failure.diagnosticId);
});
