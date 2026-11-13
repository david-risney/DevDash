import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateConfig, effectiveProfile, isGroupedProfile } from '../../src/config.js';
import { validateQueryResult } from '../../src/providers/contract.js';
import { compileFilter, filterItems } from '../../src/filters.js';
import { runJson } from '../../src/process.js';
import { frameMessage } from '../../src/native.js';
import { formatResults } from '../../src/format.js';
import { githubAccountOptions } from '../../src/github-auth.js';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../../bin/devdash.js', import.meta.url));
const nativeBin = fileURLToPath(new URL('../../bin/devdash-native.js', import.meta.url));
const localBins = fileURLToPath(new URL('../../node_modules/.bin/', import.meta.url));
const safeCodes = new Set([
  'CLI_NOT_FOUND', 'CLI_FAILED', 'GITHUB_SSO_REQUIRED', 'INVALID_PROVIDER_RESPONSE', 'PROVIDER_RESPONSE',
  'PROVIDER_NETWORK', 'PROVIDER_HTTP', 'BROWSER_NOT_INSTALLED', 'BROWSER_FAILED',
  'BUG_NOT_FOUND', 'BUG_ACCESS_DENIED', 'BUG_TIMEOUT', 'LOG_WRITE_FAILED',
  'INVALID_FILTER', 'FILTER_FAILED', 'FILTER_RESULT', 'FILTER_LIMIT',
]);

export class E2EError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'E2EError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new E2EError(code, message); };
function check(condition, message) {
  if (!condition) fail('E2E_CONTRACT', message);
}
export function safeFailure(error) {
  return safeCodes.has(error?.code) ? error.code : 'PROVIDER_FAILURE';
}

export function safeCliFailure(stdout, stderr) {
  for (const text of [stderr, stdout]) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) continue;
    let result;
    try { result = JSON.parse(text); } catch { continue; }
    const errors = [result?.error, ...Object.values(result?.queries ?? {}).map(query => query?.error)];
    const code = errors.map(safeFailure).find(value => value !== 'PROVIDER_FAILURE');
    if (code) return code;
  }
  return 'PROVIDER_FAILURE';
}

export async function readLiveConfig(path) {
  let text;
  try {
    if ((await stat(path)).size > 1024 * 1024) fail('E2E_CONFIG', 'Live test configuration exceeds 1 MiB.');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof E2EError) throw error;
    fail('E2E_CONFIG', 'Cannot read the local live-test configuration.');
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, ''));
    validateConfig(config);
  } catch {
    fail('E2E_CONFIG', 'Local live-test configuration is invalid. Validate it locally with devdash config validate; do not share private contents.');
  }
  const profiles = Object.values(config.profiles);
  if (!profiles.length || profiles.length > 10) fail('E2E_CONFIG', 'Live tests require 1-10 profiles.');
  let count = 0;
  for (const profile of profiles) {
    const definitions = isGroupedProfile(profile) ? Object.values(profile.queries) : [profile];
    for (const query of definitions) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 10) {
        fail('E2E_CONFIG', 'Every live query must explicitly set limit from 1 to 10 to bound read-only requests.');
      }
      count++;
    }
  }
  if (count > 20) fail('E2E_CONFIG', 'Live tests support at most 20 queries.');
  return config;
}

export async function preflight(config, { env = process.env, runProvider = runJson, runProviderText } = {}) {
  const checked = new Set();
  for (const raw of Object.values(config.profiles)) {
    const queries = isGroupedProfile(raw) ? Object.values(raw.queries) : [raw];
    for (const query of queries) {
      const key = JSON.stringify([query.provider, query.hostname, query.account, query.auth, query.organization, query.project, query.resource === 'bugs']);
      if (checked.has(key)) continue;
      checked.add(key);
      try {
        if (query.provider === 'github') {
          if (query.auth === 'anonymous') continue;
          const args = ['api', '--method', 'GET', 'user'];
          if (query.hostname || query.account) args.push('--hostname', query.hostname ?? 'github.com');
          const options = await githubAccountOptions(query, { env, runText: runProviderText }) ?? { env };
          const result = await runProvider('gh', args, options);
          check(typeof result?.login === 'string' && result.login.length > 0, 'GitHub authentication probe returned an invalid response.');
          check(query.account === undefined || result.login.toLowerCase() === query.account.toLowerCase(),
            'GitHub authentication probe did not use the selected account.');
        } else if (query.provider === 'ado') {
          await runProvider('az', ['extension', 'show', '--name', 'azure-devops', '--output', 'json'], { env });
          const result = await runProvider('az', [
            'devops', 'project', 'show', '--project', query.project, '--organization', query.organization,
            '--detect', 'false', '--output', 'json', '--only-show-errors',
          ], { env });
          check(typeof result?.id === 'string' && result.id.length > 0, 'Azure project authentication probe returned an invalid response.');
        } else {
          const version = await runProvider('cr', ['--version'], { env });
          check(version?.name === 'cr' && typeof version.version === 'string', 'Chromium CLI version probe returned an invalid response.');
          if (query.resource === 'bugs') {
            const doctor = await runProvider('cr', ['doctor'], { env });
            check(doctor?.checks?.browser?.status === 'ok', 'Chromium browser installation is required.');
          }
        }
      } catch (error) {
        fail('E2E_PREREQUISITE',
          `${query.provider} prerequisite check failed (${safeFailure(error)}). Authenticate gh/az yourself for the selected scope, or install cr and its browser for public Chromium queries.`);
      }
    }
  }
}

