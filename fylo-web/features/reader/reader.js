/**
 * FYLO Feature — Reader
 *
 * Owns: PDF rendering, viewport transform, zoom/pan, search, bookmarks, thumbnails.
 * Private state: _rs (reader state), _dom (DOM refs), _bm (bookmark cache).
 * Public API: ReaderModule (exported below).
 * Cross-module: uses Router.go() for navigation, bus.emit() for events.
 * No _navTo() shim. No global State.reader. No duplicate helpers.
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State, Actions } from '../../core/state.js';
import { Libs } from '../../core/libs.js';
import { BookmarkStorage } from '../../core/storage.js';
import { Router } from '../../core/router.js';
import { PAGES } from '../../core/constants.js';
import {
  toast, downloadBlob, openModal, closeModal,
  formatFileSize, formatDate, generateId, ripple
} from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Reader');

// ── Private DOM refs (lazy, never cached at module load time) ─────────────────
const _dom = {
  get canvas()      { return document.getElementById('pdf-canvas'); },
  get wrap()        { return document.getElementById('reader-canvas-wrap'); },
  get pageInput()   { return document.getElementById('reader-page-input'); },
  get totalPages()  { return document.getElementById('reader-total-pages'); },
  get zoomLevel()   { return document.getElementById('reader-zoom-level'); },
  get thumbs()      { return document.getElementById('reader-thumbs'); },
  get sidebar()     { return document.getElementById('reader-sidebar'); },
  get prev()        { return document.getElementById('reader-prev'); },
  get next()        { return document.getElementById('reader-next'); },
  get zoomIn()      { return document.getElementById('reader-zoom-in'); },
  get zoomOut()     { return document.getElementById('reader-zoom-out'); },
  get searchToggle(){ return document.getElementById('reader-search-toggle'); },
  get searchBar()   { return document.getElementById('reader-search-bar'); },
  get searchInput() { return document.getElementById('reader-search-input'); },
  get searchCount() { return document.getElementById('reader-search-count'); },
  get searchPrev()  { return document.getElementById('reader-search-prev'); },
  get searchNext()  { return document.getElementById('reader-search-next'); },
  get searchClose() { return document.getElementById('reader-search-close'); },
  get bookmarkBtn() { return document.getElementById('reader-bookmark-btn'); },
  get infoBtn()     { return document.getElementById('reader-info-btn'); },
  get moreBtn()     { return document.getElementById('reader-more'); },
  get thumbsBtn()   { return document.getElementById('reader-thumbs-btn'); },
  get title()       { return document.getElementById('reader-title'); },
};

// ── Private state ─────────────────────────────────────────────────────────────
const _rs = {
  pdf: null, currentPage: 1, totalPages: 0, scale: 1.2, docId: null,
  thumbs: [], searchResults: [], searchIndex: -1,
  renderTask: null, isRendering: false, lastScale: null,
  _tx: 0, _ty: 0, _scale: 1,
  canvasWidth: 0, canvasHeight: 0,
  // Aliases for legacy internal code
  get gestureScale()   { return this._scale; }, set gestureScale(v) { this._scale = v; },
  get panX()           { return this._tx; },    set panX(v)         { this._tx = v; },
  get panY()           { return this._ty; },    set panY(v)         { this._ty = v; },
  isZooming: false, _zoomRaf: null, _renderTimer: null,
};

// ── Bookmark cache (per-session, backed by BookmarkStorage) ───────────────────
const _bm = {};  // { [fileId]: Set<pageNumber> }

async function _BookmarkLoad(store, fileId) {
  const r = await BookmarkStorage.load(fileId);
  return r;
}
async function _BookmarkSave(store, data) {
  await BookmarkStorage.save(data.id, new Set(data.pages ?? []));
}

function destroyReader(){
  const r = _rs;
  if(r._zoomRaf){cancelAnimationFrame(r._zoomRaf);r._zoomRaf=null;}
  clearTimeout(r._renderTimer); r._renderTimer=null;
  if(r.renderTask){try{r.renderTask.cancel();}catch(e){}r.renderTask=null;}
  if(r.pdf){try{r.pdf.destroy();}catch(e){}r.pdf=null;}
  r.currentPage=1;r.totalPages=0;r.thumbs=[];r.searchResults=[];r.searchIndex=-1;r.lastScale=null;
  r._scale=1;r._tx=0;r._ty=0;r.isZooming=false;r.canvasWidth=0;r.canvasHeight=0;
  const ctx=_dom.canvas.getContext('2d');ctx.clearRect(0,0,_dom.canvas.width,_dom.canvas.height);
  _dom.canvas.width=0;_dom.canvas.height=0;
  _dom.canvas.style.width='';_dom.canvas.style.height='';_dom.canvas.style.transform='';
  _dom.thumbs.innerHTML='';_dom.sidebar.classList.remove('open');
  [_dom.zoomOut,_dom.zoomIn,_dom.prev,_dom.next,_dom.pageInput,_dom.searchToggle,_dom.bookmarkBtn,_dom.infoBtn,_dom.moreBtn,_dom.thumbsBtn].forEach(el=>el.disabled=true);
  _dom.totalPages.textContent='1';_dom.pageInput.value=1;_dom.pageInput.removeAttribute('max');_dom.pageInput.removeAttribute('min');_dom.zoomLevel.textContent='100%';
  _dom.searchBar.classList.remove('show');_dom.searchInput.value='';_dom.searchCount.textContent='';
  updateBookmarkIcon();
}


async function openReader(fileId){
  destroyReader();
  const file = State.files.find(f=>f.id===fileId);
  if(!file){toast('File not found');return;}
  if(!file.blob){toast('File data unavailable');return;}
  _rs.docId=fileId;
  _dom.title.textContent=file.name;
  Router.go(PAGES.READER);
  toast('Loading PDF...');
  try{
    const arrayBuffer = await file.blob.arrayBuffer();
    if(_rs.docId!==fileId||State.page!=='reader')return;
    if(!await Libs.waitForPdfJs()){toast('PDF.js not loaded. Check your internet connection.');return;}
    let pdf;
    try{
      const loadingTask=Libs.pdfjs.getDocument({data:arrayBuffer});
      pdf=await Promise.race([loadingTask.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PDF load timeout')),30000))]);
    }catch(loadErr){
      if(loadErr&&(loadErr.name==='PasswordException'||loadErr.name==='PasswordRequiredException')){
        // Use a modal instead of window.prompt() — works on all mobile browsers
        let pw = null;
        try {
          pw = await new Promise((resolve) => {
            openModal('Password Required',
              `<p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px">This PDF is password protected.</p>
               <div style="position:relative">
                 <input type="password" class="input-field" id="reader-pw-input" placeholder="Enter password" autocomplete="current-password" style="padding-right:44px">
                 <button type="button" id="reader-pw-show" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:4px;line-height:0">
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                 </button>
               </div>`,
              `<button class="btn btn-secondary" id="reader-pw-cancel">Cancel</button>
               <button class="btn btn-primary" id="reader-pw-ok">Open</button>`
            );
            const inp = document.getElementById('reader-pw-input');
            const toggleBtn = document.getElementById('reader-pw-show');
            toggleBtn?.addEventListener('click', () => {
              inp.type = inp.type === 'password' ? 'text' : 'password';
            });
            const submit = () => {
              const v = document.getElementById('reader-pw-input')?.value ?? '';
              // Clear input before resolving
              if(document.getElementById('reader-pw-input')) document.getElementById('reader-pw-input').value='';
              closeModal(); resolve(v || null);
            };
            document.getElementById('reader-pw-ok')?.addEventListener('click', submit);
            inp?.addEventListener('keydown', e => { if(e.key==='Enter') submit(); });
            document.getElementById('reader-pw-cancel')?.addEventListener('click', () => {
              if(document.getElementById('reader-pw-input')) document.getElementById('reader-pw-input').value='';
              closeModal(); resolve(null);
            });
            setTimeout(() => inp?.focus(), 50);
          });
        } catch(e) { pw = null; }
        if(pw===null){toast('Open cancelled');destroyReader();return;}
        try {
          const loadingTask=Libs.pdfjs.getDocument({data:arrayBuffer,password:pw});
          pdf=await loadingTask.promise;
        } catch(e2) {
          // Don't log pw; log only error type
          log.warn('Reader: protected PDF load failed', e2?.name);
          toast('Incorrect password — could not open PDF.');
          destroyReader(); return;
        } finally {
          // pw goes out of scope here — not retained
        }
      }else{throw loadErr;}
    }
    if(_rs.docId!==fileId||State.page!=='reader'){try{pdf.destroy();}catch(e){}return;}
    if(!pdf.numPages){toast('Empty or invalid PDF');destroyReader();return;}
    // Calculate a fit-to-viewport base scale before rendering
    let fitScale = 1.2;
    try{
      const fp = await pdf.getPage(1);
      const nv = fp.getViewport({scale:1});
      const ww = _dom.wrap.clientWidth  || window.innerWidth;
      const wh = _dom.wrap.clientHeight || Math.max(300, window.innerHeight - 120);
      fitScale = Math.max(0.4, Math.min(3, Math.min((ww-16)/nv.width, (wh-16)/nv.height)));
    }catch(e){}
    _rs.pdf=pdf;
    _rs.currentPage=1;
    _rs.totalPages=pdf.numPages;
    _rs.scale=fitScale;
    _rs._scale=1; _rs._tx=0; _rs._ty=0;
    _rs.thumbs=[];
    _rs.searchResults=[];
    _rs.searchIndex=-1;
    _dom.totalPages.textContent=pdf.numPages;
    _dom.pageInput.value=1;
    _dom.pageInput.setAttribute('max',String(pdf.numPages));
    _dom.pageInput.setAttribute('min','1');
    [_dom.zoomOut,_dom.zoomIn,_dom.prev,_dom.next,_dom.pageInput,_dom.searchToggle,_dom.bookmarkBtn,_dom.infoBtn,_dom.moreBtn,_dom.thumbsBtn].forEach(el=>el.disabled=false);
    _dom.zoomOut.disabled=false;_dom.zoomIn.disabled=false;
    const bm = await _BookmarkLoad('bookmarks',fileId);
    _bm[fileId]=bm?bm.pages:[];
    updateBookmarkIcon();
    await renderPage(1);
    if(_rs.docId===fileId&&State.page==='reader')await generateThumbnails();
    if(_rs.docId===fileId)toast(`${file.name} loaded`);
  }catch(err){console.error(err);toast('Failed to load PDF: '+(err&&err.message?err.message:''));destroyReader();}
}

async function renderPage(num, forceRender){
  if(!_rs.pdf||num<1||num>_rs.totalPages)return;
  // Skip if same page at same scale and not a forced quality re-render
  if(!forceRender && _rs.currentPage===num && _rs.lastScale===_rs.scale && _rs._scale===1) return;
  // Cancel any in-progress render
  if(_rs.isRendering && _rs.renderTask){
    try{_rs.renderTask.cancel();}catch(e){}
  }
  _dom.canvas.style.transition='';
  _rs.isRendering=true;
  try{
    const page = await _rs.pdf.getPage(num);
    if(!_rs.pdf||State.page!=='reader')return;
    const canvas = _dom.canvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio||1;
    const viewport = page.getViewport({scale:_rs.scale*dpr});
    const cssWidth = viewport.width/dpr;
    const cssHeight = viewport.height/dpr;
    const wasNewPage = num !== _rs.currentPage;
    // Save visual state BEFORE updating canvas size
    const prevCvW = _rs.canvasWidth;
    const prevCvH = _rs.canvasHeight;
    const prevTx  = _rs._tx;
    const prevTy  = _rs._ty;
    const prevS   = _rs._scale;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = cssWidth+'px';
    canvas.style.height = cssHeight+'px';
    _rs.canvasWidth = cssWidth;
    _rs.canvasHeight = cssHeight;
    _rs._scale = 1;

    _rs.renderTask = page.render({canvasContext:ctx,viewport});
    await _rs.renderTask.promise;
    _rs.renderTask=null;
    _rs.currentPage=num;
    _rs.lastScale=_rs.scale;

    if(wasNewPage){
      // New page: center the canvas in the viewport
      _centerCanvas();
    } else if(prevCvW > 0){
      // Quality re-render at new scale: preserve the visual center point.
      // The canvas visual center was at: prevTx + (prevCvW*prevS)/2, prevTy + (prevCvH*prevS)/2
      // New canvas size is cssWidth × cssHeight (at _scale=1).
      // Set _tx so that the same document center is at the same screen position.
      const scaleRatio = cssWidth / (prevCvW * prevS); // how much the canvas grew
      // Preserve the screen position of the canvas center
      const screenCx = prevTx + (prevCvW * prevS) / 2;
      const screenCy = prevTy + (prevCvH * prevS) / 2;
      _rs._tx = screenCx - cssWidth  / 2;
      _rs._ty = screenCy - cssHeight / 2;
      _clampTransform();
    } else {
      _centerCanvas();
    }
    _applyTransform();
    _dom.pageInput.value=num;
    updateThumbActive(num);
    updateBookmarkIcon();
    _dom.prev.disabled=num<=1;
    _dom.next.disabled=num>=_rs.totalPages;
    updateZoomDisplay();
  }catch(err){
    if(err&&err.name==='RenderingCancelledException'){/* ignore */}
    else if(err&&err.message&&err.message.includes('cancelled')){/* ignore */}
    else{console.error('Render error:',err);toast('Failed to render page');}
  }finally{
    _rs.isRendering=false;
  }
}


