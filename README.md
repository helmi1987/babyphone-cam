# babyphone-cam

Browser-only baby monitor for your home network (LAN or VPN). No app, no
cloud, no account. Any current browser with camera or microphone works as the
child unit (iPhone, iPad, Android, laptop with webcam); any browser as the
parent unit. One Docker container; video and sound run through it, nothing is
recorded.

- **Kind (child):** name from a list or free, mode **Cam** (video + sound) or
  **Phone** (sound only). Screen goes black, the page is kept awake.
- **Eltern (parents):** all active children at once, green frame on sound or
  motion, volume per child, push-to-talk per child, alarm with tone when a
  child unit drops out (must be confirmed), webhooks (Gotify, Slack, Bark, …).
- Two PINs: one for parents, one for child units.
- Only answers clients from private networks and local host names.

Design: [docs/CONCEPT.md](docs/CONCEPT.md).

## Install (Unraid, Compose Manager Plus)

1. New stack, paste [compose/compose.yaml](compose/compose.yaml); `.env` tab
   from [compose/.env.example](compose/.env.example).
2. Set at least `BABYPHONE_IP`, `PARENT_PIN`, `CHILD_PIN` and one HTTPS
   option.
3. Start. Open `https://<name or IP>/`.

The image is built by GitHub Actions: `ghcr.io/helmi1987/babyphone-cam`
(`latest` = main, version tags, branch names). If the package is private, make
it public in GitHub (Packages → Package settings) or `docker login ghcr.io`.
The image is rebuilt every Monday with the newest base image and Debian
security updates; Dependabot opens weekly PRs for npm packages and Actions.

## HTTPS is required

Browsers only allow camera and microphone on HTTPS. Use a real certificate for
a name in your domain that resolves to `BABYPHONE_IP` in your LAN:

- **A – folder:** mount the certificate folder (e.g. Nginx Proxy Manager's
  `letsencrypt`) read-only; the newest matching `fullchain.pem`/`privkey.pem`
  is used and reloaded when renewed. Or set `TLS_CERT`/`TLS_KEY`.
- **B – Cert Warden:** `CERTWARDEN_ENDPOINT_URL`, `CERT_NAME`,
  `CERT_CERT_API`, `CERT_KEY_API`. Fetched and renewed by the container.

Without either, a self-signed certificate is used (browser warning).

## Ports

| Port | Use |
|---|---|
| 443/tcp | Web page, WebSocket |
| 80/tcp | Redirect to HTTPS |
| 40000/udp + tcp | Media (`RTC_PORT`) |

Over WireGuard the VPN subnet must be routed to the LAN.

## Limits

- Child unit: keep the page in the foreground and the screen unlocked, on
  power. Locking the device or switching apps stops camera and microphone
  (iOS, Android).
- Parent unit: the same applies to listening; use webhooks for alerts when no
  parent page is open.
- LCD screens keep their backlight; only OLED goes truly dark.

## Licence

AGPL-3.0-only — Copyright (C) 2026 Stefan Diethelm. Certificate handling
follows [dropnook](https://github.com/dropnook/dropnook.app) (AGPL-3.0).
