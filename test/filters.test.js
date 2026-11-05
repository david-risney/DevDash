import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, filterItems, filterProperties } from '../src/filters.js';

const github = { provider: 'github', resource: 'bugs' };
const ado = { provider: 'ado', resource: 'prs' };
const bug = { provider: 'chromium', resource: 'bugs' };
const cl = { provider: 'chromium', resource: 'cls' };
const items = [
  {
    provider: 'github', kind: 'bug', id: '123', title: 'Fix memory leak in cache',
    state: 'open', author: 'Alice', assignees: ['Bob'], labels: ['Bug', 'Regression'],
    repository: 'owner/repo', url: 'https://example.com/issues/123', draft: false,
    createdAt: '2026-10-07T12:00:00.000Z', updatedAt: null,
  },
  {
    provider: 'github', kind: 'bug', id: '456', title: 'Improve Cache performance',
    state: 'closed', author: 'Carol', assignees: [], labels: ['Enhancement'],
    repository: 'owner/repo', url: 'https://example.com/issues/456', draft: null,
    createdAt: null, updatedAt: null,
  },
];
const matches = (filter, profile = github, rows = items) => filterItems(rows, compileFilter(filter, profile));

test('unqualified and property terms use case-insensitive literal substrings with implied AND', () => {
  for (const filter of [
    'MEMORY cache', 'title:memory state:op', 'alice cache', 'label:BUG tag:regress',
    'author:ali assigned-to:bo', 'repository:repo id:23', 'draft:fal created-at:2026',
    'url:https://example.com/issues/123',
  ]) assert.deepEqual(matches(filter), [items[0]], filter);
  assert.deepEqual(matches('kind:bu provider:git'), items);
  assert.deepEqual(matches('cache state:closed'), [items[1]]);
  assert.deepEqual(matches('memory Carol'), []);
  assert.deepEqual(matches('title:memory labels:Enhancement'), []);
  assert.deepEqual(matches('updatedAt:null'), []);
  assert.deepEqual(matches('draft:null'), []);
  assert.deepEqual(matches('labels'), []);
  assert.deepEqual(matches('cache OR memory'), [items[0]]);
  assert.deepEqual(matches('cache AND memory'), []);
  assert.deepEqual(matches('title:.*'), []);
});

test('quoted phrases and escaping preserve literal values and distinguish qualified terms', () => {
  for (const filter of [
    'title:"memory leak" cache', "'memory leak' cache", '"https://example.com/issues/123"',
    String.raw`memory\ leak cache`, String.raw`url:https\://example.com/issues/123`,
  ]) assert.deepEqual(matches(filter), [items[0]], filter);
  const row = { title: 'Say "hello" and \'bye\' at C:\\Users\\Alice; owner:alice' };
  for (const filter of [
    String.raw`title:"Say \"hello\""`, 'title:"\'bye\'"', String.raw`"C:\Users\Alice"`,
    String.raw`"C:\\Users\\Alice"`, '"owner:alice"', String.raw`owner\:alice`,
  ]) assert.deepEqual(matches(filter, github, [row]), [row], filter);
  assert.deepEqual(matches('title:"Say \\"hello\\"" author:Alice'), []);
});

test('concept aliases, case, kebab-case, underscores and provider-specific fields map consistently', () => {
  for (const filter of ['OWNER:alice', 'creator:Alice', 'created_by:ali', 'subject:memory', 'status:open', 'assignee:Bob']) {
    assert.deepEqual(matches(filter), [items[0]]);
  }
  const pr = { author: 'Alice', sourceBranch: 'feature/cache', targetBranch: 'main', reviewers: ['Bob', 'Carol'] };
  assert.deepEqual(matches('creator:ali source-branch:cache target_branch:MAIN reviewer:bob', ado, [pr]), [pr]);
  const change = { title: 'Memory leak', repository: 'chromium/src', author: 'Alice', targetBranch: 'main' };
  assert.deepEqual(matches('project:chromium/src branch:main owner:ali', cl, [change]), [change]);
  for (const [profile, filter] of [[github, 'branch:main'], [ado, 'branch:main'], [cl, 'reviewer:bob'], [github, 'priority:p2']]) {
    assert.throws(() => compileFilter(filter, profile), { code: 'INVALID_FILTER' });
  }
});

