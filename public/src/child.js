// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Child device: name/mode setup, capture, produce, talk playback, black overlay.

import { h, load, save, deviceId, mediaAvailable, errMsg } from './dom.js';
import { t } from './i18n.js';
import { Hub } from './api.js';
import { Media } from './media.js';
import { unlockAudio } from './alarm.js';
import { startDetector } from './detect.js';

const SIMULCAST = [
  { scaleResolutionDownBy: 4, maxBitrate: 150000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1200000 },
];
const BAR_MS = 5000;
const DOUBLE_TAP_MS = 400;

export function mountChild(root, cfg, nav) {
  const myId = deviceId('bp.deviceId');
  const prefs = {
    name: load('bp.childName', ''),
    mode: load('bp.childMode', 'cam') === 'phone' ? 'phone' : 'cam',
    facing: load('bp.facing', 'user') === 'environment' ? 'environment' : 'user',
  };
  let run = null;

  const onVisibility = () => {
    if (!run || document.visibilityState !== 'visible') return;
    requestWakeLock();
    refreshStream().catch((e) => console.warn('refresh stream', e));
  };
  document.addEventListener('visibilitychange', onVisibility);

  renderSetup();

  return {
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      teardown();
    },
  };

  // ---------- setup view ----------

  function renderSetup(error) {
    const err = h('p', { class: 'error', role: 'alert' }, error || '');
    const input = h('input', {
      type: 'text',
      class: 'text',
      placeholder: t('namePlaceholder'),
      maxLength: 40,
      autocomplete: 'off',
      value: (cfg.childNames || []).includes(prefs.name) ? '' : prefs.name,
      oninput: () => {
        if (input.value.trim()) {
          prefs.name = input.value.trim();
          markNames();
        }
      },
    });
    const nameBtns = (cfg.childNames || []).map((n) =>
      h('button', {
        type: 'button',
        class: 'chip',
        onclick: () => {
          prefs.name = n;
          input.value = '';
          markNames();
        },
      }, n));
    const markNames = () => {
      for (const b of nameBtns) b.classList.toggle('selected', b.textContent === prefs.name && !input.value.trim());
    };
    markNames();

    const modeBtn = (mode, label, hint) =>
      h('button', {
        type: 'button',
        class: `seg${prefs.mode === mode ? ' selected' : ''}`,
        onclick: () => {
          prefs.mode = mode;
          renderModes();
        },
      }, h('strong', null, label), h('small', null, hint));
    const facingBtn = (facing, label) =>
      h('button', {
        type: 'button',
        class: `seg${prefs.facing === facing ? ' selected' : ''}`,
        onclick: () => {
          prefs.facing = facing;
          renderModes();
        },
      }, label);
    const modeBox = h('div');
    const renderModes = () => {
      modeBox.replaceChildren(
        h('h2', null, t('mode')),
        h('div', { class: 'segmented' },
          modeBtn('cam', t('modeCam'), t('modeCamHint')),
          modeBtn('phone', t('modePhone'), t('modePhoneHint'))),
        ...(prefs.mode === 'cam'
          ? [h('h2', null, t('camera')), h('div', { class: 'segmented' },
            facingBtn('user', t('front')), facingBtn('environment', t('rear')))]
          : []),
      );
    };
    renderModes();

    const ok = mediaAvailable();
    const startBtn = h('button', {
      type: 'button',
      class: 'primary big',
      disabled: !ok,
      onclick: () => {
        const typed = input.value.trim();
        if (typed) prefs.name = typed;
        if (!prefs.name) {
          err.textContent = t('nameRequired');
          return;
        }
        start();
      },
    }, t('start'));

    root.replaceChildren(h('section', { class: 'view setup' },
      h('header', { class: 'bar' },
        h('h1', null, t('roleChild')),
        h('button', { type: 'button', class: 'ghost', onclick: () => nav.logout() }, t('logout'))),
      ok ? null : h('p', { class: 'warn' }, window.isSecureContext ? t('noMedia') : t('insecure')),
      h('h2', null, t('childName')),
      nameBtns.length ? h('div', { class: 'chips' }, nameBtns) : null,
      input,
      modeBox,
      err,
      startBtn,
    ));
  }

  // ---------- running ----------

  function start() {
    save('bp.childName', prefs.name);
    save('bp.childMode', prefs.mode);
    save('bp.facing', prefs.facing);
    // Gesture-bound calls first.
    const audioCtx = unlockAudio();
    try {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {
      // not supported
    }
    run = {
      name: prefs.name,
      mode: prefs.mode,
      facing: prefs.facing,
      audioCtx,
      gen: 0,
      hub: null,
      media: null,
      stream: null,
      detector: null,
      sendT: null,
      recvT: null,
      recvP: null,
      producers: {},
      talks: new Map(),
      wakeLock: null,
    };
    const r = run;
    buildOverlay();
    getStream(r.mode, r.facing)
      .then((stream) => {
        if (run !== r) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        setStream(stream);
        requestWakeLock();
        r.hub = new Hub();
        r.media = new Media(r.hub);
        r.hub.on('open', () => session(r));
        r.hub.on('close', () => onClose(r));
        r.hub.on('talk', (m) => onTalk(r, m.producerId));
        r.hub.on('talkEnd', (m) => endTalk(r, m.producerId));
        r.hub.on('switchCamera', () => flipCamera());
        r.hub.on('threshold', (m) => setThreshold(r, m));
        r.hub.start();
        showBar();
      })
      .catch((e) => {
        teardown();
        renderSetup(t('mediaDenied', { msg: errMsg(e) }));
      });
  }

  function getStream(mode, facing) {
    // Raw-ish audio so quiet sounds stay audible; echo cancellation for talk playback.
    const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
    const video = mode === 'cam' ? videoConstraints(facing) : false;
    return navigator.mediaDevices.getUserMedia({ audio, video });
  }

  function videoConstraints(facing) {
    return { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } };
  }

  // Front <-> rear camera, keeps the audio track and the producer
  async function flipCamera() {
    const r = run;
    if (!r?.stream || r.mode !== 'cam' || r.flipping) return;
    r.flipping = true;
    const next = r.facing === 'user' ? 'environment' : 'user';
    const oldV = r.stream.getVideoTracks()[0];
    // iOS allows only one camera at a time: stop the old one first
    oldV?.stop();
    let track = null;
    let facing = next;
    try {
      track = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(next) })).getVideoTracks()[0];
    } catch {
      facing = r.facing;
      track = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing) }).catch(() => null))?.getVideoTracks()[0] || null;
    }
    r.flipping = false;
    if (!track) return;
    if (run !== r) {
      track.stop();
      return;
    }
    if (oldV) r.stream.removeTrack(oldV);
    r.stream.addTrack(track);
    r.video.srcObject = new MediaStream([track]);
    r.video.play().catch(() => {});
    const p = r.producers.video;
    if (p && !p.closed) await p.replaceTrack({ track }).catch(() => {});
    r.facing = facing;
    prefs.facing = facing;
    save('bp.facing', facing);
    sendFacing(r);
  }

  function setThreshold(r, v) {
    if (Number.isFinite(v?.sound)) {
      r.soundThreshold = v.sound;
      r.detector?.setSoundThreshold(v.sound);
    }
    if (Number.isFinite(v?.motion)) {
      r.motionThreshold = v.motion;
      r.detector?.setMotionThreshold(v.motion);
    }
  }

  function sendFacing(r) {
    if (r.mode === 'cam' && r.hub?.connected && r.joined) r.hub.request('setFacing', { facing: r.facing }).catch(() => {});
  }

  function setStream(stream) {
    const r = run;
    const old = r.stream;
    r.stream = stream;
    if (old && old !== stream) old.getTracks().forEach((tr) => tr.stop());
    r.video.srcObject = stream.getVideoTracks().length ? new MediaStream(stream.getVideoTracks()) : null;
    if (r.video.srcObject) r.video.play().catch(() => {});
    r.detector?.stop();
    r.detector = startDetector({
      stream,
      audioCtx: r.audioCtx,
      video: r.video,
      soundThreshold: r.soundThreshold ?? cfg.soundThreshold ?? 25,
      motionThreshold: r.motionThreshold ?? cfg.motionThreshold ?? 4,
      send: (a) => {
        if (r.hub?.connected && r.joined) r.hub.request('activity', a).catch(() => {});
      },
    });
  }

  async function refreshStream() {
    const r = run;
    if (!r?.stream) return;
    if (r.stream.getTracks().every((tr) => tr.readyState === 'live')) return;
    const stream = await getStream(r.mode, r.facing);
    if (run !== r) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    setStream(stream);
    const { video, audio } = r.producers;
    if (video && !video.closed) await video.replaceTrack({ track: stream.getVideoTracks()[0] || null }).catch(() => {});
    if (audio && !audio.closed) await audio.replaceTrack({ track: stream.getAudioTracks()[0] || null }).catch(() => {});
  }

  async function session(r) {
    const g = ++r.gen;
    closeMedia(r);
    setStatus(t('connecting'), false);
    try {
      await refreshStream();
      const { rtpCapabilities, soundThreshold, motionThreshold } = await r.hub.request('join', { deviceId: myId, name: r.name, mode: r.mode });
      setThreshold(r, { sound: soundThreshold, motion: motionThreshold });
      if (g !== r.gen) return;
      await r.media.load(rtpCapabilities);
      const tr = await r.media.createTransport('send');
      if (g !== r.gen) {
        tr.close();
        return;
      }
      r.sendT = tr;
      const vt = r.stream.getVideoTracks()[0];
      const at = r.stream.getAudioTracks()[0];
      if (r.mode === 'cam' && vt) {
        r.producers.video = await tr.produce({
          track: vt,
          encodings: SIMULCAST,
          codecOptions: { videoGoogleStartBitrate: 1000 },
          stopTracks: false,
          appData: { source: 'cam' },
        });
      }
      if (at) {
        r.producers.audio = await tr.produce({
          track: at,
          stopTracks: false,
          appData: { source: 'mic' },
        });
      }
      if (g !== r.gen) return;
      r.joined = true;
      sendFacing(r);
      setStatus(t('connected'), true);
      r.detector?.resend();
    } catch (e) {
      console.warn('child session failed', e);
      if (g === r.gen && r.hub.connected) r.hub.drop();
    }
  }

  function onClose(r) {
    r.gen++;
    closeMedia(r);
    setStatus(t('connecting'), false);
    nav.checkAuth('child');
  }

  function closeMedia(r) {
    r.joined = false;
    for (const id of [...r.talks.keys()]) endTalk(r, id);
    for (const p of Object.values(r.producers)) p.close();
    r.producers = {};
    r.sendT?.close();
    r.recvT?.close();
    r.sendT = r.recvT = r.recvP = null;
  }

  async function onTalk(r, producerId) {
    if (!producerId || r.talks.has(producerId)) return;
    const g = r.gen;
    const el = h('audio', { autoplay: true });
    r.talks.set(producerId, { el, consumer: null });
    r.overlay.append(el);
    try {
      if (!r.recvP) {
        r.recvP = r.media.createTransport('recv').then((tr) => {
          if (g !== r.gen) {
            tr.close();
            throw new Error('stale');
          }
          r.recvT = tr;
          return tr;
        });
        r.recvP.catch(() => {
          if (r.gen === g) r.recvP = null;
        });
      }
      const tr = await r.recvP;
      const consumer = await r.media.consume(tr, producerId);
      const entry = r.talks.get(producerId);
      if (!entry || g !== r.gen) {
        consumer.close();
        return;
      }
      entry.consumer = consumer;
      el.srcObject = new MediaStream([consumer.track]);
      el.play().catch((e) => console.warn('talk play', e));
    } catch (e) {
      console.warn('talk consume failed', e);
      endTalk(r, producerId);
    }
  }

  function endTalk(r, producerId) {
    const entry = r.talks.get(producerId);
    if (!entry) return;
    r.talks.delete(producerId);
    entry.consumer?.close();
    entry.el.srcObject = null;
    entry.el.remove();
  }

  async function requestWakeLock() {
    const r = run;
    if (!r || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    if (r.wakeLock && !r.wakeLock.released) return;
    try {
      r.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      console.warn('wake lock', e);
    }
  }

  // ---------- overlay ----------

  function buildOverlay() {
    const r = run;
    const status = h('span', { class: 'status' }, t('connecting'));
    const dot = h('span', { class: 'dot' });
    const bar = h('div', { class: 'overlay-bar', hidden: true },
      h('div', { class: 'overlay-info' },
        h('div', null, dot, ' ', h('strong', null, r.name), ' · ', status),
        h('div', { class: 'hint' }, t('noLock')),
        h('div', { class: 'hint' }, t('doubleTap'))),
      r.mode === 'cam'
        ? h('button', { type: 'button', class: 'ghost', onclick: () => { flipCamera(); showBar(); } }, t('switchCamera'))
        : null,
      h('button', { type: 'button', class: 'danger', onclick: () => stop() }, t('stop')));
    const video = h('video', { class: 'probe', muted: true, playsInline: true, autoplay: true });
    video.setAttribute('playsinline', '');
    const overlay = h('div', { class: 'blackout' }, video, bar);
    let lastTap = 0;
    overlay.addEventListener('pointerup', (e) => {
      if (bar.contains(e.target)) return;
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        showBar();
      } else {
        lastTap = now;
      }
    });
    overlay.addEventListener('dblclick', (e) => e.preventDefault());
    document.body.append(overlay);
    Object.assign(r, { overlay, bar, statusEl: status, dotEl: dot, video, barTimer: null });
  }

  function showBar() {
    const r = run;
    if (!r) return;
    r.bar.hidden = false;
    clearTimeout(r.barTimer);
    r.barTimer = setTimeout(() => {
      r.bar.hidden = true;
    }, BAR_MS);
  }

  function setStatus(text, ok) {
    if (!run?.statusEl) return;
    run.statusEl.textContent = text;
    run.dotEl.classList.toggle('ok', ok);
  }

  async function stop() {
    const r = run;
    if (!r) return;
    if (r.hub?.connected) await r.hub.request('leave').catch(() => {});
    teardown();
    renderSetup();
  }

  function teardown() {
    const r = run;
    if (!r) return;
    run = null;
    r.gen++;
    r.hub?.stop();
    closeMedia(r);
    r.detector?.stop();
    r.stream?.getTracks().forEach((tr) => tr.stop());
    r.wakeLock?.release().catch(() => {});
    clearTimeout(r.barTimer);
    r.overlay?.remove();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
}
