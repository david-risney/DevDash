import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDash } from '../src/service.js';
import { frameMessage } from '../src/native.js';
import { formatResults } from '../src/format.js';
import { testItem } from './helpers/test-provider.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/devdash.js', import.meta.url));
const native = fileURLToPath(new URL('../bin/devdash-native.js', import.meta.url));
const profile = { provider: 'github', resource: 'prs', repository: 'owner/repo', refreshSeconds: 300 };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, DEVDASH_HOME: home };
  const service = new DevDash({ home }, { queryProfile: async () => ({ items: [], truncated: false }) });
  return { home, env, service };
}

async function run(args, env) {
  const { stdout, stderr } = await execute(process.execPath, [cli, ...args], { env, windowsHide: true });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

function nativeProcess(executable, args, input, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, shell: false, ...options });
    const output = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout: Buffer.concat(output) }));
    child.stdin.end(input);
  });
}

test('process-level CLI initialization, profiles, cached reads, status and cleanup are JSON-first', async (t) => {
  const { service, env } = await fixture(t);
  assert.equal((await run(['--version'], env)).version, '0.1.0');
  assert.equal((await run(['init'], env)).schemaVersion, 1);
  await service.setProfile('prs', profile);
  await service.get('prs');
  assert.equal((await run(['profile', 'list'], env)).profiles[0].name, 'prs');
  assert.equal((await run(['get', 'prs', '--cached-only'], env)).fromCache, true);
  assert.equal((await run(['get', 'prs'], env)).fromCache, true);
  assert.equal((await run(['cache', 'status', 'prs'], env)).count, 0);
  assert.equal((await run(['cache', 'clear', 'prs'], env)).cleared, 'prs');
  assert.equal((await run(['profile', 'remove', 'prs'], env)).removed, 'prs');
  assert.deepEqual((await run(['profile', 'list'], env)).profiles, []);
});

test('get formats selected, grouped and all cached query results directly while keeping JSON the default', async t => {
  const { service, env } = await fixture(t);
  service.query = async () => ({ items: [testItem({ kind: 'pr', title: 'Synthetic format integration' })], truncated: false });
  await service.setProfile('reviews', { refreshSeconds: 300, queries: { authored: profile, requested: profile } });
  await service.get('reviews');
  for (const selector of [['reviews', '--query', 'authored'], ['reviews'], ['--all']]) {
    const args = ['get', ...selector, '--cached-only'];
    const json = await run(args, env);
    assert.deepEqual(await run([...args, '--format', 'json'], env), json);
    for (const [format, renderer] of [['ansi', 'ansi'], ['ascii', 'text'], ['md', 'markdown']]) {
      const { stdout, stderr } = await execute(process.execPath, [cli, ...args, `--format=${format}`], { env, windowsHide: true });
      assert.equal(stderr, '');
      assert.equal(stdout, formatResults(json, renderer).output);
      if (format === 'ansi') {
        assert.ok(stdout.includes('\u2590'));
        assert.ok(stdout.includes('\u258c'));
        assert.match(stdout, /\u259d\u2580+\u2598/);
        assert.doesNotMatch(stdout, /[\u2500-\u257f]/);
      } else {
        assert.ok(!stdout.includes('\x1b'));
        assert.ok(!stdout.includes('\u2590'));
      }
    }
  }
  const pretty = await execute(process.execPath, [cli, 'get', 'reviews', '--cached-only', '--pretty', '--format', 'json'], { env, windowsHide: true });
  assert.ok(pretty.stdout.startsWith('{\n'));
});

test('human formats preserve partial failure exit status and refresh accepts the same output selector', async t => {
  const { service, env } = await fixture(t);
  await service.setProfile('ready', profile);
  await service.get('ready');
  await service.setProfile('missing-cache', profile);
  for (const format of ['ansi', 'ascii', 'md']) {
    const partial = await nativeProcess(process.execPath, [cli, 'get', '--all', '--cached-only', '--format', format], '', env);
    assert.equal(partial.code, 2);
    assert.equal(partial.stderr, '');
    assert.ok(partial.stdout.toString().includes(format === 'md' ? 'CACHE\\_MISS' : 'CACHE_MISS'));
    assert.ok(partial.stdout.toString().includes('ready'));
  }
  await service.removeProfile('ready');
  await service.removeProfile('missing-cache');
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    const result = await nativeProcess(process.execPath, [cli, 'refresh', '--all', '--format', format], '', env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(format === 'json' ? JSON.parse(result.stdout).results.length === 0 : result.stdout.toString().includes('No query results.'));
  }
});

