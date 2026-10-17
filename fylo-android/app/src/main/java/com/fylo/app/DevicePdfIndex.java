package com.fylo.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Whole-device PDF discovery for a sideloaded utility app.
 *
 * Why this exists: scoped storage (Android 10+) hides other apps' non-media files, so a PDF library can only be
 * built from (a) folders the user picked one by one (SAF) or (b) the "All files access" special permission
 * (MANAGE_EXTERNAL_STORAGE, API 30+) — or READ_EXTERNAL_STORAGE on API 26-29. This class implements (b).
 *
 * It never copies anything. It reports {path, name, size, modified, key}; the page opens a file by asking for
 * /dev/doc?p=<path>, which is streamed from the original location (see serve checks in isPathAllowed).
 */
final class DevicePdfIndex {

    private static final String TAG = "FYLO.Device";

    // Bounds keep battery/memory use predictable on huge libraries; reaching one is reported as `truncated`.
    static final int MAX_FILES = 20000;
    private static final int MAX_DIRS = 60000;
    private static final int MAX_DEPTH = 24;
    private static final long MAX_MS_QUICK = 20_000L;
    private static final long MAX_MS_DEEP = 90_000L;

    private final Context ctx;

    DevicePdfIndex(Context c) { this.ctx = c.getApplicationContext(); }

    // ── Access state ──────────────────────────────────────────────────────────

    /**
     * "all_files" (API 30+: special access in Settings), "read_storage" (API 26-28: runtime permission, legacy file
     * access), "folders_only" (API 29: scoped storage is enforced and there is no whole-storage grant to ask for,
     * so only the folder picker works).
     */
    static String mode() {
        int s = Build.VERSION.SDK_INT;
        return s >= 30 ? "all_files" : s == 29 ? "folders_only" : "read_storage";
    }

    boolean hasAccess() {
        if (Build.VERSION.SDK_INT == 29) return false;
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return ctx.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    JSONObject state() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("mode", mode());
        o.put("granted", hasAccess());
        return o;
    }

    // ── Roots / path policy ───────────────────────────────────────────────────

    /** Shared-storage volume roots (primary + SD cards). */
    Set<String> volumeRoots() {
        Set<String> roots = new HashSet<>();
        try { roots.add(Environment.getExternalStorageDirectory().getCanonicalPath()); } catch (Exception ignored) { /* */ }
        try {
            File[] dirs = ctx.getExternalFilesDirs(null);
            if (dirs != null) for (File d : dirs) {
                if (d == null) continue;
                String p = d.getAbsolutePath();
                int i = p.indexOf("/Android/");
                if (i > 0) roots.add(new File(p.substring(0, i)).getCanonicalPath());
            }
        } catch (Exception ignored) { /* best effort */ }
        return roots;
    }

    /** True when `path` is a PDF inside shared storage (never another app's Android/data|obb, never app-private dirs). */
    boolean isPathAllowed(String path) {
        if (path == null || path.isEmpty() || !path.toLowerCase(Locale.ROOT).endsWith(".pdf")) return false;
        try {
            String canon = new File(path).getCanonicalPath();
            for (String root : volumeRoots()) {
                if (!canon.startsWith(root + "/")) continue;
                String rel = canon.substring(root.length() + 1);
                if (rel.equals("Android") || rel.startsWith("Android/")) {
                    // Only this app's own external dir may be read from there.
                    String own = "Android/data/" + ctx.getPackageName() + "/";
                    return rel.startsWith(own);
                }
                return true;
            }
        } catch (IOException ignored) { /* not allowed */ }
        return false;
    }

    /** Own app-specific dir (legacy saves on API 26-28) needs no permission. */
    boolean isOwnExternalPath(String path) {
        try {
            String canon = new File(path).getCanonicalPath();
            File[] dirs = ctx.getExternalFilesDirs(null);
            if (dirs != null) for (File d : dirs) if (d != null && canon.startsWith(d.getCanonicalPath() + "/")) return true;
        } catch (IOException ignored) { /* */ }
        return false;
    }

    // ── Discovery ─────────────────────────────────────────────────────────────

