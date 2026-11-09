// 악보를 보면서 듣는 연습 음원입니다.
// 음원은 기기에 저장한 파일(MP3 등)이거나 YouTube, YouTube Music 곡 링크입니다.
import * as db from './db.js';
import { toast, confirmDialog, promptDialog } from './ui.js';

const $ = (id) => document.getElementById(id);
const FILE_SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25];
const YT_SPEEDS = [0.5, 0.75, 1, 1.25];
const TICK_MS = 60;
const YT_DEFAULT_NAME = 'YouTube 곡';

let els;
let scoreId = null;
let current = null; // 재생 중인 음원 기록
let engine = null;
let ticker = null;
let seeking = false;
let saveTimer = null;
let tapHintTimer = null;

const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------- 파일 재생 ---------- */

function fileEngine(track) {
  const audio = new Audio();
  const url = URL.createObjectURL(track.blob);
  audio.preservesPitch = true; // 속도를 바꿔도 음 높이는 그대로입니다.
  audio.webkitPreservesPitch = true;
  audio.preload = 'auto';
  audio.src = url;
  audio.addEventListener('error', () => toast('이 음원을 재생할 수 없습니다.'));
  return {
    speeds: FILE_SPEEDS,
    play: () => audio.play().catch((err) => {
      console.error(err);
      toast('음원을 재생하지 못했습니다.');
    }),
    pause: () => audio.pause(),
    seek: (t) => { audio.currentTime = t; },
    setRate: (rate) => { audio.playbackRate = rate; },
    time: () => audio.currentTime,
    duration: () => (Number.isFinite(audio.duration) ? audio.duration : track.duration || 0),
    playing: () => !audio.paused && !audio.ended,
    destroy: () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    },
  };
}

/* ---------- YouTube 재생 ---------- */

let ytApi = null;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytApi ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      ytApi = null;
      script.remove();
      reject(new Error('YouTube를 불러오지 못했습니다'));
    };
    document.head.append(script);
  });
  return ytApi;
}

const musicUrl = (videoId) => `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

function showYouTubeBox(videoId) {
  els.ytBox.hidden = false;
  els.ytError.hidden = true;
  els.ytOpen.href = musicUrl(videoId);
  els.ytErrorOpen.href = musicUrl(videoId);
  const mount = document.createElement('div');
  els.ytFrame.replaceChildren(mount);
  return mount;
}

function hideYouTubeBox() {
  els.ytBox.hidden = true;
  els.ytFrame.replaceChildren();
}

function showYouTubeError(message) {
  els.ytErrorText.textContent = message;
  els.ytError.hidden = false;
}

function youTubeEngine(track) {
  let player = null;
  let ready = false;
  let wanted = null; // 준비되기 전에 누른 재생
  let rate = 1;
  let startAt = null;
  const mount = showYouTubeBox(track.videoId);

  const engineApi = {
    speeds: YT_SPEEDS,
    play: () => {
      if (ready) player.playVideo();
      else wanted = true;
    },
    pause: () => {
      if (ready) player.pauseVideo();
      else wanted = false;
    },
    seek: (t) => {
      if (ready) player.seekTo(t, true);
      else startAt = t;
    },
    setRate: (value) => {
      rate = value;
      if (ready) player.setPlaybackRate(value);
    },
    time: () => (ready ? player.getCurrentTime() || 0 : 0),
    duration: () => (ready ? player.getDuration() || 0 : 0),
    playing: () => ready && player.getPlayerState?.() === window.YT.PlayerState.PLAYING,
    // 기기 정책으로 앱의 버튼만으로는 시작되지 않아 영상을 직접 눌러야 하는 상태입니다.
    needsTap: () => {
      if (!ready || !els.ytError.hidden) return false;
      const state = player.getPlayerState?.();
      return state === window.YT.PlayerState.UNSTARTED || state === window.YT.PlayerState.CUED;
    },
    destroy: () => {
      destroyed = true;
      try { player?.destroy(); } catch { /* 이미 사라진 플레이어입니다 */ }
      hideYouTubeBox();
    },
  };
  let destroyed = false;

  if (navigator.onLine === false) {
    showYouTubeError('YouTube 곡은 인터넷이 연결되어 있어야 들을 수 있습니다.');
    return engineApi;
  }

  loadYouTubeApi().then((YT) => {
    if (destroyed) return;
    player = new YT.Player(mount, {
      videoId: track.videoId,
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          if (destroyed) return;
          ready = true;
          player.setPlaybackRate(rate);
          if (startAt !== null) player.seekTo(startAt, true);
          if (wanted) player.playVideo();
          const title = player.getVideoData?.().title;
          if (title && track.name === YT_DEFAULT_NAME) {
            track.name = title;
            db.putTrack(track).catch(console.error);
            if (current === track) els.name.textContent = title;
            if (!els.panel.hidden) renderList();
          }
        },
        onError: (e) => {
          if (destroyed) return;
          // 101, 150: 저작권자가 외부 재생을 막은 곡
          showYouTubeError(e.data === 101 || e.data === 150
            ? '이 곡은 다른 앱에서 재생할 수 없게 설정되어 있습니다.'
            : '이 곡을 재생하지 못했습니다.');
        },
      },
    });
  }).catch((err) => {
    console.error(err);
    if (!destroyed) showYouTubeError('YouTube를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  });
  return engineApi;
}

// 공유 문구가 함께 붙여 넣어져도 그 안의 주소를 찾아냅니다.
export function parseYouTubeId(text) {
  const found = String(text).match(/https?:\/\/\S+/)?.[0] ?? String(text).trim();
  let url;
  try {
    url = new URL(found.includes('://') ? found : `https://${found}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    [, id] = url.pathname.split('/');
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v')
      ?? url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]+)/)?.[1]
      ?? null;
  }
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

