import picomatch from 'picomatch';
import { DevDashError } from './errors.js';
import { presentationThemes } from './presentation.js';

const descriptions = {
  'half-block': 'Full-width half-block frame with colored status text.',
  chevron: 'Full-width chevron title with colored status text.',
  semicircle: 'Full-width semicircle title with emoji-and-text status pills.',
  'chevron-tab': 'Compact chevron title tab with emoji-only statuses, no pills.',
  'semicircle-tab': 'Compact semicircle title tab with rounded text status pills (default).',
  'rounded-pills': 'Unfilled inline title with emoji-and-text status pills.',
};

export function themeOptions(pattern = '*') {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 256 || /[\u0000-\u001f\u007f]/u.test(pattern)) {
    throw new DevDashError('INVALID_ARGUMENT', 'The theme glob must contain 1-256 printable characters.');
  }
  let matches;
  try { matches = picomatch(pattern, { strictBrackets: true }); } catch {
    throw new DevDashError('INVALID_ARGUMENT', 'Invalid theme glob. Quote patterns such as "*tab" or "{chevron,semicircle}*".');
  }
  return {
    schemaVersion: 1, pattern,
    themes: Object.keys(presentationThemes).filter(name => matches(name)).map(name => ({
      name, description: descriptions[name], presentation: { theme: name },
    })),
  };
}

export function themeExamples(themes) {
  return {
    results: themes.map(({ name }) => ({
      profile: name, provider: 'github', resource: 'prs', truncated: false,
      items: [
        ['1', 'Fix refresh race', 'open', false],
        ['2', 'Review cache policy', 'closed', false],
        ['3', 'Explain auth failure', 'open', true],
      ].map(([id, title, state, draft]) => ({
        provider: 'github', kind: 'pr', id, title, state, draft,
        url: `https://example.com/pull/${id}`, repository: 'sample/demo',
        author: 'sample-author', assignees: [], labels: [],
        createdAt: null, updatedAt: null, providerData: {},
      })),
    })),
  };
}
