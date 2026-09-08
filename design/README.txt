TWO UI DIRECTIONS FOR VOCABX

  VOLTAGE (current) — your reference layout, acid-lime, over a real 3D grid
  field, with a light skin on a toggle. vocabx-voltage.html / voltage-body.html

  FROST (earlier) — porcelain and petrol, set as a dictionary page over a
  field of glass shards. vocabx-frost.html / frost-body.html

Each direction is two files of the same page:

  vocabx-*.html   standalone. Open it in any browser. No build, no server.
  *-body.html     the same content without the <html>/<head> wrapper, which
                  is the shape the artifact host publishes.

Edit the *-body.html and rebuild the standalone from it, or the two drift:

  { printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' \
           '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    cat voltage-body.html
    printf '\n</html>\n'; } > vocabx-voltage.html
  # then move </head><body> in ahead of the first thing that is not head content

WHAT THESE ARE

  Directions to react to, not shipped code. Nothing here is wired into the
  app; styles.css still owns the four themes VocabX actually has.

  VOLTAGE takes the layout, the acid-lime and the copy from the reference and
  adds the two things it did not have. The field is real 3D: a perspective
  floor and ceiling of grid lines meeting at a lit horizon, with nine slabs
  between them at depths from -1100px to +120px, tilting toward the pointer
  and parallaxing on scroll — each slab carrying a fraction of the scroll set
  by its own distance, which is the part that actually reads as travelling
  through the field rather than over a picture of one. Light is a designed
  skin rather than an inversion: lime is illegible as type on white, so the
  accent splits into --accent, the fill, and --accent-ink, the readable one.

  FROST argues something different — that a vocabulary trainer is a dictionary
  you are inside of, so it is built from a dictionary's materials: the
  headword in a high-contrast serif, the respelling in mono the way IPA is
  set, numbered senses, CEFR bands.

  Neither uses an emoji. Every mark is a stroked SVG carrying its own
  gradient, because a rail navigated by colour has to hold its colour in both
  skins, and an emoji is somebody else's artwork at somebody else's
  resolution.

IF ONE IS ADOPTED

  It becomes a fifth entry in the palette block at the top of
  vocab/styles.css, beside iris/paper/linen/ink, and THEMES in js/config.js
  grows one row. The design test in tests/design.test.mjs already enforces
  that every theme restates every colour token, so a half-ported theme fails
  before it ships.
