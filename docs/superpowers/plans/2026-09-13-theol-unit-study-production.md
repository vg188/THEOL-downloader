# THEOL Unit Study Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe “当前单元” and explicitly confirmed “全部单元” PDF/PPT/PPTX scanning to the Chrome extension and the self-contained bookmarklet scanner while preserving the existing course-resource behavior and download security boundary.

**Architecture:** Add a browser-neutral unit-study policy/parser beside the existing course-resource parser. Current mode parses only the active document; all mode enumerates a structurally bounded group of exact allowlisted unit-entry links, fetches at most two unit pages concurrently, validates the final page origin/course/role before parsing, deduplicates resources by canonical ID, then reuses the existing three-wide metadata scanner. Extension and bookmarklet adapters consume one shared `describeSurface`/`collectUnitResources` contract; privileged extension queue and bookmarklet download implementations remain separate.

**Tech Stack:** Node.js >=22, native browser JavaScript, Manifest V3 Chrome 120+, esbuild 0.25.12, jsdom 26.1.0, Playwright Core 1.63.0

## Global Constraints

- Approved design: `docs/superpowers/specs/2026-09-12-theol-unit-study-scanning-design.md`.
- Real-page evidence: `docs/unit-study-feasibility.md`; decisions are `UNIT_CURRENT_GO` and `UNIT_ALL_GO`.
- Exact origin: `https://course.buct.edu.cn`.
- Current-unit preview allowlist: pathname `/meol/common/script/preview/download_preview.jsp`; exact query-key set `fileid`, `lid`, `resid`; each value is one canonical positive decimal identifier of at most 12 digits.
- All-unit entry allowlist: pathname `/meol/jpk/course/course_column_preview_transfer.jsp`; exact query-key set `columnId`, `tagbug`; `columnId` is one positive decimal identifier of at most 12 digits and `tagbug` must equal the observed platform constant `client`.
- Unit page allowlist: `/meol/jpk/course/layout/lesson/index.jsp` or `/meol/jpk/course/layout/newpage/index.jsp`; exact query-key set `courseId`; `courseId` is one positive decimal identifier of at most 12 digits.
- `/meol/buildless/resFolderViewList.do` remains observational and MUST NOT be fetched or accepted as a unit-entry route in this plan.
- Existing course-resource paths and policy remain unchanged: `/meol/common/script/listview.jsp`, `/meol/common/script/preview/download_preview.jsp`, `/meol/common/script/download.jsp`.
- Current mode MUST NOT fetch another unit page. All mode is a separate explicit action and MUST show the number of unit entries before issuing unit-page requests.
- Unit-page concurrency is exactly 2; preview-metadata concurrency remains at most 3; request timeout remains 15 seconds; decoded unit/preview HTML is capped at 2 MiB per response.
- All-unit navigation requests may follow redirects only when the final response URL is the exact school origin, an allowlisted unit page, and the current course ID. Any other final URL, login page, redirect target, MIME type, or course ID fails before body parsing.
- Never click platform navigation automatically, execute inline handlers, infer IDs, accept arbitrary same-origin JSPs, broaden permissions, or manufacture preview/download URLs.
- Keep source ordering: unit index order first, then DOM resource order. Deduplicate by canonical resource ID; retain first occurrence and record the count of additional unit occurrences without issuing duplicate preview/download requests.
- Dynamic page text is untrusted. Use `textContent`; never inject course/unit/file values as HTML.
- Download path remains `courseName/originalFilename`; do not add unit subfolders.
- Tests use synthetic local fixtures only. Real THEOL checks are user-triggered and limited to authorized pages/files.
- The self-contained bookmarklet remains the runtime model; do not restore the rejected GitHub Pages remote-loader architecture.
- Bookmarklet integration in Task 7 has a mandatory conflict-resolution procedure for the older plan’s rejected remote-loader Tasks 9–10; see that task before executing any prior-plan task.

---

### Task 1: Lock the unit URL and page-role policy

**Files:**
- Modify: `src/platform/policy.js`
- Create: `src/platform/unit.js`
- Modify: `tests/platform.test.js`
- Modify: `tests/helpers/dom.js`

**Interfaces:**
- Produces `UNIT_PATHS = { entry, lesson, newpage }`.
- Produces `normalizeUnitEntryUrl(input, base): {columnId, url}`.
- Produces `normalizeUnitPageUrl(input, expectedCourseId): {courseId, url, layout:'lesson'|'newpage'}`.
- Produces `parseUnitPage(document, pageUrl): UnitPage | null` where:

