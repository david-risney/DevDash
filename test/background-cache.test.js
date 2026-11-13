import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DevDash } from '../src/service.js';
import { readJson } from '../src/storage.js';
import { workerRunning } from '../src/background.js';
import { frameMessage } from '../src/native.js';
import { testItem } from './helpers/test-provider.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/devdash.js', import.meta.url));

async function until(action, describe = async () => '') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Synthetic background refresh did not reach the expected state. ${await describe()}`);
}

async function completed(jobPath) {
  const describe = async () => {
    const job = await readJson(jobPath);
    const events = (await readFile(join(jobPath, '..', '..', 'logs', 'devdash.jsonl'), 'utf8'))
      .trim().split('\n').slice(-12).map(line => {
        const { event, code, durationMs } = JSON.parse(line);
        return { event, code, durationMs };
      });
    return JSON.stringify({ state: job?.state, code: job?.code, running: workerRunning(job), events });
  };
  return until(async () => {
    let job = await readJson(jobPath);
    if (job?.state === 'running' && !workerRunning(job)) {
      // The worker can commit completion and exit after the first read.
      job = await readJson(jobPath);
      if (job?.state === 'running') {
        assert.fail(`Synthetic worker exited without publishing a terminal job state. ${await describe()}`);
      }
    }
    assert.notEqual(job?.state, 'failed', `Synthetic worker failed: ${job?.code}`);
    return job?.state === 'complete';
  }, describe);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'devdash background '));
  const home = join(root, 'data');
  await mkdir(home);
  const service = new DevDash({ home, config: join(root, 'query config.json') }, {
    now: () => Date.now() - 2000,
    queryProfile: async () => ({ items: [testItem({ title: 'Cached synthetic result' })], truncated: false }),
  });
  await service.setProfile('bugs', { provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 1 });
  await service.get('bugs');
  service.now = Date.now;
  const jobPath = `${service.cachePath('bugs')}.background.json`;
  t.after(async () => {
    const job = await readJson(jobPath);
    if (Number.isInteger(job?.pid)) {
      if (workerRunning(job)) process.kill(job.pid);
      await until(() => !workerRunning({ ...job, state: 'running' }));
    }
    await rm(root, { recursive: true, force: true });
  });
  const preload = join(root, 'preload.mjs');
  const loader = join(root, 'loader.mjs');
  const provider = join(root, 'provider.mjs');
  await writeFile(preload, `import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));`);
  await writeFile(loader, `
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  return result.url === ${JSON.stringify(new URL('../src/providers.js', import.meta.url).href)}
    ? { url: ${JSON.stringify(pathToFileURL(provider).href)}, shortCircuit: true } : result;
}
`);
  await writeFile(provider, `
