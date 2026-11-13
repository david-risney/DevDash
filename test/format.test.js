import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatResults } from '../src/format.js';
import { testItem } from './helpers/test-provider.js';

const formats = ['markdown', 'ansi', 'text'];
const bugEmoji = ['\u{1f41b}', '\u{1f41e}', '\u{1f41c}', '\u{1f41d}', '\u{1f997}', '\u{1f99f}'];
const snapshot = (overrides = {}) => ({
  schemaVersion: 1, profile: 'work', query: 'bugs', provider: 'github', resource: 'bugs',
  fetchedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:00.000Z',
  truncated: false, stale: false, fromCache: true, items: [testItem()], ...overrides,
});
const failure = { profile: 'failed-profile', error: { code: 'CLI_FAILED', message: 'Authentication failed.', diagnosticId: 'example-id' } };
const cli = fileURLToPath(new URL('../bin/devdash.js', import.meta.url));
const cliFormats = { ansi: 'ansi', text: 'ascii', markdown: 'md' };

async function convert(format, input, args = [], chunks) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-format-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'format', '--format', cliFormats[format], ...args], {
        windowsHide: true, shell: false, env: { ...process.env, DEVDASH_HOME: home },
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      if (chunks) {
        child.stdin.write(chunks[0]);
        setTimeout(() => child.stdin.end(chunks[1]), 150);
      } else {
        child.stdin.end(input);
      }
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('all formats show grouped tables, failures, empty results and important cache warnings without debug metadata', () => {
  const document = { schemaVersion: 1, failed: 1, results: [
    { schemaVersion: 1, profile: 'work', failed: 1, queries: {
      bugs: snapshot({ stale: true, truncated: true }),
      empty: snapshot({ query: 'empty', items: [] }),
      unavailable: { error: { code: 'CACHE_MISS', message: 'Refresh needed.' } },
    } },
    failure,
  ] };
  const before = structuredClone(document);
  for (const format of formats) {
    const { output, failed } = formatResults(document, format);
    assert.equal(failed, 2);
    for (const text of ['work / bugs', 'Synthetic cache regression', 'TRUNCATED',
      'work / empty', 'No items found.', 'unavailable', 'Error: Refresh needed',
      'failed', 'Error: Authentication failed', ...(format === 'ansi' ? [] : ['cached', 'GitHub', 'Title', 'Status'])]) {
      assert.ok(output.includes(text), `${format}: ${text}`);
    }
    for (const hidden of ['fetchedAt', 'expiresAt', 'diagnosticId', 'schemaVersion', 'providerData']) {
      assert.ok(!output.includes(hidden), `${format}: hides ${hidden}`);
    }
    assert.ok(output.includes('https://example.com/items/1'));
    assert.ok(!output.includes('STALE'));
  }
  assert.deepEqual(document, before);
});

test('bare cr results, single snapshots, errors, and empty documents have explicit presentations', () => {
  for (const format of formats) {
    const item = testItem({ provider: 'chromium', kind: 'bug', priority: 'P2', severity: 'S2', type: 'Bug',
      providerData: { component: 'UI' } });
    const { output } = formatResults({ schemaVersion: 1, items: [item], truncated: true }, format);
    for (const expected of ['Chromium', 'bugs', 'P2', 'S2', ...(format === 'ansi' ? [] : ['Priority', 'Severity'])]) {
      assert.ok(output.includes(expected), `${format}: ${expected}`);
    }
    for (const hidden of ['providerData', 'component', 'type:', 'UI', 'createdAt', 'updatedAt']) {
      assert.ok(!output.includes(hidden));
    }
    assert.match(formatResults({ schemaVersion: 1, items: [], truncated: false }, format).output, /No items/);
    assert.match(formatResults({ schemaVersion: 1, results: [], failed: 0 }, format).output, /No query results/);
    assert.match(formatResults({ schemaVersion: 1, queries: {}, failed: 0 }, format).output, /No query results/);
    assert.equal(formatResults(failure, format).failed, 1);
  }
});

test('all formats accept enriched ADO PR properties without printing them or mutating JSON', async () => {
  const rows = [
    testItem({ provider: 'ado', kind: 'pr', providerData: {
      properties: { ReviewMetadata: { $type: 'System.String', $value: '{"private":"HIDDEN_PROPERTY_PAYLOAD"}' } },
    } }),
    testItem({ provider: 'ado', kind: 'pr', id: '2', providerData: {
      properties: { BuildMetadata: { $type: 'System.Boolean', $value: true } },
    } }),
    testItem({ provider: 'ado', kind: 'pr', id: '3', providerData: { properties: {} } }),
  ];
  const section = snapshot({ provider: 'ado', resource: 'prs', items: rows });
  const documents = [
    section,
    { schemaVersion: 1, items: rows, truncated: false },
    { schemaVersion: 1, profile: 'work', queries: { reviews: section } },
    { schemaVersion: 1, results: [{ schemaVersion: 1, profile: 'work', queries: { reviews: section } }] },
    snapshot({ provider: 'ado', resource: 'prs', items: [rows[2]] }),
  ];
  const original = structuredClone(documents);
  for (const format of formats) {
    for (const document of documents) {
      const { output, failed } = formatResults(document, format);
      assert.equal(failed, 0);
      assert.ok(output.includes('Synthetic cache regression'));
      for (const hidden of ['ReviewMetadata', 'BuildMetadata', 'HIDDEN_PROPERTY_PAYLOAD', '$type', '$value']) {
        assert.ok(!output.includes(hidden));
      }
    }
    const result = await convert(format, JSON.stringify(documents[3]));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('HIDDEN_PROPERTY_PAYLOAD'));
  }
  assert.deepEqual(documents, original);
});

