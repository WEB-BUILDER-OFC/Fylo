# FYLO — Bug-fixing phase report

## Read this first: what I had, and what that limits

The ZIP contained only `app-debug.apk` — **no Gradle project, no Kotlin/Java source, no `fylo-web/` tree.**
I recovered what I needed from the APK:

- the **complete web layer** (`assets/www/`, readable, unminified) — all web fixes are made on it;
- the **complete native layer** (decompiled with jadx; it is small: `MainActivity`, `UriUtils`, `FyloApplication`) and the real `AndroidManifest.xml`.

Consequences:

1. **I could not build an APK.** The Android SDK / Google Maven are blocked in this environment. Nothing below was tested on a phone or in Android WebView.
2. Web changes are delivered as a drop-in `www/` tree. Copy it over **both** `fylo-web/` and the Android `assets/www/` mirror (they must stay byte-identical).
3. Native changes are delivered as `MainActivity.java` + new `DevicePdfs.java` + a diff (`MainActivity.patch`) **against the decompiled MainActivity**. Apply the diff by hand to your real source (identifiers/lambdas in your source may differ). No manifest change and **no new permissions**.

Evidence labels used below: **[Chromium]** = automated, real Chromium + your bundled PDF.js/pdf-lib, mock `AndroidBridge` (not Android WebView); **[compile]** = native Java type-checked against Android API 33 `android.jar` with hand-written stubs for androidx (not a Gradle build, not run); **[unverified]** = needs your phone.

---

## 1. Update not applying — ROOT CAUSE FOUND (highest priority)

**Facts from the APK:** `applicationId com.fylo.app.debug`, `versionCode=1`, `versionName=1.0.0`, debug-signed. Web assets in the APK are current. IndexedDB lives in WebView site data, which Android keeps across updates.

**Root cause (reproduced [Chromium] on your original build):** the web layer registered a **cache-first service worker** (`fylo-v6`) on the `appassets…` origin. Site data (SW + Cache Storage) survives an APK update, so after updating the WebView kept serving the *previous* version's `index.html`/JS/CSS from cache.
- New code, `sw.js` byte-identical (CACHE_NAME not bumped by hand): **new version never appears, on any number of relaunches.**
- New code + `sw.js` changed: new SW installs, but the **first launch after the update still shows the old version**; new one only on the 2nd launch (the app deliberately ignores `SW_UPDATED` on Android).
- Also: `core/android-bridge.js` and the PDF libs were not in the precache list, so they were cached at runtime and never revalidated.
- The previous native workaround (`unregister` + reload in `onPageFinished`) runs *after* the stale page has loaded, marks itself done before it finishes, and never clears Cache Storage.

**Fix (smallest robust):** inside the Android app a service worker adds nothing (assets are local, offline by definition) and can only go stale.
- `app.js`: on Android, never register a SW; unregister any left behind and delete its caches.
- `sw.js` (new): on the Android origin it becomes a **self-retiring worker** — devices still holding the old worker pick it up as an update, it deletes all caches, unregisters itself and reloads open pages once. On web/PWA it is now **network-first**, so it no longer depends on hand-bumping a version.
- Settings → Version now shows `FYLO 2.1.0 · app <versionName> (build <versionCode>)` so you can *see* what is installed (`getAppVersion()` bridge method).

**Tests [Chromium], one persistent profile = same site data across "updates":**
- original → fixed build: new version on the **first** launch; old SW and caches removed;
- fixed → fixed (the case that used to stay stale forever): applies immediately;
- **user data survives**: a saved PDF (IndexedDB blob), a setting (light theme) and a bookmark persisted through two upgrades;
- fresh install on an empty profile works. 13/13 checks pass (`tests/t2_update_fix.js`).

**You still must do (build config, I had no Gradle file):** `versionCode` is `1` in every build. Make it increase every build (e.g. `versionCode = (System.currentTimeMillis()/1000).toInt()` or a CI counter) and keep the **same `applicationId` and the same signing key**. Some installers treat an equal versionCode as "nothing to update", and a different debug keystore makes Android refuse the update outright. I could not test either from here. [unverified]

