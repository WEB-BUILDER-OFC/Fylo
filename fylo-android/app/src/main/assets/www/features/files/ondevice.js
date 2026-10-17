/**
 * FYLO Feature — On Device (browse PDFs in folders the user granted)
 *
 * Android's Storage Access Framework: the user picks folders; FYLO can list and read PDFs inside THOSE folders only.
 * No broad storage permission is requested, and FYLO does NOT see "all files on the phone". Real limits, stated in
 * the UI: on Android 11+ the system refuses a few locations (the top-level Download folder, Android/data, the
 * storage root) — pick a sub-folder or a different folder instead. Access can be revoked by the user or by the
 * system (folder deleted, SD card removed); every scan can therefore end in "access lost", and that is handled.
 *
 * This file only touches the DOM inside #ondevice-panel and talks to the rest of the app through the bus.
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State } from '../../core/state.js';
import { Device } from '../../core/device.js';
import { Library } from './library.js';
import { toast, openModal, closeModal, formatFileSize, formatDate } from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('OnDevice');

const PAGE_SIZE = 100;
const MAX_OPEN_BYTES = 300 * 1024 * 1024;
const STALE_MS = 2 * 60 * 1000;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const _s = {
  folders: [],          // [{uri,name,accessible}]
  scans: new Map(),     // folderUri → { status:'ok'|'revoked'|'error'|'loading', files, truncated, reason, message, at }
  filter: '',
  shown: PAGE_SIZE,
  sort: 'recent',       // 'recent' | 'name'
  ctrl: null,           // AbortController of the running scan batch
  busy: new Set(),      // document URIs being opened (guards repeated taps)
  wired: false,
};

const panel = () => document.getElementById('ondevice-panel');
const isActive = () => document.querySelector('.file-tab.active')?.dataset.tab === 'device';

// ── Scanning ─────────────────────────────────────────────────────────────────
async function scanAll({ force = false } = {}) {
  _s.folders = Device.folders();
  if (!_s.folders.length) { render(); return; }
  _s.ctrl?.abort();
  const ctrl = _s.ctrl = new AbortController();
  const todo = _s.folders.filter(f => force || !_s.scans.get(f.uri) || Date.now() - (_s.scans.get(f.uri).at || 0) > STALE_MS);
  for (const f of todo) _s.scans.set(f.uri, { status: f.accessible ? 'loading' : 'revoked', files: [], at: 0 });
  render();
  await Promise.all(todo.filter(f => f.accessible).map(async f => {
    const r = await Device.listPdfs(f.uri, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    if (r.ok) {
      _s.scans.set(f.uri, { status: 'ok', files: r.files || [], truncated: !!r.truncated, reason: r.truncatedReason, unreadable: r.unreadableFolders || 0, at: Date.now() });
    } else {
      const revoked = r.error === 'ACCESS_REVOKED';
      _s.scans.set(f.uri, { status: revoked ? 'revoked' : 'error', files: [], message: r.message || r.error, at: Date.now() });
    }
    if (isActive()) render();
  }));
  if (!ctrl.signal.aborted && isActive()) render();
}

// ── Adding / removing folders ────────────────────────────────────────────────
let _picking = false;

/** Jump to Files → On Device (used after a folder was added from Settings or the menu). */
function showDeviceTab() {
  bus.emit(EVENTS.APP_NAV_REQUEST, { page: 'files' });
  setTimeout(() => bus.emit('files:selectTab', { tab: 'device' }), 150);
}

async function onFolderAdded(folder, { goToList = false } = {}) {
  if (folder?.persisted === false) toast('Added for now, but Android would not keep this permission after a restart.', 5000);
  else toast(`Added “${folder?.name || 'folder'}”`);
  if (folder?.uri) _s.scans.delete(folder.uri);
  await scanAll({ force: true });
  bus.emit('library:refresh', {});
  refreshManager();
  if (goToList && !isActive()) showDeviceTab();
}

