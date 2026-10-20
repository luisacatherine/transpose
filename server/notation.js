import sharp from 'sharp';

// Numbered notation (angka) scores: rows of digits separated by bar lines, with beat lines and
// legato curves, octave dots and sharps/flats, optionally stacked as voices (S, A, T, B) over a
// lyrics line. General-purpose OCR can't read the thin "|" bars or the layout, so the page is
// analysed by shape: bars are tall and very thin, digits share a common height, and rows of digits
// that bars run through are notation. The digits themselves are read with a digits-only OCR.

// adangka.ttf draws octave-dotted digits on keyboard letters: home row = dot below, top row = dot above
const OCTAVE_BELOW = { 1: 'a', 2: 's', 3: 'd', 4: 'f', 5: 'g', 6: 'h', 7: 'j' };
const OCTAVE_ABOVE = { 1: 'q', 2: 'w', 3: 'e', 4: 'r', 5: 't', 6: 'y', 7: 'u' };
const TWO_OCTAVES_ABOVE = { 1: 'i' };

// in adangka a "/" before a note makes it sharp and a "\" makes it flat
const SHARP = '/';
const FLAT = '\\';

// adgaris.ttf draws the lines: beat lines in a row above the notes, legato curves in a row below
const BEAT_LINE = ['q', 'a', 'z']; // single, double, triple
const LEGATO = { start: '2', middle: '3', end: '4' };

const VOICES = ['S', 'A', 'T', 'B'];

const MAX_SCALE = 3;
const MAX_WIDTH = 2400;
const BINARIZE_AT = 150; // also drops light-gray watermarks

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// 8-connected components of dark pixels
function findComponents(pixels, width, height) {
    const labels = new Int32Array(width * height);
    const stack = new Int32Array(width * height);
    const comps = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const start = y * width + x;
            if (pixels[start] >= 128 || labels[start]) continue;
            const comp = { id: comps.length + 1, x0: x, x1: x, y0: y, y1: y };
            let top = 0;
            stack[top++] = start;
            labels[start] = comp.id;
            while (top) {
                const p = stack[--top];
                const cx = p % width;
                const cy = (p / width) | 0;
                if (cx < comp.x0) comp.x0 = cx;
                if (cx > comp.x1) comp.x1 = cx;
                if (cy < comp.y0) comp.y0 = cy;
                if (cy > comp.y1) comp.y1 = cy;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = cx + dx;
                        const ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        const q = ny * width + nx;
                        if (labels[q] || pixels[q] >= 128) continue;
                        labels[q] = comp.id;
                        stack[top++] = q;
                    }
                }
            }
            comp.w = comp.x1 - comp.x0 + 1;
            comp.h = comp.y1 - comp.y0 + 1;
            comps.push(comp);
        }
    }
    return { labels, comps };
}

// Thin printing breaks glyphs into pieces (a "3" falls into three). Pieces that touch or nearly touch
// another glyph are joined into it; beat lines and bar lines are left alone, since they run close to digits.
function joinFragments(comps, labels, digitHeight) {
    const gap = digitHeight * 0.2;
    const isFlatish = (c) => c.h <= digitHeight * 0.2 && c.w >= c.h * 1.5;
    const isLine = (c) => isFlatish(c) || (c.w <= c.h * 0.2 && c.h >= digitHeight * 1.3);
    const parent = comps.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };

    const order = comps.map((_, i) => i).sort((a, b) => comps[a].x0 - comps[b].x0);
    for (let n = 0; n < order.length; n++) {
        const a = comps[order[n]];
        if (isLine(a)) continue;
        for (let m = n + 1; m < order.length; m++) {
            const b = comps[order[m]];
            if (b.x0 > a.x1 + gap) break;
            if (isLine(b)) continue;
            // a piece level with the glyph may sit a little way to its side; one above or below (an octave
            // dot, a curve) has to touch
            const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1);
            if (dy <= gap / 2) parent[find(order[m])] = find(order[n]);
        }
    }

    // pieces of one beat line: thin, at the same height, end to end (at least one of them clearly flat)
    const thin = order.filter((i) => comps[i].h <= digitHeight * 0.2);
    for (let n = 0; n < thin.length; n++) {
        const a = comps[thin[n]];
        for (let m = n + 1; m < thin.length; m++) {
            const b = comps[thin[m]];
            if (b.x0 > a.x1 + digitHeight * 0.35) break;
            if (!isFlatish(a) && !isFlatish(b)) continue;
            if (Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) <= digitHeight * 0.1) parent[find(thin[m])] = find(thin[n]);
        }
    }

    const merged = new Map();
    comps.forEach((c, i) => {
        const root = find(i);
        const m = merged.get(root);
        if (!m) merged.set(root, { id: c.id, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
        else {
            m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1);
            m.y0 = Math.min(m.y0, c.y0); m.y1 = Math.max(m.y1, c.y1);
        }
    });
    // labels keep their old ids: point every piece at the id of the glyph it joined
    const idOf = new Int32Array(comps.length + 1);
    comps.forEach((c, i) => { idOf[c.id] = merged.get(find(i)).id; });
    for (let i = 0; i < labels.length; i++) if (labels[i]) labels[i] = idOf[labels[i]];

    return [...merged.values()].map((c) => ({ ...c, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 }));
}

