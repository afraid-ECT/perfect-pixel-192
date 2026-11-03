/**
 * Perfect Pixel 192 — core algorithm (DOM-free, runs in browser & Node)
 *
 * 移植自 GitHub 上 star 最高的 perfectPixel 项目：
 *   theamusing/perfectPixel (2,281★) — src/perfect_pixel/perfect_pixel.py
 *
 * 与上游一致的流程：
 *   1) 灰度化，Sobel(k=3) 求梯度，按列/行做投影累加
 *   2) 估计单元格边长（上游用 2D FFT 幅值；这里用等价的频域自相关，
 *      并保留上游的“梯度峰间隔中位数”作为第二级回退）
 *   3) 从图像中心向两侧逐格外推，每条线在 ±refine 格宽内吸附到最强梯度峰
 *   4) 逐格采样：center / median / majority(k=2 聚类多数表决)
 *   5) 近似正方形时做 fix_square 对齐
 *
 * 与上游的差异（针对 192px 场景修正）：
 *   - 格宽窗口 [4,20] → [1,256]：上游硬编码 min_size=4/max_pixel_size=20，
 *     192px 图只有 10~48 格能通过校验；本实现支持 192px 下 96×96、192×192
 *     这类 2px / 1px 细格。
 *   - 上游 FFT 路径用 1-log(1+|F|) 且峰阈 0.35，实际在检“能量低点”，
 *     数值上不可靠；这里改为对去趋势后的梯度投影做自相关，
 *     取最小可信周期（含抛物线亚像素插值）。
 *   - majority 采样的 k-means 改为确定性初始化，结果可复现。
 *   - 网格线裁到 [0,len] 并去重，避免上游“图外线”造成格数偏一。
 */

export const DEFAULTS = {
  sample: 'core',     // core | center | majority | median
  minCell: 2,         // 最小格宽(px) — 上游为 4
  maxCell: 64,        // 最大格宽(px) — 上游为 20
  maxRatio: 1.5,      // 横纵格宽比上限
  refine: 0.25,       // 网格线精修强度 0~0.5
  fixSquare: true,    // 近似正方形时对齐
  colors: 0,          // >1 时把输出限制到该色数（中位切分），0 = 跟随模式默认
  strongColors: 32,   // 强劲模式默认色数
  bgTol: 7,           // 背景区域生长：相邻格最大 Lab 色差
  bgGuard: 40,        // 背景区域生长：与背景众数色的最大 Lab 色差
  ringTol: 26,        // 轮廓外侧混色环并进背景时允许的色差
  gridW: 0,           // >0 时手动指定格数，跳过自动估计
  gridH: 0,
};

/* ------------------------------------------------------------------ 基础 */

export function grayOf(img) {
  const { data } = img;
  const n = img.width * img.height;
  const g = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/** Sobel(k=3) 绝对值按列/行投影，等价于上游 grad_x_sum / grad_y_sum。 */
export function gradientProjections(gray, w, h) {
  const gx = new Float64Array(w);
  const gy = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const rows = [y > 0 ? y - 1 : 0, y, y < h - 1 ? y + 1 : h - 1];
    for (let x = 0; x < w; x++) {
      const c0 = x > 0 ? x - 1 : 0;
      const c2 = x < w - 1 ? x + 1 : w - 1;
      const tl = gray[rows[0] * w + c0], tc = gray[rows[0] * w + x], tr = gray[rows[0] * w + c2];
      const ml = gray[rows[1] * w + c0], mr = gray[rows[1] * w + c2];
      const bl = gray[rows[2] * w + c0], bc = gray[rows[2] * w + x], br = gray[rows[2] * w + c2];
      const sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      gx[x] += Math.abs(sx);
      gy[y] += Math.abs(sy);
    }
  }
  return { gx, gy };
}

