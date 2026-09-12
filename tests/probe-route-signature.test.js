import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  routeSignature,
  classifyNavigation,
  groupRouteSignatures,
} from '../probe/route-signature.js';

const origin = 'https://course.buct.edu.cn';

test('route signatures retain structure and remove all user-specific values', () => {
  const result = routeSignature(
    '/meol;tenant=PRIVATE/unit;flag/open.jsp;jsessionid=SECRET;student=%E5%BC%A0%E4%B8%89?courseId=15507&unitId=99&unitId=99#student-name',
    `${origin}/meol/course/index.jsp?courseId=15507`,
  );
  assert.deepEqual(result, {
    endpoint: '/meol/unit/open.jsp',
    queryKeys: ['courseId', 'unitId'],
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|flag|SECRET|student|%E5%BC%A0%E4%B8%89|15507|99|student-name/);
});

test('route signatures reject non-school, credentialed, and non-http navigation', () => {
  for (const value of [
    'https://evil.test/unit.jsp?id=1',
    'https://user:password@course.buct.edu.cn/unit.jsp?id=1',
    'http://course.buct.edu.cn/unit.jsp?id=1',
    'javascript:alert(1)',
    'data:text/html,test',
  ]) assert.equal(routeSignature(value, origin), null);
});

test('navigation classification never includes labels, href values, or markup', () => {
  const document = new JSDOM(`
    <a id="href" href="/meol/unit.jsp?courseId=12&unitId=34">第一次 张同学</a>
    <form id="form" action="/meol/unit/list.jsp?courseId=12"><button>第二次</button></form>
    <button id="scripted" onclick="openSecret(12,34)">第三次</button>
  `, { url: `${origin}/meol/course.jsp?courseId=12` }).window.document;
  assert.deepEqual(classifyNavigation(document.querySelector('#href'), document.URL), {
    mechanism: 'href',
    route: { endpoint: '/meol/unit.jsp', queryKeys: ['courseId', 'unitId'] },
  });
  assert.deepEqual(classifyNavigation(document.querySelector('#form button'), document.URL), {
    mechanism: 'form',
    route: { endpoint: '/meol/unit/list.jsp', queryKeys: ['courseId'] },
  });
  assert.deepEqual(classifyNavigation(document.querySelector('#scripted'), document.URL), {
    mechanism: 'scripted',
    route: null,
  });
  const serialized = JSON.stringify([
    classifyNavigation(document.querySelector('#href'), document.URL),
    classifyNavigation(document.querySelector('#scripted'), document.URL),
  ]);
  assert.doesNotMatch(serialized, /张同学|第一次|openSecret|12|34|href=/);
});

test('route groups expose only repeated structural types and counts', () => {
  const document = new JSDOM(`
    <a href="/meol/unit.jsp?unitId=1&courseId=12">第一次</a>
    <a href="/meol/unit.jsp?courseId=12&unitId=2">第二次</a>
    <a href="https://evil.test/unit.jsp?unitId=3">外站</a>
  `, { url: `${origin}/meol/course.jsp?courseId=12` }).window.document;
  assert.deepEqual(groupRouteSignatures(document, document.URL), [{
    mechanism: 'href',
    endpoint: '/meol/unit.jsp',
    queryKeys: ['courseId', 'unitId'],
    count: 2,
  }]);
});
