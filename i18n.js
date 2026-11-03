const messages = {
  "Perfect Pixel 192 — 完美像素还原": "Perfect Pixel 192 — Pixel art editor",
  "识别格宽 · 纯色还原 · 无插值放大": "Detect grids · Sample colors · Scale with nearest neighbor",
  "192px 原生支持": "192 px support",
  "2px 细格可识别": "Detects 2 px cells",
  "扩展环境": "Extension mode",
  "载入示例": "Load demo",
  "选择图片": "Open image",
  "撤销上一步": "Undo settings",
  "拖入图片 / 按 Ctrl+V 粘贴 / 从网页右键菜单导入": "Drop an image, paste with Ctrl+V, or import from the browser context menu",
  "建议先试一张 192×192 的 AI 像素图或缩略图": "Try a 192×192 sprite or thumbnail",
  "处理中…": "Processing…",
  "处理结果占比": "Result preview",
  "网格": "Grid",
  "▱ 图层": "▱ Layers",
  "适应": "Fit",
  "＋ 新建图层": "＋ New layer",
  "自动检测": "Auto detect",
  "手动指定": "Manual",
  "横向格数": "Columns",
  "纵向格数": "Rows",
  "精修强度": "Refinement",
  "近似正方形时强制对齐（上游 fix_square）": "Square up nearly square grids",
  "强制对齐到等距网格": "Lock to an evenly spaced grid",
  "大图精校 · 上限 2048 格": "High precision · up to 2048 cells",
  "这里填写采样格数。要导出 192×224 的 4×4 色块，请填 48×56，并在「输出与导出」选择 192×224。": "Set the sampling grid here. For 4×4 blocks in a 192×224 PNG, enter 48×56 and select 192×224 under Export size.",
  "重新检测": "Detect again",
  "采样方式一": "First sampling pass",
  "轮廓优先（格内众数 + 外侧清理）": "Outline priority (cell majority + edge cleanup)",
  "中心裁剪均值（推荐 / 抗软边）": "Center crop average (soft-edge reduction)",
  "★ 强劲模式：单像素中心 + 32 色 + 清轮廓外侧": "Strong: center pixel, up to 32 colors, outline cleanup",
  "区域吸附去 AA（描边整体发灰时更狠）": "Region snap (reduce anti-aliasing)",
  "单像素中心（最锐利，不去噪）": "Center pixel (sharp, no denoising)",
  "直方图众数（抗噪）": "Histogram majority",
  "中位数（上游原版）": "Median",
  "采样方式二": "Second sampling pass",
  "无": "None",
  "第二次处理第一次的采样结果，保持相同的像素宽高。": "The second pass processes the first result at the same pixel dimensions.",
  "只平均格子中央 50% 区域，避开 AI/JPEG 产生的软边混色环。": "Average the middle 50% of each cell to reduce blended edge colors.",
  "背景与主体": "Background and subject",
  "自动识别（边缘连通背景）": "Auto: edge-connected background",
  "手动保留套索内的主体": "Manual: keep the subject inside the lasso",
  "一键清除背景": "Remove background",
  "画笔与选区": "Brush and selection",
  "透明度": "Transparency",
  "取消选区": "Clear selection",
  "Alt + 左键吸取像素颜色，左键拖动上色。套索闭合后只在选区内绘制。套索模式下单击取消选区，靠近视图边缘自动平移。右键擦除，中键拖动画布，Ctrl+Z 仅撤销画布绘制或选区操作。": "Alt-click to pick a color. Drag to paint inside the selection. In lasso mode, click to clear or drag near the edge to pan. Right-drag to erase, middle-drag to pan. Ctrl+Z undoes canvas edits.",
  "颜色数": "Palette size",
  "不限": "Unlimited",
  "不限色时保留采样得到的全部颜色；限制后会做中位切分合并相近色。": "Keep sampled colors or set a limit to merge similar colors.",
  "编辑采样色": "Edit sampled color",
  "原：原采样色　当：当前编辑色　配：可选配色": "O: Original · C: Current · H: Harmony",
  "颜色": "Color",
  "明暗调整": "Lightness",
  "不透明度": "Opacity",
  "配色": "Harmony",
  "邻近色": "Analogous",
  "三角色": "Triadic",
  "四角色（正方形）": "Tetradic (square)",
  "应用": "Apply",
  "取消": "Cancel",
  "恢复此采样色": "Reset sampled color",
  "点击采样色编辑，右键复制色值。": "Click a swatch to edit it. Right-click to copy its hex value.",
  "输出与导出": "Output and export",
  "目标尺寸": "Export size",
  "1× 原格（无放大）": "1× sampling grid",
  "与原图同尺寸": "Match input dimensions",
  "192 × 224（竖版）": "192 × 224 (portrait)",
  "导出 PNG": "Export PNG",
  "复制到剪贴板": "Copy to clipboard",
  "诊断": "Diagnostics",
  "输入": "Input",
  "检测格数": "Grid dimensions",
  "单格尺寸": "Cell size",
  "估计方法": "Detection method",
  "置信度": "Confidence",
  "耗时": "Elapsed time",
  "输出": "Output",
  "从 URL 导入": "Import from URL",
  "读取": "Load",
  "跨域图片需要该站点允许读取，否则请改用拖拽或粘贴。": "The site must allow cross-origin image access. Otherwise, drop or paste the image.",
  "Perfect Pixel 192 — 完美像素还原（单文件版）": "Perfect Pixel 192 — Standalone editor",
  "画布": "Canvases",
  "撤销设置或图层操作": "Undo settings or layer changes",
  "图层": "Layers",
  "缩小": "Zoom out",
  "放大": "Zoom in",
  "锁定网格宽高比": "Lock grid aspect ratio",
  "锁定当前网格宽高比": "Lock the current grid aspect ratio",
  "按当前格数缩放": "Scale the current grid",
  "左键工具": "Left mouse tools",
  "像素画笔": "Pixel brush",
  "自由套索": "Freehand lasso",
  "油漆桶": "Paint bucket",
  "油漆桶：点击画布填充连通同色区域": "Paint bucket: fill a connected region of the same color",
  "沿色环点击或拖动选择色相": "Click or drag around the wheel to select a hue",
  "块边界一致性": "Block boundary consistency",
  "FFT 自相关": "FFT autocorrelation",
  "梯度峰间隔": "Gradient peak spacing",
  "梳状搜索": "Comb search",
  "正方形推断": "Square-grid estimate",
  "退化回退": "Fallback",
  "格内众数取色，先清理与画布边缘连通的背景，再限色。适合简单背景的单角色。": "Use the most common color per cell, clean edge-connected background, then limit colors.",
  "单像素中心取色（最锐利，1px 描边不会被平均掉）→ 限到 32 色 → 去掉孤点 → 把轮廓外侧的混色环并进背景、背景刷平。适合出成品图。": "Sample each center pixel, limit the palette, remove speckles and clean the outer edge. Defaults to 32 colors.",
  "中心加权众数取色 + 只保留\"占面积的纯色区域\"建调色板，再把每格吸附过去。描边整体发灰时用它，但颜色会比强劲模式少。": "Build a palette from solid regions and snap each cell to it. Useful for gray halos around outlines.",
  "直接取格子正中心那一个像素，边缘最锐利，但更容易被噪点带偏。": "Use the pixel at the center of each cell. Preserves sharp edges but can pick up noise.",
  "格内颜色直方图取众数（32 级分桶），对噪声与轻微网格偏移更稳。": "Use a binned color histogram to reduce sensitivity to noise and slight grid offsets.",
  "逐通道取中位数，即上游 perfectPixel 的默认行为。": "Take the median of each color channel.",
  "画布 {0}": "Canvas {0}",
  "关闭画布 {0}": "Close canvas {0}",
  "采样层": "Sampled image",
  "图层 {0}": "Layer {0}",
  "隐藏图层": "Hide layer",
  "显示图层": "Show layer",
  "选择图层": "Select layer",
  "提高优先级": "Move up",
  "降低优先级": "Move down",
  "删除采样层": "Delete sampled image",
  "删除图层 {0}": "Delete layer {0}",
  "载入失败：{0}": "Could not load image: {0}",
  "处理失败：{0}": "Processing failed: {0}",
  "无法解析这张图片": "Unable to decode the image",
  "横向和纵向格数必须是 1 到 {0} 的整数。": "Columns and rows must be integers from 1 to {0}.",
  "画笔 {0}": "Brush {0}",
  "擦除（完全透明）": "Erase (fully transparent)",
  "当前图层已隐藏，请先显示它。": "Show the active layer before removing its background.",
  "请用左键圈住主体，再清除背景。": "Draw a lasso around the subject, then remove the background.",
  "已清除 {0} 格，可撤销。": "Cleared {0} cells. Press Ctrl+Z to undo.",
  "原采样色 {0}": "Original {0}",
  "当前编辑色 {0}": "Current {0}",
  "配色 {0}": "Harmony {0}",
  "原": "O",
  "当": "C",
  "配": "H",
  "{0} · {1} 格": "{0} · {1} cells",
  "强劲模式默认 32 色，当前 {0} 色（可在上面改 8/16/64）。": "Strong defaults to 32 colors; the result has {0}. Choose another limit above.",
  "区域吸附自动收敛到 {0} 个主色。": "Region snap produced {0} main colors.",
  "输出共 {0} 色（未限色，可继续调低）。": "Output has {0} colors (unlimited).",
  "采样后本来就只有 {0} 色，未超过 {1}，无需减色。": "Sampling produced {0} colors, within the limit of {1}.",
  "采样后 {0} 色 → 限制到 {1} 色，实际 {2} 色（中位切分）。": "Sampled {0} colors. Limit: {1}. Result: {2}.",
  "已复制 {0}": "Copied {0}",
  "复制失败：{0}": "Could not copy {0}",
  "点色块可复制十六进制值。": "Right-click a swatch to copy its hex value.",
  "{0} 格": "{0} cells",
  "—（手动指定）": "— (manual)",
  "{0} 色": "{0} colors",
  "置信度偏低：这张图可能不是像素画，或网格不规则。可以手动指定格数再试。": "Low confidence. Try setting the grid dimensions manually.",
  "横向格宽是 {0}px，不是整数：右侧最后一格会略窄，属正常现象。": "Cell width is {0} px. Fractional widths can produce uneven pixel coverage.",
  "检测到近似正方形，已按 fix_square 规则补齐对齐。": "A nearly square grid was adjusted to a square.",
  "指定格数超过输入像素数，采样无法增加细节。若要放大，请调整导出尺寸。": "The grid exceeds the input resolution. Use Export size to enlarge the result.",
  "手动网格与输入尺寸相同，每个输入像素对应一格。": "The manual grid matches the input: one input pixel per cell.",
  "自动检测未找到稳定的网格周期，已使用回退格数。": "No stable grid period was found. Using fallback dimensions.",
  "自动检测到细网格，每格约 {0} × {1} px。": "Detected a fine grid of about {0} × {1} px per cell.",
  "强劲模式：已把轮廓外侧 {0} 格混色/杂点并进背景，并刷平背景。": "Strong merged {0} edge cells into the background.",
  "强劲模式：另去除 {0} 个孤立杂点。": "Strong removed {0} isolated speckles.",
  "{0} → {1}，{2} 倍最近邻放大：每个像素块内部纯色，无插值。": "{0} → {1}, {2}× nearest-neighbor scaling.",
  "{0} → {1} 不是整数倍，会按最近邻取整，个别像素会不均匀。": "{0} → {1}: scaling is not a uniform integer multiple. Blocks may have uneven dimensions.",
  "已复制 ✓": "Copied ✓",
  "复制失败": "Copy failed",
  "请先将横纵格数调至 512 以内，再关闭大图精校。": "Reduce both dimensions to 512 or less before turning off high precision.",
  "右键擦除 · 中键拖动平移 · 滚轮缩放 · 点击「适应」复位": "Right-drag to erase · Middle-drag to pan · Scroll to zoom · Fit to reset",
  "读取中…": "Loading…",
  "不是图片内容": "The response is not an image",
  "已读取。": "Image loaded.",
  "读取失败：{0}（该站点未开放跨域读取，请改用拖拽或截图粘贴）": "Could not load: {0}. Try dropping or pasting the image instead."
};

