/**
 * FYLO Feature — Camera / Document Scanner
 *
 * Owns: camera stream lifecycle, multi-page capture, review (reorder/delete), scan-to-PDF pipeline.
 * State is module-local. Cross-module: emits files:incoming (stores the PDF in FYLO Files) and
 * reader:openRequest (opens it) when a scan is finished.
 *
 * Scan workflow
 *   live viewfinder --shutter--> confirm (Retake | Keep) --Keep--> live viewfinder (page added)
 *   live viewfinder: thumbnails strip + "Pages" (review) + "Create PDF" as soon as 1 page exists
 *   review: reorder (◀ ▶), delete, "+ Add Page" (back to camera), "Create PDF"
 *   Create PDF: pdf-lib -> File -> Files storage -> Reader.   Close / Back with pages asks first
 *   (Create PDF / Keep scanning / Discard) so captured pages are never dropped by accident.
 *
 * Camera is a fullscreen modal overlay (NOT a routed page).
 */

import { bus }           from '../../core/eventBus.js';
import { Libs }          from '../../core/libs.js';
import { toast }         from '../../core/ui.js';
import { createLogger }  from '../../core/logger.js';
import { isAndroid, androidRequestCamera } from '../../core/android-bridge.js';

const log = createLogger('Camera');

// ── DOM accessors (lazy — safe to call after DOMContentLoaded) ────────────────
const D = {
  modal:      () => document.getElementById('camera-modal'),
  video:      () => document.getElementById('camera-video'),
  photo:      () => document.getElementById('camera-photo'),
  errorBox:   () => document.getElementById('camera-error'),
  errorMsg:   () => document.getElementById('camera-error-msg'),
  retryBtn:   () => document.getElementById('camera-retry-btn'),
  shutter:    () => document.getElementById('camera-shutter'),
  retake:     () => document.getElementById('camera-retake'),
  reviewBtn:  () => document.getElementById('camera-review-btn'),
  savePdf:    () => document.getElementById('camera-save-pdf'),
  closeBtn:   () => document.getElementById('camera-close'),
  flipBtn:    () => document.getElementById('camera-flip'),
  pagesBar:   () => document.getElementById('camera-pages-bar'),
  pagesList:  () => document.getElementById('camera-pages-list'),
  pagesCount: () => document.getElementById('camera-pages-count'),
  review:     () => document.getElementById('camera-review'),
  reviewGrid: () => document.getElementById('camera-review-grid'),
  reviewTitle:() => document.getElementById('camera-review-title'),
  reviewBack: () => document.getElementById('camera-review-back'),
  reviewAdd:  () => document.getElementById('camera-review-add'),
  reviewSave: () => document.getElementById('camera-review-save'),
  exit:       () => document.getElementById('camera-exit'),
  exitMsg:    () => document.getElementById('camera-exit-msg'),
  exitSave:   () => document.getElementById('camera-exit-save'),
  exitKeep:   () => document.getElementById('camera-exit-continue'),
  exitDiscard:() => document.getElementById('camera-exit-discard'),
};

// ── Session state ─────────────────────────────────────────────────────────────
const _cs = {
  stream:      null,   // MediaStream
  facingMode:  'environment',
  pages:       [],     // [{dataUrl:string}]  — in final PDF order
  capturedUrl: null,   // dataUrl of just-taken shot (not yet kept)
  rAF:         null,
  busy:        false,  // PDF is being created
  starting:    false,  // a camera start/switch is in flight
  closeTimer:  null,
};

const _plural = n => n + ' page' + (n !== 1 ? 's' : '');
const _isOpen = () => !!D.modal() && !D.modal().classList.contains('hidden');

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

/**
 * One place decides which controls are visible, from (mode, number of kept pages):
 *   capture : shutter | "Pages" + "Create PDF" once >=1 page is kept
 *   confirm : shutter becomes the green Keep tick | "Retake"
 *   hidden  : (camera error) no shutter, but "Pages"/"Create PDF" stay available for already-kept pages
 */
