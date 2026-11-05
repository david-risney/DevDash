import { endianness } from 'node:os';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { DevDashError, errorJson } from './errors.js';
import { executeCommand } from './commands.js';
import { logEvent, safeCommand } from './diagnostics.js';

const MAX_MESSAGE = 1024 * 1024;
export const HOST_NAME = 'com.devdash.cli';

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
    body = Buffer.from(JSON.stringify(errorJson(new DevDashError(
      'MESSAGE_TOO_LARGE', 'Result exceeds the 1 MiB native messaging limit. Reduce the profile limit or request one profile at a time.',
    ))), 'utf8');
  }
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function requestArgs(request) {
  if (!request || Array.isArray(request) || typeof request !== 'object') {
    throw new DevDashError('INVALID_REQUEST', 'Native request must be an object.');
  }
  const fields = {
    profiles: ['command'],
    get: ['command', 'profile', 'all', 'cachedOnly', 'query'],
    refresh: ['command', 'profile', 'all', 'due', 'query'],
    status: ['command', 'profile', 'all', 'query'],
    'profile-set': ['command', 'profile', 'definition'],
    'profile-remove': ['command', 'profile'],
  };
  if (typeof request.command !== 'string' || !Object.hasOwn(fields, request.command)) {
    throw new DevDashError('INVALID_REQUEST', 'Native command must be profiles, get, refresh, status, profile-set, or profile-remove.');
  }
  const allowed = new Set(fields[request.command]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new DevDashError('INVALID_REQUEST', `Unknown native request field "${key}".`);
  }
  if (typeof request.profile !== 'undefined' && typeof request.profile !== 'string') {
    throw new DevDashError('INVALID_REQUEST', 'profile must be a string.');
  }
  if (request.query !== undefined && (typeof request.query !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request.query) || !request.profile || request.all)) {
    throw new DevDashError('INVALID_REQUEST', 'query must be a valid named query selected with one profile, not all.');
  }
  for (const key of ['all', 'cachedOnly', 'due']) {
    if (request[key] !== undefined && typeof request[key] !== 'boolean') {
      throw new DevDashError('INVALID_REQUEST', `${key} must be a boolean.`);
    }
  }
  if (request.command === 'profiles') {
    return ['profile', 'list'];
  }
  if (request.profile?.startsWith('-')) {
    throw new DevDashError('INVALID_REQUEST', 'Invalid profile name.');
  }
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
  const args = request.command === 'status' ? ['cache', 'status'] : [request.command];
  if (request.profile !== undefined) args.push(request.profile);
  if (request.all) args.push('--all');
  if (request.cachedOnly) args.push('--cached-only');
  if (request.due) args.push('--due');
  if (request.query !== undefined) args.push('--query', request.query);
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
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
      if (length > MAX_MESSAGE) {
        throw new DevDashError('MESSAGE_TOO_LARGE', 'Native requests are limited to 1 MiB.');
      }
      if (pending.length < length + 4) break;
      const body = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      let response;
      const processRequest = async () => {
        let request;
        try { request = JSON.parse(body.toString('utf8')); } catch {
          throw new DevDashError('INVALID_JSON', 'Native message must contain valid JSON.');
        }
        const args = requestArgs(request);
        await dependencies.service?.diagnostics.log('native.request.parsed', { command: safeCommand(args) });
        const { output: result } = await (dependencies.executeCommand ?? executeCommand)(
          args,
          request.command === 'profile-set'
            ? { ...dependencies, stdin: Readable.from([JSON.stringify(request.definition)]) }
            : dependencies,
        );
        return result;
      };
      try {
        response = dependencies.service?.diagnostics
          ? await dependencies.service.diagnostics.run('native.request', {}, processRequest, { newRequest: true })
          : await processRequest();
      } catch (error) {
        response = errorJson(error);
      }
      await writeFrame(output, response);
    }
  }
  if (pending.length !== 0) throw new DevDashError('INVALID_FRAME', 'Native input ended in a partial message.');
}
