package com.fylo.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Saves files produced by the web layer to places the user can actually reach, and VERIFIES them.
 *
 * Protocol (driven from JS in chunks so a 300 MB export never has to exist as one string):
 *   begin(kind, subdir, filename, mime)  -> {ok, id}
 *   chunk(id, base64)                    -> {ok, written}
 *   end(id)                              -> {ok, name, path, uri, bytes}   (only after a size read-back matches)
 *   abort(id)
 *
 * Destinations
 *   API 29+ : MediaStore  -> Download/FYLO[/subdir]  (documents, backups)   or   Pictures/FYLO[/subdir]  (images)
 *   API 26-28: app-specific external storage (no permission needed): Android/data/<pkg>/files/{Download|Pictures}/FYLO
 *              (the previous code referenced MediaStore.Downloads unconditionally, which does not exist before API 29)
 */
final class FileSaver {

    private static final String TAG = "FYLO.Saver";
    private static final String ROOT_DIR = "FYLO";
    private static final int MAX_SESSIONS = 8;

    private static final class Session {
        String id;
        String displayName;
        String mime;
        String subdir = "";
        boolean image;
        boolean media;
        Uri uri;
        File file;
        OutputStream out;
        long written;
        String relPath = "";
    }

    private final Context ctx;
    private final Map<String, Session> sessions = new HashMap<>();

    FileSaver(Context context) {
        this.ctx = context.getApplicationContext();
    }

    // ── Public protocol ───────────────────────────────────────────────────────