function _setShutterMode(mode) {
  const shutter = D.shutter();
  if (!shutter) return;
  const n = _cs.pages.length;
  const show = (el, on) => el && el.classList.toggle('hidden', !on);

  shutter.dataset.action = mode;
  if (mode === 'confirm') {
    shutter.classList.remove('hidden');
    shutter.setAttribute('aria-label', 'Keep this page');
    shutter.style.background = 'var(--success, #22c55e)';
  } else if (mode === 'capture') {
    shutter.classList.remove('hidden');
    shutter.setAttribute('aria-label', n ? 'Add page' : 'Capture');
    shutter.style.background = '';
  } else {
    shutter.classList.add('hidden');
  }
  show(D.retake(),    mode === 'confirm');
  show(D.reviewBtn(), mode !== 'confirm' && n > 0);
  show(D.savePdf(),   mode !== 'confirm' && n > 0);
  if (D.reviewBtn()) D.reviewBtn().textContent = 'Pages (' + n + ')';
}

function _currentMode() { return D.shutter()?.dataset.action || 'capture'; }

function _updatePagesBar() {
  const n    = _cs.pages.length;
  const bar  = D.pagesBar();
  const list = D.pagesList();
  const cnt  = D.pagesCount();
  if (bar) {
    bar.classList.toggle('hidden', n === 0);
    if (cnt) cnt.textContent = _plural(n);
    if (list) {
      list.innerHTML = '';
      _cs.pages.forEach((pg, i) => {
        const item = document.createElement('div');
        item.className = 'camera-page-thumb';
        item.title = `Page ${i + 1} — tap to review`;
        const img = document.createElement('img');
        img.src = pg.dataUrl; img.alt = `Page ${i + 1}`;
        const num = document.createElement('span');
        num.className = 'camera-page-num'; num.textContent = i + 1;
        item.append(img, num);
        item.addEventListener('click', () => _openReview());
        list.appendChild(item);
      });
      list.scrollLeft = list.scrollWidth;       // newest page in view
    }
  }
  _setShutterMode(_currentMode());              // Pages / Create PDF visibility follows the page count
  if (!D.review()?.classList.contains('hidden')) _renderReview();
}

// ── Review: reorder / delete ──────────────────────────────────────────────────
function _openReview() {
  if (!_cs.pages.length || _cs.busy) return;
  D.review()?.classList.remove('hidden');
  _renderReview();
}
function _closeReview() { D.review()?.classList.add('hidden'); }

function _renderReview() {
  const grid = D.reviewGrid();
  const n = _cs.pages.length;
  if (D.reviewTitle()) D.reviewTitle().textContent = n ? _plural(n) : 'No pages';
  if (!grid) return;
  grid.innerHTML = '';
  _cs.pages.forEach((pg, i) => {
    const card = document.createElement('div');
    card.className = 'camera-review-card';
    card.innerHTML =
      '<div class="thumb"><img alt=""><span class="num"></span></div>' +
      '<div class="camera-review-actions">' +
      '<button type="button" class="left"  aria-label="Move page earlier">&#9664;</button>' +
      '<button type="button" class="del"   aria-label="Delete page">&#10005;</button>' +
      '<button type="button" class="right" aria-label="Move page later">&#9654;</button></div>';
    card.querySelector('img').src = pg.dataUrl;
    card.querySelector('img').alt = `Page ${i + 1}`;
    card.querySelector('.num').textContent = i + 1;
    const left = card.querySelector('.left'), right = card.querySelector('.right');
    left.disabled = i === 0; right.disabled = i === n - 1;
    left.addEventListener('click',  () => _movePage(i, i - 1));
    right.addEventListener('click', () => _movePage(i, i + 1));
    card.querySelector('.del').addEventListener('click', () => _removePage(i));
    grid.appendChild(card);
  });
}

function _movePage(from, to) {
  if (to < 0 || to >= _cs.pages.length || from === to) return;
  const [pg] = _cs.pages.splice(from, 1);
  _cs.pages.splice(to, 0, pg);
  _updatePagesBar();
}

function _removePage(idx) {
  _cs.pages.splice(idx, 1);
  _updatePagesBar();
  if (_cs.pages.length === 0) _closeReview();   // nothing left to review: back to the camera
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
  canvas.width = canvas.height = 0;
  _cs.capturedUrl = dataUrl;
  _showPreview(dataUrl);
}

