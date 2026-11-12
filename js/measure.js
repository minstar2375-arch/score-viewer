// 한 마디의 음표와 쉼표를 찾아 순서와 길이(박자)를 계산합니다.
// 입력은 오선 하나를 가로로 길게 자른 띠 모양 그림의 잉크 표시(mask)이고,
// staff의 줄 위치도 그 띠 기준입니다. 길이 단위는 4분음표 = 1박입니다.
import { fillHoles } from './pitch.js';

const HEAD_FILL = 0.55; // 음표 머리 상자가 이만큼 채워져야 머리 후보로 봅니다.

/* ---------- 기본 도구 ---------- */

function lineRows(staff, h) {
  const rows = new Uint8Array(h);
  for (const line of staff.lines) {
    for (let y = Math.max(0, line.top); y <= Math.min(h - 1, line.bottom); y += 1) rows[y] = 1;
  }
  return rows;
}

// 오선 줄만 지운 그림. 줄을 가로지르는 기호(쉼표, 기둥 등)는 끊기지 않게 남깁니다.
function removeStaffLines(mask, w, h, staff) {
  const out = new Uint8Array(mask);
  for (const line of staff.lines) {
    const above = line.top - 1;
    const below = line.bottom + 1;
    for (let x = 0; x < w; x += 1) {
      const upInk = above >= 0 && mask[above * w + x];
      const downInk = below < h && mask[below * w + x];
      if (upInk || downInk) continue;
      for (let y = Math.max(0, line.top); y <= Math.min(h - 1, line.bottom); y += 1) out[y * w + x] = 0;
    }
  }
  return out;
}

function summedArea(mask, w, h, skipRows) {
  const W1 = w + 1;
  const sat = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      if (!skipRows || !skipRows[y]) rowSum += mask[y * w + x];
      sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + rowSum;
    }
  }
  return (x0, y0, x1, y1) => {
    const a = Math.max(0, Math.min(w, x0));
    const b = Math.max(0, Math.min(h, y0));
    const c = Math.max(0, Math.min(w, x1));
    const d = Math.max(0, Math.min(h, y1));
    if (c <= a || d <= b) return 0;
    return sat[d * W1 + c] - sat[b * W1 + c] - sat[d * W1 + a] + sat[b * W1 + a];
  };
}

// (x, fromY)에서 dir 방향(-1 위, +1 아래)으로 끊기지 않고 이어진 세로 잉크 길이
function verticalRun(mask, w, h, x, fromY, dir, maxLen) {
  if (x < 0 || x >= w) return 0;
  let gap = 0;
  let last = fromY;
  for (let y = fromY; y >= 0 && y < h && Math.abs(y - fromY) <= maxLen; y += dir) {
    if (mask[y * w + x]) {
      last = y;
      gap = 0;
    } else if (++gap > 2) break;
  }
  return Math.abs(last - fromY);
}

/* ---------- 오선의 시작과 끝, 마디줄 ---------- */

function staffExtent(mask, w, h, staff) {
  const rows = staff.lines.map((l) => Math.round(l.c));
  const on = (x) => rows.filter((y) => mask[y * w + x] || (y > 0 && mask[(y - 1) * w + x]) || (y + 1 < h && mask[(y + 1) * w + x])).length >= 4;
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x += 1) {
    if (on(x)) {
      if (left < 0) left = x;
      right = x;
    }
  }
  return { left, right };
}

// 오선 맨 위 줄부터 맨 아래 줄까지 거의 다 덮는 가는 세로줄을 마디줄로 봅니다.
// 음표 기둥도 길 수 있으므로, 끝에 음표 머리가 붙은 줄은 뺍니다(heads로 확인).
function findBarlines(mask, w, h, staff, heads) {
  const { s } = staff;
  const top = Math.round(staff.top);
  const bottom = Math.round(staff.bottom);
  const span = bottom - top + 1;
  const full = new Uint8Array(w);
  for (let x = 0; x < w; x += 1) {
    let n = 0;
    for (let y = top; y <= bottom; y += 1) n += mask[y * w + x];
    full[x] = n >= span * 0.92 ? 1 : 0;
  }
  const bars = [];
  for (let x = 0; x < w;) {
    if (!full[x]) {
      x += 1;
      continue;
    }
    let end = x;
    while (end + 1 < w && full[end + 1]) end += 1;
    const width = end - x + 1;
    const c = (x + end) / 2;
    const isStem = heads.some((hd) => hd.stem && Math.abs(hd.stem.x - c) <= Math.max(2, s * 0.3));
    if (width <= s * 0.7 && !isStem) bars.push(c);
    x = end + 1;
  }
  // 겹세로줄·끝세로줄처럼 붙어 있는 줄은 하나로 칩니다.
  const merged = [];
  for (const b of bars) {
    if (merged.length && b - merged[merged.length - 1] < s * 1.2) merged[merged.length - 1] = b;
    else merged.push(b);
  }
  return merged;
}

