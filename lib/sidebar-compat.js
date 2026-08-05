// lib/sidebar-compat.js — Cross-browser sidebar abstraction
// Firefox: browser.sidebarAction.open() / .close() / .isOpen()
// Chrome:  chrome.sidePanel.open({tabId}) / setPanelBehavior({openPanelOnActionClick})
//
// Chrome Side Panel API (Chrome 114+):
//   - chrome.sidePanel.open({tabId}) — buka side panel untuk tab tertentu
//   - chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true/false})
//   - TIDAK ada .close() atau .isOpen() — Chrome otomatis toggle via toolbar icon
//   - User close via X button di side panel
//
// Strategy:
//   - openSidebar(): Firefox → sidebarAction.open(); Chrome → sidePanel.open({tabId})
//   - closeSidebar(): Firefox → sidebarAction.close(); Chrome → no-op (user close manual)
//   - isSidebarOpen(): Firefox → sidebarAction.isOpen(); Chrome → return false (tidak bisa cek)

/**
 * Detect browser: Firefox or Chrome.
 */
function isFirefox() {
  // Firefox punya browser.sidebarAction native (tanpa polyfill)
  // Chrome pakai chrome.sidePanel
  return typeof browser !== 'undefined' &&
         typeof browser.sidebarAction !== 'undefined' &&
         typeof browser.runtime !== 'undefined' &&
         browser.runtime.getURL('').startsWith('moz-extension://');
}

/**
 * Get active tab ID (untuk Chrome sidePanel.open({tabId})).
 */
async function getActiveTabId() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0]?.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Open sidebar.
 * Firefox: browser.sidebarAction.open()
 * Chrome:  chrome.sidePanel.open({ tabId })
 */
export async function openSidebar() {
  // Chrome path
  if (typeof chrome !== 'undefined' && chrome.sidePanel) {
    const tabId = await getActiveTabId();
    if (tabId) {
      await chrome.sidePanel.open({ tabId });
      console.log('[RecallFox/sidebar] Chrome sidePanel opened for tab', tabId);
      return { ok: true };
    }
    console.warn('[RecallFox/sidebar] No active tab ID for sidePanel.open');
    return { ok: false, error: 'no_active_tab' };
  }
  // Firefox path
  if (browser.sidebarAction) {
    await browser.sidebarAction.open();
    console.log('[RecallFox/sidebar] Firefox sidebarAction opened');
    return { ok: true };
  }
  console.warn('[RecallFox/sidebar] No sidebar API available');
  return { ok: false, error: 'no_sidebar_api' };
}

/**
 * Close sidebar.
 * Firefox: browser.sidebarAction.close()
 * Chrome:  no-op (user close via X button — Chrome API tidak provide close)
 */
export async function closeSidebar() {
  if (isFirefox() && browser.sidebarAction) {
    await browser.sidebarAction.close();
    console.log('[RecallFox/sidebar] Firefox sidebarAction closed');
    return { ok: true };
  }
  // Chrome: tidak bisa close secara programmatic. User klik X di side panel.
  console.log('[RecallFox/sidebar] Chrome: close not supported (user close via X button)');
  return { ok: false, error: 'chrome_cannot_close' };
}

/**
 * Check if sidebar is open.
 * Firefox: browser.sidebarAction.isOpen({})
 * Chrome:  return false (API tidak provide isOpen)
 */
export async function isSidebarOpen() {
  if (isFirefox() && browser.sidebarAction?.isOpen) {
    try {
      return await browser.sidebarAction.isOpen({});
    } catch (e) {
      return false;
    }
  }
  // Chrome: tidak bisa cek — return false
  return false;
}

/**
 * Toggle sidebar.
 * Firefox: open if closed, close if open.
 * Chrome:  always open (tidak bisa close programmatic).
 */
export async function toggleSidebar() {
  const isOpen = await isSidebarOpen();
  if (isOpen) {
    return await closeSidebar();
  } else {
    return await openSidebar();
  }
}

/**
 * Setup side panel behavior on install/startup.
 * Chrome: set openPanelOnActionClick = false supaya klik icon buka popup, bukan side panel.
 * Firefox: no-op.
 */
export async function setupSidebarBehavior() {
  if (typeof chrome !== 'undefined' && chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      console.log('[RecallFox/sidebar] Chrome sidePanel behavior set (openPanelOnActionClick=false)');
    } catch (e) {
      console.warn('[RecallFox/sidebar] setPanelBehavior failed:', e.message);
    }
  }
}
