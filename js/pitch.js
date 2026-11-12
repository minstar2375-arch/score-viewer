// 악보 그림에서 누른 곳의 오선과 음표 머리를 찾아 음 높이를 계산합니다.
// 화면에 그린 악보의 픽셀만 보고 판단하므로 인터넷이 필요 없습니다.

const DARK_LEVEL = 170; // 잉크와 종이의 차이가 작을 때 쓰는 기본 기준입니다.
const LINE_COVER = 0.5; // 한 줄의 절반 이상이 잉크면 오선 후보로 봅니다.
const HEAD_MIN_FILL = 0.4; // 음표 머리 상자가 이 비율 이상 채워져야 음표로 인정합니다.

// 오선 첫째 줄(맨 아래 줄)의 음. 값은 옥타브 × 7 + 음 이름 순서(C=0 … B=6)입니다.
const BOTTOM_LINE = {
  treble: 4 * 7 + 2, // E4
  tenor: 3 * 7 + 2, // 높은음자리표 아래 8: E3
  bass: 2 * 7 + 4, // G2
};
const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // 파 도 솔 레 라 미 시
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // 시 미 라 레 솔 도 파

// 잉크(어두운 픽셀)를 1로 표시합니다. 스캔본처럼 흐리거나 배경이 누런 악보도 읽을 수 있도록,
// 주변의 종이 밝기와 잉크 밝기를 재서 기준을 정합니다.
export function darkMask({ data, width, height }, reach = 0.15) {
  const count = width * height;
  const lum = new Uint8Array(count);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < count; i += 1, p += 4) {
    const v = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
    lum[i] = v;
    hist[v] += 1;
  }
  const percentile = (q) => {
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += hist[v];
      if (seen >= count * q) return v;
    }
    return 255;
  };
  const paper = percentile(0.6);
  const ink = percentile(0.01);
  // reach가 작을수록 종이 밝기 바로 아래까지 잉크로 봅니다.
  // 오선은 화면 해상도가 낮으면 연한 회색으로 그려지므로 넓게(0.15),
  // 음표 머리는 스캔본의 번진 잉크에 끌려가지 않도록 엄격하게(0.3) 봅니다.
  // 어느 쪽이든 기본 기준보다 엄격해지지는 않게 합니다.
  const level = paper - ink >= 60
    ? Math.min(paper - 12, Math.max(DARK_LEVEL, Math.round(paper - (paper - ink) * reach)))
    : DARK_LEVEL;
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) if (lum[i] < level) mask[i] = 1;
  return mask;
}

// 가로로 길게 이어진 잉크 줄을 찾고, 간격이 고른 다섯 줄을 한 오선으로 묶습니다.
export function findStaves(mask, w, h) {
  const runs = [];
  let start = -1;
  for (let y = 0; y <= h; y += 1) {
    let on = false;
    if (y < h) {
      let count = 0;
      const row = y * w;
      for (let x = 0; x < w; x += 1) count += mask[row + x];
      on = count / w >= LINE_COVER;
    }
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      runs.push({ top: start, bottom: y - 1 });
      start = -1;
    }
  }
  if (!runs.length) return [];

  // 빔처럼 두꺼운 가로 덩어리는 오선이 아니므로 뺍니다.
  const thick = runs.map((r) => r.bottom - r.top + 1).sort((a, b) => a - b);
  const typical = thick[Math.floor(thick.length / 2)];
  const lines = runs
    .filter((r) => r.bottom - r.top + 1 <= Math.max(3, typical * 2.5))
    .map((r) => ({ ...r, c: (r.top + r.bottom) / 2 }));

  const staves = [];
  for (let i = 0; i + 4 < lines.length;) {
    const five = lines.slice(i, i + 5);
    const gaps = [1, 2, 3, 4].map((k) => five[k].c - five[k - 1].c);
    const mean = gaps.reduce((a, b) => a + b, 0) / 4;
    if (mean >= 4 && gaps.every((g) => Math.abs(g - mean) <= mean * 0.25)) {
      staves.push({ lines: five, s: mean, top: five[0].c, bottom: five[4].c });
      i += 5;
    } else {
      i += 1;
    }
  }
  return staves;
}

