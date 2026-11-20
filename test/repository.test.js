import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { executeCommand } from '../src/commands.js';
import { validateConfig } from '../src/config.js';
import { readJson } from '../src/storage.js';
import { defaultConfig, normalizeRemote } from '../src/profile-templates.js';
import { inspectRepository, resolveRepositoryProfile } from '../src/repository.js';
import { testItem } from './helpers/test-provider.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/devdash.js', import.meta.url));
const git = async args => (await execute('git', args, { windowsHide: true })).stdout;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devdash remote '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'checkout');
  await mkdir(join(directory, 'nested'), { recursive: true });
  await git(['init', '--quiet', '--template=', directory]);
  await git(['-C', directory, 'remote', 'add', 'origin', 'git@github.com:sample/demo.git']);
  const service = new DevDash({ home: join(root, 'data') });
  const calls = [];
  service.query = async profile => {
    calls.push(profile);
    return { items: [testItem({ repository: profile.repository, kind: profile.resource === 'prs' ? 'pr' : 'bug' })], truncated: false };
  };
  return { root, directory, service, calls };
}

test('default remote profiles resolve HTTPS, SSH, legacy ADO, and nested Chromium projects', () => {
  const config = validateConfig(defaultConfig());
  for (const [url, name, values] of [
    ['https://github.com/sample/demo.git', 'github', { owner: 'sample', repository: 'demo' }],
    ['git@github.com:sample/demo', 'github', { owner: 'sample', repository: 'demo' }],
    ['ssh://git@github.com/sample/demo.git', 'github', { owner: 'sample', repository: 'demo' }],
    ['https://sample@dev.azure.com/sample/My%20Project/_git/my.repo', 'ado',
      { organization: 'sample', project: 'My Project', repository: 'my.repo' }],
    ['git@ssh.dev.azure.com:v3/sample/My.Project/my-repo', 'ado',
      { organization: 'sample', project: 'My.Project', repository: 'my-repo' }],
    ['https://sample.visualstudio.com/My%20Project/_git/my.repo', 'ado',
      { organization: 'sample', project: 'My Project', repository: 'my.repo' }],
    ['https://sample.visualstudio.com/DefaultCollection/My%20Project/_git/my.repo', 'ado',
      { organization: 'sample', project: 'My Project', repository: 'my.repo' }],
    ['https://chromium.googlesource.com/chromium/src.git/', 'chromium', { project: 'chromium/src' }],
    ['https://chromium.googlesource.com/chromium/deps/icu', 'chromium', { project: 'chromium/deps/icu' }],
  ]) {
    const remote = normalizeRemote(url);
    const match = resolveRepositoryProfile(config, remote);
    assert.equal(match.profile, name, url);
    assert.deepEqual(match.variables, values, url);
    assert.ok(!JSON.stringify(match.definition).includes('remoteUrls'));
    if (name === 'github') {
      assert.equal(match.definition.queries.bugs.repository, 'sample/demo');
      assert.equal(match.definition.queries.prs.account, undefined, 'owner is not the authentication account');
    }
    if (name === 'ado') assert.equal(match.definition.queries.bugs.project, values.project);
    if (name === 'chromium') assert.equal(match.definition.queries.cls.project, values.project);
  }
});

test('substitution traverses JSON values and preserves literal types, keys, arrays, and account selection', () => {
  const profile = {
    remoteUrls: ['https://github.com/{Owner}/{Repo}.git'],
    refreshSeconds: 30,
    provider: 'github', resource: 'bugs', account: 'sample-login',
    repositories: ['{Owner}/{Repo}'],
    filter: { language: 'javascript', expression: 'item.repository === params.repository', params: {
      repository: '{Owner}/{Repo}', nested: ['{Repo}', 12, false, null, { '{Repo}': '{Owner}' }],
    } },
  };
  const config = validateConfig({ version: 1, profiles: { custom: profile } });
  const { definition } = resolveRepositoryProfile(config, 'https://github.com/sample/demo');
  assert.equal(definition.account, 'sample-login');
  assert.deepEqual(definition.repositories, ['sample/demo']);
  assert.deepEqual(definition.filter.params.nested, ['demo', 12, false, null, { '{Repo}': 'sample' }]);
  assert.equal(profile.repositories[0], '{Owner}/{Repo}', 'stored templates are not mutated');
});

