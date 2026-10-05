/**
 * FYLO Feature — Camera / Document Scanner  (Phase 3 rewrite)
 *
 * Owns: camera stream lifecycle, multi-page capture, scan-to-PDF pipeline.
 * State is module-local. Cross-module: emits files:incoming when scan completes.
 *
 * Architecture:
 *   - Camera is a fullscreen modal overlay (NOT a routed page).
 *   - State lives in _cs (camera session), reset on every open().
 *   - Pages accumulate in _cs.pages[] as {dataUrl, blob} until Save PDF.
 *   - PDF is generated with PDF-Lib and imported into FileStorage via bus.
 */

import { bus }           from '../../core/eventBus.js';
import { Libs }          from '../../core/libs.js';
import { toast, downloadBlob } from '../../core/ui.js';
import { createLogger }  from '../../core/logger.js';
import { isAndroid, androidRequestCamera } from '../../core/android-bridge.js';

const log = createLogger('Camera');

// ── DOM accessors (lazy — safe to call after DOMContentLoaded) ────────────────
const D = {
  modal:      () => document.getElementById('camera-modal'),
  header:     () => document.getElementById('camera-title'),
  preview:    () => document.getElementById('camera-preview'),
  video:      () => document.getElementById('camera-video'),
  photo:      () => document.getElementById('camera-photo'),
  errorBox:   () => document.getElementById('camera-error'),
  errorMsg:   () => document.getElementById('camera-error-msg'),
  retryBtn:   () => document.getElementById('camera-retry-btn'),
  shutter:    () => document.getElementById('camera-shutter'),
  addPage:    () => document.getElementById('camera-add-page'),
  savePdf:    () => document.getElementById('camera-save-pdf'),
  closeBtn:   () => document.getElementById('camera-close'),
  flipBtn:    () => document.getElementById('camera-flip'),
  pagesBar:   () => document.getElementById('camera-pages-bar'),
  pagesList:  () => document.getElementById('camera-pages-list'),
  pagesCount: () => document.getElementById('camera-pages-count'),
};

// ── Session state ─────────────────────────────────────────────────────────────
const _cs = {
  stream:      null,   // MediaStream
  facingMode:  'environment',
  pages:       [],     // [{dataUrl:string, objectUrl:string}]
  capturedUrl: null,   // dataUrl of just-taken shot (not yet confirmed)
  rAF:         null,
  busy:        false,
  starting:    false,  // a camera start/switch is in flight
};

// ── UI state helpers ──────────────────────────────────────────────────────────
function _showViewfinder() {
  D.video()?.classList.remove('hidden');
  D.photo()?.classList.add('hidden');
  D.errorBox()?.classList.add('hidden');
  _setShutterMode('capture');
}

function _showPreview(dataUrl) {
  const img = D.photo();
  if (img) { img.src = dataUrl; img.classList.remove('hidden'); }
  D.video()?.classList.add('hidden');
  D.errorBox()?.classList.add('hidden');
  _setShutterMode('confirm');
}

function _showError(msg) {
  const eb = D.errorBox(); const em = D.errorMsg();
  if (eb) eb.classList.remove('hidden');
  if (em) em.textContent = msg;
  D.video()?.classList.add('hidden');
  D.photo()?.classList.add('hidden');
  _setShutterMode('hidden');
}

function _setShutterMode(mode) {
  // mode: 'capture' | 'confirm' | 'hidden'
  const shutter  = D.shutter();
  const addPage  = D.addPage();
  const savePdf  = D.savePdf();
  if (!shutter) return;

  if (mode === 'capture') {
    shutter.classList.remove('hidden');
    shutter.dataset.action = 'capture';
    shutter.setAttribute('aria-label', 'Capture');
    shutter.style.background = '';
    if (addPage)  addPage.style.visibility  = _cs.pages.length > 0 ? 'visible' : 'hidden';
    if (savePdf)  savePdf.classList.add('hidden');
  } else if (mode === 'confirm') {
    shutter.classList.remove('hidden');
    shutter.dataset.action = 'confirm';
    shutter.setAttribute('aria-label', 'Confirm — add this page');
    shutter.style.background = 'var(--success, #22c55e)';
    if (addPage)  addPage.style.visibility  = 'hidden';
    if (savePdf)  savePdf.classList.add('hidden');
  } else {
    shutter.classList.add('hidden');
    if (addPage)  addPage.style.visibility  = 'hidden';
    if (savePdf)  savePdf.classList.add('hidden');
  }
}

