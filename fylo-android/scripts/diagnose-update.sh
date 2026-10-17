#!/usr/bin/env bash
# Finds out WHY an APK will not install over an installed FYLO. Run with: bash scripts/diagnose-update.sh <new.apk> [installed.apk]
#
#  * With a phone attached over USB debugging (adb), it pulls the installed APK, compares both APKs, then runs
#    `adb install -r` and prints Android's exact PackageManager error (e.g. INSTALL_FAILED_UPDATE_INCOMPATIBLE).
#  * Without adb, pass the installed APK yourself (extract it on the phone with an app such as "App Manager" or
#    "ML Manager" and copy it to the computer) — the comparison part still works.
# Needs: apksigner + aapt from the Android SDK build-tools (ANDROID_HOME), or just keytool (signer only).
set -u
NEW="${1:-}"; OLD="${2:-}"
[ -f "$NEW" ] || { echo "usage: $0 <new.apk> [installed.apk]"; exit 2; }
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
BT=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)
AAPT=""; APKSIGNER=""
[ -n "$BT" ] && [ -x "$BT/aapt" ] && AAPT="$BT/aapt"
[ -n "$BT" ] && [ -x "$BT/apksigner" ] && APKSIGNER="$BT/apksigner"
command -v aapt >/dev/null 2>&1 && [ -z "$AAPT" ] && AAPT=aapt
command -v apksigner >/dev/null 2>&1 && [ -z "$APKSIGNER" ] && APKSIGNER=apksigner

signer() {
  local out c
  [ -n "$APKSIGNER" ] && out=$("$APKSIGNER" verify --print-certs "$1" 2>&1 || true) && \
    c=$(grep -i 'certificate SHA-256 digest' <<<"$out" | head -1 | sed 's/.*: *//' | tr -d ' \r')
  if [ -z "${c:-}" ]; then
    out=$(keytool -printcert -jarfile "$1" 2>&1 || true)
    c=$(grep -i 'SHA256:' <<<"$out" | head -1 | sed 's/.*SHA256: *//' | tr -d ': \r')
  fi
  tr 'A-F' 'a-f' <<<"${c:-}"
}
field() { sed -n "$2" <<<"$1" | head -1; }
identity() { # $1 label $2 file
  local b=""; [ -n "$AAPT" ] && b=$("$AAPT" dump badging "$2" 2>/dev/null || true)
  PKG=$(field "$b" "s/^package: name='\([^']*\)'.*/\1/p"); VC=$(field "$b" "s/.*versionCode='\([^']*\)'.*/\1/p")
  VN=$(field "$b" "s/.*versionName='\([^']*\)'.*/\1/p"); MIN=$(field "$b" "s/^sdkVersion:'\([^']*\)'.*/\1/p")
  TGT=$(field "$b" "s/^targetSdkVersion:'\([^']*\)'.*/\1/p"); ABI=$(field "$b" "s/^native-code: *//p")
  TEST=$(grep -c "testOnly" <<<"$b" || true); SIG=$(signer "$2")
  echo "== $1: $2"; echo "   package        $PKG"; echo "   versionCode    $VC   versionName $VN"
  echo "   minSdk/target  $MIN / $TGT   abi: ${ABI:-none (pure Java/JS)}   testOnly: $([ "${TEST:-0}" -gt 0 ] && echo YES || echo no)"
  echo "   signer SHA-256 ${SIG:-<could not read>}"
}

identity "NEW" "$NEW"; N_PKG=$PKG; N_VC=$VC; N_SIG=$SIG; N_TEST=$TEST

if [ -z "$OLD" ] && command -v adb >/dev/null 2>&1 && [ -n "$(adb devices | sed 1d | grep -w device)" ]; then
  P="$N_PKG"; [ -n "$P" ] || P="com.fylo.app.debug"
  LOC=$(adb shell pm path "$P" 2>/dev/null | head -1 | tr -d '\r' | sed 's/^package://')
  if [ -n "$LOC" ]; then OLD=/tmp/fylo-installed-$$.apk; adb pull "$LOC" "$OLD" >/dev/null && echo "(pulled installed APK from $LOC)"; else echo "Package $P is not installed on the attached device."; fi
fi

verdict=0
if [ -n "$OLD" ] && [ -f "$OLD" ]; then
  identity "INSTALLED" "$OLD"; O_PKG=$PKG; O_VC=$VC; O_SIG=$SIG
  echo "== verdict"
  [ "$N_PKG" = "$O_PKG" ] && echo "OK    same package" || { echo "FAIL  package differs ($O_PKG vs $N_PKG): this is a different app, not an update"; verdict=1; }
  if [ -n "$N_SIG" ] && [ "$N_SIG" = "$O_SIG" ]; then echo "OK    same signing certificate"
  else echo "FAIL  signing certificate differs -> Android refuses the update (INSTALL_FAILED_UPDATE_INCOMPATIBLE). The installed app was signed with a key we do not have."; verdict=1; fi
  if [ -n "$N_VC" ] && [ -n "$O_VC" ]; then [ "$N_VC" -gt "$O_VC" ] && echo "OK    versionCode $O_VC -> $N_VC" || { echo "FAIL  versionCode not higher ($O_VC -> $N_VC) -> INSTALL_FAILED_VERSION_DOWNGRADE"; verdict=1; }; fi
  [ "${N_TEST:-0}" -gt 0 ] && { echo "FAIL  new APK is testOnly"; verdict=1; }
fi

if command -v adb >/dev/null 2>&1 && [ -n "$(adb devices | sed 1d | grep -w device)" ]; then
  echo "== adb install -r (this is the real PackageManager answer)"; adb logcat -c 2>/dev/null
  RES=$(adb install -r "$NEW" 2>&1); echo "$RES"
  adb logcat -d -s PackageManager:W PackageInstaller:W 2>/dev/null | tail -15
  case "$RES" in *Success*) echo "RESULT: in-place update VERIFIED on the attached device"; exit 0;; *) echo "RESULT: install failed - see the [INSTALL_FAILED_...] code above"; exit 1;; esac
fi
echo "(no adb device: the comparison above is static; run again with the phone attached for the real install result)"
exit $verdict
