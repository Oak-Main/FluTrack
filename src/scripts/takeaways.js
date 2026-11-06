// ===========================================================================
// "This week, in plain English" — 3–5 sentence takeaways for a state report.
//
// Built only from the state's own model and signals (plus its HHS-region
// peers' levels), so every sentence restates a figure shown elsewhere on the
// page. Shared by the Node build and the browser so a live refresh rewrites the
// block with exactly the wording the build would have produced.
//
// Rules this module keeps:
//   * LIVE DATA ONLY. On the illustrative sample it renders nothing: a sentence
//     like "Flu is rising in Maryland" is a claim about a real place and must
//     never be generated from fixture numbers (a snippet would carry it off
//     the page without the "Sample data" badge).
//   * Describe, never advise or predict. No "you should", no forecasts.
//   * At low levels, small moves are described as small — a 0.1 → 0.2 point
//     change is "edging up", not a percentage headline.
// ===========================================================================

import { escapeHtml, formatDate, formatPct } from './util.js';
import { BREAKPOINTS, SEVERITY_LABELS, bucketize } from './threat-index.js';
import { MEASUREMENT_NAMES, ZERO_BASELINE_EXPLANATION, metricAvailable, observationWeek, readingStatus, resolveProvenance } from './reading-provenance.js';

const VIRUS_NAMES = { influenza: 'flu', covid: 'COVID-19', rsv: 'RSV' };
const CONTRIBUTOR_NAMES = {
  edVisits: 'emergency-department visits',
  ari: 'CDC’s acute respiratory illness rating',
  wastewater: 'wastewater',
  positivity: 'lab test positivity',
};

const latestFinite = (arr) => {
  const value = arr?.at?.(-1);
  return Number.isFinite(value) ? value : null;
};

/** "Maryland’s", but "Texas’" / "Illinois’". */
const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

