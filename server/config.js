// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import os from 'node:os';
import path from 'node:path';

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
  const v = env[name];
  return v === undefined ? def : String(v).trim();
}

function int(name, def, min, max) {
  const raw = str(name);
  if (raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer ${min}..${max}`);
  return n;
}

function num(name, def, min, max) {
  const raw = str(name);
  if (raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} must be a number ${min}..${max}`);
  return n;
}

function list(name, def = '') {
  return str(name, def).split(',').map((s) => s.trim()).filter(Boolean);
}

function autoIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

const DEFAULT_CIDRS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,100.64.0.0/10,::1/128,fc00::/7,fe80::/10';

const parentPin = str('PARENT_PIN');
const childPin = str('CHILD_PIN');
if (!parentPin) fail('PARENT_PIN is required');
if (!childPin) fail('CHILD_PIN is required');
if (parentPin === childPin) fail('PARENT_PIN and CHILD_PIN must differ');

function webhooks() {
  const out = [];
  for (let n = 1; n <= 5; n++) {
    const url = str(`WEBHOOK_${n}_URL`);
    if (!url) continue;
    const method = str(`WEBHOOK_${n}_METHOD`, 'POST').toUpperCase() || 'POST';
    if (!['GET', 'POST', 'PUT'].includes(method)) fail(`WEBHOOK_${n}_METHOD must be GET, POST or PUT`);
    const headers = [];
    for (const pair of str(`WEBHOOK_${n}_HEADERS`).split('|')) {
      const i = pair.indexOf(':');
      if (i <= 0) continue;
      headers.push([pair.slice(0, i).trim(), pair.slice(i + 1).trim()]);
    }
    const events = list(`WEBHOOK_${n}_EVENTS`).map((e) => e.toLowerCase());
    out.push({ n, url, method, headers, body: env[`WEBHOOK_${n}_BODY`] || '', events: events.length ? events : null });
  }
  return out;
}

const announced = str('ANNOUNCED_IP');

export const config = Object.freeze({
  parentPin,
  childPin,
  childNames: list('CHILD_NAMES'),
  allowedCidrs: list('ALLOWED_CIDRS', DEFAULT_CIDRS),
  hosts: str('HOSTS').split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean),
  httpsPort: int('HTTPS_PORT', 443, 1, 65535),
  httpPort: int('HTTP_PORT', 80, 0, 65535),
  rtcPort: int('RTC_PORT', 40000, 1, 65535),
  announcedIp: announced && announced.toLowerCase() !== 'auto' ? announced : autoIp(),
  dataDir: path.resolve(str('DATA_DIR', '/data') || '/data'),
  tlsCert: str('TLS_CERT'),
  tlsKey: str('TLS_KEY'),
  certsDir: path.resolve(str('CERTS_DIR', '/certs') || '/certs'),
  certwardenUrl: str('CERTWARDEN_ENDPOINT_URL').replace(/\/+$/, ''),
  certName: str('CERT_NAME'),
  certCertApi: str('CERT_CERT_API'),
  certKeyApi: str('CERT_KEY_API'),
  certCheckDays: int('CERT_CHECK_DAY', 30, 1, 3650),
  heartbeatTimeout: int('HEARTBEAT_TIMEOUT', 20, 5, 3600),
  alarmDelay: int('ALARM_DELAY', 30, 0, 86400),
  offlineTimeout: int('OFFLINE_TIMEOUT', 600, 1, 7 * 86400),
  alarmUnackedDelay: int('ALARM_UNACKED_DELAY', 60, 0, 86400),
  soundThreshold: num('SOUND_THRESHOLD', 25, 0, 100),
  motionThreshold: num('MOTION_THRESHOLD', 4, 0, 100),
  webhooks: webhooks(),
  webhookTest: str('WEBHOOK_TEST') === '1',
});
