// '음 듣기' 도구: 악보에서 음표나 마디를 누르면 음 이름을 보여 주고 피아노 소리로 들려줍니다.
//   한 음: 누른 음표 하나
//   한 마디: 누른 마디의 음들을 박자대로 이어서
import {
  darkMask, findStaves, nearestStaff, refineLines, findHead, stepOf, detectClef, pitchOf,
} from './pitch.js';
import { analyzeStaffStrip, measureAt } from './measure.js';
import { playNote, preloadNotes } from './piano.js';
import { toast, hideToast } from './ui.js';

const SOLFEGE = ['도', '레', '미', '파', '솔', '라', '시'];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ALTER_MARK = { '-1': '♭', 0: '', 1: '♯' };
const CLEF_NAMES = { treble: '높은음', tenor: '테너', bass: '낮은음' };
const VOICE_NAMES = { all: '모두', up: '윗성부', down: '아랫성부' };
const SETTINGS_KEY = 'score-viewer:listen:';
const MODE_KEY = 'score-viewer:listen-mode';
const DEFAULTS = { key: 0, clefs: {}, voice: 'all', tempo: 80 };
// 오선 간격이 이보다 좁게(픽셀) 그려져 있으면 마디를 읽기 전에 쪽을 크게 다시 그립니다.
const BAR_MIN_SPACING = 18;

let bubble = null;
let marker = null;
let current = null; // 지금 말풍선에 보이는 내용
let lastTap = null; // 모드를 바꿀 때 같은 곳을 다시 계산하기 위해 기억합니다.
let playTimers = [];
const detectedClefs = new Map(); // 오선 위치 -> 자동으로 판별한 음자리표

/* ---------- 설정 ---------- */

function loadSettings(scoreId) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY + scoreId));
    if (saved && typeof saved === 'object') return { ...DEFAULTS, ...saved };
  } catch { /* 처음 쓰는 악보입니다 */ }
  return { ...DEFAULTS, clefs: {} };
}

function saveSettings(scoreId, settings) {
  try { localStorage.setItem(SETTINGS_KEY + scoreId, JSON.stringify(settings)); } catch { /* 저장하지 못해도 이번에는 씁니다 */ }
}

function loadMode() {
  try { return localStorage.getItem(MODE_KEY) === 'note' ? 'note' : 'bar'; } catch { return 'bar'; }
}

function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* 이번에만 씁니다 */ }
}

/* ---------- 오선과 음표 찾기 ---------- */

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
    staff: {
      ...staff,
      top: staff.top + y0,
      bottom: staff.bottom + y0,
      lines: staff.lines.map((l) => ({ top: l.top + y0, bottom: l.bottom + y0, c: l.c + y0 })),
    },
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

// 오선 하나를 가로로 길게 잘라 마디 분석에 씁니다.
function readStrip(canvas, staff) {
  const { s } = staff;
  const y0 = Math.max(0, Math.round(staff.top - s * 5));
  const y1 = Math.min(canvas.height, Math.round(staff.bottom + s * 5));
  const w = canvas.width;
  const h = y1 - y0;
  const mask = darkMask(canvas.getContext('2d').getImageData(0, y0, w, h), 0.3);
  // 줄 두께를 이 띠에서 다시 잽니다(가장 진한 행 주변).
  const lines = staff.lines.map((line) => {
    const c = Math.round(line.c - y0);
    const count = (y) => {
      if (y < 0 || y >= h) return 0;
      let n = 0;
      for (let x = 0; x < w; x += 1) n += mask[y * w + x];
      return n;
    };
    let best = c;
    for (let y = c - 2; y <= c + 2; y += 1) if (count(y) > count(best)) best = y;
    const limit = count(best) * 0.5;
    let top = best;
    let bottom = best;
    while (top - 1 >= 0 && best - top < s * 0.3 && count(top - 1) >= limit) top -= 1;
    while (bottom + 1 < h && bottom - best < s * 0.3 && count(bottom + 1) >= limit) bottom += 1;
    return { top, bottom, c: (top + bottom) / 2 };
  });
  const local = {
    s, lines, top: lines[0].c, bottom: lines[4].c,
  };
  return { mask, w, h, y0, staff: local };
}

