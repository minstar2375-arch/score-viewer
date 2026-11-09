// 마이크로 연습을 녹음해 악보별로 저장하고 다시 듣습니다.
import * as db from './db.js';
import { toast, hideToast, confirmDialog } from './ui.js';
import { saveBlob } from './platform.js';
import { setTrackSink, pausePractice } from './practice.js';

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
  const note = mixNote();
  els.note.textContent = note;
  els.note.hidden = !note;
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

/* ---------- 음원 소리 섞기 ---------- */

// 연습 음원의 복사본을 받아 마이크 소리와 섞습니다. 음원 재생 경로는 건드리지 않습니다.
const TRACK_LEVEL = 0.6; // 목소리가 묻히지 않을 만큼 줄입니다.
const RESUME_WAIT_MS = 1500;

let mix = null; // { context, trackGain, sources }
let currentTrack = null; // { element, kind }

function disconnectTrack() {
  if (!mix) return;
  for (const source of mix.sources) source.disconnect();
  mix.sources = [];
  mix.stream?.removeEventListener('addtrack', mix.onAddTrack);
  mix.stream = null;
}

function connectTrack() {
  if (!mix) return;
  disconnectTrack();
  const element = currentTrack?.element;
  if (!element?.captureStream) return;
  try {
    const stream = element.captureStream();
    const known = new Set();
    // 음원을 다시 재생하면 새 트랙이 생기기도 해서 그때마다 연결합니다.
    const attach = () => {
      if (!mix) return;
      for (const track of stream.getAudioTracks()) {
        if (known.has(track.id)) continue;
        known.add(track.id);
        const source = mix.context.createMediaStreamSource(new MediaStream([track]));
        source.connect(mix.trackGain);
        mix.sources.push(source);
      }
    };
    mix.stream = stream;
    mix.onAddTrack = attach;
    stream.addEventListener('addtrack', attach);
    attach();
  } catch (err) {
    console.warn('음원을 녹음에 섞지 못했습니다', err);
  }
}

async function prepareMix(context, resumed, micStream) {
  if (!context) return micStream;
  // 오디오가 멈춘 채 녹음되면 무음 파일이 되므로, 준비되지 않으면 마이크만 녹음합니다.
  await Promise.race([resumed, new Promise((resolve) => { setTimeout(resolve, RESUME_WAIT_MS); })]);
  if (context.state !== 'running') {
    context.close().catch(() => {});
    return micStream;
  }
  const output = context.createMediaStreamDestination();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 12;
  limiter.connect(output);
  context.createMediaStreamSource(micStream).connect(limiter);
  const trackGain = context.createGain();
  trackGain.gain.value = TRACK_LEVEL;
  trackGain.connect(limiter);
  mix = { context, trackGain, sources: [], stream: null, onAddTrack: null };
  connectTrack();
  return output.stream;
}

function closeMix() {
  if (!mix) return;
  disconnectTrack();
  mix.context.close().catch(() => {});
  mix = null;
}

function onTrackChange(track) {
  currentTrack = track;
  connectTrack();
  refreshRecordingUi();
}

