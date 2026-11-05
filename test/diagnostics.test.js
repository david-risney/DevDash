import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Diagnostics, diagnosticCode, diagnosticPathsOptions, safeCommand } from '../src/diagnostics.js';
import { DevDashError, errorJson } from '../src/errors.js';
import { paths } from '../src/config.js';
import { runText } from '../src/process.js';

const execute = promisify(execFile);

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-logs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const resolved = paths({ home });
  return { home, paths: resolved, logger: new Diagnostics(resolved, options) };
}

test('JSONL logs persist across logger instances with correlated phases and no raw error data', async (t) => {
  const { logger, paths: resolved } = await fixture(t);
  let caught;
  try {
    await logger.run('command', { command: 'refresh', profile: 'bugs' }, async () => {
      await logger.run('provider.query', { provider: 'chromium', resource: 'bugs' }, async () => {
        await logger.log('chromium.bug.start', {
          phase: 'navigate', bugId: '411731002', query: 'SECRET_QUERY', token: 'SECRET_TOKEN',
          message: 'SECRET_MESSAGE', stack: 'SECRET_STACK', html: 'SECRET_HTML',
        });
        throw new DevDashError('BUG_TIMEOUT', 'SECRET_EXCEPTION');
      });
    });
  } catch (error) { caught = error; }
  const other = new Diagnostics(resolved);
  const { entries } = await other.tail();
  assert.deepEqual(entries.map((entry) => entry.event), [
    'command.start', 'provider.query.start', 'chromium.bug.start', 'provider.query.failed', 'command.failed',
  ]);
  assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 1);
  assert.equal(entries[1].parentSpanId, entries[0].spanId);
  assert.equal(entries[2].spanId, entries[1].spanId);
  assert.equal(entries[3].code, 'BUG_TIMEOUT');
  assert.equal(entries[3].profile, 'bugs');
  assert.equal(entries[3].level, 'error');
  assert.equal(errorJson(caught).error.diagnosticId, entries[0].requestId);
  const text = await readFile(logger.file, 'utf8');
  for (const secret of ['SECRET_QUERY', 'SECRET_TOKEN', 'SECRET_MESSAGE', 'SECRET_STACK', 'SECRET_HTML', 'SECRET_EXCEPTION']) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(text.includes(resolved.config), false);
});

test('logs retain numeric OS/exit diagnostics but never external process stderr or arguments', async (t) => {
  const { logger } = await fixture(t);
  await assert.rejects(logger.run('command', { command: 'doctor' }, () =>
    runText(process.execPath, ['-e', 'console.error("SECRET_PROVIDER_TOKEN");process.exit(42)'])),
  { code: 'CLI_FAILED' });
  const { entries } = await logger.tail({ errorsOnly: true });
  const failure = entries.find((entry) => entry.event === 'process.failed');
  assert.equal(failure.exitCode, 42);
  assert.equal(failure.reason, 'exit');
  assert.equal(failure.operation, 'external');
  assert.equal((await readFile(logger.file, 'utf8')).includes('SECRET_PROVIDER_TOKEN'), false);
});

test('rotation has bounded retention and tail reads newest records across archives', async (t) => {
  const { logger } = await fixture(t, { maxBytes: 800, maxFiles: 3 });
  for (let count = 0; count < 20; count++) await logger.log('test.event', { count });
  const files = await readdir(logger.directory);
  assert.deepEqual(files.sort(), ['devdash.jsonl', 'devdash.jsonl.1', 'devdash.jsonl.2']);
  const { entries } = await logger.tail({ lines: 3 });
  assert.deepEqual(entries.map((entry) => entry.count), [17, 18, 19]);
  assert.ok(files.length <= 3);
  for (const file of files) assert.ok(Buffer.byteLength(await readFile(join(logger.directory, file))) <= 800);
});

