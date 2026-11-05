import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { executeCommand, runCli, parseBugId } from '../src/cli.js';
import { createLogger, MAX_BYTES } from '../src/logger.js';
import { CrError } from '../src/errors.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageRoot, 'bin', 'cr.js');
async function home(t) {
  const path = join(packageRoot, `.test-${randomUUID()}`);
  await mkdir(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function processCli(args, path, extraEnv = {}, nodeArgs = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, bin, ...args], {
      shell: false, env: { ...process.env, CR_HOME: path, ...extraEnv }, cwd: packageRoot,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
}
function mockLogger() {
  const events = [];
  return { file: 'mock-cr.jsonl', requestId: randomUUID(), events,
    log: async (event, fields) => { events.push({ event, ...fields }); },
    tail: async () => [],
  };
}

test('executable help/version are one JSON document and launch no browser', async t => {
  const path = await home(t);
  for (const args of [[], ['--help'], ['--version'], ['bugs', 'view', '411731002', '--help'],
    ['cls', 'list', '--query', 'PRIVATE', '--help']]) {
    const result = await processCli(args, path, { PLAYWRIGHT_BROWSERS_PATH: join(path, 'missing') });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 1);
    if (args.includes('--version')) {
      assert.equal(output.name, 'cr');
      assert.equal(typeof output.version, 'string');
    }
    assert.equal(result.stdout.trim().split('\n').length, 1);
  }
});

test('official URL parsing is strict and does not accept URL normalization tricks', () => {
  for (const input of ['411731002', 'https://crbug.com/411731002',
    'https://issues.chromium.org/issues/411731002', 'https://issues.chromium.org/u/0/issues/411731002']) {
    assert.equal(parseBugId(input), '411731002');
  }
  for (const input of ['0', '01', '-1', '1.5', '12345678901234567', 'http://crbug.com/1',
    'https://crbug.com.evil/1', 'https://user@crbug.com/1', 'https://crbug.com:443/1',
    'https://crbug.com/1?secret=token', 'https://crbug.com/1#x',
    'https://crbug.com/../1', 'https://crbug.com/%31', 'https://crbug.com/1/',
    'https://issues.chromium.org/1', 'https://crbug.com\\1', 'https://CRBUG.com/1']) {
    assert.throws(() => parseBugId(input), { code: 'INVALID_ARGUMENT' });
  }
});

test('bug command validates a batch before provider invocation and reports normalized envelope', async () => {
  const logger = mockLogger();
  const result = await executeCommand(['bugs', 'view', '1', 'https://crbug.com/2', '--limit', '1', '--pretty'], {
    logger,
    queryBugs: async (request, deps) => {
      assert.deepEqual(request.bugIds, ['1', '2']);
      assert.equal(request.limit, 1);
      assert.equal(deps.log, logger.log);
      return { items: [{ id: '1' }], truncated: true };
    },
  });
  assert.deepEqual(result.output, { schemaVersion: 1, items: [{ id: '1' }], truncated: true });
  assert.equal(result.pretty, true);
  assert.equal(logger.events.at(-1).count, 1);
  for (const ids of [[], ['1', 'https://crbug.com/1'], Array.from({ length: 101 }, (_, n) => String(n + 1))]) {
    await assert.rejects(executeCommand(['bugs', 'view', ...ids], {
      logger, queryBugs: async () => assert.fail('Unexpected provider invocation'),
    }), { code: 'INVALID_ARGUMENT' });
  }
});

test('CL command defaults and explicit options are passed without a shell', async () => {
  const result = await executeCommand(['cls', 'list', '--query', 'status:merged', '--project', 'chromium/src',
    '--host', 'https://review.example.com', '--limit', '2'], {
    logger: mockLogger(),
    queryCls: async request => {
      assert.deepEqual(request, {
        query: 'status:merged', project: 'chromium/src', host: 'https://review.example.com', limit: 2,
      });
      return { items: [], truncated: false };
    },
  });
  assert.deepEqual(result.output, { schemaVersion: 1, items: [], truncated: false });
});

test('bug search command accepts native string queries, never ID selectors or unsupported scope', async () => {
  for (const args of [
    ['bugs', 'list', '--query', 'type:bug status:open', '--limit', '2'],
    ['bugs', 'list', '--query=-status:closed', '--limit=2'],
  ]) {
    const result = await executeCommand(args, {
      logger: mockLogger(),
      queryBugs: async request => {
        assert.deepEqual(request, { provider: 'chromium', resource: 'bugs',
          query: args[2].startsWith('--query=') ? '-status:closed' : 'type:bug status:open', limit: 2 });
        return { items: [], truncated: false };
      },
    });
    assert.deepEqual(result.output, { schemaVersion: 1, items: [], truncated: false });
  }
  for (const args of [
    ['bugs', 'list'], ['bugs', 'list', '1', '--query', 'type:bug'],
    ['bugs', 'list', '--query', 'type:bug', '--host', 'https://example.com'],
    ['bugs', 'list', '--query', 'type:bug', '--project', 'chromium'],
    ['bugs', 'list', '--query', 'a'.repeat(32769)],
  ]) await assert.rejects(executeCommand(args, {
    logger: mockLogger(), queryBugs: () => assert.fail('Unexpected provider invocation'),
  }), { code: 'INVALID_ARGUMENT' });
});

test('executable bug searches fail safely without a browser and never persist query text', async t => {
  const path = await home(t);
  const result = await processCli(['bugs', 'list', '--query=title:PRIVATE_SEARCH', '--limit=1'], path,
    { PLAYWRIGHT_BROWSERS_PATH: join(path, 'absent-browser') });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'BROWSER_NOT_INSTALLED');
  assert.doesNotMatch(result.stderr, /PRIVATE_SEARCH/);
  assert.doesNotMatch(await readFile(join(path, 'logs', 'cr.jsonl'), 'utf8'), /PRIVATE_SEARCH/);
});

