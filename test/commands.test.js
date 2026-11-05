import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { executeCommand, validateWatch } from '../src/commands.js';
import { DevDash } from '../src/service.js';
import { DevDashError } from '../src/errors.js';
import { testItem } from './helpers/test-provider.js';

const profile = { provider: 'github', resource: 'bugs', repository: 'owner/repo', refreshSeconds: 300 };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-command-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = new DevDash({ home }, {
    queryProfile: async () => ({ items: [], truncated: false }),
  });
  return { home, service };
}

test('help and version do not require configuration', async () => {
  assert.equal((await executeCommand([])).output.name, 'devdash');
  assert.equal((await executeCommand(['--help'])).exitCode, 0);
  assert.deepEqual((await executeCommand(['--version'])).output, { name: 'devdash', version: '0.1.0' });
});

test('commands support profile JSON files and stdin including PowerShell BOM', async (t) => {
  const { home, service } = await fixture(t);
  const file = join(home, 'profile.json');
  await writeFile(file, `\uFEFF${JSON.stringify(profile)}`);
  const dependency = { service };
  await executeCommand(['profile', 'set', 'bugs', '--file', file], dependency);
  await executeCommand(['profile', 'set', 'other', '--file', '-'], {
    service, stdin: Readable.from([JSON.stringify(profile)]),
  });
  assert.equal((await executeCommand(['profile', 'list'], dependency)).output.profiles.length, 2);
  assert.equal((await executeCommand(['profile', 'get', 'bugs'], dependency)).output.profile.limit, 1000);
  assert.equal((await executeCommand(['config', 'show'], dependency)).output.version, 1);
  assert.equal((await executeCommand(['config', 'validate'], dependency)).output.valid, true);
  const first = await executeCommand(['refresh', 'bugs'], dependency);
  assert.equal(first.output.fromCache, false);
  assert.equal((await executeCommand(['get', '--all', '--cached-only'], dependency)).exitCode, 2);
  assert.equal((await executeCommand(['get', '--all'], dependency)).exitCode, 0);
  assert.equal((await executeCommand(['cache', 'status', '--all'], dependency)).output.results.length, 2);
  await executeCommand(['cache', 'clear', '--all'], dependency);
  await executeCommand(['profile', 'remove', 'other'], dependency);
  assert.equal((await service.list()).profiles.length, 1);
});

test('batch failures have exit 2 and single failures throw', async (t) => {
  const { service } = await fixture(t);
  await service.setProfile('bugs', profile);
  service.query = async () => { throw new DevDashError('CLI_FAILED', 'Not authenticated.'); };
  const result = await executeCommand(['refresh', '--all'], { service });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.results[0].error.code, 'CLI_FAILED');
  await assert.rejects(executeCommand(['refresh', 'bugs'], { service }), { code: 'CLI_FAILED' });
});

test('refresh output selection preserves refresh semantics and structured command results', async t => {
  const { service } = await fixture(t);
  await service.setProfile('bugs', profile);
  let queries = 0;
  service.query = async () => {
    queries++;
    return { items: [testItem()], truncated: false };
  };
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    const result = await executeCommand(['refresh', 'bugs', '--format', format], { service });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.fromCache, false);
    assert.equal(result.output.items[0].id, '1');
  }
  assert.equal(queries, 4);
  for (const format of ['json', 'ansi', 'ascii', 'md']) {
    assert.equal(validateWatch(['watch', 'bugs', '--format', format]).values.format, format);
  }
});

