/**
 * Check-in handler for attendance
 * Handles arrival, late notifications, and related operations
 */

const moment = require('moment-timezone');
const sheetsService = require('../../../services/sheets.service');
const CalculatorService = require('../../../services/calculator.service');
const Keyboards = require('../../keyboards/buttons');
const Config = require('../../../config');
const logger = require('../../../utils/logger');
const {
  getUserOrPromptRegistration,
  getMainMenuKeyboard,
  awaitingLocationForCheckIn
} = require('./shared');
const { processArrivalWithLocation } = require('./location.handler');

/**
 * Setup check-in handlers
 */
function setupCheckinHandlers(bot) {
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
        `👋 Здравствуйте! Рады приветствовать вас! 😊\n\n` +
        `📍 Для подтверждения прихода, пожалуйста, поделитесь вашим текущим местоположением онлайн.\n\n` +
        `🔹 Как это сделать:\n` +
        `Нажмите кнопку ниже и выберите опцию "Поделиться моим местоположением онлайн"\n` +
        `Рекомендуем установить время на 15 минут или дольше.\n\n` +
        `💡 Совет: Пожалуйста, используйте именно онлайн-местоположение, а не статическое, чтобы система могла корректно отследить ваше присутствие.`,
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
      ratingImpact = 0.0; // No penalty, base 10 points
    } else if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!\n`;
      responseText += `📊 Штраф: 0 (полные ${Config.BASE_POINTS} баллов)`;
      details = 'on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
      // Check if user notified about being late
      if (status.lateNotified) {
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (Вы предупредили)\n`;
        responseText += `📊 Штраф за опоздание будет рассчитан при отметке`;
        details = `late_notified, ${latenessMinutes}min`;
      } else {
        // Silent late - penalty -4
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (без предупреждения)\n`;
        responseText += `📊 Штраф: ${Config.LATE_SILENT_PENALTY} баллов`;
        details = `late_silent, ${latenessMinutes}min`;
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

    // Determine emoji based on 5-zone rating
    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

    responseText += `\n\n📊 Баллы сегодня: ${todayPoint} ${pointEmoji}`;

    await ctx.reply(responseText, Keyboards.getMainMenu(ctx.from.id));
    logger.info(`Arrival logged for ${user.nameFull}: ${details}`);
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
      `💡 Штраф за раннее предупреждение: -2 балла (вместо -4)\n` +
      `⚠️ Если придёте позже ${arrivalTimeStr}, штраф составит -4 балла\n\n` +
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

    return next();
  });
}

module.exports = {
  setupCheckinHandlers
};
