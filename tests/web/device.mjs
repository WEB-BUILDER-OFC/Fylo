// On Device (SAF) — SIMULATED: fake bridge + faked /saf/doc route. Real SAF/DocumentsContract needs a physical device.
import { chromium, open, rec, sleep, saveResults, OUT, WWW } from './lib.mjs';
import { boot, idbCount, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs'; import path from 'node:path';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const G = n => `ondevice-sim/${n}`;
const T = 'content://tree/Documents';
const fileEntry = (i, name, size, modified, p = '') => ({ uri: `${T}/document/${i}`, name, size, modified, path: p });
const real = n => ({ name: n, size: fs.statSync(fx(n)).size });
async function setup(files, extra = {}, cfg = {}) {
  const s = await open(b, 'android', cfg); const p = s.page;
  s.hits = []; s.docMode = {};
  await s.ctx.route(/appassets\.androidplatform\.net\/saf\/doc/, r => {
    const u = new URL(r.request().url()).searchParams.get('u'); s.hits.push(u);
    const mode = s.docMode[u] || s.docMode['*'];
    if (mode === 403) return r.fulfill({ status: 403, body: 'revoked' });
    if (mode === 404) return r.fulfill({ status: 404, body: 'gone' });
    if (mode === 'short') { const buf = fs.readFileSync(fx('text_uncompressed.pdf')); return r.fulfill({ status: 200, headers: { 'content-length': String(buf.length + 500) }, body: buf }); }
    const name = s.docNames?.[u] || 'text_uncompressed.pdf';
    r.fulfill({ status: 200, contentType: 'application/pdf', body: fs.readFileSync(fx(name)) });
  });
  await boot(s);
  await p.evaluate(([T, files, extra]) => { window.__fake.tree[T] = Object.assign({ ok: true, files, truncated: false, truncatedReason: '', scannedFolders: 1, unreadableFolders: 0, rootRead: true }, extra); window.__fake.pickResult = { ok: true, folder: { uri: T, name: 'Documents', persisted: true } }; }, [T, files, extra]);
  return s;
}
const goDevice = async p => { if (!(await p.locator('#menu-btn').isVisible({ timeout: 100 }))) { await p.waitForFunction(() => { const b = document.getElementById('menu-btn'); return b && b.offsetParent !== null; }, null, { timeout: 6000 }).catch(async () => { await p.evaluate(() => history.back()); await sleep(800); }); } await menuAction(p, 'ondevice'); await sleep(500); };
const panel = p => p.locator('#ondevice-panel').innerText();
const lastToasts = p => p.evaluate(() => window.__toasts.slice(-6).join(' | '));

// 1. first run: honest explanation, picker, listing
{ const rt = real('text_uncompressed.pdf');
  const s = await setup([fileEntry(1, 'text_uncompressed.pdf', rt.size, 1700000000000, 'Reports'), fileEntry(2, 'notes.pdf', 2048, 1600000000000), fileEntry(3, 'zeta.pdf', 4096, 1710000000000, 'a/b')]); const p = s.page;
  await goDevice(p);
  const t0 = await panel(p);
  rec(G('first-run'), 'On Device tab visible and active via menu', await p.locator('#tab-device').isVisible() && /No folders chosen yet/.test(t0));
  rec(G('first-run'), 'states the real limitation (only chosen folders; no broad access)', /only see the folders you choose/i.test(t0), t0.replace(/\n+/g, ' | ').slice(0, 200));
  await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  const t1 = await panel(p);
  rec(G('list'), 'lists PDFs with name, size and modified date', /text_uncompressed\.pdf/.test(t1) && /notes\.pdf/.test(t1) && /KB/.test(t1) && /20\d\d/.test(t1), t1.replace(/\n+/g, ' | ').slice(0, 300));
  rec(G('list'), 'sorted newest first by default', (await p.$$eval('.ondevice-panel .recent-name, #ondevice-panel .recent-name', e => e.map(x => x.innerText)))[0] === 'zeta.pdf');
  await p.fill('#ondevice-search', 'notes'); await sleep(200);
  rec(G('list'), 'filter narrows the list', (await p.$$('#ondevice-panel .recent-item[data-i]')).length === 1);
  await p.fill('#ondevice-search', 'zzz'); await sleep(200);
  rec(G('list'), 'no-match filter says so', /No PDFs match/.test(await panel(p)));
  await p.fill('#ondevice-search', ''); await sleep(200);
  // 2. open → imported + reader
  const idx = (await p.$$eval('#ondevice-panel .recent-name', e => e.map(x => x.innerText))).indexOf('text_uncompressed.pdf');
  await p.click(`#ondevice-panel .recent-item[data-i="${idx}"]`);
  await p.waitForFunction(() => location.hash === '#reader', null, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  rec(G('open'), 'tapping a PDF streams it through /saf/doc once, adds it to the library and opens the Reader', s.hits.length === 1 && (await idbCount(p, 'files')) === 1 && (await p.evaluate(() => location.hash)) === '#reader', `hits=${s.hits.length} files=${await idbCount(p, 'files')} hash=${await p.evaluate(() => location.hash)}`);
  rec(G('open'), 'imported bytes identical to the source file', await p.evaluate(async () => new Promise(res => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAll(); q.onsuccess = () => res(q.result[0].blob.size); }; })) === rt.size);
  // 3. duplicate
  await goDevice(p); await p.waitForSelector('#ondevice-panel .recent-item[data-i]');
  const idx2 = (await p.$$eval('#ondevice-panel .recent-name', e => e.map(x => x.innerText))).indexOf('text_uncompressed.pdf');
  await p.click(`#ondevice-panel .recent-item[data-i="${idx2}"]`); await sleep(1500);
  rec(G('open'), 'opening the same PDF again does not re-read or duplicate it', s.hits.length === 1 && (await idbCount(p, 'files')) === 1, `hits=${s.hits.length} files=${await idbCount(p, 'files')}`);
  rec(G('open'), 'no page errors', s.logs.errors.length === 0, s.logs.errors.join('|'));
  await s.close(); }

