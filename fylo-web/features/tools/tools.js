/**
 * FYLO Feature — PDF Tools  (Phase 2 — production rewrite)
 *
 * Every tool is a self-contained async function.
 * State for tool sessions lives in _tool (module-local), NOT on global State,
 * so switching tools or closing the modal always starts clean.
 */

import { bus, EVENTS }   from '../../core/eventBus.js';
import { State }         from '../../core/state.js';
import { Libs }          from '../../core/libs.js';
import { Router }        from '../../core/router.js';
import { PAGES }         from '../../core/constants.js';
import {
  toast, downloadBlob, openModal, closeModal,
  formatFileSize, generateId, $
} from '../../core/ui.js';
import { FileStorage }   from '../../core/storage.js';
import { createLogger }  from '../../core/logger.js';

const log = createLogger('Tools');

// ── Local helpers ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtBytes(b) { return formatFileSize(b); }

// ── Module-local tool session state (reset on every new tool flow) ────────────
const _tool = {
  mode:    '',    // current tool id
  files:   [],   // [{name, size, blob}] — files added from disk picker
  pageCount: 0,  // page count of loaded PDF (for rotate/delete/reorder)
  pageOrder: [], // current page order (1-based) for reorder
  selected:  new Set(), // selected page indices (0-based) for delete/rotate
  rotations: {}, // page-index → cumulative degrees (rotate preview)
  dragSrc:   null,
};

function _resetTool(mode) {
  _tool.mode      = mode;
  _tool.files     = [];
  _tool.pageCount = 0;
  _tool.pageOrder = [];
  _tool.selected  = new Set();
  _tool.rotations = {};
  _tool.dragSrc   = null;
}

// ── PDF-Lib rotation helper ────────────────────────────────────────────────────
// PDFLib's degrees() function wraps a number into a rotation object.
// We use it by accessing window.PDFLib.degrees directly.
function pdfDeg(n) {
  const { degrees } = Libs.pdflib;
  return degrees(((n % 360) + 360) % 360);
}

// ── Save output PDF and import it back into FYLO ─────────────────────────────
async function _saveAndImport(pdfDoc, filename) {
  const bytes = await pdfDoc.save();
  const blob  = new Blob([bytes], { type: 'application/pdf' });
  downloadBlob(blob, filename);
  // Also import into FYLO file library
  const file = new File([blob], filename, { type: 'application/pdf' });
  bus.emit('files:incoming', { files: [file] });
}

// ── Render page thumbnails in a grid ─────────────────────────────────────────
// Returns a container div with rendered page canvases.
// mode: 'select-multi'  (delete/rotate) — checkboxes, selection
//       'reorder'       — drag handles, draggable
async function _renderPageGrid(blob, mode, opts = {}) {
  if (!await Libs.waitForPdfJs()) return null;
  const ab  = await blob.arrayBuffer();
  const pdf = await Libs.pdfjs.getDocument({ data: ab }).promise;
  const n   = pdf.numPages;
  _tool.pageCount = n;
  if (mode === 'reorder' && !_tool.pageOrder.length) {
    _tool.pageOrder = Array.from({ length: n }, (_, i) => i + 1);
  }

  const grid = document.createElement('div');
  grid.className = 'page-grid';

  const renderPage = async (pageNum, item) => {
    try {
      const page = await pdf.getPage(pageNum);
      const vp   = page.getViewport({ scale: 0.35 });
      const c    = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const old = item.querySelector('canvas');
      if (old) old.replaceWith(c); else item.prepend(c);
    } catch(e) { log.warn('Page render failed:', e); }
  };

  const items = [];
  for (let i = 0; i < n; i++) {
    const pageNum = mode === 'reorder' ? _tool.pageOrder[i] : i + 1;
    const item = document.createElement('div');
    item.className = 'page-grid-item';
    item.dataset.idx = i;
    item.dataset.page = pageNum;

    const numEl = document.createElement('div');
    numEl.className = 'page-grid-item-num';
    numEl.textContent = pageNum;
    item.appendChild(numEl);

    if (mode === 'select-multi') {
      item.addEventListener('click', () => {
        if (_tool.selected.has(i)) {
          _tool.selected.delete(i);
          item.classList.remove('selected');
          item.querySelector('.page-grid-item-check')?.remove();
        } else {
          _tool.selected.add(i);
          item.classList.add('selected');
          const chk = document.createElement('div');
          chk.className = 'page-grid-item-check';
          chk.innerHTML = '✓';
          item.appendChild(chk);
        }
        opts.onSelectionChange?.(_tool.selected);
      });
    }

    if (mode === 'reorder') {
      item.draggable = true;
      item.style.cursor = 'grab';

      item.addEventListener('dragstart', e => {
        _tool.dragSrc = i;
        e.dataTransfer.effectAllowed = 'move';
        item.style.opacity = '0.5';
      });
      item.addEventListener('dragend', () => { item.style.opacity = '1'; });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (_tool.dragSrc === null || _tool.dragSrc === i) return;
        // Swap in pageOrder
        const arr = _tool.pageOrder;
        const tmp = arr[_tool.dragSrc];
        arr[_tool.dragSrc] = arr[i];
        arr[i] = tmp;
        _tool.dragSrc = null;
        // Re-render grid
        opts.onReorder?.(_tool.pageOrder);
      });

      // Touch reorder — simple up/down buttons for mobile
      const btnUp   = document.createElement('button');
      const btnDown = document.createElement('button');
      btnUp.className = 'page-grid-move-btn';
      btnDown.className = 'page-grid-move-btn';
      btnUp.title   = 'Move left';
      btnDown.title = 'Move right';
      btnUp.innerHTML   = '‹';
      btnDown.innerHTML = '›';
      btnUp.addEventListener('click', e => {
        e.stopPropagation();
        if (i === 0) return;
        const arr = _tool.pageOrder;
        [arr[i-1], arr[i]] = [arr[i], arr[i-1]];
        opts.onReorder?.(_tool.pageOrder);
      });
      btnDown.addEventListener('click', e => {
        e.stopPropagation();
        if (i === _tool.pageOrder.length - 1) return;
        const arr = _tool.pageOrder;
        [arr[i], arr[i+1]] = [arr[i+1], arr[i]];
        opts.onReorder?.(_tool.pageOrder);
      });
      item.appendChild(btnUp);
      item.appendChild(btnDown);
    }

    grid.appendChild(item);
    items.push({ item, pageNum });
  }

  // Render thumbnails in batches to avoid hammering memory
  const BATCH = 6;
  for (let b = 0; b < items.length; b += BATCH) {
    await Promise.all(items.slice(b, b + BATCH).map(({ item, pageNum }) =>
      renderPage(pageNum, item)
    ));
  }

  return grid;
}

