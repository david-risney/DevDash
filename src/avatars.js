import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DevDashError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { runJson } from './process.js';
import { githubToken } from './github-auth.js';

const MAX_BYTES = 128 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function avatarUrl(value, profile) {
  let url;
  try { url = new URL(value); } catch { throw new DevDashError('AVATAR_UNAVAILABLE', 'This identity has no supported avatar URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new DevDashError('AVATAR_UNAVAILABLE', 'Avatar URLs must use HTTPS without credentials or fragments.');
  }
  let allowed = false;
  if (profile.provider === 'github') {
    allowed = url.origin === 'https://avatars.githubusercontent.com' ||
      url.origin === `https://${profile.hostname ?? 'github.com'}`;
  } else if (profile.provider === 'chromium' && profile.resource === 'cls') {
    allowed = url.origin === new URL(profile.host ?? 'https://chromium-review.googlesource.com').origin;
  } else if (profile.provider === 'ado') {
    const organization = new URL(profile.organization);
    const prefix = organization.pathname.replace(/\/+$/, '') + '/';
    allowed = url.origin === organization.origin &&
      (organization.hostname.endsWith('.visualstudio.com') || url.pathname.startsWith(prefix));
    if (organization.hostname === 'dev.azure.com') {
      allowed ||= url.origin === 'https://vssps.dev.azure.com' && url.pathname.startsWith(prefix);
    }
  }
  if (!allowed) throw new DevDashError('AVATAR_UNAVAILABLE', 'Avatar destination is outside this provider scope.');
  return url.href;
}

function imageMatches(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return mimeType === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

export async function fetchAvatar(identity, profile, paths, dependencies = {}) {
  const url = avatarUrl(identity?.avatarUrl, profile);
  const key = createHash('sha256').update(`${paths.config}\0${profile.provider}\0${profile.auth ?? ''}\0${profile.account ?? ''}\0${url}`).digest('hex');
  const path = join(paths.cache, 'avatars', `${key}.json`);
  const now = dependencies.now ?? Date.now;
  const cached = await readJson(path);
  if (cached) {
    const bytes = typeof cached.base64 === 'string' && cached.base64.length <= Math.ceil(MAX_BYTES / 3) * 4
      ? Buffer.from(cached.base64, 'base64') : Buffer.alloc(0);
    if (cached.schemaVersion !== 1 || !Number.isFinite(Date.parse(cached.expiresAt)) ||
        !MIME_TYPES.has(cached.mimeType) || !bytes.length || bytes.length > MAX_BYTES || !imageMatches(bytes, cached.mimeType)) {
      throw new DevDashError('INVALID_CACHE', `Invalid avatar cache at ${path}. Remove this file and retry.`);
    }
    if (now() < Date.parse(cached.expiresAt)) {
      return { mimeType: cached.mimeType, dataUrl: `data:${cached.mimeType};base64,${cached.base64}`, fromCache: true };
    }
  }
  const headers = { Accept: 'image/png,image/jpeg,image/gif,image/webp' };
  if (profile.provider === 'github' && profile.auth !== 'anonymous' &&
      new URL(url).origin === `https://${profile.hostname ?? 'github.com'}`) {
    const token = await githubToken(profile, dependencies);
    headers.Authorization = `Bearer ${token}`;
  }
  if (profile.provider === 'ado') {
    const env = dependencies.env ?? process.env;
    if (env.AZURE_DEVOPS_EXT_PAT) {
      headers.Authorization = `Basic ${Buffer.from(`:${env.AZURE_DEVOPS_EXT_PAT}`).toString('base64')}`;
    } else {
      const token = await (dependencies.runJson ?? runJson)('az', [
        'account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--output', 'json',
      ]);
      if (typeof token?.accessToken !== 'string' || !token.accessToken || /[\r\n]/.test(token.accessToken)) {
        throw new DevDashError('AVATAR_FAILED', 'Azure CLI did not return a valid access token for avatar retrieval.');
      }
      headers.Authorization = `Bearer ${token.accessToken}`;
    }
  }
  let response;
  let bytes;
  let mimeType;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(url, {
      headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DevDashError('AVATAR_FAILED', `Avatar retrieval failed (HTTP ${response.status}).`);
    mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!MIME_TYPES.has(mimeType)) throw new DevDashError('AVATAR_FAILED', 'Avatar response is not a supported raster image.');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel();
      throw new DevDashError('AVATAR_TOO_LARGE', 'Avatars are limited to 128 KiB.');
    }
    if (!response.body) throw new DevDashError('AVATAR_FAILED', 'Avatar response has no image body.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new DevDashError('AVATAR_TOO_LARGE', 'Avatars are limited to 128 KiB.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(chunks);
    if (!imageMatches(bytes, mimeType)) throw new DevDashError('AVATAR_FAILED', 'Avatar body does not match its image type.');
  } catch (error) {
    if (error instanceof DevDashError) throw error;
    throw new DevDashError('AVATAR_FAILED', 'Avatar retrieval failed or timed out.', { cause: error });
  }
  const base64 = bytes.toString('base64');
  await writeJson(path, { schemaVersion: 1, mimeType, base64, expiresAt: new Date(now() + 6 * 3600_000).toISOString() });
  return { mimeType, dataUrl: `data:${mimeType};base64,${base64}`, fromCache: false };
}