test('template validation rejects undeclared variables, malformed patterns, typos, and invalid resolved values', () => {
  const base = defaultConfig().profiles.github;
  for (const profile of [
    { ...base, remoteUrls: [] },
    { ...base, remoteUrls: ['https://github.com/{owner}/{repository}', 'https://example.com/fixed'] },
    { ...base, remoteUrls: ['file:///tmp/{repository}'] },
    { ...base, remoteUrls: ['https://github.com/{owner}/{bad-name}'] },
    { ...base, unexpected: true },
    { ...base, queries: { broken: { provider: 'github', resource: 'bugs', typo: '{owner}' } } },
  ]) {
    assert.throws(() => validateConfig({ version: 1, profiles: { broken: profile } }), { code: 'INVALID_CONFIG' });
  }
  const config = validateConfig({ version: 1, profiles: {
    broken: { ...base, queries: { bugs: { provider: 'github', resource: 'bugs', repository: '{owner}/{repository}', limit: 'invalid' } } },
  } });
  assert.throws(() => resolveRepositoryProfile(config, 'https://github.com/sample/demo'), { code: 'INVALID_CONFIG' });
  assert.equal(resolveRepositoryProfile(defaultConfig(), 'https://github.com.evil.example/sample/demo'), null);
  assert.throws(() => resolveRepositoryProfile(defaultConfig(), 'https://github.com/sample/demo/extra'), { code: 'INVALID_CONFIG' });
});

test('custom matches override built-ins; multiple custom matches require an explicit choice', () => {
  const config = defaultConfig();
  config.profiles.personal = { ...config.profiles.github };
  assert.equal(resolveRepositoryProfile(config, 'https://github.com/sample/demo').profile, 'personal');
  config.profiles.work = { ...config.profiles.github };
  assert.throws(() => resolveRepositoryProfile(config, 'https://github.com/sample/demo'), { code: 'AMBIGUOUS_REMOTE_PROFILE' });
  assert.equal(resolveRepositoryProfile(config, 'https://github.com/sample/demo', 'work').profile, 'work');
  assert.throws(() => resolveRepositoryProfile(config, 'https://github.com/sample/demo', 'missing'), { code: 'PROFILE_NOT_FOUND' });
});

test('literal punctuation, repeated variables, and full hostname variables have unambiguous captures', () => {
  const template = {
    remoteUrls: ['https://{host}/devdashvariable0x/{owner}/{repository}/{owner}'],
    refreshSeconds: 30, provider: 'github', resource: 'bugs',
    hostname: '{host}', repository: '{owner}/{repository}',
  };
  const config = validateConfig({ version: 1, profiles: { enterprise: template } });
  const match = resolveRepositoryProfile(config, 'https://git.example.com/devdashvariable0x/sample/demo/sample');
  assert.equal(match.definition.hostname, 'git.example.com');
  assert.equal(match.definition.repository, 'sample/demo');
  assert.equal(resolveRepositoryProfile(config, 'https://git.example.com/devdashvariable0x/sample/demo/other'), null);
});

test('repo resolution is read-only and uses built-ins even without a configuration', async t => {
  const { service, directory, root, calls } = await fixture(t);
  const result = await executeCommand(['repo', join(directory, 'nested'), '--resolve-only'], { service });
  assert.equal(result.output.matched, true);
  assert.equal(result.output.profile, 'github');
  assert.equal(result.output.definition.queries.prs.repository, 'sample/demo');
  assert.equal(result.output.repository.remote, 'https://github.com/sample/demo');
  assert.equal(calls.length, 0);
  assert.equal(await readJson(service.paths.config), null);
  await assert.rejects(readdir(service.paths.cache), { code: 'ENOENT' });
  assert.equal((await inspectRepository(root)).reason, 'not-a-repository');
  await git(['-C', directory, 'remote', 'remove', 'origin']);
  assert.equal((await inspectRepository(directory)).reason, 'no-origin');
});

