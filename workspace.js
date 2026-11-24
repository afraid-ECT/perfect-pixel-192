const tabs=['object','scene'];
function selectPage(mode){
  for(const key of tabs){
    const selected=key===mode,button=document.getElementById(key+'-tab'),frame=document.getElementById(key+'-page');
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;frame.hidden=!selected;
    if(!selected)continue;
    const focusCanvas=()=>{
      if(button.getAttribute('aria-selected')==='true')frame.contentWindow?.postMessage({type:'perfect-pixel-focus-canvas'},'*');
    };
    if(!frame.getAttribute('src')){
      frame.addEventListener('load',focusCanvas,{once:true});
      frame.src=document.body.dataset[key]+location.search;
    }else focusCanvas();
  }
}
for(const [index,key] of tabs.entries()) {const button=document.getElementById(key+'-tab');button.onclick=()=>selectPage(key);button.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'object':e.key==='End'?'scene':tabs[1-index];selectPage(next);document.getElementById(next+'-tab').focus();}};}
selectPage(document.body.dataset.initial);

window.addEventListener('message',event=>{if(event.data?.type!=='perfect-pixel-page'||!tabs.includes(event.data.page))return;if(!tabs.some(key=>document.getElementById(key+'-page').contentWindow===event.source))return;selectPage(event.data.page);});

// Focus can stay in the shell after switching between sampling pages.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (e.target?.isContentEditable || e.target?.closest?.('input,textarea,[contenteditable=true]')) return;
  const mode = tabs.find(key => document.getElementById(key+'-tab').getAttribute('aria-selected') === 'true');
  const frame = mode && document.getElementById(mode+'-page');
  if (!frame?.contentWindow) return;
  e.preventDefault();
  if (!e.repeat) frame.contentWindow.postMessage({type:'perfect-pixel-undo-canvas'},'*');
});
