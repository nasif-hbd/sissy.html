/**
 * Installing Lexio.
 *
 * A PWA installs differently on every platform and the difference is not
 * cosmetic: Chrome and Edge fire `beforeinstallprompt` and can install in one
 * tap, Safari has no such API and needs the learner to find Share → Add to
 * Home Screen themselves, and Firefox mostly cannot install at all. Showing one
 * "Install" button everywhere means it silently does nothing for a large share
 * of people.
 *
 * So: detect the platform, say what that platform can actually do, and give
 * step-by-step words where there is no button to press.
 *
 * `platformOf` is pure and takes the user agent, so every branch is testable
 * without a browser.
 */

/**
 * What we know about where this is running.
 *
 * `canPrompt` is only ever a guess from the user agent; the live code trusts a
 * captured `beforeinstallprompt` event over this, and uses it only to decide
 * what to say when no event has arrived.
 */
export function platformOf(ua = '', { standalone = false, touchPoints = 0 } = {}) {
  const s = String(ua);
  const has = (re) => re.test(s);

  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  const iPadDesktopUA = has(/Macintosh/i) && touchPoints > 1;
  const isIOS = has(/iPhone|iPad|iPod/i) || iPadDesktopUA;
  const isAndroid = has(/Android/i);
  // Chrome's UA contains Safari; Safari's does not contain Chrome or Chromium.
  const isSafari = has(/Safari/i) && !has(/Chrome|Chromium|CriOS|EdgiOS|FxiOS|OPR/i);
  const isFirefox = has(/Firefox|FxiOS/i);
  const isChromium = has(/Chrome|Chromium|CriOS|Edg|OPR/i);

  const os = isIOS ? 'ios'
    : isAndroid ? 'android'
    : has(/Windows/i) ? 'windows'
    : has(/Mac OS X|Macintosh/i) ? 'mac'
    : has(/CrOS/i) ? 'chromeos'
    : has(/Linux/i) ? 'linux'
    : 'other';

  if (standalone) {
    return {
      id: 'installed', os, label: 'Already installed',
      how: 'You are running the installed app.',
      steps: [], canPrompt: false, installed: true,
    };
  }

  if (isIOS) {
    // Every iOS browser is Safari underneath, and only Safari's own share sheet
    // can add to the Home Screen.
    return {
      id: 'ios', os, label: 'iPhone or iPad', canPrompt: false, installed: false,
      how: isSafari
        ? 'Add Lexio to your Home Screen from the Share menu.'
        : 'Open this page in Safari first — only Safari can add apps to the iOS Home Screen.',
      steps: [
        'Tap the Share button (the square with an arrow)',
        'Scroll down and tap "Add to Home Screen"',
        'Tap "Add"',
      ],
      note: 'Notifications on iPhone only work once it is on the Home Screen. That is an Apple rule, not a limit of the app.',
    };
  }

  if (isAndroid) {
    return {
      id: 'android', os, label: 'Android', canPrompt: isChromium, installed: false,
      how: isChromium
        ? 'Install it straight from this page.'
        : 'Open this page in Chrome to install it.',
      steps: [
        'Tap the ⋮ menu',
        'Tap "Install app" or "Add to Home screen"',
      ],
    };
  }

  if (isFirefox) {
    return {
      id: 'firefox', os, label: 'Firefox', canPrompt: false, installed: false,
      how: 'Firefox does not install web apps on the desktop. Everything still works in the tab.',
      steps: [],
      note: 'For a real app window, open this page in Chrome or Edge — or on Windows use the downloadable version.',
    };
  }

  const names = { windows: 'Windows', mac: 'Mac', linux: 'Linux', chromeos: 'ChromeOS' };

  // Safari on macOS installs too, but through "Add to Dock" — telling a Safari
  // user to click Chrome's address-bar icon sends them looking for a button
  // that is not there.
  if (isSafari) {
    return {
      id: 'safari-desktop', os, label: names[os] || 'Safari', canPrompt: false, installed: false,
      how: 'Add Lexio to your Dock from Safari\u2019s File menu.',
      steps: ['Open the File menu', 'Choose "Add to Dock"', 'Click "Add"'],
      note: 'On macOS Sonoma or later. Older Safari cannot install web apps — Chrome or Edge can.',
    };
  }

  return {
    id: 'desktop', os, label: names[os] || 'Desktop', canPrompt: isChromium, installed: false,
    how: isChromium
      ? 'Install it as a desktop app from this page.'
      : 'Open this page in Chrome or Edge to install it as a desktop app.',
    steps: [
      'Click the install icon in the address bar',
      'Or open the ⋮ menu → "Install Lexio"',
    ],
    note: os === 'windows'
      ? 'Windows also has a downloadable version that needs no browser install.'
      : undefined,
  };
}

/**
 * Live install state for the page.
 *
 * Captures `beforeinstallprompt` so the button can be shown at a sensible
 * moment rather than the browser's own, and remembers when the app is
 * installed so the offer disappears.
 */
export function createInstaller({ onChange } = {}) {
  let deferred = null;
  let installed = isStandalone();

  const state = () => ({
    ...platformOf(navigator.userAgent, {
      standalone: installed,
      touchPoints: navigator.maxTouchPoints || 0,
    }),
    // A captured event is proof, where the user agent is only a guess.
    canPrompt: Boolean(deferred),
    installed,
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome shows its own bar unless this is prevented; we want the offer in
    // our own UI, at a moment that makes sense.
    e.preventDefault();
    deferred = e;
    onChange?.(state());
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    onChange?.(state());
  });

  return {
    state,
    /** Fire the real prompt. Resolves to 'accepted', 'dismissed' or 'unavailable'. */
    async prompt() {
      if (!deferred) return 'unavailable';
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // The event is single-use; a second prompt() call is a no-op.
      deferred = null;
      onChange?.(state());
      return outcome;
    },
  };
}

/** Is the page running as an installed app rather than in a browser tab? */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: window-controls-overlay)').matches
    || window.navigator?.standalone === true;
}
