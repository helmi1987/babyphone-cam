# babyphone-cam – product website (branch `webpage`)

Static website for https://babyphone.helminet.ch. This branch contains only
the website; the application lives on `main`.

## Deploy on Plesk (Git integration, auto-pull)

1. Plesk → **Websites & Domains** → the domain → **Git**.
2. Add a **remote** repository: `https://github.com/helmi1987/babyphone-cam.git`
3. Branch: `webpage`
4. Deployment mode: **Automatic**
5. Deployment path: `/httpdocs`
6. Optional, for an immediate pull on every push: copy the **Webhook URL**
   shown by Plesk in the repository settings and add it in GitHub under
   Settings → Webhooks (content type `application/json`, event "Just the push
   event").

Requirements on the server: Apache with `.htaccess` enabled (Plesk default,
Apache + nginx). `mod_rewrite`, `mod_headers` and `mod_expires` are used when
present.

Notes:

- HTTPS redirect is commented out in `.htaccess`. Enable it once the
  Let's Encrypt certificate for the domain is issued.
- If nginx serves static files directly ("Smart static files processing" /
  "Serve static files directly by nginx"), the Apache rules for those file
  types are bypassed. To keep `/_src/` and this README private in that case,
  add to *Apache & nginx Settings → Additional nginx directives*:
  `location ~ ^/(_src/|README\.md|\.) { deny all; }`
  (adjust if `/.well-known/` must stay reachable).

## Structure

```
index.html          language picker (JS redirect, fallback links)
de/ en/ it/ fr/     one full HTML page per language (generated)
assets/css|js|img   shared assets; img/shots = screenshots of the real app
sitemap.xml         with hreflang alternates (generated)
robots.txt, .htaccess, favicon.ico
_src/               generator + translations (not served, denied by .htaccess)
```

## Edit content

Texts are in `_src/i18n.json`, markup in `_src/build.mjs`. After a change:

```
node _src/build.mjs
```

and commit the regenerated `*/index.html` and `sitemap.xml` (the server does
not build anything).

Screenshots were taken from the real app with test PINs; the children in the
camera images are SVG illustrations (`assets/img/baby.svg`,
`assets/img/toddler.svg`) used as fake camera input.

Licence: AGPL-3.0-only, © 2026 Stefan Diethelm.
