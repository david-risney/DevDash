import { endianness } from 'node:os';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { DevDashError, errorJson } from './errors.js';
import { executeCommand } from './commands.js';
import { logEvent, safeCommand } from './diagnostics.js';
import { RESULT_FIELDS } from './results.js';
import { HOST_NAME } from './native-registration.js';

const MAX_MESSAGE = 1024 * 1024;
export { HOST_NAME } from './native-registration.js';

export function nativeManifest(extensionId, launcher) {
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) {
    throw new DevDashError('INVALID_ARGUMENT', '--extension-id must be a 32-character Chrome/Edge extension ID.');
  }
  if (!launcher || !isAbsolute(launcher)) {
    throw new DevDashError('INVALID_ARGUMENT', '--launcher must be an absolute path to the native host launcher.');
  }
  return {
    name: HOST_NAME,
    description: 'DevDash query profiles and cache',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function frameMessage(value) {
  let body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_MESSAGE) {
    const failure = errorJson(new DevDashError(
      'MESSAGE_TOO_LARGE', 'Result exceeds the 1 MiB native messaging limit. Use pageSize/fields or select one query.',
    ));
    body = Buffer.from(JSON.stringify(validRequestId(value?.id) ? { id: value.id, ...failure } : failure), 'utf8');
  }
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

const validRequestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value);
const validName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const invalid = message => { throw new DevDashError('INVALID_REQUEST', message); };