let __thumbGenToken=0;
async function generateThumbnails(){
  if(!_rs.pdf)return;
  const token=++__thumbGenToken;
  _dom.thumbs.innerHTML='';
  const count = Math.min(_rs.totalPages,50);
  for(let i=1;i<=count;i++){
    if(token!==__thumbGenToken)return;
    let c=null;
    try{
      const page = await _rs.pdf.getPage(i);
      const vp = page.getViewport({scale:0.2});
      c = document.createElement('canvas');c.width=vp.width;c.height=vp.height;
      await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
      if(token!==__thumbGenToken)return;
      const thumbDiv = document.createElement('div');
      thumbDiv.className='reader-thumb'+(i===1?' active':'');
      thumbDiv.dataset.page=i;
      thumbDiv.innerHTML=`<canvas width="${vp.width}" height="${vp.height}"></canvas><div class="reader-thumb-num">${i}</div>`;
      thumbDiv.querySelector('canvas').getContext('2d').drawImage(c,0,0);
      thumbDiv.addEventListener('click',()=>{_rs._scale=1;renderPage(i);});
      _dom.thumbs.appendChild(thumbDiv);
    }catch(e){}finally{if(c){c.width=0;c.height=0;}}
    if(i%3===0)await new Promise(r=>setTimeout(r,0));
  }
}

