import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnJobUrlPattern } from '../src/job-url-pattern.js';

const SW = 'https://www.stellenwerk.de/stuttgart/';
const stellenwerk = [
  { href: `${SW}events`, text: 'Veranstaltungen' },
  { href: `${SW}werkstudent-marketing-content-und-design-mwd-261113-279979`, text: 'Werkstudent Marketing Content & Design (m/w/d) | ca. 12 - 15 Std.' },
  { href: `${SW}studentischer-ferienjob-im-lager-261113-279990`, text: 'Studentischer Ferienjob im Lager/Versand (m/w/d)' },
  { href: `${SW}fully-funded-phd-positions-in-stem-261030-279226`, text: 'Fully funded PhD positions in STEM' },
];

test('learns Stellenwerk postings from two gender-marked titles', () => {
  const re = new RegExp(learnJobUrlPattern(stellenwerk));
  // Matches the marked postings and the unmarked one of the same shape …
  assert.ok(re.test(stellenwerk[1].href));
  assert.ok(re.test(stellenwerk[3].href));
  // … but not navigation.
  assert.equal(re.test(`${SW}events`), false);
  assert.equal(re.test(`${SW}karriereservice`), false);
  assert.equal(re.test('https://other.example/stuttgart/x-261113-279979'), false);
});

test('ID-first slugs (Liebherr) and trailing slashes / queries', () => {
  const base = 'https://www.liebherr.com/de-de/j/karriere/offene-stellen/';
  const re = new RegExp(learnJobUrlPattern([
    { href: `${base}85537-de-3364214`, text: 'Monteur (m/w/d)' },
    { href: `${base}85545-de-3364214/`, text: 'Einkäufer (w/m/d)' },
  ]));
  assert.ok(re.test(`${base}99999-de-3364214?ref=list`));
  assert.equal(re.test(`${base}`), false);
});

test('one marked link, or marked links without a posting ID, teach nothing', () => {
  assert.equal(learnJobUrlPattern([{ href: `${SW}x-261113-279979`, text: 'Werkstudent (m/w/d)' }]), null);
  assert.equal(learnJobUrlPattern([
    { href: 'https://x.de/karriere/werkstudent', text: 'Werkstudent (m/w/d)' },
    { href: 'https://x.de/karriere/praktikum', text: 'Praktikum (m/w/d)' },
  ]), null);
  assert.equal(learnJobUrlPattern([]), null);
  assert.equal(learnJobUrlPattern(), null);
});
