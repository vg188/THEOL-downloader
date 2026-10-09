# 官网重设计与 2.6.0 更新验收

日期：2026-10-09，Asia/Shanghai。

## 范围

- 重做 `web/index.html`、`web/site.css` 和 `web/privacy.html`，保留名称、主色、URL 与原有导航锚点。
- 使用本地原创 SVG 表达课程文件收纳与书签安装；没有使用真实课程截图、账号素材或外部字体。
- 书签版与 Chrome 扩展均可安装，明确 ZIP 与后台逐个下载的差别。
- 新版原格式资源流、整份 PDF、分页图片合成的顺序可见，实际格式与预览限制如实说明。
- 复制失败有完整代码备用区，不再把浏览器拒绝复制报告为成功。页面关闭脚本时仍可拖拽书签、下载扩展和阅读教程。

## 版本与安装包

版本：**2.6.0**。

`npm run build` 一次生成扩展、书签和官网。官网内置 `downloads/buct-course-downloader.zip` 与 `dist/buct-course-downloader.zip` 完全一致，`release.json` 记录版本、大小和 SHA-256。

- 安装包：751,871 字节，11 个白名单资产。
- SHA-256：`46462b566780009fba7ddf798c97971348c410b52fa6b0df0d067028dc9a275d`。
- 主打包器为 `scripts/package-release.mjs`，Python 入口保留兼容，转调同一实现。
- 构建不需要 Python；测试不依赖真实账号或课件。

## 验收

- 全量单元回归：**572 项通过**。
- 全量真实 Chrome 隔离测试：**9 项通过**。
- 官网浏览器验收覆盖 1440、1024、768、390、320 px，无页面横向溢出、无损坏图片，首屏安装 CTA 可见。
- 附加 200% CSS 缩放检查，无页面横向溢出。
- Tab 跳转、跳过导航、FAQ 键盘展开、复制成功与失败、无 JavaScript 均通过。
- 从实际页面点击扩展包并由 Chrome 原生保存，文件 SHA-256 与构建记录一致，包内 manifest 为 2.6.0。
- 按 GitHub Pages 的 `/THEOL-downloader/` 子路径运行检查，安装页、隐私页、插图、图标与下载链接均成功，无浏览器脚本错误或失败资源请求。
- 主文案、次级文案、按钮、淡蓝底文字的对比度均高于 4.5:1，支持 reduced-motion。
- Node 和兼容 Python 打包产物完全一致；原始课件、账号配置和浏览器验收材料不进入发布目录。

## 发布过程的构建修复

- Git 将纯文本结构的 PDF 样本误判为文本。新增 `.gitattributes`，明确 PDF、Office、图片和 ZIP 为二进制；源码与静态资产统一 LF，避免 Windows 与 CI 的换行转换改变文件字节。已核对暂存区样本与原文件 SHA-256 一致。
- 首次 GitHub Actions 部署在 `npm ci` 阶段访问 HTTP 镜像超时。锁文件的 73 个依赖下载地址统一改为官方 `https://registry.npmjs.org/`，依赖版本和完整性校验值保持不变；项目级 `.npmrc` 和新增构建回归防止镜像地址再次进入发布锁文件，不修改全局 npm 配置。
- 已使用空目录、空 npm 缓存完成一次 `npm ci`。修复后 572 项回归与发布构建通过，扩展 ZIP 的 SHA-256 保持不变。

## 发布与线上复核

发布分支为 `codex/bookmarklet-probe`，GitHub Pages 工作流通过 `npm ci`、`npm test` 和 `npm run build` 生成并部署官网及配套安装包。线上入口：[课程资源助手](https://vg188.github.io/THEOL-downloader/)。

2026-10-09 已纠正初次权限诊断：当时的 Node 子进程没有继承主终端的 GitHub 登录环境，导致推送预检返回 403，并非用户账号没有权限。主终端已确认登录为 `vg188`，具有该仓库的管理权限，`git push --dry-run` 通过；无需重新登录或修改凭据。

同日发布前复验：`npm test` 的 572 项回归、串行执行的 9 项 Chrome 浏览器测试和 `npm run build` 全部通过。提交仅包含项目源码、文档和合成测试样本；不包含 `.workbuddy/`、浏览器记录、账号配置或真实课件。

构建成功不等于已上线。发布验收需要确认 GitHub Pages 工作流成功，再核对线上 `release.json` 为 2.6.0、书签版本一致、实际下载包的 SHA-256 与发布记录相符，以及首页、隐私页和静态资源均可访问。

与课程下载相关的既有自动化浏览器配置问题仍单独记录在 [预览下载验收](preview-downloads.md)，不因官网本地安装包下载通过而改写其结论。
