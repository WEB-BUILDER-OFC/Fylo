/* Test double for window.AndroidBridge (what MainActivity injects). SIMULATION ONLY — it proves the web layer's
 * handling of the bridge protocol, NOT that the real Java behaves the same on a device. */
(() => {
  const cfg = Object.assign({ free: 5e9, scanDelay: 20, cacheFreed: 4096 }, window.__cfg || {});
  const F = window.__fake = { cfg, sessions: {}, saved: [], shares: [], views: [], folders: [], tree: {},
    pickResult: null, pickCalls: 0, scanCalls: 0, cancelled: 0, aborted: 0, cacheCleared: 0, n: 0 };
  const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const ok = o => JSON.stringify(Object.assign({ ok: true }, o));
  const bad = e => JSON.stringify({ ok: false, error: e });
  F.base64 = (i) => { const d = F.saved[i].data; let s = ''; for (let o = 0; o < d.length; o += 0x8000) s += String.fromCharCode.apply(null, d.subarray(o, o + 0x8000)); return btoa(s); };
  window.AndroidBridge = {
    getPlatform: () => 'android',
    getAndroidVersion: () => '34',
    getAppInfo: () => JSON.stringify({ versionName: cfg.versionName || '2.1.0', versionCode: 20100, lastUpdateTime: 1, packageName: 'com.fylo.app.debug', sdk: 34 }),
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
      F.saved.push(rec); return ok({ name, path: rec.path, uri: rec.uri, bytes: s.bytes });
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
        window.fyloNativeResult('folderPicked', JSON.stringify(r));
      }, 30);
    },
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
    showToast() {}, hasCameraPermission: () => true, requestCameraPermission() {},
    openFilePicker() {},
  };
})();
