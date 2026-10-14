# FYLO — PDF Reader & Editor

Professional PDF reader, editor, and tools. Available as a **PWA** and as a native **Android app**.

---

## Project Structure

```
fylo-web/          ← Web / PWA application (the single source of truth)
  app.js           ← Bootstrap
  core/            ← Shared utilities: state, router, event bus, storage, libs
  features/        ← reader, editor, camera, tools, files, settings
  assets/          ← CSS, icons, libs/ (local PDF libraries for Android)
  index.html
  manifest.json
  sw.js

fylo-android/      ← Android wrapper (adapter only — no PDF logic here)
  app/src/main/
    java/com/fylo/app/
      MainActivity.java     ← WebView host + JavaScript bridge
      FyloApplication.java  ← Application class
      UriUtils.java         ← content:// URI filename extraction
    assets/www/             ← Synced copy of fylo-web (created by Gradle)
    res/                    ← Icons, themes, layout
  build.gradle              ← Android build config + syncWebAssets task
```

---

## Web / PWA Development

### Run locally

Any static file server works. Example:

```bash
cd fylo-web
npx serve .
# open http://localhost:3000
```

### Deploy

Upload the contents of `fylo-web/` to any static host (GitHub Pages, Netlify, Vercel).
The Service Worker enables offline use after the first load.

---

## Android Development

### Prerequisites

- Android Studio Hedgehog (2023.1.1) or newer  
- JDK 17  
- Android SDK with API 26–34  
- Gradle 8.4 (downloaded automatically by the wrapper)

### First-time setup

**Step 1: Download PDF libraries for offline bundling**

The Android app ships PDF.js and PDF-Lib locally so PDF processing works offline.

```bash
cd fylo-android
./gradlew fetchPdfLibs
```

This downloads into `app/src/main/assets/www/assets/libs/`:
- `pdf.min.js`
- `pdf.worker.min.js`
- `pdf-lib.min.js`

**Step 2: Sync web assets**

The Android app bundles the web app from the sibling `fylo-web/` directory.

```bash
./gradlew syncWebAssets
```

This copies `fylo-web/**` into `app/src/main/assets/www/`.

> This step runs automatically before every `assembleDebug`/`assembleRelease`.

**Step 3: Build debug APK**

```bash
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

**Step 4: Install on device / emulator**

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

**Step 5: Build release AAB (for Play Store)**

```bash
./gradlew bundleRelease
```

Output: `app/build/outputs/bundle/release/app-release.aab`

> Sign the AAB with your keystore before uploading to Play Store.

---

## Architecture

### Platform Adapter Pattern

```
┌──────────────────────────────────────┐
│         FYLO Web Application         │
│  reader · editor · tools · camera    │
│  files · settings · storage          │
│  (identical on web and Android)      │
└──────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    │                    │
┌───▼────┐        ┌──────▼──────────┐
│  Web   │        │ Android WebView  │
│  PWA   │        │  + Native Bridge │
└────────┘        └─────────────────┘
```

The Android app is a **thin platform adapter**. It provides:
- WebView to host the web app
- JavaScript bridge for native Android capabilities
- Intent handling (Open With, Share)
- Native file save (MediaStore)
- Camera permission flow

All PDF logic (rendering, editing, converting, scanning) runs in the web layer.

### JavaScript Bridge API

The bridge is exposed as `window.AndroidBridge` inside the WebView.

| Method | Arguments | Returns | Purpose |
|--------|-----------|---------|---------|
| `saveBegin(kind, subdir, filename, mime)` → `saveChunk(id, base64)` → `saveEnd(id)` | strings | JSON `{ok,…}`; `saveEnd` → `{ok,name,path,uri,bytes}` | **Chunked, size-verified save** to `Download/FYLO[/subdir]` (kind `download`) or `Pictures/FYLO[/subdir]` (kind `image`). `saveEnd` re-reads the stored size and discards the file on mismatch |
| `saveAbort(id)` | string | void | Discard an unfinished save |
| `saveFile(base64, filename, mime)` | strings | JSON `{ok,…}` | One-shot variant of the above (small files) |
| `getFreeSpaceBytes()` | — | number | Free space, for pre-flight checks |
| `shareUris(jsonArray, mime)` / `viewUri(uri, mime)` | | boolean | Share / open files FYLO saved |
| `shareFile(base64, filename, mime)` | strings | void | Share a file from bytes |
| `clearNativeCache()` | — | JSON `{ok,freedBytes}` | Clears WebView HTTP cache + FYLO cache dir only — never IndexedDB, saved files or settings |
| `getAppInfo()` | — | JSON `{versionName,versionCode,lastUpdateTime,packageName,sdk}` | Shown in Settings → Version |
| `pickPdfFolder()` → `window.fyloNativeResult('folderPicked', json)` | — | void | SAF folder picker (persisted read grant) |
| `getPdfFolders()` / `removePdfFolder(uri)` | | JSON / void | Granted folders (`accessible:false` = revoked) |
| `listPdfs(requestId, treeUri)` → `fyloNativeResult(requestId, json)` / `cancelScan(requestId)` | | void | Background PDF listing (limits: 5000 files, 2500 folders, depth 8, 25 s; reports `truncated`) |
| `onWebCleanupDone(changed)` / `onWebCleanupFailed(msg)` | | void | Callbacks from the injected post-update cleanup script |
| `requestCameraPermission()` / `hasCameraPermission()` | | void / boolean | Camera permission |
| `openFilePicker(mimeTypesCsv)`, `showToast(msg)`, `getPlatform()`, `getAndroidVersion()` | | | as before |

PDFs inside a chosen folder are streamed to the web layer through the WebViewAssetLoader origin at
`/saf/doc?u=<content-uri>` (only URIs under a folder the user granted are served) — no base64 over the bridge.

**Web → Android result callbacks:**

| Window property | Set by | Delivered when |
|----------------|--------|----------------|
| `window.fyloEventBus` | `app.js` | Android can call `.emit('files:incoming', {files})` |
| `window.fyloHandleBack()` | `android-bridge.js` | `MainActivity.onBackPressed()` |
| `window.fyloOnCameraPermission(granted)` | `android-bridge.js` | Camera permission result |

### File import pipeline

All file entry points (web picker, Android intent, Android share, camera scan) converge at:

```
bus.emit('files:incoming', { files: [File, ...] })
```

Nothing else needs to change.

### Download pipeline

All export/download operations call `downloadBlob(blob, filename)` from `core/ui.js`.

`core/device.js` is the single adapter. On web: standard `<a>` download (cannot be verified — the UI says so).
On Android: chunked `saveBegin/saveChunk/saveEnd` with native size verification; UI reports the real path or the real error.

---

## Offline Behaviour

### Web / PWA
- App shell (HTML, JS, CSS, icons) cached by Service Worker after first load
- PDF.js and PDF-Lib cached from CDN after first use
- IndexedDB persists imported files
- Full offline PDF functionality after first successful load

### Android
- App shell bundled in APK — always available offline
- PDF.js, PDF-Lib bundled locally via `fetchPdfLibs` — no CDN needed
- IndexedDB persisted in WebView app data
- **True offline PDF processing from fresh install** (after `fetchPdfLibs` was run at build time)

---

## Android Permissions

| Permission | Required | Why |
|-----------|---------|-----|
| `CAMERA` | Optional | Document scanning (`getUserMedia`) |
| `INTERNET` | Optional | CDN fallback if local libs missing |

No storage permissions are requested. Saving uses MediaStore (API 29+) or app-specific storage (API 26–28).
**On Device browsing uses the Storage Access Framework**: the user picks folders; FYLO can only see those folders.
Android 11+ will not let any app be granted the root of internal storage, `Android/data`, or (on many devices) the
top-level `Download` folder — pick a folder *inside* it, or `Documents`. FYLO does not claim to see "all PDFs on the phone".

---

## Security Notes

- WebView only loads `file:///android_asset/www/**` — no arbitrary URLs
- External URLs open in system browser (not in the WebView)
- JavaScript bridge exposes scoped file/SAF methods only — no shell; `/saf/doc` serves only URIs under user-granted folders
- FileProvider restricts share URIs to app cache only
- `cleartextTrafficPermitted="false"` in network_security_config.xml
- No hardcoded keys, secrets, or passwords

