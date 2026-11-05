import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumProcessFailure, processFailureDetails, resolveWindowsCr, runJson, runText } from '../src/process.js';

test('external process arguments preserve shell metacharacters without execution', async () => {
  const argument = '& echo injected %PATH% $(touch nope) "quoted"';
  const result = await runJson(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', argument]);
  assert.deepEqual(result, [argument]);
});

test('malformed JSON, missing CLI and timeout are explicit errors', async () => {
  await assert.rejects(runJson(process.execPath, ['-e', 'console.log("bad")']), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(runText('devdash-nonexistent-test-command-629235', []), { code: 'CLI_NOT_FOUND' });
  await assert.rejects(runText(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 100 }), { code: 'CLI_FAILED' });
});

test('process stderr and invalid provider responses do not leak secrets', async () => {
  await assert.rejects(runText(process.execPath, ['-e', 'console.error("SECRET_TOKEN");process.exit(1)']), (error) => {
    assert.equal(error.code, 'CLI_FAILED');
    assert.equal(error.message.includes('SECRET_TOKEN'), false);
    return true;
  });
});

test('process diagnostics classify common failures without copying stderr or secret values', () => {
  for (const [stderr, reason, httpStatus] of [
    ['HTTP 401 Bad credentials: SECRET_TOKEN', 'authentication', 401],
    ['HTTP 403 Forbidden: SECRET_TOKEN', 'permission', 403],
    ['HTTP 429 rate limit exceeded SECRET_TOKEN', 'rate-limit', 429],
    ['TF401232: Invalid query contains SECRET_QUERY', 'invalid-query', undefined],
    ['Unexpected server failure SECRET_TOKEN', 'exit', undefined],
  ]) {
    const details = processFailureDetails({ code: 1, stderr });
    assert.equal(details.reason, reason);
    assert.equal(details.httpStatus, httpStatus);
    assert.equal(details.code, 'CLI_FAILED');
    assert.equal(JSON.stringify(details).includes('SECRET'), false);
  }
  assert.equal(processFailureDetails({ killed: true, stderr: 'HTTP 403' }).reason, 'timeout');
  assert.equal(processFailureDetails({ code: 'ENOENT' }).reason, 'not-found');
  assert.equal(processFailureDetails({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }).reason, 'output-limit');
});

async function npmCrFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash cr shim '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'node_modules', '@devdash', 'cr');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@devdash/cr', type: 'module', bin: { cr: 'bin/cr.js' },
  }));
  const script = join(root, 'bin', 'cr.js');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const shim = join(home, 'cr.cmd');
  await writeFile(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@devdash\\cr\\bin\\cr.js" %*\r\n');
  return { home, root, script, shim };
}

test('Windows npm cr shims resolve to Node without a shell and preserve query metacharacters', async (t) => {
  const { home, script } = await npmCrFixture(t);
  const env = { PATH: home };
  const executable = await resolveWindowsCr(env);
  assert.deepEqual(executable, { command: process.execPath, prefix: [script] });
  const args = ['cls', 'list', '--query', '& echo injected %PATH% $(touch nope) "quoted"'];
  const result = process.platform === 'win32'
    ? await runJson('cr', args, { env })
    : await runJson(executable.command, [...executable.prefix, ...args]);
  assert.deepEqual(result, args);
});

test('Windows cr resolution supports npm workspace-relative shims and explicit missing tool errors', async (t) => {
  const { home, script, shim } = await npmCrFixture(t);
  const location = join(home, 'node_modules', '.bin');
  await mkdir(location);
  await writeFile(join(location, 'cr.cmd'), '"%_prog%" "%dp0%\\..\\@devdash\\cr\\bin\\cr.js" %*\r\n');
  assert.deepEqual(await resolveWindowsCr({ PATH: location }), { command: process.execPath, prefix: [script] });
  await rm(shim);
  await assert.rejects(resolveWindowsCr({ PATH: home }), { code: 'CLI_NOT_FOUND' });
});

test('Unrecognized cr launchers and mismatched npm packages are never passed to a shell', async (t) => {
  const { home, root, shim } = await npmCrFixture(t);
  for (const body of ['echo secrets & malicious-command', '"node" "%dp0%\\%INJECTED%\\cr.js" %*']) {
    await writeFile(shim, body);
    await assert.rejects(resolveWindowsCr({ PATH: home }), { code: 'UNSUPPORTED_CR_LAUNCHER' });
  }
  await writeFile(shim, '"%_prog%" "%dp0%\\node_modules\\@devdash\\cr\\bin\\cr.js" %*');
  for (const metadata of [
    { name: 'another-package', bin: { cr: 'bin/cr.js' } },
    { name: '@devdash/cr', bin: { cr: 'different.js' } },
    null,
  ]) {
    await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
    await assert.rejects(resolveWindowsCr({ PATH: home }), { code: 'UNSUPPORTED_CR_LAUNCHER' });
  }
});

test('Structured cr errors preserve only known codes and UUIDs, never child messages or raw diagnostics', () => {
  const diagnosticId = '628940ce-0dea-49cc-acb3-1da801367e32';
  const stderr = JSON.stringify({ error: {
    code: 'BUG_ACCESS_DENIED', message: 'SECRET_TOKEN private bug contents', diagnosticId,
  } });
  const failure = chromiumProcessFailure({ code: 1, stderr });
  assert.equal(failure.code, 'BUG_ACCESS_DENIED');
  assert.equal(failure.diagnosticId, diagnosticId);
  assert.equal(failure.message.includes('SECRET'), false);
  for (const error of [
    { code: 1, stderr: 'SECRET_TOKEN' }, { code: 1, stderr: JSON.stringify({ error: { code: 'SECRET_TOKEN' } }) },
    { code: 1, stderr: '[]' }, { code: 1, stderr: 'null' }, { code: 1, stderr: '{}' },
    { code: 1, stderr, killed: true }, { code: 'ENOENT', stderr },
    { code: 1, stderr: 'x'.repeat(1024 * 1024 + 1) },
  ]) {
    assert.equal(chromiumProcessFailure(error), undefined);
  }
  const invalidId = chromiumProcessFailure({
    code: 1, stderr: JSON.stringify({ error: { code: 'BUG_NOT_FOUND', diagnosticId: 'SECRET_TOKEN' } }),
  });
  assert.equal(invalidId.diagnosticId, undefined);
});

test('Real cr subprocess failure maps structured child codes without exposing stderr on Windows', async (t) => {
  const { home, script } = await npmCrFixture(t);
  const diagnosticId = '628940ce-0dea-49cc-acb3-1da801367e32';
  await writeFile(script, `console.error(JSON.stringify({error:{code:'BUG_NOT_FOUND',message:'SECRET_TOKEN',diagnosticId:'${diagnosticId}'}}));process.exit(1)`);
  if (process.platform === 'win32') {
    await assert.rejects(runJson('cr', ['bugs', 'view', '1'], { env: { PATH: home } }), error =>
      error.code === 'BUG_NOT_FOUND' && error.diagnosticId === diagnosticId && !error.message.includes('SECRET'));
  } else {
    await assert.rejects(runText(process.execPath, [script]), { code: 'CLI_FAILED' });
  }
});
