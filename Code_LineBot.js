// Updated: 2026-05-19 17:00
// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — LINE Bot + Slip2Go  (ALL-IN-ONE v3)          ║
// ║  Code_LineBot.gs                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

function cfg() {
  var p = PropertiesService.getScriptProperties();
  return {
    LINE_TOKEN:    p.getProperty('LINE_CHANNEL_TOKEN')  || '',
    LINE_SECRET:   p.getProperty('LINE_CHANNEL_SECRET') || '',
    SLIP2GO_KEY:   p.getProperty('SLIP2GO_API_KEY')     || '',
    SHEET_ID_SLIP: p.getProperty('SPREADSHEET_ID_SLIP') || '',
    SHEET_ID_OPS:  p.getProperty('SPREADSHEET_ID')      || '',
    PORTAL_URL:    p.getProperty('PORTAL_URL')          || '',
  };
}

var SH = {
  SLIPS:   'Slip2Go',
  PENDING: 'PENDING_SLIPS',
  DEBTS:   'บิลค้างจ่าย',
  USERS:   'USERS',
  LINEMAP: 'LINE_USER_MAP',
};

// ═══ ENTRY POINTS ══════════════════════════════════════════════════

function doGet(e) {
  if (e && e.parameter) {
    if (e.parameter.page === 'slip-match') return serveSlipMatchPage(e.parameter.ref || '');
    if (e.parameter.page === 'dsr-review') return serveDsrReviewPage(e.parameter.email || '');
  }
  return ContentService.createTextOutput('NCO LineBot OK · v3.0');
}

function doPost(e) {
  // Raw catch-all — runs before any logic to confirm webhook reaches this deployment
  try {
    var _id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    var _ss = SpreadsheetApp.openById(_id);
    var _sh = _ss.getSheetByName('Debug') || _ss.insertSheet('Debug');
    var _body = e && e.postData ? String(e.postData.contents || '').slice(0, 400) : '(no postData)';
    _sh.appendRow([new Date(), 'doPost', _body]);
  } catch (_e) { console.error('[doPost-rawlog]', _e.message); }

  try {
    if (!e || !e.postData || !e.postData.contents) return text200('empty');
    var body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(function(ev) {
      try { handleEvent(ev); }
      catch (err) { console.error('[event]', err.message, err.stack); }
    });
    return text200('ok');
  } catch (err) {
    console.error('[doPost]', err.message);
    return text200('err');
  }
}

function text200(msg) { return ContentService.createTextOutput(msg); }

// ═══ EVENT ROUTER ══════════════════════════════════════════════════

function handleEvent(ev) {
  if (ev.type === 'follow')  return handleFollow(ev);
  if (ev.type !== 'message') return;
  var msg        = ev.message;
  var userId     = (ev.source && ev.source.userId)  || '';
  var groupId    = (ev.source && ev.source.groupId) || '';
  var replyToken = ev.replyToken;

  // Route mileage group images to MileageBot (never replies)
  var mileageGroupId = PropertiesService.getScriptProperties().getProperty('MILEAGE_GROUP_ID');
  if (mileageGroupId && groupId === mileageGroupId) {
    if (msg.type === 'image') handleMileageImage(msg.id, userId, groupId);
    return;
  }

  if (msg.type === 'image') return handleImage(msg.id, userId, groupId, replyToken);
  if (msg.type === 'text')  return handleText(msg.text, userId, groupId, replyToken);
}

function handleFollow(ev) {
  replyLine(ev.replyToken, [{ type:'text', text:'🎉 ยินดีต้อนรับ NCO Slip2Go\nพิมพ์ "help" เพื่อดูวิธีใช้' }]);
}

// ═══ IMAGE HANDLER ═════════════════════════════════════════════════

function handleImage(messageId, userId, groupId, replyToken) {
  var blob = fetchLineImage(messageId);
  if (!blob) {
    replyLine(replyToken, [{ type:'text', text:'❌ โหลดรูปไม่ได้' }]);
    return;
  }

  var slip = verifyWithSlip2Go(blob);
  Logger.log('[handleImage] slip result: ' + JSON.stringify(slip).slice(0, 300));

  if (!slip || !slip.success) {
    replyLine(replyToken, [{ type:'text', text:'⚠️ อ่านสลิปไม่ผ่าน ส่งใหม่ครับ' }]);
    return;
  }
  if (slip.warning === 'บัญชีผู้รับไม่ตรง') {
    replyLine(replyToken, [{ type:'text', text:'❌ ปลายทางไม่ใช่ NCO' }]);
    return;
  }
  if (slip.warning === 'สลิปซ้ำ') {
    replyLine(replyToken, [{ type:'text', text:'⚠️ สลิปซ้ำ · ' + formatAmount(slip.data.amount) + ' ฿' }]);
    return;
  }

  addToPendingQueue(userId, messageId, groupId, slip.data);

  var queue = getPendingForUser(userId);
  if (queue.length === 1) {
    replyLine(replyToken, [{ type:'text', text:'📸 ' + formatAmount(slip.data.amount) + ' ฿' }]);
  }
}

// ═══ TEXT HANDLER ══════════════════════════════════════════════════

function handleText(textRaw, userId, groupId, replyToken) {
  var t = (textRaw || '').trim();
  if (!t) return;

  if (t === 'help' || t === 'ช่วยเหลือ') return replyHelp(replyToken);
  if (t === 'ยอด'  || t === 'สรุป')      return replySummary(userId, replyToken);
  if (t.indexOf('ลงทะเบียน') === 0)       return handleRegister(t, userId, replyToken);

  var parsed = parseSlipText(t);
  if (!parsed) return;

  var pending = getPendingForUser(userId);
  if (pending.length === 0) {
    replyLine(replyToken, [{ type:'text', text:'⚠️ ยังไม่มีสลิป — ส่งรูปก่อน' }]);
    return;
  }

  if (parsed.is_customer_only) {
    handleScenarioE(parsed.customer_code, pending, userId, replyToken);
    return;
  }

  processBatch(pending, parsed, userId, groupId, replyToken);
}

// ═══ updatePendingWithCustBill — top-level ═════════════════════════
// อัปเดต cust_code และ invoice_no ใน PENDING_SLIPS
// เรียกก่อน clearPendingQueue เสมอ

function updatePendingWithCustBill(userId, custCode, invoiceNo) {
  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ensurePendingSheet(ss); // ← ensurePendingSheet จะเพิ่ม column ให้อัตโนมัติ
    // re-read หลัง ensure เผื่อ column เพิ่งถูกสร้าง
    var data  = sheet.getDataRange().getValues();
    var h     = data[0];
    var uIdx  = h.indexOf('user_id');
    var sIdx  = h.indexOf('status');
    var cIdx  = h.indexOf('cust_code');
    var iIdx  = h.indexOf('invoice_no');

    if (uIdx < 0 || sIdx < 0) {
      console.error('[updatePending] missing required columns');
      return;
    }

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][uIdx]) !== String(userId)) continue;
      if (String(data[i][sIdx]) !== 'pending') continue;
      if (cIdx >= 0) sheet.getRange(i+1, cIdx+1).setValue(custCode  || '');
      if (iIdx >= 0) sheet.getRange(i+1, iIdx+1).setValue(invoiceNo || '');
    }
    console.log('[updatePending] userId='+userId+' cust='+custCode+' inv='+invoiceNo);
  } catch(e) {
    console.error('[updatePendingWithCustBill] ' + e.message);
  }
}

// ═══ SCENARIO E ════════════════════════════════════════════════════

function handleScenarioE(customerCode, pending, userId, replyToken) {
  var debts = getAllDebts();

  if (!customerCodeExists(customerCode, debts)) {
    replyLine(replyToken, [{
      type: 'text',
      text: '❌ ไม่พบรหัสลูกค้า: ' + customerCode + '\nตรวจสอบรหัสแล้วลองใหม่ครับ'
    }]);
    return;
  }

  var shopName  = getCustomerShopName(customerCode, debts);
  var billCount = debts.filter(function(d) {
    return String(d['รหัสหลัก'] || '').trim() === customerCode;
  }).length;

  writeScenarioE(pending, customerCode, shopName, userId);
  updatePendingWithCustBill(userId, customerCode, ''); // ← ก่อน clear
  clearPendingQueue(userId);

  var lines = [
    '✅ รับสลิป ' + pending.length + ' ใบ · ' + formatAmount(
      pending.reduce(function(s, p) { return s + (parseFloat(p.amount) || 0); }, 0)
    ) + ' ฿',
    'รหัส ' + customerCode + (shopName ? ' · ' + shopName : ''),
    'บิลค้างชำระ ' + billCount + ' รายการ',
    '',
    '📋 กรุณาระบุเลขบิลในใบสรุปอีกทีนะครับ'
  ];
  replyLine(replyToken, [{ type:'text', text:lines.join('\n') }]);
}

