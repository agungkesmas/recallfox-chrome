/**
 * ============================================================================
 * RecallFox v3.11.17-sync — Google Apps Script Bridge (FIXED + ENHANCED)
 * ----------------------------------------------------------------------------
 * Web App yang menjembatani addon RecallFox (Firefox) dengan:
 *   - Spreadsheet database (17 sheet) — ID hardcoded di bawah
 *   - Folder Google Drive untuk screenshot full image
 *   - Sheet "SyncState" untuk Multi-PC Sync (sync_state + get_state actions)
 *
 * === VERSI INI (v3.11.17-sync) ===
 * Update dari v3.10.0 (yang TIDAK support sync_state) ke versi yang support:
 *   - action 'sync_state' (Push state ke cloud via POST)
 *   - action 'get_state' (Pull state dari cloud via GET)
 *   - Sheet 'SyncState' auto-create di setup() + on-demand di _handleSyncState
 *   - Multiple profiles support (each profile = 1 row in SyncState)
 *
 * === FIXES v3.10.0 (Issue #1 dari troubleshooting Sesi 1 batch 2) ===
 * 1. Update version string ke v3.10.0 supaya konsisten dengan addon
 * 2. Tambah handler 'rebuild_all' — re-sync SEMUA item dari vault
 *    (berguna kalau user enable sync setelah punya banyak item existing)
 * 3. Tambah handler 'ping_verbose' — return info lebih detail untuk debug
 * 4. Fix: handler 'full_backup' sekarang return error deskriptif kalau
 *    data.vault kosong (sebelumnya return generic NO_VAULT)
 *
 * === FIXES v3.8.1 (Issue #1, #2 dari troubleshooting doc awal) ===
 * 1. Fix bug "berhasil terkirim 1 tapi spreadsheet kosong":
 *    - Sebelumnya: handler _handleSave memanggil _json() yang return ContentService
 *      TAPI ketika dipanggil dari batch/full_backup, hasilnya tidak dipakai dengan benar.
 *    - Sekarang: setiap handler return object biasa, dibungkus ContentService di akhir.
 * 2. Fix bug upsert: cari existing row dengan benar (sebelumnya off-by-one karena
 *    dataRange dimulai dari baris 4 tapi di-iterate dengan index 0).
 * 3. Fix bug serialize: boolean & object sekarang diserialize konsisten.
 * 4. Tambah logging ke sheet "00_SyncLog" untuk transparansi (user tahu apa yang
 *    terkirim, ke sheet mana, status sukses/gagal).
 * 5. Tambah endpoint /ping untuk health check yang lebih informatif.
 *
 * DEPLOY:
 *   1. Buka https://script.google.com → New Project (atau project yang sudah ada)
 *   2. Tempel seluruh isi file ini (overwrite Code.gs default)
 *   3. Run fungsi `setup` sekali untuk inisialisasi (buat sheet 00_SyncLog kalau belum ada)
 *   4. Deploy → New deployment → Type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   5. Salin Web App URL → tempel di Settings RecallFox → Google Drive Sync
 *
 * SETUP INSTRUKSI (untuk user pemula — lihat juga panduan di addon):
 *   1. Buat Spreadsheet baru di sheets.google.com
 *   2. Dari Spreadsheet: Extensions → Apps Script
 *   3. Hapus kode default, paste isi file ini
 *   4. Ganti SPREADSHEET_ID dengan ID Spreadsheet Anda (dari URL)
 *   5. Ganti AUTH_TOKEN dengan token yang di-generate di addon (klik 🎲 Generate)
 *   6. Run fungsi `setup` (accept permissions)
 *   7. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone
 *   8. Copy URL Web App (ends with /exec), paste ke addon
 *   9. Klik "Test Koneksi" di addon — harus "✅ Terhubung!"
 *  10. Klik "Full Backup ke GDrive" untuk kirim semua data existing
 * ============================================================================
 */

// ============================== CONFIG ==============================
// Hardcoded sesuai link yang user berikan di sesi sebelumnya.
var CONFIG = {
  SPREADSHEET_ID: '19fI4oi__6y3Ed76cHBI6Z4_tbu8-VYt7jD4oDpbZk6c',
  SCREENSHOT_FOLDER_ID: '1zlgyDJLwphfJ56d0JIyet9rvVXIiyMXe',
  // Token rahasia — generate via fungsi generateToken() lalu update di sini
  AUTH_TOKEN: 'RECALLFOX_TOKEN_GANTI_DENGAN_STRING_ACAK_32_CHAR',
  MAX_INLINE_THUMBNAIL_BYTES: 2048,
  // Sheet untuk logging semua operasi sync ( transparansi Issue #2)
  SYNC_LOG_SHEET: '00_SyncLog',
  SHEETS: {
    PROMPTS:        '02_Prompts',
    KONTEKS:        '03_Konteks',
    LINKS:          '04_Links',
    BUNDLES:        '05_Bundles',
    SNAPSHOTS:      '06_Snapshots',
    SCREENSHOTS:    '07_Screenshots',
    CATATAN:        '08_Catatan',
    TOPPINGS:       '09_Toppings',
    ASSISTANT_CHAT: '10_AssistantChat',
    HABITS_LOG:     '11_HabitsLog',
    PRAYER_TIMES:   '12_PrayerTimes',
    VOLUME:         '13_VolumeSettings',
    BLOCKLIST:      '14_Blocklist',
    SETTINGS:       '15_Settings',
    BACKUP_LOG:     '16_BackupLog',
    SYNC_META:      '17_SyncMeta'
  }
};

