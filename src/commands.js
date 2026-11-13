import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { DevDash, failedProfiles, selectedQuery } from './service.js';
import { DevDashError, errorJson } from './errors.js';
import { isGroupedProfile, loadConfig } from './config.js';
import { runJson, runText } from './process.js';
import { safeCommand, providerProcessOptions } from './diagnostics.js';
import { readResultJson } from './format.js';
import { RESULT_FIELDS } from './results.js';
import { manageNative } from './native-registration.js';

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
    'query get <profile> <query>': 'Read one named query, effective defaults, and its revision.',
    'query validate <profile> <query> --file <file|->': 'Validate a query without saving or fetching.',
    'query set <profile> <query> --file <file|-> --expected-revision <revision|missing>': 'Save one query atomically without overwriting siblings.',
    'query remove <profile> <query> --expected-revision <revision>': 'Remove one query; remove its group if it was the last query.',
    'get <name> | get --all': 'Use fresh cached results, querying when missing or expired.',
    'get <name> --cached-only': 'Read cache only, including explicitly marked stale results.',
    'get <name> --cache-mode adaptive': 'Return expired cached data while refreshing in the background, unless recent refreshes are consistently fast.',
    'refresh <name> | refresh --all [--due]': 'Force refresh, or refresh only expired entries with --due.',
    'refresh <name> --background [--query <query>] [--due]': 'Start a detached refresh and return job/status metadata, including on cold caches.',
    'avatar <name> --item-id <id> [--query <query>]': 'Retrieve one bounded raster avatar from a cached item; never returns credentials.',
    hello: 'Report version, native capabilities, limits, and authentication ownership without provider calls.',
    'format [--format <json|ansi|ascii|md>]': 'Read one query-result JSON document from stdin; render without querying or changing caches.',
    'cache status <name> | cache status --all': 'Read freshness and count metadata without querying.',
    'cache clear <name> | cache clear --all': 'Delete cached results.',
    'watch [name] [--interval <seconds>]': 'Refresh due profiles in the foreground; output JSON lines.',
    'doctor [profile] [--query <query>]': 'Check tools without authenticating; optionally check only dependencies for selected queries.',
    'logs path': 'Show diagnostic log location and retention limits.',
    'logs tail [--lines <count>] [--errors]': 'Read recent structured diagnostic records (default 100).',
    'native-host': 'Serve length-prefixed JSON requests for a registered browser native host.',
    'native-manifest --extension-id <id> --launcher <absolute-path>': 'Output a native host manifest (registration is manual).',
    'native install [--browser <chrome|edge|both>] [--extension-id <id>]': 'Register the per-user Windows native host. Existing allowed IDs are preserved.',
    'native uninstall [--browser <chrome|edge|both>]': 'Remove owned registrations; retain shared files while another browser uses them.',
    'native status': 'Inspect native-host registration, launcher, and allowed extension IDs.',
    'native extensions add <id> | remove <id> | list': 'Manage exact allowed extension IDs locally; never available through native messaging.',
  },
  options: {
    '--home <directory>': 'Data directory; defaults to DEVDASH_HOME or ~/.devdash.',
    '--config <file>': 'Override the configuration file; caches are scoped to that file.',
    '--user-config <file>': 'Override user presentation defaults (normally <home>/user.config.json); JSON output is unaffected.',
    '--query <name>': 'Select one named query for get, refresh, cache status/clear, or watch; requires a profile.',
    '--cache-mode <cache-first|adaptive>': 'Cache policy for get (default cache-first). Adaptive uses refreshSeconds as its minimum refresh age.',
    '--fast-query-ms <milliseconds>': 'Adaptive foreground-refresh threshold, 1-60000 (default 500); requires at least three successful timing samples.',
    '--page-size <1-200>': 'Read a byte-bounded page of one query snapshot; JSON output only.',
    '--cursor <cursor>': 'Continue the same cached snapshot without fetching; keep page size and fields unchanged.',
    '--fields <field,...>': 'Project normalized item fields on paged reads; provider, kind, id, and url are always retained.',
    '--background': 'Start refresh without waiting for provider completion; select one query.',
    '--expected-revision <revision|missing>': 'Required optimistic concurrency token for query set/remove.',
    '--role <author|assignee|reviewer>': 'Avatar identity role (default author).',
    '--item-id <id>': 'Select one item from the current cached query for avatar retrieval.',
    '--repository <owner/repository>': 'Disambiguate an avatar item when GitHub issue/PR numbers overlap across repositories.',
    '--index <number>': 'Avatar identity index within assignees/reviewers (default 0).',
    '--cache-revision <revision>': 'Require the expected cached snapshot when retrieving an avatar.',
    '--browser <chrome|edge|both>': 'Native registration browser scope (default both).',
    '--install-directory <directory>': 'Native launcher/manifest directory (default LocalAppData\\DevDash\\NativeMessaging).',
    '--node-path <executable>': 'Node executable for native install (default current Node).',
    '--preview': 'Preview native registration changes without writing files or registry.',
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
        'cache-mode': { type: 'string' },
        'fast-query-ms': { type: 'string' },
        'page-size': { type: 'string' },
        cursor: { type: 'string' },
        fields: { type: 'string' },
        background: { type: 'boolean' },
        'expected-revision': { type: 'string' },
        'item-id': { type: 'string' },
        repository: { type: 'string' },
        role: { type: 'string' },
        index: { type: 'string' },
        'cache-revision': { type: 'string' },
        pretty: { type: 'boolean' },
        format: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        interval: { type: 'string' },
        'extension-id': { type: 'string' },
        launcher: { type: 'string' },
        browser: { type: 'string' },
        'install-directory': { type: 'string' },
        'node-path': { type: 'string' },
        preview: { type: 'boolean' },
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

async function definitionInput(options, dependencies) {
  if (!options.file) throw new DevDashError('INVALID_ARGUMENT', 'This operation requires --file <file|->.');
  const text = options.file === '-' ? await stdinText(dependencies.stdin ?? process.stdin) : await readFile(options.file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new DevDashError('INPUT_TOO_LARGE', 'Definition JSON exceeds 1 MiB.');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    throw new DevDashError('INVALID_JSON', 'Definition input must be valid JSON.');
  }
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
  if (command === 'native' && (options.preview || positionals[1] === 'status' ||
      (positionals[1] === 'extensions' && positionals[2] === 'list'))) {
    return dispatchCommand(positionals, options, service, dependencies);
  }
  return service.diagnostics.run('command', { command: safeCommand(positionals) }, () =>
    dispatchCommand(positionals, options, service, dependencies));
}

async function dispatchCommand(positionals, options, service, dependencies) {
  const [command, subcommand, name] = positionals;
  let output;
  if (command === 'native') {
    let action = subcommand;
    if (subcommand === 'extensions') {
      action = name;
      if (!['add', 'remove', 'list'].includes(action)) {
        throw new DevDashError('INVALID_ARGUMENT', 'Expected native extensions add <id>, remove <id>, or list.');
      }
      argumentsFor(positionals, options, action === 'list' ? 3 : 4, ['install-directory', 'browser', 'preview']);
    } else {
      if (!['install', 'uninstall', 'status'].includes(action)) {
        throw new DevDashError('INVALID_ARGUMENT', 'Expected native install, uninstall, status, or extensions.');
      }
      argumentsFor(positionals, options, 2, ['install-directory', 'browser', 'preview',
        ...(action === 'install' ? ['extension-id', 'node-path'] : [])]);
    }
    output = await (dependencies.manageNative ?? manageNative)(action, {
      browser: options.browser, installDirectory: options['install-directory'], nodePath: options['node-path'],
      extensionId: subcommand === 'extensions' ? positionals[3] : undefined,
      extensionIds: options['extension-id'] === undefined ? [] : options['extension-id'].split(','),
      preview: options.preview, home: options.home, config: options.config,
    });
  } else if (command === 'init') {
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
      output = await service.setProfile(name, await definitionInput(options, dependencies));
    } else throw new DevDashError('INVALID_ARGUMENT', 'Expected profile list, get, set, or remove.');
  } else if (command === 'query') {
    const allowed = subcommand === 'set' ? ['file', 'expected-revision']
      : subcommand === 'validate' ? ['file'] : subcommand === 'remove' ? ['expected-revision'] : [];
    argumentsFor(positionals, options, 4, allowed);
    const query = positionals[3];
    if (subcommand === 'get') output = await service.queryDefinition(name, query);
    else if (subcommand === 'validate') output = await service.validateQuery(name, query, await definitionInput(options, dependencies));
    else if (subcommand === 'set') output = await service.setQuery(name, query, await definitionInput(options, dependencies), options['expected-revision']);
    else if (subcommand === 'remove') output = await service.removeQuery(name, query, options['expected-revision']);
    else throw new DevDashError('INVALID_ARGUMENT', 'Expected query get, validate, set, or remove.');
  } else if (command === 'get' || command === 'refresh') {
    argumentsFor(positionals, options, subcommand ? 2 : 1,
      command === 'get' ? ['all', 'cached-only', 'query', 'cache-mode', 'fast-query-ms', 'page-size', 'cursor', 'fields'] : ['all', 'due', 'query', 'background']);
    if (options['cache-mode'] !== undefined && !['cache-first', 'adaptive'].includes(options['cache-mode'])) {
      throw new DevDashError('INVALID_ARGUMENT', '--cache-mode must be cache-first or adaptive.');
    }
    if (options['fast-query-ms'] !== undefined && (options['cache-mode'] !== 'adaptive' ||
        !/^\d+$/.test(options['fast-query-ms']) || Number(options['fast-query-ms']) < 1 || Number(options['fast-query-ms']) > 60_000)) {
      throw new DevDashError('INVALID_ARGUMENT', '--fast-query-ms requires adaptive mode and must be an integer from 1 to 60000.');
    }
    if (options['cache-mode'] === 'adaptive' && options['cached-only']) {
      throw new DevDashError('INVALID_ARGUMENT', '--cache-mode adaptive cannot be combined with --cached-only.');
    }
    const pagination = options['page-size'] !== undefined || options.cursor !== undefined || options.fields !== undefined;
    if (pagination && (options.all || !subcommand || (options.format ?? 'json') !== 'json')) {
      throw new DevDashError('INVALID_ARGUMENT', 'Paged reads require one selected query and JSON output.');
    }
    if (options['page-size'] !== undefined && !/^\d+$/.test(options['page-size'])) {
      throw new DevDashError('INVALID_ARGUMENT', '--page-size must be an integer from 1 to 200.');
    }
    if (options.background && (options.all || !subcommand || (options.format ?? 'json') !== 'json')) {
      throw new DevDashError('INVALID_ARGUMENT', 'Background refresh requires one selected query and JSON output.');
    }
    output = await mapProfiles(service, subcommand, options, (profile) => (options.background
      ? service.startRefresh.bind(service) : pagination ? service.getPage.bind(service) : service.get.bind(service))(profile, {
      refresh: command === 'refresh',
      due: options.due ?? false,
      cachedOnly: options['cached-only'] ?? false,
      query: options.query,
      cacheMode: options['cache-mode'] ?? 'cache-first',
      ...(options['fast-query-ms'] !== undefined ? { fastQueryMs: Number(options['fast-query-ms']) } : {}),
      ...(pagination ? {
        pageSize: options['page-size'] === undefined ? 50 : Number(options['page-size']),
        cursor: options.cursor, fields: options.fields?.split(','),
      } : {}),
    }));
  } else if (command === 'avatar') {
    argumentsFor(positionals, options, 2, ['query', 'item-id', 'repository', 'role', 'index', 'cache-revision']);
    if (options.index !== undefined && !/^\d+$/.test(options.index)) {
      throw new DevDashError('INVALID_ARGUMENT', '--index must be a nonnegative integer.');
    }
    output = await service.avatar(subcommand, {
      query: options.query, itemId: options['item-id'], role: options.role, index: Number(options.index ?? 0),
      cacheRevision: options['cache-revision'],
      repository: options.repository,
    });
  } else if (command === 'hello') {
    argumentsFor(positionals, options, 1);
    output = {
      schemaVersion: 1, name: help.name, version: help.version, nativeProtocolVersion: 1,
      capabilities: {
        adaptiveCache: true, backgroundRefresh: true, queryEditing: true, queryRevisions: true,
        paging: true, projection: true, avatars: true, requestIds: true, events: false,
      },
      limits: {
        nativeMessageBytes: 1024 * 1024, pageSize: 200, pageBytes: 768 * 1024,
        avatarBytes: 128 * 1024, concurrentNativeRequests: 4, providerQueriesPerProviderAndConfig: 2,
      },
      resultFields: RESULT_FIELDS,
      authentication: {
        github: { default: 'gh', modes: ['gh', 'anonymous'] },
        ado: { default: 'az', modes: ['az', 'pat-environment'] },
        chromium: { default: 'anonymous', modes: ['anonymous'] },
      },
    };
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
    argumentsFor(positionals, options, subcommand ? 2 : 1, subcommand ? ['query'] : []);
    let required;
    if (subcommand) {
      const profile = await service.profile(subcommand);
      const definitions = options.query ? [selectedQuery(profile, options.query)]
        : isGroupedProfile(profile) ? Object.values(profile.queries) : [profile];
      required = new Set(definitions.flatMap(definition => definition.provider === 'github'
        ? definition.auth === 'anonymous' ? [] : ['gh']
        : definition.provider === 'ado' ? ['az', 'azure-devops'] : ['cr']));
    }
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
      if (required && !required.has(label)) continue;
      try { await operation(); checks.push({ name: label, available: true }); } catch (error) {
        checks.push({ name: label, available: false, ...errorJson(error) });
      }
    }
    output = {
      schemaVersion: 1, node: process.version, paths: service.paths,
      ...(subcommand ? { profile: subcommand, ...(options.query ? { query: options.query } : {}) } : {}),
      checks, failed: checks.filter((check) => !check.available).length,
    };
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
