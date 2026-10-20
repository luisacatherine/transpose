import { toSet } from './glyphs.js';
import { KEYS, transposeLines } from './transpose.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const errorEl = document.getElementById('error');
const viewerSection = document.getElementById('viewer-section');
const viewer = document.getElementById('viewer');
const fileNameEl = document.getElementById('file-name');
const clearBtn = document.getElementById('clear-btn');

const convertBtn = document.getElementById('convert-btn');
const copyBtn = document.getElementById('copy-btn');
const wordBtn = document.getElementById('word-btn');
const fontChoice = document.getElementById('font-choice');
const fontSet = document.getElementById('font-set');
const wordOptions = document.getElementById('word-options');
const wordSize = document.getElementById('word-size');
const keyFrom = document.getElementById('key-from');
const keyTo = document.getElementById('key-to');
const resultSection = document.getElementById('result-section');
const resultStatus = document.getElementById('result-status');
const resultText = document.getElementById('result-text');

let currentUrl = null;
let currentFile = null;
let extractedLines = [];

for (const select of [keyFrom, keyTo]) {
  select.append(new Option('—', ''));
  for (const { value, name } of KEYS) select.append(new Option(name, value));
}

// the score with the chosen transposition applied; unchanged while either key is unset
function currentLines() {
  const key = (select) => (select.value === '' ? '' : Number(select.value));
  return transposeLines(extractedLines, key(keyFrom), key(keyTo));
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function clearViewer() {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  currentFile = null;
  resultSection.hidden = true;
  viewer.replaceChildren();
  viewerSection.hidden = true;
  fileInput.value = '';
}

function showFile(file) {
  const isPdf = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPdf && !isImage) {
    showError('Unsupported file type. Please upload a PDF or an image.');
    return;
  }

  showError('');
  clearViewer();
  currentFile = file;
  currentUrl = URL.createObjectURL(file);

  let el;
  if (isPdf) {
    el = document.createElement('iframe');
    el.title = file.name;
  } else {
    el = document.createElement('img');
    el.alt = file.name;
  }
  el.src = currentUrl;

  viewer.appendChild(el);
  fileNameEl.textContent = file.name;
  viewerSection.hidden = false;
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) showFile(fileInput.files[0]);
});

dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

['dragenter', 'dragover'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) showFile(file);
});

clearBtn.addEventListener('click', clearViewer);

// the song fonts reuse ordinary letters, so each kind of row gets its own font
function renderLines() {
  resultText.replaceChildren(...currentLines().map(({ text, kind, label }) => {
    const row = document.createElement('div');
    row.className = `row ${kind}`; // notes: adangka, garis: adgaris, lyrics: adhuruf
    if (label !== undefined) {
      // rows of a score: voice (S, A, T, B) or lyrics (K, U) label in a gutter beside the row
      const tag = document.createElement('span');
      tag.className = 'label';
      tag.textContent = label;
      row.append(tag);
    }
    const line = document.createElement('span');
    line.textContent = (kind === 'notes' ? toSet(text, fontSet.value) : text) || '\u00a0';
    row.append(line);
    return row;
  }));
  resultText.dataset.font = fontSet.value;
}

async function convertToText() {
  if (!currentFile) return;
  const file = currentFile;

  resultSection.hidden = false;
  resultStatus.textContent = 'Converting…';
  resultStatus.hidden = false;
  resultText.hidden = true;
  copyBtn.hidden = true;
  wordBtn.hidden = true;
  fontChoice.hidden = true;
  wordOptions.hidden = true;
  convertBtn.disabled = true;

  const body = new FormData();
  body.append('document', file);

  try {
    const res = await fetch('/generate-from-document', { method: 'POST', body });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!isJson) {
      throw new Error(
        `Server returned an unexpected response (${res.status}). ` +
        'Make sure the API server is running (cd server && node index.js) and open the app from it.'
      );
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Conversion failed.');
    if (file !== currentFile) return; // file was replaced or removed meanwhile

    const lines = data.lines ?? data.text.split('\n').map((text) => ({ text, kind: 'text' }));
    extractedLines = lines;
    renderLines();
    resultText.dataset.font = fontSet.value;
    resultText.hidden = false;
    resultStatus.hidden = true;
    copyBtn.hidden = false;
    wordBtn.hidden = false;
    fontChoice.hidden = false;
  } catch (err) {
    if (file !== currentFile) return;
    resultStatus.textContent = `Error: ${err.message}`;
  } finally {
    convertBtn.disabled = false;
  }
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(
      currentLines().filter((l) => l.kind !== 'rule').map((l) => l.text).join('\n').trim(),
    );
    copyBtn.textContent = 'Copied!';
  } catch {
    copyBtn.textContent = 'Copy failed';
  }
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
}

async function saveAsWord(event) {
  event.preventDefault();
  wordBtn.disabled = true;
  try {
    const res = await fetch('/export-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: currentLines(), fontSize: Number(wordSize.value), fontSet: fontSet.value }),
    });
    if (!res.ok) throw new Error((await res.json()).message || `HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(currentFile?.name || 'score').replace(/\.[^.]+$/, '')}.docx`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    wordBtn.textContent = 'Save failed';
    setTimeout(() => (wordBtn.textContent = 'Save as Word'), 2000);
  } finally {
    wordBtn.disabled = false;
  }
}

convertBtn.addEventListener('click', convertToText);
fontSet.addEventListener('change', renderLines);
for (const select of [keyFrom, keyTo]) select.addEventListener('change', () => extractedLines.length && renderLines());
wordBtn.addEventListener('click', () => {
  wordOptions.hidden = !wordOptions.hidden;
  if (!wordOptions.hidden) wordSize.focus();
});
wordOptions.addEventListener('submit', saveAsWord);
copyBtn.addEventListener('click', copyText);
