// ── Guided GUI tour ──────────────────────────────────────────────────────────
// A short walk through the dashboard for people who have never seen it: each
// stop switches to a tab, spotlights one element and explains it in a popover.
// Starts automatically right after the setup wizard (the wizard leaves a
// `tourPending` flag in localStorage before it reloads), and any time from the
// "?" button in the top bar or Einstellungen → Rundgang starten.
//
// Text lives in i18n.js under tour.<key>.title / tour.<key>.body.
(function () {
  const $ = (s, el = document) => el.querySelector(s);

  // target: element to spotlight (none → centered card). tab: tab to open first.
  const STOPS = [
    { key: 'intro' },
    { key: 'jobs',     tab: 'jobs',     target: '.tab[data-tab="jobs"]' },
    { key: 'filters',  tab: 'jobs',     target: '#view-jobs .toolbar' },
    { key: 'run',      tab: 'run',      target: '#quick-run' },
    { key: 'sources',  tab: 'sources',  target: '.tab[data-tab="sources"]' },
    { key: 'profile',  tab: 'profile',  target: '.tab[data-tab="profile"]' },
    { key: 'stats',    tab: 'stats',    target: '.tab[data-tab="stats"]' },
    { key: 'prompts',  tab: 'prompts',  target: '.tab[data-tab="prompts"]' },
    { key: 'clients',  tab: 'clients',  target: '.tab[data-tab="clients"]' },
    { key: 'settings', tab: 'settings', target: '.tab[data-tab="settings"]' },
    { key: 'help',     tab: 'jobs',     target: '#help-btn' },
    { key: 'done' },
  ];

  let root = null, stops = [], i = 0, lastFocus = null;

  // A stop is skipped when its element isn't part of this setup (e.g. the
  // Klienten tab while CLIENTS_ENABLED is off).
  const available = (s) => {
    if (!s.target) return true;
    const el = $(s.target);
    return !!el && !el.hidden && !el.closest('[hidden]');
  };

  function build() {
    root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-hole" hidden></div>
      <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
        <div class="tour-count"></div>
        <h3 id="tour-title"></h3>
        <div class="tour-body" id="tour-body"></div>
        <div class="tour-actions">
          <button type="button" class="btn btn-ghost tour-skip"></button>
          <span class="tour-spacer"></span>
          <button type="button" class="btn tour-back"></button>
          <button type="button" class="btn btn-primary tour-next"></button>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.tour-skip').addEventListener('click', end);
    root.querySelector('.tour-back').addEventListener('click', back);
    root.querySelector('.tour-next').addEventListener('click', next);
  }

  function start() {
    if (root) end(true);
    // Never stack on top of the wizard or the login screen.
    if (!$('#setup-modal')?.hidden || !$('#login-overlay')?.hidden) return;
    stops = STOPS.filter(available);
    i = 0;
    lastFocus = document.activeElement;
    build();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    show();
  }

  function end(silent) {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    root.remove();
    root = null;
    try { localStorage.setItem('tourDone', '1'); } catch { /* ignore */ }
    if (silent !== true) {
      $('.tab[data-tab="jobs"]')?.click();
      lastFocus?.focus?.();
    }
  }

  function next() { if (i < stops.length - 1) { i++; show(); } else end(); }
  function back() { if (i > 0) { i--; show(); } }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'Tab') {
      // Keep keyboard focus inside the popover while the page is blocked.
      const btns = [...root.querySelectorAll('.tour-pop button')].filter(b => !b.hidden);
      const at = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(at + (e.shiftKey ? -1 : 1) + btns.length) % btns.length]?.focus();
    }
  }

  function show() {
    const s = stops[i];
    if (s.tab) {
      const tab = $(`.tab[data-tab="${s.tab}"]`);
      if (tab && !tab.classList.contains('active')) tab.click();
    }
    const pop = root.querySelector('.tour-pop');
    root.querySelector('.tour-count').textContent = (i > 0 && i < stops.length - 1)
      ? t('tour.count').replace('{n}', i).replace('{total}', stops.length - 2) : '';
    root.querySelector('#tour-title').textContent = t(`tour.${s.key}.title`);
    root.querySelector('.tour-body').innerHTML = t(`tour.${s.key}.body`);
    root.querySelector('.tour-skip').textContent = t('tour.skip');
    root.querySelector('.tour-skip').hidden = i === stops.length - 1;
    const backBtn = root.querySelector('.tour-back');
    backBtn.textContent = t('tour.back');
    backBtn.hidden = i === 0;
    root.querySelector('.tour-next').textContent = i === 0 ? t('tour.start')
      : i === stops.length - 1 ? t('tour.finish') : t('tour.next');

    const el = s.target ? $(s.target) : null;
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center' });
    // Wait a frame so a freshly switched tab has laid out before measuring.
    requestAnimationFrame(() => { place(); pop.querySelector('.tour-next').focus(); });
  }

  function place() {
    if (!root) return;
    const s = stops[i];
    const hole = root.querySelector('.tour-hole');
    const pop = root.querySelector('.tour-pop');
    const el = s.target ? $(s.target) : null;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 12, pad = 6;

    root.classList.toggle('tour-centered', !el);
    if (!el) {
      hole.hidden = true;
      pop.style.left = `${Math.max(16, (vw - pop.offsetWidth) / 2)}px`;
      pop.style.top = `${Math.max(16, (vh - pop.offsetHeight) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    hole.hidden = false;
    Object.assign(hole.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });

    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + pad + gap;
    if (top + ph > vh - 16) top = r.top - pad - gap - ph;       // no room below → above
    top = Math.min(Math.max(16, top), vh - ph - 16);
    const left = Math.min(Math.max(16, r.left + r.width / 2 - pw / 2), vw - pw - 16);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  onLangChange(() => { if (root) show(); });

  $('#help-btn')?.addEventListener('click', start);
  $('#tour-btn')?.addEventListener('click', start);
  window.Tour = { start };

  // Hand-over from the wizard: start once the app has booted and nothing else
  // (login, a still-open wizard) is in front.
  let pending = false;
  try { pending = localStorage.getItem('tourPending') === '1'; } catch { /* ignore */ }
  if (pending) {
    let tries = 0;
    const tryStart = () => {
      const ready = $('#setup-modal')?.hidden && $('#login-overlay')?.hidden;
      if (ready) {
        try { localStorage.removeItem('tourPending'); } catch { /* ignore */ }
        start();
      } else if (++tries < 20) setTimeout(tryStart, 500);
    };
    setTimeout(tryStart, 800);
  }
})();
