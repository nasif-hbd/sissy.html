VOCABX FOR MACOS

Double-click VocabX. It opens VocabX in your browser and keeps serving it until
you quit it. No installer, no runtime, nothing written outside the app.

THE FIRST TIME: RIGHT-CLICK, THEN OPEN

macOS blocks apps from developers who have not paid Apple for a certificate.
The first time only:

    Right-click (or Control-click) VocabX  →  Open  →  Open

After that, a normal double-click works. If macOS still refuses, run this once
in Terminal, from the folder you unzipped into:

    xattr -dr com.apple.quarantine VocabX.app

That removes the "downloaded from the internet" flag. Nothing else changes.

WHAT IT IS

VocabX is a web app. On a desktop the honest way to run it is to serve the same
files over loopback and open the browser at them, and that is all this does.

  · It serves ONLY the app folder inside the bundle
  · It listens ONLY on 127.0.0.1 — nothing is exposed to your network
  · It uploads nothing, and needs no internet connection at all

The launcher is a Perl script — /usr/bin/perl, which macOS has always shipped —
rather than a compiled binary, because a Mac binary has to be linked on a Mac
and this way the download needs nothing installed and nothing fetched. You can
read the whole of it: right-click VocabX → Show Package Contents →
Contents/Resources/vocabx.pl. It is about 130 lines.

WHERE TO PUT IT

Drag VocabX to your Applications folder, or leave it wherever you like. It is
self-contained; there is nothing else to move.

CLOSING IT

It has no window of its own — the app is the browser tab. Quit it from the Dock
(right-click → Quit; choose Force Quit if macOS offers it, which is normal for
an app with no window), or leave it: it uses almost nothing while idle.

IF YOU WOULD RATHER NOT RUN AN UNSIGNED APP

A fair position, and you do not need it. Open the app in Safari and choose
File → "Add to Dock", or install it from Chrome or Edge. You get the same
thing: a Dock icon, its own window, and offline support.
