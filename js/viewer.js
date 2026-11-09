import * as db from './db.js';
import { loadPdf } from './pdf.js';
import { toast, confirmDialog } from './ui.js';

const $ = (id) => document.getElementById(id);

const COLORS = ['#d32f2f', '#1565c0', '#2e7d32', '#111111', '#ffd600'];
const DEFAULT_COLOR = { pen: '#d32f2f', hl: '#ffd600', text: '#1565c0' };
// 페이지 너비에 대한 비율이라, 확대하거나 기기가 달라져도 같은 모양으로 보입니다.
const SIZES = {
  pen: [0.002, 0.004, 0.007],
  hl: [0.012, 0.02, 0.03],
  text: [0.018, 0.026, 0.038],
};
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari 캔버스 한도(약 16.7MP) 이내
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;
const ERASER_RADIUS = 12;
const PEN_SEEN_KEY = 'score-viewer:pen-seen';

const S = {
  score: null,
  doc: null,
  page: 1,
  count: 0,
  zoom: 1,
  tool: 'view',
  color: { ...DEFAULT_COLOR },
  sizeIndex: 1,
  items: [],
  ready: false,
  history: new Map(),
  chromeHidden: false,
  penSeen: false,
};

let els;
let inkCtx;
const committed = document.createElement('canvas');
let current = null; // 그리는 중인 획
let action = null; // 진행 중인 포인터 동작
let showToken = 0;
let openToken = 0;
const sizes = new Map(); // 쪽 번호 -> 원본 크기
const renderCache = new Map();
let progressTimer;
let resizeTimer;
let paintQueued = false;

/* ---------- PDF 렌더링 ---------- */

async function metric(n) {
  const { doc } = S;
  if (!doc) throw new Error('document closed');
  let size = sizes.get(n);
  if (!size) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    size = { w: vp.width, h: vp.height };
    sizes.set(n, size);
  }
  const fit = Math.min(els.stage.clientWidth / size.w, els.stage.clientHeight / size.h);
  const cssScale = Math.max(fit, 0.05) * S.zoom;
  const cssW = Math.floor(size.w * cssScale);
  const cssH = Math.floor(size.h * cssScale);
  const dpr = window.devicePixelRatio || 1;
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / (size.w * size.h));
  const pixelScale = Math.min(cssScale * dpr, cap);
  return { n, cssW, cssH, pixelScale, key: `${n}@${pixelScale.toFixed(3)}` };
}

function getRendered(m) {
  const cached = renderCache.get(m.key);
  if (cached) return cached.promise;

  const canvas = document.createElement('canvas');
  const entry = { canvas, task: null, cancelled: false, promise: null };
  entry.promise = S.doc.getPage(m.n).then(async (page) => {
    if (entry.cancelled) throw new Error('cancelled');
    const viewport = page.getViewport({ scale: m.pixelScale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    entry.task = page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
    });
    await entry.task.promise;
    return canvas;
  });
  entry.promise.catch(() => renderCache.delete(m.key));
  renderCache.set(m.key, entry);
  return entry.promise;
}

function evict(keep) {
  for (const [key, entry] of renderCache) {
    if (keep.has(key)) continue;
    entry.cancelled = true;
    entry.task?.cancel();
    entry.canvas.width = 0;
    renderCache.delete(key);
  }
}

async function showPage(n, { keepScroll = false } = {}) {
  if (!S.doc) return;
  finishInteractions();
  n = Math.min(Math.max(n, 1), S.count);
  const token = ++showToken;
  const samePage = n === S.page && S.ready;
  S.page = n;
  S.ready = samePage;
  updateChrome();
  scheduleProgressSave();

  const spinner = setTimeout(() => { els.stageMsg.hidden = false; }, 250);
  try {
    const pages = [n, n + 1, n - 1].filter((p) => p >= 1 && p <= S.count);
    const metrics = await Promise.all(pages.map(metric));
    if (token !== showToken) return;
    evict(new Set(metrics.map((m) => m.key)));

    const m = metrics[0];
    const [canvas, items] = await Promise.all([
      getRendered(m),
      samePage ? S.items : db.getNotes(S.score.id, n),
    ]);
    if (token !== showToken) return;

    els.sheet.style.width = `${m.cssW}px`;
    els.sheet.style.height = `${m.cssH}px`;
    els.pdf.width = canvas.width;
    els.pdf.height = canvas.height;
    els.pdf.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
    els.ink.width = canvas.width;
    els.ink.height = canvas.height;
    committed.width = canvas.width;
    committed.height = canvas.height;
    els.sheet.hidden = false;

    if (!samePage) S.items = items;
    S.ready = true;
    rebuildCommitted();
    paint();
    updateHistoryButtons();
    if (!keepScroll) els.stage.scrollTo(0, 0);

    for (const other of metrics.slice(1)) getRendered(other).catch(() => {});
  } catch (err) {
    if (token === showToken && S.doc) {
      console.error(err);
      toast('이 쪽을 표시하지 못했습니다.');
    }
  } finally {
    clearTimeout(spinner);
    if (token === showToken) els.stageMsg.hidden = true;
  }
}

