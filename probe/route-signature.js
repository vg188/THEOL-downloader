const SCHOOL_ORIGIN = 'https://course.buct.edu.cn';

function cleanPath(pathname) {
  return pathname.replace(/;[^/]*/g, '');
}

export function routeSignature(value, base = SCHOOL_ORIGIN) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== SCHOOL_ORIGIN || url.protocol !== 'https:' || url.username || url.password) return null;
  return {
    endpoint: cleanPath(url.pathname),
    queryKeys: [...new Set(url.searchParams.keys())].sort(),
  };
}

export function classifyNavigation(element, pageUrl) {
  const anchor = element?.closest?.('a[href]');
  if (anchor) return { mechanism:'href', route:routeSignature(anchor.getAttribute('href'), pageUrl) };
  const form = element?.closest?.('form');
  if (form) return { mechanism:'form', route:routeSignature(form.getAttribute('action') || pageUrl, pageUrl) };
  return { mechanism:'scripted', route:null };
}

export function groupRouteSignatures(document, pageUrl) {
  const groups = new Map();
  for (const element of document.querySelectorAll('a[href], form')) {
    const item = element.matches('form')
      ? { mechanism:'form', route:routeSignature(element.getAttribute('action') || pageUrl, pageUrl) }
      : classifyNavigation(element, pageUrl);
    if (!item.route) continue;
    const key = JSON.stringify([item.mechanism, item.route.endpoint, item.route.queryKeys]);
    const current = groups.get(key) || { mechanism:item.mechanism, ...item.route, count:0 };
    current.count++;
    groups.set(key, current);
  }
  return [...groups.values()].filter(item => item.count > 1)
    .sort((left, right) => right.count - left.count || left.endpoint.localeCompare(right.endpoint));
}