test('formatting still rejects malformed property envelopes and properties on other providers', () => {
  const row = testItem({ provider: 'ado', kind: 'pr', providerData: { properties: {} } });
  for (const properties of [null, [], 'invalid', { ReviewMetadata: {} },
    { ReviewMetadata: { $type: 'System.String', $value: {} } }]) {
    assert.throws(() => formatResults(snapshot({
      provider: 'ado', resource: 'prs', items: [{ ...row, providerData: { properties } }],
    }), 'text'), /Invalid DevDash/);
  }
  assert.throws(() => formatResults(snapshot({
    provider: 'ado', resource: 'prs', items: [row, { ...row, id: '2', providerData: {} }],
  }), 'text'), /Invalid DevDash/);
  assert.throws(() => formatResults(snapshot({
    items: [testItem({ providerData: { properties: {} } })],
  }), 'text'), /Invalid DevDash/);
});

test('Markdown escapes untrusted labels and HTML and keeps URL delimiters inside the link destination', () => {
  const item = testItem({
    title: 'Bad [label](javascript:alert(1)) <img> & *bold* | table `code`',
    url: 'https://example.com/a_(b)?x=%22',
    labels: ['[injected]', '<script>'],
  });
  const { output } = formatResults(snapshot({ items: [item], profile: '# heading' }), 'markdown');
  assert.ok(output.includes('## \\# heading'));
  assert.ok(output.includes('Bad \\[label\\]\\(javascript:alert\\(1\\)\\) &lt;img&gt; &amp; \\*bold\\* \\| table \\`code\\`'));
  assert.ok(output.includes('(https://example.com/a_%28b%29?x=%22)'));
  assert.ok(!output.includes('<img>'));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('\x1b'));
  const table = output.split('\n').filter(line => line.startsWith('|'));
  assert.equal(table[0], '| Item | Title | Status |');
  assert.equal(table.length, 3);
  assert.equal(table[2].match(/(?<!\\)\|/g).length, table[0].match(/\|/g).length);
});

test('friendly columns select the relevant person, priority, UTC date and repository without dumping source fields', () => {
  const items = [
    testItem({ assignees: ['Alice'], priority: 'P1', severity: 'S2', updatedAt: '2026-02-03T04:05:06.000Z',
      labels: ['HIDDEN_LABEL'], providerData: { nodeId: 'HIDDEN_NODE' } }),
    testItem({ id: '2', title: 'Second bug', repository: 'another/repo' }),
  ];
  const output = formatResults(snapshot({ items }), 'markdown', { now: new Date('2027-01-01T00:00:00Z') }).output;
  assert.ok(output.includes('| Item | Title | Status | Assignee | Repository | Priority | Severity | Updated |'));
  assert.ok(output.includes('| Alice | example/repo | P1 | S2 | 2026\\-02\\-03 |'));
  assert.ok(output.includes('| - | another/repo | - | - | - |'));
  assert.ok(!output.includes('HIDDEN_'));
  assert.ok(!output.includes('04:05:06'));
  const common = formatResults(snapshot(), 'markdown').output;
  assert.ok(common.includes('GitHub \\- bugs \\- example/repo'));
  assert.ok(!common.includes('| Repository |'));
  assert.ok(!common.includes('| Priority |'));
  assert.ok(!common.includes('| Updated |'));
  const pr = testItem({ kind: 'pr', provider: 'github', author: 'Alice', assignees: ['Bob'], draft: true });
  const review = formatResults(snapshot({ resource: 'prs', items: [pr] }), 'markdown').output;
  assert.ok(!review.includes('| Author |'));
  assert.ok(review.includes('| Draft / Open |'));
  assert.ok(!review.includes('Alice'));
  assert.ok(!review.includes('Bob'));
  assert.ok(!review.includes('assignees'));
});

