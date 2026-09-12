# THEOL Website and Bookmarklet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a GitHub Pages website that offers a draggable THEOL bookmarklet and an unlisted Chrome Web Store installation path, with local ZIP downloads up to 500 MiB and confirmed direct downloads above that limit.

**Architecture:** Keep the Manifest V3 extension intact and extract only browser-neutral parsing, validation, and filename behavior for reuse. A tiny version-pinned bookmarklet bootstrap loads a self-contained page-side bundle from GitHub Pages, mounts an isolated Shadow DOM panel, and delegates scan/download/archive work to focused modules; the static website generates the draggable URL from the same bootstrap source. A mandatory real-THEOL feasibility probe gates the remote-loader architecture before full implementation, while GitHub Actions publishes only `dist/site`.

**Tech Stack:** Node.js >=22, native HTML/CSS/JavaScript, esbuild 0.25.12, jsdom 26.1.0, Playwright Core 1.63.0 with desktop Chrome, an exact-pinned ZIP library selected after package review, GitHub Actions, GitHub Pages, Chrome Web Store Manifest V3.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-09-12-theol-website-bookmarklet-design.md`.
- Site URL: `https://vg188.github.io/THEOL-downloader/`; source repository: public `vg188/THEOL-downloader`.
- Bookmarklet runtime host: exact HTTPS host `course.buct.edu.cn`; current loaded directory only; PDF, PPT, and PPTX only.
- ZIP threshold: `500 * 1024 * 1024` bytes; any unknown size uses confirmed direct-download mode.
- An actual-size threshold breach destroys the unpublished archive and returns to confirmation; it never starts direct downloads automatically.
- Course files, filenames, page contents, cookies, credentials, and account data never leave the school origin; no analytics, ads, telemetry, error SDK, runtime CDN, backend, or remote file relay.
- Chrome extension installation is never silent: the website links to an unlisted Chrome Web Store detail page and Chrome performs permission confirmation.
- Until a real store URL is configured, the full-version control reads `Chrome 商店审核中` and is non-navigating.
- Existing extension permissions remain exactly `scripting`, `downloads`, `storage`, and `https://course.buct.edu.cn/*`; minimum Chrome stays 120.
- Existing extension release remains the ten-file allowlist; site assets are a separate `dist/site` artifact.
- Runtime dependencies are exact-pinned, license-recorded, bundled locally, and never fetched from third-party CDNs.
- Automated tests use synthetic local fixtures only; they make no school requests and need no login.
- Real THEOL testing is user-triggered, metadata-only during the probe, and later limited to a few files the user is authorized to access.
- Do not create/push the GitHub repository, enable Pages, or submit Chrome Web Store state until the corresponding remote-mutation task and its preconditions are reached.
- Do not overwrite, discard, or silently fold the current uncommitted popup-sizing changes; stage and commit only the files named by each task.

---

### Task 1: Commit the approved specification and establish a clean baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-theol-website-bookmarklet-design.md`
- Existing related work to preserve: `public/popup.css`, `public/manifest.json`, `tests/browser/popup-layout.test.js`, `tests/browser/helpers/native-popup.js`, `README.md`, `docs/verification.md`, `docs/images/popup-440.png`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: the approved design and current version 1.0.1 popup fix.
- Produces: an approved spec marker and a tested repository baseline on which website work can be reviewed independently.

- [ ] **Step 1: Mark the written specification approved**

Change only the status line:

```markdown
**状态：** 已批准  
```

- [ ] **Step 2: Run the existing baseline validation**

```powershell
npm test
npm run test:browser
npm run build
npm run package
git diff --check
```

Expected: 69 unit tests and 4 native popup tests pass; `dist/extension` and the ten-entry extension ZIP build successfully.

- [ ] **Step 3: Review and commit the pre-existing popup fix without broad staging**

```powershell
git diff -- public/popup.css public/manifest.json package.json package-lock.json README.md docs/verification.md
git add public/popup.css public/manifest.json package.json package-lock.json README.md docs/verification.md docs/images/popup-440.png tests/browser/popup-layout.test.js tests/browser/helpers/native-popup.js docs/superpowers/plans/2026-09-11-popup-sizing-fix.md
git commit -m "fix: keep the native popup at its intended size"
```