function writeScenarioE(slips, customerCode, shopName, userId) {
  var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
  var sheet = ss.getSheetByName(SH.SLIPS);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + SH.SLIPS);

  var email    = getDsrEmailFromLine(userId) || '';
  var dsrName  = email ? getUserDisplayName(email) : '';
  var batchRef = 'E' + Date.now().toString().slice(-10);
  var nowStr   = formatDateThai(new Date());

  slips.forEach(function(slip) {
    sheet.appendRow([
      nowStr,
      slip.transfer_date || '',
      slip.transfer_time || '',
      parseFloat(slip.amount) || 0,
      customerCode,
      shopName,
      '',             // เลขที่บิล ← ว่างไว้ รอระบุ
      slip.ref1 || '',
      userId,
      'รอระบุบิล',
      dsrName,
      email,
      'E',
      batchRef,
    ]);
  });
  return batchRef;
}

// ═══ CORE: BATCH PROCESSOR ════════════════════════════════════════

function processBatch(pending, parsed, userId, groupId, replyToken) {
  var debts    = getAllDebts();
  var customer = parsed.customer_code;
  var bills    = parsed.bills;

  if (!customerCodeExists(customer, debts)) {
    replyLine(replyToken, [{
      type: 'text',
      text: '❌ ไม่พบรหัสลูกค้า: ' + customer + '\nตรวจสอบและส่งใหม่'
    }]);
    return;
  }

  var slipCount = pending.length;
  var billCount = bills.length;
  var totalSlip = pending.reduce(function(s, p) { return s + (parseFloat(p.amount) || 0); }, 0);

  var matched  = matchBills(customer, bills, debts);
  var found    = matched.filter(function(m) { return !m._not_found; });
  var notFound = matched.filter(function(m) { return m._not_found; });
  var totalBill= found.reduce(function(s, b) { return s + parseMoneyCell(b['ยอดบิล']); }, 0);

  // ── Double-use bill check ──────────────────────────────────────────
  var usedInvoices = getUsedInvoices();
  var duplicateBills = found.filter(function(b) {
    return usedInvoices.indexOf(normalizeInvoice(String(b.InvoiceNo || ''))) !== -1;
  });
  if (duplicateBills.length > 0) {
    var dupList = duplicateBills.map(function(b) { return b.InvoiceNo || ''; }).join(', ');
    replyLine(replyToken, [{
      type: 'text',
      text: '❌ บิลถูกบันทึกแล้ว ไม่สามารถใช้ซ้ำได้\nบิลที่ซ้ำ: ' + dupList + '\nกรุณาตรวจสอบและติดต่อผู้ดูแลระบบ'
    }]);
    return;
  }
  // ──────────────────────────────────────────────────────────────────

  var scenario;
  if (slipCount === 1 && billCount === 1)      scenario = 'A';
  else if (slipCount === 1 && billCount > 1)   scenario = 'B';
  else if (slipCount > 1 && billCount === 1)   scenario = 'C';
  else                                         scenario = 'D';

  var diff    = Math.round((totalSlip - totalBill) * 100) / 100;
  var isValid = Math.abs(diff) < 1 && notFound.length === 0;

  var batchRef;
  if (scenario === 'D') {
    batchRef = writeSlipBatch(pending, matched, customer, userId, 'D', false);
    updatePendingWithCustBill(userId, customer, bills.join(','));  // ← ก่อน clear
    clearPendingQueue(userId);
    replyLine(replyToken, [{ type:'text', text:buildCaseDReply(pending, matched, batchRef, totalSlip) }]);
    return;
  }

  batchRef = writeSlipBatch(pending, matched, customer, userId, scenario, isValid);
  updatePendingWithCustBill(userId, customer, bills[0] || '');  // ← ก่อน clear
  clearPendingQueue(userId);

  replyLine(replyToken, [{
    type: 'text',
    text: buildBatchReply(scenario, pending, matched, customer, totalSlip, totalBill, diff, isValid)
  }]);
}

// ═══ MATCHING ══════════════════════════════════════════════════════

function matchBills(customerCode, billList, debts) {
  var candidates = debts.filter(function(d) {
    return String(d['รหัสหลัก'] || '').trim() === customerCode;
  });
  return billList.map(function(bill) {
    var nb = normalizeInvoice(bill);
    var found = candidates.find(function(d) {
      var inv = normalizeInvoice(String(d.InvoiceNo || ''));
      return inv === nb || inv.endsWith(nb) || nb.endsWith(inv) || digitOnly(inv) === digitOnly(nb);
    });
    if (found) return Object.assign({}, found, { _query_bill: bill });
    return { _not_found: true, _bill: bill };
  });
}

function customerCodeExists(customerCode, debts) {
  return debts.some(function(d) { return String(d['รหัสหลัก'] || '').trim() === customerCode; });
}

// คืน array ของ normalized invoice ที่มีสถานะ "เรียบร้อย" ใน Slip2Go sheet แล้ว
function getUsedInvoices() {
  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet || sheet.getLastRow() < 2) return [];
    var data    = sheet.getDataRange().getValues();
    var headers = data[0];
    var iInvoice = headers.indexOf('เลขที่บิล');
    var iStatus  = headers.indexOf('สถานะ');
    if (iInvoice < 0 || iStatus < 0) return [];
    var used = [];
    for (var i = 1; i < data.length; i++) {
      var status  = String(data[i][iStatus] || '').trim();
      var invoice = normalizeInvoice(String(data[i][iInvoice] || '').trim());
      if (status === 'เรียบร้อย' && invoice) used.push(invoice);
    }
    return used;
  } catch(e) {
    Logger.log('[getUsedInvoices] error: ' + e.message);
    return [];
  }
}

function getCustomerShopName(customerCode, debts) {
  var match = debts.find(function(d) { return String(d['รหัสหลัก'] || '').trim() === customerCode; });
  if (!match) return '';
  return match['ชื่อลูกค้าหลัก'] || match.Sale || '';
}

function normalizeInvoice(inv) {
  if (!inv) return '';
  inv = String(inv).trim().toLowerCase();
  inv = inv.replace(/\/\d+$/, '');
  inv = inv.replace(/^[a-z]{2,}\d{2}/, '');
  inv = inv.replace(/^inv-\d{2}-/, '');
  return inv.trim();
}

function digitOnly(s) { return String(s).replace(/[^0-9-]/g, ''); }

function parseSlipText(text) {
  if (!text) return null;
  var clean = text.trim().replace(/\s+/g, ' ');
  var parts = clean.split(' ');
  var CUST_RE = /^\d+-\d+$/;
  var BILL_RE = /^\d{2,4}-\d{4,6}$/;
  if (parts.length === 0 || !CUST_RE.test(parts[0])) return null;
  var customerCode = parts[0];
  var bills = parts.slice(1).filter(function(p) { return BILL_RE.test(p); });
  return { customer_code: customerCode, bills: bills, is_customer_only: bills.length === 0 };
}

// ═══ PENDING QUEUE ═════════════════════════════════════════════════

var CACHE_TTL        = 21600;
var CACHE_KEY_PREFIX = 'pending_slips_';

function cacheKeyFor(userId) { return CACHE_KEY_PREFIX + userId; }

function addToPendingQueue(userId, messageId, groupId, slipData) {
  var id = 'P' + Date.now().toString().slice(-10);
  var item = {
    pending_id:    id,
    user_id:       userId,
    message_id:    messageId,
    group_id:      groupId || '',
    amount:        parseFloat(slipData.amount || 0),
    sender_name:   (slipData.sender && slipData.sender.name) || '',
    bank:          (slipData.sender && slipData.sender.bank && slipData.sender.bank.name) || '',
    receiver_name: (slipData.receiver && slipData.receiver.name) || '',
    transfer_date: slipData.date || '',
    transfer_time: slipData.time || '',
    ref1:          slipData.ref1 || '',
    created_at:    tsString(),
    status:        'pending',
  };

  try {
    var cache    = CacheService.getScriptCache();
    var existing = cache.get(cacheKeyFor(userId));
    var queue    = existing ? JSON.parse(existing) : [];
    queue.push(item);
    cache.put(cacheKeyFor(userId), JSON.stringify(queue), CACHE_TTL);
  } catch(e) { console.error('[cache.put]', e.message); }

  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ensurePendingSheet(ss);
    sheet.appendRow([
      id, userId, messageId, groupId || '',
      item.amount, item.sender_name, item.bank, item.receiver_name,
      item.transfer_date, item.transfer_time, item.ref1,
      JSON.stringify(slipData).slice(0, 1000),
      item.created_at, 'pending',
      '', ''  // cust_code, invoice_no ← ว่างไว้ก่อน รอ DSR พิมมา
    ]);
  } catch(e) { console.error('[pending-sheet]', e.message); }

  return id;
}

