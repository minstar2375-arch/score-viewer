// 마이크로 연습을 녹음해 악보별로 저장하고 다시 듣습니다.
import * as db from './db.js';
import { toast, confirmDialog } from './ui.js';
import { saveBlob } from './platform.js';

const $ = (id) => document.getElementById(id);
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
const MIN_SECONDS = 0.5;

let els;
let scoreId = null;
let session = null;
let timer = null;
let starting = false;

const player = new Audio();
let playing = null; // { id, url, duration, row }

const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const formatDate = (time) => new Date(time).toLocaleString('ko-KR', {
  month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/* ---------- 녹음 ---------- */

const elapsed = () => (session ? (performance.now() - session.startedAt) / 1000 : 0);

function refreshRecordingUi() {
  const active = Boolean(session);
  els.toggle.classList.toggle('recording', active);
  els.main.classList.toggle('recording', active);
  els.mainText.textContent = active ? '녹음 정지' : starting ? '준비 중…' : '녹음 시작';
  els.main.disabled = starting || Boolean(session?.stopping);
  els.time.hidden = !active;
  els.pill.hidden = !active;
  if (active) {
    const time = formatTime(elapsed());
    els.time.textContent = time;
    els.pillTime.textContent = time;
  }
}

function micErrorText(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return '마이크 권한을 허용해야 녹음할 수 있습니다.';
  }
  if (err?.name === 'NotFoundError') return '마이크를 찾을 수 없습니다.';
  return '녹음을 시작하지 못했습니다.';
}

async function startRecording() {
  if (session || starting || !scoreId) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('이 브라우저에서는 녹음할 수 없습니다.');
    return;
  }
  stopPlayback();
  const forScore = scoreId;
  starting = true;
  refreshRecordingUi();

  let stream;
  try {
    // 음성 통화용 처리를 끄면 악기 소리가 덜 뭉개집니다.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (scoreId !== forScore) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 128000,
    });
    const current = {
      recorder, stream, scoreId: forScore, chunks: [], startedAt: performance.now(), stopping: null,
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size) current.chunks.push(e.data);
    };
    recorder.onerror = () => stopRecording();
    recorder.start(1000);
    session = current;
    timer = setInterval(refreshRecordingUi, 250);
  } catch (err) {
    console.error(err);
    stream?.getTracks().forEach((track) => track.stop());
    toast(micErrorText(err));
  } finally {
    starting = false;
    refreshRecordingUi();
  }
}

function stopRecording({ message = '녹음을 저장했습니다.' } = {}) {
  if (!session) return Promise.resolve();
  if (session.stopping) return session.stopping;

  const current = session;
  const duration = elapsed();
  current.stopping = new Promise((resolve) => {
    current.recorder.onstop = async () => {
      current.stream.getTracks().forEach((track) => track.stop());
      clearInterval(timer);
      session = null;
      refreshRecordingUi();
      const type = current.recorder.mimeType || current.chunks[0]?.type || 'audio/webm';
      const blob = new Blob(current.chunks, { type });
      try {
        if (duration >= MIN_SECONDS && blob.size) {
          await db.addRecording({
            id: newId(), scoreId: current.scoreId, createdAt: Date.now(), duration, type, blob,
          });
          toast(message);
        } else {
          toast('녹음이 너무 짧아 저장하지 않았습니다.');
        }
      } catch (err) {
        console.error(err);
        toast(err?.name === 'QuotaExceededError'
          ? '저장 공간이 부족해 녹음을 저장하지 못했습니다.'
          : '녹음을 저장하지 못했습니다.');
      }
      if (current.scoreId === scoreId && !els.panel.hidden) await renderList();
      resolve();
    };
  });
  refreshRecordingUi();
  current.recorder.stop();
  return current.stopping;
}

/* ---------- 다시 듣기 ---------- */

function stopPlayback() {
  player.pause();
  if (playing) {
    URL.revokeObjectURL(playing.url);
    setRowPlaying(playing.row, false);
    playing = null;
  }
  player.removeAttribute('src');
}

function setRowPlaying(row, on) {
  row.classList.toggle('playing', on);
  const btn = row.querySelector('.rec-play');
  btn.replaceChildren(icon(on ? 'pause' : 'play'));
  btn.setAttribute('aria-label', on ? '일시정지' : '재생');
  row.querySelector('.rec-seek').hidden = !on;
}

function togglePlay(recording, row) {
  if (session || starting) return;
  if (playing?.id === recording.id) {
    if (player.paused) player.play().catch(console.error);
    else player.pause();
    return;
  }
  stopPlayback();
  const url = URL.createObjectURL(recording.blob);
  playing = { id: recording.id, url, duration: recording.duration, row };
  const seek = row.querySelector('.rec-seek');
  seek.max = recording.duration;
  seek.value = 0;
  setRowPlaying(row, true);
  player.src = url;
  player.play().catch((err) => {
    console.error(err);
    toast('녹음을 재생하지 못했습니다.');
    stopPlayback();
  });
}