Expected: review matches the completed 1.0.1 popup-sizing plan and includes no account data or browser profile.

- [ ] **Step 4: Commit the approved website/bookmarklet specification**

```powershell
git add docs/superpowers/specs/2026-09-12-theol-website-bookmarklet-design.md
git commit -m "docs: approve website and bookmarklet design"
git status --short
```

Expected: clean status before implementation starts.

---

### Task 2: Build a metadata-only feasibility probe

**Files:**
- Create: `probe/index.html`
- Create: `probe/probe.js`
- Create: `scripts/build-probe.mjs`
- Create: `tests/probe.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `buildProbe(): Promise<string>`, `dist/probe/bookmarklet.txt`, and `dist/probe/probe.js`.
- Result: `{ inline, remote, frame, metadata, worker, details }` rendered locally; no result upload.

- [ ] **Step 1: Write the failing build/privacy test**

Create `tests/probe.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildProbe } from '../scripts/build-probe.mjs';

test('probe emits a fixed-origin bookmarklet and no collection endpoint', async () => {
  const output = await buildProbe();
  const bookmarklet = await readFile(`${output}/bookmarklet.txt`, 'utf8');
  const runtime = await readFile(`${output}/probe.js`, 'utf8');
  assert.match(bookmarklet, /^javascript:/);
  assert.match(bookmarklet, /https:\/\/vg188\.github\.io\/THEOL-downloader\/probe\/probe\.js/);
  assert.doesNotMatch(bookmarklet + runtime, /sendBeacon|XMLHttpRequest|localStorage|sessionStorage/);
  assert.doesNotMatch(runtime, /download\.jsp/);
});
```

Also assert `probe/index.html` says it reads one preview metadata page and triggers no course-file download.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/probe.test.js
```

Expected: FAIL because `scripts/build-probe.mjs` is missing.

- [ ] **Step 3: Implement the safe fixed-origin probe**

`probe/probe.js` initializes:

```js
const result = { inline: true, remote: true, frame: false, metadata: false, worker: false, details: [] };
```

Walk only accessible same-origin frames, find the current list using existing pathname/query rules, fetch only the first canonical `download_preview.jsp` with `credentials:'include'` and `redirect:'manual'`, and abort after 64 KiB. Never request `download.jsp`, store values, or transmit results. Test a tiny Blob Worker, revoke its URL, and render all five booleans in a removable overlay.

`buildProbe()` copies HTML, bundles the probe, and emits this logical bootstrap:

```js
javascript:(()=>{if(location.protocol!=='https:'||location.hostname!=='course.buct.edu.cn'){alert('请在 THEOL 课程资源页运行此测试');return}const s=document.createElement('script');s.src='https://vg188.github.io/THEOL-downloader/probe/probe.js';s.onerror=()=>alert('远程测试脚本被页面策略或网络阻止');document.documentElement.append(s)})()
```

Add:

```json
"build:probe": "node scripts/build-probe.mjs",
"test:probe": "node --test tests/probe.test.js"
```

- [ ] **Step 4: Run GREEN and inspect output**

```powershell
npm run test:probe
npm run build:probe
Get-Content dist/probe/bookmarklet.txt
Select-String -Path dist/probe/probe.js -Pattern 'download.jsp|sendBeacon|XMLHttpRequest'
```

Expected: tests pass; the last command has no matches.

- [ ] **Step 5: Commit the probe**

```powershell
git add probe/index.html probe/probe.js scripts/build-probe.mjs tests/probe.test.js package.json package-lock.json
git commit -m "test: add a safe THEOL bookmarklet feasibility probe"
```

---

### Task 3: Publish and execute the feasibility gate

**Files:**
- Create after test: `docs/bookmarklet-feasibility.md`
- Modify only after success: the approved specification

**Interfaces:**
- Consumes `dist/probe`.
- Produces `GO_REMOTE_LOADER` only if inline, remote, frame, and metadata are true; Worker false selects `MAIN_THREAD_ARCHIVE`.

- [ ] **Step 1: Create or inspect the public repository and publish only the probe branch**