// A "0" (a rest) is a closed oval, which the OCR often can't read on its own: one enclosed hole, centered
function looksLikeZero(comp, labels, pageWidth) {
    const w = comp.w + 2;
    const h = comp.h + 2;
    if (comp.w / comp.h < 0.4 || comp.w / comp.h > 0.95) return false;
    const ink = (x, y) => labels[(comp.y0 + y - 1) * pageWidth + comp.x0 + x - 1] === comp.id;
    // background reachable from the border is outside; what's left over is a hole
    const outside = new Uint8Array(w * h);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
        const p = stack.pop();
        const x = p % w;
        const y = (p / w) | 0;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx;
            const onComp = nx >= 1 && ny >= 1 && nx <= comp.w && ny <= comp.h && ink(nx, ny);
            if (outside[q] || onComp) continue;
            outside[q] = 1;
            stack.push(q);
        }
    }
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 1; y <= comp.h; y++) {
        for (let x = 1; x <= comp.w; x++) {
            if (outside[y * w + x] || ink(x, y)) continue;
            area++; sumX += x; sumY += y;
        }
    }
    if (area < comp.w * comp.h * 0.1) return false;
    return Math.abs(sumX / area - (comp.w + 1) / 2) <= comp.w * 0.2 && Math.abs(sumY / area - (comp.h + 1) / 2) <= comp.h * 0.2;
}

// A sharp or flat can be drawn as a slash through the digit. The slash sticks out past the digit, so
// such a glyph is bigger than the others; the slash is the strongest oblique straight line in it:
// rising to the right ("/") for a sharp, falling ("\\") for a flat.
function findSlash(comp, labels, pageWidth) {
    const points = [];
    for (let y = comp.y0; y <= comp.y1; y++) {
        for (let x = comp.x0; x <= comp.x1; x++) if (labels[y * pageWidth + x] === comp.id) points.push([x, y]);
    }
    let best = { count: 0 };
    for (let deg = -70; deg <= 70; deg += 2) {
        if (Math.abs(deg) < 25) continue; // upright strokes and bars are not slashes
        const phi = (deg * Math.PI) / 180;
        const sin = Math.sin(phi);
        const cos = Math.cos(phi);
        const bins = new Map();
        for (const [x, y] of points) {
            const rho = Math.round(-x * sin + y * cos);
            bins.set(rho, (bins.get(rho) ?? 0) + 1);
        }
        for (const [rho, n] of bins) {
            const count = n + (bins.get(rho - 1) ?? 0) + (bins.get(rho + 1) ?? 0);
            if (count > best.count) best = { count, sin, cos, rho, kind: deg < 0 ? SHARP : FLAT };
        }
    }
    return best.count >= points.length * 0.12 ? best : null;
}