// Sheet schema — primary key untuk upsert + urutan kolom (HARUS match header baris 1)
var SHEET_SCHEMA = {
  '02_Prompts': {
    primaryKeys: ['id'],
    columns: ['id','type','title','body','tags','category','variables','toppings','source','favorite','archived','useCount','lastUsedAt','createdAt','updatedAt']
  },
  '03_Konteks': {
    primaryKeys: ['id'],
    columns: ['id','type','title','body','tags','category','source','favorite','archived','useCount','lastUsedAt','createdAt','updatedAt']
  },
  '04_Links': {
    primaryKeys: ['id'],
    columns: ['id','type','title','linkUrl','linkTitle','body','tags','category','source','favorite','archived','useCount','lastUsedAt','createdAt','updatedAt']
  },
  '05_Bundles': {
    primaryKeys: ['id'],
    columns: ['id','name','itemIds','injectOrder','noteIds','color','note','inlinePrompt','inlinePromptItemId','archived','createdAt','updatedAt']
  },
  '06_Snapshots': {
    primaryKeys: ['id'],
    columns: ['id','type','title','body','source','snapshotDomain','snapshotMessageCount','tags','category','favorite','archived','useCount','lastUsedAt','createdAt','updatedAt']
  },
  '07_Screenshots': {
    primaryKeys: ['id'],
    columns: ['id','type','title','source','screenshotMode','screenshotWidth','screenshotHeight','screenshotFormat','screenshotBytes','thumbnailDataUrl','gdriveFileId','gdriveFileUrl','tags','category','favorite','archived','useCount','lastUsedAt','createdAt','updatedAt']
  },
  '08_Catatan': {
    primaryKeys: ['id'],
    columns: ['id','title','body','color','group','pinned','archived','createdAt','updatedAt']
  },
  '09_Toppings': {
    primaryKeys: ['id'],
    columns: ['id','name','emoji','description','body','builtIn','createdAt','updatedAt']
  },
  '10_AssistantChat': {
    primaryKeys: ['messageId'],
    columns: ['messageId','role','content','provider','model','usedFallback','primaryError','tokenCount','timestamp','sessionId']
  },
  '11_HabitsLog': {
    primaryKeys: ['date','habitType'],
    columns: ['date','habitType','count','target','isComplete','streakAtDate','note','recordedAt']
  },
  '12_PrayerTimes': {
    primaryKeys: ['date'],
    columns: ['date','hijri','location','latitude','longitude','Fajr','Sunrise','Dhuhr','Asr','Maghrib','Isha','Imsak','Midnight','Firstthird','Lastthird','Ishraq','Dhuha','Awwabin','Tahajud','Witir','timezone','method','fetchedAt']
  },
  '13_VolumeSettings': {
    primaryKeys: ['scope','domain'],
    columns: ['scope','domain','volumeDb','volumePercent','isBoost','isMuted','updatedAt']
  },
  '14_Blocklist': {
    primaryKeys: ['id'],
    columns: ['id','source','type','value','altValue','domain','selectors','blockDomains','blockPopups','isPreset','enabled','addedAt','sourceContext']
  },
  '15_Settings': {
    primaryKeys: ['snapshotAt','settingKey'],
    columns: ['snapshotAt','settingKey','settingValue','settingType','category','defaultValue','notes']
  },
  '16_BackupLog': {
    primaryKeys: ['backupAt','backupType'],
    columns: ['backupAt','backupType','filename','backupPath','vaultItemsCount','notesCount','bundlesCount','screenshotBlobsCount','hasHabits','hasAssistantChat','hasVolumeSettings','quranStreak','exerciseTotalDays','addonVersion','downloadId','lastRestoreAt']
  },
  '17_SyncMeta': {
    primaryKeys: ['pushedAt'],
    columns: ['pushedAt','totalChunks','hashSha256','vaultVersion','addonVersion','vaultItemsCount','vaultSizeBytes','syncDurationMs','status']
  }
};

// ============================== ENTRY POINTS ==============================

/**
 * GET /  → health check (informative untuk debugging Issue #2)
 */
function doGet(e) {
  // v3.11.7: Handle get_state action (untuk pull state dari cloud)
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'get_state') {
    // Verifikasi token
    var authHeader = '';
    if (e && e.headers) {
      authHeader = e.headers.Authorization || e.headers.authorization || '';
    }
    var bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    var token = '';
    if (bearerMatch) {
      token = bearerMatch[1];
    } else if (e && e.parameter && e.parameter.token) {
      token = e.parameter.token;
    }
    if (token !== CONFIG.AUTH_TOKEN) {
      return _jsonOut({ ok: false, error: 'INVALID_TOKEN', detail: 'Token mismatch. Expected AUTH_TOKEN, got: ' + token.slice(0, 8) + '...' });
    }
    var data = { profile: e.parameter.profile || 'default' };
    return _jsonOut(_handleGetState(data));
  }
  if (action === 'ping') {
    return _jsonOut({ ok: true, pong: true, time: new Date().toISOString(), service: 'RecallFox GDrive Bridge v3.11.17-sync', version: '3.11.17-sync' });
  }

  var info = {
    ok: true,
    service: 'RecallFox GDrive Bridge',
    version: '3.11.17-sync',
    time: new Date().toISOString(),
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    screenshotFolderId: CONFIG.SCREENSHOT_FOLDER_ID,
    sheetsConfigured: Object.keys(CONFIG.SHEETS).length,
    authRequired: true
  };
  // Verifikasi spreadsheet dapat diakses
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    info.spreadsheetName = ss.getName();
    info.sheetCount = ss.getSheets().length;
    info.sheetNames = ss.getSheets().map(function(s) { return s.getName(); });
  } catch (err) {
    info.spreadsheetError = err.message;
  }
  // Verifikasi folder dapat diakses
  try {
    var folder = DriveApp.getFolderById(CONFIG.SCREENSHOT_FOLDER_ID);
    info.folderName = folder.getName();
  } catch (err) {
    info.folderError = err.message;
  }
  return _jsonOut(info);
}

/**
 * POST /  → router utama.
 */
