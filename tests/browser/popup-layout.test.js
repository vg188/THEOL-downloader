import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildExtension } from '../../scripts/build.mjs';
import { installCourseFixture, measurePopup, openNativePopup } from './helpers/native-popup.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(root, 'output/playwright/popup-layout');
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => existsSync(path));

// The panel has no supported course tab in the preview page, so the range row
// and the confirmation are revealed directly: this measures layout only, while
// tests/popup.test.js owns the behavior.
function measureRangeUi() {
  const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
  const overflowY = selector => getComputedStyle(document.querySelector(selector)).overflowY;
  const dialog = document.querySelector('#all-units-dialog');
  return {
    width: innerWidth, height: innerHeight, modal: dialog.open === true,
    overflow: document.querySelector('.app').scrollWidth > document.querySelector('.app').clientWidth,
    row: rect('#scan-mode-row'), select: rect('#scan-mode'), scan: rect('#scan-button'), tabs: rect('.tabs'),
    dialog: rect('#all-units-dialog'), confirm: rect('#all-units-confirm'),
    files: rect('#files-panel .list-scroll'), history: rect('#history-panel .list-scroll'),
    filesOverflow: overflowY('#files-panel .list-scroll'), historyOverflow: overflowY('#history-panel .list-scroll'),
  };
}

function focusedElement() {
  const node = document.activeElement, style = getComputedStyle(node);
  return { id: node.id, outlineWidth: parseFloat(style.outlineWidth) || 0, outlineStyle: style.outlineStyle };
}

function assertRangeUi(metrics, expectedWidth, beforeDialog) {
  const box = value => [value.left, value.top, value.width, value.height].map(number => Math.round(number * 100) / 100 + 0);
  assert.equal(metrics.width, expectedWidth, 'preview keeps the requested width');
  assert.equal(metrics.modal, true, 'the confirmation uses a modal dialog');
  assert.equal(metrics.overflow, false, 'revealing the range control adds no horizontal overflow');
  assert.ok(metrics.scan.right <= expectedWidth + 1, 'the scan button still fits its row');
  assert.ok(metrics.row.top >= metrics.scan.bottom - 1 && metrics.row.bottom <= metrics.tabs.top + 1,
    'the range control owns the row between the course line and the tab bar');
  assert.ok(metrics.select.left >= -1 && metrics.select.right <= expectedWidth + 1, 'the range select fits the panel size');
  assert.ok(metrics.dialog.left >= -1 && metrics.dialog.right <= expectedWidth + 1, 'the dialog stays inside the viewport');
  assert.ok(metrics.dialog.width <= Math.min(320, expectedWidth - 32) + 1, 'the dialog keeps its narrow width: ' + metrics.dialog.width);
  assert.ok(metrics.dialog.top >= -1 && metrics.dialog.bottom <= metrics.height + 1, 'the dialog content stays reachable');
  assert.ok(metrics.confirm.height > 24 && metrics.confirm.bottom <= metrics.height + 1, 'the confirm button stays reachable');
  assert.deepEqual(box(metrics.files), box(beforeDialog), 'the modal overlays the file list instead of reflowing it');
  assert.equal(metrics.filesOverflow, 'auto', 'the file list keeps its scroll area');
  assert.equal(metrics.historyOverflow, 'auto', 'the history list keeps its scroll area');
  assert.ok(metrics.files.height > 0 && metrics.files.bottom <= metrics.height + 1, 'the file list fits the panel');
}

function assertVisible(metrics, expectedWidth = 440) {
  // Chrome may reserve a native scrollbar gutter when the display limits popup height.
  assert.ok(metrics.width >= expectedWidth && metrics.width <= expectedWidth + 16, 'native popup must not collapse to a narrow strip: ' + metrics.width);
  assert.equal(metrics.body.width, expectedWidth, 'popup content keeps its intended width');
  assert.ok(metrics.body.width <= metrics.width + 1, 'body fits the viewport');
  assert.ok(metrics.body.height <= metrics.height + 1, 'body fits the available height');
  assert.equal(metrics.horizontalOverflow, false, 'application has no horizontal overflow');
  for (const [name, rect] of Object.entries(metrics).filter(([, value]) => value?.bottom !== undefined)) {
    assert.ok(rect.left >= -1 && rect.right <= metrics.width + 1, name + ' fits horizontally');
    assert.ok(rect.top >= -1 && rect.bottom <= metrics.height + 1, name + ' fits vertically');
  }
}

