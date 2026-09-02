VOCABX FOR LINUX

Run ./VocabX. It opens VocabX in your browser and keeps serving it until you
press Ctrl+C. No installer, no runtime, no root, nothing written outside this
folder.

    ./VocabX

If your file manager will not run it, mark it executable once:

    chmod +x VocabX

WHAT IT IS

VocabX is a web app. On a desktop the honest way to run it is to serve the same
files over loopback and open the browser at them — one small native binary
instead of a second copy of the app that drifts out of step with the web one.

  · It serves ONLY the `app` folder next to it
  · It listens ONLY on 127.0.0.1 — nothing is exposed to your network
  · It uploads nothing, and needs no internet connection at all

The address is printed when it starts, so if no browser opens — some minimal
desktops have no xdg-open — you can paste it yourself.

KEEP THESE TOGETHER

  VocabX
  app/          ← the whole app. Move them together or VocabX will say so.

Put the folder anywhere: your home directory, /opt, a USB stick.

A MENU ENTRY, IF YOU WANT ONE

    ./install-menu.sh

That writes a single .desktop file into ~/.local/share/applications pointing at
this folder, so VocabX appears with your other applications. It touches nothing
else, needs no root, and ./uninstall-menu.sh removes it.

CLOSING IT

Ctrl+C in the terminal it is running in. Started from the menu instead, it ends
with `pkill -x VocabX`.

BUILDING IT YOURSELF

The source is one C file, and the build is one command:

    ./build.sh linux                 (needs cc and make-nothing-else)

Read vocabx.c first if you like — it is about 300 lines, and the whole of it is
"serve these files on localhost, then open a browser".