function doPost(e) {
  var startTime = Date.now();
  var result;
  var action = 'unknown';
  var tokenOk = false;
  try {
    // Parse body
    var parsed = _parseBody(e);
    action = parsed.action || (e.parameter && e.parameter.action) || 'unknown';
    tokenOk = (parsed.token === CONFIG.AUTH_TOKEN) || ((e.parameter && e.parameter.token) === CONFIG.AUTH_TOKEN);

    if (!tokenOk) {
      _logSync(action, 'UNAUTHORIZED', 'Token mismatch', 0, Date.now() - startTime);
      return _jsonOut({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }
    if (!action) {
      return _jsonOut({ ok: false, error: 'NO_ACTION' }, 400);
    }

    // Handle screenshot upload — support DUA format:
    //   1. multipart/form-data (legacy, via FormData — RUSAK di Firefox MV3)
    //   2. JSON+base64 (v3.11.20 fix — reliable, sama seperti sync_state)
    if (action === 'upload_screenshot') {
      if (e.postData && e.postData.type &&
          e.postData.type.indexOf('multipart/form-data') >= 0) {
        // Legacy multipart path (untuk backward compat)
        result = _handleUploadScreenshot(e);
      } else if (parsed && parsed.base64Data) {
        // v3.11.20: JSON+base64 path (FIX untuk Firefox MV3)
        result = _handleUploadScreenshotJson(parsed);
      } else {
        result = { ok: false, error: 'INVALID_UPLOAD_FORMAT', detail: 'Expected multipart/form-data or JSON with base64Data' };
      }
    } else {
      // Handle JSON actions
      result = _dispatchAction(action, parsed);
    }

    // Log success
    var duration = Date.now() - startTime;
    _logSync(action, result.ok ? 'OK' : 'ERROR',
             result.ok ? '' : (result.error || ''), 1, duration);

    return _jsonOut(result);
  } catch (err) {
    console.error('doPost error:', err);
    _logSync(action, 'EXCEPTION', err.message, 0, Date.now() - startTime);
    return _jsonOut({ ok: false, error: 'INTERNAL', detail: err.message, stack: err.stack }, 500);
  }
}

// ============================== DISPATCHER ==============================

function _dispatchAction(action, data) {
  switch (action) {
    // Single-item saves
    case 'save_prompt':       return _handleSave(CONFIG.SHEETS.PROMPTS, data);
    case 'save_konteks':      return _handleSave(CONFIG.SHEETS.KONTEKS, data);
    case 'save_link':         return _handleSave(CONFIG.SHEETS.LINKS, data);
    case 'save_bundle':       return _handleSave(CONFIG.SHEETS.BUNDLES, data);
    case 'save_snapshot':     return _handleSave(CONFIG.SHEETS.SNAPSHOTS, data);
    case 'save_screenshot':   return _handleSave(CONFIG.SHEETS.SCREENSHOTS, data);
    case 'save_catatan':      return _handleSave(CONFIG.SHEETS.CATATAN, data);
    case 'save_topping':      return _handleSave(CONFIG.SHEETS.TOPPINGS, data);
    case 'save_assistant_msg':return _handleSave(CONFIG.SHEETS.ASSISTANT_CHAT, data);
    case 'save_habit':        return _handleSave(CONFIG.SHEETS.HABITS_LOG, data);
    case 'save_prayer':       return _handleSave(CONFIG.SHEETS.PRAYER_TIMES, data);
    case 'save_volume':       return _handleSave(CONFIG.SHEETS.VOLUME, data);
    case 'save_blocklist':    return _handleSave(CONFIG.SHEETS.BLOCKLIST, data);
    case 'save_setting':      return _handleSave(CONFIG.SHEETS.SETTINGS, data);
    case 'save_backup_log':   return _handleSave(CONFIG.SHEETS.BACKUP_LOG, data);
    case 'save_sync_meta':    return _handleSave(CONFIG.SHEETS.SYNC_META, data);
    // Deletes
    case 'delete_prompt':       return _handleDelete(CONFIG.SHEETS.PROMPTS, data);
    case 'delete_konteks':      return _handleDelete(CONFIG.SHEETS.KONTEKS, data);
    case 'delete_link':         return _handleDelete(CONFIG.SHEETS.LINKS, data);
    case 'delete_bundle':       return _handleDelete(CONFIG.SHEETS.BUNDLES, data);
    case 'delete_snapshot':     return _handleDelete(CONFIG.SHEETS.SNAPSHOTS, data);
    case 'delete_screenshot':   return _handleDelete(CONFIG.SHEETS.SCREENSHOTS, data);
    case 'delete_catatan':      return _handleDelete(CONFIG.SHEETS.CATATAN, data);
    case 'delete_topping':      return _handleDelete(CONFIG.SHEETS.TOPPINGS, data);
    case 'delete_blocklist':    return _handleDelete(CONFIG.SHEETS.BLOCKLIST, data);
    // Special
    case 'batch_settings':     return _handleBatchSettings(data);
    case 'batch_habits':       return _handleBatchHabits(data);
    case 'batch_volume':       return _handleBatchVolume(data);
    case 'full_backup':        return _handleFullBackup(data);
    case 'batch':              return _handleBatch(data);
    // v3.11.7: Multi-PC bidirectional sync — push full state as JSON blob
    case 'sync_state':         return _handleSyncState(data);
    case 'ping':               return { ok: true, pong: true, time: new Date().toISOString(), service: 'RecallFox GDrive Bridge v3.11.17-sync', version: '3.11.17-sync' };
    default:                   return { ok: false, error: 'UNKNOWN_ACTION', action: action };
  }
}

// ============================== v3.11.7: SYNC STATE (Multi-PC) ==============================

/**
 * Handle sync_state action — upload full state as JSON blob ke sheet "SyncState".
 * Multiple profiles supported: each profile = 1 row in SyncState sheet.
 *
 * Payload:
 *   { action: 'sync_state', token, profile: 'Kantor', deviceId, deviceName, payload: {...} }
 *
 * Returns:
 *   { ok: true, updatedAt, profile, deviceId }
 */
function _handleSyncState(data) {
  try {
    if (!data || !data.payload) {
      console.error('_handleSyncState: NO_PAYLOAD, data keys =', data ? Object.keys(data) : 'null');
      return { ok: false, error: 'NO_PAYLOAD' };
    }
    var profileName = data.profile || 'default';
    var deviceId = data.deviceId || 'unknown';
    var deviceName = data.deviceName || 'unknown';
    var payload = data.payload;

    console.log('_handleSyncState: profile=' + profileName + ', device=' + deviceName + ', payload keys=' + Object.keys(payload).join(','));

    // Validate payload size (Apps Script limit ~50MB, tapi praktis <5MB)
    var payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 10 * 1024 * 1024) {  // 10MB limit
      return { ok: false, error: 'PAYLOAD_TOO_LARGE', size: payloadStr.length };
    }
    console.log('_handleSyncState: payload size = ' + payloadStr.length + ' bytes');

    var ss = _getSpreadsheet();
    if (!ss) {
      console.error('_handleSyncState: Cannot access spreadsheet');
      return { ok: false, error: 'SPREADSHEET_ACCESS_FAILED' };
    }
    var sheet = ss.getSheetByName('SyncState');
    if (!sheet) {
      console.log('_handleSyncState: Creating SyncState sheet...');
      sheet = ss.insertSheet('SyncState');
      sheet.appendRow(['profile', 'deviceId', 'deviceName', 'payload', 'updatedAt', 'payloadSize']);
      sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // Cari existing row by profile name
    var lastRow = sheet.getLastRow();
    var existingRow = -1;
    if (lastRow > 1) {
      var profileCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < profileCol.length; i++) {
        if (profileCol[i][0] === profileName) {
          existingRow = i + 2;  // +2 karena header di baris 1, index dimulai dari 0
          break;
        }
      }
    }

    var updatedAt = new Date().toISOString();
    var rowData = [profileName, deviceId, deviceName, payloadStr, updatedAt, payloadStr.length];

    if (existingRow > 0) {
      // Update existing row
      sheet.getRange(existingRow, 1, 1, 6).setValues([rowData]);
    } else {
      // Append new row
      sheet.appendRow(rowData);
    }

    // Auto-resize kolom profile
    sheet.autoResizeColumn(1);

    console.log('SyncState saved: profile=' + profileName + ', device=' + deviceName + ', size=' + payloadStr.length + ' bytes');

    return {
      ok: true,
      updatedAt: updatedAt,
      profile: profileName,
      deviceId: deviceId,
      payloadSize: payloadStr.length
    };
  } catch (err) {
    console.error('_handleSyncState ERROR: ' + err.message + '\nStack: ' + err.stack);
    return { ok: false, error: 'SYNC_STATE_FAILED', detail: err.message, stack: err.stack };
  }
}

/**
 * Handle get_state action — return latest state untuk profile tertentu.
 * Dipanggil via GET: ?action=get_state&profile=Kantor
 *
 * Returns:
 *   { ok: true, payload: {...}, updatedAt, deviceName } ATAU { ok: false, error: 'NO_STATE' }
 */
function _handleGetState(data) {
  var profileName = (data && data.profile) || 'default';

  var ss = _getSpreadsheet();
  var sheet = ss.getSheetByName('SyncState');
  if (!sheet) {
    return { ok: false, error: 'NO_SYNC_STATE_SHEET' };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { ok: false, error: 'NO_STATE', profile: profileName };
  }

  // Cari row by profile name
  var profileCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var foundRow = -1;
  for (var i = 0; i < profileCol.length; i++) {
    if (profileCol[i][0] === profileName) {
      foundRow = i + 2;
      break;
    }
  }

  if (foundRow < 0) {
    return { ok: false, error: 'PROFILE_NOT_FOUND', profile: profileName };
  }

  // Ambil payload + metadata
  var rowData = sheet.getRange(foundRow, 1, 1, 6).getValues()[0];
  var profileNameFromSheet = rowData[0];
  var deviceId = rowData[1];
  var deviceName = rowData[2];
  var payloadStr = rowData[3];
  var updatedAt = rowData[4];
  var payloadSize = rowData[5];

  if (!payloadStr) {
    return { ok: false, error: 'EMPTY_PAYLOAD', profile: profileName };
  }

  var payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    return { ok: false, error: 'PAYLOAD_PARSE_ERROR', detail: e.message };
  }

  return {
    ok: true,
    payload: payload,
    updatedAt: updatedAt,
    deviceId: deviceId,
    deviceName: deviceName,
    profile: profileNameFromSheet,
    payloadSize: payloadSize
  };
}

