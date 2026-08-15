// Teilergebnisse eines gestoppten Laufs: fetchDescriptions meldet jeden Job
// einzeln über onJob (damit der Scheduler ihn sofort speichern kann) und rührt
// nach einem Abbruch gar nichts mehr an.
import test from 'node:test';
import assert from 'node:assert/strict';

import { requestAbort, resetAbort } from '../src/run-control.js';
import { fetchDescriptions } from '../src/scraper.js';

test('fetchDescriptions holt nach einem Abbruch nichts mehr und meldet keinen Job', async (t) => {
  t.after(resetAbort);
  requestAbort();

  const seen = [];
  const jobs = [
    { id: 'a', title: 'A', url: 'https://example.invalid/a' },
    { id: 'b', title: 'B', url: 'https://example.invalid/b', platform: 'linkedin' },
  ];
  // Würde der Abbruch ignoriert, startete hier ein echter Browser und liefe ins
  // Netz — der Aufruf muss stattdessen sofort und ohne Fehler zurückkehren.
  await fetchDescriptions(jobs, { concurrency: 1, onJob: (j) => seen.push(j.id) });

  assert.deepEqual(seen, [], 'kein Job wird nach dem Abbruch noch abgerufen oder gemeldet');
  assert.equal(jobs[0].description, undefined, 'keine Beschreibung angefasst');
});

test('fetchDescriptions akzeptiert weiterhin die alte Zahl-Signatur', async (t) => {
  t.after(resetAbort);
  requestAbort();
  // scripts/refetch-descriptions.js ruft ohne Optionsobjekt auf — das darf nicht
  // als concurrency-Objekt missverstanden werden und muss durchlaufen.
  await fetchDescriptions([{ id: 'c', title: 'C', url: 'https://example.invalid/c' }], 2);
});
