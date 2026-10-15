// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// HTTP API and WebSocket client (request ids, heartbeat, reconnect backoff).

const HB_INTERVAL = 5000;
const HB_STALE = 15000;
const REQUEST_TIMEOUT = 10000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10000;

export async function getConfig() {
  const r = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(`config ${r.status}`);
  return r.json();
}

export async function login(role, pin) {
  const r = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, pin }),
  });
  return { ok: r.ok, status: r.status };
}

export async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // ignore, cookie stays until next attempt
  }
}

export class Hub {
  constructor() {
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.stopped = true;
    this.attempt = 0;
    this.lastHbOk = 0;
    this.openedAt = 0;
    this.stale = false;
    this.timers = [];
    this.reconnectTimer = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on(t, fn) {
    if (!this.handlers.has(t)) this.handlers.set(t, new Set());
    this.handlers.get(t).add(fn);
    return () => this.handlers.get(t)?.delete(fn);
  }

  emit(t, msg) {
    for (const fn of this.handlers.get(t) || []) {
      try {
        fn(msg);
      } catch (e) {
        console.error(`handler ${t}`, e);
      }
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastHbOk = Date.now();
    this.timers.push(setInterval(() => this.beat(), HB_INTERVAL));
    this.timers.push(setInterval(() => this.watch(), 1000));
    this.open();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
    }
    this.rejectAll('stopped');
  }

  open() {
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (e) {
      console.warn('ws create failed', e);
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.openedAt = Date.now();
      this.emit('open');
      this.beat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'request failed'));
      } else if (msg.t) {
        this.emit(msg.t, msg);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.lost();
    };
  }

  // Treat the current socket as dead and reconnect.
  drop() {
    if (this.ws) this.lost();
  }

  lost() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.rejectAll('connection closed');
    this.emit('close');
    if (!this.stopped) this.schedule();
  }

  schedule() {
    const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.attempt);
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  rejectAll(reason) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  request(t, data = {}, timeout = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('not connected'));
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${t}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...data, id, t }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  beat() {
    if (!this.connected) return;
    this.request('hb', {}, HB_INTERVAL * 2)
      .then(() => {
        this.lastHbOk = Date.now();
        if (this.stale) {
          this.stale = false;
          this.emit('fresh');
        }
      })
      .catch(() => {});
  }

  watch() {
    const gap = Date.now() - this.lastHbOk;
    if (gap > HB_STALE) {
      if (!this.stale) {
        this.stale = true;
        this.emit('stale');
      }
      // Half-open socket: force a reconnect (grace period after each open).
      if (this.connected && Date.now() - Math.max(this.lastHbOk, this.openedAt) > HB_STALE) this.drop();
    }
  }
}