// ============================== BODY PARSING ==============================

function _parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  var ct = (e.postData.type || '').toLowerCase();
  // Coba JSON dulu
  if (ct.indexOf('application/json') >= 0 || e.postData.contents.charAt(0) === '{') {
    try { return JSON.parse(e.postData.contents); }
    catch (err) { return {}; }
  }
  // Form-encoded
  if (ct.indexOf('application/x-www-form-urlencoded') >= 0) {
    var out = {};
    var pairs = e.postData.contents.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('=');
      if (eq < 0) continue;
      var k = decodeURIComponent(pairs[i].substring(0, eq));
      var v = decodeURIComponent(pairs[i].substring(eq + 1));
      out[k] = v;
    }
    return out;
  }
  // Fallback: coba JSON
  try { return JSON.parse(e.postData.contents); }
  catch (err) { return {}; }
}

// ============================== UPDERT (FIXED) ==============================

/**
 * Upsert: cari baris berdasarkan primary key, update kalau ada, append kalau tidak.
 * FIX v3.8.1: Sekarang return object biasa (bukan ContentService), dibungkus di akhir.
 * FIX: iterasi benar (data mulai baris 4, index dimulai dari 0 = baris 4).
 */
function _handleSave(sheetName, data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'NO_DATA' };
  }
  var schema = SHEET_SCHEMA[sheetName];
  if (!schema) {
    return { ok: false, error: 'NO_SCHEMA', sheet: sheetName };
  }
  // Validasi PK
  var pks = schema.primaryKeys;
  for (var i = 0; i < pks.length; i++) {
    var v = data[pks[i]];
    if (v === undefined || v === null || v === '') {
      return { ok: false, error: 'MISSING_PK', field: pks[i] };
    }
  }

  var sh = _getSheet(sheetName);
  if (!sh) return { ok: false, error: 'SHEET_NOT_FOUND', sheet: sheetName };

  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), schema.columns.length);

  // Baca header dari baris 1 (atau pakai schema.columns kalau sheet kosong)
  var header;
  if (lastRow >= 1) {
    header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  } else {
    header = schema.columns;
    // Tulis header kalau kosong
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    lastRow = 1;
  }

  // Build rowValues sesuai urutan header
  var rowValues = [];
  for (var c = 0; c < header.length; c++) {
    var colName = header[c];
    var val = data[colName];
    rowValues.push(_serialize(val));
  }

  // Cari existing row
  var pkIndices = pks.map(function(pk) { return header.indexOf(pk); });
  // Kalau ada PK yang tidak ada di header, append kolom baru
  for (var k = 0; k < pks.length; k++) {
    if (pkIndices[k] < 0) {
      // Tambah kolom baru di akhir
      sh.getRange(1, lastCol + 1).setValue(pks[k]);
      header.push(pks[k]);
      pkIndices[k] = header.length - 1;
      rowValues.push(_serialize(data[pks[k]]));
      lastCol++;
    }
  }

  var existingRowIdx = -1;
  if (lastRow >= 4) {
    // Baca data dari baris 4 sampai lastRow (data mulai baris 4: baris 1=header, 2=tipe, 3=desc)
    var dataRange = sh.getRange(4, 1, lastRow - 3, lastCol);
    var allValues = dataRange.getValues();
    for (var r = 0; r < allValues.length; r++) {
      var row = allValues[r];
      var match = true;
      for (var kk = 0; kk < pks.length; kk++) {
        var cellVal = row[pkIndices[kk]];
        var dataVal = data[pks[kk]];
        if (String(cellVal) !== _serialize(dataVal)) {
          match = false;
          break;
        }
      }
      if (match) {
        existingRowIdx = r + 4; // +4 karena r dimulai dari 0 = baris 4
        break;
      }
    }
  }

  if (existingRowIdx > 0) {
    // Update
    sh.getRange(existingRowIdx, 1, 1, rowValues.length).setValues([rowValues]);
    return { ok: true, action: 'update', sheet: sheetName, row: existingRowIdx, pks: _extractPks(data, pks) };
  } else {
    // Append di baris terakhir
    sh.appendRow(rowValues);
    return { ok: true, action: 'insert', sheet: sheetName, row: lastRow + 1, pks: _extractPks(data, pks) };
  }
}

function _extractPks(data, pks) {
  var out = {};
  for (var i = 0; i < pks.length; i++) out[pks[i]] = data[pks[i]];
  return out;
}

/**
 * Delete: cari baris berdasarkan PK, hapus barisnya (shift up).
 */