```js
{
  surface: 'unit-study',
  courseId: string,
  layout: 'lesson' | 'newpage',
  url: string,
  resources: Array<{
    id:string, courseId:string, resId:string, fileId:string,
    previewUrl:string, title:string,
    unit:{ entryUrl:string|null, title:string, order:number, occurrenceCount:number }
  }>,
}
```

- `parseUnitPage` accepts only allowlisted unit-page URLs and canonical existing preview anchors whose `lid` equals the page `courseId`.

- [ ] **Step 1: Add exact URL-policy failures**

First add shared unit fixtures to `tests/helpers/dom.js` (exported alongside the existing helpers):

```js
export const unitEntryUrl = (columnId = 41) => `https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=${columnId}`;
export const unitPageUrl = (layout = 'lesson', courseId = 12) => `https://course.buct.edu.cn/meol/jpk/course/layout/${layout}/index.jsp?courseId=${courseId}`;
```

In the plan’s test snippets, `entry(n)` means `unitEntryUrl(n)` and `lessonUrl` means `unitPageUrl('lesson')`.

```js
import {
  parseUnitPage,
  normalizeUnitEntryUrl,
  normalizeUnitPageUrl,
} from '../src/platform/unit.js';

const entryUrl = 'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=44';
const lessonUrl = 'https://course.buct.edu.cn/meol/jpk/course/layout/lesson/index.jsp?courseId=12';

assert.deepEqual(normalizeUnitEntryUrl(entryUrl), {
  columnId:'44',
  url:'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?columnId=44&tagbug=client',
});
assert.equal(normalizeUnitPageUrl(lessonUrl, '12').layout, 'lesson');
```

Reject each of these before parsing:

```js
[
  entryUrl.replace('https://', 'http://'),
  entryUrl.replace('course.buct.edu.cn', 'evil.test'),
  entryUrl + '&columnId=45',
  entryUrl.replace('columnId=44', 'columnId=-1'),
  entryUrl.replace('tagbug=client', 'tagbug=server'),
  entryUrl.replace('course_column_preview_transfer.jsp', 'resFolderViewList.do'),
]
```

Also reject unit pages with unknown paths, extra/missing/duplicate query keys, credentials, fragments after canonicalization, or a course ID different from `expectedCourseId`.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/platform.test.js
```

Expected: FAIL because `src/platform/unit.js` and the new exports do not exist.

- [ ] **Step 3: Implement exact canonicalizers**

In `src/platform/unit.js`, use `schoolUrl`, `numericParam`, `pathWithoutSession`, and an exact key-set helper:

```js
function exactKeys(url, expected) {
  const actual = [...new Set(url.searchParams.keys())].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AppError('INVALID_RESOURCE', '单元链接参数无效');
  }
}
```

- [ ] **Step 4: Add current-unit parser contracts**

Add synthetic fixtures for both `lesson` and `newpage` layouts:

```js
const document = dom(`
  <a href="/meol/common/script/preview/download_preview.jsp?fileid=56&resid=78&lid=12">第一份</a>
  <a href="/meol/common/script/preview/download_preview.jsp?fileid=57&resid=79&lid=12">第二份</a>
  <a href="/meol/common/script/preview/download_preview.jsp?fileid=58&resid=80&lid=99">其他课程</a>
`);
const unit = parseUnitPage(document, lessonUrl);
assert.equal(unit.surface, 'unit-study');
assert.deepEqual(unit.resources.map(item => item.id), ['12:78:56', '12:79:57']);
```

Cover hidden/disabled ancestors, duplicate anchors, zero resources, unsafe link text, and `resFolderViewList.do` links being ignored.

- [ ] **Step 5: Implement `parseUnitPage`**

Reuse `normalizeResourceUrl(..., 'preview', pageUrl)` and the existing unavailable-element rule. Export `isUnavailable` from `src/platform/policy.js` (the shared dependency both parsers already import) and update `parse.js` to import it — there must be exactly one visibility convention in the codebase. Extract the preview URL’s course with `numericParam(url, 'lid')` and compare it to the unit page’s `courseId` (which comes from the `courseId` query key); a mismatched anchor is ignored, never an error. A unit page with zero valid anchors returns a valid `UnitPage` with `resources: []`, not `null` — `null` is reserved for a non-allowlisted page URL. Set temporary unit metadata to `{entryUrl:null,title:'当前单元',order:0,occurrenceCount:1}`; all-mode aggregation replaces it with validated entry context.

- [ ] **Step 6: Run GREEN and existing parser regressions**

```powershell
node --test tests/platform.test.js
npm test
```

