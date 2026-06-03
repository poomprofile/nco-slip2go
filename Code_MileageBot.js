// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — Mileage Bot Handler                           ║
// ║  Code_MileageBot.gs  (nco-slip2go project)                      ║
// ║  Called from Code_LineBot.gs when groupId === MILEAGE_GROUP_ID   ║
// ║  Bot NEVER replies to LINE under any circumstance                ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

var MB_VISION_URL  = 'https://vision.googleapis.com/v1/images:annotate';
var MB_SHEET_NAME  = 'Mileage';
var MB_MORN_HOUR   = 13;   // hour < 13 → morning, else evening (BKK)
var MB_MAX_KM      = 500;  // errorFlag threshold for long_dist

var MB_COLS = [
  'id', 'dsrEmail', 'date', 'session', 'rawMile', 'confirmedMile',
  'startMile', 'endMile', 'distance', 'vehicleId', 'vehicleType',
  'confidence', 'sourceFlag', 'errorFlag', 'errorMsg', 'pendingFill',
  'imageUrl', 'submitted', 'timestamp',
];

// ─────────────────────────────────────────────────────────────────────
//  ENTRY POINT
//  Called from Code_LineBot.gs handleEvent() when groupId === MILEAGE_GROUP_ID
//  Signature matches the routing call: handleMileageImage(msg.id, userId, groupId)
// ─────────────────────────────────────────────────────────────────────
function handleMileageImage(messageId, userId, groupId) {
  try {
    var dsr = mbLookupDsr(userId);
    if (!dsr) {
      console.log('[MileageBot] unknown lineUserId: ' + userId);
      return;
    }

    // Determine date + session from current BKK time
    var bkkDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    var dateStr = Utilities.formatDate(bkkDate, 'Asia/Bangkok', 'yyyy-MM-dd');
    var session = bkkDate.getHours() < MB_MORN_HOUR ? 'morning' : 'evening';

    // Download image — reuses fetchLineImage() from Code_LineBot.gs (same GAS project)
    var blob = fetchLineImage(messageId);

    var rawMile    = null;
    var confidence = 0;
    var sourceFlag = null;

    if (blob) {
      var visionText = mbCallVision(blob);
      if (visionText !== null) {
        rawMile    = mbParseOdometer(visionText);
        confidence = rawMile !== null ? 0.9 : 0;
      }
    }

    // Save photo to Drive (non-blocking; skipped if DRIVE_FOLDER_ID not set)
    var imageUrl = '';
    if (blob) {
      try { imageUrl = mbSaveToDrive(blob, dsr.dsrEmail, dateStr, session); }
      catch (e) { console.warn('[MileageBot] Drive save: ' + e.message); }
    }

    // Fallback logic — silent, no reply
    if (rawMile !== null) {
      sourceFlag = 'vision';
    } else if (session === 'morning') {
      // morning Vision fail → use previous day's evening confirmedMile
      var prevMile = mbGetPrevEveningConfirmed(dsr.dsrEmail, dateStr);
      if (prevMile !== null) { rawMile = prevMile; sourceFlag = 'prevDay'; }
    }
    // evening Vision fail → rawMile stays null, pendingFill = TRUE

    var confirmedMile = rawMile;
    var pendingFill   = (rawMile === null) ? 'TRUE' : 'FALSE';

    var startMile = '', endMile = '', distance = '';
    var morningMile = mbGetMorningConfirmed(dsr.dsrEmail, dateStr);

    if (session === 'morning') {
      startMile = (confirmedMile !== null) ? String(confirmedMile) : '';
    } else {
      startMile = (morningMile !== null) ? String(morningMile) : '';
      endMile   = (confirmedMile !== null) ? String(confirmedMile) : '';
      if (morningMile !== null && confirmedMile !== null) {
        distance = String(confirmedMile - morningMile);
      }
    }

    // Validation flags (note only — no reply)
    var errorFlag = '', errorMsg = '';
    if (session === 'evening') {
      if (morningMile === null) {
        errorFlag = 'no_morning';
        errorMsg  = 'ไม่มีไมล์เช้าสำหรับวันนี้';
      } else if (confirmedMile !== null && confirmedMile < morningMile) {
        errorFlag = 'eve<morn';
        errorMsg  = 'ไมล์เย็น (' + confirmedMile + ') น้อยกว่าไมล์เช้า (' + morningMile + ')';
      } else if (distance !== '' && parseFloat(distance) > MB_MAX_KM) {
        errorFlag = 'long_dist';
        errorMsg  = 'ระยะทาง ' + distance + ' กม. เกิน ' + MB_MAX_KM + ' กม.';
      }
    }

    var record = {
      id:            mbUuid(),
      dsrEmail:      dsr.dsrEmail,
      date:          dateStr,
      session:       session,
      rawMile:       (rawMile !== null) ? String(rawMile) : '',
      confirmedMile: (confirmedMile !== null) ? String(confirmedMile) : '',
      startMile:     startMile,
      endMile:       endMile,
      distance:      distance,
      vehicleId:     dsr.vehicleId || '',
      vehicleType:   dsr.defaultVehicleType || 'company',
      confidence:    String(confidence),
      sourceFlag:    sourceFlag || '',
      errorFlag:     errorFlag,
      errorMsg:      errorMsg,
      pendingFill:   pendingFill,
      imageUrl:      imageUrl,
      submitted:     'FALSE',
      timestamp:     mbTs(),
    };

    mbUpsertRecord(record, dsr.dsrEmail, dateStr, session);

    console.log('[MileageBot] saved email=%s date=%s session=%s rawMile=%s src=%s err=%s',
      dsr.dsrEmail, dateStr, session, rawMile, sourceFlag, errorFlag);

  } catch (err) {
    console.error('[MileageBot] handleMileageImage: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  GOOGLE VISION API
// ─────────────────────────────────────────────────────────────────────
function mbCallVision(blob) {
  var apiKey = mbProp('GOOGLE_VISION_API_KEY');
  if (!apiKey) { console.warn('[MileageBot] GOOGLE_VISION_API_KEY not set'); return null; }
  try {
    var b64     = Utilities.base64Encode(blob.getBytes());
    var payload = JSON.stringify({
      requests: [{ image: { content: b64 }, features: [{ type: 'TEXT_DETECTION' }] }],
    });
    var res = UrlFetchApp.fetch(MB_VISION_URL + '?key=' + apiKey, {
      method: 'post', contentType: 'application/json',
      payload: payload, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      console.warn('[MileageBot] Vision API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
      return null;
    }
    var body = JSON.parse(res.getContentText());
    var ann  = body.responses && body.responses[0] && body.responses[0].textAnnotations;
    if (!ann || !ann.length) return null;
    return ann[0].description || '';
  } catch (err) {
    console.error('[MileageBot] mbCallVision: ' + err.message);
    return null;
  }
}

// Extract odometer: largest 5-6 digit number
// Ignores temperature (2 digits), time (has colon), trip meter (3-4 digits)
function mbParseOdometer(fullText) {
  if (!fullText) return null;
  var cleaned  = fullText.replace(/,/g, '').replace(/\./g, '');
  var matches  = cleaned.match(/\b\d{5,6}\b/g);
  if (!matches || !matches.length) return null;
  var candidates = matches.map(Number).filter(function(n) { return n >= 10000 && n <= 999999; });
  if (!candidates.length) return null;
  return Math.max.apply(null, candidates);
}

// ─────────────────────────────────────────────────────────────────────
//  GOOGLE DRIVE — SAVE ODOMETER PHOTO
// ─────────────────────────────────────────────────────────────────────
function mbSaveToDrive(blob, dsrEmail, dateStr, session) {
  var folderId = mbProp('DRIVE_FOLDER_ID');
  if (!folderId) return '';
  var root   = DriveApp.getFolderById(folderId);
  var subs   = root.getFoldersByName('MileagePhotos');
  var folder = subs.hasNext() ? subs.next() : root.createFolder('MileagePhotos');
  var fname  = dsrEmail.split('@')[0] + '_' + dateStr + '_' + session + '.jpg';
  blob.setName(fname);
  blob.setContentType('image/jpeg');
  return folder.createFile(blob).getUrl();
}

// ─────────────────────────────────────────────────────────────────────
//  DSR LOOKUP — by LINE userId → SPREADSHEET_ID USERS sheet
// ─────────────────────────────────────────────────────────────────────
function mbLookupDsr(lineUserId) {
  var cache = CacheService.getScriptCache();
  var key   = 'mb_dsr_' + lineUserId;
  var hit   = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }

  try {
    var ss    = SpreadsheetApp.openById(mbProp('SPREADSHEET_ID'));
    var sheet = ss.getSheetByName('USERS');
    if (!sheet) return null;
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return null;
    var h      = data[0];
    var lidIdx = h.indexOf('lineUserId');
    var actIdx = h.indexOf('active');
    if (lidIdx < 0) {
      console.warn('[MileageBot] USERS missing lineUserId column — run setupMileageBot()');
      return null;
    }
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][lidIdx]).trim() !== lineUserId) continue;
      if (actIdx >= 0 && String(data[i][actIdx]).toUpperCase() !== 'TRUE') continue;
      var u = {};
      h.forEach(function(col, ci) { u[col] = String(data[i][ci] !== undefined ? data[i][ci] : ''); });
      // Support both 'dsrEmail' and 'email' column names
      if (!u.dsrEmail && u.email) u.dsrEmail = u.email;
      cache.put(key, JSON.stringify(u), 300);
      return u;
    }
  } catch (err) {
    console.error('[MileageBot] mbLookupDsr: ' + err.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  MILEAGE LOOKUP HELPERS
// ─────────────────────────────────────────────────────────────────────
function mbGetPrevEveningConfirmed(dsrEmail, dateStr) {
  var prev = new Date(dateStr + 'T00:00:00');
  prev.setDate(prev.getDate() - 1);
  var prevStr = Utilities.formatDate(prev, 'Asia/Bangkok', 'yyyy-MM-dd');
  var rows    = mbGetRowsByDate(dsrEmail, prevStr);
  var eve     = rows.filter(function(r) { return r.session === 'evening'; })[0];
  if (!eve || !eve.confirmedMile) return null;
  var n = parseFloat(eve.confirmedMile);
  return isNaN(n) ? null : n;
}

function mbGetMorningConfirmed(dsrEmail, dateStr) {
  var rows = mbGetRowsByDate(dsrEmail, dateStr);
  var morn = rows.filter(function(r) { return r.session === 'morning'; })[0];
  if (!morn || !morn.confirmedMile) return null;
  var n = parseFloat(morn.confirmedMile);
  return isNaN(n) ? null : n;
}

function mbGetRowsByDate(dsrEmail, dateStr) {
  try {
    var sheet = mbGetMileageSheet();
    if (!sheet) return [];
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    var h = data[0];
    return data.slice(1)
      .map(function(row) {
        var obj = {};
        h.forEach(function(col, i) { obj[col] = String(row[i] !== undefined ? row[i] : ''); });
        return obj;
      })
      .filter(function(r) { return r.dsrEmail === dsrEmail && r.date === dateStr; });
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────
//  UPSERT — one record per dsrEmail × date × session
// ─────────────────────────────────────────────────────────────────────
function mbUpsertRecord(record, dsrEmail, dateStr, session) {
  mbEnsureMileageSheet();
  var sheet   = mbGetMileageSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];

  var eIdx = headers.indexOf('dsrEmail');
  var dIdx = headers.indexOf('date');
  var sIdx = headers.indexOf('session');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][eIdx]) === dsrEmail &&
        String(data[i][dIdx]) === dateStr  &&
        String(data[i][sIdx]) === session) {
      // Preserve existing id and submitted flag on overwrite
      record.id        = String(data[i][headers.indexOf('id')] || record.id);
      record.submitted = String(data[i][headers.indexOf('submitted')] || 'FALSE');
      var updRow = headers.map(function(h) {
        return record[h] !== undefined ? record[h] : (data[i][headers.indexOf(h)] || '');
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([updRow]);
      return;
    }
  }
  sheet.appendRow(headers.map(function(h) { return record[h] !== undefined ? record[h] : ''; }));
}

// ─────────────────────────────────────────────────────────────────────
//  SHEET HELPERS
// ─────────────────────────────────────────────────────────────────────
function mbGetMileageSheet() {
  return SpreadsheetApp.openById(mbProp('SPREADSHEET_ID')).getSheetByName(MB_SHEET_NAME);
}

function mbEnsureMileageSheet() {
  var ss    = SpreadsheetApp.openById(mbProp('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(MB_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MB_SHEET_NAME);
    sheet.appendRow(MB_COLS);
    sheet.getRange(1, 1, 1, MB_COLS.length).setFontWeight('bold').setBackground('#F3F4F6');
    console.log('[MileageBot] created Mileage sheet');
  }
}

// Add lineUserId, defaultVehicleType, vehicleId, depreciation_rate to USERS if missing
function mbEnsureUsersColumns() {
  var ss    = SpreadsheetApp.openById(mbProp('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName('USERS');
  if (!sheet) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ['lineUserId', 'defaultVehicleType', 'vehicleId', 'depreciation_rate'].forEach(function(col) {
    if (headers.indexOf(col) < 0) {
      var next = sheet.getLastColumn() + 1;
      sheet.getRange(1, next).setValue(col).setFontWeight('bold');
      console.log('[MileageBot] added USERS column: ' + col);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
//  ONE-TIME SETUP
// ─────────────────────────────────────────────────────────────────────
function setupMileageBot() {
  mbEnsureMileageSheet();
  mbEnsureUsersColumns();
  console.log('[MileageBot] setupMileageBot() done');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────────────
function mbProp(key) { return PropertiesService.getScriptProperties().getProperty(key) || ''; }
function mbUuid()    { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function mbTs()      { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'); }