function getPendingForUser(userId) {
  try {
    var cache  = CacheService.getScriptCache();
    var cached = cache.get(cacheKeyFor(userId));
    if (cached) {
      var queue = JSON.parse(cached);
      if (Array.isArray(queue)) return queue;
    }
  } catch(e) { console.error('[cache.get]', e.message); }
  return getPendingFromSheet(userId);
}

function getPendingFromSheet(userId) {
  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ensurePendingSheet(ss);
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    var h    = data[0];
    var uIdx = h.indexOf('user_id');
    var sIdx = h.indexOf('status');
    var results = [];
    for (var i = 1; i < data.length; i++) {
      if (data[i][uIdx] !== userId || data[i][sIdx] !== 'pending') continue;
      var obj = {};
      h.forEach(function(k, j) { obj[k] = data[i][j]; });
      obj._row = i + 1;
      results.push(obj);
    }
    return results;
  } catch(e) {
    console.error('[pending-sheet-read]', e.message);
    return [];
  }
}

function clearPendingQueue(userId) {
  try { CacheService.getScriptCache().remove(cacheKeyFor(userId)); }
  catch(e) { console.error('[cache.remove]', e.message); }

  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ensurePendingSheet(ss);
    var data  = sheet.getDataRange().getValues();
    var h     = data[0];
    var uIdx  = h.indexOf('user_id');
    var sIdx  = h.indexOf('status');
    for (var i = data.length - 1; i >= 1; i--) {
      if (data[i][uIdx] === userId && data[i][sIdx] === 'pending') {
        sheet.getRange(i+1, sIdx+1).setValue('processed');
      }
    }
  } catch(e) { console.error('[pending-sheet-clear]', e.message); }
}

// ─── ensurePendingSheet — เพิ่ม column ถ้ายังไม่มี ────────────────
function ensurePendingSheet(ss) {
  var fullHeaders = [
    'pending_id','user_id','message_id','group_id','amount',
    'sender_name','bank','receiver_name',
    'transfer_date','transfer_time','ref1',
    'raw_data','created_at','status',
    'cust_code','invoice_no'
  ];

  var s = ss.getSheetByName(SH.PENDING);
  if (!s) {
    // สร้างใหม่ทั้งหมด
    s = ss.insertSheet(SH.PENDING);
    s.getRange(1,1,1,fullHeaders.length).setValues([fullHeaders]);
    s.getRange(1,1,1,fullHeaders.length)
      .setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');
    s.setFrozenRows(1);
    console.log('[ensurePendingSheet] created new sheet with all headers');
  } else {
    // sheet มีอยู่แล้ว — ตรวจและเพิ่ม column ที่หายไป
    var lastCol  = s.getLastColumn();
    var existing = lastCol > 0 ? s.getRange(1,1,1,lastCol).getValues()[0] : [];
    var toAdd    = ['cust_code','invoice_no'];
    toAdd.forEach(function(col) {
      if (existing.indexOf(col) < 0) {
        var nextCol = s.getLastColumn() + 1;
        s.getRange(1, nextCol).setValue(col);
        s.getRange(1, nextCol)
          .setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');
        console.log('[ensurePendingSheet] added column: ' + col + ' at col ' + nextCol);
      }
    });
  }
  return s;
}

function clearAllCaches() {
  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ensurePendingSheet(ss);
    var data  = sheet.getDataRange().getValues();
    var h     = data[0];
    var uIdx  = h.indexOf('user_id');
    var sIdx  = h.indexOf('status');
    var users = {};
    for (var i = 1; i < data.length; i++) {
      if (data[i][sIdx] === 'pending' && data[i][uIdx]) users[data[i][uIdx]] = true;
    }
    var keys = Object.keys(users).map(cacheKeyFor);
    if (keys.length > 0) CacheService.getScriptCache().removeAll(keys);
    Logger.log('Cleared cache for ' + keys.length + ' users');
    return keys.length;
  } catch(e) { Logger.log('Error: ' + e.message); return -1; }
}

// ═══ WRITE SLIPS SHEET ═════════════════════════════════════════════

function writeSlipBatch(slips, matched, customer, userId, scenario, isValid) {
  var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
  var sheet = ss.getSheetByName(SH.SLIPS);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + SH.SLIPS);

  var email    = getDsrEmailFromLine(userId) || '';
  var dsrName  = email ? getUserDisplayName(email) : '';
  var batchRef = (scenario === 'D' ? 'D' : 'B') + Date.now().toString().slice(-10);
  var status   = scenario === 'D' ? 'รอระบุ' : (isValid ? 'เรียบร้อย' : 'ยอดไม่ตรง');
  var nowStr   = formatDateThai(new Date());

  slips.forEach(function(slip) {
    matched.forEach(function(bill) {
      if (bill._not_found) return;
      var shopName = bill['ชื่อลูกค้าหลัก'] || bill.Sale || '';
      sheet.appendRow([
        nowStr, slip.transfer_date || '', slip.transfer_time || '',
        parseFloat(slip.amount) || 0, customer, shopName,
        normalizeInvoice(String(bill.InvoiceNo || '')),
        slip.ref1 || '', userId, status, dsrName, email, scenario, batchRef,
      ]);
    });
  });
  return batchRef;
}

// ═══ PORTAL API ════════════════════════════════════════════════════

function getBillsForPendingRow(customerCode) {
  if (!customerCode) return { ok:false, error:'ไม่ระบุรหัสลูกค้า' };
  var debts = getAllDebts();
  var today = new Date(); today.setHours(0,0,0,0);
  var bills = debts
    .filter(function(d) { return String(d['รหัสหลัก']||'').trim() === customerCode; })
    .map(function(d) {
      var dueDateRaw = d['DueDate'] || d['วันครบกำหนด'] || '';
      var dueDate    = dueDateRaw ? new Date(dueDateRaw) : null;
      var overdue    = dueDate && !isNaN(dueDate) ? Math.floor((today-dueDate)/86400000) : null;
      return {
        invoiceNo:   String(d['InvoiceNo']||'').trim(),
        amount:      parseMoneyCell(d['ยอดคงเหลือ'] || d['ยอดบิล'] || 0),
        dueDate:     dueDate && !isNaN(dueDate) ? dueDate.toISOString().slice(0,10) : null,
        overdueDays: overdue
      };
    })
    .sort(function(a,b){
      if(!a.dueDate&&!b.dueDate)return 0; if(!a.dueDate)return 1; if(!b.dueDate)return -1;
      return new Date(a.dueDate)-new Date(b.dueDate);
    });
  if (!bills.length) return { ok:false, error:'ไม่พบบิลค้างชำระ' };
  return { ok:true, bills:bills };
}

function assignBillToSlipRow(rowIndex, invoiceNo) {
  rowIndex  = parseInt(rowIndex);
  invoiceNo = String(invoiceNo||'').trim();
  if (!rowIndex || !invoiceNo) return { ok:false, error:'ข้อมูลไม่ครบ' };

  var ss      = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
  var sheet   = ss.getSheetByName(SH.SLIPS);
  if (!sheet) return { ok:false, error:'ไม่พบ Sheet' };

  var headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  function colIdx(name){ var i=headers.indexOf(name); return i>=0?i+1:-1; }

  var iInvoice = colIdx('เลขที่บิล');
  var iStatus  = colIdx('สถานะ');
  if (iInvoice<0||iStatus<0) return { ok:false, error:'ไม่พบ column ที่จำเป็น' };

  var currentStatus = sheet.getRange(rowIndex, iStatus).getValue();
  if (String(currentStatus).trim() !== 'รอระบุบิล') return { ok:false, error:'แถวนี้อัปเดตไปแล้ว กรุณา refresh' };

  sheet.getRange(rowIndex, iInvoice).setValue(invoiceNo);
  sheet.getRange(rowIndex, iStatus).setValue('เรียบร้อย');
  return { ok:true };
}

// ═══ REPLY BUILDERS ════════════════════════════════════════════════

function buildBatchReply(scenario, slips, matched, customer, totalSlip, totalBill, diff, isValid) {
  var found    = matched.filter(function(m){ return !m._not_found; });
  var notFound = matched.filter(function(m){ return m._not_found; });
  if (isValid && notFound.length===0) {
    var shop = (found[0]&&(found[0]['ชื่อลูกค้าหลัก']||found[0].Sale)) || customer;
    return '🟢 ' + formatAmount(totalSlip) + ' ฿ · ' + shop + '\n✅ ' + found.length + ' บิล · ยอดตรง';
  }
  var lines = ['⚠️ บันทึกแล้ว · ' + formatAmount(totalSlip) + ' ฿', 'รหัสลูกค้า: ' + customer];
  if (found.length)    lines.push('✓ ตัดได้ ' + found.length + ' บิล');
  if (notFound.length) lines.push('❌ ไม่พบ: ' + notFound.map(function(m){return m._bill;}).join(', '));
  if (Math.abs(diff)>=1) lines.push((diff>0?'⚠️ ยอดเกิน ':'⚠️ ยอดขาด ') + formatAmount(Math.abs(diff)) + ' ฿');
  return lines.join('\n');
}

