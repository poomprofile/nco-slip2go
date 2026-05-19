function importCSV() {
  // นำ File ID ที่ได้จากขั้นที่ 1 มาใส่ในเครื่องหมายคำพูดด้านล่าง
  var fileId = '1Z839JjEB_EGS8FhopFD94SwJFCdmoSTj'; 
  
  var csvFile = DriveApp.getFileById(fileId);
  var csvData = Utilities.parseCsv(csvFile.getBlob().getDataAsString('windows-874'));
// *** แก้ไขบรรทัดนี้: เปลี่ยนมาใช้ getSheetByName แล้วใส่ชื่อชีตที่ใช้รับข้อมูลดิบของ sales_raw ***
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("บิลค้างจ่าย");
  
  sheet.clear(); // ล้างข้อมูลเก่าของเมื่อวาน
  sheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData); // วางข้อมูลใหม่
}

function downloadDSRPdf() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  
// 1. ดึงข้อมูลวันที่ และตัดเว้นวรรค
  var dateRaw = sheet.getRange("F1").getDisplayValue().trim(); // เติม .trim() ตรงนี้
  var dateStr = dateRaw.replace(/\//g, ""); 
  
  // 2. ดึงข้อมูลชื่อ และตัดเว้นวรรค
  var dsrRaw = sheet.getRange("H1").getDisplayValue().trim(); // เติม .trim() ตรงนี้
  var dsrName = dsrRaw;
  if (dsrRaw.includes(":")) {
    dsrName = dsrRaw.split(":")[1].trim(); 
  }
  
  // ประกอบชื่อไฟล์
  var fileName = "สรุปบิล-" + dsrName + "-" + dateStr + ".pdf";
  
  // ตั้งค่าการ Export PDF
  // r1=0 (แถว 1), r2=30 (แถว 30), c1=0 (คอลัมน์ A), c2=12 (คอลัมน์ L)
  // ตั้งค่าการ Export PDF ใหม่ แก้หน้าล้นและขยายฟอนต์
  var url = "https://docs.google.com/spreadsheets/d/" + ss.getId() + "/export?" +
            "format=pdf" +
            "&portrait=false" +     // แนวนอน
            "&size=A4" +            // ขนาด A4
            "&scale=1" +            // ขนาด 100% (Normal) ไม่ย่อ
            "&top_margin=0.25" +    // ลดขอบบน
            "&bottom_margin=0.25" + // ลดขอบล่าง
            "&left_margin=0.25" +   // ลดขอบซ้าย
            "&right_margin=0.25" +  // ลดขอบขวา
            "&gridlines=false" +    
            "&gid=" + sheet.getSheetId() +
            "&r1=0&r2=29&c1=0&c2=12";
  
  var token = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  
  var blob = response.getBlob();
  var base64 = Utilities.base64Encode(blob.getBytes());
  
  var html = `
    <script>
      var a = document.createElement('a');
      a.href = 'data:application/pdf;base64,' + '${base64}';
      a.download = '${fileName}';
      a.click();
      setTimeout(function() { google.script.host.close(); }, 100);
    </script>
    <body style="font-family: sans-serif; text-align: center; margin-top: 20px;">
      กำลังดาวน์โหลดไฟล์...<br>กรุณาเซฟลงโฟลเดอร์ OneDrive ของคุณ
    </body>
  `;
  
  var ui = HtmlService.createHtmlOutput(html).setWidth(300).setHeight(100);
  SpreadsheetApp.getUi().showModalDialog(ui, 'สร้างไฟล์ PDF สำเร็จ');
}