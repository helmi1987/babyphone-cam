// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

import * as mediasoup from 'mediasoup';
import { config, log } from './config.js';

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
];

export class Media {
  async start() {
    this.worker = await mediasoup.createWorker({ logLevel: 'warn' });
    this.worker.on('died', (err) => {
      log(`media: mediasoup worker died (${err?.message || 'unknown'}), exiting`);
      process.exit(1);
    });
    this.router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const listen = (protocol) => ({ protocol, ip: '0.0.0.0', announcedAddress: config.announcedIp, port: config.rtcPort });
    this.webRtcServer = await this.worker.createWebRtcServer({ listenInfos: [listen('udp'), listen('tcp')] });
    log(`media: WebRtcServer on ${config.rtcPort} udp+tcp, announced ${config.announcedIp}`);
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  async createTransport(appData) {
    return this.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1500000,
      appData,
    });
  }

  canConsume(producerId, rtpCapabilities) {
    try {
      return this.router.canConsume({ producerId, rtpCapabilities });
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.worker?.close();
    } catch { /* ignore */ }
  }
}
