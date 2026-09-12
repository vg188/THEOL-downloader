import { setTimeout as delay } from 'node:timers/promises';

// Action popups are separate Chrome targets, not ordinary Playwright pages.
// Never assign a viewport to this target: that would hide native autosizing bugs.
export async function openNativePopup(context, browserSession, extensionId) {
  const workerUrl = 'chrome-extension://' + extensionId + '/background.js';
  const worker = context.serviceWorkers().find(item => item.url() === workerUrl)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === workerUrl });
  await worker.evaluate(() => chrome.action.openPopup());
  const popupUrl = 'chrome-extension://' + extensionId + '/popup.html';
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const target = targetInfos.find(item => item.url === popupUrl);
  if (!target) throw new Error('Chrome did not create the native action popup');
  const { sessionId } = await browserSession.send('Target.attachToTarget', {
    targetId: target.targetId, flatten: false,
  });
  let nextId = 0;
  const pending = new Map();
  const receive = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  browserSession.on('Target.receivedMessageFromTarget', receive);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Native popup CDP timeout: ' + method));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    browserSession.send('Target.sendMessageToTarget', {
      sessionId, message: JSON.stringify({ id, method, params }),
    }).catch(error => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
  const evaluate = async (fn, arg = null) => {
    const result = await send('Runtime.evaluate', {
      expression: '(' + fn.toString() + ')(' + JSON.stringify(arg) + ')',
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  return {
    evaluate,
    async waitFor(predicate, arg = null) {
      const deadline = Date.now() + 10000;
      do {
        if (await evaluate(predicate, arg)) return;
        await delay(40);
      } while (Date.now() < deadline);
      throw new Error('Native popup condition timed out: ' + predicate.toString());
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
      });
      return Buffer.from(data, 'base64');
    },
    async close() {
      // A debugger-attached action popup can survive window.close(). Close this
      // exact native target and wait for its removal before opening another one.
      try {
        await browserSession.send('Target.closeTarget', { targetId: target.targetId });
        const deadline = Date.now() + 5000;
        do {
          const { targetInfos } = await browserSession.send('Target.getTargets');
          if (!targetInfos.some(item => item.targetId === target.targetId)) return;
          await delay(40);
        } while (Date.now() < deadline);
        throw new Error('Chrome did not close the native action popup');
      } finally {
        browserSession.off('Target.receivedMessageFromTarget', receive);
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Native popup closed'));
        }
        pending.clear();
      }
    },
  };
}

export function measurePopup() {
  const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
  return {
    width: innerWidth, height: innerHeight, deviceScale: devicePixelRatio,
    body: rect('body'), app: rect('.app'), footer: rect('.footer'),
    scan: rect('#scan-button'), download: rect('#download-button'),
    horizontalOverflow: document.querySelector('.app').scrollWidth > document.querySelector('.app').clientWidth,
  };
}

export async function installCourseFixture(context) {
  const origin = 'https://course.buct.edu.cn';
  const names = Array.from({ length: 18 }, (_, index) =>
    '第' + (index + 1) + '章 ' + (index === 1 ? '电路分析与模拟电子技术（中文长文件名布局回归样例）' : '课件布局测试')
    + '.' + ['pdf', 'ppt', 'pptx'][index % 3]);
  const link = (kind, index) => '/meol/common/script/'
    + (kind === 'preview' ? 'preview/download_preview.jsp' : 'download.jsp')
    + '?fileid=' + (index + 56) + '&resid=78&lid=12';
  const requests = [];
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    let html;
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('/newpage/index.jsp')) {
      html = '<title>网络课程—弹窗布局测试（模拟数据）</title><iframe id="outer" src="/qa-resource-frame.html"></iframe>';
    } else if (url.pathname === '/qa-resource-frame.html') {
      html = '<iframe id="inner" src="/meol/common/script/listview.jsp?lid=12&folderid=34"></iframe>';
    } else if (url.pathname.endsWith('/listview.jsp')) {
      html = names.map((name, index) => '<p><a href="' + link('preview', index) + '">资源 ' + (index + 1) + '</a></p>').join('');
    } else if (url.pathname.endsWith('/download_preview.jsp')) {
      const index = Number(url.searchParams.get('fileid')) - 56;
      if (!names[index]) return route.fulfill({ status: 404, body: 'Unknown fixture' });
      html = '<h2>文件名:' + names[index] + ' (1.2M)<a href="' + link('download', index) + '">下载</a></h2>';
    } else {
      return route.fulfill({ status: 404, body: 'No file downloads in layout tests' });
    }
    await route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + html + '</html>',
    });
  });
  return { origin, names, requests };
}
