import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeModel } from '../src/scripts/model.js';
import { arcGauge, pathogenTiles, provenanceBadge, provenanceStrip, severityMeter, signalRows, stateChip, threatCard, trendChip } from '../src/scripts/render.js';
import { observationWeek, readingStatus } from '../src/scripts/reading-provenance.js';

const state = { name: 'Maryland', abbr: 'MD' };
const context = { kind: 'live', live: true, weekEnding: '2026-09-26', now: '2026-10-09T12:00:00Z' };
const bundle = (series, provenance = {}) => ({
  weekEnding: '2026-09-26', edCombinedSeries: series,
  provenance: { kind: 'live', ...provenance },
  pathogens: { influenza: { edPercentSeries: series }, covid: { edPercentSeries: series } },
});

test('up, down and flat chips identify the comparison and selected measurement', () => {
  for (const [series, label] of [[[1, 1, 1, 2], 'Rising +100%'], [[4, 4, 4, 2], 'Falling −50%'], [[2, 2, 2, 2], 'Holding steady']]) {
    const model = computeModel(bundle(series), context);
    const html = trendChip(model.trend);
    assert.ok(html.includes(label), html);
    assert.match(html, /in the share of emergency-department visits vs prior-observation mean/);
    assert.match(html, /latest observation compared with the mean of up to three prior observations/);
    assert.doesNotMatch(html, /week.over.week/i);
  }
});

test('zero baselines never publish invented percentages and capped changes are explicitly bounded', () => {
  const zero = computeModel(bundle([0, 0, 0, 0.1]), context);
  const zeroHtml = trendChip(zero.trend) + pathogenTiles(zero);
  assert.match(zeroHtml, /increased from zero; no percentage change can be calculated from a zero baseline/);
  assert.match(zeroHtml, /trend--up/);
  assert.doesNotMatch(zeroHtml, /\+100%/);
  const unchanged = trendChip(computeModel(bundle([0, 0]), context).trend);
  assert.match(unchanged, /unchanged from zero; no percentage change can be calculated from a zero baseline/);
  assert.doesNotMatch(unchanged, /\+0%|no change%/);
  const capped = trendChip(computeModel(bundle([0, 0, 0.1, 0.2]), context).trend);
  assert.match(capped, /Rising \+200% or more \(display capped\)/);
  assert.doesNotMatch(capped, /Rising \+200% in|\+500%/);
});

test('insufficient history is unknown without a flat symbol, percent change or stable wording', () => {
  const model = computeModel(bundle([2]), context);
  const html = trendChip(model.trend);
  assert.match(html, /Not enough data to determine trend/);
  assert.doesNotMatch(html, /Holding steady|trend--flat|trend__shape|\d+%/);
  assert.match(pathogenTiles(model), /No usable reading; no data does not mean no illness/);
  assert.match(severityMeter(null), /aria-label="No data: severity unavailable"/);
  assert.doesNotMatch(severityMeter(null), /aria-label="[^"]*Minimal/);
});

test('sample provenance cannot become live or a health claim in cards and tiles', () => {
  const model = computeModel(bundle([1, 2], { kind: 'sample' }), context);
  const html = threatCard(state, model, { provenance: context }) + pathogenTiles(model, { provenance: context });
  assert.match(html, /Sample data/);
  assert.match(html, /Illustrative sample index only; these figures do not describe illness in Maryland/);
  assert.match(html, /Sample trend: Rising/);
  assert.match(html, /Illustrative sample reading/);
  assert.doesNotMatch(html, /Reported CDC data|Live CDC data/);
});

test('a fresh build timestamp does not repair a stale observation period', () => {
  const signals = { ...bundle([1, 2]), weekEnding: '2026-08-01' };
  const model = computeModel(signals, { ...context, generatedAt: '2026-10-09T12:00:00Z' });
  assert.equal(readingStatus(model), 'stale');
  assert.equal(observationWeek(model), '2026-08-01');
  const html = threatCard(state, model) + pathogenTiles(model);
  assert.match(html, /Historical CDC data/);
  assert.match(html, /This stale snapshot does not establish current conditions/);
  assert.match(html, /observations for week ending Aug 1, 2026/);
  assert.match(html, /Historical trend/);
  assert.doesNotMatch(html, /as of Oct 9/);
});

