import { DevDashError } from '../errors.js';
import { PAGE_SIZE, invalid, object, text, id, array, identity, date, boolean, uniquePage } from './shared.js';

export function githubQuery(profile) {
  const query = profile.query ?? 'state:open';
  const expectedType = profile.resource === 'prs' ? 'pr' : 'issue';
  const tokens = query.match(/(?:[^\s"\\]|\\.|"(?:\\.|[^"\\])*")+/g) ?? [];
  for (const token of tokens) {
    const qualifier = token.replace(/^\(+|\)+$/g, '').match(/^(-?)(repo|is|type):(?:"([^"]*)"|([^"]+))$/i);
    if (!qualifier) continue;
    const [, negative, name, quoted, unquoted] = qualifier;
    const value = (quoted ?? unquoted).toLowerCase();
    const conflicts = name.toLowerCase() === 'repo'
      ? (!negative && value !== profile.repository.toLowerCase()) ||
        (negative && value === profile.repository.toLowerCase())
      : ['issue', 'pr'].includes(value) &&
        ((!negative && value !== expectedType) || (negative && value === expectedType));
    if (conflicts) {
      throw new DevDashError('INVALID_PROFILE', 'GitHub query conflicts with the profile repository or resource.');
    }
  }
  return `${query} repo:${profile.repository} is:${expectedType}`;
}

async function resolveGithubIdentity(query, profile, runJson) {
  const tokenPattern = /(?:[^\s"\\]|\\.|"(?:\\.|[^"\\])*")+/g;
  const selfQualifier = /^(\(*-?(?:author|assignee|mentions|commenter|involves|reviewed-by|review-requested|user-review-requested|user):)(?:"@me"|@me)(\)*)$/i;
  if (!(query.match(tokenPattern) ?? []).some(token => selfQualifier.test(token))) return query;
  const args = ['api', '--method', 'GET', 'user'];
  if (profile.hostname) args.push('--hostname', profile.hostname);
  const user = object(await runJson('gh', args), 'GitHub authenticated user');
  const login = text(user.login, 'GitHub authenticated user login');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(login)) invalid('GitHub authenticated user returned an invalid login.');
  return query.replace(tokenPattern, token =>
    token.replace(selfQualifier, (_, prefix, suffix) => prefix + login + suffix));
}

function validateGithubScope(row, profile) {
  object(row, 'GitHub result');
  let repository;
  try {
    const url = new URL(text(row.repository_url, 'GitHub repository URL'));
    const path = url.pathname.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (path) repository = `${decodeURIComponent(path[1])}/${decodeURIComponent(path[2])}`;
  } catch {
    invalid('GitHub returned an invalid repository URL.');
  }
  if (repository?.toLowerCase() !== profile.repository.toLowerCase()) invalid('GitHub returned an item outside the profile repository.');
  const isPr = row.pull_request != null;
  if (isPr) object(row.pull_request, 'GitHub pull request marker');
  if (isPr !== (profile.resource === 'prs')) invalid('GitHub returned an item outside the profile resource.');
}

function githubItem(row, profile) {
  const number = id(row.number, 'GitHub issue number');
  const kind = profile.resource === 'prs' ? 'pr' : 'bug';
  const labels = array(row.labels ?? [], 'GitHub labels').map(label =>
    typeof label === 'string' ? text(label, 'Label') : text(object(label, 'Label').name, 'Label name'));
  return {
    provider: 'github', kind, id: number,
    title: text(row.title, 'GitHub title'), state: text(row.state, 'GitHub state'),
    url: `https://${profile.hostname ?? 'github.com'}/${profile.repository}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    repository: profile.repository, author: identity(row.user, ['login']),
    assignees: array(row.assignees ?? [], 'GitHub assignees').map(person => identity(person, ['login'])).filter(Boolean),
    labels, createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    draft: kind === 'pr' ? boolean(row.draft, 'GitHub draft') : null,
    providerData: row.node_id == null ? {} : { nodeId: text(row.node_id, 'GitHub node ID') },
  };
}

async function query(profile, { runJson }) {
  const queryText = await resolveGithubIdentity(githubQuery(profile), profile, runJson);
  const items = [];
  const seen = new Set();
  let truncated = false;
  let total = 0;
  const cap = Math.min(profile.limit, 1000);
  for (let page = 1; page <= 10; page++) {
    const args = ['api', '--method', 'GET', 'search/issues', '-f', `q=${queryText}`,
      '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`];
    if (profile.hostname) args.push('--hostname', profile.hostname);
    const result = object(await runJson('gh', args), 'GitHub search');
    if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || typeof result.incomplete_results !== 'boolean') {
      invalid('GitHub search: invalid total_count or incomplete_results.');
    }
    total = Math.max(total, result.total_count);
    truncated ||= result.incomplete_results;
    const rows = array(result.items, 'GitHub search items');
    if (rows.length > PAGE_SIZE) invalid('GitHub search exceeded the requested page size.');
    rows.forEach(row => validateGithubScope(row, profile));
    uniquePage(rows, seen, row => id(row.number, 'GitHub issue number'));
    items.push(...rows.slice(0, cap - items.length).map(row => githubItem(row, profile)));
    if (items.length >= cap || rows.length < PAGE_SIZE || seen.size >= total) break;
  }
  return { items, truncated: truncated || total > items.length || seen.size > items.length };
}

export const githubProvider = Object.freeze({
  id: 'github', cli: 'gh', resources: Object.freeze(['bugs', 'prs']), query,
});
