/**
 * FYLO — Android Bridge Adapter
 *
 * This module is loaded by app.js ONLY when running inside the Android WebView.
 * Detection: window.AndroidBridge is injected by MainActivity via addJavascriptInterface().
 *
 * It overrides web-platform behaviours that don't work in Android WebView:
 *   - downloadBlob()  → AndroidBridge.saveFile()
 *   - camera permission → AndroidBridge.requestCameraPermission()
 *
 * The rest of FYLO (reader, editor, tools, camera UI, etc.) is unchanged.
 *
 * Web version never loads this file (AndroidBridge is not defined there).
 */

import { bus }         from './eventBus.js';
import { createLogger } from './logger.js';

const log = createLogger('AndroidBridge');

// ── Is the bridge available? ─────────────────────────────────────────────────
export const isAndroid = typeof window.AndroidBridge !== 'undefined';

// ── Download override ─────────────────────────────────────────────────────────
/**
 * Replace the web downloadBlob() implementation with a native Android save.
 * Called from core/ui.js when AndroidBridge is present.
 *
 * Blob → base64 → AndroidBridge.saveFile() → MediaStore / Downloads
 */
export function androidDownloadBlob(blob, filename) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      // Strip the data-URI prefix: "data:application/pdf;base64,..."
      const dataUrl = reader.result;
      const comma   = dataUrl.indexOf(',');
      const base64  = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const mime    = blob.type || 'application/pdf';

      const result = window.AndroidBridge.saveFile(base64, filename, mime);
      try {
        const parsed = JSON.parse(result);
        if (!parsed.success) log.warn('Android save failed:', parsed.error);
      } catch(e) {}
    } catch(e) {
      log.error('androidDownloadBlob error:', e);
    }
  };
  reader.onerror = () => log.error('FileReader failed in androidDownloadBlob');
  reader.readAsDataURL(blob);
}

// ── Share ─────────────────────────────────────────────────────────────────────
export function androidShareBlob(blob, filename) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const comma   = dataUrl.indexOf(',');
    const base64  = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    window.AndroidBridge.shareFile(base64, filename, blob.type || 'application/pdf');
  };
  reader.readAsDataURL(blob);
}

// ── Camera permission bridge ──────────────────────────────────────────────────
/**
 * Call from camera.js to ensure Android camera permission before getUserMedia().
 * Returns a Promise<boolean>.
 */
export function androidRequestCamera() {
  return new Promise(resolve => {
    if (window.AndroidBridge.hasCameraPermission()) {
      resolve(true);
      return;
    }
    // Result delivered via fyloOnCameraPermission callback
    window.fyloOnCameraPermission = (granted) => {
      window.fyloOnCameraPermission = null;
      resolve(granted);
    };
    window.AndroidBridge.requestCameraPermission();
  });
}

// ── Back button handler ───────────────────────────────────────────────────────
/**
 * window.fyloHandleBack is called by MainActivity.onBackPressed().
 * Returns true if the web layer consumed the back action, false to let Android handle it.
 */
export function installBackHandler() {
  window.fyloHandleBack = () => {
    // 1. Close open modal
    const overlay = document.getElementById('modal-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      import('./ui.js').then(({ closeModal }) => closeModal());
      return true;
    }
    // 2. Close search overlay
    const search = document.getElementById('search-overlay');
    if (search && search.classList.contains('show')) {
      search.classList.remove('show');
      search.classList.add('hidden');
      const inp = document.getElementById('search-input');
      if (inp) inp.value = '';
      return true;
    }
    // 3. Close camera
    const camera = document.getElementById('camera-modal');
    if (camera && !camera.classList.contains('hidden')) {
      bus.emit('camera:closeRequest', {});
      return true;
    }
    // 4. Navigate back through router (reader/editor → files)
    const currentHash = location.hash;
    if (currentHash === '#reader' || currentHash === '#editor') {
      history.back();
      return true;
    }
    // 5. Home — let Android handle (exit or minimize)
    return false;
  };
}

// ── Event bus exposure ────────────────────────────────────────────────────────
/**
 * Expose the FYLO event bus on window.fyloEventBus so MainActivity can emit
 * files:incoming when a PDF is opened via intent.
 * Called from app.js after bus is initialized.
 */
export function exposeBusToAndroid(bus) {
  window.fyloEventBus = bus;
  log.info('Event bus exposed to Android bridge');
}

// ── libs.js local path injection ─────────────────────────────────────────────
/**
 * When running in Android, PDF.js and PDF-Lib are bundled locally.
 * This injects the correct file:///android_asset paths so libs.js
 * can load them without CDN access.
 *
 * Must be called before Libs.init().
 */
export function getAndroidLibPaths() {
  const base = 'file:///android_asset/www/assets/libs';
  return {
    pdfjsSrc:    `${base}/pdf.min.js`,
    pdfjsWorker: `${base}/pdf.worker.min.js`,
    pdflibSrc:   `${base}/pdf-lib.min.js`,
  };
}