test('explicit origins bypass Git, normalize credentials and SSH, and work without a checkout or configuration', async t => {
  const { service, root, calls } = await fixture(t);
  const dependencies = { service, git: async () => assert.fail('Explicit origin must not invoke Git') };
  for (const args of [
    ['repo', '--origin', 'git@github.com:sample/other.git'],
    ['--origin', 'https://synthetic@github.com/sample/other.git'],
    ['repo', root, '--origin', 'https://github.com/sample/other'],
  ]) {
    const { output, exitCode } = await executeCommand([...args, '--resolve-only'], dependencies);
    assert.equal(exitCode, 0);
    assert.equal(output.matched, true);
    assert.deepEqual(output.repository, { remote: 'https://github.com/sample/other' });
    assert.equal(output.definition.queries.bugs.repository, 'sample/other');
    assert.ok(!JSON.stringify(output).includes('synthetic'));
  }
  const unmatched = await executeCommand([
    '--origin', 'https://user:secret@example.com/sample/demo.git', '--resolve-only',
  ], dependencies);
  assert.equal(unmatched.output.reason, 'no-profile');
  assert.deepEqual(unmatched.output.repository, { remote: 'https://example.com/sample/demo' });
  assert.equal(calls.length, 0);
  assert.equal(await readJson(service.paths.config), null);
  await assert.rejects(readdir(service.paths.cache), { code: 'ENOENT' });
  for (const origin of ['', 'not a URL', 'file:///local/repo', 'https://github.com/sample/demo?token=secret']) {
    await assert.rejects(executeCommand(['--origin', origin], dependencies), { code: 'INVALID_ARGUMENT' });
  }
  const { stdout, stderr } = await execute(process.execPath, [
    cli, '--origin', 'https://github.com/sample/other.git', '--resolve-only', '--format', 'json',
    '--home', service.paths.home,
  ], { cwd: root, windowsHide: true });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).definition.queries.prs.repository, 'sample/other');
});

test('bare dashboard chooses the cwd template before saved profiles and honors cache overrides', async t => {
  const { service, directory, calls } = await fixture(t);
  const dependencies = { service, git: args => git(['-C', directory, ...args.slice(2)]) };
  await service.setProfile('saved', {
    provider: 'github', resource: 'bugs', repository: 'sample/unrelated', refreshSeconds: 300,
  });
  let now = Date.now();
  service.now = () => now;
  const cold = await executeCommand([], dependencies);
  assert.equal(cold.output.matched, true);
  assert.equal(cold.output.profile, 'github');
  assert.equal(cold.output.fromCache, false);
  assert.deepEqual(calls.map(call => call.repository), ['sample/demo', 'sample/demo']);
  const fresh = await executeCommand(['--format', 'json'], dependencies);
  assert.equal(fresh.output.fromCache, true);
  assert.equal(calls.length, 2);
  now += 300_000;
  const jobs = [];
  service.scheduleRefresh = async job => { jobs.push(job); return { state: 'scheduled' }; };
  const cached = await executeCommand(['--cached-only'], dependencies);
  assert.equal(cached.output.stale, true);
  assert.equal(jobs.length, 0);
  const adaptive = await executeCommand([], dependencies);
  assert.equal(adaptive.output.stale, true);
  assert.equal(jobs.length, 2);
  assert.equal(calls.length, 2);
  const blocking = await executeCommand(['--cache-mode', 'cache-first'], dependencies);
  assert.equal(blocking.output.fromCache, false);
  assert.equal(calls.length, 4);
  const selected = await executeCommand(['--cached-only', '--query', 'bugs'], dependencies);
  assert.equal(selected.output.query, 'bugs');
  assert.equal(selected.output.matched, true);
  const all = await executeCommand(['--all', '--cached-only'], {
    service, git: async () => assert.fail('--all must skip Git'),
  });
  assert.equal(all.exitCode, 2);
  assert.deepEqual(all.output.results.map(result => result.profile), ['saved']);
});

test('bare dashboard fallback is limited to unmatched discovery, not explicit context or failures', async t => {
  const { service, directory, calls } = await fixture(t);
  await service.setProfile('saved', {
    provider: 'github', resource: 'bugs', repository: 'sample/unrelated', refreshSeconds: 300,
  });
  await service.get('saved');
  const cases = [
    async () => { throw Object.assign(new Error('Synthetic non-Git'), { code: 128, stderr: 'not a git repository' }); },
    async args => {
      if (args.includes('rev-parse')) return directory;
      throw Object.assign(new Error('Synthetic missing origin'), { code: 1 });
    },
    async args => args.includes('rev-parse') ? directory : 'C:\\local\\repo',
    async args => args.includes('rev-parse') ? directory : 'https://gitlab.com/sample/demo.git',
  ];
  for (const inspect of cases) {
    const dependencies = { service, git: inspect };
    const fallback = await executeCommand(['--cached-only'], dependencies);
    assert.deepEqual(fallback.output.results.map(result => result.profile), ['saved']);
    for (const args of [['repo'], ['--resolve-only'], ['--profile', 'github'], ['--query', 'bugs']]) {
      const { output } = await executeCommand(args, dependencies);
      assert.equal(output.matched, false);
      assert.equal(output.results, undefined);
    }
  }
  const explicit = await executeCommand(['--origin', 'https://gitlab.com/sample/demo.git'], {
    service, git: async () => assert.fail('Explicit origin must skip Git'),
  });
  assert.equal(explicit.output.reason, 'no-profile');
  assert.equal(explicit.output.results, undefined);
  await assert.rejects(executeCommand([], { service, git: async () => {
    throw Object.assign(new Error('Synthetic ownership error'), { code: 128, stderr: 'dubious ownership' });
  } }), { code: 'GIT_FAILED' });
  assert.equal(calls.length, 1, 'fallbacks never contact unrelated providers when cached-only');
});

