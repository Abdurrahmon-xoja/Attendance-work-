/**
 * No-Show Check Job
 * Runs at 20:00 every day to check and mark employees who had no activity
 */

const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: Every day at 20:00 (8 PM)
const schedule = '0 20 * * *';

/**
 * Check and mark employees who had no activity today as no-shows
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance (for sendMessageSafe)
 * @returns {number} Number of employees marked as no-shows
 */
async function checkAndMarkNoShows(dateStr, schedulerService) {
  try {
    // Check if sheet exists
    const sheetExists = sheetsService.doc.sheetsByTitle[dateStr];
    if (!sheetExists) {
      logger.info(`Sheet ${dateStr} doesn't exist - skipping no-show check`);
      return 0;
    }

    // Check if the date is a weekend
    const checkDate = moment.tz(dateStr, Config.TIMEZONE);
    const isSunday = checkDate.day() === 0;
    const isSaturday = checkDate.day() === 6;

    // Get daily sheet
    const worksheet = await sheetsService.getWorksheet(dateStr);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    let noShowCount = 0;
    let skippedWeekend = 0;

    for (const row of rows) {
      const name = row.get('Name') || '';
      const telegramId = row.get('TelegramId') || '';
      const whenCome = row.get('When come') || '';
      const leaveTime = row.get('Leave time') || '';
      const absent = row.get('Absent') || '';
      const willBeLate = row.get('will be late') || '';
      const currentPoint = parseFloat(row.get('Point') || '0');

      // Skip no-show check on Sundays (everyone's day off)
      if (isSunday) {
        skippedWeekend++;
        continue;
      }

      // Skip no-show check on Saturdays for employees who don't work on Saturday
      if (isSaturday && telegramId.trim()) {
        const employee = await sheetsService.findEmployeeByTelegramId(telegramId);
        if (employee && employee.doNotWorkSaturday) {
          logger.debug(`Skipping no-show check for ${name} - Saturday is their day off`);
          skippedWeekend++;
          continue;
        }
      }

      // Check if person never arrived and is not already marked absent
      const neverArrived = !whenCome.trim() &&
                           !leaveTime.trim() &&
                           absent.toLowerCase() !== 'yes';

      // Saying "I will be late" is NOT an absence notification.
      // If the worker never shows up, it is a silent (unnotified) absence.
      const saidLateButDidNotCome = neverArrived && willBeLate.toLowerCase() === 'yes';

      if (neverArrived && name.trim()) {
        // Full no-show penalty regardless of "will be late" flag
        const noShowPoint = Config.BASE_POINTS + Config.NO_SHOW_PENALTY; // 10 + (-10) = 0
        row.set('Point', noShowPoint.toString());
        row.set('Arrival Penalty', Config.NO_SHOW_PENALTY.toString());
        row.set('Absent', 'Yes');

        if (saidLateButDidNotCome) {
          row.set('Why absent', 'No-show (said late but did not arrive)');
        } else {
          row.set('Why absent', 'No-show (no activity)');
        }

        // Clear the late flag — it does not count as an absence notification
        if (saidLateButDidNotCome) {
          row.set('will be late', '');
        }

        await row.save();

        noShowCount++;
        logger.warn(`Marked ${name} (${telegramId}) as no-show with ${noShowPoint} points (penalty: ${Config.NO_SHOW_PENALTY})${saidLateButDidNotCome ? ' [said late but never came]' : ''}`);

        // Send notification to user using safe method
        if (telegramId && schedulerService.bot) {
          const message = saidLateButDidNotCome
            ? `⚠️ ВЫ ПОЛУЧИЛИ ШТРАФ\n\n` +
              `❌ Причина: Предупредили об опоздании, но не пришли на работу\n` +
              `📅 Дата: ${moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY')}\n\n` +
              `Вы уведомили об опоздании, но так и не пришли на работу.\n` +
              `Предупреждение об опоздании НЕ является уведомлением об отсутствии.\n\n` +
              `🔴 Штраф: ${Config.NO_SHOW_PENALTY} баллов (итого: ${noShowPoint})\n\n` +
              `Если Вы не можете прийти, пожалуйста, нажмите "🚫 Отсутствую"!`
            : `⚠️ ВЫ ПОЛУЧИЛИ ШТРАФ\n\n` +
              `❌ Причина: Отсутствие без уведомления\n` +
              `📅 Дата: ${moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY')}\n\n` +
              `Вы не отметили приход, не уведомили об опоздании и не отметили отсутствие.\n\n` +
              `🔴 Штраф: ${Config.NO_SHOW_PENALTY} баллов (итого: ${noShowPoint})\n\n` +
              `Пожалуйста, всегда уведомляйте о своём отсутствии!`;

          const sent = await schedulerService.sendMessageSafe(telegramId, message);
          if (!sent) {
            logger.warn(`Could not send no-show notification to ${telegramId} - user blocked or unreachable`);
          }
        }

        // Add delay to avoid rate limit and network exhaustion when processing multiple no-shows
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (isSunday) {
      logger.info(`Skipped no-show check on ${dateStr} (Sunday - everyone's day off)`);
    } else if (isSaturday && skippedWeekend > 0) {
      logger.info(`No-show check on ${dateStr} (Saturday): Skipped ${skippedWeekend} employees with day off, marked ${noShowCount} no-shows`);
    } else if (noShowCount > 0) {
      logger.info(`Marked ${noShowCount} employees as no-shows on ${dateStr}`);
    } else {
      logger.info(`No no-shows found on ${dateStr}`);
    }

    return noShowCount;
  } catch (error) {
    logger.error(`Error in checkAndMarkNoShows: ${error.message}`);
    throw error;
  }
}

/**
 * Main job execution function
 * @param {Object} schedulerService - Scheduler service instance
 */
async function execute(schedulerService) {
  try {
    const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
    logger.info(`Checking for no-shows on ${today}`);

    await checkAndMarkNoShows(today, schedulerService);

    logger.info(`No-show check completed for ${today}`);
  } catch (error) {
    logger.error(`Error checking no-shows: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  checkAndMarkNoShows,
  name: 'No-Show Check',
  description: 'Checks for no-shows at 20:00 and marks employees with no activity'
};