const templates = Object.entries(messages)
  .filter(([source]) => source.includes('{0}'))
  .sort(([a], [b]) => b.length - a.length)
  .map(([source, english]) => {
    const parts = source.split(/\{\d+\}/);
    const escaped = parts.map(part => Array.from(part, char =>
      '.*+?^$${}()|[]\\'.includes(char) ? '\\' + char : char).join(''));
    return [new RegExp('^' + escaped.join('(.+?)') + '$'), english];
  });

function englishText(source) {
  if (Object.hasOwn(messages, source)) return messages[source];
  for (const [pattern, translated] of templates) {
    const match = source.match(pattern);
    if (match) return translated.replace(/\{(\d+)\}/g, (_, n) => messages[match[Number(n)+1]] || match[Number(n)+1]);
  }
  return source;
}

// Localize presentation nodes only. Canvas buffers, inputs and undo history stay intact.
export function initializeLanguage(button) {
  const key = 'perfect-pixel-language';
  let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'zh' || saved === 'en') language = saved;
  } catch {}
  const originals = new WeakMap();
  const attrs = ['title','aria-label','placeholder'];
  function localize(node, attr = '') {
    const value = attr ? node.getAttribute(attr) : node.nodeValue;
    if (!value) return;
    const cache = originals.get(node) || {};
    const previous = cache[attr];
    const source = previous?.display === value ? previous.source : value;
    if (!/[\u3400-\u9fff]/.test(source)) return;
    const display = language === 'en' ? source.replace(/\S(?:[\s\S]*\S)?/, text => englishText(text)) : source;
    cache[attr] = {source, display};
    originals.set(node, cache);
    if (display !== value) {
      if (attr) node.setAttribute(attr, display);
      else node.nodeValue = display;
    }
  }
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) { localize(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT','STYLE'].includes(node.tagName)) return;
    for (const attr of attrs) if (node.hasAttribute(attr)) localize(node, attr);
    for (const child of node.childNodes) visit(child);
  }
  function refresh() {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    visit(document.querySelector('title'));
    visit(document.body);
    button.textContent = language === 'zh' ? 'English' : '中文';
    button.lang = language === 'zh' ? 'en' : 'zh-CN';
  }
  button.onclick = () => {
    language = language === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(key, language); } catch {}
    refresh();
  };
  refresh();
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') for (const child of record.addedNodes) visit(child);
      else if (record.type === 'attributes') localize(record.target, record.attributeName);
      else localize(record.target);
    }
  });
  observer.observe(document.body, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attrs});
}
