import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDirectory, parsePreview, courseTitle } from '../src/platform/parse.js';
import { buildFilename, normalizeResourceUrl, validateFile } from '../src/platform/policy.js';
import { parseSize, hasFileSignature, readBodySample } from '../src/platform/file-content.js';
import { parseUnitPage, parseUnitPageFrames, parseUnitIndex, normalizeUnitEntryUrl, normalizeUnitPageUrl } from '../src/platform/unit.js';
import { dom, listUrl, previewUrl, resource, preview, file, unitEntryUrl, unitPageUrl } from './helpers/dom.js';
const code = value => error => error.code === value;
test('list with extensionless names resolves actual PPT metadata', () => {
  const directory = parseDirectory(dom('<a href="preview/download_preview.jsp?fileid=56&resid=78&lid=12">第一章</a>'), listUrl);
  assert.equal(directory.resources[0].id, '12:78:56');
  const parsed = parsePreview(dom(preview()), directory.resources[0]);
  assert.equal(parsed.name, '第一章.PPT');
  assert.equal(parsed.extension, 'ppt');
  assert.equal(parsed.sizeText, '9.1M');
  assert.equal(buildFilename('电路', parsed.name), '电路/第一章.PPT');
});
test('only current folder links are collected; duplicates and other courses ignored', () => {
  const html = `<a href="listview.jsp?lid=12&folderid=35">子目录</a><a href="${previewUrl()}">A</a><a href="${previewUrl()}">A</a><a href="${previewUrl().replace('lid=12', 'lid=99')}">B</a>`;
  const directory = parseDirectory(dom(html), listUrl);
  assert.equal(directory.resources.length, 1);
  assert.notEqual(directory.key, parseDirectory(dom(''), listUrl).key);
  assert.equal(parseDirectory(dom(html), 'https://course.buct.edu.cn/meol/personal.do'), null);
});
test('canonical URLs strip session tokens, extra parameters and fragments', () => {
  const source = `${previewUrl().replace('.jsp?', '.jsp;jsessionid=TESTTOKEN?')}&token=secret#fragment`;
  const result = normalizeResourceUrl(source, 'preview');
  assert.equal(result.url, previewUrl());
  assert.equal(result.id, '12:78:56');
});
for (const value of [
  'https://evil.test/a', 'javascript:alert(1)', 'http://course.buct.edu.cn/a',
  previewUrl().replace('https://', 'https://user:password@'),
  `${previewUrl()}&fileid=57`, previewUrl().replace('fileid=56', 'fileid=-1'),
  previewUrl().replace('fileid=56', 'fileid=1e3'),
  previewUrl().replace('/preview/', '/preview%2f'),
]) test(`rejects unsafe resource: ${value.replace(/password/g, 'redacted')}`, () => {
  assert.throws(() => normalizeResourceUrl(value, 'preview'));
});
test('preview preserves filename parentheses and spaces, permits missing size', () => {
  const parsed = parsePreview(dom(preview('章节 (修订版).pptx', 56, '')), resource());
  assert.equal(parsed.name, '章节 (修订版).pptx');
  assert.equal(parsed.sizeText, '大小未知');
  assert.equal(parsed.extension, 'pptx');
  assert.equal(parsePreview(dom(preview('第1章.PDF')), resource()).extension, 'pdf');
});
test('preview reports the displayed size as bytes as well as text', () => {
  assert.equal(parsePreview(dom(preview('A.pdf', 56, '9.1M')), resource()).sizeBytes, Math.round(9.1 * 1024 * 1024));
  const spaced = parsePreview(dom(preview('B.ppt', 56, '1.5 M')), resource());
  assert.equal(spaced.sizeText, '1.5M');
  assert.equal(spaced.sizeBytes, Math.round(1.5 * 1024 * 1024));
  const unknown = parsePreview(dom(preview('章节 (修订版).pptx', 56, '')), resource());
  assert.equal(unknown.sizeText, '大小未知');
  assert.equal(unknown.sizeBytes, null);
});
test('size text parses binary units and rejects unknown or malformed values', () => {
  assert.equal(parseSize('500MB'), 500 * 1024 * 1024);
  assert.equal(parseSize('1.5M'), Math.round(1.5 * 1024 * 1024));
  assert.equal(parseSize('1024 字节'), 1024);
  assert.equal(parseSize('大小未知'), null);
  for (const [text, bytes] of [
    ['0B', 0], ['512 b', 512], ['2K', 2 * 1024], ['2 KB', 2 * 1024], ['2 KiB', 2 * 1024],
    ['3 mib', 3 * 1024 ** 2], ['4G', 4 * 1024 ** 3], ['4GB', 4 * 1024 ** 3], ['5TiB', 5 * 1024 ** 4],
  ]) assert.equal(parseSize(text), bytes, text);
  for (const value of ['', '   ', '-1M', '1.2.3M', 'M', '1PB', '9.1M 左右', '99999999999999999999T', 1024, null, undefined]) {
    assert.equal(parseSize(value), null, String(value));
  }
});
test('original-file signatures are matched byte-wise', () => {
  const text = value => new TextEncoder().encode(value);
  assert.equal(hasFileSignature(text('%PDF-1.7\n1234'), 'pdf'), true);
  assert.equal(hasFileSignature(text('%PDF-2.0'), 'pdf'), true);
  for (const body of ['', 'login %PDF-1.7', '<!-- %PDF-1.7 -->', '%PDF-not-a-version', 'prefix\n%PDF-1.7']) {
    assert.equal(hasFileSignature(text(body), 'pdf'), false, body);
  }
  assert.equal(hasFileSignature(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'ppt'), true);
  assert.equal(hasFileSignature(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0x00]), 'ppt'), false);
  assert.equal(hasFileSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'pptx'), true);
  assert.equal(hasFileSignature(new Uint8Array(0), 'pptx'), false);
});
test('body samples keep short streams and stop at the byte budget', async () => {
  const short = await readBodySample(new Response(new Uint8Array([1, 2, 3])), { maxBytes: 8 });
  assert.deepEqual([...short], [1, 2, 3]);
  assert.equal((await readBodySample(new Response(null))).length, 0);
  let cancelled = false;
  const block = new Uint8Array(64).fill(0xab);
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(block); controller.enqueue(block); },
    cancel() { cancelled = true; },
  }));
  const sample = await readBodySample(response, { maxBytes: 100 });
  assert.equal(sample.length, 100);
  assert.ok(sample.every(value => value === 0xab));
  assert.equal(cancelled, true);
});
test('an already aborted signal cancels body sampling without reading', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([7, 8])); },
    cancel() { cancelled = true; },
  }));
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await readBodySample(response, { maxBytes: 64, signal: aborted.signal })).length, 0);
  assert.equal(cancelled, true);
});
test('preview cannot invent download links or mix resource IDs', () => {
  assert.throws(() => parsePreview(dom('<h2>文件名:A.ppt</h2>'), resource()), code('NO_DOWNLOAD'));
  assert.throws(() => parsePreview(dom(preview('A.ppt', 57)), resource()), code('NO_DOWNLOAD'));
  assert.throws(() => parsePreview(dom(preview('A.exe')), resource()), code('UNSUPPORTED_TYPE'));
});
test('login and error HTML are not valid metadata', () => {
  assert.throws(() => parsePreview(dom('<title>统一身份认证登录</title><h1>登录</h1>'), resource()), code('LOGIN_REQUIRED'));
  assert.throws(() => parsePreview(dom('<h1>服务器错误</h1>'), resource()));
});
test('script markup is never treated as filename text or executed', () => {
  const parsed = parsePreview(dom('<h2>文件名:&lt;img onerror=alert(1)&gt;.pdf (2M)<script>throw new Error("not run")</script><a href="' + file().downloadUrl + '">下载</a></h2>'), resource());
  assert.equal(parsed.name, '<img onerror=alert(1)>.pdf');
});
for (const [course, name, expected] of [
  ['../CON', '../../NUL.ppt', '.._CON/.._.._NUL.ppt'],
  ['CON', 'AUX.ppt', '_CON/_AUX.ppt'],
  ['', 'a:b?.pdf', '课件/a_b_.pdf'],
  ['C:\\temp', 'a/../b.pptx', 'C__temp/a_.._b.pptx'],
  ['课 程', '合法 名字.PPT', '课 程/合法 名字.PPT'],
]) test(`Windows-safe relative paths for ${name}`, () => {
  assert.equal(buildFilename(course, name), expected);
});
test('long file names retain the extension', () => {
  const result = buildFilename('课程', '长'.repeat(300) + '.pptx');
  assert.ok(result.endsWith('.pptx'));
  assert.ok(result.length <= 180);
});
test('file validator rejects forged extensions, IDs and URLs', () => {
  assert.equal(validateFile(file()).id, file().id);
  assert.throws(() => validateFile({ ...file(), extension: 'pdf' }));
  assert.throws(() => validateFile({ ...file(), id: '99:78:56' }));
  assert.throws(() => validateFile({ ...file(), downloadUrl: 'https://evil.test/file.ppt' }));
});
test('course title uses only a recognizable course name', () => {
  assert.equal(courseTitle('网络课程—电路与模拟电子技术'), '电路与模拟电子技术');
  assert.equal(courseTitle('THEOL网络教学综合平台-北京化工大学'), '课件');
});

