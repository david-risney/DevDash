import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ansiBorder, loadPresentation, resolvePresentation, defaultPresentation } from '../src/presentation.js';
import { displayWidth } from '../src/terminal-width.js';
import { buildTableModels, formatResults } from '../src/format.js';
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
  assert.equal(styles.ansi.table.header.background, 'p:header');
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
    ansi: {
      icons: false,
      palette: { customHeader: '#112233', first: '#223344', second: '#334455', cell: '#445566', ink: '#ddeeff' },
      table: {
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
  const presentation = { ansi: { table: { cornerStyle: 'semicircle' } } };
  assert.equal(resolvePresentation().ansi.table.cornerStyle, 'half');
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
  const presentation = { ansi: { table: { cornerStyle: 'quarter' } } };
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
    ansi: { icons: false, links: false, table: { caps: false } },
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

test('geometry overrides apply after presets, deep-merge across scopes and do not materialize preset defaults', async t => {
  const resolvedPaths = await fixture(t);
  await writeFile(resolvedPaths.userConfig, JSON.stringify(userDocument({
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
  assert.throws(() => resolvePresentation({ ansi: { table: { border: { top: { fill: '-' } } } } }), { code: 'INVALID_PRESENTATION' });
  assert.equal(Object.hasOwn(ansi.table.border, 'titleLeft'), false);
  const switched = resolvePresentation({ ansi: { table: { cornerStyle: 'quarter' } } });
  assert.equal(ansiBorder(switched.ansi).titleLeft, '\u{1fbee}');
});

test('custom borders, rules, separators, spacing and icons render safely within narrow cell budgets', () => {
  const presentation = { ansi: {
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
  const presentation = { ansi: { icons: false, table: {
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
  const asymmetric = formatResults(document, 'ansi', { columns: 24, presentation: { ansi: { table: {
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
  ]) assert.throws(() => resolvePresentation({ ansi: { table } }), { code: 'INVALID_PRESENTATION' });
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
  assert.equal(presentationFor({ profile: 'work', query: 'priority-bugs' }).ansi.table.header.foreground, 'p:accent');
  assert.equal(presentationFor({ profile: 'work', query: 'priority-bugs' }).ascii.links, false);
  assert.equal(presentationFor({ profile: 'work', query: 'bugs' }).ascii.links, true);
  assert.deepEqual(providerProfile({ ...query, presentation: header('#abcdef') }), query);
});