```powershell
gh auth switch --user vg188
gh auth status
gh repo view vg188/THEOL-downloader
```

If absent, create it without overwriting history:

```powershell
gh repo create vg188/THEOL-downloader --public --source . --remote origin --description "THEOL courseware downloader extension and bookmarklet"
git checkout -b codex/bookmarklet-probe
git push -u origin codex/bookmarklet-probe
```

If it exists, inspect and add its remote instead. Publish `dist/probe` through a temporary Pages workflow/branch and verify HTTP 200. Never expose local tokens.

- [ ] **Step 2: User executes the real-page probe**

Give the user the hosted probe page. Ask for only five booleans from an authorized current resource directory—never HTML, IDs, course names, cookies, response bodies, or credentials.

Expected checkpoint: user reports inline, remote, frame, metadata, and worker.

- [ ] **Step 3: Apply the gate**

On required success, record:

```markdown
Decision: GO_REMOTE_LOADER
Archive execution: WORKER_ARCHIVE
```

Use `MAIN_THREAD_ARCHIVE` only when Worker is false. If remote is false, stop before Task 4, measure a self-contained proof bundle, and return to brainstorming for approval of a self-contained/DevTools/userscript fallback. Do not call the bookmarklet delivered.

- [ ] **Step 4: Record non-sensitive evidence and commit**

`docs/bookmarklet-feasibility.md` records browser version, date, booleans, decision, and whether it was a current resource directory—no names, IDs, response content, or authentication data. Change the spec suffix to `已批准；可行性门禁通过` only on GO.

```powershell
git add docs/bookmarklet-feasibility.md docs/superpowers/specs/2026-09-12-theol-website-bookmarklet-design.md
git commit -m "docs: record bookmarklet feasibility decision"
```

---

### Task 4: Extract shared size and signature primitives

**Files:**
- Create: `src/platform/file-content.js`
- Modify: `src/platform/parse.js`
- Modify: `src/background/preflight.js`
- Modify: `tests/platform.test.js`
- Modify: `tests/preflight.test.js`

**Interfaces:**
- Produces `parseSize(text): number|null`, `hasFileSignature(bytes, extension): boolean`, and `readBodySample(response, {maxBytes, signal})`.
- `parsePreview()` adds `sizeBytes: number|null` and retains `sizeText`.

- [ ] **Step 1: Add failing boundaries**

```js
assert.equal(parseSize('500MB'), 500 * 1024 * 1024);
assert.equal(parseSize('1.5M'), Math.round(1.5 * 1024 * 1024));
assert.equal(parseSize('1024 字节'), 1024);
assert.equal(parseSize('大小未知'), null);
assert.equal(parsePreview(dom(preview('A.pdf', 56, '9.1M')), resource()).sizeBytes, Math.round(9.1 * 1024 * 1024));
```

Move current signature cases to test `hasFileSignature()` directly and through `preflight()`.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/platform.test.js tests/preflight.test.js
```

Expected: missing exports/properties fail.

- [ ] **Step 3: Implement browser-neutral primitives**

Accept B/字节, K/KB/KiB, M/MB/MiB, G/GB/GiB, T/TB/TiB with whitespace; return rounded safe bytes or null. Move private signature logic and bounded stream sampling to `file-content.js`; keep `preflight()` behavior unchanged.

- [ ] **Step 4: Run GREEN and regressions**

```powershell
node --test tests/platform.test.js tests/preflight.test.js
npm test
npm run test:browser
```

- [ ] **Step 5: Commit**

```powershell
git add src/platform/file-content.js src/platform/parse.js src/background/preflight.js tests/platform.test.js tests/preflight.test.js
git commit -m "refactor: share courseware size and signature checks"
```

---

### Task 5: Implement bookmarklet discovery and scanning

**Files:**
- Create: `src/bookmarklet/discovery.js`
- Create: `src/bookmarklet/scanner.js`
- Create: `tests/bookmarklet/discovery.test.js`
- Create: `tests/bookmarklet/scanner.test.js`

**Interfaces:**
- Produces `discoverDirectory(rootWindow): {context,directory}`.
- Produces `createBookmarkletScanner({fetcher,parseDocument,timeoutMs}): {scan(rootWindow,onProgress),cancel()}`.
- Scan shape: `{id,phase,context,files,failures,total,processed,skipped,message}`.

- [ ] **Step 1: Write failing discovery/scan tests**

```js
const found = discoverDirectory(topWindow);
assert.equal(found.directory.folderId, '34');
assert.equal(found.context.courseName, '电路与模拟电子技术');
assert.throws(() => discoverDirectory(nonSchoolWindow), error => error.code === 'UNSUPPORTED_PAGE');
assert.throws(() => discoverDirectory(twoDirectoriesWindow), error => error.code === 'AMBIGUOUS_DIRECTORY');
```

Also cover inaccessible frames.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/bookmarklet/discovery.test.js tests/bookmarklet/scanner.test.js
```

