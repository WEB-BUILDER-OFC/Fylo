/**
 * FYLO Feature — File Management
 *
 * Owns: file ingestion, persistence, list rendering, thumbnails,
 *       delete, favorites, storage meter, recent list, settings.
 *
 * Cross-module communication via EventBus only.
 */

import { bus, EVENTS } from '../../core/eventBus.js';
import { State, Actions } from '../../core/state.js';
import { Libs } from '../../core/libs.js';
import { Router } from '../../core/router.js';
import { PAGES, STORAGE_LIMIT_BYTES } from '../../core/constants.js';
import { FileStorage, BookmarkStorage, SettingsStorage, ThumbStorage } from '../../core/storage.js';
import {
  toast, openModal, closeModal,
  formatFileSize, formatDate, generateId, ripple, downloadBlob, $
} from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Files');

// ── Local helpers ────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtBytes(b) { return formatFileSize(b); }
function genId()     { return generateId(); }

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60)   return 'Just now';
  if (s < 3600)  return Math.floor(s/60)+'m ago';
  if (s < 86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

// ── File ingestion ────────────────────────────────────────────────────────────
async function handleFiles(files) {
  if (!files || !files.length) return;
  let addedCount = 0, updatedCount = 0;
  for (const file of Array.from(files)) {
    if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
      toast('Only PDF files supported'); continue;
    }
    const existingIdx = State.files.findIndex(
      f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
    );
    if (existingIdx > -1) {
      const existing = State.files[existingIdx];
      Actions.updateFile(existing.id, {
        date: new Date().toISOString(),
        blob: file,
        offline: true,
      });
      try { await FileStorage.save(State.getFile(existing.id)); } catch(e) {}
      try { await generateThumb(State.getFile(existing.id)); }  catch(e) {}
      updatedCount++;
    } else {
      const f = {
        id: genId(), name: file.name, size: file.size,
        type: file.type, lastModified: file.lastModified,
        date: new Date().toISOString(), blob: file, thumbnail: null, offline: true,
      };
      Actions.addFile(f);
      if (State.files.length > 100) Actions.setFiles(State.files.slice(0,100));
      try { await FileStorage.save(f); } catch(e) {}
      try { await generateThumb(f); }    catch(e) {}
      addedCount++;
    }
  }
  renderRecent(); renderFiles(); updateStorage();
  if (addedCount > 0 && updatedCount > 0) toast(`${addedCount} added, ${updatedCount} updated`);
  else if (addedCount > 0) toast(`${addedCount} PDF${addedCount > 1 ? 's' : ''} added`);
  else if (updatedCount > 0) toast(`${updatedCount} file${updatedCount > 1 ? 's' : ''} updated`);
}

// ── Thumbnail generation ─────────────────────────────────────────────────────
async function generateThumb(file) {
  if (!file || !file.blob || file.thumbnail) return;
  if (!await Libs.waitForPdfJs()) return;
  try {
    const ab  = await file.blob.slice(0, 1024 * 1024).arrayBuffer();
    const pdf  = await Libs.pdfjs.getDocument({ data: ab }).promise;
    const page = await pdf.getPage(1);
    const vp   = page.getViewport({ scale: 0.3 });
    const c    = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const thumb = c.toDataURL('image/jpeg', 0.6);
    Actions.updateFile(file.id, { thumbnail: thumb });
    const updated = State.getFile(file.id);
    if (updated) try { await FileStorage.save(updated); } catch(e) {}
    renderRecent(); renderFiles();
  } catch(e) { log.warn('Thumb generation failed:', e); }
}

// ── File actions ─────────────────────────────────────────────────────────────
async function deleteFile(id) {
  Actions.removeFile(id);
  try { await FileStorage.remove(id); } catch(e) {}
  renderRecent(); renderFiles(); updateStorage();
  toast('File deleted');
}

function toggleFav(id) {
  Actions.toggleFavorite(id);
  const isFav = State.isFavorite(id);
  toast(isFav ? 'Added to favorites' : 'Removed from favorites');
  renderRecent(); renderFiles();
  // Persist favorites list — SettingsStorage.save(key, value)
  try {
    const favs = State.files.filter(f => State.isFavorite(f.id)).map(f => f.id);
    SettingsStorage.save('favorites', favs);
  } catch(e) {}
}

async function saveSettings() {
  try { await SettingsStorage.save('app-settings', State.settings); } catch(e) {}
}

