import { CrError } from './errors.js';
import { discoverChromiumBugIds, validateBugSearch } from './bug-search.js';

const TIMEOUT = 30_000;
const READY_TIMEOUT = 15_000;
const ID = /^[1-9]\d{0,15}$/;

function failure(code, message, reason) {
  const error = new CrError(code, message);
  if (reason) error.reason = reason;
  return error;
}

// This function is serialized by Playwright; keep it independent of module scope.
export function extractBugDocument() {
  const text = node => node?.textContent?.trim() || null;
  const title = text(document.querySelector('issue-title h3'));
  const result = {
    title, state: null, priority: null, severity: null, type: null,
    component: null, reporter: null, assignees: [], createdAt: null, updatedAt: null,
    access: null,
  };
  if (/^https:\/\/accounts\.google\.com\//.test(document.location?.href || '')) {
    result.access = 'login';
  } else if (!title) {
    const body = document.body?.innerText || document.body?.textContent || '';
    if (/captcha|verify (?:that )?you are human|unusual traffic/i.test(body)) result.access = 'captcha';
    else if (/permission|access denied|not authorized|restricted issue/i.test(body)) result.access = 'restricted';
    else if (/sign in to (?:view|access)|log in to (?:view|access)/i.test(body)) result.access = 'login';
    else if (/issue (?:does not exist|not found)|could not find (?:the |this )?issue/i.test(body)) result.access = 'not-found';
  }
  document.querySelectorAll('[aria-label*="value is"]').forEach(node => {
    const match = node.getAttribute('aria-label')?.match(/^(.+?)\s+value is\s+(.+)$/);
    if (!match || match[2].trim().toLowerCase() === 'empty') return;
    const key = match[1].toLowerCase().replace(/[^a-z]/g, '');
    const field = key === 'status' ? 'state' : key;
    if (['state', 'priority', 'severity', 'type', 'component'].includes(field)) {
      result[field] = match[2].trim();
    }
  });
  document.querySelectorAll('onedev-field-label').forEach(label => {
    const name = text(label.querySelector('.label'))?.replace(/:$/, '').toLowerCase();
    if (!['reporter', 'assignee'].includes(name)) return;
    const wrapper = label.closest('.wrapper') || label.parentElement;
    const people = [...(wrapper?.querySelectorAll('onedev-field-value .user-chip-name') || [])]
      .map(text).filter(Boolean);
    if (name === 'reporter') result.reporter = people[0] || null;
    else result.assignees = [...new Set(people)];
  });
  const dates = document.querySelectorAll('b-formatted-date-time time[datetime]');
  result.createdAt = dates[0]?.getAttribute('datetime') ?? null;
  result.updatedAt = dates[1]?.getAttribute('datetime') ?? null;
  return result;
}

function bugDocumentReady() {
  const title = document.querySelector('issue-title h3')?.textContent?.trim();
  const state = [...document.querySelectorAll('[aria-label*="value is"]')]
    .some(node => /^Status\s+value is\s+\S/i.test(node.getAttribute('aria-label') || ''));
  if (title && state) return true;
  if (/^https:\/\/accounts\.google\.com\//.test(document.location?.href || '')) return true;
  if (title) return false;
  return /captcha|verify (?:that )?you are human|unusual traffic|permission|access denied|not authorized|restricted issue|sign in to (?:view|access)|log in to (?:view|access)|issue (?:does not exist|not found)|could not find (?:the |this )?issue/i
    .test(document.body?.innerText || document.body?.textContent || '');
}

function timestamp(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw failure('BUG_RESPONSE', 'Chromium returned an invalid timestamp.', 'invalid-date');
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed) ||
      +match[2] < 1 || +match[2] > 12 || +match[3] < 1 ||
      +match[3] > new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate() ||
      +match[4] > 23 || +match[5] > 59 || +match[6] > 59) {
    throw failure('BUG_RESPONSE', 'Chromium returned an invalid timestamp with no reliable UTC offset.', 'invalid-date');
  }
  return new Date(parsed).toISOString();
}

