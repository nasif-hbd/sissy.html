/**
 * How a piece of feedback is worded and addressed.
 *
 * Kept apart from the sheet that collects it so the wording can be checked
 * without a browser — and because the same text has to serve three routes out
 * of the app: the proxy, the clipboard, and the reader's own mail client.
 */

/** The note as plain text: what was said first, then what it was said from. */
export function feedbackAsText(report) {
  const c = report.context || {};
  const where = report.anonymous
    ? ''
    : [c.view, c.screen, c.provider, c.level && `level ${c.level}`]
        .filter(Boolean).join(' · ');
  /* Only the optional tail is filtered. Filtering the whole list swallows the
     blank line as well, and the note runs straight into its own metadata. */
  const tail = [`kind ${report.kind}`, where, report.anonymous && 'sent anonymously']
    .filter(Boolean);
  return [report.text, '', '—', ...tail].join('\n');
}

/** The subject line: enough of the note to tell two reports apart in a list. */
export function feedbackSubject(report) {
  const gist = report.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `VocabX ${report.kind}: ${gist}`;
}

/**
 * A mailto: link for the note.
 *
 * This is the route that works with no server at all, which is what the hosted
 * build is. Everything is percent-encoded, including the address, because a
 * newline or an ampersand left raw in a mailto silently truncates the body —
 * or, worse, appends a header of somebody else's choosing.
 */
export function feedbackMailto(report, to) {
  const q = new URLSearchParams({
    subject: feedbackSubject(report),
    body: feedbackAsText(report),
  });
  // URLSearchParams encodes a space as "+", which a mail client shows literally.
  return `mailto:${encodeURIComponent(to)}?${q.toString().replace(/\+/g, '%20')}`;
}

/**
 * Everything the app knows that could go with a report, and whether it does.
 *
 * Anonymity is a claim, and a claim the reader cannot check is worth nothing —
 * so the interface lists this rather than promising it, and the list is built
 * from the payload that is actually sent. Change what is attached and the list
 * changes with it, because there is only one description of it.
 */
export function manifestOf(report) {
  const c = report.context || {};
  const rows = [
    { label: 'What you wrote', value: report.text ? `${report.text.length} characters` : 'nothing yet', sent: true },
    { label: 'How it is going', value: MOOD[report.mood] || report.mood, sent: true },
    { label: 'What it is about', value: KIND[report.kind] || report.kind, sent: true },
    { label: 'When', sent: true,
      value: report.anonymous ? 'the date and hour only' : 'the date and time' },
    { label: 'Your email', value: report.from || 'not given', sent: Boolean(report.from) },
    { label: 'Which screen you were on', value: c.view || '—', sent: Boolean(c.view) },
    { label: 'Which AI engine', value: c.provider || '—', sent: Boolean(c.provider) },
    { label: 'Your level', value: c.level || '—', sent: Boolean(c.level) },
    { label: 'How many words in your deck', value: c.words == null ? '—' : String(c.words), sent: c.words != null },
    { label: 'Your window size', value: c.screen || '—', sent: Boolean(c.screen) },
  ];
  return rows;
}

const MOOD = { good: 'going well', mixed: 'mixed', bad: 'frustrating' };
const KIND = { idea: 'an idea', bug: 'something broke', word: 'a word is wrong' };

/**
 * Strip a report back to what an anonymous one may carry.
 *
 * Built by removing rather than by rebuilding: a new field added to the report
 * is dropped here by default, instead of being carried through by an omission
 * nobody notices. There is nothing left that distinguishes one sender from
 * another — no email, no context, no identifier, and a timestamp rounded to
 * the hour so two reports minutes apart cannot be tied together by their
 * clocks.
 */
export function anonymise(report) {
  const at = new Date(report.at || Date.now());
  at.setMinutes(0, 0, 0);
  return {
    anonymous: true,
    kind: report.kind,
    mood: report.mood,
    text: report.text,
    at: at.toISOString(),
  };
}
