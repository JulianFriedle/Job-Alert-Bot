// ── tiny helpers ───────────────────────────────────────────────────────────
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('de-DE') : '';

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

const STATUS_LABEL = { applied: 'Beworben', interview: 'Interview', offer: 'Angebot', rejected: 'Abgelehnt' };

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
  if (name === 'profile' && !profileLoaded) loadProfile();
  if (name === 'prompts' && !promptsLoaded) loadPrompts();
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
    toast('Fehler beim Laden: ' + err.message);
  }
}

function populateSourceFilter() {
  const sel = $('#filter-source');
  const current = sel.value;
  const sources = [...new Set(allJobs.map(j => j.source).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Alle Quellen</option>' +
    sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  sel.value = current;
}

function renderStats() {
  const total = allJobs.length;
  const applied = allJobs.filter(j => j.applied).length;
  const high = allJobs.filter(j => (j.score ?? 0) >= 8).length;
  const avg = total ? (allJobs.reduce((s, j) => s + (j.score ?? 0), 0) / total).toFixed(1) : '–';
  $('#stats').innerHTML = `
    <div class="stat"><div class="v">${total}</div><div class="l">Relevante Jobs</div></div>
    <div class="stat"><div class="v">${high}</div><div class="l">Top-Match (≥8)</div></div>
    <div class="stat"><div class="v">${avg}</div><div class="l">Ø Score</div></div>
    <div class="stat"><div class="v">${applied}</div><div class="l">Beworben</div></div>`;
}

function filteredJobs() {
  const q = $('#search').value.trim().toLowerCase();
  const src = $('#filter-source').value;
  const st = $('#filter-status').value;
  const minScore = Number($('#filter-score').value);
  return allJobs.filter(j => {
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
}

function scoreClass(s) {
  s = s ?? 0;
  return s >= 8 ? 's-high' : s >= 6 ? 's-mid' : 's-low';
}

function renderJobs() {
  const jobs = filteredJobs();
  $('#result-count').textContent = `${jobs.length} von ${allJobs.length}`;
  $('#jobs-empty').hidden = jobs.length > 0;
  const list = $('#job-list');

  list.innerHTML = jobs.map(j => {
    const statuses = ['applied', 'interview', 'offer', 'rejected'];
    const opts = ['<option value="">Status…</option>',
      ...statuses.map(s => `<option value="${s}"${j.status === s ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`)
    ].join('');
    const pill = j.status ? `<span class="pill st-${j.status}">${STATUS_LABEL[j.status]}${j.applied_at ? ' · ' + fmtDate(j.applied_at) : ''}</span>` : '';
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
          <select class="js-status" title="Bewerbungsstatus">${opts}</select>
          <div class="row">
            <button class="btn btn-ghost js-cover" title="Anschreiben erstellen">✎</button>
            <a class="btn btn-ghost" href="${esc(j.url)}" target="_blank" rel="noopener" title="Öffnen">↗</a>
            <button class="btn btn-ghost btn-danger js-ignore" title="Als irrelevant ausblenden">✕</button>
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
    toast(sel.value ? `Status: ${STATUS_LABEL[sel.value]}` : 'Status zurückgesetzt');
  } catch (err) { toast('Fehler: ' + err.message); }
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
  if (!confirm('Diesen Job als irrelevant ausblenden?')) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/ignore`, { method: 'POST' });
    allJobs = allJobs.filter(j => j.id !== id);
    renderStats(); renderJobs();
    toast('Ausgeblendet');
  } catch (err) { toast('Fehler: ' + err.message); }
});

// ── COVER LETTER MODAL ───────────────────────────────────────────────────────
let coverJob = null;

async function openCoverLetter(job) {
  if (!job) return;
  coverJob = job;
  $('#cl-sub').textContent = `${job.title} · ${job.company || job.source}`;
  $('#cl-modal').hidden = false;
  await generateCover();
}

async function generateCover() {
  const loading = $('#cl-loading'), text = $('#cl-text'), error = $('#cl-error');
  loading.hidden = false; text.hidden = true; error.hidden = true;
  $('#cl-copy').hidden = true; $('#cl-regen').hidden = true;
  try {
    const { text: letter } = await api(`/api/jobs/${encodeURIComponent(coverJob.id)}/cover-letter`, { method: 'POST' });
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
$('#cl-regen').addEventListener('click', generateCover);
$('#cl-text').addEventListener('input', (e) => autosize(e.target));

$('#cl-copy').addEventListener('click', async () => {
  const txt = $('#cl-text').value;
  try {
    await navigator.clipboard.writeText(txt);
    toast('In Zwischenablage kopiert');
  } catch {
    // Fallback for non-secure contexts (http://localhost is usually fine, but just in case)
    const ta = $('#cl-text');
    ta.select(); document.execCommand('copy');
    toast('Kopiert');
  }
});

['input', 'change'].forEach(ev => {
  $('#search').addEventListener(ev, renderJobs);
});
['#filter-source', '#filter-status', '#filter-score'].forEach(s =>
  $(s).addEventListener('change', renderJobs));

// ── STATS ─────────────────────────────────────────────────────────────────--
const STAT_STATUS_LABEL = { applied: 'Beworben', interview: 'Interview', offer: 'Angebot', rejected: 'Abgelehnt' };

async function loadStats() {
  try {
    const s = await api('/api/stats');
    renderStatCards(s.totals);
    renderHeatmap(s.activity);
    renderAppliedChart(s.appliedByCompany);
    renderSourcesChart(s.allTime);
    renderRunHistory(s.runHistory);
    renderOverviewTable(s.overview, s.allTime);
  } catch (err) { toast('Statistik-Fehler: ' + err.message); }
}

function renderStatCards(t = {}) {
  const cards = [
    ['Jobs gesamt', t.total ?? 0],
    ['Relevant', t.relevant ?? 0],
    ['Benachrichtigt', t.notified ?? 0],
    ['Beworben', t.applied ?? 0],
  ];
  $('#stats-cards').innerHTML = cards.map(([l, v]) =>
    `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
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

  const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  let total = 0;
  const cols = [];
  let monthLabels = '';
  for (let w = 0; w < WEEKS; w++) {
    let col = '';
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) { col += `<span class="hm-cell empty"></span>`; continue; }
      const key = ymd(date);
      const c = activity[key] || 0;
      total += c;
      const titleTxt = `${c} Bewerbung${c === 1 ? '' : 'en'} · ${date.toLocaleDateString('de-DE')}`;
      col += `<span class="hm-cell l${level(c)}" title="${titleTxt}"></span>`;
    }
    // month label when the first day of a week is in the first week of a month
    const firstOfCol = new Date(start); firstOfCol.setDate(start.getDate() + w * 7);
    const lbl = (firstOfCol.getDate() <= 7) ? MONTHS[firstOfCol.getMonth()] : '';
    monthLabels += `<span class="hm-month">${lbl}</span>`;
    cols.push(`<div class="hm-col">${col}</div>`);
  }
  $('#heatmap').innerHTML =
    `<div class="hm-months">${monthLabels}</div><div class="hm-grid">${cols.join('')}</div>`;
  $('#activity-total').textContent = `${total} Bewerbung${total === 1 ? '' : 'en'} im letzten Jahr`;
}

// Minimal dependency-free SVG bar chart (vertical).
function barChartV(data, { color = 'var(--accent)', height = 160 } = {}) {
  const entries = Object.entries(data);
  if (!entries.length) return `<p class="muted" style="padding:24px 4px">Noch keine Daten.</p>`;
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
  if (!top.length) { $('#chart-applied').innerHTML = `<p class="muted" style="padding:24px 4px">Noch keine Bewerbungen.</p>`; return; }
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
  if (!top.length) { $('#chart-sources').innerHTML = `<p class="muted" style="padding:24px 4px">Noch keine Daten.</p>`; return; }
  const max = Math.max(...top.map(s => s.relevant));
  $('#chart-sources').innerHTML = `<div class="hbars">` + top.map(s => `
    <div class="hbar-row">
      <span class="hbar-lbl" title="${esc(s.source)}">${esc(s.source)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(s.relevant / max) * 100}%"></span></span>
      <span class="hbar-val">${s.relevant}</span>
    </div>`).join('') + `</div>`;
}

// Line chart of found vs relevant over recent runs.
function renderRunHistory(runs = []) {
  const card = $('#card-runhistory');
  if (!runs || runs.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const W = 100, H = 100, pad = 4;
  const maxY = Math.max(...runs.map(r => r.total_found || 0), 1);
  const xFor = (i) => pad + (i / (runs.length - 1)) * (W - 2 * pad);
  const yFor = (v) => (H - pad) - (v / maxY) * (H - 2 * pad - 6);
  const line = (key, color) => {
    const pts = runs.map((r, i) => `${xFor(i)},${yFor(r[key] || 0)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  };
  $('#chart-runs').innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:180px">
      ${line('total_found', 'var(--muted)')}
      ${line('total_relevant', 'var(--accent)')}
    </svg>
    <div class="legend">
      <span><i style="background:var(--muted)"></i> Gefunden</span>
      <span><i style="background:var(--accent)"></i> Relevant</span>
    </div>`;
}

function renderOverviewTable(overview, allTime = []) {
  const table = $('#overview-table');
  if (overview && overview.rows?.length) {
    $('#overview-sub').textContent = 'letzter Lauf · ' + new Date(overview.ranAt).toLocaleString('de-DE');
    const head = ['Unternehmen', 'Gefunden', 'Laut Web', 'Neu(DB)', 'Geblockt', 'Analysiert', 'Neu Rel.', 'Ges. Rel.', 'Notified'];
    const rows = overview.rows.map(r => `<tr>
      <td class="t-name">${esc(r.source)}</td>
      <td>${r.found}</td><td>${r.siteTotal ?? '–'}</td><td>${r.newDb}</td>
      <td>${r.blocked}</td><td>${r.analyzed}</td>
      <td class="${r.newRelevant ? 'hl' : ''}">${r.newRelevant}</td>
      <td class="strong">${r.totalRelevant}</td><td>${r.notified}</td>
    </tr>`).join('');
    const sum = (k) => overview.rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const foot = `<tr class="t-foot">
      <td>Gesamt</td><td>${sum('found')}</td><td></td><td>${sum('newDb')}</td>
      <td>${sum('blocked')}</td><td>${sum('analyzed')}</td><td>${sum('newRelevant')}</td>
      <td>${sum('totalRelevant')}</td><td>${sum('notified')}</td></tr>`;
    table.innerHTML = `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}${foot}</tbody>`;
  } else {
    // Fallback to all-time aggregates until the first run is recorded
    $('#overview-sub').textContent = 'Gesamt (alle Zeit) · per-Lauf-Spalten erscheinen nach dem nächsten Lauf';
    const head = ['Unternehmen', 'Gefunden', 'Analysiert', 'Ges. Rel.', 'Notified', 'Beworben'];
    const rows = allTime.map(r => `<tr>
      <td class="t-name">${esc(r.source)}</td>
      <td>${r.found}</td><td>${r.analyzed}</td>
      <td class="strong">${r.relevant}</td><td>${r.notified}</td><td>${r.applied}</td>
    </tr>`).join('');
    const sum = (k) => allTime.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const foot = `<tr class="t-foot"><td>Gesamt</td><td>${sum('found')}</td><td>${sum('analyzed')}</td>
      <td>${sum('relevant')}</td><td>${sum('notified')}</td><td>${sum('applied')}</td></tr>`;
    table.innerHTML = `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}${foot}</tbody>`;
  }
}

// ── SOURCES ─────────────────────────────────────────────────────────────────
let sourcesLoaded = false;

async function loadSources() {
  try {
    const cfg = await api('/api/sources');
    renderSources(cfg.sources || []);
    sourcesLoaded = true;
  } catch (err) { toast('Fehler: ' + err.message); }
}

function sourceRow(s = { name: '', url: '' }) {
  const div = document.createElement('div');
  div.className = 'source-row';
  div.innerHTML = `
    <input class="name" placeholder="Name" value="${esc(s.name)}">
    <input class="url" placeholder="https://…" value="${esc(s.url)}">
    <button class="btn btn-ghost btn-danger js-del" title="Entfernen">✕</button>`;
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
  $('#sources-count').textContent = `${n} Karriereseite${n === 1 ? '' : 'n'}`;
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
      showSourcesMsg('Jede Quelle braucht Name und URL.', 'err');
      return;
    }
    sources.push({ name, url, type: row._extra?.type || 'careers-page', ...row._extra });
  }
  try {
    const r = await api('/api/sources', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }, null, 2),
    });
    showSourcesMsg(`✓ ${r.count} Quellen gespeichert.`, 'ok');
    toast('Quellen gespeichert');
  } catch (err) { showSourcesMsg('Fehler: ' + err.message, 'err'); }
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
  } catch (err) { toast('Fehler: ' + err.message); }
}

