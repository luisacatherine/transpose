// Reads angka scores from the text layer of PDFs typeset with the adangka/adgaris/adhuruf fonts.
// The characters are exact there, so this beats OCR; returns null when the PDF doesn't use those fonts.

import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { fromCombined } from '../client/glyphs.js';

const KINDS = [
    [/angka/i, 'notes'],
    [/garis/i, 'garis'],
    [/huruf/i, 'lyrics'],
];
const ZERO_WIDTH = new Set(['/', '\\']); // sharp/flat overlay the following note in the font
const ROW_TOLERANCE = 1.5; // pt, for items on the same baseline

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const RULE_MIN_WIDTH = 0.5; // of the page width
const RULE_MAX_THICKNESS = 4; // pt

// long thin filled rectangles, i.e. the horizontal lines that separate the systems
async function pageRules(page) {
    const { fnArray, argsArray } = await page.getOperatorList();
    const pageWidth = page.view[2] - page.view[0];
    const rules = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    fnArray.forEach((fn, i) => {
        const args = argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) {
            const [a, b, c, d, e, f] = args;
            ctm = [
                ctm[0] * a + ctm[2] * b, ctm[1] * a + ctm[3] * b,
                ctm[0] * c + ctm[2] * d, ctm[1] * c + ctm[3] * d,
                ctm[0] * e + ctm[2] * f + ctm[4], ctm[1] * e + ctm[3] * f + ctm[5],
            ];
        } else if (fn === OPS.constructPath) {
            const [x0, y0, x1, y1] = args[2]; // bounds of the path
            const w = (x1 - x0) * ctm[0];
            const h = Math.abs((y1 - y0) * ctm[3]);
            if (w >= pageWidth * RULE_MIN_WIDTH && h <= RULE_MAX_THICKNESS) {
                rules.push({ y: (y0 + y1) / 2 * ctm[3] + ctm[5], x: x0 * ctm[0] + ctm[4] });
            }
        }
    });
    return rules;
}

async function pageItems(page) {
    await page.getOperatorList(); // resolves the fonts so their names can be read
    const { items } = await page.getTextContent();
    return items
        .filter((it) => it.str && it.str.trim())
        .map((it) => {
            const font = page.commonObjs.get(it.fontName)?.name ?? '';
            const kind = KINDS.find(([re]) => re.test(font))?.[1] ?? 'text';
            // aa/ab/ac note fonts spell sharps and flats as capitals; keep the ad spelling internally
            const str = kind === 'notes' && /^(?:[A-Z]{6}\+)?a[abc]angka/i.test(font) ? fromCombined(it.str) : it.str;
            return { str, x: it.transform[4], y: it.transform[5], size: it.transform[0], width: it.width, kind };
        });
}

function groupRows(items) {
    const rows = [];
    for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= ROW_TOLERANCE);
        if (row) row.items.push(it);
        else rows.push({ y: it.y, items: [it] });
    }
    for (const r of rows) r.items.sort((a, b) => a.x - b.x);
    return rows;
}

function addRules(rows, rules) {
    return [...rows, ...rules.map((r) => ({ y: r.y, items: [], rule: true }))].sort((a, b) => b.y - a.y);
}

// places each item at the column its x position maps to, so rows from different fonts line up
function layoutRow(items, x0, cell) {
    let out = '';
    let col = 0;
    for (const it of items) {
        const start = Math.round((it.x - x0) / cell);
        if (start > col) { out += ' '.repeat(start - col); col = start; }
        for (const ch of it.str) {
            out += ch;
            if (!ZERO_WIDTH.has(ch)) col++;
        }
    }
    return out.replace(/\s+$/, '');
}

// proportional text: gaps between runs become a few spaces
function joinText(items) {
    let out = '';
    items.forEach((it, i) => {
        if (i) {
            const prev = items[i - 1];
            const gap = it.x - (prev.x + prev.width);
            if (gap > it.size * 0.15) out += ' '.repeat(Math.min(4, Math.max(1, Math.round(gap / (it.size * 0.5)))));
        }
        out += it.str;
    });
    return out.replace(/\s+$/, '');
}

export async function readPdfScore(doc) {
    const lines = [];
    let found = false;
    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const items = await pageItems(page);
        const rules = await pageRules(page);
        const notation = items.filter((it) => it.kind !== 'text');
        const notes = items.filter((it) => it.kind === 'notes');
        if (notes.length) found = true;
        if (lines.length) lines.push({ text: '', kind: 'text' });

        // monospace fonts: cell width from items without zero-width marks, grid starts at the left-most glyph
        const cellSamples = notation
            .filter((it) => ![...it.str].some((ch) => ZERO_WIDTH.has(ch)))
            .map((it) => it.width / it.str.length);
        const cell = cellSamples.length ? median(cellSamples) : 6;
        const x0 = notes.length ? Math.min(...items.filter((it) => it.kind === 'notes' || it.kind === 'garis').map((it) => it.x)) : 0;

        for (const row of addRules(groupRows(items), rules)) {
            if (row.rule) { lines.push({ text: '', kind: 'rule' }); continue; }
            const kinds = new Set(row.items.map((it) => it.kind));
            if (kinds.has('text') || !notation.length) {
                lines.push({ text: joinText(row.items), kind: 'text' });
                continue;
            }
            let rowItems = row.items;
            let label;
            // a voice name or verse number sits left of the grid, in the lyrics font
            const first = rowItems[0];
            if (rowItems.length > 1 && first.kind === 'lyrics' && first.x < x0 - cell / 2) {
                label = first.str.trim();
                rowItems = rowItems.slice(1);
            } else if (first.x >= x0 - cell / 2) {
                label = ''; // keeps the row in line with the labelled ones
            }
            const kind = kinds.has('notes') ? 'notes' : kinds.has('garis') ? 'garis' : 'lyrics';
            const line = { text: layoutRow(rowItems, x0, cell), kind };
            if (label !== undefined) line.label = label;
            lines.push(line);
        }
    }
    if (!lines.some((l) => l.label)) lines.forEach((l) => delete l.label); // no gutter without voice names
    return found ? lines : null;
}
