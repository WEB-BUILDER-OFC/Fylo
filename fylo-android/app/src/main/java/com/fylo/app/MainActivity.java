package com.fylo.app;

import android.app.ActivityManager;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.os.EnvironmentCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import com.fylo.app.MainActivity;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import java.util.Iterator;
import java.util.List;

/* loaded from: classes3.dex */
public class MainActivity extends AppCompatActivity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String BASE_URL = "https://appassets.androidplatform.net/assets/www/";
    private static final String PREFS = "fylo_native";
    private static final String PREF_SW_CLEANED = "sw_cleaned_for_install";
    private static final String TAG = "FYLO";
    private static int sRendererCrashCount = 0;
    private ValueCallback<Uri[]> mFileChooserCallback;
    private WebView mWebView;
    private boolean mNeedSwCheck = false;
    private Intent mPendingIntent = null;
    private PermissionRequest mPendingWebPermission = null;
    private boolean mCameraPermissionInFlight = false;

    // ── Device PDFs (granted folders + FYLO's own downloads; see DevicePdfs) ──
    private volatile Map<String, Uri> mDeviceRegistry = new HashMap<>();   // id -> content URI, only ids from the last scan
    private final AtomicBoolean mScanRunning = new AtomicBoolean(false);
    private final ExecutorService mScanIo = Executors.newSingleThreadExecutor();
    private final ExecutorService mThumbIo = Executors.newSingleThreadExecutor();
    private final ActivityResultLauncher<Uri> mFolderPicker = registerForActivityResult(new ActivityResultContracts.OpenDocumentTree(), new ActivityResultCallback<Uri>() {
        @Override
        public void onActivityResult(Uri uri) {
            boolean ok = false;
            String msg = "cancelled";
            if (uri != null) {
                ok = DevicePdfs.persistTree(MainActivity.this, uri);
                msg = ok ? "granted" : "failed";
            }
            callJs("window.fyloOnDeviceFolderPicked&&window.fyloOnDeviceFolderPicked(" + ok + "," + JSONObject.quote(msg) + ")");
        }
    });
    private final ActivityResultLauncher<String> mCameraPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestPermission(), new ActivityResultCallback() { // from class: com.fylo.app.MainActivity$$ExternalSyntheticLambda3
        @Override // androidx.activity.result.ActivityResultCallback
        public final void onActivityResult(Object obj) {
            MainActivity.this.lambda$new$0((Boolean) obj);
        }
    });
    private final ActivityResultLauncher<String[]> mFilePicker = registerForActivityResult(new ActivityResultContracts.OpenMultipleDocuments(), new ActivityResultCallback() { // from class: com.fylo.app.MainActivity$$ExternalSyntheticLambda4
        @Override // androidx.activity.result.ActivityResultCallback
        public final void onActivityResult(Object obj) {
            MainActivity.this.lambda$new$1((List) obj);
        }
    });

    /* JADX INFO: Access modifiers changed from: private */
    public /* synthetic */ void lambda$new$0(Boolean granted) {
        onCameraPermissionResult(Boolean.TRUE.equals(granted));
    }

    /* JADX INFO: Access modifiers changed from: private */
    public /* synthetic */ void lambda$new$1(List uris) {
        if (this.mFileChooserCallback == null) {
            return;
        }
        if (uris == null || uris.isEmpty()) {
            this.mFileChooserCallback.onReceiveValue(null);
        } else {
            this.mFileChooserCallback.onReceiveValue((Uri[]) uris.toArray(new Uri[0]));
        }
        this.mFileChooserCallback = null;
    }

    @Override // androidx.fragment.app.FragmentActivity, androidx.activity.ComponentActivity, androidx.core.app.ComponentActivity, android.app.Activity
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        this.mNeedSwCheck = getSharedPreferences(PREFS, 0).getLong(PREF_SW_CLEANED, -1L) != installStamp();
        this.mWebView = (WebView) findViewById(R.id.webview);
        setupWebView();
        this.mWebView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
        this.mPendingIntent = getIntent();
    }

    @Override // androidx.fragment.app.FragmentActivity, androidx.activity.ComponentActivity, android.app.Activity
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void setupWebView() {
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder().setDomain("appassets.androidplatform.net").addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).addPathHandler("/device/", new DeviceFileHandler()).build();
        WebSettings settings = this.mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setCacheMode(-1);
        settings.setSafeBrowsingEnabled(false);
        WebView.setWebContentsDebuggingEnabled(false);
        this.mWebView.addJavascriptInterface(new FyloBridge(), "AndroidBridge");
        this.mWebView.setRendererPriorityPolicy(2, true);
        this.mWebView.setWebViewClient(new AnonymousClass1(assetLoader));
        this.mWebView.setWebChromeClient(new AnonymousClass2());
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /* renamed from: com.fylo.app.MainActivity$1, reason: invalid class name */
    class AnonymousClass1 extends WebViewClientCompat {
        final /* synthetic */ WebViewAssetLoader val$assetLoader;

        AnonymousClass1(WebViewAssetLoader webViewAssetLoader) {
            this.val$assetLoader = webViewAssetLoader;
        }

        @Override // android.webkit.WebViewClient
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String path;
            WebResourceResponse response = this.val$assetLoader.shouldInterceptRequest(request.getUrl());
            if (response != null && (path = request.getUrl().getPath()) != null && (path.endsWith(".js") || path.endsWith(".mjs"))) {
                return new WebResourceResponse("text/javascript", "utf-8", response.getData());
            }
            return response;
        }

        @Override // android.webkit.WebViewClient
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            WebResourceResponse response = this.val$assetLoader.shouldInterceptRequest(Uri.parse(url));
            if (response != null && (url.endsWith(".js") || url.endsWith(".mjs"))) {
                return new WebResourceResponse("text/javascript", "utf-8", response.getData());
            }
            return response;
        }

        @Override // androidx.webkit.WebViewClientCompat, android.webkit.WebViewClient, org.chromium.support_lib_boundary.WebViewClientBoundaryInterface
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith("https://appassets.androidplatform.net/")) {
                return false;
            }
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                return true;
            }
            try {
                MainActivity.this.startActivity(new Intent("android.intent.action.VIEW", Uri.parse(url)));
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Could not open external URL: " + url);
            }
            return true;
        }

        @Override // android.webkit.WebViewClient
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            MainActivity.sRendererCrashCount = 0;
            if (MainActivity.this.mNeedSwCheck) {
                MainActivity.this.mNeedSwCheck = false;
                MainActivity.this.getSharedPreferences(MainActivity.PREFS, 0).edit().putLong(MainActivity.PREF_SW_CLEANED, MainActivity.this.installStamp()).apply();
                view.evaluateJavascript("(function(){if(!('serviceWorker' in navigator))return;navigator.serviceWorker.getRegistrations().then(function(rs){if(!rs.length)return;Promise.all(rs.map(function(r){return r.unregister();})).then(function(){window.location.reload(true);});});})();", null);
            }
            if (MainActivity.this.mPendingIntent != null) {
                final Intent intent = MainActivity.this.mPendingIntent;
                MainActivity.this.mPendingIntent = null;
                MainActivity.this.mWebView.postDelayed(new Runnable() { // from class: com.fylo.app.MainActivity$1$$ExternalSyntheticLambda2
                    @Override // java.lang.Runnable
                    public final void run() {
                        MainActivity.AnonymousClass1.this.lambda$onPageFinished$0(intent);
                    }
                }, 1000L);
            }
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$onPageFinished$0(Intent intent) {
            MainActivity.this.handleIncomingIntent(intent);
        }

        @Override // android.webkit.WebViewClient
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail.didCrash();
            Log.e(MainActivity.TAG, "RENDERER GONE: didCrash=" + crashed + " count=" + MainActivity.sRendererCrashCount);
            if (MainActivity.sRendererCrashCount >= 3) {
                String wv = EnvironmentCompat.MEDIA_UNKNOWN;
                try {
                    PackageInfo p = WebViewCompat.getCurrentWebViewPackage(MainActivity.this);
                    if (p != null) {
                        wv = p.versionName + " (" + p.packageName + ")";
                    }
                } catch (Exception e) {
                }
                long ram = -1;
                try {
                    ActivityManager.MemoryInfo m = new ActivityManager.MemoryInfo();
                    ((ActivityManager) MainActivity.this.getSystemService("activity")).getMemoryInfo(m);
                    ram = m.availMem / 1048576;
                } catch (Exception e2) {
                }
                Log.e(MainActivity.TAG, "Renderer gone repeatedly: didCrash=" + crashed + " count=" + MainActivity.sRendererCrashCount + " sdk=" + Build.VERSION.SDK_INT + " device=" + Build.MANUFACTURER + " " + Build.MODEL + " webview=" + wv + " freeRamMb=" + ram);
                MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$1$$ExternalSyntheticLambda0
                    @Override // java.lang.Runnable
                    public final void run() {
                        MainActivity.AnonymousClass1.this.lambda$onRenderProcessGone$2();
                    }
                });
                return true;
            }
            MainActivity.sRendererCrashCount++;
            MainActivity.this.recreate();
            return true;
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$onRenderProcessGone$2() {
            new AlertDialog.Builder(MainActivity.this).setTitle("FYLO stopped unexpectedly").setMessage("The app's view stopped several times in a row. Tap Retry to reload.").setPositiveButton("Retry", new DialogInterface.OnClickListener() { // from class: com.fylo.app.MainActivity$1$$ExternalSyntheticLambda1
                @Override // android.content.DialogInterface.OnClickListener
                public final void onClick(DialogInterface dialogInterface, int i) {
                    MainActivity.AnonymousClass1.this.lambda$onRenderProcessGone$1(dialogInterface, i);
                }
            }).setNegativeButton("Close", (DialogInterface.OnClickListener) null).setCancelable(false).show();
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$onRenderProcessGone$1(DialogInterface d, int w) {
            MainActivity.sRendererCrashCount = 0;
            MainActivity.this.recreate();
        }
    }

    /* renamed from: com.fylo.app.MainActivity$2, reason: invalid class name */
    class AnonymousClass2 extends WebChromeClient {
        AnonymousClass2() {
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$onPermissionRequest$0(PermissionRequest request) {
            MainActivity.this.handleWebPermissionRequest(request);
        }

        @Override // android.webkit.WebChromeClient
        public void onPermissionRequest(final PermissionRequest request) {
            MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$2$$ExternalSyntheticLambda0
                @Override // java.lang.Runnable
                public final void run() {
                    MainActivity.AnonymousClass2.this.lambda$onPermissionRequest$0(request);
                }
            });
        }

        @Override // android.webkit.WebChromeClient
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (MainActivity.this.mPendingWebPermission == request) {
                MainActivity.this.mPendingWebPermission = null;
            }
        }

        @Override // android.webkit.WebChromeClient
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, WebChromeClient.FileChooserParams fileChooserParams) {
            if (MainActivity.this.mFileChooserCallback != null) {
                MainActivity.this.mFileChooserCallback.onReceiveValue(null);
            }
            MainActivity.this.mFileChooserCallback = filePathCallback;
            String[] mimeTypes = fileChooserParams.getAcceptTypes();
            if (mimeTypes == null || mimeTypes.length == 0) {
                mimeTypes = new String[]{"application/pdf", "image/*"};
            }
            try {
                MainActivity.this.mFilePicker.launch(mimeTypes);
                return true;
            } catch (Exception e) {
                MainActivity.this.mFileChooserCallback.onReceiveValue(null);
                MainActivity.this.mFileChooserCallback = null;
                return true;
            }
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public long installStamp() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        } catch (Exception e) {
            return -1L;
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this, "android.permission.CAMERA") == 0;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void handleWebPermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !"appassets.androidplatform.net".equals(origin.getHost())) {
            request.deny();
            return;
        }
        boolean wantsVideo = false;
        for (String r : request.getResources()) {
            if ("android.webkit.resource.VIDEO_CAPTURE".equals(r)) {
                wantsVideo = true;
            }
        }
        if (!wantsVideo) {
            request.deny();
            return;
        }
        if (hasCameraPermission()) {
            request.grant(new String[]{"android.webkit.resource.VIDEO_CAPTURE"});
            return;
        }
        if (this.mPendingWebPermission != null && this.mPendingWebPermission != request) {
            this.mPendingWebPermission.deny();
        }
        this.mPendingWebPermission = request;
        launchCameraPermissionDialog();
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void launchCameraPermissionDialog() {
        if (this.mCameraPermissionInFlight) {
            return;
        }
        this.mCameraPermissionInFlight = true;
        try {
            this.mCameraPermissionLauncher.launch("android.permission.CAMERA");
        } catch (Exception e) {
            Log.e(TAG, "Could not launch camera permission dialog", e);
            onCameraPermissionResult(false);
        }
    }

    private void onCameraPermissionResult(boolean granted) {
        this.mCameraPermissionInFlight = false;
        PermissionRequest req = this.mPendingWebPermission;
        this.mPendingWebPermission = null;
        if (req != null) {
            try {
                if (granted) {
                    req.grant(new String[]{"android.webkit.resource.VIDEO_CAPTURE"});
                } else {
                    req.deny();
                }
            } catch (Exception e) {
                Log.w(TAG, "WebView permission request no longer valid", e);
            }
        }
        if (this.mWebView != null) {
            this.mWebView.evaluateJavascript("window.fyloOnCameraPermission && window.fyloOnCameraPermission(" + granted + ")", null);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void handleIncomingIntent(Intent intent) {
        String action;
        ArrayList<Uri> uris;
        if (intent == null || (action = intent.getAction()) == null) {
            return;
        }
        try {
            if ("android.intent.action.VIEW".equals(action)) {
                Uri uri = intent.getData();
                if (uri != null) {
                    deliverUriToWeb(uri);
                }
            } else {
                if ("android.intent.action.SEND".equals(action)) {
                    Uri uri2 = (Uri) intent.getParcelableExtra("android.intent.extra.STREAM");
                    if (uri2 != null) {
                        deliverUriToWeb(uri2);
                        return;
                    }
                    return;
                }
                if ("android.intent.action.SEND_MULTIPLE".equals(action) && (uris = intent.getParcelableArrayListExtra("android.intent.extra.STREAM")) != null) {
                    Iterator<Uri> it = uris.iterator();
                    while (it.hasNext()) {
                        deliverUriToWeb(it.next());
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling intent", e);
        }
    }

    private void deliverUriToWeb(final Uri uri) {
        new Thread(new Runnable() { // from class: com.fylo.app.MainActivity$$ExternalSyntheticLambda0
            @Override // java.lang.Runnable
            public final void run() {
                MainActivity.this.lambda$deliverUriToWeb$3(uri);
            }
        }).start();
    }

    /* JADX INFO: Access modifiers changed from: private */
    public /* synthetic */ void lambda$deliverUriToWeb$3(Uri uri) {
        try {
            ContentResolver cr = getContentResolver();
            String mimeType = cr.getType(uri);
            String filename = UriUtils.getFileName(this, uri);
            if (filename == null) {
                filename = "document.pdf";
            }
            byte[] bytes = readUri(uri);
            if (bytes == null) {
                Log.e(TAG, "Failed to read URI: " + uri);
                return;
            }
            String b64 = Base64.encodeToString(bytes, 2);
            String mime = mimeType != null ? mimeType : "application/pdf";
            String fname = filename.replace("'", "\\'");
            final String js = "javascript:(function(){try {  var b64='" + b64 + "';  var mime='" + mime + "';  var name='" + fname + "';  var bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));  var blob=new Blob([bytes],{type:mime});  var file=new File([blob],name,{type:mime});  window.fyloEventBus&&window.fyloEventBus.emit('files:incoming',{files:[file]});} catch(e) { console.error('Bridge deliverUri error:',e); }})();";
            runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$$ExternalSyntheticLambda1
                @Override // java.lang.Runnable
                public final void run() {
                    MainActivity.this.lambda$deliverUriToWeb$2(js);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "deliverUriToWeb error", e);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public /* synthetic */ void lambda$deliverUriToWeb$2(String js) {
        this.mWebView.evaluateJavascript(js, null);
    }

    private byte[] readUri(Uri uri) {
        try {
            InputStream is = getContentResolver().openInputStream(uri);
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                if (is != null) {
                    try {
                        byte[] buf = new byte[8192];
                        while (true) {
                            int n = is.read(buf);
                            if (n == -1) {
                                break;
                            }
                            bos.write(buf, 0, n);
                        }
                        byte[] byteArray = bos.toByteArray();
                        bos.close();
                        if (is != null) {
                            is.close();
                        }
                        return byteArray;
                    } finally {
                    }
                }
                bos.close();
                if (is != null) {
                    is.close();
                }
                return null;
            } finally {
            }
        } catch (Exception e) {
            Log.e(TAG, "readUri error", e);
            return null;
        }
    }

    /** Run JS on the UI thread (no-op if the view is gone). */
    private void callJs(final String js) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (mWebView != null) mWebView.evaluateJavascript(js, null);
            }
        });
    }

    /**
     * Streams ONE selected device PDF to the web layer on demand: /device/<id>.pdf. Only ids produced by the last
     * scan resolve, so JS can never ask for an arbitrary content:// URI. Nothing is copied to app storage here.
     */
    private final class DeviceFileHandler implements WebViewAssetLoader.PathHandler {
        @Override
        public WebResourceResponse handle(String path) {
            String id = path == null ? "" : path;
            int dot = id.indexOf('.');
            if (dot > 0) id = id.substring(0, dot);
            Map<String, Uri> reg = mDeviceRegistry;
            Uri uri = reg == null ? null : reg.get(id);
            if (uri == null) return deviceError(404, "Not Found");
            try {
                InputStream is = getContentResolver().openInputStream(uri);
                if (is == null) return deviceError(404, "Not Found");
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-store");
                return new WebResourceResponse("application/pdf", null, 200, "OK", h, is);
            } catch (Exception e) {                                   // deleted, moved, permission revoked
                Log.w(TAG, "device file open failed: " + e);
                return deviceError(410, "Gone");
            }
        }

        private WebResourceResponse deviceError(int code, String reason) {
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            return new WebResourceResponse("text/plain", "utf-8", code, reason, h, new ByteArrayInputStream(new byte[0]));
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        mScanIo.shutdownNow();
        mThumbIo.shutdownNow();
    }

    @Override // androidx.activity.ComponentActivity, android.app.Activity
    public void onBackPressed() {
        this.mWebView.evaluateJavascript("window.fyloHandleBack && window.fyloHandleBack()", new ValueCallback() { // from class: com.fylo.app.MainActivity$$ExternalSyntheticLambda2
            @Override // android.webkit.ValueCallback
            public final void onReceiveValue(Object obj) {
                MainActivity.this.lambda$onBackPressed$4((String) obj);
            }
        });
    }

    /* JADX INFO: Access modifiers changed from: private */
    public /* synthetic */ void lambda$onBackPressed$4(String result) {
        if (!"true".equals(result)) {
            finish();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    class FyloBridge {
        private FyloBridge() {
        }

        @JavascriptInterface
        public String saveFile(String base64, String filename, String mimeType) {
            try {
                String safeName = new File(filename).getName();
                if (safeName.isEmpty() || safeName.equals(".")) {
                    safeName = "fylo-export.pdf";
                }
                if (!safeName.contains("/") && !safeName.contains("\\") && !safeName.contains("..")) {
                    byte[] bytes = Base64.decode(base64, 0);
                    String mime = (mimeType == null || mimeType.isEmpty()) ? "application/pdf" : mimeType;
                    if (Build.VERSION.SDK_INT < 29) {
                        // Pre-scoped-storage fallback: app-specific external folder (no storage permission needed)
                        File dir = new File(MainActivity.this.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "FYLO");
                        if (!dir.exists() && !dir.mkdirs()) return saveError("Could not create the output folder");
                        File out = new File(dir, safeName);
                        FileOutputStream fos = new FileOutputStream(out);
                        try { fos.write(bytes); } finally { fos.close(); }
                        showSaved(safeName);
                        return saveOk("Android/data/" + getPackageName() + "/files/Download/FYLO/" + safeName);
                    }
                    ContentValues values = new ContentValues();
                    values.put("_display_name", safeName);
                    values.put("mime_type", mime);
                    values.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/FYLO");
                    values.put("is_pending", (Integer) 1);
                    Uri collection = MediaStore.Downloads.getContentUri("external_primary");
                    Uri itemUri = MainActivity.this.getContentResolver().insert(collection, values);
                    if (itemUri == null) return saveError("Android refused to create the file");
                    try {
                        OutputStream os = MainActivity.this.getContentResolver().openOutputStream(itemUri);
                        if (os == null) throw new java.io.IOException("Could not open the output stream");
                        try { os.write(bytes); } finally { os.close(); }
                        values.clear();
                        values.put("is_pending", (Integer) 0);
                        MainActivity.this.getContentResolver().update(itemUri, values, null, null);
                    } catch (Exception writeFailure) {
                        try { MainActivity.this.getContentResolver().delete(itemUri, null, null); } catch (Exception ignored) { }   // never leave a half-written/pending file
                        throw writeFailure;
                    }
                    showSaved(safeName);
                    return saveOk("Downloads/FYLO/" + safeName);
                }
                return "{\"success\":false,\"error\":\"Invalid filename\"}";
            } catch (Exception e) {
                Log.e(MainActivity.TAG, "saveFile error", e);
                return saveError(String.valueOf(e.getMessage()));
            }
        }

        private String saveOk(String path) {
            try { return new JSONObject().put("success", true).put("path", path).toString(); } catch (Exception e) { return "{\"success\":true}"; }
        }

        private String saveError(String message) {
            try { return new JSONObject().put("success", false).put("error", message).toString(); } catch (Exception e) { return "{\"success\":false}"; }
        }

        private void showSaved(final String savedName) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() { Toast.makeText(MainActivity.this, "Saved: " + savedName, 0).show(); }
            });
        }

        @JavascriptInterface
        public void shareFile(String base64, String filename, String mimeType) {
            try {
                String safeName = new File(filename).getName();
                byte[] bytes = Base64.decode(base64, 0);
                File shareFile = new File(MainActivity.this.getCacheDir(), safeName);
                FileOutputStream fos = new FileOutputStream(shareFile);
                try {
                    fos.write(bytes);
                    fos.close();
                    Uri shareUri = FileProvider.getUriForFile(MainActivity.this, "com.fylo.app.fileprovider", shareFile);
                    final Intent shareIntent = new Intent("android.intent.action.SEND");
                    shareIntent.setType(mimeType != null ? mimeType : "application/pdf");
                    shareIntent.putExtra("android.intent.extra.STREAM", shareUri);
                    shareIntent.addFlags(1);
                    MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$FyloBridge$$ExternalSyntheticLambda1
                        @Override // java.lang.Runnable
                        public final void run() {
                            MainActivity.FyloBridge.this.lambda$shareFile$1(shareIntent);
                        }
                    });
                } finally {
                }
            } catch (Exception e) {
                Log.e(MainActivity.TAG, "shareFile error", e);
            }
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$shareFile$1(Intent shareIntent) {
            MainActivity.this.startActivity(Intent.createChooser(shareIntent, "Share via"));
        }

        @JavascriptInterface
        public void requestCameraPermission() {
            MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$FyloBridge$$ExternalSyntheticLambda4
                @Override // java.lang.Runnable
                public final void run() {
                    MainActivity.FyloBridge.this.lambda$requestCameraPermission$2();
                }
            });
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$requestCameraPermission$2() {
            if (hasCameraPermission()) {
                MainActivity.this.mWebView.evaluateJavascript("window.fyloOnCameraPermission && window.fyloOnCameraPermission(true)", null);
            } else {
                MainActivity.this.launchCameraPermissionDialog();
            }
        }

        @JavascriptInterface
        public boolean hasCameraPermission() {
            return MainActivity.this.hasCameraPermission();
        }

        @JavascriptInterface
        public void openFilePicker(String mimeTypesCsv) {
            final String[] mimes;
            if (mimeTypesCsv != null && !mimeTypesCsv.isEmpty()) {
                mimes = mimeTypesCsv.split(",");
            } else {
                mimes = new String[]{"application/pdf"};
            }
            MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$FyloBridge$$ExternalSyntheticLambda0
                @Override // java.lang.Runnable
                public final void run() {
                    MainActivity.FyloBridge.this.lambda$openFilePicker$3(mimes);
                }
            });
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$openFilePicker$3(String[] mimes) {
            MainActivity.this.mFilePicker.launch(mimes);
        }

        @JavascriptInterface
        public void showToast(final String message) {
            if (message == null || message.length() > 200) {
                return;
            }
            MainActivity.this.runOnUiThread(new Runnable() { // from class: com.fylo.app.MainActivity$FyloBridge$$ExternalSyntheticLambda2
                @Override // java.lang.Runnable
                public final void run() {
                    MainActivity.FyloBridge.this.lambda$showToast$4(message);
                }
            });
        }

        /* JADX INFO: Access modifiers changed from: private */
        public /* synthetic */ void lambda$showToast$4(String message) {
            Toast.makeText(MainActivity.this, message, 0).show();
        }

        // ── Device PDFs ───────────────────────────────────────────────────────────
        @JavascriptInterface
        public void pickPdfFolder() {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        MainActivity.this.mFolderPicker.launch(null);
                    } catch (Exception e) {
                        Log.e(MainActivity.TAG, "folder picker failed", e);
                        MainActivity.this.callJs("window.fyloOnDeviceFolderPicked&&window.fyloOnDeviceFolderPicked(false,\"failed\")");
                    }
                }
            });
        }

        @JavascriptInterface
        public String getPdfFolders() {
            return DevicePdfs.foldersJson(MainActivity.this);
        }

        @JavascriptInterface
        public boolean removePdfFolder(String uri) {
            try { return DevicePdfs.releaseTree(MainActivity.this, Uri.parse(uri)); } catch (Exception e) { return false; }
        }

        /** Starts a background scan; the result is delivered to window.fyloOnDevicePdfs(json). Returns "started" or "busy". */
        @JavascriptInterface
        public String scanDevicePdfs() {
            if (!MainActivity.this.mScanRunning.compareAndSet(false, true)) return "busy";
            try {
                MainActivity.this.mScanIo.execute(new Runnable() {
                    @Override
                    public void run() {
                        String json;
                        try {
                            DevicePdfs.Result r = DevicePdfs.scan(MainActivity.this);
                            MainActivity.this.mDeviceRegistry = DevicePdfs.registryOf(r);
                            json = DevicePdfs.toJson(r);
                        } catch (Throwable t) {
                            Log.e(MainActivity.TAG, "scan failed", t);
                            json = "{\"items\":[],\"errors\":[\"Scan failed\"],\"truncated\":false}";
                        } finally {
                            MainActivity.this.mScanRunning.set(false);
                        }
                        MainActivity.this.callJs("window.fyloOnDevicePdfs&&window.fyloOnDevicePdfs(" + JSONObject.quote(json) + ")");
                    }
                });
            } catch (Exception e) {                          // executor shut down
                MainActivity.this.mScanRunning.set(false);
                return "failed";
            }
            return "started";
        }

        /** Renders page 1 natively; the result arrives as window.fyloOnDevicePdfThumb(id, dataUrl|null). */
        @JavascriptInterface
        public void requestDevicePdfThumb(final String id) {
            try {
                MainActivity.this.mThumbIo.execute(new Runnable() {
                    @Override
                    public void run() {
                        Map<String, Uri> reg = MainActivity.this.mDeviceRegistry;
                        Uri uri = reg == null ? null : reg.get(id);
                        String data = uri == null ? null : DevicePdfs.thumbnail(MainActivity.this, uri);
                        MainActivity.this.callJs("window.fyloOnDevicePdfThumb&&window.fyloOnDevicePdfThumb(" + JSONObject.quote(id) + "," + (data == null ? "null" : JSONObject.quote(data)) + ")");
                    }
                });
            } catch (Exception ignored) { }
        }

        // ── Maintenance ───────────────────────────────────────────────────────────
        /** Deletes only temporary files (share/export leftovers in the app cache dir) and the WebView HTTP cache. */
        @JavascriptInterface
        public String clearTempFiles() {
            long freed = 0;
            int count = 0;
            try {
                File[] files = MainActivity.this.getCacheDir().listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (!f.isFile()) continue;                 // never touch directories (WebView keeps its own there)
                        long len = f.length();
                        if (f.delete()) { freed += len; count++; }
                    }
                }
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "clearTempFiles failed", e);
            }
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { MainActivity.this.mWebView.clearCache(false); } catch (Exception ignored) { }
                }
            });
            try { return new JSONObject().put("success", true).put("freedBytes", freed).put("count", count).toString(); }
            catch (Exception e) { return "{\"success\":true}"; }
        }

        /** {"versionName","versionCode","lastUpdate"} of the installed APK, so the UI can show what is really installed. */
        @JavascriptInterface
        public String getAppVersion() {
            try {
                PackageInfo pi = MainActivity.this.getPackageManager().getPackageInfo(MainActivity.this.getPackageName(), 0);
                long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
                return new JSONObject().put("versionName", pi.versionName).put("versionCode", code).put("lastUpdate", pi.lastUpdateTime).toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        @JavascriptInterface
        public String getAndroidVersion() {
            return String.valueOf(Build.VERSION.SDK_INT);
        }
    }
}
