// '음 듣기' 도구: 악보에서 음표를 누르면 그 음의 이름을 보여 주고 피아노 소리로 들려줍니다.
import {
  darkMask, findStaves, nearestStaff, refineLines, findHead, stepOf, detectClef, pitchOf,
} from './pitch.js';
import { playNote } from './piano.js';
import { toast, hideToast } from './ui.js';

const SOLFEGE = ['도', '레', '미', '파', '솔', '라', '시'];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ALTER_MARK = { '-1': '♭', 0: '', 1: '♯' };
const CLEF_NAMES = { treble: '높은음', tenor: '테너', bass: '낮은음' };
const SETTINGS_KEY = 'score-viewer:listen:';

let bubble = null;
let marker = null;
let current = null; // 지금 말풍선에 보이는 음
const detectedClefs = new Map(); // 오선 위치 -> 자동으로 판별한 음자리표

/* ---------- 악보별 설정(조표, 직접 고른 음자리표) ---------- */

function loadSettings(scoreId) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY + scoreId));
    if (saved && typeof saved === 'object') return { key: 0, clefs: {}, ...saved };
  } catch { /* 처음 쓰는 악보입니다 */ }
  return { key: 0, clefs: {} };
}

function saveSettings(scoreId, settings) {
  try { localStorage.setItem(SETTINGS_KEY + scoreId, JSON.stringify(settings)); } catch { /* 저장하지 못해도 이번에는 씁니다 */ }
}

/* ---------- 음 찾기 ---------- */

// 누른 곳 주변만 읽어 빠르게 계산합니다.
function locate(canvas, px, py) {
  // 오선 끝 가까이에서는 읽는 폭이 오선 밖으로 나가 줄을 놓치므로, 폭을 줄여 한 번 더 봅니다.
  return locateIn(canvas, px, py, 0.07) ?? locateIn(canvas, px, py, 0.03);
}

function locateIn(canvas, px, py, widthRatio) {
  const W = canvas.width;
  const H = canvas.height;
  const rx = Math.round(Math.max(24, W * widthRatio));
  const ry = Math.round(Math.max(120, H * 0.14));
  const x0 = Math.max(0, Math.round(px - rx));
  const y0 = Math.max(0, Math.round(py - ry));
  const w = Math.min(W, Math.round(px + rx)) - x0;
  const h = Math.min(H, Math.round(py + ry)) - y0;
  if (w < 8 || h < 8) return null;
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(x0, y0, w, h);
  const found = nearestStaff(findStaves(darkMask(image, 0.15), w, h), py - y0);
  if (!found) return null;
  const strict = darkMask(image, 0.3);
  const staff = refineLines(strict, w, h, found);
  const head = findHead(strict, w, h, staff, px - x0, py - y0);
  const y = head ? head.y : py - y0;
  return {
    staff: { ...staff, top: staff.top + y0, bottom: staff.bottom + y0, lines: staff.lines.map((l) => ({ ...l, c: l.c + y0 })) },
    head: head ? { x: head.x + x0, y: head.y + y0 } : null,
    step: stepOf(staff, y),
  };
}

// 오선 왼쪽 끝의 음자리표를 봅니다. 같은 오선은 다시 계산하지 않습니다.
function autoClef(canvas, staff, px, cacheKey) {
  if (detectedClefs.has(cacheKey)) return detectedClefs.get(cacheKey);
  const { s } = staff;
  const y0 = Math.max(0, Math.round(staff.top - s * 3));
  const y1 = Math.min(canvas.height, Math.round(staff.bottom + s * 3));
  const w = Math.min(canvas.width, Math.round(px) + 1);
  let clef = null;
  if (w > 8 && y1 - y0 > 8) {
    const mask = darkMask(canvas.getContext('2d').getImageData(0, y0, w, y1 - y0));
    const local = {
      ...staff,
      top: staff.top - y0,
      bottom: staff.bottom - y0,
      lines: staff.lines.map((l) => ({ ...l, c: l.c - y0 })),
    };
    clef = detectClef(mask, w, y1 - y0, local, w - 1)?.clef ?? null;
  }
  detectedClefs.set(cacheKey, clef);
  return clef;
}

