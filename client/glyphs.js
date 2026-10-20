// The ad font sets draw a sharp/flat as a zero-width "/" or "\" in front of the note.
// The aa, ab and ac sets have no such sign: each sharp or flat note is its own capital letter or symbol.
// Everything the server returns uses the ad spelling; these helpers convert to and from the others.

const SHARP = { 1: '!', 2: '@', 4: '$', 5: '%', 6: '^', a: 'A', s: 'S', f: 'F', g: 'G', h: 'H', q: 'Q', w: 'W', r: 'R', t: 'T', y: 'Y' };
const FLAT = { 7: '&', j: 'J', u: 'U' }; // only 7 is drawn flat

const COMBINED = new Map([
  ...Object.entries(SHARP).map(([note, glyph]) => [`/${note}`, glyph]),
  ...Object.entries(FLAT).map(([note, glyph]) => [`\\${note}`, glyph]),
]);
const SPLIT = new Map([...COMBINED].map(([pair, glyph]) => [glyph, pair]));

const COMBINED_SETS = ['aa', 'ab', 'ac'];

const swap = (text, map) => text.replace(/[/\\]./g, (pair) => map.get(pair) ?? pair);

// note rows from the ad spelling into what `set` expects
export function toSet(text, set) {
  return COMBINED_SETS.includes(set) ? swap(text, COMBINED) : text;
}

// capitals of an aa/ab/ac note font back into the ad spelling
export function fromCombined(text) {
  return [...text].map((ch) => SPLIT.get(ch) ?? ch).join('');
}
