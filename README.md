# FluTrack

**A plain-English, mobile-first respiratory illness tracker — flu, RSV and COVID-19 — built on public-domain CDC surveillance data.**

FluTrack answers one question that the CDC's own dashboards make surprisingly hard: _how active is respiratory illness where I live, and which way is it heading?_ It blends several CDC public-domain surveillance signals into a single, transparent **Respiratory Threat Level** (Minimal → Very High) for every U.S. state, with a rising/falling trend and a per-virus breakdown.

> **Not medical advice.** FluTrack is an independent data-visualization utility and is **not affiliated with the CDC**. It shows directional, weekly _trends_ — not real-time case counts or individual risk. See [`/medical-disclaimer/`](src/../build/pages/content/medical-disclaimer.mjs).

---

## Why it exists

The 2025–26 "quad-demic" left consumers wanting a fast, local, jargon-free read on respiratory risk. The CDC publishes authoritative data (NSSP, NWSS, NREVSS) but its dashboards are built for epidemiologists. FluTrack is a sterile **interpreter**: it translates that data into one local answer and nothing more — deliberately avoiding medical advice so it stays defensible under Google's YMYL / E-E-A-T scrutiny and premium ad-network brand-safety rules.

## Architecture at a glance

FluTrack is a **static site** (Cloudflare Pages-ready) with **zero runtime dependencies** and a tiny custom build. CDC data is fetched **at build time** and baked into every page, and production is rebuilt weekly when CDC publishes — so crawlers and first-paint visitors see the current week, not a placeholder. A bundled sample snapshot is the clearly-labeled fallback when the feed is down.

```
Build (weekly) ──▶ CDC Socrata (via the ingest worker's warm copies, public domain)
   └─ every page + /data/snapshot.json pre-rendered from live data (sample fallback)
Browser ──▶ /data/snapshot.json (the build's own data; instant first paint + offline)
   └─ live refresh only if the shipped data is sample or ≥ 13 days old
```

| Layer | Files | Notes |
|------|-------|-------|
| Scoring model | `src/scripts/threat-index.js` | Pure, tested. The unified 0–4 threat level. |
| Data adapters | `src/scripts/data-sources.js` | CDC Socrata fetch + parsing, shared by build and browser; **WastewaterSCAN exclusion**. |
| Live pre-render | `build/lib/live-snapshot.mjs` | `LIVE_PRERENDER` policy: live, sample fallback, or fail. |
| Epidemic trend | `build/lib/epidemic-trend.mjs`, `build/lib/epidemic-trend-render.mjs` | CDC's COVID-19 Rt category: a validated, fail-soft build-time fetch, a per-state show/withhold plan, the state-page block and the home-page line. Direction only; never part of the index. |
| Rendering | `src/scripts/render.js` | Pure HTML functions shared by **build and browser** (identical markup). |
| App controller | `src/scripts/app.js` | Hydrates from the shipped snapshot, refreshes only when stale; state picker, geolocation. |
| Design system | `src/styles/*.css` | Tokens, light/dark, severity scale, components. |
| Build | `build/build.mjs` | Emits `dist/` — home, 51 state pages, content pages, SEO, PWA. |
| Consent gate | `src/scripts/consent.js` | Default-deny gate for non-essential storage; honors GPC. |
| Backend | `functions/api/subscribe.js` | Cloudflare Pages Function for surge-alert signup. |
| CSP reports | `functions/api/csp-report.js` | First-party collector for CSP violation reports. |
| Check your area | `functions/api/area.js`, `functions/api/official.js` | Official-first county/state payload; `/api/official` is CORS-open. Shared logic in `src/server/`. |
| Symptom reports | `functions/api/report.js`, `src/scripts/report-*.js` | Anonymous, Turnstile-gated, rate-limited reports into D1; community counts suppressed below 5. |
| Ingest Worker | `workers/ingest/` | `flutrack-ingest`: Wed/Fri CDC pulls into D1 + KV, daily salt rotation / 90-day purge / aggregates. |
| Globe | `src/scripts/globe.js` | Lazy canvas globe after the result card, ≤ 45 KB gzipped (checked by `build/check.mjs`). |