    synchronized String begin(String kind, String subdir, String filename, String mime) {
        try {
            if (sessions.size() >= MAX_SESSIONS) return fail("Too many saves in progress");
            Session s = new Session();
            s.id = UUID.randomUUID().toString();
            s.image = "image".equals(kind);
            s.subdir = safeName(subdir, "");
            s.displayName = safeName(filename, s.image ? "image" : "fylo-export");
            s.mime = (mime == null || mime.isEmpty()) ? guessMime(s.displayName) : mime;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) openMediaStore(s);
            else openLegacyFile(s);
            sessions.put(s.id, s);
            return json("ok", true, "id", s.id);
        } catch (Exception e) {
            Log.e(TAG, "begin failed", e);
            return fail(describe(e));
        }
    }

    synchronized String chunk(String id, String base64) {
        Session s = sessions.get(id);
        if (s == null) return fail("Unknown save session");
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            s.out.write(data);
            s.written += data.length;
            return json("ok", true, "written", s.written);
        } catch (Exception e) {
            Log.e(TAG, "chunk failed", e);
            sessions.remove(id);
            discard(s);
            return fail(describe(e));
        }
    }

    synchronized String end(String id) {
        Session s = sessions.remove(id);
        if (s == null) return fail("Unknown save session");
        try {
            s.out.flush();
            s.out.close();
            s.out = null;
            long actual = sizeOf(s);
            if (actual != s.written) {
                throw new IOException("Size check failed: wrote " + s.written + " bytes but found " + actual);
            }
            String path;
            String uri;
            String name = s.displayName;
            if (s.media) {
                finishMedia(s);
                name = readDisplayName(s);
                path = s.relPath + "/" + name;
                uri = s.uri.toString();
            } else {
                path = s.file.getAbsolutePath();
                uri = legacyUri(s.file);
            }
            return json("ok", true, "name", name, "path", path, "uri", uri, "bytes", actual);
        } catch (Exception e) {
            Log.e(TAG, "end failed", e);
            discard(s);
            return fail(describe(e));
        }
    }

    synchronized void abort(String id) {
        Session s = sessions.remove(id);
        if (s != null) discard(s);
    }

    synchronized void abortAll() {
        List<Session> all = new ArrayList<>(sessions.values());
        sessions.clear();
        for (Session s : all) discard(s);
    }

    /** One-shot save (kept for the old saveFile bridge method). */
    String saveAll(byte[] data, String kind, String subdir, String filename, String mime) {
        String begin = begin(kind, subdir, filename, mime);
        try {
            JSONObject b = new JSONObject(begin);
            if (!b.optBoolean("ok")) return begin;
            String id = b.getString("id");
            String r = chunk(id, Base64.encodeToString(data, Base64.NO_WRAP));
            if (!new JSONObject(r).optBoolean("ok")) return r;
            return end(id);
        } catch (JSONException e) {
            return fail(describe(e));
        }
    }

    // ── Destinations ──────────────────────────────────────────────────────────

    @RequiresApi(Build.VERSION_CODES.Q)
    private void openMediaStore(Session s) throws IOException {
        ContentResolver cr = ctx.getContentResolver();
        String base = s.image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS;
        s.relPath = base + "/" + ROOT_DIR + (s.subdir.isEmpty() ? "" : "/" + s.subdir);

        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, s.displayName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, s.mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, s.relPath);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri collection = s.image
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = cr.insert(collection, v);
        if (uri == null) throw new IOException("The system refused to create the file");
        s.uri = uri;
        s.media = true;
        try {
            s.out = cr.openOutputStream(uri, "w");
        } catch (IOException | RuntimeException e) {
            cr.delete(uri, null, null);
            throw e;
        }
        if (s.out == null) {
            cr.delete(uri, null, null);
            throw new IOException("Could not open the file for writing");
        }
    }

    private void openLegacyFile(Session s) throws IOException {
        File base = ctx.getExternalFilesDir(s.image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS);
        if (base == null) base = ctx.getFilesDir();
        File dir = new File(base, ROOT_DIR);
        if (!s.subdir.isEmpty()) dir = new File(dir, s.subdir);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create folder " + dir.getAbsolutePath());
        File f = uniqueFile(dir, s.displayName);
        s.file = f;
        s.displayName = f.getName();
        s.media = false;
        s.out = new FileOutputStream(f);
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private void finishMedia(Session s) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        ctx.getContentResolver().update(s.uri, v, null, null);
    }

    private String readDisplayName(Session s) {
        try (Cursor c = ctx.getContentResolver().query(
                s.uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) { /* fall back to the requested name */ }
        return s.displayName;
    }

    private long sizeOf(Session s) throws IOException {
        if (!s.media) return s.file.length();
        ContentResolver cr = ctx.getContentResolver();
        try (AssetFileDescriptor afd = cr.openAssetFileDescriptor(s.uri, "r")) {
            if (afd != null && afd.getLength() >= 0) return afd.getLength();
        }
        try (Cursor c = cr.query(s.uri, new String[]{MediaStore.MediaColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        }
        throw new IOException("Could not verify the saved file");
    }

    private String legacyUri(File f) {
        try {
            return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f).toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void discard(Session s) {
        try { if (s.out != null) s.out.close(); } catch (Exception ignored) { /* best effort */ }
        s.out = null;
        try {
            if (s.media && s.uri != null) ctx.getContentResolver().delete(s.uri, null, null);
            else if (s.file != null) //noinspection ResultOfMethodCallIgnored
                s.file.delete();
        } catch (Exception ignored) { /* best effort */ }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Basename only; no separators, control or reserved characters; bounded length. */
    static String safeName(String raw, String fallback) {
        if (raw == null) raw = "";
        int cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
        String n = cut >= 0 ? raw.substring(cut + 1) : raw;
        n = n.replaceAll("[\\p{Cntrl}:*?\"<>|]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = (dot > 0 && n.length() - dot <= 8) ? n.substring(dot) : "";
            n = n.substring(0, 120 - ext.length()) + ext;
        }
        return n.isEmpty() ? fallback : n;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 10000; i++) {
            f = new File(dir, stem + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, stem + "-" + System.currentTimeMillis() + ext);
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    static String describe(Throwable t) {
        String m = t.getMessage();
        if (m != null && (m.contains("ENOSPC") || m.toLowerCase().contains("no space"))) {
            return "Not enough free storage space on the device";
        }
        if (m == null || m.isEmpty()) return t.getClass().getSimpleName();
        return m;
    }

    private static String fail(String error) {
        return json("ok", false, "error", error);
    }

    /** Builds a flat JSON object from key/value pairs. */
    static String json(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]);
        } catch (JSONException ignored) { /* keys are never null */ }
        return o.toString();
    }
}