function mixNote() {
  if (!session || !currentTrack) return '';
  if (currentTrack.kind === 'youtube') return 'YouTube 곡은 함께 녹음되지 않습니다. 스피커 소리만 마이크로 들어갑니다.';
  if (mix && currentTrack.element?.captureStream) return '재생하는 음원도 함께 녹음됩니다.';
  return '';
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

  // 소리 재생 권한을 받을 수 있도록 버튼을 누른 순간에 만듭니다.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const mixContext = AudioCtx ? new AudioCtx({ latencyHint: 'interactive' }) : null;
  const resumed = mixContext?.resume().catch(() => {});

  let stream;
  try {
    // 음성 통화용 처리를 끄면 악기 소리가 덜 뭉개집니다.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (scoreId !== forScore) {
      stream.getTracks().forEach((track) => track.stop());
      mixContext?.close().catch(() => {});
      return;
    }
    const recordStream = await prepareMix(mixContext, resumed, stream);
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(recordStream, {
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
    closeMix();
    mixContext?.close().catch(() => {});
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
      closeMix();
      clearInterval(timer);
      session = null;
      refreshRecordingUi();
      const type = current.recorder.mimeType || current.chunks[0]?.type || 'audio/webm';
      const blob = new Blob(current.chunks, { type });
      try {
        if (duration >= MIN_SECONDS && blob.size) {
          const saved = {
            id: newId(), scoreId: current.scoreId, createdAt: Date.now(), duration, type, blob,
          };
          // 원본을 먼저 저장해 두어 변환 중 앱이 닫혀도 녹음이 남습니다.
          await db.addRecording(saved);
          toast(message);
          ensureMp3(saved).then(() => {
            if (current.scoreId === scoreId && !els.panel.hidden && !playing) renderList().catch(console.error);
          });
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

/* ---------- MP3로 바꾸기 ---------- */

// MP3는 길이 정보가 정확해 재생 막대가 안정적이고, 다른 앱과 기기에서도 잘 열립니다.
const MP3_RATE = 44100;
const MP3_KBPS = 96;
const converting = new Map(); // 녹음 ID -> 변환 중인 Promise
const convertedResults = new Map(); // 녹음 ID -> 변환 결과
const failedConversions = new Set(); // 이번 실행에서 변환에 실패한 녹음 ID

const isMp3 = (recording) => recording.type === 'audio/mpeg';

async function encodeMp3(blob) {
  const context = new OfflineAudioContext(1, 1, MP3_RATE);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const samples = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c += 1) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) samples[i] += data[i] / decoded.numberOfChannels;
  }
  const { duration } = decoded;
  const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
  try {
    const mp3 = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.blob));
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ samples, sampleRate: MP3_RATE, kbps: MP3_KBPS }, [samples.buffer]);
    });
    return { blob: mp3, duration };
  } finally {
    worker.terminate();
  }
}

// 변환에 실패하면 원본을 그대로 씁니다. 녹음은 사라지지 않습니다.
function ensureMp3(recording) {
  const done = convertedResults.get(recording.id);
  if (done) Object.assign(recording, done);
  if (isMp3(recording)) return Promise.resolve(true);
  // 실패한 변환을 누를 때마다 되풀이하면 공유 허용 시간이 계속 지나 버립니다. 앱을 다시 열면 재시도합니다.
  if (failedConversions.has(recording.id)) return Promise.resolve(false);
  let job = converting.get(recording.id);
  if (!job) {
    job = encodeMp3(recording.blob)
      .then(async ({ blob, duration }) => {
        const result = { blob, duration, type: 'audio/mpeg' };
        await db.addRecording({ ...recording, ...result });
        convertedResults.set(recording.id, result);
        return true;
      })
      .catch((err) => {
        console.warn('MP3 변환 실패', err);
        failedConversions.add(recording.id);
        return false;
      })
      .finally(() => converting.delete(recording.id));
    converting.set(recording.id, job);
  }
  return job.then((ok) => {
    const result = convertedResults.get(recording.id);
    if (result) Object.assign(recording, result);
    return ok;
  });
}

/* ---------- 다시 듣기 ---------- */

let draggingSeek = false;

function stopPlayback() {
  playToken += 1;
  player.pause();
  draggingSeek = false;
  if (playing) {
    URL.revokeObjectURL(playing.url);
    setRowPlaying(playing.row, false);
    playing = null;
  }
  player.removeAttribute('src');
}

let playToken = 0;

function setRowPlaying(row, on) {
  row.classList.toggle('playing', on);
  const btn = row.querySelector('.rec-play');
  btn.replaceChildren(icon(on ? 'pause' : 'play'));
  btn.setAttribute('aria-label', on ? '일시정지' : '재생');
  row.querySelector('.rec-seek').hidden = !on;
  if (!on) row.querySelector('.rec-length').textContent = formatTime(row.recordingDuration);
}