function _handleDelete(sheetName, data) {
  if (!data) return { ok: false, error: 'NO_DATA' };
  var schema = SHEET_SCHEMA[sheetName];
  if (!schema) return { ok: false, error: 'NO_SCHEMA' };
  var pks = schema.primaryKeys;
  for (var i = 0; i < pks.length; i++) {
    if (data[pks[i]] === undefined || data[pks[i]] === null || data[pks[i]] === '') {
      return { ok: false, error: 'MISSING_PK', field: pks[i] };
    }
  }

  var sh = _getSheet(sheetName);
  if (!sh) return { ok: false, error: 'SHEET_NOT_FOUND', sheet: sheetName };
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 4) return { ok: true, action: 'noop', reason: 'empty_sheet' };

  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var pkIndices = pks.map(function(pk) { return header.indexOf(pk); });

  var dataRange = sh.getRange(4, 1, lastRow - 3, lastCol);
  var allValues = dataRange.getValues();
  var deletedCount = 0;
  // Hapus dari bawah ke atas
  for (var r = allValues.length - 1; r >= 0; r--) {
    var row = allValues[r];
    var match = true;
    for (var k = 0; k < pks.length; k++) {
      if (String(row[pkIndices[k]]) !== _serialize(data[pks[k]])) {
        match = false;
        break;
      }
    }
    if (match) {
      sh.deleteRow(r + 4);
      deletedCount++;
    }
  }
  return { ok: true, action: 'delete', sheet: sheetName, deleted: deletedCount };
}

// ============================== SCREENSHOT UPLOAD ==============================

function _handleUploadScreenshot(e) {
  try {
    var postData = e.postData;
    if (!postData || !postData.contents) {
      return { ok: false, error: 'NO_POST_DATA' };
    }
    var parts = _parseMultipart(postData.contents, postData.type);
    var metadata = parts.metadata ? JSON.parse(parts.metadata) : {};
    var fileBlob = parts.file;
    if (!fileBlob) {
      return { ok: false, error: 'NO_FILE_BLOB' };
    }
    var token = metadata.token || parts.token;
    if (token !== CONFIG.AUTH_TOKEN) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }
    if (!metadata.id) {
      return { ok: false, error: 'NO_SCREENSHOT_ID' };
    }

    var folder = DriveApp.getFolderById(CONFIG.SCREENSHOT_FOLDER_ID);
    var safeTitle = (metadata.title || 'screenshot').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
    var ext = (metadata.screenshotFormat || 'png').toLowerCase();
    var fileName = 'rf_' + metadata.id + '_' + safeTitle + '.' + ext;

    // Hapus file lama dengan nama sama
    var existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      var oldFile = existing.next();
      oldFile.setTrashed(true);
    }

    var contentTypeFile = (ext === 'jpeg' || ext === 'jpg') ? 'image/jpeg' : 'image/png';
    var newFile = folder.createFile(fileBlob.setName(fileName).setContentType(contentTypeFile));
    var fileId = newFile.getId();
    var fileUrl = newFile.getUrl();
    var fileSize = newFile.getSize();

    // Build sheet row
    var sheetData = {
      id: metadata.id,
      type: 'screenshot',
      title: metadata.title || ('Screenshot — ' + new Date().toISOString()),
      source: _serialize(metadata.source || null),
      screenshotMode: metadata.screenshotMode || 'visible',
      screenshotWidth: metadata.screenshotWidth || 0,
      screenshotHeight: metadata.screenshotHeight || 0,
      screenshotFormat: metadata.screenshotFormat || 'png',
      screenshotBytes: fileSize,
      thumbnailDataUrl: metadata.thumbnailDataUrl || '',
      gdriveFileId: fileId,
      gdriveFileUrl: fileUrl,
      tags: _serialize(metadata.tags || []),
      category: metadata.category || '',
      favorite: metadata.favorite || false,
      archived: metadata.archived || false,
      useCount: metadata.useCount || 0,
      lastUsedAt: metadata.lastUsedAt || null,
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    var saveResult = _handleSave(CONFIG.SHEETS.SCREENSHOTS, sheetData);
    return {
      ok: true,
      screenshotId: metadata.id,
      gdriveFileId: fileId,
      gdriveFileUrl: fileUrl,
      fileSize: fileSize,
      fileName: fileName,
      sheet: saveResult
    };
  } catch (err) {
    console.error('Upload screenshot error:', err);
    return { ok: false, error: 'UPLOAD_FAILED', detail: err.message };
  }
}

// v3.11.20: Handle upload_screenshot via JSON+base64 (FIX untuk Firefox MV3)
// Data: { action, token, metadata: {...}, mimeType, base64Data }
// Metadata fields sama dengan _handleUploadScreenshot.
function _handleUploadScreenshotJson(data) {
  try {
    if (!data) return { ok: false, error: 'NO_DATA' };
    if (!data.base64Data) return { ok: false, error: 'NO_BASE64_DATA' };
    if (!data.metadata) return { ok: false, error: 'NO_METADATA' };

    // Verify token
    var token = data.token || '';
    if (token !== CONFIG.AUTH_TOKEN) {
      return { ok: false, error: 'UNAUTHORIZED', detail: 'Token mismatch' };
    }

    var metadata = data.metadata;
    if (!metadata.id) return { ok: false, error: 'NO_SCREENSHOT_ID' };

    var mimeType = data.mimeType || 'image/png';
    var base64Data = data.base64Data;

    // Decode base64 → bytes → Blob
    var bytes = Utilities.base64Decode(base64Data);
    var fileBlob = Utilities.newBlob(bytes, mimeType, 'screenshot');

    // Get Drive folder
    var folder = DriveApp.getFolderById(CONFIG.SCREENSHOT_FOLDER_ID);
    var safeTitle = (metadata.title || 'screenshot').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
    var ext = (metadata.screenshotFormat || (mimeType === 'image/jpeg' ? 'jpeg' : 'png')).toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    var fileName = 'rf_' + metadata.id + '_' + safeTitle + '.' + ext;

    // Hapus file lama dengan nama sama (re-upload support)
    var existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      var oldFile = existing.next();
      oldFile.setTrashed(true);
    }

    // Create file di Drive
    fileBlob.setName(fileName);
    fileBlob.setContentType(mimeType);
    var newFile = folder.createFile(fileBlob);
    var fileId = newFile.getId();
    var fileUrl = newFile.getUrl();
    var fileSize = newFile.getSize();

    console.log('Screenshot uploaded (JSON+base64):', fileName, fileSize, 'bytes');

    // Build sheet row — same format with _handleUploadScreenshot
    var sheetData = {
      id: metadata.id,
      type: 'screenshot',
      title: metadata.title || ('Screenshot — ' + new Date().toISOString()),
      source: _serialize(metadata.source || null),
      screenshotMode: metadata.screenshotMode || 'visible',
      screenshotWidth: metadata.screenshotWidth || 0,
      screenshotHeight: metadata.screenshotHeight || 0,
      screenshotFormat: metadata.screenshotFormat || ext,
      screenshotBytes: fileSize,
      thumbnailDataUrl: metadata.thumbnailDataUrl || '',
      gdriveFileId: fileId,
      gdriveFileUrl: fileUrl,
      tags: _serialize(metadata.tags || []),
      category: metadata.category || '',
      favorite: metadata.favorite || false,
      archived: metadata.archived || false,
      useCount: metadata.useCount || 0,
      lastUsedAt: metadata.lastUsedAt || null,
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Upsert ke sheet 07_Screenshots
    var sheet = _getSheet(CONFIG.SHEETS.SCREENSHOTS);
    _upsertRow(sheet, sheetData, ['id']);

    return {
      ok: true,
      gdriveFileId: fileId,
      gdriveFileUrl: fileUrl,
      gdriveFileName: fileName,
      gdriveFileSize: fileSize
    };
  } catch (err) {
    console.error('Upload screenshot (JSON) error:', err);
    return { ok: false, error: 'UPLOAD_JSON_FAILED', detail: err.message };
  }
}

