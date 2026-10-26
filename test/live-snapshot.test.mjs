import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSnapshot, liveSnapshot, liveAgeDays, MAX_LIVE_AGE_DAYS } from '../build/lib/live-snapshot.mjs';
import { generateSnapshot } from '../build/lib/snapshot.mjs';
import { shouldDeploy } from '../build/rebuild-gate.mjs';
import { states } from '../src/scripts/states-data.js';

// The build-time policy that decides whether pages are pre-rendered from live
// CDC data or the labeled sample. Every branch here changes what a crawler and
// a first-paint visitor are told about the data, so each one is pinned.

const NOW = new Date('2026-10-08T12:00:00Z');
const sample = generateSnapshot();
const loadSample = () => sample;
const fastRetry = { attempts: 3, backoffMs: [0] };

function liveResult(weekEnding = '2026-09-26') {
  return {
    weekEnding,
    statesWithData: 51,
    sources: ['NSSP Emergency Department Visits'],
    signalsByAbbr: new Map(states.map((st) => [st.abbr, { ariLevel: 0, edCombinedSeries: [0.5, 0.6], wastewaterSeries: [], positivityCombined: null, weekEnding, pathogens: {} }])),
  };
}

test('auto: a healthy feed pre-renders live data', async () => {
  const r = await resolveSnapshot({ mode: 'auto', loadSample, fetchLive: async () => liveResult(), now: NOW });
  assert.equal(r.live, true);
  assert.equal(r.snapshot.kind, 'live');
  assert.equal(r.snapshot.weekEnding, '2026-09-26');
  assert.equal(r.snapshot.generatedAt, NOW.toISOString());
  assert.deepEqual(r.snapshot.states.MD.edCombinedSeries, [0.5, 0.6], 'Map flattened to a JSON-able object');
});

test('auto: a failing feed falls back to the labeled sample after retrying', async () => {
  let calls = 0;
  const r = await resolveSnapshot({
    mode: 'auto', loadSample, now: NOW, ...fastRetry,
    fetchLive: async () => { calls += 1; throw new Error('HTTP 503'); },
  });
  assert.equal(calls, 3);
  assert.equal(r.live, false);
  assert.equal(r.snapshot.kind, 'sample');
  assert.match(r.reason, /HTTP 503/);
});

test('auto: a transient failure that recovers on retry is still live', async () => {
  let calls = 0;
  const r = await resolveSnapshot({
    mode: 'auto', loadSample, now: NOW, ...fastRetry,
    fetchLive: async () => { calls += 1; if (calls < 2) throw new Error('timeout'); return liveResult(); },
  });
  assert.equal(r.live, true);
  assert.equal(calls, 2);
});

test('require: a failing feed fails the build instead of shipping sample data', async () => {
  await assert.rejects(
    resolveSnapshot({ mode: 'require', loadSample, now: NOW, ...fastRetry, fetchLive: async () => { throw new Error('HTTP 403'); } }),
    /LIVE_PRERENDER=require.*HTTP 403/
  );
});

test(`a feed whose newest week is older than ${MAX_LIVE_AGE_DAYS} days is not pre-rendered as current`, async () => {
  let calls = 0;
  const stale = async () => { calls += 1; return liveResult('2026-09-05'); };
  const r = await resolveSnapshot({ mode: 'auto', loadSample, now: NOW, ...fastRetry, fetchLive: stale });
  assert.equal(r.live, false);
  assert.equal(calls, 1, 'staleness is not transient — no retries');
  assert.match(r.reason, /33 days old/);
  await assert.rejects(resolveSnapshot({ mode: 'require', loadSample, now: NOW, ...fastRetry, fetchLive: stale }), /days old/);
});

test('off: never touches the network', async () => {
  const r = await resolveSnapshot({ mode: 'off', loadSample, fetchLive: async () => assert.fail('fetched') });
  assert.equal(r.live, false);
  assert.equal(r.snapshot, sample);
});

test('an unknown LIVE_PRERENDER value is a configuration error, not a silent default', async () => {
  await assert.rejects(resolveSnapshot({ mode: 'yes', loadSample }), /must be one of auto, require, off/);
});

test('liveAgeDays measures whole days from the week-ending date', () => {
  assert.equal(liveAgeDays('2026-09-26', NOW), 12);
  assert.equal(liveAgeDays('not-a-date', NOW), Infinity);
});

test('liveSnapshot carries what the client needs to keep the live badge', () => {
  const snap = liveSnapshot(liveResult(), NOW);
  assert.equal(snap.kind, 'live');
  assert.deepEqual(snap.sources, ['NSSP Emergency Department Visits']);
  assert.equal(snap.statesWithData, 51);
  assert.ok(JSON.parse(JSON.stringify(snap)).states.MD, 'round-trips through JSON');
});