function playDuration() {
  return Number.isFinite(player.duration) && player.duration > 0 ? player.duration : playing.duration;
}

function refreshPosition() {
  if (!playing) return;
  const seek = playing.row.querySelector('.rec-seek');
  const duration = playDuration();
  seek.max = duration;
  if (!draggingSeek) seek.value = player.currentTime;
  const shown = draggingSeek ? Number(seek.value) : player.currentTime;
  playing.row.querySelector('.rec-length').textContent = `${formatTime(shown)} / ${formatTime(duration)}`;
}

async function togglePlay(recording, row) {
  if (session || starting) return;
  if (playing?.id === recording.id) {
    if (player.paused) player.play().catch(console.error);
    else player.pause();
    return;
  }
  stopPlayback();
  pausePractice(); // 연습 음원과 겹쳐 들리지 않게 합니다.
  const token = playToken;

  const btn = row.querySelector('.rec-play');
  if (!isMp3(recording) && !convertedResults.has(recording.id)) {
    btn.disabled = true;
    toast('재생 준비 중…', { sticky: true });
    await ensureMp3(recording);
    btn.disabled = false;
    hideToast();
    if (token !== playToken) return;
  } else {
    await ensureMp3(recording);
  }

  const url = URL.createObjectURL(recording.blob);
  row.recordingDuration = recording.duration;
  playing = { id: recording.id, url, duration: recording.duration, row };
  const seek = row.querySelector('.rec-seek');
  seek.max = recording.duration;
  seek.value = 0;
  setRowPlaying(row, true);
  refreshPosition();
  player.src = url;
  player.play().catch((err) => {
    console.error(err);
    stopPlayback();
    // 변환을 기다리는 동안 브라우저의 재생 허용 시간이 지나면 여기로 옵니다.
    toast(err?.name === 'NotAllowedError' ? '준비됐습니다. 재생 버튼을 한 번 더 눌러 주세요.' : '녹음을 재생하지 못했습니다.');
  });
}

function refreshPlayerUi() {
  if (!playing) return;
  const btn = playing.row.querySelector('.rec-play');
  btn.replaceChildren(icon(player.paused ? 'play' : 'pause'));
  btn.setAttribute('aria-label', player.paused ? '재생' : '일시정지');
}

