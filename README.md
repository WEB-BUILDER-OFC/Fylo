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
| `saveFile(base64, filename, mimeType)` | strings | JSON string `{success, path, error}` | Save to Downloads/FYLO |
| `shareFile(base64, filename, mimeType)` | strings | void | Android share sheet |
| `requestCameraPermission()` | — | void | Runtime camera permission |
| `hasCameraPermission()` | — | boolean | Check camera permission |
| `openFilePicker(mimeTypesCsv)` | string | void | Native file picker |
| `showToast(message)` | string | void | Native toast |
| `getPlatform()` | — | "android" | Platform detection |
| `getAndroidVersion()` | — | string | API level |

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

On web: standard `<a>` download.  
On Android: detected via `window.AndroidBridge !== undefined` → `AndroidBridge.saveFile()`.

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

No broad storage permissions required. MediaStore API is used for Downloads.

---

## Security Notes

- WebView only loads `file:///android_asset/www/**` — no arbitrary URLs
- External URLs open in system browser (not in the WebView)
- JavaScript bridge exposes only 7 scoped methods — no shell, no FS traversal
- FileProvider restricts share URIs to app cache only
- `cleartextTrafficPermitted="false"` in network_security_config.xml
- No hardcoded keys, secrets, or passwords

---

## Keeping Web and Android in Sync

When you update the web app:

```bash
cd fylo-android
./gradlew syncWebAssets   # copies latest web files into Android assets
./gradlew assembleDebug   # builds APK with updated assets
```

The `syncWebAssets` task runs automatically before every build.

---

## Device Testing Status

⚠️  **Physical device / emulator testing was not possible in this build environment.**

The following have been validated by code review and architecture audit:

- ✅ Intent filters correctly declared for `application/pdf`
- ✅ `ACTION_VIEW`, `ACTION_SEND`, `ACTION_SEND_MULTIPLE` handled
- ✅ content:// URI reading via ContentResolver
- ✅ MediaStore Downloads save (API 29+)
- ✅ FileProvider share configuration
- ✅ Camera permission request/result flow
- ✅ Back button priority chain
- ✅ WebView ES module support (minSdk 26 = Chrome 58+ WebView)
- ✅ PDF library offline loading chain
- ✅ Web version unaffected (feature-detection guards all Android code)

Physical device testing is required before Play Store submission.