// 누른 마디의 사건을 음 높이와 함께 정리합니다. 시험에서도 씁니다.
export function analyzeBar(canvas, px, py, scoreId, page, stripCache = null) {
  const tap = analyzeTap(canvas, px, py, scoreId, page);
  if (!tap) return null;
  const strip = stripCache?.staffKey === tap.staffKey ? stripCache : {
    staffKey: tap.staffKey,
    ...readStrip(canvas, tap.staff),
  };
  if (!strip.analysis) strip.analysis = analyzeStaffStrip(strip.mask, strip.w, strip.h, strip.staff);
  const bar = measureAt(strip.analysis, strip.staff, px, strip.w, strip.h, tap.settings.key);
  const { settings, clef } = tap;
  const voiceOk = (head) => settings.voice === 'all' || !head.stem
    || (settings.voice === 'up' ? head.stem.dir < 0 : head.stem.dir > 0);
  const events = [];
  for (const ev of bar.events) {
    if (ev.rest) {
      events.push({ rest: ev.rest, dur: ev.dur, x: ev.x, midis: [], names: [] });
      continue;
    }
    const heads = ev.heads.filter(voiceOk);
    if (!heads.length) continue;
    const pitches = heads
      .map((hd) => ({ hd, p: pitchOf(stepOf(strip.staff, hd.y), clef, settings.key, hd.alter) }))
      .sort((a, b) => a.p.midi - b.p.midi);
    const stemHead = heads.find((hd) => hd.stem) ?? heads[0];
    events.push({
      x: ev.x,
      y: pitches[0].hd.y + strip.y0,
      dur: stemHead.dur ?? ev.dur,
      midis: pitches.map((q) => q.p.midi),
      names: pitches.map((q) => q.p),
    });
  }
  return {
    ...tap, events, left: bar.left, right: bar.right, strip, s: strip.staff.s,
  };
}

// 화면 그림이 작으면 PDF에서 쪽을 크게 다시 그려 마디를 읽습니다. 결과의 좌표는 그 그림 기준이고 f배입니다.
export async function analyzeBarView({ canvas, pageImage }, px, py, scoreId, page, cache = null) {
  const tap = analyzeTap(canvas, px, py, scoreId, page);
  if (!tap) return null;
  let target = canvas;
  if (pageImage && tap.staff.s < BAR_MIN_SPACING) {
    const want = canvas.width * Math.min(4, BAR_MIN_SPACING / tap.staff.s);
    const hi = await pageImage(want);
    if (hi) target = hi;
  }
  const f = target.width / canvas.width;
  const reuse = cache && cache.target === target ? cache.strip : null;
  const found = analyzeBar(target, px * f, py * f, scoreId, page, reuse);
  if (!found) return null;
  return { ...found, f, target };
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

function iconButton(icon, label, onClick, className) {
  const btn = button('', label, onClick, className);
  btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
  return btn;
}

function segmented(label, options, onPick) {
  const row = document.createElement('div');
  row.className = 'lb-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const btn = button(text, null, () => onPick(value));
    btn.dataset.value = value;
    row.append(btn);
  }
  return row;
}

function markActive(row, value) {
  for (const btn of row.querySelectorAll('[data-value]')) btn.classList.toggle('active', btn.dataset.value === String(value));
}

