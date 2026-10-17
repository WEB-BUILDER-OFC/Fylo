/**
 * FYLO Core — Device adapter
 *
 * The ONE place that talks to the Android bridge (window.AndroidBridge, injected by MainActivity) and that
 * falls back to ordinary web behaviour in a browser/PWA. It deliberately imports no UI code.
 *
 *   Device.openWriter()  streaming, VERIFIED save (Android: Download/FYLO or Pictures/FYLO via MediaStore)
 *   Device.saveBlob()    convenience wrapper around openWriter
 *   Device.pickFolder() / folders() / listPdfs() / readDocument()   Storage Access Framework PDF browsing
 *   Device.share() / view() / freeSpace() / clearNativeCache() / appInfo()
 *
 * Every Android call that can fail returns { ok:false, error } — nothing here pretends to have succeeded.
 */

import { createLogger } from './logger.js';

const log = createLogger('Device');

const bridge = () => (typeof window.AndroidBridge !== 'undefined' ? window.AndroidBridge : null);

// 3 × 256 KiB: a multiple of 3 bytes so every base64 chunk is independently decodable (padding only on the last).
const CHUNK = 3 * 256 * 1024;

function parse(text, fallback = 'Unexpected response from the Android app') {
  try { return JSON.parse(text); } catch { return { ok: false, error: fallback }; }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function mimeFor(name = '') {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf'))  return 'application/pdf';
  if (n.endsWith('.png'))  return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.zip'))  return 'application/zip';
  if (n.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

// ── Async results pushed from native (folder picker, folder scans) ───────────
const _pending = new Map();
let _pickStartedAt = 0;
window.fyloNativeResult = (id, json) => {
  const resolve = _pending.get(id);
  if (!resolve) {
    // Nobody is waiting (the page was reloaded/recreated while Android's picker was open, or the wait already timed
    // out). Never drop it: tell the UI, which re-reads the granted folders from native.
    if (id === 'folderPicked') window.dispatchEvent(new CustomEvent('fylo:folderPicked', { detail: parse(json) }));
    if (id === 'docsPicked') window.dispatchEvent(new CustomEvent('fylo:docsPicked', { detail: parse(json) }));
    if (id === 'storageAccess') window.dispatchEvent(new CustomEvent('fylo:storageAccess', { detail: parse(json) }));
    return;
  }
  _pending.delete(id);
  resolve(parse(json));
};

// ── Writers ──────────────────────────────────────────────────────────────────

/** Android: streams chunks to MediaStore and asks native to verify the final size. */
function androidWriter(b, { kind, subdir, filename, mime, onProgress }) {
  const begun = parse(b.saveBegin(kind, subdir, filename, mime));
  if (!begun.ok) return Promise.resolve({ error: begun.error || 'Could not start saving' });
  const id = begun.id;
  const buf = new Uint8Array(CHUNK);
  let fill = 0, sent = 0, dead = null;

  const flush = (len) => {
    const r = parse(b.saveChunk(id, toBase64(buf.subarray(0, len))));
    if (!r.ok) { dead = r.error || 'Write failed'; throw new Error(dead); }   // native already discarded the file
    sent += len;
    onProgress?.(sent);
  };

  return Promise.resolve({
    async write(data) {
      if (dead) throw new Error(dead);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      let off = 0;
      while (off < bytes.length) {
        const n = Math.min(CHUNK - fill, bytes.length - off);
        buf.set(bytes.subarray(off, off + n), fill);
        fill += n; off += n;
        if (fill === CHUNK) { flush(fill); fill = 0; await new Promise(r => setTimeout(r, 0)); }
      }
    },
    async finish() {
      if (dead) return { ok: false, error: dead };
      try {
        if (fill > 0) { flush(fill); fill = 0; }
      } catch (e) { return { ok: false, error: e.message }; }
      const e = parse(b.saveEnd(id));
      return e.ok
        ? { ok: true, verified: true, name: e.name, path: e.path, abs: e.abs, uri: e.uri, bytes: e.bytes }
        : { ok: false, error: e.error || 'Could not verify the saved file' };
    },
    async abort() { try { b.saveAbort(id); } catch { /* already gone */ } },
  });
}

/** Browser/PWA: collects parts and triggers a normal download. The browser gives no confirmation → verified:false. */
function webWriter({ filename, mime }) {
  const parts = [];
  let size = 0;
  return Promise.resolve({
    async write(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      parts.push(bytes.slice());      // copy: callers may reuse their buffers
      size += bytes.length;
    },
    async finish() {
      try {
        const url = URL.createObjectURL(new Blob(parts, { type: mime }));
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { ok: true, verified: false, name: filename, path: 'your browser’s download folder', uri: '', bytes: size };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    async abort() { parts.length = 0; },
  });
}

// ── Public API ───────────────────────────────────────────────────────────────
export const Device = {
  get isAndroid() { return bridge() !== null; },

  /** { versionName, versionCode, lastUpdateTime, packageName, sdk } or null outside Android. */
  appInfo() {
    const b = bridge();
    if (!b || typeof b.getAppInfo !== 'function') return null;
    const r = parse(b.getAppInfo());
    return r.error ? null : r;
  },

  /** Free bytes on the app volume, -1 if unknown. */
  freeSpace() {
    const b = bridge();
    try { return b && typeof b.getFreeSpaceBytes === 'function' ? Number(b.getFreeSpaceBytes()) : -1; }
    catch { return -1; }
  },

  /**
   * Opens a streaming writer. opts: { filename, kind:'download'|'image', subdir, mime, onProgress(bytesSent) }
   * Resolves to { write(Uint8Array), finish() → result, abort() } or { error } if saving could not even start.
   */
  openWriter(opts) {
    const o = { kind: 'download', subdir: '', ...opts };
    o.mime = o.mime || mimeFor(o.filename);
    const b = bridge();
    return b ? androidWriter(b, o) : webWriter(o);
  },

  /** Saves a Blob. Resolves to { ok, name, path, uri, bytes, verified } or { ok:false, error, cancelled? }. */
  async saveBlob(blob, filename, opts = {}) {
    const w = await this.openWriter({ ...opts, filename, mime: opts.mime || blob.type || mimeFor(filename) });
    if (w.error) return { ok: false, error: w.error };
    try {
      for (let off = 0; off < blob.size; off += CHUNK) {
        if (opts.signal?.aborted) { await w.abort(); return { ok: false, cancelled: true, error: 'Cancelled' }; }
        await w.write(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
      }
      return await w.finish();
    } catch (e) {
      await w.abort();
      return { ok: false, error: e.message };
    }
  },

  async share(uris, mime) {
    const b = bridge();
    if (!b || typeof b.shareUris !== 'function') return false;
    try { return !!b.shareUris(JSON.stringify(uris), mime || ''); } catch { return false; }
  },

  async view(uri, mime) {
    const b = bridge();
    if (!b || typeof b.viewUri !== 'function') return false;
    try { return !!b.viewUri(uri, mime || ''); } catch { return false; }
  },

  /** Removes disposable native data only (temp share files + WebView HTTP cache). { ok, freedBytes } */
  clearNativeCache() {
    const b = bridge();
    if (!b || typeof b.clearNativeCache !== 'function') return { ok: false, unsupported: true, freedBytes: 0 };
    return parse(b.clearNativeCache());
  },

  // ── Storage Access Framework ───────────────────────────────────────────────

  // True on every Android build. (Previously this also required `typeof bridge.pickPdfFolder === 'function'`; if a WebView
  // reports bridge methods differently, the whole On Device UI silently vanished. Now the UI always shows on Android and
  // pickFolder() reports a clear error if the native method is really missing.)
  get canBrowseDevice() { return bridge() !== null; },

  /**
   * Opens Android's folder picker. Resolves { ok, folder:{uri,name,accessible,persisted} } | { ok:false, cancelled } | { ok:false, error }.
   * The result normally arrives through window.fyloNativeResult('folderPicked'). Because that callback can be lost
   * (Activity recreated while the system picker was open, page reloaded), the wait also ends when the app regains
   * focus: native is asked which folders are granted and a NEW one means success, none means cancelled.
   */
  pickFolder() {
    const b = bridge();
    if (!b) return Promise.resolve({ ok: false, error: 'Folder access needs the Android app' });
    if (!('pickPdfFolder' in b) && typeof b.pickPdfFolder === 'undefined') {
      return Promise.resolve({ ok: false, error: 'This version of the app cannot open the folder picker. Install the latest FYLO build.' });
    }
    // A previous wait that never got an answer must not block new taps forever.
    if (_pending.has('folderPicked') && Date.now() - _pickStartedAt < 15000) return Promise.resolve({ ok: false, error: 'A folder picker is already open' });
    _pending.delete('folderPicked');
    const before = new Set(Device.folders().map(f => f.uri));
    _pickStartedAt = Date.now();
    return new Promise(resolve => {
      let timer = null, done = false, sawAway = false;
      const finish = r => {
        if (done) return; done = true;
        clearTimeout(timer);
        window.removeEventListener('focus', onBack); window.removeEventListener('blur', onAway);
        document.removeEventListener('visibilitychange', onBack);
        _pending.delete('folderPicked'); resolve(r);
      };
      // Only arm the fallback after the app really went to the background (the system picker took over); a stray
      // focus event while launching must not be mistaken for "the user came back without choosing".
      const onAway = () => { sawAway = true; };
      const onBack = () => {
        if (document.visibilityState === 'hidden') { sawAway = true; return; }
        if (!sawAway) return;
        clearTimeout(timer);
        // Give the normal callback a moment; if it never comes, fall back to asking native what is granted.
        timer = setTimeout(() => {
          const now = Device.folders();
          const added = now.find(f => !before.has(f.uri));
          finish(added ? { ok: true, folder: { ...added, persisted: true }, recovered: true } : { ok: false, cancelled: true, recovered: true });
        }, 2500);
      };
      window.addEventListener('focus', onBack); window.addEventListener('blur', onAway);
      document.addEventListener('visibilitychange', onBack);
      _pending.set('folderPicked', finish);
      try { b.pickPdfFolder(); }
      catch (e) { finish({ ok: false, error: e.message }); }
    });
  },

  /** Native-side diagnostics for the folder picker (JSON string parsed), or null on old builds. */
  safStatus() {
    const b = bridge();
    try { return b && typeof b.getSafStatus === 'function' ? JSON.parse(b.getSafStatus()) : null; } catch { return null; }
  },

  /** [{ uri, name, accessible }] — folders the user granted. accessible:false means the grant was revoked. */
  folders() {
    const b = bridge();
    if (!b || typeof b.getPdfFolders !== 'function') return [];
    try { const a = JSON.parse(b.getPdfFolders()); return Array.isArray(a) ? a : []; } catch { return []; }
  },

  removeFolder(uri) { try { bridge()?.removePdfFolder(uri); } catch (e) { log.warn('removeFolder failed', e); } },

  /** Scans a granted folder. Resolves { ok, files:[{uri,name,size,modified,path}], truncated, … } | { ok:false, error } */
  listPdfs(uri, { signal } = {}) {
    const b = bridge();
    if (!b) return Promise.resolve({ ok: false, error: 'ERROR', message: 'Folder access needs the Android app' });
    const id = `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise(resolve => {
      _pending.set(id, resolve);
      signal?.addEventListener('abort', () => { try { b.cancelScan(id); } catch { /* done already */ } }, { once: true });
      const timer = setTimeout(() => {
        if (_pending.delete(id)) resolve({ ok: false, error: 'TIMEOUT', message: 'Scanning took too long' });
      }, 60000);
      _pending.set(id, r => { clearTimeout(timer); resolve(r); });
      try { b.listPdfs(id, uri); }
      catch (e) { clearTimeout(timer); _pending.delete(id); resolve({ ok: false, error: 'ERROR', message: e.message }); }
    });
  },

  /** Reads one PDF from a granted folder as a Blob (streamed by native, no base64). Throws Error with .code. */
  readDocument(uri, opts) { return fetchPdf(`/saf/doc?u=${encodeURIComponent(uri)}`, opts); },

  // ── Whole-device PDF access (All-files access / READ_EXTERNAL_STORAGE) ──────────────────────────────

  /** { granted, mode: 'all_files'|'read_storage'|'folders_only', sdk } or null when not on Android / old build. */
  storageAccess() {
    const b = bridge();
    if (!b || typeof b.getStorageAccess !== 'function') return null;
    try { return JSON.parse(b.getStorageAccess()); } catch { return null; }
  },

  /**
   * Sends the user to the right place to grant access. On Android 11+ that is the system "All files access" screen
   * (not a popup): the promise resolves with the new state when the user returns to FYLO. Resolves the CURRENT state
   * if nothing changed. Never rejects.
   */
  requestStorageAccess() {
    const b = bridge();
    if (!b || typeof b.requestStorageAccess !== 'function') return Promise.resolve(this.storageAccess());
    return new Promise(resolve => {
      let done = false;
      const finish = st => {
        if (done) return; done = true;
        _pending.delete('storageAccess'); window.removeEventListener('focus', onFocus); resolve(st || Device.storageAccess());
      };
      // The native callback can be lost if the Activity was recreated while Settings was open; re-read on focus.
      let away = false;
      const onFocus = () => { if (!away) return; setTimeout(() => finish(Device.storageAccess()), 600); };
      window.addEventListener('blur', () => { away = true; }, { once: true });
      window.addEventListener('focus', onFocus);
      _pending.set('storageAccess', finish);
      try { b.requestStorageAccess(); } catch (e) { finish(Device.storageAccess()); }
    });
  },

  /** Lists PDFs on shared storage. deep=true also walks folders (slower, more battery). Resolves { ok, files, truncated, … }. */
  discoverPdfs({ deep = false, signal } = {}) {
    const b = bridge();
    if (!b || typeof b.discoverPdfs !== 'function') return Promise.resolve({ ok: false, error: 'UNSUPPORTED', message: 'Needs the Android app' });
    const id = `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (_pending.delete(id)) resolve({ ok: false, error: 'TIMEOUT', message: 'Scanning took too long' }); }, 150000);
      _pending.set(id, r => { clearTimeout(timer); resolve(r); });
      signal?.addEventListener('abort', () => { try { b.cancelScan(id); } catch { /* done */ } }, { once: true });
      try { b.discoverPdfs(id, !!deep); } catch (e) { clearTimeout(timer); _pending.delete(id); resolve({ ok: false, error: 'ERROR', message: e.message }); }
    });
  },

  /** Checks which known paths still exist. Resolves Map<path, {exists, allowed, size, modified}>; empty Map if unsupported. */
  statPaths(paths) {
    const b = bridge();
    if (!b || typeof b.statPdfs !== 'function' || !paths.length) return Promise.resolve(new Map());
    const id = `stat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (_pending.delete(id)) resolve(new Map()); }, 30000);
      _pending.set(id, r => { clearTimeout(timer); resolve(new Map((r?.items || []).map(i => [i.path, i]))); });
      try { b.statPdfs(id, JSON.stringify(paths)); } catch { clearTimeout(timer); _pending.delete(id); resolve(new Map()); }
    });
  },

  /** True when native can pick documents while keeping access to them (so they can be opened in place later). */
  get canPickDocuments() { const b = bridge(); return !!b && typeof b.pickPdfDocuments === 'function'; },

  /** System document picker. Resolves { ok, files:[{uri,name,size,modified,persisted}] } (files:[] = cancelled). */
  pickDocuments() {
    const b = bridge();
    if (!this.canPickDocuments) return Promise.resolve({ ok: false, error: 'UNSUPPORTED' });
    return new Promise(resolve => {
      _pending.set('docsPicked', resolve);
      try { b.pickPdfDocuments(); } catch (e) { _pending.delete('docsPicked'); resolve({ ok: false, error: e.message }); }
    });
  },

  releaseDocument(uri) { try { bridge()?.releaseDocument?.(uri); } catch { /* best effort */ } },

  /** Reads a referenced PDF in place → transient Blob. ref = {kind:'path',path} | {kind:'media',uri} | {kind:'saf',uri}. */
  readRef(ref, opts) {
    if (!ref) throw Object.assign(new Error('No file reference'), { code: 'NOT_FOUND' });
    if (ref.kind === 'saf') return fetchPdf(`/saf/doc?u=${encodeURIComponent(ref.uri)}`, opts);
    if (ref.kind === 'media') return fetchPdf(`/dev/doc?u=${encodeURIComponent(ref.uri)}`, opts);
    return fetchPdf(`/dev/doc?p=${encodeURIComponent(ref.path)}`, opts);
  },
};

async function fetchPdf(url, { signal } = {}) {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(res.status === 403 ? 'Access to this file was removed'
      : res.status === 404 ? 'The file is no longer there' : `Could not read the file (${res.status})`);
    err.code = res.status === 403 ? 'ACCESS_REVOKED' : res.status === 404 ? 'NOT_FOUND' : 'READ_ERROR';
    throw err;
  }
  const blob = await res.blob();
  const expected = Number(res.headers.get('Content-Length'));
  if (expected && blob.size !== expected) {
    const err = new Error('The file was only partly read — try again');
    err.code = 'INCOMPLETE';
    throw err;
  }
  return new Blob([blob], { type: 'application/pdf' });
}
