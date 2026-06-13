'use strict';

// lib/dashboard/design-render.js — HTML fragments for the Design tab.
// Pure render functions: snapshot in, HTML out. Write paths live in
// routes/dashboard/design.js.

const { escHtml, escAttr, fmtDate, savedFlash } = require('./html');

const BRAND_FIELDS = [
  { key: 'tone', label: 'Tone', rows: 2, max: 500, hint: 'How the copy should sound.' },
  { key: 'audience', label: 'Audience', rows: 2, max: 500, hint: 'Who we are talking to.' },
  { key: 'directive', label: 'Content directive', rows: 3, max: 1000, hint: 'Standing instruction for every generation run.' },
  { key: 'visual_directive', label: 'Visual directive', rows: 2, max: 500, hint: 'Steers theme choice for graphics and reels.' },
];

function sectionShell(id, title, sub, bodyHtml) {
  return `<section class="design-section" id="design-${escAttr(id)}">
  <div class="section-head">
    <h3>${escHtml(title)}</h3>
    ${sub ? `<p class="section-sub">${escHtml(sub)}</p>` : ''}
  </div>
  ${bodyHtml}
</section>`;
}

// ── Brand voice ────────────────────────────────────────────────────────────

function renderBrandCard(brand, values, isActive) {
  const fields = BRAND_FIELDS.map(({ key, label, rows, max, hint }) => `
  <form class="design-field" hx-post="/dashboard/design/brand/${escAttr(brand)}/${escAttr(key)}"
        hx-target="closest .design-field" hx-swap="outerHTML">
    <label>${escHtml(label)} <span class="hint">${escHtml(hint)}</span></label>
    <textarea name="value" rows="${rows}" maxlength="${max}">${escHtml(values[key] || '')}</textarea>
    <div class="field-row">
      <button type="submit" class="btn btn-save">Save</button>
      <button type="submit" name="clear" value="1" class="btn btn-clear">Reset to default</button>
      ${savedFlash()}
    </div>
  </form>`).join('\n');

  const messages = (values.messages || []).join('\n');
  return `<div class="design-brand-card" id="design-brand-${escAttr(brand)}">
  <div class="design-brand-head">
    <strong>${escHtml(values.name || brand)}</strong>
    <span class="hint">${escHtml(values.url || '')}</span>
    <form class="brand-active-toggle" hx-post="/dashboard/design/brand/${escAttr(brand)}/active"
          hx-target="closest .brand-active-toggle" hx-swap="outerHTML">
      <label class="toggle">
        <input type="checkbox" name="active" ${isActive ? 'checked' : ''}
               onchange="this.form.requestSubmit()">
        <span>${isActive ? 'Generating' : 'Paused'}</span>
      </label>
      ${savedFlash()}
    </form>
  </div>
${fields}
  <form class="design-field" hx-post="/dashboard/design/brand/${escAttr(brand)}/messages"
        hx-target="closest .design-field" hx-swap="outerHTML">
    <label>Key messages <span class="hint">One per line — woven into copy.</span></label>
    <textarea name="value" rows="4">${escHtml(messages)}</textarea>
    <div class="field-row">
      <button type="submit" class="btn btn-save">Save</button>
      <button type="submit" name="clear" value="1" class="btn btn-clear">Reset to default</button>
      ${savedFlash()}
    </div>
  </form>
</div>`;
}

function renderBrandVoiceSection(snapshot) {
  const cards = snapshot.brands
    .map(b => renderBrandCard(b, snapshot.perBrand[b], snapshot.global.active_brands.includes(b)))
    .join('\n');
  return sectionShell('voice', 'Brand voice', 'Tone, audience and standing directives per brand.', `<div class="design-brand-grid">${cards}</div>`);
}

// Single-field fragment re-render (post-save swap target).
function renderBrandField(brand, key, value) {
  const f = BRAND_FIELDS.find(x => x.key === key);
  const label = f ? f.label : 'Key messages';
  const rows = f ? f.rows : 4;
  const max = f ? ` maxlength="${f.max}"` : '';
  const hint = f ? f.hint : 'One per line — woven into copy.';
  const path = f ? key : 'messages';
  const text = Array.isArray(value) ? value.join('\n') : (value || '');
  return `<form class="design-field" hx-post="/dashboard/design/brand/${escAttr(brand)}/${escAttr(path)}"
        hx-target="closest .design-field" hx-swap="outerHTML">
    <label>${escHtml(label)} <span class="hint">${escHtml(hint)}</span></label>
    <textarea name="value" rows="${rows}"${max}>${escHtml(text)}</textarea>
    <div class="field-row">
      <button type="submit" class="btn btn-save">Save</button>
      <button type="submit" name="clear" value="1" class="btn btn-clear">Reset to default</button>
      ${savedFlash()}
    </div>
  </form>`;
}