function buildCaseDReply(slips, matched, batchRef, totalSlip) {
  return '⚠️ ' + formatAmount(totalSlip) + ' ฿\nสลิป ' + slips.length + ' ใบ / บิล ' + matched.length + ' รายการ\nกรุณาแก้ไขใน Portal วันทำสรุป';
}

function replyHelp(replyToken) {
  replyLine(replyToken, [{ type:'text', text:'📖 วิธีใช้\n\n1. ส่งรูปสลิป\n2. พิมพ์ รหัสลูกค้า (ตามด้วยเลขบิลถ้ามี)\n   มีเลขบิล:  113-82 370-18457\n   ไม่มีเลขบิล: 113-82\n\nคำสั่ง: "ยอด" "ลงทะเบียน [email]"' }]);
}

function replySummary(userId, replyToken) {
  var email = getDsrEmailFromLine(userId);
  if (!email) { replyLine(replyToken, [{ type:'text', text:'พิมพ์: ลงทะเบียน [email]' }]); return; }

  var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
  var sheet = ss.getSheetByName(SH.SLIPS);
  if (!sheet) { replyLine(replyToken, [{ type:'text', text:'ยังไม่มีข้อมูล' }]); return; }

  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var eIdx  = h.indexOf('Email');
  var dIdx  = h.indexOf('วันที่ส่งสลิป');
  var aIdx  = h.indexOf('ยอดเงิน');
  var sIdx  = h.indexOf('สถานะ');
  var weekStart = getMondayOfWeek();
  var total = 0, count = 0;

  for (var i = 1; i < data.length; i++) {
    if (data[i][eIdx] !== email) continue;
    var st = data[i][sIdx];
    if (st==='ไม่ใช้'||st==='รอระบุ') continue;
    var d = parseThaiDate(data[i][dIdx]);
    if (d && d >= weekStart) { total += parseFloat(data[i][aIdx])||0; count++; }
  }
  replyLine(replyToken, [{ type:'text', text:'📊 คุณ'+getUserDisplayName(email)+' · สัปดาห์นี้\n'+count+' รายการ · '+formatAmount(total)+' ฿' }]);
}

function handleRegister(text, userId, replyToken) {
  var parts = text.split(/\s+/);
  if (parts.length < 2) { replyLine(replyToken, [{ type:'text', text:'พิมพ์: ลงทะเบียน [email]' }]); return; }

  var email = parts[1].toLowerCase().trim();
  var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_OPS);
  var uSh   = ss.getSheetByName(SH.USERS);
  if (!uSh) { replyLine(replyToken, [{ type:'text', text:'❌ ระบบยังไม่พร้อม' }]); return; }

  var data  = uSh.getDataRange().getValues();
  var eIdx  = data[0].indexOf('email');
  var nIdx  = data[0].indexOf('display_name');
  var found = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][eIdx]).toLowerCase() === email) { found = data[i][nIdx]; break; }
  }
  if (!found) { replyLine(replyToken, [{ type:'text', text:'❌ ไม่พบ email · ติดต่อ Admin' }]); return; }

  var map = ss.getSheetByName(SH.LINEMAP);
  if (!map) {
    map = ss.insertSheet(SH.LINEMAP);
    map.getRange(1,1,1,3).setValues([['line_user_id','email','registered_at']]);
    map.getRange(1,1,1,3).setBackground('#007B40').setFontColor('#fff').setFontWeight('bold');
  }
  var mData = map.getDataRange().getValues();
  for (var j = 1; j < mData.length; j++) {
    if (mData[j][0] === userId) {
      map.getRange(j+1,2).setValue(email);
      map.getRange(j+1,3).setValue(tsString());
      replyLine(replyToken, [{ type:'text', text:'✅ อัปเดต · คุณ'+found }]);
      return;
    }
  }
  map.appendRow([userId, email, tsString()]);
  replyLine(replyToken, [{ type:'text', text:'✅ ลงทะเบียน · คุณ'+found }]);
}

// ═══ SLIP MATCH PAGE ═══════════════════════════════════════════════

function serveSlipMatchPage(batchRef) {
  if (!batchRef) return HtmlService.createHtmlOutput('<h1>ไม่พบ batch ref</h1>');
  var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
  var sheet = ss.getSheetByName(SH.SLIPS);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var bIdx  = h.indexOf('batch_ref');
  var rows  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][bIdx] === batchRef) {
      var obj = {};
      h.forEach(function(k,j){ obj[k]=data[i][j]; });
      rows.push(obj);
    }
  }
  var t = HtmlService.createTemplate(slipMatchHtml());
  t.batchRef = batchRef;
  t.rows     = JSON.stringify(rows);
  return t.evaluate().setTitle('จับคู่สลิป — NCO').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function slipMatchHtml() {
  return [
    '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">',
    '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Sarabun,sans-serif;background:#F7F5F2;color:#1A1A1A;padding:16px;font-size:14px}.head{background:#E8631A;color:#fff;border-radius:12px;padding:16px;margin-bottom:12px}.slip{background:#fff;border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid rgba(0,0,0,.08)}.amt{font-size:20px;font-weight:700;color:#E8631A}.row{display:flex;gap:8px;margin-top:8px}select{flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-family:inherit;font-size:14px}button{background:#007B40;color:#fff;border:none;padding:14px;border-radius:10px;font-size:15px;font-weight:600;width:100%;margin-top:16px;font-family:inherit}</style>',
    '</head><body>',
    '<div class="head"><h1>จับคู่สลิปกับบิล</h1><p>Batch: <?= batchRef ?></p></div>',
    '<div id="app">กำลังโหลด...</div>',
    '<script>',
    'var rows=<?!= rows ?>;var slips={},bills={};',
    'rows.forEach(function(r){var sid=r["Slip Ref"],bid=r["เลขที่บิล"];if(!slips[sid])slips[sid]={ref:sid,amount:r["ยอดเงิน"],date:r["วันที่โอน"]};if(!bills[bid])bills[bid]={inv:bid,shop:r["ชื่อร้าน"]};});',
    'var html="";Object.values(slips).forEach(function(s,i){html+=\'<div class="slip"><div style="font-size:12px;color:#888">สลิป #\'+(i+1)+\' · \'+(s.date||"")+\'</div><div class="amt">\'+Number(s.amount).toLocaleString()+\' ฿</div><div class="row"><select data-slip="\'+s.ref+\'"><option value="">— เลือกบิล —</option>\';Object.values(bills).forEach(function(b){html+=\'<option value="\'+b.inv+\'">\'+b.inv+\' · \'+b.shop+\'</option>\';});html+=\'</select></div></div>\';});',
    'html+=\'<button onclick="save()">บันทึกการจับคู่</button>\';',
    'document.getElementById("app").innerHTML=html;',
    'function save(){var pairs=[];document.querySelectorAll("select[data-slip]").forEach(function(s){if(s.value)pairs.push({slip_ref:s.dataset.slip,bill:s.value});});if(!pairs.length){alert("กรุณาเลือกอย่างน้อย 1 คู่");return;}document.querySelector("button").textContent="กำลังบันทึก...";google.script.run.withSuccessHandler(function(){document.body.innerHTML=\'<div class="head"><h1>✅ บันทึกเรียบร้อย</h1></div>\';}).withFailureHandler(function(e){alert("Error: "+e.message);}).saveSlipMatching("<?= batchRef ?>",pairs);}',
    '<\/script></body></html>'
  ].join('');
}

function saveSlipMatching(batchRef, pairs) {
  var ss=SpreadsheetApp.openById(cfg().SHEET_ID_SLIP),sheet=ss.getSheetByName(SH.SLIPS),data=sheet.getDataRange().getValues(),h=data[0];
  var refIdx=h.indexOf('Slip Ref'),invIdx=h.indexOf('เลขที่บิล'),stIdx=h.indexOf('สถานะ'),batchIdx=h.indexOf('batch_ref');
  for (var i=1;i<data.length;i++){
    if(data[i][batchIdx]!==batchRef)continue;
    var matched=pairs.find(function(p){return p.slip_ref===data[i][refIdx]&&p.bill===data[i][invIdx];});
    sheet.getRange(i+1,stIdx+1).setValue(matched?'เรียบร้อย':'ไม่ใช้');
  }
  return { saved:pairs.length };
}

// ═══ EXTERNAL API ══════════════════════════════════════════════════

