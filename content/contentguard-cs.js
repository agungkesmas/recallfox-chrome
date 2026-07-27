// content/contentguard-cs.js — Filter feed YouTube & X dari konten negatif Indonesia
// RecallFox v0.8.21 → 0.8.22 (robust X selectors + interval fallback + debug overlay)
//
// Cara kerja:
//   1. Inject di youtube.com & x.com/twitter.com (document_idle)
//   2. Pasang MutationObserver + setInterval (fallback) untuk scan feed
//   3. Sembunyikan (display:none) elemen yang:
//      a. Mengandung kata negatif (DEFAULT_NEGATIVE_KEYWORDS + user keywords)
//      b. Channel/akun ada di daftar blokir (DEFAULT_BLOCKED_YT_CHANNELS / X_ACCOUNTS)
//      c. Cocok dengan user blocklist (klik kanan "Blokir Konten Ini")
//   4. Tampilkan counter "X konten negatif disembunyikan" di pojok
//   5. Mode debug (alt+click badge) — tampilkan overlay dengan detail apa yang di-scan

(function () {
  'use strict';

  // v0.8.32: Guard global pakai dataset di documentElement
  // (window.__x tidak reliable karena setiap inject context berbeda)
  if (document.documentElement.dataset.rfCgInjected === '1') {
    console.log('[RecallFox/CG] Already injected, skip');
    return;
  }
  document.documentElement.dataset.rfCgInjected = '1';

  // v0.8.32: Hapus panel duplikat yang mungkin ada dari inject sebelumnya
  document.querySelectorAll('#rf-cg-control, #rf-cg-status, #rf-cg-debug').forEach(el => el.remove());

  let settings = null;
  let hiddenCount = 0;
  let hoveredElement = null;
  let scanTimer = null;
  let intervalTimer = null;

  // ===== Load settings dari background =====
  // v0.8.31: Fallback ke browser.storage.local kalau message ke background gagal
  // (terjadi kalau background script belum siap atau tab sudah terbuka sebelum addon update)
  async function loadSettings() {
    // Strategi 1: kirim message ke background
    try {
      const resp = await browser.runtime.sendMessage({ type: 'CG_GET_SETTINGS' });
      if (resp && resp.settings) {
        settings = resp.settings;
        return true;
      }
    } catch (e) {
      console.warn('[RecallFox/CG] sendMessage ke background gagal, coba storage.local langsung:', e.message);
    }
    // Strategi 2: fallback ke storage.local langsung
    try {
      const data = await browser.storage.local.get('recallfox_vault');
      const vault = data.recallfox_vault;
      if (vault && vault.settings) {
        settings = vault.settings;
        console.log('[RecallFox/CG] Settings loaded via storage.local fallback');
        return true;
      }
    } catch (e2) {
      console.warn('[RecallFox/CG] storage.local fallback juga gagal:', e2.message);
    }
    // Strategi 3: default empty settings (supaya panel tetap tampil)
    settings = {
      contentGuardEnabled: true,
      contentGuardFilterFeeds: true,
      contentGuardNuclearMode: true,
      contentGuardForceRedirect: true,
      contentGuardBlockSearchQueries: true,
      contentGuardNegativeKeywords: [],
      contentGuardBlockedYtChannels: [],
      contentGuardBlockedXAccounts: [],
      contentGuardUserBlocklist: [],
      contentGuardShowFloating: false  // v3.4: default OFF — pindah ke sidebar
    };
    console.warn('[RecallFox/CG] Pakai default empty settings');
    return false;
  }

  function shouldRun() {
    if (!settings) return false;
    if (settings.contentGuardEnabled === false) return false;
    if (settings.contentGuardFilterFeeds === false) return false;
    return true;
  }

  function getKeywords() {
    return (settings?.contentGuardNegativeKeywords) || [];
  }
  function getBlockedYtChannels() {
    return (settings?.contentGuardBlockedYtChannels) || [];
  }
  function getBlockedXAccounts() {
    return (settings?.contentGuardBlockedXAccounts) || [];
  }
  function getUserBlocklist() {
    return Array.isArray(settings?.contentGuardUserBlocklist) ? settings.contentGuardUserBlocklist : [];
  }

  // ===== v0.8.24: Normalisasi teks (anti bypass) =====
  // Mis. "F3bri3 Adr14nsy4h" → "febrie adriansyah"
  function normalizeText(text) {
    if (!text) return '';
    let s = String(text).toLowerCase();
    s = s.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
         .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
         .replace(/8/g, 'b').replace(/9/g, 'g');
    s = s.replace(/[._\-*+#~|]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function containsNegative(text) {
    if (!text) return null;
    // Cek versi asli + versi normalized
    const lower = text.toLowerCase();
    const normalized = normalizeText(text);
    for (const kw of getKeywords()) {
      const k = String(kw).toLowerCase().trim();
      if (!k) continue;
      if (lower.includes(k)) return kw;
      // Juga cek versi normalized (anti leet speak)
      if (normalized.includes(normalizeText(k))) return kw;
    }
    return null;
  }

  function isChannelBlocked(channelName) {
    if (!channelName) return null;
    const lower = channelName.toLowerCase().trim();
    if (!lower) return null;
    // Cek di YT channels DAN X accounts (X handle dimulai @)
    const ytList = (settings?.contentGuardBlockYtChannels !== false) ? getBlockedYtChannels() : [];
    const xList = (settings?.contentGuardBlockXAccounts !== false) ? getBlockedXAccounts() : [];
    const list = [...ytList, ...xList];
    for (const ch of list) {
      const c = String(ch).toLowerCase().trim();
      if (!c) continue;
      const cmpLower = lower.replace(/^@/, '');
      const cmpC = c.replace(/^@/, '');
      if (cmpLower === cmpC || cmpLower.includes(cmpC) || cmpC.includes(cmpLower)) {
        return ch;
      }
    }
    return null;
  }

  function matchesUserBlocklistLocal(text, channel) {
    const list = getUserBlocklist();
    if (!list || list.length === 0) return null;
    const lowerText = (text || '').toLowerCase();
    const lowerChan = (channel || '').toLowerCase();
    for (const entry of list) {
      if (!entry || !entry.value) continue;
      const v = String(entry.value).toLowerCase().trim();
      if (!v) continue;
      if (entry.type === 'channel' || entry.type === 'account') {
        if (lowerChan && (lowerChan.includes(v) || v.includes(lowerChan))) {
          return { entry, matched: entry.type };
        }
      } else if (entry.type === 'exact_title') {
        if (lowerText === v) return { entry, matched: 'exact_title' };
      } else if (entry.type === 'title') {
        if (lowerText.includes(v)) return { entry, matched: 'title' };
      } else if (entry.type === 'x_post_url') {
        // v3.4: Match kalau teks tweet mengandung URL post ini
        if (lowerText && lowerText.includes(v)) {
          return { entry, matched: 'x_post_url' };
        }
        if (entry.altValue) {
          const altV = String(entry.altValue).toLowerCase().trim();
          if (altV && lowerText.includes(altV)) {
            return { entry, matched: 'x_post_url' };
          }
        }
      } else {
        if (lowerText.includes(v) || (lowerChan && lowerChan.includes(v))) {
          return { entry, matched: 'keyword' };
        }
      }
    }
    return null;
  }

  // v3.4: Helper khusus untuk cek URL post X terhadap blocklist
  // Dipakai di hideXNegative — cek apakah URL tweet ada di daftar blokir
  function matchesBlockedXPostUrlLocal(postUrl) {
    const list = getUserBlocklist();
    if (!list || list.length === 0 || !postUrl) return null;
    const lowerUrl = String(postUrl).toLowerCase();
    let urlPath = '';
    try {
      urlPath = new URL(postUrl).pathname.toLowerCase();
    } catch (e) {}
    for (const entry of list) {
      if (!entry || entry.type !== 'x_post_url' || !entry.value) continue;
      const v = String(entry.value).toLowerCase().trim();
      if (v && lowerUrl.includes(v)) return { entry, matched: 'x_post_url' };
      // Match berdasarkan path (toleran twitter.com vs x.com)
      if (entry.altValue) {
        const altV = String(entry.altValue).toLowerCase().trim();
        if (altV && urlPath && urlPath === altV) return { entry, matched: 'x_post_url' };
      }
    }
    return null;
  }

  // ===== YouTube selectors (multiple fallback — SUPER COMPREHENSIVE) =====
  // v0.8.25: tambah banyak selector untuk catch semua layout YouTube.
  const YT_VIDEO_SELECTORS = [
    // Feed home (rich items)
    'ytd-rich-item-renderer',
    'ytd-rich-shelf-renderer ytd-rich-item-renderer',
    // Search results
    'ytd-video-renderer',
    'ytd-item-section-renderer ytd-video-renderer',
    // Sidebar related (compact)
    'ytd-compact-video-renderer',
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
    // Channel pages (grid)
    'ytd-grid-video-renderer',
    'ytd-grid-renderer ytd-grid-video-renderer',
    // Shorts
    'ytd-reel-item-renderer',
    'ytd-rich-shelf-renderer ytd-reel-item-renderer',
    // Shelf (kategori)
    'ytd-rich-shelf-renderer',
    // Playlist items
    'ytd-playlist-panel-video-renderer',
    // Cards/end-screens
    'ytd-grid-movie-renderer',
    'ytd-movie-renderer',
    // New: feed section
    'ytd-rich-section-renderer ytd-rich-item-renderer',
    // Fallback generic
    '[data-testid="video-card"]',
    // New YouTube layout (2026)
    'ytd-video-preview-renderer',
    // Compact station (music)
    'ytd-compact-station-renderer',
    // Channel featured video
    'ytd-channel-video-player-renderer',
    // Premium/movie
    'ytd-offer-module-renderer',
    // Live streaming
    'ytd-live-chat-frame',
    // Search filter chips (sometimes appears)
    'ytd-search-filter-renderer'
  ];

  function getYouTubeTitle(el) {
    const candidates = [
      '#video-title',
      'a#video-title-link',
      '#metadata-line',
      'yt-formatted-string#video-title',
      'h3.ytd-rich-item-renderer',
      'span#title',
      '[title]',
      '[aria-label]'
    ];
    for (const sel of candidates) {
      const node = el.querySelector(sel);
      if (node) {
        const t = (node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '').trim();
        if (t && t.length > 3) return t;
      }
    }
    return (el.textContent || '').trim().slice(0, 500);
  }

  // v0.8.24: Ambil description/preview text dari video card
  function getYouTubeDescription(el) {
    const candidates = [
      '#description-text',
      '#metadata-line',
      'yt-formatted-string#description-text',
      '.metadata-snippet-text',
      '#metadata snipped-text',
      'yt-attribution-renderer',
      // Untuk compact video di sidebar
      '#metadata-line span'
    ];
    let text = '';
    for (const sel of candidates) {
      try {
        const nodes = el.querySelectorAll(sel);
        for (const n of nodes) {
          const t = (n.textContent || '').trim();
          if (t && t.length > 5 && !text.includes(t)) {
            text += ' ' + t;
          }
        }
      } catch (e) {}
    }
    return text.trim();
  }

  function getYouTubeChannel(el) {
    const candidates = [
      'yt-formatted-string#text a',
      '#channel-name a',
      '#channel-name',
      'a.yt-simple-endpoint[href*="/@"]',
      'a.yt-simple-endpoint[href*="/channel/"]',
      'a.yt-simple-endpoint[href*="/c/"]',
      'a.yt-simple-endpoint[href*="/user/"]',
      'ytd-channel-name a',
      'ytd-channel-name yt-formatted-string',
      '#text.ytd-channel-name',
      '.ytd-channel-name a'
    ];
    for (const sel of candidates) {
      const nodes = el.querySelectorAll(sel);
      for (const node of nodes) {
        const t = (node.textContent || '').trim();
        if (t && t.length > 0 && t.length < 100) return t;
        if (node.href) {
          const m = node.href.match(/\/(@[\w.\-]+|channel\/[\w\-]+|c\/[\w\-]+|user\/[\w\-]+)/);
          if (m) return m[1];
        }
      }
    }
    return '';
  }

  function hideYouTubeNegative() {
    // v3.7.2 (Issue 6): Jika contentGuardBlockShorts aktif, sembunyikan SEMUA Shorts
    // tanpa peduli keyword. Dipanggil pertama agar feed bersih sebelum scan keyword.
    if (settings?.contentGuardBlockShorts === true) {
      hideAllShorts();
    }

    // v3.10.0 (Issue 2): Mode Anak — filter konten di youtube.com (no redirect).
    // Hanya tampilkan video dari channel whitelist ramah anak + yang judulnya mengandung
    // kata kunci anak/kids/edukasi. Semua video lain di-hide.
    if (settings?.contentGuardKidModeFilter === true) {
      hideNonKidContent();
    }

    let changed = false;
    const scanDescription = settings?.contentGuardScanDescription !== false;

    for (const sel of YT_VIDEO_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(node => {
        if (node.dataset.rfCgHidden === '1') return;
        if (node.querySelector('ytd-ad-slot-renderer, [class*="ad-"], ytd-ad-slot-renderer')) return;

        const title = getYouTubeTitle(node);
        const channel = getYouTubeChannel(node);
        const description = scanDescription ? getYouTubeDescription(node) : '';
        const combinedText = (title + ' ' + channel + ' ' + description).trim();

        // v0.8.40: Hanya Nuclear Mode — cek keyword negatif + channel blocklist + user blocklist
        const negKw = containsNegative(title) || containsNegative(channel) ||
                      (scanDescription ? containsNegative(description) : null);
        const blockedCh = settings.contentGuardBlockYtChannels !== false ? isChannelBlocked(channel) : null;
        const userBlk = matchesUserBlocklistLocal(combinedText, channel);

        if (negKw || blockedCh || userBlk) {
          node.style.setProperty('display', 'none', 'important');
          node.dataset.rfCgHidden = '1';
          node.dataset.rfCgReason = negKw || blockedCh || (userBlk?.entry?.value) || 'unknown';
          node.dataset.rfCgTitle = (title || '').slice(0, 100);
          node.dataset.rfCgChannel = (channel || '').slice(0, 60);
          hiddenCount++;
          changed = true;
          if (settings.contentGuardDebugMode) {
            console.log('[RecallFox/CG] YT hidden:', { title: title.slice(0, 80), channel, reason: node.dataset.rfCgReason });
          }
        }
      });
    }
    if (changed) {
      hideEmptyShelves();
    }
    panelStats.blocked = hiddenCount;
    panelStats.allowed = countAllowedCards();
    panelStats.lastScanAt = Date.now();
    ensureControlPanel();
    updateControlPanelStatus();
    updatePanelCounters();
  }

  // v0.8.27: Hitung jumlah card yang TIDAK di-hidden (allowed)
  function countAllowedCards() {
    let count = 0;
    for (const sel of YT_VIDEO_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(n => {
        if (n.dataset.rfCgHidden !== '1' && n.dataset.rfCgWhitelisted !== '1') count++;
      });
    }
    return count;
  }

  // v0.8.25: Hide parent shelves yang sudah kosong (semua children di-hidden)
  // Untuk bersihkan tampilan feed YouTube yang penuh shelf kosong
  function hideEmptyShelves() {
    const shelfSelectors = [
      'ytd-rich-shelf-renderer',
      'ytd-shelf-renderer',
      'ytd-item-section-renderer',
      'ytd-rich-section-renderer'
    ];
    for (const sel of shelfSelectors) {
      let shelves;
      try { shelves = document.querySelectorAll(sel); }
      catch (e) { continue; }
      shelves.forEach(shelf => {
        if (shelf.dataset.rfCgShelfHidden === '1') return;
        // Cari semua video card di dalam shelf
        const cards = shelf.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');
        if (cards.length === 0) return;
        // Cek apakah SEMUA cards di-hidden
        let hiddenCount = 0;
        cards.forEach(c => { if (c.dataset.rfCgHidden === '1') hiddenCount++; });
        if (hiddenCount === cards.length) {
          shelf.style.setProperty('display', 'none', 'important');
          shelf.dataset.rfCgShelfHidden = '1';
        }
      });
    }
  }

  // v3.7.2 (Issue 6): Sembunyikan SEMUA elemen YouTube Shorts di feed.
  // Selector komprehensif: reel items, shelf shorts, button "Shorts" di sidebar,
  // tab Shorts di channel page, dan section Shorts di home feed.
  function hideAllShorts() {
    const shortsSelectors = [
      // Feed: individual short cards
      'ytd-reel-item-renderer',
      'ytd-rich-shelf-renderer ytd-reel-item-renderer',
      'ytd-rich-section-renderer ytd-reel-item-renderer',
      // Whole shelf that only contains shorts (judul "Shorts", "Shorts breaking", dsb.)
      'ytd-rich-shelf-renderer[is-shorts]',
      'ytd-rich-section-renderer[is-shorts]',
      // Sidebar "Shorts" button (menu kiri)
      'ytd-mini-guide-entry-renderer[aria-label*="Shorts"]',
      'ytd-guide-entry-renderer[aria-label*="Shorts"]',
      'a[title="Shorts"]',
      // Channel page: tab "Shorts"
      'yt-tab-shape[tab-title="Shorts"]',
      'tp-yt-paper-tab[aria-label*="Shorts"]',
      // New 2026: shorts on home page header
      'ytd-rich-section-renderer:has(ytd-reel-item-renderer)',
      // Mobile m.youtube.com
      '.reel-video-renderer'
    ];
    let hiddenNow = 0;
    for (const sel of shortsSelectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(node => {
        if (node.dataset.rfCgShortsHidden === '1') return;
        node.style.setProperty('display', 'none', 'important');
        node.dataset.rfCgShortsHidden = '1';
        hiddenNow++;
      });
    }
    if (hiddenNow > 0 && settings?.contentGuardDebugMode) {
      console.log('[RecallFox/CG] hideAllShorts: hidden', hiddenNow, 'shorts elements');
    }
  }

  // ===== X (Twitter) selectors — SUPER COMPREHENSIVE =====
  // v0.8.25: tambah lebih banyak selector + fallback ke text element langsung.
  const X_TWEET_SELECTORS = [
    // Standard tweet article
    'article[data-testid="tweet"]',
    'div[data-testid="cellInnerDiv"] article',
    'article[role="article"]',
    'article',
    // Timeline containers
    '[data-testid="primaryColumn"] article',
    '[aria-label*="Timeline"] article',
    '[aria-label*="Feed"] article',
    'div[role="presentation"] article',
    'section[aria-label*="Timeline"] article',
    'div[aria-label*="Timeline"] article',
    // TweetText fallback (scan semua text element)
    'div[data-testid="tweetText"]',
    'div[data-testid="tweetText"] *',
    // Reply threads
    'div[data-testid="tweet"] article',
    // Conversations
    'div[data-testid="conversation"] article',
    // Pinned tweets
    'div[data-testid="pin"] article',
    // New 2026 layout
    'div[data-testid="tombstone"] article',
    'div[data-testid="placementTracking"] article',
    // Generic fallback: any article with tweetText inside
    'article:has([data-testid="tweetText"])'
  ];

  function getXTweetText(el) {
    // Cari semua elemen yang berisi teks tweet
    // X punya tweetText, juga [lang] untuk tweet multibahasa, juga div dengan teks
    const selectors = [
      '[data-testid="tweetText"]',
      '[data-testid="tweetText"] *',
      '[lang]',
      'div[dir="auto"]',
      'span[dir="auto"]',
      'div.css-146c3p1.r-8akbws.r-krxsd3'  // class lama, mungkin masih dipakai
    ];
    let txt = '';
    const seen = new Set();
    for (const sel of selectors) {
      try {
        const nodes = el.querySelectorAll(sel);
        for (const n of nodes) {
          const t = (n.textContent || '').trim();
          if (t && !seen.has(t) && t.length > 2) {
            seen.add(t);
            txt += ' ' + t;
          }
        }
      } catch (e) {}
    }
    // Jika masih kosong, ambil semua teks
    if (!txt.trim()) {
      txt = (el.textContent || '').trim();
    }
    return txt.trim();
  }

  function getXTweetAuthor(el) {
    // Strategi 1: cari link dengan href /username di dalam User-Name
    const userLinks = el.querySelectorAll('[data-testid="User-Name"] a[href], a[href*="/"]');
    for (const link of userLinks) {
      if (!link.href) continue;
      // Skip link ke /home, /explore, /i, /settings, dll.
      const m = link.href.match(/https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:$|\/|\?)/);
      if (m && !['home', 'explore', 'i', 'settings', 'notifications', 'messages',
                 'bookmarks', 'compose', 'search', 'login', 'signup'].includes(m[1].toLowerCase())) {
        return '@' + m[1];
      }
    }
    // Strategi 2: cari text @handle di seluruh article
    const allText = el.textContent || '';
    const m = allText.match(/@([A-Za-z0-9_]{1,15})/);
    return m ? m[0] : '';
  }

  // v3.10.0 (Issue 2): Mode Anak — hide SEMUA video kecuali yang ramah anak.
  // Definisi "ramah anak":
  //   - Channel ada di whitelist KID_FRIENDLY_CHANNELS (channel edukasi/kartun/anak terkenal)
  //   - ATAU judul mengandung kata kunci anak/kids/edukasi/cartoon/dongeng/dll.
  //   - Video lain di-hide (display:none) — feed jadi hanya konten ramah anak.
  // Catatan: ini bukan redirect ke youtubekids.com. User tetap di youtube.com biasa,
  // tapi feed difilter supaya hanya konten ramah anak yang tampil.
  //
  // v3.11.1 (Issue 1 fix): Flicker fix.
  //   YouTube recycle DOM node: judul/channel di-update oleh polymer saat scroll,
  //   menyebabkan flag rfCgKidHidden stale. Fix: simpan content hash di dataset,
  //   re-evaluate kalau hash berubah (node di-recycle dengan konten baru).
  //   Hide via CSS !important (di injectHideCSS), bukan inline style — lebih persisten.
  function hideNonKidContent() {
    // Whitelist channel ramah anak (lowercase, match substring)
    // v3.11.1: tambah banyak channel Islamic kids Indonesia + channel edukasi positif
    const KID_FRIENDLY_CHANNELS = [
      // Kartun/anak internasional
      'cocomelon', 'super simple songs', 'pinkfong', 'little baby bum',
      'chuchu tv', 'kids tv', 'cvn 78 kids', 'edukids', 'boboiboy',
      'upin & ipin', 'upin ipin', 'didiketikdotcom', 'kastari animation',
      'nussa official', 'nussa', 'ruqot', 'drummy kids', 'natgeo kids',
      'national geographic kids', 'sesame street', 'pbs kids', 'tayo the little bus',
      'robocar poli', 'pororo', 'tobot', 'hello carbot', 'bumi cartoon',
      'keluarga cemara', 'si unyil', 'jalan sesame', 'monster school',
      'minecraft for kids', 'roblox for kids', 'lego',
      // v3.11.1: Channel Islamic / edukasi Islam anak
      'nussa official', 'nussa channel', 'ruqot channel', 'syiar tv',
      'boy shiandi', 'anis mata', 'matematika islam', 'yufid tv',
      'yufid kids', 'kisah nabi', 'cerita nabi', 'dongeng islami',
      'anak muslim', 'kids muslim', 'muslim kids', 'calon imam',
      'belajar mengaji', 'belajar doa', 'belajar islam', 'hijaiyah',
      'mini moslem', 'my little quran', 'sosok inspiratif', 'kisah rasul',
      '25 nabi', 'kisah 25 nabi', 'dongeng nabi', 'cerita islami',
      'adab anak muslim', 'anak saleh', 'anak sholeh', 'prasaja',
      'boboiboy galaxy', 'nussa kids', 'nussy', 'saifulrahman',
      // v3.11.1: Channel edukasi positif lain
      'national geographic', 'disney junior', 'disney channel', 'cartoon network',
      'kuassa teknologi', 'khan academy kids', 'scratch', 'tynker',
      'code.org', 'belajar koding', 'hour of code',
      // Indonesia edukasi
      'edukidstv', 'kastari', 'sains anak', 'belajar sains', 'budak cisewu',
      'keluarga sakinah', 'islamic kids', 'cahaya islam'
    ];
    // Kata kunci ramah anak di judul (lowercase, match substring)
    // v3.11.1: tambah kata kunci Islamic + edukasi positif
    const KID_TITLE_KEYWORDS = [
      'anak', 'kids', 'kid', 'cartoon', 'kartun', 'dongeng', 'cerita anak',
      'lagu anak', 'nursery rhymes', 'belajar', 'edukasi', 'balita',
      'anak-anak', 'prasekolah', 'tk ', 'paud', 'animasi', 'petualangan',
      'tayo', 'pororo', 'robocar', 'bumi', 'boboiboy', 'upin ipin',
      'nussa', 'ruqot', 'cocomelon', 'pinkfong',
      // v3.11.1: Kata kunci Islamic + edukasi
      'islami', 'islamic', 'hijaiyah', 'kisah nabi', 'rasul', 'nabi',
      'mengaji', 'doa harian', 'doa anak', 'quran kids', 'cerita islami',
      'dongeng islami', 'anak muslim', 'anak sholeh', 'anak saleh',
      'adab islam', 'akhlak', 'puasa anak', 'shalat anak', 'zakat',
      'calon imam', 'hafiz', 'hafidz', 'tajwid', 'iqro', 'iqró',
      'belajar shalat', 'belajar wudhu', 'belajar doa', 'belajar islam',
      'belajar mengaji', 'belajar huruf hijaiyah',
      // v3.11.1: Edukasi positif umum
      'belajar abc', 'belajar angka', 'belajar warna', 'belajar huruf',
      'belajar berhitung', 'belajar membaca', 'sains anak', 'edukasi sains',
      'coding for kids', 'lego education', 'stem kids', 'robotics kids'
    ];

    let hiddenCount = 0;
    let recycledCount = 0;
    for (const sel of YT_VIDEO_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(node => {
        // Skip ad slots
        if (node.querySelector('ytd-ad-slot-renderer, [class*="ad-"]')) return;
        // Jangan hide kalau sudah di-hide oleh filter negatif (lebih spesifik)
        if (node.dataset.rfCgHidden === '1') return;

        const title = (getYouTubeTitle(node) || '').toLowerCase();
        const channel = (getYouTubeChannel(node) || '').toLowerCase();
        const combined = title + ' ' + channel;

        // v3.11.1 (Issue 1 fix): Deteksi node recycling — hash judul+channel
        // YouTube kadang reuse DOM node untuk video berbeda saat scroll.
        // Kalau hash berubah, reset flag supaya re-evaluate.
        const currentHash = combined.slice(0, 200); // batasi panjang hash
        const prevHash = node.dataset.rfCgKidHash || '';
        if (node.dataset.rfCgKidHidden === '1' && prevHash && prevHash !== currentHash) {
          // Node di-recycle dengan konten baru — re-evaluate
          delete node.dataset.rfCgKidHidden;
          delete node.dataset.rfCgReason;
          recycledCount++;
        }
        // Simpan hash untuk deteksi recycle berikutnya
        node.dataset.rfCgKidHash = currentHash;

        if (node.dataset.rfCgKidHidden === '1') return; // sudah di-hide, skip

        // Cek apakah ramah anak
        const isKidFriendly =
          KID_FRIENDLY_CHANNELS.some(c => channel.includes(c)) ||
          KID_TITLE_KEYWORDS.some(k => combined.includes(k));

        if (!isKidFriendly) {
          // v3.11.1: Hide via dataset attribute + CSS !important rule (di injectHideCSS).
          // Tidak lagi pakai inline style.display='none' — terlalu mudah di-override YouTube.
          node.dataset.rfCgKidHidden = '1';
          node.dataset.rfCgReason = 'kid_mode_filter';
          // Backup: set inline style juga (double protection)
          node.style.setProperty('display', 'none', 'important');
          hiddenCount++;
        }
      });
    }
    if ((hiddenCount > 0 || recycledCount > 0) && settings?.contentGuardDebugMode) {
      console.log('[RecallFox/CG] Kid mode: hidden', hiddenCount, 'non-kid videos, recycled', recycledCount);
    }
    return hiddenCount;
  }

  function hideXNegative() {
    let changed = false;
    // Pakai Set untuk deduplikasi node
    const allNodes = new Set();
    for (const sel of X_TWEET_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(n => allNodes.add(n));
    }

    for (const node of allNodes) {
      if (node.dataset.rfCgHidden === '1') continue;
      if (node.querySelector('[data-testid="placementTracking"]')) continue;
      if (node.tagName !== 'ARTICLE' && !node.closest('article')) {
        if (node.getAttribute('data-testid') !== 'tweetText') continue;
      }

      const txt = getXTweetText(node);
      const author = getXTweetAuthor(node);

      // v3.4: Extract URL post X dari tweet article (link ke tweet itu sendiri)
      // X punya pola: <a href="/<user>/status/<id>"> dengan timestamp/ikon jam
      // Cari di dalam article, khusus link yang path-nya mengandung /status/
      let postUrl = '';
      try {
        // Cari semua anchor dengan href berisi /status/ — biasanya itu link ke tweet
        const links = node.querySelectorAll('a[href*="/status/"]');
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          // Skip link reply (href-nya sama dengan reply target)
          // Pilih link yang href-nya cuma /<user>/status/<id> (tanpa query photo/1 dll)
          if (/^\/[^/]+\/status\/\d+(?:\?|$)/.test(href)) {
            postUrl = location.protocol + '//' + location.hostname + href.split('?')[0];
            break;
          }
        }
      } catch (e) {}

      // v0.8.40: Hanya Nuclear Mode — cek keyword negatif + account blocklist + user blocklist
      const negKw = containsNegative(txt);
      const blockedAcct = settings.contentGuardBlockXAccounts !== false ? isChannelBlocked(author) : null;
      const userBlk = matchesUserBlocklistLocal(txt, author);
      // v3.4: Cek juga apakah URL post ini ada di blocklist
      const urlBlk = postUrl ? matchesBlockedXPostUrlLocal(postUrl) : null;

      if (negKw || blockedAcct || userBlk || urlBlk) {
        let target = node;
        if (node.getAttribute('data-testid') === 'tweetText' && node.tagName !== 'ARTICLE') {
          const parentArticle = node.closest('article, div[data-testid="cellInnerDiv"]');
          if (parentArticle) target = parentArticle;
        }
        target.style.setProperty('display', 'none', 'important');
        target.dataset.rfCgHidden = '1';
        target.dataset.rfCgReason = negKw || blockedAcct || (userBlk?.entry?.value) || (urlBlk?.entry?.value) || 'unknown';
        target.dataset.rfCgTitle = (txt || '').slice(0, 100);
        target.dataset.rfCgChannel = (author || '').slice(0, 60);
        hiddenCount++;
        changed = true;
        if (settings.contentGuardDebugMode) {
          console.log('[RecallFox/CG] X hidden:', { text: txt.slice(0, 100), author, postUrl, reason: target.dataset.rfCgReason });
        }
      }
    }
    panelStats.blocked = hiddenCount;
    panelStats.allowed = countAllowedTweets();
    panelStats.lastScanAt = Date.now();
    // v0.8.33: Update HANYA counter (text content) — jangan rebuild DOM
    ensureControlPanel();
    updateControlPanelStatus();
    updatePanelCounters();
  }

  // v0.8.27: Hitung jumlah tweet yang TIDAK di-hidden (allowed)
  function countAllowedTweets() {
    let count = 0;
    const allNodes = new Set();
    for (const sel of X_TWEET_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch (e) { continue; }
      nodes.forEach(n => allNodes.add(n));
    }
    for (const node of allNodes) {
      if (node.dataset.rfCgHidden !== '1') count++;
    }
    return count;
  }

  // ===== Status Panel (PERMANEN — selalu visible) =====
  // v0.8.27: Indikator real-time yang SELALU tampil di pojok kanan bawah.
  // Menampilkan: status AKTIF/TIDAK AKTIF, jumlah diblokir, jumlah diizinkan.
  // Klik biasa = sembunyikan panel. Alt+Klik = buka debug overlay.
  let panelStats = { blocked: 0, allowed: 0, lastScanAt: null };

  // ===== Debug overlay =====
  let debugOverlay = null;
  function toggleDebugOverlay() {
    if (debugOverlay) {
      debugOverlay.remove();
      debugOverlay = null;
      return;
    }
    debugOverlay = document.createElement('div');
    debugOverlay.id = 'rf-cg-debug';
    debugOverlay.style.cssText = `
      position: fixed !important;
      top: 16px !important;
      right: 16px !important;
      z-index: 2147483647 !important;
      width: 380px !important;
      max-height: 80vh !important;
      overflow-y: auto !important;
      background: #1e293b !important;
      color: #f1f5f9 !important;
      font: 11px/1.5 monospace !important;
      padding: 12px !important;
      border-radius: 8px !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4) !important;
      border: 1px solid #475569 !important;
    `;
    document.documentElement.appendChild(debugOverlay);
    renderDebugOverlay();
  }

  function renderDebugOverlay() {
    if (!debugOverlay) return;
    // Hitung semua elemen yang di-scan
    const ytCount = isYouTube ? document.querySelectorAll(YT_VIDEO_SELECTORS.join(', ')).length : 0;
    const xArticles = isX ? document.querySelectorAll('article').length : 0;
    const xTweetTexts = isX ? document.querySelectorAll('[data-testid="tweetText"]').length : 0;
    const hiddenNodes = document.querySelectorAll('[data-rf-cg-hidden="1"]');

    let html = `
      <div style="font-weight:bold;font-size:12px;margin-bottom:8px;color:#fbbf24;">🔍 RecallFox Content Guardian Debug</div>
      <div style="margin-bottom:6px;">Platform: <b>${isYouTube ? 'YouTube' : (isX ? 'X' : '?')}</b></div>
      <div style="margin-bottom:6px;">Settings loaded: ${settings ? '✅' : '❌'}</div>
      <div style="margin-bottom:6px;">Filter aktif: ${shouldRun() ? '✅' : '❌'}</div>
      <div style="margin-bottom:6px;">Keywords: ${(getKeywords() || []).length}</div>
      <div style="margin-bottom:6px;">Blocked YT channels: ${(getBlockedYtChannels() || []).length}</div>
      <div style="margin-bottom:6px;">Blocked X accounts: ${(getBlockedXAccounts() || []).length}</div>
      <div style="margin-bottom:6px;">User blocklist entries: ${getUserBlocklist().length}</div>
      <div style="margin-bottom:6px;">Elements scanned (YT): ${ytCount}</div>
      <div style="margin-bottom:6px;">Articles in DOM (X): ${xArticles}</div>
      <div style="margin-bottom:6px;">TweetText elements (X): ${xTweetTexts}</div>
      <div style="margin-bottom:6px;">Hidden total: <b style="color:#dc2626;">${hiddenCount}</b></div>
      <div style="margin-bottom:6px;">Hidden nodes in DOM: ${hiddenNodes.length}</div>
      <hr style="border-color:#475569;margin:8px 0;" />
      <div style="font-weight:bold;margin-bottom:6px;color:#fbbf24;">Last 10 hidden:</div>
    `;
    const recent = Array.from(hiddenNodes).slice(-10).reverse();
    if (recent.length === 0) {
      html += '<div style="color:#94a3b8;font-style:italic;">(belum ada yang di-hidden)</div>';
    } else {
      recent.forEach((n, i) => {
        const title = (n.dataset.rfCgTitle || '').slice(0, 60);
        const chan = (n.dataset.rfCgChannel || '').slice(0, 30);
        const reason = n.dataset.rfCgReason || '';
        html += `
          <div style="margin-bottom:6px;padding:4px 6px;background:#0f172a;border-radius:4px;">
            <div style="color:#fbbf24;">#${i + 1} [${reason}]</div>
            <div style="color:#e2e8f0;">${escapeHtml(title)}</div>
            <div style="color:#94a3b8;">@${escapeHtml(chan)}</div>
          </div>
        `;
      });
    }
    html += `
      <hr style="border-color:#475569;margin:8px 0;" />
      <div style="font-size:10px;color:#94a3b8;">
        Alt+Klik badge untuk tutup. Jika elemen di-scan = 0, mungkin selector tidak match.
        Cek console (F12) untuk log detail (aktifkan "Mode Debug" di Settings).
      </div>
    `;
    debugOverlay.innerHTML = html;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ===== Pasang observer + interval fallback (SUPER CEPAT) =====
  // v0.8.25: interval 500ms (sebelumnya 2000ms) supaya lazy-load ke-catch lebih cepat
  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
    // Interval fallback: scan setiap 500ms (X & YT lazy-load, kadang observer kelewat)
    if (!intervalTimer) {
      intervalTimer = setInterval(() => {
        scheduleScan();
        if (settings?.contentGuardDebugMode && debugOverlay) {
          renderDebugOverlay();
        }
      }, 500);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        if (isYouTube) hideYouTubeNegative();
        if (isX) hideXNegative();
      } catch (e) {
        console.warn('[RecallFox/CG] scan error:', e);
      }
    }, 150);  // debounce 150ms (sebelumnya 300ms) — lebih responsif
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  // ===== Track hovered element untuk context menu =====
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest(
      YT_VIDEO_SELECTORS.join(', ') + ', ' + X_TWEET_SELECTORS.join(', ') + ', article'
    );
    hoveredElement = card || null;
  }, true);

  // ===== Deteksi platform =====
  let isYouTube = false;
  let isX = false;
  function detectPlatform() {
    const host = location.hostname.toLowerCase();
    isYouTube = host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com');
    isX = host.endsWith('twitter.com') || host.endsWith('x.com');
  }

  function injectHideCSS() {
    const cssId = 'rf-cg-hide-css';
    if (document.getElementById(cssId)) return;
    const style = document.createElement('style');
    style.id = cssId;
    // v3.11.1 (Issue 1 fix): Mode Anak flicker fix.
    // Sebelumnya hanya inline style.display='none' yang dipakai — YouTube
    // merecycle node & meng-override inline style saat re-render, menyebabkan
    // flicker. Sekarang hide via attribute selector + !important rule.
    style.textContent = `
      [data-rf-cg-hidden="1"] { display: none !important; }
      [data-rf-cg-kid-hidden="1"] { display: none !important; }
      [data-rf-cg-shelf-hidden="1"] { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  // ===== v0.8.26: Auto-reload settings setiap 3 detik (defensive) =====
  // Kalau CG_SETTINGS_UPDATED broadcast miss (e.g., tab sudah terbuka sebelum
  // addon update), settings tetap ke-update via polling.
  let settingsReloadTimer = null;
  function startSettingsPolling() {
    if (settingsReloadTimer) return;
    settingsReloadTimer = setInterval(async () => {
      const prev = JSON.stringify(settings);
      const ok = await loadSettings();
      if (!ok) return;
      const now = JSON.stringify(settings);
      if (prev !== now) {
        console.log('[RecallFox/CG] Settings changed (detected via polling) — re-scanning');
        // Reset hidden flags supaya re-evaluate
        document.querySelectorAll('[data-rf-cg-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgHidden;
          delete el.dataset.rfCgReason;
          delete el.dataset.rfCgTitle;
          delete el.dataset.rfCgChannel;
        });
        // v3.11.1 (Issue 1 fix): Reset juga flag Mode Anak + content hash
        document.querySelectorAll('[data-rf-cg-kid-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgKidHidden;
          delete el.dataset.rfCgReason;
          delete el.dataset.rfCgKidHash;
        });
        document.querySelectorAll('[data-rf-cg-shelf-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgShelfHidden;
        });
        hiddenCount = 0;
        if (isYouTube) hideYouTubeNegative();
        if (isX) hideXNegative();
      }
    }, 3000);
  }

  // ===== v0.8.29: Floating Control Panel — toggle on/off langsung di halaman =====
  // User minta: tidak usah buka Settings page, langsung toggle di halaman YouTube/X
  // dengan icon mengambang. Bisa lihat perbedaan langsung.
  let controlPanel = null;
  let controlPanelToggle = null;
  let isControlPanelExpanded = false;
  let panelPosition = { x: 16, y: 80 };  // default pojok kiri atas

  // Load saved position dari localStorage
  function loadPanelPosition() {
    try {
      const saved = localStorage.getItem('rf_cg_panel_pos');
      if (saved) {
        const pos = JSON.parse(saved);
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
          panelPosition = pos;
        }
      }
    } catch (e) {}
  }
  function savePanelPosition() {
    try {
      localStorage.setItem('rf_cg_panel_pos', JSON.stringify(panelPosition));
    } catch (e) {}
  }

  // v0.8.34: Declare isCollapsed + collapse functions BEFORE ensureControlPanel
  // (v0.8.33 bug: these were missing → ReferenceError → toggles tidak render)
  let isCollapsed = false;
  function collapsePanel() {
    const b = document.getElementById('rf-cg-body');
    const btn = document.getElementById('rf-cg-collapse');
    if (b && btn) {
      b.style.display = 'none';
      btn.textContent = '+';
      isCollapsed = true;
    }
  }
  function expandPanel() {
    const b = document.getElementById('rf-cg-body');
    const btn = document.getElementById('rf-cg-collapse');
    if (b && btn) {
      b.style.display = 'block';
      btn.textContent = '−';
      isCollapsed = false;
    }
  }
  function toggleCollapse() {
    if (isCollapsed) expandPanel();
    else collapsePanel();
  }

  // v0.8.37: Guard anti-duplikat — flag saat panel sedang di-build
  let panelBuilding = false;
  function ensureControlPanel() {
    // v3.4: Jangan tampilkan floating panel kalau setting contentGuardShowFloating === false
    // Default false — user harus enable manual lewat menu Alat → Kontrol Situs → Pengaturan Guardian
    if (settings && settings.contentGuardShowFloating === false) {
      // Kalau panel sudah ada (user baru saja toggle OFF), remove
      if (controlPanel && document.documentElement.contains(controlPanel)) {
        controlPanel.remove();
      }
      return;
    }
    // v0.8.37: FIX BUG — panel attach ke documentElement, bukan body.
    // Pakai documentElement.contains() (yang includes body + langsung documentElement children)
    if (controlPanel && document.documentElement.contains(controlPanel)) return;
    // v0.8.37: Kalau sedang di-build → return (anti race condition)
    if (panelBuilding) {
      return;
    }
    panelBuilding = true;
    try {
      // v0.8.32: Hapus panel duplikat yang mungkin ada (defensive)
      document.querySelectorAll('#rf-cg-control').forEach(el => {
        if (el !== controlPanel) el.remove();
      });
      loadPanelPosition();

    // Container utama
    controlPanel = document.createElement('div');
    controlPanel.id = 'rf-cg-control';
    controlPanel.style.cssText = `
      position: fixed !important;
      top: ${panelPosition.y}px !important;
      left: ${panelPosition.x}px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%) !important;
      color: #f1f5f9 !important;
      font: 600 11px/1.4 system-ui, -apple-system, sans-serif !important;
      border-radius: 12px !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4) !important;
      border: 1px solid rgba(34,197,94,0.4) !important;
      min-width: 220px !important;
      max-width: 320px !important;
      user-select: none !important;
      pointer-events: auto !important;
    `;
    document.documentElement.appendChild(controlPanel);

    // v0.8.33: Build panel structure SEKALI (static), bukan re-render setiap scan
    controlPanel.innerHTML = `
      <div id="rf-cg-header" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;border-bottom:1px solid rgba(148,163,184,0.2);">
        <span style="font-size:16px;pointer-events:none;">🛡️</span>
        <span style="font-weight:700;font-size:12px;flex:1;pointer-events:none;">RecallFox Guardian</span>
        <span id="rf-cg-status-mini" title="Status Content Guardian" style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(220,38,38,0.2);color:#fca5a5;pointer-events:none;cursor:help;">🔴 MATI</span>
        <button id="rf-cg-collapse" title="Sembunyikan/Tampilkan" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;padding:0 4px;">−</button>
      </div>
      <div id="rf-cg-body" style="padding: 10px 12px;">
        <div style="display:flex;gap:6px;font-size:10px;margin-bottom:8px;">
          <span style="background:rgba(220,38,38,0.2);color:#fca5a5;padding:3px 6px;border-radius:4px;flex:1;text-align:center;">🚫 Blokir: <b id="rf-cg-blocked-count" style="color:#fff;">0</b></span>
          <span style="background:rgba(34,197,94,0.2);color:#86efac;padding:3px 6px;border-radius:4px;flex:1;text-align:center;">✓ Izinkan: <b id="rf-cg-allowed-count" style="color:#fff;">0</b></span>
        </div>
        <div id="rf-cg-mode-info" style="font-size:9px;color:#94a3b8;margin-bottom:8px;text-align:center;">
          Mode: <b id="rf-cg-mode-label">NUCLEAR</b> | Scan: <span id="rf-cg-scan-time">—</span>
        </div>
        <div style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;" id="rf-cg-toggles"></div>
        <div style="border-top:1px solid rgba(148,163,184,0.2);padding-top:8px;margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="rf-cg-test-hide" style="background:#f59e0b;color:#000;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;flex:1;">🧪 Test Hide</button>
          <button id="rf-cg-rescan" style="background:#3b82f6;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;flex:1;">🔄 Re-scan</button>
          <button id="rf-cg-settings" style="background:#6b7280;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;flex:1;">⚙️ Settings</button>
        </div>
        <div style="font-size:8px;color:#64748b;margin-top:6px;text-align:center;">Drag header • Hover untuk expand • v0.8.40</div>
      </div>
    `;

    const header = controlPanel.querySelector('#rf-cg-header');
    const collapseBtn = controlPanel.querySelector('#rf-cg-collapse');

    // v0.8.33: Drag logic — jangan trigger re-render saat drag
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };
    let dragStarted = false;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
      isDragging = true;
      dragStarted = false;
      const rect = controlPanel.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      dragStarted = true;
      const newX = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffset.x));
      const newY = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - dragOffset.y));
      panelPosition = { x: newX, y: newY };
      controlPanel.style.left = newX + 'px';
      controlPanel.style.top = newY + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        if (dragStarted) savePanelPosition();
      }
    });

    // Collapse button
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleCollapse();
    });

    // v0.8.33: Auto-collapse dengan debounce yang benar
    // Hanya collapse kalau mouse BENAR-BENAR keluar selama 4 detik (bukan saat re-render)
    let autoCollapseTimer = null;
    let isHovered = false;
    controlPanel.addEventListener('mouseenter', () => {
      isHovered = true;
      if (autoCollapseTimer) {
        clearTimeout(autoCollapseTimer);
        autoCollapseTimer = null;
      }
      if (isCollapsed) expandPanel();
    });
    controlPanel.addEventListener('mouseleave', () => {
      isHovered = false;
      if (autoCollapseTimer) clearTimeout(autoCollapseTimer);
      autoCollapseTimer = setTimeout(() => {
        // Cek lagi sebelum collapse — mungkin mouse sudah balik
        if (!isHovered && !isCollapsed) {
          collapsePanel();
        }
      }, 4000);
    });

    // Initial: expanded
    isCollapsed = false;

    // v0.8.33: Build toggles SEKALI (static)
    buildToggles();

    // Bind button events SEKALI
    bindPanelButtons();

    // Initial counter update
    updatePanelCounters();
    } catch(e) {
      console.error('[RecallFox/CG] ensureControlPanel error:', e.message);
    } finally {
      panelBuilding = false;
    }
  }

  // v0.8.33: Build toggles sekali saja — TIDAK di-rebuild setiap scan
  function buildToggles() {
    const container = document.getElementById('rf-cg-toggles');
    if (!container) return;
    const s = settings || {};
    const toggles = [
      { id: 'rf-cg-tg-enabled', label: 'Master ON/OFF', key: 'contentGuardEnabled', checked: s.contentGuardEnabled !== false },
      { id: 'rf-cg-tg-nuclear', label: 'Nuclear Mode', key: 'contentGuardNuclearMode', checked: s.contentGuardNuclearMode !== false },
      { id: 'rf-cg-tg-filter', label: 'Filter Feed', key: 'contentGuardFilterFeeds', checked: s.contentGuardFilterFeeds !== false },
      { id: 'rf-cg-tg-redirect', label: 'Redirect Home', key: 'contentGuardForceRedirect', checked: s.contentGuardForceRedirect === true },
      { id: 'rf-cg-tg-search', label: 'Block Search', key: 'contentGuardBlockSearchQueries', checked: s.contentGuardBlockSearchQueries !== false }
    ];
    container.innerHTML = toggles.map(t => `
      <div class="rf-cg-toggle-row" data-toggle-id="${t.id}" data-key="${t.key}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:11px;cursor:pointer;">
        <span style="color:#cbd5e1;pointer-events:none;">${t.label}</span>
        <div style="position:relative;display:inline-block;width:32px;height:18px;flex-shrink:0;pointer-events:none;">
          <input type="checkbox" id="${t.id}" ${t.checked ? 'checked' : ''} style="display:none;">
          <span class="rf-cg-slider" style="position:absolute;top:0;left:0;right:0;bottom:0;background:${t.checked ? '#16a34a' : '#475569'};border-radius:9px;transition:background 0.2s;"></span>
          <span class="rf-cg-knob" style="position:absolute;height:14px;width:14px;left:${t.checked ? '16px' : '2px'};bottom:2px;background:#fff;border-radius:50%;transition:left 0.2s;"></span>
        </div>
      </div>
    `).join('');

    // Bind click event untuk setiap toggle row
    container.querySelectorAll('.rf-cg-toggle-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = row.dataset.key;
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (!checkbox || !key) return;
        const newChecked = !checkbox.checked;
        checkbox.checked = newChecked;
        // Update visual
        const slider = row.querySelector('.rf-cg-slider');
        const knob = row.querySelector('.rf-cg-knob');
        if (slider) slider.style.background = newChecked ? '#16a34a' : '#475569';
        if (knob) knob.style.left = newChecked ? '16px' : '2px';
        console.log('[RecallFox/CG] Toggle clicked:', key, '=', newChecked);
        // Save setting
        let saved = false;
        try {
          const resp = await browser.runtime.sendMessage({ type: 'CG_SAVE_SETTING', key, value: newChecked });
          if (resp && resp.ok) saved = true;
        } catch (err) {
          console.warn('[RecallFox/CG] Save via background gagal:', err.message);
        }
        if (!saved) {
          try {
            const data = await browser.storage.local.get('recallfox_vault');
            const vault = data.recallfox_vault || { settings: {} };
            vault.settings[key] = newChecked;
            await browser.storage.local.set({ recallfox_vault: vault });
            saved = true;
          } catch (err2) {
            console.error('[RecallFox/CG] Save via storage.local gagal:', err2.message);
          }
        }
        await loadSettings();
        if (settings) settings[key] = newChecked;
        // Reset + re-scan
        document.querySelectorAll('[data-rf-cg-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgHidden;
          delete el.dataset.rfCgReason;
        });
        document.querySelectorAll('[data-rf-cg-shelf-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgShelfHidden;
        });
        hiddenCount = 0;
        if (isYouTube) hideYouTubeNegative();
        if (isX) hideXNegative();
        updateControlPanelStatus();
        updatePanelCounters();
      });
    });
  }

  // v0.8.33: Bind tombol Test Hide, Re-scan, Settings SEKALI
  function bindPanelButtons() {
    const testBtn = document.getElementById('rf-cg-test-hide');
    if (testBtn) {
      testBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = isYouTube
          ? 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer'
          : 'article[data-testid="tweet"], article';
        const cards = document.querySelectorAll(sel);
        let hidden = 0;
        for (const c of cards) {
          if (c.dataset.rfCgHidden !== '1' && c.offsetHeight > 0) {
            c.style.setProperty('display', 'none', 'important');
            c.dataset.rfCgHidden = '1';
            c.dataset.rfCgReason = 'test_hide';
            hiddenCount++;
            hidden++;
            if (hidden >= 1) break;
          }
        }
        panelStats.blocked = hiddenCount;
        panelStats.allowed = isYouTube ? countAllowedCards() : countAllowedTweets();
        panelStats.lastScanAt = Date.now();
        updatePanelCounters();
        alert(hidden > 0
          ? `✓ Test berhasil! ${hidden} video di-hide. Berarti content script JALAN.`
          : '⚠️ Tidak ada video yang bisa di-hide. Mungkin halaman belum fully loaded.');
      });
    }

    const rescanBtn = document.getElementById('rf-cg-rescan');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        rescanBtn.textContent = '🔄 Scanning...';
        document.querySelectorAll('[data-rf-cg-hidden="1"]').forEach(el => {
          el.style.removeProperty('display');
          delete el.dataset.rfCgHidden;
          delete el.dataset.rfCgReason;
        });
        hiddenCount = 0;
        if (isYouTube) hideYouTubeNegative();
        if (isX) hideXNegative();
        updatePanelCounters();
        setTimeout(() => { rescanBtn.textContent = '🔄 Re-scan'; }, 1000);
      });
    }

    const settingsBtn = document.getElementById('rf-cg-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[RecallFox/CG] Settings button clicked');
        try { await browser.runtime.openOptionsPage(); return; } catch (err) {}
        try {
          const url = browser.runtime.getURL('settings/settings.html');
          await browser.tabs.create({ url });
          return;
        } catch (err2) {}
        try {
          window.open(browser.runtime.getURL('settings/settings.html'), '_blank');
        } catch (err3) {
          alert('Tidak bisa buka Settings. Buka via about:addons → RecallFox → Pengaturan.');
        }
      });
    }
  }

  // v0.8.33: Update HANYA counter & mode (text content) — TIDAK rebuild DOM
  // Ini fix flicker — sebelumnya renderControlPanelBody() rebuild seluruh panel setiap 500ms
  function updatePanelCounters() {
    const blockedEl = document.getElementById('rf-cg-blocked-count');
    const allowedEl = document.getElementById('rf-cg-allowed-count');
    const modeEl = document.getElementById('rf-cg-mode-label');
    const scanEl = document.getElementById('rf-cg-scan-time');
    if (blockedEl) blockedEl.textContent = panelStats.blocked;
    if (allowedEl) allowedEl.textContent = panelStats.allowed;
    if (modeEl) {
      modeEl.textContent = 'NUCLEAR';
      modeEl.style.color = '#dc2626';
    }
    if (scanEl) {
      scanEl.textContent = panelStats.lastScanAt
        ? new Date(panelStats.lastScanAt).toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'})
        : '—';
    }
  }


  // v0.8.30: Update mini status di header panel — FIX bug status MATI padahal Master ON
  function updateControlPanelStatus() {
    const mini = document.getElementById('rf-cg-status-mini');
    if (!mini) return;
    if (!settings) {
      mini.textContent = '🔴 NO SETTINGS';
      mini.style.background = 'rgba(220,38,38,0.2)';
      mini.style.color = '#fca5a5';
      return;
    }
    // Cek tiap kondisi untuk diagnostic
    if (settings.contentGuardEnabled === false) {
      mini.textContent = '🔴 MASTER OFF';
      mini.style.background = 'rgba(220,38,38,0.2)';
      mini.style.color = '#fca5a5';
      return;
    }
    if (settings.contentGuardFilterFeeds === false) {
      mini.textContent = '🔴 FILTER OFF';
      mini.style.background = 'rgba(220,38,38,0.2)';
      mini.style.color = '#fca5a5';
      return;
    }
    // Semua kondisi terpenuhi
    mini.textContent = '🟢 AKTIF';
    mini.style.background = 'rgba(34,197,94,0.2)';
    mini.style.color = '#86efac';
  }
  async function init() {
    detectPlatform();
    if (!isYouTube && !isX) return;
    console.log('[RecallFox/CG] Initializing on', isYouTube ? 'YouTube' : 'X', 'at', location.href);

    const ok = await loadSettings();
    // v0.8.29: Tampilkan floating control panel SEGERA (bahkan kalau settings gagal load)
    ensureControlPanel();
    updateControlPanelStatus();
    if (!ok) {
      console.warn('[RecallFox/CG] Failed to load settings on init — Content Guardian TIDAK AKTIF');
      return;
    }
    updateControlPanelStatus();
    if (!shouldRun()) {
      console.log('[RecallFox/CG] Filter disabled in settings — Content Guardian MATI');
      return;
    }
    injectHideCSS();
    // Initial sweep
    if (isYouTube) hideYouTubeNegative();
    if (isX) hideXNegative();
    startObserver();
    startSettingsPolling();
    console.log('[RecallFox/CG] Content Guardian AKTIF di', isYouTube ? 'YouTube' : 'X',
      '| keywords:', getKeywords().length, '| blocklist:', getUserBlocklist().length,
      '| nuclearMode:', settings?.contentGuardNuclearMode !== false);
  }

  // ===== Handler message dari background =====
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // v0.8.27: Ping handler — supaya background bisa cek apakah content script sudah ter-load
    if (msg?.type === 'CG_PING') {
      sendResponse({ ok: true, platform: isYouTube ? 'youtube' : (isX ? 'x' : 'unknown'), hiddenCount });
      return false;
    }

    if (msg?.type === 'CG_SETTINGS_UPDATED') {
      loadSettings().then(() => {
        if (!shouldRun()) {
          stopObserver();
        } else {
          // Reset "hidden" flag supaya re-evaluate
          document.querySelectorAll('[data-rf-cg-hidden="1"]').forEach(el => {
            el.style.removeProperty('display');
            delete el.dataset.rfCgHidden;
            delete el.dataset.rfCgReason;
            delete el.dataset.rfCgTitle;
            delete el.dataset.rfCgChannel;
          });
          hiddenCount = 0;
          startObserver();
          if (isYouTube) hideYouTubeNegative();
          if (isX) hideXNegative();
        }
      });
      return false;
    }

    if (msg?.type === 'CG_RESCAN_NOW') {
      // Reset hidden flags lalu re-scan
      document.querySelectorAll('[data-rf-cg-hidden="1"]').forEach(el => {
        el.style.removeProperty('display');
        delete el.dataset.rfCgHidden;
        delete el.dataset.rfCgReason;
      });
      hiddenCount = 0;
      if (isYouTube) hideYouTubeNegative();
      if (isX) hideXNegative();
      return false;
    }

    if (msg?.type === 'CG_PAUSE_FEED_FILTER') {
      stopObserver();
      return false;
    }
    if (msg?.type === 'CG_RESUME_FEED_FILTER') {
      if (shouldRun()) startObserver();
      return false;
    }

    if (msg?.type === 'CG_TOGGLE_DEBUG') {
      toggleDebugOverlay();
      return false;
    }

    if (msg?.type === 'CG_GET_CONTEXT_FOR_BLOCK') {
      const menuItemId = msg.menuItemId;
      const selectionText = msg.selectionText || '';

      let targetEl = hoveredElement;
      if (!targetEl) {
        const sel = window.getSelection();
        if (sel && sel.anchorNode) {
          targetEl = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)
            ?.closest(YT_VIDEO_SELECTORS.join(', ') + ', ' + X_TWEET_SELECTORS.join(', ') + ', article');
        }
      }

      let title = '';
      let channel = '';
      let value = '';

      if (targetEl) {
        if (isYouTube) {
          title = getYouTubeTitle(targetEl);
          channel = getYouTubeChannel(targetEl);
        } else if (isX) {
          title = getXTweetText(targetEl);
          channel = getXTweetAuthor(targetEl);
        }
      }

      if (menuItemId === 'rf-cg-block-title') {
        value = title;
      } else if (menuItemId === 'rf-cg-block-exact-title') {
        value = title;
      } else if (menuItemId === 'rf-cg-block-channel') {
        value = channel;
      } else if (menuItemId === 'rf-cg-block-keyword') {
        value = selectionText || title;
      }

      sendResponse({
        value: (value || '').trim().slice(0, 300),
        title,
        channel,
        platform: isYouTube ? 'youtube' : (isX ? 'x' : 'unknown')
      });
      return true;
    }
  });

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
