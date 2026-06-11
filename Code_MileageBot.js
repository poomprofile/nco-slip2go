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
  var t0 = Date.now();
  try {
    var dsr = mbLookupDsr(userId);
    // mbLookupDsr() calls mbLogUnknownUser() → MileageDebug 'lookup_fail' row if userId not found
    if (!dsr) {
      console.log('[MileageBot] unknown lineUserId: ' + userId);
      return;
    }

    // Determine date + session from current BKK time
    var bkkDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    var dateStr = Utilities.formatDate(bkkDate, 'Asia/Bangkok', 'yyyy-MM-dd');
    var session = bkkDate.getHours() < MB_MORN_HOUR ? 'morning' : 'evening';

    // debugCtx defined early so all downstream log calls can use it
    var debugCtx = { userId: userId, dsrEmail: dsr.dsrEmail, dateStr: dateStr, session: session };

    // Fetch image immediately — process_start logged after to avoid adding a sheet-write delay before fetch
    var blob = mbFetchLineImage(messageId, debugCtx);

    mbLogVisionDebug(debugCtx, 'process_start', 0,
      'DSR lookup OK — fetched messageId=' + messageId + ' elapsed=' + (Date.now() - t0) + 'ms blob=' + (blob ? 'ok' : 'null'), [], null);

    var rawMile    = null;
    var confidence = 0;
    var sourceFlag = null;

    if (blob) {
      var visionText = mbCallVision(blob, debugCtx);
      if (visionText !== null) {
        rawMile    = mbParseOdometer(visionText);
        confidence = rawMile !== null ? 0.9 : 0;
        mbLogVisionDebug(debugCtx, 'pre_write_check', 0,
          'parsedMile=' + rawMile + ' visionText(50)=' + visionText.slice(0, 50), [], rawMile);
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

    // ── Plausibility guard: reject implausible Vision readings ──
    var _plausFlag = '', _plausMsg = '';
    if (confirmedMile !== null) {
      var _lastMile = mbGetLastConfirmedMile(dsr.dsrEmail, dateStr);
      if (_lastMile !== null) {
        if (confirmedMile < _lastMile) {
          _plausFlag    = 'odo_regression';
          _plausMsg     = 'ไมล์ใหม่ (' + confirmedMile + ') < ล่าสุด (' + _lastMile + ')';
          confirmedMile = null;
          pendingFill   = 'TRUE';
          console.warn('[MileageBot] %s email=%s date=%s new=%s prev=%s',
            _plausFlag, dsr.dsrEmail, dateStr, rawMile, _lastMile);
        } else if (confirmedMile - _lastMile > 1000) {
          _plausFlag    = 'odo_jump';
          _plausMsg     = 'ไมล์กระโดด +' + Math.round(confirmedMile - _lastMile) + ' กม. (ล่าสุด=' + _lastMile + ')';
          confirmedMile = null;
          pendingFill   = 'TRUE';
          console.warn('[MileageBot] %s email=%s date=%s new=%s prev=%s',
            _plausFlag, dsr.dsrEmail, dateStr, rawMile, _lastMile);
        }
      }
    }

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
    var errorFlag = _plausFlag, errorMsg = _plausMsg;
    if (!errorFlag && session === 'evening') {
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
//  debugCtx = { userId, dsrEmail, dateStr, session } — for sheet logging
// ─────────────────────────────────────────────────────────────────────
function mbCallVision(blob, debugCtx) {
  var apiKey = mbProp('GOOGLE_VISION_API_KEY');
  if (!apiKey) {
    console.warn('[MileageBot] GOOGLE_VISION_API_KEY not set');
    mbLogVisionDebug(debugCtx, 'no_api_key', 0,
      'GOOGLE_VISION_API_KEY not set in Script Properties', [], null);
    return null;
  }
  debugCtx = debugCtx || {};
  try {
    var b64 = Utilities.base64Encode(blob.getBytes());
    // Request both in one call: DOCUMENT for structured OCR, TEXT as fallback for amber LCD
    // languageHints:'en' tells Vision to expect digits/Latin — improves dark LCD accuracy
    var payload = JSON.stringify({
      requests: [{
        image: { content: b64 },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'TEXT_DETECTION' },
        ],
        imageContext: { languageHints: ['en'] },
      }],
    });
    var res = UrlFetchApp.fetch(MB_VISION_URL + '?key=' + apiKey, {
      method: 'post', contentType: 'application/json',
      payload: payload, muteHttpExceptions: true,
    });
    var httpStatus = res.getResponseCode();
    if (httpStatus !== 200) {
      console.warn('[MileageBot] Vision API ' + httpStatus + ': ' + res.getContentText().slice(0, 200));
      mbLogVisionDebug(debugCtx, 'DOCUMENT+TEXT', httpStatus, '', [], null);
      return null;
    }

    var body = JSON.parse(res.getContentText());
    var resp = body.responses && body.responses[0];

    // DOCUMENT_TEXT_DETECTION → fullTextAnnotation.text
    var docText = (resp && resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '';

    // TEXT_DETECTION → textAnnotations[0].description (scene text, different model)
    var sceneText = '';
    var words = [];
    if (resp && resp.textAnnotations && resp.textAnnotations.length) {
      sceneText = resp.textAnnotations[0].description || '';
      resp.textAnnotations.slice(1, 40).forEach(function(a) {
        if (a.description) words.push(a.description);
      });
    }

    // Parse from DOCUMENT first; fall back to scene text if no 5-6 digit number found
    var parsedDoc   = mbParseOdometer(docText);
    var parsedScene = mbParseOdometer(sceneText);
    var parsedMile  = parsedDoc !== null ? parsedDoc : parsedScene;
    var usedMethod  = parsedDoc !== null ? 'DOCUMENT_TEXT_DETECTION'
                    : parsedScene !== null ? 'TEXT_DETECTION(fallback)'
                    : 'DOCUMENT+TEXT(no_parse)';
    var bestText    = parsedDoc !== null ? docText : (sceneText || docText);

    // Log both raw texts so admin can see what Vision actually returned
    var logText = 'DOC:' + docText.slice(0, 500) + ' | SCENE:' + sceneText.slice(0, 500);
    mbLogVisionDebug(debugCtx, usedMethod, httpStatus, logText, words, parsedMile);

    console.log('[MileageBot] Vision doc=%s scene=%s parsed=%s method=%s',
      JSON.stringify(docText).slice(0, 60), JSON.stringify(sceneText).slice(0, 60),
      parsedMile, usedMethod);
    return bestText || null;
  } catch (err) {
    console.error('[MileageBot] mbCallVision: ' + err.message);
    mbLogVisionDebug(debugCtx, 'DOCUMENT+TEXT', -1, 'ERROR: ' + err.message, [], null);
    return null;
  }
}

// Extract odometer reading from Vision OCR text.
// Strategy order: ODO-proximity → direct (filtered) → adjacent-join (filtered).
// Speedometer scale: 20-220 km/h in multiples of 20. Numbers where floor(n/1000)
// matches a scale graduation are likely Vision artefacts (e.g. "220"+"600" → 220600).
// NOTE: ODO proximity (Strategy 1) skips the speedo filter so a real 200,000 km reading
// that happens to be labeled "ODO" is still returned correctly.
function mbParseOdometer(fullText) {
  if (!fullText) return null;
  var cleaned = fullText.replace(/,/g, '').replace(/\./g, '');

  var SPEEDO = {20:1,40:1,60:1,80:1,100:1,120:1,140:1,160:1,180:1,200:1,220:1};
  function odoRange(n)  { return n >= 10000 && n <= 999999; }
  function notSpeedo(n) { return !SPEEDO[Math.floor(n / 1000)]; }

  // Strategy 1: numbers in 60-char window after ODO/กม label — direct then adjacent pair.
  // Speedo filter intentionally skipped: if "ODO" label is present the reading is trustworthy.
  var odoIdx = cleaned.search(/[Oo][Dd][Oo]|กม/);
  if (odoIdx >= 0) {
    var region  = cleaned.substring(odoIdx, odoIdx + 60).replace(/[^0-9 \n]/g, ' ');
    var onums   = region.match(/\d+/g) || [];
    for (var j = 0; j < onums.length; j++) {
      if (onums[j].length >= 5 && onums[j].length <= 6) {
        var dv = Number(onums[j]);
        if (odoRange(dv)) return dv;
      }
    }
    // adjacent pair in ODO zone — handles "06 1996" split → 061996 → 61996
    for (var k = 0; k < onums.length - 1; k++) {
      var op = onums[k] + onums[k + 1];
      if (op.length >= 5 && op.length <= 6) {
        var ov = Number(op);
        if (odoRange(ov)) return ov;
      }
    }
  }

  // Strategy 2: direct 5-6 digit number, speedometer artefacts filtered
  var direct = cleaned.match(/\b\d{5,6}\b/g);
  if (direct) {
    var c2 = direct.map(Number).filter(function(n) { return odoRange(n) && notSpeedo(n); });
    if (c2.length) return Math.max.apply(null, c2);
  }

  // Strategy 3: adjacent digit join → 5-6 digits, speedometer artefacts filtered
  // e.g. "342 670" → 342670
  var parts  = cleaned.match(/\d+/g) || [];
  var joined = [];
  for (var i = 0; i < parts.length - 1; i++) {
    var pair = parts[i] + parts[i + 1];
    if (pair.length >= 5 && pair.length <= 6) {
      var pv = Number(pair);
      if (odoRange(pv) && notSpeedo(pv)) joined.push(pv);
    }
  }
  if (joined.length) return Math.max.apply(null, joined);

  return null;
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
  // Log unregistered userId so admin can identify and map it
  mbLogUnknownUser(lineUserId);
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
  if (!eve || !eve.confirmedMile || eve.errorFlag) return null;
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
        h.forEach(function(col, i) {
          var v = row[i];
          obj[col] = (col === 'date' && v instanceof Date)
            ? Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd')
            : String(v !== undefined ? v : '');
        });
        return obj;
      })
      .filter(function(r) { return r.dsrEmail === dsrEmail && r.date === dateStr; });
  } catch (_) { return []; }
}

