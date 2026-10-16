// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import { config, isoNow, log } from './config.js';
import { WEBHOOK_EVENTS } from './settings.js';

export const EVENTS = WEBHOOK_EVENTS;
const TIMEOUT_MS = 10000;

function fill(template, values, escape) {
  return template.replace(/\{(event|name|title|message|time)\}/g, (_, key) => escape(String(values[key] ?? '')));
}

const jsonEscape = (s) => JSON.stringify(s).slice(1, -1);
const plain = (s) => s;

async function sendOne(hook, values) {
  const label = hook.n ? `webhook ${hook.n}` : 'webhook test';
  const url = fill(hook.url, values, encodeURIComponent);
  const headers = {};
  for (const [name, value] of hook.headers) headers[name] = fill(value, values, plain);
  let body;
  if (hook.method !== 'GET' && hook.body) {
    const trimmed = hook.body.trimStart();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    body = fill(hook.body, values, isJson ? jsonEscape : plain);
    const hasType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
    if (!hasType) headers['Content-Type'] = isJson ? 'application/json' : 'text/plain; charset=utf-8';
  }
  try {
    const res = await fetch(url, { method: hook.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    if (res.ok) log(`${label}: ${values.event} sent (${res.status})`);
    else log(`${label}: ${values.event} failed with HTTP ${res.status}`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.name || 'error';
    log(`${label}: ${values.event} failed (${reason})`);
    return { ok: false, reason: String(reason) };
  }
}

// Sends event "test" to one hook definition (ignores its event filter).
export function testWebhook(hook) {
  const values = { event: 'test', name: '', title: 'Babyphone test', message: 'Babyphone webhook test', time: isoNow() };
  return sendOne({ ...hook, n: 0 }, values);
}

// Fire and forget; never throws.
export function sendWebhook(event, { name = '', title = '', message = '' } = {}) {
  const values = { event, name, title, message, time: isoNow() };
  for (const hook of config.webhooks) {
    if (hook.events && !hook.events.includes(event)) continue;
    sendOne(hook, values);
  }
}

export function webhookStartup() {
  if (config.webhooks.length) log(`webhooks: ${config.webhooks.length} configured`);
  if (config.webhookTest) {
    sendWebhook('test', { title: 'Babyphone test', message: 'Babyphone webhook test' });
  }
}