function render() {
  const c = current;
  const els = bubble.els;
  els.bubble.classList.toggle('mode-bar', c.mode === 'bar');
  markActive(els.mode, c.mode);
  markActive(els.clef, c.clef);
  markActive(els.voice, c.settings.voice);
  els.keyText.textContent = keyText(c.settings.key);
  els.tempoText.textContent = `♩ = ${c.settings.tempo}`;
  els.guess.hidden = c.mode !== 'note' || c.found;
  els.voice.hidden = c.mode !== 'bar';
  els.tempoRow.hidden = c.mode !== 'bar';
  if (c.mode === 'note') {
    const pitch = pitchOf(c.step, c.clef, c.settings.key, c.accidental);
    const names = noteText(pitch);
    els.solfege.textContent = names.solfege;
    els.letter.textContent = names.letter;
    for (const btn of els.acc.querySelectorAll('[data-acc]')) {
      btn.classList.toggle('active', c.accidental !== null && Number(btn.dataset.acc) === c.accidental);
    }
    return pitch;
  }
  els.seq.replaceChildren(...c.events.map((ev, i) => {
    const chip = document.createElement('span');
    chip.className = 'lb-chip';
    chip.dataset.index = i;
    chip.textContent = ev.rest ? '쉼' : ev.names.map((p) => noteText(p).solfege).join('+');
    return chip;
  }));
  return null;
}

function stopPlayback() {
  for (const t of playTimers) clearTimeout(t);
  playTimers = [];
}

function highlight(index) {
  if (!bubble) return;
  for (const chip of bubble.els.seq.children) chip.classList.toggle('now', Number(chip.dataset.index) === index);
  const ev = current?.events?.[index];
  if (ev && !ev.rest) moveMarker({ x: ev.x, y: ev.y });
}

async function play() {
  stopPlayback();
  if (!current) return;
  if (current.mode === 'note') {
    const pitch = render();
    playNote(pitch.midi).catch(console.error);
    return;
  }
  render();
  const { events } = current;
  const token = {};
  current.playing = token;
  await preloadNotes(events.flatMap((ev) => ev.midis));
  if (!current || current.playing !== token) return;
  const beat = 60 / current.settings.tempo;
  let t = 0;
  events.forEach((ev, i) => {
    const seconds = ev.dur * beat;
    playTimers.push(setTimeout(() => {
      highlight(i);
      for (const midi of ev.midis) playNote(midi, Math.max(0.25, seconds * 0.95)).catch(console.error);
    }, t * 1000));
    t += seconds;
  });
  playTimers.push(setTimeout(() => highlight(-1), t * 1000));
}

function changeSetting(apply) {
  apply(current.settings);
  saveSettings(current.scoreId, current.settings);
  if (current.mode === 'bar' && lastTap) {
    reanalyze();
    return;
  }
  play();
}