// ============================================================
//  TOOL IMPLEMENTATIONS
// ============================================================

// ── MERGE ────────────────────────────────────────────────────
async function toolMerge(files) {
  if (!files || files.length < 2) { toast('Select at least 2 PDFs to merge'); return; }
  toast('Merging PDFs…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded. Check connection.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const merged = await PDFDocument.create();
    for (const file of files) {
      const ab  = await file.blob.arrayBuffer();
      let pdf;
      try { pdf = await PDFDocument.load(ab); }
      catch(e) { toast(`Cannot read ${file.name}: ${e.message}`); return; }
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    if (merged.getPageCount() === 0) { toast('Merge produced 0 pages — aborting.'); return; }
    const name = 'merged.pdf';
    await _saveAndImport(merged, name);
    toast(`Merged ${files.length} PDFs → ${merged.getPageCount()} pages`);
  } catch(e) { log.error('Merge failed:', e); toast('Merge failed: ' + e.message); }
}

// ── SPLIT ─────────────────────────────────────────────────────
async function toolSplit(file, splitAfter) {
  if (!file) { toast('Select a PDF'); return; }
  toast('Splitting PDF…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const ab  = await file.blob.arrayBuffer();
    const pdf = await PDFDocument.load(ab);
    const total = pdf.getPageCount();
    const sp = Math.max(1, Math.min(total - 1, Math.floor(splitAfter)));
    if (total < 2) { toast('PDF must have at least 2 pages to split.'); return; }

    const part1 = await PDFDocument.create();
    const p1 = await part1.copyPages(pdf, Array.from({ length: sp }, (_, i) => i));
    p1.forEach(p => part1.addPage(p));

    const part2 = await PDFDocument.create();
    const p2 = await part2.copyPages(pdf, Array.from({ length: total - sp }, (_, i) => i + sp));
    p2.forEach(p => part2.addPage(p));

    const base = file.name.replace(/\.pdf$/i, '');
    await _saveAndImport(part1, `${base}_part1.pdf`);
    await _saveAndImport(part2, `${base}_part2.pdf`);
    toast(`Split: ${sp} pages + ${total - sp} pages`);
  } catch(e) { log.error('Split failed:', e); toast('Split failed: ' + e.message); }
}

// ── ROTATE ────────────────────────────────────────────────────
async function toolRotate(file, pageIndices, degrees) {
  if (!file) { toast('Select a PDF'); return; }
  toast('Rotating pages…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const ab    = await file.blob.arrayBuffer();
    const pdf   = await PDFDocument.load(ab);
    const pages = pdf.getPages();

    const targets = (pageIndices === 'all')
      ? pages.map((_, i) => i)
      : pageIndices.filter(i => i >= 0 && i < pages.length);

    targets.forEach(i => {
      const page    = pages[i];
      const current = page.getRotation().angle;
      page.setRotation(pdfDeg(current + degrees));
    });

    if (pdf.getPageCount() === 0) { toast('Rotation produced 0 pages — aborting.'); return; }
    const base = file.name.replace(/\.pdf$/i, '');
    await _saveAndImport(pdf, `${base}_rotated.pdf`);
    toast(`Rotated ${targets.length} page${targets.length !== 1 ? 's' : ''} by ${degrees}°`);
  } catch(e) { log.error('Rotate failed:', e); toast('Rotation failed: ' + e.message); }
}

// ── DELETE PAGES ──────────────────────────────────────────────
async function toolDeletePages(file, pageIndices) {
  if (!file) { toast('Select a PDF'); return; }
  if (!pageIndices.length) { toast('No pages selected'); return; }
  toast('Deleting pages…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const ab    = await file.blob.arrayBuffer();
    const pdf   = await PDFDocument.load(ab);
    const total = pdf.getPageCount();
    const toDelete = new Set(pageIndices);
    const keep = Array.from({ length: total }, (_, i) => i).filter(i => !toDelete.has(i));

    if (keep.length === 0) {
      toast('Cannot delete all pages — PDF must have at least 1 page.'); return;
    }

    const out   = await PDFDocument.create();
    const pages = await out.copyPages(pdf, keep);
    pages.forEach(p => out.addPage(p));

    const base = file.name.replace(/\.pdf$/i, '');
    await _saveAndImport(out, `${base}_edited.pdf`);
    toast(`Deleted ${pageIndices.length} page${pageIndices.length !== 1 ? 's' : ''}`);
  } catch(e) { log.error('Delete pages failed:', e); toast('Delete failed: ' + e.message); }
}

// ── REORDER PAGES ─────────────────────────────────────────────
// newOrder: 1-based page numbers in desired output order
async function toolReorder(file, newOrder) {
  if (!file || !newOrder.length) { toast('No page order specified'); return; }
  toast('Reordering pages…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const ab    = await file.blob.arrayBuffer();
    const pdf   = await PDFDocument.load(ab);
    const total = pdf.getPageCount();
    const indices = newOrder.map(p => p - 1).filter(i => i >= 0 && i < total);
    if (indices.length === 0) { toast('Invalid page order.'); return; }

    const out   = await PDFDocument.create();
    const pages = await out.copyPages(pdf, indices);
    pages.forEach(p => out.addPage(p));

    const base = file.name.replace(/\.pdf$/i, '');
    await _saveAndImport(out, `${base}_reordered.pdf`);
    toast(`Reordered to ${indices.length} pages`);
  } catch(e) { log.error('Reorder failed:', e); toast('Reorder failed: ' + e.message); }
}

// ── COMPRESS ──────────────────────────────────────────────────
async function toolCompress(file) {
  if (!file) { toast('Select a PDF'); return; }
  toast('Compressing PDF…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const ab  = await file.blob.arrayBuffer();
    const pdf = await PDFDocument.load(ab, { updateMetadata: false });
    const bytes = await pdf.save({ useObjectStreams: true });
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    const saved = ((file.size - blob.size) / file.size * 100).toFixed(1);
    downloadBlob(blob, file.name.replace(/\.pdf$/i, '_compressed.pdf'));
    toast(`Compressed — saved ~${saved}% (${fmtBytes(file.size)} → ${fmtBytes(blob.size)})`);
  } catch(e) { log.error('Compress failed:', e); toast('Compress failed: ' + e.message); }
}

// ── IMG → PDF ─────────────────────────────────────────────────
// Image type detection — more reliable than blob.type alone
function _imgType(blob) {
  const t = (blob.type || '').toLowerCase();
  if (t === 'image/png') return 'png';
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpeg';
  // Fallback from extension
  return 'jpeg'; // PDF-Lib embedJpg handles JPEG; PNG fallback below
}

// Scale down blob to stay under 4 MP before embedding into PDF-Lib
// PDF-Lib loads the entire image into JS memory — very large images can OOM.
async function _downscaleImageBlob(blob, maxPixels = 4_000_000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w * h <= maxPixels) { resolve(blob); return; }
      const scale = Math.sqrt(maxPixels / (w * h));
      const sw = Math.round(w * scale), sh = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      c.getContext('2d').drawImage(img, 0, 0, sw, sh);
      const mime = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      c.toBlob(b => b ? resolve(b) : reject(new Error('Downscale failed')), mime, 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

async function toolImgToPdf(images) {
  if (!images || !images.length) { toast('Select at least one image'); return; }
  toast(`Converting ${images.length} image${images.length !== 1 ? 's' : ''} to PDF…`);
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); return; }
    const { PDFDocument } = Libs.pdflib;
    const pdf = await PDFDocument.create();
    let embedded = 0;

    for (const imgFile of images) {
      let blob = imgFile.blob;
      // Downscale very large images to avoid OOM
      try { blob = await _downscaleImageBlob(blob, 8_000_000); } catch(e) {}
      const ab   = await blob.arrayBuffer();
      const type = _imgType(blob);
      let img;
      try {
        img = type === 'png' ? await pdf.embedPng(ab) : await pdf.embedJpg(ab);
      } catch(e) {
        // Try the other type before giving up
        try {
          img = type === 'png' ? await pdf.embedJpg(ab) : await pdf.embedPng(ab);
        } catch(e2) {
          toast(`Skipping ${imgFile.name}: unsupported format`);
          continue;
        }
      }
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      embedded++;
    }

    if (embedded === 0) { toast('No images could be embedded.'); return; }
    if (pdf.getPageCount() === 0) { toast('No pages in PDF — aborting.'); return; }
    const base = images[0].name.replace(/\.[^.]+$/, '') || 'images';
    await _saveAndImport(pdf, `${base}.pdf`);
    toast(`${embedded} image${embedded !== 1 ? 's' : ''} converted to PDF`);
  } catch(e) { log.error('ImgToPdf failed:', e); toast('Conversion failed: ' + e.message); }
}