export function detrend(sig, win) {
  const n = sig.length;
  const out = new Float64Array(n);
  const half = Math.max(1, Math.round(win / 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + sig[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = sig[i] - (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

/* -------------------------------------------------------------- 频域 FFI */

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const half = n >> 1;
  const cosT = new Float64Array(half);
  const sinT = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / n;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a); // = -sin(2πi/n)，配合 e^{-i} 约定
  }
  t = { rev, cosT, sinT };
  fftCache.set(n, t);
  return t;
}

function fftInPlace(re, im, inverse) {
  const n = re.length;
  const { rev, cosT, sinT } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cosT[k];
        const wi = inverse ? -sinT[k] : sinT[k];
        const a = i + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** 自相关（Wiener–Khinchin）：先 FFT 取功率谱，再 IFFT。 */
export function autocorr(sig) {
  const n = sig.length;
  let m = 1;
  while (m < n * 2) m <<= 1;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sig[i];
  mean /= n || 1;
  for (let i = 0; i < n; i++) re[i] = sig[i] - mean;
  fftInPlace(re, im, false);
  for (let i = 0; i < m; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    re[i] = p;
    im[i] = 0;
  }
  fftInPlace(re, im, true);
  const ac = new Float64Array(n);
  const denom = re[0] || 1;
  for (let i = 0; i < n; i++) ac[i] = re[i] / denom;
  return ac;
}

/** 在自相关序列里挑最小可信周期（避开 2p/3p 谐波），带亚像素插值。 */
export function pickPeriod(ac, minLag, maxLag) {
  const lo = Math.max(2, Math.ceil(minLag));
  const hi = Math.min(ac.length - 2, Math.floor(maxLag));
  if (hi <= lo) return null;
  let best = 0;
  let arg = -1;
  for (let k = lo; k <= hi; k++) if (ac[k] > best) { best = ac[k]; arg = k; }
  if (arg < 0 || best <= 1e-6) return null;
  let chosen = arg;
  for (let k = lo; k <= hi; k++) {
    if (ac[k] < 0.8 * best) continue;
    const isLocal = (k === lo || ac[k] >= ac[k - 1]) && (k === hi || ac[k] >= ac[k + 1]);
    if (isLocal) { chosen = k; break; }
  }
  let period = chosen;
  const y0 = ac[chosen - 1], y1 = ac[chosen], y2 = ac[chosen + 1];
  const den = y0 - 2 * y1 + y2;
  if (Math.abs(den) > 1e-9) {
    const d = (0.5 * (y0 - y2)) / den;
    if (Math.abs(d) < 0.5) period = chosen + d;
  }
  return { period, peak: ac[chosen], ratio: ac[chosen] / (ac[0] || 1) };
}

/** 梳状搜索回退：直接最小化 |sig[i]-sig[i+p]| 的均值。 */
export function combPeriod(sig, minCell, maxCell) {
  const n = sig.length;
  const lo = Math.max(1, minCell);
  const hi = Math.min(maxCell, n / 3);
  if (!(hi > lo) || n < 16) return null;
  const steps = 240;
  let best = null;
  const base = [];
  for (let s = 0; s <= steps; s++) {
    const p = lo + ((hi - lo) * s) / steps;
    const ip = Math.floor(p);
    const fp = p - ip;
    let cost = 0;
    let cnt = 0;
    for (let i = 0; i + ip + 1 < n; i++) {
      const b = sig[i + ip] * (1 - fp) + sig[i + ip + 1] * fp;
      cost += Math.abs(sig[i] - b);
      cnt++;
    }
    if (!cnt) continue;
    base.push({ period: p, cost: cost / cnt });
    if (!best || base[base.length - 1].cost < best.cost) best = base[base.length - 1];
  }
  if (!best) return null;
  const costs = base.map((b) => b.cost).sort((a, b) => a - b);
  const median = costs[costs.length >> 1] || 1;
  return { period: best.period, peak: 1 - best.cost / (median || 1), ratio: Math.max(0, 1 - best.cost / (median || 1)) };
}

/**
 * 上游 estimate_grid_gradient 的忠实移植：
 * 梯度投影上的强峰间隔取中位数 → 格宽。
 */
export function gradientIntervalPeriod(sig, relThr = 0.2, minInterval = 4) {
  const mx = sig.reduce((a, b) => Math.max(a, b), 0);
  if (mx < 1e-6) return null;
  const thr = relThr * mx;
  const peaks = [];
  for (let i = 1; i < sig.length - 1; i++) {
    if (sig[i] > sig[i - 1] && sig[i] > sig[i + 1] && sig[i] >= thr) {
      if (!peaks.length || i - peaks[peaks.length - 1] >= minInterval) peaks.push(i);
    }
  }
  if (peaks.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
  intervals.sort((a, b) => a - b);
  const med = intervals[intervals.length >> 1];
  if (!med) return null;
  const spread = (intervals[intervals.length >> 2] || med) / med;
  return { period: med, peak: 1, ratio: Math.min(1, 1 - Math.abs(1 - spread)) };
}

/**
 * 块一致性估计（本实现新增，针对像素画/AI 像素图）。
 *
 * 判据：真正格宽 c 必须让“所有色变”都落在 c 的倍数边界上，
 * 即块内相邻像素差能量占比 r(c) → 0。且 c 必须整除真实格宽，
 * 所以 r(c)≈0 的最大 c 就是真实格宽——对 1px/2px 细格同样成立，
 * 而 Sobel 投影在这种尺度下已无周期性可言。
 */
export function blockPeriods(gray, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const minC = Math.max(2, Math.round(o.minCell));
  const maxC = Math.min(Math.round(o.maxCell), Math.floor(Math.max(w, h) / 2));
  if (maxC < minC || w < 6 || h < 6) return null;

  const yStep = Math.max(1, Math.ceil(h / 512));
  const xStep = Math.max(1, Math.ceil(w / 1024));
  const hx = [];
  const hv = [];
  let totH = 0;
  for (let y = 0; y < h; y += yStep) {
    const row = y * w;
    for (let x = 0; x + 1 < w; x += xStep) {
      const d = gray[row + x] - gray[row + x + 1];
      const d2 = d * d;
      if (d2 === 0) continue;
      hx.push(x);
      hv.push(d2);
      totH += d2;
    }
  }
  const vy = [];
  const vv = [];
  let totV = 0;
  for (let y = 0; y + 1 < h; y++) {
    const row = y * w;
    const next = row + w;
    for (let x = 0; x < w; x += xStep) {
      const d = gray[row + x] - gray[next + x];
      const d2 = d * d;
      if (d2 === 0) continue;
      vy.push(y);
      vv.push(d2);
      totV += d2;
    }
  }
  if (!totH || !totV) return null;

  const rH = new Float64Array(maxC + 1);
  const rV = new Float64Array(maxC + 1);
  for (let c = minC; c <= maxC; c++) {
    rH[c] = ratioAt(hx, hv, totH, c);
    rV[c] = ratioAt(vy, vv, totV, c);
  }

  const px = pickBlock(rH, minC, maxC);
  const py = pickBlock(rV, minC, maxC);
  if (!px || !py) return null;
  return { cellW: px.cell, cellH: py.cell, score: Math.min(px.score, py.score) };
}

/** 块内相邻像素差能量占比；c 可以是小数（非整数格宽）。 */
function ratioAt(idx, val, total, c) {
  let within = 0;
  for (let i = 0; i < val.length; i++) {
    const p = idx[i];
    if (Math.floor(p / c) === Math.floor((p + 1) / c)) within += val[i];
  }
  return within / total;
}

/**
 * 先整数扫描定位候选，再在其邻域做小数精度细化：
 * 真实格宽 3.43px 这类非整数情况下，只有精确的小数 c 才能让块内差能量归零。
 */
function pickBlock(ratios, minC, maxC) {
  let m = Infinity;
  for (let c = minC; c <= maxC; c++) if (ratios[c] < m) m = ratios[c];
  // 模糊会让“块内差能量”整体抬高；m 太大说明图里没有真正的方格结构
  if (!(m < 0.25)) return null;
  // r(c) 随 c 变小单调下降，只有真实格宽的整除数会贴近 0。
  // 所以取“仍低于阈值的最大的 c”——越过真实格宽后 r 会跳崖式上升。
  const lim = Math.max(0.3, m * 2 + 0.05);
  let best = -1;
  for (let c = maxC; c >= minC; c--) {
    if (ratios[c] <= lim) { best = c; break; }
  }
  if (best < 0) return null;
  return { cell: best, score: 1 - ratios[best] };
}

/* ------------------------------------------------------------ 格宽估计 */

export function estimateCell(gray, gx, gy, opts, w, h) {
  const o = { ...DEFAULTS, ...opts };
  const minC = Math.max(2, Math.round(o.minCell));
  const maxC = Math.max(minC + 1, Math.round(o.maxCell));
  const ratioOk = (a, b) => Math.max(a, b) / Math.min(a, b) <= o.maxRatio;

  // 1) 块边界一致性：像素画/AI 像素图最可靠，也覆盖 2px 细格
  const blk = blockPeriods(gray, w, h, o);
  if (blk && blk.score > 0.75 && ratioOk(blk.cellW, blk.cellH)) {
    const gW = Math.max(1, Math.round(w / blk.cellW));
    const gH = Math.max(1, Math.round(h / blk.cellH));
    return {
      cellW: w / gW,
      cellH: h / gH,
      gridW: gW,
      gridH: gH,
      method: 'block-boundary',
      confidence: Math.min(1, 0.6 + blk.score * 0.4),
    };
  }

  // 2) 频域自相关基频（非整数格宽时的主要依据）
  const win = Math.max(8, Math.min(o.maxCell * 3, Math.min(w, h) / 2));
  const fx = pickPeriod(autocorr(detrend(gx, win)), minC, maxC);
  const fy = pickPeriod(autocorr(detrend(gy, win)), minC, maxC);
  if (fx && fy && ratioOk(fx.period, fy.period)) {
    const gW = Math.max(1, Math.round(w / fx.period));
    const gH = Math.max(1, Math.round(h / fy.period));
    if (ratioOk(w / gW, h / gH)) {
      return {
        cellW: w / gW,
        cellH: h / gH,
        gridW: gW,
        gridH: gH,
        method: 'fft-autocorr',
        confidence: Math.max(0.4, Math.min(0.95, 0.4 + Math.min(fx.ratio, fy.ratio))),
      };
    }
  }

  // 3) 上游的梯度峰间隔中位数
  const giX = gradientIntervalPeriod(gx);
  const giY = gradientIntervalPeriod(gy);
  if (giX && giY && ratioOk(giX.period, giY.period)) {
    const gW = Math.max(1, Math.round(w / giX.period));
    const gH = Math.max(1, Math.round(h / giY.period));
    return { cellW: w / gW, cellH: h / gH, gridW: gW, gridH: gH, method: 'gradient-interval', confidence: 0.5 };
  }

  // 4) 梳状搜索
  const cbX = combPeriod(detrend(gx, win), minC, maxC);
  const cbY = combPeriod(detrend(gy, win), minC, maxC);
  if (cbX && cbY) {
    const gW = Math.max(1, Math.round(w / cbX.period));
    const gH = Math.max(1, Math.round(h / cbY.period));
    return { cellW: w / gW, cellH: h / gH, gridW: gW, gridH: gH, method: 'comb', confidence: 0.35 };
  }

  const cell = Math.max(minC, Math.min(maxC, Math.min(w, h) / 32));
  return {
    cellW: cell,
    cellH: cell,
    gridW: Math.max(1, Math.round(w / cell)),
    gridH: Math.max(1, Math.round(h / cell)),
    method: 'fallback',
    confidence: 0.15,
  };
}

/**
 * 在 origin ±search 内找最强梯度峰。
 * 返回值以“像素边界坐标”为单位：像素索引 i 的中心在 i+0.5，
 * 因此平台峰(5,6) → 均值 5.5 → 返回 6.0，正好落在两列之间。
 */
function findBestGrid(origin, search, grad) {
  const len = grad.length;
  const from = Math.max(0, Math.round(origin - search - 0.5));
  const to = Math.min(len - 1, Math.round(origin + search - 0.5));
  let bestVal = 0;
  const hits = [];
  for (let c = from; c <= to; c++) {
    const v = grad[c];
    if (v <= 0) continue;
    const leftOk = c === 0 || v >= grad[c - 1];
    const rightOk = c === len - 1 || v >= grad[c + 1];
    if (!leftOk || !rightOk) continue;
    if (v > bestVal * 1.0001) {
      bestVal = v;
      hits.length = 0;
      hits.push(c);
    } else if (v >= bestVal * 0.999) {
      hits.push(c);
    }
  }
  if (!hits.length) return Math.max(0, Math.min(len, origin));
  let sum = 0;
  for (const c of hits) sum += c;
  return sum / hits.length + 0.5;
}

/**
 * 以 0 为起点构建整数格点阵，并在 ±0.35 格内吸附到梯度峰（保持单调，不会重叠）。
 * 先测“边界对比度”：像 2px 这种细格，Sobel 跨满整格导致每列都是边界，
 * 梯度没有谷 → 直接返回精确点阵，不做吸附（否则会乱跳）。
 */
export function refineLines(len, cell, grad, intensity) {
  const c = Math.max(1, cell);
  const lattice = [];
  for (let k = 0; k * c <= len + 1e-6; k++) lattice.push(Math.min(len, k * c));
  if (lattice[lattice.length - 1] < len - 1e-6) lattice.push(len);
  if (lattice.length < 2) return [0, len];

  let bsum = 0;
  let bn = 0;
  for (let k = 1; k < lattice.length - 1; k++) {
    const i = Math.round(lattice[k]);
    if (i > 0 && i < len) {
      bsum += grad[i - 1] + grad[i];
      bn += 2;
    }
  }
  const bmean = bn ? bsum / bn : 0;
  let total = 0;
  for (let i = 0; i < len; i++) total += grad[i];
  const gmean = total / len || 1;
  const contrast = bmean / gmean;
  if (!(contrast > 1.6) || !(intensity > 0)) return lattice;

  const search = Math.min(Math.max(0.6, c * intensity), c * 0.35);
  const out = [lattice[0]];
  for (let k = 1; k < lattice.length - 1; k++) {
    const p = lattice[k];
    const q = findBestGrid(p, search, grad);
    out.push(Math.max(out[out.length - 1] + c * 0.3, Math.min(len, q)));
  }
  out.push(len);
  return out;
}

/* ---------------------------------------------------------------- 采样 */

function clampRect(x0, x1, y0, y1, w, h) {
  let a = Math.max(0, Math.min(w, Math.round(x0)));
  let b = Math.max(0, Math.min(w, Math.round(x1)));
  let c = Math.max(0, Math.min(h, Math.round(y0)));
  let d = Math.max(0, Math.min(h, Math.round(y1)));
  if (b <= a) b = Math.min(w, a + 1);
  if (d <= c) d = Math.min(h, c + 1);
  return [a, b, c, d];
}

function sampleCenter(data, w, x0, x1, y0, y1) {
  const px = Math.min(x1 - 1, Math.floor((x0 + x1) / 2));
  const py = Math.min(y1 - 1, Math.floor((y0 + y1) / 2));
  const p = (py * w + px) * 4;
  return [data[p], data[p + 1], data[p + 2], data[p + 3]];
}

function sampleMedian(data, w, x0, x1, y0, y1) {
  const r = [], g = [], b = [], a = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      r.push(data[p]); g.push(data[p + 1]); b.push(data[p + 2]); a.push(data[p + 3]);
    }
  }
  if (!r.length) return [0, 0, 0, 0];
  const mid = (arr) => {
    arr.sort((p, q) => p - q);
    return arr[arr.length >> 1];
  };
  return [mid(r), mid(g), mid(b), mid(a)];
}

/** 中心裁剪均值：只平均格子中央 50% 区域，避开软边混色环。 */
function sampleCore(data, w, x0, x1, y0, y1) {
  const cw = x1 - x0;
  const ch = y1 - y0;
  const mw = Math.max(1, Math.round(cw * 0.5));
  const mh = Math.max(1, Math.round(ch * 0.5));
  const sx = x0 + Math.floor((cw - mw) / 2);
  const sy = y0 + Math.floor((ch - mh) / 2);
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = sy; y < sy + mh; y++) {
    for (let x = sx; x < sx + mw; x++) {
      if (x < 0 || y < 0 || x >= w) continue;
      const p = (y * w + x) * 4;
      r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3];
      n++;
    }
  }
  if (!n) return [0, 0, 0, 0];
  return [r / n, g / n, b / n, a / n];
}

