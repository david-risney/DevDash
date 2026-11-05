import { DevDashError } from '../errors.js';
import { PAGE_SIZE, MAX_PAGES, invalid, object, text, id, array, optionalText, identity, date, boolean, uniquePage } from './shared.js';

const BUG_FIELDS = [
  'System.Title', 'System.State', 'System.WorkItemType', 'System.TeamProject',
  'System.CreatedBy', 'System.AssignedTo', 'System.Tags', 'System.CreatedDate', 'System.ChangedDate',
];

function azContext(profile) {
  return ['--organization', profile.organization, '--project', profile.project,
    '--detect', 'false', '--output', 'json', '--only-show-errors'];
}

function bugItem(row, profile) {
  const fields = object(row.fields, 'ADO work item fields');
  const number = id(row.id, 'ADO work item ID');
  const assignedTo = identity(fields['System.AssignedTo'], ['uniqueName', 'displayName', 'id']);
  const tags = optionalText(fields['System.Tags'], 'ADO tags');
  const project = fields['System.TeamProject'] == null ? profile.project : text(fields['System.TeamProject'], 'ADO work item project');
  return {
    provider: 'ado', kind: 'bug', id: number,
    title: text(fields['System.Title'], 'ADO work item title'), state: text(fields['System.State'], 'ADO work item state'),
    url: `${profile.organization.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${number}`,
    repository: null, author: identity(fields['System.CreatedBy'], ['uniqueName', 'displayName', 'id']),
    assignees: assignedTo ? [assignedTo] : [],
    labels: tags ? tags.split(';').map(tag => tag.trim()).filter(Boolean) : [],
    createdAt: date(fields['System.CreatedDate']), updatedAt: date(fields['System.ChangedDate']), draft: null,
    providerData: {},
  };
}

function workItemBatch(rows, offset, profile) {
  const batch = rows.slice(offset, offset + 200);
  // The REST count limit does not account for long URLs; use the extension's URL precautions too.
  const url = new URL(`${profile.organization.replace(/\/+$/, '')}/${encodeURIComponent(profile.project)}/_apis/wit/workitems`);
  url.searchParams.set('fields', ['System.Id', ...BUG_FIELDS].join(','));
  url.searchParams.set('api-version', '7.1');
  do {
    url.searchParams.set('ids', batch.map(row => row.id).join(','));
    if (url.href.length <= 1900 || batch.length === 1) break;
    batch.pop();
  } while (batch.length);
  return batch;
}

function flatWiql(profile) {
  const query = text(profile.query, 'ADO WIQL');
  const syntax = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, '');
  if (/\bFROM\s+\[?WorkItemLinks\]?\b/i.test(syntax)) {
    throw new DevDashError('UNSUPPORTED_QUERY', 'ADO bugs support only flat work-item queries, not trees or links.');
  }
  if (!/^\s*SELECT\b/i.test(syntax) || !/\bFROM\s+(?:WorkItems\b|\[WorkItems\])/i.test(syntax)) {
    throw new DevDashError('INVALID_PROFILE', 'ADO WIQL must be a flat SELECT query from WorkItems.');
  }
  // boards query does not pass --project to query_by_wiql.
  return query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\[[^\]]*\]|@project\b/gi,
    token => /^@project$/i.test(token) ? `'${profile.project.replace(/'/g, "''")}'` : token);
}

async function bugs(profile, runJson) {
  if (profile.queryId) {
    const query = object(await runJson('az', ['devops', 'invoke', '--area', 'wit',
      '--resource', 'queries', '--http-method', 'GET', '--api-version', '7.1',
      '--route-parameters', `project=${profile.project}`, `query=${profile.queryId}`,
      '--query-parameters', '$expand=wiql', '--organization', profile.organization,
      '--detect', 'false', '--output', 'json', '--only-show-errors']), 'ADO saved query');
    if (query.isFolder === true || ['tree', 'oneHop'].includes(query.queryType)) {
      throw new DevDashError('UNSUPPORTED_QUERY', 'ADO bugs support only flat work-item queries, not folders, trees or links.');
    }
    if (query.queryType !== 'flat') invalid('ADO saved query omitted a valid queryType.');
  }
  const result = await runJson('az', ['boards', 'query',
    profile.queryId ? '--id' : '--wiql', profile.queryId ?? flatWiql(profile),
    '--query', 'not_null(@, `[]`)', ...azContext(profile)]);
  // The extension returns None for no matches and silently caps the list near 1000.
  const rows = result === null ? [] : array(result, 'ADO boards query');
  const seen = new Set();
  uniquePage(rows, seen, row => id(row.id, 'ADO work item ID'));
  const selected = rows.slice(0, Math.min(profile.limit, 1000));
  const missing = selected.filter(row => !row.fields || BUG_FIELDS.some(field => !Object.hasOwn(row.fields, field)));
  const hydrated = new Map();
  for (let offset = 0; offset < missing.length;) {
    const batch = workItemBatch(missing, offset, profile);
    offset += batch.length;
    // invoke cannot disambiguate duplicate workitems routes on some servers.
    const query = `SELECT ${['System.Id', ...BUG_FIELDS].map(field => `[${field}]`).join(', ')} FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] IN (${batch.map(row => row.id).join(',')})`;
    const response = await runJson('az', ['boards', 'query', '--wiql', flatWiql({ ...profile, query }),
      '--query', 'not_null(@, `[]`)', ...azContext(profile)]);
    const values = response === null ? [] : array(response, 'ADO work item hydration');
    const expected = new Set(batch.map(row => String(row.id)));
    for (const row of values) {
      object(row, 'ADO hydrated work item');
      const number = id(row.id, 'ADO hydrated work item ID');
      if (!expected.delete(number)) invalid('ADO hydration returned an unexpected or duplicate work item.');
      hydrated.set(number, row);
    }
    if (expected.size) invalid('ADO hydration omitted requested work items.');
  }
  const items = selected.map(row => hydrated.get(String(row.id)) ?? row)
    .filter(row => text(object(row.fields, 'ADO fields')['System.WorkItemType'], 'ADO work item type').toLowerCase() === 'bug')
    .map(row => bugItem(row, profile));
  return { items, truncated: rows.length > profile.limit || rows.length >= 1000 };
}

