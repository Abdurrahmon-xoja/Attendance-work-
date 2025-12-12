/**
 * Scheduler service for automated tasks
 * Uses node-cron to schedule daily sheet creation and reminders
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const Config = require('../config');
const sheetsService = require('./sheets.service');
const logger = require('../utils/logger');

class SchedulerService {
  constructor() {
    this.bot = null;
    this.jobs = [];
    // Track last adjusted end times to prevent redundant updates
    this._lastAdjustedEndTimes = new Map(); // key: telegramId, value: { endTime, deficitMinutes, date }
    // FIX #4: Track blocked users to prevent repeated failed message attempts
    this._blockedUsers = new Map(); // key: telegramId, value: { blockedAt, reason }
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
    } else {
      logger.info('⚠️  Auto daily sheet creation DISABLED (development mode)');
    }

    if (Config.ENABLE_WORK_REMINDERS) {
      this.setupReminderChecks();
      logger.info('✅ Work reminders ENABLED');
    } else {
      logger.info('⚠️  Work reminders DISABLED');
    }

    // Setup monthly report
    if (Config.AUTO_UPDATE_MONTHLY_REPORT) {
      this.setupMonthlyReportCreation();
      // this.setupDailyReportUpdate(); // DISABLED: This function destroys monthly data by trying to recalculate from all daily sheets (which are deleted). The transferDailyDataToMonthly() at 00:00 properly handles incremental updates.
      logger.info('✅ Monthly report system ENABLED');
    } else {
      logger.info('⚠️  Monthly report system DISABLED');
    }

    // Setup automatic report sending to admins
    this.setupDailyReportToAdmins();
    this.setupMonthlyReportToAdmins();
    logger.info('✅ Automatic report sending to admins ENABLED');

    // Setup no-show penalty check
    this.setupNoShowCheck();
    logger.info('✅ No-show penalty check ENABLED');

    // Setup end-of-day archiving process
    this.setupEndOfDayArchiving();
    logger.info('✅ End-of-day archiving ENABLED');

    logger.info('Scheduler service initialized');
  }

  /**
   * Create daily attendance sheet at midnight
   */
  setupDailySheetCreation() {
    // Run at 00:01 every day (1 minute after midnight)
    const job = cron.schedule('1 0 * * *', async () => {
      try {
        const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
        logger.info(`Creating daily sheet for ${today}`);

        await sheetsService.initializeDailySheet(today);

        logger.info(`Daily sheet ${today} created successfully`);
      } catch (error) {
        logger.error(`Error creating daily sheet: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Daily sheet creation job scheduled (runs at 00:01 every day)');
  }

  /**
   * Check every 5 minutes for reminders to send
   * Sends reminder 15 minutes before work start time
   */
  setupReminderChecks() {
    // Run every 5 minutes to check if we need to send reminders
    const job = cron.schedule('*/5 * * * *', async () => {
      try {
        await this.checkAndSendReminders();
      } catch (error) {
        logger.error(`Error in reminder check: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Reminder check job scheduled (runs every 5 minutes)');
  }

  /**
   * Check if any employees need reminders and send them
   * Sends 3 reminders: 15 min before, at work time, and 15 min after
   * Also automatically marks as late if 17+ minutes late
   */
  async checkAndSendReminders() {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');
      const currentMinute = now.format('HH:mm');

      // Check if today's sheet exists
      const sheetExists = sheetsService.doc.sheetsByTitle[today];
      if (!sheetExists) {
        // Sheet doesn't exist yet - skip reminder check
        // Sheet will be created when first user marks attendance
        return;
      }

      // Get today's attendance sheet with retry logic
      const worksheet = await this.retryOperation(async () => {
        const ws = await sheetsService.getWorksheet(today);
        await ws.loadHeaderRow();
        return ws;
      });

      const rows = await this.retryOperation(async () => {
        return await worksheet.getRows();
      });

      // Get roster to check work times with retry logic
      const roster = await this.retryOperation(async () => {
        const r = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
        await r.loadHeaderRow();
        return r;
      });

      const rosterRows = await this.retryOperation(async () => {
        return await roster.getRows();
      });

      // OPTIMIZATION: Collect rows that need updates for batch saving
      const rowsToUpdate = [];

      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const whenCome = row.get('When come') || '';
        const isAbsent = row.get('Absent') || '';
        const willBeLate = row.get('will be late') || '';
        const cameOnTime = row.get('Came on time') || '';
        const reminder1Sent = row.get('reminder_1_sent') || 'false';
        const reminder2Sent = row.get('reminder_2_sent') || 'false';
        const reminder3Sent = row.get('reminder_3_sent') || 'false';

        // Skip if no telegram ID
        if (!telegramId || !telegramId.trim()) {
          continue;
        }

        // Skip if person is absent
        if (isAbsent.toLowerCase() === 'yes' || isAbsent.toLowerCase() === 'true') {
          continue;
        }

        // Check if person already did any action
        const hasArrived = whenCome.trim() !== '';
        const hasNotifiedLate = willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true';
        const shouldSendReminders = !hasArrived;

        // Skip reminders if person already arrived
        // If person notified they'll be late, reminders will be sent using adjusted expected arrival time
        if (hasArrived) {
          continue;
        }

        // Get work time from roster
        let workTime = null;
        for (const rosterRow of rosterRows) {
          const rosterTelegramId = rosterRow.get('Telegram Id') || '';
          if (rosterTelegramId.toString().trim() === telegramId.toString().trim()) {
            workTime = rosterRow.get('Work time') || '';
            break;
          }
        }

        if (!workTime || workTime === '-') {
          continue;
        }

        // Parse work start time
        const startTime = workTime.split('-')[0].trim();
        const [startHour, startMinute] = startTime.split(':').map(num => parseInt(num));
        let workStart = moment.tz(Config.TIMEZONE)
          .set({ hour: startHour, minute: startMinute, second: 0 });

        // Check if person notified they'll be late - adjust reminder times accordingly
        const lateExpectedArrival = row.get('will be late will come at') || '';
        if (willBeLate.toLowerCase() === 'yes' && lateExpectedArrival.trim()) {
          // Parse expected arrival time (e.g., "10:00" or "60 минут")
          let adjustedTime = null;

          if (lateExpectedArrival.includes(':')) {
            // Format: "10:00"
            const [arrivalHour, arrivalMin] = lateExpectedArrival.split(':').map(num => parseInt(num));
            adjustedTime = moment.tz(Config.TIMEZONE)
              .set({ hour: arrivalHour, minute: arrivalMin, second: 0 });
          } else {
            // Format: "60 минут" - extract number and add to work start
            const minutes = parseInt(lateExpectedArrival.match(/\d+/)?.[0] || '0');
            if (minutes > 0) {
              adjustedTime = workStart.clone().add(minutes, 'minutes');
            }
          }

          // Use adjusted time if successfully parsed
          if (adjustedTime) {
            workStart = adjustedTime;
            // Note: Adjusted time will be logged when reminder is actually sent
          }
        }

        // Calculate 3 reminder times (based on adjusted time if late notification given)
        // Round to nearest 5-minute interval since cron runs every 5 minutes
        const reminder1Time = this.roundToNearest5Minutes(workStart.clone().subtract(15, 'minutes'));
        const reminder2Time = this.roundToNearest5Minutes(workStart.clone());
        const reminder3Time = this.roundToNearest5Minutes(workStart.clone().add(15, 'minutes'));

        // Use adjusted time for reminder messages if person notified they'll be late
        const reminderTime = workStart.format('HH:mm');
        const isAdjustedTime = willBeLate.toLowerCase() === 'yes' && lateExpectedArrival.trim();

        // Only send reminders if person hasn't taken any action yet
        if (shouldSendReminders) {
          // Check and send reminder 1 (15 min before)
          if (currentMinute === reminder1Time && reminder1Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 1, reminderTime);
            row.set('reminder_1_sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save
            logger.info(`Sent reminder 1 to ${name} (${telegramId}) at ${currentMinute}${isAdjustedTime ? ` - adjusted for late arrival at ${reminderTime}` : ''}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          // Check and send reminder 2 (at work time)
          if (currentMinute === reminder2Time && reminder2Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 2, reminderTime);
            row.set('reminder_2_sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save
            logger.info(`Sent reminder 2 to ${name} (${telegramId}) at ${currentMinute}${isAdjustedTime ? ` - adjusted for late arrival at ${reminderTime}` : ''}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          // Check and send reminder 3 (15 min after)
          if (currentMinute === reminder3Time && reminder3Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 3, reminderTime);
            row.set('reminder_3_sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save
            logger.info(`Sent reminder 3 to ${name} (${telegramId}) at ${currentMinute}${isAdjustedTime ? ` - adjusted for late arrival at ${reminderTime}` : ''}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        // Check if person should be automatically marked as late (20+ minutes after start)
        const minutesSinceStart = now.diff(workStart, 'minutes');
        if (minutesSinceStart >= 20) {
          // Skip auto-late marking on Sunday OR (Saturday AND user doesn't work on Saturday)
          const isSunday = now.day() === 0;
          const isSaturday = now.day() === 6;

          if (isSunday) {
            logger.debug(`Skipping auto-late marking for ${name} - today is Sunday`);
            continue;
          }

          if (isSaturday) {
            const user = await sheetsService.findEmployeeByTelegramId(telegramId);
            if (user && user.doNotWorkSaturday) {
              logger.debug(`Skipping auto-late marking for ${name} - Saturday is their day off`);
              continue;
            }
          }

          // Person is 20+ minutes late
          // Check if they haven't notified they'll be late and haven't been marked yet
          const alreadyMarkedLate = cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false';
          const notifiedLate = willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true';
          const isAbsentNow = isAbsent.toLowerCase() === 'yes' || isAbsent.toLowerCase() === 'true';

          // Don't mark late if already marked late, notified, or marked absent (fraud)
          if (!alreadyMarkedLate && !notifiedLate && !isAbsentNow) {
            // Automatically mark as late (silent - no notification given)
            row.set('Came on time', 'No');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

            // Log the silent late event
            const CalculatorService = require('./calculator.service');
            const ratingImpact = CalculatorService.calculateRatingImpact('LATE_SILENT');
            await sheetsService.logEvent(
              telegramId,
              name,
              'LATE_SILENT',
              `автоматически отмечен опоздавшим на ${minutesSinceStart} минут`,
              ratingImpact
            );

            // FIX #4: Send notification to employee using safe method
            const sent = await this.sendMessageSafe(
              telegramId,
              `⚠️ Вы автоматически отмечены как опоздавший\n\n` +
              `Вы не пришли на работу вовремя (${startTime}).\n` +
              `Прошло уже ${minutesSinceStart} минут с начала рабочего дня.\n\n` +
              `Пожалуйста, отметьте свой приход, когда придёте.`
            );
            if (!sent) {
              logger.warn(`Could not send auto-late notification to ${telegramId} - user blocked or unreachable`);
            }

            logger.info(`Automatically marked ${name} (${telegramId}) as late (${minutesSinceStart} min)`);

            // Add delay to avoid hitting Google API rate limit and prevent network exhaustion
            await new Promise(resolve => setTimeout(resolve, 2000)); // Increased from 1s to 2s
          }
        }
      }

      // Check for temporary exit return reminders
      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const currentlyOut = row.get('Currently out') || 'false';
        const tempExitRemindAt = row.get('Temp exit remind at') || '';
        const tempExitRemindSent = row.get('Temp exit remind sent') || 'false';
        const tempExitExpectedReturn = row.get('Temp exit expected return') || '';

        // Skip if no telegram ID
        if (!telegramId || !telegramId.trim()) {
          continue;
        }

        // Skip if not currently out
        if (currentlyOut.toLowerCase() !== 'true') {
          continue;
        }

        // Skip if reminder already sent
        if (tempExitRemindSent.toLowerCase() === 'true') {
          continue;
        }

        // Skip if no remind time
        if (!tempExitRemindAt.trim()) {
          continue;
        }

        // Get the last remind time (most recent exit)
        const remindAtArray = tempExitRemindAt.split('; ');
        const lastRemindAt = remindAtArray[remindAtArray.length - 1];

        // Check if current time matches remind time (15 min before expected return)
        if (currentMinute === lastRemindAt.substring(0, 5)) {
          // Time to send return reminder
          try {
            const tempExitReason = row.get('Temp exit reason') || '';
            const expectedReturnArray = tempExitExpectedReturn.split('; ');
            const lastExpectedReturn = expectedReturnArray[expectedReturnArray.length - 1];
            const expectedReturnTime = lastExpectedReturn.substring(0, 5);

            // Get last reason
            const reasonArray = tempExitReason.split('; ');
            const lastReason = reasonArray[reasonArray.length - 1];

            const Markup = require('telegraf').Markup;

            // Send reminder with interactive buttons
            await this.retryTelegramOperation(async () => {
              await this.bot.telegram.sendMessage(
                telegramId,
                `⏰ Напоминание о возвращении\n\n` +
                `У вас осталось 15 минут до времени возвращения.\n` +
                `Причина выхода: ${lastReason}\n` +
                `Ожидаемое возвращение: ${expectedReturnTime}\n\n` +
                `Вам нужно больше времени?`,
                Markup.inlineKeyboard([
                  [
                    Markup.button.callback('✅ Вернусь вовремя', 'temp_exit_confirm_return'),
                    Markup.button.callback('⏱ +15 мин', 'temp_exit_extend:15')
                  ],
                  [
                    Markup.button.callback('⏱ +30 мин', 'temp_exit_extend:30'),
                    Markup.button.callback('⏱ +45 мин', 'temp_exit_extend:45')
                  ],
                  [
                    Markup.button.callback('⏱ +1 час', 'temp_exit_extend:60')
                  ]
                ])
              );
            });

            // Mark reminder as sent
            row.set('Temp exit remind sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

            logger.info(`Sent temp exit return reminder to ${name} (${telegramId}) - 15 min before ${expectedReturnTime}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            logger.error(`Failed to send temp exit reminder to ${telegramId}: ${err.message}`);
          }
        }
      }

      // Check for departure reminders (15 min before required end time + deficit)
      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const whenCome = row.get('When come') || '';
        const leaveTime = row.get('Leave time') || '';
        const departureReminderSent = row.get('departure_reminder_sent') || 'false';

        // Skip if no telegram ID
        if (!telegramId || !telegramId.trim()) {
          continue;
        }

        // Skip if person hasn't arrived yet
        if (!whenCome.trim()) {
          continue;
        }

        // Skip if person already left
        if (leaveTime.trim()) {
          continue;
        }

        // Skip if reminder already sent
        if (departureReminderSent.toLowerCase() === 'true') {
          continue;
        }

        // Skip departure reminders on Sunday OR (Saturday AND user doesn't work on Saturday)
        const isSunday = now.day() === 0;
        const isSaturday = now.day() === 6;

        if (isSunday) {
          logger.debug(`Skipping departure reminder for ${name} - today is Sunday`);
          continue;
        }

        if (isSaturday) {
          const user = await sheetsService.findEmployeeByTelegramId(telegramId);
          if (user && user.doNotWorkSaturday) {
            logger.debug(`Skipping departure reminder for ${name} - Saturday is their day off`);
            continue;
          }
        }

        // Get work time from roster
        let workTime = null;
        for (const rosterRow of rosterRows) {
          const rosterTelegramId = rosterRow.get('Telegram Id') || '';
          if (rosterTelegramId.toString().trim() === telegramId.toString().trim()) {
            workTime = rosterRow.get('Work time') || '';
            break;
          }
        }

        if (!workTime || workTime === '-') {
          continue;
        }

        // Parse work end time
        const endTime = workTime.split('-')[1]?.trim();
        if (!endTime) continue;

        const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));
        let workEnd = moment.tz(Config.TIMEZONE)
          .set({ hour: endHour, minute: endMinute, second: 0 });

        // Get monthly balance to calculate deficit
        try {
          const balance = await sheetsService.getMonthlyBalance(telegramId);
          const deficitMinutes = balance.totalDeficitMinutes || 0;

          // Add deficit time to required end time
          if (deficitMinutes > 0) {
            workEnd = workEnd.clone().add(deficitMinutes, 'minutes');

            // FIX #1: Only log if the end time actually changed
            const cacheKey = `${telegramId}-${now.format('YYYY-MM-DD')}`;
            const cached = this._lastAdjustedEndTimes.get(cacheKey);
            const newEndTime = workEnd.format('HH:mm');

            // Only log and update if this is a new adjustment or values changed
            if (!cached || cached.endTime !== newEndTime || cached.deficitMinutes !== deficitMinutes) {
              logger.info(`Adjusted end time for ${name}: ${newEndTime} (+${deficitMinutes} min deficit)`);
              this._lastAdjustedEndTimes.set(cacheKey, {
                endTime: newEndTime,
                deficitMinutes: deficitMinutes,
                date: now.format('YYYY-MM-DD')
              });
            }
            // Otherwise skip logging - no change detected
          }
        } catch (balanceErr) {
          logger.error(`Error getting balance for ${name}: ${balanceErr.message}`);
          // Continue with normal end time if can't get balance
        }

        // Calculate reminder time (15 min before adjusted end time)
        const departureReminderTime = workEnd.clone().subtract(15, 'minutes').format('HH:mm');

        // Check if current time matches reminder time
        if (currentMinute === departureReminderTime) {
          try {
            const requiredEndTime = workEnd.format('HH:mm');
            const normalEndTime = endTime;
            const extraMinutes = workEnd.diff(moment.tz(Config.TIMEZONE).set({ hour: endHour, minute: endMinute, second: 0 }), 'minutes');

            let message = `⏰ Напоминание об окончании рабочего дня\n\n`;

            if (extraMinutes > 0) {
              const hours = Math.floor(extraMinutes / 60);
              const mins = extraMinutes % 60;
              const extraTime = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

              message += `Ваше рабочее время заканчивается в ${normalEndTime}\n`;
              message += `⚠️ НО у вас есть недоработка: ${extraTime}\n\n`;
              message += `📌 Вам нужно остаться до ${requiredEndTime}\n\n`;
              message += `💡 Это поможет погасить вашу недоработку за предыдущие дни.`;
            } else {
              message += `Ваше рабочее время заканчивается в ${requiredEndTime}\n\n`;
              message += `Не забудьте отметить уход командой "- сообщение"`;
            }

            await this.retryTelegramOperation(async () => {
              await this.bot.telegram.sendMessage(telegramId, message);
            });

            // Mark reminder as sent
            row.set('departure_reminder_sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

            logger.info(`Sent departure reminder to ${name} (${telegramId}) for ${requiredEndTime}`);
            // Add delay to avoid rate limit and network exhaustion
            await new Promise(resolve => setTimeout(resolve, 2000)); // Increased from 500ms to 2s
          } catch (err) {
            logger.error(`Failed to send departure reminder to ${telegramId}: ${err.message}`);
          }
        }
      }

      // Check for extended work reminders (15 min before extended end time)
      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const whenCome = row.get('When come') || '';
        const leaveTime = row.get('Leave time') || '';
        const workExtensionMinutes = parseInt(row.get('work_extension_minutes') || '0');
        const extendedWorkReminderSent = row.get('extended_work_reminder_sent') || 'false';

        // Skip if no telegram ID
        if (!telegramId || !telegramId.trim()) {
          continue;
        }

        // Skip if person hasn't arrived yet
        if (!whenCome.trim()) {
          continue;
        }

        // Skip if person already left
        if (leaveTime.trim()) {
          continue;
        }

        // Skip if no work extension
        if (workExtensionMinutes <= 0) {
          continue;
        }

        // Skip if reminder already sent
        if (extendedWorkReminderSent.toLowerCase() === 'true') {
          continue;
        }

        // Skip extended work reminders on Sunday OR (Saturday AND user doesn't work on Saturday)
        const isSunday = now.day() === 0;
        const isSaturday = now.day() === 6;

        if (isSunday) {
          logger.debug(`Skipping extended work reminder for ${name} - today is Sunday`);
          continue;
        }

        if (isSaturday) {
          const user = await sheetsService.findEmployeeByTelegramId(telegramId);
          if (user && user.doNotWorkSaturday) {
            logger.debug(`Skipping extended work reminder for ${name} - Saturday is their day off`);
            continue;
          }
        }

        // Get work time from roster
        let workTime = null;
        for (const rosterRow of rosterRows) {
          const rosterTelegramId = rosterRow.get('Telegram Id') || '';
          if (rosterTelegramId.toString().trim() === telegramId.toString().trim()) {
            workTime = rosterRow.get('Work time') || '';
            break;
          }
        }

        if (!workTime || workTime === '-') {
          continue;
        }

        // Parse work end time
        const endTime = workTime.split('-')[1]?.trim();
        if (!endTime) continue;

        const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));
        let workEnd = moment.tz(Config.TIMEZONE)
          .set({ hour: endHour, minute: endMinute, second: 0 });

        // Add work extension to end time
        const extendedWorkEnd = workEnd.clone().add(workExtensionMinutes, 'minutes');

        // Calculate reminder time (15 min before extended end time)
        // Round to nearest 5-minute interval since cron runs every 5 minutes
        const extendedWorkReminderTime = this.roundToNearest5Minutes(
          extendedWorkEnd.clone().subtract(15, 'minutes')
        );

        // Check if current time matches reminder time
        if (currentMinute === extendedWorkReminderTime) {
          try {
            const extendedEndTimeStr = extendedWorkEnd.format('HH:mm');
            const hours = Math.floor(workExtensionMinutes / 60);
            const mins = workExtensionMinutes % 60;
            const extensionText = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

            const message =
              `⏰ Напоминание о продленном рабочем времени\n\n` +
              `Ваше продленное рабочее время заканчивается через 15 минут\n` +
              `Время окончания: ${extendedEndTimeStr}\n\n` +
              `Вы продлили работу на: ${extensionText}\n\n` +
              `Не забудьте отметить уход командой "- сообщение"`;

            await this.retryTelegramOperation(async () => {
              await this.bot.telegram.sendMessage(telegramId, message);
            });

            // Mark reminder as sent
            row.set('extended_work_reminder_sent', 'true');
            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

            logger.info(`Sent extended work reminder to ${name} (${telegramId}) for ${extendedEndTimeStr} (extension: ${extensionText})`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (err) {
            logger.error(`Failed to send extended work reminder to ${telegramId}: ${err.message}`);
          }
        }
      }

      // FIX #1: Clean up old cached end times (keep only today's entries)
      // Note: 'today' is already declared at the top of this function
      for (const [key, value] of this._lastAdjustedEndTimes.entries()) {
        if (value.date !== today) {
          this._lastAdjustedEndTimes.delete(key);
        }
      }

      // AUTO-DEPARTURE CHECK: Check for employees who forgot to mark departure
      if (Config.ENABLE_AUTO_DEPARTURE) {
        for (const row of rows) {
          const name = row.get('Name') || '';
          const telegramId = row.get('TelegramId') || '';
          const whenCome = row.get('When come') || '';
          const leaveTime = row.get('Leave time') || '';
          const autoDepartureWarningSent = row.get('auto_departure_warning_sent') || 'false';
          const workExtensionMinutes = parseInt(row.get('work_extension_minutes') || '0');

          // Skip if no telegram ID
          if (!telegramId || !telegramId.trim()) {
            continue;
          }

          // Skip if person hasn't arrived yet
          if (!whenCome.trim()) {
            continue;
          }

          // Skip if person already left
          if (leaveTime.trim()) {
            continue;
          }

          // Get work time from roster
          let workTime = null;
          for (const rosterRow of rosterRows) {
            const rosterTelegramId = rosterRow.get('Telegram Id') || '';
            if (rosterTelegramId.toString().trim() === telegramId.toString().trim()) {
              workTime = rosterRow.get('Work time') || '';
              break;
            }
          }

          if (!workTime || workTime === '-') {
            continue;
          }

          // Parse work end time
          const endTime = workTime.split('-')[1]?.trim();
          if (!endTime) continue;

          const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));
          let workEnd = moment.tz(Config.TIMEZONE)
            .set({ hour: endHour, minute: endMinute, second: 0 });

          // Add work extension if user requested it
          if (workExtensionMinutes > 0) {
            workEnd = workEnd.clone().add(workExtensionMinutes, 'minutes');
          }

          // Calculate auto-departure time (work end + grace period)
          const autoDepartureTime = workEnd.clone().add(Config.AUTO_DEPARTURE_GRACE_MINUTES, 'minutes');
          const warningTime = autoDepartureTime.clone().subtract(Config.AUTO_DEPARTURE_WARNING_MINUTES, 'minutes');

          const minutesUntilAutoDeparture = autoDepartureTime.diff(now, 'minutes');
          const currentMinute = now.format('HH:mm');
          const warningMinute = warningTime.format('HH:mm');

          // Send warning if it's time and not sent yet
          if (currentMinute === warningMinute && autoDepartureWarningSent.toLowerCase() !== 'true') {
            try {
              const Markup = require('telegraf').Markup;

              // Format the actual end time (including extension if any)
              const actualEndTime = workEnd.format('HH:mm');

              // Build warning message
              let warningMessage = `⏰ Напоминание об окончании работы\n\n`;

              if (workExtensionMinutes > 0) {
                const hours = Math.floor(workExtensionMinutes / 60);
                const mins = workExtensionMinutes % 60;
                const extensionText = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

                warningMessage += `Ваше плановое время: ${endTime}\n`;
                warningMessage += `Продление: +${extensionText}\n`;
                warningMessage += `Текущее окончание работы: ${actualEndTime}\n\n`;
              } else {
                warningMessage += `Ваше рабочее время закончилось в ${actualEndTime}.\n`;
              }

              warningMessage += `Вы не отметили уход.\n\n`;
              warningMessage += `⚠️ Через ${Config.AUTO_DEPARTURE_WARNING_MINUTES} минут вы будете автоматически отмечены как ушедший.\n\n`;
              warningMessage += `Что вы хотите сделать?`;

              // Send warning and store message ID
              let sentMessage = null;
              await this.retryTelegramOperation(async () => {
                sentMessage = await this.bot.telegram.sendMessage(
                  telegramId,
                  warningMessage,
                  Markup.inlineKeyboard([
                    [
                      Markup.button.callback('✅ Отметить уход сейчас', 'auto_depart_now'),
                      Markup.button.callback('⏱ +30 мин', 'extend_work:30')
                    ],
                    [
                      Markup.button.callback('⏱ +1 час', 'extend_work:60'),
                      Markup.button.callback('⏱ +2 часа', 'extend_work:120')
                    ],
                    [
                      Markup.button.callback('⏱ Работаю всю ночь', 'extend_work:480')
                    ]
                  ])
                );
              });

              // Store message ID for later cleanup
              if (sentMessage) {
                if (!this._autoDepartureWarningMessages) {
                  this._autoDepartureWarningMessages = new Map();
                }
                this._autoDepartureWarningMessages.set(telegramId, sentMessage.message_id);
              }

              // Mark warning as sent
              row.set('auto_departure_warning_sent', 'true');
              rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

              logger.info(`Sent auto-departure warning to ${name} (${telegramId})`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
              logger.error(`Failed to send auto-departure warning to ${telegramId}: ${err.message}`);
            }
          }

          // Auto-depart if time has come
          if (minutesUntilAutoDeparture <= 0) {
            try {
              const CalculatorService = require('./calculator.service');

              // Mark departure
              const departureTime = now.format('HH:mm');
              row.set('Leave time', departureTime);

              // Calculate hours worked
              const arrivalTime = moment.tz(`${today} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
              const minutesWorked = now.diff(arrivalTime, 'minutes');
              const hoursWorked = minutesWorked / 60;
              row.set('Hours worked', hoursWorked.toFixed(2));

              rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

              // Remove buttons from warning message if it exists
              if (this._autoDepartureWarningMessages && this._autoDepartureWarningMessages.has(telegramId)) {
                const warningMessageId = this._autoDepartureWarningMessages.get(telegramId);
                try {
                  // Edit the message to remove buttons and update text
                  await this.bot.telegram.editMessageText(
                    telegramId,
                    warningMessageId,
                    null,
                    `⏰ Напоминание об окончании работы\n\n` +
                    `Ваше рабочее время закончилось.\n` +
                    `Вы не отметили уход.\n\n` +
                    `✅ Вы были автоматически отмечены как ушедший в ${departureTime}`
                  );
                  logger.info(`Removed buttons from warning message for ${name} (${telegramId})`);
                } catch (err) {
                  logger.warn(`Could not edit warning message for ${telegramId}: ${err.message}`);
                }
                // Clean up the stored message ID
                this._autoDepartureWarningMessages.delete(telegramId);
              }

              // Log the auto-departure event
              await sheetsService.logEvent(
                telegramId,
                name,
                'AUTO_DEPARTURE',
                `автоматически отмечен как ушедший в ${departureTime}`,
                0
              );

              // Send notification to employee
              const sent = await this.sendMessageSafe(
                telegramId,
                `✅ Вы автоматически отмечены как ушедший\n\n` +
                `🕐 Время ухода: ${departureTime}\n` +
                `⏱ Отработано: ${CalculatorService.formatTimeDiff(minutesWorked)}\n\n` +
                `Если вы всё ещё на работе, пожалуйста, отметьте приход заново.`
              );

              if (!sent) {
                logger.warn(`Could not send auto-departure notification to ${telegramId} - user blocked or unreachable`);
              }

              logger.info(`Auto-departed ${name} (${telegramId}) at ${departureTime} after ${minutesWorked} minutes of work`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
              logger.error(`Failed to auto-depart ${telegramId}: ${err.message}`);
            }
          }
        }
      }

      // OPTIMIZATION: Batch save all row updates at once
      if (rowsToUpdate.length > 0) {
        logger.info(`Batch saving ${rowsToUpdate.length} row updates...`);
        await sheetsService.batchSaveRows(rowsToUpdate);
        logger.info(`Successfully batch saved ${rowsToUpdate.length} rows`);
      }
    } catch (error) {
      logger.error(`Error checking reminders: ${error.message}`);
    }
  }

  /**
   * Send work reminder to employee
   * @param {string} telegramId - Employee's Telegram ID
   * @param {string} name - Employee's name
   * @param {number} reminderNumber - Which reminder (1, 2, or 3)
   * @param {string} workStartTime - Work start time (e.g., "10:00")
   */
  async sendWorkReminder(telegramId, name, reminderNumber, workStartTime) {
    try {
      if (!this.bot) {
        logger.error('Bot instance not initialized in scheduler');
        return;
      }

      // Skip reminders on Sunday OR (Saturday AND user doesn't work on Saturday)
      const now = moment.tz(Config.TIMEZONE);
      const isSunday = now.day() === 0;
      const isSaturday = now.day() === 6;

      if (isSunday) {
        logger.info(`Skipping work reminder for ${name} - today is Sunday`);
        return;
      }

      if (isSaturday) {
        // Check if user works on Saturday
        const user = await sheetsService.findEmployeeByTelegramId(telegramId);
        if (user && user.doNotWorkSaturday) {
          logger.info(`Skipping work reminder for ${name} - Saturday is their day off`);
          return;
        }
      }

      let message;
      if (reminderNumber === 1) {
        // 15 minutes before work
        message = `⏰ Напоминание о начале работы\n\n` +
                 `Ваша работа начинается через 15 минут (в ${workStartTime})!\n\n` +
                 `💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.\n\n` +
                 `Отметьте свой приход, когда придёте в офис.`;
      } else if (reminderNumber === 2) {
        // At work start time
        message = `⏰ Время начала работы\n\n` +
                 `Ваша работа начинается сейчас (${workStartTime}).\n\n` +
                 `💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.\n\n` +
                 `Отметьте свой приход, когда придёте в офис.`;
      } else if (reminderNumber === 3) {
        // 15 minutes after work start
        message = `⚠️ Напоминание о работе\n\n` +
                 `Прошло 15 минут с начала рабочего дня (${workStartTime}).\n\n` +
                 `💡 Если вы опаздываете, лучше сообщить об этом администрации через бот.\n\n` +
                 `Не забудьте отметить свой приход.`;
      }

      await this.retryTelegramOperation(async () => {
        await this.bot.telegram.sendMessage(telegramId, message);
      });
    } catch (error) {
      logger.error(`Error sending reminder to ${telegramId} after retries: ${error.message}`);
    }
  }

  /**
   * Create monthly report sheet at the start of each month
   */
  setupMonthlyReportCreation() {
    // Run at 00:05 on the 1st of every month
    const job = cron.schedule('5 0 1 * *', async () => {
      try {
        const now = moment.tz(Config.TIMEZONE);
        const yearMonth = now.format('YYYY-MM');
        logger.info(`Creating monthly report for ${yearMonth}`);

        await sheetsService.initializeMonthlyReport(yearMonth);

        logger.info(`Monthly report ${yearMonth} created successfully`);
      } catch (error) {
        logger.error(`Error creating monthly report: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Monthly report creation job scheduled (runs at 00:05 on 1st of each month)');
  }

  /**
   * Update monthly report daily at end of day
   */
  setupDailyReportUpdate() {
    // Run at 23:55 every day to update the monthly report with today's data
    const job = cron.schedule('55 23 * * *', async () => {
      try {
        const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
        logger.info(`Updating monthly report with data from ${today}`);

        await sheetsService.updateMonthlyReport(today);

        logger.info(`Monthly report updated successfully with ${today} data`);
      } catch (error) {
        logger.error(`Error updating monthly report: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Daily report update job scheduled (runs at 23:55 every day)');
  }

  /**
   * Send daily report to admins at end of day
   */
  setupDailyReportToAdmins() {
    // Run at 23:59 every day to send report to admins
    const job = cron.schedule('59 23 * * *', async () => {
      try {
        const now = moment.tz(Config.TIMEZONE);
        const today = now.format('YYYY-MM-DD');

        // Skip daily report on Sunday (day 0)
        if (now.day() === 0) {
          logger.info(`Skipping daily report for ${today} - today is Sunday`);
          return;
        }

        logger.info(`Sending daily report to admins for ${today}`);

        await this.sendDailyReportToAdmins(today);

        logger.info(`Daily report sent to admins for ${today}`);
      } catch (error) {
        logger.error(`Error sending daily report to admins: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Daily report to admins job scheduled (runs at 23:59 every day)');
  }

  /**
   * Send monthly report to admins at end of month
   */
  setupMonthlyReportToAdmins() {
    // Run at 23:59 on the last day of every month
    const job = cron.schedule('59 23 28-31 * *', async () => {
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

          await this.sendMonthlyReportToAdmins(yearMonth);

          logger.info(`Monthly report sent to admins for ${yearMonth}`);
        }
      } catch (error) {
        logger.error(`Error sending monthly report to admins: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Monthly report to admins job scheduled (runs at 23:59 on last day of month)');
  }

  /**
   * Send daily report to all admins
   * @param {string} date - Date in YYYY-MM-DD format
   */
  async sendDailyReportToAdmins(date) {
    try {
      if (!this.bot) {
        logger.error('Bot instance not initialized in scheduler');
        return;
      }

      const sheetsService = require('./sheets.service');

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

      // Generate HTML report
      const now = moment.tz(Config.TIMEZONE);
      const fs = require('fs');
      const path = require('path');

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
          // Check if explicitly marked as late (No or false)
          if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
            status = `Опоздал (${whenCome})`;
            statusClass = 'status-late';
            lateCount++;
          } else {
            // Default to on-time if 'Yes', 'true', or empty (when marked on time)
            status = `Вовремя (${whenCome})`;
            statusClass = 'status-ontime';
          }

          // Add "will be late" notification if they informed about lateness
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

          // Check if person notified they'll be late but hasn't arrived yet
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
  <title>Дневной отчёт - ${date}</title>
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
      <h1>📅 Дневной отчёт</h1>
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

      const tempDir = path.join(__dirname, '../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filename = `daily_report_${date}.html`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, html, 'utf8');

      // Send to all admins
      for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
        try {
          await this.bot.telegram.sendDocument(
            adminId,
            { source: filepath },
            {
              caption: `📊 Дневной отчёт за ${date}\n\n✅ Присутствуют: ${presentCount}\n🕒 Опоздали: ${lateCount}\n❌ Отсутствуют: ${absentCount}`,
              filename: filename
            }
          );
          logger.info(`Daily report sent to admin ${adminId}`);
        } catch (err) {
          logger.error(`Failed to send daily report to admin ${adminId}: ${err.message}`);
        }
      }

      // Clean up temp file
      fs.unlinkSync(filepath);

    } catch (error) {
      logger.error(`Error in sendDailyReportToAdmins: ${error.message}`);
    }
  }

  /**
   * Send monthly report to all admins
   * @param {string} yearMonth - Month in YYYY-MM format
   */
  async sendMonthlyReportToAdmins(yearMonth) {
    try {
      if (!this.bot) {
        logger.error('Bot instance not initialized in scheduler');
        return;
      }

      const sheetsService = require('./sheets.service');
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
      let greenCount = 0, yellowCount = 0, redCount = 0;
      rows.forEach(row => {
        const zone = row.get('Rating Zone') || '';
        if (zone === 'Green') greenCount++;
        else if (zone === 'Yellow') yellowCount++;
        else redCount++;
      });

      // Send to all admins
      for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
        try {
          await this.retryTelegramOperation(async () => {
            await this.bot.telegram.sendMessage(
              adminId,
              `📊 Месячный отчёт за ${yearMonth}\n\n` +
              `🟢 Зелёная зона: ${greenCount}\n` +
              `🟡 Жёлтая зона: ${yellowCount}\n` +
              `🔴 Красная зона: ${redCount}\n\n` +
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
   * Setup no-show penalty check
   * Runs at 20:00 every day to mark people with no activity as no-shows
   */
  setupNoShowCheck() {
    // Run at 20:00 every day (8 PM)
    const job = cron.schedule('0 20 * * *', async () => {
      try {
        const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
        logger.info(`Checking for no-shows on ${today}`);

        await this.checkAndMarkNoShows(today);

        logger.info(`No-show check completed for ${today}`);
      } catch (error) {
        logger.error(`Error checking no-shows: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('No-show check job scheduled (runs at 20:00 every day)');
  }

  /**
   * Check and mark employees who had no activity today as no-shows
   */
  async checkAndMarkNoShows(dateStr) {
    try {
      // Check if sheet exists
      const sheetExists = sheetsService.doc.sheetsByTitle[dateStr];
      if (!sheetExists) {
        logger.info(`Sheet ${dateStr} doesn't exist - skipping no-show check`);
        return;
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

        // Check if person has NO activity at all
        const hasNoActivity = !whenCome.trim() &&
                              !leaveTime.trim() &&
                              absent.toLowerCase() !== 'yes' &&
                              willBeLate.toLowerCase() !== 'yes';

        if (hasNoActivity && name.trim()) {
          // Mark as no-show with -2 penalty
          row.set('Point', Config.NO_SHOW_PENALTY.toString());
          row.set('Absent', 'Yes');
          row.set('Why absent', 'No-show (no activity)');
          await row.save();

          noShowCount++;
          logger.warn(`Marked ${name} (${telegramId}) as no-show with ${Config.NO_SHOW_PENALTY} points`);

          // FIX #4: Send notification to user using safe method
          if (telegramId && this.bot) {
            const sent = await this.sendMessageSafe(
              telegramId,
              `⚠️ ВЫ ПОЛУЧИЛИ ШТРАФ\n\n` +
              `❌ Причина: Отсутствие без уведомления\n` +
              `📅 Дата: ${moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY')}\n\n` +
              `Вы не отметили приход, не уведомили об опоздании и не отметили отсутствие.\n\n` +
              `🔴 Штраф: ${Config.NO_SHOW_PENALTY} баллов\n\n` +
              `Пожалуйста, всегда уведомляйте о своём отсутствии!`
            );
            if (!sent) {
              logger.warn(`Could not send no-show notification to ${telegramId} - user blocked or unreachable`);
            }
          }

          // Add delay to avoid rate limit and network exhaustion when processing multiple no-shows
          await new Promise(resolve => setTimeout(resolve, 2000)); // Increased from 1s to 2s
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
   * Setup end-of-day archiving process
   * Runs at midnight (00:00) to archive the previous day and prepare for new day
   */
  setupEndOfDayArchiving() {
    // Run at 00:00 every day (midnight)
    const job = cron.schedule('0 0 * * *', async () => {
      try {
        const yesterday = moment.tz(Config.TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
        logger.info(`Starting end-of-day archiving for ${yesterday}`);

        await this.handleEndOfDay(yesterday, false); // false = automatic (with 2-min wait)

        logger.info(`End-of-day archiving completed for ${yesterday}`);
      } catch (error) {
        logger.error(`Error in end-of-day archiving: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('End-of-day archiving job scheduled (runs at 00:00 every day)');
  }

  /**
   * Handle end-of-day process
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @param {boolean} manual - If true, skip the 2-minute wait (for testing)
   */
  async handleEndOfDay(dateStr, manual = false) {
    try {
      logger.info(`=== Starting End-of-Day Process for ${dateStr} ===`);

      // Check if sheet exists
      const sheetExists = sheetsService.doc.sheetsByTitle[dateStr];
      if (!sheetExists) {
        logger.info(`Sheet ${dateStr} doesn't exist - skipping end-of-day process`);
        return;
      }

      // Step 1: Handle overnight workers
      logger.info('Step 1: Handling overnight workers...');
      const overnightWorkers = await this.handleOvernightWorkers(dateStr);

      // Step 2: Wait 2 minutes for responses (only in automatic mode)
      if (!manual && overnightWorkers > 0) {
        logger.info(`Step 2: Waiting 2 minutes for overnight worker responses...`);
        await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes
      } else if (manual) {
        logger.info('Step 2: Skipped (manual mode)');
      }

      // Step 3: Transfer data to monthly report
      logger.info('Step 3: Transferring data to monthly report...');
      const transferred = await this.transferDailyDataToMonthly(dateStr);
      if (!transferred) {
        logger.error('Failed to transfer data - ABORTING end-of-day process to prevent data loss');
        return;
      }

      // Step 4: Send report to Telegram group
      logger.info('Step 4: Sending report to Telegram group...');
      await this.sendDailyReportToGroup(dateStr);

      // Step 5: Delete the daily sheet
      logger.info('Step 5: Deleting daily sheet...');
      await this.deleteDailySheet(dateStr);

      logger.info(`=== End-of-Day Process Completed for ${dateStr} ===`);
    } catch (error) {
      logger.error(`Error in handleEndOfDay: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle employees who are still working at midnight
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {number} Number of overnight workers handled
   */
  async handleOvernightWorkers(dateStr) {
    try {
      const worksheet = await sheetsService.getWorksheet(dateStr);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      let overnightCount = 0;
      const CalculatorService = require('./calculator.service');
      const { Markup } = require('telegraf');

      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const whenCome = row.get('When come') || '';
        const leaveTime = row.get('Leave time') || '';

        // Check if person arrived but didn't leave
        if (whenCome.trim() && !leaveTime.trim() && telegramId.trim()) {
          overnightCount++;

          // Set leave time to 23:59 (end of day at midnight)
          const endTime = '23:59';
          row.set('Leave time', endTime);

          // Calculate hours worked
          const arrivalTime = moment.tz(`${dateStr} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
          const departureTime = moment.tz(`${dateStr} ${endTime}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
          const minutesWorked = departureTime.diff(arrivalTime, 'minutes');
          const hoursWorked = minutesWorked / 60;
          row.set('Hours worked', hoursWorked.toFixed(2));

          await row.save();

          logger.info(`Auto-ended work for overnight worker: ${name} (${telegramId}) at ${endTime}`);

          // FIX #4: Send notification with button using safe method
          if (this.bot) {
            const tomorrow = moment.tz(dateStr, Config.TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
            const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY');
            const formattedTomorrow = moment.tz(tomorrow, 'YYYY-MM-DD', Config.TIMEZONE).format('DD.MM.YYYY');

            const CalculatorService = require('./calculator.service');
            const sent = await this.sendMessageSafe(
              telegramId,
              `⚠️ Ваше рабочее время автоматически завершено\n\n` +
              `📅 Дата: ${formattedDate}\n` +
              `🕐 Время окончания: ${endTime}\n` +
              `⏱ Отработано: ${CalculatorService.formatTimeDiff(minutesWorked)}\n\n` +
              `Если вы всё ещё работаете ночную смену, нажмите кнопку ниже, чтобы отметить приход на новый день (${formattedTomorrow}):`,
              Markup.inlineKeyboard([
                [Markup.button.callback('✅ Я всё ещё здесь - Отметить приход', `overnight_still_working:${tomorrow}`)]
              ])
            );
            if (!sent) {
              logger.warn(`Could not send overnight notification to ${telegramId} - user blocked or unreachable`);
            }
          }

          // Add delay to avoid rate limiting and network exhaustion
          await new Promise(resolve => setTimeout(resolve, 2000)); // Increased from 500ms to 2s
        }
      }

      logger.info(`Handled ${overnightCount} overnight workers on ${dateStr}`);
      return overnightCount;
    } catch (error) {
      logger.error(`Error handling overnight workers: ${error.message}`);
      return 0;
    }
  }

  /**
   * Transfer daily data to monthly report
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {boolean} True if successful
   */
  async transferDailyDataToMonthly(dateStr) {
    try {
      const yearMonth = moment.tz(dateStr, Config.TIMEZONE).format('YYYY-MM');
      const reportSheetName = `Report_${yearMonth}`;

      // Ensure monthly report exists
      let monthlySheet = sheetsService.doc.sheetsByTitle[reportSheetName];
      if (!monthlySheet) {
        logger.info(`Creating monthly report ${reportSheetName}`);
        await sheetsService.initializeMonthlyReport(yearMonth);
        monthlySheet = await sheetsService.getWorksheet(reportSheetName);
      } else {
        monthlySheet = await sheetsService.getWorksheet(reportSheetName);
      }

      // Get daily data
      const dailySheet = await sheetsService.getWorksheet(dateStr);
      await dailySheet.loadHeaderRow();
      const dailyRows = await dailySheet.getRows();

      // Load monthly sheet
      await monthlySheet.loadHeaderRow();
      const monthlyRows = await monthlySheet.getRows();

      // Transfer data for each employee
      for (const dailyRow of dailyRows) {
        const telegramId = (dailyRow.get('TelegramId') || '').toString().trim();
        const name = dailyRow.get('Name') || '';

        if (!telegramId && !name) continue;

        // Find employee in monthly report (note: column is 'Telegram ID' not 'Telegram Id')
        let monthlyRow = monthlyRows.find(row => {
          const rowTelegramId = (row.get('Telegram ID') || '').toString().trim();
          const rowName = row.get('Name') || '';
          return (telegramId && rowTelegramId === telegramId) || rowName === name;
        });

        // FIX #5: Auto-add employee to monthly report if missing
        if (!monthlyRow) {
          logger.warn(`Employee ${name} (${telegramId}) not found in monthly report - auto-adding now`);

          try {
            // Get employee info from roster to populate initial data
            const roster = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
            await roster.loadHeaderRow();
            const rosterRows = await roster.getRows();

            let workSchedule = '';
            let company = '';

            // Find employee in roster
            for (const rosterRow of rosterRows) {
              const rosterTelegramId = (rosterRow.get('Telegram Id') || '').toString().trim();
              const rosterName = (rosterRow.get('Name full') || '').toString().trim();

              if ((telegramId && rosterTelegramId === telegramId) || rosterName === name) {
                workSchedule = rosterRow.get('Work time') || '';
                company = rosterRow.get('Company') || '';
                break;
              }
            }

            // Add new row to monthly report
            monthlyRow = await monthlySheet.addRow({
              'Name': name,
              'Telegram ID': telegramId,
              'Company': company,
              'Work Schedule': workSchedule,
              'Total Work Days': 0,
              'Days Worked': 0,
              'Days Absent': 0,
              'Days Absent (Notified)': 0,
              'Days Absent (Silent)': 0,
              'On Time Arrivals': 0,
              'Late Arrivals (Notified)': 0,
              'Late Arrivals (Silent)': 0,
              'Early Departures': 0,
              'Early Departures (Worked Full Hours)': 0,
              'Left Before Shift': 0,
              'Total Hours Required': 0,
              'Total Hours Worked': 0,
              'Hours Deficit/Surplus': 0,
              'Total Penalty Minutes': 0,
              'Total Deficit Minutes': 0,
              'Total Surplus Minutes': 0,
              'Net Balance Minutes': 0,
              'Net Balance (Hours)': '0:00',
              'Balance Status': '⚪ None',
              'Total Points': 0,
              'Average Daily Points': 0,
              'Attendance Rate %': 0,
              'On-Time Rate %': 0,
              'Rating (0-10)': 0,
              'Rating Zone': '⚪',
              'Last Updated': ''
            });

            // Add to the monthlyRows array so we can continue processing
            monthlyRows.push(monthlyRow);

            logger.info(`✅ Successfully added ${name} to monthly report ${reportSheetName}`);
          } catch (addError) {
            logger.error(`Failed to auto-add employee ${name} to monthly report: ${addError.message}`);
            continue; // Skip this employee if we can't add them
          }
        }

        // Get daily data
        const hoursWorked = parseFloat(dailyRow.get('Hours worked') || '0');
        const cameOnTime = dailyRow.get('Came on time') || '';
        const absent = dailyRow.get('Absent') || '';
        const whenCome = dailyRow.get('When come') || '';
        const willBeLate = dailyRow.get('will be late') || '';
        const leftEarly = dailyRow.get('Left early') || '';
        const point = parseFloat(dailyRow.get('Point') || '0');
        const penaltyMinutes = parseFloat(dailyRow.get('Penalty minutes') || '0');
        const remainingHours = parseFloat(dailyRow.get('Remaining hours to work') || '0');

        // Get required hours for this day from roster
        // FIXED: Calculate required hours for ALL days, not just days when employee came
        let requiredHoursDaily = 0;
        const workSchedule = monthlyRow.get('Work Schedule') || '';
        if (workSchedule) {
          // Parse work schedule (e.g., "09:00-18:00")
          const scheduleMatch = workSchedule.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
          if (scheduleMatch) {
            const startHour = parseInt(scheduleMatch[1]);
            const startMin = parseInt(scheduleMatch[2]);
            const endHour = parseInt(scheduleMatch[3]);
            const endMin = parseInt(scheduleMatch[4]);
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;
            requiredHoursDaily = (endMinutes - startMinutes) / 60;
          }
        }

        // Update Days Worked
        if (whenCome.trim()) {
          const current = parseInt(monthlyRow.get('Days Worked') || '0');
          monthlyRow.set('Days Worked', current + 1);
        }

        // Update Days Absent
        if (absent.toLowerCase() === 'yes' || absent.toLowerCase() === 'true') {
          const current = parseInt(monthlyRow.get('Days Absent') || '0');
          monthlyRow.set('Days Absent', current + 1);

          // Check if notified or silent
          if (willBeLate.toLowerCase() === 'yes') {
            const notified = parseInt(monthlyRow.get('Days Absent (Notified)') || '0');
            monthlyRow.set('Days Absent (Notified)', notified + 1);
          } else {
            const silent = parseInt(monthlyRow.get('Days Absent (Silent)') || '0');
            monthlyRow.set('Days Absent (Silent)', silent + 1);
          }
        }

        // Update On Time / Late Arrivals
        if (whenCome.trim()) {
          if (cameOnTime.toLowerCase() === 'true' || cameOnTime.toLowerCase() === 'yes' || cameOnTime === '') {
            const onTime = parseInt(monthlyRow.get('On Time Arrivals') || '0');
            monthlyRow.set('On Time Arrivals', onTime + 1);
          } else {
            // Late arrival
            if (willBeLate.toLowerCase() === 'yes') {
              const lateNotified = parseInt(monthlyRow.get('Late Arrivals (Notified)') || '0');
              monthlyRow.set('Late Arrivals (Notified)', lateNotified + 1);
            } else {
              const lateSilent = parseInt(monthlyRow.get('Late Arrivals (Silent)') || '0');
              monthlyRow.set('Late Arrivals (Silent)', lateSilent + 1);
            }
          }
        }

        // Update Early Departures
        if (leftEarly.toLowerCase() === 'yes' || leftEarly.toLowerCase() === 'true') {
          const earlyDep = parseInt(monthlyRow.get('Early Departures') || '0');
          monthlyRow.set('Early Departures', earlyDep + 1);
        }

        // Update Total Hours Worked
        const currentHours = parseFloat(monthlyRow.get('Total Hours Worked') || '0');
        monthlyRow.set('Total Hours Worked', (currentHours + hoursWorked).toFixed(2));

        // Update Total Hours Required
        const currentRequired = parseFloat(monthlyRow.get('Total Hours Required') || '0');
        monthlyRow.set('Total Hours Required', (currentRequired + requiredHoursDaily).toFixed(2));

        // Update Total Penalty Minutes
        const currentPenalty = parseFloat(monthlyRow.get('Total Penalty Minutes') || '0');
        monthlyRow.set('Total Penalty Minutes', (currentPenalty + penaltyMinutes).toFixed(0));

        // Calculate deficit/surplus for this day
        const dayDeficitSurplus = hoursWorked - requiredHoursDaily;
        const dayDeficitSurplusMinutes = Math.round(dayDeficitSurplus * 60);

        // Update Deficit/Surplus Minutes
        if (dayDeficitSurplusMinutes < 0) {
          // Deficit
          const currentDeficit = parseFloat(monthlyRow.get('Total Deficit Minutes') || '0');
          monthlyRow.set('Total Deficit Minutes', (currentDeficit + Math.abs(dayDeficitSurplusMinutes)).toFixed(0));
        } else if (dayDeficitSurplusMinutes > 0) {
          // Surplus
          const currentSurplus = parseFloat(monthlyRow.get('Total Surplus Minutes') || '0');
          monthlyRow.set('Total Surplus Minutes', (currentSurplus + dayDeficitSurplusMinutes).toFixed(0));
        }

        // Calculate Net Balance (Total Surplus - Total Deficit - Total Penalty)
        const totalDeficit = parseFloat(monthlyRow.get('Total Deficit Minutes') || '0');
        const totalSurplus = parseFloat(monthlyRow.get('Total Surplus Minutes') || '0');
        const totalPenaltyMins = parseFloat(monthlyRow.get('Total Penalty Minutes') || '0');
        const netBalanceMinutes = totalSurplus - totalDeficit - totalPenaltyMins;
        monthlyRow.set('Net Balance Minutes', netBalanceMinutes.toFixed(0));

        // Convert to Hours:Minutes format
        const absMinutes = Math.abs(netBalanceMinutes);
        const hours = Math.floor(absMinutes / 60);
        const minutes = Math.round(absMinutes % 60);
        const sign = netBalanceMinutes < 0 ? '-' : '+';
        monthlyRow.set('Net Balance (Hours)', `${sign}${hours}:${minutes.toString().padStart(2, '0')}`);

        // Set Balance Status
        if (netBalanceMinutes > 60) {
          monthlyRow.set('Balance Status', '🟢 Surplus');
        } else if (netBalanceMinutes < -60) {
          monthlyRow.set('Balance Status', '🔴 Deficit');
        } else {
          monthlyRow.set('Balance Status', '⚪ Balanced');
        }

        // Update Hours Deficit/Surplus (in hours)
        monthlyRow.set('Hours Deficit/Surplus', (netBalanceMinutes / 60).toFixed(2));

        // Update Total Points
        const currentPoints = parseFloat(monthlyRow.get('Total Points') || '0');
        monthlyRow.set('Total Points', (currentPoints + point).toFixed(2));

        // Update Rating (0-10)
        const currentRating = parseFloat(monthlyRow.get('Rating (0-10)') || '0');
        const newRating = Math.max(0, Math.min(10, currentRating + point));
        monthlyRow.set('Rating (0-10)', newRating.toFixed(1));

        // Calculate Attendance Rate %
        const daysWorked = parseInt(monthlyRow.get('Days Worked') || '0');
        const daysAbsent = parseInt(monthlyRow.get('Days Absent') || '0');
        const totalDays = daysWorked + daysAbsent;
        const attendanceRate = totalDays > 0 ? ((daysWorked / totalDays) * 100).toFixed(1) : '0.0';
        monthlyRow.set('Attendance Rate %', attendanceRate);

        // Calculate On-Time Rate %
        const onTimeArrivals = parseInt(monthlyRow.get('On Time Arrivals') || '0');
        const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : '0.0';
        monthlyRow.set('On-Time Rate %', onTimeRate);

        // Set Rating Zone
        const ratingValue = parseFloat(monthlyRow.get('Rating (0-10)') || '0');
        if (ratingValue >= Config.GREEN_ZONE_MIN) {
          monthlyRow.set('Rating Zone', '🟢 Отлично');
        } else if (ratingValue >= Config.YELLOW_ZONE_MIN) {
          monthlyRow.set('Rating Zone', '🟡 Норма');
        } else {
          monthlyRow.set('Rating Zone', '🔴 Риск');
        }

        // Update Last Updated
        monthlyRow.set('Last Updated', moment.tz(Config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss'));

        await monthlyRow.save();
        logger.info(`Updated monthly report for ${name}: +${hoursWorked.toFixed(2)}h/${requiredHoursDaily.toFixed(2)}h required, penalty: ${penaltyMinutes}min, balance: ${sign}${hours}:${minutes.toString().padStart(2, '0')}, rating: ${newRating.toFixed(1)}`);
      }

      logger.info(`Successfully transferred data from ${dateStr} to ${reportSheetName}`);
      return true;
    } catch (error) {
      logger.error(`Error transferring daily data to monthly: ${error.message}`);
      return false;
    }
  }

  /**
   * Send daily report to Telegram group as Excel file
   * @param {string} dateStr - Date in YYYY-MM-DD format
   */
  async sendDailyReportToGroup(dateStr) {
    try {
      if (!this.bot) {
        logger.error('Bot instance not initialized');
        return;
      }

      if (!Config.DAILY_REPORT_GROUP_ID) {
        logger.warn('DAILY_REPORT_GROUP_ID not configured - skipping group report');
        return;
      }

      const worksheet = await sheetsService.getWorksheet(dateStr);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        logger.info('No data for daily report');
        return;
      }

      // Use xlsx library to create Excel file from data
      const XLSX = require('xlsx');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      // Create workbook
      const workbook = XLSX.utils.book_new();

      // Get headers
      const headers = worksheet.headerValues;

      // Prepare data array
      const data = [headers]; // First row is headers

      // Add all rows
      for (const row of rows) {
        const rowData = headers.map(header => {
          const value = row.get(header);
          return value !== undefined ? value : '';
        });
        data.push(rowData);
      }

      // Create worksheet from data
      const ws = XLSX.utils.aoa_to_sheet(data);

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, ws, dateStr);

      // Create temporary file path
      const tempDir = os.tmpdir();
      const fileName = `attendance_${dateStr}.xlsx`;
      const filePath = path.join(tempDir, fileName);

      // Write Excel file
      XLSX.writeFile(workbook, filePath);
      logger.info(`Created Excel file: ${filePath}`);

      // Calculate statistics for caption
      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;
      let totalHoursWorked = 0;

      for (const row of rows) {
        const whenCome = row.get('When come') || '';
        const absent = row.get('Absent') || '';
        const cameOnTime = row.get('Came on time') || '';
        const hoursWorked = parseFloat(row.get('Hours worked') || '0');

        if (whenCome.trim()) {
          presentCount++;
          totalHoursWorked += hoursWorked;
          if (cameOnTime.toLowerCase() === 'false' || cameOnTime.toLowerCase() === 'no') {
            lateCount++;
          }
        } else if (absent.toLowerCase() === 'yes') {
          absentCount++;
        }
      }

      const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY (dddd)');
      const caption =
        `📊 <b>ОТЧЁТ ЗА ${formattedDate.toUpperCase()}</b>\n\n` +
        `✅ Присутствовали: ${presentCount}\n` +
        `⚠️ Опоздали: ${lateCount}\n` +
        `❌ Отсутствовали: ${absentCount}\n` +
        `⏱ Всего часов: ${totalHoursWorked.toFixed(1)}\n\n` +
        `📄 Полный отчёт во вложении\n` +
        `🤖 Данные архивированы автоматически`;

      // Send the Excel file to the group
      await this.bot.telegram.sendDocument(
        Config.DAILY_REPORT_GROUP_ID,
        { source: filePath, filename: fileName },
        {
          caption: caption,
          parse_mode: 'HTML'
        }
      );

      // Clean up temporary file
      fs.unlink(filePath, (err) => {
        if (err) {
          logger.warn(`Failed to delete temp file ${filePath}: ${err.message}`);
        } else {
          logger.info(`Cleaned up temp file: ${filePath}`);
        }
      });

      logger.info(`Daily report (Excel file) sent to group ${Config.DAILY_REPORT_GROUP_ID}`);
    } catch (error) {
      logger.error(`Error sending daily report to group: ${error.message}`);
      logger.error(error.stack);
    }
  }

  /**
   * Delete daily sheet from Google Sheets
   * @param {string} dateStr - Date in YYYY-MM-DD format
   */
  async deleteDailySheet(dateStr) {
    try {
      const sheet = sheetsService.doc.sheetsByTitle[dateStr];
      if (!sheet) {
        logger.warn(`Sheet ${dateStr} not found - already deleted?`);
        return;
      }

      await sheet.delete();
      logger.info(`Successfully deleted daily sheet: ${dateStr}`);
    } catch (error) {
      logger.error(`Error deleting daily sheet ${dateStr}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    this.jobs.forEach(job => job.stop());
    logger.info('All scheduled jobs stopped');
  }
}

// Create and export singleton instance
const schedulerService = new SchedulerService();
module.exports = schedulerService;
