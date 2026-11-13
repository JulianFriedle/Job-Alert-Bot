// ── Application documents: Markdown helpers (pure, no I/O) ────────────────────
// CVs and cover letters are stored as Markdown with a small YAML-ish frontmatter
// and inline HTML (the CV header with photo, the signature block). This module
// turns them into a printable HTML page, checks them for the style rules the
// documents must follow, and derives file names / plain text. Everything here is
// synchronous and side-effect free so it can be unit-tested offline.

import { marked } from 'marked';

// Template images are referenced by bare file name in the Markdown
// (`<img src="foto.png">`). Each name maps to one stored client asset.
export const ASSET_NAMES = ['foto', 'unterschrift'];
export const ASSET_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export const DOC_KINDS = ['cv', 'cover'];
const KIND_LABEL = { cv: 'Lebenslauf', cover: 'Anschreiben' };

// ── Frontmatter ──────────────────────────────────────────────────────────────

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(md) {
  const text = String(md ?? '');
  const m = text.match(FM_RE);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

export function stripFrontmatter(md) {
  return splitFrontmatter(md).body;
}

// Set (or add) simple `key: value` lines in the frontmatter, keeping every other
// line (including comments) untouched. Creates a frontmatter block if missing.
export function setFrontmatter(md, values) {
  const { frontmatter, body } = splitFrontmatter(md);
  const lines = frontmatter ? frontmatter.split(/\r?\n/) : [];
  for (const [key, raw] of Object.entries(values)) {
    const value = raw == null || raw === '' ? 'null' : JSON.stringify(String(raw));
    const i = lines.findIndex(l => new RegExp(`^${key}\\s*:`).test(l));
    if (i === -1) lines.push(`${key}: ${value}`);
    else lines[i] = `${key}: ${value}`;
  }
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}

// ── HTML rendering ───────────────────────────────────────────────────────────

const IMG_SRC_RE = new RegExp(
  `<img\\b([^>]*?)\\bsrc=["'](${ASSET_NAMES.join('|')})\\.(?:png|jpe?g|webp)["']([^>]*)>`, 'gi'
);

// Swap `src="foto.png"` / `src="unterschrift.png"` for inline data URIs. An image
// whose asset was never uploaded is dropped rather than rendered broken.
export function embedAssets(html, assets = {}) {
  return html.replace(IMG_SRC_RE, (_, pre, name, post) => {
    const a = assets[name.toLowerCase()];
    if (!a || !a.data) return '';
    const b64 = Buffer.isBuffer(a.data) ? a.data.toString('base64') : Buffer.from(a.data).toString('base64');
    return `<img${pre}src="data:${a.mime};base64,${b64}"${post}>`;
  });
}

// On screen (GUI preview) the page is shown as a white A4 sheet; print/PDF is
// unaffected because the rule only applies to the screen media type.
const SCREEN_CSS = `@media screen {
  html { background: #e9ebef; }
  body { background: #fff; max-width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 20mm; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
}`;

// Full standalone HTML page for preview and PDF printing.
export function renderDocumentHtml(markdown, { css = '', assets = {}, title = '', screen = false } = {}) {
  const body = embedAssets(marked.parse(stripFrontmatter(markdown)), assets);
  if (screen) css = `${css}\n${SCREEN_CSS}`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main class="dokument">
${body}
</main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Lint: style rules the AI output must follow ──────────────────────────────

// A dash between two dates/years is structure, not prose ("März 2025 – heute").
const DATE_WORD = '(?:\\d{4}|\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}|heute|jetzt|dato|laufend|vsl\\.?\\s*\\w+\\s*\\d{4})';
const DATE_RANGE_RE = new RegExp(`${DATE_WORD}\\s+[–—]\\s+(?:vsl\\.\\s*|seit\\s*)?\\S`, 'i');
const SPACED_DASH_RE = /\s[–—]\s/g;
// [Platzhalter] — but not Markdown links `[text](url)` and not task boxes.
const PLACEHOLDER_RE = /\[(?![ xX]\])[^\]\n]{2,}\](?!\()/g;

// Returns a list of { rule, line, text } findings. Rules:
//  - dash: spaced en/em dash in running text (an AI tell the documents avoid)
//  - placeholder: a leftover template placeholder like "[Datum]"
//  - empty: the document has no content at all
export function lintDocument(markdown) {
  const findings = [];
  const { body } = splitFrontmatter(markdown);
  if (!body.trim()) return [{ rule: 'empty', line: 0, text: '' }];

  // Line numbers are reported relative to the full document (frontmatter included).
  const offset = String(markdown).split('\n').length - body.split('\n').length;
  let inComment = false;
  body.split('\n').forEach((raw, i) => {
    let line = raw;
    // Skip HTML comments (template instructions for the AI), even multi-line.
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) return;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open !== -1) { line = line.slice(0, open); inComment = true; }
    if (!line.trim()) return;

    const n = i + 1 + offset;
    // Headings and the "Firma · Ort · Zeitraum" meta lines are structure.
    const isStructure = /^\s*#{1,6}\s/.test(line) || /\s·\s/.test(line);
    if (!isStructure) {
      // Bold run-in labels ("**Bachelorarbeit – HPE**: …") count as structure too.
      const scan = line.replace(/\*\*[^*]+\*\*/g, s => s.replace(/[–—]/g, '-'));
      for (const m of scan.matchAll(SPACED_DASH_RE)) {
        const around = scan.slice(Math.max(0, m.index - 25), m.index + 12);
        if (DATE_RANGE_RE.test(around)) continue;
        // "- Organisation – Rolle": a short label before the dash in a list item,
        // followed by a capitalised word (prose would go on in lower case).
        const label = scan.slice(0, m.index).match(/^\s*[-*+]\s+(.*)$/);
        const next = scan.slice(m.index + m[0].length, m.index + m[0].length + 1);
        if (label && label[1].length <= 60 && !/[,;:]/.test(label[1]) && /[A-ZÄÖÜ0-9]/.test(next)) continue;
        findings.push({ rule: 'dash', line: n, text: line.trim().slice(0, 140) });
        break;
      }
    }
    for (const m of line.matchAll(PLACEHOLDER_RE)) {
      findings.push({ rule: 'placeholder', line: n, text: m[0] });
    }
  });
  return findings;
}

// ── File names / plain text ──────────────────────────────────────────────────

// Company slug for file names: lowercase, umlauts transliterated, everything
// else collapsed to single dashes.
export function slugify(s) {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return out || 'firma';
}

// YYYY-MM-DD_firmenslug_Lebenslauf.pdf
export function documentFileName({ date = new Date(), company, kind, ext = 'pdf' }) {
  const d = date instanceof Date ? date : new Date(date);
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return `${iso.slice(0, 10)}_${slugify(company)}_${KIND_LABEL[kind] || kind}.${ext}`;
}

// Plain-text rendering of a document — used where a platform form only takes
// text (auto-apply cover letter field). Drops frontmatter, comments, images and
// tags, unwraps Markdown emphasis/links/headings.
export function toPlainText(markdown) {
  return stripFrontmatter(markdown)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|header)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*])\*(?!\s)([^*\n]+)\*/g, '$1$2')
    .replace(/\\\n/g, '\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
