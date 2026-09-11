import { mountPopup } from './view.js';

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const app = await mountPopup({ document, activeTab: tab?.id,
    send: async message => {
      if (message.type === 'OPEN_DOWNLOADS') { await chrome.tabs.create({url:'chrome://downloads/'}); return {ok:true,data:null}; }
      return chrome.runtime.sendMessage(message);
    },
    subscribe: changed => {
      const listener = (changes, area) => { if (area === 'session' && Object.keys(changes).some(key => key.startsWith('buct.'))) changed(); };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  });
  window.addEventListener('unload', () => app.destroy(), { once: true });
} catch {
  const notice=document.getElementById('notice');notice.hidden=false;notice.textContent='无法连接扩展，请在 Chrome 扩展管理页重新加载后再试';
}
