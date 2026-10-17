#!/usr/bin/env bash
# Usage: scripts/verify-apk.sh [new.apk] [--previous installed-or-old.apk]
# Verifies a built FYLO APK (and, with --previous, that it can UPDATE that APK): version metadata matches APP_VERSION, applicationId is stable, and the packaged web
# assets are the CURRENT ones (byte-identical to fylo-web/). Usage: scripts/verify-apk.sh [path/to/app-debug.apk]
set -euo pipefail
cd "$(dirname "$0")/.."
PREV=""; APK=""
while [ $# -gt 0 ]; do case "$1" in --previous) PREV="$2"; shift 2;; *) APK="$1"; shift;; esac; done
APK="${APK:-app/build/outputs/apk/debug/app-debug.apk}"
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
echo "--- signing certificate (an update is only accepted if this matches the installed app) ---"
APKSIGNER=$(ls "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)
cert() {
  # apksigner first; keytool as a fallback (its output format differs between versions, so parse loosely).
  local out c
  out=$("$APKSIGNER" verify --print-certs "$1" 2>&1 || true)
  c=$(grep -i 'certificate SHA-256 digest' <<<"$out" | head -1 | sed 's/.*: *//' | tr -d ' \r')
  if [ -z "$c" ]; then
    out=$(keytool -printcert -jarfile "$1" 2>&1 || true)
    c=$(grep -i 'SHA256:' <<<"$out" | head -1 | sed 's/.*SHA256: *//' | tr -d ': \r' | tr 'A-F' 'a-f')
  fi
  if [ -z "$c" ]; then echo "DEBUG could not read a signer from $1:" >&2; echo "$out" | head -8 >&2; fi
  tr 'A-F' 'a-f' <<<"$c"
}
if [ -z "$APKSIGNER" ]; then
  echo "WARN apksigner not found - cannot check the signing certificate"; fail=1
else
  NEWCERT=$(cert "$APK"); echo "new APK signer SHA-256: $NEWCERT"
  EXPECT=$(tr -d ' \n\r' < signing/expected-cert-sha256.txt 2>/dev/null || true)
  if [ -n "${KEYSTORE_PROPERTIES_IN_USE:-}" ] || [ -f keystore.properties ]; then echo "INFO keystore.properties present - using YOUR key; skipping the committed-key fingerprint check"
  elif [ -n "$EXPECT" ]; then chk "signer == committed FYLO key" "$NEWCERT" "$EXPECT"; fi
  if [ -n "$PREV" ]; then
    echo "--- update compatibility vs $PREV ---"
    PB=$("$AAPT" dump badging "$PREV" | head -1)
    PPKG=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$PB"); PCODE=$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$PB")
    chk "same package name" "$PKG" "$PPKG"
    PCERT=$(cert "$PREV"); echo "previous APK signer SHA-256: $PCERT"
    chk "same signing certificate" "$NEWCERT" "$PCERT"
    NCODE=$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGE")
    if [ "$NCODE" -gt "$PCODE" ]; then echo "OK   versionCode $PCODE -> $NCODE (higher)"; else echo "FAIL versionCode must be higher than $PCODE (got $NCODE)"; fail=1; fi
  fi
fi
[ $fail -eq 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
