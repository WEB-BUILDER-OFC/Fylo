// Android-WRAPPER SIMULATION: real FYLO web code from assets/www on the faked WebViewAssetLoader origin, talking to a
// fake AndroidBridge. Proves the web layer's protocol handling — NOT the Java, MediaStore or SAF on a real device.
import { chromium, open, rec, sleep, saveResults, OUT, WWW } from './lib.mjs';
import { boot, importPdfs, idbCount, modalText, waitModal, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const waitTitle = (p, re, t = 180000) => p.waitForFunction(r => { const o = document.getElementById('modal-overlay'); return o && !o.classList.contains('hidden') && new RegExp(r, 'i').test(document.getElementById('modal-title').innerText); }, re.source, { timeout: t }).then(() => modalText(p));
const saved = p => p.evaluate(() => window.__fake.saved.map(x => ({ path: x.path, bytes: x.bytes, mime: x.mime, kind: x.kind })));
const dump = (p, i) => p.evaluate(i => window.__fake.base64(i), i).then(s => Buffer.from(s, 'base64'));
const pngDims = buf => buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null;
const isJpeg = buf => buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
const G = n => `android-sim/${n}`;
async function fresh(cfg, pdfs = ['photos.pdf']) { const s = await open(b, 'android', cfg); await boot(s); if (pdfs.length) await importPdfs(s.page, pdfs, pdfs.length); return s; }
async function pdf2img(p, { fmt = 'png', pages = '', fileIdx = 0 } = {}) {
  await menuAction(p, 'pdf-to-img'); await sleep(300);
  await (await p.$$('[data-pdf2img-file]'))[fileIdx].click(); await p.selectOption('#pdf2img-format', fmt); await p.fill('#pdf2img-pages', pages); await p.click('#pdf2img-run-btn');
}

// ───────── A. Compress → Save to device (Download/FYLO) ─────────
{ const s = await fresh({}); const p = s.page;
  await menuAction(p, 'compress'); await p.click('[data-compress-file]'); await p.click('#compress-run-btn');
  await waitTitle(p, /compressed/); await sleep(1200);
  rec(G('compress'), 'result offers no second "Save to device" (it is already saved once to Download/FYLO)', (await p.locator('text=Save to device').count()) === 0 && /Downloads\/FYLO/.test(await modalText(p)));
  const sv = await saved(p); const f = sv[0];
  rec(G('compress'), 'compress result is written exactly once, as a verified PDF under Download/FYLO', sv.length === 1 && f.path.startsWith('Download/FYLO/') && f.mime === 'application/pdf', JSON.stringify(sv));
  const out = path.join(OUT, 'android_compressed.pdf'); fs.writeFileSync(out, await dump(p, 0));
  const c = JSON.parse(execFileSync('python3', ['-I', 'check_pdf.py', fx('photos.pdf'), out], { encoding: 'utf8' }));
  rec(G('compress'), 'the bytes handed to the bridge are a valid, smaller PDF', c.qpdf_ok && c.size_new < c.size_orig && c.pages_new === c.pages_orig, JSON.stringify(c));
  rec(G('compress'), 'the library keeps a reference to that single file (no second copy)', await p.evaluate(() => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAll(); q.onsuccess = () => res(q.result.some(x => x.ref && !x.blob && /Download\/FYLO\//.test(x.ref.path))); }; })) && true, (await p.evaluate(() => window.__toasts)).join(' | '));
  rec(G('compress'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }

// ───────── B. Compress save failures are reported, nothing claimed ─────────
{ const s = await fresh({ failChunkContains: '_compressed' }); const p = s.page;
  await menuAction(p, 'compress'); await p.click('[data-compress-file]'); await p.click('#compress-run-btn');
  await waitTitle(p, /compressed/); await p.click('text=Save to device'); await sleep(2500);
  const t = (await p.evaluate(() => window.__toasts)).join(' | ');
  rec(G('compress'), 'storage-full during Save to device is reported, not claimed as saved', /could not save|not enough/i.test(t) && !/^Saved to/m.test(t), t.replace(/\n/g, ' | '));
  rec(G('compress'), 'failed save left nothing behind', (await saved(p)).length === 0);
  await s.close(); }

// ───────── C. PDF → Image ─────────
{ const s = await fresh({}); const p = s.page;
  await pdf2img(p, { fmt: 'png' }); const t = await waitTitle(p, /^(Saved|No images|Conversion)/);
  const sv = await saved(p); const bufs = await Promise.all(sv.map((_, i) => dump(p, i)));
  rec(G('pdf→png'), 'every page rendered and saved (6 pages → 6 files)', sv.length === 6 && /Saved 6 images/.test(await p.locator('#modal-title').innerText()), t.replace(/\n+/g, ' | ').slice(0, 160));
  rec(G('pdf→png'), 'files are in Pictures/FYLO/<name>/ and are real PNGs with sane dimensions', sv.every((f, i) => f.path.startsWith('Pictures/FYLO/photos/') && f.kind === 'image' && f.mime === 'image/png' && pngDims(bufs[i])?.[0] > 600), sv.map(f => f.path).join(', '));
  fs.writeFileSync(path.join(OUT, 'p1.png'), bufs[0]);
  const stat = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,json;from PIL import Image,ImageStat;i=Image.open(sys.argv[1]).convert("RGB");s=ImageStat.Stat(i);print(json.dumps({"size":i.size,"mean":s.mean,"std":s.stddev}))', path.join(OUT, 'p1.png')], { encoding: 'utf8' }));
  rec(G('pdf→png'), 'image content is not blank', stat.std.some(x => x > 5), JSON.stringify(stat));
  const actions = await p.$$eval('#modal-footer button', bs => bs.map(x => x.innerText));
  rec(G('pdf→png'), 'Share / View offered on Android', actions.includes('Share') && actions.includes('View'), actions.join());
  await p.click('text=Share'); await sleep(300);
  const shares = await p.evaluate(() => window.__fake.shares);
  rec(G('pdf→png'), 'Share passes all 6 saved URIs to the bridge', shares.length === 1 && shares[0].uris.length === 6, JSON.stringify(shares).slice(0, 120));
  rec(G('pdf→png'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }
{ const s = await fresh({}); const p = s.page;
  await pdf2img(p, { fmt: 'jpg', pages: '2-3, 6' }); const t = await waitTitle(p, /^(Saved|No images|Conversion)/);
  const sv = await saved(p); const bufs = await Promise.all(sv.map((_, i) => dump(p, i)));
  rec(G('pdf→jpg'), 'page range "2-3, 6" → exactly pages 2,3,6 as real JPEGs', sv.length === 3 && sv.every((f, i) => isJpeg(bufs[i]) && f.mime === 'image/jpeg') && sv.map(f => f.path.match(/page(\d+)/)[1]).join() === '2,3,6', sv.map(f => f.path).join(', '));
  await s.close(); }
{ const s = await fresh({ failChunkContains: 'page2.' }); const p = s.page;
  await pdf2img(p, { fmt: 'png', pages: '1-3' }); const t = await waitTitle(p, /^(Saved|No images|Conversion)/);
  rec(G('pdf→png'), 'partial failure: "Saved 2 of 3 pages", failing page named, others kept', /Saved 2 of 3/.test(await p.locator('#modal-title').innerText()) && /Page 2/.test(await modalText(p)) && (await saved(p)).length === 2, t.replace(/\n+/g, ' | ').slice(0, 200));
  await s.close(); }
{ const s = await fresh({ failBeginContains: 'page' }); const p = s.page;
  await pdf2img(p, { fmt: 'png', pages: '1-2' }); await waitTitle(p, /^(Saved|No images|Conversion)/);
  rec(G('pdf→png'), 'total failure: "No images were saved" (never "success")', /No images were saved/i.test(await p.locator('#modal-title').innerText()) && (await saved(p)).length === 0);
  await s.close(); }
{ const s = await fresh({}, ['large_ok.pdf']); const p = s.page;
  await pdf2img(p, { fmt: 'png' });
  await p.waitForFunction(() => window.__fake.saved.length >= 1, null, { timeout: 120000 });
  await p.click('#progress-cancel'); const t = await waitTitle(p, /^(Saved|No images|Conversion)/);
  const n = (await saved(p)).length;
  rec(G('pdf→png'), 'cancel stops the run, keeps already-saved pages, says so', /Conversion cancelled/i.test(await p.locator('#modal-title').innerText()) && n >= 1 && n < 8 && (await p.evaluate(() => Object.keys(window.__fake.sessions).length)) === 0, `saved ${n}/8; open sessions ${await p.evaluate(() => Object.keys(window.__fake.sessions).length)}`);
  await s.close(); }
{ const s = await fresh({}); const p = s.page;
  await pdf2img(p, { fmt: 'png', pages: '40' }); await sleep(3500);
  const t = (await p.evaluate(() => window.__toasts)).join(' | ') + ' ' + (await modalText(p).catch(() => ''));
  rec(G('pdf→png'), 'out-of-range page selection is rejected with a message', /page|range/i.test(t) && (await saved(p)).length === 0, t.replace(/\n/g, ' | ').slice(0, 140));
  await s.close(); }

// ───────── D. Export Data ─────────
async function exportRun(p) { await p.click('.nav-item[data-page="settings"]'); await sleep(300); await p.click('#setting-export-data'); }
const zipCheck = (f) => JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile,json,sys,hashlib
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); names=z.namelist()
man=json.loads(z.read('manifest.json')); 
pd={n:hashlib.sha256(z.read(n)).hexdigest() for n in names if n.startswith('pdfs/')}
print(json.dumps({'bad':bad,'names':names,'manifest':man,'sha':pd}))`, f], { encoding: 'utf8', maxBuffer: 1e8 }));
{ const s = await fresh({}, ['text_uncompressed.pdf', 'photos.pdf', 'scanned.pdf']); const p = s.page;
  await p.evaluate(() => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const tx = r.result.transaction(['bookmarks', 'settings_kv'], 'readwrite'); tx.objectStore('bookmarks').put({ id: 'bm-test', pages: [1, 4] }); tx.objectStore('settings_kv').put({ key: 'probe', value: 'keep-me' }); tx.oncomplete = () => res(); }; }));
  await exportRun(p); const t = await waitTitle(p, /^(Backup saved|Export failed)/); await sleep(500);
  const body = await modalText(p); const sv = await saved(p);
  rec(G('export'), 'one ZIP saved to Download/FYLO/Backups with verified size', sv.length === 1 && /^Download\/FYLO\/Backups\/fylo-backup-.*\.zip$/.test(sv[0].path) && sv[0].mime === 'application/zip', JSON.stringify(sv));
  const zf = path.join(OUT, 'android_backup.zip'); fs.writeFileSync(zf, await dump(p, 0));
  const z = zipCheck(zf);
  const want = ['text_uncompressed', 'photos', 'scanned'].map(n => crypto.createHash('sha256').update(fs.readFileSync(fx(n + '.pdf'))).digest('hex')).sort();
  rec(G('export'), 'ZIP passes CRC test; contains manifest/files/bookmarks/settings/README', z.bad === null && ['manifest.json', 'files.json', 'bookmarks.json', 'settings.json', 'README.txt'].every(n => z.names.includes(n)), z.names.join(','));
  rec(G('export'), 'every PDF in the ZIP is byte-identical to the original', JSON.stringify(Object.values(z.sha).sort()) === JSON.stringify(want));
  rec(G('export'), 'manifest counts match (3 pdfs, 0 failures) and list what is NOT included', z.manifest.counts?.pdfsExported === 3 && (z.manifest.failures || []).length === 0 && (z.manifest.notIncluded || []).length > 0, JSON.stringify(z.manifest).slice(0, 220));
  const bm = JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read("bookmarks.json").decode())', zf], { encoding: 'utf8' }));
  rec(G('export'), 'bookmarks and settings are in the backup', JSON.stringify(bm).includes('bm-test') && execFileSync('python3', ['-I', '-c', 'import zipfile,sys;print("keep-me" in zipfile.ZipFile(sys.argv[1]).read("settings.json").decode())', zf], { encoding: 'utf8' }).trim() === 'True');
  rec(G('export'), 'result dialog shows verified path + size + Share', /Download\/FYLO\/Backups/.test(body) && (await p.$$eval('#modal-footer button', bs => bs.map(x => x.innerText))).includes('Share'), body.replace(/\n+/g, ' | ').slice(0, 220));
  rec(G('export'), 'exporting does not alter library data', (await idbCount(p, 'files')) === 3 && (await idbCount(p, 'bookmarks')) >= 1);
  // repeated tap while running → one export only
  await p.click('text=Done').catch(() => {}); await sleep(300);
  await p.evaluate(() => { const e = document.getElementById('setting-export-data'); e.click(); e.click(); e.click(); });
  await waitTitle(p, /^(Backup saved|Export failed)/); await sleep(800);
  rec(G('export'), 'triple tap starts only one export', (await saved(p)).length === 2, 'archives=' + (await saved(p)).length);
  rec(G('export'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }
{ const s = await fresh({ endMismatch: true }, ['photos.pdf']); const p = s.page;
  await exportRun(p); const t = await waitTitle(p, /^(Backup saved|Export failed)/); const body = await modalText(p);
  rec(G('export'), 'native size-verification failure ⇒ reported as FAILED, no success claim, nothing kept', /size check failed|could not/i.test(body) && !/Backup saved/i.test(t) && (await saved(p)).length === 0, (t + ' | ' + body).replace(/\n+/g, ' | ').slice(0, 200));
  await s.close(); }
{ const s = await fresh({ free: 1000 }, ['photos.pdf']); const p = s.page;
  await exportRun(p); const t = await waitTitle(p, /^(Backup saved|Export failed)/); const body = await modalText(p);
  rec(G('export'), 'insufficient free space is detected up front, before writing', /space|storage/i.test(t + body) && (await p.evaluate(() => Object.keys(window.__fake.sessions).length + window.__fake.n)) === 0, (t + ' | ' + body).replace(/\n+/g, ' | ').slice(0, 200));
  await s.close(); }
{ const s = await fresh({}, ['text_uncompressed.pdf', 'photos.pdf']); const p = s.page; await sleep(3500);   // let background thumbnail writes finish first
  await p.evaluate(() => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const tx = r.result.transaction('files', 'readwrite'); const st = tx.objectStore('files'); const q = st.getAll(); q.onsuccess = () => { const rr = q.result.find(x => /photos/.test(x.name)); rr.blob = null; st.put(rr); }; tx.oncomplete = () => res(); }; }));
  await exportRun(p); const t = await waitTitle(p, /^(Backup saved|Export failed)/); const body = await modalText(p);
  const sv = await saved(p);
  rec(G('export'), 'one unreadable PDF ⇒ PARTIAL backup, offender named, archive still valid', /partial|not included|could not be/i.test(t + body) && /photos/.test(body) && sv.length === 1, (t + ' | ' + body).replace(/\n+/g, ' | ').slice(0, 260));
  if (sv.length) { fs.writeFileSync(path.join(OUT, 'partial.zip'), await dump(p, 0)); const z = zipCheck(path.join(OUT, 'partial.zip')); rec(G('export'), 'partial archive: CRC ok, manifest lists the failure', z.bad === null && (z.manifest.failures || []).length === 1, JSON.stringify(z.manifest.failures)); }
  await s.close(); }
{ const s = await fresh({}, ['large_ok.pdf', 'photos.pdf']); const p = s.page;
  await exportRun(p); await p.waitForFunction(() => window.__fake.n >= 1, null, { timeout: 60000 });
  await p.click('#progress-cancel'); await sleep(1500);
  rec(G('export'), 'cancel mid-export discards the partial archive (no file left)', (await saved(p)).length === 0 && (await p.evaluate(() => Object.keys(window.__fake.sessions).length)) === 0 && (await p.evaluate(() => window.__fake.aborted)) >= 1, 'aborted=' + await p.evaluate(() => window.__fake.aborted));
  await s.close(); }

// ───────── E. Clear Cache ─────────
{ const s = await fresh({}, ['text_uncompressed.pdf', 'photos.pdf']); const p = s.page;
  await p.evaluate(async () => { await caches.open('fylo-old-1'); await caches.open('fylo-v0.9'); await caches.open('someone-elses'); await new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const tx = r.result.transaction(['bookmarks', 'settings_kv'], 'readwrite'); tx.objectStore('bookmarks').put({ id: 'bm-x', pages: [2] }); tx.objectStore('settings_kv').put({ key: 'probe', value: 'keep-me' }); tx.oncomplete = res; }; }); localStorage.setItem('fylo_probe', '1'); });
  const before = { files: await idbCount(p, 'files'), bm: await idbCount(p, 'bookmarks'), kv: await idbCount(p, 'settings_kv') };
  await p.click('.nav-item[data-page="settings"]'); await sleep(300); await p.click('#setting-clear-cache'); await sleep(1500);
  if (await p.evaluate(() => !document.getElementById('modal-overlay').classList.contains('hidden'))) { await p.click('#modal-footer .btn-primary').catch(() => {}); await sleep(1200); }
  const after = { files: await idbCount(p, 'files'), bm: await idbCount(p, 'bookmarks'), kv: await idbCount(p, 'settings_kv') };
  const keys = await p.evaluate(() => caches.keys());
  rec(G('clear-cache'), 'PDFs, bookmarks and settings are untouched', JSON.stringify(before) === JSON.stringify(after) && before.files === 2, JSON.stringify({ before, after }));
  rec(G('clear-cache'), 'only fylo-* caches deleted; foreign cache kept', !keys.some(k => k.startsWith('fylo-')) && keys.includes('someone-elses'), keys.join());
  rec(G('clear-cache'), 'native cache clear invoked via bridge', (await p.evaluate(() => window.__fake.cacheCleared)) >= 1);
  rec(G('clear-cache'), 'localStorage kept', await p.evaluate(() => localStorage.getItem('fylo_probe') === '1'));
  { const tt = (await p.evaluate(() => window.__toasts)).join(' | '); rec(G('clear-cache'), 'user told what happened', /Cleared .*not touched/.test(tt), tt); }
  await s.close(); }

// ───────── F. Back button ─────────
{ const s = await fresh({}, []); const p = s.page;
  await p.click('#menu-btn'); await sleep(300);
  const r1 = await p.evaluate(() => window.fyloHandleBack()); await sleep(300);
  rec(G('back'), 'Android Back closes the open drawer first (consumed)', r1 === true && (await p.getAttribute('#menu-drawer', 'aria-hidden')) === 'true');
  await s.close(); }

await b.close(); saveResults('android.json'); process.exit(0);
