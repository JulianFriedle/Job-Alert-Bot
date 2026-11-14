// A job the Personio feed brings back can carry another URL than the same
// posting saved from the page; it is matched by source and title (#41).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jobbot-alias-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../src/database.js');

test('a live job of the same source and title is found; other sources, titles and expired rows are not', () => {
  db.saveJob('default', { id: 'page-1', title: 'Konstrukteur (m/w/d)', company: 'A', url: 'https://a.jobs.personio.de/job/1?language=de', location: '', description: '', source: 'APworks' });
  db.saveJob('other', { id: 'page-1', title: 'Konstrukteur (m/w/d)', company: 'A', url: 'https://a.jobs.personio.de/job/1?language=de', location: '', description: '', source: 'APworks' });
  assert.deepEqual(db.findJobIdsBySourceTitle('default', 'APworks', 'Konstrukteur (m/w/d)'), ['page-1']);
  assert.deepEqual(db.findJobIdsBySourceTitle('default', 'Andere Quelle', 'Konstrukteur (m/w/d)'), []);
  assert.deepEqual(db.findJobIdsBySourceTitle('default', 'APworks', 'Konstrukteur'), []);
  db.markExpired('default', 'page-1');
  assert.deepEqual(db.findJobIdsBySourceTitle('default', 'APworks', 'Konstrukteur (m/w/d)'), [], 'expired rows are not revived');
  assert.deepEqual(db.findJobIdsBySourceTitle('other', 'APworks', 'Konstrukteur (m/w/d)'), ['page-1'], 'per client');
});

test('a title listed for several offices returns every live row', () => {
  for (const [id, loc] of [['ws-muc', 'München'], ['ws-ber', 'Berlin']]) {
    db.saveJob('default', { id, title: 'Werkstudent (m/w/d)', company: 'A', url: `https://a.jobs.personio.de/job/${id}`, location: loc, description: '', source: 'APworks' });
  }
  assert.deepEqual(db.findJobIdsBySourceTitle('default', 'APworks', 'Werkstudent (m/w/d)').sort(), ['ws-ber', 'ws-muc']);
});
