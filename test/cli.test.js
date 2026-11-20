import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { DevDash } from '../src/service.js';
import { frameMessage } from '../src/native.js';
import { formatResults } from '../src/format.js';
import { presentationThemes } from '../src/presentation.js';
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

async function run(args, env, options = {}) {
  const { stdout, stderr } = await execute(process.execPath, [cli, ...args, '--format', 'json'], { env, windowsHide: true, ...options });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('help and version honor every format without configuration, with ANSI as default', async t => {
  const { env } = await fixture(t);
  for (const format of [undefined, 'json', 'ansi', 'ascii', 'md']) {
    for (const args of [['--help'], ['--version']]) {
      const { stdout, stderr } = await execute(process.execPath,
        [cli, ...(format ? ['--format', format] : []), ...args], { env, windowsHide: true });
      assert.equal(stderr, '');
      if (format === 'json') {
        const document = JSON.parse(stdout);
        assert.equal(document.version, '0.1.0');
        if (!args.includes('--version')) assert.ok(document.options['--format <json|ansi|ascii|md>'].includes('default ansi'));
      } else {
        assert.equal(stdout.includes('\x1b['), (format ?? 'ansi') === 'ansi');
        assert.ok(stdout.includes(format === 'md' ? '0\\.1\\.0' : '0.1.0'));
        if (!args.includes('--version')) {
          assert.ok(stdout.includes('Commands') || stdout.includes('commands'));
          assert.ok(stdout.includes('default ansi'));
        }
      }
    }
  }
});

test('theme previews default to ANSI, filter globs, and support every format without configuration', async t => {
  const { env } = await fixture(t);
  const all = await run(['--themes'], env);
  assert.deepEqual(all.themes.map(theme => theme.name), Object.keys(presentationThemes));
  const preview = await execute(process.execPath, [cli, '--themes'], { env, windowsHide: true });
  for (const [theme, pills, emoji, text] of [
    ['half-block', false, false, true], ['chevron', false, false, true],
    ['semicircle', true, true, true], ['chevron-tab', false, true, false],
    ['semicircle-tab', true, false, true], ['rounded-pills', true, true, true],
  ]) {
    const block = preview.stdout.split('\n\n').find(block => block.includes(`${theme} -`));
    assert.ok(block, theme);
    assert.equal(block.includes('\x1b[0;48;2;140;200;255;'), pills, theme);
    assert.equal(block.includes('\u{1f513}'), emoji, theme);
    assert.equal(block.includes('Open'), text, theme);
  }
  for (const format of [undefined, 'ansi', 'ascii', 'md']) {
    const result = await execute(process.execPath, [cli, '--themes', '*tab', ...(format ? ['--format', format] : [])],
      { env, windowsHide: true });
    assert.equal(result.stderr, '');
    const text = format === 'md' ? result.stdout.replaceAll('\\-', '-') : result.stdout;
    assert.ok(text.includes('chevron-tab') && text.includes('semicircle-tab'));
    assert.ok(result.stdout.includes('Fix refresh race'));
    assert.ok(!result.stdout.includes('half-block') && !result.stdout.includes('rounded-pills'));
    assert.equal(result.stdout.includes('\x1b['), !format || format === 'ansi');
  }
  const noMatches = await execute(process.execPath, [cli, '--themes=missing*'], { env, windowsHide: true });
  assert.ok(noMatches.stdout.includes('No themes match'));
  const malformed = await nativeProcess(process.execPath, [cli, '--themes=[', '--format', 'json'], '', env);
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.stderr).error.code, 'INVALID_ARGUMENT');
});

