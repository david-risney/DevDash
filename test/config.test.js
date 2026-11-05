import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig, validateName, paths } from '../src/config.js';

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