function _updatePagesBar() {
  const n    = _cs.pages.length;
  const bar  = D.pagesBar();
  const list = D.pagesList();
  const cnt  = D.pagesCount();

  if (!bar) return;
  if (n === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  if (cnt) cnt.textContent = n + ' page' + (n !== 1 ? 's' : '');

  if (list) {
    list.innerHTML = '';
    _cs.pages.forEach((pg, i) => {
      const item = document.createElement('div');
      item.className = 'camera-page-thumb';
      item.title = `Page ${i + 1}`;
      const img = document.createElement('img');
      img.src = pg.dataUrl;
      img.alt = `Page ${i + 1}`;

      const num = document.createElement('span');
      num.className = 'camera-page-num';
      num.textContent = i + 1;

      const del = document.createElement('button');
      del.className = 'camera-page-del';
      del.title = 'Remove page';
      del.innerHTML = '✕';
      del.addEventListener('click', e => {
        e.stopPropagation();
        _removePage(i);
      });

      item.appendChild(img);
      item.appendChild(num);
      item.appendChild(del);
      list.appendChild(item);
    });
    // Scroll to latest
    list.scrollLeft = list.scrollWidth;
  }

  // Show save button once we have at least 1 confirmed page
  D.savePdf()?.classList.toggle('hidden', n === 0);
  // Show addPage once we have pages and are in viewfinder mode
  if (D.shutter()?.dataset.action === 'capture') {
    const ap = D.addPage();
    if (ap) ap.style.visibility = n > 0 ? 'visible' : 'hidden';
  }
}

function _removePage(idx) {
  _cs.pages.splice(idx, 1);
  _updatePagesBar();
  if (_cs.pages.length === 0) {
    D.savePdf()?.classList.add('hidden');
  }
  toast('Page removed');
}

// ── Camera stream ─────────────────────────────────────────────────────────────
//
// Android WebView notes (why this is more than a bare getUserMedia call):
//  1. The app needs the *Android runtime* CAMERA permission, not just WebView's. On Android we
//     ask for it first through the bridge, which shows the native system dialog automatically.
//  2. Stopping a track does not release the camera hardware instantly. Opening the other camera
//     straight away can fail with NotReadableError/AbortError, so we wait briefly and retry.
//  3. Taps on Flip / Try Again can overlap a start that is still in flight. Every start gets a
//     generation number; results from superseded starts are discarded and their tracks stopped,
//     so a stale stream can never replace the current one or leak (leaving the camera "in use").

const RELEASE_DELAY_MS = 250;   // let the previous camera hardware release before reopening
const RETRY_DELAY_MS   = 400;
const MAX_OPEN_TRIES   = 3;
const _sleep = ms => new Promise(r => setTimeout(r, ms));

let _startGen = 0;              // bumped on every start and on close; stale async results are dropped

const _FACING_LABEL = {
  user:        /front|user|selfie|facetime/i,
  environment: /back|rear|environment/i,
};

function _err(name, message) {
  const e = new Error(message || name); e.name = name; return e;
}

/** Android: show the native permission dialog (if needed). Browsers prompt inside getUserMedia. */
async function _ensureCameraPermission() {
  if (!isAndroid) return true;
  try { return await androidRequestCamera(); }
  catch (e) { log.warn('Camera permission request failed:', e); return false; }
}

/** One pass over the strategies for getting the requested camera. Throws the last error. */
async function _openOnce(facing) {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const gum  = video => navigator.mediaDevices.getUserMedia({ video, audio: false });
  let lastErr = null;

  // 1) Strict: exactly the requested facing mode.
  try { return await gum({ ...size, facingMode: { exact: facing } }); }
  catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' ||
        e.name === 'NotReadableError' || e.name === 'AbortError' || e.name === 'TrackStartError') throw e;
    lastErr = e;   // OverconstrainedError / NotFoundError -> try the next strategy
  }

  // 2) Pick by device label (labels are only populated once permission has been granted).
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'videoinput' && _FACING_LABEL[facing].test(d.label || ''));
    for (const d of devs) {
      try { return await gum({ ...size, deviceId: { exact: d.deviceId } }); }
      catch (e) { lastErr = e; if (e.name === 'NotReadableError' || e.name === 'AbortError') throw e; }
    }
  } catch (e) { lastErr = e; if (e.name === 'NotReadableError' || e.name === 'AbortError') throw e; }

  // 3) Soft preference — accepted only if the browser did not hand back the *other* camera.
  try {
    const stream = await gum({ ...size, facingMode: { ideal: facing } });
    const got = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    if (!got || got === facing) return stream;
    stream.getTracks().forEach(t => t.stop());
    lastErr = _err('NotFoundError', `No ${facing === 'user' ? 'front' : 'rear'} camera on this device`);
  } catch (e) { lastErr = e; }

  throw lastErr || _err('NotFoundError', 'No camera found');
}

