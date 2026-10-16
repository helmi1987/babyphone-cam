// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Parent device: tile grid, per-child audio mixing, enlarge, push-to-talk, alarms.

import { h, load, save, deviceId, mediaAvailable, errMsg } from './dom.js';
import { t, clock } from './i18n.js';
import { Hub } from './api.js';
import { Media } from './media.js';
import { getAudioContext, AlarmTone } from './alarm.js';

export function mountParent(root, cfg, nav) {
  const myId = deviceId('bp.parentId');
  const ctx = getAudioContext();
  const hub = new Hub();
  const media = new Media(hub);
  const tone = new AlarmTone();
  const tiles = new Map();
  const alarms = new Map();
  let recvT = null;
  let gen = 0;
  let enlarged = null;
  let fullChrome = 200; // tile height minus picture, measured in layout()
  const FOCUS_HOLD = 5000;
  const FOCUS_MAX = 4;
  const focusSince = new Map(); // deviceId -> time sound started
  const focusUntil = new Map(); // deviceId -> keep in focus until
  let focusTimer = null;
  let talk = null;
  let localAcked = false;
  let destroyed = false;

  const dot = h('span', { class: 'dot' });
  const soundHint = h('button', {
    type: 'button',
    class: 'notice',
    hidden: true,
    onclick: () => ctx?.resume().catch(() => {}),
  }, t('tapForSound'));
  const banners = h('div', { class: 'banners', role: 'alert' });
  const toast = h('p', { class: 'error', role: 'status' });
  const empty = h('p', { class: 'empty' }, t('noChildren'));
  const grid = h('div', { class: 'grid' });
  // Auto focus: children with sound take over the screen (newest 4, ~5 s after)
  let autoFocus = load('bp.autoFocus', false) === true;
  const focusBtn = h('button', {
    type: 'button',
    class: 'ghost small',
    'aria-pressed': String(autoFocus),
    onclick: () => {
      autoFocus = !autoFocus;
      save('bp.autoFocus', autoFocus);
      updateFocus();
    },
  }, `${t('autoFocus')}: ${autoFocus ? t('on') : t('off')}`);
  focusBtn.classList.toggle('selected', autoFocus);

  root.replaceChildren(h('section', { class: 'view parent' },
    h('header', { class: 'bar' },
      h('h1', null, dot, ' ', t('roleParent')),
      h('div', { class: 'bar-actions' },
        focusBtn,
        h('button', { type: 'button', class: 'ghost', onclick: () => logout() }, t('logout')))),
    soundHint,
    toast,
    empty,
    grid));
  document.body.append(banners);

  const updateSoundHint = () => {
    soundHint.hidden = !ctx || ctx.state === 'running';
  };
  if (ctx) {
    ctx.addEventListener('statechange', updateSoundHint);
    ctx.resume().catch(() => {});
  }
  updateSoundHint();

  const onKey = (e) => {
    if (e.key === 'Escape' && enlarged) toggleEnlarge(enlarged);
  };
  document.addEventListener('keydown', onKey);
  const clockTimer = setInterval(() => {
    for (const tile of tiles.values()) updateTile(tile);
  }, 15000);

  hub.on('open', session);
  hub.on('close', onClose);
  hub.on('devices', (m) => renderList(Array.isArray(m.list) ? m.list : []));
  hub.on('alarm', (m) => {
    alarms.set(m.alarmId, m);
    renderAlarms();
  });
  hub.on('alarmCleared', (m) => {
    alarms.delete(m.alarmId);
    renderAlarms();
  });
  hub.on('stale', () => {
    localAcked = false;
    updateDot();
    renderAlarms();
  });
  hub.on('fresh', () => {
    localAcked = false;
    updateDot();
    renderAlarms();
  });
  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  hub.start();

  return { destroy };

  // ---------- connection ----------

  async function session() {
    const g = ++gen;
    // Server resends open alarms on join; drop ones cleared while disconnected
    alarms.clear();
    renderAlarms();
    resetMedia();
    updateDot();
    try {
      const { rtpCapabilities } = await hub.request('join', { deviceId: myId });
      if (g !== gen) return;
      await media.load(rtpCapabilities);
      const tr = await media.createTransport('recv');
      if (g !== gen) {
        tr.close();
        return;
      }
      recvT = tr;
      for (const tile of tiles.values()) syncConsumers(tile);
    } catch (e) {
      console.warn('parent session failed', e);
      if (g === gen && hub.connected) hub.drop();
    }
  }

  function onClose() {
    gen++;
    resetMedia();
    updateDot();
    nav.checkAuth('parent');
  }

  function resetMedia() {
    stopTalk();
    for (const tile of tiles.values()) {
      for (const pid of [...tile.consumers.keys()]) closeConsumer(tile, pid);
    }
    recvT?.close();
    recvT = null;
  }

  function updateDot() {
    dot.classList.toggle('ok', hub.connected && !hub.stale);
  }

  // ---------- devices ----------

  function renderList(list) {
    // Only child devices carry a mode (assumption: parents are not listed or have no cam/phone mode).
    const children = list.filter((d) => d && (d.mode === 'cam' || d.mode === 'phone'));
    const seen = new Set();
    for (const d of children) {
      seen.add(d.deviceId);
      let tile = tiles.get(d.deviceId);
      if (!tile) {
        tile = createTile(d);
        tiles.set(d.deviceId, tile);
        grid.append(tile.el);
      }
      tile.data = d;
      updateTile(tile);
      syncConsumers(tile);
    }
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) removeTile(tile);
    }
    empty.hidden = tiles.size > 0;
    updateFocus();
  }

  // Use the whole screen: pick the column count that gives each picture the
  // largest 16:9 area; fall back to a scrolling grid when tiles get too small.
  // Use the whole screen without scrolling: pick the column count that gives
  // each picture the largest 16:9 area. If full controls do not fit, tiles
  // switch to "mini" (name over the picture, controls in the enlarged view).
  function layout() {
    const shown = [...tiles.values()].filter((tl) => !tl.el.classList.contains('unfocused'));
    const n = shown.length;
    const gap = n > 4 ? 8 : 12;
    const W = grid.clientWidth;
    const view = grid.parentElement;
    const padBottom = view ? parseFloat(getComputedStyle(view).paddingBottom) || 0 : 0;
    const H = window.innerHeight - grid.getBoundingClientRect().top - window.scrollY - padBottom;
    const first = shown[0];
    if (first && !grid.classList.contains('mini')) {
      const c = first.el.offsetHeight - first.el.querySelector('.media').offsetHeight;
      if (c > 0) fullChrome = c;
    }
    const pick = (chrome, minW, minH) => {
      let best = null;
      for (let cols = 1; cols <= Math.max(1, n); cols++) {
        const rows = Math.ceil(n / cols);
        const cw = (W - gap * (cols - 1)) / cols;
        const mh = (H - gap * (rows - 1)) / rows - chrome;
        if (cw < minW || mh < minH) continue;
        const vw = Math.min(cw, (mh * 16) / 9);
        if (!best || vw > best.vw) best = { cols, rows, vw };
      }
      return best;
    };
    let best = pick(fullChrome, 300, 120);
    const mini = n > 0 && !best;
    if (mini) best = pick(0, 0, 0) || { cols: 1, rows: n };
    grid.classList.toggle('fill', n > 0);
    grid.classList.toggle('mini', mini);
    grid.style.gap = `${gap}px`;
    grid.style.gridTemplateColumns = n ? `repeat(${best.cols}, minmax(0, 1fr))` : '';
    grid.style.gridTemplateRows = n ? `repeat(${best.rows}, minmax(0, 1fr))` : '';
    grid.style.height = n ? `${Math.max(0, Math.floor(H))}px` : '';
  }
  function updateFocus() {
    const now = Date.now();
    for (const [id, tile] of tiles) {
      const d = tile.data || {};
      if (d.online && d.sound) {
        if (!(focusUntil.get(id) > now)) focusSince.set(id, now);
        focusUntil.set(id, now + FOCUS_HOLD);
      }
    }
    for (const id of [...focusUntil.keys()]) {
      if (!tiles.has(id) || focusUntil.get(id) <= now) {
        focusUntil.delete(id);
        focusSince.delete(id);
      }
    }
    // A picture enlarged by hand is never replaced
    const ids = autoFocus && !enlarged
      ? [...focusUntil.keys()].sort((a, b) => focusSince.get(b) - focusSince.get(a)).slice(0, FOCUS_MAX)
      : [];
    const focus = new Set(ids);
    for (const [id, tile] of tiles) tile.el.classList.toggle('unfocused', focus.size > 0 && !focus.has(id));
    grid.classList.toggle('focus', focus.size > 0);
    focusBtn.textContent = `${t('autoFocus')}: ${autoFocus ? t('on') : t('off')}`;
    focusBtn.setAttribute('aria-pressed', String(autoFocus));
    focusBtn.classList.toggle('selected', autoFocus);
    clearTimeout(focusTimer);
    if (focus.size) focusTimer = setTimeout(updateFocus, 1000);
    layout();
  }

  function wantedProducers(tile) {
    const d = tile.data;
    if (!d.online || !Array.isArray(d.producers)) return new Map();
    return new Map(d.producers.filter((p) => p.source !== 'talk').map((p) => [p.id, p]));
  }

  function syncConsumers(tile) {
    const want = wantedProducers(tile);
    for (const pid of [...tile.consumers.keys()]) {
      if (!want.has(pid)) closeConsumer(tile, pid);
    }
    if (!recvT) return;
    for (const pid of want.keys()) {
      if (!tile.consumers.has(pid) && !tile.pending.has(pid)) consume(tile, pid);
    }
  }

  async function consume(tile, pid) {
    const tr = recvT;
    tile.pending.add(pid);
    try {
      const c = await media.consume(tr, pid, { spatialLayer: enlarged === tile ? 1 : 0 });
      if (tr !== recvT || tiles.get(tile.id) !== tile || !wantedProducers(tile).has(pid)) {
        c.close();
        return;
      }
      tile.consumers.set(pid, c);
      attach(tile, c);
      c.on('transportclose', () => closeConsumer(tile, pid));
    } catch (e) {
      console.warn('consume failed', e);
    } finally {
      tile.pending.delete(pid);
    }
  }

  function attach(tile, c) {
    const stream = new MediaStream([c.track]);
    if (c.kind === 'video') {
      tile.video.srcObject = stream;
      tile.video.play().catch(() => {});
      tile.el.classList.add('has-video');
      return;
    }
    // Muted element keeps Chrome pulling the remote audio; sound goes through WebAudio.
    tile.audioEl.srcObject = stream;
    tile.audioEl.play().catch(() => {});
    if (ctx && tile.gain) {
      try {
        tile.source?.disconnect();
        tile.source = ctx.createMediaStreamSource(stream);
        tile.source.connect(tile.gain);
      } catch (e) {
        console.warn('webaudio route failed', e);
        tile.source = null;
      }
    }
    applyGain(tile);
  }

  function closeConsumer(tile, pid) {
    const c = tile.consumers.get(pid);
    if (!c) return;
    tile.consumers.delete(pid);
    if (c.kind === 'video') {
      tile.video.srcObject = null;
      tile.el.classList.remove('has-video');
    } else {
      try {
        tile.source?.disconnect();
      } catch {
        // ignore
      }
      tile.source = null;
      tile.audioEl.srcObject = null;
    }
    if (!c.closed) c.close();
  }

  function applyGain(tile) {
    const vol = tile.muted ? 0 : tile.volume / 100;
    if (tile.gain) tile.gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
    if (tile.source) {
      tile.audioEl.muted = true;
    } else {
      // Fallback without WebAudio: element volume, max 100 %.
      tile.audioEl.muted = tile.muted;
      tile.audioEl.volume = Math.min(1, vol);
    }
    tile.muteBtn.textContent = tile.muted ? t('unmute') : t('mute');
    tile.muteBtn.setAttribute('aria-pressed', String(tile.muted));
    tile.volLabel.textContent = `${tile.volume} %`;
  }

  function createTile(d) {
    const id = d.deviceId;
    const tile = {
      id,
      data: d,
      consumers: new Map(),
      pending: new Set(),
      volume: clampVol(load(`bp.vol.${id}`, 100)),
      muted: load(`bp.mute.${id}`, false) === true,
      gain: null,
      source: null,
    };
    if (ctx) {
      tile.gain = ctx.createGain();
      tile.gain.connect(ctx.destination);
    }
    tile.video = h('video', { muted: true, playsInline: true, autoplay: true });
    tile.video.setAttribute('playsinline', '');
    tile.audioEl = h('audio', { muted: true, autoplay: true });
    tile.nameEl = h('strong', { class: 'name' });
    tile.modeEl = h('span', { class: 'badge' });
    tile.micEl = h('span', { class: 'badge mic' }, t('micActive'));
    tile.stateEl = h('span', { class: 'state' });
    tile.levelEl = h('span', { class: 'level-fill' });
    tile.placeholder = h('div', { class: 'placeholder' }, t('audioOnly'));
    tile.volLabel = h('span', { class: 'vol-label' });
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '200',
      step: '5',
      value: String(tile.volume),
      'aria-label': t('volume'),
      oninput: () => {
        tile.volume = clampVol(Number(slider.value));
        save(`bp.vol.${id}`, tile.volume);
        applyGain(tile);
      },
    });
    tile.muteBtn = h('button', {
      type: 'button',
      class: 'small',
      onclick: () => {
        tile.muted = !tile.muted;
        save(`bp.mute.${id}`, tile.muted);
        applyGain(tile);
      },
    });
    tile.talkBtn = h('button', { type: 'button', class: 'talk' }, t('talk'));
    bindTalk(tile);
    tile.thrMark = h('span', { class: 'thr-mark' });
    // Threshold sliders: sound (0-100, marker on the level bar) and motion (% changed pixels)
    const thrRow = (kind, max) => {
      const label = h('span', { class: 'vol-label' });
      let timer = null;
      const input = h('input', {
        type: 'range',
        min: '0',
        max: String(max),
        step: '1',
        'aria-label': t(kind === 'sound' ? 'thrSound' : 'thrMotion'),
        oninput: () => {
          const v = Number(input.value);
          tile.thrEditUntil = Date.now() + 1500;
          showThreshold(tile, kind, v);
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (hub.connected) hub.request('setThreshold', { deviceId: id, [kind]: v }).catch(() => {});
          }, 300);
        },
      });
      tile.thr[kind] = { input, label };
      return h('div', { class: `vol thr thr-${kind}` },
        h('span', { class: 'thr-title' }, t(kind === 'sound' ? 'thrSound' : 'thrMotion')), input, label);
    };
    tile.thr = {};
    const soundRow = thrRow('sound', 100);
    const motionRow = thrRow('motion', 50);
    tile.motionRow = motionRow;
    tile.flipBtn = h('button', {
      type: 'button',
      class: 'small flip',
      onclick: () => {
        if (hub.connected) hub.request('switchCamera', { deviceId: id }).catch(() => {});
      },
    }, t('switchCamera'));
    const closeBtn = h('button', {
      type: 'button',
      class: 'close-big',
      'aria-label': t('close'),
      onclick: (e) => {
        e.stopPropagation();
        toggleEnlarge(tile);
      },
    }, '×');
    const controls = h('div', { class: 'controls' },
      h('div', { class: 'vol' }, slider, tile.volLabel, tile.muteBtn),
      soundRow,
      motionRow,
      h('div', { class: 'actions' }, tile.talkBtn, tile.flipBtn));
    for (const ev of ['click', 'pointerdown', 'pointerup']) controls.addEventListener(ev, (e) => e.stopPropagation());

    tile.el = h('article', { class: 'tile', tabIndex: 0 },
      h('div', { class: 'media', onclick: () => toggleEnlarge(tile) },
        tile.video, tile.placeholder, closeBtn,
        h('div', { class: 'level' }, tile.levelEl, tile.thrMark)),
      h('div', { class: 'info', onclick: () => toggleEnlarge(tile) },
        tile.nameEl, tile.modeEl, tile.micEl, tile.stateEl),
      controls,
      tile.audioEl);
    tile.el.addEventListener('keydown', (e) => {
      if (e.target === tile.el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggleEnlarge(tile);
      }
    });
    applyGain(tile);
    return tile;
  }

  function showThreshold(tile, kind, v) {
    tile.thr[kind].label.textContent = kind === 'motion' ? `${v} %` : String(v);
    if (kind === 'sound') tile.thrMark.style.left = `${v}%`;
  }

  function updateTile(tile) {
    const d = tile.data;
    const online = Boolean(d.online);
    const producers = Array.isArray(d.producers) ? d.producers : [];
    tile.nameEl.textContent = d.name || '?';
    tile.modeEl.textContent = d.mode === 'phone' ? t('modePhone') : t('modeCam');
    tile.micEl.hidden = !(online && producers.some((p) => p.source === 'mic'));
    if (online) {
      tile.stateEl.textContent = t('online');
    } else if (d.since) {
      const min = Math.max(0, Math.floor((Date.now() - Number(d.since)) / 60000));
      tile.stateEl.textContent = t('offlineSince', { min });
    } else {
      tile.stateEl.textContent = t('offline');
    }
    tile.el.classList.toggle('offline', !online);
    tile.el.classList.toggle('active', online && Boolean(d.sound || d.motion));
    tile.el.classList.toggle('phone', d.mode === 'phone');
    tile.levelEl.style.width = `${online ? Math.max(0, Math.min(100, Number(d.level) || 0)) : 0}%`;
    tile.talkBtn.disabled = !online || !mediaAvailable();
    if (!(tile.thrEditUntil > Date.now())) {
      for (const [kind, v] of [['sound', d.soundThreshold], ['motion', d.motionThreshold]]) {
        if (!Number.isFinite(v)) continue;
        tile.thr[kind].input.value = String(v);
        showThreshold(tile, kind, v);
      }
    }
    tile.motionRow.hidden = d.mode !== 'cam';
    tile.flipBtn.hidden = d.mode !== 'cam';
    tile.flipBtn.disabled = !online;
    if (!online && talk?.deviceId === tile.id) stopTalk();
  }

  function removeTile(tile) {
    if (enlarged === tile) toggleEnlarge(tile);
    if (talk?.deviceId === tile.id) stopTalk();
    for (const pid of [...tile.consumers.keys()]) closeConsumer(tile, pid);
    try {
      tile.gain?.disconnect();
    } catch {
      // ignore
    }
    tile.el.remove();
    tiles.delete(tile.id);
  }

  function toggleEnlarge(tile) {
    const prev = enlarged;
    if (prev) {
      prev.el.classList.remove('enlarged');
      setVideoLayer(prev, 0);
      enlarged = null;
      document.body.classList.remove('has-enlarged');
      updateFocus();
    }
    if (prev !== tile) {
      enlarged = tile;
      tile.el.classList.add('enlarged');
      document.body.classList.add('has-enlarged');
      setVideoLayer(tile, 1);
    }
  }

  function setVideoLayer(tile, layer) {
    for (const c of tile.consumers.values()) {
      if (c.kind === 'video') media.setLayer(c, layer);
    }
  }

  // ---------- push to talk ----------

  function bindTalk(tile) {
    const btn = tile.talkBtn;
    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      startTalk(tile);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      btn.addEventListener(ev, () => stopTalk());
    }
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        startTalk(tile);
      }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') stopTalk();
    });
  }

  async function startTalk(tile) {
    if (talk || !hub.connected) return;
    const s = { deviceId: tile.id, tile, stopped: false, stream: null, transport: null, producer: null };
    talk = s;
    tile.talkBtn.classList.add('talking');
    tile.talkBtn.textContent = t('talking');
    toast.textContent = '';
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (s.stopped) return cleanupTalk(s);
      s.transport = await media.createTransport('send');
      if (s.stopped) return cleanupTalk(s);
      s.producer = await s.transport.produce({
        track: s.stream.getAudioTracks()[0],
        appData: { source: 'talk', target: tile.id },
      });
      if (s.stopped) cleanupTalk(s);
    } catch (e) {
      console.warn('talk failed', e);
      if (!s.stopped) toast.textContent = t('talkFailed', { msg: errMsg(e) });
      stopTalk();
    }
  }

  function stopTalk() {
    const s = talk;
    if (!s) return;
    talk = null;
    s.stopped = true;
    s.tile.talkBtn.classList.remove('talking');
    s.tile.talkBtn.textContent = t('talk');
    cleanupTalk(s);
  }

  function cleanupTalk(s) {
    if (s.producer) {
      const producerId = s.producer.id;
      s.producer.close();
      s.producer = null;
      if (hub.connected) hub.request('closeProducer', { producerId }).catch(() => {});
    }
    s.transport?.close();
    s.transport = null;
    s.stream?.getTracks().forEach((tr) => tr.stop());
    s.stream = null;
  }

  // ---------- alarms ----------

  function renderAlarms() {
    const items = [];
    if (hub.stale && !localAcked) {
      items.push(banner(t('connLost'), () => {
        localAcked = true;
        renderAlarms();
      }));
    }
    for (const a of alarms.values()) {
      items.push(banner(t('alarmOffline', { name: a.name || '?', time: clock(a.since) }), (btn) => {
        btn.disabled = true;
        hub.request('ackAlarm', { alarmId: a.alarmId })
          .then(() => {
            alarms.delete(a.alarmId);
            renderAlarms();
          })
          .catch(() => {
            btn.disabled = false;
          });
      }));
    }
    banners.replaceChildren(...items);
    tone.set(items.length > 0);
  }

  function banner(text, onAck) {
    const btn = h('button', { type: 'button', class: 'ack' }, t('ack'));
    btn.addEventListener('click', () => onAck(btn));
    return h('div', { class: 'banner' }, h('span', null, text), btn);
  }

  // ---------- lifecycle ----------

  async function logout() {
    if (hub.connected) await hub.request('leave').catch(() => {});
    destroy();
    nav.logout();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    gen++;
    hub.stop();
    resetMedia();
    for (const tile of [...tiles.values()]) removeTile(tile);
    tone.set(false);
    clearInterval(clockTimer);
    clearTimeout(focusTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    ctx?.removeEventListener('statechange', updateSoundHint);
    banners.remove();
    document.body.classList.remove('has-enlarged');
  }
}

function clampVol(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : 100;
}