/* ---------- 음표 머리 ---------- */

function findAllHeads(mask, filled, clean, w, h, staff) {
  const { s } = staff;
  const skip = lineRows(staff, h);
  const linePrefix = new Int32Array(h + 1);
  for (let y = 0; y < h; y += 1) linePrefix[y + 1] = linePrefix[y] + skip[y];
  const box = summedArea(filled, w, h, skip);
  const bw = Math.max(3, Math.round(s * 1.1));
  const bh = Math.max(3, Math.round(s * 0.75));
  const stride = Math.max(1, Math.round(s / 5));
  const yTop = Math.max(0, Math.round(staff.top - s * 4.5));
  const yBottom = Math.min(h, Math.round(staff.bottom + s * 4.5));

  const candidates = [];
  for (let cy = yTop + bh / 2; cy <= yBottom - bh / 2; cy += stride) {
    for (let cx = bw / 2; cx <= w - bw / 2; cx += stride) {
      const x0 = Math.round(cx - bw / 2);
      const y0 = Math.round(cy - bh / 2);
      const usable = bh - (linePrefix[y0 + bh] - linePrefix[y0]);
      if (usable < bh * 0.4) continue;
      const fill = box(x0, y0, x0 + bw, y0 + bh) / (bw * usable);
      if (fill >= HEAD_FILL) candidates.push({ cx, cy, fill });
    }
  }
  candidates.sort((a, b) => b.fill - a.fill);
  const picked = [];
  for (const c of candidates) {
    if (picked.some((p) => Math.abs(p.cx - c.cx) < s * 0.9 && Math.abs(p.cy - c.cy) < s * 0.65)) continue;
    picked.push(c);
  }

  const heads = [];
  for (const p of picked) {
    const head = describeHead(mask, filled, clean, w, h, staff, p, skip);
    if (!head) continue;
    const twin = heads.find((o) => Math.abs(o.x - head.x) < s * 0.6 && Math.abs(o.y - head.y) < s * 0.4);
    if (twin) {
      if (!twin.stem && head.stem) Object.assign(twin, head);
      continue;
    }
    heads.push(head);
  }
  return heads;
}