test('a matched cwd dashboard reports partial provider failures instead of falling back', async t => {
  const { service, directory } = await fixture(t);
  service.query = async definition => {
    assert.equal(definition.repository, 'sample/demo');
    if (definition.resource === 'bugs') {
      throw new DevDashError('CLI_FAILED', 'Synthetic provider failure');
    }
    return { items: [], truncated: false };
  };
  const result = await executeCommand([], { service, git: args => git(['-C', directory, ...args.slice(2)]) });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.matched, true);
  assert.equal(result.output.failed, 1);
  assert.equal(result.output.queries.bugs.error.code, 'CLI_FAILED');
  assert.deepEqual(result.output.queries.prs.items, []);
});

test('bare CLI resolves cwd templates in every format and explicit origins override local discovery', async t => {
  const { service, directory, root } = await fixture(t);
  await executeCommand(['repo', directory], { service });
  const env = { ...process.env, DEVDASH_HOME: service.paths.home };
  for (const format of [undefined, 'json', 'ansi', 'ascii', 'md']) {
    const { stdout, stderr } = await execute(process.execPath,
      [cli, ...(format ? ['--format', format] : [])], { env, cwd: join(directory, 'nested'), windowsHide: true });
    assert.equal(stderr, '');
    if (format === 'json') {
      const output = JSON.parse(stdout);
      assert.equal(output.matched, true);
      assert.equal(output.profile, 'github');
      assert.equal(output.repository.remote, 'https://github.com/sample/demo');
    } else {
      assert.equal(stdout.includes('\x1b['), (format ?? 'ansi') === 'ansi');
      assert.ok(stdout.includes('Synthetic cache regression'));
    }
  }
  for (const cwd of [root, directory]) {
    const { stdout } = await execute(process.execPath, [
      cli, '--origin', 'https://github.com/sample/other.git', '--resolve-only', '--format', 'json',
    ], { env, cwd, windowsHide: true });
    assert.equal(JSON.parse(stdout).definition.queries.prs.repository, 'sample/other');
  }
  const cached = await execute(process.execPath, [
    cli, '--origin', 'git@github.com:sample/demo.git', '--cached-only', '--format', 'json',
  ], { env, cwd: root, windowsHide: true });
  assert.equal(JSON.parse(cached.stdout).fromCache, true, 'explicit SSH and discovered HTTPS share cached results');
});

test('repo shares caches within a project, isolates different origins, and gives workers resolved config', async t => {
  const { service, directory, calls } = await fixture(t);
  let now = Date.now();
  service.now = () => now;
  const first = await executeCommand(['repo', directory], { service });
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.fromCache, false);
  assert.deepEqual(calls.map(call => call.repository), ['sample/demo', 'sample/demo']);
  const cached = await executeCommand(['repo', join(directory, 'nested'), '--cached-only'], { service });
  assert.equal(cached.output.fromCache, true);
  assert.equal(calls.length, 2);
  const jobs = [];
  service.scheduleRefresh = async job => {
    jobs.push(job);
    const config = await readJson(job.paths.config);
    assert.equal(config.profiles.github.queries.bugs.repository, 'sample/demo');
    assert.equal(config.profiles.github.remoteUrls, undefined);
    return { state: 'scheduled' };
  };
  now += 300_000;
  const expired = await executeCommand(['repo', directory], { service });
  assert.equal(expired.output.stale, true);
  assert.equal(jobs.length, 2);
  assert.ok(Object.values(expired.output.queries).every(result => result.refreshStatus === 'scheduled'));
  const explicit = await executeCommand(['--origin', 'https://github.com/sample/other.git'], {
    service, git: async () => assert.fail('Explicit origin must skip Git'),
  });
  assert.equal(explicit.output.fromCache, false);
  assert.equal(explicit.output.repository.remote, 'https://github.com/sample/other');
  await git(['-C', directory, 'remote', 'set-url', 'origin', 'https://github.com/sample/other.git']);
  const other = await executeCommand(['repo', directory], { service });
  assert.equal(other.output.fromCache, true);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].repository, 'sample/other');
  assert.equal(await readJson(service.paths.config), null);
});

