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
        o.put("accessible", isGranted(tree) && rootExists(tree));
        return o;
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
                        if (node.depth == 0) return failure(out, "UNREADABLE", "This folder could not be read");
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
                    if (node.depth == 0) return failure(out, "UNREADABLE", FileSaver.describe(e));
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