async function addFolder({ goToList = false } = {}) {
  if (_picking) return;                     // repeated taps while the system picker is open
  _picking = true;
  try {
    toast('Opening Android’s folder picker…', 1800);
    const r = await Device.pickFolder();
    log.info('folder picker result', r);
    if (r.cancelled) { toast('No folder chosen'); return; }
    if (!r.ok) { toast('Could not add the folder: ' + (r.error || 'unknown error'), 5000); return; }
    await onFolderAdded(r.folder, { goToList });
  } finally { _picking = false; }
}

// The picker's answer can arrive when nothing is waiting for it (page reloaded / Activity recreated while the system
// picker was open). Native already saved the grant, so just refresh from it.
window.addEventListener('fylo:folderPicked', async e => {
  const r = e.detail || {};
  if (r.ok && r.folder) await onFolderAdded(r.folder, { goToList: true });
  else if (r.error) toast('Could not add the folder: ' + r.error, 5000);
});

function removeFolder(uri) {
  Device.removeFolder(uri);
  _s.scans.delete(uri);
  _s.folders = Device.folders();
  render(); refreshManager();
  bus.emit('library:refresh', {});
}

// ── Opening a PDF ────────────────────────────────────────────────────────────
async function openEntry(entry, folderUri) {
  if (_s.busy.has(entry.uri)) return;
  _s.busy.add(entry.uri); render();
  try {
    // Open IN PLACE: the library keeps a tiny reference record (no copy of the PDF). Reading happens through
    // Android's document provider when the Reader loads it, so a revoked/moved file is reported there.
    const rec = Library.adopt({ name: entry.name, size: entry.size, modified: entry.modified, ref: { kind: 'saf', uri: entry.uri } });
    const chk = await Library.checkOpenable(rec);
    if (!chk.ok) {
      if (chk.code === 'ACCESS_REVOKED') { toast('Access to that folder was removed. Add it again to keep browsing.', 5000); _s.scans.set(folderUri, { status: 'revoked', files: [], at: Date.now() }); }
      else { toast('That file is no longer there — refreshing the list.'); scanAll({ force: true }); }
      return;
    }
    bus.emit('files:open', { fileId: rec.id });
  } finally { _s.busy.delete(entry.uri); if (isActive()) render(); }
}

// ── Rendering ────────────────────────────────────────────────────────────────
function allEntries() {
  const out = [];
  for (const f of _s.folders) {
    const sc = _s.scans.get(f.uri);
    if (sc?.status !== 'ok') continue;
    for (const e of sc.files) out.push({ ...e, folderUri: f.uri, folderName: f.name });
  }
  const q = _s.filter.trim().toLowerCase();
  const list = q ? out.filter(e => e.name.toLowerCase().includes(q) || (e.path || '').toLowerCase().includes(q)) : out;
  list.sort(_s.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : (a, b) => (b.modified || 0) - (a.modified || 0));
  return list;
}