Expected: new policy/parser tests and all existing course-resource tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/platform/policy.js src/platform/unit.js src/platform/parse.js tests/platform.test.js tests/helpers/dom.js
git commit -m "feat: recognize current THEOL unit pages"
```

---

### Task 2: Enumerate bounded unit-entry groups without guessing

**Files:**
- Modify: `src/platform/unit.js`
- Modify: `tests/platform.test.js`

**Interfaces:**
- Produces `parseUnitIndex(document, pageUrl): {courseId, entries, key} | null`.
- `entries` shape:

```js
Array<{ columnId:string, entryUrl:string, title:string, order:number }>
```

- The parser groups exact allowlisted entry anchors by their nearest list container (`ul`, `ol`, or an element with `role="list"`). It accepts exactly one visible group containing at least two distinct canonical unit entries. It never scans page-wide matching links when no bounded group exists.

- [ ] **Step 1: Write bounded-group tests**

Add a fixture with a top navigation and a separate unit list, both using the same endpoint:

```js
const document = dom(`
  <nav><a href="${entry(900)}">栏目</a></nav>
  <ul id="units">
    <li><a href="${entry(41)}">第一次</a></li>
    <li><a href="${entry(42)}">第二次</a></li>
    <li><a href="${entry(43)}">第三次</a></li>
  </ul>
`);
const index = parseUnitIndex(document, lessonUrl);
assert.deepEqual(index.entries.map(item => item.columnId), ['41','42','43']);
```

Add failures for:

- two visible list groups with two or more distinct entry links (`AMBIGUOUS_UNIT_INDEX`);
- only page-wide anchors without a list container;
- one-entry groups;
- nested lists (count each anchor once in the nearest candidate group);
- hidden groups;
- duplicate `columnId` values;
- form/scripted controls;
- auxiliary `resFolderViewList.do` links.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/platform.test.js
```

Expected: FAIL because `parseUnitIndex` is absent.

- [ ] **Step 3: Implement structural grouping**

For each visible anchor accepted by `normalizeUnitEntryUrl`, choose `anchor.closest('ul,ol,[role="list"]')`. Group by container identity, deduplicate by `columnId`, preserve DOM order, and keep groups with at least two entries. If zero groups exist, return `null`; if more than one group exists, throw `AMBIGUOUS_UNIT_INDEX`. Never fall back to all matching anchors.

`key` must include the current course ID and the ordered full canonical entry parameter set so a changed `tagbug` value or any future canonical-parameter change invalidates the scan:

```js
`${courseId}|${entries.map(entry => `${entry.columnId}:${canonicalEntryParams}`).join(',')}`
```

where `canonicalEntryParams` is the exact sorted `name=value` list of the canonical entry URL (currently `columnId=<id>&tagbug=client`). Do not store only `columnId`.

The unit title is sanitized `textContent`, collapsed whitespace, maximum 200 UTF-16 units, fallback `单元 ${order + 1}`. It remains local and is never logged remotely.

- [ ] **Step 4: Run GREEN**

```powershell
node --test tests/platform.test.js
```

Expected: grouping, ambiguity, visibility, and auxiliary-route tests pass.

git add src/platform/unit.js tests/platform.test.js
git commit -m "feat: enumerate bounded THEOL unit groups"
```

---

### Task 3: Fetch and aggregate all unit pages with two workers

**Files:**
- Create: `src/platform/unit-scan.js`
- Create: `tests/unit-scan.test.js`
- Modify: `src/platform/network.js`

**Interfaces:**
- Produces `collectUnitResources(index, options): Promise<UnitCollection>`.
- Options: `{fetcher=globalThis.fetch, parseDocument, signal, timeoutMs=15000, onProgress=async()=>{}}`.
- Result:

```js
{
  entriesProcessed:number,
  entriesTotal:number,
  resources:Array<Resource>,
  failures:Array<{kind:'unit',columnId:string,title:string,code:string,message:string}>,
}
```

- Progress event: `{kind:'unit-progress', processed, total, discovered, failure?}`.

- [ ] **Step 1: Write concurrency, validation, and dedupe tests**

Create `tests/unit-scan.test.js` that supplies four synthetic entries and a fetcher tracking active/peak calls. Assert `peak <= 2`, entry order survives out-of-order responses, and duplicate resource IDs are requested only once later.

A valid unit-page response must satisfy all of:

```js
response.ok === true
response.type !== 'opaqueredirect' && response.status !== 0 && !response.redirected && response.status !== 401
response.url is exact school-origin lesson/newpage URL
normalizeUnitPageUrl(response.url, index.courseId) succeeds
content-type is text/html or application/xhtml+xml
body length <= 2 * 1024 * 1024
parsed document is not a login page
```

Also test `redirect:'manual'` behavior: an opaque redirect and a `redirected: true` response both fail as `LOGIN_REQUIRED` before any body read; and a 200 whose `response.url` is neither the canonical entry URL nor an allowlisted unit page fails as a redirect-equivalent.

Test cross-origin final URLs, wrong course IDs, `resFolderViewList.do`, login/error HTML, unsupported charset, timeout, cancellation, one failed unit with remaining success, and all units failing.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/unit-scan.test.js
```

