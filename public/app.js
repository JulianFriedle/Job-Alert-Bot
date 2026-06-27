// ── tiny helpers ───────────────────────────────────────────────────────────
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
// The active tenant. Data requests are auto-scoped with ?clientId=…; a handful of
// global/operator endpoints (below) are exempt.
let currentClientId = null;
const CLIENT_AGNOSTIC = ['/api/clients', '/api/login', '/api/logout', '/api/auth', '/api/settings', '/api/setup', '/api/update', '/api/restart', '/api/backups'];
const api = async (url, opts) => {
  if (currentClientId && url.startsWith('/api/') && !CLIENT_AGNOSTIC.some(p => url.startsWith(p))) {
    url += (url.includes('?') ? '&' : '?') + 'clientId=' + encodeURIComponent(currentClientId);
  }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// i18n (dictionary, t(), setLang, applyStaticI18n, settings/wizard maps) lives in i18n.js,
// which is loaded before this script. Those identifiers are globals here.
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(locale()) : '';

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ── tab switching ───────────────────────────────────────────────────────────
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
  const name = tab.dataset.tab;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'sources' && !sourcesLoaded) loadSources();
  if (name === 'stats') loadStats();
  if (name === 'settings' && !settingsLoaded) loadSettings();
  if (name === 'settings') loadBackups();
  if (name === 'profile' && !profileLoaded) loadProfile();
  if (name === 'prompts' && !promptsLoaded) loadPrompts();
  if (name === 'clients') renderClients();
  if (name === 'run') loadRecentRuns();
});

// ── JOBS ────────────────────────────────────────────────────────────────────
let allJobs = [];

async function loadJobs() {
  try {
    allJobs = await api('/api/jobs');
    populateSourceFilter();
    renderStats();
    renderJobs();
  } catch (err) {
    toast(t('toast.loadError') + err.message);
  }
}

function populateSourceFilter() {
  const sel = $('#filter-source');
  const current = sel.value;
  const sources = [...new Set(allJobs.map(j => j.source).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">${esc(t('jobs.allSources'))}</option>` +
    sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  sel.value = current;
}

function renderStats() {
  const total = allJobs.length;
  const applied = allJobs.filter(j => j.applied).length;
  const high = allJobs.filter(j => (j.score ?? 0) >= 8).length;
  const avg = total ? (allJobs.reduce((s, j) => s + (j.score ?? 0), 0) / total).toFixed(1) : '–';
  $('#stats').innerHTML = `
    <div class="stat"><div class="v">${total}</div><div class="l">${esc(t('stat.relevantJobs'))}</div></div>
    <div class="stat"><div class="v">${high}</div><div class="l">${esc(t('stat.topMatch'))}</div></div>
    <div class="stat"><div class="v">${avg}</div><div class="l">${esc(t('stat.avgScore'))}</div></div>
    <div class="stat"><div class="v">${applied}</div><div class="l">${esc(t('stat.applied'))}</div></div>`;
}

function filteredJobs() {
  const q = $('#search').value.trim().toLowerCase();
  const src = $('#filter-source').value;
  const st = $('#filter-status').value;
  const minScore = Number($('#filter-score').value);
  const jobs = allJobs.filter(j => {
    if (src && j.source !== src) return false;
    if ((j.score ?? 0) < minScore) return false;
    if (st === 'none' && j.status) return false;
    if (st && st !== 'none' && j.status !== st) return false;
    if (q) {
      const hay = `${j.title} ${j.company} ${j.location} ${j.source}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // `scraped_at` is the ISO timestamp when a job was first found; ISO strings
  // sort correctly as plain strings. "default" keeps the server's order.
  const sort = $('#sort')?.value;
  if (sort === 'found-asc') jobs.sort((a, b) => (a.scraped_at || '').localeCompare(b.scraped_at || ''));
  else if (sort === 'found-desc') jobs.sort((a, b) => (b.scraped_at || '').localeCompare(a.scraped_at || ''));
  return jobs;
}

function scoreClass(s) {
  s = s ?? 0;
  return s >= 8 ? 's-high' : s >= 6 ? 's-mid' : 's-low';
}

function renderJobs() {
  const jobs = filteredJobs();
  $('#result-count').textContent = `${jobs.length} ${t('jobs.of')} ${allJobs.length}`;
  $('#jobs-empty').hidden = jobs.length > 0;
  const list = $('#job-list');

  list.innerHTML = jobs.map(j => {
    const statuses = ['applied', 'interview', 'offer', 'rejected'];
    const opts = [`<option value="">${esc(t('jobs.statusPlaceholder'))}</option>`,
      ...statuses.map(s => `<option value="${s}"${j.status === s ? ' selected' : ''}>${esc(statusLabel(s))}</option>`)
    ].join('');
    const pill = j.status ? `<span class="pill st-${j.status}">${esc(statusLabel(j.status))}${j.applied_at ? ' · ' + fmtDate(j.applied_at) : ''}</span>` : '';
    const loc = j.location ? `<span>${esc(j.location)}</span><span class="dot">·</span>` : '';
    return `
      <article class="job" data-id="${esc(j.id)}">
        <div class="score-badge ${scoreClass(j.score)}">${j.score ?? '–'}</div>
        <div class="job-main">
          <div class="job-title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></div>
          <div class="job-meta">
            <strong>${esc(j.company || j.source)}</strong><span class="dot">·</span>
            ${loc}<span>${esc(j.source)}</span>
            ${pill ? '<span class="dot">·</span>' + pill : ''}
          </div>
          ${j.summary ? `<div class="job-summary">${esc(j.summary)}</div>` : ''}
        </div>
        <div class="job-actions">
          <select class="js-status" title="${esc(t('job.statusTitle'))}">${opts}</select>
          <div class="row">
            <button class="btn btn-ghost js-cover" title="${esc(t('job.coverTitle'))}">✎</button>
            <a class="btn btn-ghost" href="${esc(j.url)}" target="_blank" rel="noopener" title="${esc(t('job.openTitle'))}">↗</a>
            <button class="btn btn-ghost btn-danger js-ignore" title="${esc(t('job.ignoreTitle'))}">✕</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

// Job interactions (event delegation)
$('#job-list').addEventListener('change', async (e) => {
  const sel = e.target.closest('.js-status');
  if (!sel) return;
  const id = e.target.closest('.job').dataset.id;
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(id)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: sel.value || null }),
    });
    const job = allJobs.find(j => j.id === id);
    Object.assign(job, { status: updated.status, applied: updated.applied, applied_at: updated.applied_at });
    renderStats(); renderJobs();
    toast(sel.value ? `Status: ${statusLabel(sel.value)}` : t('toast.statusReset'));
  } catch (err) { toast(t('toast.error') + err.message); }
});

$('#job-list').addEventListener('click', async (e) => {
  if (e.target.closest('.js-cover')) {
    const id = e.target.closest('.job').dataset.id;
    return openCoverLetter(allJobs.find(j => j.id === id));
  }

  const btn = e.target.closest('.js-ignore');
  if (!btn) return;
  const card = e.target.closest('.job');
  const id = card.dataset.id;
  if (!confirm(t('job.confirmIgnore'))) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/ignore`, { method: 'POST' });
    allJobs = allJobs.filter(j => j.id !== id);
    renderStats(); renderJobs();
    toast(t('toast.hidden'));
  } catch (err) { toast(t('toast.error') + err.message); }
});

// ── COVER LETTER MODAL ───────────────────────────────────────────────────────
let coverJob = null;

async function openCoverLetter(job) {
  if (!job) return;
  coverJob = job;
  $('#cl-sub').textContent = `${job.title} · ${job.company || job.source}`;
  // Initial state: let the user add optional notes before generating.
  $('#cl-notes').value = '';
  $('#cl-loading').hidden = true;
  $('#cl-text').hidden = true;
  $('#cl-error').hidden = true;
  $('#cl-copy').hidden = true;
  $('#cl-regen').hidden = true;
  $('#cl-generate').hidden = false;
  updateAppliedBtn();
  $('#cl-modal').hidden = false;
  $('#cl-notes').focus();
}

// Reflect the job's current status on the header "Applied" button.
function updateAppliedBtn() {
  const btn = $('#cl-applied');
  const done = coverJob && coverJob.status === 'applied';
  btn.classList.toggle('is-applied', done);
  btn.textContent = done ? t('cover.appliedDone') : t('cover.applied');
}

async function generateCover() {
  const loading = $('#cl-loading'), text = $('#cl-text'), error = $('#cl-error');
  const notes = $('#cl-notes').value.trim();
  loading.hidden = false; text.hidden = true; error.hidden = true;
  $('#cl-copy').hidden = true; $('#cl-regen').hidden = true; $('#cl-generate').hidden = true;
  try {
    const { text: letter } = await api(`/api/jobs/${encodeURIComponent(coverJob.id)}/cover-letter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    text.value = letter;
    loading.hidden = true; text.hidden = false;
    $('#cl-copy').hidden = false; $('#cl-regen').hidden = false;
    autosize(text);
  } catch (err) {
    loading.hidden = true; error.hidden = false;
    error.textContent = err.message;
    $('#cl-regen').hidden = false;
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * 0.6) + 'px';
}

function closeCover() { $('#cl-modal').hidden = true; coverJob = null; }

$('#cl-close').addEventListener('click', closeCover);
$('#cl-modal').addEventListener('click', (e) => { if (e.target.id === 'cl-modal') closeCover(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cl-modal').hidden) closeCover(); });
$('#cl-generate').addEventListener('click', generateCover);
$('#cl-regen').addEventListener('click', generateCover);
$('#cl-applied').addEventListener('click', async () => {
  if (!coverJob || coverJob.status === 'applied') return;
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(coverJob.id)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'applied' }),
    });
    Object.assign(coverJob, { status: updated.status, applied: updated.applied, applied_at: updated.applied_at });
    const job = allJobs.find(j => j.id === coverJob.id);
    if (job) Object.assign(job, { status: updated.status, applied: updated.applied, applied_at: updated.applied_at });
    updateAppliedBtn();
    renderStats(); renderJobs();
    toast(`Status: ${statusLabel('applied')}`);
  } catch (err) { toast(t('toast.error') + err.message); }
});
$('#cl-text').addEventListener('input', (e) => autosize(e.target));

