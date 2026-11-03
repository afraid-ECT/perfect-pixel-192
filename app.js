/* Perfect Pixel 192 — editor UI */

import { analyze, countColors, scaleNearest } from './core.js';

const $ = (sel) => document.querySelector(sel);

const isExt = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

const METHOD_LABEL = {
  'block-boundary': '块边界一致性',
  'fft-autocorr': 'FFT 自相关',
  'gradient-interval': '梯度峰间隔',
  comb: '梳状搜索',
  'square-guess': '正方形推断',
  fallback: '退化回退',
  manual: '手动指定',
};

const SAMPLE_HINT = {
  outline: '格内众数取色，先清理与画布边缘连通的背景，再限色。适合简单背景的单角色。',
  core: '只平均格子中央 50% 区域，避开 AI/JPEG 产生的软边混色环。',
  strong: '单像素中心取色（最锐利，1px 描边不会被平均掉）→ 限到 32 色 → 去掉孤点 → 把轮廓外侧的混色环并进背景、背景刷平。适合出成品图。',
  region: '中心加权众数取色 + 只保留"占面积的纯色区域"建调色板，再把每格吸附过去。描边整体发灰时用它，但颜色会比强劲模式少。',
  center: '直接取格子正中心那一个像素，边缘最锐利，但更容易被噪点带偏。',
  majority: '格内颜色直方图取众数（32 级分桶），对噪声与轻微网格偏移更稳。',
  median: '逐通道取中位数，即上游 perfectPixel 的默认行为。',
};

const state = {
  bitmap: null,
  src: null,
  res: null,
  key: 0,
  opts: { largeGrid:false, gridRatio:1, forceGrid:true, sample2: '', sample: 'center', refine: 0.25, fixSquare: true, colors: 0, gridW: 0, gridH: 0, minCell: 2, maxCell: 64 },
  mode: 'auto',
  wipe: 100,
  panX:0, panY:0, zoom: 1,
  fit: 1,
  grid: true,
  target: '192',
  disp: { w: 0, h: 0 },
};

let resultKey = -1;

/* --------------------------------------------------------------- 示例 */

const DEMO_PAL = [
  [26, 28, 44], [93, 39, 93], [177, 62, 83], [239, 125, 87],
  [255, 205, 117], [167, 240, 112], [56, 183, 100], [37, 113, 121],
  [41, 54, 111], [59, 93, 201], [65, 166, 246], [115, 239, 247],
  [244, 244, 244], [148, 176, 194], [86, 108, 134], [51, 60, 87],
];

/** 造一张 192×192、32×32 格的"AI 味"像素图：同心环 + 抖动 + 1px 软边。 */
function makeDemo() {
  const GW = 32;
  const CELL = 6;
  const W = GW * CELL;
  let seed = 20260401;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = W;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, W);
  const d = img.data;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - W / 2 + 0.5;
      const dy = y - W / 2 + 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const k = Math.floor(r / 5.2 + Math.sin(ang * 3) * 0.6 + rnd() * 0.75) & 15;
      const col = DEMO_PAL[k];
      const p = (y * W + x) * 4;
      d[p] = col[0];
      d[p + 1] = col[1];
      d[p + 2] = col[2];
      d[p + 3] = 255;
    }
  }
  // 1px 盒式模糊 + 轻微噪声，模拟 AI 生成 / JPEG 压缩后的软边
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let k = -1; k <= 1; k++) {
        for (let j = -1; j <= 1; j++) {
          const yy = Math.min(W - 1, Math.max(0, y + k));
          const xx = Math.min(W - 1, Math.max(0, x + j));
          const p = (yy * W + xx) * 4;
          r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
        }
      }
      const p = (y * W + x) * 4;
      const nz = (rnd() * 2 - 1) * 4;
      out[p] = r / n + nz;
      out[p + 1] = g / n + nz;
      out[p + 2] = b / n + nz;
      out[p + 3] = 255;
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
  return c;
}

/* --------------------------------------------------------------- 载入 */

const canvases = [];
let active = null;
let serial = 0;

function settings() {
  return { opts:{...state.opts}, mode:state.mode, target:state.target,
    gw:$('#gridW').value, gh:$('#gridH').value, edits:[...edits], stack, layerId };
}

function remember() {
  if (!active) return;
  const next = settings();
  if (JSON.stringify(next) === JSON.stringify(active.settings)) return;
  active.history.push(active.settings);
  if (active.history.length > 50) active.history.shift();
  active.settings = next;
  drawTabs();
}

function drawTabs() {
  const box = $('#tabs');
  box.replaceChildren();
  for (const tab of canvases) {
    const b = document.createElement('button');
    b.textContent = '画布 ' + tab.id;
    b.title = tab.name;
    b.setAttribute('aria-current', String(tab === active));
    b.onclick = () => activate(tab);
    const group = document.createElement('span');
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '关闭画布 ' + tab.id;
    close.setAttribute('aria-label', close.title);
    close.onclick = () => closeCanvas(tab);
    close.className = "tab-close";
    group.append(b,close);
    box.append(group);
  }
  $('#undo').disabled = !active || (!active.history.length && !active.parent);
}

function updateGridFactors() {
  const dims=[$('#gridW'),$('#gridH')];
  for(const b of $('#gridFactors').children) {
    const target=dims.map(el=>Math.max(1,Math.round(el.valueAsNumber*Number(b.dataset.factor))));
    const valid=dims.every(el=>el.value && el.validity.valid);
    b.disabled=!valid || target.some((n,i)=>n>Number(dims[i].max));
    b.querySelector('small').textContent=valid ? target.join('×') : '—';
  }
}