import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DevDashError } from ${JSON.stringify(new URL('../src/errors.js', import.meta.url).href)};
const item = ${JSON.stringify(testItem({ title: 'Updated synthetic result' }))};
export const queryWebUrl = () => 'https://example.com/synthetic';
export async function queryProfile() {
  const root = ${JSON.stringify(root)};
  await appendFile(join(root, 'started'), 'query\\n');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { await stat(join(root, 'release')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw new DevDashError('CLI_FAILED', 'Synthetic gate timed out.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const release = await readFile(join(root, 'release'), 'utf8');
  if (release === 'fail') throw new DevDashError('CLI_FAILED', 'SECRET_SYNTHETIC_PROVIDER_OUTPUT');
  return { items: [item], truncated: false };
}
`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const run = async args => {
    const result = await execute(process.execPath, [cli, ...args, '--home', home, '--config', service.paths.config], {
      env, windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const runNative = async request => {
    const execution = execute(process.execPath, [cli, 'native-host', '--home', home, '--config', service.paths.config], {
      env, windowsHide: true, timeout: 30_000, encoding: 'buffer',
    });
    execution.child.stdin.end(frameMessage(request));
    const { stdout, stderr } = await execution;
    assert.equal(stderr.length, 0);
    const size = endianness() === 'LE' ? stdout.readUInt32LE() : stdout.readUInt32BE();
    assert.equal(stdout.length, size + 4);
    return JSON.parse(stdout.subarray(4).toString('utf8'));
  };
  return { root, service, jobPath, run, runNative, preload };
}

test('real detached refresh survives its requesting CLI and coalesces other expired-cache readers', async t => {
  const f = await fixture(t);
  const launches = await Promise.all(Array.from({ length: 2 }, () => f.run(['get', 'bugs', '--cache-mode', 'adaptive'])));
  assert.equal(launches.filter(result => result.refreshStatus === 'scheduled').length, 1);
  assert.equal(launches.filter(result => result.refreshStatus === 'running').length, 1);
  const first = launches.find(result => result.refreshStatus === 'scheduled');
  assert.equal(first.refreshStatus, 'scheduled');
  assert.equal(first.items[0].title, 'Cached synthetic result');
  const job = await readJson(f.jobPath);
  assert.ok(workerRunning(job), 'Worker remains alive after the CLI has exited.');
  await until(async () => {
    try { return await readFile(join(f.root, 'started'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });

  const readers = await Promise.all(Array.from({ length: 3 }, () => f.run(['get', 'bugs', '--cache-mode', 'adaptive'])));
  assert.ok(readers.every(result => result.refreshStatus === 'running' && result.fromCache && result.stale));
  assert.equal(await readFile(join(f.root, 'started'), 'utf8'), 'query\n');
  assert.equal((await f.run(['get', 'bugs', '--cached-only'])).items[0].title, 'Cached synthetic result');
  await writeFile(join(f.root, 'release'), 'success');
  await completed(f.jobPath);
  const updated = await f.run(['get', 'bugs', '--cached-only']);
  assert.equal(updated.items[0].title, 'Updated synthetic result');
  assert.equal((await f.service.cacheStatus('bugs')).refreshTiming.samples, 2);
  assert.equal((await f.service.cacheStatus('bugs')).backgroundRefresh.state, 'complete');
});

test('native adaptive reads preserve framing and their refresh continues after the host closes', async t => {
  const f = await fixture(t);
  const cached = await f.runNative({ command: 'get', profile: 'bugs', cacheMode: 'adaptive', fastQueryMs: 750 });
  assert.equal(cached.refreshStatus, 'scheduled');
  assert.equal(cached.fromCache, true);
  assert.ok(workerRunning(await readJson(f.jobPath)));
  await writeFile(join(f.root, 'release'), 'success');
  await completed(f.jobPath);
  const updated = await f.runNative({ command: 'get', profile: 'bugs', cachedOnly: true });
  assert.equal(updated.items[0].title, 'Updated synthetic result');
});

test('native cold refresh jobs return before provider completion and survive closing the host', async t => {
  const f = await fixture(t);
  await f.service.clearCache('bugs');
  const started = await f.runNative({ command: 'refresh-start', profile: 'bugs' });
  assert.equal(started.cached, false);
  assert.equal(started.refreshStatus, 'scheduled');
  assert.match(started.jobId, /^[0-9a-f-]{36}$/);
  const running = await f.runNative({ command: 'status', profile: 'bugs' });
  assert.equal(running.backgroundRefresh.id, started.jobId);
  assert.equal(running.backgroundRefresh.state, 'running');
  assert.ok(workerRunning(await readJson(f.jobPath)));
  await writeFile(join(f.root, 'release'), 'success');
  await completed(f.jobPath);
  const finished = await f.runNative({ command: 'status', profile: 'bugs' });
  assert.equal(finished.cached, true);
  assert.match(finished.cacheRevision, /^[a-f0-9]{64}$/);
  assert.equal((await f.runNative({ command: 'get', profile: 'bugs', cachedOnly: true })).items[0].title, 'Updated synthetic result');
});

test('due jobs skip fresh caches but explicit manual background refreshes still fetch', async t => {
  const f = await fixture(t);
  await f.service.setProfile('bugs', {
    provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 3600,
  });
  await f.service.get('bugs');
  const fresh = await f.run(['refresh', 'bugs', '--background', '--due']);
  assert.equal(fresh.refreshStatus, 'fresh');
  assert.equal(fresh.jobId, null);
  assert.equal(await readJson(f.jobPath), null);
  const forced = await f.run(['refresh', 'bugs', '--background']);
  assert.equal(forced.refreshStatus, 'scheduled');
  await until(async () => {
    try { return await readFile(join(f.root, 'started'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  await writeFile(join(f.root, 'release'), 'success');
  await completed(f.jobPath);
  assert.equal((await f.run(['get', 'bugs', '--cached-only'])).items[0].title, 'Updated synthetic result');
});

test('background provider errors preserve cache bytes and are visible in status and redacted diagnostics', async t => {
  const f = await fixture(t);
  const before = await readFile(f.service.cachePath('bugs'), 'utf8');
  assert.equal((await f.run(['get', 'bugs', '--cache-mode', 'adaptive'])).refreshStatus, 'scheduled');
  await writeFile(join(f.root, 'release'), 'fail');
  await until(async () => (await readJson(f.jobPath))?.state === 'failed');
  assert.equal(await readFile(f.service.cachePath('bugs'), 'utf8'), before);
  const status = await f.service.cacheStatus('bugs');
  assert.equal(status.backgroundRefresh.state, 'failed');
  assert.equal(status.backgroundRefresh.code, 'CLI_FAILED');
  const records = (await f.service.diagnostics.tail({ errorsOnly: true })).entries;
  assert.ok(records.some(record => record.event === 'background.refresh.failed' && record.code === 'CLI_FAILED'));
  assert.ok(!JSON.stringify(records).includes('SECRET_SYNTHETIC'));
});

test('detached refresh evaluates JavaScript filters with params and cache-only reads keep their snapshot', async t => {
  const f = await fixture(t);
  await f.service.setProfile('bugs', {
    provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 1,
    filter: { language: 'javascript', expression: 'hasText(item.title, params.text)', params: { text: 'updated' } },
  });
  f.service.now = () => Date.now() - 2000;
  assert.deepEqual((await f.service.get('bugs')).items, []);
  f.service.now = Date.now;
  const scheduled = await f.run(['get', 'bugs', '--cache-mode', 'adaptive']);
  assert.equal(scheduled.refreshStatus, 'scheduled');
  assert.deepEqual(scheduled.items, []);
  await writeFile(join(f.root, 'release'), 'success');
  await completed(f.jobPath);
  const refreshed = await f.runNative({ command: 'get', profile: 'bugs', cachedOnly: true });
  assert.equal(refreshed.items[0].title, 'Updated synthetic result');
});

test('foreground native and CLI refreshes evaluate JavaScript filters and return redacted failures', async t => {
  const f = await fixture(t);
  const definition = {
    provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 300,
    filter: { language: 'javascript', expression: 'hasText(item.title, params.text)', params: { text: 'updated' } },
  };
  await f.service.setProfile('bugs', definition);
  await writeFile(join(f.root, 'release'), 'success');
  const fresh = await f.runNative({ command: 'get', profile: 'bugs' });
  assert.equal(fresh.fromCache, false);
  assert.equal(fresh.items[0].title, 'Updated synthetic result');
  assert.equal((await f.run(['refresh', 'bugs'])).items[0].title, 'Updated synthetic result');
  await f.service.setProfile('bugs', {
    ...definition, filter: { language: 'javascript', expression: '(() => { throw new Error("SECRET_FILTER_VALUE"); })()' },
  });
  const failure = await f.runNative({ id: 'js-failed', command: 'get', profile: 'bugs' });
  assert.equal(failure.id, 'js-failed');
  assert.equal(failure.error.code, 'FILTER_FAILED');
  assert.equal(JSON.stringify(failure).includes('SECRET_FILTER_VALUE'), false);
});

test('configuration edits during detached refresh prevent an obsolete cache commit', async t => {
  const f = await fixture(t);
  const before = await readFile(f.service.cachePath('bugs'), 'utf8');
  await f.run(['get', 'bugs', '--cache-mode', 'adaptive']);
  await until(async () => {
    try { return await readFile(join(f.root, 'started'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  await f.service.setProfile('bugs', {
    provider: 'github', resource: 'bugs', repository: 'example/changed', refreshSeconds: 1,
  });
  await writeFile(join(f.root, 'release'), 'success');
  await until(async () => (await readJson(f.jobPath))?.state === 'failed');
  assert.equal((await readJson(f.jobPath)).code, 'PROFILE_CHANGED');
  assert.equal(await readFile(f.service.cachePath('bugs'), 'utf8'), before);
  assert.equal((await f.service.cacheStatus('bugs')).cached, false);
});

test('a worker that exits before its handshake causes an explicit startup failure', async t => {
  const f = await fixture(t);
  const before = await readFile(f.service.cachePath('bugs'), 'utf8');
  await writeFile(f.preload, `
if (process.argv[1].endsWith('background-worker.js')) throw new Error('Synthetic startup failure');
`);
  await assert.rejects(f.run(['get', 'bugs', '--cache-mode', 'adaptive']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'BACKGROUND_START_FAILED');
    assert.equal(error.stdout, '');
    return true;
  });
  assert.equal((await readJson(f.jobPath)).code, 'BACKGROUND_START_FAILED');
  assert.equal(await readFile(f.service.cachePath('bugs'), 'utf8'), before);
});
