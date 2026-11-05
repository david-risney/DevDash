import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const credentialPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:_authToken|password|client_secret)\s*[=:]\s*["']?[A-Za-z0-9/+_-]{24,}/i,
];
const privateScopes = [
  /https:\/\/dev\.azure\.com\/microsoft(?:[/\s"']|$)/i,
  /https:\/\/[^/\s"']+\.pkgs\.visualstudio\.com\//i,
  /https:\/\/pkgs\.dev\.azure\.com\//i,
];
const localData = /(?:^|\/)(?:\.npmrc|\.devdash|\.cr|auth-state|playwright-report|test-results)(?:\/|$)|(?:^|\/)playwright\/\.auth\/|(?:^|\/)[^/]*\.e2e\.local\.json$/;

function credentialUrl(text, syntheticFixtures) {
  const matches = text.match(/https:\/\/[^/\s"'<>]+:[^/\s"'<>]+@[^/\s"'<>]+/g) ?? [];
  return matches.some(value => {
    if (!syntheticFixtures) return true;
    let url;
    try { url = new URL(value); } catch { return true; }
    return !((url.hostname === 'example.com' || url.hostname.endsWith('.example.com')) &&
      ['user', 'token', 'name'].includes(url.username) &&
      ['secret', 'password', 'pass', 'token'].includes(url.password));
  });
}

export function inspectPublicText(text, { syntheticFixtures = false } = {}) {
  return [
    ...(credentialPatterns.some(pattern => pattern.test(text)) || credentialUrl(text, syntheticFixtures) ? ['credential-pattern'] : []),
    ...(privateScopes.some(pattern => pattern.test(text)) ? ['organization-specific-scope'] : []),
  ];
}

export async function checkPublicFiles() {
  const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024,
  });
  const files = [...new Set(stdout.split('\0').filter(Boolean))];
  const findings = [];
  for (const file of files) {
    if (localData.test(file)) {
      findings.push({ file, category: 'local-auth-or-test-data' });
      continue;
    }
    if (!/\.(?:js|json|md|ya?ml|cmd|ps1)$/.test(file) && file !== '.gitignore') continue;
    const text = await readFile(resolve(root, ...file.split('/')), 'utf8');
    for (const category of inspectPublicText(text, { syntheticFixtures: /^(?:test\/|packages\/cr\/test\/)/.test(file) })) {
      findings.push({ file, category });
    }
  }
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  for (const value of Object.values(lock.packages ?? {})) {
    if (value.resolved && !value.link && !value.resolved.startsWith('https://registry.npmjs.org/')) {
      findings.push({ file: 'package-lock.json', category: 'nonpublic-dependency-registry' });
      break;
    }
  }
  return { schemaVersion: 1, checked: files.length, findings, failed: findings.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkPublicFiles();
    console.log(JSON.stringify(result));
    process.exitCode = result.failed ? 1 : 0;
  } catch {
    console.error(JSON.stringify({ error: { code: 'PUBLIC_CHECK_FAILED', message: 'Could not inspect public repository candidates. No file contents were printed.' } }));
    process.exitCode = 1;
  }
}
