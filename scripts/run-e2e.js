import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLiveConfig } from '../test/helpers/live-e2e.js';

try {
  const { values, positionals } = parseArgs({
    options: { config: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true,
  });
  if (values.help) {
    console.log(JSON.stringify({
      usage: 'npm run test:e2e -- --config <private-local-config.json>',
      prerequisites: 'Authenticate gh/az yourself; install cr and its browser for selected Chromium queries. Every query requires limit: 1-10.',
      privacy: 'Config and result contents are never printed. Only read-only provider requests are made; temporary test data is removed.',
    }));
  } else {
    if (!values.config || positionals.length) throw new Error('CONFIG_REQUIRED');
    const config = resolve(values.config);
    await readLiveConfig(config);
    const child = spawn(process.execPath, ['--test', fileURLToPath(new URL('../test/e2e/live.test.js', import.meta.url))], {
      shell: false, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, DEVDASH_LIVE_E2E: '1', DEVDASH_E2E_CONFIG: config },
    });
    child.on('error', () => {
      console.error(JSON.stringify({ error: { code: 'E2E_START', message: 'Cannot start the live test runner.' } }));
      process.exitCode = 1;
    });
    child.on('close', code => { process.exitCode = code ?? 1; });
  }
} catch {
  console.error(JSON.stringify({ error: {
    code: 'E2E_CONFIG',
    message: 'Supply a valid private local configuration with explicit query limits of 1-10. Run npm run test:e2e -- --help. No live queries were started.',
  } }));
  process.exitCode = 1;
}
