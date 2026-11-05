import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { DevDashError } from './errors.js';

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value === null) throw new Error('Expected a JSON object, not null.');
    return value;
  } catch {
    throw new DevDashError('INVALID_JSON', `Invalid JSON object in ${path}.`);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withLock(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let compromised;
  let release;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 30000,
      update: 5000,
      retries: { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 },
      onCompromised: (error) => { compromised = error; },
    });
  } catch (error) {
    if (error.code === 'ELOCKED') {
      throw new DevDashError('BUSY', `Another DevDash process is using ${path}; retry shortly.`);
    }
    throw error;
  }
  try {
    const result = await action(() => {
      if (compromised) {
        throw new DevDashError('LOCK_LOST', `Lock lost for ${path}: ${compromised.message}`);
      }
    });
    if (compromised) throw new DevDashError('LOCK_LOST', `Lock lost for ${path}.`);
    return result;
  } finally {
    if (!compromised) await release();
  }
}