test('Windows limits count UTF-16 units and truncation cannot create reserved or dot-ending folders', () => {
  assert.ok(buildFilename('😀'.repeat(70), '😀'.repeat(200) + '.pptx').length <= 180);
  const dotted = buildFilename('A'.repeat(47) + '.' + 'B'.repeat(40), '课件.ppt');
  assert.ok(!/[. ]$/.test(dotted.split('/')[0]));
  const reserved = buildFilename('CON' + ' '.repeat(70) + 'tail', '课件.pdf');
  assert.notEqual(reserved.split('/')[0].toUpperCase(), 'CON');
});
test('explicitly hidden or disabled download controls are not used', () => {
  for (const attributes of ['hidden', 'aria-disabled="true"', 'style="display: none"', 'style="visibility:hidden"']) {
    assert.throws(() => parsePreview(dom(preview().replace('<a href=', `<a ${attributes} href=`)), resource()), code('NO_DOWNLOAD'));
  }
});


test('UTF-16 truncation keeps emoji intact and every path segment within its limit', () => {
  const result = buildFilename('课' + '😀'.repeat(50), '文' + '😀'.repeat(200) + '.PPTX');
  const [folder, filename] = result.split('/');
  assert.ok(folder.length <= 48);
  assert.ok(filename.length <= 120);
  assert.ok(result.isWellFormed());
  assert.ok(result.endsWith('.PPTX'));
});
test('download controls in unavailable ancestors are skipped without hiding eligible siblings', () => {
  for (const attributes of ['hidden', 'inert', 'disabled', 'aria-hidden="true"', 'aria-disabled="true"', 'style="display:none!important"', 'style="visibility:collapse"']) {
    const html = preview().replace('<a href=', '<span ' + attributes + '><a href=').replace('</a>', '</a></span>');
    assert.throws(() => parsePreview(dom(html), resource()), code('NO_DOWNLOAD'));
    assert.equal(parsePreview(dom(html + '<a href="' + file().downloadUrl + '">下载</a>'), resource()).downloadUrl, file().downloadUrl);
  }
});
test('hidden list ancestors do not become scanned resources', () => {
  const html = '<div style="display:none"><a href="' + previewUrl() + '">隐藏</a></div>';
  assert.equal(parseDirectory(dom(html), listUrl).resources.length, 0);
});

