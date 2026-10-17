/**
 * FYLO Feature — Unified PDF Library
 *
 * One list of PDFs, whatever their source:
 *   • PDFs FYLO made (Scan, Compress, Merge, …) — saved ONCE to Downloads/FYLO (or kept inside FYLO if the user chose so)
 *   • PDFs found on the phone (All-files access / MediaStore) — used IN PLACE
 *   • PDFs from folders the user granted (Storage Access Framework) and from the "Open PDF" picker — used IN PLACE
 *   • PDFs imported into FYLO's own storage (browser/PWA, shared-in from other apps)
 *
 * Storage rules this module enforces:
 *   - Browsing a PDF never copies it. A record that points at a file (`ref`) is stored as metadata only (no blob).
 *   - The same physical PDF appears once: records are keyed by its canonical path (SAF URIs are mapped to a path
 *     where Android's document id allows it), so FYLO output, a discovered file and a picked file collapse into one.
 *   - Opening a device PDF "adopts" it: a tiny metadata record (name/size/ref/thumbnail) so it shows up under Recent.
 *   - Device discovery results are in memory only (rebuilt from Android on launch) — no index is persisted.
 */

import { bus } from '../../core/eventBus.js';
import { State, Actions } from '../../core/state.js';
import { Device } from '../../core/device.js';
import { FileStorage } from '../../core/storage.js';
import { DeviceBlob } from '../../core/deviceblob.js';
import { toast, openModal, closeModal } from '../../core/ui.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('Library');
const MAX_VERIFY = 2000;

// ── Identity ────────────────────────────────────────────────────────────────
/** /storage/emulated/0/x ← content://…/document/primary%3Ax ; null when the URI is not a plain storage document. */
export function safToPath(uri) {
  try {
    const m = /\/document\/([^/?#]+)/.exec(uri);
    if (!m) return null;
    const id = decodeURIComponent(m[1]);
    const i = id.indexOf(':');
    if (i < 0) return null;
    const vol = id.slice(0, i), rel = id.slice(i + 1);
    if (!rel) return null;
    if (vol === 'primary') return '/storage/emulated/0/' + rel;
    if (/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(vol)) return `/storage/${vol}/${rel}`;
  } catch { /* not mappable */ }
  return null;
}

const normPath = p => String(p).replace(/^\/sdcard\//, '/storage/emulated/0/').replace(/^\/storage\/self\/primary\//, '/storage/emulated/0/').replace(/\/+/g, '/');

/** Stable key of the physical file behind a ref. */
export function keyOf(ref) {
  if (!ref) return null;
  if (ref.path) return 'p:' + normPath(ref.path);
  if (ref.kind === 'saf') { const p = safToPath(ref.uri); return p ? 'p:' + p : 's:' + ref.uri; }
  return ref.uri ? 'u:' + ref.uri : null;
}

/** Short stable id from a key (same file → same id across launches and sources). */
export function stableId(key) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x5bd1e995) >>> 0; h2 ^= h2 >>> 13;
  }
  return 'd_' + h1.toString(36) + h2.toString(36);
}

// ── State ───────────────────────────────────────────────────────────────────
const L = {
  device: new Map(),          // key → { key,id,name,size,modified,ref, _file }
  access: null,               // last Device.storageAccess()
  refreshing: false, again: false, deep: false,
  last: null,                 // { at, ok, count, truncated, deep, ms, error, fromFolders }
  denied: false,              // user came back from Settings without granting
  scanCtl: null,
};
let _verifyTimer = null;

export const isRef = f => !!f?.ref;

// ── Records ─────────────────────────────────────────────────────────────────
function entryToFile(e) {
  if (e._file) return e._file;
  return (e._file = {
    id: e.id, name: e.name, size: e.size, type: 'application/pdf', lastModified: e.modified || 0,
    date: new Date(e.modified || 0).toISOString(), ref: e.ref, source: 'device', thumbnail: null, offline: false, _virtual: true,
  });
}

