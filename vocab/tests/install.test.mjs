/**
 * Platform detection for installing.
 *
 * One "Install" button everywhere silently does nothing for everyone on
 * Safari and Firefox. These pin the branches with real user-agent strings,
 * because the whole point of the module is that it must not guess wrong about
 * what the visitor's browser can actually do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOf } from '../js/install.js';

const UA = {
  iphoneSafari:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1',
  ipadOS:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  androidFirefox:'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
  winChrome:     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  winEdge:       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  winFirefox:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/124.0 Firefox/124.0',
  macSafari:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  linuxChrome:   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

test('an installed app is recognised before anything else', () => {
  for (const ua of Object.values(UA)) {
    const p = platformOf(ua, { standalone: true });
    assert.equal(p.id, 'installed', `missed standalone on: ${ua.slice(0, 40)}`);
    assert.equal(p.installed, true);
    assert.equal(p.canPrompt, false, 'an installed app must not offer to install again');
  }
});

test('iPhone gets Share → Add to Home Screen, never a button', () => {
  const p = platformOf(UA.iphoneSafari);
  assert.equal(p.id, 'ios');
  assert.equal(p.canPrompt, false, 'iOS has no install API — a button would do nothing');
  assert.ok(p.steps.some((s) => /Add to Home Screen/i.test(s)));
  assert.match(p.note, /Home Screen/);
});

test('a non-Safari browser on iOS is told to switch to Safari', () => {
  // Chrome on iOS is Safari underneath but cannot add to the Home Screen.
  const p = platformOf(UA.iphoneChrome);
  assert.equal(p.id, 'ios');
  assert.match(p.how, /Safari/);
  assert.equal(p.canPrompt, false);
});

test('an iPad claiming to be a Mac is caught by its touch points', () => {
  // iPadOS 13+ sends a desktop Mac user agent; without the touch check it
  // would be told to click an address-bar icon that is not there.
  assert.equal(platformOf(UA.ipadOS, { touchPoints: 5 }).id, 'ios');
  const realMac = platformOf(UA.ipadOS, { touchPoints: 0 });
  assert.notEqual(realMac.id, 'ios', 'a real Mac was mistaken for an iPad');
  assert.equal(realMac.os, 'mac');
});

test('Android Chrome can prompt; Android Firefox cannot', () => {
  const chrome = platformOf(UA.androidChrome);
  assert.equal(chrome.id, 'android');
  assert.equal(chrome.canPrompt, true);

  const firefox = platformOf(UA.androidFirefox);
  assert.equal(firefox.canPrompt, false);
  assert.match(firefox.how, /Chrome/);
});

test('desktop Chromium can prompt on every operating system', () => {
  for (const [name, ua] of [['win', UA.winChrome], ['edge', UA.winEdge],
                            ['mac', UA.macChrome], ['linux', UA.linuxChrome]]) {
    const p = platformOf(ua);
    assert.equal(p.id, 'desktop', `${name} was not read as desktop`);
    assert.equal(p.canPrompt, true, `${name} should be able to prompt`);
  }
});

test('the operating system is named, so the copy can be specific', () => {
  assert.equal(platformOf(UA.winChrome).os, 'windows');
  assert.equal(platformOf(UA.macChrome).os, 'mac');
  assert.equal(platformOf(UA.linuxChrome).os, 'linux');
  assert.equal(platformOf(UA.androidChrome).os, 'android');
  assert.equal(platformOf(UA.iphoneSafari).os, 'ios');
});

test('Windows is told about the download, other systems are not', () => {
  assert.match(platformOf(UA.winChrome).note, /download/i);
  assert.equal(platformOf(UA.macChrome).note, undefined);
  assert.equal(platformOf(UA.linuxChrome).note, undefined);
});

test('desktop Safari is sent to Add to Dock, not to Chrome\'s address bar', () => {
  // Safari installs through the File menu. Pointing a Safari user at an
  // address-bar icon sends them hunting for a button that is not there.
  const safari = platformOf(UA.macSafari);
  assert.equal(safari.id, 'safari-desktop');
  assert.equal(safari.canPrompt, false, 'Safari has no install prompt API');
  assert.ok(safari.steps.some((s) => /Add to Dock/i.test(s)));
  assert.ok(!safari.steps.some((s) => /address bar/i.test(s)), 'gave Chrome instructions to Safari');
});

test('desktop Firefox is told the truth rather than shown a dead button', () => {

  const firefox = platformOf(UA.winFirefox);
  assert.equal(firefox.id, 'firefox');
  assert.equal(firefox.canPrompt, false);
  assert.match(firefox.how, /does not install/i);
  assert.match(firefox.note, /Chrome or Edge|downloadable/i);
});

test('every branch returns something the interface can actually render', () => {
  for (const [name, ua] of Object.entries(UA)) {
    for (const standalone of [false, true]) {
      const p = platformOf(ua, { standalone, touchPoints: 5 });
      assert.ok(p.id && p.label && p.how, `${name} (standalone=${standalone}) is missing a field`);
      assert.ok(Array.isArray(p.steps), `${name} has no steps array`);
      assert.equal(typeof p.canPrompt, 'boolean');
      assert.equal(typeof p.installed, 'boolean');
    }
  }
});

test('an unknown user agent still gets a usable answer', () => {
  const p = platformOf('some-unknown-browser/1.0');
  assert.ok(p.id && p.how);
  assert.equal(p.canPrompt, false, 'never promise a prompt we cannot verify');
});

test('an empty user agent does not throw', () => {
  assert.ok(platformOf('').id);
  assert.ok(platformOf(undefined).id);
});