function listJoin(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Direction in words, scaled to the level so tiny moves read as tiny. */
function movement(level, trend) {
  const dir = trend?.direction;
  if (!['up', 'down', 'flat'].includes(dir) || trend.label === 'Not enough data') return '';
  const low = !Number.isFinite(level) || level <= 1;
  if (dir === 'up') return low ? 'edging up' : 'rising';
  if (dir === 'down') return low ? 'easing' : 'falling';
  return dir === 'flat' ? 'holding steady' : '';
}

const trendSentence = (level, trend) => {
  const m = movement(level, trend);
  const source = MEASUREMENT_NAMES[trend?.source] || 'the selected surveillance signal';
  const subject = `${source[0].toUpperCase()}${source.slice(1)}`;
  if (m && trend.zeroBaseline) {
    const change = trend.direction === 'up' ? 'increased' : 'was unchanged';
    return ` ${subject} ${change} from zero compared with the mean of up to three prior observations, so ${ZERO_BASELINE_EXPLANATION}.`;
  }
  return m ? ` ${subject} was ${m} compared with the mean of up to three prior observations.${trend.changePctCapped ? ' The relative percentage change exceeds the model cap; the capped value is not the actual comparison.' : ''}` : ' There is not enough history to determine a trend.';
};

/**
 * @param {object} state  { name, abbr }
 * @param {object} model  computeModel(signals)
 * @param {object} signals the state's signal bundle
 * @param {object} opts   { live: boolean, peers: [{ name, level }] } — peers
 *   are the other states in the same HHS region.
 * @returns {{ lead: string, text: string }[]} empty unless live with data
 */
export function weeklyTakeaways(state, model, signals = {}, { live = false, peers = [], provenance = {}, weekEnding = '' } = {}) {
  const evidence = resolveProvenance(model?.provenance, { ...provenance, live, weekEnding: signals.weekEnding || weekEnding || provenance.weekEnding });
  if (readingStatus(model, evidence) !== 'live') return [];
  const name = state.name;
  const out = [];
  const contributingValue = (key, metric, field) => {
    const pathogen = model.pathogens?.[key];
    const reading = signals.pathogens?.[key] || {};
    if (readingStatus(pathogen, evidence) !== 'live' || !pathogen?.contributors?.includes(metric) || !metricAvailable(reading, metric)) return null;
    return latestFinite(reading[field]);
  };

  // 1. Overall, plus CDC's own categorical rating when it reported one.
  const ari = metricAvailable(signals, 'ari') && model.contributors?.includes('ari') ? signals.ariLabel || (Number.isFinite(signals.ariLevel) ? ['Very Low', 'Low', 'Moderate', 'High', 'Very High'][signals.ariLevel] : '') : '';
  out.push({
    lead: 'Overall',
    text:
      `The combined respiratory index for ${name} is ${model.label.toLowerCase()} for the reported observation period.` +
      trendSentence(model.level, model.trend) +
      (ari ? ` CDC reported the state's broader acute respiratory illness activity as ${ari}.` : ''),
  });

  // 2. Flu — the reading most people came for.
  const flu = model.pathogens?.influenza;
  const fluEd = contributingValue('influenza', 'edVisits', 'edPercentSeries');
  const fluWw = contributingValue('influenza', 'wastewater', 'wastewaterSeries');
  if (fluEd != null && Number.isFinite(flu?.level)) {
    out.push({
      lead: 'Flu',
      text: `Influenza accounted for ${formatPct(fluEd)} of emergency-department visits in the reported period. FluTrack's influenza index was ${flu.label.toLowerCase()}.` + trendSentence(flu.level, flu.trend),
    });
  } else if (fluWw != null && Number.isFinite(flu?.level)) {
    const label = SEVERITY_LABELS[bucketize(fluWw, BREAKPOINTS.wastewater)].toLowerCase();
    out.push({ lead: 'Flu', text: `The influenza wastewater activity index was ${fluWw.toFixed(1)} (${label} on FluTrack's scale) in the reported period.` + trendSentence(flu.level, flu.trend) });
  } else {
    out.push({ lead: 'Flu', text: `No usable influenza reading was available for ${name} in the reported observation period. No data does not mean no influenza.` });
  }

  // 3. Which of the three is most common in emergency departments.
  const ed = Object.keys(VIRUS_NAMES)
    .map((key) => ({ key, v: contributingValue(key, 'edVisits', 'edPercentSeries') }))
    .filter((x) => x.v != null);
  if (ed.length === 3) {
    const sorted = [...ed].sort((a, b) => b.v - a.v);
    const [top, second] = sorted;
    const others = sorted.slice(1).map((x) => `${formatPct(x.v)} ${VIRUS_NAMES[x.key]}`);
    if (top.v > 0 && top.v > second.v) {
      const topName = VIRUS_NAMES[top.key];
      out.push({
        lead: 'Emergency visits',
        text: `${topName[0].toUpperCase()}${topName.slice(1)} accounted for the largest share of visits among these three viruses in ${possessive(name)} reporting emergency departments (${formatPct(top.v)}, against ${listJoin(others)}) for the reported period. This is not a population case count.`,
      });
    } else if (top.v > 0) {
      out.push({ lead: 'Emergency visits', text: `No single virus had the largest share of visits among these three viruses in ${possessive(name)} reporting emergency departments for the reported period (${listJoin(sorted.map((x) => `${formatPct(x.v)} ${VIRUS_NAMES[x.key]}`))}).` });
    }
  }

  // 4. Wastewater — or, when there is none, what the level rests on.
  const ww = Object.keys(VIRUS_NAMES)
    .map((key) => ({ key, v: contributingValue(key, 'wastewater', 'wastewaterSeries') }))
    .filter((x) => x.v != null);
  if (ww.length) {
    const readings = ww.map(({ key, v }) => `${VIRUS_NAMES[key]} ${v.toFixed(1)} (${SEVERITY_LABELS[bucketize(v, BREAKPOINTS.wastewater)].toLowerCase()} on FluTrack's scale)`);
    out.push({
      lead: 'Wastewater',
      text: `Reported wastewater activity indices for ${name}: ${listJoin(readings)}. These indices are measured against each pathogen's baseline; they do not rank how common the viruses are.`,
    });
  } else {
    const basis = (model.contributors || []).map((c) => CONTRIBUTOR_NAMES[c]).filter(Boolean);
    out.push({
      lead: 'Wastewater',
      text: `No contributing wastewater reading is available for ${name} in the reported period${basis.length ? `, so this index rests on ${listJoin(basis)}` : ''}.`,
    });
  }

  // 5. Nearby states (same HHS region).
  const ranked = peers.filter((p) => {
    const week = observationWeek(p, { weekEnding: p.weekEnding });
    return readingStatus(p, { weekEnding: week }) === 'live' && week && week === evidence.weekEnding;
  });
  if (ranked.length) {
    const higher = ranked.filter((p) => p.level > model.level).length;
    const lower = ranked.filter((p) => p.level < model.level).length;
    const m = ranked.length;
    let text;
    const scope = `${m} other ${m === 1 ? 'state' : 'states'} with usable readings for the same observation period in ${possessive(name)} HHS region`;
    if (!higher && !lower) text = `The ${scope} ${m === 1 ? 'is' : 'are'} also at a ${model.label.toLowerCase()} index level.`;
    // Ties are stated: "highest" with two states level alongside is not the highest.
    else if (!higher) text = `${name} ${lower < m ? 'is tied for' : 'has'} the highest available index level among the ${scope} — ${lower} of ${m} compared states ${lower === 1 ? 'is' : 'are'} lower.`;
    else if (!lower) text = `${name} ${higher < m ? 'is tied for' : 'has'} the lowest available index level among the ${scope} — ${higher} of ${m} compared states ${higher === 1 ? 'is' : 'are'} higher.`;
    else text = `Among the ${scope}, ${higher} ${higher === 1 ? 'is' : 'are'} at a higher index level and ${lower} lower.`;
    out.push({ lead: 'Nearby states', text });
  }

  return out.slice(0, 5);
}

/** The rendered block, or '' when there is nothing honest to say. */
export function takeawaysBlock(state, model, signals, { live = false, peers = [], weekEnding = '', provenance = {} } = {}) {
  const items = weeklyTakeaways(state, model, signals, { live, peers, weekEnding, provenance });
  if (!items.length) return '';
  const asOf = weekEnding ? `Week ending ${escapeHtml(formatDate(weekEnding))} · ` : '';
  return `<section class="takeaways" aria-labelledby="takeaways-title">
    <div class="section-head section-rule">
      <h2 id="takeaways-title" style="font-size: var(--step-2)">Reported observations in ${escapeHtml(state.name)}, in plain English</h2>
      <p class="text-secondary">${asOf}what the contributing CDC surveillance observations show; not current-day conditions.</p>
    </div>
    <ul class="takeaways__list">${items.map((t) => `<li><strong>${escapeHtml(t.lead)}:</strong> ${escapeHtml(t.text)}</li>`).join('')}</ul>
  </section>`;
}