// Candidate digit heights: the peaks of the height distribution of glyph-shaped components
function heightCandidates(comps) {
    const counts = new Map();
    for (const c of comps) {
        const ratio = c.w / c.h;
        if (ratio < 0.25 || ratio > 1.2 || c.h < 10 || c.h > 90) continue;
        counts.set(c.h, (counts.get(c.h) ?? 0) + 1);
    }
    const smoothed = new Map();
    for (const h of counts.keys()) {
        smoothed.set(h, (counts.get(h - 1) ?? 0) + counts.get(h) + (counts.get(h + 1) ?? 0));
    }
    const most = Math.max(0, ...smoothed.values());
    return [...smoothed]
        .filter(([h, total]) => total >= most * 0.15 && total >= (smoothed.get(h - 1) ?? 0) && total >= (smoothed.get(h + 1) ?? 0))
        .map(([h]) => h);
}

const centerY = (c) => (c.y0 + c.y1) / 2;
const centerX = (c) => (c.x0 + c.x1) / 2;

// Rows of digit-sized glyphs that bar lines run through, for a given digit height
function detectRows(comps, dH) {
    const isBar = (c) => c.w <= dH * 0.5 && c.w <= c.h * 0.2 && c.h >= dH * 1.3;
    const bars = comps.filter(isBar);

    // rows of digit-sized glyphs, clustered by their vertical center
    const glyphs = comps
        .filter((c) => !isBar(c) && c.h >= dH * 0.75 && c.h <= dH * 1.3 && c.w / c.h >= 0.2 && c.w / c.h <= 1.3)
        .sort((a, b) => centerY(a) - centerY(b));
    const clusters = [];
    let current = [];
    for (const g of glyphs) {
        if (current.length && centerY(g) - centerY(current.at(-1)) > dH * 0.6) {
            clusters.push(current);
            current = [];
        }
        current.push(g);
    }
    if (current.length) clusters.push(current);

    // notation rows are the ones bar lines run through
    const barsAt = (cy) => bars.filter((b) => b.y0 <= cy + dH * 0.3 && b.y1 >= cy - dH * 0.3);
    const rows = clusters
        .map((members) => ({ members, cy: members.reduce((sum, m) => sum + centerY(m), 0) / members.length }))
        .filter((r) => r.members.length >= 5 && barsAt(r.cy).length >= 2);
    return { isBar, bars, barsAt, rows };
}