test('format choices and command compatibility fail explicitly before provider access', async t => {
  const { env } = await fixture(t);
  for (const args of [
    ['get', 'reviews', '--format', 'html'],
    ['get', 'reviews', '--format', 'ansi', '--pretty'],
    ['config', 'show', '--format', 'md'],
    ['native-host', '--format', 'ansi'],
    ['native-manifest', '--format', 'ascii'],
  ]) {
    const result = await nativeProcess(process.execPath, [cli, ...args], '', env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  }
});

test('CLI resolves user/file/group/query styles for cached results and explicit stdin configuration without rewriting caches', async t => {
  const { env, service, home } = await fixture(t);
  service.query = async () => ({ items: [testItem({ title: 'Layered style integration' })], truncated: false });
  await service.setProfile('work', {
    refreshSeconds: 300,
    presentation: { ansi: { table: { header: { background: '#334455' } } } },
    queries: {
      bugs: { ...profile, resource: 'bugs' },
      priority: { ...profile, resource: 'bugs', presentation: {
        ansi: { table: { header: { background: '#445566' }, columns: { title: { bold: true } } } },
        ascii: { links: false }, md: { headingLevel: 4 },
      } },
    },
  });
  await service.get('work');
  const config = await service.config();
  config.presentation = { ansi: { table: { header: { background: '#223344' } } } };
  await writeFile(service.paths.config, JSON.stringify(config));
  await writeFile(service.paths.userConfig, JSON.stringify({
    version: 1, presentation: {
      ansi: { palette: { userInk: '#ddeeff' }, glyphs: { dashboard: 'D' },
        table: { header: { foreground: 'p:userInk' }, border: { left: '[', right: ']' }, padding: 2, gap: 1, separator: ':' } },
      ascii: { table: { separator: ' / ', junction: '-/-' } }, md: { headingLevel: 3 },
    },
  }));
  const before = await readFile(service.cachePath('work', 'bugs'), 'utf8');
  const args = ['get', 'work', '--cached-only'];
  const ansi = await execute(process.execPath, [cli, ...args, '--format', 'ansi'], { env, windowsHide: true });
  assert.ok(ansi.stdout.includes('\x1b[0;48;2;51;68;85;38;2;221;238;255;1m'));
  assert.ok(ansi.stdout.includes('\x1b[0;48;2;68;85;102;38;2;221;238;255;1m'));
  assert.ok(ansi.stdout.includes('D DevDash'));
  assert.ok(ansi.stdout.includes('\x1b[0;38;2;51;68;85m[\x1b['));
  assert.ok(ansi.stdout.includes(': '));
  const ascii = await execute(process.execPath, [cli, ...args, '--format', 'ascii'], { env, windowsHide: true });
  assert.ok(ascii.stdout.includes('Item / Title'));
  assert.equal(ascii.stdout.match(/Links:/g).length, 1);
  const md = await execute(process.execPath, [cli, ...args, '--format', 'md'], { env, windowsHide: true });
  assert.ok(md.stdout.includes('### work / bugs'));
  assert.ok(md.stdout.includes('#### work / priority'));
  const json = await run(args, env);
  assert.ok(!JSON.stringify(json).includes('presentation'));
  assert.equal(await readFile(service.cachePath('work', 'bugs'), 'utf8'), before);
  const converted = await nativeProcess(process.execPath, [cli, 'format', '--config', service.paths.config, '--format', 'ansi'],
    JSON.stringify(json), env);
  assert.equal(converted.code, 0, converted.stderr);
  assert.equal(converted.stdout.toString(), ansi.stdout);
  const custom = join(home, 'alternate-user.json');
  await writeFile(custom, JSON.stringify({ version: 1, presentation: { md: { headingLevel: 5 } } }));
  const alternate = await nativeProcess(process.execPath, [cli, 'format', '--user-config', custom, '--format', 'md'],
    JSON.stringify(json), env);
  assert.equal(alternate.code, 0, alternate.stderr);
  assert.ok(alternate.stdout.toString().includes('##### work / bugs'));
});

test('invalid presentation fails human output before provider access but cannot corrupt default JSON or native results', async t => {
  const { env, service } = await fixture(t);
  await service.setProfile('reviews', profile);
  await service.get('reviews');
  await writeFile(service.paths.userConfig, JSON.stringify({
    version: 1, presentation: { ansi: { table: { header: { foreground: 'p:SECRET_MISSING_COLOR' } } } },
  }));
  const result = await nativeProcess(process.execPath, [cli, 'refresh', 'reviews', '--format', 'ansi'], '', env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_PRESENTATION');
  assert.ok(!result.stderr.includes('SECRET_MISSING_COLOR'));
  assert.equal((await run(['get', 'reviews', '--cached-only'], env)).fromCache, true);
  for (const table of [{ border: { left: '\x1b[31m' } }, { border: { right: '\u754c' } }, { padding: 99 }]) {
    await writeFile(service.paths.userConfig, JSON.stringify({ version: 1, presentation: { ansi: { table } } }));
    const invalidGeometry = await nativeProcess(process.execPath, [cli, 'refresh', 'reviews', '--format', 'ansi'], '', env);
    assert.equal(invalidGeometry.code, 1);
    assert.equal(invalidGeometry.stdout.length, 0);
    assert.equal(JSON.parse(invalidGeometry.stderr).error.code, 'INVALID_PRESENTATION');
  }
  const nativeResult = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'get', profile: 'reviews', cachedOnly: true,
  }), env);
  assert.equal(nativeResult.code, 0);
  assert.equal(nativeResult.stderr, '');
  assert.equal(JSON.parse(nativeResult.stdout.subarray(4)).fromCache, true);
  const missing = await nativeProcess(process.execPath, [cli, 'get', 'reviews', '--cached-only', '--format', 'md',
    '--user-config', join(service.paths.home, 'missing.json')], '', env);
  assert.equal(JSON.parse(missing.stderr).error.code, 'INVALID_PRESENTATION');
});

