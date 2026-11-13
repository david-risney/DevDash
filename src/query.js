import { DevDashError } from './errors.js';

export function githubRepositories(profile) {
  return profile.repositories ?? (profile.repository === undefined ? [] : [profile.repository]);
}

export function providerProfile(profile) {
  const { filter, presentation, ...definition } = profile;
  if (definition.auth !== undefined &&
      (definition.provider !== 'github' || !['gh', 'anonymous'].includes(definition.auth))) {
    throw new DevDashError('INVALID_PROFILE', 'GitHub auth must be gh or anonymous.');
  }
  if (definition.provider === 'github') {
    const repository = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
    if ((definition.repository !== undefined && !repository(definition.repository)) ||
        (definition.repositories !== undefined && (!Array.isArray(definition.repositories) ||
          definition.repositories.length < 1 || definition.repositories.length > 100 ||
          definition.repositories.some(value => !repository(value)) ||
          new Set(definition.repositories.map(value => value.toLowerCase())).size !== definition.repositories.length)) ||
        (definition.repository !== undefined && definition.repositories !== undefined)) {
      throw new DevDashError('INVALID_PROFILE', 'GitHub scope requires either repository or 1-100 unique repositories in owner/repository form, or neither for cross-repository search.');
    }
    if (definition.hostname !== undefined &&
        (typeof definition.hostname !== 'string' || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/.test(definition.hostname))) {
      throw new DevDashError('INVALID_PROFILE', 'GitHub hostname must be a hostname without a scheme or path.');
    }
  }
  if (definition.account !== undefined &&
      (definition.provider !== 'github' || definition.auth === 'anonymous' ||
        typeof definition.account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(definition.account))) {
    throw new DevDashError('INVALID_PROFILE', 'account requires a GitHub login using gh authentication, not anonymous access.');
  }
  if (definition.repositories !== undefined && definition.provider !== 'github') {
    throw new DevDashError('INVALID_PROFILE', 'repositories is supported only for GitHub queries.');
  }
  const textValue = value => typeof value === 'string' && value.trim() && value.length <= 32768 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const textArray = value => Array.isArray(value) && value.length >= 1 && value.length <= 20 &&
    value.every(textValue) && new Set(value).size === value.length;
  if (definition.include !== undefined) {
    const include = definition.include;
    if (definition.provider !== 'ado' || definition.resource !== 'prs' || !include ||
        typeof include !== 'object' || Array.isArray(include) ||
        Object.keys(include).length !== 1 || !Object.hasOwn(include, 'properties') ||
        !textArray(include.properties) ||
        include.properties.some(name => name.length > 256 || name.includes(','))) {
      throw new DevDashError('INVALID_PROFILE', 'include.properties requires 1-20 unique ADO PR property names of at most 256 characters without commas or control characters.');
    }
  }
  if (definition.workItemTypes !== undefined &&
      (definition.provider !== 'ado' || definition.resource !== 'bugs' || !textArray(definition.workItemTypes))) {
    throw new DevDashError('INVALID_PROFILE', 'workItemTypes requires 1-20 unique nonempty ADO work-item type names.');
  }
  if (definition.query === undefined) return definition;
  if (typeof definition.query === 'string') {
    if (definition.provider === 'ado' && definition.resource === 'prs') {
      throw new DevDashError('INVALID_PROFILE', 'This provider/resource requires an object query.');
    }
    if (definition.provider === 'chromium' && definition.resource === 'bugs' &&
        (definition.bugIds !== undefined || !definition.query.trim() || definition.query.length > 32768 ||
          /[\u0000-\u001f\u007f]/.test(definition.query))) {
      throw new DevDashError('INVALID_PROFILE', 'Chromium bug search requires a nonempty query without control characters or legacy bug IDs.');
    }
    return definition;
  }
  const { query, ...scope } = definition;
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new DevDashError('INVALID_PROFILE', 'Provider query must use the supported string or object form.');
  }
  const validate = (allowed) => {
    if (Object.keys(query).some(name => !allowed.includes(name))) {
      throw new DevDashError('INVALID_PROFILE', 'Provider query contains unsupported parameters.');
    }
    for (const [name, value] of Object.entries(query)) {
      if (name === 'bugIds') continue;
      if (['author', 'reviewer'].includes(name) && Array.isArray(value)) {
        if (!textArray(value)) throw new DevDashError('INVALID_PROFILE', 'Author/reviewer arrays require 1-20 unique nonempty identities.');
        continue;
      }
      if (typeof value !== 'string' || !value.trim() || value.length > 32768 ||
          (name === 'wiql' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) {
        throw new DevDashError('INVALID_PROFILE', 'Provider query parameters must be nonempty strings without invalid control characters.');
      }
    }
  };
  if (definition.provider === 'ado' && definition.resource === 'bugs') {
    validate(['wiql', 'queryId']);
    if (definition.queryId !== undefined || Number(query.wiql !== undefined) + Number(query.queryId !== undefined) !== 1) {
      throw new DevDashError('INVALID_PROFILE', 'ADO bug queries require exactly one WIQL or saved-query ID.');
    }
    return query.wiql !== undefined ? { ...scope, query: query.wiql } : { ...scope, queryId: query.queryId };
  }
  if (definition.provider === 'ado' && definition.resource === 'prs') {
    const fields = { author: 'creator', reviewer: 'reviewer', status: 'status', sourceBranch: 'sourceBranch', targetBranch: 'targetBranch' };
    validate(Object.keys(fields));
    if (['creator', 'reviewer', 'status', 'sourceBranch', 'targetBranch'].some(name => scope[name] !== undefined)) {
      throw new DevDashError('INVALID_PROFILE', 'Object PR queries cannot be combined with legacy top-level query parameters.');
    }
    if (query.status !== undefined && !['active', 'completed', 'abandoned', 'all'].includes(query.status)) {
      throw new DevDashError('INVALID_PROFILE', 'ADO PR query status must be active, completed, abandoned, or all.');
    }
    for (const [name, field] of Object.entries(fields)) {
      if (query[name] !== undefined) scope[field] = query[name];
    }
    return scope;
  }
  if (definition.provider === 'chromium' && definition.resource === 'bugs') {
    validate(['bugIds']);
    if (definition.bugIds !== undefined || !Array.isArray(query.bugIds) ||
        query.bugIds.length < 1 || query.bugIds.length > 100 ||
        query.bugIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) ||
        new Set(query.bugIds).size !== query.bugIds.length) {
      throw new DevDashError('INVALID_PROFILE', 'Chromium bug queries require 1-100 unique numeric string bugIds without legacy selectors.');
    }
    return { ...scope, bugIds: query.bugIds };
  }
  throw new DevDashError('INVALID_PROFILE', 'This provider/resource does not support an object query.');
}
