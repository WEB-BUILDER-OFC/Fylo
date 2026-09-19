package com.fylo.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

public class UriUtils {

    /**
     * Extract a display filename from a content:// or file:// URI.
     * Returns null if the filename cannot be determined.
     */
    public static String getFileName(Context context, Uri uri) {
        if (uri == null) return null;

        String scheme = uri.getScheme();

        if ("content".equals(scheme)) {
            try (Cursor cursor = context.getContentResolver()
                    .query(uri, new String[]{OpenableColumns.DISPLAY_NAME},
                            null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) return cursor.getString(idx);
                }
            } catch (Exception e) {
                // Fall through to path-based extraction
            }
        }

        // Fallback: last path segment
        String path = uri.getPath();
        if (path != null) {
            int cut = path.lastIndexOf('/');
            if (cut >= 0) path = path.substring(cut + 1);
            if (!path.isEmpty()) return path;
        }

        return null;
    }
}