function renderSettings() {
  const groups = [...new Set(settingsSchema.map(s => s.group))];
  $('#settings-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(g)}</h2></div>
      <div class="setting-list">
        ${settingsSchema.filter(s => s.group === g).map(settingField).join('')}
      </div>
    </div>`).join('');
  $('#settings-msg').textContent = '';
}

function settingField(s) {
  const id = `set-${s.key}`;
  const req = s.required ? '<span class="req">erforderlich</span>' : '';
  const da = `data-key="${esc(s.key)}" data-type="${s.type}"`;
  let control;
  if (s.type === 'secret') {
    const ph = s.isSet ? '•••••••• gesetzt' : 'nicht gesetzt';
    control = `<div class="secret-wrap">
      <input id="${id}" class="set-input" type="password" ${da} value="${esc(s.value)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">
      <button type="button" class="btn btn-ghost set-reveal" title="Anzeigen/Verbergen">👁</button>
    </div>`;
  } else if (s.type === 'int') {
    control = `<input id="${id}" class="set-input set-num" type="number" ${da}
      value="${esc(s.value)}" placeholder="${esc(s.default)}"${s.min != null ? ` min="${s.min}"` : ''}${s.max != null ? ` max="${s.max}"` : ''}>`;
  } else {
    control = `<input id="${id}" class="set-input" type="text" ${da}
      value="${esc(s.value)}" placeholder="${esc(s.default)}" spellcheck="false">`;
  }
  const def = (s.type !== 'secret' && s.default) ? ` <span class="set-default">Standard: <code>${esc(s.default)}</code></span>` : '';
  return `<div class="setting">
    <label class="set-label" for="${id}">${esc(s.label)} ${req}</label>
    <div class="set-control">${control}</div>
    <p class="set-help">${esc(s.help)}${def}</p>
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
    } else {
      payload[inp.dataset.key] = inp.value.trim();
    }
  }
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: payload }),
    });
    showSettingsMsg('✓ Gespeichert. Änderungen greifen beim nächsten Lauf (GUI-Port erst nach Neustart).', 'ok');
    toast('Einstellungen gespeichert');
    loadSettings();   // refresh: clears secret fields, updates "gesetzt"-Status
  } catch (err) { showSettingsMsg('Fehler: ' + err.message, 'err'); }
});

