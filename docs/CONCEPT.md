# babyphone-cam — concept and protocol

Browser-only baby monitor for the home network (LAN / WireGuard). One Docker
container: HTTPS, PIN login, WebSocket hub, mediasoup SFU. All media goes
through the container, never device to device. Live only, nothing is stored.

Licence: AGPL-3.0-only, Copyright (C) 2026 Stefan Diethelm. Certificate logic
follows dropnook (AGPL-3.0, github.com/dropnook/dropnook.app).

## Stack

- Node.js 22, ES modules, no framework: `node:https`, `ws`, `mediasoup` 3.x,
  `selfsigned` (fallback certificate only).
- Browser: plain HTML/CSS/JS, `mediasoup-client` bundled with esbuild at image
  build time into `public/app.js`. No CDN, no internet needed at runtime.
- Image built by GitHub Actions, pushed to `ghcr.io/helmi1987/babyphone-cam`.

## Layout

```
server/config.js     env parsing + validation (exit on missing PINs)
server/certs.js      TLS: CertWarden | TLS_CERT/TLS_KEY | CERTS_DIR scan | self-signed
server/security.js   IP allowlist, host check, PIN login, signed cookie, rate limit
server/media.js      mediasoup worker, router, WebRtcServer (one port udp+tcp)
server/hub.js        WebSocket: devices, presence, activity, alarms, signalling
server/webhooks.js   WEBHOOK_n_* sender
server/index.js      HTTPS server, static files, /api/*, /ws upgrade
public/index.html, public/style.css
public/src/*.js      browser sources -> esbuild -> public/app.js
```

## Environment

Settings live in `DATA_DIR/settings.json` (0600) and are edited in the web UI
(first-start wizard, admin page). Effective value = settings.json ?? ENV ??
default; ENV is only the start value, empty ENV = unset. PINs are stored as
scrypt hashes; ENV PINs are hashed in memory at start. Infrastructure is ENV
only: `DATA_DIR`, `CERTS_DIR`, `PUID`, `PGID`, `TZ`, `WEBHOOK_TEST`.
Invalid ENV values stop the start unless settings.json overrides them.
Every save copies values whose source is still ENV (PINs as hash) into
settings.json, so ENV can be removed afterwards.
Restart needed for: ports, `ANNOUNCED_IP`, `TLS_SOURCE`, Cert Warden and
`TLS_CERT`/`TLS_KEY`; everything else applies live.

