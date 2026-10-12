// ===========================================================================
// Post-build QA. Crawls dist/ and verifies:
//   * every internal href / src resolves to a real file (no dead links)
//   * every page has <title>, meta description, canonical, exactly one <h1>
//   * no obvious unresolved template placeholders
// Exits non-zero on failure so it can gate CI.  Usage: node build/check.mjs
// ===========================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { computeModel } from '../src/scripts/model.js';
import { readingStatus } from '../src/scripts/reading-provenance.js';
import { hasSignalData, MIN_LIVE_STATES } from '../src/scripts/data-sources.js';
import { states } from '../src/scripts/states-data.js';
import { formatDate } from '../src/scripts/util.js';
import { ageDays, MAX_REPORT_AGE_DAYS } from './lib/epidemic-trend.mjs';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const errors = [];
const warnings = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function assetExists(urlPath) {
  const clean = urlPath.split('#')[0].split('?')[0];
  if (clean.endsWith('/')) return existsSync(join(dist, clean, 'index.html'));
  const direct = join(dist, clean);
  if (existsSync(direct)) return true;
  return existsSync(join(dist, clean, 'index.html'));
}

const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'));
if (!htmlFiles.length) errors.push('No HTML files found in dist/. Did the build run?');

for (const file of htmlFiles) {
  const rel = file.replace(dist, '');
  const html = readFileSync(file, 'utf8');
  // Ignore JSON-LD blocks when scanning for stray template markers / "undefined",
  // since valid JSON legitimately contains "}}" and other brace sequences.
  const htmlNoLd = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');

  // Required SEO tags.
  if (!/<title>[^<]{3,}<\/title>/.test(html)) errors.push(`${rel}: missing/empty <title>`);
  if (!/<meta name="description" content="[^"]{20,}"/.test(html)) errors.push(`${rel}: missing meta description`);
  if (!/<link rel="canonical"/.test(html)) errors.push(`${rel}: missing canonical`);
  const h1s = (html.match(/<h1[\s>]/g) || []).length;
  if (h1s === 0) warnings.push(`${rel}: no <h1>`);
  if (h1s > 1) warnings.push(`${rel}: ${h1s} <h1> elements (expected 1)`);

  // Unresolved placeholders / stray "undefined".
  if (/\bundefined\b/.test(htmlNoLd.replace(/https?:\/\/[^"']*/g, ''))) {
    warnings.push(`${rel}: contains the literal "undefined"`);
  }
  if (/\{\{\s*[\w.]+\s*\}\}/.test(htmlNoLd)) errors.push(`${rel}: unresolved {{template}} markers`);

  // Internal link + asset integrity.
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (ref.startsWith('//')) continue; // protocol-relative external
    if (!assetExists(ref)) errors.push(`${rel}: dead internal link → ${ref}`);
  }
}

// Required top-level artifacts.
for (const req of ['sitemap.xml', 'robots.txt', 'manifest.webmanifest', '_headers', '404.html', 'data/snapshot.json']) {
  if (!existsSync(join(dist, req))) errors.push(`missing required artifact: ${req}`);
}

// --- Provenance: every badge must match the data actually shipped ------- //
// Pages are pre-rendered from either live CDC data or the bundled sample
// (build/lib/live-snapshot.mjs). A page that says "Live CDC data" over sample
// numbers — or "Sample data" over real ones — is a false statement about the
// data, so the shipped snapshot and every rendered badge must agree.
if (existsSync(join(dist, 'data/snapshot.json'))) {
  const snap = JSON.parse(readFileSync(join(dist, 'data/snapshot.json'), 'utf8'));
  const live = snap.kind === 'live';
  if (!['live', 'sample'].includes(snap.kind)) errors.push(`data/snapshot.json: unknown kind "${snap.kind}"`);
  if (live && !/^\d{4}-\d{2}-\d{2}$/.test(snap.weekEnding || '')) errors.push('data/snapshot.json: live snapshot without a valid weekEnding');
  const usableCoverage = states.filter((state) => snap.states?.[state.abbr]?.weekEnding === snap.weekEnding && hasSignalData(snap.states[state.abbr])).length;
  if (live && usableCoverage < MIN_LIVE_STATES) errors.push(`data/snapshot.json: live snapshot has usable observations for only ${usableCoverage} jurisdictions`);
  if (live && snap.statesWithData !== usableCoverage) errors.push(`data/snapshot.json: declared coverage ${snap.statesWithData} disagrees with ${usableCoverage} usable jurisdiction readings`);
  const LIVE_BADGE = 'class="badge badge--live"';
  const SAMPLE_BADGE = 'class="badge badge--cached"';
  let pages = 0;
  for (const file of htmlFiles.filter((f) => /[\\/]state[\\/][^\\/]+[\\/]index\.html$/.test(f) || f === join(dist, 'index.html'))) {
    const rel = file.replace(dist, '');
    const html = readFileSync(file, 'utf8');
    pages += 1;
    if (live && html.includes(SAMPLE_BADGE)) errors.push(`${rel}: "Sample data" badge on a page rendered from live CDC data`);
    if (!live && html.includes(LIVE_BADGE)) errors.push(`${rel}: "Live CDC data" badge on a page rendered from sample data`);
    if (!html.includes(live ? LIVE_BADGE : SAMPLE_BADGE)) errors.push(`${rel}: threat card carries no provenance badge`);
    // Plain-English takeaways are claims about a real state: live data only.
    if (rel !== '/index.html') {
      const hasTakeaways = html.includes('<section class="takeaways"');
      const state = states.find((s) => rel === `/state/${s.slug}/index.html`);
      const provenance = { kind: snap.kind, live, weekEnding: snap.weekEnding };
      const model = computeModel(snap.states?.[state?.abbr] || {}, provenance);
      const hasUsableLiveReading = readingStatus(model, provenance) === 'live';
      if (hasUsableLiveReading && !hasTakeaways) errors.push(`${rel}: usable live reading is missing its plain-English takeaways`);
      if (!hasUsableLiveReading && hasTakeaways) errors.push(`${rel}: takeaways rendered from sample, stale or missing observations`);
    }
  }
  const ogDir = join(dist, 'assets', 'og');
  for (const f of existsSync(ogDir) ? readdirSync(ogDir) : []) {
    const svg = readFileSync(join(ogDir, f), 'utf8');
    if (live === svg.includes('>Sample data<')) errors.push(`assets/og/${f}: share card provenance does not match the ${snap.kind} snapshot`);
  }
  console.log(`Provenance: ${snap.kind} snapshot (week ending ${snap.weekEnding}); ${pages} page badge(s) and share cards agree.`);
}

// --- No placeholder copy may ever reach a visitor ---------------------- //
// The season-kit module shipped 204 visible "[COPY NEEDED: …]" strings across
// 51 state pages, rendered rather than hidden. partials.seasonKitModule() now
// refuses to render until its copy is filled, but that is one component's
// discipline; this is the backstop that covers every template.
//
// Scanned surfaces are the two a visitor or a crawler can actually read: the
// visible text with tags stripped, and the values of human-facing attributes.
// Raw HTML is deliberately NOT scanned — `placeholder="you@example.com"` is a
// legitimate attribute appearing 64 times, and a guard that cries wolf on it
// would be switched off within a week.
{
  const PLACEHOLDER_TOKENS = [
    { name: 'COPY NEEDED', re: /\[?\s*COPY\s+NEEDED/i },
    { name: 'TODO', re: /\bTODO\b/ },
    { name: 'FIXME', re: /\bFIXME\b/i },
    { name: 'Lorem', re: /\bLOREM\b/i },
    { name: 'TBD', re: /\bTBD\b/ },
    { name: 'XXX', re: /\bXXX\b/ },
  ];
  // Attributes a person or a crawler consumes as prose.
  const PROSE_ATTRS = /\b(?:alt|title|aria-label|placeholder|content)\s*=\s*"([^"]*)"/gi;

  const decode = (t) =>
    t
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');

  let scanned = 0;
  for (const file of htmlFiles) {
    const rel = file.replace(dist, '');
    const html = readFileSync(file, 'utf8');
    scanned += 1;

    // Visible text: drop script/style wholesale, then all tags (which also
    // drops every attribute), then decode entities.
    const visible = decode(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ');

    const attrValues = [...html.matchAll(PROSE_ATTRS)].map((m) => decode(m[1]));

    for (const { name, re } of PLACEHOLDER_TOKENS) {
      const hitText = visible.match(re);
      if (hitText) {
        const at = visible.indexOf(hitText[0]);
        errors.push(
          `${rel}: placeholder "${name}" is visible to readers → "${visible.slice(Math.max(0, at - 30), at + 60).trim()}"`
        );
      }
      const hitAttr = attrValues.find((v) => re.test(v));
      if (hitAttr) errors.push(`${rel}: placeholder "${name}" in a reader-facing attribute → "${hitAttr.slice(0, 90)}"`);
    }
  }
  console.log(`Placeholders: ${scanned} page(s) scanned for ${PLACEHOLDER_TOKENS.map((t) => t.name).join(', ')}.`);
}

// --- CSP integrity: the inline script must be allowlisted on EVERY page --- //
// The theme-boot script is permitted by its SHA-256 alone. If that script ever
// changes by a byte and the policy is not regenerated, the browser silently
// blocks it: the theme toggle dies and the stylesheet is never promoted from
// media="print", leaving an unstyled page. Nothing else in the build catches
// that, so it is asserted here against the ACTUAL emitted bytes of every page.
{
  const headersText = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  const cspLine = (headersText.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';
  const scriptSrc = (cspLine.match(/script-src([^;]*)/) || [])[1] || '';
  const allowed = new Set((scriptSrc.match(/'sha256-[A-Za-z0-9+/=]+'/g) || []).map((h) => h.slice(1, -1)));

  if (!cspLine) {
    errors.push('_headers: no Content-Security-Policy found');
  } else if (!allowed.size) {
    errors.push('_headers: CSP script-src carries no sha256- hash for the inline boot script');
  }

  let inlineTotal = 0;
  for (const file of htmlFiles) {
    const rel = file.replace(dist, '');
    const html = readFileSync(file, 'utf8');
    // Inline <script> blocks, excluding JSON-LD and anything with a src=.
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      const attrs = m[1] || '';
      if (/type\s*=\s*"application\/ld\+json"/.test(attrs)) continue;
      inlineTotal += 1;
      const digest = `sha256-${createHash('sha256').update(m[2]).digest('base64')}`;
      if (!allowed.has(digest)) {
        errors.push(
          `${rel}: inline <script> is not allowlisted by the CSP (${digest} absent from script-src). ` +
            `The policy and the emitted script have drifted apart.`
        );
      }
    }
    // Inline event handlers would need 'unsafe-inline'/'unsafe-hashes', which
    // this policy does not grant, so they would be dead code in production.
    const handler = html.match(/<[^>]+\son[a-z]+\s*=\s*"/i);
    if (handler) errors.push(`${rel}: inline event handler would be blocked by the CSP → ${handler[0].slice(0, 60)}`);
  }
  if (!errors.length && !inlineTotal) warnings.push('no inline <script> found in any page — is the theme boot script still emitted?');
  console.log(`CSP: ${inlineTotal} inline script(s) across ${htmlFiles.length} pages checked against ${allowed.size} allowlisted hash(es).`);
}

// --- GA4: in-page, consent-gated, and allowed by the CSP ------------------ //
// Every page must carry the per-site measurement ID on the analytics.js tag,
// early enough that the fleet's edge ga4-inject Worker (which only scans the
// first 5,000 characters for a G- ID) sees it and does not inject an ungated
// second copy. No page may hard-code the gtag.js loader: analytics.js inserts
// it only after consent. And the policy must allow the GA4 and Cloudflare Web
// Analytics origins, or the tags are silently refused.
{
  const GA4_ID = 'G-65H1FJWYLR';
  const { js = 'js' } = JSON.parse(readFileSync(join(dist, 'assets', 'build.json'), 'utf8'));
  const tag = `<script type="module" src="/assets/${js}/analytics.js" data-ga4-id="${GA4_ID}"></script>`;
  if (!existsSync(join(dist, 'assets', js, 'analytics.js'))) errors.push(`missing /assets/${js}/analytics.js (GA4 bootstrap)`);
  for (const file of htmlFiles) {
    const rel = file.replace(dist, '');
    const html = readFileSync(file, 'utf8');
    const at = html.indexOf(tag);
    if (at === -1) errors.push(`${rel}: GA4 analytics.js tag with ${GA4_ID} is missing`);
    else if (at + tag.length > 5000) errors.push(`${rel}: GA4 tag ends at char ${at + tag.length}; the ga4-inject Worker only scans the first 5000`);
    if (html.split(tag).length - 1 > 1) errors.push(`${rel}: GA4 analytics.js tag emitted more than once`);
    if (/googletagmanager\.com\/gtag\/js/.test(html)) errors.push(`${rel}: hard-coded gtag.js loader bypasses the consent gate`);
  }
  const headersText = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  const csp = (headersText.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';
  const directive = (name) => ((csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`)) || [])[1] || '').trim().split(/\s+/);
  const required = {
    'script-src': ['https://www.googletagmanager.com', 'https://static.cloudflareinsights.com'],
    'connect-src': ["'self'", 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com', 'https://cloudflareinsights.com'],
    'img-src': ['https://*.google-analytics.com', 'https://*.googletagmanager.com'],
  };
  for (const [name, hosts] of Object.entries(required)) {
    const have = directive(name);
    for (const h of hosts) if (!have.includes(h)) errors.push(`_headers: CSP ${name} is missing ${h}`);
  }
  if (/'unsafe-inline'|'unsafe-eval'/.test(directive('script-src').join(' '))) {
    errors.push("_headers: CSP script-src must not allow 'unsafe-inline' or 'unsafe-eval'");
  }
  console.log(`GA4: ${htmlFiles.length} page(s) checked for the consent-gated ${GA4_ID} tag and CSP origins.`);
}

// --- Cache-Control rules must not overlap -------------------------------- //
// Cloudflare joins duplicate header values with a comma, and a splat matches
// greedily across "/", so two matching rules give one file a spliced
// Cache-Control. Every emitted asset must match exactly one rule.
{
  const headersText = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  const rules = [];
  let current = null;
  for (const line of headersText.split('\n')) {
    if (/^\S/.test(line) && line.trim()) {
      current = { pattern: line.trim(), cache: false };
      rules.push(current);
    } else if (current && /^\s+Cache-Control:/i.test(line)) {
      current.cache = true;
    }
  }
  const cacheRules = rules.filter((r) => r.cache);
  // A splat matches any characters (including "/"); a :placeholder matches any
  // run of characters except "/".
  const toRegExp = (pattern) => {
    let out = '';
    for (const part of pattern.split(/(\*|:[A-Za-z]\w*)/)) {
      if (part === '*') out += '.*';
      else if (/^:[A-Za-z]\w*$/.test(part)) out += '[^/]+';
      else out += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  };
  const compiled = cacheRules.map((r) => ({ ...r, re: toRegExp(r.pattern) }));

  const served = [];
  const walkAll = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkAll(p, `${prefix}/${name}`);
      else served.push(`${prefix}/${name}`);
    }
  };
  walkAll(dist);

  let overlaps = 0;
  for (const f of served) {
    if (f === '/_headers' || f === '/_redirects') continue;
    // Directory URLs are what Cloudflare actually serves for index.html.
    const url = f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f;
    const hits = compiled.filter((r) => r.re.test(url));
    if (hits.length > 1) {
      overlaps += 1;
      errors.push(
        `_headers: ${url} matches ${hits.length} Cache-Control rules (${hits.map((h) => h.pattern).join(', ')}); ` +
          `Cloudflare would join them into one spliced value`
      );
    }
  }
  const unmatched = served
    .filter((f) => f !== '/_headers' && f !== '/_redirects') // parsed by Pages, never served
    .map((f) => (f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f))
    .filter((url) => !compiled.some((r) => r.re.test(url)));
  if (unmatched.length) {
    warnings.push(`_headers: ${unmatched.length} file(s) match no Cache-Control rule, e.g. ${unmatched.slice(0, 5).join(', ')}`);
  }
  console.log(
    `Cache rules: ${cacheRules.length} pattern(s), ${served.length} emitted file(s), ` +
      `${overlaps === 0 ? 'no overlaps' : `${overlaps} OVERLAP(S)`}.`
  );
}

// --- Globe budget and lazy loading --------------------------------------- //
// The landing globe (src/scripts/globe.js) is a decorative payoff after the
// result card. Hard budget: its JS + the vendored geo library + geometry must
// stay <= 45 KB gzipped, and NONE of it may load with a page. Pages may only
// reach it through dynamic import() (report-boot → report-widget → globe), so
// this walks every page's static module graph and fails if any of the lazy
// files is reachable from the first load.
{
  const GLOBE_BUDGET = 45 * 1024;
  const { js = 'js' } = JSON.parse(readFileSync(join(dist, 'assets', 'build.json'), 'utf8'));
  if (!/^js\/[a-f0-9]{12}$/.test(js)) errors.push('client modules have no content-addressed release directory');
  const globeFiles = [`assets/${js}/globe.js`, `assets/${js}/geo-vendor.js`, `assets/${js}/states-data.js`, 'assets/geo/land-110m.json', 'assets/geo/us-states.json'];
  let total = 0;
  for (const rel of globeFiles) {
    const p = join(dist, rel);
    if (!existsSync(p)) {
      errors.push(`globe: missing ${rel}`);
      continue;
    }
    total += gzipSync(readFileSync(p), { level: 9 }).length;
  }
  if (total > GLOBE_BUDGET) errors.push(`globe: ${(total / 1024).toFixed(1)} KB gzipped exceeds the 45 KB budget`);

  const LAZY = new Set(['globe.js', 'geo-vendor.js', 'report-widget.js', 'report-render.js']);
  const staticImports = (file) => {
    const p = join(dist, 'assets', js, file);
    if (!existsSync(p)) return [];
    const src = readFileSync(p, 'utf8');
    return [...src.matchAll(/(?:^|[;\n])\s*import\s+(?:[^'"()]*?\s+from\s+)?['"]\.\/([\w.-]+\.js)['"]/g)].map((m) => m[1]);
  };
  let pagesChecked = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const entries = [...html.matchAll(/<script[^>]+src="\/assets\/(js\/[^"?#]+\.js)"/g)].map((m) => {
      const name = m[1].split('/').at(-1);
      if (m[1] !== `${js}/${name}`) errors.push(`${file.replace(dist, '')}: ${m[1]} can load cached modules from another release`);
      return name;
    });
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      queue.push(...staticImports(f));
    }
    for (const f of seen) {
      if (LAZY.has(f)) errors.push(`${file.replace(dist, '')}: ${f} is loaded with the page; it must only be reached by a dynamic import()`);
    }
    if (/\/assets\/geo\/|geo-vendor\.js|globe\.js/.test(html)) errors.push(`${file.replace(dist, '')}: references globe assets directly (must load lazily)`);
    pagesChecked += 1;
  }
  console.log(`Globe: ${(total / 1024).toFixed(1)} KB gzipped of a 45 KB budget; lazy on ${pagesChecked} page(s).`);
}

// --- Turnstile is allowed exactly where it is used ------------------------ //
{
  const headersText = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  const csp = (headersText.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';
  for (const d of ['script-src', 'frame-src']) {
    const have = ((csp.match(new RegExp(`(?:^|;)\\s*${d}\\s+([^;]*)`)) || [])[1] || '').split(/\s+/);
    if (!have.includes('https://challenges.cloudflare.com')) errors.push(`_headers: CSP ${d} is missing https://challenges.cloudflare.com (Turnstile)`);
  }
}

// --- No ad slot in or beside the symptom form / result card --------------- //
{
  const home = existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '';
  const start = home.indexOf('<section class="section report"');
  if (start !== -1) {
    const end = home.indexOf('</section>', start) + '</section>'.length;
    const inside = home.slice(start, end);
    const before = home.slice(0, start).trimEnd().slice(-300);
    const after = home.slice(end).trimStart().slice(0, 300);
    if (/ad-slot/.test(inside)) errors.push('/index.html: an ad slot sits inside the report section');
    if (/<aside class="ad-slot"[^>]*><\/aside>$/.test(before) || /^<aside class="ad-slot"/.test(after)) {
      errors.push('/index.html: an ad slot sits directly beside the report section');
    }
  }
}

// --- Community output never says "outbreak" ------------------------------ //
// Community reports are unverified; no page or template may call them one.
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<div class="result__row result__row--community"[\s\S]*?<\/div>/g)) {
    if (/outbreak/i.test(m[0])) errors.push(`${file.replace(dist, '')}: community block uses the word "outbreak"`);
  }
}

// --- CDC epidemic trend: every block must match the record it was built from --- //
// The blocks are static and the browser never re-renders them, so the only way
// they can mislead is by disagreeing with dist/data/epidemic-trends.json. This
// ties each page to that record, and checks the house rules the renderer keeps.
{
  const recordPath = join(dist, 'data', 'epidemic-trends.json');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  const BLOCK = /<section class="epi"[^>]*data-block="epidemic-trend"[^>]*>[\s\S]*?<\/section>/g;
  const LINE = /<p[^>]*data-block="epidemic-trend-national"[^>]*>[\s\S]*?<\/p>/;
  const ALARM = /\b(surge|surging|outbreak|spike|alarm|skyrocket)\b/i;
  const text = (html) => html.replace(/<[^>]+>/g, ' ');

  if (record) {
    if (record.schema !== 'flutrack-epidemic-trends/1') errors.push(`data/epidemic-trends.json: unexpected schema "${record.schema}"`);
    const age = ageDays(record.reportDate);
    if (!(age <= MAX_REPORT_AGE_DAYS)) errors.push(`data/epidemic-trends.json: report ${record.reportDate} is ${age} days old (limit ${MAX_REPORT_AGE_DAYS})`);
    if (record.counts.shown !== Object.keys(record.states).length) errors.push('data/epidemic-trends.json: counts.shown does not match the states listed');
    if (record.counts.up + record.counts.flat + record.counts.down !== record.counts.shown) errors.push('data/epidemic-trends.json: direction counts do not add up to counts.shown');
  }

  for (const st of states) {
    const file = join(dist, 'state', st.slug, 'index.html');
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    const rel = `/state/${st.slug}/index.html`;
    const blocks = html.match(BLOCK) || [];
    if (blocks.length > 1) errors.push(`${rel}: ${blocks.length} epidemic-trend blocks (expected at most 1)`);
    const [block] = blocks;
    const status = block?.match(/data-status="([^"]+)"/)?.[1];
    const category = block?.match(/data-category="([^"]+)"/)?.[1];
    if (!record) {
      if (block) errors.push(`${rel}: has an epidemic-trend block, but no data/epidemic-trends.json was written`);
      continue;
    }
    const estimate = record.states[st.abbr];
    const expected = estimate ? 'shown' : record.withheld[st.abbr] ? 'withheld' : record.notEstimated[st.abbr] ? 'not-estimated' : null;
    if (expected === null) {
      if (block) errors.push(`${rel}: has an epidemic-trend block, but the record has nothing for ${st.abbr}`);
      continue;
    }
    if (!block) { errors.push(`${rel}: the record says ${st.abbr} is ${expected}, but the page has no epidemic-trend block`); continue; }
    if (status !== expected) errors.push(`${rel}: block status "${status}", record says "${expected}"`);
    if (expected === 'shown') {
      if (category !== estimate.category) errors.push(`${rel}: block category "${category}", record says "${estimate.category}"`);
      for (const [what, needle] of [['report date', formatDate(record.reportDate)], ['training-data end', formatDate(record.trainingDataEnd)], ['category label', estimate.label], ['Rt estimate', estimate.median.toFixed(2)]]) {
        if (!block.includes(needle)) errors.push(`${rel}: block is missing the ${what} "${needle}"`);
      }
    } else if (category) {
      errors.push(`${rel}: a ${expected} block must not carry a category ("${category}")`);
    }
    if (/level-token|data-sev=/.test(block)) errors.push(`${rel}: the epidemic-trend block uses the FluTrack severity scale (direction is not severity)`);
    if (ALARM.test(text(block))) errors.push(`${rel}: the epidemic-trend block uses alarm language`);
  }

  const homeHtml = existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '';
  const line = homeHtml.match(LINE)?.[0];
  if (record && record.counts.shown && !line) errors.push('/index.html: the record has shown states but the national epidemic-trend line is missing');
  if (!record && line) errors.push('/index.html: has a national epidemic-trend line, but no data/epidemic-trends.json was written');
  if (line && record) {
    const t = text(line).replace(/\s+/g, ' ');
    if (!t.includes(formatDate(record.reportDate))) errors.push('/index.html: national line is missing the report date');
    if (!t.includes(`In ${record.counts.shown} of `)) errors.push(`/index.html: national line does not state ${record.counts.shown} shown jurisdictions`);
    if (!t.includes(`${record.counts.flat} not changing`)) errors.push(`/index.html: national line does not state ${record.counts.flat} not changing`);
    if (ALARM.test(t)) errors.push('/index.html: the national epidemic-trend line uses alarm language');
  }
  // Only the state pages and the home page may carry these blocks.
  for (const file of htmlFiles) {
    // Normalize separators so the allow-list matches on Windows too
    // (path.join yields "\state\alabama\index.html", which would never
    // equal "/index.html" and falsely flagged every legitimate carrier).
    const rel = file.replace(dist, '').split('\\').join('/');
    if (rel === '/index.html' || rel.startsWith('/state/')) continue;
    if (/data-block="epidemic-trend/.test(readFileSync(file, 'utf8'))) errors.push(`${rel}: carries an epidemic-trend block it should not`);
  }
}

console.log(`Checked ${htmlFiles.length} HTML pages.`);
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log(`\n✗ ${errors.length} error(s):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('\n✓ QA passed: links, assets, and SEO tags are intact.');
