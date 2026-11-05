import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { DevDash, failedProfiles } from './service.js';
import { DevDashError, errorJson } from './errors.js';
import { loadConfig } from './config.js';
import { runJson, runText } from './process.js';
import { safeCommand, providerProcessOptions } from './diagnostics.js';
import { readResultJson } from './format.js';

export const help = {
  name: 'devdash',
  version: '0.1.0',
  usage: 'devdash <command> [arguments] [options]',
  commands: {
    init: 'Create an empty config, without overwriting an existing file.',
    'config show': 'Read and validate the JSON configuration.',
    'config validate [file]': 'Validate the current configuration or a supplied file.',
    'profile list': 'List named profiles.',
    'profile get <name>': 'Read one profile.',
    'profile set <name> --file <file|->': 'Create or replace a profile using JSON (or stdin).',
    'profile remove <name>': 'Remove a profile and its cache.',
    'get <name> | get --all': 'Use fresh cached results, querying when missing or expired.',
    'get <name> --cached-only': 'Read cache only, including explicitly marked stale results.',
    'refresh <name> | refresh --all [--due]': 'Force refresh, or refresh only expired entries with --due.',
    'format [--format <json|ansi|ascii|md>]': 'Read one query-result JSON document from stdin; render without querying or changing caches.',
    'cache status <name> | cache status --all': 'Read freshness and count metadata without querying.',
    'cache clear <name> | cache clear --all': 'Delete cached results.',
    'watch [name] [--interval <seconds>]': 'Refresh due profiles in the foreground; output JSON lines.',
    doctor: 'Check Node, gh, az, cr, and the Azure DevOps extension.',
    'logs path': 'Show diagnostic log location and retention limits.',
    'logs tail [--lines <count>] [--errors]': 'Read recent structured diagnostic records (default 100).',
    'native-host': 'Serve length-prefixed JSON requests for a registered browser native host.',
    'native-manifest --extension-id <id> --launcher <absolute-path>': 'Output a native host manifest (registration is manual).',
  },
  options: {
    '--home <directory>': 'Data directory; defaults to DEVDASH_HOME or ~/.devdash.',
    '--config <file>': 'Override the configuration file; caches are scoped to that file.',
    '--user-config <file>': 'Override user presentation defaults (normally <home>/user.config.json); JSON output is unaffected.',
    '--query <name>': 'Select one named query for get, refresh, cache status/clear, or watch; requires a profile.',
    '--pretty': 'Indent JSON output.',
    '--format <json|ansi|ascii|md>': 'Output format for get, refresh, format, or watch (default json). Other commands remain JSON-only.',
    '--help': 'Print this JSON command reference.',
    '--version': 'Print JSON version information.',
  },
};

export function parseCommand(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        home: { type: 'string' },
        config: { type: 'string' },
        'user-config': { type: 'string' },
        file: { type: 'string' },
        all: { type: 'boolean' },
        due: { type: 'boolean' },
        'cached-only': { type: 'boolean' },
        pretty: { type: 'boolean' },
        format: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        interval: { type: 'string' },
        'extension-id': { type: 'string' },
        launcher: { type: 'string' },
        lines: { type: 'string' },
        errors: { type: 'boolean' },
        query: { type: 'string' },
      },
    });
  } catch (error) {
    throw new DevDashError('INVALID_ARGUMENT', error.message);
  }
  const format = parsed.values.format ?? 'json';
  if (!['json', 'ansi', 'ascii', 'md'].includes(format)) {
    throw new DevDashError('INVALID_ARGUMENT', '--format must be json, ansi, ascii, or md.');
  }
  if (format !== 'json' && parsed.values.pretty) {
    throw new DevDashError('INVALID_ARGUMENT', '--pretty is only supported with JSON output.');
  }
  if (format !== 'json' && !['get', 'refresh', 'format', 'watch'].includes(parsed.positionals[0])) {
    throw new DevDashError('INVALID_ARGUMENT', 'Human-readable formats require get, refresh, format, or watch.');
  }
  return parsed;
}

function argumentsFor(positionals, options, count, allowed = []) {
  if (positionals.length !== count) {
    throw new DevDashError('INVALID_ARGUMENT', 'Unexpected or missing arguments; run devdash --help.');
  }
  for (const key of Object.keys(options)) {
    if (!['home', 'config', 'user-config', 'pretty', 'format', ...allowed].includes(key)) {
      throw new DevDashError('INVALID_ARGUMENT', `--${key} is not supported by this command.`);
    }
  }
}

async function stdinText(input) {
  let text = '';
  let size = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) {
      throw new DevDashError('INPUT_TOO_LARGE', 'Profile JSON exceeds 1 MiB.');
    }
    text += decoder.write(bytes);
  }
  return text + decoder.end();
}

async function mapProfiles(service, name, options, action) {
  if (Boolean(name) === Boolean(options.all)) {
    throw new DevDashError('INVALID_ARGUMENT', 'Specify one profile name or --all, but not both.');
  }
  if (options.query !== undefined && options.all) {
    throw new DevDashError('INVALID_ARGUMENT', '--query cannot be combined with --all.');
  }
  if (name) return action(name);
  const config = await service.config();
  const results = [];
  for (const profile of Object.keys(config.profiles)) {
    try { results.push(await action(profile)); } catch (error) {
      results.push({ profile, ...errorJson(error) });
    }
  }
  return { schemaVersion: 1, results, failed: failedProfiles(results) };
}

export async function executeCommand(args, dependencies = {}) {
  const { values: options, positionals } = parseCommand(args);
  const [command] = positionals;
  const service = dependencies.service ?? new DevDash(options);
  if (options.version) return { output: { name: help.name, version: help.version }, exitCode: 0 };
  if (options.help || !command) return { output: help, exitCode: 0 };
  return service.diagnostics.run('command', { command: safeCommand(positionals) }, () =>
    dispatchCommand(positionals, options, service, dependencies));
}

