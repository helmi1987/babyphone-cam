// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// "Add to home screen" hint on the start screen of a phone: floating card with
// the install button where the browser offers a dialog (Chromium, Android),
// Share instructions on iPhone/iPad, a menu hint elsewhere. Hidden in the app
// itself, after installing and for 30 days after closing it.

import { h, load, save } from './dom.js';
import { t } from './i18n.js';

const KEY = 'bp.installHint';
const CLOSED_MS = 30 * 86400 * 1000;
const SHARE_SVG = '<svg class="install-share" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

let deferred = null; // beforeinstallprompt event, kept for the button
let box = null; // card of the current start screen

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  if (box?.isConnected && eligible()) show('android');
});
window.addEventListener('appinstalled', () => {
  remember({ installed: true });
  hide();
});

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function remember(patch) {
  save(KEY, { ...load(KEY, {}), ...patch });
}

function eligible() {
  if (isStandalone()) {
    remember({ installed: true });
    return false;
  }
  const s = load(KEY, {});
  const phone = window.matchMedia?.('(max-width: 900px) and (pointer: coarse)').matches;
  return phone && !s.installed && !(s.closed && Date.now() - s.closed < CLOSED_MS);
}

// Card for the start screen; shows itself when it applies
export function installHint() {
  const go = h('button', {
    type: 'button',
    class: 'primary small',
    hidden: true,
    onclick: async () => {
      const e = deferred;
      if (!e) return;
      deferred = null;
      try {
        await e.prompt();
        await e.userChoice;
      } catch (err) {
        console.warn('install prompt', err);
      }
      hide(true);
    },
  }, t('installButton'));
  const ios = h('span', { 'data-install': 'ios' });
  const [before, after = ''] = t('installIos').split('{share}');
  const share = h('span', { 'aria-label': t('installShare'), role: 'img' });
  share.innerHTML = SHARE_SVG;
  ios.append(before, share, after);
  box = h('div', { class: 'install-hint', role: 'dialog', 'aria-labelledby': 'install-title', hidden: true },
    h('img', { src: '/icon-192.png', alt: '', width: '44', height: '44' }),
    h('div', { class: 'install-text' },
      h('strong', { id: 'install-title' }, t('installTitle')),
      h('span', { 'data-install': 'android' }, t('installAndroid')),
      ios,
      h('span', { 'data-install': 'other' }, t('installOther'))),
    go,
    h('button', { type: 'button', class: 'install-close', 'aria-label': t('close'), onclick: () => hide(true) }, '×'));
  box.goBtn = go;
  if (eligible()) {
    if (deferred) show('android');
    // iPhone: instructions; other browsers: menu hint, unless Chromium offers its dialog shortly
    else {
      const card = box;
      setTimeout(() => {
        if (box === card && card.isConnected && card.hidden && !deferred && eligible()) show(isIos() ? 'ios' : 'other');
      }, 1500);
    }
  }
  return box;
}

function show(kind) {
  if (!box) return;
  box.querySelectorAll('[data-install]').forEach((el) => { el.hidden = el.dataset.install !== kind; });
  box.goBtn.hidden = kind !== 'android';
  box.hidden = false;
}

function hide(closed) {
  if (box) box.hidden = true;
  if (closed) remember({ closed: Date.now() });
}
