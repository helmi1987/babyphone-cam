// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm
//
// TLS certificate selection. Logic follows dropnook (AGPL-3.0):
// CertWarden -> TLS_CERT/TLS_KEY -> CERTS_DIR scan -> self-signed.

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import selfsigned from 'selfsigned';
import { config, log } from './config.js';

const DAY = 86400 * 1000;
const POLL_FILES_MS = 5 * 60 * 1000;
const CW_CHECK_MS = 6 * 3600 * 1000;
const CW_DIR = path.join(config.dataDir, '.certwarden');
const SELF_DIR = path.join(config.dataDir, '.selfsigned');

export function pemBlocks(text, kind) {
  const re = new RegExp(`-----BEGIN [A-Z ]*${kind}-----[A-Za-z0-9+/=\\s]+?-----END [A-Z ]*${kind}-----`, 'g');
  return text.match(re) || [];
}

// Facts of the leaf certificate: {expires(ms), names[]} or null.
export function certFacts(certPem) {
  try {
    const x = new X509Certificate(certPem);
    const names = [];
    for (const part of (x.subjectAltName || '').split(',')) {
      const m = part.trim().match(/^DNS:(.+)$/i);
      if (m) names.push(m[1].trim().toLowerCase());
    }
    const cn = (x.subject || '').match(/(?:^|\n)CN=([^\n]+)/);
    if (cn && !names.includes(cn[1].trim().toLowerCase())) names.push(cn[1].trim().toLowerCase());
    return { expires: Date.parse(x.validTo), names, x };
  } catch {
    return null;
  }
}

// Validate a PEM pair: key matches leaf, not expired. Returns facts or throws.
export function checkPair(certPem, keyPem, label) {
  const blocks = pemBlocks(certPem, 'CERTIFICATE');
  if (!blocks.length) throw new Error(`${label}: no certificate`);
  const facts = certFacts(blocks[0]);
  if (!facts) throw new Error(`${label}: unreadable certificate`);
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error(`${label}: unreadable private key`);
  }
  if (!facts.x.checkPrivateKey(key)) throw new Error(`${label}: key and certificate do not belong together`);
  if (!(facts.expires > Date.now())) throw new Error(`${label}: certificate has expired`);
  return { expires: facts.expires, names: facts.names };
}

function readPair(certPath, keyPath, label) {
  const cert = fs.readFileSync(certPath, 'utf8');
  const key = fs.readFileSync(keyPath, 'utf8');
  const facts = checkPair(cert, key, label);
  return { cert, key, ...facts, source: label, files: [certPath, keyPath] };
}

function pairIn(folder) {
  const c = path.join(folder, 'fullchain.pem');
  const k = path.join(folder, 'privkey.pem');
  try {
    if (fs.statSync(c).isFile() && fs.statSync(k).isFile()) return [c, k];
  } catch { /* missing */ }
  return null;
}

// ---------------------------------------------------------------- CertWarden

export function certwardenApi(url = config.certwardenUrl) {
  let base = url.replace(/\/+$/, '');
  const at = base.search(/\/certwarden(\/|$)/);
  if (at >= 0) base = base.slice(0, at);
  return `${base.replace(/\/+$/, '')}/certwarden/api/v1/download`;
}

function certwardenEnabled() {
  return Boolean(config.certwardenUrl) && (config.tlsSource === 'auto' || config.tlsSource === 'certwarden');
}

function certwardenMissing() {
  const names = ['CERTWARDEN_ENDPOINT_URL', 'CERT_NAME', 'CERT_CERT_API', 'CERT_KEY_API'];
  const vals = [config.certwardenUrl, config.certName, config.certCertApi, config.certKeyApi];
  return names.filter((_, i) => !vals[i]);
}

