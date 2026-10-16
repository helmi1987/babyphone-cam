// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Settings schema and validation (no I/O). Effective value = settings.json ?? ENV ?? default.

import net from 'node:net';

export const WEBHOOK_EVENTS = ['child_offline', 'child_online', 'alarm_unacked', 'parent_offline', 'no_parent', 'test'];
export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT'];
export const MAX_WEBHOOKS = 5;
export const TLS_SOURCES = ['auto', 'certwarden', 'folder', 'selfsigned'];
export const DEFAULT_CIDRS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,100.64.0.0/10,::1/128,fc00::/7,fe80::/10';
export const PIN_KEYS = { admin: 'ADMIN_PIN', parent: 'PARENT_PIN', child: 'CHILD_PIN' };

// prop: property in the running config. restart: only applied at the next start.
export const FIELDS = [
  { key: 'ADMIN_PIN', group: 'pins', type: 'pin', secret: true },
  { key: 'PARENT_PIN', group: 'pins', type: 'pin', secret: true },
  { key: 'CHILD_PIN', group: 'pins', type: 'pin', secret: true },
  { key: 'CHILD_NAMES', group: 'children', type: 'names', def: [], prop: 'childNames' },
  { key: 'TLS_SOURCE', group: 'https', type: 'enum', values: TLS_SOURCES, def: 'auto', prop: 'tlsSource', restart: true },
  { key: 'CERTWARDEN_ENDPOINT_URL', group: 'https', type: 'url', def: '', prop: 'certwardenUrl', restart: true },
  { key: 'CERT_NAME', group: 'https', type: 'certname', def: '', prop: 'certName', restart: true },
  { key: 'CERT_CERT_API', group: 'https', type: 'secret', def: '', prop: 'certCertApi', secret: true, restart: true },
  { key: 'CERT_KEY_API', group: 'https', type: 'secret', def: '', prop: 'certKeyApi', secret: true, restart: true },
  { key: 'HEARTBEAT_TIMEOUT', group: 'alarms', type: 'int', min: 15, max: 3600, def: 20, prop: 'heartbeatTimeout' },
  { key: 'ALARM_DELAY', group: 'alarms', type: 'int', min: 0, max: 86400, def: 30, prop: 'alarmDelay' },
  { key: 'OFFLINE_TIMEOUT', group: 'alarms', type: 'int', min: 1, max: 7 * 86400, def: 600, prop: 'offlineTimeout' },
  { key: 'ALARM_UNACKED_DELAY', group: 'alarms', type: 'int', min: 0, max: 86400, def: 60, prop: 'alarmUnackedDelay' },
  { key: 'SOUND_THRESHOLD', group: 'alarms', type: 'num', min: 0, max: 100, def: 25, prop: 'soundThreshold' },
  { key: 'MOTION_THRESHOLD', group: 'alarms', type: 'num', min: 0, max: 100, def: 4, prop: 'motionThreshold' },
  { key: 'WEBHOOKS', group: 'webhooks', type: 'webhooks', def: [], prop: 'webhooks' },
  { key: 'ALLOWED_CIDRS', group: 'network', type: 'cidrs', def: DEFAULT_CIDRS.split(','), prop: 'allowedCidrs' },
  { key: 'HOSTS', group: 'network', type: 'hosts', def: [], prop: 'hosts' },
  { key: 'HTTPS_PORT', group: 'network', type: 'int', min: 1, max: 65535, def: 443, prop: 'httpsPort', restart: true },
  { key: 'HTTP_PORT', group: 'network', type: 'int', min: 0, max: 65535, def: 80, prop: 'httpPort', restart: true },
  { key: 'RTC_PORT', group: 'network', type: 'int', min: 1, max: 65535, def: 40000, prop: 'rtcPort', restart: true },
  { key: 'ANNOUNCED_IP', group: 'network', type: 'ip', def: 'auto', prop: 'announcedIpSetting', restart: true },
  { key: 'TLS_CERT', group: 'network', type: 'path', def: '', prop: 'tlsCert', restart: true },
  { key: 'TLS_KEY', group: 'network', type: 'path', def: '', prop: 'tlsKey', restart: true },
  { key: 'CERT_CHECK_DAY', group: 'network', type: 'int', min: 1, max: 3650, def: 30, prop: 'certCheckDays' },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// ---------------------------------------------------------------- IP helpers

export function normalizeIp(ip) {
  let s = String(ip || '').trim();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

export function ipToBig(ip) {
  if (net.isIPv4(ip)) {
    return { v: 4, n: ip.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n) };
  }
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
}

export function parseCidr(cidr) {
  const [addr, bitsRaw, extra] = String(cidr).split('/');
  if (extra !== undefined) return null;
  const ip = ipToBig(normalizeIp(addr));
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (bitsRaw === '' || !Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { v: ip.v, net: ip.n & mask, mask };
}

export function ipInCidrs(rawIp, parsed) {
  const ip = ipToBig(normalizeIp(rawIp));
  if (!ip) return false;
  return parsed.some((c) => c.v === ip.v && (ip.n & c.mask) === c.net);
}

// ---------------------------------------------------------------- parsing

const err = (code, extra = {}) => ({ error: { code, ...extra } });
const CONTROL = /[\u0000-\u001f\u007f]/;

function asText(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  return String(raw).trim();
}

function asList(raw, split) {
  if (Array.isArray(raw)) return raw.every((x) => typeof x === 'string') ? raw.map((s) => s.trim()).filter(Boolean) : null;
  const s = asText(raw);
  return s === null ? null : s.split(split).map((x) => x.trim()).filter(Boolean);
}

export function parseHeaders(raw) {
  // "Name: value" pairs separated by | or new lines
  if (Array.isArray(raw)) raw = raw.map((p) => (Array.isArray(p) ? `${p[0]}: ${p[1]}` : '')).join('\n');
  if (typeof raw !== 'string') return null;
  const out = [];
  for (const pair of raw.split(/[|\n]/)) {
    if (!pair.trim()) continue;
    const i = pair.indexOf(':');
    if (i <= 0) return null;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || CONTROL.test(value)) return null;
    out.push([name, value]);
  }
  return out.length <= 20 ? out : null;
}

function parseWebhook(w) {
  if (!w || typeof w !== 'object') return err('type');
  const url = asText(w.url);
  if (!url) return err('required', { sub: 'url' });
  const u = parseField(FIELD.CERTWARDEN_ENDPOINT_URL, url);
  if (u.error || url.length > 2000) return err('url', { sub: 'url' });
  const method = (asText(w.method) || 'POST').toUpperCase();
  if (!WEBHOOK_METHODS.includes(method)) return err('enum', { sub: 'method' });
  const headers = parseHeaders(w.headers ?? []);
  if (!headers) return err('headers', { sub: 'headers' });
  const body = typeof w.body === 'string' ? w.body : w.body == null ? '' : null;
  if (body === null || body.length > 4000) return err('body', { sub: 'body' });
  const events = asList(w.events ?? [], ',');
  if (!events) return err('events', { sub: 'events' });
  const ev = events.map((e) => e.toLowerCase());
  if (ev.some((e) => !WEBHOOK_EVENTS.includes(e))) return err('events', { sub: 'events' });
  return { value: { url, method, headers, body, events: ev.length ? [...new Set(ev)] : null } };
}

// Parse and validate one value (ENV string or JSON value). Returns {value} or {error:{code,...}}.
export function parseField(f, raw) {
  switch (f.type) {
    case 'pin': {
      const s = typeof raw === 'string' ? raw : null;
      if (s === null || !/^[0-9]{4,12}$/.test(s)) return err('pin');
      return { value: s };
    }
    case 'int':
    case 'num': {
      const s = typeof raw === 'number' ? raw : asText(raw);
      if (s === null || s === '') return err(f.type, { min: f.min, max: f.max });
      const n = Number(s);
      const ok = f.type === 'int' ? Number.isInteger(n) : Number.isFinite(n);
      if (!ok || n < f.min || n > f.max) return err(f.type, { min: f.min, max: f.max });
      return { value: n };
    }
    case 'names': {
      const list = asList(raw, ',');
      if (!list || list.length > 20 || list.some((n) => n.length > 40 || CONTROL.test(n) || n.includes(','))) return err('names');
      return { value: [...new Set(list)] };
    }
    case 'cidrs': {
      const list = asList(raw, /[\s,]+/);
      if (!list || !list.length || list.length > 64) return err('cidrs');
      const bad = list.find((c) => !parseCidr(c));
      if (bad) return err('cidr', { item: bad.slice(0, 60) });
      return { value: list };
    }
    case 'hosts': {
      const list = asList(raw, /[\s,]+/);
      if (!list || list.length > 64) return err('hosts');
      const norm = list.map((h) => h.toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);
      const bad = norm.find((h) => h.length > 253 || !/^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(h));
      if (bad) return err('host', { item: bad.slice(0, 60) });
      return { value: [...new Set(norm)] };
    }
    case 'enum': {
      const s = asText(raw);
      if (!f.values.includes(s)) return err('enum');
      return { value: s };
    }
    case 'url': {
      const s = asText(raw);
      if (s === null) return err('url');
      if (s === '') return { value: '' };
      try {
        const u = new URL(s);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return err('url');
      } catch {
        return err('url');
      }
      return { value: s.replace(/\/+$/, '') };
    }
    case 'certname': {
      const s = asText(raw);
      if (s === null || (s !== '' && !/^[A-Za-z0-9._~-]{1,200}$/.test(s))) return err('certname');
      return { value: s };
    }
    case 'secret': {
      const s = asText(raw);
      if (s === null || s.length > 512 || CONTROL.test(s)) return err('secret');
      return { value: s };
    }
    case 'path': {
      const s = asText(raw);
      if (s === null || (s !== '' && (!s.startsWith('/') || s.length > 1024 || CONTROL.test(s)))) return err('path');
      return { value: s };
    }
    case 'ip': {
      const s = asText(raw);
      if (s === null) return err('ip');
      if (s === '' || s.toLowerCase() === 'auto') return { value: 'auto' };
      if (!net.isIP(s)) return err('ip');
      return { value: s };
    }
    case 'webhooks': {
      if (!Array.isArray(raw) || raw.length > MAX_WEBHOOKS) return err('webhooks');
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        const r = parseWebhook(raw[i]);
        if (r.error) return err(r.error.code, { ...r.error, index: i });
        out.push(r.value);
      }
      return { value: out };
    }
    default:
      return err('type');
  }
}

