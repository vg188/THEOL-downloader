// Browser-neutral courseware primitives shared by the extension and the bookmarklet:
// displayed size text, original-file format signatures, and bounded body sampling.
// No `chrome.*` and no DOM: both surfaces can call these from any context.

const SIZE_UNITS = Object.freeze({
  b: 1, '字节': 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
});
const SIZE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(字节|[kmgt](?:i?b)?|b)\s*$/i;

// THEOL prints sizes such as "9.1M", "500MB" or "1024 字节". Binary multipliers, so
// the bookmarklet total matches the extension's. Anything else is unknown.
export function parseSize(text) {
  if (typeof text !== 'string') return null;
  const match = SIZE_PATTERN.exec(text);
  if (!match) return null;
  const bytes = Math.round(Number(match[1]) * SIZE_UNITS[match[2].toLowerCase()]);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

const LATIN1 = new TextDecoder('latin1');

// A PPT/PPTX download that is really the login page must never be written to disk,
// so the first bytes are matched against the original format's magic number.
export function hasFileSignature(bytes, extension) {
  if (extension === 'pdf') return /^%PDF-\d\.\d(?:[\r\n\t ]|$)/.test(LATIN1.decode(bytes));
  const signature = extension === 'ppt' ? [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] : [0x50, 0x4b, 0x03, 0x04];
  return signature.every((value, index) => bytes[index] === value);
}

// Deliberately distinct from network.js `readHtmlResponse`: that helper enforces its
// byte budget before charset-decoding a whole preview page and throws when oversized,
// while this one returns the leading bytes undecoded for signature checks and stops
// reading as soon as `maxBytes` arrive, cancelling the stream over the wasted tail.
export async function readBodySample(response, { maxBytes = 1024, signal } = {}) {
  if (!response?.body) return new Uint8Array(0);
  const sample = new Uint8Array(maxBytes);
  let length = 0;
  const reader = response.body.getReader();
  const stopReading = () => { void reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) stopReading();
    else signal.addEventListener('abort', stopReading, { once: true });
  }
  try {
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        const chunk = value.subarray(0, maxBytes - length);
        sample.set(chunk, length);
        length += chunk.length;
      }
    }
  } finally {
    signal?.removeEventListener('abort', stopReading);
    await reader.cancel().catch(() => {});
  }
  return sample.subarray(0, length);
}
