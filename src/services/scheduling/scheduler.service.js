/**
 * Scheduler Service - Core
 * Initializes and manages all scheduled jobs
 * Uses node-cron to schedule automated tasks
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const Config = require('../../config');
const logger = require('../../utils/logger');

// Import all job modules
const jobs = require('./jobs');

class SchedulerService {
  constructor() {
    this.bot = null;
    this.jobs = [];
    // Track last adjusted end times to prevent redundant updates
    this._lastAdjustedEndTimes = new Map(); // key: telegramId, value: { endTime, deficitMinutes, date }
    // FIX #4: Track blocked users to prevent repeated failed message attempts
    this._blockedUsers = new Map(); // key: telegramId, value: { blockedAt, reason }
    // Track auto-departure warning messages for later cleanup
    this._autoDepartureWarningMessages = new Map(); // key: telegramId, value: messageId
  }

  /**
   * Retry operation with exponential backoff for quota errors
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise} Result of operation
   */
  async retryOperation(operation, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if it's a quota error (429)
        const isQuotaError = error.message && (
          error.message.includes('429') ||
          error.message.includes('Quota exceeded') ||
          error.message.includes('quota metric')
        );

        // Only retry on quota errors
        if (!isQuotaError || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff: 2s, 4s, 8s (longer than sheets service)
        const delay = 2000 * Math.pow(2, attempt);
        logger.warn(`Quota error in scheduler, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Retry Telegram API operation with exponential backoff for network errors
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise} Result of operation
   */
  async retryTelegramOperation(operation, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if it's a network error that should be retried
        const isNetworkError = error.message && (
          error.message.includes('EADDRNOTAVAIL') ||  // Address not available
          error.message.includes('ECONNRESET') ||     // Connection reset
          error.message.includes('ETIMEDOUT') ||      // Connection timeout
          error.message.includes('ENOTFOUND') ||      // DNS lookup failed
          error.message.includes('EAI_AGAIN') ||      // DNS temporary failure
          error.message.includes('ECONNREFUSED') ||   // Connection refused
          error.message.includes('socket hang up') || // Socket closed unexpectedly
          error.code === 'EADDRNOTAVAIL' ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'ECONNREFUSED'
        );

        // Only retry on network errors
        if (!isNetworkError || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s for network errors
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(`Network error in Telegram API call, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * FIX #4: Send Telegram message with blocked user handling
   * @param {string} telegramId - User's Telegram ID
   * @param {string} message - Message to send
   * @param {Object} options - Optional message options
   * @returns {Promise<boolean>} True if sent successfully, false if user is blocked
   */
  async sendMessageSafe(telegramId, message, options = {}) {
    // Check if user is already known to be blocked
    if (this._blockedUsers.has(telegramId)) {
      const blocked = this._blockedUsers.get(telegramId);
      logger.debug(`Skipping message to blocked user ${telegramId} (blocked since ${blocked.blockedAt})`);
      return false;
    }

    try {
      await this.retryTelegramOperation(async () => {
        await this.bot.telegram.sendMessage(telegramId, message, options);
      });
      return true;
    } catch (error) {
      const errCode = error.response?.error_code || error.code;
      const errDesc = error.response?.description || error.message || '';

      // Check for permanent errors (user blocked bot or chat not found)
      const PERMANENT_ERROR_CODES = [400, 403];
      const isPermanentError = PERMANENT_ERROR_CODES.includes(errCode) && (
        errDesc.includes('chat not found') ||
        errDesc.includes('bot was blocked') ||
        errDesc.includes('user is deactivated') ||
        errDesc.includes('Forbidden')
      );

      if (isPermanentError) {
        // Mark user as blocked
        this._blockedUsers.set(telegramId, {
          blockedAt: new Date().toISOString(),
          reason: errDesc
        });
        logger.warn(`User ${telegramId} marked as blocked/unreachable: ${errDesc}`);
        return false;
      }

      // For other errors, throw to allow retry logic
      throw error;
    }
  }

  /**
   * Round time to nearest 5-minute interval for cron matching
   * Since cron runs every 5 minutes, we need to round reminder times
   * to match the cron schedule (00, 05, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55)
   *
   * @param {moment} momentTime - Moment object to round
   * @returns {string} Rounded time in HH:mm format
   *
   * Examples:
   * - 09:17 → 09:15 (2 min early)
   * - 09:18 → 09:20 (2 min late)
   * - 09:32 → 09:30 (2 min early)
   * - 09:33 → 09:35 (2 min late)
   *
   * Maximum difference: ±2 minutes
   */
  roundToNearest5Minutes(momentTime) {
    const minute = momentTime.minute();
    const remainder = minute % 5;

    let roundedMinute;
    if (remainder === 0) {
      // Already on 5-minute interval
      roundedMinute = minute;
    } else if (remainder <= 2) {
      // Round down (0-2 minutes: round down)
      roundedMinute = minute - remainder;
    } else {
      // Round up (3-4 minutes: round up)
      roundedMinute = minute + (5 - remainder);
    }

    // Handle minute overflow (e.g., 59 → 60 becomes next hour)
    const rounded = momentTime.clone().minute(roundedMinute).second(0);

    return rounded.format('HH:mm');
  }

  /**
   * Initialize scheduler with bot instance
   * @param {Object} bot - Telegraf bot instance
   */
  init(bot) {
    this.bot = bot;

    if (Config.AUTO_CREATE_DAILY_SHEET) {
      this.setupDailySheetCreation();
      logger.info('✅ Auto daily sheet creation ENABLED');
    }

    if (Config.ENABLE_WORK_REMINDERS) {
      this.setupReminderChecks();
      logger.info('✅ Reminders ENABLED');

      // Enable monthly report creation if reminders are enabled
      this.setupMonthlyReportCreation();
      // this.setupDailyReportUpdate(); // DISABLED: This function destroys monthly data by trying to recalculate from all daily sheets (which are deleted). The transferDailyDataToMonthly() at 00:00 properly handles incremental updates.
    }

    // Report sending jobs
    this.setupDailyReportToAdmins();
    this.setupMonthlyReportToAdmins();
    
    // Monthly reminder to users
    this.setupMonthlyReminderToUsers();

    // No-show check and archiving jobs
    this.setupNoShowCheck();

    // End of day archiving job
    this.setupEndOfDayArchiving();
  }

  /**
   * Setup daily sheet creation job
   */
  setupDailySheetCreation() {
    const job = cron.schedule(jobs.dailySheetJob.schedule, async () => {
      try {
        await jobs.dailySheetJob.execute();
      } catch (error) {
        logger.error(`Error in daily sheet creation job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.dailySheetJob.name} job scheduled (${jobs.dailySheetJob.schedule})`);
  }

  /**
   * Setup reminder checks job
   */
  setupReminderChecks() {
    const job = cron.schedule(jobs.reminderChecksJob.schedule, async () => {
      try {
        await jobs.reminderChecksJob.execute(this);
      } catch (error) {
        logger.error(`Error in reminder checks job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.reminderChecksJob.name} job scheduled (${jobs.reminderChecksJob.schedule})`);
  }

  /**
   * Setup monthly report creation job
   */
  setupMonthlyReportCreation() {
    const job = cron.schedule(jobs.monthlyReportJob.schedule, async () => {
      try {
        await jobs.monthlyReportJob.execute();
      } catch (error) {
        logger.error(`Error in monthly report creation job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.monthlyReportJob.name} job scheduled (${jobs.monthlyReportJob.schedule})`);
  }

  /**
   * Setup daily report to admins job
   */
  setupDailyReportToAdmins() {
    const job = cron.schedule(jobs.dailyReportToAdminsJob.schedule, async () => {
      try {
        await jobs.dailyReportToAdminsJob.execute(this);
      } catch (error) {
        logger.error(`Error in daily report to admins job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.dailyReportToAdminsJob.name} job scheduled (${jobs.dailyReportToAdminsJob.schedule})`);
  }

  /**
   * Setup monthly report to admins job
   */
  setupMonthlyReportToAdmins() {
    const job = cron.schedule(jobs.monthlyReportToAdminsJob.schedule, async () => {
      try {
        await jobs.monthlyReportToAdminsJob.execute(this);
      } catch (error) {
        logger.error(`Error in monthly report to admins job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.monthlyReportToAdminsJob.name} job scheduled (${jobs.monthlyReportToAdminsJob.schedule})`);
  }

  /**
   * Setup monthly reminder to users
   */
  setupMonthlyReminderToUsers() {
    const job = cron.schedule(jobs.monthlyReminderToUsersJob.schedule, async () => {
      try {
        await jobs.monthlyReminderToUsersJob.execute(this);
      } catch (error) {
        logger.error(`Error in monthly reminder to users job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.monthlyReminderToUsersJob.name} job scheduled (${jobs.monthlyReminderToUsersJob.schedule})`);
  }

  /**
   * Setup no-show check job
   */
  setupNoShowCheck() {
    const job = cron.schedule(jobs.noShowCheckJob.schedule, async () => {
      try {
        await jobs.noShowCheckJob.execute(this);
      } catch (error) {
        logger.error(`Error in no-show check job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.noShowCheckJob.name} job scheduled (${jobs.noShowCheckJob.schedule})`);
  }

  /**
   * Setup end of day archiving job
   */
  setupEndOfDayArchiving() {
    const job = cron.schedule(jobs.endOfDayArchivingJob.schedule, async () => {
      try {
        await jobs.endOfDayArchivingJob.execute(this);
      } catch (error) {
        logger.error(`Error in end of day archiving job: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info(`${jobs.endOfDayArchivingJob.name} job scheduled (${jobs.endOfDayArchivingJob.schedule})`);
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    this.jobs.forEach(job => job.stop());
    logger.info('All scheduled jobs stopped');
  }
}

module.exports = SchedulerService;