// ── Storage meter ─────────────────────────────────────────────────────────────
function updateStorage() {
  const used = State.files.reduce((s, f) => s + (f.size || 0), 0);
  const limit = State.settings.storageLimit || STORAGE_LIMIT_BYTES;
  const pct   = Math.min(100, Math.round((used / limit) * 100));
  const elUsed   = document.getElementById('storage-used');
  const elFill   = document.getElementById('storage-fill');
  const elPct    = document.getElementById('storage-percent');
  if (elUsed)  elUsed.textContent  = fmtBytes(used);
  if (elFill)  elFill.style.width  = pct + '%';
  if (elPct)   elPct.textContent   = pct + '%';
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderRecent() {
  const el = document.getElementById('recent-list');
  if (!el) return;
  if (!State.files.length) {
    el.innerHTML = '<div class="empty-state" style="padding:24px 0"><p style="color:var(--text-tertiary);font-size:13px">No recent files. Open a PDF to get started.</p></div>';
    return;
  }
  const files = State.files.slice(0, 5);
  el.innerHTML = files.map((f, i) => {
    const isFav = State.isFavorite(f.id);
    return `<div class="recent-item" data-file="${f.id}" style="animation:fadeInUp 300ms ${i*50}ms both">
      <div class="recent-thumb">${f.thumbnail ? `<img src="${f.thumbnail}" alt="">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="recent-meta">${fmtBytes(f.size)} &middot; ${timeAgo(f.date)}</span>
      </div>
      <div class="recent-actions">
        <button class="recent-fav ${isFav?'active':''}" data-fav="${f.id}" aria-label="Favorite">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-file]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('[data-fav]')) return;
      bus.emit('reader:openRequest', { fileId: item.dataset.file });
    });
  });
  el.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleFav(btn.dataset.fav); });
  });
}

function renderFiles(filteredFiles) {
  const tab       = document.querySelector('.file-tab.active')?.dataset.tab || 'recent';
  let files       = filteredFiles ?? (
    tab === 'favorites' ? State.files.filter(f => State.isFavorite(f.id)) :
    tab === 'offline'   ? State.files.filter(f => f.offline) :
                          State.files
  );

  const elEmpty = document.getElementById('files-empty');
  const elList  = document.getElementById('files-list');
  if (!elEmpty || !elList) return;

  elEmpty.classList.toggle('hidden', files.length > 0);
  elList.classList.toggle('hidden', files.length === 0);
  if (!files.length) { elList.innerHTML = ''; return; }

  elList.innerHTML = files.map(f => {
    const isFav = State.isFavorite(f.id);
    return `<div class="recent-item" data-file="${f.id}">
      <div class="recent-thumb">${f.thumbnail ? `<img src="${f.thumbnail}" alt="">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="recent-meta">${fmtBytes(f.size)} &middot; ${timeAgo(f.date)}</span>
      </div>
      <div class="recent-actions">
        <button class="recent-action" data-read="${f.id}" title="Read"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button class="recent-action" data-edit="${f.id}" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="recent-fav ${isFav?'active':''}" data-fav="${f.id}" title="Favorite"><svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg></button>
        <button class="recent-action" data-delete="${f.id}" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
      </div>
    </div>`;
  }).join('');

  elList.querySelectorAll('[data-file]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      bus.emit('reader:openRequest', { fileId: item.dataset.file });
    });
  });
  elList.querySelectorAll('[data-read]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); bus.emit('reader:openRequest', { fileId: btn.dataset.read }); });
  });
  elList.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); bus.emit('editor:openRequest', { fileId: btn.dataset.edit }); });
  });
  elList.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleFav(btn.dataset.fav); });
  });
  elList.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openModal('Delete File', `<p>Delete <strong>${esc(State.getFile(btn.dataset.delete)?.name ?? '')}</strong>? This cannot be undone.</p>`,
        `<button class="btn btn-secondary modal-cancel">Cancel</button><button class="btn btn-primary" id="confirm-delete-btn">Delete</button>`);
      document.getElementById('confirm-delete-btn').addEventListener('click', () => { closeModal(); deleteFile(btn.dataset.delete); });
      document.querySelector('.modal-cancel')?.addEventListener('click', closeModal);
    });
  });
}

// ── Wire file tabs ───────────────────────────────────────────────────────────
function wireFileTabs() {
  document.querySelectorAll('.file-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.file-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderFiles();
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
export const FilesModule = {
  handleFiles:   files => handleFiles(files),
  renderFiles:   ()    => renderFiles(),
  renderRecent:  ()    => renderRecent(),
  updateStorage: ()    => updateStorage(),
  deleteFile:    id    => deleteFile(id),
  toggleFav:     id    => toggleFav(id),
  saveSettings:  ()    => saveSettings(),
  wireFileTabs:  ()    => wireFileTabs(),
};

// ── Bus listeners ─────────────────────────────────────────────────────────────
bus.on('files:incoming',      ({ files })           => handleFiles(files));
bus.on('files:render',        ()                    => renderFiles());
bus.on('files:renderFiltered',({ files })           => renderFiles(files));
bus.on('files:updateStorage', ()                    => updateStorage());
