// Static contract check: every AndroidBridge method the web code calls must exist as a @JavascriptInterface method in
// MainActivity.java; every method the fake test-bridge offers must too (so the simulation can't drift from the real bridge).
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, rec, saveResults } from './lib.mjs';
const java = fs.readFileSync(path.join(ROOT, 'fylo-android/app/src/main/java/com/fylo/app/MainActivity.java'), 'utf8');
const native = new Set([...java.matchAll(/@JavascriptInterface\s+public\s+[\w<>\[\]]+\s+(\w+)\s*\(/g)].map(m => m[1]));
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const web = new Set();
for (const f of walk(path.join(ROOT, 'fylo-web')).filter(f => f.endsWith('.js'))) {
  const t = fs.readFileSync(f, 'utf8');
  const bridgeVar = /core\/device\.js$/.test(f) ? '\\bb|' : '';   // in device.js the bridge object is held in a local named b
  for (const m of t.matchAll(new RegExp('(?:' + bridgeVar + 'bridge\\(\\)\\??|AndroidBridge|window\\.AndroidBridge)\\??\\.(\\w+)\\s*\\(', 'g'))) web.add(m[1]);
  for (const m of t.matchAll(/typeof\s+(?:b|AndroidBridge|window\.AndroidBridge)\.(\w+)/g)) web.add(m[1]);
}
const ignore = new Set(['call', 'apply', 'bind']);
const missing = [...web].filter(n => !native.has(n) && !ignore.has(n));
rec('contract', 'every AndroidBridge method used by the web code exists in MainActivity.java', missing.length === 0, 'missing: ' + missing.join(',') + ' | native=' + [...native].sort().join(','));
const fake = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-bridge.js'), 'utf8');
const fakeNames = [...fake.matchAll(/^\s{4}(\w+)\s*(?:\(|:)/gm)].map(m => m[1]).filter(n => !['ok'].includes(n));
const ghost = [...new Set(fakeNames)].filter(n => !native.has(n) && ['getPlatform','pickPdfFolder','saveBegin','listPdfs','getSafStatus','cancelScan'].includes(n));
rec('contract', 'fake bridge methods used in tests are real native methods', ghost.length === 0, ghost.join(','));
// event / key names the web waits for must be the ones native sends
rec('contract', 'native posts "folderPicked" and web waits for "folderPicked"', /postToWeb\("folderPicked"/.test(java) && /_pending\.set\('folderPicked'/.test(fs.readFileSync(path.join(ROOT, 'fylo-web/core/device.js'), 'utf8')));
rec('contract', 'native JSON keys read by web exist (ok, folder, cancelled, error)', ['"ok"', '"folder"', '"cancelled"', '"error"'].every(k => java.includes(k)));
const dev = fs.readFileSync(path.join(ROOT, 'fylo-web/core/device.js'), 'utf8');
const A = f => fs.readFileSync(path.join(ROOT, 'fylo-android/app/src/main/java/com/fylo/app', f), 'utf8');
const idx = A('DevicePdfIndex.java'), saf = A('SafPdfIndex.java'), man = fs.readFileSync(path.join(ROOT, 'fylo-android/app/src/main/AndroidManifest.xml'), 'utf8');
rec('contract', 'native posts "storageAccess"/"docsPicked" and web waits for the same ids', /postStorageState\("storageAccess"\)|postToWeb\(id, mDevice/.test(java) && /postToWeb\("docsPicked"/.test(java) && /_pending\.set\('storageAccess'/.test(dev) && /_pending\.set\('docsPicked'/.test(dev));
rec('contract', 'web reads the JSON keys native sends for discovery (files/path/name/size/modified, items/allowed/exists, granted/mode)',
  ['"files"', '"path"', '"name"', '"size"', '"modified"', '"truncated"'].every(k => idx.includes(k)) && ['"items"'].every(k => java.includes(k)) && ['"allowed"', '"exists"'].every(k => idx.includes(k)) && ['"granted"', '"mode"'].every(k => idx.includes(k)));
rec('contract', 'saveEnd returns "abs" (web uses it as the stable file path)', /"abs"/.test(fs.readFileSync(path.join(ROOT, 'fylo-android/app/src/main/java/com/fylo/app/FileSaver.java'), 'utf8')) && /abs: e\.abs/.test(dev));
rec('contract', 'manifest declares All-files access (API 30+) and READ_EXTERNAL_STORAGE only up to API 28', /MANAGE_EXTERNAL_STORAGE/.test(man) && /READ_EXTERNAL_STORAGE"[^>]*maxSdkVersion="28"/s.test(man) && /xmlns:tools/.test(man));
rec('contract', 'streaming route /dev/doc only serves PDFs inside shared storage (path policy) or FYLO-saved media URIs', /isPathAllowed\(p\)/.test(java) && /endsWith\("\.pdf"\)/.test(idx) && /"media"\.equals\(doc\.getAuthority\(\)\)/.test(java) && /Android\/data\/" \+ ctx\.getPackageName/.test(idx));
rec('contract', 'document grants: picked documents are served only while granted, and released when forgotten', /isGrantedDocument\(doc\)/.test(java) && /releasePersistableUriPermission/.test(saf) && /releaseDocument/.test(dev));
saveResults('contract.json'); process.exit(0);
