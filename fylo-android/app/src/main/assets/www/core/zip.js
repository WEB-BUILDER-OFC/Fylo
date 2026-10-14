/**
 * FYLO Core — minimal ZIP writer (STORE method, no compression).
 *
 * Streams entries to a sink so a large backup never has to exist in memory as one buffer. PDFs are already
 * compressed, so STORE costs almost nothing in size and keeps this tiny and dependency-free.
 * Limits (classic ZIP, not ZIP64): < 4 GiB total, < 65 535 entries — callers check size up-front.
 */

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc, bytes) {
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const READ_CHUNK = 1024 * 1024;

export class ZipWriter {
  /** @param {(bytes:Uint8Array)=>Promise<void>} sink */
  constructor(sink) {
    this._sink = sink;
    this._entries = [];
    this._offset = 0;
    this._names = new Set();
  }

  async _emit(bytes) {
    await this._sink(bytes);
    this._offset += bytes.length;
  }

  /** Adds a file from a Blob/File or Uint8Array. Throws if the entry cannot be read completely. */
  async addFile(name, data, { mtime = new Date(), signal } = {}) {
    if (this._names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    const size = isBlob ? data.size : data.length;
    if (size >= 0xFFFFFFFF) throw new Error(`${name} is too large for a ZIP backup`);

    // Pass 1: CRC (needed in the local header, so that no data descriptor — which some readers dislike — is required).
    let crc = 0, read = 0;
    for (let off = 0; off < size; off += READ_CHUNK) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const part = isBlob ? new Uint8Array(await data.slice(off, off + READ_CHUNK).arrayBuffer())
                          : data.subarray(off, off + READ_CHUNK);
      crc = crc32Update(crc, part);
      read += part.length;
    }
    if (read !== size) throw new Error(`${name}: expected ${size} bytes but could read ${read}`);

    const nameBytes = enc.encode(name);
    const { time, date } = dosDateTime(mtime);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034B50, true);
    header.setUint16(4, 20, true);              // version needed
    header.setUint16(6, 0x0800, true);          // UTF-8 names
    header.setUint16(8, 0, true);               // STORE
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    const localOffset = this._offset;
    await this._emit(new Uint8Array(header.buffer));
    await this._emit(nameBytes);

    // Pass 2: data. From here on the header is already in the stream, so ANY failure leaves the archive
    // unusable → errors are flagged `fatal` and the caller must discard the whole archive.
    let written = 0;
    try {
      for (let off = 0; off < size; off += READ_CHUNK) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const part = isBlob ? new Uint8Array(await data.slice(off, off + READ_CHUNK).arrayBuffer())
                            : data.subarray(off, off + READ_CHUNK);
        await this._emit(part);
        written += part.length;
      }
      if (written !== size) throw new Error(`${name}: file changed while it was being written`);
    } catch (e) {
      e.fatal = true;
      throw e;
    }

    this._names.add(name);
    this._entries.push({ nameBytes, crc, size, time, date, offset: localOffset });
  }

  /** Writes the central directory. Returns total archive size. */
  async finish() {
    const dirStart = this._offset;
    for (const e of this._entries) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014B50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint32(42, e.offset, true);
      await this._emit(new Uint8Array(h.buffer));
      await this._emit(e.nameBytes);
    }
    const dirSize = this._offset - dirStart;
    if (this._entries.length > 0xFFFF || this._offset >= 0xFFFFFFFF) throw new Error('Backup is too large for a ZIP file');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(8, this._entries.length, true);
    end.setUint16(10, this._entries.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, dirStart, true);
    await this._emit(new Uint8Array(end.buffer));
    return this._offset;
  }
}
