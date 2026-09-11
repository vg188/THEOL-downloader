import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDirectory, parsePreview, courseTitle } from '../src/platform/parse.js';
import { buildFilename, normalizeResourceUrl, validateFile } from '../src/platform/policy.js';
import { dom, listUrl, previewUrl, resource, preview, file } from './helpers/dom.js';

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