function buildBubble() {
  const el = document.createElement('div');
  el.className = 'listen-bubble';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '음 듣기');
  // 말풍선을 누를 때 악보 쪽 동작(쪽 넘기기 등)이 함께 일어나지 않게 합니다.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'lb-head';
  const again = iconButton('play', '다시 듣기', () => play(), 'lb-play');
  const mode = segmented('듣는 범위', [['note', '한 음'], ['bar', '한 마디']], (value) => {
    if (!current || current.mode === value) return;
    saveMode(value);
    current.mode = value;
    reanalyze();
  });
  mode.classList.add('lb-mode');
  const spacer = document.createElement('div');
  spacer.className = 'lb-spacer';
  const more = iconButton('settings', '설정', () => {
    const open = settingsBox.hidden;
    settingsBox.hidden = !open;
    more.classList.toggle('active', open);
    more.setAttribute('aria-expanded', open);
    if (current) placeBubble(el.parentElement, current.tapY);
  }, 'lb-more');
  more.setAttribute('aria-expanded', 'false');
  const close = iconButton('close', '닫기', clearListen, 'lb-close');
  head.append(again, mode, spacer, more, close);

  // 한 음: 음 이름과 임시표
  const noteRow = document.createElement('div');
  noteRow.className = 'lb-noterow';
  const name = document.createElement('div');
  name.className = 'lb-name';
  name.setAttribute('aria-live', 'polite');
  const solfege = document.createElement('span');
  solfege.className = 'lb-solfege';
  const letter = document.createElement('span');
  letter.className = 'lb-letter';
  name.append(solfege, letter);
  const acc = document.createElement('div');
  acc.className = 'lb-acc';
  acc.setAttribute('role', 'group');
  acc.setAttribute('aria-label', '임시표');
  for (const [text, value, label] of [['♭', -1, '내림'], ['♮', 0, '제자리'], ['♯', 1, '올림']]) {
    const btn = button(text, label, () => {
      current.accidental = current.accidental === value ? null : value;
      play();
    });
    btn.dataset.acc = value;
    acc.append(btn);
  }
  noteRow.append(name, acc);

  // 한 마디: 음 이름 줄과 다음 마디
  const barRow = document.createElement('div');
  barRow.className = 'lb-barrow';
  const seq = document.createElement('div');
  seq.className = 'lb-seq';
  seq.setAttribute('aria-live', 'polite');
  const next = button('다음 마디', '다음 마디 듣기', () => nextBar(), 'lb-btn lb-next');
  barRow.append(seq, next);

  const guess = document.createElement('p');
  guess.className = 'lb-note';
  guess.textContent = '음표를 찾지 못해 누른 위치로 계산했습니다.';

  const voice = segmented('성부', Object.entries(VOICE_NAMES), (value) => changeSetting((st) => { st.voice = value; }));
  const tempoRow = document.createElement('div');
  tempoRow.className = 'lb-row lb-key';
  const tempoLabel = document.createElement('span');
  tempoLabel.className = 'lb-label';
  tempoLabel.textContent = '빠르기';
  const tempoText = document.createElement('span');
  tempoText.className = 'lb-keytext';
  const tempo = (delta) => () => changeSetting((st) => { st.tempo = Math.max(40, Math.min(160, st.tempo + delta)); });
  tempoRow.append(tempoLabel, button('−', '느리게', tempo(-10)), tempoText, button('+', '빠르게', tempo(10)));

  const clef = segmented('음자리표', Object.entries(CLEF_NAMES), (value) => changeSetting((st) => {
    st.clefs[current.staffKey] = value;
    current.clef = value;
  }));
  const keyRow = document.createElement('div');
  keyRow.className = 'lb-row lb-key';
  const keyLabel = document.createElement('span');
  keyLabel.className = 'lb-label';
  keyLabel.textContent = '조표';
  const keyText = document.createElement('span');
  keyText.className = 'lb-keytext';
  const changeKey = (delta) => () => changeSetting((st) => { st.key = Math.max(-7, Math.min(7, st.key + delta)); });
  keyRow.append(keyLabel, button('♭', '내림표 하나 더', changeKey(-1)), keyText, button('♯', '올림표 하나 더', changeKey(1)));

  // 자주 바꾸지 않는 설정은 실수로 눌리지 않도록 접어 둡니다.
  const settingsBox = document.createElement('div');
  settingsBox.className = 'lb-settings';
  settingsBox.hidden = true;
  settingsBox.append(voice, tempoRow, clef, keyRow);

  el.append(head, noteRow, barRow, guess, settingsBox);
  el.els = {
    bubble: el, mode, solfege, letter, acc, seq, guess, voice, tempoRow, tempoText, clef, keyText,
  };
  return el;
}

// 말풍선은 누른 곳의 반대편 가장자리에 붙여, 이어서 누를 악보를 가리지 않게 합니다.
function placeBubble(stage, tapY) {
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const x = Math.max(8, (stageRect.width - bw) / 2);
  const lowerHalf = tapY - stageRect.top > stageRect.height / 2;
  bubble.style.left = `${x}px`;
  bubble.style.top = lowerHalf ? '8px' : `${Math.max(8, stageRect.height - bh - 8)}px`;
}