function verifyWithSlip2Go(blob) {
  var MAX_ATTEMPTS = 3;
  var RETRY_DELAY_MS = 2000;
  var lastError = '';

  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      var payload = {
        checkDuplicate: true,
        checkReceiver: [
          { accountNameTH:'หจก. ไนซ์เซ็นเตอร์ออยล์' },
          { accountNameEN:'NICESENTER O' }
        ],
      };
      var res = UrlFetchApp.fetch('https://connect.slip2go.com/api/verify-slip/qr-image/info', {
        method:'post', headers:{'Authorization':'Bearer '+cfg().SLIP2GO_KEY},
        payload:{ file:blob, payload:JSON.stringify(payload) }, muteHttpExceptions:true,
      });
      var code = res.getResponseCode();
      var body;
      try { body=JSON.parse(res.getContentText()); } catch(e){ body={message:res.getContentText()}; }
      Logger.log('[Slip2Go] attempt='+attempt+' status='+code+' body='+JSON.stringify(body).slice(0,800));
      var msg=((body.message||body.msg||'')).toString(), msgLower=msg.toLowerCase();
      var slipData=(body.data&&body.data.data)||body.data||null;
      var hasSlipData=slipData&&(slipData.amount!==undefined||slipData.transRef||slipData.ref1);
      if (code!==200&&!hasSlipData) {
        lastError = msg||body.error||('HTTP '+code);
        if (attempt < MAX_ATTEMPTS) { Utilities.sleep(RETRY_DELAY_MS); continue; }
        return { success:false, message:lastError };
      }
      if (hasSlipData) {
        var warning='';
        if (msgLower.indexOf('mismatch')!==-1) warning='บัญชีผู้รับไม่ตรง';
        else if (msgLower.indexOf('duplicate')!==-1) warning='สลิปซ้ำ';
        return { success:true, warning:warning, raw_message:msg, data:normalizeSlip2GoData(slipData) };
      }
      lastError = msg||'ไม่สามารถอ่านสลิปได้';
      if (attempt < MAX_ATTEMPTS) { Utilities.sleep(RETRY_DELAY_MS); continue; }
      return { success:false, message:lastError };
    } catch(e) {
      lastError = e.message;
      Logger.log('[Slip2Go] attempt='+attempt+' exception: '+e.message);
      if (attempt < MAX_ATTEMPTS) { Utilities.sleep(RETRY_DELAY_MS); continue; }
    }
  }
  return { success:false, message:lastError };
}

function normalizeSlip2GoData(d) {
  if (!d) return {};
  var sender=d.sender||{},receiver=d.receiver||{};
  var sAcc=sender.account||{},rAcc=receiver.account||{};
  var sBank=sender.bank||{},rBank=receiver.bank||{};
  var rawDate=d.dateTime||d.date||d.transDate||'', dateStr='', timeStr='';
  if (rawDate) {
    try {
      var dt=new Date(rawDate);
      if (!isNaN(dt.getTime())) {
        dateStr=Utilities.formatDate(dt,'Asia/Bangkok','dd/MM/yyyy');
        timeStr=Utilities.formatDate(dt,'Asia/Bangkok','HH:mm:ss');
      }
    } catch(e) {}
  }
  return {
    amount:   parseFloat(d.amount||0),
    sender:   { name:sAcc.name||'', bank:{ name:sBank.name||'' } },
    receiver: { name:rAcc.name||'', bank:{ name:rBank.name||'' } },
    date:dateStr, time:timeStr, ref1:d.transRef||d.ref1||'', raw:d,
  };
}

function fetchLineImage(messageId) {
  try {
    var res=UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/'+messageId+'/content',
      { headers:{'Authorization':'Bearer '+cfg().LINE_TOKEN}, muteHttpExceptions:true });
    if (res.getResponseCode()!==200) return null;
    return res.getBlob().setName('slip_'+messageId+'.jpg');
  } catch(e) { return null; }
}

function replyLine(replyToken, messages) {
  if (!replyToken||!messages||!messages.length) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method:'post',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg().LINE_TOKEN},
      payload:JSON.stringify({ replyToken:replyToken, messages:messages }),
      muteHttpExceptions:true,
    });
  } catch(e) { console.error('[replyLine]',e.message); }
}

// ═══ DSR REVIEW PAGE ═══════════════════════════════════════════════

