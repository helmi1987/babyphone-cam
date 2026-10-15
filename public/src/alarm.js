// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Shared AudioContext, autoplay unlock and the alarm tone loop.

let ctx = null;

export function getAudioContext() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try {
      ctx = new C();
    } catch {
      return null;
    }
  }
  return ctx;
}

// Must be called synchronously inside a user gesture handler.
export function unlockAudio() {
  const c = getAudioContext();
  if (c && c.state !== 'running') c.resume().catch(() => {});
  return c;
}

export function installAudioUnlock() {
  const resume = () => {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) {
    document.addEventListener(ev, resume, { capture: true, passive: true });
  }
}

export class AlarmTone {
  constructor() {
    this.timer = null;
  }

  get active() {
    return this.timer != null;
  }

  set(on) {
    if (on && !this.timer) {
      this.ring();
      this.timer = setInterval(() => this.ring(), 1500);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  ring() {
    const c = getAudioContext();
    if (!c) return;
    if (c.state !== 'running') c.resume().catch(() => {});
    const t0 = c.currentTime + 0.02;
    beep(c, 880, t0, 0.25);
    beep(c, 660, t0 + 0.35, 0.25);
    beep(c, 880, t0 + 0.7, 0.25);
  }
}

function beep(c, freq, at, dur) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
  g.gain.setValueAtTime(0.3, at + dur - 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  osc.onended = () => g.disconnect();
}
