// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Local activity detection on the child device: audio RMS and motion frame diff.

const SOUND_INTERVAL = 200;
const MOTION_INTERVAL = 500;
const LEVEL_INTERVAL = 500;
const HOLD_MS = 3000;
const MOTION_W = 64;
const MOTION_H = 48;
const PIXEL_DIFF = 25; // luminance delta (0..255) for a pixel to count as changed
const DB_FLOOR = -60; // dBFS mapped to level 0; 0 dBFS = level 100

// send({sound, motion, level}) is called on state change and every 500 ms.
export function startDetector({ stream, audioCtx, video, soundThreshold = 25, motionThreshold = 4, send }) {
  const state = { sound: false, motion: false, level: 0 };
  let soundUntil = 0;
  let motionUntil = 0;
  let peak = 0;
  const timers = [];
  let source = null;
  let analyser = null;
  let buf = null;

  const audioTrack = stream.getAudioTracks()[0];
  if (audioCtx && audioTrack) {
    try {
      source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      buf = new Float32Array(analyser.fftSize);
      source.connect(analyser);
    } catch (e) {
      console.warn('analyser unavailable', e);
      analyser = null;
    }
  }

  const emit = () => send({ sound: state.sound, motion: state.motion, level: state.level });

  const evaluate = () => {
    const now = Date.now();
    const sound = now < soundUntil;
    const motion = now < motionUntil;
    if (sound !== state.sound || motion !== state.motion) {
      state.sound = sound;
      state.motion = motion;
      emit();
    }
  };

  timers.push(setInterval(() => {
    if (analyser) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const level = Math.max(0, Math.min(100, ((db - DB_FLOOR) / -DB_FLOOR) * 100));
      if (level > peak) peak = level;
      if (level >= soundThreshold) soundUntil = Date.now() + HOLD_MS;
    }
    evaluate();
  }, SOUND_INTERVAL));

  if (video && stream.getVideoTracks().length) {
    const canvas = document.createElement('canvas');
    canvas.width = MOTION_W;
    canvas.height = MOTION_H;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    let prev = null;
    timers.push(setInterval(() => {
      if (!g || video.readyState < 2) return;
      try {
        g.drawImage(video, 0, 0, MOTION_W, MOTION_H);
        const px = g.getImageData(0, 0, MOTION_W, MOTION_H).data;
        const cur = new Uint8Array(MOTION_W * MOTION_H);
        let changed = 0;
        for (let i = 0, j = 0; j < cur.length; i += 4, j++) {
          cur[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
          if (prev && Math.abs(cur[j] - prev[j]) > PIXEL_DIFF) changed++;
        }
        if (prev && (changed / cur.length) * 100 >= motionThreshold) motionUntil = Date.now() + HOLD_MS;
        prev = cur;
      } catch {
        // frame not ready
      }
    }, MOTION_INTERVAL));
  }

  timers.push(setInterval(() => {
    state.level = Math.round(peak);
    peak = 0;
    emit();
  }, LEVEL_INTERVAL));

  return {
    resend: emit,
    setSoundThreshold(v) {
      soundThreshold = v;
    },
    stop() {
      timers.forEach(clearInterval);
      try {
        source?.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