function renderBrandActiveToggle(brand, isActive) {
  return `<form class="brand-active-toggle" hx-post="/dashboard/design/brand/${escAttr(brand)}/active"
        hx-target="closest .brand-active-toggle" hx-swap="outerHTML">
    <label class="toggle">
      <input type="checkbox" name="active" ${isActive ? 'checked' : ''}
             onchange="this.form.requestSubmit()">
      <span>${isActive ? 'Generating' : 'Paused'}</span>
    </label>
    ${savedFlash()}
  </form>`;
}

// ── Patterns (hook / CTA) ─────────────────────────────────────────────────

function renderPatternList(kind, patterns) {
  const rows = (patterns || []).map((p, i) => `
    <li class="pattern-row">
      <span class="pattern-body">${escHtml(p.body || String(p))}</span>
      <form hx-post="/dashboard/design/patterns/${escAttr(kind)}/remove"
            hx-target="#patterns-${escAttr(kind)}" hx-swap="outerHTML">
        <input type="hidden" name="index" value="${i}">
        <button type="submit" class="btn btn-clear btn-tiny" title="Remove">✕</button>
      </form>
    </li>`).join('\n');

  return `<div class="pattern-block" id="patterns-${escAttr(kind)}">
  <ul class="pattern-list">${rows || '<li class="hint">No patterns yet.</li>'}</ul>
  <form class="pattern-add" hx-post="/dashboard/design/patterns/${escAttr(kind)}/add"
        hx-target="#patterns-${escAttr(kind)}" hx-swap="outerHTML">
    <input type="text" name="body" placeholder="Add a ${escAttr(kind)} pattern, or describe an idea and use Draft with AI&hellip;" autocomplete="off">
    <button type="submit" class="btn btn-save">Add</button>
    <button type="submit" class="btn btn-rerender"
            formaction="/dashboard/design/patterns/${escAttr(kind)}/draft"
            hx-post="/dashboard/design/patterns/${escAttr(kind)}/draft">Draft with AI</button>
    ${savedFlash()}
  </form>
</div>`;
}

function renderPatternsSection(snapshot) {
  return sectionShell('patterns', 'Hook & CTA patterns',
    'The rhetorical moves generation can draw on. Drafted patterns land in the input for review before you add them.',
    `<div class="pattern-cols">
  <div><h4>Hooks</h4>${renderPatternList('hook', snapshot.global.hook_patterns)}</div>
  <div><h4>CTAs</h4>${renderPatternList('cta', snapshot.global.cta_patterns)}</div>
</div>`);
}

// Draft result: same block with the suggestion pre-filled in the input.
function renderPatternListWithDraft(kind, patterns, draftText) {
  const block = renderPatternList(kind, patterns);
  return block.replace(
    /placeholder="[^"]*" autocomplete="off">/,
    `placeholder="" autocomplete="off" value="${escAttr(draftText)}">`
  );
}

// ── Template mix ──────────────────────────────────────────────────────────

function renderMixSection(snapshot) {
  const weights = snapshot.global.template_weights || {};
  const inputs = (snapshot.menus.templateTypes || []).map(t => `
    <label class="mix-item">
      <span>${escHtml(t)}</span>
      <input type="number" name="weight_${escAttr(t)}" min="0" max="5"
             value="${Number.isFinite(weights[t]) ? weights[t] : 1}">
    </label>`).join('\n');

  return sectionShell('mix', 'Template mix',
    'Relative weight of each template type in the daily batch (0 = never).',
    `<form class="mix-form" hx-post="/dashboard/design/mix" hx-target="#design-mix" hx-swap="outerHTML">
  <div class="mix-row">${inputs}</div>
  <div class="field-row">
    <button type="submit" class="btn btn-save">Save mix</button>
    <button type="submit" name="reset" value="1" class="btn btn-clear">Reset to defaults</button>
    ${savedFlash()}
  </div>
</form>`);
}

// ── Timing (per-template video durations) ────────────────────────────────

function renderTimingSection(snapshot) {
  const durations = snapshot.global.template_durations || {};
  const inputs = Object.entries(durations).map(([t, secs]) => `
    <label class="mix-item">
      <span>${escHtml(t)}</span>
      <input type="number" name="duration_${escAttr(t)}" min="3" max="90" value="${Number(secs)}">
    </label>`).join('\n');

  return sectionShell('timing', 'Video length',
    'Default seconds per template type for every newly generated video. Override any single post from its Studio card.',
    `<form class="mix-form" hx-post="/dashboard/design/durations" hx-target="#design-timing" hx-swap="outerHTML">
  <div class="mix-row">${inputs}</div>
  <div class="field-row">
    <button type="submit" class="btn btn-save">Save lengths</button>
    <button type="submit" name="reset" value="1" class="btn btn-clear">Reset to defaults</button>
    ${savedFlash()}
  </div>
</form>`);
}