function activate(tab) {
  if (active) active.view = {panX:state.panX, panY:state.panY, zoom:state.zoom, grid:state.grid, wipe:state.wipe};
  active = tab;
  const q = tab.settings;
  Object.assign(state, tab.view, {bitmap:tab.bitmap, src:tab.src, name:tab.name,
    opts:{...q.opts}, mode:q.mode, target:q.target, res:null});
  base = null;
  layers = tab.strokes; stack=q.stack; layerId=q.layerId; drawLayerList();
  edits.clear();
  for (const [key,value] of q.edits) edits.set(key,value);
  $('#sample').value = q.opts.sample;
  $('#sample2').value = q.opts.sample2;
  $('#sampleHint').textContent = SAMPLE_HINT[q.opts.sample];
  $('#gridLink').setAttribute('aria-pressed',String(!!q.opts.gridRatio));
  syncLargeGrid(q.opts.largeGrid);
  $('#gridW').value = q.gw;
  $('#gridH').value = q.gh;
  updateGridFactors();
  $('#manualBox').hidden = q.mode !== 'manual';
  $('#refine').value = Math.round(q.opts.refine*100);
  $('#refineNum').textContent = $('#refine').value+'%';
  syncForceGrid(q.opts.forceGrid);
  $('#fixSquare').checked = q.opts.fixSquare;
  $('#target').value = q.target;
  $('#showGrid').checked = state.grid;
  $('#wipe').value = state.wipe;
  for (const b of $('#colorSeg').children) b.classList.toggle('on',Number(b.dataset.colors)===q.opts.colors);
  for (const b of $('#modeSeg').children) b.classList.toggle('on',b.dataset.mode===q.mode);
  drawTabs();
  reprocess();
}

function closeCanvas(tab, next = null) {
  const index = canvases.indexOf(tab);
  canvases.splice(index,1);
  for (const child of canvases) if (child.parent === tab) child.parent = tab.parent;
  if (active === tab) {
    const fallback = next || canvases[index] || canvases[index-1];
    if (fallback) activate(fallback);
    else {
      active = base = null;
      Object.assign(state,{src:null,bitmap:null,res:null,name:''});
      edits.clear();
      for (const id of ['cvSrc','cvRes','cvGrid']) $('#'+id).width = 1;
      $('#empty').hidden = false; $('#guideGrid').style.display='none'; drawLayerList();
      $('#palette').replaceChildren();
      $('#notes').replaceChildren();
      for (const el of document.querySelectorAll('dd, #targetHint, #colorHint')) el.textContent = '—';
    }
  }
  tab.bitmap.close?.();
  drawTabs();
}

function undoEdit() {
  if (!active) return;
  if (active.history.length) {
    active.settings = active.history.pop();
    activate(active);
  } else if (active.parent) {
    closeCanvas(active, active.parent);
  }
}

async function loadImage(source, name = '') {
  try {
    const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
    if (!bmp || !bmp.width) throw new Error('无法解析这张图片');
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const src = ctx.getImageData(0, 0, c.width, c.height);
    const tab = {id:++serial, parent:active, history:[], strokes:[], canvasHistory:[], nextLayer:1, bitmap:bmp, src, name,
      settings:{...settings(), edits:[],stack:[{id:0,name:"采样层",visible:true}],layerId:0}, view:{panX:0,panY:0,zoom:1,grid:state.grid,wipe:100}};
    canvases.push(tab);
    activate(tab);
    $('#empty').hidden = true;
    $('#urlHint').textContent = '跨域图片需要该站点允许读取，否则请改用拖拽或粘贴。';
    $('#urlHint').classList.remove('bad');
  } catch (e) {
    setUrlHint(`载入失败：${e.message}`, true);
  }
}

function reprocess() {
  if (!state.src) return;
  if (state.mode === 'manual' && ![$('#gridW'),$('#gridH')].every(el=>el.value && el.validity.valid)) {
    $('#notes').replaceChildren();
    addNote(`横向和纵向格数必须是 1 到 ${$('#gridW').max} 的整数。`,'warn');
    return;
  }
  remember();
  const owner = active;
  const gw = Number($('#gridW').value), gh = Number($('#gridH').value);
  $('#busy').hidden = false;
  // 让 busy 提示先绘制出来，再做同步计算
  requestAnimationFrame(() => {
    try {
      if (active !== owner) return;
      const opts = { ...state.opts };
      if (state.mode === 'manual') {
        opts.gridW = gw;
        opts.gridH = gh;
      } else {
        opts.gridW = 0;
        opts.gridH = 0;
      }
      base = analyze(state.src, opts);
      if (opts.sample2) {
        const first = base;
        const grid = {gridW:first.image.width, gridH:first.image.height, refine:0, fixSquare:false};
        const second = analyze(first.image, {...opts, sample:opts.sample2, ...grid});
        base = {...second, xs:first.xs, ys:first.ys, cellW:first.cellW, cellH:first.cellH,
          gridW:first.gridW, gridH:first.gridH, method:first.method, confidence:first.confidence,
          ms:first.ms+second.ms};
      }
      applyEdits();
      state.key += 1;
      $('#notes').innerHTML = '';
      renderAll();
    } catch (e) {
      console.error(e);
      addNote(`处理失败：${e.message}`, 'bad');
    } finally {
      $('#busy').hidden = true;
    }
  });
}

/* --------------------------------------------------------------- 渲染 */

function measure() {
  const box = $('#dz').getBoundingClientRect();
  const { width: W, height: H } = state.src;
  const availW = Math.max(80, box.width - 26);
  const availH = Math.max(80, box.height - 26);
  state.fit = Math.min(availW / W, availH / H);
  const scale = Math.max(0.04, Math.min(state.fit, 24));
  return {
    w: Math.max(1, Math.round(W * scale)),
    h: Math.max(1, Math.round(H * scale)),
  };
}

function sizeCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function renderAll() {
  if (!state.src) return;
  const { w, h } = measure();
  state.disp = { w, h };

  const srcCtx = sizeCanvas($('#cvSrc'), w, h);
  srcCtx.clearRect(0, 0, w, h);
  srcCtx.drawImage(state.bitmap, 0, 0, w, h);

  const resultCanvas = $('#cvRes');
  resultCanvas.style.width = w+'px';
  resultCanvas.style.height = h+'px';
  if (state.res && resultKey !== state.key) {
    const img = state.res.image;
    resultCanvas.width = img.width;
    resultCanvas.height = img.height;
    resultCanvas.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    resultKey = state.key;
  }

  const gridCtx = sizeCanvas($('#cvGrid'), w, h);
  gridCtx.clearRect(0, 0, w, h);
  const guide = $('#guideGrid');
  guide.style.display = state.grid && state.res ? 'block' : 'none';
  if (state.grid && state.res) {
    const {gridW, gridH} = state.res;
    guide.style.width = w+'px';
    guide.style.height = h+'px';
    const key = gridW+'x'+gridH;
    if (guide.dataset.grid !== key) {
      guide.setAttribute('viewBox', `0 0 ${gridW} ${gridH}`);
      guide.setAttribute('preserveAspectRatio', 'none');
      const lines = [];
      for (let x=0; x<=gridW; x++) lines.push(`M${x} 0V${gridH}`);
      for (let y=0; y<=gridH; y++) lines.push(`M0 ${y}H${gridW}`);
      guide.firstElementChild.setAttribute('d',lines.join(' '));
      guide.dataset.grid = key;
    }
  }

  const img=state.res?.image;
  if(img) {
    const d=drawing;
    gridCtx.save(); gridCtx.scale(w/img.width,h/img.height);
    if(d?.tool==='paint') {
      gridCtx.fillStyle=d.color[3] ? 'rgba('+d.color.slice(0,3).join(',')+','+d.color[3]/255+')' : '#ff5486';
      for(const i of d.pixels) gridCtx.fillRect(i%img.width,Math.floor(i/img.width),1,1);
    }
    const path=d?.tool==='lasso' ? selectionPath(d.points) : selectedPath();
    if(path) { gridCtx.lineWidth=1.5*img.width/w; gridCtx.strokeStyle='#ff477b'; gridCtx.stroke(path); }
    gridCtx.restore();
  }
  applyWipe();
  updateDiag();
  updateColors();
  updateTargetHint();
  positionView();
}

function positionView() {
  const dz = $('#dz');
  dz.style.setProperty('--pan-x',state.panX+'px');
  dz.style.setProperty('--pan-y',state.panY+'px');
  dz.style.setProperty('--zoom',state.zoom);
  $('#zoomLabel').textContent = state.zoom === 1 ? '适应' : `${Math.round(state.zoom * 100)}%`;
}

/* --------------------------------------------------------------- 颜色 */

function hexOf(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

let base, selected, priorEdit;
const edits = new Map();
let layers = [], drawing = null, brushAlpha = 255;

function applyEdits() {
  state.res = base;
  if (!edits.size && !layers.length && stack.length===1 && stack[0].id===0 && stack[0].visible) return;
  const data = new Uint8ClampedArray(base.image.data);
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i+3]) continue;
    const e = edits.get(hexOf(data[i], data[i+1], data[i+2]));
    if (!e) continue;
    data.set(e.rgb, i);
    data[i+3] = Math.round(data[i+3] * e.opacity / 100);
  }
  const merged=new Uint8ClampedArray(data.length);
  for(const layer of stack) {
    if(!layer.visible) continue;
    const plane=layer.id===0 ? data : new Uint8ClampedArray(data.length);
    for(const stroke of layers) {
      if(stroke.id!==layer.id || stroke.w!==base.image.width || stroke.h!==base.image.height) continue;
      for(const i of stroke.pixels) plane.set(stroke.color,i*4);
    }
    for(let i=0;i<plane.length;i+=4) {
      const alpha=plane[i+3]/255;
      if(!alpha)continue;
      const below=merged[i+3]/255*(1-alpha), total=alpha+below;
      for(let c=0;c<3;c++) merged[i+c]=(plane[i+c]*alpha+merged[i+c]*below)/total;
      merged[i+3]=total*255;
    }
  }
  const image = { ...base.image, data:merged };
  state.res = { ...base, image, colorsAfter: countColors(image) };
}

let stack = [], layerId = 0;

function drawLayerList() {
  const list=$('#layerList');
  list.replaceChildren();
  if(!active) return;
  for(const layer of [...stack].reverse()) {
    const row=document.createElement('div');
    for(const [label,title,action,disabled] of [
      [layer.visible?'◉':'○',layer.visible?'隐藏图层':'显示图层',()=>changeLayers(stack.map(l=>l===layer?{...l,visible:!l.visible}:l))],
      [layer.name,'选择图层',()=>{layerId=layer.id; active.settings={...active.settings,layerId};drawLayerList();}],
      ['↑','提高优先级',()=>moveLayer(layer,1),layer===stack.at(-1)],
      ['↓','降低优先级',()=>moveLayer(layer,-1),layer===stack[0]],
      ['🗑','删除'+layer.name,()=>deleteLayer(layer),stack.length===1]
    ]) {
      const b=document.createElement('button');
      b.textContent=label;b.title=title;b.disabled=!!disabled;b.onclick=action;
      if(label===layer.name)b.setAttribute('aria-pressed',String(layer.id===layerId));
      row.append(b);
    }
    list.append(row);
  }
}

function changeLayers(next) {
  stack=next; applyEdits();state.key++;remember();drawLayerList();renderAll();
}

function deleteLayer(layer) {
  if(stack.length<2) return;
  const index=stack.indexOf(layer);
  const next=stack.filter(item=>item!==layer);
  if(layerId===layer.id) layerId=next[Math.min(index,next.length-1)].id;
  changeLayers(next);
}

function moveLayer(layer,delta) {
  const next=[...stack], i=next.indexOf(layer);
  [next[i],next[i+delta]]=[next[i+delta],next[i]];
  changeLayers(next);
}

function bucketFill(x,y) {
  const {width:w,height:h,data}=state.res.image;
  const path=selectedPath();
  const ctx=path && document.createElement('canvas').getContext('2d');
  const seed=y*w+x, rgba=data.slice(seed*4,seed*4+4);
  const pixels=[], seen=new Uint8Array(w*h);
  function visit(i) {
    if(seen[i]) return;
    seen[i]=1;
    if(path && !ctx.isPointInPath(path,i%w+.5,Math.floor(i/w)+.5)) return;
    const j=i*4;
    if(data[j+3]!==rgba[3] || (rgba[3] && (data[j]!==rgba[0] || data[j+1]!==rgba[1] || data[j+2]!==rgba[2]))) return;
    pixels.push(i);
  }
  visit(seed);
  for(let n=0;n<pixels.length;n++) {
    const i=pixels[n];
    if(i%w) visit(i-1);
    if(i%w<w-1) visit(i+1);
    if(i>=w) visit(i-w);
    if(i+w<w*h) visit(i+w);
  }
  recordPixels(pixels,[...rgbOf($('#ink').value),brushAlpha]);
}

