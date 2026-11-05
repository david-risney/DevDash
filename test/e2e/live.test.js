import test from 'node:test';
import { readLiveConfig, runLiveSuite } from '../helpers/live-e2e.js';

test('opt-in authenticated provider-to-CLI-to-cache-to-native end-to-end suite', {
  skip: process.env.DEVDASH_LIVE_E2E !== '1',
  timeout: 60 * 60 * 1000,
}, async t => {
  const config = await readLiveConfig(process.env.DEVDASH_E2E_CONFIG);
  const report = await runLiveSuite(config);
  for (const check of report.checks) t.diagnostic(`${check.provider}/${check.resource}: passed`);
});
