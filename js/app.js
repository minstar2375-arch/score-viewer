import * as db from './db.js';
import { loadPdf, makeThumbnail } from './pdf.js';
import { toast, confirmDialog, promptDialog, initDialog } from './ui.js';
import { initViewer, openViewer, closeViewer } from './viewer.js';
import { initPiano, closePiano } from './piano.js';
import { initRecorder, closeRecorder, setRecorderScore } from './recorder.js';
import { initPractice, closePractice, setPracticeScore } from './practice.js';

const $ = (id) => document.getElementById(id);
const libraryEl = $('library');
const viewerEl = $('viewer');
const gridEl = $('grid');
const emptyEl = $('empty');
const noResultEl = $('noResult');
const searchEl = $('search');
const fileInput = $('fileInput');

let thumbUrls = [];

const SORT_KEY = 'score-viewer:sort';
const SORTERS = {
  recent: (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
  name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }),
};
let sortMode = 'recent';
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (saved in SORTERS) sortMode = saved;
} catch { /* 기본값을 씁니다 */ }

function refreshSortButtons() {
  for (const btn of document.querySelectorAll('[data-sort]')) {
    btn.setAttribute('aria-pressed', btn.dataset.sort === sortMode);
  }
}

function setSort(mode) {
  sortMode = mode;
  try { localStorage.setItem(SORT_KEY, mode); } catch { /* 이번 실행에만 적용됩니다 */ }
  refreshSortButtons();
  renderLibrary();
}

const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function scoreCard(score) {
  const card = document.createElement('article');
  card.className = 'card';

  const open = document.createElement('a');
  open.className = 'card-open';
  open.href = `#/score/${encodeURIComponent(score.id)}`;

  const frame = document.createElement('div');
  frame.className = 'thumb';
  if (score.thumb) {
    const img = document.createElement('img');
    const url = URL.createObjectURL(score.thumb);
    thumbUrls.push(url);
    img.src = url;
    img.alt = '';
    frame.append(img);
  }

  const title = document.createElement('h2');
  title.textContent = score.name;

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = score.lastPage > 1
    ? `${score.lastPage} / ${score.pageCount}쪽`
    : `${score.pageCount}쪽`;

  open.append(frame, title, meta);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'card-more';
  more.setAttribute('aria-label', `${score.name} 메뉴`);
  more.setAttribute('aria-haspopup', 'menu');
  more.append(icon('more'));

  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const makeItem = (label, handler, danger = false) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    if (danger) btn.className = 'danger';
    btn.addEventListener('click', () => {
      closeCardMenus();
      handler();
    });
    return btn;
  };
  menu.append(
    makeItem('이름 바꾸기', () => renameScore(score)),
    makeItem('삭제', () => removeScore(score), true),
  );
  more.addEventListener('click', () => {
    const wasOpen = !menu.hidden;
    closeCardMenus();
    menu.hidden = wasOpen;
  });

  card.append(open, more, menu);
  return card;
}

function closeCardMenus() {
  for (const menu of document.querySelectorAll('.card-menu')) menu.hidden = true;
}

async function renderLibrary() {
  const scores = await db.listScores();
  scores.sort(SORTERS[sortMode]);
  $('sortBar').hidden = scores.length === 0;
  const query = searchEl.value.trim().toLowerCase();
  const shown = query ? scores.filter((s) => s.name.toLowerCase().includes(query)) : scores;

  thumbUrls.forEach(URL.revokeObjectURL);
  thumbUrls = [];
  gridEl.replaceChildren(...shown.map(scoreCard));
  emptyEl.hidden = scores.length > 0;
  noResultEl.hidden = !(scores.length > 0 && shown.length === 0);
  searchEl.hidden = scores.length === 0;
}

async function renameScore(score) {
  const name = await promptDialog({ title: '이름 바꾸기', ok: '저장', value: score.name });
  if (!name || name === score.name) return;
  const current = await db.getScore(score.id);
  if (!current) return;
  await db.putScore({ ...current, name });
  await renderLibrary();
}

