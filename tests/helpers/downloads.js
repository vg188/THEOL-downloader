export const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };
export function memoryStorage(initial = null) {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), write: async next => { value = structuredClone(next); } };
}
export function fakeDownloads() {
  const items = new Map(); let next = 100;
  return {
    items, calls: [], failNext: false, immediatelyComplete: false,
    async download(options) {
      this.calls.push(options);
      if (this.failNext) { this.failNext=false; throw new Error('private failure detail'); }
      const id = next++;
      items.set(id, { id, url: options.url, finalUrl:options.url, filename:options.filename, byExtensionId:'test-extension',
        state:this.immediatelyComplete ? 'complete' : 'in_progress', mime:'application/vnd.ms-powerpoint',
        bytesReceived: this.immediatelyComplete ? 100 : 0, totalBytes:100, startTime:new Date().toISOString() });
      return id;
    },
    async search(query) { return [...items.values()].filter(i => (query.id == null || i.id === query.id) && (!query.url || i.url === query.url) && (!query.startedAfter || i.startTime >= query.startedAfter)).map(i => ({...i})); },
    async cancel(id) { const i=items.get(id); if(i) {i.state='interrupted';i.error='USER_CANCELED';} },
    async show(id) { return items.has(id); },
    activeCount() { return [...items.values()].filter(i=>i.state==='in_progress').length; },
    completeFirst() { const i=[...items.values()].find(i=>i.state==='in_progress'); if(i){i.state='complete';i.bytesReceived=i.totalBytes;} },
  };
}
