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
  async function open(debugMode) {
    debug = !!debugMode;
    el.badge.hidden = !debug;
    try {
      const status = await api('/api/setup/status' + qs());
      firstRun = status.firstRun;
      const stepPages = status.steps.filter(s => s.pending);
      if (!debug && stepPages.length === 0) { note('Einrichtung ist bereits vollständig.'); return; }
      pages = [];
      if (firstRun) pages.push('welcome');
      pages.push(...stepPages);
      if (firstRun) pages.push('finish');
      idx = 0;
      el.modal.hidden = false;
      render();
    } catch (err) {
      note('Einrichtung konnte nicht geladen werden: ' + err.message);
    }
  }

  function close() { el.modal.hidden = true; showMsg(''); }

  // ── progress dots ─────────────────────────────────────────────────────────
  function renderProgress() {
    el.progress.innerHTML = pages.map((p, i) => {
      const cls = i === idx ? 'on' : i < idx ? 'done' : '';
      return `<span class="setup-dot ${cls}"></span>`;
    }).join('');
  }

  // ── field controls ──────────────────────────────────────────────────────--
  function fieldControl(f) {
    const id = `su-${f.key.replace(/\W/g, '_')}`;
    const req = f.required ? '<span class="req">erforderlich</span>' : '';
    const da = `data-key="${esc(f.key)}" data-type="${f.type}"`;
    let control;

    if (f.type === 'toggle') {
      const on = String(f.value) !== 'off';
      return `<div class="setting su-field su-toggle-field">
        <label class="su-toggle">
          <input type="checkbox" id="${id}" ${da} ${on ? 'checked' : ''}>
          <span>${esc(f.label)}</span>
        </label>
        ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
      </div>`;
    }

    if (f.type === 'sources') {
      const rows = (f.value || []).map(sourceRow).join('');
      control = `<div class="su-sources" ${da}>
        <div class="su-source-list">${rows}</div>
        <button type="button" class="btn su-add-source">+ Quelle</button>
      </div>`;
    } else if (f.type === 'list') {
      const text = Array.isArray(f.value) ? f.value.join('\n') : (f.value || '');
      control = `<textarea id="${id}" class="set-input su-textarea" ${da}
        placeholder="${esc(f.placeholder)}" spellcheck="false" rows="4">${esc(text)}</textarea>`;
    } else if (f.type === 'textarea') {
      control = `<textarea id="${id}" class="set-input su-textarea" ${da}
        placeholder="${esc(f.placeholder)}" spellcheck="false" rows="4">${esc(f.value || '')}</textarea>`;
    } else if (f.type === 'secret') {
      control = `<div class="secret-wrap">
        <input id="${id}" class="set-input" type="password" ${da} value="${esc(f.value || '')}"
          placeholder="${esc(f.placeholder)}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-ghost su-reveal" title="Anzeigen/Verbergen">👁</button>
      </div>`;
    } else if (f.type === 'int') {
      control = `<input id="${id}" class="set-input set-num" type="number" ${da}
        value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || f.default)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
    } else {
      control = `<input id="${id}" class="set-input" type="text" ${da}
        value="${esc(f.value || '')}" placeholder="${esc(f.placeholder)}" spellcheck="false">`;
    }

    const help = f.help ? `<p class="set-help">${esc(f.help)}</p>` : '';
    return `<div class="setting su-field">
      <label class="set-label" for="${id}">${esc(f.label)} ${req}</label>
      <div class="set-control">${control}${help}</div>
    </div>`;
  }

  function sourceRow(s = { name: '', url: '' }) {
    return `<div class="source-row su-source-row">
      <input class="su-name" placeholder="Name" value="${esc(s.name || '')}">
      <input class="su-url" placeholder="https://… (Karriere-/Stellenseite)" value="${esc(s.url || '')}">
      <button type="button" class="btn btn-ghost btn-danger su-del" title="Entfernen">✕</button>
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
      el.title.textContent = 'Willkommen 👋';
      el.subtitle.textContent = 'Richte deinen Job-Alert in wenigen Schritten ein.';
      el.body.innerHTML = `<div class="su-intro">
        <p>Dieser Assistent führt dich durch alle nötigen Einstellungen — einen Schritt nach dem anderen.
        Du brauchst dafür:</p>
        <ul class="su-list">
          <li>einen <strong>Anthropic API-Schlüssel</strong> (für die KI-Bewertung),</li>
          <li>einen <strong>Telegram-Bot</strong> (für Benachrichtigungen),</li>
          <li>ein paar Angaben zu <strong>dir</strong> und den <strong>Firmen</strong>, die dich interessieren.</li>
        </ul>
        <p class="muted">Alles lässt sich später unter „Einstellungen“ ändern.</p>
      </div>`;
      el.next.textContent = "Los geht's →";
      return;
    }

    if (page === 'finish') {
      el.title.textContent = 'Fertig 🎉';
      el.subtitle.textContent = 'Die Einrichtung ist abgeschlossen.';
      el.body.innerHTML = `<div class="su-intro">
        <p>Alles eingerichtet! Du kannst jetzt einen ersten Lauf starten, um sofort nach passenden Stellen zu suchen.</p>
        <label class="su-check"><input type="checkbox" id="su-run-now" ${debug ? 'disabled' : 'checked'}> Ersten Lauf direkt starten</label>
        ${debug ? '<p class="muted">Im Debug-Modus wird kein echter Lauf gestartet.</p>' : ''}
      </div>`;
      el.next.textContent = 'Abschließen';
      return;
    }

    // a real step
    el.title.textContent = page.title;
    el.subtitle.textContent = page.subtitle || '';
    const intro = page.intro ? `<p class="su-step-intro">${esc(page.intro)}</p>` : '';
    const test = page.test === 'telegram'
      ? `<div class="su-test"><button type="button" class="btn" id="su-test-tg">✈ Testnachricht senden</button><span class="su-test-result" id="su-test-result"></span></div>`
      : '';
    el.body.innerHTML = intro + page.fields.map(f => {
      const f2 = { ...f, value: page.values[f.key] };
      return fieldControl(f2);
    }).join('') + test;

    // Telegram step: reflect the on/off toggle onto the credential fields.
    if (page.test === 'telegram') applyTelegramToggle(page.values.TELEGRAM_NOTIFICATIONS !== 'off');

    el.skip.hidden = page.required;
    el.next.textContent = (idx === pages.length - 1) ? 'Speichern & Abschließen' : 'Speichern & Weiter →';
  }

  // Grey out + disable the Telegram credential fields and test button when the
  // user has opted out of notifications.
  function applyTelegramToggle(on) {
    const tok = el.body.querySelector('[data-key="TELEGRAM_BOT_TOKEN"]');
    const chat = el.body.querySelector('[data-key="TELEGRAM_CHAT_ID"]');
    const test = el.body.querySelector('#su-test-tg');
    [tok, chat, test].forEach(x => {
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
        values[f.key] = rows.map(r => ({
          name: r.querySelector('.su-name').value.trim(),
          url: r.querySelector('.su-url').value.trim(),
        })).filter(s => s.name || s.url);
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
        await api('/api/setup/complete' + qs(), { method: 'POST' });
        close();
        if (!debug && runNow) {
          await fetch('/api/run', { method: 'POST' }).catch(() => {});
          note('Einrichtung fertig – erster Lauf gestartet.');
          setTimeout(() => location.reload(), 600);
        } else {
          note(debug ? 'Debug-Durchlauf abgeschlossen.' : 'Einrichtung abgeschlossen.');
          if (!debug) setTimeout(() => location.reload(), 400);
        }
      } catch (err) { showMsg('Fehler: ' + err.message, 'err'); }
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
      showMsg('Fehler: ' + err.message, 'err');
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

  function advance() {
    if (idx < pages.length - 1) { idx++; render(); }
    else next(); // last real step with no finish page → complete
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
    out.textContent = '…wird gesendet'; out.className = 'su-test-result';
    try {
      const res = await api('/api/setup/test-telegram' + qs(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: collectStep(page) }),
      });
      if (res.ok) { out.textContent = '✓ gesendet – schau in deinen Chat!'; out.className = 'su-test-result ok'; }
      else { out.textContent = '✗ ' + res.error; out.className = 'su-test-result err'; }
    } catch (err) { out.textContent = '✗ ' + err.message; out.className = 'su-test-result err'; }
  }

  // ── event wiring ──────────────────────────────────────────────────────────
  el.next.addEventListener('click', next);
  el.back.addEventListener('click', () => { if (idx > 0) { idx--; render(); } });
  el.skip.addEventListener('click', skip);
  el.close.addEventListener('click', () => {
    if (!firstRun || debug || confirm('Einrichtung wirklich schließen? Du kannst sie später unter „Einstellungen“ fortsetzen.')) close();
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
    const cb = e.target.closest('input[data-type="toggle"]');
    if (cb && cb.dataset.key === 'TELEGRAM_NOTIFICATIONS') applyTelegramToggle(cb.checked);
  });

  // Settings buttons
  $('#reopen-setup')?.addEventListener('click', () => open(false));
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