function serveDsrReviewPage(email) {
  if (!email) return HtmlService.createHtmlOutput('<div style="padding:40px;font-family:sans-serif;text-align:center"><h2>กรุณาระบุ email ใน URL</h2></div>');
  var name = getUserDisplayName(email);
  var t    = HtmlService.createTemplate(dsrReviewHtml());
  t.dsrEmail = email; t.dsrName = name;
  return t.evaluate().setTitle('DSR Review — NCO')
    .addMetaTag('viewport','width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getDsrWeekSlips(email) {
  try {
    if (!email) return { rows:[],total:0,count:0 };
    var ss=SpreadsheetApp.openById(cfg().SHEET_ID_SLIP),sheet=ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { rows:[],total:0,count:0 };
    var data=sheet.getDataRange().getValues();
    if (data.length<2) return { rows:[],total:0,count:0 };
    var h=data[0];
    function findCol(names){for(var ni=0;ni<names.length;ni++)for(var hi=0;hi<h.length;hi++)if(String(h[hi]).trim().toLowerCase()===names[ni].toLowerCase())return hi;return -1;}
    var eIdx=findCol(['Email','email','DSR Email','dsr_email']);
    var dIdx=findCol(['วันที่ส่งสลิป','วันที่ส่ง','created_at']);
    var stIdx=findCol(['สถานะ','status']);
    if (eIdx<0) return { rows:[],total:0,count:0,debug:'email col not found' };
    var weekStart=getMondayOfWeek(), rows=[];
    for (var i=1;i<data.length;i++) {
      var rowEmail=String(data[i][eIdx]||'').trim().toLowerCase();
      if (rowEmail!==email.toLowerCase()) continue;
      var st=stIdx>=0?String(data[i][stIdx]||''):'';
      if (st==='ไม่ใช้') continue;
      if (dIdx>=0&&data[i][dIdx]) {
        var rawDate=data[i][dIdx],dt=rawDate instanceof Date?rawDate:new Date(rawDate);
        if (!isNaN(dt.getTime())&&dt<weekStart) continue;
      }
      var obj={_row:i+1};
      h.forEach(function(k,j){var v=data[i][j];obj[k]=(v instanceof Date)?(isNaN(v.getTime())?'':v.toISOString()):v;});
      rows.push(obj);
    }
    rows.sort(function(a,b){return new Date(a['วันที่โอน']||0)-new Date(b['วันที่โอน']||0);});
    var total=rows.reduce(function(s,r){return s+(parseFloat(r['ยอดเงิน'])||0);},0);
    return { rows:rows,total:total,count:rows.length };
  } catch(err) { return { rows:[],total:0,count:0,error:err.message }; }
}

function saveDsrEdits(edits) {
  if (!Array.isArray(edits)) throw new Error('edits must be array');
  var ss=SpreadsheetApp.openById(cfg().SHEET_ID_SLIP),sheet=ss.getSheetByName(SH.SLIPS);
  var h=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  var idxMap={'รหัสลูกค้า':h.indexOf('รหัสลูกค้า')+1,'ชื่อร้าน':h.indexOf('ชื่อร้าน')+1,'เลขที่บิล':h.indexOf('เลขที่บิล')+1,'ยอดเงิน':h.indexOf('ยอดเงิน')+1,'note':h.indexOf('note')>0?h.indexOf('note')+1:null};
  if (!idxMap['note']) { var col=sheet.getLastColumn()+1;sheet.getRange(1,col).setValue('note');sheet.getRange(1,col).setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');idxMap['note']=col; }
  var updated=0;
  edits.forEach(function(e){if(!e.row)return;Object.keys(e.fields||{}).forEach(function(col){if(!idxMap[col])return;sheet.getRange(e.row,idxMap[col]).setValue(e.fields[col]);});updated++;});
  return { updated:updated };
}

function dsrReviewHtml() {
  return '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet"><style>body{font-family:Sarabun,sans-serif;margin:0;background:#F7F5F2;color:#1A1A1A}.hdr{background:#E8631A;color:#fff;padding:14px 20px;position:sticky;top:0;z-index:10}.hdr h1{font-size:17px;font-weight:700;margin:0}.wrap{padding:12px 16px;max-width:1100px;margin:0 auto}.stats{background:#fff;border-radius:10px;padding:14px 18px;margin-bottom:12px;border:1px solid rgba(0,0,0,.08);display:flex;gap:32px}.n{font-size:24px;font-weight:700;color:#E8631A}.l{font-size:11px;color:#888;text-transform:uppercase}table{width:100%;background:#fff;border-collapse:collapse;border:1px solid rgba(0,0,0,.08);border-radius:8px;overflow:hidden}th{background:#F1EEE9;padding:8px 6px;text-align:left;font-weight:600;font-size:11px;color:#555;border-bottom:2px solid #E8631A;white-space:nowrap}td{padding:5px 6px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:middle;font-size:13px}td input{width:100%;border:1px solid transparent;padding:3px 5px;border-radius:4px;font-family:Sarabun,sans-serif;font-size:13px;background:transparent;box-sizing:border-box}td input:focus{outline:none;background:#fff;border-color:#E8631A}.num{text-align:right}.tr-warn{background:#FEF6EE}.tr-e{background:#FFFDE7}.tr-ok{background:#fff}.st{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}.st-ok{background:#E2F4ED;color:#007B40}.st-wait{background:#FEF0E7;color:#C65410}.st-e{background:#FFF8E1;color:#F57F17}.st-na{background:#FEE9E9;color:#B61010}.bill-sel{padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-family:Sarabun,sans-serif;font-size:12px;min-width:160px}.btn-assign{background:#007B40;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;font-family:Sarabun,sans-serif;cursor:pointer}.btn-assign:disabled{opacity:.4;cursor:not-allowed}.act{position:sticky;bottom:0;background:#fff;padding:10px 16px;border-top:1px solid rgba(0,0,0,.1);display:flex;gap:8px}.btn{flex:1;padding:11px;border:none;border-radius:8px;font-size:14px;font-weight:600;font-family:Sarabun,sans-serif;cursor:pointer}.btn-g{background:#007B40;color:#fff}.btn-w{background:#fff;color:#666;border:1px solid #ddd}.toast{position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#1A1A1A;color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}.toast.on{opacity:1}</style></head><body><div class="hdr"><h1>📋 ใบสรุปเงินสัปดาห์นี้</h1><p>คุณ<?= dsrName ?> · <?= dsrEmail ?></p></div><div class="wrap"><div class="stats"><div><div class="l">จำนวน</div><div class="n" id="cnt">—</div></div><div><div class="l">ยอดรวม</div><div class="n" id="sum">—</div></div></div><div id="app" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:#888">กำลังโหลด...</div></div><div class="act"><button class="btn btn-w" onclick="doReload()">รีเฟรช</button><button class="btn btn-g" id="btn-s" onclick="doSubmit()">บันทึก + สร้าง Cover Sheet</button></div><div class="toast" id="t"></div><script>var EM="<?= dsrEmail ?>";var rows=[],edits={};function toast(m,d){var e=document.getElementById("t");e.textContent=m;e.className="toast on";setTimeout(function(){e.className="toast"},d||2500);}function doReload(){if(Object.keys(edits).length&&!confirm("มีการแก้ไขที่ยังไม่ได้บันทึก — โหลดใหม่?"))return;load();}function load(){document.getElementById("app").innerHTML="<div style=\'padding:40px;text-align:center;color:#888\'>กำลังโหลด...</div>";google.script.run.withSuccessHandler(render).withFailureHandler(function(e){document.getElementById("app").innerHTML="<div style=\'padding:24px;color:#c00\'>❌ "+e.message+"</div>";}).getDsrWeekSlips(EM);}function render(d){if(!d||d.error){document.getElementById("app").innerHTML="<div style=\'padding:24px;color:#c00\'>❌ "+(d?d.error:"ไม่ได้รับข้อมูล")+"</div>";return;}rows=d.rows||[];edits={};document.getElementById("cnt").textContent=rows.length;document.getElementById("sum").textContent=Number(d.total||0).toLocaleString("th-TH")+" ฿";if(!rows.length){document.getElementById("app").innerHTML="<div style=\'padding:40px;text-align:center;color:#888\'>ยังไม่มีสลิปสัปดาห์นี้</div>";return;}var h="<table><thead><tr><th style=\'width:3%\'>#</th><th style=\'width:9%\'>วันที่โอน</th><th style=\'width:6%\'>เวลาโอน</th><th style=\'width:6%\'>รหัส</th><th style=\'width:17%\'>ร้าน</th><th style=\'width:10%\'>เลขบิล</th><th style=\'width:7%;text-align:right\'>ยอด(฿)</th><th style=\'width:8%\'>สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>";rows.forEach(function(r,i){var st=r["สถานะ"]||"";var isE=(r["scenario"]==="E"||st==="รอระบุบิล");var tc=isE?"tr-e":(st==="ยอดไม่ตรง"||st==="รอระบุ")?"tr-warn":"tr-ok";var sc=isE?"st-e":st==="เรียบร้อย"?"st-ok":st==="รอระบุ"?"st-wait":"st-na";var sd=fd(r["วันที่โอน"]);var sv=r["เวลาโอน"]?String(r["เวลาโอน"]).slice(0,5):"";var af=(parseFloat(r["ยอดเงิน"])||0).toLocaleString("th-TH");h+="<tr class=\'"+tc+"\' data-row=\'"+r._row+"\'><td>"+(i+1)+"</td><td class=\'ro\'>"+sd+"</td><td class=\'ro\'>"+sv+"</td>";h+=inp(r,"รหัสลูกค้า");h+="<td class=\'ro\'>"+(r["ชื่อร้าน"]||"")+"</td>";if(isE&&!r["เลขที่บิล"]){h+="<td><div style=\'display:flex;gap:4px;align-items:center\'><select class=\'bill-sel\' onchange=\'onSelChange(this)\' data-row=\'"+r._row+"\'><option value=\'\'>— กำลังโหลด... —</option></select><button class=\'btn-assign\' disabled onclick=\'assignBill(this)\' data-row=\'"+r._row+"\'>บันทึก</button></div></td>";}else{h+=inp(r,"เลขที่บิล");}h+="<td class=\'num\'>"+af+"</td><td><span class=\'st "+sc+"\'>"+(isE&&!r["เลขที่บิล"]?"รอระบุบิล":st||"-")+"</span></td>";h+=inp(r,"note");h+="</tr>";});h+="</tbody></table>";document.getElementById("app").innerHTML=h;rows.forEach(function(r){if(r["scenario"]==="E"&&!r["เลขที่บิล"])loadBillOptions(r._row,r["รหัสลูกค้า"]);});}function loadBillOptions(rowIndex,custCode){if(!custCode)return;google.script.run.withSuccessHandler(function(res){var sel=document.querySelector("select.bill-sel[data-row=\'"+rowIndex+"\']");if(!sel)return;if(!res||!res.ok){sel.innerHTML="<option value=\'\'>ไม่พบบิล</option>";return;}var opts="<option value=\'\'>— เลือกเลขบิล —</option>";res.bills.forEach(function(b){var ovTxt=b.overdueDays===null?"":b.overdueDays>0?" ⚠️เกิน"+b.overdueDays+"วัน":b.overdueDays>-7?" 🟡อีก"+Math.abs(b.overdueDays)+"วัน":"";opts+="<option value=\'"+esc(b.invoiceNo)+"\'>"+esc(b.invoiceNo)+" · ฿"+fmtAmt(b.amount)+(b.dueDate?" · "+fmtShortDate(b.dueDate):"")+ovTxt+"</option>";});sel.innerHTML=opts;}).withFailureHandler(function(){}).getBillsForPendingRow(custCode);}function onSelChange(sel){var btn=sel.parentElement.querySelector(".btn-assign");btn.disabled=!sel.value;}function assignBill(btn){var container=btn.parentElement,sel=container.querySelector(".bill-sel"),rowIndex=parseInt(btn.dataset.row),invoice=sel.value;if(!invoice)return;btn.disabled=true;btn.textContent="⏳";google.script.run.withSuccessHandler(function(res){if(res&&res.ok){var tr=btn.closest("tr");tr.className="tr-ok";var stTd=tr.querySelectorAll("td")[7];if(stTd)stTd.innerHTML="<span class=\'st st-ok\'>เรียบร้อย</span>";var billTd=tr.querySelectorAll("td")[5];if(billTd)billTd.innerHTML="<span style=\'font-weight:700\'>"+esc(invoice)+"</span>";toast("✅ บันทึกเลขบิล "+invoice+" แล้ว");}else{btn.disabled=false;btn.textContent="บันทึก";toast("❌ "+(res?res.error:"เกิดข้อผิดพลาด"));}}).withFailureHandler(function(e){btn.disabled=false;btn.textContent="บันทึก";toast("❌ "+e.message);}).assignBillToSlipRow(rowIndex,invoice);}function inp(r,k){var v=String(r[k]||"").replace(/"/g,"&quot;");return "<td><input data-k=\'"+k+"\' value=\'"+v+"\' oninput=\'ed(this)\'></td>";}function ed(el){var tr=el.closest("tr"),row=tr.dataset.row,k=el.dataset.k;if(!edits[row])edits[row]={row:parseInt(row),fields:{}};edits[row].fields[k]=el.value;}function fd(s){var mo=["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];try{var dt=new Date(s);if(isNaN(dt.getTime()))return s;var b=new Date(dt.toLocaleString("en-US",{timeZone:"Asia/Bangkok"}));return b.getDate()+" "+mo[b.getMonth()+1]+" "+String(b.getFullYear()+543).slice(-2);}catch(e){return s;}}function fmtShortDate(iso){var mo=["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];try{var dt=new Date(iso);var b=new Date(dt.toLocaleString("en-US",{timeZone:"Asia/Bangkok"}));return b.getDate()+" "+mo[b.getMonth()+1];}catch(e){return iso;}}function fmtAmt(n){return Number(n).toLocaleString("th-TH");}function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}function doSubmit(){var bs=document.getElementById("btn-s");bs.disabled=true;bs.textContent="กำลังบันทึก...";var list=Object.values(edits);function pdf(){bs.textContent="กำลังสร้าง PDF...";google.script.run.withSuccessHandler(function(res){bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";if(res&&res.url){toast("✅ สร้างเรียบร้อย");window.open(res.url,"_blank");}else toast("⚠️ สร้างไม่ได้");}).withFailureHandler(function(e){bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";toast("❌ "+e.message);}).generateCoverSheetPdf(EM);}if(!list.length){pdf();return;}google.script.run.withSuccessHandler(function(){edits={};pdf();}).withFailureHandler(function(e){bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";toast("❌ "+e.message);}).saveDsrEdits(list);}load();<\/script></body></html>';
}

// ═══ PDF COVER SHEET ═══════════════════════════════════════════════

function generateCoverSheetPdf(email) {
  if (!email) throw new Error('missing email');
  var data=getDsrWeekSlips(email), rows=data.rows||[];
  if (!rows.length) throw new Error('ไม่มีสลิปสัปดาห์นี้');
  var dsrName=getUserDisplayName(email), today=Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy');
  var html=buildCoverSheetHtml(rows, dsrName, today, data.total);
  var blob=Utilities.newBlob(html,'text/html','cover.html').getAs('application/pdf');
  var filename='ใบสรุปเงิน_'+dsrName+'_'+today.replace(/\//g,'-')+'.pdf';
  blob.setName(filename);
  var folder=ensureCoverSheetFolder(), file=folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url:file.getUrl(), downloadUrl:'https://drive.google.com/uc?export=download&id='+file.getId(), filename:filename, count:rows.length, total:data.total };
}

function ensureCoverSheetFolder() {
  var folders=DriveApp.getFoldersByName('NCO_CoverSheets');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('NCO_CoverSheets');
}

function buildCoverSheetHtml(rows, dsrName, today, total) {
  var logoHtml=getLogoBase64Html();
  var tableRows=rows.map(function(r,i){
    var amt=parseMoneyCell(r['ยอดเงิน']), note=r['note']||'';
    var display=formatDateThai2(r['วันที่โอน']), timeStr=r['เวลาโอน']?String(r['เวลาโอน']).slice(0,5):'';
    if (timeStr) display+=' '+timeStr;
    return '<tr><td class="c">'+(i+1)+'</td><td>'+escapeHtmlSrv(r['รหัสลูกค้า']||'')+'&nbsp;&nbsp;'+escapeHtmlSrv(r['ชื่อร้าน']||'')+'</td><td class="c">'+escapeHtmlSrv(r['เลขที่บิล']||'')+'</td><td class="r">'+formatMoney(parseMoneyCell(r['ยอดบิล']||amt))+'</td><td class="r"></td><td class="r">'+formatMoney(amt)+'</td><td class="c">'+escapeHtmlSrv(display)+'</td><td class="c"></td><td></td><td></td><td>'+escapeHtmlSrv(note)+'</td></tr>';
  }).join('');
  var emptyRows='';
  for (var i=rows.length;i<15;i++) emptyRows+='<tr><td class="c">'+(i+1)+'</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';
  return ['<!DOCTYPE html><html><head><meta charset="UTF-8">','<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">','<style>@page{size:A4 landscape;margin:7mm}body,table,th,td,div,span,p{font-family:"Sarabun",sans-serif!important}*{box-sizing:border-box}body{font-size:16px;color:#000;margin:0}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;border-bottom:1px solid #000;padding-bottom:4px}.title{font-size:17px;font-weight:700}.meta{font-size:14px;text-align:center}.meta span{margin:0 14px}.logo img{height:44px;object-fit:contain}table.main{width:100%;border-collapse:collapse;table-layout:fixed}table.main th{background:#f0f0f0;font-size:14px;font-weight:700;border:0.5px solid #888;padding:4px 3px;text-align:center;white-space:nowrap}table.main td{border:0.5px solid #888;padding:4px 5px;font-size:15px;vertical-align:middle;overflow:hidden}.c{text-align:center}.r{text-align:right}.sub{display:flex;justify-content:flex-end;gap:0;margin-top:5px}.box{border:0.5px solid #888;padding:3px 8px;font-size:14px;font-weight:600;min-width:110px;text-align:right}.foot{margin-top:12px;display:flex;align-items:flex-end;gap:16px}.note-area{width:40%}.note-label{font-size:13px}.note-line{border-bottom:1px dotted #000;height:20px;margin-top:2px}.sig{min-width:200px;padding-left:20px}.sig-line{border-top:1px dotted #000;margin-top:30px;padding-top:3px;font-size:13px;text-align:center}</style></head><body>',
    '<div class="top"><div class="title">ใบสรุปเงินสด / โอน / เช็ค</div><div class="meta"><span>วันที่: <b>'+today+'</b></span><span>DSR: <b>'+escapeHtmlSrv(dsrName)+'</b></span></div><div class="logo">'+logoHtml+'</div></div>',
    '<table class="main"><colgroup><col style="width:4%"><col style="width:22%"><col style="width:9%"><col style="width:8%"><col style="width:7%"><col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col></colgroup>',
    '<thead><tr><th rowspan="2">No.</th><th rowspan="2">รหัส - ชื่อ ลูกค้า</th><th rowspan="2">เลขที่บิล</th><th rowspan="2">ยอดบิล</th><th colspan="6">รายการเก็บ เงินสด / โอน / เช็ค</th><th rowspan="2">หมายเหตุ</th></tr><tr><th>เงินสด</th><th>ยอดโอน/เช็ค</th><th>วันที่โอน/เช็ค</th><th>เลขที่เช็ค</th><th>ธนาคาร</th><th>สาขา</th></tr></thead>',
    '<tbody>'+tableRows+emptyRows+'</tbody></table>',
    '<div class="sub"><div class="box">รวมยอดเงินสด: <b>0</b></div><div class="box">ยอดเก็บเงินรวม: <b>'+formatMoney(total)+'</b></div></div>',
    '<div class="foot"><div class="note-area"><div class="note-label">Note :</div><div class="note-line"></div></div><div class="sig"><div class="sig-line">ลงชื่อผู้ส่งเงิน</div></div></div>',
    '</body></html>'].join('');
}

function formatDateThai2(v) {
  if (!v) return '';
  var thMonths=['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  try {
    var s=String(v).trim(), m1=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m1) return parseInt(m1[1])+' '+thMonths[parseInt(m1[2])]+' '+String(parseInt(m1[3])+543).slice(-2);
    var dt=new Date(s);if(isNaN(dt.getTime()))return s;
    var bkk=new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
    return bkk.getDate()+' '+thMonths[bkk.getMonth()+1]+' '+String(bkk.getFullYear()+543).slice(-2);
  } catch(e){ return String(v); }
}

function getLogoBase64Html() {
  try {
    var logoName='Nice Center Oil x Castrol - Business Card ใส.png', logoBlob=null;
    var folders=DriveApp.getFoldersByName('NCO_CoverSheets');
    if (folders.hasNext()){var files=folders.next().getFilesByName(logoName);if(files.hasNext())logoBlob=files.next().getBlob();}
    if (!logoBlob){var allFiles=DriveApp.getFilesByName(logoName);if(allFiles.hasNext())logoBlob=allFiles.next().getBlob();}
    if (!logoBlob) return '<span style="font-size:15px;font-weight:700;color:#E8631A">NICE CENTER</span>&nbsp;<span style="font-size:15px;font-weight:700;color:#E8212A">Castrol</span>';
    return '<img src="data:'+logoBlob.getContentType()+';base64,'+Utilities.base64Encode(logoBlob.getBytes())+'" style="height:44px;">';
  } catch(e){ return '<span style="font-size:15px;font-weight:700;color:#E8212A">Castrol</span>'; }
}

function formatMoney(n) {
  var v=parseFloat(n)||0;if(!v)return'';
  return v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2});
}

