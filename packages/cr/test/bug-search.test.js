import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverChromiumBugIds, extractBugSearchDocument, validateBugSearch } from '../src/bug-search.js';
import { queryChromiumBugs } from '../src/bugs.js';
import { CrError } from '../src/errors.js';

const privateError = () => new Error('PRIVATE query cookies HTML');
const timeout = () => Object.assign(privateError(), { name: 'TimeoutError' });
const resultPage = (ids, start = 1, next = false, total = next ? null : start + ids.length - 1) =>
  ({ ids, start, end: start + ids.length - 1, next, total });
const empty = { ids: [], start: 0, end: 0, total: 0, next: false };

function fixture(pages, options = {}) {
  const calls = [], events = [];
  let index = 0;
  const page = {
    async goto(url, settings) {
      calls.push(['goto', url, settings]);
      if (options.gotoError) throw options.gotoError;
      return options.noResponse ? null : { status: () => options.status ?? 200 };
    },
    async waitForFunction(fn, previous, settings) {
      calls.push(['ready', fn.name, previous, settings]);
      if (options.readyError) throw options.readyError;
      return {
        async jsonValue() { if (options.extractError) throw options.extractError; return pages[index]; },
        async dispose() { calls.push(['dispose']); if (options.disposeError) throw options.disposeError; },
      };
    },
    locator(selector) {
      assert.equal(selector, 'b-pagination button[aria-label="Go to next page"]');
      return { async click(settings) {
        calls.push(['next', settings]);
        if (options.nextError) throw options.nextError;
        index++;
      } };
    },
    async close() { calls.push(['close']); if (options.closeError) throw options.closeError; },
  };
  const context = { async newPage() {
    calls.push(['page']);
    if (options.pageError) throw options.pageError;
    return page;
  } };
  const log = async (event, fields) => {
    events.push({ event, ...fields });
    if (options.logErrorAt === event) throw new CrError('LOG_WRITE_FAILED', 'Diagnostic write failed.');
  };
  return { context, log, calls, events };
}

test('anonymous search URL encodes native query as data, not flags or extra URL parameters', async () => {
  const f = fixture([resultPage(['1', '2', '3'])]);
  const query = '-status:closed title:"memory & renderer" hotlistid:123';
  assert.deepEqual(await discoverChromiumBugIds(f.context, query, 2, f.log),
    { bugIds: ['1', '2'], truncated: true });
  const url = new URL(f.calls.find(c => c[0] === 'goto')[1]);
  assert.equal(url.origin, 'https://issues.chromium.org');
  assert.equal(url.pathname, '/issues');
  assert.deepEqual([...url.searchParams], [['q', query]]);
  assert.equal(f.calls.at(-1)[0], 'close');
  assert.doesNotMatch(JSON.stringify(f.events), /memory|renderer|123|query/);
});

test('native next-page controls are followed until completion with ordered unique IDs', async () => {
  const f = fixture([resultPage(['1', '2'], 1, true), resultPage(['3'], 3)]);
  assert.deepEqual(await discoverChromiumBugIds(f.context, 'type:bug', 10, f.log),
    { bugIds: ['1', '2', '3'], truncated: false });
  assert.equal(f.calls.filter(c => c[0] === 'next').length, 1);
  assert.deepEqual(f.calls.filter(c => c[0] === 'ready').map(c => c[2]),
    [{ after: 0, previousIds: [] }, { after: 2, previousIds: ['1', '2'] }]);
  assert.equal(f.calls.filter(c => c[0] === 'dispose').length, 2);
});

test('limit boundaries distinguish complete pages, more pages, partial pages and explicit empty results', async () => {
  for (const [page, limit, ids, truncated] of [
    [resultPage(['1', '2']), 2, ['1', '2'], false],
    [resultPage(['1', '2'], 1, true), 2, ['1', '2'], true],
    [resultPage(['1', '2', '3']), 2, ['1', '2'], true],
    [empty, 2, [], false],
  ]) {
    const f = fixture([page]);
    assert.deepEqual(await discoverChromiumBugIds(f.context, 'type:bug', limit, f.log),
      { bugIds: ids, truncated });
    assert.equal(f.calls.filter(c => c[0] === 'next').length, 0);
  }
});

