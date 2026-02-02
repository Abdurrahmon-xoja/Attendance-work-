/**
 * Monthly Report Creation Job
 * Runs at 00:05 on the 1st of every month to create monthly report sheets
 */

const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: At 00:05 on the 1st of every month
const schedule = '5 0 1 * *';

/**
 * Create monthly report for the current month
 */
async function execute() {
  try {
    const now = moment.tz(Config.TIMEZONE);
    const yearMonth = now.format('YYYY-MM');
    logger.info(`Creating monthly report for ${yearMonth}`);

    await sheetsService.initializeMonthlyReport(yearMonth);

    // Initialize Hours Calendar with retry on failure
    let calendarCreated = false;
    try {
      calendarCreated = await sheetsService.initializeHoursCalendar(yearMonth);
    } catch (calendarError) {
      logger.warn(`Hours Calendar creation failed, retrying in 5s: ${calendarError.message}`);
    }

    if (!calendarCreated) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        calendarCreated = await sheetsService.initializeHoursCalendar(yearMonth);
        if (calendarCreated) {
          logger.info(`Hours Calendar created successfully on retry`);
        } else {
          logger.error(`Hours Calendar creation failed on retry for ${yearMonth}`);
        }
      } catch (retryError) {
        logger.error(`Hours Calendar retry also failed: ${retryError.message}`);
      }
    }

    logger.info(`Monthly report ${yearMonth} created successfully`);
  } catch (error) {
    logger.error(`Error creating monthly report: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  name: 'Monthly Report Creation',
  description: 'Creates monthly report sheet at 00:05 on the 1st of each month'
};
