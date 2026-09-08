/**
 * The welcome screen: the one thing between opening the app and using it.
 *
 * Three ways through and all three are real. "Start learning" is the primary
 * button because it is what most people should press — a guest gets every
 * word, every screen and every feature, kept on their own device, and is never
 * nagged to upgrade. An account is offered plainly for the one thing it
 * actually buys: work that outlives this browser.
 *
 * It is also reachable later, from Settings, which is why it takes a mode and
 * can be dismissed. On first run it cannot be dismissed — not to trap anyone,
 * but because "no answer" is not one of the three answers, and the cheapest
 * one is a single tap away.
 */
import { $ } from './ui.js';
import { Auth, possible, serverAccounts } from './auth.js';

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

let live = null;

/**
 * Show the gate. Resolves with what was chosen — never rejects, because every
 * outcome including "changed my mind" is a normal end for this screen.
 *
 * @returns {Promise<{ how: 'guest'|'signup'|'login'|'cancel' }>}
 */
export function openGate({ mode = 'choose', dismissible = false } = {}) {
  if (live) return live.promise;

  const gate = $('#gate');
  const panes = { choose: $('#gateChoose'), form: $('#gateForm') };
  let settle;
  const promise = new Promise((done) => { settle = done; });
  live = { promise };

  let kind = mode === 'signin' ? 'login' : 'signup';

  const finish = (how) => {
    gate.hidden = true;
    document.body.classList.remove('is-gated');
    off();
    live = null;
    settle({ how });
  };

  // ── panes ────────────────────────────────────────────────────────────────

  const showChoose = () => {
    panes.choose.hidden = false;
    panes.form.hidden = true;
    $('#gatePanel').focus({ preventScroll: true });
  };

  const showForm = (which) => {
    kind = which;
    const making = which === 'signup';
    panes.choose.hidden = true;
    panes.form.hidden = false;
    clearError();

    $('#gateFormTitle').textContent = making ? 'Create an account' : 'Welcome back';
    $('#gateFormLede').textContent = making
      ? 'So your streak, your schedule and your word list survive a cleared browser.'
      : 'Sign in and your progress comes back to this device.';
    $('#gateSubmitLabel').textContent = making ? 'Create account' : 'Sign in';
    $('#gateSwap').textContent = making
      ? 'Already have an account? Sign in'
      : 'New here? Create an account';
    $('#gateNameField').hidden = !making;
    /* The browser fills and saves the right thing only if this says which it
       is; leaving it on "current-password" makes every signup look to a
       password manager like a login that failed. */
    $('#gatePass').setAttribute('autocomplete', making ? 'new-password' : 'current-password');
    $('#gateEmail').focus({ preventScroll: true });
  };

  // ── errors ───────────────────────────────────────────────────────────────

  const clearError = () => { $('#gateError').hidden = true; $('#gateError').textContent = ''; };
  const showError = (message) => {
    const box = $('#gateError');
    box.textContent = message;
    box.hidden = false;
  };

  // ── submit ───────────────────────────────────────────────────────────────

  const busy = (on) => {
    $('#gateSubmit').classList.toggle('is-busy', on);
    $('#gateSubmit').disabled = on;
    for (const field of ['#gateName', '#gateEmail', '#gatePass']) $(field).disabled = on;
  };

  async function submit(event) {
    event.preventDefault();
    clearError();

    const email = $('#gateEmail').value.trim();
    const password = $('#gatePass').value;
    const name = $('#gateName').value.trim();

    // Checked here as well as on the server, because a round trip to be told
    // the address has no @ in it is a round trip nobody needed.
    if (!EMAIL.test(email)) return showError('That does not look like an email address.');
    if (password.length < 8) return showError('Use at least 8 characters.');

    busy(true);
    try {
      const out = kind === 'signup'
        ? await Auth.signup({ email, password, name })
        : await Auth.login({ email, password });

      if (out?.ok) return finish(kind);
      showError(out?.error || 'That did not work. Try again.');
    } catch {
      /* Every failure that is not the server saying no: offline, asleep,
         blocked. Naming guest here matters — it is a way through, not a
         consolation. */
      showError('Could not reach the server. Check your connection, or start '
        + 'as a guest and add an account later.');
    } finally {
      busy(false);
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (!panes.form.hidden) { showChoose(); return; }
    if (dismissible) finish('cancel');
  };

  const bind = [
    ['#gateGuest', () => { Auth.guest(); finish('guest'); }],
    ['#gateNew', () => showForm('signup')],
    ['#gateOld', () => showForm('login')],
    ['#gateBack', () => (dismissible && mode !== 'choose' ? finish('cancel') : showChoose())],
    ['#gateSwap', () => showForm(kind === 'signup' ? 'login' : 'signup')],
  ];
  for (const [sel, fn] of bind) $(sel).addEventListener('click', fn);
  $('#gateFormEl').addEventListener('submit', submit);
  addEventListener('keydown', onKey);

  const off = () => {
    for (const [sel, fn] of bind) $(sel).removeEventListener('click', fn);
    $('#gateFormEl').removeEventListener('submit', submit);
    removeEventListener('keydown', onKey);
  };

  // ── open ─────────────────────────────────────────────────────────────────

  /* Reset what a previous opening may have done. The no-accounts branch below
     hides two buttons and promotes a third, and none of that was ever undone —
     so a gate opened offline once stayed in its fallback shape for the rest of
     the session, even after the network came back. */
  $('#gateNew').hidden = false;
  $('#gateOld').hidden = false;
  $('#gateGuest').classList.remove('gate__tiny--only');

  gate.hidden = false;
  document.body.classList.add('is-gated');
  if (mode === 'choose') showChoose(); else showForm(kind);

  /**
   * Whether this deployment can hold an account at all.
   *
   * Asked after the screen is already up, so the gate never waits on the
   * network to paint. If the answer is no the two account buttons go away
   * rather than staying to fail at the last step — a form that cannot work is
   * worse than no form.
   */
  (async () => {
    const can = possible() && await serverAccounts();
    if (can || !live) return;
    $('#gateNew').hidden = true;
    $('#gateOld').hidden = true;
    /* Guest is normally the small print under two buttons. With the buttons
       gone it is the only way in, so it stops being small print — a screen
       whose single control is a text link reads as a screen that failed. */
    $('#gateGuest').classList.add('gate__tiny--only');
    $('#gateFoot').textContent = 'Accounts are not set up on this deployment yet, '
      + 'so everything is kept on this device. Nothing else is missing.';
    if (!panes.form.hidden) showChoose();
  })();

  return promise;
}

/** The initial from a name, for the header. Falls back to the app's own mark. */
export function initialOf(user) {
  const from = String(user?.name || user?.email || '').trim();
  return from ? from[0].toUpperCase() : '';
}
