import { createProviderRegistry, queryProfile } from '../../src/providers.js';
import { DevDashError } from '../../src/errors.js';

export function testItem(overrides = {}) {
  return {
    provider: 'github', kind: 'bug', id: '1', title: 'Synthetic cache regression',
    state: 'open', url: 'https://example.com/items/1', repository: 'example/repo',
    author: 'example-user', assignees: [], labels: ['regression'],
    createdAt: null, updatedAt: null, draft: null, providerData: {}, ...overrides,
  };
}

export function createTestProvider({ provider = 'github', responses = [] } = {}) {
  const queue = [...responses];
  const calls = [];
  const resources = provider === 'chromium' ? ['bugs', 'cls'] : ['bugs', 'prs'];
  const adapter = {
    id: provider, cli: 'test-provider', resources,
    async query(profile) {
      calls.push(structuredClone(profile));
      if (!queue.length) throw new DevDashError('TEST_RESPONSE_MISSING', 'No synthetic provider response was queued.');
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
  const providers = createProviderRegistry([adapter]);
  return {
    calls,
    enqueue: response => queue.push(response),
    queryProfile: profile => queryProfile(profile, {
      providers,
      runJson: async () => { throw new DevDashError('TEST_NETWORK_FORBIDDEN', 'Synthetic providers cannot execute external CLIs.'); },
    }),
  };
}