test('normalized bug fields, provider data and legacy aliases remain searchable without matching property names', () => {
  const row = { labels: ['Security', 'Regression'], priority: 'P2', severity: 'S2', type: 'Bug', providerData: { component: null } };
  for (const filter of ['priority:p2 severity:s2', 'details.priority:P2 type:bug', 'details:P2 Regression', 'P2 Security']) {
    assert.deepEqual(matches(filter, bug, [row]), [row]);
  }
  assert.deepEqual(matches('component:null', bug, [row]), []);
  assert.deepEqual(matches('priority', bug, [row]), []);
  assert.deepEqual(matches('component:x', bug, [{ labels: [] }]), []);
});

test('empty filters match all without mutating items or compiling arbitrary operators', () => {
  for (const filter of [undefined, '', ' \t\n ']) assert.equal(matches(filter), items);
  const snapshot = structuredClone(items);
  matches('cache');
  assert.deepEqual(items, snapshot);
  const composed = [{ title: 'caf\u00e9' }];
  assert.deepEqual(matches('cafe\u0301', github, composed), composed);
});

test('qualified providerData fields and bare values search only the selected provider surface', () => {
  const bugRow = { priority: 'P2', providerData: { component: 'UI>Accessibility' } };
  for (const filter of ['component:accessibility', 'details.component:ui', 'providerData.component:access',
    'providerData:ui', 'accessibility', 'details:p2']) {
    assert.deepEqual(matches(filter, bug, [bugRow]), [bugRow], filter);
  }
  assert.deepEqual(matches('component', bug, [bugRow]), []);
  const pr = { providerData: { mergeStatus: 'conflicts', reviewerVotes: [{ reviewer: 'Alice', vote: -10, required: true }] } };
  for (const filter of ['providerData.mergeStatus:conflict', 'providerData.reviewerVotes:alice',
    'provider-data:conflict', 'alice -10']) {
    assert.deepEqual(matches(filter, ado, [pr]), [pr], filter);
  }
  const change = { providerData: { changeId: 'I_example' } };
  assert.deepEqual(matches('providerData.changeId:example', cl, [change]), [change]);
  const issue = { providerData: { nodeId: 'I_node' } };
  assert.deepEqual(matches('providerData.nodeId:node', github, [issue]), [issue]);
  for (const [profile, filter] of [[github, 'providerData.mergeStatus:x'], [cl, 'providerData.component:ui'],
    [bug, 'providerData.changeId:x'], [ado, 'providerData.raw:x']]) {
    assert.throws(() => compileFilter(filter, profile), { code: 'INVALID_FILTER' });
  }
});

test('invalid filters are explicit safe errors before fetching rather than empty success', () => {
  for (const filter of [
    null, 0, {}, [], 'title:', ':value', '""', "''", 'title:"unfinished', "'unfinished",
    'value\\', 'unknown:SECRET_FILTER_VALUE', 'constructor:x', '__proto__:x',
    'bad property:value', 'title:\u0000', 'title:\u007f', 'x'.repeat(32769), Array(257).fill('x').join(' '),
  ]) {
    assert.throws(() => compileFilter(filter, github), error => {
      assert.equal(error.code, 'INVALID_FILTER', String(filter));
      assert.equal(error.message.includes('SECRET_FILTER_VALUE'), false);
      return true;
    });
  }
  for (const profile of [null, {}, { provider: 'constructor', resource: 'bugs' }, { provider: 'github', resource: 'cls' }]) {
    assert.throws(() => filterProperties(profile), { code: 'INVALID_FILTER' });
  }
});

test('property discovery is scoped and cannot mutate later filters', () => {
  const fields = filterProperties(ado);
  assert.ok(fields.some(field => field.name === 'sourceBranch'));
  assert.ok(fields.some(field => field.name === 'reviewers'));
  assert.ok(!filterProperties(github).some(field => field.name === 'sourceBranch'));
  fields[0].aliases.push('injected');
  assert.throws(() => compileFilter('injected:value', ado), { code: 'INVALID_FILTER' });
});