function _parseMultipart(contents, contentType) {
  var boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('NO_BOUNDARY_IN_CONTENT_TYPE');
  var boundary = boundaryMatch[1] || boundaryMatch[2];
  var rawBlob = Utilities.newBlob(contents);
  var rawBytes = rawBlob.getBytes();
  var boundaryBytes = Utilities.newBlob('--' + boundary).getBytes();
  var positions = [];
  for (var i = 0; i < rawBytes.length - boundaryBytes.length; i++) {
    var match = true;
    for (var j = 0; j < boundaryBytes.length; j++) {
      if (rawBytes[i + j] !== boundaryBytes[j]) { match = false; break; }
    }
    if (match) positions.push(i);
  }
  var parts = {};
  for (var p = 0; p < positions.length - 1; p++) {
    var start = positions[p] + boundaryBytes.length;
    while (start < rawBytes.length && (rawBytes[start] === 13 || rawBytes[start] === 10)) start++;
    var end = positions[p + 1];
    while (end > start && (rawBytes[end - 1] === 13 || rawBytes[end - 1] === 10)) end--;
    var partBytes = rawBytes.slice(start, end);
    var partBlob = Utilities.newBlob(partBytes);
    var partText = partBlob.getDataAsString();
    var headerEnd = partText.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    var headerStr = partText.substring(0, headerEnd);
    var bodyStartByte = start + headerEnd + 4;
    var nameMatch = headerStr.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    var fieldName = nameMatch[1];
    var filenameMatch = headerStr.match(/filename="([^"]*)"/i);
    var ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (filenameMatch) {
      var fileBytes = rawBytes.slice(bodyStartByte, end);
      var fileBlob = Utilities.newBlob(fileBytes);
      if (ctMatch) fileBlob.setContentType(ctMatch[1].trim());
      parts[fieldName] = fileBlob;
    } else {
      parts[fieldName] = partText.substring(headerEnd + 4);
    }
  }
  return parts;
}

// ============================== BATCH HANDLERS ==============================

function _handleBatchSettings(data) {
  if (!data || !data.settings) return { ok: false, error: 'NO_SETTINGS' };
  var snapshotAt = data.snapshotAt || new Date().toISOString();
  var settings = data.settings;
  var defaults = data.defaults || {};
  var categories = data.categories || {};
  var notes = data.notes || {};
  var rows = [];
  var count = 0;
  for (var key in settings) {
    if (!settings.hasOwnProperty(key)) continue;
    var val = settings[key];
    var settingType = typeof val === 'boolean' ? 'BOOLEAN'
                    : typeof val === 'number' ? 'NUMBER'
                    : (val && typeof val === 'object') ? 'JSON'
                    : 'STRING';
    rows.push([
      snapshotAt, key, _serialize(val), settingType,
      categories[key] || 'uncategorized',
      _serialize(defaults[key] || ''),
      notes[key] || ''
    ]);
    count++;
  }
  if (rows.length === 0) return { ok: true, inserted: 0 };
  var sh = _getSheet(CONFIG.SHEETS.SETTINGS);
  if (!sh) return { ok: false, error: 'SHEET_NOT_FOUND' };
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  return { ok: true, action: 'batch_settings', inserted: count, snapshotAt: snapshotAt };
}

function _handleBatchHabits(data) {
  if (!data) return { ok: false, error: 'NO_DATA' };
  var quranLog = data.quranLog || {};
  var exerciseLog = data.exerciseLog || {};
  var quranTarget = data.quranTargetPages || 1;
  var recordedAt = data.recordedAt || new Date().toISOString();
  var quranStreak = data.quranStreak || 0;
  var exerciseStreak = data.exerciseStreak || 0;
  var inserted = 0, updated = 0;
  for (var date in quranLog) {
    if (!quranLog.hasOwnProperty(date)) continue;
    var pages = quranLog[date];
    var r = _handleSave(CONFIG.SHEETS.HABITS_LOG, {
      date: date, habitType: 'quran', count: pages, target: quranTarget,
      isComplete: pages >= quranTarget, streakAtDate: quranStreak,
      note: '', recordedAt: recordedAt
    });
    if (r.action === 'insert') inserted++; else if (r.action === 'update') updated++;
  }
  for (var date2 in exerciseLog) {
    if (!exerciseLog.hasOwnProperty(date2)) continue;
    var sessions = exerciseLog[date2];
    var r2 = _handleSave(CONFIG.SHEETS.HABITS_LOG, {
      date: date2, habitType: 'exercise', count: sessions, target: 1,
      isComplete: sessions >= 1, streakAtDate: exerciseStreak,
      note: '', recordedAt: recordedAt
    });
    if (r2.action === 'insert') inserted++; else if (r2.action === 'update') updated++;
  }
  return { ok: true, action: 'batch_habits', inserted: inserted, updated: updated };
}

function _handleBatchVolume(data) {
  if (!data) return { ok: false, error: 'NO_DATA' };
  var sites = data.sites || {};
  var global = data.global !== undefined ? data.global : 0;
  var updatedAt = data.updatedAt || new Date().toISOString();
  var inserted = 0, updated = 0;
  var r0 = _handleSave(CONFIG.SHEETS.VOLUME, {
    scope: 'global', domain: '', volumeDb: global,
    volumePercent: _dbToPercent(global), isBoost: global > 0, isMuted: global <= -30,
    updatedAt: updatedAt
  });
  if (r0.action === 'insert') inserted++; else updated++;
  for (var domain in sites) {
    if (!sites.hasOwnProperty(domain)) continue;
    var dB = sites[domain];
    var r = _handleSave(CONFIG.SHEETS.VOLUME, {
      scope: 'site', domain: domain, volumeDb: dB,
      volumePercent: _dbToPercent(dB), isBoost: dB > 0, isMuted: dB <= -30,
      updatedAt: updatedAt
    });
    if (r.action === 'insert') inserted++; else updated++;
  }
  return { ok: true, action: 'batch_volume', inserted: inserted, updated: updated };
}

