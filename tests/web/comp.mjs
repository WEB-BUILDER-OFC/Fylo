import { chromium, open, rec, sleep, saveResults, OUT } from './lib.mjs';
import { boot, importPdfs, idbCount, modalText, waitModal, menuAction, fx } from './helpers.mjs';
import fs from 'node:fs';
const mode = process.argv[2] || 'web';
const only = process.argv[3] ? process.argv[3].split(',') : null;
const level = process.argv[4] || 'medium';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const names = ['text_uncompressed','text_compressed','photos','gray_photos','flate_images','already_small','scanned','malformed','not_a_pdf','encrypted','large_ok'].filter(n => !only || only.includes(n));
for (const n of names) {
  const s = await open(b, mode); const p = s.page; await boot(s);
  const t0 = Date.now();
  const imported = await importPdfs(p, [n + '.pdf'], 1);
  if (!imported) { rec(`compress/${mode}`, n, true, 'not importable into library (rejected at import) — compress flow n/a'); await s.close(); continue; }
  await menuAction(p, 'compress');
  await p.click('[data-compress-file]'); await p.selectOption('#compress-level', level); await p.click('#compress-run-btn');
  let txt = '';
  try { txt = await waitModal(p, /smaller|couldn|could not|failed|error|saved|can.?t|already|no (further )?saving|not .*compress/, 240000); } catch (e) { txt = 'TIMEOUT ' + (await modalText(p).catch(() => '')); }
  console.log(`--- ${n} (${((Date.now()-t0)/1000).toFixed(1)}s)\n${txt.replace(/\n+/g, ' | ')}\n errors: ${s.logs.errors.join('; ')}  files-in-lib: ${await idbCount(p, 'files')}`);
  await s.close();
}
await b.close(); process.exit(0);