test('invalid, stale, duplicate or incomplete pagination is not an empty or complete success', async () => {
  for (const page of [
    null, {}, { ...empty, next: true }, { ...empty, total: null },
    resultPage(['1', '1']), resultPage(['0']), resultPage([1]),
    { ...resultPage(['1']), end: 2 }, { ...resultPage(['1']), next: true },
    { ...resultPage(['1'], 1, true), total: 0 },
    { ...resultPage(['1']), start: 2 }, { ...resultPage(['1']), total: -1 },
  ]) {
    const f = fixture([page]);
    await assert.rejects(discoverChromiumBugIds(f.context, 'PRIVATE', 2, f.log), { code: 'BUG_RESPONSE' });
    assert.equal(f.calls.at(-1)[0], 'close');
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
  }
  for (const second of [empty, resultPage(['1'], 2), resultPage(['2'], 3)]) {
    const f = fixture([resultPage(['1'], 1, true), second]);
    await assert.rejects(discoverChromiumBugIds(f.context, 'type:bug', 2, f.log), { code: 'BUG_RESPONSE' });
  }
});

test('search failures are safe, explicit and close acquired pages', async () => {
  for (const [options, code] of [
    [{ pageError: privateError() }, 'BROWSER_FAILED'],
    [{ gotoError: privateError() }, 'BUG_UNAVAILABLE'],
    [{ gotoError: timeout() }, 'BUG_TIMEOUT'],
    [{ noResponse: true }, 'BUG_HTTP'],
    [{ status: 403 }, 'BUG_ACCESS_DENIED'], [{ status: 429 }, 'BUG_HTTP'],
    [{ readyError: timeout() }, 'BUG_TIMEOUT'],
    [{ readyError: privateError() }, 'BUG_EXTRACTION_FAILED'],
    [{ extractError: privateError() }, 'BUG_EXTRACTION_FAILED'],
    [{ disposeError: privateError() }, 'BROWSER_CLEANUP_FAILED'],
    [{ nextError: timeout() }, 'BUG_TIMEOUT'],
    [{ nextError: privateError() }, 'BUG_RENDER_FAILED'],
    [{ closeError: privateError() }, 'BROWSER_CLEANUP_FAILED'],
    [{ logErrorAt: 'chromium.search.page' }, 'LOG_WRITE_FAILED'],
    [{ logErrorAt: 'browser.close' }, 'LOG_WRITE_FAILED'],
  ]) {
    const f = fixture([resultPage(['1'], 1, true), resultPage(['2'], 2)], options);
    await assert.rejects(discoverChromiumBugIds(f.context, 'PRIVATE', 2, f.log), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /PRIVATE|cookies|HTML/);
      return true;
    });
    if (!options.pageError) assert.equal(f.calls.at(-1)[0], 'close');
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|cookies|HTML/);
  }
  for (const access of ['login', 'restricted', 'captcha']) {
    const f = fixture([{ access }]);
    await assert.rejects(discoverChromiumBugIds(f.context, 'PRIVATE', 1, f.log), { code: 'BUG_ACCESS_DENIED' });
  }
});

test('search page cleanup errors do not hide the original error', async () => {
  const f = fixture([empty], { gotoError: timeout(), closeError: privateError() });
  await assert.rejects(discoverChromiumBugIds(f.context, 'type:bug', 1, f.log), error =>
    error.code === 'BUG_TIMEOUT' && error.cause instanceof AggregateError);
});

test('search pagination has a finite bound and never reports incomplete traversal as complete', async () => {
  const f = fixture(Array.from({ length: 400 }, (_, n) => resultPage([String(n + 1)], n + 1, true)));
  await assert.rejects(discoverChromiumBugIds(f.context, 'type:bug', 20000, f.log), { code: 'BUG_RESPONSE' });
  assert.equal(f.calls.at(-1)[0], 'close');
});

test('search query validation rejects empty, oversized and control-character input', () => {
  for (const query of [undefined, null, {}, [], '', '  ', 'a'.repeat(32769), 'a\nb', 'a\u007fb']) {
    assert.throws(() => validateBugSearch(query), { code: 'INVALID_PROFILE' });
  }
  for (const query of ['type:bug status:open', '-status:closed', 'a'.repeat(32768)]) {
    assert.doesNotThrow(() => validateBugSearch(query));
  }
});

