import assert from 'node:assert/strict';
import test from 'node:test';
import { ZIP_LIMIT_BYTES, planDownload } from '../../src/bookmarklet/download-plan.js';

const MiB = 1024 * 1024;
const sized = (...sizes) => sizes.map(sizeBytes => ({ sizeBytes }));

test('exact limit routes to a single local ZIP', () => {
  assert.equal(ZIP_LIMIT_BYTES, 500 * MiB);
  assert.equal(planDownload([{ sizeBytes: 500 * MiB }]).mode, 'zip');
  assert.equal(planDownload(sized(0)).mode, 'zip');
  assert.equal(planDownload(sized(1)).mode, 'zip');
  assert.equal(planDownload(sized(300 * MiB, 200 * MiB)).mode, 'zip');
});

test('one byte over the limit routes to direct download with OVER_LIMIT', () => {
  assert.equal(planDownload([{ sizeBytes: 500 * MiB + 1 }]).reason, 'OVER_LIMIT');
  const over = planDownload(sized(400 * MiB, 100 * MiB + 1));
  assert.equal(over.mode, 'direct');
  assert.equal(over.reason, 'OVER_LIMIT');
  assert.equal(over.knownTotalBytes, 500 * MiB + 1);
});

test('any unknown size routes to direct download with UNKNOWN_SIZE', () => {
  const unknown = planDownload([{ sizeBytes: null }]);
  assert.equal(unknown.mode, 'direct');
  assert.equal(unknown.reason, 'UNKNOWN_SIZE');
  const mixed = planDownload([...sized(MiB), { sizeBytes: null }, { sizeBytes: undefined }]);
  assert.equal(mixed.reason, 'UNKNOWN_SIZE');
  assert.equal(mixed.unknownCount, 2);
  assert.equal(mixed.knownTotalBytes, MiB);
});

test('a known total over the limit outranks an unknown size', () => {
  const plan = planDownload([...sized(600 * MiB), { sizeBytes: null }]);
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.reason, 'OVER_LIMIT');
  assert.equal(plan.unknownCount, 1);
});

test('an empty selection is blocked and exact numbers are reported', () => {
  const empty = planDownload([]);
  assert.equal(empty.mode, 'blocked');
  assert.equal(empty.fileCount, 0);
  assert.deepEqual(planDownload(sized(3 * MiB, 4 * MiB)), {
    mode: 'zip', fileCount: 2, knownTotalBytes: 7 * MiB, unknownCount: 0, limitBytes: ZIP_LIMIT_BYTES,
  });
});

test('planning never mutates the input and ignores malformed sizes', () => {
  const files = [{ sizeBytes: MiB }, { sizeBytes: -1 }, { sizeBytes: 1.5 }, {}, 'nonsense'];
  const copy = structuredClone(files);
  const plan = planDownload(files);
  assert.equal(plan.unknownCount, 4, 'negative, fractional, missing, and invalid sizes are unknown');
  assert.equal(plan.knownTotalBytes, MiB);
  assert.deepEqual(files, copy);
  assert.equal(planDownload(undefined).mode, 'blocked');
});
