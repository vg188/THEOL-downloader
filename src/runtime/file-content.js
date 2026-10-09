import { Inflate } from 'fflate';
import { extOf, problem, trimWhitespace } from './policy.js';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
export function crc32(bytes, previous = 0) {
  let value = previous ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) value = CRC_TABLE[(value ^ bytes[i]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const fail = message => { throw problem('BAD_FILE', message); };
const has = (bytes, values, offset = 0) => values.every((value, i) => bytes[offset + i] === value);
const ascii = (bytes, start = 0, end = bytes.length) => new TextDecoder('latin1').decode(bytes.subarray(start, end));
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const OFFICE = {
  docx: ['word/document.xml', 'document', 'wordprocessingml.document.main+xml'],
  docm: ['word/document.xml', 'document', 'ms-word.document.macroEnabled.main+xml'],
  dotx: ['word/document.xml', 'document', 'wordprocessingml.template.main+xml'],
  dotm: ['word/document.xml', 'document', 'ms-word.template.macroEnabledTemplate.main+xml'],
  pptx: ['ppt/presentation.xml', 'presentation', 'presentationml.presentation.main+xml'],
  pptm: ['ppt/presentation.xml', 'presentation', 'ms-powerpoint.presentation.macroEnabled.main+xml'],
  ppsx: ['ppt/presentation.xml', 'presentation', 'presentationml.slideshow.main+xml'],
  ppsm: ['ppt/presentation.xml', 'presentation', 'ms-powerpoint.slideshow.macroEnabled.main+xml'],
  potx: ['ppt/presentation.xml', 'presentation', 'presentationml.template.main+xml'],
  potm: ['ppt/presentation.xml', 'presentation', 'ms-powerpoint.template.macroEnabled.main+xml'],
  xlsx: ['xl/workbook.xml', 'workbook', 'spreadsheetml.sheet.main+xml'],
  xlsm: ['xl/workbook.xml', 'workbook', 'ms-excel.sheet.macroEnabled.main+xml'],
  xltx: ['xl/workbook.xml', 'workbook', 'spreadsheetml.template.main+xml'],
  xltm: ['xl/workbook.xml', 'workbook', 'ms-excel.template.macroEnabled.main+xml'],
};
const isZip = bytes => has(bytes, [0x50, 0x4b, 3, 4]) || has(bytes, [0x50, 0x4b, 5, 6]);
const textTypes = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'svg', 'html', 'htm', 'css', 'js', 'mjs', 'py', 'c', 'cpp', 'h', 'java', 'r', 'tex', 'log', 'ini', 'yaml', 'yml']);
export function assertFileMime(file, contentType = '', disposition = '') {
  const ext = extOf(file.name), type = contentType.split(';')[0].toLowerCase().replace(/^\s+|\s+$/g, '');
  const attachment = /(?:^|;)\s*attachment(?:\s*;|\s*$)/i.test(disposition);
  if ((/^(?:text\/html|application\/xhtml\+xml)$/.test(type) && !(attachment && ['html', 'htm'].includes(ext)))
    || (/^(?:application|text)\/(?:[\w.-]+\+)?json$/.test(type) && ext !== 'json')
    || (/^(?:application|text)\/(?:[\w.-]+\+)?xml$/.test(type) && !['xml', 'svg'].includes(ext))) {
    fail('服务器返回了网页或错误信息，而不是所选原文件');
  }
  const declared = { 'application/pdf': ['pdf'], 'application/msword': ['doc', 'dot', 'rtf'], 'application/vnd.ms-powerpoint': ['ppt', 'pps', 'pot'], 'application/vnd.ms-excel': ['xls', 'xlt', 'csv'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'],
    'video/mp4': ['mp4', 'm4v'], 'audio/mp4': ['m4a', 'mp4'], 'audio/mpeg': ['mp3'], 'video/webm': ['webm'], 'audio/webm': ['webm'],
    'video/x-flv': ['flv'], 'audio/ogg': ['ogg'], 'video/ogg': ['ogg'], 'audio/wav': ['wav'], 'audio/x-wav': ['wav'] }[type];
  if (declared && !declared.includes(ext)) fail('响应声明的文件类型与原文件后缀不符，请重新扫描');
}

/** ZIP directory, bounds and CRC checks. Never expand an archive without explicit limits. */
function inspectZip(bytes, ext) {
  const dv = view(bytes); let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (dv.getUint32(p, true) === 0x06054b50 && p + 22 + dv.getUint16(p + 20, true) === bytes.length) { end = p; break; }
  }
  if (end < 0) fail('ZIP/Office 文件尾部缺失，文件可能未下载完整');
  const count = dv.getUint16(end + 10, true), centralSize = dv.getUint32(end + 12, true), centralStart = dv.getUint32(end + 16, true);
  if (count === 0xffff || centralStart === 0xffffffff || centralSize === 0xffffffff) throw problem('VERIFY_LIMIT', '完整校验暂不支持 ZIP64，请在平台手动下载并核对');
  if (dv.getUint16(end + 4, true) || dv.getUint16(end + 6, true) || dv.getUint16(end + 8, true) !== count) fail('不支持分卷或不完整的 ZIP 文件');
  if (centralStart + centralSize !== end) fail('ZIP 目录位置或文件长度不正确');
  if (count > 20000) throw problem('VERIFY_LIMIT', '压缩包条目过多，已停止完整校验');
  const names = new Set(), regions = [], parts = new Map(); let cursor = centralStart, expanded = 0, allCrc = true;
  const wanted = new Set(['[Content_Types].xml', '_rels/.rels', OFFICE[ext]?.[0]]);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || dv.getUint32(cursor, true) !== 0x02014b50) fail('ZIP 目录已损坏');
    const flags = dv.getUint16(cursor + 8, true), method = dv.getUint16(cursor + 10, true), crc = dv.getUint32(cursor + 16, true);
    const packed = dv.getUint32(cursor + 20, true), size = dv.getUint32(cursor + 24, true), nameSize = dv.getUint16(cursor + 28, true);
    const recordEnd = cursor + 46 + nameSize + dv.getUint16(cursor + 30, true) + dv.getUint16(cursor + 32, true), local = dv.getUint32(cursor + 42, true);
    if (recordEnd > end || !nameSize || dv.getUint16(cursor + 34, true)) fail('ZIP 条目信息不完整');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    let name;
    try { name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252', { fatal: true }).decode(nameBytes); } catch { fail('ZIP 文件名编码已损坏'); }
    if (OFFICE[ext] && names.has(name)) fail('Office 压缩包存在重复条目，无法确认原文件');
    names.add(name);
    if (local + 30 > centralStart || dv.getUint32(local, true) !== 0x04034b50 || dv.getUint16(local + 6, true) !== flags || dv.getUint16(local + 8, true) !== method) fail('ZIP 本地条目与目录不一致');
    const localNameSize = dv.getUint16(local + 26, true), dataStart = local + 30 + localNameSize + dv.getUint16(local + 28, true), dataEnd = dataStart + packed;
    if (localNameSize !== nameSize || dataEnd > centralStart || !nameBytes.every((byte, n) => bytes[local + 30 + n] === byte)) fail('ZIP 文件名或条目长度不一致');
    let regionEnd = dataEnd;
    if (!(flags & 8)) {
      if (dv.getUint32(local + 14, true) !== crc || dv.getUint32(local + 18, true) !== packed || dv.getUint32(local + 22, true) !== size) fail('ZIP 条目校验信息不一致');
    } else {
      let p = dataEnd;
      if (p + 4 <= centralStart && dv.getUint32(p, true) === 0x08074b50) p += 4;
      if (p + 12 > centralStart || dv.getUint32(p, true) !== crc || dv.getUint32(p + 4, true) !== packed || dv.getUint32(p + 8, true) !== size) fail('ZIP 数据描述符缺失或损坏');
      regionEnd = p + 12;
    }
    regions.push([local, regionEnd]);
    if ((flags & 1) || ![0, 8].includes(method)) {
      if (OFFICE[ext]) fail('Office 包含加密或不支持的压缩条目');
      allCrc = false;
    } else {
      if (size > 256 * 1048576 || expanded + size > 512 * 1048576) throw problem('VERIFY_LIMIT', '解压校验体积超过安全上限，未继续占用内存');
      if (wanted.has(name) && size > 8 * 1048576) throw problem('VERIFY_LIMIT', 'Office 结构信息过大，无法安全校验');
      let actualSize = 0, actualCrc = 0; const chunks = [];
      const consume = chunk => {
        actualSize += chunk.length;
        if (actualSize > size) fail('ZIP 解压后的长度超出目录声明');
        actualCrc = crc32(chunk, actualCrc);
        if (wanted.has(name)) chunks.push(chunk.slice());
      };
      try {
        if (method === 0) consume(bytes.subarray(dataStart, dataEnd));
        else {
          const inflater = new Inflate(consume);
          for (let p = dataStart; p < dataEnd; p += 1024) inflater.push(bytes.subarray(p, Math.min(p + 1024, dataEnd)), p + 1024 >= dataEnd);
          if (!packed) fail('ZIP 压缩条目缺失');
        }
      } catch (error) { if (error.code === 'BAD_FILE') throw error; fail('ZIP 压缩内容已损坏，无法解压'); }
      if (actualSize !== size || actualCrc !== crc) fail('ZIP 内容校验失败（长度或 CRC 不一致）');
      expanded += actualSize;
      if (wanted.has(name)) {
        const joined = new Uint8Array(actualSize); let at = 0;
        for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
        parts.set(name, new TextDecoder().decode(joined));
      }
    }
    cursor = recordEnd;
  }
  if (cursor !== centralStart + centralSize) fail('ZIP 目录条目数量不一致');
  regions.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < regions.length; i++) if (regions[i][0] < regions[i - 1][1]) fail('ZIP 条目相互重叠，文件已损坏');
  if (OFFICE[ext]) {
    const [main, root, type] = OFFICE[ext], contentTypes = parts.get('[Content_Types].xml') || '', relationships = parts.get('_rels/.rels') || '', xml = parts.get(main) || '';
    const attr = (tag, key) => tag.match(new RegExp('\\b' + key + '\\s*=\\s*["\x27]([^"\x27]*)["\x27]', 'i'))?.[1];
    const types = contentTypes.match(/<(?:\w+:)?Override\b[^>]*>/g) || [];
    if (!types.some(tag => attr(tag, 'PartName') === '/' + main && (attr(tag, 'ContentType') || '').endsWith(type))) fail('Office 内部类型与 .' + ext + ' 后缀不符，未保存错误格式');
    const rels = relationships.match(/<(?:\w+:)?Relationship\b[^>]*>/g) || [];
    if (!rels.some(tag => /\/officeDocument$/.test(attr(tag, 'Type') || '') && (attr(tag, 'Target') || '').replace(/^\//, '') === main && attr(tag, 'TargetMode') !== 'External')) fail('Office 缺少主文档关系');
    if (!new RegExp('<(?:[\\w.-]+:)?' + root + '(?:\\s|>)').test(xml)) fail('Office 主文档缺失或损坏');
  }
  const warnings = [];
  if (count === 0) warnings.push({ code: 'EMPTY_SOURCE_ZIP', message: '原 ZIP 为空（0 个条目）；已保留原始文件，不是下载丢失了内容' });
  if (!allCrc) warnings.push({ code: 'PARTIAL_ZIP_CHECK', message: '原压缩包含加密或不支持的压缩方式，部分条目的解压内容未校验' });
  return { format: ext, level: allCrc ? 'container-crc' : 'container-structure', entries: count, warnings };
}

/** Inspect CFB chains and root streams; a Word file must not pass as PowerPoint. */
function inspectCompound(bytes, ext) {
  if (bytes.length < 512) fail('Office 复合文件头不完整');
  const dv = view(bytes), major = dv.getUint16(26, true), shift = dv.getUint16(30, true);
  if (dv.getUint16(28, true) !== 0xfffe || !((major === 3 && shift === 9) || (major === 4 && shift === 12)) || dv.getUint16(32, true) !== 6) fail('Office 复合文件头已损坏');
  const sectorSize = 2 ** shift, sectors = bytes.length / sectorSize - 1;
  if (!Number.isInteger(sectors) || sectors < 1) fail('Office 扇区长度不完整');
  const END = 0xfffffffe, FREE = 0xffffffff;
  const sector = id => { if (!Number.isInteger(id) || id < 0 || id >= sectors) fail('Office 扇区引用越界，文件可能截断'); return (id + 1) * sectorSize; };
  const fatIds = [], addFat = id => { if (id !== FREE) { sector(id); if (fatIds.includes(id)) fail('Office FAT 扇区重复'); fatIds.push(id); } };
  for (let i = 0; i < 109; i++) addFat(dv.getUint32(76 + 4 * i, true));
  let next = dv.getUint32(68, true); const seenDifat = new Set(), difatCount = dv.getUint32(72, true);
  if (difatCount > sectors) fail('Office DIFAT 数量不正确');
  for (let i = 0; i < difatCount; i++) {
    if (seenDifat.has(next)) fail('Office DIFAT 存在循环'); seenDifat.add(next);
    const start = sector(next);
    for (let p = 0; p < sectorSize - 4; p += 4) addFat(dv.getUint32(start + p, true));
    next = dv.getUint32(start + sectorSize - 4, true);
  }
  if (fatIds.length !== dv.getUint32(44, true) || (difatCount && next !== END)) fail('Office FAT 目录不完整');
  const chain = (start, max = sectors, table) => {
    const ids = [], seen = new Set(); let id = start;
    while (id !== END) {
      if (seen.has(id) || ids.length >= max) fail('Office 数据链循环或长度不正确');
      seen.add(id); ids.push(id);
      if (table) { if (id >= table.length) fail('Office 小文件数据链越界'); id = table[id]; }
      else {
        sector(id); const fat = fatIds[Math.floor(id / (sectorSize / 4))];
        if (fat == null) fail('Office FAT 无法覆盖文件');
        id = dv.getUint32(sector(fat) + (id % (sectorSize / 4)) * 4, true);
      }
    }
    return ids;
  };
  const dir = chain(dv.getUint32(48, true));
  if (dir.length * sectorSize > 16 * 1048576) throw problem('VERIFY_LIMIT', 'Office 目录过大，已停止校验');
  const entries = [];
  for (const id of dir) for (let offset = sector(id); offset < sector(id) + sectorSize; offset += 128) {
    const length = dv.getUint16(offset + 64, true), kind = bytes[offset + 66];
    if (kind && (length < 2 || length > 64 || length % 2)) fail('Office 目录名称无效');
    const size = major === 3 ? dv.getUint32(offset + 120, true) : Number(dv.getBigUint64(offset + 120, true));
    entries.push({ name: kind ? new TextDecoder('utf-16le').decode(bytes.subarray(offset, offset + length - 2)) : '', kind, left: dv.getUint32(offset + 68, true), right: dv.getUint32(offset + 72, true), child: dv.getUint32(offset + 76, true), start: dv.getUint32(offset + 116, true), size });
  }
  const root = entries[0];
  if (!root || root.kind !== 5) fail('Office 缺少根目录');
  const rootChain = root.size ? chain(root.start) : [];
  if (rootChain.length !== Math.ceil(root.size / sectorSize)) fail('Office 小文件存储长度不正确');
  const miniIds = dv.getUint32(64, true) ? chain(dv.getUint32(60, true)) : [];
  if (miniIds.length !== dv.getUint32(64, true)) fail('Office MiniFAT 长度不正确');
  const miniFat = [];
  for (const id of miniIds) for (let p = sector(id); p < sector(id) + sectorSize; p += 4) miniFat.push(dv.getUint32(p, true));
  for (const entry of entries) if (entry.kind === 2 && entry.size) {
    if (!Number.isSafeInteger(entry.size) || entry.size > bytes.length) fail('Office 文档流长度不正确');
    const mini = entry.size < dv.getUint32(56, true), ids = chain(entry.start, mini ? Math.ceil(root.size / 64) : sectors, mini ? miniFat : undefined);
    if (ids.length !== Math.ceil(entry.size / (mini ? 64 : sectorSize)) || (mini && ids.some(id => (id + 1) * 64 > root.size))) fail('Office 文档流不完整');
  }
  const names = new Set(), visited = new Set(), walk = [root.child];
  while (walk.length) {
    const id = walk.pop(); if (id === FREE) continue;
    if (visited.has(id) || !entries[id]?.kind) fail('Office 根目录树已损坏');
    visited.add(id); const entry = entries[id]; if (entry.kind === 2) names.add(entry.name);
    walk.push(entry.left, entry.right);
  }
  if (OFFICE[ext] && names.has('EncryptionInfo') && names.has('EncryptedPackage')) return { format: 'encrypted-office', level: 'container-structure', warnings: [{ code: 'ENCRYPTED_OFFICE', message: '原文档已加密，仅能核对容器，无法确认内部文档类型及正文' }] };
  const expected = { doc: ['WordDocument'], dot: ['WordDocument'], ppt: ['PowerPoint Document'], pps: ['PowerPoint Document'], pot: ['PowerPoint Document'], xls: ['Workbook', 'Book'], xlt: ['Workbook', 'Book'] }[ext];
  if (!expected?.some(name => names.has(name))) fail('Office 内部文档类型与 .' + ext + ' 后缀不符');
  return { format: ext, level: 'container-structure' };
}

export function inspectFileContent(bytes, file, { contentType = '', disposition = '', complete = true } = {}) {
  if (!bytes.length) throw problem('EMPTY_FILE', '服务器返回了空文件');
  assertFileMime(file, contentType, disposition);
  const ext = extOf(file.name), header = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^\uFEFF/, '').trimStart();
  const textAttachment = textTypes.has(ext) && /\battachment\b/i.test(disposition);
  if ((!textAttachment && /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<form\b|<script\b|<\?xml)/i.test(header))
    || (textAttachment && /<input\b[^>]*type\s*=\s*["']?password\b/i.test(header) && /登录|登陆|sign\s*in|log\s*in/i.test(header))) fail('服务器返回了登录页面或网页，而不是所选原文件');
  const result = { format: ext || 'unknown', level: complete ? 'signature' : 'prefix' };
  if (ext === 'pdf') {
    if (!/^%PDF-(?:1\.\d|2\.0)(?:\s|$)/.test(header)) fail('返回内容不是 PDF 原文件');
    if (complete) {
      const tail = ascii(bytes, Math.max(0, bytes.length - 65536));
      const end = tail.match(/startxref\s+(\d+)\s+%%EOF[\s\0]*$/);
      if (!end) fail('PDF 文件尾部或交叉引用缺失，文件可能截断');
      const offset = Number(end[1]);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.length - 20) fail('PDF 交叉引用位置不正确');
      const xref = ascii(bytes, offset, Math.min(offset + 2048, bytes.length));
      if (!/^xref\b/.test(xref) && !(/^\d+\s+\d+\s+obj\b/.test(xref) && /\/Type\s*\/XRef\b/.test(xref))) fail('PDF 交叉引用已损坏');
      result.level = 'document-structure';
    }
  } else if (OFFICE[ext] || ext === 'zip') {
    if (OFFICE[ext] && has(bytes, OLE)) return complete ? inspectCompound(bytes, ext) : { format: 'encrypted-office', level: 'prefix' };
    if (!isZip(bytes)) fail('返回内容与 ZIP/Office 文件格式不符');
    if (complete) return inspectZip(bytes, ext);
  } else if (['doc', 'dot', 'ppt', 'pps', 'pot', 'xls', 'xlt'].includes(ext)) {
    if (['doc', 'dot'].includes(ext) && /^\{\\rtf\d/.test(header)) {
      if (complete && !trimWhitespace(ascii(bytes)).endsWith('}')) fail('RTF 文档尾部缺失');
      return { format: 'rtf', level: complete ? 'document-structure' : 'prefix' };
    }
    if (!has(bytes, OLE)) fail('返回内容与 Office 原文件格式不符');
    if (complete) return inspectCompound(bytes, ext);
  } else if (ext === 'png') {
    if (!has(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) fail('返回内容不是 PNG 图片');
    if (complete) {
      const dv = view(bytes); let p = 8, ended = false, image = false;
      while (p + 12 <= bytes.length) {
        const size = dv.getUint32(p), type = ascii(bytes, p + 4, p + 8);
        if (p + 12 + size > bytes.length || crc32(bytes.subarray(p + 4, p + 8 + size)) !== dv.getUint32(p + 8 + size)) fail('PNG 内容已截断或 CRC 不一致');
        if (p === 8 && (type !== 'IHDR' || size !== 13)) fail('PNG 缺少图片信息');
        if (type === 'IDAT') image = true;
        p += size + 12;
        if (type === 'IEND') { ended = size === 0 && p === bytes.length; break; }
      }
      if (!ended || !image) fail('PNG 图片内容不完整'); result.level = 'container-crc';
    }
  } else if (['jpg', 'jpeg'].includes(ext)) {
    if (!has(bytes, [255, 216, 255]) || (complete && !has(bytes, [255, 217], bytes.length - 2))) fail('JPEG 图片格式或尾部不完整');
  } else if (ext === 'gif') {
    if (!/^GIF8[79]a/.test(ascii(bytes, 0, 6)) || (complete && (bytes.length < 14 || bytes.at(-1) !== 0x3b))) fail('GIF 图片格式或尾部不完整');
  } else if (['webp', 'wav', 'avi'].includes(ext)) {
    const kind = { webp: 'WEBP', wav: 'WAVE', avi: 'AVI ' }[ext];
    if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== kind || (complete && view(bytes).getUint32(4, true) + 8 !== bytes.length)) fail('返回内容与 .' + ext + ' 格式或长度不符');
  } else if (['mp4', 'm4v', 'm4a'].includes(ext)) {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') fail('返回内容不是 MP4/音频预览文件');
    if (complete) {
      const dv = view(bytes); let p = 0, boxes = 0, metadata = false, media = false;
      while (p + 8 <= bytes.length) {
        if (++boxes > 100000) throw problem('VERIFY_LIMIT', '媒体分段过多，无法安全校验');
        let size = dv.getUint32(p), headerSize = 8; const type = ascii(bytes, p + 4, p + 8);
        if (size === 1) { if (p + 16 > bytes.length) fail('MP4 扩展长度信息缺失'); size = Number(dv.getBigUint64(p + 8)); headerSize = 16; }
        else if (size === 0) size = bytes.length - p;
        if (!Number.isSafeInteger(size) || size < headerSize || p + size > bytes.length) fail('MP4 内容已截断或长度不一致');
        if (type === 'moov') metadata = true;
        if (type === 'mdat' && size > headerSize) media = true;
        p += size;
      }
      if (p !== bytes.length || !metadata || !media) fail('MP4 缺少完整的媒体数据或播放信息');
      result.level = 'container-structure';
    }
  } else if (ext === 'mp3') {
    if (ascii(bytes, 0, 3) !== 'ID3' && !(bytes[0] === 255 && (bytes[1] & 224) === 224)) fail('返回内容不是 MP3 音频');
  } else if (ext === 'webm') {
    if (!has(bytes, [26, 69, 223, 163])) fail('返回内容不是 WebM 媒体');
  } else if (ext === 'ogg') {
    if (ascii(bytes, 0, 4) !== 'OggS') fail('返回内容不是 Ogg 媒体');
  } else if (ext === 'flv') {
    if (ascii(bytes, 0, 3) !== 'FLV' || bytes[3] !== 1 || bytes.length < 13) fail('返回内容不是 FLV 媒体');
  } else if (ext === 'rar') {
    if (!has(bytes, [82, 97, 114, 33, 26, 7]) || ![0, 1].includes(bytes[6]) || (bytes[6] === 1 && bytes[7] !== 0) || (complete && bytes.length < 15)) fail('返回内容不是完整的 RAR 文件');
  } else if (ext === '7z') {
    if (!has(bytes, [55, 122, 188, 175, 39, 28]) || bytes.length < 32) fail('返回内容不是完整的 7z 文件');
    const dv = view(bytes);
    if (crc32(bytes.subarray(12, 32)) !== dv.getUint32(8, true)) fail('7z 起始头校验失败');
    if (complete) {
      const start = 32 + Number(dv.getBigUint64(12, true)), size = Number(dv.getBigUint64(20, true));
      if (!Number.isSafeInteger(start + size) || start + size > bytes.length || crc32(bytes.subarray(start, start + size)) !== dv.getUint32(28, true)) fail('7z 文件尾部缺失或校验失败');
      result.level = 'container-structure';
    }
  } else {
    result.level = 'unrecognized';
    // Prevent the common "renamed PDF/Office/image" error even for text/unknown extensions.
    if (textTypes.has(ext) && (has(bytes, OLE) || isZip(bytes) || /^%PDF-/.test(header) || has(bytes, [137, 80, 78, 71]))) fail('返回的二进制内容与文本文件后缀不符');
  }
  return result;
}