function documentFixture({ ids = ['1', '2'], range = '1 - 2 of 2', next = false, busy = false,
  emptyText, body = '', url = 'https://issues.chromium.org/issues' } = {}) {
  const root = {
    querySelector(selector) {
      if (selector === '[aria-busy="true"]') return busy ? {} : null;
      if (selector === '.no-results') return emptyText ? { textContent: emptyText } : null;
      if (selector === 'b-pagination [role="alert"]') return { textContent: range };
      if (selector.includes('Go to next page')) return { disabled: !next };
      return null;
    },
    querySelectorAll: () => ids.map(id => ({ getAttribute: () => id })),
  };
  return { location: { href: url }, body: { innerText: body }, querySelector: () => root };
}

function extract(document, previous) {
  const old = globalThis.document;
  globalThis.document = document;
  try { return extractBugSearchDocument(previous); } finally {
    if (old === undefined) delete globalThis.document; else globalThis.document = old;
  }
}

test('serialized DOM reader waits for finished rows and pagination, not the application shell', () => {
  assert.deepEqual(extract(documentFixture()), resultPage(['1', '2']));
  assert.deepEqual(extract(documentFixture({ range: '1\u00a0-\u00a02\u00a0of\u00a0many', next: true })),
    resultPage(['1', '2'], 1, true));
  for (const document of [
    documentFixture({ busy: true }), documentFixture({ ids: [] }),
    documentFixture({ range: 'loading' }), documentFixture({ range: '1 - 3 of 3' }),
  ]) assert.equal(extract(document), null);
  assert.equal(extract(documentFixture(), { after: 2 }), null);
  assert.equal(extract(documentFixture({ ids: ['1', '2'], range: '3 - 4 of 4' }),
    { after: 2, previousIds: ['1', '2'] }), null);
  assert.deepEqual(extract(documentFixture({ ids: [], emptyText: 'No issues match your search. Click to see all open issues' })), empty);
  assert.equal(extract(documentFixture({ ids: [], emptyText: 'Loading...' })), null);
  assert.deepEqual(extract(documentFixture({ url: 'https://accounts.google.com/login' })), { access: 'login' });
  assert.deepEqual(extract(documentFixture({ ids: [], body: 'Verify you are human' })), { access: 'captcha' });
  // Bug titles containing access-related words must not be interpreted as a denial.
  assert.deepEqual(extract(documentFixture({ body: 'Access denied bug' })), resultPage(['1', '2']));
});

test('bug search hydrates selected IDs in the same fresh context and preserves truncation', async () => {
  const f = fixture([resultPage(['1', '2', '3'])]);
  let pages = 0, contexts = 0;
  const closed = [];
  const chromium = { async launch(settings) {
    assert.deepEqual(settings, { headless: true });
    return {
      async newContext(settings) {
        contexts++;
        assert.deepEqual(settings, { locale: 'en-US' });
        return {
          async newPage() {
            if (pages++ === 0) return f.context.newPage();
            return {
              async goto(url) { closed.push(url); return { status: () => 200 }; },
              async waitForFunction() {},
              async evaluate() { return { title: 'Bug', state: 'New' }; },
              async close() { closed.push('detail-close'); },
            };
          },
          async close() { closed.push('context-close'); },
        };
      },
      async close() { closed.push('browser-close'); },
    };
  } };
  const result = await queryChromiumBugs({ provider: 'chromium', resource: 'bugs', query: 'type:bug', limit: 2 },
    { chromium, log: f.log });
  assert.equal(contexts, 1);
  assert.equal(pages, 3);
  assert.deepEqual(result.items.map(item => item.id), ['1', '2']);
  assert.equal(result.truncated, true);
  assert.deepEqual(closed, ['https://issues.chromium.org/issues/1', 'detail-close',
    'https://issues.chromium.org/issues/2', 'detail-close', 'context-close', 'browser-close']);
});

test('search errors and empty results still close browser resources without bug hydration', async () => {
  for (const raw of [empty, { access: 'captcha' }]) {
    const f = fixture([raw]);
    const closed = [];
    const chromium = { async launch() { return {
      async newContext() { return { ...f.context, async close() { closed.push('context'); } }; },
      async close() { closed.push('browser'); },
    }; } };
    const action = queryChromiumBugs({ provider: 'chromium', resource: 'bugs', query: 'type:bug', limit: 1 }, { chromium });
    if (raw.access) await assert.rejects(action, { code: 'BUG_ACCESS_DENIED' });
    else assert.deepEqual(await action, { items: [], truncated: false });
    assert.deepEqual(closed, ['context', 'browser']);
  }
});
