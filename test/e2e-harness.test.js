import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevDash } from '../src/service.js';
import { executeCommand } from '../src/commands.js';
import { DevDashError } from '../src/errors.js';
import { preflight, readLiveConfig, runLiveSuite, safeFailure, safeCliFailure } from './helpers/live-e2e.js';
import { createTestProvider, testItem } from './helpers/test-provider.js';

const execute = promisify(execFile);
const base = { provider: 'github', resource: 'bugs', repository: 'example/repo', refreshSeconds: 60, limit: 2 };
const config = { version: 1, profiles: { privateName: base } };

test('live CLI errors retain only allowlisted codes from grouped stdout without leaking private results', () => {
  const grouped = JSON.stringify({ queries: {
    privateQuery: { items: [{ title: 'SECRET_RESULT' }] },
    blocked: { error: { code: 'GITHUB_SSO_REQUIRED', message: 'SECRET_AUTH_URL' } },
  } });
  assert.equal(safeCliFailure(grouped, ''), 'GITHUB_SSO_REQUIRED');
  for (const text of ['SECRET_RESULT', 'null', '[]', '{}', JSON.stringify({ error: { code: 'SECRET_RESULT' } }),
    'x'.repeat(1024 * 1024 + 1)]) assert.equal(safeCliFailure(text, text), 'PROVIDER_FAILURE');
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-e2e-harness-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'devdash.e2e.local.json');
  await writeFile(path, JSON.stringify(config));
  return { home, path };
}

