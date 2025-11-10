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
      this.setupDailyReportUpdate();
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
   * Check every minute for reminders to send
   * Sends reminder 15 minutes before work start time
   */
  setupReminderChecks() {
    // Run every minute to check if we need to send reminders
    const job = cron.schedule('* * * * *', async () => {
      try {
        await this.checkAndSendReminders();
      } catch (error) {
        logger.error(`Error in reminder check: ${error.message}`);
      }
    }, {
      timezone: Config.TIMEZONE
    });

    this.jobs.push(job);
    logger.info('Reminder check job scheduled (runs every minute)');
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

      // Get today's attendance sheet
      const worksheet = await sheetsService.getWorksheet(today);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Get roster to check work times
      const roster = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rosterRows = await roster.getRows();

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
        const shouldSendReminders = !hasArrived && !hasNotifiedLate;

        // Skip reminders if person already arrived or notified late
        // But continue to check for auto-late marking
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
            logger.info(`Adjusted reminder time for ${name}: expected at ${workStart.format('HH:mm')}`);
          }
        }

        // Calculate 3 reminder times (based on adjusted time if late notification given)
        const reminder1Time = workStart.clone().subtract(15, 'minutes').format('HH:mm');
        const reminder2Time = workStart.format('HH:mm');
        const reminder3Time = workStart.clone().add(15, 'minutes').format('HH:mm');

        // Use adjusted time for reminder messages if person notified they'll be late
        const reminderTime = workStart.format('HH:mm');

        // Only send reminders if person hasn't taken any action yet
        if (shouldSendReminders) {
          // Check and send reminder 1 (15 min before)
          if (currentMinute === reminder1Time && reminder1Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 1, reminderTime);
            row.set('reminder_1_sent', 'true');
            await row.save();
            logger.info(`Sent reminder 1 to ${name} (${telegramId}) at ${currentMinute}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          // Check and send reminder 2 (at work time)
          if (currentMinute === reminder2Time && reminder2Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 2, reminderTime);
            row.set('reminder_2_sent', 'true');
            await row.save();
            logger.info(`Sent reminder 2 to ${name} (${telegramId}) at ${currentMinute}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          // Check and send reminder 3 (15 min after)
          if (currentMinute === reminder3Time && reminder3Sent.toLowerCase() !== 'true') {
            await this.sendWorkReminder(telegramId, name, 3, reminderTime);
            row.set('reminder_3_sent', 'true');
            await row.save();
            logger.info(`Sent reminder 3 to ${name} (${telegramId}) at ${currentMinute}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        // Check if person should be automatically marked as late (17+ minutes after start)
        const minutesSinceStart = now.diff(workStart, 'minutes');
        if (minutesSinceStart >= 17) {
          // Person is 17+ minutes late
          // Check if they haven't notified they'll be late and haven't been marked yet
          const alreadyMarkedLate = cameOnTime.toLowerCase() === 'false' || cameOnTime === 'No';
          const notifiedLate = willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true';

          if (!alreadyMarkedLate && !notifiedLate) {
            // Automatically mark as late (silent - no notification given)
            row.set('Came on time', 'false');
            await row.save();

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

            // Send notification to employee
            try {
              await this.bot.telegram.sendMessage(
                telegramId,
                `⚠️ Вы автоматически отмечены как опоздавший\n\n` +
                `Вы не пришли на работу вовремя (${startTime}).\n` +
                `Прошло уже ${minutesSinceStart} минут с начала рабочего дня.\n\n` +
                `Пожалуйста, отметьте свой приход, когда придёте.`
              );
            } catch (err) {
              logger.error(`Failed to send auto-late notification to ${telegramId}: ${err.message}`);
            }

            logger.info(`Automatically marked ${name} (${telegramId}) as late (${minutesSinceStart} min)`);

            // Add delay to avoid hitting Google API rate limit
            await new Promise(resolve => setTimeout(resolve, 1000));
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

            // Mark reminder as sent
            row.set('Temp exit remind sent', 'true');
            await row.save();

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
            logger.info(`Adjusted end time for ${name}: ${workEnd.format('HH:mm')} (+${deficitMinutes} min deficit)`);
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

            await this.bot.telegram.sendMessage(telegramId, message);

            // Mark reminder as sent
            row.set('departure_reminder_sent', 'true');
            await row.save();

            logger.info(`Sent departure reminder to ${name} (${telegramId}) for ${requiredEndTime}`);
            // Add delay to avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            logger.error(`Failed to send departure reminder to ${telegramId}: ${err.message}`);
          }
        }
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

      await this.bot.telegram.sendMessage(telegramId, message);
    } catch (error) {
      logger.error(`Error sending reminder to ${telegramId}: ${error.message}`);
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
        const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
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
        const point = row.get('Point') || '0';
        const pointNum = parseFloat(point);

        let status = '';
        let statusClass = '';
        let pointClass = '';

        if (absent.toLowerCase() === 'true') {
          status = `Отсутствует`;
          if (whyAbsent) status += ` (${whyAbsent})`;
          statusClass = 'status-absent';
          absentCount++;
        } else if (whenCome) {
          if (cameOnTime.toLowerCase() === 'true') {
            status = `Вовремя (${whenCome})`;
            statusClass = 'status-ontime';
          } else {
            status = `Опоздал (${whenCome})`;
            statusClass = 'status-late';
            lateCount++;
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
          await this.bot.telegram.sendMessage(
            adminId,
            `📊 Месячный отчёт за ${yearMonth}\n\n` +
            `🟢 Зелёная зона: ${greenCount}\n` +
            `🟡 Жёлтая зона: ${yellowCount}\n` +
            `🔴 Красная зона: ${redCount}\n\n` +
            `Используйте кнопку "📈 Отчёт за месяц" для получения полного отчёта.`
          );
          logger.info(`Monthly report sent to admin ${adminId}`);
        } catch (err) {
          logger.error(`Failed to send monthly report to admin ${adminId}: ${err.message}`);
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

      // Get daily sheet
      const worksheet = await sheetsService.getWorksheet(dateStr);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      let noShowCount = 0;

      for (const row of rows) {
        const name = row.get('Name') || '';
        const telegramId = row.get('TelegramId') || '';
        const whenCome = row.get('When come') || '';
        const leaveTime = row.get('Leave time') || '';
        const absent = row.get('Absent') || '';
        const willBeLate = row.get('will be late') || '';
        const currentPoint = parseFloat(row.get('Point') || '0');

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

          // Add delay to avoid rate limit when processing multiple no-shows
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Send notification to user if telegram ID exists
          if (telegramId && this.bot) {
            try {
              await this.bot.telegram.sendMessage(
                telegramId,
                `⚠️ ВЫ ПОЛУЧИЛИ ШТРАФ\n\n` +
                `❌ Причина: Отсутствие без уведомления\n` +
                `📅 Дата: ${moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY')}\n\n` +
                `Вы не отметили приход, не уведомили об опоздании и не отметили отсутствие.\n\n` +
                `🔴 Штраф: ${Config.NO_SHOW_PENALTY} баллов\n\n` +
                `Пожалуйста, всегда уведомляйте о своём отсутствии!`
              );
            } catch (msgError) {
              logger.error(`Failed to send no-show notification to ${telegramId}: ${msgError.message}`);
            }
          }
        }
      }

      if (noShowCount > 0) {
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
   * Runs at midnight (00:00) to archive the day and prepare for new day
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

          // Set leave time to 23:59
          const endTime = '23:59';
          row.set('Leave time', endTime);

          // Calculate hours worked
          const arrivalTime = moment.tz(`${dateStr} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
          const departureTime = moment.tz(`${dateStr} ${endTime}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
          const hoursWorked = departureTime.diff(arrivalTime, 'minutes') / 60;
          row.set('Hours worked', hoursWorked.toFixed(2));

          await row.save();

          logger.info(`Auto-ended work for overnight worker: ${name} (${telegramId}) at ${endTime}`);

          // Send notification with button
          if (this.bot) {
            try {
              const tomorrow = moment.tz(dateStr, Config.TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
              const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY');
              const formattedTomorrow = moment.tz(tomorrow, 'YYYY-MM-DD', Config.TIMEZONE).format('DD.MM.YYYY');

              await this.bot.telegram.sendMessage(
                telegramId,
                `⚠️ Ваше рабочее время автоматически завершено\n\n` +
                `📅 Дата: ${formattedDate}\n` +
                `🕐 Время окончания: ${endTime}\n` +
                `⏱ Отработано часов: ${hoursWorked.toFixed(2)}\n\n` +
                `Если вы всё ещё работаете ночную смену, нажмите кнопку ниже, чтобы отметить приход на новый день (${formattedTomorrow}):`,
                Markup.inlineKeyboard([
                  [Markup.button.callback('✅ Я всё ещё здесь - Отметить приход', `overnight_still_working:${tomorrow}`)]
                ])
              );
            } catch (msgError) {
              logger.error(`Failed to send overnight notification to ${telegramId}: ${msgError.message}`);
            }
          }

          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
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

        // Find employee in monthly report
        let monthlyRow = monthlyRows.find(row => {
          const rowTelegramId = (row.get('Telegram Id') || '').toString().trim();
          const rowName = row.get('Name') || '';
          return (telegramId && rowTelegramId === telegramId) || rowName === name;
        });

        // If employee not in monthly report, add them
        if (!monthlyRow) {
          logger.info(`Adding new employee to monthly report: ${name}`);
          monthlyRow = await monthlySheet.addRow({
            'Name': name,
            'Telegram Id': telegramId,
            'Rating': '10.0',
            'Worked days': '0',
            'Late days': '0',
            'Absent days': '0',
            'Total hours': '0',
            'Required hours': '0',
            'Deficit hours': '0',
            'Status': 'Active'
          });
          await monthlyRow.save();
          // Reload to get the new row
          const updatedRows = await monthlySheet.getRows();
          monthlyRow = updatedRows[updatedRows.length - 1];
        }

        // Update statistics
        const hoursWorked = parseFloat(dailyRow.get('Hours worked') || '0');
        const cameOnTime = dailyRow.get('Came on time') || '';
        const absent = dailyRow.get('Absent') || '';
        const point = parseFloat(dailyRow.get('Point') || '0');

        // Update worked days
        const whenCome = dailyRow.get('When come') || '';
        if (whenCome.trim() || absent.toLowerCase() === 'yes') {
          const currentWorkedDays = parseInt(monthlyRow.get('Worked days') || '0');
          monthlyRow.set('Worked days', currentWorkedDays + 1);
        }

        // Update late days
        if (cameOnTime.toLowerCase() === 'false' || cameOnTime.toLowerCase() === 'no') {
          const currentLateDays = parseInt(monthlyRow.get('Late days') || '0');
          monthlyRow.set('Late days', currentLateDays + 1);
        }

        // Update absent days
        if (absent.toLowerCase() === 'yes') {
          const currentAbsentDays = parseInt(monthlyRow.get('Absent days') || '0');
          monthlyRow.set('Absent days', currentAbsentDays + 1);
        }

        // Update total hours
        const currentTotalHours = parseFloat(monthlyRow.get('Total hours') || '0');
        monthlyRow.set('Total hours', (currentTotalHours + hoursWorked).toFixed(2));

        // Update rating
        const currentRating = parseFloat(monthlyRow.get('Rating') || '10.0');
        const newRating = Math.max(0, Math.min(10, currentRating + point));
        monthlyRow.set('Rating', newRating.toFixed(1));

        await monthlyRow.save();
        logger.info(`Updated monthly report for ${name}: +${hoursWorked.toFixed(2)}h, rating: ${newRating.toFixed(1)}`);
      }

      logger.info(`Successfully transferred data from ${dateStr} to ${reportSheetName}`);
      return true;
    } catch (error) {
      logger.error(`Error transferring daily data to monthly: ${error.message}`);
      return false;
    }
  }

  /**
   * Send daily report to Telegram group
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

      // Generate statistics
      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;
      let leftEarlyCount = 0;
      let totalHoursWorked = 0;

      const employeeStats = [];

      for (const row of rows) {
        const name = row.get('Name') || '';
        const whenCome = row.get('When come') || '';
        const leaveTime = row.get('Leave time') || '';
        const cameOnTime = row.get('Came on time') || '';
        const absent = row.get('Absent') || '';
        const leftEarly = row.get('Left early') || '';
        const hoursWorked = parseFloat(row.get('Hours worked') || '0');

        if (whenCome.trim()) {
          presentCount++;
          totalHoursWorked += hoursWorked;

          let status = '✅';
          if (cameOnTime.toLowerCase() === 'false' || cameOnTime.toLowerCase() === 'no') {
            status = '⚠️';
            lateCount++;
          }
          if (leftEarly.toLowerCase() === 'yes') {
            status = '🟡';
            leftEarlyCount++;
          }

          employeeStats.push({
            name,
            status,
            arrival: whenCome,
            departure: leaveTime || '-',
            hours: hoursWorked.toFixed(1)
          });
        } else if (absent.toLowerCase() === 'yes') {
          absentCount++;
          employeeStats.push({
            name,
            status: '❌',
            arrival: 'Отсутствует',
            departure: '-',
            hours: '0'
          });
        }
      }

      // Format report
      const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY (dddd)');
      let report = `📊 <b>ОТЧЁТ ЗА ${formattedDate.toUpperCase()}</b>\n\n`;

      report += `<b>📈 Статистика:</b>\n`;
      report += `✅ Присутствовали: ${presentCount}\n`;
      report += `⚠️ Опоздали: ${lateCount}\n`;
      report += `❌ Отсутствовали: ${absentCount}\n`;
      report += `🟡 Ушли раньше: ${leftEarlyCount}\n`;
      report += `⏱ Всего часов: ${totalHoursWorked.toFixed(1)}\n\n`;

      report += `<b>👥 Детали по сотрудникам:</b>\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

      for (const emp of employeeStats) {
        report += `${emp.status} <b>${emp.name}</b>\n`;
        report += `   Приход: ${emp.arrival} | Уход: ${emp.departure}\n`;
        report += `   Часов: ${emp.hours}\n\n`;
      }

      report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      report += `📅 Данные за ${dateStr} архивированы\n`;
      report += `🤖 Отчёт создан автоматически`;

      // Send to group
      await this.bot.telegram.sendMessage(
        Config.DAILY_REPORT_GROUP_ID,
        report,
        { parse_mode: 'HTML' }
      );

      logger.info(`Daily report sent to group ${Config.DAILY_REPORT_GROUP_ID}`);
    } catch (error) {
      logger.error(`Error sending daily report to group: ${error.message}`);
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