function moveMarker(center) {
  if (!current?.view) return;
  const { sheet, canvas, rect } = current.view;
  const f = current.f ?? 1;
  center = { x: center.x / f, y: center.y / f };
  if (!marker) {
    marker = document.createElement('div');
    marker.className = 'listen-marker';
    sheet.append(marker);
  }
  const scale = rect.width / canvas.width;
  const size = Math.max(22, (current.s / f) * 1.8 * scale);
  marker.style.width = `${size}px`;
  marker.style.height = `${size}px`;
  marker.style.left = `${center.x * scale - size / 2}px`;
  marker.style.top = `${center.y * scale - size / 2}px`;
}

/* ---------- 누르기 처리 ---------- */

function showBar(found, view, px) {
  current = {
    mode: 'bar',
    f: found.f,
    target: found.target,
    scoreId: view.scoreId,
    staffKey: found.staffKey,
    settings: found.settings,
    clef: found.clef,
    events: found.events,
    strip: found.strip,
    right: found.right,
    s: found.s,
    tapY: view.clientY,
    view,
    px,
    py: found.strip.y0 + (found.strip.staff.top + found.strip.staff.bottom) / 2,
  };
  if (!found.events.length) {
    toast('이 마디에서 음표를 찾지 못했습니다.');
  }
}

function reanalyze() {
  if (!lastTap) return;
  listenAt({ ...lastTap, keepBubble: true });
}

async function nextBar() {
  if (!current || current.mode !== 'bar') return;
  const { view, right, strip, s: spacing, target, f } = current;
  const extentRight = strip.analysis.extent.right;
  if (right >= extentRight - spacing) {
    toast('이 줄의 마지막 마디입니다. 다음 줄의 마디를 눌러 주세요.');
    return;
  }
  const px = right + spacing * 1.5;
  const found = analyzeBar(target, px, current.py, view.scoreId, view.page, strip);
  if (!found || !current) return;
  showBar({ ...found, f, target }, view, px);
  play();
}

export function clearListen() {
  stopPlayback();
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

let tapToken = 0;

export function listenAt(args) {
  const {
    canvas, sheet, stage, clientX, clientY, scoreId, page, pageImage,
  } = args;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !canvas.width) return;
  lastTap = {
    canvas, sheet, stage, clientX, clientY, scoreId, page, pageImage,
  };
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  const mode = current?.mode ?? loadMode();
  stopPlayback();
  hideToast(); // 처음 안내 문구가 말풍선을 가리지 않게 합니다.
  const view = {
    canvas, sheet, stage, rect, scoreId, page, clientY, pageImage,
  };
  const token = ++tapToken;

  const showBubble = () => {
    if (!bubble) {
      bubble = buildBubble();
      stage.append(bubble);
    }
    play();
    placeBubble(stage, clientY);
  };

  if (mode === 'bar') {
    analyzeBarView(view, px, py, scoreId, page, current?.mode === 'bar' ? current : null)
      .then((found) => {
        if (token !== tapToken) return;
        if (!found) {
          clearListen();
          toast('여기서는 오선을 찾지 못했습니다. 오선 위를 눌러 보세요.');
          return;
        }
        showBar(found, view, px * found.f);
        showBubble();
      })
      .catch(console.error);
    return;
  }

  const found = analyzeTap(canvas, px, py, scoreId, page);
  if (!found) {
    clearListen();
    toast('여기서는 오선을 찾지 못했습니다. 음표 머리를 눌러 보세요.');
    return;
  }
  current = {
    mode: 'note',
    f: 1,
    scoreId,
    staffKey: found.staffKey,
    settings: found.settings,
    clef: found.clef,
    step: found.step,
    accidental: null,
    found: Boolean(found.head),
    tapY: clientY,
    view,
    s: found.staff.s,
  };
  moveMarker(found.head ?? { x: px, y: found.staff.bottom - (found.step * found.staff.s) / 2 });
  showBubble();
}
