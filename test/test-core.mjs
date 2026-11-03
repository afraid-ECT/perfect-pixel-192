/**
 * core.js 的回归测试 —— 纯 Node，无外部依赖。
 * 用合成图覆盖 192px 场景：整数倍放大、非方形、2px 细格、模糊+噪声。
 */
import { analyze, quantize, countColors, scaleToSquare } from '../core.js';

let pass = 0;
let fail = 0;
const fails = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    fails.push(`${name} ${extra}`);
    console.log(`  FAIL ${name} ${extra}`);
  }
}

/* ---------------------------------------------------------------- 工具 */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PALETTE = [
  [26, 28, 44], [93, 39, 93], [177, 62, 83], [239, 125, 87],
  [255, 205, 117], [167, 240, 112], [56, 183, 100], [37, 113, 121],
  [41, 54, 111], [59, 93, 201], [65, 166, 246], [115, 239, 247],
  [244, 244, 244], [148, 176, 194], [86, 108, 134], [51, 60, 87],
];

/** 生成 gw×gh 的调色板像素画，再按 cellW/cellH 最近邻放大。 */
function makePixelArt(gw, gh, cellW, cellH, seed = 7) {
  const rand = rng(seed);
  const small = new Uint8ClampedArray(gw * gh * 4);
  for (let i = 0; i < gw * gh; i++) {
    const c = PALETTE[Math.floor(rand() * PALETTE.length)];
    small[i * 4] = c[0];
    small[i * 4 + 1] = c[1];
    small[i * 4 + 2] = c[2];
    small[i * 4 + 3] = 255;
  }
  const w = gw * cellW;
  const h = gh * cellH;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / cellW);
      const s = (sy * gw + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = small[s];
      data[d + 1] = small[s + 1];
      data[d + 2] = small[s + 2];
      data[d + 3] = 255;
    }
  }
  return { image: { data, width: w, height: h }, small, gw, gh };
}

/** 3x3 盒式模糊 + 高斯噪声，模拟 JPEG/AI 生成的软边。 */
function soften(img, noise = 0, seed = 3) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(data.length);
  const rand = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const p = (yy * w + xx) * 4;
          r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
        }
      }
      const d = (y * w + x) * 4;
      const nz = noise ? (rand() * 2 - 1) * noise : 0;
      out[d] = r / n + nz;
      out[d + 1] = g / n + nz;
      out[d + 2] = b / n + nz;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

function maxColorError(a, b) {
  let m = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i += 4) {
    for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(a.data[i + k] - b.data[i + k]));
  }
  return m;
}

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/* ---------------------------------------------------------------- 用例 */

console.log('\n# 1. 192×192 / 24×24 格（8px 格宽）');
{
  const { image, small, gw, gh } = makePixelArt(24, 24, 8, 8);
  const r = analyze(image, { sample: 'majority' });
  console.log(`   detected ${r.outW}×${r.outH}  cell=${r.cellW.toFixed(2)}  method=${r.method}  conf=${r.confidence.toFixed(2)}  ${r.ms}ms`);
  check('输出尺寸 24×24', r.outW === 24 && r.outH === 24, `got ${r.outW}×${r.outH}`);
  check('网格线与格数一致', r.xs.length === 25 && r.ys.length === 25, `xs=${r.xs.length}`);
  check('颜色完全还原', maxColorError(r.image, { data: small, width: gw, height: gh }) === 0);
}

console.log('\n# 2. 192×192 / 32×32 格（6px 格宽）');
{
  const { image, small, gw, gh } = makePixelArt(32, 32, 6, 6, 11);
  for (const sample of ['center', 'median', 'majority']) {
    const r = analyze(image, { sample });
    check(`[${sample}] 输出 32×32`, r.outW === 32 && r.outH === 32, `got ${r.outW}×${r.outH}`);
    if (sample !== 'center') {
      check(`[${sample}] 颜色完全还原`, maxColorError(r.image, { data: small, width: gw, height: gh }) === 0);
    }
  }
}

console.log('\n# 3. 192×192 / 96×96 格（2px 格宽，上游 min_size=4 会失败）');
{
  const { image, small, gw, gh } = makePixelArt(96, 96, 2, 2, 5);
  const r = analyze(image, { sample: 'majority' });
  console.log(`   detected ${r.outW}×${r.outH}  cell=${r.cellW.toFixed(2)}  method=${r.method}`);
  check('输出 96×96（±1）', near(r.outW, 96) && near(r.outH, 96), `got ${r.outW}×${r.outH}`);
  const err = maxColorError(r.image, { data: small, width: gw, height: gh });
  check('2px 细格颜色还原误差 <= 8', err <= 8, `err=${err}`);
}

console.log('\n# 4. 192×128 / 24×16 格（非正方形图）');
{
  const { image } = makePixelArt(24, 16, 8, 8, 21);
  const r = analyze(image);
  check('输出 24×16', r.outW === 24 && r.outH === 16, `got ${r.outW}×${r.outH}`);
  check('横纵格宽都≈8', near(r.cellW, 8, 0.5) && near(r.cellH, 8, 0.5), `${r.cellW}/${r.cellH}`);
}

console.log('\n# 5. 192×192 / 32×24 格（矩形格 6×8）');
{
  const { image } = makePixelArt(32, 24, 6, 8, 33);
  const r = analyze(image);
  check('输出 32×24', r.outW === 32 && r.outH === 24, `got ${r.outW}×${r.outH}`);
}

