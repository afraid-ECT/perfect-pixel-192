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

  if(opts.maskOnly)return { background:bg, transparentBg };

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

/** Extract a dominant subject before sampling so background hues do not enter its palette. */
function sampleSubjectFusion(img, xs, ys) {
  const {width,height,data}=img;
  const n=width*height;
  const {background,transparentBg}=cleanOutside(img,{maxRing:1,ringTol:16,maskOnly:true});
  let cutout=img;
  if(!transparentBg){
    const seen=new Uint8Array(n), queue=new Int32Array(n);
    let largest=queue.subarray(0,0), total=0;
    for(let i=0;i<n;i++){
      if(seen[i]||background[i]||!data[i*4+3])continue;
      let tail=1;
      seen[i]=1;queue[0]=i;
      for(let head=0;head<tail;head++){
        const p=queue[head],x=p%width,y=Math.floor(p/width);
        for(let yy=Math.max(0,y-1);yy<=Math.min(height-1,y+1);yy++){
          for(let xx=Math.max(0,x-1);xx<=Math.min(width-1,x+1);xx++){
            const j=yy*width+xx;
            if(seen[j]||background[j]||!data[j*4+3])continue;
            seen[j]=1;queue[tail++]=j;
          }
        }
      }
      total+=tail;
      if(tail>largest.length)largest=queue.slice(0,tail);
    }
    // Leave the source intact if the boundary flood does not establish a
    // background and a single, dominant foreground component.
    if(largest.length<8||largest.length<total*.75||largest.length>n*.80){
      return {image:sampleCells(img,xs,ys,'center'),ambiguous:true};
    }
    const pixels=new Uint8ClampedArray(data.length);
    for(const i of largest)pixels.set(data.subarray(4*i,4*i+4),4*i);
    cutout={width,height,data:pixels};
  }

  const sampled=sampleCells(cutout,xs,ys,'center');
  const {width:w,height:h,data:out}=sampled;
  const remove=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;
    if(!out[4*i+3])continue;
    const neighbours=(x>0&&out[4*(i-1)+3]>0)+(x+1<w&&out[4*(i+1)+3]>0)
      +(y>0&&out[4*(i-w)+3]>0)+(y+1<h&&out[4*(i+w)+3]>0);
    if(neighbours!==1)continue;
    const [x0,x1,y0,y1]=clampRect(xs[x],xs[x+1],ys[y],ys[y+1],width,height);
    let coverage=0;
    for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)coverage+=cutout.data[(yy*width+xx)*4+3];
    // Only trim a spur when the original cell is mostly background. A
    // solid native pixel, detached detail, or narrow connected tip survives.
    if(coverage<255*(x1-x0)*(y1-y0)*.40)remove.push(i);
  }
  for(const i of remove)out.fill(0,4*i,4*i+4);
  return {image:sampled,ambiguous:false};
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
  if (o.forceGrid && !(o.gridW > 0 || o.gridH > 0)) {
    // A shared cell size can round to different effective sizes at the
    // image edges. Adjust only when rounding cannot explain the mismatch.
    const minPitch = Math.max(w / (gridW + 0.5), h / (gridH + 0.5));
    const maxPitch = Math.min(w / (gridW - 0.5), h / (gridH - 0.5));
    if (minPitch >= maxPitch) {
      const cell = Math.min(w / gridW, h / gridH);
      gridW = Math.max(1, Math.round(w / cell));
      gridH = Math.max(1, Math.round(h / cell));
    }
  }
  const cellW = w / gridW;
  const cellH = h / gridH;

  const xs = o.forceGrid ? Array.from({length:gridW+1}, (_,i)=>i*w/gridW) : refineLines(w, cellW, gx, o.refine);
  const ys = o.forceGrid ? Array.from({length:gridH+1}, (_,i)=>i*h/gridH) : refineLines(h, cellH, gy, o.refine);

  const mode = o.sample;
  const isRegion = mode === 'region';
  const isStrong = mode === 'strong';
  const isTonal = mode === 'scene-tonal';

  const isElement = mode === 'scene-element';
  const isStraight = mode === 'scene-straight';
  const isContour = mode === 'scene-contour' || mode === 'scene-general-edges' || mode === 'scene-traced-edges'
    || mode === 'scene-anchored-lines';

  // 采样式
  let sampled;
  let regionPalette = null;
  let tonalRegions = 0;
  let subjectAmbiguous = false;
  let straightStats = null;
  if (isRegion) {
    const st = sampleStrongCells(img, xs, ys);
    sampled = st.image;
    regionPalette = buildStrongPalette(sampled, st.conf, o.colors, o.strongColors || 24);
  } else if (isElement) {
    // 元素分割：先认细线等细节元素并保护，再按各元素自己的明暗跨度定额
    const t = sampleSceneElement(img, xs, ys, o.sceneOpts || {});
    sampled = t.image;
    tonalRegions = t.regions;
  } else if (isStraight) {
    const t = sampleSceneStraight(img, xs, ys, o.sceneOpts || {});
    sampled = t.image;
    tonalRegions = t.objects;
    const {image,diagnostics,budgetExceeded,...stats} = t;
    straightStats = {...stats,...(budgetExceeded?{straightBudgetExceeded:true}:{})};
  } else if (isContour) {
    const fn = mode === 'scene-anchored-lines' ? sampleSceneAnchoredLines
      : mode === 'scene-traced-edges' ? sampleSceneTracedEdges
      : mode === 'scene-general-edges' ? sampleSceneGeneralEdges : sampleSceneContour;
    const t = fn(img, xs, ys, o.sceneOpts || {});
    sampled = t.image;
    tonalRegions = t.objects;
  } else if (mode === 'subject-fusion') {
    const t=sampleSubjectFusion(img,xs,ys);
    sampled=t.image;
    subjectAmbiguous=t.ambiguous;
  } else if (isTonal) {
    // 区域自适应：采样与限色一步完成，色数取「颜色数」，未选则 64
    const k = o.colors >= 2 ? o.colors : (o.tonalColors || 64);
    const t = sampleSceneTonal(img, xs, ys, k);
    sampled = t.image;
    tonalRegions = t.regions;
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
  } else if (isTonal || isElement || isContour || isStraight) {
    // 这些模式在采样阶段已经把颜色压到"区域级"（几十到两百色）。
    // 此时再走 quantize，等于"在已有的一小撮颜色里按面积加权做 Lab 层次合并"，
    // 不破坏区域结构，但严格服从用户选的色数。（tonal 本身就用 colors 当目标 k）
    if (o.colors >= 2 && colorsAfter > o.colors) {
      result = quantize(result, o.colors).image;
    }
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
    ...(subjectAmbiguous?{subjectAmbiguous}:{}),
    ...straightStats,
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

/* ============================================================ 整图·区域自适应（tonal）

  背景：全图共用一个调色板时，小物体（黄色垃圾桶）抢不到色数，
  大面积平滑区又会被饱和色的配额挤掉，于是出现两件事：
    ① 小物体只剩一个平色，失去明暗
    ② 平滑面上两个调色板色相距很远，交界成硬边，看起来像噪点

  做法：
    1. 区域生长（与种子色的 Lab 距离判定，不用区域均值，避免渐变被整体吞掉）
    2. 先把碎小区域并进颜色最近的大区（把区域数压到可算范围）
    3. Ward 合并（代价 = n1·n2/(n1+n2)·ΔE²）到 regionCap 个区
       小的、孤立的区域代价高 → 不会被并掉
    4. 每区保底 1 色，剩余按 sqrt(面积)·(1+σ/4) 分配
    5. 区内沿"方差最大的通道"等距切分 → 阶梯均匀
    6. 吸附只在本区域的调色板里选 → 白色永远吸不到黄色
    7. 去孤点（只清 3×3 里只出现一次的像素）
*/

function _pxLab(img) {
  const { data } = img;
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  const cache = new Map();
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    let v = cache.get(key);
    if (!v) { v = rgbToLab(data[p], data[p + 1], data[p + 2]); cache.set(key, v); }
    lab[i * 3] = v[0]; lab[i * 3 + 1] = v[1]; lab[i * 3 + 2] = v[2];
  }
  return lab;
}

function _growRegions(img, lab, tol) {
  const { width: W, height: H, data } = img;
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const tol2 = tol * tol;
  let nreg = 0;
  for (let s = 0; s < N; s++) {
    if (label[s] >= 0 || data[s * 4 + 3] === 0) continue;
    const sL = lab[s * 3], sA = lab[s * 3 + 1], sB = lab[s * 3 + 2];
    const id = nreg++;
    let sp = 0; stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 4; d++) {
        const j = d === 0 ? (x > 0 ? i - 1 : -1)
          : d === 1 ? (x < W - 1 ? i + 1 : -1)
            : d === 2 ? (y > 0 ? i - W : -1)
              : (y < H - 1 ? i + W : -1);
        if (j < 0 || label[j] >= 0 || data[j * 4 + 3] === 0) continue;
        const dL = lab[j * 3] - sL, dA = lab[j * 3 + 1] - sA, dB = lab[j * 3 + 2] - sB;
        if (dL * dL + dA * dA + dB * dB <= tol2) { label[j] = id; stack[sp++] = j; }
      }
    }
  }
  return { label, nreg };
}

function _stats(label, lab, nreg) {
  const N = label.length;
  const cnt = new Float64Array(nreg);
  const mean = new Float64Array(nreg * 3);
  for (let i = 0; i < N; i++) {
    const r = label[i];
    if (r < 0) continue;
    cnt[r]++;
    mean[r * 3] += lab[i * 3]; mean[r * 3 + 1] += lab[i * 3 + 1]; mean[r * 3 + 2] += lab[i * 3 + 2];
  }
  for (let r = 0; r < nreg; r++) {
    if (!cnt[r]) continue;
    mean[r * 3] /= cnt[r]; mean[r * 3 + 1] /= cnt[r]; mean[r * 3 + 2] /= cnt[r];
  }
  const var3 = new Float64Array(nreg * 3);
  for (let i = 0; i < N; i++) {
    const r = label[i];
    if (r < 0) continue;
    const dL = lab[i * 3] - mean[r * 3];
    const dA = lab[i * 3 + 1] - mean[r * 3 + 1];
    const dB = lab[i * 3 + 2] - mean[r * 3 + 2];
    var3[r * 3] += dL * dL; var3[r * 3 + 1] += dA * dA; var3[r * 3 + 2] += dB * dB;
  }
  const sigma = new Float64Array(nreg);
  const axis = new Int8Array(nreg);
  for (let r = 0; r < nreg; r++) {
    if (!cnt[r]) continue;
    for (let c = 0; c < 3; c++) var3[r * 3 + c] /= cnt[r];
    let k = 0;
    if (var3[r * 3 + 1] > var3[r * 3 + k]) k = 1;
    if (var3[r * 3 + 2] > var3[r * 3 + k]) k = 2;
    axis[r] = k;
    sigma[r] = Math.sqrt(var3[r * 3 + k]);
  }
  return { cnt, mean, sigma, axis };
}

function _reindex(label, nreg) {
  const remap = new Int32Array(nreg).fill(-1);
  let next = 0;
  for (let i = 0; i < label.length; i++) {
    const q = label[i];
    if (q < 0) continue;
    if (remap[q] < 0) remap[q] = next++;
    label[i] = remap[q];
  }
  return next;
}

/** 碎区归并：保留面积最大的 keepN 个，其余并进颜色最近的大区。 */
function _reduceRegions(label, lab, nreg, keepN) {
  const st = _stats(label, lab, nreg);
  const alive = [];
  for (let r = 0; r < nreg; r++) if (st.cnt[r] > 0) alive.push(r);
  if (alive.length <= keepN) return nreg;
  alive.sort((a, b) => st.cnt[b] - st.cnt[a] || a - b);
  const keep = alive.slice(0, keepN);
  const drop = alive.slice(keepN);
  const target = new Map();
  for (const r of drop) {
    let best = keep[0], bd = Infinity;
    for (const q of keep) {
      const d = (st.mean[r * 3] - st.mean[q * 3]) ** 2 + (st.mean[r * 3 + 1] - st.mean[q * 3 + 1]) ** 2
        + (st.mean[r * 3 + 2] - st.mean[q * 3 + 2]) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    target.set(r, best);
  }
  for (let i = 0; i < label.length; i++) {
    const t = target.get(label[i]);
    if (t !== undefined) label[i] = t;
  }
  return _reindex(label, nreg);
}

/** Ward 合并到 cap 个区：代价 = n1·n2/(n1+n2)·ΔE²，小的孤立的区不会被并掉。 */
function _wardToCap(label, lab, nreg, cap) {
  const st = _stats(label, lab, nreg);
  const cnt = Array.from(st.cnt);
  const mean = Array.from(st.mean);
  const alive = new Set();
  for (let r = 0; r < nreg; r++) if (cnt[r] > 0) alive.add(r);
  while (alive.size > cap) {
    let bi = -1, bj = -1, bc = Infinity;
    const list = [...alive];
    for (let a = 0; a < list.length; a++) {
      const i = list[a];
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b];
        const n = cnt[i] + cnt[j];
        const d = (mean[i * 3] - mean[j * 3]) ** 2 + (mean[i * 3 + 1] - mean[j * 3 + 1]) ** 2
          + (mean[i * 3 + 2] - mean[j * 3 + 2]) ** 2;
        const c = ((cnt[i] * cnt[j]) / n) * d;
        if (c < bc) { bc = c; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    const n = cnt[bi] + cnt[bj];
    for (let c = 0; c < 3; c++) {
      mean[bi * 3 + c] = (mean[bi * 3 + c] * cnt[bi] + mean[bj * 3 + c] * cnt[bj]) / n;
    }
    cnt[bi] = n;
    for (let i = 0; i < label.length; i++) if (label[i] === bj) label[i] = bi;
    cnt[bj] = 0;
    alive.delete(bj);
  }
  return _reindex(label, nreg);
}

function _despecklePal(img) {
  const { data, width: W, height: H } = img;
  const dst = new Uint8ClampedArray(data);
  const cnt = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!data[i + 3]) continue;
      const self = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      cnt.clear();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = (yy * W + xx) * 4;
          if (!data[j + 3]) continue;
          const k = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
          cnt.set(k, (cnt.get(k) || 0) + 1);
        }
      }
      if ((cnt.get(self) || 0) > 1) continue;
      let bk = -1, bn = 0;
      for (const [k2, n2] of cnt) if (n2 > bn) { bn = n2; bk = k2; }
      if (bn >= 5) { dst[i] = (bk >> 16) & 255; dst[i + 1] = (bk >> 8) & 255; dst[i + 2] = bk & 255; }
    }
  }
  return { ...img, data: dst };
}

/**
 * 整图·区域自适应采样 + 限色。
 * @param {object} img  源图 {data,width,height}
 * @param {number[]} xs 网格 x 边界
 * @param {number[]} ys 网格 y 边界
 * @param {number} k    色数目标
 */
