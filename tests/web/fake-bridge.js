/* Test double for window.AndroidBridge (what MainActivity injects). SIMULATION ONLY — it proves the web layer's
 * handling of the bridge protocol, NOT that the real Java behaves the same on a device. */
(() => {
  const cfg = Object.assign({ free: 5e9, scanDelay: 20, cacheFreed: 4096 }, window.__cfg || {});
  const F = window.__fake = { cfg, sessions: {}, saved: [], shares: [], views: [], folders: [], tree: {},
    pickResult: null, pickCalls: 0, storage: Object.assign({ sdk: 34, mode: 'all_files', granted: false }, cfg.storage || {}), device: [], docs: [], docPick: [], accessRequests: 0, discoverCalls: [], statCalls: [], scanCalls: 0, cancelled: 0, aborted: 0, cacheCleared: 0, n: 0 };
  // Native state (granted folders, trees) outlives a page reload, like SharedPreferences/persisted grants do on a device.
  try { const saved = JSON.parse(sessionStorage.getItem('__fakeNative') || 'null'); if (saved) { F.folders = saved.folders; F.tree = saved.tree; F.pickResult = saved.pickResult; F.pickCalls = saved.pickCalls || 0; F.saved = []; if (saved.storage) F.storage = saved.storage; F.device = saved.device || []; F.docPick = saved.docPick || []; F.accessRequests = saved.accessRequests || 0; } } catch (e) {}
  setInterval(() => { try { sessionStorage.setItem('__fakeNative', JSON.stringify({ folders: F.folders, tree: F.tree, pickResult: F.pickResult, pickCalls: F.pickCalls, storage: F.storage, device: F.device, docPick: F.docPick, accessRequests: F.accessRequests })); } catch (e) {} }, 40);
  const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const ok = o => JSON.stringify(Object.assign({ ok: true }, o));
  const bad = e => JSON.stringify({ ok: false, error: e });
  F.base64 = (i) => { const d = F.saved[i].data; let s = ''; for (let o = 0; o < d.length; o += 0x8000) s += String.fromCharCode.apply(null, d.subarray(o, o + 0x8000)); return btoa(s); };
  window.AndroidBridge = {
    getPlatform: () => 'android',
    getAndroidVersion: () => '34',
    getAppInfo: () => JSON.stringify({ versionName: cfg.versionName || '2.2.0', versionCode: 20200, lastUpdateTime: 1, packageName: 'com.fylo.app.debug', sdk: 34 }),
    saveBegin(kind, subdir, filename, mime) {
      if (cfg.failBeginContains && filename.includes(cfg.failBeginContains)) return bad('Simulated: the system refused to create the file');
      const id = 's' + (++F.n); F.sessions[id] = { kind, subdir, filename, mime, parts: [], bytes: 0 }; return ok({ id });
    },
    saveChunk(id, data) {
      const s = F.sessions[id]; if (!s) return bad('Unknown save session');
      if (cfg.failChunkContains && s.filename.includes(cfg.failChunkContains)) { delete F.sessions[id]; return bad('Not enough free storage space on the device'); }
      const u = b64(data); s.parts.push(u); s.bytes += u.length; return ok({ written: s.bytes });
    },
    saveEnd(id) {
      const s = F.sessions[id]; delete F.sessions[id]; if (!s) return bad('Unknown save session');
      if (cfg.endMismatch) return bad('Size check failed: wrote ' + s.bytes + ' bytes but found ' + (s.bytes - 1));
      const dir = (s.kind === 'image' ? 'Pictures' : 'Download') + '/FYLO' + (s.subdir ? '/' + s.subdir : '');
      let name = s.filename; while (F.saved.some(x => x.path === dir + '/' + name)) name = name.replace(/(\.[^.]+)$/, ' (1)$1');
      const data = new Uint8Array(s.bytes); let o = 0; for (const p of s.parts) { data.set(p, o); o += p.length; }
      const rec = { name, path: dir + '/' + name, uri: 'content://media/external/' + s.kind + '/' + (F.saved.length + 1), bytes: s.bytes, kind: s.kind, mime: s.mime, data };
      rec.abs = '/storage/emulated/0/' + rec.path;
      F.saved.push(rec); return ok({ name, path: rec.path, abs: rec.abs, uri: rec.uri, bytes: s.bytes });
    },
    saveAbort(id) { delete F.sessions[id]; F.aborted++; },
    getFreeSpaceBytes: () => cfg.free,
    clearNativeCache() { F.cacheCleared++; return ok({ freedBytes: cfg.cacheFreed }); },
    shareUris(j, m) { F.shares.push({ uris: JSON.parse(j), mime: m }); return true; },
    viewUri(u, m) { F.views.push({ u, m }); return true; },
    pickPdfFolder() {
      F.pickCalls++;
      setTimeout(() => {
        const r = F.pickResult || { ok: false, cancelled: true };
        if (r.ok && !F.folders.some(f => f.uri === r.folder.uri)) F.folders.push({ uri: r.folder.uri, name: r.folder.name, accessible: true });
        if (cfg.dropPickCallback) return;            // simulate the native->JS callback being lost
        window.fyloNativeResult('folderPicked', JSON.stringify(r));
      }, 30);
    },
    getSafStatus: () => JSON.stringify({ launches: F.pickCalls, results: F.pickCalls, lastEvent: 'fake', persistedGrants: F.folders.length, folders: F.folders, sdk: 34, pageReady: true }),
    getPdfFolders: () => JSON.stringify(F.folders),
    removePdfFolder(u) { F.folders = F.folders.filter(f => f.uri !== u); },
    listPdfs(id, uri) {
      F.scanCalls++;
      setTimeout(() => {
        const t = F.tree[uri];
        window.fyloNativeResult(id, JSON.stringify(t || { ok: false, error: 'ACCESS_REVOKED', message: 'Access to this folder was removed' }));
      }, cfg.scanDelay);
    },
    cancelScan() { F.cancelled++; },
    // ── whole-device access (simulation of MainActivity/DevicePdfIndex contract) ──
    getStorageAccess: () => JSON.stringify(F.storage),
    requestStorageAccess() {
      F.accessRequests++;
      // The real thing opens a Settings screen; the test decides what the user did there (F.grantOnRequest).
      setTimeout(() => {
        if (F.grantOnRequest) F.storage.granted = true;
        window.fyloNativeResult('storageAccess', JSON.stringify(F.storage));
      }, cfg.accessDelay || 60);
    },
    discoverPdfs(id, deep) {
      F.discoverCalls.push({ id, deep });
      setTimeout(() => {
        if (!F.storage.granted) return window.fyloNativeResult(id, JSON.stringify({ ok: false, error: 'NO_ACCESS', message: 'Storage access has not been granted.' }));
        const files = F.device.filter(f => !f.deleted && (deep || !f.unindexed)).map(f => ({ path: f.path, name: f.name, size: f.size, modified: f.modified }));
        window.fyloNativeResult(id, JSON.stringify({ ok: true, files, truncated: !!cfg.truncate, deep: !!deep }));
      }, cfg.scanDelay);
    },
    statPdfs(id, json) {
      const list = JSON.parse(json); F.statCalls.push(list);
      setTimeout(() => {
        const items = list.map(p => {
          if (p.startsWith('content://media/')) { const r = F.saved.find(x => x.uri === p); return { path: p, allowed: true, exists: !!r && !r.deleted, size: r ? r.bytes : 0, modified: 0 }; }
          if (p.startsWith('content:') && F.folders.some(f => p.startsWith(f.uri + '/'))) return { path: p, allowed: !(F.revokedFolders || []).some(u => p.startsWith(u)), exists: !(F.goneDocs || []).includes(p), size: 1, modified: 0 };
          if (p.startsWith('content:')) { const d = F.docPick.find(x => x.uri === p); return { path: p, allowed: !!d && !d.revoked, exists: !!d && !d.deleted, size: d ? d.size : 0, modified: 0 }; }
          const f = F.device.find(x => x.path === p) || F.saved.find(x => x.abs === p);
          const allowed = F.storage.granted || (F.saved.some(x => x.abs === p) && false);
          return { path: p, allowed, exists: allowed && !!f && !f.deleted, size: f ? (f.size || f.bytes) : 0, modified: 0 };
        });
        window.fyloNativeResult(id, JSON.stringify({ ok: true, items }));
      }, 10);
    },
    pickPdfDocuments() { F.pickDocCalls = (F.pickDocCalls || 0) + 1; (F.nextDocs || []).forEach(d => { if (!F.docPick.some(x => x.uri === d.uri)) F.docPick.push(d); }); setTimeout(() => window.fyloNativeResult('docsPicked', JSON.stringify({ ok: true, files: F.nextDocs || [] })), 30); },
    releaseDocument(u) { (F.released = F.released || []).push(u); },
    showToast() {}, hasCameraPermission: () => true, requestCameraPermission() {},
    openFilePicker() {},
  };
})();
