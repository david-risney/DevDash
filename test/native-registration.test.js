import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageNative } from '../src/native-registration.js';
import { executeCommand } from '../src/commands.js';
import { DevDash } from '../src/service.js';

const id = 'a'.repeat(32), second = 'b'.repeat(32);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devdash-native-admin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'host space & (x) %NATIVE_UNSET% ! ^');
  const values = new Map(), writes = [];
  let failKey;
  const dependencies = {
    platform: 'win32',
    registry: async (action, key, value) => {
      if (action === 'get') return values.get(key) ?? null;
      writes.push({ action, key, value });
      if (action === 'set' && key === failKey) { failKey = undefined; throw new Error('Synthetic registry failure'); }
      if (action === 'set') values.set(key, value);
      else if (action === 'remove') values.delete(key);
      else assert.fail('Unexpected registry action');
    },
    prepare: async () => {},
    execute: async () => ({ stdout: 'v24.0.0' }),
  };
  const call = (action, options = {}) => manageNative(action, {
    installDirectory: directory, nodePath: join(root, 'node.exe'), ...options,
  }, dependencies);
  return { root, directory, values, writes, call, dependencies, failOn: key => { failKey = key; } };
}

test('native lifecycle preserves extension IDs and shared browser files; removing the last ID denies all', async t => {
  const f = await fixture(t);
  const preview = await f.call('install', { preview: true, browser: 'chrome', extensionIds: [id] });
  assert.equal(f.writes.length, 0);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  const installed = await f.call('install', { browser: 'chrome', extensionIds: [id] });
  assert.equal(f.values.size, 1);
  assert.equal(JSON.parse(await readFile(installed.manifest)).allowed_origins[0], `chrome-extension://${id}/`);
  await f.call('install', { browser: 'edge', extensionIds: [second] });
  assert.equal(f.values.size, 2);
  await Promise.all([f.call('add', { extensionId: id }), f.call('add', { extensionId: second })]);
  assert.deepEqual((await f.call('list')).extensionIds, [id, second]);
  await f.call('remove', { extensionId: id });
  assert.deepEqual((await f.call('list')).extensionIds, [second]);
  await f.call('remove', { extensionId: second });
  assert.deepEqual((await f.call('list')).extensionIds, []);
  await f.call('uninstall', { browser: 'chrome' });
  assert.equal(f.values.size, 1);
  assert.ok((await stat(installed.manifest)).isFile());
  await f.call('uninstall', { browser: 'edge' });
  assert.equal(f.values.size, 0);
  for (const path of preview.removeFiles.concat(Object.keys(preview.files))) {
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  assert.equal((await f.call('status')).installed, false);
  await f.call('uninstall');
});

test('registration rejects foreign registry/file ownership without changing either browser or any files', async t => {
  const f = await fixture(t);
  const plan = await f.call('install', { preview: true });
  f.values.set(plan.registryKeys[1], join(f.root, 'another-installation.json'));
  await assert.rejects(f.call('install'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(f.writes.length, 0);
  f.values.clear();
  await f.call('install');
  const before = await readFile(plan.manifest, 'utf8');
  f.values.set(plan.registryKeys[1], join(f.root, 'another-installation.json'));
  await assert.rejects(f.call('uninstall'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  await assert.rejects(f.call('add', { extensionId: id }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(await readFile(plan.manifest, 'utf8'), before);
  f.values.clear();
  await writeFile(join(f.directory, 'devdash-native.cmd'), 'not owned by DevDash');
  await assert.rejects(f.call('install'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  await assert.rejects(f.call('uninstall'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(await readFile(join(f.directory, 'devdash-native.cmd'), 'utf8'), 'not owned by DevDash');
});

test('registry failure rolls back files and previously changed registrations, preserving existing installs', async t => {
  const f = await fixture(t);
  const plan = await f.call('install', { preview: true });
  f.failOn(plan.registryKeys[1]);
  await assert.rejects(f.call('install'), /Synthetic registry failure/);
  assert.equal(f.values.size, 0);
  await assert.rejects(stat(plan.manifest), { code: 'ENOENT' });
  await f.call('install', { browser: 'chrome', extensionIds: [id] });
  const before = await readFile(plan.manifest, 'utf8');
  f.failOn(plan.registryKeys[1]);
  await assert.rejects(f.call('install', { extensionIds: [second] }), /Synthetic registry failure/);
  assert.equal(await readFile(plan.manifest, 'utf8'), before);
  assert.equal(f.values.size, 1);
});

test('preparation failure makes no installation changes and preview never prepares dependencies', async t => {
  const f = await fixture(t);
  f.dependencies.prepare = async () => { throw new Error('Synthetic preparation failure'); };
  await f.call('install', { preview: true });
  await assert.rejects(f.call('install'), /Synthetic preparation failure/);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.call('list')).installed, false);
});

test('reinstall preserves trusted launcher settings and legacy installations can be managed without losing their allowlist', async t => {
  const f = await fixture(t);
  const home = join(f.root, 'custom home'), config = join(f.root, 'custom config.json');
  await f.call('install', { extensionIds: [id], home, config });
  const wrapper = join(f.directory, 'devdash-native.cmd');
  await writeFile(wrapper, (await readFile(wrapper, 'utf8')).replace('@rem DevDash native host\r\n', ''));
  await f.call('install', { extensionIds: [second] });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'launcher.json'), 'utf8')), { home, config });
  assert.deepEqual((await f.call('list')).extensionIds, [id, second]);
});

test('incomplete rollback is explicit rather than returning success or hiding recovery errors', async t => {
  const f = await fixture(t);
  const plan = await f.call('install', { preview: true });
  const registry = f.dependencies.registry;
  f.dependencies.registry = async (action, key, value) => {
    if (action === 'set' && key === plan.registryKeys[1]) throw new Error('Synthetic setup failure');
    if (action === 'remove' && key === plan.registryKeys[0]) throw new Error('Synthetic rollback failure');
    return registry(action, key, value);
  };
  await assert.rejects(f.call('install'), error =>
    error.code === 'NATIVE_REGISTRATION_FAILED' && error.message.includes('rollback was incomplete'));
  await assert.rejects(stat(plan.manifest), { code: 'ENOENT' });
});

test('native status is read-only and reports missing launchers instead of claiming healthy registration', async t => {
  const f = await fixture(t);
  await f.call('status');
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  await f.call('install', { extensionIds: [id] });
  const status = await f.call('status');
  assert.equal(status.installed, true);
  assert.ok(Object.values(status.browsers).every(browser => browser.registered && !browser.healthy));
});

test('native administration validates IDs and platform before performing registry operations', async t => {
  const f = await fixture(t);
  for (const extensionId of ['*', '', 'A'.repeat(32), 'q'.repeat(32), null]) {
    await assert.rejects(f.call('add', { extensionId }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(f.call('install', { extensionIds: [extensionId] }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(f.call('add', { extensionId: id }), { code: 'NATIVE_NOT_INSTALLED' });
  await assert.rejects(f.call('install', { browser: 'firefox' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(manageNative('install', {}, { platform: 'linux' }), { code: 'UNSUPPORTED_PLATFORM' });
  assert.equal(f.writes.length, 0);
});

test('CLI forwards administration arguments and read-only previews do not create diagnostic files', async t => {
  const f = await fixture(t);
  const home = join(f.root, 'data');
  const service = new DevDash({ home });
  const calls = [];
  const dependencies = { service, manageNative: async (action, options) => {
    calls.push({ action, options });
    return { schemaVersion: 1 };
  } };
  await executeCommand(['native', 'install', '--browser', 'edge', '--extension-id', `${id},${second}`,
    '--install-directory', f.directory, '--preview'], dependencies);
  await executeCommand(['native', 'extensions', 'list'], dependencies);
  await executeCommand(['native', 'status'], dependencies);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  await executeCommand(['native', 'extensions', 'add', id], dependencies);
  await executeCommand(['native', 'extensions', 'remove', id], dependencies);
  assert.deepEqual(calls.map(call => call.action), ['install', 'list', 'status', 'add', 'remove']);
  assert.deepEqual(calls[0].options.extensionIds, [id, second]);
  assert.equal(calls[3].options.extensionId, id);
  for (const args of [
    ['native', 'extensions', 'add'], ['native', 'extensions', 'clear'], ['native', 'status', '--extension-id', id],
    ['native', 'install', '--all'], ['native', 'run'],
  ]) await assert.rejects(executeCommand(args, dependencies), { code: 'INVALID_ARGUMENT' });
});