async function dispatchCommand(positionals, options, service, dependencies) {
  const [command, subcommand, name] = positionals;
  let output;
  if (command === 'init') {
    argumentsFor(positionals, options, 1);
    output = await service.init();
  } else if (command === 'config') {
    argumentsFor(positionals, options, subcommand === 'validate' && name ? 3 : 2);
    if (subcommand === 'show') output = await service.config();
    else if (subcommand === 'validate') {
      await loadConfig(name ?? service.paths.config);
      output = { schemaVersion: 1, valid: true };
    } else throw new DevDashError('INVALID_ARGUMENT', 'Expected config show or config validate.');
  } else if (command === 'profile') {
    argumentsFor(positionals, options, subcommand === 'list' ? 2 : 3, subcommand === 'set' ? ['file'] : []);
    if (subcommand === 'list') output = await service.list();
    else if (subcommand === 'get') output = { schemaVersion: 1, name, profile: await service.profile(name) };
    else if (subcommand === 'remove') output = await service.removeProfile(name);
    else if (subcommand === 'set') {
      if (!options.file) throw new DevDashError('INVALID_ARGUMENT', 'profile set requires --file <file|->.');
      const text = options.file === '-'
        ? await stdinText(dependencies.stdin ?? process.stdin)
        : await readFile(options.file, 'utf8');
      if (Buffer.byteLength(text) > 1024 * 1024) {
        throw new DevDashError('INPUT_TOO_LARGE', 'Profile JSON exceeds 1 MiB.');
      }
      let profile;
      try { profile = JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
        throw new DevDashError('INVALID_JSON', 'Profile input must be valid JSON.');
      }
      output = await service.setProfile(name, profile);
    } else throw new DevDashError('INVALID_ARGUMENT', 'Expected profile list, get, set, or remove.');
  } else if (command === 'get' || command === 'refresh') {
    argumentsFor(positionals, options, subcommand ? 2 : 1,
      command === 'get' ? ['all', 'cached-only', 'query'] : ['all', 'due', 'query']);
    output = await mapProfiles(service, subcommand, options, (profile) => service.get(profile, {
      refresh: command === 'refresh',
      due: options.due ?? false,
      cachedOnly: options['cached-only'] ?? false,
      query: options.query,
    }));
  } else if (command === 'format') {
    argumentsFor(positionals, options, 1);
    const { document, failed } = await readResultJson(dependencies.stdin ?? process.stdin);
    return { output: document, exitCode: failed ? 2 : 0 };
  } else if (command === 'cache') {
    argumentsFor(positionals, options, name ? 3 : 2, ['all', 'query']);
    if (!['status', 'clear'].includes(subcommand)) {
      throw new DevDashError('INVALID_ARGUMENT', 'Expected cache status or cache clear.');
    }
    output = await mapProfiles(service, name, options, (profile) =>
      subcommand === 'status' ? service.cacheStatus(profile, { query: options.query }) : service.clearCache(profile, { query: options.query }));
  } else if (command === 'doctor') {
    argumentsFor(positionals, options, 1);
    const checks = [];
    for (const [label, operation] of [
      ['gh', () => (dependencies.runText ?? runText)('gh', ['--version'])],
      ['az', () => (dependencies.runJson ?? runJson)('az', ['version', '--output', 'json'])],
      ['azure-devops', () => (dependencies.runJson ?? runJson)('az', ['extension', 'show', '--name', 'azure-devops', '--output', 'json'])],
      ['cr', async () => {
        const version = await (dependencies.runJson ?? runJson)('cr', ['--version'], providerProcessOptions());
        if (version?.name !== 'cr' || typeof version.version !== 'string' || !version.version) {
          throw new DevDashError('INVALID_PROVIDER_RESPONSE', 'cr returned invalid version information.');
        }
      }],
    ]) {
      try { await operation(); checks.push({ name: label, available: true }); } catch (error) {
        checks.push({ name: label, available: false, ...errorJson(error) });
      }
    }
    output = { schemaVersion: 1, node: process.version, paths: service.paths, checks, failed: checks.filter((check) => !check.available).length };
  } else if (command === 'logs') {
    argumentsFor(positionals, options, 2, subcommand === 'tail' ? ['lines', 'errors'] : []);
    if (subcommand === 'path') output = service.diagnostics.pathInfo();
    else if (subcommand === 'tail') {
      output = await service.diagnostics.tail({
        lines: options.lines === undefined ? 100 : Number(options.lines),
        errorsOnly: options.errors ?? false,
      });
    } else throw new DevDashError('INVALID_ARGUMENT', 'Expected logs path or logs tail.');
  } else {
    throw new DevDashError('INVALID_ARGUMENT', `Unknown command "${command}"; run devdash --help.`);
  }
  return { output, exitCode: output.failed ? 2 : 0 };
}

export function validateWatch(args) {
  const parsed = parseCommand(args);
  argumentsFor(parsed.positionals, parsed.values, parsed.positionals.length > 1 ? 2 : 1, ['interval', 'query']);
  if (parsed.values.query !== undefined && parsed.positionals.length !== 2) {
    throw new DevDashError('INVALID_ARGUMENT', 'watch --query requires a profile name.');
  }
  const interval = parsed.values.interval === undefined ? 1 : Number(parsed.values.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 86400) {
    throw new DevDashError('INVALID_ARGUMENT', '--interval must be an integer from 1 to 86400 seconds.');
  }
  return { ...parsed, interval };
}