const unitAnchor = (n = 56, lid = 12) => `<a href="/meol/common/script/preview/download_preview.jsp?fileid=${n}&resid=${n + 22}&lid=${lid}">第${n}份</a>`;
test('unit entry canonicalizes to exact columnId and tagbug order', () => {
  assert.deepEqual(normalizeUnitEntryUrl(unitEntryUrl(44)), {
    columnId: '44',
    url: 'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?columnId=44&tagbug=client',
  });
});
for (const value of [
  unitEntryUrl().replace('https://', 'http://'),
  unitEntryUrl().replace('course.buct.edu.cn', 'evil.test'),
  unitEntryUrl() + '&columnId=45',
  unitEntryUrl().replace('columnId=41', 'columnId=-1'),
  unitEntryUrl().replace('tagbug=client', 'tagbug=server'),
  unitEntryUrl().replace('course_column_preview_transfer.jsp', 'resFolderViewList.do'),
  unitEntryUrl().replace('columnId=41', 'columnId='),
  unitEntryUrl() + '#fragment',
]) test(`rejects unsafe unit entry: ${value}`, () => {
  assert.throws(() => normalizeUnitEntryUrl(value));
});
test('unit pages canonicalize for both layouts and match expected course', () => {
  for (const layout of ['lesson', 'newpage']) {
    assert.deepEqual(normalizeUnitPageUrl(unitPageUrl(layout), '12'), {
      courseId: '12',
      url: `https://course.buct.edu.cn/meol/jpk/course/layout/${layout}/index.jsp?courseId=12`,
      layout,
    });
  }
});
for (const value of [
  unitPageUrl().replace('/lesson/', '/other/'),
  unitPageUrl() + '&courseId=13',
  unitPageUrl().replace('courseId=12', 'courseId='),
  unitPageUrl().replace('https://', 'https://user:password@'),
  unitPageUrl() + '#section',
  'https://course.buct.edu.cn/meol/jpk/course/course_column_preview_transfer.jsp?tagbug=client&columnId=41',
]) test(`rejects unsafe unit page: ${value.replace(/password/g, 'redacted')}`, () => {
  assert.throws(() => normalizeUnitPageUrl(value, '12'));
});
test('unit page with wrong course is rejected against expected courseId', () => {
  assert.throws(() => normalizeUnitPageUrl(unitPageUrl('lesson', 13), '12'), code('INVALID_RESOURCE'));
});
test('current unit page collects only matching-course preview anchors', () => {
  for (const layout of ['lesson', 'newpage']) {
    const document = dom(`${unitAnchor(56)}${unitAnchor(57)}${unitAnchor(58, 99)}`);
    const unit = parseUnitPage(document, unitPageUrl(layout));
    assert.equal(unit.surface, 'unit-study');
    assert.equal(unit.layout, layout);
    assert.deepEqual(unit.resources.map(item => item.id), ['12:78:56', '12:79:57']);
    assert.deepEqual(unit.resources[0].unit, { entryUrl: null, title: '当前单元', order: 0, occurrenceCount: 1 });
  }
});
test('hidden or disabled unit anchors and duplicates are ignored', () => {
  for (const attributes of ['hidden', 'inert', 'disabled', 'aria-hidden="true"', 'aria-disabled="true"', 'style="display:none"', 'style="visibility:collapse"']) {
    const html = `<span ${attributes}>${unitAnchor(56)}</span>${unitAnchor(56)}${unitAnchor(57)}`;
    assert.deepEqual(parseUnitPage(dom(html), unitPageUrl()).resources.map(item => item.id), ['12:78:56', '12:79:57']);
    assert.deepEqual(parseUnitPage(dom(`<span ${attributes}>${unitAnchor(56)}</span>${unitAnchor(57)}`), unitPageUrl()).resources.map(item => item.id), ['12:79:57']);
  }
});
test('unit page keeps first duplicate and safe title text', () => {
  const document = dom(`<a href="/meol/common/script/preview/download_preview.jsp?fileid=56&resid=78&lid=12">  第一 份 <img onerror=alert(1) src=x> </a>`);
  const unit = parseUnitPage(document, unitPageUrl());
  assert.equal(unit.resources.length, 1);
  assert.equal(unit.resources[0].title, '第一 份');
});
test('unit page with no valid anchors returns empty resources, non-unit URL returns null', () => {
  const document = dom(`<a href="${unitEntryUrl()}">栏目</a><a href="https://course.buct.edu.cn/meol/buildless/resFolderViewList.do?columnId=41">文件夹</a>`);
  assert.deepEqual(parseUnitPage(document, unitPageUrl()).resources, []);
  assert.equal(parseUnitPage(document, listUrl), null);
});