function requestArgs(request) {
  if (!request || Array.isArray(request) || typeof request !== 'object') {
    throw new DevDashError('INVALID_REQUEST', 'Native request must be an object.');
  }
  const fields = {
    hello: ['command'],
    health: ['command', 'profile', 'query'],
    profiles: ['command'],
    get: ['command', 'profile', 'all', 'cachedOnly', 'query', 'cacheMode', 'fastQueryMs', 'pageSize', 'cursor', 'fields'],
    refresh: ['command', 'profile', 'all', 'due', 'query'],
    'refresh-start': ['command', 'profile', 'due', 'query'],
    status: ['command', 'profile', 'all', 'query'],
    'profile-set': ['command', 'profile', 'definition'],
    'profile-remove': ['command', 'profile'],
    'query-get': ['command', 'profile', 'query'],
    'query-validate': ['command', 'profile', 'query', 'definition'],
    'query-set': ['command', 'profile', 'query', 'definition', 'expectedRevision'],
    'query-remove': ['command', 'profile', 'query', 'expectedRevision'],
    avatar: ['command', 'profile', 'query', 'itemId', 'repository', 'role', 'index', 'cacheRevision'],
  };
  if (typeof request.command !== 'string' || !Object.hasOwn(fields, request.command)) {
    invalid('Unknown native command. Use hello to discover supported capabilities.');
  }
  const allowed = new Set([...fields[request.command], 'id']);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new DevDashError('INVALID_REQUEST', `Unknown native request field "${key}".`);
  }
  if (request.id !== undefined && !validRequestId(request.id)) invalid('id must be a 1-80 character request identifier.');
  if (request.profile !== undefined && !validName(request.profile)) {
    invalid('profile must be a valid profile name.');
  }
  if (request.query !== undefined && (typeof request.query !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request.query) || !request.profile || request.all)) {
    throw new DevDashError('INVALID_REQUEST', 'query must be a valid named query selected with one profile, not all.');
  }
  for (const key of ['all', 'cachedOnly', 'due']) {
    if (request[key] !== undefined && typeof request[key] !== 'boolean') {
      throw new DevDashError('INVALID_REQUEST', `${key} must be a boolean.`);
    }
    if (request.pageSize !== undefined && (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 200)) {
      invalid('pageSize must be an integer from 1 to 200.');
    }
    if (request.cursor !== undefined && (typeof request.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(request.cursor))) {
      invalid('cursor must be a valid page cursor.');
    }
    if (request.fields !== undefined && (!Array.isArray(request.fields) || !request.fields.length ||
        request.fields.length > RESULT_FIELDS.length || request.fields.some(field => !RESULT_FIELDS.includes(field)) ||
        new Set(request.fields).size !== request.fields.length)) {
      invalid('fields must contain unique normalized result field names.');
    }
    if ((request.pageSize !== undefined || request.cursor !== undefined || request.fields !== undefined) && request.all) {
      invalid('Paging requires one selected query, not all profiles.');
    }
  }
  if ((request.cacheMode !== undefined && !['cache-first', 'adaptive'].includes(request.cacheMode)) ||
      (request.fastQueryMs !== undefined && (request.cacheMode !== 'adaptive' ||
        !Number.isInteger(request.fastQueryMs) || request.fastQueryMs < 1 || request.fastQueryMs > 60_000)) ||
      (request.cacheMode === 'adaptive' && request.cachedOnly)) {
    throw new DevDashError('INVALID_REQUEST', 'Invalid adaptive cache policy or fast-query threshold.');
  }
  if (request.command === 'hello') return ['hello'];
  if (request.command === 'health') {
    const args = ['doctor'];
    if (request.profile !== undefined) args.push(request.profile);
    if (request.query !== undefined) args.push('--query', request.query);
    return args;
  }
  if (request.command === 'profiles') return ['profile', 'list'];
  if (Boolean(request.profile) === Boolean(request.all)) invalid('Specify one profile or all, but not both.');
  if (request.command === 'profile-set' || request.command === 'profile-remove') {
    if (!request.profile) throw new DevDashError('INVALID_REQUEST', 'A profile name is required.');
    if (request.command === 'profile-set') {
      if (!request.definition || Array.isArray(request.definition) || typeof request.definition !== 'object') {
        throw new DevDashError('INVALID_REQUEST', 'profile-set requires a JSON profile object in definition.');
      }
      return ['profile', 'set', request.profile, '--file', '-'];
    }
    return ['profile', 'remove', request.profile];
  }
  if (request.command.startsWith('query-')) {
    if (!validName(request.query)) invalid('A named query is required.');
    if (['query-set', 'query-validate'].includes(request.command) &&
        (!request.definition || Array.isArray(request.definition) || typeof request.definition !== 'object')) {
      invalid('A JSON query object is required in definition.');
    }
    if (['query-set', 'query-remove'].includes(request.command) &&
        (typeof request.expectedRevision !== 'string' ||
          (request.expectedRevision !== 'missing' && !/^[a-f0-9]{64}$/.test(request.expectedRevision)))) {
      invalid('expectedRevision must be the current revision, or missing for a new query.');
    }
    const args = ['query', request.command.slice(6), request.profile, request.query];
    if (['query-set', 'query-validate'].includes(request.command)) args.push('--file', '-');
    if (request.expectedRevision !== undefined) args.push('--expected-revision', request.expectedRevision);
    return args;
  }
  if (request.command === 'avatar') {
    if (typeof request.itemId !== 'string' || !request.itemId || request.itemId.length > 256 ||
        /[\u0000-\u001f]/.test(request.itemId) || request.itemId.startsWith('-')) invalid('itemId must identify one cached item.');
    if (request.repository !== undefined && (typeof request.repository !== 'string' || !request.repository.trim() ||
        request.repository.length > 512 || /[\u0000-\u001f\u007f]/.test(request.repository) ||
        request.repository.startsWith('-'))) invalid('repository must identify a cached repository.');
    if (request.role !== undefined && !['author', 'assignee', 'reviewer'].includes(request.role)) invalid('Invalid avatar identity role.');
    if (request.index !== undefined && (!Number.isInteger(request.index) || request.index < 0 || request.index > 1000)) invalid('Invalid identity index.');
    if (request.cacheRevision !== undefined && (typeof request.cacheRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.cacheRevision))) {
      invalid('cacheRevision must be a cached snapshot revision.');
    }
    const args = ['avatar', request.profile, '--item-id', request.itemId];
    if (request.query !== undefined) args.push('--query', request.query);
    if (request.repository !== undefined) args.push('--repository', request.repository);
    if (request.role !== undefined) args.push('--role', request.role);
    if (request.index !== undefined) args.push('--index', String(request.index));
    if (request.cacheRevision !== undefined) args.push('--cache-revision', request.cacheRevision);
    return args;
  }
  const args = request.command === 'status' ? ['cache', 'status']
    : request.command === 'refresh-start' ? ['refresh'] : [request.command];
  if (request.profile !== undefined) args.push(request.profile);
  if (request.all) args.push('--all');
  if (request.cachedOnly) args.push('--cached-only');
  if (request.due) args.push('--due');
  if (request.query !== undefined) args.push('--query', request.query);
  if (request.cacheMode !== undefined) args.push('--cache-mode', request.cacheMode);
  if (request.fastQueryMs !== undefined) args.push('--fast-query-ms', String(request.fastQueryMs));
  if (request.command === 'refresh-start') args.push('--background');
  if (request.pageSize !== undefined) args.push('--page-size', String(request.pageSize));
  if (request.cursor !== undefined) args.push('--cursor', request.cursor);
  if (request.fields !== undefined) args.push('--fields', request.fields.join(','));
  return args;
}

