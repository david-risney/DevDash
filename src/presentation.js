import Ajv from 'ajv';
import schema from '../presentation.schema.json' with { type: 'json' };
import { DevDashError } from './errors.js';
import { readJson } from './storage.js';
import { displayWidth, segmenter } from './terminal-width.js';

const ajv = new Ajv({ allErrors: true, strict: false }).addSchema(schema);
const validateUser = ajv.getSchema(schema.$id);
const validateSettings = ajv.compile({ $ref: `${schema.$id}#/definitions/presentation` });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new DevDashError('INVALID_PRESENTATION', 'Invalid presentation settings. Check presentation.schema.json and named palette references.'); };

export const defaultPresentation = {
  ansi: {
    palette: {
      header: '#2e4052', row: '#1f2933', alternate: '#27333f', text: '#e0e8f0',
      muted: '#acbed0', accent: '#bee6f9', active: '#8cc8ff', closed: '#a6e3a1',
      draft: '#f9d380', priority: '#f3a5cf',
    },
    links: true, icons: true,
    glyphs: {
      dashboard: '\ueacd', pr: '\uea64', cl: '\ueafc', warning: '\uea6c',
      bugs: ['\u{1f41b}', '\u{1f41e}', '\u{1f41c}', '\u{1f41d}', '\u{1f997}', '\u{1f99f}'],
    },
    table: {
      caps: true,
      cornerStyle: 'half',
      padding: 1, gap: 2, separator: '', border: {},
      header: { background: 'p:header', foreground: 'p:accent', bold: true },
      rows: [
        { background: 'p:row', foreground: 'p:text', bold: false },
        { background: 'p:alternate', foreground: 'p:text', bold: false },
      ],
      columns: {
        item: { foreground: 'p:accent', bold: true },
        title: {}, status: {},
        person: { foreground: 'p:muted' }, repository: { foreground: 'p:muted' },
        priority: { foreground: 'p:priority', bold: true }, severity: { foreground: 'p:priority', bold: true },
        updated: { foreground: 'p:muted' },
      },
      states: {
        active: { foreground: 'p:active' }, closed: { foreground: 'p:closed' }, draft: { foreground: 'p:draft' },
      },
      missing: { foreground: 'p:muted' },
      warning: { foreground: 'p:draft', bold: false },
      error: { foreground: 'p:draft', bold: false },
    },
  },
  ascii: { links: true, table: { separator: ' | ', junction: '-+-' } },
  md: { links: true, headingLevel: 2, table: { align: {} } },
};

const borderPresets = {
  half: {
    left: '\u2590', right: '\u258c', colorSource: 'header',
    bottom: { left: '\u259d', fill: '\u2580', right: '\u2598' },
  },
  quarter: {
    left: ' ', right: ' ', titleLeft: '\u{1fbee}', titleRight: '\u{1fbed}',
    lastLeft: '\u{1fbec}', lastRight: '\u{1fbef}', colorSource: 'row', filledSides: true,
  },
  semicircle: { left: '\ue0b6', right: '\ue0b4', colorSource: 'row' },
};

/** Apply glyph overrides after the selected preset without persisting derived defaults. */
export function ansiBorder(settings) {
  const border = merge(borderPresets[settings.table.cornerStyle], settings.table.border);
  return {
    ...border, titleLeft: border.titleLeft ?? border.left, titleRight: border.titleRight ?? border.right,
    lastLeft: border.lastLeft ?? border.left, lastRight: border.lastRight ?? border.right,
  };
}

function merge(base, override) {
  if (!object(override)) return structuredClone(override);
  return Object.fromEntries([...new Set([...Object.keys(base ?? {}), ...Object.keys(override)])].map(key => [
    key, Object.hasOwn(override, key)
      ? merge(Object.hasOwn(base ?? {}, key) ? base[key] : undefined, override[key])
      : structuredClone(base[key]),
  ]));
}

export function resolvePresentation(...layers) {
  let settings = structuredClone(defaultPresentation);
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!validateSettings(layer)) invalid();
    settings = merge(settings, layer);
  }
  const checkReferences = value => {
    for (const [key, entry] of Object.entries(value)) {
      if (['foreground', 'background'].includes(key) && entry.startsWith('p:') &&
          !Object.hasOwn(settings.ansi.palette, entry.slice(2))) invalid();
      if (object(entry) || Array.isArray(entry)) checkReferences(entry);
    }
  };
  checkReferences(settings.ansi.table);
  const safe = value => !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
    ![...value].some(character => /\p{Cf}/u.test(character) && character !== '\u200d');
  const glyph = (value, maxWidth) => typeof value === 'string' && safe(value) && [...segmenter.segment(value)].length === 1 &&
    displayWidth(value) >= 1 && displayWidth(value) <= maxWidth;
  for (const [key, value] of Object.entries(settings.ansi.glyphs)) {
    if (key === 'bugs' ? !value.every(entry => glyph(entry, 2)) : !glyph(value, 2)) invalid();
  }
  if (!safe(settings.ansi.table.separator) || displayWidth(settings.ansi.table.separator) > 4 ||
      [...segmenter.segment(settings.ansi.table.separator)].some(part => displayWidth(part.segment) === 0)) invalid();
  const border = ansiBorder(settings.ansi);
  for (const key of ['left', 'right', 'titleLeft', 'titleRight', 'lastLeft', 'lastRight']) {
    if (border[key] !== '' && !glyph(border[key], 1)) invalid();
  }
  for (const key of ['top', 'bottom']) {
    if (!border[key]) continue;
    for (const part of ['left', 'fill', 'right']) {
      if (!glyph(border[key][part], 1)) invalid();
    }
  }
  // Replacement row arrays still inherit the base row's unspecified style properties.
  settings.ansi.table.rows = settings.ansi.table.rows.map(row => ({ ...defaultPresentation.ansi.table.rows[0], ...row }));
  if (settings.ascii.table.separator.length !== settings.ascii.table.junction.length) invalid();
  return settings;
}

export function ansiColor(color, palette) {
  const hex = color.startsWith('p:') ? palette[color.slice(2)] : color;
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(';');
}

export function ansiStyle(style, palette, background = true) {
  return [
    ...(background && style.background ? [`48;2;${ansiColor(style.background, palette)}`] : []),
    ...(style.foreground ? [`38;2;${ansiColor(style.foreground, palette)}`] : []),
    style.bold ? '1' : '22',
  ].join(';');
}

export async function loadPresentation(paths, config, { required = false } = {}) {
  const user = await readJson(paths.userConfig);
  if (user === null && required) {
    throw new DevDashError('INVALID_PRESENTATION', 'The explicitly selected user configuration file does not exist.');
  }
  if (user !== null && !validateUser(user)) invalid();
  const layers = [user?.presentation, config?.presentation];
  const base = resolvePresentation(...layers);
  const profiles = new Map();
  for (const [name, profile] of Object.entries(config?.profiles ?? {})) {
    const queries = new Map();
    const profileLayers = [...layers, profile.presentation];
    const settings = resolvePresentation(...profileLayers);
    for (const [query, definition] of Object.entries(profile.queries ?? {})) {
      queries.set(query, resolvePresentation(...profileLayers, definition.presentation));
    }
    profiles.set(name, { settings, queries });
  }
  return {
    presentation: base,
    presentationFor: section => {
      const profile = profiles.get(section.profile);
      return profile?.queries.get(section.query) ?? profile?.settings ?? base;
    },
  };
}
