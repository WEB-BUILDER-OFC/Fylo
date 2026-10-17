package com.fylo.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Storage Access Framework helper: remembers the folders the user chose, lists the PDFs inside them,
 * and decides whether a document URI may be streamed to the web layer.
 *
 * Android only lets an app read folders the user explicitly picks (no broad storage permission is
 * requested). The grant is persisted, so it survives restarts, but the user (or the system, e.g. when
 * the folder is deleted or the SD card removed) can revoke it — callers must treat every listing as
 * something that can fail with ACCESS_REVOKED.
 */
final class SafPdfIndex {

    private static final String TAG = "FYLO.Saf";
    private static final String PREFS = "fylo_native";
    private static final String KEY_ROOTS = "pdf_roots";

    // Scan limits keep a huge or slow directory from freezing the app; hitting one is reported as `truncated`.
    private static final int MAX_FILES = 5000;
    private static final int MAX_DIRS = 2500;
    private static final int MAX_DEPTH = 8;
    private static final long MAX_MS = 25_000L;

    private final Context ctx;
    private final ContentResolver cr;

    SafPdfIndex(Context context) {
        this.ctx = context.getApplicationContext();
        this.cr = ctx.getContentResolver();
    }

    // ── Folder grants ─────────────────────────────────────────────────────────

    /** Persists read access to a picked folder and remembers it. Returns the folder description. */
    synchronized JSONObject addRoot(Uri tree) throws JSONException {
        try {
            cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            Log.w(TAG, "Could not persist folder permission", e);
            // Still usable until the process ends, but it will not survive a restart: say so.
            JSONObject o = describe(tree);
            o.put("persisted", false);
            return o;
        }
        List<String> roots = readRoots();
        if (!roots.contains(tree.toString())) {
            roots.add(tree.toString());
            writeRoots(roots);
        }
        JSONObject o = describe(tree);
        o.put("persisted", true);
        return o;
    }

    synchronized void removeRoot(String treeUri) {
        List<String> roots = readRoots();
        roots.remove(treeUri);
        writeRoots(roots);
        try {
            cr.releasePersistableUriPermission(Uri.parse(treeUri), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception e) {
            Log.w(TAG, "release permission failed (already gone?)", e);
        }
    }

    synchronized JSONArray foldersJson() {
        JSONArray arr = new JSONArray();
        for (String r : readRoots()) {
            try {
                arr.put(describe(Uri.parse(r)));
            } catch (JSONException ignored) { /* skip entry */ }
        }
        return arr;
    }

    private JSONObject describe(Uri tree) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("uri", tree.toString());
        o.put("name", nameOf(tree));
        // "accessible" = Android still holds our grant. (Whether the folder still exists is learnt when it is listed;
        // a flaky provider query here used to mark a perfectly good new folder as "access lost".)
        o.put("accessible", isGranted(tree));
        return o;
    }

    int persistedGrantCount() {
        try { return cr.getPersistedUriPermissions().size(); } catch (Exception e) { return -1; }
    }

    private boolean isGranted(Uri tree) {
        try {
            for (UriPermission p : cr.getPersistedUriPermissions()) {
                if (p.getUri().equals(tree) && p.isReadPermission()) return true;
            }
        } catch (Exception ignored) { /* treat as not granted */ }
        return false;
    }