function refreshPlayerUi() {
  if (!playing) return;
  const btn = playing.row.querySelector('.rec-play');
  btn.replaceChildren(icon(player.paused ? 'play' : 'pause'));
  btn.setAttribute('aria-label', player.paused ? '재생' : '일시정지');
}

function saveToFile(recording) {
  const extension = recording.type.includes('mp4') ? 'm4a' : 'webm';
  const date = new Date(recording.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  saveBlob(recording.blob, `${els.title.textContent || '녹음'} ${stamp}.${extension}`).catch((err) => {
    console.error(err);
    toast('파일을 저장하지 못했습니다.');
  });
}

async function removeRecording(recording) {
  const yes = await confirmDialog({
    title: '녹음을 삭제할까요?',
    message: `${formatDate(recording.createdAt)} 녹음이 지워지며, 되돌릴 수 없습니다.`,
    ok: '삭제',
    danger: true,
  });
  if (!yes) return;
  if (playing?.id === recording.id) stopPlayback();
  await db.deleteRecording(recording.id);
  await renderList();
}

/* ---------- 목록 ---------- */

function recordingRow(recording) {
  const row = document.createElement('li');
  row.className = 'rec-row';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'tb rec-play';
  play.setAttribute('aria-label', '재생');
  play.append(icon('play'));
  play.addEventListener('click', () => togglePlay(recording, row));

  const info = document.createElement('div');
  info.className = 'rec-info';
  const when = document.createElement('div');
  when.className = 'rec-when';
  when.textContent = formatDate(recording.createdAt);
  const length = document.createElement('div');
  length.className = 'rec-length';
  length.textContent = formatTime(recording.duration);
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'rec-seek';
  seek.min = 0;
  seek.step = 0.1;
  seek.value = 0;
  seek.hidden = true;
  seek.setAttribute('aria-label', '재생 위치');
  seek.addEventListener('input', () => {
    player.currentTime = Number(seek.value);
  });
  info.append(when, length, seek);

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'tb';
  download.title = '파일로 저장';
  download.setAttribute('aria-label', '파일로 저장');
  download.append(icon('download'));
  download.addEventListener('click', () => saveToFile(recording));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tb';
  remove.title = '삭제';
  remove.setAttribute('aria-label', '삭제');
  remove.append(icon('trash'));
  remove.addEventListener('click', () => removeRecording(recording));

  row.append(play, info, download, remove);
  return row;
}

async function renderList() {
  const id = scoreId;
  stopPlayback();
  const recordings = id ? await db.listRecordings(id) : [];
  if (id !== scoreId) return;
  recordings.sort((a, b) => b.createdAt - a.createdAt);
  els.list.replaceChildren(...recordings.map(recordingRow));
  els.empty.hidden = recordings.length > 0;
}

function setPanelOpen(open) {
  if (open && !$('trackPanel').hidden) $('trackClose').click();
  els.panel.hidden = !open;
  els.toggle.classList.toggle('active', open);
  els.toggle.setAttribute('aria-pressed', open);
  if (open) renderList().catch(console.error);
  else stopPlayback();
}

/* ---------- 앱과 연결 ---------- */

export function setRecorderScore(id) {
  scoreId = id;
}

// 악보를 닫을 때 호출합니다. 녹음 중이면 저장까지 마칩니다.
export async function closeRecorder() {
  if (!els) return;
  await stopRecording();
  setPanelOpen(false);
  scoreId = null;
}

export function initRecorder() {
  els = {
    toggle: $('toggleRecorder'),
    panel: $('recPanel'),
    close: $('recClose'),
    main: $('recMain'),
    mainText: $('recMainText'),
    time: $('recTime'),
    list: $('recList'),
    empty: $('recEmpty'),
    pill: $('recPill'),
    pillTime: $('recPillTime'),
    title: $('viewerTitle'),
  };
  els.toggle.addEventListener('click', () => setPanelOpen(els.panel.hidden));
  els.close.addEventListener('click', () => setPanelOpen(false));
  els.main.addEventListener('click', () => (session ? stopRecording() : startRecording()));
  els.pill.addEventListener('click', () => stopRecording());

  player.addEventListener('timeupdate', () => {
    if (playing) playing.row.querySelector('.rec-seek').value = player.currentTime;
  });
  player.addEventListener('play', refreshPlayerUi);
  player.addEventListener('pause', refreshPlayerUi);
  player.addEventListener('ended', stopPlayback);

  // 다른 앱으로 넘어가면 녹음이 끊기거나 앱이 종료될 수 있어 먼저 저장합니다.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRecording({ message: '앱을 벗어나 녹음을 저장했습니다.' });
      player.pause();
    }
  });
}
