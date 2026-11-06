import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestLive, ingestSnapshot, render, selectionAnnouncement } from '../src/scripts/app.js';
import { computeModel } from '../src/scripts/model.js';
import { nationalSignals } from '../src/scripts/aggregate.js';
import { stateChip } from '../src/scripts/render.js';
import { statePage } from '../build/pages/state.mjs';
import { site } from '../build/lib/site.mjs';
import { states } from '../src/scripts/states-data.js';
import { escapeHtml } from '../src/scripts/util.js';

const state = states.find((s) => s.abbr === 'MD');
const period = '2026-09-26';
const now = '2026-10-09T12:00:00Z';
const metric = { status: 'available', contributes: true, observationPeriod: { weekEnding: period }, publicationDate: null, retrievedAt: '2026-10-08T04:00:00Z' };
function fixture(kind = 'live', series = [1, 1, 1, 2], overrides = {}) {
  const evidence = { kind, observationPeriod: { weekEnding: period }, metrics: { edVisits: metric, positivity: { status: 'unavailable', contributes: false } }, ...overrides };
  return {
    kind, weekEnding: period, generatedAt: now, provenance: { now }, sources: ['NSSP Emergency Department Visits'],
    states: Object.fromEntries(states.map((s) => [s.abbr, {
      weekEnding: evidence.observationPeriod.weekEnding, edCombinedSeries: series, provenance: evidence,
      pathogens: {
        influenza: { edPercentSeries: series, provenance: evidence },
        covid: { edPercentSeries: [...series].reverse(), provenance: evidence },
        rsv: { edPercentSeries: [1], provenance: evidence },
      },
    }])),
  };
}

function pageFor(snapshot, selectedState = state) {
  const provenance = { ...snapshot.provenance, kind: snapshot.kind || 'unknown', live: snapshot.kind === 'live', weekEnding: snapshot.weekEnding, sources: snapshot.sources, generatedAt: snapshot.generatedAt };
  return statePage({
    site, states, provenance, weekEnding: snapshot.weekEnding, render: { stateChip },
    models: new Map(states.map((st) => [st.abbr, { model: computeModel(snapshot.states[st.abbr] || {}, provenance), signals: snapshot.states[st.abbr] || {} }])),
  }, selectedState);
}

function regionContent(html, name) {
  const match = new RegExp(`<([a-z]+)\\b[^>]*data-region="${name}"[^>]*>`).exec(html);
  assert.ok(match, `static region ${name} exists`);
  const start = match.index + match[0].length;
  const tag = match[1];
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 1;
  for (let token; (token = tags.exec(html)); ) {
    depth += token[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, token.index);
  }
  throw new Error(`Unclosed region ${name}`);
}

const unescape = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
class Element {
  constructor(html = '') { this.attributes = new Map(); this.innerHTML = html; }
  set innerHTML(value) { this._html = value; this._text = unescape(value.replace(/<[^>]*>/g, '')); }
  get innerHTML() { return this._html; }
  set textContent(value) { this._text = value; this._html = escapeHtml(value); }
  get textContent() { return this._text; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) || null; }
  removeAttribute(key) { this.attributes.delete(key); }
}