- [ ] **Step 3: Implement without extension APIs**

Walk top/accessibly same-origin child frames, require `schoolUrl`, match expected courseId, collect exactly one current directory, and preserve document/location keys. Wrap `scanResources` so a replacement scan cancels the old generation, late progress cannot mutate it, source order is retained, and each file is validated with courseName. Never call `chrome.*`.

- [ ] **Step 4: Validate races and network boundaries**

Cover zero resources, cancellation, replacement, GBK, unsupported skip, login/redirect, and require every fetch URL to be canonical `download_preview.jsp` on the school host.

```powershell
node --test tests/bookmarklet/discovery.test.js tests/bookmarklet/scanner.test.js
npm test
```

- [ ] **Step 5: Commit**

```powershell
git add src/bookmarklet/discovery.js src/bookmarklet/scanner.js tests/bookmarklet/discovery.test.js tests/bookmarklet/scanner.test.js
git commit -m "feat: scan the current THEOL directory from a bookmarklet"
```

---

### Task 6: Implement the 500 MiB planner and controller

**Files:**
- Create: `src/bookmarklet/download-plan.js`
- Create: `src/bookmarklet/controller.js`
- Create: `tests/bookmarklet/download-plan.test.js`
- Create: `tests/bookmarklet/controller.test.js`

**Interfaces:**
- Produces `ZIP_LIMIT_BYTES`, `planDownload(files)`, and `createBookmarkletController(dependencies)`.
- States: idle, scanning, ready, confirm-zip, confirm-direct, archiving, actual-size-overflow, direct-downloading, cancelled, done, error.
- Commands: scan, setQuery, setFormat, toggle, requestDownload, confirm, cancel, hide, show.

- [ ] **Step 1: Write exact threshold and side-effect tests**

```js
assert.equal(planDownload([{ sizeBytes: 500 * 1024 * 1024 }]).mode, 'zip');
assert.equal(planDownload([{ sizeBytes: 500 * 1024 * 1024 + 1 }]).reason, 'OVER_LIMIT');
assert.equal(planDownload([{ sizeBytes: null }]).reason, 'UNKNOWN_SIZE');
```