let paintTool = 'paint';
function chooseTool(tool) {
  paintTool = tool;
  for (const b of $('#paintTools').children) b.setAttribute('aria-pressed',String(b.dataset.tool===tool));
}

function useBrush(alpha) {
  brushAlpha = alpha;
  if(paintTool!=='bucket') chooseTool('paint');
  const percent=Math.round(100*(1-alpha/255));
  $('#inkTransparency').value=percent;
  $('#inkTransparencyValue').textContent=percent+'%';
  $('#ink').title = '画笔 ' + $('#ink').value.toUpperCase();
  $('#paintTools').firstElementChild.title = alpha ? $('#ink').title : '擦除（完全透明）';
}

function selectionPath(points) {
  const path = new Path2D();
  points.forEach(([x,y],i) => i ? path.lineTo(x,y) : path.moveTo(x,y));
  path.closePath();
  return path;
}

function selectedPath() {
  const sel = active?.selection, img = state.res?.image;
  return sel && img && sel.w===img.width && sel.h===img.height ? selectionPath(sel.points) : null;
}

function recordPixels(pixels,color) {
  if (!pixels.length || !stack.find(l=>l.id===layerId)?.visible) return;
  const {width:w,height:h} = state.res.image;
  const stroke={id:layerId,w,h,pixels,color};
  layers.push(stroke);
  rememberCanvas({stroke});
  applyEdits(); state.key++; renderAll();
}

function rememberCanvas(action) {
  active.canvasHistory.push(action);
  if(active.canvasHistory.length>50) active.canvasHistory.shift();
}

function setSelection(next) {
  if(!active || (!next && !active.selection)) return;
  rememberCanvas({selection:active.selection || null});
  active.selection=next;
}

function undoCanvas() {
  if(!active || !state.res) return;
  const history=active.canvasHistory;
  const index=history.findLastIndex(({stroke})=>!stroke || (stack.some(l=>l.id===stroke.id) &&
    stroke.w===state.res.image.width && stroke.h===state.res.image.height));
  if(index<0) return;
  const [action]=history.splice(index,1);
  if(action.stroke) {
    layers.splice(layers.indexOf(action.stroke),1);
    applyEdits(); state.key++;
  } else active.selection=action.selection;
  renderAll();
}

function exterior(img) {
  const {width:w,height:h,data} = img;
  const bins=new Map(), queue=[], seen=new Uint8Array(w*h);
  const key = i => (data[i*4]>>5)*64+(data[i*4+1]>>5)*8+(data[i*4+2]>>5);
  const border=[];
  for(let i=0;i<w*h;i++) if(i<w || i>=w*(h-1) || i%w===0 || i%w===w-1) {
    border.push(i);
    if(data[i*4+3]) bins.set(key(i),(bins.get(key(i))||0)+1);
  }
  const mode=[...bins].sort((a,b)=>b[1]-a[1])[0]?.[0];
  const samples=border.filter(i=>data[i*4+3] && key(i)===mode);
  const rgb=[0,1,2].map(c=>samples.reduce((sum,i)=>sum+data[i*4+c],0)/(samples.length||1));
  const transparent=border.filter(i=>!data[i*4+3]).length>border.length/2;
  function visit(i) {
    if(seen[i]) return;
    seen[i]=1;
    const j=i*4;
    if(data[j+3] && (transparent || Math.hypot(data[j]-rgb[0],data[j+1]-rgb[1],data[j+2]-rgb[2])>55)) return;
    queue.push(i);
  }
  border.forEach(visit);
  for(let n=0;n<queue.length;n++) {
    const i=queue[n], x=i%w;
    if(x) visit(i-1);
    if(x<w-1) visit(i+1);
    if(i>=w) visit(i-w);
    if(i+w<w*h) visit(i+w);
  }
  return queue.filter(i=>data[i*4+3]);
}

let noticeTimer;
function showTopNotice(message) {
  const notice=$('#topNotice');
  notice.textContent=message;
  notice.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer=setTimeout(()=>notice.classList.remove('visible'),1500);
}

function removeBackground() {
  if (!state.res) return;
  if (!stack.find(layer=>layer.id===layerId)?.visible) {
    $('#maskNote').textContent='当前图层已隐藏，请先显示它。';
    showTopNotice($('#maskNote').textContent);
    return;
  }
  const img=state.res.image, path=selectedPath();
  let pixels;
  if ($('#subject').value==='manual') {
    if(!path) { chooseTool('lasso'); $('#maskNote').textContent='请用左键圈住主体，再清除背景。'; return; }
    const ctx=document.createElement('canvas').getContext('2d');
    pixels=[];
    for(let i=0;i<img.width*img.height;i++) if(!ctx.isPointInPath(path,i%img.width+.5,Math.floor(i/img.width)+.5)) pixels.push(i);
  } else pixels=exterior(img);
  recordPixels(pixels,[0,0,0,0]);
  $('#maskNote').textContent='已清除 '+pixels.length+' 格，可撤销。';
}

function pixelPoint(e) {
  const r=$('#cvRes').getBoundingClientRect(), img=state.res.image;
  return [(e.clientX-r.left)*img.width/r.width,(e.clientY-r.top)*img.height/r.height];
}

function drawStep(e) {
  const pt=pixelPoint(e), d=drawing;
  if(d.tool==='lasso') d.points.push(pt);
  else {
    const [x,y]=pt, [a,b]=d.last || pt;
    const n=Math.max(1,Math.ceil(Math.max(Math.abs(x-a),Math.abs(y-b))));
    for(let k=1;k<=n;k++){
      const u=Math.floor(a+(x-a)*k/n), v=Math.floor(b+(y-b)*k/n);
      if(u>=0 && v>=0 && u<d.w && v<d.h && (!d.path || d.ctx.isPointInPath(d.path,u+.5,v+.5))) d.pixels.add(v*d.w+u);
    }
    d.last=pt;
  }
  renderAll();
}

function editColor(hex) {
  selected = hex;
  priorEdit = edits.get(hex);
  const e = edits.get(hex);
  $('#tone').value = e?.tone || hex;
  $('#light').value = e?.light || 0;
  $('#opacity').value = e?.opacity ?? 100;
  suggestions();
  updateReadouts();
  $('#editor').showModal();
}