/** Opens the requested camera, retrying while the previous one is still being released. */
async function _openStream(facing, gen) {
  let err = null;
  for (let i = 0; i < MAX_OPEN_TRIES; i++) {
    if (gen !== _startGen) throw _err('AbortError', 'superseded');
    try { return await _openOnce(facing); }
    catch (e) {
      err = e;
      const busy = e.name === 'NotReadableError' || e.name === 'AbortError' || e.name === 'TrackStartError';
      if (!busy) throw e;
      await _sleep(RETRY_DELAY_MS);
    }
  }
  throw err;
}

/**
 * (Re)starts the preview for _cs.facingMode.
 * Resolves to: 'ok' | 'denied' | 'unavailable' | 'error' | 'stale'
 */
async function _startStream() {
  const gen = ++_startGen;
  const hadStream = !!_cs.stream;
  _stopStream();
  _showViewfinder();
  const flip = D.flipBtn();
  if (flip) flip.disabled = true;      // no overlapping switches while a start is in flight
  _cs.starting = true;
  try {
    if (!await _ensureCameraPermission()) throw _err('NotAllowedError', 'Camera permission denied');
    if (gen !== _startGen) return 'stale';
    if (hadStream) await _sleep(RELEASE_DELAY_MS);
    if (gen !== _startGen) return 'stale';

    const stream = await _openStream(_cs.facingMode, gen);
    if (gen !== _startGen) { stream.getTracks().forEach(t => t.stop()); return 'stale'; }

    _cs.stream = stream;
    const video = D.video();
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
    return 'ok';
  } catch (e) {
    if (gen !== _startGen) return 'stale';
    log.warn('Camera start failed:', e);
    const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError';
    const missing = e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError' ||
                    e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError';
    const msg = denied
      ? (isAndroid ? 'Camera permission denied. Tap Try Again to allow camera access.'
                   : 'Camera permission denied. Allow camera access in your browser settings.')
      : missing
      ? 'No camera found on this device.'
      : e.name === 'NotReadableError' || e.name === 'TrackStartError'
      ? 'Camera is in use by another app.'
      : 'Camera unavailable: ' + e.message;
    _showError(msg);
    return denied ? 'denied' : missing ? 'unavailable' : 'error';
  } finally {
    if (gen === _startGen) {
      _cs.starting = false;
      if (flip) flip.disabled = false;
    }
  }
}

function _stopStream() {
  if (_cs.stream) {
    _cs.stream.getTracks().forEach(t => t.stop());
    _cs.stream = null;
  }
  const video = D.video();
  if (video) { video.pause?.(); video.srcObject = null; }
}