/** Turns a discovered entry into a (metadata-only) library record, synchronously. Returns the record. */
function adoptEntry(e) {
  const existing = State.files.find(f => f.id === e.id);
  if (existing) return existing;
  const rec = {
    id: e.id, name: e.name, size: e.size, type: 'application/pdf', lastModified: e.modified || 0,
    date: new Date().toISOString(), ref: e.ref, source: e.source || 'device', thumbnail: null, offline: false,
    blob: new DeviceBlob(e.ref, e.size),
  };
  Actions.addFile(rec);
  FileStorage.save(rec).catch(err => log.warn('Could not save library record', err));
  return rec;
}

/** Registers a PDF that was just written to shared storage by FYLO (no copy is kept in FYLO). */
export function addSavedRecord({ name, size, lastModified, ref, source = 'fylo' }) {
  const key = keyOf(ref);
  const id = stableId(key);
  const prev = State.files.find(f => f.id === id);
  const rec = {
    id, name, size, type: 'application/pdf', lastModified: lastModified || Date.now(), date: new Date().toISOString(),
    ref, source, thumbnail: prev?.thumbnail ?? null, offline: false, blob: new DeviceBlob(ref, size),
  };
  if (prev) Actions.updateFile(id, rec); else Actions.addFile(rec);
  L.device.delete(key);       // the discovered entry (if any) is the same file
  return rec;
}

/** Hook for State.getFile(): resolves a discovered-but-not-yet-opened id to a record. */
function resolve(id) {
  for (const e of L.device.values()) if (e.id === id) return adoptEntry(e);
  return null;
}

// ── Merged list ─────────────────────────────────────────────────────────────
export function allFiles() {
  const keys = new Set();
  for (const f of State.files) if (f.ref) keys.add(keyOf(f.ref));
  const out = State.files.slice();
  for (const [k, e] of L.device) if (!keys.has(k)) out.push(entryToFile(e));
  return out;
}
export const count = () => State.files.length + Math.max(0, L.device.size);
export function pickerList(n = 20) {
  const l = allFiles();
  l.sort((a, b) => sortTime(b) - sortTime(a));
  return l.slice(0, n);
}
export const sortTime = f => Math.max(Date.parse(f.date) || 0, f.lastModified || 0);