/* ---------- 말풍선 ---------- */

function noteText(pitch) {
  const mark = ALTER_MARK[pitch.alter];
  return {
    solfege: `${SOLFEGE[pitch.letter]}${mark}`,
    letter: `${LETTERS[pitch.letter]}${mark}${pitch.octave}`,
  };
}

function keyText(key) {
  if (!key) return '없음';
  return key > 0 ? `♯ ${key}개` : `♭ ${-key}개`;
}

function button(text, label, onClick, className = 'lb-btn') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  if (label) btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}

function render() {
  const c = current;
  const pitch = pitchOf(c.step, c.clef, c.settings.key, c.accidental);
  const names = noteText(pitch);
  bubble.querySelector('.lb-solfege').textContent = names.solfege;
  bubble.querySelector('.lb-letter').textContent = names.letter;
  for (const btn of bubble.querySelectorAll('[data-acc]')) {
    btn.classList.toggle('active', c.accidental !== null && Number(btn.dataset.acc) === c.accidental);
  }
  for (const btn of bubble.querySelectorAll('[data-clef]')) {
    btn.classList.toggle('active', btn.dataset.clef === c.clef);
  }
  bubble.querySelector('.lb-keytext').textContent = keyText(c.settings.key);
  bubble.querySelector('.lb-note').hidden = c.found;
  return pitch;
}

function play() {
  const pitch = render();
  playNote(pitch.midi).catch(console.error);
}

function buildBubble() {
  const el = document.createElement('div');
  el.className = 'listen-bubble';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '누른 음');
  // 말풍선을 누를 때 악보 쪽 동작(쪽 넘기기 등)이 함께 일어나지 않게 합니다.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'lb-head';
  const again = button('', '다시 듣기', play, 'lb-play');
  again.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>';
  const name = document.createElement('div');
  name.className = 'lb-name';
  name.setAttribute('aria-live', 'polite');
  name.innerHTML = '<span class="lb-solfege"></span><span class="lb-letter"></span>';
  const more = button('', '음자리표와 조표 설정', () => {
    const open = settingsBox.hidden;
    settingsBox.hidden = !open;
    more.classList.toggle('active', open);
    if (current) placeBubble(bubble.parentElement, current.tapY);
    more.setAttribute('aria-expanded', open);
  }, 'lb-more');
  more.setAttribute('aria-expanded', 'false');
  more.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-settings"/></svg>';
  const close = button('', '닫기', clearListen, 'lb-close');
  close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
  head.append(again, name);

  const accRow = document.createElement('div');
  accRow.className = 'lb-acc';
  accRow.setAttribute('role', 'group');
  accRow.setAttribute('aria-label', '임시표');
  for (const [text, value, label] of [['♭', -1, '내림'], ['♮', 0, '제자리'], ['♯', 1, '올림']]) {
    const btn = button(text, label, () => {
      current.accidental = current.accidental === value ? null : value;
      play();
    });
    btn.dataset.acc = value;
    accRow.append(btn);
  }

  const clefRow = document.createElement('div');
  clefRow.className = 'lb-row';
  clefRow.setAttribute('role', 'group');
  clefRow.setAttribute('aria-label', '음자리표');
  for (const clef of ['treble', 'tenor', 'bass']) {
    const btn = button(CLEF_NAMES[clef], `${CLEF_NAMES[clef]}자리표`, () => {
      current.clef = clef;
      current.settings.clefs[current.staffKey] = clef;
      saveSettings(current.scoreId, current.settings);
      play();
    });
    btn.dataset.clef = clef;
    clefRow.append(btn);
  }

  const keyRow = document.createElement('div');
  keyRow.className = 'lb-row lb-key';
  const keyLabel = document.createElement('span');
  keyLabel.className = 'lb-label';
  keyLabel.textContent = '조표';
  const keyValue = document.createElement('span');
  keyValue.className = 'lb-keytext';
  const changeKey = (delta) => () => {
    current.settings.key = Math.max(-7, Math.min(7, current.settings.key + delta));
    saveSettings(current.scoreId, current.settings);
    play();
  };
  keyRow.append(
    keyLabel,
    button('♭', '내림표 하나 더', changeKey(-1)),
    keyValue,
    button('♯', '올림표 하나 더', changeKey(1)),
  );

  const note = document.createElement('p');
  note.className = 'lb-note';
  note.textContent = '음표를 찾지 못해 누른 위치로 계산했습니다.';

  // 자주 바꾸지 않는 설정은 실수로 눌리지 않도록 접어 둡니다.
  const settingsBox = document.createElement('div');
  settingsBox.className = 'lb-settings';
  settingsBox.hidden = true;
  settingsBox.append(clefRow, keyRow);

  head.append(accRow, more, close);
  el.append(head, note, settingsBox);
  return el;
}