for (const { scale, screenHeight } of [1, 1.25].flatMap(scale => [1080, 600].map(screenHeight => ({scale, screenHeight})))) {
  test('native action popup stays complete at scale ' + scale + ' on a ' + screenHeight + 'px display', { timeout: 60000 }, async t => {
    assert.ok(chrome, 'Install desktop Chrome or set CHROME_PATH to its executable');
    const extensionPath = await buildExtension();
    const height = screenHeight - 80;
    await mkdir(artifacts, { recursive: true });
    const profile = await mkdtemp(join(artifacts, 'profile-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: chrome, headless: true, viewport: null,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--enable-unsafe-extension-debugging', '--enable-automation',
          '--window-size=1280,' + height,
          '--screen-info={' + (1920 * scale) + 'x' + (screenHeight * scale) + '}',
          '--force-device-scale-factor=' + scale],
      });
      const browserSession = await context.browser().newBrowserCDPSession();
      const { id } = await browserSession.send('Extensions.loadUnpacked', { path: extensionPath });
      const fixture = await installCourseFixture(context);
      const page = context.pages()[0] || await context.newPage();
      await page.goto(fixture.origin + '/meol/jpk/course/layout/newpage/index.jsp?courseId=12');
      await page.frameLocator('#outer').frameLocator('#inner').locator('a').first().waitFor();
      let measurements;
      await page.bringToFront();
      const popup = await openNativePopup(context, browserSession, id);
      try {
        await popup.waitFor(() => !document.querySelector('#scan-button').disabled);
        await popup.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
        const before = await popup.evaluate(measurePopup);
        measurements = before;
        await writeFile(join(artifacts, 'native-' + scale + '-' + height + '-initial.png'), await popup.screenshot());
        assertVisible(before);
        if (screenHeight === 1080) {
          assert.equal(before.width, 440, 'native popup must not collapse to a narrow strip');
          assert.ok(before.footer.bottom <= before.height + 1, 'download footer must fit');
          assert.ok(before.download.right <= before.width + 1, 'download button must fit');
        }
        assert.equal(before.deviceScale, scale, 'native popup uses the requested device scale');
        if (screenHeight === 1080) assert.equal(before.height, 600, 'normal popup uses the intended 600px height');
        else assert.ok(before.height < 600, 'short-window case actually constrains the popup height');
        await popup.evaluate(() => document.querySelector('#scan-button').click());
        await popup.waitFor(count => document.querySelectorAll('.file-row').length === count
          && !document.querySelector('#scan-button').disabled, fixture.names.length);
        assert.equal(await popup.evaluate(() => document.querySelector('#download-button').disabled), true);
        await writeFile(join(artifacts, 'native-' + scale + '-' + height + '-list.png'), await popup.screenshot());
        assertVisible(await popup.evaluate(measurePopup));
        await popup.evaluate(() => {
          const checkbox = document.querySelector('.file-row:last-child input');
          checkbox.scrollIntoView({ block: 'nearest' });
        });
        const scrolled = await popup.evaluate(() => ({
          last: document.querySelector('.file-row:last-child input').getBoundingClientRect().toJSON(),
          list: document.querySelector('#files-panel .list-scroll').getBoundingClientRect().toJSON(),
        }));
        assert.ok(scrolled.last.top >= scrolled.list.top - 1 && scrolled.last.bottom <= scrolled.list.bottom + 1,
          'last checkbox is reachable (allow subpixel scroll rounding): ' + JSON.stringify(scrolled));
        await popup.evaluate(() => document.querySelector('.file-row:last-child input').click());
        assert.equal(await popup.evaluate(() => document.querySelector('#download-button').disabled), false);
        assertVisible(await popup.evaluate(measurePopup));
        await popup.evaluate(() => document.querySelector('#history-tab').click());
        await popup.waitFor(() => !document.querySelector('#history-panel').hidden);
        assertVisible(await popup.evaluate(measurePopup));
      } finally {
        await popup.close();
      }
      await page.bringToFront();
      const reopened = await openNativePopup(context, browserSession, id);
      try {
        await reopened.waitFor(count => document.querySelectorAll('.file-row').length === count, fixture.names.length);
        assertVisible(await reopened.evaluate(measurePopup));
        assert.equal(await reopened.evaluate(() => document.querySelector('#download-button').disabled), true,
          'reopening preserves scanned files but does not select or download automatically');
      } finally {
        await reopened.close();
      }
      const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'));
      assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), 0);
      assert.ok(!fixture.requests.some(url => new URL(url).pathname.endsWith('/download.jsp')), 'layout verification never requests an original file');
      const preview = await context.newPage();
      await preview.setViewportSize({ width: 360, height: 600 });
      await preview.bringToFront();
      await preview.goto('chrome-extension://' + id + '/popup.html');
      // Wait for the panel's first inspection: this preview tab is not a school
      // page, but the course tab may still be the active one.
      await preview.waitForFunction(() => document.querySelector('#course-name').textContent !== '等待课程页面'
        || document.querySelector('#empty-copy').textContent.includes('请先打开'));
      await preview.evaluate(() => document.fonts.ready);
      assertVisible(await preview.evaluate(measurePopup), 360);
      assert.equal(await preview.evaluate(() => document.querySelector('#all-units-dialog').hidden), true,
        'the unit confirmation stays closed until a unit range is confirmed');
      await preview.screenshot({ path: join(artifacts, 'preview-' + scale + '-' + screenHeight + '-360.png') });
      for (const width of [360, 440]) {
        await preview.setViewportSize({ width, height: 600 });
        const beforeDialog = await preview.evaluate(() => {
          document.querySelector('#scan-mode-row').hidden = false;
          document.querySelector('#scan-mode').hidden = false;
          return document.querySelector('#files-panel .list-scroll').getBoundingClientRect().toJSON();
        });
        await preview.evaluate(() => {
          document.querySelector('#all-units-copy').textContent = '将读取当前课程的 12 个单元页面，不会下载课件正文';
          const dialog = document.querySelector('#all-units-dialog');
          dialog.hidden = false;
          dialog.showModal();
        });
        await preview.waitForFunction(() => document.activeElement?.id === 'all-units-cancel', null, { timeout: 5000 });
        const metrics = await preview.evaluate(measureRangeUi);
        assertRangeUi(metrics, width, beforeDialog);
        if (width === 360) await preview.screenshot({ path: join(artifacts, 'dialog-' + scale + '-' + screenHeight + '-360.png') });
        await preview.keyboard.press('Tab');
        const confirmFocus = await preview.evaluate(focusedElement);
        assert.equal(confirmFocus.id, 'all-units-confirm', 'tab order reaches the confirm button');
        assert.ok(confirmFocus.outlineWidth > 0 && confirmFocus.outlineStyle !== 'none', `the focused button shows a visible focus ring: ${JSON.stringify(confirmFocus)}`);
        await preview.keyboard.press('Escape');
        await preview.waitForFunction(() => document.querySelector('#all-units-dialog').hidden === true);
        let focused = '';
        for (let attempt = 0; attempt < 12 && focused !== 'scan-mode'; attempt++) {
          await preview.keyboard.press('Tab');
          focused = await preview.evaluate(() => document.activeElement?.id || '');
        }
        assert.equal(focused, 'scan-mode', 'closing the dialog leaves the range control reachable by keyboard');
        const selectFocus = await preview.evaluate(focusedElement);
        // Chromium rounds outline widths to whole device pixels, so the ring is
        // asserted as visible rather than as an exact CSS pixel count.
        assert.ok(selectFocus.outlineWidth > 0 && selectFocus.outlineStyle !== 'none', `the focused range control shows a visible focus ring: ${JSON.stringify(selectFocus)}`);
      }
      await preview.screenshot({ path: join(artifacts, 'preview-' + scale + '-' + screenHeight + '-440.png') });
      await preview.close();
      await writeFile(join(artifacts, 'metrics-' + scale + '-' + screenHeight + '.json'), JSON.stringify({ browserVersion: context.browser().version(), scale, screenHeight, windowHeight: height, popup: measurements }, null, 2) + '\n');
      t.diagnostic('native dimensions: ' + measurements.width + 'x' + measurements.height);
      await browserSession.detach();
    } finally {
      await context?.close();
      // Only this test-created directory can be recursively removed, never another profile.
      const absoluteProfile = resolve(profile);
      if (!absoluteProfile.startsWith(resolve(artifacts) + sep) || !absoluteProfile.split(sep).at(-1).startsWith('profile-')) {
        throw new Error('Refusing to remove a profile outside the browser-test artifact directory');
      }
      await rm(absoluteProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