test('concurrent processes append complete JSON records without lost writes', async (t) => {
  const { home, logger } = await fixture(t);
  const module = new URL('../src/diagnostics.js', import.meta.url).href;
  const config = new URL('../src/config.js', import.meta.url).href;
  const script = `
    import { Diagnostics } from ${JSON.stringify(module)};
    import { paths } from ${JSON.stringify(config)};
    const logger = new Diagnostics(paths({ home: process.argv[1] }));
    for (let count = 0; count < 4; count++) await logger.log('test.event', { count });
  `;
  await Promise.all([1, 2, 3].map(() =>
    execute(process.execPath, ['--input-type=module', '-e', script, home], { windowsHide: true })));
  assert.equal((await logger.tail()).entries.length, 12);
});

test('tail filters errors and configuration identity, validates limits and rejects damaged records', async (t) => {
  const { logger, paths: resolved } = await fixture(t);
  await logger.log('test.event', { count: 1 });
  await logger.log('test.failed', { code: 'EACCES' });
  const other = new Diagnostics({ ...resolved, config: `${resolved.config}.other` });
  await other.log('test.failed', { code: 'ENOENT' });
  assert.equal((await logger.tail({ errorsOnly: true })).entries.length, 1);
  assert.equal((await other.tail()).entries[0].code, 'ENOENT');
  for (const lines of [0, 1001, 1.5, NaN]) {
    await assert.rejects(logger.tail({ lines }), { code: 'INVALID_ARGUMENT' });
  }
  await writeFile(logger.file, '{invalid');
  await assert.rejects(logger.tail(), { code: 'INVALID_LOG' });
  await writeFile(logger.file, 'null\n');
  await assert.rejects(logger.tail(), { code: 'INVALID_LOG' });
});

test('logging failures are explicit and prevent unlogged operations', async (t) => {
  const { logger, home } = await fixture(t);
  await writeFile(join(home, 'logs'), 'not a directory');
  let ran = false;
  await assert.rejects(logger.run('command', {}, async () => { ran = true; }), { code: 'LOG_WRITE_FAILED' });
  assert.equal(ran, false);
});

test('a failed diagnostic write reports both the logging failure and safe original error code', async (t) => {
  const { logger } = await fixture(t);
  const originalLog = logger.log.bind(logger);
  logger.log = async (event, data) => {
    if (event === 'command.failed') throw new DevDashError('LOG_WRITE_FAILED', 'Disk unavailable.');
    return originalLog(event, data);
  };
  const primary = new DevDashError('BUG_TIMEOUT', 'SECRET_PROVIDER_ERROR');
  await assert.rejects(logger.run('command', { command: 'refresh' }, async () => { throw primary; }), (error) => {
    assert.equal(error.code, 'LOG_WRITE_FAILED');
    assert.equal(error.cause, primary);
    assert.ok(error.message.includes('BUG_TIMEOUT'));
    assert.equal(error.message.includes('SECRET_PROVIDER_ERROR'), false);
    assert.match(error.diagnosticId, /^[a-f0-9-]{36}$/);
    return true;
  });
});

test('unsafe arbitrary values are not emitted as diagnostic codes or command names', () => {
  assert.equal(diagnosticCode(new Error('SECRET')), 'UNEXPECTED_ERROR');
  assert.equal(diagnosticCode({ code: 'SECRET_TOKEN' }), 'UNEXPECTED_ERROR');
  assert.equal(diagnosticCode({ code: 'ENOSPC' }), 'ENOSPC');
  assert.equal(safeCommand(['SECRET_TOKEN']), 'invalid');
  assert.equal(safeCommand(['profile', 'SECRET_TOKEN']), 'profile.invalid');
  assert.equal(safeCommand(['profile', 'set', 'ignored']), 'profile.set');
  assert.deepEqual(diagnosticPathsOptions(['--home', 'test-home', '--config=test.json', '--invalid']), {
    home: 'test-home', config: 'test.json',
  });
  assert.deepEqual(diagnosticPathsOptions(['--', '--home', 'not-an-option']), {});
});