Assert `requestDownload()` has no archive/direct side effect and only `confirm()` invokes the selected dependency.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/bookmarklet/download-plan.test.js tests/bookmarklet/controller.test.js
```

- [ ] **Step 3: Implement the pure planner and serialized controller**

The controller owns `createSelection()`, immutable snapshots, exact confirmation data, one active task, and stale-selection reset. `hide()` never cancels active work.

- [ ] **Step 4: Test actual-size overflow and all transitions**

Mock archive throwing `ActualSizeLimitError`; require transition to actual-size-overflow with zero direct calls, then a new `confirm()` for direct mode. Test double click, cancel, rescan, and errors.

```powershell
node --test tests/bookmarklet/download-plan.test.js tests/bookmarklet/controller.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add src/bookmarklet/download-plan.js src/bookmarklet/controller.js tests/bookmarklet/download-plan.test.js tests/bookmarklet/controller.test.js
git commit -m "feat: gate bookmarklet downloads at 500 MiB"
```

---

### Task 7: Stream, validate, and archive files locally

**Files:**
- Create: `src/bookmarklet/fetch-file.js`
- Create: `src/bookmarklet/archive.js`
- Create: `src/bookmarklet/archive-worker.js`
- Create: `tests/bookmarklet/fetch-file.test.js`
- Create: `tests/bookmarklet/archive.test.js`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces `fetchCourseFile(file,{fetcher,signal,onChunk})`, `archiveFiles(files,options)`, and `ActualSizeLimitError`.
- Worker messages: start, entry, finish, abort; replies: progress, complete, error.

- [ ] **Step 1: Review and exact-pin the ZIP dependency**

```powershell
npm view fflate version license repository scripts
npm pack fflate@LATEST --dry-run
```

After verifying the official package, MIT license, files, and no install script, install the concrete observed version (replace `X.Y.Z` in the execution command with that output):

```powershell
npm install --save-exact fflate@X.Y.Z
```

Record version, license, source URL, and “ZIP Store worker, bundled; no runtime CDN” in `THIRD_PARTY_NOTICES.md`. Stop if metadata is unexpected.

- [ ] **Step 2: Write failing fetch/archive tests**

Cover canonical validation before fetch, credentials include, manual redirects, login/status, unsafe MIME, signature, response ID mismatch, cancellation, missing body, chunked data, ZIP exact bytes, duplicate names, mixed/all failure, and overflow cleanup.

- [ ] **Step 3: Run RED**

```powershell
node --test tests/bookmarklet/fetch-file.test.js tests/bookmarklet/archive.test.js
```

- [ ] **Step 4: Implement validated Store-mode ZIP**

Buffer only the signature sample, then forward chunks. Before retaining a chunk, enforce `actualBytes + chunk.byteLength <= limitBytes`. On breach abort readers, abort/terminate worker, release all references, and throw `ActualSizeLimitError` without a Blob. Use one ZIP algorithm and an in-process worker-protocol adapter if the gate chose main-thread mode. Generate deterministic duplicate names and UTF-8 `下载失败清单.txt` only for mixed success; reject all-failure runs.

- [ ] **Step 5: Run GREEN and regressions**

```powershell
node --test tests/bookmarklet/fetch-file.test.js tests/bookmarklet/archive.test.js
npm test
```

- [ ] **Step 6: Commit**

```powershell
git add src/bookmarklet/fetch-file.js src/bookmarklet/archive.js src/bookmarklet/archive-worker.js tests/bookmarklet/fetch-file.test.js tests/bookmarklet/archive.test.js package.json package-lock.json THIRD_PARTY_NOTICES.md
git commit -m "feat: archive selected courseware locally"
```

---

### Task 8: Implement confirmed sequential direct downloads

**Files:**
- Create: `src/bookmarklet/direct-download.js`
- Create: `tests/bookmarklet/direct-download.test.js`

**Interfaces:**
- Produces `downloadDirect(files,{document,signal,delayMs,onProgress}): Promise<{triggered,failed}>`.
- Triggered means requested, never completed.

- [ ] **Step 1: Write failing click/cleanup tests**

Use a fake document/timer. Each valid file gets one hidden anchor with canonical href, safe download name, `rel='noopener'`, one click, and removal. Assert serial order, delays, cancellation, validation-before-first-click, and progress `已触发 n/m`.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/bookmarklet/direct-download.test.js
```

- [ ] **Step 3: Implement serial triggering**

Validate the whole list before any click. Do not fetch bodies, open popups, use hidden frames, or claim completion. Show: “Chrome 可能要求允许此网站下载多个文件；‘已触发’不代表文件已保存完成。”

- [ ] **Step 4: Run integration GREEN**

```powershell
node --test tests/bookmarklet/direct-download.test.js tests/bookmarklet/controller.test.js
```

Expected: no anchor click before second confirmation.

- [ ] **Step 5: Commit**

```powershell
git add src/bookmarklet/direct-download.js tests/bookmarklet/direct-download.test.js
git commit -m "feat: confirm large bookmarklet downloads before triggering"
```

---

### Task 9: Build the Shadow DOM panel and bootstrap

**Files:**
- Create: `src/bookmarklet/template.js`, `panel.css`, `view.js`, `main.js`, `bootstrap.js`
- Create: `tests/bookmarklet/view.test.js`, `bootstrap.test.js`