Expected: FAIL because `collectUnitResources` does not exist.

- [ ] **Step 3: Extract one shared bounded HTML reader**

Move the charset/body-limit logic currently embedded in `scanResources` into `src/platform/network.js`:

```js
export async function readHtmlResponse(response, {
  signal,
  maxBytes = 2 * 1024 * 1024,
  badEncodingMessage,
  tooLargeMessage,
} = {})
```

It validates HTML MIME, extracts declared charset with UTF-8 fallback using the exact `content-type` regex from `scanResources`, enforces the byte limit **before decoding** (read at most `maxBytes + 1` bytes; exceeding `maxBytes` throws the caller-provided `tooLargeMessage` without ever constructing a decoder for the oversized payload), decodes with `TextDecoder` and the existing `BAD_FILE` message on unsupported charsets, cancels the reader in `finally` on abort or early exit, and throws `AppError`. Preserve the exact GBK test sequence: charset from headers, bounded bytes, then decode. Update `scanResources` to call it without changing any existing behavior, message, or error code.

- [ ] **Step 4: Implement the two-worker collector**

Use `withDeadline` per entry. Fetch canonical `entryUrl` with `{credentials:'include', redirect:'manual', signal}` and reject any redirect exactly as `scanResources` does: `response.type === 'opaqueredirect' || response.status === 0 || response.redirected || response.status === 401` fails as `LOGIN_REQUIRED`. If the platform answers the entry URL with a normal 200 whose `response.url` differs from the canonical entry URL, treat it as a redirect-equivalent failure unless `normalizeUnitPageUrl(response.url, index.courseId)` succeeds — the observed entry route renders content directly, so any redirect is anomalous. Never read the body before the final URL passes `normalizeUnitPageUrl(response.url, index.courseId)`. Parse with `parseUnitPage`; attach the entry’s title/order/url to each resource.

Deduplicate in entry order after workers settle:

```js
const unique = new Map();
for (const unitResult of resultsInEntryOrder) {
  for (const resource of unitResult.resources) {
    const existing = unique.get(resource.id);
    if (existing) existing.unit.occurrenceCount++;
    else unique.set(resource.id, resource);
  }
}
```

Do not expose raw response URLs or bodies in errors. Login failure is fatal only when all entries fail with `LOGIN_REQUIRED`; otherwise it is a local unit failure and successful units remain.

- [ ] **Step 5: Run focused and scanner regression tests**

```powershell
node --test tests/unit-scan.test.js tests/scanner.test.js
npm test
```

Expected: unit concurrency is at most 2; preview concurrency remains at most 3; GBK preview tests still pass.

- [ ] **Step 6: Commit**

```powershell
git add src/platform/unit-scan.js src/platform/network.js src/platform/scan.js tests/unit-scan.test.js tests/scanner.test.js
git commit -m "feat: collect resources from all THEOL units"
```

---

### Task 4: Expose surface and mode through the content-script API

**Files:**
- Modify: `src/content.js`
- Create: `src/platform/surface.js`
- Modify: `tests/scanner.test.js`

**Interfaces:**
- Produces `describeSurface(document, pageUrl)` returning one of:

```js
{ surface:'resource-directory', modeOptions:['current'], directory }
{ surface:'unit-study', modeOptions:['current','all'], unitPage, unitIndex }
null
```

```js

describe(): {url,title,surface}   // surface = describeSurface(document, location.href); surface.directory preserved for resource frames
scan(scanId, {mode='current'} = {}): Promise<void>   // omitted mode keeps today's behavior; unknown mode throws AppError('INVALID_MESSAGE') before any request
```

- [ ] **Step 1: Add surface-precedence tests**

Test:

