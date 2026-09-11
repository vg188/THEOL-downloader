import { createBridge } from './background/bridge.js';
import { createQueue } from './background/queue.js';
import { createRouter } from './background/app.js';
import { preflight } from './background/preflight.js';
import { errorResult } from './platform/policy.js';

const SCAN_KEY = 'buct.scan.v1', QUEUE_KEY = 'buct.queue.v1';
const readScan = async () => (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY] || null;
const writeScan = state => chrome.storage.session.set({ [SCAN_KEY]: state });
const queue = createQueue({
  storage: { read: async () => (await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY] || null,
    write: state => chrome.storage.session.set({ [QUEUE_KEY]: state }) },
  downloads: chrome.downloads, preflight, extensionId: chrome.runtime.id,
});
const bridge = createBridge(chrome, { readScan, writeScan });
const route = createRouter({ chrome, bridge, queue });

// Register listeners before asynchronous initialization so worker wakeups cannot miss events.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  Promise.resolve().then(() => route(message, sender)).then(
    data => respond({ ok: true, data }),
    error => respond({ ok: false, error: errorResult(error) }),
  );
  return true;
});
chrome.downloads.onChanged.addListener(() => { void queue.refresh().catch(() => {}); });
chrome.downloads.onErased.addListener(() => { void queue.refresh().catch(() => {}); });
void queue.init().catch(() => {});
