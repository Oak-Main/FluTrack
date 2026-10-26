// ===========================================================================
// FluTrack static build. Emits a fully static, Cloudflare-Pages-ready site to
// dist/. Pure Node, no third-party dependencies.
//
//   dist/
//     index.html                     home
//     states/index.html              all-states directory
//     state/<slug>/index.html        51 programmatic state reports
//     <content pages>/index.html     auto-discovered from build/pages/content
//     assets/styles.css              bundled CSS
//     assets/js/*.js                 client ES modules (copied)
//     assets/*                       icons, og image, etc.
//     data/snapshot.json             live CDC snapshot (sample fallback)
//     data/epidemic-trends.json      CDC's COVID-19 Rt categories the pages show
//                                    (only when fetched, valid and the snapshot is live)
//     sitemap.xml, robots.txt, manifest.webmanifest, _headers, _redirects, 404
// ===========================================================================

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { createHash } from 'node:crypto';
import { site, disclaimers } from './lib/site.mjs';
import { states } from './lib/states.mjs';
import { layout, BOOT_SCRIPT } from './lib/layout.mjs';
import { computeModel } from '../src/scripts/model.js';
import { nationalSignals } from '../src/scripts/aggregate.js';
import { threatCard, pathogenTiles, stateChip, signalRows } from '../src/scripts/render.js';
import * as seo from './lib/seo.mjs';
import * as partials from './lib/partials.mjs';
import { generateSnapshot } from './lib/snapshot.mjs';
import { resolveSnapshot, resolveLivePrerenderMode } from './lib/live-snapshot.mjs';
import { resolveEpidemicTrend, planEpidemicTrend, publicEpidemicTrend } from './lib/epidemic-trend.mjs';
import { assetFiles, manifest, icoFromPng, stateOgSvg } from './lib/assets.mjs';
import { extractCritical } from './lib/critical.mjs';
import { shardCrosswalk } from '../src/server/zip-lookup.js';
import { contentHash, writeVersionedScripts } from './lib/versioned-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const srcScripts = resolve(root, 'src/scripts');
const srcStyles = resolve(root, 'src/styles');

function log(msg) {
  console.log(`  ${msg}`);
}

// --- Snapshot ------------------------------------------------------------- //
// The bundled sample: deterministic, labeled "Sample data" wherever it shows.
// Only used when the live CDC pre-render is off or unavailable (see below).
function loadSampleSnapshot() {
  const p = resolve(root, 'src/data/snapshot.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  log('snapshot.json missing — generating');
  const snap = generateSnapshot();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(snap, null, 2));
  return snap;
}

// --- Context -------------------------------------------------------------- //
function buildContext(snapshot) {
  const provenance = {
    kind: snapshot.kind || 'unknown',
    live: snapshot.kind === 'live',
    weekEnding: snapshot.weekEnding,
    observationPeriod: { weekEnding: snapshot.weekEnding },
    generatedAt: snapshot.generatedAt,
    retrievedAt: snapshot.retrievedAt || null,
    sources: snapshot.sources || [],
    coverage: snapshot.coverage || null,
  };
  const models = new Map();
  for (const st of states) {
    const signals = snapshot.states[st.abbr];
    models.set(st.abbr, { model: computeModel(signals, provenance), signals });
  }
  const natSignals = nationalSignals(states.map((s) => snapshot.states[s.abbr]), provenance);
  const national = {
    state: { name: 'United States', abbr: 'US', slug: '' },
    model: computeModel(natSignals, provenance),
    signals: natSignals,
  };
  return {
    site,
    disclaimers,
    states,
    snapshot,
    weekEnding: snapshot.weekEnding,
    provenance,
    models,
    national,
    render: { threatCard, pathogenTiles, stateChip, signalRows },
    seo,
    partials,
  };
}

// --- Writers -------------------------------------------------------------- //
function writePage(page) {
  const html = layout(page);
  let outPath;
  if (page.path === '/') outPath = join(dist, 'index.html');
  else if (page.path.endsWith('.html')) outPath = join(dist, page.path);
  else outPath = join(dist, page.path, 'index.html');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return page.path;
}

