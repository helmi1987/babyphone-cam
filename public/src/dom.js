// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Small DOM and storage helpers shared by all views.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.)
  }
}

export function randomId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Persistent per-browser id; falls back to a session-only id without storage.
let volatileIds = {};
export function deviceId(key) {
  let id = load(key, null);
  if (typeof id !== 'string' || !id) {
    id = volatileIds[key] || randomId();
    volatileIds[key] = id;
    save(key, id);
  }
  return id;
}

export function mediaAvailable() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

export function errMsg(e) {
  return (e && (e.message || e.name)) || String(e);
}