test('live config requires bounded explicit limits and never prints private scopes on malformed input', async t => {
  const { path } = await fixture(t);
  assert.deepEqual(await readLiveConfig(path), config);
  for (const content of [
    'SECRET_CONFIG_VALUE', JSON.stringify({ version: 1, profiles: {} }),
    JSON.stringify({ version: 1, profiles: { privateName: { ...base, limit: undefined } } }),
    JSON.stringify({ version: 1, profiles: { privateName: { ...base, limit: 11 } } }),
    'x'.repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(path, content);
    await assert.rejects(readLiveConfig(path), error =>
      error.code === 'E2E_CONFIG' && !error.message.includes('SECRET_CONFIG_VALUE'));
  }
});

test('auth prerequisites probe gh user and explicitly scoped az project without logging in or changing auth', async () => {
  const calls = [];
  const profiles = {
    github: { ...base, hostname: 'git.example.com' },
    ado: { provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/example', project: 'Example', limit: 1 },
    chromium: { provider: 'chromium', resource: 'bugs', bugIds: ['1'], limit: 1 },
  };
  await preflight({ version: 1, profiles }, {
    runProvider: async (command, args) => {
      calls.push({ command, args });
      if (command === 'gh') return { login: 'example-user' };
      if (command === 'az') return { id: 'example-project' };
      if (args[0] === '--version') return { name: 'cr', version: '0.1.0' };
      return { checks: { browser: { status: 'ok' } } };
    },
  });
  assert.ok(calls[0].args.includes('git.example.com'));
  const project = calls.find(call => call.command === 'az' && call.args[1] === 'project');
  assert.ok(project.args.includes('https://dev.azure.com/example'));
  assert.ok(project.args.includes('Example'));
  assert.ok(project.args.includes('--detect'));
  assert.ok(calls.every(call => !call.args.includes('login') && !call.args.includes('add')));
  await assert.rejects(preflight(config, {
    runProvider: async () => { throw new DevDashError('CLI_FAILED', 'SECRET_CREDENTIAL PRIVATE_SCOPE'); },
  }), error => error.code === 'E2E_PREREQUISITE' && !error.message.includes('SECRET_CREDENTIAL'));
  assert.equal(safeFailure({ code: 'SECRET_CODE' }), 'PROVIDER_FAILURE');
});

test('opt-in harness traverses grouped service/filter/cache/native contracts with a test adapter and cleanup', async () => {
  const provider = createTestProvider({ responses: [{ items: [testItem()], truncated: false }] });
  const local = {
    version: 1,
    profiles: {
      PRIVATE_PROFILE: { refreshSeconds: 300, queries: {
        PRIVATE_QUERY: { ...base, filter: { language: 'javascript', expression: 'hasText(item.title, params.text)', params: { text: 'cache' } } },
      } },
    },
  };
  let scratch;
  const operations = [];
  const service = env => {
    scratch = env.DEVDASH_HOME;
    return new DevDash({ home: scratch }, { queryProfile: provider.queryProfile });
  };
  const report = await runLiveSuite(local, {
    runProvider: async () => ({ login: 'example-user' }),
    command: async (args, env) => {
      operations.push(args[0]);
      return (await executeCommand(args, { service: service(env) })).output;
    },
    native: async (request, env) => service(env).get(request.profile, { query: request.query, cachedOnly: request.cachedOnly }),
  });
  assert.equal(report.queries, 1);
  assert.equal(report.failed, 0);
  assert.equal(provider.calls.length, 1);
  assert.ok(operations.includes('init') && operations.includes('refresh') && operations.includes('cache'));
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  await assert.rejects(stat(scratch), { code: 'ENOENT' });
});

test('live harness removes temporary credentials/results after prerequisite or refresh failure', async () => {
  let scratch;
  await assert.rejects(runLiveSuite(config, {
    runProvider: async (command, args, options) => {
      scratch = options.env.DEVDASH_HOME;
      throw new Error('SECRET_PREREQUISITE');
    },
  }), { code: 'E2E_PREREQUISITE' });
  await assert.rejects(stat(scratch), { code: 'ENOENT' });
  await assert.rejects(runLiveSuite(config, {
    runProvider: async () => ({ login: 'example-user' }),
    command: async (args, env) => {
      scratch = env.DEVDASH_HOME;
      if (args[0] === 'refresh') return { failed: 1, error: { message: 'PRIVATE_CONTENT' } };
      return {};
    },
  }), error => error.code === 'E2E_CONTRACT' && !error.message.includes('PRIVATE_CONTENT'));
  await assert.rejects(stat(scratch), { code: 'ENOENT' });
});

test('live harness exercises enriched ADO snapshot presentation as well as cached JSON', async () => {
  const provider = createTestProvider({ provider: 'ado', responses: [{
    items: [testItem({ provider: 'ado', kind: 'pr', providerData: {
      properties: { ReviewMetadata: { $type: 'System.String', $value: '{"ready":true}' } },
    } })], truncated: false,
  }] });
  const service = env => new DevDash({ home: env.DEVDASH_HOME }, { queryProfile: provider.queryProfile });
  const report = await runLiveSuite({ version: 1, profiles: { reviews: {
    provider: 'ado', resource: 'prs', organization: 'https://dev.azure.com/example', project: 'Project',
    refreshSeconds: 300, limit: 1, include: { properties: ['ReviewMetadata'] },
  } } }, {
    runProvider: async () => ({ id: 'synthetic-project' }),
    command: async (args, env) => (await executeCommand(args, { service: service(env) })).output,
    native: async (request, env) => service(env).get(request.profile, { cachedOnly: request.cachedOnly }),
  });
  assert.equal(report.queries, 1);
  assert.equal(report.failed, 0);
  assert.equal(provider.calls.length, 1);
});

test('E2E launcher requires an explicit valid configuration before any real provider requests', async () => {
  const script = fileURLToPath(new URL('../scripts/run-e2e.js', import.meta.url));
  const help = await execute(process.execPath, [script, '--help'], { windowsHide: true });
  assert.equal(JSON.parse(help.stdout).usage.includes('--config'), true);
  for (const args of [[], ['--config', 'not-present-SECRET_PATH.json'], ['--unknown', 'SECRET_VALUE']]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { windowsHide: true }), error => {
      assert.equal(error.stdout, '');
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stderr).error.code, 'E2E_CONFIG');
      assert.equal(error.stderr.includes('SECRET'), false);
      return true;
    });
  }
});
