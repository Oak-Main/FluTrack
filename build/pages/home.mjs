import { escapeHtml } from '../../src/scripts/util.js';
import { threatCard, pathogenTiles, signalRows, provenanceStrip } from '../../src/scripts/render.js';
import { usMap } from '../../src/scripts/map-render.js';
import { presentationModel } from '../../src/scripts/reading-provenance.js';
import { icon } from '../../src/scripts/icons.js';
import { signupBand, trendDisclaimer, adSlot } from '../lib/partials.mjs';
import { websiteLd, organizationLd, datasetLd, webApplicationLd } from '../lib/seo.mjs';
import { reportSection } from '../lib/report-section.mjs';
import { epidemicTrendHomeLine } from '../lib/epidemic-trend-render.mjs';

export default function home(ctx) {
  const { site, states, national, weekEnding, provenance } = ctx;
  const def = { ...national, model: presentationModel(national.model, { ...provenance, weekEnding }) };
  const stateOptions = states.map((s) => `<option value="${s.abbr}">${escapeHtml(s.name)}</option>`).join('');
  const mapEntries = states.map((s) => {
    const m = presentationModel(ctx.models.get(s.abbr).model, { ...provenance, weekEnding });
    return { abbr: s.abbr, name: s.name, slug: s.slug, level: m.level, label: m.label };
  });

  const body = `
  <section class="hero">
    <div class="hero__bg" aria-hidden="true"${Number.isFinite(def.model.level) ? ` data-sev="${def.model.level}"` : ''}></div>
    <div class="container">
      <div class="hero__grid">
        <div class="home-readout" data-region="threat-card" data-week="${escapeHtml(weekEnding)}">
          ${threatCard(def.state, def.model, { weekEnding, provenance, signals: def.signals })}
        </div>
        <div class="hero__lead">
          <p class="hero__label">Flu <span aria-hidden="true">/</span> RSV <span aria-hidden="true">/</span> COVID-19 <span aria-hidden="true">/</span> United States</p>
          <h1 class="hero__question">How bad is it near you, in plain English?</h1>
          <p class="lede hero__lede">FluTrack summarizes reported flu, RSV and COVID-19 activity in a combined respiratory index for your state. Each reading describes its observation period, with a trend when enough comparable data exists.</p>
          <div class="prov" data-region="provenance-strip" style="margin-top: var(--space-lg)">${provenanceStrip(def.model.provenance || provenance, { model: def.model })}</div>
          <p class="text-secondary" style="margin-top: var(--space-sm)">The U.S. display is an unweighted rollup of available state signals, not an independently published CDC national estimate. State and local trends can differ.</p>
        </div>
      </div>
      <form class="picker hero__cta" id="state-picker" role="search" aria-label="Choose your state">
        <label class="visually-hidden" for="state-select">Choose your state</label>
        <select class="select" id="state-select" name="state" data-default="${escapeHtml(def.state.abbr)}">
          <option value="US">United States (overall)</option>
          ${stateOptions}
        </select>
        <button class="btn btn--primary" type="submit">See my area</button>
        <button class="btn btn--ghost" type="button" id="geo-btn" title="Use my location">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Use my location
        </button>
      </form>
    </div>
  </section>

  ${reportSection({ siteKey: site.turnstile?.siteKey, enabled: site.features?.report !== false })}

  <section class="section section--tight" id="breakdown" style="scroll-margin-top: 5rem">
    <div class="container">
      <div class="trend-note">${trendDisclaimer()}</div>
    </div>
  </section>

  ${adSlot('home-readout')}

  <section class="section below-fold">
    <div class="container">
      <div class="section-head section-rule">
        <h2>By virus, for <span data-region="state-name">the U.S.</span></h2>
        <p class="text-secondary">The same picture, split into flu, RSV and COVID-19.</p>
      </div>
      <div data-region="pathogen-tiles">${pathogenTiles(def.model, { weekEnding, provenance })}</div>
      <div style="margin-top: var(--space-2xl)">
        <h2 style="font-size: var(--step-2)">Underlying signals</h2>
        <div data-region="signal-rows" style="margin-top: var(--space-md)">${signalRows(def.signals, { model: def.model, weekEnding, provenance })}</div>
      </div>
    </div>
  </section>

  <section class="section below-fold" style="background: var(--bg-elevated); border-block: 1px solid var(--border)">
    <div class="container">
      <div class="section-head section-rule">
        <h2>United States activity</h2>
        <p class="text-secondary">Tap or select a state for its full report.</p>
      </div>
      ${epidemicTrendHomeLine(ctx.epidemicTrend)}
      <a class="skip-link" href="#after-state-map">Skip the state map</a>
      <div data-region="us-map">${usMap(mapEntries, { selected: '' })}</div>
      <div style="margin-top: var(--space-xl)">
        <a class="btn btn--secondary" id="after-state-map" href="/states/" data-region="state-link">Full state report</a>
      </div>
    </div>
  </section>

  <section class="section below-fold">
    <div class="container">
      <div class="section-head section-rule">
        <h2>Authoritative data, translated</h2>
        <p class="text-secondary">Three steps, no jargon, no login.</p>
      </div>
      <div class="editorial-columns">
        <div>
          <h3>We read the CDC</h3>
          <p>The implemented index feeds are emergency-department visits, the Acute Respiratory Illness activity level and wastewater viral activity. Laboratory positivity is unavailable in live readings; illustrative samples can include it. The CDC's COVID-19 epidemic trend, where available, is shown beside a state's readings and never inside the index.</p>
        </div>
        <div>
          <h3>We combine the signals</h3>
          <p>Available signals are blended into a transparent 0–4 combined respiratory index. The trend compares the latest observation with the mean of up to three prior observations. <a href="/methodology/">See the method</a></p>
        </div>
        <div>
          <h3>You get a plain answer</h3>
          <p>State surveillance provides context, with its dates and coverage limits. Missing observations do not mean no illness, and sample data cannot describe current conditions.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section below-fold" style="background: var(--bg-elevated); border-block: 1px solid var(--border)">
    <div class="container">
      <div class="section-head section-rule">
        <h2>Implemented sources and unavailable feeds</h2>
        <p class="text-secondary">A source contributes only where usable observations are available. The underlying signals above list the inputs for the selected reading.</p>
      </div>
      <div class="source-ledger">
        ${sourceCard('Emergency department visits', 'NSSP', 'The share of ER visits for respiratory illness (flu, RSV, COVID-19), by state.')}
        ${sourceCard('Wastewater viral activity', 'NWSS', "The CDC's wastewater index — an early indicator that can lead clinical cases by days.")}
        ${sourceCard('Laboratory test positivity — unavailable live', 'NREVSS', 'No live adapter is implemented. Positivity appears only in clearly labeled illustrative sample inputs.')}
        ${sourceCard('Acute Respiratory Illness level', 'NSSP ARI', "The CDC's categorical activity level, from Very Low to Very High.")}
      </div>
      <div class="callout" style="margin-top: var(--space-xl)">
        <p class="callout__title">${icon('shield-check')} Licensing note</p>
        <p class="text-secondary">FluTrack deliberately uses only public-domain CDC feeds. We exclude non-commercially licensed datasets (such as WastewaterSCAN, CC BY-NC 4.0) so this free, ad-supported utility stays fully within its rights. <a href="/data-sources/">More on our sources</a></p>
      </div>
    </div>
  </section>

  <section class="section below-fold">
    <div class="container">
      <div class="section-head section-rule">
        <h2>Find your state</h2>
      </div>
      <div class="state-index">
        ${ctx.states.slice(0, 12).map((s) => ctx.render.stateChip(s, ctx.models.get(s.abbr).model)).join('')}
      </div>
      <div style="margin-top: var(--space-xl)"><a class="btn btn--secondary" href="/states/">See the respiratory activity map</a></div>
    </div>
  </section>

  ${signupBand()}
  ${adSlot('home-footer')}
  `;

  return {
    title: '',
    description: site.description,
    path: '/',
    body,
    scripts: ['/assets/js/app.js', '/assets/js/map-keyboard.js', '/assets/js/report-boot.js'],
    jsonld: [websiteLd(), organizationLd(), datasetLd(), webApplicationLd()],
  };
}

function sourceCard(title, badge, desc) {
  return `<div class="source-card"><span class="source-card__badge">${escapeHtml(badge)} <span aria-hidden="true">/</span> Public Domain</span><h3>${escapeHtml(title)}</h3><p class="text-secondary">${escapeHtml(desc)}</p></div>`;
}
