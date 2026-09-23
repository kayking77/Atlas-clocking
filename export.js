/* Atlas Timeclock — Excel timesheet builder.
 *
 * Works in the browser (window.AtlasExport, with window.ExcelJS loaded) and in
 * Node (module.exports) so the layout can be tested.
 *
 * Layout — one workbook per organization:
 *   Sheet "Timesheet"      Date | Staff | House | Address | Time In | Time Out | Hours | Notes
 *                          grouped by house, a SUM subtotal per house,
 *                          and an organization total at the bottom.
 *   Sheet "Hours by Staff" staff × house matrix with row and column totals.
 *
 * "All organizations" workbook:
 *   Sheet "Summary"        hours per organization → house, org subtotals,
 *                          grand total, then total hours per staff member.
 *   One timesheet sheet per organization (same layout as above).
 */
(function (root) {
  'use strict';

  const COLORS = {
    headFill: 'FF1B2A4A',
    headInk: 'FFFFFFFF',
    groupFill: 'FFE3E9FB',
    subtotalFill: 'FFF2F4F3',
    totalFill: 'FFD6DEEF',
    line: 'FFB9C3CC',
    flagInk: 'FF9A5B06',
  };

  // "2026-09-22T15:04:00" (Atlas local wall time) → Excel serial number
  function serial(local) {
    const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return (ms - Date.UTC(1899, 11, 30)) / 86400000;
  }

  function mdY(dateStr) {
    const [y, m, d] = String(dateStr).slice(0, 10).split('-');
    return `${m}/${d}/${y}`;
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function sheetName(name, used) {
    let base = String(name).replace(/[\[\]\*\?\/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let n = base;
    let i = 2;
    while (used.has(n.toLowerCase())) {
      const suffix = ` (${i++})`;
      n = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(n.toLowerCase());
    return n;
  }

  function fileSafe(s) {
    return String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  }

  function entryNotes(e) {
    const out = [];
    if (e.source === 'admin') out.push('Entered by admin');
    if (e.in_inside === false) out.push(`Clock-in outside geofence (${e.in_distance_m} m)`);
    if (e.out_inside === false) out.push(`Clock-out outside geofence (${e.out_distance_m} m)`);
    if (e.in_mocked || e.out_mocked) out.push('Simulated GPS reported');
    if (e.in_note) out.push(`In: ${e.in_note}`);
    if (e.out_note) out.push(`Out: ${e.out_note}`);
    if (e.admin_note) out.push(`Admin: ${e.admin_note}`);
    if (e.edited_at) out.push('Edited by admin');
    return out.join(' · ');
  }

  function styleHeader(row) {
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: COLORS.headInk } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headFill } };
      cell.alignment = { vertical: 'middle' };
    });
    row.height = 20;
  }

  function fillRow(row, argb, nCols) {
    for (let i = 1; i <= nCols; i++) {
      row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    }
  }

  function titleBlock(ws, lines) {
    lines.forEach((text, i) => {
      const r = ws.addRow([text]);
      r.getCell(1).font = i === 0 ? { bold: true, size: 14 } : { size: 11, color: { argb: 'FF44505B' } };
    });
    ws.addRow([]);
  }

  /** Adds one organization's timesheet sheet. Returns { totalCell, total } */
  function addTimesheetSheet(wb, { name, companyName, org, period, houses, rows, used }) {
    const ws = wb.addWorksheet(sheetName(name, used), {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.columns = [
      { width: 12 }, // Date
      { width: 24 }, // Staff
      { width: 20 }, // House
      { width: 40 }, // Address
      { width: 11 }, // Time In
      { width: 17 }, // Time Out
      { width: 9 },  // Hours
      { width: 60 }, // Notes
    ];
    titleBlock(ws, [
      `${companyName} — Timesheet`,
      `Organization: ${org.name}`,
      `Pay period: ${mdY(period.period_start)} – ${mdY(period.period_end)}`,
      `Generated: ${new Date().toLocaleString('en-US')}`,
    ]);
    const head = ws.addRow(['Date', 'Staff', 'House', 'Address', 'Time In', 'Time Out', 'Hours', 'Notes']);
    styleHeader(head);
    ws.views = [{ state: 'frozen', ySplit: head.number }];

    const subtotalRefs = [];
    let orgTotal = 0;

    for (const h of houses) {
      const hr = rows.filter((e) => e.house_id === h.id).sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
      const g = ws.addRow([`${h.name} — ${h.address}`]);
      ws.mergeCells(g.number, 1, g.number, 8);
      g.getCell(1).font = { bold: true };
      fillRow(g, COLORS.groupFill, 8);

      const first = ws.rowCount + 1;
      let sub = 0;
      for (const e of hr) {
        const hours = round2(e.hours);
        sub += hours;
        const r = ws.addRow([
          serial(e.work_date),
          e.staff_name,
          h.name,
          h.address,
          serial(e.clock_in_local),
          serial(e.clock_out_local),
          hours,
          entryNotes(e),
        ]);
        r.getCell(1).numFmt = 'mm/dd/yyyy';
        r.getCell(5).numFmt = 'h:mm AM/PM';
        const nextDay = String(e.clock_in_local).slice(0, 10) !== String(e.clock_out_local).slice(0, 10);
        r.getCell(6).numFmt = nextDay ? 'h:mm AM/PM "(+1 day)"' : 'h:mm AM/PM';
        r.getCell(7).numFmt = '0.00';
        if (e.flagged) r.getCell(8).font = { color: { argb: COLORS.flagInk } };
      }
      const last = ws.rowCount;
      if (!hr.length) {
        const empty = ws.addRow(['', '', '', 'No shifts this period']);
        empty.getCell(4).font = { italic: true, color: { argb: 'FF6B7780' } };
      }
      const st = ws.addRow(['', '', '', `Subtotal — ${h.name}`, '', '', null, '']);
      st.getCell(7).value = hr.length ? { formula: `SUM(G${first}:G${last})`, result: round2(sub) } : 0;
      st.getCell(7).numFmt = '0.00';
      st.font = { bold: true };
      st.getCell(4).font = { bold: true };
      st.getCell(7).font = { bold: true };
      fillRow(st, COLORS.subtotalFill, 8);
      st.getCell(7).border = { top: { style: 'thin', color: { argb: COLORS.line } } };
      subtotalRefs.push(`G${st.number}`);
      orgTotal += sub;
    }

    ws.addRow([]);
    const t = ws.addRow(['', '', '', `Total hours — ${org.name}`, '', '', null, '']);
    t.getCell(7).value = subtotalRefs.length ? { formula: subtotalRefs.join('+'), result: round2(orgTotal) } : 0;
    t.getCell(7).numFmt = '0.00';
    t.getCell(4).font = { bold: true, size: 12 };
    t.getCell(7).font = { bold: true, size: 12 };
    fillRow(t, COLORS.totalFill, 8);
    t.getCell(7).border = { top: { style: 'thin' }, bottom: { style: 'double' } };

    return { ws, totalRef: `'${ws.name.replace(/'/g, "''")}'!G${t.number}`, total: round2(orgTotal) };
  }

  function addStaffMatrixSheet(wb, { houses, rows, used, title }) {
    const ws = wb.addWorksheet(sheetName('Hours by Staff', used));
    const staff = [...new Map(rows.map((e) => [e.staff_id, e.staff_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    ws.columns = [{ width: 26 }, ...houses.map(() => ({ width: 14 })), { width: 12 }];
    titleBlock(ws, [title]);
    const head = ws.addRow(['Staff', ...houses.map((h) => h.name), 'Total']);
    styleHeader(head);
    const nCols = houses.length + 2;
    const lastHouseCol = colLetter(houses.length + 1);
    const first = ws.rowCount + 1;
    for (const [sid, sname] of staff) {
      const vals = houses.map((h) => round2(rows.filter((e) => e.staff_id === sid && e.house_id === h.id).reduce((s, e) => s + Number(e.hours), 0)));
      const r = ws.addRow([sname, ...vals, null]);
      const total = round2(vals.reduce((a, b) => a + b, 0));
      r.getCell(nCols).value = { formula: `SUM(B${r.number}:${lastHouseCol}${r.number})`, result: total };
      for (let i = 2; i <= nCols; i++) r.getCell(i).numFmt = '0.00';
      r.getCell(nCols).font = { bold: true };
    }
    const last = ws.rowCount;
    const t = ws.addRow(['Total', ...houses.map(() => null), null]);
    for (let i = 2; i <= nCols; i++) {
      const L = colLetter(i);
      const result = staff.length ? round2(sumCol(ws, i, first, last)) : 0;
      t.getCell(i).value = staff.length ? { formula: `SUM(${L}${first}:${L}${last})`, result } : 0;
      t.getCell(i).numFmt = '0.00';
    }
    t.font = { bold: true };
    fillRow(t, COLORS.totalFill, nCols);
    return ws;
  }

  function sumCol(ws, col, first, last) {
    let s = 0;
    for (let r = first; r <= last; r++) {
      const v = ws.getRow(r).getCell(col).value;
      s += typeof v === 'number' ? v : v && typeof v.result === 'number' ? v.result : 0;
    }
    return s;
  }

  function colLetter(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function housesForOrg(org, houses, rows) {
    const withRows = new Set(rows.map((e) => e.house_id));
    return houses
      .filter((h) => h.org_id === org.id && (h.active || withRows.has(h.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function newWorkbook(ExcelJS, companyName) {
    const wb = new ExcelJS.Workbook();
    wb.creator = `${companyName} Timeclock`;
    wb.created = new Date();
    return wb;
  }

  /**
   * One organization's workbook.
   * rows: closed clock_entries_detail rows for the period (any org — filtered here).
   */
  function buildOrgWorkbook(ExcelJS, { companyName = 'Atlas Staffing', org, period, houses, rows }) {
    const orgRows = rows.filter((e) => e.org_id === org.id && e.clock_out);
    const hs = housesForOrg(org, houses, orgRows);
    const wb = newWorkbook(ExcelJS, companyName);
    const used = new Set();
    const ts = addTimesheetSheet(wb, { name: 'Timesheet', companyName, org, period, houses: hs, rows: orgRows, used });
    addStaffMatrixSheet(wb, {
      houses: hs,
      rows: orgRows,
      used,
      title: `${org.name} — hours by staff, ${mdY(period.period_start)} – ${mdY(period.period_end)}`,
    });
    return {
      workbook: wb,
      total: ts.total,
      filename: `${fileSafe(companyName)}_Timesheet_${fileSafe(org.name)}_${period.period_start}_to_${period.period_end}.xlsx`,
    };
  }

  /** Every organization in one workbook, with a summary sheet first. */
  function buildAllWorkbook(ExcelJS, { companyName = 'Atlas Staffing', orgs, period, houses, rows }) {
    const closed = rows.filter((e) => e.clock_out);
    const wb = newWorkbook(ExcelJS, companyName);
    const used = new Set(['summary']);
    const summary = wb.addWorksheet('Summary');
    summary.columns = [{ width: 42 }, { width: 24 }, { width: 12 }];

    const sheets = [];
    const activeOrgs = orgs
      .filter((o) => o.active || closed.some((e) => e.org_id === o.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const org of activeOrgs) {
      const orgRows = closed.filter((e) => e.org_id === org.id);
      const hs = housesForOrg(org, houses, orgRows);
      const ts = addTimesheetSheet(wb, { name: org.name, companyName, org, period, houses: hs, rows: orgRows, used });
      sheets.push({ org, hs, orgRows, ts });
    }

    titleBlock(summary, [
      `${companyName} — Pay period summary`,
      `Pay period: ${mdY(period.period_start)} – ${mdY(period.period_end)}`,
      `Generated: ${new Date().toLocaleString('en-US')}`,
    ]);
    styleHeader(summary.addRow(['Organization', 'House', 'Hours']));
    const orgTotalRefs = [];
    let grand = 0;
    for (const { org, hs, orgRows, ts } of sheets) {
      const g = summary.addRow([org.name]);
      g.getCell(1).font = { bold: true };
      fillRow(g, COLORS.groupFill, 3);
      const first = summary.rowCount + 1;
      for (const h of hs) {
        const v = round2(orgRows.filter((e) => e.house_id === h.id).reduce((s, e) => s + Number(e.hours), 0));
        const r = summary.addRow(['', h.name, v]);
        r.getCell(3).numFmt = '0.00';
      }
      const last = summary.rowCount;
      const st = summary.addRow(['', `Total — ${org.name}`, null]);
      st.getCell(3).value = hs.length ? { formula: `SUM(C${first}:C${last})`, result: ts.total } : 0;
      st.getCell(3).numFmt = '0.00';
      st.font = { bold: true };
      fillRow(st, COLORS.subtotalFill, 3);
      orgTotalRefs.push(`C${st.number}`);
      grand += ts.total;
    }
    summary.addRow([]);
    const gt = summary.addRow(['Total hours worked — all organizations', '', null]);
    gt.getCell(3).value = orgTotalRefs.length ? { formula: orgTotalRefs.join('+'), result: round2(grand) } : 0;
    gt.getCell(3).numFmt = '0.00';
    gt.font = { bold: true, size: 12 };
    fillRow(gt, COLORS.totalFill, 3);
    gt.getCell(3).border = { top: { style: 'thin' }, bottom: { style: 'double' } };

    // total hours per staff member across all organizations
    summary.addRow([]);
    summary.addRow([]);
    styleHeader(summary.addRow(['Staff', 'Shifts', 'Hours']));
    const staff = [...new Map(closed.map((e) => [e.staff_id, e.staff_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const sFirst = summary.rowCount + 1;
    for (const [sid, sname] of staff) {
      const mine = closed.filter((e) => e.staff_id === sid);
      const r = summary.addRow([sname, mine.length, round2(mine.reduce((s, e) => s + Number(e.hours), 0))]);
      r.getCell(3).numFmt = '0.00';
    }
    const sLast = summary.rowCount;
    const stt = summary.addRow(['Total', null, null]);
    stt.getCell(2).value = staff.length ? { formula: `SUM(B${sFirst}:B${sLast})`, result: closed.length } : 0;
    stt.getCell(3).value = staff.length ? { formula: `SUM(C${sFirst}:C${sLast})`, result: round2(grand) } : 0;
    stt.getCell(3).numFmt = '0.00';
    stt.font = { bold: true };
    fillRow(stt, COLORS.totalFill, 3);

    return {
      workbook: wb,
      total: round2(grand),
      filename: `${fileSafe(companyName)}_Timesheets_All_Organizations_${period.period_start}_to_${period.period_end}.xlsx`,
    };
  }

  const api = { buildOrgWorkbook, buildAllWorkbook, entryNotes, serial };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AtlasExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