// ── PDF → IMG ─────────────────────────────────────────────────
// Safe multi-page export: renders all pages to blobs first, then packages into
// a ZIP-like sequential download using object URLs — avoids browser popup blocking.
async function toolPdfToImg(file, format = 'png') {
  if (!file) { toast('Select a PDF'); return; }
  if (!await Libs.waitForPdfJs()) { toast('PDF.js not loaded.'); return; }
  toast('Rendering pages…');
  try {
    const ab   = await file.blob.arrayBuffer();
    const pdf  = await Libs.pdfjs.getDocument({ data: ab }).promise;
    const base = file.name.replace(/\.pdf$/i, '');
    const n    = pdf.numPages;
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const ext  = format === 'png' ? 'png' : 'jpg';

    // Render all pages to blobs (sequential — avoid canvas memory pile-up)
    const blobs = [];
    for (let i = 1; i <= n; i++) {
      toast(`Rendering page ${i} of ${n}…`);
      const page = await pdf.getPage(i);
      // Scale to ~150 dpi equivalent (reasonable quality, not OOM-inducing)
      const vp = page.getViewport({ scale: 1.5 });
      const c  = document.createElement('canvas');
      c.width  = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const blob = await new Promise(res => c.toBlob(res, mime, 0.88));
      blobs.push({ blob, name: `${base}_page${i}.${ext}` });
      // Release canvas memory
      c.width = 0; c.height = 0;
    }

    if (n === 1) {
      // Single page — direct download, no popup issue
      const url = URL.createObjectURL(blobs[0].blob);
      const a   = document.createElement('a');
      a.href = url; a.download = blobs[0].name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Image downloaded');
    } else {
      // Multiple pages — sequential async downloads with small delay to avoid blocking
      // Browsers allow programmatic downloads when triggered in a user-gesture context;
      // we stagger them with 80 ms gaps so the browser doesn't treat them as popup spam.
      let done = 0;
      const downloadNext = () => {
        if (done >= blobs.length) { toast(`${n} images downloaded`); return; }
        const { blob, name } = blobs[done++];
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setTimeout(downloadNext, 80);
      };
      downloadNext();
    }
  } catch(e) { log.error('PdfToImg failed:', e); toast('Conversion failed: ' + e.message); }
}

