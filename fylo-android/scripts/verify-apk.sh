#!/usr/bin/env bash
# Verifies a built FYLO APK: version metadata matches APP_VERSION, applicationId is stable, and the packaged web
# assets are the CURRENT ones (byte-identical to fylo-web/). Usage: scripts/verify-apk.sh [path/to/app-debug.apk]
set -euo pipefail
cd "$(dirname "$0")/.."
APK="${1:-app/build/outputs/apk/debug/app-debug.apk}"
[ -f "$APK" ] || { echo "FAIL: APK not found: $APK"; exit 1; }
WEB=../fylo-web
VER=$(sed -n "s/.*APP_VERSION *= *'\([0-9]*\.[0-9]*\.[0-9]*\)'.*/\1/p" $WEB/core/constants.js | head -1)
[ -n "$VER" ] || { echo "FAIL: cannot read APP_VERSION"; exit 1; }
IFS=. read -r MA MI PA <<<"$VER"; CODE=$((MA*10000+MI*100+PA))

# aapt2 from the SDK build-tools (or aapt)
AAPT=$(command -v aapt2 || true)
[ -z "$AAPT" ] && AAPT=$(ls "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)
[ -n "$AAPT" ] || { echo "FAIL: aapt2 not found (set ANDROID_HOME)"; exit 1; }
BADGE=$("$AAPT" dump badging "$APK" | head -1)
echo "$BADGE"
fail=0
chk() { if [ "$2" = "$3" ]; then echo "OK   $1 = $3"; else echo "FAIL $1: expected '$3', got '$2'"; fail=1; fi; }
chk versionName "$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGE")" "$VER"
chk versionCode "$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGE")" "${FYLO_EXPECT_CODE:-$CODE}"
PKG=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$BADGE")
case "$PKG" in com.fylo.app|com.fylo.app.debug) echo "OK   applicationId = $PKG";; *) echo "FAIL applicationId unexpected: $PKG"; fail=1;; esac

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
unzip -q "$APK" 'assets/www/*' 'assets/libs/*' -d "$TMP" 2>/dev/null || true
# Web assets in the APK must equal fylo-web/ (nothing stale, nothing missing). Libraries only exist on the Android side.
while IFS= read -r f; do
  rel=${f#$WEB/}
  if [ ! -f "$TMP/assets/www/$rel" ]; then echo "FAIL missing in APK: $rel"; fail=1
  elif ! cmp -s "$f" "$TMP/assets/www/$rel"; then echo "FAIL stale in APK (differs from fylo-web): $rel"; fail=1; fi
done < <(find $WEB -type f)
[ $fail -eq 0 ] && echo "OK   all $(find $WEB -type f | wc -l) web files in the APK are identical to fylo-web/"
grep -q "APP_VERSION = '$VER'" "$TMP/assets/www/core/constants.js" && echo "OK   packaged constants.js carries $VER" || { echo "FAIL packaged constants.js version"; fail=1; }
for lib in pdf-lib.min.js pdf.min.js pdf.worker.min.js; do
  if [ -f "$TMP/assets/www/assets/libs/$lib" ] || [ -f "$TMP/assets/libs/$lib" ]; then echo "OK   $lib packaged"; else echo "WARN $lib not packaged (run ./gradlew fetchPdfLibs first; the app falls back to CDN without it)"; fi
done
echo "--- signing certificate (updates require this to match the installed build) ---"
APKSIGNER=$(ls "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)
[ -n "$APKSIGNER" ] && "$APKSIGNER" verify --print-certs "$APK" | grep -i "SHA-256" || echo "(apksigner not found — compare certificates with: keytool -printcert -jarfile $APK)"
[ $fail -eq 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
