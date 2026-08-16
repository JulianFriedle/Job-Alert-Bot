// Shared helpers for the platform appliers: harvesting form fields from an
// apply flow (prepare) and filling stored answers back in (submit). All
// selector work is best-effort — apply flows change without notice, so every
// caller treats a miss as a failed application with a screenshot, never as a
// reason to guess and submit anyway.

// Runs in the browser: enumerate visible, fillable fields inside `container`
// (CSS selector; defaults to the whole document). Returns raw field specs the
// caller turns into question objects.
export function harvestFieldsInPage(containerSelector) {
  const root = containerSelector ? document.querySelector(containerSelector) : document;
  if (!root) return [];
  const out = [];
  const seenLabels = new Set();

  const labelFor = (el) => {
    if (el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.textContent;
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return t;
    }
    const fieldset = el.closest('fieldset');
    const legend = fieldset?.querySelector('legend');
    if (legend) return legend.textContent;
    const group = el.closest('[data-test-form-element], .fb-dash-form-element, [class*="form-element"], [class*="Questions-item"], .ia-Questions-item, div');
    const groupLabel = group?.querySelector('label, legend, [class*="label"]');
    if (groupLabel) return groupLabel.textContent;
    return el.getAttribute('placeholder') || el.name || '';
  };

  // Page chrome (site-wide search bar, nav, cookie banner) must never become a
  // "screening question": StepStone/Indeed harvest without a container selector,
  // and a harvested search bar would be filled at submit time and even pollute
  // the cross-application answer library.
  const inChrome = (el) => Boolean(el.closest(
    'header, nav, footer, [role="search"], [role="banner"], [role="navigation"], [class*="cookie" i], [id*="cookie" i]'
  ));
  const visible = (el) => el.offsetParent !== null && !el.disabled && el.type !== 'hidden' && !inChrome(el);

  // Radio groups: one question per name with the option labels.
  const radios = [...root.querySelectorAll('input[type="radio"]')].filter(visible);
  const radioGroups = new Map();
  for (const r of radios) {
    const key = r.name || labelFor(r);
    if (!radioGroups.has(key)) radioGroups.set(key, []);
    radioGroups.get(key).push(r);
  }
  for (const [name, group] of radioGroups) {
    const fieldset = group[0].closest('fieldset');
    const label = (fieldset?.querySelector('legend')?.textContent || labelFor(group[0]) || name)
      .replace(/\s+/g, ' ').trim();
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    const options = group.map(r => {
      const l = root.querySelector(`label[for="${CSS.escape(r.id || '')}"]`) || r.closest('label');
      return (l?.textContent || r.value || '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    out.push({
      kind: 'radio', label, options,
      required: group.some(r => r.required || r.getAttribute('aria-required') === 'true'),
      answered: group.some(r => r.checked),
    });
  }

  for (const el of root.querySelectorAll('select')) {
    if (!visible(el)) continue;
    const label = (labelFor(el) || '').replace(/\s+/g, ' ').trim();
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    const options = [...el.options]
      .map(o => (o.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t && !/^(bitte )?(ausw[äa]hlen|select)/i.test(t));
    out.push({
      kind: 'select', label, options,
      required: el.required || el.getAttribute('aria-required') === 'true',
      answered: el.selectedIndex > 0 && Boolean(el.value),
    });
  }

  for (const el of root.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea')) {
    if (!visible(el)) continue;
    const label = (labelFor(el) || '').replace(/\s+/g, ' ').trim();
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    out.push({
      kind: el.type === 'number' ? 'number' : 'text', label, options: null,
      required: el.required || el.getAttribute('aria-required') === 'true',
      answered: Boolean((el.value || '').trim()),
    });
  }

  for (const el of root.querySelectorAll('input[type="file"]')) {
    if (el.offsetParent === null && !el.closest('[class*="upload"]')) continue;
    if (inChrome(el)) continue;
    const label = (labelFor(el) || 'Datei-Upload').replace(/\s+/g, ' ').trim();
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    out.push({
      kind: 'file', label, options: null,
      // Custom upload widgets (LinkedIn) mark requirement via aria-required,
      // not the native attribute — same rule as every other field kind.
      required: el.required || el.getAttribute('aria-required') === 'true',
      answered: Boolean(el.files?.length),
    });
  }

  return out;
}

// Turn harvested field specs into the question objects stored on the
// application row. Fields the platform already answered (prefilled from the
// account profile) are skipped — the user only sees what actually needs input.
export function fieldsToQuestions(fields) {
  return fields
    .filter(f => !f.answered && f.kind !== 'file')
    .map((f, i) => ({
      id: `q${i + 1}`,
      label: f.label,
      type: f.kind,
      options: f.options && f.options.length ? f.options : null,
      required: Boolean(f.required),
      answer: null,
      answeredVia: null,
    }));
}

// Runs in the browser: write one answer into the field whose label matches.
// Returns true when a field was found and set.
export function fillAnswerInPage({ containerSelector, label, value }) {
  const root = containerSelector ? document.querySelector(containerSelector) : document;
  if (!root) return false;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(label);

  const labelFor = (el) => {
    if (el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.textContent;
    }
    return el.closest('label')?.textContent
      || el.getAttribute('aria-label')
      || el.closest('fieldset')?.querySelector('legend')?.textContent
      || el.getAttribute('placeholder')
      || '';
  };

  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  // Radios: match group label, then click the option whose label matches value.
  for (const r of root.querySelectorAll('input[type="radio"]')) {
    const groupLabel = norm(r.closest('fieldset')?.querySelector('legend')?.textContent || labelFor(r));
    if (groupLabel !== target && !groupLabel.includes(target)) continue;
    const optLabel = norm(
      (root.querySelector(`label[for="${CSS.escape(r.id || '')}"]`) || r.closest('label'))?.textContent || r.value
    );
    if (optLabel === norm(value)) { r.click(); fire(r); return true; }
  }

  for (const el of root.querySelectorAll('select')) {
    const l = norm(labelFor(el));
    if (l !== target && !l.includes(target)) continue;
    for (const opt of el.options) {
      if (norm(opt.textContent) === norm(value)) {
        el.value = opt.value;
        fire(el);
        return true;
      }
    }
  }

  for (const el of root.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea')) {
    if (el.offsetParent === null) continue;
    const l = norm(labelFor(el));
    if (l !== target && !l.includes(target)) continue;
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
    ).set;
    setter.call(el, String(value));
    fire(el);
    return true;
  }

  return false;
}

// Fill every answered question into the current step/form. Returns the labels
// that could not be matched (caller decides whether that is fatal).
export async function fillAnswers(page, questions, containerSelector = null) {
  const misses = [];
  for (const q of questions) {
    if (q.answer == null || String(q.answer).trim() === '') continue;
    const ok = await page.evaluate(fillAnswerInPage, { containerSelector, label: q.label, value: String(q.answer) })
      .catch(() => false);
    if (!ok) misses.push(q.label);
    await page.waitForTimeout(150 + Math.random() * 250);
  }
  return misses;
}

// Click the first visible button/link matching one of the text patterns.
// Returns the matched pattern source or null.
export async function clickButtonByText(page, patterns, containerSelector = null) {
  return page.evaluate(({ patterns, containerSelector }) => {
    const root = containerSelector ? document.querySelector(containerSelector) : document;
    if (!root) return null;
    const els = [...root.querySelectorAll('button, a[role="button"], [role="button"], input[type="submit"]')];
    for (const src of patterns) {
      const re = new RegExp(src, 'i');
      const el = els.find(b =>
        b.offsetParent !== null && !b.disabled &&
        re.test(((b.textContent || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).trim())
      );
      if (el) { el.click(); return src; }
    }
    return null;
  }, { patterns, containerSelector }).catch(() => null);
}
