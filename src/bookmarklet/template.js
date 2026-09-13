// The panel's isolated shell. `panel.css` is inlined by esbuild's `text` loader
// (`loader:{'.css':'text'}`) so the shipped bookmarklet is one self-contained
// `javascript:` URL: no <link>, no page stylesheet and no remote asset is ever
// requested for the panel.
import PANEL_CSS from './panel.css';

export { PANEL_CSS };

export const HOST_ID = '__theol_bookmarklet_panel_v1__';

// Static skeleton only. Every dynamic value is written with `textContent` by
// view.js, so course names, file names and platform messages can never become
// markup. Parsed through an inert <template>, which keeps the string literal
// here the single description of the panel's structure.
export const PANEL_HTML = `<section class="panel" role="dialog" aria-label="课件下载助手">
  <header class="head">
    <div>
      <h2 class="title">课件下载助手</h2>
      <p class="course" data-ref="course"></p>
    </div>
    <div class="head-actions">
      <button type="button" class="ghost" data-ref="close">关闭</button>
    </div>
  </header>
  <p class="notice" data-ref="notice" role="status" hidden></p>
  <p class="busy-note" data-ref="busyNote" hidden></p>
  <div class="controls">
    <button type="button" class="primary" data-ref="scan">扫描当前目录</button>
    <input type="search" class="search" data-ref="search" placeholder="搜索文件名" aria-label="搜索文件名" />
  </div>
  <div class="filters" role="group" aria-label="按格式筛选">
    <button type="button" class="chip" data-format="all" aria-pressed="true">全部</button>
    <button type="button" class="chip" data-format="pdf" aria-pressed="false">PDF</button>
    <button type="button" class="chip" data-format="ppt" aria-pressed="false">PPT</button>
    <button type="button" class="chip" data-format="pptx" aria-pressed="false">PPTX</button>
  </div>
  <div class="summary">
    <label class="select-all"><input type="checkbox" data-ref="all" />全选当前结果</label>
    <p class="counts" data-ref="counts"></p>
  </div>
  <p class="progress" data-ref="progress" role="status" hidden>
    <span data-ref="progressText"></span>
    <progress class="bar" data-ref="bar" max="1" value="0" hidden></progress>
  </p>
  <ul class="files" data-ref="files">
    <li class="empty" data-ref="empty"></li>
  </ul>
  <p class="failures" data-ref="failures" hidden></p>
  <p class="error" data-ref="error" role="alert" hidden></p>
  <section class="confirm" data-ref="confirm" aria-label="下载确认" hidden></section>
  <section class="result" data-ref="result" hidden></section>
  <footer class="footer">
    <button type="button" class="primary" data-ref="download">下载所选文件</button>
    <button type="button" class="ghost" data-ref="cancel" hidden>取消</button>
  </footer>
</section>
`;

function refMap(root) {
  const refs = {};
  for (const node of root.querySelectorAll('[data-ref]')) refs[node.dataset.ref] = node;
  return refs;
}

/**
 * Builds the detached panel host: one element carrying an open shadow root that
 * holds the inlined stylesheet and the skeleton markup. Nothing is attached to,
 * or read from, the page's own DOM.
 */
export function createPanelHost({ document: pageDocument, css = PANEL_CSS } = {}) {
  const host = pageDocument.createElement('div');
  host.id = HOST_ID;
  host.hidden = true;
  const root = host.attachShadow({ mode: 'open' });
  const style = pageDocument.createElement('style');
  style.textContent = css;
  const template = pageDocument.createElement('template');
  template.innerHTML = PANEL_HTML;
  root.append(style, template.content);
  return { host, root, style, refs: refMap(root) };
}
