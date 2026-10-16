// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config, effective, log, restartPending, saveSettings } from './config.js';
import { buildChanges, settingsState, testCertwarden, testWebhookInput } from './admin.js';
import { CertManager } from './certs.js';
import { Media } from './media.js';
import { Hub } from './hub.js';
import { webhookStartup } from './webhooks.js';
import {
  SECURITY_HEADERS, adminCookie, beginAttempt, endAttempt, checkPin, clearAdminCookie, clearCookie, hostWithoutPort, ipAllowed, isAdmin,
  knownHost, makeSession, normalizeIp, pinHash, roleFromRequest, sessionCookie, setupMode,
} from './security.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 4096;
const MAX_SETTINGS_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const certs = new CertManager();
const media = new Media();
let hub;
let wss;
let shutdown = () => process.exit(0);
const wsRoles = new WeakMap(); // ws -> role

process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.message || e}`));

function clientIp(req) {
  return normalizeIp(req.socket.remoteAddress);
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.writeHead(status, { 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

// Plain HTTP request (HTTP_PORT, or plaintext that arrived on the HTTPS port)
const isPlain = (req) => !req.socket.encrypted;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === (isPlain(req) ? 'http:' : 'https:')
      && u.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- API

async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch {
    return undefined;
  }
}

// Rate-limited PIN check; answers 429/401 itself and returns false then.
async function pinOk(res, ip, role, pin, what) {
  const attempt = beginAttempt(ip);
  if (!attempt) {
    log(`login: rate limited ${ip}`);
    sendJson(res, 429, { error: 'too many attempts' });
    return false;
  }
  let ok = false;
  try {
    ok = await checkPin(role, pin);
  } finally {
    endAttempt(attempt, ok);
  }
  if (!ok) {
    log(`login: wrong PIN for ${what} from ${ip}`);
    sendJson(res, 401, { error: 'wrong pin' });
  }
  return ok;
}

async function login(req, res, ip) {
  if (setupMode()) return sendJson(res, 503, { error: 'setup' });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const role = body?.role;
  if (role !== 'parent' && role !== 'child' && role !== 'admin') return sendJson(res, 400, { error: 'invalid role' });
  if (!(await pinOk(res, ip, role, body.pin, `${role} login`))) return undefined;
  log(`login: ${role} from ${ip}`);
  const cookie = role === 'admin' ? adminCookie(makeSession(role)) : sessionCookie(makeSession(role));
  return sendJson(res, 200, { role }, { 'Set-Cookie': cookie });
}

// Close the sockets of roles whose PIN changed (their cookies no longer verify).
function kickRoles(roles) {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (roles.includes(wsRoles.get(ws))) ws.close(4001, 'pin changed');
  }
}

async function saveInput(req, res, ip, setup) {
  const body = await readJson(req, MAX_SETTINGS_BODY);
  if (body === undefined) return sendJson(res, 400, { error: 'bad request' });
  const r = await buildChanges(body?.values, { setup, ip });
  if (r.errors) return sendJson(res, 400, { error: 'invalid', errors: r.errors });
  if (setup && !setupMode()) return sendJson(res, 409, { error: 'not in setup' });
  try {
    saveSettings(r.changes);
  } catch (e) {
    log(`settings: cannot write (${e.code || e.message})`);
    return sendJson(res, 500, { error: 'write failed' });
  }
  kickRoles(r.pinRoles.filter((role) => role !== 'admin'));
  const headers = {};
  const plain = isPlain(req);
  // Setup ends signed in as admin; an admin changing the admin PIN stays signed in.
  // Over plain HTTP no session cookie is issued (it would travel unencrypted).
  if (!plain && (setup || r.pinRoles.includes('admin'))) headers['Set-Cookie'] = adminCookie(makeSession('admin'));
  log(`settings: ${setup ? 'setup finished' : 'changed by admin'} from ${ip}${plain ? ' (plain http)' : ''}`);
  const pending = restartPending();
  const out = { ok: true, changed: Object.keys(r.changes), restartPending: pending };
  if (plain) {
    // The browser continues on HTTPS; restart first if TLS settings changed.
    out.httpsPort = effective('HTTPS_PORT');
    out.restarting = pending.length > 0;
    if (out.restarting) {
      log('setup: restarting to apply TLS settings');
      res.on('finish', () => setTimeout(() => shutdown('restart'), 200));
    }
  }
  return sendJson(res, 200, out, headers);
}

async function runTest(req, res, fn) {
  const body = await readJson(req, MAX_SETTINGS_BODY);
  if (body === undefined) return sendJson(res, 400, { error: 'bad request' });
  return sendJson(res, 200, await fn(body));
}

const postOnly = (res) => sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });

async function setupApi(req, res, pathname, ip) {
  if (!setupMode()) return sendJson(res, 409, { error: 'not in setup' });
  if (pathname === '/api/setup/state') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    return sendJson(res, 200, settingsState());
  }
  if (req.method !== 'POST') return postOnly(res);
  if (pathname === '/api/setup') return saveInput(req, res, ip, true);
  if (pathname === '/api/setup/test-certwarden') return runTest(req, res, testCertwarden);
  if (pathname === '/api/setup/test-webhook') return runTest(req, res, testWebhookInput);
  return sendJson(res, 404, { error: 'not found' });
}

// No admin PIN yet (ENV setups): the parent PIN authorises setting one.
async function claimAdmin(req, res, ip) {
  if (pinHash('admin')) return sendJson(res, 409, { error: 'admin pin exists' });
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad request' });
  if (!(await pinOk(res, ip, 'parent', body.parentPin, 'admin claim (parent PIN)'))) return undefined;
  if (typeof body.adminPin !== 'string' || !body.adminPin) {
    return sendJson(res, 400, { error: 'invalid', errors: { ADMIN_PIN: { code: 'pin' } } });
  }
  const r = await buildChanges({ ADMIN_PIN: body.adminPin }, { setup: false, ip });
  if (r.errors) return sendJson(res, 400, { error: 'invalid', errors: r.errors });
  if (pinHash('admin')) return sendJson(res, 409, { error: 'admin pin exists' });
  try {
    saveSettings(r.changes);
  } catch (e) {
    log(`settings: cannot write (${e.code || e.message})`);
    return sendJson(res, 500, { error: 'write failed' });
  }
  log(`login: admin PIN set from ${ip}`);
  return sendJson(res, 200, { role: 'admin' }, { 'Set-Cookie': adminCookie(makeSession('admin')) });
}

async function adminApi(req, res, pathname, ip) {
  if (pathname === '/api/admin/logout') {
    if (req.method !== 'POST') return postOnly(res);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearAdminCookie() });
  }
  if (setupMode()) return sendJson(res, 503, { error: 'setup' });
  if (pathname === '/api/admin/claim') {
    if (req.method !== 'POST') return postOnly(res);
    return claimAdmin(req, res, ip);
  }
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  if (pathname === '/api/admin/settings') {
    if (req.method === 'GET') return sendJson(res, 200, settingsState());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
    return saveInput(req, res, ip, false);
  }
  if (req.method !== 'POST') return postOnly(res);
  if (pathname === '/api/admin/test-certwarden') return runTest(req, res, testCertwarden);
  if (pathname === '/api/admin/test-webhook') return runTest(req, res, testWebhookInput);
  if (pathname === '/api/admin/restart') {
    log(`restart requested by admin from ${ip}`);
    res.on('finish', () => setTimeout(() => shutdown('restart'), 200));
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function api(req, res, pathname, ip) {
  const method = req.method;
  if (method === 'POST' && !sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (pathname === '/api/login') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    return login(req, res, ip);
  }
  if (pathname === '/api/logout') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }
  if (pathname === '/api/setup' || pathname.startsWith('/api/setup/')) return setupApi(req, res, pathname, ip);
  if (pathname.startsWith('/api/admin/')) return adminApi(req, res, pathname, ip);
  if (pathname === '/api/config') {
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    if (setupMode()) return sendJson(res, 200, { setup: true, role: null, admin: false });
    return sendJson(res, 200, {
      role: roleFromRequest(req),
      admin: isAdmin(req),
      adminPin: Boolean(pinHash('admin')),
      childNames: config.childNames,
      soundThreshold: config.soundThreshold,
      motionThreshold: config.motionThreshold,
      heartbeatTimeout: config.heartbeatTimeout,
    });
  }
  return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- static

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (rel === '/') rel = '/index.html';
  // Setup mode: every page request shows the wizard
  else if (setupMode() && !path.extname(rel)) rel = '/index.html';
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, 'Bad Request');
  const parts = rel.split('/').filter(Boolean);
  // no dotfiles, no browser sources, no traversal
  if (!parts.length || parts.some((p) => p.startsWith('.')) || parts[0] === 'src') return send(res, 404, 'Not Found');
  const file = path.resolve(PUBLIC_DIR, ...parts);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not Found');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, 'Not Found');
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return send(res, 404, 'Not Found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not Found');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- handlers

// Icons are harmless and make even the error page recognisable
const PUBLIC_FILES = new Set(['/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico']);
const deniedLogged = new Map(); // ip -> last log time

function forbiddenPage(ip) {
  const safeIp = String(ip).replace(/[^0-9a-fA-F:.]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Babyphone</title><link rel="icon" href="/icon.svg" type="image/svg+xml"></head>`
    + `<body bgcolor="#0f1115" text="#e8eaf0"><center><br><img src="/icon.svg" width="120" height="120" alt="">`
    + `<h2>Forbidden</h2><p>${safeIp} is not in ALLOWED_CIDRS.</p></center></body></html>`;
}

