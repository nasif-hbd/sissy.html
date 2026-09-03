# VocabX for Android

Builds `VocabX.apk` — the real app, with everything inside it.

Every word, all fourteen packs, the grammar bank and the fonts are packed into
the APK. It works on a plane, on a dead SIM, and on the very first launch after
install. The only thing that ever touches the network is the AI assistant, and
the app is complete without it.

---

## How it works

One activity holding one WebView, which serves the bundled app from inside the
APK. There is no rewrite of VocabX in Java, because a second implementation
would be a second thing to keep correct.

The one subtlety worth knowing: it does **not** load the files as `file://`
URLs. A `file://` page has no origin, and a page with no origin cannot run ES
modules, cannot use `localStorage`, and cannot register a service worker —
which is to say the app would not run at all. `WebViewAssetLoader` serves the
same files over `https://appassets.androidplatform.net/`, a real secure origin
that never touches the network, and everything behaves as it does in a browser.

`bundleWebApp` copies `../vocab` into the APK on every build, so there is no
step to forget. It is a `Sync`, not a `Copy`: a file deleted from the site is
deleted from the app too, rather than lingering as a page nobody can reach.

**The trade:** the app carries its own copy, so a website deploy is not an app
update. Ship a new APK when you want people on a new version.

### The two things WebView does not have

Android's WebView is not quite a browser, and two gaps would have shown up as
features that silently do nothing rather than as errors.

**Notifications.** WebView implements no part of the Web Notifications API, so
the whole reminder feature — the thing people most expect from an app on a
phone — would have been dead inside the app. `AndroidHost` is the other side of
that bridge: the page calls it and a real system notification appears, with the
same `granted`/`denied`/`default` answers the web API gives, so `notify.js`
needs no special case beyond asking which one it is talking to. The bridge is
deliberately three methods wide. It reads nothing, writes no files and takes no
URL, because a bridge is the one place where a bug in the page becomes a bug on
the phone.

**Downloads.** A download link in a WebView does nothing at all unless
something is listening, so Settings' offer of the desktop app would have looked
broken rather than unsupported. `setDownloadListener` hands it to Android's own
download manager.

There is a third, on the server rather than here: the app's origin is
`https://appassets.androidplatform.net`, fixed by Android. If your Worker pins
`ALLOWED_ORIGIN` to your website — and it should — that origin has to be
allowed too, or the AI assistant is off inside the app with a CORS error nobody
sees. The Worker allows it by default; `tests/worker.test.mjs` pins that it
still refuses everyone else.

### What has and has not been checked

Verified here: the Gradle files parse, the XML is valid, the Java has no syntax
errors, the wrapper runs, and the icons are cut from the same source as the
website's.

**Not built here, and it cannot be.** The Android build tools are published
only on `dl.google.com`, which the machine this was written on gets a 403 from.
Your machine does the first real compile.

---

## Step 1 — Install the tools

**Android Studio** brings the SDK: <https://developer.android.com/studio>
Open it once, let it finish downloading, then close it. You never need the
interface.

In the SDK Manager (**More Actions → SDK Manager**), make sure you have:

- **SDK Platforms:** Android 15.0 (API 35)
- **SDK Tools:** Android SDK Build-Tools, Platform-Tools, Command-line Tools

Copy the **Android SDK Location** path from the top of that window.

**Java 21** — and it must be 21, not the newest. Android Studio ships Java 25
inside it, and Gradle 8.9 cannot read Java 25 class files; the error is
`Unsupported class file major version 69`, which names nothing helpful.

<https://adoptium.net/temurin/releases/> — set **Version: 21 - LTS**, Windows,
x64, JDK, and download the `.msi`. During install, enable **Set JAVA_HOME
variable**.

## Step 2 — Point the build at the SDK

Open a terminal in this folder and run (Windows):

```bat
(echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk)>local.properties
```

macOS or Linux:

```bash
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
```