// ── PROTECT ───────────────────────────────────────────────────
// ── PROTECT ──────────────────────────────────────────────────
// LIBRARY LIMITATION: pdf-lib 1.x does NOT support PDF encryption.
// PDFDocument has no .encrypt() method. True AES/RC4 password protection
// requires a library with encryption support (e.g. node-forge + custom PDF writer),
// which is outside the current FYLO browser stack.
//
// What we CAN do safely:
//   1. Re-save the PDF with pdf-lib (strips any existing permissions layer).
//   2. Clearly inform the user of the limitation.
//
// We do NOT fake security by returning an unprotected blob and calling it "protected".
async function toolProtect(_file, _password) {
  // Clear password from any argument reference immediately — never log it
  _password = null;
  toast('PDF password protection requires a server-side component not available in this browser version. Feature not yet available.', 4000);
  log.warn('Protect: pdf-lib does not support encryption — feature disabled');
}

// ── UNLOCK ────────────────────────────────────────────────────
// pdf-lib CAN load password-protected PDFs (RC4 40/128-bit, AES 128/256-bit)
// and re-save them without a password. This is genuine unlock functionality.
async function toolUnlock(file, password) {
  if (!file || !password) { toast('Select a PDF and enter the password'); password = null; return; }
  const _busy = { active: true };
  toast('Unlocking PDF…');
  try {
    if (!await Libs.waitForPdfLib()) { toast('PDF-Lib not loaded.'); password = null; return; }
    const { PDFDocument } = Libs.pdflib;
    const ab = await file.blob.arrayBuffer();
    let pdf;
    try {
      pdf = await PDFDocument.load(ab, { password, ignoreEncryption: false });
    } catch(e) {
      password = null;
      // Distinguish wrong-password from other errors without logging the password itself
      const msg = e?.message ?? '';
      if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('incorrect') ||
          msg.toLowerCase().includes('decrypt') || e?.name === 'PasswordException') {
        toast('Incorrect password — please try again.');
      } else if (msg.toLowerCase().includes('unsupported') || msg.toLowerCase().includes('encrypt')) {
        toast('This PDF uses an unsupported encryption type and cannot be unlocked in the browser.');
      } else {
        toast('Could not open PDF: file may be corrupted.');
      }
      return;
    }
    password = null; // Clear as soon as PDFDocument is loaded
    if (pdf.getPageCount() === 0) { toast('Unlocked PDF has no pages — aborting.'); return; }
    await _saveAndImport(pdf, file.name.replace(/\.pdf$/i, '_unlocked.pdf'));
    toast('PDF unlocked successfully');
  } catch(e) {
    password = null;
    // Log only the error type/name — NOT the message (may contain password artifacts)
    log.error('Unlock failed:', e?.name ?? 'unknown error');
    toast('Unlock failed — file may be corrupted or use unsupported encryption.');
  } finally {
    _busy.active = false;
  }
}

// ============================================================
//  MODAL UI FLOWS
// ============================================================

// Shared: build a list of existing FYLO files for selection
function _fileListHTML(dataProp) {
  if (!State.files.length) return '<p style="color:var(--text-tertiary);font-size:13px">No PDFs in library. Import a file first.</p>';
  return State.files.slice(0, 20).map(f =>
    `<div class="tool-file-item" data-${dataProp}="${f.id}">
      <div class="recent-thumb" style="width:32px;height:40px">${f.thumbnail
        ? `<img src="${f.thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:3px">`
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'}</div>
      <span class="tool-file-item-name">${esc(f.name)}</span>
      <span class="tool-file-item-size">${fmtBytes(f.size)}</span>
    </div>`
  ).join('');
}

function _highlightSelected(selector) {
  document.querySelectorAll(`[${selector}]`).forEach(el => {
    el.style.opacity = (el.style.opacity === '0.5') ? '0.5' : '1';
  });
}