// Conservative, safe CSS minifier: strips comments, collapses whitespace, and
// tightens only around { } ; — it never touches ':' or ',' so property values,
// selectors, and the data-URI in .select stay intact.
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function bundleCss() {
  const order = ['tokens.css', 'base.css', 'components.css', 'main.css'];
  const sources = Object.fromEntries(order.map((f) => [f, readFileSync(join(srcStyles, f), 'utf8')]));
  const css = order.map((f) => sources[f]).join('\n');
  const min = minifyCss(css);
  // Content-hash the filename so the immutable cache header is always safe.
  const hash = createHash('sha256').update(min).digest('hex').slice(0, 10);
  const name = `styles.${hash}.css`;
  const out = join(dist, 'assets', name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `/* FluTrack — bundled stylesheet */\n${min}`);

  // Critical CSS for the header and the hero readout, cut from the same
  // sources so it can never drift from the sheet it is a subset of. The token
  // and reset layers go in whole: every above-the-fold rule resolves custom
  // properties against them, and @font-face must be inline for the preloaded
  // fonts to be used.
  const critical = minifyCss(
    [
      extractCritical(sources['tokens.css'], { all: true }),
      extractCritical(sources['base.css'], { all: true }),
      extractCritical(sources['components.css']),
      extractCritical(sources['main.css']),
    ].join('\n')
  );
  site.assets = { ...(site.assets || {}), css: name, critical };
}

function copyScripts() {
  const scripts = writeVersionedScripts(srcScripts, join(dist, 'assets'));
  site.assets = { ...site.assets, js: scripts.path, jsVersion: scripts.version };
}

// JavaScript-only changes must also activate a fresh service-worker cache.
function writeServiceWorker() {
  const version = `${site.assets?.css || 'styles'}-${site.assets?.jsVersion || 'v1'}`.replace(/[^a-z0-9]/gi, '');
  const sw = readFileSync(join(srcScripts, 'sw.js'), 'utf8').replace('__BUILD__', version);
  writeFileSync(join(dist, 'sw.js'), sw);
}

function writeAssets(snapshot) {
  const outDir = join(dist, 'assets');
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(assetFiles(site))) {
    writeFileSync(join(outDir, name), content);
  }
  // Copy committed binary assets (PNG icons, OG card) from src/assets.
  const srcAssets = resolve(root, 'src/assets');
  if (existsSync(srcAssets)) {
    for (const f of readdirSync(srcAssets)) {
      if (/\.(png|ico|webp|jpg|jpeg)$/i.test(f)) cpSync(join(srcAssets, f), join(outDir, f));
    }
    // Font assets stay same-origin to satisfy the production CSP.
    const fonts = join(srcAssets, 'fonts');
    if (existsSync(fonts)) cpSync(fonts, join(outDir, 'fonts'), { recursive: true });
    // Globe geometry (vendored by scripts/vendor-geo.mjs), fetched lazily.
    const geo = join(srcAssets, 'geo');
    if (existsSync(geo)) cpSync(geo, join(outDir, 'geo'), { recursive: true });
    const og = readFileSync(join(srcAssets, 'og-default.png'));
    const ogName = `og-default.${contentHash(og)}.png`;
    writeFileSync(join(outDir, ogName), og);
    site.assets.ogImage = `/assets/${ogName}`;
  }
  // The hashed stylesheet name, for the server-rendered (no-JS) result pages
  // the Pages Functions emit (src/server/page.js).
  writeFileSync(join(outDir, 'build.json'), JSON.stringify({ css: site.assets.css, js: site.assets.js, ogImage: site.assets.ogImage }));
  // Ship exactly the snapshot the pages were rendered from, minified, so the
  // browser's first re-render reproduces the static markup — live data stays
  // live instead of flashing back to the sample.
  const dataOut = join(dist, 'data');
  mkdirSync(dataOut, { recursive: true });
  writeFileSync(join(dataOut, 'snapshot.json'), JSON.stringify(snapshot));

  // ZIP → county lookup shards (/data/zip3/<zip3>.json), the fallback the
  // Functions use until D1's zip_crosswalk is seeded (src/server/zip-lookup.js).
  const crosswalk = resolve(root, 'src/data/zip-county.csv');
  if (existsSync(crosswalk)) {
    const shardDir = join(dataOut, 'zip3');
    mkdirSync(shardDir, { recursive: true });
    for (const [zip3, map] of Object.entries(shardCrosswalk(readFileSync(crosswalk, 'utf8')))) {
      writeFileSync(join(shardDir, `${zip3}.json`), JSON.stringify(map));
    }
  }
}