/* ---------- 재생 막대 ---------- */

function tick() {
  if (!engine || !current) return;
  const duration = engine.duration();
  const time = engine.time();
  const { loopA, loopB } = current;

  if (loopA != null && loopB != null && loopB > loopA && engine.playing()
      && (time >= loopB || time < loopA - 0.5)) {
    engine.seek(loopA);
  }

  if (!seeking) {
    els.seek.max = duration || 0;
    els.seek.value = time;
  }
  els.time.textContent = `${formatTime(seeking ? Number(els.seek.value) : time)} / ${formatTime(duration)}`;

  const isPlaying = engine.playing();
  if (els.play.dataset.state !== String(isPlaying)) {
    els.play.dataset.state = String(isPlaying);
    els.play.replaceChildren(icon(isPlaying ? 'pause' : 'play'));
    els.play.setAttribute('aria-label', isPlaying ? '일시정지' : '재생');
  }
  refreshLoopMarks(duration);
}

function refreshLoopMarks(duration) {
  const { loopA, loopB } = current;
  els.a.classList.toggle('active', loopA != null);
  els.b.classList.toggle('active', loopB != null);
  els.a.setAttribute('aria-pressed', loopA != null);
  els.b.setAttribute('aria-pressed', loopB != null);
  const hasLoop = duration > 0 && loopA != null && loopB != null;
  els.seek.classList.toggle('looping', hasLoop);
  if (hasLoop) {
    els.seek.style.setProperty('--a', `${(loopA / duration) * 100}%`);
    els.seek.style.setProperty('--b', `${(loopB / duration) * 100}%`);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  const track = current;
  saveTimer = setTimeout(() => db.putTrack(track).catch(console.error), 300);
}

function setLoopPoint(which) {
  if (!engine || !current) return;
  const key = which === 'a' ? 'loopA' : 'loopB';
  if (current[key] != null) {
    current[key] = null; // 다시 누르면 해제합니다.
  } else {
    const time = engine.time();
    if (which === 'a' && current.loopB != null && time >= current.loopB) current.loopB = null;
    if (which === 'b' && current.loopA != null && time <= current.loopA) {
      toast('B는 A보다 뒤에서 눌러 주세요.');
      return;
    }
    current[key] = time;
    if (which === 'b' && current.loopA != null) engine.seek(current.loopA);
  }
  scheduleSave();
  tick();
}

function buildSpeeds(speeds, rate) {
  els.speed.replaceChildren(...speeds.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value}배`;
    return option;
  }));
  const selected = speeds.includes(rate) ? rate : 1;
  els.speed.value = selected;
  return selected;
}

function startPlaying() {
  engine.play();
  if (!engine.needsTap) return;
  const started = engine;
  clearTimeout(tapHintTimer);
  tapHintTimer = setTimeout(() => {
    if (engine === started && engine.needsTap()) {
      toast('재생이 시작되지 않으면 영상 화면을 한 번 직접 눌러 주세요.', { duration: 6000 });
    }
  }, 4000);
}

function closeEngine() {
  clearTimeout(tapHintTimer);
  clearInterval(ticker);
  ticker = null;
  engine?.destroy();
  engine = null;
}

function selectTrack(track, { autoplay = true } = {}) {
  closeEngine();
  current = track;
  engine = track.kind === 'youtube' ? youTubeEngine(track) : fileEngine(track);
  els.bar.hidden = false;
  els.name.textContent = track.name;
  els.play.dataset.state = '';
  engine.setRate(buildSpeeds(engine.speeds, track.rate ?? 1));
  ticker = setInterval(tick, TICK_MS);
  tick();
  if (autoplay) startPlaying();
}

function closeBar() {
  closeEngine();
  current = null;
  els.bar.hidden = true;
}

/* ---------- 음원 목록 ---------- */

function trackMeta(track) {
  if (track.kind === 'youtube') return 'YouTube Music';
  return `${formatTime(track.duration)} · ${(track.blob.size / 1048576).toFixed(1)}MB`;
}

function trackRow(track) {
  const row = document.createElement('li');
  row.className = 'rec-row';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'tb';
  play.setAttribute('aria-label', `${track.name} 재생`);
  play.append(icon('play'));
  play.addEventListener('click', () => {
    setPanelOpen(false);
    selectTrack(track);
  });

  const info = document.createElement('div');
  info.className = 'rec-info';
  const name = document.createElement('div');
  name.className = 'rec-when';
  name.textContent = track.name;
  const meta = document.createElement('div');
  meta.className = 'rec-length';
  meta.textContent = trackMeta(track);
  info.append(name, meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tb';
  remove.title = '삭제';
  remove.setAttribute('aria-label', `${track.name} 삭제`);
  remove.append(icon('trash'));
  remove.addEventListener('click', () => removeTrack(track));

  row.append(play, info, remove);
  return row;
}

async function renderList() {
  const id = scoreId;
  const tracks = id ? await db.listTracks(id) : [];
  if (id !== scoreId) return;
  tracks.sort((a, b) => a.createdAt - b.createdAt);
  els.list.replaceChildren(...tracks.map(trackRow));
  els.empty.hidden = tracks.length > 0;
}

async function removeTrack(track) {
  const yes = await confirmDialog({
    title: '연습 음원을 삭제할까요?',
    message: track.kind === 'youtube'
      ? `"${track.name}" 링크를 이 악보에서 뺍니다.`
      : `"${track.name}" 파일이 이 앱에서 지워지며, 되돌릴 수 없습니다. 원본 파일은 그대로 남습니다.`,
    ok: '삭제',
    danger: true,
  });
  if (!yes) return;
  if (current?.id === track.id) closeBar();
  await db.deleteTrack(track.id);
  await renderList();
}

function setPanelOpen(open) {
  if (open && !$('recPanel').hidden) $('recClose').click();
  els.panel.hidden = !open;
  els.toggle.classList.toggle('active', open);
  els.toggle.setAttribute('aria-pressed', open);
  if (open) renderList().catch(console.error);
}

function probeDuration(blob) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (fn, value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('timeout')), 20000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(resolve, Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(reject, new Error('unsupported'));
    audio.src = url;
  });
}

async function sameFile(blob, tracks) {
  const candidates = tracks.filter((t) => t.kind === 'file' && t.blob.size === blob.size);
  if (!candidates.length) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (const track of candidates) {
    const other = new Uint8Array(await track.blob.arrayBuffer());
    if (other.every((value, i) => value === bytes[i])) return track;
  }
  return null;
}

async function addFiles(files) {
  const forScore = scoreId;
  if (!forScore) return;
  const messages = [];
  let added = 0;
  const existing = await db.listTracks(forScore);
  for (const file of files) {
    toast(`음원 추가 중… ${file.name}`, { sticky: true });
    try {
      const same = await sameFile(file, existing);
      if (same) {
        messages.push(`같은 파일이 이미 있습니다: ${same.name}`);
        continue;
      }
      const duration = await probeDuration(file);
      const track = {
        id: newId(),
        scoreId: forScore,
        kind: 'file',
        name: file.name.replace(/\.[^.]+$/, ''),
        createdAt: Date.now(),
        duration,
        type: file.type,
        // 선택한 파일과의 연결이 끊겨도 재생되도록 내용을 복사해 저장합니다.
        blob: new Blob([await file.arrayBuffer()], { type: file.type }),
      };
      await db.putTrack(track);
      existing.push(track);
      added += 1;
    } catch (err) {
      console.error(err);
      messages.push(err?.name === 'QuotaExceededError'
        ? '저장 공간이 부족해 음원을 추가하지 못했습니다.'
        : `"${file.name}"은 재생할 수 없는 파일입니다.`);
    }
  }
  if (added) messages.unshift(`음원 ${added}개를 추가했습니다.`);
  toast(messages.join(' '), { duration: 5000 });
  if (forScore === scoreId) await renderList();
}

async function addLink() {
  const forScore = scoreId;
  const text = await promptDialog({
    title: 'YouTube Music 링크 추가',
    message: 'YouTube Music에서 곡의 공유 버튼을 눌러 링크를 복사한 뒤 붙여 넣으세요.',
    ok: '추가',
    value: '',
  });
  if (!text || forScore !== scoreId) return;
  const videoId = parseYouTubeId(text);
  if (!videoId) {
    toast('곡 링크를 찾지 못했습니다. 재생목록이 아니라 곡의 링크를 넣어 주세요.', { duration: 5000 });
    return;
  }
  const existing = await db.listTracks(forScore);
  const same = existing.find((t) => t.videoId === videoId);
  if (same) {
    toast(`같은 곡이 이미 있습니다: ${same.name}`, { duration: 5000 });
    return;
  }
  const track = {
    id: newId(), scoreId: forScore, kind: 'youtube', name: YT_DEFAULT_NAME, createdAt: Date.now(), videoId,
  };
  await db.putTrack(track);
  setPanelOpen(false);
  selectTrack(track);
}

/* ---------- YouTube 창 옮기기 ---------- */

function initBoxDrag() {
  let drag = null;
  const { ytBox, ytHandle } = els;
  ytHandle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button')) return;
    const rect = ytBox.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    ytHandle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ytHandle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const maxLeft = window.innerWidth - ytBox.offsetWidth;
    const maxTop = window.innerHeight - ytBox.offsetHeight;
    ytBox.style.left = `${Math.max(0, Math.min(maxLeft, e.clientX - drag.dx))}px`;
    ytBox.style.top = `${Math.max(0, Math.min(maxTop, e.clientY - drag.dy))}px`;
    ytBox.style.right = 'auto';
    ytBox.style.bottom = 'auto';
  });
  const end = () => { drag = null; };
  ytHandle.addEventListener('pointerup', end);
  ytHandle.addEventListener('pointercancel', end);
}

/* ---------- 앱과 연결 ---------- */

export function setPracticeScore(id) {
  scoreId = id;
}

export function closePractice() {
  if (!els) return;
  closeBar();
  setPanelOpen(false);
  scoreId = null;
}

export function initPractice() {
  els = {
    toggle: $('toggleTracks'),
    panel: $('trackPanel'),
    close: $('trackClose'),
    addFile: $('trackAddFile'),
    addLink: $('trackAddLink'),
    file: $('trackFile'),
    list: $('trackList'),
    empty: $('trackEmpty'),
    bar: $('practiceBar'),
    name: $('practiceName'),
    play: $('practicePlay'),
    back: $('practiceBack'),
    seek: $('practiceSeek'),
    time: $('practiceTime'),
    a: $('practiceA'),
    b: $('practiceB'),
    speed: $('practiceSpeed'),
    barClose: $('practiceClose'),
    ytBox: $('ytBox'),
    ytHandle: $('ytHandle'),
    ytFrame: $('ytFrame'),
    ytOpen: $('ytOpen'),
    ytError: $('ytError'),
    ytErrorText: $('ytErrorText'),
    ytErrorOpen: $('ytErrorOpen'),
  };

  els.toggle.addEventListener('click', () => setPanelOpen(els.panel.hidden));
  els.close.addEventListener('click', () => setPanelOpen(false));
  els.addFile.addEventListener('click', () => els.file.click());
  els.addLink.addEventListener('click', () => addLink().catch(console.error));
  els.file.addEventListener('change', () => {
    const files = [...els.file.files];
    els.file.value = '';
    if (files.length) addFiles(files).catch(console.error);
  });

  els.play.addEventListener('click', () => {
    if (!engine) return;
    if (engine.playing()) engine.pause();
    else startPlaying();
  });
  els.back.addEventListener('click', () => engine?.seek(Math.max(0, engine.time() - 5)));
  els.a.addEventListener('click', () => setLoopPoint('a'));
  els.b.addEventListener('click', () => setLoopPoint('b'));
  els.speed.addEventListener('change', () => {
    if (!engine || !current) return;
    current.rate = Number(els.speed.value);
    engine.setRate(current.rate);
    scheduleSave();
  });
  els.barClose.addEventListener('click', closeBar);

  els.seek.addEventListener('pointerdown', () => { seeking = true; });
  els.seek.addEventListener('input', () => {
    if (engine) engine.seek(Number(els.seek.value));
  });
  const endSeek = () => { seeking = false; };
  els.seek.addEventListener('pointerup', endSeek);
  els.seek.addEventListener('pointercancel', endSeek);
  els.seek.addEventListener('change', endSeek);

  initBoxDrag();
}