test('CLI file/URL overlays work in order for config, cached queries, previews and native launchers', async t => {
  const { env, home } = await fixture(t);
  const base = join(home, 'base.json'), override = join(home, 'override.json');
  await writeFile(base, JSON.stringify({ version: 1, profiles: { reviews: { ...profile, limit: 100 } } }));
  await writeFile(override, JSON.stringify({ profiles: { reviews: { query: 'is:open' } } }));
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/override.json' }); response.end(); return;
    }
    if (request.url === '/invalid') { response.end('SECRET_SERVER_PAYLOAD'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      presentation: { ansi: { palette: { accent: '#314159' } } },
      profiles: { reviews: { limit: 25, query: 'is:closed' } },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/override.json`;
  const configs = [base, url, override];
  const args = ['--config', base, `--config=${url}`, '--config', override];
  const service = new DevDash({ home, config: configs }, {
    queryProfile: async definition => {
      assert.equal(definition.limit, 25);
      assert.equal(definition.query, 'is:open');
      return { items: [testItem({ kind: 'pr', title: 'Layered URL cache result' })], truncated: false };
    },
  });
  await service.get('reviews');
  const before = await readFile(service.cachePath('reviews'));
  const shown = await run(['config', 'show', ...args], env);
  assert.equal(shown.profiles.reviews.query, 'is:open');
  assert.equal(shown.profiles.reviews.limit, 25);
  assert.equal((await run(['config', 'validate', ...args], env)).valid, true);
  const reversed = await run(['config', 'show', '--config', url, '--config', base], env);
  assert.equal(reversed.profiles.reviews.limit, 100);
  const cached = await run(['get', 'reviews', '--cached-only', ...args], env);
  assert.equal(cached.items[0].title, 'Layered URL cache result');
  const preview = await execute(process.execPath, [cli, '--themes=*tab', ...args], { env, windowsHide: true });
  assert.ok(preview.stdout.includes('38;2;49;65;89m'));
  const launcher = join(home, 'launcher.json');
  await writeFile(launcher, JSON.stringify({ home, config: configs }));
  const nativeResult = await nativeProcess(process.execPath, [native, '--launch-config', launcher],
    frameMessage({ command: 'get', profile: 'reviews', cachedOnly: true }), env);
  assert.equal(nativeResult.code, 0, nativeResult.stderr);
  assert.deepEqual(JSON.parse(nativeResult.stdout.subarray(4)), cached);
  assert.deepEqual(await readFile(service.cachePath('reviews')), before);
  for (const route of ['/redirect', '/invalid']) {
    const failure = await nativeProcess(process.execPath, [cli, 'config', 'show', '--config', new URL(route, url).href,
      '--format', 'json'], '', env);
    assert.equal(failure.code, 1);
    assert.ok(['CONFIG_FETCH_FAILED', 'INVALID_JSON'].includes(JSON.parse(failure.stderr).error.code));
    assert.ok(!failure.stderr.includes('SECRET_SERVER_PAYLOAD'));
  }
  const unsafe = await nativeProcess(process.execPath, [cli, 'config', 'show', '--config',
    'https://user:password@example.com/config.json', '--format', 'json'], '', env);
  assert.equal(unsafe.code, 1);
  assert.equal(JSON.parse(unsafe.stderr).error.code, 'INVALID_ARGUMENT');
  assert.ok(!unsafe.stderr.includes('password'));
});

test('bare CLI falls back to all profiles outside Git, honoring formats and cache settings', async t => {
  const { service, env } = await fixture(t);
  service.query = async definition => ({
    items: [testItem({ kind: definition.resource === 'prs' ? 'pr' : 'bug', title: 'Synthetic default dashboard' })],
    truncated: false,
  });
  await service.setProfile('bugs', { ...profile, resource: 'bugs' });
  await service.setProfile('reviews', { refreshSeconds: 300, queries: { requested: profile } });
  await service.get('bugs');
  await service.get('reviews');
  const json = await run(['get', '--all', '--cache-mode', 'adaptive'], env);
  for (const format of [undefined, 'json', 'ansi', 'ascii', 'md']) {
    const { stdout, stderr } = await execute(process.execPath, [cli, ...(format ? ['--format', format] : [])],
      { env, cwd: service.paths.home, windowsHide: true });
    assert.equal(stderr, '');
    if (format === 'json') assert.deepEqual(JSON.parse(stdout), json);
    else assert.equal(stdout, formatResults(json, { ansi: 'ansi', ascii: 'text', md: 'markdown' }[format ?? 'ansi']).output);
  }
  const cached = await run(['--cached-only'], env, { cwd: service.paths.home });
  assert.equal(cached.results.length, 2);
  assert.ok(cached.results.every(result => !Object.hasOwn(result, 'refreshStatus')));
});

test('non-query CLI commands and projected pages support all formats without losing fields or changing cache data', async t => {
  const { service, env } = await fixture(t);
  service.query = async () => ({ items: [testItem({ kind: 'pr', title: 'Synthetic metadata output' })], truncated: false });
  await service.setProfile('reviews', { refreshSeconds: 300, queries: { requested: profile } });
  await service.setProfile('public', { ...profile, auth: 'anonymous' });
  await service.get('reviews');
  const cachePath = service.cachePath('reviews', 'requested');
  const before = await readFile(cachePath);
  const cases = [
    [['config', 'show'], 'reviews'],
    [['config', 'validate'], 'valid'],
    [['profile', 'list'], 'reviews'],
    [['profile', 'get', 'reviews'], 'requested'],
    [['query', 'get', 'reviews', 'requested'], 'owner/repo'],
    [['cache', 'status', 'reviews'], 'requested'],
    [['logs', 'path'], 'path'],
    [['logs', 'tail', '--lines', '1'], 'logs'],
    [['hello'], 'capabilities'],
    [['doctor', 'public'], 'checks'],
    [['native-manifest', '--extension-id', 'a'.repeat(32), '--launcher', 'C:\\DevDash\\host.cmd'], 'origins'],
    [['get', 'reviews', '--query', 'requested', '--cached-only', '--page-size', '1', '--fields', 'title'], 'Synthetic metadata output'],
    [['refresh', 'reviews', '--query', 'requested', '--background', '--due'], 'fresh'],
  ];
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    for (const [args, expected] of cases) {
      const { stdout, stderr } = await execute(process.execPath, [cli, ...args, '--format', format], { env, windowsHide: true });
      assert.equal(stderr, '', `${args}: ${format}`);
      if (format === 'json') assert.ok(JSON.parse(stdout));
      else {
        assert.equal(stdout.includes('\x1b['), format === 'ansi');
        assert.ok(stdout.includes(expected), `${args}: ${format}: ${stdout}`);
        assert.ok(!stdout.includes('undefined'));
      }
    }
  }
  assert.deepEqual(await readFile(cachePath), before);
});

test('default ANSI initialization persists configuration and fatal errors honor the selected format', async t => {
  const { service, env } = await fixture(t);
  const initialized = await execute(process.execPath, [cli, 'init'], { env, windowsHide: true });
  assert.equal(initialized.stderr, '');
  assert.ok(initialized.stdout.includes('\x1b['));
  assert.equal((await service.config()).version, 1);
  for (const format of [undefined, 'json', 'ansi', 'ascii', 'md']) {
    const args = [cli, '--unknown', ...(format ? ['--format', format] : [])];
    const result = await nativeProcess(process.execPath, args, '', env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    if (format === 'json') assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    else {
      assert.ok(result.stderr.includes(format === 'md' ? 'INVALID\\_ARGUMENT' : 'INVALID_ARGUMENT'));
      assert.equal(result.stderr.includes('\x1b['), (format ?? 'ansi') === 'ansi');
    }
  }
  for (const args of [['--pretty=invalid'], ['--home'], ['--config']]) {
    const result = await nativeProcess(process.execPath, [cli, '--format', 'json', ...args], '', env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  }
});

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

test('explicit JSON CLI initialization, profiles, cached reads, status and cleanup preserve machine contracts', async (t) => {
  const { service, env } = await fixture(t);
  assert.equal((await run(['--version'], env)).version, '0.1.0');
  assert.equal((await run(['init'], env)).schemaVersion, 1);
  await service.setProfile('prs', profile);
  await service.get('prs');
  assert.ok((await run(['profile', 'list'], env)).profiles.some(profile => profile.name === 'prs'));
  assert.equal((await run(['get', 'prs', '--cached-only'], env)).fromCache, true);
  assert.equal((await run(['get', 'prs'], env)).fromCache, true);
  assert.equal((await run(['cache', 'status', 'prs'], env)).count, 0);
  assert.equal((await run(['cache', 'clear', 'prs'], env)).cleared, 'prs');
  assert.equal((await run(['profile', 'remove', 'prs'], env)).removed, 'prs');
  assert.deepEqual((await run(['profile', 'list'], env)).profiles.map(profile => profile.name), ['github', 'ado', 'chromium']);
});

test('get formats selected, grouped and all cached query results with ANSI as the default', async t => {
  const { service, env } = await fixture(t);
  service.query = async () => ({ items: [testItem({ kind: 'pr', title: 'Synthetic format integration' })], truncated: false });
  await service.setProfile('reviews', { refreshSeconds: 300, queries: { authored: profile, requested: profile } });
  await service.get('reviews');
  for (const selector of [['reviews', '--query', 'authored'], ['reviews'], ['--all']]) {
    const args = ['get', ...selector, '--cached-only'];
    const json = await run(args, env);
    const defaultOutput = await execute(process.execPath, [cli, ...args], { env, windowsHide: true });
    assert.equal(defaultOutput.stdout, formatResults(json, 'ansi').output);
    for (const [format, renderer] of [['ansi', 'ansi'], ['ascii', 'text'], ['md', 'markdown']]) {
      const { stdout, stderr } = await execute(process.execPath, [cli, ...args, `--format=${format}`], { env, windowsHide: true });
      assert.equal(stderr, '');
      assert.equal(stdout, formatResults(json, renderer).output);
      if (format === 'ansi') {
        assert.ok(stdout.includes('\u256d\u2500'));
        assert.ok(stdout.includes('\ue0b6'));
        assert.match(stdout, /\u2570\u2500+\u256f/);
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
    ['--help', '--pretty'],
  ]) {
    const result = await nativeProcess(process.execPath, [cli, ...args], '', env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.ok(result.stderr.includes('INVALID_ARGUMENT'));
  }
  const host = await nativeProcess(process.execPath, [cli, 'native-host', '--format', 'ansi'], '', env);
  assert.equal(host.code, 1);
  assert.equal(JSON.parse(host.stderr).error.code, 'INVALID_ARGUMENT');
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
      theme: 'half-block',
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

test('named user themes render existing cached results without changing JSON or cache bytes', async t => {
  const { env, service } = await fixture(t);
  service.query = async () => ({ items: [testItem({ kind: 'pr', title: 'Synthetic theme selection' })], truncated: false });
  await service.setProfile('reviews', profile);
  await service.get('reviews');
  const snapshot = await service.get('reviews', { cachedOnly: true });
  const before = await readFile(service.cachePath('reviews'));
  const args = ['get', 'reviews', '--cached-only'];
  for (const theme of Object.keys(presentationThemes)) {
    const presentation = { theme, ansi: { table: { status: {
      labels: { OPEN: '\u{1f513}' }, background: '#123456', left: '[', right: ']', padding: 0,
    } } } };
    await writeFile(service.paths.userConfig, JSON.stringify({ version: 1, presentation }));
    const result = await execute(process.execPath, [cli, ...args, '--format', 'ansi'], { env, windowsHide: true });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, formatResults(snapshot, 'ansi', { presentation }).output);
    assert.ok(result.stdout.includes('\u{1f513}'));
    assert.deepEqual(await run(args, env), snapshot);
    assert.deepEqual(await readFile(service.cachePath('reviews')), before);
  }
});

test('invalid presentation fails human output before provider access but cannot corrupt explicit JSON or native results', async t => {
  const { env, service } = await fixture(t);
  await service.setProfile('reviews', profile);
  await service.get('reviews');
  await writeFile(service.paths.userConfig, JSON.stringify({
    version: 1, presentation: { ansi: { table: { header: { foreground: 'p:SECRET_MISSING_COLOR' } } } },
  }));
  const result = await nativeProcess(process.execPath, [cli, 'refresh', 'reviews', '--format', 'ansi'], '', env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.ok(result.stderr.includes('INVALID_PRESENTATION'));
  assert.ok(!result.stderr.includes('SECRET_MISSING_COLOR'));
  assert.equal((await run(['get', 'reviews', '--cached-only'], env)).fromCache, true);
  for (const table of [{ border: { left: '\x1b[31m' } }, { border: { right: '\u754c' } }, { padding: 99 }]) {
    await writeFile(service.paths.userConfig, JSON.stringify({ version: 1, presentation: { ansi: { table } } }));
    const invalidGeometry = await nativeProcess(process.execPath, [cli, 'refresh', 'reviews', '--format', 'ansi'], '', env);
    assert.equal(invalidGeometry.code, 1);
    assert.equal(invalidGeometry.stdout.length, 0);
    assert.ok(invalidGeometry.stderr.includes('INVALID_PRESENTATION'));
  }
  const nativeResult = await nativeProcess(process.execPath, [native], frameMessage({
    command: 'get', profile: 'reviews', cachedOnly: true,
  }), env);
  assert.equal(nativeResult.code, 0);
  assert.equal(nativeResult.stderr, '');
  assert.equal(JSON.parse(nativeResult.stdout.subarray(4)).fromCache, true);
  const missing = await nativeProcess(process.execPath, [cli, 'get', 'reviews', '--cached-only', '--format', 'md',
    '--user-config', join(service.paths.home, 'missing.json')], '', env);
  assert.ok(missing.stderr.includes('INVALID\\_PRESENTATION'));
});

test('format command defaults to ANSI and detects nested failures without relying on aggregate counters', async t => {
  const { env } = await fixture(t);
  const document = { queries: {
    good: { items: [testItem()], truncated: false },
    bad: { error: { code: 'CLI_FAILED', message: 'Synthetic provider failure.' } },
  } };
  const result = await nativeProcess(process.execPath, [cli, 'format'], JSON.stringify(document), env);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.toString(), formatResults(document, 'ansi').output);
  const json = await nativeProcess(process.execPath, [cli, 'format', '--format', 'json'], JSON.stringify(document), env);
  assert.deepEqual(JSON.parse(json.stdout), document);
  const invalid = await nativeProcess(process.execPath, [cli, 'format'], '{"PRIVATE_INPUT":', env);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout.length, 0);
  assert.ok(invalid.stderr.includes('INVALID_INPUT'));
  assert.ok(!invalid.stderr.includes('PRIVATE_INPUT'));
});

test('watch emits ANSI by default and retains explicit JSON-lines events', async t => {
  const { service, env, home } = await fixture(t);
  await service.setProfile('reviews', profile);
  await writeFile(service.paths.userConfig, JSON.stringify({
    version: 1, presentation: {
      ansi: { table: { header: { background: '#344556' } } }, md: { headingLevel: 4 },
    },
  }));
  // An empty PATH makes provider failure deterministic without running gh or contacting a provider.
  const isolated = { ...env, PATH: home, Path: home };
  for (const format of [undefined, 'json', 'ansi', 'ascii', 'md']) {
    const selected = format ?? 'ansi';
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'watch', 'reviews', '--interval', '86400',
        ...(format === undefined ? [] : ['--format', format])], {
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
      assert.equal(result.stdout.includes('\u256d\u2500'), selected === 'ansi');
      if (selected === 'ansi') assert.ok(result.stdout.includes('\x1b[0;48;2;52;69;86;'));
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
    await assert.rejects(execute(process.execPath, [cli, ...args, '--format', 'json'], { env, windowsHide: true }), (error) => {
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
  assert.deepEqual((await service.list()).profiles.map(profile => profile.name).sort(),
    ['ado', 'chromium', 'github', 'one', 'three', 'two']);
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
  await assert.rejects(execute(process.execPath, [cli, 'get', 'missing', '--format', 'json'], { env, windowsHide: true }), (error) => {
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
  await assert.rejects(execute(process.execPath, [cli, 'init', '--format', 'json'], { env, windowsHide: true }), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'LOG_WRITE_FAILED');
    return true;
  });
  await assert.rejects(execute(process.execPath, [cli, '--unknown', '--format', 'json'], { env, windowsHide: true }), (error) => {
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
  await assert.rejects(execute(process.execPath, [cli, 'get', 'edge', '--cached-only', '--format', 'json'], {
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
  await assert.rejects(execute(process.execPath, [cli, 'get', '--all', '--cached-only', '--format', 'json'], {
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