    /** Quick pass = MediaStore index (fast, cheap). Deep pass = also walks the file system for unindexed PDFs. */
    JSONObject discover(boolean deep, AtomicBoolean cancel) throws JSONException {
        JSONObject out = new JSONObject();
        if (!hasAccess()) {
            out.put("ok", false); out.put("error", "NO_ACCESS");
            out.put("message", "Storage access has not been granted.");
            return out;
        }
        long t0 = System.currentTimeMillis();
        long budget = deep ? MAX_MS_DEEP : MAX_MS_QUICK;
        JSONArray arr = new JSONArray();
        Set<String> seen = new HashSet<>();
        boolean truncated = false;
        int fromIndex = 0, fromWalk = 0;

        // 1) MediaStore.Files — an indexed, battery-cheap list of every PDF Android knows about.
        try {
            ContentResolver cr = ctx.getContentResolver();
            Uri files = MediaStore.Files.getContentUri("external");
            String[] proj = {MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.DATA,
                    MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.SIZE,
                    MediaStore.Files.FileColumns.DATE_MODIFIED};
            String sel = MediaStore.Files.FileColumns.MIME_TYPE + "=? OR " + MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE ?";
            try (Cursor c = cr.query(files, proj, sel, new String[]{"application/pdf", "%.pdf"},
                    MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC")) {
                while (c != null && c.moveToNext()) {
                    if (cancel.get()) { out.put("cancelled", true); break; }
                    if (arr.length() >= MAX_FILES) { truncated = true; break; }
                    String path = c.getString(1);
                    if (path == null || !isPathAllowed(path)) continue;
                    File f = new File(path);
                    long size = f.length();
                    if (!f.isFile() || size <= 0) continue;      // stale index row (file deleted) → skip
                    if (add(arr, seen, f, c.getString(2), size, f.lastModified())) fromIndex++;
                }
            }
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "MediaStore query failed: " + e);
        } catch (Exception e) {
            Log.w(TAG, "MediaStore query error", e);
        }

        // 2) Optional deep walk: catches PDFs the media scanner has not indexed (e.g. copied by a file manager).
        if (deep && !cancel.get()) {
            ArrayDeque<File> dirs = new ArrayDeque<>();
            ArrayDeque<Integer> depths = new ArrayDeque<>();
            for (String r : volumeRoots()) { dirs.add(new File(r)); depths.add(0); }
            int dirCount = 0;
            while (!dirs.isEmpty()) {
                if (cancel.get()) { out.put("cancelled", true); break; }
                if (System.currentTimeMillis() - t0 > budget || dirCount > MAX_DIRS || arr.length() >= MAX_FILES) { truncated = true; break; }
                File d = dirs.poll(); int depth = depths.poll(); dirCount++;
                File[] kids = d.listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    String n = k.getName();
                    if (k.isDirectory()) {
                        if (n.startsWith(".") || (depth == 0 && n.equals("Android")) || depth >= MAX_DEPTH) continue;
                        if (java.nio.file.Files.isSymbolicLink(k.toPath())) continue;   // avoid loops
                        dirs.add(k); depths.add(depth + 1);
                    } else if (n.toLowerCase(Locale.ROOT).endsWith(".pdf") && k.length() > 0 && isPathAllowed(k.getPath())) {
                        if (arr.length() >= MAX_FILES) { truncated = true; break; }
                        if (add(arr, seen, k, n, k.length(), k.lastModified())) fromWalk++;
                    }
                }
            }
        }

        out.put("ok", true);
        out.put("files", arr);
        out.put("truncated", truncated);
        out.put("deep", deep);
        out.put("fromIndex", fromIndex);
        out.put("fromWalk", fromWalk);
        out.put("ms", System.currentTimeMillis() - t0);
        return out;
    }

    private boolean add(JSONArray arr, Set<String> seen, File f, String name, long size, long modifiedMs) throws JSONException {
        String key;
        try { key = f.getCanonicalPath(); } catch (IOException e) { key = f.getAbsolutePath(); }
        if (!seen.add(key)) return false;                      // same physical file reached twice → once
        JSONObject o = new JSONObject();
        o.put("path", key);
        o.put("name", name != null && !name.isEmpty() ? name : f.getName());
        o.put("size", size);
        o.put("modified", modifiedMs > 0 && modifiedMs < 100000000000L ? modifiedMs * 1000 : modifiedMs);
        arr.put(o);
        return true;
    }

    /** Existence/size check for already-known files (deleted / moved / revoked detection). */
    JSONArray stat(JSONArray paths) throws JSONException {
        JSONArray out = new JSONArray();
        boolean access = hasAccess();
        for (int i = 0; i < paths.length(); i++) {
            String p = paths.optString(i);
            JSONObject o = new JSONObject();
            o.put("path", p);
            boolean allowed = isPathAllowed(p) && (access || isOwnExternalPath(p));
            File f = new File(p);
            o.put("allowed", allowed);
            o.put("exists", allowed && f.isFile());
            o.put("size", allowed && f.isFile() ? f.length() : 0);
            o.put("modified", allowed && f.isFile() ? f.lastModified() : 0);
            out.put(o);
        }
        return out;
    }
}
