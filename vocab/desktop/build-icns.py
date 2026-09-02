#!/usr/bin/env python3
"""
Pack the desktop PNGs into a macOS .icns.

An .icns is a container, not an image format: a 'icns' magic, a big-endian
total length, then one chunk per size — a four-character type, its length,
and a PNG verbatim. Apple's own iconutil only runs on macOS, and the format
is simple enough that writing it here is better than not shipping an icon at
all, which is what a Mac app with no icns looks like in the Dock.

    python3 build-icns.py icon/ VocabX.icns
"""
import struct
import sys
from pathlib import Path

# The chunk type macOS reads for each size. ic07 and up take PNG directly;
# anything older wants a raw bitmap we have no reason to produce.
TYPES = {
    16:  b'icp4',
    32:  b'icp5',
    64:  b'icp6',
    128: b'ic07',
    256: b'ic08',
    512: b'ic09',
    1024: b'ic10',
}
# The same pixels again under the retina names, so a 512-point icon on a
# 2x display is drawn from the 1024 rather than being smeared up from 512.
RETINA = {32: b'ic11', 64: b'ic12', 256: b'ic13', 512: b'ic14'}


def build(src: Path, out: Path) -> None:
    chunks = []
    for size, kind in sorted(TYPES.items()):
        png = src / f'icon-{size}.png'
        if not png.exists():
            continue
        data = png.read_bytes()
        chunks.append(kind + struct.pack('>I', len(data) + 8) + data)
        if size in RETINA:
            chunks.append(RETINA[size] + struct.pack('>I', len(data) + 8) + data)

    if not chunks:
        sys.exit(f'no icon-*.png under {src}')

    body = b''.join(chunks)
    out.write_bytes(b'icns' + struct.pack('>I', len(body) + 8) + body)
    print(f'wrote {out} — {len(chunks)} entries, {len(body) / 1024:.0f} KB')


if __name__ == '__main__':
    build(Path(sys.argv[1] if len(sys.argv) > 1 else 'icon'),
          Path(sys.argv[2] if len(sys.argv) > 2 else 'VocabX.icns'))