function updateThumbActive(num){
  _dom.thumbs.querySelectorAll('.reader-thumb').forEach(t=>{
    const isActive=parseInt(t.dataset.page)===num;
    t.classList.toggle('active',isActive);
    if(isActive){
      const tRect=t.getBoundingClientRect();
      const pRect=_dom.thumbs.getBoundingClientRect();
      if(tRect.top<pRect.top||tRect.bottom>pRect.bottom){
        t.scrollIntoView({behavior:'smooth',block:'nearest'});
      }
    }
  });
}

function zoomIn(){
  if(!_rs.pdf) return;
  const r = _rs;
  const curVis = r.scale * r._scale;
  if(curVis >= 4) return;
  const step = curVis < 1 ? curVis * 1.5 : curVis + 0.5;
  const targetVis = Math.min(4, Math.round(step * 10) / 10);
  _animateToVisual(targetVis);
}

function zoomOut(){
  if(!_rs.pdf) return;
  const r = _rs;
  const curVis = r.scale * r._scale;
  if(curVis <= 0.3) return;
  const step = curVis <= 1 ? curVis * 0.75 : curVis - 0.5;
  const targetVis = Math.max(0.3, Math.round(step * 10) / 10);
  _animateToVisual(targetVis);
}

// Animate to a target visual zoom level (render_scale × _scale = targetVis).
// Zooms around viewport center. After animation, bakes scale and re-renders for sharpness.
function _animateToVisual(targetVis){
  const r = _rs;
  if(r._zoomRaf){ cancelAnimationFrame(r._zoomRaf); r._zoomRaf=null; }

  const wrap = _dom.wrap;
  const fx = wrap.clientWidth / 2, fy = wrap.clientHeight / 2;
  const fromScale = r._scale;
  const toScale   = targetVis / r.scale;   // what _scale must be to reach targetVis
  const fromTx = r._tx, fromTy = r._ty;
  // Pre-compute destination tx/ty (zoom around center)
  const ratio  = toScale / fromScale;
  let toTx = fx - (fx - fromTx) * ratio;
  let toTy = fy - (fy - fromTy) * ratio;
  // Pre-clamp destination
  { const visW=r.canvasWidth*toScale, visH=r.canvasHeight*toScale;
    const ww=wrap.clientWidth, wh=wrap.clientHeight;
    if(visW<=ww){ toTx=(ww-visW)/2; } else { toTx=Math.min(0,Math.max(ww-visW,toTx)); }
    if(visH<=wh){ toTy=(wh-visH)/2; } else { toTy=Math.min(0,Math.max(wh-visH,toTy)); }
  }
  const start=performance.now(), dur=220;
  function ease(t){ return t<.5?2*t*t:(4-2*t)*t-1; }
  function frame(now){
    const t=Math.min(1,(now-start)/dur), e=ease(t);
    r._scale = fromScale+(toScale-fromScale)*e;
    r._tx    = fromTx+(toTx-fromTx)*e;
    r._ty    = fromTy+(toTy-fromTy)*e;
    _applyTransform(); updateZoomDisplay();
    if(t<1){ r._zoomRaf=requestAnimationFrame(frame); }
    else{
      r._scale=toScale; r._tx=toTx; r._ty=toTy;
      _clampTransform(); _applyTransform(); updateZoomDisplay();
      r._zoomRaf=null;
      clearTimeout(r._renderTimer);
      r._renderTimer=setTimeout(()=>{
        if(!r.pdf||State.page!=='reader') return;
        r.scale=Math.max(0.3,Math.min(5, r.scale*r._scale));
        r._scale=1;
        renderPage(r.currentPage, true);
      }, 200);
    }
  }
  r._zoomRaf=requestAnimationFrame(frame);
}