test('all formats omit uniform people per query, comparing assignee sets independently of their order', () => {
  const bugLists = [
    [testItem({ assignees: ['Alice'] })],
    [testItem({ assignees: ['Alice'] }), testItem({ id: '2', author: 'different-author', assignees: ['Alice'] })],
    [testItem({ assignees: ['Alice', 'Bob'] }), testItem({ id: '2', assignees: ['Bob', 'Alice', 'Bob'] })],
    [testItem(), testItem({ id: '2' })],
  ];
  const prLists = [
    [testItem({ kind: 'pr', author: 'Alice' })],
    [testItem({ kind: 'pr', author: 'Alice' }), testItem({ id: '2', kind: 'pr', author: 'Alice', assignees: ['Bob'] })],
    [testItem({ kind: 'pr', author: null }), testItem({ id: '2', kind: 'pr', author: null })],
  ];
  for (const format of formats) {
    for (const items of bugLists) {
      const { output } = formatResults(snapshot({ items }), format);
      assert.ok(!output.includes('Assignee'), format);
      assert.ok(!output.includes('Alice'));
      assert.ok(!output.includes('Bob'));
    }
    for (const items of prLists) {
      const { output } = formatResults(snapshot({ resource: 'prs', items }), format);
      assert.ok(!output.includes('Author'), format);
      assert.ok(!output.includes('Alice'));
    }
    for (const assignees of [[], ['Bob'], ['Alice', 'Bob']]) {
      const items = [testItem({ assignees: ['Alice'] }), testItem({ id: '2', assignees })];
      assert.ok(formatResults(snapshot({ items }), format).output.includes(format === 'ansi' ? 'Alice' : 'Assignee'), format);
    }
    for (const author of [null, 'Bob']) {
      const items = [testItem({ kind: 'pr', author: 'Alice' }), testItem({ id: '2', kind: 'pr', author })];
      assert.ok(formatResults(snapshot({ resource: 'prs', items }), format).output.includes(format === 'ansi' ? 'Alice' : 'Author'), format);
    }
    const grouped = { queries: {
      alice: snapshot({ query: 'alice', items: [testItem({ assignees: ['Alice'] })] }),
      bob: snapshot({ query: 'bob', items: [testItem({ assignees: ['Bob'] })] }),
    } };
    assert.ok(!formatResults(grouped, format).output.includes('Assignee'));
  }
});

test('all formats omit only the current UTC year and restore it automatically after year rollover', () => {
  const items = [
    testItem({ updatedAt: '2026-03-04T05:06:07.000Z' }),
    testItem({ id: '2', updatedAt: '2025-12-31T23:59:59.000Z' }),
    testItem({ id: '3', updatedAt: '2027-01-01T00:00:00.000Z' }),
    testItem({ id: '4', updatedAt: null }),
  ];
  for (const format of formats) {
    const now = new Date('2026-12-31T23:59:59Z');
    const { output } = formatResults(snapshot({ items }), format, { now });
    const date = value => format === 'markdown' ? value.replaceAll('-', '\\-') : value;
    for (const expected of ['03-04', '2025-12-31', '2027-01-01']) assert.ok(output.includes(date(expected)), format);
    assert.ok(!output.includes('2026'), format);
    const next = formatResults(snapshot({ items }), format, { now: new Date('2027-01-01T00:00:00Z') }).output;
    assert.ok(next.includes(date('2026-03-04')), format);
    assert.ok(!next.includes('2027'), format);
  }
  assert.throws(() => formatResults(snapshot(), 'text', { now: new Date(NaN) }), /Current date/);
});