$('#cl-copy').addEventListener('click', async () => {
  const txt = $('#cl-text').value;
  try {
    await navigator.clipboard.writeText(txt);
    toast(t('toast.copied'));
  } catch {
    // Fallback for non-secure contexts (http://localhost is usually fine, but just in case)
    const ta = $('#cl-text');
    ta.select(); document.execCommand('copy');
    toast(t('toast.copiedShort'));
  }
});

['input', 'change'].forEach(ev => {
  $('#search').addEventListener(ev, renderJobs);
});
['#filter-source', '#filter-status', '#filter-score', '#sort'].forEach(s =>
  $(s).addEventListener('change', renderJobs));

// ── STATS ─────────────────────────────────────────────────────────────────--
let statsLoaded = false;

async function loadStats() {
  try {
    const s = await api('/api/stats');
    renderStatCards(s.totals);
    renderStatusBreakdown(s.statusBreak);
    renderHeatmap(s.activity);
    renderAppliedChart(s.appliedByCompany);
    renderSourcesChart(s.allTime);
    renderRunHistory(s.runHistory);
    renderOverviewTable(s.overview, s.allTime);
    statsLoaded = true;
  } catch (err) { toast(t('stats.error') + err.message); }
}

function renderStatCards(totals = {}) {
  const cards = [
    [t('stats.cardTotal'), totals.total ?? 0],
    [t('stats.cardRelevant'), totals.relevant ?? 0],
    [t('stats.cardNotified'), totals.notified ?? 0],
    [t('stats.cardApplied'), totals.applied ?? 0],
  ];
  $('#stats-cards').innerHTML = cards.map(([l, v]) =>
    `<div class="stat"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('');
}

// Funnel of where applications currently stand (applied → interview → offer /
// rejected). Uses the `statusBreak` payload, which sums to the "Beworben" total.
function renderStatusBreakdown(breakdown = {}) {
  const order = ['applied', 'interview', 'offer', 'rejected'];
  const total = order.reduce((sum, k) => sum + (breakdown[k] || 0), 0);
  const el = $('#status-breakdown');
  if (!el) return;
  if (!total) { el.innerHTML = ''; return; }
  el.innerHTML = order.map(k => `
    <div class="sb-chip st-${k}">
      <span class="sb-n">${breakdown[k] || 0}</span>
      <span class="sb-l">${esc(statusLabel(k))}</span>
    </div>`).join('');
}

// GitHub-style contribution heatmap of application activity (last ~53 weeks).
function renderHeatmap(activity = {}) {
  const WEEKS = 53;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Start on the Sunday WEEKS-1 weeks before the start of this week
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);

  const counts = Object.values(activity);
  const max = counts.length ? Math.max(...counts) : 0;
  const level = (c) => {
    if (!c) return 0;
    if (max <= 1) return 4;
    const r = c / max;
    return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
  };

  // Local-calendar-day key (NOT toISOString, which converts to UTC and shifts the
  // day in non-UTC timezones). Must match the server's date(applied_at,'localtime').
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const MONTHS = t('months');
  let total = 0;
  const cols = [];
  let monthLabels = '';
  for (let w = 0; w < WEEKS; w++) {
    let col = '';
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) { col += `<span class="hm-cell hm-empty"></span>`; continue; }
      const key = ymd(date);
      const c = activity[key] || 0;
      total += c;
      const titleTxt = `${applicationsN(c)} · ${date.toLocaleDateString(locale())}`;
      col += `<span class="hm-cell l${level(c)}" title="${titleTxt}"></span>`;
    }
    // month label when the first day of a week is in the first week of a month
    const firstOfCol = new Date(start); firstOfCol.setDate(start.getDate() + w * 7);
    const lbl = (firstOfCol.getDate() <= 7) ? MONTHS[firstOfCol.getMonth()] : '';
    monthLabels += `<span class="hm-month">${lbl}</span>`;
    cols.push(`<div class="hm-col">${col}</div>`);
  }
  // Weekday labels (rows are Sun-first); show Mon/Wed/Fri to stay uncluttered.
  const WD = t('weekdays');
  const weekdays = Array.from({ length: 7 }, (_, d) =>
    `<span class="hm-weekday">${d % 2 === 1 ? WD[d] : ''}</span>`).join('');
  $('#heatmap').innerHTML =
    `<div class="hm-weekdays">${weekdays}</div>` +
    `<div class="hm-body">` +
      `<div class="hm-months">${monthLabels}</div><div class="hm-grid">${cols.join('')}</div>` +
    `</div>`;
  $('#activity-total').textContent = applicationsN(total) + t('stats.inLastYear');
}

// Minimal dependency-free SVG bar chart (vertical).
function barChartV(data, { color = 'var(--accent)', height = 160 } = {}) {
  const entries = Object.entries(data);
  if (!entries.length) return `<p class="muted" style="padding:24px 4px">${esc(t('stats.noData'))}</p>`;
  const max = Math.max(...entries.map(([, v]) => v));
  const bw = 100 / entries.length;
  const bars = entries.map(([k, v], i) => {
    const h = max ? (v / max) * 78 : 0;
    const x = i * bw + bw * 0.15;
    const w = bw * 0.7;
    return `<rect x="${x}" y="${88 - h}" width="${w}" height="${h}" rx="1.2" fill="${color}"></rect>
            <text x="${x + w / 2}" y="${86 - h - 1}" class="bar-val" text-anchor="middle">${v}</text>
            <text x="${x + w / 2}" y="98" class="bar-lbl" text-anchor="middle">${esc(k)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:${height}px">${bars}</svg>`;
}

// Horizontal bars: companies you applied to most.
function renderAppliedChart(rows = []) {
  const top = [...rows].filter(r => r.count > 0).slice(0, 8);
  if (!top.length) { $('#chart-applied').innerHTML = `<p class="muted" style="padding:24px 4px">${esc(t('stats.noApplications'))}</p>`; return; }
  const max = Math.max(...top.map(r => r.count));
  $('#chart-applied').innerHTML = `<div class="hbars">` + top.map(r => `
    <div class="hbar-row">
      <span class="hbar-lbl" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(r.count / max) * 100}%"></span></span>
      <span class="hbar-val">${r.count}</span>
    </div>`).join('') + `</div>`;
}

// Horizontal bars for top sources by relevant count.
function renderSourcesChart(allTime = []) {
  const top = [...allTime].filter(s => s.relevant > 0).sort((a, b) => b.relevant - a.relevant).slice(0, 8);
  if (!top.length) { $('#chart-sources').innerHTML = `<p class="muted" style="padding:24px 4px">${esc(t('stats.noData'))}</p>`; return; }
  const max = Math.max(...top.map(s => s.relevant));
  $('#chart-sources').innerHTML = `<div class="hbars">` + top.map(s => `
    <div class="hbar-row">
      <span class="hbar-lbl" title="${esc(s.source)}">${esc(s.source)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(s.relevant / max) * 100}%"></span></span>
      <span class="hbar-val">${s.relevant}</span>
    </div>`).join('') + `</div>`;
}

// Build the y-axis tick values for a log chart: 0, then each power of ten up to
// the data max (plus the max itself so the top line is labelled with its value).
function logTicks(max) {
  const ticks = [0];
  for (let p = 1; p <= max; p *= 10) ticks.push(p);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

// Line chart of found vs relevant over recent runs (log y-scale so the small
// relevant counts stay readable next to the much larger found counts).
function renderRunHistory(runs = []) {
  const card = $('#card-runhistory');
  if (!runs || runs.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const PX_H = 180;
  const W = 100, H = 100, pad = 4;
  const rawMax = Math.max(...runs.map(r => r.total_found || 0), 1);
  // log10(v + 1) keeps zero at the baseline while still spreading out low values.
  const lg = (v) => Math.log10((v || 0) + 1);
  const lgMax = lg(rawMax) || 1;
  const xFor = (i) => pad + (i / (runs.length - 1)) * (W - 2 * pad);
  const yFor = (v) => (H - pad) - (lg(v) / lgMax) * (H - 2 * pad - 6);
  const dateOf = (r) => {
    const d = r.ran_at ? new Date(r.ran_at) : null;
    return d ? d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }) : '';
  };
  const line = (key, color) => {
    const pts = runs.map((r, i) => `${xFor(i)},${yFor(r[key] || 0)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  };
  const ticks = logTicks(rawMax);
  const grid = ticks.map(v =>
    `<line x1="${pad}" y1="${yFor(v)}" x2="${W - pad}" y2="${yFor(v)}" stroke="var(--border)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`
  ).join('');
  const yLabels = ticks.map(v =>
    `<span style="top:${yFor(v)}%">${v}</span>`
  ).join('');
  // A few evenly spaced x-axis date labels (avoid crowding on dense histories).
  const xCount = Math.min(runs.length, 5);
  const xLabels = Array.from({ length: xCount }, (_, k) => {
    const i = Math.round(k * (runs.length - 1) / (xCount - 1));
    const label = dateOf(runs[i]) || (i + 1);
    return `<span style="left:${xFor(i)}%">${esc(String(label))}</span>`;
  }).join('');
  $('#chart-runs').innerHTML = `
    <div class="runchart">
      <div class="runchart-yaxis">${yLabels}</div>
      <div class="runchart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:${PX_H}px">
          ${grid}
          ${line('total_found', 'var(--muted)')}
          ${line('total_relevant', 'var(--accent)')}
        </svg>
        <div class="runchart-hover" hidden>
          <div class="rc-vline"></div>
          <div class="rc-dot rc-dot-found"></div>
          <div class="rc-dot rc-dot-rel"></div>
        </div>
        <div class="runchart-tip" hidden></div>
        <div class="runchart-xaxis">${xLabels}</div>
      </div>
    </div>
    <div class="legend">
      <span><i style="background:var(--muted)"></i> ${esc(t('stats.legendFound'))}</span>
      <span><i style="background:var(--accent)"></i> ${esc(t('stats.legendRelevant'))}</span>
      <span class="legend-note">${esc(t('stats.logScale'))}</span>
    </div>`;

  // Hover interaction: snap to the nearest run and show exact counts.
  const points = runs.map((r, i) => ({
    x: xFor(i),
    found: r.total_found || 0,
    rel: r.total_relevant || 0,
    yFound: yFor(r.total_found || 0) / 100 * PX_H,
    yRel: yFor(r.total_relevant || 0) / 100 * PX_H,
    date: dateOf(r),
  }));
  const plot  = $('#chart-runs .runchart-plot');
  const hover = plot.querySelector('.runchart-hover');
  const vline = plot.querySelector('.rc-vline');
  const dotF  = plot.querySelector('.rc-dot-found');
  const dotR  = plot.querySelector('.rc-dot-rel');
  const tip   = plot.querySelector('.runchart-tip');
  plot.addEventListener('mousemove', (ev) => {
    const rect = plot.getBoundingClientRect();
    const frac = ((ev.clientX - rect.left) / rect.width) * 100;
    let best = 0, bestD = Infinity;
    points.forEach((p, i) => { const d = Math.abs(p.x - frac); if (d < bestD) { bestD = d; best = i; } });
    const p = points[best];
    hover.hidden = false;
    vline.style.left = p.x + '%';
    dotF.style.left  = p.x + '%'; dotF.style.top = p.yFound + 'px';
    dotR.style.left  = p.x + '%'; dotR.style.top = p.yRel + 'px';
    tip.hidden = false;
    tip.innerHTML =
      `<div class="rc-tip-date">${esc(p.date)}</div>` +
      `<div><i style="background:var(--muted)"></i>${esc(t('stats.legendFound'))}: <b>${p.found}</b></div>` +
      `<div><i style="background:var(--accent)"></i>${esc(t('stats.legendRelevant'))}: <b>${p.rel}</b></div>`;
    // Keep the tip inside the plot; flip to the left of the cursor near the edge.
    const flip = p.x > 60;
    tip.style.left = `calc(${p.x}% ${flip ? '- 12px' : '+ 12px'})`;
    tip.style.transform = flip ? 'translateX(-100%)' : 'none';
  });
  plot.addEventListener('mouseleave', () => { hover.hidden = true; tip.hidden = true; });
}

function renderOverviewTable(overview, allTime = []) {
  const table = $('#overview-table');
  if (overview && overview.rows?.length) {
    $('#overview-sub').textContent = overview.combined
      ? `${overview.runCount} ${t('stats.runsWord')} ${t('stats.combinedRuns')}`
      : t('stats.lastRun') + new Date(overview.ranAt).toLocaleString(locale());
    const head = t('stats.headers');
    const rows = overview.rows.map(r => `<tr>
      <td class="t-name">${esc(r.source)}</td>
      <td>${r.found}</td><td>${r.siteTotal ?? '–'}</td><td>${r.newDb}</td>
      <td>${r.blocked}</td><td>${r.analyzed}</td>
      <td class="${r.newRelevant ? 'hl' : ''}">${r.newRelevant}</td>
      <td class="strong">${r.totalRelevant}</td><td>${r.notified}</td>
    </tr>`).join('');
    const sum = (k) => overview.rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const foot = `<tr class="t-foot">
      <td>${esc(t('stats.total'))}</td><td>${sum('found')}</td><td></td><td>${sum('newDb')}</td>
      <td>${sum('blocked')}</td><td>${sum('analyzed')}</td><td>${sum('newRelevant')}</td>
      <td>${sum('totalRelevant')}</td><td>${sum('notified')}</td></tr>`;
    table.innerHTML = `<thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}${foot}</tbody>`;
  } else {
    // Fallback to all-time aggregates until the first run is recorded
    $('#overview-sub').textContent = t('stats.allTimeSub');
    const head = t('stats.headersFallback');
    const rows = allTime.map(r => `<tr>
      <td class="t-name">${esc(r.source)}</td>
      <td>${r.found}</td><td>${r.analyzed}</td>
      <td class="strong">${r.relevant}</td><td>${r.notified}</td><td>${r.applied}</td>
    </tr>`).join('');
    const sum = (k) => allTime.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const foot = `<tr class="t-foot"><td>${esc(t('stats.total'))}</td><td>${sum('found')}</td><td>${sum('analyzed')}</td>
      <td>${sum('relevant')}</td><td>${sum('notified')}</td><td>${sum('applied')}</td></tr>`;
    table.innerHTML = `<thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}${foot}</tbody>`;
  }
}

// ── SOURCES ─────────────────────────────────────────────────────────────────
let sourcesLoaded = false;

async function loadSources() {
  try {
    const cfg = await api('/api/sources');
    renderSources(cfg.sources || []);
    sourcesLoaded = true;
  } catch (err) { toast(t('toast.error') + err.message); }
}

function sourceRow(s = { name: '', url: '' }) {
  const div = document.createElement('div');
  div.className = 'source-row';
  div.innerHTML = `
    <input class="name" placeholder="${esc(t('sources.namePh'))}" value="${esc(s.name)}">
    <input class="url" placeholder="${esc(t('sources.urlPh'))}" value="${esc(s.url)}">
    <button class="btn btn-ghost btn-danger js-del" title="${esc(t('sources.delTitle'))}">✕</button>`;
  div.querySelector('.js-del').addEventListener('click', () => { div.remove(); updateSourceCount(); });
  // preserve any extra config fields (paginationParam, extraWait, …) on the element
  div._extra = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'name' && k !== 'url'));
  return div;
}

function renderSources(sources) {
  const list = $('#source-list');
  list.innerHTML = '';
  sources.forEach(s => list.appendChild(sourceRow(s)));
  updateSourceCount();
}

function updateSourceCount() {
  const n = $$('#source-list .source-row').length;
  $('#sources-count').textContent = careerPagesN(n);
}

$('#add-source').addEventListener('click', () => {
  const row = sourceRow();
  $('#source-list').appendChild(row);
  updateSourceCount();
  row.querySelector('.name').focus();
});

$('#save-sources').addEventListener('click', async () => {
  const rows = $$('#source-list .source-row');
  const sources = [];
  for (const row of rows) {
    const name = row.querySelector('.name').value.trim();
    const url = row.querySelector('.url').value.trim();
    if (!name || !url) {
      showSourcesMsg(t('sources.needNameUrl'), 'err');
      return;
    }
    sources.push({ name, url, type: row._extra?.type || 'careers-page', ...row._extra });
  }
  try {
    const r = await api('/api/sources', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }, null, 2),
    });
    showSourcesMsg(t('sources.savedMsg').replace('{n}', r.count), 'ok');
    toast(t('toast.sourcesSaved'));
  } catch (err) { showSourcesMsg(t('toast.error') + err.message, 'err'); }
});

