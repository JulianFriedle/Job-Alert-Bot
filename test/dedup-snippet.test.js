// Smaller findings from the review in #17 (#21): a posting found by two sources
// is processed once, and Indeed's search snippet is used when it is a real text.
import test from 'node:test';
import assert from 'node:assert/strict';

const { uniqueJobsById } = await import('../src/scraper.js');
const { snippetAsDescription } = await import('../src/scrapers/indeed.js');

test('a posting reached from two sources is kept once, first copy wins', () => {
  const jobs = [
    { id: 'a', source: 'Konzern' }, { id: 'b', source: 'Konzern' },
    { id: 'a', source: 'Sparte' }, { id: 'c', source: 'Sparte' },
  ];
  const { unique, dropped } = uniqueJobsById(jobs);
  assert.deepEqual(unique.map(j => `${j.id}:${j.source}`), ['a:Konzern', 'b:Konzern', 'c:Sparte']);
  assert.deepEqual(dropped.map(j => `${j.id}:${j.source}`), ['a:Sparte']);
});

test('Indeed: a long snippet becomes the description, a teaser does not', () => {
  const saved = process.env.MIN_DESCRIPTION_CHARS;
  try {
    delete process.env.MIN_DESCRIPTION_CHARS;
    const long = 'Wir suchen dich für spannende Projekte im Maschinenbau. '.repeat(8);
    assert.equal(snippetAsDescription(long), long.slice(0, 4000));
    assert.equal(snippetAsDescription('Toller Job in Stuttgart'), '');
    assert.equal(snippetAsDescription(''), '');
    assert.equal(snippetAsDescription(undefined), '');
    // Turning the floor off must not let every teaser replace the posting.
    process.env.MIN_DESCRIPTION_CHARS = '0';
    assert.equal(snippetAsDescription('Toller Job in Stuttgart'), '');
    // A higher configured floor is respected.
    process.env.MIN_DESCRIPTION_CHARS = '1000';
    assert.equal(snippetAsDescription(long), '');
  } finally {
    if (saved === undefined) delete process.env.MIN_DESCRIPTION_CHARS; else process.env.MIN_DESCRIPTION_CHARS = saved;
  }
});
