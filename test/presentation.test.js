import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ansiBorder, loadPresentation, resolvePresentation, defaultPresentation, presentationThemes } from '../src/presentation.js';
import { displayWidth } from '../src/terminal-width.js';
import { buildTableModels, formatDocument, formatResults } from '../src/format.js';
import { validateConfig, paths } from '../src/config.js';
import { providerProfile } from '../src/query.js';
import { testItem } from './helpers/test-provider.js';

const query = { provider: 'github', resource: 'bugs', repository: 'example/repo' };
const snapshot = (overrides = {}) => ({ profile: 'work', query: 'bugs', items: [testItem()], truncated: false, ...overrides });
const userDocument = presentation => ({ version: 1, presentation });
const header = color => ({ ansi: { table: { header: { background: color } } } });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'devdash-presentation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return paths({ home });
}

test('presentation merges objects deeply, replaces row arrays and never mutates its inputs or defaults', () => {
  const layers = [
    { ansi: { palette: { custom: '#123456' }, table: { header: { foreground: 'p:custom' } } } },
    { ansi: { table: { header: { bold: false }, rows: [{ background: '#112233' }] } }, ascii: { links: false } },
  ];
  const before = structuredClone(layers);
  const defaults = structuredClone(defaultPresentation);
  const styles = resolvePresentation(...layers);
  assert.equal(styles.ansi.table.header.foreground, 'p:custom');
  assert.equal(styles.ansi.table.header.background, 'p:accent');
  assert.equal(styles.ansi.table.header.bold, false);
  assert.equal(styles.ansi.table.rows.length, 1);
  assert.deepEqual(styles.ansi.table.rows[0], { background: '#112233', foreground: 'p:text', bold: false });
  assert.equal(styles.ansi.table.columns.priority.foreground, 'p:priority');
  assert.equal(styles.ascii.links, false);
  assert.equal(styles.md.links, true);
  assert.deepEqual(layers, before);
  styles.ansi.palette.accent = '#000000';
  assert.deepEqual(defaultPresentation, defaults);
});

