import assert from 'node:assert/strict';
import { analyze } from '../core.js';

const width = 120;
const height = 112;
const data = new Uint8ClampedArray(width * height * 4);
let seed = 7;
const colors = Array.from({length: 10 * 14}, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return [seed >>> 24, (seed >>> 16) & 255, (seed >>> 8) & 255, 255];
});
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    data.set(colors[Math.floor(y / 8) * 10 + Math.floor(x / 12)], (y * width + x) * 4);
  }
}
const img = {width, height, data};

const original = analyze(img, {forceGrid: false});
assert.deepEqual([original.gridW, original.gridH], [10, 14]);

const automatic = analyze(img, {forceGrid: true});
assert.deepEqual([automatic.gridW, automatic.gridH], [15, 14]);
assert.deepEqual([automatic.cellW, automatic.cellH], [8, 8]);
assert.deepEqual([automatic.xs[0], automatic.ys[0], automatic.xs.at(-1), automatic.ys.at(-1)], [0, 0, width, height]);

const manual = analyze(img, {forceGrid: true, gridW: 10, gridH: 14});
assert.deepEqual([manual.gridW, manual.gridH], [10, 14]);
assert.deepEqual([manual.cellW, manual.cellH], [12, 8]);

const clipped = {width: 80, height: 111, data: new Uint8ClampedArray(80 * 111 * 4)};
for (let y = 0; y < clipped.height; y++) {
  for (let x = 0; x < clipped.width; x++) {
    clipped.data.set(colors[Math.floor(y / 8) * 10 + Math.floor(x / 8)], (y * clipped.width + x) * 4);
  }
}
const edges = analyze(clipped, {forceGrid: true});
assert.deepEqual([edges.gridW, edges.gridH], [10, 14]);
const squared = analyze(img, {gridW: 10, gridH: 11, forceGrid: false, fixSquare: true});
assert.deepEqual([squared.outW, squared.outH, squared.squared], [10, 10, true]);
const evenlySpaced = analyze(img, {gridW: 10, gridH: 11, forceGrid: true, fixSquare: true});
assert.deepEqual([evenlySpaced.outW, evenlySpaced.outH, evenlySpaced.squared], [10, 11, false]);
console.log('PASS: automatic equal spacing uses the finer common cell size, manual counts remain exact');
