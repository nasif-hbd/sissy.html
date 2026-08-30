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
  const where = [c.view, c.screen, c.provider, c.level && `level ${c.level}`]
    .filter(Boolean).join(' · ');
  /* Only the optional tail is filtered. Filtering the whole list swallows the
     blank line as well, and the note runs straight into its own metadata. */
  const tail = [`kind ${report.kind}`, where].filter(Boolean);
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