function guard(req, res) {
  const ip = clientIp(req);
  if (!ipAllowed(ip)) {
    const now = Date.now();
    if (now - (deniedLogged.get(ip) || 0) > 600000) {
      deniedLogged.set(ip, now);
      if (deniedLogged.size > 1000) deniedLogged.clear();
      log(`access: ${ip} denied, not in ALLOWED_CIDRS`);
    }
    let pathname = '';
    try { pathname = new URL(req.url, 'https://x').pathname; } catch { /* ignore */ }
    if (PUBLIC_FILES.has(pathname) && knownHost(req.headers.host, certs.names())) return ip;
    send(res, 403, forbiddenPage(ip), { 'Content-Type': 'text/html; charset=utf-8' });
    return null;
  }
  if (!knownHost(req.headers.host, certs.names())) {
    send(res, 421, 'Misdirected Request');
    return null;
  }
  return ip;
}

// API endpoints the first-start wizard needs; only these work over plain HTTP.
const setupApiPath = (p) => p === '/api/config' || p === '/api/setup' || p.startsWith('/api/setup/');

async function onRequest(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const ip = guard(req, res);
  if (!ip) return;
  // Plain HTTP: only the wizard while in setup mode, otherwise redirect to HTTPS
  if (isPlain(req) && !setupMode()) return redirectToHttps(req, res);
  let pathname;
  try {
    pathname = new URL(req.url, 'https://x').pathname;
  } catch {
    return send(res, 400, 'Bad Request');
  }
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  if (isPlain(req) && isApi && !setupApiPath(pathname)) return sendJson(res, 403, { error: 'https required' });
  try {
    if (isApi) return await api(req, res, pathname, ip);
    return await serveStatic(req, res, pathname);
  } catch (e) {
    log(`http: ${req.method} ${pathname} failed: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
    else res.destroy();
  }
}

function redirectToHttps(req, res) {
  let host = hostWithoutPort(req.headers.host);
  if (!host) return send(res, 400, 'Bad Request');
  if (host.includes(':')) host = `[${host}]`;
  const port = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
  const target = String(req.url || '/').startsWith('/') ? req.url : '/';
  send(res, 301, '', { Location: `https://${host}${port}${target}` });
}

function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// No WebSocket over plain HTTP
function onPlainUpgrade(req, socket) {
  socket.on('error', () => {});
  rejectUpgrade(socket, 403, 'Forbidden');
}

function onUpgrade(req, socket, head) {
  socket.on('error', () => {});
  const ip = clientIp(req);
  let pathname = '';
  try {
    pathname = new URL(req.url, 'https://x').pathname;
  } catch { /* invalid */ }
  if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
  if (!ipAllowed(ip)) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!knownHost(req.headers.host, certs.names())) return rejectUpgrade(socket, 421, 'Misdirected Request');
  if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  if (setupMode()) return rejectUpgrade(socket, 503, 'Service Unavailable');
  const role = roleFromRequest(req);
  if (!role) return rejectUpgrade(socket, 401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsRoles.set(ws, role);
    hub.attach(ws, role, ip);
  });
}