function decodeResult(stdout, stderr) {
  check(!stderr || stderr.length === 0, 'Successful CLI output unexpectedly included stderr.');
  try { return JSON.parse(stdout.toString('utf8')); } catch {
    fail('E2E_PROTOCOL', 'CLI did not return exactly one JSON document.');
  }
}

export async function liveCli(args, env) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [bin, ...args], {
      env, shell: false, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
    });
    return decodeResult(stdout, stderr);
  } catch (error) {
    if (error instanceof E2EError) throw error;
    const code = safeCliFailure(error.stdout, error.stderr);
    fail('E2E_CLI', `CLI operation failed (${code}); private stdout/stderr has been suppressed.`);
  }
}

export async function liveNative(request, env) {
  try {
    const execution = execute(process.execPath, [nativeBin], {
      env, shell: false, windowsHide: true, encoding: 'buffer',
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    execution.child.stdin.end(frameMessage(request));
    const { stdout, stderr } = await execution;
    check(stderr.length === 0 && stdout.length >= 4, 'Native host returned invalid framing or stderr.');
    const length = endianness() === 'LE' ? stdout.readUInt32LE() : stdout.readUInt32BE();
    check(stdout.length === length + 4, 'Native host returned an invalid frame length.');
    return decodeResult(stdout.subarray(4), stderr);
  } catch (error) {
    if (error instanceof E2EError) throw error;
    fail('E2E_NATIVE', 'Native host failed; private output has been suppressed.');
  }
}

async function assertSnapshot(result, profile, name, query) {
  check(result?.schemaVersion === 1 && result?.profile === name && result?.query === query,
    'Query snapshot identity or schema is invalid.');
  check(!result.error && result.provider === profile.provider && result.resource === profile.resource,
    'Query snapshot indicates a provider error or mismatched scope.');
  try { validateQueryResult(profile, result); } catch {
    fail('E2E_CONTRACT', 'Provider returned an invalid normalized item contract.');
  }
  try {
    for (const format of ['ansi', 'text', 'markdown']) formatResults(result, format);
  } catch {
    fail('E2E_PRESENTATION', 'A successful query snapshot cannot be rendered in every supported table format.');
  }
  check((await filterItems(result.items, compileFilter(profile.filter, profile))).length === result.items.length,
    'A returned item does not satisfy the configured local filter.');
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runLiveSuite(config, options = {}) {
  const command = options.command ?? liveCli;
  const native = options.native ?? liveNative;
  const environment = options.env ?? process.env;
  const home = await mkdtemp(join(tmpdir(), 'devdash-live-e2e-'));
  const env = {
    ...environment, DEVDASH_HOME: home, CR_HOME: join(home, 'standalone-cr'),
    PATH: [localBins, environment.PATH ?? environment.Path ?? ''].join(delimiter),
  };
  const checks = [];
  try {
    await preflight(config, { env, runProvider: options.runProvider, runProviderText: options.runProviderText });
    await command(['init', '--home', home], env);
    let index = 0;
    for (const raw of Object.values(config.profiles)) {
      // Original private profile/query names never become test names or diagnostics.
      const name = `live-${++index}`;
      const profile = structuredClone(raw);
      profile.refreshSeconds = 3600;
      if (isGroupedProfile(profile)) {
        profile.queries = Object.fromEntries(Object.values(profile.queries).map((query, offset) =>
          [`query-${offset + 1}`, { ...query, refreshSeconds: 3600 }]));
      }
      const file = join(home, `${name}.profile.json`);
      await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
      await command(['profile', 'set', name, '--file', file, '--home', home], env);
      const refreshed = await command(['refresh', name, '--home', home], env);
      check(!refreshed.error && !refreshed.failed && refreshed.fromCache === false,
        'Live refresh did not return a successful noncached result.');
      const effective = effectiveProfile(profile);
      const entries = isGroupedProfile(effective)
        ? Object.entries(effective.queries) : [[undefined, effective]];
      for (const [query, definition] of entries) {
        const snapshot = query === undefined ? refreshed : refreshed.queries?.[query];
        await assertSnapshot(snapshot, definition, name, query);
        const selector = query === undefined ? [] : ['--query', query];
        // PATH removes gh/az/cr: a cache read must work without provider executables.
        const offline = { ...env, PATH: '', Path: '' };
        const cached = await command(['get', name, ...selector, '--cached-only', '--home', home], offline);
        check(cached?.fromCache === true && equal(cached.items, snapshot.items),
          'Offline cached-only results differ from the refresh.');
        const due = await command(['refresh', name, ...selector, '--due', '--home', home], offline);
        check(due?.fromCache === true && equal(due.items, snapshot.items),
          'Due-only refresh contacted a provider or changed a fresh cache.');
        const bridge = await native({ command: 'get', profile: name, ...(query === undefined ? {} : { query }), cachedOnly: true }, offline);
        check(bridge?.fromCache === true && equal(bridge.items, snapshot.items),
          'Native messaging does not return the same cached snapshot.');
        const status = await command(['cache', 'status', name, ...selector, '--home', home], offline);
        check(status?.cached === true && status.count === snapshot.items.length, 'Cache status has incorrect item counts.');
        checks.push({ provider: definition.provider, resource: definition.resource, passed: true });
      }
      await command(['cache', 'clear', name, '--home', home], env);
      const status = await command(['cache', 'status', name, '--home', home], env);
      const cleared = isGroupedProfile(effective) ? Object.values(status.queries ?? {}) : [status];
      check(cleared.length === entries.length && cleared.every(value => value.cached === false), 'Cache clear did not remove all selected snapshots.');
      await command(['profile', 'remove', name, '--home', home], env);
    }
    return { schemaVersion: 1, checks, queries: checks.length, failed: 0 };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