const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function render() {
  const el = panel();
  if (!el) return;
  const keepFocus = document.activeElement?.id === 'ondevice-search' ? { pos: document.activeElement.selectionStart } : null;

  const note = `<div class="ondevice-note">Folders you choose here are listed in <strong>All PDFs</strong> too, and their PDFs open in place (no copy). This works without any broad storage permission. To see every PDF on the phone at once instead, allow access from Settings → PDFs on this phone. Android may refuse the main <em>Download</em> folder or <em>Android/data</em>; choose a sub-folder instead.</div>`;

  if (!_s.folders.length) {
    el.innerHTML = `${note}<div class="empty-state" style="padding:24px 0"><h3>No folders chosen yet</h3><p>Choose a folder to see the PDFs inside it.</p></div>
      <div class="ondevice-toolbar"><button class="btn btn-primary" id="od-add">Choose a folder</button></div>`;
    el.querySelector('#od-add').addEventListener('click', () => addFolder());
    return;
  }

  const chips = _s.folders.map(f => {
    const sc = _s.scans.get(f.uri);
    const lost = !f.accessible || sc?.status === 'revoked';
    return `<div class="ondevice-chip ${lost ? 'warn' : ''}"><span title="${esc(f.name)}">${lost ? '⚠ ' : ''}${esc(f.name)}</span>${lost ? `<button data-regrant="${esc(f.uri)}" title="Choose this folder again" aria-label="Grant access to ${esc(f.name)} again">↻</button>` : ''}<button data-remove="${esc(f.uri)}" aria-label="Remove ${esc(f.name)}" title="Remove">✕</button></div>`;
  }).join('');

  const statuses = [];
  let loading = 0;
  for (const f of _s.folders) {
    const sc = _s.scans.get(f.uri);
    if (!sc || sc.status === 'loading') loading++;
    else if (sc.status === 'revoked' || !f.accessible) statuses.push(`<div class="ondevice-status warn">Access to “${esc(f.name)}” was lost (the folder was removed, or permission was revoked). Use ↻ to grant it again.</div>`);
    else if (sc.status === 'error') statuses.push(`<div class="ondevice-status err">Couldn’t read “${esc(f.name)}”: ${esc(sc.message || 'unknown error')}</div>`);
    else {
      if (sc.truncated) statuses.push(`<div class="ondevice-status warn">“${esc(f.name)}” is very large — showing the first ${sc.files.length} PDFs (${sc.reason === 'time' ? 'scan time limit' : sc.reason === 'depth' ? 'deeper folders skipped' : 'file limit'} reached). Choose a more specific folder to see the rest.</div>`);
      if (sc.unreadable) statuses.push(`<div class="ondevice-status warn">${sc.unreadable} sub-folder${sc.unreadable === 1 ? '' : 's'} in “${esc(f.name)}” couldn’t be read and were skipped.</div>`);
    }
  }
  if (loading) statuses.unshift(`<div class="ondevice-status">Scanning ${loading} folder${loading === 1 ? '' : 's'}…</div>`);

  const list = allEntries();
  const shown = list.slice(0, _s.shown);
  const okFolders = _s.folders.filter(f => _s.scans.get(f.uri)?.status === 'ok');
  let listHTML = '';
  if (shown.length) {
    listHTML = `<div class="files-list">${shown.map((e, i) => `
      <div class="recent-item ${_s.busy.has(e.uri) ? 'is-busy' : ''}" data-i="${i}" role="button" tabindex="0" aria-label="Open ${esc(e.name)}">
        <div class="recent-thumb">${ICON}</div>
        <div class="recent-info">
          <span class="recent-name" title="${esc(e.name)}">${esc(e.name)}</span>
          <span class="recent-meta">${e.size >= 0 ? formatFileSize(e.size) : 'size unknown'}${e.modified ? ' · ' + formatDate(e.modified) : ''}${e.path ? ' · ' + esc(e.path) : ''}${_s.folders.length > 1 ? ' · ' + esc(e.folderName) : ''}</span>
        </div>
      </div>`).join('')}</div>`;
    if (list.length > shown.length) listHTML += `<button class="btn btn-secondary" id="od-more">Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more (${list.length - shown.length} hidden)</button>`;
  } else if (!loading && okFolders.length) {
    listHTML = `<div class="ondevice-status">${_s.filter ? 'No PDFs match your search.' : `No PDFs found in ${okFolders.length === 1 ? '“' + esc(okFolders[0].name) + '”' : 'the chosen folders'}.`}</div>`;
  }

  el.innerHTML = `${note}
    <div class="ondevice-folders">${chips}</div>
    <div class="ondevice-toolbar">
      <button class="btn btn-secondary btn-sm" id="od-add">+ Add folder</button>
      <button class="btn btn-secondary btn-sm" id="od-refresh">Refresh</button>
      <select class="select-field" id="od-sort" aria-label="Sort" style="width:auto"><option value="recent" ${_s.sort === 'recent' ? 'selected' : ''}>Newest first</option><option value="name" ${_s.sort === 'name' ? 'selected' : ''}>Name</option></select>
    </div>
    <input type="text" class="input-field" id="ondevice-search" placeholder="Filter by name…" value="${esc(_s.filter)}" autocomplete="off" aria-label="Filter PDFs">
    ${statuses.join('')}${listHTML}
    ${list.length ? `<div class="ondevice-status">${list.length} PDF${list.length === 1 ? '' : 's'}. Opening one uses the file where it is — nothing is copied into FYLO.</div>` : ''}`;

  el.querySelector('#od-add').addEventListener('click', () => addFolder());
  el.querySelector('#od-refresh').addEventListener('click', () => scanAll({ force: true }));
  el.querySelector('#od-sort').addEventListener('change', e => { _s.sort = e.target.value; render(); });
  el.querySelector('#od-more')?.addEventListener('click', () => { _s.shown += PAGE_SIZE; render(); });
  const search = el.querySelector('#ondevice-search');
  search.addEventListener('input', e => { _s.filter = e.target.value; _s.shown = PAGE_SIZE; render(); });
  el.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeFolder(b.dataset.remove)));
  el.querySelectorAll('[data-regrant]').forEach(b => b.addEventListener('click', () => addFolder()));
  el.querySelectorAll('.recent-item[data-i]').forEach(item => {
    const go = () => { const e = shown[Number(item.dataset.i)]; if (e) openEntry(e, e.folderUri); };
    item.addEventListener('click', go);
    item.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  });
  if (keepFocus) { search.focus(); try { search.setSelectionRange(keepFocus.pos, keepFocus.pos); } catch { /* ignore */ } }
}

