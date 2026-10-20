import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } from 'docx';

// the song fonts must be installed where the .docx is opened (same as when typing scores by hand)
const FONT = { notes: 'adangka', garis: 'adgaris', lyrics: 'adhuruf', text: 'Calibri' };
export const DEFAULT_SIZE = 12; // pt
const NARROW_MARGIN = 720; // twips: Word's "Narrow" preset, 0.5 in
const GUTTER = 4; // label column in characters, as in the result panel

const run = (text, font, pt) => new TextRun({ text, font: { name: font }, size: Math.round(pt * 2) }); // size is in half-points

export async function linesToDocx(lines, pt = DEFAULT_SIZE) {
    const children = lines.map(({ text, kind, label }) => {
        if (kind === 'rule') {
            return new Paragraph({
                spacing: { before: 120, after: 120 },
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '000000' } },
            });
        }
        const runs = [];
        if (label !== undefined) runs.push(run(label.padEnd(GUTTER), FONT.lyrics, pt * 0.75));
        runs.push(run(text, FONT[kind] ?? FONT.text, pt));
        // exact line height keeps the stacked beat-line, note and lyric rows close together like the app shows them
        return new Paragraph({ children: runs, spacing: { line: Math.round(pt * (kind === 'text' ? 23 : 24)), lineRule: 'exact' } });
    });
    return Packer.toBuffer(new Document({ sections: [{
        properties: { page: { margin: { top: NARROW_MARGIN, bottom: NARROW_MARGIN, left: NARROW_MARGIN, right: NARROW_MARGIN } } },
        children,
    }] }));
}
