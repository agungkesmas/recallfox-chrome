// lib/search.js — Fuzzy search sederhana untuk vault
// RecallFox v0.1.0

// Normalize: lowercase + trim
function norm(s) {
  return (s || '').toString().toLowerCase().trim();
}

// Score: 0 = no match, higher = better match
// Substring match > word-start match > fuzzy char match
function scoreMatch(query, target) {
  if (!query) return 1;
  const q = norm(query);
  const t = norm(target);
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const idx = t.indexOf(q);
  if (idx >= 0) return 60 - idx; // earlier = better
  // word-start match
  const words = t.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(q)) return 50 - i;
  }
  // fuzzy char-by-char (in order)
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi === q.length) return 20;
  return 0;
}

export function searchItems(items, query) {
  if (!query || !query.trim()) {
    // default sort: favorite first, then by lastUsedAt desc, then updatedAt desc
    return [...items].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const aTime = a.lastUsedAt || a.updatedAt || a.createdAt;
      const bTime = b.lastUsedAt || b.updatedAt || b.createdAt;
      return new Date(bTime) - new Date(aTime);
    });
  }

  const scored = items.map(item => {
    let score = 0;
    score = Math.max(score, scoreMatch(query, item.title) * 3);
    score = Math.max(score, scoreMatch(query, item.body) * 1);
    score = Math.max(score, scoreMatch(query, (item.tags || []).join(' ')) * 2);
    score = Math.max(score, scoreMatch(query, item.category || '') * 1.5);
    // favorites get bonus
    if (item.favorite) score *= 1.1;
    return { item, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);
}

export function filterByType(items, type) {
  if (!type || type === 'all') return items;
  if (type === 'bundle') return []; // bundles handled separately
  return items.filter(i => i.type === type);
}

export function getAllTags(items) {
  const counts = {};
  for (const it of items) {
    for (const t of (it.tags || [])) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// Detect {{variable}} placeholders in body
export function extractVariables(body) {
  const matches = (body || '').matchAll(/\{\{(\w+)\}\}/g);
  const set = new Set();
  for (const m of matches) set.add(m[1]);
  return [...set];
}

// Replace {{var}} with values; if value missing, keep placeholder
export function fillVariables(body, values = {}) {
  return (body || '').replace(/\{\{(\w+)\}\}/g, (m, name) => {
    return values[name] != null && values[name] !== '' ? values[name] : m;
  });
}