function mbGetLastConfirmedMile(dsrEmail, beforeDateStr) {
  try {
    var sheet = mbGetMileageSheet();
    if (!sheet) return null;
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return null;
    var h     = data[0];
    var eIdx  = h.indexOf('dsrEmail');
    var dIdx  = h.indexOf('date');
    var cmIdx = h.indexOf('confirmedMile');
    var efIdx = h.indexOf('errorFlag');
    if (eIdx < 0 || dIdx < 0 || cmIdx < 0) return null;
    var best = null, bestDate = '';
    data.slice(1).forEach(function(row) {
      var em = String(row[eIdx] || '');
      var d  = row[dIdx] instanceof Date
        ? Utilities.formatDate(row[dIdx], 'Asia/Bangkok', 'yyyy-MM-dd')
        : String(row[dIdx] || '');
      var cm = String(row[cmIdx] || '');
      var ef = efIdx >= 0 ? String(row[efIdx] || '') : '';
      if (em !== dsrEmail) return;
      if (!d || d >= beforeDateStr) return;
      if (ef) return;
      if (!cm) return;
      var n = parseFloat(cm);
      if (isNaN(n) || n <= 0) return;
      if (d > bestDate) { best = n; bestDate = d; }
    });
    return best;
  } catch (_) { return null; }
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
//  DEBUG LOGGING → sheet 'MileageDebug' in SPREADSHEET_ID
// ─────────────────────────────────────────────────────────────────────
var MB_DEBUG_SHEET = 'MileageDebug';
var MB_DEBUG_COLS  = ['timestamp','type','userId','dsrEmail','date','session',
                      'visionMethod','httpStatus','rawText','words','parsedMile'];

function mbEnsureDebugSheet() {
  var ss    = SpreadsheetApp.openById(mbProp('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(MB_DEBUG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MB_DEBUG_SHEET);
    sheet.appendRow(MB_DEBUG_COLS);
    sheet.getRange(1, 1, 1, MB_DEBUG_COLS.length).setFontWeight('bold').setBackground('#FFF3CD');
  }
  return sheet;
}

function mbLogVisionDebug(ctx, visionMethod, httpStatus, rawText, words, parsedMile) {
  try {
    var sheet = mbEnsureDebugSheet();
    sheet.appendRow([
      mbTs(),
      'vision',
      ctx.userId    || '',
      ctx.dsrEmail  || '',
      ctx.dateStr   || '',
      ctx.session   || '',
      visionMethod,
      httpStatus,
      String(rawText || '').slice(0, 500),   // cap at 500 chars
      JSON.stringify(words || []).slice(0, 300),
      parsedMile !== null && parsedMile !== undefined ? String(parsedMile) : '',
    ]);
  } catch (e) {
    console.warn('[MileageBot] mbLogVisionDebug failed: ' + e.message);
  }
}

function mbLogUnknownUser(lineUserId) {
  try {
    var sheet = mbEnsureDebugSheet();
    sheet.appendRow([
      mbTs(), 'lookup_fail', lineUserId,
      '', '', '', '', '', 'lineUserId not found in USERS sheet', '', '',
    ]);
    console.warn('[MileageBot] unregistered lineUserId: ' + lineUserId);
  } catch (e) {
    console.warn('[MileageBot] mbLogUnknownUser failed: ' + e.message);
  }
}

// Called from Code_LineBot.gs handleEvent() for every message event.
// Logs: source.groupId, ev.destination (body-level), source.type, match result.
// ctx = { evType, msgType, userId, groupId, sourceType, destination, mileageGroupId, matched }
function mbLogRouteEvent(ctx) {
  try {
    var sheet = mbEnsureDebugSheet();
    var detail = 'evType='   + (ctx.evType   || '') +
                 '|msgType=' + (ctx.msgType  || '') +
                 '|sourceType=' + (ctx.sourceType || '') +
                 '|groupId=' + (ctx.groupId  || '') +
                 '|dest='    + (ctx.destination || '') +
                 '|mileageGroupId=' + (ctx.mileageGroupId || '') +
                 '|matched=' + (ctx.matched ? 'YES' : 'NO');
    sheet.appendRow([
      mbTs(),
      'route',
      ctx.userId || '',
      '',   // dsrEmail — not resolved at routing stage
      '',   // date
      '',   // session
      ctx.sourceType || '',   // visionMethod col → source.type
      ctx.matched ? 'matched' : 'no_match',  // httpStatus col → routing result
      detail,
      '',   // words
      '',   // parsedMile
    ]);
  } catch (e) {
    console.warn('[MileageBot] mbLogRouteEvent failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  ONE-TIME SETUP
// ─────────────────────────────────────────────────────────────────────
function setupMileageBot() {
  mbEnsureMileageSheet();
  mbEnsureUsersColumns();
  mbEnsureDebugSheet();
  console.log('[MileageBot] setupMileageBot() done');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
//  LINE IMAGE FETCH — requires LINE_MILEAGE_TOKEN in Script Properties
//  Logs HTTP status + error to MileageDebug on failure
// ─────────────────────────────────────────────────────────────────────
function mbFetchLineImage(messageId, debugCtx) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_MILEAGE_TOKEN');
  var tokenPreview = token ? token.substring(0, 10) : 'NULL';
  mbLogVisionDebug(debugCtx, 'token_check', 0,
    'LINE_MILEAGE_TOKEN first10=' + tokenPreview + ' messageId=' + messageId, [], null);
  if (!token) {
    var msg = 'LINE_MILEAGE_TOKEN not set in Script Properties';
    mbLogVisionDebug(debugCtx, 'fetch_fail', -1, msg, [], null);
    console.error('[MileageBot] mbFetchLineImage: ' + msg);
    throw new Error(msg);
  }
  var url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
  try {
    var res    = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    var status = res.getResponseCode();
    if (status !== 200) {
      var body = res.getContentText().slice(0, 300);
      mbLogVisionDebug(debugCtx, 'fetch_fail', status,
        'LINE Content API ' + status + ' token=LINE_MILEAGE_TOKEN url=' + url + ' body=' + body,
        [], null);
      console.warn('[MileageBot] mbFetchLineImage status=' + status + ' body=' + body);
      return null;
    }
    console.log('[MileageBot] mbFetchLineImage OK status=200');
    return res.getBlob().setName('mileage_' + messageId + '.jpg');
  } catch (e) {
    mbLogVisionDebug(debugCtx, 'fetch_fail', -1,
      'fetchLineImage exception err=' + e.message,
      [], null);
    console.error('[MileageBot] mbFetchLineImage exception: ' + e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────────────
function mbProp(key) { return PropertiesService.getScriptProperties().getProperty(key) || ''; }
function mbUuid()    { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function mbTs()      { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'); }

// ─────────────────────────────────────────────────────────────────────
//  TEST — run manually from Apps Script Editor to verify LINE_MILEAGE_TOKEN
// ─────────────────────────────────────────────────────────────────────
function testLineImageFetch() {
  var token     = PropertiesService.getScriptProperties().getProperty('LINE_MILEAGE_TOKEN');
  var messageId = '617714165360623857'; // from MileageDebug row 72
  var url       = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
  var res       = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  console.log('status:', res.getResponseCode());
  console.log('body:',   res.getContentText().substring(0, 500));
}

function testMileageDateType() {
  var sheet = mbGetMileageSheet();
  if (!sheet) { console.log('[test] Mileage sheet not found'); return; }
  var h    = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row1 = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var dIdx = h.indexOf('date');
  console.log('[test] date col index: %s', dIdx);
  console.log('[test] date raw value: %s', row1[dIdx]);
  console.log('[test] date typeof: %s', typeof row1[dIdx]);
  console.log('[test] date instanceof Date: %s', row1[dIdx] instanceof Date);
  if (row1[dIdx] instanceof Date) {
    console.log('[test] date formatted: %s',
      Utilities.formatDate(row1[dIdx], 'Asia/Bangkok', 'yyyy-MM-dd'));
  }
}
