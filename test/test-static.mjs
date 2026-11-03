/**
 * 静态一致性检查（没有浏览器可用时的替代验证）：
 *  - app.js 里引用的每个 #id 都必须在 app.html 中存在
 *  - app.html 里的每个 id 至少被 app.js 引用一次（避免死代码/拼写错误）
 *  - manifest 里声明的文件必须存在
 *  - app.js / core.js 里 import 的符号必须在 core.js 中导出
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : extra}`);
  if (!ok) fail++;
};

const html = read('app.html');
const js = read('app.js');
const core = read('core.js');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((m) => m[1]));

console.log('\n# DOM id 一致性');
for (const id of jsIds) check(`app.js 引用 #${id} 存在于 app.html`, htmlIds.has(id));
const STRUCT_ONLY = new Set(['diag']); // 纯样式钩子，不需要 JS 引用
for (const id of htmlIds) {
  if (STRUCT_ONLY.has(id)) continue;
  check(`app.html 的 #${id} 被 app.js 使用`, jsIds.has(id));
}

console.log('\n# core.js 导出完整性');
const exportsCore = new Set(
  [...core.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
);
for (const m of core.matchAll(/export\s+const\s+([A-Za-z0-9_]+)/g)) exportsCore.add(m[1]);
const imported = [...js.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/core\.js['"]/g)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]))
  .filter(Boolean);
for (const name of imported) check(`app.js 导入的 ${name} 已导出`, exportsCore.has(name));

console.log('\n# manifest');
const manifest = JSON.parse(read('manifest.json'));
check('manifest_version = 3', manifest.manifest_version === 3);
for (const [k, v] of Object.entries({ ...(manifest.icons || {}), ...(manifest.action?.default_icon || {}) })) {
  check(`图标 ${k} (${v}) 存在`, existsSync(join(root, v)), v);
}
check('service_worker 存在', existsSync(join(root, manifest.background.service_worker)));
check('无 v2 遗留字段 (browser_action)', !('browser_action' in manifest));
check('未声明 content_scripts（本扩展不需要注入）', !('content_scripts' in manifest));

console.log('\n# HTML 结构');
check('使用 <script type="module">', /<script type="module" src="app\.js">/.test(html));
check('无内联 <script> 代码（MV3 CSP）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html));
check('引用了 app.css', html.includes('href="app.css"'));
check('所有 input 都有 id 或 name', !/<input(?![^>]*\bid=)[^>]*>/.test(html));

console.log(`\n===== ${fail ? `${fail} 项未通过` : '全部通过'} =====`);
process.exit(fail ? 1 : 0);