export function locationLabel(f) {
  if (!f.ref) return 'Inside FYLO';
  const p = f.ref.path || '';
  if (f.source === 'fylo' || /\/Download\/FYLO\//.test(p) || /^Download\/FYLO\//.test(p)) return 'Downloads/FYLO';
  return 'On phone';
}

// ── Access state ────────────────────────────────────────────────────────────
export function accessState() {
  L.access = Device.storageAccess();
  return L.access;
}
export const status = () => ({ ...L.last, refreshing: L.refreshing, denied: L.denied, deviceCount: L.device.size });

// ── Refresh ─────────────────────────────────────────────────────────────────
function put(map, e) {
  const k = keyOf(e.ref);
  if (!k) return;
  const cur = map.get(k);
  if (cur) {                                    // same physical file seen through another source → one entry
    if (e.ref.kind !== 'saf' && cur.ref.kind === 'saf') { e.ref.alt = cur.ref; cur.ref = e.ref; }
    else if (e.ref.kind === 'saf' && cur.ref.kind !== 'saf') cur.ref.alt = e.ref;
    return;
  }
  map.set(k, { key: k, id: stableId(k), name: e.name, size: e.size, modified: e.modified, ref: e.ref });
}

/**
 * Re-reads what Android can see. Quick = MediaStore index (cheap). Deep = also walks storage (battery heavy).
 * Single-flight: a request made while one is running schedules exactly one more pass.
 */
export async function refresh({ deep = false, quiet = true } = {}) {
  if (!Device.isAndroid) return;
  if (L.refreshing) { L.again = true; L.deep = L.deep || deep; return; }
  L.refreshing = true; notify();
  const t0 = Date.now();
  const next = new Map();
  let err = null, truncated = false, folderCount = 0;
  try {
    accessState();
    if (L.access?.granted) {
      L.scanCtl = new AbortController();
      const r = await Device.discoverPdfs({ deep, signal: L.scanCtl.signal });
      if (r.ok) {
        truncated = !!r.truncated;
        for (const f of r.files || []) put(next, { name: f.name, size: f.size, modified: f.modified, ref: { kind: 'path', path: f.path } });
      } else if (r.error === 'NO_ACCESS') { accessState(); }
      else err = r.message || r.error;
    }
    // Folders the user granted (works without any broad permission, and as the fallback when access is denied).
    for (const f of Device.folders()) {
      if (!f.accessible) continue;
      const r = await Device.listPdfs(f.uri);
      if (!r.ok) continue;
      folderCount++;
      truncated = truncated || !!r.truncated;
      for (const e of r.files || []) put(next, { name: e.name, size: e.size, modified: e.modified, ref: { kind: 'saf', uri: e.uri } });
    }
    L.device = next;
    L.last = { at: Date.now(), ok: !err, count: next.size, truncated, deep, ms: Date.now() - t0, error: err, folders: folderCount };
  } catch (e) {
    log.warn('refresh failed', e);
    L.last = { at: Date.now(), ok: false, count: L.device.size, error: e.message, deep, ms: Date.now() - t0 };
  } finally {
    L.refreshing = false;
  }
  notify();
  verify();
  if (L.again) { const d = L.deep; L.again = false; L.deep = false; refresh({ deep: d }); }
}

/** Marks library records whose file was deleted / moved / lost access. Never touches the files themselves. */
export async function verify() {
  if (!Device.isAndroid) return;
  const recs = State.files.filter(f => f.ref).slice(0, MAX_VERIFY);
  if (!recs.length) return;
  const idOf = f => f.ref.kind === 'path' ? f.ref.path : (f.ref.uri || f.ref.path);
  const res = await Device.statPaths(recs.map(idOf));
  if (!res.size) return;
  let changed = false;
  for (const f of recs) {
    const st = res.get(idOf(f));
    if (!st) continue;
    const missing = !!st.allowed && !st.exists, noAccess = !st.allowed;
    if (!!f.missing !== missing || !!f.noAccess !== noAccess) {
      Actions.updateFile(f.id, { missing, noAccess }); changed = true;
    }
  }
  if (changed) notify();
}

function notify() { bus.emit('library:changed', {}); }

// ── Opening ─────────────────────────────────────────────────────────────────
/** Checks a record is readable right now; returns { ok } or { ok:false, code, message }. Does NOT read the file. */
export async function checkOpenable(file) {
  if (!file?.ref) return { ok: true };
  const idf = file.ref.kind === 'path' ? file.ref.path : (file.ref.uri || file.ref.path);
  const st = (await Device.statPaths([idf])).get(idf);
  if (!st) return { ok: true };                 // cannot tell (old build / bridge missing) → let the read decide
  if (!st.allowed) return { ok: false, code: 'ACCESS_REVOKED', message: 'FYLO no longer has access to this file.' };
  if (!st.exists) return { ok: false, code: 'NOT_FOUND', message: 'This file was moved or deleted.' };
  return { ok: true };
}

/** Removes a missing/inaccessible reference from the library (the file on the phone is never touched). */
export async function forget(id) {
  const f = State.getFile(id);
  if (!f) return;
  if (f.ref?.kind === 'saf' && /^content:/.test(f.ref.uri || '') && !Device.folders().some(d => f.ref.uri.startsWith(d.uri))) Device.releaseDocument(f.ref.uri);
  Actions.removeFile(id);
  try { await FileStorage.remove(id); } catch { /* record already gone */ }
  for (const [k, e] of L.device) if (e.id === id) L.device.delete(k);
  notify();
}

// ── "Open PDF" picker (kept) — in place when Android lets us keep access ───
/** Returns ids of the library records for the picked documents; falls back to copying only when access can't be kept. */
export async function pickDocuments() {
  const r = await Device.pickDocuments();
  if (!r.ok) { toast('Could not open the file picker: ' + (r.error || 'unknown error'), 5000); return { ok: false }; }
  const ids = [], copies = [];
  for (const d of r.files || []) {
    if (!/\.pdf$/i.test(d.name || '')) { toast(`“${d.name}” is not a PDF`); continue; }
    if (d.persisted === false) { copies.push(d); continue; }
    const ref = { kind: 'saf', uri: d.uri };
    const key = keyOf(ref);
    const id = stableId(key);
    const prior = L.device.get(key);
    if (prior) { ids.push(adoptEntry(prior).id); continue; }
    const rec = adoptEntry({ id, name: d.name, size: d.size >= 0 ? d.size : 0, modified: d.modified, ref, source: 'device' });
    ids.push(rec.id);
  }
  // Android would not keep access after a restart: copy so the file is still openable later (and say so).
  for (const d of copies) {
    try {
      const blob = await Device.readRef({ kind: 'saf', uri: d.uri });
      const file = new File([blob], d.name, { type: 'application/pdf', lastModified: d.modified || Date.now() });
      const got = await new Promise(res => bus.emit('files:incoming', { files: [file], onSaved: res }));
      if (got?.[0]) ids.push(got[0]);
      toast('Android would not keep access to this file, so a copy was stored in FYLO.', 4500);
    } catch (e) { toast(e.message || 'Could not read the file', 4500); }
  }
  notify();
  return { ok: true, ids };
}

// ── Access UI ───────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function requestAccess() {
  const before = accessState();
  if (before?.granted) { refresh(); return before; }
  const st = await Device.requestStorageAccess();
  L.access = st;
  L.denied = !st?.granted;
  if (st?.granted) { toast('Access granted — finding your PDFs…', 2500); refresh(); }
  else toast('Access not granted. You can still use Open PDF or choose folders.', 4500);
  notify();
  return st;
}