function showSourcesMsg(msg, kind) {
  const el = $('#sources-msg');
  el.textContent = msg; el.className = 'save-hint ' + kind;
  if (kind === 'ok') setTimeout(() => { el.textContent = ''; }, 4000);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────--
let settingsSchema = [];
let settingsLoaded = false;

async function loadSettings() {
  try {
    const { settings } = await api('/api/settings');
    settingsSchema = settings;
    renderSettings();
    settingsLoaded = true;
  } catch (err) { toast(t('toast.error') + err.message); }
}

function renderSettings() {
  const groups = [...new Set(settingsSchema.map(s => s.group))];
  $('#settings-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(tSetGroup(g))}</h2></div>
      <div class="setting-list">
        ${settingsSchema.filter(s => s.group === g).map(settingField).join('')}
      </div>
    </div>`).join('');
  $('#settings-msg').textContent = '';
}

function settingField(s) {
  const id = `set-${s.key}`;
  const req = s.required ? `<span class="req">${esc(t('settings.required'))}</span>` : '';
  const da = `data-key="${esc(s.key)}" data-type="${s.type}"`;
  let control;
  if (s.type === 'secret') {
    const ph = s.isSet ? t('settings.secretSet') : t('settings.secretUnset');
    control = `<div class="secret-wrap">
      <input id="${id}" class="set-input" type="password" ${da} value="${esc(s.value)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">
      <button type="button" class="btn btn-ghost set-reveal" title="${esc(t('settings.revealTitle'))}">👁</button>
    </div>`;
  } else if (s.type === 'int') {
    control = `<input id="${id}" class="set-input set-num" type="number" ${da}
      value="${esc(s.value)}" placeholder="${esc(s.default)}"${s.min != null ? ` min="${s.min}"` : ''}${s.max != null ? ` max="${s.max}"` : ''}>`;
  } else if (s.type === 'bool') {
    const on = String(s.value).toLowerCase() === 'true';
    control = `<label class="set-switch">
      <input id="${id}" class="set-input set-bool" type="checkbox" ${da}${on ? ' checked' : ''}>
      <span class="set-switch-track"></span>
    </label>`;
  } else {
    control = `<input id="${id}" class="set-input" type="text" ${da}
      value="${esc(s.value)}" placeholder="${esc(s.default)}" spellcheck="false">`;
  }
  const def = (s.type !== 'secret' && s.type !== 'bool' && s.default) ? ` <span class="set-default">${esc(t('settings.defaultPrefix'))}<code>${esc(s.default)}</code></span>` : '';
  return `<div class="setting">
    <label class="set-label" for="${id}">${esc(tSetLabel(s.key, s.label))} ${req}</label>
    <div class="set-control">${control}</div>
    <p class="set-help">${esc(tSetHelp(s.key, s.help))}${def}</p>
  </div>`;
}

// reveal/hide a secret value
$('#settings-groups').addEventListener('click', (e) => {
  const btn = e.target.closest('.set-reveal');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.classList.toggle('on', input.type === 'text');
});

$('#save-settings').addEventListener('click', async () => {
  const payload = {};
  for (const inp of $$('#settings-groups .set-input')) {
    if (inp.dataset.type === 'secret') {
      if (inp.value !== '') payload[inp.dataset.key] = inp.value;   // only send if changed
    } else if (inp.dataset.type === 'bool') {
      payload[inp.dataset.key] = inp.checked ? 'true' : 'false';
    } else {
      payload[inp.dataset.key] = inp.value.trim();
    }
  }
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: payload }),
    });
    showSettingsMsg(t('settings.savedMsg'), 'ok');
    toast(t('toast.settingsSaved'));
    // Reflect the clients toggle immediately — no page reload needed.
    const clientsCb = $('#set-CLIENTS_ENABLED');
    if (clientsCb) applyClientsVisibility(clientsCb.checked);
    loadSettings();   // refresh: clears secret fields, updates "gesetzt"-Status
  } catch (err) { showSettingsMsg(t('toast.error') + err.message, 'err'); }
});

$('#settings-reset').addEventListener('click', loadSettings);

async function restartService(btn) {
  try {
    await api('/api/restart', { method: 'POST' });
    if (btn) { btn.disabled = true; btn.textContent = t('restart.running'); }
    toast(t('toast.restart'));
    setTimeout(() => location.reload(), 4500);
  } catch (err) { toast(t('toast.error') + err.message); }
}

$('#restart-btn').addEventListener('click', () => {
  if (!confirm(t('restart.confirm'))) return;
  restartService($('#restart-btn'));
});

// ── BACKUP / RESTORE ──────────────────────────────────────────────────────────
function backupMsg(text, kind = '') {
  const el = $('#backup-msg');
  el.textContent = text; el.className = 'save-hint' + (kind ? ' ' + kind : '');
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
  return bytes + ' B';
}

async function loadBackups() {
  try {
    const data = await api('/api/backups');
    renderBackups(data);
  } catch (err) { backupMsg(t('toast.error') + err.message, 'err'); }
}

function renderBackups({ backups = [] } = {}) {
  const list = $('#backup-list');
  if (!backups.length) {
    list.innerHTML = `<p class="muted" style="padding:8px 2px">${esc(t('backup.none'))}</p>`;
    return;
  }
  const rows = backups.map(b => `<tr>
    <td class="t-name">${esc(new Date(b.createdAt).toLocaleString(locale()))}</td>
    <td><span class="bk-badge bk-${esc(b.type)}">${esc(t('backup.type.' + b.type))}</span></td>
    <td>${esc(fmtSize(b.size))}</td>
    <td class="bk-actions">
      <button class="btn btn-ghost bk-download" data-file="${esc(b.file)}" title="${esc(t('backup.download'))}">⬇</button>
      <button class="btn bk-restore" data-file="${esc(b.file)}" data-i18n="backup.restore">${esc(t('backup.restore'))}</button>
    </td>
  </tr>`).join('');
  list.innerHTML = `<div class="table-scroll"><table class="data-table bk-table">
    <thead><tr>
      <th>${esc(t('backup.colDate'))}</th><th>${esc(t('backup.colType'))}</th>
      <th>${esc(t('backup.colSize'))}</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

$('#backup-create-btn').addEventListener('click', async () => {
  const btn = $('#backup-create-btn');
  btn.disabled = true;
  backupMsg(t('backup.creating'));
  try {
    await api('/api/backups', { method: 'POST' });
    backupMsg(t('backup.created'), 'ok');
    toast(t('backup.created'));
    loadBackups();
  } catch (err) { backupMsg(t('backup.error') + err.message, 'err'); }
  finally { btn.disabled = false; }
});

$('#backup-upload-btn').addEventListener('click', () => $('#backup-upload-input').click());
$('#backup-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';                 // allow re-selecting the same file later
  if (!file) return;
  backupMsg(t('backup.uploading'));
  try {
    // Raw binary body — the server streams it straight to a temp file and validates it.
    await api('/api/backups/upload', { method: 'POST', body: file });
    backupMsg(t('backup.uploaded'), 'ok');
    toast(t('backup.uploaded'));
    loadBackups();
  } catch (err) { backupMsg(t('backup.error') + err.message, 'err'); }
});

$('#backup-list').addEventListener('click', async (e) => {
  const dl = e.target.closest('.bk-download');
  if (dl) { window.location.href = '/api/backups/download?file=' + encodeURIComponent(dl.dataset.file); return; }

  const rs = e.target.closest('.bk-restore');
  if (!rs) return;
  if (!confirm(t('backup.restoreConfirm'))) return;
  rs.disabled = true;
  backupMsg(t('backup.restoring'));
  try {
    const r = await api('/api/backups/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: rs.dataset.file }),
    });
    backupMsg(t('backup.restored').replace('{safety}', r.safetyBackup?.file || ''), 'ok');
    toast(t('backup.restored').replace('{safety}', r.safetyBackup?.file || ''));
    loadBackups();
    loadJobs();
    statsLoaded = false;                 // force a fresh stats reload on next visit
  } catch (err) { backupMsg(t('backup.error') + err.message, 'err'); rs.disabled = false; }
});

// ── UPDATE (git pull from GitHub) ─────────────────────────────────────────────
$('#update-btn').addEventListener('click', async () => {
  const btn = $('#update-btn');
  const msg = $('#update-msg');
  const out = $('#update-output');
  const applyBtn = $('#update-apply-btn');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = t('update.checking');
  applyBtn.hidden = true;
  msg.textContent = ''; msg.className = 'save-hint';
  out.hidden = true; out.textContent = '';
  try {
    const r = await api('/api/update', { method: 'POST' });
    if (r.output) { out.textContent = r.output; out.hidden = false; }
    if (!r.ok) {
      msg.textContent = t('update.failed'); msg.className = 'save-hint err';
    } else if (!r.updated) {
      msg.textContent = t('update.upToDate'); msg.className = 'save-hint ok';
    } else if (r.depsChanged) {
      msg.textContent = t('update.depsChanged'); msg.className = 'save-hint err';
    } else {
      msg.textContent = t('update.updated'); msg.className = 'save-hint ok';
      applyBtn.hidden = false;
    }
  } catch (err) {
    msg.textContent = t('update.failed') + err.message; msg.className = 'save-hint err';
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

$('#update-apply-btn').addEventListener('click', () => restartService($('#update-apply-btn')));

function showSettingsMsg(msg, kind) {
  const el = $('#settings-msg');
  el.textContent = msg; el.className = 'save-hint ' + kind;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 6000);
}

// ── RUN ─────────────────────────────────────────────────────────────────────
let evtSource = null;

function colorizeLog(line) {
  let cls = '';
  if (/RELEVANT|✓|ready|Finished|complete|Exported/i.test(line)) cls = 'ok';
  else if (/ERROR|FEHLER|Failed|Fatal/i.test(line)) cls = 'err';
  else if (/skip|Rate limit|timed out|retry/i.test(line)) cls = 'warn';
  else if (/^\[?\d{4}-|\[.*?\]/.test(line)) cls = 'dim';
  return `<span class="${cls}">${esc(line)}</span>`;
}

function appendConsole(line) {
  const c = $('#console');
  const placeholder = c.querySelector('.console-placeholder');
  if (placeholder) c.innerHTML = '';
  c.insertAdjacentHTML('beforeend', colorizeLog(line) + '\n');
  c.scrollTop = c.scrollHeight;
}

function setRunning(active) {
  const ind = $('#run-indicator');
  ind.textContent = active ? t('run.running') : t('run.ready');
  ind.classList.toggle('live', active);
  $('#run-btn').disabled = active;
  $('#quick-run').disabled = active;
}

function connectStream() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/run/stream');
  evtSource.addEventListener('log', (e) => appendConsole(JSON.parse(e.data)));
  evtSource.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    setRunning(s.active);
    if (!s.active && s.exitCode != null) refreshAfterRun();
  });
  evtSource.onerror = () => { /* browser auto-reconnects */ };
}

async function startRun() {
  $('#console').innerHTML = '';
  try {
    await api('/api/run', { method: 'POST' });
    setRunning(true);
    // switch to Run tab so the user sees logs
    document.querySelector('.tab[data-tab="run"]').click();
  } catch (err) {
    if (/läuft bereits|already/.test(err.message)) { toast(t('run.alreadyRunning')); document.querySelector('.tab[data-tab="run"]').click(); }
    else toast(t('toast.error') + err.message);
  }
}

let refreshTimer;
function refreshAfterRun() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { loadJobs(); loadRecentRuns(); toast(t('run.doneToast')); }, 800);
}

