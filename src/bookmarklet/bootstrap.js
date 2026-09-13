// Builds the bookmarklet itself. The real-page feasibility gate disproved the
// remote-loader bootstrap, so the bookmarklet carries its whole runtime in the
// URL: `bundleSource` is the minified IIFE built from `main.js`, and nothing is
// fetched from GitHub Pages, a CDN or the course page's own origin.
export function createSelfContainedBookmarklet(bundleSource) {
  if (typeof bundleSource !== 'string' || !bundleSource.trim()) {
    throw new TypeError('bundleSource 必须是非空的打包源码字符串');
  }
  return 'javascript:' + bundleSource;
}
