import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBugDocument, queryChromiumBugs } from '../src/bugs.js';
import { CrError } from '../src/errors.js';

const profile = {
  provider: 'chromium', resource: 'bugs', bugIds: ['411731002'], refreshSeconds: 300, limit: 1000,
};
const metadata = {
  title: ' Test bug ', state: ' Assigned ', priority: 'P2', severity: 'S3',
  type: 'Bug', component: 'UI', reporter: 'Reporter',
  assignees: ['Owner', 'Owner'], createdAt: '2026-01-02T03:04:05+02:00',
  updatedAt: '2026-03-04T05:06:07Z', access: null,
};
const privateError = () => new Error('PRIVATE TITLE cookies HTML secret');
const timeoutError = () => Object.assign(privateError(), { name: 'TimeoutError' });

function browserFixture(options = {}) {
  const calls = [], events = [];
  let index = 0;
  const browser = {
    async newContext(value) {
      calls.push(['context', value]);
      if (options.contextError) throw options.contextError;
      return {
        async newPage() {
          calls.push(['page', index]);
          if (options.pageError) throw options.pageError;
          const number = index++;
          return {
            async goto(url, value) {
              calls.push(['goto', url, value]);
              if (options.gotoError) throw options.gotoError;
              if (options.noResponse) return null;
              return { status: () => {
                if (options.statusError) throw options.statusError;
                return options.status || 200;
              } };
            },
            async waitForFunction(fn, argument, value) {
              calls.push(['ready', fn.name, argument, value]);
              if (options.readyError) throw options.readyError;
              if (options.dom && !withDocument(options.dom, fn)) throw timeoutError();
            },
            async evaluate(fn) {
              calls.push(['evaluate', fn.name]);
              if (options.evaluateError) throw options.evaluateError;
              if (options.dom) return withDocument(options.dom, fn);
              return options.rows ? options.rows[number] : { ...metadata, ...options.metadata };
            },
            async close() {
              calls.push(['page-close', number]);
              if (options.pageCloseError) throw options.pageCloseError;
            },
          };
        },
        async close() {
          calls.push(['context-close']);
          if (options.contextCloseError) throw options.contextCloseError;
        },
      };
    },
    async close() {
      calls.push(['browser-close']);
      if (options.browserCloseError) throw options.browserCloseError;
    },
  };
  return {
    calls, events,
    dependencies: {
      chromium: {
        async launch(value) {
          calls.push(['launch', value]);
          if (options.launchError) throw options.launchError;
          return browser;
        },
      },
      async log(event, data) {
        events.push([event, data]);
        if (event === options.logErrorAt) throw options.logError;
      },
    },
  };
}

async function expectFailure(options, code) {
  const fixture = browserFixture(options);
  await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => {
    assert.equal(error.code, code);
    assert.ok(error instanceof CrError);
    assert.doesNotMatch(error.message, /PRIVATE|cookies|secret/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(fixture.events), /PRIVATE|cookies|secret|Test bug|Reporter/);
  return fixture;
}

test('normalizes public bugs with ISO UTC dates and optional details', async () => {
  const fixture = browserFixture();
  assert.deepEqual(await queryChromiumBugs(profile, fixture.dependencies), {
    truncated: false,
    items: [{
      provider: 'chromium', kind: 'bug', id: '411731002', title: 'Test bug', state: 'Assigned',
      url: 'https://issues.chromium.org/issues/411731002', repository: null, author: 'Reporter',
      assignees: ['Owner'], labels: [], createdAt: '2026-01-02T01:04:05.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z', draft: null,
      priority: 'P2', severity: 'S3', type: 'Bug', providerData: { component: 'UI' },
    }],
  });
  assert.deepEqual(fixture.calls[0], ['launch', { headless: true }]);
  assert.deepEqual(fixture.calls[1], ['context', { locale: 'en-US' }]);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'goto')[2], {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });
  assert.deepEqual(fixture.calls.find(call => call[0] === 'ready').slice(1), [
    'bugDocumentReady', null, { timeout: 15_000 },
  ]);
  assert.deepEqual(fixture.calls.slice(-3).map(call => call[0]), [
    'page-close', 'context-close', 'browser-close',
  ]);
  const allowed = new Set(['phase', 'bugId', 'httpStatus', 'durationMs', 'code', 'reason', 'count', 'outcome']);
  for (const [, data] of fixture.events) {
    assert.ok(Object.keys(data).every(key => allowed.has(key)));
  }
});

