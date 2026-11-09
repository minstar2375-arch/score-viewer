import * as db from './db.js';
import { loadPdf, makeThumbnail } from './pdf.js';
import { toast, confirmDialog, promptDialog, initDialog } from './ui.js';
import { initViewer, openViewer, closeViewer } from './viewer.js';
import { initPiano, closePiano } from './piano.js';

const $ = (id) => document.getElementById(id);
const libraryEl = $('library');
const viewerEl = $('viewer');
const gridEl = $('grid');
const emptyEl = $('empty');
const noResultEl = $('noResult');
const searchEl = $('search');
const fileInput = $('fileInput');

let thumbUrls = [];

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
    ? `총 ${score.pageCount}쪽 · ${score.lastPage}쪽까지 봄`
    : `총 ${score.pageCount}쪽`;

  open.append(frame, title, meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const makeAction = (name, label, handler) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.title = label;
    btn.setAttribute('aria-label', `${score.name} ${label}`);
    btn.append(icon(name));
    btn.addEventListener('click', handler);
    return btn;
  };
  actions.append(
    makeAction('rename', '이름 바꾸기', () => renameScore(score)),
    makeAction('trash', '삭제', () => removeScore(score)),
  );

  card.append(open, actions);
  return card;
}

async function renderLibrary() {
  const scores = await db.listScores();
  scores.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
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

async function importOne(file, existing) {
  const name = file.name.replace(/\.pdf$/i, '');
  if (existing.some((s) => s.name === name && s.size === file.size)) return 'duplicate';

  const data = await file.arrayBuffer();
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
    return 'added';
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
  let duplicates = 0;
  const errors = [];
  for (const [i, file] of pdfs.entries()) {
    toast(pdfs.length > 1 ? `악보 추가 중… (${i + 1}/${pdfs.length})` : '악보 추가 중…', { sticky: true });
    try {
      const result = await importOne(file, existing);
      if (result === 'added') added += 1;
      else duplicates += 1;
    } catch (err) {
      console.error(err);
      errors.push(importErrorText(err, file.name));
    }
  }
  await renderLibrary();

  if (errors.length) toast(errors.join(' '));
  else if (added) toast(`악보 ${added}개를 추가했습니다.`);
  else if (duplicates) toast('이미 보관함에 있는 악보입니다.');
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
    await openViewer(decodeURIComponent(match[1]));
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

initDialog();
initViewer();
initPiano();
initDropZone();

for (const btn of document.querySelectorAll('[data-add]')) {
  btn.addEventListener('click', () => fileInput.click());
}
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  await importFiles(files);
});
searchEl.addEventListener('input', renderLibrary);
addEventListener('hashchange', route);

// 저장 공간이 부족할 때 브라우저가 악보를 임의로 지우지 않도록 요청합니다.
navigator.storage?.persist?.().catch(() => {});

// 서비스 워커는 HTTPS 또는 localhost에서만 동작합니다.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('오프라인 설정 실패', err));
}

route();
