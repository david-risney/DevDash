import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPublicText, checkPublicFiles } from '../scripts/check-public.js';

const execute = promisify(execFile);

test('public repository candidates contain no detected credentials, private scopes, or private feed URLs', async () => {
  const report = await checkPublicFiles();
  assert.equal(report.failed, 0, 'Public hygiene check failed. Run npm run check:public for file/category metadata, never paste private file contents.');
  assert.ok(report.checked > 0);
});

test('public hygiene scanner reports categories rather than detected credential values', () => {
  const token = ['ghp', '_', 'x'.repeat(36)].join('');
  const findings = inspectPublicText(`token=${token}`);
  assert.deepEqual(findings, ['credential-pattern']);
  assert.equal(JSON.stringify(findings).includes(token), false);
  const privateScope = ['https://dev.azure.com/', 'microsoft', '/project'].join('');
  assert.deepEqual(inspectPublicText(privateScope), ['organization-specific-scope']);
  assert.deepEqual(inspectPublicText('https://dev.azure.com/YOUR-ORG you@example.com'), []);
  const fakeUrl = ['https://', 'user', ':', 'secret', '@example.com'].join('');
  assert.deepEqual(inspectPublicText(fakeUrl), ['credential-pattern']);
  assert.deepEqual(inspectPublicText(fakeUrl, { syntheticFixtures: true }), []);
  assert.deepEqual(inspectPublicText(`${fakeUrl} ${token}`, { syntheticFixtures: true }), ['credential-pattern']);
});

test('git ignores local auth, provider state, and E2E data but keeps sanitized example configurations', async () => {
  const paths = [
    '.npmrc', '.devdash/config.json', '.cr/config.json', 'devdash.e2e.local.json',
    'auth-state/state.json', 'playwright/.auth/state.json', 'playwright-report/index.html', 'test-results/trace.zip',
  ];
  const request = execute('git', ['check-ignore', '--stdin', '-z'], { windowsHide: true, shell: false });
  request.child.stdin.end(`${paths.join('\0')}\0`);
  const { stdout } = await request;
  assert.deepEqual(stdout.split('\0').filter(Boolean), paths);
  await assert.rejects(execute('git', ['check-ignore', 'examples/e2e.config.json'], { windowsHide: true, shell: false }), error => error.code === 1);
});