- listview page returns only `resource-directory/current`;
- lesson/newpage with preview links returns `unit-study/current` and, when a valid index exists, `all`;
- unit page with no preview links but a valid index still supports `all` and current returns zero resources;
- an ordinary course shell returns `null`;
- a synthetic document matching both shapes is rejected as `AMBIGUOUS_DIRECTORY`, not silently prioritized.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/scanner.test.js
```

Expected: new surface APIs are missing.

- [ ] **Step 3: Implement `describeSurface`**

Keep page recognition pure. Do not inspect page text to guess the surface; use exact page URL policy plus parser success. A course-resource nested frame and unit page in separate frames are separate candidates for the background bridge to disambiguate using the active document/course context.

- [ ] **Step 4: Implement current/all scan flows**

`current`:

- resource surface → existing `directory.resources`;
- unit surface → current `unitPage.resources`;
- no other page requests.

`all`:

- require `unitIndex`;
- call `collectUnitResources` and emit `unit-progress`;
- feed unique resources to `scanResources`, which emits metadata progress;
- combine local unit failures with metadata failures in the final event.

A replacement scan aborts both stages. `cancel()` aborts the active controller and does not mutate a newer generation.

- [ ] **Step 5: Run focused tests**

Use a fake `chrome.runtime.sendMessage` and assert event ordering:

```text
unit-progress* -> metadata progress* -> complete
```

Assert current mode performs zero unit-entry fetches and all mode never calls `download.jsp`.

```powershell
node --test tests/scanner.test.js tests/unit-scan.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add src/content.js src/platform/surface.js tests/scanner.test.js
git commit -m "feat: scan current or all THEOL units"
```

---

### Task 5: Carry unit context through the background bridge

**Files:**
- Modify: `src/background/bridge.js`
- Modify: `src/background/app.js`
- Modify: `tests/bridge.test.js`
- Modify: `tests/app.test.js`

**Interfaces:**
- `bridge.inspect(tabId)` returns `{context,surface}`.
- `bridge.start(tabId, mode='current')` validates the mode against `surface.modeOptions`.
- Context adds:

```js
{
  surface:'resource-directory'|'unit-study',
  mode:'current'|'all',
  unitKey:string,
  resourceIds:string[],
}
```

- Router `START_SCAN` accepts only `{type:'START_SCAN',tabId,mode}`.

- [ ] **Step 1: Add frame-selection and mode-validation tests**

Extend the bridge harness with unit-page frames. Assert:

- current unit selects exactly one matching frame and passes `{mode:'current'}` to content `scan`;
- all mode is rejected on course-resource surfaces;
- invalid/missing modes normalize only to safe default `current`;
- multiple unit candidates or a simultaneous resource candidate are rejected unless exactly one corresponds to the top-level course and active surface;
- sender frame/document validation remains exact;
- unit failures cannot inject resource IDs outside the inspected list/collected generation;
- switching `surface`, `mode`, `documentId`, unit index key, or resource set invalidates selection.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/bridge.test.js tests/app.test.js
```

Expected: mode/context assertions fail.

- [ ] **Step 3: Update inspection and start**

Replace `directory`-only frame candidates with `surface` candidates from `describe()`. Context key format:

```js
`${surface.surface}|${mode}|${surface.directory?.key || surface.unitPage?.url || ''}|${surface.unitIndex?.key || ''}`
```

Surface tie-breaking (bridge): after filtering by top-level course, if both a `resource-directory` frame and a `unit-study` frame remain, prefer the frame containing the browser-focused document (`document.hasFocus()`), then the deepest active frame reported by `chrome.scripting` results; if still ambiguous, throw `AMBIGUOUS_DIRECTORY` with the existing message — never merge or guess.
Discovered-event correlation: in all mode the content script emits, after each unit page settles, one `{kind:'discovered', resources:[descriptors]}` batch containing that unit’s canonical preview descriptors; `unit-progress` events remain display-only counters and are never used for ID validation. The bridge validates each descriptor with `normalizeResourceUrl(...,'preview')`, rejects any course mismatch, appends each ID once to `resourceIds`, and only then accepts subsequent `progress` file/failure events for those IDs — mirroring the existing current-mode `resourceIds` trust rule.

- [ ] **Step 4: Preserve race invariants**

Retain serialization and the rule that stale context checks never clear a replacement scan. Add races for replacing current with all and all with current during `inspect()`.

- [ ] **Step 5: Run bridge/router regressions**

```powershell
node --test tests/bridge.test.js tests/app.test.js
npm test
```

Expected: untrusted content/webpage senders remain rejected; download submission still uses only stored validated files.

- [ ] **Step 6: Commit**

```powershell
git add src/background/bridge.js src/background/app.js tests/bridge.test.js tests/app.test.js
git commit -m "feat: preserve unit scan modes across the extension bridge"
```