| Variable | Default | Meaning |
|---|---|---|
| `APP_LANGUAGE` | `auto` | App language on all devices: `auto`, `de`, `en`, `it`, `fr`. `auto` = per device first match of `navigator.languages` (`gsw` counts as `de`), else English. Live |
| `ADMIN_PIN` | empty | PIN for the admin page (settings) |
| `PARENT_PIN` | empty | PIN for parents; missing parent or child PIN = setup mode |
| `CHILD_PIN` | empty | PIN for child devices; all three PINs must differ |
| `TLS_SOURCE` | `auto` | `auto`, `certwarden`, `folder` (skip Cert Warden), `selfsigned` |
| `CHILD_NAMES` | empty | Fixed names, comma-separated; free name always possible |
| `ALLOWED_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,100.64.0.0/10,::1/128,fc00::/7,fe80::/10` | Client IPs allowed (HTTP, WS). IPv4-mapped IPv6 normalised |
| `HOSTS` | empty | Extra host names accepted, comma-separated, `*.example.org` allowed |
| `HTTPS_PORT` | `443` | |
| `HTTP_PORT` | `80` | Redirect to HTTPS (setup mode: wizard over HTTP); `0` = off |
| `RTC_PORT` | `40000` | mediasoup WebRtcServer, UDP and TCP |
| `ANNOUNCED_IP` | auto | IP given to browsers for media; auto = first non-internal IPv4 of the container |
| `DATA_DIR` | `/data` | Cookie secret, CertWarden cache |
| `TLS_CERT`, `TLS_KEY` | empty | Explicit paths of fullchain / private key |
| `CERTS_DIR` | `/certs` | Scanned for `live/*/` and `*/` holding `fullchain.pem` + `privkey.pem` (NPM letsencrypt folder) |
| `CERTWARDEN_ENDPOINT_URL` | empty | Cert Warden address; any form (`https://host:4050`, `…/certwarden/app/`, `…/certwarden/api/v1/download`) |
| `CERT_NAME`, `CERT_CERT_API`, `CERT_KEY_API` | empty | Certificate name in Cert Warden, API key of cert, API key of private key |
| `CERT_CHECK_DAY` | `30` | Refetch when fewer days left; checked at start and every 6 h |
| `HEARTBEAT_TIMEOUT` | `20` | s without heartbeat = device offline (min 15; clients beat every 5 s) |
| `ALARM_DELAY` | `30` | s offline before alarm / webhook |
| `OFFLINE_TIMEOUT` | `600` | s offline before a child disappears from the list |
| `ALARM_UNACKED_DELAY` | `60` | s an alarm stays unacknowledged before webhook `alarm_unacked` |
| `SOUND_THRESHOLD` | `25` | 0–100, default sound level that counts as activity; parents can change it per child |
| `MOTION_THRESHOLD` | `4` | % of changed pixels that counts as motion |
| `WEBHOOK_<n>_URL` | empty | n = 1..5 |
| `WEBHOOK_<n>_METHOD` | `POST` | GET, POST, PUT |
| `WEBHOOK_<n>_HEADERS` | empty | `Name: value` pairs separated by `\|` |
| `WEBHOOK_<n>_BODY` | empty | Body template (POST/PUT) |
| `WEBHOOK_<n>_EVENTS` | all | Comma list of events |
| `TZ` | UTC | Log time stamps |

TLS order: CertWarden (if `CERTWARDEN_ENDPOINT_URL` set) -> `TLS_CERT`/`TLS_KEY`
-> `CERTS_DIR` scan (longest valid certificate; SNI by name if several) ->
self-signed (log warning). Reload without restart via
`server.setSecureContext()`; files polled every 5 min.

CertWarden: `GET <base>/certwarden/api/v1/download/privatecertchains/<CERT_NAME>`,
header `X-API-Key: <CERT_CERT_API>.<CERT_KEY_API>`. Response is PEM with key
and chain. Check key matches cert and not expired, store in
`DATA_DIR/.certwarden/{fullchain,privkey}.pem` (0600). Never log keys.

## Access

- Every request: client IP must be in `ALLOWED_CIDRS`, else 403. Host header
  must be an IP, a local name (no dot, or suffix `.local .lan .home
  .home.arpa .internal .fritz.box .ts.net`), a name of the served certificate
  (CN/SAN, wildcard) or in `HOSTS`; else 421 (DNS rebinding).
- Setup mode (parent or child PIN missing): every page request shows the
  wizard, no protection code. `GET /api/setup/state`, `POST /api/setup`,
  `POST /api/setup/test-certwarden`, `POST /api/setup/test-webhook` only
  work now; login and `/ws` answer 503. Saving ends setup and sets the
  admin cookie.
- Plain HTTP (`HTTP_PORT`, and plaintext that arrives on `HTTPS_PORT`: the
  port is a TCP listener that sends a first byte 0x16 to TLS and anything
  else to the HTTP handler; silent connections close after 10 s): in setup
  mode it serves the static files, `/api/config` and `/api/setup*` (same IP
  and host checks, same-origin with `http:` origin); other API paths answer
  403, `/ws` 403. During this first setup the PINs travel unencrypted in the
  LAN. `POST /api/setup` over HTTP sets no cookie and returns `httpsPort` and
  `restarting`; when TLS settings need a restart the server exits 0 after the
  answer (restart policy). The page waits (1.5 s, or 6 s on restart) and goes
  to `https://<host>[:port]/`. Outside setup mode (checked per request) every
  HTTP request gets 301 to `https://<host>[:HTTPS_PORT]<path>`.
