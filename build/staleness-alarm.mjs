// ===========================================================================
// Production data watchdog — is production serving the live CDC week it should?
//
// Two layers already guard the data, and neither reads what production is
// serving between runs:
//   * build/lib/live-snapshot.mjs refuses a too-old live week WHEN IT BUILDS.
//   * build/rebuild-gate.mjs decides whether to deploy WHEN THE WEEKLY JOB RUNS.
// If the weekly job stops, nothing is building, so no build fails. Production
// keeps its last deployed week and the badge keeps saying "Live CDC data".
//
// This reads what production is serving and fails when it is sample data,
// unreadable, short of the 51 jurisdictions, dated after today, or older than
// the generator's ceiling. The ceiling is imported, not copied, so the two
// layers cannot disagree.
//
// Usage: node build/staleness-alarm.mjs [--url URL | --file PATH]
//                                       [--max-age-days N] [--now YYYY-MM-DD]
// Exit 0: production is live and fresh. Exit 1: it is not, and the reason says
// why. Exit 2: bad arguments. It fails closed everywhere: any doubt is a fail.
// ===========================================================================

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveAgeDays, MAX_LIVE_AGE_DAYS } from './lib/live-snapshot.mjs';
import { hasSignalData, MIN_LIVE_STATES } from '../src/scripts/data-sources.js';
import { states } from '../src/scripts/states-data.js';

export const DEFAULT_URL = 'https://flufollower.com/data/snapshot.json';
const EXPECTED_JURISDICTIONS = 51;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Judge the snapshot production is serving. Pure: the clock is injected.
 * @returns {{ ok: boolean, reason: string, kind?: string, weekEnding?: string, ageDays?: number }}
 */
export function assessProduction(snapshot, { now = new Date(), maxAgeDays = MAX_LIVE_AGE_DAYS } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, reason: 'production snapshot is not a JSON object' };
  }
  const kind = String(snapshot.kind ?? 'unknown');
  const weekEnding = String(snapshot.weekEnding ?? '');
  const base = { kind, weekEnding };
  if (kind !== 'live') {
    return { ok: false, reason: `production is serving ${kind} data, not live CDC data`, ...base };
  }
  if (!ISO_DATE.test(weekEnding)) {
    return { ok: false, reason: `live snapshot has no valid weekEnding (got ${JSON.stringify(weekEnding)})`, ...base };
  }
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length === 0) {
    return { ok: false, reason: 'live snapshot names no upstream sources', ...base };
  }
  const jurisdictions = Object.keys(snapshot.states || {}).length;
  if (jurisdictions !== EXPECTED_JURISDICTIONS) {
    return { ok: false, reason: `live snapshot covers ${jurisdictions} jurisdictions, expected ${EXPECTED_JURISDICTIONS}`, ...base };
  }
  const ageDays = liveAgeDays(weekEnding, now);
  if (!Number.isFinite(ageDays)) {
    return { ok: false, reason: `could not compute the age of week ${weekEnding}`, ...base };
  }
  if (ageDays < 0) {
    return { ok: false, reason: `live week ${weekEnding} is dated after ${now.toISOString().slice(0, 10)}`, ...base, ageDays };
  }
  if (ageDays > maxAgeDays) {
    return { ok: false, reason: `live week ${weekEnding} is ${ageDays} days old; the ceiling is ${maxAgeDays}`, ...base, ageDays };
  }
  const usable = states.filter((state) => {
    const signal = snapshot.states?.[state.abbr];
    return signal?.weekEnding === weekEnding && hasSignalData(signal);
  }).length;
  if (usable < MIN_LIVE_STATES) {
    return { ok: false, reason: `live snapshot has usable observations for only ${usable} jurisdictions at ${weekEnding}, minimum ${MIN_LIVE_STATES}; keys and retrieval timestamps do not establish coverage`, ...base, ageDays, usableJurisdictions: usable };
  }
  return { ok: true, reason: `live CDC week ending ${weekEnding}, ${ageDays} day(s) old (ceiling ${maxAgeDays}); ${usable} jurisdictions with usable observations`, ...base, ageDays, usableJurisdictions: usable };
}

/** Fetch with retries: a transient blip must not look like a stopped pipeline. */
export async function fetchSnapshot(url, { attempts = 3, delayMs = 2000 } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (i < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * i));
    }
  }
  throw lastError;
}

function report(result) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const mark = result.ok ? '✅' : '❌';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production data watchdog\n\n${mark} ${result.reason}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`expected --name value pairs, got ${JSON.stringify(argv.slice(i, i + 2))}`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const maxAgeDays = args['max-age-days'] === undefined ? MAX_LIVE_AGE_DAYS : Number(args['max-age-days']);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    console.error('--max-age-days must be a non-negative integer');
    process.exitCode = 2;
    return;
  }
  const now = args.now ? new Date(`${args.now}T12:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error('--now must be a YYYY-MM-DD date');
    process.exitCode = 2;
    return;
  }
  let snapshot;
  try {
    snapshot = args.file ? JSON.parse(readFileSync(args.file, 'utf8')) : await fetchSnapshot(args.url || DEFAULT_URL);
  } catch (err) {
    report({ ok: false, reason: `production snapshot is unreadable: ${err.message}` });
    return;
  }
  report(assessProduction(snapshot, { now, maxAgeDays }));
}

// pathToFileURL, not a string splice: `file://${argv[1]}` never matches on
// Windows (backslashes, drive letters), where the CLI would then exit 0
// without ever running. The truthiness guard first: argv[1] is absent for
// eval/REPL-style imports, and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
