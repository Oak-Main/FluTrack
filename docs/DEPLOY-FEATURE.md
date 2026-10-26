# Deploying "Report your symptoms + Check your area"

Everything ships through the existing git-connected Cloudflare Pages project
(`flufollower`, production branch `main`). One extra Worker, `flutrack-ingest`,
owns the cron triggers. Commands assume the repo root and a logged-in
`npx wrangler` (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` set).

## 0. Status after the feature PR

| Item | State |
|---|---|
| D1 `flutrack-db` (`f3349920-cdfd-4513-b5f3-53f25bb25301`) | **Created**; `migrations/0001_init.sql` **applied** (recorded in `d1_migrations`) |
| KV `OFFICIAL_CACHE` (`91b560ebf86148e0b8c9cc29b1aa48cc`) | **Created** |
| Pages bindings `DB`, `OFFICIAL_CACHE`, var `FEATURE_REPORT` | In `wrangler.toml` — applied by the next Pages build |
| `/api/area`, `/api/official` | Work from the first deploy: a missing state document is pulled from CDC on demand and stored |
| Turnstile widget, `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | **Not created** (this session's Cloudflare token could not write) → report form shows "opens soon", `/api/report` returns 503 |
| `flutrack-ingest` Worker + `INGEST_TOKEN` | **Not deployed** (same reason) → no scheduled pulls, no daily maintenance |
| D1 `zip_crosswalk` seed | Not seeded; lookups use the static `/data/zip3/*.json` shards until it is |

## 1. Database (already done — for a fresh environment)

```bash
npx wrangler d1 create flutrack-db                     # put the id in both wrangler.toml files
npx wrangler d1 migrations apply flutrack-db --remote
npx wrangler kv namespace create OFFICIAL_CACHE        # put the id in both wrangler.toml files
```

## 2. Turnstile (turns symptom reporting on)

1. Cloudflare dashboard → **Turnstile** → **Add widget**: name `flufollower-report`,
   hostnames `flufollower.com` and `flufollower.pages.dev`, mode **Managed**.
2. Secret key (do this first, so the form never ships without it):
   ```bash
   npx wrangler pages secret put TURNSTILE_SECRET --project-name flufollower
   ```
3. Site key (public) → one line in the root `wrangler.toml`, then PR + merge:
   ```toml
   [vars]
   FEATURE_REPORT = "true"
   TURNSTILE_SITE_KEY = "0x4AAAA…"
   ```
   `wrangler.toml` is the Pages project's source of truth, so its `[vars]`
   reach the build environment too, not only the deployed Functions — the
   2026-10-19 production build log recorded `FEATURE_REPORT=true` straight
   from build.mjs's `process.env`, and that var exists only in `wrangler.toml`.
   `build/lib/site.mjs` reads `TURNSTILE_SITE_KEY` this way, and the dashboard
   shows these variables read-only. (Committing the key directly to
   `turnstile.siteKey` in `site.mjs` also works.) Note the distinction this
   relies on: Pages project variables set in the dashboard cover both build
   and runtime, while `[env.production.vars]` in `wrangler.toml` scopes a
   value to production deployments. LIVE_PRERENDER additionally cannot rest on
   either alone — the build resolves `require` for production-branch builds in
   code (`resolveLivePrerenderMode` in `build/lib/live-snapshot.mjs`).
4. Check the deploy log line `report form: ON (Turnstile site key set)`.
5. Verify: the home page shows the report form (not "opens soon"); a report from
   a phone returns the result card with "Thanks — your report was counted."

## 3. Ingest Worker (scheduled pulls + daily maintenance)

```bash
cd workers/ingest
npx wrangler deploy
npx wrangler secret put INGEST_TOKEN            # any long random string; keep it
npx wrangler secret put SODA_APP_TOKEN          # optional, data.cdc.gov app token
# optional, only with DELPHI_FLUVIEW = "true":  npx wrangler secret put DELPHI_API_KEY
```

After a pull the Worker rebuilds KV one state per invocation through its own
loopback binding (`ctx.exports`, compatibility flag `enable_ctx_exports` in its
`wrangler.toml`), so no service binding has to exist before the first deploy and
no invocation comes near KV's 1,000-operations cap.

Trigger one ingest and seed the crosswalk:

```bash
URL=https://flutrack-ingest.kevynsgrin.workers.dev
curl -X POST "$URL/__ingest"   -H "Authorization: Bearer $INGEST_TOKEN"   # pulls every source
curl -X POST "$URL/__seed-zip" -H "Authorization: Bearer $INGEST_TOKEN"   # Census ZIP→county into D1
curl "$URL/health"                                                         # last run summary
```

Confirm D1 and KV hold current data:

```bash
npx wrangler d1 execute flutrack-db --remote --command \
  "SELECT source, COUNT(DISTINCT geo_id) AS geos, MAX(week_ending) AS latest FROM official_snapshots GROUP BY source"
npx wrangler d1 execute flutrack-db --remote --command "SELECT COUNT(*) FROM zip_crosswalk"
npx wrangler kv key get --namespace-id 91b560ebf86148e0b8c9cc29b1aa48cc official:state:CA
```

Expect `nssp_ed`, `nssp_ari`, `nhsn_levels`, `nhsn_hrd`, `nhsn_hrd_prelim` with 50+
geographies and `nwss_wval` with hundreds of counties, all for the latest CDC week.

Crons (UTC): `0 18 * * 3` and `0 18 * * 5` (official pulls), `0 8 * * *` (salt
rotation, 90-day purge, anomaly checks, aggregates). Manual maintenance:
`POST /__maintenance`.

`.github/workflows/deploy-ingest.yml` can redeploy the Worker from GitHub once a
`CLOUDFLARE_API_TOKEN` repository secret (Workers Scripts: Edit, D1: Edit,
Workers KV: Edit) exists.

## 4. Verify production

| URL | Expect |
|---|---|
| https://flufollower.com/ | "Check your area / Report how you feel" under the hero; renders without JS |
| https://flufollower.com/api/area?zip=94612 | JSON: Alameda County; `official.*.week_ending` + `fetched_at`; `community.suppressed: true` |
| https://flufollower.com/api/area | JSON for your approximate location; `Cache-Control: private, max-age=900` |
| https://flufollower.com/api/official?state=CA&county=06073 | Official-only JSON, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=900` |
| https://flufollower.com/api/area?zip=94612 with `Accept: text/html` | Server-rendered result page (the no-JS path) |
| https://flufollower.com/consumer-health-data-privacy/ | The notice; linked from every footer and from the form |
| https://flufollower.com/methodology/#check-your-area | ILI definition, thresholds, suppression, no "outbreak" |
| https://flufollower.com/data-sources/ | New datasets; six `Dataset` JSON-LD nodes |

Non-US: a request with a non-US `request.cf.country` and no ZIP gets
`403 {"error":"us_only","message":"FluFollower is US-only for now."}`
(covered by `test/functions-report-area.test.mjs`; from a VPN exit outside the
US, `curl -i https://flufollower.com/api/area`).

## 5. Rollback

In order of reach — none of them drops data:

1. **Pause reporting only**: set `FEATURE_REPORT = "false"` in `wrangler.toml`
   `[vars]` and merge. `/api/report` answers 503 and the widget hides the report
   form. Also set `FEATURE_REPORT=false` as a Pages **build** variable to drop
   the form from the HTML. `/api/area` and `/api/official` keep working.
2. **Revert the feature**: `git revert -m 1 <merge sha> && git push` (via a PR),
   or Cloudflare dashboard → Pages → flufollower → Deployments → the last good
   deployment → **Rollback to this deployment** (instant).
3. **Stop the ingest**: set `crons = []` in `workers/ingest/wrangler.toml` and
   `npx wrangler deploy` (or `npx wrangler delete flutrack-ingest`).

**Never drop D1 tables in a rollback.** Reports age out on their own (90 days)
once the Worker runs; official snapshots are public data.

## 6. Lighthouse (mobile, local `npm run serve`, no edge compression)

| Build | Performance | Accessibility | Best practices | SEO | LCP | CLS |
|---|---:|---:|---:|---:|---:|---:|
| feature (run 1) | 90 | 100 | 96 | 100 | 3.3 s | 0 |
| feature (run 2) | 94 | — | — | — | 2.9 s | 0 |
| main, same machine | 92 | — | — | — | 3.2 s | 0 |

The widget adds no script to the first load beyond the 1 KB `report-boot.js`;
the widget, Turnstile and the globe load on interaction.