test('signals and source tags credit only contributing measurements with their own dates', () => {
  const signals = {
    ...bundle([1, 2]), ariLevel: 0, ariLabel: 'Very Low', positivityCombined: 99, wastewaterSeries: [9, 9],
    provenance: { kind: 'live', metrics: {
      edVisits: { status: 'available', contributes: true, observationPeriod: { weekEnding: '2026-09-26' }, publicationDate: '2026-10-02', retrievedAt: '2026-10-08T04:00:00Z' },
      ari: { status: 'available', contributes: true },
      positivity: { status: 'unavailable', contributes: false },
      wastewater: { status: 'available', contributes: false, observationPeriod: { weekEnding: '2026-09-19' } },
    } },
  };
  const model = computeModel(signals, context);
  const html = signalRows(signals, { model });
  assert.match(html, /Acute respiratory illness activity/);
  assert.match(html, /Combined flu, RSV and COVID-19 ED visits/);
  assert.match(html, /Observation week ending Sep 26, 2026/);
  assert.match(html, /Published Oct 2, 2026/);
  assert.match(html, /Retrieved 2026-10-08T04:00:00Z/);
  assert.doesNotMatch(html, /99\.0%|Wastewater viral activity input|NREVSS/);
  assert.match(html, /Laboratory test positivity is unavailable/);
  assert.doesNotMatch(provenanceStrip({ ...context, sources: [] }), /NREVSS|NWSS|>NSSP</);
});

test('absence of a combined reading does not give the gauge a minimal needle', () => {
  const html = threatCard(state, computeModel({}, context));
  assert.match(html, /Missing surveillance data does not mean no illness/);
  assert.doesNotMatch(html, /class="gauge__needle"/);
  assert.doesNotMatch(html, /<article class="threat" data-sev="0"/);
});

test('comparison chips qualify sample and historical levels and keep their own observation date', () => {
  const sample = stateChip({ ...state, slug: 'maryland' }, computeModel(bundle([1, 2], { kind: 'sample' }), context));
  assert.match(sample, /\(sample\)/);
  assert.match(sample, /title="Illustrative period Sep 26, 2026"/);
  const historical = stateChip({ ...state, slug: 'maryland' }, computeModel({ ...bundle([1, 2]), weekEnding: '2026-08-01' }, context));
  assert.match(historical, /\(historical\)/);
  assert.match(historical, /title="Observation week ending Aug 1, 2026"/);
});

test('unknown provenance is unverified in both strip and badge, without illustrative source claims', () => {
  for (const provenance of [{}, { kind: 'unknown', live: false, sources: ['NSSP'] }]) {
    const strip = provenanceStrip(provenance);
    assert.match(strip, /Unverified provenance/);
    assert.match(provenanceBadge(provenance), /Unverified provenance/);
    assert.doesNotMatch(strip, /Sample data|Demonstration only|Illustrative inputs|>NSSP</);
  }
});

test('unverified numeric inputs have no health level, colored token, gauge needle or observed trend', () => {
  const signals = bundle([1, 2], { kind: 'unknown' });
  const model = computeModel(signals, context);
  const card = threatCard(state, model, { provenance: context });
  const tiles = pathogenTiles(model, { provenance: context });
  assert.match(card, /id="threat-reading">Unknown<\/p>/);
  assert.match(card, /Unverified provenance/);
  assert.match(card, /does not establish current conditions/);
  assert.doesNotMatch(card + tiles, /data-sev="\d"|gauge__needle|trend--(?:up|down|flat)|Rising|Falling|Holding steady/);
  assert.match(tiles, /Unverified provenance; current conditions unknown/);
  assert.doesNotMatch(tiles, /level-token__word">(?:Minimal|Low|Moderate|High|Very High)/);
  assert.doesNotMatch(arcGauge(model, { provenance: context }), /gauge__needle|data-sev/);
  assert.doesNotMatch(stateChip({ ...state, slug: 'maryland' }, model), /data-sev|aria-label="level/);
  assert.match(signalRows(signals, { model, provenance: context }), /No contributing signal detail/);
});