// opts: {certwardenUrl, certName, certCertApi, certKeyApi}; defaults to the running config.
export async function certwardenFetch(opts = config) {
  const name = opts.certName;
  if (!/^[A-Za-z0-9._~-]+$/.test(name)) throw new Error(`"${name}" is not a Cert Warden name`);
  let res;
  try {
    res = await fetch(`${certwardenApi(opts.certwardenUrl)}/privatecertchains/${name}`, {
      headers: { 'X-API-Key': `${opts.certCertApi}.${opts.certKeyApi}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Cert Warden not reachable: ${e.cause?.code || e.name || 'error'}`);
  }
  if (!res.ok) throw new Error(`Cert Warden answered ${res.status} for ${name} (name or API keys?)`);
  const text = (await res.text()).slice(0, 1024 * 1024);
  const keys = pemBlocks(text, 'PRIVATE KEY');
  const certs = pemBlocks(text, 'CERTIFICATE');
  if (keys.length !== 1 || !certs.length) throw new Error(`no certificate with its key in Cert Warden's answer for ${name}`);
  const chain = `${certs.join('\n')}\n`;
  const key = `${keys[0]}\n`;
  checkPair(chain, key, name);
  return { chain, key };
}

function writeSecret(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.new`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function storePair(folder, chain, key) {
  const pair = pairIn(folder);
  if (pair && fs.readFileSync(pair[0], 'utf8') === chain && fs.readFileSync(pair[1], 'utf8') === key) return false;
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // key first, certificate last
  writeSecret(path.join(folder, 'privkey.pem'), key);
  writeSecret(path.join(folder, 'fullchain.pem'), chain);
  return true;
}

function certwardenDue() {
  const pair = pairIn(CW_DIR);
  if (!pair) return true;
  const facts = certFacts(fs.readFileSync(pair[0], 'utf8'));
  return !facts || facts.expires - Date.now() < config.certCheckDays * DAY;
}

// Fetch when due. Returns true if the stored pair changed.
async function certwardenSync() {
  const missing = certwardenMissing();
  if (missing.length) {
    log(`Cert Warden: missing ${missing.join(', ')}`);
    return false;
  }
  try {
    if (!certwardenDue()) return false;
    const { chain, key } = await certwardenFetch();
    const changed = storePair(CW_DIR, chain, key);
    const facts = certFacts(chain);
    log(`Cert Warden: ${config.certName} ${changed ? 'fetched' : 'unchanged'}, valid until ${new Date(facts.expires).toISOString().slice(0, 10)}`);
    return changed;
  } catch (e) {
    log(`Cert Warden: ${e.message} - keeping what is there`);
    return false;
  }
}

// ---------------------------------------------------------------- CERTS_DIR

// Subfolders of dir; {dirs, error} where error is an fs error code or ''.
function listDirs(dir) {
  try {
    const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    return { dirs, error: '' };
  } catch (e) {
    return { dirs: [], error: e.code || 'error' };
  }
}

const denied = (code) => code === 'EACCES' || code === 'EPERM';

// Why a folder's pair cannot be used, from an fs error or a checkPair error.
function skipReason(e, label) {
  if (e.code) {
    const file = path.basename(e.path || '') || '?';
    return denied(e.code) ? `${file} permission denied (${e.code})` : `${file} not readable (${e.code})`;
  }
  const msg = String(e.message || e);
  return msg.startsWith(`${label}: `) ? msg.slice(label.length + 2) : msg;
}

// fullchain.pem + privkey.pem of a folder: {pair} or {reason}.
function pairOrReason(folder) {
  const missing = [];
  for (const name of ['fullchain.pem', 'privkey.pem']) {
    try {
      if (!fs.statSync(path.join(folder, name)).isFile()) missing.push(name);
    } catch (e) {
      if (denied(e.code)) return { reason: `${name} permission denied (${e.code})` };
      missing.push(name);
    }
  }
  if (missing.length) return { reason: `no ${missing.join('/')}` };
  return { pair: [path.join(folder, 'fullchain.pem'), path.join(folder, 'privkey.pem')] };
}

// Scan report of the last run; logged again only when it changes (re-scans run every 5 min).
let lastScanReport = null;

function scanCertsDir() {
  const live = path.join(config.certsDir, 'live');
  const top = listDirs(config.certsDir);
  const folders = [...listDirs(live).dirs, ...top.dirs.filter((d) => d !== live)];
  const found = [];
  const lines = [];
  const seen = new Set();
  for (const folder of folders) {
    const r = pairOrReason(folder);
    if (r.reason) {
      lines.push(`TLS: skipping ${folder}: ${r.reason}`);
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(r.pair[0]);
    } catch (e) {
      lines.push(`TLS: skipping ${folder}: ${skipReason(e, r.pair[0])}`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      found.push(readPair(r.pair[0], r.pair[1], r.pair[0]));
    } catch (e) {
      lines.push(`TLS: skipping ${folder}: ${skipReason(e, r.pair[0])}`);
    }
  }
  if (!found.length) {
    let dirState;
    if (top.error === 'ENOENT') dirState = 'does not exist';
    else if (top.error) dirState = `is not readable (${top.error})`;
    else dirState = `exists, ${folders.length} folder${folders.length === 1 ? '' : 's'} checked (live/* and */)`;
    lines.push(`TLS: no usable certificate in CERTS_DIR ${config.certsDir}: ${dirState}`);
    lines.push('TLS: WARNING no valid certificate found, using self-signed');
  }
  const report = lines.join('\n');
  if (report !== lastScanReport) {
    lastScanReport = report;
    for (const line of lines) log(line);
  }
  found.sort((a, b) => b.expires - a.expires); // longest valid first = default
  return found;
}

// ---------------------------------------------------------------- self-signed

let selfCache = null;

async function selfSigned() {
  if (selfCache && selfCache.expires - Date.now() > 30 * DAY) return selfCache;
  const pair = pairIn(SELF_DIR);
  if (pair) {
    try {
      const p = readPair(pair[0], pair[1], 'self-signed');
      if (p.expires - Date.now() > 30 * DAY) return (selfCache = p);
    } catch { /* regenerate */ }
  }
  const now = new Date();
  const gen = await selfsigned.generate([{ name: 'commonName', value: 'babyphone-cam' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - DAY),
    notAfterDate: new Date(now.getTime() + 825 * DAY),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'babyphone-cam' },
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...(/^\d+\.\d+\.\d+\.\d+$/.test(config.announcedIp) ? [{ type: 7, ip: config.announcedIp }] : []),
        ],
      },
    ],
  });
  try {
    storePair(SELF_DIR, gen.cert, gen.private);
  } catch (e) {
    log(`TLS: cannot store self-signed certificate (${e.code || 'error'})`);
  }
  const facts = checkPair(gen.cert, gen.private, 'self-signed');
  selfCache = { cert: gen.cert, key: gen.private, ...facts, source: 'self-signed', files: [] };
  return selfCache;
}

// ---------------------------------------------------------------- selection

async function choose() {
  if (config.tlsSource === 'selfsigned') return [await selfSigned()];
  if (certwardenEnabled()) {
    const pair = pairIn(CW_DIR);
    if (pair) {
      try {
        return [readPair(pair[0], pair[1], 'Cert Warden')];
      } catch (e) {
        log(`TLS: ${e.message}`);
      }
    }
  }
  if (config.tlsCert || config.tlsKey) {
    try {
      return [readPair(config.tlsCert, config.tlsKey, 'TLS_CERT')];
    } catch (e) {
      log(`TLS: TLS_CERT/TLS_KEY not usable: ${e.code || e.message}`);
    }
  }
  const scanned = scanCertsDir();
  if (scanned.length) return scanned;
  return [await selfSigned()];
}

function fingerprint(list) {
  return list.map((c) => `${c.source}|${c.expires}|${c.cert.length}|${c.cert.slice(-64)}`).join(';');
}

function matchName(host, name) {
  if (name.startsWith('*.')) {
    const suffix = name.slice(1);
    return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.');
  }
  return host === name;
}

export class CertManager {
  constructor() {
    this.list = [];
    this.contexts = [];
    this.server = null;
    this.print = '';
  }

  async init() {
    if (certwardenEnabled()) await certwardenSync();
    this.apply(await choose());
  }

  apply(list) {
    this.list = list;
    this.contexts = list.map((c) => ({ names: c.names, ctx: tls.createSecureContext({ cert: c.cert, key: c.key }) }));
    this.print = fingerprint(list);
    for (const c of list) {
      log(`TLS: using ${c.source} (${c.names.join(', ') || 'no names'}), valid until ${new Date(c.expires).toISOString().slice(0, 10)}`);
    }
  }

  // Options for https.createServer.
  serverOptions() {
    const d = this.list[0];
    return {
      cert: d.cert,
      key: d.key,
      SNICallback: (servername, cb) => cb(null, this.contextFor(servername)),
    };
  }

  contextFor(servername) {
    const host = String(servername || '').toLowerCase();
    if (host && this.contexts.length > 1) {
      for (const c of this.contexts) if (c.names.some((n) => matchName(host, n))) return c.ctx;
    }
    return this.contexts[0].ctx;
  }

  // All names of served certificates (for the host check).
  names() {
    return this.list.flatMap((c) => c.names);
  }

  attach(server) {
    this.server = server;
    this.filesTimer = setInterval(() => this.reload().catch((e) => log(`TLS: reload failed: ${e.message}`)), POLL_FILES_MS);
    this.filesTimer.unref();
    if (certwardenEnabled()) {
      this.cwTimer = setInterval(async () => {
        if (await certwardenSync()) await this.reload();
      }, CW_CHECK_MS);
      this.cwTimer.unref();
    }
  }

  async reload() {
    const list = await choose();
    if (fingerprint(list) === this.print) return;
    this.apply(list);
    if (this.server) {
      const d = list[0];
      this.server.setSecureContext({ cert: d.cert, key: d.key });
      log('TLS: certificate reloaded');
    }
  }

  stop() {
    clearInterval(this.filesTimer);
    clearInterval(this.cwTimer);
  }
}
