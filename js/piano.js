// 악보를 보면서 음을 확인하는 화면 건반입니다.
// 소리는 Web Audio로 합성하므로 음원 파일이 없고 인터넷 없이도 납니다.

const $ = (id) => document.getElementById(id);

const LOWEST_OCTAVE = 1; // C1
const HIGHEST_MIDI = 108; // C8
const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];
const SOLFEGE = ['도', '레', '미', '파', '솔', '라', '시'];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LABEL_MODES = ['solfege', 'letter', 'none'];
const LABEL_BUTTON_TEXT = { solfege: '도레미', letter: 'CDE', none: '이름 없음' };
const LABEL_KEY = 'score-viewer:piano-labels';
const MAX_VOICES = 20;
const PARTIALS = [1, 0.55, 0.3, 0.18, 0.1, 0.06];
const INHARMONICITY = 0.0003;

const midiOf = (octave, whiteIndex) => (octave + 1) * 12 + WHITE_STEPS[whiteIndex];

function noteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const whiteIndex = WHITE_STEPS.indexOf(midi % 12);
  if (whiteIndex >= 0) return { octave, whiteIndex, sharp: false };
  return { octave, whiteIndex: WHITE_STEPS.indexOf((midi % 12) - 1), sharp: true };
}

/* ---------- 소리 ---------- */

let ctx = null;
let master = null;
let noiseBuffer = null;
const voices = new Set();

function ensureAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx = new AudioCtx({ latencyHint: 'interactive' });
    const compressor = ctx.createDynamicsCompressor();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(compressor);
    compressor.connect(ctx.destination);

    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return true;
}

function hammerNoise(frequency, t) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = Math.min(frequency * 4, 6000);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.05, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
  source.connect(band);
  band.connect(gain);
  gain.connect(master);
  source.start(t);
  source.onended = () => gain.disconnect();
}

function noteOn(midi) {
  if (!ensureAudio()) return null;
  if (voices.size >= MAX_VOICES) noteOff(voices.values().next().value);

  const t = ctx.currentTime;
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  // 낮은 음일수록 소리가 오래 남습니다.
  const decay = 6 * 2 ** (-(midi - 21) / 30);

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.linearRampToValueAtTime(0.5, t + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.22, t + 0.12);
  envelope.gain.exponentialRampToValueAtTime(0.001, t + decay);

  // 처음에는 밝다가 점점 부드러워지는 음색입니다.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(Math.min(frequency * 10, 14000), t);
  tone.frequency.setTargetAtTime(Math.min(frequency * 3, 9000), t, 0.5);
  tone.connect(envelope);
  envelope.connect(master);

  const voice = { midi, envelope, oscillators: [], released: false };
  const limit = Math.min(ctx.sampleRate * 0.45, 14000);
  PARTIALS.forEach((amplitude, i) => {
    const n = i + 1;
    const partialFrequency = n * frequency * Math.sqrt(1 + INHARMONICITY * n * n);
    if (partialFrequency > limit) return;
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = partialFrequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(amplitude, t);
    gain.gain.setTargetAtTime(amplitude * 0.25, t, decay / (n + 1));
    oscillator.connect(gain);
    gain.connect(tone);
    oscillator.start(t);
    oscillator.stop(t + decay + 0.1);
    voice.oscillators.push(oscillator);
  });

  const last = voice.oscillators[voice.oscillators.length - 1];
  last.onended = () => {
    envelope.disconnect();
    voices.delete(voice);
  };
  voices.add(voice);
  hammerNoise(frequency, t);
  return voice;
}

// 건반에서 손을 떼면 댐퍼가 내려앉듯 빠르게 소리가 줄어듭니다.
function noteOff(voice) {
  if (!voice || voice.released) return;
  voice.released = true;
  const t = ctx.currentTime;
  const { gain } = voice.envelope;
  if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(t);
  else {
    const value = gain.value;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(value, t);
  }
  gain.setTargetAtTime(0, t, voice.midi < 48 ? 0.14 : 0.08);
  for (const oscillator of voice.oscillators) {
    try {
      oscillator.stop(t + 0.7);
    } catch { /* 이미 끝난 소리입니다 */ }
  }
}

/* ---------- 건반 화면 ---------- */

let els;
let whiteCount = 0;
let startOctave = null; // null이면 가온 도가 가운데 오도록 자동으로 정합니다.
let labelMode = 'solfege';
const held = new Map(); // pointerId -> { midi, voice }
const keyEls = new Map(); // midi -> 건반 요소

function keyLabel(midi) {
  const { octave, whiteIndex } = noteName(midi);
  if (labelMode === 'solfege') return SOLFEGE[whiteIndex];
  if (labelMode === 'letter') return whiteIndex === 0 ? `C${octave}` : LETTERS[whiteIndex];
  return '';
}

function ariaName(midi) {
  const { octave, whiteIndex, sharp } = noteName(midi);
  return `${LETTERS[whiteIndex]}${sharp ? '샵' : ''}${octave}`;
}

function octaveLimits() {
  // 가장 높은 위치에서는 C8까지 보이도록 건반 수가 조금 줄어들 수 있습니다.
  const highest = Math.min(7, 8 - Math.floor((whiteCount - 1) / 7));
  return { min: LOWEST_OCTAVE, max: Math.max(LOWEST_OCTAVE, highest) };
}

function currentStart() {
  const { min, max } = octaveLimits();
  const automatic = 4 - Math.floor(whiteCount / 7 / 2);
  return Math.min(max, Math.max(min, startOctave ?? automatic));
}