function escapeHtmlSrv(s) {
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══ HELPERS ═══════════════════════════════════════════════════════

function getAllDebts() {
  var results = [];

  // ── 1. บิลค้างจ่าย (บิลหลัก) ────────────────────────────────
  try {
    var ss    = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);
    var sheet = ss.getSheetByName(SH.DEBTS);
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      if (data.length >= 2) {
        var h = data[0];
        data.slice(1).filter(function(r){ return r[0]; }).forEach(function(row){
          var obj = {}; h.forEach(function(k,i){ obj[k]=row[i]; });
          results.push(obj);
        });
      }
    }
  } catch(e) { console.error('[getAllDebts-main] '+e.message); }

  // ── 2. Pay sheet (บิลหน้าร้าน) ──────────────────────────────
  try {
    var STORE_SS_ID = '1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY';
    var storeSs  = SpreadsheetApp.openById(STORE_SS_ID);
    var storeSh  = storeSs.getSheetByName('Pay');
    if (storeSh) {
      var sData = storeSh.getDataRange().getValues();
      if (sData.length >= 2) {
        var sh = sData[0];
        // หา column index
        function sIdx(names) {
          for (var ni=0;ni<names.length;ni++)
            for (var hi=0;hi<sh.length;hi++)
              if (String(sh[hi]).trim()===names[ni]) return hi;
          return -1;
        }
        var sCust   = sIdx(['รหัสลูกค้า']); if(sCust<0)  sCust=1;
        var sInv    = sIdx(['เลขที่บิล']);   if(sInv<0)   sInv=2;
        var sRemain = sIdx(['ยอดคงเหลือ','คงเหลือ']); if(sRemain<0) sRemain=5;
        var sShop   = sIdx(['ลูกค้า','ชื่อลูกค้า']); 
        var sDue    = sIdx(['ถึงกำหนดชำระ']);

        for (var sr=1; sr<sData.length; sr++) {
          var rowCust   = String(sData[sr][sCust]||'').trim();
          var rowInv    = String(sData[sr][sInv]||'').trim();
          var rowRemain = parseFloat(String(sData[sr][sRemain]||0).replace(/[^0-9.\-]/g,''))||0;
          if (!rowCust || !rowInv) continue;
          if (rowRemain <= 0) continue; // ชำระครบแล้ว ข้ามไป

          var rowShop = sShop>=0 ? String(sData[sr][sShop]||'').trim() : '';
          var rowDue  = sDue>=0  ? sData[sr][sDue] : null;
          var dueStr  = '';
          if (rowDue instanceof Date && !isNaN(rowDue.getTime())) {
            dueStr = rowDue.toISOString().slice(0,10);
          } else if (rowDue) {
            try { var dt=new Date(rowDue); if(!isNaN(dt.getTime())) dueStr=dt.toISOString().slice(0,10); } catch(e){}
          }

          // map ให้ตรงกับ format ของ บิลค้างจ่าย
          results.push({
            'รหัสหลัก':       rowCust,
            'InvoiceNo':      rowInv,
            'ยอดคงเหลือ':     rowRemain,
            'ยอดบิล':         rowRemain,
            'ชื่อลูกค้าหลัก': rowShop,
            'Sale':            rowShop,
            'DueDate':         dueStr,
            '_source':         'store', // tag ว่ามาจาก Pay sheet
          });
        }
        console.log('[getAllDebts] Pay sheet added, total results='+results.length);
      }
    }
  } catch(e) { console.error('[getAllDebts-store] '+e.message); }

  return results;
}

