import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { encodeHeader, dotStuff, buildMessage, mailConfig, address, speakSmtp } from '../server/mailer.mjs';

/*
 * The SMTP client the proxy uses to forward feedback. It is hand-written to
 * keep a dependency out of the process that holds the API keys, which means
 * the protocol details are ours to get right — so a fake server answers a real
 * conversation below, rather than the parts being checked in isolation only.
 */

test('a header with non-ASCII is encoded, not mangled', () => {
  assert.equal(encodeHeader('VocabX idea: more words'), 'VocabX idea: more words');
  assert.equal(encodeHeader('VocabX: শব্দ'), '=?UTF-8?B?Vm9jYWJYOiDgprbgpqzgp43gpqY=?=');
  // A newline in a header is how a header-injection attack starts.
  assert.equal(encodeHeader('one\r\nBcc: someone@example.com'), 'one Bcc: someone@example.com');
});

test('a line starting with a dot cannot end the message early', () => {
  assert.equal(dotStuff('hello\n.\nworld'), 'hello\r\n..\r\nworld');
  assert.equal(dotStuff('..hidden'), '...hidden');
  assert.equal(dotStuff('a\r\nb'), 'a\r\nb', 'CRLF is not doubled into CRCRLF');
});

test('the message carries the headers a mail client needs', () => {
  const msg = buildMessage({
    from: 'bot@example.com', to: 'you@example.com', replyTo: 'learner@example.com',
    subject: 'VocabX bug', text: 'the Test tab froze',
    date: new Date('2026-08-30T09:00:00Z'), id: 'fixed@vocabx',
  });
  const [headers, body] = msg.split('\r\n\r\n');
  assert.match(headers, /^From: bot@example\.com$/m);
  assert.match(headers, /^To: you@example\.com$/m);
  assert.match(headers, /^Reply-To: learner@example\.com$/m);
  assert.match(headers, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(headers, /^Message-ID: <fixed@vocabx>$/m);
  assert.equal(body, 'the Test tab froze');
});

test('Reply-To is left out when nobody asked for a reply', () => {
  assert.doesNotMatch(buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /Reply-To/);
});

test('the envelope address is the address, not the display name', () => {
  assert.equal(address('VocabX <bot@example.com>'), 'bot@example.com');
  assert.equal(address('  bot@example.com '), 'bot@example.com');
});

test('the config says exactly what is missing', () => {
  const none = mailConfig({});
  assert.equal(none.ready, false);
  assert.deepEqual(none.missing, ['host', 'user', 'pass', 'to']);

  const partial = mailConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.c', SMTP_PASS: 'x' });
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missing, ['to'], 'a server with nowhere to send is not ready');

  const full = mailConfig({
    SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.c', SMTP_PASS: 'x', FEEDBACK_TO: 'you@d.e',
  });
  assert.equal(full.ready, true);
  assert.equal(full.port, 465, 'implicit TLS by default');
  assert.equal(full.from, 'a@b.c', 'the sender defaults to the account that logs in');
});

/**
 * A server that speaks just enough SMTP to record what it was told.
 *
 * The conversation is driven through `speakSmtp` over a plain socket marked
 * `secure: true` — which is exactly the shape of a port-465 connection, and
 * needs no certificate to exercise.
 */
function fakeSmtp({ authOffer = 'AUTH LOGIN PLAIN' } = {}) {
  const seen = { commands: [], message: '', auth: [] };
  let inData = false;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake ESMTP\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); }
          else seen.message += `${line}\n`;
          continue;
        }
        seen.commands.push(line);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write(`250-fake\r\n250 ${authOffer}\r\n`);
        else if (cmd === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
        else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else { seen.auth.push(line); socket.write(seen.auth.length === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); }
      }
    });
  });
  return {
    server,
    seen,
    /** Connect, run the whole conversation, and shut the server down after. */
    async run(opts) {
      const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
      const socket = net.connect({ port, host: '127.0.0.1' });
      await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
      try {
        await speakSmtp(socket, { secure: true, user: 'u', pass: 'p', from: 'a@b.c', to: 'd@e.f',
                                  subject: 's', text: 't', ...opts });
      } finally {
        socket.destroy();
        await new Promise((r) => server.close(r));
      }
    },
  };
}

test('a whole conversation, from greeting to queued', async () => {
  const fake = fakeSmtp();
  await fake.run({
    user: 'bot@example.com', pass: 'app-password',
    from: 'bot@example.com', to: 'you@example.com', replyTo: 'learner@example.com',
    subject: 'VocabX idea', text: 'more phrasal verbs please\n.hidden line',
  });

  const said = fake.seen.commands.join('\n');
  assert.match(said, /^EHLO /m);
  assert.match(said, /^AUTH LOGIN$/m);
  assert.ok(said.includes(Buffer.from('bot@example.com').toString('base64')), 'the username is sent base64');
  assert.ok(said.includes(Buffer.from('app-password').toString('base64')), 'and so is the password');
  assert.match(said, /^MAIL FROM:<bot@example\.com>$/m);
  assert.match(said, /^RCPT TO:<you@example\.com>$/m);
  assert.match(said, /^DATA$/m);
  assert.match(said, /^QUIT$/m);

  assert.match(fake.seen.message, /^Subject: VocabX idea$/m);
  assert.match(fake.seen.message, /^Reply-To: learner@example\.com$/m);
  assert.match(fake.seen.message, /more phrasal verbs please/);
  assert.match(fake.seen.message, /^\.\.hidden line$/m, 'the leading dot survives as a stuffed pair');
});

test('a server that only offers PLAIN gets PLAIN', async () => {
  const fake = fakeSmtp({ authOffer: 'AUTH PLAIN' });
  await fake.run({});
  const said = fake.seen.commands.join('\n');
  assert.match(said, /^AUTH PLAIN /m);
  assert.doesNotMatch(said, /^AUTH LOGIN$/m);
});

test('a refusal is reported, not swallowed', async () => {
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.write('220 fake\r\n');
    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (cmd === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else s.write('535 Username and Password not accepted\r\n');
      }
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const socket = net.connect({ port, host: '127.0.0.1' });
  await new Promise((res) => socket.once('connect', res));
  await assert.rejects(
    speakSmtp(socket, { secure: true, user: 'u', pass: 'wrong', from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }),
    /SMTP (username|password) failed: 535/,
  );
  socket.destroy();
  await new Promise((r) => server.close(r));
});

test('a password is never sent over a socket that refuses TLS', async () => {
  const fake = fakeSmtp({ authOffer: 'AUTH LOGIN' });     // no STARTTLS advertised
  const port = await new Promise((r) => fake.server.listen(0, '127.0.0.1', () => r(fake.server.address().port)));
  const socket = net.connect({ port, host: '127.0.0.1' });
  await new Promise((res) => socket.once('connect', res));
  await assert.rejects(
    speakSmtp(socket, { secure: false, upgrade: null, user: 'u', pass: 'hunter2',
                        from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }),
    /will not start TLS/,
  );
  socket.destroy();
  await new Promise((r) => fake.server.close(r));
  assert.ok(!fake.seen.commands.some((c) => c.includes(Buffer.from('hunter2').toString('base64'))),
    'the password never reached the wire');
});