---

### Task 6: Add the extension scan-range UI and confirmation

**Files:**
- Modify: `public/popup.html`
- Modify: `public/popup.css`
- Modify: `src/popup/view.js`
- Modify: `tests/popup.test.js`
- Modify: `tests/browser/popup-layout.test.js`

**Interfaces:**
- Adds `#scan-mode` select with values `current` and `all`.
- Adds `#all-units-dialog` with unit count, request explanation, Confirm, and Cancel.
- `START_SCAN` sends `{mode}`; `all` is never submitted before dialog confirmation.

- [ ] **Step 1: Add popup behavior tests**

Cover:

```js
assert.equal(mode.hidden, true); // resource-directory
assert.equal(mode.value, 'current'); // fresh unit-study popup
```

For unit-study:

- mode control visible, default current;
- selecting all and pressing Scan opens the dialog and sends no `START_SCAN`;
- dialog displays `surface.unitIndex.entries.length`;
- cancel sends nothing and restores controls;
- confirm sends one `START_SCAN` with `mode:'all'`;
- scanning disables mode changes;
- refresh/reopen restores `current` rather than persisting all;
- changing mode clears unsubmitted selection through the context key;
- file row shows `所属单元 · 另见 N 个单元` only when available;
- unit and resource failures render in separate local groups;
- course-resource copy remains “当前目录”, not “当前单元”.

- [ ] **Step 2: Run RED**

```powershell
node --test tests/popup.test.js
```

Expected: controls are absent.

- [ ] **Step 3: Add semantic controls**

Place a labelled native select near the scan button. Use a native `<dialog>` with heading `扫描全部单元？`, text `将读取当前课程的 N 个单元页面，不会下载课件正文`, and explicit buttons. Provide a non-dialog fallback by toggling `hidden` if `showModal` is unavailable in jsdom/older environments; do not use `window.confirm`.

Narrow-width placement: the course line already fills 360 px. Put the `#scan-mode` select on its own row between the course line and the tab bar, hidden entirely on `resource-directory` surfaces, `max-width:100%`, so the scan button never shares a row with it. The dialog is centered with `max-width: min(320px, calc(100vw - 32px))` and internal scrolling, and must overlay — not reflow — the file list.

- [ ] **Step 4: Update render/state handling**

Derive available modes solely from `state.page.context.modeOptions`. Do not infer from visible copy. Progress text:

```text
units: 正在读取单元 X / Y，已发现 Z 个候选
metadata: 正在识别课件 X / Y
```

The select remains disabled while pending/scanning. A fatal context change closes the dialog and resets mode to current.

- [ ] **Step 5: Validate popup and native layout**

```powershell
node --test tests/popup.test.js
npm run build
npm run test:browser
```

At 360 and 440 px, assert no horizontal overflow, dialog content is reachable, select and buttons have visible focus, and current file/history panels retain their scroll area.

- [ ] **Step 6: Commit**

```powershell
git add public/popup.html public/popup.css src/popup/view.js tests/popup.test.js tests/browser/popup-layout.test.js
git commit -m "feat: choose current or all THEOL units"
```

---

### Task 7: Integrate the shared modes into the self-contained bookmarklet scanner

**Prerequisite:** `src/bookmarklet/discovery.js`, `scanner.js`, `controller.js`, `view.js`, and `scripts/build-site.mjs` do not exist yet. They are created by Tasks 4–10 of `docs/superpowers/plans/2026-09-12-theol-website-bookmarklet.md`. That plan’s Tasks 4–8 (shared size/signature primitives, discovery, 500 MiB planner/controller, streaming archive, confirmed direct downloads) remain valid prerequisites.

**Conflict resolution — mandatory overrides before executing this task:** the older plan’s Tasks 9–10 embed the **rejected remote-loader bootstrap** (`s.src="https://vg188.github.io/THEOL-downloader/bookmarklet/v1/bookmarklet.js"`) that the real-page gate disproved. When executing that plan, apply these overrides:

1. Execute its Task 4–8 as written.
2. For its Task 9, keep the Shadow DOM panel/controller wiring but **drop the remote bootstrap**: `bootstrap.js` must emit a self-contained `javascript:` URL containing the full bundled runtime (same bundling strategy as the feasibility probe, see `scripts/build-probe.mjs`), and the `createBootstrap({runtimeUrl})` interface becomes `createSelfContainedBookmarklet(bundleSource): string` with no runtime URL parameter.
3. For its Task 10, keep the site build and config but the draggable/copy bookmarklet is the self-contained URL; no versioned runtime file is published or fetched.
4. The prior plan’s self-contained size risk is real: its Task 5–8 bundle will exceed the probe’s 7.6 KB. Mitigation order: (a) ship the self-contained bookmarklet regardless of size — Chrome accepts long bookmark URLs; the sub-8,000-char rule applied to the probe’s draggability proof, not the product; (b) if the built URL exceeds 100,000 characters, stop and return to design with the measured size — do not silently reintroduce a remote loader.

