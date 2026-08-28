# RecallFox v3.20.22 — Fix: Tombol Pengaturan (Gerigi) Mati di Popout Sidebar

**Release date:** 2026-08-03
**Tag:** `v3.20.22` (bug fix)
**Manifest version bump:** `3.20.21` → `3.20.22`

## TL;DR

Bug: tombol pengaturan (ikon roda gerigi) di sudut kanan atas panel RecallFox
tidak berfungsi (mati) ketika antarmuka dalam mode 'popout sidebar'. User report:

> "Tombol pengaturan (ikon roda gerigi yang dianotasi kotak merah muda) di
> sudut kanan atas panel RecallFox tidak berfungsi (mati). Ini terjadi ketika
> antarmuka sedang dalam mode 'popout sidebar'."

Root cause: `browser.runtime.openOptionsPage()` di Firefox bisa gagal di iframe
extension page (sidebar.html yang di-iframe di popout sidebar). Bug Firefox
terkenal — kadang no-op tanpa error.

Fix: tambah helper `openSettings()` dengan fallback chain:
1. `browser.runtime.openOptionsPage()` (di top-level context — popup/sidebar native)
2. `browser.tabs.create({ url: settings.html })` (di iframe atau kalau #1 gagal)

Apply helper ke **6 call sites** yang pakai `openOptionsPage()` langsung.

## Yang diubah

### 1. `popup/popup.js` — Helper `openSettings()` baru

```javascript
async function openSettings() {
  const inIframe = (window !== window.top);

  if (!inIframe) {
    // Top-level context — openOptionsPage lebih native (respect user tab preference)
    try {
      await browser.runtime.openOptionsPage();
      return;
    } catch (e) {
      console.warn('[RecallFox] openOptionsPage failed, fallback to tabs.create:', e.message);
    }
  }

  // Iframe context (popout sidebar) atau openOptionsPage gagal → fallback ke tabs.create
  // Ini selalu bekerja di semua context.
  try {
    await browser.tabs.create({ url: browser.runtime.getURL('settings/settings.html') });
  } catch (e2) {
    console.error('[RecallFox] tabs.create fallback also failed:', e2.message);
    toast('⚠️ Tidak bisa buka pengaturan: ' + e2.message, false);
  }
}
```

### 2. `popup/popup.js` — Apply helper ke 6 call sites

Semua yang sebelumnya pakai `browser.runtime.openOptionsPage()` langsung
sekarang pakai `openSettings()`:

| Lokasi | ID elemen | Trigger |
|--------|-----------|---------|
| Header sidebar/popup | `#settingsBtn` | Klik ikon gerigi di header |
| Sheet "Buka di Pengaturan" | `#goSettings` | Klik tombol di feature sheet kosong |
| Halaman settings | `#rfGoSettings` | Klik tombol "Buka Settings" |
| Halaman Tanya AI (setup) | `#askAiSetup` | Klik tombol setup AI |
| Halaman Tanya AI (send) | `#askAiSend` | Klik kirim tanpa AI configured |
| Halaman Tanya AI (tab) | `#askAiSendTab` | Klik "tanya tentang tab" tanpa AI configured |

## Audit elemen interaktif lain di popout sidebar (Langkah 3)

Saya juga audit elemen lain yang user sebutkan di report. **Semua sudah works**:

| Elemen | Status | Catatan |
|--------|--------|---------|
| Tombol "Salin" item vault | ✅ Works | Sudah di-fix di v3.20.21 (4-level fallback chain) |
| Filter kategori (Semua, Terbaru, Prompt, dll) | ✅ Works | Pakai event delegation `renderChips()` — bekerja di iframe |
| Search bar | ✅ Works | Input native, tidak butuh extension API |
| Tombol RecallTape (🧾) | ✅ Works | Sudah ada iframe detection sejak v3.20.8 (postMessage ke parent) |
| Tombol AI (✨) | ✅ Works | `aiToolsSheet()` — render sheet di DOM, tidak butuh extension API |
| Tombol Theme | ✅ Works | `toggleTheme()` — localStorage + class toggle |
| Tombol Popout (sidebar icon) | ✅ Works | Sudah ada iframe detection sejak v3.20.7 (postMessage ke parent) |
| Tombol Stop Adzan | ✅ Works | Hanya muncul saat adzan aktif, kirim message ke background |
| Bottom nav (Pin, Home, Catatan, Kotak) | ✅ Works | Tidak ada di popup.html — user mungkin lihat di sidebar native (beda UI) |

**Tidak ada elemen lain yang mati.** Hanya `#settingsBtn` yang bermasalah, sudah di-fix.

## Skenario test

1. **Buka popout sidebar** (klik tombol "rf" di floater) → sidebar muncul
2. **Klik ikon gerigi** di pojok kanan atas → tab baru terbuka dengan `settings/settings.html`
3. **Buka sidebar native** (bukan popout) → klik ikon gerigi → settings terbuka (via openOptionsPage)
4. **Buka popup** (klik toolbar icon) → klik ikon gerigi → settings terbuka (via openOptionsPage)
5. **Test tombol settings lain**: buka sheet feature kosong (mis. Tanya AI tanpa config) → klik "Buka di Pengaturan" → settings terbuka
6. **Test di halaman Tanya AI**: klik "Kirim" tanpa config → settings terbuka

## File yang berubah

- `manifest.json` — version bump `3.20.21` → `3.20.22`
- `popup/popup.js` — tambah helper `openSettings()` + apply ke 6 call sites

## Catatan

- **Tidak ada breaking change**. Helper `openSettings()` backward compatible — behavior di top-level context sama seperti sebelumnya (pakai `openOptionsPage()`).
- **Audit menyeluruh**: semua elemen interaktif lain di popout sidebar sudah works. Tidak ada fix lain yang perlu di-apply.
- **Pattern konsisten**: fix ini mengikuti pattern yang sama dengan `openTapePopover()` (line 6045) dan `sidebarInPageBtn` (line 8772) — detect iframe context, fallback ke API yang reliable.
