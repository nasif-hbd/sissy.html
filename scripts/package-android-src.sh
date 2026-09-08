#!/usr/bin/env bash
# Package everything needed to build the Android app, and nothing else.
#
# The Gradle build copies the web app in from ../vocab, so the android folder
# alone is not buildable — it needs vocab/ sitting beside it. That is the whole
# reason this exists rather than "just zip the android folder": a zip that
# builds nothing looks identical to one that works until the moment it fails.
#
#   ./scripts/package-android-src.sh    → download/vocabx-android-source.zip
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(pwd)/download/vocabx-android-source.zip
STAGE=$(mktemp -d)/vocabx-android-source
trap 'rm -rf "$(dirname "$STAGE")"' EXIT
mkdir -p "$STAGE"

# The Android project, minus anything a build makes or a machine owns.
mkdir -p "$STAGE/android"
(cd android && tar --exclude=build --exclude=.gradle --exclude='src/main/assets' \
   --exclude=local.properties --exclude='*.jks' --exclude=keystore.properties \
   --exclude='*.apk' --exclude='*.aab' -cf - .) | (cd "$STAGE/android" && tar -xf -)

# The web app the build copies in. Named part by part rather than wholesale, so
# nothing new under vocab/ reaches the APK without someone deciding it should.
mkdir -p "$STAGE/vocab"
for part in index.html styles.css sw.js manifest.webmanifest js data fonts icons; do
  cp -r "vocab/$part" "$STAGE/vocab/"
done

# The two pieces the build cannot start without.
for need in android/gradlew.bat android/gradle/wrapper/gradle-wrapper.jar \
            android/app/build.gradle vocab/index.html vocab/data/dict/index.json; do
  [ -e "$STAGE/$need" ] || { echo "packaging lost $need"; exit 1; }
done

# Nothing with a key in it, ever.
if find "$STAGE" -name '.env' -o -name '*.key' -o -name '*.jks' \
   -o -name 'keystore.properties' | grep -q .; then
  echo "refusing to package: a secret reached the staging directory"; exit 1
fi

cat > "$STAGE/BUILD-THE-APP.txt" <<'NOTE'
BUILDING VOCABX FOR ANDROID

Everything needed is in this folder. Keep android/ and vocab/ together — the
build copies the app in from vocab/, and moving either one apart breaks it.

BEFORE YOU START, ONCE

  1. Android Studio, for the SDK:  https://developer.android.com/studio
     Open it once, let it download, close it. In its SDK Manager, have
     "Android 15.0 (API 35)" ticked under SDK Platforms.

  2. Java 21 — and it must be 21, not the newest. Android Studio ships Java 25
     inside it, which Gradle cannot read; the error is "Unsupported class file
     major version 69".  https://adoptium.net/temurin/releases/
     Set Version to "21 - LTS", Windows, x64, JDK, and run the .msi. Tick
     "Set JAVA_HOME variable" during install.

THEN, EVERY TIME

  Open the android folder in File Explorer, click the address bar at the top,
  type  cmd  and press Enter. In that black window:

      (echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk)>local.properties
      gradlew.bat assembleDebug

  The first build downloads a few hundred megabytes and takes ten minutes.
  After that it takes seconds.

  Your app:  android\app\build\outputs\apk\debug\app-debug.apk
  It should be roughly 10 MB. Much smaller means the web app did not get
  copied in, and the app will open to a blank screen.

INSTALLING IT

  Use adb rather than copying the file to the phone — Android reports a failed
  sideload as "App wasn't installed" and tells you nothing, while adb prints
  the actual reason:

      "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb" install -r app\build\outputs\apk\debug\app-debug.apk

  It needs USB debugging on: Settings > About phone > tap Build number seven
  times, then Settings > System > Developer options > USB debugging.

There is more, including how to sign a release build, in android/README.md.
NOTE

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$(dirname "$STAGE")" && zip -qr "$OUT" vocabx-android-source)
echo "packaged $(du -h "$OUT" | cut -f1)  $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files  →  $OUT"