// Legacy alias kept for zoom-level chip reset click
function animateZoomTo(targetRenderScale){
  // Reset to fit: animate _scale back to 1 (canvas at its render size), centered
  _animateToVisual(targetRenderScale);
}

function prevPage(){
  if(_rs.currentPage>1){_rs._scale=1;renderPage(_rs.currentPage-1);}
}
function nextPage(){
  if(_rs.currentPage<_rs.totalPages){_rs._scale=1;renderPage(_rs.currentPage+1);}
}
function goToPage(num){
  const n=parseInt(num,10);
  if(isNaN(n)||!_rs.pdf){_dom.pageInput.value=_rs.currentPage;return;}
  const clamped=Math.max(1,Math.min(_rs.totalPages,n));
  if(clamped===_rs.currentPage){_dom.pageInput.value=_rs.currentPage;return;}
  _rs._scale=1;
  renderPage(clamped);
}

// ─────────────────────────────────────────────────────────────────────────────
//
// The canvas sits at position:absolute; transform-origin:0 0.
// State stores:
//   _tx, _ty   — screen-pixel offset of the canvas top-left corner
//   _scale     — visual zoom (1.0 = render size, i.e. no additional zoom)
//
// The invariant:  canvas top-left is at (_tx, _ty) in wrap-local pixels,
// scaled by _scale from that origin.
// transform = `translate(_tx px, _ty px) scale(_scale)`
//
// "Finger anchored" means: when scale changes from S to S', we adjust
// (_tx, _ty) so the screen point (fx, fy) stays fixed:
//   new_tx = fx - (fx - old_tx) * (S'/S)
//   new_ty = fy - (fy - old_ty) * (S'/S)
//
// clampTransform() keeps the canvas from drifting fully off screen.
// ─────────────────────────────────────────────────────────────────────────────