// The record behind the epidemic-trend blocks, so the figures on the pages can
// be audited against a file (build/check.mjs does exactly that). Written only
// when the pages carry the blocks: no plan, no file.
function writeEpidemicTrend(plan) {
  const record = publicEpidemicTrend(plan);
  if (!record) return;
  const dataOut = join(dist, 'data');
  mkdirSync(dataOut, { recursive: true });
  writeFileSync(join(dataOut, 'epidemic-trends.json'), JSON.stringify(record));
}

function writeRootFiles(sitemapEntries) {
  writeFileSync(join(dist, 'sitemap.xml'), seo.sitemapXml(sitemapEntries));
  writeFileSync(join(dist, 'robots.txt'), seo.robotsTxt());
  // IndexNow key file (shared fleet vault key) — must exist at dist root for keyLocation validation.
  writeFileSync(join(dist, 'd390aee0a606d453b3585684871efd3e.txt'), 'd390aee0a606d453b3585684871efd3e');
  writeFileSync(join(dist, 'manifest.webmanifest'), manifest(site));
  writeFileSync(join(dist, '_headers'), headers());
  writeFileSync(join(dist, '_redirects'), redirects());

  // favicon.ico at the root for legacy clients / bots that request it directly.
  const png32 = resolve(root, 'src/assets/favicon-32.png');
  if (existsSync(png32)) writeFileSync(join(dist, 'favicon.ico'), icoFromPng(readFileSync(png32), 32));

  // RFC 9116 security contact + humans.txt (transparency / firm-grade polish).
  mkdirSync(join(dist, '.well-known'), { recursive: true });
  writeFileSync(join(dist, '.well-known', 'security.txt'), securityTxt());
  writeFileSync(join(dist, 'humans.txt'), humansTxt());

  // IndexNow key: repo-root indexnow.txt holds the fleet key; the protocol
  // requires it served at /<key>.txt (Disney-Guide's build does the same).
  const indexNowKeyPath = resolve(root, 'indexnow.txt');
  if (existsSync(indexNowKeyPath)) {
    const key = readFileSync(indexNowKeyPath, 'utf8').trim();
    if (/^[0-9a-f]{8,64}$/.test(key)) writeFileSync(join(dist, `${key}.txt`), key);
  }
}

function securityTxt() {
  // Expires ~1 year out from the season anchor (stable, avoids build-time Date).
  return `# ${site.name} security contact
Contact: mailto:${site.publisher.email}
Expires: ${site.season.endsISO}T00:00:00Z
Preferred-Languages: en
Canonical: ${site.origin}/.well-known/security.txt
`;
}

function humansTxt() {
  return `/* TEAM */
  Site: ${site.name}
  Contact: ${site.publisher.email}

/* SITE */
  An independent, plain-English respiratory illness tracker built on
  public-domain CDC surveillance data. Not affiliated with the CDC.
  Standards: HTML5, CSS3, ES modules, JSON-LD
  Components: Zero runtime dependencies. Static build. Cloudflare Pages.
`;
}

