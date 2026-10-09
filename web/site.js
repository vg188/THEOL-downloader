// Installation helpers only: no network, account access, telemetry or course scanning.
(function () {
  'use strict';
  var install = document.getElementById('bookmarklet-install');
  if (!install) return;
  var data = window.__BOOKMARKLET__ || {};
  var copyButton = document.getElementById('copy-bookmarklet');
  var status = document.getElementById('copy-status');
  var stamp = document.getElementById('bookmarklet-stamp');
  var manual = document.getElementById('manual-code');
  var textarea = document.getElementById('bookmarklet-code');
  if (typeof data.href === 'string' && data.href.indexOf('javascript:') === 0) install.setAttribute('href', data.href);
  if (stamp && data.stamp) stamp.textContent = data.stamp;

  function announce(message, error) {
    if (!status) return;
    status.textContent = message;
    status.dataset.error = error ? 'true' : 'false';
  }
  function legacyCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-label', '临时复制内容');
    field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    var focused = document.activeElement;
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand('copy') === true; }
    catch (error) { copied = false; }
    finally { field.remove(); if (focused && typeof focused.focus === 'function') focused.focus({ preventScroll: true }); }
    return copied;
  }
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch (error) { /* A denied Clipboard permission still has a manual fallback. */ }
    }
    return legacyCopy(text);
  }
  if (copyButton) copyButton.addEventListener('click', async function () {
    var href = install.getAttribute('href') || '';
    if (href.indexOf('javascript:') !== 0) { announce('书签代码未就绪，请刷新页面；也可以下载 Chrome 扩展。', true); return; }
    copyButton.disabled = true;
    try {
      if (await copyText(href)) announce('已复制。新建书签，名称填“课程资源助手”，把代码粘贴到“网址”栏。');
      else {
        if (manual && textarea) {
          textarea.value = href; manual.hidden = false; manual.open = true;
          textarea.focus(); textarea.select();
        }
        announce('浏览器未允许自动复制。完整代码已在下方选中，请按 Ctrl+C（macOS 用 ⌘C）手动复制。', true);
      }
    } finally { copyButton.disabled = false; }
  });
  install.addEventListener('click', function (event) {
    event.preventDefault();
    announce('请把这个按钮拖到书签栏，再到 THEOL 课程页点击书签使用。拖拽不方便时，可复制书签代码。');
  });
  var addressButton = document.getElementById('copy-extensions-url');
  var addressStatus = document.getElementById('extension-copy-status');
  if (addressButton) addressButton.addEventListener('click', async function () {
    addressButton.disabled = true;
    try {
      var success = await copyText('chrome://extensions');
      if (addressStatus) addressStatus.textContent = success ? '地址已复制，粘贴到浏览器地址栏打开。' : '自动复制不可用，请手动复制上面的 chrome://extensions。';
    } finally { addressButton.disabled = false; }
  });
})();
