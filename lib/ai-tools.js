// lib/ai-tools.js — Katalog AI tool untuk Quick Switch launcher
// RecallFox v0.1.0
//
// Setiap entry:
//   id, name, region ('local'|'west'|'china'), url, color, emoji, alt (alias domain)

export const AI_TOOLS = [
  // ===== Lokal (untuk AI lokal Indonesia — saat ini kosong, siap untuk masa depan) =====

  // ===== Barat =====
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    region: 'west',
    url: 'https://chatgpt.com/',
    color: '#10a37f',
    emoji: '💬',
    alt: ['chatgpt.com']
  },
  {
    id: 'claude',
    name: 'Claude',
    region: 'west',
    url: 'https://claude.ai/',
    color: '#d97757',
    emoji: '🎭',
    alt: ['claude.ai']
  },
  {
    id: 'gemini',
    name: 'Gemini',
    region: 'west',
    url: 'https://gemini.google.com/',
    color: '#4285f4',
    emoji: '✨',
    alt: ['gemini.google.com']
  },
  {
    id: 'copilot',
    name: 'Copilot',
    region: 'west',
    url: 'https://copilot.microsoft.com/',
    color: '#0078d4',
    emoji: '🚁',
    alt: ['copilot.microsoft.com']
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    region: 'west',
    url: 'https://www.perplexity.ai/',
    color: '#21808d',
    emoji: '🔍',
    alt: ['perplexity.ai']
  },
  {
    id: 'grok',
    name: 'Grok',
    region: 'west',
    url: 'https://grok.com/',
    color: '#1d9bf0',
    emoji: '⚡',
    alt: ['grok.com']
  },
  {
    id: 'mistral',
    name: 'Mistral',
    region: 'west',
    url: 'https://chat.mistral.ai/',
    color: '#ff7000',
    emoji: '🌬️',
    alt: ['chat.mistral.ai']
  },
  {
    id: 'huggingchat',
    name: 'HuggingChat',
    region: 'west',
    url: 'https://huggingface.co/chat/',
    color: '#ffcc4d',
    emoji: '🤗',
    alt: ['huggingface.co']
  },
  {
    id: 'pi',
    name: 'Pi',
    region: 'west',
    url: 'https://pi.ai/',
    color: '#000000',
    emoji: '🥧',
    alt: ['pi.ai']
  },
  {
    id: 'you',
    name: 'You.com',
    region: 'west',
    url: 'https://you.com/',
    color: '#7c3aed',
    emoji: '🌐',
    alt: ['you.com']
  },

  // ===== China =====
  {
    id: 'zai',
    name: 'z.ai (Zhipu)',
    region: 'china',
    url: 'https://chat.z.ai/',
    color: '#1a73e8',
    emoji: '🧠',
    alt: ['chat.z.ai']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    region: 'china',
    url: 'https://chat.deepseek.com/',
    color: '#4d6bfe',
    emoji: '🐋',
    alt: ['chat.deepseek.com']
  },
  {
    id: 'qwen',
    name: 'Qwen 通义',
    region: 'china',
    url: 'https://chat.qwen.ai/',
    color: '#615ced',
    emoji: '🐉',
    alt: ['chat.qwen.ai', 'tongyi.aliyun.com']
  },
  {
    id: 'kimi',
    name: 'Kimi',
    region: 'china',
    url: 'https://kimi.com/',
    color: '#1a1a1a',
    emoji: '🌙',
    alt: ['kimi.com', 'kimi.moonshot.cn']
  },
  {
    id: 'doubao',
    name: '豆包 Doubao',
    region: 'china',
    url: 'https://www.doubao.com/',
    color: '#3b82f6',
    emoji: '🫘',
    alt: ['doubao.com']
  },
  {
    id: 'chatglm',
    name: '智谱清言 ChatGLM',
    region: 'china',
    url: 'https://chatglm.cn/',
    color: '#0ea5e9',
    emoji: '💭',
    alt: ['chatglm.cn']
  },
  {
    id: 'yiyan',
    name: '文心一言',
    region: 'china',
    url: 'https://yiyan.baidu.com/',
    color: '#2932e1',
    emoji: '📝',
    alt: ['yiyan.baidu.com']
  },
  {
    id: 'yuanbao',
    name: '腾讯元宝',
    region: 'china',
    url: 'https://yuanbao.tencent.com/',
    color: '#0053e0',
    emoji: '💰',
    alt: ['yuanbao.tencent.com']
  },
  {
    id: 'baichuan',
    name: '百川 Baichuan',
    region: 'china',
    url: 'https://www.baichuan-ai.com/',
    color: '#ff6b35',
    emoji: '🏞️',
    alt: ['baichuan-ai.com']
  },
  {
    id: 'minimax',
    name: 'MiniMax 海螺',
    region: 'china',
    url: 'https://chat.minimaxi.com/',
    color: '#ff5c5c',
    emoji: '🌀',
    alt: ['chat.minimaxi.com', 'hailuoai.com']
  },
  {
    id: 'sensetime',
    name: '商汤 SenseChat',
    region: 'china',
    url: 'https://chat.sensetime.com/',
    color: '#00b4a6',
    emoji: '👁️',
    alt: ['chat.sensetime.com']
  }
];

export const REGION_LABELS = {
  local: 'LOKAL',
  west: 'BARAT',
  china: 'CHINA'
};

export const REGION_COLORS = {
  local: { bg: '#fef3c7', fg: '#92400e', dot: '#f59e0b' },
  west: { bg: '#dbeafe', fg: '#1e40af', dot: '#3b82f6' },
  china: { bg: '#fee2e2', fg: '#991b1b', dot: '#ef4444' }
};

// Group by region for rendering
export function groupByRegion(tools = AI_TOOLS) {
  const groups = { local: [], west: [], china: [] };
  for (const t of tools) {
    if (!groups[t.region]) groups[t.region] = [];
    groups[t.region].push(t);
  }
  return groups;
}

// Check if current URL matches any AI tool
export function matchCurrentTool(url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname; } catch (e) { return null; }
  for (const t of AI_TOOLS) {
    for (const alt of (t.alt || [])) {
      if (host === alt || host.endsWith('.' + alt)) return t;
    }
  }
  return null;
}

// Generate a stable color from a hostname (for link icons)
const DOMAIN_PALETTE = [
  '#4f46e5', '#0891b2', '#059669', '#d97757', '#dc2626',
  '#7c3aed', '#db2777', '#ea580c', '#0ea5e9', '#65a30d',
  '#9333ea', '#0d9488', '#ca8a04', '#e11d48', '#2563eb'
];

export function getDomainColor(host) {
  if (!host) return DOMAIN_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < host.length; i++) {
    hash = (hash * 31 + host.charCodeAt(i)) | 0;
  }
  return DOMAIN_PALETTE[Math.abs(hash) % DOMAIN_PALETTE.length];
}

// Get first letter (uppercase) of host for icon — e.g. "github.com" → "G"
export function getDomainLetter(host) {
  if (!host) return '?';
  // try to get the main label (before first dot, or subdomain part)
  const parts = host.split('.');
  // for "www.example.com" → "E"; for "github.com" → "G"; for "chat.z.ai" → "Z"
  let main = parts[0];
  if (parts.length >= 2 && (main === 'www' || main === 'chat' || main === 'app' || main === 'mail')) {
    main = parts[1];
  }
  return main.charAt(0).toUpperCase();
}

// Try to match an AI tool by URL, return its emoji for use as icon
export function getEmojiForUrl(url) {
  const tool = matchCurrentTool(url);
  return tool?.emoji || null;
}