function prItem(row, profile) {
  const number = id(row.pullRequestId, 'ADO PR ID');
  const repository = object(row.repository, 'ADO PR repository');
  const repositoryName = text(repository.name, 'ADO repository name');
  const project = repository.project == null ? profile.project : text(object(repository.project, 'ADO repository project').name, 'ADO project name');
  return {
    provider: 'ado', kind: 'pr', id: number, title: text(row.title, 'ADO PR title'), state: text(row.status, 'ADO PR status'),
    url: `${profile.organization.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repositoryName)}/pullrequest/${number}`,
    repository: repositoryName, author: identity(row.createdBy, ['uniqueName', 'displayName', 'id']), assignees: [],
    labels: array(row.labels ?? [], 'ADO PR labels').map(label => text(object(label, 'ADO label').name, 'ADO label name')),
    createdAt: date(row.creationDate), updatedAt: null, draft: boolean(row.isDraft, 'ADO PR draft'),
    ...(Object.hasOwn(row, 'sourceRefName') ? { sourceBranch: branch(row.sourceRefName) } : {}),
    ...(Object.hasOwn(row, 'targetRefName') ? { targetBranch: branch(row.targetRefName) } : {}),
    ...(Object.hasOwn(row, 'reviewers') ? {
      reviewers: array(row.reviewers ?? [], 'ADO PR reviewers')
        .map(person => identity(person, ['uniqueName', 'displayName', 'id'])).filter(Boolean),
    } : {}),
    providerData: {
      ...(Object.hasOwn(row, 'mergeStatus') ? { mergeStatus: optionalText(row.mergeStatus, 'ADO PR merge status') } : {}),
      ...(Object.hasOwn(row, 'reviewers') ? {
        reviewerVotes: array(row.reviewers ?? [], 'ADO PR reviewers').map(person => ({
          reviewer: identity(person, ['uniqueName', 'displayName', 'id']),
          vote: reviewerVote(person?.vote),
          required: boolean(person?.isRequired, 'ADO reviewer required'),
        })),
      } : {}),
    },
  };
}

function reviewerVote(value) {
  if (value == null) return null;
  if (![-10, -5, 0, 5, 10].includes(value)) invalid('ADO reviewer vote is invalid.');
  return value;
}

function branch(value) {
  const name = value == null ? null : text(value, 'ADO branch');
  const result = name?.replace(/^refs\/heads\//, '') ?? null;
  if (name !== null && !result) invalid('ADO branch must have a nonempty name.');
  return result;
}

async function prs(profile, runJson) {
  const items = [];
  const seen = new Set();
  let skip = 0;
  for (let page = 0; page <= MAX_PAGES; page++) {
    const top = Math.min(PAGE_SIZE, profile.limit - items.length + 1);
    const args = ['repos', 'pr', 'list', '--status', profile.status ?? 'active',
      '--top', String(top), '--skip', String(skip), ...azContext(profile)];
    for (const field of ['repository', 'creator', 'reviewer']) {
      if (profile[field]) args.push(`--${field}`, profile[field]);
    }
    for (const field of ['sourceBranch', 'targetBranch']) {
      if (profile[field]) args.push(field === 'sourceBranch' ? '--source-branch' : '--target-branch', profile[field]);
    }
    const rows = array(await runJson('az', args), 'ADO PR list');
    if (rows.length > top) invalid('ADO PR list exceeded the requested page size.');
    uniquePage(rows, seen, row => id(row.pullRequestId, 'ADO PR ID'));
    items.push(...rows.slice(0, profile.limit - items.length).map(row => prItem(row, profile)));
    if (seen.size > profile.limit) return { items, truncated: true };
    if (rows.length < top) return { items, truncated: false };
    skip += rows.length;
  }
  return { items, truncated: true };
}

export const adoProvider = Object.freeze({
  id: 'ado', cli: 'az', resources: Object.freeze(['bugs', 'prs']),
  query: (profile, { runJson }) => profile.resource === 'bugs' ? bugs(profile, runJson) : prs(profile, runJson),
});
