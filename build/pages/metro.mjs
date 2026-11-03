import { escapeHtml, formatDate } from '../../src/scripts/util.js';
import { threatCard, pathogenTiles, signalRows, levelToken, trendChip } from '../../src/scripts/render.js';
import { observationWeek, presentationModel, resolveProvenance } from '../../src/scripts/reading-provenance.js';
import { signupBand, trendDisclaimer, breadcrumbs, adSlot, seasonKitModule } from '../lib/partials.mjs';
import { breadcrumbLd, statePageLd, faqLd } from '../lib/seo.mjs';

/**
 * Metro "what's going around" pages. The CDC publishes no combined
 * metro-level respiratory index, so each metro page renders its state's
 * public-domain surveillance picture — labeled as state-level throughout —
 * alongside the official metro-specific sources that do exist (state health
 * department reports, wastewater surveillance). Editorial voice and honesty
 * rules match state.mjs exactly: no medical guidance, no fabricated local
 * data, everything dated to the snapshot week.
 */

export const metros = [
  {
    slug: 'atlanta',
    name: 'Atlanta',
    stateAbbr: 'GA',
    context: `Georgia Department of Public Health (dph.ga.gov) and CDC wastewater surveillance provide additional official reports. The reading below is calculated from Georgia state surveillance; participating wastewater sewersheds cover only part of the state. FluTrack has no independently measured Atlanta index, and state activity can differ from activity within Atlanta.`,
  },
  {
    slug: 'boston',
    name: 'Boston',
    stateAbbr: 'MA',
    context: `Massachusetts Department of Public Health (mass.gov/dph) and the Massachusetts Water Resources Authority (mwra.com) publish additional respiratory or wastewater reports. The reading below is calculated from Massachusetts state surveillance. Local wastewater describes the population served by its sampling system; it is not a city case count and is not separately combined into this page's index.`,
  },
  {
    slug: 'bay-area',
    name: 'the SF Bay Area',
    titleName: 'SF Bay Area',
    stateAbbr: 'CA',
    context: `California Department of Public Health (cdph.ca.gov), county health departments and CDC wastewater surveillance provide additional official reports. The reading below is calculated from California state surveillance, not independent Bay Area measurements. Sampling coverage varies by sewershed, and a local change cannot establish a statewide or national trend.`,
  },
  {
    slug: 'new-york-city',
    name: 'New York City',
    stateAbbr: 'NY',
    context: `The New York City Department of Health and Mental Hygiene (nyc.gov) publishes a weekly respiratory-illness report covering flu, RSV and COVID-19, updated Thursdays. The New York State Department of Health's Flu Tracker (nyshc.health.ny.gov) shows weekly flu activity by county, and CDC wastewater and emergency-department surveillance include monitoring locations in New York. The reading below is calculated from New York state surveillance; activity in the five boroughs can differ from the state reading, and FluTrack has no independently measured New York City index.`,
  },
];

