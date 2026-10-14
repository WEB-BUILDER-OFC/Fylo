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
window.fyloNativeResult = (id, json) => {
  const resolve = _pending.get(id);
  if (!resolve) return;
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
        ? { ok: true, verified: true, name: e.name, path: e.path, uri: e.uri, bytes: e.bytes }
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

  get canBrowseDevice() {
    const b = bridge();
    return !!b && typeof b.pickPdfFolder === 'function';
  },

  /** Opens Android's folder picker. Resolves { ok, folder:{uri,name,accessible,persisted} } | { ok:false, cancelled } */
  pickFolder() {
    const b = bridge();
    if (!b) return Promise.resolve({ ok: false, error: 'Folder access needs the Android app' });
    if (_pending.has('folderPicked')) return Promise.resolve({ ok: false, error: 'A folder picker is already open' });
    return new Promise(resolve => {
      _pending.set('folderPicked', resolve);
      try { b.pickPdfFolder(); }
      catch (e) { _pending.delete('folderPicked'); resolve({ ok: false, error: e.message }); }
    });
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
  async readDocument(uri, { signal } = {}) {
    const res = await fetch(`/saf/doc?u=${encodeURIComponent(uri)}`, { signal, cache: 'no-store' });
    if (!res.ok) {
      const err = new Error(res.status === 403 ? 'Access to this folder was removed'
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
  },
};
