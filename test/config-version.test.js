// A stale GUI window must not silently overwrite newer saved data (#32).
import test from 'node:test';
import assert from 'node:assert/strict';

import { versionOf, isStale, CONFLICT_ERROR } from '../src/config-version.js';

test('the version follows the content, not the object identity', () => {
  const a = versionOf({ sources: [{ name: 'A', url: 'https://a.example' }] });
  assert.equal(a, versionOf({ sources: [{ name: 'A', url: 'https://a.example' }] }));
  assert.notEqual(a, versionOf({ sources: [{ name: 'A', url: 'https://b.example' }] }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(versionOf(undefined), versionOf(null));
});

test('a save based on another version is stale; one without a version is not', () => {
  const v = versionOf([1, 2, 3]);
  assert.equal(isStale(v, v), false);
  assert.equal(isStale(versionOf([1, 2]), v), true);
  // Older callers (wizard, scripts) send none — accepted as before.
  assert.equal(isStale(undefined, v), false);
  assert.equal(isStale(null, v), false);
  assert.equal(isStale('', v), false);
  assert.match(CONFLICT_ERROR, /neu laden/);
});