// ── Folder manager (Settings → PDF Folders on this Device) ───────────────────
function managerBody() {
  const folders = Device.folders();
  return folders.length
    ? `<p style="color:var(--text-secondary);font-size:13px;margin-bottom:10px">FYLO can list PDFs only inside these folders.</p>` + folders.map(f => `
        <div class="setting-item" style="margin-bottom:8px"><div class="setting-info"><span class="setting-label">${f.accessible ? '' : '⚠ '}${esc(f.name)}</span><span class="setting-desc">${f.accessible ? 'Access granted' : 'Access lost — remove it, then add it again'}</span></div>
        <button class="btn btn-secondary btn-sm" data-mgr-remove="${esc(f.uri)}">Remove</button></div>`).join('')
    : '<p style="color:var(--text-secondary);font-size:14px">No folders chosen. FYLO can’t see any PDFs on your phone until you choose one.</p>';
}
function refreshManager() {
  const body = document.getElementById('modal-body');
  if (!body || !document.getElementById('mgr-marker')) return;
  body.innerHTML = '<span id="mgr-marker" hidden></span>' + managerBody();
  wireManager();
}
function wireManager() {
  document.querySelectorAll('[data-mgr-remove]').forEach(b => b.addEventListener('click', () => removeFolder(b.dataset.mgrRemove)));
}
function managerDiagnostics() {
  const st = Device.safStatus();
  if (!st) return '<p style="margin-top:10px;font-size:12px;color:var(--text-tertiary)">Diagnostics unavailable (this build has no folder diagnostics).</p>';
  return `<details style="margin-top:12px;font-size:12px;color:var(--text-tertiary)"><summary>Folder access diagnostics</summary><pre style="white-space:pre-wrap;word-break:break-all;margin-top:6px">${esc(JSON.stringify(st, null, 2))}</pre></details>`;
}

function manageFolders() {
  // Nothing granted yet: the useful action is the picker itself, not a list that says "no folders".
  if (!Device.folders().length) { addFolder({ goToList: true }); return; }
  openModal('PDF Folders on this Device', '<span id="mgr-marker" hidden></span>' + managerBody() + managerDiagnostics(),
    '<button class="btn btn-secondary" id="mgr-add">Add folder</button><button class="btn btn-primary" id="mgr-done">Done</button>');
  wireManager();
  document.getElementById('mgr-add')?.addEventListener('click', () => addFolder());
  document.getElementById('mgr-done')?.addEventListener('click', closeModal);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function wire() {
  if (_s.wired) return;
  _s.wired = true;
  // Only offered when the Android bridge can actually browse folders.
  document.getElementById('tab-device')?.classList.toggle('hidden', !Device.canBrowseDevice);
  bus.on('ondevice:show', () => { _s.folders = Device.folders(); render(); scanAll(); });
  bus.on('ondevice:manageFolders', manageFolders);
  bus.on('ondevice:addFolder', () => addFolder());
  bus.on('app:nav', ({ page }) => { if (page !== 'files') _s.ctrl?.abort(); });
}
wire();
document.addEventListener('DOMContentLoaded', wire, { once: true });