function sampleMajority(data, w, x0, x1, y0, y1) {
  const total = (x1 - x0) * (y1 - y0);
  if (!total) return [0, 0, 0, 0];
  const step = total > 4096 ? Math.ceil(total / 4096) : 1;
  // 颜色直方图（每通道 32 级量化）→ 取众数桶 → 桶内取均值
  const buckets = new Map();
  let idx = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, idx++) {
      if (idx % step) continue;
      const p = (y * w + x) * 4;
      const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
      let b = buckets.get(key);
      if (!b) {
        b = [0, 0, 0, 0, 0];
        buckets.set(key, b);
      }
      b[0] += data[p];
      b[1] += data[p + 1];
      b[2] += data[p + 2];
      b[3] += data[p + 3];
      b[4]++;
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b[4] > best[4]) best = b;
  if (!best) return [0, 0, 0, 0];
  const n = best[4];
  return [best[0] / n, best[1] / n, best[2] / n, best[3] / n];
}

export function sampleCells(img, xs, ys, method) {
  const { data, width: w, height: h } = img;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const out = new Uint8ClampedArray(nx * ny * 4);
  const fn = method === 'center' ? sampleCenter
    : method === 'median' ? sampleMedian
      : method === 'core' ? sampleCore
        : sampleMajority;
  for (let j = 0; j < ny; j++) {
    const [x0, x1, y0, y1] = [0, 0, ys[j], ys[j + 1]];
    const rectY = clampRect(0, 1, y0, y1, w, h);
    for (let i = 0; i < nx; i++) {
      const rect = clampRect(xs[i], xs[i + 1], rectY[2], rectY[3], w, h);
      const c = fn(data, w, rect[0], rect[1], rect[2], rect[3]);
      const p = (j * nx + i) * 4;
      out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = c[3];
    }
  }
  return { data: out, width: nx, height: ny };
}