test('user, file, group and query styles cascade independently, including flat profiles and palette inheritance', async t => {
  const resolvedPaths = await fixture(t);
  await writeFile(resolvedPaths.userConfig, JSON.stringify(userDocument({
    theme: 'half-block',
    ansi: { palette: { userAccent: '#aabbcc' }, table: { header: { foreground: 'p:userAccent', background: '#111111' } } },
    md: { headingLevel: 3 },
  })));
  const config = {
    version: 1, presentation: { ...header('#222222'), ascii: { links: false } },
    profiles: {
      work: {
        refreshSeconds: 300, presentation: header('#333333'),
        queries: {
          bugs: { ...query, presentation: { ...header('#444444'), md: { headingLevel: 4 } } },
          inherited: query,
        },
      },
      flat: { ...query, refreshSeconds: 300, presentation: header('#555555') },
      sibling: { ...query, refreshSeconds: 300 },
    },
  };
  validateConfig(config);
  const before = structuredClone(config);
  const { presentation, presentationFor } = await loadPresentation(resolvedPaths, config);
  const cases = [
    [{ profile: 'work', query: 'bugs' }, '#444444', 4],
    [{ profile: 'work', query: 'inherited' }, '#333333', 3],
    [{ profile: 'work', query: 'unknown' }, '#333333', 3],
    [{ profile: 'flat' }, '#555555', 3],
    [{ profile: 'sibling' }, '#222222', 3],
    [{ profile: 'unknown' }, '#222222', 3],
  ];
  assert.equal(presentation.ansi.table.header.background, '#222222');
  for (const [section, background, level] of cases) {
    const styles = presentationFor(section);
    assert.equal(styles.ansi.table.header.background, background);
    assert.equal(styles.ansi.table.header.foreground, 'p:userAccent');
    assert.equal(styles.ansi.palette.userAccent, '#aabbcc');
    assert.equal(styles.ascii.links, false);
    assert.equal(styles.md.headingLevel, level);
    const output = formatResults(snapshot(section), 'ansi', { presentationFor }).output;
    const rgb = background.slice(1).match(/../g).map(value => Number.parseInt(value, 16)).join(';');
    const lines = output.trimEnd().split('\n').filter(line => /[\u2590\u259d]/.test(line));
    assert.ok(lines.length >= 3);
    assert.ok(lines.every(line => line.startsWith(`\x1b[0;38;2;${rgb}m`)));
    assert.match(lines.at(-1), /\u259d\u2580+\u2598\x1b\[0m$/);
  }
  assert.deepEqual(config, before);
});

test('absent optional user files inherit built-ins while explicit missing and malformed files fail', async t => {
  const resolvedPaths = await fixture(t);
  assert.deepEqual((await loadPresentation(resolvedPaths)).presentation, resolvePresentation());
  await assert.rejects(loadPresentation(resolvedPaths, undefined, { required: true }), { code: 'INVALID_PRESENTATION' });
  for (const value of ['not JSON SECRET_INPUT', '{}', '{"version":2,"presentation":{}}']) {
    await writeFile(resolvedPaths.userConfig, value);
    await assert.rejects(loadPresentation(resolvedPaths), error =>
      ['INVALID_JSON', 'INVALID_PRESENTATION'].includes(error.code) && !error.message.includes('SECRET_INPUT'));
  }
});

test('invalid styles, unsafe controls, missing colors and unknown properties fail explicitly without echoing values', () => {
  for (const layer of [
    null, [], { markdown: {} }, { ansi: { palette: { custom: 'red' } } },
    { ansi: { palette: { custom: '\x1b[31mSECRET' } } },
    { ansi: { table: { header: { foreground: 'p:missingSECRET' } } } },
    { ansi: { table: { columns: { unknown: {} } } } },
    { ansi: { table: { cornerStyle: 'triangle' } } },
    { ansi: { table: { rows: [] } } }, { ansi: { table: { rows: Array(9).fill({}) } } },
    { ansi: { table: { rows: [{ background: 'p:missingSECRET' }] } } },
    { ansi: { table: { columns: { title: { bold: 'yes' } } } } },
    { ascii: { table: { separator: '\n' } } }, { ascii: { table: { separator: '界' } } },
    { ascii: { table: { separator: ' / ', junction: '+' } } },
    { md: { headingLevel: 1 } }, { md: { table: { align: { title: 'justify' } } } },
  ]) {
    assert.throws(() => resolvePresentation(layer), error => error.code === 'INVALID_PRESENTATION' && !error.message.includes('SECRET'));
  }
  const dangerous = JSON.parse('{"ansi":{"palette":{"__proto__":"#123456"}}}');
  assert.throws(() => resolvePresentation(dangerous), { code: 'INVALID_PRESENTATION' });
  assert.equal(Object.prototype.polluted, undefined);
  const constructor = resolvePresentation({ ansi: { palette: { constructor: '#123456' }, table: { header: { foreground: 'p:constructor' } } } });
  assert.equal(constructor.ansi.palette.constructor, '#123456');
});

test('one format-neutral model supplies all renderers with identical row data, dynamic columns and warnings', () => {
  const document = snapshot({
    stale: true, truncated: true,
    items: [
      testItem({ title: 'Shared synthetic title', assignees: ['Alice'], priority: 'P1', updatedAt: '2026-03-04T05:06:07.000Z' }),
      testItem({ id: '2', title: 'Shared second title', assignees: ['Bob'], state: 'closed', priority: 'P2' }),
    ],
  });
  const before = structuredClone(document);
  const options = { now: new Date('2026-11-03T17:00:00Z') };
  const models = buildTableModels(document, options);
  assert.deepEqual(models[0].columns.map(column => column.key), ['item', 'title', 'status', 'person', 'priority', 'updated']);
  assert.deepEqual(models[0].rows.map(row => [row.item, row.title, row.status, row.updated]), [
    ['#1', 'Shared synthetic title', 'Open', '03-04'], ['#2', 'Shared second title', 'Closed', '-'],
  ]);
  assert.equal(models[0].notices.length, 1);
  assert.ok(!JSON.stringify(models).includes('\\u001b'));
  for (const format of ['ansi', 'text', 'markdown']) {
    const { output, failed } = formatResults(document, format, options);
    assert.equal(failed, 0);
    for (const expected of ['Shared synthetic title', 'Shared second title', 'Alice', 'Bob', 'Open', 'Closed', 'P1', 'P2', 'TRUNCATED']) {
      assert.ok(output.includes(expected), `${format}: ${expected}`);
    }
    assert.deepEqual(buildTableModels(document, options), models);
  }
  assert.deepEqual(document, before);
});

test('ANSI named styles apply to header, row stripes, states and columns without leaking column backgrounds into gaps', () => {
  const presentation = {
    theme: 'half-block',
    ansi: {
      icons: false,
      palette: { customHeader: '#112233', first: '#223344', second: '#334455', cell: '#445566', ink: '#ddeeff' },
      table: {
        status: { pills: false },
        header: { background: 'p:customHeader', foreground: 'p:ink', bold: false },
        rows: [{ background: 'p:first' }, { background: 'p:second' }],
        columns: { title: { background: 'p:cell', foreground: 'p:ink', bold: true } },
        states: { closed: { foreground: '#aabbcc', bold: true } },
      },
    },
  };
  const document = snapshot({ items: [testItem({ title: 'First title' }), testItem({ id: '2', title: 'Second title', state: 'closed' })] });
  const { output } = formatResults(document, 'ansi', { presentation });
  assert.ok(output.includes('\x1b[0;38;2;17;34;51m\u2590\x1b[0;48;2;17;34;51;38;2;221;238;255;22m'));
  assert.ok(output.includes('\x1b[48;2;68;85;102;38;2;221;238;255;1mFirst title'));
  assert.ok(output.includes('\x1b[38;2;170;187;204;1mClosed'));
  for (const [title, rowColor] of [['First title', '34;51;68'], ['Second title', '51;68;85']]) {
    const line = output.split('\n').find(line => line.includes(title));
    assert.ok(line.includes(`\x1b[48;2;${rowColor}m  \x1b[`), 'The inter-column gap restores the logical row background');
    assert.ok(line.startsWith('\x1b[0;38;2;17;34;51m\u2590'));
    assert.ok(line.endsWith('\x1b[0;38;2;17;34;51m\u258c\x1b[0m'),
      'Both side borders use the header, not row or column, background');
  }
  assert.match(output.trimEnd().split('\n').at(-1), /^\x1b\[0;38;2;17;34;51m\u259d\u2580+\u2598\x1b\[0m$/);
  for (const format of ['text', 'markdown']) {
    assert.equal(formatResults(document, format, { presentation }).output, formatResults(document, format).output);
  }
});

test('semicircle corner styling retains Powerline caps as an explicit font-compatibility fallback', () => {
  const document = snapshot({ stale: true, items: [
    testItem({ title: 'A title that wraps over several narrow lines' }), testItem({ id: '2' }),
  ] });
  const presentation = { theme: 'half-block', ansi: { table: { cornerStyle: 'semicircle' } } };
  assert.equal(resolvePresentation().ansi.table.cornerStyle, 'rounded');
  assert.equal(resolvePresentation(presentation).ansi.table.cornerStyle, 'semicircle');
  const output = formatResults(document, 'ansi', { presentation, columns: 24 }).output;
  const lines = output.trimEnd().split('\n').filter(line => line.includes('48;2;'));
  for (const line of lines) {
    const color = line.match(/48;2;(\d+;\d+;\d+)/)[1];
    assert.ok(line.startsWith(`\x1b[0;38;2;${color}m\ue0b6`));
    assert.ok(line.endsWith(`\x1b[0;38;2;${color}m\ue0b4\x1b[0m`));
  }
  assert.doesNotMatch(output, /[\u{1fbec}-\u{1fbef}]/u);
  assert.doesNotMatch(output, /[\u2580\u258c\u2590\u2598\u259d]/);
});

test('quarter styling retains one top and bottom pair with straight sides on wrapped panels', () => {
  const presentation = { theme: 'half-block', ansi: { table: { cornerStyle: 'quarter' } } };
  for (const document of [
    snapshot({ stale: true, profile: 'A very long profile name that wraps', items: [
      testItem({ title: 'A very long item title that wraps across lines' }),
    ] }),
    snapshot({ items: [] }),
    { profile: 'unavailable', error: { code: 'CLI_FAILED', message: 'A long synthetic error message that wraps.' } },
  ]) {
    const output = formatResults(document, 'ansi', { presentation, columns: 24 }).output;
    const lines = output.trimEnd().split('\n').filter(line => line.includes('48;2;'));
    const plain = lines.map(line => line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[\d;]*m/g, ''));
    assert.match(plain[0], /^\u{1fbee} .* \u{1fbed}$/u);
    assert.match(plain.at(-1), /^\u{1fbec} .* \u{1fbef}$/u);
    assert.ok(plain.slice(1, -1).every(line => /^  .*  $/.test(line)));
    assert.doesNotMatch(output, /[\u2580\u258c\u2590\u2598\u259d]/);
  }
});

test('format-specific styling changes presentation without changing row data, safety or warnings', () => {
  const presentation = {
    ansi: { icons: false, links: false, table: { caps: false, status: { pills: false } } },
    ascii: { links: false, table: { separator: ' / ', junction: '-/-' } },
    md: { links: false, headingLevel: 4, table: { align: { title: 'left', status: 'center', item: 'right' } } },
  };
  const document = snapshot({ stale: true, truncated: true, items: [testItem({ title: 'Shared table data' })] });
  const ansi = formatResults(document, 'ansi', { presentation, columns: 24 }).output;
  assert.doesNotMatch(ansi, /[\u2580\u258c\u2590\u2598\u259d\ue000-\uf8ff\u{1fbec}-\u{1fbef}]|\x1b\]8;;/u);
  assert.ok(ansi.includes('TRUNCATED'));
  for (const line of ansi.split('\n').filter(line => line.startsWith('\x1b[0;48;2;'))) {
    assert.ok(line.replace(/\x1b\[[\d;]*m/g, '').length <= 24);
  }
  const ascii = formatResults(document, 'text', { presentation }).output;
  assert.ok(ascii.includes('Item / Title'));
  assert.ok(!ascii.includes('Links:'));
  const md = formatResults(document, 'markdown', { presentation }).output;
  assert.ok(md.includes('#### work / bugs'));
  assert.ok(md.includes('| ---: | :--- | :---: |'));
  assert.ok(!md.includes('](https:'));
  assert.doesNotMatch(ascii + md, /\x1b/);
});

const stripTerminal = value => value.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[\d;]*m/g, '');

function terminalCells(output) {
  const cells = [];
  let background = null, foreground = null;
  for (const token of output.split(/(\x1b\]8;;[^\x1b]*\x1b\\|\x1b\[[\d;]*m)/)) {
    if (token.startsWith('\x1b]')) continue;
    if (!token.startsWith('\x1b[')) {
      for (const glyph of token) cells.push({ glyph, background, foreground });
      continue;
    }
    const codes = token.slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0) { background = null; foreground = null; }
      if (codes[i] === 49) background = null;
      if ([38, 48].includes(codes[i]) && codes[i + 1] === 2) {
        const color = codes.slice(i + 2, i + 5).join(';');
        if (codes[i] === 48) background = color;
        else foreground = color;
        i += 4;
      }
    }
  }
  return cells;
}

