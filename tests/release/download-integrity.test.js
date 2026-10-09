import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { inspectFileContent, crc32 } from '../../src/runtime/file-content.js';
import { dispositionFilename } from '../../src/runtime/response-metadata.js';
import { fetchFileBytes, preflightFile, PROBE_BYTES } from '../../src/runtime/network.js';
import { createArchive } from '../../src/runtime/archive.js';
import { filePath, safeSegment, uniqueArchivePath, validateFile } from '../../src/runtime/policy.js';
import { file, fixtureBytes } from './helpers.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function downloadResponse(bytes, url, headers = {}, status = 200) {
  const response = new Response(bytes, { status, headers: { 'content-type': 'application/octet-stream', ...headers } });
  Object.defineProperty(response, 'url', { value: url }); return response;
}
function named(ext, name = '原文件  空格 + α.' + ext.toUpperCase()) { return file(1, { name, ext }); }
const disposition = name => "attachment; filename*=UTF-8''" + encodeURIComponent(name);

for (const ext of ['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls', 'png', 'jpg']) {
  test('real ' + ext + ': bytes survive response validation without conversion or renaming', async () => {
    const source = fixtureBytes('sample.' + ext), resource = named(ext);
    const bytes = await fetchFileBytes(resource, { fetchImpl: async url => downloadResponse(source, url, { 'content-length': String(source.length), 'content-disposition': disposition(resource.name) }) });
    assert.equal(hash(bytes), hash(source));
    const inspection = inspectFileContent(bytes, resource);
    assert.equal(inspection.format, ext);
    assert.ok(inspection.level !== 'unrecognized');
  });
}
test('Office containers are distinguished by their actual root documents, not only PK/OLE headers', () => {
  for (const [actual, wrong] of [['docx', 'pptx'], ['pptx', 'xlsx'], ['xlsx', 'docx'], ['doc', 'ppt'], ['ppt', 'xls'], ['xls', 'doc']]) {
    assert.throws(() => inspectFileContent(fixtureBytes('sample.' + actual), named(wrong)), { code: 'BAD_FILE' });
  }
});
test('truncated PDF and truncated Office containers are not accepted as originals', () => {
  assert.throws(() => inspectFileContent(strToU8('%PDF-1.7\nfixture\n%%EOF'), named('pdf')), { code: 'BAD_FILE' });
  for (const ext of ['pdf', 'pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'png', 'jpg']) {
    const source = fixtureBytes('sample.' + ext);
    assert.throws(() => inspectFileContent(source.subarray(0, source.length - 12), named(ext)), { code: 'BAD_FILE' });
  }
});
test('ZIP CRC failures, incomplete packages and wrong Office content types are detected', () => {
  const parts = unzipSync(fixtureBytes('sample.docx'));
  const stored = zipSync(parts, { level: 0 }), bad = stored.slice();
  const offset = new TextDecoder().decode(stored).indexOf('<?xml'); assert.ok(offset >= 0); bad[offset + 2] ^= 1;
  assert.throws(() => inspectFileContent(bad, named('docx')), { code: 'BAD_FILE' });
  delete parts['word/document.xml'];
  assert.throws(() => inspectFileContent(zipSync(parts), named('docx')), { code: 'BAD_FILE' });
  const other = unzipSync(fixtureBytes('sample.docx')); delete other['_rels/.rels'];
  assert.throws(() => inspectFileContent(zipSync(other), named('docx')), { code: 'BAD_FILE' });
  assert.throws(() => inspectFileContent(zipSync({ 'ppt/presentation.xml': strToU8('<presentation/>') }), named('pptx')), { code: 'BAD_FILE' });
});
test('bounded ZIP inflation refuses unsafe expanded lengths before allocating them', () => {
  const bytes = zipSync({ 'bomb.txt': strToU8('tiny') }, { level: 0 }), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  dv.setUint32(22, 600 * 1048576, true);
  const central = dv.getUint32(bytes.length - 6, true); dv.setUint32(central + 24, 600 * 1048576, true);
  assert.throws(() => inspectFileContent(bytes, named('zip')), { code: 'VERIFY_LIMIT' });
});
test('CRC can be updated incrementally without changing its value', () => {
  const bytes = fixtureBytes('sample.docx'); let value = 0;
  for (let p = 0; p < bytes.length; p += 53) value = crc32(bytes.subarray(p, p + 53), value);
  assert.equal(value, crc32(bytes));
});
test('filenames support RFC 5987, quoted semicolons, raw UTF-8 octets, GBK and literal plus signs', () => {
  assert.equal(dispositionFilename("attachment; filename=fall-back.docx; filename*=UTF-8'zh'%E4%B8%AD%E6%96%87%20%20A%2BB.docx"), '中文  A+B.docx');
  assert.equal(dispositionFilename('attachment; filename="lecture; part 1.pdf"'), 'lecture; part 1.pdf');
  assert.equal(dispositionFilename('attachment; filename="a\\"b.pdf"'), 'a"b.pdf');
  assert.equal(dispositionFilename('attachment; filename=%D6%D0%CE%C4.pdf'), '中文.pdf');
  assert.equal(dispositionFilename('attachment; filename="CafÃ©.pdf"'), 'Café.pdf');
  assert.equal(dispositionFilename('inline'), '');
  assert.throws(() => dispositionFilename('attachment; filename=a.pdf; filename=b.pdf'), { code: 'BAD_FILENAME' });
  assert.throws(() => dispositionFilename("attachment; filename*=UTF-8''%xx.pdf"), { code: 'BAD_FILENAME' });
});
test('a contradictory response filename is refused before buffering or saving', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchFileBytes(named('pdf'), { fetchImpl: async url => downloadResponse(body, url, { 'content-disposition': disposition('不是所选文件.pdf') }) }), { code: 'FILENAME_MISMATCH' });
  assert.equal(cancelled, true);
});
test('an original filename containing a literal percent escape must not be decoded twice', async () => {
  const source = fixtureBytes('sample.pdf'), resource = named('pdf', '100%20 +  two.pdf');
  const bytes = await fetchFileBytes(resource, { fetchImpl: async url => downloadResponse(source, url, { 'content-disposition': 'attachment; filename="' + resource.name + '"' }) });
  assert.equal(hash(bytes), hash(source));
});
test('declared MIME, exact metadata lengths and unsolicited partial responses cannot silently disagree', async () => {
  const source = fixtureBytes('sample.pdf');
  await assert.rejects(fetchFileBytes(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, { 'content-type': 'image/png' }) }), { code: 'BAD_FILE' });
  await assert.rejects(fetchFileBytes(file(1, { sizeExact: true, sizeBytes: source.length + 1 }), { fetchImpl: async url => downloadResponse(source, url) }), { code: 'SIZE_MISMATCH' });
  await assert.rejects(fetchFileBytes(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, {}, 206) }), { code: 'BAD_FILE' });
});
test('a finished stream shorter than Content-Length is a failed download, not a successful file', async () => {
  const source = fixtureBytes('sample.pdf');
  await assert.rejects(fetchFileBytes(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, { 'content-length': String(source.length + 200) }) }), { code: 'SIZE_MISMATCH' });
});
test('transport decompression is not confused with a truncated decoded body', async () => {
  const source = fixtureBytes('sample.pdf');
  const bytes = await fetchFileBytes(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, { 'content-encoding': 'gzip', 'content-length': '400' }) });
  assert.equal(hash(bytes), hash(source));
});
test('a complete small Range response receives full structure validation and preserves response metadata', async () => {
  const source = fixtureBytes('sample.xlsx'), resource = named('xlsx');
  const result = await preflightFile(resource, { fetchImpl: async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-' + (PROBE_BYTES - 1));
    return downloadResponse(source, url, { 'content-range': 'bytes 0-' + (source.length - 1) + '/' + source.length, 'content-length': String(source.length), 'content-disposition': disposition(resource.name), etag: '"stable-version"' }, 206);
  } });
  assert.equal(result.expectedBytes, source.length); assert.equal(result.responseName, resource.name); assert.equal(result.etag, '"stable-version"');
  assert.equal(result.sampleComplete, true); assert.equal(result.level, 'container-crc');
});
test('large Range probes are explicitly partial and never pretend the whole document was checked', async () => {
  const source = fixtureBytes('sample.ppt'), bytes = source.subarray(0, PROBE_BYTES);
  const result = await preflightFile(named('ppt'), { fetchImpl: async url => downloadResponse(bytes, url, { 'content-range': 'bytes 0-' + (PROBE_BYTES - 1) + '/' + source.length }, 206) });
  assert.equal(result.sampleComplete, false); assert.equal(result.level, 'prefix'); assert.equal(result.expectedBytes, source.length);
});
test('invalid Range offsets and truncated Range bodies are rejected', async () => {
  const source = fixtureBytes('sample.pdf');
  await assert.rejects(preflightFile(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, { 'content-range': 'bytes 5-999/1000' }, 206) }), { code: 'BAD_FILE' });
  await assert.rejects(preflightFile(named('pdf'), { fetchImpl: async url => downloadResponse(source, url, { 'content-range': 'bytes 0-999/1000' }, 206) }), { code: 'SIZE_MISMATCH' });
});
test('JSON/XML/HTML originals are not rejected simply for being legitimate text attachments', async () => {
  for (const [ext, type, content] of [['json', 'application/json', '{"fixture":true}'], ['xml', 'application/xml', '<?xml version="1.0"?><fixture/>'], ['html', 'text/html', '<!doctype html><html><title>Lecture</title></html>']]) {
    const resource = named(ext), source = strToU8(content);
    const bytes = await fetchFileBytes(resource, { fetchImpl: async url => downloadResponse(source, url, { 'content-type': type, 'content-disposition': disposition(resource.name) }) });
    assert.equal(hash(bytes), hash(source));
  }
});
test('portable filenames preserve legal double spaces and bound entire deep paths', () => {
  assert.equal(safeSegment('Lecture  01.PDF', { filename: true }), 'Lecture  01.PDF');
  const deep = file(1, { name: '😀中文'.repeat(80) + '.DOCX', pathSegments: Array.from({ length: 20 }, (_, i) => '长目录' + i + '课'.repeat(40)) });
  const saved = filePath(deep, { courseName: '课程'.repeat(90), section: true });
  assert.ok(saved.length <= 200, saved); assert.ok(saved.endsWith('.DOCX'));
  for (const part of saved.split('/')) { assert.ok(new TextEncoder().encode(part).length <= 240); assert.ok(part.length <= 120); }
  const used = new Set(), first = uniqueArchivePath(deep, used), second = uniqueArchivePath(deep, used);
  assert.notEqual(first, second); assert.ok(second.length <= 200); assert.ok(second.endsWith('.DOCX'));
  assert.notEqual(safeSegment('a'.repeat(130) + '1.pdf', { filename: true }), safeSegment('a'.repeat(130) + '2.pdf', { filename: true }));
});
test('file validation derives the type from the original name, not stale message metadata', () => {
  const value = validateFile(file(1, { name: 'example  two.PPTX', ext: 'pdf', group: 'pdf' }));
  assert.equal(value.ext, 'pptx'); assert.equal(value.group, 'ppt'); assert.equal(value.name, 'example  two.PPTX');
});
test('ZIP entries retain each selected file hash with Unicode names, collisions and directory grouping', async () => {
  const files = ['pdf', 'pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'png', 'jpg'].map((ext, i) => file(i + 1, { name: '中文  课件 + α.' + ext.toUpperCase(), ext, section: i % 2 ? 'unit' : 'resource', pathSegments: ['目录 ' + i] }));
  files.push(file(20, { ...files[0], ...file(20), name: files[0].name.toLowerCase(), pathSegments: files[0].pathSegments }));
  const originals = new Map(files.map(f => [f.id, fixtureBytes('sample.' + f.name.split('.').at(-1).toLowerCase())]));
  const zip = await createArchive(files, { fetchImpl: async url => { const resource = files.find(f => f.downloadUrl === url); return downloadResponse(originals.get(resource.id), url, { 'content-disposition': disposition(resource.name) }); } });
  const entries = unzipSync(new Uint8Array(await zip.blob.arrayBuffer())), used = new Set();
  assert.equal(Object.keys(entries).length, files.length);
  for (const resource of files) { const path = uniqueArchivePath(resource, used); assert.equal(hash(entries[path]), hash(originals.get(resource.id)), path); }
  assert.equal(inspectFileContent(new Uint8Array(await zip.blob.arrayBuffer()), { name: 'course.zip' }).level, 'container-crc');
});


test('Windows device aliases and superscript device names are made portable', () => {
  for (const name of ['CONIN$.txt', 'CONOUT$.pdf', 'COM¹.pdf', 'LPT².doc', 'NUL .pdf']) assert.ok(safeSegment(name, { filename: true }).startsWith('_'), name);
});
