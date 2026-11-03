import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeModel } from '../src/scripts/model.js';
import { weekInBriefContent, stateIntro, stateReadingSummary, stateFaqs, sourceEvidence } from '../src/scripts/state-narrative.js';
import { statePage } from '../build/pages/state.mjs';
import { stateOgSvg, ogSvg } from '../build/lib/assets.mjs';
import { stateChip } from '../src/scripts/render.js';
import { site } from '../build/lib/site.mjs';
import { states } from '../src/scripts/states-data.js';

const state = states.find((s) => s.abbr === 'CA');
const weekEnding = '2026-09-26';
const provenance = { kind: 'live', live: true, weekEnding, now: '2026-10-09T12:00:00Z' };
const signals = (series = [1, 1, 1, 1.2], over = {}) => ({
  weekEnding, edCombinedSeries: series, pathogens: {
    influenza: { edPercentSeries: series },
    covid: { edPercentSeries: [0.1, 0.1, 0.1, 0.1] },
    rsv: { edPercentSeries: [0.1, 0.1, 0.1, 0.08] },
  }, ...over,
});
const render = (data, p = provenance) => weekInBriefContent(state, computeModel(data, p), weekEnding, p);

test('up/down/flat map to the actual model contract, with the correct baseline', () => {
  for (const [series, expected] of [
    [[1, 1, 1, 1.2], /was <strong>rising<\/strong> \(\+20%\)/],
    [[1, 1, 1, 0.8], /was <strong>falling<\/strong> \(−20%\)/],
    [[1, 1, 1, 1], /was <strong>holding steady<\/strong>/],
  ]) {
    const html = render(signals(series));
    assert.match(html, expected);
    assert.match(html, /latest observation compared with the mean of up to three prior observations/);
    assert.doesNotMatch(html, /week over week|this week|right now/);
  }
});

test('fastest-rising selection uses up and compares the same measurement only', () => {
  const html = render(signals([1, 1, 1, 1.2]));
  assert.match(html, /Largest relative increase among available series for the share of emergency-department visits with the same comparison observations: <strong>Flu<\/strong>, \+20%/);
  assert.doesNotMatch(html, /No virus is rising|contributing the most/);
});

test('undefined relative growth is not ranked and two capped changes compare actual evidence', () => {
  const zero = render(signals([0, 0, 0, 0.1], { pathogens: { rsv: { edPercentSeries: [0, 0, 0, 0.1] } } }));
  assert.match(zero, /increased from zero; no percentage change can be calculated from a zero baseline/);
  assert.doesNotMatch(zero, /\+100%|Largest relative increase/);
  const capped = render(signals([1, 1, 1, 1.2], { pathogens: {
    influenza: { edPercentSeries: [0, 0, 0.1, 0.2] },
    covid: { edPercentSeries: [0.1, 0.1, 0.1, 0.4] },
    rsv: { edPercentSeries: [0, 0, 0, 0.1] },
  } }));
  assert.match(capped, /Largest relative increase[^<]+<strong>Flu<\/strong>, \+200% or more \(display capped\)/);
  assert.match(capped, /Rankings use the actual uncapped comparisons/);
  assert.match(capped, /zero-baseline series are not ranked/);
  assert.doesNotMatch(capped, /<strong>Flu and COVID-19<\/strong>, \+200%|Largest relative increase[^<]+<strong>RSV/);
  const faq = stateFaqs(state, computeModel(signals(), provenance), signals(), weekEnding, provenance)[1].a;
  assert.match(faq, /zero prior mean has no defined percentage change/);
  assert.match(faq, /Capped percentages are labeled/);
});

test('insufficient history and missing pathogens never become stable or reassuring', () => {
  const html = render(signals([1], { pathogens: { influenza: { edPercentSeries: [1] } } }));
  assert.match(html, /not enough comparable observations/);
  assert.match(html, /complete comparison of all three pathogen trends is unavailable/);
  assert.doesNotMatch(html, /is <strong>holding steady|No virus is rising|COVID-19<\/strong>|RSV<\/strong>/);
  const noData = computeModel({ pathogens: {} }, provenance);
  assert.equal(noData.level, null);
  assert.match(stateReadingSummary(state, noData, weekEnding, provenance), /Missing data does not mean no illness/);
});

