// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Entry: routing between start, PIN, child, parent, settings and setup views.

import { h, mediaAvailable } from './dom.js';
import { setLang, t } from './i18n.js';
import { getConfig, login, logout } from './api.js';
import { installAudioUnlock, unlockAudio, setAudioSession } from './alarm.js';
import { installHint } from './install.js';
import { mountChild } from './child.js';
import { mountParent } from './parent.js';
import { mountAdmin, mountClaim } from './admin.js';
import { mountWizard } from './setup.js';

const PIN_MAX = 12;
const app = document.getElementById('app');
let cfg = { role: null, childNames: [] };
let view = null;

// Server config; also applies the app language setting before anything renders.
function useConfig(c) {
  cfg = c;
  setLang(c.appLanguage);
}

const nav = {
  go,
  async logout() {
    await logout();
    cfg.role = null;
    go('start');
  },
  // Called after a WS drop: if the cookie is gone or changed, back to start.
  async checkAuth(role) {
    try {
      const c = await getConfig();
      if (c.role !== role) {
        useConfig(c);
        go(c.role || 'start');
      }
    } catch {
      // server unreachable, keep reconnecting
    }
  },
};

function go(name, arg) {
  try {
    view?.destroy?.();
  } catch (e) {
    console.error(e);
  }
  view = null;
  app.replaceChildren();
  document.title = t('appTitle');
  if (name === 'child') view = mountChild(app, cfg, nav);
  else if (name === 'parent') view = mountParent(app, cfg, nav);
  else if (name === 'pin') view = renderPin(arg);
  else if (name === 'setup') view = mountWizard(app, { mode: 'setup', nav });
  else if (name === 'wizard') view = mountWizard(app, { mode: 'admin', nav });
  else if (name === 'admin') view = mountAdmin(app, nav);
  else if (name === 'claim') view = mountClaim(app, nav);
  else view = renderStart();
}


function renderStart(error) {
  app.replaceChildren(h('section', { class: 'view start' },
    h('img', { class: 'logo', src: '/icon.svg', alt: '', width: '112', height: '112' }),
    h('h1', { class: 'title' }, t('appTitle')),
    h('p', { class: 'muted' }, t('useAs')),
    h('div', { class: 'roles' },
      h('button', { type: 'button', class: 'role', onclick: () => go('pin', 'child') }, t('roleChild')),
      h('button', { type: 'button', class: 'role', onclick: () => go('pin', 'parent') }, t('roleParent'))),
    mediaAvailable() ? null : h('p', { class: 'warn' }, window.isSecureContext ? t('noMedia') : t('insecure')),
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
    h('button', { type: 'button', class: 'ghost small settings-link', onclick: openSettings }, `⚙ ${t('settings')}`),
    installHint(),
  ));
  return null;
}

function openSettings() {
  if (cfg.admin) go('admin');
  else if (cfg.adminPin === false) go('claim');
  else go('pin', 'admin');
}

function renderPin(role) {
  let pin = '';
  let busy = false;
  const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite' });
  const err = h('p', { class: 'error', role: 'alert' });
  const renderDots = () => {
    dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) =>
      h('span', { class: i < pin.length ? 'filled' : '' })));
  };
  const press = (d) => {
    if (busy) return;
    err.textContent = '';
    if (d === 'del') pin = pin.slice(0, -1);
    else if (pin.length < PIN_MAX) pin += d;
    renderDots();
  };
  const submit = async () => {
    if (busy || !pin) return;
    // iOS: the session type must be set before the AudioContext starts; switching it
    // while the context runs leaves the parent page silent until a reload.
    if (role === 'parent') setAudioSession('playback');
    unlockAudio(); // gesture: unlocks autoplay for later alarm/child audio
    busy = true;
    okBtn.disabled = true;
    try {
      const r = await login(role, pin);
      if (r.ok) {
        useConfig(await getConfig());
        go(role === 'admin' ? 'admin' : cfg.role || role);
        return;
      }
      err.textContent = r.status === 429 ? t('pinLocked') : r.status === 401 || r.status === 403 ? t('pinWrong') : t('pinError');
    } catch {
      err.textContent = t('serverError');
    }
    pin = '';
    renderDots();
    busy = false;
    okBtn.disabled = false;
    dots.classList.remove('shake');
    void dots.offsetWidth;
    dots.classList.add('shake');
  };

  const key = (label, onclick, cls = '') =>
    h('button', { type: 'button', class: `key ${cls}`, onclick }, label);
  const okBtn = key(t('ok'), submit, 'ok');
  const delBtn = key('⌫', () => press('del'), 'fn');
  delBtn.setAttribute('aria-label', t('del'));
  const pad = h('div', { class: 'pinpad' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => press(d))),
    delBtn,
    key('0', () => press('0')),
    okBtn);

  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') go('start');
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  renderDots();
  app.replaceChildren(h('section', { class: 'view pin' },
    h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'ghost', onclick: () => go('start') }, `‹ ${t('back')}`)),
    h('h1', null, role === 'child' ? t('pinChild') : role === 'admin' ? t('pinAdmin') : t('pinParent')),
    dots,
    err,
    pad));
  return { destroy: () => document.removeEventListener('keydown', onKey) };
}

async function boot() {
  installAudioUnlock();
  try {
    useConfig(await getConfig());
    if (cfg.setup) go('setup');
    else go(cfg.role === 'child' || cfg.role === 'parent' ? cfg.role : 'start');
  } catch {
    renderStart(t('serverError'));
  }
}

boot();
