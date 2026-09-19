/**
 * FYLO Feature — PDF Editor (Production Grade)
 *
 * Fixes vs previous version:
 *   1. Save syntax error (mismatched bracket in bus.emit)
 *   2. Coordinate system: now normalized (0-1 ratios), DPR-independent
 *   3. Multi-page save: each annotation carries its own canvasW/canvasH
 *   4. _dom.canvasWrap undefined: replaced with _dom.wrap throughout
 *   5. setupEditorOverlay getter reassignment: replaced with AbortController
 *   6. Text position double-DPR: uses same normalized coord system
 *   7. Page navigation: prev/next/input wired in wireEditorToolbar
 *   8. Undo on tap: only push undo if annotation actually moved
 *   9. Signature HTMLImageElement: stores dataUrl string, reconstructs on draw
 *  10. Eraser batches drag-erase into single undo operation
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State } from '../../core/state.js';
import { Libs } from '../../core/libs.js';
import { Router } from '../../core/router.js';
import { PAGES, EDITOR_HIGHLIGHT_COLORS, EDITOR_DEFAULT_COLOR, EDITOR_DEFAULT_STROKE }
  from '../../core/constants.js';
import { toast, downloadBlob, openModal, closeModal, generateId } from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Editor');

// ── DOM refs — lazy getters, never cached ─────────────────────────────────────
const _dom = {
  get canvas()     { return document.getElementById('editor-canvas'); },
  get overlay()    { return document.getElementById('editor-overlay'); },
  get wrap()       { return document.getElementById('editor-canvas-wrap'); },
  get toolbar()    { return document.getElementById('editor-toolbar'); },
  get undo()       { return document.getElementById('editor-undo'); },
  get redo()       { return document.getElementById('editor-redo'); },
  get save()       { return document.getElementById('editor-save'); },
  get cancel()     { return document.getElementById('editor-cancel'); },
  get colorBtn()   { return document.getElementById('editor-color-btn'); },
  get strokeSel()  { return document.getElementById('editor-stroke-sel'); },
  get pageInput()  { return document.getElementById('editor-page-input'); },
  get totalPages() { return document.getElementById('editor-total-pages'); },
  get prevBtn()    { return document.getElementById('editor-prev'); },
  get nextBtn()    { return document.getElementById('editor-next'); },
};

// ── Module-private state ──────────────────────────────────────────────────────
const _es = {
  pdf: null, currentPage: 1, totalPages: 0,
  scale: 1.2, tool: 'select', docId: null,
  isRendering: false, renderTask: null,
  annotations: [],
  undoStack: [], redoStack: [],
  selectedId: null,
  isDrawing: false,
  livePath: [], liveStart: {x:0,y:0},
  color: EDITOR_DEFAULT_COLOR,
  strokeWidth: EDITOR_DEFAULT_STROKE,
  opacity: 1.0,
  savedSignature: null,
  textInput: null,
  drag: null,
  _drawRaf: null,
  _committingText: false,
  _erasing: false,
  _eraseBatch: null,
};

// ── Coordinate helpers ────────────────────────────────────────────────────────
// All annotations stored as normalized 0..1 ratios of canvas physical size.
// This makes coordinates DPR-independent and page-size-independent.

function _cvW() { return _dom.canvas?.width  || 1; }
function _cvH() { return _dom.canvas?.height || 1; }

function _toNorm(px, py, cW, cH) { return { nx: px/cW, ny: py/cH }; }

function _canvasPos(e) {
  const ov = _dom.overlay;
  if (!ov) return {x:0,y:0};
  const rect = ov.getBoundingClientRect();
  const touch = e.touches?.[0] || e.changedTouches?.[0];
  const cx = touch ? touch.clientX : e.clientX;
  const cy = touch ? touch.clientY : e.clientY;
  return {
    x: (cx - rect.left) * (ov.width  / rect.width),
    y: (cy - rect.top)  * (ov.height / rect.height),
  };
}

function _annStyle() {
  return { color: _es.color, width: _es.strokeWidth, opacity: _es.opacity };
}

// Deep clone — no HTMLImageElement, dataUrl survives
function _cloneAnns(anns) {
  return anns.map(a => {
    const c = Object.assign({}, a);
    c.style = Object.assign({}, a.style);
    if (a.points) c.points = a.points.map(p => ({nx:p.nx,ny:p.ny}));
    delete c._img;
    return c;
  });
}

function _pushUndo() {
  _es.undoStack.push(_cloneAnns(_es.annotations));
  if (_es.undoStack.length > 50) _es.undoStack.shift();
  _es.redoStack = [];
}

// ── Overlay sync ──────────────────────────────────────────────────────────────
function _syncOverlay() {
  const cv = _dom.canvas, ov = _dom.overlay, wrap = _dom.wrap;
  if (!cv || !ov || !wrap) return;
  ov.width  = cv.width;  ov.height = cv.height;
  ov.style.width  = cv.style.width;
  ov.style.height = cv.style.height;
  ov.style.position = 'absolute';
  const cvR = cv.getBoundingClientRect(), wR = wrap.getBoundingClientRect();
  ov.style.left = (cvR.left - wR.left + wrap.scrollLeft) + 'px';
  ov.style.top  = (cvR.top  - wR.top  + wrap.scrollTop)  + 'px';
}

// ── Rendering helpers ─────────────────────────────────────────────────────────
function _px(ann, nx) { return nx * (ann.canvasW || _cvW()); }
function _py(ann, ny) { return ny * (ann.canvasH || _cvH()); }

function _redrawAnnotations(overrideSelected) {
  const ov = _dom.overlay;
  if (!ov || !ov.width) return;
  const ctx   = ov.getContext('2d');
  const selId = overrideSelected ?? _es.selectedId;
  ctx.clearRect(0, 0, ov.width, ov.height);
  _es.annotations
    .filter(a => a.page === _es.currentPage)
    .forEach(a => _drawAnnotation(ctx, a, a.id === selId));
}

function _drawAnnotation(ctx, ann, selected) {
  ctx.save();
  switch (ann.type) {
    case 'highlight':
      ctx.globalAlpha = 0.35;
      ctx.fillStyle   = ann.style.color;
      ctx.fillRect(_px(ann,ann.nx), _py(ann,ann.ny), _px(ann,ann.nw), _py(ann,ann.nh));
      break;
    case 'underline':
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ann.style.color;
      ctx.lineWidth   = ann.style.width;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(_px(ann,ann.nx1), _py(ann,ann.ny1));
      ctx.lineTo(_px(ann,ann.nx2), _py(ann,ann.ny2));
      ctx.stroke();
      break;
    case 'draw':
      if (!ann.points || ann.points.length < 2) break;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ann.style.color;
      ctx.lineWidth   = ann.style.width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(_px(ann,ann.points[0].nx), _py(ann,ann.points[0].ny));
      for (let i = 1; i < ann.points.length; i++) {
        const mx = (_px(ann,ann.points[i-1].nx) + _px(ann,ann.points[i].nx)) / 2;
        const my = (_py(ann,ann.points[i-1].ny) + _py(ann,ann.points[i].ny)) / 2;
        ctx.quadraticCurveTo(_px(ann,ann.points[i-1].nx), _py(ann,ann.points[i-1].ny), mx, my);
      }
      ctx.lineTo(_px(ann,ann.points[ann.points.length-1].nx), _py(ann,ann.points[ann.points.length-1].ny));
      ctx.stroke();
      break;
    case 'text':
      ctx.globalAlpha = 1;
      ctx.font        = `${ann.fontSize}px ${ann.fontFamily||'Inter,sans-serif'}`;
      ctx.fillStyle   = ann.style.color;
      ann.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, _px(ann,ann.nx), _py(ann,ann.ny) + i * ann.fontSize * 1.3);
      });
      break;
    case 'signature':
      if (ann.dataUrl) {
        if (!ann._img || ann._img._src !== ann.dataUrl) {
          ann._img = new Image(); ann._img._src = ann.dataUrl;
          ann._img.onload = () => _redrawAnnotations();
          ann._img.src = ann.dataUrl;
        }
        if (ann._img.complete && ann._img.naturalWidth) {
          ctx.globalAlpha = 1;
          ctx.drawImage(ann._img, _px(ann,ann.nx), _py(ann,ann.ny), _px(ann,ann.nw), _py(ann,ann.nh));
        }
      }
      break;
  }
  if (selected) {
    const b = _annBounds(ann);
    if (b) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(79,140,255,0.95)'; ctx.lineWidth = 2;
      ctx.setLineDash([5,3]);
      ctx.strokeRect(b.x-4, b.y-4, b.w+8, b.h+8);
      ctx.setLineDash([]);
      // Delete handle
      ctx.fillStyle = 'rgba(220,50,50,0.95)';
      ctx.beginPath(); ctx.arc(b.x+b.w+8, b.y-8, 10, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='white'; ctx.font='bold 14px sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('×', b.x+b.w+8, b.y-8);
      // Resize handle (signature/text only)
      if (ann.type==='signature'||ann.type==='text') {
        ctx.fillStyle='rgba(79,140,255,0.95)';
        ctx.fillRect(b.x+b.w+1, b.y+b.h+1, 14, 14);
        ctx.fillStyle='white'; ctx.font='10px sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('↔', b.x+b.w+8, b.y+b.h+8);
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

function _annBounds(ann) {
  switch (ann.type) {
    case 'highlight':
      return {x:_px(ann,ann.nx), y:_py(ann,ann.ny), w:_px(ann,ann.nw), h:_py(ann,ann.nh)};
    case 'underline': {
      const x1=_px(ann,ann.nx1),y1=_py(ann,ann.ny1),x2=_px(ann,ann.nx2),y2=_py(ann,ann.ny2);
      return {x:Math.min(x1,x2)-4, y:Math.min(y1,y2)-6, w:Math.abs(x2-x1)+8, h:Math.max(12,ann.style.width*2+8)};
    }
    case 'draw': {
      if (!ann.points?.length) return null;
      const xs=ann.points.map(p=>_px(ann,p.nx)), ys=ann.points.map(p=>_py(ann,p.ny));
      const pad=ann.style.width;
      return {x:Math.min(...xs)-pad, y:Math.min(...ys)-pad, w:Math.max(...xs)-Math.min(...xs)+pad*2, h:Math.max(...ys)-Math.min(...ys)+pad*2};
    }
    case 'text':
      return {x:_px(ann,ann.nx), y:_py(ann,ann.ny)-ann.fontSize, w:_px(ann,ann.nTextW||0.1)||80, h:_py(ann,ann.nTextH||0.05)||ann.fontSize*1.5};
    case 'signature':
      return {x:_px(ann,ann.nx), y:_py(ann,ann.ny), w:_px(ann,ann.nw), h:_py(ann,ann.nh)};
    default: return null;
  }
}

function _hitTest(px, py) {
  const pageAnns = _es.annotations.filter(a => a.page === _es.currentPage);
  if (_es.selectedId) {
    const sel = pageAnns.find(a => a.id === _es.selectedId);
    if (sel) {
      const b = _annBounds(sel);
      if (b) {
        if (Math.hypot(px-(b.x+b.w+8), py-(b.y-8)) < 13) return {__delete:true, ann:sel};
        if ((sel.type==='signature'||sel.type==='text') &&
            px>=b.x+b.w+1&&px<=b.x+b.w+15&&py>=b.y+b.h+1&&py<=b.y+b.h+15)
          return {__resize:true, ann:sel};
      }
    }
  }
  for (let i=pageAnns.length-1; i>=0; i--) {
    const b = _annBounds(pageAnns[i]);
    if (b && px>=b.x-6&&py>=b.y-6&&px<=b.x+b.w+6&&py<=b.y+b.h+6) return pageAnns[i];
  }
  return null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
function destroyEditor() {
  if (_overlayAbort) { _overlayAbort.abort(); _overlayAbort = null; }
  const e = _es;
  if (e.renderTask) { try{e.renderTask.cancel();}catch{} e.renderTask=null; }
  if (e._drawRaf)   { cancelAnimationFrame(e._drawRaf); e._drawRaf=null; }
  if (e.pdf)        { try{e.pdf.destroy();}catch{} e.pdf=null; }
  if (e.textInput)  { e.textInput.remove(); e.textInput=null; }
  _closeColorPopup();
  Object.assign(e, {
    annotations:[], undoStack:[], redoStack:[],
    selectedId:null, isDrawing:false, livePath:[],
    isRendering:false, currentPage:1, totalPages:0,
    docId:null, drag:null, _erasing:false, _eraseBatch:null,
    _committingText:false,
  });
  const cv=_dom.canvas, ov=_dom.overlay;
  if (cv){cv.getContext('2d').clearRect(0,0,cv.width,cv.height); cv.width=1;cv.height=1;cv.style.width='';cv.style.height='';}
  if (ov){ov.width=1;ov.height=1;ov.style.left='0';ov.style.top='0';ov.className='';}
}

async function openEditor(fileId, tool='select') {
  const file = State.files.find(f=>f.id===fileId);
  if (!file)      { toast('File not found'); return; }
  if (!file.blob) { toast('File data unavailable'); return; }
  if (!await Libs.waitForPdfJs()) { toast('PDF.js not loaded.'); return; }

  destroyEditor();
  _es.docId = fileId; _es.tool = tool;

  if (tool==='highlight')               _es.color='rgba(255,179,0,1)';
  else if (tool==='underline'||tool==='draw') _es.color='#4F8CFF';
  else if (tool==='text')               _es.color='#222222';
  else if (tool==='signature')          _es.color='#111111';
  else                                  _es.color='#FFB300';

  if (_dom.colorBtn) _dom.colorBtn.style.background = _es.color;
  _updateToolbarActive(tool);
  _initOverlayListeners();
  Router.go(PAGES.EDITOR);
  toast('Loading PDF for editing…');

  try {
    const ab  = await file.blob.arrayBuffer();
    const pdf = await Libs.pdfjs.getDocument({data:ab}).promise;
    _es.pdf = pdf; _es.totalPages = pdf.numPages; _es.currentPage = 1;

    // Auto-fit scale
    const fp = await pdf.getPage(1);
    const nv = fp.getViewport({scale:1});
    const wrap = _dom.wrap;
    if (wrap) {
      const fit = Math.min((wrap.clientWidth-32)/nv.width, (wrap.clientHeight-32)/nv.height);
      _es.scale = Math.max(0.5, Math.min(2.5, fit));
    }

    _updatePageUI();
    await renderEditorPage(1);
    toast('Ready to edit');
  } catch(err) {
    console.error(err); toast('Failed to load for editing'); destroyEditor();
  }
}

function _updateToolbarActive(tool) {
  _dom.toolbar?.querySelectorAll('.editor-tool-btn[data-edit]').forEach(b => {
    b.classList.toggle('active', b.dataset.edit===tool);
  });
  const ov = _dom.overlay;
  if (ov) ov.className = 'tool-'+tool;
}

function _updatePageUI() {
  if (_dom.pageInput)  _dom.pageInput.value = _es.currentPage;
  if (_dom.totalPages) _dom.totalPages.textContent = _es.totalPages;
  if (_dom.prevBtn)    _dom.prevBtn.disabled = _es.currentPage <= 1;
  if (_dom.nextBtn)    _dom.nextBtn.disabled = _es.currentPage >= _es.totalPages;
}

async function renderEditorPage(num) {
  const e = _es;
  if (!e.pdf||num<1||num>e.totalPages) return;
  if (e.renderTask){try{e.renderTask.cancel();}catch{} e.renderTask=null;}
  e.isRendering = true;
  try {
    const page = await e.pdf.getPage(num);
    const cv   = _dom.canvas, ctx = cv.getContext('2d');
    const dpr  = window.devicePixelRatio||1;
    const vp   = page.getViewport({scale:e.scale*dpr});
    cv.width=vp.width; cv.height=vp.height;
    cv.style.width=(vp.width/dpr)+'px'; cv.style.height=(vp.height/dpr)+'px';
    ctx.fillStyle='#FFFFFF'; ctx.fillRect(0,0,cv.width,cv.height);
    e.renderTask = page.render({canvasContext:ctx,viewport:vp});
    await e.renderTask.promise;
    e.renderTask=null; e.currentPage=num;
    requestAnimationFrame(()=>{ _syncOverlay(); _redrawAnnotations(); _updatePageUI(); });
  } catch(err) {
    if (err?.name==='RenderingCancelledException') return;
    console.error('Editor render:',err); toast('Render failed');
  } finally { e.isRendering=false; }
}

// ── Overlay listeners via AbortController (no DOM node replacement) ───────────
let _overlayAbort = null;

function _initOverlayListeners() {
  if (_overlayAbort) _overlayAbort.abort();
  _overlayAbort = new AbortController();
  const sig = {signal:_overlayAbort.signal};
  const ov  = _dom.overlay;
  if (!ov) return;
  ov.addEventListener('pointerdown',   _edPointerDown,   {passive:false,...sig});
  ov.addEventListener('pointermove',   _edPointerMove,   {passive:false,...sig});
  ov.addEventListener('pointerup',     _edPointerUp,     {passive:false,...sig});
  ov.addEventListener('pointercancel', _edPointerCancel, {passive:true,...sig});
}

// ── Pointer handlers ──────────────────────────────────────────────────────────
function _edPointerDown(e) {
  e.preventDefault();
  const ed=_es;
  if (ed.textInput){_commitText();return;}
  try{_dom.overlay?.setPointerCapture(e.pointerId);}catch{}
  const pos = _canvasPos(e);

  if (ed.tool==='select') {
    const hit=_hitTest(pos.x,pos.y);
    if (hit?.__delete) {
      _pushUndo(); ed.annotations=ed.annotations.filter(a=>a.id!==hit.ann.id);
      ed.selectedId=null; _redrawAnnotations(); return;
    }
    if (hit?.__resize) {
      ed.selectedId=hit.ann.id;
      const b=_annBounds(hit.ann);
      ed.drag={annId:hit.ann.id,ox:pos.x,oy:pos.y,startAnn:_cloneAnns([hit.ann])[0],
               mode:'resize',originX:b.x,originY:b.y,moved:false};
      _redrawAnnotations(); return;
    }
    if (hit&&!hit.__delete&&!hit.__resize) {
      ed.selectedId=hit.id;
      ed.drag={annId:hit.id,ox:pos.x,oy:pos.y,startAnn:_cloneAnns([hit])[0],mode:'move',moved:false};
    } else {ed.selectedId=null;ed.drag=null;}
    _redrawAnnotations(); return;
  }

  if (ed.tool==='eraser') {
    ed._erasing=true; ed._eraseBatch=new Set(); _eraseAt(pos.x,pos.y); return;
  }
  if (ed.tool==='text')      {_placeTextInput(pos.x,pos.y);return;}
  if (ed.tool==='signature') {_openSignatureModal(pos.x,pos.y);return;}

  ed.isDrawing=true; ed.liveStart={x:pos.x,y:pos.y}; ed.livePath=[{x:pos.x,y:pos.y}];
}

function _edPointerMove(e) {
  e.preventDefault();
  const ed=_es, pos=_canvasPos(e);

  if (ed.tool==='select'&&ed.drag) {
    const ann=ed.annotations.find(a=>a.id===ed.drag.annId);
    if (!ann) return;
    ed.drag.moved=true;
    const cW=ann.canvasW||_cvW(), cH=ann.canvasH||_cvH();
    const dnx=(pos.x-ed.drag.ox)/cW, dny=(pos.y-ed.drag.oy)/cH;
    const src=ed.drag.startAnn;
    if (ed.drag.mode==='resize') {
      const nw=Math.max(20/cW,(pos.x-ed.drag.originX)/cW);
      const nh=Math.max(10/cH,(pos.y-ed.drag.originY)/cH);
      if (ann.type==='signature'){ann.nw=nw;ann.nh=nh;}
      if (ann.type==='text'){ann.nTextW=nw;ann.nTextH=nh;ann.fontSize=Math.max(8,Math.round(nh*cH/1.3));}
      _redrawAnnotations(); return;
    }
    switch(ann.type){
      case 'highlight': ann.nx=src.nx+dnx;ann.ny=src.ny+dny;break;
      case 'underline': ann.nx1=src.nx1+dnx;ann.ny1=src.ny1+dny;ann.nx2=src.nx2+dnx;ann.ny2=src.ny2+dny;break;
      case 'draw': if(src.points)ann.points=src.points.map(p=>({nx:p.nx+dnx,ny:p.ny+dny}));break;
      case 'text': ann.nx=src.nx+dnx;ann.ny=src.ny+dny;break;
      case 'signature': ann.nx=src.nx+dnx;ann.ny=src.ny+dny;break;
    }
    _redrawAnnotations(); return;
  }

  if (ed.tool==='eraser'&&ed._erasing){_eraseAt(pos.x,pos.y);return;}
  if (!ed.isDrawing) return;

  ed.livePath.push({x:pos.x,y:pos.y});
  if (ed._drawRaf) return;
  ed._drawRaf=requestAnimationFrame(()=>{
    ed._drawRaf=null;
    const ov=_dom.overlay; if(!ov) return;
    const ctx=ov.getContext('2d');
    ctx.clearRect(0,0,ov.width,ov.height);
    _redrawAnnotations();
    ctx.save();
    const path=ed.livePath;
    if (ed.tool==='draw') {
      ctx.strokeStyle=ed.color;ctx.lineWidth=ed.strokeWidth;ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);
      for(let i=1;i<path.length;i++){
        const mx=(path[i-1].x+path[i].x)/2,my=(path[i-1].y+path[i].y)/2;
        ctx.quadraticCurveTo(path[i-1].x,path[i-1].y,mx,my);
      }
      ctx.lineTo(path[path.length-1].x,path[path.length-1].y);ctx.stroke();
    } else if (ed.tool==='highlight') {
      const cur=path[path.length-1];
      ctx.globalAlpha=0.35;ctx.fillStyle=ed.color;
      ctx.fillRect(Math.min(ed.liveStart.x,cur.x),Math.min(ed.liveStart.y,cur.y),
        Math.abs(cur.x-ed.liveStart.x),Math.abs(cur.y-ed.liveStart.y));
    } else if (ed.tool==='underline') {
      const cur=path[path.length-1];
      ctx.strokeStyle=ed.color;ctx.lineWidth=ed.strokeWidth;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(ed.liveStart.x,ed.liveStart.y);ctx.lineTo(cur.x,cur.y);ctx.stroke();
    }
    ctx.restore();
  });
}

function _edPointerUp(e) {
  const ed=_es, pos=_canvasPos(e);
  if (ed.tool==='eraser'){
    if(ed._eraseBatch?.size>0)_pushUndo();
    ed._erasing=false;ed._eraseBatch=null;return;
  }
  if (ed.tool==='select'){
    if(ed.drag){if(ed.drag.moved)_pushUndo();ed.drag=null;}return;
  }
  if (!ed.isDrawing) return;
  ed.isDrawing=false;
  if(ed._drawRaf){cancelAnimationFrame(ed._drawRaf);ed._drawRaf=null;}

  ed.livePath.push({x:pos.x,y:pos.y});
  const cW=_cvW(),cH=_cvH();
  _pushUndo();

  if (ed.tool==='draw'&&ed.livePath.length>=2) {
    ed.annotations.push({id:generateId(),type:'draw',page:ed.currentPage,
      canvasW:cW,canvasH:cH,
      points:ed.livePath.map(p=>({nx:p.x/cW,ny:p.y/cH})),
      style:_annStyle()});
  } else if (ed.tool==='highlight') {
    const cur=ed.livePath[ed.livePath.length-1];
    const x=Math.min(ed.liveStart.x,cur.x),y=Math.min(ed.liveStart.y,cur.y);
    const w=Math.abs(cur.x-ed.liveStart.x),h=Math.abs(cur.y-ed.liveStart.y);
    if(w>4&&h>4) ed.annotations.push({id:generateId(),type:'highlight',page:ed.currentPage,
      canvasW:cW,canvasH:cH,nx:x/cW,ny:y/cH,nw:w/cW,nh:h/cH,style:_annStyle()});
  } else if (ed.tool==='underline') {
    const cur=ed.livePath[ed.livePath.length-1];
    if(Math.hypot(cur.x-ed.liveStart.x,cur.y-ed.liveStart.y)>4)
      ed.annotations.push({id:generateId(),type:'underline',page:ed.currentPage,
        canvasW:cW,canvasH:cH,
        nx1:ed.liveStart.x/cW,ny1:ed.liveStart.y/cH,nx2:cur.x/cW,ny2:cur.y/cH,
        style:_annStyle()});
  }
  ed.livePath=[];
  _redrawAnnotations();
}

function _edPointerCancel() {
  _es.isDrawing=false;_es.livePath=[];_es._erasing=false;_es._eraseBatch=null;
  if(_es._drawRaf){cancelAnimationFrame(_es._drawRaf);_es._drawRaf=null;}
  _redrawAnnotations();
}

function _eraseAt(px,py) {
  const hit=_hitTest(px,py);
  if(hit&&!hit.__delete&&!hit.__resize&&!_es._eraseBatch?.has(hit.id)){
    _es._eraseBatch?.add(hit.id);
    _es.annotations=_es.annotations.filter(a=>a.id!==hit.id);
    _redrawAnnotations();
  }
}

// ── Text tool ─────────────────────────────────────────────────────────────────
function _placeTextInput(px,py) {
  const ed=_es;
  if(ed.textInput)_commitText();
  const dpr=window.devicePixelRatio||1;
  const inp=document.createElement('textarea');
  inp.className='editor-text-input';
  inp.rows=1;inp.placeholder='Type text… (Enter=confirm, Shift+Enter=newline)';
  inp.style.left=(px/dpr)+'px';inp.style.top=(py/dpr)+'px';
  inp.style.color=ed.color;inp.style.position='absolute';
  const wrap=_dom.wrap;if(wrap)wrap.appendChild(inp);
  inp.focus();ed.textInput=inp;
  inp.addEventListener('input',()=>{inp.style.height='auto';inp.style.height=inp.scrollHeight+'px';});
  inp.addEventListener('keydown',ev=>{
    if(ev.key==='Escape'){ev.preventDefault();inp.remove();ed.textInput=null;}
    if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();_commitText();}
  });
  inp.addEventListener('blur',()=>{setTimeout(()=>{if(ed.textInput===inp)_commitText();},200);});
}

function _commitText() {
  const ed=_es;
  if(!ed.textInput||ed._committingText)return;
  ed._committingText=true;
  const val=ed.textInput.value.trim();
  if(val){
    const ov=_dom.overlay;
    const dpr=window.devicePixelRatio||1;
    const cW=_cvW(),cH=_cvH();
    const rect=ov?.getBoundingClientRect()||{left:0,top:0,width:1,height:1};
    const inpRect=ed.textInput.getBoundingClientRect();
    const scaleX=ov.width/rect.width,scaleY=ov.height/rect.height;
    const px=(inpRect.left-rect.left)*scaleX;
    const py=(inpRect.top-rect.top)*scaleY;
    const fontSize=Math.round(14*dpr);
    const ctx=ov?.getContext('2d');
    if(ctx)ctx.font=`${fontSize}px Inter,sans-serif`;
    const lines=val.split('\n');
    const maxCW=ctx?Math.max(...lines.map(l=>ctx.measureText(l).width)):80;
    _pushUndo();
    ed.annotations.push({id:generateId(),type:'text',page:ed.currentPage,
      canvasW:cW,canvasH:cH,
      nx:px/cW,ny:(py+fontSize)/cH,
      text:val,fontSize,fontFamily:'Inter,sans-serif',
      nTextW:maxCW/cW,nTextH:(lines.length*fontSize*1.3)/cH,
      style:_annStyle()});
  }
  ed.textInput.remove();ed.textInput=null;ed._committingText=false;
  _redrawAnnotations();
}

// ── Signature tool ────────────────────────────────────────────────────────────
function _placeSignatureFromDataUrl(dataUrl,dropX,dropY){
  const img=new Image();
  img.onload=()=>{
    const cW=_cvW(),cH=_cvH();
    const sw=Math.min(img.width,Math.round(cW*0.35));
    const sh=Math.round(sw*img.height/img.width);
    _pushUndo();
    _es.annotations.push({id:generateId(),type:'signature',page:_es.currentPage,
      canvasW:cW,canvasH:cH,
      nx:(dropX-sw/2)/cW,ny:(dropY-sh/2)/cH,nw:sw/cW,nh:sh/cH,
      dataUrl,style:_annStyle()});
    _redrawAnnotations();
  };
  img.src=dataUrl;
}

function _openSignatureModal(dropX,dropY){
  const ed=_es;
  if(ed.savedSignature){_placeSignatureFromDataUrl(ed.savedSignature,dropX,dropY);return;}
  openModal('Draw Your Signature',
    `<p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Draw with finger or mouse:</p>
     <canvas id="sig-canvas" style="width:100%;height:180px;background:#fff;border-radius:8px;touch-action:none;cursor:crosshair;display:block"></canvas>
     <div style="display:flex;gap:12px;margin-top:10px;align-items:center">
       <button class="btn btn-secondary" id="sig-clear" style="flex:1">Clear</button>
       <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">
         <input type="checkbox" id="sig-save"> Save for reuse</label>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary" id="sig-confirm">Place Signature</button>`);
  const sc=document.getElementById('sig-canvas');
  sc.width=480;sc.height=180;
  const sctx=sc.getContext('2d');
  sctx.fillStyle='#FFFFFF';sctx.fillRect(0,0,sc.width,sc.height);
  sctx.strokeStyle='#111';sctx.lineWidth=2.5;sctx.lineCap='round';sctx.lineJoin='round';
  let sigDrawing=false,sigHasContent=false;
  function getSigPos(ev){const r=sc.getBoundingClientRect();const t=ev.touches?.[0]||ev;return{x:(t.clientX-r.left)*(sc.width/r.width),y:(t.clientY-r.top)*(sc.height/r.height)};}
  sc.addEventListener('pointerdown',ev=>{sigDrawing=true;const p=getSigPos(ev);sctx.beginPath();sctx.moveTo(p.x,p.y);try{sc.setPointerCapture(ev.pointerId);}catch{}});
  sc.addEventListener('pointermove',ev=>{if(!sigDrawing)return;const p=getSigPos(ev);sctx.lineTo(p.x,p.y);sctx.stroke();sigHasContent=true;});
  sc.addEventListener('pointerup',()=>{sigDrawing=false;});
  document.getElementById('sig-clear').addEventListener('click',()=>{sctx.fillStyle='#FFFFFF';sctx.fillRect(0,0,sc.width,sc.height);sigHasContent=false;});
  document.querySelector('.modal-cancel')?.addEventListener('click',closeModal);
  document.getElementById('sig-confirm').addEventListener('click',()=>{
    if(!sigHasContent){toast('Please draw a signature first');return;}
    const dataUrl=sc.toDataURL('image/png');
    if(document.getElementById('sig-save').checked)ed.savedSignature=dataUrl;
    closeModal();
    _placeSignatureFromDataUrl(dataUrl,dropX,dropY);
  });
}

// ── Color palette ─────────────────────────────────────────────────────────────
const _PALETTE=['#FFB300','#FF5252','#4F8CFF','#00C853','#7B61FF','#FF6D00',
                '#00B0FF','#FF4081','#69F0AE','#EEFF41','#111111','#FFFFFF'];
let _colorPopup=null;
function _closeColorPopup(){if(_colorPopup){_colorPopup.remove();_colorPopup=null;}}
function _setEditorColor(c){_es.color=c;if(_dom.colorBtn)_dom.colorBtn.style.background=c;}

function _openColorPopup(){
  _closeColorPopup();
  const popup=document.createElement('div');
  popup.className='editor-color-popup';
  popup.innerHTML=`<div id="ecg" style="display:grid;grid-template-columns:repeat(6,26px);gap:5px"></div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--text-secondary)">
      Custom:<input type="color" id="ecc" value="${_es.color.startsWith('rgba')?'#FFB300':_es.color}"
        style="width:36px;height:26px;border:none;background:none;cursor:pointer;padding:0">
    </div>`;
  document.body.appendChild(popup);_colorPopup=popup;
  popup.querySelector('#ecg').childNodes.forEach&&null;
  _PALETTE.forEach(c=>{
    const sw=document.createElement('div');
    sw.style.cssText=`width:26px;height:26px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c===_es.color?'white':'transparent'};box-sizing:border-box;transition:transform .15s`;
    sw.addEventListener('click',()=>{_setEditorColor(c);_closeColorPopup();});
    sw.addEventListener('mouseenter',()=>sw.style.transform='scale(1.2)');
    sw.addEventListener('mouseleave',()=>sw.style.transform='');
    popup.querySelector('#ecg').appendChild(sw);
  });
  popup.querySelector('#ecc').addEventListener('input',ev=>_setEditorColor(ev.target.value));
  const btn=_dom.colorBtn?.getBoundingClientRect()||{bottom:40,left:8};
  popup.style.cssText+=`;position:fixed;top:${btn.bottom+6}px;left:${Math.max(8,btn.left-40)}px;z-index:200`;
  setTimeout(()=>document.addEventListener('pointerdown',function h(ev){
    if(!popup.contains(ev.target)){_closeColorPopup();document.removeEventListener('pointerdown',h);}
  }),50);
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────
function undoEditor(){if(!_es.undoStack.length){toast('Nothing to undo');return;}_es.redoStack.push(_cloneAnns(_es.annotations));_es.annotations=_es.undoStack.pop();_es.selectedId=null;_redrawAnnotations();}
function redoEditor(){if(!_es.redoStack.length){toast('Nothing to redo');return;}_es.undoStack.push(_cloneAnns(_es.annotations));_es.annotations=_es.redoStack.pop();_es.selectedId=null;_redrawAnnotations();}

// ── Save pipeline ─────────────────────────────────────────────────────────────
async function saveEditor(){
  if(!_es.pdf){toast('No PDF loaded');return;}
  const file=State.files.find(f=>f.id===_es.docId);
  if(!file?.blob){toast('File data unavailable');return;}
  if(!await Libs.waitForPdfLib()){toast('PDF-Lib not loaded.');return;}
  if(!_es.annotations.length){toast('No annotations to save');return;}
  toast('Saving annotations…');
  try{
    const {PDFDocument,rgb,StandardFonts}=Libs.pdflib;
    const ab=await file.blob.arrayBuffer();
    const pdfDoc=await PDFDocument.load(ab,{ignoreEncryption:true});

    function parseColor(c){
      const tmp=document.createElement('canvas');tmp.width=tmp.height=1;
      const t=tmp.getContext('2d');t.fillStyle=c;t.fillRect(0,0,1,1);
      const d=t.getImageData(0,0,1,1).data;return rgb(d[0]/255,d[1]/255,d[2]/255);
    }

    for(const ann of _es.annotations){
      const idx=ann.page-1;
      if(idx<0||idx>=pdfDoc.getPageCount())continue;
      const pdfPage=pdfDoc.getPage(idx);
      const{width:pw,height:ph}=pdfPage.getSize();
      // Normalized → PDF units. PDF Y=0 is bottom.
      const pdfX=nx=>nx*pw;
      const pdfY=ny=>ph-ny*ph;
      const pdfW=nw=>nw*pw;
      const pdfH=nh=>nh*ph;
      const col=parseColor(ann.style.color||'#000000');

      switch(ann.type){
        case 'highlight':
          pdfPage.drawRectangle({x:pdfX(ann.nx),y:pdfY(ann.ny+ann.nh),width:pdfW(ann.nw),height:pdfH(ann.nh),color:parseColor('#FFB300'),opacity:0.35});
          break;
        case 'underline':
          pdfPage.drawLine({start:{x:pdfX(ann.nx1),y:pdfY(ann.ny1)},end:{x:pdfX(ann.nx2),y:pdfY(ann.ny2)},
            thickness:Math.max(0.5,pdfW(ann.style.width/(ann.canvasW||1))),color:col});
          break;
        case 'draw':
          if(!ann.points?.length)break;
          for(let i=1;i<ann.points.length;i++){
            pdfPage.drawLine({
              start:{x:pdfX(ann.points[i-1].nx),y:pdfY(ann.points[i-1].ny)},
              end:{x:pdfX(ann.points[i].nx),y:pdfY(ann.points[i].ny)},
              thickness:Math.max(0.5,pdfW(ann.style.width/(ann.canvasW||1))),color:col});
          }
          break;
        case 'text':{
          const font=await pdfDoc.embedFont(StandardFonts.Helvetica);
          const ptSize=Math.max(6,ann.fontSize*(pw/(ann.canvasW||1)));
          ann.text.split('\n').forEach((line,i)=>{
            if(!line.trim())return;
            pdfPage.drawText(line,{x:pdfX(ann.nx),y:pdfY(ann.ny)-(i*ptSize*1.3),size:ptSize,font,color:col});
          });
          break;
        }
        case 'signature':
          if(!ann.dataUrl)break;
          try{
            const sigArr=await fetch(ann.dataUrl).then(r=>r.arrayBuffer());
            const embSig=await pdfDoc.embedPng(sigArr);
            pdfPage.drawImage(embSig,{x:pdfX(ann.nx),y:pdfY(ann.ny+ann.nh),width:pdfW(ann.nw),height:pdfH(ann.nh)});
          }catch(e){log.warn('Signature embed failed:',e);}
          break;
      }
    }
    const bytes=await pdfDoc.save();
    const blob=new Blob([bytes],{type:'application/pdf'});
    const outName=file.name.replace(/\.pdf$/i,'_annotated.pdf');
    downloadBlob(blob,outName);
    bus.emit('files:incoming',{files:[new File([blob],outName,{type:'application/pdf'})]});
    toast('Saved & downloaded!');
  }catch(err){console.error('Save failed:',err);toast('Save failed: '+err.message);}
}

// ── Toolbar wiring ────────────────────────────────────────────────────────────
export function wireEditorToolbar(){
  _dom.toolbar?.querySelectorAll('.editor-tool-btn[data-edit]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(_es.textInput)_commitText();
      _es.tool=btn.dataset.edit;_es.selectedId=null;
      _updateToolbarActive(_es.tool);
      const hlBar=document.getElementById('editor-hl-colors');
      if(hlBar)hlBar.classList.toggle('show',btn.dataset.edit==='highlight');
    });
  });

  const hlBar=document.getElementById('editor-hl-colors');
  if(hlBar&&!hlBar.childElementCount){
    const hlColors=EDITOR_HIGHLIGHT_COLORS.length?EDITOR_HIGHLIGHT_COLORS:
      ['rgba(255,179,0,1)','rgba(255,82,82,0.8)','rgba(79,140,255,0.8)',
       'rgba(0,200,83,0.8)','rgba(123,97,255,0.8)','rgba(0,188,212,0.8)'];
    hlColors.forEach((c,idx)=>{
      const dot=document.createElement('div');
      dot.className='hl-color-dot'+(idx===0?' active':'');
      dot.style.background=c;dot.title='Highlight color';
      dot.addEventListener('click',()=>{
        hlBar.querySelectorAll('.hl-color-dot').forEach(d=>d.classList.remove('active'));
        dot.classList.add('active');_setEditorColor(c);
        _es.tool='highlight';_updateToolbarActive('highlight');hlBar.classList.add('show');
      });
      hlBar.appendChild(dot);
    });
  }

  _dom.undo?.addEventListener('click',undoEditor);
  _dom.redo?.addEventListener('click',redoEditor);
  _dom.save?.addEventListener('click',saveEditor);
  _dom.cancel?.addEventListener('click',()=>{
    if(_es.annotations.length&&!confirm('Close editor? Unsaved annotations will be lost.'))return;
    destroyEditor();Router.go(State.prevPage||PAGES.FILES);
  });
  _dom.colorBtn?.addEventListener('click',_openColorPopup);
  _dom.strokeSel?.addEventListener('change',e=>{_es.strokeWidth=parseInt(e.target.value,10);});

  // Page navigation
  _dom.prevBtn?.addEventListener('click',()=>{
    if(_es.currentPage>1){if(_es.textInput)_commitText();renderEditorPage(_es.currentPage-1);}
  });
  _dom.nextBtn?.addEventListener('click',()=>{
    if(_es.currentPage<_es.totalPages){if(_es.textInput)_commitText();renderEditorPage(_es.currentPage+1);}
  });
  _dom.pageInput?.addEventListener('change',e=>{
    const n=parseInt(e.target.value,10);
    if(n>=1&&n<=_es.totalPages&&n!==_es.currentPage){if(_es.textInput)_commitText();renderEditorPage(n);}
    else e.target.value=_es.currentPage;
  });
  log.info('Editor toolbar wired');
}

// ── Public API ────────────────────────────────────────────────────────────────
export const EditorModule={
  open:(fileId,tool)=>openEditor(fileId,tool),
  close:()=>destroyEditor(),
  undo:()=>undoEditor(),
  redo:()=>redoEditor(),
  save:()=>saveEditor(),
  deleteSelected:()=>{
    if(!_es.selectedId)return;
    _pushUndo();
    _es.annotations=_es.annotations.filter(a=>a.id!==_es.selectedId);
    _es.selectedId=null;_redrawAnnotations();
  },
  get currentPage(){return _es.currentPage;},
  get totalPages(){return _es.totalPages;},
  get annotations(){return[..._es.annotations];},
  get hasAnnotations(){return _es.annotations.length>0;},
};