function _applyTransform(){
  const r = _rs;
  _dom.canvas.style.transform = `translate(${r._tx}px,${r._ty}px) scale(${r._scale})`;
}

function _clampTransform(){
  const r = _rs;
  if(!r.canvasWidth) return;
  const wrap = _dom.wrap;
  const ww = wrap.clientWidth, wh = wrap.clientHeight;
  const visW = r.canvasWidth  * r._scale;
  const visH = r.canvasHeight * r._scale;
  // Horizontal
  if(visW <= ww){
    // Content narrower than viewport: center it
    r._tx = (ww - visW) / 2;
  } else {
    // Content wider: allow panning, but keep at least 1px visible on each side
    r._tx = Math.min(0, Math.max(ww - visW, r._tx));
  }
  // Vertical
  if(visH <= wh){
    r._ty = (wh - visH) / 2;
  } else {
    r._ty = Math.min(0, Math.max(wh - visH, r._ty));
  }
}

function _centerCanvas(){
  const r = _rs;
  const wrap = _dom.wrap;
  const ww = wrap.clientWidth, wh = wrap.clientHeight;
  const visW = r.canvasWidth  * r._scale;
  const visH = r.canvasHeight * r._scale;
  r._tx = (ww - visW) / 2;
  r._ty = (wh - visH) / 2;
}