/* ---------------------------------------------------- 强劲模式（去抗锯齿） */

/**
 * 中心加权直方图众数采样：
 * 每个格子内按到格心的距离做高斯加权统计颜色，取权重最大的 8 级量化桶的加权均值。
 * 同时返回置信度 conf（该桶占总权重的比例）——沿描边的混色格 conf 会明显偏低，
 * 后续只用高置信度格子建调色板，再全场吸附，混色就被彻底消掉。
 */
export function sampleStrongCells(img, xs, ys) {
  const { data, width: w, height: h } = img;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const out = new Uint8ClampedArray(nx * ny * 4);
  const conf = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y0 = Math.max(0, Math.min(h, Math.round(ys[j])));
    const y1 = Math.max(0, Math.min(h, Math.round(ys[j + 1])));
    for (let i = 0; i < nx; i++) {
      const x0 = Math.max(0, Math.min(w, Math.round(xs[i])));
      const x1 = Math.max(0, Math.min(w, Math.round(xs[i + 1])));
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const sigma = Math.max(0.9, (x1 - x0) / 4);
      const inv = 1 / (2 * sigma * sigma);
      const buckets = new Map();
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 4;
          if (data[p + 3] === 0) continue;
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const wgt = Math.exp(-(dx * dx + dy * dy) * inv);
          const key = ((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5);
          let b = buckets.get(key);
          if (!b) {
            b = [0, 0, 0, 0, 0];
            buckets.set(key, b);
          }
          b[0] += wgt;
          b[1] += data[p] * wgt;
          b[2] += data[p + 1] * wgt;
          b[3] += data[p + 2] * wgt;
          b[4] += data[p + 3] * wgt;
          total += wgt;
        }
      }
      const idx = j * nx + i;
      if (!total) {
        out[idx * 4 + 3] = 0;
        continue;
      }
      let best = null;
      for (const b of buckets.values()) if (!best || b[0] > best[0]) best = b;
      const sw = best[0] || 1;
      out[idx * 4] = best[1] / sw;
      out[idx * 4 + 1] = best[2] / sw;
      out[idx * 4 + 2] = best[3] / sw;
      out[idx * 4 + 3] = best[4] / sw;
      conf[idx] = Math.min(1, best[0] / total);
    }
  }
  return { image: { data: out, width: nx, height: ny }, conf };
}

/**
 * 强劲模式的调色板：只用“干净”格子(conf>=0.55)的颜色来建，
 * 混色格不参与投票，所以描边上的中间灰不会挤进调色板。
 * wanted>=2 时取指定色数；否则按 Lab 距离 10 自适应归并。
 */
