/**
 * Checkout/departure handler for attendance
 * Handles departures, absences, early departures, and temporary exits
 *
 * Extracted from attendance.handler.js to improve modularity and maintainability.
 * This module contains all checkout-related functionality including:
 * - Regular departures (with/without message)
 * - Absent notifications
 * - Early departure handling
 * - Work time extensions
 * - Temporary exits and returns
 */

const moment = require('moment-timezone');
const { Markup } = require('telegraf');
const sheetsService = require('../../../services/sheets.service');
const CalculatorService = require('../../../services/calculator.service');
const Keyboards = require('../../keyboards/buttons');
const Config = require('../../../config');
const logger = require('../../../utils/logger');
const {
  getUserOrPromptRegistration,
  getMainMenuKeyboard,
  awaitingLocationForCheckout
} = require('./shared');
const { processDepartureWithLocation } = require('./location.handler');

/**
 * Setup checkout/departure handlers
 * @param {Object} bot - Telegraf bot instance
 */
function setupCheckoutHandlers(bot) {
  // ===================================================================
  // DEPARTURE HANDLERS
  // ===================================================================

  // Handle departure with message (e.g., "- Going home")
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
        `👋 Спасибо за уведомление об уходе! 🌟\n\n` +
        `📍 Для подтверждения, пожалуйста, поделитесь вашим текущим местоположением онлайн.\n\n` +
        `🔹 **Пошаговая инструкция:**\n` +
        `1️⃣ Нажмите кнопку "📎" (вложение)\n` +
        `2️⃣ Выберите "Геолокация"\n` +
        `3️⃣ Выберите "Поделиться моим местоположением онлайн"\n` +
        `4️⃣ Установите время на 15 минут или больше\n\n` +
        `⏱ Проверка займет примерно ${trackingTime}.\n` +
        `💬 Ваше сообщение: "${departureMessage}"\n\n` +
        `💡 Совет: Используйте "онлайн-местоположение", а не "текущее местоположение", чтобы система могла отследить ваше перемещение.`,
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
        if (now.isBefore(workTime.end)) {
          // Leaving early!
          const earlyMinutes = workTime.end.diff(now, 'minutes');
          const { penalty, violationType } = CalculatorService.determineEarlyDeparturePenalty(earlyMinutes);

          responseText += `⚠️ Вы уходите раньше требуемого времени (${workTime.end.format('HH:mm')})\n`;
          responseText += `⚠️ Недоработано: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;

          if (penalty === 0) {
            responseText += `📊 Штраф: 0 (менее ${Config.EARLY_MINOR_THRESHOLD} мин)\n`;
          } else {
            responseText += `📊 Штраф за ранний уход: ${penalty} баллов\n`;
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
        // Calculate deficit or surplus
        const deficitMinutes = CalculatorService.calculateEarlyDepartureMinutes(now, workTime.end);
        const surplusMinutes = CalculatorService.calculateOvertimeMinutes(now, workTime.end);

        // Log the day's balance
        await sheetsService.logDayBalance(
          user.telegramId,
          user.nameFull,
          deficitMinutes,
          surplusMinutes,
          0
        );

        // Add balance info to response
        if (deficitMinutes > 0) {
          responseText += `\n⏱ Сегодня недоработано: ${CalculatorService.formatTimeDiff(deficitMinutes)}`;
        } else if (surplusMinutes > 0) {
          responseText += `\n⏱ Сегодня переработано: ${CalculatorService.formatTimeDiff(surplusMinutes)}`;
        }
      } catch (error) {
        logger.error(`Error calculating day balance: ${error.message}`);
      }
    }

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on 5-zone rating
    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

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

    // Check if person worked the full required hours
    const workedFullHours = actualWorkedMinutes >= requiredWorkMinutes;

    // Check if leaving before official end time
    const isLeavingEarly = now.isBefore(workTime.end);

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

      const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

      await ctx.reply(
        `✅ Отмечен уход: ${now.format('HH:mm')}\n\n` +
        `👋 Хорошего отдыха! До завтра! 😊\n\n` +
        `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`,
        Keyboards.getMainMenu(ctx.from.id)
      );

      logger.info(`On-time departure logged for ${user.nameFull}`);
    }
  });

  // ===================================================================
  // ABSENT HANDLERS
  // ===================================================================

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

    // Map reason codes to text and caring messages
    const reasons = {
      'sick': {
        text: 'Болею',
        message: '🤒 Выздоравливайте скорее!\n\n💊 Берегите себя, отдыхайте и не волнуйтесь о работе.\n❤️ Желаем вам скорейшего выздоровления!'
      },
      'family': {
        text: 'Семейные обстоятельства',
        message: '👨‍👩‍👧 Семья - самое важное!\n\n❤️ Надеемся, что у всех всё хорошо.\n🤗 Берегите друг друга, мы вас ждём!'
      },
      'business_trip': {
        text: 'Командировка',
        message: '✈️ Удачной командировки!\n\n🌟 Желаем продуктивной поездки и новых достижений.\n🔙 До скорой встречи в офисе!'
      },
      'personal': {
        text: 'Личные дела',
        message: '🧭 Хорошего дня!\n\n🌟 Иногда нужно время для себя.\n😊 Надеемся скоро увидеть вас!'
      }
    };

    const reason = reasons[reasonCode] || { text: 'Не указана', message: '✅ Хорошего дня!' };
    const reasonText = reason.text;
    const caringMessage = reason.message;

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
      `📋 Причина: ${reasonText}\n\n` +
      `${caringMessage}`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Absence notification from ${user.nameFull}: ${reasonText}`);
  });

  // ===================================================================
  // EARLY DEPARTURE HANDLERS
  // ===================================================================

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

    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

    await ctx.editMessageText(
      `✅ Отмечен уход: ${now.format('HH:mm')}\n` +
      `Причина раннего ухода: ${reasonText}\n\n` +
      `⚠️ Ранний уход зафиксирован.\n\n` +
      `📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`
    );

    await ctx.reply('🏠 Главное меню:', Keyboards.getMainMenu(ctx.from.id));

    logger.info(`Early departure logged for ${user.nameFull}: ${reasonText}`);
  });

  // ===================================================================
  // WORK EXTENSION HANDLERS
  // ===================================================================

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

    // Check if user can extend (15 min before work end)
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

    // FIX: Update work_extension_minutes in the Google Sheet using cached method
    const now = moment.tz(Config.TIMEZONE);
    const today = now.format('YYYY-MM-DD');

    try {
      // Use cached method - reduces API calls from 4 to 1
      const employeeRow = await sheetsService.getCachedDailyRow(today, user.telegramId.toString());

      if (employeeRow) {
        // Get current extension and add to it
        const currentExtension = parseInt(employeeRow.get('work_extension_minutes') || '0');
        const newExtension = currentExtension + durationMinutes;

        // Update work extension
        employeeRow.set('work_extension_minutes', newExtension.toString());
        // Reset warning flags so user gets new warnings based on extended time
        employeeRow.set('auto_departure_warning_sent', 'false');
        employeeRow.set('extended_work_reminder_sent', 'false');

        await employeeRow.save();
        logger.info(`Updated work_extension_minutes for ${user.nameFull}: ${currentExtension} + ${durationMinutes} = ${newExtension}`);
      }
    } catch (error) {
      logger.error(`Error updating work_extension_minutes: ${error.message}`);
    }

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

  // ===================================================================
  // TEMPORARY EXIT HANDLERS
  // ===================================================================

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

      // Get the user's row using cached method - reduces API calls from 4 to 1
      const employeeRow = await sheetsService.getCachedDailyRow(today, user.telegramId.toString());

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

      // Get the user's row using cached method - reduces API calls from 4 to 1
      const employeeRow = await sheetsService.getCachedDailyRow(today, user.telegramId.toString());

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
      // Reset extended work reminder flag so user gets a new reminder for the new extended time
      employeeRow.set('extended_work_reminder_sent', 'false');

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

  // ===================================================================
  // TEXT INPUT HANDLERS (Combined)
  // ===================================================================

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

        // FIX: Update work_extension_minutes in the Google Sheet using cached method
        const now = moment.tz(Config.TIMEZONE);
        const today = now.format('YYYY-MM-DD');

        try {
          // Use cached method - reduces API calls from 4 to 1
          const employeeRow = await sheetsService.getCachedDailyRow(today, user.telegramId.toString());

          if (employeeRow) {
            // Get current extension and add to it
            const currentExtension = parseInt(employeeRow.get('work_extension_minutes') || '0');
            const newExtension = currentExtension + durationMinutes;

            // Update work extension
            employeeRow.set('work_extension_minutes', newExtension.toString());
            // Reset warning flags so user gets new warnings based on extended time
            employeeRow.set('auto_departure_warning_sent', 'false');
            employeeRow.set('extended_work_reminder_sent', 'false');

            await employeeRow.save();
            logger.info(`Updated work_extension_minutes for ${user.nameFull}: ${currentExtension} + ${durationMinutes} = ${newExtension}`);
          }
        } catch (error) {
          logger.error(`Error updating work_extension_minutes: ${error.message}`);
        }

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
          if (now.isBefore(workTime.end)) {
            // Leaving early!
            const earlyMinutes = workTime.end.diff(now, 'minutes');
            const { penalty, violationType } = CalculatorService.determineEarlyDeparturePenalty(earlyMinutes);

            responseText += `⚠️ Вы уходите раньше требуемого времени (${workTime.end.format('HH:mm')})\n`;
            responseText += `⚠️ Недоработано: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;

            if (penalty === 0) {
              responseText += `📊 Штраф: 0 (менее ${Config.EARLY_MINOR_THRESHOLD} мин)\n`;
            } else {
              responseText += `📊 Штраф за ранний уход: ${penalty} баллов\n`;
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

      const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

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

      // Generate caring message based on keywords in the reason
      let caringMessage = '🌟 Хорошего дня! Надеемся скоро увидеть вас!';

      const reasonLower = reason.toLowerCase();
      if (reasonLower.includes('болею') || reasonLower.includes('больн') || reasonLower.includes('температур') || reasonLower.includes('простуд')) {
        caringMessage = '🤒 Выздоравливайте скорее!\n\n💊 Берегите себя, отдыхайте и не волнуйтесь о работе.\n❤️ Желаем вам скорейшего выздоровления!';
      } else if (reasonLower.includes('семь') || reasonLower.includes('родст') || reasonLower.includes('родител')) {
        caringMessage = '👨‍👩‍👧 Семья - самое важное!\n\n❤️ Надеемся, что у всех всё хорошо.\n🤗 Берегите друг друга, мы вас ждём!';
      } else if (reasonLower.includes('команд') || reasonLower.includes('поезд') || reasonLower.includes('дело')) {
        caringMessage = '✈️ Удачной поездки!\n\n🌟 Желаем продуктивного времени.\n🔙 До скорой встречи!';
      } else if (reasonLower.includes('личн') || reasonLower.includes('дел')) {
        caringMessage = '🧭 Хорошего дня!\n\n🌟 Иногда нужно время для себя.\n😊 Надеемся скоро увидеть вас!';
      }

      await ctx.reply(
        `✅ Ваше отсутствие зафиксировано.\n` +
        `📋 Причина: ${reason}\n\n` +
        `${caringMessage}`,
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

      const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

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
}

module.exports = {
  setupCheckoutHandlers
};
