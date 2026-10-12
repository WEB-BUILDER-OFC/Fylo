/**
 * FYLO Feature — PDFs on this device (Android app only)
 *
 * Shows the PDFs FYLO is allowed to see, inside the app, without any broad storage permission:
 *   - folders the user granted once through the system folder picker (persisted by Android), and
 *   - the PDFs FYLO itself saved to Downloads/FYLO.
 * Native side: DevicePdfs.java + the /device/ path handler in MainActivity.java.
 *
 * Only metadata is listed. A file's bytes are read on demand, for the ONE file the user taps, and that file is
 * handed to the normal import path (so it opens in the existing Reader). Nothing else is copied into app storage.
 *
 * This module does not exist for the web/PWA build: the tab stays hidden unless the native bridge offers it.
 */

import { bus } from '../../core/eventBus.js';
import { State } from '../../core/state.js';
import { toast, formatFileSize, formatDate } from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('DevicePdfs');

const DEVICE_URL_BASE = 'https://appassets.androidplatform.net/device/';
const PAGE_SIZE       = 100;
const SCAN_TIMEOUT_MS = 45000;

const _s = {
  items: [],            // [{id,name,folder,source,size,modified}]
  folders: [],          // [{uri,name,accessible}]
  errors: [],
  truncated: false,
  scanning: false,
  scannedOnce: false,
  lastScanAt: 0,
  shown: PAGE_SIZE,
  thumbs: new Map(),    // id -> dataUrl | null (null = no preview available)
  thumbRequested: new Set(),
  opening: new Set(),
  scanTimer: null,
  wired: false,
};

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function deviceSupported() {
  return typeof window.AndroidBridge !== 'undefined' && typeof window.AndroidBridge.scanDevicePdfs === 'function';
}

function _tabActive() {
  return document.querySelector('.file-tab.active')?.dataset.tab === 'device';
}