function headers() {
  // Content-Security-Policy tuned to exactly what FluTrack loads:
  //   * scripts are self-hosted ES modules; the single inline theme-boot script
  //     is allowlisted by its SHA-256 hash rather than 'unsafe-inline'.
  //   * style-src keeps 'unsafe-inline' because the templates use inline
  //     style="" attributes (no inline <style> blocks or remote styles).
  //   * connect-src permits the CDC Socrata API and the FCC geocoder used for
  //     "use my location".
  const bootHash = createHash('sha256').update(BOOT_SCRIPT).digest('base64');
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    // www.googletagmanager.com serves the GA4 gtag.js loader, which
    // src/scripts/analytics.js inserts once analytics consent is granted (the
    // bootstrap itself is that same-origin file, so no inline hash is needed);
    // hits go to *.google-analytics.com / *.analytics.google.com.
    // static.cloudflareinsights.com serves the Cloudflare Web Analytics beacon,
    // which reports to cloudflareinsights.com.
    // challenges.cloudflare.com serves Cloudflare Turnstile (the bot check on
    // the symptom-report form): its script loads only once that form is used,
    // and it renders in an iframe from the same host (frame-src below).
    `script-src 'self' 'sha256-${bootHash}' https://googletagmanager.com https://www.googletagmanager.com https://static.cloudflareinsights.com https://challenges.cloudflare.com`,
    "frame-src https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://www.google-analytics.com https://*.google-analytics.com https://*.googletagmanager.com",
    "font-src 'self'",
    // ingest.oakandmain.dev is the TrueAPI ingest Worker that data-sources.js
    // has fetched from since b817d55; that commit repointed the host without
    // updating this policy, so every live refresh has been blocked ever since.
    "connect-src 'self' https://data.cdc.gov https://geo.fcc.gov https://ingest.oakandmain.dev https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com https://cloudflareinsights.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  // Cache-Control rules must be MUTUALLY EXCLUSIVE. Cloudflare's _headers spec:
  // "If a header is applied twice in the _headers file, the values are joined
  // with a comma separator" — and a splat "will greedily match all characters",
  // including "/". So /assets/* would also match /assets/js/app.js, and a file
  // matching two rules ends up with a spliced, meaningless Cache-Control.
  // build/check.mjs asserts no emitted file matches more than one rule.
  //
  // Only the stylesheet carries a content hash, so only it may be immutable.
  // Everything else is served at a stable name that pins no bytes — including
  // the fonts: `newsreader-latin.woff2` does not change when the face does, so
  // a year of `immutable` would strand a replacement in returning visitors'
  // caches exactly as it would for app.js. Fonts get a long TTL with a long
  // stale-while-revalidate window instead: near-immutable in practice, but
  // recoverable. SWR is live here because no revalidating directive accompanies
  // it (see the HTML rule below for the case where it would be inert).
  // No stale-while-revalidate here, deliberately. Cloudflare disables SWR
  // whenever s-maxage, must-revalidate or proxy-revalidate is present (RFC 9111
  // 4.2.4) — and this value needs both: max-age=0 + must-revalidate keeps the
  // browser revalidating, s-maxage gives the shared cache a short freshness
  // window. An SWR directive alongside them is inert, and advertising a
  // stale-serving window that can never happen is worse than omitting it.
  const HTML_CACHE = 'public, max-age=0, must-revalidate, s-maxage=300';
  // Directory URLs never collide with the asset rules below: a placeholder
  // matches everything except "/", and each of these ends in "/".
  const htmlRules = ['/', '/:page/', '/:section/:page/', '/404.html', '/offline.html']
    .map((pattern) => `${pattern}\n  Cache-Control: ${HTML_CACHE}\n`)
    .join('\n');

  return `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  Content-Security-Policy: ${csp}

${htmlRules}
/assets/fonts/*
  Cache-Control: public, max-age=2592000, stale-while-revalidate=31536000

/assets/${site.assets.css}
  Cache-Control: public, max-age=31536000, immutable

/assets/js/*
  Cache-Control: public, max-age=300, stale-while-revalidate=86400

/assets/*.png
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/assets/*.svg
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/assets/geo/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=2592000

/assets/build.json
  Cache-Control: no-cache

/data/*
  Cache-Control: public, max-age=3600

/sw.js
  Cache-Control: no-cache
`;
}

function redirects() {
  return `# Legacy / convenience redirects
/states  /states/  301
/state   /states/  301
`;
}

// --- Content-page discovery ---------------------------------------------- //
async function discoverContentPages(ctx) {
  const dir = resolve(here, 'pages/content');
  if (!existsSync(dir)) return [];
  const pages = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs')) continue;
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.default !== 'function') {
      console.warn(`  ! ${file} has no default export — skipping`);
      continue;
    }
    const result = mod.default(ctx);
    for (const p of Array.isArray(result) ? result : [result]) pages.push(p);
  }
  return pages;
}


/**
 * Where the resolved LIVE_PRERENDER mode came from — the build log is the
 * receipt a reviewer checks before trusting a production deployment.
 */
function modeSource(env) {
  if (env.CF_PAGES === '1' && (env.CF_PAGES_BRANCH || '') === 'main') return 'Pages production build entrypoint';
  if (env.LIVE_PRERENDER) return 'environment variable';
  return 'default';
}

// --- Main ---------------------------------------------------------------- //

