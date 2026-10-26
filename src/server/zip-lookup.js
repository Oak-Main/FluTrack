// ===========================================================================
// ZIP5 → { county_fips, state, zip3, zip3_pop_over_20k }.
//
// D1 zip_crosswalk is the primary source. Until it is seeded (or if D1 is
// unavailable) the same crosswalk is read from the static shards the build
// emits at /data/zip3/<zip3>.json (generated from src/data/zip-county.csv),
// so a ZIP lookup never depends on a seeding step having run.
// The ZIP5 itself is only ever a lookup key — it is not stored or logged.
// ===========================================================================

import { normalizeZip, stateForCounty, RESTRICTED_ZIP3 } from './geo.js';

export function makeZipLookup(env, request) {
  const shardCache = new Map();
  return async function lookupZip(zipInput) {
    const zip5 = normalizeZip(zipInput);
    if (!zip5) return null;
    if (env.DB) {
      try {
        const row = await env.DB.prepare('SELECT zip5, county_fips, state, zip3, zip3_pop_over_20k FROM zip_crosswalk WHERE zip5 = ?').bind(zip5).first();
        if (row) return row;
      } catch (e) {
        /* fall through to the static shard */
      }
    }
    if (!env.ASSETS || !request) return null;
    const zip3 = zip5.slice(0, 3);
    try {
      if (!shardCache.has(zip3)) {
        const res = await env.ASSETS.fetch(new Request(new URL(`/data/zip3/${zip3}.json`, request.url)));
        shardCache.set(zip3, res.ok ? await res.json() : {});
      }
      const county = shardCache.get(zip3)[zip5];
      if (!county) return null;
      return { zip5, county_fips: county, state: stateForCounty(county), zip3, zip3_pop_over_20k: RESTRICTED_ZIP3.has(zip3) ? 0 : 1 };
    } catch (e) {
      return null;
    }
  };
}

/** Build-time: group the committed CSV into { "921": { "92101": "06073", … }, … }. */
export function shardCrosswalk(csvText) {
  const shards = {};
  // \r?\n: a Windows checkout (core.autocrlf) holds this CSV with CRLF line
  // endings; a plain \n split leaves '\r' on the county FIPS and the strict
  // check below would silently drop every row, emptying the emitted shards.
  for (const line of String(csvText).trim().split(/\r?\n/).slice(1)) {
    const [zip5, county] = line.split(',');
    if (!/^\d{5}$/.test(zip5) || !/^\d{5}$/.test(county)) continue;
    const z3 = zip5.slice(0, 3);
    (shards[z3] ||= {})[zip5] = county;
  }
  return shards;
}