console.log('\n# 6. 模糊 + 噪声（模拟 AI 生成的非整数像素）');
{
  const { image, small, gw, gh } = makePixelArt(32, 32, 6, 6, 9);
  const soft = soften(image, 6, 17);
  const ref = { data: small, width: gw, height: gh };
  const errs = {};
  for (const sample of ['center', 'core', 'median', 'majority']) {
    const r = analyze(soft, { sample });
    errs[sample] = maxColorError(r.image, ref);
    console.log(`   [${sample}] ${r.outW}×${r.outH} cell=${r.cellW.toFixed(2)} conf=${r.confidence.toFixed(2)} err=${errs[sample]}`);
    check(`[${sample}] 格数 32×32（±1）`, near(r.outW, 32) && near(r.outH, 32), `got ${r.outW}×${r.outH}`);
  }
  check('core 误差 <= 24（默认采样）', errs.core <= 24, `err=${errs.core}`);
  check('center 误差 <= 24', errs.center <= 24, `err=${errs.center}`);
}

console.log('\n# 7. 手动指定格数优先于自动估计');
{
  const { image } = makePixelArt(32, 32, 6, 6, 4);
  const r = analyze(image, { gridW: 16, gridH: 16 });
  check('manual 生效为 16×16', r.outW === 16 && r.outH === 16, `got ${r.outW}×${r.outH}`);
  check('method=manual', r.method === 'manual');
}

console.log('\n# 8. 放大到 192（像素完美整数倍）');
{
  const { image } = makePixelArt(32, 32, 6, 6, 4);
  const r = analyze(image);
  const up = scaleToSquare(r.image, 192);
  check('32→192 得到 6 倍整数放大', up.factor === 6 && up.exact === true, `f=${up.factor}`);
  check('放大后尺寸 192×192', up.image.width === 192 && up.image.height === 192);
  // 像素完美校验：放大后每个 6×6 块内颜色一致
  let uniform = true;
  const { data } = up.image;
  for (let by = 0; by < 192 && uniform; by += 6) {
    for (let bx = 0; bx < 192 && uniform; bx += 6) {
      const p0 = (by * 192 + bx) * 4;
      for (let dy = 0; dy < 6 && uniform; dy++) {
        for (let dx = 0; dx < 6 && uniform; dx++) {
          const p = ((by + dy) * 192 + bx + dx) * 4;
          if (data[p] !== data[p0] || data[p + 1] !== data[p0 + 1] || data[p + 2] !== data[p0 + 2]) uniform = false;
        }
      }
    }
  }
  check('每个 6×6 像素块内部纯色（无插值）', uniform);
}

console.log('\n# 9. 24×24 → 192 非整数倍时退回最近邻但不崩');
{
  const { image } = makePixelArt(24, 24, 8, 8, 2);
  const r = analyze(image);
  const up = scaleToSquare(r.image, 192);
  check('24→192 = 8 倍整数', up.factor === 8 && up.exact, `f=${up.factor}`);
}

console.log('\n# 10. 全透明 / 单色等退化输入不应抛异常');
{
  const flat = { data: new Uint8ClampedArray(192 * 192 * 4), width: 192, height: 192 };
  let threw = null;
  let r = null;
  try {
    r = analyze(flat);
  } catch (e) {
    threw = e;
  }
  check('纯色图不抛异常', !threw, threw && threw.message);
  check('纯色图输出合法尺寸', r && r.outW > 0 && r.outH > 0, r && `${r.outW}×${r.outH}`);
}

console.log('\n# 11. 限色 16/32/64');
{
  const { image, small, gw, gh } = makePixelArt(32, 32, 6, 6, 9);
  const soft = soften(image, 6, 17);
  const base = analyze(soft, { sample: 'core' });
  check('未限色时颜色数 > 16（确实需要减色）', base.colorsAfter > 16, `got ${base.colorsAfter}`);
  for (const n of [16, 32, 64]) {
    const r = analyze(soft, { sample: 'core', colors: n });
    check(`限 ${n} 色：结果色数 <= ${n}`, r.colorsAfter <= n, `got ${r.colorsAfter}`);
    check(`限 ${n} 色：调色板条数 <= ${n}`, (r.palette || []).length <= n, `got ${(r.palette || []).length}`);
    check(`限 ${n} 色：格数不变`, r.outW === base.outW && r.outH === base.outH);
  }
  const r16 = analyze(soft, { sample: 'core', colors: 16 });
  const err = maxColorError(r16.image, { data: small, width: gw, height: gh });
  check('限 16 色后仍贴近原始 16 色调色板（误差 <= 24）', err <= 24, `err=${err}`);
}
{
  const img = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  const rand = rng(3);
  for (let i = 0; i < 16; i++) {
    const p = i * 4;
    img.data[p] = rand() * 255;
    img.data[p + 1] = rand() * 255;
    img.data[p + 2] = rand() * 255;
    img.data[p + 3] = i % 2 ? 255 : 0;
  }
  const a = quantize(img, 4);
  const b = quantize(img, 4);
  check('限色是确定性的（两次输出完全相同）', a.image.data.every((v, i) => v === b.image.data[i]));
  let alphaKept = true;
  for (let i = 0; i < 16; i++) {
    if ((img.data[i * 4 + 3] === 0) !== (a.image.data[i * 4 + 3] === 0)) alphaKept = false;
  }
  check('透明像素保持透明', alphaKept);
  check('限 4 色：实际色数 <= 4', countColors(a.image) <= 4, `got ${countColors(a.image)}`);
}
{
  const { image } = makePixelArt(16, 16, 12, 12, 5);
  const off = analyze(image, {});
  const zero = analyze(image, { colors: 0 });
  check('colors=0 等同于不限色', off.colorsAfter === zero.colorsAfter);
  const keep = analyze(image, { colors: 64 });
  check('原色数已少于上限时不减色', keep.colorsAfter === keep.colorsBefore, `${keep.colorsBefore}->${keep.colorsAfter}`);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (fail) {
  console.log(fails.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
