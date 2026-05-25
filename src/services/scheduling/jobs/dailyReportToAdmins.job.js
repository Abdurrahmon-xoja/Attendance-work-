/**
 * Daily Report to Admins Job
 * Runs at 23:59 every day to send HTML report to all admin users
 * Skips Sundays
 */

const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: Every day at 23:59
const schedule = '59 23 * * *';

/**
 * Build company lookup map from roster: telegramId → company, name → company
 */
async function buildCompanyMap() {
  const companyMap = { byTelegramId: {}, byName: {} };
  try {
    const rosterSheet = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
    await rosterSheet.loadHeaderRow();
    const rosterRows = await rosterSheet.getRows();
    for (const row of rosterRows) {
      const company = (row.get('Company') || '').trim();
      const telegramId = (row.get('Telegram Id') || '').toString().trim();
      const name = (row.get('Name full') || '').trim();
      if (telegramId) companyMap.byTelegramId[telegramId] = company;
      if (name) companyMap.byName[name] = company;
    }
  } catch (err) {
    logger.error(`Failed to build company map: ${err.message}`);
  }
  return companyMap;
}

/**
 * Generate HTML report for a specific group of rows
 */
function generateHtmlReport(date, rows, companyLabel, now) {
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let leftEarlyCount = 0;
  let notifiedLateCount = 0;

  let employeeRows = '';
  for (const row of rows) {
    const name = row.get('Name') || 'N/A';
    const cameOnTime = row.get('Came on time') || '';
    const whenCome = row.get('When come') || '';
    const leaveTime = row.get('Leave time') || '';
    const hoursWorked = row.get('Hours worked') || '0';
    const leftEarly = row.get('Left early') || '';
    const absent = row.get('Absent') || '';
    const whyAbsent = row.get('Why absent') || '';
    const willBeLate = row.get('will be late') || '';
    const willBeLateTime = row.get('will be late will come at') || '';
    const point = row.get('Point') || '0';
    const pointNum = parseFloat(point);

    let status = '';
    let statusClass = '';
    let pointClass = '';

    if (absent.toLowerCase() === 'yes') {
      status = `Отсутствует`;
      if (whyAbsent) status += ` (${whyAbsent})`;
      statusClass = 'status-absent';
      absentCount++;
    } else if (whenCome) {
      if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
        status = `Опоздал (${whenCome})`;
        statusClass = 'status-late';
        lateCount++;
      } else {
        status = `Вовремя (${whenCome})`;
        statusClass = 'status-ontime';
      }

      if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
        status += `<br><small>⏰ Предупредил об опоздании`;
        if (willBeLateTime.trim()) {
          status += ` (${willBeLateTime})`;
        }
        status += `</small>`;
        notifiedLateCount++;
      }

      presentCount++;

      if (leaveTime) {
        status += `<br><small>Ушёл: ${leaveTime} (${hoursWorked}ч)`;
        if (leftEarly && leftEarly.toLowerCase().includes('yes')) {
          status += ` - Рано`;
          leftEarlyCount++;
        }
        status += `</small>`;
      }
    } else {
      status = `Не пришёл`;
      statusClass = 'status-notarrived';

      if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
        status = `Ожидается`;
        if (willBeLateTime.trim()) {
          status += ` (${willBeLateTime})`;
        }
        statusClass = 'status-waiting';
        notifiedLateCount++;
      }
    }

    if (pointNum > 0) {
      pointClass = 'point-good';
    } else if (pointNum === 0) {
      pointClass = 'point-neutral';
    } else {
      pointClass = 'point-bad';
    }

    employeeRows += `
        <tr>
          <td>${name}</td>
          <td class="${statusClass}">${status}</td>
          <td class="${pointClass}">${point}</td>
        </tr>
      `;
  }

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Дневной отчёт - ${date} - ${companyLabel}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; text-align: center; }
    .header h1 { font-size: 36px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
    .stat-card { background: white; padding: 25px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; transition: transform 0.3s ease; }
    .stat-card:hover { transform: translateY(-5px); }
    .stat-card .number { font-size: 36px; font-weight: bold; margin-bottom: 10px; }
    .stat-card .label { color: #6c757d; font-size: 14px; }
    .stat-total .number { color: #667eea; }
    .stat-present .number { color: #10b981; }
    .stat-late .number { color: #f59e0b; }
    .stat-absent .number { color: #ef4444; }
    .stat-early .number { color: #8b5cf6; }
    .stat-notified .number { color: #3b82f6; }
    .table-container { padding: 30px; overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 10px; }
    thead th { background: #667eea; color: white; padding: 15px; text-align: left; font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 1px; }
    thead th:first-child { border-radius: 10px 0 0 10px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr { background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: all 0.3s ease; }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); transform: scale(1.01); }
    tbody td { padding: 20px 15px; border-top: 1px solid #f1f3f5; border-bottom: 1px solid #f1f3f5; }
    tbody td:first-child { font-weight: 600; color: #2d3748; border-left: 1px solid #f1f3f5; border-radius: 10px 0 0 10px; }
    tbody td:last-child { border-right: 1px solid #f1f3f5; border-radius: 0 10px 10px 0; text-align: center; font-weight: bold; font-size: 18px; }
    .status-ontime { color: #10b981; font-weight: 500; }
    .status-late { color: #f59e0b; font-weight: 500; }
    .status-absent { color: #ef4444; font-weight: 500; }
    .status-notarrived { color: #94a3b8; font-weight: 500; }
    .status-waiting { color: #3b82f6; font-weight: 500; }
    .point-good { color: #10b981; }
    .point-neutral { color: #f59e0b; }
    .point-bad { color: #ef4444; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📅 Дневной отчёт — ${companyLabel}</h1>
      <div class="date">${date} • ${now.format('HH:mm:ss')}</div>
    </div>
    <div class="stats">
      <div class="stat-card stat-total"><div class="number">${rows.length}</div><div class="label">Всего сотрудников</div></div>
      <div class="stat-card stat-present"><div class="number">${presentCount}</div><div class="label">Присутствуют</div></div>
      <div class="stat-card stat-late"><div class="number">${lateCount}</div><div class="label">Опоздали</div></div>
      <div class="stat-card stat-notified"><div class="number">${notifiedLateCount}</div><div class="label">Предупредили</div></div>
      <div class="stat-card stat-absent"><div class="number">${absentCount}</div><div class="label">Отсутствуют</div></div>
      <div class="stat-card stat-early"><div class="number">${leftEarlyCount}</div><div class="label">Ушли рано</div></div>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>Сотрудник</th><th>Статус</th><th>Баллы</th></tr></thead>
        <tbody>${employeeRows}</tbody>
      </table>
    </div>
    <div class="footer">Сгенерировано системой учёта посещаемости • ${now.format('DD.MM.YYYY HH:mm:ss')}</div>
  </div>
</body>
</html>`;

  return { html, presentCount, lateCount, absentCount };
}

/**
 * Send daily report to all admins as HTML file
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance (for bot)
 */
async function sendDailyReportToAdmins(date, schedulerService) {
  try {
    if (!schedulerService.bot) {
      logger.error('Bot instance not initialized in scheduler');
      return;
    }

    // Check if sheet exists
    const sheetExists = sheetsService.doc.sheetsByTitle[date];
    if (!sheetExists) {
      logger.info(`Sheet ${date} doesn't exist - skipping daily report`);
      return;
    }

    const worksheet = await sheetsService.getWorksheet(date);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    if (rows.length === 0) {
      logger.info('No data for daily report');
      return;
    }

    const now = moment.tz(Config.TIMEZONE);

    // Build company map from roster
    const companyMap = await buildCompanyMap();

    // Split rows into two company groups
    const groups = { 'НО.UZ': [], 'Grace': [], other: [] };
    for (const row of rows) {
      const telegramId = (row.get('TelegramId') || '').toString().trim();
      const name = (row.get('Name') || '').trim();
      let company = companyMap.byTelegramId[telegramId] || companyMap.byName[name] || '';

      if (company.toLowerCase().includes('grace')) {
        groups['Grace'].push(row);
      } else if (company.toLowerCase().includes('но') || company.toLowerCase().includes('no.uz') || company.toLowerCase().includes('но.uz')) {
        groups['НО.UZ'].push(row);
      } else {
        groups['НО.UZ'].push(row); // default to НО.UZ if company unknown
      }
    }

    const tempDir = path.join(__dirname, '../../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate and send report for each company group
    const reportGroups = [
      { key: 'НО.UZ', label: 'НО.UZ' },
      { key: 'Grace', label: 'Grace' }
    ];

    for (const group of reportGroups) {
      const groupRows = groups[group.key];
      if (groupRows.length === 0) continue;

      const { html, presentCount, lateCount, absentCount } = generateHtmlReport(date, groupRows, group.label, now);

      const safeName = group.label.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `daily_report_${date}_${safeName}.html`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, html, 'utf8');

      for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
        let sent = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await schedulerService.bot.telegram.sendDocument(
              adminId,
              { source: filepath },
              {
                caption: `📊 Дневной отчёт за ${date} — ${group.label}\n\n✅ Присутствуют: ${presentCount}\n🕒 Опоздали: ${lateCount}\n❌ Отсутствуют: ${absentCount}`,
                filename: filename
              }
            );
            logger.info(`Daily report (${group.label}) sent to admin ${adminId}`);
            sent = true;
            break;
          } catch (err) {
            logger.warn(`sendDocument attempt ${attempt} failed for admin ${adminId}: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
          }
        }
        if (!sent) {
          logger.error(`Failed to send daily report (${group.label}) to admin ${adminId} after 3 attempts`);
        }
      }

      fs.unlinkSync(filepath);
    }

  } catch (error) {
    logger.error(`Error in sendDailyReportToAdmins: ${error.message}`);
  }
}

/**
 * Main job execution function
 * @param {Object} schedulerService - Scheduler service instance
 */
async function execute(schedulerService) {
  try {
    const now = moment.tz(Config.TIMEZONE);
    const today = now.format('YYYY-MM-DD');

    // Skip daily report on Sunday (day 0)
    if (now.day() === 0) {
      logger.info(`Skipping daily report for ${today} - today is Sunday`);
      return;
    }

    logger.info(`Sending daily report to admins for ${today}`);

    await sendDailyReportToAdmins(today, schedulerService);

    logger.info(`Daily report sent to admins for ${today}`);
  } catch (error) {
    logger.error(`Error sending daily report to admins: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  sendDailyReportToAdmins,
  name: 'Daily Report to Admins',
  description: 'Sends HTML daily report to all admins at 23:59 (skips Sundays)'
};