/** Text for the access card / settings row. */
export function accessSummary() {
  const st = L.access || accessState();
  if (!st) return { state: 'none', text: '' };
  if (st.granted) return { state: 'granted', text: 'Access allowed' };
  if (st.mode === 'folders_only') return { state: 'folders_only', text: 'Choose folders' };
  return { state: L.denied ? 'denied' : 'off', text: L.denied ? 'Not allowed' : 'Not allowed yet' };
}

function describeAccessRow() {
  const el = document.getElementById('setting-access-desc');
  if (!el || !Device.isAndroid) return;
  const s = accessSummary();
  const n = L.device.size;
  el.textContent = s.state === 'granted' ? `Allowed${n ? ` · ${n} PDF${n === 1 ? '' : 's'} found` : ''}`
    : s.state === 'folders_only' ? 'Choose folders to list PDFs'
    : 'Let FYLO list your phone’s PDFs';
}

function manageAccess() {
  const st = accessState();
  if (!st) { toast('This needs the FYLO Android app'); return; }
  const granted = st.granted;
  const why = st.mode === 'all_files'
    ? `<p>To show every PDF on your phone, Android requires a special setting called <strong>All files access</strong>. It is not a normal pop-up: FYLO opens Android’s settings page and you switch <em>Allow access to manage all files</em> on, then come back.</p>
       <p style="margin-top:8px"><strong>What FYLO does with it:</strong> lists PDF files and opens the ones you tap — in place, without copying them. It does not upload anything and does not read other file types.</p>
       <p style="margin-top:8px"><strong>Trade-off:</strong> this is broad access to your storage, so it is optional. If you decline, everything still works: use <em>Open PDF</em> or choose folders.</p>`
    : st.mode === 'read_storage'
    ? `<p>Android will ask for permission to read your storage so FYLO can list your PDFs. They are opened in place and never copied.</p>`
    : `<p>On Android 10, apps can’t be given access to all files. Choose the folders that hold your PDFs, or use <em>Open PDF</em>.</p>`;
  const stat = granted ? `<p style="margin-top:10px;color:var(--text-secondary)">Status: <strong>allowed</strong>. ${L.device.size} PDF${L.device.size === 1 ? '' : 's'} found${L.last?.truncated ? ' (list limit reached)' : ''}.</p>`
    : `<p style="margin-top:10px;color:var(--text-secondary)">Status: <strong>${L.denied ? 'not allowed' : 'not allowed yet'}</strong>.</p>`;
  const foot = st.mode === 'folders_only'
    ? '<button class="btn btn-secondary" id="acc-folder">Choose a folder</button><button class="btn btn-primary" id="acc-done">Done</button>'
    : granted
      ? '<button class="btn btn-secondary" id="acc-deep">Deep scan</button><button class="btn btn-secondary" id="acc-settings">Open Android settings</button><button class="btn btn-primary" id="acc-done">Done</button>'
      : '<button class="btn btn-secondary" id="acc-folder">Choose folders instead</button><button class="btn btn-primary" id="acc-allow">' + (st.mode === 'all_files' ? 'Open settings' : 'Allow') + '</button>';
  openModal('PDFs on this phone', why + stat + (granted ? '<p style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">Quick refresh uses Android’s file index. “Deep scan” also walks your folders to find PDFs Android hasn’t indexed yet; it takes longer and uses more battery.</p>' : ''), foot);
  document.getElementById('acc-done')?.addEventListener('click', closeModal);
  document.getElementById('acc-allow')?.addEventListener('click', async () => { closeModal(); await requestAccess(); });
  document.getElementById('acc-settings')?.addEventListener('click', () => { closeModal(); Device.requestStorageAccess(); });
  document.getElementById('acc-deep')?.addEventListener('click', () => { closeModal(); toast('Deep scan started…', 2000); refresh({ deep: true }); });
  document.getElementById('acc-folder')?.addEventListener('click', () => { closeModal(); bus.emit('ondevice:addFolder', {}); });
}

