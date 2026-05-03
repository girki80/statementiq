/**
 * buildStyledXLSX — Generates a professionally formatted bank statement Excel
 * that replicates the JOPAR BROTHERS format exactly:
 *
 * Row 1: Company name — dark navy header (003366) white bold text, merged
 * Row 2: Account info — light blue bg, centered
 * Row 3: Empty spacer
 * Row 4: Column headers — dark navy bg, white bold, centered
 * Row 5+: Data rows — alternating white/light grey, numbers right-aligned #,##0.00
 * Last row: TOTALS — light green bg (E2EFDA), bold
 * Frozen pane at row 5
 */

const ExcelJS = require("exceljs");

const COLORS = {
  HEADER_BG:   "003366",   // dark navy (header row & col headers)
  HEADER_FG:   "FFFFFFFF", // white text
  SUBHEAD_BG:  "DAEEF3",   // light blue (account info row)
  SUBHEAD_FG:  "FF000000", // black text
  TOTALS_BG:   "E2EFDA",   // light green (totals row)
  TOTALS_FG:   "FF000000",
  ROW_ALT_BG:  "F2F2F2",   // alternating row light grey
  ROW_ODD_BG:  "FFFFFFFF", // white
  BORDER_COLOR:"CCCCCC",
};

const FONT_NAME = "Arial";

// Detect which columns are numeric (money) based on header text
const MONEY_KEYWORDS = /pay in|pay out|balance|debit|credit|amount|total|charge|fee|withdrawal|deposit/i;
const DATE_KEYWORDS  = /date/i;

function isMoneyCol(header) { return MONEY_KEYWORDS.test(header); }
function isDateCol(header)  { return DATE_KEYWORDS.test(header); }

function borderStyle() {
  return {
    top:    { style: "thin", color: { argb: "FF" + COLORS.BORDER_COLOR } },
    bottom: { style: "thin", color: { argb: "FF" + COLORS.BORDER_COLOR } },
    left:   { style: "thin", color: { argb: "FF" + COLORS.BORDER_COLOR } },
    right:  { style: "thin", color: { argb: "FF" + COLORS.BORDER_COLOR } },
  };
}

/**
 * @param {Object} opts
 * @param {string}   opts.companyName       — "JOPAR BROTHERS PHARMACEUTICAL LTD"
 * @param {string}   opts.accountInfo       — "Account: 5600149747 | Currency: NGN | ..."
 * @param {string}   opts.sheetName         — "2024"
 * @param {string[]} opts.headers           — ["Transaction Date","Value Date","Description","Pay In (₦)","Pay Out (₦)","Balance (₦)"]
 * @param {Array[]}  opts.rows              — array of arrays matching headers order
 * @param {Object}   opts.totals            — { "Pay In (₦)": 5000000, "Pay Out (₦)": 4900000 }
 * @param {string}   [opts.firmName]        — white-label firm name for footer
 * @returns {Promise<Buffer>}               — xlsx buffer
 */
async function buildStyledXLSX({ companyName, accountInfo, sheetName, headers, rows, totals = {}, firmName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator   = firmName || "StatementIQ";
  wb.created   = new Date();
  wb.modified  = new Date();

  const ws = wb.addWorksheet(sheetName || "Statement", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const numCols = headers.length;
  const lastCol = String.fromCharCode(64 + numCols); // A=65

  // ── Column widths ──────────────────────────────────────────────────────────
  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    if (isDateCol(h))       col.width = 15;
    else if (isMoneyCol(h)) col.width = 18;
    else if (i === 2)       col.width = 55; // description col
    else                    col.width = 18;
  });

  // ── Row 1: Company + year header ──────────────────────────────────────────
  ws.getRow(1).height = 22;
  const titleCell = ws.getCell("A1");
  titleCell.value = `${companyName} - BANK STATEMENT ${sheetName}`;
  titleCell.font  = { name: FONT_NAME, bold: true, size: 12, color: { argb: COLORS.HEADER_FG } };
  titleCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.HEADER_BG } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.mergeCells(`A1:${lastCol}1`);

  // ── Row 2: Account info ────────────────────────────────────────────────────
  ws.getRow(2).height = 16;
  const infoCell = ws.getCell("A2");
  infoCell.value = accountInfo;
  infoCell.font  = { name: FONT_NAME, size: 10, color: { argb: "FF000000" } };
  infoCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.SUBHEAD_BG } };
  infoCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.mergeCells(`A2:${lastCol}2`);

  // ── Row 3: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(3).height = 6;

  // ── Row 4: Column headers ──────────────────────────────────────────────────
  ws.getRow(4).height = 18;
  headers.forEach((h, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = h;
    cell.font  = { name: FONT_NAME, bold: true, size: 10, color: { argb: COLORS.HEADER_FG } };
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.HEADER_BG } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borderStyle();
  });

  // ── Data rows ──────────────────────────────────────────────────────────────
  rows.forEach((rowData, rowIdx) => {
    const excelRow = rowIdx + 5;
    ws.getRow(excelRow).height = 15;
    const isEven = rowIdx % 2 === 0;
    const rowBg  = isEven ? COLORS.ROW_ODD_BG : COLORS.ROW_ALT_BG;

    headers.forEach((h, colIdx) => {
      const cell  = ws.getCell(excelRow, colIdx + 1);
      const value = rowData[colIdx];

      // Parse numeric values
      if (isMoneyCol(h) && value !== null && value !== undefined && value !== "") {
        const num = parseFloat(String(value).replace(/[₦$€£₵,\s]/g, ""));
        cell.value  = isNaN(num) ? null : num;
        cell.numFmt = "#,##0.00";
        cell.alignment = { horizontal: "right" };
      } else {
        cell.value = (value === null || value === undefined) ? null : value;
        cell.alignment = {
          horizontal: isDateCol(h) ? "center" : colIdx === 2 ? "left" : "left",
        };
      }

      cell.font   = { name: FONT_NAME, size: 10, color: { argb: "FF000000" } };
      cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + rowBg } };
      cell.border = borderStyle();
    });
  });

  // ── Totals row ─────────────────────────────────────────────────────────────
  const totalsRow = rows.length + 5;
  ws.getRow(totalsRow).height = 18;

  headers.forEach((h, colIdx) => {
    const cell = ws.getCell(totalsRow, colIdx + 1);
    cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.TOTALS_BG } };
    cell.font   = { name: FONT_NAME, bold: true, size: 10, color: { argb: COLORS.TOTALS_FG } };
    cell.border = borderStyle();

    if (colIdx === 2) {
      // Description column — "TOTALS" label
      cell.value = "TOTALS";
      cell.alignment = { horizontal: "center" };
    } else if (totals[h] !== undefined) {
      cell.value     = parseFloat(totals[h]) || 0;
      cell.numFmt    = "#,##0.00";
      cell.alignment = { horizontal: "right" };
    }
  });

  // ── Freeze pane at row 5 (below headers) ──────────────────────────────────
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 4, activeCell: "A5" }];

  // ── Auto filter on header row ──────────────────────────────────────────────
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: numCols } };

  // ── Print settings ────────────────────────────────────────────────────────
  ws.headerFooter.oddFooter = `&L${firmName || "StatementIQ"}&RPage &P of &N`;

  return wb.xlsx.writeBuffer();
}

