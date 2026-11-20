import { DevDashError } from './errors.js';
import defaults from './default-config.json' with { type: 'json' };

const variablePattern = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const invalid = message => { throw new DevDashError('INVALID_CONFIG', message); };

export const defaultConfig = () => structuredClone(defaults);
export const isRemoteProfile = profile => Object.hasOwn(profile, 'remoteUrls');

export function normalizeRemote(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  const scp = value.match(/^(?:[^/@:]+@)?([^/:]+):([^/].*)$/);
  if (!value.includes('://') && scp) value = `ssh://${scp[1]}/${scp[2]}`;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
  if (url.port && !((url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'ssh:' && url.port === '22'))) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  const adoSsh = url.hostname === 'ssh.dev.azure.com' && path.match(/^\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (adoSsh) return `https://dev.azure.com/${adoSsh[1]}/${adoSsh[2]}/_git/${adoSsh[3]}`;
  if (!path || path === '/') return null;
  return `https://${url.hostname}${path}`;
}

export function compileRemoteTemplate(template) {
  if (typeof template !== 'string') invalid('remoteUrls must contain URL templates.');
  const variables = [...template.matchAll(variablePattern)].map(match => match[1]);
  // Substitute URL-safe sentinels while normalizing schemes, credentials, and .git.
  let prefix = 'devdashvariable';
  while (template.toLowerCase().includes(prefix)) prefix += 'x';
  const sentinels = variables.map((_, index) => `${prefix}${index}x`);
  let index = 0;
  const normalized = normalizeRemote(template.replace(variablePattern, () => sentinels[index++]));
  if (!normalized || /[{}]/.test(template.replace(variablePattern, ''))) {
    invalid('remoteUrls must contain HTTPS, SSH, or git URL templates with {variable} placeholders.');
  }
  const pieces = normalized.split(new RegExp(`(${prefix}\\d+x)`));
  const captures = [];
  const pattern = pieces.map((piece, i) => {
    const position = sentinels.indexOf(piece);
    if (position === -1) return escape(piece);
    captures.push(variables[position]);
    // A final path capture also supports Gerrit projects such as chromium/src.
    const inPath = normalized.indexOf(piece) > normalized.indexOf('/', 8);
    return inPath ? (i === pieces.length - 2 ? '(.+)' : '([^/]+)') : '([^/:]+)';
  }).join('');
  if (variables.some(name => !captures.includes(name))) {
    invalid('URL variables must appear in the host or path, not in credentials.');
  }
  return { regex: new RegExp(`^${pattern}$`), variables: new Set(variables), captures };
}

export function substituteProfile(value, variables) {
  if (typeof value === 'string') return value.replace(variablePattern, (_, name) => {
    if (!Object.hasOwn(variables, name)) invalid(`Profile template references undeclared variable {${name}}.`);
    return variables[name];
  });
  if (Array.isArray(value)) return value.map(entry => substituteProfile(entry, variables));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteProfile(entry, variables)]));
  }
  return value;
}

export function validateRemoteProfile(profile) {
  const { remoteUrls, ...definition } = profile;
  for (const template of remoteUrls) {
    const { variables } = compileRemoteTemplate(template);
    substituteProfile(definition, Object.fromEntries([...variables].map(name => [name, 'example'])));
  }
}

export function matchRemoteProfile(profile, remote) {
  for (const template of profile.remoteUrls) {
    const { regex, captures } = compileRemoteTemplate(template);
    const match = regex.exec(remote);
    if (!match) continue;
    const variables = Object.create(null);
    let valid = true;
    for (let index = 0; index < captures.length; index++) {
      let value;
      try { value = decodeURIComponent(match[index + 1]); } catch { valid = false; break; }
      if (!value || /[\u0000-\u001f\u007f]/.test(value) ||
          (Object.hasOwn(variables, captures[index]) && variables[captures[index]] !== value)) {
        valid = false; break;
      }
      variables[captures[index]] = value;
    }
    if (valid) {
      const { remoteUrls, ...definition } = profile;
      return { variables: { ...variables }, definition: substituteProfile(definition, variables) };
    }
  }
  return null;
}
