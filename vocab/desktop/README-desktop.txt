VOCABX FOR THE DESKTOP

One folder, three launchers. Use the one for your system — the others are a
few kilobytes and you can ignore or delete them.

  Windows    double-click  VocabX.exe
  macOS      double-click  VocabX          (the app with the VocabX icon)
  Linux      run           ./VocabX

It opens VocabX in your browser and keeps serving it until you close it. No
installer, no runtime, no account, and no internet connection needed.

WHAT IT IS

VocabX is a web app. On a desktop the honest way to run it is to serve the same
files over loopback and open the browser at them — one small launcher instead
of a second copy of the app that drifts out of step with the web one.

  · It serves ONLY the `app` folder in here
  · It listens ONLY on 127.0.0.1 — nothing is exposed to your network
  · It uploads nothing, and works with no internet at all

KEEP THE FOLDER TOGETHER

  VocabX.exe     VocabX     VocabX.app     app/

The launchers all read the same `app` folder, which is why there is one copy of
it instead of three. Move the whole folder anywhere you like — Desktop,
Program Files, Applications, /opt, a USB stick — but move it whole. On a Mac
that means dragging this folder into Applications, not just the app inside it.

THE FIRST RUN WARNS. THAT IS EXPECTED.

None of these is code-signed, because signing means paying Apple and Microsoft
a certificate fee every year. Nothing is wrong with the files; the system just
cannot tell who made them.

  Windows    "Windows protected your PC"  →  More info  →  Run anyway
  macOS      right-click VocabX  →  Open  →  Open      (first time only)

If macOS still refuses, run this once in Terminal, from this folder:

    xattr -dr com.apple.quarantine VocabX.app

If you would rather not run an unsigned program — a fair position — you do not
need any of this. Open the app in Chrome, Edge or Safari and install it from
the browser. You get the same thing: an icon, its own window, and offline
support.

A MENU ENTRY ON LINUX, IF YOU WANT ONE

    ./install-menu.sh

That writes a single .desktop file into ~/.local/share/applications pointing at
this folder. No root, nothing else touched, and ./uninstall-menu.sh removes it.

CLOSING IT

None of them has a window of its own — the app is the browser tab.

  Windows    Task Manager → VocabX.exe → End task
  macOS      right-click VocabX in the Dock → Quit (Force Quit is normal for
             an app with no window)
  Linux      Ctrl+C in its terminal, or `pkill -x VocabX`

Or just leave it running. It uses almost nothing while idle.

BUILDING IT YOURSELF

    ./build.sh              → VocabX.exe (needs mingw-w64) and VocabX (needs cc)

vocabx.c is one file for Windows and Linux both, about 300 lines, and the whole
of it is "serve these files on localhost, then open a browser". The macOS
launcher is vocabx.pl inside the bundle — right-click VocabX → Show Package
Contents → Contents/Resources — and it is the same thing in about 130 lines.
