// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Diethelm
//
// Static site generator for the babyphone-cam product page.
// Usage (from the branch root): node _src/build.mjs
// Reads _src/i18n.json and writes {de,en,it,fr}/index.html and sitemap.xml.
// No dependencies; output is plain HTML that the web server serves as-is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '..');
const SITE = 'https://babyphone.helminet.ch';
const REPO = 'https://github.com/helmi1987/babyphone-cam';
const LANGS = ['de', 'en', 'it', 'fr'];
const T = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n.json'), 'utf8'));

// Shot sizes (must match assets/img/shots/*.webp)
const SHOT_SIZE = {
  parent: [1280, 800], enlarged: [1280, 800], 'parent-phone': [390, 844],
  start: [780, 1688], child: [780, 1688], 'child-running': [780, 1688],
  wizard: [680, 484], settings: [680, 800],
};
const PHONE = new Set(['parent-phone', 'start', 'child', 'child-running']);

// Text escaping. Strings in i18n.json are plain text unless the key is known to carry markup (steps).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Small line icons (24x24, stroke = currentColor)
const ICONS = {
  roles: '<rect x="3" y="4" width="7" height="13" rx="1.5"/><rect x="14" y="7" width="7" height="13" rx="1.5"/><path d="M6.5 14h0M17.5 17h0"/>',
  cam: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  wave: '<path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-1.5"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0"/>',
  talk: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
  focus: '<path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16"/><circle cx="12" cy="12" r="3.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  shield: '<path d="M12 2.5 4 5.5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
};
const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// Device glyphs for the diagram
const phoneGlyph = (x, y, cam) => `<g transform="translate(${x} ${y})"><rect x="-22" y="-38" width="44" height="76" rx="8" class="d-dev"/><rect x="-16" y="-28" width="32" height="52" rx="3" class="d-screen"/>${cam ? '<circle cx="0" cy="-33" r="2.5" class="d-accent"/><path d="M-9 0q4-6 9 0t9 0" class="d-wave"/>' : '<path d="M-9 -8h18M-9 0h18M-9 8h12" class="d-line"/>'}</g>`;
const laptopGlyph = (x, y) => `<g transform="translate(${x} ${y})"><rect x="-34" y="-26" width="68" height="44" rx="5" class="d-dev"/><rect x="-28" y="-20" width="56" height="32" rx="2" class="d-screen"/><path d="M-44 22h88" class="d-dev-stroke"/><rect x="-24" y="-16" width="22" height="12" rx="1.5" class="d-tile-on"/><rect x="2" y="-16" width="22" height="12" rx="1.5" class="d-tile"/><rect x="-24" y="-1" width="22" height="10" rx="1.5" class="d-tile"/></g>`;
const serverGlyph = (x, y) => `<g transform="translate(${x} ${y})"><rect x="-38" y="-30" width="76" height="60" rx="8" class="d-server"/><path d="M-26 -12h36M-26 0h44M-26 12h28" class="d-line-inv"/><circle cx="26" cy="-12" r="3.5" class="d-accent"/></g>`;
const arrowDefs = (id) => '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="d-arrowhead"/></marker></defs>';

