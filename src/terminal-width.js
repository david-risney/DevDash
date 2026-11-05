export const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function graphemeWidth(value) {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(value)) return 0;
  const code = value.codePointAt(0);
  return (!value.includes('\ufe0e') && (/[\p{Emoji_Presentation}\u20e3]/u.test(value) ||
    (value.includes('\ufe0f') && /\p{Extended_Pictographic}/u.test(value)))) ||
    (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd))) ? 2 : 1;
}

export const displayWidth = value => [...segmenter.segment(value)].reduce((sum, part) => sum + graphemeWidth(part.segment), 0);