$('#settings-reset').addEventListener('click', loadSettings);

$('#restart-btn').addEventListener('click', async () => {
  if (!confirm('Den GUI-Dienst jetzt neu starten? Die Seite lädt anschließend neu.')) return;
  const btn = $('#restart-btn');
  try {
    await api('/api/restart', { method: 'POST' });
    btn.disabled = true; btn.textContent = '↻ Neustart läuft …';
    toast('Dienst wird neu gestartet …');
    setTimeout(() => location.reload(), 4500);
  } catch (err) { toast('Fehler: ' + err.message); }
});

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
  ind.textContent = active ? '● läuft…' : '● bereit';
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
    if (/läuft bereits/.test(err.message)) { toast('Lauf läuft bereits'); document.querySelector('.tab[data-tab="run"]').click(); }
    else toast('Fehler: ' + err.message);
  }
}

let refreshTimer;
function refreshAfterRun() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { loadJobs(); toast('Lauf fertig – Jobs aktualisiert'); }, 800);
}

$('#run-btn').addEventListener('click', startRun);
$('#quick-run').addEventListener('click', startRun);

// ── PROFILE (CV) ─────────────────────────────────────────────────────────────
let profileLoaded = false;
let profileData = {};   // full loaded object — preserves keys not shown in the form

