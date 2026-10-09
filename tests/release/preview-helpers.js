import { zlibSync } from 'fflate';
import { crc32 } from '../../src/runtime/file-content.js';
import { findPreviewDownload } from '../../src/runtime/preview.js';
import { JSDOM } from 'jsdom';
import { ORIGIN, file } from './helpers.js';
export const WHOLE_PDF = ORIGIN + '/meol/data/convert/2026/10/9/complete.pdf';
export const MEDIA_URL = ORIGIN + '/dest/abc/lesson.mp4';
export const PAGE_URLS = [1, 2].map(n => ORIGIN + '/meol/data/convert/2026/10/9/page_slide-' + n);
export const VIEWER_URL = ORIGIN + '/meol/common/script/preview/preview.jsp?fileid=1&resid=101&lid=42';
export const streamUrl = (f = sourceFile()) => new URL('/meol/analytics/resPdfShow.do?resId=' + f.resid + '&lid=' + f.lid, f.previewUrl).href;
// Live THEOL template shape: the assignment exists even when #pdfIframe does not.
export function sourceStreamHTML(f = sourceFile(), url = streamUrl(f)) {
  return '<script>$(function(){var url=encodeURIComponent(' + JSON.stringify(url) + ');$("#pdfIframe").attr("src","/meol/analytics/resPdfShow.do?file="+url+"&lid=' + f.lid + '&resId=' + f.resid + '");});</script>';
}
export const slideHTML = (urls = PAGE_URLS, extra = '') => '<div id="ppt-img"></div><script>var converbodyHtml = ' + JSON.stringify(urls.join(',')) + '; $("#ppt-img").slidePPT({img_src:converbodyHtml.split(",")});</script>' + extra;
export const mediaHTML = url => '<script>var flashvars={f:' + JSON.stringify(url || MEDIA_URL) + '}; var videoparams=[' + JSON.stringify((url || MEDIA_URL) + '->video/mp4') + ']; CKobject.embed("player.swf","video","p",800,600,true,flashvars,videoparams);</script>';
export function sourceFile(extras = {}) { return file(1, { name: 'Lesson One.pptx', originalName: 'Lesson One.pptx', metadataResolved: true, downloadable: false, downloadUrl: '', sourceUrl: file().previewUrl, ...extras }); }
export function previewFile(html = slideHTML(), input = sourceFile()) {
  const dom = new JSDOM(html, { url: VIEWER_URL });
  try { return findPreviewDownload(dom.window.document, input, VIEWER_URL).file; } finally { dom.window.close(); }
}
function pngChunk(type, data) {
  const kind = new TextEncoder().encode(type), bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(kind, 4); bytes.set(data, 8); view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4))); return bytes;
}
export function pagePNG(width = 40, height = 30, rgb = [30, 100, 200]) {
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  const pixels = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  const chunks = [Uint8Array.of(137,80,78,71,13,10,26,10), pngChunk('IHDR', header), pngChunk('IDAT', zlibSync(pixels)), pngChunk('IEND', new Uint8Array())];
  const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const c of chunks) { output.set(c, offset); offset += c.length; } return output;
}
// Synthetic ISO-BMFF container for transport tests, not a claim about a playable video.
export function mediaBytes() {
  const box = (name, payload) => { const output = new Uint8Array(8 + payload.length); new DataView(output.buffer).setUint32(0, output.length); output.set(new TextEncoder().encode(name), 4); output.set(payload, 8); return output; };
  const boxes = [box('ftyp', new TextEncoder().encode('isom0000isom')), box('moov', new Uint8Array()), box('mdat', Uint8Array.of(1,2,3,4))];
  return Uint8Array.from(boxes.flatMap(b => [...b]));
}
