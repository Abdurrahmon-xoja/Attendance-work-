/**
 * Recovery diagnostic (READ-ONLY).
 * Lists leftover daily sheets, Hours calendar fill status, and Report totals,
 * then flags possible partial transfers (double-count risk for /endday re-runs).
 *
 * Usage: node scripts/recovery/diagnose.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.production') });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const moment = require('moment-timezone');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Tashkent';
const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WORKED_CELL_RE = /^(\d+(?:\.\d+)?)h \|/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retry a Sheets call on 429/quota errors with exponential backoff. */
async function withRetry(fn, label, maxRetries = 5) {
  let delay = 15000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status || err.status;
      if (status === 429 && attempt < maxRetries) {
        console.log(`  (quota 429 on ${label}, waiting ${delay / 1000}s...)`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, auth);
  await withRetry(() => doc.loadInfo(), 'loadInfo');

  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  console.log(`Spreadsheet: "${doc.title}"  |  today (${TIMEZONE}): ${today}\n`);

  // 1. Leftover daily sheets
  const allTitles = Object.keys(doc.sheetsByTitle);
  const dailyTitles = allTitles.filter(t => DAILY_RE.test(t)).sort();
  const leftovers = dailyTitles.filter(t => t < today);
  console.log('=== Sheets in document ===');
  console.log(allTitles.join(', '));
  console.log(`\n=== Daily sheets ===`);
  console.log(`All: ${dailyTitles.join(', ') || '(none)'}`);
  console.log(`Leftover (older than today, should have been archived): ${leftovers.join(', ') || '(none)'}\n`);

  // 2. Relevant months = months of leftovers + current month
  const months = [...new Set([...leftovers.map(d => d.slice(0, 7)), today.slice(0, 7)])].sort();

  // Per-employee derived stats from Hours calendars: month -> tid -> { days, hours }
  const hoursDerived = {};
  for (const ym of months) {
    const sheetName = `Hours_${ym}`;
    const sheet = doc.sheetsByTitle[sheetName];
    console.log(`=== ${sheetName} ===`);
    if (!sheet) {
      console.log('  SHEET DOES NOT EXIST\n');
      continue;
    }
    await withRetry(() => sheet.loadHeaderRow(), 'Hours loadHeaderRow');
    const rows = await withRetry(() => sheet.getRows(), 'Hours getRows');
    const daysInMonth = moment.tz(ym, 'YYYY-MM', TIMEZONE).daysInMonth();
    const lastDay = ym === today.slice(0, 7) ? moment.tz(TIMEZONE).date() - 1 : daysInMonth;

    hoursDerived[ym] = new Map();
    const dayStatus = [];
    for (let d = 1; d <= lastDay; d++) {
      let filled = 0;
      for (const row of rows) {
        if (((row.get(String(d)) || '').toString().trim())) filled++;
      }
      const status = filled === 0 ? 'EMPTY' : filled >= rows.length ? 'FULL' : `PARTIAL(${filled}/${rows.length})`;
      dayStatus.push(`${d}:${status}`);
    }
    console.log(`  Employees: ${rows.length}. Day columns 1..${lastDay}: ${dayStatus.join('  ')}`);

    for (const row of rows) {
      const tid = (row.get('Telegram ID') || '').toString().trim();
      if (!tid) continue;
      let days = 0, hours = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const cell = (row.get(String(d)) || '').toString().trim();
        const m = cell.match(WORKED_CELL_RE);
        if (m) { days++; hours += parseFloat(m[1]); }
      }
      hoursDerived[ym].set(tid, { days, hours, name: row.get('Name') || '' });
    }
    console.log('');
  }

  // 3. Report sheets + partial-transfer heuristic
  for (const ym of months) {
    const sheetName = `Report_${ym}`;
    const sheet = doc.sheetsByTitle[sheetName];
    console.log(`=== ${sheetName} ===`);
    if (!sheet) {
      console.log('  SHEET DOES NOT EXIST\n');
      continue;
    }
    let rows;
    try {
      await withRetry(() => sheet.loadHeaderRow(), 'Report loadHeaderRow');
      rows = await withRetry(() => sheet.getRows(), 'Report getRows');
    } catch (err) {
      console.log(`  BROKEN SHEET (cannot read rows): ${err.message}\n`);
      continue;
    }
    const derived = hoursDerived[ym] || new Map();
    console.log('  Name | TID | DaysWorked | DaysAbsent | TotalHours | Points | LastUpdated | HoursCal(days/hours) | EXCESS(days/hours)');
    for (const row of rows) {
      const tid = (row.get('Telegram ID') || '').toString().trim();
      const dw = parseInt(row.get('Days Worked') || '0');
      const da = parseInt(row.get('Days Absent') || '0');
      const th = parseFloat(row.get('Total Hours Worked') || '0');
      const pts = row.get('Total Points') || '0';
      const lu = row.get('Last Updated') || '';
      const h = derived.get(tid) || { days: 0, hours: 0 };
      const exDays = dw - h.days;
      const exHours = (th - h.hours).toFixed(2);
      const flag = exDays !== 0 ? '  <-- MISMATCH' : '';
      console.log(`  ${row.get('Name')} | ${tid} | ${dw} | ${da} | ${th.toFixed(2)} | ${pts} | ${lu} | ${h.days}/${h.hours.toFixed(2)} | ${exDays}/${exHours}${flag}`);
    }
    console.log('');
  }

  // 4. Would-be contribution of each leftover daily sheet
  for (const dateStr of leftovers) {
    const sheet = doc.sheetsByTitle[dateStr];
    console.log(`=== Leftover daily sheet ${dateStr} (would-be contribution) ===`);
    await withRetry(() => sheet.loadHeaderRow(), 'daily loadHeaderRow');
    const rows = await withRetry(() => sheet.getRows(), 'daily getRows');
    let came = 0, absent = 0, noshow = 0;
    for (const row of rows) {
      const tid = (row.get('TelegramId') || '').toString().trim();
      const whenCome = (row.get('When come') || '').trim();
      const abs = (row.get('Absent') || '').trim().toLowerCase();
      const hoursWorked = parseFloat(row.get('Hours worked') || '0');
      const leaveTime = (row.get('Leave time') || '').trim();
      if (whenCome) {
        came++;
        console.log(`  ${row.get('Name')} | ${tid} | came ${whenCome}, left ${leaveTime || '(STILL OPEN)'}, +1 day, +${hoursWorked.toFixed(2)}h, +${row.get('Point') || '0'}pt`);
      } else if (abs === 'yes' || abs === 'true') {
        absent++;
      } else {
        noshow++;
      }
    }
    console.log(`  Summary: ${came} came, ${absent} absent, ${noshow} no-show/no-activity\n`);
  }

  console.log('Done. Interpretation: EXCESS > 0 for an employee means the Report already counts more days');
  console.log('than the Hours calendar shows — either a partial transfer of a leftover day (skip that');
  console.log('employee when backfilling) or an old Hours-update failure on an already-deleted day.');
}

main().catch(err => { console.error('FATAL:', err.message, err.response?.status || ''); process.exit(1); });