export function sampleSceneTonal(img, xs, ys, k = 64, opts = {}) {
  const { width: W, height: H, data } = img;
  const nx = xs.length - 1, ny = ys.length - 1;

  // ① 格采样：Lab 亮度加权中位数（保边、不造中间色）
  const sampled = { data: new Uint8ClampedArray(nx * ny * 4), width: nx, height: ny };
  const out = sampled.data;
  for (let j = 0; j < ny; j++) {
    const y0 = Math.max(0, Math.floor(ys[j])), y1 = Math.min(H, Math.ceil(ys[j + 1]));
    for (let i = 0; i < nx; i++) {
      const x0 = Math.max(0, Math.floor(xs[i])), x1 = Math.min(W, Math.ceil(xs[i + 1]));
      const list = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * W + x) * 4;
          if (data[p + 3] === 0) continue;
          const a = (Math.min(x + 1, xs[i + 1]) - Math.max(x, xs[i]))
            * (Math.min(y + 1, ys[j + 1]) - Math.max(y, ys[j]));
          list.push([0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2], p, a]);
        }
      }
      if (!list.length) continue;
      list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let tot = 0;
      for (const t of list) tot += t[2];
      let acc = 0, pick = list[list.length - 1];
      for (const t of list) { acc += t[2]; if (acc >= tot / 2) { pick = t; break; } }
      const q = (j * nx + i) * 4;
      out[q] = data[pick[1]]; out[q + 1] = data[pick[1] + 1]; out[q + 2] = data[pick[1] + 2]; out[q + 3] = 255;
    }
  }

  // ② 区域分割 + 合并
  const lab = _pxLab(sampled);
  const g = _growRegions(sampled, lab, opts.tol ?? 6);
  const pre = _reduceRegions(g.label, lab, g.nreg, opts.keepRegions ?? 600);
  const cap = Math.max(4, Math.floor(k * (opts.regionRatio ?? 0.75)));
  const nreg = _wardToCap(g.label, lab, pre, cap);
  const st = _stats(g.label, lab, nreg);

  // ③ 配额：保底 1 + 按 sqrt(面积)·(1+σ/4) 分
  const spare = Math.max(0, k - nreg);
  const w = new Float64Array(nreg);
  let wsum = 0;
  for (let r = 0; r < nreg; r++) { w[r] = Math.sqrt(st.cnt[r]) * (1 + st.sigma[r] / 4); wsum += w[r]; }
  const quota = new Int32Array(nreg).fill(1);
  for (let r = 0; r < nreg; r++) quota[r] += Math.floor((spare * w[r]) / wsum);
  let used = 0;
  for (let r = 0; r < nreg; r++) used += quota[r];
  let left = k - used;
  if (left > 0) {
    const order = [...Array(nreg).keys()].sort((a, b) => {
      const fa = (spare * w[a]) / wsum - Math.floor((spare * w[a]) / wsum);
      const fb = (spare * w[b]) / wsum - Math.floor((spare * w[b]) / wsum);
      return fb - fa || st.cnt[b] - st.cnt[a] || a - b;
    });
    for (let i = 0; i < order.length && left > 0; i++, left--) quota[order[i]]++;
  }

  // ④ 区内沿主方差通道等距切分
  const buckets = Array.from({ length: nreg }, () => []);
  for (let i = 0; i < nx * ny; i++) { const r = g.label[i]; if (r >= 0) buckets[r].push(i); }
  const perRegion = new Array(nreg);
  const palLab = new Array(nreg);
  for (let r = 0; r < nreg; r++) {
    const idxs = buckets[r];
    const ax = st.axis[r];
    if (!idxs.length) { perRegion[r] = []; palLab[r] = []; continue; }
    const vals = idxs.map((i) => [lab[i * 3 + ax], lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
    vals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const qn = quota[r], m = vals.length;
    const cols = [], lcols = [];
    for (let c = 0; c < qn; c++) {
      const a0 = Math.floor((c * m) / qn);
      const a1 = Math.max(a0 + 1, Math.floor(((c + 1) * m) / qn));
      let sL = 0, sA = 0, sB = 0, n = 0;
      for (let i = a0; i < a1 && i < m; i++) { sL += vals[i][1]; sA += vals[i][2]; sB += vals[i][3]; n++; }
      if (!n) continue;
      const L = sL / n, A = sA / n, B = sB / n;
      lcols.push([L, A, B]);
      cols.push(labToRgb(L, A, B));
    }
    perRegion[r] = cols;
    palLab[r] = lcols;
  }

  // ⑤ 吸附（只在本区域调色板里选）
  const res = new Uint8ClampedArray(sampled.data.length);
  for (let i = 0; i < nx * ny; i++) {
    const p = i * 4;
    if (!out[p + 3]) { res[p + 3] = 0; continue; }
    const r = g.label[i];
    const list = perRegion[r];
    const pl = palLab[r];
    if (!list || !list.length) {
      res[p] = out[p]; res[p + 1] = out[p + 1]; res[p + 2] = out[p + 2]; res[p + 3] = 255; continue;
    }
    let best = 0, bd = Infinity;
    for (let c = 0; c < pl.length; c++) {
      const qq = pl[c];
      const d = (lab[i * 3] - qq[0]) ** 2 + (lab[i * 3 + 1] - qq[1]) ** 2 + (lab[i * 3 + 2] - qq[2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    const cc = list[best];
    res[p] = cc[0]; res[p + 1] = cc[1]; res[p + 2] = cc[2]; res[p + 3] = 255;
  }

  // ⑥ 去孤点
  let outImg = { data: res, width: nx, height: ny };
  for (let pass = 0; pass < (opts.cohere ?? 2); pass++) outImg = _despecklePal(outImg);

  return { image: outImg, regions: nreg };
}

/* ===== 整图·元素分割（element）===== */

/**
 * 整图采样 · A 方案：元素分割 + 逐元素定额
 *
 * 与 tonal 的区别：
 *   tonal    全局 k 色按 sqrt(面积)·σ 分配 → 细线抢不过大墙面
 *   element  先认定「元素」，每个元素按自己的明暗跨度定额 → 线、面各拿各的，
 *            总色数不是硬上限，而是各元素需求加出来的
 *
 * 元素认定（在区域生长之后、任何合并之前做）：
 *   面积 ≥ protectArea 且 与其它任一区域的最小 ΔE ≥ protectDelta
 *   → 1px 长线：面积够、色差大 → 保护
 *   → 零星噪点：面积太小          → 不保护，会被并掉
 */


/* ---------------------------------------------------------------- 采样 */

function sampleMedianL(img, xs, ys) {
  const { width: W, height: H, data } = img;
  const nx = xs.length - 1, ny = ys.length - 1;
  const out = { data: new Uint8ClampedArray(nx * ny * 4), width: nx, height: ny };
  for (let j = 0; j < ny; j++) {
    const y0 = Math.max(0, Math.floor(ys[j])), y1 = Math.min(H, Math.ceil(ys[j + 1]));
    for (let i = 0; i < nx; i++) {
      const x0 = Math.max(0, Math.floor(xs[i])), x1 = Math.min(W, Math.ceil(xs[i + 1]));
      const list = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * W + x) * 4;
          if (data[p + 3] === 0) continue;
          const a = (Math.min(x + 1, xs[i + 1]) - Math.max(x, xs[i]))
            * (Math.min(y + 1, ys[j + 1]) - Math.max(y, ys[j]));
          list.push([0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2], p, a]);
        }
      }
      if (!list.length) continue;
      list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let tot = 0;
      for (const t of list) tot += t[2];
      let acc = 0, pick = list[list.length - 1];
      for (const t of list) { acc += t[2]; if (acc >= tot / 2) { pick = t; break; } }
      const q = (j * nx + i) * 4;
      out.data[q] = data[pick[1]]; out.data[q + 1] = data[pick[1] + 1];
      out.data[q + 2] = data[pick[1] + 2]; out.data[q + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------ Lab 缓存 */

function pxLab(img) {
  const { data } = img;
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  const cache = new Map();
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    let v = cache.get(key);
    if (!v) { v = rgbToLab(data[p], data[p + 1], data[p + 2]); cache.set(key, v); }
    lab[i * 3] = v[0]; lab[i * 3 + 1] = v[1]; lab[i * 3 + 2] = v[2];
  }
  return lab;
}

/* ---------------------------------------------------------- 区域生长 */

function growRegions(img, lab, tol) {
  const { width: W, height: H, data } = img;
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const tol2 = tol * tol;
  let nreg = 0;
  for (let s = 0; s < N; s++) {
    if (label[s] >= 0 || data[s * 4 + 3] === 0) continue;
    const sL = lab[s * 3], sA = lab[s * 3 + 1], sB = lab[s * 3 + 2];
    const id = nreg++;
    let sp = 0; stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 4; d++) {
        const j = d === 0 ? (x > 0 ? i - 1 : -1)
          : d === 1 ? (x < W - 1 ? i + 1 : -1)
            : d === 2 ? (y > 0 ? i - W : -1)
              : (y < H - 1 ? i + W : -1);
        if (j < 0 || label[j] >= 0 || data[j * 4 + 3] === 0) continue;
        const dL = lab[j * 3] - sL, dA = lab[j * 3 + 1] - sA, dB = lab[j * 3 + 2] - sB;
        if (dL * dL + dA * dA + dB * dB <= tol2) { label[j] = id; stack[sp++] = j; }
      }
    }
  }
  return { label, nreg };
}

/* -------------------------------------------------------------- 统计 */

function stats(label, lab, nreg) {
  const N = label.length;
  const cnt = new Float64Array(nreg);
  const mean = new Float64Array(nreg * 3);
  const lo = new Float64Array(nreg * 3).fill(Infinity);
  const hi = new Float64Array(nreg * 3).fill(-Infinity);
  for (let i = 0; i < N; i++) {
    const r = label[i];
    if (r < 0) continue;
    cnt[r]++;
    for (let c = 0; c < 3; c++) {
      const v = lab[i * 3 + c];
      mean[r * 3 + c] += v;
      if (v < lo[r * 3 + c]) lo[r * 3 + c] = v;
      if (v > hi[r * 3 + c]) hi[r * 3 + c] = v;
    }
  }
  for (let r = 0; r < nreg; r++) {
    if (!cnt[r]) continue;
    for (let c = 0; c < 3; c++) mean[r * 3 + c] /= cnt[r];
  }
  const var3 = new Float64Array(nreg * 3);
  for (let i = 0; i < N; i++) {
    const r = label[i];
    if (r < 0) continue;
    for (let c = 0; c < 3; c++) { const d = lab[i * 3 + c] - mean[r * 3 + c]; var3[r * 3 + c] += d * d; }
  }
  const sigma = new Float64Array(nreg);
  const axis = new Int8Array(nreg);
  for (let r = 0; r < nreg; r++) {
    if (!cnt[r]) continue;
    for (let c = 0; c < 3; c++) var3[r * 3 + c] /= cnt[r];
    let k = 0;
    if (var3[r * 3 + 1] > var3[r * 3 + k]) k = 1;
    if (var3[r * 3 + 2] > var3[r * 3 + k]) k = 2;
    axis[r] = k;
    sigma[r] = Math.sqrt(var3[r * 3 + k]);
  }
  return { cnt, mean, sigma, axis, lo, hi };
}

function reindex(label, nreg) {
  const remap = new Int32Array(nreg).fill(-1);
  let next = 0;
  for (let i = 0; i < label.length; i++) {
    const q = label[i];
    if (q < 0) continue;
    if (remap[q] < 0) remap[q] = next++;
    label[i] = remap[q];
  }
  return next;
}

/* ------------------------------------------------------- 元素（保护）认定 */

function boundaryStats(label, W, H, nreg) {
  const perim = new Float64Array(nreg);
  const nb = Array.from({ length: nreg }, () => new Map());
  const add = (a, b, n) => {
    if (a < 0 || b < 0 || a === b) return;
    perim[a] += n; perim[b] += n;
    const cur = nb[a].get(b) || 0;
    nb[a].set(b, cur + n);
    const cur2 = nb[b].get(a) || 0;
    nb[b].set(a, cur2 + n);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = label[i];
      if (x < W - 1) add(a, label[i + 1], 1);
      if (y < H - 1) add(a, label[i + W], 1);
    }
  }
  return { perim, nb };
}

function findProtected(st, alive, perim, nb, opts) {
  const thinMin = opts.thinMin ?? 8;
  const contrastMin = opts.contrastMin ?? 10;
  const areaMin = opts.protectArea ?? 40;
  const ridgeGap = opts.ridgeGap ?? 3;
  const prot = new Set();
  for (const r of alive) {
    if (st.cnt[r] < areaMin) continue;
    const thin = perim[r] / Math.sqrt(st.cnt[r]);
    if (thin < thinMin) continue;

    // 必须比所有邻居都暗（或都亮）—— 这才是一条"线"，
    // 而不是某种渐变里的中间色带。
    let maxN = -Infinity, minN = Infinity, contrast = 0;
    for (const q of nb[r].keys()) {
      if (!st.cnt[q]) continue;
      const Lq = st.mean[q * 3];
      if (Lq > maxN) maxN = Lq;
      if (Lq < minN) minN = Lq;
      const d = Math.sqrt((st.mean[r * 3] - st.mean[q * 3]) ** 2
        + (st.mean[r * 3 + 1] - st.mean[q * 3 + 1]) ** 2
        + (st.mean[r * 3 + 2] - st.mean[q * 3 + 2]) ** 2);
      if (d > contrast) contrast = d;
    }
    if (!isFinite(maxN)) continue;
    const Lr = st.mean[r * 3];
    const isRidge = Lr < minN - ridgeGap || Lr > maxN + ridgeGap;
    if (!isRidge) continue;
    if (contrast >= contrastMin) prot.add(r);
  }
  return prot;
}

/** 合并颜色几乎相同的相邻区域（消除"每个面自己一个色"造成的接缝）。 */
function mergeSimilar(label, st, alive, nb, delta) {
  const parent = new Map();
  for (const r of alive) parent.set(r, r);
  const find = (x) => {
    let p = x;
    while (parent.get(p) !== p) p = parent.get(p);
    while (parent.get(x) !== p) { const nxt = parent.get(x); parent.set(x, p); x = nxt; }
    return p;
  };
  const d2 = delta * delta;
  for (const r of alive) {
    for (const q of nb[r].keys()) {
      if (q < r || !parent.has(q)) continue;
      const d = (st.mean[r * 3] - st.mean[q * 3]) ** 2 + (st.mean[r * 3 + 1] - st.mean[q * 3 + 1]) ** 2
        + (st.mean[r * 3 + 2] - st.mean[q * 3 + 2]) ** 2;
      if (d > d2) continue;
      const a = find(r), b = find(q);
      if (a !== b) parent.set(b, a);
    }
  }
  const tmap = new Map();
  for (const r of alive) tmap.set(r, find(r));
  let changed = 0;
  for (let i = 0; i < label.length; i++) {
    const t = tmap.get(label[i]);
    if (t !== undefined && t !== label[i]) { label[i] = t; changed++; }
  }
  return changed;
}

/* ------------------------------------------------------ 预并（保护项不动） */

