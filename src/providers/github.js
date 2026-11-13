import { DevDashError } from '../errors.js';
import { PAGE_SIZE, invalid, object, text, id, array, identity, identityMetadata, date, boolean, count, uniquePage } from './shared.js';
import { githubRepositories } from '../query.js';

const tokenPattern = /(?:[^\s"\\]|\\.|"(?:\\.|[^"\\])*")+/g;
const selfQualifier = /^(\(*-?(?:author|assignee|mentions|commenter|involves|reviewed-by|review-requested|user-review-requested|user):)(?:"@me"|@me)(\)*)$/i;
const replaceSelf = (query, login) => query.replace(tokenPattern, token =>
  token.replace(selfQualifier, (_, prefix, suffix) => prefix + login + suffix));

export function githubQuery(profile) {
  const query = profile.query ?? 'state:open';
  const expectedType = profile.resource === 'prs' ? 'pr' : 'issue';
  const repositories = githubRepositories(profile);
  const scope = repositories.map(value => value.toLowerCase());
  const tokens = query.match(tokenPattern) ?? [];
  let hasRepository = false;
  const exclusions = new Set();
  for (const token of tokens) {
    const qualifier = token.replace(/^\(+|\)+$/g, '').match(/^(-?)(repo|is|type):(?:"([^"]*)"|([^"]+))$/i);
    if (!qualifier) continue;
    const [, negative, name, quoted, unquoted] = qualifier;
    const value = (quoted ?? unquoted).toLowerCase();
    if (name.toLowerCase() === 'repo') {
      if (negative) exclusions.add(value);
      else hasRepository = true;
    }
    const conflicts = name.toLowerCase() === 'repo'
      ? scope.length > 0 && !negative && !scope.includes(value)
      : ['issue', 'pr'].includes(value) &&
        ((!negative && value !== expectedType) || (negative && value === expectedType));
    if (conflicts) {
      throw new DevDashError('INVALID_PROFILE', 'GitHub query conflicts with the profile repository or resource.');
    }
  }
  if (scope.length && scope.every(repository => exclusions.has(repository))) {
    throw new DevDashError('INVALID_PROFILE', 'GitHub query excludes every configured repository.');
  }
  const scoped = [query, ...(!hasRepository ? repositories.map(repository => `repo:${repository}`) : []),
    `is:${expectedType}`].join(' ');
  return profile.account === undefined ? scoped : replaceSelf(scoped, profile.account);
}

async function resolveGithubIdentity(query, profile, runJson) {
  if (profile.account === undefined && !(query.match(tokenPattern) ?? []).some(token => selfQualifier.test(token))) return query;
  if (profile.auth === 'anonymous') {
    throw new DevDashError('INVALID_PROFILE', 'Anonymous GitHub queries cannot resolve @me. Use an explicit login or gh authentication.');
  }
  const args = ['api', '--method', 'GET', 'user'];
  if (profile.hostname || profile.account) args.push('--hostname', profile.hostname ?? 'github.com');
  const user = object(await runJson('gh', args), 'GitHub authenticated user');
  const login = text(user.login, 'GitHub authenticated user login');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(login)) invalid('GitHub authenticated user returned an invalid login.');
  if (profile.account !== undefined && login.toLowerCase() !== profile.account.toLowerCase()) {
    throw new DevDashError('CLI_FAILED', 'GitHub authenticated identity does not match the selected query account.');
  }
  return replaceSelf(query, login);
}

async function githubRequest(profile, context, endpoint, parameters = {}) {
  if (profile.auth !== 'anonymous') {
    const args = ['api', '--method', 'GET', endpoint];
    for (const [name, value] of Object.entries(parameters)) args.push('-f', `${name}=${value}`);
    if (profile.hostname || profile.account) args.push('--hostname', profile.hostname ?? 'github.com');
    return context.runJson('gh', args);
  }
  const hostname = profile.hostname ?? 'github.com';
  const base = hostname.toLowerCase() === 'github.com' ? 'https://api.github.com/' : `https://${hostname}/api/v3/`;
  const url = new URL(endpoint, base);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  let response;
  try {
    response = await context.fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
  } catch {
    throw new DevDashError('PROVIDER_NETWORK', 'Anonymous GitHub request failed or timed out.');
  }
  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status) ||
      response.status < 100 || response.status > 599 || typeof response.json !== 'function') {
    invalid('GitHub returned an invalid HTTP response.');
  }
  if (!response.ok) throw new DevDashError('PROVIDER_HTTP', `Anonymous GitHub returned HTTP ${response.status}.`);
  try { return await response.json(); }
  catch { invalid('GitHub returned invalid JSON.'); }
}

function validateGithubScope(row, profile) {
  object(row, 'GitHub result');
  let repository;
  try {
    const url = new URL(text(row.repository_url, 'GitHub repository URL'));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid('GitHub returned an invalid repository URL.');
    const path = url.pathname.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (path) repository = `${decodeURIComponent(path[1])}/${decodeURIComponent(path[2])}`;
  } catch {
    invalid('GitHub returned an invalid repository URL.');
  }
  if (!repository || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) invalid('GitHub returned an invalid repository identity.');
  const repositories = githubRepositories(profile);
  if (repositories.length && !repositories.some(value => value.toLowerCase() === repository.toLowerCase())) {
    invalid('GitHub returned an item outside the profile repositories.');
  }
  const isPr = row.pull_request != null;
  if (isPr) object(row.pull_request, 'GitHub pull request marker');
  if (isPr !== (profile.resource === 'prs')) invalid('GitHub returned an item outside the profile resource.');
  return repository;
}