async function removeScore(score) {
  const yes = await confirmDialog({
    title: '악보를 삭제할까요?',
    message: `"${score.name}"와 이 악보에 쓴 필기가 모두 지워지며, 되돌릴 수 없습니다.`,
    ok: '삭제',
    danger: true,
  });
  if (!yes) return;
  await db.deleteScore(score.id);
  await renderLibrary();
  toast('삭제했습니다.');
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

// 이름은 바뀔 수 있으므로 내용으로 비교합니다. 크기가 같은 악보만 열어 봅니다.
async function findSameFile(data, existing) {
  for (const score of existing) {
    if (score.size !== data.byteLength) continue;
    const stored = await db.getFile(score.id);
    if (stored && sameBytes(stored, data)) return score;
  }
  return null;
}

async function importOne(file, existing) {
  const name = file.name.replace(/\.pdf$/i, '');
  const data = await file.arrayBuffer();
  const same = await findSameFile(data, existing);
  if (same) return { duplicateOf: same.name };

  const doc = await loadPdf(data);
  try {
    const score = {
      id: newId(),
      name,
      size: file.size,
      pageCount: doc.numPages,
      lastPage: 1,
      addedAt: Date.now(),
      thumb: await makeThumbnail(doc),
    };
    await db.addScore(score, data);
    existing.push(score);
    return {};
  } finally {
    await doc.destroy();
  }
}

function importErrorText(err, fileName) {
  if (err?.name === 'PasswordException') return `"${fileName}"은 암호가 걸려 있어 열 수 없습니다.`;
  if (err?.name === 'QuotaExceededError') return '저장 공간이 부족해 추가하지 못했습니다.';
  return `"${fileName}"은 PDF로 읽을 수 없습니다.`;
}

async function importFiles(fileList) {
  const files = [...fileList];
  const pdfs = files.filter(isPdf);
  if (!pdfs.length) {
    if (files.length) toast('PDF 파일만 추가할 수 있습니다.');
    return;
  }

  const existing = await db.listScores();
  let added = 0;
  const duplicates = [];
  const errors = [];
  for (const [i, file] of pdfs.entries()) {
    toast(pdfs.length > 1 ? `악보 추가 중… (${i + 1}/${pdfs.length})` : '악보 추가 중…', { sticky: true });
    try {
      const result = await importOne(file, existing);
      if (result.duplicateOf) duplicates.push(result.duplicateOf);
      else added += 1;
    } catch (err) {
      console.error(err);
      errors.push(importErrorText(err, file.name));
    }
  }
  await renderLibrary();

  const messages = [...errors];
  if (added) messages.push(`악보 ${added}개를 추가했습니다.`);
  if (duplicates.length === 1) {
    messages.push(`같은 파일이 이미 있어 추가하지 않았습니다: ${duplicates[0]}`);
  } else if (duplicates.length > 1) {
    messages.push(`같은 파일이 이미 있어 ${duplicates.length}개는 추가하지 않았습니다: ${duplicates[0]} 외 ${duplicates.length - 1}개`);
  }
  if (messages.length) toast(messages.join(' '), { duration: duplicates.length || errors.length ? 6000 : 3500 });
}

const THEME_KEY = 'score-viewer:theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

const currentTheme = () =>
  document.documentElement.dataset.theme || (prefersDark.matches ? 'dark' : 'light');

function refreshThemeUi() {
  const dark = currentTheme() === 'dark';
  const label = dark ? '밝은 화면으로' : '어두운 화면으로';
  const button = $('themeToggle');
  button.title = label;
  button.setAttribute('aria-label', label);
  $('themeIcon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#161618' : '#ffffff';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 이번 실행에만 적용됩니다 */ }
  refreshThemeUi();
}

function showLibrary() {
  viewerEl.hidden = true;
  libraryEl.hidden = false;
  document.title = '악보함';
}

let routeToken = 0;
async function route() {
  const token = ++routeToken;
  const match = location.hash.match(/^#\/score\/(.+)$/);
  closePiano();
  closePractice();
  await closeRecorder();
  await closeViewer();
  if (token !== routeToken) return;

  if (!match) {
    showLibrary();
    await renderLibrary();
    return;
  }
  libraryEl.hidden = true;
  viewerEl.hidden = false;
  try {
    const id = decodeURIComponent(match[1]);
    setRecorderScore(id);
    setPracticeScore(id);
    await openViewer(id);
  } catch (err) {
    console.error(err);
    if (token !== routeToken) return;
    toast('악보를 열 수 없습니다.');
    location.hash = '#/';
  }
}

function initDropZone() {
  let depth = 0;
  const setActive = (on) => document.body.classList.toggle('dropping', on);
  addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!libraryEl.hidden) { depth += 1; setActive(true); }
  });
  addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) setActive(false);
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setActive(false);
    if (!libraryEl.hidden) importFiles(e.dataTransfer.files);
  });
}

refreshThemeUi();
$('themeToggle').addEventListener('click', toggleTheme);
prefersDark.addEventListener('change', refreshThemeUi);

initDialog();
initViewer();
initPiano();
initRecorder();
initPractice();
initDropZone();
refreshSortButtons();
for (const btn of document.querySelectorAll('[data-sort]')) {
  btn.addEventListener('click', () => setSort(btn.dataset.sort));
}

for (const btn of document.querySelectorAll('[data-add]')) {
  btn.addEventListener('click', () => fileInput.click());
}
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  await importFiles(files);
});
searchEl.addEventListener('input', renderLibrary);
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.card-more, .card-menu')) closeCardMenus();
});
addEventListener('hashchange', route);

// 저장 공간이 부족할 때 브라우저가 악보를 임의로 지우지 않도록 요청합니다.
navigator.storage?.persist?.().catch(() => {});

// 서비스 워커는 HTTPS 또는 localhost에서만 동작합니다.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('오프라인 설정 실패', err));
}

route();
