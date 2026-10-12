package com.fylo.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Lists the PDFs FYLO is *allowed* to see, without any broad storage permission.
 *
 * Sources
 *   1. Folders the user explicitly granted through the system folder picker (Storage Access Framework,
 *      ACTION_OPEN_DOCUMENT_TREE). The grant is persisted, so the folder keeps being listed after restarts
 *      and app updates. Nothing outside granted folders is ever read.
 *   2. PDFs FYLO itself saved to Downloads/FYLO through MediaStore (the app owns these, so Android lets it
 *      query them without any permission).
 *
 * Why not READ_EXTERNAL_STORAGE / READ_MEDIA_* / MANAGE_EXTERNAL_STORAGE: on Android 10+ the first two never
 * expose other apps' non-media files (PDFs) to MediaStore queries, and the last is "all files access", a
 * broad grant that is restricted on Google Play and not needed here.
 *
 * Nothing is copied: this class only reads metadata. File bytes are streamed on demand, one selected file at
 * a time, by MainActivity's /device/ path handler.
 */
final class DevicePdfs {
    private static final String TAG = "FYLO";

    static final int MAX_ITEMS = 3000;
    private static final int MAX_DIRS = 6000;
    private static final int MAX_DEPTH = 10;
    private static final long MAX_SCAN_MS = 25_000L;

    private static final String EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents";

    /** One listed PDF. */
    static final class Item {
        String id;        // stable key (hash of authority + document id)
        String name;
        String folder;    // folder path shown to the user, e.g. "Download/Invoices"
        String source;    // human readable origin: granted folder name or "FYLO"
        long size;        // bytes, -1 if unknown
        long modified;    // epoch millis, 0 if unknown
        Uri uri;          // content:// URI (never exposed to JS)
    }

    static final class Result {
        final List<Item> items = new ArrayList<>();
        final List<String> errors = new ArrayList<>();
        boolean truncated;
    }

    private DevicePdfs() {}

    // ── Granted folders ───────────────────────────────────────────────────────

    /** Folders with a persisted read grant. The system is the source of truth, so revoked grants disappear. */
    static List<Uri> grantedTrees(Context ctx) {
        List<Uri> out = new ArrayList<>();
        try {
            for (UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) {
                if (p.isReadPermission() && DocumentsContract.isTreeUri(p.getUri())) out.add(p.getUri());
            }
        } catch (Exception e) {
            Log.w(TAG, "getPersistedUriPermissions failed", e);
        }
        return out;
    }

