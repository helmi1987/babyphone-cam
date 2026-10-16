// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Form widgets shared by the settings page and the first-start wizard.
// Secrets never come from the server: '' / undefined = unchanged, null = clear.

import { h } from './dom.js';
import { LANG_NAMES, lang, t } from './i18n.js';
import { requestJson } from './api.js';

const MAX_HOOKS = 5;
let uid = 0;

export function errText(e) {
  if (!e) return '';
  const key = `e_${e.code}`;
  const s = t(key, { min: e.min ?? '', max: e.max ?? '', item: e.item ?? '' });
  return s === key ? t('e_invalid') : s;
}

function sourceHint(st) {
  if (st.source === 'env') return t('srcEnv');
  if (st.source === 'default') return t('srcDefault');
  return '';
}

function shell(st, control, { id, extra = [], status = null } = {}) {
  const err = h('p', { class: 'error', role: 'alert' });
  const hints = [sourceHint(st), st.restart ? t('needsRestart') : '', st.min !== undefined ? t('range', { min: st.min, max: st.max }) : '']
    .filter(Boolean).join(' · ');
  const el = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, t(`f_${st.key}`)),
    h('p', { class: 'desc' }, t(`d_${st.key}`)),
    status,
    control,
    extra,
    hints ? h('p', { class: 'hint' }, hints) : null,
    err);
  return { el, setError: (msg) => { err.textContent = msg || ''; } };
}

function textInput(id, value, props = {}) {
  return h('input', { id, type: 'text', class: 'text', autocomplete: 'off', spellcheck: 'false', value: value ?? '', ...props });
}

function textArea(id, value, props = {}) {
  const ta = h('textarea', { id, class: 'text area', rows: '3', spellcheck: 'false', autocomplete: 'off', ...props });
  ta.value = value ?? '';
  return ta;
}

function statusLine(set, extra = '') {
  const s = h('p', { class: 'status' });
  const render = (state) => {
    s.replaceChildren(h('span', { class: `dot ${state === 'set' ? 'ok' : ''}` }), ' ',
      state === 'set' ? t('isSet') : state === 'clear' ? t('willClear') : t('notSet'), extra ? ` · ${extra}` : '');
  };
  render(set ? 'set' : 'unset');
  return { el: s, render };
}