test('all six built-in themes keep every border cell on the terminal default background', () => {
  const documents = [
    snapshot({ truncated: true, profile: 'Long synthetic project title that wraps', items: [
      testItem({ title: 'Wrapped synthetic content with CJK \u754c and combining e\u0301' }),
      testItem({ id: '2', state: 'closed', title: 'Another synthetic row' }),
    ] }),
    snapshot({ items: [] }),
    { profile: 'unavailable', error: { code: 'CLI_FAILED', message: 'A synthetic provider error that wraps.' } },
  ];
  const borders = /[\u2500\u2502\u256d\u256e\u256f\u2570\u2580\u258c\u2590\u2598\u259d\ue0b0\ue0b2\ue0b4\ue0b6]/u;
  for (const theme of Object.keys(presentationThemes)) for (const columns of [24, 40, 100]) {
    for (const document of documents) {
      const before = structuredClone(document);
      const output = formatResults(document, 'ansi', { presentation: { theme }, columns }).output;
      const lines = stripTerminal(output).trimEnd().split('\n').slice(2);
      assert.ok(lines.length >= 2);
      assert.ok(lines.every(line => displayWidth(line) === displayWidth(lines[0]) && displayWidth(line) <= columns),
        `${theme} must keep wrapped rows, titles, notices and rules aligned at ${columns} cells`);
      const borderCells = terminalCells(output).filter(cell => borders.test(cell.glyph));
      assert.ok(borderCells.length >= 3);
      assert.ok(borderCells.every(cell => cell.background === null), `${theme}: no border inherits a row/title background`);
      assert.deepEqual(document, before);
      for (const format of ['text', 'markdown']) {
        assert.equal(formatResults(document, format, { presentation: { theme } }).output,
          formatResults(document, format).output);
      }
    }
  }
});