function githubItem(row, profile) {
  const repository = validateGithubScope(row, profile);
  const number = id(row.number, 'GitHub issue number');
  const kind = profile.resource === 'prs' ? 'pr' : 'bug';
  const labels = array(row.labels ?? [], 'GitHub labels').map(label =>
    typeof label === 'string' ? text(label, 'Label') : text(object(label, 'Label').name, 'Label name'));
  const labelDetails = (row.labels ?? []).filter(label => typeof label !== 'string' && label.color != null).map(label => {
    if (typeof label.color !== 'string' || !/^[0-9a-f]{6}$/i.test(label.color)) invalid('GitHub label color is invalid.');
    return { name: text(label.name, 'Label name'), color: `#${label.color.toLowerCase()}` };
  });
  const providerData = row.node_id == null ? {} : { nodeId: text(row.node_id, 'GitHub node ID') };
  if (Object.hasOwn(row, 'comments')) providerData.commentCount = count(row.comments, 'GitHub comment count');
  if (kind === 'bug' && Object.hasOwn(row, 'state_reason')) {
    if (row.state_reason !== null && !['completed', 'not_planned', 'reopened', 'duplicate'].includes(row.state_reason)) {
      invalid('GitHub closure reason is invalid.');
    }
    providerData.closureReason = row.state_reason;
  }
  if (kind === 'pr') {
    if (typeof row.merged !== 'boolean') invalid('GitHub PR merged flag is invalid.');
    providerData.merged = row.merged;
    providerData.mergedAt = date(row.merged_at);
    providerData.requestedReviewers = array(row.requested_reviewers, 'GitHub requested reviewers')
      .map(person => text(object(person, 'GitHub reviewer').login, 'GitHub reviewer login'));
    providerData.requestedTeams = array(row.requested_teams, 'GitHub requested teams')
      .map(team => text(object(team, 'GitHub team').slug, 'GitHub team slug'));
  }
  return {
    provider: 'github', kind, id: number,
    title: text(row.title, 'GitHub title'), state: text(row.state, 'GitHub state'),
    url: `https://${profile.hostname ?? 'github.com'}/${repository}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    repository, author: identity(row.user, ['login']),
    assignees: array(row.assignees ?? [], 'GitHub assignees').map(person => identity(person, ['login'])).filter(Boolean),
    labels, createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    draft: kind === 'pr' ? boolean(row.draft, 'GitHub draft') : null,
    providerData,
    ...identityMetadata(row.user, row.assignees ?? [], 'github', kind === 'pr' ? row.requested_reviewers : []),
    ...(labelDetails.length ? { labelDetails } : {}),
    ...(kind === 'pr' ? { reviewers: providerData.requestedReviewers } : {}),
  };
}

async function hydratePr(row, profile, context) {
  if (['merged', 'merged_at', 'requested_reviewers', 'requested_teams'].every(key => Object.hasOwn(row, key))) return row;
  const number = id(row.number, 'GitHub PR number');
  const repository = validateGithubScope(row, profile);
  const details = object(await githubRequest(profile, context, `repos/${repository}/pulls/${number}`), 'GitHub PR details');
  if (id(details.number, 'GitHub PR number') !== number ||
      text(object(object(details.base, 'GitHub PR base').repo, 'GitHub PR repository').full_name, 'GitHub PR repository')
        .toLowerCase() !== repository.toLowerCase()) invalid('GitHub PR hydration returned an item outside the requested scope.');
  // Only these fields need the PR endpoint; search owns the rest of the normalized item.
  return { ...row, merged: details.merged, merged_at: details.merged_at,
    requested_reviewers: details.requested_reviewers, requested_teams: details.requested_teams };
}

async function query(profile, context) {
  const queryText = await resolveGithubIdentity(githubQuery(profile), profile, context.runJson);
  const items = [];
  const seen = new Set();
  let truncated = false;
  let total = 0;
  const cap = Math.min(profile.limit, 1000);
  for (let page = 1; page <= 10; page++) {
    const result = object(await githubRequest(profile, context, 'search/issues', {
      q: queryText, per_page: PAGE_SIZE, page,
    }), 'GitHub search');
    if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || typeof result.incomplete_results !== 'boolean') {
      invalid('GitHub search: invalid total_count or incomplete_results.');
    }
    total = Math.max(total, result.total_count);
    truncated ||= result.incomplete_results;
    const rows = array(result.items, 'GitHub search items');
    if (rows.length > PAGE_SIZE) invalid('GitHub search exceeded the requested page size.');
    rows.forEach(row => validateGithubScope(row, profile));
    uniquePage(rows, seen, row => `${validateGithubScope(row, profile).toLowerCase()}\0${id(row.number, 'GitHub issue number')}`);
    const selected = rows.slice(0, cap - items.length);
    // At most the selected search cap (1000) is hydrated, four requests at a time.
    for (let offset = 0; offset < selected.length; offset += 4) {
      const batch = selected.slice(offset, offset + 4);
      const hydrated = profile.resource === 'prs'
        ? await Promise.all(batch.map(row => hydratePr(row, profile, context))) : batch;
      items.push(...hydrated.map(row => githubItem(row, profile)));
    }
    if (items.length >= cap || rows.length < PAGE_SIZE || seen.size >= total) break;
  }
  return { items, truncated: truncated || total > items.length || seen.size > items.length };
}

export const githubProvider = Object.freeze({
  id: 'github', cli: 'gh', resources: Object.freeze(['bugs', 'prs']), query,
});