## 2. Show phone PDFs inside FYLO

**Design decision (steelmanned):**
- *MANAGE_EXTERNAL_STORAGE* (list everything automatically): broad "all files" access, Play-restricted — rejected per your constraints.
- *READ_MEDIA_\* / READ_EXTERNAL_STORAGE*: on Android 10+ these do **not** expose other apps' PDFs to MediaStore — would silently list nothing.
- **Chosen: Storage Access Framework.** The user grants a folder once (Download, Documents…) through the system picker; the grant is persisted by Android; FYLO lists PDFs from granted folders **plus** the PDFs FYLO itself saved to `Downloads/FYLO` (readable without permission). Nothing outside granted folders is read. No permission is requested up-front.

**What was built:** Files → new **On device** tab (shown only in the Android app): Add folder, Refresh, folder list with Remove, rows with thumbnail / name / size / date / folder, "Show more" paging. Thumbnails are rendered **natively** (`PdfRenderer`) only for rows on screen. Tapping a row streams **only that one file** (`/device/<id>.pdf` path handler, ids come only from the last scan) into the normal import → Reader. Nothing else is copied. The manual **Open PDF** picker is untouched.
Handled: no grant (explained, nothing requested), picker cancelled, folder unavailable/revoked (shown, removable), empty results, **duplicates** (same document reached via two granted folders, or via MediaStore + folder → one entry), deleted/moved file (410 → message + rescan), scan that never reports back (45 s guard, no stuck spinner), names HTML-escaped, 3000-item / 25 s scan cap with a visible "showing most recent" note.

**Evidence:**
- **[Chromium]** 19 UI/protocol checks with a mocked native bridge (`t3_features.js`): empty/denied/cancelled/error/empty-result states, listing, escaping, thumbnails once each, refresh, open → Reader with 3 pages, no duplicate library entry on re-open, only the tapped file imported, deleted-file path, remove folder, other tabs unaffected.
- **[compile]** `DevicePdfs.java` and patched `MainActivity.java` compile against API 33.
- **[unverified]** the actual SAF traversal, persisted-permission behaviour, `PdfRenderer` thumbnails, the `/device/` path handler and the dedupe on a real phone/OEM. Please test: grant Download → list appears → open one → revoke in system settings → Refresh.
- Limit to know: on Android 26–28 the FYLO-own-downloads source is skipped (MediaStore.Downloads is API 29+); folder grants work.

## 3. Compress PDF

**Root causes:** (a) pdf-lib `save({useObjectStreams})` only rewrites structure and **never recompresses images**, so output was often as large or larger, yet reported "Compressed — saved ~-3%"; (b) the file was saved only via download, never added to FYLO, so it could not be reopened from the app; (c) no progress / cancel / verification; (d) `file.size` metadata used instead of the real blob size.

**Now:** JPEG images are decoded, optionally downscaled and re-encoded at a chosen strength (Light / **Balanced** / Strong), replaced only if ≥10 % smaller; CMYK, masked, `/Decode`d and stencil images are left alone. Output is **verified** (reloaded with pdf-lib *and* PDF.js, page count compared) before anything is saved. Under 1 % saving → **"Could not reduce this PDF"**, nothing saved, original untouched. Result is added to the library once, saved to Downloads, and offers **Open**. Real progress, Cancel / X / Back all cancel; failures show a message and release the tool.

**[Chromium] results:** 3-page JPEG scan **12.3 MB → 2.7 MB (78.1 % smaller)**, reported sizes equal the real byte counts, output re-opens in PDF.js with 3 non-blank pages and in the Reader; text-only PDF → truthful "could not reduce", nothing saved; corrupt file → clear error, nothing saved, next run works; Cancel saves nothing; exactly one file per run.
Honest limit: text/vector-only PDFs and PDFs whose images are not JPEG (e.g. Flate/PNG-style) will usually report "could not reduce". Image quality is visibly lower at Strong.

## 4. PDF to Image

