import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyTakeaways, takeawaysBlock } from '../src/scripts/takeaways.js';
import { computeModel } from '../src/scripts/model.js';
import { statePage } from '../build/pages/state.mjs';
import { generateSnapshot } from '../build/lib/snapshot.mjs';
import { states } from '../src/scripts/states-data.js';
import { stateChip } from '../src/scripts/render.js';
import { site } from '../build/lib/site.mjs';

/** Most recent Saturday on or before today, then n weeks further back.
 * Keeps fixtures inside the live pipeline's 21-day observation window
 * forever — the frozen 2026-09-26 anchor aged out on 2026-10-18 and
 * broke CI (assembleLiveSignals drops weeks older than the window). */
function saturdayWeeksBack(n) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const dow = d.getUTCDay(); // 6 = Saturday
  d.setUTCDate(d.getUTCDate() - ((dow + 1) % 7) - n * 7);
  return d.toISOString().slice(0, 10);
}

// Signal bundles shaped like the live adapter's output, with the real CDC
// values for the week ending 2026-09-26 (NSSP ED %, NWSS site medians, ARI).
const MD = {
  provenance: { kind: 'live', now: '2026-10-09T12:00:00Z' },
  ariLevel: 0, ariLabel: 'Very Low', positivityCombined: null, weekEnding: saturdayWeeksBack(2),
  edCombinedSeries: [0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.5, 0.6, 0.6],
  wastewaterSeries: [],
  pathogens: {
    influenza: { edPercentSeries: [0.1, 0, 0, 0, 0, 0.1, 0, 0.1, 0.1, 0.1, 0.2, 0.2], wastewaterSeries: [], positivitySeries: [] },
    covid: { edPercentSeries: [0, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.4, 0.4], wastewaterSeries: [], positivitySeries: [] },
    rsv: { edPercentSeries: Array(12).fill(0), wastewaterSeries: [], positivitySeries: [] },
  },
};
const GA = {
  ...MD,
  edCombinedSeries: [0.1, 0.3, 0.2, 0.4, 0.6, 0.8, 0.9, 1, 0.8, 0.7, 0.7, 0.9],
  wastewaterSeries: [9.59, 7.75, 7.22],
  pathogens: {
    influenza: { edPercentSeries: [0, 0.1, 0, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3], wastewaterSeries: [1, 1, 1], positivitySeries: [] },
    covid: { edPercentSeries: [0.1, 0.2, 0.2, 0.4, 0.5, 0.7, 0.8, 0.9, 0.7, 0.6, 0.5, 0.5], wastewaterSeries: [9.59, 7.75, 7.22], positivitySeries: [] },
    rsv: { edPercentSeries: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1], wastewaterSeries: [1, 1, 1], positivitySeries: [] },
  },
};
const find = (abbr) => states.find((s) => s.abbr === abbr);
const texts = (items) => items.map((t) => `${t.lead}: ${t.text}`).join('\n');
const verifiedPeer = (peer) => ({ ...peer, provenance: MD.provenance, weekEnding: MD.weekEnding });

test('NOTHING is said on sample data — no claim about a real state from fixture numbers', () => {
  const snap = generateSnapshot();
  for (const st of states) {
    const sig = snap.states[st.abbr];
    assert.deepEqual(weeklyTakeaways(st, computeModel(sig), sig, { live: false }), [], st.abbr);
    assert.equal(takeawaysBlock(st, computeModel(sig), sig, { live: false }), '', st.abbr);
  }
});

test('nothing is said when the state has no level at all', () => {
  const empty = { pathogens: {} };
  assert.deepEqual(weeklyTakeaways(find('MD'), computeModel(empty), empty, { live: true }), []);
});

