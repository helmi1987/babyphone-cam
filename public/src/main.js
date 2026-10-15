// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Entry: routing between start, PIN, child and parent views.

import { h, mediaAvailable } from './dom.js';
import { t } from './i18n.js';
import { getConfig, login, logout } from './api.js';
import { installAudioUnlock, unlockAudio } from './alarm.js';
import { mountChild } from './child.js';
import { mountParent } from './parent.js';

const PIN_MAX = 12;
const app = document.getElementById('app');
let cfg = { role: null, childNames: [] };
let view = null;

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
        cfg = c;
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
  else view = renderStart();
}

function renderStart(error) {
  app.replaceChildren(h('section', { class: 'view start' },
    h('h1', { class: 'title' }, t('appTitle')),
    h('p', { class: 'muted' }, t('useAs')),
    h('div', { class: 'roles' },
      h('button', { type: 'button', class: 'role', onclick: () => go('pin', 'child') }, t('roleChild')),
      h('button', { type: 'button', class: 'role', onclick: () => go('pin', 'parent') }, t('roleParent'))),
    mediaAvailable() ? null : h('p', { class: 'warn' }, window.isSecureContext ? t('noMedia') : t('insecure')),
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
  ));
  return null;
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
    unlockAudio(); // gesture: unlocks autoplay for later alarm/child audio
    busy = true;
    okBtn.disabled = true;
    try {
      const r = await login(role, pin);
      if (r.ok) {
        cfg = await getConfig();
        go(cfg.role || role);
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
    h('h1', null, role === 'child' ? t('pinChild') : t('pinParent')),
    dots,
    err,
    pad));
  return { destroy: () => document.removeEventListener('keydown', onKey) };
}

async function boot() {
  installAudioUnlock();
  try {
    cfg = await getConfig();
    go(cfg.role === 'child' || cfg.role === 'parent' ? cfg.role : 'start');
  } catch {
    renderStart(t('serverError'));
  }
}

boot();