function describeHead(mask, filled, clean, w, h, staff, p, skip) {
  const why = (reason, extra) => { globalThis.__measureDebug?.push({ x: p.cx, y: p.cy, fill: p.fill, reason, ...extra }); return null; };
  const { s } = staff;
  const bw = Math.round(s * 1.1);
  const bh = Math.round(s * 0.75);

  // 무게중심으로 위치를 다듬습니다.
  const x0 = Math.round(p.cx - bw / 2);
  const y0 = Math.round(p.cy - bh / 2);
  let total = 0;
  let sx = 0;
  let sy = 0;
  for (let y = y0; y < y0 + bh; y += 1) {
    if (y < 0 || y >= h || skip[y]) continue;
    for (let x = x0; x < x0 + bw; x += 1) {
      if (x >= 0 && x < w && filled[y * w + x]) {
        total += 1;
        sx += x;
        sy += y;
      }
    }
  }
  if (!total) return null;
  const cx = sx / total;
  let cy = sy / total;
  // 위아래로 붙은 화음의 맨 위·맨 아래 머리는 무게중심이 옆 머리 쪽으로 끌리므로,
  // 잉크가 끝나는 가장자리에서 머리 반 높이만큼 안쪽을 가운데로 잡습니다.
  {
    const ix = Math.round(cx);
    let top = Math.round(cy);
    let bottom = Math.round(cy);
    while (top - 1 >= 0 && cy - top < s * 3 && filled[(top - 1) * w + ix]) top -= 1;
    while (bottom + 1 < h && bottom - cy < s * 3 && filled[(bottom + 1) * w + ix]) bottom += 1;
    const span = bottom - top + 1;
    if (span <= s * 1.3) cy = (top + bottom) / 2;
    else if (bottom - cy < s * 0.95 && cy - top > bottom - cy + s * 0.3) cy = bottom - s * 0.46; // 화음 맨 아래 머리
    else if (cy - top < s * 0.95 && bottom - cy > cy - top + s * 0.3) cy = top + s * 0.46; // 화음 맨 위 머리
    // 가운데 머리는 무게중심을 그대로 씁니다.
  }
  // 화음처럼 머리가 붙어 있으면 무게중심이 옆 머리 쪽으로 끌리므로,
  // 가까운 줄·칸 위치 가운데 머리 상자가 가장 꽉 차는 높이를 고릅니다.
  {
    const half = s / 2;
    const k0 = Math.round((staff.bottom - cy) / half);
    let bestK = k0;
    let bestFill = -1;
    for (const k of [k0, k0 - 1, k0 + 1]) {
      const yk = staff.bottom - k * half;
      let n = 0;
      let c = 0;
      for (let y = Math.round(yk - bh / 2); y < Math.round(yk + bh / 2); y += 1) {
        if (y < 0 || y >= h || skip[y]) continue;
        for (let x = Math.round(cx - bw / 2); x < Math.round(cx + bw / 2); x += 1) {
          if (x < 0 || x >= w) continue;
          n += filled[y * w + x];
          c += 1;
        }
      }
      const fill = c ? n / c : 0;
      // 가장 가까운 칸을 기본으로 하고, 옆 칸이 확실히 더 꽉 찰 때만 옮깁니다.
      if (bestFill < 0 || fill > bestFill + 0.1) {
        bestFill = fill;
        bestK = k;
      }
    }
    cy = staff.bottom - bestK * half;
  }

  // 머리 모양 확인: 가운데를 세로로 가로지르는 잉크가 머리 높이(약 1칸)만큼,
  // 가로로 가로지르는 잉크가 머리 폭만큼이어야 합니다. 빔(납작하고 긺)이나 기둥(가늘고 긺)을 거릅니다.
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  const run = (x, y, dx, dy, limit) => {
    let n = 0;
    for (let i = 1; i <= limit; i += 1) {
      const px = x + dx * i;
      const py = y + dy * i;
      if (px < 0 || px >= w || py < 0 || py >= h || !filled[py * w + px]) break;
      n += 1;
    }
    return n;
  };
  if (!filled[iy * w + ix]) return why('center empty');
  // 화음은 머리가 위아래로 붙어 길어질 수 있어 위쪽 한계는 두지 않습니다(가는 기둥은 폭 검사에서 걸러집니다).
  const tallAt = (x) => (x >= 0 && x < w && filled[iy * w + x]
    ? run(x, iy, 0, -1, s * 2) + run(x, iy, 0, 1, s * 2) + 1 : 0);
  const talls = [-0.3, 0, 0.3].map((d) => tallAt(Math.round(ix + d * s))).sort((a, b) => a - b);
  const tall = talls[1];
  const up0 = run(ix, iy, 0, -1, s * 2);
  const down0 = run(ix, iy, 0, 1, s * 2);
  if (tall < s * 0.7) return why('short', { tall: tall / s });
  let wide = Infinity;
  for (const dy of [-0.22, 0.22]) {
    const y = Math.round(cy + dy * s);
    if (y < 0 || y >= h || skip[y] || !filled[y * w + ix]) continue;
    wide = Math.min(wide, run(ix, y, -1, 0, s * 3) + run(ix, y, 1, 0, s * 3) + 1);
  }
  if (wide !== Infinity && (wide < s * 0.8 || wide > s * 2.6)) return why('width', { wide: wide / s });
  // 모서리 확인: 머리(타원)는 자기 크기 상자의 모서리 둘 이상이 비고, 빔·쉼표 같은 네모는 꽉 찹니다.
  {
    const halfH = Math.min(up0, down0, s * 0.6);
    const left = run(ix, iy, -1, 0, s * 1.5);
    const right = run(ix, iy, 1, 0, s * 1.5);
    const halfW = Math.min(left, right, s * 0.8);
    let empty = 0;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = Math.round(ix + dx * halfW * 0.85);
      const y = Math.round(iy + dy * halfH * 0.85);
      if (x < 0 || x >= w || y < 0 || y >= h || skip[y] || !filled[y * w + x]) empty += 1;
    }
    if (halfH >= s * 0.3 && halfW >= s * 0.4 && empty < 1) return why('corners', { empty });
  }

  // 기둥: 위로 난 기둥은 머리 오른쪽, 아래로 난 기둥은 머리 왼쪽에 붙습니다.
  const findStem = (fromX, toX, dir) => {
    let best = null;
    for (let x = Math.round(fromX); x <= Math.round(toX); x += 1) {
      const len = verticalRun(clean, w, h, x, Math.round(cy - dir * s * 0.1), dir, s * 5);
      if (!best || len > best.len) best = { x, len };
    }
    return best;
  };
  const up = findStem(cx + s * 0.3, cx + s * 0.85, -1);
  const down = findStem(cx - s * 0.85, cx - s * 0.3, 1);
  const leftUp = findStem(cx - s * 0.85, cx - s * 0.3, -1);
  const STEM = s * 2.4;
  let stem = null;
  if (up.len >= STEM && up.len >= down.len) stem = { x: up.x, dir: -1, end: Math.round(cy - up.len) };
  else if (down.len >= STEM) stem = { x: down.x, dir: 1, end: Math.round(cy + down.len) };

  // 머리 가운데가 비어 있으면 2분·온음표입니다.
  let inner = 0;
  let innerCount = 0;
  const r = Math.max(1, Math.round(s * 0.18));
  for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y += 1) {
    if (y < 0 || y >= h || skip[y]) continue;
    for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x += 1) {
      if (x < 0 || x >= w) continue;
      inner += mask[y * w + x];
      innerCount += 1;
    }
  }
  const hollow = innerCount > 0 && inner / innerCount < 0.5;

  if (!stem && leftUp.len >= s * 1.2) return why('flat-like', { leftUp: leftUp.len / s });
  if (!stem) {
    // 기둥이 없는 것은 온음표만 인정합니다. 내림표(왼쪽 위로 곧은 줄)와 글자, 박자표 숫자를 거릅니다.
    if (!hollow) return { x: cx, y: cy, stem: null, hollow, chordOnly: true };
    if (leftUp.len >= s * 1.4) return null;
    const blob = blobSize(clean, w, h, Math.round(cx), Math.round(cy), s * 3);
    if (blob.h > s * 1.4 || blob.w < s * 1.1) return null;
  }

  const head = { x: cx, y: cy, stem, hollow };
  head.flags = stem && !hollow ? countFlags(clean, w, h, staff, stem) : 0;
  head.dot = hasDot(clean, w, h, staff, cx, cy);
  return head;
}

