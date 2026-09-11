# BUCT Course Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可安装的 Chrome 扩展，在用户已登录的北化教学平台当前资源列表中选择并下载 PDF、PPT、PPTX 原文件。

**Architecture:** 用纯函数解析平台 URL、目录、预览页和 Windows 文件名。按需注入的内容脚本在同源资源 frame 内扫描；后台负责会话状态、可信消息边界和持久化下载队列；弹出面板只负责选择和展示。

**Tech Stack:** Chrome Manifest V3；原生 JavaScript ES modules、HTML、CSS；Node.js 内置测试运行器；jsdom 仅用于开发测试；esbuild 仅用于构建；Python 标准库用于发布 ZIP。

## Global Constraints

- 首版只处理当前目录已经加载的资源列表，不自动进入子目录、不自动翻页、不跨课程扫描。
- PDF、PPT、PPTX 按扩展名识别，不区分大小写。
- 元数据请求最多同时进行 3 个，每个请求超时为 15 秒；单个失败不阻断其余文件。
- 下载最多同时进行 2 个；其余排队。
- 初次扫描完成时不默认勾选任何文件。
- 保存位置是 Chrome 配置的下载根目录下的“课程名/原始文件名”。
- 同名文件由 Chrome 自动追加编号，不覆盖已有文件。
- 扩展权限固定为 `scripting`、`downloads`、`storage`，站点权限仅为 `https://course.buct.edu.cn/*`。
- 运行时使用原生 JavaScript、HTML、CSS 和 Chrome 扩展 API，不引入运行时第三方库；允许使用开发和测试工具。
- 不读取、复制或保存 Cookie，不收集账号密码，不访问登录表单字段。
- 本地浏览器调试记录不进入 Git，也不进入扩展发布包。
- 关闭弹出面板不终止已提交队列；浏览器重启不自动恢复尚未交给 Chrome 的排队项。

## Execution

在当前会话顺序执行并逐项自检，不启动子代理。当前环境未安装上方引用的执行子技能，采用相同的逐项实现、测试和检查点流程，不伪称调用过不存在的技能。

## File Map

