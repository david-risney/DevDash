import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNpm, launcherOptions, missingDependencies, prepareDependencies } from '../bin/devdash-native.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const installer = join(root, 'scripts', 'install-native-host.ps1');
const windows = process.platform === 'win32';
const id = 'a'.repeat(32);

async function fixture(t) {
  // Keep isolated test data in the checkout, never the user's home or registry.
  const directory = await mkdtemp(join(root, '.native-installer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function preview(parameters) {
  return execute('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$parameters = $env:DEVDASH_INSTALL_TEST_PARAMS | ConvertFrom-Json -AsHashtable; & $env:DEVDASH_INSTALL_TEST_SCRIPT @parameters'], {
    env: { ...process.env, DEVDASH_INSTALL_TEST_PARAMS: JSON.stringify({ ...parameters, Preview: true }), DEVDASH_INSTALL_TEST_SCRIPT: installer },
    windowsHide: true,
  });
}

test('Windows preview produces exact origins, absolute launcher and browser-specific HKCU plan without writes', { skip: !windows }, async t => {
  const directory = await fixture(t);
  const destination = join(directory, 'host space & (x) %NATIVE_UNSET% ! ^');
  const parameters = {
    ExtensionId: [id, 'p'.repeat(32), id], Browser: 'Both', NodePath: process.execPath,
    InstallDirectory: destination, Home: join(directory, 'home & % !'), Config: join(directory, 'custom config.json'),
  };
  const first = await preview(parameters);
  const second = await preview(parameters);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  const plan = JSON.parse(first.stdout);
  assert.equal(plan.action, 'install');
  assert.deepEqual(plan.removeFiles, []);
  assert.equal(plan.registryKeys.length, 2);
  assert.ok(plan.registryKeys.every(key => key.startsWith('HKCU:\\Software\\')));
  const manifest = JSON.parse(plan.files[plan.manifest]);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`, `chrome-extension://${'p'.repeat(32)}/`]);
  assert.equal(manifest.path, join(destination, 'devdash-native.cmd'));
  assert.equal(manifest.type, 'stdio');
  assert.match(plan.files[manifest.path], /DisableDelayedExpansion/);
  assert.match(plan.files[manifest.path], /%%NATIVE_UNSET%%/);
  assert.ok(plan.files[manifest.path].includes(`"${process.execPath}"`));
  assert.deepEqual(JSON.parse(plan.files[join(destination, 'launcher.json')]), { home: parameters.Home, config: parameters.Config });
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  for (const browser of ['Chrome', 'Edge']) {
    const selected = JSON.parse((await preview({ ...parameters, Browser: browser })).stdout);
    assert.equal(selected.registryKeys.length, 1);
    assert.ok(selected.registryKeys[0].includes(`\\${browser}\\`));
  }
  const singular = JSON.parse((await preview({ ...parameters, ExtensionId: id })).stdout);
  assert.deepEqual(JSON.parse(singular.files[singular.manifest]).allowed_origins, [`chrome-extension://${id}/`]);
});

test('Windows uninstall preview does not validate launcher Node or require extension IDs and never removes files', { skip: !windows }, async t => {
  const directory = await fixture(t);
  const install = JSON.parse((await preview({ ExtensionId: id, InstallDirectory: directory })).stdout);
  for (const [file, contents] of Object.entries(install.files)) await writeFile(file, contents);
  const marker = join(directory, 'devdash-native.cmd');
  const before = await readFile(marker, 'utf8');
  const plan = JSON.parse((await preview({ Uninstall: true, Browser: 'Edge', InstallDirectory: directory, NodePath: 'not-a-node.exe' })).stdout);
  assert.equal(plan.action, 'uninstall');
  assert.deepEqual(plan.files, {});
  assert.equal(plan.removeFiles.length, 3);
  assert.match(plan.registryKeys[0], /Microsoft\\Edge/);
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('Windows preview rejects wildcard, uppercase and malformed extension IDs before writing', { skip: !windows }, async t => {
  const directory = await fixture(t);
  const destination = join(directory, 'untouched');
  for (const ExtensionId of [['*'], ['A'.repeat(32)], ['q'.repeat(32)], [id, '../bad']]) {
    await assert.rejects(preview({ ExtensionId, InstallDirectory: destination }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /extension.?id|extension ID/i);
      return true;
    });
  }
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('launcher accepts only trusted configuration flags and browser-supplied metadata', async t => {
  const directory = await fixture(t);
  const config = join(directory, 'launcher.json');
  await writeFile(config, JSON.stringify({ home: directory, config: join(directory, 'custom.json') }));
  assert.deepEqual(launcherOptions(['--launch-config', config, `chrome-extension://${id}/`, '--parent-window=0']),
    { home: directory, config: join(directory, 'custom.json') });
  assert.deepEqual(launcherOptions(['--home', directory, '--config', config]), { home: directory, config });
  for (const args of [['--home'], ['--home', directory, '--home', directory], ['--command', 'get'], ['chrome-extension://*/']]) {
    assert.throws(() => launcherOptions(args));
  }
  await writeFile(config, '{"home":123}');
  assert.throws(() => launcherOptions(['--launch-config', config]), /Invalid native launcher configuration/);
});

test('npm discovery supports Windows, POSIX prefix and explicit npm runner layouts without a shell', async t => {
  const directory = await fixture(t);
  const executable = join(directory, 'bin', windows ? 'node.exe' : 'node');
  for (const npm of [
    join(directory, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, 'runner', 'npm-cli.js'),
  ]) {
    await mkdir(join(npm, '..'), { recursive: true });
    await writeFile(npm, '');
    const env = { PATH: join(directory, 'tools'), npm_execpath: npm === join(directory, 'runner', 'npm-cli.js') ? npm : undefined };
    assert.equal(findNpm({ executable, env }), npm);
    await rm(npm);
  }
  assert.throws(() => findNpm({ executable, env: { PATH: '', npm_execpath: join(directory, 'yarn.js') } }), /npm-cli.js was not found/);
});

test('dependency bootstrap skips installed dependencies and hides npm with stderr-only logs', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'packages', 'cr', 'bin'), { recursive: true });
  await writeFile(join(directory, 'packages', 'cr', 'bin', 'cr.js'), '');
  await writeFile(join(directory, 'packages', 'cr', 'package.json'), '{"dependencies":{}}');
  await writeFile(join(directory, 'package.json'), '{"workspaces":["packages/cr"]}');
  await writeFile(join(directory, 'package-lock.json'), '{"packages":{"packages/cr":{}}}');
  let calls = 0;
  prepareDependencies({ source: directory, missing: () => false, run: () => { throw new Error('npm must not run'); } });
  let probes = 0;
  prepareDependencies({
    source: directory, missing: () => ++probes === 1,
    run: (executable, args, options) => {
      calls++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args.slice(1), ['ci', '--no-audit', '--no-fund']);
      assert.equal(options.cwd, directory);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 2, 2]);
      return { status: 0 };
    },
  });
  assert.equal(calls, 1);
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true, run: () => ({ status: 7 }) }), /npm ci failed with exit code 7/);
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true, run: () => ({ error: new Error('fake start failure') }) }), /could not start: fake start failure/);
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true, run: () => ({ status: 0 }) }), /still missing/);
  await rm(join(directory, 'package-lock.json'));
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true }), /Missing package-lock/);
});