function rgbOf(hex) {
  return hex.slice(1).match(/../g).map(v => parseInt(v, 16));
}

function wheelColor(hex) {
  const rgb = rgbOf(hex).map(v => v/255);
  const hi = Math.max(...rgb), lo = Math.min(...rgb), d = hi-lo;
  let h = 0;
  if (d) h = hi === rgb[0] ? (rgb[1]-rgb[2])/d : hi === rgb[1] ? (rgb[2]-rgb[0])/d+2 : (rgb[0]-rgb[1])/d+4;
  return {h,hi,d};
}

function wheelMark(hex, degrees, radius, label, choose) {
  const el = document.createElement(choose ? 'button' : 'span');
  el.className = 'wheel-mark';
  const rad = degrees * Math.PI / 180;
  el.style.left = (50 + radius * Math.sin(rad)) + '%';
  el.style.top = (50 - radius * Math.cos(rad)) + '%';
  el.style.backgroundColor = hex;
  el.title = label + ' ' + hex;
  el.setAttribute('aria-label', el.title);
  el.textContent = label[0];
  if (choose) el.onclick = choose;
  $('#wheel').append(el);
}

function suggestions() {
  const {h,hi,d} = wheelColor($('#tone').value);
  const original = wheelColor(selected);
  $('#wheel').replaceChildren();
  wheelMark(selected, original.h*60, original.d ? 26 : 0, '原采样色', null);
  const offsets = {adjacent:[-30,0,30],triad:[0,120,240],tetrad:[0,90,180,270]};
  const box = $('#choices');
  box.replaceChildren();
  for (const angle of offsets[$('#scheme').value]) {
    const channel = n => {
      const k = (n+h+angle/60+12)%6;
      return Math.round(255*(hi-d*Math.max(0,Math.min(k,4-k,1))));
    };
    const hex = hexOf(channel(5),channel(3),channel(1));
    const btn = document.createElement('button');
    btn.textContent = hex;
    btn.style.borderBottom = '5px solid '+hex;
    const choose = () => { $('#tone').value = hex; suggestions(); previewTone(); };
    btn.onclick = choose;
    if (d || angle === 0) wheelMark(hex, h*60+angle, d ? 40 : 13,
      angle === 0 ? '当前编辑色' : '配色 ' + angle + '°', choose);
    box.append(btn);
  }
}

function updateReadouts() {
  $('#lightValue').textContent = $('#light').value + '%';
  $('#opacityValue').textContent = $('#opacity').value + '%';
}

function previewTone() {
  updateReadouts();
  finishEdit(false, false);
}

function cancelTone() {
  if (priorEdit) edits.set(selected, priorEdit);
  else edits.delete(selected);
  applyEdits();
  state.key++;
  renderAll();
  $('#editor').close();
}

function wheelPick(event) {
  const box = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - box.left - box.width / 2;
  const y = event.clientY - box.top - box.height / 2;
  const hue = (Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1;
  const channel = n => {
    const k = (n + hue * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4-k, 1))));
  };
  $('#tone').value = hexOf(channel(5), channel(3), channel(1));
  suggestions();
  previewTone();
}

function finishEdit(reset, close = true) {
  if (reset) edits.delete(selected);
  else {
    const tone = $('#tone').value, light = Number($('#light').value);
    const rgb = rgbOf(tone).map(c => Math.round(c + (light >= 0 ? 255-c : c)*light/100));
    edits.set(selected, {tone, light, opacity:Number($('#opacity').value), rgb, hex:hexOf(...rgb)});
  }
  applyEdits();
  state.key++;
  renderAll();
  if (close) { remember(); $('#editor').close(); }
}

function updateColors() {
  const res = state.res;
  const box = $('#palette');
  box.innerHTML = '';
  if (!res) return;
  const list = base.palette || [];
  const shown = list;
  for (const [r, g, b, n] of shown) {
    const sw = document.createElement('button');
    sw.className = 'sw';
    sw.style.background = `rgb(${r},${g},${b})`;
    const hex = hexOf(r, g, b);
    sw.title = `${hex} · ${n} 格`;
    sw.addEventListener('click', () => editColor(hex));
    sw.oncontextmenu = e => { e.preventDefault(); copyText(hex); };
    if (edits.has(hex)) sw.style.background = edits.get(hex).hex;
    box.appendChild(sw);
  }
  if (res.colorsAfter > shown.length) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = `+${res.colorsAfter - shown.length}`;
    box.appendChild(more);
  }

  const limit = state.opts.colors;
  const isStrong = state.opts.sample === 'strong';
  let text;
  if (!limit) {
    text = isStrong
      ? `强劲模式默认 32 色，当前 ${res.colorsAfter} 色（可在上面改 8/16/64）。`
      : state.opts.sample === 'region'
        ? `区域吸附自动收敛到 ${res.colorsAfter} 个主色。`
        : `输出共 ${res.colorsAfter} 色（未限色，可继续调低）。`;
  } else if (res.colorsBefore <= limit) {
    text = `采样后本来就只有 ${res.colorsBefore} 色，未超过 ${limit}，无需减色。`;
  } else {
    text = `采样后 ${res.colorsBefore} 色 → 限制到 ${limit} 色，实际 ${res.colorsAfter} 色（中位切分）。`;
  }
  $('#colorHint').textContent = text;
}

async function copyText(text) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e2) {
      ok = false;
    }
  }
  const el = $('#paletteHint');
  el.textContent = ok ? `已复制 ${text}` : `复制失败：${text}`;
  setTimeout(() => {
    el.textContent = '点色块可复制十六进制值。';
  }, 1600);
}

function applyWipe() {
  $('#cvSrc').style.clipPath = `inset(0 0 0 ${state.wipe}%)`;
  $('#cvRes').style.clipPath = `inset(0 ${100 - state.wipe}% 0 0)`;
  $('#wipeNum').textContent = `${Math.round(state.wipe)}%`;
}

/* --------------------------------------------------------------- 诊断 */

