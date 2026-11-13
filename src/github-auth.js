import { DevDashError } from './errors.js';
import { runText } from './process.js';

const credentialVariables = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

export async function githubToken(profile, dependencies = {}) {
  const args = ['auth', 'token', '--hostname', profile.hostname ?? 'github.com'];
  const env = { ...(dependencies.env ?? process.env) };
  if (profile.account !== undefined) {
    args.push('--user', profile.account);
    for (const name of credentialVariables) env[name] = '';
  }
  let token;
  try {
    token = await (dependencies.runText ?? runText)('gh', args, { env });
  } catch (error) {
    if (['CLI_NOT_FOUND', 'LOG_WRITE_FAILED', 'GITHUB_SSO_REQUIRED'].includes(error.code)) throw error;
    throw new DevDashError('CLI_FAILED', 'Could not obtain the selected GitHub account credential. Check gh authentication for this host and account.');
  }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token.trim())) {
    throw new DevDashError('CLI_FAILED', 'GitHub CLI did not return a valid account credential.');
  }
  return token.trim();
}

export async function githubAccountOptions(profile, dependencies = {}) {
  if (profile.account === undefined) return undefined;
  const token = await githubToken(profile, dependencies);
  const env = { ...(dependencies.env ?? process.env) };
  for (const name of credentialVariables) env[name] = '';
  const hostname = (profile.hostname ?? 'github.com').toLowerCase();
  env[hostname === 'github.com' || hostname.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'] = token;
  return { env };
}