function diagramWide(d) {
  return `<svg class="diagram diagram-wide" viewBox="0 0 960 380" role="img" aria-labelledby="dg-t dg-d">
<title id="dg-t">${esc(d.title)}</title><desc id="dg-d">${esc(d.desc)}</desc>${arrowDefs('ahw')}
<rect x="20" y="40" width="920" height="320" rx="22" class="d-zone"/>
<text x="44" y="72" class="d-zone-label">${esc(d.zone)}</text>
<g class="d-cloud" transform="translate(860 40)"><path d="M-40 4a16 16 0 0 1 10-26 22 22 0 0 1 40-6 15 15 0 0 1 22 18 12 12 0 0 1-4 14z" /><path d="M-44 -30 34 12" class="d-cross"/><text x="-4" y="30" text-anchor="middle" class="d-small">${esc(d.cloud)}</text></g>
${phoneGlyph(150, 190, true)}
<text x="150" y="268" text-anchor="middle" class="d-h">${esc(d.child)}</text>
<text x="150" y="290" text-anchor="middle" class="d-small">${esc(d.childSub)}</text>
${serverGlyph(480, 186)}
<text x="480" y="252" text-anchor="middle" class="d-h">${esc(d.server)}</text>
<text x="480" y="272" text-anchor="middle" class="d-mono">${esc(d.serverSub)}</text>
${d.serverLines.map((l, i) => `<text x="480" y="${296 + i * 20}" text-anchor="middle" class="d-small">${esc(l)}</text>`).join('')}
${laptopGlyph(790, 170)}${phoneGlyph(850, 196, false)}
<text x="810" y="268" text-anchor="middle" class="d-h">${esc(d.parents)}</text>
<text x="810" y="290" text-anchor="middle" class="d-small">${esc(d.parentsSub)}</text>
<path d="M200 176H412" class="d-arrow" marker-end="url(#ahw)"/>
<text x="306" y="164" text-anchor="middle" class="d-small">${esc(d.arrow1)}</text>
<path d="M548 176H732" class="d-arrow" marker-end="url(#ahw)"/>
<text x="640" y="164" text-anchor="middle" class="d-small">${esc(d.arrow2)}</text>
<path d="M732 212H548" class="d-arrow-back" marker-end="url(#ahw)"/>
<path d="M412 212H200" class="d-arrow-back" marker-end="url(#ahw)"/>
<text x="650" y="238" text-anchor="middle" class="d-small">${esc(d.back)}</text>
</svg>`;
}

function diagramTall(d) {
  return `<svg class="diagram diagram-tall" viewBox="0 0 340 690" role="img" aria-labelledby="dgm-t dgm-d">
<title id="dgm-t">${esc(d.title)}</title><desc id="dgm-d">${esc(d.desc)}</desc>${arrowDefs('aht')}
<rect x="8" y="8" width="324" height="674" rx="20" class="d-zone"/>
<text x="26" y="38" class="d-zone-label">${esc(d.zone)}</text>
${phoneGlyph(90, 110, true)}
<text x="130" y="104" class="d-h">${esc(d.child)}</text>
<text x="130" y="126" class="d-small">${esc(d.childSub)}</text>
<path d="M150 158V250" class="d-arrow" marker-end="url(#aht)"/>
<text x="162" y="210" class="d-small">${esc(d.arrow1)}</text>
${serverGlyph(90, 310)}
<text x="148" y="290" class="d-h">${esc(d.server)}</text>
<text x="148" y="310" class="d-mono">${esc(d.serverSub)}</text>
${d.serverLines.map((l, i) => `<text x="148" y="${332 + i * 20}" class="d-small">${esc(l)}</text>`).join('')}
<path d="M150 400V478" class="d-arrow" marker-end="url(#aht)"/>
<text x="162" y="436" class="d-small">${esc(d.arrow2)}</text>
<path d="M70 478V400" class="d-arrow-back" marker-end="url(#aht)"/>
${laptopGlyph(130, 530)}${phoneGlyph(196, 546, false)}
<text x="170" y="616" text-anchor="middle" class="d-h">${esc(d.parents)}</text>
<text x="170" y="638" text-anchor="middle" class="d-small">${esc(d.parentsSub)}</text>
<text x="170" y="664" text-anchor="middle" class="d-small d-muted">${esc(d.cloud)}</text>
</svg>`;
}

// Compose snippet (shortened from compose/compose.yaml of the main branch)
const COMPOSE = `services:
  babyphone:
    image: ghcr.io/helmi1987/babyphone-cam:latest
    container_name: babyphone
    restart: unless-stopped
    environment:
      - TZ=Europe/Zurich
      - CERTS_DIR=/certs
      - ANNOUNCED_IP=192.168.1.30
    volumes:
      - /mnt/user/appdata/babyphone:/data
      - /mnt/user/appdata/Nginx-Proxy-Manager-Official/letsencrypt:/certs:ro
    networks:
      br0:
        ipv4_address: 192.168.1.30

networks:
  br0:
    external: true`;

