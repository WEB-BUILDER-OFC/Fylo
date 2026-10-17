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
| `getStorageAccess()` | — | JSON `{sdk,mode,granted}` | `mode`: `all_files` (API 30+), `read_storage` (API 26–28), `folders_only` (API 29) |
| `requestStorageAccess()` → `fyloNativeResult('storageAccess', json)` | — | void | API 30+: opens the system **All files access** screen (not a popup); result is posted when the app resumes. API 26–28: runtime READ_EXTERNAL_STORAGE dialog |
| `discoverPdfs(requestId, deep)` → `fyloNativeResult(requestId, json)` | | void | `{ok,files:[{path,name,size,modified}],truncated}`. Quick = MediaStore index; deep = also walks storage (limits 20 000 files, 90 s) |
| `statPdfs(requestId, jsonArray)` | | void | Existence/permission check for paths or content URIs → `{items:[{path,allowed,exists,size}]}` |
| `pickPdfDocuments()` → `fyloNativeResult('docsPicked', json)` / `releaseDocument(uri)` | | void | "Open PDF" picker that keeps a persisted read grant per document so it is opened in place |
| `onWebCleanupDone(changed)` / `onWebCleanupFailed(msg)` | | void | Callbacks from the injected post-update cleanup script |
| `requestCameraPermission()` / `hasCameraPermission()` | | void / boolean | Camera permission |
| `openFilePicker(mimeTypesCsv)`, `showToast(msg)`, `getPlatform()`, `getAndroidVersion()` | | | as before |

PDFs inside a chosen folder are streamed to the web layer through the WebViewAssetLoader origin at
`/saf/doc?u=<content-uri>` (only URIs under a granted folder or individually picked/granted documents are served) — no base64 over the bridge.
PDFs on shared storage stream from `/dev/doc?p=<absolute path>` (PDF files inside shared storage only; never other apps' `Android/data|obb`;
needs All-files access) and FYLO's own MediaStore saves from `/dev/doc?u=<content://media/…>`.

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

| `MANAGE_EXTERNAL_STORAGE` | Optional (API 30+) | "All files access": lets FYLO list PDFs anywhere on shared storage and open them in place. Granted by the user on a **system Settings screen**, not a popup. Sideload-only: Google Play does not allow this for a PDF utility |
| `READ_EXTERNAL_STORAGE` (≤ API 28) | Optional | Same purpose on Android 8–9 |

Everything works without the storage permissions: saving uses MediaStore (API 29+) / app-specific storage (API 26–28), the **Open PDF** picker and
folders chosen through the Storage Access Framework keep working. Android 10 has no whole-storage grant for apps targeting 30+, so it is folders-only.

### Unified library & storage rules
- One list ("All PDFs"): PDFs found on the phone + PDFs FYLO made + PDFs the user opened/imported. The same physical file is listed once (key = canonical path; SAF document ids are mapped to paths).
- **Nothing is copied to browse or open.** A library record for a file kept elsewhere is metadata only (`ref`, name, size, a small thumbnail); the bytes are streamed from the original location each time (`DeviceBlob`). Discovery results live in memory only and are rebuilt from Android at launch.
- **New PDFs (Scan, Merge, Split, Compress, …) are saved once** to `Download/FYLO` (Settings → *Save new PDFs to*; "Inside FYLO only" keeps the old internal storage). No second download, no private duplicate. If the shared save fails, the PDF is kept inside FYLO rather than lost.
- Originals are never overwritten: tools write a new file. "Remove from FYLO" on a referenced PDF only deletes the record — FYLO never deletes files on the phone.
- Backup (Export Data) includes only PDFs stored inside FYLO; referenced PDFs are listed in `files.json` with their location, not duplicated.
- Missing / moved / permission-revoked files are flagged (*Missing* / *No access*) and explained on tap; refresh and a bounded deep scan are available.

---

## Security Notes

- WebView only loads `file:///android_asset/www/**` — no arbitrary URLs
- External URLs open in system browser (not in the WebView)
- JavaScript bridge exposes scoped file/SAF methods only — no shell; `/saf/doc` serves only granted folders/documents; `/dev/doc` serves only `.pdf` files inside shared storage (and requires All-files access) or FYLO's own MediaStore items
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
2. Build with the **same signing key every time**. Builds are now signed with the committed
   `fylo-android/signing/fylo-signing.keystore` (alias `fylo`; SHA-256 in `signing/expected-cert-sha256.txt`) on every machine **and in GitHub Actions**.
   Before this, each CI run generated a brand-new random debug key, so each APK had a different certificate and Android answered "App not installed".
   Use your own key instead by creating `fylo-android/keystore.properties` (git-ignored: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`) or, in CI,
   the secrets `FYLO_KEYSTORE_B64`, `FYLO_KEYSTORE_PASSWORD`, `FYLO_KEY_ALIAS`, `FYLO_KEY_PASSWORD`. **Never change keys once the app is installed anywhere.**
   The committed key's password is public: it is a convenience key for personal/sideloaded builds, not a store-release secret.
   `bash scripts/verify-apk.sh new.apk --previous old.apk` compares package name, signing certificate and versionCode of two APKs.
3. `adb install -r app-debug.apk` (or just open the APK on the phone). Data in IndexedDB survives an update.

Why old builds kept showing: a cache-first Service Worker (fixed cache name) and Cache Storage inside the WebView could serve the old app
shell before any new code ran. Inside the Android wrapper the SW is no longer registered (assets are already local), and after every install/update
`MainActivity` injects a one-time cleanup (unregister SWs, delete `fylo-*` caches — never IndexedDB) and reloads, retrying until the page confirms.
Browsers/PWA: the SW cache name is `fylo-v<APP_VERSION>`, so each release replaces the previous cache.

---

### Diagnosing "App not installed"
1. Every CI run uploads `apk-report.txt` next to the APK (package, versionCode, SDK, ABI, signer SHA-256, `apksigner verify` output).
2. With the phone attached (USB debugging): `bash fylo-android/scripts/diagnose-update.sh app-debug.apk` pulls the installed APK, compares package / signer / versionCode, and runs `adb install -r`, printing the exact `[INSTALL_FAILED_…]` code.
3. Without a PC: extract the installed APK with an app like App Manager and run the script with both files, or compare the signer SHA-256 it shows with the one in `apk-report.txt`.
4. From 2.2.1 on, Settings → Version shows the first 8 hex digits of the key the running app is signed with (`key e509a730…` = the committed FYLO key).

## Testing status

Automated (headless Chromium, `tests/web/` — run `python3 tests/web/make_fixtures.py` then the `*.mjs` suites with Playwright):
web mode against `fylo-web/`, and an **Android-wrapper simulation** (the `www` copy on the WebViewAssetLoader origin with a *fake* `AndroidBridge`).
The simulation proves the web layer's handling of the bridge protocol; it does **not** prove real MediaStore/SAF/WebView behaviour.

Not verifiable without a device: MediaStore writes and gallery visibility, the SAF picker and real folder listings, persisted-permission revocation,
share sheet, Back button, in-place update over an older install, WebView service-worker routing. See the release report for the physical-device checklist.
