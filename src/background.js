import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DevDashError } from './errors.js';
import { readJson, withLock, writeJson } from './storage.js';

export async function readRefreshJob(path) {
  const job = await readJson(path);
  if (job === null) return null;
  if (typeof job !== 'object' || Array.isArray(job) ||
      typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/.test(job.id) ||
      (job.fingerprint !== undefined && (typeof job.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(job.fingerprint))) ||
      (job.force !== undefined && typeof job.force !== 'boolean') ||
      !['running', 'complete', 'failed'].includes(job.state) ||
      (job.state === 'running' && (!Number.isInteger(job.pid) || job.pid <= 0 ||
        !Number.isFinite(Date.parse(job.startedAt)))) ||
      (job.state !== 'running' && !Number.isFinite(Date.parse(job.finishedAt))) ||
      (job.state === 'failed' && (typeof job.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(job.code)))) {
    throw new DevDashError('INVALID_CACHE', `Invalid background refresh state at ${path}. Clear this query's cache to repair it.`);
  }
  return job;
}

export function workerRunning(job) {
  if (job?.state !== 'running' || !Number.isInteger(job.pid) || job.pid <= 0) return false;
  try {
    process.kill(job.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function scheduleRefresh({ cachePath, paths, name, queryName, fingerprint, force = false }) {
  const jobPath = `${cachePath}.background.json`;
  return withLock(jobPath, async checkLock => {
    const previous = await readRefreshJob(jobPath);
    if (workerRunning(previous) && previous.fingerprint === fingerprint && (!force || previous.force)) {
      return { state: 'running', id: previous.id };
    }
    const id = randomUUID();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./background-worker.js', import.meta.url))], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker startup timed out.')), 10_000);
      const finish = action => value => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        action(value);
      };
      const onMessage = finish(message => message?.ready === id ? resolve() : reject(new Error('Invalid worker handshake.')));
      const onError = finish(reject);
      const onExit = finish(() => reject(new Error('Worker exited before it was ready.')));
      child.once('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    // Handle a spawn failure even if persisting the job also fails.
    ready.catch(() => {});
    try {
      checkLock();
      await writeJson(jobPath, { id, pid: child.pid, fingerprint, force, state: 'running', startedAt: new Date().toISOString() });
      child.send({ id, jobPath, home: paths.home, config: paths.config, name, queryName, fingerprint, force });
      await ready;
      if (child.connected) child.disconnect();
      child.unref();
      return { state: 'scheduled', id };
    } catch (error) {
      child.kill();
      if (child.connected) child.disconnect();
      await writeJson(jobPath, {
        id, fingerprint, force, state: 'failed', code: 'BACKGROUND_START_FAILED', finishedAt: new Date().toISOString(),
      });
      throw new DevDashError('BACKGROUND_START_FAILED', 'Could not start the background refresh. Inspect DevDash diagnostics.', { cause: error });
    }
  });
}
