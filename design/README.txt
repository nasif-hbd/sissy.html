FROST — a UI direction for VocabX

Two files, the same page:

  vocabx-frost.html   standalone. Open it in any browser. No build, no server.
  frost-body.html     the same content without the <html>/<head> wrapper,
                      which is the shape the artifact host publishes.

Edit frost-body.html and rebuild the standalone from it, or the two drift:

  { printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' \
           '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    cat frost-body.html
    printf '\n</html>\n'; } > vocabx-frost.html
  # then move </head><body> in ahead of the first markup comment

WHAT THIS IS

  A direction to react to, not shipped code. Nothing here is wired into the
  app; styles.css still owns the four themes VocabX actually has.

  The idea it is arguing for: a vocabulary trainer is a dictionary you are
  inside of, so it should be built from a dictionary's materials — the
  headword in a high-contrast serif, the respelling in mono the way IPA is
  set, numbered senses, CEFR bands. The chrome is glass over a field of
  shards in real CSS perspective, and the whole thing carries four skins
  (Frost, Iris, Ember, Ink) off one set of token names.

  Colour is spent in two places only. The navigation icons carry a spectrum,
  because that is what makes a rail scannable. Amber means heat — a streak, a
  word going cold — and never means "another category".

IF IT IS ADOPTED

  Frost becomes a fifth entry in the palette block at the top of
  vocab/styles.css, beside iris/paper/linen/ink, and THEMES in js/config.js
  grows one row. The design test in tests/design.test.mjs already enforces
  that every theme restates every colour token, so a half-ported theme fails
  before it ships.
