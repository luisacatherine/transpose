# Transposer

Web app that converts scores in numbered notation ("angka", e.g. Puji Syukur / lagumisa.web.id) from a PDF or image into text typeset with the angka fonts, and exports it to Word. Transposing itself is not built yet. The user writes Indonesian; UI strings are English.

## Run

- `cd server && npm install && npm run dev` (nodemon) or `npm start`. Default port is `process.env.PORT || 3001`; use another `PORT=310x node index.js` for throwaway test servers and kill them afterwards.
- Open the app from the API port: the server serves `client/` statically and the fonts at `/fonts`. Don't use a separate static server.
- No test suite. Verify by uploading a score and comparing with the source (render the output lines with the song fonts to check alignment).
- Optional `server/.env` (gitignored) can set `PORT` and `LYRICS_LANG`. There is no LLM/API dependency; conversion is fully local.
- Tesseract downloads `eng`/`ind` models on first use (needs network) and caches `*.traineddata` in the working directory (gitignored).

## Layout

- `client/` (`index.html`, `styles.css`, `app.js`): plain JS, no build. Upload → "Convert to text" posts `document` to `/generate-from-document` → rows rendered from `data.lines`. "Save as Word" shows a font-size form and posts `{lines, fontSize}` to `/export-docx`.
- `server/index.js`: ESM (`"type": "module"`). Routes, image OCR orchestration (`recognizeImage`), plain-text bar-line fixer.
- `server/pdfText.js`: PDFs typeset with the angka fonts: reads the exact characters, positions and font names from the text layer (pdf.js via pdf-parse) and detects the horizontal rules from the drawing operators. Returns `null` for other PDFs, which then fall back to rendering each page and using the image pipeline.
- `server/notation.js`: image notation engine (`analyzePage`, `readRow`, `layoutSystem`): connected components, row/system detection, per-segment digit OCR, dots/dashes/beat lines/legato/sharp-flat detection, column grid layout.
- `server/docxExport.js`: `.docx` via the `docx` package; Narrow margins, size from the client.
- `server/font/`: adangka, adgaris, adhuruf, adsymbol `.ttf`.

## Output format

`lines` is a list of `{ text, kind, label? }`: kind is `text`, `notes` (adangka), `garis` (adgaris, beat lines and legato curves) or `lyrics` (adhuruf), plus `rule` (horizontal separator, empty text). `label` (voice name, verse number) renders in a gutter; `''` keeps an unlabelled row aligned with labelled ones. `text` (used by Copy) joins the lines without labels or rules.

All four fonts are equal width, so rows line up by character column. Mapping: dot below 1–7 → `a s d f g h j`; dot above → `q w e r t y u` (two dots on 1 → `i`); sharp `/` and flat `\` come before the note and take no width; beat lines `q`/`a`/`z` (single/double/triple); legato `2` start, `3` middle, `4` end (`5` end+restart is not implemented).

## Gotchas

- The image pipeline is tuned on a handful of scores (`037`, `041`, `182`, `347`-style SATB). Don't change thresholds or Tesseract settings without re-running those; known weak spots: watermarked lyrics, a `5` misread as `6`, legato curves touching digits, flats untested.
- Lyrics OCR language is `LYRICS_LANG` (default `ind`). Tesseract tuning for the watermarked lyrics is exhausted.
- Word output refers to the song fonts by name and does not embed them; they must be installed to display correctly.
- Not a git repo yet; the `.gitignore` is ready for `git init`.