// Zoom around a wrap-local screen point (fx, fy), keeping that point fixed.
function _zoomAt(newScale, fx, fy){
  const r = _rs;
  const ratio = newScale / r._scale;
  r._tx = fx - (fx - r._tx) * ratio;
  r._ty = fy - (fy - r._ty) * ratio;
  r._scale = newScale;
  _clampTransform();
}

function applyReaderTransform(){ _applyTransform(); }
function clampPan(){ _clampTransform(); }

function updateZoomDisplay(){
  const r = _rs;
  _dom.zoomLevel.textContent = Math.round(r.scale * r._scale * 100) + '%';
}

function handleDoubleTap(fx, fy){
  if(!_rs.pdf) return;
  const r = _rs;
  const visual = r.scale * r._scale;
  const isZoomed = visual > 1.3;
  if(isZoomed){
    // Zoom back to fit (render scale, _scale=1), centered in viewport
    _animateToVisual(r.scale);  // r.scale is the base render scale → visual = r.scale × 1 = r.scale
    // After animation, override to center (handled by _clampTransform centering when visW<=ww)
  } else {
    // Zoom 2.5× into the tapped point
    const targetVis = Math.min(4, r.scale * 2.5);
    if(r._zoomRaf){ cancelAnimationFrame(r._zoomRaf); r._zoomRaf=null; }
    const fromScale=r._scale, toScale=targetVis/r.scale;
    const fromTx=r._tx, fromTy=r._ty;
    const ratio=toScale/fromScale;
    let toTx=fx-(fx-fromTx)*ratio, toTy=fy-(fy-fromTy)*ratio;
    { const visW=r.canvasWidth*toScale, visH=r.canvasHeight*toScale;
      const ww=_dom.wrap.clientWidth, wh=_dom.wrap.clientHeight;
      if(visW<=ww){ toTx=(ww-visW)/2; } else { toTx=Math.min(0,Math.max(ww-visW,toTx)); }
      if(visH<=wh){ toTy=(wh-visH)/2; } else { toTy=Math.min(0,Math.max(wh-visH,toTy)); }
    }
    const start=performance.now(), dur=280;
    function ease(t){ return t<.5?2*t*t:(4-2*t)*t-1; }
    function frame(now){
      const t=Math.min(1,(now-start)/dur), e=ease(t);
      r._scale=fromScale+(toScale-fromScale)*e;
      r._tx=fromTx+(toTx-fromTx)*e; r._ty=fromTy+(toTy-fromTy)*e;
      _applyTransform(); updateZoomDisplay();
      if(t<1){ r._zoomRaf=requestAnimationFrame(frame); }
      else{
        r._scale=toScale; r._tx=toTx; r._ty=toTy;
        _clampTransform(); _applyTransform(); updateZoomDisplay();
        r._zoomRaf=null;
        clearTimeout(r._renderTimer);
        r._renderTimer=setTimeout(()=>{
          if(!r.pdf||State.page!=='reader')return;
          r.scale=Math.max(0.3,Math.min(5,r.scale*r._scale));
          r._scale=1; renderPage(r.currentPage,true);
        },200);
      }
    }
    r._zoomRaf=requestAnimationFrame(frame);
  }
}

// Reader Search
let __searchToken=0;
async function searchInPDF(query){
  if(!_rs.pdf||!query.trim()){_rs.searchResults=[];_rs.searchIndex=-1;_dom.searchCount.textContent='';return;}
  const thisSearch=++__searchToken;
  _rs.searchResults=[];_rs.searchIndex=-1;
  toast('Searching...');
  try{
    for(let i=1;i<=_rs.totalPages;i++){
      if(__searchToken!==thisSearch)return;
      const page=await _rs.pdf.getPage(i);
      if(__searchToken!==thisSearch)return;
      try{
        const text=await page.getTextContent();
        const str=text.items.map(t=>t.str).join(' ');
        if(str.toLowerCase().includes(query.toLowerCase()))_rs.searchResults.push(i);
      }catch(textErr){/* skip pages with unreadable text */}
      if(i%5===0)await new Promise(r=>setTimeout(r,0));
    }
    if(__searchToken!==thisSearch)return;
    if(_rs.searchResults.length){
      _rs.searchIndex=0;renderPage(_rs.searchResults[0]);
      _dom.searchCount.textContent=`1/${_rs.searchResults.length}`;
      toast(`Found ${_rs.searchResults.length} matches`);
    }else{_dom.searchCount.textContent='0/0';toast('No matches found');}
  }catch(e){toast('Search failed');}
}
function nextSearchResult(){if(!_rs.searchResults.length||_rs.searchIndex<0)return;_rs.searchIndex=(_rs.searchIndex+1)%_rs.searchResults.length;renderPage(_rs.searchResults[_rs.searchIndex]);_dom.searchCount.textContent=`${_rs.searchIndex+1}/${_rs.searchResults.length}`;}
function prevSearchResult(){if(!_rs.searchResults.length||_rs.searchIndex<0)return;_rs.searchIndex=(_rs.searchIndex-1+_rs.searchResults.length)%_rs.searchResults.length;renderPage(_rs.searchResults[_rs.searchIndex]);_dom.searchCount.textContent=`${_rs.searchIndex+1}/${_rs.searchResults.length}`;}