function recordingFileName(recording) {
  const extension = isMp3(recording) ? 'mp3' : recording.type.includes('mp4') ? 'm4a' : 'weba';
  const date = new Date(recording.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  // 파일 이름에 쓸 수 없는 글자가 있으면 공유나 저장이 거부될 수 있습니다.
  const title = (els.title.textContent || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\.{2,}/g, '.') // 안드로이드 Chrome은 이름에 ".."이 있으면 공유를 거부합니다.
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
    .slice(0, 60)
    .trim();
  return `${title || '녹음'} ${stamp}.${extension}`;
}

async function saveToFile(recording) {
  await ensureMp3(recording);
  saveBlob(recording.blob, recordingFileName(recording)).catch((err) => {
    console.error(err);
    toast('파일을 저장하지 못했습니다.');
  });
}

/* ---------- 다른 앱으로 공유 ---------- */

// 삼성 인터넷은 Chrome과 달리 음원 파일 공유를 거부하는 경우가 있어 Chrome으로 안내합니다.
const isSamsungBrowser = () => /SamsungBrowser/i.test(navigator.userAgent);

function openInChrome() {
  const link = document.createElement('a');
  link.href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  document.body.append(link);
  link.click();
  link.remove();
}

// 공유할 수 없을 때도 녹음을 꺼낼 수 있도록 파일로 저장합니다.
async function saveInsteadOfShare(recording, name, reason) {
  try {
    await saveBlob(recording.blob, name);
    if (isSamsungBrowser()) {
      const open = await confirmDialog({
        title: '삼성 인터넷이 공유를 거부했습니다',
        message: `녹음은 다운로드 폴더에 저장했으니, 내 파일 앱에서 그 파일을 공유하면 카카오톡으로 보낼 수 있습니다. 앱에서 바로 공유하려면 Chrome에서 악보함을 여세요. 악보와 녹음은 자동으로 옮겨지지 않으니 보관함의 ⋯ 메뉴에서 백업한 뒤 Chrome에서 복원하세요. (${reason})`,
        ok: 'Chrome에서 열기',
      });
      if (open) openInChrome();
      return;
    }
    toast(`공유 창을 열지 못해 파일로 저장했습니다. 다운로드 폴더에서 보낼 수 있습니다. (${reason})`, { duration: 7000 });
  } catch (err) {
    console.error(err);
    toast(`공유도 저장도 하지 못했습니다. (${reason})`, { duration: 7000 });
  }
}

async function shareRecording(recording, button) {
  const ready = isMp3(recording) || convertedResults.has(recording.id) || failedConversions.has(recording.id);
  if (!ready) {
    button.disabled = true;
    toast('공유 준비 중…', { sticky: true });
  }
  await ensureMp3(recording);
  button.disabled = false;
  if (!ready) hideToast();

  // 변환을 기다리는 동안 버튼을 누른 효력이 끝나면 공유 창을 열 수 없습니다.
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    toast('준비됐습니다. 공유 버튼을 한 번 더 눌러 주세요.', { duration: 5000 });
    return;
  }

  hideToast(); // 앞서 띄운 "한 번 더 눌러 주세요"가 남지 않게 합니다.
  const name = recordingFileName(recording);
  // 'audio/webm;codecs=opus'처럼 뒤에 붙은 정보가 있으면 공유가 거부될 수 있어 형식만 남깁니다.
  const baseType = recording.type.split(';')[0].trim();
  // 안드로이드 Chrome의 허용 목록에는 m4a가 audio/x-m4a로만 올라 있습니다.
  const type = baseType === 'audio/mp4' ? 'audio/x-m4a' : baseType;
  const data = { files: [new File([recording.blob], name, { type })] };
  // canShare가 없는 브라우저도 공유는 될 수 있으니 시도해 봅니다.
  if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
    await saveInsteadOfShare(recording, name, `공유 미지원, ${type}`);
    return;
  }
  try {
    await navigator.share(data);
  } catch (err) {
    if (err?.name === 'AbortError') return; // 사용자가 공유 창을 닫은 경우입니다.
    console.error(err);
    await saveInsteadOfShare(recording, name, `${err?.name || '알 수 없는 오류'}, ${type}`);
  }
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
  // 끄는 동안 재생 위치가 막대를 되돌리지 않게 합니다.
  seek.addEventListener('pointerdown', () => { draggingSeek = true; });
  seek.addEventListener('input', () => {
    player.currentTime = Number(seek.value);
    refreshPosition();
  });
  const endDrag = () => { draggingSeek = false; };
  seek.addEventListener('pointerup', endDrag);
  seek.addEventListener('pointercancel', endDrag);
  seek.addEventListener('change', endDrag);
  info.append(when, length, seek);
  row.recordingDuration = recording.duration;

  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'tb rec-share';
  share.title = '다른 앱으로 공유';
  share.setAttribute('aria-label', '다른 앱으로 공유');
  share.append(icon('share'));
  share.addEventListener('click', () => shareRecording(recording, share).catch(console.error));

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

  row.append(play, info, share, download, remove);
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
    note: $('recNote'),
    list: $('recList'),
    empty: $('recEmpty'),
    pill: $('recPill'),
    pillTime: $('recPillTime'),
    title: $('viewerTitle'),
  };
  setTrackSink(onTrackChange);
  els.toggle.addEventListener('click', () => setPanelOpen(els.panel.hidden));
  els.close.addEventListener('click', () => setPanelOpen(false));
  els.main.addEventListener('click', () => (session ? stopRecording() : startRecording()));
  els.pill.addEventListener('click', () => stopRecording());

  player.addEventListener('timeupdate', refreshPosition);
  player.addEventListener('durationchange', refreshPosition);
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
