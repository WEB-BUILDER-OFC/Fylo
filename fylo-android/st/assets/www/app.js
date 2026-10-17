/**
 * FYLO — Application Bootstrap (app.js)
 *
 * Responsibility: wire everything together. No business logic here.
 *
 * Sequence:
 *   1. initStorage()
 *   2. Libs.init()         — PDF.js + PDF-Lib (non-blocking)
 *   3. SettingsModule.load()
 *   4. Load persisted files
 *   5. Register routes
 *   6. Each module wires its own toolbar
 *   7. Wire global events (nav, search, drag-drop, keyboard, resize)
 *   8. Init gesture engine
 *   9. Router.init()
 *  10. Render initial UI
 *  11. Hide splash
 *
 * Cross-module events use bus.emit(EVENTS.*).
 * Features never import each other — only core/* and their own files.
 */

import { bus, EVENTS }    from './core/eventBus.js';
import { State, Actions } from './core/state.js';
import { initStorage, FileStorage, SettingsStorage } from './core/storage.js';
import { Libs }           from './core/libs.js';
import { Router }         from './core/router.js';
import { PAGES }          from './core/constants.js';
import { toast, openModal, closeModal, ripple } from './core/ui.js';
import { createLogger }   from './core/logger.js';

// Feature entry points (each module owns its own internals)
import { ReaderModule, wireReaderToolbar, initGestureEngine }
  from './features/reader/index.js';
import { EditorModule, wireEditorToolbar }
  from './features/editor/index.js';
import { CameraModule }  from './features/camera/index.js';
import { ToolsModule }   from './features/tools/index.js';
import { FilesModule }   from './features/files/index.js';
import { SettingsModule } from './features/settings/index.js';
import { MenuModule }     from './features/menu/index.js';
import { Device }         from './core/device.js';
import { APP_VERSION }    from './core/constants.js';


const log = createLogger('App');

// ── Extended EVENTS (app-level, not in core eventBus) ────────────────────────
// These are declared here to avoid circular imports.
const APP_EVENTS = {
  READER_OPEN_REQUEST: 'reader:openRequest',
  EDITOR_OPEN_REQUEST: 'editor:openRequest',
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  log.info(`FYLO starting`);

  // 1. Storage
  try {
    await initStorage();
    log.info('Storage ready');
  } catch (e) {
    log.error('Storage init failed:', e);
    toast('Storage unavailable — files will not persist');
  }

  // 2. Libraries — load in background, features await internally
  Libs.init();

  // 3. Settings
  await SettingsModule.load();

  // 4. Persisted files
  await _loadPersistedFiles();

  // 5. Register routes
  _registerRoutes();

  // 6. Each module wires its own toolbar (no app.js DOM refs for features)
  _safeWire('search',         _wireSearch);
  _safeWire('manage',         _wireManage);
  _safeWire('reader toolbar', wireReaderToolbar);
  _safeWire('reader chrome',  _wireReaderChrome);
  _safeWire('editor toolbar', wireEditorToolbar);
  _safeWire('settings',       () => SettingsModule.init());
  _safeWire('menu',           () => { MenuModule.init(); _wireMenuActions(); });

  // 7. Global events
  _safeWire('global events',  _wireGlobalEvents);

  // 8. Gesture engine (reader touch/mouse/wheel)
  _safeWire('gesture engine', () => initGestureEngine(ReaderModule));

  // 9. Router
  Router.init();

  // 10. Initial render
  FilesModule.wireFileTabs();
  FilesModule.renderFiles();
  FilesModule.updateStorage();
  FilesModule.renderRecent();
  ToolsModule.renderCategories();
  ToolsModule.wireInputs();

  // 11. Splash
  _hideSplash();

  // 12. Android bridge — only active when window.AndroidBridge is injected by WebView
  if (typeof window.AndroidBridge !== 'undefined') {
    // Expose the event bus so MainActivity can deliver files via intent
    window.fyloEventBus = bus;
    // Install the back button handler
    import('./core/android-bridge.js').then(({ installBackHandler }) => {
      installBackHandler();
    }).catch(e => log.warn('Android bridge setup failed:', e));
    // Wire camera close request (back button closes camera)
    bus.on('camera:closeRequest', () => {
      import('./features/camera/index.js').then(({ CameraModule }) => CameraModule.close());
    });
    log.info('Android bridge active');
  }

  bus.emit(EVENTS.APP_READY, {});
  log.info('Bootstrap complete');
}