- HTTPS same-origin checks require an `https:` origin.
- `POST /api/login` `{role:"parent"|"child"|"admin", pin}` -> cookie
  `bp_session` = `role.issued.hmac`, HttpOnly, Secure, SameSite=Strict, 90
  days; admin gets `bp_admin` (1 h). HMAC key = sha256(secret file in
  DATA_DIR + role PIN hash) so a PIN change signs that role out (open sockets
  are closed). Rate limit: 5 failures / IP / 5 min -> 429 (admin too).
  scrypt verify, constant-time compare.
- `POST /api/logout` clears the cookie; `POST /api/admin/logout` the admin one.
- `GET /api/config` -> `{role|null, admin, adminPin, childNames,
  soundThreshold, motionThreshold, heartbeatTimeout}` or `{setup:true}`.
- Admin cookie: `GET/POST /api/admin/settings` (`{values:{KEY:value}}`,
  unknown keys and invalid values -> 400 with `errors`), `POST
  /api/admin/test-certwarden`, `/api/admin/test-webhook`,
  `/api/admin/restart` (answers, then exits 0). Secrets are never returned;
  `''`/missing = unchanged, `null` = delete (not for PINs). Changing
  `ALLOWED_CIDRS` so that the own IP is locked out is refused.
- `POST /api/admin/claim` `{parentPin, adminPin}`: only while no admin PIN
  exists; parent PIN verified (rate limit), admin PIN stored, admin cookie set.
- All POSTs: same-origin check.
- `/ws` upgrade needs a valid cookie; role comes from the cookie.
- Security headers: CSP `default-src 'self'; media-src 'self' blob:;
  img-src 'self' data: blob:; connect-src 'self' wss:`, no-referrer,
  nosniff, `Permissions-Policy: camera=(self), microphone=(self)`.

## WebSocket protocol (`/ws`, JSON)

Request: `{id, t, ...}` -> reply `{id, ok:true, data}` or `{id, ok:false,
error}`. Push messages have no `id`.

Client -> server (requests):

| t | Fields | Reply data |
|---|---|---|
| `join` | child: `deviceId, name, mode:"cam"\|"phone"`; parent: `deviceId, label?` | `{rtpCapabilities}` |
| `hb` | – | `{now}` (every 5 s) |
| `createTransport` | `direction:"send"\|"recv"` | `{id, iceParameters, iceCandidates, dtlsParameters}` |
| `connectTransport` | `transportId, dtlsParameters` | – |
| `produce` | `transportId, kind, rtpParameters, appData:{source:"cam"\|"mic"\|"talk", target?}` | `{id}` |
| `closeProducer` | `producerId` | – |
| `consume` | `transportId, producerId, rtpCapabilities` | `{id, producerId, kind, rtpParameters}` (created paused) |
| `resumeConsumer` | `consumerId` | – |
| `setLayer` | `consumerId, spatialLayer` (0 low, 1 high) | – |
| `activity` | child only: `sound:bool, motion:bool, level:0..100` | – |
| `ackAlarm` | parent only: `alarmId` | – |
| `setFacing` | child only: `facing:"user"\|"environment"` | – |
| `switchCamera` | parent only: `deviceId` (cam child) | – |
| `setThreshold` | parent only: `deviceId, sound?:0..100, motion?:0..100` (stored in `DATA_DIR/thresholds.json`) | – |
| `leave` | – | – (child: removed at once, no alarm) |

Server -> client (push):