// 한 점에서 이어진 잉크 덩어리의 크기(범위 제한)
function blobSize(mask, w, h, x, y, limit) {
  if (!mask[y * w + x]) {
    // 속이 빈 머리는 테두리에서 시작합니다.
    let found = false;
    for (let d = 1; d < limit && !found; d += 1) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) {
          x = nx;
          y = ny;
          found = true;
          break;
        }
      }
    }
    if (!found) return { w: 0, h: 0 };
  }
  const seen = new Set([y * w + x]);
  const stack = [y * w + x];
  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;
  while (stack.length && seen.size < 20000) {
    const i = stack.pop();
    const px = i % w;
    const py = (i - px) / w;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
    if (maxX - minX > limit || maxY - minY > limit) break;
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      if (j >= 0 && j < w * h && mask[j] && !seen.has(j)) {
        seen.add(j);
        stack.push(j);
      }
    }
  }
  return { w: maxX - minX + 1, h: maxY - minY + 1 };
}

// 기둥 끝에 달린 꼬리·빔 개수(8분음표 1, 16분음표 2 …)
function countFlags(mask, w, h, staff, stem) {
  const { s } = staff;
  let best = 0;
  for (const side of [-1, 1]) {
    const x = Math.round(stem.x + side * s * 0.38);
    if (x < 0 || x >= w) continue;
    let runs = 0;
    let len = 0;
    const from = stem.end + stem.dir * Math.round(s * 0.2);
    for (let i = 0; i <= s * 2.4; i += 1) {
      const y = from - stem.dir * i;
      if (y < 0 || y >= h) break;
      if (mask[y * w + x]) len += 1;
      else {
        if (len >= s * 0.18) runs += 1;
        else if (!runs && i > s * 1.4) break; // 끝에서 멀리 떨어진 잉크는 다른 기호입니다.
        len = 0;
      }
    }
    if (len >= s * 0.18) runs += 1;
    best = Math.max(best, runs);
  }
  return Math.min(best, 3);
}

