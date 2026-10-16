// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIELD, FIELDS, fieldFromEnv, parseField } from './settings.js';

const env = process.env;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// Local ISO 8601 time with offset (honours TZ).
export function isoNow(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function log(...parts) {
  console.log(`${isoNow()} ${parts.join(' ')}`);
}

function fail(message) {
  log(`config error: ${message}`);
  process.exit(1);
}

function str(name, def = '') {
  // Empty counts as unset: compose passes `NAME=` for values left empty in .env
  const v = env[name] === undefined ? '' : String(env[name]).trim();
  return v === '' ? def : v;
}

function autoIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------- infrastructure (ENV only)

const dataDir = path.resolve(str('DATA_DIR', '/data') || '/data');
const certsDir = path.resolve(str('CERTS_DIR', '/certs') || '/certs');
const SETTINGS_FILE = path.join(dataDir, 'settings.json');

export const infra = Object.freeze({
  DATA_DIR: dataDir,
  CERTS_DIR: certsDir,
  PUID: str('PUID'),
  PGID: str('PGID'),
  TZ: str('TZ'),
});

// ---------------------------------------------------------------- settings.json

const PIN_HASH = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

function loadStored() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log(`settings: cannot read ${SETTINGS_FILE} (${e.code || e.message}), using ENV and defaults`);
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const f = FIELD[key];
    if (!f) {
      log(`settings: ignoring unknown key ${key}`);
      continue;
    }
    if (f.type === 'pin') {
      if (typeof value === 'string' && PIN_HASH.test(value)) out[key] = value;
      else log(`settings: ignoring ${key}, not a PIN hash`);
      continue;
    }
    const r = parseField(f, value);
    if (r.error) log(`settings: ignoring invalid ${key}`);
    else out[key] = r.value;
  }
  return out;
}

let stored = loadStored();

const envValues = {};
for (const f of FIELDS) {
  const r = fieldFromEnv(f, env);
  if (!r) continue;
  // Invalid ENV is fatal unless settings.json overrides it
  if (r.error) {
    if (f.key in stored) continue;
    const range = r.error.min !== undefined ? ` ${r.error.min}..${r.error.max}` : '';
    fail(`${r.error.item || f.key} is invalid (${r.error.code}${range})`);
  }
  envValues[f.key] = r.value;
}

{
  const pins = ['ADMIN_PIN', 'PARENT_PIN', 'CHILD_PIN'].filter((k) => envValues[k] && !(k in stored));
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      if (envValues[pins[i]] === envValues[pins[j]]) fail(`${pins[i]} and ${pins[j]} must differ`);
    }
  }
}

export function sourceOf(key) {
  if (key in stored) return 'settings';
  if (key in envValues) return 'env';
  return 'default';
}

export function effective(key) {
  if (key in stored) return stored[key];
  if (key in envValues) return envValues[key];
  return FIELD[key].def;
}

export function storedValue(key) {
  return stored[key];
}

// Plain ENV PIN (hashed in memory by security.js).
export function envPin(key) {
  return envValues[key] || '';
}

// ---------------------------------------------------------------- running config

export const config = {
  dataDir,
  certsDir,
  webhookTest: str('WEBHOOK_TEST') === '1',
};

function apply(f, value) {
  if (!f.prop) return;
  if (f.key === 'WEBHOOKS') {
    config.webhooks = value.map((w, i) => ({ n: i + 1, ...w }));
  } else if (f.key === 'ANNOUNCED_IP') {
    config.announcedIpSetting = value;
    config.announcedIp = value && value !== 'auto' ? value : autoIp();
  } else {
    config[f.prop] = value;
  }
}

const startValues = {};
for (const f of FIELDS) {
  if (!f.prop) continue;
  startValues[f.key] = effective(f.key);
  apply(f, startValues[f.key]);
}

// Restart-only fields whose stored value differs from the running one.
export function restartPending() {
  return FIELDS.filter((f) => f.restart && JSON.stringify(effective(f.key)) !== JSON.stringify(startValues[f.key]))
    .map((f) => f.key);
}

function writeStored(next) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, '.settings.json.new');
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, SETTINGS_FILE);
}

// Store validated changes {KEY: value}; live fields apply at once. Throws on write errors.
export function saveSettings(changes) {
  const next = { ...stored, ...changes };
  writeStored(next);
  stored = next;
  for (const key of Object.keys(changes)) {
    const f = FIELD[key];
    if (!f.restart) apply(f, effective(key));
  }
  log(`settings: saved ${Object.keys(changes).join(', ') || 'nothing'}`);
}
