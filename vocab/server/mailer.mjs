/**
 * A small SMTP client, so feedback can arrive as email.
 *
 * Written rather than installed for the same reason as the rest of this
 * server: the proxy holds your API keys, and every dependency added to it is
 * another package that could read them. Sending one short message over SMTP is
 * a few hundred lines of a protocol that has not changed since 1982.
 *
 * Not a general mail library. One recipient, plain text, one attachment-free
 * message — which is all a feedback note is.
 */
import net from 'node:net';
import tls from 'node:tls';

/** Read replies off the socket, one complete reply at a time. */
function makeReader(socket) {
  let buffer = '';
  const waiting = [];
  const flush = () => {
    // A reply ends on the first line whose code is followed by a space rather
    // than a hyphen: "250-SIZE" continues, "250 OK" finishes.
    for (;;) {
      const lines = buffer.split('\r\n');
      const end = lines.findIndex((l) => /^\d{3} /.test(l));
      if (end < 0 || !waiting.length) return;
      const reply = lines.slice(0, end + 1).join('\n');
      buffer = lines.slice(end + 1).join('\r\n');
      waiting.shift()({ code: Number(reply.slice(0, 3)), text: reply });
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { buffer += chunk; flush(); });
  return () => new Promise((resolve) => { waiting.push(resolve); flush(); });
}

class SmtpError extends Error {
  constructor(step, reply) {
    super(`SMTP ${step} failed: ${reply.text.split('\n')[0]}`);
    this.name = 'SmtpError';
    this.code = reply.code;
  }
}

/**
 * Anything outside ASCII has to be encoded, or the header is mangled or the
 * message is rejected. Base64 for the whole value is the simple, always-legal
 * form of RFC 2047.
 */
export function encodeHeader(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * A line of message body starting with a dot would end the DATA block early,
 * so it is doubled — and the receiver undoes it. This is the whole reason a
 * message body cannot simply be concatenated onto the wire.
 */
export function dotStuff(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/** The complete message, headers and all. Pure, so it can be checked. */
export function buildMessage({ from, to, subject, text, replyTo,
                               date = new Date(), id = randomId() }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(text)}`;
}

const randomId = () =>
  `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@vocabx`;

/** Reads the mail settings, and says plainly whether they are complete. */
export function mailConfig(env = process.env) {
  const cfg = {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    to: env.FEEDBACK_TO || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  };
  const missing = ['host', 'user', 'pass', 'to'].filter((k) => !cfg[k]);
  return { ...cfg, ready: missing.length === 0, missing };
}

/**
 * The conversation, over a socket somebody else opened.
 *
 * Split from `sendMail` so the protocol can be exercised without a real mail
 * server and a real certificate: `secure` says whether the socket is already
 * encrypted, and `upgrade` — when there is one — hands back a TLS stream over
 * the same connection. A password is never written to a stream that is neither.
 */
export async function speakSmtp(socket, { secure, upgrade, user, pass, from, to,
                                          subject, text, replyTo, ehlo = 'localhost' }) {
  let live = socket;
  let read = makeReader(live);
  const write = (line) => new Promise((res, rej) => live.write(`${line}\r\n`, (e) => (e ? rej(e) : res())));
  const step = async (name, line, ok) => {
    if (line !== null) await write(line);
    const reply = await read();
    if (!ok.includes(reply.code)) throw new SmtpError(name, reply);
    return reply;
  };

  await step('greeting', null, [220]);
  let hello = await step('EHLO', `EHLO ${ehlo}`, [250]);

  if (!secure) {
    if (!upgrade || !/\bSTARTTLS\b/i.test(hello.text)) {
      throw new Error('the server will not start TLS, and a password must not cross a plain socket');
    }
    await step('STARTTLS', 'STARTTLS', [220]);
    live = await upgrade(socket);
    read = makeReader(live);
    hello = await step('EHLO', `EHLO ${ehlo}`, [250]);      // again, inside TLS
  }

  // AUTH LOGIN is the one every server still speaks; PLAIN is the fallback.
  if (/\bAUTH\b[^\n]*\bLOGIN\b/i.test(hello.text)) {
    await step('AUTH LOGIN', 'AUTH LOGIN', [334]);
    await step('username', b64(user), [334]);
    await step('password', b64(pass), [235]);
  } else {
    await step('AUTH PLAIN', `AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
  }

  await step('MAIL FROM', `MAIL FROM:<${address(from)}>`, [250]);
  await step('RCPT TO', `RCPT TO:<${address(to)}>`, [250, 251]);
  await step('DATA', 'DATA', [354]);
  await write(buildMessage({ from, to, subject, text, replyTo }));
  await step('message', '.', [250]);
  await write('QUIT');
  return live;
}

/**
 * Open a connection and send one message.
 *
 * Port 465 is TLS from the first byte; anything else is upgraded with
 * STARTTLS. `insecureTLS` exists for a mail server on your own network with a
 * certificate nobody has signed — it is off, and should stay off for Gmail and
 * every other public host.
 */
export async function sendMail({ host, port = 465, timeout = 20000, insecureTLS = false, ...msg }) {
  const tlsOpts = { servername: host, rejectUnauthorized: !insecureTLS };
  const socket = port === 465
    ? tls.connect({ host, port, ...tlsOpts })
    : net.connect({ host, port });
  socket.setTimeout(timeout);
  let live = socket;

  try {
    await new Promise((res, rej) => {
      socket.once(port === 465 ? 'secureConnect' : 'connect', res);
      socket.once('error', rej);
      socket.once('timeout', () => rej(new Error(`SMTP timed out connecting to ${host}:${port}`)));
    });
    socket.on('timeout', () => socket.destroy(new Error('SMTP timed out')));

    live = await speakSmtp(socket, {
      ...msg,
      secure: port === 465,
      upgrade: (raw) => new Promise((res, rej) => {
        const up = tls.connect({ socket: raw, ...tlsOpts });
        up.once('secureConnect', () => res(up));
        up.once('error', rej);
      }),
    });
  } catch (err) {
    // The host is in the message because "535 not accepted" on its own says
    // nothing about which of several accounts was refused.
    err.message = `${err.message} (${host}:${port})`;
    throw err;
  } finally {
    live.end();
    socket.destroy();
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
/** "Name <a@b.c>" → "a@b.c", which is what the envelope wants. */
export const address = (value) => (String(value).match(/<([^>]+)>/)?.[1] || String(value)).trim();
const hostname = () => {
  try { return new URL(`http://${process.env.HOSTNAME || 'localhost'}`).hostname; }
  catch { return 'localhost'; }
};