// ── Load persisted files ──────────────────────────────────────────────────────
async function _loadPersistedFiles() {
  try {
    const files = await FileStorage.loadAll();
    if (files?.length) {
      Actions.setFiles(files.reverse());
      log.info(`Loaded ${files.length} persisted files`);
    }
  } catch (e) { log.warn('Could not load persisted files:', e); }

  // Load persisted favorites
  try {
    const favIds = await SettingsStorage.load('favorites');
    if (Array.isArray(favIds)) {
      favIds.forEach(id => {
        if (State.files.find(f => f.id === id)) Actions.toggleFavorite(id);
      });
      log.info(`Loaded ${favIds.length} favorites`);
    }
  } catch(e) { log.warn('Could not load favorites:', e); }
}

// ── Route registration ────────────────────────────────────────────────────────
function _registerRoutes() {
  Router.register(PAGES.HOME, {
    el: document.getElementById('page-home'),
  });
  Router.register(PAGES.FILES, {
    el:      document.getElementById('page-files'),
    onEnter: () => { FilesModule.renderFiles(); FilesModule.updateStorage(); },
  });
  Router.register(PAGES.TOOLS, {
    el:      document.getElementById('page-tools'),
    onEnter: () => ToolsModule.renderCategories(),
  });
  Router.register(PAGES.SETTINGS, {
    el:      document.getElementById('page-settings'),
    onEnter: () => SettingsModule.render(),
  });
  Router.register(PAGES.READER, {
    el: document.getElementById('page-reader'),
    // Reader is a dedicated full-screen mode: the app bar, bottom nav and FAB are hidden and the
    // document itself cannot scroll (see `.reader-mode` in main.css). Left again in onLeave.
    onEnter: () => _setReaderMode(true),
    onLeave: () => { ReaderModule.close(); _setReaderMode(false); },
  });
  Router.register(PAGES.EDITOR, {
    el: document.getElementById('page-editor'),
  });
  // Camera is a fullscreen modal overlay, not a routed page — no registration needed.
}

// ── Reader full-screen mode ───────────────────────────────────────────────────
function _setReaderMode(on) {
  document.documentElement.classList.toggle('reader-mode', on);
  document.body.classList.toggle('reader-mode', on);
  if (on) _resetPageScroll();
}

// Nothing outside the PDF viewport may ever be scrolled while reading. CSS locks overflow; this is the
// belt-and-braces layer for things CSS cannot stop (focus-induced scroll when the soft keyboard opens
// for the page-number / search input, overscroll glow, a stray scrolled ancestor).
function _resetPageScroll() {
  const se = document.scrollingElement;
  if (se && (se.scrollTop || se.scrollLeft)) se.scrollTo(0, 0);
  const mc = document.querySelector('.main-content');
  if (mc && (mc.scrollTop || mc.scrollLeft)) { mc.scrollTop = 0; mc.scrollLeft = 0; }
  const pr = document.getElementById('page-reader');
  if (pr && (pr.scrollTop || pr.scrollLeft)) { pr.scrollTop = 0; pr.scrollLeft = 0; }
}

function _wireReaderChrome() {
  const page = document.getElementById('page-reader');
  if (!page) return;

  // Only the thumbnail strip (and text fields) may scroll by touch; the toolbar and the canvas must not
  // drag the page. The canvas wrap already handles its own gestures (preventDefault in gestures.js).
  page.addEventListener('touchmove', e => {
    if (e.target.closest?.('.reader-thumbs, input, .reader-search-bar')) return;
    e.preventDefault();
  }, { passive: false });

  const guard = () => { if (document.documentElement.classList.contains('reader-mode')) _resetPageScroll(); };
  window.addEventListener('scroll', guard, { passive: true });
  document.querySelector('.main-content')?.addEventListener('scroll', guard, { passive: true });
  page.addEventListener('scroll', guard, { passive: true });

  // Reader's own Back button (the app bar is hidden while reading)
  document.getElementById('reader-back')?.addEventListener('click', () => {
    const dest = (State.prevPage && State.prevPage !== PAGES.READER) ? State.prevPage : PAGES.FILES;
    Router.go(dest);
  });
}

