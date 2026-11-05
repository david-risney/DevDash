import { validateQueryResult } from './providers/contract.js';
import { StringDecoder } from 'node:string_decoder';
import { DevDashError } from './errors.js';
import { ansiBorder, ansiColor, ansiStyle, defaultPresentation, resolvePresentation } from './presentation.js';
import { displayWidth, graphemeWidth, segmenter } from './terminal-width.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const controls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = value => String(value).replace(controls, ' ').replace(/\s+/gu, ' ').trim();
const markdown = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&');
const invalid = () => { throw new Error('Invalid DevDash query-result JSON.'); };
const paint = (value, color) => `\x1b[${color}m${value}\x1b[0m`;
// U+1FAB2 is one cell in older terminal width tables; use the supported bee instead.
const bugEmoji = defaultPresentation.ansi.glyphs.bugs;
// Nerd Fonts Codicons: dashboard, PR, commit, warning.
const icons = defaultPresentation.ansi.glyphs;
const providers = { github: 'GitHub', ado: 'Azure DevOps', chromium: 'Chromium' };
const resources = { bugs: ['bug', 'bugs'], prs: ['pull request', 'pull requests'], cls: ['change', 'changes'] };
function band(value, style, settings, edge = 'middle') {
  const border = ansiBorder(settings);
  const color = border.foreground ?? (border.colorSource === 'header' ? settings.table.header : style).background;
  const cap = `\x1b[0;38;2;${ansiColor(color, settings.palette)}m`;
  const content = `\x1b[0;${ansiStyle(style, settings.palette)}m${value}`;
  if (!settings.table.caps) return `${content}\x1b[0m`;
  const left = edge === 'top' ? border.titleLeft : edge === 'bottom' ? border.lastLeft : border.left;
  const right = edge === 'top' ? border.titleRight : edge === 'bottom' ? border.lastRight : border.right;
  const slots = borderWidths(border);
  const start = border.filledSides && left === ' ' ? `\x1b[0;${ansiStyle(style, settings.palette)}m ${value}` : cap + left.padStart(slots.left) + content;
  const end = border.filledSides && right === ' ' ? ' ' : cap + right.padEnd(slots.right);
  return `${start}${end}\x1b[0m`;
}

function borderWidths(border) {
  const rule = border.top || border.bottom ? 1 : 0;
  return {
    left: Math.max(rule, ...[border.left, border.titleLeft, border.lastLeft].map(displayWidth)),
    right: Math.max(rule, ...[border.right, border.titleRight, border.lastRight].map(displayWidth)),
  };
}

function safeUrl(value) {
  if (!nonempty(value) || clean(value) !== value || /[\s\\]/u.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid();
  return url.href;
}

function sections(document) {
  const result = [];
  function visit(value, context = {}, depth = 0) {
    if (!object(value) || depth > 2 || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) invalid();
    const identity = { ...context };
    for (const key of ['profile', 'query', 'provider', 'resource']) {
      if (value[key] !== undefined) {
        if (!nonempty(value[key])) invalid();
        identity[key] = value[key];
      }
    }
    if (value.queryUrl !== undefined) identity.queryUrl = safeUrl(value.queryUrl);
    const shapes = ['results', 'queries', 'items', 'error'].filter(key => Object.hasOwn(value, key));
    if (shapes.length !== 1) invalid();
    if (value.results !== undefined) {
      if (depth !== 0 || !Array.isArray(value.results)) invalid();
      for (const entry of value.results) visit(entry, identity, depth + 1);
    } else if (value.queries !== undefined) {
      if (depth > 1 || !object(value.queries)) invalid();
      for (const [query, entry] of Object.entries(value.queries)) {
        visit(entry, { ...identity, query }, depth + 1);
      }
    } else if (value.error !== undefined) {
      if (!object(value.error) || !nonempty(value.error.code) || !nonempty(value.error.message) ||
          (value.error.diagnosticId !== undefined && !nonempty(value.error.diagnosticId))) invalid();
      result.push({ ...identity, error: value.error });
    } else {
      if (!Array.isArray(value.items) || typeof value.truncated !== 'boolean') invalid();
      for (const key of ['stale', 'fromCache']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid();
      }
      for (const key of ['fetchedAt', 'expiresAt']) {
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])))) invalid();
      }
      const provider = identity.provider ?? value.items[0]?.provider;
      const resource = identity.resource ?? { bug: 'bugs', pr: 'prs', cl: 'cls' }[value.items[0]?.kind];
      const resources = { github: ['bugs', 'prs'], ado: ['bugs', 'prs'], chromium: ['bugs', 'cls'] };
      if ((provider !== undefined && (!Object.hasOwn(resources, provider) || !resources[provider].includes(resource))) ||
          (provider === undefined && resource !== undefined)) invalid();
      try {
        validateQueryResult({ provider, resource, limit: 20_000 }, value);
        for (const item of value.items) safeUrl(item.url);
      } catch { invalid(); }
      result.push({ ...identity, provider, resource, ...value });
    }
  }
  visit(document);
  return result;
}