// Finds the notation systems on the page. Heights and widths in the result are in original-image pixels.
export async function analyzePage(imageBuffer) {
    const { width: origWidth } = await sharp(imageBuffer).metadata();
    const scale = Math.min(MAX_SCALE, MAX_WIDTH / origWidth);
    const { data: gray, info } = await sharp(imageBuffer)
        .resize({ width: Math.round(origWidth * scale) })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const pixels = gray.map((v) => (v < BINARIZE_AT ? 0 : 255));

    const { labels, comps: pieces } = findComponents(pixels, info.width, info.height);

    // the digit height is the candidate that yields the most notation (taller wins a tie)
    let digitHeight = 0;
    let best = 0;
    for (const h of heightCandidates(pieces).sort((a, b) => a - b)) {
        const found = detectRows(pieces, h).rows.reduce((sum, r) => sum + r.members.length, 0);
        if (found > 0 && found >= best) { best = found; digitHeight = h; }
    }
    const comps = digitHeight ? joinFragments(pieces, labels, digitHeight) : pieces;
    const page = { scale, gray, labels, comps, width: info.width, height: info.height, digitHeight, systems: [] };
    if (!digitHeight) return page;

    const dH = digitHeight;
    const { isBar, bars, barsAt, rows } = detectRows(comps, dH);
    page.isBar = isBar;
    page.bars = bars;

    // rows close together form one system (the voices of a score)
    const groups = [];
    for (const row of rows) {
        const last = groups.at(-1);
        if (last && row.cy - last.at(-1).cy <= dH * 3.2) last.push(row);
        else groups.push([row]);
    }

    page.systems = groups.map((systemRows, systemIndex) => {
        const nextSystemTop = groups[systemIndex + 1] ? groups[systemIndex + 1][0].cy - dH * 2 : Infinity;
        systemRows.forEach((row, i) => {
            const above = systemRows[i - 1];
            const below = systemRows[i + 1];
            row.top = Math.max(row.cy - dH * 1.7, above ? (above.cy + row.cy) / 2 : -Infinity);
            row.bottom = Math.min(row.cy + dH * 1.4, below ? (below.cy + row.cy) / 2 : Infinity);
        });

        // voice labels (S, A, T, B): a column left of the first bar line, aligned across the rows
        const lefts = systemRows.map((r) => Math.min(...r.members.map((m) => m.x0)));
        const firstBar = Math.min(...systemRows.flatMap((r) => barsAt(r.cy).map((b) => b.x0)));
        const leftmost = Math.min(...lefts);
        // (only stacked voices have them: a lone row whose first measure is long would look like one)
        const hasLabels = systemRows.length > 1 && lefts.every((x) => x <= leftmost + dH * 1.2) && firstBar - leftmost >= dH * 3.3;
        const labelEdge = leftmost + dH * 1.2;
        systemRows.forEach((row, i) => {
            row.label = hasLabels ? (systemRows.length === VOICES.length ? VOICES[i] : '') : null;
            row.isLabel = (c) => hasLabels && c.x0 <= labelEdge;
        });

        // the lyrics sit just under the last row: the glyphs in that strip, if any
        const lastRow = systemRows.at(-1);
        const lyricGlyphs = comps.filter(
            (c) => !isBar(c) && c.h <= dH * 1.3 && centerY(c) >= lastRow.cy + dH * 1.4 && centerY(c) <= Math.min(lastRow.cy + dH * 3.4, nextSystemTop),
        );
        const lyrics = lyricGlyphs.length >= 3
            ? { y0: Math.min(...lyricGlyphs.map((c) => c.y0)), y1: Math.max(...lyricGlyphs.map((c) => c.y1)) }
            : null;

        // the brace in front of the system, if any: text to its right is the system's
        const braces = comps.filter(
            (c) => !isBar(c) && c.h >= dH * 2.5 && c.x1 < leftmost && c.y0 <= (lyrics ? lyrics.y1 : lastRow.bottom) && c.y1 >= systemRows[0].top,
        );
        const left = braces.length ? Math.max(...braces.map((c) => c.x1)) + 2 : 0;

        return {
            rows: systemRows,
            left: left / scale,
            lyrics: lyrics && { y0: lyrics.y0 / scale, y1: lyrics.y1 / scale },
            y0: systemRows[0].top / scale,
            y1: (lyrics ? lyrics.y1 : lastRow.bottom) / scale,
        };
    });
    return page;
}