export function buildStrongPalette(img, conf, wanted, autoK = 24) {
  const n = img.width * img.height;
  const collect = (minConf) => {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      if (minConf > 0 && conf && conf[i] < minConf) continue;
      const p = i * 4;
      if (img.data[p + 3] === 0) continue;
      const key = (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2];
      const e = map.get(key);
      if (e) e.n++;
      else {
        const lab = rgbToLab(img.data[p], img.data[p + 1], img.data[p + 2]);
        map.set(key, { r: img.data[p], g: img.data[p + 1], b: img.data[p + 2], key, n: 1, L: lab[0], A: lab[1], B: lab[2] });
      }
    }
    return [...map.values()];
  };

  let entries = collect(0.55);
  if (entries.length < 2) entries = collect(0);

  // 先按 Lab 接近度聚成“颜色区域”，再看区域的面积占比。
  // 注意不能用“单个精确色”的频次判断主色：软边/噪声会把一块大色域碎成上千个近似色，
  // 每个精确色的占比都很低，但合起来是整张图最大的区域。
  const clusters = proximityClusters(entries, 10);
  const total = clusters.reduce((a, c) => a + c.n, 0);
  let keep = clusters.filter((c) => c.n / total >= 0.005);
  if (keep.length < 4) keep = clusters;

  // 再剔除“夹在两个更大色块中间”的色：这正是 50% 抗锯齿混色在 Lab 里的位置特征。
  // 条件收得很紧（两个父色都至少大 1.5 倍、中点距离 <=10、自身占比 <6%），
  // 避免把正常的中间调（阴影/高光）误删。
  keep = keep.filter((c) => {
    const share = c.n / total;
    if (share >= 0.06) return true;
    for (let i = 0; i < keep.length; i++) {
      const a = keep[i];
      if (a === c || a.n <= c.n * 1.5) continue;
      for (let j = i + 1; j < keep.length; j++) {
        const b = keep[j];
        if (b === c || b.n <= c.n * 1.5) continue;
        const dL = (a.seedL + b.seedL) / 2 - c.seedL;
        const dA = (a.seedA + b.seedA) / 2 - c.seedA;
        const dB = (a.seedB + b.seedB) / 2 - c.seedB;
        if (dL * dL + dA * dA + dB * dB <= 100) return false;
      }
    }
    return true;
  });
  if (keep.length < 2) keep = clusters.filter((c) => c.n / total >= 0.005);
  if (keep.length < 2) keep = clusters;

  const k = wanted >= 2 ? wanted : autoK;
  if (keep.length <= k) return keep.map((c) => labToRgb(c.seedL, c.seedA, c.seedB));
  const asEntries = keep.map((c) => {
    const rgb = labToRgb(c.seedL, c.seedA, c.seedB);
    return { r: rgb[0], g: rgb[1], b: rgb[2], key: (rgb[0] << 16) | (rgb[1] << 8) | rgb[2], n: c.n, L: c.seedL, A: c.seedA, B: c.seedB };
  });
  return buildPalette(asEntries, k);
}

/**
 * 去孤点：8 邻域里与自己同色的格子少于 minSame 个，就用周围出现最多的颜色替换。
 * 一条 1px 线的格子至少有 2 个同色邻居，所以线不会被吃掉；只有真正的孤点会消失。
 */
export function despeckle(img, opts = {}) {
  const minSame = opts.minSame ?? 2;
  const share = opts.share ?? 0.0015;
  const { width: w, height: h } = img;
  const data = img.data;
  const out = new Uint8ClampedArray(data);
  const n = w * h;
  // 先统计每种颜色占多少格：描边色即使被抗锯齿拆成几种深浅，也是“常见色”，
  // 绝不能被当成孤点删掉；真正的孤点占比极低。
  const freq = new Map();
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const k = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const rareMax = Math.max(3, Math.round(n * share));
  let fixed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      let same = 0;
      const votes = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = (yy * w + xx) * 4;
          const k2 = (data[q] << 16) | (data[q + 1] << 8) | data[q + 2];
          if (k2 === key) same++;
          else {
            const e = votes.get(k2) || [0, 0, 0, 0, 0];
            e[0]++;
            e[1] += data[q];
            e[2] += data[q + 1];
            e[3] += data[q + 2];
            e[4] += data[q + 3];
            votes.set(k2, e);
          }
        }
      }
      if (same >= minSame || !votes.size) continue;
      if ((freq.get(key) || 0) > rareMax) continue;
      let best = null;
      for (const e of votes.values()) if (!best || e[0] > best[0]) best = e;
      if (!best) continue;
      out[p] = best[1] / best[0];
      out[p + 1] = best[2] / best[0];
      out[p + 2] = best[3] / best[0];
      out[p + 3] = best[4] / best[0];
      fixed++;
    }
  }
  return { image: { data: out, width: w, height: h }, fixed };
}

/* -------------------------------------------------- 角色外侧噪点清理 */

/**
 * 清掉角色轮廓外侧的噪点：
 *  1) 以外圈格子为种子做区域生长，局部色差容忍（背景渐变/暗角也能整片连通）
 *  2) 把贴着轮廓的 1~2 圈“混色环”（描边与背景的中间色）并进背景
 *  3) 删掉背景区域里被背景包住的孤立杂点
 *  4) 只把 2)、3) 吃到的那部分格子刷成邻近背景色，不动背景本身的层次
 */