**Interfaces:**
- Produces `mountBookmarklet({window,controller})` and global `__THEOL_DOWNLOADER_BOOKMARKLET_V1__`.
- Produces `createBootstrap({runtimeUrl,timeoutMs}): string` with fixed runtime URL `https://vg188.github.io/THEOL-downloader/bookmarklet/v1/bookmarklet.js`.

- [ ] **Step 1: Write failing UI/bootstrap tests**

Assert one open Shadow root, textContent-only dynamic values, initial unchecked state, filtering/selection, all confirmation states, hide/show, destroy, exact host validation, fixed URL, duplicate invocation calling show, and timeout/error alerts.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/bookmarklet/view.test.js tests/bookmarklet/bootstrap.test.js
```

- [ ] **Step 3: Implement semantic isolated UI**

Match the extension’s white/dark/red language with visible focus, native checkboxes, file metadata, progress, cancel/hide/close, no page CSS import, and reduced motion. Confirmation copy must distinguish ZIP, direct, and actual-overflow states exactly as the spec.

- [ ] **Step 4: Wire runtime lifecycle**

Create one in-memory controller per page; start no scan/download automatically. Second invocation calls show. Destroy aborts readers/workers, removes host, and clears the singleton.

- [ ] **Step 5: Run GREEN**

```powershell
node --test tests/bookmarklet/view.test.js tests/bookmarklet/bootstrap.test.js tests/bookmarklet/controller.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add src/bookmarklet/template.js src/bookmarklet/panel.css src/bookmarklet/view.js src/bookmarklet/main.js src/bookmarklet/bootstrap.js tests/bookmarklet/view.test.js tests/bookmarklet/bootstrap.test.js
git commit -m "feat: add the bookmarklet courseware panel"
```

---

### Task 10: Build the static website and privacy page

**Files:**
- Create: `site/index.html`, `privacy.html`, `site.css`, `site.js`, `config.json`
- Create: `scripts/build-site.mjs`, `tests/site.test.js`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Config: `{"basePath":"/THEOL-downloader/","bookmarkletVersion":"v1","chromeWebStoreUrl":null,"releaseVersion":"1.0.1"}`.
- Produces `buildSite(): Promise<string>` and `dist/site` with pages, local assets, versioned runtime, and archive worker.

- [ ] **Step 1: Write failing artifact tests**

```js
assert.equal(document.documentElement.lang, 'zh-CN');
assert.match(document.querySelector('#bookmarklet-install').href, /^javascript:/);
assert.equal(document.querySelector('#chrome-install').getAttribute('aria-disabled'), 'true');
assert.match(document.querySelector('#chrome-install').textContent, /审核中/);
assert.ok(document.querySelector('a[href*="github.com/vg188/THEOL-downloader"]'));
```

Assert copy covers 500 MB, unknown sizes, second confirmation, page-open requirement, no upload, non-official status, and “已触发” vs “已完成”; all local URLs honor the base path.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/site.test.js
```

- [ ] **Step 3: Implement the approved static page**

Build hero, two install cards, comparison, three steps, 500 MB behavior, privacy, FAQ, footer, real draggable anchor, copy fallback, desktop/touch guidance, readable no-JS content, responsive 360/768/desktop CSS, focus, contrast, and reduced motion.

- [ ] **Step 4: Implement safe config/build**

Validate non-null store URLs as `https://chromewebstore.google.com/detail/<slug>/<32-letter-id>`. Null renders a disabled non-link; valid renders “添加至 Chrome”. Bundle all runtime code locally; reject remote imports and output containing maps, fixtures, env files, or credentials.

Add:

```json
"build:site": "node scripts/build-site.mjs",
"test:bookmarklet": "node --test tests/bookmarklet/*.test.js",
"test:site": "node --test tests/site.test.js"
```

- [ ] **Step 5: Run GREEN and inspect**

```powershell
npm run test:site
npm run build:site
Get-ChildItem dist/site -Recurse -File
```

Tests exercise pending and valid store states in memory without rewriting config.

- [ ] **Step 6: Commit**