function getDsrEmailFromLine(userId) {
  try {
    var ss=SpreadsheetApp.openById(cfg().SHEET_ID_OPS),s=ss.getSheetByName(SH.LINEMAP);
    if(!s)return null;
    var data=s.getDataRange().getValues();
    for(var i=1;i<data.length;i++){if(data[i][0]===userId)return data[i][1]||null;}
    return null;
  } catch(e){return null;}
}

function getUserDisplayName(email) {
  try {
    var ss=SpreadsheetApp.openById(cfg().SHEET_ID_OPS),s=ss.getSheetByName(SH.USERS),data=s.getDataRange().getValues();
    var eIdx=data[0].indexOf('email'),nIdx=data[0].indexOf('display_name');
    for(var i=1;i<data.length;i++){if(String(data[i][eIdx]).toLowerCase()===email.toLowerCase())return data[i][nIdx];}
    return email;
  } catch(e){return email;}
}

function parseMoneyCell(v) {
  if(v===null||v===undefined)return 0;if(typeof v==='number')return v;
  return parseFloat(String(v).replace(/[^0-9.\-]/g,''))||0;
}

function formatAmount(n) {
  var v=parseFloat(n)||0;
  return v===Math.floor(v)?v.toLocaleString('en-US'):v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function formatDateThai(d) { return Utilities.formatDate(d,'Asia/Bangkok','d/M/yyyy HH:mm'); }
function tsString()        { return Utilities.formatDate(new Date(),'Asia/Bangkok','yyyy-MM-dd HH:mm:ss'); }

function parseThaiDate(dateStr) {
  if(!dateStr)return null;if(dateStr instanceof Date)return dateStr;
  try{var m=String(dateStr).trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!m)return null;return new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]));}catch(e){return null;}
}

function getMondayOfWeek() {
  var d=new Date(),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);
  var mon=new Date(d.setDate(diff));mon.setHours(0,0,0,0);return mon;
}

// ═══ SETUP ═════════════════════════════════════════════════════════

function setupAll() {
  var ss = SpreadsheetApp.openById(cfg().SHEET_ID_SLIP);

  // 1. สร้าง/อัปเดต PENDING_SLIPS sheet (รวม cust_code, invoice_no)
  ensurePendingSheet(ss);
  Logger.log('✅ PENDING_SLIPS ready');

  // 2. เพิ่ม scenario + batch_ref ใน Slip2Go ถ้ายังไม่มี
  var slipSheet = ss.getSheetByName(SH.SLIPS);
  if (slipSheet) {
    var headers = slipSheet.getRange(1,1,1,slipSheet.getLastColumn()).getValues()[0];
    var toAdd   = ['scenario','batch_ref','Email','note'];
    toAdd.forEach(function(col){
      if (headers.indexOf(col) < 0) {
        var nextCol = slipSheet.getLastColumn() + 1;
        slipSheet.getRange(1, nextCol).setValue(col);
        slipSheet.getRange(1, nextCol).setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');
        Logger.log('Added column: ' + col);
      }
    });
  }

  // 3. สร้าง LINE_USER_MAP ใน DSR Operation
  var opsSs   = SpreadsheetApp.openById(cfg().SHEET_ID_OPS);
  var mapSheet = opsSs.getSheetByName(SH.LINEMAP);
  if (!mapSheet) {
    mapSheet = opsSs.insertSheet(SH.LINEMAP);
    mapSheet.getRange(1,1,1,3).setValues([['line_user_id','email','registered_at']]);
    mapSheet.getRange(1,1,1,3).setBackground('#007B40').setFontColor('#fff').setFontWeight('bold');
    Logger.log('Created LINE_USER_MAP');
  }

  Logger.log('✅ Setup complete v3');
  return 'Setup complete v3';
}

function testConfig() {
  var c = cfg();
  Object.keys(c).forEach(function(k){
    var v=c[k];Logger.log(k+': '+(v?(v.length>30?v.slice(0,20)+'...':v):'(empty)'));
  });
}

/**
 * ตั้งค่า Script Properties สำหรับ deployment ใหม่
 *
 * วิธีใช้: อย่า hardcode credentials ในฟังก์ชันนี้
 * ให้ไปที่ Apps Script Editor → Project Settings → Script Properties
 * แล้วเพิ่ม key-value ดังนี้:
 *
 *   LINE_CHANNEL_TOKEN   = <token จาก LINE Developers Console>
 *   LINE_CHANNEL_SECRET  = <secret จาก LINE Developers Console>
 *   SLIP2GO_API_KEY      = <API key จาก Slip2Go>
 *   SPREADSHEET_ID_SLIP  = <Spreadsheet ID สำหรับ Slip2Go data>
 *   SPREADSHEET_ID       = <Spreadsheet ID สำหรับ Operations/DSR data>
 *   PORTAL_URL           = <Web App URL หลัง deploy>
 *
 * ฟังก์ชันนี้ใช้ตรวจสอบว่าตั้งค่าครบหรือยัง
 */
function setProps() {
  var required = [
    'LINE_CHANNEL_TOKEN',
    'LINE_CHANNEL_SECRET',
    'SLIP2GO_API_KEY',
    'SPREADSHEET_ID_SLIP',
    'SPREADSHEET_ID',
    'PORTAL_URL',
  ];
  var p = PropertiesService.getScriptProperties();
  var missing = required.filter(function(k) { return !p.getProperty(k); });
  if (missing.length === 0) {
    Logger.log('✅ Script Properties ครบถ้วน');
  } else {
    Logger.log('❌ ยังไม่ได้ตั้งค่า: ' + missing.join(', '));
    Logger.log('ไปที่ Apps Script Editor → Project Settings → Script Properties');
  }
}