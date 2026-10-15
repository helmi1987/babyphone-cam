#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Stefan Diethelm
# Started as root: make DATA_DIR writable for PUID:PGID, then drop to that user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-99}"
  PGID="${PGID:-100}"
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ]; then
    echo "entrypoint: chown $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups node /app/server/index.js
fi
exec node /app/server/index.js
