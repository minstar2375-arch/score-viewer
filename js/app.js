import * as db from './db.js';
import { loadPdf, makeThumbnail } from './pdf.js';
import { toast, hideToast, confirmDialog, promptDialog, initDialog } from './ui.js';
import { initViewer, openViewer, closeViewer } from './viewer.js';
import { initPiano, closePiano } from './piano.js';
import { initRecorder, closeRecorder, setRecorderScore } from './recorder.js';
import { initPractice, closePractice, setPracticeScore } from './practice.js';
import { exportBackup, restoreBackup, BackupFormatError } from './backup.js';
import { isStoreApp } from './platform.js';

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
  for (const menu of document.querySelectorAll('.card .card-menu')) menu.hidden = true;
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

// 다시 받을 때 붙는 "곡 (1)" 같은 번호와 대소문자, 공백 차이는 같은 이름으로 봅니다.
const plainName = (name) => name
  .replace(/\s*[(（]\d+[)）]\s*$/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

async function importOne(file, existing) {
  const name = file.name.replace(/\.pdf$/i, '');
  const data = await file.arrayBuffer();
  const same = await findSameFile(data, existing);
  if (same) return { duplicateOf: same.name };

  // 이름만 같고 내용이 다르면 고친 악보일 수 있으니 물어봅니다.
  const sameName = existing.find((s) => plainName(s.name) === plainName(name));
  if (sameName) {
    hideToast();
    const yes = await confirmDialog({
      title: '같은 이름의 악보가 있습니다',
      message: `보관함에 "${sameName.name}"이 있습니다. 새 파일 "${file.name}"은 내용이 다릅니다. 함께 추가할까요?`,
      ok: '추가',
    });
    if (!yes) return { declined: true };
  }

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
      else if (!result.declined) added += 1;
    } catch (err) {
      console.error(err);
      errors.push(importErrorText(err, file.name));
    }
  }
  await renderLibrary();

  const messages = [...errors];
  if (added) messages.push(`악보 ${added}개를 추가했습니다.`);
  if (messages.length) toast(messages.join(' '), { duration: errors.length ? 6000 : 3500 });
  else hideToast();

  // 놓치지 않도록 사라지는 문구 대신 확인 창으로 알립니다.
  if (duplicates.length) {
    const names = [...new Set(duplicates)];
    const list = names.slice(0, 5).map((name) => `"${name}"`).join(', ');
    const more = names.length > 5 ? ` 외 ${names.length - 5}개` : '';
    await confirmDialog({
      title: '이미 있는 악보입니다',
      message: `같은 파일이 보관함에 있어 ${duplicates.length}개를 추가하지 않았습니다: ${list}${more}`,
      ok: '확인',
      alertOnly: true,
    });
  }
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

/* ---------- 백업 ---------- */

let backupBusy = false;

async function runBackup() {
  if (backupBusy) return;
  backupBusy = true;
  try {
    const result = await exportBackup((done, total) => {
      toast(`백업 준비 중… (${done}/${total})`, { sticky: true });
    });
    if (!result.count) toast('백업할 악보가 없습니다.');
    else if (result.saved) {
      toast(`악보 ${result.count}개를 백업했습니다 (${(result.size / 1048576).toFixed(1)}MB). 파일을 안전한 곳에 보관하세요.`, { duration: 6000 });
    } else toast('백업을 취소했습니다.');
  } catch (err) {
    console.error(err);
    toast('백업 파일을 만들지 못했습니다.');
  } finally {
    backupBusy = false;
  }
}

async function runRestore(file) {
  if (backupBusy) return;
  backupBusy = true;
  try {
    const { added, skipped } = await restoreBackup(file, (done, total) => {
      toast(`복원 중… (${done}/${total})`, { sticky: true });
    });
    await renderLibrary();
    const parts = [`악보 ${added}개를 복원했습니다.`];
    if (skipped.length) parts.push(`이미 있는 악보 ${skipped.length}개는 건너뛰었습니다.`);
    toast(parts.join(' '), { duration: 6000 });
  } catch (err) {
    console.error(err);
    await renderLibrary();
    if (err instanceof BackupFormatError) toast(err.message, { duration: 6000 });
    else if (err?.name === 'QuotaExceededError') toast('저장 공간이 부족해 복원을 끝내지 못했습니다.', { duration: 6000 });
    else toast('복원하지 못했습니다.', { duration: 6000 });
  } finally {
    backupBusy = false;
  }
}

function initBackupMenu() {
  const toggle = $('moreButton');
  const menu = $('moreMenu');
  toggle.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#moreButton, #moreMenu')) menu.hidden = true;
  });
  $('backupSave').addEventListener('click', () => {
    menu.hidden = true;
    runBackup();
  });
  $('backupRestore').addEventListener('click', () => {
    menu.hidden = true;
    $('backupFile').click();
  });
  $('backupFile').addEventListener('change', () => {
    const [file] = $('backupFile').files;
    $('backupFile').value = '';
    if (file) runRestore(file);
  });
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
initBackupMenu();
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
// 스토어 앱은 파일이 앱 안에 들어 있어 필요하지 않습니다.
if ('serviceWorker' in navigator && !isStoreApp) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('오프라인 설정 실패', err));
}

route();