function preMerge(label, st, alive, keepN, prot) {
  const big = alive.slice().sort((a, b) => st.cnt[b] - st.cnt[a] || a - b);
  const keep = new Set(big.slice(0, keepN));
  for (const p of prot) keep.add(p);
  const drop = alive.filter((r) => !keep.has(r));
  if (!drop.length) return alive.length;
  const keepList = [...keep];
  const tmap = new Map();
  for (const r of drop) {
    let best = keepList[0], bd = Infinity;
    for (const q of keepList) {
      const d = (st.mean[r * 3] - st.mean[q * 3]) ** 2 + (st.mean[r * 3 + 1] - st.mean[q * 3 + 1]) ** 2
        + (st.mean[r * 3 + 2] - st.mean[q * 3 + 2]) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    tmap.set(r, best);
  }
  for (let i = 0; i < label.length; i++) {
    const t = tmap.get(label[i]);
    if (t !== undefined) label[i] = t;
  }
  return keepList.length;
}

/* ---------------------------------------------------- Ward 合并（保护项缓） */

function wardMerge(label, st, nreg, prot, cap) {
  const cnt = Array.from(st.cnt);
  const mean = Array.from(st.mean);
  const alive = new Set();
  for (let r = 0; r < nreg; r++) if (cnt[r] > 0) alive.add(r);
  while (alive.size > cap) {
    const list = [...alive];
    let bi = -1, bj = -1, bc = Infinity;
    for (let a = 0; a < list.length; a++) {
      const i = list[a];
      const pi = prot.has(i);
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b];
        const pj = prot.has(j);
        if (pi && pj) continue;
        const n = cnt[i] + cnt[j];
        const d = (mean[i * 3] - mean[j * 3]) ** 2 + (mean[i * 3 + 1] - mean[j * 3 + 1]) ** 2
          + (mean[i * 3 + 2] - mean[j * 3 + 2]) ** 2;
        let c = ((cnt[i] * cnt[j]) / n) * d;
        if (pi || pj) c *= 1e6;
        if (c < bc) { bc = c; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    const n = cnt[bi] + cnt[bj];
    for (let c = 0; c < 3; c++) {
      mean[bi * 3 + c] = (mean[bi * 3 + c] * cnt[bi] + mean[bj * 3 + c] * cnt[bj]) / n;
    }
    cnt[bi] = n;
    for (let i = 0; i < label.length; i++) if (label[i] === bj) label[i] = bi;
    cnt[bj] = 0;
    alive.delete(bj);
  }
  return reindex(label, nreg);
}

/* ---------------------------------------------------------------- 主入口 */

export function sampleSceneElement(img, xs, ys, opts = {}) {
  const tol = opts.tol ?? 6;
  const keepN = opts.keepRegions ?? 1200;
  const regionCap = opts.regionCap ?? 140;
  const toneStep = opts.toneStep ?? 8;
  const maxPer = opts.maxPerRegion ?? 8;
  const maxColors = opts.maxColors ?? 160;

  // ① 格采样
  const sampled = sampleMedianL(img, xs, ys);
  const nx = sampled.width, ny = sampled.height;

  // ② 区域生长
  const lab = pxLab(sampled);
  const g = growRegions(sampled, lab, tol);
  let st = stats(g.label, lab, g.nreg);
  const alive0 = [];
  for (let r = 0; r < g.nreg; r++) if (st.cnt[r] > 0) alive0.push(r);

  // ③ 元素认定（在合并之前）
  const bs0 = boundaryStats(g.label, nx, ny, g.nreg);
  const prot0 = findProtected(st, alive0, bs0.perim, bs0.nb, opts);

  // ④ 预并：小碎区并入大区，保护项不参与
  const keptCount = preMerge(g.label, st, alive0, keepN, prot0);
  let nreg = reindex(g.label, g.nreg);
  st = stats(g.label, lab, nreg);

  // ④b 合并颜色几乎相同的相邻区域（去掉"每个面自己一个色"的接缝）
  {
    const aliveTmp = [];
    for (let r = 0; r < nreg; r++) if (st.cnt[r] > 0) aliveTmp.push(r);
    const bsTmp = boundaryStats(g.label, nx, ny, nreg);
    mergeSimilar(g.label, st, aliveTmp, bsTmp.nb, opts.mergeDelta ?? 3.5);
    nreg = reindex(g.label, g.nreg);
    st = stats(g.label, lab, nreg);
  }

  // ⑤ Ward 合并到 cap（保护项高代价，最后才被并）
  const alive1 = [];
  for (let r = 0; r < nreg; r++) if (st.cnt[r] > 0) alive1.push(r);
  const bs1 = boundaryStats(g.label, nx, ny, nreg);
  const prot1 = findProtected(st, alive1, bs1.perim, bs1.nb, opts);
  nreg = wardMerge(g.label, st, nreg, prot1, Math.max(prot1.size + 8, regionCap));
  st = stats(g.label, lab, nreg);

  // ⑥ 定额：按各元素自己的明暗跨度
  const quota = new Int32Array(nreg);
  let sum = 0;
  for (let r = 0; r < nreg; r++) {
    if (!st.cnt[r]) continue;
    const ax = st.axis[r];
    const span = st.hi[r * 3 + ax] - st.lo[r * 3 + ax];
    const q = Math.max(1, Math.min(maxPer, Math.round(span / toneStep) + 1));
    quota[r] = q;
    sum += q;
  }
  // 软上限：超了就按比例缩，但每区保底 1
  if (maxColors > 0 && sum > maxColors) {
    const scale = maxColors / sum;
    sum = 0;
    for (let r = 0; r < nreg; r++) {
      if (!quota[r]) continue;
      quota[r] = Math.max(1, Math.floor(quota[r] * scale));
      sum += quota[r];
    }
  }

  // ⑦ 区内沿主方差通道等距切分
  const buckets = Array.from({ length: nreg }, () => []);
  for (let i = 0; i < nx * ny; i++) { const r = g.label[i]; if (r >= 0) buckets[r].push(i); }
  const perRegion = new Array(nreg);
  const palLab = new Array(nreg);
  for (let r = 0; r < nreg; r++) {
    const idxs = buckets[r];
    if (!idxs.length) { perRegion[r] = []; palLab[r] = []; continue; }
    const ax = st.axis[r];
    const vals = idxs.map((i) => [lab[i * 3 + ax], lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
    vals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const qn = quota[r], m = vals.length;
    const cols = [], lcols = [];
    for (let c = 0; c < qn; c++) {
      const a0 = Math.floor((c * m) / qn);
      const a1 = Math.max(a0 + 1, Math.floor(((c + 1) * m) / qn));
      let sL = 0, sA = 0, sB = 0, n = 0;
      for (let i = a0; i < a1 && i < m; i++) { sL += vals[i][1]; sA += vals[i][2]; sB += vals[i][3]; n++; }
      if (!n) continue;
      const L = sL / n, A = sA / n, B = sB / n;
      lcols.push([L, A, B]);
      cols.push(labToRgb(L, A, B));
    }
    perRegion[r] = cols;
    palLab[r] = lcols;
  }

  // ⑧ 吸附
  const res = new Uint8ClampedArray(sampled.data.length);
  for (let i = 0; i < nx * ny; i++) {
    const p = i * 4;
    if (!sampled.data[p + 3]) { res[p + 3] = 0; continue; }
    const r = g.label[i];
    const list = perRegion[r], pl = palLab[r];
    if (!list || !list.length) {
      res[p] = sampled.data[p]; res[p + 1] = sampled.data[p + 1];
      res[p + 2] = sampled.data[p + 2]; res[p + 3] = 255; continue;
    }
    let best = 0, bd = Infinity;
    for (let c = 0; c < pl.length; c++) {
      const qq = pl[c];
      const d = (lab[i * 3] - qq[0]) ** 2 + (lab[i * 3 + 1] - qq[1]) ** 2 + (lab[i * 3 + 2] - qq[2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    const cc = list[best];
    res[p] = cc[0]; res[p + 1] = cc[1]; res[p + 2] = cc[2]; res[p + 3] = 255;
  }

  const outImg = { data: res, width: nx, height: ny };
  const set = new Set();
  for (let i = 0; i < res.length; i += 4) {
    if (!res[i + 3]) continue;
    set.add((res[i] << 16) | (res[i + 1] << 8) | res[i + 2]);
  }
  return { image: outImg, regions: nreg, kept: keptCount, protectedCount: prot1.size, colors: set.size };
}

/* ===== 整图·已有线条规整：不再沿填色连通域生成闭合框 ===== */
export function sampleSceneContour(img, xs, ys, opts = {}) {
  const base = sampleSceneElement(img, xs, ys, opts).image;
  return regularizeSceneDiagonals(base, sampleMedianL(img, xs, ys), opts);
}

export function sampleSceneContourHalo(img, xs, ys, opts = {}) {
  const base = sampleSceneElement(img, xs, ys, opts).image;
  return regularizeRaisedEdges(base, sampleMedianL(img, xs, ys), opts);
}

/** Snap evidenced diagonal dark ridges to a small rational slope, not fill boundaries. */
export function regularizeSceneDiagonals(base, source, opts = {}) {
  const W=base.width,H=base.height,N=W*H,lab=pxLab(source),bl=pxLab(base);
  const out=new Uint8ClampedArray(base.data),claimed=new Uint8Array(N),lineMask=new Uint8Array(N),cleanMask=new Uint8Array(N);
  const rejected=[],plans=[],minLength=opts.diagonalMinLength??12;
  const at=(x,y)=>x>=0&&y>=0&&x<W&&y<H?y*W+x:-1;
  const valid=i=>i>=0&&base.data[i*4+3]===255&&source.data[i*4+3]===255;
  const de=(a,b)=>Math.hypot(bl[a*3]-bl[b*3],bl[a*3+1]-bl[b*3+1],bl[a*3+2]-bl[b*3+2]);
  const gcd=(a,b)=>b?gcd(b,a%b):a;
  const ratios=[];for(let q=1;q<=8;q++)for(let p=1;p<=q;p++)if(gcd(p,q)===1)ratios.push([p,q]);
  // Region size identifies the likely background side; ambiguous sides get no AA cleanup.
  const grown=growRegions(base,bl,6),sizes=new Uint32Array(grown.nreg);
  for(const r of grown.label)if(r>=0)sizes[r]++;
  const fit=points=>{
    const n=points.length,u0=points[0][0],v0=points[0][1];
    let su=0,sv=0,suu=0,suv=0;for(const [u,v]of points){const x=u-u0,y=v-v0;su+=x;sv+=y;suu+=x*x;suv+=x*y;}
    const slope=(n*suv-su*sv)/(n*suu-su*su||1);
    if(Math.abs(slope)<0.07)return null; // horizontal/vertical lines remain byte-identical.
    let best=null;
    for(const [p,q]of ratios)for(const sign of [-1,1]){
      const m=sign*p/q;if(Math.abs(m-slope)*(points[n-1][0]-u0)>1.5)continue;
      const intercept=points.reduce((s,[u,v])=>s+v-m*u,0)/n;
      for(let phase=-q;phase<=q;phase++){
        const b=Math.round(intercept*q)/q+phase/q;
        let error=0,max=0;for(const [u,v]of points){const e=Math.abs(Math.round(m*u+b)-v);error+=e*e;max=Math.max(max,e);}
        if(max>1||error/n>0.45)continue;
        const score=error/n+q*0.0001;
        if(!best||score<best.score)best={p,q,sign,m,b,score};
      }
    }
    return best;
  };
  const between=(i,a,b)=>{
    const d=[0,1,2].map(k=>bl[b*3+k]-bl[a*3+k]);const n=d.reduce((s,x)=>s+x*x,0);if(n<100)return false;
    const t=d.reduce((s,x,k)=>s+x*(bl[i*3+k]-bl[a*3+k]),0)/n;
    return t>0.08&&t<0.94&&Math.hypot(...d.map((x,k)=>bl[i*3+k]-bl[a*3+k]-t*x))<4;
  };
  for(const transpose of [false,true]){
    const U=transpose?H:W,V=transpose?W:H;
    const index=(u,v)=>transpose?at(v,u):at(u,v);
    const candidates=Array.from({length:U},()=>[]);
    for(let u=0;u<U;u++)for(let v=3;v<V-3;v++){
      const i=index(u,v);if(!valid(i))continue;
      // Keep the darkest core, never a parallel AA shoulder.
      const prev=index(u,v-1),next=index(u,v+1);
      if(lab[prev*3]<lab[i*3]-2||lab[next*3]<lab[i*3]-2)continue;
      if(Math.abs(lab[prev*3]-lab[i*3])<0.1)continue;
      let ok=false;
      for(let r=1;r<=3;r++){
        const a=index(u,v-r),b=index(u,v+r);
        if(!valid(a)||!valid(b))continue;
        if(Math.min(lab[a*3],lab[b*3])-lab[i*3]>=7&&Math.min(bl[a*3],bl[b*3])-bl[i*3]>=7){ok=true;break;}
      }
      if(ok)candidates[u].push(v);
    }
    const used=new Set();
    const process=points=>{
      if(points.length<minLength)return;
      let f=fit(points);
      if(!f){if(opts.contourDiagnostics)rejected.push({reason:'fit',transpose,start:points[0],end:points[points.length-1],n:points.length});const mid=points.length>>1;if(points.length>=2*minLength){process(points.slice(0,mid+1));process(points.slice(mid));}return;}
      const u0=points[0][0],u1=points[points.length-1][0];
      if(Math.abs(f.m)*(u1-u0)<3)return;
      // Nearby pieces of the same edge share phase as well as slope.
      let preceding=null;
      for(let k=plans.length-1;k>=0;k--){const prev=plans[k];if(prev.transpose!==transpose||prev.sign!==f.sign||prev.p!==f.p||prev.q!==f.q)continue;
        const end=prev.points[prev.points.length-1];if(u0-end[0]>8||u0<=end[0]||Math.abs(prev.b-f.b)>1)continue;
        if(points.every(([u,v])=>Math.abs(Math.round(f.m*u+prev.b)-v)<=1)){f={...f,b:prev.b};preceding=prev;break;}
      }
      let begin=2,end=points.length-2;
      while(begin<end&&Math.abs(Math.round(f.m*points[begin][0]+f.b)-points[begin-1][1])>1)begin++;
      while(end>begin&&Math.abs(Math.round(f.m*points[end-1][0]+f.b)-points[end][1])>1)end--;
      if(end-begin<6)return;
      const interior=points.slice(begin,end),pixels=interior.map(([u])=>index(u,Math.round(f.m*u+f.b)));
      if(pixels.some(i=>!valid(i)||claimed[i]))return;
      // Different surfaces on the two sides distinguish silhouettes from panel/grout lines.
      let silhouette=0,sideMinus=0,sidePlus=0;
      for(const [u,v]of interior){const a=index(u,v-3),b=index(u,v+3);if(!valid(a)||!valid(b))continue;
        if(de(a,b)>=6)silhouette++;
        sideMinus+=sizes[grown.label[a]]||0;sidePlus+=sizes[grown.label[b]]||0;
      }
      if(silhouette<interior.length*0.6){if(opts.contourDiagnostics)rejected.push({reason:'silhouette',transpose,start:points[0],end:points[points.length-1],n:points.length});return;}
      const bgSign=sideMinus>sidePlus*1.5?-1:sidePlus>sideMinus*1.5?1:0;
      const old=interior.map(([u,v])=>index(u,v)).sort((a,b)=>bl[a*3]-bl[b*3]||a-b);
      const median=old[old.length>>1];
      let color=[...base.data.subarray(median*4,median*4+3)];
      if(preceding){const last=preceding.line[preceding.line.length-1];if(de(last,median)<12)color=preceding.color;}
      const erase=[],cleanup=[];
      for(const [u,v]of interior){
        const nv=Math.round(f.m*u+f.b),i=index(u,v);
        // Restore the old core only when it actually moved; side colours are sampled locally.
        if(nv!==v){
          for(let r=1;r<=3;r++){const anchor=index(u,v+(v<nv?-r:r));
            if(valid(anchor)&&de(i,anchor)>8){erase.push([i,anchor]);break;}
          }
        }
        if(bgSign){
          const background=index(u,v+bgSign*3),stable=index(u,v+bgSign*4);
          if(valid(background)&&valid(stable)&&de(background,stable)<5){
            for(let r=1;r<=2;r++){
              const j=index(u,v+bgSign*r);
              if(valid(j)&&j!==index(u,nv)&&between(j,i,background))cleanup.push([j,background]);
            }
          }
        }
      }
      // Do not cross another accepted line with either erasure or transition cleanup.
      if([...erase,...cleanup].some(([i])=>claimed[i]))return;
      for(const [i,a]of [...erase,...cleanup]){out.set(base.data.subarray(a*4,a*4+3),i*4);cleanMask[i]=1;}
      for(const i of pixels){out.set(color,i*4);claimed[i]=1;lineMask[i]=1;}
      plans.push({ratio:transpose?[f.q,f.p]:[f.p,f.q],transpose,sign:f.sign,p:f.p,q:f.q,b:f.b,line:pixels,color,points:interior,backgroundSide:bgSign});
    };
    for(let u=0;u<U;u++)for(const v of candidates[u]){
      const start=index(u,v);if(used.has(start))continue;
      const points=[[u,v]];used.add(start);let last=v;
      for(let nextU=u+1;nextU<U;nextU++){
        const options=candidates[nextU].filter(y=>Math.abs(y-last)<=2&&!used.has(index(nextU,y))&&de(start,index(nextU,y))<=18);
        if(!options.length)break;
        const trend=points.length>1?last-points[points.length-2][1]:0;
        options.sort((a,b)=>Math.abs(a-last-trend)-Math.abs(b-last-trend)||lab[index(nextU,a)*3]-lab[index(nextU,b)*3]||a-b);
        last=options[0];points.push([nextU,last]);used.add(index(nextU,last));
      }
      process(points);
    }
  }
  const result={image:{data:out,width:W,height:H},objects:plans.length,drawn:plans.length,skipped:0};
  if(opts.contourDiagnostics)Object.assign(result,{contours:plans,lineMask,cleanMask,source,rejected});
  return result;
}


/** Find parallel highlight/shadow ridges and render them on a shared discrete slope. */
export function regularizeRaisedEdges(base, source, opts = {}) {
  const {width, height, data} = base;
  const result = new Uint8ClampedArray(data);
  const sourceLab = pxLab(source), baseLab = pxLab(base);
  const reservations = new Uint8Array(width * height);
  const groups = [];
  const distance = (lab, a, b) => Math.hypot(
    lab[a*3]-lab[b*3], lab[a*3+1]-lab[b*3+1], lab[a*3+2]-lab[b*3+2]
  );
  const opaque = i => data[i*4+3] === 255 && source.data[i*4+3] === 255;
  const ratios = [[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[2,3],[2,5],[3,4],[3,7],[4,5],[5,6],[7,8]];
  const minLength = opts.pairedEdgeMinLength ?? 30;
  const maxSeparation = 20;

  const axes = [];
  for (const transposed of [false, true]) {
    const length = transposed ? height : width, rows = transposed ? width : height;
    const pixel = (u,v) => transposed ? u*width+v : v*width+u;
    // Each polarity has a separate score map. Comparing opposite flanks rejects one-sided fill steps.
    const strengths = [new Float32Array(length*rows), new Float32Array(length*rows)];
    for (let u=0; u<length; u++) for (let v=3; v<rows-3; v++) {
      const i = pixel(u,v);
      if (!opaque(i)) continue;
      for (let polarity=0; polarity<2; polarity++) {
        const sign = polarity ? -1 : 1;
        const sourceL = sourceLab[i*3], baseL = baseLab[i*3];
        const near = [pixel(u,v-1), pixel(u,v+1)];
        if (near.some(j=>sign*(sourceLab[j*3]-sourceL)>5 && sign*(baseLab[j*3]-baseL)>3)) continue;
        for (let radius=1; radius<=3; radius++) {
          const a=pixel(u,v-radius), b=pixel(u,v+radius);
          if (!opaque(a) || !opaque(b)) continue;
          const srcGap=Math.min(sign*(sourceL-sourceLab[a*3]),sign*(sourceL-sourceLab[b*3]));
          const baseGap=Math.min(sign*(baseL-baseLab[a*3]),sign*(baseL-baseLab[b*3]));
          if (srcGap<3 || baseGap<4 || srcGap+baseGap<13) continue;
          strengths[polarity][u*rows+v] = Math.max(strengths[polarity][u*rows+v],Math.min(26,(srcGap+baseGap)/2));
        }
      }
    }

    const edgeCells = strengths.map(scores => {
      const cells = [];
      for (let k=0; k<scores.length; k++) if (scores[k]) cells.push(k);
      return cells;
    });
    const findTracks = (polarity, offsets, slope) => {
      const scores = strengths[polarity];
      const votes = new Uint32Array(rows + 2*length);
      const firstColumn = new Int32Array(votes.length).fill(length);
      const lastColumn = new Int32Array(votes.length).fill(-1);
      for (const k of edgeCells[polarity]) {
        const u = Math.floor(k/rows), v = k%rows;
        const slot = v-offsets[u]+length;
        votes[slot]++;
        firstColumn[slot] = Math.min(firstColumn[slot],u);
        lastColumn[slot] = u;
      }
      const tracks=[];
      for (let slot=1; slot<votes.length-1; slot++) {
        if (votes[slot]<Math.max(3,minLength/5)) continue;
        const intercept=slot-length;
        let start=-1, last=-1, hits=0, merit=0, sumU=0, sumV=0, sumUU=0, sumUV=0;
        const flush=()=>{
          const span=last-start+1;
          const variance=hits*sumUU-sumU*sumU;
          const observed=variance ? (hits*sumUV-sumU*sumV)/variance : 0;
          // A tolerance band can also match a straight rail; verify the actual ridge slope.
          if (span>=minLength && hits/span>=0.78 && Math.abs(slope)*(span-1)>=5
              && observed*slope>0 && Math.abs(observed-slope)<Math.max(0.045,1.3/span)
              && Math.abs(observed)>=Math.abs(slope)*0.72) {
            tracks.push({intercept,start,end:last,quality:merit/span});
          }
          start=last=-1; hits=merit=sumU=sumV=sumUU=sumUV=0;
        };
        const first = Math.min(firstColumn[slot-1],firstColumn[slot],firstColumn[slot+1]);
        const lastSupport = Math.max(lastColumn[slot-1],lastColumn[slot],lastColumn[slot+1]);
        for (let u=first; u<=lastSupport; u++) {
          const v=offsets[u]+intercept;
          if (v<2 || v>=rows-2) continue;
          const k=u*rows+v;
          const evidence=Math.max(scores[k],0.65*scores[k-1],0.65*scores[k+1]);
          if (evidence) {
            if (start>=0 && u-last>3) flush();
            if (start<0) start=u;
            const centre=scores[k], before=scores[k-1], after=scores[k+1];
            const observedV=v+(before>centre+1 && before>=after ? -1 : after>centre+1 ? 1 : 0);
            last=u; hits++; merit+=evidence;
            sumU+=u; sumV+=observedV; sumUU+=u*u; sumUV+=u*observedV;
          }
        }
        flush();
      }
      return tracks;
    };

    const candidates=[];
    for (const [rise,run] of ratios) for (const direction of [-1,1]) {
      const offsets=Int32Array.from({length},(_,u)=>Math.round(direction*u*rise/run));
      const bright=findTracks(0,offsets,direction*rise/run), dark=findTracks(1,offsets,direction*rise/run);
      const byIntercept=new Map();
      for (const line of dark) {
        if (!byIntercept.has(line.intercept)) byIntercept.set(line.intercept,[]);
        byIntercept.get(line.intercept).push(line);
      }
      for (const light of bright) for (let delta=3; delta<=maxSeparation; delta++) for (const side of [-1,1]) {
        for (const shade of byIntercept.get(light.intercept+side*delta) || []) {
          const start=Math.max(light.start,shade.start),end=Math.min(light.end,shade.end),span=end-start+1;
          if (span<minLength || span<0.70*Math.max(light.end-light.start+1,shade.end-shade.start+1)) continue;
          const quality=span*(light.quality+shade.quality)/(1+0.017*delta+0.012*(run-1));
          candidates.push({rise,run,direction,start,end,light,shade,quality});
        }
      }
    }
    axes.push({transposed,rows,pixel,strengths,candidates,accepted:[]});
  }

  const ranked=axes.flatMap(axis=>axis.candidates.map(candidate=>({axis,candidate})));
  ranked.sort((a,b)=>b.candidate.quality-a.candidate.quality);
  // A 45-degree edge can be detected on either axis. Compare both fits before rendering.
  for (const {axis,candidate} of ranked) {
    const {transposed,rows,pixel,strengths,accepted} = axis;
    const {rise,run,direction,start,end,light,shade} = candidate;
    const slope=direction*rise/run;
    const collides=accepted.some(other=>{
      const l=Math.max(start,other.start),r=Math.min(end,other.end);
      if(r-l<5)return false;
      const m=(l+r)/2;
      return [light,shade].some(a=>other.tracks.some(b=>Math.abs(slope*m+a.intercept-other.slope*m-b.intercept)<=3));
    });
    if(collides)continue;

    // Let the bottom of the same panel contribute a second dark line. It can
    // follow the shared slope up to two cells away, with supported endpoints and stable adjacent surfaces.
    const side=Math.sign(shade.intercept-light.intercept);
    const span=end-start+1;
    let underside=null, undersideScore=0;
    for(let gap=9; gap<=32; gap++){
      const intercept=shade.intercept+side*gap;
      let hits=0, first=-1, last=-1, value=0;
      for(let u=start;u<=end;u++){
        const v=Math.round(slope*u)+intercept;
        if(v<4||v>=rows-4)continue;
        const k=u*rows+v;
        const above=pixel(u,v-4),below=pixel(u,v+4);
        if(!opaque(above)||!opaque(below)||distance(baseLab,above,below)<10)continue;
        const map=strengths[1];
        const merit=Math.max(map[k],0.8*map[k-1],0.8*map[k+1],0.55*map[k-2],0.55*map[k+2],0.3*map[k-3],0.3*map[k+3]);
        if(!merit)continue;
        value+=merit;hits++;
        if(first<0)first=u;
        last=u;
      }
      if(hits>=span*0.70 && first<=start+span*0.18 && last>=end-span*0.18 && value>undersideScore){
        underside={intercept,start:first,end:last};
        undersideScore=value;
      }
    }
    const tracks=[light,shade];
    if(underside)tracks.push(underside);

    // Search one shared phase. All stripes then step on the same columns.
    let best=null;
    for(let phase=-run;phase<=run;phase++){
      const fraction=phase/run;
      let score=0, hits=0, total=0;
      for(let n=0;n<tracks.length;n++){
        const line=tracks[n],map=strengths[n===0?0:1];
        for(let u=Math.max(start,line.start);u<=Math.min(end,line.end);u++){
          const v=Math.round(slope*u+fraction)+line.intercept;
          if(v<2||v>=rows-2)continue;
          const k=u*rows+v;
          total++;
          const value=Math.max(map[k],0.65*map[k-1],0.65*map[k+1],n===2?0.55*map[k-2]:0,n===2?0.55*map[k+2]:0,n===2?0.3*map[k-3]:0,n===2?0.3*map[k+3]:0);
          if(value){score+=value;hits++;}
        }
      }
      if (!best || score>best.score) best={fraction,score,hits,total};
    }
    if(best.hits < best.total*0.79)continue;

    const stripes=[];
    for(let n=0;n<tracks.length;n++){
      const track=tracks[n], map=strengths[n===0?0:1];
      const st=Math.max(track.start,start-2), en=Math.min(track.end,end+2);
      const points=[], colours=[];
      for(let u=st;u<=en;u++){
        const v=Math.round(slope*u+best.fraction)+track.intercept;
        if(v<4||v>=rows-4)break;
        const i=pixel(u,v);
        if(!opaque(i)||reservations[i])break;
        let oldV=v, strength=-1;
        const tolerance=n===2 ? 3 : 1;
        for(let d=-tolerance;d<=tolerance;d++){
          const sc=map[u*rows+v+d]-2*Math.abs(d);
          if(sc>strength){strength=sc;oldV=v+d;}
        }
        if(strength>0)colours.push(pixel(u,oldV));
        points.push({u,v,i,oldV});
      }
      if(points.length!==en-st+1 || colours.length<points.length*0.75) break;
      colours.sort((a,b)=>baseLab[a*3]-baseLab[b*3]||a-b);
      const colour=colours[colours.length>>1];
      stripes.push({points,colour,track});
    }
    if (stripes.length<2)continue;
    if (baseLab[stripes[0].colour*3]-baseLab[stripes[1].colour*3]<23)continue;

    // The two flanks of an existing stripe may belong to different surfaces.
    // Sample them beyond the old core and touch only its contiguous colour fringe.
    const lineCells=new Set(stripes.flatMap(stripe=>stripe.points.map(point=>point.i)));
    const repairs=new Map();
    for(const {points,colour} of stripes)for(const {u,v,oldV} of points){
      for(const side of [-1,1]){
        // The old core may lie on the other side of the newly drawn line.
        // In that case the correct fill reference is past the new line on this side.
        const edge=Math.max(side*v, side*oldV)*side;
        let far=-1;
        for(let offset=2;offset<=4;offset++){
          const a=edge+offset*side,b=a+side;
          if(a<0||a>=rows||b<0||b>=rows)break;
          const ia=pixel(u,a),ib=pixel(u,b);
          if(!opaque(ia)||!opaque(ib)||lineCells.has(ia)||lineCells.has(ib))break;
          if(distance(baseLab,ia,ib)<=9 && distance(baseLab,colour,ia)>=14){
            far=ia;break;
          }
        }
        if(far<0)continue;
        const a=colour*3,b=far*3;
        const dL=baseLab[b]-baseLab[a],dA=baseLab[b+1]-baseLab[a+1],dB=baseLab[b+2]-baseLab[a+2];
        const norm=dL*dL+dA*dA+dB*dB;
        const movement=(oldV-v)*side;
        for(let offset=1;offset<=Math.min(3,Math.max(2,movement+1));offset++){
          const i=pixel(u,v+side*offset);
          if(!opaque(i)||reservations[i]||lineCells.has(i))break;
          const p=i*3,l=baseLab[p]-baseLab[a],aa=baseLab[p+1]-baseLab[a+1],bb=baseLab[p+2]-baseLab[a+2];
          const mix=(l*dL+aa*dA+bb*dB)/norm;
          const residual=Math.hypot(l-mix*dL,aa-mix*dA,bb-mix*dB);
          if(offset===movement || (mix>=-0.2&&mix<=0.82&&residual<=7)){
            repairs.set(i,far);
          } else if(offset>=movement)break;
        }
      }
    }
    for(const [i,far] of repairs){
      result.set(data.subarray(far*4,far*4+3),i*4);
      reservations[i]=1;
    }
    for(const {points,colour} of stripes)for(const {i} of points){
      result.set(data.subarray(colour*4,colour*4+3),i*4);
      reservations[i]=1;
    }
    accepted.push({start,end,slope,tracks:stripes.map(s=>s.track)});
    groups.push({transposed,rise,run,direction,start,end,stripes});
  }

  const response={image:{data:result,width,height},objects:groups.length,drawn:groups.length,skipped:0};
  if(opts.contourDiagnostics)response.edgeGroups=groups;
  return response;
}



/** Mode 6 extends the paired-edge result with independent seams and silhouettes. */
export function sampleSceneGeneralEdges(img, xs, ys, opts = {}) {
  return sampleSceneEdges(img, xs, ys, opts, false);
}

/** Mode 7 follows coherent material boundaries over the mode 6 result. */
export function sampleSceneTracedEdges(img, xs, ys, opts = {}) {
  return sampleSceneEdges(img, xs, ys, opts, true);
}

/** Mode 8 finds independent source lines and reconstructs them between their anchors. */
export function sampleSceneAnchoredLines(img, xs, ys, opts = {}) {
  return sampleSceneEdges(img, xs, ys, opts, true, true);
}

function sampleSceneEdges(img, xs, ys, opts, trace, anchored=false) {
  const base = sampleSceneElement(img, xs, ys, opts).image;
  const source = sampleMedianL(img, xs, ys);
  const paired = regularizeRaisedEdges(base, source, {...opts, contourDiagnostics:true});
  const {width, height, data} = base;
  const output = paired.image.data;
  const occupied = new Uint8Array(width*height);
  for(let i=0;i<occupied.length;i++){
    const p=4*i;
    if(data[p]!==output[p] || data[p+1]!==output[p+1] || data[p+2]!==output[p+2])occupied[i]=1;
  }
  // Protect the original paired strokes even where their colour already matched.
  for(const group of paired.edgeGroups)for(const {points} of group.stripes){
    const stride=group.transposed ? 1 : width, extent=group.transposed ? width : height;
    for(const {i,v} of points){
      occupied[i]=1;
      if(v>0)occupied[i-stride]=1;
      if(v+1<extent)occupied[i+stride]=1;
    }
  }
  if(!opts.contourDiagnostics)delete paired.edgeGroups;
  return regularizeSceneSeams(base, source, paired, occupied, opts, trace, anchored);
}

/**
 * Protect the silhouette and adjoining detail of a compact, distinctly coloured
 * component. Group by chroma and hue rather than RGB so lighting on each face
 * does not split the object into unrelated regions. Broad faces remain eligible.
 */
function protectCompactSceneColours(image, lab) {
  const {width,height,data}=image, size=width*height;
  const protectedPixels=new Uint8Array(size);
  const visited=new Uint8Array(size), queue=new Int32Array(size);
  const chroma=new Float32Array(size);
  for(let i=0;i<size;i++)if(data[i*4+3]===255)chroma[i]=Math.hypot(lab[i*3+1],lab[i*3+2]);
  const maxExtent=Math.max(24,Math.floor(Math.min(width,height)*.28));
  const maxArea=Math.max(64,Math.floor(size*.022));
  for(let seed=0;seed<size;seed++){
    if(visited[seed]||chroma[seed]<29)continue;
    const a=lab[seed*3+1], b=lab[seed*3+2], c=chroma[seed];
    const minChroma=Math.max(29,c*.53);
    let head=0,tail=1,minX=width,minY=height,maxX=0,maxY=0,strong=0;
    visited[seed]=1;
    queue[0]=seed;
    const add=i=>{
      if(visited[i]||chroma[i]<minChroma)return;
      if(a*lab[i*3+1]+b*lab[i*3+2]<.906*c*chroma[i])return;
      visited[i]=1;
      queue[tail++]=i;
    };
    while(head<tail){
      const i=queue[head++],x=i%width,y=Math.floor(i/width);
      if(chroma[i]>=42)strong++;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);
      minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      if(x>0)add(i-1);
      if(x+1<width)add(i+1);
      if(y>0)add(i-width);
      if(y+1<height)add(i+width);
    }
    const w=maxX-minX+1,h=maxY-minY+1;
    if(tail<18||tail>maxArea||w>maxExtent||h>maxExtent||Math.min(w,h)<4
        ||tail<w*h*.28||strong<tail*.30)continue;
    // Include the original contour pixels just outside the sampled colour mass.
    for(let j=0;j<tail;j++){
      const i=queue[j],x=i%width,y=Math.floor(i/width);
      for(let dy=-3;dy<=3;dy++){
        const py=y+dy;
        if(py<0||py>=height)continue;
        const radius=3-Math.max(0,Math.abs(dy)-1);
        const left=py*width+Math.max(0,x-radius),right=py*width+Math.min(width-1,x+radius);
        protectedPixels.fill(1,left,right+1);
      }
    }
  }
  return protectedPixels;
}

/** Find single dark seams and silhouette steps that have no matching highlight. */
function regularizeSceneSeams(base, source, paired, occupied, opts, trace, anchored) {
  const {width,height,data} = base;
  const src = pxLab(source), lab = pxLab(base);
  const protectStraight = new Uint8Array(width*height);
  const compactColours = protectCompactSceneColours(base,lab);
  const axes = [];
  const distance = (values,a,b) => Math.hypot(
    values[a*3]-values[b*3],values[a*3+1]-values[b*3+1],values[a*3+2]-values[b*3+2]
  );
  const opaque = i => data[4*i+3] === 255 && source.data[4*i+3] === 255;
  const mixRatio = (i,a,b) => {
    const ax=lab[3*a], ay=lab[3*a+1], az=lab[3*a+2];
    const dx=lab[3*b]-ax, dy=lab[3*b+1]-ay, dz=lab[3*b+2]-az;
    const x=lab[3*i]-ax, y=lab[3*i+1]-ay, z=lab[3*i+2]-az;
    const t=(x*dx+y*dy+z*dz)/(dx*dx+dy*dy+dz*dz || 1);
    return Math.hypot(x-t*dx,y-t*dy,z-t*dz)<=4 ? t : -Infinity;
  };

  // Estimate the boundary from colour (a/b in Lab), independently of shadow
  // lightness. A dark ink pixel and the face it outlines can be the same material.
  const chroma=(values,i)=>Math.hypot(values[3*i+1],values[3*i+2]);
  const projection=(values,i,a,b)=>{
    const da=values[3*b+1]-values[3*a+1],db=values[3*b+2]-values[3*a+2];
    return ((values[3*i+1]-values[3*a+1])*da+(values[3*i+2]-values[3*a+2])*db)/(da*da+db*db || 1);
  };
  const materialProfile=(at,u,v,breadth)=>{
    if(v<4||v>=breadth-4)return null;
    const left=at(u,v-1),right=at(u,v);
    if(!opaque(left)||!opaque(right))return null;
    const colourStepA=lab[3*right+1]-lab[3*left+1],colourStepB=lab[3*right+2]-lab[3*left+2];
    if(colourStepA*colourStepA+colourStepB*colourStepB<5)return null;
    // Take the median chroma of three surface samples. Luminance may vary
    // significantly within one material, for example beside a rim highlight.
    const surface=side=>{
      const p=at(u,v+side*2),q=at(u,v+side*3),r=at(u,v+side*4);
      if(!opaque(p)||!opaque(q)||!opaque(r))return -1;
      const a=chroma(lab,p),b=chroma(lab,q),c=chroma(lab,r);
      if((a-b)*(a-c)<=0)return p;
      return (b-a)*(b-c)<=0?q:r;
    };
    const a=surface(-1),b=surface(1);
    if(a<0||b<0)return null;
    const da=lab[3*b+1]-lab[3*a+1], db=lab[3*b+2]-lab[3*a+2];
    const separation=Math.hypot(da,db);
    if(separation<15)return null;
    const bias=chroma(lab,b)-chroma(lab,a);
    if(Math.abs(bias)<10)return null;
    const sourceA=src[3*b+1]-src[3*a+1],sourceB=src[3*b+2]-src[3*a+2];
    if((da*sourceA+db*sourceB)/separation<9)return null;
    // A dark stroke can have less chroma than the face. Keep it on the
    // coloured side once the chromatic evidence crosses a soft threshold.
    const cutoff=bias>0?.36:.64;
    const leftT=projection(lab,left,a,b),rightT=projection(lab,right,a,b);
    if(leftT>=cutoff || rightT<cutoff || rightT-leftT<.15)return null;
    const srcLeft=projection(src,at(u,v-2),a,b),srcRight=projection(src,at(u,v+1),a,b);
    if(srcLeft>.78 || srcRight<.24 || srcRight-srcLeft<.28)return null;
    const score=Math.min(52,separation)*Math.min(1,.66+(rightT-leftT)*.55);
    return {a,b,da,db,separation,bias,score};
  };

  // Read horizontal and vertical profiles; the major axis of a diagonal depends on its slope.
  for(const swapped of [false,true]) {
    const length=swapped ? height : width;
    const breadth=swapped ? width : height;
    const at=(u,v)=>swapped ? u*width+v : v*width+u;
    const seams=new Float32Array(length*breadth), silhouettes=new Float32Array(length*breadth);
    const materials=new Float32Array(length*breadth);
    const lists=[[],[],[]];
    const straightSupport=new Uint8Array(length*breadth);
    for(let u=0;u<length;u++)for(let v=3;v<breadth-3;v++) {
      const i=at(u,v), l=at(u,v-1), r=at(u,v+1), a=at(u,v-2), b=at(u,v+2);
      const aa=at(u,v-3), bb=at(u,v+3), k=u*breadth+v;
      if(!opaque(i)||!opaque(a)||!opaque(b)||!opaque(l)||!opaque(r))continue;
      // For long straight boundaries use direct edge evidence, even where the
      // original thin-ridge detector cannot find a single dark centre.
      const da=lab[3*i]-lab[3*l], db=lab[3*i+1]-lab[3*l+1], dc=lab[3*i+2]-lab[3*l+2];
      const boundary=Math.hypot(da,db,dc);
      if(boundary>=7){
        for(const [p,q] of [[a,l],[l,i],[i,r]]) {
          const agreement=(da*(src[3*q]-src[3*p])+db*(src[3*q+1]-src[3*p+1])+dc*(src[3*q+2]-src[3*p+2]))/boundary;
          if(agreement>=Math.max(3,boundary*.20)){
            straightSupport[k]=1;break;
          }
        }
      }
      const material=materialProfile(at,u,v,breadth);
      if(material){
        materials[k]=material.score;
        lists[2].push(k);
      }
      const S=src[3*i], L=lab[3*i];
      const srcDark=Math.min(src[3*a],src[3*b])-S;
      const baseDark=Math.min(lab[3*a],lab[3*b])-L;
      const nearDarker=Math.min(src[3*l],src[3*r])<S-2 || Math.min(lab[3*l],lab[3*r])<L-2;
      if(!nearDarker && srcDark>=3 && baseDark>=3.5 && srcDark+baseDark>=8) {
        seams[k]=Math.min(30,(srcDark+baseDark)/2);
        lists[0].push(k);
      }
      if(!opaque(aa)||!opaque(bb))continue;
      const diff = distance(lab,a,b), originalDiff=distance(src,a,b);
      if(diff<14 || originalDiff<12)continue;
      const baseLeft=distance(lab,aa,a), baseRight=distance(lab,b,bb);
      const sourceLeft=distance(src,aa,a), sourceRight=distance(src,b,bb);
      // A smooth wall against a textured object is still a boundary. Require
      // one stable side and bound the variation on the other relative to the edge.
      if(Math.min(baseLeft,baseRight)>Math.min(8,diff*.23)
          || Math.max(baseLeft,baseRight)>diff*.60
          || Math.min(sourceLeft,sourceRight)>Math.min(10,originalDiff*.28)
          || Math.max(sourceLeft,sourceRight)>originalDiff*.76)continue;
      // The detected grid step is the first pixel past the colour midpoint.
      const previousSide = distance(lab,l,a)-distance(lab,l,b);
      const nextSide = distance(lab,i,a)-distance(lab,i,b);
      if(previousSide>=0 || nextSide<0 || nextSide-previousSide<diff*.38)continue;
      silhouettes[k]=Math.min(diff,48);
      lists[1].push(k);
    }
    const maps=[seams,silhouettes,materials];
    // Keep existing axis-aligned runs, including grid intersections and the corners they reach.
    for(let v=3;v<breadth-3;v++)for(const map of [seams,silhouettes]) {
      let begin=-1;
      for(let u=0;u<=length;u++) {
        if(u<length && map[u*breadth+v]>0){
          if(begin<0)begin=u;
          continue;
        }
        if(begin>=0 && u-begin>=8)for(let x=begin;x<u;x++){
          protectStraight[at(x,v)]=1;
          if(map===silhouettes)protectStraight[at(x,v-1)]=1;
        }
        begin=-1;
      }
    }
    // Join a few missing samples at rail crossings or shading boundaries.
    // The fallback locks persistent steps in the sampled image even if glare
    // or antialiasing weakens their pixel-by-pixel support in the source.
    const lockAxisRuns=(v,minimum,density,gap,supported)=>{
      let first=-1,last=-1,count=0;
      const preserve=()=>{
        if(first>=0 && last-first+1>=minimum && count>=density*(last-first+1)){
          for(let u=first;u<=last;u++){
            protectStraight[at(u,v-1)]=1;
            protectStraight[at(u,v)]=1;
          }
        }
        first=last=-1;count=0;
      };
      for(let u=0;u<length;u++){
        if(!supported(u))continue;
        if(first>=0 && u-last>gap)preserve();
        if(first<0)first=u;
        last=u;count++;
      }
      preserve();
    };
    for(let v=3;v<breadth-3;v++){
      lockAxisRuns(v,18,.72,6,u=>straightSupport[u*breadth+v]);
      for(const sign of [-1,1])lockAxisRuns(v,21,.82,4,u=>{
        const left=at(u,v-1),right=at(u,v);
        return opaque(left)&&opaque(right)&&sign*(lab[right*3]-lab[left*3])>=4.6;
      });
    }
    axes.push({swapped,length,breadth,at,maps,lists});
  }

  const gcd=(a,b)=>b ? gcd(b,a%b) : a;
  const ratios=[];
  for(let run=1;run<=9;run++)for(let rise=1;rise<=run;rise++){
    if(gcd(rise,run)===1)ratios.push([rise,run]);
  }
  const candidates=[];
  for(const axis of axes) {
    const {length,breadth,maps,lists}=axis;
    for(const [rise,run] of ratios)for(const sign of [-1,1]) {
      const slope=sign*rise/run;
      const offset=Int32Array.from({length},(_,u)=>Math.round(slope*u));
      for(const [type,cells] of lists.entries()) {
        const map=maps[type];
        const count=new Uint32Array(breadth+2*length);
        const low=new Int32Array(count.length).fill(length), high=new Int32Array(count.length).fill(-1);
        for(const k of cells){
          const u=Math.floor(k/breadth), v=k%breadth;
          const slot=v-offset[u]+length;
          count[slot]++;
          low[slot]=Math.min(low[slot],u);
          high[slot]=u;
        }
        for(let slot=1;slot<count.length-1;slot++){
          if(count[slot]<(type===2?4:5))continue;
          const intercept=slot-length, start=Math.min(low[slot-1],low[slot],low[slot+1]);
          const end=Math.max(high[slot-1],high[slot],high[slot+1]);
          let first=-1,last=-1,hits=0,strength=0,exact=0,sumU=0,sumV=0,sumUU=0,sumUV=0;
          const record=()=>{
            if(first<0)return;
            const span=last-first+1;
            const denominator=hits*sumUU-sumU*sumU;
            const observed=denominator ? (hits*sumUV-sumU*sumV)/denominator : 0;
            const minimum=type===2 ? 12 : type ? 15 : 16;
            // A real, repeated displacement is required. Near-horizontal jiggle does not qualify.
            if(span>=minimum && Math.abs(slope)*(span-1)>=(type===2 ? 3 : 4) && hits/span>=0.82 && exact/hits>=(type===2?.30:.40)
              && observed*slope>0 && Math.abs(observed-slope)*(span-1)<=(type===2 ? 3.0 : 1.35)
              && Math.abs(observed)>=Math.abs(slope)*.75){
              const score=(hits+exact*.45)*(1+Math.min(22,strength/hits)/25)/(1+.012*(run-1));
              candidates.push({axis,type,rise,run,sign,slope,intercept,first,last,score,contrast:strength/hits});
            }
            first=last=-1;
            hits=strength=exact=sumU=sumV=sumUU=sumUV=0;
          };
          for(let u=start;u<=end;u++){
            const v=offset[u]+intercept;
            if(v<3||v>=breadth-3)continue;
            const k=u*breadth+v;
            const center=map[k], before=map[k-1], after=map[k+1];
            const fartherBefore=type===2?map[k-2]:0,fartherAfter=type===2?map[k+2]:0;
            const evidence=Math.max(center,before*.72,after*.72,fartherBefore*.52,fartherAfter*.52);
            if(!evidence)continue;
            if(last>=0&&u-last>4)record();
            if(first<0)first=u;
            last=u; hits++; strength+=evidence;
            if(center)exact++;
            let measured=v, measuredScore=center;
            for(const d of [-2,-1,1,2]){
              const candidate=Math.abs(d)===2 ? (d<0?fartherBefore:fartherAfter)*.64 : map[k+d]*.8;
              if(candidate>measuredScore){measured=v+d;measuredScore=candidate;}
            }
            sumU+=u;sumV+=measured;sumUU+=u*u;sumUV+=u*measured;
          }
          record();
        }
      }
    }
  }

  // Prefer a true line core to a step belonging to the same edge; paired edges already own their pixels.
  const priority=c=>c.type===2 ? 0 : c.type===1 && c.contrast>=27 ? 1 : c.type ? 3 : 2;
  candidates.sort((a,b)=>priority(a)-priority(b)||b.score-a.score);
  const output=paired.image.data, lines=[];
  const traces=[], geometry=[];
  const owners=trace ? Int32Array.from(occupied, value=>value ? -1 : 0) : null;
  let owner=-1;
  const paint=(to,from)=>{
    output.set(data.subarray(from*4,from*4+3),to*4);
    occupied[to]=1;
    if(owners)owners[to]=owner;
  };
  const blocked=i=>occupied[i]||protectStraight[i]||compactColours[i]||!opaque(i);
  for(const candidate of candidates) {
    const {axis,type,slope,first,last,intercept,rise,run,sign}=candidate;
    const {breadth,at,maps}=axis, map=maps[type];
    let best=null;
    for(let phase=-run;phase<=run;phase++){
      let merit=0,hits=0;
      for(let u=first;u<=last;u++){
        const v=Math.round(slope*u+phase/run)+intercept;
        if(v<3||v>=breadth-3)continue;
        const k=u*breadth+v;
        const s=Math.max(map[k],.66*map[k-1],.66*map[k+1],type===2?.45*map[k-2]:0,type===2?.45*map[k+2]:0);
        merit+=s;if(s)hits++;
      }
      if(!best||merit>best.merit)best={phase,merit,hits};
    }
    if(best.hits<.83*(last-first+1))continue;
    const points=[], samples=[];
    for(let u=first;u<=last;u++) {
      const v=Math.round(slope*u+best.phase/run)+intercept;
      if(v<3||v>=breadth-3)continue;
      const k=u*breadth+v;
      let old=v, strength=map[k];
      for(const delta of type===2?[-2,-1,1,2]:[-1,1]){
        const evidence=map[k+delta]*(Math.abs(delta)===2?.58:.8);
        if(evidence>strength){old=v+delta;strength=evidence;}
      }
      if(!strength)continue;
      if(old<2||old>=breadth-2)continue;
      const i=at(u,v), before=at(u,old-2), after=at(u,old+2);
      if(compactColours[at(u,old)]||compactColours[i])continue;
      if(occupied[at(u,old)]||occupied[at(u,v-1)]||occupied[at(u,v+1)])continue;
      if(!opaque(before)||!opaque(after))continue;
      if(type===2){
        if(occupied[i]||occupied[at(u,old-1)])continue;
      }else if(type){
        // Reject a one-sided fit if either side already belongs to a traced stripe.
        if(blocked(i)||occupied[at(u,old-1)])continue;
        if(distance(lab,before,after)<14)continue;
      }else{
        if(!blocked(i))samples.push(at(u,old));
      }
      points.push({u,v,old,i,before,after});
    }
    if(points.length<.74*(last-first+1) || (!type && samples.length<Math.max(8,.50*(last-first+1))))continue;
    if(type===2){
      // Confirm a consistent pair of colours along the entire segment.
      const profiles=points.map(p=>({...p,edge:materialProfile(at,p.u,p.old,breadth)})).filter(p=>p.edge);
      if(profiles.length<.74*(last-first+1))continue;
      const da=profiles.reduce((sum,p)=>sum+p.edge.da/p.edge.separation,0);
      const db=profiles.reduce((sum,p)=>sum+p.edge.db/p.edge.separation,0);
      if(Math.hypot(da,db)<profiles.length*.92)continue;
      const side=profiles.reduce((sum,p)=>sum+Math.sign(p.edge.bias),0)>0?1:-1;
      if(profiles.filter(p=>Math.sign(p.edge.bias)===side).length<profiles.length*.94)continue;

      const stripe=[], pigment=[], measuredPigment=new Map();
      for(const p of profiles){
        const {u,old,edge}=p, face=side>0?edge.b:edge.a, local=old+(side<0?-1:0);
        let chosen=-1, core=-1;
        for(let d=0;d<=1;d++){
          const i=at(u,local+side*d),t=projection(lab,i,edge.a,edge.b);
          const membership=side>0?t:1-t;
          if(membership>=.67 && core<0)core=i;
          if(membership<.37)continue;
          const light=lab[3*face]-lab[3*i],sourceLight=src[3*face]-src[3*i];
          if(light>=5&&sourceLight>=4&&(chosen<0||lab[3*i]<lab[3*chosen]))chosen=i;
        }
        if(chosen>=0)stripe.push(chosen);
        if(core>=0){
          pigment.push(core);
          measuredPigment.set(u,core);
        }
      }
      stripe.sort((a,b)=>lab[3*a]-lab[3*b]||a-b);
      const lineColour=stripe.length>=profiles.length*.52 ? stripe[stripe.length>>1] : null;
      pigment.sort((a,b)=>lab[3*a]-lab[3*b]||a-b);
      const medianPigment=pigment[pigment.length>>1];
      const coherentPigment=pigment.filter(i=>distance(lab,medianPigment,i)<=14).length>=profiles.length*.67
          ? medianPigment : null;
      const edits=new Map(), footprint=new Set();
      for(const {u,v,old,edge} of profiles){
        if(Math.abs(v-old)>1 || v<4 || v>=breadth-4)continue;
        if(Math.sign(edge.bias)!==side)continue;
        const stroke=side<0?v-1:v;
        const colouredFace=side<0?edge.a:edge.b;
        const shade=lineColour!==null && distance(lab,lineColour,colouredFace)<36 ? lineColour : null;
        let edgePigment=coherentPigment;
        if(edgePigment===null && shade===null && measuredPigment.has(u)){
          // Remove along-edge colour spikes by choosing a nearby measured
          // median only within this material. Gradual shade changes remain.
          const neighbours=[];
          for(let x=u-2;x<=u+2;x++){
            const c=measuredPigment.get(x);
            if(c!==undefined && distance(lab,c,colouredFace)<=24)neighbours.push(c);
          }
          neighbours.sort((a,b)=>lab[3*a]-lab[3*b]||a-b);
          const centre=measuredPigment.get(u);
          if(neighbours.length>=3 && distance(lab,centre,neighbours[neighbours.length>>1])<=17){
            edgePigment=neighbours[neighbours.length>>1];
          }
        }
        if(edgePigment!==null && distance(lab,edgePigment,colouredFace)>24)edgePigment=null;
        const needed=[at(u,v-1),at(u,v)];
        if(needed.some(blocked))continue;
        for(let d=-2;d<=1;d++){
          const y=v+d, i=at(u,y);
          if(blocked(i))continue;
          const face=d<0?edge.a:edge.b;
          const t=projection(lab,i,edge.a,edge.b);
          const moved=(y<old)!==(y<v);
          const isCore=y===v-1||y===v;
          const onColour=face===colouredFace;
          // The two pixels across the interface must belong to their own face.
          // Only a source-supported raised edge may contribute a dark ink pixel.
          if(y===stroke && (shade!==null || edgePigment!==null))edits.set(i,shade??edgePigment);
          else if(moved || (isCore && (!onColour || shade!==null || t>.10&&t<.89))){
            edits.set(i,face);
          } else if(shade!==null && onColour && Math.abs(y-stroke)===1
              && (distance(lab,i,shade)<16 || (t>.10&&t<.89))){
            edits.set(i,face);
          } else if(!onColour && t>.12&&t<.87){
            edits.set(i,face);
          }
          if(isCore)footprint.add(i);
        }
      }
      if(footprint.size<Math.max(14,profiles.length*.93))continue;
      let changeCount=0;
      for(const [i,j] of edits)if(distance(lab,i,j)>.1)changeCount++;
      if(changeCount<4)continue;
      owner=lines.length+1;
      for(const [i,j] of edits)paint(i,j);
      for(const i of footprint){
        occupied[i]=1;
        if(owners)owners[i]=owner;
      }
      if(trace){
        traces.push({axis,slope,phase:best.phase/run+intercept,profiles,side,lineColour,owner});
        if(lineColour!==null)geometry.push({axis,slope,phase:best.phase/run+intercept,first,last,ink:lineColour,owner});
      }
      owner=-1;
      lines.push({type:'material',transposed:axis.swapped,rise,run,sign,first,last,changed:changeCount,
        from:[first,Math.round(slope*first+best.phase/run)+intercept],
        to:[last,Math.round(slope*last+best.phase/run)+intercept],ink:lineColour!==null});
      continue;
    }
    samples.sort((a,b)=>lab[3*a]-lab[3*b]||a-b);
    const ink=samples[samples.length>>1];
    let changed=0;
    const planned=[];
    const validPaint=(i,j)=>!blocked(i)&&opaque(j);
    for(const {u,v,old,i,before,after} of points) {
      if(type){
        // Use the measured face colours on each side, without inventing a contour colour.
        for(let d=-2;d<=1;d++){
          const p=at(u,v+d), face=d<0?before:after;
          if(!validPaint(p,face))continue;
          const t=mixRatio(p,before,after);
          const moved=d<0 ? v+d>=old : v+d<old;
          const hardEdgeCore=candidate.contrast>=27 && (d===-1||d===0);
          if(hardEdgeCore || (t>0.10&&t<.90) || moved)planned.push([p,face]);
        }
      }else{
        if(!validPaint(i,ink))continue;
        if(distance(lab,ink,at(u,old))>14)continue;
        let canDraw=true;
        const fringe=[];
        for(const side of [-1,1]){
          const endpoint=side<0 ? before : after;
          for(let d=1;d<=2;d++){
            const p=at(u,v+side*d);
            if(!validPaint(p,endpoint))break;
            const t=mixRatio(p,at(u,old),endpoint);
            if(v+side*d===old || (t>=-.12&&t<.83 && Math.abs(lab[3*p]-lab[3*endpoint])>2)){
              fringe.push([p,endpoint]);
            }else break;
          }
        }
        if(v!==old && !fringe.some(([p])=>p===at(u,old)))canDraw=false;
        if(canDraw)planned.push(...fringe,[i,ink]);
      }
    }
    for(const [i,j] of planned){
      if(data[i*4]!==data[j*4]||data[i*4+1]!==data[j*4+1]||data[i*4+2]!==data[j*4+2])changed++;
    }
    if(changed<3)continue;
    owner=lines.length+1;
    for(const [i,j] of planned)paint(i,j);
    if(trace&&!type)geometry.push({axis,slope,phase:best.phase/run+intercept,first,last,ink,owner});
    owner=-1;
    lines.push({type:type?'silhouette':'seam',transposed:axis.swapped,rise,run,sign,first,last,changed,
      from:[first,Math.round(slope*first+best.phase/run)+intercept],
      to:[last,Math.round(slope*last+best.phase/run)+intercept]});
  }

  if(trace){
    const canEdit=(i,track)=>opaque(i)&&!protectStraight[i]&&!compactColours[i]
      && (owners[i]===0||owners[i]===track.owner);
    const followed=followSceneMaterialTracks(paired.image, data, lab, src, traces, canEdit, opaque, owners);
    if(opts.contourDiagnostics)paired.tracedSegments=followed;
    const drawn=rebuildSceneStraightOutlines(paired.image, data, lab, src, geometry, owners, compactColours, opaque);
    if(opts.contourDiagnostics)paired.straightOutlines=drawn;
    if(anchored){
      const anchors=regularizeAnchoredSceneLines(paired.image, source, src, compactColours, drawn, {...opts,contourDiagnostics:true});
      const leaks=restoreCompactSceneFaces(paired.image, source, src, compactColours);
      const toneEdits=reconcileSceneSoftTones(paired.image, base, src, compactColours, opaque, [...drawn,...anchors]);
      if(opts.contourDiagnostics){paired.anchoredLines=anchors;paired.compactFaceEdits=leaks;paired.softToneEdits=toneEdits;}
    }
  }
  paired.objects+=lines.length;
  paired.drawn+=lines.length;
  if(opts.contourDiagnostics)paired.seamSegments=lines;
  return paired;
}

/** Choose a connected edge within the one-cell band of a confirmed fit. */
function followSceneMaterialTracks(image, baseData, base, source, tracks, canEdit, opaque, owners) {
  const output=image.data, current=pxLab(image), followed=[];
  for(const track of tracks){
    const {axis:{at,breadth,swapped},slope,phase,profiles,side,lineColour,owner}=track;
    const direction=Math.sign(slope);
    const first=profiles[0].u,last=profiles.at(-1).u;
    const reference=new Map(profiles.map(({u,edge})=>[u,edge]));
    let section=[];
    const finish=()=>{
      const columns=section;
      section=[];
      if(columns.length<7)return;
      // Lock the ends against the untouched contour and the next surface.
      for(let n=0;n<columns.length;n++){
        const {choices,old}=columns[n], end=n===0||n===columns.length-1;
        for(const choice of choices){
          choice.total=Infinity;
          if(end&&choice.v!==old)continue;
          if(n===0){choice.total=choice.cost;continue;}
          for(const prev of columns[n-1].choices){
            const step=(choice.v-prev.v)*direction;
            const broken=step<0||step>1;
            // A protected pixel may force the original break to remain. It
            // cannot be used to introduce or move a break to another column.
            if(broken&&(choice.v!==old||prev.v!==columns[n-1].old))continue;
            const expected=columns[n].ideal-columns[n-1].ideal;
            const total=prev.total+choice.cost+.16*Math.abs(choice.v-prev.v-expected)+(broken?5:0);
            if(total<choice.total){choice.total=total;choice.prev=prev;}
          }
        }
      }
      let best=columns.at(-1).choices.find(choice=>Number.isFinite(choice.total));
      if(!best)return;
      const path=[];
      for(let n=columns.length-1;n>=0;n--){path.push(best);best=best.prev;}
      path.reverse();
      const changed=path.reduce((sum,p)=>sum+p.edits.length,0);
      if(!changed)return;
      for(const {edits} of path)for(const [i,j,ink] of edits){
        const pixels=ink?baseData:output, colours=ink?base:current;
        output.set(pixels.subarray(4*j,4*j+3),4*i);
        current.set(colours.subarray(3*j,3*j+3),3*i);
        owners[i]=owner;
      }
      followed.push({transposed:swapped,slope,first:columns[0].u,last:columns.at(-1).u,changed,
        shifted:path.filter((p,n)=>p.v!==columns[n].old).length});
    };

    for(let u=first;u<=last;u++){
      const ideal=Math.round(slope*u+phase);
      if(ideal<5||ideal>=breadth-5){finish();continue;}
      // Borrow reference colours across a short missing observation only when
      // there is matching material on both sides of it along the track.
      let edge=reference.get(u);
      if(!edge){
        const prev=reference.get(u-1)??reference.get(u-2);
        const next=reference.get(u+1)??reference.get(u+2);
        if(prev&&next&&prev.da*next.da+prev.db*next.db>=.95*prev.separation*next.separation)edge=prev;
      }
      if(!edge||Math.sign(edge.bias)!==side){finish();continue;}
      const {a,b,da,db,separation}=edge;
      const project=(lab,i)=>((lab[3*i+1]-base[3*a+1])*da+(lab[3*i+2]-base[3*a+2])*db)/(separation*separation);
      const band=Array.from({length:9},(_,n)=>at(u,ideal+n-4));
      if(band.some(i=>!opaque(i))){finish();continue;}
      const levels=band.map(i=>project(current,i)), observed=band.map(i=>project(source,i));
      const cutoff=side<0?.64:.36;
      // A second crossing signals another surface, a corner, or an occlusion.
      // Keep the source profile as evidence even if quantization blurred its core.
      const crossing=levels.flatMap((t,n)=>n&&levels[n-1]<cutoff&&t>=cutoff?[n]:[]);
      if(crossing.length!==1||levels[0]>=cutoff||levels[8]<cutoff
          ||observed[1]>.52||observed[7]<.48||observed[7]-observed[1]<.45){finish();continue;}
      const measured=crossing[0],old=ideal+measured-4;
      const left=band[0],right=band[8],face=side<0?left:right;
      const ink=side<0?measured-1:measured;
      const inkColour=lineColour===null?Infinity:Math.hypot(
        base[3*lineColour]-current[3*face],base[3*lineColour+1]-current[3*face+1],base[3*lineColour+2]-current[3*face+2]);
      const matchesInk=i=>lineColour!==null&&Math.hypot(
        base[3*lineColour]-current[3*i],base[3*lineColour+1]-current[3*i+1],base[3*lineColour+2]-current[3*i+2])<=6;
      const choices=[];
      for(const v of new Set([old,ideal-1,ideal,ideal+1])){
        if(Math.abs(v-old)>1)continue;
        const boundary=v-ideal+4,stroke=side<0?boundary-1:boundary;
        const edits=[];
        const membership=t=>side<0?1-t:t;
        const hasInk=inkColour<36&&[stroke,ink].some(n=>membership(observed[n])>=.32
          && source[3*face]-source[3*band[n]]>=7);
        const canInk=hasInk&&canEdit(band[stroke],track)&&membership(project(base,lineColour))>=.36;
        const moves=v!==old;
        const changedSide=band[Math.min(boundary,measured)];
        if(moves){
          // Only a transitional source pixel can change which object owns it.
          const evidence=observed[Math.min(boundary,measured)];
          if(evidence<.07||evidence>.93||!canEdit(changedSide,track))continue;
          if(matchesInk(band[ink])&&!canInk)continue;
          if(changedSide!==band[stroke]||!canInk)edits.push([changedSide,v>old?left:right]);
        }
        if(canInk&&!matchesInk(band[stroke]))edits.push([band[stroke],lineColour,true]);
        if(moves&&matchesInk(band[ink])&&changedSide!==band[ink]){
          if(!canInk||!canEdit(band[ink],track))continue;
          edits.push([band[ink],face]);
        }
        // Score evidence across the interface, giving source geometry more
        // weight than the colour quantizer's position.
        let cost=.5*Math.abs(v-ideal)+.12*edits.length;
        for(let n=2;n<=6;n++){
          const expected=n<boundary?0:1;
          cost+=Math.abs(expected-observed[n])+.18*Math.abs(expected-levels[n]);
        }
        choices.push({v,edits,cost});
      }
      if(!choices.length){finish();continue;}
      section.push({u,ideal,old,choices});
    }
    finish();
  }
  return followed;
}

/** Fit and redraw an already detected dark outline as one rasterized line. */
function rebuildSceneStraightOutlines(image, baseData, baseLab, source, candidates, owners, compact, opaque) {
  const {data,width,height}=image;
  const current=pxLab(image), result=[];
  const distance=(a,i,b,j)=>Math.hypot(a[3*i]-b[3*j],a[3*i+1]-b[3*j+1],a[3*i+2]-b[3*j+2]);
  const fit=points=>{
    const n=points.length;
    let x=0,y=0,xx=0,xy=0;
    for(const [u,v] of points){x+=u;y+=v;xx+=u*u;xy+=u*v;}
    const slope=(xy-x*y/n)/(xx-x*x/n);
    return {slope,offset:(y-slope*x)/n};
  };
  // Identify a long independent arm of a junction in the sampled image. The
  // diagonal itself can occupy two cells of a row, but not five past the join.
  const hasArm=(i,sx,sy)=>{
    const x=i%width,y=Math.floor(i/width);
    let reference=-1, contrast=0;
    for(let d=1;d<=6;d++){
      const a=x+sx*d,b=y+sy*d;
      if(a<1||a>=width-1||b<1||b>=height-1)return false;
      const j=b*width+a, normal=sx?width:1;
      if(!opaque(j)||distance(current,i,current,j)>12)return false;
      if(reference<0)reference=j;
      if(distance(current,reference,current,j)>9)return false;
      if(Math.max(distance(source,j,source,j-normal),distance(source,j,source,j+normal))>=7)contrast++;
    }
    return contrast>=4;
  };
  for(const track of candidates){
    const {axis:{at,length,breadth,swapped},first,last,ink,owner}=track;
    if(last-first<22||Math.abs(track.slope)<.18||!opaque(ink))continue;
    let a=0,b=0,supported=0;
    const columns=[];
    for(let u=first;u<=last;u++){
      const v=Math.round(track.slope*u+track.phase);
      if(v<2||v>=breadth-3)continue;
      const left=at(u,Math.max(0,v-4)),right=at(u,Math.min(breadth-1,v+4));
      if(!opaque(left)||!opaque(right))continue;
      const da=source[3*right+1]-source[3*left+1],db=source[3*right+2]-source[3*left+2];
      const magnitude=Math.hypot(da,db);
      columns.push({u,v,da,db,magnitude});
      if(magnitude<7)continue;
      a+=da/magnitude;b+=db/magnitude;supported++;
    }
    const extent=last-first+1,norm=Math.hypot(a,b);
    if(supported<.72*extent||norm<.91*supported)continue;
    a/=norm;b/=norm;
    const chroma=i=>a*source[3*i+1]+b*source[3*i+2];
    const samples=[];
    for(const {u,v,da,db,magnitude} of columns){
      if(da*a+db*b<Math.max(7,.65*magnitude))continue;
      let strength=0,weighted=0;
      for(let p=Math.max(0,v-2);p<=Math.min(breadth-2,v+2);p++){
        const i=at(u,p),j=at(u,p+1);
        if(!opaque(i)||!opaque(j))continue;
        const weight=Math.max(0,chroma(j)-chroma(i));
        strength+=weight;weighted+=p*weight;
      }
      if(strength>=7)samples.push([u,weighted/strength]);
    }
    if(samples.length<.80*extent)continue;
    const coarse=fit(samples);
    const inliers=samples.filter(([u,v])=>Math.abs(v-coarse.slope*u-coarse.offset)<=1.15);
    if(inliers.length<.80*extent || inliers.length<.90*(inliers.at(-1)[0]-inliers[0][0]+1))continue;
    const line=fit(inliers);
    if(!Number.isFinite(line.slope)||Math.abs(line.slope)>1||Math.abs(line.slope-track.slope)>.14)continue;
    const residual=inliers.map(([u,v])=>Math.abs(v-line.slope*u-line.offset)).sort((x,y)=>x-y);
    const p95=residual[Math.floor(residual.length*.95)];
    if(p95>.92)continue;
    let start=inliers[0][0],end=inliers.at(-1)[0];
    let previous=start;
    if(inliers.some(([u])=>{const gap=u-previous;previous=u;return gap>4;}))continue;

    // The seed detector needs space on both sides of an edge. Recover the
    // short, source-supported continuation up to a clipped image boundary.
    const clipped=[];
    const extend=(origin,delta)=>{
      const originV=line.slope*origin+line.offset;
      if(originV>5&&originV<breadth-6)return origin;
      let accepted=origin;
      for(let n=1;n<=6;n++){
        const u=origin+delta*n;
        if(u<0||u>=length)break;
        const v=Math.round(line.slope*u+line.offset);
        if(v<0||v>=breadth)break;
        const i=at(u,Math.max(0,v-2)),j=at(u,Math.min(breadth-1,v+2));
        if(!opaque(i)||!opaque(j)||chroma(j)-chroma(i)<6)break;
        accepted=u;clipped.push(u);
      }
      return accepted;
    };
    start=extend(start,-1);
    end=extend(end,1);

    // Choose the sampling phase jointly for the whole stroke. Its location
    // must agree with both the existing ink cores and the source transition.
    let best=null;
    for(let step=-8;step<=8;step++){
      const offset=line.offset+step/8;
      let merit=.55*Math.abs(step/8)*(end-start+1);
      for(let u=start;u<=end;u++){
        const v=Math.round(line.slope*u+offset);
        if(v<0||v>=breadth){merit=Infinity;break;}
        const i=at(u,v);
        if(!opaque(i)||compact[i]||owners[i]===-1){merit=Infinity;break;}
        const old=Math.round(track.slope*u+track.phase);
        if(Math.abs(old-v)>2){merit=Infinity;break;}
        const colour=distance(baseLab,ink,current,i);
        if(owners[i]!==0&&owners[i]!==owner&&colour>15){merit=Infinity;break;}
        merit+=Math.min(35,colour)/13;
      }
      if(Number.isFinite(merit)&&(!best||merit<best.merit))best={offset,merit};
    }
    if(!best)continue;
    const direction=[[1,0],[-1,0],[0,1],[0,-1]];
    const arms=i=>direction.filter(([dx,dy])=>hasArm(i,dx,dy));
    const joins=[], barriers=[];
    for(let u=start;u<=end;u++){
      const v=Math.round(line.slope*u+best.offset),i=at(u,v);
      if(distance(baseLab,ink,current,i)<=1)continue;
      const connections=arms(i);
      if(!connections.length)continue;
      const [[dx,dy]]=connections;
      const beside=i-dx-dy*width;
      if(connections.length===1&&beside>=0&&beside<width*height&&distance(current,i,current,beside)>12){
        joins.push(u);
      }else{
        barriers.push(u);
      }
    }
    const edgeMargin=Math.floor((end-start+1)*.14);
    if(barriers.some(u=>u>start+edgeMargin&&u<end-edgeMargin))continue;
    const beginning=start+edgeMargin;
    for(const u of barriers){
      if(u<=beginning)start=Math.max(start,u+1);
      else end=Math.min(end,u-1);
    }
    if(end-start<18)continue;

    const plan=new Map(), centers=[];
    for(let u=start;u<=end;u++){
      const v=Math.round(line.slope*u+best.offset);
      const i=at(u,v), inkDistance=distance(baseLab,ink,current,i);
      centers.push(i);
      if(inkDistance>.1)plan.set(i,{from:ink,stroke:true});
      for(const side of [-1,1]){
        let surface=-1;
        for(let d=3;d<=5;d++){
          const p=v+side*d;
          if(p<0||p>=breadth)break;
          const j=at(u,p);
          if(opaque(j)&&distance(baseLab,ink,current,j)>13){surface=j;break;}
        }
        if(surface<0)continue;
        const outer=v-side*3;
        const far=outer>=0&&outer<breadth?at(u,outer):-1;
        for(let step=1;step<=2;step++){
          const p=v+side*step;
          if(p<0||p>=breadth)break;
          const j=at(u,p), fromInk=distance(baseLab,ink,current,j);
          const wrongSide=far>=0&&distance(current,j,current,surface)>13&&distance(current,j,current,far)+8<distance(current,j,current,surface);
          if(fromInk>18&&!wrongSide)continue;
          if(compact[j]||!opaque(j)||owners[j]!==0&&owners[j]!==owner
              ||direction.some(([dx,dy])=>hasArm(j,dx,dy)))continue;
          plan.set(j,{from:surface,stroke:false});
        }
      }
    }
    if(plan.size<4)continue;
    // Only commit a one-cell stroke. If a second, same-coloured feature could
    // not be explained and removed safely, preserve the entire previous run.
    const duplicate=centers.map((_,n)=>start+n).filter(u=>{
      const v=Math.round(line.slope*u+best.offset);
      return [-2,-1,1,2].some(d=>{
        if(v+d<0||v+d>=breadth)return false;
        const i=at(u,v+d),copy=plan.get(i);
        return distance(baseLab,ink,current,copy?copy.from:i)<.15;
      });
    });
    if(duplicate.some(u=>u>start+3&&u<end-3))continue;
    const centerStart=start;
    for(const u of duplicate){
      if(u<=centerStart+3)start=Math.max(start,u+1);
      else end=Math.min(end,u-1);
    }
    if(end-start<18)continue;
    const stroke=centers.slice(start-centerStart,end-centerStart+1);
    const snapshot=new Map();
    for(const [i,{from,stroke}] of plan){
      const u=swapped?Math.floor(i/width):i%width;
      if(u<start||u>end)continue;
      const pixels=stroke?baseData:data, lab=stroke?baseLab:current;
      snapshot.set(i,[pixels.slice(4*from,4*from+3),lab.slice(3*from,3*from+3)]);
    }
    if(snapshot.size<4)continue;
    for(const [i,[rgb,lab]] of snapshot){data.set(rgb,4*i);current.set(lab,3*i);owners[i]=owner;}
    result.push({transposed:swapped,first:start,last:end,slope:line.slope,offset:best.offset,p95,
      support:inliers.filter(([u])=>u>=start&&u<=end).length+clipped.filter(u=>u>=start&&u<=end).length,
      changed:snapshot.size,
      junctions:joins.filter(u=>u>=start&&u<=end).length,centers:stroke});
  }
  return result;
}

/** Accumulate finite source strokes, then constrain every redraw to its two observed ends. */
function regularizeAnchoredSceneLines(image, source, lab, compact, finished, opts) {
  const {width,height,data}=image, input=source.data;
  const current=pxLab(image), reserved=new Uint8Array(width*height), lines=[];
  const opaque=i=>data[4*i+3]===255&&input[4*i+3]===255;
  const distance=(space,i,j)=>Math.hypot(space[3*i]-space[3*j],space[3*i+1]-space[3*j+1],space[3*i+2]-space[3*j+2]);
  const proposals=[];
  const slopes=new Set([0,1,-1]);
  for(let run=2;run<=8;run++)for(let rise=1;rise<run;rise++){
    slopes.add(rise/run);slopes.add(-rise/run);
  }
  for(let n=1;n<40;n++){slopes.add(n/40);slopes.add(-n/40);}

  for(const line of finished){
    const step=line.transposed?1:width,extent=line.transposed?width:height;
    for(const i of line.centers){
      const v=line.transposed?i%width:Math.floor(i/width);
      reserved[i]=1;
      if(v>0)reserved[i-step]=1;
      if(v<extent-1)reserved[i+step]=1;
    }
  }

  for(const swapped of [false,true]){
    const length=swapped?height:width,breadth=swapped?width:height;
    const at=(u,v)=>swapped?u*width+v:v*width+u;
    const axis={swapped,length,breadth,at};
    for(const sign of [-1,1,0]){
      // A stroke must be locally darker or brighter than BOTH of its faces.
      // A single intensity step or the shoulder of a highlight is insufficient.
      const response=new Float32Array(length*breadth), seeds=[];
      for(let u=0;u<length;u++)for(let v=3;v<breadth-3;v++){
        const i=at(u,v),l=at(u,v-1),r=at(u,v+1),a=at(u,v-2),b=at(u,v+2);
        if(!opaque(i)||!opaque(a)||!opaque(b)||!opaque(l)||!opaque(r))continue;
        const k=u*breadth+v;
        if(!sign){
          const contrast=distance(lab,a,b);
          if(contrast<14||Math.min(distance(lab,a,l),distance(lab,b,r))>contrast*.31)continue;
          const before=distance(lab,l,a)-distance(lab,l,b),after=distance(lab,i,a)-distance(lab,i,b);
          if(before>=0||after<0||after-before<contrast*.48)continue;
          response[k]=Math.min(35,contrast*.75);
          seeds.push(k);
          continue;
        }
        const center=lab[3*i]*sign;
        const dl=center-lab[3*a]*sign,dr=center-lab[3*b]*sign;
        if(dl<4.5||dr<4.5||dl+dr<14)continue;
        const leftCore=center-lab[3*l]*sign,rightCore=center-lab[3*r]*sign;
        if(leftCore< -1.5||rightCore< -1.5||Math.max(leftCore,rightCore)<2.7)continue;
        response[k]=Math.min(36,(Math.min(dl,dr)*.7+(dl+dr)*.18+Math.min(12,Math.max(leftCore,rightCore))*.22));
        seeds.push(k);
      }
      if(!seeds.length)continue;
      for(const slope of slopes){
        if(swapped&&Math.abs(slope)===1)continue;
        const shifts=Int32Array.from({length},(_,u)=>Math.round(slope*u));
        const votes=new Uint32Array(breadth+length*2), lo=new Int32Array(votes.length).fill(length), hi=new Int32Array(votes.length).fill(-1);
        for(const k of seeds){
          const u=Math.floor(k/breadth),v=k%breadth,key=v-shifts[u]+length;
          votes[key]++;lo[key]=Math.min(lo[key],u);hi[key]=Math.max(hi[key],u);
        }
        for(let key=1;key<votes.length-1;key++){
          if(votes[key]<6)continue;
          const begin=Math.min(lo[key-1],lo[key],lo[key+1]),end=Math.max(hi[key-1],hi[key],hi[key+1]);
          const intercept=key-length;
          let points=[],exact=0,total=0;
          const record=()=>{
            if(points.length){
              const first=points[0][0],last=points.at(-1)[0],span=last-first+1;
              const minimum=slope===0?27:sign?37:34;
              if(span>=minimum && points.length>=.86*span && exact>=.45*points.length && total>=7*points.length){
                const score=points.length+exact*.65+total*.017;
                proposals.push({axis,sign,slope,first,last,points,score});
              }
            }
            points=[];exact=total=0;
          };
          for(let u=begin;u<=end;u++){
            const v=shifts[u]+intercept;
            if(v<3||v>=breadth-3)continue;
            const k=u*breadth+v;
            let pick=v,value=response[k];
            for(const d of [-1,1])if(response[k+d]*.74>value){pick=v+d;value=response[k+d]*.74;}
            if(!value)continue;
            if(points.length&&u-points.at(-1)[0]>3)record();
            points.push([u,pick]);
            if(pick===v)exact++;
            total+=value;
          }
          record();
        }
      }
    }
  }

  // Draw a supported ridge before the wider material step beside it. This
  // prevents the neighbouring face from claiming the actual stroke first.
  proposals.sort((a,b)=>Number(a.sign===0)-Number(b.sign===0)||b.score-a.score||Math.abs(a.slope)-Math.abs(b.slope));
  const previous=[];
  for(const p of proposals){
    const {axis:{at,breadth,swapped},first,last,points,sign}=p;
    if(previous.some(q=>q.axis===p.axis&&q.sign===sign&&Math.abs(q.slope-p.slope)<.06&&
      Math.abs(q.points[0][1]+q.slope*(first-q.first)-points[0][1])<=1&&
      Math.min(last,q.last)-Math.max(first,q.first)>=.68*(last-first)))continue;
    previous.push(p);
    const guess=fitSceneStrokeAnchors(points);
    if(!guess)continue;
    const from=first+1,to=last-1;
    const get=u=>guess.a+(u-first)*(guess.b-guess.a)/(last-first);

    // Only change runs bounded by observed source samples. Foreign lines,
    // small chromatic objects and transparency divide the available path.
    const matched=new Map(points.map(([u,v])=>[u,v]));
    let segment=[];
    const finish=()=>{
      const minimum=sign!==0?(p.slope===0?25:32):29;
      if(segment.length>=minimum)paintAnchoredSceneRun(segment,p,current,lab,data,reserved,compact,opaque,lines,opts);
      segment=[];
    };
    for(let u=from;u<=to;u++){
      const v=Math.round(get(u));
      if(v<3||v>=breadth-3){finish();continue;}
      const i=at(u,v), a=at(u,v-2),b=at(u,v+2);
      if(reserved[i]||compact[i]||!opaque(i)||!opaque(a)||!opaque(b)){finish();continue;}
      const measured=matched.get(u);
      if(measured!==undefined&&Math.abs(v-measured)>1){finish();continue;}
      const faceStep=distance(lab,a,b);
      // A change in the flanking material is a possible intersection. Split
      // at a sudden jump on either face rather than bridging the two strokes.
      const prev=segment.at(-1);
      if(prev&&(distance(lab,a,prev.a)>Math.min(15,Math.max(9,faceStep*.45))
          ||distance(lab,b,prev.b)>Math.min(15,Math.max(9,faceStep*.45))))finish();
      if(measured===undefined&&(!prev||prev.measured===undefined)){finish();continue;}
      segment.push({u,v,i,a,b,measured});
    }
    finish();
  }
  return lines;
}

function fitSceneStrokeAnchors(points) {
  const [first,firstV]=points[0], [last,lastV]=points.at(-1);
  let best=null;
  for(let aa=-4;aa<=4;aa++)for(let bb=-4;bb<=4;bb++){
    const a=firstV+aa/4,b=lastV+bb/4;
    const slope=(b-a)/(last-first);
    if(Math.abs(slope)>1)continue;
    let confirmed=0,exact=0,error=0;
    for(const [u,v] of points){
      const delta=Math.abs(v-a-(u-first)*slope);
      if(delta<=1.37)confirmed++;
      if(delta<=.53)exact++;
      error+=Math.min(2.5,delta);
    }
    if(confirmed<points.length*.92||exact<points.length*.52)continue;
    const merit=error+.85*(points.length-exact)+.32*(Math.abs(a-firstV)+Math.abs(b-lastV));
    if(!best||merit<best.merit)best={a,b,merit};
  }
  return best;
}

function paintAnchoredSceneRun(columns,proposal,current,source,data,reserved,compact,opaque,lines,opts) {
  const {axis:{at,breadth,swapped},sign}=proposal;
  // Refit after splitting: each emitted run has its own observed endpoints.
  const samples=columns.filter(c=>c.measured!==undefined).map(c=>[c.u,c.measured]);
  if(samples.length<.83*columns.length)return;
  const anchors=fitSceneStrokeAnchors(samples);
  if(!anchors)return;
  const start=samples[0][0],end=samples.at(-1)[0],slope=(anchors.b-anchors.a)/(end-start);
  const points=[];
  for(const c of columns){
    const {u,measured}=c;
    if(u<start||u>end)continue;
    const v=Math.round(anchors.a+slope*(u-start));
    if(v<3||v>=breadth-3||Math.abs(v-c.v)>1) return;
    const i=at(u,v),a=at(u,v-(sign?3:2)),b=at(u,v+(sign?3:2));
    if(reserved[i]||reserved[a]||reserved[b]||compact[i]||!opaque(i)||!opaque(a)||!opaque(b))return;
    const measuredAt=measured===undefined?i:at(u,measured);
    const prominence=sign*(source[3*measuredAt]-(sign>0?Math.max(source[3*a],source[3*b]):Math.min(source[3*a],source[3*b])));
    points.push({u,v,i,a,b,measuredAt,prominence});
  }
  if(points.length<22)return;
  if(!sign){
    paintAnchoredMaterial(points,source,current,data,reserved,compact,opaque,at,anchors,swapped,lines,opts);
    return;
  }
  if(points.filter(p=>p.prominence>=3).length<points.length*.78)return;
  const distance=(i,j)=>Math.hypot(current[3*i]-current[3*j],current[3*i+1]-current[3*j+1],current[3*i+2]-current[3*j+2]);
  const strokeColour=(i,a,b)=>sign*(current[3*i]-(sign>0?Math.max(current[3*a],current[3*b]):Math.min(current[3*a],current[3*b])));
  const pigments=[];
  for(const {u,v,a,b,measuredAt,prominence} of points){
    if(prominence<3)continue;
    let observed=-1,score=-Infinity;
    for(const d of [-1,0,1]){
      const i=at(u,v+d),value=strokeColour(i,a,b);
      if(value<2.7||reserved[i])continue;
      const photo=Math.hypot(current[3*i]-source[3*measuredAt],current[3*i+1]-source[3*measuredAt+1],current[3*i+2]-source[3*measuredAt+2]);
      const merit=value*.5-photo-Math.abs(d)*.45;
      if(photo<=14&&merit>score){score=merit;observed=i;}
    }
    if(observed>=0)pigments.push(observed);
  }
  if(pigments.length<points.length*.64)return;
  pigments.sort((a,b)=>current[3*a]-current[3*b]);
  const ink=pigments[pigments.length>>1];
  if(pigments.filter(p=>distance(ink,p)<=8).length<pigments.length*.88)return;

  const plan=new Map();
  let repair=0;
  for(const {u,v,i,a,b,measuredAt} of points){
    if(strokeColour(ink,a,b)<1.5)return;
    // Pigment has to fit the source cross-section. Permit a one-cell
    // movement, and clear the old core only to its own face colour.
    if(Math.hypot(current[3*ink]-source[3*measuredAt],current[3*ink+1]-source[3*measuredAt+1],current[3*ink+2]-source[3*measuredAt+2])>18)return;
    if(strokeColour(i,a,b)<2.7||distance(i,ink)>8)repair++;
    if(distance(i,ink)>.15)plan.set(i,ink);
    if(u===start||u===end)continue;
    for(const d of [-1,1]){
      const j=at(u,v+d),face=d<0?a:b;
      if(distance(j,ink)>8||distance(j,face)<5||sign*(source[3*measuredAt]-source[3*j])<3)continue;
      if(reserved[j]||compact[j]||!opaque(j))return;
      plan.set(j,face);
    }
  }
  if(repair<Math.max(3,points.length*.095)||plan.size<4||plan.size>1.32*points.length)return;
  const copies=[...plan].map(([i,j])=>[i,data.slice(4*j,4*j+3),current.slice(3*j,3*j+3)]);
  for(const [i,rgb,lab] of copies){data.set(rgb,4*i);current.set(lab,3*i);reserved[i]=1;}
  for(const {i} of points)reserved[i]=1;
  if(opts.contourDiagnostics)lines.push({transposed:swapped,sign,from:[start,Math.round(anchors.a)],to:[end,Math.round(anchors.b)],
    subpixel:[anchors.a,anchors.b],
    repaired:repair,changed:plan.size,centers:points.map(p=>p.i)});
}

function paintAnchoredMaterial(points,source,current,data,reserved,compact,opaque,at,anchors,swapped,lines,opts) {
  // One stable pair of faces must explain the entire boundary. Do not erase
  // an existing dark contour while snapping the two materials to the seam.
  const project=(space,i,a,b)=>{
    const l=source[3*b]-source[3*a],x=source[3*b+1]-source[3*a+1],y=source[3*b+2]-source[3*a+2];
    return ((space[3*i]-source[3*a])*l+(space[3*i+1]-source[3*a+1])*x+(space[3*i+2]-source[3*a+2])*y)/(l*l+x*x+y*y||1);
  };
  const polarity=({a,b})=>[source[3*b]-source[3*a],source[3*b+1]-source[3*a+1],source[3*b+2]-source[3*a+2]];
  const reference=polarity(points[points.length>>1]),size=Math.hypot(...reference);
  if(size<15)return;
  const plan=[];
  let stable=0;
  for(const {u,v,i,a,b} of points){
    const normal=polarity({a,b}),span=Math.hypot(...normal);
    if(span<11||normal.reduce((s,c,n)=>s+c*reference[n],0)<span*size*.86)continue;
    const j=at(u,v-1), left=project(current,j,a,b),right=project(current,i,a,b);
    const originalLeft=project(source,j,a,b),originalRight=project(source,i,a,b);
    if(originalLeft>.80||originalRight<.20||originalRight-originalLeft<.18)continue;
    stable++;
    if(reserved[j]||compact[j]||!opaque(j))continue;
    for(const [p,face,t,observed] of [[j,a,left,originalLeft],[i,b,right,originalRight]]){
      const other=face===a?b:a, belongsLeft=face===a;
      if(belongsLeft?t<.34:t>.66)continue;
      if(belongsLeft?observed>.67:observed<.33)continue;
      if(current[3*p]<Math.min(current[3*face],current[3*other])-4
          ||current[3*p]>Math.max(current[3*face],current[3*other])+4)continue;
      const offset=p*3,origin=a*3;
      // Keep independent pigments such as a gold rim next to a wood/cloth
      // boundary. A simple transition colour lies between the two faces.
      const residual=Math.hypot(...normal.map((channel,n)=>current[offset+n]-source[origin+n]-channel*t));
      if(residual>Math.max(5.5,span*.15))continue;
      const q=face*3;
      // A replacement face should also explain the actual source colour at
      // this cell. In particular, do not expand the saturated shoulder of a
      // rim across a low-saturation sample just because it fits the slope.
      const chromaError=Math.hypot(current[q+1]-source[offset+1],current[q+2]-source[offset+2]);
      if(chromaError>8.5||Math.abs(current[q]-source[offset])>15)continue;
      const match=project(current,face,a,b);
      if(belongsLeft?match>.25:match<.75)continue;
      plan.push([p,face]);
    }
  }
  if(stable<points.length*.85||plan.length<Math.max(5,points.length*.12))return;
  const snapshots=plan.map(([i,j])=>[i,data.slice(4*j,4*j+3),current.slice(3*j,3*j+3)]);
  for(const [i,rgb,lab] of snapshots){data.set(rgb,4*i);current.set(lab,3*i);reserved[i]=1;}
  for(const {i} of points)reserved[i]=1;
  if(opts.contourDiagnostics)lines.push({transposed:swapped,sign:0,from:[points[0].u,Math.round(anchors.a)],to:[points.at(-1).u,Math.round(anchors.b)],
    subpixel:[anchors.a,anchors.b],
    changed:plan.length,centers:points.map(p=>p.i)});
}

/** Restore source-coloured border pixels beside an unsupported compact-colour spur. */
function restoreCompactSceneFaces(image, source, lab, compact) {
  const {width,height,data}=image,current=pxLab(image), ed=new Map();
  const opaque=i=>data[4*i+3]===255&&source.data[4*i+3]===255;
  for(let y=5;y<height-5;y++)for(let x=5;x<width-5;x++){
    const i=y*width+x;
    if(!compact[i]||!opaque(i))continue;
    const [a,b]=[current[3*i+1],current[3*i+2]],s=a*a+b*b;
    const projection=(space,j)=>(a*space[3*j+1]+b*space[3*j+2])/s;
    if(s<34*34||projection(lab,i)>.37)continue;
    const hue=j=>projection(current,j)>=.67&&Math.abs(a*current[3*j+2]-b*current[3*j+1])<s*.36;
    let colour=-1,cost=12;
    for(const inside of [-width,width,-1,1]){
      if(hue(i-inside)||projection(current,i+inside)<.38||!hue(i+2*inside))continue;
      const along=Math.abs(inside)===1?width:1;
      let inner=0,outer=0;
      for(let d=-4;d<=4;d++){
        if(hue(i+2*inside+d*along))inner++;
        if(hue(i+d*along))outer++;
      }
      if(inner<8||outer>7)continue;
      for(let d=-4;d<=4;d++)for(const step of [0,-1,-2]){
        const j=i+along*d+inside*step;
        if(!opaque(j)||hue(j)||projection(lab,j)>.55)continue;
        const dist=Math.hypot(current[3*j]-lab[3*i],current[3*j+1]-lab[3*i+1],current[3*j+2]-lab[3*i+2]);
        if(dist<cost){cost=dist;colour=j;}
      }
    }
    if(colour>=0)ed.set(i,data.slice(4*colour,4*colour+3));
  }
  for(const [i,rgb] of ed)data.set(rgb,4*i);
  return [...ed.keys()];
}

/** Share perceptual tone steps across false boundaries in a smoothly lit surface. */
function reconcileSceneSoftTones(image, base, source, compact, opaque, lines=[]) {
  const {width,height,data}=image, size=width*height, current=pxLab(image);
  const safe=new Uint8Array(size), marked=new Uint8Array(size), queue=new Int32Array(size);
  const reserved=new Uint8Array(size);
  for(const line of lines){
    const step=line.transposed?1:width,extent=line.transposed?width:height;
    for(const i of line.centers){
      const v=line.transposed?i%width:Math.floor(i/width);
      reserved[i]=1;
      if(v>0)reserved[i-step]=1;
      if(v<extent-1)reserved[i+step]=1;
    }
  }
  const distance=(a,i,b,j)=>Math.hypot(a[i*3]-b[j*3], a[i*3+1]-b[j*3+1], a[i*3+2]-b[j*3+2]);
  const soft=2.6, falseJump=4.5;
  const muted=(r,g,b)=>Math.max(r,g,b)-Math.min(r,g,b)<=24;
  const unchanged=i=>data[i*4]===base.data[i*4]&&data[i*4+1]===base.data[i*4+1]&&data[i*4+2]===base.data[i*4+2];

  // Guard the neighbourhood as well as the centre of a real source edge.
  // Also reserve compact objects and pixels already repaired by the line passes.
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
    const i=y*width+x;
    if(compact[i]||reserved[i]||!opaque(i)||!unchanged(i)||!muted(data[i*4],data[i*4+1],data[i*4+2]))continue;
    let ok=true;
    for(const offset of [-1,1,-width,width]){
      if(!opaque(i+offset)||!opaque(i+2*offset)
          ||distance(source,i,source,i+offset)>4.8||distance(source,i,source,i+2*offset)>7.2){ok=false;break;}
    }
    if(ok)safe[i]=1;
  }
  let tail=0;
  const enqueue=(i,level)=>{
    if(!marked[i]){marked[i]=level;queue[tail++]=i;}
  };
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
    const i=y*width+x;
    if(!safe[i])continue;
    for(const offset of [1,width]){
      const j=i+offset;
      if(!safe[j])continue;
      const original=distance(source,i,source,j), quantized=distance(current,i,current,j);
      if(original<=soft&&quantized>=falseJump&&quantized-original>=3.2){enqueue(i,1);enqueue(j,1);}
    }
  }
  if(!tail)return 0;

  // Include a narrow neighbourhood on the same source surface. A local
  // quantization seam should not retone a whole wall or sky behind it.
  for(let head=0;head<tail;head++){
    const i=queue[head];
    if(marked[i]>=5)continue;
    for(const offset of [-1,1,-width,width]){
      const j=i+offset;
      if(safe[j]&&!marked[j]&&distance(source,i,source,j)<=soft)enqueue(j,marked[i]+1);
    }
  }

  const edited=new Uint8Array(size), targets=current.slice(), palette=new Map();
  const rgbEdits=new Map();
  const existing=new Map();
  for(let i=0;i<size;i++){
    const p=i*4;
    if(data[p+3]!==255)continue;
    const key=(data[p]<<16)|(data[p+1]<<8)|data[p+2];
    if(!existing.has(key))existing.set(key,{rgb:data.slice(p,p+3),lab:current.subarray(i*3,i*3+3)});
  }
  for(let n=0;n<tail;n++){
    const i=queue[n],p=i*3;
    const error=distance(source,i,current,i);
    if(error<2.6)continue;
    // A fixed Lab grid gives neighbouring regions the same shade choices,
    // while preserving both gradual lighting and colour differences in the source.
    const keys=[Math.round(source[p]/2),Math.round(source[p+1]/2.5),Math.round(source[p+2]/2.5)];
    const key=keys.join(',');
    if(!palette.has(key)){
      const rgb=labToRgb(2*keys[0],2.5*keys[1],2.5*keys[2]);
      const lab=rgbToLab(...rgb);
      let tone={rgb,lab},nearest=1.45;
      for(const candidate of existing.values()){
        const d=Math.hypot(lab[0]-candidate.lab[0],lab[1]-candidate.lab[1],lab[2]-candidate.lab[2]);
        if(d<nearest){tone=candidate;nearest=d;}
      }
      palette.set(key,tone);
    }
    const colour=palette.get(key);
    if(!muted(...colour.rgb))continue;
    const nextError=Math.hypot(source[p]-colour.lab[0],source[p+1]-colour.lab[1],source[p+2]-colour.lab[2]);
    if(error-nextError<1.25)continue;
    edited[i]=1;
    targets.set(colour.lab,p);
    rgbEdits.set(i,colour.rgb);
  }

  // Reject edits that would shift a hard step to the limits of a protected
  // surface. Recheck neighbouring edits after each rejection.
  const pending=[...rgbEdits.keys()];
  for(let n=0;n<pending.length;n++){
    const i=pending[n];
    if(!edited[i])continue;
    const createsStep=[-1,1,-width,width].some(offset=>{
      const j=i+offset;
      if(!opaque(j))return false;
      const original=distance(source,i,source,j);
      if(original>soft)return false;
      const before=distance(current,i,current,j), after=distance(targets,i,targets,j);
      return after>=falseJump&&after-original>=3.2&&(before<falseJump||after>before+1);
    });
    if(!createsStep)continue;
    edited[i]=0;
    targets.set(current.subarray(i*3,i*3+3),i*3);
    for(const offset of [-1,1,-width,width])if(edited[i+offset])pending.push(i+offset);
  }
  let count=0;
  for(const [i,rgb] of rgbEdits){
    if(!edited[i])continue;
    data.set(rgb,i*4);
    count++;
  }
  return count;
}

// Same-colour 4-neighbour flood. Keep raster labels and membership, not all contours.
function straightColourComponents(image) {
  const {width:w,height:h,data}=image;
  const size=w*h, labels=new Int32Array(size).fill(-1), cells=new Int32Array(size), components=[];
  const colours=new Uint32Array(size);
  for(let i=0;i<size;i++){
    const k=4*i;
    colours[i]=(data[k+3]<<24)|(data[k]<<16)|(data[k+1]<<8)|data[k+2];
  }
  let tail=0;
  for(let seed=0;seed<size;seed++){
    if(labels[seed]!==-1||!data[4*seed+3])continue;
    const id=components.length,from=tail,key=colours[seed];
    let left=w,right=0,top=h,bottom=0;
    const enqueue=i=>{
      if(labels[i]===-1&&colours[i]===key){labels[i]=id;cells[tail++]=i;}
    };
    enqueue(seed);
    for(let head=from;head<tail;head++){
      const i=cells[head],x=i%w,y=Math.floor(i/w);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      if(x>0)enqueue(i-1);
      if(x+1<w)enqueue(i+1);
      if(y>0)enqueue(i-w);
      if(y+1<h)enqueue(i+w);
    }
    components.push({id,seed,from,end:tail,length:tail-from,left,right,top,bottom});
  }
  return {labels,cells,components};
}

function mergeStraightComponents(image, partition, maxDistance) {
  const {width:w,height:h,data}=image;
  const {labels,cells,components}=partition;
  const count=components.length,roots=Int32Array.from(components,c=>c.id);
  const find=id=>{
    while(roots[id]!==id){roots[id]=roots[roots[id]];id=roots[id];}
    return id;
  };
  // Each source component is monochrome, so its seed gives its exact mean.
  const means=components.map(({seed})=>{
    const p=seed*4;
    return rgbToLab(data[p],data[p+1],data[p+2]);
  });
  const thresholdSquared=maxDistance*maxDistance,contacts=new Map();
  let mergedPairs=0;
  const countContact=(a,b)=>{
    if(a===b||a<0||b<0)return;
    if(a>b)[a,b]=[b,a];
    const key=a*count+b,seen=contacts.get(key);
    if(seen===2)return;
    if(!seen){contacts.set(key,1);return;}
    contacts.set(key,2);
    if(data[4*components[a].seed+3]!==data[4*components[b].seed+3])return;
    const first=means[a],second=means[b];
    const distance=(first[0]-second[0])**2+(first[1]-second[1])**2+(first[2]-second[2])**2;
    if(distance>=thresholdSquared)return;
    const left=find(a),right=find(b);
    if(left===right)return;
    roots[Math.max(left,right)]=Math.min(left,right);
    mergedPairs++;
  };
  if(maxDistance>0){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x;
      if(x+1<w)countContact(labels[i],labels[i+1]);
      if(y+1<h)countContact(labels[i],labels[i+w]);
    }
  }
  if(!mergedPairs)return {...partition,roots,mergedPairs,maxFragments:count?1:0};

  const groups=new Array(count);
  let maxFragments=0;
  for(const c of components){
    const id=roots[c.id]=find(c.id),lab=means[c.id],area=c.length;
    let group=groups[id];
    if(!group){
      group={...c,length:0,fragments:0,labSum:[0,0,0]};
      groups[id]=group;
    }
    group.length+=area;
    group.fragments++;
    group.labSum[0]+=lab[0]*area;
    group.labSum[1]+=lab[1]*area;
    group.labSum[2]+=lab[2]*area;
    group.left=Math.min(group.left,c.left);group.right=Math.max(group.right,c.right);
    group.top=Math.min(group.top,c.top);group.bottom=Math.max(group.bottom,c.bottom);
    maxFragments=Math.max(maxFragments,group.fragments);
  }
  const merged=groups.filter(Boolean),write=new Int32Array(count),mergedCells=new Int32Array(cells.length);
  let next=0;
  for(const group of merged){
    write[group.id]=group.from=next;
    next+=group.length;
    group.end=next;
    if(group.fragments>1)group.color=labToRgb(...group.labSum.map(value=>value/group.length));
  }
  for(const c of components){
    const id=roots[c.id];
    for(let k=c.from;k<c.end;k++){
      const i=cells[k];
      labels[i]=id;
      mergedCells[write[id]++]=i;
    }
  }
  return {labels,cells:mergedCells,components:merged,roots,mergedPairs,maxFragments};
}

// Moore neighbourhood in clockwise order. Close on the directed start edge
// so a second visit to the same cell via another arm cannot close early.
function traceStraightContour(member,component,w,h) {
  const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const first=component.seed, points=[];
  let p=first, back=4, successor=-1;
  const limit=Math.min(component.length*2+256,200000);
  for(let n=0;n<limit;n++){
    const x=p%w,y=Math.floor(p/w);
    let step=1,next=-1;
    for(;step<=8;step++){
      const [dx,dy]=dirs[(back+step)%8],xx=x+dx,yy=y+dy;
      if(xx>=0&&xx<w&&yy>=0&&yy<h&&member[yy*w+xx]){next=yy*w+xx;break;}
    }
    if(next<0)return null;
    if(successor===-1)successor=next;
    else if(p===first&&next===successor)return points;
    points.push([x,y]);
    const [dx,dy]=dirs[(back+step+7)%8];
    const xx=x+dx-next%w,yy=y+dy-Math.floor(next/w);
    back=dirs.findIndex(([a,b])=>a===xx&&b===yy);
    p=next;
  }
  return null;
}

function straightDouglasPeuckerRuns(points) {
  const end=points.length,[x0,y0]=points[0];
  let far=0,farthest=0;
  for(let i=1;i<end;i++){
    const [x,y]=points[i],dx=x-x0,dy=y-y0;
    const distance=dx*dx+dy*dy;
    if(distance>farthest){far=i;farthest=distance;}
  }
  if(!far)return [];

  // The closing index refers back to point zero. Both halves keep their
  // endpoints, so the original indices also describe the joined ring.
  const keep=new Uint8Array(end+1),stack=[[0,far],[far,end]];
  keep[0]=keep[far]=keep[end]=1;
  const epsilonSquared=1.8**2;
  while(stack.length){
    const [start,finish]=stack.pop();
    const [ax,ay]=points[start],[bx,by]=points[finish%end];
    const dx=bx-ax,dy=by-ay,lengthSquared=dx*dx+dy*dy;
    let split=-1,maxDistance=epsilonSquared*(lengthSquared||1);
    for(let i=start+1;i<finish;i++){
      const [x,y]=points[i],u=x-ax,v=y-ay;
      const cross=dx*v-dy*u;
      const distance=lengthSquared?cross*cross:u*u+v*v;
      if(distance>maxDistance){split=i;maxDistance=distance;}
    }
    if(split!==-1){
      keep[split]=1;
      stack.push([start,split],[split,finish]);
    }
  }

  const runs=[];
  let start=0;
  for(let i=1;i<=end;i++){
    if(!keep[i])continue;
    runs.push({start,end:i});
    start=i;
  }
  return runs;
}

function fitStraightRun(points,run) {
  const n=run.end-run.start+1;
  let x=0,y=0,xx=0,xy=0,yy=0;
  for(let i=run.start;i<=run.end;i++){
    const [u,v]=points[i%points.length];x+=u;y+=v;xx+=u*u;xy+=u*v;yy+=v*v;
  }
  const angle=.5*Math.atan2(2*(xy-x*y/n),xx-x*x/n-(yy-y*y/n));
  const slope=Math.abs(Math.cos(angle))<1e-9?Infinity:Math.tan(angle);
  const slopes=[0,1/3,.5,1,2,3,Infinity];
  const target=slopes.reduce((a,b)=>Math.abs(Math.atan(b)-Math.abs(angle))<Math.abs(Math.atan(a)-Math.abs(angle))?b:a);
  return {slope,snapped:target===Infinity?Infinity:Math.sign(angle)*target};
}

function straightAnchor(anchor,[x,y],slope,maxDrift,stats) {
  const [a,b]=anchor, dx=x-a,dy=y-b;
  let nx=x,ny=y;
  if(slope===0)ny=b;
  else if(!Number.isFinite(slope))nx=a;
  else if(Math.abs(dx)>=Math.abs(dy))ny=b+Math.round(dx*slope);
  else nx=a+Math.round(dy/slope);
  const isTwoToOne=Math.abs(slope)===.5||Math.abs(slope)===2;
  stats.anchorSegments++;
  if(isTwoToOne)stats.ratioAnchorSegments++;
  if(Math.hypot(nx-x,ny-y)<=maxDrift){
    if(dx*(ny-b)!==dy*(nx-a))stats.segmentsSnapped++;
    return [nx,ny];
  }
  stats.anchorsClamped++;
  if(isTwoToOne)stats.ratioAnchorsClamped++;
  return [x,y];
}

// Visit the integer pixels inside the closed ring using even–odd scanlines.
function scanStraightPolygon(vertices,w,h,span) {
  const crossings=Array.from({length:h},()=>[]);
  for(let i=0,j=vertices.length-1;i<vertices.length;j=i++){
    let [x0,y0]=vertices[j],[x1,y1]=vertices[i];
    if(y0>y1){[x0,x1]=[x1,x0];[y0,y1]=[y1,y0];}
    if(y0>=0&&y0<h){
      const left=Math.max(0,Math.min(x0,x1)),right=Math.min(w-1,Math.max(x0,x1));
      if(y0===y1&&left<=right)span(y0,left,right);
    }
    if(y0===y1)continue;
    // Count a shared vertex once in the parity pass, and retain its pixel.
    for(let y=Math.max(0,y0);y<=Math.min(h-1,y1);y++){
      const offset=(x1-x0)*(y-y0),height=y1-y0;
      const x=x0+offset/height;
      if(y<y1)crossings[y].push(x);
      if(offset%height===0&&x>=0&&x<w)span(y,x,x);
    }
  }
  for(let y=0;y<h;y++){
    const row=crossings[y];
    if(!row.length)continue;
    row.sort((a,b)=>a-b);
    for(let i=0;i+1<row.length;i+=2){
      const left=Math.max(0,Math.ceil(row[i])),right=Math.min(w-1,Math.floor(row[i+1]));
      if(left<=right)span(y,left,right);
    }
  }
}

function repairStraightGaps(owners,labels,data,w,h) {
  const repairs=[];
  for(let i=0;i<owners.length;i++){
    if(owners[i]!==-1||labels[i]===-1)continue;
    const x=i%w,y=Math.floor(i/w),alpha=data[4*i+3];
    let donor=-1,nearest=Infinity;
    // A closed contour can leave a small gap. Search at most its local
    // displacement band first, and grow by one ring until the result is exact.
    const limit=Math.max(x,w-1-x,y,h-1-y);
    for(let radius=1;radius<=limit&&radius*radius<=nearest;radius++){
      for(let v=Math.max(0,y-radius);v<=Math.min(h-1,y+radius);v++){
        for(let u=Math.max(0,x-radius);u<=Math.min(w-1,x+radius);u++){
          if(Math.max(Math.abs(u-x),Math.abs(v-y))!==radius)continue;
          const j=v*w+u,d=(u-x)**2+(v-y)**2;
          if(owners[j]===-1||data[j*4+3]!==alpha||d>nearest)continue;
          // At equal distance, retain the source side of the interface.
          // Otherwise a tie can grow a dark detail into the adjacent fill.
          if(d===nearest&&(donor===labels[i]||owners[j]!==labels[i]))continue;
          donor=owners[j];nearest=d;
        }
      }
    }
    repairs.push(i,donor===-1?labels[i]:donor);
  }
  for(let k=0;k<repairs.length;k+=2)owners[repairs[k]]=repairs[k+1];
  return repairs.length/2;
}

// Write one side of each shared edge, using the darker region's unmodified
// colour. Work from the finished labels so remapping one edge can't make
// a neighbouring interface move or widen.
function renderStraightRegions(base,owners,components) {
  const {width:w,height:h,data}=base;
  const result=new Uint8ClampedArray(data),seams=new Uint8Array(owners.length);
  const lightness=new Float64Array((components.at(-1)?.id??-1)+1),palette=new Map();
  const colors=new Array(lightness.length);
  for(const component of components){
    const p=component.seed*4,[r,g,b]=component.color??[data[p],data[p+1],data[p+2]];
    const key=(r<<16)|(g<<8)|b;
    colors[component.id]=[r,g,b];
    if(!palette.has(key))palette.set(key,rgbToLab(r,g,b)[0]);
    lightness[component.id]=palette.get(key);
  }
  const fill=(i,id)=>{
    const p=4*i,[r,g,b]=colors[id];
    result[p]=r;result[p+1]=g;result[p+2]=b;
  };
  for(let i=0;i<owners.length;i++)if(owners[i]!==-1)fill(i,owners[i]);
  let seamPixels=0;
  const seam=(i,j)=>{
    const a=owners[i],b=owners[j];
    if(a===b||a===-1||b===-1||data[4*i+3]!==data[4*j+3])return;
    const p=4*i,q=4*j;
    if(result[p]===result[q]&&result[p+1]===result[q+1]&&result[p+2]===result[q+2])return;
    const dark=lightness[a]<lightness[b]||(lightness[a]===lightness[b]&&a<b)?i:j;
    if(seams[dark])return;
    seams[dark]=1;
    fill(dark,owners[dark]);
    seamPixels++;
  };
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;
    if(x+1<w)seam(i,i+1);
    if(y+1<h)seam(i,i+w);
  }
  return {result,seams,seamPixels};
}

/** Rebuild the region labels first, then render fills and their shared boundaries. */
export function sampleSceneStraight(img,xs,ys,opts={}) {
  const minArea=opts.minArea??700,minRun=opts.minRun??7,maxDrift=opts.maxDrift??1.5;
  const base=sampleSceneElement(img,xs,ys,opts).image;
  const clock=()=>typeof performance!=='undefined'?performance.now():Date.now();
  const started=clock();
  const {width:w,height:h,data}=base,size=w*h,paddedWidth=w+2,paddedHeight=h+2;
  const original=straightColourComponents(base);
  const mergeDistance=opts.mergeDistance??1.5;
  const {labels,cells,components,roots,mergedPairs,maxFragments}=mergeStraightComponents(base,original,mergeDistance);
  const members=new Uint8Array(paddedWidth*paddedHeight);
  const owners=new Int32Array(size).fill(-1),envelope=new Int32Array(size).fill(-1);
  const objects=components.filter(c=>c.length>=minArea).length;
  const report=opts.contourDiagnostics?[]:null;
  const limit=size*4;
  const skipReasons={border:0,tooLong:0,tooShort:0,fewRuns:0,driftAbort:0,budget:0,
    traceFailed:0,unsafeAnchor:0,noPaint:0};
  const anchorStats={segments:0,segmentsSnapped:0,anchorSegments:0,anchorsClamped:0,
    ratioAnchorSegments:0,ratioAnchorsClamped:0};
  const paddedIndex=i=>(Math.floor(i/w)+1)*paddedWidth+(i%w)+1;
  let filledRegions=0,borderTouching=0,polygonSteps=0,budgetExceeded=false;

  const contourPolygon=component=>{
    for(let k=component.from;k<component.end;k++)members[paddedIndex(cells[k])]=1;
    const raw=traceStraightContour(members,{seed:paddedIndex(component.seed),length:component.length},
      paddedWidth,paddedHeight);
    for(let k=component.from;k<component.end;k++)members[paddedIndex(cells[k])]=0;
    if(!raw){skipReasons.traceFailed++;return null;}
    if(raw.length>20000){skipReasons.tooLong++;return null;}
    if(raw.length<minRun*2){skipReasons.tooShort++;return null;}
    const contour=raw.map(([x,y])=>[x-1,y-1]);
    const runs=straightDouglasPeuckerRuns(contour);
    anchorStats.segments+=runs.length;
    if(runs.length<3){skipReasons.fewRuns++;return null;}

    const vertices=[contour[0]];
    let anchor=contour[0],cost=0;
    for(const run of runs){
      const fit=fitStraightRun(contour,run);
      const next=straightAnchor(anchor,contour[run.end%contour.length],fit.snapped,maxDrift,anchorStats);
      vertices.push(next);
      cost+=Math.max(Math.abs(next[0]-anchor[0]),Math.abs(next[1]-anchor[1]))+1;
      anchor=next;
    }
    const [x0,y0]=contour[0],closingGap=Math.hypot(anchor[0]-x0,anchor[1]-y0);
    if(closingGap>3){skipReasons.driftAbort++;return null;}
    if(closingGap>0)cost+=Math.max(Math.abs(anchor[0]-x0),Math.abs(anchor[1]-y0))+1;
    else vertices.pop();
    if(polygonSteps+cost>limit){budgetExceeded=true;skipReasons.budget++;return null;}
    polygonSteps+=cost;
    return {contour,vertices};
  };

  for(const component of components){
    const {id,from,end,left,right,top,bottom}=component;
    const eligible=component.length>=minArea;
    if(eligible&&budgetExceeded)skipReasons.budget++;
    const polygon=eligible&&!budgetExceeded?contourPolygon(component):null;
    if(!polygon){
      for(let k=from;k<end;k++)owners[cells[k]]=id;
      continue;
    }

    // Retain original holes, whose pixels have independent owners. The
    // padded contour is in image coordinates by now, so scanlines clip only
    // the raster output, including any snapped vertex outside the canvas.
    scanStraightPolygon(polygon.contour,w,h,(y,a,b)=>envelope.fill(id,y*w+a,y*w+b+1));
    const alpha=data[4*component.seed+3];
    let anyFill=false;
    scanStraightPolygon(polygon.vertices,w,h,(y,a,b)=>{
      for(let i=y*w+a;i<=y*w+b;i++){
        if(data[4*i+3]!==alpha||(envelope[i]===id&&labels[i]!==id))continue;
        owners[i]=id;anyFill=true;
      }
    });
    if(!anyFill){
      skipReasons.noPaint++;
      for(let k=from;k<end;k++)owners[cells[k]]=id;
      continue;
    }
    filledRegions++;
    if(left===0||right===w-1||top===0||bottom===h-1)borderTouching++;
    if(report)report.push({id,area:component.length,contourLength:polygon.contour.length,
      bounds:[left,top,right,bottom],vertices:polygon.vertices});
  }

  const repairedPixels=repairStraightGaps(owners,labels,data,w,h);
  const {result,seams,seamPixels}=renderStraightRegions(base,owners,components);
  const response={image:{data:result,width:w,height:h},objects,drawn:filledRegions,
    skipped:objects-filledRegions,filledRegions,borderTouching,seamPixels,repairedPixels,
    mergedPairs,maxFragments,mergeDistance,componentsBefore:original.components.length,componentsAfter:components.length,
    skipReasons,...anchorStats,maxDriftAborts:anchorStats.anchorsClamped,polygonSteps,
    bresenhamSteps:0,budgetExceeded,regularizeMs:clock()-started};
  if(report)response.diagnostics={regions:report,owners,seams,roots,limit};
  return response;
}