function updateDiag() {
  $('#notes').replaceChildren();
  const r = state.res;
  const s = state.src;
  if (!r || !s) return;
  $('#dInput').textContent = `${s.width} × ${s.height} px`;
  $('#dGrid').textContent = `${r.gridW} × ${r.gridH} 格`;
  $('#dCell').textContent = `${r.cellW.toFixed(2)} × ${r.cellH.toFixed(2)} px`;
  $('#dMethod').textContent = METHOD_LABEL[r.method] || r.method;
  $('#dConf').textContent = r.method === 'manual' ? '—（手动指定）' : `${Math.round(r.confidence * 100)}%`;
  $('#dMs').textContent = `${r.ms} ms`;
  $('#dOut').textContent = `${r.outW} × ${r.outH} 格`;
  $('#dColors').textContent =
    r.colorsAfter === r.colorsBefore
      ? `${r.colorsAfter} 色`
      : `${r.colorsBefore} → ${r.colorsAfter} 色`;

  const W = s.width;
  const H = s.height;
  if (r.confidence < 0.45) {
    addNote('置信度偏低：这张图可能不是像素画，或网格不规则。可以手动指定格数再试。', 'warn');
  }
  if (r.gridW > 0 && Math.abs(W / r.gridW - Math.round(W / r.gridW)) > 0.02) {
    addNote(`横向格宽是 ${(W / r.gridW).toFixed(2)}px，不是整数：右侧最后一格会略窄，属正常现象。`, '');
  }
  if (r.squared) {
    addNote('检测到近似正方形，已按 fix_square 规则补齐对齐。', '');
  }
  if (r.method === 'manual') {
    if (r.gridW > W || r.gridH > H) {
      addNote('指定格数超过输入像素数，采样无法增加细节。若要放大，请调整导出尺寸。','warn');
    } else if (r.gridW === W && r.gridH === H) {
      addNote('手动网格与输入尺寸相同，每个输入像素对应一格。','');
    }
  } else if (r.method === 'fallback') {
    addNote('自动检测未找到稳定的网格周期，已使用回退格数。','warn');
  } else if (r.cellW <= 2.2 || r.cellH <= 2.2) {
    addNote(`自动检测到细网格，每格约 ${r.cellW.toFixed(2)} × ${r.cellH.toFixed(2)} px。`,'ok');
  }
  if (r.cleaned > 0) {
    addNote(`强劲模式：已把轮廓外侧 ${r.cleaned} 格混色/杂点并进背景，并刷平背景。`, 'ok');
  }
  if (r.speckles > 0) {
    addNote(`强劲模式：另去除 ${r.speckles} 个孤立杂点。`, 'ok');
  }
}

function addNote(text, kind) {
  const li = document.createElement('li');
  li.textContent = text;
  if (kind) li.className = kind;
  $('#notes').appendChild(li);
}