/**
 * buildMultiSheetXLSX — builds one workbook with multiple sheets (one per year/period)
 * Mirrors the JOPAR BROTHERS multi-year format.
 */
async function buildMultiSheetXLSX({ companyName, accountInfo, sheets, firmName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = firmName || "StatementIQ";
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name, {
      pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true },
    });

    const { headers, rows, totals = {} } = sheet;
    const numCols = headers.length;
    const lastCol = String.fromCharCode(64 + numCols);

    headers.forEach((h, i) => {
      const col = ws.getColumn(i + 1);
      if (isDateCol(h))       col.width = 15;
      else if (isMoneyCol(h)) col.width = 18;
      else if (i === 2)       col.width = 55;
      else                    col.width = 18;
    });

    // Title row
    ws.getRow(1).height = 22;
    const tc = ws.getCell("A1");
    tc.value = `${companyName} - BANK STATEMENT ${sheet.name}`;
    tc.font  = { name: FONT_NAME, bold: true, size: 12, color: { argb: COLORS.HEADER_FG } };
    tc.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.HEADER_BG } };
    tc.alignment = { horizontal: "center", vertical: "middle" };
    ws.mergeCells(`A1:${lastCol}1`);

    // Account info row
    ws.getRow(2).height = 16;
    const ic = ws.getCell("A2");
    ic.value = sheet.accountInfo || accountInfo;
    ic.font  = { name: FONT_NAME, size: 10 };
    ic.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.SUBHEAD_BG } };
    ic.alignment = { horizontal: "center", vertical: "middle" };
    ws.mergeCells(`A2:${lastCol}2`);

    ws.getRow(3).height = 6;

    // Column headers
    ws.getRow(4).height = 18;
    headers.forEach((h, i) => {
      const c = ws.getCell(4, i + 1);
      c.value = h;
      c.font  = { name: FONT_NAME, bold: true, size: 10, color: { argb: COLORS.HEADER_FG } };
      c.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.HEADER_BG } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = borderStyle();
    });

    // Data rows
    rows.forEach((rowData, rowIdx) => {
      const excelRow = rowIdx + 5;
      ws.getRow(excelRow).height = 15;
      const rowBg = rowIdx % 2 === 0 ? COLORS.ROW_ODD_BG : COLORS.ROW_ALT_BG;

      headers.forEach((h, colIdx) => {
        const c = ws.getCell(excelRow, colIdx + 1);
        const v = rowData[colIdx];
        if (isMoneyCol(h) && v !== null && v !== undefined && v !== "") {
          const num = parseFloat(String(v).replace(/[₦$€£₵,\s]/g, ""));
          c.value = isNaN(num) ? null : num;
          c.numFmt = "#,##0.00";
          c.alignment = { horizontal: "right" };
        } else {
          c.value = (v === null || v === undefined) ? null : v;
          c.alignment = { horizontal: isDateCol(h) ? "center" : "left" };
        }
        c.font   = { name: FONT_NAME, size: 10 };
        c.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + rowBg } };
        c.border = borderStyle();
      });
    });

    // Totals
    const totalsRow = rows.length + 5;
    ws.getRow(totalsRow).height = 18;
    headers.forEach((h, colIdx) => {
      const c = ws.getCell(totalsRow, colIdx + 1);
      c.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLORS.TOTALS_BG } };
      c.font   = { name: FONT_NAME, bold: true, size: 10 };
      c.border = borderStyle();
      if (colIdx === 2) { c.value = "TOTALS"; c.alignment = { horizontal: "center" }; }
      else if (totals[h] !== undefined) { c.value = parseFloat(totals[h])||0; c.numFmt = "#,##0.00"; c.alignment = { horizontal: "right" }; }
    });

    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 4, activeCell: "A5" }];
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: numCols } };
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildStyledXLSX, buildMultiSheetXLSX };
