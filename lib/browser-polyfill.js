// lib/browser-polyfill.js — Chrome/Firefox compatibility shim
// RecallFox v3.7.2 (Chrome MV3)
//
// Chrome extension API pakai chrome.* (callback-based atau promise-based tergantung API).
// Firefox WebExtension API pakai browser.* (selalu promise-based).
//
// Polyfill ini membuat browser.* tersedia di Chrome dengan promise wrappers
// untuk API yang masih callback-based.
//
// Cara pakai: load file ini SEBELUM file lain di popup.html, sidebar.html, settings.html,
// dan sebagai content script pertama di manifest content_scripts.
// Untuk background service worker, import di awal background.js.

(function () {
  if (typeof globalThis.browser !== 'undefined') {
    // Firefox atau sudah ter-polyfill — skip
    return;
  }
  if (typeof chrome === 'undefined') {
    console.warn('[RecallFox] Neither browser nor chrome API found');
    return;
  }

  // Untuk Chrome: alias browser = chrome (most APIs are already promise-based in MV3)
  globalThis.browser = chrome;

  // Wrap callback-based APIs dengan promise version
  // Chrome MV3 sebagian besar sudah promise-based, tapi beberapa API legacy masih callback:
  // - chrome.contextMenus.create (sync, no callback needed)
  // - chrome.contextMenus.onClicked (event listener, no promise)
  // - chrome.tabs.onUpdated (event listener)
  // - chrome.runtime.onMessage (event listener)
  // - chrome.storage.* (sudah promise-based)
  // - chrome.tabs.* (sudah promise-based)
  // - chrome.scripting.* (sudah promise-based)
  // - chrome.notifications.create (callback optional)
  // - chrome.browsingData.remove (sudah promise-based)
  // - chrome.downloads.download (sudah promise-based)
  // - chrome.permissions.request (sudah promise-based)

  // Sebagian besar sudah OK. Tapi untuk safety, kita pastikan
  // chrome.runtime.sendMessage returns promise (di MV3 sudah, tapi just in case)
  if (chrome.runtime && chrome.runtime.sendMessage && !chrome.runtime.sendMessage._promiseWrapped) {
    const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (...args) {
      // Jika callback diberikan, pakai original behavior
      if (typeof args[args.length - 1] === 'function') {
        return origSendMessage(...args);
      }
      // Tanpa callback — return promise
      return new Promise((resolve, reject) => {
        origSendMessage(...args, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    };
    chrome.runtime.sendMessage._promiseWrapped = true;
  }

  // chrome.tabs.sendMessage — sama, pastikan promise-based
  if (chrome.tabs && chrome.tabs.sendMessage && !chrome.tabs.sendMessage._promiseWrapped) {
    const origTabSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = function (...args) {
      if (typeof args[args.length - 1] === 'function') {
        return origTabSendMessage(...args);
      }
      return new Promise((resolve, reject) => {
        origTabSendMessage(...args, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    };
    chrome.tabs.sendMessage._promiseWrapped = true;
  }

  // chrome.storage.local.get — di MV3 sudah promise-based, tapi Chrome < 88 masih callback.
  // Wrap untuk safety.
  if (chrome.storage && chrome.storage.local && !chrome.storage.local._promiseWrapped) {
    const wrapStorageArea = (area) => {
      const origGet = area.get.bind(area);
      const origSet = area.set.bind(area);
      const origRemove = area.remove.bind(area);
      const origClear = area.clear.bind(area);

      area.get = function (keys) {
        if (typeof keys === 'function') {
          return origGet(keys); // callback mode
        }
        return new Promise((resolve, reject) => {
          origGet(keys || null, (result) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result);
          });
        });
      };
      area.set = function (items) {
        return new Promise((resolve, reject) => {
          origSet(items, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      };
      area.remove = function (keys) {
        return new Promise((resolve, reject) => {
          origRemove(keys, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      };
      area.clear = function () {
        return new Promise((resolve, reject) => {
          origClear(() => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      };
      area._promiseWrapped = true;
    };

    wrapStorageArea(chrome.storage.local);
    if (chrome.storage.sync) wrapStorageArea(chrome.storage.sync);
  }

  console.log('[RecallFox] Chrome polyfill loaded — browser.* = chrome.*');
})();
