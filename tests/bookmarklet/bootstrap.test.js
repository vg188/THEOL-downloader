import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelfContainedBookmarklet } from '../../src/bookmarklet/bootstrap.js';

// A stand-in for the minified `main.js` IIFE the build feeds in.
const BUNDLE = '(()=>{globalThis.__THEOL_DOWNLOADER_BOOKMARKLET_V1__={show(){}}})()';

test('the bookmarklet carries its own runtime instead of loading one', () => {
  const url = createSelfContainedBookmarklet(BUNDLE);
  assert.equal(url, 'javascript:' + BUNDLE);
  assert.ok(url.includes(BUNDLE), 'the bundle source survives verbatim');
  assert.doesNotMatch(url.slice('javascript:'.length), /^https?:/, 'no remote runtime URL is the entry point');
  assert.doesNotMatch(url, /document\.createElement\(['"]script['"]\)/, 'no script element is injected');
  assert.doesNotMatch(url, /\.src\s*=|fetch\(|XMLHttpRequest|sendBeacon/, 'the launcher requests nothing');
});

test('an empty or non-string bundle is a build error, never an empty bookmarklet', () => {
  for (const value of ['', '   ', '\n', undefined, null, 42, {}, [], () => BUNDLE]) {
    assert.throws(() => createSelfContainedBookmarklet(value), TypeError, `rejects ${String(value)}`);
  }
});
