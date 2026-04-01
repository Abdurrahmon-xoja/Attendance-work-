/**
 * Monthly Reminder to Users Job
 * Runs at 10:00 AM on the last day of every month to send a reminder to all registered users
 */

const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: At 10:00 AM on days 28-31
const schedule = '0 10 28-31 * *';

/**
 * Send monthly reminder to all users
 * @param {Object} schedulerService - Scheduler service instance (for bot and sendMessageSafe)
 */
async function sendMonthlyReminderToUsers(schedulerService) {
  try {
    if (!schedulerService.bot) {
      logger.error('Bot instance not initialized in scheduler');
      return;
    }

    const rosterWorksheet = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
    await rosterWorksheet.loadHeaderRow();
    const employees = await rosterWorksheet.getRows();

    let successCount = 0;
    let failCount = 0;

    const message = 
      '🔔 *Важное напоминание!*\n\n' +
      'Конец месяца приближается. Если в течение месяца у вас возникали какие-либо проблемы с ботом (например, неверно записанное время, ошибки в подсчете баллов), пожалуйста, срочно сообщите об этом администратору для исправления.\n\n' +
      '⚠️ *Если вы не сообщите о проблемах сегодня, ваши текущие баллы и отработанные часы будут зафиксированы как окончательные за этот месяц.*';

    for (const employee of employees) {
      const telegramId = employee.get('Telegram Id') || employee.get('TelegramId');
      
      if (telegramId && telegramId.trim()) {
        try {
          const sent = await schedulerService.sendMessageSafe(
            telegramId, 
            message,
            { parse_mode: 'Markdown' }
          );
          
          if (sent) {
            successCount++;
          } else {
            failCount++;
          }

          // Add a small delay to avoid hitting Telegram API rate limits (30 messages per second)
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          logger.error(`Failed to send monthly reminder to ${telegramId}: ${err.message}`);
          failCount++;
        }
      }
    }

    logger.info(`Monthly reminder sent to users: ${successCount} successful, ${failCount} failed`);

  } catch (error) {
    logger.error(`Error in sendMonthlyReminderToUsers: ${error.message}`);
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
      logger.info('Sending monthly reminder to all users');
      await sendMonthlyReminderToUsers(schedulerService);
      logger.info('Monthly reminder to all users completed');
    }
  } catch (error) {
    logger.error(`Error sending monthly reminder to users: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  sendMonthlyReminderToUsers,
  name: 'Monthly Reminder to Users',
  description: 'Sends a reminder to all users at 10:00 AM on the last day of the month about final points'
};
