// lib/domains.js — AI tool domain resolvers (selector configs)
// RecallFox v0.1.0
//
// Setiap entry punya:
//   id, name, region, domainPatterns (array),
//   selectors: { textarea[], sendButton[], userMessage[], aiMessage[] }
// Selector pakai array of candidates, dicoba berurutan.

export const AI_DOMAINS = [
  // ===== Tier 1: MVP =====
  {
    id: 'zai',
    name: 'z.ai',
    region: 'china',
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
    region: 'west',
    patterns: ['chatgpt.com'],
    selectors: {
      textarea: [
        'div#prompt-textarea[contenteditable="true"]',
        'textarea#prompt-textarea',
        'div[contenteditable="true"][data-testid*="composer"]'
      ],
      sendButton: [
        'button[data-testid="send-button"]',
        'button[aria-label*="send" i]'
      ],
      userMessage: [
        '[data-message-author-role="user"]',
        'div[data-message-author="user"]'
      ],
      aiMessage: [
        '[data-message-author-role="assistant"]',
        'div[data-message-author="assistant"]'
      ]
    }
  },
  {
    id: 'claude',
    name: 'Claude',
    region: 'west',
    patterns: ['claude.ai'],
    selectors: {
      textarea: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        'div.ProseMirror[contenteditable="true"]'
      ],
      sendButton: [
        'button[aria-label="Send Message"]',
        'button[aria-label*="send" i]',
        'button[type="submit"]'
      ],
      userMessage: [
        'div[data-is-streaming][data-testid="user-message"]',
        '[data-message-author="user"]',
        'div.font-user-message'
      ],
      aiMessage: [
        'div[data-is-streaming][data-testid="ai-message"]',
        '[data-message-author="assistant"]',
        'div.font-claude-message'
      ]
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    region: 'west',
    patterns: ['gemini.google.com'],
    selectors: {
      textarea: [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="prompt" i]'
      ],
      sendButton: [
        'button[aria-label="Send message"]',
        'button[aria-label*="send" i]',
        'mat-icon[aria-label*="send" i]'
      ],
      userMessage: [
        'message-content[data-message-id] .query-text',
        '.query-text',
        '.user-query'
      ],
      aiMessage: [
        'message-content[data-message-id] .model-response-text',
        '.model-response-text',
        '.model-response'
      ]
    }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    region: 'china',
    patterns: ['chat.deepseek.com'],
    selectors: {
      textarea: [
        'textarea#chat-input',
        'textarea[placeholder*="Message" i]',
        'textarea'
      ],
      sendButton: [
        'button.ds-button[type="submit"]',
        'div[role="button"][aria-label*="send" i]',
        'button[type="submit"]'
      ],
      userMessage: [
        'div[data-role="user"]',
        '.ds-message--user',
        '.message-user'
      ],
      aiMessage: [
        'div[data-role="assistant"]',
        '.ds-message--assistant',
        '.markdown-body'
      ]
    }
  },
  {
    id: 'qwen',
    name: 'Qwen',
    region: 'china',
    patterns: ['tongyi.aliyun.com', 'chat.qwen.ai'],
    selectors: {
      textarea: [
        'textarea.chat-input',
        'textarea[placeholder*="input" i]',
        'textarea'
      ],
      sendButton: [
        'button.send-btn',
        'button[type="submit"]',
        'div[role="button"][aria-label*="send" i]'
      ],
      userMessage: [
        '.message-user',
        '[data-role="user"]'
      ],
      aiMessage: [
        '.message-assistant',
        '.markdown-body',
        '[data-role="assistant"]'
      ]
    }
  },
  {
    id: 'kimi',
    name: 'Kimi',
    region: 'china',
    patterns: ['kimi.moonshot.cn', 'kimi.com'],
    selectors: {
      textarea: [
        'textarea#chat-input',
        '.chat-input textarea',
        'textarea'
      ],
      sendButton: [
        'button[type="submit"]',
        'button[aria-label*="send" i]'
      ],
      userMessage: [
        '.role-user',
        '[data-role="user"]'
      ],
      aiMessage: [
        '.role-assistant',
        '.markdown-body',
        '[data-role="assistant"]'
      ]
    }
  },

  // ===== Tier 2 (akan diaktifkan setelah testing) =====
  // Perplexity, Grok, Copilot, Mistral, Doubao, ChatGLM, Yiyan, Yuanbao
  // Lihat dokumentasi untuk konfigurasi resolver
];

export function getDomainConfig(url = location.href) {
  const host = (() => {
    try { return new URL(url).hostname; } catch (e) { return url; }
  })();
  for (const d of AI_DOMAINS) {
    for (const p of d.patterns) {
      if (host === p || host.endsWith('.' + p)) return d;
    }
  }
  return null;
}

export function isSupportedDomain(url = location.href) {
  return getDomainConfig(url) !== null;
}
