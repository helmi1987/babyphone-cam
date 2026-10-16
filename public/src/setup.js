// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// First-start wizard; also reachable from the settings page ("run again").

import { h } from './dom.js';
import { t } from './i18n.js';
import { requestJson } from './api.js';
import { buildForm, restartBox } from './fields.js';

const STEPS = [
  { id: 'welcome' },
  { id: 'pins', group: 'pins' },
  { id: 'children', group: 'children' },
  { id: 'https', group: 'https' },
  { id: 'alarms', group: 'alarms' },
  { id: 'webhooks', group: 'webhooks' },
  { id: 'summary' },
];

// mode 'setup': no login, /api/setup. mode 'admin': admin cookie, /api/admin.
export function mountWizard(app, { mode, nav }) {
  const setup = mode === 'setup';
  // First start over plain HTTP: the server only allows the wizard here
  const plainHttp = setup && location.protocol === 'http:';
  const api = setup ? '/api/setup' : '/api/admin';
  const stateUrl = setup ? '/api/setup/state' : '/api/admin/settings';
  const saveUrl = setup ? '/api/setup' : '/api/admin/settings';
  let form = null;
  let state = null;
  let step = 0;
  let busy = false;
  const root = h('section', { class: 'view settings wizard' });
  app.replaceChildren(root);

  const keysOf = (s) => (s.group ? state.fields.filter((f) => f.group === s.group).map((f) => f.key) : []);
  const wizardKeys = () => STEPS.flatMap(keysOf);

  async function load() {
    root.replaceChildren(h('p', { class: 'muted' }, t('connecting')));
    try {
      const r = await requestJson(stateUrl);
      if (r.status === 401 && !setup) return nav.go('pin', 'admin');
      if (r.status === 409 && setup) return location.reload();
      if (!r.ok) throw new Error(String(r.status));
      state = r.data;
      form = buildForm(state, { api, setup, wizard: true });
      render();
    } catch {
      root.replaceChildren(h('p', { class: 'error', role: 'alert' }, t('serverError')),
        h('button', { type: 'button', onclick: load }, t('retry')));
    }
  }

  function summary() {
    return h('div', null,
      STEPS.filter((s) => s.group).map((s) => [
        h('h2', null, t(`g_${s.group}`)),
        h('dl', { class: 'readonly' }, keysOf(s).flatMap((k) => {
          const w = form.widgets[k];
          return w.el.hidden ? [] : [h('dt', null, t(`f_${k}`)), h('dd', null, w.summary())];
        })),
      ]));
  }

  function render(error) {
    const s = STEPS[step];
    const err = h('p', { class: 'error', role: 'alert' }, error || '');
    let body;
    if (s.id === 'welcome') {
      body = [h('img', { class: 'logo', src: '/icon.svg', alt: '', width: '96', height: '96' }),
        h('p', null, t(setup ? 'w_welcomeText' : 'w_againText'))];
    } else if (s.id === 'summary') {
      body = [h('p', { class: 'muted' }, t('w_summaryText')), summary()];
    } else {
      body = form.groupEls(s.group);
    }
    const back = h('button', { type: 'button', class: 'ghost', disabled: step === 0, onclick: () => go(step - 1) }, `‹ ${t('back')}`);
    const last = step === STEPS.length - 1;
    const next = h('button', { type: 'button', class: 'primary', onclick: () => (last ? save(next) : go(step + 1, true)) },
      last ? t('finish') : `${t('next')} ›`);
    root.replaceChildren(
      h('header', { class: 'bar' },
        h('h1', null, setup ? t('w_title') : t('wizardAgain')),
        setup ? null : h('button', { type: 'button', class: 'ghost small', onclick: () => nav.go('admin') }, t('close'))),
      plainHttp ? h('p', { class: 'warn insecure-hint' }, t('w_insecure')) : null,
      h('p', { class: 'muted step-count' }, t('step', { n: step + 1, total: STEPS.length })),
      h('ol', { class: 'steps' }, STEPS.map((x, i) => h('li', { class: i === step ? 'current' : i < step ? 'done' : '' }, t(`w_${x.id}`)))),
      h('h2', { class: 'step-title' }, t(`w_${s.id}`)),
      h('div', { class: 'step-body' }, body),
      err,
      h('div', { class: 'wiz-nav' }, back, next));
    window.scrollTo(0, 0);
  }

  function go(n, validate) {
    if (validate && !form.check(keysOf(STEPS[step]))) return;
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    render();
  }

  async function save(btn) {
    if (busy) return;
    for (let i = 0; i < STEPS.length; i++) {
      if (!form.check(keysOf(STEPS[i]))) {
        step = i;
        render(t('fixErrors'));
        return;
      }
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = t('saving');
    let r;
    try {
      r = await requestJson(saveUrl, { values: form.values(wizardKeys()) });
    } catch {
      r = null;
    }
    busy = false;
    if (!r) return render(t('serverError'));
    if (r.status === 401 && !setup) return nav.go('pin', 'admin');
    if (!r.ok) {
      const keys = form.showErrors(r.data?.errors);
      const at = STEPS.findIndex((s) => keysOf(s).some((k) => keys.includes(k)));
      if (at >= 0) step = at;
      return render(keys.length ? t('fixErrors') : t('saveFailed'));
    }
    done(r.data);
  }

  // Setup over HTTP ends on HTTPS; the server restarts itself first when TLS settings changed.
  function toHttps(result) {
    const port = Number(result?.httpsPort) || 443;
    const url = `https://${location.hostname}${port === 443 ? '' : `:${port}`}/`;
    root.replaceChildren(
      h('h1', null, t('saved')),
      h('p', null, t('setupDone')),
      h('p', { class: 'muted' }, t(result?.restarting ? 'w_toHttpsRestart' : 'w_toHttps')),
      h('p', null, h('a', { href: url }, url)),
      h('div', { class: 'wiz-nav' },
        h('button', { type: 'button', class: 'primary', onclick: () => { location.href = url; } }, t('w_toHttpsLink'))));
    setTimeout(() => { location.href = url; }, result?.restarting ? 6000 : 1500);
  }

  function done(result) {
    if (plainHttp) return toHttps(result);
    const pending = result?.restartPending || [];
    root.replaceChildren(
      h('h1', null, t('saved')),
      h('p', null, t('setupDone')),
      pending.length ? restartBox(pending) : '',
      h('div', { class: 'wiz-nav' },
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => (setup ? location.reload() : nav.go('admin')),
        }, setup ? t('toStart') : t('settings'))));
  }

  load();
  return null;
}