function setUrlHint(text, bad) {
  const el = $('#urlHint');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

/* --------------------------------------------------------------- 导出 */

function targetDimensions() {
  const img = state.res.image;
  let width = img.width, height = img.height;
  if (state.target === 'input') ({width,height} = state.src);
  else if (state.target === '192x224') { width=192; height=224; }
  else if (state.target !== 'one') width=height=Number(state.target);
  const factor=width/img.width;
  return {width,height,label:`${width}x${height}`,factor,exact:Number.isInteger(factor) && factor===height/img.height};
}

function currentTarget() {
  const t = targetDimensions(), img = state.res.image;
  const image = t.width===img.width && t.height===img.height ? img : scaleNearest(img,t.width,t.height);
  return {...t,image};
}

function updateTargetHint() {
  if (!state.res) return;
  const t = targetDimensions();
  const img = state.res.image;
  const el = $('#targetHint');
  if (t.exact) {
    el.textContent = `${img.width}×${img.height} → ${t.label}，${Number.isInteger(t.factor) ? `${t.factor} 倍` : `${t.factor.toFixed(2)} 倍`}最近邻放大：每个像素块内部纯色，无插值。`;
    el.classList.remove('bad');
  } else {
    el.textContent = `${img.width}×${img.height} → ${t.label} 不是整数倍，会按最近邻取整，个别像素会不均匀。`;
    el.classList.add('bad');
  }
}

function toBlob(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

async function exportPng() {
  if (!state.res) return;
  const t = currentTarget();
  const blob = await toBlob(t.image);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perfect-pixel-${t.label}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyPng() {
  if (!state.res) return;
  try {
    const t = currentTarget();
    const blob = await toBlob(t.image);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('#btnCopy').textContent = '已复制 ✓';
  } catch (e) {
    $('#btnCopy').textContent = '复制失败';
  }
  setTimeout(() => { $('#btnCopy').textContent = '复制到剪贴板'; }, 1400);
}

/* --------------------------------------------------------------- 事件 */

function syncLargeGrid(enabled) {
  $('#largeGrid').checked=!!enabled;
  for(const input of [$('#gridW'),$('#gridH')]) input.max=enabled ? 2048 : 512;
}

function syncForceGrid(enabled) {
  $('#forceGrid').checked = enabled;
  $('#fixSquare').disabled = $('#refine').disabled = enabled;
}

function bind() {
  $('#largeGrid').onchange=e=>{
    const enabled=e.target.checked;
    const w=$('#gridW'), h=$('#gridH');
    if(!enabled && Math.max(w.valueAsNumber,h.valueAsNumber)>512) {
      syncLargeGrid(state.opts.largeGrid);
      showTopNotice('请先将横纵格数调至 512 以内，再关闭大图精校。');
      return;
    }
    state.opts.largeGrid=enabled;
    syncLargeGrid(enabled);
    updateGridFactors();
    remember();
  };
  $('#forceGrid').onchange = e => {
    state.opts.forceGrid=e.target.checked;
    syncForceGrid(state.opts.forceGrid);
    reprocess();
  };
  $('#btnDemo').addEventListener('click', () => loadImage(makeDemo(), 'demo'));
  $('#btnPick').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadImage(f, f.name);
    e.target.value = '';
  });

  $('#sample').addEventListener('change', (e) => {
    state.opts.sample = e.target.value;
    $('#sampleHint').textContent = SAMPLE_HINT[e.target.value] || '';
    reprocess();
  });

  $('#modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    if (state.mode === btn.dataset.mode) return;
    state.mode = btn.dataset.mode;
    for (const b of $('#modeSeg').children) b.classList.toggle('on', b === btn);
    $('#manualBox').hidden = state.mode !== 'manual';
    if (state.res) {
      $('#gridW').value = state.res.gridW;
      $('#gridH').value = state.res.gridH;
      if (state.opts.gridRatio) state.opts.gridRatio = state.res.gridW / state.res.gridH;
    }
    updateGridFactors();
    reprocess();
  });

  const widthInput=$('#gridW'), heightInput=$('#gridH');
  $('#gridLink').onclick=()=>{
    if(!state.opts.gridRatio && ![widthInput,heightInput].every(el=>el.value && el.validity.valid)) return;
    state.opts.gridRatio=state.opts.gridRatio ? 0 : widthInput.valueAsNumber/heightInput.valueAsNumber;
    $('#gridLink').setAttribute('aria-pressed',String(!!state.opts.gridRatio));
    remember();
  };
  function linkOther(input) {
    const ratio=state.opts.gridRatio;
    if(!ratio || !input.value || !input.validity.valid) return;
    const horizontal=input===widthInput;
    const other=horizontal ? heightInput : widthInput;
    const factor=horizontal ? 1/ratio : ratio;
    const value=input.valueAsNumber;
    const paired=Math.min(+other.max,Math.max(+other.min,Math.round(value*factor)));
    other.value=paired;
    if(value*factor > +other.max || value*factor < +other.min)
      input.value=Math.min(+input.max,Math.max(+input.min,Math.round(paired/factor)));
  }
  let gridTimer;
  function commitGrid() {
    clearTimeout(gridTimer);
    if (!active || state.mode !== 'manual') return;
    const w = $('#gridW'), h = $('#gridH');
    if (![w,h].every(input => input.value && input.validity.valid)) return;
    if (active.settings.gw !== w.value || active.settings.gh !== h.value) reprocess();
  }
  updateGridFactors();
  $('#gridFactors').onclick=e=>{
    const b=e.target.closest('button[data-factor]');
    if(!b || b.disabled) return;
    for(const el of [widthInput,heightInput]) el.value=Math.max(1,Math.round(el.valueAsNumber*Number(b.dataset.factor)));
    updateGridFactors();
    commitGrid();
  };
  for (const input of [$('#gridW'), $('#gridH')]) {
    input.oninput = () => {
      linkOther(input);
      updateGridFactors();
      clearTimeout(gridTimer);
      const owner = active;
      gridTimer = setTimeout(() => { if (owner === active) commitGrid(); }, 350);
    };
    input.onchange = commitGrid;
    input.onkeydown = e => { if (e.key === 'Enter') commitGrid(); };
  }

  $('#refine').addEventListener('input', (e) => {
    state.opts.refine = Number(e.target.value) / 100;
    $('#refineNum').textContent = `${e.target.value}%`;
  });
  $('#refine').addEventListener('change', reprocess);

  $('#fixSquare').addEventListener('change', (e) => {
    state.opts.fixSquare = e.target.checked;
    reprocess();
  });

  $('#colorSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-colors]');
    if (!btn) return;
    state.opts.colors = Number(btn.dataset.colors);
    for (const b of $('#colorSeg').children) b.classList.toggle('on', b === btn);
    reprocess();
  });

  $('#btnRedetect').addEventListener('click', () => {
    state.mode = 'auto';
    for (const b of $('#modeSeg').children) b.classList.toggle('on', b.dataset.mode === 'auto');
    $('#manualBox').hidden = true;
    reprocess();
  });

  $('#wipe').addEventListener('input', (e) => {
    state.wipe = Number(e.target.value);
    applyWipe();
  });

  $('#showGrid').addEventListener('change', (e) => {
    state.grid = e.target.checked;
    renderAll();
  });

  $('#zoomIn').addEventListener('click', () => {
    state.zoom = Math.min(24, state.zoom * 2);
    renderAll();
  });
  $('#zoomOut').addEventListener('click', () => {
    state.zoom = Math.max(0.1, state.zoom / 2);
    renderAll();
  });
  $('#zoomFit').addEventListener('click', () => {
    state.panX = state.panY = 0;
    state.zoom = 1;
    positionView();
  });

  $('#target').addEventListener('change', (e) => {
    state.target = e.target.value;
    remember();
    updateTargetHint();
  });

  $('#btnExport').addEventListener('click', exportPng);
  $('#btnCopy').addEventListener('click', copyPng);

  $('#btnUrl').addEventListener('click', loadFromUrl);
  $('#url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl();
  });

  // 拖拽
  const dz = $('#dz');
  dz.title = '右键擦除 · 中键拖动平移 · 滚轮缩放 · 点击「适应」复位';
  let drag, panFrame, pointer;
  function followLasso() {
    panFrame = 0;
    if (drawing?.tool !== 'lasso' || !pointer) return;
    const r = dz.getBoundingClientRect();
    const shift = (v,min,max) => Math.max(-2,Math.min(2,(v<min ? min-v : v>max ? max-v : 0)*0.05));
    const mx=Math.min(48,r.width/4), my=Math.min(48,r.height/4);
    const dx = shift(pointer.clientX,r.left+mx,r.right-mx), dy = shift(pointer.clientY,r.top+my,r.bottom-my);
    if (!dx && !dy) return;
    state.panX += dx; state.panY += dy;
    positionView();
    drawStep(pointer);
    panFrame = requestAnimationFrame(followLasso);
  }
  dz.oncontextmenu = e => e.preventDefault();
  dz.onauxclick = e => { if(e.button===1) e.preventDefault(); };
  dz.onpointerdown = e => {
    if (!state.res || drawing || drag) return;
    if(e.button===0 || e.button===2){
      const [x,y]=pixelPoint(e).map(Math.floor), img=state.res.image;
      if(x<0||y<0||x>=img.width||y>=img.height) return;
      if(e.button===0 && e.altKey) {
        const j=(y*img.width+x)*4;
        $('#ink').value=hexOf(...img.data.slice(j,j+3));
        useBrush(255); e.preventDefault(); return;
      }
      if(e.button===0 && paintTool==='bucket') { bucketFill(x,y); return; }
      drawing={id:e.pointerId,tool:e.button===2?'paint':paintTool,startX:e.clientX,startY:e.clientY,moved:false,w:img.width,h:img.height,points:[],pixels:new Set(),
        color:e.button===2?[0,0,0,0]:[...rgbOf($('#ink').value),brushAlpha],path:selectedPath(),ctx:document.createElement('canvas').getContext('2d')};
      dz.setPointerCapture(e.pointerId); drawStep(e);return;
    }
    if(e.button!==1) return;
    e.preventDefault();
    drag = {id:e.pointerId,x:e.clientX,y:e.clientY};
    dz.setPointerCapture(e.pointerId);
    dz.classList.add('panning');
  };
  dz.onpointermove = e => {
    if(e.pointerId===drawing?.id) {
      drawing.moved ||= Math.hypot(e.clientX-drawing.startX,e.clientY-drawing.startY)>3;
      pointer = e;
      drawStep(e);
      if(drawing.tool==='lasso' && !panFrame) panFrame=requestAnimationFrame(followLasso);
      return;
    }
    if (e.pointerId !== drag?.id) return;
    state.panX += e.clientX-drag.x;
    state.panY += e.clientY-drag.y;
    drag.x=e.clientX; drag.y=e.clientY;
    positionView();
  };
  dz.onpointerup = e => {
    if(e.pointerId!==drawing?.id) return;
    drawStep(e);
    const d=drawing; drawing=null;
    if(d.tool==='lasso') setSelection(d.moved && d.points.length>=3 ? {w:d.w,h:d.h,points:d.points} : null);
    else recordPixels([...d.pixels],d.color);
    renderAll();
  };
  dz.onlostpointercapture = () => { cancelAnimationFrame(panFrame); panFrame=0; pointer=null; drawing=null; drag=null; dz.classList.remove('panning'); };
  dz.addEventListener('wheel', e => {
    if (!state.src) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? dz.clientHeight : 1);
    const zoom = Math.max(0.1, Math.min(24, state.zoom*Math.exp(-delta*0.002)));
    const ratio = zoom/state.zoom;
    const bounds = dz.getBoundingClientRect();
    const x = e.clientX-bounds.left-bounds.width/2;
    const y = e.clientY-bounds.top-bounds.height/2;
    state.panX = x+(state.panX-x)*ratio;
    state.panY = y+(state.panY-y)*ratio;
    state.zoom=zoom;
    positionView();
  }, {passive:false});
  for (const evt of ['dragenter', 'dragover']) {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && e.relatedTarget) return;
      dz.classList.remove('drag');
    });
  }
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadImage(f, f.name);
  });

  // 粘贴
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          loadImage(f, 'clipboard');
          return;
        }
      }
    }
  });

  window.addEventListener('resize', () => {
    if (state.src) renderAll();
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (state.src) renderAll();
    }).observe($('#dz'));
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if ($('#editor').open || e.target.isContentEditable || e.target.matches('textarea,input[type=text],input[type=url],input[type=number]')) return;
      e.preventDefault();
      if (!drawing && !e.repeat) undoCanvas();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      exportPng();
    }
  });
}

