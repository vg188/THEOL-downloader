// Landing-page enhancement only. Nothing is fetched and nothing is sent: the page
// stays fully readable and the draggable bookmarklet still installs with this file
// missing. It only (1) copies the real javascript: code for users who cannot drag
// the anchor, and (2) stops a click on that anchor from running the bookmarklet on
// this site, which is not a THEOL page.
(function () {
  'use strict';

  var install = document.getElementById('bookmarklet-install');
  var copyButton = document.getElementById('copy-bookmarklet');
  var status = document.getElementById('copy-status');
  if (!install || !copyButton || !status) return;

  var COPIED = '已复制书签代码。请在书签管理器或书签栏新建一个书签，把代码粘贴到“网址”一栏。';
  var COPY_FAILED = '自动复制失败：请右键“拖到书签栏”按钮，选择“复制链接地址”，再手动新建书签。';
  var DRAG_HINT = '书签需要拖到书签栏才能安装，请勿在本页点击。手机或平板不支持拖拽安装，请改用桌面浏览器或完整版插件。';

  function announce(message) { status.textContent = message; }

  function copyFromHiddenField(value) {
    if (typeof document.execCommand !== 'function') return false;
    var field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    document.body.appendChild(field);
    var copied = false;
    try {
      field.select();
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    field.remove();
    return copied;
  }

  async function copyBookmarkletCode() {
    var code = install.getAttribute('href') || '';
    if (!code) return false;
    var clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(code);
        return true;
      } catch (error) {
        // Insecure context or a denied permission: fall back to the manual path.
      }
    }
    return copyFromHiddenField(code);
  }

  copyButton.addEventListener('click', async function () {
    announce(await copyBookmarkletCode() ? COPIED : COPY_FAILED);
  });

  install.addEventListener('click', function (event) {
    event.preventDefault();
    announce(DRAG_HINT);
  });
})();