async function writeFrame(output, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MESSAGE) {
    await logEvent('native.response.failed', { code: 'MESSAGE_TOO_LARGE' });
  }
  const frame = frameMessage(value);
  await new Promise((resolve, reject) => {
    output.write(frame, (error) => error ? reject(error) : resolve());
  });
}

export async function serveNative(input, output, dependencies = {}) {
  let pending = Buffer.alloc(0);
  const running = new Set();
  const ids = new Set();
  let writing = Promise.resolve();
  let failure;
  const respond = value => {
    writing = writing.then(() => writeFrame(output, value));
    return writing;
  };
  const processBody = async body => {
    let request;
    let response;
    let ownsId = false;
    const action = async () => {
      try { request = JSON.parse(body.toString('utf8')); } catch {
        throw new DevDashError('INVALID_JSON', 'Native message must contain valid JSON.');
      }
      const args = requestArgs(request);
      if (request.id !== undefined) {
        if (ids.has(request.id)) invalid('This request id is already in flight.');
        ids.add(request.id);
        ownsId = true;
      }
      await dependencies.service?.diagnostics.log('native.request.parsed', { command: safeCommand(args) });
      const definition = ['profile-set', 'query-set', 'query-validate'].includes(request.command);
      const { output: result } = await (dependencies.executeCommand ?? executeCommand)(
        args, definition ? { ...dependencies, stdin: Readable.from([JSON.stringify(request.definition)]) } : dependencies,
      );
      return result;
    };
    try {
      const result = dependencies.service?.diagnostics
        ? await dependencies.service.diagnostics.run('native.request', {}, action, { newRequest: true })
        : await action();
      response = validRequestId(request?.id) ? { id: request.id, result } : result;
    } catch (error) {
      response = validRequestId(request?.id) ? { id: request.id, ...errorJson(error) } : errorJson(error);
    }
    try { await respond(response); } finally {
      if (ownsId) ids.delete(request.id);
    }
  };
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
        if (length > MAX_MESSAGE) throw new DevDashError('MESSAGE_TOO_LARGE', 'Native requests are limited to 1 MiB.');
        if (pending.length < length + 4) break;
        const body = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        let correlated = false;
        try { correlated = validRequestId(JSON.parse(body.toString('utf8'))?.id); } catch { /* Report malformed JSON through the normal response. */ }
        if (!correlated) {
          await Promise.all(running);
          await processBody(body);
        } else {
          while (running.size >= 4) await Promise.race(running);
          const task = processBody(body);
          running.add(task);
          task.then(() => running.delete(task), error => { failure ??= error; running.delete(task); });
        }
        if (failure) throw failure;
      }
    }
    if (pending.length !== 0) throw new DevDashError('INVALID_FRAME', 'Native input ended in a partial message.');
  } finally {
    await Promise.allSettled(running);
  }
  if (failure) throw failure;
}
