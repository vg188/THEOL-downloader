# Popup Sizing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Restore the already-approved popup UI so the native Chrome action popup is readable and the download footer remains visible.

**Architecture:** Keep the existing HTML, view, scanner, and queue unchanged. Give the root element an intrinsic 440 × 600 CSS-pixel size so Chrome's popup autosizing cannot depend exclusively on its current viewport. Constrain the body to the available viewport and keep only the file/history area scrollable.

**Tech Stack:** Manifest V3, native HTML/CSS/JavaScript; Node.js test runner, Playwright Core and installed desktop Chrome for regression testing.

## Global Constraints

- Implements the previously approved design in docs/superpowers/specs/2026-09-11-buct-course-downloader-design.md; no new product features or redesign.
- Node.js >=22; minimum Chrome 120 remains unchanged.
- Runtime permissions remain scripting, downloads, storage; host remains https://course.buct.edu.cn/*.
- No authenticated browser profile, credentials, real course downloads, or external requests in layout tests.
- Debug screenshots/profiles stay under the ignored output/playwright/ directory or isolated temporary directories; release remains the 10-file allowlist.
- Work is executed locally in this task; no subagents or Git push.

---

### Task 1: Reproduce and test the native popup

**Files:** Create tests/browser/popup-layout.test.js and tests/browser/helpers/native-popup.js; modify package.json and package-lock.json.

**Interfaces:** Use buildExtension() to create the release layout; load it with Extensions.loadUnpacked; open it with chrome.action.openPopup(). Inspect that native target through a CDP session, not a normal tab given a fixed viewport.

- [x] Run the minimized reproduction twice: npx --package @playwright/cli playwright-cli -s=popup-sizing run-code --filename=output/playwright/popup-size-repro.js. Both fail with native width 55px.
- [x] Test the leading hypothesis by removing only the body width cap, then setting the root width; confirm stylesheet loaded, zoom 1 and transform none.
- [x] Add a reproducible browser test with this exact assertion before changing CSS:

~~~js
assert.equal(metrics.width, 440, 'native popup must not collapse to a narrow strip');
assert.ok(metrics.footer.bottom <= metrics.height + 1, 'download footer must fit');
assert.ok(metrics.download.right <= metrics.width + 1, 'download button must fit');
~~~

- [x] Run npm run test:browser and record the pre-fix failure plus screenshot.

### Task 2: Repair root sizing and verify content

**Files:** Modify public/popup.css; test tests/browser/popup-layout.test.js.

**Interfaces:** Existing .app/.panel/.list-scroll flex layout, #scan-button, #download-button, and #history-tab selectors are unchanged.

- [x] Anchor html width and height to 440px and 600px; hide root overflow. Retain the body width cap and add max-height: 100vh so the inner application fits browser-imposed bounds.
- [x] Run npm run test:browser at normal and reduced browser heights, checking native popup geometry and footer, scrolling the actual fixture file list and opening download history without submitting downloads.
- [x] Verify the old 360px preview remains usable, and verify a non-default device scale.
- [x] Run npm test and git diff --check. Remove diagnostic overrides and keep only the reusable regression test.

### Task 3: Deliver a reloadable patch

**Files:** Modify public/manifest.json, package.json, package-lock.json, README.md, docs/verification.md; update representative docs/images screenshot(s).

**Interfaces:** Same dist/extension directory and dist/buct-course-downloader.zip paths; Chrome reload is required for an already-loaded unpacked extension.

- [x] Bump the patch version to 1.0.1 and document the safe reload steps (wait for current queued jobs first).
- [x] Run npm run build and npm run package; verify ZIP entries and byte equality against the build, record SHA-256.
- [x] Clearly separate current simulated native-popup layout verification from the previous real PPT download verification; no new real-file download claims.
- [x] Provide the updated directory/ZIP and concise reload instructions. Do not reload the user's active browser or interrupt their downloads.
