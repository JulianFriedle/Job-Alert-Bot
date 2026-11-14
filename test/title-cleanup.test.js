// Career pages put dates, badges, locations and portal metadata into the same
// link as the title (#39). cleanJobTitle strips them and keeps real titles intact.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanJobTitle } from '../src/title-cleanup.js';

const title = (s) => cleanJobTitle(s).title;

test('the examples from #39 are cleaned', () => {
  assert.deepEqual(cleanJobTitle('30. September 2026Betreuer Lieferantenqualität'),
    { title: 'Betreuer Lieferantenqualität', location: '', postedDate: '30. September 2026' });
  assert.equal(title('12. August 2026Director Global Procurement'), 'Director Global Procurement');
  assert.equal(title('NeuTeamassistenz Vertrieb (m/w/d)'), 'Teamassistenz Vertrieb (m/w/d)');
  assert.deepEqual(
    cleanJobTitle('Senior Technical CoordinatorLocationUnited States of America | Etowah, TNPosted on09.11.2026'),
    { title: 'Senior Technical Coordinator', location: 'United States of America | Etowah, TN', postedDate: '09.11.2026' });
  assert.equal(title('Diehl Defence Betriebsbeauftragter für Gewässerschutz 13.11.2026 Sonstige Überlingen am Bodensee'),
    'Diehl Defence Betriebsbeauftragter für Gewässerschutz');
  assert.deepEqual(
    cleanJobTitle('Wissenschaftliche*r Mitarbeiter*in Einsatzorte: Karlsruhe, Campus Nord Unternehmen: KIT Arbeitszeiten: Vollzeit'),
    { title: 'Wissenschaftliche*r Mitarbeiter*in', location: 'Karlsruhe, Campus Nord', postedDate: '' });
});

test('more date and badge variants', () => {
  assert.equal(title('30.09.2026 – Projektingenieur Elektrotechnik'), 'Projektingenieur Elektrotechnik');
  assert.equal(title('2026-09-30 Projektingenieur Elektrotechnik'), 'Projektingenieur Elektrotechnik');
  assert.equal(title('September 30, 2026 Project Engineer'), 'Project Engineer');
  assert.equal(title('Neu: Projektleiter Bau (m/w/d)'), 'Projektleiter Bau (m/w/d)');
  assert.equal(title('[Neu] Projektleiter Bau'), 'Projektleiter Bau');
  assert.equal(title('Neu Teamassistenz Vertrieb (m/w/d)'), 'Teamassistenz Vertrieb (m/w/d)');
  assert.equal(title('NEW Senior Data Engineer'), 'Senior Data Engineer');
  assert.equal(title('NEU30.09.2026 Projektleiter Bau'), 'Projektleiter Bau');
  assert.equal(title('Software Engineer Posted on 01.10.2026'), 'Software Engineer');
  assert.equal(title('Konstrukteur (m/w/d) Standort: Stuttgart'), 'Konstrukteur (m/w/d)');
  assert.equal(cleanJobTitle('Konstrukteur (m/w/d) Standort: Stuttgart').location, 'Stuttgart');
});

test('real titles stay exactly as they are', () => {
  for (const t of [
    'Neubau-Projektleiter (m/w/d)',
    'Neukundenberater Außendienst',
    'Newsroom Editor',
    'New Business Development Manager',
    'Neu-Ulm Filialleitung (m/w/d)',
    'Location Manager (m/w/d)',
    'Senior Location Manager Film',
    'Werkstudent ab 01.03.2027 im Controlling',
    'Elternzeitvertretung bis 31.12.2027 – Sachbearbeitung',
    'Ingenieur: Schwerpunkt Elektrotechnik',
    'SolidWorks Konstrukteur',
    'Referent Unternehmensentwicklung (m/w/d)',
    'Standortleiter Logistik',
    'Wissenschaftliche*r Mitarbeiter*in Optik',
    'C++ Entwickler (m/w/d)',
    '2nd Level Support (m/w/d)',
    '3D-Konstrukteur Sondermaschinenbau',
  ]) assert.equal(title(t), t, t);
});

test('a cleanup that would leave less than two words keeps the original', () => {
  assert.equal(title('30. September 2026Controller'), '30. September 2026Controller');
  assert.equal(title('NeuController'), 'NeuController');
});

test('total for odd input', () => {
  assert.deepEqual(cleanJobTitle(null), { title: '', location: '', postedDate: '' });
  assert.equal(title('   Senior    Engineer  '), 'Senior Engineer');
});
