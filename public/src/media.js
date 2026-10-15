// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm

// Thin wrapper around mediasoup-client using the Hub signalling requests.

import { Device } from 'mediasoup-client';

export class Media {
  constructor(hub) {
    this.hub = hub;
    this.device = null;
  }

  // A fresh Device per join: router capabilities may change after a server restart.
  async load(routerRtpCapabilities) {
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    this.device = device;
    return device;
  }

  canProduce(kind) {
    return Boolean(this.device?.loaded && this.device.canProduce(kind));
  }

  async createTransport(direction) {
    const p = await this.hub.request('createTransport', { direction });
    const opts = {
      id: p.id,
      iceParameters: p.iceParameters,
      iceCandidates: p.iceCandidates,
      dtlsParameters: p.dtlsParameters,
    };
    const tr = direction === 'send'
      ? this.device.createSendTransport(opts)
      : this.device.createRecvTransport(opts);
    tr.on('connect', ({ dtlsParameters }, cb, eb) => {
      this.hub.request('connectTransport', { transportId: tr.id, dtlsParameters }).then(() => cb(), eb);
    });
    if (direction === 'send') {
      tr.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
        this.hub
          .request('produce', { transportId: tr.id, kind, rtpParameters, appData })
          .then((d) => cb({ id: d.id }), eb);
      });
    }
    tr.on('connectionstatechange', (state) => {
      if (state === 'failed') console.warn(`transport ${direction} failed`);
    });
    return tr;
  }

  // Consumers are created paused on the server; optional layer is set before resume.
  async consume(transport, producerId, { spatialLayer } = {}) {
    const d = await this.hub.request('consume', {
      transportId: transport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await transport.consume({
      id: d.id,
      producerId: d.producerId,
      kind: d.kind,
      rtpParameters: d.rtpParameters,
    });
    try {
      if (consumer.kind === 'video' && spatialLayer != null) {
        await this.hub.request('setLayer', { consumerId: consumer.id, spatialLayer }).catch(() => {});
      }
      await this.hub.request('resumeConsumer', { consumerId: consumer.id });
    } catch (e) {
      consumer.close();
      throw e;
    }
    return consumer;
  }

  setLayer(consumer, spatialLayer) {
    return this.hub.request('setLayer', { consumerId: consumer.id, spatialLayer }).catch(() => {});
  }
}
