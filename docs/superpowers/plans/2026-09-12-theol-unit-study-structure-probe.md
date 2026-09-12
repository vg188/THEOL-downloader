# THEOL Unit Study Structure Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the self-contained THEOL compatibility probe so an authorized user can report the non-sensitive route structure needed to implement “当前单元” and “全部单元” without downloading courseware or exposing course data.

**Architecture:** Keep the production extension unchanged until the real-page gate passes. Add a browser-neutral route-signature module that reports only endpoint paths, query-key names, counts, navigation mechanism, response type, and character encoding; the page-side probe recursively examines accessible same-origin frames and can capture one explicitly selected unit navigation click without following it. After the user reports the sanitized result, write the production implementation plan with the confirmed endpoint allowlist—never infer or manufacture unit URLs.

**Tech Stack:** Node.js >=22, native browser JavaScript, esbuild 0.25.12, jsdom 26.1.0, GitHub Pages, Chrome 120+

## Global Constraints

- Specification: `docs/superpowers/specs/2026-09-12-theol-unit-study-scanning-design.md`.
- Exact runtime origin: `https://course.buct.edu.cn`.
- The deployed bookmarklet must be self-contained; the real THEOL page already blocked the GitHub Pages remote runtime.
- The probe may inspect DOM structure and fetch at most one canonical preview metadata page; it must never request `/meol/common/script/download.jsp` or any courseware body.
- The probe must not upload, persist, log, or place in the report any course name, unit title, filename, resource ID, numeric query value, Cookie, credential, response body, or full URL.
- A route signature may contain only the endpoint pathname, sorted query-key names, navigation mechanism, counts, MIME family, and declared character encoding. Strip `;jsessionid`, fragments, usernames, passwords, and all query values before rendering.
- Do not add permissions, dependencies, telemetry, remote logging, storage APIs, clipboard writes, or collection endpoints.
- Automated tests use synthetic local fixtures only and make no school request.
- Keep `bookmarklet-self-contained.txt` below 8,000 characters so the current draggable installation path remains testable.
- Production unit-study parsing, all-unit requests, extension UI, and bookmarklet download behavior are intentionally outside this gate plan. The follow-up plan must be written from observed route signatures; an inconclusive gate stops production work.

---

### Task 1: Add browser-neutral sanitized route signatures

**Files:**
- Create: `probe/route-signature.js`
- Create: `tests/probe-route-signature.test.js`

**Interfaces:**
- Produces `routeSignature(value, base): { endpoint:string, queryKeys:string[] } | null`.
- Produces `classifyNavigation(element, pageUrl): { mechanism:'href'|'form'|'scripted', route:{endpoint:string,queryKeys:string[]}|null }`.
- Produces `groupRouteSignatures(document, pageUrl): Array<{mechanism:string,endpoint:string,queryKeys:string[],count:number}>`.
- A signature contains no URL origin, query value, fragment, credentials, text content, or element HTML.

- [ ] **Step 1: Write the failing sanitization tests**

Create `tests/probe-route-signature.test.js` with these observable contracts:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  routeSignature,
  classifyNavigation,
  groupRouteSignatures,
} from '../probe/route-signature.js';

const origin = 'https://course.buct.edu.cn';