// ── Wiring ──────────────────────────────────────────────────────────────────
let _lastResume = 0;
function wire() {
  State.setResolver(resolve);
  bus.on('library:manageAccess', manageAccess);
  bus.on('library:describeAccess', describeAccessRow);
  bus.on('library:changed', describeAccessRow);
  bus.on('library:refresh', ({ deep } = {}) => refresh({ deep: !!deep }));
  window.addEventListener('fylo:storageAccess', e => {
    const st = e.detail; L.access = st && st.mode ? st : Device.storageAccess();
    L.denied = !L.access?.granted && L.denied;
    if (L.access?.granted) refresh(); else notify();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - _lastResume < 30000) return;
    _lastResume = Date.now();
    const was = L.access?.granted;
    accessState();
    if (L.access?.granted || was) refresh();   // also catches permission being revoked in Settings
  });
  bus.on('app:ready', () => { if (Device.isAndroid) { accessState(); refresh(); } });
}
wire();

/** Adopts any {name,size,modified,ref} into the library (metadata only) and returns the record. */
export function adopt({ name, size, modified, ref }) {
  const key = keyOf(ref);
  return adoptEntry({ id: stableId(key), name, size: size >= 0 ? size : 0, modified, ref, source: 'device' });
}

export const Library = { adopt, allFiles, count, pickerList, refresh, verify, status, accessState, accessSummary, requestAccess, forget, checkOpenable, pickDocuments, addSavedRecord, keyOf, stableId, safToPath, locationLabel, sortTime, isRef };
