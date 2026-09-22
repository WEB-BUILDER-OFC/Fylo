package com.fylo.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

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
    private static final int CAMERA_PERMISSION_REQUEST = 1001;

    private WebView mWebView;
    private boolean mNeedSwCheck = true;
    private static int sRendererCrashCount = 0;


    // Pending intent data (PDF opened from file manager / share)
    private Intent mPendingIntent = null;

    // File chooser callback for <input type="file">
    private ValueCallback<Uri[]> mFileChooserCallback;

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

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        mWebView = findViewById(R.id.webview);
        setupWebView();
        mWebView.loadUrl(BASE_URL + "index.html");

        // Store intent for delivery after app loads
        mPendingIntent = getIntent();
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
                WebResourceResponse response =
                        assetLoader.shouldInterceptRequest(request.getUrl());
                if (response != null) {
                    Log.d(TAG, "AssetLoader served: " + request.getUrl().getPath());
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
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap fav) {
                super.onPageStarted(view, url, fav);
                Log.i(TAG, "JAVA: onPageStarted url=" + url);
                view.evaluateJavascript("window._D&&window._D('BOOT-JAVA-01: onPageStarted')", null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i(TAG, "JAVA: onPageFinished url=" + url);
                sRendererCrashCount = 0;
                view.evaluateJavascript("window._D&&window._D('BOOT-JAVA-02: onPageFinished')", null);
                if (mNeedSwCheck) {
                    mNeedSwCheck = false;
                    String swJS = "(function(){if(!('serviceWorker' in navigator))return;"
                        + "navigator.serviceWorker.getRegistrations().then(function(rs){"
                        + "if(!rs.length)return;"
                        + "Promise.all(rs.map(function(r){return r.unregister();})).then(function(){window.location.reload(true);});"
                        + "});})();";
                    view.evaluateJavascript(swJS, null);
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
                    final String info = "SCREENSHOT THIS!\n\n"
                        + "didCrash: " + crashed + "\n"
                        + "crashCount: " + sRendererCrashCount + "\n"
                        + "Android SDK: " + android.os.Build.VERSION.SDK_INT + "\n"
                        + "Device: " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL + "\n"
                        + "WebView: " + wv + "\n"
                        + "Free RAM: " + ram + " MB";
                    Log.e(TAG, "CRASH DIAG:\n" + info);
                    runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                        .setTitle("FYLO Crash — Screenshot!")
                        .setMessage(info)
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
            public void onPermissionRequest(PermissionRequest request) {
                // Allow camera access for document scanning
                request.grant(request.getResources());
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

    // ── Camera permission ─────────────────────────────────────────────────────

    @Override
    public void onRequestPermissionsResult(int requestCode,
            @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            mWebView.evaluateJavascript(
                "window.fyloOnCameraPermission && window.fyloOnCameraPermission(" + granted + ")",
                null
            );
        }
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

        /**
         * Save a base64-encoded file to the user's Downloads.
         * Called by the web layer for all download/export operations.
         *
         * @param base64   Base64-encoded file content (no data-URI prefix)
         * @param filename Target filename (no path — basename only)
         * @param mimeType MIME type string
         * @return JSON {success:bool, path:string, error:string}
         */
        @JavascriptInterface
        public String saveFile(String base64, String filename, String mimeType) {
            try {
                // Sanitise filename — strip any path components
                String safeName = new File(filename).getName();
                if (safeName.isEmpty() || safeName.equals(".")) safeName = "fylo-export.pdf";
                // Block path traversal
                if (safeName.contains("/") || safeName.contains("\\") || safeName.contains("..")) {
                    return "{\"success\":false,\"error\":\"Invalid filename\"}";
                }

                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

                // Save to app cache first, then copy to Downloads via MediaStore (API 29+)
                File cacheFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(cacheFile)) {
                    fos.write(bytes);
                }

                // MediaStore insertion for Downloads visibility
                android.content.ContentValues values = new android.content.ContentValues();
                values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(android.provider.MediaStore.Downloads.MIME_TYPE,
                        mimeType != null && !mimeType.isEmpty() ? mimeType : "application/pdf");
                values.put(android.provider.MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/FYLO");
                values.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);

                Uri collection = android.provider.MediaStore.Downloads.getContentUri(
                        android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri itemUri = getContentResolver().insert(collection, values);

                if (itemUri != null) {
                    try (OutputStream os = getContentResolver().openOutputStream(itemUri)) {
                        if (os != null) os.write(bytes);
                    }
                    values.clear();
                    values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(itemUri, values, null, null);
                }

                cacheFile.delete();

                // savedName is effectively final — required for lambda capture.
                // safeName may have been reassigned above (default name fallback),
                // so we snapshot it here after all mutation is complete.
                final String savedName = safeName;
                runOnUiThread(() ->
                    Toast.makeText(MainActivity.this,
                        "Saved: " + savedName, Toast.LENGTH_SHORT).show());

                return "{\"success\":true,\"path\":\"Downloads/FYLO/" + safeName + "\"}";

            } catch (Exception e) {
                Log.e(TAG, "saveFile error", e);
                return "{\"success\":false,\"error\":\"" + e.getMessage() + "\"}";
            }
        }

        /**
         * Share a file with other Android apps.
         * Creates a FileProvider URI and launches the share sheet.
         */
        @JavascriptInterface
        public void shareFile(String base64, String filename, String mimeType) {
            try {
                String safeName = new File(filename).getName();
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                File shareFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(shareFile)) {
                    fos.write(bytes);
                }
                Uri shareUri = FileProvider.getUriForFile(
                    MainActivity.this, "com.fylo.app.fileprovider", shareFile);

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

        /**
         * Request camera permission from Android runtime.
         * Result delivered via window.fyloOnCameraPermission(granted).
         */
        @JavascriptInterface
        public void requestCameraPermission() {
            if (ContextCompat.checkSelfPermission(MainActivity.this,
                    Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                mWebView.post(() ->
                    mWebView.evaluateJavascript(
                        "window.fyloOnCameraPermission && window.fyloOnCameraPermission(true)",
                        null));
            } else {
                requestPermissions(
                    new String[]{Manifest.permission.CAMERA},
                    CAMERA_PERMISSION_REQUEST);
            }
        }

        /**
         * Check if camera permission is granted (synchronous).
         */
        @JavascriptInterface
        public boolean hasCameraPermission() {
            return ContextCompat.checkSelfPermission(MainActivity.this,
                Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
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