// ── Merge modal ───────────────────────────────────────────────
function showMergeModal() {
  _resetTool('merge');
  openModal(
    'Merge PDFs',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select 2 or more PDFs:</p>
     <div id="merge-file-list" class="tool-file-list" style="max-height:260px;overflow-y:auto"></div>
     <button class="btn btn-secondary" id="merge-pick-btn" style="margin-top:10px;width:100%">+ Add PDF from device</button>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="merge-run-btn">Merge PDFs</button>`
  );

  function refreshMergeList() {
    const list = document.getElementById('merge-file-list');
    if (!list) return;
    if (!_tool.files.length) {
      list.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px">No files added yet.</p>'; return;
    }
    list.innerHTML = _tool.files.map((f, i) =>
      `<div class="tool-file-item">
        <span class="tool-file-item-name">${esc(f.name)}</span>
        <span class="tool-file-item-size">${fmtBytes(f.size)}</span>
        <button class="tool-file-item-del" data-remove="${i}" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`
    ).join('');
    list.querySelectorAll('[data-remove]').forEach(btn =>
      btn.addEventListener('click', () => {
        _tool.files.splice(parseInt(btn.dataset.remove), 1);
        refreshMergeList();
        document.getElementById('merge-run-btn')?.classList.toggle('hidden', _tool.files.length < 2);
      })
    );
    document.getElementById('merge-run-btn')?.classList.toggle('hidden', _tool.files.length < 2);
  }

  refreshMergeList();

  document.getElementById('merge-pick-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('tool-file-input');
    if (!inp) return;
    inp.accept = '.pdf,application/pdf'; inp.multiple = true;
    inp._toolCallback = files => {
      files.forEach(f => _tool.files.push({ name: f.name, size: f.size, blob: f }));
      refreshMergeList();
    };
    inp.click();
  });
  document.getElementById('merge-run-btn')?.addEventListener('click', () => { closeModal(); toolMerge(_tool.files); });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Split modal ───────────────────────────────────────────────
function showSplitModal() {
  _resetTool('split');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Split PDF',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF to split:</p>
     <div class="tool-file-list" style="max-height:220px;overflow-y:auto">${_fileListHTML('split-file')}</div>
     <div id="split-options" class="hidden" style="margin-top:16px">
       <label style="color:var(--text-secondary);font-size:13px">Split after page:</label>
       <input type="number" class="input-field" id="split-page" value="1" min="1" style="margin-top:8px">
       <p id="split-hint" style="color:var(--text-tertiary);font-size:12px;margin-top:6px"></p>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="split-run-btn">Split</button>`
  );

  document.querySelectorAll('[data-split-file]').forEach(el => {
    el.addEventListener('click', () => {
      const file = State.getFile(el.dataset.splitFile);
      if (!file) return;
      _tool.files = [file];
      document.querySelectorAll('[data-split-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      const opts = document.getElementById('split-options');
      const inp  = document.getElementById('split-page');
      const hint = document.getElementById('split-hint');
      opts?.classList.remove('hidden');
      document.getElementById('split-run-btn')?.classList.remove('hidden');
      // Update hint from page count
      Libs.waitForPdfJs().then(async ok => {
        if (!ok || !file.blob) return;
        try {
          const ab  = await file.blob.arrayBuffer();
          const pdf = await Libs.pdfjs.getDocument({ data: ab }).promise;
          const n   = pdf.numPages;
          _tool.pageCount = n;
          inp.max = n - 1;
          if (hint) hint.textContent = `This PDF has ${n} pages`;
        } catch(e) {}
      });
    });
  });

  document.getElementById('split-run-btn')?.addEventListener('click', () => {
    const v = parseInt(document.getElementById('split-page')?.value || '1');
    closeModal();
    toolSplit(_tool.files[0], v);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Rotate modal ──────────────────────────────────────────────
function showRotateModal() {
  _resetTool('rotate');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Rotate Pages',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF:</p>
     <div class="tool-file-list" style="max-height:200px;overflow-y:auto">${_fileListHTML('rotate-file')}</div>
     <div id="rotate-options" class="hidden" style="margin-top:16px">
       <label style="color:var(--text-secondary);font-size:13px">Rotation:</label>
       <select class="select-field" id="rotate-degrees" style="margin-top:8px">
         <option value="90">90° Clockwise</option>
         <option value="180">180°</option>
         <option value="270">90° Counter-clockwise</option>
       </select>
       <p style="color:var(--text-secondary);font-size:13px;margin-top:12px">Select pages (tap to toggle):</p>
       <div id="rotate-grid-wrap" style="max-height:260px;overflow-y:auto;margin-top:8px">
         <p style="color:var(--text-tertiary);font-size:12px">Loading page thumbnails…</p>
       </div>
       <p id="rotate-sel-info" style="color:var(--text-tertiary);font-size:12px;margin-top:6px">No pages selected (will rotate all)</p>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="rotate-run-btn">Rotate</button>`
  );

  document.querySelectorAll('[data-rotate-file]').forEach(el => {
    el.addEventListener('click', async () => {
      const file = State.getFile(el.dataset.rotateFile);
      if (!file) return;
      _tool.files = [file];
      _tool.selected = new Set();
      document.querySelectorAll('[data-rotate-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      document.getElementById('rotate-options')?.classList.remove('hidden');
      document.getElementById('rotate-run-btn')?.classList.remove('hidden');

      const wrap = document.getElementById('rotate-grid-wrap');
      if (wrap) wrap.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px">Loading…</p>';
      const grid = await _renderPageGrid(file.blob, 'select-multi', {
        onSelectionChange: (sel) => {
          const info = document.getElementById('rotate-sel-info');
          if (info) info.textContent = sel.size > 0
            ? `${sel.size} page${sel.size !== 1 ? 's' : ''} selected`
            : 'No pages selected (will rotate all)';
        },
      });
      if (grid && wrap) { wrap.innerHTML = ''; wrap.appendChild(grid); }
    });
  });

  document.getElementById('rotate-run-btn')?.addEventListener('click', () => {
    const deg = parseInt(document.getElementById('rotate-degrees')?.value || '90');
    const sel = _tool.selected.size > 0 ? [..._tool.selected] : 'all';
    closeModal();
    toolRotate(_tool.files[0], sel, deg);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Delete pages modal ────────────────────────────────────────
function showDeleteModal() {
  _resetTool('delete-pages');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Delete Pages',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF:</p>
     <div class="tool-file-list" style="max-height:200px;overflow-y:auto">${_fileListHTML('delete-file')}</div>
     <div id="delete-options" class="hidden" style="margin-top:16px">
       <p style="color:var(--text-secondary);font-size:13px">Select pages to delete (tap to toggle):</p>
       <div id="delete-grid-wrap" style="max-height:280px;overflow-y:auto;margin-top:8px">
         <p style="color:var(--text-tertiary);font-size:12px">Loading page thumbnails…</p>
       </div>
       <p id="delete-sel-info" style="color:var(--text-tertiary);font-size:12px;margin-top:6px">No pages selected</p>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="delete-run-btn">Delete Selected Pages</button>`
  );

  document.querySelectorAll('[data-delete-file]').forEach(el => {
    el.addEventListener('click', async () => {
      const file = State.getFile(el.dataset.deleteFile);
      if (!file) return;
      _tool.files = [file];
      _tool.selected = new Set();
      document.querySelectorAll('[data-delete-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      document.getElementById('delete-options')?.classList.remove('hidden');
      document.getElementById('delete-run-btn')?.classList.remove('hidden');

      const wrap = document.getElementById('delete-grid-wrap');
      if (wrap) wrap.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px">Loading…</p>';
      const grid = await _renderPageGrid(file.blob, 'select-multi', {
        onSelectionChange: (sel) => {
          const info = document.getElementById('delete-sel-info');
          if (info) info.textContent = sel.size > 0
            ? `${sel.size} page${sel.size !== 1 ? 's' : ''} selected`
            : 'No pages selected';
          const btn = document.getElementById('delete-run-btn');
          if (btn) btn.textContent = sel.size > 0
            ? `Delete ${sel.size} Page${sel.size !== 1 ? 's' : ''}`
            : 'Delete Selected Pages';
        },
      });
      if (grid && wrap) { wrap.innerHTML = ''; wrap.appendChild(grid); }
    });
  });

  document.getElementById('delete-run-btn')?.addEventListener('click', () => {
    if (_tool.selected.size === 0) { toast('Select at least one page to delete'); return; }
    const indices = [..._tool.selected];
    closeModal();
    toolDeletePages(_tool.files[0], indices);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Reorder pages modal ───────────────────────────────────────
function showReorderModal() {
  _resetTool('reorder');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Reorder Pages',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF:</p>
     <div class="tool-file-list" style="max-height:200px;overflow-y:auto">${_fileListHTML('reorder-file')}</div>
     <div id="reorder-options" class="hidden" style="margin-top:16px">
       <p style="color:var(--text-secondary);font-size:13px">Drag pages to reorder (or use ‹ › buttons):</p>
       <div id="reorder-grid-wrap" style="max-height:320px;overflow-y:auto;margin-top:8px">
         <p style="color:var(--text-tertiary);font-size:12px">Loading page thumbnails…</p>
       </div>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="reorder-run-btn">Apply Reorder</button>`
  );

  let _reorderFile = null;

  async function refreshReorderGrid() {
    if (!_reorderFile) return;
    const wrap = document.getElementById('reorder-grid-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px">Loading…</p>';
    const grid = await _renderPageGrid(_reorderFile.blob, 'reorder', {
      onReorder: async (newOrder) => {
        _tool.pageOrder = [...newOrder];
        await refreshReorderGrid();
      },
    });
    if (grid) { wrap.innerHTML = ''; wrap.appendChild(grid); }
  }

  document.querySelectorAll('[data-reorder-file]').forEach(el => {
    el.addEventListener('click', async () => {
      const file = State.getFile(el.dataset.reorderFile);
      if (!file) return;
      _tool.files = [file];
      _reorderFile = file;
      _tool.pageOrder = [];
      document.querySelectorAll('[data-reorder-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      document.getElementById('reorder-options')?.classList.remove('hidden');
      document.getElementById('reorder-run-btn')?.classList.remove('hidden');
      await refreshReorderGrid();
    });
  });

  document.getElementById('reorder-run-btn')?.addEventListener('click', () => {
    if (!_tool.pageOrder.length) { toast('No page order set'); return; }
    closeModal();
    toolReorder(_tool.files[0], _tool.pageOrder);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Compress modal ────────────────────────────────────────────
function showCompressModal() {
  _resetTool('compress');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Compress PDF',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF to compress:</p>
     <div class="tool-file-list" style="max-height:260px;overflow-y:auto">${_fileListHTML('compress-file')}</div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="compress-run-btn">Compress</button>`
  );
  document.querySelectorAll('[data-compress-file]').forEach(el => {
    el.addEventListener('click', () => {
      const file = State.getFile(el.dataset.compressFile);
      if (!file) return;
      _tool.files = [file];
      document.querySelectorAll('[data-compress-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      document.getElementById('compress-run-btn')?.classList.remove('hidden');
    });
  });
  document.getElementById('compress-run-btn')?.addEventListener('click', () => { closeModal(); toolCompress(_tool.files[0]); });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Img-to-PDF modal ──────────────────────────────────────────
function showImgToPdfModal() {
  _resetTool('img-to-pdf');
  const _previewUrls = [];

  openModal(
    'Image to PDF',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Add images — use arrows to set page order:</p>
     <div id="img-list" class="img-pdf-list" style="max-height:260px;overflow-y:auto">
       <p style="color:var(--text-tertiary);font-size:13px;padding:8px 0">No images added yet.</p>
     </div>
     <button class="btn btn-secondary" id="img-pick-btn" style="margin-top:10px;width:100%">+ Add Images</button>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="img-run-btn">Convert to PDF</button>`
  );

  function _revokeAll() {
    _previewUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch(e) {} });
    _previewUrls.length = 0;
  }

  function refreshImgList() {
    const list = document.getElementById('img-list');
    if (!list) return;
    _revokeAll();
    if (!_tool.files.length) {
      list.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px;padding:8px 0">No images added yet.</p>';
      document.getElementById('img-run-btn')?.classList.add('hidden');
      return;
    }
    list.innerHTML = _tool.files.map((f, i) => {
      const url = URL.createObjectURL(f.blob);
      _previewUrls.push(url);
      const isFirst = i === 0, isLast = i === _tool.files.length - 1;
      return `<div class="img-pdf-item">
        <img class="img-pdf-thumb" src="${url}" alt="${esc(f.name)}">
        <div class="img-pdf-item-info">
          <span class="tool-file-item-name">${esc(f.name)}</span>
          <span class="tool-file-item-size">${fmtBytes(f.size)}</span>
        </div>
        <div class="img-pdf-item-actions">
          <button class="page-grid-move-btn" data-up="${i}" ${isFirst ? 'disabled' : ''} title="Move up">↑</button>
          <button class="page-grid-move-btn" data-down="${i}" ${isLast ? 'disabled' : ''} title="Move down">↓</button>
          <button class="tool-file-item-del" data-remove="${i}" title="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.up);
        if (i === 0) return;
        [_tool.files[i-1], _tool.files[i]] = [_tool.files[i], _tool.files[i-1]];
        refreshImgList();
      });
    });
    list.querySelectorAll('[data-down]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.down);
        if (i >= _tool.files.length - 1) return;
        [_tool.files[i], _tool.files[i+1]] = [_tool.files[i+1], _tool.files[i]];
        refreshImgList();
      });
    });
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        _tool.files.splice(parseInt(btn.dataset.remove), 1);
        refreshImgList();
      });
    });
    document.getElementById('img-run-btn')?.classList.toggle('hidden', _tool.files.length === 0);
  }

  document.getElementById('img-pick-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('image-input');
    if (!inp) return;
    inp.multiple = true;
    inp._toolCallback = files => {
      files.forEach(f => {
        if (!f.type.startsWith('image/')) { toast(f.name + ': not an image'); return; }
        _tool.files.push({ name: f.name, size: f.size, blob: f });
      });
      refreshImgList();
    };
    inp.click();
  });
  document.getElementById('img-run-btn')?.addEventListener('click', () => {
    _revokeAll(); closeModal(); toolImgToPdf(_tool.files);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', () => {
    _revokeAll(); closeModal();
  });
}

