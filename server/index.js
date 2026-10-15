// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config, log } from './config.js';
import { CertManager } from './certs.js';
import { Media } from './media.js';
import { Hub } from './hub.js';
import { webhookStartup } from './webhooks.js';
import {
  SECURITY_HEADERS, checkPin, clearCookie, hostWithoutPort, ipAllowed, knownHost, makeSession,
  normalizeIp, rateLimited, recordFailure, roleFromRequest, sessionCookie,
} from './security.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 4096;
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

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
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

async function login(req, res, ip) {
  if (rateLimited(ip)) {
    log(`login: rate limited ${ip}`);
    return sendJson(res, 429, { error: 'too many attempts' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const role = body?.role;
  if (role !== 'parent' && role !== 'child') return sendJson(res, 400, { error: 'invalid role' });
  if (!checkPin(role, body.pin)) {
    recordFailure(ip);
    log(`login: wrong PIN for ${role} from ${ip}`);
    return sendJson(res, 401, { error: 'wrong pin' });
  }
  log(`login: ${role} from ${ip}`);
  return sendJson(res, 200, { role }, { 'Set-Cookie': sessionCookie(makeSession(role)) });
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
  if (pathname === '/api/config') {
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    return sendJson(res, 200, {
      role: roleFromRequest(req),
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

async function onRequest(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const ip = guard(req, res);
  if (!ip) return;
  let pathname;
  try {
    pathname = new URL(req.url, 'https://x').pathname;
  } catch {
    return send(res, 400, 'Bad Request');
  }
  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) return await api(req, res, pathname, ip);
    return await serveStatic(req, res, pathname);
  } catch (e) {
    log(`http: ${req.method} ${pathname} failed: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
    else res.destroy();
  }
}

function onRedirect(req, res) {
  const ip = guard(req, res);
  if (!ip) return;
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

function onUpgrade(wss, req, socket, head) {
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
  const role = roleFromRequest(req);
  if (!role) return rejectUpgrade(socket, 401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, role, ip));
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => onUpgrade(wss, req, socket, head));
  server.on('tlsClientError', () => {});
  certs.attach(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpsPort, () => resolve());
  });
  log(`https: listening on ${config.httpsPort}`);

  let redirect = null;
  if (config.httpPort > 0) {
    redirect = http.createServer(onRedirect);
    redirect.on('error', (e) => log(`http: redirect server error: ${e.code || e.message}`));
    redirect.listen(config.httpPort, () => log(`http: redirect on ${config.httpPort}`));
  }

  webhookStartup();

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    hub.close();
    wss.close();
    certs.stop();
    redirect?.close();
    server.close(() => {
      media.close();
      log('stopped');
      process.exit(0);
    });
    server.closeAllConnections();
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