```powershell
git add site/index.html site/privacy.html site/site.css site/site.js site/config.json scripts/build-site.mjs tests/site.test.js package.json package-lock.json
git commit -m "feat: add the dual-install project website"
```

---

### Task 11: Add browser-level website/bookmarklet regression

**Files:**
- Create: `tests/browser/site-bookmarklet.test.js`
- Create: `tests/browser/helpers/bookmarklet-fixture.js`
- Modify: `package.json`

**Interfaces:**
- Consumes `buildSite()` and synthetic nested THEOL fixtures.
- Produces ignored screenshots in `output/playwright/site/`.

- [ ] **Step 1: Test website at 360, 768, and 1280 px**

Assert no horizontal overflow, keyboard-visible controls, pending store state, draggable URL, copy feedback, mobile guidance, privacy link, and no console errors.

- [ ] **Step 2: Test built bookmarklet end-to-end**

Route fixed GitHub Pages URLs to local built assets. Assert singleton Shadow host, nested scan, no initial selection/download, small ZIP exact bytes, mixed-failure manifest, and no non-school content request.

- [ ] **Step 3: Test threshold/direct/actual-overflow branches**

Use metadata-only 500 MiB and 500 MiB+1 cases; unknown size requires direct confirmation. Lower a test-only injected actual limit to prove temporary archive disposal and an additional confirmation before anchor clicks.

- [ ] **Step 4: Run browser suites**

```powershell
npm run build:site
npm run test:browser
```

Update `test:browser` to include popup and site/bookmarklet files. All tests use local synthetic origins.

- [ ] **Step 5: Inspect screenshots**

Inspect `home-360.png`, `home-1280.png`, `bookmarklet-list.png`, and `bookmarklet-confirm-direct.png` for clipping, focus, scrolling, and action visibility; fix and rerun failures.

- [ ] **Step 6: Commit**

```powershell
git add tests/browser/site-bookmarklet.test.js tests/browser/helpers/bookmarklet-fixture.js package.json
git commit -m "test: cover website and bookmarklet flows in Chrome"
```

---

### Task 12: Add least-privilege GitHub Pages deployment

**Files:**
- Create: `.github/workflows/pages.yml`, `.github/dependabot.yml`
- Modify: `README.md`, `docs/verification.md`

**Interfaces:**
- Produces a `dist/site` Pages artifact from master/manual dispatch.
- Top-level permission: contents read; deploy job: pages write and id-token write only.

- [ ] **Step 1: Add validating Pages workflow**

Use checkout/setup-node/configure-pages/upload-pages-artifact/deploy-pages official actions. Node 22 + npm cache, `npm ci`, unit/bookmarklet/site tests, and build-site run before upload. Browser tests stay a local release check unless CI installs a pinned Chrome mechanism.

- [ ] **Step 2: Add monthly dependency policy**

Configure npm and Actions Dependabot with a small PR limit and no auto-merge. Exact runtime changes require license/package review and full archive tests.

- [ ] **Step 3: Update docs accurately**

README leads with both editions and links site/privacy/source; explains drag/copy, 500 MB, unknown sizes, confirmation, and pending store status. Verification separates synthetic bookmarklet evidence from the prior real PPT evidence.

- [ ] **Step 4: Run the complete local release check**

```powershell
npm ci
npm test
npm run test:bookmarklet
npm run test:site
npm run test:browser
npm run build
npm run package
npm run build:site
git diff --check
```