export function cleanOutside(img, opts = {}) {
  const { width: w, height: h } = img;
  const data = img.data;
  const tol = opts.tol ?? 7;        // 区域生长：与父格子的最大 Lab 距离
  const guard = opts.guard ?? 40;   // 与背景众数色的最大 Lab 距离（防止爬进角色）
  const ringTol = opts.ringTol ?? 26; // 混色环并进背景时允许的色差
  const maxRing = opts.maxRing ?? 2;
  const n = w * h;

  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] === 0) continue;
    const l = rgbToLab(data[p], data[p + 1], data[p + 2]);
    lab[i * 3] = l[0];
    lab[i * 3 + 1] = l[1];
    lab[i * 3 + 2] = l[2];
  }
  const dist = (i, j) => {
    const a = i * 3;
    const b = j * 3;
    return Math.hypot(lab[a] - lab[b], lab[a + 1] - lab[b + 1], lab[a + 2] - lab[b + 2]);
  };

  // 透明背景：外圈若以透明为主，直接按 alpha 处理
  let borderTotal = 0;
  let borderAlpha0 = 0;
  const borderIdx = [];
  for (let x = 0; x < w; x++) borderIdx.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) borderIdx.push(y * w, y * w + (w - 1));
  for (const i of borderIdx) {
    borderTotal++;
    if (data[i * 4 + 3] === 0) borderAlpha0++;
  }
  const transparentBg = borderAlpha0 > borderTotal * 0.6;

  // 背景众数色（用于 guard）
  let modeL = 0;
  let modeA = 0;
  let modeB = 0;
  if (!transparentBg) {
    const buckets = new Map();
    for (const i of borderIdx) {
      const p = i * 4;
      const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
      const e = buckets.get(key) || [0, 0, 0, 0];
      e[0]++;
      e[1] += lab[i * 3];
      e[2] += lab[i * 3 + 1];
      e[3] += lab[i * 3 + 2];
      buckets.set(key, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e[0] > best[0]) best = e;
    if (best && best[0]) {
      modeL = best[1] / best[0];
      modeA = best[2] / best[0];
      modeB = best[3] / best[0];
    }
  }

  const bg = new Uint8Array(n);
  const stack = [];
  const pass = (i) => {
    if (i < 0 || i >= n || bg[i]) return;
    if (transparentBg) {
      if (data[i * 4 + 3] !== 0) return;
    }
    bg[i] = 1;
    stack.push(i);
  };

  if (transparentBg) {
    for (const i of borderIdx) pass(i);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) pass(i - 1);
      if (x < w - 1) pass(i + 1);
      if (y > 0) pass(i - w);
      if (y < h - 1) pass(i + w);
    }
  } else {
    for (const i of borderIdx) {
      const d = Math.hypot(lab[i * 3] - modeL, lab[i * 3 + 1] - modeA, lab[i * 3 + 2] - modeB);
      if (d <= guard) pass(i);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      const push = (j) => {
        if (bg[j]) return;
        if (dist(j, i) > tol) return;
        const d = Math.hypot(lab[j * 3] - modeL, lab[j * 3 + 1] - modeA, lab[j * 3 + 2] - modeB);
        if (d > guard) return;
        bg[j] = 1;
        stack.push(j);
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
  }

  // 混色环：贴着背景且与某个背景邻居色差在 ringTol 内 → 并进背景
  const added = [];
  for (let passN = 0; passN < maxRing; passN++) {
    const batch = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (bg[i]) continue;
        let near = -1;
        if (x > 0 && bg[i - 1]) near = i - 1;
        else if (x < w - 1 && bg[i + 1]) near = i + 1;
        else if (y > 0 && bg[i - w]) near = i - w;
        else if (y < h - 1 && bg[i + w]) near = i + w;
        if (near < 0) continue;
        if (transparentBg ? data[i * 4 + 3] >= 96 : dist(i, near) > ringTol) continue;
        batch.push(i);
      }
    }
    if (!batch.length) break;
    for (const i of batch) {
      bg[i] = 1;
      added.push(i);
    }
  }

  // 背景里被完全包围的孤立杂点
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bg[i]) continue;
      let around = 0;
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          total++;
          if (bg[yy * w + xx]) around++;
        }
      }
      if (total && around === total) {
        bg[i] = 1;
        added.push(i);
      }
    }
  }

  // 背景整片刷成同一个背景色：量化产生的色带、渐变、以及残留杂点一起抹平
  const out = new Uint8ClampedArray(data);
  if (!transparentBg) {
    const br = Math.max(0, Math.min(255, Math.round(labToRgb(modeL, modeA, modeB)[0])));
    const bgc = labToRgb(modeL, modeA, modeB);
    for (let i = 0; i < n; i++) {
      if (!bg[i]) continue;
      out[i * 4] = bgc[0];
      out[i * 4 + 1] = bgc[1];
      out[i * 4 + 2] = bgc[2];
      out[i * 4 + 3] = 255;
    }
  }
  if (transparentBg) {
    for (const i of added) out.fill(0, i * 4, i * 4 + 4);
  }

  return { image: { data: out, width: w, height: h }, cleaned: added.length, transparentBg };
}

/* ------------------------------------------------------------ 主流程 */

export function analyze(img, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { width: w, height: h } = img;
  const gray = grayOf(img);
  const { gx, gy } = gradientProjections(gray, w, h);

  const est = estimateCell(gray, gx, gy, o, w, h);
  let gridW = o.gridW > 0 ? Math.round(o.gridW) : est.gridW;
  let gridH = o.gridH > 0 ? Math.round(o.gridH) : est.gridH;
  const cellW = w / gridW;
  const cellH = h / gridH;

  const xs = o.forceGrid ? Array.from({length:gridW+1}, (_,i)=>i*w/gridW) : refineLines(w, cellW, gx, o.refine);
  const ys = o.forceGrid ? Array.from({length:gridH+1}, (_,i)=>i*h/gridH) : refineLines(h, cellH, gy, o.refine);

  const mode = o.sample;
  const isRegion = mode === 'region';
  const isStrong = mode === 'strong';

  // 采样式
  let sampled;
  let regionPalette = null;
  if (isRegion) {
    const st = sampleStrongCells(img, xs, ys);
    sampled = st.image;
    regionPalette = buildStrongPalette(sampled, st.conf, o.colors, o.strongColors || 24);
  } else {
    // 强劲模式：单像素中心取色（最锐利，1px 描边不会被平均掉）
    sampled = sampleCells(img, xs, ys, isStrong ? 'center' : mode);
  }

  let result = sampled;
  let squared = false;
  if (!o.forceGrid && o.fixSquare && Math.abs(result.width - result.height) === 1) {
    result = fixSquare(result);
    squared = true;
  }

  const colorsBefore = countColors(result);
  let colorsAfter = colorsBefore;
  let cleaned = 0;
  let speckles = 0;

  if (isRegion) {
    if (regionPalette && regionPalette.length) result = snapToPalette(result, regionPalette);
    colorsAfter = countColors(result);
  } else if (mode === 'outline') {
    result = cleanOutside(result, { maxRing: 1 }).image;
    if (o.colors >= 2) result = quantize(result, o.colors).image;
    colorsAfter = countColors(result);
  } else if (isStrong) {
    // 32 色（跟随「颜色数」选择，未选则默认 32）
    const k = o.colors >= 2 ? o.colors : o.strongColors || 32;
    if (colorsAfter > k) result = quantize(result, k).image;
    // 先去掉孤点，再清掉角色轮廓外侧的混色环 + 把背景刷平
    const ds = despeckle(result, { minSame: 2 });
    result = ds.image;
    const cc = cleanOutside(result, { tol: o.bgTol, guard: o.bgGuard, ringTol: o.ringTol });
    result = cc.image;
    cleaned = cc.cleaned;
    speckles = ds.fixed;
    colorsAfter = countColors(result);
  } else if (o.colors >= 2 && colorsAfter > o.colors) {
    result = quantize(result, o.colors).image;
    colorsAfter = countColors(result);
  }

  const palette = paletteOf(result, 64);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    image: result,
    xs,
    ys,
    gridW,
    gridH,
    cellW,
    cellH,
    outW: result.width,
    outH: result.height,
    method: o.gridW > 0 ? 'manual' : est.method,
    confidence: o.gridW > 0 ? 1 : est.confidence,
    squared,
    colorsBefore,
    colorsAfter,
    palette,
    cleaned,
    speckles,
    ms: Math.round(t1 - t0),
  };
}