test('format command defaults to validated JSON and detects nested failures without relying on aggregate counters', async t => {
  const { env } = await fixture(t);
  const document = { queries: {
    good: { items: [testItem()], truncated: false },
    bad: { error: { code: 'CLI_FAILED', message: 'Synthetic provider failure.' } },
  } };
  const result = await nativeProcess(process.execPath, [cli, 'format'], JSON.stringify(document), env);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), document);
  const invalid = await nativeProcess(process.execPath, [cli, 'format'], '{"PRIVATE_INPUT":', env);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout.length, 0);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_INPUT');
  assert.ok(!invalid.stderr.includes('PRIVATE_INPUT'));
});

test('watch emits selected human formats and retains JSON-lines events by default', async t => {
  const { service, env, home } = await fixture(t);
  await service.setProfile('reviews', profile);
  await writeFile(service.paths.userConfig, JSON.stringify({
    version: 1, presentation: {
      ansi: { table: { header: { background: '#344556' } } }, md: { headingLevel: 4 },
    },
  }));
  // An empty PATH makes provider failure deterministic without running gh or contacting a provider.
  const isolated = { ...env, PATH: home, Path: home };
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'watch', 'reviews', '--interval', '86400',
        ...(format === 'json' ? [] : ['--format', format])], {
        env: isolated, windowsHide: true, shell: false,
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Timed out waiting for the synthetic watch event.'));
      }, 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk;
        if (stdout.includes(format === 'md' ? 'CLI\\_NOT\\_FOUND' : 'CLI_NOT_FOUND')) child.kill();
      });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    });
    assert.equal(result.stderr, '');
    if (format === 'json') {
      const event = JSON.parse(result.stdout);
      assert.equal(event.event, 'error');
      assert.equal(event.error.code, 'CLI_NOT_FOUND');
      assert.equal(result.stdout.trim().split('\n').length, 1);
    } else {
      assert.ok(result.stdout.includes('reviews'));
      assert.ok(result.stdout.includes(format === 'md' ? 'CLI\\_NOT\\_FOUND' : 'CLI_NOT_FOUND'));
      assert.equal(result.stdout.includes('\u2590'), format === 'ansi');
      if (format === 'ansi') assert.ok(result.stdout.includes('\x1b[0;48;2;52;69;86;'));
      if (format === 'md') assert.ok(result.stdout.includes('#### reviews'));
    }
  }
});

