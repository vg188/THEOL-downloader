// Bookmarklet download routing. Pure and browser-neutral: the 500 MiB rule
// decides between one local ZIP and confirmed sequential direct downloads.
export const ZIP_LIMIT_BYTES = 500 * 1024 * 1024;

// A size is known only when the platform reported a usable byte count.
function sizeOf(file) {
  const size = file?.sizeBytes;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function planDownload(files) {
  const list = Array.isArray(files) ? files : [];
  let knownTotalBytes = 0;
  let unknownCount = 0;
  for (const file of list) {
    const size = sizeOf(file);
    if (size === null) unknownCount++;
    else knownTotalBytes += size;
  }
  const summary = { fileCount: list.length, knownTotalBytes, unknownCount, limitBytes: ZIP_LIMIT_BYTES };
  if (!list.length) return Object.freeze({ ...summary, mode: 'blocked', reason: 'EMPTY_SELECTION' });
  // An already-known total over the limit outranks unknown sizes: the selected
  // bytes alone cannot be archived locally.
  if (knownTotalBytes > ZIP_LIMIT_BYTES) return Object.freeze({ ...summary, mode: 'direct', reason: 'OVER_LIMIT' });
  if (unknownCount) return Object.freeze({ ...summary, mode: 'direct', reason: 'UNKNOWN_SIZE' });
  return Object.freeze({ ...summary, mode: 'zip' });
}
