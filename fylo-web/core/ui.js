/**
 * FYLO Core — UI Utilities
 * Shared UI primitives: toast, modal, ripple, focus trap, DOM helpers.
 * No business logic here — only generic UI building blocks.
 */

import { TOAST_DURATION_MS } from './constants.js';
import { bus, EVENTS } from './eventBus.js';

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

export function openModal(title, bodyHTML, footerHTML = '') {
  const overlay = document.getElementById('modal-overlay');
  const tEl = document.getElementById('modal-title');
  const bEl = document.getElementById('modal-body');
  const fEl = document.getElementById('modal-footer');
  if (!overlay) return;
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
  releaseFocusTrap();
  overlay.classList.remove('show');
  setTimeout(() => {
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

// ── Download helper ───────────────────────────────────────────────────────────
export function downloadBlob(blob, filename) {
  // Android WebView: native bridge handles downloads (a.click() is blocked in WebView)
  if (typeof window.AndroidBridge !== 'undefined') {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma   = dataUrl.indexOf(',');
      const base64  = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      window.AndroidBridge.saveFile(base64, filename, blob.type || 'application/pdf');
    };
    reader.readAsDataURL(blob);
    return;
  }
  // Web / PWA: standard anchor download
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