/* ---------------------------------------------------- CIELab 色差空间 */

const SRGB_LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** sRGB → CIELab（D65）。感知均匀，用来替代 RGB 欧氏距离。 */
export function rgbToLab(r, g, b) {
  const R = SRGB_LIN[r | 0];
  const G = SRGB_LIN[g | 0];
  const B = SRGB_LIN[b | 0];
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  let z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIELab → sRGB */
export function labToRgb(L, a, bb) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const finv = (t) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = finv(fx) * 0.95047;
  const y = finv(fy);
  const z = finv(fz) * 1.08883;
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [enc(R), enc(G), enc(B)];
}

/* ---------------------------------------------------------- 颜色统计 */

/** 统计 alpha>0 的唯一 RGB 色数。 */
export function countColors(img) {
  const { data } = img;
  const set = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return set.size;
}

/** 按出现次数排序的调色板（最多 limit 项）：[[r,g,b,count], ...] */
export function paletteOf(img, limit = 64) {
  const { data } = img;
  const map = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, n]);
}

/* ------------------------------------------------------------ 限色 */

function makeBox(items) {
  let minL = 1e9, maxL = -1e9, minA = 1e9, maxA = -1e9, minB = 1e9, maxB = -1e9;
  let count = 0, sumL = 0, sumA = 0, sumB = 0;
  for (const c of items) {
    if (c.L < minL) minL = c.L;
    if (c.L > maxL) maxL = c.L;
    if (c.A < minA) minA = c.A;
    if (c.A > maxA) maxA = c.A;
    if (c.B < minB) minB = c.B;
    if (c.B > maxB) maxB = c.B;
    count += c.n;
    sumL += c.L * c.n;
    sumA += c.A * c.n;
    sumB += c.B * c.n;
  }
  const dL = maxL - minL;
  const dA = maxA - minA;
  const dB = maxB - minB;
  const ch = dL >= dA && dL >= dB ? 'L' : dA >= dB ? 'A' : 'B';
  return { items, count, sumL, sumA, sumB, ch, span: Math.max(dL, dA, dB) };
}

function splitBox(box) {
  const ch = box.ch;
  const items = box.items.slice().sort((a, b) => a[ch] - b[ch] || a.key - b.key);
  const half = box.count / 2;
  let acc = 0;
  let cut = items.length >> 1;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].n;
    if (acc >= half) {
      cut = i + 1;
      break;
    }
  }
  cut = Math.max(1, Math.min(items.length - 1, cut));
  return [makeBox(items.slice(0, cut)), makeBox(items.slice(cut))];
}

function medianCut(all, maxColors) {
  const boxes = [makeBox(all)];
  while (boxes.length < maxColors) {
    let target = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.items.length < 2 || b.span <= 0) continue;
      const score = b.span * b.count;
      if (score > bestScore) {
        bestScore = score;
        target = i;
      }
    }
    if (target < 0) break;
    const parts = splitBox(boxes[target]);
    if (!parts[0].items.length || !parts[1].items.length) break;
    boxes.splice(target, 1, parts[0], parts[1]);
  }
  return boxes;
}

/** Lab 空间层次合并：反复并掉“加权 SSE 增量最小”的一对簇，直到只剩 maxColors 个。 */
function agglomerative(all, maxColors) {
  const cl = all.map((c) => ({ L: c.L, A: c.A, B: c.B, n: c.n }));
  const stride = cl.length;
  let m = cl.length;
  const D = new Float64Array(stride * stride);
  const dist = (a, b) => {
    const n = a.n + b.n;
    if (!n) return 0;
    return ((a.n * b.n) / n) * ((a.L - b.L) ** 2 + (a.A - b.A) ** 2 + (a.B - b.B) ** 2);
  };
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const d = dist(cl[i], cl[j]);
      D[i * stride + j] = d;
      D[j * stride + i] = d;
    }
  }
  while (m > maxColors) {
    let bi = 0;
    let bj = 1;
    let bd = Infinity;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const d = D[i * stride + j];
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    const A = cl[bi];
    const B = cl[bj];
    const n = A.n + B.n;
    cl[bi] = {
      L: (A.L * A.n + B.L * B.n) / n,
      A: (A.A * A.n + B.A * B.n) / n,
      B: (A.B * A.n + B.B * B.n) / n,
      n,
    };
    const last = m - 1;
    if (bj !== last) {
      cl[bj] = cl[last];
      for (let i = 0; i < m; i++) {
        D[bj * stride + i] = D[last * stride + i];
        D[i * stride + bj] = D[i * stride + last];
      }
    }
    m--;
    for (let i = 0; i < m; i++) {
      if (i === bi) continue;
      const d = dist(cl[bi], cl[i]);
      D[bi * stride + i] = d;
      D[i * stride + bi] = d;
    }
  }
  return cl.slice(0, m).map((c) => labToRgb(c.L, c.A, c.B));
}

