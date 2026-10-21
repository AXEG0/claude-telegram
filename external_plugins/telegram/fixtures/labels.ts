// Button labels the tests send: each refused one named for what it holds,
// and ones that pass and come back unchanged.

// Characters by code point, so none hides in this file as itself.
export const cp = (...points: number[]) => String.fromCodePoint(...points)
export const lone = (unit: number) => String.fromCharCode(unit)

// Each refused label, named for what it holds.
export const REFUSED_LABELS: [string, string][] = [
  ['empty', ''],
  ['41 code points', 'x'.repeat(41)],
  ['a tab', 'a\tb'],
  ['U+007F', `a${cp(0x7f)}b`],
  ['U+0085', `a${cp(0x85)}b`],
  ['U+00A0', `a${cp(0xa0)}b`],
  ['U+202F', `a${cp(0x202f)}b`],
  ['U+2028', `a${cp(0x2028)}b`],
  ['U+202E', `a${cp(0x202e)}b`],
  ['U+030A', `a${cp(0x30a)}`],
  ['U+FEFF', `a${cp(0xfeff)}b`],
  ['a double quote', 'say "yes"'],
  ['a lone high surrogate', `a${lone(0xd83d)}b`],
  ['a lone low surrogate', `a${lone(0xde00)}`],
  ['a mixed run of U+200E and U+200F', `a${cp(0x200e, 0x200f)}b`],
  ['only U+200B', cp(0x200b)],
  ['only U+180E and U+2800', cp(0x180e, 0x2800)],
  ['only a tag character', cp(0xe0041)],
  ['a leading space', ' Yes'],
  ['a trailing space', 'Yes '],
  ['two spaces', 'Yes  please'],
  ['an angle bracket', 'a<b'],
  ['a square bracket', '[x]'],
  ['a semicolon', 'a;b'],
  ['U+0333', `a${cp(0x333)}`],
  ['U+033F', `a${cp(0x33f)}`],
  ['a line break', 'a\nb'],
]

// A family emoji joined by U+200D, a single U+200E, and 40 code points of
// Cyrillic.
export const PASSING_LABELS = [cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), `Yes${cp(0x200e)}`, 'Ж'.repeat(40), 'Ship it now']