test('published-package layouts and non-workspace locks never attempt npm ci', async t => {
  const directory = await fixture(t);
  const neverRun = () => { throw new Error('npm must not run for an installed package or incomplete checkout'); };
  await writeFile(join(directory, 'package.json'), '{"workspaces":["packages/cr"]}');
  for (const missing of [() => true, () => false]) {
    assert.throws(() => prepareDependencies({ source: directory, missing, run: neverRun }), { code: 'SOURCE_CHECKOUT_REQUIRED' });
  }
  assert.throws(() => missingDependencies(directory), /full DevDash source checkout/);
  await mkdir(join(directory, 'packages', 'cr', 'bin'), { recursive: true });
  await writeFile(join(directory, 'packages', 'cr', 'package.json'), '{"dependencies":{}}');
  await writeFile(join(directory, 'packages', 'cr', 'bin', 'cr.js'), '');
  await writeFile(join(directory, 'package-lock.json'), '{"packages":{}}');
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true, run: neverRun }), /lock.json containing the packages\/cr workspace/);
  await writeFile(join(directory, 'package-lock.json'), '{"packages":{"packages/cr":{}}}');
  await writeFile(join(directory, 'package.json'), '{"workspaces":[]}');
  assert.throws(() => prepareDependencies({ source: directory, missing: () => true, run: neverRun }), /packages\/cr workspace/);
});

test('generated Windows wrapper roundtrips native framing with metacharacter paths and explicit home/config', { skip: !windows }, async t => {
  assert.equal(missingDependencies(), false, 'Install checkout dependencies before running integration coverage; this test never runs npm.');
  const directory = await fixture(t);
  const destination = join(directory, 'host space & (x) %NATIVE_UNSET% ! ^');
  const home = join(directory, 'home space & %NATIVE_UNSET% !');
  const config = join(directory, 'config space & %.json');
  await writeFile(config, JSON.stringify({ version: 1, profiles: {} }));
  const plan = JSON.parse((await preview({
    ExtensionId: [id], InstallDirectory: destination, NodePath: process.execPath, Home: home, Config: config,
  })).stdout);
  // Materialize only preview files. Never execute installation or access registry.
  await mkdir(destination, { recursive: true });
  for (const [file, contents] of Object.entries(plan.files)) await writeFile(file, contents);
  const wrapper = JSON.parse(plan.files[plan.manifest]).path;
  const request = Buffer.from(JSON.stringify({ command: 'profiles' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(request.length);
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""%DEVDASH_TEST_WRAPPER%" chrome-extension://${id}/ --parent-window=0"`], {
      windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, DEVDASH_TEST_WRAPPER: wrapper, DEVDASH_HOME: join(directory, 'wrong home'), NATIVE_UNSET: 'must not expand' },
    });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stderr, output: Buffer.concat(chunks) }));
    child.stdin.end(Buffer.concat([header, request]));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.output.readUInt32LE(), result.output.length - 4, 'stdout contains exactly one native frame');
  assert.deepEqual(JSON.parse(result.output.subarray(4)), { schemaVersion: 1, profiles: [] });
  assert.ok((await stat(join(home, 'logs'))).isDirectory());
});
