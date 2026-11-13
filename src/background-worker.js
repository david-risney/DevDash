import { DevDash, selectedQuery } from './service.js';
import { DevDashError } from './errors.js';
import { diagnosticCode } from './diagnostics.js';
import { readJson, withLock, writeJson } from './storage.js';

const startupTimeout = setTimeout(() => { process.exitCode = 1; process.disconnect?.(); }, 15_000);
process.once('message', async request => {
  clearTimeout(startupTimeout);
  const service = new DevDash({ home: request.home, config: request.config });
  let code;
  try {
    const job = await readJson(request.jobPath);
    if (job?.id !== request.id || job.pid !== process.pid) {
      throw new DevDashError('BACKGROUND_START_FAILED', 'The background refresh reservation changed.');
    }
    await new Promise((resolve, reject) => process.send({ ready: request.id }, error => error ? reject(error) : resolve()));
    await service.diagnostics.run('background.refresh', { profile: request.name, queryName: request.queryName }, async () => {
      const definition = selectedQuery(await service.profile(request.name), request.queryName);
      if (service.fingerprint(definition) !== request.fingerprint) {
        throw new DevDashError('PROFILE_CHANGED', 'The query changed before its background refresh started.');
      }
      return service.getQuerySnapshot(request.name, definition, request.queryName, {
        refresh: true, due: !request.force,
        assertReservation: async () => {
          if ((await readJson(request.jobPath))?.id !== request.id) {
            throw new DevDashError('BACKGROUND_CANCELLED', 'The background refresh was cancelled by a cache clear.');
          }
        },
      });
    });
  } catch (error) {
    code = diagnosticCode(error);
    process.exitCode = 1;
    if (!error.diagnosticId && code !== 'LOG_WRITE_FAILED') {
      try { await service.diagnostics.log('background.refresh.failed', { code, profile: request.name, queryName: request.queryName }); }
      catch { code = 'LOG_WRITE_FAILED'; }
    }
  } finally {
    try {
      await withLock(request.jobPath, async checkLock => {
        const job = await readJson(request.jobPath);
        if (job?.id !== request.id) return;
        checkLock();
        await writeJson(request.jobPath, {
          ...job, state: code ? 'failed' : 'complete', ...(code ? { code } : {}),
          finishedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      process.exitCode = 1;
      // The state file itself may be unwritable; use the independent diagnostics sink.
      await service.diagnostics.log('background.state.failed', { code: diagnosticCode(error), profile: request.name, queryName: request.queryName });
    }
  }
});
