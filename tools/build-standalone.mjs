/**
 * 生成可直接双击的单文件版。
 *
 * 现在的结构（重构后）：
 *   demo.html                 标签页外壳，用 iframe 载入下面两个
 *   workspace-demo.html       ← workspace-app.html   内联后
 *   workspace-scene-demo.html ← workspace-scene.html 内联后
 *
 * 每个页面内联：app.css / sampling-tabs.css / core.js / i18n.js / app.js / sampling-tabs.js
 * 用普通 <script>（非 module），这样 file:// 双击也能跑（module 会被 CORS 拦）。
 *
 * 用法: node tools/build-standalone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/* ---- 把 ESM 改成普通脚本可用的形式 ---- */
const core = read('core.js')
  .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const locale = read('i18n.js')
  .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const app = read('app.js')
  .replace(/^import .*? from ['"]\.\/i18n\.js['"];?$/m, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*['"]\.\/core\.js['"];?\s*$/m, '');

const tabs = read('sampling-tabs.js');
const cssApp = read('app.css');
const cssTabs = read('sampling-tabs.css');

const bundle = `(() => {\n"use strict";\n\n/* ============ core.js ============ */\n${core}\n\n/* ============ i18n.js ============ */\n${locale}\n\n/* ============ app.js ============ */\n${app}\n\n/* ============ sampling-tabs.js ============ */\n${tabs}\n})();`;

/* ---- 把一个 workspace 页面内联成单文件 ---- */
function inline(srcName, outName, title) {
  let html = read(srcName);
  html = html
    .replace('<link rel="stylesheet" href="app.css" />', `<style>\n${cssApp}\n</style>`)
    .replace('<link rel="stylesheet" href="sampling-tabs.css">', `<style>\n${cssTabs}\n</style>`)
    .replace('<script type="module" src="app.js"></script>', '__BUNDLE__')
    .replace('<script src="sampling-tabs.js"></script>', '')
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  if (!html.includes('__BUNDLE__')) throw new Error(`${srcName}: 找不到 app.js 的 script 标签`);
  html = html.replace('__BUNDLE__', () => `<script>\n${bundle}\n</script>`);
  writeFileSync(join(root, outName), html, 'utf8');
  return html.length;
}

const a = inline('workspace-app.html', 'workspace-demo.html', 'Perfect Pixel 192 — 完美像素还原（单文件版）');
const s = inline('workspace-scene.html', 'workspace-scene-demo.html', 'Perfect Pixel 192 — 整图采样（单文件版）');

// demo.html：标签页外壳，但 iframe 要指向"内联后的"那两份，
// 不能指向 workspace-app.html / workspace-scene.html（它们是 module，file:// 下会被 CORS 拦）。
let shell = read('app.html')
  .replace('data-object="workspace-app.html"', 'data-object="workspace-demo.html"')
  .replace('data-scene="workspace-scene.html"', 'data-scene="workspace-scene-demo.html"');
if (!shell.includes('workspace-demo.html') || !shell.includes('workspace-scene-demo.html')) {
  throw new Error('demo.html 外壳：没找到 workspace-app.html / workspace-scene.html 的引用');
}
writeFileSync(join(root, 'demo.html'), shell, 'utf8');

mkdirSync(join(root, '.build'), { recursive: true });
writeFileSync(join(root, '.build', 'bundle.js'), `"use strict";\n${core}\n${app}\n`, 'utf8');

console.log('demo.html                 ', shell.length, 'bytes');
console.log('workspace-demo.html      ', a, 'bytes');
console.log('workspace-scene-demo.html', s, 'bytes');
console.log('bundle lines             ', bundle.split('\n').length);
