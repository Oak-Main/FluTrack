// Shared evidence checks for static pages and browser refreshes. A retrieval
// date describes a download; only the observation period dates a reading.
import { MAX_OBSERVATION_AGE_DAYS, observationAgeDays } from './data-sources.js';
import { formatChange } from './util.js';

export function resolveProvenance(reading = {}, context = {}) {
  const out = { ...context, ...reading };
  out.metrics = { ...(context.metrics || {}), ...(reading.metrics || {}) };
  out.observationPeriod = reading.observationPeriod || context.observationPeriod;
  // An explicitly unverified reading cannot borrow the surrounding bundle's
  // verified kind. A default inferred unknown can still accept legacy context.
  const readingKind = reading.kind && (reading.kind !== 'unknown' || reading.kindExplicit !== false) ? reading.kind : '';
  const contextKind = context.kind && (context.kind !== 'unknown' || context.kindExplicit !== false) ? context.kind : '';
  const explicitLive = (context.kind !== 'unknown' ? context.live : undefined) ?? (reading.kind !== 'unknown' ? reading.live : undefined);
  const kind = readingKind || contextKind || (explicitLive === true ? 'live' : explicitLive === false ? 'sample' : 'unknown');
  out.kind = kind;
  out.kindExplicit = Boolean(readingKind || contextKind || explicitLive !== undefined);
  out.live = kind === 'live';
  const week = out.observationPeriod?.weekEnding || reading.weekEnding || context.weekEnding;
  if (week) out.weekEnding = week;
  // Preserve source-specific freshness evidence. The age guard also catches
  // old snapshots created before per-metric provenance was recorded.
  const now = out.now ? new Date(out.now) : new Date();
  out.stale = Boolean(reading.stale || context.stale || out.status === 'stale' ||
    (kind === 'live' && week && observationAgeDays(week, now) > MAX_OBSERVATION_AGE_DAYS));
  return out;
}

export function observationWeek(model = {}, context = {}) {
  return resolveProvenance(model.provenance, context).weekEnding || '';
}

/** Explicitly absent or excluded signals cannot contribute leftover numbers. */
export function metricAvailable(signals = {}, key, context = {}) {
  const metric = signals.provenance?.metrics?.[key];
  const kind = resolveProvenance(signals.provenance, context).kind;
  return !(kind === 'live' && metric?.kind && metric.kind !== 'live') &&
    metric?.contributes !== false && !['missing', 'unavailable', 'stale'].includes(metric?.status);
}

/** Status is about evidence, independently of the numeric severity bucket. */
export function readingStatus(model = {}, context = {}) {
  const p = resolveProvenance(model.provenance, context);
  if (p.kind === 'sample') return 'sample';
  if (p.status === 'unverified' || (!p.live && Number.isFinite(model.level))) return 'unverified';
  if (p.stale) return 'stale';
  if (!Number.isFinite(model.level) || ['missing', 'unavailable'].includes(p.status)) return 'missing';
  return p.live ? 'live' : 'unverified';
}

/** Keep arithmetic separate from an evidence-qualified health presentation. */
export function presentationModel(model = {}, context = {}) {
  const provenance = resolveProvenance(model.provenance, context);
  const unverified = readingStatus(model, provenance) === 'unverified';
  const presented = {
    ...model,
    provenance: unverified ? { ...provenance, status: 'unverified' } : provenance,
    trend: model.trend ? { ...model.trend, provenance } : model.trend,
  };
  if (unverified) Object.assign(presented, {
    composite: null, level: null, label: 'Unknown', contributors: [], _series: [],
    trend: { direction: 'unknown', changePct: null, label: 'Unverified provenance', source: null, provenance: presented.provenance },
  });
  if (model.pathogens) presented.pathogens = Object.fromEntries(Object.entries(model.pathogens).map(([key, pathogen]) => [key,
    presentationModel(pathogen, { ...context, ...provenance, metrics: {}, coverage: undefined, sources: [] }),
  ]));
  return presented;
}

export const TREND_COMPARISON = 'latest observation compared with the mean of up to three prior observations';
export const ZERO_BASELINE_EXPLANATION = 'no percentage change can be calculated from a zero baseline';

/** A zero baseline has no relative percentage, including zero-to-zero. */
export function relativeTrendChange(trend = {}) {
  if (trend.zeroBaseline) return null;
  if (Number.isFinite(trend.actualChangePct)) return trend.actualChangePct;
  return trend.changePctCapped ? null : Number.isFinite(trend.changePct) ? trend.changePct : null;
}

/** Keep capped model percentages distinct from the observed comparison. */
export function trendChangeText(trend = {}) {
  if (trend.zeroBaseline) return `${trend.direction === 'up' ? 'increased' : 'unchanged'} from zero; ${ZERO_BASELINE_EXPLANATION}`;
  if (trend.changePctCapped) {
    return trend.changePct >= 0
      ? `${formatChange(trend.changePct)} or more (display capped)`
      : `decrease of ${Math.abs(trend.changePct)}% or more (display capped)`;
  }
  return formatChange(trend.changePct);
}
export const MEASUREMENT_NAMES = Object.freeze({
  edVisits: 'the share of emergency-department visits',
  wastewater: 'the wastewater viral activity index',
  positivity: 'the share of laboratory tests positive',
});
