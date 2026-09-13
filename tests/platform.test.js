import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDirectory, parsePreview, courseTitle } from '../src/platform/parse.js';
import { buildFilename, normalizeResourceUrl, validateFile } from '../src/platform/policy.js';
import { parseUnitPage, normalizeUnitEntryUrl, normalizeUnitPageUrl } from '../src/platform/unit.js';
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