// ---------------------------------------------------------------- main

async function main() {
  log('babyphone-cam starting');
  await certs.init();
  await media.start();
  hub = new Hub(media);

  const server = https.createServer(certs.serverOptions(), onRequest);
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', onUpgrade);
  server.on('tlsClientError', () => {});
  certs.attach(server);

  // Plain HTTP handler: wizard in setup mode, otherwise redirect to HTTPS.
  // Serves HTTP_PORT and plaintext requests that arrive on the HTTPS port.
  const plain = http.createServer(onRequest);
  plain.headersTimeout = 15000;
  plain.requestTimeout = 30000;
  plain.on('upgrade', onPlainUpgrade);
  plain.on('clientError', (e, socket) => socket.destroy());

  // The HTTPS port is owned by a raw TCP listener that looks at the first byte:
  // 0x16 (TLS handshake record) goes to the HTTPS server, anything else to the
  // plain handler, so "http://host:443" gets a redirect instead of TLS bytes.
  // The inner servers never listen themselves; 'listening' is emitted once so
  // they start their connection tracking (headersTimeout/requestTimeout checks).
  server.emit('listening');
  plain.emit('listening');
  const pending = new Set();
  const front = net.createServer({ noDelay: true }, (socket) => {
    pending.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(10000, () => socket.destroy());
    socket.once('close', () => pending.delete(socket));
    socket.once('data', (buf) => {
      pending.delete(socket);
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? server : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  await new Promise((resolve, reject) => {
    front.once('error', reject);
    front.listen(config.httpsPort, () => resolve());
  });
  log(`https: listening on ${config.httpsPort}`);
  log(`access: allowed networks ${config.allowedCidrs.join(', ')}`);
  if (setupMode()) log('setup: PINs missing, first-start wizard active (open the page in a browser)');
  else if (!pinHash('admin')) log('setup: ADMIN_PIN not set, set it under Einstellungen with the parent PIN');

  let redirect = null;
  if (config.httpPort > 0) {
    redirect = net.createServer({ noDelay: true }, (socket) => plain.emit('connection', socket));
    redirect.on('error', (e) => log(`http: server error: ${e.code || e.message}`));
    redirect.listen(config.httpPort, () => log(`http: listening on ${config.httpPort} (setup wizard, otherwise redirect)`));
  }

  webhookStartup();

  let stopping = false;
  shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    hub.close();
    wss.close();
    certs.stop();
    redirect?.close();
    front.close(() => {
      media.close();
      log('stopped');
      process.exit(0);
    });
    for (const s of [server, plain]) {
      s.close(() => {}); // stops connection tracking; the port belongs to front
      s.closeAllConnections();
    }
    for (const socket of pending) socket.destroy();
    setTimeout(() => {
      media.close();
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log(`startup failed: ${e.message}`);
  process.exit(1);
});