function normalize(raw, bugId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw failure('BUG_EXTRACTION_FAILED', 'Chromium bug metadata could not be extracted.');
  }
  const accessErrors = {
    login: ['BUG_ACCESS_DENIED', 'Chromium requires sign-in to view this bug; only anonymous public bugs are supported.'],
    restricted: ['BUG_ACCESS_DENIED', 'Chromium denied anonymous access to this bug.'],
    captcha: ['BUG_ACCESS_DENIED', 'Chromium requires human verification; cr does not bypass access challenges.'],
    'not-found': ['BUG_NOT_FOUND', 'Chromium could not find this bug.'],
  };
  if (raw.access) {
    const reason = Object.hasOwn(accessErrors, raw.access) ? raw.access : 'restricted';
    throw failure(...accessErrors[reason], reason);
  }
  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    throw failure('BUG_RESPONSE', 'Chromium returned no bug title.', 'missing-title');
  }
  if (typeof raw.state !== 'string' || !raw.state.trim()) {
    throw failure('BUG_RESPONSE', 'Chromium returned no bug state.', 'missing-state');
  }
  const optional = value => {
    if (value == null) return null;
    if (typeof value !== 'string') throw failure('BUG_EXTRACTION_FAILED', 'Chromium returned invalid bug metadata.');
    return value.trim() || null;
  };
  if (raw.assignees != null && !Array.isArray(raw.assignees)) {
    throw failure('BUG_EXTRACTION_FAILED', 'Chromium returned invalid bug assignees.');
  }
  return {
    provider: 'chromium', kind: 'bug', id: bugId, title: raw.title.trim(),
    state: raw.state.trim(), url: `https://issues.chromium.org/issues/${bugId}`,
    repository: null, author: optional(raw.reporter),
    assignees: [...new Set((raw.assignees || []).map(optional).filter(Boolean))],
    labels: [], createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt),
    draft: null,
    priority: optional(raw.priority), severity: optional(raw.severity), type: optional(raw.type),
    providerData: { component: optional(raw.component) },
  };
}

function validateProfile(profile) {
  const allowed = new Set(['provider', 'resource', 'bugIds', 'query', 'refreshSeconds', 'limit']);
  if (!profile || profile.provider !== 'chromium' || profile.resource !== 'bugs' ||
      Object.keys(profile).some(key => !allowed.has(key)) ||
      !Number.isInteger(profile.limit) || profile.limit < 1 || profile.limit > 20_000) {
    throw failure('INVALID_PROFILE', 'Chromium bugs require supported profile fields and a limit from 1 to 20000.');
  }
  if (profile.query !== undefined) {
    validateBugSearch(profile.query);
    if (profile.bugIds !== undefined) throw failure('INVALID_PROFILE', 'Chromium bug search cannot be combined with bug IDs.');
  } else if (!Array.isArray(profile.bugIds) || profile.bugIds.length < 1 || profile.bugIds.length > 100 ||
      profile.bugIds.some(id => typeof id !== 'string' || !ID.test(id)) ||
      new Set(profile.bugIds).size !== profile.bugIds.length) {
    throw failure('INVALID_PROFILE', 'Chromium bug lookup requires 1-100 unique numeric string bug IDs.');
  }
}

