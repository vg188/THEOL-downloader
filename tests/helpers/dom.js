import { JSDOM } from 'jsdom';
export const dom = (html) => new JSDOM(html).window.document;
export const listUrl = 'https://course.buct.edu.cn/meol/common/script/listview.jsp?lid=12&folderid=34';
export const previewUrl = (n = 56) => `https://course.buct.edu.cn/meol/common/script/preview/download_preview.jsp?fileid=${n}&resid=78&lid=12`;
export const downloadUrl = (n = 56) => `https://course.buct.edu.cn/meol/common/script/download.jsp?fileid=${n}&resid=78&lid=12`;
export const resource = (n = 56) => ({ id: `12:78:${n}`, courseId: '12', resId: '78', fileId: String(n), title: `第${n}章`, previewUrl: previewUrl(n) });
export const preview = (name = '第一章.PPT', n = 56, size = '9.1M') => `<h2>文件名:${name} ${size ? `(${size})` : ''}<a href="${downloadUrl(n)}">下载</a></h2>`;
export const file = (n = 56) => ({ ...resource(n), name: `第${n}章.ppt`, extension: 'ppt', sizeText: '9.1M', downloadUrl: downloadUrl(n), courseName: '电路' });
