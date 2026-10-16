# babyphone-cam

Browser-only baby monitor for your home network (LAN or VPN). No app, no
cloud, no account. Any current browser with camera or microphone works as the
child unit (iPhone, iPad, Android, laptop with webcam); any browser as the
parent unit. One Docker container; video and sound run through it, nothing is
recorded.

- **Kind (child):** name from a list or free, mode **Cam** (video + sound) or
  **Phone** (sound only). After start a preview shows the camera for
  positioning (camera can be switched); a tap or 1 min without touch turns the
  screen black. The page is kept awake.
- **Eltern (parents):** all active children at once, green frame on sound or
  motion, volume per child, push-to-talk per child, alarm with tone when a
  child unit drops out (must be confirmed), webhooks (Gotify, Slack, Bark, …).
- Three PINs: parents, child units and admin (settings page).
- Only answers clients from private networks and local host names.

Design: [docs/CONCEPT.md](docs/CONCEPT.md).

## Install (Unraid, Compose Manager Plus)

1. New stack, paste [compose/compose.yaml](compose/compose.yaml); `.env` tab
   from [compose/.env.example](compose/.env.example).
2. Set at least `BABYPHONE_IP` (and `CERTS_DIR` for HTTPS option A).
3. Start. Open `http://<IP>/` (or `https://<name or IP>/`); the first-start
   wizard asks for the rest and then switches to HTTPS.

The image is built by GitHub Actions: `ghcr.io/helmi1987/babyphone-cam`
(`latest` = main, version tags, branch names). If the package is private, make
it public in GitHub (Packages → Package settings) or `docker login ghcr.io`.
The image is rebuilt every Monday with the newest base image and Debian
security updates; Dependabot opens weekly PRs for npm packages and Actions.

## Einstellungen

Everything except infrastructure is set in the browser:

- **First start:** while the parent or child PIN is missing, every page shows
  a wizard (language, welcome, PINs, child names, HTTPS, alarms and
  detection, webhooks, summary). Parent and child pages stay closed until it is saved.
  There is no extra protection code: run the first start in a trusted network.
  Before a trusted certificate exists the wizard also works over plain
  `http://<IP>/` (only the wizard; the page shows "Unverschlüsselte
  Verbindung"). The PINs then travel unencrypted through the LAN. After
  saving, the page switches to HTTPS (the server restarts first when the
  certificate source changed) and HTTP only redirects to HTTPS.
  While setup is open the wizard works on any address (IP or DNS name); the
  DNS name used is added to `HOSTS` on save.
- **App address (`BASE_URL`):** optional, e.g. `https://baby.example.ch`
  (wizard HTTPS step or Einstellungen → HTTPS; ENV `BASE_URL` as start
  value). After setup every HTTP request and every page opened over HTTPS on
  another address (e.g. the IP) is redirected there (302). The API keeps
  working on the IP. **If the address is wrong:** open
  `https://<IP>/?nobase` (skips the redirect once), sign in under
  Einstellungen and correct it. Changing the ENV value does not help once a
  value is saved (the saved value wins); last resort: delete `BASE_URL` from
  `DATA_DIR/settings.json` and restart the container.
- **Later:** start page → **Einstellungen** → admin PIN. All settings grouped
  like the wizard plus network (without an admin PIN yet: "Admin-PIN
  festlegen" with the parent PIN); each shows where its value comes from (web UI,
  ENV start value or default). Secrets (PINs, Cert Warden API keys, webhook
  URLs and headers) are never sent to the browser: empty field = unchanged.
- Saved in `DATA_DIR/settings.json` (0600, PINs as scrypt hashes). A value
  saved there wins over ENV; ENV only gives start values. Every save (and setting
  the admin PIN) copies all values still coming from ENV into settings.json,
  so the ENV variables can be removed afterwards.
- Most changes apply at once (a changed PIN signs that role out). Ports,
  announced IP and the certificate source need a restart: the page offers a
  button; the container restarts through its restart policy.
- **Language:** `APP_LANGUAGE` = `auto` (default: each device uses its
  browser language if it is German, English, Italian or French, otherwise
  English) or a fixed `de`, `en`, `it`, `fr` for all devices. Chosen in the
  first wizard step and under Einstellungen → Allgemein; also settable as ENV
  start value.
- Only ENV / compose: `DATA_DIR`, `CERTS_DIR`, `PUID`, `PGID`, `TZ`
  (shown read-only).

## HTTPS is required

Browsers only allow camera and microphone on HTTPS. Use a real certificate for
a name in your domain that resolves to `BABYPHONE_IP` in your LAN:

- **A – folder:** mount the certificate folder (e.g. Nginx Proxy Manager's
  `letsencrypt`) read-only; the newest matching `fullchain.pem`/`privkey.pem`
  is used and reloaded when renewed. Or set the certificate and key files.
  Note: Nginx Proxy Manager keeps private keys root-only (0600), while the
  container runs as `PUID`, so reading `privkey.pem` may fail with `EACCES`.
  The log names each skipped folder and why (`permission denied`,
  `certificate has expired`, `key and certificate do not belong together`,
  `no fullchain.pem/privkey.pem`). Then use Cert Warden instead (B).
- **B – Cert Warden:** address, certificate name and both API keys in the
  settings ("Test" checks them). Fetched and renewed by the container.

Without either, a self-signed certificate is used (browser warning).

## Ports

| Port | Use |
|---|---|
| 443/tcp | Web page, WebSocket |
| 80/tcp | Redirect to HTTPS (or `BASE_URL`); first-start wizard only while setup is open |
| 40000/udp + tcp | Media (`RTC_PORT`) |

Over WireGuard the VPN subnet must be routed to the LAN.

## Limits

- Child unit: keep the page in the foreground and the screen unlocked, on
  power. Locking the device or switching apps stops camera and microphone
  (iOS, Android).
- Home screen app: the start screen offers "Als App auf den Home-Bildschirm"
  (install dialog in Chrome/Edge/Android, step hint on iPhone/iPad); hidden when
  already running as an app.
- Parent unit: the page keeps the screen on (Wake Lock) while it is open.
  iPhone (Home Screen app, user test): sound keeps playing with the screen
  locked; the audio indicator shows the app icon. Other platforms not tested;
  use webhooks for alerts when no parent page is open.
- LCD screens keep their backlight; only OLED goes truly dark.

## Licence

AGPL-3.0-only — Copyright (C) 2026 Stefan Diethelm. Certificate handling
follows [dropnook](https://github.com/dropnook/dropnook.app) (AGPL-3.0).