    /** Persist a folder grant returned by the folder picker. */
    static boolean persistTree(Context ctx, Uri tree) {
        if (tree == null || !DocumentsContract.isTreeUri(tree)) return false;
        try {
            ctx.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "takePersistableUriPermission failed", e);
            return false;
        }
    }

    static boolean releaseTree(Context ctx, Uri tree) {
        try {
            ctx.getContentResolver().releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "releasePersistableUriPermission failed", e);
            return false;
        }
    }

    /** JSON array: [{uri, name, accessible}] */
    static String foldersJson(Context ctx) {
        JSONArray arr = new JSONArray();
        for (Uri tree : grantedTrees(ctx)) {
            try {
                JSONObject o = new JSONObject();
                String name = treeName(ctx, tree);
                o.put("uri", tree.toString());
                o.put("name", name != null ? name : "Folder");
                o.put("accessible", name != null);
                arr.put(o);
            } catch (Exception ignored) { }
        }
        return arr.toString();
    }

    /** Display name of the granted folder root, or null when it can no longer be reached. */
    private static String treeName(Context ctx, Uri tree) {
        Cursor c = null;
        try {
            Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            c = ctx.getContentResolver().query(root,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                return (n == null || n.isEmpty()) ? "Folder" : n;
            }
        } catch (Exception e) {
            Log.w(TAG, "treeName failed for " + tree, e);
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    // ── Scan ──────────────────────────────────────────────────────────────────

    static Result scan(Context ctx) {
        final Result result = new Result();
        final Set<String> seen = new HashSet<>();
        final long deadline = System.currentTimeMillis() + MAX_SCAN_MS;

        for (Uri tree : grantedTrees(ctx)) {
            if (result.truncated) break;
            String rootName = treeName(ctx, tree);
            if (rootName == null) {
                result.errors.add("A granted folder is no longer available (removed, moved or unmounted).");
                continue;
            }
            try {
                walkTree(ctx, tree, rootName, result, seen, deadline);
            } catch (Exception e) {
                Log.w(TAG, "walkTree failed for " + tree, e);
                result.errors.add("Could not read folder \"" + rootName + "\".");
            }
        }

        try {
            addOwnDownloads(ctx, result, seen);
        } catch (Exception e) {
            Log.w(TAG, "own downloads query failed", e);
        }

        Collections.sort(result.items, (a, b) -> Long.compare(b.modified, a.modified));
        return result;
    }

    private static boolean looksLikePdf(String mime, String name) {
        if ("application/pdf".equals(mime)) return true;
        boolean vague = mime == null || mime.isEmpty() || "application/octet-stream".equals(mime);
        return vague && name != null && name.toLowerCase(Locale.ROOT).endsWith(".pdf");
    }

    private static void walkTree(Context ctx, Uri tree, String rootName, Result result,
                                 Set<String> seen, long deadline) {
        final ContentResolver cr = ctx.getContentResolver();
        final String[] proj = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        final String authority = tree.getAuthority();

        // Work list of (document id, path shown to the user, depth)
        final ArrayDeque<Object[]> stack = new ArrayDeque<>();
        stack.push(new Object[]{DocumentsContract.getTreeDocumentId(tree), rootName, 0});
        int dirs = 0;

        while (!stack.isEmpty()) {
            if (System.currentTimeMillis() > deadline || ++dirs > MAX_DIRS) { result.truncated = true; return; }
            Object[] cur = stack.pop();
            String parentId = (String) cur[0];
            String path = (String) cur[1];
            int depth = (Integer) cur[2];

            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
            Cursor c = null;
            try {
                c = cr.query(children, proj, null, null, null);
                if (c == null) continue;
                while (c.moveToNext()) {
                    String docId = c.getString(0);
                    String name = c.getString(1);
                    String mime = c.getString(2);
                    if (docId == null || name == null) continue;

                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        // Skip hidden folders (.thumbnails, .Trash, ...) and bound the depth
                        if (!name.startsWith(".") && depth < MAX_DEPTH) {
                            stack.push(new Object[]{docId, path + "/" + name, depth + 1});
                        }
                        continue;
                    }
                    if (!looksLikePdf(mime, name)) continue;

                    String key = authority + "|" + docId;
                    if (!seen.add(key)) continue;                       // same file reached twice -> one entry
                    if (result.items.size() >= MAX_ITEMS) { result.truncated = true; return; }

                    Item it = new Item();
                    it.id = hash(key);
                    it.name = name;
                    it.folder = path;
                    it.source = rootName;
                    it.size = c.isNull(3) ? -1 : c.getLong(3);
                    it.modified = c.isNull(4) ? 0 : c.getLong(4);
                    it.uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                    result.items.add(it);
                }
            } catch (Exception e) {
                Log.w(TAG, "list children failed: " + parentId, e);
                result.errors.add("Some items in \"" + path + "\" could not be read.");
            } finally {
                if (c != null) c.close();
            }
        }
    }

    /** PDFs FYLO saved to Downloads/FYLO. Owned by this app, so no permission is required (API 29+). */
    private static void addOwnDownloads(Context ctx, Result result, Set<String> seen) {
        if (Build.VERSION.SDK_INT < 29) return;   // minSdk is 26; on 26-28 only the folder grant is offered
        final Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        final String[] proj = {
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.RELATIVE_PATH,
        };
        final String sel = MediaStore.MediaColumns.MIME_TYPE + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
        final String[] args = {"application/pdf", "Download/FYLO%"};
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(collection, proj, sel, args, null);
            if (c == null) return;
            while (c.moveToNext()) {
                if (result.items.size() >= MAX_ITEMS) { result.truncated = true; return; }
                long mediaId = c.getLong(0);
                String name = c.getString(1);
                String rel = c.getString(4) == null ? "Download/FYLO/" : c.getString(4);
                if (name == null) continue;

                // Same logical key as an ExternalStorageProvider document, so a granted "Download" folder that
                // also contains these files does not produce a second entry.
                String key = EXTERNAL_STORAGE_AUTHORITY + "|primary:" + rel + name;
                if (!seen.add(key)) continue;

                Item it = new Item();
                it.id = hash(key);
                it.name = name;
                it.folder = rel.endsWith("/") ? rel.substring(0, rel.length() - 1) : rel;
                it.source = "FYLO";
                it.size = c.isNull(2) ? -1 : c.getLong(2);
                it.modified = c.isNull(3) ? 0 : c.getLong(3) * 1000L;   // DATE_MODIFIED is in seconds
                it.uri = ContentUris.withAppendedId(collection, mediaId);
                result.items.add(it);
            }
        } finally {
            if (c != null) c.close();
        }
    }

    // ── JSON for the web layer ────────────────────────────────────────────────

    static String toJson(Result r) {
        try {
            JSONObject root = new JSONObject();
            JSONArray items = new JSONArray();
            for (Item it : r.items) {
                JSONObject o = new JSONObject();
                o.put("id", it.id);
                o.put("name", it.name);
                o.put("folder", it.folder);
                o.put("source", it.source);
                o.put("size", it.size);
                o.put("modified", it.modified);
                items.put(o);
            }
            root.put("items", items);
            JSONArray errs = new JSONArray();
            for (String e : r.errors) errs.put(e);
            root.put("errors", errs);
            root.put("truncated", r.truncated);
            return root.toString();
        } catch (Exception e) {
            return "{\"items\":[],\"errors\":[\"internal error\"],\"truncated\":false}";
        }
    }

    static Map<String, Uri> registryOf(Result r) {
        Map<String, Uri> m = new HashMap<>();
        for (Item it : r.items) m.put(it.id, it.uri);
        return m;
    }

    // ── Thumbnail (first page, rendered natively; the PDF never goes through JS) ──

    /** Returns a data: URL (JPEG) or null when the file cannot be rendered (encrypted, corrupt, not seekable). */
    static String thumbnail(Context ctx, Uri uri) {
        ParcelFileDescriptor pfd = null;
        PdfRenderer renderer = null;
        PdfRenderer.Page page = null;
        Bitmap bmp = null;
        try {
            pfd = ctx.getContentResolver().openFileDescriptor(uri, "r");
            if (pfd == null) return null;
            renderer = new PdfRenderer(pfd);
            if (renderer.getPageCount() < 1) return null;
            page = renderer.openPage(0);
            final int targetW = 240;
            int w = targetW;
            int h = Math.max(1, Math.round(targetW * (page.getHeight() / (float) Math.max(1, page.getWidth()))));
            h = Math.min(h, 480);
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            new Canvas(bmp).drawColor(Color.WHITE);                  // PdfRenderer draws onto transparent
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos);
            return "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable t) {                                      // SecurityException for protected PDFs, OOM, ...
            Log.w(TAG, "thumbnail failed: " + t);
            return null;
        } finally {
            try { if (page != null) page.close(); } catch (Throwable ignored) { }
            try { if (renderer != null) renderer.close(); } catch (Throwable ignored) { }
            try { if (pfd != null) pfd.close(); } catch (Throwable ignored) { }
            if (bmp != null) bmp.recycle();
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 10; i++) sb.append(String.format(Locale.ROOT, "%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