// 잉크로 둘러싸인 작은 빈 곳(속이 빈 음표 머리의 안쪽 등)을 잉크로 채웁니다.
// 2분음표와 온음표도 검은 음표 머리처럼 찾을 수 있게 됩니다.
// 빔과 기둥 사이처럼 큰 빈 곳은 음표 머리가 아니므로 채우지 않습니다.
export function fillHoles(mask, w, h, maxArea) {
  const filled = new Uint8Array(mask);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const flood = (start) => {
    const part = [];
    seen[start] = 1;
    stack.push(start);
    let touchesEdge = false;
    while (stack.length) {
      const i = stack.pop();
      part.push(i);
      const x = i % w;
      if (x === 0 || x === w - 1 || i < w || i >= (h - 1) * w) touchesEdge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && !mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    return { part, touchesEdge };
  };
  for (let i = 0; i < w * h; i += 1) {
    if (mask[i] || seen[i]) continue;
    const { part, touchesEdge } = flood(i);
    if (!touchesEdge && part.length <= maxArea) for (const j of part) filled[j] = 1;
  }
  return filled;
}

// 넓은 기준으로 찾은 오선의 줄 두께를 엄격한 기준의 잉크로 다시 잽니다.
// 번진 스캔본에서 줄이 두껍게 잡히면 음표 머리의 높이 계산이 틀어지기 때문입니다.
export function refineLines(mask, w, h, staff) {
  const covered = (y) => {
    if (y < 0 || y >= h) return false;
    let count = 0;
    for (let x = 0; x < w; x += 1) count += mask[y * w + x];
    return count / w >= LINE_COVER;
  };
  const lines = staff.lines.map((line) => {
    const c = Math.round(line.c);
    let start = -1;
    for (let y = line.top; y <= line.bottom; y += 1) {
      if (covered(y)) {
        start = y;
        break;
      }
    }
    if (start < 0) return line; // 엄격한 기준으로는 안 보이는 얇은 선이면 그대로 둡니다.
    let end = start;
    while (end + 1 <= line.bottom && covered(end + 1)) end += 1;
    return { top: start, bottom: end, c: c };
  });
  return { ...staff, lines };
}

// 누른 높이에서 가장 가까운 오선을 고릅니다. 덧줄 음표를 위해 위아래로 여유를 둡니다.
export function nearestStaff(staves, y) {
  let best = null;
  for (const staff of staves) {
    const distance = y < staff.top ? staff.top - y : y > staff.bottom ? y - staff.bottom : 0;
    if (distance > staff.s * 4.5) continue;
    if (!best || distance < best.distance) best = { staff, distance };
  }
  return best?.staff ?? null;
}

// 누른 곳 근처에서 잉크가 가장 꽉 찬 음표 머리 크기의 상자를 찾습니다.
// 손가락이 음표를 정확히 덮지 않아도 되도록, 가까울수록 점수를 더 줍니다.
export function findHead(rawMask, w, h, staff, tx, ty) {
  const { s } = staff;
  const mask = fillHoles(rawMask, w, h, s * s * 0.8);
  const lineRow = new Uint8Array(h);
  for (const line of staff.lines) {
    for (let y = Math.max(0, line.top); y <= Math.min(h - 1, line.bottom); y += 1) lineRow[y] = 1;
  }
  // 오선 줄을 지운 잉크의 누적 합(상자 안 잉크 양을 빠르게 셉니다)
  const W1 = w + 1;
  const sat = new Int32Array(W1 * (h + 1));
  const linePrefix = new Int32Array(h + 1);
  for (let y = 0; y < h; y += 1) {
    linePrefix[y + 1] = linePrefix[y] + lineRow[y];
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      if (!lineRow[y]) rowSum += mask[y * w + x];
      sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + rowSum;
    }
  }
  const boxSum = (x0, y0, x1, y1) => sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];

  const bw = Math.max(3, Math.round(s * 1.1));
  const bh = Math.max(3, Math.round(s * 0.75));
  const range = s * 1.8;
  const stride = Math.max(1, Math.round(s / 6));
  let best = null;
  for (let cy = ty - range; cy <= ty + range; cy += stride) {
    for (let cx = tx - range; cx <= tx + range; cx += stride) {
      const x0 = Math.round(cx - bw / 2);
      const y0 = Math.round(cy - bh / 2);
      const x1 = x0 + bw;
      const y1 = y0 + bh;
      if (x0 < 0 || y0 < 0 || x1 > w || y1 > h) continue;
      const usable = bh - (linePrefix[y1] - linePrefix[y0]);
      if (usable < bh * 0.4) continue;
      const fill = boxSum(x0, y0, x1, y1) / (bw * usable);
      // 속이 빈 음표(2분·온음표)도 놓치지 않도록, 음표 머리만큼 채워진 상자 중에서 가장 가까운 것을 고릅니다.
      if (fill < HEAD_MIN_FILL) continue;
      const d2 = ((cx - tx) ** 2 + (cy - ty) ** 2) / (s * s);
      const score = fill * Math.exp(-0.35 * d2);
      if (!best || score > best.score) best = { score, fill, x0, y0, x1, y1 };
    }
  }
  if (!best) return null;

  // 상자 안 잉크의 무게중심으로 높이를 다듬습니다.
  let total = 0;
  let sumY = 0;
  let sumX = 0;
  for (let y = best.y0; y < best.y1; y += 1) {
    if (lineRow[y]) continue;
    for (let x = best.x0; x < best.x1; x += 1) {
      if (mask[y * w + x]) {
        total += 1;
        sumY += y;
        sumX += x;
      }
    }
  }
  if (!total) return null;
  return { x: sumX / total, y: sumY / total, fill: best.fill };
}