Check it with `type local.properties` (or `cat`). Forward slashes, no trailing
space. `local.properties` is a Java properties file, where `\` escapes the next
character — `C:\Users` is read as `C:Users`, and the build then reports the SDK
missing while it sits right there. Forward slashes have no such meaning and
work fine on Windows.

## Step 3 — Build a test APK

```bash
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
```

First run downloads Gradle and the Android plugin — a few hundred megabytes.
After that it takes seconds.

Your APK: `app/build/outputs/apk/debug/app-debug.apk`, around 10 MB — most of
it dictionary.

Install it with the phone plugged in and USB debugging on:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`adb` lives in `<SDK>/platform-tools/`. Prefer it over copying the file to the
phone: Android reports a failed sideload as "App wasn't installed" with no
reason, while `adb` prints the actual cause.

## Step 4 — Make your signing key

The same key must sign every future update.

> **If you lose this key, you can never update the app again.** Not "it is
> difficult" — Google will not allow it. Back it up somewhere you will still
> have in five years.

```bash
keytool -genkey -v -keystore vocabx.jks -alias vocabx \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then `keystore.properties` beside this file:

```properties
storeFile=vocabx.jks
storePassword=whatever-you-chose
keyAlias=vocabx
keyPassword=whatever-you-chose
```

Both that file and `vocabx.jks` are gitignored. Never commit either — anyone
holding them can publish updates as you.

## Step 5 — Build the real thing

```bash
./gradlew assembleRelease
```

Signed APK: `app/build/outputs/apk/release/app-release.apk`. That is the file
to put on your website or hand to people directly.

For the Play Store, Google wants a bundle instead:

```bash
./gradlew bundleRelease        # → app/build/outputs/bundle/release/app-release.aab
```

## Putting it on your own site

```bash
cp app/build/outputs/apk/release/app-release.apk ../download/vocabx-android.apk
```

Then uncomment the `android` entry at the bottom of `DOWNLOADS` in
`vocab/js/install.js`, and every Android visitor is offered the file. Leave it
commented until the APK is actually there — a button pointing at a missing file
is worse than no button.

Installing an APK directly makes Android ask permission to install from an
unknown source. That is normal for anything outside the Play Store, and the
note in `DOWNLOADS` says so rather than letting people hit it cold.

## Every time you release

1. Bump `versionCode` **and** `versionName` in `app/build.gradle`.
   Play rejects a `versionCode` it has seen before.
2. `./gradlew bundleRelease`
3. Upload.

Unlike the desktop downloads, this one carries its own copy of the app — so a
website deploy does not update it. Rebuild when you want people on a new
version.

---

## When it goes wrong

**`Unsupported class file major version 69`** — you are building with Java 25.
Install Java 21 and point `JAVA_HOME` at it. 69 means Java 25; 65 means 21.

**`SDK location not found`** — `local.properties` is missing or its path is
wrong. On Windows, check you used forward slashes.

**`Failed to resolve: androidx.webkit`** — no internet, or a proxy blocking
Google's Maven. The Android build tools are published only on `dl.google.com`;
an offline machine cannot build an Android app at all.

**"App wasn't installed" on the phone** — Android's catch-all. Use
`adb install -r …` to get the real reason. Common ones: an older build signed
with a different key is already installed (uninstall it first), or Play Protect
is blocking it (Play Store → profile → Play Protect → settings → turn off
scanning, install, turn it back on).

**Blank screen on launch** — the assets did not make it into the APK. Run
`./gradlew clean assembleDebug` and check `app/src/main/assets/index.html`
exists after the build.

---

## What is in here

```
build.gradle              the Android plugin version, nothing else
settings.gradle           where Gradle looks for dependencies
gradle.properties         AndroidX on, memory limit
app/build.gradle          the whole build: package, version, signing, and the
                          task that copies the web app into the APK
app/src/main/
  java/…/MainActivity.java  one activity, one WebView, the asset loader
  AndroidManifest.xml       the launcher and one permission
  res/values/               name, colours, theme
  res/mipmap-*/             the launcher icon, cut from brand/vocabx.png
  assets/                   the web app — generated on every build, gitignored
```

The icons are generated, not hand-made: `node scripts/build-icons.mjs --android`
from `vocab/` recuts them from the same source as the favicon, so the launcher
icon can never drift from the one on the website.
