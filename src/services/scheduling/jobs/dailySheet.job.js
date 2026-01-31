/**
 * Daily Sheet Creation Job
 * Runs at 00:01 every day to create daily attendance sheets
 * Skips Sundays (day off for everyone)
 */

const moment = require('moment-timezone');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: Every day at 00:01 AM
const schedule = '1 0 * * *';

/**
 * Create daily sheet for today
 * Skips Sunday (nobody works on Sunday)
 */
async function execute() {
  try {
    const now = moment.tz(Config.TIMEZONE);
    const today = now.format('YYYY-MM-DD');
    const isSunday = now.day() === 0;

    // Skip creating sheet on Sunday (nobody works on Sunday)
    if (isSunday) {
      logger.info(`Skipping daily sheet creation for ${today} (Sunday - day off for everyone)`);
      return;
    }

    logger.info(`Creating daily sheet for ${today}`);

    await sheetsService.initializeDailySheet(today);

    logger.info(`Daily sheet ${today} created successfully`);
  } catch (error) {
    logger.error(`Error creating daily sheet: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  name: 'Daily Sheet Creation',
  description: 'Creates daily attendance sheet at 00:01 (skips Sundays)'
};