test('Git inspection uses the nested repository origin and understands linked worktree .git files', async t => {
  const { root, directory } = await fixture(t);
  const nested = join(directory, 'nested');
  await git(['init', '--quiet', '--template=', nested]);
  await git(['-C', nested, 'remote', 'add', 'origin', 'https://chromium.googlesource.com/chromium/deps/icu']);
  const inner = await inspectRepository(nested);
  assert.equal(inner.repository.remote, 'https://chromium.googlesource.com/chromium/deps/icu');
  assert.notEqual(inner.repository.root, (await inspectRepository(directory)).repository.root);
  await git(['-C', directory, '-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`,
    'commit', '--quiet', '--allow-empty', '-m', 'Synthetic worktree fixture']);
  const worktree = join(root, 'linked-worktree');
  await git(['-C', directory, 'worktree', 'add', '--quiet', '--detach', worktree]);
  const linked = await inspectRepository(worktree);
  assert.equal(linked.repository.remote, 'https://github.com/sample/demo');
  assert.ok(linked.repository.root.endsWith('linked-worktree'));
});

test('Git inspection and explicitly missing configuration errors are surfaced, not treated as unmatched', async t => {
  const { service, directory } = await fixture(t);
  await assert.rejects(inspectRepository(directory, {
    git: async () => { throw Object.assign(new Error('private stderr'), { code: 'ENOENT' }); },
  }), { code: 'CLI_NOT_FOUND' });
  await assert.rejects(inspectRepository(directory, {
    git: async () => { throw Object.assign(new Error('private stderr'), { code: 128, stderr: 'dubious ownership' }); },
  }), { code: 'GIT_FAILED' });
  await assert.rejects(executeCommand(['repo', directory, '--config', join(service.paths.home, 'missing.json')],
    { service }), { code: 'CONFIG_NOT_FOUND' });
});

test('init includes templates, ordinary all-profile operations skip them, and direct get explains resolution', async t => {
  const { service, directory, calls } = await fixture(t);
  await service.init();
  assert.deepEqual((await service.list()).profiles.map(profile => profile.name), ['github', 'ado', 'chromium']);
  assert.equal((await executeCommand(['get', '--all'], { service })).output.results.length, 0);
  assert.equal((await service.getAll()).results.length, 0);
  await assert.rejects(service.get('github'), { code: 'REPOSITORY_REQUIRED' });
  const saved = await readFile(service.paths.config, 'utf8');
  await executeCommand(['repo', directory], { service });
  assert.equal(calls.length, 2);
  assert.equal(await readFile(service.paths.config, 'utf8'), saved);
});

test('repo CLI supports every format, is quiet for unmatched folders, and rejects invalid flags', async t => {
  const { service, directory, root } = await fixture(t);
  await executeCommand(['repo', directory], { service });
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    const { stdout, stderr } = await execute(process.execPath,
      [cli, 'repo', directory, '--home', service.paths.home, '--cached-only', '--format', format], { windowsHide: true });
    assert.equal(stderr, '');
    if (format === 'json') assert.equal(JSON.parse(stdout).matched, true);
    else {
      assert.equal(stdout.includes('\x1b['), format === 'ansi');
      assert.ok(stdout.includes('Synthetic cache regression'));
    }
  }
  const quiet = await execute(process.execPath, [cli, 'repo', root, '--home', service.paths.home], { windowsHide: true });
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  for (const args of [
    ['repo', directory, '--all'], ['repo', directory, '--cache-mode', 'bogus'],
    ['repo', directory, '--cache-mode', 'adaptive', '--cached-only'],
    ['repo', directory, '--resolve-only', '--query', 'bugs'],
  ]) await assert.rejects(executeCommand(args, { service }), { code: 'INVALID_ARGUMENT' });
});