const PROFILE_FIELDS = [
  { p: 'cv.name',                  t: 'text',     l: 'Name', group: 'Lebenslauf (CV)' },
  { p: 'cv.currentRole',           t: 'text',     l: 'Aktuelle Rolle / Status', group: 'Lebenslauf (CV)' },
  { p: 'cv.yearsOfExperience',     t: 'int',      l: 'Berufserfahrung (Jahre)', group: 'Lebenslauf (CV)' },
  { p: 'cv.summary',               t: 'textarea', l: 'Kurzprofil', group: 'Lebenslauf (CV)',
    h: '2–3 Sätze: Fachgebiet, Stärken, was du suchst. Geht direkt an die KI.' },
  { p: 'cv.skills.domain',         t: 'list',     l: 'Fachliche Kompetenzen', group: 'Lebenslauf (CV)', h: 'Eine pro Zeile' },
  { p: 'cv.skills.tools',          t: 'list',     l: 'Tools / Software', group: 'Lebenslauf (CV)' },
  { p: 'cv.skills.programming',    t: 'list',     l: 'Programmierung', group: 'Lebenslauf (CV)' },
  { p: 'cv.languages',             t: 'list',     l: 'Sprachen', group: 'Lebenslauf (CV)' },
  { p: 'cv.education',             t: 'list',     l: 'Ausbildung', group: 'Lebenslauf (CV)', h: 'Ein Abschluss pro Zeile' },
  { p: 'cv.experience',            t: 'list',     l: 'Berufserfahrung (Stationen)', group: 'Lebenslauf (CV)', h: 'Eine Station pro Zeile' },
  { p: 'preferences.desiredRoles', t: 'list',     l: 'Wunsch-Rollen', group: 'Präferenzen', h: 'Job-Titel, die du suchst' },
  { p: 'preferences.locations',    t: 'list',     l: 'Orte', group: 'Präferenzen', h: 'Städte, "Remote", "Hybrid" …' },
  { p: 'preferences.industries',   t: 'list',     l: 'Branchen', group: 'Präferenzen' },
  { p: 'preferences.salaryMin',    t: 'int',      l: 'Mindestgehalt (€/Jahr)', group: 'Präferenzen' },
  { p: 'preferences.contractTypes',t: 'list',     l: 'Vertragsarten', group: 'Präferenzen' },
  { p: 'preferences.dealbreakers', t: 'list',     l: 'No-Gos', group: 'Präferenzen', h: 'Was du auf keinen Fall willst' },
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
  } catch (err) { toast('Fehler: ' + err.message); }
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
  const help = f.h ? ` <span class="set-default">${esc(f.h)}</span>` : '';
  return `<div class="setting">
    <label class="set-label" for="${id}">${esc(f.l)}</label>
    <div class="set-control">${control}<p class="set-help">${help}</p></div>
  </div>`;
}