test('unit surface aggregates courseware rendered by nested same-origin frames', () => {
  const window = {
    document: dom(unitAnchor(56)),
    frames: [
      { document: dom(`${unitAnchor(56)}${unitAnchor(57)}`), location: { href: listUrl } },
      { document: dom(unitAnchor(58, 99)), location: { href: listUrl } },
    ],
  };
  const unit = parseUnitPageFrames(window, unitPageUrl());
  assert.deepEqual(unit.resources.map(item => item.id), ['12:78:56', '12:79:57']);
});

test('unit surface skips unreadable frames and non-unit pages', () => {
  const window = {
    document: dom(''),
    frames: [Object.defineProperty({}, 'document', { get() { throw new Error('cross-origin'); } })],
  };
  const unit = parseUnitPageFrames(window, unitPageUrl());
  assert.deepEqual(unit.resources, []);
  assert.equal(unit.frameCount, 0);
  assert.equal(parseUnitPageFrames({ document: dom(unitAnchor(56)) }, listUrl), null);
  assert.equal(parseUnitPageFrames({}, unitPageUrl()), null);
});

test('unit index counts only the bounded list, not page-wide or navigation anchors', () => {
  const entry = unitEntryUrl;
  const document = dom(`
    <nav><a href="${entry(900)}">栏目</a></nav>
    <a href="${entry(901)}">游离链接</a>
    <ul id="units">
      <li><a href="${entry(41)}">第一次</a></li>
      <li><a href="${entry(42)}">第二次</a></li>
      <li><a href="${entry(43)}">第三次</a></li>
    </ul>`);
  const index = parseUnitIndex(document, unitPageUrl());
  assert.deepEqual(index.entries.map(item => item.columnId), ['41', '42', '43']);
  assert.equal(index.courseId, '12');
  assert.equal(index.key, `12|41:columnId=41&tagbug=client,42:columnId=42&tagbug=client,43:columnId=43&tagbug=client`);
});
test('unit index returns null for page-wide anchors without a list container or a non-unit page URL', () => {
  const entry = unitEntryUrl;
  const document = dom(`<div><a href="${entry(41)}">第一次</a> <a href="${entry(42)}">第二次</a></div>`);
  assert.equal(parseUnitIndex(document, unitPageUrl()), null);
  const listed = dom(`<ul><li><a href="${entry(41)}">第一次</a></li><li><a href="${entry(42)}">第二次</a></li></ul>`);
  assert.equal(parseUnitIndex(listed, listUrl), null);
});
test('two visible bounded groups are ambiguous', () => {
  const entry = unitEntryUrl;
  const document = dom(`
    <ul id="first"><li><a href="${entry(41)}">第一次</a></li><li><a href="${entry(42)}">第二次</a></li></ul>
    <ul id="second"><li><a href="${entry(43)}">第三次</a></li><li><a href="${entry(44)}">第四次</a></li></ul>`);
  assert.throws(() => parseUnitIndex(document, unitPageUrl()), code('AMBIGUOUS_UNIT_INDEX'));
});
test('single-entry groups are not counted', () => {
  const entry = unitEntryUrl;
  const document = dom(`
    <ul id="solo"><li><a href="${entry(41)}">第一次</a></li></ul>
    <ul id="pair"><li><a href="${entry(42)}">第二次</a></li><li><a href="${entry(43)}">第三次</a></li></ul>`);
  assert.deepEqual(parseUnitIndex(document, unitPageUrl()).entries.map(item => item.columnId), ['42', '43']);
});
test('nested lists count each anchor once in its nearest group', () => {
  const entry = unitEntryUrl;
  const document = dom(`
    <ul id="outer">
      <li><a href="${entry(41)}">第一次</a></li>
      <li><ul id="inner">
        <li><a href="${entry(42)}">第二次</a></li>
        <li><a href="${entry(43)}">第三次</a></li>
      </ul></li>
    </ul>`);
  const index = parseUnitIndex(document, unitPageUrl());
  assert.deepEqual(index.entries.map(item => item.columnId), ['42', '43']);
});
test('hidden groups are excluded and cannot create ambiguity', () => {
  const entry = unitEntryUrl;
  const visible = `<ul><li><a href="${entry(41)}">第一次</a></li><li><a href="${entry(42)}">第二次</a></li></ul>`;
  for (const attributes of ['hidden', 'inert', 'disabled', 'aria-hidden="true"', 'aria-disabled="true"', 'style="display:none"', 'style="visibility:collapse"']) {
    const document = dom(`<ul ${attributes}><li><a href="${entry(43)}">第三次</a></li><li><a href="${entry(44)}">第四次</a></li></ul>${visible}`);
    assert.deepEqual(parseUnitIndex(document, unitPageUrl()).entries.map(item => item.columnId), ['41', '42']);
  }
});
test('duplicate columnId keeps the first DOM occurrence', () => {
  const entry = unitEntryUrl;
  const document = dom(`<ul>
    <li><a href="${entry(41)}">第一次</a></li>
    <li><a href="${entry(42)}">第二次</a></li>
    <li><a href="${entry(41)}">重复单元</a></li>
    <li><a href="${entry(42)}">重复单元</a></li>
  </ul>`);
  const index = parseUnitIndex(document, unitPageUrl());
  assert.deepEqual(index.entries.map(item => item.columnId), ['41', '42']);
  assert.deepEqual(index.entries.map(item => item.title), ['第一次', '第二次']);
});
test('unsafe entry links and auxiliary routes never form a group', () => {
  const entry = unitEntryUrl;
  const document = dom(`<ul>
    <li><a href="${entry(41).replace('tagbug=client', 'tagbug=server')}">错误参数</a></li>
    <li><a href="${entry(42).replace('course_column_preview_transfer.jsp', 'resFolderViewList.do')}">文件夹</a></li>
    <li><a href="${entry(43).replace('https://', 'http://')}">不安全</a></li>
    <li><button onclick="go(44)">按钮</button></li>
    <li><a href="#">脚本单元</a></li>
  </ul>`);
  assert.equal(parseUnitIndex(document, unitPageUrl()), null);
});
test('entry titles are sanitized, truncated and fall back when empty', () => {
  const entry = unitEntryUrl;
  const long = '长'.repeat(250);
  const document = dom(`<ul>
    <li><a href="${entry(41)}">  第一 次 <img onerror=alert(1) src=x> </a></li>
    <li><a href="${entry(42)}">${long}</a></li>
    <li><a href="${entry(43)}"><img alt="" src=x></a></li>
  </ul>`);
  const index = parseUnitIndex(document, unitPageUrl());
  assert.deepEqual(index.entries.map(item => item.title), ['第一 次', '长'.repeat(200), '单元 3']);
  assert.deepEqual(index.entries.map(item => item.order), [0, 1, 2]);
});
test('role list containers and non-list markup do not mix groups', () => {
  const entry = unitEntryUrl;
  const document = dom(`
    <div role="list"><span role="listitem"><a href="${entry(41)}">第一次</a></span><span role="listitem"><a href="${entry(42)}">第二次</a></span></div>
    <ul><li><a href="${entry(43)}">第三次</a></li><li><a href="${entry(44)}">第四次</a></li></ul>`);
  assert.throws(() => parseUnitIndex(document, unitPageUrl()), code('AMBIGUOUS_UNIT_INDEX'));
});