async function _flipCamera() {
  if (_cs.starting) return;            // ignore taps while a switch is already in progress
  const prev = _cs.facingMode;
  _cs.facingMode = prev === 'environment' ? 'user' : 'environment';
  const result = await _startStream();
  if (result === 'unavailable') {
    // The device has no camera facing that way — go back to the one that worked.
    _cs.facingMode = prev;
    toast(prev === 'environment' ? 'Front camera not available' : 'Rear camera not available');
    await _startStream();
  } else if (result !== 'ok' && result !== 'stale') {
    _cs.facingMode = prev;             // denied/in-use: keep state consistent for Try Again
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────
function _captureFrame() {
  const video = D.video();
  if (!video || !video.videoWidth) { toast('Camera not ready'); return; }

  const w = video.videoWidth;
  const h = video.videoHeight;

  // Cap at 2MP to avoid OOM on high-res cameras (still plenty for a document scan)
  const MAX_PX = 2_000_000;
  let sw = w, sh = h;
  if (w * h > MAX_PX) {
    const scale = Math.sqrt(MAX_PX / (w * h));
    sw = Math.round(w * scale);
    sh = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  canvas.getContext('2d').drawImage(video, 0, 0, sw, sh);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  _cs.capturedUrl = dataUrl;
  _showPreview(dataUrl);
}

function _confirmPage() {
  if (!_cs.capturedUrl) return;
  _cs.pages.push({ dataUrl: _cs.capturedUrl });
  _cs.capturedUrl = null;
  _updatePagesBar();
  _showViewfinder();
  if (_cs.pages.length === 1) toast('Page 1 added — keep scanning or Save PDF');
}

function _retake() {
  _cs.capturedUrl = null;
  _showViewfinder();
}

// ── Save as PDF ───────────────────────────────────────────────────────────────
async function _saveAsPdf() {
  if (_cs.pages.length === 0) { toast('No pages captured'); return; }
  if (_cs.busy) return;
  _cs.busy = true;
  const btn = D.savePdf();
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  toast(`Creating PDF from ${_cs.pages.length} page${_cs.pages.length !== 1 ? 's' : ''}…`);

  try {
    if (!await Libs.waitForPdfLib()) {
      toast('PDF-Lib not loaded. Check your connection.'); return;
    }
    const { PDFDocument } = Libs.pdflib;
    const pdf = await PDFDocument.create();

    for (const pg of _cs.pages) {
      // dataUrl → ArrayBuffer
      const resp  = await fetch(pg.dataUrl);
      const ab    = await resp.arrayBuffer();
      let img;
      try {
        img = await pdf.embedJpg(ab);
      } catch(e) {
        try { img = await pdf.embedPng(ab); } catch(e2) {
          log.warn('Could not embed page image:', e2); continue;
        }
      }
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    if (pdf.getPageCount() === 0) {
      toast('No pages could be embedded — PDF not saved.'); return;
    }

    const bytes = await pdf.save();
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    const name  = 'scan_' + new Date().toISOString().slice(0, 10) +
                  '_' + _cs.pages.length + 'p.pdf';
    downloadBlob(blob, name);
    const file = new File([blob], name, { type: 'application/pdf' });
    bus.emit('files:incoming', { files: [file] });
    toast(`Saved ${pdf.getPageCount()}-page PDF`);
    _closeCamera();
  } catch(e) {
    log.error('Scan-to-PDF failed:', e);
    toast('Failed to create PDF: ' + e.message);
  } finally {
    _cs.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Save PDF'; }
  }
}

// ── Open / close ─────────────────────────────────────────────────────────────
function _openCamera() {
  // Reset session
  _cs.pages       = [];
  _cs.capturedUrl = null;
  _cs.busy        = false;
  _cs.facingMode  = 'environment';   // every scan session starts on the rear camera

  const modal = D.modal();
  if (!modal) { log.error('camera-modal not found in DOM'); return; }

  modal.classList.remove('hidden');
  // Trigger CSS transition
  _cs.rAF = requestAnimationFrame(() => {
    _cs.rAF = null;
    modal.classList.add('show');
  });

  _updatePagesBar();
  _startStream();
  _wireButtons();
}

function _closeCamera() {
  _startGen++;          // cancel any start still waiting on permission / hardware
  _cs.starting = false;
  _stopStream();
  _cs.pages       = [];
  _cs.capturedUrl = null;
  _cs.busy        = false;

  const modal = D.modal();
  if (!modal) return;
  modal.classList.remove('show');
  setTimeout(() => modal.classList.add('hidden'), 300);
  if (_cs.rAF) { cancelAnimationFrame(_cs.rAF); _cs.rAF = null; }
}

// ── Button wiring (called on every open) ─────────────────────────────────────
let _buttonsWired = false;
function _wireButtons() {
  if (_buttonsWired) return;
  _buttonsWired = true;

  D.closeBtn()?.addEventListener('click', () => _closeCamera());
  D.flipBtn()?.addEventListener('click',  () => _flipCamera());
  D.retryBtn()?.addEventListener('click', () => _startStream());

  // Shutter is dual-mode: capture or confirm
  D.shutter()?.addEventListener('click', () => {
    const action = D.shutter()?.dataset.action || 'capture';
    if (action === 'capture') _captureFrame();
    else if (action === 'confirm') _confirmPage();
  });

  // Retake from confirm state — re-show viewfinder
  D.addPage()?.addEventListener('click', () => {
    // Already in viewfinder — this just signals intent (no-op visually)
    // Useful if user is on confirm screen and wants to discard
    _retake();
  });

  D.savePdf()?.addEventListener('click', () => _saveAsPdf());

  // Swipe right to close on mobile
  let touchStartX = 0;
  D.modal()?.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  D.modal()?.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx > 80) _closeCamera(); // swipe right → close
  }, { passive: true });
}

// ── Public API ────────────────────────────────────────────────────────────────
export const CameraModule = {
  open:  () => _openCamera(),
  close: () => _closeCamera(),
};
