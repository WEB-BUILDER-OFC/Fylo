/**
 * FYLO Core — minimal ZIP writer (STORE method, no compression).
 * Used for the Settings → Export Data backup. PDFs are already compressed, so storing them is the right trade:
 * no extra library, tiny code, opens in every unzip tool / file manager.
 */

let _crcTable = null;
function _table() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

export function crc32(bytes) {
  const t = _table();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function _dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {{name:string, data:Uint8Array}[]} entries  names use "/" separators, must be unique
 * @returns {Blob} application/zip
 */
export function buildZip(entries, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = _dosDateTime(when);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc  = crc32(e.data);
    const size = e.data.length;
    if (size >= 0xFFFFFFFF || offset >= 0xFFFFFFFF) throw new Error('Backup too large for a ZIP file');

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);              // version needed
    lh.setUint16(6, 0x0800, true);          // flags: UTF-8 names
    lh.setUint16(8, 0, true);               // method: store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + size;
  }

  let centralSize = 0;
  for (const p of central) centralSize += p.byteLength !== undefined ? p.byteLength : p.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
