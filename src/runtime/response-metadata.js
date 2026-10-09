import { extOf, problem, trimWhitespace, isPreviewSource, validateFile } from './policy.js';
import { assertFileMime } from './file-content.js';

function decodeOctets(value, charset = 'utf-8') {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%') {
      if (!/^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) throw problem('BAD_FILENAME', '下载响应中的文件名编码无效');
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16)); i += 2;
    } else {
      if (value.charCodeAt(i) > 127) throw problem('BAD_FILENAME', '下载响应中的扩展文件名编码无效');
      bytes.push(value.charCodeAt(i));
    }
  }
  try { return new TextDecoder(charset, { fatal: true }).decode(new Uint8Array(bytes)); }
  catch { throw problem('BAD_FILENAME', '无法可靠解码下载响应中的文件名'); }
}
/** RFC 6266/5987 plus THEOL-style percent-encoded legacy filename parameters. */
export function dispositionFilename(header = '', expectedName = '') {
  if (!header) return '';
  if (/[\r\n\0]/.test(header)) throw problem('BAD_FILENAME', '下载响应中的文件名无效');
  const parts = []; let text = '', quoted = false, escaped = false;
  for (const char of header) {
    if (escaped) { text += char; escaped = false; continue; }
    if (char === '\\' && quoted) { text += char; escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) { parts.push(text); text = ''; } else text += char;
  }
  if (quoted || escaped) throw problem('BAD_FILENAME', '下载响应中的文件名引号未闭合');
  parts.push(text); const names = new Map();
  for (const part of parts.slice(1)) {
    const match = part.match(/^\s*(filename\*?)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (names.has(key)) throw problem('BAD_FILENAME', '下载响应包含相互冲突的文件名');
    let value = match[2];
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw problem('BAD_FILENAME', '下载响应中的文件名引号无效');
      value = value.slice(1, -1).replace(/\\([\s\S])/g, '$1');
    }
    names.set(key, value);
  }
  let name = '';
  if (names.has('filename*')) {
    const value = names.get('filename*').match(/^([^']+)'[^']*'(.*)$/);
    if (!value) throw problem('BAD_FILENAME', '下载响应中的扩展文件名无效');
    name = decodeOctets(value[2], value[1]);
  } else if (names.has('filename')) {
    name = names.get('filename');
    if (name.normalize('NFC') !== expectedName.normalize('NFC') && /%[0-9a-f]{2}/i.test(name) && !/[^\x00-\x7f]/.test(name)) {
      try { name = decodeOctets(name); } catch { name = decodeOctets(name, 'gb18030'); }
    } else if (/[^\x00-\x7f]/.test(name) && [...name].every(char => char.charCodeAt(0) <= 255)) {
      // Some older servlets put raw UTF-8 octets in a Latin-1 header.
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(name, char => char.charCodeAt(0))); } catch { /* A genuine Latin-1 filename. */ }
    }
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) throw problem('BAD_FILENAME', '下载响应中的文件名含控制字符');
  return trimWhitespace(name).normalize('NFC');
}
export function assertResponseFilename(file, disposition) {
  const name = dispositionFilename(disposition, trimWhitespace(file.name));
  const expected = trimWhitespace(file.name).normalize('NFC');
  if (file.downloadKind === 'preview') {
    if (name && extOf(name) && extOf(name) !== extOf(expected)) throw problem('FILENAME_MISMATCH', '预览响应的文件后缀与可保存格式不一致');
    return name; // Preview servers can use a generated UUID; the course metadata supplies the user-facing filename.
  }
  if (name && name.toLowerCase() !== expected.toLowerCase()) {
    throw problem('FILENAME_MISMATCH', '原文件名与下载响应不一致：预览为「' + expected + '」，响应为「' + name + '」。请重新扫描，不会静默改名');
  }
  return name;
}
export function responseHeaders(response, file) {
  const declaredContentType = response.headers.get('content-type') || '', disposition = response.headers.get('content-disposition') || '';
  // A confirmed THEOL stream route labels Office bytes as PDF. Only this ID-bound route
  // may defer that MIME mismatch to full Office/container validation; ordinary downloads stay strict.
  if (isPreviewSource(file)) validateFile(file);
  const mimeCorrected = isPreviewSource(file) && trimWhitespace(declaredContentType.split(';')[0]).toLowerCase() === 'application/pdf' && extOf(file.name) !== 'pdf';
  const contentType = mimeCorrected ? 'application/octet-stream' : declaredContentType;
  assertFileMime(file, contentType, disposition);
  const responseName = assertResponseFilename(file, disposition);
  const raw = response.headers.get('content-length');
  if (raw != null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw problem('BAD_FILE', '响应中的文件长度无效');
  const encoding = response.headers.get('content-encoding') || '';
  const identityEncoding = !encoding || /^identity$/i.test(trimWhitespace(encoding));
  const etag = response.headers.get('etag') || '';
  return { contentType, declaredContentType, mimeCorrected, disposition, responseName, contentLength: raw == null ? null : Number(raw), identityEncoding,
    etag: /^"[^"\r\n]*"$/.test(etag) ? etag : '', ext: extOf(file.name) };
}
export function assertExactMetadataSize(file, bytes) {
  if (file.sizeExact === true && Number.isSafeInteger(file.sizeBytes) && bytes != null && file.sizeBytes !== bytes) {
    throw problem('SIZE_MISMATCH', '预览页的原文件大小与下载响应不一致，请重新扫描');
  }
}
