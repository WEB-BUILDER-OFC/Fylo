package com.fylo.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Bundle;
import android.os.StatFs;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.app.AlertDialog;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * FYLO — MainActivity
 *
 * Hosts the FYLO web application in a hardened WebView.
 * Provides a narrow, type-safe JavaScript bridge for:
 *   - File reading (content:// URI → base64)
 *   - File saving (base64 → Downloads via MediaStore)
 *   - Camera permission
 *   - Share intent
 *
 * Web app entry point: https://appassets.androidplatform.net/assets/www/index.html
 * (served via WebViewAssetLoader — ES modules and IndexedDB require an http/s origin)
 *
 * Bridge security:
 *   - Only https://appassets.androidplatform.net/* URLs can call bridge methods
 *   - No shell execution, no arbitrary FS access, no reflection
 *   - All input validated before use
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "FYLO";
    // WebViewAssetLoader serves assets at this https:// origin.
    // The https:// scheme gives the page a proper origin, which is required for:
    //   - ES module imports  (type="module" is blocked on file://)
    //   - IndexedDB          (file:// origin causes silent hangs on some WebViews)
    //   - Service Workers    (require https or localhost)
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String BASE_URL   =
            "https://" + ASSET_HOST + "/assets/www/";

    private WebView mWebView;

    // ── Upgrade hygiene ───────────────────────────────────────────────────────
    // A service worker / Cache Storage entry created by an older build can keep serving the OLD web app
    // from cache even though the APK now bundles a newer one (the page is stale before any new code runs,
    // so only native code can fix it). After every install/update we therefore run a cleanup in the page and
    // only record it as done when the page confirms it (AndroidBridge.onWebCleanupDone). If the confirmation
    // never arrives (cleanup threw, WebView too old …) it is simply tried again on the next launch.
    private volatile boolean mNeedWebCleanup = false;
    private volatile boolean mReloadedForCleanup = false;     // loop guard: at most one forced reload per process
    private static final String PREFS = "fylo_native";
    private static final String PREF_WEB_CLEANED = "web_cleanup_stamp";
    private static int sRendererCrashCount = 0;

    // File saving (verified, chunked) and Storage Access Framework PDF browsing.
    private FileSaver mSaver;
    private SafPdfIndex mSaf;
    private final Map<String, AtomicBoolean> mScans = new ConcurrentHashMap<>();


    // Pending intent data (PDF opened from file manager / share)
    private Intent mPendingIntent = null;

    // File chooser callback for <input type="file">
    private ValueCallback<Uri[]> mFileChooserCallback;

    // Camera: a WebView getUserMedia() request that is waiting for the Android
    // runtime CAMERA permission dialog, plus a guard so only one dialog is ever in flight.
    private PermissionRequest mPendingWebPermission = null;
    private boolean mCameraPermissionInFlight = false;

    // Native runtime-permission launcher for CAMERA. Result resolves BOTH the pending
    // WebView request (getUserMedia) and the JS pre-flight callback (fyloOnCameraPermission).
    private final ActivityResultLauncher<String> mCameraPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(),
            granted -> onCameraPermissionResult(Boolean.TRUE.equals(granted)));

    // File picker launcher
    private final ActivityResultLauncher<String[]> mFilePicker =
        registerForActivityResult(new ActivityResultContracts.OpenMultipleDocuments(),
            uris -> {
                if (mFileChooserCallback == null) return;
                if (uris == null || uris.isEmpty()) {
                    mFileChooserCallback.onReceiveValue(null);
                } else {
                    mFileChooserCallback.onReceiveValue(uris.toArray(new Uri[0]));
                }
                mFileChooserCallback = null;
            });

    // Folder picker (Storage Access Framework). Requests a READ grant that can be persisted so the
    // folder is still available after the app restarts.
    private static final class PersistableTreeContract extends ActivityResultContracts.OpenDocumentTree {
        @NonNull
        @Override
        public Intent createIntent(@NonNull Context context, Uri input) {
            Intent i = super.createIntent(context, input);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            return i;
        }
    }

    private final ActivityResultLauncher<Uri> mFolderPicker =
        registerForActivityResult(new PersistableTreeContract(), this::onFolderPicked);

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        mSaver = new FileSaver(this);
        mSaf = new SafPdfIndex(this);

        mNeedWebCleanup = !installStamp().equals(
                getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_WEB_CLEANED, ""));

        mWebView = findViewById(R.id.webview);
        setupWebView();
        mWebView.loadUrl(BASE_URL + "index.html");

        // Store intent for delivery after app loads
        mPendingIntent = getIntent();
    }

    @Override
    protected void onDestroy() {
        if (mSaver != null) mSaver.abortAll();          // never leave half-written files behind
        for (AtomicBoolean cancel : mScans.values()) cancel.set(true);
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // App is already running — deliver immediately
        handleIncomingIntent(intent);
    }

    // ── WebView setup ─────────────────────────────────────────────────────────

    private void setupWebView() {
        // ── WebViewAssetLoader ─────────────────────────────────────────────────
        // Serves app/src/main/assets/** at https://appassets.androidplatform.net/
        // This gives the web layer a real https:// origin, which is required for:
        //   • ES modules  (type="module" is blocked by the browser on file://)
        //   • IndexedDB   (hangs silently on file:// in many WebView builds)
        //   • Service Workers (require https or localhost origin)
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                // Register /assets/ so AssetsPathHandler maps:
                //   /assets/www/index.html → app/src/main/assets/www/index.html
                //   /assets/www/app.js     → app/src/main/assets/www/app.js  etc.
                // The handler strips the registered prefix then looks up the remainder
                // under app/src/main/assets/ — so the prefix must be /assets/, NOT /assets/www/.
                .addPathHandler("/assets/", new AssetsPathHandler(this))
                .build();

        WebSettings settings = mWebView.getSettings();

        // Required for modern JS
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);  // FYLO manages its own zoom
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        WebView.setWebContentsDebuggingEnabled(false);
        // Note: setAllowFileAccessFromFileURLs / setAllowUniversalAccessFromFileURLs
        // are NOT set — they are insecure and unnecessary when using WebViewAssetLoader.

        // Add the JavaScript bridge — only accessible from our bundled https origin
        mWebView.addJavascriptInterface(new FyloBridge(), "AndroidBridge");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            mWebView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }

        // WebViewClientCompat — required to correctly support both shouldInterceptRequest
        // overloads across all WebView versions (androidx.webkit handles API differences).
        mWebView.setWebViewClient(new WebViewClientCompat() {

            /** Modern overload — used by WebView 21+ (API 21 = Android 5.0+). */
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                // PDFs from folders the user granted via the Storage Access Framework are streamed straight
                // to the page (fetch → Blob) instead of being base64-encoded through the JS bridge.
                Uri reqUri = request.getUrl();
                if (ASSET_HOST.equals(reqUri.getHost()) && "/saf/doc".equals(reqUri.getPath())) {
                    return serveSafDocument(reqUri);
                }
                WebResourceResponse response =
                        assetLoader.shouldInterceptRequest(request.getUrl());
                if (response != null) {
                    // Force text/javascript for all .js files.
                    // AssetsPathHandler delegates to MimeTypeMap, which on some Android
                    // versions does not have .js registered and falls back to text/plain.
                    // Browsers enforce strict MIME type checking for type="module" scripts
                    // and silently refuse to execute any module served as text/plain.
                    String path = request.getUrl().getPath();
                    if (path != null && (path.endsWith(".js") || path.endsWith(".mjs"))) {
                        return new WebResourceResponse(
                                "text/javascript", "utf-8", response.getData());
                    }
                }
                return response;
            }

            /** Deprecated String overload — required for compatibility on older WebViews. */
            @SuppressWarnings("deprecation")
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                WebResourceResponse response =
                        assetLoader.shouldInterceptRequest(android.net.Uri.parse(url));
                if (response != null && (url.endsWith(".js") || url.endsWith(".mjs"))) {
                    return new WebResourceResponse(
                            "text/javascript", "utf-8", response.getData());
                }
                return response;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Allow navigation within our asset bundle (https://appassets.*)
                if (url.startsWith("https://" + ASSET_HOST + "/")) {
                    return false;  // handled by shouldInterceptRequest
                }
                // External URLs — open in system browser, not in our WebView
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception e) {
                        Log.w(TAG, "Could not open external URL: " + url);
                    }
                    return true;
                }
                return true;  // Block everything else
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                sRendererCrashCount = 0;
                if (mNeedWebCleanup) {
                    // Runs inside the page. The result comes back through AndroidBridge.onWebCleanupDone().
                    // Only FYLO's own caches ("fylo-*") are touched — never IndexedDB, files, bookmarks or settings.
                    view.evaluateJavascript(
                        "(async function(){"
                        + "try{"
                        + "var changed=false;"
                        + "if('serviceWorker' in navigator){"
                        +   "var rs=await navigator.serviceWorker.getRegistrations();"
                        +   "for(var i=0;i<rs.length;i++){ if(await rs[i].unregister()) changed=true; }"
                        + "}"
                        + "if(window.caches){"
                        +   "var ks=await caches.keys();"
                        +   "for(var j=0;j<ks.length;j++){ if(ks[j].indexOf('fylo-')===0){ await caches.delete(ks[j]); changed=true; } }"
                        + "}"
                        + "AndroidBridge.onWebCleanupDone(changed);"
                        + "}catch(e){ AndroidBridge.onWebCleanupFailed(String(e&&e.message||e)); }"
                        + "})();", null);
                }
                if (mPendingIntent != null) {
                    final Intent intent = mPendingIntent;
                    mPendingIntent = null;
                    mWebView.postDelayed(() -> handleIncomingIntent(intent), 1000);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = detail.didCrash();
                Log.e(TAG, "RENDERER GONE: didCrash=" + crashed + " count=" + sRendererCrashCount);
                if (sRendererCrashCount >= 3) {
                    String wv = "unknown";
                    try {
                        android.content.pm.PackageInfo p =
                            WebViewCompat.getCurrentWebViewPackage(MainActivity.this);
                        if (p != null) wv = p.versionName + " (" + p.packageName + ")";
                    } catch (Exception e2) {}
                    long ram = -1;
                    try {
                        android.app.ActivityManager.MemoryInfo m =
                            new android.app.ActivityManager.MemoryInfo();
                        ((android.app.ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(m);
                        ram = m.availMem / 1048576;
                    } catch (Exception e3) {}
                    Log.e(TAG, "Renderer gone repeatedly: didCrash=" + crashed
                        + " count=" + sRendererCrashCount
                        + " sdk=" + android.os.Build.VERSION.SDK_INT
                        + " device=" + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL
                        + " webview=" + wv + " freeRamMb=" + ram);
                    runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                        .setTitle("FYLO stopped unexpectedly")
                        .setMessage("The app's view stopped several times in a row. Tap Retry to reload.")
                        .setPositiveButton("Retry", (d, w) -> { sRendererCrashCount = 0; recreate(); })
                        .setNegativeButton("Close", null)
                        .setCancelable(false).show());
                    return true;
                }
                sRendererCrashCount++;
                recreate();
                return true;
            }
        });

        // WebChromeClient — camera permissions and file chooser
        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // getUserMedia() lands here. WebView permission != Android permission:
                // the app must also hold the runtime CAMERA permission, otherwise the
                // grant below is useless and the system dialog never appears.
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (mPendingWebPermission == request) mPendingWebPermission = null;
            }

            @Override
            public boolean onShowFileChooser(WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                // Cancel any previous callback
                if (mFileChooserCallback != null) {
                    mFileChooserCallback.onReceiveValue(null);
                }
                mFileChooserCallback = filePathCallback;
                // Launch the native file picker
                String[] mimeTypes = fileChooserParams.getAcceptTypes();
                if (mimeTypes == null || mimeTypes.length == 0) {
                    mimeTypes = new String[]{"application/pdf", "image/*"};
                }
                try {
                    mFilePicker.launch(mimeTypes);
                } catch (Exception e) {
                    mFileChooserCallback.onReceiveValue(null);
                    mFileChooserCallback = null;
                }
                return true;
            }
        });

        // Enable WebView debugging in debug builds
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /**
     * Identifies the installed build. Changes on every update (versionCode) and on every re-install of the
     * same version (lastUpdateTime), so stale web caches are never trusted across either.
     */
    private String installStamp() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionCode + ":" + p.lastUpdateTime;
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** Only URIs FYLO created itself (MediaStore items it inserted, or its FileProvider) may be shared/opened. */
    private boolean isOwnSavedUri(Uri u) {
        if (u == null || !"content".equals(u.getScheme())) return false;
        String a = u.getAuthority();
        return "media".equals(a) || (getPackageName() + ".fileprovider").equals(a);
    }

    /** Serves a document from a user-granted folder to the page; 403 for anything outside those folders. */
    private WebResourceResponse serveSafDocument(Uri req) {
        try {
            String s = req.getQueryParameter("u");
            if (s == null || s.isEmpty()) return httpError(400, "Bad Request");
            Uri doc = Uri.parse(s);
            if (!mSaf.isUnderGrantedRoot(doc)) return httpError(403, "Forbidden");
            AssetFileDescriptor afd = getContentResolver().openAssetFileDescriptor(doc, "r");
            if (afd == null) return httpError(404, "Not Found");
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            long len = afd.getLength();
            if (len >= 0) headers.put("Content-Length", Long.toString(len));
            return new WebResourceResponse("application/pdf", null, 200, "OK", headers, afd.createInputStream());
        } catch (SecurityException e) {
            return httpError(403, "Forbidden");
        } catch (FileNotFoundException e) {
            return httpError(404, "Not Found");
        } catch (Exception e) {
            Log.e(TAG, "serveSafDocument failed", e);
            return httpError(500, "Read Error");
        }
    }

    private static WebResourceResponse httpError(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    /** Delivers a native result to the page: window.fyloNativeResult(id, jsonString). */
    private void postToWeb(String id, String json) {
        final String js = "window.fyloNativeResult&&window.fyloNativeResult("
                + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        runOnUiThread(() -> { if (mWebView != null) mWebView.evaluateJavascript(js, null); });
    }

    /** Result of the folder picker. */
    private void onFolderPicked(Uri tree) {
        String json;
        try {
            if (tree == null) {
                json = FileSaver.json("ok", false, "cancelled", true);
            } else {
                JSONObject folder = mSaf.addRoot(tree);
                json = FileSaver.json("ok", true, "folder", folder);
            }
        } catch (Exception e) {
            Log.e(TAG, "onFolderPicked failed", e);
            json = FileSaver.json("ok", false, "error", FileSaver.describe(e));
        }
        postToWeb("folderPicked", json);
    }

    // ── Camera permission ─────────────────────────────────────────────────────

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Runs on the UI thread. Grants the WebView request, asking Android for CAMERA first if needed. */
    private void handleWebPermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        // Only our own bundled origin may use the camera.
        if (origin == null || !ASSET_HOST.equals(origin.getHost())) {
            request.deny();
            return;
        }
        boolean wantsVideo = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsVideo = true;
        }
        if (!wantsVideo) {            // FYLO only ever needs video (getUserMedia audio:false)
            request.deny();
            return;
        }
        if (hasCameraPermission()) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        if (mPendingWebPermission != null && mPendingWebPermission != request) {
            mPendingWebPermission.deny();   // superseded by the newer request
        }
        mPendingWebPermission = request;
        launchCameraPermissionDialog();
    }

    /** Shows the native "Allow FYLO to take pictures and record video?" dialog (once at a time). */
    private void launchCameraPermissionDialog() {
        if (mCameraPermissionInFlight) return;   // result callback will resolve everything waiting
        mCameraPermissionInFlight = true;
        try {
            mCameraPermissionLauncher.launch(Manifest.permission.CAMERA);
        } catch (Exception e) {
            Log.e(TAG, "Could not launch camera permission dialog", e);
            onCameraPermissionResult(false);
        }
    }

    /** Result of the native CAMERA dialog. Resolves the pending getUserMedia() and the JS pre-flight. */
    private void onCameraPermissionResult(boolean granted) {
        mCameraPermissionInFlight = false;
        PermissionRequest req = mPendingWebPermission;
        mPendingWebPermission = null;
        if (req != null) {
            try {
                if (granted) req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                else req.deny();
            } catch (Exception e) {
                Log.w(TAG, "WebView permission request no longer valid", e);
            }
        }
        if (mWebView != null) {
            mWebView.evaluateJavascript(
                "window.fyloOnCameraPermission && window.fyloOnCameraPermission(" + granted + ")",
                null);
        }
    }

    // ── Intent handling ───────────────────────────────────────────────────────

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        try {
            if (Intent.ACTION_VIEW.equals(action)) {
                // Single PDF opened via "Open with"
                Uri uri = intent.getData();
                if (uri != null) deliverUriToWeb(uri);

            } else if (Intent.ACTION_SEND.equals(action)) {
                // Single file shared to FYLO
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) deliverUriToWeb(uri);

            } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                // Multiple files shared to FYLO
                ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (uris != null) {
                    for (Uri uri : uris) deliverUriToWeb(uri);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling intent", e);
        }
    }

    /**
     * Reads a URI (content:// or file://) into base64 and delivers it to the
     * web app via the files:incoming bus event.
     */
    private void deliverUriToWeb(Uri uri) {
        new Thread(() -> {
            try {
                ContentResolver cr = getContentResolver();
                String mimeType = cr.getType(uri);
                String filename  = UriUtils.getFileName(MainActivity.this, uri);
                if (filename == null) filename = "document.pdf";

                // Read the file
                byte[] bytes = readUri(uri);
                if (bytes == null) {
                    Log.e(TAG, "Failed to read URI: " + uri);
                    return;
                }

                String b64  = Base64.encodeToString(bytes, Base64.NO_WRAP);
                String mime = (mimeType != null) ? mimeType : "application/pdf";
                String fname = filename.replace("'", "\\'");

                // Call into web app on UI thread
                final String js = "javascript:(function(){"
                    + "try {"
                    + "  var b64='" + b64 + "';"
                    + "  var mime='" + mime + "';"
                    + "  var name='" + fname + "';"
                    + "  var bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));"
                    + "  var blob=new Blob([bytes],{type:mime});"
                    + "  var file=new File([blob],name,{type:mime});"
                    + "  window.fyloEventBus&&window.fyloEventBus.emit('files:incoming',{files:[file]});"
                    + "} catch(e) { console.error('Bridge deliverUri error:',e); }"
                    + "})();";

                runOnUiThread(() -> mWebView.evaluateJavascript(js, null));

            } catch (Exception e) {
                Log.e(TAG, "deliverUriToWeb error", e);
            }
        }).start();
    }

    private byte[] readUri(Uri uri) {
        try (InputStream is = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            if (is == null) return null;
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Exception e) {
            Log.e(TAG, "readUri error", e);
            return null;
        }
    }

    // ── Android Back Button ───────────────────────────────────────────────────

    @Override
    public void onBackPressed() {
        // Ask web layer to handle back first
        mWebView.evaluateJavascript(
            "window.fyloHandleBack && window.fyloHandleBack()",
            result -> {
                if (!"true".equals(result)) {
                    // Web layer didn't consume it — standard back
                    finish();
                }
            }
        );
    }

    // ── JavaScript Bridge ─────────────────────────────────────────────────────

    /**
     * FyloBridge — the ONLY JavaScript interface exposed to the WebView.
     *
     * Security model:
     *   - All methods are annotated @JavascriptInterface
     *   - Input is validated / sanitised before use
     *   - No shell execution, no arbitrary file access
     *   - File saves go to app-private Downloads cache, then MediaStore
     *   - Camera permission goes through Android runtime permission flow
     */
    private class FyloBridge {

        // ── App / update info ─────────────────────────────────────────────────

        /** {versionName, versionCode, lastUpdateTime, packageName, sdk} — shows which build is really running. */
        @JavascriptInterface
        public String getAppInfo() {
            try {
                PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                return FileSaver.json("versionName", p.versionName, "versionCode", p.versionCode,
                        "lastUpdateTime", p.lastUpdateTime, "packageName", getPackageName(),
                        "sdk", android.os.Build.VERSION.SDK_INT);
            } catch (Exception e) {
                return FileSaver.json("error", FileSaver.describe(e));
            }
        }

        /** Called by the cleanup script injected after an install/update (see onPageFinished). */
        @JavascriptInterface
        public void onWebCleanupDone(boolean changed) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_WEB_CLEANED, installStamp()).apply();
            mNeedWebCleanup = false;
            if (changed && !mReloadedForCleanup) {
                // Stale caches were just removed: reload so the page is served from the APK's assets.
                mReloadedForCleanup = true;
                runOnUiThread(() -> {
                    mWebView.clearCache(true);
                    mWebView.reload();
                });
            }
        }

        @JavascriptInterface
        public void onWebCleanupFailed(String reason) {
            Log.w(TAG, "Web cleanup failed (will be retried on next launch): " + reason);
        }

        // ── Saving files (chunked + verified; see FileSaver) ──────────────────

        /** kind: "download" (Download/FYLO) or "image" (Pictures/FYLO). Returns {ok, id} or {ok:false, error}. */
        @JavascriptInterface
        public String saveBegin(String kind, String subdir, String filename, String mimeType) {
            return mSaver.begin(kind, subdir, filename, mimeType);
        }

        @JavascriptInterface
        public String saveChunk(String id, String base64) {
            return mSaver.chunk(id, base64);
        }

        /** Returns {ok, name, path, uri, bytes}; ok is true only after the written size was read back and matched. */
        @JavascriptInterface
        public String saveEnd(String id) {
            return mSaver.end(id);
        }

        @JavascriptInterface
        public void saveAbort(String id) {
            mSaver.abort(id);
        }

        /** One-shot save for small files. Same verification and result format as saveEnd. */
        @JavascriptInterface
        public String saveFile(String base64, String filename, String mimeType) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                return mSaver.saveAll(bytes, "download", "", filename, mimeType);
            } catch (Exception e) {
                Log.e(TAG, "saveFile error", e);
                return FileSaver.json("ok", false, "error", FileSaver.describe(e));
            }
        }

        /** Free bytes on the app's storage volume, or -1 if unknown. Used to refuse exports that cannot fit. */
        @JavascriptInterface
        public long getFreeSpaceBytes() {
            try {
                return new StatFs(getFilesDir().getAbsolutePath()).getAvailableBytes();
            } catch (Exception e) {
                return -1L;
            }
        }

        /**
         * Removes disposable data only: temporary share files in the app cache and the WebView's HTTP cache.
         * Never touches IndexedDB (PDFs, bookmarks, settings), files saved to Downloads/Pictures, or folder grants.
         */
        @JavascriptInterface
        public String clearNativeCache() {
            long freed = 0L;
            File[] files = getCacheDir().listFiles();
            if (files != null) {
                for (File f : files) {
                    // Only plain files: sub-directories belong to the WebView's own disk cache.
                    if (f.isFile()) {
                        long len = f.length();
                        if (f.delete()) freed += len;
                    }
                }
            }
            runOnUiThread(() -> { if (mWebView != null) mWebView.clearCache(true); });
            return FileSaver.json("ok", true, "freedBytes", freed);
        }

        // ── Sharing / viewing saved results ───────────────────────────────────

        /** Share a file the page just generated (written to the app cache, handed over via FileProvider). */
        @JavascriptInterface
        public void shareFile(String base64, String filename, String mimeType) {
            try {
                String safeName = FileSaver.safeName(filename, "fylo-share.pdf");
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                File shareFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(shareFile)) {
                    fos.write(bytes);
                }
                Uri shareUri = FileProvider.getUriForFile(
                    MainActivity.this, getPackageName() + ".fileprovider", shareFile);

                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType(mimeType != null ? mimeType : "application/pdf");
                shareIntent.putExtra(Intent.EXTRA_STREAM, shareUri);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() ->
                    startActivity(Intent.createChooser(shareIntent, "Share via")));

            } catch (Exception e) {
                Log.e(TAG, "shareFile error", e);
            }
        }

        /** Share files FYLO itself saved (URIs returned by saveEnd). Returns false if nothing could be shared. */
        @JavascriptInterface
        public boolean shareUris(String jsonArray, String mimeType) {
            try {
                JSONArray arr = new JSONArray(jsonArray);
                ArrayList<Uri> uris = new ArrayList<>();
                for (int i = 0; i < arr.length(); i++) {
                    Uri u = Uri.parse(arr.getString(i));
                    if (isOwnSavedUri(u)) uris.add(u);
                }
                if (uris.isEmpty()) return false;
                final Intent send = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
                send.setType(mimeType != null && !mimeType.isEmpty() ? mimeType : "*/*");
                if (uris.size() == 1) {
                    send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                } else {
                    send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                }
                ClipData clip = ClipData.newRawUri("FYLO", uris.get(0));
                for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                send.setClipData(clip);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Share via")));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "shareUris error", e);
                return false;
            }
        }

        /** Open a file FYLO saved in another app (e.g. Gallery for an image). Returns false if no app can open it. */
        @JavascriptInterface
        public boolean viewUri(String uri, String mimeType) {
            try {
                Uri u = Uri.parse(uri);
                if (!isOwnSavedUri(u)) return false;
                final Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(u, mimeType != null && !mimeType.isEmpty() ? mimeType : "*/*");
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (view.resolveActivity(getPackageManager()) == null) return false;
                runOnUiThread(() -> startActivity(view));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "viewUri error", e);
                return false;
            }
        }

        // ── On-device PDF browsing (Storage Access Framework) ─────────────────

        /** Opens the system folder picker. Result: window.fyloNativeResult("folderPicked", json). */
        @JavascriptInterface
        public void pickPdfFolder() {
            runOnUiThread(() -> {
                try {
                    mFolderPicker.launch(null);
                } catch (Exception e) {
                    postToWeb("folderPicked", FileSaver.json("ok", false, "error", FileSaver.describe(e)));
                }
            });
        }

        /** JSON array of {uri, name, accessible} for the folders the user granted. */
        @JavascriptInterface
        public String getPdfFolders() {
            return mSaf.foldersJson().toString();
        }

        @JavascriptInterface
        public void removePdfFolder(String treeUri) {
            if (treeUri != null) mSaf.removeRoot(treeUri);
        }

        /** Lists PDFs under a granted folder in the background. Result: window.fyloNativeResult(requestId, json). */
        @JavascriptInterface
        public void listPdfs(final String requestId, final String treeUri) {
            if (requestId == null || treeUri == null) return;
            final AtomicBoolean cancel = new AtomicBoolean(false);
            mScans.put(requestId, cancel);
            new Thread(() -> {
                String json;
                try {
                    json = mSaf.listPdfs(Uri.parse(treeUri), cancel).toString();
                } catch (Exception e) {
                    json = FileSaver.json("ok", false, "error", "ERROR", "message", FileSaver.describe(e));
                }
                mScans.remove(requestId);
                postToWeb(requestId, json);
            }, "fylo-pdf-scan").start();
        }

        @JavascriptInterface
        public void cancelScan(String requestId) {
            AtomicBoolean c = requestId == null ? null : mScans.get(requestId);
            if (c != null) c.set(true);
        }

        /**
         * Request camera permission from Android runtime.
         * Result delivered via window.fyloOnCameraPermission(granted).
         */
        @JavascriptInterface
        public void requestCameraPermission() {
            // Bridge methods run on a WebView background thread; dialogs must start on the UI thread.
            runOnUiThread(() -> {
                if (hasCameraPermission()) {
                    mWebView.evaluateJavascript(
                        "window.fyloOnCameraPermission && window.fyloOnCameraPermission(true)",
                        null);
                } else {
                    launchCameraPermissionDialog();
                }
            });
        }

        /**
         * Check if camera permission is granted (synchronous).
         */
        @JavascriptInterface
        public boolean hasCameraPermission() {
            return MainActivity.this.hasCameraPermission();
        }

        /**
         * Open the native file picker.
         * Selected files are delivered via the WebChromeClient.onShowFileChooser path.
         * This method is a fallback for programmatic invocation when the input
         * element click doesn't trigger the chooser.
         */
        @JavascriptInterface
        public void openFilePicker(String mimeTypesCsv) {
            String[] mimes = (mimeTypesCsv != null && !mimeTypesCsv.isEmpty())
                ? mimeTypesCsv.split(",")
                : new String[]{"application/pdf"};
            runOnUiThread(() -> mFilePicker.launch(mimes));
        }

        /**
         * Show a native toast message.
         */
        @JavascriptInterface
        public void showToast(String message) {
            if (message == null || message.length() > 200) return;
            runOnUiThread(() ->
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }

        /**
         * Returns "android" — lets web JS detect the native environment.
         */
        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        /**
         * Returns the Android version as a string.
         */
        @JavascriptInterface
        public String getAndroidVersion() {
            return String.valueOf(android.os.Build.VERSION.SDK_INT);
        }
    }

    // ── Event Bus exposure ────────────────────────────────────────────────────

    /**
     * Exposes the FYLO event bus on window.fyloEventBus so the native layer
     * can emit events into the web application.
     * Called from the web app's app.js after the bus is initialized.
     */
    // This is called FROM JavaScript: window.fyloEventBus = bus;
    // We don't need to do anything here — the web JS sets it up.
}