function renderProfile() {
  const groups = [...new Set(PROFILE_FIELDS.map(f => f.group))];
  $('#profile-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(g)}</h2></div>
      <div class="setting-list">${PROFILE_FIELDS.filter(f => f.group === g).map(profileField).join('')}</div>
    </div>`).join('');
  $('#profile-msg').textContent = '';
}

$('#save-profile').addEventListener('click', async () => {
  const next = JSON.parse(JSON.stringify(profileData || {}));   // preserve untouched keys
  for (const inp of $$('#profile-groups [data-path]')) {
    const p = inp.dataset.path, t = inp.dataset.type;
    if (t === 'list') {
      setPath(next, p, inp.value.split('\n').map(s => s.trim()).filter(Boolean));
    } else if (t === 'int') {
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
    showProfileMsg('✓ Profil gespeichert. Greift beim nächsten Lauf / Anschreiben.', 'ok');
    toast('Profil gespeichert');
  } catch (err) { showProfileMsg('Fehler: ' + err.message, 'err'); }
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
  } catch (err) { toast('Fehler: ' + err.message); }
}

function renderPrompts(fields, values) {
  const groups = [...new Set(fields.map(f => f.group))];
  $('#prompts-groups').innerHTML = groups.map(g => `
    <div class="card">
      <div class="card-head"><h2>${esc(g)}</h2></div>
      <div class="setting-list">
        ${fields.filter(f => f.group === g).map(f => {
          const id = `pr-${f.key}`;
          return `<div class="setting">
            <label class="set-label" for="${id}">${esc(f.label)}
              <button type="button" class="btn btn-ghost prompt-default" data-key="${esc(f.key)}" title="Standard einsetzen">↺ Standard</button>
            </label>
            <div class="set-control">
              <textarea id="${id}" class="set-input su-textarea" data-key="${esc(f.key)}" rows="5" spellcheck="false">${esc(values[f.key] ?? '')}</textarea>
              <p class="set-help">${esc(f.help || '')}</p>
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
    showPromptsMsg('✓ Prompts gespeichert. Greifen sofort beim nächsten Lauf / Anschreiben.', 'ok');
    toast('Prompts gespeichert');
  } catch (err) { showPromptsMsg('Fehler: ' + err.message, 'err'); }
});

// reset all fields to defaults (in the form; takes effect on Save)
$('#prompts-reset').addEventListener('click', () => {
  for (const ta of $$('#prompts-groups textarea[data-key]')) ta.value = promptDefaults[ta.dataset.key] ?? '';
  showPromptsMsg('Standardwerte eingesetzt – zum Übernehmen „Speichern“ klicken.', 'ok');
});

function showPromptsMsg(msg, kind) {
  const el = $('#prompts-msg');
  el.textContent = msg; el.className = 'save-hint ' + kind;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

// ── THEME (light / dark / auto) ───────────────────────────────────────────────
function currentTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  $$('#theme-toggle .theme-opt').forEach(b => b.classList.toggle('active', b.dataset.themeVal === t));
}
$('#theme-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-opt');
  if (btn) applyTheme(btn.dataset.themeVal);
});
applyTheme(currentTheme());   // reflect the saved choice on the toggle buttons

// ── init ────────────────────────────────────────────────────────────────────
loadJobs();
connectStream();
