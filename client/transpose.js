// Transposes the notes rows (ad spelling, see glyphs.js) by whole semitone steps.
// Digits are read as major-scale degrees; the shift is applied to the pitch and written back with a sharp
// where the result is a black key (the aa/ab/ac fonts only have sharp glyphs), keeping the octave dots.

export const KEYS = [
  { value: 0, name: 'C' }, { value: 1, name: 'C#' }, { value: 2, name: 'D' }, { value: 3, name: 'Eb' },
  { value: 4, name: 'E' }, { value: 5, name: 'F' }, { value: 6, name: 'F#' }, { value: 7, name: 'G' },
  { value: 8, name: 'Ab' }, { value: 9, name: 'A' }, { value: 10, name: 'Bb' }, { value: 11, name: 'B' },
];

const SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // degrees 1-7
const SHARP_DEGREE = [[1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0], [6, 1], [7, 0]]; // by pitch class: [degree, sharp?]
const BELOW = 'asdfghj'; // dot below 1-7
const ABOVE = 'qwertyu'; // dot above 1-7
const NOTE = /[/\\]?[1-7asdfghjqwertyui]/g; // one cell: optional (zero-width) accidental + note

function decode(ch) {
  if (ch === 'i') return { degree: 1, octave: 2 };
  if (BELOW.includes(ch)) return { degree: BELOW.indexOf(ch) + 1, octave: -1 };
  if (ABOVE.includes(ch)) return { degree: ABOVE.indexOf(ch) + 1, octave: 1 };
  return { degree: Number(ch), octave: 0 };
}

function encode(degree, octave) {
  if (octave >= 2 && degree === 1) return 'i';
  if (octave >= 1) return ABOVE[degree - 1];
  if (octave <= -1) return BELOW[degree - 1]; // the fonts have one dot below at most
  return String(degree);
}

function shiftCell(cell, steps) {
  const accidental = cell.length === 2 ? { '/': 1, '\\': -1 }[cell[0]] : 0;
  const { degree, octave } = decode(cell.at(-1));
  const total = octave * 12 + SEMITONES[degree - 1] + accidental + steps;
  const [newDegree, sharp] = SHARP_DEGREE[((total % 12) + 12) % 12];
  return (sharp ? '/' : '') + encode(newDegree, Math.floor(total / 12));
}

// shortest way from one key to the other, -5..+6 semitones
function stepsBetween(from, to) {
  const up = (((to - from) % 12) + 12) % 12;
  return up > 6 ? up - 12 : up;
}

export function transposeLines(lines, from, to) {
  if (from === '' || to === '' || from === to) return lines;
  const steps = stepsBetween(from, to);
  return lines.map((line) => (
    line.kind === 'notes' ? { ...line, text: line.text.replace(NOTE, (cell) => shiftCell(cell, steps)) } : line
  ));
}
