/* ===========================================================================
   Word families

   ACADEMICS is a word-family list: it carries "visual", "visualise",
   "visualize", "visualisation" and "visualized" as five separate entries. A
   pack that shows all five is teaching one word five times, so a pack keeps the
   first member it meets — the best-ranked one — and skips the rest. The
   dictionary still holds them all; this only applies to the study packs.

   Two words are one family when what is left over after their common stem is an
   English suffix on both sides. That last condition is the whole rule: it is
   why "globalization" folds into "global" but "country" does not fold into
   "count", because "ry" is not a suffix.
=========================================================================== */
export const SUFFIX = new RegExp('^(?:' + [
  'e', 'e?[sd]', 'ings?', 'ers?', 'ors?', 'ly', 'ally', 'y', 'ies', 'ied',
  'ments?', 'ness', 'als?', 'at(?:e|es|ed|ing|ions?|ive|ors?|ory)',
  'anc[ey]', 'enc[ey]', 'ants?', 'ents?', 'abl[ey]', 'ability', 'ibl[ey]', 'ibility',
  'iv(?:e|es|ity)', 'it(?:y|ies)', 'isms?', 'ists?', 'iz(?:e|es|ed|ing|ations?)',
  'ic', 'ical', 'ically', 'ics', '[st]?ions?', 'ution', 'ous', 'ously',
  'ful', 'less', 'lessly', 'ship', 'hood', 'ery', 'ary', 'ory', 'ze?', 's?is',
].join('|') + ')$');

/** British and American spellings of the same word are the same word. */
export const stemOf = (w) => w
  .replace(/is(e|es|ed|ing|ation|ations)$/, 'iz$1')
  .replace(/yse(s|d)?$/, 'yze$1')
  .replace(/our$/, 'or');

export function sameFamily(a, b) {
  const x = stemOf(a), y = stemOf(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  if (i < 4) return false;                       // too little in common to judge
  const restX = x.slice(i), restY = y.slice(i);
  return (!restX || SUFFIX.test(restX)) && (!restY || SUFFIX.test(restY));
}
