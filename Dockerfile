# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Stefan Diethelm
# Built by .github/workflows/image.yml and pushed to ghcr.io; compose only pulls it.

FROM node:22-bookworm-slim AS build
# Toolchain only needed if mediasoup has no prebuilt worker for this platform
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY server/ server/
COPY public/ public/
RUN npm run build && npm prune --omit=dev && rm -rf public/src

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data CERTS_DIR=/certs
WORKDIR /app
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/public/ public/
COPY server/ server/
COPY package.json LICENSE entrypoint.sh ./
RUN chmod 755 /app/entrypoint.sh && command -v setpriv
EXPOSE 443 80 40000/udp 40000/tcp
# Healthy as soon as the HTTPS port accepts connections
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
  CMD ["node", "-e", "require('net').connect(+process.env.HTTPS_PORT||443,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
