import test from 'node:test';
import assert from 'node:assert/strict';
import { queryGerrit } from '../src/gerrit.js';
import { CrError } from '../src/errors.js';

const profile = { query: 'status:open' };
const cl = number => ({
  _number: number, subject: `Change ${number}`, status: 'NEW', project: 'chromium/src',
  created: '2026-10-06 19:00:00.123456789', updated: '2026-10-06 20:00:00.000000000',
  owner: { email: 'owner@example.com', name: 'Owner' }, hashtags: ['tag'], work_in_progress: true,
});
const http = (value, prefix = ")]}'\n") => ({
  ok: true, status: 200, text: async () => prefix + JSON.stringify(value),
});
const normalizedKeys = ['provider', 'kind', 'id', 'title', 'state', 'url', 'repository',
  'author', 'assignees', 'labels', 'createdAt', 'updatedAt', 'draft', 'providerData'];

test('Gerrit strips XSSI, normalizes nanosecond UTC timestamps and web URLs', async () => {
  const calls = [];
  const result = await queryGerrit({ ...profile, project: 'chromium/src' }, {
    fetch: async (url, options) => { calls.push({ url, options }); return http([cl(1)]); },
  });
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.items[0]), normalizedKeys);
  assert.equal(result.items[0].url, 'https://chromium-review.googlesource.com/c/chromium/src/+/1');
  assert.equal(result.items[0].author, 'owner@example.com');
  assert.equal(result.items[0].createdAt, '2026-10-06T19:00:00.123Z');
  assert.equal(result.items[0].updatedAt, '2026-10-06T20:00:00.000Z');
  assert.equal(result.items[0].draft, true);
  assert.deepEqual(result.items[0].labels, ['tag']);
  assert.equal(calls[0].url.searchParams.get('q'), 'status:open project:"chromium/src"');
  assert.equal(calls[0].url.searchParams.get('o'), 'DETAILED_ACCOUNTS');
  assert.equal(calls[0].url.searchParams.get('S'), '0');
  assert.equal(calls[0].url.searchParams.get('n'), '100');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('Gerrit follows _more_changes even on short server-limited pages', async () => {
  const responses = [[{ ...cl(1), _more_changes: true }], [cl(2)]], offsets = [];
  const result = await queryGerrit({ ...profile, host: 'https://review.example.com/' }, {
    fetch: async url => { offsets.push(url.searchParams.get('S')); return http(responses.shift(), ''); },
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(offsets, ['0', '1']);
  assert.equal(result.items[0].url, 'https://review.example.com/c/chromium/src/+/1');
});

test('Gerrit providerData curates the stable change ID without exposing raw metadata', async () => {
  const result = await queryGerrit(profile, {
    fetch: async () => http([{ ...cl(1), change_id: 'I1234', messages: ['PRIVATE_MESSAGE'], token: 'PRIVATE_TOKEN' }]),
  });
  assert.deepEqual(result.items[0].providerData, { changeId: 'I1234' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|change_id|messages|token/);
  for (const change_id of ['', ' ', {}, 1]) {
    await assert.rejects(queryGerrit(profile, { fetch: async () => http([{ ...cl(1), change_id }]) }),
      { code: 'PROVIDER_RESPONSE' });
  }
});

test('Gerrit exact limit uses _more_changes for truthful truncation', async () => {
  for (const more of [true, false]) {
    const result = await queryGerrit({ ...profile, limit: 1 }, {
      fetch: async () => http([{ ...cl(1), _more_changes: more }]),
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, more);
  }
});

test('Gerrit empty query result is complete', async () => {
  assert.deepEqual(await queryGerrit(profile, { fetch: async () => http([]) }),
    { items: [], truncated: false });
});

test('Gerrit destination branches use the normalized targetBranch concept', async () => {
  for (const [branch, expected] of [['main', 'main'], ['refs/heads/branch/path', 'branch/path'], [null, null]]) {
    const result = await queryGerrit(profile, { fetch: async () => http([{ ...cl(1), branch }]) });
    assert.equal(result.items[0].targetBranch, expected);
    assert.equal(Object.hasOwn(result.items[0], 'sourceBranch'), false);
  }
  for (const branch of ['', ' ', 'refs/heads/', 1, {}]) {
    await assert.rejects(queryGerrit(profile, { fetch: async () => http([{ ...cl(1), branch }]) }),
      { code: 'PROVIDER_RESPONSE' });
  }
});

test('Optional absent metadata stays null or empty and dates convert offsets to UTC', async () => {
  const result = await queryGerrit(profile, {
    fetch: async () => http([{
      _number: 1, subject: 'Bare change', status: 'MERGED', project: 'chromium/src',
      created: '2026-10-06 19:00:00', assignee: { _account_id: 123 },
    }]),
  });
  assert.equal(result.items[0].createdAt, '2026-10-06T19:00:00.000Z');
  assert.equal(result.items[0].updatedAt, null);
  assert.equal(result.items[0].author, null);
  assert.equal(result.items[0].draft, false);
  assert.deepEqual(result.items[0].labels, []);
  assert.deepEqual(result.items[0].assignees, ['123']);
});

test('Gerrit pagination rejects repeats rather than looping', async () => {
  await assert.rejects(queryGerrit(profile, { fetch: async () => http([{ ...cl(1), _more_changes: true }]) }),
    { code: 'PROVIDER_RESPONSE' });
});

test('Gerrit bounds pagination when a server forces tiny pages', async () => {
  let requests = 0;
  const result = await queryGerrit({ ...profile, limit: 20000 }, {
    fetch: async () => http([{ ...cl(++requests), _more_changes: true }]),
  });
  assert.equal(requests, 200);
  assert.equal(result.items.length, 200);
  assert.equal(result.truncated, true);
});

test('Gerrit HTTP, malformed JSON, invalid shapes and network errors are explicit', async () => {
  const cases = [
    [async () => ({ ok: false, status: 403, text: async () => '' }), 'PROVIDER_HTTP'],
    [async () => ({ ok: true, text: async () => 'not JSON' }), 'PROVIDER_RESPONSE'],
    [async () => null, 'PROVIDER_RESPONSE'],
    [async () => http({ changes: [] }), 'PROVIDER_RESPONSE'],
    [async () => http([{ ...cl(1), _more_changes: 'true' }]), 'PROVIDER_RESPONSE'],
    [async () => http([{ ...cl(1), created: 'not a date' }]), 'PROVIDER_RESPONSE'],
    [async () => { throw new Error('PRIVATE connection refused'); }, 'PROVIDER_NETWORK'],
    [async () => { throw new DOMException('PRIVATE timed out', 'TimeoutError'); }, 'PROVIDER_NETWORK'],
    [async () => http(Array.from({ length: 101 }, (_, n) => cl(n + 1))), 'PROVIDER_RESPONSE'],
    [async () => http([{ ...cl(1), hashtags: {} }]), 'PROVIDER_RESPONSE'],
    [async () => http([{ ...cl(1), work_in_progress: 'false' }]), 'PROVIDER_RESPONSE'],
    [async () => http([{ ...cl(1), _number: 0 }]), 'PROVIDER_RESPONSE'],
  ];
  for (const [fetch, code] of cases) {
    await assert.rejects(queryGerrit(profile, { fetch }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
  }
});

test('Gerrit validates limits, query controls and HTTPS origins before network', async () => {
  for (const options of [
    { query: '' }, { query: 'PRIVATE\nquery' }, { host: 'http://review.example.com' },
    { host: 'https://user:password@review.example.com' }, { host: 'https://review.example.com/path' },
    { host: 'https://review.example.com/?secret=token' }, { host: 'https://review.example.com/#secret' },
    { host: 'https://review.example.com\n' }, { host: ' https://review.example.com' },
    { host: 'https:\\review.example.com' }, { project: ' \t ' },
    ...[0, -1, 20001, 1.5, '100'].map(limit => ({ limit })),
  ]) {
    await assert.rejects(queryGerrit({ ...profile, ...options }, {
      fetch: async () => assert.fail('Unexpected request'),
    }), { code: 'INVALID_ARGUMENT' });
  }
});

test('Gerrit project scope rejects conflicting queries and unscoped results', async () => {
  for (const query of ['project:other', 'project:"other"', '-project:chromium/src']) {
    await assert.rejects(queryGerrit({ query, project: 'chromium/src' }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(queryGerrit({ ...profile, project: 'other' }, {
    fetch: async () => http([cl(1)]),
  }), { code: 'PROVIDER_RESPONSE' });
});

test('canonical URLs encode project segments and offsets normalize to UTC', async () => {
  const result = await queryGerrit(profile, {
    fetch: async () => http([{ ...cl(1), project: 'some project/path#', updated: '2026-10-06T13:00:00-07:00' }]),
  });
  assert.equal(result.items[0].url, 'https://chromium-review.googlesource.com/c/some%20project/path%23/+/1');
  assert.equal(result.items[0].updatedAt, '2026-10-06T20:00:00.000Z');
});

test('log write failures are not misclassified as provider network failures', async () => {
  for (const event of ['http.start', 'http.response', 'http.failed', 'gerrit.page']) {
    const failure = new CrError('LOG_WRITE_FAILED', 'Diagnostic write failed.');
    await assert.rejects(queryGerrit(profile, {
      fetch: async () => event === 'http.failed' ? Promise.reject(new Error('private')) : http([cl(1)]),
      log: async value => { if (value === event) throw failure; },
    }), error => error === failure);
  }
});