test('sample and stale snapshots cannot produce unsupported observational conclusions', () => {
  for (const [p, expected] of [
    [{ ...provenance, kind: 'sample', live: false }, /illustrative sample/],
    [{ ...provenance, stale: true }, /Historical observations ending Sep 26, 2026/],
    [{ ...provenance, weekEnding: '2026-08-01' }, /Historical observations/],
  ]) {
    const data = signals([1, 1, 1, 1.2], { weekEnding: p.weekEnding });
    const model = computeModel(data, p);
    const html = weekInBriefContent(state, model, p.weekEnding, p);
    assert.match(html, expected);
    assert.doesNotMatch(html, /was <strong>rising|Highest available pathogen|Largest relative increase/);
  }
});

test('explicit unverified provenance cannot produce current levels, source claims or ranked trends', () => {
  const data = signals([1, 2], { provenance: { kind: 'unknown' } });
  const model = computeModel(data, provenance);
  const summary = stateReadingSummary(state, model, weekEnding, provenance);
  assert.match(summary, /provenance.*not verified/);
  assert.doesNotMatch(summary, /was (Minimal|Low|Moderate|High|Very High)/);
  const intro = stateIntro(state, [], model, data, provenance);
  assert.match(intro, /provenance.*unverified/);
  assert.doesNotMatch(intro, /contributing readings for|this live reading/);
  assert.doesNotMatch(weekInBriefContent(state, model, weekEnding, provenance), /Highest available|Largest relative increase|was <strong>/);
});

test('only contributing available sources are listed and live positivity stays unavailable', () => {
  const data = signals([1, 1, 1, 1.2], {
    wastewaterSeries: [9, 9], positivityCombined: 99,
    provenance: { ...provenance, metrics: { wastewater: { status: 'unavailable', contributes: false }, positivity: { status: 'unavailable', contributes: false } } },
  });
  const model = computeModel(data, provenance);
  assert.deepEqual(model.contributors, ['edVisits']);
  const intro = stateIntro(state, [], model, data, provenance);
  assert.match(intro, /contributing readings for emergency-department visit percentages/);
  assert.match(intro, /Laboratory positivity has no live adapter/);
  assert.doesNotMatch(intro, /four public|influenza threat level|readings for .*wastewater/);
});

test('an ARI-only index cannot claim specific pathogen observations exist', () => {
  const data = { weekEnding, ariLevel: 1, pathogens: {} };
  const model = computeModel(data, provenance);
  assert.deepEqual(model.contributors, ['ari']);
  const summary = stateReadingSummary(state, model, weekEnding, provenance);
  assert.match(summary, /available surveillance inputs; pathogen-specific readings may be missing/);
  assert.doesNotMatch(summary, /combines available influenza/);
  assert.match(render(data), /complete comparison of all three pathogen trends is unavailable/);
});

test('date evidence keeps unknown publication distinct from source update and retrieval', () => {
  const data = signals([1, 1, 1, 1.2], { provenance: { ...provenance, metrics: { edVisits: {
    status: 'available', contributes: true, observationPeriod: { start: '2026-09-20', end: weekEnding, weekEnding },
    publicationDate: null, upstreamUpdatedAt: '2026-10-02 16:03:50', retrievedAt: '2026-10-09T00:11:22.744Z',
    requestRetrievedAt: '2026-10-09T12:00:00Z', cacheStale: true, coverage: { reportingPathogens: ['influenza', 'covid', 'rsv'] },
  } } } });
  const html = sourceEvidence(data, computeModel(data, provenance), provenance);
  assert.match(html, /Sep 20, 2026 to Sep 26, 2026/);
  assert.match(html, /Not supplied<\/td><td>2026-10-02 16:03:50/);
  assert.match(html, /warm copy past cache TTL/);
  assert.match(html, /3\/3 pathogen ED readings/);
});

