# VocabX for Android

This folder builds `VocabX.apk` — a real Android app you can install, or upload
to the Play Store.

Everything is already written. You need to install the build tools, make a
signing key, and run one command. It takes about an hour the first time and
about a minute every time after.

---

## What this actually is

There is no app code in here, and that is deliberate.

The app is a **Trusted Web Activity**: Android opens your website in Chrome
with all the browser interface removed. What lands on the phone is the same
app the website serves — the same offline dictionary, the same service worker,
the same everything. When you deploy an update to the site, the app updates
too, with no new APK.

The alternative — rewriting VocabX in Java — would be a second copy of the app
to keep in step with the first. This way there is one app.

**One consequence worth knowing up front:** the app loads from
`vocabx.ylarena.online`. It works offline *after* the first launch, because the
service worker caches everything, but the very first launch needs internet.

### What has and has not been checked

Written and verified here: every Gradle file parses, every XML file is valid,
the Gradle wrapper runs, and the icons are cut from the same source as the
website's.

**Not built here, and it cannot be.** The Android build tools are published
only on `dl.google.com`, which the machine this was written on cannot reach —
it gets a 403 from the proxy. So the first real compile happens on your
machine, and if something needs a small correction, it will be in step 3. Send
me the error and I will fix it.

---

## Step 1 — Install the tools

You need two things: a Java JDK and the Android SDK.

**The easy way** is Android Studio, which brings both:
<https://developer.android.com/studio>

Install it, open it once, and let it finish downloading its components. Then
close it. You will not need the interface again.

**Check it worked.** Open a terminal and run:

```bash
java -version
```

You should see version 17 or higher. If you see "command not found", Android
Studio installed a JDK inside itself — use that one:

- **Windows:** `C:\Program Files\Android\Android Studio\jbr\bin`
- **macOS:** `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin`
- **Linux:** `~/android-studio/jbr/bin`

Add that folder to your PATH, or use the full path in the commands below.

---

## Step 2 — Tell the build where the SDK is

Create a file called `local.properties` in **this folder** with one line:

```properties
sdk.dir=/home/you/Android/Sdk
```

Use your real path:

- **Windows:** `sdk.dir=C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk`
  (double backslashes — a single one is an escape character and the build will
  say the SDK is missing when it is sitting right there)
- **macOS:** `sdk.dir=/Users/YourName/Library/Android/sdk`
- **Linux:** `sdk.dir=/home/YourName/Android/Sdk`

This file is gitignored, because the path is yours and not anyone else's.

---

## Step 3 — Build a test APK

From this folder:

```bash
./gradlew assembleDebug
```

Windows: `gradlew.bat assembleDebug`

The first run downloads Gradle and the Android plugin — a few hundred
megabytes, five to ten minutes. After that it takes seconds.

Your APK:

```
app/build/outputs/apk/debug/app-debug.apk
```

Copy it to your phone and open it. Android will warn about installing from an
unknown source; allow it. **The app will have a URL bar across the top** — that
is expected until step 5.

---

## Step 4 — Make your signing key

Every Android app is signed. The same key must sign every future update, so:

> **If you lose this key, you can never update the app again.** Not "it is
> difficult" — Google will not let you. Back it up somewhere you will still
> have in five years.