function _dbToPercent(dB) {
  var n = Number(dB);
  if (!isFinite(n)) n = 0;
  n = Math.max(-32, Math.min(32, Math.round(n)));
  return Math.round(Math.pow(10, n / 20) * 100);
}

function _handleFullBackup(data) {
  if (!data || !data.vault) return { ok: false, error: 'NO_VAULT' };
  var vault = data.vault;
  var exportedAt = data.exportedAt || new Date().toISOString();
  var addonVersion = data.addonVersion || 'unknown';
  var stats = { items: 0, notes: 0, bundles: 0, toppings: 0, screenshots: 0, habits: 0, settings: 0, assistantMsgs: 0, volume: 0 };
  var items = vault.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var sheetName;
    switch (item.type) {
      case 'prompt':    sheetName = CONFIG.SHEETS.PROMPTS; stats.items++; break;
      case 'context':   sheetName = CONFIG.SHEETS.KONTEKS; stats.items++; break;
      case 'link':      sheetName = CONFIG.SHEETS.LINKS; stats.items++; break;
      case 'snapshot':  sheetName = CONFIG.SHEETS.SNAPSHOTS; stats.items++; break;
      case 'screenshot':sheetName = CONFIG.SHEETS.SCREENSHOTS; stats.screenshots++; break;
      default:          sheetName = CONFIG.SHEETS.PROMPTS; stats.items++; break;
    }
    _handleSave(sheetName, item);
  }
  var bundles = vault.bundles || [];
  for (var b = 0; b < bundles.length; b++) {
    _handleSave(CONFIG.SHEETS.BUNDLES, bundles[b]);
    stats.bundles++;
  }
  var toppings = vault.toppings || [];
  for (var t = 0; t < toppings.length; t++) {
    _handleSave(CONFIG.SHEETS.TOPPINGS, toppings[t]);
    stats.toppings++;
  }
  var notes = data.notes || [];
  for (var n = 0; n < notes.length; n++) {
    _handleSave(CONFIG.SHEETS.CATATAN, notes[n]);
    stats.notes++;
  }
  if (data.habits) {
    _handleBatchHabits({
      quranLog: data.habits.quranLog || {},
      exerciseLog: data.habits.exerciseLog || {},
      quranTargetPages: vault.settings ? vault.settings.quranTargetPages : 1,
      quranStreak: data.meta ? data.meta.quranStreak : 0,
      exerciseStreak: 0, recordedAt: exportedAt
    });
    stats.habits = Object.keys(data.habits.quranLog || {}).length + Object.keys(data.habits.exerciseLog || {}).length;
  }
  if (data.assistantChat && data.assistantChat.messages) {
    var msgs = data.assistantChat.messages;
    var sessionId = 'session_' + exportedAt;
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      _handleSave(CONFIG.SHEETS.ASSISTANT_CHAT, {
        messageId: 'm_' + exportedAt + '_' + String(m).padStart(3, '0'),
        role: msg.role || 'user', content: msg.content || '',
        provider: msg.provider || (vault.settings ? vault.settings.assistantProvider : ''),
        model: msg.model || (vault.settings ? vault.settings.assistantModel : ''),
        usedFallback: msg.usedFallback || false,
        primaryError: msg.primaryError || '',
        tokenCount: msg.tokenCount || 0,
        timestamp: msg.timestamp || exportedAt,
        sessionId: msg.sessionId || sessionId
      });
      stats.assistantMsgs++;
    }
  }
  if (data.volumeSettings) {
    _handleBatchVolume({
      sites: data.volumeSettings.sites || {},
      global: data.volumeSettings.global || 0,
      updatedAt: exportedAt
    });
    stats.volume = Object.keys(data.volumeSettings.sites || {}).length + 1;
  }
  if (vault.settings) {
    _handleBatchSettings({
      snapshotAt: exportedAt,
      settings: vault.settings,
      defaults: {},
      categories: _categorizeSettings(vault.settings),
      notes: {}
    });
    stats.settings = Object.keys(vault.settings).length;
  }
  _handleSave(CONFIG.SHEETS.BACKUP_LOG, {
    backupAt: exportedAt,
    backupType: data.backupType || 'manual',
    filename: data.filename || '',
    backupPath: data.backupPath || '',
    vaultItemsCount: (vault.items || []).length,
    notesCount: (data.notes || []).length,
    bundlesCount: (vault.bundles || []).length,
    screenshotBlobsCount: data.screenshotBlobs ? Object.keys(data.screenshotBlobs).length : 0,
    hasHabits: !!data.habits,
    hasAssistantChat: !!data.assistantChat,
    hasVolumeSettings: !!data.volumeSettings,
    quranStreak: data.meta ? data.meta.quranStreak : 0,
    exerciseTotalDays: data.meta ? data.meta.exerciseTotalDays : 0,
    addonVersion: addonVersion,
    downloadId: '',
    lastRestoreAt: null
  });
  return { ok: true, action: 'full_backup', exportedAt: exportedAt, stats: stats };
}

function _handleBatch(data) {
  if (!data || !Array.isArray(data.ops)) return { ok: false, error: 'NO_OPS' };
  var results = [];
  var okCount = 0, errCount = 0;
  for (var i = 0; i < data.ops.length; i++) {
    var op = data.ops[i];
    try {
      var r = _dispatchAction(op.action, op.data || {});
      results.push({ i: i, action: op.action, ok: r.ok, action_detail: r.action, error: r.error });
      if (r.ok) okCount++; else errCount++;
    } catch (err) {
      results.push({ i: i, action: op.action, ok: false, error: err.message });
      errCount++;
    }
  }
  return { ok: errCount === 0, action: 'batch', total: data.ops.length, ok: okCount, error: errCount, results: results };
}

// ============================== HELPERS ==============================

function _jsonOut(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _serialize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  return String(value);
}

function _getSheet(name) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(name);
    return sh;
  } catch (e) {
    console.error('Cannot get sheet ' + name + ':', e.message);
    return null;
  }
}

