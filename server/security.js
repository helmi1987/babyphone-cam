// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, envPin, log, storedValue } from './config.js';
import { PIN_KEYS, ipInCidrs, normalizeIp, parseCidr } from './settings.js';

export const COOKIE_NAME = 'bp_session';
export const COOKIE_MAX_AGE = 90 * 86400; // seconds
export const ADMIN_COOKIE = 'bp_admin';
export const ADMIN_MAX_AGE = 3600; // seconds
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_FAILS = 5;
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.fritz.box', '.ts.net'];

// ---------------------------------------------------------------- IP allowlist

export { normalizeIp };

let cidrCache = { src: null, list: [] };

// Re-parsed whenever the settings replace config.allowedCidrs.
function allowedCidrs() {
  if (cidrCache.src !== config.allowedCidrs) {
    const list = config.allowedCidrs.map((c) => {
      const p = parseCidr(c);
      if (!p) log(`config: ignoring invalid CIDR ${c}`);
      return p;
    }).filter(Boolean);
    cidrCache = { src: config.allowedCidrs, list };
  }
  return cidrCache.list;
}

export function ipAllowed(rawIp) {
  return ipInCidrs(rawIp, allowedCidrs());
}

// ---------------------------------------------------------------- host check

export function hostWithoutPort(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(1).split(']')[0];
  return v.split(':')[0].replace(/\.+$/, '');
}

// Host name of BASE_URL ('' when not set).
export function baseHost() {
  if (!config.baseUrl) return '';
  try {
    return hostWithoutPort(new URL(config.baseUrl).host);
  } catch {
    return '';
  }
}

// Against DNS rebinding: IPs, local names, certificate names, HOSTS and the
// BASE_URL host only. Setup mode accepts any host (the wizard is unprotected
// by design; login, admin API and WebSocket are closed until setup is done).
export function knownHost(value, certNames = []) {
  if (setupMode()) return true;
  const host = hostWithoutPort(value);
  if (!host.includes('.')) return true; // no host, localhost, plain names, IPv6 literals
  if (net.isIP(host)) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host === baseHost()) return true;
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

// ---------------------------------------------------------------- PINs

// PINs are kept as scrypt hashes only: settings.json stores them, ENV PINs are
// hashed at start with a salt derived from the secret (stable across restarts).
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const MAX_PIN_INPUT = 256; // longer input is cut, for ENV PINs too
const MAX_SCRYPT = 4; // concurrent hashes, protects the libuv threadpool
let scryptActive = 0;
const scryptQueue = [];

async function scrypt(pin, salt, N, r, p) {
  while (scryptActive >= MAX_SCRYPT) await new Promise((resolve) => scryptQueue.push(resolve));
  scryptActive++;
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(pin, salt, SCRYPT.len, { N, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key)));
    });
  } finally {
    scryptActive--;
    scryptQueue.shift()?.();
  }
}

function formatHash(salt, key) {
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parseHash(s) {
  const m = String(s || '').match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(m[4], 'base64url'), key: Buffer.from(m[5], 'base64url') };
}

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return formatHash(salt, await scrypt(String(pin).slice(0, MAX_PIN_INPUT), salt, SCRYPT.N, SCRYPT.r, SCRYPT.p));
}

const envHashes = {};
for (const [role, key] of Object.entries(PIN_KEYS)) {
  const plain = envPin(key);
  if (!plain) continue;
  const salt = crypto.createHmac('sha256', secret).update(`env-pin:${role}`).digest().subarray(0, 16);
  envHashes[role] = formatHash(salt, crypto.scryptSync(plain.slice(0, MAX_PIN_INPUT), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }));
}

// Effective PIN hash of a role or null.
export function pinHash(role) {
  const key = PIN_KEYS[role];
  if (!key) return null;
  const s = storedValue(key);
  return (typeof s === 'string' && s) ? s : envHashes[role] || null;
}

export function pinSource(role) {
  const s = storedValue(PIN_KEYS[role]);
  if (typeof s === 'string' && s) return 'settings';
  return envHashes[role] ? 'env' : 'default';
}

// Setup is needed while parents or children cannot log in.
export function setupMode() {
  return !pinHash('parent') || !pinHash('child');
}

export async function verifyHash(hash, pin) {
  const p = parseHash(hash);
  if (!p) return false;
  const got = await scrypt(String(pin ?? '').slice(0, MAX_PIN_INPUT), p.salt, p.N, p.r, p.p);
  return got.length === p.key.length && crypto.timingSafeEqual(got, p.key);
}

export async function checkPin(role, pin) {
  const hash = pinHash(role);
  if (!hash) return false;
  return verifyHash(hash, pin);
}

// ---------------------------------------------------------------- cookies

function mac(role, issued) {
  const key = crypto.createHash('sha256').update(secret).update(pinHash(role) || '').digest();
  return crypto.createHmac('sha256', key).update(`${role}.${issued}`).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
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

export function adminCookie(value) {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_MAX_AGE}`;
}

export function clearAdminCookie() {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
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

function verifySession(value, roles, maxAge) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [role, issuedRaw, sig] = parts;
  if (!roles.includes(role) || !pinHash(role)) return null;
  const issued = Number(issuedRaw);
  if (!Number.isInteger(issued)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (issued > now + 60 || now - issued > maxAge) return null;
  return safeEqual(sig, mac(role, issuedRaw)) ? role : null;
}

// Returns 'parent' | 'child' | null.
export function roleFromRequest(req) {
  return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME], ['parent', 'child'], COOKIE_MAX_AGE);
}

export function isAdmin(req) {
  return verifySession(parseCookies(req.headers.cookie)[ADMIN_COOKIE], ['admin'], ADMIN_MAX_AGE) === 'admin';
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

const inflight = new Map(); // ip -> PIN checks running
const MAX_INFLIGHT = 2;

// Reserve a PIN attempt before the (async) check: it counts as a failure until
// endAttempt(attempt, true). Returns null when limited.
export function beginAttempt(ip) {
  if (rateLimited(ip) || (inflight.get(ip) || 0) >= MAX_INFLIGHT) return null;
  const list = recent(ip);
  const ts = Date.now();
  list.push(ts);
  failures.set(ip, list);
  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  return { ip, ts };
}

export function endAttempt(attempt, success) {
  const n = (inflight.get(attempt.ip) || 1) - 1;
  if (n > 0) inflight.set(attempt.ip, n);
  else inflight.delete(attempt.ip);
  if (!success) return;
  const list = failures.get(attempt.ip) || [];
  const i = list.indexOf(attempt.ts);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) failures.delete(attempt.ip);
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