function shotFigure(t, s, i) {
  const file = `../assets/img/shots/${s.img}-${t.shots}.webp`;
  const [w, h] = SHOT_SIZE[s.img];
  const cls = PHONE.has(s.img) ? 'shot shot-phone' : 'shot shot-wide';
  return `<figure class="${cls}">
          <a class="zoom" href="${file}" aria-label="${esc(t.zoom)}: ${esc(s.cap)}"><img src="${file}" width="${w}" height="${h}" alt="${esc(s.alt)}" loading="${i < 1 ? 'eager' : 'lazy'}" decoding="async"></a>
          <figcaption>${esc(s.cap)}</figcaption>
        </figure>`;
}

function page(lang) {
  const t = T[lang];
  const url = `${SITE}/${lang}/`;
  const alternates = LANGS.map((l) => `  <link rel="alternate" hreflang="${l}" href="${SITE}/${l}/">`).join('\n')
    + `\n  <link rel="alternate" hreflang="x-default" href="${SITE}/en/">`;
  const switcher = LANGS.map((l) => `<li><a href="../${l}/" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="page"' : ''}>${l.toUpperCase()}<span class="sr-only"> – ${esc(T[l].name)}</span></a></li>`).join('');
  const navItems = ['features', 'how', 'screens', 'privacy', 'install', 'faq']
    .map((k) => `<li><a href="#${k}">${esc(t.nav[k])}</a></li>`).join('');
  const heroShot = `../assets/img/shots/parent-${t.shots}.webp`;
  const wideShots = t.shotsList.filter((s) => !PHONE.has(s.img));
  const phoneShots = t.shotsList.filter((s) => PHONE.has(s.img));

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(t.description)}">
  <link rel="canonical" href="${url}">
${alternates}
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#121735">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="babyphone-cam">
  <meta property="og:title" content="${esc(t.title)}">
  <meta property="og:description" content="${esc(t.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:locale" content="${t.locale}">
