/**
 * Attendance handler for check-in/out and related operations.
 * Implements arrival (+), departure (- message), late notifications, and status checks.
 */

const moment = require('moment-timezone');
const { Markup } = require('telegraf');
const sheetsService = require('../../services/sheets.service');
const CalculatorService = require('../../services/calculator.service');
const Keyboards = require('../keyboards/buttons');
const Config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Get user data or prompt for registration
 */
async function getUserOrPromptRegistration(ctx) {
  const telegramId = ctx.from.id;
  const user = await sheetsService.findEmployeeByTelegramId(telegramId);

  if (!user) {
    await ctx.reply(
      '❌ Вы не зарегистрированы в системе.\n' +
      'Используйте /start для регистрации.'
    );
    return null;
  }

  return user;
}

/**
 * Get main menu with dynamic buttons based on user status
 */
async function getMainMenuKeyboard(userId) {
  try {
    const status = await sheetsService.getUserStatusToday(userId);
    return Keyboards.getMainMenu(userId, status.currentlyOut);
  } catch (error) {
    // If error, return default keyboard
    return Keyboards.getMainMenu(userId, false);
  }
}

/**
 * Setup attendance handlers
 */
function setupAttendanceHandlers(bot) {
  // Handle arrival: "+" or button
  bot.hears(['+', '✅ Пришёл'], async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if already arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if currently out temporarily
    if (status.currentlyOut) {
      await ctx.reply(
        `❌ Вы временно вышли из офиса.\n` +
        `Сначала отметьте возвращение кнопкой "↩️ Вернулся".`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Check if already departed today
    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже ушли с работы сегодня в ${status.departureTime}\n` +
        `До завтра! 👋`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    if (status.hasArrived) {
      await ctx.reply(
        `ℹ️ Вы уже отметили приход сегодня в ${status.arrivalTime}`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Check if already marked as absent today
    if (status.isAbsent) {
      await ctx.reply(
        `❌ Вы уже отметили отсутствие сегодня. Вы не можете прийти в офис! 🤔`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Get current time
    const now = moment.tz(Config.TIMEZONE);

    // Parse work schedule
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if arriving after work end time
    if (now.isAfter(workTime.end)) {
      await ctx.reply(
        `⚠️ Ваше рабочее время уже закончилось!\n\n` +
        `Ваш график работы: ${user.workTime}\n` +
        `Время окончания работы: ${workTime.end.format('HH:mm')}\n` +
        `Текущее время: ${now.format('HH:mm')}\n\n` +
        `🌙 Увидимся завтра! Хорошего вечера!`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Calculate lateness
    const { latenessMinutes, status: latenessStatus } = CalculatorService.calculateLateness(
      workTime.start,
      now
    );

    let responseText = `✅ Отмечен приход: ${now.format('HH:mm')}\n`;
    let eventType = 'ARRIVAL';
    let details = 'on_time';
    let ratingImpact = 0.0;

    if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!`;
      details = 'on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
      // Check if user notified about being late
      if (status.lateNotified) {
        // User used late notification, less penalty
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (вы предупредили)\n`;
        details = `late_notified, ${latenessMinutes}min`;
        ratingImpact = CalculatorService.calculateRatingImpact('LATE_NOTIFIED');
      } else {
        // Silent late - higher penalty
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (без предупреждения)\n`;
        details = `late_silent, ${latenessMinutes}min`;
        ratingImpact = CalculatorService.calculateRatingImpact('LATE_SILENT');
      }

      // Calculate penalty time
      const penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
      const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);

      responseText += `⏳ Необходимо отработать дополнительно: ${CalculatorService.formatTimeDiff(penaltyMinutes)}\n`;
      responseText += `⏰ Уход не раньше: ${requiredEnd.format('HH:mm')}`;

      // Log penalty separately if it's a violation
      if (!status.lateNotified) {
        await sheetsService.logEvent(
          user.telegramId,
          user.nameFull,
          'LATE_SILENT',
          `${latenessMinutes} min, penalty=${penaltyMinutes} min`,
          ratingImpact
        );
        ratingImpact = 0.0; // Don't double-count
      }
    }

    // Log arrival
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      eventType,
      details,
      ratingImpact
    );

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on points
    let pointEmoji = '🟢';
    if (todayPoint < 0) {
      pointEmoji = '🔴';
    } else if (todayPoint === 0) {
      pointEmoji = '🟡';
    }

    responseText += `\n\n📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`;

    await ctx.reply(responseText, Keyboards.getMainMenu(ctx.from.id));
    logger.info(`Arrival logged for ${user.nameFull}: ${details}`);
  });

  // Handle departure with message: "- message"
  bot.hears(/^-\s+.+/, async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if marked as absent today
    if (status.isAbsent) {
      await ctx.reply(
        '❌ Вы не пришли на работу сегодня. Отдыхайте! 😴',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (!status.hasArrived) {
      await ctx.reply(
        '❌ Вы не отметили приход сегодня. Сначала отметьте приход с помощью \'+\'',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже отметили уход сегодня в ${status.departureTime}`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Extract message (everything after "- ")
    const departureMessage = ctx.message.text.substring(2).trim();
    const now = moment.tz(Config.TIMEZONE);

    // Parse work schedule
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    let responseText = `✅ Отмечен уход: ${now.format('HH:mm')}\n`;
    responseText += `💬 Сообщение: "${departureMessage}"\n`;

    let ratingImpact = 0.0;

    // Check if leaving early (only if not using extend)
    if (!status.extendNotified && status.arrivalTime) {
      try {
        const [arrivalHour, arrivalMin, arrivalSec] = status.arrivalTime.split(':').map(Number);
        const arrivalDt = now.clone().set({
          hour: arrivalHour,
          minute: arrivalMin,
          second: arrivalSec
        });

        // Recalculate lateness and penalty
        const { latenessMinutes } = CalculatorService.calculateLateness(workTime.start, arrivalDt);
        if (latenessMinutes > Config.GRACE_PERIOD_MINUTES) {
          const penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
          const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);

          if (now.isBefore(requiredEnd)) {
            // Leaving early!
            const earlyMinutes = requiredEnd.diff(now, 'minutes');
            responseText += `⚠️ Вы уходите раньше требуемого времени (${requiredEnd.format('HH:mm')})\n`;
            responseText += `⚠️ Недоработано: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;
            responseText += '⚠️ Это будет зафиксировано как нарушение.\n';

            // Log early departure violation
            ratingImpact = CalculatorService.calculateRatingImpact('EARLY_DEPARTURE');
            await sheetsService.logEvent(
              user.telegramId,
              user.nameFull,
              'EARLY_DEPARTURE',
              `left ${earlyMinutes} min early`,
              ratingImpact
            );
            ratingImpact = 0.0; // Don't double-count
          }
        }
      } catch (error) {
        logger.error(`Error calculating early departure: ${error.message}`);
      }
    }

    responseText += '👋 Хорошего вечера!';

    // Log departure
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'DEPARTURE',
      departureMessage,
      ratingImpact
    );

    // Calculate and log end-of-day balance
    if (status.arrivalTime) {
      try {
        // Parse arrival time
        const [arrivalHour, arrivalMin, arrivalSec] = status.arrivalTime.split(':').map(Number);
        const arrivalDt = now.clone().set({
          hour: arrivalHour,
          minute: arrivalMin,
          second: arrivalSec
        });

        // Calculate lateness and penalty
        const { latenessMinutes } = CalculatorService.calculateLateness(workTime.start, arrivalDt);
        let penaltyMinutes = 0;
        if (latenessMinutes > Config.GRACE_PERIOD_MINUTES) {
          penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
        }

        // Calculate required end time
        const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);

        // Calculate deficit or surplus
        const deficitMinutes = CalculatorService.calculateEarlyDepartureMinutes(now, requiredEnd);
        const surplusMinutes = CalculatorService.calculateOvertimeMinutes(now, requiredEnd);

        // Log the day's balance
        await sheetsService.logDayBalance(
          user.telegramId,
          user.nameFull,
          deficitMinutes,
          surplusMinutes,
          penaltyMinutes
        );

        // Add balance info to response
        if (deficitMinutes > 0) {
          responseText += `\n⏱ Сегодня недоработано: ${CalculatorService.formatTimeDiff(deficitMinutes)}`;
        } else if (surplusMinutes > 0 && penaltyMinutes === 0) {
          responseText += `\n⏱ Сегодня переработано: ${CalculatorService.formatTimeDiff(surplusMinutes)}`;
        } else if (surplusMinutes > 0 && penaltyMinutes > 0) {
          responseText += `\n⏱ Переработка ${CalculatorService.formatTimeDiff(surplusMinutes)} не засчитана (были штрафы)`;
        }
      } catch (error) {
        logger.error(`Error calculating day balance: ${error.message}`);
      }
    }

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on points
    let pointEmoji = '🟢';
    if (todayPoint < 0) {
      pointEmoji = '🔴';
    } else if (todayPoint === 0) {
      pointEmoji = '🟡';
    }

    responseText += `\n\n📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`;

    await ctx.reply(responseText, Keyboards.getMainMenu(ctx.from.id));
    logger.info(`Departure logged for ${user.nameFull}: ${departureMessage}`);
  });

  // Handle departure without message
  bot.hears('-', async (ctx) => {
    await ctx.reply(
      '❌ Пожалуйста, добавьте сообщение при уходе.\n\n' +
      'Пример:\n' +
      '• \'- Иду домой\'\n' +
      '• \'- До завтра\'\n' +
      '• \'- Ухожу на обед\'',
      Keyboards.getMainMenu(ctx.from.id)
    );
  });

  // Handle "I'm leaving" button
  bot.hears('🚪 Ухожу', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if already departed today
    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже ушли с работы сегодня в ${status.departureTime}\n` +
        `До завтра! 👋`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if marked as absent today
    if (status.isAbsent) {
      await ctx.reply(
        '❌ Вы не пришли на работу сегодня. Отдыхайте! 😴',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (!status.hasArrived) {
      await ctx.reply(
        '❌ Вы не отметили приход сегодня. Сначала отметьте приход с помощью \'+\' или кнопкой \'✅ Пришёл\'',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if leaving early or on time
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    // Check if after work end time
    if (workTime && now.isAfter(workTime.end)) {
      await ctx.reply(
        `⚠️ Ваше рабочее время уже закончилось!\n\n` +
        `🌙 Увидимся завтра! Хорошего вечера!`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if leaving before shift even started
    if (now.isBefore(workTime.start)) {
      const minutesBeforeShift = workTime.start.diff(now, 'minutes');
      await ctx.reply(
        `🚨 ВНИМАНИЕ! Вы уходите ДО НАЧАЛА рабочей смены!\n\n` +
        `Ваша смена начинается в: ${workTime.start.format('HH:mm')}\n` +
        `Сейчас: ${now.format('HH:mm')}\n` +
        `До начала смены: ${CalculatorService.formatTimeDiff(minutesBeforeShift)}\n\n` +
        `⚠️ Это будет считаться как полное отсутствие на работе!\n\n` +
        `Пожалуйста, укажите причину:`,
        Keyboards.getEarlyDepartureReasonKeyboard()
      );
      return;
    }

    // Calculate required work hours for the day
    const requiredWorkMinutes = workTime.end.diff(workTime.start, 'minutes');
    const requiredWorkHours = (requiredWorkMinutes / 60).toFixed(2);

    // Calculate actual worked hours
    let actualWorkedMinutes = 0;
    let arrivalTime = null;

    if (status.arrivalTime) {
      try {
        const [arriveHour, arriveMinute, arriveSecond] = status.arrivalTime.split(':').map(Number);
        arrivalTime = now.clone().set({
          hour: arriveHour,
          minute: arriveMinute,
          second: arriveSecond || 0
        });
        actualWorkedMinutes = now.diff(arrivalTime, 'minutes');
      } catch (err) {
        logger.error(`Error parsing arrival time: ${err.message}`);
      }
    }

    const actualWorkedHours = (actualWorkedMinutes / 60).toFixed(2);

    // Get the required end time from the daily sheet (if person came late, this will be later than normal end time)
    const sheetName = now.format('YYYY-MM-DD');
    const worksheet = await sheetsService.getWorksheet(sheetName);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    let requiredEndTime = workTime.end; // Default to normal work end time
    for (const row of rows) {
      if (row.get('TelegramId')?.toString().trim() === user.telegramId.toString()) {
        const requiredEndStr = row.get('Required end time') || '';
        if (requiredEndStr.trim()) {
          const [reqHour, reqMinute] = requiredEndStr.split(':').map(num => parseInt(num));
          requiredEndTime = moment.tz(Config.TIMEZONE).set({ hour: reqHour, minute: reqMinute, second: 0 });
        }
        break;
      }
    }

    // Check if person worked the full required hours
    const workedFullHours = actualWorkedMinutes >= requiredWorkMinutes;

    // Check if leaving before official end time
    const isLeavingEarly = now.isBefore(requiredEndTime);

    if (workedFullHours && isLeavingEarly) {
      // Worked full hours but leaving before official end time
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'DEPARTURE',
        'Worked full hours (early schedule)',
        0.0
      );

      // Get today's points
      const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
      const todayPoint = updatedStatus.todayPoint || 0;

      let pointEmoji = '🟢';
      if (todayPoint < 0) {
        pointEmoji = '🔴';
      } else if (todayPoint === 0) {
        pointEmoji = '🟡';
      }

      await ctx.reply(
        `✅ Вы отработали требуемое количество часов!\n\n` +
        `Требуется: ${requiredWorkHours} часа\n` +
        `Вы отработали: ${actualWorkedHours} часа\n\n` +
        `⚠️ Но вы уходите раньше официального времени окончания работы (${requiredEndTime.format('HH:mm')}).\n` +
        `Это будет зафиксировано в системе.\n\n` +
        `👋 Хорошего отдыха!\n\n` +
        `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      logger.info(`${user.nameFull} left early but worked full hours: ${actualWorkedHours}h`);
    } else if (!workedFullHours && isLeavingEarly) {
      // Did NOT work full hours and leaving early - ask for reason
      const remainingMinutes = requiredWorkMinutes - actualWorkedMinutes;
      const remainingHours = (remainingMinutes / 60).toFixed(2);

      await ctx.reply(
        `⚠️ Вы не отработали требуемое количество часов!\n\n` +
        `Требуется: ${requiredWorkHours} часа\n` +
        `Вы отработали: ${actualWorkedHours} часа\n` +
        `Осталось: ${remainingHours} часа\n\n` +
        `Пожалуйста, укажите причину раннего ухода:`,
        Keyboards.getEarlyDepartureReasonKeyboard()
      );
    } else {
      // Leaving on time or later - just say goodbye
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'DEPARTURE',
        'On time',
        0.0
      );

      // Get today's points
      const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
      const todayPoint = updatedStatus.todayPoint || 0;

      let pointEmoji = '🟢';
      if (todayPoint < 0) {
        pointEmoji = '🔴';
      } else if (todayPoint === 0) {
        pointEmoji = '🟡';
      }

      await ctx.reply(
        `✅ Отмечен уход: ${now.format('HH:mm')}\n\n` +
        `👋 Хорошего отдыха! До завтра! 😊\n\n` +
        `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      logger.info(`On-time departure logged for ${user.nameFull}`);
    }
  });

  // Handle late button
  bot.hears('🕒 Опоздаю', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if after work end time
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (now.isAfter(workTime.end)) {
      await ctx.reply(
        `⚠️ Ваше рабочее время уже закончилось!\n\n` +
        `🌙 Увидимся завтра! Хорошего вечера!`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if already arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if currently out temporarily
    if (status.currentlyOut) {
      await ctx.reply(
        `❌ Вы временно вышли из офиса.\n` +
        `Вы не можете отметить опоздание, находясь вне офиса.\n\n` +
        `Сначала вернитесь кнопкой "↩️ Вернулся".`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Check if already departed today
    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже ушли с работы сегодня в ${status.departureTime}\n` +
        `До завтра! 👋`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    if (status.hasArrived) {
      await ctx.reply(
        `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
        `Вы отметили приход в ${status.arrivalTime}`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Check if already marked as absent today
    if (status.isAbsent) {
      await ctx.reply(
        `❌ Вы уже отметили отсутствие сегодня. Вы не можете опоздать! 🤔`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if within deadline (15 min after work start)
    if (!CalculatorService.isWithinLateDeadline(workTime.start, now)) {
      const deadline = workTime.start.clone().add(15, 'minutes').format('HH:mm');
      await ctx.reply(
        `❌ Время для предупреждения об опоздании истекло (крайний срок: ${deadline}).\n` +
        'Братан, надо было раньше написать! 😅\n' +
        'Ваше опоздание будет зафиксировано без предупреждения.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    await ctx.reply(
      '🕒 На сколько минут вы опоздаете?',
      Keyboards.getLateReasonKeyboard()
    );
  });

  // Handle late duration selection
  bot.action(/^late_duration:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if already arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);
    if (status.hasArrived) {
      await ctx.editMessageText(
        `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
        `Вы отметили приход в ${status.arrivalTime}`
      );
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    // Check if already marked as absent today
    if (status.isAbsent) {
      await ctx.editMessageText(
        `❌ Вы уже отметили отсутствие сегодня. Вы не можете опоздать! 🤔`
      );
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    const durationCode = ctx.match[1];

    if (durationCode === 'cancel') {
      await ctx.editMessageText('❌ Отменено.');
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    if (durationCode === 'custom') {
      await ctx.editMessageText('🔢 Введите количество минут (только цифры):');
      await ctx.reply(
        'Используйте клавиатуру ниже для ввода числа:',
        Keyboards.getNumericKeyboard('60')
      );
      ctx.session = ctx.session || {};
      ctx.session.awaitingLateDuration = true;
      ctx.session.customDurationInput = '';
      return;
    }

    // Duration is in minutes
    const durationMinutes = parseInt(durationCode);

    // Get work time to calculate arrival time
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.editMessageText('❌ Ошибка в вашем расписании. Обратитесь к администратору.');
      return;
    }

    // Calculate expected arrival time
    const expectedArrival = workTime.start.clone().add(durationMinutes, 'minutes');
    const arrivalTimeStr = expectedArrival.format('HH:mm');

    // Log late notification with arrival time
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'LATE_NOTIFIED',
      arrivalTimeStr,
      0.0 // No penalty for notifying
    );

    await ctx.editMessageText(
      `✅ Ваше предупреждение принято!\n\n` +
      `Вы опоздаете на: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
      `Ожидаемое время прибытия: ${arrivalTimeStr}\n\n` +
      `При прибытии отметьтесь командой '+' или кнопкой '✅ Пришёл'`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Late notification from ${user.nameFull}: ${durationMinutes} min, arriving at ${arrivalTimeStr}`);
  });

  // Handle custom late duration with numeric keyboard
  bot.on('text', async (ctx, next) => {
    // Handle custom late duration input
    if (ctx.session?.awaitingLateDuration) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingLateDuration;
        delete ctx.session.customDurationInput;
        return;
      }

      // Check if already arrived today
      const status = await sheetsService.getUserStatusToday(user.telegramId);
      if (status.hasArrived) {
        await ctx.reply(
          `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
          `Вы отметили приход в ${status.arrivalTime}`,
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingLateDuration;
        delete ctx.session.customDurationInput;
        return;
      }

      // Check if already marked as absent today
      if (status.isAbsent) {
        await ctx.reply(
          `❌ Вы уже отметили отсутствие сегодня. Вы не можете опоздать! 🤔`,
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingLateDuration;
        delete ctx.session.customDurationInput;
        return;
      }

      const input = ctx.message.text.trim();

      // Handle numeric keyboard buttons
      if (input === '⬅️ Удалить') {
        // Delete last character
        if (ctx.session.customDurationInput) {
          ctx.session.customDurationInput = ctx.session.customDurationInput.slice(0, -1);
        }
        await ctx.reply(
          `Текущий ввод: ${ctx.session.customDurationInput || '(пусто)'} минут`,
          Keyboards.getNumericKeyboard()
        );
        return;
      }

      if (input === '✅ Готово') {
        const durationMinutes = parseInt(ctx.session.customDurationInput);

        if (!durationMinutes || durationMinutes <= 0) {
          await ctx.reply(
            '❌ Пожалуйста, введите корректное число минут.',
            Keyboards.getNumericKeyboard()
          );
          return;
        }

        // Get work time to calculate arrival time
        const workTime = CalculatorService.parseWorkTime(user.workTime);
        if (!workTime) {
          await ctx.reply(
            '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
            Keyboards.getMainMenu(ctx.from.id)
          );
          delete ctx.session.awaitingLateDuration;
          delete ctx.session.customDurationInput;
          return;
        }

        // Calculate expected arrival time
        const expectedArrival = workTime.start.clone().add(durationMinutes, 'minutes');
        const arrivalTimeStr = expectedArrival.format('HH:mm');

        // Log late notification with arrival time
        await sheetsService.logEvent(
          user.telegramId,
          user.nameFull,
          'LATE_NOTIFIED',
          arrivalTimeStr,
          0.0
        );

        await ctx.reply(
          `✅ Ваше предупреждение принято!\n\n` +
          `Вы опоздаете на: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
          `Ожидаемое время прибытия: ${arrivalTimeStr}\n\n` +
          `При прибытии отметьтесь командой '+' или кнопкой '✅ Пришёл'`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        logger.info(`Late notification from ${user.nameFull}: ${durationMinutes} min, arriving at ${arrivalTimeStr}`);

        delete ctx.session.awaitingLateDuration;
        delete ctx.session.customDurationInput;
        return;
      }

      // Handle number input (0-9)
      if (/^[0-9]$/.test(input)) {
        ctx.session.customDurationInput = (ctx.session.customDurationInput || '') + input;
        await ctx.reply(
          `Текущий ввод: ${ctx.session.customDurationInput} минут`,
          Keyboards.getNumericKeyboard()
        );
        return;
      }

      // If user types something else, treat it as direct number input
      const directInput = parseInt(input);
      if (!isNaN(directInput) && directInput > 0) {
        ctx.session.customDurationInput = input;
        await ctx.reply(
          `Введено: ${input} минут\nНажмите "✅ Готово" для подтверждения`,
          Keyboards.getNumericKeyboard()
        );
        return;
      }

      // Invalid input
      await ctx.reply(
        '❌ Пожалуйста, используйте цифровую клавиатуру или введите число.',
        Keyboards.getNumericKeyboard()
      );
      return;
    }

    // Handle departure message
    if (ctx.session?.awaitingDepartureMessage) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingDepartureMessage;
        return;
      }

      // Check if marked as absent today
      const statusCheck = await sheetsService.getUserStatusToday(user.telegramId);
      if (statusCheck.isAbsent) {
        await ctx.reply(
          '❌ Вы не пришли на работу сегодня. Отдыхайте! 😴',
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingDepartureMessage;
        return;
      }

      const departureMessage = ctx.message.text.trim();
      const now = moment.tz(Config.TIMEZONE);

      // Parse work schedule
      const workTime = CalculatorService.parseWorkTime(user.workTime);
      if (!workTime) {
        await ctx.reply(
          '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingDepartureMessage;
        return;
      }

      let responseText = `✅ Отмечен уход: ${now.format('HH:mm')}\n`;
      responseText += `💬 Сообщение: "${departureMessage}"\n`;

      let ratingImpact = 0.0;

      // Check if arrived today (should be already checked, but double-check)
      const status = await sheetsService.getUserStatusToday(user.telegramId);

      // Check if leaving early
      if (!status.extendNotified && status.arrivalTime) {
        try {
          const [arrivalHour, arrivalMin, arrivalSec] = status.arrivalTime.split(':').map(Number);
          const arrivalDt = now.clone().set({
            hour: arrivalHour,
            minute: arrivalMin,
            second: arrivalSec
          });

          // Recalculate lateness and penalty
          const { latenessMinutes } = CalculatorService.calculateLateness(workTime.start, arrivalDt);
          if (latenessMinutes > Config.GRACE_PERIOD_MINUTES) {
            const penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
            const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);

            if (now.isBefore(requiredEnd)) {
              // Leaving early!
              const earlyMinutes = requiredEnd.diff(now, 'minutes');
              responseText += `⚠️ Вы уходите раньше требуемого времени (${requiredEnd.format('HH:mm')})\n`;
              responseText += `⚠️ Недоработано: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;
              responseText += '⚠️ Это будет зафиксировано как нарушение.\n';

              // Log early departure violation
              ratingImpact = CalculatorService.calculateRatingImpact('EARLY_DEPARTURE');
              await sheetsService.logEvent(
                user.telegramId,
                user.nameFull,
                'EARLY_DEPARTURE',
                `left ${earlyMinutes} min early`,
                ratingImpact
              );
              ratingImpact = 0.0; // Don't double-count
            }
          }
        } catch (error) {
          logger.error(`Error calculating early departure: ${error.message}`);
        }
      }

      responseText += '👋 Хорошего вечера!';

      // Log departure
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'DEPARTURE',
        departureMessage,
        ratingImpact
      );

      // Get today's points
      const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
      const todayPoint = updatedStatus.todayPoint || 0;

      // Determine emoji based on points
      let pointEmoji = '🟢';
      if (todayPoint < 0) {
        pointEmoji = '🔴';
      } else if (todayPoint === 0) {
        pointEmoji = '🟡';
      }

      responseText += `\n\n📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`;

      await ctx.reply(responseText, Keyboards.getMainMenu(ctx.from.id));
      logger.info(`Departure logged for ${user.nameFull}: ${departureMessage}`);

      delete ctx.session.awaitingDepartureMessage;
      return;
    }

    // Handle custom absent reason
    if (ctx.session?.awaitingAbsentReason) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingAbsentReason;
        return;
      }

      // Check if already arrived today
      const status = await sheetsService.getUserStatusToday(user.telegramId);
      if (status.hasArrived) {
        await ctx.reply(
          `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
          `Вы отметили приход в ${status.arrivalTime}`,
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingAbsentReason;
        return;
      }

      const reason = ctx.message.text.trim();

      // Log absence
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'ABSENT_NOTIFIED',
        reason,
        0.0
      );

      await ctx.reply(
        `✅ Ваше отсутствие зафиксировано.\n` +
        `Причина: ${reason}\n\n` +
        `Хорошего дня!`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      delete ctx.session.awaitingAbsentReason;
      logger.info(`Absence notification from ${user.nameFull}: ${reason}`);
      return;
    }

    // Handle custom early departure reason
    if (ctx.session?.awaitingEarlyDepartureReason) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingEarlyDepartureReason;
        return;
      }

      // Check if already departed today
      const status = await sheetsService.getUserStatusToday(user.telegramId);
      if (status.hasDeparted) {
        await ctx.reply(
          `ℹ️ Вы уже отметили уход сегодня в ${status.departureTime}`,
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingEarlyDepartureReason;
        return;
      }

      const reason = ctx.message.text.trim();

      // Log departure with early reason
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'DEPARTURE',
        reason,
        0.0
      );

      // Get today's points
      const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
      const todayPoint = updatedStatus.todayPoint || 0;

      // Determine emoji based on points
      let pointEmoji = '🟢';
      if (todayPoint < 0) {
        pointEmoji = '🔴';
      } else if (todayPoint === 0) {
        pointEmoji = '🟡';
      }

      const now = moment.tz(Config.TIMEZONE);

      await ctx.reply(
        `✅ Отмечен уход: ${now.format('HH:mm')}\n` +
        `Причина раннего ухода: ${reason}\n\n` +
        `⚠️ Ранний уход зафиксирован.\n\n` +
        `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      delete ctx.session.awaitingEarlyDepartureReason;
      logger.info(`Early departure logged for ${user.nameFull}: ${reason}`);
      return;
    }

    return next();
  });

  // Handle absent button
  bot.hears('🚫 Отсутствую', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if after work end time
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (now.isAfter(workTime.end)) {
      await ctx.reply(
        `⚠️ Ваше рабочее время уже закончилось!\n\n` +
        `🌙 Увидимся завтра! Хорошего вечера!`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if already arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if currently out temporarily
    if (status.currentlyOut) {
      await ctx.reply(
        `❌ Вы временно вышли из офиса.\n` +
        `Вы не можете отметить отсутствие, находясь вне офиса.\n\n` +
        `Сначала вернитесь кнопкой "↩️ Вернулся" или отметьте полный уход.`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    // Check if already departed today
    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже ушли с работы сегодня в ${status.departureTime}\n` +
        `До завтра! 👋`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    if (status.hasArrived) {
      await ctx.reply(
        `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
        `Вы отметили приход в ${status.arrivalTime}`,
        await getMainMenuKeyboard(ctx.from.id)
      );
      return;
    }

    await ctx.reply(
      '🚫 Выберите причину отсутствия:',
      Keyboards.getAbsentReasonKeyboard()
    );
  });

  // Handle absent reason selection
  bot.action(/^absent_reason:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if already arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);
    if (status.hasArrived) {
      await ctx.editMessageText(
        `❌ Вы уже в офисе, что вы делаете? 🤔\n` +
        `Вы отметили приход в ${status.arrivalTime}`
      );
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    const reasonCode = ctx.match[1];

    if (reasonCode === 'cancel') {
      await ctx.editMessageText('❌ Отменено.');
      return;
    }

    if (reasonCode === 'other') {
      await ctx.editMessageText('📝 Напишите причину отсутствия:', Keyboards.getTextInput('Болею / Личные дела...'));
      ctx.session = ctx.session || {};
      ctx.session.awaitingAbsentReason = true;
      return;
    }

    // Map reason codes to text
    const reasons = {
      'sick': 'Болею',
      'family': 'Семейные обстоятельства',
      'business_trip': 'Командировка',
      'personal': 'Личные дела'
    };

    const reasonText = reasons[reasonCode] || 'Не указана';

    // Log absence (no penalty for notifying)
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'ABSENT_NOTIFIED',
      reasonText,
      0.0
    );

    await ctx.editMessageText(
      `✅ Ваше отсутствие зафиксировано.\n` +
      `Причина: ${reasonText}\n\n` +
      `Выздоравливайте! / Хорошего дня!`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Absence notification from ${user.nameFull}: ${reasonText}`);
  });

  // Handle early departure reason selection
  bot.action(/^early_reason:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if already departed today
    const status = await sheetsService.getUserStatusToday(user.telegramId);
    if (status.hasDeparted) {
      await ctx.editMessageText(
        `ℹ️ Вы уже отметили уход сегодня в ${status.departureTime}`
      );
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    const reasonCode = ctx.match[1];

    if (reasonCode === 'cancel') {
      await ctx.editMessageText('❌ Отменено.');
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    if (reasonCode === 'other') {
      await ctx.editMessageText('📝 Напишите причину раннего ухода:', Keyboards.getTextInput('Семья / Здоровье...'));
      ctx.session = ctx.session || {};
      ctx.session.awaitingEarlyDepartureReason = true;
      return;
    }

    // Map reason codes to text
    const reasons = {
      'family': 'Семейные обстоятельства',
      'health': 'Здоровье',
      'personal': 'Личные дела',
      'transport': 'Транспорт'
    };

    const reasonText = reasons[reasonCode] || 'Не указана';

    // Log departure with early reason
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'DEPARTURE',
      reasonText,
      0.0
    );

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on points
    let pointEmoji = '🟢';
    if (todayPoint < 0) {
      pointEmoji = '🔴';
    } else if (todayPoint === 0) {
      pointEmoji = '🟡';
    }

    const now = moment.tz(Config.TIMEZONE);

    await ctx.editMessageText(
      `✅ Отмечен уход: ${now.format('HH:mm')}\n` +
      `Причина раннего ухода: ${reasonText}\n\n` +
      `⚠️ Ранний уход зафиксирован.\n\n` +
      `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Early departure logged for ${user.nameFull}: ${reasonText}`);
  });

  // Handle working longer button
  bot.hears('⏰ Работаю дольше', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if after work end time
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (now.isAfter(workTime.end)) {
      await ctx.reply(
        `⚠️ Ваше рабочее время уже закончилось!\n\n` +
        `🌙 Увидимся завтра! Хорошего вечера!`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if marked as absent today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if already departed today
    if (status.hasDeparted) {
      await ctx.reply(
        `ℹ️ Вы уже ушли с работы сегодня в ${status.departureTime}\n` +
        `До завтра! 👋`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (status.isAbsent) {
      await ctx.reply(
        '❌ Вы не пришли на работу сегодня. Отдыхайте! 😴',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if user has arrived at office first
    if (!status.hasArrived) {
      if (status.lateNotified) {
        await ctx.reply(
          '❌ Вы ещё не пришли в офис. Сначала отметьтесь кнопкой \'✅ Пришёл\'',
          Keyboards.getMainMenu(ctx.from.id)
        );
      } else {
        await ctx.reply(
          '❌ Вы ещё не пришли в офис. Сначала отметьтесь кнопкой \'+\' или \'✅ Пришёл\'',
          Keyboards.getMainMenu(ctx.from.id)
        );
      }
      return;
    }

    // Calculate when user can extend (15 min before work end)
    const extendAllowedTime = workTime.end.clone().subtract(15, 'minutes');

    if (now.isBefore(extendAllowedTime)) {
      const minutesUntilEnd = workTime.end.diff(now, 'minutes');
      await ctx.reply(
        `⏰ Ваш рабочий день ещё не закончился!\n` +
        `До конца работы: ${CalculatorService.formatTimeDiff(minutesUntilEnd)}\n\n` +
        `Вы сможете продлить рабочий день за 15 минут до конца (с ${extendAllowedTime.format('HH:mm')})`,
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    await ctx.reply(
      '⏰ На сколько вы хотите продлить рабочий день?',
      Keyboards.getExtendDurationKeyboard()
    );
  });

  // Handle extend duration selection
  bot.action(/^extend_duration:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    const durationCode = ctx.match[1];

    if (durationCode === 'cancel') {
      await ctx.editMessageText('❌ Отменено.');
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    if (durationCode === 'custom') {
      await ctx.editMessageText('🔢 Введите количество минут (только цифры):');
      await ctx.reply(
        'Используйте клавиатуру ниже для ввода числа:',
        Keyboards.getNumericKeyboard('120')
      );
      ctx.session = ctx.session || {};
      ctx.session.awaitingExtendCustomDuration = true;
      ctx.session.customExtendInput = '';
      return;
    }

    // Duration is in minutes
    const durationMinutes = parseInt(durationCode);

    // Calculate new end time
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.editMessageText('❌ Ошибка в вашем расписании. Обратитесь к администратору.');
      return;
    }

    const newEndTime = workTime.end.clone().add(durationMinutes, 'minutes');
    const newEndTimeStr = newEndTime.format('HH:mm');

    // Log extend event
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'EXTEND',
      newEndTimeStr,
      0.0
    );

    await ctx.editMessageText(
      `✅ Продление рабочего дня принято!\n\n` +
      `Дополнительное время: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
      `Новое время окончания работы: ${newEndTimeStr}\n\n` +
      `Хорошей работы! 💪`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Extend notification from ${user.nameFull}: ${durationMinutes} min, new end: ${newEndTimeStr}`);
  });

  // Handle custom extend duration with numeric keyboard
  bot.on('text', async (ctx, next) => {
    // Handle custom extend duration input
    if (ctx.session?.awaitingExtendCustomDuration) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingExtendCustomDuration;
        delete ctx.session.customExtendInput;
        return;
      }

      const input = ctx.message.text.trim();

      // Handle numeric keyboard buttons
      if (input === '⬅️ Удалить') {
        // Delete last character
        if (ctx.session.customExtendInput) {
          ctx.session.customExtendInput = ctx.session.customExtendInput.slice(0, -1);
        }
        await ctx.reply(
          `Текущий ввод: ${ctx.session.customExtendInput || '(пусто)'} минут`,
          Keyboards.getNumericKeyboard()
        );
        return;
      }

      if (input === '✅ Готово') {
        const durationMinutes = parseInt(ctx.session.customExtendInput);

        if (!durationMinutes || durationMinutes <= 0) {
          await ctx.reply(
            '❌ Пожалуйста, введите корректное число минут.',
            Keyboards.getNumericKeyboard()
          );
          return;
        }

        // Calculate new end time
        const workTime = CalculatorService.parseWorkTime(user.workTime);
        if (!workTime) {
          await ctx.reply(
            '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
            Keyboards.getMainMenu(ctx.from.id)
          );
          delete ctx.session.awaitingExtendCustomDuration;
          delete ctx.session.customExtendInput;
          return;
        }

        const newEndTime = workTime.end.clone().add(durationMinutes, 'minutes');
        const newEndTimeStr = newEndTime.format('HH:mm');

        // Log extend event
        await sheetsService.logEvent(
          user.telegramId,
          user.nameFull,
          'EXTEND',
          newEndTimeStr,
          0.0
        );

        await ctx.reply(
          `✅ Продление рабочего дня принято!\n\n` +
          `Дополнительное время: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
          `Новое время окончания работы: ${newEndTimeStr}\n\n` +
          `Хорошей работы! 💪`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        logger.info(`Extend notification from ${user.nameFull}: ${durationMinutes} min, new end: ${newEndTimeStr}`);

        delete ctx.session.awaitingExtendCustomDuration;
        delete ctx.session.customExtendInput;
        return;
      }

      // Handle number input (0-9)
      if (/^[0-9]$/.test(input)) {
        ctx.session.customExtendInput = (ctx.session.customExtendInput || '') + input;
        await ctx.reply(
          `Текущий ввод: ${ctx.session.customExtendInput} минут`,
          Keyboards.getNumericKeyboard()
        );
        return;
      }

      // Invalid input
      await ctx.reply(
        '❌ Пожалуйста, используйте цифровую клавиатуру или введите число.',
        Keyboards.getNumericKeyboard()
      );
      return;
    }

    if (ctx.session?.awaitingExtendReason) {
      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session.awaitingExtendReason;
        return;
      }

      // Check if marked as absent today
      const statusCheck = await sheetsService.getUserStatusToday(user.telegramId);
      if (statusCheck.isAbsent) {
        await ctx.reply(
          '❌ Вы не пришли на работу сегодня. Отдыхайте! 😴',
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingExtendReason;
        return;
      }

      // Check if user has arrived at office first
      if (!statusCheck.hasArrived) {
        await ctx.reply(
          '❌ Вы ещё не пришли в офис. Сначала отметьтесь кнопкой \'✅ Пришёл\'',
          Keyboards.getMainMenu(ctx.from.id)
        );
        delete ctx.session.awaitingExtendReason;
        return;
      }

      const reason = ctx.message.text.trim();

      // Log extend notification
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'EXTEND',
        reason,
        0.0
      );

      await ctx.reply(
        `✅ Записано. Уведомите, когда будете уходить.\n` +
        `Причина: ${reason}`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      delete ctx.session.awaitingExtendReason;
      logger.info(`Extend notification from ${user.nameFull}: ${reason}`);
      return;
    }

    return next();
  });

  // Handle status command
  bot.command('status', async (ctx) => await handleStatus(ctx));
  bot.hears('📋 Мой статус', async (ctx) => await handleStatus(ctx));

  // Admin command: Create today's sheet manually
  bot.command('createsheet', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      await ctx.reply(`🔄 Создаю лист для ${today}...`);

      // Create daily sheet
      await sheetsService.initializeDailySheet(today);

      await ctx.reply(
        `✅ Лист создан успешно!\n\n` +
        `📅 Дата: ${today}\n` +
        `⏰ Время: ${now.format('HH:mm:ss')}\n\n` +
        `Проверьте Google Sheets!`
      );

      logger.info(`Admin ${ctx.from.id} manually created sheet for ${today}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при создании листа: ${error.message}`);
      logger.error(`Error in /createsheet command: ${error.message}`);
    }
  });

  // Admin command: Manually trigger end-of-day process (for testing)
  bot.command('endday', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    // In production, require confirmation
    if (Config.NODE_ENV === 'production') {
      await ctx.reply(
        '⚠️ ПРЕДУПРЕЖДЕНИЕ\n\n' +
        'Эта команда завершит день, архивирует данные и УДАЛИТ текущий лист.\n\n' +
        'Вы уверены? Используйте /endday_confirm для подтверждения.'
      );
      return;
    }

    try {
      const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');

      await ctx.reply(
        `🔄 Запуск процесса завершения дня для ${today}...\n\n` +
        `Это займёт несколько секунд...`
      );

      const schedulerService = require('../../services/scheduler.service');
      await schedulerService.handleEndOfDay(today, true); // true = manual mode (no wait)

      await ctx.reply(
        `✅ Завершение дня выполнено!\n\n` +
        `📊 Данные перенесены в месячный отчёт\n` +
        `📨 Отчёт отправлен в группу\n` +
        `🗑 Лист ${today} удалён`
      );

      logger.info(`Admin ${ctx.from.id} manually triggered end-of-day for ${today}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при завершении дня: ${error.message}`);
      logger.error(`Error in /endday command: ${error.message}`);
    }
  });

  // Admin command: Confirm end-of-day in production
  bot.command('endday_confirm', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    try {
      const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');

      await ctx.reply(
        `🔄 Запуск процесса завершения дня для ${today}...\n\n` +
        `Обработка занимает несколько секунд...`
      );

      const schedulerService = require('../../services/scheduler.service');
      await schedulerService.handleEndOfDay(today, true); // true = manual mode (no wait)

      await ctx.reply(
        `✅ Завершение дня выполнено!\n\n` +
        `📊 Данные перенесены в месячный отчёт\n` +
        `📨 Отчёт отправлен в группу\n` +
        `🗑 Лист ${today} удалён`
      );

      logger.info(`Admin ${ctx.from.id} manually confirmed and triggered end-of-day for ${today}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при завершении дня: ${error.message}`);
      logger.error(`Error in /endday_confirm command: ${error.message}`);
    }
  });

  // Handle overtime arrival confirmation
  bot.action(/^overtime_arrival:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    const answer = ctx.match[1];

    if (answer === 'no') {
      await ctx.editMessageText(
        '👍 Хорошо! Увидимся завтра!\n\n' +
        'Хорошего отдыха! 😊'
      );
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      delete ctx.session.arrivingAfterHours;
      delete ctx.session.arrivalTimeStr;
      return;
    }

    // Yes - mark as overtime arrival
    if (!ctx.session?.arrivingAfterHours || !ctx.session?.arrivalTimeStr) {
      await ctx.editMessageText('❌ Ошибка: сессия истекла. Попробуйте снова.');
      return;
    }

    try {
      // Parse the stored time string back to moment
      const now = moment.tz(ctx.session.arrivalTimeStr, 'YYYY-MM-DD HH:mm:ss', Config.TIMEZONE);

      // Log arrival as overtime
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'ARRIVAL',
        'Overtime work',
        1.0  // Full point for overtime work
      );

      await ctx.editMessageText(
        `✅ Сверхурочная работа зафиксирована!\n\n` +
        `⏰ Время прихода: ${now.format('HH:mm:ss')}\n` +
        `📊 Баллы: +1.0 🟢\n\n` +
        `Не забудьте отметить уход!`
      );

      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

      logger.info(`Overtime arrival logged for ${user.nameFull} at ${now.format('HH:mm')}`);

      delete ctx.session.arrivingAfterHours;
      delete ctx.session.arrivalTimeStr;
    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error in overtime arrival: ${error.message}`);
    }
  });

  // Admin command: Update monthly report manually
  bot.command('updatereport', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');
      const reportSheetName = `Report_${yearMonth}`;

      await ctx.reply(`🔄 Проверяю месячный отчёт ${yearMonth}...`);

      // Check if monthly report exists
      const reportExists = sheetsService.doc.sheetsByTitle[reportSheetName];

      if (!reportExists) {
        await ctx.reply(`📝 Создаю новый месячный отчёт ${reportSheetName}...`);
        await sheetsService.initializeMonthlyReport(yearMonth);
        logger.info(`Created new monthly report ${reportSheetName}`);
      }

      await ctx.reply(`🔄 Обновляю отчёт данными всех дней месяца...`);

      // Update with all daily sheets from this month
      const startOfMonth = moment.tz(Config.TIMEZONE).startOf('month');
      const currentDay = now.date();
      let processedDays = 0;

      for (let day = 1; day <= currentDay; day++) {
        const dateStr = moment.tz(Config.TIMEZONE).set('date', day).format('YYYY-MM-DD');

        // Check if daily sheet exists
        const dailySheet = sheetsService.doc.sheetsByTitle[dateStr];
        if (dailySheet) {
          await sheetsService.updateMonthlyReport(dateStr);
          processedDays++;
          logger.info(`Updated monthly report with data from ${dateStr}`);

          // Add delay to avoid API rate limit (1.5 seconds between each day)
          if (day < currentDay) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }

      await ctx.reply(
        `✅ Месячный отчёт обновлён успешно!\n\n` +
        `📅 Месяц: ${yearMonth}\n` +
        `📊 Обработано дней: ${processedDays}\n` +
        `⏰ Время: ${now.format('HH:mm:ss')}\n\n` +
        `Проверьте Google Sheets!`
      );

      logger.info(`Admin ${ctx.from.id} manually updated monthly report with ${processedDays} days of data`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при обновлении отчёта: ${error.message}`);
      logger.error(`Error in /updatereport command: ${error.message}`);
    }
  });

  // Admin command: Send daily report
  bot.command('reportdaily', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      await ctx.reply(`📊 Формирую дневной отчёт за ${today}...`);

      // Get today's worksheet
      const worksheet = await sheetsService.getWorksheet(today);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply('📭 Нет данных за сегодня.');
        return;
      }

      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;
      let leftEarlyCount = 0;

      // Build employee rows HTML
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

        // Point class
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

      // Build HTML report
      const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Дневной отчёт - ${today}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 {
      font-size: 36px;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .header .date {
      font-size: 20px;
      opacity: 0.9;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #f8f9fa;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 15px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
      transition: transform 0.3s ease;
    }
    .stat-card:hover {
      transform: translateY(-5px);
    }
    .stat-card .number {
      font-size: 36px;
      font-weight: bold;
      margin-bottom: 10px;
    }
    .stat-card .label {
      color: #6c757d;
      font-size: 14px;
    }
    .stat-total .number { color: #667eea; }
    .stat-present .number { color: #10b981; }
    .stat-late .number { color: #f59e0b; }
    .stat-absent .number { color: #ef4444; }
    .stat-early .number { color: #8b5cf6; }
    .table-container {
      padding: 30px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 10px;
    }
    thead th {
      background: #667eea;
      color: white;
      padding: 15px;
      text-align: left;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 1px;
    }
    thead th:first-child {
      border-radius: 10px 0 0 10px;
    }
    thead th:last-child {
      border-radius: 0 10px 10px 0;
    }
    tbody tr {
      background: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      transition: all 0.3s ease;
    }
    tbody tr:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      transform: scale(1.01);
    }
    tbody td {
      padding: 20px 15px;
      border-top: 1px solid #f1f3f5;
      border-bottom: 1px solid #f1f3f5;
    }
    tbody td:first-child {
      font-weight: 600;
      color: #2d3748;
      border-left: 1px solid #f1f3f5;
      border-radius: 10px 0 0 10px;
    }
    tbody td:last-child {
      border-right: 1px solid #f1f3f5;
      border-radius: 0 10px 10px 0;
      text-align: center;
      font-weight: bold;
      font-size: 18px;
    }
    .status-ontime { color: #10b981; font-weight: 500; }
    .status-late { color: #f59e0b; font-weight: 500; }
    .status-absent { color: #ef4444; font-weight: 500; }
    .status-notarrived { color: #94a3b8; font-weight: 500; }
    .point-good { color: #10b981; }
    .point-neutral { color: #f59e0b; }
    .point-bad { color: #ef4444; }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📅 Дневной отчёт</h1>
      <div class="date">${today} • ${now.format('HH:mm:ss')}</div>
    </div>

    <div class="stats">
      <div class="stat-card stat-total">
        <div class="number">${rows.length}</div>
        <div class="label">Всего сотрудников</div>
      </div>
      <div class="stat-card stat-present">
        <div class="number">${presentCount}</div>
        <div class="label">Присутствуют</div>
      </div>
      <div class="stat-card stat-late">
        <div class="number">${lateCount}</div>
        <div class="label">Опоздали</div>
      </div>
      <div class="stat-card stat-absent">
        <div class="number">${absentCount}</div>
        <div class="label">Отсутствуют</div>
      </div>
      <div class="stat-card stat-early">
        <div class="number">${leftEarlyCount}</div>
        <div class="label">Ушли рано</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Сотрудник</th>
            <th>Статус</th>
            <th>Баллы</th>
          </tr>
        </thead>
        <tbody>
          ${employeeRows}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Сгенерировано системой учёта посещаемости • ${now.format('DD.MM.YYYY HH:mm:ss')}
    </div>
  </div>
</body>
</html>
      `;

      // Save to temp file
      const fs = require('fs');
      const path = require('path');
      const tempDir = path.join(__dirname, '../../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filename = `daily_report_${today}.html`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, html, 'utf8');

      // Send as document
      await ctx.replyWithDocument({ source: filepath, filename: filename }, {
        caption: `📊 Дневной отчёт за ${today}\n\n✅ Присутствуют: ${presentCount}\n🕒 Опоздали: ${lateCount}\n❌ Отсутствуют: ${absentCount}`
      });

      // Clean up temp file
      fs.unlinkSync(filepath);

      logger.info(`Admin ${ctx.from.id} requested daily report for ${today}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при формировании отчёта: ${error.message}`);
      logger.error(`Error in /reportdaily command: ${error.message}`);
    }
  });

  // Admin command: Send monthly report
  bot.command('reportmonthly', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      await ctx.reply('❌ У вас нет прав для выполнения этой команды.');
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');

      await ctx.reply(`📊 Формирую месячный отчёт за ${yearMonth}...`);

      // Get monthly report worksheet
      const sheetName = `Report_${yearMonth}`;
      const worksheet = await sheetsService.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply('📭 Нет данных за этот месяц.');
        return;
      }

      // Sort by rating (descending)
      const sortedRows = rows.sort((a, b) => {
        const ratingA = parseFloat(a.get('Rating (0-10)') || '0');
        const ratingB = parseFloat(b.get('Rating (0-10)') || '0');
        return ratingB - ratingA;
      });

      // Build employee rows HTML
      let employeeRows = '';
      let rank = 1;
      for (const row of sortedRows) {
        const name = row.get('Name') || 'N/A';
        const totalWorkDays = row.get('Total Work Days') || '0';
        const daysWorked = row.get('Days Worked') || '0';
        const daysAbsent = row.get('Days Absent') || '0';
        const onTimeArrivals = row.get('On Time Arrivals') || '0';
        const lateArrivalsNotified = row.get('Late Arrivals (Notified)') || '0';
        const lateArrivalsSilent = row.get('Late Arrivals (Silent)') || '0';
        const totalHoursRequired = row.get('Total Hours Required') || '0';
        const totalHoursWorked = row.get('Total Hours Worked') || '0';
        const attendanceRate = row.get('Attendance Rate %') || '0';
        const onTimeRate = row.get('On-Time Rate %') || '0';
        const rating = row.get('Rating (0-10)') || '0';
        const ratingZone = row.get('Rating Zone') || 'N/A';
        const avgDailyPoints = row.get('Average Daily Points') || '0';

        let zoneClass = 'zone-red';
        let rankMedal = '';
        if (ratingZone === 'Green') {
          zoneClass = 'zone-green';
        } else if (ratingZone === 'Yellow') {
          zoneClass = 'zone-yellow';
        }

        // Top 3 medals
        if (rank === 1) rankMedal = '🥇';
        else if (rank === 2) rankMedal = '🥈';
        else if (rank === 3) rankMedal = '🥉';

        employeeRows += `
          <tr class="${zoneClass}">
            <td class="rank">${rankMedal} ${rank}</td>
            <td class="name">${name}</td>
            <td class="rating"><strong>${rating}</strong>/10</td>
            <td>${avgDailyPoints}</td>
            <td>${daysWorked}/${totalWorkDays}<br><small>${attendanceRate}%</small></td>
            <td>${onTimeArrivals}<br><small>${onTimeRate}%</small></td>
            <td>${lateArrivalsNotified} / ${lateArrivalsSilent}</td>
            <td>${totalHoursWorked}<br><small>из ${totalHoursRequired}</small></td>
            <td>${daysAbsent}</td>
          </tr>
        `;
        rank++;
      }

      // Build HTML report
      const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Месячный отчёт - ${yearMonth}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 {
      font-size: 42px;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .header .date {
      font-size: 20px;
      opacity: 0.9;
    }
    .legend {
      display: flex;
      justify-content: center;
      gap: 30px;
      padding: 30px;
      background: #f8f9fa;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .legend-badge {
      width: 20px;
      height: 20px;
      border-radius: 50%;
    }
    .badge-green { background: #10b981; }
    .badge-yellow { background: #f59e0b; }
    .badge-red { background: #ef4444; }
    .table-container {
      padding: 30px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 8px;
    }
    thead th {
      background: #667eea;
      color: white;
      padding: 15px 10px;
      text-align: center;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    thead th:first-child {
      border-radius: 10px 0 0 10px;
      text-align: left;
      padding-left: 20px;
    }
    thead th:last-child {
      border-radius: 0 10px 10px 0;
    }
    tbody tr {
      background: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      transition: all 0.3s ease;
    }
    tbody tr:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transform: translateY(-2px);
    }
    tbody td {
      padding: 18px 10px;
      text-align: center;
      border-top: 1px solid #f1f3f5;
      border-bottom: 1px solid #f1f3f5;
      font-size: 14px;
    }
    tbody td:first-child {
      border-left: 1px solid #f1f3f5;
      border-radius: 10px 0 0 10px;
      text-align: left;
      padding-left: 20px;
    }
    tbody td:last-child {
      border-right: 1px solid #f1f3f5;
      border-radius: 0 10px 10px 0;
    }
    .rank {
      font-weight: bold;
      font-size: 16px;
      color: #667eea;
    }
    .name {
      font-weight: 600;
      color: #2d3748;
      text-align: left !important;
      font-size: 15px;
    }
    .rating {
      font-size: 18px;
      font-weight: bold;
    }
    .zone-green {
      border-left: 4px solid #10b981;
    }
    .zone-green .rating {
      color: #10b981;
    }
    .zone-yellow {
      border-left: 4px solid #f59e0b;
    }
    .zone-yellow .rating {
      color: #f59e0b;
    }
    .zone-red {
      border-left: 4px solid #ef4444;
    }
    .zone-red .rating {
      color: #ef4444;
    }
    small {
      color: #6c757d;
      font-size: 11px;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
    @media (max-width: 768px) {
      table {
        font-size: 12px;
      }
      tbody td, thead th {
        padding: 10px 5px;
      }
      .header h1 {
        font-size: 28px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Месячный отчёт</h1>
      <div class="date">${yearMonth} • Сгенерировано ${now.format('DD.MM.YYYY HH:mm')}</div>
    </div>

    <div class="legend">
      <div class="legend-item">
        <div class="legend-badge badge-green"></div>
        <span><strong>Зелёная зона:</strong> ≥8.5 баллов</span>
      </div>
      <div class="legend-item">
        <div class="legend-badge badge-yellow"></div>
        <span><strong>Жёлтая зона:</strong> 6.5-8.4 баллов</span>
      </div>
      <div class="legend-item">
        <div class="legend-badge badge-red"></div>
        <span><strong>Красная зона:</strong> &lt;6.5 баллов</span>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Место</th>
            <th>Сотрудник</th>
            <th>Рейтинг</th>
            <th>Ср. баллы</th>
            <th>Дни работы</th>
            <th>Вовремя</th>
            <th>Опоздания<br><small>Ув./Неув.</small></th>
            <th>Часы</th>
            <th>Отсутствия</th>
          </tr>
        </thead>
        <tbody>
          ${employeeRows}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Сгенерировано системой учёта посещаемости • ${now.format('DD.MM.YYYY HH:mm:ss')}
    </div>
  </div>
</body>
</html>
      `;

      // Save to temp file
      const fs = require('fs');
      const path = require('path');
      const tempDir = path.join(__dirname, '../../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filename = `monthly_report_${yearMonth}.html`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, html, 'utf8');

      // Calculate summary stats
      let greenCount = 0, yellowCount = 0, redCount = 0;
      sortedRows.forEach(row => {
        const zone = row.get('Rating Zone') || '';
        if (zone === 'Green') greenCount++;
        else if (zone === 'Yellow') yellowCount++;
        else redCount++;
      });

      // Send as document
      await ctx.replyWithDocument({ source: filepath, filename: filename }, {
        caption: `📊 Месячный отчёт за ${yearMonth}\n\n🟢 Зелёная зона: ${greenCount}\n🟡 Жёлтая зона: ${yellowCount}\n🔴 Красная зона: ${redCount}`
      });

      // Clean up temp file
      fs.unlinkSync(filepath);

      logger.info(`Admin ${ctx.from.id} requested monthly report for ${yearMonth}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка при формировании отчёта: ${error.message}`);
      logger.error(`Error in /reportmonthly command: ${error.message}`);
    }
  });

  // Admin button: Daily report
  bot.hears('📊 Отчёт за день', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    // Trigger the same logic as /reportdaily command
    ctx.command = { command: 'reportdaily' };
    const reportDailyHandler = bot.handleUpdate.bind(bot);

    // Call reportdaily logic
    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      await ctx.reply(`📊 Формирую дневной отчёт за ${today}...`);

      const worksheet = await sheetsService.getWorksheet(today);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply('📭 Нет данных за сегодня.', Keyboards.getMainMenu(ctx.from.id));
        return;
      }

      // Generate report (same as /reportdaily)
      await generateAndSendDailyReport(ctx, today, now, rows);

    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error in daily report button: ${error.message}`);
    }
  });

  // Admin button: Monthly report
  bot.hears('📈 Отчёт за месяц', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');

      await ctx.reply(`📊 Формирую месячный отчёт за ${yearMonth}...`);

      const sheetName = `Report_${yearMonth}`;
      const worksheet = await sheetsService.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      if (rows.length === 0) {
        await ctx.reply('📭 Нет данных за этот месяц.', Keyboards.getMainMenu(ctx.from.id));
        return;
      }

      // Generate report (same as /reportmonthly)
      await generateAndSendMonthlyReport(ctx, yearMonth, now, rows);

    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error in monthly report button: ${error.message}`);
    }
  });

  // Admin button: Broadcast message
  bot.hears('📢 Отправить всем сообщение', async (ctx) => {
    // Check if user is admin
    if (!Config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
      return;
    }

    await ctx.reply(
      '📢 Введите сообщение, которое хотите отправить всем сотрудникам:\n\n' +
      'Или отправьте /cancel для отмены.',
      Keyboards.getTextInput('Ваше сообщение...')
    );

    ctx.session = ctx.session || {};
    ctx.session.awaitingBroadcastMessage = true;
  });

  // Handle broadcast message input
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.awaitingBroadcastMessage) {
      const message = ctx.message.text;

      if (message === '/cancel') {
        ctx.session.awaitingBroadcastMessage = false;
        await ctx.reply('❌ Отправка отменена.', Keyboards.getMainMenu(ctx.from.id));
        return;
      }

      try {
        await ctx.reply('📤 Отправляю сообщение всем сотрудникам...');

        // Get all employees from roster
        const rosterWorksheet = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
        await rosterWorksheet.loadHeaderRow();
        const employees = await rosterWorksheet.getRows();

        let successCount = 0;
        let failCount = 0;

        for (const employee of employees) {
          const telegramId = employee.get('Telegram Id');
          if (telegramId && telegramId.trim()) {
            try {
              await bot.telegram.sendMessage(
                telegramId,
                `📢 Сообщение от администрации:\n\n${message}`
              );
              successCount++;
              // Small delay to avoid rate limits
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
              logger.error(`Failed to send message to ${telegramId}: ${err.message}`);
              failCount++;
            }
          }
        }

        await ctx.reply(
          `✅ Сообщение отправлено!\n\n` +
          `📬 Успешно: ${successCount}\n` +
          `❌ Ошибки: ${failCount}`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        ctx.session.awaitingBroadcastMessage = false;
        logger.info(`Admin ${ctx.from.id} sent broadcast message to ${successCount} employees`);

      } catch (error) {
        await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
        logger.error(`Error in broadcast: ${error.message}`);
        ctx.session.awaitingBroadcastMessage = false;
      }

      return;
    }

    // Continue to next handler
    return next();
  });

  // Temporary exit button
  bot.hears('🚶 Выхожу временно', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if person has arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);
    if (!status.hasArrived) {
      await ctx.reply(
        '❌ Вы еще не отметили приход сегодня.\n' +
        'Сначала отметьте приход, а потом можете выйти временно.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if already departed for the day
    if (status.hasDeparted) {
      await ctx.reply(
        '❌ Вы уже ушли с работы сегодня.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if currently out
    if (status.currentlyOut) {
      await ctx.reply(
        '❌ Вы уже отметили временный выход.\n' +
        'Сначала вернитесь, используя кнопку "↩️ Вернулся".',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    await ctx.reply(
      '🚶 Укажите причину временного выхода:',
      Keyboards.getTempExitReasonKeyboard()
    );
  });

  // Handle temporary exit reason selection
  bot.action(/temp_exit_reason:(.+)/, async (ctx) => {
    const reason = ctx.match[1];

    if (reason === 'cancel') {
      await ctx.answerCbQuery();
      await ctx.editMessageText('❌ Отменено.');
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      return;
    }

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    // Map reason to text
    const reasonMap = {
      'lunch': '🍽 Обед',
      'medical': '🏥 Врач/Аптека',
      'documents': '🏦 Банк/Документы',
      'family': '👨‍👩‍👧 Семейные дела',
      'transport': '🚗 Транспорт',
      'object': '🏗 Выхожу на обек',
      'other': '📝 Другая причина'
    };

    const reasonText = reasonMap[reason] || reason;

    // Store reason in session
    ctx.session = ctx.session || {};
    ctx.session.tempExitReason = reasonText;

    if (reason === 'other') {
      await ctx.answerCbQuery();
      await ctx.editMessageText('📝 Введите свою причину:', Keyboards.getTextInput('Обед / Врач...'));
      ctx.session.awaitingTempExitCustomReason = true;
    } else {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `Причина: ${reasonText}\n\n` +
        '⏱ Как долго вы будете отсутствовать?'
      );
      await ctx.reply(
        'Выберите продолжительность отсутствия:',
        Keyboards.getTempExitDurationKeyboard()
      );
    }
  });

  // Handle temporary exit duration selection
  bot.action(/temp_exit_duration:(.+)/, async (ctx) => {
    const duration = ctx.match[1];

    if (duration === 'cancel') {
      await ctx.answerCbQuery();
      await ctx.editMessageText('❌ Отменено.');
      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      delete ctx.session?.tempExitReason;
      return;
    }

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    const reason = ctx.session?.tempExitReason || 'Не указана';

    if (duration === 'custom') {
      await ctx.answerCbQuery();
      await ctx.editMessageText('🔢 Введите время в минутах:');
      await ctx.reply(
        'Используйте клавиатуру ниже для ввода числа:',
        Keyboards.getNumericKeyboard('30')
      );
      ctx.session.awaitingTempExitCustomDuration = true;
      return;
    }

    const durationMinutes = parseInt(duration);

    try {
      const now = moment.tz(Config.TIMEZONE);
      const expectedReturn = now.clone().add(durationMinutes, 'minutes');

      // Log temporary exit
      await sheetsService.logTempExit(
        user.telegramId,
        user.nameFull,
        reason,
        durationMinutes,
        now.format('HH:mm:ss'),
        expectedReturn.format('HH:mm:ss')
      );

      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `✅ Временный выход зафиксирован\n\n` +
        `📋 Причина: ${reason}\n` +
        `⏱ Продолжительность: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
        `🕐 Выход: ${now.format('HH:mm')}\n` +
        `🕐 Ожидаемое возвращение: ${expectedReturn.format('HH:mm')}\n\n` +
        `Не забудьте отметить возвращение кнопкой "↩️ Вернулся"!`
      );
      await ctx.reply('🏠 Главное меню:', await getMainMenuKeyboard(ctx.from.id));

      delete ctx.session?.tempExitReason;

      logger.info(`${user.nameFull} temporary exit: ${reason}, ${durationMinutes} min`);
    } catch (error) {
      await ctx.answerCbQuery();
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error logging temporary exit: ${error.message}`);
    }
  });

  // Handle temp exit reminder confirmation (will return on time)
  bot.action('temp_exit_confirm_return', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '✅ Отлично! Ждём вас обратно вовремя.\n\n' +
      'Не забудьте отметить возвращение кнопкой "↩️ Вернулся"!'
    );
  });

  // Handle temp exit time extension request
  bot.action(/temp_exit_extend:(\d+)/, async (ctx) => {
    const extendMinutes = parseInt(ctx.match[1]);

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    try {
      // Get current expected return and extend it
      const status = await sheetsService.getUserStatusToday(user.telegramId);

      if (!status.currentlyOut) {
        await ctx.answerCbQuery('❌ Вы не отмечены как вышедший');
        return;
      }

      const now = moment.tz(Config.TIMEZONE);
      const worksheet = await sheetsService.getWorksheet(now.format('YYYY-MM-DD'));
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === user.telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        await ctx.answerCbQuery('❌ Ошибка: данные не найдены');
        return;
      }

      // Get current expected return and extend it
      const tempExitExpectedReturn = employeeRow.get('Temp exit expected return') || '';
      const expectedReturnArray = tempExitExpectedReturn.split('; ');
      const lastExpectedReturn = expectedReturnArray[expectedReturnArray.length - 1];

      // Parse and extend
      const currentReturn = moment.tz(lastExpectedReturn, 'HH:mm:ss', Config.TIMEZONE);
      const newReturn = currentReturn.add(extendMinutes, 'minutes');

      // Update last expected return time
      expectedReturnArray[expectedReturnArray.length - 1] = newReturn.format('HH:mm:ss');
      employeeRow.set('Temp exit expected return', expectedReturnArray.join('; '));

      // Calculate new remind time (15 min before new return time)
      const newRemindAt = newReturn.clone().subtract(15, 'minutes').format('HH:mm:ss');
      const remindAtArray = (employeeRow.get('Temp exit remind at') || '').split('; ');
      remindAtArray[remindAtArray.length - 1] = newRemindAt;
      employeeRow.set('Temp exit remind at', remindAtArray.join('; '));

      // Reset reminder sent flag so new reminder can be sent
      employeeRow.set('Temp exit remind sent', 'false');

      await employeeRow.save();

      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `✅ Время продлено на ${CalculatorService.formatTimeDiff(extendMinutes)}\n\n` +
        `Новое время возвращения: ${newReturn.format('HH:mm')}\n` +
        `Вы получите напоминание за 15 минут до этого времени.\n\n` +
        `Не забудьте отметить возвращение кнопкой "↩️ Вернулся"!`
      );

      logger.info(`${user.nameFull} extended temp exit by ${extendMinutes} min, new return: ${newReturn.format('HH:mm')}`);
    } catch (error) {
      await ctx.answerCbQuery('❌ Ошибка');
      logger.error(`Error extending temp exit: ${error.message}`);
    }
  });

  // Return from temporary exit button
  bot.hears('↩️ Вернулся', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if person has arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);
    if (!status.hasArrived) {
      await ctx.reply(
        '❌ Вы еще не отмечали приход сегодня.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if already departed for the day
    if (status.hasDeparted) {
      await ctx.reply(
        '❌ Вы уже ушли с работы сегодня.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if currently out
    if (!status.currentlyOut) {
      await ctx.reply(
        '❌ Вы не отмечали временный выход.\n' +
        'Используйте кнопку "🚶 Выхожу временно" перед тем, как отмечать возвращение.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);

      // Log return from temporary exit (returns minutes out)
      const minutesOut = await sheetsService.logTempReturn(
        user.telegramId,
        user.nameFull,
        now.format('HH:mm:ss')
      );

      let message = `✅ Возвращение зафиксировано\n\n` +
                    `🕐 Время возвращения: ${now.format('HH:mm')}\n`;

      if (minutesOut > 0) {
        message += `⏱ Отсутствовали: ${CalculatorService.formatTimeDiff(minutesOut)}\n`;
      }

      message += `\nДобро пожаловать обратно!`;

      await ctx.reply(message, await getMainMenuKeyboard(ctx.from.id));

      logger.info(`${user.nameFull} returned from temporary exit at ${now.format('HH:mm')}, was out ${minutesOut} min`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error logging temporary return: ${error.message}`);
    }
  });

  // Handle custom temporary exit reason input
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.awaitingTempExitCustomReason) {
      const customReason = ctx.message.text.trim();

      ctx.session.tempExitReason = customReason;
      delete ctx.session.awaitingTempExitCustomReason;

      await ctx.reply(
        `Причина: ${customReason}\n\n` +
        '⏱ Как долго вы будете отсутствовать?',
        Keyboards.getTempExitDurationKeyboard()
      );
      return;
    }

    if (ctx.session?.awaitingTempExitCustomDuration) {
      const durationText = ctx.message.text.trim();
      const durationMinutes = parseInt(durationText);

      if (isNaN(durationMinutes) || durationMinutes <= 0 || durationMinutes > 480) {
        await ctx.reply(
          '❌ Пожалуйста, введите корректное число минут (от 1 до 480).'
        );
        return;
      }

      const user = await getUserOrPromptRegistration(ctx);
      if (!user) {
        delete ctx.session?.awaitingTempExitCustomDuration;
        delete ctx.session?.tempExitReason;
        return;
      }

      const reason = ctx.session?.tempExitReason || 'Не указана';

      try {
        const now = moment.tz(Config.TIMEZONE);
        const expectedReturn = now.clone().add(durationMinutes, 'minutes');

        // Log temporary exit
        await sheetsService.logTempExit(
          user.telegramId,
          user.nameFull,
          reason,
          durationMinutes,
          now.format('HH:mm:ss'),
          expectedReturn.format('HH:mm:ss')
        );

        await ctx.reply(
          `✅ Временный выход зафиксирован\n\n` +
          `📋 Причина: ${reason}\n` +
          `⏱ Продолжительность: ${CalculatorService.formatTimeDiff(durationMinutes)}\n` +
          `🕐 Выход: ${now.format('HH:mm')}\n` +
          `🕐 Ожидаемое возвращение: ${expectedReturn.format('HH:mm')}\n\n` +
          `Не забудьте отметить возвращение кнопкой "↩️ Вернулся"!`,
          await getMainMenuKeyboard(ctx.from.id)
        );

        delete ctx.session?.awaitingTempExitCustomDuration;
        delete ctx.session?.tempExitReason;

        logger.info(`${user.nameFull} temporary exit: ${reason}, ${durationMinutes} min`);
      } catch (error) {
        await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
        logger.error(`Error logging temporary exit: ${error.message}`);
        delete ctx.session?.awaitingTempExitCustomDuration;
        delete ctx.session?.tempExitReason;
      }
      return;
    }

    return next();
  });

  // Handle /endday command - manually trigger end of day calculation
  bot.command('endday', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    // Check if user has arrived and departed today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    if (!status.hasArrived) {
      await ctx.reply(
        '❌ Вы не отмечали приход сегодня.\n' +
        'Завершение дня невозможно.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (!status.hasDeparted) {
      await ctx.reply(
        '❌ Вы не отмечали уход сегодня.\n' +
        'Сначала отметьте уход с помощью \'- сообщение\'',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    const now = moment.tz(Config.TIMEZONE);

    // Parse work schedule
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.reply(
        '❌ Ошибка в вашем расписании. Обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    let responseText = '📊 ИТОГИ ДНЯ\n\n';

    try {
      // Parse arrival and departure times
      const [arrivalHour, arrivalMin, arrivalSec] = status.arrivalTime.split(':').map(Number);
      const arrivalDt = now.clone().set({
        hour: arrivalHour,
        minute: arrivalMin,
        second: arrivalSec
      });

      const [departureHour, departureMin, departureSec] = status.departureTime.split(':').map(Number);
      const departureDt = now.clone().set({
        hour: departureHour,
        minute: departureMin,
        second: departureSec
      });

      // Calculate total hours worked
      const hoursWorked = CalculatorService.calculateHoursWorked(arrivalDt, departureDt);
      responseText += `⏰ Время прихода: ${status.arrivalTime}\n`;
      responseText += `⏰ Время ухода: ${status.departureTime}\n`;
      responseText += `📊 Отработано: ${CalculatorService.formatTimeDiff(hoursWorked)}\n\n`;

      // Calculate lateness and penalty
      const { latenessMinutes } = CalculatorService.calculateLateness(workTime.start, arrivalDt);
      let penaltyMinutes = 0;
      if (latenessMinutes > Config.GRACE_PERIOD_MINUTES) {
        penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)}\n`;
        responseText += `⚠️ Штраф: ${CalculatorService.formatTimeDiff(penaltyMinutes)}\n\n`;
      }

      // Calculate required hours
      const requiredMinutes = CalculatorService.calculateRequiredHours(workTime.start, workTime.end, penaltyMinutes);
      responseText += `📋 Требуется отработать: ${CalculatorService.formatTimeDiff(requiredMinutes)}\n\n`;

      // Calculate required end time
      const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);

      // Calculate deficit or surplus
      const deficitMinutes = CalculatorService.calculateEarlyDepartureMinutes(departureDt, requiredEnd);
      const surplusMinutes = CalculatorService.calculateOvertimeMinutes(departureDt, requiredEnd);

      // Log the day's balance
      await sheetsService.logDayBalance(
        user.telegramId,
        user.nameFull,
        deficitMinutes,
        surplusMinutes,
        penaltyMinutes
      );

      // Show balance result
      if (deficitMinutes > 0) {
        responseText += `❌ Недоработано: ${CalculatorService.formatTimeDiff(deficitMinutes)}\n`;
        responseText += '⚠️ Это время будет добавлено к вашему балансу недоработки.';
      } else if (surplusMinutes > 0 && penaltyMinutes === 0) {
        responseText += `✅ Переработано: ${CalculatorService.formatTimeDiff(surplusMinutes)}\n`;
        responseText += '✅ Это время зачтено в ваш баланс переработки.';
      } else if (surplusMinutes > 0 && penaltyMinutes > 0) {
        responseText += `⏱ Переработано: ${CalculatorService.formatTimeDiff(surplusMinutes)}\n`;
        responseText += '⚠️ Не зачтено - сначала нужно отработать штрафное время.';
      } else {
        responseText += '✅ Отработано ровно требуемое время. Отлично!';
      }
    } catch (error) {
      logger.error(`Error in endday calculation: ${error.message}`);
      responseText += '❌ Ошибка при подсчете итогов дня.';
    }

    await ctx.reply(responseText, Keyboards.getMainMenu(ctx.from.id));
  });
}

// Helper function to generate and send daily report
async function generateAndSendDailyReport(ctx, today, now, rows) {
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

  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Дневной отчёт - ${today}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 { font-size: 36px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #f8f9fa;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 15px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
      transition: transform 0.3s ease;
    }
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
    thead th {
      background: #667eea;
      color: white;
      padding: 15px;
      text-align: left;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 1px;
    }
    thead th:first-child { border-radius: 10px 0 0 10px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr {
      background: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      transition: all 0.3s ease;
    }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); transform: scale(1.01); }
    tbody td {
      padding: 20px 15px;
      border-top: 1px solid #f1f3f5;
      border-bottom: 1px solid #f1f3f5;
    }
    tbody td:first-child {
      font-weight: 600;
      color: #2d3748;
      border-left: 1px solid #f1f3f5;
      border-radius: 10px 0 0 10px;
    }
    tbody td:last-child {
      border-right: 1px solid #f1f3f5;
      border-radius: 0 10px 10px 0;
      text-align: center;
      font-weight: bold;
      font-size: 18px;
    }
    .status-ontime { color: #10b981; font-weight: 500; }
    .status-late { color: #f59e0b; font-weight: 500; }
    .status-absent { color: #ef4444; font-weight: 500; }
    .status-notarrived { color: #94a3b8; font-weight: 500; }
    .point-good { color: #10b981; }
    .point-neutral { color: #f59e0b; }
    .point-bad { color: #ef4444; }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📅 Дневной отчёт</h1>
      <div class="date">${today} • ${now.format('HH:mm:ss')}</div>
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
</html>
  `;

  const tempDir = path.join(__dirname, '../../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `daily_report_${today}.html`;
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, html, 'utf8');

  await ctx.replyWithDocument({ source: filepath, filename: filename }, {
    caption: `📊 Дневной отчёт за ${today}\n\n✅ Присутствуют: ${presentCount}\n🕒 Опоздали: ${lateCount}\n❌ Отсутствуют: ${absentCount}`
  });

  fs.unlinkSync(filepath);
}

// Helper function to generate and send monthly report
async function generateAndSendMonthlyReport(ctx, yearMonth, now, rows) {
  const fs = require('fs');
  const path = require('path');

  // Sort by rating (descending)
  const sortedRows = rows.sort((a, b) => {
    const ratingA = parseFloat(a.get('Rating (0-10)') || '0');
    const ratingB = parseFloat(b.get('Rating (0-10)') || '0');
    return ratingB - ratingA;
  });

  // Build employee rows HTML
  let employeeRows = '';
  let rank = 1;
  for (const row of sortedRows) {
    const name = row.get('Name') || 'N/A';
    const totalWorkDays = row.get('Total Work Days') || '0';
    const daysWorked = row.get('Days Worked') || '0';
    const daysAbsent = row.get('Days Absent') || '0';
    const onTimeArrivals = row.get('On Time Arrivals') || '0';
    const lateArrivalsNotified = row.get('Late Arrivals (Notified)') || '0';
    const lateArrivalsSilent = row.get('Late Arrivals (Silent)') || '0';
    const totalHoursRequired = row.get('Total Hours Required') || '0';
    const totalHoursWorked = row.get('Total Hours Worked') || '0';
    const attendanceRate = row.get('Attendance Rate %') || '0';
    const onTimeRate = row.get('On-Time Rate %') || '0';
    const rating = row.get('Rating (0-10)') || '0';
    const ratingZone = row.get('Rating Zone') || 'N/A';
    const avgDailyPoints = row.get('Average Daily Points') || '0';

    let zoneClass = 'zone-red';
    let rankMedal = '';
    if (ratingZone === 'Green') {
      zoneClass = 'zone-green';
    } else if (ratingZone === 'Yellow') {
      zoneClass = 'zone-yellow';
    }

    // Top 3 medals
    if (rank === 1) rankMedal = '🥇';
    else if (rank === 2) rankMedal = '🥈';
    else if (rank === 3) rankMedal = '🥉';

    employeeRows += `
      <tr class="${zoneClass}">
        <td class="rank">${rankMedal} ${rank}</td>
        <td class="name">${name}</td>
        <td class="rating"><strong>${rating}</strong>/10</td>
        <td>${avgDailyPoints}</td>
        <td>${daysWorked}/${totalWorkDays}<br><small>${attendanceRate}%</small></td>
        <td>${onTimeArrivals}<br><small>${onTimeRate}%</small></td>
        <td>${lateArrivalsNotified} / ${lateArrivalsSilent}</td>
        <td>${totalHoursWorked}<br><small>из ${totalHoursRequired}</small></td>
        <td>${daysAbsent}</td>
      </tr>
    `;
    rank++;
  }

  // Build HTML report
  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Месячный отчёт - ${yearMonth}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 { font-size: 42px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .legend {
      display: flex;
      justify-content: center;
      gap: 30px;
      padding: 30px;
      background: #f8f9fa;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .legend-badge { width: 20px; height: 20px; border-radius: 50%; }
    .badge-green { background: #10b981; }
    .badge-yellow { background: #f59e0b; }
    .badge-red { background: #ef4444; }
    .table-container { padding: 30px; overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
    thead th {
      background: #667eea;
      color: white;
      padding: 15px 10px;
      text-align: center;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    thead th:first-child { border-radius: 10px 0 0 10px; text-align: left; padding-left: 20px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr {
      background: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      transition: all 0.3s ease;
    }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); transform: translateY(-2px); }
    tbody td {
      padding: 18px 10px;
      text-align: center;
      border-top: 1px solid #f1f3f5;
      border-bottom: 1px solid #f1f3f5;
      font-size: 14px;
    }
    tbody td:first-child {
      border-left: 1px solid #f1f3f5;
      border-radius: 10px 0 0 10px;
      text-align: left;
      padding-left: 20px;
    }
    tbody td:last-child { border-right: 1px solid #f1f3f5; border-radius: 0 10px 10px 0; }
    .rank { font-weight: bold; font-size: 16px; color: #667eea; }
    .name { font-weight: 600; color: #2d3748; text-align: left !important; font-size: 15px; }
    .rating { font-size: 18px; font-weight: bold; }
    .zone-green { border-left: 4px solid #10b981; }
    .zone-green .rating { color: #10b981; }
    .zone-yellow { border-left: 4px solid #f59e0b; }
    .zone-yellow .rating { color: #f59e0b; }
    .zone-red { border-left: 4px solid #ef4444; }
    .zone-red .rating { color: #ef4444; }
    small { color: #6c757d; font-size: 11px; }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 14px;
    }
    @media (max-width: 768px) {
      table { font-size: 12px; }
      tbody td, thead th { padding: 10px 5px; }
      .header h1 { font-size: 28px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Месячный отчёт</h1>
      <div class="date">${yearMonth} • Сгенерировано ${now.format('DD.MM.YYYY HH:mm')}</div>
    </div>

    <div class="legend">
      <div class="legend-item">
        <div class="legend-badge badge-green"></div>
        <span><strong>Зелёная зона:</strong> ≥8.5 баллов</span>
      </div>
      <div class="legend-item">
        <div class="legend-badge badge-yellow"></div>
        <span><strong>Жёлтая зона:</strong> 6.5-8.4 баллов</span>
      </div>
      <div class="legend-item">
        <div class="legend-badge badge-red"></div>
        <span><strong>Красная зона:</strong> &lt;6.5 баллов</span>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Место</th>
            <th>Сотрудник</th>
            <th>Рейтинг</th>
            <th>Ср. баллы</th>
            <th>Дни работы</th>
            <th>Вовремя</th>
            <th>Опоздания<br><small>Ув./Неув.</small></th>
            <th>Часы</th>
            <th>Отсутствия</th>
          </tr>
        </thead>
        <tbody>
          ${employeeRows}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Сгенерировано системой учёта посещаемости • ${now.format('DD.MM.YYYY HH:mm:ss')}
    </div>
  </div>
</body>
</html>
  `;

  const tempDir = path.join(__dirname, '../../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `monthly_report_${yearMonth}.html`;
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, html, 'utf8');

  // Calculate summary stats
  let greenCount = 0, yellowCount = 0, redCount = 0;
  sortedRows.forEach(row => {
    const zone = row.get('Rating Zone') || '';
    if (zone === 'Green') greenCount++;
    else if (zone === 'Yellow') yellowCount++;
    else redCount++;
  });

  // Send as document
  await ctx.replyWithDocument({ source: filepath, filename: filename }, {
    caption: `📊 Месячный отчёт за ${yearMonth}\n\n🟢 Зелёная зона: ${greenCount}\n🟡 Жёлтая зона: ${yellowCount}\n🔴 Красная зона: ${redCount}`
  });

  // Clean up temp file
  fs.unlinkSync(filepath);
}

async function handleStatus(ctx) {
  const user = await getUserOrPromptRegistration(ctx);
  if (!user) return;

  // Get today's status
  const status = await sheetsService.getUserStatusToday(user.telegramId);

  // Get today's point from status
  const todayPoint = status.todayPoint || 0;

  // Determine emoji and message based on today's point
  let pointEmoji = '⚪';
  let pointMessage = 'Пока не отмечен';

  if (todayPoint >= 1.0) {
    pointEmoji = '🟢';
    if (status.isAbsent) {
      pointMessage = 'Отсутствие зафиксировано';
    } else if (status.lateNotified) {
      pointMessage = 'Опоздание предупреждено!';
    } else {
      pointMessage = 'Отличная работа!';
    }
  } else if (todayPoint > 0 && todayPoint < 1.0) {
    pointEmoji = '🟡';
    pointMessage = 'Небольшое нарушение';
  } else if (todayPoint === 0) {
    if (status.hasArrived) {
      pointEmoji = '🟢';
      pointMessage = 'Без нарушений';
    } else {
      pointEmoji = '⚪';
      pointMessage = 'Ожидается отметка';
    }
  } else if (todayPoint < 0) {
    if (todayPoint >= -0.5) {
      pointEmoji = '🟡';
      pointMessage = 'Небольшое нарушение';
    } else {
      pointEmoji = '🔴';
      pointMessage = 'Есть нарушения';
    }
  }

  const now = moment.tz(Config.TIMEZONE);

  let response = `📊 ВАШ СТАТУС\n\n`;
  response += `👤 Имя: ${user.nameFull}\n`;
  response += `🏢 Компания: ${user.company}\n`;
  response += `⏰ График: ${user.workTime}\n\n`;

  response += `📅 СЕГОДНЯ (${now.format('DD.MM.YYYY')}):\n`;

  // Check if user is absent today
  if (status.isAbsent) {
    response += `🏠 Вы отметили отсутствие сегодня\n`;
    response += `✅ Не волнуйтесь, ваше отсутствие зафиксировано!\n`;
    response += `💤 Отдыхайте или выздоравливайте!\n`;
  } else {
    // Normal status display
    if (status.hasArrived) {
      response += `✅ Приход: ${status.arrivalTime}\n`;
    } else {
      response += `❌ Приход: не отмечен\n`;
    }

    if (status.hasDeparted) {
      response += `✅ Уход: ${status.departureTime}\n`;
      if (status.departureMessage) {
        response += `💬 Сообщение: "${status.departureMessage}"\n`;
      }
    } else {
      response += `❌ Уход: не отмечен\n`;
    }

    if (status.violations.length > 0) {
      response += `\n⚠️ Нарушения сегодня:\n`;
      for (const v of status.violations) {
        response += `  • ${v.type}: ${v.details}\n`;
      }
    }
  }

  response += `\n📊 ВАШ БАЛЛ СЕГОДНЯ:\n`;
  response += `Баллы: ${todayPoint} ${pointEmoji}\n`;
  response += `Статус: ${pointMessage}`;

  // Add monthly time balance
  const balance = await sheetsService.getMonthlyBalance(user.telegramId);
  response += `\n\n⏱ БАЛАНС ВРЕМЕНИ ЗА МЕСЯЦ:\n`;

  if (balance.totalDeficitMinutes > 0) {
    response += `⚠️ Недоработка: ${CalculatorService.formatTimeDiff(balance.totalDeficitMinutes)}\n`;
  }
  if (balance.totalSurplusMinutes > 0) {
    response += `✅ Переработка: ${CalculatorService.formatTimeDiff(balance.totalSurplusMinutes)}\n`;
  }

  const netBalance = balance.netBalanceMinutes;
  if (netBalance > 0) {
    response += `📊 Итого: +${CalculatorService.formatTimeDiff(netBalance)}`;
  } else if (netBalance < 0) {
    response += `📊 Итого: -${CalculatorService.formatTimeDiff(Math.abs(netBalance))}`;
  } else {
    response += `📊 Итого: 0 ч (баланс)`;
  }

  await ctx.reply(response, Keyboards.getMainMenu(ctx.from.id));
}

module.exports = {
  setupAttendanceHandlers
};
