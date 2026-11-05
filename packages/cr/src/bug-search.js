import { CrError } from './errors.js';

const TIMEOUT = 30_000;
const MAX_PAGES = 400;
const NEXT = 'b-pagination button[aria-label="Go to next page"]';
const failure = (code, message) => new CrError(code, message);

export function validateBugSearch(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 32768 ||
      /[\u0000-\u001f\u007f]/.test(query)) {
    throw failure('INVALID_PROFILE', 'Chromium bug search requires a nonempty query of at most 32768 characters without control characters.');
  }
}

// Serialized by Playwright. Return null while the search or page transition is loading.
export function extractBugSearchDocument({ after = 0, previousIds = [] } = {}) {
  if (/^https:\/\/accounts\.google\.com\//.test(document.location?.href || '')) return { access: 'login' };
  const root = document.querySelector('list-issues-page');
  if (root?.querySelector('[aria-busy="true"]')) return null;
  const rows = [...(root?.querySelectorAll('b-issues-grid tr[data-row-id]') || [])];
  if (!rows.length) {
    const body = document.body?.innerText || document.body?.textContent || '';
    if (/captcha|verify (?:that )?you are human|unusual traffic/i.test(body)) return { access: 'captcha' };
    if (/access denied|not authorized|sign in to (?:view|access)|restricted search/i.test(body)) return { access: 'restricted' };
    const empty = root?.querySelector('.no-results');
    if (/^No issues match your search\./.test(empty?.textContent?.trim() || '')) {
      return { ids: [], start: 0, end: 0, total: 0, next: false };
    }
    return null;
  }
  const range = root.querySelector('b-pagination [role="alert"]')?.textContent
    ?.replace(/[\s,]/g, '').match(/^(\d+)-(\d+)of(\d+|many)$/);
  const next = root.querySelector('b-pagination button[aria-label="Go to next page"]');
  if (!range || !next || Number(range[1]) <= after) return null;
  const ids = rows.map(row => row.getAttribute('data-row-id'));
  if (ids.length !== Number(range[2]) - Number(range[1]) + 1 ||
      ids.some(id => previousIds.includes(id))) return null;
  return {
    ids, start: Number(range[1]), end: Number(range[2]),
    total: range[3] === 'many' ? null : Number(range[3]), next: !next.disabled,
  };
}

function validatePage(raw, after, seen) {
  if (raw?.access) {
    throw failure('BUG_ACCESS_DENIED',
      'Chromium search requires sign-in or human verification; cr supports anonymous public results only and does not bypass access challenges.');
  }
  if (!raw || !Array.isArray(raw.ids) || typeof raw.next !== 'boolean' ||
      !Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) ||
      (raw.total !== null && (!Number.isSafeInteger(raw.total) || raw.total < 0)) ||
      raw.ids.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) ||
      new Set(raw.ids).size !== raw.ids.length || raw.ids.some(id => seen.has(id)) ||
      (raw.ids.length === 0
        ? after !== 0 || raw.start !== 0 || raw.end !== 0 || raw.total !== 0 || raw.next
        : raw.start !== after + 1 || raw.end !== after + raw.ids.length ||
          (raw.total !== null && (raw.total < raw.end || raw.next !== (raw.end < raw.total))))) {
    throw failure('BUG_RESPONSE', 'Chromium search returned invalid results or inconsistent pagination.');
  }
}

export async function discoverChromiumBugIds(context, query, limit, log = async () => {}) {
  validateBugSearch(query);
  let page, primary, phase = 'search-page';
  const started = Date.now();
  try {
    await log('chromium.search.start', { phase });
    try { page = await context.newPage(); } catch {
      throw failure('BROWSER_FAILED', 'Chromium could not create an anonymous search page.');
    }
    phase = 'search-goto';
    const url = new URL('https://issues.chromium.org/issues');
    url.searchParams.set('q', query);
    let response;
    try {
      response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    } catch (error) {
      throw failure(error?.name === 'TimeoutError' ? 'BUG_TIMEOUT' : 'BUG_UNAVAILABLE',
        'Chromium search navigation failed or timed out. Check network connectivity.');
    }
    let status;
    try { status = response?.status(); } catch {
      throw failure('BUG_HTTP', 'Chromium search returned an invalid HTTP response.');
    }
    if (!Number.isInteger(status)) throw failure('BUG_HTTP', 'Chromium search returned no HTTP response.');
    if (status >= 400) {
      throw failure([401, 403].includes(status) ? 'BUG_ACCESS_DENIED' : 'BUG_HTTP',
        `Chromium search returned HTTP ${status}.`);
    }
    const ids = [], seen = new Set();
    let after = 0, previousIds = [];
    for (let index = 0; index < MAX_PAGES; index++) {
      phase = 'search-ready';
      let handle, raw, extractionError;
      try {
        handle = await page.waitForFunction(extractBugSearchDocument, { after, previousIds }, { timeout: TIMEOUT });
        raw = await handle.jsonValue();
      } catch (error) {
        extractionError = failure(error?.name === 'TimeoutError' ? 'BUG_TIMEOUT' : 'BUG_EXTRACTION_FAILED',
          'Chromium search results did not become ready or could not be extracted.');
      } finally {
        if (handle) {
          try { await handle.dispose(); } catch {
            const cleanupError = failure('BROWSER_CLEANUP_FAILED', 'Chromium search metadata handle could not be released.');
            if (extractionError) extractionError.cause = cleanupError;
            else extractionError = cleanupError;
          }
        }
      }
      if (extractionError) throw extractionError;
      phase = 'search-extract';
      validatePage(raw, after, seen);
      await log('chromium.search.page', { phase, count: raw.ids.length });
      for (const id of raw.ids) seen.add(id);
      ids.push(...raw.ids.slice(0, limit - ids.length));
      const truncated = seen.size > limit || raw.next;
      if (ids.length >= limit || !raw.next) {
        await log('chromium.search.complete', {
          phase, count: ids.length, durationMs: Date.now() - started, outcome: 'success',
        });
        return { bugIds: ids, truncated };
      }
      if (index + 1 === MAX_PAGES) {
        throw failure('BUG_RESPONSE', 'Chromium search exceeded its safe pagination bound.');
      }
      after = raw.end;
      previousIds = raw.ids;
      phase = 'search-next';
      try { await page.locator(NEXT).click({ timeout: TIMEOUT }); } catch (error) {
        throw failure(error?.name === 'TimeoutError' ? 'BUG_TIMEOUT' : 'BUG_RENDER_FAILED',
          'Chromium search could not advance to the next results page.');
      }
    }
  } catch (error) {
    primary = error;
    try {
      await log('chromium.search.failed', {
        phase, code: error instanceof CrError ? error.code : 'BUG_RENDER_FAILED',
        durationMs: Date.now() - started, outcome: 'failed',
      });
    } catch (logError) {
      error.cause = logError;
    }
    throw error;
  } finally {
    if (page) {
      let cleanupError;
      try { await page.close(); } catch {
        cleanupError = failure('BROWSER_CLEANUP_FAILED', 'Chromium search page could not be closed.');
      }
      try {
        await log('browser.close', {
          phase: 'search-close', outcome: cleanupError ? 'failed' : 'success',
          ...(cleanupError ? { code: cleanupError.code } : {}),
        });
      } catch (error) { cleanupError ??= error; }
      if (cleanupError) {
        if (primary) primary.cause = new AggregateError(
          [primary.cause, cleanupError].filter(Boolean), 'Search cleanup or diagnostics failed.');
        else throw cleanupError;
      }
    }
  }
}
