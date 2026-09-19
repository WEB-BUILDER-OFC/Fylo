# FYLO ProGuard rules
# Keep JavaScript interface methods accessible from WebView
-keepclassmembers class com.fylo.app.MainActivity$FyloBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.fylo.app.UriUtils {
    public static *;
}
# Keep AppCompat
-keep class androidx.appcompat.** { *; }
