// The generic career-page scraper used to save pagination, legal links and UI
// buttons as jobs (#38) — each one cost a detail-page fetch and a Claude call.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isNonJobLink, normalizeLinkText } from '../src/link-filter.js';

test('the link texts reported in #38 are dropped', () => {
  for (const text of [
    'Gehe zu Seite 1', 'Gehe zu Seite 2', 'Gehe zu Seite 3', 'Gehe zu Seite 4',
    'Impressum und rechtliche Hinweise',
    'Stellenanzeige merken',
    'Lokalisiere mich',
    'Arbeiten bei Diehl',
    'Folgen Sie diesem Link auf unsere Stellensuchseite der Diehl-Gruppe',
    'hier weitere attraktive Angebote des Diehl-Konzerns',
    'ERGREIF DIE INITIATIVE',
  ]) assert.equal(isNonJobLink(text, 'Diehl'), true, text);
});

test('more pagination, legal and UI chrome is dropped', () => {
  for (const text of [
    'Seite 2', 'Seite 3 von 12', 'Page 4', 'Go to page 2', 'Nächste Seite', 'Next page',
    'Impressum', 'Datenschutz', 'Datenschutzerklärung', 'Cookie-Einstellungen', 'Privacy Policy',
    'Barrierefreiheit', 'Terms of Use', 'AGB',
    'Job merken', 'Save job', 'Share this job', 'Standort ermitteln', 'Use my location',
    'Filter zurücksetzen', 'Zurück zur Übersicht', 'Back to search', 'Job-Alert erstellen',
    'Karriere bei Bosch', 'Alle Stellen anzeigen', 'Weitere Stellen', 'Initiativbewerbung',
    '  »Impressum«  ', 'Seite 2 ›', 'Ergreife die Initiative!',
  ]) assert.equal(isNonJobLink(text), true, text);
});

test('a link that is just the company name is dropped', () => {
  assert.equal(isNonJobLink('Diehl Defence', 'Diehl Defence'), true);
  assert.equal(isNonJobLink('  DIEHL defence ', 'Diehl Defence'), true);
  assert.equal(isNonJobLink('Diehl Defence Systemingenieur (m/w/d)', 'Diehl Defence'), false);
});

test('real job titles that share words with the chrome survive', () => {
  for (const text of [
    'Referent Datenschutz (m/w/d)',
    'Datenschutzbeauftragter (m/w/d)',
    'Datenschutz Specialist (all genders)',
    'Mitarbeiter Impressum & Content (m/w/d)',
    'Seitenbauer / Karosseriebauer (m/w/d)',
    'Page Layout Designer',
    'Kontaktcenter-Agent (m/w/d)',
    'Arbeitsvorbereiter (m/w/d)',
    'Arbeiten im Lager – Fachkraft für Lagerlogistik (m/w/d)',
    'Karriereberater (m/w/d)',
    'Initiative Manager Sustainability',
    'Werkstudent Accessibility Testing',
    'Betreuer Lieferantenqualität',
    'Executive Assistant to the Board',
    // Start like marketing links, but are listings (review of #38)
    'Arbeiten bei Bosch als Softwareentwickler (m/w/d)',
    'Arbeiten für die Zukunft: Software Engineer',
    'Alle Stellen Controlling',
    'Weitere Angebote Mitarbeiter (m/w/d)',
    'Alle Angebote Kundenservice',
    'Weitere Stellen im Bereich Vertrieb',
  ]) assert.equal(isNonJobLink(text, 'Diehl'), false, text);
});

test('a gender marker always means a job title', () => {
  for (const text of [
    'Impressum (m/w/d)', 'Seite 2 (w/m/d)', 'Karriere bei Diehl (m/f/d)',
    'Initiativbewerbung (m/w/d)', 'Stelle merken (all genders)', 'Kontakt (gn)', 'Datenschutz (m|w|d)',
  ]) assert.equal(isNonJobLink(text, 'Diehl'), false, text);
});

test('the current-page suffix and invisible characters do not hide pagination', () => {
  assert.equal(isNonJobLink('Gehe zu Seite 1 (aktuelle Seite)'), true);
  assert.equal(isNonJobLink('Page 3 (current)'), true);
  assert.equal(isNonJobLink('Gehe zu\u200b Seite 3'), true);
  assert.equal(isNonJobLink('Impres\u00adsum'), true);
});

test('empty link text is never a job', () => {
  assert.equal(isNonJobLink(''), true);
  assert.equal(isNonJobLink('   '), true);
  assert.equal(isNonJobLink(null), true);
});

test('normalizeLinkText lowercases and strips decoration only at the edges', () => {
  assert.equal(normalizeLinkText('  „Seite  2“ › '), 'seite 2');
  assert.equal(normalizeLinkText('C++ Entwickler (m/w/d)'), 'c++ entwickler (m/w/d)');
});