function lloydRefine(paletteLab, all) {
  const pal = paletteLab.map((x) => x.slice());
  for (let it = 0; it < 10; it++) {
    const sums = pal.map(() => [0, 0, 0, 0]);
    for (const c of all) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < pal.length; i++) {
        const p = pal[i];
        const d = (c.L - p[0]) ** 2 + (c.A - p[1]) ** 2 + (c.B - p[2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const sm = sums[bi];
      sm[0] += c.L * c.n;
      sm[1] += c.A * c.n;
      sm[2] += c.B * c.n;
      sm[3] += c.n;
    }
    let moved = false;
    for (let i = 0; i < pal.length; i++) {
      const sm = sums[i];
      if (!sm[3]) continue;
      const L = sm[0] / sm[3];
      const A = sm[1] / sm[3];
      const B = sm[2] / sm[3];
      if (Math.abs(L - pal[i][0]) > 0.01 || Math.abs(A - pal[i][1]) > 0.01 || Math.abs(B - pal[i][2]) > 0.01) moved = true;
      pal[i] = [L, A, B];
    }
    if (!moved) break;
  }
  return pal.map((x) => labToRgb(x[0], x[1], x[2]));
}

function buildPalette(all, maxColors) {
  if (all.length <= 320) return agglomerative(all, maxColors);
  const boxes = medianCut(all, maxColors);
  const paletteLab = boxes.map((b) => [b.sumL / b.count, b.sumA / b.count, b.sumB / b.count]);
  return lloydRefine(paletteLab, all);
}

/** 按“与已有簇中心 Lab 距离 < T”贪心归并；先扫高频色，AA 混色会被吸进主色。 */
function proximityClusters(entries, T) {
  const sorted = entries.slice().sort((a, b) => b.n - a.n || a.key - b.key);
  const clusters = [];
  const t2 = T * T;
  for (const c of sorted) {
    let best = null;
    let bd = t2;
    for (const cl of clusters) {
      const d = (c.L - cl.L) ** 2 + (c.A - cl.A) ** 2 + (c.B - cl.B) ** 2;
      if (d < bd) {
        bd = d;
        best = cl;
      }
    }
    if (best) {
      const n = best.n + c.n;
      best.L = (best.L * best.n + c.L * c.n) / n;
      best.A = (best.A * best.n + c.A * c.n) / n;
      best.B = (best.B * best.n + c.B * c.n) / n;
      best.n = n;
    } else {
      clusters.push({ L: c.L, A: c.A, B: c.B, n: c.n, seedL: c.L, seedA: c.A, seedB: c.B });
    }
  }
  return clusters;
}

export function groupByProximity(entries, T) {
  return proximityClusters(entries, T).map((c) => labToRgb(c.seedL, c.seedA, c.seedB));
}

function labEntries(img) {
  const { data } = img;
  const map = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const e = map.get(key);
    if (e) e.n++;
    else {
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      map.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], key, n: 1, L: lab[0], A: lab[1], B: lab[2] });
    }
  }
  return [...map.values()];
}

/** 把每个像素吸到调色板里 Lab 最近的颜色上。 */
export function snapToPalette(img, palette) {
  if (!palette || !palette.length) return img;
  const palLab = palette.map((p) => rgbToLab(p[0], p[1], p[2]));
  const lut = new Map();
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      out[i + 3] = 0;
      continue;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let p = lut.get(key);
    if (!p) {
      const L = rgbToLab(data[i], data[i + 1], data[i + 2]);
      let bi = 0;
      let bd = Infinity;
      for (let k = 0; k < palLab.length; k++) {
        const q = palLab[k];
        const d = (L[0] - q[0]) ** 2 + (L[1] - q[1]) ** 2 + (L[2] - q[2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = k;
        }
      }
      p = palette[bi];
      lut.set(key, p);
    }
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
    out[i + 3] = data[i + 3];
  }
  return { data: out, width, height };
}

/**
 * 限色（CIELab 空间）：唯一色 ≤320 走层次合并，否则中位切分 + Lloyd 精修。
 * 合并与吸附都用 Lab 距离，避免 RGB 把“深藏青 vs 纯黑”判得过近导致发灰。
 */
export function quantize(img, maxColors) {
  const all = labEntries(img);
  const before = all.length;
  if (!before) return { image: img, before: 0, after: 0, palette: [] };
  if (!(maxColors >= 2) || before <= maxColors) {
    return { image: img, before, after: before, palette: all.map((c) => [c.r, c.g, c.b]) };
  }
  const palette = buildPalette(all, maxColors);
  const outImg = snapToPalette(img, palette);
  const seen = new Set();
  const uniq = [];
  for (const p of palette) {
    const k = (p[0] << 16) | (p[1] << 8) | p[2];
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  return { image: outImg, before, after: countColors(outImg), palette: uniq };
}

/** 上游 fix_square 的移植：差一列/行时补齐成正方形。 */
export function fixSquare(img) {
  const { data, width: w, height: h } = img;
  if (w > h) {
    if (w % 2 === 1) return cropCols(img, w - 1);
    return dupFirstRow(img);
  }
  if (h % 2 === 1) return cropRows(img, h - 1);
  return dupFirstCol(img);
}

function cropCols(img, nw) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(nw * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(data.subarray(y * w * 4, y * w * 4 + nw * 4), y * nw * 4);
  }
  return { data: out, width: nw, height: h };
}

function cropRows(img, nh) {
  const { data, width: w } = img;
  return { data: data.slice(0, w * nh * 4), width: w, height: nh };
}

function dupFirstRow(img) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(w * (h + 1) * 4);
  out.set(data.subarray(0, w * 4), 0);
  out.set(data, w * 4);
  return { data: out, width: w, height: h + 1 };
}

function dupFirstCol(img) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray((w + 1) * h * 4);
  for (let y = 0; y < h; y++) {
    const src = y * w * 4;
    const dst = y * (w + 1) * 4;
    out.set(data.subarray(src, src + 4), dst);
    out.set(data.subarray(src, src + w * 4), dst + 4);
  }
  return { data: out, width: w + 1, height: h };
}

/* ------------------------------------------------------------- 放大/导出 */

export function scaleNearest(img, nw, nh) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const s = (sy * w + sx) * 4;
      const d = (y * nw + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

/** 整数倍放大（像素完美）；非整除时退回最近邻。 */
export function scaleToSquare(img, size) {
  const f = Math.max(1, Math.floor(size / Math.max(img.width, img.height)));
  if (img.width * f === size && img.height * f === size) {
    return { image: scaleNearest(img, size, size), factor: f, exact: true };
  }
  return { image: scaleNearest(img, size, size), factor: size / Math.max(img.width, img.height), exact: false };
}