| t | To | Fields |
|---|---|---|
| `devices` | parents | `list:[{deviceId, name, mode, facing, soundThreshold, motionThreshold, online, since, lastSeen, producers:[{id, kind, source}], sound, motion, level}]` (on every change; `level` throttled to 2/s) |
| `alarm` | parents | `{alarmId, deviceId, name, reason:"child_offline", since}` |
| `alarmCleared` | parents | `{alarmId}` (acked by any parent, or child back online) |
| `talk` | one child | `{producerId}` consume and play |
| `talkEnd` | one child | `{producerId}` |
| `switchCamera` | one child | – (flip front/rear, then `setFacing`) |
| `threshold` | one child | `{sound, motion}` (also in `join` reply) |

Media:
- Child cam: video (simulcast 2 layers: `scaleResolutionDownBy:4,
  maxBitrate:150000` and `1, 1200000`) + audio (`source:"mic"`). Child phone:
  audio only.
- Parent: one recv transport, consumes every child producer; tiles use layer
  0, enlarged view layer 1. One send transport only while talking.
- Talk: parent produces audio `appData {source:"talk", target:deviceId}`;
  server pushes `talk` to that child only; push-to-talk (hold button).
- Router codecs: opus 48000/2, VP8, H264 (packetization-mode 1,
  profile-level-id 42e01f) for iOS.

## Presence and alarms

- Device online while WS open and last `hb` < `HEARTBEAT_TIMEOUT`.
- Child goes offline without `leave`: stays in list (`online:false`). After
  `ALARM_DELAY` still offline -> `alarm` to parents + webhook `child_offline`.
  Back online with same `deviceId` -> `alarmCleared`, webhook `child_online`.
  After `OFFLINE_TIMEOUT` -> removed.
- Alarm not acked after `ALARM_UNACKED_DELAY` -> webhook `alarm_unacked`.
- Parent WS lost without `leave` for `ALARM_DELAY` -> webhook `parent_offline`.
- ≥1 child online and no parent online for `ALARM_DELAY` -> webhook
  `no_parent` (once per period).
- Parent page: no `hb` reply for 15 s -> local alarm tone (WebAudio) +
  banner until reconnected or acked; reconnect with backoff 1–10 s.

## Webhooks

Placeholders in URL, headers and body: `{event} {name} {title} {message}
{time}`; in URL they are URL-encoded, in a body starting with `{` or `[`
JSON-string-escaped. Timeout 10 s, errors logged, no retry.
Events: `child_offline, child_online, alarm_unacked, parent_offline,
no_parent, test`. `test` is sent once at start when `WEBHOOK_TEST=1`.

## Browser UI

- Start: two big buttons Kind / Eltern -> PIN pad -> role page. Languages
  German, English, Italian, French; `APP_LANGUAGE` from `/api/config` is
  applied before the first render (`auto` = browser language, fallback
  English); strings in one table (`public/src/i18n.js`). Running pages pick up
  a changed setting at their next config load (reload, login, reconnect).
- Child: pick name (buttons from `CHILD_NAMES` + text field), mode Cam
  (video+audio, front/back toggle) or Phone (audio only), Start. Then Wake
  Lock (re-request on `visibilitychange`), black fullscreen overlay. Overlay:
  double tap shows a small bar for 5 s with Beenden (sends `leave`) and a
  hint "Bildschirm nicht sperren". Detection runs locally: audio RMS via
  AnalyserNode (every 200 ms), motion via 64x48 canvas frame diff (every
  500 ms, cam only); state held 3 s, sent on change, level every 500 ms.
- Parent: grid of tiles (name, mode, online/offline since, phone active =
  mic producer present). Green border while sound or motion. Video muted
  `<video playsinline>`, audio through WebAudio GainNode per child
  (slider 0–200 %, mute). Level bar. Click tile = enlarged (layer 1).
  Hold "Sprechen" = talk to that child. Alarm banner with tone and
  "Bestätigen". Offline tiles grey with time since.
- The PIN/role click unlocks audio playback (autoplay policy).
- Known limits: iOS/Android stop camera/mic/audio when the page is in the
  background or the screen is locked; LCD backlight cannot be switched off.