// 머리 오른쪽의 작은 점(점음표)
function hasDot(mask, w, h, staff, cx, cy) {
  const { s } = staff;
  const x0 = Math.round(cx + s * 0.75);
  const x1 = Math.round(cx + s * 1.7);
  const y0 = Math.round(cy - s * 0.75);
  const y1 = Math.round(cy + s * 0.45);
  // 머리 가장자리나 다른 기호에 먼저 닿을 수 있으므로, 점 크기의 덩어리가 나올 때까지 계속 찾습니다.
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      if (x < 0 || x >= w || y < 0 || y >= h || !mask[y * w + x]) continue;
      const b = blobSize(mask, w, h, x, y, s);
      if (b.w >= s * 0.2 && b.w <= s * 0.6 && b.h >= s * 0.2 && b.h <= s * 0.6) return true;
    }
  }
  return false;
}

/* ---------- 쉼표와 임시표 ---------- */

function components(mask, w, h, xa, xb, ya, yb) {
  const seen = new Uint8Array(w * h);
  const list = [];
  for (let y = Math.max(0, ya); y < Math.min(h, yb); y += 1) {
    for (let x = Math.max(0, xa); x < Math.min(w, xb); x += 1) {
      const i = y * w + x;
      if (!mask[i] || seen[i]) continue;
      seen[i] = 1;
      const stack = [i];
      const pts = [];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (stack.length) {
        const j = stack.pop();
        pts.push(j);
        const px = j % w;
        const py = (j - px) / w;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (const k of [px > 0 ? j - 1 : -1, px < w - 1 ? j + 1 : -1, j - w, j + w]) {
          if (k >= 0 && k < w * h && mask[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      list.push({ minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1, pts });
    }
  }
  return list;
}

// 머리 바로 왼쪽(0.7~2.4칸)에서 곧게 선 세로 획을 찾아 임시표를 판별합니다.
//   내림표: 획 1개(머리 위로 길게)  올림표: 획 2개(같은 높이)  제자리표: 획 2개(왼쪽은 위로, 오른쪽은 아래로)
function accidentalLeftOf(clean, w, h, staff, head, stemXs, bars) {
  const { s } = staff;
  const x0 = Math.round(head.x - s * 2.4);
  const x1 = Math.round(head.x - s * 0.7);
  const yTop = Math.round(head.y - s * 2.2);
  const yBottom = Math.round(head.y + s * 1.8);
  const groups = [];
  for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x += 1) {
    if (stemXs.some((sx) => Math.abs(sx - x) <= s * 0.25)) continue;
    if (bars.some((bx) => Math.abs(bx - x) <= s * 0.4)) continue; // 마디줄
    let best = 0;
    let bestStart = 0;
    let run = 0;
    let start = 0;
    for (let y = Math.max(0, yTop); y <= Math.min(h - 1, yBottom); y += 1) {
      if (clean[y * w + x]) {
        if (!run) start = y;
        run += 1;
        if (run > best) {
          best = run;
          bestStart = start;
        }
      } else run = 0;
    }
    // 머리 높이를 지나가는 곧은 획만 봅니다.
    if (best < s * 1.4 || best > s * 3.8 || bestStart > head.y + s * 0.3 || bestStart + best < head.y - s * 0.3) continue;
    const last = groups[groups.length - 1];
    if (last && x - last.x1 <= 1) {
      last.x1 = x;
      last.top = Math.min(last.top, bestStart);
      last.bottom = Math.max(last.bottom, bestStart + best);
    } else groups.push({ x0: x, x1: x, top: bestStart, bottom: bestStart + best });
  }
  if (!groups.length || groups.length > 2) return null;
  const right = groups[groups.length - 1];
  if (groups.length === 1) {
    // 내림표의 획은 머리 위로 길게 솟고 아래로는 짧습니다.
    if (head.y - right.top >= s * 1.0 && right.bottom - head.y <= s * 0.9) return { alter: -1, x: right.x0 };
    return null;
  }
  const [a, b] = groups;
  if (b.x0 - a.x1 > s * 1.0) return null;
  const shift = ((b.top - a.top) + (b.bottom - a.bottom)) / 2;
  return { alter: shift > s * 0.3 ? 0 : 1, x: a.x0 };
}

// 덩어리 안에서 곧게 선 세로줄 묶음(임시표는 1~2개, 쉼표는 없음)
function verticalStrokes(comp, mask, w, s) {
  const groups = [];
  for (let x = comp.minX; x <= comp.maxX; x += 1) {
    let best = 0;
    let run = 0;
    let start = 0;
    let bestStart = 0;
    for (let y = comp.minY; y <= comp.maxY; y += 1) {
      if (mask[y * w + x]) {
        if (!run) start = y;
        run += 1;
        if (run > best) {
          best = run;
          bestStart = start;
        }
      } else run = 0;
    }
    if (best >= s * 1.5) {
      const last = groups[groups.length - 1];
      if (last && x - last.x1 <= 1) {
        last.x1 = x;
        last.top = Math.min(last.top, bestStart);
        last.bottom = Math.max(last.bottom, bestStart + best);
      } else groups.push({ x0: x, x1: x, top: bestStart, bottom: bestStart + best });
    }
  }
  return groups;
}

/* ---------- 한 마디 분석 ---------- */

export function analyzeStaffStrip(mask, w, h, staff) {
  const { s } = staff;
  const clean = removeStaffLines(mask, w, h, staff);
  // 오선 줄이 있으면 줄과 빔 사이 같은 틈까지 메워지므로, 줄을 지운 그림에서 빈틈을 메웁니다.
  const filled = fillHoles(clean, w, h, s * s * 0.8);
  const heads = findAllHeads(mask, filled, clean, w, h, staff);
  const bars = findBarlines(mask, w, h, staff, heads);
  const extent = staffExtent(mask, w, h, staff);
  return { heads, bars, extent, clean };
}

// tapX가 속한 마디의 경계와 그 안의 사건(음표 묶음과 쉼표)을 시간 순서로 돌려줍니다.
export function measureAt(strip, staff, tapX, w, h, keyCount = 0) {
  const { s } = staff;
  const { heads, bars, extent, clean } = strip;
  let left = extent.left;
  let right = extent.right;
  for (const b of bars) {
    if (b <= tapX && b > left) left = b;
    if (b > tapX && b < right) right = b;
  }
  // 줄 맨 앞의 시작 세로줄은 오선이 시작되는 곳 바로 옆에 있습니다.
  const firstOfSystem = left - extent.left < s * 2;
  if (firstOfSystem) left = extent.left;
  return { ...buildEvents(heads, clean, w, h, staff, left, right, firstOfSystem, keyCount, [...bars, extent.left]), left, right, s };
}

function buildEvents(heads, clean, w, h, staff, left, right, firstOfSystem, keyCount, bars) {
  const { s } = staff;
  const inside = heads.filter((hd) => hd.x > left + s * 0.4 && hd.x < right - s * 0.4);
  // 줄의 첫 마디는 음자리표 자리(약 3.6칸)를 건너뜁니다.
  const start = firstOfSystem ? left + s * 3.6 : left;
  const notes = inside.filter((hd) => hd.x >= start && !(hd.chordOnly && !inside.some((o) => o !== hd && o.stem && Math.abs(o.x - hd.x) < s * 1.4)));

  // 줄 첫 마디의 음자리표·조표·박자표 자리
  const keyEnd = firstOfSystem ? left + s * (3.6 + Math.abs(keyCount) * 1.1 + 0.5) : -Infinity;
  const firstNoteX = notes.length ? Math.min(...notes.map((n) => n.x)) : right;
  // 쉼표는 줄을 지운 그림의 덩어리로 찾습니다.
  const comps = components(clean, w, h, Math.round(start), Math.round(right), Math.round(staff.top - s * 1.2), Math.round(staff.bottom + s * 1.2));
  const rests = [];
  const accidentals = [];
  const mid = (staff.top + staff.bottom) / 2;
  comps.sort((a, b) => a.minX - b.minX);
  for (const c of comps) {
    const cxm = (c.minX + c.maxX) / 2;
    const cym = (c.minY + c.maxY) / 2;
    const nearHead = notes.some((n) => Math.abs(n.x - cxm) < s * 0.9 && Math.abs(n.y - cym) < s * 2.5);
    if (nearHead) continue;
    // 줄 첫 마디의 조표(설정한 개수만큼의 자리, 또는 첫 음표 앞의 세로 획 기호)는 쉼표가 아닙니다.
    if (firstOfSystem && c.maxX < keyEnd) continue;
    if (firstOfSystem && c.maxX < firstNoteX - s * 0.3 && verticalStrokes(c, clean, w, s).length) continue;
    // 줄 첫 마디의 박자표(숫자 두 개가 위아래로 쌓임)는 쉼표가 아닙니다.
    if (c.minX < keyEnd + s * 3) {
      const stacked = comps.some((d) => d !== c && Math.abs((d.minX + d.maxX) / 2 - cxm) < s * 0.7
        && Math.abs((d.minY + d.maxY) / 2 - cym) > s * 1.2 && d.h >= s * 1.2 && d.h <= s * 2.6);
      if (stacked) continue;
    }
    // 바로 오른쪽에 음표가 있는 세로 획 기호는 임시표입니다.
    const accidentalLike = notes.some((n) => n.x - c.maxX > s * 0.2 && n.x - c.maxX < s * 2.4 && Math.abs(n.y - cym) < s * 1.6)
      && c.h >= s * 1.8 && c.h <= s * 3.6 && verticalStrokes(c, clean, w, s).length > 0;
    if (accidentalLike) continue;
    // 온쉼표(넷째 줄에 매달림)와 2분쉼표(셋째 줄 위에 얹힘): 납작한 네모
    if (c.h >= s * 0.3 && c.h <= s * 0.75 && c.w >= s * 0.8 && c.w <= s * 1.7) {
      const line4 = staff.lines[1].c;
      const line3 = staff.lines[2].c;
      if (Math.abs(c.minY - line4) < s * 0.3) rests.push({ x: cxm, dur: 4, kind: 'whole' });
      else if (Math.abs(c.maxY - line3) < s * 0.3) rests.push({ x: cxm, dur: 2, kind: 'half' });
      continue;
    }
    if (Math.abs(cym - mid) > s * 1.3 || c.w < s * 0.45 || c.w > s * 1.4) continue;
    let rest = null;
    if (c.h >= s * 2.5 && c.h <= s * 3.4) rest = { x: cxm, dur: 1, kind: 'quarter' };
    else if (c.h >= s * 1.2 && c.h < s * 2.5) rest = { x: cxm, dur: 0.5, kind: 'eighth' };
    if (!rest) continue;
    // 쉼표 오른쪽의 작은 점은 점쉼표(1.5배)입니다.
    const dotted = comps.some((d) => d !== c && d.w <= s * 0.6 && d.h <= s * 0.6 && d.w >= s * 0.15
      && d.minX - c.maxX > 0 && d.minX - c.maxX < s * 1.2 && d.minY >= c.minY - s * 0.3 && d.maxY <= c.maxY);
    if (dotted) rest.dur *= 1.5;
    rests.push(rest);
  }

  const stemXs = heads.filter((hd) => hd.stem).map((hd) => hd.stem.x);
  for (const n of notes) {
    n.dur = n.hollow ? (n.stem ? 2 : 4) : 1 / 2 ** (n.flags || 0);
    if (n.dot) n.dur *= 1.5;
    n.alter = null;
    const found = accidentalLeftOf(clean, w, h, staff, n, stemXs, bars);
    if (found && found.x > keyEnd) accidentals.push({ head: n, alter: found.alter });
  }
  // 임시표는 같은 마디 안 같은 높이의 뒤 음표에도 적용됩니다.
  for (const a of accidentals) {
    for (const n of notes) {
      if (n.x >= a.head.x - 1 && Math.abs(n.y - a.head.y) < s * 0.3) n.alter = a.alter;
    }
  }

  // 같은 세로 위치의 머리는 화음으로 묶습니다.
  notes.sort((a, b) => a.x - b.x);
  const events = [];
  for (const n of notes) {
    const last = events[events.length - 1];
    if (last && !last.rest && Math.abs(last.x - n.x) < s * 1.2) {
      last.heads.push(n);
      if (n.stem && (!last.withStem || n.dur < last.dur)) {
        last.dur = n.dur;
        last.withStem = true;
      }
    } else {
      events.push({ x: n.x, heads: [n], dur: n.dur, withStem: Boolean(n.stem) });
    }
  }
  for (const r of rests) events.push({ x: r.x, heads: [], dur: r.dur, rest: r.kind });
  events.sort((a, b) => a.x - b.x);
  return { events };
}
