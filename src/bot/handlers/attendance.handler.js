/**
 * Attendance handler for check-in/out and related operations.
 * Implements arrival (+), departure (- message), late notifications, and status checks.
 */

const moment = require('moment-timezone');
const { Markup } = require('telegraf');
const sheetsService = require('../../services/sheets.service');
const CalculatorService = require('../../services/calculator.service');
const locationTrackerService = require('../../services/locationTracker.service');
const anomalyDetectorService = require('../../services/anomalyDetector.service');
const Keyboards = require('../keyboards/buttons');
const Config = require('../../config');
const logger = require('../../utils/logger');

// Temporary state: users awaiting location for check-in
// Map<userId, { requestTime, user, checkInData }>
const awaitingLocationForCheckIn = new Map();

// Temporary state: users awaiting location for checkout/departure
// Map<userId, { requestTime, user, checkoutTime, departureType, workTimeData }>
const awaitingLocationForCheckout = new Map();

/**
 * Get user data or prompt for registration
 */
async function getUserOrPromptRegistration(ctx) {
  const telegramId = ctx.from.id;
  const user = await sheetsService.findEmployeeByTelegramId(telegramId);

  if (!user) {
    await ctx.reply(
      '❌ К сожалению, Вы не зарегистрированы в системе.\n' +
      'Пожалуйста, используйте команду /start для регистрации.'
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
 * Process arrival check-in with location
 * @param {Object} ctx - Telegraf context
 * @param {Object} user - User object
 * @param {Object} location - Location object
 * @returns {Promise<void>}
 */
async function processArrivalWithLocation(ctx, user, location) {
  try {
    const now = moment.tz(Config.TIMEZONE);

    // Start tracking session
    const trackingResult = locationTrackerService.startTracking(
      user.telegramId,
      {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.horizontal_accuracy || location.accuracy || null
      },
      user.nameFull
    );

    if (!trackingResult.success) {
      logger.error(`Failed to start tracking for ${user.nameFull}: ${trackingResult.error}`);
      // Continue with check-in anyway
    }

    // Check for initial location anomaly
    if (trackingResult.hasInitialAnomaly) {
      const anomaly = trackingResult.initialAnomaly;
      logger.warn(`Initial location anomaly for ${user.nameFull}: ${anomaly.type}`);

      // If CRITICAL (wrong location), reject check-in
      if (anomaly.severity === 'CRITICAL') {
        await ctx.reply(
          `❌ К сожалению, отметка прихода не выполнена: ${anomaly.description}\n\n` +
          `Пожалуйста, убедитесь, что Вы находитесь в офисе перед отметкой прихода.`,
          Keyboards.getMainMenu(ctx.from.id)
        );
        // Stop tracking
        locationTrackerService.forceStopTracking(user.telegramId);
        return;
      }
    }

    // Parse work schedule
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.reply(
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if Sunday OR (Saturday AND user doesn't work on Saturday) - encourage work
    const isSunday = now.day() === 0;
    const isSaturday = now.day() === 6;
    const isDayOff = isSunday || (isSaturday && user.doNotWorkSaturday);

    // Calculate lateness
    const { latenessMinutes, status: latenessStatus } = CalculatorService.calculateLateness(
      workTime.start,
      now
    );

    let responseText = `✅ **Приход отмечен! Добро пожаловать на работу.**\n\n`;
    let eventType = 'ARRIVAL';
    let details = 'on_time';
    let ratingImpact = 0.0;

    if (isDayOff) {
      const dayName = isSunday ? 'воскресенье' : 'субботу';
      responseText += `🌟 Отличная работа! Вы работаете в ${dayName}!\n`;
      responseText += `💪 Такое усердие заслуживает уважения!\n`;
      details = isSunday ? 'sunday_work' : 'saturday_work';
      ratingImpact = 1.0; // Bonus point for working on day off
    } else if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!`;
      details = 'on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
      if (status.lateNotified) {
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (Вы предупредили)\n`;
        details = `late_notified, ${latenessMinutes}min`;
        ratingImpact = CalculatorService.calculateRatingImpact('LATE_NOTIFIED');
      } else {
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (без предупреждения)\n`;
        details = `late_silent, ${latenessMinutes}min`;
        ratingImpact = CalculatorService.calculateRatingImpact('LATE_SILENT');
      }

      const penaltyMinutes = CalculatorService.calculatePenaltyTime(latenessMinutes);
      const requiredEnd = CalculatorService.calculateRequiredEndTime(workTime.end, penaltyMinutes);
      responseText += `⏳ Необходимо отработать дополнительно: ${CalculatorService.formatTimeDiff(penaltyMinutes)}\n`;
      responseText += `⏰ Уход не раньше: ${requiredEnd.format('HH:mm')}`;

      if (!status.lateNotified) {
        await sheetsService.logEvent(
          user.telegramId,
          user.nameFull,
          'LATE_SILENT',
          `${latenessMinutes} min, penalty=${penaltyMinutes} min`,
          ratingImpact
        );
        ratingImpact = 0.0;
      }
    }

    // Log arrival event
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      eventType,
      details,
      ratingImpact
    );

    // Store location data
    await sheetsService.updateArrivalLocation(
      user.telegramId,
      { latitude: location.latitude, longitude: location.longitude },
      location.horizontal_accuracy || location.accuracy || null
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

    responseText += `\n\n📊 Баллы за сегодня: ${todayPoint} ${pointEmoji}`;

    // Don't mention tracking here - already mentioned in previous message
    // responseText += `\n\n📍 Location tracking active for ${Config.TRACKING_DURATION_MINUTES} minutes...`;

    await ctx.reply(responseText, {
      ...Keyboards.getMainMenu(ctx.from.id),
      parse_mode: 'Markdown'
    });
    logger.info(`Arrival with location logged for ${user.nameFull}: ${details}`);

  } catch (error) {
    logger.error(`Error processing arrival with location: ${error.message}`);
    await ctx.reply(
      '❌ К сожалению, произошла ошибка при отметке прихода. Пожалуйста, попробуйте снова или обратитесь к администратору.',
      Keyboards.getMainMenu(ctx.from.id)
    );
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
        `Пожалуйста, сначала отметьте возвращение кнопкой "↩️ Вернулся".`,
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
        `ℹ️ Вы уже отметили отсутствие на сегодня. К сожалению, отметить приход в офис сегодня уже невозможно. Спасибо за понимание! 🙏`,
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
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
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

    // === LOCATION TRACKING INTEGRATION ===
    // If location tracking is enabled, request live location
    if (Config.ENABLE_LOCATION_TRACKING) {
      // Store check-in state for this user
      awaitingLocationForCheckIn.set(user.telegramId, {
        requestTime: Date.now(),
        user: user,
        checkInTime: now
      });

      logger.info(`📍 Requesting location from ${user.nameFull} (${user.telegramId}) for check-in`);

      // Request live location with keyboard - keep original format
      const keyboard = {
        keyboard: [[{ text: '📍 Отправить местоположение', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      };

      await ctx.reply(
        `⚠️ ВАЖНО: Пожалуйста, будьте добры, поделитесь ВАШИМ ТЕКУЩИМ МЕСТОПОЛОЖЕНИЕМ ОНЛАЙН\n\n` +
        `📍 Нажмите кнопку ниже и выберите:\n` +
        `"Поделиться моим местоположением онлайн" (15 минут или дольше)\n\n` +
        `❌ Обратите внимание: статическое местоположение будет отклонено`,
        keyboard
      );

      // Set timeout to clean up if user doesn't send location
      setTimeout(() => {
        if (awaitingLocationForCheckIn.has(user.telegramId)) {
          awaitingLocationForCheckIn.delete(user.telegramId);
          logger.warn(`Location request timeout for user ${user.telegramId}`);
        }
      }, 5 * 60 * 1000); // 5 minutes timeout

      return; // Exit here, will resume when location is received
    }

    // === FALLBACK: LOCATION TRACKING DISABLED ===
    // Continue with normal check-in (without location)

    // Check if Sunday OR (Saturday AND user doesn't work on Saturday) - encourage work
    const isSunday = now.day() === 0;
    const isSaturday = now.day() === 6;
    const isDayOff = isSunday || (isSaturday && user.doNotWorkSaturday);

    // Calculate lateness
    const { latenessMinutes, status: latenessStatus } = CalculatorService.calculateLateness(
      workTime.start,
      now
    );

    let responseText = `✅ Отмечен приход: ${now.format('HH:mm')}\n`;
    let eventType = 'ARRIVAL';
    let details = 'on_time';
    let ratingImpact = 0.0;

    if (isDayOff) {
      const dayName = isSunday ? 'воскресенье' : 'субботу';
      responseText += `🌟 Отличная работа! Вы работаете в ${dayName}!\n`;
      responseText += `💪 Такое усердие заслуживает уважения!`;
      details = isSunday ? 'sunday_work' : 'saturday_work';
      ratingImpact = 1.0; // Bonus point for working on day off
    } else if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!`;
      details = 'on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
      // Check if user notified about being late
      if (status.lateNotified) {
        // User used late notification, less penalty
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (Вы предупредили)\n`;
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
        'ℹ️ Пожалуйста, сначала отметьте свой приход на работу с помощью \'+\' или кнопки "✅ Пришёл". Спасибо!',
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
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // === LOCATION TRACKING INTEGRATION FOR DEPARTURE WITH MESSAGE ===
    // If location tracking is enabled, request live location
    if (Config.ENABLE_LOCATION_TRACKING) {
      // Store checkout state for this user
      awaitingLocationForCheckout.set(user.telegramId.toString(), {
        requestTime: Date.now(),
        user: user,
        checkoutTime: now,
        departureType: 'message',
        message: departureMessage,
        workTimeData: {
          workTime: workTime,
          arrivalTime: status.arrivalTime
        }
      });

      logger.info(`📍 Requesting location from ${user.nameFull} (${user.telegramId}) for departure with message`);

      const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
      const trackingTime = trackingSeconds < 60
        ? `${trackingSeconds} секунд`
        : `${Math.round(trackingSeconds / 60)} минут`;

      await ctx.reply(
        `📍 **ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ МЕСТОПОЛОЖЕНИЯ**\n\n` +
        `Для подтверждения ухода, пожалуйста, поделитесь ВАШИМ ТЕКУЩИМ МЕСТОПОЛОЖЕНИЕМ ОНЛАЙН.\n\n` +
        `⚠️ **ВАЖНО:**\n` +
        `1️⃣ Нажмите кнопку "📎" (вложение)\n` +
        `2️⃣ Выберите "Геолокация"\n` +
        `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
        `4️⃣ Установите время на 15 минут или больше\n\n` +
        `📍 Проверка займет примерно ${trackingTime}.\n` +
        `💬 Ваше сообщение: "${departureMessage}"\n\n` +
        `❌ Пожалуйста, НЕ отправляйте "Текущее местоположение" - оно будет отклонено!`,
        { parse_mode: 'Markdown' }
      );

      // Set timeout to clean up if user doesn't send location
      setTimeout(() => {
        if (awaitingLocationForCheckout.has(user.telegramId.toString())) {
          awaitingLocationForCheckout.delete(user.telegramId.toString());
          logger.warn(`Checkout location request timeout for user ${user.telegramId}`);
        }
      }, 5 * 60 * 1000); // 5 minutes timeout

      return; // Exit here - wait for location
    }

    // === FALLBACK: LOCATION TRACKING DISABLED ===
    // Continue with normal departure (without location)

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
        'ℹ️ Вы отметили отсутствие на сегодня. Отдыхайте и набирайтесь сил! 😴 До встречи!',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    if (!status.hasArrived) {
      await ctx.reply(
        'ℹ️ Пожалуйста, сначала отметьте свой приход на работу с помощью \'+\' или кнопки \'✅ Пришёл\'. Спасибо за понимание!',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Check if leaving early or on time
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    // FIX: Allow departure even after work time ends (removed blocking check)
    // Users should always be able to log their departure for proper tracking

    if (!workTime) {
      await ctx.reply(
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // === CHECK FOR EARLY DEPARTURE FIRST ===
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

    // If person worked full hours, treat as normal departure regardless of scheduled end time
    if (!workedFullHours && isLeavingEarly) {
      // Did NOT work full hours and leaving early - ask for reason
      const remainingMinutes = requiredWorkMinutes - actualWorkedMinutes;

      await ctx.reply(
        `⚠️ Вы не отработали требуемое количество часов!\n\n` +
        `Требуется: ${CalculatorService.formatTimeDiff(requiredWorkMinutes)}\n` +
        `Вы отработали: ${CalculatorService.formatTimeDiff(actualWorkedMinutes)}\n` +
        `Осталось: ${CalculatorService.formatTimeDiff(remainingMinutes)}\n\n` +
        `📝 Пожалуйста, укажите причину раннего ухода:`,
        Keyboards.getEarlyDepartureReasonKeyboard()
      );
      return;
    } else {
      // Leaving on time or later - REQUEST LOCATION if enabled
      if (Config.ENABLE_LOCATION_TRACKING) {
        // Store checkout state
        awaitingLocationForCheckout.set(user.telegramId.toString(), {
          requestTime: Date.now(),
          user: user,
          checkoutTime: now,
          departureType: 'button',
          workTimeData: {
            workTime: workTime,
            arrivalTime: status.arrivalTime
          }
        });

        const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
        const trackingTime = trackingSeconds < 60
          ? `${trackingSeconds} seconds`
          : `${Math.round(trackingSeconds / 60)} minute(s)`;

        await ctx.reply(
          `📍 **ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ МЕСТОПОЛОЖЕНИЯ**\n\n` +
          `Для подтверждения ухода, пожалуйста, поделитесь ВАШИМ ТЕКУЩИМ МЕСТОПОЛОЖЕНИЕМ ОНЛАЙН.\n\n` +
          `⚠️ **ВАЖНО:**\n` +
          `1️⃣ Нажмите кнопку "📎" (вложение)\n` +
          `2️⃣ Выберите "Геолокация"\n` +
          `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
          `4️⃣ Установите время на 15 минут или больше\n\n` +
          `📍 Проверка займет примерно ${trackingTime}.\n\n` +
          `❌ Пожалуйста, НЕ отправляйте "Текущее местоположение" - оно будет отклонено!`,
          { parse_mode: 'Markdown' }
        );

        // Set timeout - 5 minutes
        setTimeout(() => {
          if (awaitingLocationForCheckout.has(user.telegramId.toString())) {
            awaitingLocationForCheckout.delete(user.telegramId.toString());
            logger.warn(`Checkout location request timeout for user ${user.telegramId}`);
          }
        }, 5 * 60 * 1000);

        return; // Exit here - wait for location
      }

      // FALLBACK: Location tracking disabled - process departure without location
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

    // Check if Sunday OR (Saturday AND user doesn't work on Saturday) - encourage rest
    const now = moment.tz(Config.TIMEZONE);
    const isSunday = now.day() === 0;
    const isSaturday = now.day() === 6;
    const isDayOff = isSunday || (isSaturday && user.doNotWorkSaturday);

    if (isDayOff) {
      const dayName = isSunday ? 'воскресенье' : 'суббота';
      await ctx.reply(
        `🌞 Сегодня ${dayName}, отдыхайте!\n\n` +
        'Не нужно отмечать опоздания в выходной день.\n' +
        'Хорошего отдыха! 😊',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    const workTime = CalculatorService.parseWorkTime(user.workTime);

    if (!workTime) {
      await ctx.reply(
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Removed: Allow late notification even after work hours
    // Users might need to report late arrival retrospectively

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
            '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
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
          '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
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
      const now = moment.tz(Config.TIMEZONE);
      const workTime = CalculatorService.parseWorkTime(user.workTime);

      // REQUEST LOCATION FOR EARLY DEPARTURE if location tracking enabled
      if (Config.ENABLE_LOCATION_TRACKING && workTime) {
        // Store checkout state with early departure reason
        awaitingLocationForCheckout.set(user.telegramId.toString(), {
          requestTime: Date.now(),
          user: user,
          checkoutTime: now,
          departureType: 'early_reason',
          message: reason,
          workTimeData: {
            workTime: workTime,
            arrivalTime: status.arrivalTime
          }
        });

        const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
        const trackingTime = trackingSeconds < 60
          ? `${trackingSeconds} секунд`
          : `${Math.round(trackingSeconds / 60)} минут`;

        await ctx.reply(
          `📍 **ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ МЕСТОПОЛОЖЕНИЯ**\n\n` +
          `Для подтверждения раннего ухода, пожалуйста, будьте добры, поделитесь ВАШИМ ТЕКУЩИМ МЕСТОПОЛОЖЕНИЕМ ОНЛАЙН.\n\n` +
          `⚠️ **ВАЖНО:**\n` +
          `1️⃣ Нажмите кнопку "📎" (вложение)\n` +
          `2️⃣ Выберите "Геолокация"\n` +
          `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
          `4️⃣ Установите время на 15 минут или больше\n\n` +
          `📍 Проверка займет примерно ${trackingTime}.\n` +
          `💬 Причина: "${reason}"\n\n` +
          `❌ Пожалуйста, НЕ отправляйте "Текущее местоположение" - оно будет отклонено!`,
          { parse_mode: 'Markdown' }
        );

        // Set timeout to clean up if user doesn't send location
        setTimeout(() => {
          if (awaitingLocationForCheckout.has(user.telegramId.toString())) {
            awaitingLocationForCheckout.delete(user.telegramId.toString());
            logger.warn(`Checkout location request timeout for user ${user.telegramId}`);
          }
        }, 5 * 60 * 1000); // 5 minutes timeout

        delete ctx.session.awaitingEarlyDepartureReason;
        return; // Exit here - wait for location
      }

      // FALLBACK: Location tracking disabled - process departure without location
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

    // Check if Sunday OR (Saturday AND user doesn't work on Saturday) - encourage rest
    const now = moment.tz(Config.TIMEZONE);
    const isSunday = now.day() === 0;
    const isSaturday = now.day() === 6;
    const isDayOff = isSunday || (isSaturday && user.doNotWorkSaturday);

    if (isDayOff) {
      const dayName = isSunday ? 'воскресенье' : 'суббота';
      await ctx.reply(
        `🌞 Сегодня ${dayName}, отдыхайте!\n\n` +
        'Не нужно отмечать отсутствие в выходной день.\n' +
        'Хорошего отдыха! 😊',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    const workTime = CalculatorService.parseWorkTime(user.workTime);

    if (!workTime) {
      await ctx.reply(
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Removed: Allow absence marking even after work hours
    // Users might need to mark absence retrospectively

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
      await ctx.editMessageText('📝 Напишите причину отсутствия:');
      await ctx.reply('📝 Пожалуйста, укажите причину:', Keyboards.getTextInput('Болею / Личные дела...'));
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
      await ctx.editMessageText('📝 Напишите причину раннего ухода:');
      await ctx.reply('📝 Пожалуйста, укажите причину:', Keyboards.getTextInput('Семья / Здоровье...'));
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
    const now = moment.tz(Config.TIMEZONE);
    const workTime = CalculatorService.parseWorkTime(user.workTime);

    // REQUEST LOCATION FOR EARLY DEPARTURE if location tracking enabled
    if (Config.ENABLE_LOCATION_TRACKING && workTime) {
      // Store checkout state with early departure reason
      awaitingLocationForCheckout.set(user.telegramId.toString(), {
        requestTime: Date.now(),
        user: user,
        checkoutTime: now,
        departureType: 'early_reason',
        message: reasonText,
        workTimeData: {
          workTime: workTime,
          arrivalTime: status.arrivalTime
        }
      });

      const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
      const trackingTime = trackingSeconds < 60
        ? `${trackingSeconds} секунд`
        : `${Math.round(trackingSeconds / 60)} минут`;

      await ctx.editMessageText(
        `✅ Причина: ${reasonText}\n\n` +
        `📍 Теперь подтвердите ваше местоположение.`
      );

      await ctx.reply(
        `📍 **ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ МЕСТОПОЛОЖЕНИЯ**\n\n` +
        `Для подтверждения раннего ухода, пожалуйста, поделитесь ВАШИМ МЕСТОПОЛОЖЕНИЕМ ОНЛАЙН.\n\n` +
        `⚠️ **ВАЖНО:**\n` +
        `1️⃣ Нажмите кнопку "📎" (вложение)\n` +
        `2️⃣ Выберите "Геолокация"\n` +
        `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
        `4️⃣ Установите время на 15 минут или больше\n\n` +
        `📍 Проверка займет примерно ${trackingTime}.\n` +
        `💬 Причина: "${reasonText}"\n\n` +
        `❌ Пожалуйста, НЕ отправляйте "Текущее местоположение" - оно будет отклонено!`,
        { parse_mode: 'Markdown' }
      );

      // Set timeout to clean up if user doesn't send location
      setTimeout(() => {
        if (awaitingLocationForCheckout.has(user.telegramId.toString())) {
          awaitingLocationForCheckout.delete(user.telegramId.toString());
          logger.warn(`Checkout location request timeout for user ${user.telegramId}`);
        }
      }, 5 * 60 * 1000); // 5 minutes timeout

      return; // Exit here - wait for location
    }

    // FALLBACK: Location tracking disabled - process departure without location
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
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
      return;
    }

    // Removed: Allow working longer even after official end time
    // Users might stay late and need to log extra hours

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
            '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
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

  // Handle overnight worker "still working" button
  bot.action(/^overnight_still_working:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) return;

    const tomorrow = ctx.match[1]; // Date in YYYY-MM-DD format

    try {
      const now = moment.tz(Config.TIMEZONE);
      const currentTime = now.format('HH:mm');

      // Initialize tomorrow's sheet if needed
      await sheetsService.initializeDailySheet(tomorrow);

      // Get tomorrow's sheet
      const worksheet = await sheetsService.getWorksheet(tomorrow);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find employee row
      const employeeRow = rows.find(row => {
        const rowTelegramId = (row.get('TelegramId') || '').toString().trim();
        return rowTelegramId === user.telegramId.toString();
      });

      if (!employeeRow) {
        await ctx.editMessageText(
          `❌ Ошибка: не удалось найти вас в листе ${tomorrow}\n\n` +
          `Попробуйте отметить приход обычным способом.`
        );
        return;
      }

      // Mark arrival for the new day
      employeeRow.set('When come', currentTime);
      employeeRow.set('Came on time', 'true'); // Coming overnight is considered on time
      await employeeRow.save();

      // Log event
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'OVERNIGHT_CONTINUATION',
        `Продолжение работы с предыдущего дня на ${tomorrow}`,
        0.5 // Bonus for overnight work
      );

      const formattedDate = moment.tz(tomorrow, 'YYYY-MM-DD', Config.TIMEZONE).format('DD.MM.YYYY');

      await ctx.editMessageText(
        `✅ Приход отмечен для ${formattedDate}!\n\n` +
        `⏰ Время: ${currentTime}\n` +
        `🌙 Продолжение ночной смены\n` +
        `📊 Бонус: +0.5 балла\n\n` +
        `Не забудьте отметить уход, когда закончите работу!`
      );

      await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

      logger.info(`Overnight worker ${user.nameFull} marked arrival for ${tomorrow} at ${currentTime}`);
    } catch (error) {
      await ctx.reply(`❌ Ошибка: ${error.message}`, Keyboards.getMainMenu(ctx.from.id));
      logger.error(`Error in overnight_still_working: ${error.message}`);
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
      await ctx.editMessageText('📝 Введите свою причину:');
      await ctx.reply('📝 Пожалуйста, укажите причину:', Keyboards.getTextInput('Обед / Врач...'));
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

  // AUTO-DEPARTURE: Handle "Depart Now" button
  bot.action('auto_depart_now', async (ctx) => {
    const user = await getUserOrPromptRegistration(ctx);
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      // Check if user has already departed
      const status = await sheetsService.getUserStatusToday(user.telegramId);
      if (status.hasDeparted) {
        await ctx.answerCbQuery('❌ Вы уже отметили уход');
        return;
      }

      if (!status.hasArrived) {
        await ctx.answerCbQuery('❌ Вы не отмечали приход сегодня');
        return;
      }

      // Get the user's row
      const worksheet = await sheetsService.getWorksheet(today);
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

      // Mark departure
      const departureTime = now.format('HH:mm');
      const whenCome = employeeRow.get('When come') || '';

      employeeRow.set('Leave time', departureTime);

      // Calculate hours worked
      const arrivalTime = moment.tz(`${today} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
      const minutesWorked = now.diff(arrivalTime, 'minutes');
      const hoursWorked = minutesWorked / 60;
      employeeRow.set('Hours worked', hoursWorked.toFixed(2));

      await employeeRow.save();

      // Log the departure event
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'DEPARTURE',
        'Уход отмечен через кнопку авто-ухода',
        0
      );

      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `✅ Уход успешно отмечен!\n\n` +
        `🕐 Время ухода: ${departureTime}\n` +
        `⏱ Отработано: ${CalculatorService.formatTimeDiff(minutesWorked)}\n\n` +
        `Хорошего вечера! 👋`
      );

      logger.info(`${user.nameFull} marked departure via auto-depart button at ${departureTime}`);
    } catch (error) {
      await ctx.answerCbQuery('❌ Ошибка');
      logger.error(`Error handling auto-depart now: ${error.message}`);
    }
  });

  // AUTO-DEPARTURE: Handle "Extend Work" button
  bot.action(/extend_work:(\d+)/, async (ctx) => {
    const extendMinutes = parseInt(ctx.match[1]);

    const user = await getUserOrPromptRegistration(ctx);
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    try {
      const now = moment.tz(Config.TIMEZONE);
      const today = now.format('YYYY-MM-DD');

      // Check if user has already departed
      const status = await sheetsService.getUserStatusToday(user.telegramId);
      if (status.hasDeparted) {
        await ctx.answerCbQuery('❌ Вы уже отметили уход');
        return;
      }

      if (!status.hasArrived) {
        await ctx.answerCbQuery('❌ Вы не отмечали приход сегодня');
        return;
      }

      // Get the user's row
      const worksheet = await sheetsService.getWorksheet(today);
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

      // Get current extension and add to it
      const currentExtension = parseInt(employeeRow.get('work_extension_minutes') || '0');
      const newExtension = currentExtension + extendMinutes;

      // Update work extension
      employeeRow.set('work_extension_minutes', newExtension.toString());
      // Reset warning sent flag so user gets a new warning later
      employeeRow.set('auto_departure_warning_sent', 'false');

      await employeeRow.save();

      const hours = Math.floor(extendMinutes / 60);
      const mins = extendMinutes % 60;
      const extendText = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `✅ Рабочее время продлено на ${extendText}\n\n` +
        `Вы получите новое напоминание перед окончанием продленного времени.\n\n` +
        `Не забудьте отметить уход, когда закончите работу!`
      );

      logger.info(`${user.nameFull} extended work by ${extendMinutes} min (total extension: ${newExtension} min)`);

      // Log the extension event
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        'WORK_EXTENDED',
        `Работа продлена на ${extendText}`,
        0
      );
    } catch (error) {
      await ctx.answerCbQuery('❌ Ошибка');
      logger.error(`Error extending work time: ${error.message}`);
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
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.',
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

  /**
   * Process departure/checkout with location verification
   * @param {Object} ctx - Telegram context
   * @param {Object} user - User object
   * @param {Object} location - Location object
   * @param {Object} checkoutState - Checkout state with workTimeData
   * @returns {Promise<void>}
   */
  async function processDepartureWithLocation(ctx, user, location, checkoutState) {
    try {
      const now = moment.tz(Config.TIMEZONE);

      // Start tracking session for departure
      const trackingResult = locationTrackerService.startTracking(
        user.telegramId,
        {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.horizontal_accuracy || location.accuracy || null
        },
        user.nameFull
      );

      if (!trackingResult.success) {
        logger.error(`Failed to start tracking for ${user.nameFull} departure: ${trackingResult.error}`);
        // Continue with checkout anyway
      }

      // Check for initial location anomaly (outside geofence = fraud)
      let isFraudulent = false;
      let fraudReason = '';

      if (trackingResult.hasInitialAnomaly) {
        const anomaly = trackingResult.initialAnomaly;
        logger.warn(`Initial departure location anomaly for ${user.nameFull}: ${anomaly.type}`);

        // If CRITICAL (wrong location - outside geofence), flag as fraud
        if (anomaly.severity === 'CRITICAL' && anomaly.type === 'WRONG_LOCATION') {
          isFraudulent = true;
          fraudReason = anomaly.description;

          logger.error(`🚨 FRAUD DETECTED: ${user.nameFull} trying to checkout from outside office!`);
          logger.error(`   Reason: ${fraudReason}`);

          // Log fraud event
          await sheetsService.logEvent(
            user.telegramId,
            user.nameFull,
            'CHECKOUT_FRAUD',
            `Location outside office: ${fraudReason}`,
            -2.0 // Heavy penalty for fraud attempt
          );

          // Notify admins about fraudulent checkout attempt
          const adminIds = Config.ADMIN_TELEGRAM_IDS;
          const alertMessage =
            `🚨 **FRAUD ALERT: Suspicious Checkout**\n\n` +
            `👤 User: ${user.nameFull}\n` +
            `📱 Telegram ID: ${user.telegramId}\n` +
            `⚠️ Reason: ${fraudReason}\n` +
            `📍 Location: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}\n` +
            `🕐 Time: ${now.format('HH:mm:ss')}`;

          for (const adminId of adminIds) {
            try {
              await ctx.telegram.sendMessage(adminId, alertMessage, { parse_mode: 'Markdown' });
            } catch (error) {
              logger.error(`Failed to notify admin ${adminId}: ${error.message}`);
            }
          }

          // Reject the checkout
          await ctx.reply(
            `❌ **Checkout REJECTED**\n\n` +
            `${fraudReason}\n\n` +
            `⚠️ This incident has been logged and administrators have been notified.\n\n` +
            `Please ensure you are at the office location before checking out.`,
            Keyboards.getMainMenu(ctx.from.id)
          );

          // Stop tracking
          locationTrackerService.forceStopTracking(user.telegramId);
          return;
        }
      }

      // Get user's work time from checkout state
      const workTime = checkoutState.workTimeData.workTime;
      const arrivalTime = checkoutState.workTimeData.arrivalTime;
      const checkoutTime = checkoutState.checkoutTime;

      // Parse message if departure was via message or early reason
      let departureMessage = '';
      if (checkoutState.departureType === 'message' || checkoutState.departureType === 'early_reason') {
        departureMessage = checkoutState.message || '';
      }

      // Calculate worked hours
      const workedMinutes = checkoutTime.diff(moment.tz(arrivalTime, 'HH:mm', Config.TIMEZONE), 'minutes');

      // Check if leaving early
      const scheduledEnd = workTime.end;
      const isEarly = checkoutTime.isBefore(scheduledEnd);
      const earlyMinutes = isEarly ? scheduledEnd.diff(checkoutTime, 'minutes') : 0;

      // Calculate required work hours (scheduled shift duration)
      const requiredWorkMinutes = workTime.end.diff(workTime.start, 'minutes');
      const workedFullHours = workedMinutes >= requiredWorkMinutes;

      let responseText = `✅ **Уход отмечен!**\n\n`;
      let eventType = 'DEPARTURE';
      let details = departureMessage ? `message: ${departureMessage}` : 'normal';
      let ratingImpact = 0.0;

      if (isEarly && !workedFullHours) {
        // Leaving early AND did not work full required hours - apply penalties
        responseText += `⚠️ Ранний уход: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;
        details = `early_${earlyMinutes}min` + (departureMessage ? `, msg: ${departureMessage}` : '');

        // Check if message was provided
        if (Config.REQUIRE_DEPARTURE_MESSAGE && !departureMessage) {
          ratingImpact = CalculatorService.calculateRatingImpact('LEFT_WITHOUT_MESSAGE');
          responseText += `⚠️ Ушли рано без сообщения: ${ratingImpact} баллов\n`;
        } else if (departureMessage) {
          ratingImpact = CalculatorService.calculateRatingImpact('EARLY_DEPARTURE');
          responseText += `📝 Указана причина: ${departureMessage}\n`;
        }
      } else {
        // Either left on time OR worked full required hours - treat as normal departure
        responseText += `✅ Ушли вовремя или позже\n`;
        details = 'normal';
      }

      responseText += `\n⏱️ Отработано: ${CalculatorService.formatTimeDiff(workedMinutes)}\n`;
      responseText += `📍 Местоположение подтверждено`;

      // Log departure event
      await sheetsService.logEvent(
        user.telegramId,
        user.nameFull,
        eventType,
        details,
        ratingImpact
      );

      // Store departure location data
      await sheetsService.updateDepartureLocation(
        user.telegramId,
        { latitude: location.latitude, longitude: location.longitude },
        location.horizontal_accuracy || location.accuracy || null
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

      responseText += `\n\n📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`;
      responseText += `\n\n👋 Хорошего вечера!`;

      await ctx.reply(responseText, {
        ...Keyboards.getMainMenu(ctx.from.id),
        parse_mode: 'Markdown'
      });

      logger.info(`Departure with location logged for ${user.nameFull}: ${details}`);

    } catch (error) {
      logger.error(`Error processing departure with location: ${error.message}`);
      await ctx.reply(
        '❌ Ошибка при регистрации ухода. Пожалуйста, попробуйте снова или обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
    }
  }

  /**
   * Handle checkout/departure location processing
   * @param {Object} ctx - Telegram context
   * @param {string} userId - User's Telegram ID
   * @param {Object} location - Location object from Telegram
   */
  async function handleCheckoutLocation(ctx, userId, location) {
    try {
      // Get checkout state
      const checkoutState = awaitingLocationForCheckout.get(userId);
      const user = checkoutState.user;

      // Check if this is LIVE location or static location
      const isLiveLocation = ctx.message.location.live_period !== undefined;

      logger.info(`📍 Received checkout location from ${user.nameFull} (${userId})`);
      logger.info(`   Location type: ${isLiveLocation ? 'LIVE ✅' : 'STATIC ❌'}`);

      // ONLY accept LIVE location - REJECT static location
      if (!isLiveLocation) {
        logger.warn(`❌ User ${user.nameFull} sent STATIC location for checkout - REJECTED`);

        // Clean up the awaiting state
        awaitingLocationForCheckout.delete(userId);

        await ctx.reply(
          `❌ **К СОЖАЛЕНИЮ, ЭТО НЕ ОНЛАЙН МЕСТОПОЛОЖЕНИЕ**\n\n` +
          `⚠️ Пожалуйста, отправьте местоположение ОНЛАЙН, а не статическое.\n\n` +
          `Попробуйте ещё раз:\n` +
          `1️⃣ Нажмите кнопку "🚪 Ухожу"\n` +
          `2️⃣ Нажмите "📎" (вложение)\n` +
          `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
          `4️⃣ Установите время на 15 минут или больше\n\n` +
          `Пожалуйста, НЕ выбирайте "Отправить мое текущее местоположение" - это не будет работать!`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        return; // Exit without processing checkout
      }

      // Live location accepted
      logger.info(`✅ User ${user.nameFull} sent LIVE location correctly for checkout`);
      logger.info(`   Live period: ${ctx.message.location.live_period} seconds`);

      const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
      const trackingTime = trackingSeconds < 60
        ? `${trackingSeconds} секунд`
        : `${Math.round(trackingSeconds / 60)} минут`;

      await ctx.reply(
        `✅ Получено живое местоположение!\n\n` +
        `📍 Проверка в процессе...\n` +
        `Это займет около ${trackingTime}.\n\n` +
        `Вы можете использовать другие приложения при необходимости. Обрабатываем отметку ухода...`
      );

      // Clean up the awaiting state
      awaitingLocationForCheckout.delete(userId);

      // Process departure with location
      await processDepartureWithLocation(ctx, user, location, checkoutState);

    } catch (error) {
      logger.error(`Error in checkout location handler: ${error.message}`);
      await ctx.reply(
        '❌ Ошибка при обработке Вашего местоположения. Пожалуйста, попробуйте снова или обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
    }
  }

  // === LOCATION HANDLER FOR CHECK-IN ===
  // Process location when user sends it after requesting check-in
  bot.on('location', async (ctx) => {
    try {
      // IMPORTANT: Convert to string to match the type stored in the map (from Google Sheets)
      const userId = ctx.from.id.toString();
      const location = ctx.message.location;

      logger.debug(`📍 Location received from user ${userId} for check-in`);

      // Check if this user is awaiting location for check-in OR checkout
      const isAwaitingCheckIn = awaitingLocationForCheckIn.has(userId);
      const isAwaitingCheckout = awaitingLocationForCheckout.has(userId);

      if (!isAwaitingCheckIn && !isAwaitingCheckout) {
        // Not awaiting location, ignore (will be handled by main location handler in index.js)
        return;
      }

      // HANDLE CHECKOUT LOCATION
      if (isAwaitingCheckout) {
        await handleCheckoutLocation(ctx, userId, location);
        return;
      }

      // HANDLE CHECK-IN LOCATION (existing logic below)

      // Get check-in state
      const checkInState = awaitingLocationForCheckIn.get(userId);

      // Get user info
      const user = checkInState.user;

      // Check if this is LIVE location or static location
      const isLiveLocation = ctx.message.location.live_period !== undefined;

      logger.info(`📍 Received check-in location from ${user.nameFull} (${userId})`);
      logger.info(`   Location type: ${isLiveLocation ? 'LIVE ✅' : 'STATIC ❌'}`);

      // ONLY accept LIVE location - REJECT static location
      if (!isLiveLocation) {
        logger.warn(`❌ User ${user.nameFull} sent STATIC location - REJECTED`);

        // Clean up the awaiting state
        awaitingLocationForCheckIn.delete(userId);

        await ctx.reply(
          `❌ **К СОЖАЛЕНИЮ, ЭТО НЕ ОНЛАЙН МЕСТОПОЛОЖЕНИЕ**\n\n` +
          `⚠️ Пожалуйста, отправьте местоположение ОНЛАЙН, а не статическое.\n\n` +
          `Попробуйте ещё раз:\n` +
          `1️⃣ Нажмите кнопку "✅ Пришёл"\n` +
          `2️⃣ Нажмите "📎" (вложение)\n` +
          `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
          `4️⃣ Установите время на 15 минут или больше\n\n` +
          `Пожалуйста, НЕ выбирайте "Отправить мое текущее местоположение" - это не будет работать!`,
          Keyboards.getMainMenu(ctx.from.id)
        );

        return; // Exit without processing check-in
      }

      // Live location accepted
      logger.info(`✅ User ${user.nameFull} sent LIVE location correctly`);
      logger.info(`   Live period: ${ctx.message.location.live_period} seconds`);

      const trackingSeconds = Math.round((Config.TRACKING_DURATION_MINUTES || 0.17) * 60);
      const trackingTime = trackingSeconds < 60
        ? `${trackingSeconds} секунд`
        : `${Math.round(trackingSeconds / 60)} минут`;

      await ctx.reply(
        `✅ Онлайн местоположение получено!\n\n` +
        `📍 Идет проверка...\n` +
        `Это займет примерно ${trackingTime}.\n\n` +
        `Вы можете пользоваться другими приложениями. Обрабатываем ваш приход...`
      );

      // Clean up the awaiting state
      awaitingLocationForCheckIn.delete(userId);

      // Process arrival with location
      await processArrivalWithLocation(ctx, user, location);

    } catch (error) {
      logger.error(`Error in check-in location handler: ${error.message}`);
      await ctx.reply(
        '❌ Ошибка при обработке Вашего местоположения. Пожалуйста, попробуйте снова или обратитесь к администратору.',
        Keyboards.getMainMenu(ctx.from.id)
      );
    }
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

  response += `⏰ График работы: ${user.workTime}\n\n`;

  // Check if user is absent today
  if (status.isAbsent) {
    response += `🏠 Сегодня (${now.format('DD.MM.YYYY')}):\n`;
    response += `Вы отметили отсутствие\n\n`;
    response += `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}\n`;
  } else {
    // Parse work schedule to calculate required hours
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    let requiredMinutes = 0;
    let workedMinutes = 0;

    if (workTime) {
      requiredMinutes = workTime.end.diff(workTime.start, 'minutes');
    }

    // Calculate worked minutes if arrived
    if (status.hasArrived && status.arrivalTime) {
      const arrivalMoment = moment.tz(status.arrivalTime, 'HH:mm:ss', Config.TIMEZONE);
      if (status.hasDeparted && status.departureTime) {
        const departureMoment = moment.tz(status.departureTime, 'HH:mm:ss', Config.TIMEZONE);
        workedMinutes = departureMoment.diff(arrivalMoment, 'minutes');
      } else {
        // Still working - calculate current worked time
        workedMinutes = now.diff(arrivalMoment, 'minutes');
      }
    }

    response += `📅 Сегодня (${now.format('DD.MM.YYYY')}):\n`;
    response += `Отработано: ${CalculatorService.formatTimeDiff(workedMinutes)} / ${CalculatorService.formatTimeDiff(requiredMinutes)}\n\n`;
    response += `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}\n`;
  }

  // Add monthly work hours summary
  const monthlyStats = await sheetsService.getMonthlyStats(user.telegramId);

  if (monthlyStats) {
    response += `\n⏱ За месяц (${now.format('MMMM').toUpperCase()}):\n`;
    response += `Отработано: ${CalculatorService.formatTimeDiff(Math.round(monthlyStats.totalHoursWorked * 60))} / ${CalculatorService.formatTimeDiff(Math.round(monthlyStats.totalHoursRequired * 60))}\n`;
    response += `Баллы: ${monthlyStats.totalPoints.toFixed(1)}\n`;
    response += `Рейтинг: ${monthlyStats.rating.toFixed(1)}/10 ${monthlyStats.ratingZone}`;
  } else {
    // Fallback if monthly stats not available
    const balance = await sheetsService.getMonthlyBalance(user.telegramId);
    response += `\n⏱ За месяц:\n`;

    const netBalance = balance.netBalanceMinutes;
    if (netBalance > 0) {
      response += `Баланс: +${CalculatorService.formatTimeDiff(netBalance)}`;
    } else if (netBalance < 0) {
      response += `Баланс: -${CalculatorService.formatTimeDiff(Math.abs(netBalance))}`;
    } else {
      response += `Баланс: 0 (норма)`;
    }
  }

  await ctx.reply(response, Keyboards.getMainMenu(ctx.from.id));
}

module.exports = {
  setupAttendanceHandlers
};
