// Personio career sites publish their positions as XML (#41). Parsed offline
// from a sample in the feed's format — no request to Personio.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isPersonioUrl, feedUrl, parsePersonioXml, fetchPersonioJobs } from '../src/scrapers/personio.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>1234567</id>
    <subcompany>APworks GmbH</subcompany>
    <office>Taufkirchen</office>
    <additionalOffices><office>München</office><office>Taufkirchen</office></additionalOffices>
    <department>Engineering</department>
    <name>Konstrukteur Additive Fertigung (m/w/d)</name>
    <jobDescriptions>
      <jobDescription>
        <name>Deine Aufgaben</name>
        <value><![CDATA[<ul><li>Konstruktion von Bauteilen f&uuml;r den 3D-Druck</li><li>Abstimmung mit der Fertigung</li></ul>]]></value>
      </jobDescription>
      <jobDescription>
        <name>Dein Profil</name>
        <value><![CDATA[<p>Studium Maschinenbau &amp; Erfahrung mit <b>Siemens NX</b></p>]]></value>
      </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-11-01T10:00:00+00:00</createdAt>
  </position>
  <position>
    <id>7654321</id>
    <office>Remote</office>
    <name>Werkstudent Qualit&#228;tssicherung</name>
    <jobDescriptions></jobDescriptions>
  </position>
  <position><id></id><name>Ohne ID</name></position>
</workzag-jobs>`;

test('recognizes Personio career sites and their feed URL', () => {
  assert.equal(isPersonioUrl('https://apworks.jobs.personio.de'), true);
  assert.equal(isPersonioUrl('https://acme.jobs.personio.com/?language=de'), true);
  assert.equal(isPersonioUrl('https://www.personio.de/karriere'), false);
  assert.equal(isPersonioUrl('https://evil.example/jobs.personio.de'), false);
  assert.equal(isPersonioUrl('kein url'), false);
  assert.equal(feedUrl('https://apworks.jobs.personio.de/?language=de#x'), 'https://apworks.jobs.personio.de/xml?language=de');
  assert.equal(feedUrl('https://apworks.jobs.personio.de/jobs'), 'https://apworks.jobs.personio.de/xml');
});

test('parses positions with title, URL, offices, company and full description', () => {
  const jobs = parsePersonioXml(SAMPLE, 'https://apworks.jobs.personio.de', 'APworks');
  assert.equal(jobs.length, 2, 'a position without id is skipped');
  const [a, b] = jobs;
  assert.equal(a.title, 'Konstrukteur Additive Fertigung (m/w/d)', 'the position name, not a section name');
  assert.equal(a.url, 'https://apworks.jobs.personio.de/job/1234567');
  assert.equal(a.location, 'Taufkirchen, München');
  assert.equal(a.company, 'APworks GmbH');
  assert.match(a.description, /^Deine Aufgaben\nKonstruktion von Bauteilen für den 3D-Druck\nAbstimmung mit der Fertigung/);
  assert.match(a.description, /Dein Profil\nStudium Maschinenbau & Erfahrung mit Siemens NX/);
  assert.doesNotMatch(a.description, /<|&amp;/);
  assert.equal(b.title, 'Werkstudent Qualitätssicherung');
  assert.equal(b.company, 'APworks', 'falls back to the source name');
  assert.equal(b.description, '');
  assert.deepEqual(parsePersonioXml('<workzag-jobs></workzag-jobs>', 'https://x.jobs.personio.de'), []);
});

test('fetch: reads /xml, rejects HTTP errors and non-Personio answers', async () => {
  const calls = [];
  const ok = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => SAMPLE }; };
  const jobs = await fetchPersonioJobs({ name: 'APworks', url: 'https://apworks.jobs.personio.de' }, { fetchImpl: ok });
  assert.deepEqual(calls, ['https://apworks.jobs.personio.de/xml']);
  assert.equal(jobs.length, 2);
  await assert.rejects(fetchPersonioJobs({ url: 'https://x.jobs.personio.de' },
    { fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) }), /HTTP 404/);
  await assert.rejects(fetchPersonioJobs({ url: 'https://x.jobs.personio.de' },
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>Login</html>' }) }), /unerwartetes Format/);
});

test('escaped < and > in a description survive (decoded once, after the tags are gone)', () => {
  const xml = `<workzag-jobs><position><id>1</id><name>Ingenieur Test</name><jobDescriptions><jobDescription>
    <name>Profil</name><value><![CDATA[<p>Erfahrung &lt; 3 Jahre, Gehalt &gt; 50k, C++ &lt;-&gt; Python, &amp;lt;literal&amp;gt;</p>]]></value>
  </jobDescription></jobDescriptions></position></workzag-jobs>`;
  const [job] = parsePersonioXml(xml, 'https://x.jobs.personio.de');
  assert.equal(job.description, 'Profil\nErfahrung < 3 Jahre, Gehalt > 50k, C++ <-> Python, &lt;literal&gt;');
  assert.equal(job.viaFeed, true);
});

test('a ?language= on the source URL is passed to the feed', () => {
  assert.equal(feedUrl('https://x.jobs.personio.de/?language=en'), 'https://x.jobs.personio.de/xml?language=en');
});

// ── Page / feed control flow ─────────────────────────────────────────────────
const { scrapeCareerSource } = await import('../src/scraper.js');
const page = (jobs, extra = {}) => async () => ({ jobs, duplicates: 0, siteTotal: null, ...extra });
const feed = (jobs) => async () => ({ jobs, duplicates: 0, siteTotal: jobs.length });
const boom = (msg) => async () => { throw new Error(msg); };
const P = { name: 'APworks', url: 'https://apworks.jobs.personio.de' };

test('control flow: page first, feed when the page fails or finds nothing', async () => {
  const one = [{ id: 'p1' }];
  const viaFeed = [{ id: 'f1' }];
  assert.deepEqual((await scrapeCareerSource(P, { scrapePage: page(one), readFeed: feed(viaFeed) })).jobs, one, 'a working page wins');
  assert.deepEqual((await scrapeCareerSource(P, { scrapePage: boom('Timeout'), readFeed: feed(viaFeed) })).jobs, viaFeed, 'page throws → feed');
  const fromEmpty = await scrapeCareerSource(P, { scrapePage: page([], { blocked: true, error: 'x' }), readFeed: feed(viaFeed) });
  assert.deepEqual(fromEmpty.jobs, viaFeed, 'page empty → feed');
  assert.equal(fromEmpty.blocked, undefined, 'a complete feed result is not incomplete');
  const bothEmpty = await scrapeCareerSource(P, { scrapePage: page([], { blocked: true }), readFeed: feed([]) });
  assert.equal(bothEmpty.blocked, true, 'an empty feed keeps the page result');
  await assert.rejects(scrapeCareerSource(P, { scrapePage: boom('Timeout 15000ms'), readFeed: boom('HTTP 404') }), /Timeout 15000ms/,
    'both fail → the page error, not the feed one');
  assert.deepEqual((await scrapeCareerSource({ ...P, personioFeed: true }, { scrapePage: page(one), readFeed: feed(viaFeed) })).jobs,
    viaFeed, 'personioFeed: true → feed first');
  assert.deepEqual((await scrapeCareerSource({ ...P, personioFeed: true }, { scrapePage: page(one), readFeed: boom('HTTP 500') })).jobs,
    one, '… and the page as fallback');
  assert.deepEqual((await scrapeCareerSource({ name: 'X', url: 'https://x.example/jobs' }, { scrapePage: page(one), readFeed: boom('never') })).jobs,
    one, 'not Personio → page only');
});