// ── PDF-to-Image modal ────────────────────────────────────────
function showPdfToImgModal() {
  _resetTool('pdf-to-img');
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'PDF to Image',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Select a PDF to convert:</p>
     <div class="tool-file-list" style="max-height:220px;overflow-y:auto">${_fileListHTML('pdf2img-file')}</div>
     <div id="pdf2img-options" class="hidden" style="margin-top:16px">
       <label style="color:var(--text-secondary);font-size:13px">Format:</label>
       <select class="select-field" id="pdf2img-format" style="margin-top:8px">
         <option value="png">PNG (lossless)</option>
         <option value="jpg">JPG (smaller)</option>
       </select>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="pdf2img-run-btn">Convert</button>`
  );
  document.querySelectorAll('[data-pdf2img-file]').forEach(el => {
    el.addEventListener('click', () => {
      const file = State.getFile(el.dataset.pdf2imgFile);
      if (!file) return;
      _tool.files = [file];
      document.querySelectorAll('[data-pdf2img-file]').forEach(i => i.style.opacity = '0.4');
      el.style.opacity = '1';
      document.getElementById('pdf2img-options')?.classList.remove('hidden');
      document.getElementById('pdf2img-run-btn')?.classList.remove('hidden');
    });
  });
  document.getElementById('pdf2img-run-btn')?.addEventListener('click', () => {
    const fmt = document.getElementById('pdf2img-format')?.value || 'png';
    closeModal(); toolPdfToImg(_tool.files[0], fmt);
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ── Protect modal ─────────────────────────────────────────────
function showProtectModal() {
  _resetTool('protect');
  // Honestly communicate the library limitation
  openModal(
    'Protect PDF',
    `<div style="padding:8px 0">
       <div style="display:flex;align-items:flex-start;gap:12px;padding:14px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.35);border-radius:var(--radius-md,8px);margin-bottom:14px">
         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgb(234,179,8)" stroke-width="2" flex-shrink="0" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
         <div>
           <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:4px">Browser limitation</p>
           <p style="font-size:13px;color:var(--text-secondary);line-height:1.5">PDF password encryption is not supported in this browser version. The PDF-Lib library used by FYLO does not implement AES or RC4 PDF encryption.</p>
         </div>
       </div>
       <p style="font-size:13px;color:var(--text-secondary);line-height:1.5">To protect a PDF with a password, use a native PDF application (Adobe Acrobat, Preview on macOS, or a server-side tool), then import the protected file into FYLO.</p>
     </div>`,
    `<button class="btn btn-primary modal-cancel">Got it</button>`
  );
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}
function showUnlockModal() {
  _resetTool('unlock');
  openModal(
    'Unlock PDF',
    `<p style="color:var(--text-secondary);margin-bottom:12px;font-size:13px">Select a password-protected PDF from your device:</p>
     <div id="unlock-file-list" class="tool-file-list" style="max-height:140px;overflow-y:auto">
       <p style="color:var(--text-tertiary);font-size:13px">No file selected.</p>
     </div>
     <button class="btn btn-secondary" id="unlock-pick-btn" style="margin-top:10px;width:100%">Select Protected PDF</button>
     <div id="unlock-pw-area" class="hidden" style="margin-top:16px">
       <label style="color:var(--text-secondary);font-size:13px;display:block;margin-bottom:6px">Password:</label>
       <div style="position:relative">
         <input type="password" class="input-field" id="unlock-pass" placeholder="Enter password" autocomplete="current-password" style="padding-right:44px">
         <button type="button" id="unlock-show-pw" title="Show / hide password"
           style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:4px;line-height:0">
           <svg id="unlock-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
         </button>
       </div>
       <p style="font-size:12px;color:var(--text-tertiary);margin-top:6px">Password is used only to unlock this file and is not stored.</p>
     </div>`,
    `<button class="btn btn-secondary modal-cancel">Cancel</button>
     <button class="btn btn-primary hidden" id="unlock-run-btn">Unlock PDF</button>`
  );

  document.getElementById('unlock-pick-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('tool-file-input');
    if (!inp) return;
    inp.accept = '.pdf,application/pdf'; inp.multiple = false;
    inp._toolCallback = files => {
      if (!files.length) return;
      _tool.files = [{ name: files[0].name, size: files[0].size, blob: files[0] }];
      const list = document.getElementById('unlock-file-list');
      if (list) list.innerHTML = `<div class="tool-file-item">
        <span class="tool-file-item-name">${esc(files[0].name)}</span>
        <span class="tool-file-item-size">${fmtBytes(files[0].size)}</span>
      </div>`;
      document.getElementById('unlock-pw-area')?.classList.remove('hidden');
      document.getElementById('unlock-run-btn')?.classList.remove('hidden');
      document.getElementById('unlock-pass')?.focus();
    };
    inp.click();
  });

  // Show/hide password toggle
  document.getElementById('unlock-show-pw')?.addEventListener('click', () => {
    const inp  = document.getElementById('unlock-pass');
    const icon = document.getElementById('unlock-eye-icon');
    if (!inp) return;
    const showing = inp.type === 'text';
    inp.type = showing ? 'password' : 'text';
    // Switch icon: eye vs eye-off
    icon.innerHTML = showing
      ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
      : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  });

  // Enter key submits
  document.getElementById('unlock-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('unlock-run-btn')?.click();
  });

  let _busy = false;
  document.getElementById('unlock-run-btn')?.addEventListener('click', async () => {
    if (_busy) return;
    const pw  = document.getElementById('unlock-pass')?.value ?? '';
    if (!pw) { toast('Enter the PDF password'); return; }
    if (!_tool.files.length) { toast('Select a PDF first'); return; }
    _busy = true;
    const btn = document.getElementById('unlock-run-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Unlocking…'; }
    // Clear the input field now — don't hold password in DOM during async op
    const passEl = document.getElementById('unlock-pass');
    if (passEl) passEl.value = '';
    closeModal();
    await toolUnlock(_tool.files[0], pw);
    _busy = false;
  });

  document.querySelector('.modal-cancel')?.addEventListener('click', () => {
    // Clear password from DOM immediately
    const passEl = document.getElementById('unlock-pass');
    if (passEl) passEl.value = '';
    closeModal();
  });
}
// ── Editor flow ───────────────────────────────────────────────
function startEditorFlow(tool) {
  if (!State.files.length) { toast('Open a PDF first'); Router.go(PAGES.FILES); return; }
  openModal(
    'Select PDF to Edit',
    `<p style="color:var(--text-secondary);margin-bottom:12px">Choose a PDF to edit with <strong>${esc(tool)}</strong>:</p>
     <div class="tool-file-list" style="max-height:300px;overflow-y:auto">${_fileListHTML('edit-file')}</div>`,
  );
  document.querySelectorAll('[data-edit-file]').forEach(el => {
    el.addEventListener('click', () => {
      closeModal();
      bus.emit('editor:openRequest', { fileId: el.dataset.editFile, tool });
    });
  });
  document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
}

// ============================================================
//  TOOL DISPATCH
// ============================================================
function startToolFlow(toolId) {
  switch (toolId) {
    case 'merge':        showMergeModal();   break;
    case 'split':        showSplitModal();   break;
    case 'compress':     showCompressModal();break;
    case 'img-to-pdf':   showImgToPdfModal();break;
    case 'pdf-to-img':   showPdfToImgModal();break;
    case 'protect':      showProtectModal(); break;
    case 'unlock':       showUnlockModal();  break;
    case 'rotate':       showRotateModal();  break;
    case 'delete-pages': showDeleteModal();  break;
    case 'reorder':      showReorderModal(); break;
    case 'highlight': case 'underline': case 'draw': case 'text': case 'signature':
      startEditorFlow(toolId); break;
    default:
      toast('Tool coming soon');
  }
}

// ============================================================
//  TOOL CATEGORIES RENDER
// ============================================================
function renderToolsCats() {
  const container = document.getElementById('tools-categories');
  if (!container) return;

  const cats = [
    {
      name: 'Organize',
      tools: [
        { id:'merge',        label:'Merge PDFs',    icon:'<path d="M8 2H4a2 2 0 0 0-2 2v4"/><path d="M16 2h4a2 2 0 0 1 2 2v4"/><path d="M8 22H4a2 2 0 0 1-2-2v-4"/><path d="M16 22h4a2 2 0 0 0 2-2v-4"/><line x1="2" y1="12" x2="22" y2="12"/>' },
        { id:'split',        label:'Split PDF',     icon:'<path d="M16 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/><line x1="12" y1="2" x2="12" y2="22"/>' },
        { id:'rotate',       label:'Rotate Pages',  icon:'<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>' },
        { id:'delete-pages', label:'Delete Pages',  icon:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>' },
        { id:'reorder',      label:'Reorder Pages', icon:'<path d="M3 9l4-4 4 4"/><path d="M7 5v14"/><path d="M21 15l-4 4-4-4"/><path d="M17 19V5"/>' },
        { id:'compress',     label:'Compress',      icon:'<path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/><polyline points="16 16 12 20 8 16"/><line x1="12" y1="12" x2="12" y2="20"/>' },
      ],
    },
    {
      name: 'Convert',
      tools: [
        { id:'img-to-pdf',   label:'Image to PDF',  icon:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' },
        { id:'pdf-to-img',   label:'PDF to Image',  icon:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>' },
      ],
    },
    {
      name: 'Security',
      tools: [
        { id:'protect',      label:'Protect PDF',   icon:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
        { id:'unlock',       label:'Unlock PDF',    icon:'<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>' },
      ],
    },
    {
      name: 'Edit',
      tools: [
        { id:'highlight',    label:'Highlight',     icon:'<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>' },
        { id:'draw',         label:'Draw',          icon:'<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>' },
        { id:'text',         label:'Add Text',      icon:'<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>' },
        { id:'signature',    label:'Signature',     icon:'<path d="M3 17c3-3 6 0 9-3s6-6 9-3"/><path d="M3 21h18"/>' },
      ],
    },
  ];

  container.innerHTML = cats.map(cat => `
    <div class="tools-category">
      <h3 class="tools-cat-title">${esc(cat.name)}</h3>
      <div class="tools-grid">
        ${cat.tools.map(t => `
          <button class="tool-card" data-tool="${t.id}" aria-label="${esc(t.label)}">
            <div class="tool-card-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${t.icon}</svg>
            </div>
            <span class="tool-card-label">${esc(t.label)}</span>
          </button>`).join('')}
      </div>
    </div>`
  ).join('');

  container.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => startToolFlow(btn.dataset.tool));
  });
}

// ============================================================
//  FILE INPUT WIRING (tool-file-input + image-input)
// ============================================================
// These are global inputs; we forward to whichever modal registered a callback.
function wireToolInputs() {
  const toolInput  = document.getElementById('tool-file-input');
  const imageInput = document.getElementById('image-input');

  if (toolInput) {
    toolInput.addEventListener('change', e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (toolInput._toolCallback) {
        toolInput._toolCallback(files);
        toolInput._toolCallback = null;
      }
    });
  }
  if (imageInput) {
    imageInput.addEventListener('change', e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (imageInput._toolCallback) {
        imageInput._toolCallback(files);
        imageInput._toolCallback = null;
      }
    });
  }

  // Home quick-action buttons
  document.querySelectorAll('[data-home-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.homeAction;
      if (action === 'open') {
        document.getElementById('file-input')?.click();
      } else if (action === 'scan') {
        bus.emit('camera:openRequest', {});
      } else {
        Router.go(PAGES.TOOLS);
        // Small delay so tools page is shown before modal
        setTimeout(() => startToolFlow(action), 150);
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
export const ToolsModule = {
  startFlow:        toolId => startToolFlow(toolId),
  startEditorFlow:  tool   => startEditorFlow(tool),
  renderCategories: ()     => renderToolsCats(),
  wireInputs:       ()     => wireToolInputs(),
};

// Wire inputs on module load (after DOM is ready via type=module defer)
document.addEventListener('DOMContentLoaded', wireToolInputs, { once: true });
// Also call immediately in case DOMContentLoaded already fired
if (document.readyState !== 'loading') wireToolInputs();