    private boolean rootExists(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = cr.query(doc, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
                return c != null && c.moveToFirst();
            }
        } catch (Exception e) {
            return false;
        }
    }

    private String nameOf(Uri tree) {
        try {
            String id = DocumentsContract.getTreeDocumentId(tree);
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            try (Cursor c = cr.query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String n = c.getString(0);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
            int colon = id.lastIndexOf(':');
            String tail = colon >= 0 ? id.substring(colon + 1) : id;
            int slash = tail.lastIndexOf('/');
            tail = slash >= 0 ? tail.substring(slash + 1) : tail;
            return tail.isEmpty() ? "Storage" : tail;
        } catch (Exception e) {
            return "Folder";
        }
    }

    private List<String> readRoots() {
        List<String> out = new ArrayList<>();
        String raw = prefs().getString(KEY_ROOTS, "[]");
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (JSONException e) {
            Log.w(TAG, "Corrupt folder list, resetting", e);
        }
        return out;
    }

    private void writeRoots(List<String> roots) {
        JSONArray a = new JSONArray();
        for (String r : roots) a.put(r);
        prefs().edit().putString(KEY_ROOTS, a.toString()).apply();
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── Document access check ─────────────────────────────────────────────────

    /**
     * True only for document URIs inside one of the user's granted folders. Our own listing builds URIs as
     * "<tree>/document/<id>"; the provider itself refuses documents outside that tree, so a prefix check is
     * both cheap and safe.
     */
    boolean isUnderGrantedRoot(Uri doc) {
        if (doc == null || !"content".equals(doc.getScheme())) return false;
        String d = doc.toString();
        for (String root : readRoots()) {
            if (d.startsWith(root + "/document/") && isGranted(Uri.parse(root))) return true;
        }
        return false;
    }

    // ── Individually picked documents (the "Open PDF" picker) ────────────────

    /** Documents picked this session (covers grants that could not be persisted). */
    private final java.util.Set<String> sessionDocs = new java.util.HashSet<>();

    /** Remembers a picked document and tries to keep read access across restarts. Returns true when persisted. */
    boolean grantDocument(Uri doc) {
        synchronized (sessionDocs) { sessionDocs.add(doc.toString()); }
        try {
            cr.takePersistableUriPermission(doc, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "Could not persist document permission", e);
            return false;
        }
    }

    boolean isGrantedDocument(Uri doc) {
        if (doc == null || !"content".equals(doc.getScheme())) return false;
        synchronized (sessionDocs) { if (sessionDocs.contains(doc.toString())) return true; }
        try {
            for (UriPermission p : cr.getPersistedUriPermissions()) {
                if (p.isReadPermission() && p.getUri().equals(doc)) return true;
            }
        } catch (Exception ignored) { /* treated as not granted */ }
        return false;
    }

    /** Frees the persisted grant of a document FYLO no longer lists (Android caps how many an app may hold). */
    void releaseDocument(Uri doc) {
        synchronized (sessionDocs) { sessionDocs.remove(doc.toString()); }
        // Never release a grant that is the folder root of a granted tree.
        if (readRoots().contains(doc.toString())) return;
        try { cr.releasePersistableUriPermission(doc, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { /* none */ }
    }

    /** Describes a picked document: {uri,name,size,modified}. */
    JSONObject describeDocument(Uri doc) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("uri", doc.toString());
        String name = null; long size = -1, mod = 0;
        try (Cursor c = cr.query(doc, new String[]{android.provider.OpenableColumns.DISPLAY_NAME,
                android.provider.OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
                if (c.getColumnCount() > 2 && !c.isNull(2)) mod = c.getLong(2);
            }
        } catch (Exception e) { Log.w(TAG, "describeDocument failed: " + e); }
        o.put("name", name != null ? name : "document.pdf");
        o.put("size", size);
        o.put("modified", mod);
        return o;
    }

    /** Existence check for a document/URI the app was granted: {path:<uri>, allowed, exists, size, modified}. */
    JSONObject statDocument(String uriStr) throws JSONException {
        Uri doc = Uri.parse(uriStr);
        JSONObject o = new JSONObject();
        o.put("path", uriStr);
        boolean allowed = isGrantedDocument(doc) || isUnderGrantedRoot(doc) || "media".equals(doc.getAuthority());
        o.put("allowed", allowed);
        boolean exists = false; long size = 0, mod = 0;
        if (allowed) {
            try (Cursor c = cr.query(doc, new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) {
                if (c != null && c.moveToFirst()) { exists = true; if (!c.isNull(0)) size = c.getLong(0); }
            } catch (Exception ignored) { /* gone */ }
        }
        o.put("exists", exists); o.put("size", size); o.put("modified", mod);
        return o;
    }

    // ── PDF listing ───────────────────────────────────────────────────────────

    private static final class Node {
        final String docId;
        final String path;
        final int depth;
        Node(String docId, String path, int depth) {
            this.docId = docId;
            this.path = path;
            this.depth = depth;
        }
    }

    /**
     * Lists PDFs under a granted folder. Never throws: failures are reported in the JSON
     * ({ok:false, error:"ACCESS_REVOKED"|"UNREADABLE"|...}).
     */
    JSONObject listPdfs(Uri tree, AtomicBoolean cancel) {
        JSONObject out = new JSONObject();
        try {
            out.put("folder", tree.toString());
            if (!isGranted(tree)) return failure(out, "ACCESS_REVOKED", "Access to this folder was removed");

            JSONArray files = new JSONArray();
            ArrayDeque<Node> queue = new ArrayDeque<>();
            queue.add(new Node(DocumentsContract.getTreeDocumentId(tree), "", 0));
            long deadline = System.currentTimeMillis() + MAX_MS;
            int dirs = 0;
            int unreadableDirs = 0;
            String truncatedWhy = null;
            boolean depthLimited = false;
            boolean rootRead = false;

            while (!queue.isEmpty()) {
                if (cancel.get()) return failure(out, "CANCELLED", "Cancelled");
                if (System.currentTimeMillis() > deadline) { truncatedWhy = "time"; break; }
                if (dirs >= MAX_DIRS) { truncatedWhy = "folders"; break; }
                Node node = queue.poll();
                dirs++;
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, node.docId);
                try (Cursor c = cr.query(children, new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE,
                        DocumentsContract.Document.COLUMN_LAST_MODIFIED}, null, null, null)) {
                    if (c == null) {
                        if (node.depth == 0) return rootExists(tree)
                                ? failure(out, "UNREADABLE", "This folder could not be read")
                                : failure(out, "ACCESS_REVOKED", "This folder no longer exists or its storage was removed");
                        unreadableDirs++;
                        continue;
                    }
                    if (node.depth == 0) rootRead = true;
                    while (c.moveToNext()) {
                        String id = c.getString(0);
                        String name = c.getString(1);
                        String mime = c.getString(2);
                        if (id == null || name == null) continue;
                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                            if (name.startsWith(".")) continue;          // hidden folders (.thumbnails, .trash …)
                            if (node.depth < MAX_DEPTH) {
                                queue.add(new Node(id, node.path.isEmpty() ? name : node.path + "/" + name, node.depth + 1));
                            } else {
                                depthLimited = true;                     // deeper folders exist but are not scanned
                            }
                            continue;
                        }
                        boolean pdf = "application/pdf".equals(mime) || name.toLowerCase().endsWith(".pdf");
                        if (!pdf) continue;
                        if (files.length() >= MAX_FILES) { truncatedWhy = "files"; break; }
                        JSONObject f = new JSONObject();
                        f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        f.put("name", name);
                        f.put("size", c.isNull(3) ? -1L : c.getLong(3));
                        f.put("modified", c.isNull(4) ? 0L : c.getLong(4));
                        f.put("path", node.path);
                        files.put(f);
                    }
                    if (truncatedWhy != null) break;
                } catch (SecurityException e) {
                    return failure(out, "ACCESS_REVOKED", "Access to this folder was removed");
                } catch (Exception e) {
                    if (node.depth == 0) return rootExists(tree)
                            ? failure(out, "UNREADABLE", FileSaver.describe(e))
                            : failure(out, "ACCESS_REVOKED", "This folder no longer exists or its storage was removed");
                    unreadableDirs++;
                    Log.w(TAG, "Skipping unreadable folder", e);
                }
            }
            out.put("ok", true);
            out.put("files", files);
            if (truncatedWhy == null && depthLimited) truncatedWhy = "depth";
            out.put("truncated", truncatedWhy != null);
            out.put("truncatedReason", truncatedWhy == null ? "" : truncatedWhy);
            out.put("scannedFolders", dirs);
            out.put("unreadableFolders", unreadableDirs);
            out.put("rootRead", rootRead);
        } catch (SecurityException e) {
            return failure(out, "ACCESS_REVOKED", "Access to this folder was removed");
        } catch (Exception e) {
            Log.e(TAG, "listPdfs failed", e);
            return failure(out, "ERROR", FileSaver.describe(e));
        }
        return out;
    }

    private static JSONObject failure(JSONObject o, String code, String message) {
        try {
            o.put("ok", false);
            o.put("error", code);
            o.put("message", message);
        } catch (JSONException ignored) { /* keys are constants */ }
        return o;
    }
}
