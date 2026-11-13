import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDashError } from './errors.js';
import { readJson, withLock, writeJson } from './storage.js';

export const HOST_NAME = 'com.devdash.cli';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browsers = {
  chrome: `HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
};
const invalid = message => { throw new DevDashError('INVALID_ARGUMENT', message); };
const conflict = message => { throw new DevDashError('NATIVE_REGISTRATION_CONFLICT', message); };
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  resolve(a).toLowerCase() === resolve(b).toLowerCase();
const extensionId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
const quote = value => `"${value.replaceAll('%', '%%')}"`;

// Only fixed registry locations are accepted. Caller values travel as JSON, never PowerShell source.
const registryScript = `
$ErrorActionPreference = 'Stop'
$request = $env:DEVDASH_NATIVE_REGISTRY | ConvertFrom-Json
$allowed = @('${browsers.chrome}', '${browsers.edge}')
if ($request.key -cnotin $allowed) { throw 'Unsupported native registry key.' }
switch ($request.action) {
  'get' {
    $value = if (Test-Path -LiteralPath $request.key) { (Get-Item -LiteralPath $request.key).GetValue('') } else { $null }
    ConvertTo-Json -Compress -InputObject @{ value = $value }
  }
  'set' {
    New-Item -Path $request.key -Force | Out-Null
    Set-Item -LiteralPath $request.key -Value ([string]$request.value)
    '{"ok":true}'
  }
  'remove' {
    if (Test-Path -LiteralPath $request.key) { Remove-Item -LiteralPath $request.key -Force }
    '{"ok":true}'
  }
  default { throw 'Unsupported registry action.' }
}
`;

export async function nativeRegistry(action, key, value) {
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execute('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(registryScript, 'utf16le').toString('base64'),
    ], {
      windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, DEVDASH_NATIVE_REGISTRY: JSON.stringify({ action, key, value }) },
    }));
  } catch (error) {
    throw new DevDashError('NATIVE_REGISTRATION_FAILED',
      'Windows registry operation failed. Check that PowerShell 7 (pwsh) is installed and the per-user registry key is writable.', { cause: error });
  }
  if (stderr) throw new DevDashError('NATIVE_REGISTRATION_FAILED', 'Registry operation produced unexpected diagnostic output.');
  const result = JSON.parse(stdout);
  if (action === 'get') {
    if (result.value !== null && typeof result.value !== 'string') {
      conflict('Native host registry default value is not a manifest path.');
    }
    return result.value;
  }
  if (result.ok !== true) throw new DevDashError('NATIVE_REGISTRATION_FAILED', 'Registry operation did not confirm success.');
}

async function optionalFile(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function manageNative(action, options = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new DevDashError('UNSUPPORTED_PLATFORM', 'Native host registration currently supports Windows only.');
  }
  if (!['install', 'uninstall', 'status', 'list', 'add', 'remove'].includes(action)) invalid('Unknown native administration command.');
  const browser = (options.browser ?? 'both').toLowerCase();
  if (!['chrome', 'edge', 'both'].includes(browser)) invalid('--browser must be chrome, edge, or both.');
  const selected = browser === 'both' ? Object.keys(browsers) : [browser];
  if (!options.installDirectory && !process.env.LOCALAPPDATA) invalid('LOCALAPPDATA is unavailable; specify --install-directory.');
  const directory = resolve(options.installDirectory ?? join(process.env.LOCALAPPDATA, 'DevDash', 'NativeMessaging'));
  const manifestPath = join(directory, `${HOST_NAME}.json`);
  const wrapperPath = join(directory, 'devdash-native.cmd');
  const settingsPath = join(directory, 'launcher.json');
  const registry = dependencies.registry ?? nativeRegistry;
  const id = options.extensionId;
  if (['add', 'remove'].includes(action) && !extensionId(id)) invalid('Extension ID must contain exactly 32 lowercase letters a-p.');
  const ids = options.extensionIds ?? [];
  if (!Array.isArray(ids) || ids.some(value => !extensionId(value))) invalid('Extension IDs must contain exactly 32 lowercase letters a-p.');
  const run = async () => {
    const registrations = Object.fromEntries(await Promise.all(Object.entries(browsers).map(async ([name, key]) =>
      [name, await registry('get', key)])));
    const manifest = await readJson(manifestPath);
    const wrapper = await optionalFile(wrapperPath);
    const settings = await readJson(settingsPath);
    const validManifest = manifest?.name === HOST_NAME && manifest.type === 'stdio' &&
      samePath(manifest.path, wrapperPath) && Array.isArray(manifest.allowed_origins) &&
      manifest.allowed_origins.every(value => typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(value));
    const owned = validManifest && typeof wrapper === 'string' &&
      (wrapper.startsWith('@rem DevDash native host\r\n') ||
        wrapper.includes(`${quote(join(source, 'bin', 'devdash-native.js'))} --launch-config ${quote(settingsPath)}`)) &&
      settings && typeof settings === 'object' && !Array.isArray(settings) &&
      Object.keys(settings).every(key => ['home', 'config'].includes(key)) &&
      Object.values(settings).every(value => typeof value === 'string' && value.length > 0);
    const launchPaths = wrapper?.match(/^"([^"\r\n]+)" "([^"\r\n]+)" --launch-config /m)?.slice(1);
    let launchable = Boolean(launchPaths);
    for (const path of launchPaths ?? []) {
      try { launchable &&= (await stat(path.replaceAll('%%', '%'))).isFile(); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        launchable = false;
      }
    }
    const allowed = validManifest ? [...new Set(manifest.allowed_origins.map(value => value.slice(19, -1)))].sort() : [];
    const status = () => ({
      schemaVersion: 1, name: HOST_NAME, directory, manifest: manifestPath,
      installed: Boolean(owned), extensionIds: allowed,
      browsers: Object.fromEntries(selected.map(name => [name, {
        registryKey: browsers[name], manifest: registrations[name],
        registered: samePath(registrations[name], manifestPath),
        healthy: Boolean(owned && launchable && samePath(registrations[name], manifestPath)),
      }])),
    });
    if (action === 'status' || action === 'list') return status();
    for (const name of selected) {
      if (registrations[name] !== null && !samePath(registrations[name], manifestPath)) {
        conflict(`The ${name} registration belongs to another installation. Uninstall it explicitly before replacing it.`);
      }
    }
    if ((manifest !== null || wrapper !== null || settings !== null) && !owned) {
      conflict('The native installation files are incomplete or not recognized as DevDash-owned. No files were changed.');
    }
    if (['add', 'remove'].includes(action) && !owned) {
      throw new DevDashError('NATIVE_NOT_INSTALLED', 'Run devdash native install before managing allowed extensions.');
    }
    const files = {};
    let removeFiles = [];
    const registryChanges = {};
    if (action === 'install') {
      const node = resolve(options.nodePath ?? process.execPath);
      const entry = join(source, 'bin', 'devdash-native.js');
      for (const path of [directory, node, entry, settingsPath]) {
        if (/[\u0000-\u001f"]/.test(path)) invalid('A native launcher path contains unsupported characters.');
      }
      if (!/\.exe$/i.test(node)) invalid('--node-path must identify a Node.js executable.');
      const { stdout } = await (dependencies.execute ?? execute)(node, ['--version'], { windowsHide: true, timeout: 30_000 });
      if (!/^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(stdout.trim())) invalid('Native hosting requires Node.js 22 or newer.');
      for (const relative of ['bin/devdash-native.js', 'packages/cr/package.json', 'packages/cr/bin/cr.js']) {
        if (!(await stat(join(source, ...relative.split('/')))).isFile()) {
          throw new DevDashError('SOURCE_CHECKOUT_REQUIRED', 'Native hosting requires the full DevDash source checkout.');
        }
      }
      const saved = { ...(settings ?? {}) };
      if (options.home !== undefined) saved.home = resolve(options.home);
      if (options.config !== undefined) saved.config = resolve(options.config);
      const origins = [...new Set([...allowed, ...ids])].sort();
      files[wrapperPath] = `@rem DevDash native host\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(node)} ${quote(entry)} --launch-config ${quote(settingsPath)} %*\r\nexit /b %errorlevel%\r\n`;
      files[settingsPath] = JSON.stringify(saved, null, 2) + '\n';
      files[manifestPath] = JSON.stringify({
        name: HOST_NAME, description: 'DevDash query profiles and cache', path: wrapperPath,
        type: 'stdio', allowed_origins: origins.map(value => `chrome-extension://${value}/`),
      }, null, 2) + '\n';
      for (const name of selected) registryChanges[name] = manifestPath;
    } else if (action === 'add' || action === 'remove') {
      const next = action === 'add' ? [...new Set([...allowed, id])].sort() : allowed.filter(value => value !== id);
      files[manifestPath] = JSON.stringify({
        ...manifest, allowed_origins: next.map(value => `chrome-extension://${value}/`),
      }, null, 2) + '\n';
    } else {
      for (const name of selected) if (registrations[name] !== null) registryChanges[name] = null;
      const stillUsed = Object.keys(browsers).some(name =>
        !selected.includes(name) && samePath(registrations[name], manifestPath));
      if (owned && !stillUsed) removeFiles = [manifestPath, wrapperPath, settingsPath];
    }
    const plan = {
      action, directory, manifest: manifestPath, registryKeys: selected.map(name => browsers[name]),
      files, removeFiles, registryChanges,
    };
    if (options.preview) return plan;
    if (action === 'install') {
      // Preparation must succeed before files or registry values change.
      if (dependencies.prepare) await dependencies.prepare();
      else {
        try {
          const prepared = await execute(process.execPath, [join(source, 'bin', 'devdash-native.js'), '--prepare'], {
            windowsHide: true, timeout: 20 * 60_000, maxBuffer: 1024 * 1024,
          });
          if (prepared.stderr) process.stderr.write(prepared.stderr);
        } catch (error) {
          throw new DevDashError('NATIVE_REGISTRATION_FAILED',
            'Native host dependency preparation failed; registration was not changed. Run devdash-native --prepare directly to diagnose.', { cause: error });
        }
      }
    }
    const previousFiles = new Map(await Promise.all([...new Set([...Object.keys(files), ...removeFiles])]
      .map(async path => [path, await optionalFile(path)])));
    const touched = [];
    const changed = [];
    try {
      for (const [path, contents] of Object.entries(files)) {
        touched.push(path);
        if (path === wrapperPath) await writeFile(path, contents, { mode: 0o600 });
        else await writeJson(path, JSON.parse(contents));
      }
      for (const [name, value] of Object.entries(registryChanges)) {
        const current = await registry('get', browsers[name]);
        if (current !== registrations[name]) conflict(`The ${name} registration changed during setup; retry.`);
        changed.push(name);
        await registry(value === null ? 'remove' : 'set', browsers[name], value);
      }
      for (const path of removeFiles) {
        touched.push(path);
        await rm(path, { force: true });
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const path of touched.reverse()) {
        try {
          const contents = previousFiles.get(path);
          if (contents === null) await rm(path, { force: true });
          else await writeFile(path, contents, { mode: 0o600 });
        } catch (failure) { rollbackErrors.push(failure); }
      }
      for (const name of changed.reverse()) {
        try {
          const current = await registry('get', browsers[name]);
          const expected = registryChanges[name];
          if (current !== expected && current !== registrations[name]) {
            conflict(`Cannot restore ${name}: its registration changed outside this operation.`);
          }
          await registry(registrations[name] === null ? 'remove' : 'set', browsers[name], registrations[name]);
        } catch (failure) { rollbackErrors.push(failure); }
      }
      if (rollbackErrors.length) {
        throw new DevDashError('NATIVE_REGISTRATION_FAILED', 'Native setup failed and rollback was incomplete. Inspect native status and the installation directory before retrying.',
          { cause: new AggregateError([error, ...rollbackErrors]) });
      }
      throw error;
    }
    return { schemaVersion: 1, ...plan };
  };
  if (options.preview || ['status', 'list'].includes(action)) return run();
  return withLock(manifestPath, run);
}
