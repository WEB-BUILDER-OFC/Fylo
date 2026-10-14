import path from 'node:path';
import { FIX, sleep } from './lib.mjs';
export const fx = n => path.join(FIX, n);
export const idbCount = (page, store) => page.evaluate(store => new Promise((res, rej) => { const r = indexedDB.open('fylo_db'); r.onsuccess = () => { try { const q = r.result.transaction(store).objectStore(store).count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); } catch (e) { res(-1); } }; r.onerror = () => rej(r.error); }), store);
export async function boot(s) { await s.page.goto(s.url); await s.page.waitForSelector('#menu-btn'); await sleep(1800); }
export async function importPdfs(page, names, wantTotal) {
  await page.setInputFiles('#file-input', names.map(fx));
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { if ((await idbCount(page, 'files')) >= wantTotal) return true; await sleep(200); }
  return false;
}
export const modalText = page => page.locator('#modal-body').innerText();
export const modalOpen = page => page.evaluate(() => !document.getElementById('modal-overlay').classList.contains('hidden'));
export async function waitModal(page, re, timeout = 120000) {
  await page.waitForFunction(r => { const o = document.getElementById('modal-overlay'); return o && !o.classList.contains('hidden') && new RegExp(r, 'i').test(document.getElementById('modal-body').innerText + ' ' + document.getElementById('modal-title').innerText); }, re.source, { timeout });
  return modalText(page);
}
export async function menuAction(page, action) { await page.click('#menu-btn'); await page.waitForSelector('#menu-drawer[aria-hidden="false"]'); await page.click(`[data-menu-action="${action}"]`); await sleep(500); }
