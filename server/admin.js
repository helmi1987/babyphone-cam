// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Settings state for the browser (without secrets), input validation and tests.

import { effective, infra, log, restartPending, sourceOf } from './config.js';
import { certFacts, certwardenFetch } from './certs.js';
import { hashPin, pinHash, pinSource, setupMode, verifyHash } from './security.js';
import { FIELD, FIELDS, PIN_KEYS, WEBHOOK_EVENTS, ipInCidrs, parseCidr, parseField } from './settings.js';
import { testWebhook } from './webhooks.js';

const ROLE_OF = Object.fromEntries(Object.entries(PIN_KEYS).map(([role, key]) => [key, role]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fieldState(f) {
  const meta = { key: f.key, group: f.group, type: f.type, restart: Boolean(f.restart), secret: Boolean(f.secret) };
  if (f.min !== undefined) Object.assign(meta, { min: f.min, max: f.max });
  if (f.values) meta.values = f.values;
  if (f.type === 'pin') {
    const role = ROLE_OF[f.key];
    return { ...meta, set: Boolean(pinHash(role)), source: pinSource(role) };
  }
  const value = effective(f.key);
  const source = sourceOf(f.key);
  if (f.secret) return { ...meta, set: Boolean(value), source };
  if (f.type === 'webhooks') {
    return {
      ...meta,
      source,
      value: value.map((w) => ({ urlSet: Boolean(w.url), headersSet: w.headers.length > 0, method: w.method, body: w.body, events: w.events || [] })),
    };
  }
  return { ...meta, source, value, def: f.def };
}

export function settingsState() {
  return {
    setup: setupMode(),
    fields: FIELDS.map(fieldState),
    readonly: infra,
    events: WEBHOOK_EVENTS,
    restartPending: restartPending(),
  };
}

// Stored webhook of a slot number (1..5) sent by the browser; 0/missing = new.
function storedHook(slot) {
  return Number.isInteger(slot) && slot >= 1 ? effective('WEBHOOKS')[slot - 1] : undefined;
}

// Merge a webhook slot from the browser with the stored one (secrets: ''/missing = unchanged, null = clear).
// Stored headers are only kept for the stored URL, so they never go to a new address.
function mergeHook(input, existing) {
  if (!input || typeof input !== 'object') return { bad: true };
  if (input.url === null) return null;
  const typed = typeof input.url === 'string' ? input.url.trim() : '';
  const url = typed || existing?.url || '';
  if (!url) return null; // empty slot
  const sameUrl = Boolean(existing) && url === existing.url;
  let headers;
  if (input.headers === null) headers = [];
  else if (typeof input.headers === 'string' && input.headers.trim()) headers = input.headers;
  else if (sameUrl) headers = existing.headers;
  else if (existing?.headers.length) return { reenter: true };
  else headers = [];
  return { url, headers, method: input.method, body: input.body, events: input.events };
}

function mergeHooks(list) {
  if (!Array.isArray(list)) return { error: { code: 'webhooks' } };
  const out = [];
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    const slot = list[i]?.slot;
    if (slot && (used.has(slot) || !storedHook(slot))) return { error: { code: 'type', index: i } };
    if (slot) used.add(slot);
    const m = mergeHook(list[i], storedHook(slot));
    if (m?.bad) return { error: { code: 'type', index: i } };
    if (m?.reenter) return { error: { code: 'headersReenter', index: i } };
    if (m) out.push(m);
  }
  return { value: out };
}

// Validate browser input {KEY: value}. Returns {errors} or {changes, pinRoles}.
export async function buildChanges(values, { setup, ip }) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { errors: { _: { code: 'type' } } };
  const errors = {};
  const changes = {};
  const newPins = {};
  const given = new Set(); // secrets sent in this request (new value or delete)
  for (const key of Object.keys(values)) {
    if (!FIELD[key]) errors[key] = { code: 'unknown' };
  }
  if (Object.keys(errors).length) return { errors };

  for (const [key, raw] of Object.entries(values)) {
    const f = FIELD[key];
    if (f.type === 'pin') {
      if (raw === undefined || raw === '') continue;
      if (raw === null) {
        errors[key] = { code: 'noDelete' };
        continue;
      }
      const r = parseField(f, raw);
      if (r.error) errors[key] = r.error;
      else newPins[ROLE_OF[key]] = r.value;
      continue;
    }
    let input = raw;
    if (f.secret) {
      if (raw === undefined || raw === '') continue;
      given.add(key);
      if (raw === null) input = '';
    }
    if (f.type === 'webhooks') {
      const m = mergeHooks(raw);
      if (m.error) {
        errors[key] = m.error;
        continue;
      }
      input = m.value;
    }
    const r = parseField(f, input);
    if (r.error) {
      errors[key] = r.error;
      continue;
    }
    if (!same(r.value, effective(key))) changes[key] = r.value;
  }

  // PINs: all three must exist after setup and differ from each other
  const roles = Object.keys(PIN_KEYS);
  for (const role of roles) {
    if (setup && !newPins[role] && !pinHash(role)) errors[PIN_KEYS[role]] ||= { code: 'required' };
  }
  for (let i = 0; i < roles.length; i++) {
    for (let j = 0; j < roles.length; j++) {
      if (i === j) continue;
      const a = newPins[roles[i]];
      if (!a || errors[PIN_KEYS[roles[i]]]) continue;
      const b = newPins[roles[j]];
      const clash = b ? (j < i && a === b) : (pinHash(roles[j]) && await verifyHash(pinHash(roles[j]), a));
      if (clash) errors[PIN_KEYS[roles[i]]] = { code: 'pinSame' };
    }
  }

  // Stored Cert Warden keys never follow a new address: they must be entered again
  if ('CERTWARDEN_ENDPOINT_URL' in changes) {
    for (const k of ['CERT_CERT_API', 'CERT_KEY_API']) {
      if (effective(k) && !given.has(k) && !errors[k]) errors[k] = { code: 'reenter' };
    }
  }
  if (changes.ALLOWED_CIDRS && !ipInCidrs(ip, changes.ALLOWED_CIDRS.map(parseCidr))) {
    errors.ALLOWED_CIDRS = { code: 'lockout', item: ip };
  }
  const port = (k) => (k in changes ? changes[k] : effective(k));
  if (port('HTTP_PORT') > 0 && port('HTTP_PORT') === port('HTTPS_PORT')) errors.HTTP_PORT = { code: 'portClash' };
  if (port('RTC_PORT') === port('HTTPS_PORT')) errors.RTC_PORT = { code: 'portClash' };

  if (Object.keys(errors).length) return { errors };
  for (const [role, pin] of Object.entries(newPins)) changes[PIN_KEYS[role]] = await hashPin(pin);
  // Adopt values that still come from ENV, so saving makes the backend the only source
  // and the ENV variables can be removed afterwards.
  for (const f of FIELDS) {
    if (f.key in changes) continue;
    if (f.type === 'pin') {
      const role = ROLE_OF[f.key];
      if (pinSource(role) === 'env') changes[f.key] = pinHash(role);
    } else if (sourceOf(f.key) === 'env') {
      // Same strict check as loadStored, so an adopted value is not dropped at the next start
      const r = parseField(f, effective(f.key));
      if (r.error) log(`settings: not adopting ${f.key} from ENV, invalid for settings.json`);
      else changes[f.key] = r.value;
    }
  }
  return { changes, pinRoles: Object.keys(newPins) };
}