// 오선 맨 아래 줄을 0으로, 줄과 칸을 한 칸씩 셉니다(위로 갈수록 +).
export const stepOf = (staff, y) => Math.round((staff.bottom - y) / (staff.s / 2));

// 오선이 시작하는 왼쪽 끝을 찾아 음자리표 모양을 봅니다.
// 높은음자리표는 오선 위아래로 크게 삐져나오고, 낮은음자리표는 오선 안에 머뭅니다.
// mask는 오선 주변 띠 모양 영역이고, staff의 줄 높이는 그 영역 기준입니다.
export function detectClef(mask, w, h, staff, startX) {
  const { s } = staff;
  const inkAt = (x, y) => y >= 0 && y < h && mask[y * w + x] === 1;
  // 스캔한 악보는 조금 기울어져 있으므로, 왼쪽으로 가면서 각 줄의 높이를 따라갑니다.
  const rows = staff.lines.map((line) => Math.round(line.c));
  let leftRows = rows.slice();
  const follow = (x) => {
    let hits = 0;
    for (let k = 0; k < rows.length; k += 1) {
      for (const dy of [0, -1, 1, -2, 2]) {
        if (inkAt(x, rows[k] + dy)) {
          rows[k] += dy;
          hits += 1;
          break;
        }
      }
    }
    return hits >= 3;
  };

  let left = -1;
  for (let x = Math.min(startX, w - 1); x >= 0; x -= 1) {
    if (follow(x)) {
      left = x;
      leftRows = rows.slice();
    } else if (left >= 0 ? left - x > s * 1.5 : startX - x > s * 3) break;
  }
  if (left < 0) return null;
  const top = leftRows[0];
  const bottom = leftRows[leftRows.length - 1];

  // 오선 시작 부분의 세로줄(조를 묶는 괄호, 시작 세로줄)은 위아래로 길게 이어져 음자리표처럼 보이므로 건너뜁니다.
  const y0 = Math.max(0, Math.round(top - s * 2.5));
  const y1 = Math.min(h, Math.round(bottom + s * 2.5));
  const isVertical = (x) => {
    let n = 0;
    for (let y = y0; y < y1; y += 1) n += mask[y * w + x];
    return n > (y1 - y0) * 0.75;
  };
  let lastVertical = -1;
  for (let x = left; x < Math.min(w, left + s * 2.5); x += 1) if (isVertical(x)) lastVertical = x;
  const x0 = Math.round(Math.max(left + s * 0.5, lastVertical + s * 0.4));
  const x1 = Math.min(w, Math.round(x0 + s * 2.8));
  const columns = [];
  for (let x = x0; x < x1; x += 1) if (!isVertical(x)) columns.push(x);
  const rowHasInk = (y) => {
    if (y < 0 || y >= h) return false;
    for (const x of columns) if (mask[y * w + x]) return true;
    return false;
  };
  // 오선 맨 위·맨 아래 줄에서부터 끊기지 않고 이어진 잉크가 얼마나 삐져나오는지 잽니다.
  const reach = (fromY, dir) => {
    const maxGap = Math.max(2, Math.round(s * 0.2));
    let gap = 0;
    let last = fromY;
    for (let y = fromY + dir; Math.abs(y - fromY) <= s * 3; y += dir) {
      if (rowHasInk(y)) {
        last = y;
        gap = 0;
      } else if (++gap > maxGap) break;
    }
    return Math.abs(last - fromY) / s;
  };
  const above = reach(top, -1);
  const below = reach(bottom, 1);
  // 높은음자리표는 오선 위로 1칸 넘게, 아래로도 1칸 가까이 삐져나옵니다.
  return { clef: above >= 1 && below >= 0.8 ? 'treble' : 'bass', left, above, below };
}

// 조표에 따라 그 음 이름에 붙는 올림(+1)·내림(-1)을 돌려줍니다.
export function keyAlter(letter, keySig) {
  if (keySig > 0) return SHARP_ORDER.slice(0, keySig).includes(letter) ? 1 : 0;
  if (keySig < 0) return FLAT_ORDER.slice(0, -keySig).includes(letter) ? -1 : 0;
  return 0;
}

// 음자리표, 조표, 임시표를 반영해 음 높이를 계산합니다. accidental이 null이면 조표를 따릅니다.
export function pitchOf(step, clef, keySig = 0, accidental = null) {
  const d = BOTTOM_LINE[clef] + step;
  const letter = ((d % 7) + 7) % 7;
  const octave = Math.floor(d / 7);
  const alter = accidental ?? keyAlter(letter, keySig);
  return { letter, octave, alter, midi: (octave + 1) * 12 + WHITE_STEPS[letter] + alter };
}
