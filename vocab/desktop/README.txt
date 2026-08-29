VOCABX FOR WINDOWS

Double-click VocabX.exe. It opens VocabX in your browser and keeps serving it
until you close it. No installer, no runtime, nothing written outside this
folder.

WHAT IT IS

VocabX is a web app. On a desktop the honest way to run it is to serve the same
files over loopback and open the browser at them — one 43 KB native binary
instead of a second copy of the app that drifts out of step with the web one.

  · It serves ONLY the `app` folder next to it
  · It listens ONLY on 127.0.0.1 — nothing is exposed to your network
  · It uploads nothing, and needs no internet connection at all

KEEP THESE TOGETHER

  VocabX.exe
  app\          ← the whole app. Move them together or the exe will say so.

Put the folder anywhere: Desktop, Program Files, a USB stick.

CLOSING IT

It has no window of its own. End it from Task Manager (VocabX.exe), or just
leave it — it uses almost nothing while idle.

WINDOWS SMARTSCREEN

The first run may show "Windows protected your PC". That is because this exe
is not code-signed, not because anything is wrong with it: signing needs a
certificate that costs money annually. Click "More info" → "Run anyway".

If you would rather not run an unsigned exe — a fair position — you do not
need it. Open the app in Edge or Chrome and use "Install this site as an app"
from the browser menu. You get the same thing: a desktop icon, its own window,
and offline support.

BUILDING IT YOURSELF

The source is one C file, and the build is one command:

    ./build.sh                       (needs mingw-w64)

Read vocabx.c first if you like — it is about 200 lines, and the whole of it is
"serve these files on localhost, then open a browser".
