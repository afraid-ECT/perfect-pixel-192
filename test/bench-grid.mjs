/**
 * 网格检测基准（node 直接跑）：合成图 → 检测 → 统计命中率与耗时。
 * 用法: node test/bench-grid.mjs
 */
import { analyze } from '../core.js';

function rng(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const PALETTE = [
  [26, 28, 44], [93, 39, 93], [177, 62, 83], [239, 125, 87],
  [255, 205, 117], [167, 240, 112], [56, 183, 100], [37, 113, 121],
  [41, 54, 111], [59, 93, 201], [65, 166, 246], [115, 239, 247],
  [244, 244, 244], [148, 176, 194], [86, 108, 134], [51, 60, 87],
];

/** 逻辑 gw×gh 重采样到 W×H，可选 1px 模糊 + 噪声（模拟 AI 输出）。 */
export function synth(gw, gh, W, H, seed = 11, blur = true) {
  const r = rng(seed);
  const g = [];
  for (let i = 0; i < gw * gh; i++) g.push(PALETTE[Math.floor(r() * PALETTE.length)]);
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(gw - 1, Math.floor(((x + 0.5) * gw) / W));
      const sy = Math.min(gh - 1, Math.floor(((y + 0.5) * gh) / H));
      const c = g[sy * gw + sx];
      const p = (y * W + x) * 4;
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
    }
  }
  if (!blur) return { data: d, width: W, height: H };
  const o = new Uint8ClampedArray(d.length);
  const r2 = rng(seed + 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let k = -1; k <= 1; k++) {
        for (let j = -1; j <= 1; j++) {
          const yy = Math.min(H - 1, Math.max(0, y + k));
          const xx = Math.min(W - 1, Math.max(0, x + j));
          const p = (yy * W + xx) * 4;
          R += d[p]; G += d[p + 1]; B += d[p + 2]; n++;
        }
      }
      const p = (y * W + x) * 4;
      const nz = (r2() * 2 - 1) * 4;
      o[p] = R / n + nz; o[p + 1] = G / n + nz; o[p + 2] = B / n + nz; o[p + 3] = 255;
    }
  }
  return { data: o, width: W, height: H };
}

const main = process.argv[1] && process.argv[1].endsWith('bench-grid.mjs');
if (main) {
  const WIDTHS = [128, 192, 256, 320];
  const GROUPS = [
    { name: '常规（4~16px 格）', cells: [12, 16, 20, 24, 26, 28, 32, 40, 48] },
    { name: '高密度（2~4px 格）', cells: [56, 64, 80, 96] },
  ];
  for (const group of GROUPS) {
    let tot = 0, miss = 0, ms = 0;
    const fails = [];
    for (const W of WIDTHS) {
      for (const gw of group.cells) {
        if (gw > W / 2) continue;
        for (const seed of [11, 12, 13]) {
          const img = synth(gw, gw, W, W, seed);
          const t = Date.now();
          const r = analyze(img, { sample: 'core' });
          ms += Date.now() - t;
          tot++;
          if (r.gridW !== gw || r.gridH !== gw) {
            miss++;
            fails.push(`  ${W}/${gw} s${seed} -> ${r.gridW}x${r.gridH} (${r.method})`);
          }
        }
      }
    }
    console.log(`${group.name}: ${tot - miss}/${tot} 命中, 平均 ${(ms / tot).toFixed(0)}ms`);
    if (fails.length) console.log(fails.slice(0, 12).join('\n'));
  }
}