${LANGS.filter((l) => l !== lang).map((l) => `  <meta property="og:locale:alternate" content="${T[l].locale}">`).join('\n')}
  <meta property="og:image" content="${SITE}/assets/img/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="babyphone-cam">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="../favicon.ico" sizes="any">
  <link rel="icon" href="../assets/img/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../assets/img/apple-touch-icon.png">
  <link rel="stylesheet" href="../assets/css/site.css">
  <script src="../assets/js/site.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">${esc(t.skip)}</a>
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand" href="./"><img src="../assets/img/icon.svg" width="36" height="36" alt=""><span>babyphone-cam</span></a>
      <nav class="main-nav" aria-label="${esc(t.title.split(' – ')[0])}">
        <ul>${navItems}</ul>
      </nav>
      <nav class="lang" aria-label="${esc(t.langLabel)}">
        <ul>${switcher}</ul>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="stars" aria-hidden="true"></div>
      <div class="wrap hero-grid">
        <div class="hero-text">
          <h1 id="hero-title"><img class="hero-logo" src="../assets/img/icon.svg" width="72" height="72" alt="">babyphone-cam</h1>
          <p class="claim">${esc(t.claim)}</p>
          <p class="sub">${esc(t.sub)}</p>
          <p class="cta">
            <a class="btn btn-primary" href="#install">${esc(t.ctaInstall)}</a>
            <a class="btn btn-ghost" href="${REPO}" rel="noopener">${esc(t.ctaGithub)}</a>
          </p>
          <ul class="badges">${t.badges.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        </div>
        <div class="hero-shot">
          <img src="${heroShot}" width="1280" height="800" alt="${esc(t.heroAlt)}" fetchpriority="high">
        </div>
      </div>
      <svg class="hero-waves" viewBox="0 0 1440 80" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 40c120-30 240-30 360 0s240 30 360 0 240-30 360 0 240 30 360 0v40H0z"/></svg>
    </section>

    <section id="features" class="section" aria-labelledby="features-title">
      <div class="wrap">
        <h2 id="features-title">${esc(t.featuresTitle)}</h2>
        <p class="lead">${esc(t.featuresIntro)}</p>
        <ul class="features">
${t.features.map((f) => `          <li class="card">${icon(f.icon)}<h3>${esc(f.t)}</h3><p>${esc(f.d)}</p></li>`).join('\n')}
        </ul>
      </div>
    </section>

    <section id="how" class="section alt" aria-labelledby="how-title">
      <div class="wrap">
        <h2 id="how-title">${esc(t.howTitle)}</h2>
        <p class="lead">${esc(t.howIntro)}</p>
        <div class="diagram-box">
          ${diagramWide(t.diagram)}
          ${diagramTall(t.diagram)}
        </div>
      </div>
    </section>

    <section id="screens" class="section" aria-labelledby="screens-title">
      <div class="wrap">
        <h2 id="screens-title">${esc(t.screensTitle)}</h2>
        <p class="lead">${esc(t.screensNote)}</p>
        <div class="shots shots-wide">
        ${wideShots.map((s, i) => shotFigure(t, s, i + 1)).join('\n        ')}
        </div>
        <div class="shots shots-phone">
        ${phoneShots.map((s, i) => shotFigure(t, s, i + 1)).join('\n        ')}
        </div>
      </div>
    </section>

    <section id="privacy" class="section alt" aria-labelledby="privacy-title">
      <div class="wrap">
        <h2 id="privacy-title">${esc(t.privacyTitle)}</h2>
        <ul class="privacy">
${t.privacy.map((p) => `          <li>${icon('shield')}<div><h3>${esc(p.t)}</h3><p>${esc(p.d)}</p></div></li>`).join('\n')}
        </ul>
      </div>
    </section>

    <section id="install" class="section" aria-labelledby="install-title">
      <div class="wrap install-grid">
        <div>
          <h2 id="install-title">${esc(t.installTitle)}</h2>
          <ol class="steps">
${t.steps.map((s) => `            <li>${s}</li>`).join('\n')}
          </ol>
          <h3 id="req-title">${esc(t.reqTitle)}</h3>
          <ul class="req">
${t.req.map((r) => `            <li>${esc(r)}</li>`).join('\n')}
          </ul>
        </div>
        <div>
          <p class="note">${esc(t.installIntro)}</p>
          <pre class="code" tabindex="0"><code><span class="c"># compose.yaml</span>
${esc(COMPOSE)}</code></pre>
          <p><a href="${REPO}/blob/main/compose/compose.yaml" rel="noopener">${esc(t.fullFile)}</a></p>
        </div>
      </div>
    </section>

    <section id="faq" class="section alt" aria-labelledby="faq-title">
      <div class="wrap narrow">
        <h2 id="faq-title">${esc(t.faqTitle)}</h2>
${t.faq.map((f) => `        <details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n')}
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap footer-row">
      <p><img src="../assets/img/icon.svg" width="24" height="24" alt=""> © 2026 Stefan Diethelm · <a href="${REPO}/blob/main/LICENSE" rel="noopener">${esc(t.footerLicense)}</a> · <a href="${REPO}" rel="noopener">${esc(t.footerSource)}</a></p>
      <!-- IMPRESSUM PLACEHOLDER: add a link to the legal notice / Impressum page here once it exists. No personal data is invented on this site. -->
      <p class="muted">${esc(t.footerNote)}</p>
      <p><a href="#main">${esc(t.top)} ↑</a></p>
    </div>
  </footer>

  <dialog class="lightbox" aria-label="${esc(t.zoom)}">
    <form method="dialog"><button class="lb-close" type="submit" aria-label="${esc(t.close)}">×</button></form>
    <img alt="">
  </dialog>
</body>
</html>
`;
}

for (const lang of LANGS) {
  fs.mkdirSync(path.join(ROOT, lang), { recursive: true });
  fs.writeFileSync(path.join(ROOT, lang, 'index.html'), page(lang));
}

// sitemap.xml with hreflang alternates
const alt = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE}/${l}/"/>`).join('\n')
  + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/en/"/>`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map((l) => `  <url>\n    <loc>${SITE}/${l}/</loc>\n${alt}\n  </url>`).join('\n')}
</urlset>
`);
console.log('built', LANGS.join(', '));
