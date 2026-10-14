/**
 * FYLO Feature — Backup export
 *
 * Produces ONE ZIP file containing everything FYLO actually stores for the user:
 *   pdfs/<name>.pdf        every PDF in the library (the original bytes, not re-encoded)
 *   files.json             library metadata (id, name, size, dates, favourite flag, which ZIP entry holds the PDF)
 *   bookmarks.json         bookmarked pages per PDF
 *   settings.json          app settings and the favourites list
 *   manifest.json          what was exported, what failed, and what is NOT part of a backup
 *   README.txt             how to read the backup
 *
 * Honesty rules: a PDF that cannot be read is listed as a failure and the result is reported as PARTIAL; if the
 * archive itself cannot be written/verified nothing is kept and the caller gets { ok:false, error }.
 * The ZIP is streamed (never held in memory) through Device.openWriter, which on Android saves to
 * Download/FYLO/Backups and verifies the final size.
 */

import { FileStorage, storage } from '../../core/storage.js';
import { DB_STORES, APP_VERSION } from '../../core/constants.js';
import { State } from '../../core/state.js';
import { Device } from '../../core/device.js';
import { ZipWriter } from '../../core/zip.js';

const enc = new TextEncoder();
const json = obj => enc.encode(JSON.stringify(obj, null, 2));

const NOT_INCLUDED = [
  'Page thumbnails (they are regenerated automatically)',
  'Unsaved editor annotations and unfinished scan pages (FYLO keeps them in memory only until saved as a PDF)',
  'PDFs that are only on your phone and were never opened in FYLO (they are still where you left them)',
  'Android folder permissions (they cannot be exported; choose your folders again after a reinstall)',
];

function safeEntryName(name, used) {
  let n = String(name || 'document.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'document.pdf';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  let candidate = n, i = 2;
  while (used.has(candidate.toLowerCase())) candidate = n.replace(/(\.pdf)$/i, ` (${i++})$1`);
  used.add(candidate.toLowerCase());
  return 'pdfs/' + candidate;
}

const pad = n => String(n).padStart(2, '0');
function stamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

/**
 * @param {{signal?:AbortSignal, onProgress?:(p:{done:number,total:number,name:string})=>void}} opts
 * @returns {Promise<{ok:boolean, cancelled?:boolean, error?:string, partial?:boolean, saved?:object,
 *                    counts?:object, failures?:Array, notIncluded?:string[]}>}
 */
export async function exportBackup({ signal, onProgress = () => {} } = {}) {
  const startedAt = new Date();
  const failures = [];

  // 1 ── read everything first, so a read problem is known BEFORE anything is written ──────────────────────────
  let files;
  try { files = await FileStorage.loadAll(); }
  catch (e) { return { ok: false, error: `Your stored PDFs could not be read: ${e?.message || e}` }; }
  let bookmarks = [], settings = [];
  try { bookmarks = await storage.getAll(DB_STORES.BOOKMARKS); }
  catch (e) { failures.push({ item: 'bookmarks', reason: e?.message || String(e) }); }
  try { settings = await storage.getAll('settings_kv'); }
  catch (e) { failures.push({ item: 'settings', reason: e?.message || String(e) }); }

  const favIds = new Set((settings.find(s => s.key === 'favorites')?.value) || []);
  const totalBytes = files.reduce((n, f) => n + (f.blob?.size || 0), 0);

  // 2 ── can it fit? ─────────────────────────────────────────────────────────────────────────────────────────
  if (totalBytes > 3.9 * 1024 ** 3) {
    return { ok: false, error: 'Your library is larger than a single ZIP backup can hold (about 4 GB). Remove some PDFs and try again.' };
  }
  const free = Device.freeSpace();
  if (free >= 0 && free < totalBytes + 16 * 1024 * 1024) {
    const mb = n => (n / 1048576).toFixed(0);
    return { ok: false, error: `Not enough free space on the device: the backup needs about ${mb(totalBytes + 16 * 1048576)} MB but only ${mb(free)} MB is free.` };
  }

  // 3 ── open the destination ────────────────────────────────────────────────────────────────────────────────
  const filename = `fylo-backup-${stamp(startedAt)}.zip`;
  const w = await Device.openWriter({ filename, kind: 'download', subdir: 'Backups', mime: 'application/zip' });
  if (w.error) return { ok: false, error: `Could not start saving: ${w.error}` };

  // A failed sink write means the archive is unusable → mark fatal so we abort instead of "skipping a file".
  const sink = async bytes => { try { await w.write(bytes); } catch (e) { throw Object.assign(e, { fatal: true }); } };
  const zip = new ZipWriter(sink);
  const used = new Set();
  const meta = [];
  let exported = 0;

  const abort = async (result) => { await w.abort(); return result; };

  try {
    // 4 ── PDFs ───────────────────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) return abort({ ok: false, cancelled: true, error: 'Cancelled' });
      const f = files[i];
      onProgress({ done: i, total: files.length, name: f.name });
      const entry = { id: f.id, name: f.name, size: f.size, type: f.type, lastModified: f.lastModified, date: f.date,
                      favorite: favIds.has(f.id), zipPath: null };
      if (!f.blob || !f.blob.size) {
        failures.push({ item: f.name, reason: 'The stored file data is missing or empty' });
      } else {
        const path = safeEntryName(f.name, used);
        try {
          await zip.addFile(path, f.blob, { mtime: new Date(f.lastModified || Date.now()), signal });
          entry.zipPath = path; exported++;
        } catch (e) {
          if (e?.name === 'AbortError') return abort({ ok: false, cancelled: true, error: 'Cancelled' });
          if (e?.fatal) throw e;
          // Only reachable when the file could not be READ (nothing of it was written yet), so skipping is safe.
          failures.push({ item: f.name, reason: e?.message || String(e) });
        }
      }
      meta.push(entry);
    }
    onProgress({ done: files.length, total: files.length, name: 'Finishing…' });

    // 5 ── metadata ───────────────────────────────────────────────────────────────────────────────────────────
    const counts = { pdfsInLibrary: files.length, pdfsExported: exported, pdfsFailed: files.length - exported,
                     bookmarkedDocuments: bookmarks.length, settings: settings.length };
    await zip.addFile('files.json', json(meta));
    await zip.addFile('bookmarks.json', json(bookmarks));
    await zip.addFile('settings.json', json(settings));
    await zip.addFile('manifest.json', json({
      format: 'fylo-backup', formatVersion: 1, app: 'FYLO', appVersion: APP_VERSION,
      exportedAt: startedAt.toISOString(), complete: failures.length === 0,
      counts, failures, notIncluded: NOT_INCLUDED,
    }));
    await zip.addFile('README.txt', enc.encode(
`FYLO backup — ${startedAt.toISOString()}

pdfs/            your PDF files (open them with any PDF app)
files.json       library details (names, dates, favourites) and which file in pdfs/ belongs to each entry
bookmarks.json   bookmarked pages, keyed by the file ids used in files.json
settings.json    FYLO settings and favourites
manifest.json    what this backup contains, what failed, and what a backup does not include
`));
    await zip.finish();

    // 6 ── finish + verify (native re-reads the size; the browser cannot, so it says "unverified") ───────────
    const saved = await w.finish();
    if (!saved.ok) return { ok: false, error: `The backup could not be saved: ${saved.error}` };
    return { ok: true, partial: failures.length > 0, saved, counts, failures, notIncluded: NOT_INCLUDED, totalBytes };
  } catch (e) {
    return abort({ ok: false, error: `The backup was stopped and nothing was kept: ${e?.message || e}` });
  }
}