test('themes have distinct status treatments while semicircle-tab retains rounded text pills', () => {
  const document = snapshot({ items: [testItem(), testItem({ id: '2', state: 'closed' }), testItem({ id: '3', draft: true })] });
  const defaultOutput = formatResults(document, 'ansi').output;
  assert.equal(defaultOutput, formatResults(document, 'ansi', { presentation: { theme: 'semicircle-tab' } }).output);
  assert.ok(stripTerminal(defaultOutput).split('\n')[2].startsWith('\u256d\u2500\ue0b6'));
  for (const [theme, pills, labels] of [
    ['half-block', false, ['Open', 'Closed', 'Draft / Open']],
    ['chevron', false, ['Open', 'Closed', 'Draft / Open']],
    ['semicircle', true, ['\u{1f513} Open', '\u2705 Closed', '\u{1f4dd} Draft / Open']],
    ['rounded-pills', true, ['\u{1f513} Open', '\u2705 Closed', '\u{1f4dd} Draft / Open']],
    ['chevron-tab', false, ['\u{1f513}', '\u2705', '\u{1f4dd}']],
    ['semicircle-tab', true, ['Open', 'Closed', 'Draft / Open']],
  ]) {
    // Exercise both raw layers and already-resolved settings, as used by CLI previews.
    const presentation = resolvePresentation(resolvePresentation({ theme: 'semicircle' }), { theme });
    const output = formatResults(document, 'ansi', { presentation }).output;
    for (const label of labels) assert.ok(output.includes(label), `${theme}: ${label}`);
    for (const color of ['140;200;255', '166;227;161', '249;211;128']) {
      assert.equal(output.includes(`\x1b[0;48;2;${color};`), pills, theme);
    }
    if (theme === 'chevron-tab') assert.doesNotMatch(stripTerminal(output), /\b(?:Open|Closed|Draft)\b/u);
    if (pills) assert.match(output, /\ue0b6\x1b\[0;48;2;/u);
    else assert.match(output, /\x1b\[38;2;140;200;255;22m/u);
    for (const format of ['text', 'markdown']) assert.equal(formatResults(document, format, { presentation }).output,
      formatResults(document, format).output);
  }
});

test('case-insensitive state labels support emoji, draft precedence and wrapping without changing source or other formats', () => {
  const document = snapshot({ items: [
    testItem({ state: 'OPEN', title: 'One' }), testItem({ id: '2', state: 'closed', title: 'Two' }),
    testItem({ id: '3', state: 'merged', title: 'Three' }), testItem({ id: '4', state: 'IN_PROGRESS', title: 'Four' }),
    testItem({ id: '5', state: 'waiting', title: 'Five' }), testItem({ id: '6', draft: true, title: 'Six' }),
  ] });
  const before = structuredClone(document);
  const labels = { open: '\u{1f513}', CLOSED: '\u2705', merged: 'Merged!', in_progress: '\u{1f469}\u200d\u{1f4bb} Ready', draft: '\u{1f4dd}' };
  for (const pills of [true, false]) for (const columns of [24, 40, 100]) {
    const presentation = { ansi: { table: { status: { labels, pills } } } };
    const output = formatResults(document, 'ansi', { presentation, columns }).output;
    for (const label of ['\u{1f513}', '\u2705', '\u{1f469}\u200d\u{1f4bb}', '\u{1f4dd}']) assert.ok(output.includes(label));
    assert.doesNotMatch(stripTerminal(output), /\b(?:Open|Closed|Draft)\b/u);
    const lines = stripTerminal(output.trimEnd()).split('\n').slice(2);
    assert.ok(lines.every(line => displayWidth(line) === displayWidth(lines[0]) && displayWidth(line) <= columns));
    if (columns === 100) for (const label of ['Merged!', 'Waiting', 'Ready']) assert.ok(output.includes(label));
    for (const format of ['text', 'markdown']) {
      assert.equal(formatResults(document, format, { presentation }).output, formatResults(document, format).output);
    }
  }
  const fallback = formatResults(snapshot({ items: [testItem({ draft: true })] }), 'ansi', {
    presentation: { ansi: { table: { status: { labels: { open: '\u{1f513}' } } } } },
  }).output;
  assert.ok(fallback.includes('Draft / \u{1f513}'));
  const longLabel = 'Waiting for an exceptionally thorough review';
  const wrapped = formatResults(snapshot({ items: [testItem({ title: 'One' })] }), 'ansi', { columns: 24,
    presentation: { ansi: { table: { status: { labels: { open: longLabel } } } } },
  }).output;
  const pieces = [...wrapped.matchAll(/\x1b\[0;48;2;140;200;255;38;2;31;41;51;22m ([^\x1b]*)/gu)].map(match => match[1]);
  assert.equal(pieces.join('').replaceAll(' ', ''), longLabel.replaceAll(' ', ''));
  assert.deepEqual(document, before);
});

test('pill colors, caps, spacing and labels survive frame changes, with narrower label overrides', () => {
  const user = { ansi: { table: {
    status: { pills: true, background: '#123456', foreground: '#fedcba', left: '[', right: ']', padding: 0, labels: { OPEN: 'Pending' } },
    states: { closed: { foreground: '#abcdef' } },
  } } };
  const before = structuredClone(user);
  for (const theme of Object.keys(presentationThemes)) {
    const presentation = resolvePresentation(resolvePresentation(user), { theme, ansi: { table: { status: { labels: { open: 'Ready' } } } } });
    const output = formatResults(snapshot(), 'ansi', { presentation }).output;
    assert.ok(output.includes('[\x1b[0;48;2;18;52;86;38;2;254;220;186;22mReady\x1b[0;38;2;18;52;86m]'));
    const caps = terminalCells(output).filter(cell => ['[', ']'].includes(cell.glyph));
    assert.equal(caps.length, 2);
    assert.ok(caps.every(cell => cell.background === null && cell.foreground === '18;52;86'));
    assert.equal(presentation.ansi.table.states.closed.foreground, '#abcdef');
    const disabled = resolvePresentation({ ansi: { table: { status: { pills: false } } } }, { theme });
    assert.equal(disabled.ansi.table.status.pills, false);
    const text = resolvePresentation({ ansi: { table: { status: { labelStyle: 'text' } } } }, { theme });
    assert.equal(text.ansi.table.status.labelStyle, 'text');
  }
  const square = formatResults(snapshot(), 'ansi', {
    presentation: { ansi: { table: { status: { left: '', right: '', padding: 0 } } } },
  }).output;
  assert.match(square, /\x1b\[0;48;2;140;200;255;38;2;31;41;51;22mOpen\x1b\[0;38;2;140;200;255m\x1b\[0;/u);
  assert.deepEqual(user, before);
});

test('emoji styles cover semantic provider states and exact custom labels override automatic decoration', () => {
  const document = snapshot({ items: [
    testItem({ state: 'NEW', title: 'One' }), testItem({ id: '2', state: 'completed', title: 'Two' }),
    testItem({ id: '3', state: 'MERGED', title: 'Three' }), testItem({ id: '4', state: 'active', draft: true, title: 'Four' }),
  ] });
  const output = formatResults(document, 'ansi', { presentation: { theme: 'chevron-tab' } }).output;
  for (const emoji of ['\u{1f513}', '\u2705', '\u{1f7e3}', '\u{1f4dd}']) assert.ok(output.includes(emoji));
  assert.doesNotMatch(stripTerminal(output), /\b(?:New|Completed|Merged|Draft|Active)\b/u);
  const custom = formatResults(document, 'ansi', { presentation: { theme: 'chevron-tab', ansi: { table: {
    status: { labels: { new: 'Pending', draft: 'WIP' } },
  } } } }).output;
  assert.ok(custom.includes('Pending') && custom.includes('WIP'));
  assert.ok(!custom.includes('\u{1f513}') && !custom.includes('\u{1f4dd}'));
  assert.throws(() => resolvePresentation({ ansi: { table: { status: { labelStyle: 'invalid' } } } }),
    { code: 'INVALID_PRESENTATION' });
});

test('unsafe and ambiguous labels or pill caps fail even when no border rules are drawn', () => {
  for (const status of [
    { background: 'p:missingSECRET' }, { left: '\u754c' }, { right: '\x1b[2J' }, { left: '\u200d' },
    { labels: { open: '' } }, { labels: { open: ' ' } }, { labels: { open: '\x1b[2JSECRET' } },
    { labels: { open: '\u202eSECRET' } }, { labels: { open: '\nSECRET' } }, { labels: { open: '\u0301' } },
    { labels: { open: '\ud800' } }, { labels: { open: 'x'.repeat(129) } },
    { labels: { Open: 'One', open: 'Two' } }, { labels: { ' open ': 'One' } }, { labels: { '': 'One' } },
  ]) {
    assert.throws(() => resolvePresentation({ ansi: { table: { status, border: { top: false, bottom: false } } } }),
      error => error.code === 'INVALID_PRESENTATION' && !error.message.includes('SECRET'));
  }
  assert.equal(resolvePresentation({ ansi: { table: { status: { labels: { background: 'p:literal' } } } } })
    .ansi.table.status.labels.background, 'p:literal');
});

test('full-width, content-width and numeric title tabs share panel widths while keeping their distinct geometry', () => {
  const document = snapshot({ items: [testItem({ title: 'A sufficiently long synthetic title for a wide result panel' })] });
  const rendered = presentation => stripTerminal(formatResults(document, 'ansi', {
    presentation: resolvePresentation(presentation, { ansi: { table: { status: { pills: true, labelStyle: 'text' } } } }),
  }).output)
    .trimEnd().split('\n').slice(2);
  const full = rendered({ theme: 'chevron' });
  assert.ok(full[0].startsWith('\ue0b2') && full[0].endsWith('\ue0b0'));
  assert.ok(full.slice(1, -1).every(line => line.startsWith('\u2502') && line.endsWith('\u2502')));
  assert.match(full.at(-1), /^\u2570\u2500+\u256f$/u);
  for (const [theme, left, right] of [
    ['chevron-tab', '\ue0b2', '\ue0b0'], ['semicircle-tab', '\ue0b6', '\ue0b4'],
  ]) {
    const compact = rendered({ theme });
    const fixed = rendered({ theme, ansi: { table: { title: { width: 20, inset: 3 } } } });
    assert.ok(compact[0].startsWith('\u256d\u2500' + left));
    assert.ok(compact[0].endsWith('\u2500\u256e'));
    assert.ok(compact[0].indexOf(right) < displayWidth(compact[0]) - 5);
    assert.equal(fixed[0].indexOf(right) - fixed[0].indexOf(left) + 1, 20);
    assert.ok(fixed[0].startsWith('\u256d\u2500\u2500\u2500' + left));
    assert.ok(fixed.every(line => displayWidth(line) === displayWidth(full[0])));
  }
  const pills = formatResults(document, 'ansi', { presentation: { theme: 'rounded-pills' } }).output;
  assert.match(pills, /\ue0b6\x1b\[0;48;2;140;200;255;38;2;31;41;51;22m \u{1f513} Open \x1b\[0;38;2;140;200;255m\ue0b4/u);
});

test('theme changes reset inherited table geometry but retain palettes and independent query selections', async t => {
  const resolvedPaths = await fixture(t);
  await writeFile(resolvedPaths.userConfig, JSON.stringify(userDocument({
    theme: 'chevron-tab', ansi: { palette: { accent: '#123456' } }, ascii: { links: false },
  })));
  const config = { version: 1, profiles: { work: {
    refreshSeconds: 300, queries: {
      bugs: { ...query, presentation: { theme: 'semicircle' } },
      half: { ...query, presentation: { theme: 'half-block' } },
      inherited: query,
    },
  } } };
  validateConfig(config);
  const options = await loadPresentation(resolvedPaths, config);
  for (const [name, theme, shape] of [
    ['bugs', 'semicircle', '\ue0b6'], ['half', 'half-block', '\u2590'], ['inherited', 'chevron-tab', '\u256d'],
  ]) {
    const settings = options.presentationFor({ profile: 'work', query: name });
    assert.equal(settings.theme, theme);
    assert.equal(settings.ansi.palette.accent, '#123456');
    assert.equal(settings.ascii.links, false);
    const output = formatResults(snapshot({ query: name }), 'ansi', options).output;
    assert.ok(stripTerminal(output).split('\n')[2].startsWith(shape), name);
  }
  assert.equal(ansiBorder(options.presentationFor({ profile: 'work', query: 'half' }).ansi).top, undefined);
});

test('border visibility, individual edge colors and explicit backgrounds remain separately configurable', () => {
  const document = snapshot({ items: [testItem(), testItem({ id: '2' })] });
  const presentation = { theme: 'chevron-tab', ansi: { table: { border: {
    left: '[', right: ']', foreground: '#123456', colors: { left: '#abcdef', right: '#fedcba', bottom: '#445566' },
  } } } };
  const output = formatResults(document, 'ansi', { presentation }).output;
  const cells = terminalCells(output);
  assert.ok(cells.filter(cell => cell.glyph === '[').every(cell => cell.foreground === '171;205;239' && cell.background === null));
  assert.ok(cells.filter(cell => cell.glyph === ']').every(cell => cell.foreground === '254;220;186' && cell.background === null));
  assert.match(output.trimEnd().split('\n').at(-1), /^\x1b\[0;38;2;68;85;102m/u);
  const disabled = formatResults(document, 'ansi', { presentation: {
    theme: 'chevron', ansi: { table: { border: { enabled: false } } },
  } }).output;
  assert.doesNotMatch(disabled, /[\u2500\u2502\u256d\u256e\u256f\u2570]/u);
  assert.ok(disabled.includes('\ue0b2'), 'The title band is independent of the body border');
  for (const line of stripTerminal(disabled.trimEnd()).split('\n').slice(2)) {
    assert.equal(displayWidth(line), displayWidth(stripTerminal(disabled).split('\n')[2]));
  }
  const filled = terminalCells(formatResults(document, 'ansi', { presentation: {
    theme: 'semicircle', ansi: { table: { border: { background: '#102030' } } },
  } }).output).filter(cell => cell.glyph === '\u2502');
  assert.ok(filled.length > 0 && filled.every(cell => cell.background === '16;32;48'));
});

test('background-free styles and configurable status caps retain narrow-width alignment and reject invalid theme settings', () => {
  const document = snapshot({ items: [testItem({ state: 'a long custom state', title: 'Synthetic wrapped item' })] });
  const presentation = { theme: 'rounded-pills', ansi: { table: {
    padding: 3, title: { width: 8, inset: 6 },
    header: { background: false }, rows: [{ background: false }],
    columns: { title: { background: '#102030' } },
    status: { left: '[', right: ']', foreground: '#ffffff', padding: 2 },
  } } };
  const output = formatResults(document, 'ansi', { presentation, columns: 24 }).output;
  const lines = stripTerminal(output).trimEnd().split('\n').slice(2);
  assert.ok(lines.every(line => displayWidth(line) === displayWidth(lines[0]) && displayWidth(line) <= 24));
  assert.ok(output.includes('\x1b[49m'), 'Column backgrounds restore the default row background');
  for (const width of ['content', 8, 20]) {
    const metadata = formatDocument({ x: 'v' }, 'ansi', { title: 'X', columns: 24,
      presentation: { theme: 'chevron-tab', ansi: { table: { title: { width, inset: 6 } } } } }).output;
    const metadataLines = stripTerminal(metadata).trimEnd().split('\n').slice(2);
    assert.ok(metadataLines.every(line => displayWidth(line) === displayWidth(metadataLines[0]) && displayWidth(line) <= 24));
  }
  for (const layer of [
    { theme: 'missing' }, { ansi: { table: { title: { width: 0 } } } },
    { ansi: { table: { title: { width: 'unknown', inset: 8 } } } },
    { ansi: { table: { status: { left: '\u754c' } } } },
    { ansi: { table: { border: { colors: { left: 'p:missing' } } } } },
    { ansi: { table: { border: { background: 'p:missing' } } } },
  ]) assert.throws(() => resolvePresentation(layer), { code: 'INVALID_PRESENTATION' });
});

test('geometry overrides apply after presets, deep-merge across scopes and do not materialize preset defaults', async t => {
  const resolvedPaths = await fixture(t);
  await writeFile(resolvedPaths.userConfig, JSON.stringify(userDocument({
    theme: 'half-block',
    ansi: { table: { border: { left: 'L', bottom: { left: '+', fill: '-', right: '+' } }, padding: 2 } },
  })));
  const config = { version: 1, profiles: { work: {
    refreshSeconds: 300,
    presentation: { ansi: { table: { cornerStyle: 'semicircle', gap: 1 } } },
    queries: { bugs: { ...query, presentation: { ansi: { table: { border: { right: 'R' } } } } } },
  } } };
  validateConfig(config);
  const { presentationFor } = await loadPresentation(resolvedPaths, config);
  const ansi = presentationFor({ profile: 'work', query: 'bugs' }).ansi;
  assert.equal(ansi.table.padding, 2);
  assert.equal(ansi.table.gap, 1);
  assert.equal(ansiBorder(ansi).left, 'L');
  assert.equal(ansiBorder(ansi).right, 'R');
  assert.deepEqual(ansiBorder(ansi).bottom, { left: '+', fill: '-', right: '+' });
  assert.throws(() => resolvePresentation({ theme: 'half-block', ansi: { table: { border: { top: { fill: '-' } } } } }), { code: 'INVALID_PRESENTATION' });
  assert.equal(Object.hasOwn(ansi.table.border, 'titleLeft'), false);
  const switched = resolvePresentation({ theme: 'half-block', ansi: { table: { cornerStyle: 'quarter' } } });
  assert.equal(ansiBorder(switched.ansi).titleLeft, '\u{1fbee}');
});

test('custom borders, rules, separators, spacing and icons render safely within narrow cell budgets', () => {
  const presentation = { theme: 'half-block', ansi: {
    glyphs: { dashboard: 'D', warning: '!', pr: 'P', cl: 'C', bugs: ['x', '\u{1f41d}'] },
    table: {
      padding: 3, gap: 6, separator: '\u2502',
      border: {
        left: '[', right: ']', titleLeft: '<', titleRight: '>', lastLeft: '{', lastRight: '}',
        foreground: '#123456', top: { left: '+', fill: '-', right: '+' },
        bottom: { left: '+', fill: '=', right: '+' },
      },
    },
  } };
  const document = snapshot({ stale: true, truncated: true, items: [
    testItem({ id: '2', title: 'A synthetic title that wraps with custom spacing' }),
    testItem({ id: '3', title: 'Another bug' }),
  ] });
  for (const columns of [24, 40, 100]) {
    const output = formatResults(document, 'ansi', { presentation, columns }).output;
    const lines = stripTerminal(output).trimEnd().split('\n').slice(2);
    assert.match(lines[0], /^\+-+\+$/);
    assert.match(lines[1], /^<.*>$/);
    assert.match(lines.at(-2), /^\{.*\}$/);
    assert.match(lines.at(-1), /^\+=+\+$/);
    assert.ok(lines.every(line => displayWidth(line) === displayWidth(lines[0]) && displayWidth(line) <= columns));
    assert.ok(output.includes('D DevDash'));
    assert.ok(output.includes('! TRUNCATED'));
    if (columns === 100) {
      assert.ok(output.includes('x #2'));
      assert.ok(output.includes('\u{1f41d} #3'));
    }
    assert.ok(output.includes('\u2502'));
    assert.ok(!output.includes('STALE'));
    for (const line of output.trimEnd().split('\n').slice(2)) {
      assert.ok(line.startsWith('\x1b[0;38;2;18;52;86m'));
      assert.ok(line.endsWith('\x1b[0m'));
    }
    for (const [kind, icon] of [['pr', 'P'], ['cl', 'C']]) {
      const items = [testItem({ kind, ...(kind === 'cl' ? { provider: 'chromium' } : {}) })];
      assert.ok(formatResults(snapshot({ items }), 'ansi', { presentation }).output.includes(`${icon} #1`));
    }
  }
  for (const format of ['markdown', 'text']) {
    assert.equal(formatResults(document, format, { presentation }).output, formatResults(document, format).output);
  }
});

test('pixel sides can repeat on every line with no horizontal rules, and borders can be disabled or asymmetric', () => {
  const presentation = { theme: 'half-block', ansi: { icons: false, table: {
    padding: 0, gap: 0, separator: ' ',
    border: { left: '\ue0c7', right: '\ue0c6', top: false, bottom: false },
  } } };
  const document = snapshot({ items: [testItem({ title: 'Long synthetic content for a narrow table' })] });
  const output = formatResults(document, 'ansi', { presentation, columns: 24 }).output;
  const lines = stripTerminal(output).trimEnd().split('\n').slice(2);
  assert.ok(lines.length > 2);
  assert.ok(lines.every(line => line.startsWith('\ue0c7') && line.endsWith('\ue0c6') && displayWidth(line) <= 24));
  const noBorders = formatResults(document, 'ansi', { presentation: {
    ansi: { table: { caps: false, border: { top: { left: '+', fill: '-', right: '+' } } } },
  } }).output;
  assert.doesNotMatch(noBorders, /[\u2590\u258c\u2580]|[+]/);
  const asymmetric = formatResults(document, 'ansi', { columns: 24, presentation: { theme: 'half-block', ansi: { table: {
    border: { left: '', right: ']', bottom: false },
  } } } }).output;
  assert.ok(stripTerminal(asymmetric).trimEnd().split('\n').slice(2).every(line => line.endsWith(']') && displayWidth(line) <= 24));
});

test('unsafe, non-cell and overly wide geometry or icon values fail explicitly', () => {
  for (const table of [
    { padding: -1 }, { padding: 4 }, { gap: 7 }, { separator: '\x1b[31m' }, { separator: '12345' },
    { border: { left: '\u754c' } }, { border: { right: '\u0301' } }, { border: { left: 'ab' } },
    { border: { bottom: { fill: '' } } }, { border: { top: {} } },
    { border: { titleLeft: '\u202e' } }, { border: { left: '\n' } },
    { separator: '\u200d' }, { separator: '\u00ad' }, { border: { left: '\ud800' } },
  ]) assert.throws(() => resolvePresentation({ theme: 'half-block', ansi: { table } }), { code: 'INVALID_PRESENTATION' });
  for (const glyphs of [
    { bugs: [] }, { bugs: ['\x1b'] }, { pr: 'abc' }, { warning: '\u200b' }, { dashboard: '' },
    { dashboard: '\u00ad' }, { warning: '\u2060' },
  ]) assert.throws(() => resolvePresentation({ ansi: { glyphs } }), { code: 'INVALID_PRESENTATION' });
  assert.equal(resolvePresentation({ ansi: { glyphs: { bugs: ['\u{1f469}\u200d\u{1f4bb}'] } } }).ansi.glyphs.bugs.length, 1);
});

test('stale status remains in the input while human output omits its warning and retains fetch age and truncation', () => {
  const document = snapshot({ stale: true, truncated: true, fetchedAt: '2026-01-01T00:00:00Z' });
  for (const format of ['ansi', 'text', 'markdown']) {
    const output = formatResults(document, format, { now: new Date('2026-01-01T01:00:00Z') }).output;
    assert.ok(!output.includes('STALE'));
    assert.ok(!output.includes('refresh recommended'));
    assert.ok(output.includes('TRUNCATED'));
    if (format === 'ansi') assert.ok(output.includes('(1 hour ago)'));
  }
  assert.equal(document.stale, true);
});

test('schemas and public examples cover user settings and all override levels', async t => {
  const resolvedPaths = await fixture(t);
  const user = JSON.parse(await readFile(new URL('../examples/user.config.json', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(new URL('../examples/styled.config.json', import.meta.url), 'utf8'));
  await writeFile(resolvedPaths.userConfig, JSON.stringify(user));
  validateConfig(config);
  const { presentationFor } = await loadPresentation(resolvedPaths, config);
  assert.equal(presentationFor({ profile: 'work', query: 'bugs' }).ansi.table.header.background, 'p:groupHeader');
  assert.equal(presentationFor({ profile: 'work', query: 'priority-bugs' }).ansi.table.header.background, 'p:queryHeader');
  assert.equal(presentationFor({ profile: 'work', query: 'priority-bugs' }).ansi.table.header.foreground, 'p:row');
  assert.equal(presentationFor({ profile: 'work', query: 'priority-bugs' }).ascii.links, false);
  assert.equal(presentationFor({ profile: 'work', query: 'bugs' }).ascii.links, true);
  assert.deepEqual(providerProfile({ ...query, presentation: header('#abcdef') }), query);
});
