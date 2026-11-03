/**
 * 生成 demo.html：把 core.js + app.js + app.css 合成单文件，
 * 用普通 <script>（非 module）加载，这样 file:// 双击也能跑（module 会被 CORS 拦）。
 *
 * 用法: node tools/build-standalone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const core = read('core.js')
  .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const locale = read('i18n.js').replace(/^export /gm, '');
const app = read('app.js').replace(/^import .*? from ['"]\.\/i18n\.js['"];?$/m, '').replace(/^import\s*\{[^}]*\}\s*from\s*['"]\.\/core\.js['"];?\s*$/m, '');

const css = read('app.css');
const html = read('app.html');
const noModule = html
  .replace('<script type="module" src="app.js"></script>', '__BUNDLE__')
  .replace('<link rel="stylesheet" href="app.css" />', `<style>\n${css}\n</style>`)
  .replace('<title>Perfect Pixel 192 — 完美像素还原</title>', '<title>Perfect Pixel 192 — 完美像素还原（单文件版）</title>');

const bundle = `(() => {\n"use strict";\n\n/* ============ core.js ============ */\n${core}\n\n${locale}\n\n/* ============ app.js ============ */\n${app}\n})();`;

const out = noModule.replace('__BUNDLE__', () => `<script>\n${bundle}\n</script>`);
writeFileSync(join(root, 'demo.html'), out, 'utf8');

// 供 node --check 校验语法
mkdirSync(join(root, '.build'), { recursive: true });
writeFileSync(join(root, '.build', 'bundle.js'), `"use strict";\n${core}\n${app}\n`, 'utf8');

console.log('demo.html bytes:', out.length);
console.log('bundle lines:', bundle.split('\n').length);