test('executable bug search passes native query intact and emits normalized JSON with safe diagnostics', async t => {
  const path = await home(t);
  const query = '-status:closed title:"PRIVATE_SEARCH & cache"';
  const script = `
    import assert from 'node:assert/strict';
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    chromium.launch = async () => ({newContext:async settings=>{
      assert.deepEqual(settings,{locale:'en-US'});
      let number=0;
      return {newPage:async()=> {
        const search=number++===0;
        return {
          goto:async url=>{
            if(search)assert.equal(new URL(url).searchParams.get('q'),${JSON.stringify(query)});
            else assert.equal(url,'https://issues.chromium.org/issues/1');
            return {status:()=>200};
          },
          waitForFunction:async()=>({jsonValue:async()=>({ids:['1'],start:1,end:1,total:1,next:false}),dispose:async()=>{}}),
          evaluate:async()=>({title:'Fixture bug',state:'New'}),
          close:async()=>{}
        };
      },close:async()=>{}};
    },close:async()=>{}});
  `;
  const result = await processCli(['bugs', 'list', `--query=${query}`, '--limit=1'], path, {},
    ['--import', `data:text/javascript,${encodeURIComponent(script)}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.items[0].id, '1');
  assert.equal(output.items[0].kind, 'bug');
  assert.equal(output.items[0].priority, null);
  assert.equal(output.items[0].severity, null);
  assert.equal(output.items[0].type, null);
  assert.deepEqual(output.items[0].providerData, { component: null });
  assert.equal(Object.hasOwn(output.items[0], 'details'), false);
  assert.equal(output.truncated, false);
  const log = await readFile(join(path, 'logs', 'cr.jsonl'), 'utf8');
  assert.match(log, /chromium.search.complete/);
  assert.doesNotMatch(log, /PRIVATE_SEARCH|Fixture bug/);
});

test('executable accepts separated and equals options, including exclusion queries and hyphenated projects', async t => {
  const path = await home(t);
  const cases = [
    { query: 'status:merged', project: 'chromium/src',
      args: ['--query=status:merged', '--project=chromium/src', '--limit', '1'] },
    { query: '-status:merged', project: '-chromium/src',
      args: ['--query=-status:merged', '--project=-chromium/src', '--host=https://review.example.com', '--limit=1'] },
    { query: '-status:merged', project: '-chromium/src',
      args: ['--query', '-status:merged', '--project', '-chromium/src', '--host', 'https://review.example.com', '--limit', '1'] },
    { query: 'message:"left=right" -status:merged', project: '-chromium/src',
      args: ['--query=message:"left=right" -status:merged', '--project=-chromium/src', '--limit=1'] },
  ];
  for (const { args, query, project } of cases) {
    const expectedQuery = `${query} project:${JSON.stringify(project)}`;
    const script = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url.searchParams.get('q'), ${JSON.stringify(expectedQuery)});
        assert.equal(url.searchParams.get('n'), '1');
        assert.equal(options.redirect, 'error');
        return {ok:true,status:200,text:async()=>JSON.stringify([{
          _number:1,subject:'Mock change',status:'MERGED',project:${JSON.stringify(project)}
        }])};
      };
    `;
    const result = await processCli(['cls', 'list', ...args, `--home=${path}`], path, {},
      ['--import', `data:text/javascript,${encodeURIComponent(script)}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 1);
    assert.equal(output.items[0].repository, project);
    assert.equal(output.truncated, false);
    assert.equal(result.stdout.trim().split('\n').length, 1);
  }
});

test('executable equals options reject empty values, mixed duplicates, controls and boolean values safely', async t => {
  const path = await home(t);
  for (const args of [
    ['cls', 'list', '--query='],
    ['cls', 'list', '--query=status:merged', '--query', 'status:open'],
    ['cls', 'list', '--query', 'status:open', '--query=status:merged'],
    ['cls', 'list', '--query=PRIVATE\nTOKEN'],
    ['cls', 'list', '--query=status:merged', '--limit=0'],
    ['--pretty=true'], ['--help=false'], ['--unknown=PRIVATE'],
  ]) {
    const result = await processCli(args, path);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    assert.doesNotMatch(result.stderr, /PRIVATE|TOKEN/);
  }
  const result = await processCli(['logs', 'tail', '--lines=1', `--home=${path}`], path);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).items.length, 1);
});

test('CLI invalid arguments produce safe stderr JSON and diagnostic correlation', async t => {
  const path = await home(t), requestId = randomUUID();
  for (const args of [
    ['invalid'], ['bugs', 'view'], ['bugs', 'view', '1', '--query', 'PRIVATE'],
    ['cls', 'list'], ['cls', 'list', '--query', 'PRIVATE', '--host', 'http://bad'],
    ['--unknown'], ['--home'], ['--limit', '0'], ['--limit', '1.5'], ['--limit', '20001'],
    ['--pretty', '--pretty'], ['logs', 'tail', '--lines', '1001'],
    ['--help', '--query', 'PRIVATE\nTOKEN'], ['doctor', '--errors'],
  ]) {
    const result = await processCli(args, path, { CR_REQUEST_ID: requestId });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const { error } = JSON.parse(result.stderr);
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal(error.diagnosticId, requestId);
    assert.doesNotMatch(result.stderr, /PRIVATE|TOKEN/);
  }
  const log = await readFile(join(path, 'logs', 'cr.jsonl'), 'utf8');
  assert.doesNotMatch(log, /PRIVATE|TOKEN/);
  assert.ok(log.includes(requestId));
});

test('provider failures are JSON-only and do not disclose underlying exception text', async () => {
  const outputs = { stdout: '', stderr: '' }, logger = mockLogger();
  const code = await runCli(['cls', 'list', '--query', 'PRIVATE'], {
    logger, queryCls: async () => { throw new Error('PRIVATE password exception'); },
    stdout: { write: value => { outputs.stdout += value; } },
    stderr: { write: value => { outputs.stderr += value; } },
  });
  assert.equal(code, 1);
  assert.equal(outputs.stdout, '');
  assert.deepEqual(JSON.parse(outputs.stderr).error, {
    code: 'UNEXPECTED_ERROR', message: 'cr could not complete the command.', diagnosticId: logger.requestId,
  });
});

test('doctor checks executable access without launching browser or making HTTP requests', async () => {
  for (const missing of [true, false]) {
    let checked = false;
    const result = await executeCommand(['doctor'], {
      logger: mockLogger(),
      chromium: { executablePath: () => 'C:\\browser\\chromium-123\\chrome-win64\\chrome.exe',
        launch: () => assert.fail('Browser must not launch') },
      access: async () => { checked = true; if (missing) throw new Error('missing'); },
      fetch: async () => assert.fail('No provider request'),
    });
    assert.ok(checked);
    assert.equal(result.exitCode, missing ? 2 : 0);
    assert.equal(result.output.status, missing ? 'failed' : 'ok');
  }
});

test('executable doctor missing browser has exit 2 and clean stdout', async t => {
  const path = await home(t);
  const result = await processCli(['doctor'], path, { PLAYWRIGHT_BROWSERS_PATH: join(path, 'absent-browser') });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).checks.browser.code, 'BROWSER_NOT_INSTALLED');
});

test('home option overrides environment and logs path/tail have JSON-only output', async t => {
  const path = await home(t), other = join(path, 'explicit');
  const result = await processCli(['logs', 'path', '--home', other], path);
  assert.equal(JSON.parse(result.stdout).path, join(other, 'logs', 'cr.jsonl'));
  const tail = await processCli(['--home', other, 'logs', 'tail', '--lines', '1'], path);
  assert.equal(tail.code, 0);
  assert.equal(tail.stderr, '');
  assert.equal(JSON.parse(tail.stdout).items.length, 1);
});

test('logger validates request UUID and allowlists all metadata, preserving versions', async t => {
  const path = await home(t), logger = createLogger({ home: path }, { CR_REQUEST_ID: 'PRIVATE query TOKEN' });
  await logger.log('chromium.bug.failed', {
    phase: 'goto', bugId: '123', code: 'BUG_TIMEOUT', outcome: 'failed', count: 1, httpStatus: 403,
    durationMs: 10, reason: 'PRIVATE', message: 'PRIVATE', query: 'PRIVATE', profile: 'PRIVATE',
  });

  test('search diagnostic events retain safe phases and counts without native search text or result bodies', async t => {
    const path = await home(t), logger = createLogger({ home: path });
    for (const [event, phase] of [
      ['chromium.search.start', 'search-page'], ['chromium.search.page', 'search-extract'],
      ['chromium.search.complete', 'search-extract'], ['chromium.search.failed', 'search-ready'],
    ]) await logger.log(event, { phase, count: 2, query: 'PRIVATE_QUERY', title: 'PRIVATE_TITLE',
      html: 'PRIVATE_HTML', url: 'https://example.com/?token=PRIVATE_TOKEN' });
    const records = (await readFile(logger.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 4);
    assert.ok(records.every(record => record.phase.startsWith('search-') && record.count === 2));
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
  });
  await logger.log('cli.start', { phase: 'PRIVATE', code: 'PRIVATE', bugId: 'PRIVATE' });
  const log = await readFile(logger.file, 'utf8');
  assert.doesNotMatch(log, /PRIVATE|TOKEN/);
  const row = JSON.parse(log.split('\n')[0]);
  assert.equal(row.appVersion, '0.1.0');
  assert.equal(row.nodeVersion, process.version);
  assert.match(row.requestId, /^[0-9a-f-]{36}$/);
  assert.equal((await logger.tail(100, true)).length, 1);
  await assert.rejects(logger.tail(1001), { code: 'INVALID_ARGUMENT' });
});

test('log rotation is bounded to five 2 MiB files', async t => {
  const path = await home(t), logger = createLogger({ home: path });
  await mkdir(logger.logs);
  for (let cycle = 0; cycle < 7; cycle++) {
    await writeFile(logger.file, 'x'.repeat(MAX_BYTES));
    await logger.log('cli.start', { phase: 'command' });
  }
  const files = await readdir(logger.logs);
  assert.equal(files.length, 5);
  for (const file of files) assert.ok((await stat(join(logger.logs, file))).size <= MAX_BYTES);
});

test('interprocess writes serialize without dropping JSONL records', async t => {
  const path = await home(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => processCli(['--version'], path)));
  assert.ok(results.every(result => result.code === 0 && result.stderr === ''));
  const rows = (await readFile(join(path, 'logs', 'cr.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 8);
});

test('log write failure is explicit and prevents a false success', async t => {
  const path = await home(t), file = join(path, 'not-a-directory');
  await writeFile(file, '');
  const result = await processCli(['--version', '--home', file], path);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'LOG_WRITE_FAILED');
  const logger = mockLogger();
  logger.log = async () => { throw new CrError('LOG_WRITE_FAILED', 'Write failed.'); };
  await assert.rejects(executeCommand(['--version'], { logger }), { code: 'LOG_WRITE_FAILED' });
});

test('log tails sanitize externally modified files and read at most the bounded tail', async t => {
  const path = await home(t), logger = createLogger({ home: path });
  await logger.log('cli.failed', { code: 'INVALID_ARGUMENT', outcome: 'failed' });
  const record = JSON.parse((await readFile(logger.file, 'utf8')).trim());
  await writeFile(logger.file, JSON.stringify({ ...record, secret: 'PRIVATE', phase: 'PRIVATE', code: 'PRIVATE' }) + '\nnot JSON\n');
  assert.doesNotMatch(JSON.stringify(await logger.tail()), /PRIVATE/);
  assert.equal(resolve(logger.file), join(path, 'logs', 'cr.jsonl'));
});
