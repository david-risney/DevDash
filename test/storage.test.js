import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson } from '../src/storage.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devdash atomic '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await writeJson(path, { sequence: 0 });
  return { root, path };
}

test('Windows sharing violations retry atomic replacement without removing or changing the old target', async t => {
  const { root, path } = await fixture(t);
  const failures = ['EPERM', 'EACCES', 'EBUSY'];
  let attempts = 0;
  await writeJson(path, { sequence: 1 }, {
    platform: 'win32',
    replace: async (source, target) => {
      assert.deepEqual(await readJson(target), { sequence: 0 });
      const code = failures[attempts++];
      if (code) throw Object.assign(new Error('Synthetic sharing violation'), { code });
      await rename(source, target);
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(await readJson(path), { sequence: 1 });
  assert.deepEqual(await readdir(root), ['state.json']);
});

test('persistent sharing failures are bounded and nonretryable errors fail without losing the previous snapshot', async t => {
  const { root, path } = await fixture(t);
  const original = await readFile(path, 'utf8');
  for (const [platform, code, expectedAttempts] of [
    ['win32', 'EPERM', 21], ['win32', 'EIO', 1], ['linux', 'EPERM', 1],
  ]) {
    let attempts = 0;
    await assert.rejects(writeJson(path, { sequence: 1 }, {
      platform, replace: async () => {
        attempts++;
        throw Object.assign(new Error('Synthetic replacement failure'), { code });
      },
    }), { code });
    assert.equal(attempts, expectedAttempts);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(root), ['state.json']);
  }
});

test('atomic replacement tolerates a concurrent reader until it closes without exposing partial snapshots', async t => {
  const { root, path } = await fixture(t);
  for (let sequence = 1; sequence <= 5; sequence++) {
    const reader = await open(path, 'r');
    assert.deepEqual(JSON.parse(await reader.readFile('utf8')), { sequence: sequence - 1 });
    const closing = (async () => {
      await delay(100);
      await reader.close();
    })();
    try {
      await writeJson(path, { sequence });
    } finally {
      await closing;
    }
    assert.deepEqual(await readJson(path), { sequence });
  }
  assert.deepEqual(await readdir(root), ['state.json']);
});