function friendlyState(value) {
  const words = clean(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function commonRepository(section) {
  const names = new Set(section.items?.map(item => item.repository));
  return names.size === 1 ? [...names][0] : null;
}

function personKey(item) {
  return item.kind === 'bug'
    ? JSON.stringify([...new Set(item.assignees.map(person => clean(person).normalize('NFC')))].sort())
    : item.author === null ? null : clean(item.author).normalize('NFC');
}

function tableColumns(section) {
  const columns = [
    { key: 'item', label: 'Item', max: 22 },
    { key: 'title', label: 'Title', max: 60 },
    { key: 'status', label: 'Status', max: 24 },
  ];
  if (new Set(section.items.map(personKey)).size > 1) {
    columns.push({ key: 'person', label: section.resource === 'bugs' ? 'Assignee' : 'Author', max: 24 });
  }
  if (!commonRepository(section) && section.items.some(item => item.repository)) {
    columns.push({ key: 'repository', label: 'Repository', max: 24 });
  }
  for (const [key, label] of [['priority', 'Priority'], ['severity', 'Severity']]) {
    if (section.items.some(item => item[key] != null)) columns.push({ key, label, max: 10 });
  }
  if (section.items.some(item => item.updatedAt != null)) columns.push({ key: 'updated', label: 'Updated', max: 10 });
  return columns;
}

function tableRow(item, year) {
  const icon = item.kind === 'bug' ? bugEmoji[Number(BigInt(item.id) % BigInt(bugEmoji.length))] : icons[item.kind];
  const date = item.updatedAt?.slice(0, 10);
  return {
    item: `#${item.id}`, icon, kind: item.kind,
    title: clean(item.title),
    status: `${item.draft ? 'Draft / ' : ''}${friendlyState(item.state)}`,
    person: clean((item.kind === 'bug' ? item.assignees.join(', ') : item.author) || '-'),
    repository: clean(item.repository ?? '-'),
    priority: clean(item.priority ?? '-'),
    severity: clean(item.severity ?? '-'),
    updated: date ? (Number(date.slice(0, 4)) === year ? date.slice(5) : date) : '-',
    url: safeUrl(item.url),
    tone: item.draft ? 'draft' : /^(closed|merged|resolved|fixed|completed)$/i.test(item.state) ? 'closed' : 'active',
  };
}

function wrapCell(value, width) {
  const lines = [];
  let line = '';
  let length = 0;
  for (const word of value.split(' ')) {
    const wordWidth = displayWidth(word);
    if (line && length + 1 + wordWidth <= width) {
      line += ` ${word}`;
      length += 1 + wordWidth;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    length = 0;
    for (const { segment } of segmenter.segment(word)) {
      const size = graphemeWidth(segment);
      if (length + size > width) {
        lines.push(line);
        line = '';
        length = 0;
      }
      line += segment;
      length += size;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function markdownTable(columns, rows, settings) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [
    line(columns.map(column => column.label)),
    line(columns.map(column => ({ left: ':---', center: ':---:', right: '---:' }[settings.table.align[column.key]] ?? '---'))),
    ...rows.map(row => line(columns.map(column => {
      if (column.key !== 'item') return row[column.key] === '-' ? '-' : markdown(row[column.key]);
      const url = row.url.replace(/[()<>\\|]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      return settings.links ? `[${markdown(row.item)}](${url})` : markdown(row.item);
    }))),
  ];
}

function sectionUrl(section) {
  if (section.queryUrl) return safeUrl(section.queryUrl);
  if (!section.items?.length) return null;
  const url = new URL(safeUrl(section.items[0].url));
  url.search = '';
  url.hash = '';
  if (section.provider === 'github') url.pathname = url.pathname.replace(/\/(?:issues|pull)\/\d+$/, section.resource === 'prs' ? '/pulls' : '/issues');
  else if (section.provider === 'ado') url.pathname = url.pathname
    .replace(/\/_workitems\/edit\/\d+$/, '/_queries').replace(/\/pullrequest\/\d+$/, '/pullrequests');
  else if (section.provider === 'chromium') url.pathname = section.resource === 'bugs' ? '/issues' : '/q/status:open';
  return url.href;
}

function updateAge(section, now) {
  if (!section.fetchedAt) return '';
  const elapsed = now.getTime() - Date.parse(section.fetchedAt);
  if (elapsed <= 120_000) return '';
  const [unit, milliseconds] = elapsed >= 86_400_000 ? ['day', 86_400_000]
    : elapsed >= 3_600_000 ? ['hour', 3_600_000] : ['minute', 60_000];
  const count = Math.floor(elapsed / milliseconds);
  return ` (${count} ${unit}${count === 1 ? '' : 's'} ago)`;
}

function consoleTable(columns, rows, ansi, width, panel, settings) {
  columns = [...columns];
  rows = rows.map(row => {
    const icon = ansi ? row.kind === 'bug'
      ? settings.glyphs.bugs[Number(BigInt(row.item.slice(1)) % BigInt(settings.glyphs.bugs.length))]
      : settings.glyphs[row.kind] : '';
    return { ...row, item: ansi && settings.icons ? `${icon} ${row.item}` : row.item };
  });
  const table = settings.table;
  const border = ansi ? ansiBorder(settings) : null;
  const sides = ansi && table.caps ? borderWidths(border) : { left: 0, right: 0 };
  let padding = ansi ? table.padding : 0;
  let gapSize = ansi ? table.gap : 0;
  const gap = () => ansi ? ' '.repeat(Math.floor(gapSize / 2)) + table.separator + ' '.repeat(Math.ceil(gapSize / 2)) : table.separator;
  const overhead = () => (columns.length - 1) * displayWidth(gap()) + padding * 2 + sides.left + sides.right;
  const minimum = column => ansi ? Math.min(3, column.label.length) : column.label.length;
  const minimumWidth = () => columns.reduce((sum, column) => sum + minimum(column), 0) + overhead();
  for (const key of ['updated', 'repository', 'severity', 'priority', 'person']) {
    if (minimumWidth() + 10 <= width) break;
    columns = columns.filter(column => column.key !== key);
  }
  while (ansi && minimumWidth() > width && (gapSize || padding)) {
    if (gapSize) gapSize--;
    else padding--;
  }
  const widths = columns.map(column => Math.max(minimum(column),
    Math.min(column.max, Math.max(...rows.map(row => displayWidth(row[column.key]))))));
  const total = () => widths.reduce((sum, size) => sum + size, 0) + overhead();
  while (total() > width) {
    let largest = -1;
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] > minimum(columns[index]) && (largest === -1 || widths[index] > widths[largest])) largest = index;
    }
    if (largest === -1) break;
    widths[largest]--;
  }
  const edges = padding * 2 + sides.left + sides.right;
  const panelLabels = ansi ? [panel.panelTitle, ...panel.notices, ...(!rows.length ? [panel.message] : [])] : [];
  const panelWidth = ansi ? Math.min(width, Math.max(total(), ...panelLabels.map(label => displayWidth(label) + edges))) : total();
  const innerWidth = panelWidth - edges;
  const lines = [];
  const inset = ' '.repeat(padding);
  const rule = (definition, style) => {
    const color = border.foreground ?? (border.colorSource === 'header' ? table.header : style).background;
    return `\x1b[0;38;2;${ansiColor(color, settings.palette)}m${definition.left}${definition.fill.repeat(panelWidth - 2)}${definition.right}\x1b[0m`;
  };
  if (ansi) {
    if (table.caps && border.top) lines.push(rule(border.top, table.header));
    for (const [index, label] of wrapCell(panel.panelTitle, innerWidth).entries()) {
      const linked = settings.links && panel.url ? `\x1b]8;;${panel.url}\x1b\\${label}\x1b]8;;\x1b\\` : label;
      lines.push(band(`${inset}${linked}${' '.repeat(innerWidth - displayWidth(label))}${inset}`,
        table.header, settings, index === 0 ? 'top' : 'middle'));
    }
    for (const notice of panel.notices) {
      for (const label of wrapCell(`${settings.icons ? `${settings.glyphs.warning} ` : ''}${notice}`, innerWidth)) {
        lines.push(band(`${inset}${label}${' '.repeat(innerWidth - displayWidth(label))}${inset}`,
          { ...table.header, ...table.warning }, settings));
      }
    }
    if (!rows.length) {
      const labels = wrapCell(panel.message, innerWidth);
      labels.forEach((label, index) => {
        lines.push(band(`${inset}${label}${' '.repeat(innerWidth - displayWidth(label))}${inset}`,
          { ...table.rows[0], ...(panel.error ? table.error : {}) }, settings,
          index === labels.length - 1 ? 'bottom' : 'middle'));
      });
    }
  } else {
    lines.push(columns.map((column, index) => column.label.padEnd(widths[index])).join(gap()),
      widths.map(size => '-'.repeat(size)).join(table.junction));
  }
  for (const [rowIndex, row] of rows.entries()) {
    const rowStyle = ansi ? table.rows[rowIndex % table.rows.length] : null;
    const cells = columns.map((column, index) => wrapCell(row[column.key], widths[index]));
    const height = Math.max(...cells.map(cell => cell.length));
    for (let line = 0; line < height; line++) {
      const content = columns.map((column, index) => {
        const value = cells[index][line] ?? '';
        const padding = ' '.repeat(widths[index] - displayWidth(value));
        if (!ansi) return value + padding;
        const cellStyle = {
          ...rowStyle, ...(column.key === 'status' ? table.states[row.tone] : {}),
          ...table.columns[column.key], ...(value === '-' ? table.missing : {}),
        };
        const background = ansiColor(cellStyle.background, settings.palette) !== ansiColor(rowStyle.background, settings.palette);
        const style = `\x1b[${ansiStyle(cellStyle, settings.palette, background)}m`;
        const label = settings.links && column.key === 'item' && value
          ? `\x1b]8;;${row.url}\x1b\\${value}\x1b]8;;\x1b\\` : value;
        return style + label + padding + (background ? `\x1b[48;2;${ansiColor(rowStyle.background, settings.palette)}m` : '');
      }).join(ansi && table.separator ? `\x1b[${ansiStyle(rowStyle, settings.palette, false)}m${gap()}` : gap());
      // Only reset at the line boundary so cell colors cannot punch holes in the row band.
      lines.push(ansi ? band(
        `${inset}${content}\x1b[${ansiStyle(rowStyle, settings.palette, false)}m${' '.repeat(panelWidth - total())}${inset}`,
        rowStyle, settings, rowIndex === rows.length - 1 && line === height - 1 ? 'bottom' : 'middle') : content);
    }
  }
  if (ansi && table.caps && border.bottom) {
    const lastStyle = rows.length ? table.rows[(rows.length - 1) % table.rows.length]
      : { ...table.rows[0], ...(panel.error ? table.error : {}) };
    lines.push(rule(border.bottom, lastStyle));
  }
  return lines;
}

/** Build the same friendly table data for every renderer, without terminal or Markdown decoration. */
export function buildTableModels(document, { now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Current date must be valid.');
  const year = now.getUTCFullYear();
  return sections(document).map(section => {
    const title = clean([section.profile, section.query].filter(Boolean).join(' / ')
      || [providers[section.provider], resources[section.resource]?.[1]].filter(Boolean).join(' ') || 'Results');
    const scope = clean([providers[section.provider], resources[section.resource]?.[1], commonRepository(section)].filter(Boolean).join(' - '));
    const rows = (section.items ?? []).map(item => tableRow(item, year));
    const count = `${rows.length} ${(resources[section.resource] ?? ['item', 'items'])[rows.length === 1 ? 0 : 1]}`;
    const notices = [];
    if (section.truncated) notices.push('TRUNCATED - showing only part of the results');
    const summary = [count];
    if (section.fromCache !== undefined) summary.push(section.fromCache ? 'cached' : 'just refreshed');
    summary.push(...notices);
    return {
      profile: section.profile, query: section.query, title, scope, rows, notices,
      columns: rows.length ? tableColumns(section) : [],
      panelTitle: title + (section.error ? '' : ` - ${count}`) + updateAge(section, now),
      summary: summary.join(' / '), url: sectionUrl(section),
      error: Boolean(section.error),
      message: section.error ? clean(`Error: ${section.error.message} (${section.error.code})`) : 'No items found.',
    };
  });
}

/** Render query results only; never fetch providers or modify the input/cache. */
export function formatResults(document, format, {
  columns = 100, now = new Date(), presentation, presentationFor,
} = {}) {
  if (!['markdown', 'ansi', 'text'].includes(format)) throw new Error('Unknown presentation format.');
  if (!Number.isInteger(columns) || columns < 1) throw new Error('Console width must be a positive integer.');
  const width = Math.max(24, Math.min(240, columns));
  const groups = buildTableModels(document, { now });
  const base = resolvePresentation(presentation);
  const md = format === 'markdown';
  const ansi = format === 'ansi';
  const text = md ? markdown : clean;
  const dashboardStyle = ansiStyle({ foreground: base.ansi.table.header.foreground, bold: true }, base.ansi.palette);
  const lines = [md ? '# DevDash' : ansi ? paint(`${base.ansi.icons ? `${base.ansi.glyphs.dashboard} ` : ''}DevDash`, dashboardStyle) : 'DevDash'];
  let failed = 0;
  if (!groups.length) lines.push('', 'No query results.');
  for (const model of groups) {
    const styles = resolvePresentation(base, presentationFor?.(model));
    const settings = ansi ? styles.ansi : md ? styles.md : styles.ascii;
    if (model.error) failed++;
    if (ansi) {
      lines.push('', ...consoleTable(model.columns, model.rows, true, width, model, settings));
      continue;
    }
    lines.push('', md ? `${'#'.repeat(settings.headingLevel)} ${text(model.title)}` : model.title);
    if (model.scope) lines.push(text(model.scope));
    if (model.error) {
      lines.push(text(model.message));
      continue;
    }
    lines.push(text(model.summary));
    if (!model.rows.length) {
      lines.push('', model.message);
      continue;
    }
    lines.push('', ...(md ? markdownTable(model.columns, model.rows, settings)
      : consoleTable(model.columns, model.rows, false, width, model, settings)));
    if (!md && settings.links) {
      lines.push('', 'Links:', ...model.rows.map(row => `  ${row.item} ${row.url}`));
    }
  }
  return { output: lines.join('\n') + '\n', failed };
}

export async function readResultJson(input) {
  if (input.isTTY) throw new DevDashError('INVALID_INPUT', 'Pipe one query-result JSON document to devdash format.');
  try {
    let text = '';
    let size = 0;
    const decoder = new StringDecoder('utf8');
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 32 * 1024 * 1024) throw new Error('Input exceeds 32 MiB.');
      text += decoder.write(bytes);
    }
    const document = JSON.parse((text + decoder.end()).replace(/^\uFEFF/, ''));
    return { document, failed: sections(document).filter(section => section.error).length };
  } catch {
    throw new DevDashError('INVALID_INPUT',
      'Could not render input. Supply one valid DevDash query-result JSON document (at most 32 MiB); private input was not printed.');
  }
}
