/**
 * FYLO Core — UI Utilities
 * Shared UI primitives: toast, modal, ripple, focus trap, DOM helpers.
 * No business logic here — only generic UI building blocks.
 */

import { TOAST_DURATION_MS } from './constants.js';
import { bus, EVENTS } from './eventBus.js';
import { Device } from './device.js';

// ── Toast ─────────────────────────────────────────────────────────────────────
export function toast(message, duration = TOAST_DURATION_MS) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  // Auto-remove after duration + animation
  const removeDelay = (typeof duration === 'number' ? duration : TOAST_DURATION_MS) + 350;
  setTimeout(() => {
    el.style.animation = 'toastOut 300ms cubic-bezier(0.4,0,1,1) forwards';
    setTimeout(() => { try { container.removeChild(el); } catch(e) {} }, 350);
  }, typeof duration === 'number' ? duration : TOAST_DURATION_MS);
}

// Listen for bus-emitted toasts (so modules don't need to import ui directly)
bus.on(EVENTS.APP_TOAST, ({ message, duration }) => toast(message, duration));

// ── Modal ─────────────────────────────────────────────────────────────────────
let _savedFocus = null;
let _modalToken = 0;      // identifies the CURRENT modal so a stale close timer can never wipe a newer one
let _onModalClose = null; // optional callback for the CURRENT modal (cancel a running job when it is dismissed)

export function openModal(title, bodyHTML, footerHTML = '', opts = {}) {
  const overlay = document.getElementById('modal-overlay');
  const tEl = document.getElementById('modal-title');
  const bEl = document.getElementById('modal-body');
  const fEl = document.getElementById('modal-footer');
  if (!overlay) return;
  _modalToken++;
  _onModalClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  _savedFocus = document.activeElement;
  tEl.textContent = title;
  bEl.innerHTML   = bodyHTML;
  fEl.innerHTML   = footerHTML;
  fEl.classList.toggle('hidden', !footerHTML);
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('show'));
  trapFocus(overlay, true);
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  const cb = _onModalClose; _onModalClose = null;
  if (cb) { try { cb(); } catch (e) { console.error('[ui] modal onClose failed', e); } }
  releaseFocusTrap();
  overlay.classList.remove('show');
  const token = _modalToken;
  setTimeout(() => {
    if (token !== _modalToken) return;     // another modal was opened meanwhile — leave it alone
    overlay.classList.add('hidden');
    const bEl = document.getElementById('modal-body');
    const fEl = document.getElementById('modal-footer');
    if (bEl) bEl.innerHTML = '';
    if (fEl) fEl.innerHTML = '';
    _savedFocus?.focus();
  }, 300);
}

// ── Focus trap ────────────────────────────────────────────────────────────────
// ── Focus trap ─────────────────────────────────────────────────────────────────
let _trapAbort = null;

export function trapFocus(container, autoFocus = false) {
  // Cancel any previous trap listener
  if (_trapAbort) { _trapAbort.abort(); _trapAbort = null; }
  const focusable = container.querySelectorAll(
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  if (autoFocus) { setTimeout(() => focusable[0].focus(), 50); }
  const first = focusable[0], last = focusable[focusable.length - 1];
  _trapAbort = new AbortController();
  container.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
    else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
  }, { signal: _trapAbort.signal });
}

export function releaseFocusTrap() {
  if (_trapAbort) { _trapAbort.abort(); _trapAbort = null; }
}

// ── Ripple effect ─────────────────────────────────────────────────────────────
export function ripple(e, el) {
  const r = document.createElement('span');
  r.className = 'ripple';
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  r.style.cssText = `width:${size}px;height:${size}px;top:${e.clientY-rect.top-size/2}px;left:${e.clientX-rect.left-size/2}px`;
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
export const $ = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') node.append(document.createTextNode(child));
    else if (child instanceof Node) node.appendChild(child);
  }
  return node;
}

// ── Format helpers ────────────────────────────────────────────────────────────
export function formatFileSize(bytes) {
  if (bytes < 1024)          return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}

// ── Progress dialog ───────────────────────────────────────────────────────────
/**
 * Modal with a real progress bar and a Cancel button. Dismissing it any other way (X, backdrop, Android Back)
 * also cancels. Returns { signal, update(text, fraction|null), done() }.
 *   update(text, 0..1)  determinate;  update(text, null)  indeterminate
 *   done()              closes the dialog WITHOUT triggering cancel
 */
export function showProgress(title, { cancelable = true, text = 'Starting…' } = {}) {
  const ctrl = new AbortController();
  openModal(title,
    `<p id="progress-text" style="color:var(--text-secondary);font-size:14px;margin-bottom:12px" aria-live="polite">${text}</p>
     <div style="height:8px;background:var(--surface-hover);border-radius:9999px;overflow:hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="progress-track">
       <div id="progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--primary),var(--accent));transition:width 150ms"></div>
     </div>`,
    cancelable ? '<button class="btn btn-secondary" id="progress-cancel">Cancel</button>' : '',
    { onClose: () => ctrl.abort() });
  document.getElementById('progress-cancel')?.addEventListener('click', () => closeModal());
  const api = {
    signal: ctrl.signal,
    update(msg, fraction) {
      const t = document.getElementById('progress-text');
      const b = document.getElementById('progress-bar');
      const k = document.getElementById('progress-track');
      if (t && msg != null) t.textContent = msg;
      if (b && fraction != null) {
        const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
        b.style.width = pct + '%';
        k?.setAttribute('aria-valuenow', String(pct));
      }
    },
    done() { _onModalClose = null; closeModal(); },
  };
  return api;
}

// ── Download helper ───────────────────────────────────────────────────────────
/**
 * Saves a Blob for the user. Android: verified save into Download/FYLO via the native bridge (a plain
 * <a download> click is silently ignored inside WebView). Browser: normal download.
 * Always resolves to { ok, name, path, uri, bytes, verified } or { ok:false, error } and tells the user either way.
 */
export async function downloadBlob(blob, filename, opts = {}) {
  const r = await Device.saveBlob(blob, filename, opts);
  if (!opts.quiet) {
    if (r.ok) toast(r.verified ? `Saved to ${r.path}` : 'Download started');
    else if (!r.cancelled) toast(`Could not save ${filename}: ${r.error}`, 5000);
  }
  return r;
}

// ── Misc ──────────────────────────────────────────────────────────────────────
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms) {
  let last = 0;
  return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } };
}