/* ---------- 필기 그리기 ---------- */

function drawItem(ctx, item, W, H) {
  ctx.save();
  if (item.t === 'text') {
    ctx.fillStyle = item.c;
    ctx.font = `600 ${item.s * W}px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(item.text, item.x * W, item.y * H);
    ctx.restore();
    return;
  }
  const { p } = item;
  const width = item.w * W;
  ctx.strokeStyle = item.c;
  ctx.fillStyle = item.c;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (item.t === 'hl') ctx.globalAlpha = 0.4;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0] * W, p[1] * H, width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(p[0] * W, p[1] * H);
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = ((p[i] + p[i + 2]) / 2) * W;
      const my = ((p[i + 1] + p[i + 3]) / 2) * H;
      ctx.quadraticCurveTo(p[i] * W, p[i + 1] * H, mx, my);
    }
    ctx.lineTo(p[p.length - 2] * W, p[p.length - 1] * H);
    ctx.stroke();
  }
  ctx.restore();
}

function rebuildCommitted() {
  const ctx = committed.getContext('2d');
  ctx.clearRect(0, 0, committed.width, committed.height);
  for (const item of S.items) drawItem(ctx, item, committed.width, committed.height);
}

function paint() {
  paintQueued = false;
  const { width: W, height: H } = els.ink;
  if (!W || !H) return;
  inkCtx.clearRect(0, 0, W, H);
  inkCtx.drawImage(committed, 0, 0);
  if (current) drawItem(inkCtx, current, W, H);
}

function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paint);
}

/* ---------- 필기 기록 (되돌리기, 저장) ---------- */

function pageHistory() {
  let h = S.history.get(S.page);
  if (!h) {
    h = { undo: [], redo: [] };
    S.history.set(S.page, h);
  }
  return h;
}

function saveItems() {
  db.saveNotes(S.score.id, S.page, S.items).catch((err) => {
    console.error(err);
    toast('필기를 저장하지 못했습니다.');
  });
}

function rememberForUndo() {
  const h = pageHistory();
  h.undo.push(S.items);
  if (h.undo.length > 100) h.undo.shift();
  h.redo = [];
}

function commitItems(items) {
  rememberForUndo();
  S.items = items;
  afterItemsChange();
}

function afterItemsChange() {
  saveItems();
  rebuildCommitted();
  paint();
  updateHistoryButtons();
}

function undo() {
  finishInteractions();
  const h = pageHistory();
  if (!S.ready || !h.undo.length) return;
  h.redo.push(S.items);
  S.items = h.undo.pop();
  afterItemsChange();
}

function redo() {
  finishInteractions();
  const h = pageHistory();
  if (!S.ready || !h.redo.length) return;
  h.undo.push(S.items);
  S.items = h.redo.pop();
  afterItemsChange();
}

async function clearPage() {
  finishInteractions();
  if (!S.ready || !S.items.length) return;
  const page = S.page;
  const yes = await confirmDialog({
    title: `${page}쪽의 필기를 모두 지울까요?`,
    ok: '모두 지우기',
    danger: true,
  });
  if (yes && S.ready && S.page === page) commitItems([]);
}

/* ---------- 지우개 ---------- */

function hitsItem(item, x, y, rect) {
  const W = rect.width;
  const H = rect.height;
  const px = x * W;
  const py = y * H;
  if (item.t === 'text') {
    inkCtx.save();
    inkCtx.font = `600 ${item.s * W}px ${FONT}`;
    const textW = inkCtx.measureText(item.text).width;
    inkCtx.restore();
    const left = item.x * W;
    const top = item.y * H;
    return px > left - ERASER_RADIUS && px < left + textW + ERASER_RADIUS
      && py > top - ERASER_RADIUS && py < top + item.s * W * 1.25 + ERASER_RADIUS;
  }
  const reach = ERASER_RADIUS + (item.w * W) / 2;
  const { p } = item;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i] * W;
    const ay = p[i + 1] * H;
    const bx = (i + 3 < p.length ? p[i + 2] : p[i]) * W;
    const by = (i + 3 < p.length ? p[i + 3] : p[i + 1]) * H;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= reach) return true;
  }
  return false;
}

// 빠르게 움직여도 지나간 경로의 획이 빠지지 않도록 중간 지점까지 검사합니다.
function eraseAlong(x, y) {
  const { rect } = action;
  const fromX = action.lastX ?? x;
  const fromY = action.lastY ?? y;
  const distance = Math.hypot((x - fromX) * rect.width, (y - fromY) * rect.height);
  const steps = Math.max(1, Math.ceil(distance / ERASER_RADIUS));
  for (let i = 1; i <= steps; i += 1) {
    eraseAt(fromX + ((x - fromX) * i) / steps, fromY + ((y - fromY) * i) / steps);
  }
  action.lastX = x;
  action.lastY = y;
}

function eraseAt(x, y) {
  const kept = S.items.filter((item) => !hitsItem(item, x, y, action.rect));
  if (kept.length === S.items.length) return;
  if (!action.erased) {
    rememberForUndo();
    action.erased = true;
  }
  S.items = kept;
  rebuildCommitted();
  queuePaint();
}

/* ---------- 글자 메모 ---------- */

function openTextEntry(x, y) {
  const size = SIZES.text[S.sizeIndex];
  const input = els.textEntry;
  input.value = '';
  input.dataset.x = x;
  input.dataset.y = y;
  input.dataset.page = S.page;
  input.style.left = `${x * 100}%`;
  input.style.top = `${y * 100}%`;
  input.style.color = S.color.text;
  input.style.fontSize = `max(16px, ${size * els.ink.getBoundingClientRect().width}px)`;
  input.hidden = false;
  input.focus();
}

function commitTextEntry() {
  const input = els.textEntry;
  if (input.hidden) return false;
  input.hidden = true;
  const text = input.value.trim();
  if (!text || Number(input.dataset.page) !== S.page || !S.ready) return true;

  const s = SIZES.text[S.sizeIndex];
  const W = els.ink.width;
  inkCtx.save();
  inkCtx.font = `600 ${s * W}px ${FONT}`;
  const widthRatio = inkCtx.measureText(text).width / W;
  inkCtx.restore();
  const x = Math.max(0, Math.min(Number(input.dataset.x), 1 - widthRatio));
  commitItems([...S.items, { t: 'text', c: S.color.text, s, x, y: Number(input.dataset.y), text }]);
  return true;
}

/* ---------- 포인터 입력 ---------- */

const round = (v) => Math.round(v * 100000) / 100000;

function rememberPen() {
  if (S.penSeen) return;
  S.penSeen = true;
  try { localStorage.setItem(PEN_SEEN_KEY, '1'); } catch { /* 저장 못 해도 이번 실행에는 적용됩니다 */ }
}

function cancelTouchAction() {
  if (action.kind === 'eraser') {
    finishInteractions();
    return;
  }
  current = null;
  action = null;
  queuePaint();
}

function normalized(e, rect) {
  return [
    Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  ];
}

function onPointerDown(e) {
  if (e.target === els.textEntry) return;
  if (e.pointerType === 'pen') {
    rememberPen();
    // 손바닥이 먼저 닿아 있어도 펜 획이 무시되지 않도록 손가락 동작을 취소합니다.
    if (action?.pointerType === 'touch') cancelTouchAction();
  }
  if (action || (e.pointerType === 'mouse' && e.button !== 0)) return;

  // 글자 입력 중 다른 곳을 누르면 입력만 마칩니다.
  if (commitTextEntry()) {
    e.preventDefault();
    return;
  }

  const rect = els.ink.getBoundingClientRect();
  const onSheet = !els.sheet.hidden && e.clientX >= rect.left && e.clientX <= rect.right
    && e.clientY >= rect.top && e.clientY <= rect.bottom;
  // 펜을 쓰는 기기에서는 손바닥이 닿아도 그려지지 않도록 손가락 입력을 무시합니다.
  const drawsWithThis = !(e.pointerType === 'touch' && S.penSeen);

  if (S.tool !== 'view' && onSheet && drawsWithThis && S.ready) {
    e.preventDefault();
    action = { kind: S.tool, id: e.pointerId, pointerType: e.pointerType, rect, erased: false };
    els.stage.setPointerCapture(e.pointerId);
    const [x, y] = normalized(e, rect);
    if (S.tool === 'eraser') {
      eraseAlong(x, y);
    } else if (S.tool === 'pen' || S.tool === 'hl') {
      current = {
        t: S.tool,
        c: S.color[S.tool],
        w: SIZES[S.tool][S.sizeIndex],
        p: [round(x), round(y)],
      };
      queuePaint();
    } else if (S.tool === 'text') {
      action.x = x;
      action.y = y;
    }
    return;
  }

  // 확대했을 때 나타나는 스크롤바를 눌러도 쪽이 넘어가지 않게 합니다.
  const stageRect = els.stage.getBoundingClientRect();
  if (e.clientX >= stageRect.left + els.stage.clientWidth
      || e.clientY >= stageRect.top + els.stage.clientHeight) return;

  // 화면 밖에서 손을 떼도 pointerup을 받도록 붙잡아 둡니다.
  els.stage.setPointerCapture(e.pointerId);
  action = {
    kind: 'gesture',
    id: e.pointerId,
    pointerType: e.pointerType,
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    startTime: performance.now(),
  };
}

function onPointerMove(e) {
  if (!action || e.pointerId !== action.id) return;

  if (action.kind === 'gesture') {
    // 필기 모드에서는 브라우저 스크롤이 꺼져 있어 손가락 이동을 직접 반영합니다.
    if (S.tool !== 'view' && action.pointerType === 'touch') {
      els.stage.scrollBy(action.lastX - e.clientX, action.lastY - e.clientY);
    }
    action.lastX = e.clientX;
    action.lastY = e.clientY;
    return;
  }

  const events = e.getCoalescedEvents?.() ?? [];
  for (const ev of events.length ? events : [e]) {
    const [x, y] = normalized(ev, action.rect);
    if (action.kind === 'eraser') {
      eraseAlong(x, y);
    } else if (current) {
      const n = current.p.length;
      const moved = Math.hypot(
        (x - current.p[n - 2]) * action.rect.width,
        (y - current.p[n - 1]) * action.rect.height,
      );
      if (moved >= 0.6) current.p.push(round(x), round(y));
    }
  }
  if (current) queuePaint();
}

function onPointerUp(e) {
  if (!action || e.pointerId !== action.id) return;
  const done = action;

  if (done.kind === 'gesture') {
    action = null;
    if (e.type === 'pointerup') handleGestureEnd(done, e);
    return;
  }
  if (done.kind === 'text') {
    action = null;
    if (e.type === 'pointerup') {
      e.preventDefault();
      openTextEntry(done.x, done.y);
    }
    return;
  }
  finishInteractions();
}

function handleGestureEnd(gesture, e) {
  // 필기 모드에서는 손바닥이 닿아 쪽이 넘어가는 일이 없도록 넘기지 않습니다.
  if (S.tool !== 'view') return;

  const dx = e.clientX - gesture.startX;
  const dy = e.clientY - gesture.startY;
  const moved = Math.hypot(dx, dy);
  const elapsed = performance.now() - gesture.startTime;

  if (gesture.pointerType === 'touch' && S.zoom === 1
      && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    showPage(S.page + (dx < 0 ? 1 : -1));
    return;
  }
  if (moved > 10 || elapsed > 500) return;

  const rect = els.stage.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  if (ratio < 0.3) showPage(S.page - 1);
  else if (ratio > 0.7) showPage(S.page + 1);
  else setChromeHidden(!S.chromeHidden);
}

// 그리던 획이나 지우개 동작을 마무리해 저장합니다.
function finishInteractions() {
  if (action && (action.kind === 'pen' || action.kind === 'hl') && current) {
    const stroke = current;
    current = null;
    commitItems([...S.items, stroke]);
  } else if (action?.kind === 'eraser' && action.erased) {
    saveItems();
    updateHistoryButtons();
  }
  if (action && els.stage.hasPointerCapture?.(action.id)) {
    els.stage.releasePointerCapture(action.id);
  }
  action = null;
  current = null;
  commitTextEntry();
}

/* ---------- 도구막대 ---------- */

function updateChrome() {
  els.pageLabel.textContent = `${S.page} / ${S.count}`;
  els.slider.max = S.count;
  els.slider.value = S.page;
  els.prev.disabled = S.page <= 1;
  els.next.disabled = S.page >= S.count;
  els.zoomLabel.textContent = `${Math.round(S.zoom * 100)}%`;
  els.zoomOut.disabled = S.zoom <= 1;
  els.zoomIn.disabled = S.zoom >= ZOOM_MAX;
  els.stage.classList.toggle('zoomed', S.zoom > 1);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const h = S.history.get(S.page);
  els.undo.disabled = !h?.undo.length;
  els.redo.disabled = !h?.redo.length;
  els.clear.disabled = !S.items.length;
}

function setChromeHidden(hidden) {
  S.chromeHidden = hidden;
  els.viewer.classList.toggle('immersive', hidden);
}

function setTool(tool) {
  finishInteractions();
  S.tool = tool;
  for (const btn of els.tools) {
    const on = btn.dataset.tool === tool;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on);
  }
  els.stage.classList.toggle('drawing', tool !== 'view');
  els.stage.classList.toggle('tool-text', tool === 'text');
  const hasOptions = tool === 'pen' || tool === 'hl' || tool === 'text';
  els.options.hidden = !hasOptions;
  if (hasOptions) refreshOptions();
}

function refreshOptions() {
  for (const swatch of els.swatches) {
    const on = swatch.dataset.color === S.color[S.tool];
    swatch.classList.toggle('active', on);
    swatch.setAttribute('aria-pressed', on);
  }
  for (const btn of els.sizeButtons) {
    const on = Number(btn.dataset.size) === S.sizeIndex;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on);
  }
}

function setZoom(zoom) {
  finishInteractions();
  const next = Math.min(ZOOM_MAX, Math.max(1, zoom));
  if (next === S.zoom) return;
  const { stage } = els;
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(stage.scrollWidth, 1);
  const cy = (stage.scrollTop + stage.clientHeight / 2) / Math.max(stage.scrollHeight, 1);
  S.zoom = next;
  updateChrome();
  showPage(S.page, { keepScroll: true }).then(() => {
    stage.scrollTo(
      cx * stage.scrollWidth - stage.clientWidth / 2,
      cy * stage.scrollHeight - stage.clientHeight / 2,
    );
  });
}

function buildOptions() {
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.color = color;
    btn.style.setProperty('--swatch', color);
    btn.setAttribute('aria-label', `색상 ${color}`);
    btn.addEventListener('click', () => {
      S.color[S.tool] = color;
      refreshOptions();
    });
    els.colors.append(btn);
  }
  els.swatches = [...els.colors.children];
  els.sizeButtons = [...document.querySelectorAll('[data-size]')];
  for (const btn of els.sizeButtons) {
    btn.addEventListener('click', () => {
      S.sizeIndex = Number(btn.dataset.size);
      refreshOptions();
    });
  }
}

/* ---------- 진행 위치 저장 ---------- */

async function saveProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  const { score, page } = S;
  if (!score || score.lastPage === page) return;
  score.lastPage = page;
  const stored = await db.getScore(score.id);
  if (stored) await db.putScore({ ...stored, lastPage: page });
}

function scheduleProgressSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => saveProgress().catch(console.error), 400);
}

/* ---------- 키보드 (블루투스 페달 포함) ---------- */

function onKeyDown(e) {
  if (els.viewer.hidden || !S.doc || $('dlg').open) return;
  if (e.target.matches?.('input[type="text"], input:not([type])')) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTextEntry();
    } else if (e.key === 'Escape') {
      els.textEntry.value = '';
      commitTextEntry();
    }
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.zoom * ZOOM_STEP); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(S.zoom / ZOOM_STEP); return; }
  if (mod || e.altKey) return;

  const turns = {
    ArrowLeft: -1, ArrowUp: -1, PageUp: -1,
    ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1,
  };
  if (e.key in turns && e.target !== els.slider) {
    e.preventDefault();
    showPage(S.page + turns[e.key]);
  } else if (e.key === 'Home') {
    e.preventDefault();
    showPage(1);
  } else if (e.key === 'End') {
    e.preventDefault();
    showPage(S.count);
  } else if (e.key === 'Escape') {
    if (S.tool !== 'view') setTool('view');
    else if (S.chromeHidden) setChromeHidden(false);
    else location.hash = '#/';
  }
}

/* ---------- 연주 중 화면 꺼짐 방지 ---------- */

let wakeLock = null;

async function keepScreenOn() {
  if (!navigator.wakeLock || !S.doc || document.hidden || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!S.doc) {
      lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch { /* 배터리 절약 모드 등에서는 거부될 수 있습니다 */ }
}

function allowScreenOff() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

/* ---------- 열기, 닫기 ---------- */

export async function openViewer(id) {
  const token = ++openToken;
  els.title.textContent = '';
  els.sheet.hidden = true;
  els.stageMsg.hidden = false;
  setChromeHidden(false);
  setTool('view');

  const [score, data] = await Promise.all([db.getScore(id), db.getFile(id)]);
  if (!score || !data) throw new Error('악보를 찾을 수 없습니다');
  const doc = await loadPdf(data);
  if (token !== openToken) {
    doc.destroy();
    return;
  }

  Object.assign(S, {
    score,
    doc,
    count: doc.numPages,
    page: Math.min(score.lastPage || 1, doc.numPages),
    zoom: 1,
    items: [],
    ready: false,
    history: new Map(),
  });
  els.title.textContent = score.name;
  document.title = `${score.name} - 악보함`;
  keepScreenOn();
  await db.putScore({ ...score, lastOpenedAt: Date.now() });
  if (token !== openToken) return;
  await showPage(S.page);
}

export async function closeViewer() {
  openToken += 1;
  showToken += 1;
  if (!S.doc) return;
  finishInteractions();
  allowScreenOff();
  await saveProgress().catch(console.error);
  const { doc } = S;
  S.doc = null;
  S.score = null;
  S.ready = false;
  S.items = [];
  evict(new Set());
  sizes.clear();
  els.pdf.width = 0;
  els.ink.width = 0;
  committed.width = 0;
  await doc.destroy();
}

export function initViewer() {
  els = {
    viewer: $('viewer'),
    stage: $('stage'),
    stageMsg: $('stageMsg'),
    sheet: $('sheet'),
    pdf: $('pdfCanvas'),
    ink: $('inkCanvas'),
    textEntry: $('textEntry'),
    title: $('viewerTitle'),
    tools: [...document.querySelectorAll('[data-tool]')],
    options: $('toolOptions'),
    colors: $('colors'),
    undo: $('undo'),
    redo: $('redo'),
    clear: $('clearPage'),
    zoomIn: $('zoomIn'),
    zoomOut: $('zoomOut'),
    zoomLabel: $('zoomLabel'),
    prev: $('prevPage'),
    next: $('nextPage'),
    slider: $('pageSlider'),
    pageLabel: $('pageLabel'),
  };
  inkCtx = els.ink.getContext('2d');
  buildOptions();
  try { S.penSeen = localStorage.getItem(PEN_SEEN_KEY) === '1'; } catch { /* 첫 펜 입력 때 다시 판단합니다 */ }
  // 다른 앱에 다녀오면 화면 꺼짐 방지가 풀리므로 다시 요청합니다.
  document.addEventListener('visibilitychange', keepScreenOn);

  for (const btn of els.tools) btn.addEventListener('click', () => setTool(btn.dataset.tool));
  els.undo.addEventListener('click', undo);
  els.redo.addEventListener('click', redo);
  els.clear.addEventListener('click', clearPage);
  els.zoomIn.addEventListener('click', () => setZoom(S.zoom * ZOOM_STEP));
  els.zoomOut.addEventListener('click', () => setZoom(S.zoom / ZOOM_STEP));
  els.zoomLabel.addEventListener('click', () => setZoom(1));
  els.prev.addEventListener('click', () => showPage(S.page - 1));
  els.next.addEventListener('click', () => showPage(S.page + 1));
  els.slider.addEventListener('input', () => showPage(Number(els.slider.value)));
  $('backToLibrary').addEventListener('click', () => { location.hash = '#/'; });

  // 버튼에 포커스가 남으면 페달의 스페이스 입력이 그 버튼을 다시 누르게 됩니다.
  els.viewer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) btn.blur();
  });

  els.stage.addEventListener('pointerdown', onPointerDown);
  els.stage.addEventListener('pointermove', onPointerMove);
  els.stage.addEventListener('pointerup', onPointerUp);
  els.stage.addEventListener('pointercancel', onPointerUp);
  els.stage.addEventListener('contextmenu', (e) => {
    if (S.tool !== 'view') e.preventDefault();
  });
  els.textEntry.addEventListener('blur', () => commitTextEntry());
  addEventListener('keydown', onKeyDown);
  addEventListener('pagehide', () => {
    finishInteractions();
    saveProgress().catch(console.error);
  });

  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (S.doc && !action) showPage(S.page, { keepScroll: true });
    }, 120);
  }).observe(els.stage);
}
