/**
 * 两种"成品模式"的验证：
 *   strong = 单像素中心 + 32 色 + 去孤点 + 清轮廓外侧（背景刷平）
 *   region = 区域吸附去 AA（旧强劲模式）
 */
import { analyze } from '../core.js';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function rng(s0) { let s = s0 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const PAL = [
  [26, 28, 44], [93, 39, 93], [177, 62, 83], [239, 125, 87],
  [255, 205, 117], [167, 240, 112], [56, 183, 100], [37, 113, 121],
  [41, 54, 111], [59, 93, 201], [65, 166, 246], [115, 239, 247],
  [244, 244, 244], [148, 176, 194], [86, 108, 134], [51, 60, 87],
];

const BG = [200, 205, 190];

function upscale(grid, GN, CELL) {
  const W = GN * CELL;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid[Math.floor(y / CELL) * GN + Math.floor(x / CELL)];
      const p = (y * W + x) * 4;
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
    }
  }
  return { data, width: W, height: W };
}

function blurNoise(img, seed = 3, amp = 4) {
  const { data, width: W, height: H } = img;
  const r = rng(seed);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          const xx = Math.min(W - 1, Math.max(0, x + dx));
          const p = (yy * W + xx) * 4;
          R += data[p]; G += data[p + 1]; B += data[p + 2]; n++;
        }
      }
      const p = (y * W + x) * 4;
      const nz = (r() * 2 - 1) * amp;
      out[p] = R / n + nz; out[p + 1] = G / n + nz; out[p + 2] = B / n + nz; out[p + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/** 造一张带"描边混色环 + 背景孤点"的角色图 */
function makeScene(GN = 32, CELL = 6, seed = 5, aaRate = 0.18) {
  const rand = rng(seed);
  const grid = [];
  for (let y = 0; y < GN; y++) {
    for (let x = 0; x < GN; x++) {
      const dx = x - GN / 2 + 0.5;
      const dy = y - GN / 2 + 0.5;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      grid.push(PAL[Math.floor(r / 3.4 + Math.sin(ang * 3) * 0.7) & 15].slice());
    }
  }
  for (let y = 0; y < GN; y++) {
    for (let x = 0; x < GN; x++) {
      if (x < 6 || x >= GN - 6 || y < 5 || y >= GN - 4) grid[y * GN + x] = BG.slice();
    }
  }
  const src = grid.map((c) => c.slice());
  const blend = (a, b) => [(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1];
  for (let y = 1; y < GN - 1; y++) {
    for (let x = 1; x < GN - 1; x++) {
      const i = y * GN + x;
      const cur = src[i];
      const nb = [src[i - 1], src[i + 1], src[i - GN], src[i + GN]];
      const diff = nb.find((c) => c[0] !== cur[0] || c[1] !== cur[1] || c[2] !== cur[2]);
      if (diff && rand() < aaRate) grid[i] = blend(cur, diff);
    }
  }
  const dots = [[2, 2], [GN - 3, 3], [3, GN - 3], [GN - 2, GN - 2]];
  for (const [x, y] of dots) grid[y * GN + x] = [150, 120, 90];
  return { img: blurNoise(upscale(grid, GN, CELL), seed + 1), dots, GN, CELL };
}

function aaCount(img, tol = 12) {
  const d = img.data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    let hit = false;
    for (let a = 0; a < PAL.length && !hit; a++) {
      for (let b = a + 1; b < PAL.length && !hit; b++) {
        const mr = (PAL[a][0] + PAL[b][0]) / 2;
        const mg = (PAL[a][1] + PAL[b][1]) / 2;
        const mb = (PAL[a][2] + PAL[b][2]) / 2;
        if (Math.abs(d[i] - mr) <= tol && Math.abs(d[i + 1] - mg) <= tol && Math.abs(d[i + 2] - mb) <= tol) hit = true;
      }
    }
    if (hit) n++;
  }
  return n;
}

const near = (c, t, tol = 14) =>
  Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol;

function cellColor(img, x, y) {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

console.log('\n# 12a. 强劲模式（单像素中心 + 32 色 + 清外侧）');
{
  const { img, dots, GN } = makeScene(32, 6, 5);
  const strong = analyze(img, { sample: 'strong' });
  const center = analyze(img, { sample: 'center' });
  console.log(`   center: ${center.outW}×${center.outH} ${center.colorsAfter} 色`);
  console.log(`   strong: ${strong.outW}×${strong.outH} ${strong.colorsAfter} 色, 清外侧 ${strong.cleaned} 格, 去孤点 ${strong.speckles}`);

  check('格数 32×32', strong.outW === 32 && strong.outH === 32, `${strong.outW}×${strong.outH}`);
  check('色数 <= 32', strong.colorsAfter <= 32, `got ${strong.colorsAfter}`);
  check('色数少于单像素中心模式', strong.colorsAfter < center.colorsAfter, `${strong.colorsAfter} vs ${center.colorsAfter}`);
  check('确实清理了轮廓外侧', strong.cleaned > 0, `cleaned=${strong.cleaned}`);

  const c1 = cellColor(strong.image, 1, 1);
  const c2 = cellColor(strong.image, GN - 2, 1);
  const c3 = cellColor(strong.image, 1, GN - 2);
  check('背景被刷平成单一颜色', near(c1, c2, 3) && near(c1, c3, 3) && near(c1, BG, 26), `${c1} / ${c2} / ${c3}`);

  let dotsLeft = 0;
  for (const [x, y] of dots) if (!near(cellColor(strong.image, x, y), BG, 26)) dotsLeft++;
  check('背景里的 4 个孤立杂点全部清除', dotsLeft === 0, `剩 ${dotsLeft} 个`);

  check('角色主体仍然存在', !near(cellColor(strong.image, 16, 16), BG, 26), JSON.stringify(cellColor(strong.image, 16, 16)));
}
{
  const { img } = makeScene(32, 6, 7);
  const r = analyze(img, { sample: 'strong', colors: 16 });
  check('强劲模式 + 限 16 色：色数 <= 16', r.colorsAfter <= 16, `got ${r.colorsAfter}`);
  check('强劲模式 + 限 16 色：格数 32×32', r.outW === 32 && r.outH === 32);
}
{
  const { img } = makeScene(32, 6, 9);
  const a = analyze(img, { sample: 'strong' });
  const b = analyze(img, { sample: 'strong' });
  check('强劲模式确定性（两次逐字节相同）', a.image.data.every((v, i) => v === b.image.data[i]));
}

console.log('\n# 12b. 区域吸附去 AA（region）');
{
  const { img } = makeScene(32, 6, 5);
  const core = analyze(img, { sample: 'core' });
  const region = analyze(img, { sample: 'region' });
  const gCore = aaCount(core.image);
  const gRegion = aaCount(region.image);
  console.log(`   core:   ${core.colorsAfter} 色, AA 中点数 ${gCore}`);
  console.log(`   region: ${region.colorsAfter} 色, AA 中点数 ${gRegion}`);

  check('格数 32×32', region.outW === 32 && region.outH === 32);
  check('核心模式确实残留 AA（用例有效）', gCore > 0, `aa=${gCore}`);
  check('区域吸附把 AA 混色清零', gRegion === 0, `aa=${gRegion}（core=${gCore}）`);
  check('区域吸附色数明显减少', region.colorsAfter < core.colorsAfter, `${region.colorsAfter} vs ${core.colorsAfter}`);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
