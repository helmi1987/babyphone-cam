// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm
//
// WebSocket hub: devices, presence, activity, alarms, mediasoup signalling.

import crypto from 'node:crypto';
import { config, log } from './config.js';
import { sendWebhook } from './webhooks.js';

const LEVEL_THROTTLE_MS = 500;
const TICK_MS = 1000;
const MAX_TRANSPORTS = 4;
const MAX_PRODUCERS = 4;
const MAX_CONSUMERS = 64;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class HubError extends Error {}

function fail(message) {
  throw new HubError(message);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export class Hub {
  constructor(media) {
    this.media = media;
    this.conns = new Set();
    this.children = new Map(); // deviceId -> child record
    this.parents = new Map(); // deviceId -> parent record
    this.producers = new Map(); // producerId -> {producer, conn}
    this.alarms = new Map(); // alarmId -> alarm
    this.lastDevicesAt = 0;
    this.devicesTimer = null;
    this.noParentSince = null;
    this.noParentSent = false;
    this.tick = setInterval(() => this.onTick(), TICK_MS);
  }

  // ---------------------------------------------------------------- connection

  attach(ws, role, ip) {
    const conn = {
      ws,
      role,
      ip,
      deviceId: null,
      joined: false,
      left: false,
      lastHb: Date.now(),
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    this.conns.add(conn);
    log(`ws: ${role} connected from ${ip}`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onMessage(conn, data.toString('utf8'));
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => {});
  }

  send(conn, msg) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }

  toParents(msg) {
    for (const p of this.parents.values()) if (p.conn) this.send(p.conn, msg);
  }

  async onMessage(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const { id } = msg;
    const after = [];
    try {
      const data = await this.handle(conn, msg, after);
      if (id !== undefined) this.send(conn, { id, ok: true, data: data ?? null });
    } catch (e) {
      if (!(e instanceof HubError)) log(`ws: ${msg.t} failed: ${e.message}`);
      if (id !== undefined) this.send(conn, { id, ok: false, error: e.message || 'error' });
    }
    for (const fn of after) fn();
  }

  async handle(conn, m, after) {
    if (m.t === 'hb') {
      conn.lastHb = Date.now();
      const rec = this.recordOf(conn);
      if (rec) rec.lastSeen = conn.lastHb;
      return { now: conn.lastHb };
    }
    if (m.t === 'join') return this.join(conn, m, after);
    if (!conn.joined) fail('not joined');
    switch (m.t) {
      case 'createTransport': return this.createTransport(conn, m);
      case 'connectTransport': return this.connectTransport(conn, m);
      case 'produce': return this.produce(conn, m);
      case 'closeProducer': return this.closeOwnProducer(conn, m);
      case 'consume': return this.consume(conn, m);
      case 'resumeConsumer': return this.resumeConsumer(conn, m);
      case 'setLayer': return this.setLayer(conn, m);
      case 'activity': return this.activity(conn, m);
      case 'ackAlarm': return this.ackAlarm(conn, m);
      case 'leave': return this.leave(conn);
      default: fail('unknown request');
    }
  }

  recordOf(conn) {
    if (!conn.joined) return null;
    const rec = (conn.role === 'child' ? this.children : this.parents).get(conn.deviceId);
    return rec && rec.conn === conn ? rec : null;
  }

  // ---------------------------------------------------------------- join / leave

  join(conn, m, after) {
    if (conn.joined) fail('already joined');
    const deviceId = String(m.deviceId ?? '');
    if (!DEVICE_ID_RE.test(deviceId)) fail('invalid deviceId');
    const now = Date.now();
    conn.lastHb = now;

    if (conn.role === 'child') {
      const name = cleanText(m.name, 40);
      if (!name) fail('name required');
      if (m.mode !== 'cam' && m.mode !== 'phone') fail('invalid mode');
      let rec = this.children.get(deviceId);
      if (rec?.conn) this.replaceConn(rec.conn);
      const wasOnline = rec?.online;
      if (!rec) {
        rec = { deviceId, offlineNotified: false };
        this.children.set(deviceId, rec);
      }
      this.clearChildTimers(rec);
      Object.assign(rec, {
        name, mode: m.mode, conn, online: true, lastSeen: now,
        since: wasOnline ? rec.since : now, sound: false, motion: false, level: 0,
      });
      conn.deviceId = deviceId;
      conn.joined = true;
      conn.left = false;
      log(`child ${JSON.stringify(name)} (${deviceId}) online, mode ${m.mode}`);
      this.clearAlarmsOf(deviceId);
      if (rec.offlineNotified) {
        rec.offlineNotified = false;
        sendWebhook('child_online', { name, title: `${name} online`, message: `Baby monitor ${name} is back online.` });
      }
      this.broadcastDevices();
    } else {
      const label = cleanText(m.label, 40);
      let rec = this.parents.get(deviceId);
      if (rec?.conn) this.replaceConn(rec.conn);
      if (!rec) {
        rec = { deviceId };
        this.parents.set(deviceId, rec);
      }
      clearTimeout(rec.offlineTimer);
      Object.assign(rec, { label, conn, online: true, lastSeen: now, offlineTimer: null });
      conn.deviceId = deviceId;
      conn.joined = true;
      conn.left = false;
      log(`parent ${label ? JSON.stringify(label) + ' ' : ''}(${deviceId}) online`);
      after.push(() => {
        this.send(conn, { t: 'devices', list: this.deviceList() });
        for (const a of this.alarms.values()) this.send(conn, { t: 'alarm', ...this.alarmPayload(a) });
      });
    }
    return { rtpCapabilities: this.media.rtpCapabilities };
  }

  // Same deviceId joined again from another socket: drop the old one silently.
  replaceConn(old) {
    old.left = true;
    this.cleanupMedia(old);
    old.joined = false;
    try {
      old.ws.close(4000, 'replaced');
    } catch { /* ignore */ }
  }

  leave(conn) {
    const rec = this.recordOf(conn);
    conn.left = true;
    this.cleanupMedia(conn);
    conn.joined = false;
    if (!rec) return null;
    if (conn.role === 'child') {
      this.clearChildTimers(rec);
      this.children.delete(rec.deviceId);
      this.clearAlarmsOf(rec.deviceId);
      log(`child ${JSON.stringify(rec.name)} (${rec.deviceId}) left`);
      this.broadcastDevices();
    } else {
      clearTimeout(rec.offlineTimer);
      this.parents.delete(rec.deviceId);
      log(`parent (${rec.deviceId}) left`);
    }
    return null;
  }

  onClose(conn) {
    this.conns.delete(conn);
    const rec = this.recordOf(conn);
    this.cleanupMedia(conn);
    conn.joined = false;
    if (!rec || conn.left) {
      log(`ws: ${conn.role} disconnected`);
      return;
    }
    rec.conn = null;
    rec.online = false;
    rec.since = Date.now();
    if (conn.role === 'child') this.childOffline(rec);
    else this.parentOffline(rec);
  }

  // ---------------------------------------------------------------- presence

  childOffline(rec) {
    Object.assign(rec, { sound: false, motion: false, level: 0 });
    log(`child ${JSON.stringify(rec.name)} (${rec.deviceId}) offline`);
    this.broadcastDevices();
    this.clearChildTimers(rec);
    rec.alarmTimer = setTimeout(() => this.raiseAlarm(rec), config.alarmDelay * 1000);
    rec.removeTimer = setTimeout(() => {
      this.clearChildTimers(rec);
      if (this.children.get(rec.deviceId) === rec && !rec.online) {
        this.children.delete(rec.deviceId);
        log(`child ${JSON.stringify(rec.name)} (${rec.deviceId}) removed after offline timeout`);
        this.broadcastDevices();
      }
    }, config.offlineTimeout * 1000);
  }

  clearChildTimers(rec) {
    clearTimeout(rec.alarmTimer);
    clearTimeout(rec.removeTimer);
    rec.alarmTimer = rec.removeTimer = null;
  }

  parentOffline(rec) {
    log(`parent (${rec.deviceId}) offline`);
    clearTimeout(rec.offlineTimer);
    rec.offlineTimer = setTimeout(() => {
      if (this.parents.get(rec.deviceId) !== rec || rec.online) return;
      this.parents.delete(rec.deviceId);
      const name = rec.label || rec.deviceId;
      log(`parent (${rec.deviceId}) still offline, webhook parent_offline`);
      sendWebhook('parent_offline', { name, title: 'Parent device offline', message: `Parent device ${name} lost its connection.` });
    }, config.alarmDelay * 1000);
  }

  onTick() {
    const now = Date.now();
    const limit = config.heartbeatTimeout * 1000;
    for (const conn of this.conns) {
      if (now - conn.lastHb > limit) {
        log(`ws: ${conn.role} ${conn.deviceId || ''} heartbeat timeout`);
        conn.ws.terminate();
      }
    }
    // no_parent: at least one child online, no parent online for ALARM_DELAY
    const childOnline = [...this.children.values()].some((c) => c.online);
    const parentOnline = [...this.parents.values()].some((p) => p.online);
    if (childOnline && !parentOnline) {
      if (this.noParentSince === null) this.noParentSince = now;
      if (!this.noParentSent && now - this.noParentSince >= config.alarmDelay * 1000) {
        this.noParentSent = true;
        log('no parent online, webhook no_parent');
        sendWebhook('no_parent', { title: 'No parent online', message: 'A baby monitor is running but no parent device is connected.' });
      }
    } else {
      this.noParentSince = null;
      this.noParentSent = false;
    }
  }

  // ---------------------------------------------------------------- alarms

  alarmPayload(a) {
    return { alarmId: a.alarmId, deviceId: a.deviceId, name: a.name, reason: a.reason, since: a.since };
  }

  raiseAlarm(rec) {
    rec.alarmTimer = null;
    if (rec.online || this.children.get(rec.deviceId) !== rec) return;
    const alarm = {
      alarmId: crypto.randomUUID(),
      deviceId: rec.deviceId,
      name: rec.name,
      reason: 'child_offline',
      since: rec.since,
    };
    alarm.unackedTimer = setTimeout(() => {
      if (!this.alarms.has(alarm.alarmId)) return;
      log(`alarm ${alarm.alarmId} unacknowledged, webhook alarm_unacked`);
      sendWebhook('alarm_unacked', { name: alarm.name, title: `Alarm not acknowledged: ${alarm.name}`, message: `Nobody acknowledged that ${alarm.name} went offline.` });
    }, config.alarmUnackedDelay * 1000);
    this.alarms.set(alarm.alarmId, alarm);
    rec.offlineNotified = true;
    log(`alarm ${alarm.alarmId}: child ${JSON.stringify(rec.name)} (${rec.deviceId}) offline`);
    this.toParents({ t: 'alarm', ...this.alarmPayload(alarm) });
    sendWebhook('child_offline', { name: rec.name, title: `${rec.name} offline`, message: `Baby monitor ${rec.name} went offline.` });
  }

  clearAlarm(alarm, why) {
    clearTimeout(alarm.unackedTimer);
    this.alarms.delete(alarm.alarmId);
    log(`alarm ${alarm.alarmId} cleared (${why})`);
    this.toParents({ t: 'alarmCleared', alarmId: alarm.alarmId });
  }

  clearAlarmsOf(deviceId) {
    for (const a of [...this.alarms.values()]) if (a.deviceId === deviceId) this.clearAlarm(a, 'child back');
  }

  ackAlarm(conn, m) {
    if (conn.role !== 'parent') fail('parent only');
    const alarm = this.alarms.get(String(m.alarmId ?? ''));
    if (alarm) this.clearAlarm(alarm, 'acknowledged');
    return null;
  }

  // ---------------------------------------------------------------- devices

  deviceList() {
    return [...this.children.values()].map((c) => ({
      deviceId: c.deviceId,
      name: c.name,
      mode: c.mode,
      online: c.online,
      since: c.since,
      lastSeen: c.lastSeen,
      producers: c.conn
        ? [...c.conn.producers.values()].map((p) => ({ id: p.id, kind: p.kind, source: p.appData.source }))
        : [],
      sound: c.sound,
      motion: c.motion,
      level: c.level,
    }));
  }

  broadcastDevices(throttled = false) {
    const now = Date.now();
    if (throttled) {
      if (this.devicesTimer) return;
      const wait = LEVEL_THROTTLE_MS - (now - this.lastDevicesAt);
      if (wait > 0) {
        this.devicesTimer = setTimeout(() => this.broadcastDevices(), wait);
        return;
      }
    }
    clearTimeout(this.devicesTimer);
    this.devicesTimer = null;
    this.lastDevicesAt = now;
    this.toParents({ t: 'devices', list: this.deviceList() });
  }

  activity(conn, m) {
    if (conn.role !== 'child') fail('child only');
    const rec = this.recordOf(conn);
    if (!rec) fail('not joined');
    const sound = Boolean(m.sound);
    const motion = Boolean(m.motion);
    const level = Math.max(0, Math.min(100, Math.round(Number(m.level) || 0)));
    const changed = sound !== rec.sound || motion !== rec.motion;
    const levelChanged = level !== rec.level;
    Object.assign(rec, { sound, motion, level, lastSeen: Date.now() });
    if (changed) this.broadcastDevices();
    else if (levelChanged) this.broadcastDevices(true);
    return null;
  }

  // ---------------------------------------------------------------- media

  async createTransport(conn, m) {
    if (m.direction !== 'send' && m.direction !== 'recv') fail('invalid direction');
    if (conn.transports.size >= MAX_TRANSPORTS) fail('too many transports');
    const transport = await this.media.createTransport({ direction: m.direction });
    if (!conn.joined || conn.ws.readyState !== 1) {
      transport.close();
      fail('not joined');
    }
    conn.transports.set(transport.id, transport);
    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed' || state === 'failed') transport.close();
    });
    transport.observer.on('close', () => conn.transports.delete(transport.id));
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  transportOf(conn, id, direction) {
    const t = conn.transports.get(String(id ?? ''));
    if (!t) fail('unknown transport');
    if (direction && t.appData.direction !== direction) fail('wrong transport direction');
    return t;
  }

  async connectTransport(conn, m) {
    const t = this.transportOf(conn, m.transportId);
    if (!m.dtlsParameters || typeof m.dtlsParameters !== 'object') fail('dtlsParameters required');
    await t.connect({ dtlsParameters: m.dtlsParameters });
    return null;
  }

  async produce(conn, m) {
    const t = this.transportOf(conn, m.transportId, 'send');
    const kind = m.kind;
    if (kind !== 'audio' && kind !== 'video') fail('invalid kind');
    if (conn.producers.size >= MAX_PRODUCERS) fail('too many producers');
    const source = m.appData?.source;
    const appData = { source, deviceId: conn.deviceId, role: conn.role };
    if (conn.role === 'child') {
      if (!(source === 'cam' && kind === 'video') && !(source === 'mic' && kind === 'audio')) fail('invalid source');
      if ([...conn.producers.values()].some((p) => p.appData.source === source)) fail('source already produced');
    } else {
      if (source !== 'talk' || kind !== 'audio') fail('invalid source');
      const target = this.children.get(String(m.appData?.target ?? ''));
      if (!target?.online || !target.conn) fail('target not online');
      appData.target = target.deviceId;
    }
    if (!m.rtpParameters || typeof m.rtpParameters !== 'object') fail('rtpParameters required');
    const producer = await t.produce({ kind, rtpParameters: m.rtpParameters, appData });
    conn.producers.set(producer.id, producer);
    this.producers.set(producer.id, { producer, conn });
    producer.observer.on('close', () => this.onProducerGone(conn, producer));

    if (conn.role === 'child') {
      this.broadcastDevices();
    } else {
      const target = this.children.get(appData.target);
      if (target?.conn) this.send(target.conn, { t: 'talk', producerId: producer.id });
      log(`talk to ${JSON.stringify(target?.name || appData.target)} started`);
    }
    return { id: producer.id };
  }

  onProducerGone(conn, producer) {
    if (!this.producers.has(producer.id)) return;
    this.producers.delete(producer.id);
    conn.producers.delete(producer.id);
    if (producer.appData.source === 'talk') {
      const target = this.children.get(producer.appData.target);
      if (target?.conn) this.send(target.conn, { t: 'talkEnd', producerId: producer.id });
      log(`talk to ${JSON.stringify(target?.name || producer.appData.target)} ended`);
    } else if (this.children.get(conn.deviceId)?.conn === conn) {
      this.broadcastDevices();
    }
  }

  closeOwnProducer(conn, m) {
    const p = conn.producers.get(String(m.producerId ?? ''));
    if (!p) fail('unknown producer');
    p.close();
    return null;
  }

  async consume(conn, m) {
    const t = this.transportOf(conn, m.transportId, 'recv');
    if (conn.consumers.size >= MAX_CONSUMERS) fail('too many consumers');
    const entry = this.producers.get(String(m.producerId ?? ''));
    if (!entry) fail('unknown producer');
    const { producer } = entry;
    const src = producer.appData.source;
    const allowed = conn.role === 'parent'
      ? entry.conn.role === 'child' && (src === 'cam' || src === 'mic')
      : src === 'talk' && producer.appData.target === conn.deviceId;
    if (!allowed) fail('not allowed');
    if (!m.rtpCapabilities || !this.media.canConsume(producer.id, m.rtpCapabilities)) fail('cannot consume');
    const consumer = await t.consume({
      producerId: producer.id,
      rtpCapabilities: m.rtpCapabilities,
      paused: true,
      ...(producer.kind === 'video' ? { preferredLayers: { spatialLayer: 0 } } : {}),
    });
    conn.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => conn.consumers.delete(consumer.id));
    return { id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
  }

  async resumeConsumer(conn, m) {
    const c = conn.consumers.get(String(m.consumerId ?? ''));
    if (!c) fail('unknown consumer');
    await c.resume();
    return null;
  }

  async setLayer(conn, m) {
    const c = conn.consumers.get(String(m.consumerId ?? ''));
    if (!c) fail('unknown consumer');
    const layer = Number(m.spatialLayer);
    if (layer !== 0 && layer !== 1) fail('invalid spatialLayer');
    if (c.kind === 'video' && c.type === 'simulcast') await c.setPreferredLayers({ spatialLayer: layer });
    return null;
  }

  cleanupMedia(conn) {
    for (const c of [...conn.consumers.values()]) c.close();
    for (const p of [...conn.producers.values()]) p.close();
    for (const t of [...conn.transports.values()]) t.close();
    conn.consumers.clear();
    conn.producers.clear();
    conn.transports.clear();
  }

  // ---------------------------------------------------------------- shutdown

  close() {
    clearInterval(this.tick);
    clearTimeout(this.devicesTimer);
    for (const c of this.children.values()) this.clearChildTimers(c);
    for (const p of this.parents.values()) clearTimeout(p.offlineTimer);
    for (const a of this.alarms.values()) clearTimeout(a.unackedTimer);
    for (const conn of [...this.conns]) {
      conn.left = true;
      this.cleanupMedia(conn);
      try {
        conn.ws.close(1001, 'shutdown');
      } catch { /* ignore */ }
    }
  }
}
