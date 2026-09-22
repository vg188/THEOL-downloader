(function () {
  var stampEl = document.getElementById('bookmarklet-stamp');
  var install = document.getElementById('bookmarklet-install');
  var copyBtn = document.getElementById('copy-bookmarklet');
  var status = document.getElementById('copy-status');
  if (!install) return;

  // 由构建脚本写入 window.__BOOKMARKLET__ = { href, stamp }
  var data = window.__BOOKMARKLET__;
  if (!data || !data.href) {
    install.removeAttribute('href');
    install.textContent = '书签尚未构建';
    if (status) status.textContent = '请先运行 node web/build.mjs';
    return;
  }
  install.setAttribute('href', data.href);
  if (stampEl) stampEl.textContent = data.stamp || '';

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text = data.href;
      function ok() { if (status) status.textContent = '已复制书签代码'; }
      function fail() { if (status) status.textContent = '复制失败，请手动右键按钮复制链接地址'; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok).catch(fail);
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          ok();
        } catch (e) { fail(); }
      }
    });
  }

  install.addEventListener('click', function (e) {
    // 在本页点击时给出提示，避免误运行
    if (location.hostname.indexOf('github.io') !== -1 || location.protocol === 'file:') {
      e.preventDefault();
      if (status) status.textContent = '请把按钮拖到书签栏，然后到 THEOL 课程页点击使用';
    }
  });
})();