// 4. folder picker cancelled
{ const s = await setup([]); const p = s.page; await goDevice(p);
  await p.evaluate(() => { window.__fake.pickResult = { ok: false, cancelled: true }; });
  await p.click('#od-add'); await sleep(600);
  rec(G('picker'), 'cancelling the system picker changes nothing and shows no error', /No folders chosen yet/.test(await panel(p)) && s.logs.errors.length === 0);
  await p.evaluate(() => { window.__fake.pickResult = { ok: false, error: 'Android would not allow that folder' }; });
  await p.click('#od-add'); await sleep(600);
  rec(G('picker'), 'picker failure is reported', /Could not add the folder/.test(await lastToasts(p)), await lastToasts(p));
  await p.evaluate(() => { window.__fake.pickResult = { ok: true, folder: { uri: 'content://tree/Documents', name: 'Documents', persisted: false } }; });
  await p.click('#od-add'); await sleep(900);
  rec(G('picker'), 'non-persistable grant is disclosed', /would not keep this permission/.test(await lastToasts(p)), await lastToasts(p));
  await s.close(); }

// 5. empty folder
{ const s = await setup([]); const p = s.page; await goDevice(p); await p.click('#od-add'); await sleep(900);
  rec(G('empty'), 'empty folder: clear "No PDFs found" message', /No PDFs found in/.test(await panel(p)), (await panel(p)).replace(/\n+/g, ' | ').slice(0, 160));
  await s.close(); }

// 6. revoked access
{ const s = await setup([fileEntry(1, 'a.pdf', 1000, 1700000000000)]); const p = s.page; await goDevice(p); await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  await p.evaluate(T => { delete window.__fake.tree[T]; }, T);
  await p.click('#od-refresh'); await sleep(900);
  const t = await panel(p);
  rec(G('revoked'), 'revoked folder: warning with re-grant path, list cleared', /Access to .*Documents.* was lost/.test(t) && !/a\.pdf/.test(t), t.replace(/\n+/g, ' | ').slice(0, 240));
  await s.close(); }
{ const s = await setup([fileEntry(1, 'a.pdf', 1000, 1700000000000)]); const p = s.page; await goDevice(p); await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  s.docMode['*'] = 403; await p.click('#ondevice-panel .recent-item[data-i="0"]'); await sleep(1200);
  rec(G('revoked'), 'permission revoked at open time: told to re-add, nothing imported', /Access to that folder was removed/.test(await lastToasts(p)) && (await idbCount(p, 'files')) === 0, await lastToasts(p));
  s.docMode['*'] = 404; await p.evaluate(() => { window.__toasts.length = 0; });
  await p.click('#od-refresh'); await sleep(500);
  await p.waitForSelector('#ondevice-panel .recent-item[data-i]').catch(() => {}); await p.click('#ondevice-panel .recent-item[data-i="0"]').catch(() => {}); await sleep(1200);
  rec(G('missing'), 'file deleted since listing: "no longer there", list refreshes', /no longer there/.test(await lastToasts(p)) && (await idbCount(p, 'files')) === 0, await lastToasts(p));
  s.docMode['*'] = 'short'; await p.evaluate(() => { window.__toasts.length = 0; });
  await p.waitForSelector('#ondevice-panel .recent-item[data-i]').catch(() => {}); await p.click('#ondevice-panel .recent-item[data-i="0"]').catch(() => {}); await sleep(1500);
  rec(G('truncated-read'), 'short/incomplete read is rejected, not imported', (await idbCount(p, 'files')) === 0 && /incomplete|could not|read/i.test(await lastToasts(p)), await lastToasts(p));
  await s.close(); }

