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

import { bus } from '../../core/eventBus.js';
import { State } from '../../core/state.js';
import { Device } from '../../core/device.js';
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
async function addFolder() {
  if (_picking) return;                     // repeated taps while the system picker is open
  _picking = true;
  try {
    const r = await Device.pickFolder();
    if (r.cancelled) return;
    if (!r.ok) { toast('Could not add the folder: ' + (r.error || 'unknown error'), 4500); return; }
    if (r.folder?.persisted === false) toast('Added for now, but Android would not keep this permission after a restart.', 5000);
    else toast(`Added “${r.folder.name}”`);
    _s.scans.delete(r.folder.uri);
    await scanAll({ force: true });
    refreshManager();
  } finally { _picking = false; }
}

function removeFolder(uri) {
  Device.removeFolder(uri);
  _s.scans.delete(uri);
  _s.folders = Device.folders();
  render(); refreshManager();
}

// ── Opening a PDF ────────────────────────────────────────────────────────────
async function openEntry(entry, folderUri) {
  if (_s.busy.has(entry.uri)) return;
  _s.busy.add(entry.uri); render();
  try {
    // Already imported? Open the library copy instead of copying the file again.
    const dup = State.files.find(f => f.name === entry.name && f.size === entry.size && (f.lastModified || 0) === (entry.modified || 0));
    if (dup) { bus.emit('reader:openRequest', { fileId: dup.id }); return; }
    if (entry.size > MAX_OPEN_BYTES) { toast(`This PDF is ${formatFileSize(entry.size)} — too large to open safely in FYLO.`, 5000); return; }
    toast('Opening…', 1500);
    let blob;
    try { blob = await Device.readDocument(entry.uri); }
    catch (e) {
      if (e.code === 'ACCESS_REVOKED') { toast('Access to that folder was removed. Add it again to keep browsing.', 5000); _s.scans.set(folderUri, { status: 'revoked', files: [], at: Date.now() }); }
      else if (e.code === 'NOT_FOUND') { toast('That file is no longer there — refreshing the list.'); scanAll({ force: true }); }
      else toast(e.message || 'Could not read the file', 5000);
      return;
    }
    const file = new File([blob], entry.name, { type: 'application/pdf', lastModified: entry.modified || Date.now() });
    const ids = await new Promise(res => bus.emit('files:incoming', { files: [file], onSaved: res }));
    // handleFiles adds the file to the library even when persisting fails; find it either way.
    const id = ids?.[0] || State.files.find(f => f.name === entry.name && f.size === file.size)?.id;
    if (!id) { toast('Could not add the PDF to FYLO'); return; }
    bus.emit('reader:openRequest', { fileId: id });
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

  const note = `<div class="ondevice-note">FYLO can only see the folders you choose here — Android doesn’t let apps browse everything on a phone without broad storage access, which FYLO deliberately doesn’t ask for. Pick the folders where your PDFs live (for example <em>Documents</em> or a folder inside <em>Download</em>). Android may refuse the main <em>Download</em> folder or <em>Android/data</em>; choose a sub-folder instead.</div>`;

  if (!_s.folders.length) {
    el.innerHTML = `${note}<div class="empty-state" style="padding:24px 0"><h3>No folders chosen yet</h3><p>Choose a folder to see the PDFs inside it.</p></div>
      <div class="ondevice-toolbar"><button class="btn btn-primary" id="od-add">Choose a folder</button></div>`;
    el.querySelector('#od-add').addEventListener('click', addFolder);
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
    ${list.length ? `<div class="ondevice-status">${list.length} PDF${list.length === 1 ? '' : 's'}. Opening one adds a copy to your FYLO library (it isn’t imported twice).</div>` : ''}`;

  el.querySelector('#od-add').addEventListener('click', addFolder);
  el.querySelector('#od-refresh').addEventListener('click', () => scanAll({ force: true }));
  el.querySelector('#od-sort').addEventListener('change', e => { _s.sort = e.target.value; render(); });
  el.querySelector('#od-more')?.addEventListener('click', () => { _s.shown += PAGE_SIZE; render(); });
  const search = el.querySelector('#ondevice-search');
  search.addEventListener('input', e => { _s.filter = e.target.value; _s.shown = PAGE_SIZE; render(); });
  el.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeFolder(b.dataset.remove)));
  el.querySelectorAll('[data-regrant]').forEach(b => b.addEventListener('click', addFolder));
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
function manageFolders() {
  openModal('PDF Folders on this Device', '<span id="mgr-marker" hidden></span>' + managerBody(),
    '<button class="btn btn-secondary" id="mgr-add">Add folder</button><button class="btn btn-primary" id="mgr-done">Done</button>');
  wireManager();
  document.getElementById('mgr-add')?.addEventListener('click', addFolder);
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
  bus.on('app:nav', ({ page }) => { if (page !== 'files') _s.ctrl?.abort(); });
}
wire();
document.addEventListener('DOMContentLoaded', wire, { once: true });