test('route signatures retain structure and remove all user-specific values', () => {
  const result = routeSignature(
    '/meol/unit/open.jsp;jsessionid=SECRET?courseId=15507&unitId=99&unitId=99#student-name',
    `${origin}/meol/course/index.jsp?courseId=15507`,
  );
  assert.deepEqual(result, {
    endpoint: '/meol/unit/open.jsp',
    queryKeys: ['courseId', 'unitId'],
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|15507|99|student-name/);
});

test('route signatures reject non-school, credentialed, and non-http navigation', () => {
  for (const value of [
    'https://evil.test/unit.jsp?id=1',
    'https://user:password@course.buct.edu.cn/unit.jsp?id=1',
    'http://course.buct.edu.cn/unit.jsp?id=1',
    'javascript:alert(1)',
    'data:text/html,test',
  ]) assert.equal(routeSignature(value, origin), null);
});

test('navigation classification never includes labels, href values, or markup', () => {
  const document = new JSDOM(`
    <a id="href" href="/meol/unit.jsp?courseId=12&unitId=34">第一次 张同学</a>
    <form id="form" action="/meol/unit/list.jsp?courseId=12"><button>第二次</button></form>
    <button id="scripted" onclick="openSecret(12,34)">第三次</button>
  `, { url: `${origin}/meol/course.jsp?courseId=12` }).window.document;
  assert.deepEqual(classifyNavigation(document.querySelector('#href'), document.URL), {
    mechanism: 'href',
    route: { endpoint: '/meol/unit.jsp', queryKeys: ['courseId', 'unitId'] },
  });
  assert.deepEqual(classifyNavigation(document.querySelector('#form button'), document.URL), {
    mechanism: 'form',
    route: { endpoint: '/meol/unit/list.jsp', queryKeys: ['courseId'] },
  });
  assert.deepEqual(classifyNavigation(document.querySelector('#scripted'), document.URL), {
    mechanism: 'scripted',
    route: null,
  });
  const serialized = JSON.stringify([
    classifyNavigation(document.querySelector('#href'), document.URL),
    classifyNavigation(document.querySelector('#scripted'), document.URL),
  ]);
  assert.doesNotMatch(serialized, /张同学|第一次|openSecret|12|34|href=/);
});

test('route groups expose only repeated structural types and counts', () => {
  const document = new JSDOM(`
    <a href="/meol/unit.jsp?unitId=1&courseId=12">第一次</a>
    <a href="/meol/unit.jsp?courseId=12&unitId=2">第二次</a>
    <a href="https://evil.test/unit.jsp?unitId=3">外站</a>
  `, { url: `${origin}/meol/course.jsp?courseId=12` }).window.document;
  assert.deepEqual(groupRouteSignatures(document, document.URL), [{
    mechanism: 'href',
    endpoint: '/meol/unit.jsp',
    queryKeys: ['courseId', 'unitId'],
    count: 2,
  }]);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
node --test tests/probe-route-signature.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `probe/route-signature.js`.

- [ ] **Step 3: Implement the minimal pure classifier**

Create `probe/route-signature.js` with these rules:

```js
const SCHOOL_ORIGIN = 'https://course.buct.edu.cn';

function cleanPath(pathname) {
  return pathname.replace(/;jsessionid=[^/;]*/ig, '');
}

export function routeSignature(value, base = SCHOOL_ORIGIN) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== SCHOOL_ORIGIN || url.protocol !== 'https:' || url.username || url.password) return null;
  return {
    endpoint: cleanPath(url.pathname),
    queryKeys: [...new Set(url.searchParams.keys())].sort(),
  };
}

export function classifyNavigation(element, pageUrl) {
  const anchor = element?.closest?.('a[href]');
  if (anchor) return { mechanism:'href', route:routeSignature(anchor.getAttribute('href'), pageUrl) };
  const form = element?.closest?.('form');
  if (form) return { mechanism:'form', route:routeSignature(form.getAttribute('action') || pageUrl, pageUrl) };
  return { mechanism:'scripted', route:null };
}

export function groupRouteSignatures(document, pageUrl) {
  const groups = new Map();
  for (const element of document.querySelectorAll('a[href], form')) {
    const item = element.matches('form')
      ? { mechanism:'form', route:routeSignature(element.getAttribute('action') || pageUrl, pageUrl) }
      : classifyNavigation(element, pageUrl);
    if (!item.route) continue;
    const key = JSON.stringify([item.mechanism, item.route.endpoint, item.route.queryKeys]);
    const current = groups.get(key) || { mechanism:item.mechanism, ...item.route, count:0 };
    current.count++;
    groups.set(key, current);
  }
  return [...groups.values()].filter(item => item.count > 1)
    .sort((left, right) => right.count - left.count || left.endpoint.localeCompare(right.endpoint));
}
```

Do not add element text, `outerHTML`, `onclick`, referrers, query values, or raw URLs to any return shape.

- [ ] **Step 4: Run GREEN and privacy checks**

Run:

```powershell
node --test tests/probe-route-signature.test.js
```

Expected: 4 tests pass.

Then run:

```powershell
npm run test:probe
```

Expected: existing probe tests still pass.

- [ ] **Step 5: Commit the pure classifier**

```powershell
git add probe/route-signature.js tests/probe-route-signature.test.js
git commit -m "test: sanitize THEOL unit route signatures"
```

---

### Task 2: Extend the self-contained probe for unit-study capture

**Files:**
- Modify: `probe/probe.js`
- Modify: `probe/index.html`
- Modify: `tests/probe.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes `routeSignature`, `classifyNavigation`, and `groupRouteSignatures` from Task 1.
- Probe result shape:

```js
{
  inline: true,
  remote: false,
  frame: boolean,
  metadata: boolean,
  worker: boolean,
  currentFrame: { endpoint:string, queryKeys:string[] } | null,
  previewCount: number,
  repeatedRoutes: Array<{ mechanism:string, endpoint:string, queryKeys:string[], count:number }>,
  capturedNavigation: { mechanism:string, route:{endpoint:string,queryKeys:string[]}|null } | null,
  response: { mimeFamily:'html'|'other', charset:string } | null,
  details: string[],
}
```

- Produces a removable overlay with `捕获下一次单元点击`, `取消捕获`, and `关闭` buttons.
- Capturing is one-shot and local: the probe intercepts exactly one trusted click in an accessible same-origin document, calls `preventDefault()` and `stopImmediatePropagation()`, records only its sanitized navigation classification, removes every capture listener, and does not execute the platform navigation.

- [ ] **Step 1: Add failing artifact and privacy assertions**

Extend `tests/probe.test.js` so `buildProbe()` must satisfy:

```js
assert.match(runtime, /捕获下一次单元点击/);
assert.match(runtime, /取消捕获/);
assert.match(runtime, /当前 frame 类型/);
assert.match(runtime, /重复链接类型/);
assert.match(runtime, /预览链接数量/);
assert.doesNotMatch(bookmarklet + standalone + runtime,
  /sendBeacon|XMLHttpRequest|localStorage|sessionStorage|indexedDB|navigator\.clipboard/);
assert.doesNotMatch(runtime, /\/meol\/common\/script\/download\.jsp/);
assert.ok(standalone.length < 8000,
  `self-contained proof must stay draggable: ${standalone.length}`);
```

Change the package script so `npm run test:probe` covers both probe files:

```json
"test:probe": "node --test tests/probe*.test.js"
```

Add a source-level assertion that `probe/index.html` instructs the user to click `捕获下一次单元点击`, click one visible unit once, and report only the overlay—not DevTools, page source, URLs, IDs, names, or filenames.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm run test:probe
```

Expected: FAIL because the current probe lacks unit capture and the script still targets only `tests/probe.test.js`.

- [ ] **Step 3: Separate canonical preview discovery from list-page detection**

In `probe/probe.js`, import the pure helpers and replace the current `firstPreview(document, pageUrl)` restriction with a function that accepts canonical preview anchors from any accessible school-origin frame while still deriving the expected course ID from each preview URL:

```js
function previewCandidates(document, pageUrl) {
  const found = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), pageUrl); } catch { continue; }
    if (url.origin !== SCHOOL_ORIGIN ||
        url.pathname.replace(/;jsessionid=[^/;]*$/i, '') !== PREVIEW_PATH) continue;
    const fileId = numericParam(url, 'fileid');
    const resId = numericParam(url, 'resid');
    const courseId = numericParam(url, 'lid');
    if (!fileId || !resId || !courseId) continue;
    const canonical = canonicalPreview(url.href, pageUrl, courseId);
    if (canonical && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}
```

This is probe-only discovery. Do not broaden production `normalizeResourceUrl()` or accept any new preview/download endpoint.

- [ ] **Step 4: Add bounded metadata response classification**

Keep the one-request limit. Select the first canonical preview across all accessible frames, call `fetch(url, {credentials:'include', redirect:'manual'})`, validate status/redirect exactly as today, and read at most 64 KiB. Before reading, record only:

```js
function responseSignature(response) {
  const type = response.headers.get('content-type') || '';
  return {
    mimeFamily: /text\/html|application\/xhtml\+xml/i.test(type) ? 'html' : 'other',
    charset: type.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() || 'unspecified',
  };
}
```

Never retain or render the body bytes. `readBounded()` returns only byte count and cancels its reader in `finally`.

- [ ] **Step 5: Implement one-shot click capture**

For each accessible frame document, register a capture-phase listener only after the user presses `捕获下一次单元点击`:

```js
function armCapture(frames, onCapture) {
  const removers = [];
  const stop = () => removers.splice(0).forEach(remove => remove());
  for (const frame of frames) {
    const handler = event => {
      if (!event.isTrusted) return;
      const navigation = classifyNavigation(event.target, frame.url);
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      onCapture(navigation);
    };
    frame.document.addEventListener('click', handler, true);
    removers.push(() => frame.document.removeEventListener('click', handler, true));
  }
  return stop;
}
```

The overlay’s `取消捕获` and `关闭` actions must call `stop()`. Re-running the bookmarklet removes the old overlay and old listeners before creating a new result. The capture report includes no clicked text, DOM, handler source, URL, or query values.

- [ ] **Step 6: Render the sanitized structure report**

Render dynamic values only with `textContent`. Include:

```text
当前 frame 类型：<endpoint> [<sorted key names>]
预览链接数量：<integer>
预览响应：HTML；字符编码 <charset>
重复链接类型：
- href <endpoint> [<sorted key names>] × <count>
捕获的单元入口：href <endpoint> [<sorted key names>]
```

If no value exists, render `未识别`, not a fabricated endpoint. Keep the existing five feasibility booleans and privacy statement. Limit repeated route groups to the ten highest counts so the overlay and bookmarklet stay bounded.

Update `probe/index.html` with the exact workflow:

1. Drag `自包含测试` to the bookmark bar.
2. Open “单元学习” and expand a unit that visibly contains courseware.
3. Run the bookmarklet and press `捕获下一次单元点击`.
4. Click one other visible unit once; the probe intercepts it and does not change the page.
5. Send only a screenshot of the probe overlay. Do not send DevTools output, page source, full URLs, query values, course names, unit names, filenames, IDs, or account data.

- [ ] **Step 7: Build and run all probe checks**

Run:

```powershell
npm run test:probe
npm run build:probe
```

Expected: all probe tests pass; `dist/probe/bookmarklet-self-contained.txt` is under 8,000 characters.

Run the source/output privacy scan:

```powershell
node -e "const fs=require('node:fs');const s=['dist/probe/probe.js','dist/probe/bookmarklet-self-contained.txt'].map(fs.readFileSync).join('');for(const p of ['sendBeacon','XMLHttpRequest','localStorage','sessionStorage','indexedDB','navigator.clipboard','/meol/common/script/download.jsp'])if(s.includes(p))throw Error(p);console.log('probe privacy scan passed')"
```

Expected: `probe privacy scan passed`.

- [ ] **Step 8: Commit the extended probe**

```powershell
git add probe/probe.js probe/index.html tests/probe.test.js package.json
git commit -m "test: inspect THEOL unit study structure safely"
```

---

### Task 3: Publish the probe and execute the real-page gate

**Files:**
- Existing deployment: `.github/workflows/probe-pages.yml`
- Create after observation: `docs/unit-study-feasibility.md`

**Interfaces:**
- Consumes the Task 2 `dist/probe` artifact.
- Produces one of:
  - `UNIT_CURRENT_GO` when the current unit exposes at least one canonical existing preview URL and its metadata request returns HTML.
  - `UNIT_ALL_GO` when a user-selected unit control exposes a stable HTTPS school-origin route signature suitable for an explicit allowlist and a later bounded same-origin GET probe.
  - `UNIT_ALL_NEEDS_SECOND_PROBE` when the click is scripted or the route cannot yet be validated.
  - `UNIT_STUDY_NO_GO` when current-unit resources do not expose a canonical preview entry.
- No production implementation starts from screenshot appearance alone.

- [ ] **Step 1: Verify the deployment workflow still publishes only probe assets**

Inspect `.github/workflows/probe-pages.yml` and require:

```text
build input: repository source
published path: dist/probe
permissions: contents read, pages write, id-token write
no secrets passed to the page build
```

Do not broaden Pages publication to `dist/extension`, browser profiles, `.playwright-cli`, `output`, or local files.

- [ ] **Step 2: Push the reviewed probe commits**

Run only after reviewing both commits and confirming a clean working tree:

```powershell
git status --short
git push origin codex/bookmarklet-probe
```

Expected: the GitHub Actions probe deployment succeeds for the pushed commit. Do not force-push.

- [ ] **Step 3: Verify the public artifact without a logged-in school session**

Run:

```powershell
curl.exe -fsS https://vg188.github.io/THEOL-downloader/ -o NUL
```

Expected: exit code 0.

Open the public page in an ordinary browser and verify both draggable links exist. This check proves publication only; it does not prove THEOL compatibility.

- [ ] **Step 4: Ask the user to run the current-unit gate**

Ask the authorized user to:

1. Hard-refresh the public probe page and replace the old self-contained bookmark.
2. Open a THEOL “单元学习” page where the current expanded unit visibly lists at least one PDF/PPT/PPTX.
3. Run the bookmarklet.
4. Confirm the overlay reports `预览链接数量` greater than zero and `预览元数据请求：成功`.
5. Send only the overlay screenshot.

Expected decision:

```text
previewCount > 0 and metadata = true and response.mimeFamily = html
=> UNIT_CURRENT_GO
otherwise
=> UNIT_STUDY_NO_GO
```

- [ ] **Step 5: Ask the user to capture one alternate unit entry**

In the same overlay, ask the user to press `捕获下一次单元点击`, then click a different visible unit once. The probe must prevent navigation and show only the sanitized classification.

Expected decision:

```text
capturedNavigation.mechanism = href or form
and capturedNavigation.route.endpoint is a fixed school pathname
and capturedNavigation.route.queryKeys is a stable finite key set
=> UNIT_ALL_GO for production-plan allowlisting

capturedNavigation.mechanism = scripted or route = null
=> UNIT_ALL_NEEDS_SECOND_PROBE
```

A scripted result does not authorize reading `onclick`, executing handlers, automatically clicking units, or allowing arbitrary same-origin URLs.

- [ ] **Step 6: Record only non-sensitive evidence**

Create `docs/unit-study-feasibility.md` with this fixed structure and observed sanitized values:

```markdown
# THEOL Unit Study Feasibility

**Date:** 2026-09-12
**Browser:** Chrome 120+
**Probe mode:** self-contained bookmarklet

## Current unit

- Same-origin frame access: pass/fail
- Canonical existing preview links present: pass/fail
- Preview metadata response: pass/fail
- MIME family: html/other/unavailable
- Declared charset: observed label or unspecified

## All units

- Captured mechanism: href/form/scripted/unavailable
- Endpoint type: sanitized pathname or unavailable
- Query-key set: sorted key names or unavailable
- No navigation executed by probe: pass/fail

## Privacy boundary

- Courseware body requests: none
- Upload or telemetry: none
- Stored page/user data: none
- Full URLs, query values, names, filenames, and IDs recorded: none

## Decision

- Current unit: UNIT_CURRENT_GO or UNIT_STUDY_NO_GO
- All units: UNIT_ALL_GO, UNIT_ALL_NEEDS_SECOND_PROBE, or UNIT_STUDY_NO_GO
```

Do not add screenshots, course identifiers, resource identifiers, names, filenames, response bodies, full URLs, Cookie values, or query values to Git.

- [ ] **Step 7: Validate and commit the gate evidence**

Run:

```powershell
git diff --check
git diff -- docs/unit-study-feasibility.md
```

Expected: only sanitized capability evidence and decisions appear.

Commit:

```powershell
git add docs/unit-study-feasibility.md
git commit -m "docs: record unit study feasibility gate"
```

- [ ] **Step 8: Stop or transition based on the gate**

- `UNIT_STUDY_NO_GO`: stop; do not modify production parsers or UI.
- `UNIT_ALL_NEEDS_SECOND_PROBE`: write a second, route-specific metadata-only probe plan; do not auto-click or inspect handler source.
- `UNIT_CURRENT_GO` only: write a production plan for current-unit support, leaving “全部单元” disabled.
- `UNIT_CURRENT_GO` plus `UNIT_ALL_GO`: write the full production plan covering the shared parser, limited-concurrency unit fetcher, extension bridge/UI, self-contained bookmarklet integration, regression tests, documentation, build, and real one-file download acceptance.

The follow-up production plan must copy the observed endpoint pathname and exact sorted query-key allowlist from `docs/unit-study-feasibility.md`. It must not use placeholders, wildcard JSP acceptance, arbitrary same-origin fetches, inferred IDs, or screenshot-derived routes.
