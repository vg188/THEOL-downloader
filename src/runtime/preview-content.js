import { PDFDocument } from 'pdf-lib';
import { inspectFileContent } from './file-content.js';
import { problem } from './policy.js';

const cancelled = signal => { if (signal?.aborted) throw problem('CANCELLED', '操作已取消'); };
function dimensionsAllowed(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 16000000) throw problem('PREVIEW_LIMIT', '单页预览图片分辨率过大，已停止生成以保护浏览器内存');
}
/** Embed every supplied page at its native aspect ratio; never invent or silently omit pages. */
export async function renderPreviewBytes(file, { loadAsset, maxBytes, signal, onProgress = () => {} }) {
  cancelled(signal);
  if (file.preview.kind === 'text') {
    const bytes = new TextEncoder().encode('\uFEFF' + file.preview.text + '\n');
    if (bytes.length > maxBytes) throw problem('OVER_BUDGET', '在线文本超过剩余内存预算');
    return bytes;
  }
  if (file.preview.kind === 'html') {
    const data = []; let sourceBytes = 0;
    for (const [index, url] of file.preview.images.entries()) {
      cancelled(signal); onProgress({ file, stage: 'preview', page: index + 1, pages: file.preview.images.length });
      const { bytes, contentType } = await loadAsset(url, Math.max(0, maxBytes - sourceBytes)); sourceBytes += bytes.length;
      const ext = bytes[0] === 137 ? 'png' : 'jpg'; inspectFileContent(bytes, { name: 'preview.' + ext }, { contentType, complete: true });
      const chunks = []; for (let p = 0; p < bytes.length; p += 16384) chunks.push(String.fromCharCode(...bytes.subarray(p, p + 16384)));
      data.push('data:image/' + (ext === 'png' ? 'png' : 'jpeg') + ';base64,' + btoa(chunks.join('')));
    }
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const html = file.preview.html.replace(/<img src="buct-preview-image:(\d+)"/g, (_, index) => {
      if (!data[Number(index)]) throw problem('BAD_PREVIEW', '富文本预览缺少图片，未生成不完整文件');
      return '<img src="' + data[Number(index)] + '"';
    });
    const title = escape(file.name);
    const document = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{max-width:72rem;margin:2rem auto;padding:0 1rem;color:#17212b;font:16px/1.7 system-ui,sans-serif}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #aeb8c4;padding:.4rem .6rem}pre{white-space:pre-wrap}a{color:#1456a0}.source-note{color:#52606e;border-bottom:1px solid #ccd3dc;padding-bottom:1rem}</style></head><body><p class="source-note">平台富文本预览副本：保留平台提供的正文、表格和图片，不是原始 Word 文件。</p>' + html + '</body></html>';
    cancelled(signal); const bytes = new TextEncoder().encode(document);
    if (bytes.length > maxBytes) throw problem('OVER_BUDGET', '离线 HTML 超过剩余内存预算'); return bytes;
  }
  const pdf = await PDFDocument.create();
  pdf.setTitle(file.name); pdf.setAuthor('课程资源助手'); pdf.setCreator('Course Resource Assistant');
  pdf.setProducer('Course Resource Assistant / pdf-lib');
  pdf.setSubject('平台预览副本；仅含平台提供的 ' + file.preview.pages.length + ' 页图片，不是原始课件');
  pdf.setCreationDate(new Date(0)); pdf.setModificationDate(new Date(0));
  let sourceBytes = 0;
  for (const [index, url] of file.preview.pages.entries()) {
    cancelled(signal);
    onProgress({ file, stage: 'preview', page: index + 1, pages: file.preview.pages.length });
    try {
      const { bytes, contentType } = await loadAsset(url, Math.max(0, maxBytes - sourceBytes));
      sourceBytes += bytes.length; cancelled(signal);
      const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw problem('BAD_PREVIEW_IMAGE', '平台返回的不是 PNG 或 JPEG 预览图片');
      inspectFileContent(bytes, { name: 'preview.' + (png ? 'png' : 'jpg') }, { contentType, complete: true });
      if (png) {
        if (bytes.length < 24) throw problem('BAD_PREVIEW_IMAGE', 'PNG 图片信息不完整');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); dimensionsAllowed(view.getUint32(16), view.getUint32(20));
      }
      const image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      dimensionsAllowed(image.width, image.height);
      const width = image.width * 0.75, height = image.height * 0.75;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      await image.embed(); // Release decoded PNG pixels before reading the next page.
    } catch (error) {
      cancelled(signal);
      if (['OVER_BUDGET', 'PREVIEW_LIMIT', 'LOGIN_REQUIRED'].includes(error.code)) throw error;
      throw problem('PREVIEW_PAGE_FAILED', '第 ' + (index + 1) + ' / ' + file.preview.pages.length + ' 页预览读取失败，未生成缺页 PDF：' + (error.message || '图片损坏'));
    }
  }
  cancelled(signal);
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 25 });
  cancelled(signal);
  if (bytes.length > maxBytes) throw problem('OVER_BUDGET', '生成的预览 PDF 超过剩余内存预算');
  return bytes;
}