async function main() {
  console.log('FluTrack build');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // Production git builds always require live data (build/lib/live-snapshot.mjs
  // resolveLivePrerenderMode): the entrypoint cannot be weakened by a dashboard
  // variable, and wrangler.toml [env.production.vars] carries the same policy.
  const mode = resolveLivePrerenderMode({ livePrerender: process.env.LIVE_PRERENDER, cfPages: process.env.CF_PAGES, cfPagesBranch: process.env.CF_PAGES_BRANCH });
  log(`data policy: LIVE_PRERENDER=${mode} (${modeSource(process.env)})`);
  const { snapshot, live, reason } = await resolveSnapshot({ mode, loadSample: loadSampleSnapshot });
  if (live) log(`data: LIVE CDC pre-render — ${reason}`);
  else console.warn(`  ! data: SAMPLE fallback — pages will say "Sample data" (${reason})`);
  const ctx = buildContext(snapshot);

  // CDC's COVID-19 epidemic-trend (Rt) categories. Never fatal: any failure to
  // fetch or validate them simply omits the block, and a sample-data build
  // carries none (a page that says "Sample data" must not also carry a real
  // health signal). See build/lib/epidemic-trend.mjs.
  const trend = await resolveEpidemicTrend();
  ctx.epidemicTrend = planEpidemicTrend(trend.data, { models: ctx.models, provenance: ctx.provenance });
  if (ctx.epidemicTrend) {
    const c = ctx.epidemicTrend.counts;
    log(`epidemic trend: CDC ${trend.reason} — ${c.shown} states shown, ${c.withheld} withheld, ${c.notEstimated} not estimated`);
  } else if (trend.data) {
    console.warn(`  ! epidemic trend: fetched (${trend.reason}) but omitted — this build's data is not live`);
  } else if (trend.status === 'skipped') {
    log(`epidemic trend: skipped (${trend.reason})`);
  } else {
    console.warn(`  ! epidemic trend: unavailable, block omitted (${trend.reason})`);
  }
  // Build variables come from wrangler.toml [vars] (the Pages project's source
  // of truth), so this line is where a deploy log shows which mode shipped.
  log(
    `report form: ${site.turnstile.siteKey ? 'ON (Turnstile site key set)' : 'opens soon (no TURNSTILE_SITE_KEY)'}` +
      `${site.features.report ? '' : ', switched OFF by FEATURE_REPORT=false'}; FEATURE_REPORT=${process.env.FEATURE_REPORT ?? '(unset)'}`
  );

  // Assets & code
  bundleCss();
  copyScripts();
  writeServiceWorker();
  writeAssets(snapshot);
  writeEpidemicTrend(ctx.epidemicTrend);
  log('assets, styles, scripts and service worker written');

  const written = [];
  const sitemap = [];

  // Home
  const { default: home } = await import('./pages/home.mjs');
  written.push(writePage(home(ctx)));
  sitemap.push({ path: '/', changefreq: 'daily', priority: 1.0, lastmod: snapshot.weekEnding });

  // Per-state pages
  const { statePage } = await import('./pages/state.mjs');
  for (const st of states) {
    const socialDir = join(dist, 'assets', 'og');
    mkdirSync(socialDir, { recursive: true });
    writeFileSync(join(socialDir, `${st.slug}.svg`), stateOgSvg(site, st, ctx.models.get(st.abbr).model, ctx.provenance));
    written.push(writePage(statePage(ctx, st)));
    sitemap.push({ path: `/state/${st.slug}/`, changefreq: 'weekly', priority: 0.8, lastmod: snapshot.weekEnding });
  }
  log(`${states.length} state pages written`);

  // Metro "what's going around" pages (state-level read, honestly labeled)
  const { metroPage, metros } = await import('./pages/metro.mjs');
  for (const metro of metros) {
    written.push(writePage(metroPage(ctx, metro)));
    sitemap.push({ path: `/metro/${metro.slug}/`, changefreq: 'weekly', priority: 0.7, lastmod: snapshot.weekEnding });
  }
  log(`${metros.length} metro pages written`);

  // Auto-discovered content/legal pages
  const contentPages = await discoverContentPages(ctx);
  for (const page of contentPages) {
    written.push(writePage(page));
    if (!page.noindex) {
      sitemap.push({
        path: page.path,
        changefreq: page.changefreq || 'monthly',
        priority: page.priority ?? 0.5,
        lastmod: page.lastmod || (page.path === '/states/' ? snapshot.weekEnding : site.contentUpdated),
      });
    }
  }
  log(`${contentPages.length} content pages written`);

  writeRootFiles(sitemap);
  log('sitemap, robots, manifest, headers written');

  console.log(`\n✓ Built ${written.length} pages → dist/`);
}

main().catch((err) => {
  console.error('\n✗ Build failed:', err);
  process.exit(1);
});