---

## Keeping Web and Android in Sync

```bash
cd fylo-android
./gradlew fetchPdfLibs    # once (PDF.js + PDF-Lib into assets/libs)
./gradlew assembleDebug   # syncWebAssets (a true mirror of fylo-web/) + verifyWebVersion run first
bash scripts/verify-apk.sh   # checks versionName/versionCode and that packaged web files == fylo-web/
```

## Releasing an update that installs over the old one

Android installs an APK as an update only when **(1) `applicationId` is unchanged, (2) `versionCode` is higher, (3) it is signed with the same key.**

1. Bump `APP_VERSION` in `fylo-web/core/constants.js` (e.g. `2.1.0` → `2.1.1`). This is the *only* version source:
   Gradle derives `versionName` and `versionCode = MAJOR*10000 + MINOR*100 + PATCH`; the Service Worker cache name and Settings → Version use it too.
2. Build with the **same signing key every time**. Default is the machine's debug key; to make builds from other machines/CI
   update each other, create `fylo-android/keystore.properties` (git-ignored: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
   If the key ever changes, Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE` — back up first (Settings → Export Data), then uninstall once.
3. `adb install -r app-debug.apk` (or just open the APK on the phone). Data in IndexedDB survives an update.

Why old builds kept showing: a cache-first Service Worker (fixed cache name) and Cache Storage inside the WebView could serve the old app
shell before any new code ran. Inside the Android wrapper the SW is no longer registered (assets are already local), and after every install/update
`MainActivity` injects a one-time cleanup (unregister SWs, delete `fylo-*` caches — never IndexedDB) and reloads, retrying until the page confirms.
Browsers/PWA: the SW cache name is `fylo-v<APP_VERSION>`, so each release replaces the previous cache.

---

## Testing status

Automated (headless Chromium, `tests/web/` — run `python3 tests/web/make_fixtures.py` then the `*.mjs` suites with Playwright):
web mode against `fylo-web/`, and an **Android-wrapper simulation** (the `www` copy on the WebViewAssetLoader origin with a *fake* `AndroidBridge`).
The simulation proves the web layer's handling of the bridge protocol; it does **not** prove real MediaStore/SAF/WebView behaviour.

Not verifiable without a device: MediaStore writes and gallery visibility, the SAF picker and real folder listings, persisted-permission revocation,
share sheet, Back button, in-place update over an older install, WebView service-worker routing. See the release report for the physical-device checklist.
