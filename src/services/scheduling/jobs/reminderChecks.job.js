/**
 * Reminder Checks Job
 * Runs every 5 minutes to check and send various reminders:
 * - Arrival reminders (15 min before, at time, 15 min after)
 * - Late marking (20+ min after start without arrival)
 * - Temporary exit return reminders
 * - Departure reminders (15 min before required end time + deficit)
 * - Extended work reminders (for employees working longer)
 * - Auto-departure warnings and execution
 */

const moment = require('moment-timezone');
const { Markup } = require('telegraf');
const { setIfHeaderExists } = require('../../../utils/rowHelper');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: Every 5 minutes
const schedule = '*/5 * * * *';

/**
 * Send work reminder to employee
 * @param {string} telegramId - Employee's Telegram ID
 * @param {string} name - Employee's name
 * @param {number} reminderNumber - Reminder number (1, 2, or 3)
 * @param {string} workStartTime - Work start time (HH:mm)
 * @param {Object} schedulerService - Scheduler service instance
 */
async function sendWorkReminder(telegramId, name, reminderNumber, workStartTime, schedulerService) {
  try {
    if (!schedulerService.bot) {
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

    await schedulerService.retryTelegramOperation(async () => {
      await schedulerService.bot.telegram.sendMessage(telegramId, message);
    });
  } catch (error) {
    logger.error(`Error sending reminder to ${telegramId} after retries: ${error.message}`);
  }
}

/**
 * Check if any employees need reminders and send them
 * Sends 3 reminders: 15 min before, at work time, and 15 min after
 * Also automatically marks as late if 20+ minutes late
 * Handles temporary exit reminders, departure reminders, extended work reminders, and auto-departure
 * @param {Object} schedulerService - Scheduler service instance (for bot, sendMessageSafe, etc.)
 */
async function checkAndSendReminders(schedulerService) {
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

    // OPTIMIZATION: Use cached methods to reduce API calls
    // This runs every 5 minutes, so caching is critical
    const { worksheet, rows } = await schedulerService.retryOperation(async () => {
      return await sheetsService._getCachedDailySheet(today);
    });

    // OPTIMIZATION: Use cached roster data instead of loading every time
    const rosterRows = await schedulerService.retryOperation(async () => {
      return await sheetsService._getCachedRoster(true); // Build index for faster lookups
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
      const reminder1Time = schedulerService.roundToNearest5Minutes(workStart.clone().subtract(15, 'minutes'));
      const reminder2Time = schedulerService.roundToNearest5Minutes(workStart.clone());
      const reminder3Time = schedulerService.roundToNearest5Minutes(workStart.clone().add(15, 'minutes'));

      // Use adjusted time for reminder messages if person notified they'll be late
      const reminderTime = workStart.format('HH:mm');
      const isAdjustedTime = willBeLate.toLowerCase() === 'yes' && lateExpectedArrival.trim();

      // Only send reminders if person hasn't taken any action yet
      if (shouldSendReminders) {
        // Check and send reminder 1 (15 min before)
        if (currentMinute === reminder1Time && reminder1Sent.toLowerCase() !== 'true') {
          await sendWorkReminder(telegramId, name, 1, reminderTime, schedulerService);
          row.set('reminder_1_sent', 'true');
          rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save
          logger.info(`Sent reminder 1 to ${name} (${telegramId}) at ${currentMinute}${isAdjustedTime ? ` - adjusted for late arrival at ${reminderTime}` : ''}`);
          // Add delay to avoid rate limit
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Check and send reminder 2 (at work time)
        if (currentMinute === reminder2Time && reminder2Sent.toLowerCase() !== 'true') {
          await sendWorkReminder(telegramId, name, 2, reminderTime, schedulerService);
          row.set('reminder_2_sent', 'true');
          rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save
          logger.info(`Sent reminder 2 to ${name} (${telegramId}) at ${currentMinute}${isAdjustedTime ? ` - adjusted for late arrival at ${reminderTime}` : ''}`);
          // Add delay to avoid rate limit
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Check and send reminder 3 (15 min after)
        if (currentMinute === reminder3Time && reminder3Sent.toLowerCase() !== 'true') {
          await sendWorkReminder(telegramId, name, 3, reminderTime, schedulerService);
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

        // FIX: Only auto-mark as late if at least one reminder was sent
        // This prevents marking employees who were just added to the daily sheet but whose work time hasn't arrived yet
        const hasHadReminders = reminder1Sent.toLowerCase() === 'true' ||
                                reminder2Sent.toLowerCase() === 'true' ||
                                reminder3Sent.toLowerCase() === 'true';

        // Don't mark late if already marked late, notified, marked absent, OR no reminders sent yet
        if (!alreadyMarkedLate && !notifiedLate && !isAbsentNow && hasHadReminders) {
          // Automatically mark as late (silent - no notification given)
          row.set('Came on time', 'No');
          rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

          // Log the silent late event
          const CalculatorService = require('../../calculator.service');
          const ratingImpact = CalculatorService.calculateRatingImpact('LATE_SILENT');
          await sheetsService.logEvent(
            telegramId,
            name,
            'LATE_SILENT',
            `автоматически отмечен опоздавшим на ${minutesSinceStart} минут`,
            ratingImpact
          );

          // FIX #4: Send notification to employee using safe method
          const sent = await schedulerService.sendMessageSafe(
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
          await schedulerService.retryTelegramOperation(async () => {
            await schedulerService.bot.telegram.sendMessage(
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
          const cached = schedulerService._lastAdjustedEndTimes.get(cacheKey);
          const newEndTime = workEnd.format('HH:mm');

          // Only log and update if this is a new adjustment or values changed
          if (!cached || cached.endTime !== newEndTime || cached.deficitMinutes !== deficitMinutes) {
            logger.info(`Adjusted end time for ${name}: ${newEndTime} (+${deficitMinutes} min deficit)`);
            schedulerService._lastAdjustedEndTimes.set(cacheKey, {
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

          await schedulerService.retryTelegramOperation(async () => {
            await schedulerService.bot.telegram.sendMessage(telegramId, message);
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
      const extendedWorkReminderTime = schedulerService.roundToNearest5Minutes(
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

          await schedulerService.retryTelegramOperation(async () => {
            await schedulerService.bot.telegram.sendMessage(telegramId, message);
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
    for (const [key, value] of schedulerService._lastAdjustedEndTimes.entries()) {
      if (value.date !== today) {
        schedulerService._lastAdjustedEndTimes.delete(key);
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
            await schedulerService.retryTelegramOperation(async () => {
              sentMessage = await schedulerService.bot.telegram.sendMessage(
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
              if (!schedulerService._autoDepartureWarningMessages) {
                schedulerService._autoDepartureWarningMessages = new Map();
              }
              schedulerService._autoDepartureWarningMessages.set(telegramId, sentMessage.message_id);
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
            const CalculatorService = require('../../calculator.service');

            // Mark departure
            const departureTime = now.format('HH:mm');
            row.set('Leave time', departureTime);

            // Calculate hours worked
            const arrivalTime = moment.tz(`${today} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
            const minutesWorked = now.diff(arrivalTime, 'minutes');
            const hoursWorked = minutesWorked / 60;
            row.set('Hours worked', hoursWorked.toFixed(2));

            // Audit trail for the "🙋 Нет, я ещё на работе" undo. No-ops on a
            // daily tab created before these columns existed — the button
            // carries the departure time itself, so the undo still works.
            setIfHeaderExists(row, 'auto_departure_applied', 'true');
            setIfHeaderExists(row, 'auto_departure_at', departureTime);

            rowsToUpdate.push(row); // OPTIMIZATION: Batch save instead of individual save

            // Remove buttons from warning message if it exists
            if (schedulerService._autoDepartureWarningMessages && schedulerService._autoDepartureWarningMessages.has(telegramId)) {
              const warningMessageId = schedulerService._autoDepartureWarningMessages.get(telegramId);
              try {
                // Edit the message to remove buttons and update text
                await schedulerService.bot.telegram.editMessageText(
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
              schedulerService._autoDepartureWarningMessages.delete(telegramId);
            }

            // Log the auto-departure event
            await sheetsService.logEvent(
              telegramId,
              name,
              'AUTO_DEPARTURE',
              `автоматически отмечен как ушедший в ${departureTime}`,
              0
            );

            // Send notification to employee, with a one-tap way to say the
            // departure was wrong and they are in fact still working.
            const sent = await schedulerService.sendMessageSafe(
              telegramId,
              `✅ Вы автоматически отмечены как ушедший\n\n` +
              `🕐 Время ухода: ${departureTime}\n` +
              `⏱ Отработано: ${CalculatorService.formatTimeDiff(minutesWorked)}\n\n` +
              `Если вы всё ещё на работе — нажмите кнопку ниже, и отметка об уходе будет отменена.`,
              Markup.inlineKeyboard([
                [Markup.button.callback('🙋 Нет, я ещё на работе', `still_here:${departureTime}`)]
              ])
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
 * Main job execution function
 * @param {Object} schedulerService - Scheduler service instance
 */
async function execute(schedulerService) {
  try {
    await checkAndSendReminders(schedulerService);
  } catch (error) {
    logger.error(`Error in reminder check: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  checkAndSendReminders,
  sendWorkReminder,
  name: 'Reminder Checks',
  description: 'Runs every 5 minutes to check and send various reminders (arrival, departure, extended work, auto-departure)'
};