test('missing optional metadata stays null or empty rather than fabricated', async () => {
  const fixture = browserFixture({ rows: [{ title: 'Bug', state: 'New' }] });
  const { items } = await queryChromiumBugs(profile, fixture.dependencies);
  assert.equal(items[0].author, null);
  assert.equal(items[0].createdAt, null);
  assert.equal(items[0].updatedAt, null);
  assert.deepEqual(items[0].assignees, []);
  assert.equal(items[0].priority, null);
  assert.equal(items[0].severity, null);
  assert.equal(items[0].type, null);
  assert.deepEqual(items[0].providerData, { component: null });
});

test('one anonymous context is reused sequentially and limit reports truncation', async () => {
  const fixture = browserFixture();
  const result = await queryChromiumBugs({ ...profile, bugIds: ['1', '2', '3'], limit: 2 }, fixture.dependencies);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map(item => item.id), ['1', '2']);
  assert.equal(fixture.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(fixture.calls.filter(call => call[0] === 'context').length, 1);
  assert.deepEqual(fixture.calls.filter(call => ['page', 'page-close'].includes(call[0])), [
    ['page', 0], ['page-close', 0], ['page', 1], ['page-close', 1],
  ]);
});

test('rejects invalid IDs, duplicates, unsupported selectors and unbounded profiles before launch', async () => {
  const invalid = [
    { bugIds: [] }, { bugIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
    { bugIds: ['1', '1'] }, { bugIds: [1] }, { bugIds: ['0'] }, { bugIds: ['01'] },
    { bugIds: ['12345678901234567'] }, { bugIds: ['1\n'] }, { bugIds: ['https://crbug.com/1'] },
    { provider: 'github' }, { resource: 'changes' }, { limit: 0 }, { limit: 20_001 },
    { limit: 1.5 }, { limit: undefined }, { query: '' }, { host: undefined }, { project: null },
    { auth: {} }, { storageState: 'profile.json' }, { cookies: [] }, { userDataDir: 'profile' },
    { username: 'person' }, { password: 'secret' }, { token: 'secret' }, { unknown: true },
  ];
  for (const change of invalid) {
    const fixture = browserFixture();
    await assert.rejects(queryChromiumBugs({ ...profile, ...change }, fixture.dependencies), { code: 'INVALID_PROFILE' });
    assert.deepEqual(fixture.calls, []);
  }
});

test('distinguishes missing browser from other launch errors and gives installation action', async () => {
  const missing = browserFixture({ launchError: new Error("Executable doesn't exist at PRIVATE") });
  await assert.rejects(queryChromiumBugs(profile, missing.dependencies), error => {
    assert.equal(error.code, 'BROWSER_NOT_INSTALLED');
    assert.match(error.message, /npx playwright install chromium/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.deepEqual(missing.events.at(-1), ['browser.failed', { phase: 'launch', code: 'BROWSER_NOT_INSTALLED' }]);
  await expectFailure({ launchError: privateError() }, 'BROWSER_FAILED');
});

test('context creation failure still closes browser', async () => {
  const fixture = await expectFailure({ contextError: privateError() }, 'BROWSER_FAILED');
  assert.equal(fixture.calls.at(-1)[0], 'browser-close');
});

test('page creation failure closes context and browser', async () => {
  const fixture = await expectFailure({ pageError: privateError() }, 'BROWSER_FAILED');
  assert.deepEqual(fixture.calls.slice(-2).map(call => call[0]), ['context-close', 'browser-close']);
});

for (const [name, options, code] of [
  ['navigation', { gotoError: privateError() }, 'BUG_UNAVAILABLE'],
  ['navigation deadline', { gotoError: timeoutError() }, 'BUG_TIMEOUT'],
  ['metadata deadline', { readyError: timeoutError() }, 'BUG_TIMEOUT'],
  ['metadata readiness failure', { readyError: privateError() }, 'BUG_RENDER_FAILED'],
  ['no HTTP response', { noResponse: true }, 'BUG_HTTP'],
  ['invalid HTTP response', { statusError: privateError() }, 'BUG_HTTP'],
  ['HTTP 404', { status: 404 }, 'BUG_NOT_FOUND'],
  ['HTTP 401', { status: 401 }, 'BUG_ACCESS_DENIED'],
  ['HTTP 403', { status: 403 }, 'BUG_ACCESS_DENIED'],
  ['HTTP 429', { status: 429 }, 'BUG_HTTP'],
  ['HTTP 500', { status: 500 }, 'BUG_HTTP'],
  ['evaluate', { evaluateError: privateError() }, 'BUG_EXTRACTION_FAILED'],
  ['invalid extracted object', { rows: [null] }, 'BUG_EXTRACTION_FAILED'],
  ['empty title', { metadata: { title: ' ' } }, 'BUG_RESPONSE'],
  ['empty state', { metadata: { state: null } }, 'BUG_RESPONSE'],
  ['login', { metadata: { access: 'login' } }, 'BUG_ACCESS_DENIED'],
  ['restricted', { metadata: { access: 'restricted' } }, 'BUG_ACCESS_DENIED'],
  ['CAPTCHA', { metadata: { access: 'captcha' } }, 'BUG_ACCESS_DENIED'],
  ['missing issue', { metadata: { access: 'not-found' } }, 'BUG_NOT_FOUND'],
  ['unknown date text', { metadata: { createdAt: 'Yesterday' } }, 'BUG_RESPONSE'],
  ['date without offset', { metadata: { updatedAt: '2026-03-04T05:06:07' } }, 'BUG_RESPONSE'],
  ['impossible calendar date', { metadata: { updatedAt: '2026-02-30T05:06:07Z' } }, 'BUG_RESPONSE'],
  ['invalid optional field', { metadata: { priority: {} } }, 'BUG_EXTRACTION_FAILED'],
  ['invalid people', { metadata: { assignees: ['Owner', {}] } }, 'BUG_EXTRACTION_FAILED'],
]) {
  test(`${name} fails safely and closes every acquired resource`, async () => {
    const fixture = await expectFailure(options, code);
    assert.deepEqual(fixture.calls.slice(-3).map(call => call[0]), ['page-close', 'context-close', 'browser-close']);
    assert.ok(fixture.events.some(([event, data]) => event === 'chromium.bug.failed' && data.code === code));
  });
}

test('access challenges take precedence over selector timeout', async () => {
  await expectFailure({ readyError: timeoutError(), metadata: { title: null, access: 'captcha' } }, 'BUG_ACCESS_DENIED');
});

test('safe reason slugs distinguish access challenges and incomplete required fields', async () => {
  for (const [metadata, reason] of [
    [{ access: 'login' }, 'login'], [{ access: 'restricted' }, 'restricted'],
    [{ access: 'captcha' }, 'captcha'], [{ access: '__proto__' }, 'restricted'],
    [{ title: '' }, 'missing-title'], [{ state: '' }, 'missing-state'],
    [{ createdAt: 'Yesterday' }, 'invalid-date'],
  ]) {
    const fixture = browserFixture({ metadata });
    await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => error.reason === reason);
    const event = fixture.events.find(([name]) => name === 'chromium.bug.failed');
    assert.equal(event[1].reason, reason);
  }
});

test('a loaded title with a state that never appears has an explicit state error', async () => {
  await expectFailure({ readyError: timeoutError(), metadata: { state: null } }, 'BUG_RESPONSE');
});

test('a single failing bug rejects the entire snapshot and stops later requests', async () => {
  const fixture = browserFixture({ rows: [metadata, { ...metadata, state: '' }, metadata] });
  await assert.rejects(queryChromiumBugs({ ...profile, bugIds: ['1', '2', '3'] }, fixture.dependencies), { code: 'BUG_RESPONSE' });
  assert.equal(fixture.calls.filter(call => call[0] === 'page').length, 2);
  assert.equal(fixture.calls.filter(call => call[0] === 'page-close').length, 2);
});

test('cleanup failure rejects success and still attempts other cleanup', async () => {
  const fixture = await expectFailure({ pageCloseError: privateError() }, 'BROWSER_CLEANUP_FAILED');
  assert.deepEqual(fixture.calls.slice(-3).map(call => call[0]), ['page-close', 'context-close', 'browser-close']);
});

for (const property of ['contextCloseError', 'browserCloseError']) {
  test(`${property} rejects success with a safe cleanup code`, async () => {
    const fixture = await expectFailure({ [property]: privateError() }, 'BROWSER_CLEANUP_FAILED');
    assert.equal(fixture.calls.at(-1)[0], 'browser-close');
  });
}

test('primary failure survives multiple cleanup failures with sanitized causes and logs', async () => {
  const fixture = browserFixture({
    gotoError: privateError(), pageCloseError: privateError(),
    contextCloseError: privateError(), browserCloseError: privateError(),
  });
  await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => {
    assert.equal(error.code, 'BUG_UNAVAILABLE');
    assert.equal(error.cause.errors.length, 3);
    assert.ok(error.cause.errors.every(cause => cause.code === 'BROWSER_CLEANUP_FAILED'));
    assert.doesNotMatch(String(error.cause), /PRIVATE/);
    return true;
  });
  assert.equal(fixture.events.filter(([event, data]) => event === 'browser.close' && data.outcome === 'failed').length, 3);
});

for (const event of ['browser.start', 'browser.ready', 'chromium.bug.start', 'chromium.bug.complete', 'browser.close']) {
  test(`diagnostic rejection at ${event} propagates and never prevents resource cleanup`, async () => {
    const logError = new Error('diagnostic destination unavailable');
    const fixture = browserFixture({ logErrorAt: event, logError });
    await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error =>
      error === logError || error.cause?.errors.includes(logError) || error.errors?.includes(logError));
    if (event !== 'browser.start') assert.equal(fixture.calls.at(-1)[0], 'browser-close');
  });
}

test('failed-event diagnostic rejection is attached to the preserved primary failure', async () => {
  const logError = new Error('diagnostic destination unavailable');
  const fixture = browserFixture({ gotoError: privateError(), logErrorAt: 'chromium.bug.failed', logError });
  await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error =>
    error.code === 'BUG_UNAVAILABLE' && error.cause.errors.includes(logError));
});

