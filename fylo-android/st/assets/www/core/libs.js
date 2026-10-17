/**
 * FYLO Core — Library Loader
 * Loads PDF.js and PDF-Lib from CDN with automatic fallbacks.
 * All external library access goes through this module.
 * Business logic NEVER imports from CDN directly.
 *
 * Future libraries (OCR, AI, etc.) are added here.
 */

import { PDFJS_VERSION, PDFLIB_VERSION } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('Libs');

// ── Ready flags ───────────────────────────────────────────────────────────────
let _pdfjsReady  = false;
let _pdflibReady = false;

const _pdfjsWaiters  = [];
const _pdflibWaiters = [];

// ── PDF.js ────────────────────────────────────────────────────────────────────
// On Android, local assets are tried first (bundled in APK).
// On web/PWA, CDN sources are used with fallbacks.
// WebViewAssetLoader serves assets at this https:// origin (see MainActivity.java).
// Must match the domain and path handler configured in WebViewAssetLoader.Builder.
const _ANDROID_BASE = 'https://appassets.androidplatform.net/assets/www/assets/libs';
const _isAndroid    = typeof window.AndroidBridge !== 'undefined';

const PDFJS_SOURCES = _isAndroid
  ? [
      `${_ANDROID_BASE}/pdf.min.js`,  // local first on Android
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`,
    ]
  : [
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`,
      `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`,
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
    ];

const PDFJS_WORKERS = _isAndroid
  ? [
      `${_ANDROID_BASE}/pdf.worker.min.js`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`,
    ]
  : [
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`,
      `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`,
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`,
    ];

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function _loadPdfJs() {
  for (let i = 0; i < PDFJS_SOURCES.length; i++) {
    try {
      await _loadScript(PDFJS_SOURCES[i]);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKERS[i];
      log.info('PDF.js loaded from:', PDFJS_SOURCES[i]);
      _pdfjsReady = true;
      _pdfjsWaiters.forEach(r => r(true));
      return true;
    } catch { log.warn('PDF.js CDN failed, trying next...'); }
  }
  log.error('All PDF.js CDN sources failed');
  _pdfjsWaiters.forEach(r => r(false));
  return false;
}

// ── PDF-Lib ───────────────────────────────────────────────────────────────────
const PDFLIB_SOURCES = _isAndroid
  ? [
      `${_ANDROID_BASE}/pdf-lib.min.js`,
      `https://cdn.jsdelivr.net/npm/pdf-lib@${PDFLIB_VERSION}/dist/pdf-lib.min.js`,
    ]
  : [
      `https://cdn.jsdelivr.net/npm/pdf-lib@${PDFLIB_VERSION}/dist/pdf-lib.min.js`,
      `https://unpkg.com/pdf-lib@${PDFLIB_VERSION}/dist/pdf-lib.min.js`,
    ];

async function _loadPdfLib() {
  for (const src of PDFLIB_SOURCES) {
    try {
      await _loadScript(src);
      log.info('PDF-Lib loaded from:', src);
      _pdflibReady = true;
      _pdflibWaiters.forEach(r => r(true));
      return true;
    } catch { log.warn('PDF-Lib CDN failed, trying next...'); }
  }
  log.error('All PDF-Lib CDN sources failed');
  _pdflibWaiters.forEach(r => r(false));
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────
export const Libs = {
  /** Call once at app start */
  async init() {
    await Promise.all([_loadPdfJs(), _loadPdfLib()]);
  },

  /** Returns true when PDF.js is ready. Awaitable. */
  waitForPdfJs() {
    if (_pdfjsReady) return Promise.resolve(true);
    return new Promise(r => _pdfjsWaiters.push(r));
  },

  /** Returns true when PDF-Lib is ready. Awaitable. */
  waitForPdfLib() {
    if (_pdflibReady) return Promise.resolve(true);
    return new Promise(r => _pdflibWaiters.push(r));
  },

  get pdfjs()  { return window.pdfjsLib  ?? null; },
  get pdflib() { return window.PDFLib    ?? null; },

  get isPdfjsReady()  { return _pdfjsReady; },
  get isPdflibReady() { return _pdflibReady; },
};
