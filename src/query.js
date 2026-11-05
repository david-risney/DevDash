import { DevDashError } from './errors.js';

export function providerProfile(profile) {
  const { filter, presentation, ...definition } = profile;
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