test('a fresh timestamp and 51 empty jurisdiction keys cannot pass the live snapshot gate', async () => {
  const empty = liveResult();
  empty.signalsByAbbr = new Map(states.map((st) => [st.abbr, { weekEnding: empty.weekEnding, ariLevel: null, edCombinedSeries: [null, NaN], wastewaterSeries: [], pathogens: {} }]));
  assert.throws(() => liveSnapshot(empty, NOW), /usable data for only 0 of 51/);
  await assert.rejects(resolveSnapshot({ mode: 'require', loadSample, now: NOW, ...fastRetry, fetchLive: async () => empty }), /usable data for only 0 of 51/);
});

test('the snapshot recounts usable coverage instead of trusting the reported total', () => {
  const partial = liveResult();
  partial.signalsByAbbr.delete('MD');
  const snap = liveSnapshot(partial, NOW);
  assert.equal(snap.statesWithData, 50);
  assert.equal(snap.coverage.usableJurisdictions, 50);
  assert.equal(snap.coverage.usableAbbrs.includes('MD'), false);
});

test('snapshot metadata retains source retrieval and unknown publication dates without replacing them with build time', () => {
  const live = liveResult();
  live.retrievedAt = '2026-10-08T10:00:00Z';
  live.sourceAvailability = [{ key: 'edVisits', publicationDates: [], retrievedAt: '2026-10-08T06:11:25.126Z', cacheStale: true }];
  live.signalsByAbbr.get('MD').provenance = { kind: 'live', metrics: { edVisits: { status: 'available', contributes: true, publicationDate: null, retrievedAt: '2026-10-08T06:11:25.126Z', observationPeriod: { weekEnding: '2026-09-26' } } } };
  const snap = liveSnapshot(live, NOW);
  assert.equal(snap.generatedAt, NOW.toISOString());
  assert.equal(snap.retrievedAt, '2026-10-08T10:00:00Z');
  assert.deepEqual(snap.sourceAvailability, live.sourceAvailability);
  assert.equal(snap.states.MD.provenance.metrics.edVisits.publicationDate, null);
  assert.equal(snap.states.MD.provenance.metrics.edVisits.observationPeriod.weekEnding, '2026-09-26');
});

test('future observation periods do not pass as current surveillance', async () => {
  const r = await resolveSnapshot({ mode: 'auto', loadSample, now: NOW, ...fastRetry, fetchLive: async () => liveResult('2026-10-17') });
  assert.equal(r.live, false);
  assert.equal(r.snapshot.kind, 'sample');
});

test('the snapshot gate rejects date-mismatched metrics even when their contribution flag is incorrectly true', () => {
  const live = liveResult();
  for (const signal of live.signalsByAbbr.values()) {
    signal.ariLevel = null;
    signal.provenance = { metrics: { edVisits: { status: 'available', contributes: true, observationPeriod: { weekEnding: '2026-09-19' } } } };
  }
  assert.throws(() => liveSnapshot(live, NOW), /usable data for only 0 of 51/);
});

test('explicit unknown state bindings cannot satisfy live snapshot coverage despite fresh timestamps and numbers', () => {
  const live = liveResult();
  for (const signal of live.signalsByAbbr.values()) signal.provenance = { kind: 'unknown' };
  assert.throws(() => liveSnapshot(live, NOW), /usable data for only 0 of 51/);
});

// --- weekly rebuild gate ---------------------------------------------------- //


test('rebuild gate: deploys a newer CDC week, skips the same week, never deploys sample', () => {
  const built = { kind: 'live', weekEnding: '2026-10-03' };
  assert.equal(shouldDeploy({ built, deployed: { kind: 'live', weekEnding: '2026-09-26' } }).deploy, true);
  assert.equal(shouldDeploy({ built, deployed: { kind: 'live', weekEnding: '2026-10-03' } }).deploy, false);
  assert.equal(shouldDeploy({ built, deployed: { kind: 'sample', weekEnding: '2026-10-02' } }).deploy, true, 'production on sample → replace it');
  assert.equal(shouldDeploy({ built, deployed: null }).deploy, true, 'unreadable production → deploy');
  assert.equal(shouldDeploy({ built, deployed: { kind: 'live', weekEnding: '2026-10-03' }, force: true }).deploy, true);
  assert.equal(shouldDeploy({ built: { kind: 'sample', weekEnding: '2026-10-02' }, deployed: null, force: true }).deploy, false, 'a sample build is never deployed, even forced');
});

test('rebuild gate: skips when the built week is older than what production already serves', () => {
  // The October 2026 failure shape, mirrored: production can end up ahead of a
  // retrying build (e.g. a push build landed first). An older live build must
  // not be deployed over a newer one, even by force.
  const deployed = { kind: 'live', weekEnding: '2026-10-17' };
  const r = shouldDeploy({ built: { kind: 'live', weekEnding: '2026-10-10' }, deployed });
  assert.equal(r.deploy, false);
  assert.match(r.reason, /already shows CDC week 2026-10-17/);
  assert.equal(shouldDeploy({ built: { kind: 'live', weekEnding: '2026-10-10' }, deployed, force: true }).deploy, true, 'force is the only way to redeploy an older week');
});