async function loadFromUrl() {
  const url = $('#url').value.trim();
  if (!url) return;
  setUrlHint('读取中…');
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) throw new Error('不是图片内容');
    await loadImage(blob, url.split('/').pop() || 'url');
    setUrlHint('已读取。');
  } catch (e) {
    setUrlHint(`读取失败：${e.message}（该站点未开放跨域读取，请改用拖拽或截图粘贴）`, true);
  }
}

/* --------------------------------------------------------------- 启动 */

function boot() {
  syncLargeGrid(state.opts.largeGrid);
  syncForceGrid(state.opts.forceGrid);
  for (const option of $('#sample').options) $('#sample2').append(option.cloneNode(true));
  $('#sample2').value = '';
  $('#sample2').onchange = () => { state.opts.sample2 = $('#sample2').value; reprocess(); };
  $('#undo').onclick = undoEdit;
  $('#paintTools').onclick = e => { const b=e.target.closest('button'); if(b) chooseTool(b.dataset.tool); };
  $('#layerToggle').onclick=()=>{const panel=$('#layerPanel');panel.hidden=!panel.hidden;$('#layerToggle').setAttribute('aria-expanded',String(!panel.hidden));drawLayerList();};
  $('#addLayer').onclick=()=>{if(!state.res)return;layerId=active.nextLayer++;changeLayers([...stack,{id:layerId,name:'图层 '+layerId,visible:true}]);};
  $('#removeBG').onclick=removeBackground;
  $('#subject').onchange=()=>{ if($('#subject').value==='manual') chooseTool('lasso'); };
  $('#noSelection').onclick=()=>{ if(active) { setSelection(null); renderAll(); } };
  $('#ink').onclick = $('#ink').oninput = $('#ink').onchange = () => useBrush(brushAlpha || 255);
  $('#inkTransparency').oninput = e => useBrush(Math.round(255*(100-Number(e.target.value))/100));
  useBrush(255);
  bind();
  $('#tone').oninput = () => { suggestions(); previewTone(); };
  $('#light').oninput = $('#opacity').oninput = previewTone;
  $('#wheel').onpointerdown = e => { if (e.target.closest("button")) return; e.currentTarget.setPointerCapture(e.pointerId); wheelPick(e); };
  $('#wheel').onpointermove = e => { if (e.buttons && e.currentTarget.hasPointerCapture(e.pointerId)) wheelPick(e); };
  $('#editor').oncancel = e => { e.preventDefault(); cancelTone(); };
  $('#scheme').onchange = suggestions;
  $('#applyTone').onclick = () => finishEdit(false);
  $('#resetTone').onclick = () => finishEdit(true);
  $('#cancelTone').onclick = cancelTone;
  if (isExt) $('#extChip').hidden = false;
  $('#sampleHint').textContent = SAMPLE_HINT[state.opts.sample];
  $('#refineNum').textContent = `${Math.round(state.opts.refine * 100)}%`;

  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) {
    $('#url').value = src;
    loadFromUrl();
  } else if (params.has('demo')) {
    loadImage(makeDemo(), 'demo');
  }
}

boot();
