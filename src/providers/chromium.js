import { DevDashError } from '../errors.js';

async function query(profile, { runJson }) {
  const bugSearch = profile.resource === 'bugs' && typeof profile.query === 'string';
  if (profile.resource === 'bugs' && !bugSearch &&
      (!Array.isArray(profile.bugIds) || profile.bugIds.length < 1 || profile.bugIds.length > 100 ||
        profile.bugIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) ||
        new Set(profile.bugIds).size !== profile.bugIds.length)) {
    throw new DevDashError('INVALID_PROFILE', 'Chromium bugs require 1-100 unique positive numeric string bugIds.');
  }
  const args = profile.resource === 'bugs'
    ? bugSearch ? ['bugs', 'list', `--query=${profile.query}`] : ['bugs', 'view', ...profile.bugIds]
    : ['cls', 'list', `--query=${profile.query}`];
  if (profile.resource === 'cls') {
    for (const field of ['project', 'host']) {
      if (profile[field]) args.push(`--${field}=${profile[field]}`);
    }
  }
  args.push('--limit', String(profile.limit));
  // A public bug can need navigation, rendering, and cleanup time for each requested ID.
  const requests = profile.resource === 'bugs'
    ? bugSearch ? profile.limit : Math.min(profile.bugIds.length, profile.limit)
    : Math.min(profile.limit, 200);
  const result = await runJson('cr', args, {
    timeout: 120_000 + requests * (profile.resource === 'bugs' ? 75_000 : 35_000) +
      (bugSearch ? Math.ceil(profile.limit / 50) * 60_000 : 0),
  });
  if (result?.schemaVersion !== 1) {
    throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'cr returned an unsupported or missing result schemaVersion.');
  }
  if (profile.resource === 'bugs' && !bugSearch) {
    const requested = new Set(profile.bugIds.slice(0, profile.limit));
    if (!Array.isArray(result.items) || result.items.length !== requested.size ||
        result.items.some(item => !requested.has(item?.id)) ||
        result.truncated !== (profile.bugIds.length > profile.limit)) {
      throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'cr did not return exactly the requested bug IDs.');
    }
  } else if (profile.project && Array.isArray(result.items) &&
      result.items.some(item => item?.repository !== profile.project)) {
    throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'cr returned a CL outside the requested Gerrit project.');
  }
  if (Array.isArray(result.items) && result.items.some(item => {
    const expected = profile.resource === 'bugs'
      ? `https://issues.chromium.org/issues/${item?.id}`
      : `${(profile.host ?? 'https://chromium-review.googlesource.com').replace(/\/+$/, '')}/c/${typeof item?.repository === 'string'
        ? item.repository.split('/').map(encodeURIComponent).join('/') : ''}/+/${item?.id}`;
    return item?.url !== expected;
  })) {
    throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'cr returned an item URL outside the requested provider scope.');
  }
  return result;
}

export const chromiumProvider = Object.freeze({
  id: 'chromium', cli: 'cr', resources: Object.freeze(['bugs', 'cls']), query,
});