function _loadFolders() {
  try { _s.folders = JSON.parse(window.AndroidBridge.getPdfFolders() || '[]'); }
  catch (e) { log.warn('getPdfFolders failed:', e); _s.folders = []; }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
export function scan() {
  if (!deviceSupported()) return;
  _loadFolders();
  if (_s.scanning) return;                                   // one scan at a time; its result will render
  _s.scanning = true;
  clearTimeout(_s.scanTimer);
  // A scan that never reports back must not leave the spinner running forever.
  _s.scanTimer = setTimeout(() => {
    if (!_s.scanning) return;
    _s.scanning = false;
    _s.errors = ['The scan did not finish. Pull to refresh or try again.'];
    render();
  }, SCAN_TIMEOUT_MS);
  let r;
  try { r = window.AndroidBridge.scanDevicePdfs(); } catch (e) { r = 'failed'; log.warn('scan threw:', e); }
  if (r === 'failed') {
    _s.scanning = false; clearTimeout(_s.scanTimer);
    _s.errors = ['Could not start the scan.'];
  }
  render();
}

function _onScanResult(json) {
  clearTimeout(_s.scanTimer);
  _s.scanning = false;
  _s.scannedOnce = true;
  _s.lastScanAt = Date.now();
  try {
    const d = JSON.parse(json);
    _s.items = Array.isArray(d.items) ? d.items : [];
    _s.errors = Array.isArray(d.errors) ? [...new Set(d.errors)] : [];
    _s.truncated = !!d.truncated;
  } catch (e) {
    log.error('Bad scan payload:', e);
    _s.items = []; _s.errors = ['The device returned an unreadable list.']; _s.truncated = false;
  }
  _s.shown = PAGE_SIZE;
  _loadFolders();
  if (_tabActive()) render();
}

function _onThumb(id, dataUrl) {
  _s.thumbs.set(id, dataUrl || null);
  if (!_tabActive()) return;
  const el = document.querySelector(`[data-device-thumb="${CSS.escape(id)}"]`);
  if (el && dataUrl) el.innerHTML = `<img src="${dataUrl}" alt="">`;
}

function _onFolderPicked(ok, msg) {
  if (ok) { toast('Folder added'); scan(); return; }
  if (msg === 'cancelled') toast('No folder selected');
  else toast('Could not keep access to that folder');
}

// ── Actions ───────────────────────────────────────────────────────────────────
function _addFolder() {
  try { window.AndroidBridge.pickPdfFolder(); }
  catch (e) { toast('Could not open the folder picker'); log.warn(e); }
}

function _removeFolder(uri) {
  let ok = false;
  try { ok = window.AndroidBridge.removePdfFolder(uri); } catch (e) { log.warn(e); }
  toast(ok ? 'Folder removed (your files are untouched)' : 'Could not remove that folder');
  scan();
}

async function _open(item) {
  if (_s.opening.has(item.id)) return;                       // ignore repeated taps while reading
  _s.opening.add(item.id);
  const row = document.querySelector(`[data-device-id="${CSS.escape(item.id)}"]`);
  row?.classList.add('is-busy');
  try {
    const res = await fetch(`${DEVICE_URL_BASE}${encodeURIComponent(item.id)}.pdf`, { cache: 'no-store' });
    if (!res.ok) {
      toast('That PDF is no longer available. Refreshing the list…', 4000);
      _s.items = _s.items.filter(i => i.id !== item.id);
      scan();
      return;
    }
    const blob = await res.blob();
    if (!blob.size) { toast(`${item.name} is empty`); return; }
    const file = new File([blob], item.name, { type: 'application/pdf', lastModified: item.modified || blob.size });
    bus.emit('files:incoming', {
      files: [file],
      onSaved: ids => {
        const id = ids?.[0] ?? State.files.find(f => f.name === file.name && f.size === file.size)?.id;
        if (id) bus.emit('reader:openRequest', { fileId: id });
        else toast('Could not open that PDF');
      },
    });
  } catch (e) {
    log.error('Open device PDF failed:', e);
    toast('Could not open that PDF');
  } finally {
    _s.opening.delete(item.id);
    row?.classList.remove('is-busy');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const ICON_PDF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

export function render() {
  const elEmpty = document.getElementById('files-empty');
  const elList  = document.getElementById('files-list');
  if (!elEmpty || !elList) return;
  elEmpty.classList.add('hidden');
  elList.classList.remove('hidden');
  if (!deviceSupported()) { elList.innerHTML = ''; return; }

  const hasFolders = _s.folders.length > 0;
  const toolbar = `
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button type="button" class="btn btn-secondary" data-device-act="add" style="flex:1;min-width:140px">Add folder</button>
      <button type="button" class="btn btn-secondary" data-device-act="refresh" style="flex:1;min-width:120px" ${_s.scanning ? 'disabled' : ''}>${_s.scanning ? 'Scanning…' : 'Refresh'}</button>
    </div>`;

  const folderChips = hasFolders ? `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">${_s.folders.map(f => `
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary)">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}${f.accessible ? '' : ' — unavailable'}</span>
        <button type="button" class="text-btn" data-device-remove="${esc(f.uri)}" aria-label="Remove folder ${esc(f.name)}">Remove</button>
      </div>`).join('')}
    </div>` : '';

  const notes = [
    ..._s.errors.map(e => `<p style="font-size:12px;color:var(--text-tertiary);margin:0 0 8px">${esc(e)}</p>`),
    _s.truncated ? '<p style="font-size:12px;color:var(--text-tertiary);margin:0 0 8px">Showing the most recent PDFs only. Choose a more specific folder to narrow the list.</p>' : '',
  ].join('');

  let body = '';
  if (!_s.scannedOnce && _s.scanning) {
    body = '<div class="empty-state"><p>Looking for PDFs…</p></div>';
  } else if (!_s.items.length && !hasFolders) {
    body = `<div class="empty-state">
      <div class="empty-icon">${ICON_PDF.replace('width="20" height="20"','width="48" height="48"')}</div>
      <h3>Choose where your PDFs are</h3>
      <p>Android only lets an app see folders you pick. Choose a folder such as Download or Documents once and FYLO will list its PDFs here.</p>
    </div>`;
  } else if (!_s.items.length) {
    body = `<div class="empty-state"><h3>No PDFs found</h3><p>There are no PDFs in the folders you chose. Add another folder or refresh.</p></div>`;
  } else {
    const rows = _s.items.slice(0, _s.shown).map(it => {
      const thumb = _s.thumbs.get(it.id);
      const meta = [it.size >= 0 ? formatFileSize(it.size) : null, it.modified ? formatDate(it.modified) : null, it.folder].filter(Boolean).map(esc).join(' &middot; ');
      return `<div class="recent-item" data-device-id="${esc(it.id)}" role="button" tabindex="0">
        <div class="recent-thumb" data-device-thumb="${esc(it.id)}">${thumb ? `<img src="${thumb}" alt="">` : ICON_PDF}</div>
        <div class="recent-info">
          <span class="recent-name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="recent-meta">${meta}</span>
        </div>
      </div>`;
    }).join('');
    const more = _s.items.length > _s.shown
      ? `<button type="button" class="btn btn-secondary" data-device-act="more" style="width:100%;margin-top:8px">Show more (${_s.items.length - _s.shown} left)</button>` : '';
    body = `<p style="font-size:12px;color:var(--text-tertiary);margin:0 0 8px">${_s.items.length} PDF${_s.items.length === 1 ? '' : 's'}</p>${rows}${more}`;
  }

  elList.innerHTML = toolbar + folderChips + notes + body;
  _wireList(elList);
  _observeThumbs(elList);
}

function _wireList(root) {
  root.querySelector('[data-device-act="add"]')?.addEventListener('click', _addFolder);
  root.querySelector('[data-device-act="refresh"]')?.addEventListener('click', scan);
  root.querySelector('[data-device-act="more"]')?.addEventListener('click', () => { _s.shown += PAGE_SIZE; render(); });
  root.querySelectorAll('[data-device-remove]').forEach(b => b.addEventListener('click', () => _removeFolder(b.dataset.deviceRemove)));
  root.querySelectorAll('[data-device-id]').forEach(row => {
    const open = () => { const it = _s.items.find(i => i.id === row.dataset.deviceId); if (it) _open(it); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// Previews are rendered by Android for the rows that are actually on screen, one at a time.
function _observeThumbs(root) {
  if (typeof IntersectionObserver === 'undefined') return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const id = en.target.dataset.deviceThumb;
      io.unobserve(en.target);
      if (!id || _s.thumbs.has(id) || _s.thumbRequested.has(id)) return;
      _s.thumbRequested.add(id);
      try { window.AndroidBridge.requestDevicePdfThumb(id); } catch (e) { log.warn(e); }
    });
  }, { root: null, rootMargin: '200px' });
  root.querySelectorAll('[data-device-thumb]').forEach(el => io.observe(el));
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function activate() {
  if (!deviceSupported()) return;
  _loadFolders();
  // Re-scan when the tab opens, unless a scan finished moments ago.
  if (!_s.scannedOnce || Date.now() - _s.lastScanAt > 15000) scan(); else render();
}

export function initDevice() {
  if (!deviceSupported() || _s.wired) return;
  _s.wired = true;
  document.getElementById('files-tab-device')?.classList.remove('hidden');
  window.fyloOnDevicePdfs        = _onScanResult;
  window.fyloOnDevicePdfThumb    = _onThumb;
  window.fyloOnDeviceFolderPicked = _onFolderPicked;
  // Returning from the system folder picker / another app: pick up files added or deleted meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _tabActive()) scan();
  });
  bus.on('files:showDeviceTab', () => {
    document.querySelectorAll('.file-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'device'));
    activate();
  });
}