test('invalid arguments never silently change behavior', async (t) => {
  const { service } = await fixture(t);
  for (const args of [
    ['bogus'], ['init', '--all'], ['profile', 'list', 'extra'], ['profile', 'set', 'name'],
    ['get'], ['get', 'name', '--all'], ['get', 'name', '--due'], ['refresh', 'name', '--cached-only'],
    ['cache', 'status'], ['config', 'wrong'], ['watch', '--interval', '0'], ['watch', '--all'],
    ['watch', 'one', 'two'], ['get', '--unknown'],
  ]) {
    const operation = args[0] === 'watch' ? () => validateWatch(args) : () => executeCommand(args, { service });
    await assert.rejects(async () => operation(), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(validateWatch(['watch']).interval, 1);
  assert.equal(validateWatch(['watch', 'one', '--interval', '5']).interval, 5);
});

test('malformed and excessively large profile input is explicitly rejected', async (t) => {
  const { service } = await fixture(t);
  for (const [input, code] of [['bad json', 'INVALID_JSON'], ['x'.repeat(1024 * 1024 + 1), 'INPUT_TOO_LARGE']]) {
    await assert.rejects(executeCommand(['profile', 'set', 'bugs', '--file', '-'], {
      service, stdin: Readable.from([input]),
    }), { code });
  }
});

test('format rejects oversized result input without echoing it or requiring configuration', async t => {
  const { service } = await fixture(t);
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  await assert.rejects(executeCommand(['format', '--format', 'ansi'], {
    service, stdin: Readable.from(Array(33).fill(chunk)),
  }), error => error.code === 'INVALID_INPUT' && error.message.includes('32 MiB') && !error.message.includes('xxxx'));
  const records = (await service.diagnostics.tail({ errorsOnly: true })).entries;
  assert.ok(records.some(record => record.command === 'format' && record.code === 'INVALID_INPUT'));
  assert.ok(!JSON.stringify(records).includes('xxxx'));
});

test('UTF-8 profile query characters survive split stdin chunks', async (t) => {
  const { service } = await fixture(t);
  const query = 'label:"caf\u00e9"';
  const bytes = Buffer.from(JSON.stringify({ ...profile, query }));
  const split = bytes.indexOf(Buffer.from('\u00e9')) + 1;
  await executeCommand(['profile', 'set', 'bugs', '--file', '-'], {
    service, stdin: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
  });
  assert.equal((await service.profile('bugs')).query, query);
});

test('doctor reports dependency errors without requiring or changing auth', async (t) => {
  const { service } = await fixture(t);
  const result = await executeCommand(['doctor'], {
    service,
    runText: async () => 'gh version',
    runJson: async (command, args) => {
      if (command === 'cr') return { name: 'cr', version: '0.1.0' };
      if (args[0] === 'extension') throw new DevDashError('CLI_FAILED', 'Extension missing.');
      return { 'azure-cli': '2.0' };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.checks[0].available, true);
  assert.equal(result.output.checks[2].error.code, 'CLI_FAILED');
  assert.deepEqual(result.output.checks[3], { name: 'cr', available: true });
});

test('doctor rejects malformed cr version responses and reports missing cr independently', async (t) => {
  const { service } = await fixture(t);
  for (const response of [{ version: '0.1.0' }, { name: 'cr' }, new DevDashError('CLI_NOT_FOUND', 'cr missing.')]) {
    const result = await executeCommand(['doctor'], {
      service, runText: async () => '',
      runJson: async command => {
        if (command !== 'cr') return {};
        if (response instanceof Error) throw response;
        return response;
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.failed, 1);
    assert.equal(result.output.checks[3].error.code,
      response instanceof Error ? 'CLI_NOT_FOUND' : 'INVALID_PROVIDER_RESPONSE');
  }
});

test('logs commands expose persistent diagnostic paths and bounded recent errors as JSON', async (t) => {
  const { service } = await fixture(t);
  await service.setProfile('bugs', profile);
  service.query = async () => { throw new DevDashError('CLI_FAILED', 'SECRET_PROVIDER_ERROR'); };
  await assert.rejects(executeCommand(['get', 'bugs'], { service }), { code: 'CLI_FAILED' });
  const location = await executeCommand(['logs', 'path'], { service });
  assert.equal(location.output.maxFiles, 5);
  assert.match(location.output.file, /devdash\.jsonl$/);
  const tail = await executeCommand(['logs', 'tail', '--errors', '--lines', '5'], { service });
  assert.ok(tail.output.entries.length > 0);
  assert.ok(tail.output.entries.every((entry) => entry.level === 'error'));
  assert.equal(JSON.stringify(tail.output).includes('SECRET_PROVIDER_ERROR'), false);
  for (const args of [['logs', 'tail', '--lines', '0'], ['logs', 'path', '--lines', '5'], ['logs', 'wrong']]) {
    await assert.rejects(executeCommand(args, { service }), { code: 'INVALID_ARGUMENT' });
  }
});