// ---------------------------------------------------------------- ENV

const envStr = (env, name) => (env[name] === undefined ? '' : String(env[name]).trim());

// ENV value of a field: undefined = unset (empty counts as unset), else parseField result.
export function fieldFromEnv(f, env) {
  if (f.type === 'webhooks') {
    const out = [];
    for (let n = 1; n <= MAX_WEBHOOKS; n++) {
      const url = envStr(env, `WEBHOOK_${n}_URL`);
      if (!url) continue;
      const method = envStr(env, `WEBHOOK_${n}_METHOD`).toUpperCase() || 'POST';
      if (!WEBHOOK_METHODS.includes(method)) return err('enum', { item: `WEBHOOK_${n}_METHOD` });
      const headers = [];
      for (const pair of envStr(env, `WEBHOOK_${n}_HEADERS`).split('|')) {
        const i = pair.indexOf(':');
        if (i <= 0) continue;
        headers.push([pair.slice(0, i).trim(), pair.slice(i + 1).trim()]);
      }
      const events = envStr(env, `WEBHOOK_${n}_EVENTS`).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
      out.push({ url, method, headers, body: env[`WEBHOOK_${n}_BODY`] || '', events: events.length ? events : null });
    }
    return out.length ? { value: out } : undefined;
  }
  const raw = envStr(env, f.key);
  if (raw === '') return undefined;
  if (f.type === 'pin') return { value: raw }; // ENV PINs keep their old free format
  if (f.type === 'hosts') {
    // old lenient parsing: no validation of single names
    return { value: raw.split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean) };
  }
  if (f.type === 'cidrs' || f.type === 'names') return { value: raw.split(',').map((s) => s.trim()).filter(Boolean) };
  return parseField(f, raw);
}