// Cert Warden test with browser values; missing API keys fall back to the stored
// ones only for the stored address (never sent to another host).
export async function testCertwarden(input) {
  const typed = (k) => (typeof input?.[k] === 'string' ? input[k].trim() : '');
  const url = parseField(FIELD.CERTWARDEN_ENDPOINT_URL, typed('url') || effective('CERTWARDEN_ENDPOINT_URL'));
  const name = parseField(FIELD.CERT_NAME, typed('name') || effective('CERT_NAME'));
  if (url.error || !url.value) return { ok: false, error: 'url' };
  if (name.error || !name.value) return { ok: false, error: 'certname' };
  const stored = url.value === effective('CERTWARDEN_ENDPOINT_URL');
  const certCertApi = typed('certApi') || (stored ? effective('CERT_CERT_API') : '');
  const certKeyApi = typed('keyApi') || (stored ? effective('CERT_KEY_API') : '');
  if (!certCertApi || !certKeyApi) return { ok: false, error: 'apiKeys' };
  try {
    const { chain } = await certwardenFetch({ certwardenUrl: url.value, certName: name.value, certCertApi, certKeyApi });
    const facts = certFacts(chain);
    return { ok: true, names: facts.names, expires: new Date(facts.expires).toISOString() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Webhook test: {slot, url, headers, method, body, events}; empty secrets = stored slot.
export async function testWebhookInput(input) {
  const m = mergeHook(input, storedHook(input?.slot));
  if (!m || m.bad) return { ok: false, error: 'url' };
  if (m.reenter) return { ok: false, error: 'headersReenter' };
  const r = parseField(FIELD.WEBHOOKS, [m]);
  if (r.error) return { ok: false, error: r.error.code };
  return testWebhook(r.value[0]);
}
