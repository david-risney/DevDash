import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { DevDashError } from './errors.js';

export async function mapLimit(values, limit, action) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await action(values[index], index);
    }
  }));
  return results;
}

export async function withProviderSlot(directory, provider, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 120_000;
  do {
    for (let slot = 0; slot < 2; slot++) {
      let release;
      let compromised;
      try {
        release = await lockfile.lock(join(directory, `${provider}-${slot}`), {
          realpath: false, stale: 30000, update: 5000, retries: 0,
          onCompromised: error => { compromised = error; },
        });
      } catch (error) {
        if (error.code === 'ELOCKED') continue;
        throw error;
      }
      try {
        const result = await action();
        if (compromised) throw new DevDashError('LOCK_LOST', 'The provider concurrency reservation was lost.');
        return result;
      } finally {
        if (!compromised) await release();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new DevDashError('BUSY', 'Provider concurrency slots are busy. Retry this query shortly.');
}