export function metroPage(ctx, metro) {
  const { site, weekEnding, provenance } = ctx;
  const state = ctx.states.find((s) => s.abbr === metro.stateAbbr);
  const entry = ctx.models.get(state.abbr);
  const model = presentationModel(entry.model, { ...provenance, weekEnding });
  const signals = entry.signals;
  const displayName = metro.titleName || metro.name;
  const crumbs = [
    { name: 'Home', path: '/' },
    { name: 'States', path: '/states/' },
    { name: state.name, path: `/state/${state.slug}/` },
    { name: displayName, path: `/metro/${metro.slug}/` },
  ];
  const readingProvenance = resolveProvenance(model.provenance, provenance);
  const observedWeek = observationWeek(model, { ...provenance, weekEnding });
  const readingContext = { weekEnding: observedWeek, provenance: readingProvenance, signals };
  const faqs = metroFaqs(metro, state);

  const body = `
  <div class="status-strip" data-sticky-status aria-label="${escapeHtml(displayName)} report status">
    <span class="status-strip__state">${escapeHtml(displayName)} · ${escapeHtml(state.name)}</span>
    <span class="status-strip__level" data-region="sticky-level"${Number.isFinite(model.level) ? ` data-sev="${model.level}"` : ''}>${levelToken(model.level, model.label)}</span>
    <span data-region="sticky-trend">${trendChip(model.trend, readingContext)}</span>
  </div>
  <section class="section section--tight state-masthead" data-state-masthead>
    <div class="container">
      ${breadcrumbs(crumbs)}
      <h1>What's going around in ${escapeHtml(displayName)}: flu, RSV &amp; COVID-19</h1>
      <p class="lede" style="margin-top: var(--space-sm); max-width: 44rem">${escapeHtml(state.name)} state surveillance provides context for ${escapeHtml(displayName)}. FluTrack calculates the combined respiratory index from the available state inputs; it is not an independent city measurement.</p>
      <p class="text-secondary" style="margin-top: var(--space-md); max-width: 48rem">${escapeHtml(metro.context)}</p>
    </div>
  </section>

  <section class="section" style="padding-top: var(--space-xl)">
    <div class="container">
      <div class="state-layout">
        <div class="stack" style="--flow: var(--space-2xl)">
          <div data-region="threat-card" data-state="${escapeHtml(state.abbr)}" data-week="${escapeHtml(observedWeek)}">
            ${threatCard(state, model, readingContext)}
          </div>
          ${trendDisclaimer()}
          <div>
            <div class="section-head section-rule">
              <h2>By virus</h2>
              <p class="text-secondary">Available by-virus observations across ${escapeHtml(state.name)}. Their observation periods and coverage may differ from conditions in ${escapeHtml(displayName)}.</p>
            </div>
            <div data-region="pathogen-tiles">${pathogenTiles(model, readingContext)}</div>
          </div>
          ${adSlot('metro-by-virus')}
          <div>
            <div class="section-head section-rule"><h2 style="font-size: var(--step-2)">What the data shows</h2></div>
            <div data-region="signal-rows">${signalRows(signals, { ...readingContext, model })}</div>
          </div>
          ${adSlot('metro-signals')}
          ${seasonKitModule()}
        </div>

        <aside class="state-rail" aria-label="More about ${escapeHtml(displayName)}">
          <div class="card">
            <h2 style="font-size: var(--step-1)">At a glance</h2>
            <dl class="stack" style="--flow: var(--space-sm); margin-top: var(--space-sm)">
              <div class="between"><dt class="text-secondary">Combined respiratory index</dt><dd data-region="glance-level"><strong>${escapeHtml(model.label)}</strong> <span class="text-secondary">(${escapeHtml(state.name)})</span></dd></div>
              <div class="between"><dt class="text-secondary">Trend</dt><dd data-region="glance-trend">${trendChip(model.trend, readingContext)}</dd></div>
              <div class="between"><dt class="text-secondary">Observation period ending</dt><dd data-region="glance-week">${observedWeek ? escapeHtml(formatDate(observedWeek)) : 'Not available'}</dd></div>
            </dl>
          </div>
          <div class="card">
            <h2 style="font-size: var(--step-1)">The full ${escapeHtml(state.name)} report</h2>
            <p class="text-secondary" style="margin: var(--space-2xs) 0 var(--space-md)">Every signal behind this level, on the state page.</p>
            <a class="btn btn--block" href="/state/${state.slug}/">Open ${escapeHtml(state.name)}</a>
          </div>
          <div class="card">
            <h2 style="font-size: var(--step-1)">Get ${escapeHtml(state.name)} alerts</h2>
            <p class="text-secondary" style="margin: var(--space-2xs) 0 var(--space-md)">We'll email you when activity starts climbing here.</p>
            <a class="btn btn--primary btn--block" href="/alerts/?state=${escapeHtml(state.abbr)}">Set up surge alerts</a>
          </div>
          <div class="card">
            <h2 style="font-size: var(--step-1)">Respiratory activity map</h2>
            <p class="text-secondary" style="margin: var(--space-2xs) 0 var(--space-md)">Compare dated state readings and their coverage.</p>
            <a class="btn btn--block" href="/states/">Open the activity map</a>
          </div>
        </aside>
      </div>
    </div>
  </section>

  <section class="section below-fold" style="background: var(--bg-elevated); border-block: 1px solid var(--border)">
    <div class="container container--narrow">
      <h2 style="font-size: var(--step-2)">${escapeHtml(displayName)}: common questions</h2>
      <div style="margin-top: var(--space-md)">${faqs.map((f) => `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><div class="faq-item__body">${f.a}</div></details>`).join('')}</div>
    </div>
  </section>

  ${signupBand({ compact: true })}
  `;

  // Hoisted so the WebPage JSON-LD describes THIS page with the same strings the
  // <head> uses, instead of inheriting the state page's identity.
  const title = `What's Going Around in ${displayName}: Flu, RSV & COVID`;
  const description = `${displayName} context from ${state.name} state surveillance: a dated combined respiratory index and by-virus readings with coverage limits. No independent city measurement.`;
  const path = `/metro/${metro.slug}/`;

  return {
    title,
    description,
    path,
    body,
    scripts: ['/assets/js/app.js', '/assets/js/sticky-status.js'],
    ogType: 'article',
    // No per-page ogImage: layout.mjs falls back to /assets/og-default.png.
    // The per-state card is an SVG, and no major social or chat consumer renders
    // SVG in a link preview — so pointing at it produced a BLANK card on every
    // share, while the page still declared og:image:width 1200 / height 630.
    // A rasterised per-state PNG is not the fix either: the card encodes a
    // threat reading that changes weekly, so a committed PNG would freeze it and
    // start contradicting the page. A dataless brand card is correct until the
    // cards are generated per request.
    jsonld: [breadcrumbLd(crumbs), statePageLd(state, observedWeek, { path, name: title, description, provenance: readingProvenance, available: Number.isFinite(model.level) }), faqLd(faqs.map((f) => ({ q: f.q, a: stripTags(f.a) })))],
  };
}