// ── Lot of the Day schedule ───────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderScheduleSection(snapshot) {
  const schedule = snapshot.global.lot_archetype_schedule || [];
  const archetypes = snapshot.menus.archetypes || [];
  const selects = DAY_NAMES.map((day, i) => {
    const opts = archetypes.map(a =>
      `<option value="${escAttr(a)}"${schedule[i] === a ? ' selected' : ''}>${escHtml(a)}</option>`).join('');
    return `<label class="sched-item"><span>${escHtml(day)}</span><select name="day_${i}">${opts}</select></label>`;
  }).join('\n');

  return sectionShell('schedule', 'Lot of the Day schedule',
    'Which lot archetype runs each day of the week.',
    `<form class="sched-form" hx-post="/dashboard/design/lot-schedule" hx-target="#design-schedule" hx-swap="outerHTML">
  <div class="sched-row">${selects}</div>
  <div class="field-row">
    <button type="submit" class="btn btn-save">Save schedule</button>
    <button type="submit" name="reset" value="1" class="btn btn-clear">Reset to default</button>
    ${savedFlash()}
  </div>
</form>`);
}

// ── Manual triggers ───────────────────────────────────────────────────────

function renderTriggersSection(snapshot) {
  const archOpts = (snapshot.menus.archetypes || []).map(a =>
    `<option value="${escAttr(a)}">${escHtml(a)}</option>`).join('');
  return sectionShell('triggers', 'Manual triggers',
    'Fire a run now instead of waiting for the cron. Results arrive in Telegram and the Studio tab.',
    `<div class="trigger-row">
  <form hx-post="/dashboard/design/trigger/generate" hx-target="#trigger-result" hx-swap="innerHTML">
    <button type="submit" class="btn btn-approve">Generate social batch now</button>
  </form>
  <form class="trigger-lot" hx-post="/dashboard/design/trigger/lot" hx-target="#trigger-result" hx-swap="innerHTML">
    <select name="archetype"><option value="">Today's archetype</option>${archOpts}</select>
    <button type="submit" class="btn btn-approve">Run Lot of the Day</button>
  </form>
</div>
<div id="trigger-result" class="hint"></div>`);
}

// ── Live blogs ────────────────────────────────────────────────────────────

function renderLiveBlogs(posts) {
  const rows = (posts || []).map(p => `
    <li><span class="chip ${escAttr(p.brand)}">${escHtml(p.brand)}</span>
      <a href="${escAttr(p.url)}" target="_blank" rel="noopener">${escHtml(p.title)}</a>
      <span class="hint">${escHtml(fmtDate(p.published_at))}</span></li>`).join('\n');
  return `<ul class="live-blogs" id="live-blogs">${rows || '<li class="hint">No published posts yet.</li>'}</ul>`;
}

function renderLiveBlogsSection() {
  return sectionShell('blogs', 'Live blogs',
    'What is already published on both landing pages — avoid approving near-duplicates.',
    `<div id="live-blogs-slot" hx-get="/dashboard/design/live-blogs" hx-trigger="load" hx-swap="innerHTML">
  <p class="loading">Loading&hellip;</p>
</div>`);
}

// ── Tab assembly ──────────────────────────────────────────────────────────

function renderDesignTab(snapshot) {
  return `<section class="tab-section design">
  <div class="section-head">
    <h2>Design</h2>
    <p class="section-sub">Every creative lever in one place — voice, patterns, mix, schedule and triggers.</p>
  </div>
  ${renderBrandVoiceSection(snapshot)}
  ${renderPatternsSection(snapshot)}
  ${renderMixSection(snapshot)}
  ${renderTimingSection(snapshot)}
  ${renderScheduleSection(snapshot)}
  ${renderTriggersSection(snapshot)}
  ${renderLiveBlogsSection()}
</section>`;
}

module.exports = {
  renderDesignTab,
  renderBrandVoiceSection,
  renderBrandCard,
  renderBrandField,
  renderBrandActiveToggle,
  renderPatternsSection,
  renderPatternList,
  renderPatternListWithDraft,
  renderMixSection,
  renderTimingSection,
  renderScheduleSection,
  renderTriggersSection,
  renderLiveBlogs,
};