export async function queryChromiumBugs(profile, dependencies = {}) {
  validateProfile(profile);
  const log = dependencies.log || (async () => {});
  let browser, context, primary;
  const cleanupFailures = [];
  async function cleanup(resource, phase, bugId) {
    if (!resource) return;
    let error;
    try {
      await resource.close();
    } catch {
      error = failure('BROWSER_CLEANUP_FAILED', 'Chromium browser resources could not be closed.');
      cleanupFailures.push(error);
    }
    try {
      await log('browser.close', {
        phase, ...(bugId ? { bugId } : {}), outcome: error ? 'failed' : 'success',
        ...(error ? { code: error.code } : {}),
      });
    } catch (logError) {
      cleanupFailures.push(logError);
    }
  }
  try {
    await log('browser.start', { phase: 'launch' });
    let chromium = dependencies.chromium;
    if (!chromium) {
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        await log('browser.failed', { phase: 'import', code: 'BROWSER_FAILED' });
        throw failure('BROWSER_FAILED', 'Playwright is unavailable. Install cr dependencies before viewing Chromium bugs.');
      }
    }
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const missing = /executable doesn't exist|please run.*playwright install|browser.*(?:not found|not installed)/is.test(error?.message || '');
      const code = missing ? 'BROWSER_NOT_INSTALLED' : 'BROWSER_FAILED';
      await log('browser.failed', { phase: 'launch', code });
      throw failure(code, missing
        ? 'Playwright Chromium is not installed. Run npx playwright install chromium --only-shell, then retry.'
        : 'Chromium could not start. Check the local browser installation and operating-system requirements.');
    }
    try {
      context = await browser.newContext({ locale: 'en-US' });
    } catch {
      await log('browser.failed', { phase: 'context', code: 'BROWSER_FAILED' });
      throw failure('BROWSER_FAILED', 'Chromium could not create an anonymous browser context.');
    }
    await log('browser.ready', { phase: 'context' });
    const selection = profile.query !== undefined
      ? await discoverChromiumBugIds(context, profile.query, profile.limit, log)
      : { bugIds: profile.bugIds.slice(0, profile.limit), truncated: profile.bugIds.length > profile.limit };
    const items = [];
    for (const bugId of selection.bugIds) {
      let page, bugError, phase = 'page';
      const started = Date.now();
      try {
        await log('chromium.bug.start', { phase, bugId });
        try { page = await context.newPage(); } catch {
          throw failure('BROWSER_FAILED', 'Chromium could not create a bug page.');
        }
        phase = 'goto';
        let response;
        try {
          response = await page.goto(`https://issues.chromium.org/issues/${bugId}`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT,
          });
        } catch (error) {
          throw failure(error?.name === 'TimeoutError' ? 'BUG_TIMEOUT' : 'BUG_UNAVAILABLE',
            'Chromium bug navigation failed or timed out. Check network connectivity.');
        }
        let httpStatus;
        try { httpStatus = response?.status(); } catch {
          throw failure('BUG_HTTP', 'Chromium returned an invalid HTTP response.');
        }
        if (!Number.isInteger(httpStatus)) throw failure('BUG_HTTP', 'Chromium returned no HTTP response.');
        if (httpStatus >= 400) {
          await log('chromium.bug.http', { phase, bugId, httpStatus });
          const code = httpStatus === 404 ? 'BUG_NOT_FOUND'
            : [401, 403].includes(httpStatus) ? 'BUG_ACCESS_DENIED' : 'BUG_HTTP';
          throw failure(code, `Chromium bug request returned HTTP ${httpStatus}.`);
        }
        phase = 'ready';
        let readyError;
        try {
          await page.waitForFunction(bugDocumentReady, null, { timeout: READY_TIMEOUT });
        } catch (error) {
          readyError = failure(error?.name === 'TimeoutError' ? 'BUG_TIMEOUT' : 'BUG_RENDER_FAILED',
            'Chromium bug metadata did not become ready before the page deadline.');
        }
        phase = 'extract';
        let raw;
        try { raw = await page.evaluate(extractBugDocument); } catch {
          throw failure('BUG_EXTRACTION_FAILED', 'Chromium bug metadata extraction failed.');
        }
        if (readyError && !raw?.access) {
          if (raw?.title && (typeof raw.state !== 'string' || !raw.state.trim())) {
            throw failure('BUG_RESPONSE', 'Chromium returned no bug state before the page deadline.', 'missing-state');
          }
          phase = 'ready';
          throw readyError;
        }
        phase = 'normalize';
        items.push(normalize(raw, bugId));
        await log('chromium.bug.complete', {
          phase, bugId, httpStatus, durationMs: Date.now() - started, outcome: 'success',
        });
      } catch (error) {
        bugError = error;
        try {
          await log('chromium.bug.failed', {
            phase, bugId, durationMs: Date.now() - started,
            code: error instanceof CrError ? error.code : 'BUG_RENDER_FAILED',
            ...(error instanceof CrError && error.reason ? { reason: error.reason } : {}),
            outcome: 'failed',
          });
        } catch (logError) {
          cleanupFailures.push(logError);
        }
      } finally {
        await cleanup(page, 'page-close', bugId);
      }
      if (bugError) throw bugError;
      if (cleanupFailures.length) throw cleanupFailures.shift();
    }
    return { items, truncated: selection.truncated };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await cleanup(context, 'context-close');
    await cleanup(browser, 'browser-close');
    if (cleanupFailures.length) {
      const error = primary || cleanupFailures[0];
      const additional = cleanupFailures.filter(other => other !== error);
      if (additional.length) {
        error.cause = new AggregateError(additional, 'Chromium cleanup or diagnostic logging failed.');
      }
      if (!primary) throw error;
    }
  }
}
