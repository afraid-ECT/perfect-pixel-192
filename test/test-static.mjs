/**
 * 静态一致性检查（没有浏览器可用时的替代验证）：
 *  - 工作区入口及其子页面依赖都应存在
 *  - app.js 和两个编辑器页面的 DOM id 应双向一致
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

const js = read('app.js');
const core = read('core.js');
const jsIds = new Set([...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((m) => m[1]));

const editors = ['workspace-app.html', 'workspace-scene.html'];
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/;
const structureOnly = new Set(['diag']);
for (const file of editors) {
  console.log(`\n# ${file}`);
  const html = read(file);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const htmlIds = new Set(ids);
  check('DOM id 唯一', ids.length === htmlIds.size);
  for (const id of jsIds) check(`app.js 引用的 #${id} 存在`, htmlIds.has(id));
  for (const id of htmlIds) {
    if (!structureOnly.has(id)) check(`#${id} 被 app.js 使用`, jsIds.has(id));
  }
  check('模块入口 app.js', /<script type="module" src="app\.js">/.test(html));
  check('无内联脚本（MV3 CSP）', !inlineScript.test(html));
  check('引用了 app.css', html.includes('href="app.css"'));
  check('所有 input 都有 id 或 name', !/<input\b(?![^>]*\b(?:id|name)=)[^>]*>/.test(html));
  for (const [, dependency] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    check(`依赖 ${dependency} 存在`, existsSync(join(root, dependency)));
  }
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

console.log('\n# 工作区入口');
for (const [entry, pages] of [['app.html', editors], ['demo.html', ['workspace-demo.html', 'workspace-scene-demo.html']]]) {
  const html = read(entry);
  check(`${entry} 加载工作区脚本`, html.includes('src="workspace.js"') && existsSync(join(root, 'workspace.js')));
  check(`${entry} 加载外壳样式`, html.includes('href="workspace.css"') && existsSync(join(root, 'workspace.css')));
  check(`${entry} 无内联脚本`, !inlineScript.test(html));
  for (const [i, attr] of ['data-object', 'data-scene'].entries()) {
    const page = pages[i];
    check(`${entry} 载入 ${page}`, html.includes(`${attr}="${page}"`) && existsSync(join(root, page)));
  }
}

console.log(`\n===== ${fail ? `${fail} 项未通过` : '全部通过'} =====`);
process.exit(fail ? 1 : 0);
