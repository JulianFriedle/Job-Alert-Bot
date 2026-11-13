// ── First-run setup wizard (frontend) ────────────────────────────────────────
// Self-contained: defines its own tiny helpers so it can load before app.js.
// Shows one incomplete step at a time. On a fresh install it auto-opens; it can
// also be reopened from Settings, or run in a no-risk Debug/Sandbox mode.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const note = (m) => (window.toast ? window.toast(m) : console.log(m));
  const api = async (url, opts) => {
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body?.error || res.statusText);
    return body;
  };

  const el = {
    modal: $('#setup-modal'), body: $('#setup-body'), title: $('#setup-title'),
    subtitle: $('#setup-subtitle'), progress: $('#setup-progress'), msg: $('#setup-msg'),
    badge: $('#setup-debug-badge'), close: $('#setup-close'),
    skip: $('#setup-skip'), back: $('#setup-back'), next: $('#setup-next'),
  };

  // Wizard run-state
  let debug = false;
  let firstRun = false;
  let pages = [];     // ['welcome', <stepObj>…, 'finish']
  let idx = 0;

  const qs = () => (debug ? '?debug=1' : '');

  function showMsg(text, kind) {
    el.msg.textContent = text || '';
    el.msg.className = 'save-hint setup-msg' + (kind ? ' ' + kind : '');
  }

  // ── open / close ────────────────────────────────────────────────────────--
  // `allSteps` shows every step instead of only the outstanding ones. Opening the
  // wizard by hand from Settings means "let me go through my answers", so it must
  // work when nothing is pending — that is the normal case for a configured
  // install. The automatic open on load stays filtered, so a step added by a later
  // release still appears on its own rather than replaying the whole flow.
  async function open(debugMode, { allSteps = false } = {}) {
    debug = !!debugMode;
    el.badge.hidden = !debug;
    try {
      const status = await api('/api/setup/status' + qs());
      firstRun = status.firstRun;
      const stepPages = (debug || allSteps) ? status.steps : status.steps.filter(s => s.pending);
      if (stepPages.length === 0) { note(t('wiz.alreadyComplete')); return; }
      pages = [];
      if (firstRun) pages.push('welcome');
      pages.push(...stepPages);
      if (firstRun) pages.push('finish');
      idx = 0;
      el.modal.hidden = false;
      render();
    } catch (err) {
      note(t('wiz.loadFailed') + err.message);
    }
  }

  function close() { el.modal.hidden = true; showMsg(''); }

  // ── progress dots ─────────────────────────────────────────────────────────
  function renderProgress() {
    const dots = pages.map((p, i) => {
      const cls = i === idx ? 'on' : i < idx ? 'done' : '';
      const name = typeof p === 'object' ? (wzStep(p.id, 'title') ?? p.title) : '';
      return `<span class="setup-dot ${cls}"${name ? ` title="${esc(name)}"` : ''}></span>`;
    }).join('');
    // "Step 3 of 9" counts only real steps, not the welcome/finish frames.
    const steps = pages.filter(p => typeof p === 'object');
    const pos = typeof pages[idx] === 'object' ? steps.indexOf(pages[idx]) + 1 : 0;
    const label = pos ? `<span class="setup-count">${esc(t('wiz.stepOf').replace('{n}', pos).replace('{total}', steps.length))}</span>` : '';
    el.progress.innerHTML = `<span class="setup-dots">${dots}</span>${label}`;
  }

  // ── field controls ──────────────────────────────────────────────────────--
  function fieldControl(f) {
    const id = `su-${f.key.replace(/\W/g, '_')}`;
    const label = wzField(f.key, 'label') ?? f.label;
    const help = wzField(f.key, 'help') ?? f.help;
    const placeholder = wzField(f.key, 'placeholder') ?? f.placeholder;
    let req = f.required ? `<span class="req">${esc(t('wiz.required'))}</span>` : '';
    const da = `data-key="${esc(f.key)}" data-type="${f.type}"`;
    let control;

    if (f.type === 'toggle') {
      const on = String(f.value) !== 'off';
      return `<div class="setting su-field su-toggle-field">
        <label class="su-toggle">
          <input type="checkbox" id="${id}" ${da} ${on ? 'checked' : ''}>
          <span>${esc(label)}</span>
        </label>
        ${help ? `<p class="set-help">${esc(help)}</p>` : ''}
      </div>`;
    }

    if (f.type === 'checks') {
      const chosen = new Set(Array.isArray(f.value) ? f.value : []);
      return `<div class="setting su-field">
        <span class="set-label">${esc(label)} ${req}</span>
        <div class="set-control">
          <div class="su-checks" ${da}>${(f.options || []).map(o => `
            <label class="su-chip"><input type="checkbox" value="${esc(o.value)}" ${chosen.has(o.value) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}
          </div>
          ${help ? `<p class="set-help">${esc(help)}</p>` : ''}
        </div>
      </div>`;
    }

    if (f.type === 'sources') {
      // Job-board searches have no URL: they belong to the "Jobportale" step and
      // are merged back by the server, so only career pages are rows here.
      const all = Array.isArray(f.value) ? f.value : [];
      const boards = all.filter(s => PLATFORM_TYPES.includes(s.type));
      const rows = all.filter(s => !PLATFORM_TYPES.includes(s.type)).map(sourceRow).join('');
      if (boards.length) req = '';   // a job-board search already satisfies the minimum
      const boardNote = boards.length
        ? `<p class="su-board-note">${esc(t('wiz.boardsKept').replace('{list}', boards.map(b => b.name).join(', ')))}</p>`
        : '';
      control = `<div class="su-sources" ${da}>
        <div class="su-source-list">${rows}</div>
        <button type="button" class="btn su-add-source">${esc(t('wiz.addSource'))}</button>
        ${boardNote}
      </div>`;
    } else if (f.type === 'select') {
      let value = String(f.value ?? '');
      // UI language lives in the browser; the content language defaults to it.
      if (f.store === 'ui' && f.key === 'uiLanguage') value = lang;
      if (value === '' && f.key === 'preferences.outputLanguage') value = lang;
      if (value === '') value = String(f.default ?? '');
      const opts = (f.options || []).map(o => ({ value: o.value, label: wzOption(f.key, o.value) ?? o.label }));
      if (f.allowCustom && value && !opts.some(o => o.value === value)) {
        opts.push({ value, label: t('wiz.customValue').replace('{v}', value) });
      }
      control = `<select id="${id}" class="set-input" ${da}>${opts.map(o =>
        `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'list') {
      const text = Array.isArray(f.value) ? f.value.join('\n') : (f.value || '');
      control = `<textarea id="${id}" class="set-input su-textarea" ${da}
        placeholder="${esc(placeholder)}" spellcheck="false" rows="4">${esc(text)}</textarea>`;
    } else if (f.type === 'textarea') {
      control = `<textarea id="${id}" class="set-input su-textarea" ${da}
        placeholder="${esc(placeholder)}" spellcheck="false" rows="4">${esc(f.value || '')}</textarea>`;
    } else if (f.type === 'secret') {
      control = `<div class="secret-wrap">
        <input id="${id}" class="set-input" type="password" ${da} value="${esc(f.value || '')}"
          placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-ghost su-reveal" title="${esc(t('wiz.reveal'))}">👁</button>
      </div>`;
    } else if (f.type === 'int') {
      control = `<input id="${id}" class="set-input set-num" type="number" ${da}
        value="${esc(f.value ?? '')}" placeholder="${esc(placeholder || f.default)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
    } else {
      control = `<input id="${id}" class="set-input" type="text" ${da}
        value="${esc(f.value || '')}" placeholder="${esc(placeholder)}" spellcheck="false">`;
    }

    const helpHtml = help ? `<p class="set-help">${esc(help)}</p>` : '';
    return `<div class="setting su-field">
      <label class="set-label" for="${id}">${esc(label)} ${req}</label>
      <div class="set-control">${control}${helpHtml}</div>
    </div>`;
  }

  const PLATFORM_TYPES = ['linkedin', 'stepstone', 'indeed'];

  // Each row carries the source's other keys (type, paginationParam, extraWait, …)
  // so saving from the wizard never strips a hand-tuned career page.
  function sourceRow(s = { name: '', url: '' }) {
    const { name, url, ...extra } = s;
    return `<div class="source-row su-source-row" data-extra="${esc(JSON.stringify(extra))}">
      <input class="su-name" placeholder="${esc(t('wiz.sourceNamePh'))}" value="${esc(s.name || '')}">
      <input class="su-url" placeholder="${esc(t('wiz.sourceUrlPh'))}" value="${esc(s.url || '')}">
      <button type="button" class="btn btn-ghost btn-danger su-del" title="${esc(t('wiz.del'))}">✕</button>
    </div>`;
  }

  // ── render current page ─────────────────────────────────────────────────--
  function render() {
    renderProgress();
    showMsg('');
    const page = pages[idx];

    el.back.hidden = idx === 0;
    el.skip.hidden = true;
    el.next.disabled = false;

    if (page === 'welcome') {
      el.title.textContent = t('wiz.welcomeTitle');
      el.subtitle.textContent = t('wiz.welcomeSubtitle');
      el.body.innerHTML = `<div class="su-intro">
        <div class="su-field su-lang-field">
          <label class="su-lang-label" for="su-lang">${esc(t('wiz.langLabel'))}</label>
          <select id="su-lang" class="set-input">
            <option value="de"${lang === 'de' ? ' selected' : ''}>Deutsch</option>
            <option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
          </select>
        </div>
        <p>${t('wiz.welcomeBody')}</p>
        <ul class="su-list">
          <li>${t('wiz.welcomeLi1')}</li>
          <li>${t('wiz.welcomeLi2')}</li>
          <li>${t('wiz.welcomeLi3')}</li>
          <li>${t('wiz.welcomeLi4')}</li>
        </ul>
        <p class="muted">${esc(t('wiz.welcomeFootnote'))}</p>
      </div>`;
      el.next.textContent = t('wiz.start');
      return;
    }

    if (page === 'finish') {
      el.title.textContent = t('wiz.finishTitle');
      el.subtitle.textContent = t('wiz.finishSubtitle');
      el.body.innerHTML = `<div class="su-intro">
        <p>${esc(t('wiz.finishBody'))}</p>
        <ol class="su-list su-next">
          <li>${t('wiz.finishLi1')}</li>
          <li>${t('wiz.finishLi2')}</li>
          <li>${t('wiz.finishLi3')}</li>
        </ol>
        <label class="su-check"><input type="checkbox" id="su-tour" checked> ${esc(t('wiz.tourAfter'))}</label>
        <label class="su-check"><input type="checkbox" id="su-run-now" ${debug ? 'disabled' : 'checked'}> ${esc(t('wiz.runNow'))}</label>
        <p class="muted su-run-hint">${esc(debug ? t('wiz.debugNoRun') : t('wiz.runNowHint'))}</p>
      </div>`;
      el.next.textContent = t('wiz.finish');
      return;
    }

    // a real step
    el.title.textContent = wzStep(page.id, 'title') ?? page.title;
    el.subtitle.textContent = wzStep(page.id, 'subtitle') ?? page.subtitle ?? '';
    const introTxt = wzStep(page.id, 'intro') ?? page.intro;
    const intro = introTxt ? `<p class="su-step-intro">${esc(introTxt)}</p>` : '';
    const laterTxt = page.later === 'wizard' ? t('wiz.laterWizard')
      : page.later === 'language' ? t('wiz.laterLanguage')
      : page.later ? t('wiz.later').replace('{tab}', t('tab.' + page.later)) : '';
    const later = laterTxt ? `<p class="su-later">${esc(laterTxt)}</p>` : '';
    const test = page.test === 'telegram'
      ? `<div class="su-test"><button type="button" class="btn" id="su-test-tg">${esc(t('wiz.testTelegram'))}</button><span class="su-test-result" id="su-test-result"></span></div>`
      : '';
    // The welcome page already asked for the UI language on a first run.
    const shown = page.fields.filter(f => !(f.store === 'ui' && pages[0] === 'welcome'));
    el.body.innerHTML = intro + shown.map(f => {
      const f2 = { ...f, value: page.values[f.key] };
      return fieldControl(f2);
    }).join('') + test + later;

    // Telegram step: reflect the on/off toggle onto the credential fields.
    if (page.test === 'telegram') applyTelegramToggle(page.values.TELEGRAM_NOTIFICATIONS !== 'off');

    el.skip.hidden = page.required;
    el.next.textContent = (idx === pages.length - 1) ? t('wiz.complete') : t('wiz.saveNext');
  }

  // Grey out + disable the Telegram credential fields and test button when the
  // user has opted out of notifications.
  function applyTelegramToggle(on) {
    const page = pages[idx];
    const dependent = (page?.fields || []).filter(f => f.telegramOnly)
      .map(f => el.body.querySelector(`[data-key="${cssEsc(f.key)}"]`));
    const test = el.body.querySelector('#su-test-tg');
    [...dependent, test].forEach(x => {
      if (!x) return;
      x.disabled = !on;
      x.closest('.setting, .su-test')?.classList.toggle('su-dim', !on);
    });
  }

  // ── collect values from the current step's inputs ─────────────────────────--
  function collectStep(page) {
    const values = {};
    for (const f of page.fields) {
      if (f.type === 'sources') {
        const rows = [...el.body.querySelectorAll('.su-source-row')];
        values[f.key] = rows.map(r => {
          let extra = {};
          try { extra = JSON.parse(r.dataset.extra || '{}'); } catch { /* fresh row */ }
          return {
            ...extra,
            name: r.querySelector('.su-name').value.trim(),
            url: r.querySelector('.su-url').value.trim(),
          };
        }).filter(s => s.name || s.url);
        // Keep the board searches in the cached values so a re-render (language
        // switch) still shows the note; the server ignores them on save.
        values[f.key].push(...(page.values[f.key] || []).filter(s => PLATFORM_TYPES.includes(s.type)));
      } else if (f.type === 'checks') {
        values[f.key] = [...el.body.querySelectorAll(`[data-key="${cssEsc(f.key)}"] input:checked`)].map(i => i.value);
      } else if (f.type === 'toggle') {
        const cb = el.body.querySelector(`[data-key="${cssEsc(f.key)}"]`);
        values[f.key] = cb ? cb.checked : true;
      } else if (f.type === 'list') {
        const ta = el.body.querySelector(`[data-key="${cssEsc(f.key)}"]`);
        values[f.key] = (ta?.value || '').split('\n').map(x => x.trim()).filter(Boolean);
      } else {
        const inp = el.body.querySelector(`[data-key="${cssEsc(f.key)}"]`);
        values[f.key] = inp ? inp.value : '';
      }
    }
    return values;
  }
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));

  // ── navigation ────────────────────────────────────────────────────────────
  async function next() {
    const page = pages[idx];

    if (page === 'welcome') { idx++; render(); return; }

    if (page === 'finish') {
      try {
        const runNow = $('#su-run-now')?.checked;
        const tour = $('#su-tour')?.checked;
        await api('/api/setup/complete' + qs(), { method: 'POST' });
        close();
        if (tour) {
          // A real finish reloads the page, so hand the tour over via storage;
          // debug mode stays on the page and can start it right away.
          if (debug) { setTimeout(() => window.Tour?.start(), 300); note(t('wiz.debugDone')); return; }
          try { localStorage.setItem('tourPending', '1'); } catch { /* tour just won't auto-start */ }
        }
        if (!debug && runNow) {
          await fetch('/api/run', { method: 'POST' }).catch(() => {});
          note(t('wiz.completeRun'));
          setTimeout(() => location.reload(), 600);
        } else {
          note(debug ? t('wiz.debugDone') : t('wiz.setupDone'));
          if (!debug) setTimeout(() => location.reload(), 400);
        }
      } catch (err) { showMsg(t('wiz.error') + err.message, 'err'); }
      return;
    }

    // real step → persist
    el.next.disabled = true;
    try {
      const result = await api('/api/setup/step' + qs(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: page.id, values: collectStep(page) }),
      });
      // refresh values from server (keeps subsequent renders accurate)
      if (result.status) syncFromStatus(result.status);
      advance();
    } catch (err) {
      showMsg(t('wiz.error') + err.message, 'err');
      el.next.disabled = false;
    }
  }

  async function skip() {
    const page = pages[idx];
    if (!page || page === 'welcome' || page === 'finish' || page.required) { advance(); return; }
    try {
      await api('/api/setup/step' + qs(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: page.id, skip: true }),
      });
    } catch { /* non-fatal */ }
    advance();
  }

  async function advance() {
    if (idx < pages.length - 1) { idx++; render(); return; }
    // Last page is the 'finish' sentinel (first run): let next() run its
    // completion branch. Otherwise (reopened wizard, real step last) complete
    // directly — recursing into next() would re-save the same step forever.
    if (pages[idx] === 'finish') { next(); return; }
    try { await api('/api/setup/complete' + qs(), { method: 'POST' }); } catch { /* non-fatal */ }
    close();
    note(debug ? t('wiz.debugDone') : t('wiz.setupDone'));
    if (!debug) setTimeout(() => location.reload(), 400);
  }

  function syncFromStatus(status) {
    // Update cached values for any step pages still ahead.
    const byId = Object.fromEntries(status.steps.map(s => [s.id, s]));
    pages = pages.map(p => (p === 'welcome' || p === 'finish') ? p : (byId[p.id] || p));
  }

  // ── telegram test ─────────────────────────────────────────────────────────
  async function runTelegramTest() {
    const page = pages[idx];
    const out = $('#su-test-result');
    out.textContent = t('wiz.sending'); out.className = 'su-test-result';
    try {
      const res = await api('/api/setup/test-telegram' + qs(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: collectStep(page) }),
      });
      if (res.ok) { out.textContent = t('wiz.testOk'); out.className = 'su-test-result ok'; }
      else { out.textContent = '✗ ' + res.error; out.className = 'su-test-result err'; }
    } catch (err) { out.textContent = '✗ ' + err.message; out.className = 'su-test-result err'; }
  }

  // ── event wiring ──────────────────────────────────────────────────────────
  el.next.addEventListener('click', next);
  el.back.addEventListener('click', () => { if (idx > 0) { idx--; render(); } });
  el.skip.addEventListener('click', skip);
  el.close.addEventListener('click', () => {
    if (!firstRun || debug || confirm(t('wiz.closeConfirm'))) close();
  });

  el.body.addEventListener('click', (e) => {
    if (e.target.closest('.su-reveal')) {
      const inp = e.target.closest('.secret-wrap').querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      e.target.classList.toggle('on', inp.type === 'text');
    }
    if (e.target.closest('.su-add-source')) {
      const list = e.target.closest('.su-sources').querySelector('.su-source-list');
      list.insertAdjacentHTML('beforeend', sourceRow());
      list.lastElementChild.querySelector('.su-name').focus();
    }
    if (e.target.closest('.su-del')) e.target.closest('.su-source-row').remove();
    if (e.target.closest('#su-test-tg')) runTelegramTest();
  });

  el.body.addEventListener('change', (e) => {
    // Language picker on the welcome page → switch the whole UI immediately.
    if (e.target.id === 'su-lang' || e.target.dataset.key === 'uiLanguage') { setLang(e.target.value); return; }
    const cb = e.target.closest('input[data-type="toggle"]');
    if (cb && cb.dataset.key === 'TELEGRAM_NOTIFICATIONS') applyTelegramToggle(cb.checked);
  });

  // Re-render the open wizard when the language changes (e.g. from the welcome
  // picker or the Settings dropdown) so titles, fields and buttons follow suit.
  onLangChange(() => {
    if (el.modal.hidden) return;
    const page = pages[idx];
    // Keep any values already typed in the current step across the re-render.
    if (page && typeof page === 'object') Object.assign(page.values, collectStep(page));
    render();
  });

  // Settings buttons
  $('#reopen-setup')?.addEventListener('click', () => open(false, { allSteps: true }));
  $('#debug-setup')?.addEventListener('click', () => open(true));

  // Expose + auto-check on load
  window.Setup = { open };
  (async () => {
    try {
      const status = await api('/api/setup/status');
      if (status.needed) open(false);
    } catch { /* server still starting or no setup needed */ }
  })();
})();
