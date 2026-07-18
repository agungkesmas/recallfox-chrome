// lib/toppings.js — Prompt Orchestrator Toppings
// RecallFox v0.1.0
//
// Toppings = behavior modifiers yang nempel di prompt saat diinject ke AI.
// Bisa multiple, stacking. Bisa built-in atau custom (disimpan user).
// Default-on: toppings yang disimpan di item langsung aktif saat inject.

import { getVault } from './storage.js';

// ===== 12 Built-in Toppings =====
export const BUILTIN_TOPPINGS = [
  {
    id: 'research',
    name: 'Research Mode',
    emoji: '🔍',
    description: 'Search informasi terbaru sebelum jawab, sertakan citation URL',
    body: 'Sebelum menjawab, cari informasi terbaru dan terverifikasi tentang topik ini. Sertakan URL referensi untuk setiap klaim penting. Prioritaskan sumber primer dan dokumentasi resmi.'
  },
  {
    id: 'step_by_step',
    name: 'Step-by-step',
    emoji: '📋',
    description: 'Format jawaban dalam langkah-langkah numbered yang jelas',
    body: 'Format jawaban sebagai langkah-langkah numbered yang jelas dan berurutan. Setiap langkah harus actionable dan dapat diikuti. Gunakan format: "1. [Langkah] - [penjelasan singkat]".'
  },
  {
    id: 'deep_think',
    name: 'Deep Think',
    emoji: '🧠',
    description: 'Reasoning mendalam, tampilkan thought process',
    body: 'Pikirkan secara mendalam sebelum menjawab. Tampilkan thought process dan reasoning Anda dengan jelas. Pertimbangkan multiple angles, trade-offs, dan edge cases. Jangan terburu-buru ke kesimpulan.'
  },
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    emoji: '💡',
    description: 'Generate 3-5 alternatif solusi kreatif',
    body: 'Generate 3-5 alternatif solusi yang berbeda untuk permintaan ini. Beri nama tiap alternatif, jelaskan kelebihan/kekurangan singkat. Buat alternatifnya benar-benar berbeda pendekatan, bukan variasi minor.'
  },
  {
    id: 'critic',
    name: 'Critic Mode',
    emoji: '⚖️',
    description: 'Find weaknesses, counterarguments, edge cases',
    body: 'Setelah memberikan jawaban utama, aktif sebagai critic. Identifikasi kelemahan, counterarguments, edge cases, dan potensi masalah dari solusi yang Anda berikan. Beri peringatan jika ada risiko.'
  },
  {
    id: 'simplifier',
    name: 'Simplifier',
    emoji: '📝',
    description: 'Jelaskan simpel untuk non-expert, hindari jargon',
    body: 'Jelaskan dengan bahasa sederhana untuk orang non-expert. Hindari jargon teknis atau jelaskan jika terpaksa pakai. Gunakan analogi sehari-hari. Asumsikan pembaca baru pertama kali dengar topik ini.'
  },
  {
    id: 'translator',
    name: 'Translator',
    emoji: '🌐',
    description: 'Translate output ke bahasa tertentu (prompt minta)',
    body: 'Jika permintaan menyebutkan bahasa target, translate output ke bahasa tersebut. Jika tidak, pertahankan bahasa asli permintaan. Jaga nuansa dan istilah teknis tetap akurat.'
  },
  {
    id: 'code_reviewer',
    name: 'Code Reviewer',
    emoji: '🎨',
    description: 'Review kode pakai best practices (a11y, perf, SEO)',
    body: 'Untuk kode yang dihasilkan, review sendiri dengan checklist: accessibility (a11y), performance, SEO, responsiveness, security, dan maintainability. Tunjukkan issue dengan severity (critical/warning/info) dan beri saran perbaikan.'
  },
  {
    id: 'checklist',
    name: 'Checklist Maker',
    emoji: '✅',
    description: 'Output sebagai checklist yang bisa di-tick',
    body: 'Format output sebagai checklist markdown ("- [ ] item"). Kelompokkan ke kategori jika perlu. Setiap item harus spesifik dan actionable. Tambahkan estimasi effort (S/M/L) di akhir tiap item.'
  },
  {
    id: 'iterative',
    name: 'Iterative Improver',
    emoji: '🔄',
    description: 'Generate + suggest 3 improvements iteratively',
    body: 'Setelah memberikan jawaban awal, suggest 3 specific improvements yang bisa dilakukan. Untuk tiap improvement, jelaskan: (1) apa yang diubah, (2) kenapa, (3) dampak yang diharapkan. Beri versi final improved jika feasible.'
  },
  {
    id: 'persona_expert',
    name: 'Expert Persona',
    emoji: '🎯',
    description: 'Berperan sebagai expert di bidang tertentu (prompt minta)',
    body: 'Berperan sebagai expert di bidang yang disebutkan di permintaan (atau inferensi yang paling relevan). Pikirkan seperti expert tersebut: pakai mental model mereka, refer best practices industri, dan kasih insight yang hanya expert tau. Sebutkan expertise Anda di awal jawaban.'
  },
  {
    id: 'output_format',
    name: 'Output Format',
    emoji: '📊',
    description: 'Format output sebagai JSON/table/markdown (prompt minta)',
    body: 'Format output sesuai format yang diminta di permintaan (JSON / table / markdown / dll). Jika tidak disebut, gunakan format yang paling sesuai dengan konteks. Pastikan format konsisten dan valid. Untuk JSON, sertakan schema di komentar jika perlu.'
  }
];

// Cache for resolved toppings (built-in + custom from vault)
let _toppingsCache = null;

export async function getAllToppings() {
  const vault = await getVault();
  const custom = vault.toppings || [];
  return [...BUILTIN_TOPPINGS, ...custom];
}

export function getBuiltinTopping(id) {
  return BUILTIN_TOPPINGS.find(t => t.id === id) || null;
}

export async function getToppingById(id) {
  // Try built-in first
  const builtin = getBuiltinTopping(id);
  if (builtin) return builtin;
  // Try custom from vault
  const vault = await getVault();
  const custom = (vault.toppings || []).find(t => t.id === id);
  return custom || null;
}

// ===== Build final prompt with toppings applied =====
// Returns the original body if no toppings selected
export async function buildFinalPrompt(promptBody, toppingIds = []) {
  if (!toppingIds || toppingIds.length === 0) return promptBody;

  // Resolve all toppings (parallel)
  const toppings = await Promise.all(toppingIds.map(id => getToppingById(id)));
  const validToppings = toppings.filter(Boolean);

  if (validToppings.length === 0) return promptBody;

  const toppingBlock = validToppings.map(t => {
    return `[${t.emoji} ${t.name}]\n${t.body}`;
  }).join('\n\n');

  return `${promptBody}\n\n---\n⚙️ Orchestrator Toppings:\n\n${toppingBlock}`;
}

// ===== Helper for UI: get toppings as list with selection state =====
export async function getToppingsForUI(selectedIds = []) {
  const all = await getAllToppings();
  return all.map(t => ({
    ...t,
    selected: selectedIds.includes(t.id)
  }));
}

// ===== Custom topping CRUD (delegates to storage) =====
// Storage functions: addCustomTopping, updateCustomTopping, deleteCustomTopping
// Defined in storage.js, imported here just for re-export convenience
export { addCustomTopping, updateCustomTopping, deleteCustomTopping } from './storage.js';