test('process-level failures produce only JSON stderr with nonzero status', async (t) => {
  const { env } = await fixture(t);
  for (const [args, code] of [
    [['get', 'missing'], 'CONFIG_NOT_FOUND'],
    [['unknown'], 'INVALID_ARGUMENT'],
    [['native-host', '--pretty'], 'INVALID_ARGUMENT'],
    [['native-manifest'], 'INVALID_ARGUMENT'],
  ]) {
    await assert.rejects(execute(process.execPath, [cli, ...args], { env, windowsHide: true }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(JSON.parse(error.stderr).error.code, code);
      return true;
    });
  }
});

test('native host processes return framed JSON from the same persistent cache', async (t) => {
  const { env, service } = await fixture(t);
  await service.setProfile('prs', profile);
  await service.get('prs');
  for (const args of [[native, `chrome-extension://${'a'.repeat(32)}/`, '--parent-window=0'], [cli, 'native-host']]) {
    const result = await nativeProcess(process.execPath, args, frameMessage({
      command: 'get', profile: 'prs', cachedOnly: true,
    }), env);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const size = endianness() === 'LE' ? result.stdout.readUInt32LE() : result.stdout.readUInt32BE();
    assert.equal(result.stdout.length, size + 4);
    assert.equal(JSON.parse(result.stdout.subarray(4).toString()).fromCache, true);
  }
});

