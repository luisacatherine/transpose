import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { readPdfScore } from './pdfText.js';
import { DEFAULT_SIZE, linesToDocx } from './docxExport.js';
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { analyzePage, readRow, layoutSystem } from './notation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer();

// created lazily so the language data only loads on the first image upload
let ocrWorker;
const getOcrWorker = () => (ocrWorker ??= createWorker('eng'));

// digits-only worker for numbered-notation lines
let digitWorker;
const getDigitWorker = () => (digitWorker ??= (async () => {
    const worker = await createWorker('eng');
    await worker.setParameters({
        tessedit_char_whitelist: '0123456789.-#b',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
    return worker;
})());

// reads one digit at a time, to tell digits from the "b" and "#" the line worker may misread them as
let glyphWorker;
const getGlyphWorker = () => (glyphWorker ??= (async () => {
    const worker = await createWorker('eng');
    await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: PSM.SINGLE_CHAR,
    });
    return worker;
})());

// single-line worker for the lyrics under a score; the language is set for Indonesian songs by default
const LYRICS_LANG = process.env.LYRICS_LANG || 'ind';
let lineWorker;
const getLineWorker = () => (lineWorker ??= (async () => {
    const worker = await createWorker(LYRICS_LANG);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    return worker;
})());

// the words (with boxes in original-image pixels) of the one text line between y0 and y1, right of x = left
async function recognizeLineWords(buffer, { width, height }, { y0, y1 }, left) {
    const LINE_SCALE = 2;
    const x = Math.max(0, Math.floor(left));
    const top = Math.max(0, Math.floor(y0) - 2);
    const crop = await sharp(buffer)
        .extract({ left: x, top, width: width - x, height: Math.min(height - top, Math.ceil(y1 - y0) + 4) })
        .resize({ width: (width - x) * LINE_SCALE })
        .grayscale()
        .png()
        .toBuffer();
    const worker = await getLineWorker();
    const { data } = await worker.recognize(crop, {}, { blocks: true });
    return (data.blocks ?? [])
        .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
        .map((w) => ({
            text: w.text,
            bbox: { x0: w.bbox.x0 / LINE_SCALE + x, x1: w.bbox.x1 / LINE_SCALE + x, y0: w.bbox.y0 / LINE_SCALE + top, y1: w.bbox.y1 / LINE_SCALE + top },
        }));
}

// Returns the lines of the page in reading order: ({ text, kind, label }), where kind is
// text | notes | garis | lyrics. Scores are found by shape (see notation.js); the rest is plain OCR.
async function recognizeImage(buffer) {
    const meta = await sharp(buffer).metadata();
    const page = await analyzePage(buffer);

    const worker = await getOcrWorker();
    const { data } = await worker.recognize(buffer, {}, { blocks: true });
    const textLines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));

    // plain text that isn't part of a score
    const items = [];
    for (const line of textLines) {
        const text = line.text.trim();
        const middle = (line.bbox.y0 + line.bbox.y1) / 2;
        if (!text || page.systems.some((s) => middle >= s.y0 - 4 && middle <= s.y1 + 4)) continue;
        items.push({ y: line.bbox.y0, lines: [{ text: fixBarLines(text), kind: 'text' }] });
    }

    const digits = await getDigitWorker();
    const ocrDigits = async (png) => (await digits.recognize(png)).data.text;
    const glyphWorker = await getGlyphWorker();
    const ocrGlyph = async (png) => (await glyphWorker.recognize(png)).data;
    const cell = (page.digitHeight * 0.6) / page.scale; // one character cell of the song fonts, in original pixels

    for (const system of page.systems) {
        const rows = [];
        for (const row of system.rows) {
            const result = await readRow(page, row, ocrDigits, ocrGlyph);
            if (result) rows.push(result);
        }
        if (!rows.length) continue;
        const words = system.lyrics ? await recognizeLineWords(buffer, meta, system.lyrics, system.left) : [];
        items.push({ y: system.y0, lines: layoutSystem(rows, words, cell) });
    }

    return items.sort((a, b) => a.y - b.y).flatMap((item) => item.lines);
}

const CHORD = /^[A-G][#b]?[a-z0-9()+#b-]*(\/[A-G][#b]?)?$/;
const BAR_LIKE = /[|Il!\[\]]/;

// OCR often reads bar lines "|" as 1, I, l, [ or ], sometimes glued to chords (e.g. "ICIGIAmIFI").
// On lines made up only of chords and bars, turn those characters back into "|".
function fixBarLines(text) {
    return text.split('\n').map((line) => {
        const fixed = line.replace(/\S+/g, (token) => {
            if (CHORD.test(token) || token === '%') return token;
            if (/^[|Il!1\[\]]+$/.test(token)) return '|';
            return token.split(BAR_LIKE).join(' | ').trim();
        });
        const tokens = fixed.split(/\s+/).filter(Boolean);
        const isChordLine = tokens.some((t) => CHORD.test(t)) &&
            tokens.every((t) => t === '|' || t === '%' || CHORD.test(t));
        return isChordLine ? fixed.replace(/\|(\s*\|)+/g, '|') : line;
    }).join('\n');
}

const PORT = process.env.PORT || 3001;

app.use(cors())
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../client')));
app.use('/fonts', express.static(path.join(__dirname, 'font')));

app.post('/generate-from-document', upload.single("document"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No document uploaded.' });

    const { mimetype, buffer } = req.file;

    try {
        if (mimetype === 'application/pdf') {
            const parser = new PDFParse({ data: new Uint8Array(buffer) });
            try {
                // scores typeset with the angka fonts carry exact characters in the text layer
                const embedded = await readPdfScore(await parser.load());
                if (embedded) return res.status(200).json({ text: embedded.filter((l) => l.kind !== 'rule').map((l) => l.text).join('\n').trim(), lines: embedded })

                // otherwise render each page and read it like an uploaded image
                const { pages } = await parser.getScreenshot({ desiredWidth: 2400, imageDataUrl: false });
                const lines = [];
                for (const page of pages) {
                    if (lines.length) lines.push({ text: '', kind: 'text' });
                    lines.push(...await recognizeImage(Buffer.from(page.data)));
                }
                return res.status(200).json({ text: lines.map((l) => l.text).join('\n').trim(), lines })
            } finally {
                await parser.destroy();
            }
        }

        if (mimetype.startsWith('image/')) {
            // notation lines use the adangka font's letters for octave dots, so the client styles them separately
            const lines = await recognizeImage(buffer);
            return res.status(200).json({ text: lines.map((l) => l.text).join('\n').trim(), lines })
        }

        res.status(415).json({ message: 'Unsupported file type. Please upload a PDF or an image.' })
    } catch (error) {
        res.status(500).json({ message: error.message })
    }
})
app.post('/export-docx', async (req, res) => {
    const { lines, fontSize = DEFAULT_SIZE } = req.body;
    if (!Array.isArray(lines)) return res.status(400).json({ message: 'No lines to export.' });
    if (!(fontSize >= 6 && fontSize <= 48)) return res.status(400).json({ message: 'Font size must be between 6 and 48.' });
    try {
        const buffer = await linesToDocx(lines, Number(fontSize));
        res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            .set('Content-Disposition', 'attachment; filename="score.docx"')
            .send(buffer);
    } catch (error) {
        res.status(500).json({ message: error.message })
    }
})

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
