import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DevDash } from './service.js';
import { DevDashError } from './errors.js';
import { configurationLayers, validateConfig, validateName } from './config.js';
import { readJson, withLock, writeJson } from './storage.js';
import { defaultConfig, isRemoteProfile, matchRemoteProfile, normalizeRemote } from './profile-templates.js';

const execute = promisify(execFile);
const gitText = async args => (await execute('git', args, {
  encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
})).stdout;

function gitFailure(error) {
  throw new DevDashError(error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'GIT_FAILED',
    error.code === 'ENOENT' ? 'git not found; install it and ensure it is on PATH.'
      : 'Could not inspect the Git repository. Check the directory and Git safe-directory settings.');
}

export async function inspectRepository(directory = process.cwd(), { git = gitText } = {}) {
  const location = resolve(directory);
  let root;
  try { root = (await git(['-C', location, 'rev-parse', '--show-toplevel'])).trim(); } catch (error) {
    if (error.code === 128 && /not a git repository/i.test(error.stderr ?? '')) {
      return { matched: false, reason: 'not-a-repository' };
    }
    gitFailure(error);
  }
  if (!root) throw new DevDashError('GIT_FAILED', 'Git did not return a repository root.');
  root = resolve(root);
  let origin;
  try { origin = (await git(['-C', root, 'config', '--get', 'remote.origin.url'])).trim(); } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) {
      return { matched: false, reason: 'no-origin', repository: { root } };
    }
    gitFailure(error);
  }
  const remote = normalizeRemote(origin);
  return remote ? { repository: { root, remote } }
    : { matched: false, reason: 'unsupported-origin', repository: { root } };
}

export async function repositoryConfiguration(service, { required = false } = {}) {
  const current = await service.config({ required });
  const defaults = defaultConfig();
  return Object.defineProperty({ ...defaults, ...current, profiles: { ...defaults.profiles, ...current?.profiles } },
    configurationLayers, { value: [defaults, ...(current?.[configurationLayers] ?? [])] });
}

export function resolveRepositoryProfile(config, remote, selected) {
  if (selected !== undefined) {
    validateName(selected);
    if (!Object.hasOwn(config.profiles, selected)) {
      throw new DevDashError('PROFILE_NOT_FOUND', `No profile named "${selected}".`);
    }
    if (!isRemoteProfile(config.profiles[selected])) {
      throw new DevDashError('INVALID_ARGUMENT', '--profile must select a profile advertising remoteUrls.');
    }
  }
  const matches = [];
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!isRemoteProfile(profile) || (selected !== undefined && name !== selected)) continue;
    const match = matchRemoteProfile(profile, remote);
    if (match) matches.push({ profile: name, ...match });
  }
  const builtins = defaultConfig().profiles;
  const custom = matches.filter(match => !Object.hasOwn(builtins, match.profile));
  const candidates = custom.length ? custom : matches;
  if (candidates.length > 1) {
    throw new DevDashError('AMBIGUOUS_REMOTE_PROFILE',
      `Multiple profiles match this origin: ${candidates.map(match => match.profile).join(', ')}. Select one with --profile.`);
  }
  const match = candidates[0];
  if (!match) return null;
  validateConfig({ version: 1, profiles: { [match.profile]: match.definition } });
  return match;
}

export async function repositoryDashboard(service, options = {}, dependencies = {}) {
  let context;
  if (options.origin !== undefined) {
    const remote = normalizeRemote(options.origin);
    if (!remote) {
      throw new DevDashError('INVALID_ARGUMENT', '--origin must be an HTTPS, SSH, or git repository URL.');
    }
    context = { repository: { remote } };
  } else {
    context = await inspectRepository(options.directory, dependencies);
  }
  if (context.matched === false) return { schemaVersion: 1, ...context };
  const config = await repositoryConfiguration(service, { required: options.requiredConfig });
  const match = resolveRepositoryProfile(config, context.repository.remote, options.profile);
  if (!match) return { schemaVersion: 1, matched: false, reason: 'no-profile', ...context };
  const metadata = { schemaVersion: 1, matched: true, ...context, profile: match.profile, variables: match.variables };
  if (options.resolveOnly) return { ...metadata, definition: match.definition };

  // Persist only the resolved definition so ordinary detached refresh workers can reload it.
  // Origin and source config scope the cache; subdirectories/worktrees share remote results.
  const identity = createHash('sha256')
    .update(`${service.paths.config}\0${match.profile}\0${context.repository.remote}`).digest('hex');
  const path = join(service.paths.cache, 'repositories', `${identity}.json`);
  const runtime = {
    version: 1, ...(config.presentation === undefined ? {} : { presentation: config.presentation }),
    profiles: { [match.profile]: match.definition },
  };
  await withLock(path, async checkLock => {
    if (JSON.stringify(await readJson(path)) !== JSON.stringify(runtime)) {
      checkLock();
      await writeJson(path, runtime);
    }
  });
  const scoped = new DevDash({ home: service.paths.home, config: path }, {
    queryProfile: service.query, now: service.now, monotonicNow: service.monotonicNow,
    scheduleRefresh: service.scheduleRefresh, diagnostics: service.diagnostics,
  });
  return {
    ...await scoped.get(match.profile, {
      query: options.query, cachedOnly: options.cachedOnly ?? false,
      cacheMode: options.cacheMode ?? (options.cachedOnly ? 'cache-first' : 'adaptive'),
      ...(options.fastQueryMs === undefined ? {} : { fastQueryMs: options.fastQueryMs }),
    }),
    matched: true, repository: context.repository,
  };
}
