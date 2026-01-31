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

    // Calculate stats
    let excellentCount = 0, goodCount = 0, acceptableCount = 0, badCount = 0, unacceptableCount = 0;
    rows.forEach(row => {
      const zone = row.get('Rating Zone') || '';
      if (zone.includes('Excellent')) excellentCount++;
      else if (zone.includes('Good')) goodCount++;
      else if (zone.includes('Acceptable')) acceptableCount++;
      else if (zone.includes('Bad')) badCount++;
      else if (zone.includes('Unacceptable')) unacceptableCount++;
    });

    // Send to all admins
    for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
      try {
        await schedulerService.retryTelegramOperation(async () => {
          await schedulerService.bot.telegram.sendMessage(
            adminId,
            `📊 Месячный отчёт за ${yearMonth}\n\n` +
            `🟢 Excellent: ${excellentCount}\n` +
            `🔵 Good: ${goodCount}\n` +
            `🟡 Acceptable: ${acceptableCount}\n` +
            `🟠 Bad: ${badCount}\n` +
            `🔴 Unacceptable: ${unacceptableCount}\n\n` +
            `Используйте кнопку "📈 Отчёт за месяц" для получения полного отчёта.`
          );
        });
        logger.info(`Monthly report sent to admin ${adminId}`);

        // Add delay between admin notifications
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        logger.error(`Failed to send monthly report to admin ${adminId} after retries: ${err.message}`);
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