// Bookmarks
async function toggleBookmark(){
  const docId=_rs.docId;const page=_rs.currentPage;
  if(!docId)return;
  let pages=_bm[docId]||[];
  const idx=pages.indexOf(page);
  if(idx>-1){pages.splice(idx,1);toast(`Removed bookmark on page ${page}`);}
  else{pages.push(page);pages.sort((a,b)=>a-b);toast(`Bookmarked page ${page}`);}
  _bm[docId]=pages;
  await _BookmarkSave('bookmarks',{docId,pages});
  updateBookmarkIcon();
}
function updateBookmarkIcon(){const docId=_rs.docId;const page=_rs.currentPage;const pages=_bm[docId]||[];const active=pages.includes(page);_dom.bookmarkBtn.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="${active?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;_dom.bookmarkBtn.style.color=active?'var(--warning)':'';}
function showBookmarks(){const docId=_rs.docId;const pages=_bm[docId]||[];if(!pages.length){toast('No bookmarks yet');return;}
  const list=pages.map(p=>`<div class="bookmark-item" data-page="${p}"><div class="bookmark-item-num">${p}</div><span class="bookmark-item-text">Page ${p}</span><button class="bookmark-item-del" data-del="${p}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`).join('');
  openModal('Bookmarks',`<div class="bookmark-list">${list}</div>`);
  document.querySelectorAll('.bookmark-item').forEach(el=>el.addEventListener('click',e=>{if(!e.target.closest('.bookmark-item-del')){closeModal();renderPage(parseInt(el.dataset.page));}}));
  document.querySelectorAll('.bookmark-item-del').forEach(el=>el.addEventListener('click',async e=>{e.stopPropagation();const p=parseInt(el.dataset.del);let pages=_bm[docId]||[];const i=pages.indexOf(p);if(i>-1)pages.splice(i,1);_bm[docId]=pages;await _BookmarkSave('bookmarks',{docId,pages});updateBookmarkIcon();showBookmarks();toast(`Removed bookmark on page ${p}`);}));
}

// File Info

function parsePdfDate(d){
  if(!d)return null;
  if(d instanceof Date)return d;
  if(typeof d==='string'&&d.startsWith('D:')){
    try{
      const s=d.slice(2);
      const y=parseInt(s.slice(0,4)),m=parseInt(s.slice(4,6))-1,day=parseInt(s.slice(6,8));
      const h=parseInt(s.slice(8,10)||0),min=parseInt(s.slice(10,12)||0),sec=parseInt(s.slice(12,14)||0);
      const date=new Date(Date.UTC(y,m,day,h,min,sec));
      const off=s.slice(14);
      if(off&&off.length>=3){
        const sign=off[0]==='-'?-1:1;
        const oh=parseInt(off.slice(1,3)||0),om=parseInt(off.slice(3,5)||0);
        date.setTime(date.getTime()-sign*(oh*60+om)*60000);
      }
      return isNaN(date.getTime())?null:date;
    }catch(e){return null;}
  }
  try{const p=new Date(d);return isNaN(p.getTime())?null:p;}catch(e){return null;}
}

async function showFileInfo(){
  const file=State.files.find(f=>f.id===_rs.docId);if(!file)return;
  const pdf=_rs.pdf;if(!pdf)return;
  let info;
  try{info=await pdf.getMetadata();}catch(e){info={info:{}};}
  const rows=[{l:'Name',v:file.name},{l:'Size',v:fmtBytes(file.size)},{l:'Pages',v:_rs.totalPages},{l:'Title',v:info?.info?.Title||'—'},{l:'Author',v:info?.info?.Author||'—'},{l:'Created',v:parsePdfDate(info?.info?.CreationDate)?parsePdfDate(info?.info?.CreationDate).toLocaleDateString():'—'},{l:'Modified',v:timeAgo(file.date)}];
  openModal('File Information',`<div class="file-info-panel">${rows.map(r=>`<div class="file-info-row"><span class="file-info-label">${r.l}</span><span class="file-info-value">${esc(String(r.v))}</span></div>`).join('')}</div>`);
}

// Reader More Menu
function showReaderMenu(){
  const file=State.files.find(f=>f.id===_rs.docId);if(!file)return;
  openModal('Options','<div style="display:flex;flex-direction:column;gap:8px">'+
    '<button class="btn btn-secondary" id="menu-print" style="justify-content:flex-start"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print</button>'+
    '<button class="btn btn-secondary" id="menu-share" style="justify-content:flex-start"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share</button>'+
    '<button class="btn btn-secondary" id="menu-download" style="justify-content:flex-start"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download</button>'+
    '<button class="btn btn-danger" id="menu-delete" style="justify-content:flex-start"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>'+
  '</div>');
  $('#menu-print').addEventListener('click',()=>{window.print();closeModal();});
  $('#menu-share').addEventListener('click',async()=>{closeModal();if(navigator.share){try{await navigator.share({title:file.name,files:[file.blob]});}catch(e){}}else{toast('Share not supported');}});
  $('#menu-download').addEventListener('click',()=>{closeModal();downloadBlob(file.blob,file.name);toast('Downloading...');});
  $('#menu-delete').addEventListener('click',()=>{closeModal();const fid=file.id;if(_rs.docId===fid)destroyReader();deleteFile(fid);Router.go(PAGES.FILES);});
}

// ============================================
// PDF Editor
// ============================================

// ── Reader toolbar event wiring ───────────────────────────────────────────────
// Called once by app.js after DOM is ready.
export function wireReaderToolbar() {
  _dom.prev?.addEventListener('click',    prevPage);
  _dom.next?.addEventListener('click',    nextPage);
  _dom.zoomIn?.addEventListener('click',  zoomIn);
  _dom.zoomOut?.addEventListener('click', zoomOut);
  _dom.thumbsBtn?.addEventListener('click', () => _dom.sidebar?.classList.toggle('open'));
  _dom.pageInput?.addEventListener('change', e => goToPage(e.target.value));
  _dom.pageInput?.addEventListener('keydown', e => { if (e.key === 'Enter') goToPage(e.target.value); });
  _dom.searchToggle?.addEventListener('click', () => {
    _dom.searchBar?.classList.add('show'); _dom.searchInput?.focus();
  });
  _dom.searchClose?.addEventListener('click', () => {
    _dom.searchBar?.classList.remove('show');
    if (_dom.searchInput) _dom.searchInput.value = '';
    if (_dom.searchCount) _dom.searchCount.textContent = '';
  });
  _dom.searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') searchInPDF(e.target.value); });
  _dom.searchPrev?.addEventListener('click', prevSearchResult);
  _dom.searchNext?.addEventListener('click', nextSearchResult);
  // Zoom chip: click to reset to fit
  if (_dom.zoomLevel) {
    _dom.zoomLevel.style.cursor = 'pointer';
    _dom.zoomLevel.title = 'Click to reset zoom';
    _dom.zoomLevel.addEventListener('click', () => { if (_rs.pdf) _animateToVisual(_rs.scale); });
  }
  log.info('Reader toolbar wired');
}

// ── Public API ────────────────────────────────────────────────────────────────
export const ReaderModule = {
  open:        fileId   => openReader(fileId),
  close:       ()       => destroyReader(),
  goToPage:    n        => goToPage(n),
  zoomIn:      ()       => zoomIn(),
  zoomOut:     ()       => zoomOut(),
  search:      q        => searchInPDF(q),
  nextResult:  ()       => nextSearchResult(),
  prevResult:  ()       => prevSearchResult(),
  get currentPage()     { return _rs.currentPage; },
  get totalPages()      { return _rs.totalPages; },
  // Exposed for gesture engine (gestures.js imports this module)
  get _rs()             { return _rs; },
  get _dom()            { return _dom; },
  renderPage:           (n, force) => renderPage(n, force),
  _applyTransform,
  _clampTransform,
  _centerCanvas,
  _zoomAt,
  _animateToVisual,
  updateZoomDisplay,
  prevPage,
  nextPage,
  handleDoubleTap,
};