function makeKey(midi, className) {
  const key = document.createElement('div');
  key.className = className;
  key.dataset.midi = midi;
  key.setAttribute('role', 'button');
  key.setAttribute('aria-label', ariaName(midi));
  keyEls.set(midi, key);
  return key;
}

function buildKeys() {
  releaseAll();
  keyEls.clear();
  const width = els.keys.clientWidth;
  if (!width) return;
  const minWidth = width < 600 ? 36 : 40;
  whiteCount = Math.max(7, Math.floor(width / minWidth));
  const octave = currentStart();

  const fragment = document.createDocumentFragment();
  const blackKeys = [];
  let lastMidi = 0;
  let drawn = 0;
  for (let i = 0; i < whiteCount; i += 1) {
    const midi = midiOf(octave + Math.floor(i / 7), i % 7);
    if (midi > HIGHEST_MIDI) break;
    const key = makeKey(midi, midi === 60 ? 'key white middle-c' : 'key white');
    const label = document.createElement('span');
    label.textContent = keyLabel(midi);
    key.append(label);
    fragment.append(key);
    lastMidi = midi;
    drawn = i + 1;
    if (i % 7 !== 2 && i % 7 !== 6) blackKeys.push({ midi: midi + 1, boundary: i + 1 });
  }
  els.keys.style.setProperty('--whites', drawn);
  for (const { midi, boundary } of blackKeys) {
    if (boundary >= drawn) continue;
    const key = makeKey(midi, 'key black');
    key.style.left = `${(boundary * 100) / drawn}%`;
    fragment.append(key);
  }
  els.keys.replaceChildren(fragment);

  const { min, max } = octaveLimits();
  els.down.disabled = octave <= min;
  els.up.disabled = octave >= max;
  els.range.textContent = `C${octave} ~ ${LETTERS[noteName(lastMidi).whiteIndex]}${noteName(lastMidi).octave}`;
  els.labels.textContent = LABEL_BUTTON_TEXT[labelMode];
}

function setKeyDown(midi, down) {
  const key = keyEls.get(midi);
  if (!key) return;
  const stillHeld = [...held.values()].some((h) => h.midi === midi);
  key.classList.toggle('down', down || stillHeld);
}

function midiAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest?.('[data-midi]');
  return el && els.keys.contains(el) ? Number(el.dataset.midi) : null;
}

function press(pointerId, midi) {
  held.set(pointerId, { midi, voice: noteOn(midi) });
  setKeyDown(midi, true);
}

function release(pointerId) {
  const hold = held.get(pointerId);
  if (!hold) return;
  held.delete(pointerId);
  noteOff(hold.voice);
  setKeyDown(hold.midi, false);
}

function releaseAll() {
  for (const pointerId of [...held.keys()]) release(pointerId);
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  // 건반 위로 손가락이 미끄러져도, 건반 밖에서 떼도 이 영역이 입력을 받습니다.
  els.keys.setPointerCapture(e.pointerId);
  ensureAudio();
  const midi = midiAt(e.clientX, e.clientY);
  if (midi !== null) press(e.pointerId, midi);
}

function onMove(e) {
  const hold = held.get(e.pointerId);
  if (!hold) return;
  const midi = midiAt(e.clientX, e.clientY);
  if (midi === null || midi === hold.midi) return;
  release(e.pointerId);
  press(e.pointerId, midi);
}

function onUp(e) {
  release(e.pointerId);
  // 터치 입력은 손을 뗄 때 소리 재생 권한이 생깁니다.
  ensureAudio();
}

function shiftOctave(delta) {
  startOctave = currentStart() + delta;
  buildKeys();
}

function cycleLabels() {
  labelMode = LABEL_MODES[(LABEL_MODES.indexOf(labelMode) + 1) % LABEL_MODES.length];
  try { localStorage.setItem(LABEL_KEY, labelMode); } catch { /* 이번 실행에만 적용됩니다 */ }
  buildKeys();
}

function setOpen(open) {
  els.panel.hidden = !open;
  els.toggle.classList.toggle('active', open);
  els.toggle.setAttribute('aria-pressed', open);
  if (open) {
    // 버튼을 누른 순간에 소리를 미리 허용해 첫 건반부터 바로 소리가 납니다.
    ensureAudio();
    buildKeys();
  } else {
    releaseAll();
  }
}

export function closePiano() {
  if (els && !els.panel.hidden) setOpen(false);
}

export function initPiano() {
  els = {
    panel: $('piano'),
    keys: $('pianoKeys'),
    toggle: $('togglePiano'),
    down: $('pianoDown'),
    up: $('pianoUp'),
    range: $('pianoRange'),
    labels: $('pianoLabels'),
    close: $('pianoClose'),
  };
  try {
    const saved = localStorage.getItem(LABEL_KEY);
    if (LABEL_MODES.includes(saved)) labelMode = saved;
  } catch { /* 기본값을 씁니다 */ }

  els.toggle.addEventListener('click', () => setOpen(els.panel.hidden));
  els.close.addEventListener('click', () => setOpen(false));
  els.down.addEventListener('click', () => shiftOctave(-1));
  els.up.addEventListener('click', () => shiftOctave(1));
  els.labels.addEventListener('click', cycleLabels);

  els.keys.addEventListener('pointerdown', onDown);
  els.keys.addEventListener('pointermove', onMove);
  els.keys.addEventListener('pointerup', onUp);
  els.keys.addEventListener('pointercancel', onUp);
  els.keys.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });
  new ResizeObserver(() => {
    if (!els.panel.hidden) buildKeys();
  }).observe(els.keys);
}