```bash
keytool -genkey -v -keystore vocabx.jks -alias vocabx \
  -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a password and some details. The details do not matter much; the
password does. Write it down.

Now create `keystore.properties` in this folder:

```properties
storeFile=vocabx.jks
storePassword=whatever-you-chose
keyAlias=vocabx
keyPassword=whatever-you-chose
```

Both this file and `vocabx.jks` are gitignored. Never commit either. Anyone who
has them can publish updates as you.

---

## Step 5 — Remove the URL bar

The URL bar disappears when your **website** publicly vouches for your **app**.
That is one file on the site.

From this folder:

```bash
./make-assetlinks.sh
```

It reads the fingerprint out of your key and writes
`../.well-known/assetlinks.json`.

Then rebuild and redeploy the site — `scripts/package-web.sh` picks that file
up automatically and will tell you it did:

```bash
cd .. && ./scripts/package-web.sh
```

Upload the new `download/vocabx-web.zip` to Cloudflare as usual, then check the
file is really live:

```bash
curl -s https://vocabx.ylarena.online/.well-known/assetlinks.json
```

If that returns your JSON, reinstall the app. The URL bar will be gone.

> **If you use Play App Signing** (Google re-signs your app when you upload it),
> the fingerprint that matters is *Google's*, not yours. Find it in the Play
> Console under **Release → Setup → App integrity → App signing key
> certificate**, then run:
>
> ```bash
> ./make-assetlinks.sh <that SHA-256 fingerprint>
> ```
>
> Getting this wrong is the number one reason the URL bar stays.
>
> The **debug** build always shows the URL bar, and cannot be fixed this way:
> it installs under a different package name (`…vocabx.debug`, so it can sit
> alongside the real one) and the asset-link names the real package. Test the
> URL bar with a release build.

---

## Step 6 — Build the real thing

```bash
./gradlew assembleRelease
```

Your signed APK:

```
app/build/outputs/apk/release/app-release.apk
```

That is the file to put on your website, or hand to people directly.

**For the Play Store**, Google wants a bundle rather than an APK:

```bash
./gradlew bundleRelease
```

which gives you `app/build/outputs/bundle/release/app-release.aab`.

---

## Putting it on your own site

Copy the APK into `download/` and it is served like the desktop app:

```bash
cp app/build/outputs/apk/release/app-release.apk ../download/vocabx-android.apk
```

Then add it to the download table in `vocab/js/install.js` — there is an
`android:` entry commented out at the bottom of `DOWNLOADS` with the exact
shape, so it is three lines uncommented rather than new code.

People installing an APK directly get a "install unknown apps" prompt from
Android. That is normal for anything not from the Play Store, and worth saying
plainly in the note rather than letting them hit it cold.

---

## Every time you release

1. Bump `versionCode` **and** `versionName` in `app/build.gradle`.
   Play rejects a `versionCode` it has seen before.
2. `./gradlew bundleRelease`
3. Upload.

You do **not** need to rebuild the app when you change the website. The app
loads the live site, so a site deploy is an app update.

---

## When it goes wrong

**"SDK location not found"** — `local.properties` is missing, or the path is
wrong. On Windows, check you used double backslashes.

**"Failed to resolve: com.google.androidbrowserhelper"** — no internet, or a
proxy blocking Google's Maven. The Android build tools are only published on
`dl.google.com`; an offline machine cannot build an Android app at all.

**The URL bar will not go away** — in order of likelihood: the assetlinks file
is not deployed yet; you used your own fingerprint when Play re-signed the app
with theirs; the file is served as HTML instead of JSON; you did not reinstall
the app after deploying. Android caches the check, so uninstall and reinstall
rather than just reopening.

**"App not installed"** on the phone — you already have a build signed with a
different key. Uninstall the old one first. (The debug build has a `.debug`
package suffix precisely so it can sit alongside the real one.)

**Blank screen on launch** — the site was unreachable on first run. A TWA needs
internet the first time; after that the service worker has it.

---

## What is in here

```
build.gradle              the Android plugin version, nothing else
settings.gradle           where Gradle looks for dependencies
gradle.properties         AndroidX on, memory limit
app/build.gradle          the whole app: package, version, signing, one library
app/src/main/
  AndroidManifest.xml     the launcher, the URL it opens, the permissions
  res/values/colors.xml   the ground colour, so the splash does not flash white
  res/values/styles.xml   no title bar
  res/drawable/splash.xml the launch screen
  res/xml/filepaths.xml   the only folder the app may hand files out from
  res/mipmap-*/           the launcher icon, cut from brand/vocabx.png
make-assetlinks.sh        writes the file that removes the URL bar
```

The icons are generated, not hand-made — `node scripts/build-icons.mjs --android`
from `vocab/` recuts them from the same source as the favicon, so the launcher
icon can never drift from the one on the website.
