// Identity of a built bookmarklet. A bookmarklet lives inside a URL the user
// saved once, so "is this the current one?" is a question the panel has to be
// able to answer later, without contacting this project.
//
// `VERSION` tracks the release; `BUILD` is stamped in by `scripts/build-site.mjs`
// so two builds of the same release can still be told apart. Source runs fall
// back to a placeholder rather than failing the bundle in tests.
export const BOOKMARKLET_VERSION = '1.0.1';
// `esbuild.define` substitutes the bare identifier, so a direct reference is the
// only form it can replace; the `typeof` guard keeps the module loadable as
// plain source (tests read it without ever running a build).
export const BOOKMARKLET_BUILD = typeof __BOOKMARKLET_BUILD__ !== 'undefined' ? __BOOKMARKLET_BUILD__ : 'source';

/** One line safe to paste into an issue: "v1.0.1 (2026-09-18)". */
export function bookmarkletStamp(build = BOOKMARKLET_BUILD) {
  return `v${BOOKMARKLET_VERSION} (${build})`;
}