// Reads one notation row. ocr(buffer) recognizes a digits-only line; ocrGlyph(buffer) a single
// digit and returns { text, confidence }.
// Returns the tokens and lines found on the page (see layoutSystem), or null when nothing can be read.
export async function readRow(page, row, ocr, ocrGlyph) {
    const { scale, gray, labels, comps, width: pageWidth, digitHeight: dH } = page;
    const top = Math.max(0, Math.floor(row.top));
    const bottom = Math.min(page.height, Math.ceil(row.bottom));
    const bandHeight = bottom - top;

    const inBand = comps.filter((c) => !page.isBar(c) && centerY(c) >= top && centerY(c) <= bottom && c.h <= dH * 1.3 && !row.isLabel(c));
    const digitLike = row.members.filter((c) => !row.isLabel(c));
    if (!digitLike.length) return null;

    const digitHeight = median(digitLike.map((c) => c.h));
    const digitTop = median(digitLike.map((c) => c.y0));
    const digitBottom = median(digitLike.map((c) => c.y1));
    const above = (c) => centerY(c) < digitTop;
    const below = (c) => centerY(c) > digitBottom;
    const outsideDigits = (c) => above(c) || below(c);

    const isFlat = (c) => c.h <= digitHeight * 0.25 && c.w >= c.h * 1.5;
    const isOctaveDot = (c) => c.h <= digitHeight * 0.35 && c.w <= c.h * 1.6 && outsideDigits(c);
    // legato curves are wide, low arcs under the digits
    const isCurve = (c) => below(c) && c.w >= digitHeight * 1.2 && c.w >= c.h * 2.5 && c.h <= digitHeight * 0.6;
    // decorations around the digits: beat lines above, legato curves below, octave dots above/below
    const isDecoration = (c) => outsideDigits(c) && (isOctaveDot(c) || isFlat(c) || isCurve(c) || c.h <= digitHeight * 0.35);

    const dots = inBand.filter(isOctaveDot);
    const beatLines = inBand.filter((c) => isFlat(c) && above(c) && !isOctaveDot(c));
    const legatoCurves = inBand.filter(isCurve);
    const marks = inBand.filter((c) => !isDecoration(c));
    if (!marks.length) return null;

    // the bar lines that run through this row, merged when adjacent (double bar line)
    const bars = page.bars
        .filter((b) => b.y0 <= row.cy + dH * 0.3 && b.y1 >= row.cy - dH * 0.3 && !row.isLabel(b))
        .sort((a, b) => a.x0 - b.x0);
    const barGroups = [];
    for (const bar of bars) {
        const last = barGroups.at(-1);
        if (last && bar.x0 - last.x1 <= digitHeight * 0.5) {
            last.x1 = bar.x1;
            last.count++;
        } else {
            barGroups.push({ x0: bar.x0, x1: bar.x1, count: 1 });
        }
    }

    // digits with a slash through them (sharp / flat): bigger than the rest, with a straight oblique line
    const digitWidth = median(digitLike.map((c) => c.w));
    const slashed = new Map();
    for (const c of marks) {
        if (c.h < digitHeight * 1.07 || c.w < digitWidth * 1.08) continue;
        const slash = findSlash(c, labels, pageWidth);
        if (slash) slashed.set(c.id, slash);
    }

    const withOctave = (digit, glyph) => {
        const center = centerX(glyph);
        const near = dots.filter((d) => Math.abs(centerX(d) - center) <= Math.max(glyph.w, digitHeight * 0.5));
        const upper = near.filter((d) => above(d)).length;
        const lower = near.length - upper;
        if (upper >= 2 && TWO_OCTAVES_ABOVE[digit]) return TWO_OCTAVES_ABOVE[digit];
        if (upper) return OCTAVE_ABOVE[digit] ?? digit;
        if (lower) return OCTAVE_BELOW[digit] ?? digit;
        return digit;
    };

    // an image of just the given glyphs, taken from the original gray pixels (thresholding loses thin strokes)
    const render = async (glyphs, left, width) => {
        const image = Buffer.alloc(width * bandHeight, 255);
        const pad = 2;
        for (const c of glyphs) {
            const slash = slashed.get(c.id);
            for (let y = Math.max(top, c.y0 - pad); y <= Math.min(bottom - 1, c.y1 + pad); y++) {
                for (let x = Math.max(left, c.x0 - pad); x <= Math.min(left + width - 1, c.x1 + pad); x++) {
                    // leave the slash out so the digit under it can be read
                    if (slash && Math.abs(-x * slash.sin + y * slash.cos - slash.rho) <= 2.5) continue;
                    image[(y - top) * width + (x - left)] = gray[y * pageWidth + x];
                }
            }
        }
        return sharp(image, { raw: { width, height: bandHeight, channels: 1 } })
            .extend({ top: 30, bottom: 30, left: 30, right: 30, background: '#fff' })
            .png()
            .toBuffer();
    };

    // tokens carry the x range of their glyph on the page (when known) so the rows can be aligned
    const readSegment = async (from, to) => {
        const inSegment = marks.filter((c) => c.x0 >= from && c.x1 < to);
        if (!inSegment.length) return [];
        const left = Math.floor(from);
        const chars = (await ocr(await render(inSegment, left, Math.max(1, Math.floor(to) - left)))).replace(/\s/g, '').split('');
        const keep = new Set(inSegment.map((c) => c.id));

        const glyphs = marks.filter((c) => keep.has(c.id)).sort((a, b) => a.x0 - b.x0);
        const isDigit = (ch) => /\d/.test(ch);

        // dots and dashes are told by their shape; the OCR supplies the characters of the other glyphs
        const kindOf = (c) => (isFlat(c) ? '-' : c.h <= digitHeight * 0.35 ? '.' : 'glyph');
        const solid = glyphs.filter((c) => kindOf(c) === 'glyph');
        const readChars = chars.filter((ch) => ch !== '.' && ch !== '-');

        let tokens;
        if (solid.length === readChars.length) {
            let next = 0;
            tokens = glyphs.map((glyph) => {
                const kind = kindOf(glyph);
                const text = kind === 'glyph' ? readChars[next++] : kind;
                return { text, x0: glyph.x0, x1: glyph.x1, glyph, prefix: slashed.get(glyph.id)?.kind };
            });
        } else {
            // the line reading doesn't match the glyphs on the page: read them one at a time instead
            tokens = [];
            for (const glyph of glyphs) {
                const kind = kindOf(glyph);
                let text = kind === 'glyph' ? null : kind;
                if (!text && glyph.h >= digitHeight * 0.6) {
                    const { text: digit, confidence } = await ocrGlyph(await render([glyph], Math.floor(glyph.x0) - 4, glyph.w + 8));
                    if (/^\d$/.test(digit.trim()) && confidence >= 50) text = digit.trim();
                    else if (looksLikeZero(glyph, labels, pageWidth)) text = '0';
                }
                if (text) tokens.push({ text, x0: glyph.x0, x1: glyph.x1, glyph, prefix: slashed.get(glyph.id)?.kind });
            }
        }
        for (const t of tokens) t.isNote = isDigit(t.text);

        // the OCR reads sharp and flat signs as "#" and "b", but it also mistakes a 5 or 6 for a "b":
        // a digit-only reading of the glyph settles which it is
        for (const t of tokens) {
            if ((t.text !== '#' && t.text !== 'b') || !t.glyph) continue;
            const { text, confidence } = await ocrGlyph(await render([t.glyph], Math.floor(t.glyph.x0) - 4, t.glyph.w + 8));
            if (/^\d$/.test(text.trim()) && confidence >= 70) {
                t.text = text.trim();
                t.isNote = true;
            }
        }
        for (const t of tokens) {
            if (t.glyph && t.isNote && /^\d$/.test(t.text)) t.text = withOctave(t.text, t.glyph);
        }

        // attach sharp and flat signs to the note after them
        const notes = [];
        tokens.forEach((t, i) => {
            if (t.text !== '#' && t.text !== 'b') return notes.push(t);
            const note = tokens[i + 1];
            if (!note?.isNote) return; // stray mark, not an accidental
            note.prefix = t.text === '#' ? SHARP : FLAT; // zero-width in the font, so it shares the note's cell
            if (t.x0 !== undefined && note.x0 !== undefined) note.x0 = Math.min(note.x0, t.x0);
        });
        return notes;
    };

    const tokens = [];
    let from = 0;
    for (const group of barGroups) {
        tokens.push(...(await readSegment(from, group.x0)));
        tokens.push({ text: '|'.repeat(group.count), x0: group.x0, x1: group.x1 });
        from = group.x1 + 1;
    }
    tokens.push(...(await readSegment(from, pageWidth)));
    if (!tokens.length) return null;

    // hand everything over in original-image pixels; layoutSystem turns it into columns
    const toPixels = (c) => ({ x0: c.x0 / scale, x1: c.x1 / scale });
    for (const t of tokens) {
        if (t.x0 === undefined) continue;
        t.x0 /= scale;
        t.x1 /= scale;
    }
    return {
        label: row.label,
        tokens,
        beatLines: beatLines.map(toPixels),
        legatoCurves: legatoCurves.map(toPixels),
    };
}