**Files:**
- Create or modify per the prerequisite flow: `src/bookmarklet/discovery.js`, `scanner.js`, `controller.js`, `view.js`, `template.js`, `bootstrap.js`
- Modify: `tests/bookmarklet/discovery.test.js`, `scanner.test.js`, `controller.test.js`, `view.test.js`, `bootstrap.test.js`
- Modify: `scripts/build-site.mjs`

**Interfaces:**
- `discoverSurface(rootWindow)` returns the same surface/context contract as the extension bridge without `chrome.*`. Unlike the prior plan’s course-resource-only `discoverDirectory`, it must recognize `resource-directory`, `unit-study` current, and `unit-study` with unit index, reusing `describeSurface` from `src/platform/surface.js` — not a copy.
- `scanner.scan(rootWindow, {mode}, onProgress)` uses `collectUnitResources` and `scanResources`.
- Controller exposes `setScanMode('current'|'all')` and `confirmAllUnits()`; changing mode invalidates selection.
- Built bookmarklet is a self-contained `javascript:` URL with no runtime network fetch except allowlisted THEOL requests initiated by the user.

- [ ] **Step 1: Add shared-contract discovery tests**

Use nested synthetic windows for course-resource, current-unit, all-unit, inaccessible frame, ambiguous frame, and top-course mismatch cases. Assert extension `describeSurface` and bookmarklet `discoverSurface` select identical surface/mode/resource IDs for equivalent documents.

- [ ] **Step 2: Add controller side-effect tests**

Selecting all and invoking scan must transition to `confirm-all-units` with zero fetches. Only `confirmAllUnits()` starts unit-page reads. Test cancel, replacement, hidden panel, context change, and download request after scan.

- [ ] **Step 3: Implement scanner/controller integration**

Reuse shared modules directly. Do not copy route policies into bookmarklet code. Current mode performs no entry-page request. All mode respects 2/3 concurrency, aborts both stages on cancel, and emits the same local failure categories as the extension.

- [ ] **Step 4: Implement bookmarklet UI mode selection**

Mirror the extension wording and confirmation. Keep Shadow DOM isolation, visible focus, reduced motion, and textContent-only dynamic values. During an active archive/direct-download task the scan mode is immutable.

- [ ] **Step 5: Build and prove self-contained output**

```powershell
npm run test:bookmarklet
npm run build:site
```

Inspect `dist/site/index.html` and the draggable link. Assert its `javascript:` payload does not create `<script src>`, fetch GitHub Pages runtime JS, use storage/telemetry APIs, or contain source maps. Course-content requests must target only exact school-origin allowlisted paths. Measure and record the payload length; over 100,000 characters is a stop condition, not a size warning.

- [ ] **Step 6: Commit**

```powershell
git add src/bookmarklet tests/bookmarklet scripts/build-site.mjs
git commit -m "feat: scan current or all units from the bookmarklet"
```

---

### Task 8: Update user documentation and release evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/verification.md`
- Modify: `PRODUCT.md`
- Modify: `docs/superpowers/specs/2026-09-12-theol-unit-study-scanning-design.md`

**Interfaces:**
- Documents exactly three scan labels: `当前目录` for course resources, `当前单元`, and `全部单元`.
- Records automatic-test evidence separately from real-page evidence.

- [ ] **Step 1: Update behavior and boundaries**

Document:

- where the scan-range control appears;
- current as the safe default;
- all mode reads N unit pages only after confirmation;
- two unit-page and three metadata-request concurrency;
- duplicate files appear once with additional-unit count;
- partial unit failures preserve successes;
- switching course/unit/mode clears old selection;
- no recursion, pagination, cross-course scan, video/non-courseware download, or auxiliary-route traversal;
- no unit subfolder in saved paths.

Audit `README.md`, `docs/verification.md`, and `PRODUCT.md` for statements that describe the extension as limited to “课程资源” 目录扫描 (e.g. “只扫描当前目录” usage guidance, “进入课程资源目录” instructions, “首版只读取当前列表” empty-state copy). Update each to describe both surfaces accurately; the spec’s rule that course-resource pages offer only current-directory mode stays — it is the surface behavior, not a product limitation sentence.