test('Maryland (no usable wastewater): says what the level rests on instead of inventing a reading', () => {
  const items = weeklyTakeaways(find('MD'), computeModel(MD), MD, { live: true, peers: [{ name: 'Virginia', level: 0 }, { name: 'Delaware', level: 0 }].map(verifiedPeer) });
  const all = texts(items);
  assert.ok(items.length >= 3 && items.length <= 5);
  assert.match(all, /^Overall: The combined respiratory index for Maryland is minimal for the reported observation period\./);
  assert.match(all, /The share of emergency-department visits was edging up compared with the mean of up to three prior observations\./);
  assert.match(all, /CDC reported the state's broader acute respiratory illness activity as Very Low\./);
  assert.match(all, /Flu: Influenza accounted for 0\.2% of emergency-department visits in the reported period\./);
  assert.match(all, /COVID-19 accounted for the largest share of visits among these three viruses in Maryland’s reporting emergency departments \(0\.4%, against 0\.2% flu and 0\.0% RSV\)/);
  assert.match(all, /No contributing wastewater reading is available for Maryland in the reported period, so this index rests on CDC’s acute respiratory illness rating and emergency-department visits\./);
  assert.match(all, /The 2 other states with usable readings for the same observation period in Maryland’s HHS region are also at a minimal index level\./);
});

test('Georgia: states separate wastewater readings without ranking pathogen prevalence', () => {
  const items = weeklyTakeaways(find('GA'), computeModel(GA), GA, { live: true, peers: [{ name: 'Alabama', level: 0 }, { name: 'Florida', level: 0 }].map(verifiedPeer) });
  const all = texts(items);
  assert.match(all, /COVID-19 7\.2 \(high on FluTrack's scale\)/);
  assert.match(all, /These indices are measured against each pathogen's baseline; they do not rank how common the viruses are\./);
  assert.doesNotMatch(all, /most viral activity/);
  assert.match(all, /Georgia has the highest available index level among the 2 other states with usable readings for the same observation period in Georgia’s HHS region — 2 of 2 compared states are lower\./);
});

test('zero-baseline and capped comparisons are qualified without invented percentage headlines', () => {
  const zero = { ...MD, edCombinedSeries: [0, 0, 0, 0.1], pathogens: { influenza: { edPercentSeries: [0, 0, 0, 0.1] } } };
  const zeroText = texts(weeklyTakeaways(find('GA'), computeModel(zero), zero, { live: true }));
  assert.match(zeroText, /share of emergency-department visits increased from zero compared with the mean of up to three prior observations/);
  assert.match(zeroText, /relative percentage change is undefined with a zero baseline/);
  assert.doesNotMatch(zeroText, /\+100%/);
  const capped = { ...MD, edCombinedSeries: [0, 0, 0.1, 0.2], pathogens: { influenza: { edPercentSeries: [0, 0, 0.1, 0.2] } } };
  const cappedText = texts(weeklyTakeaways(find('VT'), computeModel(capped), capped, { live: true }));
  assert.match(cappedText, /relative percentage change exceeds the model cap; the capped value is not the actual comparison/);
  assert.doesNotMatch(cappedText, /\+200%|\+500%/);
});

test('regional rank states ties instead of claiming a sole highest or lowest', () => {
  const region = (peers) => texts(weeklyTakeaways(find('GA'), computeModel(GA), GA, { live: true, peers: peers.map(verifiedPeer) })).split('\n').at(-1);
  // Georgia is Low (1) on these signals.
  assert.match(region([{ name: 'A', level: 0 }, { name: 'B', level: 1 }, { name: 'C', level: 0 }]), /Georgia is tied for the highest available index level among the 3 other states with usable readings for the same observation period in Georgia’s HHS region — 2 of 3 compared states are lower\./);
  assert.match(region([{ name: 'A', level: 2 }, { name: 'B', level: 1 }]), /Georgia is tied for the lowest available index level among the 2 other states with usable readings for the same observation period in Georgia’s HHS region — 1 of 2 compared states is higher\./);
  assert.match(region([{ name: 'A', level: 2 }, { name: 'B', level: 3 }]), /Georgia has the lowest available index level among the 2 other states with usable readings for the same observation period in Georgia’s HHS region — 2 of 2 compared states are higher\./);
  assert.match(region([{ name: 'A', level: 0 }, { name: 'B', level: 2 }]), /Among the 2 other states with usable readings for the same observation period in Georgia’s HHS region, 1 is at a higher index level and 1 lower\./);
});

test('partial HHS coverage is explicitly scoped to verified peers with usable same-period readings', () => {
  const peers = [
    verifiedPeer({ name: 'Available', level: 0 }),
    { name: 'Missing', level: null, provenance: MD.provenance, weekEnding: MD.weekEnding },
    { name: 'Stale', level: 4, provenance: { ...MD.provenance, stale: true }, weekEnding: MD.weekEnding },
    { name: 'Other period', level: 4, provenance: { ...MD.provenance, observationPeriod: { weekEnding: '2026-09-19' } }, weekEnding: '2026-09-19' },
    { name: 'Unverified', level: 4, provenance: { kind: 'unknown' }, weekEnding: MD.weekEnding },
    { name: 'Sample', level: 4, provenance: { kind: 'sample' }, weekEnding: MD.weekEnding },
  ];
  const text = weeklyTakeaways(find('GA'), computeModel(GA), GA, { live: true, peers }).find((item) => item.lead === 'Nearby states')?.text;
  assert.match(text, /highest available index level among the 1 other state with usable readings for the same observation period/);
  assert.match(text, /1 of 1 compared states is lower/);
  assert.doesNotMatch(text, /highest level in its HHS region|all \d+ other states|only other state/);
  const noUsable = weeklyTakeaways(find('GA'), computeModel(GA), GA, { live: true, peers: peers.slice(1) });
  assert.equal(noUsable.some((item) => item.lead === 'Nearby states'), false);
});

test('takeaways describe; they never advise, predict, or headline a percentage change', () => {
  for (const [abbr, sig] of [['MD', MD], ['GA', GA]]) {
    const all = texts(weeklyTakeaways(find(abbr), computeModel(sig), sig, { live: true, peers: [{ name: 'X', level: 2 }] }));
    assert.doesNotMatch(all, /\b(should|recommend|consider|avoid|will (rise|fall|peak)|expect|forecast|predict)\b/i);
    assert.doesNotMatch(all, /[+-]\d+%|\d+% (rise|increase|jump|drop)/i, 'no change-percentage headlines');
  }
});

test('possessives follow the state name (Texas’, not Texas’s)', () => {
  const all = texts(weeklyTakeaways(find('TX'), computeModel(MD), MD, { live: true }));
  assert.match(all, /Texas’ reporting emergency departments/);
  assert.doesNotMatch(all, /Texas’s/);
});

test('the rendered block escapes text and carries the week', () => {
  const html = takeawaysBlock({ name: 'A<b>' }, computeModel(MD), MD, { live: true, weekEnding: saturdayWeeksBack(2) });
  assert.ok(!html.includes('A<b>'), 'state name escaped');
  assert.match(html, /Week ending Sep 26, 2026/);
  assert.equal((html.match(/<li>/g) || []).length, 4, 'no peers → no region line');
});

// --- on the state report ---------------------------------------------------- //

function ctxFor(signalsByAbbr, live) {
  const models = new Map(states.map((st) => [st.abbr, { model: computeModel(signalsByAbbr[st.abbr]), signals: signalsByAbbr[st.abbr] }]));
  return { site, weekEnding: saturdayWeeksBack(2), provenance: { live }, states, models, render: { stateChip } };
}

test('state report: block present on live data, absent (empty region) on sample', () => {
  const liveSignals = Object.fromEntries(states.map((s) => [s.abbr, MD]));
  const live = statePage(ctxFor(liveSignals, true), find('MD'));
  assert.match(live.body, /<div data-region="takeaways"><section class="takeaways"/);
  assert.match(live.body, /Reported observations in Maryland, in plain English/);

  const sample = statePage(ctxFor(generateSnapshot().states, false), find('MD'));
  assert.match(sample.body, /<div data-region="takeaways"><\/div>/, 'region kept for the browser refresh to fill');
  assert.doesNotMatch(sample.body, /in plain English<\/h2>/);
});

test('explicit sample or stale provenance suppresses health takeaways even under a live option', () => {
  for (const provenance of [{ kind: 'sample' }, { kind: 'live', stale: true }, { kind: 'live', observationPeriod: { weekEnding: '2026-08-01' }, now: '2026-10-09T12:00:00Z' }]) {
    const signals = { ...MD, provenance };
    const model = computeModel(signals);
    assert.deepEqual(weeklyTakeaways(find('MD'), model, signals, { live: true }), []);
  }
});

test('insufficient history and a missing pathogen never become steady or reassuring', () => {
  const signals = { ariLevel: 0, provenance: MD.provenance, weekEnding: saturdayWeeksBack(2), edCombinedSeries: [0.3], pathogens: { covid: { edPercentSeries: [0.3] } } };
  const all = texts(weeklyTakeaways(find('MD'), computeModel(signals), signals, { live: true }));
  assert.match(all, /not enough history to determine a trend/);
  assert.match(all, /No usable influenza reading was available/);
  assert.match(all, /No data does not mean no influenza/);
  assert.doesNotMatch(all, /holding steady|no virus is rising|stable|no illness/i);
});

test('an unavailable source contributes neither copy nor historical numeric leftovers', () => {
  const signals = { ...GA, provenance: { kind: 'live', metrics: { wastewater: { status: 'unavailable' } } }, pathogens: Object.fromEntries(Object.entries(GA.pathogens).map(([key, p]) => [key, { ...p, provenance: { metrics: { wastewater: { status: 'unavailable' } } } }])) };
  const all = texts(weeklyTakeaways(find('GA'), computeModel(signals), signals, { live: true }));
  assert.match(all, /No contributing wastewater reading is available/);
  assert.doesNotMatch(all, /activity indices for Georgia|7\.2/);
});

test('an available wastewater reading cannot promote an older ED observation from a missing latest period', () => {
  const signals = {
    weekEnding: MD.weekEnding, provenance: MD.provenance, ariLevel: 0, wastewaterSeries: [3, 4],
    pathogens: {
      influenza: { edPercentSeries: [9, null], wastewaterSeries: [3, 4] },
      covid: { edPercentSeries: [1, 1] },
      rsv: { edPercentSeries: [0.1, 0.1] },
    },
  };
  const model = computeModel(signals);
  assert.deepEqual(model.pathogens.influenza.contributors, ['wastewater']);
  const items = weeklyTakeaways(find('MD'), model, signals, { live: true });
  const all = texts(items);
  assert.match(all, /influenza wastewater activity index was 4\.0/i);
  assert.doesNotMatch(all, /9\.0%|Influenza accounted for|Flu accounted for the largest share/);
  assert.equal(items.some((item) => item.lead === 'Emergency visits'), false, 'the three-virus comparison requires three current contributing ED readings');
});
