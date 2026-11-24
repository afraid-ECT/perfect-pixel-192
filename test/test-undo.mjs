import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/\bboot\(\);\s*$/,'');
let checks=0;
function test(scene){
 const elements=new Map(),docEvents={},winEvents={},frames=[];
 const doc={body:{dataset:{samplingPage:scene?'scene':'object'}},activeElement:null,querySelector:s=>element(s),createElement:tag=>element('created-'+elements.size),querySelectorAll:()=>[],addEventListener:(name,fn)=>docEvents[name]=fn};
 function element(id){if(elements.has(id))return elements.get(id);const e={id,value:id==='#ink'?'#ff0000':'32',checked:true,open:false,children:[],style:{setProperty(){}},dataset:{},validity:{valid:true},max:512,min:1,disabled:false,
 classList:{toggle(){},add(){},remove(){}},listeners:{},addEventListener(k,f){this.listeners[k]=f;},get valueAsNumber(){return Number(this.value)},setAttribute(k,v){this[k]=v},getAttribute(k){return this[k]},replaceChildren(){this.children=[]},append(...x){this.children.push(...x)},appendChild(x){this.children.push(x)},querySelector(){return element('small')},closest(){return null},matches(){return false},focus(){doc.activeElement=this},getContext(){return {isPointInPath:()=>true}},getBoundingClientRect(){return {left:0,top:0,width:4,height:4}},setPointerCapture(){},get firstElementChild(){return element('first')}};elements.set(id,e);return e;}
 const win={addEventListener:(name,fn)=>winEvents[name]=fn,parent:{}};
 const context=vm.createContext({document:doc,window:win,location:{search:''},URLSearchParams,Uint8ClampedArray,Map,Set,console,setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:f=>frames.push(f),cancelAnimationFrame(){},countColors:()=>1});
 vm.runInContext(app+`\nrenderAll=()=>{};drawLayerList=()=>{};positionView=()=>{};
 globalThis.testing={state,bind,handleCanvasUndoKey,undoEdit,remember,settings,setSelection,undoCanvas,recordPixels,activate,reprocess,
 setup(){state.src={width:4,height:4};state.res=base={image:{width:4,height:4,data:new Uint8ClampedArray(64).fill(255)}};stack=[{id:0,visible:true}];layerId=0;layers=[];active={id:1,strokes:layers,canvasHistory:[],history:[],view:{},settings:settings()};canvases.push(active);},
 get active(){return active},get layers(){return layers},get stack(){return stack},setDrawing(v){drawing=v},setBase(){state.res=base={image:{width:4,height:4,data:new Uint8ClampedArray(64).fill(255)}};},
 topUndo(){undoEdit();},setStack(v){stack=v;remember();}};`,context);
 const t=context.testing;t.setup();t.bind();
 const dz=element('#dz');assert.equal(dz.tabIndex,0);
 const key=(extra={})=>({ctrlKey:true,key:'z',preventDefault(){this.prevented=true},...extra});
 // Reproduce focus remaining in a numeric field, then paint on canvas.
 const number=element('#gridW');number.closest=()=>number;doc.activeElement=number;
 let e=key();docEvents.keydown(e);assert(!e.prevented);
 dz.onpointerdown({button:0,pointerId:1,clientX:1,clientY:1,preventDefault(){}});assert.equal(doc.activeElement,dz);
 dz.onpointerup({pointerId:1,clientX:1,clientY:1});assert.equal(t.layers.length,1);
 // Settings undo remains separate even when canvas history exists.
 t.state.opts.colors=32;t.remember();assert.equal(t.active.history.length,1);assert.equal(element('#undo').disabled,false);
 e=key();docEvents.keydown(e);assert(e.prevented);assert.equal(t.layers.length,0);assert.equal(t.state.opts.colors,32);assert.equal(t.active.history.length,1);
 // Top-right undo restores settings without creating another settings snapshot.
 t.topUndo();assert.equal(t.state.opts.colors,0);assert.equal(t.active.history.length,0);assert.equal(element('#undo').disabled,true);
 t.setBase();t.recordPixels([5],[255,0,0,255]);assert.equal(t.state.res.image.data[5*4+1],0);t.state.opts.colors=64;t.remember();t.topUndo();assert.equal(t.state.opts.colors,0);assert.equal(t.layers.length,1,'top-right must preserve strokes');
 // Restoring or switching must not record history.
 assert.equal(t.active.history.length,0);t.activate(t.active);assert.equal(t.active.history.length,0);
 t.setBase();doc.activeElement=dz;docEvents.keydown(key());assert.equal(t.layers.length,0);assert.equal(t.state.res.image.data[5*4+1],255);
 // Selection and drawing share canvas history, not settings history.
 t.setSelection({w:4,h:4,points:[[0,0],[3,0],[3,3]]});docEvents.keydown(key());assert.equal(t.active.selection,null);assert.equal(t.active.history.length,0);
 // Shell request undoes only this page's canvas and ignores foreign messages.
 t.recordPixels([2],[255,0,0,255]);winEvents.message({source:{},data:{type:'perfect-pixel-undo-canvas'}});assert.equal(t.layers.length,1);
 winEvents.message({source:win.parent,data:{type:'perfect-pixel-undo-canvas'}});assert.equal(t.layers.length,0);
 t.recordPixels([3],[255,0,0,255]);t.setDrawing({});docEvents.keydown(key());assert.equal(t.layers.length,1);t.setDrawing(null);
 docEvents.keydown(key({repeat:true}));assert.equal(t.layers.length,1);
 docEvents.keydown(key({ctrlKey:false,metaKey:true}));assert.equal(t.layers.length,0);
 for(const extra of [{shiftKey:true},{altKey:true}]){e=key(extra);docEvents.keydown(e);assert(!e.prevented);}
 doc.activeElement=number;t.recordPixels([3],[255,0,0,255]);winEvents.message({source:win.parent,data:{type:'perfect-pixel-undo-canvas'}});assert.equal(t.layers.length,1,'text field undo must stay native');
 checks+=22;return {t,doc,docEvents,winEvents};
}
const a=test(false),b=test(true);assert.notEqual(a.t.active,b.t.active);
a.doc.activeElement=null;a.docEvents.keydown({ctrlKey:true,key:'z',preventDefault(){}});assert.equal(a.t.layers.length,0);assert.equal(b.t.layers.length,1,'sampling pages must not share history');
// Exercise actual shell keyboard dispatch after changing sampling page.
const buttons={},pages={},events={};for(const k of ['object','scene']){buttons[k]={attributes:{},setAttribute(k,v){this.attributes[k]=v},getAttribute(k){return this.attributes[k]},focus(){}};pages[k]={src:null,load:null,addEventListener(n,f){this.load=f},getAttribute(){return this.src},contentWindow:{messages:[],postMessage(v){this.messages.push(v)}}};}
const document={body:{dataset:{initial:'object',object:'object.html',scene:'scene.html'}},getElementById:id=>id.endsWith('-tab')?buttons[id.replace('-tab','')]:pages[id.replace('-page','')],addEventListener:(n,f)=>events[n]=f};
vm.runInNewContext(fs.readFileSync(new URL('../workspace.js',import.meta.url),'utf8'),{document,window:{addEventListener(){}},location:{search:''}});
const fire=()=>events.keydown({ctrlKey:true,key:'z',target:{},preventDefault(){}});
pages.object.load();assert.equal(pages.object.contentWindow.messages[0].type,'perfect-pixel-focus-canvas');pages.object.contentWindow.messages.length=0;fire();assert.equal(pages.object.contentWindow.messages.length,1);assert.equal(pages.scene.contentWindow.messages.length,0);
buttons.scene.onclick();pages.scene.load();assert.equal(pages.scene.contentWindow.messages[0].type,'perfect-pixel-focus-canvas');pages.scene.contentWindow.messages.length=0;fire();assert.equal(pages.scene.contentWindow.messages.length,1);assert.equal(pages.object.contentWindow.messages.length,1);
assert.equal(pages.scene.contentWindow.messages[0].type,'perfect-pixel-undo-canvas');
buttons.object.onclick();assert.equal(pages.object.contentWindow.messages.at(-1).type,'perfect-pixel-focus-canvas');
console.log('PASS: canvas/settings undo, numeric-field focus, page switching, isolation and shell dispatch checks');