$('#run-btn').addEventListener('click', startRun);
$('#quick-run').addEventListener('click', startRun);

// ── RUN HISTORY (last N runs, with per-source breakdown) ──────────────────────
async function loadRecentRuns() {
  const limit = $('#run-history-limit')?.value || 10;
  try {
    const { runs } = await api(`/api/runs?limit=${limit}`);
    renderRecentRuns(runs || []);
  } catch (err) { toast(t('toast.error') + err.message); }
}

function renderRecentRuns(runs) {
  const list = $('#run-history-list');
  if (!runs.length) {
    list.innerHTML = `<p class="empty" data-i18n="run.noRuns">${esc(t('run.noRuns'))}</p>`;
    return;
  }
  const head = t('run.histHeaders');
  list.innerHTML = runs.map((run, i) => {
    const tot = run.totals;
    const when = new Date(run.ranAt).toLocaleString(locale());
    const chips = [
      [t('stats.legendFound'), tot.found],
      [t('stats.legendRelevant'), tot.relevant],
      [t('stats.cardNotified'), tot.notified],
    ].map(([l, v]) => `<span class="run-chip"><b>${v}</b> ${esc(l)}</span>`).join('');
    const body = run.rows.length ? `
      <div class="table-scroll"><table class="data-table run-mini">
        <thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${run.rows.map(r => `<tr>
          <td class="t-name">${esc(r.source)}</td>
          <td>${r.found}</td><td>${r.analyzed}</td>
          <td class="${r.newRelevant ? 'hl' : ''}">${r.newRelevant}</td>
          <td class="strong">${r.totalRelevant}</td><td>${r.notified}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<p class="muted" style="padding:8px 2px">${esc(t('run.noSources'))}</p>`;
    return `<details class="run-entry"${i === 0 ? ' open' : ''}>
      <summary>
        <span class="run-when">${esc(when)}</span>
        <span class="run-chips">${chips}</span>
      </summary>
      ${body}
    </details>`;
  }).join('');
}

$('#run-history-limit')?.addEventListener('change', loadRecentRuns);

// ── PROFILE (CV) ─────────────────────────────────────────────────────────────
let profileLoaded = false;
let profileData = {};   // full loaded object — preserves keys not shown in the form

// Labels, group headings and hints are i18n keys (see public/i18n.js), resolved
// via t() at render time so the form follows the selected language.
const CV = 'profile.group.cv', PREF = 'profile.group.preferences';
const PROFILE_FIELDS = [
  { p: 'cv.name',                  t: 'text',     l: 'profile.field.name', group: CV },
  { p: 'cv.currentRole',           t: 'text',     l: 'profile.field.currentRole', group: CV },
  { p: 'cv.yearsOfExperience',     t: 'int',      l: 'profile.field.yearsOfExperience', group: CV },
  { p: 'cv.summary',               t: 'textarea', l: 'profile.field.summary', group: CV, h: 'profile.field.summary.h' },
  { p: 'cv.skills.domain',         t: 'list',     l: 'profile.field.skills.domain', group: CV, h: 'profile.field.skills.domain.h' },
  { p: 'cv.skills.tools',          t: 'list',     l: 'profile.field.skills.tools', group: CV },
  { p: 'cv.skills.programming',    t: 'list',     l: 'profile.field.skills.programming', group: CV },
  { p: 'cv.languages',             t: 'list',     l: 'profile.field.languages', group: CV },
  { p: 'cv.education',             t: 'list',     l: 'profile.field.education', group: CV, h: 'profile.field.education.h' },
  { p: 'cv.experience',            t: 'list',     l: 'profile.field.experience', group: CV, h: 'profile.field.experience.h' },
  { p: 'preferences.desiredRoles', t: 'list',     l: 'profile.field.desiredRoles', group: PREF, h: 'profile.field.desiredRoles.h' },
  { p: 'preferences.locations',    t: 'list',     l: 'profile.field.locations', group: PREF, h: 'profile.field.locations.h' },
  { p: 'preferences.industries',   t: 'list',     l: 'profile.field.industries', group: PREF },
  { p: 'preferences.salaryMin',    t: 'int',      l: 'profile.field.salaryMin', group: PREF },
  { p: 'preferences.contractTypes',t: 'list',     l: 'profile.field.contractTypes', group: PREF },
  { p: 'preferences.dealbreakers', t: 'list',     l: 'profile.field.dealbreakers', group: PREF, h: 'profile.field.dealbreakers.h' },
];

const getPath = (o, dotted) => dotted.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, dotted, value) {
  const ks = dotted.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (typeof cur[ks[i]] !== 'object' || cur[ks[i]] == null) cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = value;
}

async function loadProfile() {
  try {
    const { profile } = await api('/api/profile');
    profileData = profile || {};
    renderProfile();
    profileLoaded = true;
  } catch (err) { toast(t('toast.error') + err.message); }
}

function profileField(f) {
  const id = `pf-${f.p.replace(/\W/g, '_')}`;
  const v = getPath(profileData, f.p);
  const da = `data-path="${esc(f.p)}" data-type="${f.t}"`;
  let control;
  if (f.t === 'list') {
    const text = Array.isArray(v) ? v.join('\n') : (v ?? '');
    control = `<textarea id="${id}" class="set-input su-textarea" ${da} rows="4" spellcheck="false">${esc(text)}</textarea>`;
  } else if (f.t === 'textarea') {
    control = `<textarea id="${id}" class="set-input su-textarea" ${da} rows="4" spellcheck="false">${esc(v ?? '')}</textarea>`;
  } else if (f.t === 'int') {
    control = `<input id="${id}" class="set-input set-num" type="number" ${da} value="${esc(v ?? '')}">`;
  } else {
    control = `<input id="${id}" class="set-input" type="text" ${da} value="${esc(v ?? '')}" spellcheck="false">`;
  }
  const help = f.h ? ` <span class="set-default">${esc(t(f.h))}</span>` : '';
  return `<div class="setting">
    <label class="set-label" for="${id}">${esc(t(f.l))}</label>
    <div class="set-control">${control}<p class="set-help">${help}</p></div>
  </div>`;
}

function renderProfile() {
  const groups = [...new Set(PROFILE_FIELDS.map(f => f.group))];
  $('#profile-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(t(g))}</h2></div>
      <div class="setting-list">${PROFILE_FIELDS.filter(f => f.group === g).map(profileField).join('')}</div>
    </div>`).join('');
  $('#profile-msg').textContent = '';
}

$('#save-profile').addEventListener('click', async () => {
  const next = JSON.parse(JSON.stringify(profileData || {}));   // preserve untouched keys
  for (const inp of $$('#profile-groups [data-path]')) {
    const p = inp.dataset.path, ty = inp.dataset.type;
    if (ty === 'list') {
      setPath(next, p, inp.value.split('\n').map(s => s.trim()).filter(Boolean));
    } else if (ty === 'int') {
      const raw = inp.value.trim();
      setPath(next, p, raw === '' ? undefined : Number(raw));
    } else {
      setPath(next, p, inp.value.trim());
    }
  }
  try {
    await api('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: next }),
    });
    profileData = next;
    showProfileMsg(t('profile.savedMsg'), 'ok');
    toast(t('toast.profileSaved'));
  } catch (err) { showProfileMsg(t('toast.error') + err.message, 'err'); }
});

