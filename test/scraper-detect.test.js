import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockPageReason, isAzureSearchApi } from '../src/scraper.js';

test('blockPageReason: Akamai "Access Denied" page is a bot wall (Heidenhain)', () => {
  const reason = blockPageReason({
    status: 403,
    title: 'Access Denied',
    text: 'Access Denied You don\'t have permission to access "http://www.heidenhain.de/karriere/" on this server.',
  });
  assert.match(reason, /Zugriff verweigert/);
  assert.match(reason, /HTTP 403/);
});

test('blockPageReason: challenge titles and refusal status codes', () => {
  assert.ok(blockPageReason({ title: 'Just a moment...' }));
  assert.ok(blockPageReason({ title: 'Attention Required! | Cloudflare' }));
  assert.equal(blockPageReason({ status: 429, title: 'Karriere' }), 'Zugriff verweigert (HTTP 429)');
});

test('blockPageReason: an ordinary empty career page is not blocked', () => {
  assert.equal(blockPageReason({ status: 200, title: 'Karriere – Rosswag Engineering', text: 'Initiativbewerbungen …' }), null);
  assert.equal(blockPageReason({ status: 404, title: 'Seite nicht gefunden' }), null);
  assert.equal(blockPageReason(), null);
});

test('isAzureSearchApi: old Azure host and the j2w API that replaced it (Schaeffler)', () => {
  assert.ok(isAzureSearchApi('https://xyz.search.windows.net/indexes/jobs/docs/search?api-version=2020-06-30'));
  assert.ok(isAzureSearchApi('https://production.api.recruiting-solutions.org/search'));
  assert.equal(isAzureSearchApi('https://production.api.recruiting-solutions.org/sui/picklists'), false);
  assert.equal(isAzureSearchApi('https://jobs.example.com/search?q=windows.net'), false);
});