**Root cause:** the conversion itself rendered, but saving used `a.click()` on a blob URL — **Android WebView does not handle that download at all**, so nothing was ever written; the "Rendering page n of N…" toasts were all the user saw. (Single page and multi-page paths both used it.)

**Now:** each page is rendered (≈144 dpi, capped at 12 MP per canvas, white background so JPG is not black), encoded, and saved through the native bridge (`downloadBlob`, which now returns a real result). Progress dialog with Cancel; the final message states exactly "N of M pages saved" and where. A save/encode failure stops and reports how many were saved; no success is claimed otherwise. `saveFile` in native code also had silent-failure paths (returned `success:true` when MediaStore insert failed; no pre-API-29 fallback; unescaped error JSON) — hardened.

**[Chromium]:** PNG: 3/3 files, names `scan_page1..3.png`, valid PNG signature, 1190×1684, decode to non-blank content; JPG: 3 valid JPEGs; simulated disk-full → honest failure, nothing claimed saved, next run works; Cancel and dialog-dismiss both stop work. **[unverified]** real saving to `Downloads/FYLO` on a device.

## 5. Settings
- **Clear Cache:** removes only disposable data — Cache Storage, and (Android, new `clearTempFiles()`) loose temp files in the app cache dir (share/export leftovers, which were never deleted before) + WebView HTTP cache. Reports what was freed. Never touches PDFs, bookmarks, favorites, settings. **[Chromium]** with mocked native method.
- **Export Data:** old version used `a.click()` (does nothing in WebView) and exported only names. Now one real file `fylo-backup-DATE.zip` with `fylo-backup.json` (settings, favorites, bookmarks, file list) + the PDFs (up to 48 MB total; anything left out is listed in the JSON **and** in the message), plus a Share button. **[Chromium]** ZIP passes Python `zipfile` CRC test, contains all PDFs, bookmarks, settings. **[unverified]** on-device save/share, and a backup near the 48 MB limit (base64 over the JS bridge).
- **Built With** removed. Remaining settings (Dark mode, Reduce animations, Clear cache, Export, Version) are all functional; I added none. The PWA install banner only ever appears in browsers.

## 6. Hamburger button
**Root cause:** the only handler toggled the Reader sidebar *while on the Reader page* — but the Reader hides the whole app bar (`.reader-mode .app-bar{display:none}`), so the button could never do anything. There is no drawer anywhere in the shell, so there was no "intended" menu to restore. **Decision for you to review:** it now opens a small menu (existing modal component) with Open PDF, Scan, PDFs on this device (Android), All tools, Settings. If you would rather remove the button, delete `#menu-btn` and `_openAppMenu` in `app.js`. **[Chromium]** open + navigation verified.

## Other fix found on the way
`closeModal()`'s 300 ms cleanup could blank a modal opened right after it (hit by progress → result dialogs). Fixed with a sequence guard.

## Test summary
| Suite | Result | Kind |
|---|---|---|
| `t1_update_repro.js` (original build) | stale-forever / stale-first-launch reproduced | [Chromium] |
| `t2_update_fix.js` | 13/13 pass (upgrade, 2nd upgrade, data survival, fresh install) | [Chromium] |
| `t3_features.js` | 55/55 pass, no page errors | [Chromium] |
| Native Java | compiles vs API 33 + androidx stubs | [compile] |

Test host note: the real `appassets.androidplatform.net` is unreachable in this sandbox, so tests ran on `appassets.localhost` (only the host string is rewritten in test copies; shipped files keep the real host).

## Not verified / needs your phone
Install over an existing install with a real APK; SAF folder grant + listing + persisted permission + revoke; native thumbnails; opening a device PDF end to end; saving images / backup / compressed PDF to Downloads; Android WebView specifics (memory on very large PDFs); versionCode / signature behaviour of your installer.

## Files
`www/` (drop-in, new: `features/files/device.js`, `core/zip.js`; changed: `app.js sw.js index.html core/ui.js core/constants.js features/{files,settings,tools}/*.js assets/css/main.css`), `native/MainActivity.java`, `native/DevicePdfs.java`, `native/MainActivity.patch`, `tests/`.

Stopping here as requested — no new feature phase started.
