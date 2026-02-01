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
    await sheetsService.initializeHoursCalendar(yearMonth);

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
