# Transposer

Web app that converts scores in numbered notation ("angka", e.g. Puji Syukur / lagumisa.web.id) from a PDF or image into text typeset with the angka fonts, and exports it to Word. Transposing itself is not built yet. The user writes Indonesian; UI strings are English.

## Run

- `cd server && npm install && npm run dev` (nodemon) or `npm start`. Default port is `process.env.PORT || 3001`; use another `PORT=310x node index.js` for throwaway test servers and kill them afterwards.
- Open the app from the API port: the server serves `client/` statically and the fonts at `/fonts`. Don't use a separate static server.
- No test suite. Verify by uploading a score and comparing with the source (render the output lines with the song fonts to check alignment).
- Optional `server/.env` (gitignored) can set `PORT` and `LYRICS_LANG`. There is no LLM/API dependency; conversion is fully local.
- Tesseract downloads `eng`/`ind` models on first use (needs network) and caches `*.traineddata` in the working directory (gitignored).

## Layout

- `client/` (`index.html`, `styles.css`, `app.js`, `glyphs.js`): plain JS, native ES modules, no build. Upload → "Convert to text" posts `document` to `/generate-from-document` → rows rendered from `data.lines` (`renderLines`). A Font dropdown (aa/ab/ac/ad) re-renders in the chosen set. "Save as Word" shows a font-size form and posts `{lines, fontSize, fontSet}` to `/export-docx`. `glyphs.js` is also imported by the server. `transpose.js` (pure, no DOM) backs the From/To root dropdowns next to Convert: `currentLines()` returns the score transposed and feeds the panel, Copy and Word export. The keys come only from the user's choice; nothing is read from the score's text.
- `server/index.js`: ESM (`"type": "module"`). Routes, image OCR orchestration (`recognizeImage`), plain-text bar-line fixer, `hasNotation` (rejects non-scores with a 422: needs ≥4 note characters) and `padSystems` (see Output format).
- `server/pdfText.js`: PDFs typeset with the angka fonts: reads the exact characters, positions and font names from the text layer (pdf.js via pdf-parse) and detects the horizontal rules from the drawing operators, and converts aa/ab/ac sharp/flat capitals back to the `ad` spelling. Returns `null` for other PDFs, which then fall back to rendering each page and using the image pipeline.
- `server/notation.js`: image notation engine (`analyzePage`, `readRow`, `layoutSystem`): connected components, row/system detection, per-segment digit OCR, dots/dashes/beat lines/legato/sharp-flat detection, column grid layout.
- `server/docxExport.js`: `.docx` via the `docx` package; Narrow margins, font size and font set from the client (default 12 pt, `ad`; size 6–48). Row line height scales with the size.
- `server/font/`: the four font sets as `.ttf`: `ad*` (adangka, adgaris, adhuruf, adsymbol) and `AA-`/`AB-`/`AC-` files (ANGKA, HURUF, SYMBOL; the beat-line font for ab and ac is `AA-GARIS`/`AB-GARIS`, both family `aagaris`). Served at `/fonts`; CSS `@font-face` families are `aaangka`, `aagaris`, … in `client/styles.css`.

## Output format

`lines` is a list of `{ text, kind, label? }`: kind is `text`, `notes` (adangka), `garis` (adgaris, beat lines and legato curves) or `lyrics` (adhuruf), plus `rule` (horizontal separator, empty text). `label` (voice name, verse number) renders in a gutter; `''` keeps an unlabelled row aligned with labelled ones. `text` (used by Copy) joins the lines without labels or rules. `padSystems` makes systems consistent: every `notes` row has a `garis` row above and below it, blank (`text: ''`, `label: ''` when labelled) when the score has no beat line or legato there.

All fonts within a set are equal width (0.5em for `ad`, 0.603em for `aa`/`ab`/`ac`), so rows line up by character column. Mapping: dot below 1–7 → `a s d f g h j`; dot above → `q w e r t y u` (two dots on 1 → `i`); sharp `/` and flat `\` come before the note and take no width; beat lines `q`/`a`/`z` (single/double/triple); legato `2` start, `3` middle, `4` end (`5` end+restart is not implemented).

Font sets `aa`/`ab`/`ac`/`ad` (dropdown + Word export): all server output uses the `ad` spelling. The aa/ab/ac note fonts have no `/` `\` signs; each sharp/flat note is a single capital or symbol (`client/glyphs.js`: `!`=1#, `$`=4#, `%`=5#, `&`=7b, `A`=1# dot below, …). `glyphs.js` converts to the set on display and in the Word export, and back when reading aa/ab/ac PDFs. Flats other than 7 and sharp 3 have no glyph in those fonts. They have no `-` either.

Transposing (`client/transpose.js`): digits are read as major-scale degrees and shifted by the shortest semitone distance from root to destination (−5…+6); results on black keys are written as sharps (`/`) because aa/ab/ac have no flat glyphs; octave dots follow the shift (two dots above only exist on 1, two below don't exist, so those clamp). It maps each cell (accidental + note) to one cell, so columns stay aligned. Only `notes` rows change; the heading text (e.g. `Do=G`) is left as is.

## Gotchas

- The image pipeline is tuned on a handful of scores (`037`, `041`, `182`, `347`-style SATB). Don't change thresholds or Tesseract settings without re-running those; known weak spots: watermarked lyrics, a `5` misread as `6`, legato curves touching digits, flats untested.
- Lyrics OCR language is `LYRICS_LANG` (default `ind`). Tesseract tuning for the watermarked lyrics is exhausted.
- Word output refers to the song fonts by name and does not embed them; they must be installed to display correctly.
- Repo: github.com/luisacatherine/transpose (`main`, public, fonts included). Commit/push only when asked.
- Not a score → 422 `No numbered notation found…`; the client shows it as `Error: …`. A very short score (<4 notes) is rejected too.
