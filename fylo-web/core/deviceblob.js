/**
 * FYLO Core — DeviceBlob
 * A Blob-shaped handle to a PDF that stays where it is (shared storage, a picked document, a granted folder).
 * Nothing is read until a consumer asks, nothing is cached, nothing is persisted: every arrayBuffer() streams the
 * file from its original location and the bytes are garbage-collected when the caller is done.
 *
 * It exposes only what FYLO's tools use (size, type, arrayBuffer, slice().arrayBuffer, toBlob). Code that needs a
 * real Blob (share, download, zip, object URLs) calls blobOf(file).
 */
import { Device } from './device.js';

export class DeviceBlob {
  constructor(ref, size = 0) { this.ref = ref; this.size = size; this.type = 'application/pdf'; this.isDeviceBlob = true; }

  async toBlob(opts) {
    const refs = [this.ref, ...(this.ref.alt ? [this.ref.alt] : [])];
    let lastErr;
    for (const r of refs) {
      try { return await Device.readRef(r, opts); }
      catch (e) { lastErr = e; if (e.code === 'INCOMPLETE') throw e; }
    }
    throw lastErr;
  }
  async arrayBuffer() { return (await this.toBlob()).arrayBuffer(); }
  slice(a = 0, b = this.size) {
    return { size: Math.max(0, Math.min(b, this.size) - a), type: this.type, arrayBuffer: async () => (await this.arrayBuffer()).slice(a, b) };
  }
}

/** A real Blob for any library record (transient for device files). */
export async function blobOf(file) {
  const b = file?.blob;
  if (!b) throw Object.assign(new Error('File data unavailable'), { code: 'NOT_FOUND' });
  return b.isDeviceBlob ? b.toBlob() : b;
}

/** Attaches a DeviceBlob to a record that carries a reference (used after loading from IndexedDB). */
export function hydrate(rec) {
  if (rec && rec.ref && !rec.blob) rec.blob = new DeviceBlob(rec.ref, rec.size || 0);
  return rec;
}