Because the render functions are imported by **both** the Node build (static output) and the browser (live re-render), the server-rendered and hydrated markup are byte-identical — no flicker, no hydration mismatch.

## Data sources & licensing

FluTrack uses **only U.S. Government public-domain** feeds:

- **NSSP** — Emergency-department visits for flu/RSV/COVID (`vutn-jzwm`) and ARI activity level (`f3zz-zga5`).
- **NWSS** — Wastewater Viral Activity Level / WVAL (`atcp-73re`), an early indicator.
- **NREVSS** — Laboratory test positivity (modeled in the sample only — no live adapter yet, so a live reading rests on up to three signals).
- **CFA Rt** — CDC's COVID-19 epidemic-trend estimate (`rt-map/1.0.0`), a *direction* signal (Growing … Declining) estimated from NSSP ED visits. It is fetched directly from cdc.gov at build time, shown beside a state's readings and never part of the combined index. See [Epidemic trend](#cdc-epidemic-trend-covid-19-rt).

**It deliberately excludes WastewaterSCAN / SCAN / Verily data**, which is licensed **CC BY-NC 4.0 (non-commercial)** and cannot be used on a monetized site. The exclusion is enforced defensively in code (`excludeNonCommercial` in `data-sources.js`) and covered by tests. See [`/data-sources/`](build/pages/content/data-sources.mjs).

## The threat level (summary)

A composite 0–100 score is a weighted average over whatever signals are present for a state/week — wastewater `0.30`, ARI `0.25`, ED visits `0.25`, positivity `0.20` (renormalized) — then bucketed: `<20` Minimal, `<40` Low, `<60` Moderate, `<80` High, `≥80` Very High. Wastewater is weighted highest because it leads clinical reporting by ~5–7 days. Full, transparent thresholds live on the **/methodology/** page and in `threat-index.js`.

## Develop

```bash
npm run build          # build the static site into dist/
npm run serve          # preview dist/ at http://localhost:8788
npm run dev            # build + serve
npm test               # run the unit + integration tests
npm run build:snapshot # regenerate the bundled sample (the offline fallback)
```

No `npm install` is needed — there are no dependencies. Requires Node ≥ 20.

Icons and the Open Graph card are pre-rendered PNGs committed under `src/assets/`. To regenerate them from the SVG sources (requires a local Chromium):

```bash
node build/lib/rasterize.mjs
```

## Deploy (Cloudflare Pages)

> **"Report your symptoms + Check your area"** adds D1 (`flutrack-db`), KV
> (`OFFICIAL_CACHE`), a Turnstile secret and the `flutrack-ingest` Worker. The
> bindings live in `wrangler.toml`; setup, verification and rollback are in
> [`docs/DEPLOY-FEATURE.md`](docs/DEPLOY-FEATURE.md). Tests need Node ≥ 22.13
> (the D1 test double uses `node:sqlite`); the build still runs on Node 20.

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Functions:** the `functions/` directory is picked up automatically.

Optional bindings for live surge-alert delivery (Settings → Functions):

- KV namespace **`SUBSCRIBERS`** — **required**: persists signups and backs the per-IP rate limiter.
- Env var **`ALERTS_WEBHOOK_URL`** — forwards signups to an email provider/automation.

Without the KV binding, `/api/subscribe` returns `501` and the form shows a friendly "not switched on" message — the site remains fully functional. KV is required rather than optional because the rate limiter is backed by it; a webhook-only deployment would accept unlimited unauthenticated submissions with arbitrary recipient addresses.

### Live data at build time

Every build fetches the CDC feed (via the ingest worker's warm copies) and
pre-renders all pages from it — the threat cards, the "This week in plain
English" takeaways, share cards and `/data/snapshot.json`. `LIVE_PRERENDER`
sets the policy (`build/lib/live-snapshot.mjs`):

| Value | Behaviour |
|---|---|
| `auto` *(default)* | Live CDC data; if the feed is unreachable, stale (> 21 days) or covers fewer than 25 states, fall back to the bundled sample, which every page labels **Sample data** and which renders no takeaways. |
| `require` | Live or fail the build — Cloudflare keeps serving the previous deployment. Use for production. |
| `off` | Sample only, no network (deterministic offline builds). |

`build/check.mjs` fails the build if any page's provenance badge, share card or
takeaways block disagrees with the data actually shipped. In the browser,
`app.js` re-fetches the live feed only when the shipped snapshot is sample
data or ≥ 13 days old (a newer CDC week may exist) — otherwise the pre-render
already is the newest week.

### Weekly data refresh

Because the data is baked in at build time, a build is what refreshes it.
`.github/workflows/weekly-rebuild.yml` runs every Saturday (CDC publishes on
Fridays) and Monday (catch-up for holiday weeks): it builds with
`LIVE_PRERENDER=require`, runs QA, and — only if the feed carries a newer CDC
week than production serves — POSTs a Cloudflare Pages deploy hook. It never
deploys sample data. Run it on demand from the Actions tab (`force` rebuilds
even when production is current).

**One-time setup (two steps):**

1. Cloudflare dashboard → Workers & Pages → `flufollower` → Settings → Builds →
   **Deploy hooks** → add a hook for branch `main`, then save the URL as the
   GitHub repository secret **`CF_PAGES_DEPLOY_HOOK`** (Settings → Secrets and
   variables → Actions). Until it exists the workflow fails with that
   instruction rather than silently skipping.
2. Set `LIVE_PRERENDER` = `require` for **production** builds. A push-triggered
   production build during a feed outage then fails and Cloudflare keeps
   serving the last live deploy, instead of replacing it with sample data.
   Leave Preview on the default (`auto`) so branch previews still build when
   the feed is down.

   Enforcement is layered, and does not rest on one mechanism:

   - **The build entrypoint decides on its own.** `build/lib/live-snapshot.mjs`
     (`resolveLivePrerenderMode`) resolves `require` for any git-connected
     build whose `CF_PAGES_BRANCH` is the production branch — the dashboard
     cannot weaken it, and no variable has to exist for it to hold.
   - **`wrangler.toml` carries the same policy.** Since `wrangler.toml` is the
     project's source of truth (the dashboard shows these variables
     read-only), a production-only override must repeat the bindings
     (Cloudflare treats `vars`, `d1_databases` and `kv_namespaces` as
     non-inheritable). Pages injects these vars into the production build
     environment as well as the deployed Functions — the 2026-10-19
     production build log recorded `FEATURE_REPORT=true` straight from the
     build's `process.env`, and that var exists only in `wrangler.toml`:

   ```toml
   [env.production.vars]
   FEATURE_REPORT = "true"
   LIVE_PRERENDER = "require"

   [[env.production.d1_databases]]
   binding = "DB"
   database_name = "flutrack-db"
   database_id = "f3349920-cdfd-4513-b5f3-53f25bb25301"

   [[env.production.kv_namespaces]]
   binding = "OFFICIAL_CACHE"
   id = "91b560ebf86148e0b8c9cc29b1aa48cc"
   ```

   Every build logs the variables it saw (`report form: …; FEATURE_REPORT=…`)
   and the data policy it resolved (`data policy: LIVE_PRERENDER=require
   (Pages production build entrypoint)`), so the deploy log confirms the
   enforcement took. GitHub pauses scheduled workflows
in a repository with no activity for 60 days; re-enable it from the Actions tab
if that happens.

### CDC epidemic trend (COVID-19 Rt)

State pages and the home page also carry CDC's own estimate of whether COVID-19
infections are growing (`build/lib/epidemic-trend.mjs`). It is a second, separate
build-time input: it is **not** on the ingest mirror (it is a CDC website data
file, not a Socrata dataset), so the build fetches it directly from cdc.gov.

| `EPIDEMIC_TREND` | Behaviour |
|---|---|
| `auto` *(default)* | Fetch, validate and render. Any failure — network, HTTP error, bad JSON, wrong schema, a report older than 21 days, categories that contradict their own probabilities — **omits the blocks**. It never fails the build, even under `LIVE_PRERENDER=require`, and is never replaced by sample values. |
| `off` | Skip the fetch and omit the blocks. |

An offline build (`LIVE_PRERENDER=off`) skips it too, and a build whose snapshot
is sample data carries no blocks: a page that says "Sample data" must not also
carry a real health signal. Anything other than `auto` or `off` fails the build
loudly (there is deliberately no `require` mode). The build log says which
happened (`epidemic trend: …`). When blocks are rendered, the figures behind them
are written to `dist/data/epidemic-trends.json`, and `build/check.mjs` verifies
every block against that record. Review `DOCUMENTED_ED_GAPS` in the same module
whenever CDC's data notes change; see `docs/EPIDEMIC-TREND-REVIEW.md`.

### Cloudflare Web Analytics and the CSP

Web Analytics is enabled on the `flufollower.com` zone with **automatic injection**, so Cloudflare adds its `beacon.min.js` tag to every HTML response at the edge. That tag is not in this repository and cannot be hashed at build time, so the CSP names its host explicitly:

- `script-src` includes `https://static.cloudflareinsights.com`
- `connect-src` includes `https://cloudflareinsights.com` (where the beacon reports)

**If you disable Web Analytics, remove those two entries.** If you re-enable it after removing them, the tag will ship on every page and be blocked on every load — a broken beacon *and* a privacy policy describing analytics that never actually run. `build/check.mjs` fails the build if the allowance goes missing while the policy still claims the beacon.

The beacon is cookieless and writes nothing to the visitor's device, which is why it sits outside the consent gate. It is named by legal entity in `/privacy/` and `/vendors/`.

Set `SITE_ORIGIN` at build time to your production origin so canonical URLs, sitemap, and Open Graph tags are correct:

```bash
SITE_ORIGIN=https://your-domain.example npm run build
```

## Project structure

```
build/            Build pipeline (Node ESM, no deps)
  build.mjs       Orchestrator
  lib/            layout, site config, states, seo, partials, snapshot, assets
  pages/          home.mjs, state.mjs, content/*.mjs (auto-discovered)
src/
  scripts/        Client + shared ES modules (threat-index, render, app, …)
  styles/         Design system (tokens, base, components, main)
  assets/         Committed PNG icons + OG card
  data/           snapshot.json — bundled SAMPLE data, the fallback when the
                  CDC feed is unreachable at build time
functions/api/    Cloudflare Pages Functions
test/             node:test unit + integration tests
docs/             Architecture, audits, and the release checklist
```

## Compliance & release

Three pages carry the site's accountability obligations, and all three are
generated from configuration rather than hand-maintained prose:

- **`/consent/`** — the live preference centre. Advertising and analytics storage
  are denied by default for every visitor, not only where a prompt is legally
  required; nothing non-essential loads before a decision is recorded; Global
  Privacy Control is honored as an opt-out. The gate is `src/scripts/consent.js`,
  and registering a vendor in its `VENDORS` array is what arms the banner.
- **`/vendors/`** — the processor register, rendered from the `processors` array
  in `build/lib/site.mjs`. The Privacy Policy reads the same array, so the two
  cannot describe a vendor differently.
- **`/changelog/`** — append-only record of corrections and methodology changes,
  flagging which ones affected readings that had already been published.

**Before any release, work `docs/RELEASE-CHECKLIST.md`.** `npm run verify` covers
the automated half and blocks on it; the manual half (screen readers, real
devices, six viewport widths, PWA install/offline/update) needs a signature in
the PR because CI cannot certify it.

## License

Code is MIT-licensed (see `LICENSE`). The underlying CDC surveillance data is in the U.S. public domain. FluTrack's branding and presentation are its own.

<!-- deploy nudge 2026-09-21: Pages queue stalled on duplicate builds -->
