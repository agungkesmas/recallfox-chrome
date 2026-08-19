// content/ai-resolvers.js — AI domain detection + selector resolver
// v3.16.2: Refactor — pakai storage.aiSites sebagai single source of truth
// Hapus AI_DOMAINS dan AI_TOOLS_DOMAINS hardcoded.
// Deteksi via async isAIPage() dari storage.aiSites (lib/ai-detect.js).
//
// SELECTORS tetap static (konfigurasi DOM spesifik per AI tool untuk extraction).
// Tapi DETEKSI domain via aiSites (dynamic — user bisa tambah/hapus situs).

(function () {
  if (window.__recallfoxAiResolversLoaded) return;
  window.__recallfoxAiResolversLoaded = true;

  const DEBUG_AI = true;
  function logAI(...args) {
    if (!DEBUG_AI) return;
    console.log('[RecallFox AI]', ...args);
  }

  // matchDomain: case insensitive, support subdomain, anti-gagal
  function matchDomain(currentOrigin, configuredOrigin) {
    try {
      if (!currentOrigin || !configuredOrigin) return false;
      const current = new URL(currentOrigin);
      const config = new URL(configuredOrigin);
      const currentHost = current.hostname.toLowerCase();
      const configHost = config.hostname.toLowerCase();
      return currentHost === configHost || currentHost.endsWith('.' + configHost);
    } catch {
      return false;
    }
  }

  // SELECTORS tetap static (konfigurasi DOM spesifik per AI tool).
  // Hanya dipakai untuk extraction (dapatkan textarea, sendButton, dll).
  // Bukan untuk deteksi domain — deteksi pakai aiSites.
  const DOMAIN_SELECTORS = [
    {
      id: 'zai',
      name: 'z.ai',
      patterns: ['chat.z.ai'],
      selectors: {
        textarea: [
          'div[contenteditable="true"]#chat-input',
          'div[contenteditable="true"][data-testid*="input"]',
          'textarea#chat-input',
          'div[contenteditable="true"]'
        ],
        sendButton: [
          'button[type="submit"]',
          'button[aria-label="Send"]',
          'button[data-testid="send-button"]',
          'button[aria-label*="send" i]'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.message-user',
          '[data-role="user"]'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.message-assistant',
          '[data-role="assistant"]',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      patterns: ['chatgpt.com'],
      selectors: {
        textarea: [
          'div#prompt-textarea[contenteditable="true"]',
          'textarea#prompt-textarea',
          'div[contenteditable="true"][data-testid*="input"]'
        ],
        sendButton: [
          'button[data-testid="send-button"]',
          'button[aria-label*="send" i]',
          'button[type="submit"]'
        ],
        userMessage: [
          '[data-message-author-role="user"]',
          '[data-message-author="user"]',
          '.user-message'
        ],
        aiMessage: [
          '[data-message-author-role="assistant"]',
          '[data-message-author="assistant"]',
          '.assistant-message',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'claude',
      name: 'Claude',
      patterns: ['claude.ai'],
      selectors: {
        textarea: [
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
          'textarea'
        ],
        sendButton: [
          'button[aria-label*="send" i]',
          'button[type="submit"]',
          'button[data-testid*="send" i]'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.user-message',
          '[data-role="user"]'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.assistant-message',
          '[data-role="assistant"]',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'gemini',
      name: 'Gemini',
      patterns: ['gemini.google.com'],
      selectors: {
        textarea: [
          'div[contenteditable="true"][role="textbox"]',
          'rich-textarea textarea',
          'textarea'
        ],
        sendButton: [
          'button[aria-label*="send" i]',
          'button[type="submit"]',
          'button.send-button'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.user-message',
          'message-content[data-author="user"]'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.assistant-message',
          'message-content[data-author="model"]',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      patterns: ['chat.deepseek.com'],
      selectors: {
        textarea: [
          'textarea#chat-input',
          'div[contenteditable="true"]',
          'textarea'
        ],
        sendButton: [
          'button[type="submit"]',
          'button[aria-label*="send" i]'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.user-message'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.assistant-message',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'qwen',
      name: 'Qwen',
      patterns: ['chat.qwen.ai', 'tongyi.aliyun.com'],
      selectors: {
        textarea: [
          'div[contenteditable="true"][role="textbox"]',
          'textarea',
          'div[contenteditable="true"]'
        ],
        sendButton: [
          'button[type="submit"]',
          'button[aria-label*="send" i]'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.user-message'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.assistant-message',
          '.markdown-body'
        ]
      }
    },
    {
      id: 'kimi',
      name: 'Kimi',
      patterns: ['kimi.moonshot.cn', 'kimi.com'],
      selectors: {
        textarea: [
          'textarea',
          'div[contenteditable="true"]'
        ],
        sendButton: [
          'button[type="submit"]',
          'button[aria-label*="send" i]'
        ],
        userMessage: [
          '[data-message-author="user"]',
          '.user-message'
        ],
        aiMessage: [
          '[data-message-author="assistant"]',
          '.assistant-message',
          '.markdown-body'
        ]
      }
    }
  ];

  function getDomainConfig(url) {
    url = url || location.href;
    const host = (() => {
      try { return new URL(url).hostname; } catch (e) { return url; }
    })();
    for (const d of DOMAIN_SELECTORS) {
      for (const p of d.patterns) {
        if (host === p || host.endsWith('.' + p)) return d;
      }
    }
    return null;
  }

  // Generic fallback config — dipakai kalau domain AI tool tapi tidak ada selectors spesifik
  const GENERIC_FALLBACK_CONFIG = {
    id: 'generic',
    name: 'AI Chat (generic)',
    selectors: {
      textarea: [
        'div[contenteditable="true"][role="textbox"]',
        'textarea[data-testid*="input" i]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="ask" i]',
        'textarea',
        'div[contenteditable="true"]'
      ],
      sendButton: [
        'button[type="submit"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="submit" i]',
        'button[data-testid*="send" i]'
      ],
      userMessage: [
        '[data-message-author-role="user"]',
        '[data-message-author="user"]',
        '.user-message', '.message-user',
        '[data-role="user"]',
        '[class*="user"][class*="message"]'
      ],
      aiMessage: [
        '[data-message-author-role="assistant"]',
        '[data-message-author="assistant"]',
        '.assistant-message', '.message-assistant',
        '[data-role="assistant"]',
        '[class*="assistant"][class*="message"]',
        '[class*="ai"][class*="message"]',
        '.markdown-body'
      ]
    }
  };

  // ===== v3.16.2: isAIPage() — baca dari storage.aiSites (single source of truth) =====
  async function isAIPage() {
    try {
      const r = await browser.storage.local.get(['aiSites', 'settings']);
      let aiSites = r.aiSites;

      // Migration: kalau aiSites belum ada, build dari AI_TOOLS + customizations
      if (!aiSites || !Array.isArray(aiSites) || aiSites.length === 0) {
        logAI('aiSites empty, migrating from AI_TOOLS + customizations...');
        aiSites = await buildAiSitesFromLegacy(r.settings || {});
        if (aiSites.length > 0) {
          await browser.storage.local.set({ aiSites });
          logAI('Migration done:', aiSites.length, 'sites saved');
        }
      }

      if (!aiSites.length) {
        logAI('No aiSites configured');
        return false;
      }

      const currentOrigin = window.location.origin;
      for (const site of aiSites) {
        if (!site.active) continue;
        if (matchDomain(currentOrigin, site.origin)) {
          logAI('MATCH:', site.name, '→', currentOrigin);
          return true;
        }
      }
      logAI('NO MATCH:', currentOrigin);
      return false;
    } catch (err) {
      console.error('[AI DETECT ERROR] isAIPage:', err);
      return false;
    }
  }

  // buildAiSitesFromLegacy: migration dari AI_TOOLS + customizations
  async function buildAiSitesFromLegacy(settings) {
    try {
      const mod = await import(browser.runtime.getURL('lib/ai-detect.js'));
      return await mod.migrateFromAiTools(settings);
    } catch (e) {
      console.error('[AI DETECT] Migration failed:', e);
      return [];
    }
  }

  // ===== Init: set window flags =====
  async function init() {
    try {
      const isAI = await isAIPage();
      const specificConfig = getDomainConfig();

      // Set config: pakai spesifik kalau ada, kalau tidak pakai generic fallback
      if (specificConfig) {
        window.__RecallFoxDomainConfig__ = specificConfig;
      } else if (isAI) {
        window.__RecallFoxDomainConfig__ = GENERIC_FALLBACK_CONFIG;
      } else {
        window.__RecallFoxDomainConfig__ = null;
      }

      // __RecallFoxIsAIDomain__ = true kalau isAIPage() true
      window.__RecallFoxIsAIDomain__ = isAI;

      logAI('Init done: isAIPage=' + isAI + ', config=' + (window.__RecallFoxDomainConfig__?.name || 'none'));

      // Notify content.js that AI detection is ready
      window.dispatchEvent(new CustomEvent('recallfox-ai-detected', {
        detail: { isAI, configName: window.__RecallFoxDomainConfig__?.name || null }
      }));
    } catch (err) {
      console.error('[AI DETECT ERROR] init:', err);
      window.__RecallFoxIsAIDomain__ = false;
      window.__RecallFoxDomainConfig__ = null;
    }
  }

  // ===== Auto-update saat aiSites berubah =====
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aiSites) {
      logAI('aiSites updated, re-initializing...');
      init();
    }
  });

  // ===== Expose for content.js (synchronous fallback) =====
  // content.js mungkin baca __RecallFoxIsAIDomain__ sebelum init selesai.
  // Untuk gate yang async, content.js bisa pakai window.__recallfoxIsAIPage__() langsung.
  window.__recallfoxIsAIPage__ = isAIPage;
  window.__recallfoxMatchDomain__ = matchDomain;

  // ===== Run init (async) =====
  init();
})();
