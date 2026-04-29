/**
 * Monthly Report to Admins Job
 * Runs at 23:59 on the last day of every month to send report to all admin users
 * Skips Sundays
 */

const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: At 23:59 on days 28-31 (checks if tomorrow is 1st to determine last day)
const schedule = '59 23 28-31 * *';

/**
 * Build a formatted monthly report message for a group of employees
 */
function buildMonthlyMessage(yearMonth, employees, companyLabel) {
  let excellentCount = 0, goodCount = 0, acceptableCount = 0, badCount = 0, unacceptableCount = 0;
  employees.forEach(e => {
    const zone = e.ratingZone;
    if (zone.includes('Excellent'))         excellentCount++;
    else if (zone.includes('Good'))         goodCount++;
    else if (zone.includes('Acceptable'))   acceptableCount++;
    else if (zone.includes('Bad'))          badCount++;
    else if (zone.includes('Unacceptable')) unacceptableCount++;
  });

  const medals = ['🥇', '🥈', '🥉'];
  const rankLines = employees.map((e, i) => {
    const medal     = medals[i] || `   ${i + 1}.`;
    const ratingStr = e.rating.toFixed(1);
    const pointsStr = e.totalPoints.toFixed(0);
    const hoursStr  = e.hoursWorked.toFixed(1);
    return `${medal} ${e.name}\n` +
           `    ⭐ ${ratingStr}/10 | 📊 ${pointsStr}pts | ⏱ ${hoursStr}h`;
  }).join('\n');

  return (
    `📊 Месячный рейтинг за ${yearMonth} — ${companyLabel}\n` +
    `${'─'.repeat(30)}\n` +
    `${rankLines}\n` +
    `${'─'.repeat(30)}\n` +
    `🟢 Отлично: ${excellentCount}  🔵 Хорошо: ${goodCount}\n` +
    `🟡 Допустимо: ${acceptableCount}  🟠 Плохо: ${badCount}  🔴 Недопустимо: ${unacceptableCount}\n\n` +
    `Используйте кнопку "📈 Отчёт за месяц" для полного HTML-отчёта.`
  );
}

/**
 * Send monthly report to all admins
 * @param {string} yearMonth - Month in YYYY-MM format
 * @param {Object} schedulerService - Scheduler service instance (for bot)
 */
async function sendMonthlyReportToAdmins(yearMonth, schedulerService) {
  try {
    if (!schedulerService.bot) {
      logger.error('Bot instance not initialized in scheduler');
      return;
    }

    const sheetName = `Report_${yearMonth}`;

    // Check if sheet exists
    const sheetExists = sheetsService.doc.sheetsByTitle[sheetName];
    if (!sheetExists) {
      logger.info(`Sheet ${sheetName} doesn't exist - skipping monthly report`);
      return;
    }

    const worksheet = await sheetsService.getWorksheet(sheetName);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    if (rows.length === 0) {
      logger.info('No data for monthly report');
      return;
    }

    // Split employees into company groups
    const groupedEmployees = { 'НО.UZ': [], 'Grace': [] };

    for (const row of rows) {
      const company = (row.get('Company') || '').trim();
      const employee = {
        name:        row.get('Name') || 'N/A',
        rating:      parseFloat(row.get('Rating (0-10)') || '0'),
        totalPoints: parseFloat(row.get('Total Points') || '0'),
        hoursWorked: parseFloat(row.get('Total Hours Worked') || '0'),
        ratingZone:  row.get('Rating Zone') || ''
      };

      if (company.toLowerCase().includes('grace')) {
        groupedEmployees['Grace'].push(employee);
      } else {
        groupedEmployees['НО.UZ'].push(employee); // default to НО.UZ
      }
    }

    // Sort each group: Rating DESC → Total Points DESC → Hours Worked DESC
    const sortFn = (a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return b.hoursWorked - a.hoursWorked;
    };

    const reportGroups = [
      { key: 'НО.UZ', label: 'НО.UZ' },
      { key: 'Grace', label: 'Grace' }
    ];

    for (const group of reportGroups) {
      const employees = groupedEmployees[group.key];
      if (employees.length === 0) continue;

      employees.sort(sortFn);
      const message = buildMonthlyMessage(yearMonth, employees, group.label);

      // Send to all admins
      for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
        try {
          await schedulerService.retryTelegramOperation(async () => {
            await schedulerService.bot.telegram.sendMessage(adminId, message);
          });
          logger.info(`Monthly report (${group.label}) sent to admin ${adminId}`);

          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          logger.error(`Failed to send monthly report (${group.label}) to admin ${adminId} after retries: ${err.message}`);
        }
      }
    }

  } catch (error) {
    logger.error(`Error in sendMonthlyReportToAdmins: ${error.message}`);
  }
}

/**
 * Main job execution function
 * @param {Object} schedulerService - Scheduler service instance
 */
async function execute(schedulerService) {
  try {
    const now = moment.tz(Config.TIMEZONE);
    const tomorrow = now.clone().add(1, 'day');

    // Check if tomorrow is the 1st (i.e., today is last day of month)
    if (tomorrow.date() === 1) {
      // Skip monthly report on Sunday (day 0)
      if (now.day() === 0) {
        const yearMonth = now.format('YYYY-MM');
        logger.info(`Skipping monthly report for ${yearMonth} - today is Sunday`);
        return;
      }

      const yearMonth = now.format('YYYY-MM');
      logger.info(`Sending monthly report to admins for ${yearMonth}`);

      await sendMonthlyReportToAdmins(yearMonth, schedulerService);

      logger.info(`Monthly report sent to admins for ${yearMonth}`);
    }
  } catch (error) {
    logger.error(`Error sending monthly report to admins: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  sendMonthlyReportToAdmins,
  name: 'Monthly Report to Admins',
  description: 'Sends monthly report to all admins at 23:59 on last day of month (skips Sundays)'
};