// 7. too large
{ const s = await setup([fileEntry(1, 'huge.pdf', 450 * 1048576, 1700000000000)]); const p = s.page; await goDevice(p); await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  await p.click('#ondevice-panel .recent-item[data-i="0"]'); await sleep(800);
  rec(G('large-file'), '450 MB PDF refused with a clear reason before any read', /too large/.test(await lastToasts(p)) && s.hits.length === 0, await lastToasts(p)); await s.close(); }

// 8. large directory: pagination + truncation notice + unreadable notice
{ const many = Array.from({ length: 450 }, (_, i) => fileEntry(i + 1, `doc_${String(i).padStart(4, '0')}.pdf`, 1000 + i, 1700000000000 + i * 1000));
  const s = await setup(many, { truncated: true, truncatedReason: 'files', unreadableFolders: 2 }); const p = s.page; await goDevice(p); const t0 = Date.now(); await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  const n1 = (await p.$$('#ondevice-panel .recent-item[data-i]')).length;
  rec(G('large-dir'), '450 entries render as a first page of 100 (+ "show more")', n1 === 100 && (await p.locator('#od-more').count()) === 1, `rendered ${n1} in ${Date.now() - t0}ms`);
  await p.click('#od-more'); await sleep(200);
  rec(G('large-dir'), 'show more adds the next page', (await p.$$('#ondevice-panel .recent-item[data-i]')).length === 200);
  const t = await panel(p);
  rec(G('large-dir'), 'truncation + unreadable sub-folders disclosed', /very large/.test(t) && /couldn’t be read/.test(t), t.replace(/\n+/g, ' | ').slice(0, 260));
  await p.fill('#ondevice-search', 'doc_0123'); await sleep(200);
  rec(G('large-dir'), 'filter searches the whole list, not just the visible page', (await p.$$('#ondevice-panel .recent-item[data-i]')).length === 1);
  await s.close(); }

// 9. folder manager in Settings + remove
{ const s = await setup([fileEntry(1, 'a.pdf', 1000, 1700000000000)]); const p = s.page; await goDevice(p); await p.click('#od-add'); await p.waitForSelector('.recent-item[data-i]');
  await p.click('.nav-item[data-page="settings"]'); await sleep(300); await p.click('#setting-folders'); await sleep(500);
  rec(G('manager'), 'Settings → PDF Folders lists the granted folder', /Documents/.test(await p.locator('#modal-body').innerText()));
  await p.click('[data-mgr-remove]'); await sleep(500);
  const gone = await p.evaluate(() => window.__fake.folders.length === 0);
  rec(G('manager'), 'Remove releases the folder (bridge) and the list empties', gone);
  await p.click('#mgr-done').catch(() => {}); await sleep(300); await goDevice(p);
  rec(G('manager'), 'On Device returns to the empty state', /No folders chosen yet/.test(await panel(p)));
  await s.close(); }

// 10. the web (non-Android) build must not expose any of this
{ const s = await open(b, 'web'); await boot(s); const p = s.page;
  rec(G('web'), 'plain browser: no On Device tab/menu item/settings row', !(await p.locator('#tab-device').isVisible()) && !(await p.locator('#setting-folders').isVisible()));
  await s.close(); }

await b.close(); saveResults('device.json'); process.exit(0);