for (const [event, options] of [
  ['browser.start', {}], ['browser.ready', {}], ['chromium.bug.start', {}],
  ['chromium.bug.complete', {}], ['browser.close', {}],
  ['browser.failed', { launchError: privateError() }],
  ['chromium.bug.http', { status: 500 }],
]) {
  test(`LOG_WRITE_FAILED from ${event} preserves the original CrError`, async () => {
    const logError = new CrError('LOG_WRITE_FAILED', 'Diagnostic log write failed.');
    const fixture = browserFixture({ ...options, logErrorAt: event, logError });
    await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => {
      assert.equal(error, logError);
      assert.equal(error.code, 'LOG_WRITE_FAILED');
      return true;
    });
  });
}

test('repeated diagnostic cleanup rejection does not create cyclic error causes', async () => {
  const logError = new Error('diagnostic destination unavailable');
  const fixture = browserFixture({ logErrorAt: 'browser.close', logError });
  await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => {
    assert.equal(error, logError);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('multiple cleanup failures after success preserve a safe primary cleanup error', async () => {
  const fixture = browserFixture({ contextCloseError: privateError(), browserCloseError: privateError() });
  await assert.rejects(queryChromiumBugs(profile, fixture.dependencies), error => {
    assert.equal(error.code, 'BROWSER_CLEANUP_FAILED');
    assert.equal(error.cause.errors.length, 1);
    assert.equal(error.cause.errors[0].code, 'BROWSER_CLEANUP_FAILED');
    assert.ok(!error.cause.errors.includes(error));
    return true;
  });
});

function documentFixture({ title = ' DOM title ', fields = [], people = [], dates = [], body = '', href = '' } = {}) {
  const node = value => ({ textContent: value });
  return {
    location: { href }, body: { innerText: body },
    querySelector(selector) {
      assert.equal(selector, 'issue-title h3');
      return title == null ? null : node(title);
    },
    querySelectorAll(selector) {
      if (selector === '[aria-label*="value is"]') return fields.map(value => ({
        getAttribute: name => { assert.equal(name, 'aria-label'); return value; },
      }));
      if (selector === 'onedev-field-label') return people.map(([label, names]) => ({
        querySelector: value => { assert.equal(value, '.label'); return node(label); },
        closest: value => {
          assert.equal(value, '.wrapper');
          return {
            querySelectorAll: query => {
              assert.equal(query, 'onedev-field-value .user-chip-name');
              return names.map(node);
            },
          };
        },
      }));
      if (selector === 'b-formatted-date-time time[datetime]') return dates.map(value => ({
        getAttribute: name => { assert.equal(name, 'datetime'); return value; },
      }));
      assert.fail(`Unexpected selector: ${selector}`);
    },
  };
}

function withDocument(options, action) {
  const original = globalThis.document;
  try {
    globalThis.document = documentFixture(options);
    return action();
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
}

function extractFixture(options) {
  return withDocument(options, extractBugDocument);
}

test('public query executes serialized readiness and extraction against document semantics', async () => {
  const fixture = browserFixture({ dom: {
    fields: ['Status value is New', 'Priority value is P1'],
    people: [['Reporter', ['Author']]],
    dates: ['2026-10-07T18:00:00Z'],
  } });
  const { items } = await queryChromiumBugs(profile, fixture.dependencies);
  assert.equal(items[0].title, 'DOM title');
  assert.equal(items[0].state, 'New');
  assert.equal(items[0].priority, 'P1');
  assert.equal(items[0].author, 'Author');
  assert.equal(items[0].createdAt, '2026-10-07T18:00:00.000Z');
});

for (const [dom, code] of [
  [{ title: null, body: 'Please sign in to view this issue' }, 'BUG_ACCESS_DENIED'],
  [{ title: null, body: 'Access denied' }, 'BUG_ACCESS_DENIED'],
  [{ title: null, body: 'CAPTCHA' }, 'BUG_ACCESS_DENIED'],
  [{ title: null, body: 'Issue not found' }, 'BUG_NOT_FOUND'],
  [{ href: 'https://accounts.google.com/v3/signin' }, 'BUG_ACCESS_DENIED'],
  [{ fields: [] }, 'BUG_RESPONSE'],
  [{ title: null, body: '' }, 'BUG_TIMEOUT'],
]) {
  test(`serialized document readiness reports ${code} through the public query`, async () => {
    await expectFailure({ dom }, code);
  });
}

test('serialized DOM extractor reads semantic issue fields, people and dates only', () => {
  assert.deepEqual(extractFixture({
    fields: ['Status value is Assigned', 'Priority value is P2', 'Severity value is empty',
      'Type value is Bug', 'Component value is UI>Browser', 'unrelated value is secret'],
    people: [['Reporter', [' Person ']], ['Assignee', ['Owner', 'Owner', 'Other']], ['Verifier', ['Ignored']]],
    dates: ['2026-01-02T03:04:05Z', '2026-03-04T05:06:07Z'],
  }), {
    title: 'DOM title', state: 'Assigned', priority: 'P2', severity: null,
    type: 'Bug', component: 'UI>Browser', reporter: 'Person', assignees: ['Owner', 'Other'],
    createdAt: '2026-01-02T03:04:05Z', updatedAt: '2026-03-04T05:06:07Z', access: null,
  });
});

for (const [body, access] of [
  ['Please sign in to view this issue', 'login'],
  ["You don't have permission to view this issue", 'restricted'],
  ['Please verify you are human CAPTCHA', 'captcha'],
  ['Issue does not exist', 'not-found'],
]) {
  test(`DOM extractor detects ${access} without returning page body`, () => {
    const extracted = extractFixture({ title: null, body });
    assert.equal(extracted.access, access);
    assert.ok(!Object.values(extracted).includes(body));
  });
}

test('public titles mentioning restrictions do not falsely flag an access challenge', () => {
  assert.equal(extractFixture({ title: 'CAPTCHA access denied bug', body: 'captcha' }).access, null);
});

test('accounts redirect is a login failure even if unrelated title exists', () => {
  assert.equal(extractFixture({ href: 'https://accounts.google.com/v3/signin/identifier' }).access, 'login');
});