function _keepPage() {
  if (!_cs.capturedUrl) return;
  _cs.pages.push({ dataUrl: _cs.capturedUrl });
  _cs.capturedUrl = null;
  _showViewfinder();            // first: mode -> capture ...
  _updatePagesBar();            // ... then page count (the order matters: this used to hide "Save PDF")
  toast(`Page ${_cs.pages.length} added`);
}

function _retake() {
  _cs.capturedUrl = null;
  _showViewfinder();
}

// ── Create PDF ────────────────────────────────────────────────────────────────
function _dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function _scanFileName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.pdf`;
}

function _setBusy(on, label) {
  _cs.busy = on;
  [D.savePdf(), D.reviewSave(), D.exitSave()].forEach(b => {
    if (!b) return;
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.disabled = on;
    b.textContent = on ? (label || 'Creating…') : b.dataset.label;
  });
  [D.shutter(), D.reviewBtn(), D.reviewAdd(), D.flipBtn()].forEach(b => { if (b) b.disabled = on; });
}

/** Build the PDF from the kept pages (in order). Throws on failure; pages are never touched. */
async function _buildPdf() {
  if (!await Libs.waitForPdfLib()) throw new Error('PDF library not loaded');
  const { PDFDocument } = Libs.pdflib;
  const pdf = await PDFDocument.create();
  for (const pg of _cs.pages) {
    const bytes = _dataUrlToBytes(pg.dataUrl);
    let img;
    try { img = await pdf.embedJpg(bytes); }
    catch (e) { img = await pdf.embedPng(bytes); }
    // A4-sized page that follows the photo's orientation; the image fills it exactly (no distortion).
    const A4_SHORT = 595.28, A4_LONG = 841.89;
    const landscape = img.width > img.height;
    const w = landscape ? A4_LONG : A4_SHORT;
    const h = w * img.height / img.width;
    pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

/** Hand the PDF to the Files module and wait until it is stored. Resolves to the new file id. */
function _storeInFiles(file) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Saving timed out')), 20000);
    bus.emit('files:incoming', {
      files: [file],
      requirePersist: true,        // a scan must really be stored, otherwise keep the pages and let the user retry
      onSaved: ids => { clearTimeout(t); ids && ids.length ? resolve(ids[0]) : reject(new Error('Could not save to Files')); },
    });
  });
}

async function _createPdf() {
  if (_cs.busy) return;
  if (!_cs.pages.length) { toast('Capture at least one page first'); return; }
  _hideExitDialog();
  _setBusy(true);
  try {
    const bytes = await _buildPdf();
    const file  = new File([bytes], _scanFileName(), { type: 'application/pdf' });
    const fileId = await _storeInFiles(file);
    const count = _cs.pages.length;
    _cs.pages = [];                       // only now, after it is safely stored, is the draft released
    _setBusy(false);
    _closeCamera();
    toast(`Saved ${_plural(count)} to Files`);
    bus.emit('reader:openRequest', { fileId });
  } catch (e) {
    log.error('Scan-to-PDF failed:', e);
    _setBusy(false);
    toast('Could not create PDF: ' + (e && e.message ? e.message : 'unknown error') + ' — your pages are still here');
  }
}

// ── Leave / back (never drops pages silently) ─────────────────────────────────
function _showExitDialog() {
  const n = _cs.pages.length + (_cs.capturedUrl ? 1 : 0);
  if (D.exitMsg()) D.exitMsg().textContent =
    `You have ${_plural(n)} that ${n === 1 ? "hasn't" : "haven't"} been saved. Create the PDF now, keep scanning, or discard them.`;
  if (D.exitSave()) D.exitSave().classList.toggle('hidden', _cs.pages.length === 0);
  D.exit()?.classList.remove('hidden');
}
function _hideExitDialog() { D.exit()?.classList.add('hidden'); }

/**
 * User asked to leave (X button, swipe, Android Back). Back-navigation peels one layer at a time:
 * exit dialog -> review panel -> confirm preview -> (unsaved pages? ask) -> close.
 */
function _requestClose() {
  if (!_isOpen() || _cs.busy) return;
  if (!D.exit()?.classList.contains('hidden')) { _hideExitDialog(); return; }       // Back = "Keep scanning"
  if (!D.review()?.classList.contains('hidden')) { _closeReview(); return; }
  if (_currentMode() === 'confirm' && !_cs.pages.length) { _retake(); return; }
  if (_cs.pages.length || _cs.capturedUrl) { _showExitDialog(); return; }
  _closeCamera();
}

// ── Open / close ─────────────────────────────────────────────────────────────
function _openCamera() {
  clearTimeout(_cs.closeTimer);
  // Fresh session (a draft can only exist here if close was interrupted; never resurrect stale shots)
  _cs.pages       = [];
  _cs.capturedUrl = null;
  _cs.busy        = false;
  _cs.facingMode  = 'environment';   // every scan session starts on the rear camera

  const modal = D.modal();
  if (!modal) { log.error('camera-modal not found in DOM'); return; }

  _closeReview(); _hideExitDialog();
  _setBusy(false);
  modal.classList.remove('hidden');
  _cs.rAF = requestAnimationFrame(() => {   // trigger CSS transition
    _cs.rAF = null;
    modal.classList.add('show');
  });

  _wireButtons();
  _showViewfinder();
  _updatePagesBar();
  _startStream();
}

/** Unconditional close: stops the camera and releases the session. Use _requestClose for user exits. */
function _closeCamera() {
  _startGen++;          // cancel any start still waiting on permission / hardware
  _cs.starting = false;
  _stopStream();
  _cs.pages       = [];
  _cs.capturedUrl = null;
  _closeReview(); _hideExitDialog();

  const modal = D.modal();
  if (!modal) return;
  modal.classList.remove('show');
  clearTimeout(_cs.closeTimer);
  _cs.closeTimer = setTimeout(() => modal.classList.add('hidden'), 300);
  if (_cs.rAF) { cancelAnimationFrame(_cs.rAF); _cs.rAF = null; }
}

// ── Button wiring (idempotent) ────────────────────────────────────────────────
let _buttonsWired = false;
function _wireButtons() {
  if (_buttonsWired) return;
  _buttonsWired = true;

  D.closeBtn()?.addEventListener('click', () => _requestClose());
  D.flipBtn()?.addEventListener('click',  () => _flipCamera());
  D.retryBtn()?.addEventListener('click', () => _startStream());

  // Shutter is dual-mode: capture, or "keep" while a fresh shot is being confirmed
  D.shutter()?.addEventListener('click', () => {
    if (_cs.busy) return;
    if (_currentMode() === 'confirm') _keepPage(); else if (_currentMode() === 'capture') _captureFrame();
  });
  D.retake()?.addEventListener('click', () => _retake());
  D.reviewBtn()?.addEventListener('click', () => _openReview());
  D.pagesCount()?.addEventListener('click', () => _openReview());
  D.savePdf()?.addEventListener('click', () => _createPdf());

  D.reviewBack()?.addEventListener('click', () => _closeReview());
  D.reviewAdd()?.addEventListener('click',  () => _closeReview());      // "+ Add Page" = back to the camera
  D.reviewSave()?.addEventListener('click', () => _createPdf());

  D.exitSave()?.addEventListener('click',    () => _createPdf());
  D.exitKeep()?.addEventListener('click',    () => _hideExitDialog());
  D.exitDiscard()?.addEventListener('click', () => { _cs.pages = []; _cs.capturedUrl = null; _closeCamera(); });

  // Swipe right to leave (goes through the same safe-exit path)
  let touchStartX = 0, touchStartY = 0;
  D.modal()?.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; }, { passive: true });
  D.modal()?.addEventListener('touchend', e => {
    if (e.target.closest?.('.camera-pages-list, .camera-review-grid')) return;   // those scroll horizontally/vertically
    const dx = e.changedTouches[0].clientX - touchStartX, dy = e.changedTouches[0].clientY - touchStartY;
    if (dx > 120 && Math.abs(dy) < 60) _requestClose();
  }, { passive: true });
}

// ── Public API ────────────────────────────────────────────────────────────────
export const CameraModule = {
  open:  () => _openCamera(),
  close: () => _requestClose(),                 // user-initiated (Android Back etc.): asks before dropping pages
  get pageCount() { return _cs.pages.length; },
};
