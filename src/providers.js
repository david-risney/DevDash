import { runJson as defaultRunJson } from './process.js';
import { DevDashError } from './errors.js';
import { providerProcessOptions } from './diagnostics.js';
import { createProviderRegistry, validateQueryResult } from './providers/contract.js';
import { githubProvider, githubQuery } from './providers/github.js';
import { adoProvider } from './providers/ado.js';
import { chromiumProvider } from './providers/chromium.js';
import { providerProfile } from './query.js';
import { compileFilter, filterItems } from './filters.js';
import { githubAccountOptions } from './github-auth.js';

export { createProviderRegistry } from './providers/contract.js';
export const providerRegistry = createProviderRegistry([githubProvider, adoProvider, chromiumProvider]);

export function queryWebUrl(profile) {
  const definition = providerProfile(profile);
  if (definition.provider === 'github') {
    const url = new URL(`https://${definition.hostname ?? 'github.com'}/search`);
    url.searchParams.set('q', githubQuery(definition));
    url.searchParams.set('type', definition.resource === 'prs' ? 'pullrequests' : 'issues');
    return url.href;
  }
  if (definition.provider === 'ado') {
    const project = `${definition.organization.replace(/\/+$/, '')}/${encodeURIComponent(definition.project)}`;
    return definition.resource === 'bugs'
      ? `${project}/_queries${definition.queryId ? `/query/${encodeURIComponent(definition.queryId)}` : ''}`
      : `${project}/_git${definition.repository ? `/${encodeURIComponent(definition.repository)}` : ''}/pullrequests`;
  }
  if (definition.provider === 'chromium') {
    if (definition.resource === 'bugs') {
      const url = new URL('https://issues.chromium.org/issues');
      if (definition.query) url.searchParams.set('q', definition.query);
      else if (definition.bugIds.length === 1) url.pathname += `/${definition.bugIds[0]}`;
      return url.href;
    }
    const query = `${definition.query}${definition.project ? ` project:${JSON.stringify(definition.project)}` : ''}`;
    return `${(definition.host ?? 'https://chromium-review.googlesource.com').replace(/\/+$/, '')}/q/${encodeURIComponent(query)}`;
  }
  throw new DevDashError('UNSUPPORTED_PROVIDER', 'Unsupported provider for a query web link.');
}

export async function queryProfile(profile, dependencies = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new DevDashError('INVALID_PROFILE', 'Provider query requires a profile object.');
  }
  const filter = compileFilter(profile.filter, profile);
  const limit = profile.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
    throw new DevDashError('INVALID_PROFILE', 'Profile limit must be between 1 and 20000.');
  }
  const registry = dependencies.providers ?? providerRegistry;
  const adapter = Object.hasOwn(registry, profile.provider) ? registry[profile.provider] : undefined;
  if (!adapter || !adapter.resources.includes(profile.resource)) {
    throw new DevDashError('UNSUPPORTED_PROVIDER', 'Unsupported provider or resource.');
  }
  const executeJson = dependencies.runJson ?? defaultRunJson;
  const effective = { ...providerProfile(profile), limit };
  if (effective.provider === 'github') githubQuery(effective);
  const githubOptions = effective.provider === 'github' ? await githubAccountOptions(effective, dependencies) : undefined;
  const context = {
    fetch: dependencies.fetch ?? globalThis.fetch,
    runJson: async (command, args, options) => {
      if (command !== adapter.cli) {
        throw new DevDashError('INVALID_PROVIDER', 'Provider attempted to run a command outside its adapter contract.');
      }
      const processOptions = command === 'cr'
        ? { ...options, ...providerProcessOptions() }
        : githubOptions
          ? { ...options, env: { ...options?.env, ...githubOptions.env } }
        : options;
      try {
        return await executeJson(command, args, processOptions);
      } catch (error) {
        if (error instanceof DevDashError && error.code !== 'CLI_FAILED') throw error;
        throw new DevDashError('CLI_FAILED', `${command} provider query failed. Check CLI authentication and query permissions directly.`);
      }
    },
  };
  const result = validateQueryResult(effective, await adapter.query(effective, context));
  return { ...result, items: await filterItems(result.items, filter) };
}