test('checked-in Windows native launcher works with framed stdin', { skip: process.platform !== 'win32' }, async (t) => {
  const { env, service } = await fixture(t);
  await service.setProfile('prs', profile);
  const launcher = fileURLToPath(new URL('../bin/devdash-native.cmd', import.meta.url));
  const result = await nativeProcess(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`],
    frameMessage({ command: 'profiles' }), env, { windowsVerbatimArguments: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout.subarray(4).toString());
  assert.equal(output.profiles[0].name, 'prs');
});

test('native profile configuration is persistent and rejects invalid definitions', async (t) => {
  const { env, service } = await fixture(t);
  const output = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'profile-set', profile: 'browser-prs', definition: profile,
  }), env);
  assert.equal(output.code, 0);
  assert.equal(output.stderr, '');
  assert.equal((await service.profile('browser-prs')).repository, profile.repository);
  const invalid = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'profile-set', profile: 'browser-prs', definition: { ...profile, token: 'SECRET_TOKEN' },
  }), env);
  const error = JSON.parse(invalid.stdout.subarray(4).toString()).error;
  assert.equal(error.code, 'INVALID_CONFIG');
  assert.equal(error.message.includes('SECRET_TOKEN'), false);
  assert.equal((await service.profile('browser-prs')).repository, profile.repository);
});

test('profile updates in independent processes preserve all profiles', async (t) => {
  const { env, service } = await fixture(t);
  await service.init();
  const script = `
    import { DevDash } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
    await new DevDash().setProfile(process.argv[1], ${JSON.stringify(profile)});
  `;
  await Promise.all(['one', 'two', 'three'].map((name) =>
    execute(process.execPath, ['--input-type=module', '-e', script, name], { env, windowsHide: true })));
  assert.equal((await service.list()).profiles.length, 3);
});

test('native manifest command produces JSON without writing browser settings', async (t) => {
  const { env } = await fixture(t);
  const launcher = fileURLToPath(new URL('../bin/devdash-native.cmd', import.meta.url));
  const result = await run(['native-manifest', '--extension-id', 'a'.repeat(32), '--launcher', launcher], env);
  assert.equal(result.name, 'com.devdash.cli');
  assert.equal(result.path, launcher);
  assert.deepEqual(result.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
});

test('failed CLI commands can be investigated after exit without secrets in logs', async (t) => {
  const { env, home, service } = await fixture(t);
  await service.init();
  let diagnosticId;
  await assert.rejects(execute(process.execPath, [cli, 'get', 'missing'], { env, windowsHide: true }), (error) => {
    const payload = JSON.parse(error.stderr);
    diagnosticId = payload.error.diagnosticId;
    assert.match(diagnosticId, /^[a-f0-9-]{36}$/);
    assert.equal(error.stdout, '');
    return true;
  });
  const result = await run(['logs', 'tail', '--errors'], env);
  assert.ok(result.entries.some((entry) => entry.requestId === diagnosticId && entry.code === 'PROFILE_NOT_FOUND'));
  await assert.rejects(execute(process.execPath, [cli, '--unknown=SECRET_ARGUMENT'], { env, windowsHide: true }));
  assert.equal((await readFile(join(home, 'logs', 'devdash.jsonl'), 'utf8')).includes('SECRET_ARGUMENT'), false);
});

test('unwritable logs produce a single JSON error without stdout or protocol pollution', async (t) => {
  const { env, home } = await fixture(t);
  await writeFile(join(home, 'logs'), 'not a directory');
  await assert.rejects(execute(process.execPath, [cli, 'init'], { env, windowsHide: true }), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'LOG_WRITE_FAILED');
    return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--unknown'], { env, windowsHide: true }), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'LOG_WRITE_FAILED');
    return true;
  });
});

test('native requests have distinct diagnostic IDs while sharing one session', async (t) => {
  const { env, service } = await fixture(t);
  await service.init();
  const requests = Buffer.concat([
    frameMessage({ command: 'get', profile: 'missing' }),
    frameMessage({ command: 'get', profile: 'missing' }),
  ]);
  const result = await nativeProcess(process.execPath, [native], requests, env);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const starts = (await service.diagnostics.tail({ lines: 100 })).entries.filter((entry) => entry.event === 'native.request.start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].requestId, starts[1].requestId);
  assert.equal(starts[0].sessionId, starts[1].sessionId);
});

test('CLI and native consumers receive four named query lists and can select one', async (t) => {
  const { env, service } = await fixture(t);
  const grouped = {
    refreshSeconds: 300,
    queries: {
      bugs: { ...profile, resource: 'bugs' },
      'security-bugs': { ...profile, resource: 'bugs', query: 'label:security' },
      'my-prs': { ...profile, query: 'author:@me' },
      'review-prs': { ...profile, query: 'review-requested:@me' },
    },
  };
  await service.setProfile('edge', grouped);
  await service.get('edge');
  const result = await run(['get', 'edge', '--cached-only'], env);
  assert.deepEqual(Object.keys(result.queries), Object.keys(grouped.queries));
  assert.equal(result.failed, 0);
  assert.equal(result.fromCache, true);
  const selected = await run(['get', 'edge', '--query', 'my-prs', '--cached-only'], env);
  assert.equal(selected.query, 'my-prs');
  assert.equal(selected.queries, undefined);
  const nativeResult = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'get', profile: 'edge', cachedOnly: true,
  }), env);
  assert.equal(nativeResult.stderr, '');
  assert.deepEqual(Object.keys(JSON.parse(nativeResult.stdout.subarray(4).toString()).queries), Object.keys(grouped.queries));
  const nativeSelected = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'get', profile: 'edge', query: 'review-prs', cachedOnly: true,
  }), env);
  assert.equal(JSON.parse(nativeSelected.stdout.subarray(4).toString()).query, 'review-prs');
  await run(['cache', 'clear', 'edge', '--query', 'bugs'], env);
  await assert.rejects(execute(process.execPath, [cli, 'get', 'edge', '--cached-only'], {
    env, windowsHide: true,
  }), (error) => {
    assert.equal(error.code, 2);
    assert.equal(error.stderr, '');
    const partial = JSON.parse(error.stdout);
    assert.equal(partial.failed, 1);
    assert.equal(partial.queries.bugs.error.code, 'CACHE_MISS');
    assert.equal(partial.queries['my-prs'].fromCache, true);
    return true;
  });
  await assert.rejects(execute(process.execPath, [cli, 'get', '--all', '--cached-only'], {
    env, windowsHide: true,
  }), (error) => {
    assert.equal(error.code, 2);
    const batch = JSON.parse(error.stdout);
    assert.equal(batch.failed, 1);
    assert.equal(batch.results[0].failed, 1);
    return true;
  });
  const list = await run(['profile', 'list'], env);
  assert.equal(list.profiles[0].queries['my-prs'].limit, 1000);
  assert.equal((await run(['cache', 'status', 'edge', '--query', 'my-prs'], env)).cached, true);
});