const stripLinks = value => value.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const stripAnsi = value => stripLinks(value).replace(/\x1b\[[\d;]*m/g, '');
function rawTableLines(output) {
  const lines = output.split('\n');
  const first = lines.findIndex(line => /^(?:Item\s+\||[\u2590\ue0b6\u{1fbee}] )/u.test(stripAnsi(line)));
  assert.ok(first !== -1, 'Expected an aligned table');
  const end = lines.indexOf('', first);
  return lines.slice(first, end === -1 ? undefined : end);
}

const tableLines = output => rawTableLines(output).map(stripAnsi);
const bodyLines = output => {
  const lines = rawTableLines(output);
  return lines[0].includes('\x1b[')
    ? lines.filter(line => line.includes('\x1b[0;48;2;31;41;51;') || line.includes('\x1b[0;48;2;39;51;63;'))
    : lines.slice(2);
};
function tableCells(line) {
  if (!line.includes('\x1b[')) return line.split(' | ').map(cell => cell.trim());
  const parts = [...stripLinks(bandLine(line)).matchAll(/\x1b\[[\d;]*m([^\x1b]*)/g)].map(match => match[1]);
  return parts.slice(1, -1).map(cell => cell.trim());
}
const bandLine = line => {
  const cap = line.lastIndexOf('\x1b[0;38;2;');
  const content = line.slice(line.indexOf('\x1b[0;48;2;'), cap < 0 ? line.lastIndexOf('\x1b[0m') : cap);
  return cap < 0 ? content.replace(/^(\x1b\[[\d;]*m) /, '$1').slice(0, -1) : content;
};
const cellCount = value => [...value].length;

test('console tables wrap rather than truncate long titles, preserving full information in narrow terminals', () => {
  const title = 'A lengthy bug title with enough words to wrap across several lines without losing any details';
  const row = testItem({ title, assignees: ['person-with-a-long-name@example.com'],
    priority: 'P2', severity: 'S2', updatedAt: '2026-02-03T04:05:06.000Z' });
  for (const columns of [24, 40, 80, 120]) {
    for (const format of ['text', 'ansi']) {
      const output = formatResults(snapshot({ items: [row] }), format, { columns }).output;
      const lines = tableLines(output);
      const headers = format === 'text' ? tableCells(rawTableLines(output)[0]) : [];
      if (format === 'text') assert.deepEqual(headers.slice(0, 3), ['Item', 'Title', 'Status']);
      const cells = bodyLines(output).map(tableCells);
      const restored = cells.map(cells => cells[1].trim()).filter(Boolean).join(' ');
      // Narrow columns may split individual words as well as wrapping on spaces.
      assert.equal(restored.replace(/ /g, ''), title.replace(/ /g, ''));
      for (const line of lines) {
        assert.ok(cellCount(line.replaceAll(bugEmoji[1], 'xx')) <= columns, `${format} ${columns}: ${line}`);
      }
      if (columns === 24) {
        assert.ok(!headers.includes('Assignee'));
        assert.ok(!headers.includes('Updated'));
      }
    }
  }
});

test('emoji, CJK and combining sequences do not shift console table columns', () => {
  const items = [
    testItem({ title: '\u4fee\u590d e\u0301 \u{1f469}\u200d\u{1f4bb}', assignees: ['Alice'] }),
    testItem({ id: '2', title: 'ASCII', assignees: ['Bob'] }),
    testItem({ id: '3', title: '\u00a9 \u2600\ufe0e \u2600\ufe0f \u{1f1fa}\u{1f1f8}', assignees: ['Carol'] }),
  ];
  const width = value => cellCount(bugEmoji.reduce((text, emoji) => text.replaceAll(emoji, 'xx'), value).replaceAll('\u4fee\u590d', 'xxxx')
    .replaceAll('e\u0301', 'e').replaceAll('\u{1f469}\u200d\u{1f4bb}', 'xx')
    .replaceAll('\u2600\ufe0e', 'x').replaceAll('\u2600\ufe0f', 'xx').replaceAll('\u{1f1fa}\u{1f1f8}', 'xx'));
  for (const format of ['text', 'ansi']) {
    const output = formatResults(snapshot({ items }), format, { columns: 80 }).output;
    const lines = tableLines(output);
    if (format === 'ansi') {
      const first = stripLinks(bandLine(bodyLines(output)[0]));
      const expected = [...first.matchAll(/\x1b\[[\d;]*m/g)].slice(1, -1)
        .map(cell => width(stripAnsi(first.slice(0, cell.index))));
      for (const raw of bodyLines(output)) {
        const inner = stripLinks(bandLine(raw));
        const cells = [...inner.matchAll(/\x1b\[[\d;]*m/g)].slice(1, -1);
        assert.deepEqual(cells.map(cell => width(stripAnsi(inner.slice(0, cell.index)))), expected);
      }
    } else {
      const offsets = line => line.split('|').slice(0, -1)
        .map((_, index, parts) => width(parts.slice(0, index + 1).join('|')));
      const expected = offsets(lines[0]);
      for (const line of lines.slice(2)) assert.deepEqual(offsets(line), expected);
    }
    assert.ok(lines.every(line => width(line) === width(lines[0])));
  }
});

test('ANSI tables have SGR colors, linked IDs and emoji; plain tables use a separate link reference list', () => {
  const input = snapshot();
  const { output } = formatResults(input, 'ansi');
  assert.match(output, /\x1b\[\d/);
  assert.ok(output.includes('\x1b]8;;https://example.com/items/1\x1b\\'));
  assert.ok(output.includes(bugEmoji[1]));
  assert.ok(output.includes('\ueacd'));
  assert.ok(output.includes('work / bugs'));
  assert.ok(!output.includes('\ueaf7'));
  assert.ok(!output.includes('\ueace'));
  assert.ok(!output.includes('Title'));
  assert.match(stripAnsi(output), /^\u2590 .* \u258c$/m);
  assert.doesNotMatch(output, /[\u2500-\u257f]/);
  assert.ok(!output.includes('Links:'));
  const plain = formatResults(input, 'text').output;
  assert.doesNotMatch(plain, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.ok(!plain.includes('\u{1f41b}'));
  assert.match(plain, /#1\s+\| Synthetic cache regression \| Open/);
  assert.match(plain, /Links:\n  #1 https:\/\/example.com\/items\/1/);
  assert.ok(plain.includes('https://example.com/items/1'));
  const pr = testItem({ kind: 'pr', provider: 'ado', state: 'active', draft: true,
    sourceBranch: 'feature', targetBranch: 'main', reviewers: ['Reviewer'],
    providerData: { mergeStatus: 'conflicts', reviewerVotes: [{ reviewer: 'Reviewer', vote: -5, required: true }] } });
  const ansi = formatResults(snapshot({ provider: 'ado', resource: 'prs', items: [pr] }), 'ansi').output;
  assert.ok(ansi.includes('\uea64'));
  assert.ok(ansi.includes('\x1b[38;2;249;211;128;22mDraft / Active'));
  for (const text of ['sourceBranch', 'targetBranch', 'reviewers', 'reviewerVotes', 'conflicts', 'providerData']) {
    assert.ok(!ansi.includes(text));
  }
  assert.ok(!ansi.includes('Author'));
  assert.ok(!ansi.includes('example-user'));
  const cl = testItem({ provider: 'chromium', kind: 'cl', state: 'MERGED', providerData: { changeId: 'Iexample' } });
  const change = formatResults(snapshot({ provider: 'chromium', resource: 'cls', items: [cl] }), 'ansi').output;
  assert.ok(change.includes('\ueafc'));
  assert.ok(change.includes('\x1b[38;2;166;227;161;22mMerged'));
});

test('ANSI keeps Nerd Font dashboard, warning and review accents without a separate query preamble', () => {
  const document = { results: [
    snapshot(),
    snapshot({ fromCache: false }),
    snapshot({ stale: true }),
    snapshot({ truncated: true }),
    { items: [testItem()], truncated: false },
    failure,
  ] };
  const ansi = formatResults(document, 'ansi').output;
  for (const glyph of ['\ueacd', '\uea6c']) {
    assert.ok(ansi.includes(glyph), glyph.codePointAt(0).toString(16));
  }
  for (const glyph of ['\ueaf7', '\ueace', '\ueb37', '\ueab2']) assert.ok(!ansi.includes(glyph));
  for (const format of ['markdown', 'text']) {
    const output = formatResults(document, format).output;
    assert.doesNotMatch(output, /[\ue000-\uf8ff]/);
    assert.ok(bugEmoji.every(emoji => !output.includes(emoji)));
  }
  for (const [kind, glyph] of [['pr', '\uea64'], ['cl', '\ueafc']]) {
    const items = [testItem({ id: '1', provider: 'chromium', kind: 'cl' })];
    if (kind === 'pr') items[0] = testItem({ kind });
    const document = { items, truncated: false };
    const lines = tableLines(formatResults(document, 'ansi').output);
    assert.ok(lines[1].includes(glyph));
    assert.ok(lines.every(line => cellCount(line) === cellCount(lines[0])));
  }
});

test('ANSI tables use header-colored half-block sides and bottom with continuous striped row bands', () => {
  const items = [
    testItem({ priority: 'P1', severity: 'S2' }),
    testItem({ id: '2', title: 'Another bug', priority: 'P2' }),
  ];
  const { output } = formatResults(snapshot({ items }), 'ansi');
  assert.ok(output.includes('\x1b[0;38;2;46;64;82m\u2590\x1b[0;48;2;46;64;82;38;2;190;230;249;1m '));
  assert.ok(!stripAnsi(output).includes('Title'));
  assert.ok(output.includes('\x1b[38;2;243;165;207;1mP1'));
  assert.ok(output.includes('\x1b[38;2;243;165;207;1mS2'));
  const raw = rawTableLines(output);
  const table = raw.map(stripAnsi);
  assert.equal(table.length, 4);
  assert.match(raw[1], /^\x1b\[0;38;2;46;64;82m\u2590\x1b\[0;48;2;31;41;51;/);
  assert.match(raw[2], /^\x1b\[0;38;2;46;64;82m\u2590\x1b\[0;48;2;39;51;63;/);
  for (const line of raw.slice(0, -1)) {
    assert.ok(line.endsWith(' \x1b[0;38;2;46;64;82m\u258c\x1b[0m'));
    assert.equal((line.match(/\x1b\[0m/g) ?? []).length, 1, 'Cell styles must not reset the row background');
    assert.equal((line.match(/48;2;/g) ?? []).length, 1, 'A physical row must have one continuous background');
  }
  assert.ok(table.slice(0, -1).every(line => /^\u2590 .* \u258c$/.test(line)));
  assert.match(table.at(-1), /^\u259d\u2580+\u2598$/);
  assert.match(raw.at(-1), /^\x1b\[0;38;2;46;64;82m\u259d\u2580+\u2598\x1b\[0m$/);
  assert.doesNotMatch(output, /[\ue0b4\ue0b6\u{1fbec}-\u{1fbef}]/u);
  for (const line of table) assert.doesNotMatch(line.slice(1, -1), /[|+\u2500-\u257f]/);
  const cellWidth = value => cellCount(bugEmoji.reduce((text, emoji) => text.replaceAll(emoji, 'xx'), value));
  assert.ok(table.every(line => cellWidth(line) === cellWidth(table[0])));
  for (const format of ['text', 'markdown']) {
    assert.doesNotMatch(formatResults(snapshot({ items }), format).output, /\x1b/);
  }
});

test('ANSI padding and wrapped content fit the terminal width without dropping IDs', () => {
  const item = testItem({
    title: 'A longer title that wraps while keeping every column aligned',
    state: 'IN_PROGRESS', priority: 'P1', updatedAt: '2026-03-04T05:06:07.000Z',
  });
  for (const columns of [24, 25, 26, 40, 80, 100, 120]) {
    const output = formatResults(snapshot({ items: [item] }), 'ansi', { columns }).output;
    const table = tableLines(output);
    const widths = table.map(line => cellCount(line.replaceAll(bugEmoji[1], 'xx')));
    assert.ok(widths.every(width => width <= columns), `Width ${columns}: ${widths}`);
    assert.ok(widths.every(width => width === widths[0]));
    assert.match(table.at(-1), /^\u259d\u2580+\u2598$/);
    assert.ok(table.slice(0, -1).every(line => /^\u2590 .* \u258c$/.test(line)));
    const visibleId = bodyLines(output).map(line => tableCells(line)[0]).join('');
    assert.ok(visibleId.includes('#1'));
  }
});

test('ANSI stripes alternate per item, not per wrapped line, and restart independently in each query', () => {
  const items = [
    testItem({ title: 'A long title that wraps onto several lines but remains one visual row band' }),
    testItem({ id: '2', title: 'Short title' }),
    testItem({ id: '3', title: 'Another long title that wraps without splitting the stripe into different backgrounds' }),
  ];
  const grouped = { queries: { first: snapshot({ items }), second: snapshot({ items: [testItem()] }) } };
  const { output } = formatResults(grouped, 'ansi', { columns: 40 });
  const first = output.split('\n\n').find(block => block.includes('48;2;46;64;82'));
  const rows = bodyLines(first);
  const groups = [];
  for (const row of rows) {
    if (tableCells(row)[0]) groups.push([]);
    groups.at(-1).push(row);
  }
  assert.equal(groups.length, 3);
  assert.ok(groups[0].length > 1);
  assert.ok(groups[2].length > 1);
  groups.forEach((lines, index) => {
    const expected = index % 2 ? '39;51;63' : '31;41;51';
    for (const line of lines) assert.ok(line.includes(`\x1b[0;48;2;${expected};`));
  });
  const second = output.split('\n\n').filter(block => block.includes('48;2;46;64;82'))[1];
  assert.ok(bodyLines(second)[0].includes('\x1b[0;48;2;31;41;51;'));
});

test('ANSI table foreground colors have readable contrast against both stripe backgrounds', () => {
  const items = [
    testItem({ assignees: ['Alice'], priority: 'P1', severity: 'S2', updatedAt: '2026-03-04T05:06:07.000Z' }),
    testItem({ id: '2', assignees: ['Bob'], state: 'closed' }),
    testItem({ id: '3', state: 'active', draft: true }),
  ];
  const luminance = rgb => rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const rows = rawTableLines(formatResults(snapshot({ items }), 'ansi', { columns: 160 }).output);
  for (const row of rows.slice(0, -1)) {
    const background = row.match(/48;2;(\d+);(\d+);(\d+)/).slice(1).map(Number);
    const foregrounds = [...bandLine(row).matchAll(/38;2;(\d+);(\d+);(\d+)/g)].map(match => match.slice(1).map(Number));
    for (const foreground of foregrounds) {
      const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
      assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, 'Text contrast must be at least 4.5:1');
    }
  }
});

test('ANSI table titles link to the query and show relative fetch age only strictly after two minutes', () => {
  const now = new Date('2026-11-03T17:00:00Z');
  const queryUrl = 'https://dev.azure.com/example/Project/_queries/query/01234567-89ab-cdef-0123-456789abcdef';
  for (const [elapsed, expected] of [
    [-1000, ''], [0, ''], [119999, ''], [120000, ''], [120001, '(2 minutes ago)'],
    [180000, '(3 minutes ago)'], [3600000, '(1 hour ago)'], [7200000, '(2 hours ago)'],
    [86400000, '(1 day ago)'], [259200000, '(3 days ago)'],
  ]) {
    const document = snapshot({ queryUrl, fetchedAt: new Date(now.getTime() - elapsed).toISOString() });
    const output = formatResults(document, 'ansi', { now }).output;
    const title = rawTableLines(output)[0];
    assert.ok(title.includes(`\x1b]8;;${queryUrl}\x1b\\work / bugs - 1 bug`));
    assert.ok(stripAnsi(title).includes(expected));
    assert.equal(output.includes(' ago)'), Boolean(expected));
    for (const removed of ['Title', 'Status', 'cached', 'just refreshed', '\ueaf7']) assert.ok(!output.includes(removed));
  }
  const missing = snapshot({ queryUrl });
  delete missing.fetchedAt;
  assert.ok(!formatResults(missing, 'ansi', { now }).output.includes(' ago)'));
  for (const queryUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/\x1b[31m']) {
    assert.throws(() => formatResults(snapshot({ queryUrl }), 'ansi'), /Invalid/);
  }
});

test('ANSI half-block panels retain counts, warnings, empty results and errors at narrow widths', () => {
  const now = new Date('2026-01-01T00:01:00Z');
  const document = { queries: {
    long: snapshot({ profile: 'Long \u4fee\u590d e\u0301 profile', query: 'A long query name', stale: true, truncated: true }),
    empty: snapshot({ items: [] }),
    failed: { profile: 'work', query: 'unavailable', error: { code: 'CLI_FAILED', message: 'Provider could not be reached.' } },
  } };
  const width = value => cellCount(value.replaceAll('\u4fee\u590d', 'xxxx').replaceAll('e\u0301', 'e').replaceAll(bugEmoji[1], 'xx'));
  for (const columns of [24, 40, 100]) {
    const { output, failed } = formatResults(document, 'ansi', { columns, now });
    assert.equal(failed, 1);
    const panels = output.split('\n\n').filter(block => stripAnsi(block).startsWith('\u2590'));
    assert.equal(panels.length, 3);
    for (const panel of panels) {
      const lines = panel.trimEnd().split('\n').map(stripAnsi);
      assert.match(lines.at(-1), /^\u259d\u2580+\u2598$/);
      assert.equal(lines.filter(line => line.includes('\u259d')).length, 1);
      assert.ok(lines.slice(0, -1).every(line => /^\u2590 .* \u258c$/.test(line)));
      for (const raw of panel.trimEnd().split('\n')) {
        assert.ok(raw.startsWith('\x1b[0;38;2;46;64;82m'));
      }
      assert.ok(lines.every(line => width(line) === width(lines[0]) && width(line) <= columns));
    }
    const labels = output.split('\n').map(line => [...stripAnsi(line)].slice(2, -2).join('').trim()).join(' ');
    for (const expected of ['TRUNCATED', '0 bugs', 'No items found.', 'Error:', 'CLI_FAILED']) {
      assert.ok(labels.includes(expected), `${columns}: ${expected}`);
    }
  }
});

test('legacy snapshots use the closest provider list link without reading configuration or inventing a saved query', () => {
  const cases = [
    ['github', 'bug', 'https://github.com/example/repo/issues/1', 'https://github.com/example/repo/issues'],
    ['github', 'pr', 'https://github.example.com/example/repo/pull/1', 'https://github.example.com/example/repo/pulls'],
    ['ado', 'bug', 'https://dev.azure.com/example/Project/_workitems/edit/1', 'https://dev.azure.com/example/Project/_queries'],
    ['ado', 'pr', 'https://dev.azure.com/example/Project/_git/Repo/pullrequest/1', 'https://dev.azure.com/example/Project/_git/Repo/pullrequests'],
    ['chromium', 'bug', 'https://issues.chromium.org/issues/1', 'https://issues.chromium.org/issues'],
    ['chromium', 'cl', 'https://chromium-review.googlesource.com/c/chromium/src/+/1', 'https://chromium-review.googlesource.com/q/status:open'],
  ];
  for (const [provider, kind, url, expected] of cases) {
    const item = testItem({ provider, kind, url });
    const output = formatResults({ items: [item], truncated: false }, 'ansi').output;
    assert.ok(rawTableLines(output)[0].includes(`\x1b]8;;${expected}\x1b\\`));
  }
  const output = formatResults(snapshot({ items: [] }), 'ansi').output;
  assert.ok(!output.includes('\x1b]8;;'));
});

test('bug emoji are selected by exact ID modulo list size, stable across ordering and beyond safe integer precision', () => {
  const ids = ['1', '2', '3', '4', '5', '6', '7', '9007199254740993', '12345678901234567'];
  const items = ids.map(id => testItem({ id, url: `https://example.com/items/${id}` }));
  const before = structuredClone(items);
  for (const rows of [items, [...items].reverse()]) {
    const output = stripAnsi(formatResults(snapshot({ items: rows }), 'ansi').output);
    for (const id of ids) {
      const expected = bugEmoji[Number(BigInt(id) % BigInt(bugEmoji.length))];
      assert.ok(output.includes(`${expected} #${id}`), id);
    }
  }
  assert.deepEqual(items, before);
  assert.notEqual(Number(ids[7]) % bugEmoji.length, Number(BigInt(ids[7]) % BigInt(bugEmoji.length)));
});

test('generated bug icons avoid the newer emoji block miscounted by older browser-terminal width tables', () => {
  const items = Array.from({ length: 6 }, (_, index) => testItem({ id: String(index + 1) }));
  const output = stripAnsi(formatResults(snapshot({ items }), 'ansi').output);
  assert.ok(output.includes('\u{1f41d} #3'));
  assert.doesNotMatch(output, /[\u{1fa00}-\u{1faff}]/u);
  for (const emoji of bugEmoji) assert.ok(output.includes(emoji));
});

test('input cannot inject terminal controls, new lines or bidi overrides through fields or errors', () => {
  const injected = 'start\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\nend\u202e';
  const item = testItem({ title: injected, author: injected, providerData: { nodeId: injected } });
  for (const format of ['text', 'markdown']) {
    const rendered = formatResults(snapshot({ items: [item], profile: injected }), format).output;
    assert.doesNotMatch(rendered, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
    assert.ok(!rendered.includes('\nend'));
    const error = formatResults({ error: { code: injected, message: injected } }, format).output;
    assert.doesNotMatch(error, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
  }
  const ansi = formatResults(snapshot({ items: [item] }), 'ansi').output;
  assert.ok(!ansi.includes('\x1b]8;;https://evil.example'));
});

test('invalid input shapes, metadata and unsafe links fail instead of appearing empty or successful', () => {
  const values = [null, [], 1, {}, { schemaVersion: 2, items: [], truncated: false },
    { results: {} }, { queries: [] }, { items: [] }, { error: {} }, { error: { code: 'X', message: 1 } },
    { items: [], truncated: false, queries: {} }, snapshot({ items: [testItem({ providerData: { raw: {} } })] }),
    snapshot({ items: [testItem({ title: '' })] }), snapshot({ stale: 'false' }), snapshot({ fetchedAt: 'invalid' }),
    snapshot({ provider: 'other', items: [] }), snapshot({ resource: 'cls', items: [] }),
    { results: [{ results: [] }] }, { queries: { nested: { queries: { nested: { queries: {} } } } } },
  ];
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com',
    'https://example.com/\x1b[31m', 'https://example.com/a b', 'https://example.com\\x']) {
    values.push(snapshot({ items: [testItem({ url })] }));
  }
  for (const value of values) {
    for (const format of formats) assert.throws(() => formatResults(value, format), /Invalid DevDash/);
  }
  assert.throws(() => formatResults(snapshot(), 'html'), /Unknown presentation/);
});

test('integrated format command reads pretty JSON with a BOM and preserves explicit provider failure exit status', async () => {
  await Promise.all(formats.map(async format => {
    const input = '\uFEFF' + JSON.stringify(snapshot(), null, 2);
    const success = await convert(format, input);
    assert.equal(success.code, 0, success.stderr);
    assert.equal(success.stderr, '');
    assert.equal(success.stdout, formatResults(snapshot(), format).output);
    const partial = { schemaVersion: 1, results: [snapshot(), failure], failed: 1 };
    const result = await convert(format, JSON.stringify(partial));
    assert.equal(result.code, 2);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes('Synthetic cache regression'));
    assert.ok(result.stdout.includes('Error: Authentication failed'));
    for (const bad of ['', '{"PRIVATE_INPUT":', '{}', JSON.stringify(snapshot()) + JSON.stringify(snapshot())]) {
      const rejected = await convert(format, bad);
      assert.equal(rejected.code, 1);
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /Could not render/);
      assert.ok(!rejected.stderr.includes('PRIVATE_INPUT'));
    }
    const help = await convert(format, '', ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /stdin/);
    const unknown = await convert(format, '', ['--unknown']);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, '');
  }));
});

test('UTF-8 characters split across stdin chunks survive decoding', async () => {
  const item = testItem({ title: 'Fix caf\u00e9 \u{1f41b}' });
  const input = Buffer.from(JSON.stringify(snapshot({ items: [item] })));
  const split = input.indexOf(Buffer.from('\u{1f41b}')) + 1;
  const result = await convert('text', '', [], [input.subarray(0, split), input.subarray(split)]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('caf\u00e9 \u{1f41b}'));
  assert.ok(!result.stdout.includes('\ufffd'));
});

test('published package contains the integrated CLI and formatter, not obsolete converter scripts', async () => {
  const execute = promisify(execFile);
  const npm = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const { stdout } = await execute(npm, args, { windowsHide: true, shell: false });
  const files = JSON.parse(stdout)[0].files.map(file => file.path);
  for (const name of ['src/format.js', 'src/presentation.js', 'presentation.schema.json', 'bin/devdash.js']) {
    assert.ok(files.includes(name), name);
  }
  for (const format of formats) assert.ok(!files.includes(`scripts/json-to-${format}.js`));
  assert.ok(!files.includes('devdash.e2e.local.json'));
});
