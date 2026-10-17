/**
 * FYLO Feature — Menu drawer (the three-line button)
 *
 * Owns: opening/closing the drawer, focus handling, dismissal (backdrop, close button, Escape, Android Back),
 * and emitting 'menu:action' for the chosen item. It never navigates itself — app.js (which already knows every
 * module) turns actions into navigation, so features stay decoupled.
 *
 * Robustness:
 *   - init() is idempotent: listeners are attached exactly once, however many times it is called.
 *   - Item clicks use ONE delegated listener (no per-open re-binding → no duplicate handlers).
 *   - open()/close() are idempotent, so rapid repeated taps cannot stack or desync the state.
 */

import { bus } from '../../core/eventBus.js';
import { State } from '../../core/state.js';
import { PAGES } from '../../core/constants.js';
import { trapFocus, releaseFocusTrap } from '../../core/ui.js';
import { Device } from '../../core/device.js';

let _wired = false;
let _open = false;
let _returnFocus = null;

const $ = id => document.getElementById(id);

function _syncCurrent() {
  document.querySelectorAll('#menu-drawer [data-menu-page]').forEach(btn => {
    if (btn.dataset.menuPage === State.page) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function open() {
  if (_open) return;
  const drawer = $('menu-drawer'), overlay = $('menu-overlay'), btn = $('menu-btn');
  if (!drawer || !overlay) return;
  _open = true;
  _returnFocus = document.activeElement;
  $('menu-ondevice')?.classList.toggle('hidden', !Device.canBrowseDevice);
  _syncCurrent();
  overlay.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  overlay.setAttribute('aria-hidden', 'false');
  btn?.setAttribute('aria-expanded', 'true');
  trapFocus(drawer, false);
  // Focus the drawer's first control once it is visible (visibility transition would otherwise swallow the call).
  // (focus() is a no-op while the element is still visibility:hidden, which is the case for the first frame
  // of the transition — so retry a few times until the drawer actually holds focus.)
  const target = () => drawer.querySelector('.menu-item:not(.hidden)') || drawer;
  let tries = 0;
  const focusIn = () => {
    if (!_open || drawer.contains(document.activeElement)) return;
    target().focus();
    if (!drawer.contains(document.activeElement) && ++tries < 8) setTimeout(focusIn, 40);
  };
  requestAnimationFrame(() => setTimeout(focusIn, 0));
}

function close({ restoreFocus = true } = {}) {
  if (!_open) return;
  const drawer = $('menu-drawer'), overlay = $('menu-overlay'), btn = $('menu-btn');
  _open = false;
  releaseFocusTrap();
  overlay?.classList.remove('open');
  drawer?.classList.remove('open');
  drawer?.setAttribute('aria-hidden', 'true');
  overlay?.setAttribute('aria-hidden', 'true');
  btn?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && _returnFocus && document.contains(_returnFocus)) _returnFocus.focus();
  _returnFocus = null;
}

function init() {
  if (_wired) return;
  _wired = true;

  $('menu-btn')?.addEventListener('click', () => {
    // Inside the reader the same button used to toggle the page-thumbnail sidebar; keep that behaviour there.
    if (State.page === PAGES.READER) { $('reader-sidebar')?.classList.toggle('open'); return; }
    open();
  });
  $('menu-close')?.addEventListener('click', () => close());
  $('menu-overlay')?.addEventListener('click', () => close());

  // One delegated listener for every menu entry.
  $('menu-drawer')?.addEventListener('click', e => {
    const item = e.target.closest('[data-menu-action]');
    if (!item) return;
    const action = item.dataset.menuAction;
    // Close first (without stealing focus back), then act — in the same tick, so a file picker opened by the
    // action is still inside the user's tap gesture.
    close({ restoreFocus: false });
    bus.emit('menu:action', { action });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _open) { e.preventDefault(); close(); }
  });

  // Android Back / any other module can ask the menu to close.
  bus.on('menu:closeRequest', () => close());
  // Navigating by any other means (bottom nav, search result …) must not leave the drawer open.
  bus.on('app:nav', () => close({ restoreFocus: false }));
}

export const MenuModule = {
  init,
  open,
  close,
  get isOpen() { return _open; },
};