| Path | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json` | 开发依赖与 test/build/package 命令 |
| `src/platform/policy.js` | 学校域名、规范化资源标识、文件类型、文件路径、错误类型 |
| `src/platform/parse.js` | DOM → 当前目录与预览文件元数据 |
| `src/platform/scan.js` | 3 并发预览扫描、超时、进度、单项失败隔离 |
| `src/content.js` | 在隔离世界按需安装 describe/scan API，不监听页面脚本事件 |
| `src/background/bridge.js` | Chrome 脚本注入、唯一目录定位、扫描消息验证 |
| `src/background/preflight.js` | 下载前有限读取文件头并验证原文件格式 |
| `src/background/queue.js` | 会话队列、并发、幂等、重试、恢复和下载记录校对 |
| `src/background.js` | 扩展消息路由、存储适配、Chrome 事件接线 |
| `src/popup/model.js` | 选择、搜索、格式筛选、全选语义 |
| `src/popup/view.js`, `src/popup/main.js` | 安全 DOM 渲染及 Chrome 通信 |
| `public/manifest.json`, `public/popup.html`, `public/popup.css` | 发布清单和静态界面 |
| `scripts/build.mjs`, `scripts/icons.mjs`, `scripts/package.py` | 确定性构建、图标、白名单 ZIP 打包 |
| `tests/*.test.js`, `tests/helpers/*.js` | 解析、扫描、队列、桥接、界面和发布验证 |
| `README.md`, `docs/verification.md` | 中文安装使用及真实测试结果 |
| `dist/extension/`, `dist/buct-course-downloader.zip` | 生成的可加载目录和安装包，Git 忽略 |

## Shared Data and Message Contracts

- `Resource`: `{id, courseId, resId, fileId, title, previewUrl}`，ID 为 `courseId:resId:fileId`，所有数字标识均为十进制字符串。
- `Directory`: `{courseId, folderId, url, key, resources}`，key 包含目录标识及本页按顺序出现的资源 ID；不只凭文件夹 ID 判断页面是否变化。
- `FileRecord`: Resource 加 `{name, extension, sizeText, downloadUrl, courseName}`。大小缺失为“大小未知”；名称保留原扩展名。
- `Context`: `{tabId, frameId, documentId, courseId, folderId, key, courseName, url}`。
- `ScanState`: `{id, phase, context, files, failures, total, processed, skipped, message, errorCode}`；phase 为 idle/scanning/ready/error。
- `QueueState`: `{jobs, requests}`；`Job` 为 `{id, file, status, downloadId, createdAt, startedAt, bytesReceived, totalBytes, error, errorCode}`；status 为 queued/preparing/downloading/complete/failed。
- 扩展界面请求：`GET_STATE {tabId}`、`START_SCAN {tabId}`、`DOWNLOAD_SELECTED {tabId, scanId, ids, requestId}`、`RETRY_FAILED {ids}`、`SHOW_DOWNLOAD {id}`。
- 内容脚本只发送 `SCAN_EVENT {scanId, event}`。event 含 kind=progress/complete/fatal；progress 含 processed/total，以及 file、failure、skipped 中的一项。
- 返回值统一为 `{ok:true, data}` 或 `{ok:false, error:{code,message}}`；不把堆栈、请求头、Cookie 或响应全文发给界面。
- 错误码：UNSUPPORTED_PAGE、NO_DIRECTORY、AMBIGUOUS_DIRECTORY、INVALID_URL、INVALID_RESOURCE、LOGIN_REQUIRED、NO_DOWNLOAD、UNSUPPORTED_TYPE、NETWORK、TIMEOUT、STALE_SCAN、INVALID_MESSAGE、BAD_FILE、CANCELLED、INTERRUPTED、RECOVERY_REQUIRED。

---

## Task 1: Safe platform parsing and developer test harness

**Files:** Create package files, `src/platform/policy.js`, `src/platform/parse.js`, `tests/platform.test.js`, `tests/helpers/dom.js`.

**Interfaces:**
- `normalizeResourceUrl(input, kind, base)` → Resource identity plus `url`; kind is preview/download.
- `parseDirectory(document, pageUrl)` → Directory or null.
- `parsePreview(document, resource)` → FileRecord without courseName; throws AppError for unsupported or unavailable resources.
- `validateFile(file)` → validated FileRecord; `buildFilename(courseName, name)` → safe relative Chrome filename.
- `AppError(code, message)` and `errorResult(error)` define structured errors for every later task.

- [ ] **1. Write executable parser tests and install only development dependencies.**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {parseDirectory, parsePreview} from '../src/platform/parse.js';
import {buildFilename} from '../src/platform/policy.js';

test('unlabelled resource link resolves to original PPT', () => {
  const base = 'https://course.buct.edu.cn/meol/common/script/listview.jsp?lid=12&folderid=34';
  const document = new JSDOM('<a href="preview/download_preview.jsp?fileid=56&resid=78&lid=12">第一章</a>').window.document;
  const directory = parseDirectory(document, base);
  assert.equal(directory.resources[0].id, '12:78:56');
  const preview = new JSDOM('<h2>文件名:第一章.PPT (9.1M)<a href="/meol/common/script/download.jsp?fileid=56&resid=78&lid=12">下载</a></h2>').window.document;
  const file = parsePreview(preview, directory.resources[0]);
  assert.equal(file.extension, 'ppt');
  assert.equal(buildFilename('电路', file.name), '电路/第一章.PPT');
});
```

Commands: `npm install --save-dev esbuild jsdom`; `node --test tests/platform.test.js`. Before implementation the test must fail because the imported source modules do not exist.

- [ ] **2. Implement strict URL/identity parsing and DOM parsing.**

Only accept the observed preview and download paths on the exact HTTPS origin. Remove session path parameters and unknown query fields from accepted links; require single positive numeric fileid/resid/lid values, no credentials. Do not create a download URL from a preview URL when the HTML has no actual download link. The download identity must equal the preview identity. Derive the filename from the preview heading, strip its label and trailing displayed size, and determine the extension from that name, not the resource title.

Core identity algorithm:

```js
const id = `${courseId}:${resId}:${fileId}`;
const extension = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
if (!new Set(['pdf', 'ppt', 'pptx']).has(extension)) {
  throw new AppError('UNSUPPORTED_TYPE', '不是 PDF、PPT 或 PPTX，已跳过');
}
```

Filename policy replaces invalid characters inside each segment, neutralizes dot/absolute paths, reserved device names and trailing dots/spaces, preserves extensions and prevents overwrites through `conflictAction: 'uniquify'` in Task 3. The directory fingerprint includes the actual current resource IDs so pagination/DOM changes invalidate old selection.

- [ ] **3. Add and pass cases for duplicate links, outside hosts, userinfo, JavaScript URLs, mismatched IDs, encoded path attacks, absent size, parentheses in names, uppercase formats, no download link, login HTML, hostile HTML labels and Windows reserved names.**

Run `node --test tests/platform.test.js`; commit only the explicit package, source and test paths with message `feat: parse THEOL resources and safe download paths`.

## Task 2: Current-frame scanner and verified bridge

**Files:** Create `src/platform/scan.js`, `src/content.js`, `src/background/bridge.js`, `tests/scanner.test.js`, `tests/bridge.test.js`.

**Interfaces:**
- Consumes Task 1 parsers and types.
- `scanResources(resources, {fetcher, parseDocument, onProgress, signal, timeoutMs})` → `{processed,total,skipped,files,failures}`.
- `createBridge(chrome, {readScan, writeScan})` → `{inspect(tabId), start(tabId), receive(message,sender), assertCurrent(tabId,scanId)}`.
- Isolated-world API `globalThis.__BUCT_COURSE_V1__` exposes `describe()` and asynchronous `scan(scanId)` only.

- [ ] **1. Test parallelism and partial failure before implementation.**

```js
const events = [];
const result = await scanResources(resources, {
  fetcher,
  parseDocument: html => new JSDOM(html).window.document,
  onProgress: event => events.push(event),
  timeoutMs: 20,
});
assert.ok(maxConcurrent <= 3);
assert.equal(result.processed, resources.length);
assert.equal(result.files.length + result.failures.length + result.skipped, resources.length);
```

Fixtures define three valid resources, one non-courseware resource, one rejection, and one request that waits for its abort signal. Verify the slow request times out while valid resources complete. Run `node --test tests/scanner.test.js tests/bridge.test.js` and observe missing-module failure.

- [ ] **2. Implement 3 workers with per-request AbortController and complete response-body timeout coverage.**

Use same-origin credentialed GET for the observed preview link, refuse redirects and non-HTML responses, parse via DOMParser without executing scripts, and await each progress notification. Completion is emitted only after all workers and progress notifications settle. Return failures with resource title/id and safe error code, never HTML bodies.

- [ ] **3. Implement on-demand all-frame injection and context validation.**

```js
await chrome.scripting.executeScript({target: {tabId, allFrames: true}, files: ['content.js']});
const frames = await chrome.scripting.executeScript({
  target: {tabId, allFrames: true},
  func: () => globalThis.__BUCT_COURSE_V1__?.describe(),
});
```

Choose exactly one list frame compatible with the top-level courseId. Capture frameId and documentId from Chrome, not from page data. Reject ambiguity and non-school tabs. Read the course name from the course document title; use “课件” when unknown. Persist scan state before starting detached work. Accept SCAN_EVENT only for the current scanId, expected tab/frame/document, exact origin and resource IDs discovered in that list. Deduplicate progress items. Ignore late events from previous scans. Before enqueue, inspect the current directory again and reject stale fingerprints. Only popup.html may initiate privileged UI messages.

- [ ] **4. Run scanner/bridge tests, including detached popup, stale scan event, cross-frame sender, multiple directories, top-level course mismatch and directory change. Commit explicit Task 2 files.**

## Task 3: Durable, validated native-download queue

**Files:** Create `src/background/preflight.js`, `src/background/queue.js`, `tests/queue.test.js`, `tests/preflight.test.js`, `tests/helpers/downloads.js`.

**Interfaces:**
- `preflight(file, {fetcher, timeoutMs})` → `{mime}` or AppError.
- `createQueue({storage,downloads,preflight,extensionId,clock,makeId})` → asynchronous `{init,enqueue,retry,refresh,getState}`.
- `storage.read()` / `storage.write(QueueState)` use Chrome session storage. `downloads` exposes Promise-based download/search/cancel/show methods.
- `enqueue(files, requestId)` returns state, reserving only non-active file identities. `retry(jobIds)` only retries failed jobs. `refresh()` reconciles native records and pumps free slots.

- [ ] **1. Write tests before implementation.**

```js
await queue.init();
await queue.enqueue(files, 'request-one');
await settle();
assert.equal(downloads.activeCount(), 2);
await queue.enqueue(files, 'request-one');
assert.equal((await queue.getState()).jobs.length, files.length);
downloads.completeFirst();
await queue.refresh();
await settle();
assert.equal(downloads.activeCount(), 2);
```

The fake implements real state transitions and extension ownership. Cover failed preflight, rejected download API, immediate completion before event processing, cancelled task, worker recovery, missing native records and retry. Run `node --test tests/queue.test.js tests/preflight.test.js` and confirm source-module failure.

- [ ] **2. Implement GET-based bounded preflight, not HEAD.**

Real-platform investigation on 2026-09-11 found HEAD returns 403, but a normal authenticated GET returns a valid PPT with MIME `application/vnd.ms-powerpoint` and OLE header. Send GET with `Range: bytes=0-1023`, read at most 1024 bytes and cancel the reader/abort the request even when the server ignores Range. Do not buffer the complete file. Apply a 15-second timeout through body reading. Verify PDF `%PDF-`, legacy PPT OLE signature, or PPTX ZIP signature; reject HTML/JSON, authentication redirects, mismatched signatures, non-success status and outside-domain responses. Preflight happens only after explicit selection, including each retry.

- [ ] **3. Implement persisted reservations and native downloads.**

```js
const downloadId = await downloads.download({
  url: file.downloadUrl,
  filename: buildFilename(file.courseName, file.name),
  conflictAction: 'uniquify',
  saveAs: false,
});
```

A serialized mutation queue protects state writes. Reserve at most two queued jobs as preparing and persist before asynchronous preflight. Do not hold a mutation lock during network reads. Save startedAt before calling Chrome; save downloadId immediately after. Check the native record after creation to catch fast completion. Native completion/interruption events free slots. Reconcile bytes only while the popup asks for state; do not depend on background polling timers. On worker recovery adopt an unambiguous extension-owned matching native download created after startedAt; otherwise mark an interrupted preparing task retryable rather than blindly downloading twice. Persist request IDs for repeated-message idempotency. Native records with an unexpected final URL or HTML/JSON MIME fail, rather than being labelled valid courseware.

- [ ] **4. Run queue/preflight tests, including proof that range-ignoring streams are cancelled, current-session recovery works, double clicks do not duplicate, completed files can be explicitly requested again, and no more than two slots are reserved. Commit explicit Task 3 files.**

## Task 4: Accessible popup, Chrome entry points and deterministic build

**Files:** Create popup source/public files, `src/background.js`, build/icon scripts and `tests/popup.test.js`, `tests/package.test.js`.

**Interfaces:**
- `createSelection()` exposes `{reset, toggle, toggleVisible, visible, selectedIds}`. Search/format changes preserve hidden selections; reset uses scanId/context changes.
- `mountPopup({document, send, subscribe, activeTab})` binds UI with a cleanup function, without importing browser globals into its testable model.
- Chrome service worker instantiates bridge and queue, registers event listeners synchronously, and routes only the contract messages above.

- [ ] **1. Test selection and empty/error controls before implementation.**

```js
selection.toggle('12:78:56', true);
const filtered = selection.visible(files, '另一章', 'all');
selection.toggleVisible(filtered, true);
assert.ok(selection.selectedIds().includes('12:78:56'));
selection.reset('new-scan');
assert.deepEqual(selection.selectedIds(), []);
```

Also test native checkbox labels, no innerHTML insertion of file names, disabled download with no selection, download submission busy state, retry of failed jobs only, keyboard activation and selection reset after rescan. Run `node --test tests/popup.test.js` before implementing its imports.

- [ ] **2. Build the compact tool interface and runtime wiring.**

Use a pure-white 440px popup with native system/Chinese fonts, restrained warm-red primary derived from seed hue 35°, neutral toolbars and dividers, visible focus rings, no display typography or remote assets. The course title and current-list scope lead; files occupy the main scroll area; search and PDF/PPT filters sit above it; the selected count and primary button stay at the bottom. Distinguish file format by text, not color alone. Use textContent, createElement, labelled native checkboxes, aria-live for scan/result messages, polite progress updates and reduced-motion support. A separate “下载记录” tab preserves visibility of jobs from an earlier folder.

A secondary small “Chrome 下载” link opens the native manager. Do not falsely promise a directory chooser. Tell users “保存到 Chrome 下载目录 / 课程名” and “关闭面板后下载继续”。

Wire downloads.onChanged/onErased to queue refresh; persist state in trusted session storage keys. GET_STATE validates current context and returns both scan and queue. DOWNLOAD_SELECTED obtains files from stored validated scan state, never from UI-supplied URLs. Poll native bytes while the popup is open; use storage change events for scan changes. Other browser tabs remain untouched.

- [ ] **3. Build a loadable extension with a fixed asset allowlist.**

esbuild bundles content.js as IIFE, background.js as module and popup.js as module, with no third-party runtime libraries. Copy public files and generate local PNG icons at 16/32/48/128 pixels using a standard-library PNG writer. Manifest uses only the three approved permissions and exact host. Build into dist/extension; do not recursively delete computed paths. The package test checks all required files, permissions, CSP and absence of remote scripts/debug artifacts.

- [ ] **4. Run `npm test`, `npm run build`; inspect the built popup at 440px and 360px, keyboard focus, long Chinese names and all states in a real browser. Commit explicit Task 4 source/tests/scripts/public paths.**

## Task 5: Real-site verification, documentation and release

**Files:** Create `README.md`, `docs/verification.md`, `scripts/package.py`; update this plan with checked steps.

- [ ] **1. Load dist/extension into the existing manually authenticated test Chrome.**

Use Chrome's extension page or a supported unpacked-extension debugging API; do not relaunch or export the user's cookies. Confirm the exact runtime extension ID from the loaded manifest; do not guess it. Exercise the actual popup/background/content interaction on the inspected course list. If a native file picker cannot be automated safely, ask the user for that one installation action while continuing all independent tests.

- [ ] **2. Verify a small selected sample.**

Scan without automatically checking any row. Compare observed names/formats to the platform. Select one PPT, submit through the real extension, observe native completion, compare the saved original signature/name and size. Keep test downloads in an explicitly named workspace test directory configured only for this independent automated browser, not the user's ordinary Chrome profile. Verify that closing/reopening the popup preserves the job and that reloading a different folder clears selection. Record actual results and untested constraints separately.

- [ ] **3. Write concise installation and use documentation.**

README explains unpacking, chrome://extensions, developer mode, loading dist/extension, pinning, logging in, opening a resource directory, scanning and selecting. Explain current-page-only scope, file naming, duplicate handling, Chrome save prompts, 15-second request timeout, metadata failures, session expiry and browser-restart limits. State that this is not an official school extension. Describe the optional bounded preflight and its potential to increment the platform download counter even before Chrome's full transfer.

- [ ] **4. Create and verify the ZIP from the same build allowlist.**

Use Python zipfile; store only manifest, HTML/CSS, three bundles and the four PNG icons at the ZIP root. No source, node_modules, tests, logs, credentials or downloaded courseware. Run `npm test`, `npm run build`, `npm run package`, list ZIP contents, run `git diff --check`, and record the final test summary and remaining live-test limitations in docs/verification.md.

- [ ] **5. Commit documentation and test additions; deliver absolute links to the loadable folder, ZIP and README, with a short verified-features summary.**

## Self-review

- Spec coverage: Tasks 1–2 cover scope/metadata and safe DOM; Task 3 covers durable downloads/naming/retry/auth; Task 4 covers interaction/accessibility/permissions; Task 5 covers native installation, real originals and clean distribution.
- Interfaces: all consumers use the types and signatures listed above; popup IDs refer to stored files/jobs, not arbitrary URLs.
- Privacy: no live page HTML, login state, real account identifiers or raw network trace is included in this plan or in distributable artifacts.