// ── Global search (own function so a failure elsewhere in startup can never skip it) ──
function _wireSearch() {
  // ── Global search ───────────────────────────────────────────────────────
  const searchBtn   = document.getElementById('search-btn');
  const searchBar   = document.getElementById('search-overlay');
  const searchInput = document.getElementById('search-input');
  const searchClose = document.getElementById('search-close');

  searchBtn?.addEventListener('click',  () => {
    searchBar?.classList.remove('hidden');
    searchBar?.classList.add('show');
    searchInput?.focus();
  });
  searchClose?.addEventListener('click', () => {
    searchBar?.classList.remove('show');
    searchBar?.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) resultsEl.innerHTML = '';
    if (State.page === PAGES.FILES) FilesModule.renderFiles();
  });
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      const resultsEl = document.getElementById('search-results');
      if (resultsEl) resultsEl.innerHTML = '';
      return;
    }
    const filtered = State.files.filter(f => f.name.toLowerCase().includes(q));
    // Show results in search-results panel
    const resultsEl = document.getElementById('search-results');
    if (resultsEl) {
      if (!filtered.length) {
        resultsEl.innerHTML = '<p style="padding:12px;color:var(--text-tertiary);font-size:13px">No PDFs found</p>';
      } else {
        resultsEl.innerHTML = filtered.map(f => `
          <div class="search-result-item" data-file-id="${f.id}" style="padding:10px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span style="font-size:13px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name.replace(/</g,'&lt;')}</span>
          </div>`).join('');
        resultsEl.querySelectorAll('[data-file-id]').forEach(el => {
          el.addEventListener('click', () => {
            searchBar?.classList.remove('show');
            searchBar?.classList.add('hidden');
            if (searchInput) searchInput.value = '';
            resultsEl.innerHTML = '';
            bus.emit('reader:openRequest', { fileId: el.dataset.fileId });
          });
        });
      }
    }
    // Also filter Files page if we're on it
    if (State.page === PAGES.FILES) {
      bus.emit('files:renderFiltered', { files: filtered });
    }
  });
}

// ── Home storage card: Manage ─────────────────────────────────────────────────
// #storage-manage previously had no handler at all, so tapping it did nothing.
// Managing local storage = reviewing / deleting stored PDFs, which lives on the Files page.
function _wireManage() {
  document.getElementById('storage-manage')?.addEventListener('click', () => Router.go(PAGES.FILES));
}

// Wire one feature; an exception in one must not prevent the rest of the UI from working.
function _safeWire(name, fn) {
  try { fn(); } catch (e) { log.error(`Wiring "${name}" failed:`, e); }
}

// ── Global event wiring ───────────────────────────────────────────────────────
function _wireGlobalEvents() {

  // ── Navigation bar ──────────────────────────────────────────────────────
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', e => { ripple(e, item); Router.go(item.dataset.page); });
  });
  // Keep the bottom-bar highlight in step with the real page (menu shortcuts and deep links navigate without a tap on it).
  bus.on(EVENTS.APP_NAV, ({ page }) => {
    document.querySelectorAll('.nav-item[data-page]').forEach(i => {
      const on = i.dataset.page === page;
      i.classList.toggle('active', on);
      if (on) i.setAttribute('aria-current', 'page'); else i.removeAttribute('aria-current');
    });
  });
  document.getElementById('back-btn')?.addEventListener('click',
    () => Router.go(State.prevPage || PAGES.HOME));

  // ── Cross-module open requests ──────────────────────────────────────────
  bus.on(APP_EVENTS.READER_OPEN_REQUEST, ({ fileId })       => ReaderModule.open(fileId));
  bus.on(APP_EVENTS.EDITOR_OPEN_REQUEST, ({ fileId, tool }) => EditorModule.open(fileId, tool));

  // ── File input / drag-drop ──────────────────────────────────────────────
  const fileInput = document.getElementById('file-input');
  fileInput?.addEventListener('change', e => {
    const files = [...e.target.files];
    if (files.length) FilesModule.handleFiles(files);
    e.target.value = '';
  });
  document.getElementById('fab')?.addEventListener('click',
    () => fileInput?.click());

  // Drag-drop on the files page and home page
  const dropTargets = [
    document.getElementById('page-files'),
    document.getElementById('page-home'),
  ].filter(Boolean);
  dropTargets.forEach(zone => {
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(f =>
        f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (files.length) FilesModule.handleFiles(files);
    });
  });

  // ── Modal ────────────────────────────────────────────────────────────────
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // ── Nav: aria-current for screen readers ─────────────────────────────────
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-page]').forEach(b => b.removeAttribute('aria-current'));
      btn.setAttribute('aria-current', 'page');
    });
  });

  // Camera is opened via the home quick-action 'scan' button (data-home-action="scan")
  // and via bus.emit('camera:openRequest')
  bus.on('camera:openRequest', () => CameraModule.open());

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const mod    = e.ctrlKey || e.metaKey;

    if (State.page === PAGES.READER && !typing) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); ReaderModule.zoomIn(); }
      if (e.key === '-')                  { e.preventDefault(); ReaderModule.zoomOut(); }
      if (e.key === 'Escape')             { e.preventDefault(); Router.go(PAGES.FILES); }
      if (e.key === 'ArrowLeft')          { e.preventDefault(); ReaderModule.goToPage(ReaderModule.currentPage - 1); }
      if (e.key === 'ArrowRight')         { e.preventDefault(); ReaderModule.goToPage(ReaderModule.currentPage + 1); }
    }

    if (State.page === PAGES.EDITOR) {
      if (mod && e.key === 'z')                        { e.preventDefault(); EditorModule.undo(); }
      if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); EditorModule.redo(); }
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); EditorModule.deleteSelected();
      }
    }

    if (e.key === 'Escape') {
      const overlay = document.getElementById('modal-overlay');
      if (overlay?.classList.contains('show')) closeModal();
    }
  });

  // ── Window resize ────────────────────────────────────────────────────────
  let _resizeTimer, _lastW = 0, _lastH = 0;
  window.addEventListener('resize', () => {
    if (State.page !== PAGES.READER) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const ww = window.innerWidth, wh = window.innerHeight;
      const major = Math.abs(ww - _lastW) > 80 || Math.abs(wh - _lastH) > 80;
      _lastW = ww; _lastH = wh;
      const rs = ReaderModule._rs;
      if (!rs?.canvasWidth) return;
      if (major) {
        // Orientation / viewport change: recompute fit-to-screen for the current page
        ReaderModule.refit();
      } else {
        ReaderModule._clampTransform?.();
        ReaderModule._applyTransform?.();
      }
    }, 200);
  });

  // ── Bus: APP_NAV_REQUEST (modules may bus.emit a nav request instead of calling Router.go) ──
  // IMPORTANT: this must NOT listen on EVENTS.APP_NAV. Router.go() *emits* APP_NAV after every
  // navigation; listening to it here and calling Router.go() again recursed forever and froze
  // the WebView main thread on the splash screen.
  bus.on(EVENTS.APP_NAV_REQUEST, ({ page, push }) => Router.go(page, push ?? true));

  log.info('Global events wired');
}