// 말풍선은 누른 곳의 반대편 가장자리에 붙여, 이어서 누를 악보를 가리지 않게 합니다.
function placeBubble(stage, tapY) {
  const stageRect = stage.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const x = Math.max(8, (stageRect.width - bw) / 2);
  const lowerHalf = tapY - stageRect.top > stageRect.height / 2;
  bubble.classList.toggle('docked-top', lowerHalf);
  bubble.style.left = `${x}px`;
  bubble.style.top = lowerHalf ? '8px' : `${Math.max(8, stageRect.height - bh - 8)}px`;
}

function showMarker(sheet, canvas, rect, center, radius) {
  marker?.remove();
  marker = document.createElement('div');
  marker.className = 'listen-marker';
  const scale = rect.width / canvas.width;
  const size = Math.max(22, radius * 2 * scale);
  marker.style.width = `${size}px`;
  marker.style.height = `${size}px`;
  marker.style.left = `${center.x * scale - size / 2}px`;
  marker.style.top = `${center.y * scale - size / 2}px`;
  sheet.append(marker);
  return size;
}

/* ---------- 바깥에서 부르는 함수 ---------- */

export function clearListen() {
  bubble?.remove();
  marker?.remove();
  bubble = null;
  marker = null;
  current = null;
}

// 악보를 바꾸면 자동 판별 결과를 새로 계산합니다.
export function resetListenCache() {
  detectedClefs.clear();
}

// 누른 곳의 오선·음표·음자리표를 계산합니다. 화면 표시와 시험에서 함께 씁니다.
export function analyzeTap(canvas, px, py, scoreId, page) {
  const found = locate(canvas, px, py);
  if (!found) return null;
  const { staff, head, step } = found;
  // 화면 크기가 바뀌어도 같은 오선을 가리키도록 쪽 높이에 대한 비율로 기억합니다.
  const staffKey = `${page}:${Math.round(((staff.top + staff.bottom) / 2 / canvas.height) * 200)}`;
  const settings = loadSettings(scoreId);
  const clef = settings.clefs[staffKey]
    || autoClef(canvas, staff, head?.x ?? px, `${scoreId}:${staffKey}`)
    || 'treble';
  return { staff, head, step, staffKey, settings, clef };
}

export function listenAt({ canvas, sheet, stage, clientX, clientY, scoreId, page }) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !canvas.width) return;
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  const found = analyzeTap(canvas, px, py, scoreId, page);
  if (!found) {
    clearListen();
    toast('여기서는 오선을 찾지 못했습니다. 음표 머리를 눌러 보세요.');
    return;
  }

  const {
    staff, head, step, staffKey, settings, clef,
  } = found;
  current = {
    scoreId, staffKey, settings, step, clef, accidental: null, found: Boolean(head), tapY: clientY,
  };
  hideToast(); // 처음 안내 문구가 말풍선을 가리지 않게 합니다.
  if (!bubble) {
    bubble = buildBubble();
    stage.append(bubble);
  }
  const center = head ?? { x: px, y: staff.bottom - (step * staff.s) / 2 };
  showMarker(sheet, canvas, rect, center, staff.s * 0.9);
  play();
  placeBubble(stage, clientY);
}
