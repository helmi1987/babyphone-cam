// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Settings page for the admin role.

import { h } from './dom.js';
import { setLang, t } from './i18n.js';
import { requestJson } from './api.js';
import { buildForm, errText, restartBox } from './fields.js';

const GROUPS = ['general', 'pins', 'children', 'https', 'alarms', 'webhooks', 'network'];

export function mountAdmin(app, nav) {
  const root = h('section', { class: 'view settings' });
  app.replaceChildren(root);
  let form = null;
  let busy = false;

  async function logoutAdmin() {
    try {
      await requestJson('/api/admin/logout', {});
    } catch {
      // ignore
    }
    nav.go('start');
  }

  async function load(notice) {
    let r;
    try {
      r = await requestJson('/api/admin/settings');
    } catch {
      r = null;
    }
    if (r?.status === 401) return nav.go('pin', 'admin');
    if (!r?.ok) {
      root.replaceChildren(h('p', { class: 'error', role: 'alert' }, t('serverError')),
        h('button', { type: 'button', onclick: () => load() }, t('retry')));
      return;
    }
    render(r.data, notice);
  }

  function render(state, notice) {
    form = buildForm(state, { api: '/api/admin', setup: false, wizard: false });
    const status = h('p', { class: 'muted save-status', 'aria-live': 'polite' }, notice || '');
    const saveBtn = h('button', { type: 'button', class: 'primary', onclick: () => save(saveBtn, status) }, t('save'));
    root.replaceChildren(
      h('header', { class: 'bar' },
        h('button', { type: 'button', class: 'ghost', onclick: () => nav.go('start') }, `‹ ${t('back')}`),
        h('button', { type: 'button', class: 'ghost small', onclick: logoutAdmin }, t('logout'))),
      h('h1', null, t('settings')),
      state.restartPending.length ? restartBox(state.restartPending) : '',
      ...GROUPS.map((g) => h('section', { class: 'group' }, h('h2', null, t(`g_${g}`)), form.groupEls(g))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => nav.go('wizard') }, t('wizardAgain'))),
      h('div', { class: 'wiz-nav sticky' }, status, saveBtn));
  }

  async function save(btn, status) {
    if (busy) return;
    if (!form.check()) {
      status.textContent = t('fixErrors');
      return;
    }
    busy = true;
    btn.disabled = true;
    status.textContent = t('saving');
    let r;
    try {
      r = await requestJson('/api/admin/settings', { values: form.values() });
    } catch {
      r = null;
    }
    busy = false;
    btn.disabled = false;
    if (!r) {
      status.textContent = t('serverError');
      return;
    }
    if (r.status === 401) {
      status.textContent = t('sessionExpired');
      return;
    }
    if (!r.ok) {
      const keys = form.showErrors(r.data?.errors);
      status.textContent = keys.length ? t('fixErrors') : t('saveFailed');
      form.widgets[keys[0]]?.el.scrollIntoView({ block: 'center' });
      return;
    }
    // the new language applies right away on this device; others pick it up when they load the config
    if (r.data.changed.includes('APP_LANGUAGE')) {
      setLang(form.widgets.APP_LANGUAGE.get());
      document.title = t('appTitle');
    }
    await load(r.data.changed.length ? t('saved') : t('noChanges'));
  }

  load();
  return null;
}

// No admin PIN yet: set one with the parent PIN.
export function mountClaim(app, nav) {
  const props = { type: 'password', class: 'text', inputmode: 'numeric', maxLength: 12, autocomplete: 'off' };
  const parent = h('input', { ...props, id: 'claim-parent', autocomplete: 'current-password' });
  const a = h('input', { ...props, id: 'claim-new', autocomplete: 'new-password' });
  const b = h('input', { ...props, autocomplete: 'new-password', placeholder: t('pinConfirm'), 'aria-label': t('pinConfirm') });
  const err = h('p', { class: 'error', role: 'alert' });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    if (!/^[0-9]{4,12}$/.test(a.value)) return void (err.textContent = t('e_pin'));
    if (a.value !== b.value) return void (err.textContent = t('e_confirm'));
    busy = true;
    btn.disabled = true;
    err.textContent = '';
    try {
      const r = await requestJson('/api/admin/claim', { parentPin: parent.value, adminPin: a.value });
      if (r.ok) return nav.go('admin');
      if (r.status === 401) err.textContent = t('pinWrong');
      else if (r.status === 429) err.textContent = t('pinLocked');
      else if (r.status === 409) return nav.go('pin', 'admin');
      else err.textContent = errText(r.data?.errors?.ADMIN_PIN) || t('saveFailed');
    } catch {
      err.textContent = t('serverError');
    }
    busy = false;
    btn.disabled = false;
  };
  const btn = h('button', { type: 'button', class: 'primary big', onclick: submit }, t('claimSave'));
  app.replaceChildren(h('section', { class: 'view settings claim' },
    h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'ghost', onclick: () => nav.go('start') }, `‹ ${t('back')}`)),
    h('h1', null, t('claimTitle')),
    h('p', { class: 'muted' }, t('claimText')),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'claim-parent' }, t('pinParent')),
      parent),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'claim-new' }, t('claimNew')),
      h('p', { class: 'desc' }, t('e_pin')),
      h('div', { class: 'pair' }, a, b)),
    err,
    btn));
  parent.focus();
  return null;
}
