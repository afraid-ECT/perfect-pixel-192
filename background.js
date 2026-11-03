/* Perfect Pixel 192 — MV3 service worker */

const APP = 'app.html';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'pp-open',
    title: '用 Perfect Pixel 192 处理这张图',
    contexts: ['image'],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const q = info && info.srcUrl ? `?src=${encodeURIComponent(info.srcUrl)}` : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(APP + q) });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL(APP) });
});