function segmented(options, value, onchange) {
  let current = value;
  const btns = options.map(([v, label]) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': String(v === current), onclick: () => select(v) }, label));
  const select = (v) => {
    current = v;
    btns.forEach((b, i) => {
      const on = options[i][0] === v;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
    onchange?.(v);
  };
  select(value);
  const el = h('div', { class: `segmented n${Math.min(options.length, 4)}` }, btns);
  return { el, get: () => current, set: select };
}

// ---------------------------------------------------------------- single fields

function pinField(st, ctx) {
  const id = `f${++uid}`;
  const props = { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxLength: 12 };
  const a = textInput(id, '', { ...props, placeholder: st.set ? t('unchangedPh') : '' });
  const b = textInput(`${id}c`, '', { ...props, placeholder: t('pinConfirm'), 'aria-label': t('pinConfirm') });
  const status = statusLine(st.set, st.source === 'env' ? t('srcEnv') : '');
  const s = shell({ ...st, source: 'settings' }, h('div', { class: 'pair' }, a, b), { id, status: status.el });
  return {
    ...s,
    get: () => (a.value ? a.value : undefined),
    check() {
      if (!a.value && !b.value) return ctx.setup && !st.set ? t('e_required') : '';
      if (!/^[0-9]{4,12}$/.test(a.value)) return t('e_pin');
      if (a.value !== b.value) return t('e_confirm');
      return '';
    },
    summary: () => (a.value ? t('pinNew') : st.set ? t('isSet') : t('notSet')),
  };
}

function secretField(st) {
  const id = `f${++uid}`;
  let cleared = false;
  const input = textInput(id, '', { type: 'password', autocomplete: 'new-password', placeholder: st.set ? t('unchangedPh') : '' });
  const status = statusLine(st.set, sourceHint(st));
  const clearBtn = st.set ? h('button', {
    type: 'button',
    class: 'ghost small',
    onclick: () => {
      cleared = !cleared;
      input.disabled = cleared;
      if (cleared) input.value = '';
      clearBtn.textContent = cleared ? t('undo') : t('clear');
      status.render(cleared ? 'clear' : 'set');
    },
  }, t('clear')) : null;
  const s = shell({ ...st, source: 'settings', restart: st.restart }, h('div', { class: 'inline' }, input, clearBtn), { id, status: status.el });
  return {
    ...s,
    get: () => (cleared ? null : input.value.trim() || undefined),
    summary: () => (cleared ? t('willClear') : input.value ? t('changed') : st.set ? t('isSet') : t('notSet')),
  };
}

function plainField(st) {
  const id = `f${++uid}`;
  let control;
  let get;
  if (st.type === 'int' || st.type === 'num') {
    control = textInput(id, String(st.value), {
      type: 'number', inputmode: st.type === 'int' ? 'numeric' : 'decimal', min: String(st.min), max: String(st.max), step: st.type === 'int' ? '1' : 'any',
    });
    get = () => control.value.trim();
  } else if (st.type === 'names' || st.type === 'cidrs' || st.type === 'hosts') {
    control = st.type === 'names' ? textInput(id, st.value.join(', ')) : textArea(id, st.value.join('\n'));
    get = () => control.value;
  } else {
    control = textInput(id, st.value, st.type === 'url' ? { inputmode: 'url' } : {});
    get = () => control.value.trim();
  }
  const s = shell(st, control, { id });
  return { ...s, get, summary: () => (Array.isArray(st.value) ? get().split(/[\s,]+/).filter(Boolean).join(', ') : get()) || '—' };
}

function tlsField(st, ctx) {
  const opts = (ctx.wizard ? ['folder', 'certwarden', 'selfsigned'] : st.values).map((v) => [v, t(`tls_${v}`)]);
  let start = st.value;
  if (ctx.wizard && start === 'auto') start = ctx.state.CERTWARDEN_ENDPOINT_URL?.value ? 'certwarden' : 'folder';
  const listeners = [];
  const seg = segmented(opts, start, (v) => listeners.forEach((fn) => fn(v)));
  const s = shell(st, seg.el, {});
  return {
    ...s,
    get: seg.get,
    onChange: (fn) => {
      listeners.push(fn);
      fn(seg.get());
    },
    summary: () => t(`tls_${seg.get()}`),
  };
}

// App language: auto + native language names. ctx.onLang (wizard) gets every change.
function langField(st, ctx) {
  const opts = st.values.map((v) => [v, v === 'auto' ? t('lang_auto') : LANG_NAMES[v] || v]);
  let ready = false;
  const seg = segmented(opts, st.value, (v) => {
    if (ready) ctx.onLang?.(v);
  });
  ready = true;
  seg.el.classList.add('lang');
  seg.el.querySelectorAll('.seg').forEach((b, i) => {
    if (opts[i][0] !== 'auto') b.setAttribute('lang', opts[i][0]);
  });
  const s = shell(st, seg.el, {});
  return { ...s, get: seg.get, summary: () => opts.find(([v]) => v === seg.get())?.[1] || seg.get() };
}

// ---------------------------------------------------------------- webhooks

function hookSlot(w, index, ctx, events, onRemove) {
  const id = `f${++uid}`;
  const existing = Boolean(w);
  let deleted = false;
  let headersCleared = false;
  const title = h('h3', { class: 'hook-title' });
  const url = textInput(id, '', { inputmode: 'url', placeholder: w?.urlSet ? t('unchangedPh') : 'https://…' });
  const method = segmented(['GET', 'POST', 'PUT'].map((m) => [m, m]), w?.method || 'POST');
  const headers = textArea(`${id}h`, '', { rows: '2', placeholder: w?.headersSet ? t('unchangedPh') : 'Content-Type: application/json' });
  const headStatus = w?.headersSet ? statusLine(true) : null;
  const headClear = w?.headersSet ? h('button', {
    type: 'button',
    class: 'ghost small',
    onclick: () => {
      headersCleared = !headersCleared;
      headers.disabled = headersCleared;
      if (headersCleared) headers.value = '';
      headClear.textContent = headersCleared ? t('undo') : t('clear');
      headStatus.render(headersCleared ? 'clear' : 'set');
    },
  }, t('clear')) : null;
  const body = textArea(`${id}b`, w?.body || '', { rows: '3' });
  const chosen = new Set(w?.events || []);
  const chips = events.map((ev) => {
    const b = h('button', {
      type: 'button',
      class: `chip ${chosen.has(ev) ? 'selected' : ''}`,
      'aria-pressed': String(chosen.has(ev)),
      onclick: () => {
        if (chosen.has(ev)) chosen.delete(ev);
        else chosen.add(ev);
        b.classList.toggle('selected', chosen.has(ev));
        b.setAttribute('aria-pressed', String(chosen.has(ev)));
      },
    }, ev);
    return b;
  });
  const result = h('p', { class: 'muted test-result', 'aria-live': 'polite' });
  const err = h('p', { class: 'error', role: 'alert' });

  const value = () => ({
    slot: existing ? index + 1 : 0,
    url: url.value.trim(),
    headers: headersCleared ? null : headers.value,
    method: method.get(),
    body: body.value,
    events: [...chosen],
  });

  const testBtn = h('button', {
    type: 'button',
    class: 'small',
    onclick: async () => {
      testBtn.disabled = true;
      result.textContent = t('testing');
      try {
        const r = await requestJson(`${ctx.api}/test-webhook`, value());
        const d = r.data || {};
        if (!r.ok) result.textContent = r.status === 401 ? t('sessionExpired') : t('testFail', { msg: `HTTP ${r.status}` });
        else if (d.ok) result.textContent = t('testOk', { status: d.status });
        else result.textContent = t('testFail', { msg: d.status ? `HTTP ${d.status}` : d.error ? errText({ code: d.error }) : d.reason || '?' });
      } catch {
        result.textContent = t('serverError');
      }
      testBtn.disabled = false;
    },
  }, t('testSend'));

  const fields = h('div', { class: 'hook-fields' },
    h('label', { class: 'field-label', for: id }, t('whUrl')),
    w?.urlSet ? statusLine(true).el : null,
    url,
    h('p', { class: 'hint' }, t('whHelp')),
    h('span', { class: 'field-label' }, t('whMethod')),
    method.el,
    h('label', { class: 'field-label', for: `${id}h` }, t('whHeaders')),
    headStatus?.el,
    h('div', { class: 'inline' }, headers, headClear),
    w?.headersSet ? h('p', { class: 'hint' }, t('whHeadersUrl')) : null,
    h('label', { class: 'field-label', for: `${id}b` }, t('whBody')),
    body,
    h('span', { class: 'field-label' }, t('whEvents')),
    h('div', { class: 'chips' }, chips),
    h('div', { class: 'actions' }, testBtn),
    result);
  const gone = h('p', { class: 'muted', hidden: true }, t('willClear'));
  const removeBtn = h('button', {
    type: 'button',
    class: 'ghost small',
    onclick: () => {
      if (!existing) {
        onRemove(slot);
        return;
      }
      deleted = !deleted;
      fields.hidden = deleted;
      gone.hidden = !deleted;
      removeBtn.textContent = deleted ? t('undo') : t('removeWebhook');
      onRemove(null);
    },
  }, t('removeWebhook'));
  const el = h('div', { class: 'hook' }, h('div', { class: 'bar' }, title, removeBtn), gone, fields, err);
  const slot = {
    el,
    existing,
    get deleted() { return deleted; },
    setTitle: (n) => { title.textContent = t('webhook', { n }); },
    get: () => (deleted ? { slot: index + 1, url: null } : value()),
    check: () => (!deleted && !existing && !url.value.trim() ? t('e_required') : ''),
    setError: (msg) => { err.textContent = msg || ''; },
  };
  return slot;
}

function webhooksField(st, ctx) {
  const list = h('div', { class: 'hooks' });
  const empty = h('p', { class: 'muted' }, t('noWebhooks'));
  const slots = [];
  const active = () => slots.filter((s) => !s.deleted).length;
  const addBtn = h('button', { type: 'button', class: 'ghost', onclick: () => add(null) }, `+ ${t('addWebhook')}`);
  const refresh = () => {
    let n = 0;
    for (const s of slots) if (!s.deleted) s.setTitle(++n);
    empty.hidden = active() > 0;
    addBtn.disabled = active() >= MAX_HOOKS;
  };
  const remove = (slot) => {
    if (slot) {
      slots.splice(slots.indexOf(slot), 1);
      slot.el.remove();
    }
    refresh();
  };
  function add(w, index) {
    const slot = hookSlot(w, index, ctx, ctx.events, remove);
    slots.push(slot);
    list.append(slot.el);
    refresh();
  }
  st.value.forEach((w, i) => add(w, i));
  const s = shell(st, h('div', null, empty, list, addBtn), {});
  return {
    ...s,
    get: () => slots.map((x) => x.get()),
    check() {
      let bad = '';
      for (const x of slots) {
        const m = x.check();
        x.setError(m);
        bad ||= m;
      }
      return bad;
    },
    summary: () => String(active()),
  };
}

// ---------------------------------------------------------------- form

// state: server answer of /api/setup/state or /api/admin/settings.
// ctx: {api: '/api/setup' | '/api/admin', setup: bool, wizard: bool, onLang?: fn(setting)}
export function buildForm(state, ctx) {
  const byKey = Object.fromEntries(state.fields.map((f) => [f.key, f]));
  const c = { ...ctx, state: byKey, events: state.events };
  const widgets = {};
  for (const st of state.fields) {
    let w;
    if (st.type === 'pin') w = pinField(st, c);
    else if (st.type === 'webhooks') w = webhooksField(st, c);
    else if (st.key === 'TLS_SOURCE') w = tlsField(st, c);
    else if (st.key === 'APP_LANGUAGE') w = langField(st, c);
    else if (st.secret) w = secretField(st);
    else w = plainField(st);
    widgets[st.key] = { ...w, key: st.key, group: st.group, state: st };
  }

  const groupCache = {};
  function groupEls(group) {
    groupCache[group] ||= groupElsOnce(group);
    return groupCache[group];
  }

  function groupElsOnce(group) {
    const els = state.fields.filter((f) => f.group === group).map((f) => widgets[f.key].el);
    if (group === 'https') els.push(...httpsExtras());
    if (group === 'network' && !ctx.wizard) els.push(...readonlyEls());
    return els;
  }

  function httpsExtras() {
    const cwKeys = ['CERTWARDEN_ENDPOINT_URL', 'CERT_NAME', 'CERT_CERT_API', 'CERT_KEY_API'];
    const result = h('p', { class: 'muted test-result', 'aria-live': 'polite' });
    const testBtn = h('button', {
      type: 'button',
      class: 'small',
      onclick: async () => {
        testBtn.disabled = true;
        result.textContent = t('testing');
        const v = (k) => widgets[k].get() || '';
        try {
          const r = await requestJson(`${ctx.api}/test-certwarden`, {
            url: v('CERTWARDEN_ENDPOINT_URL'), name: v('CERT_NAME'), certApi: v('CERT_CERT_API'), keyApi: v('CERT_KEY_API'),
          });
          const d = r.data || {};
          if (!r.ok) result.textContent = r.status === 401 ? t('sessionExpired') : t('testFail', { msg: `HTTP ${r.status}` });
          else if (d.ok) {
            const date = new Date(d.expires).toLocaleDateString(lang);
            result.textContent = t('cwOk', { names: d.names.join(', ') || '—', date });
          } else result.textContent = t('testFail', { msg: d.message || errText({ code: d.error }) });
        } catch {
          result.textContent = t('serverError');
        }
        testBtn.disabled = false;
      },
    }, t('test'));
    const cwTest = h('div', { class: 'field' }, h('div', { class: 'actions' }, testBtn), result);
    const info = h('p', { class: 'muted info' });
    widgets.TLS_SOURCE.onChange((v) => {
      const cw = v === 'certwarden' || v === 'auto';
      for (const k of cwKeys) widgets[k].el.hidden = !cw;
      cwTest.hidden = !cw;
      info.textContent = t(`tlsInfo_${v}`, { dir: state.readonly.CERTS_DIR });
    });
    // the info sits right below the source choice
    widgets.TLS_SOURCE.el.append(info);
    return [cwTest];
  }

  function readonlyEls() {
    return [h('div', { class: 'field' },
      h('span', { class: 'field-label' }, t('g_system')),
      h('p', { class: 'desc' }, t('readonlyHint')),
      h('dl', { class: 'readonly' }, Object.entries(state.readonly).flatMap(([k, v]) => [
        h('dt', null, `${t(`f_${k}`)} (${k})`),
        h('dd', null, v || '—', h('br'), h('small', { class: 'muted' }, t(`d_${k}`))),
      ])))];
  }

  // First local error per key; also shows it. Returns true when fine.
  function check(keys = Object.keys(widgets)) {
    let ok = true;
    for (const k of keys) {
      const m = widgets[k].check?.() || '';
      if (widgets[k].check) widgets[k].setError(m);
      if (m) ok = false;
    }
    // new PINs must differ from each other (the server also checks stored ones)
    const seen = new Map();
    for (const k of keys) {
      const w = widgets[k];
      if (w.state.type !== 'pin' || !w.get()) continue;
      if (seen.has(w.get())) {
        w.setError(t('e_pinSame'));
        ok = false;
      }
      seen.set(w.get(), k);
    }
    return ok;
  }

  function values(keys = Object.keys(widgets)) {
    const out = {};
    for (const k of keys) {
      if (widgets[k].el.hidden && widgets[k].state.secret) continue;
      const v = widgets[k].get();
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // Server errors {KEY: {code,...}}; returns the keys that have one.
  function showErrors(errors) {
    for (const w of Object.values(widgets)) w.setError('');
    const keys = [];
    for (const [k, e] of Object.entries(errors || {})) {
      const w = widgets[k];
      if (!w) continue;
      const msg = errText(e);
      w.setError(e.index !== undefined ? `${t('webhook', { n: e.index + 1 })}: ${msg}` : msg);
      keys.push(k);
    }
    return keys;
  }

  return { widgets, groupEls, check, values, showErrors };
}

// Restart button: the server exits after answering; Docker starts it again.
export function restartBox(pending) {
  const msg = h('p', null, t('restartHint', { keys: pending.map((k) => t(`f_${k}`)).join(', ') }));
  const btn = h('button', {
    type: 'button',
    class: 'danger',
    onclick: async () => {
      btn.disabled = true;
      try {
        const r = await requestJson('/api/admin/restart', {});
        if (!r.ok) {
          msg.textContent = r.status === 401 ? t('sessionExpired') : t('saveFailed');
          btn.disabled = false;
          return;
        }
      } catch {
        // connection may close early
      }
      msg.textContent = t('restarting');
      waitAndReload();
    },
  }, t('restartNow'));
  return h('div', { class: 'warn restart' }, h('strong', null, t('restartNeeded')), msg, btn);
}

function waitAndReload() {
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 4000) {
      try {
        const r = await fetch('/api/config', { cache: 'no-store' });
        if (r.ok) {
          location.reload();
          return;
        }
      } catch {
        // still down
      }
    }
    if (Date.now() - started > 60000) location.reload();
    else setTimeout(poll, 1500);
  };
  setTimeout(poll, 1500);
}
