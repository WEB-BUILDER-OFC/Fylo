import { chromium, open, rec, sleep, saveResults, OUT } from './lib.mjs';
import { boot, importPdfs, idbCount, modalText, waitModal, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process'; import path from 'node:path';
const mode = process.argv[2] || 'web';
const G = `compress/${mode}`;
const b = await chromium.launch({ args: ['--no-sandbox'] });
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const blobOf = (p, match) => p.evaluate(m => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAll(); q.onsuccess = async () => { const rec = q.result.find(x => new RegExp(m).test(x.name)); if (!rec) return res(null); const ab = new Uint8Array(await rec.blob.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 32768) s += String.fromCharCode.apply(null, ab.subarray(i, i + 32768)); res({ name: rec.name, b64: btoa(s) }); }; }; }), match);
async function run(p, level) {
  await menuAction(p, 'compress'); await p.click('[data-compress-file]'); await p.selectOption('#compress-level', level); await p.click('#compress-run-btn');
  return waitModal(p, /smaller|couldn|could not|failed|error|saved|can.?t|already|negligible/, 240000);
}
const cases = ['text_uncompressed', 'photos', 'gray_photos', 'flate_images', 'scanned', 'already_small', 'large_ok'];
for (const n of cases) for (const level of (n === 'photos' ? ['low', 'medium', 'high'] : ['medium'])) {
  const s = await open(b, mode); const p = s.page; await boot(s);
  await importPdfs(p, [n + '.pdf'], 1);
  const txt = await run(p, level);
  const out = path.join(OUT, `${n}_${level}_compressed.pdf`);
  // Android: the result is written once to Download/FYLO (library keeps only a reference), so read it from there.
  const o = mode === 'android' ? await p.evaluate(() => { const i = window.__fake.saved.findIndex(x => /_compressed/.test(x.name)); return i < 0 ? null : { b64: window.__fake.base64(i) }; }) : await blobOf(p, '_compressed');
  const origRec = await blobOf(p, '^' + n + '\\.pdf$');
  const srcIntact = origRec && crypto.createHash('sha256').update(Buffer.from(origRec.b64, 'base64')).digest('hex') === sha(fx(n + '.pdf'));
  if (!o) { rec(G, `${n}/${level}`, false, 'no compressed file in library: ' + txt.slice(0, 120)); await s.close(); continue; }
  fs.writeFileSync(out, Buffer.from(o.b64, 'base64'));
  const c = JSON.parse(execFileSync('python3', ['-I', 'check_pdf.py', fx(n + '.pdf'), out], { encoding: 'utf8', maxBuffer: 1e8 }));
  const maxDiff = Math.max(...c.page_diff_mean_lum);
  const lim = level === 'high' ? 22 : 14;
  const ok = c.qpdf_ok && c.pages_orig === c.pages_new && c.size_new < c.size_orig && srcIntact && maxDiff <= lim && (c.text_len === 0 || c.text_equal) && /smaller/.test(txt) && !s.logs.errors.length;
  rec(G, `${n}/${level}`, ok, `${(c.size_orig/1048576).toFixed(2)}MB→${(c.size_new/1048576).toFixed(2)}MB qpdf=${c.qpdf_ok} pages=${c.pages_new}/${c.pages_orig} text=${c.text_len ? c.text_equal : 'n/a'} pagediff=${c.page_diff_mean_lum} source-intact=${srcIntact} errs=${s.logs.errors.length}`);
  if (n === 'photos' && level === 'medium') {
    // Second pass on the already-compressed output: must be honest that nothing more can be saved, and must NOT create a file.
    await p.click('#modal-close').catch(() => {}); await sleep(400);
    const before = await idbCount(p, 'files');
    await menuAction(p, 'compress');
    const items = await p.$$('[data-compress-file]');
    const names = await Promise.all(items.map(i => i.innerText()));
    const idx = names.findIndex(t => /_compressed/.test(t));
    await items[idx].click(); await p.selectOption('#compress-level', 'medium'); await p.click('#compress-run-btn');
    const t2 = await waitModal(p, /smaller|couldn|could not|failed|error|saved|can.?t|already|negligible/, 120000);
    const after = await idbCount(p, 'files');
    rec(G, 'recompressing an already-compressed file is reported honestly, nothing saved', /already well compressed|negligible|couldn/i.test(t2) && after === before, t2.replace(/\n+/g, ' | ').slice(0, 200));
  }
  await s.close();
}
await b.close(); saveResults(`compress-${mode}.json`); process.exit(0);
