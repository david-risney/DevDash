import { setTimeout } from 'node:timers/promises';
import { DevDashError, errorJson } from './errors.js';
import { selectedQuery } from './service.js';

export async function watchProfiles(service, { profile, query, interval = 1, signal }, emit, dependencies = {}) {
  if (query !== undefined && !profile) {
    throw new DevDashError('INVALID_ARGUMENT', 'A profile is required when watching a named query.');
  }
  if (profile) {
    const definition = await service.profile(profile);
    if (query !== undefined) selectedQuery(definition, query);
  }
  else await service.config();
  const sleep = dependencies.sleep ?? setTimeout;
  while (!signal?.aborted) {
    let results;
    try {
      results = profile
        ? [await service.get(profile, { refresh: true, due: true, query })]
        : (await service.getAll({ refresh: true, due: true })).results;
    } catch (error) {
      results = [{ profile: profile ?? null, ...(query === undefined ? {} : { query }), ...errorJson(error) }];
    }
    for (const result of results) {
      if (!result.fromCache) await emit({ event: result.error || result.failed > 0 ? 'error' : 'refreshed', ...result });
    }
    try {
      await sleep(interval * 1000, undefined, { signal });
    } catch (error) {
      if (error.name !== 'AbortError' || !signal?.aborted) throw error;
    }
  }
}