function documentFor(page) {
  const regions = new Map([...page.body.matchAll(/data-region="([^"]+)"/g)].map((m) => [m[1], new Element(regionContent(page.body, m[1]))]));
  const metas = new Map(['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]'].map((key) => [key, new Element()]));
  const scripts = page.jsonld.map((data) => { const e = new Element(); e.textContent = JSON.stringify(data); return e; });
  return {
    regions, metas, scripts,
    querySelector(selector) {
      const name = selector.match(/^\[data-region="([^"]+)"\]$/)?.[1];
      return name ? regions.get(name) || null : metas.get(selector) || null;
    },
    querySelectorAll(selector) { return selector === 'script[type="application/ld+json"]' ? scripts : []; },
    createElement() { return new Element(); },
    getElementById() { return null; },
  };
}

test('static and hydrated state summaries, cards, source evidence, metadata and FAQ agree', () => {
  const previousDocument = globalThis.document;
  try {
    for (const snapshot of [fixture(), fixture('sample'), fixture('live', [1]), fixture('live', [4, 3, 2, 1]), fixture('live', [1, 1]), fixture('live', [0, 0, 0, 0.1]), fixture('live', [0, 0, 0.1, 0.2]), fixture('live', [1, 2], { observationPeriod: { weekEnding: '2026-08-01' } }), fixture('live', [1, 2], { kind: 'unknown' })]) {
      const page = pageFor(snapshot);
      const doc = documentFor(page);
      globalThis.document = doc;
      const store = { signals: new Map(), weekEnding: '', provenance: {} };
      ingestSnapshot(store, snapshot);
      render(store, state.abbr);
      for (const name of ['threat-card', 'pathogen-tiles', 'signal-rows', 'takeaways', 'week-in-brief', 'source-evidence', 'state-faqs', 'glance-trend', 'sticky-trend', 'neighbor-states']) {
        assert.equal(doc.regions.get(name).innerHTML.trim(), regionContent(page.body, name).trim(), `${snapshot.kind}/${snapshot.states.MD.edCombinedSeries}: ${name}`);
      }
      assert.equal(doc.regions.get('state-intro').textContent, unescape(regionContent(page.body, 'state-intro')));
      for (const meta of doc.metas.values()) assert.equal(meta.getAttribute('content'), page.description);
      assert.deepEqual(JSON.parse(doc.scripts.find((script) => JSON.parse(script.textContent)['@type'] === 'FAQPage').textContent), page.jsonld.find((item) => item['@type'] === 'FAQPage'));
      assert.deepEqual(JSON.parse(doc.scripts.find((script) => JSON.parse(script.textContent)['@type'] === 'WebPage').textContent), page.jsonld.find((item) => item['@type'] === 'WebPage'));
    }
  } finally { globalThis.document = previousDocument; }
});

test('live refresh replaces sample takeaways with the same zero-baseline explanation as the built state page', () => {
  const previousDocument = globalThis.document;
  try {
    const sample = fixture('sample');
    const doc = documentFor(pageFor(sample));
    globalThis.document = doc;
    const store = { signals: new Map(), weekEnding: '', provenance: {} };
    ingestSnapshot(store, sample);
    const takeaways = doc.regions.get('takeaways');
    assert.equal(takeaways.innerHTML, '');

    for (const series of [[0, 0, 0, 0.1], [0, 0]]) {
      const live = fixture('live', series);
      const page = pageFor(live);
      const built = regionContent(page.body, 'takeaways');
      assert.match(built, /no percentage change can be calculated from a zero baseline/i);
      assert.doesNotMatch(page.body, /\bundefined\b/i);

      ingestLive(store, { ...live, signalsByAbbr: new Map(Object.entries(live.states)) });
      render(store, state.abbr);
      assert.equal(takeaways.innerHTML, built);
      for (const region of doc.regions.values()) assert.doesNotMatch(region.textContent, /\bundefined\b/i);
    }
  } finally { globalThis.document = previousDocument; }
});

test('refreshing an unavailable state removes older/sample claims rather than borrowing a national level', () => {
  const previousDocument = globalThis.document;
  try {
    const snapshot = fixture('sample');
    const doc = documentFor(pageFor(snapshot));
    globalThis.document = doc;
    const store = { signals: new Map(), weekEnding: '', provenance: {} };
    ingestSnapshot(store, snapshot);
    const live = fixture('live');
    const signalsByAbbr = new Map(Object.entries(live.states));
    signalsByAbbr.delete(state.abbr);
    ingestLive(store, { ...live, signalsByAbbr });
    const result = render(store, state.abbr);
    assert.equal(result.model.level, null);
    assert.equal(result.model.trend.direction, 'unknown');
    assert.match(doc.regions.get('week-in-brief').innerHTML, /No usable combined respiratory index is available for Maryland/);
    assert.match(doc.regions.get('threat-card').innerHTML, /Missing surveillance data does not mean no illness/);
    assert.doesNotMatch(doc.regions.get('state-faqs').innerHTML, /illustrative sample for Maryland/);
    assert.equal(doc.regions.get('sticky-level').getAttribute('data-sev'), null);
    assert.match(doc.metas.get('meta[name="description"]').getAttribute('content'), /No usable combined respiratory index/);
    assert.equal(JSON.parse(doc.scripts.find((script) => JSON.parse(script.textContent)['@type'] === 'WebPage').textContent).temporalCoverage, undefined);
  } finally { globalThis.document = previousDocument; }
});

test('selection announcements carry sample, historical, missing and trend evidence limits', () => {
  const sample = fixture('sample');
  const sampleText = selectionAnnouncement(state, computeModel(sample.states.MD, { now }));
  assert.match(sampleText, /illustrative sample for Maryland, not observed health conditions/);
  assert.doesNotMatch(sampleText, /Minimal|Low|Rising|Falling|holding steady/i);
  const stale = fixture('live', [1, 2], { observationPeriod: { weekEnding: '2026-08-01' } });
  assert.match(selectionAnnouncement(state, computeModel(stale.states.MD, { now })), /Historical observations ending Aug 1, 2026.*do not establish current health conditions or a current trend/);
  assert.match(selectionAnnouncement(state, computeModel({}, { kind: 'live', now })), /Missing data does not mean no illness/);
  const current = fixture();
  const text = selectionAnnouncement(state, computeModel(current.states.MD, { now }));
  assert.match(text, /observations ending Sep 26, 2026/);
  assert.match(text, /trend in the share of emergency-department visits was rising/);
  assert.match(text, /latest observation compared with the mean of up to three prior observations/);
  const nationalText = selectionAnnouncement({ name: 'United States', isNational: true }, computeModel(nationalSignals(Object.values(current.states)), { now }));
  assert.match(nationalText, /unweighted aggregate of states with usable observations/);
  const short = fixture('live', [1]);
  assert.match(selectionAnnouncement(state, computeModel(short.states.MD, { now })), /not enough comparable observations to determine a trend/);
  const zero = fixture('live', [0, 0, 0, 0.1]);
  const zeroText = selectionAnnouncement(state, computeModel(zero.states.MD, { now }));
  assert.match(zeroText, /increased from zero; no percentage change can be calculated from a zero baseline/);
  assert.doesNotMatch(zeroText, /\+100%/);
  const capped = fixture('live', [0, 0, 0.1, 0.2]);
  assert.match(selectionAnnouncement(state, computeModel(capped.states.MD, { now })), /\+200% or more \(display capped\)/);
});

test('Iowa source-gap evidence survives hydration with the same official citation and dates', () => {
  const previousDocument = globalThis.document;
  try {
    const iowa = states.find((s) => s.abbr === 'IA');
    const snapshot = fixture();
    snapshot.states.IA = {
      weekEnding: period, wastewaterSeries: [3, 4],
      provenance: { kind: 'live', geography: { level: 'state', abbr: 'IA', name: 'Iowa' }, metrics: {
        edVisits: { status: 'missing', contributes: false }, ari: { status: 'missing', contributes: false }, wastewater: metric,
      } },
    };
    const page = pageFor(snapshot, iowa);
    const doc = documentFor(page);
    globalThis.document = doc;
    const store = { signals: new Map(), weekEnding: '', provenance: {} };
    ingestSnapshot(store, snapshot);
    render(store, iowa.abbr);
    assert.equal(doc.regions.get('source-evidence').innerHTML, regionContent(page.body, 'source-evidence'));
    assert.match(doc.regions.get('source-evidence').innerHTML, /CDC's activity-level data notes, updated October 2, 2026/);
    assert.match(doc.regions.get('source-evidence').innerHTML, /reporting gap does not mean no illness in Iowa/);
  } finally { globalThis.document = previousDocument; }
});