// ── Menu actions ──────────────────────────────────────────────────────────────
// The menu module only announces which entry was chosen; navigation lives here, next to the modules it needs.
function _wireMenuActions() {
  bus.on('menu:action', ({ action }) => {
    if (action.startsWith('nav:'))  { Router.go(action.slice(4)); return; }
    switch (action) {
      case 'ondevice':
        Router.go(PAGES.FILES).then(() => bus.emit('files:selectTab', { tab: 'device' }));
        break;
      case 'open':   document.getElementById('file-input')?.click(); break;   // same tick: still inside the tap gesture
      case 'scan':   bus.emit('camera:openRequest', {}); break;
      default:       // a tool id (merge, compress, pdf-to-img, img-to-pdf …)
        Router.go(PAGES.TOOLS);
        setTimeout(() => ToolsModule.startFlow(action), 150);
    }
  });
}

// ── Splash hide ───────────────────────────────────────────────────────────────
function _hideSplash() {
  const splash = document.getElementById('splash');
  const app    = document.getElementById('app');
  if (!splash) return;
  splash.classList.add('fade-out');
  splash.style.pointerEvents = 'none';
  setTimeout(() => {
    splash.classList.add('hidden');
    splash.style.display = 'none';
    app?.classList.remove('hidden');
    app?.classList.add('show');
  }, 500);
}

// ── Error safety net ──────────────────────────────────────────────────────────
window.onerror = () => _hideSplash();
window.addEventListener('unhandledrejection', () => _hideSplash());

// ── Service Worker registration ───────────────────────────────────────────────
// Browser/PWA only. The Android app ships every file inside the APK, so a service worker adds nothing there —
// and a cache-first worker is exactly what can keep serving an OLD copy of the app after the APK was updated.
// (MainActivity also removes any worker left behind by an older build.)
// The version in the URL makes every release a new worker script, so the browser always installs the new one.
if ('serviceWorker' in navigator && !Device.isAndroid) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: './' })
      .then(reg => {
        log.info('Service Worker registered:', reg.scope);
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'SW_UPDATED') bus.emit('sw:updateAvailable', {});
        });
      })
      .catch(e => log.warn('Service Worker registration failed:', e));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
// type="module" scripts are deferred automatically — DOM is ready here.
bootstrap();