- [ ] **Step 2: Record evidence honestly**

In `docs/verification.md`, distinguish:

- synthetic parser/scanner/UI tests;
- real metadata-only probe result from `docs/unit-study-feasibility.md`;
- real one-file download acceptance, initially marked pending until Task 9.

Do not add screenshots containing course names, IDs, filenames, account UI, or full URLs to Git.

- [ ] **Step 3: Run documentation/build checks**

```powershell
git diff --check
npm run build
npm run package
```

Expected: extension package allowlist remains ten files; no probe evidence or browser profile enters the ZIP.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/verification.md PRODUCT.md docs/superpowers/specs/2026-09-12-theol-unit-study-scanning-design.md
git commit -m "docs: explain THEOL unit scan modes"
```

---

### Task 9: Run automated and real authorized acceptance

**Files:**
- Modify after acceptance: `docs/verification.md`
- Remove after use: any untracked throwaway fixtures/scripts created for smoke testing

**Interfaces:**
- Produces final evidence for extension current/all modes and bookmarklet current/all modes.
- Does not add permanent tests that assert screenshots, source text, mock forwarding, or incidental DOM defaults.

- [ ] **Step 1: Run the full automated matrix**

```powershell
npm test
npm run test:browser
npm run test:bookmarklet
npm run test:site
npm run build
npm run build:site
npm run package
git diff --check
```

Expected: all configured commands pass; extension ZIP remains the ten-file allowlist; site/bookmarklet artifact is self-contained.

- [ ] **Step 2: Smoke the extension on current unit**

With the user’s authorized Chrome profile:

1. Load the rebuilt extension.
2. Open a unit page visibly containing at least one small PDF/PPT/PPTX.
3. Confirm mode defaults to `当前单元`.
4. Scan and select one file.
5. Download it; compare filename/extension, open it in the corresponding application, and verify Chrome reports completion.

This is the real one-file acceptance. Do not record course/file names, IDs, URLs, account data, or file content.

- [ ] **Step 3: Smoke the extension all-unit boundary**

Choose `全部单元`, confirm the displayed unit count matches the visible bounded unit list, then scan. Verify:

- no navigation occurs;
- unit progress precedes metadata progress;
- duplicate courseware appears once;
- switching back to current clears selection;
- a course-resource page exposes only current directory;
- no request is made to `resFolderViewList.do` by the all-unit collector.

Do not download every result. One already accepted file is sufficient.

- [ ] **Step 4: Smoke the self-contained bookmarklet**

Repeat current/all scans using the built self-contained bookmarklet. Verify no GitHub Pages runtime request, no automatic selection, identical resource count/order to the extension on the same page, and the existing ZIP/direct-download confirmation behavior for the one selected small file. Do not start a second real download if the extension file already proves the server path; a local synthetic fixture may prove archive bytes.

- [ ] **Step 5: Record sanitized acceptance**

Update `docs/verification.md` with date, Chrome major version, pass/fail booleans, mode, file format, and whether the file opened successfully. Record no names, identifiers, URLs, sizes tied to a real resource, screenshots, or content hashes.

- [ ] **Step 6: Cleanup and final validation**

Remove throwaway scripts/fixtures and generated real downloads from the repository workspace. Do not delete user files outside the workspace.

```powershell
git status --short
git diff --check
```

Expected: only the intended verification document remains modified.

- [ ] **Step 7: Commit**

```powershell
git add docs/verification.md
git commit -m "docs: verify THEOL unit scan modes"
```

---

## Execution Order and Stop Conditions

1. Tasks 1–6 deliver and prove Chrome extension support.
2. Task 7 runs only after the existing bookmarklet source prerequisites exist; it does not authorize remote runtime loading.
3. Task 8 updates documentation after both product paths exist.
4. Task 9 requires the user’s authorized logged-in browser and is the only real download step. If the user is unavailable, stop after Step 1 with `docs/verification.md` marking real acceptance as pending; do not substitute synthetic evidence for the real gate and do not block automated-task completion on it.

Stop without broadening behavior when:

- exact unit-entry key/value rules differ from the recorded allowlist;
- unit links cannot be isolated to one bounded list group;
- the final unit-page URL is not an allowlisted layout page for the current course;
- all-unit scanning would require clicking handlers, accepting auxiliary routes, or inferring IDs;
- the bookmarklet cannot remain self-contained.

A stop is not permission to fall back to page-wide matching, automatic clicks, wildcard JSPs, or arbitrary same-origin fetches. Return to design with new sanitized evidence instead.
