// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, log } from './config.js';

export const COOKIE_NAME = 'bp_session';
export const COOKIE_MAX_AGE = 90 * 86400; // seconds
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_FAILS = 5;
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.fritz.box', '.ts.net'];

// ---------------------------------------------------------------- IP allowlist

export function normalizeIp(ip) {
  let s = String(ip || '').trim();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function ipToBig(ip) {
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

function parseCidr(cidr) {
  const [addr, bitsRaw] = cidr.split('/');
  const ip = ipToBig(normalizeIp(addr));
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { v: ip.v, net: ip.n & mask, mask };
}

const cidrs = config.allowedCidrs.map((c) => {
  const p = parseCidr(c);
  if (!p) log(`config: ignoring invalid CIDR ${c}`);
  return p;
}).filter(Boolean);

export function ipAllowed(rawIp) {
  const ip = ipToBig(normalizeIp(rawIp));
  if (!ip) return false;
  return cidrs.some((c) => c.v === ip.v && (ip.n & c.mask) === c.net);
}

// ---------------------------------------------------------------- host check

export function hostWithoutPort(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(1).split(']')[0];
  return v.split(':')[0].replace(/\.+$/, '');
}

// Against DNS rebinding: IPs, local names, certificate names and HOSTS only.
export function knownHost(value, certNames = []) {
  const host = hostWithoutPort(value);
  if (!host.includes('.')) return true; // no host, localhost, plain names, IPv6 literals
  if (net.isIP(host)) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  for (const name of [...config.hosts, ...certNames]) {
    if (name.startsWith('*.') || name.startsWith('.')) {
      if (host.endsWith(name.slice(name.indexOf('.')))) return true;
    } else if (host === name) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- cookies

function loadSecret() {
  const file = path.join(config.dataDir, 'cookie-secret');
  try {
    const s = fs.readFileSync(file);
    if (s.length >= 32) return s;
  } catch { /* create */ }
  const secret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (e) {
    log(`security: cannot store cookie secret (${e.code || 'error'}), sessions end on restart`);
  }
  return secret;
}

const secret = loadSecret();

function pinFor(role) {
  return role === 'parent' ? config.parentPin : role === 'child' ? config.childPin : null;
}

function hmacKey(role) {
  return crypto.createHash('sha256').update(secret).update(pinFor(role)).digest();
}

function mac(role, issued) {
  return crypto.createHmac('sha256', hmacKey(role)).update(`${role}.${issued}`).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPin(role, pin) {
  const expected = pinFor(role);
  if (!expected) return false;
  return safeEqual(String(pin ?? ''), expected);
}

export function makeSession(role) {
  const issued = Math.floor(Date.now() / 1000);
  return `${role}.${issued}.${mac(role, issued)}`;
}

export function sessionCookie(value) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Returns 'parent' | 'child' | null.
export function roleFromRequest(req) {
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [role, issuedRaw, sig] = parts;
  if (role !== 'parent' && role !== 'child') return null;
  const issued = Number(issuedRaw);
  if (!Number.isInteger(issued)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (issued > now + 60 || now - issued > COOKIE_MAX_AGE) return null;
  return safeEqual(sig, mac(role, issuedRaw)) ? role : null;
}

// ---------------------------------------------------------------- rate limit

const failures = new Map(); // ip -> [timestamps]

function recent(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

export function rateLimited(ip) {
  return recent(ip).length >= RATE_MAX_FAILS;
}

export function recordFailure(ip) {
  const list = recent(ip);
  list.push(Date.now());
  failures.set(ip, list);
}

setInterval(() => {
  for (const ip of [...failures.keys()]) recent(ip);
}, RATE_WINDOW_MS).unref();

// ---------------------------------------------------------------- headers

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' wss:",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(self), microphone=(self)',
};