// "so-rak-so-rai" -> "so-", "rak-", "so-", "rai", each with its estimated x position
function splitSyllables(word, wordIndex) {
    const width = word.bbox.x1 - word.bbox.x0;
    const parts = word.text.match(/[^-]+-?|-/g) ?? [word.text];
    let offset = 0;
    return parts.map((text) => {
        const x = word.bbox.x0 + (offset / word.text.length) * width;
        offset += text.length;
        return { text, x, wordIndex };
    });
}

const put = (row, start, text) => {
    for (let i = 0; i < text.length; i++) row[start + i] = text[i];
};

// Lays the voices of a system and their lyrics out on one character grid so that every row lines up.
// rows: results of readRow; lyricWords: OCR words ({ text, bbox }) of the line under the notes;
// cell: the width of one character cell in original pixels. Returns lines ({ text, kind, label }).
export function layoutSystem(rows, lyricWords, cell) {
    // words left of the first note are the brace and the row's label ("K", "U"), not lyrics
    const notesLeft = Math.min(...rows.flatMap((r) => r.tokens.filter((t) => t.x0 !== undefined).map((t) => t.x0)));
    const leading = lyricWords.filter((w) => w.bbox.x1 < notesLeft - cell * 0.5);
    const words = lyricWords.filter((w) => !leading.includes(w));
    const lyricLabel = leading.map((w) => w.text).find((text) => /^[KU]$/.test(text)) ?? '';
    const syllables = words.flatMap(splitSyllables);

    const xs = [
        ...rows.flatMap((r) => r.tokens.filter((t) => t.x0 !== undefined).map((t) => t.x0)),
        ...syllables.map((s) => s.x),
    ];
    const originX = xs.length ? Math.min(...xs) : 0;
    const columnOf = (x) => Math.max(0, Math.round((x - originX) / cell));

    const lines = [];
    for (const row of rows) {
        const { tokens, beatLines, legatoCurves } = row;

        // notes: at the column of their x position, never touching the previous token
        let next = 0;
        for (const t of tokens) {
            t.start = Math.max(t.x0 === undefined ? 0 : columnOf(t.x0), next);
            t.end = t.start + t.text.length - 1;
            next = t.end + 2;
        }
        const width = (tokens.at(-1)?.end ?? 0) + 1;
        const blank = () => new Array(width).fill(' ');

        const notes = blank();
        for (const t of tokens) {
            put(notes, t.start, t.text);
            if (t.prefix) notes[t.start] = t.prefix + notes[t.start];
        }

        // tokens under a horizontal span, as a column range
        // (a curve ends between its notes rather than on them, so it gets more room than a beat line)
        const columnsUnder = (c, reach = cell) => {
            const hit = tokens.filter((t) => t.x0 !== undefined && (t.x0 + t.x1) / 2 >= c.x0 - reach && (t.x0 + t.x1) / 2 <= c.x1 + reach);
            return hit.length ? { from: hit[0].start, to: hit.at(-1).end, count: hit.length } : null;
        };

        const beatLevels = new Array(width).fill(0);
        for (const line of beatLines) {
            const span = columnsUnder(line);
            if (span) for (let col = span.from; col <= span.to; col++) beatLevels[col]++;
        }
        const beats = beatLevels.map((n) => (n ? BEAT_LINE[Math.min(n, BEAT_LINE.length) - 1] : ' '));

        const legato = blank();
        for (const curve of legatoCurves) {
            const span = columnsUnder(curve, cell * 1.5);
            if (!span || span.count < 2) continue;
            for (let col = span.from; col <= span.to; col++) legato[col] = LEGATO.middle;
            legato[span.from] = LEGATO.start;
            legato[span.to] = LEGATO.end;
        }

        const text = (chars) => chars.join('').trimEnd();
        // beat lines (adgaris) above the notes (adangka), legato curves (adgaris) below
        if (text(beats)) lines.push({ text: text(beats), kind: 'garis', label: '' });
        lines.push({ text: text(notes), kind: 'notes', label: row.label ?? '' });
        if (text(legato)) lines.push({ text: text(legato), kind: 'garis', label: '' });
    }

    const lyrics = [];
    let next = 0;
    syllables.forEach((s, i) => {
        // syllables of one word stay together, separate words keep a space between them
        const sameWord = i > 0 && syllables[i - 1].wordIndex === s.wordIndex;
        const start = Math.max(columnOf(s.x), next + (sameWord || i === 0 ? 0 : 1));
        lyrics.push({ start, text: s.text });
        next = start + s.text.length;
    });
    if (lyrics.length) {
        const row = new Array(next).fill(' ');
        for (const slot of lyrics) put(row, slot.start, slot.text);
        lines.push({ text: row.join('').trimEnd(), kind: 'lyrics', label: lyricLabel });
    }
    return lines;
}
