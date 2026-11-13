import { DevDashError } from './errors.js';
import { compileJavaScriptFilter, filterJavaScriptItems } from './javascript-filter.js';

const common = [
  ['provider'], ['kind'], ['id'], ['title', 'subject'], ['state', 'status'], ['url'],
  ['repository', 'repo'], ['author', 'creator', 'owner', 'createdBy'],
  ['assignees', 'assignee', 'assignedTo'], ['labels', 'label', 'tags', 'tag', 'hashtags'],
  ['createdAt', 'created'], ['updatedAt', 'updated'], ['draft'],
];
const supported = { github: ['bugs', 'prs'], ado: ['bugs', 'prs'], chromium: ['bugs', 'cls'] };
const canonical = value => value.toLowerCase().replace(/[-_]/g, '');
const folded = value => String(value).normalize('NFC').toLowerCase();
const invalid = message => { throw new DevDashError('INVALID_FILTER', message); };

export function filterProperties(profile) {
  if (!profile || !Object.hasOwn(supported, profile.provider) || !supported[profile.provider].includes(profile.resource)) {
    invalid('Filter properties require a supported provider and resource.');
  }
  const properties = common.map(([name, ...aliases]) => ({ name, aliases, path: name }));
  properties.push({ name: 'providerData', aliases: [], path: 'providerData' });
  properties.push({ name: 'identities', aliases: [], path: 'identities' });
  if (profile.provider === 'ado' && profile.resource === 'bugs') {
    for (const name of ['priority', 'severity', 'type']) properties.push({ name, aliases: [], path: name });
  }
  if (profile.provider === 'github') {
    for (const name of ['nodeId', 'commentCount', ...(profile.resource === 'bugs' ? ['closureReason']
      : ['merged', 'mergedAt', 'requestedReviewers', 'requestedTeams'])]) {
      properties.push({ name: `providerData.${name}`, aliases: [], path: `providerData.${name}` });
    }
    properties.push({ name: 'labelDetails', aliases: [], path: 'labelDetails' });
    if (profile.resource === 'prs') properties.push({ name: 'reviewers', aliases: ['reviewer'], path: 'reviewers' });
  }
  if (profile.provider === 'ado' && profile.resource === 'prs') {
    properties.push(
      { name: 'sourceBranch', aliases: [], path: 'sourceBranch' },
      { name: 'targetBranch', aliases: [], path: 'targetBranch' },
      { name: 'reviewers', aliases: ['reviewer'], path: 'reviewers' },
      { name: 'providerData.mergeStatus', aliases: [], path: 'providerData.mergeStatus' },
      { name: 'providerData.reviewerVotes', aliases: [], path: 'providerData.reviewerVotes' },
    );
    if (profile.include?.properties) {
      properties.push({ name: 'providerData.properties', aliases: [], path: 'providerData.properties' });
    }
  }
  if (profile.provider === 'chromium' && profile.resource === 'cls') {
    properties.find(property => property.name === 'repository').aliases.push('project');
    properties.push({ name: 'targetBranch', aliases: ['branch'], path: 'targetBranch' });
    properties.push({ name: 'providerData.changeId', aliases: [], path: 'providerData.changeId' });
    for (const name of ['codeReviewScores', 'insertions', 'deletions', 'unresolvedCommentCount']) {
      properties.push({ name: `providerData.${name}`, aliases: [], path: `providerData.${name}` });
    }
  }
  if (profile.provider === 'chromium' && profile.resource === 'bugs') {
    properties.push({ name: 'details', aliases: [], path: 'legacyDetails' });
    for (const name of ['priority', 'severity', 'type']) {
      properties.push({ name, aliases: [`details.${name}`], path: name });
    }
    properties.push({ name: 'providerData.component', aliases: ['component', 'details.component'], path: 'providerData.component' });
  }
  return properties;
}

export function compileFilter(expression, profile) {
  if (expression && typeof expression === 'object' && !Array.isArray(expression)) {
    return compileJavaScriptFilter(expression);
  }
  if (expression === undefined) return [];
  if (typeof expression !== 'string' || expression.length > 32768 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(expression)) {
    invalid('Filter must be a string of at most 32768 characters without invalid control characters.');
  }
  const properties = filterProperties(profile);
  const names = new Map();
  for (const property of properties) {
    for (const name of [property.name, ...property.aliases]) names.set(canonical(name), property);
  }
  const terms = [];
  let index = 0;
  while (index < expression.length) {
    while (/\s/u.test(expression[index] ?? '') && index < expression.length) index++;
    if (index === expression.length) break;
    const start = index;
    let text = '';
    let quote;
    let separator = -1;
    while (index < expression.length) {
      const character = expression[index];
      if (character === '\\') {
        const next = expression[index + 1];
        if (next === undefined) invalid(`Dangling filter escape at character ${index + 1}.`);
        if (/[\s\\:'"]/u.test(next)) {
          text += next;
          index += 2;
          continue;
        }
        text += character;
      } else if (quote) {
        if (character === quote) quote = undefined;
        else text += character;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (/\s/u.test(character)) {
        break;
      } else {
        if (character === ':' && separator === -1) separator = text.length;
        text += character;
      }
      index++;
    }
    if (quote) invalid(`Unclosed filter quote at character ${start + 1}.`);
    const name = separator === -1 ? null : text.slice(0, separator);
    const value = separator === -1 ? text : text.slice(separator + 1);
    if (!value || (name !== null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name))) {
      invalid(`Filter term at character ${start + 1} requires a value and, when qualified, a property name.`);
    }
    const property = name === null ? undefined : names.get(canonical(name));
    if (name !== null && !property) {
      invalid(`Unknown or unavailable filter property. Supported properties: ${properties.map(property => property.name).join(', ')}.`);
    }
    terms.push({ property: property?.name ?? null, path: property?.path ?? null, value: folded(value) });
    if (terms.length > 256) invalid('Filter must contain at most 256 terms.');
  }
  return terms;
}

function values(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === 'object') return Object.values(value).flatMap(values);
  return ['string', 'number', 'boolean'].includes(typeof value) ? [folded(value)] : [];
}

function propertyValue(item, path) {
  if (path === 'legacyDetails') {
    return { priority: item.priority, severity: item.severity, type: item.type, component: item.providerData?.component };
  }
  if (['author', 'assignees', 'reviewers'].includes(path) && item.identities) {
    const identities = item.identities[path];
    return [item[path], (Array.isArray(identities) ? identities : [identities])
      .map(identity => [identity?.id, identity?.login, identity?.displayName])];
  }
  let value = item;
  for (const name of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, name)) return undefined;
    value = value[name];
  }
  return value;
}

export function filterItems(items, terms, options) {
  if (terms.language === 'javascript') return filterJavaScriptItems(items, terms, options);
  if (!terms.length) return items;
  return items.filter(item => {
    const fields = new Map();
    return terms.every(term => {
      if (!fields.has(term.path)) {
        fields.set(term.path, values(term.path === null ? item : propertyValue(item, term.path)));
      }
      return fields.get(term.path).some(value => value.includes(term.value));
    });
  });
}