test('Iowa missing NSSP readings name the documented vendor gap without implying no illness', () => {
  const data = { weekEnding, wastewaterSeries: [3, 4], provenance: { ...provenance, geography: { level: 'state', abbr: 'IA', name: 'Iowa' }, metrics: {
    edVisits: { status: 'missing', contributes: false }, ari: { status: 'missing', contributes: false }, wastewater: { status: 'available', contributes: true },
  } } };
  const model = computeModel(data, provenance);
  const html = sourceEvidence(data, model, provenance);
  assert.match(html, /data-source-gap="iowa-nssp"/);
  assert.match(html, /https:\/\/www\.cdc\.gov\/respiratory-viruses\/data\/activity-levels\.html/);
  assert.match(html, /updated October 2, 2026/);
  assert.match(html, /feed ended on May 6, 2026/);
  assert.match(html, /week ending May 2, 2026/);
  assert.match(html, /weeks ending May 9, 2026 onward are unavailable/);
  assert.match(html, /reporting gap does not mean no illness in Iowa/);
  const otherState = { ...data, provenance: { ...data.provenance, geography: { level: 'state', abbr: 'CA', name: 'California' } } };
  assert.doesNotMatch(sourceEvidence(otherState, computeModel(otherState, provenance), provenance), /data-source-gap="iowa-nssp"/);
  const sampleData = { ...data, provenance: { ...data.provenance, kind: 'sample', live: false } };
  assert.doesNotMatch(sourceEvidence(sampleData, computeModel(sampleData), { kind: 'sample', live: false }), /data-source-gap="iowa-nssp"/);
  const restored = { ...data, ariLevel: 0, edCombinedSeries: [1, 1], provenance: { ...data.provenance, metrics: { ...data.provenance.metrics, edVisits: { status: 'available', contributes: true }, ari: { status: 'available', contributes: true } } } };
  assert.doesNotMatch(sourceEvidence(restored, computeModel(restored), provenance), /data-source-gap="iowa-nssp"/);
});

test('static summary, metadata and FAQ agree on sample/live/stale/missing evidence', () => {
  for (const p of [provenance, { ...provenance, kind: 'sample', live: false }, { ...provenance, stale: true }]) {
    for (const data of [signals(), { weekEnding, pathogens: {} }]) {
      const model = computeModel(data, p);
      const ctx = { site, states: [state], weekEnding, provenance: p, models: new Map([['CA', { model, signals: data }]]), render: { stateChip } };
      const page = statePage(ctx, state);
      const summary = stateReadingSummary(state, model, weekEnding, p);
      assert.equal(page.description, summary);
      assert.equal(page.jsonld.find((b) => b['@type'] === 'WebPage').description, summary);
      assert.equal(page.jsonld.find((b) => b['@type'] === 'FAQPage').mainEntity[0].acceptedAnswer.text, summary);
      assert.ok(page.body.includes(summary));
      assert.equal(stateFaqs(state, model, data, weekEnding, p)[0].a, `<p>${summary}</p>`);
    }
  }
});

test('standalone share cards state combined identity, period and sample/stale/missing caveats', () => {
  const cases = [
    [signals(), { ...provenance, kind: 'sample', live: false }, /Sample data/],
    [signals(), { ...provenance, stale: true }, /Historical observations/],
    [{ weekEnding, pathogens: {} }, provenance, /No usable reading/],
  ];
  for (const [data, p, expected] of cases) {
    const svg = stateOgSvg(site, state, computeModel(data, p), p);
    assert.match(svg, expected);
    assert.match(svg, /Combined respiratory index/);
    assert.match(svg, /Sep 26, 2026/);
    assert.doesNotMatch(svg, /Influenza threat|this week|right now/);
    if (!Object.keys(data.pathogens).length) assert.doesNotMatch(svg, /Holding steady/);
  }
});

test('default brand share art contains no invented jurisdiction severity', () => {
  const svg = ogSvg(site);
  assert.match(svg, /Illustrative map — no activity readings/);
  assert.doesNotMatch(svg, /Minimal|Very High|severity|threat level/);
  const tiles = [...svg.matchAll(/<rect x="\d+" y="\d+" width="40" height="40" rx="9" fill="([^"]+)"/g)];
  assert.equal(tiles.length, 51);
  assert.deepEqual([...new Set(tiles.map((match) => match[1]))], ['#5b6773']);
  const gradientIds = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(gradientIds).size, gradientIds.length, 'nested icon gradients cannot override the card background');
});