Confirm workflow contains no secrets/PAT/school credentials/write-all.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/pages.yml .github/dependabot.yml README.md docs/verification.md
git commit -m "ci: deploy the static website to GitHub Pages"
```

---

### Task 13: Prepare the unlisted Web Store submission kit

**Files:**
- Create: `store/listing-zh-CN.md`, `privacy-practices.md`, `permission-justifications.md`, `submission-checklist.md`
- Create: `store/assets/README.md`, `icon-128.png`, `screenshot-popup.png`
- Modify: `scripts/package.py`, `tests/package.test.js`

**Interfaces:**
- Produces the existing extension ZIP and documentation/assets for manual Unlisted submission; no dashboard automation.

- [ ] **Step 1: Strengthen package tests**

Assert MV3, package/manifest/site version consistency, Chrome 120, exact permissions/host, real icons, no remote runtime, and ten entries byte-equal to `dist/extension`.

- [ ] **Step 2: Write accurate listing/privacy/permission text**

Map scripting to user-triggered active THEOL frame inspection, storage to current-session state, downloads to selected Chrome downloads, and host access to selected authorized metadata/files. State no collection/sale/upload/password or Cookie export and no bypass. Visibility is `Unlisted`.

- [ ] **Step 3: Generate synthetic store assets**

Use existing icon source and browser-test screenshots with only simulated names. Record dimensions, generation command, synthetic status, and upload field in asset README.

- [ ] **Step 4: Run checks**

```powershell
npm run build
npm run package
node --test tests/package.test.js
Select-String -Path store/*.md -Pattern 'Unlisted|不公开|收集|Cookie|权限'
```

- [ ] **Step 5: Commit**

```powershell
git add store scripts/package.py tests/package.test.js
git commit -m "docs: prepare the unlisted Chrome Web Store submission"
```

---

### Task 14: Publish the repository and Pages site

**Files:**
- Remote: `https://github.com/vg188/THEOL-downloader`
- Modify after deployment: `docs/verification.md`

**Interfaces:**
- Produces the public repository and Pages site; store remains pending.

- [ ] **Step 1: Review remote/local state**

```powershell
gh auth switch --user vg188
gh auth status
gh repo view vg188/THEOL-downloader --json nameWithOwner,visibility,defaultBranchRef,url
git remote -v
git status --short --branch
git log --oneline --decorate -10
```

Require vg188, public repo, clean tree, and no unrelated history to overwrite.

- [ ] **Step 2: Push a feature branch and open PR**

```powershell
git checkout -b codex/bookmarklet-site
git push -u origin codex/bookmarklet-site
gh pr create --base master --head codex/bookmarklet-site --title "Add THEOL website and bookmarklet" --body-file docs/release-pr.md
```

Never force-push or push directly to master.

- [ ] **Step 3: Wait for checks; merge only with user approval**

Run `gh pr checks`, present the PR, and ask before merge because it triggers production Pages deployment.

- [ ] **Step 4: Verify public deployment**

Verify 200 for root, privacy page, bookmarklet runtime, and worker. Confirm pending store control, fixed versioned bootstrap URL, no source maps/listing, and successful Actions run.

- [ ] **Step 5: Record evidence through a follow-up PR**

Document run URL, commit, date, assets, and checks—never tokens/course data—on a new branch/PR.

---

### Task 15: Hand off Web Store submission and activate the approved link

**Files:**
- User action: Chrome Web Store Developer Dashboard
- Modify after approval: `site/config.json`, `README.md`, `docs/verification.md`

**Interfaces:**
- Produces a validated Unlisted detail URL and enabled “添加至 Chrome” link only after approval.

- [ ] **Step 1: Give the manual submission checklist**

User uploads the ZIP/assets, pastes prepared copy, chooses Unlisted, supplies Pages privacy/support URLs, and completes Google verification/fee/attestations/submission.

- [ ] **Step 2: Keep pending state honest**

Require `"chromeWebStoreUrl": null`; do not guess an ID or substitute a ZIP install link.

- [ ] **Step 3: Validate the approved URL**

Require HTTPS `chromewebstore.google.com/detail/.../<32 lowercase-letter ID>`, public success, matching product name, and Unlisted behavior.

- [ ] **Step 4: Enable and test**

Set the exact URL, then run site tests, site build, browser tests, and diff check. Expected: enabled external “添加至 Chrome” with unchanged bookmarklet/privacy behavior.

- [ ] **Step 5: Publish via reviewed PR**

```powershell
git checkout -b codex/enable-web-store-link
git add site/config.json README.md docs/verification.md
git commit -m "feat: enable the unlisted Chrome Web Store link"
git push -u origin codex/enable-web-store-link
gh pr create --base master --head codex/enable-web-store-link --title "Enable Chrome Web Store install link" --body "Activates the approved unlisted listing URL and leaves bookmarklet behavior unchanged."
```

Merge only after checks and explicit user approval.
