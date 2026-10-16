// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// "Add to home screen": install button where the browser offers a prompt
// (Chromium, Android), step-by-step hint on iPhone/iPad, nothing when already installed.

import { h } from './dom.js';
import { t } from './i18n.js';

let deferred = null; // beforeinstallprompt event, kept for a click
let box = null; // install element on the current start screen

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  fill();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  fill();
});

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Element for the start screen; it fills itself when the browser offers installing later
export function installBox() {
  box = h('div', { class: 'install' });
  fill();
  return box;
}

function fill() {
  if (!box) return;
  if (isStandalone()) {
    box.replaceChildren();
    return;
  }
  if (deferred) {
    box.replaceChildren(h('button', {
      type: 'button',
      class: 'ghost small',
      onclick: async () => {
        const e = deferred;
        deferred = null;
        try {
          await e.prompt();
          await e.userChoice;
        } catch (err) {
          console.warn('install prompt', err);
        }
        fill();
      },
    }, `📲 ${t('installApp')}`));
    return;
  }
  if (isIos()) {
    const help = h('p', { class: 'muted install-help', hidden: true }, t('installIosHelp'));
    box.replaceChildren(
      h('button', { type: 'button', class: 'ghost small', onclick: () => {
        help.hidden = !help.hidden;
        if (!help.hidden) help.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } }, `📲 ${t('installApp')}`),
      help);
    return;
  }
  box.replaceChildren();
}
