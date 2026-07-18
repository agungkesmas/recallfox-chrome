// content/browser-polyfill-cs.js — Chrome polyfill untuk content scripts
// RecallFox v3.7.2 (Chrome MV3)
//
// Versi ringkas dari lib/browser-polyfill.js untuk content scripts.
// Di-load sebagai content script pertama di setiap entry manifest.

(function () {
  if (typeof globalThis.browser !== 'undefined') return;
  if (typeof chrome === 'undefined') return;

  globalThis.browser = chrome;

  // Wrap chrome.runtime.sendMessage untuk return promise jika tanpa callback
  if (chrome.runtime && chrome.runtime.sendMessage && !chrome.runtime.sendMessage._promiseWrapped) {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (...args) {
      if (typeof args[args.length - 1] === 'function') return orig(...args);
      return new Promise((resolve, reject) => {
        orig(...args, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    };
    chrome.runtime.sendMessage._promiseWrapped = true;
  }

  // chrome.tabs.sendMessage
  if (chrome.tabs && chrome.tabs.sendMessage && !chrome.tabs.sendMessage._promiseWrapped) {
    const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = function (...args) {
      if (typeof args[args.length - 1] === 'function') return orig(...args);
      return new Promise((resolve, reject) => {
        orig(...args, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    };
    chrome.tabs.sendMessage._promiseWrapped = true;
  }

  // chrome.storage.local
  if (chrome.storage && chrome.storage.local && !chrome.storage.local._promiseWrapped) {
    const wrap = (area) => {
      const oGet = area.get.bind(area), oSet = area.set.bind(area);
      const oRemove = area.remove.bind(area), oClear = area.clear.bind(area);
      area.get = (keys) => {
        if (typeof keys === 'function') return oGet(keys);
        return new Promise((resolve, reject) => {
          oGet(keys || null, (r) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
      };
      area.set = (items) => new Promise((resolve, reject) => {
        oSet(items, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      area.remove = (keys) => new Promise((resolve, reject) => {
        oRemove(keys, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      area.clear = () => new Promise((resolve, reject) => {
        oClear(() => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      area._promiseWrapped = true;
    };
    wrap(chrome.storage.local);
    if (chrome.storage.sync) wrap(chrome.storage.sync);
  }
})();
