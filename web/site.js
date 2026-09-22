(function () {
  var stampEl = document.getElementById('bookmarklet-stamp');
  var install = document.getElementById('bookmarklet-install');
  var copyBtn = document.getElementById('copy-bookmarklet');
  var status = document.getElementById('copy-status');
  if (!install) return;

  var data = window.__BOOKMARKLET__;
  if (data && data.href) {
    install.setAttribute('href', data.href);
  }
  if (stampEl) stampEl.textContent = (data && data.stamp) || '';

  function ok(msg) { if (status) status.textContent = msg; }
  function fail(msg) { if (status) status.textContent = msg; }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var href = install.getAttribute('href') || (data && data.href) || '';
      if (!href || href === '#') {
        fail('书签代码未就绪，请刷新页面');
        return;
      }
      function done() { ok('已复制书签代码，可在书签管理器新建书签并粘贴到网址栏'); }
      function nope() { fail('复制失败，请右键上方按钮 →「复制链接地址」'); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(href).then(done).catch(nope);
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = href;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          done();
        } catch (e) { nope(); }
      }
    });
  }

  install.addEventListener('click', function (e) {
    // 在官网点击时只提示安装方式，不执行书签
    e.preventDefault();
    ok('请把「课程资源助手」拖到书签栏，再到 THEOL 课程页点击使用');
  });
})();