$('#profile-reset').addEventListener('click', loadProfile);

function showProfileMsg(msg, kind) {
  const el = $('#profile-msg');
  el.textContent = msg; el.className = 'save-hint ' + kind;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

// ── PROMPTS ──────────────────────────────────────────────────────────────────
let promptsLoaded = false;
let promptDefaults = {};

async function loadPrompts() {
  try {
    const { fields, prompts, defaults } = await api('/api/prompts');
    promptDefaults = defaults || {};
    renderPrompts(fields, prompts);
    promptsLoaded = true;
  } catch (err) { toast(t('toast.error') + err.message); }
}

function renderPrompts(fields, values) {
  const groups = [...new Set(fields.map(f => f.group))];
  $('#prompts-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(tPromptGroup(g))}</h2></div>
      <div class="setting-list">
        ${fields.filter(f => f.group === g).map(f => {
          const id = `pr-${f.key}`;
          return `<div class="setting">
            <label class="set-label" for="${id}">${esc(tPromptLabel(f.key, f.label))}
              <button type="button" class="btn btn-ghost prompt-default" data-key="${esc(f.key)}" title="${esc(t('prompts.defaultTitle'))}">${esc(t('prompts.defaultBtn'))}</button>
            </label>
            <div class="set-control">
              <textarea id="${id}" class="set-input su-textarea" data-key="${esc(f.key)}" rows="5" spellcheck="false">${esc(values[f.key] ?? '')}</textarea>
              <p class="set-help">${esc(tPromptHelp(f.key, f.help) || '')}</p>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
  $('#prompts-msg').textContent = '';
}

// per-field "↺ Standard" button → drop the default text into that textarea
$('#prompts-groups').addEventListener('click', (e) => {
  const btn = e.target.closest('.prompt-default');
  if (!btn) return;
  const ta = $(`#prompts-groups textarea[data-key="${btn.dataset.key}"]`);
  if (ta) { ta.value = promptDefaults[btn.dataset.key] ?? ''; ta.focus(); }
});

$('#save-prompts').addEventListener('click', async () => {
  const prompts = {};
  for (const ta of $$('#prompts-groups textarea[data-key]')) prompts[ta.dataset.key] = ta.value;
  try {
    await api('/api/prompts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts }),
    });
    showPromptsMsg(t('prompts.savedMsg'), 'ok');
    toast(t('toast.promptsSaved'));
  } catch (err) { showPromptsMsg(t('toast.error') + err.message, 'err'); }
});

// reset all fields to defaults (in the form; takes effect on Save)
$('#prompts-reset').addEventListener('click', () => {
  for (const ta of $$('#prompts-groups textarea[data-key]')) ta.value = promptDefaults[ta.dataset.key] ?? '';
  showPromptsMsg(t('prompts.resetHint'), 'ok');
});

function showPromptsMsg(msg, kind) {
  const el = $('#prompts-msg');
  el.textContent = msg; el.className = 'save-hint ' + kind;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

// ── APPEARANCE: color scheme (light / dark / auto) ────────────────────────────
function currentTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(val) {
  document.documentElement.dataset.theme = val;
  try { localStorage.setItem('theme', val); } catch { /* ignore */ }
  $$('#theme-toggle .theme-opt').forEach(b => b.classList.toggle('active', b.dataset.themeVal === val));
}
$('#theme-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-opt');
  if (btn) applyTheme(btn.dataset.themeVal);
});

// ── APPEARANCE: color theme / palette (default / pink) ────────────────────────
function currentPalette() {
  try { return localStorage.getItem('palette') || 'default'; } catch { return 'default'; }
}
function applyPalette(val) {
  document.documentElement.dataset.palette = val;
  try { localStorage.setItem('palette', val); } catch { /* ignore */ }
  const sel = $('#palette-select'); if (sel) sel.value = val;
}
$('#palette-select')?.addEventListener('change', (e) => applyPalette(e.target.value));

// ── APPEARANCE: language (de / en) ────────────────────────────────────────────
// The shared setLang() (i18n.js) persists the choice, translates static markup,
// and fires the listeners registered below so dynamic views re-render in place.
$('#lang-select')?.addEventListener('change', (e) => setLang(e.target.value));
onLangChange(() => {
  const sel = $('#lang-select'); if (sel) sel.value = lang;
  populateSourceFilter(); renderStats(); renderJobs();
  if (settingsLoaded) renderSettings();
  if (statsLoaded) loadStats();
  if (profileLoaded) renderProfile();
  if (promptsLoaded) loadPrompts();
  if ($('#backup-list')?.querySelector('table')) loadBackups();
});

// ── CLIENTS (tenant management) ──────────────────────────────────────────────
let clientsList = [];
let defaultClientId = 'default';

async function loadClients() {
  const { clients, defaultClientId: dcid } = await api('/api/clients');
  clientsList = clients || [];
  defaultClientId = dcid || 'default';
  // Validate the persisted selection; fall back to default/first.
  if (!clientsList.some(c => c.id === currentClientId)) {
    currentClientId = (clientsList.find(c => c.id === defaultClientId) || clientsList[0])?.id || null;
  }
  populateClientSwitcher();
}

function populateClientSwitcher() {
  const sel = $('#client-switcher');
  if (!sel) return;
  sel.innerHTML = clientsList.map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}${c.enabled ? '' : ' · ' + esc(t('clients.inactive'))}</option>`
  ).join('');
  if (currentClientId) sel.value = currentClientId;
}

$('#client-switcher')?.addEventListener('change', (e) => switchClient(e.target.value));

function switchClient(id) {
  if (id === currentClientId) return;
  currentClientId = id;
  try { localStorage.setItem('clientId', id); } catch { /* ignore */ }
  // Invalidate per-client caches so the next tab visit refetches for this client.
  sourcesLoaded = profileLoaded = promptsLoaded = false;
  // Refresh whatever is on screen for the new client.
  loadJobs();
  const active = $('.tab.active')?.dataset.tab;
  if (active === 'stats') loadStats();
  else if (active === 'sources') loadSources();
  else if (active === 'profile') loadProfile();
  else if (active === 'prompts') loadPrompts();
  else if (active === 'clients') renderClients();
  else if (active === 'run') loadRecentRuns();
}

function renderClients() {
  const list = $('#client-list');
  if (!list) return;
  list.innerHTML = '';
  clientsList.forEach(c => list.appendChild(clientCard(c)));
}

function clientCard(c) {
  const div = document.createElement('div');
  div.className = 'card client-card';
  const isDefault = c.id === defaultClientId;
  const isActive  = c.id === currentClientId;
  div.innerHTML = `
    <div class="client-card-head">
      <input class="set-input cc-name" value="${esc(c.name)}">
      ${isActive
        ? `<span class="badge badge-active" data-i18n="client.activeBadge">aktiv</span>`
        : `<button class="btn btn-ghost cc-select" data-i18n="clients.select">auswählen</button>`}
    </div>
    <label data-i18n="clients.chatId">Telegram Chat-ID</label>
    <input class="set-input cc-chat" value="${esc(c.telegram_chat_id || '')}" placeholder="z. B. 123456789">
    <div class="cc-toggles">
      <label><input type="checkbox" class="cc-enabled" ${c.enabled ? 'checked' : ''}> <span data-i18n="clients.enabled">im Lauf aktiv</span></label>
      <label><input type="checkbox" class="cc-tg" ${c.telegram_notifications !== 'off' ? 'checked' : ''}> <span data-i18n="clients.telegram">Telegram</span></label>
      <label><input type="checkbox" class="cc-exp" ${c.expiry_notifications !== 'off' ? 'checked' : ''}> <span data-i18n="clients.expiry">Ablauf-Hinweise</span></label>
    </div>
    <label data-i18n="clients.minScore">Min. Relevanz-Score (leer = global)</label>
    <input class="set-input set-num cc-min" type="number" min="1" max="10" value="${c.min_relevance_score ?? ''}">

    <label class="cc-edit-label" data-i18n="clients.editContent">Inhalte dieses Klienten bearbeiten</label>
    <div class="cc-edit">
      <button class="btn cc-go" data-go="profile" data-i18n="tab.profile">Profil</button>
      <button class="btn cc-go" data-go="sources" data-i18n="tab.sources">Quellen</button>
      <button class="btn cc-go" data-go="prompts" data-i18n="tab.prompts">Prompts</button>
    </div>

    <div class="panel-actions">
      <button class="btn btn-primary cc-save" data-i18n="btn.save">Speichern</button>
      <button class="btn cc-test" data-i18n="clients.tgTest">Telegram-Test</button>
      ${isDefault ? '' : `<button class="btn btn-danger cc-del" data-i18n="clients.delete">Löschen</button>`}
    </div>
    <p class="save-hint cc-msg"></p>`;
  applyStaticI18n(div);

  const msg = (text, kind) => { const m = div.querySelector('.cc-msg'); m.textContent = text; m.className = 'save-hint cc-msg ' + (kind || ''); };

  div.querySelector('.cc-select')?.addEventListener('click', () => {
    switchClient(c.id);
    populateClientSwitcher();
    renderClients();
  });

  // Jump straight to the scoped editor for this client (switches the active client
  // first, then opens the relevant tab).
  div.querySelectorAll('.cc-go').forEach(btn => btn.addEventListener('click', () => {
    if (c.id !== currentClientId) { switchClient(c.id); populateClientSwitcher(); }
    document.querySelector(`.tab[data-tab="${btn.dataset.go}"]`)?.click();
  }));

  div.querySelector('.cc-save').addEventListener('click', async () => {
    const patch = {
      name: div.querySelector('.cc-name').value.trim() || c.name,
      telegram_chat_id: div.querySelector('.cc-chat').value.trim() || null,
      enabled: div.querySelector('.cc-enabled').checked,
      telegram_notifications: div.querySelector('.cc-tg').checked ? 'on' : 'off',
      expiry_notifications: div.querySelector('.cc-exp').checked ? 'on' : 'off',
      min_relevance_score: div.querySelector('.cc-min').value === '' ? null : Number(div.querySelector('.cc-min').value),
    };
    try {
      const { client } = await api(`/api/clients/${encodeURIComponent(c.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      Object.assign(c, client);
      populateClientSwitcher();
      msg(t('clients.saved'), 'ok');
      toast(t('clients.saved'));
    } catch (err) { msg(err.message, 'err'); }
  });

  div.querySelector('.cc-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      await api(`/api/clients/${encodeURIComponent(c.id)}/telegram-test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_chat_id: div.querySelector('.cc-chat').value.trim() }),
      });
      msg(t('clients.tgOk'), 'ok');
    } catch (err) { msg(err.message, 'err'); }
    finally { btn.disabled = false; }
  });

  div.querySelector('.cc-del')?.addEventListener('click', async () => {
    if (!confirm(t('clients.delConfirm').replace('{name}', c.name))) return;
    try {
      await api(`/api/clients/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (currentClientId === c.id) { currentClientId = defaultClientId; try { localStorage.setItem('clientId', currentClientId); } catch { /* ignore */ } }
      await loadClients();
      renderClients();
      loadJobs();
      toast(t('clients.deleted'));
    } catch (err) { msg(err.message, 'err'); }
  });

  return div;
}

$('#add-client')?.addEventListener('click', async () => {
  const name = prompt(t('clients.namePrompt'));
  if (!name || !name.trim()) return;
  try {
    const { client } = await api('/api/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
    });
    await loadClients();
    switchClient(client.id);
    populateClientSwitcher();
    renderClients();
    toast(t('clients.created'));
  } catch (err) { toast(t('toast.error') + err.message); }
});

// ── AUTH + boot ──────────────────────────────────────────────────────────────
$('#login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#login-user').value;
  const password = $('#login-pass').value;
  const errEl = $('#login-error');
  try {
    await api('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }),
    });
    location.reload();
  } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
});

$('#logout-btn')?.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
});

// Show/hide everything multi-tenant: the Klienten tab and the client selector in
// the top bar. When off (private use), the app silently stays on the default client.
function applyClientsVisibility(enabled) {
  const tab = document.querySelector('.tab[data-tab="clients"]');
  if (tab) tab.hidden = !enabled;
  const sw = document.querySelector('.client-switch');
  if (sw) sw.hidden = !enabled;
  // If the Klienten tab was active when it got hidden, fall back to Jobs.
  if (!enabled && tab && tab.classList.contains('active')) {
    document.querySelector('.tab[data-tab="jobs"]')?.click();
  }
}

async function boot() {
  applyTheme(currentTheme());        // reflect saved scheme on the toggle buttons
  applyPalette(currentPalette());    // reflect saved palette in the dropdown
  const langSel = $('#lang-select'); if (langSel) langSel.value = lang;
  applyStaticI18n();                 // translate static markup to the saved language

  let auth;
  try { auth = await api('/api/auth/status'); }
  catch { auth = { authEnabled: false, authenticated: true, clientsEnabled: false }; }

  if (auth.authEnabled && !auth.authenticated) {
    $('#login-overlay').hidden = false;   // gate the whole app behind login
    return;
  }
  if (auth.authEnabled) $('#logout-btn').hidden = false;
  applyClientsVisibility(!!auth.clientsEnabled);

  const verEl = $('#app-version');
  if (verEl && auth.version) { verEl.textContent = `${t('settings.version')} ${auth.version}`; verEl.hidden = false; }

  try { currentClientId = localStorage.getItem('clientId') || null; } catch { /* ignore */ }
  try { await loadClients(); } catch { /* keep going with default scope */ }

  loadJobs();
  connectStream();
}

boot();
