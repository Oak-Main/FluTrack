import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessProduction, fetchSnapshot } from '../build/staleness-alarm.mjs';
import { states } from '../src/scripts/states-data.js';
import { MAX_LIVE_AGE_DAYS } from '../build/lib/live-snapshot.mjs';

const NOW = new Date('2026-10-08T12:00:00Z');
const CLI = fileURLToPath(new URL('../build/staleness-alarm.mjs', import.meta.url));
const JURISDICTIONS = Object.fromEntries(states.map(({abbr}) => [abbr, { weekEnding: '2026-09-26', ariLevel: 1 }]));

/** A snapshot shaped the way build/lib/live-snapshot.mjs writes one. */
const live = (over = {}) => ({
  kind: 'live',
  weekEnding: '2026-09-26',
  sources: ['NSSP Emergency Department Visits'],
  states: Object.fromEntries(Object.entries(JURISDICTIONS).map(([abbr, signal]) => [abbr, { ...signal, weekEnding: over.weekEnding || '2026-09-26' }])),
  ...over,
});

/** The ISO date `days` days before NOW. */
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** Hand a snapshot to a callback as a file on disk, then remove it. */
function withSnapshotFile(value, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'staleness-alarm-'));
  try {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('a live week inside the ceiling passes, and says how old it is', () => {
  const r = assessProduction(live(), { now: NOW });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ageDays, 12);
  assert.match(r.reason, /12 day\(s\) old/);
});

test('the ceiling is inclusive: at the limit passes, one day past it fails', () => {
  assert.equal(assessProduction(live({ weekEnding: daysAgo(MAX_LIVE_AGE_DAYS) }), { now: NOW }).ok, true);
  const past = assessProduction(live({ weekEnding: daysAgo(MAX_LIVE_AGE_DAYS + 1) }), { now: NOW });
  assert.equal(past.ok, false);
  assert.match(past.reason, new RegExp(`the ceiling is ${MAX_LIVE_AGE_DAYS}`));
});

test('a tighter ceiling is honoured', () => {
  assert.equal(assessProduction(live(), { now: NOW, maxAgeDays: 11 }).ok, false);
  assert.equal(assessProduction(live(), { now: NOW, maxAgeDays: 12 }).ok, true);
});

test('sample data is never production data, however fresh its date looks', () => {
  const r = assessProduction(live({ kind: 'sample' }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /serving sample data, not live CDC data/);
});

test('a live week older than the ceiling fails and names its age', () => {
  const r = assessProduction(live({ weekEnding: '2026-08-01' }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /2026-08-01 is 68 days old/);
});

test('a future-dated week fails rather than passing as fresh', () => {
  const r = assessProduction(live({ weekEnding: '2026-10-20' }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /dated after 2026-10-08/);
});

test('a malformed or missing week-ending date fails closed', () => {
  for (const bad of ['10/08/2026', '2026-9-26', '', undefined]) {
    assert.equal(assessProduction(live({ weekEnding: bad }), { now: NOW }).ok, false, JSON.stringify(bad));
  }
});

test('a live snapshot naming no upstream sources fails', () => {
  assert.equal(assessProduction(live({ sources: [] }), { now: NOW }).ok, false);
  assert.equal(assessProduction(live({ sources: undefined }), { now: NOW }).ok, false);
});

test('a partial snapshot, short of the 51 jurisdictions, fails', () => {
  const short = Object.fromEntries(Object.entries(JURISDICTIONS).slice(0, 50));
  const r = assessProduction(live({ states: short }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /covers 50 jurisdictions, expected 51/);
});

test('51 keys and a fresh generated timestamp cannot validate empty observations', () => {
  const snapshot = live({ generatedAt: NOW.toISOString(), statesWithData: 51, states: Object.fromEntries(states.map(({ abbr }) => [abbr, {}])) });
  const result = assessProduction(snapshot, { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.reason, /usable observations for only 0 jurisdictions/);
});

test('old or explicitly unavailable numeric leftovers do not count as usable coverage', () => {
  const snapshot = live({ states: Object.fromEntries(states.map(({ abbr }) => [abbr, {
    weekEnding: '2026-09-26', ariLevel: 1,
    provenance: { metrics: { ari: { status: 'unavailable', contributes: false } } },
  }])) });
  assert.equal(assessProduction(snapshot, { now: NOW }).ok, false);
  for (const signal of Object.values(snapshot.states)) {
    signal.provenance.metrics.ari = { status: 'available', contributes: true };
    signal.weekEnding = '2026-09-19';
  }
  assert.equal(assessProduction(snapshot, { now: NOW }).ok, false, 'different observation periods are not latest-period coverage');
});

test('a missing or non-object snapshot fails closed', () => {
  assert.equal(assessProduction(null, { now: NOW }).ok, false);
  assert.equal(assessProduction('<html>not json</html>', { now: NOW }).ok, false);
});

test('fetchSnapshot retries a transient failure, then succeeds', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => live() };
  };
  try {
    const body = await fetchSnapshot('https://example.invalid/snapshot.json', { delayMs: 0 });
    assert.equal(body.kind, 'live');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchSnapshot gives up loudly after its attempts, rather than passing', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('socket hang up');
  };
  try {
    await assert.rejects(() => fetchSnapshot('https://example.invalid/snapshot.json', { attempts: 3, delayMs: 0 }), /socket hang up/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('the CLI passes a fresh live snapshot with exit 0', () => {
  withSnapshotFile(live(), (file) => {
    const run = runCli(['--file', file, '--now', '2026-10-08']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^PASS: live CDC week ending 2026-09-26, 12 day\(s\) old/m);
  });
});

test('the CLI fails closed on sample data, a stale week, and an unreadable file', () => {
  withSnapshotFile(live({ kind: 'sample' }), (file) => {
    const run = runCli(['--file', file, '--now', '2026-10-08']);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^FAIL: production is serving sample data/m);
  });
  withSnapshotFile(live({ weekEnding: '2026-08-01' }), (file) => {
    assert.equal(runCli(['--file', file, '--now', '2026-10-08']).status, 1);
  });
  const missing = runCli(['--file', join(tmpdir(), 'no-such-staleness-alarm-snapshot.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^FAIL: production snapshot is unreadable/m);
});

test('bad arguments are a usage error (exit 2), never a verdict', () => {
  assert.equal(runCli(['--max-age-days', 'soon']).status, 2);
  assert.equal(runCli(['--now', 'not-a-date']).status, 2);
  assert.equal(runCli(['--now']).status, 2);
  assert.equal(runCli(['stray']).status, 2);
});

test('importing the CLI without an entry argument (eval/REPL) neither throws nor runs the alarm', () => {
  // pathToFileURL(undefined) throws at import time without the truthiness
  // guard, taking out every exported function with it.
  const url = new URL('../build/staleness-alarm.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /^(PASS|FAIL):/m, 'the alarm must not judge production on a bare import');
});
