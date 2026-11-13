import { DevDashError } from '../errors.js';
import { mapLimit } from '../concurrency.js';
import { PAGE_SIZE, MAX_PAGES, invalid, object, text, id, array, optionalText, identity, identityMetadata, date, boolean, uniquePage } from './shared.js';

const BUG_FIELDS = [
  'System.Title', 'System.State', 'System.WorkItemType', 'System.TeamProject',
  'System.CreatedBy', 'System.AssignedTo', 'System.Tags', 'System.CreatedDate', 'System.ChangedDate',
];
const DETAIL_FIELDS = ['Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority'];
const WORK_ITEM_FIELDS = [...BUG_FIELDS, ...DETAIL_FIELDS];

function workItemValue(value, label) {
  if (value == null) return null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : text(value, label);
}

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
    type: text(fields['System.WorkItemType'], 'ADO work item type'),
    ...(Object.hasOwn(fields, DETAIL_FIELDS[0]) ? { severity: workItemValue(fields[DETAIL_FIELDS[0]], 'ADO severity') } : {}),
    ...(Object.hasOwn(fields, DETAIL_FIELDS[1]) ? { priority: workItemValue(fields[DETAIL_FIELDS[1]], 'ADO priority') } : {}),
    ...identityMetadata(fields['System.CreatedBy'], [fields['System.AssignedTo']], 'ado'),
  };
}

function workItemBatch(rows, offset, profile) {
  const batch = rows.slice(offset, offset + 200);
  // The REST count limit does not account for long URLs; use the extension's URL precautions too.
  const url = new URL(`${profile.organization.replace(/\/+$/, '')}/${encodeURIComponent(profile.project)}/_apis/wit/workitems`);
  url.searchParams.set('fields', ['System.Id', ...WORK_ITEM_FIELDS].join(','));
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
  const types = (profile.workItemTypes ?? ['Bug']).map(type => type.toLowerCase());
  const candidates = rows.slice(0, 1000).filter(row => row.fields?.['System.WorkItemType'] == null ||
    types.includes(text(row.fields['System.WorkItemType'], 'ADO work item type').toLowerCase()));
  const items = [];
  let candidateOffset = 0;
  while (candidateOffset < candidates.length && items.length < profile.limit) {
    const selected = candidates.slice(candidateOffset, candidateOffset + profile.limit - items.length);
    candidateOffset += selected.length;
    const missing = selected.filter(row => !row.fields || BUG_FIELDS.some(field => !Object.hasOwn(row.fields, field)));
    const hydrated = new Map();
    for (let offset = 0; offset < missing.length;) {
      const batch = workItemBatch(missing, offset, profile);
      offset += batch.length;
      // invoke cannot disambiguate duplicate workitems routes on some servers.
      const query = `SELECT ${['System.Id', ...WORK_ITEM_FIELDS].map(field => `[${field}]`).join(', ')} FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] IN (${batch.map(row => row.id).join(',')})`;
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
    items.push(...selected.map(row => hydrated.get(String(row.id)) ?? row)
      .filter(row => types.includes(text(object(row.fields, 'ADO fields')['System.WorkItemType'], 'ADO work item type').toLowerCase()))
      .map(row => bugItem(row, profile)));
  }
  return { items, truncated: candidateOffset < candidates.length || rows.length >= 1000 };
}

function prItem(row, profile) {
  const number = id(row.pullRequestId, 'ADO PR ID');
  const repository = object(row.repository, 'ADO PR repository');
  const repositoryName = text(repository.name, 'ADO repository name');
  const project = repository.project == null ? profile.project : text(object(repository.project, 'ADO repository project').name, 'ADO project name');
  if (project.toLowerCase() !== profile.project.toLowerCase()) invalid('ADO returned a PR outside the requested project.');
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
    ...identityMetadata(row.createdBy, [], 'ado', row.reviewers ?? []),
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
  const references = new Map();
  const finish = async truncated => ({
    items: profile.include
      ? await mapLimit(items, 4, item => prProperties(item, references.get(item.id), profile, runJson))
      : items,
    truncated,
  });
  const seen = new Set();
  const selectors = value => Array.isArray(value) ? value : [value];
  const creators = selectors(profile.creator), reviewers = selectors(profile.reviewer);
  const requestLimit = MAX_PAGES + creators.length * reviewers.length;
  let pages = 0;
  for (const creator of creators) for (const reviewer of reviewers) {
    let skip = 0;
    const streamSeen = new Set();
    for (;;) {
      if (pages++ >= requestLimit) return finish(true);
      const top = Math.min(PAGE_SIZE, profile.limit - items.length + 1);
      const args = ['repos', 'pr', 'list', '--status', profile.status ?? 'active',
        '--top', String(top), '--skip', String(skip), ...azContext(profile)];
      for (const [field, value] of Object.entries({ repository: profile.repository, creator, reviewer })) {
        if (value) args.push(`--${field}`, value);
      }
      for (const field of ['sourceBranch', 'targetBranch']) {
        if (profile[field]) args.push(field === 'sourceBranch' ? '--source-branch' : '--target-branch', profile[field]);
      }
      const rows = array(await runJson('az', args), 'ADO PR list');
      if (rows.length > top) invalid('ADO PR list exceeded the requested page size.');
      uniquePage(rows, streamSeen, row => id(row.pullRequestId, 'ADO PR ID'));
      for (const row of rows) {
        const item = prItem(row, profile);
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (items.length === profile.limit) return finish(true);
        items.push(item);
        if (profile.include) {
          const repositoryId = text(row.repository.id, 'ADO PR repository ID');
          if (profile.repository && ![repositoryId, item.repository].some(name =>
            name.toLowerCase() === profile.repository.toLowerCase())) invalid('ADO returned a PR outside the requested repository.');
          references.set(item.id, repositoryId);
        }
      }
      if (rows.length < top) break;
      skip += rows.length;
    }
  }
  return finish(false);
}

async function prProperties(item, repositoryId, profile, runJson) {
  const names = profile.include.properties;
  const response = object(await runJson('az', [
    'devops', 'invoke', '--area', 'git', '--resource', 'pullRequestProperties',
    '--http-method', 'GET', '--api-version', '7.1',
    '--route-parameters', `project=${profile.project}`, `repositoryId=${repositoryId}`, `pullRequestId=${item.id}`,
    '--query-parameters', `keys=${names.join(',')}`, '--organization', profile.organization,
    '--detect', 'false', '--output', 'json', '--only-show-errors',
  ]), 'ADO PR properties');
  const value = object(response.value, 'ADO PR property collection');
  if (!Number.isSafeInteger(response.count) || response.count !== Object.keys(value).length ||
      (response.continuation_token != null && response.continuation_token !== '')) {
    invalid('ADO PR properties returned an incomplete or invalid collection.');
  }
  const properties = Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));
  return { ...item, providerData: { ...item.providerData, properties } };
}

export const adoProvider = Object.freeze({
  id: 'ado', cli: 'az', resources: Object.freeze(['bugs', 'prs']),
  query: (profile, { runJson }) => profile.resource === 'bugs' ? bugs(profile, runJson) : prs(profile, runJson),
});