function metroFaqs(metro, state) {
  const dn = metro.titleName || metro.name;
  return [
    { q: `What can this page say about illness in ${dn}?`, a: `<p>The combined respiratory index summarizes available ${escapeHtml(state.name)} state observations for flu, RSV and COVID-19. It cannot establish city conditions or count infections. Check each observation period and provenance label: sample, missing, insufficient or stale data cannot support a current-week conclusion. No data does not mean no illness.</p>` },
    { q: `Is this data specific to ${dn} itself?`, a: `<p>The index is the ${escapeHtml(state.name)} state reading. FluTrack has no independent combined index for ${escapeHtml(dn)}. Official local reports may provide additional context, but a sewershed, a county and an entire metro have different populations and coverage.</p>` },
    { q: `Where does the data come from?`, a: `<p>The implemented index feeds are emergency-department visits and the Acute Respiratory Illness activity level (NSSP), and wastewater viral activity (NWSS). Only usable inputs contribute to a reading. Laboratory test positivity (NREVSS) has no live adapter and appears only in illustrative samples. Hospital admissions, case counts and test positivity are separate measures; they are not interchangeable with ED visits or wastewater. See our <a href="/methodology/">methodology</a> and <a href="/data-sources/">data sources</a>.</p>` },
    { q: `How often is it updated?`, a: `<p>The index feeds generally publish weekly, with source-specific delays and revisions. An observation period ending, the source publication date and a retrieval timestamp describe different events. A newer retrieval can contain the same reported week. The trend compares the latest observation with the mean of up to three prior observations, not an ordinary week-over-week change.</p>` },
    { q: 'Is this medical advice?', a: '<p>No. FluTrack is an independent data-visualization utility and is not affiliated with the CDC. The information here is general and is not a substitute for professional medical advice. For guidance about your health, consult a qualified provider.</p>' },
  ];
}
function stripTags(html) { return String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
