import { crc32 } from './file-content.js';
import { problem, uniqueArchivePath } from './policy.js';
import { checkCancelled, fetchFileBytes } from './network.js';

export const DEFAULT_SETTINGS = Object.freeze({ zipMode: 'auto', flatten: false, maxZipMb: 200, maxZipFiles: 120 });
export function normalizeSettings(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const number = (key, min, max) => Number.isFinite(Number(value[key])) && Number(value[key]) > 0 ? Math.max(min, Math.min(max, Math.floor(Number(value[key])))) : DEFAULT_SETTINGS[key];
  return { zipMode: ['auto', 'always', 'never'].includes(value.zipMode) ? value.zipMode : 'auto', flatten: typeof value.flatten === 'boolean' ? value.flatten : false, maxZipMb: number('maxZipMb', 10, 512), maxZipFiles: number('maxZipFiles', 1, 500) };
}
export function planDownload(files, input) {
  const settings = normalizeSettings(input), maxBytes = settings.maxZipMb * 1048576;
  if (settings.zipMode === 'never') return { mode: 'batch', reason: '已设为批量逐个下载' };
  if (files.length > settings.maxZipFiles) return { mode: 'batch', reason: '文件数量超过打包上限' };
  const known = files.reduce((total, file) => total + (Number.isFinite(file.sizeBytes) && file.sizeBytes > 0 ? file.sizeBytes : 0), 0);
  if (known > maxBytes) return { mode: 'batch', reason: '已知文件体积超过打包上限' };
  const unknown = files.filter(file => !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0).length;
  if (settings.zipMode === 'auto' && unknown > 60) return { mode: 'batch', reason: '大小未知的文件过多' };
  return { mode: 'zip', reason: '打包 ZIP · ' + (settings.flatten ? '文件平铺' : '保留目录') + (unknown ? '（含 ' + unknown + ' 个大小未知）' : '') };
}
export function zipStore(files) {
  // files: [{ name, data: Uint8Array }]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8
    dv.setUint16(8, 0, true); // store
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true); // fixed date ~1980+
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, f.data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + size;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}


export async function createArchive(files, { settings: input, fetchImpl, signal, onProgress = () => {}, shouldSkip = async () => false } = {}) {
  const settings = normalizeSettings(input);
  if (!files.length) throw problem('EMPTY_SELECTION', '请先选择文件');
  if (files.length > settings.maxZipFiles) throw problem('OVER_BUDGET', '文件数量超过打包上限');
  const maxBytes = settings.maxZipMb * 1048576;
  const packed = [], skipped = [], warnings = [], used = new Set(), encoder = new TextEncoder();
  let total = 22; // ZIP end-of-central-directory record.
  for (const [position, file] of files.entries()) {
    checkCancelled(signal);
    onProgress({ file, position: position + 1, total: files.length });
    const name = uniqueArchivePath(file, used, settings);
    const overhead = 76 + 2 * encoder.encode(name).length;
    try {
      let inspection;
      const data = await fetchFileBytes(file, { fetchImpl, signal, maxBytes: Math.max(0, maxBytes - total - overhead), onInspection: value => { inspection = value; }, onProgress: progress => onProgress({ ...progress, position: position + 1, total: files.length }) });
      for (const warning of inspection?.warnings || []) warnings.push({ ...warning, id: file.id, name: file.name });
      total += data.length + overhead;
      packed.push({ name, data });
    } catch (error) {
      used.delete(name.toLowerCase());
      checkCancelled(signal);
      if (error.code === 'OVER_BUDGET') throw error;
      if (!await shouldSkip(file, error)) throw error;
      skipped.push({ id: file.id, name: file.name, error: error.message });
    }
  }
  checkCancelled(signal);
  if (!packed.length) throw problem('EMPTY_ARCHIVE', '没有成功读取的文件，未生成空压缩包');
  const blob = zipStore(packed);
  if (blob.size > maxBytes) throw problem('OVER_BUDGET', '压缩包超过内存预算');
  return { blob, count: packed.length, skipped, warnings };
}