function _categorizeSettings(s) {
  var map = {};
  for (var k in s) {
    if (k.indexOf('sync') === 0 || k === 'lastSyncAt') map[k] = 'sync';
    else if (k === 'theme' || k === 'displayMode' || k === 'injectMode' ||
             k === 'floatingButtonEnabled' || k === 'overlayButtonEnabled' ||
             k === 'sidebarAutoOpen' || k === 'rememberLastTab' || k === 'lastActiveTab' ||
             k === 'lastSidebarWidth' || k === 'showWelcomeOnFirstUse' || k === 'locale') map[k] = 'ui';
    else if (k.indexOf('assistant') === 0) map[k] = 'assistant';
    else if (k.indexOf('screenshot') === 0) map[k] = 'screenshot';
    else if (k.indexOf('clearCache') === 0) map[k] = 'clearcache';
    else if (k.indexOf('prayer') === 0) map[k] = 'prayer';
    else if (k.indexOf('quran') === 0) map[k] = 'quran';
    else if (k.indexOf('exercise') === 0) map[k] = 'exercise';
    else if (k.indexOf('elementBlocker') === 0) map[k] = 'element_blocker';
    else if (k.indexOf('autoDiscard') === 0) map[k] = 'auto_discard';
    else if (k.indexOf('backup') === 0 || k === 'lastBackupAt') map[k] = 'backup';
    else if (k.indexOf('contentGuard') === 0) map[k] = 'content_guard';
    else if (k.indexOf('gdrive') === 0) map[k] = 'gdrive';
    else map[k] = 'other';
  }
  return map;
}

// ============================== SYNC LOG (Issue #2 fix) ==============================

function _logSync(action, status, errorMsg, itemCount, durationMs) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.SYNC_LOG_SHEET);
    if (!sh) return; // Sheet belum dibuat — skip log
    sh.appendRow([
      new Date().toISOString(),
      action,
      status,
      errorMsg || '',
      itemCount || 0,
      durationMs || 0,
      Session.getActiveUser().getEmail() || ''
    ]);
  } catch (e) {
    // Silent fail — jangan block operasi utama
  }
}

// ============================== SETUP & TEST FUNCTIONS ==============================

/**
 * Run fungsi ini sekali untuk inisialisasi: buat sheet 00_SyncLog kalau belum ada.
 */
function setup() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SYNC_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SYNC_LOG_SHEET, 0); // insert di posisi pertama
    sh.getRange(1, 1, 1, 7).setValues([[
      'timestamp', 'action', 'status', 'error', 'itemCount', 'durationMs', 'user'
    ]]);
    // Bold header
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
    sh.setFrozenRows(1);
    Logger.log('✓ Sheet 00_SyncLog dibuat di posisi pertama');
  } else {
    Logger.log('✓ Sheet 00_SyncLog sudah ada');
  }
  // Verifikasi akses
  try {
    var folder = DriveApp.getFolderById(CONFIG.SCREENSHOT_FOLDER_ID);
    Logger.log('✓ Folder screenshot dapat diakses: ' + folder.getName());
  } catch (e) {
    Logger.log('✗ Folder screenshot TIDAK dapat diakses: ' + e.message);
  }

  // v3.11.17-sync: Buat sheet SyncState untuk Multi-PC Sync (sync_state + get_state)
  var syncSheet = ss.getSheetByName('SyncState');
  if (!syncSheet) {
    syncSheet = ss.insertSheet('SyncState');
    syncSheet.getRange(1, 1, 1, 7).setValues([[
      'profile', 'deviceId', 'deviceName', 'updatedAt', 'payloadSize', 'payload', 'createdAt'
    ]]);
    syncSheet.getRange(1, 1, 1, 7).setFontWeight('bold');
    syncSheet.setFrozenRows(1);
    Logger.log('✓ Sheet SyncState dibuat (untuk Multi-PC Sync)');
  } else {
    Logger.log('✓ Sheet SyncState sudah ada');
  }

  Logger.log('✓ Setup selesai. Spreadsheet: ' + ss.getName());
  Logger.log('✓ Jumlah sheet: ' + ss.getSheets().length);
  Logger.log('✓ AUTH_TOKEN saat ini: ' + CONFIG.AUTH_TOKEN);
  Logger.log('  → Ganti AUTH_TOKEN di atas dengan token baru (jalankan generateToken)');
}

/**
 * Run untuk test koneksi + list semua sheet.
 */
function testPing() {
  var url = ScriptApp.getService().url();
  Logger.log('Web App URL: ' + (url || 'BELUM DEPLOY — Deploy dulu via Deploy → New deployment → Web app'));
  Logger.log('Spreadsheet ID: ' + CONFIG.SPREADSHEET_ID);
  Logger.log('Screenshot Folder ID: ' + CONFIG.SCREENSHOT_FOLDER_ID);
  Logger.log('Auth Token: ' + CONFIG.AUTH_TOKEN);
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    Logger.log('Spreadsheet: ' + ss.getName());
    var sheets = ss.getSheets();
    Logger.log('Sheets (' + sheets.length + '):');
    for (var i = 0; i < sheets.length; i++) {
      Logger.log('  ' + (i + 1) + '. ' + sheets[i].getName() + ' (rows: ' + sheets[i].getLastRow() + ', cols: ' + sheets[i].getLastColumn() + ')');
    }
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
  }
  try {
    var folder = DriveApp.getFolderById(CONFIG.SCREENSHOT_FOLDER_ID);
    Logger.log('Folder: ' + folder.getName());
  } catch (e) {
    Logger.log('ERROR folder: ' + e.message);
  }
}

/**
 * Run untuk test insert 1 row ke sheet 08_Catatan.
 */
function testInsertCatatan() {
  var data = {
    id: 'n_test_' + Date.now(),
    title: 'Test dari Apps Script v3.8.1',
    body: 'Halo, ini catatan test dari Apps Script editor. Jika baris ini muncul di sheet 08_Catatan, berarti sync berfungsi.',
    color: 'yellow',
    group: 'Test',
    pinned: false,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  var r = _handleSave(CONFIG.SHEETS.CATATAN, data);
  Logger.log(JSON.stringify(r, null, 2));
  Logger.log('→ Cek sheet 08_Catatan di spreadsheet, harus ada 1 baris baru.');
  Logger.log('→ Cek sheet 00_SyncLog, harus ada 1 log entry dengan status OK.');
}

/**
 * Run untuk generate token acak.
 */
function generateToken() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var token = '';
  for (var i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  Logger.log('Token baru (copy ke CONFIG.AUTH_TOKEN di atas, HAPUS tanda kutip lalu paste):');
  Logger.log(token);
  Logger.log('---');
  Logger.log('Setelah update CONFIG.AUTH_TOKEN, Save (Ctrl+S) lalu Deploy ulang.');
}

/**
 * Run untuk clear sheet 00_SyncLog (jika terlalu penuh).
 */
function clearSyncLog() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SYNC_LOG_SHEET);
  if (!sh) {
    Logger.log('Sheet 00_SyncLog belum ada. Run setup() dulu.');
    return;
  }
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    Logger.log('✓ SyncLog direset (header tetap, data dibersihkan)');
  } else {
    Logger.log('SyncLog sudah kosong');
  }
}
