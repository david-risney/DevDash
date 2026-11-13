#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertCheckout(source) {
  for (const relative of ['package.json', join('packages', 'cr', 'package.json'), join('packages', 'cr', 'bin', 'cr.js')]) {
    if (!existsSync(join(source, relative))) {
      throw Object.assign(new Error(
        `Native hosting requires the full DevDash source checkout; missing ${relative}. The published npm package does not include the Chromium workspace. Run scripts\\install-native-host.ps1 from a source checkout.`,
      ), { code: 'SOURCE_CHECKOUT_REQUIRED' });
    }
  }
}

export function missingDependencies(source = root) {
  assertCheckout(source);
  for (const manifest of [join(source, 'package.json'), join(source, 'packages', 'cr', 'package.json')]) {
    const require = createRequire(manifest);
    for (const name of Object.keys(require(manifest).dependencies ?? {})) {
      try { require.resolve(name); } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return true;
      }
    }
  }
  return !existsSync(join(source, 'node_modules', '.bin', process.platform === 'win32' ? 'cr.cmd' : 'cr'));
}

export function prepareDependencies({ source = root, missing = missingDependencies, run = spawnSync } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('DevDash requires Node.js 22 or newer.');
  assertCheckout(source);
  if (!missing(source)) return;
  const lockPath = join(source, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error('Missing package-lock.json; locked native-host bootstrap requires the full source checkout, not an installed npm package.');
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!workspaces?.includes('packages/cr') || !lock.packages?.['packages/cr']) {
    throw new Error('Native-host bootstrap requires package.json and package-lock.json containing the packages/cr workspace; use the full source checkout.');
  }
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  const npm = candidates.find(candidate => existsSync(candidate));
  if (!npm) throw new Error('npm-cli.js was not found beside Node.js or on PATH; install npm and retry.');
  process.stderr.write('DevDash: missing dependencies; running npm ci --no-audit --no-fund.\n');
  const result = run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], {
    cwd: source, stdio: ['ignore', 2, 2], windowsHide: true, shell: false,
  });
  if (result.error) throw new Error(`npm ci could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ci failed with exit code ${result.status ?? 'unknown'}; native host was not started.`);
  if (missing(source)) throw new Error('npm ci completed but required dependencies or the local cr launcher are still missing.');
}

export function launcherOptions(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (/^chrome-extension:\/\/[a-p]{32}\/$/.test(argument) || /^--parent-window=\d+$/.test(argument)) continue;
    if (!['--home', '--config', '--launch-config'].includes(argument) || seen.has(argument)) {
      throw new Error(`Unsupported native launcher argument: ${argument}`);
    }
    seen.add(argument);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
    if (argument === '--launch-config') {
      const saved = JSON.parse(readFileSync(value, 'utf8').replace(/^\uFEFF/, ''));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)
          || Object.keys(saved).some(key => !['home', 'config'].includes(key))
          || Object.values(saved).some(path => typeof path !== 'string' || !path)) {
        throw new Error('Invalid native launcher configuration.');
      }
      Object.assign(options, saved);
    } else {
      options[argument.slice(2)] = value;
    }
  }
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--prepare') {
    prepareDependencies();
    return;
  }
  const options = launcherOptions(args);
  prepareDependencies();
  process.env.PATH = join(root, 'node_modules', '.bin') + delimiter + (process.env.PATH ?? '');
  const [{ DevDash }, { serveNative }] = await Promise.all([import('../src/service.js'), import('../src/native.js')]);
  const service = new DevDash(options);
  await service.diagnostics.run('native.host', {}, () => serveNative(process.stdin, process.stdout, { service }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'NATIVE_LAUNCH_FAILED', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}
