/**
 * Location tracking and verification functions
 */

const moment = require('moment-timezone');
const sheetsService = require('../../../services/sheets.service');
const CalculatorService = require('../../../services/calculator.service');
const locationTrackerService = require('../../../services/locationTracker.service');
const anomalyDetectorService = require('../../../services/anomalyDetector.service');
const Keyboards = require('../../keyboards/buttons');
const Config = require('../../../config');
const logger = require('../../../utils/logger');
const {
  awaitingLocationForCheckIn,
  awaitingLocationForCheckout,
  awaitingOnsiteConfirmation
} = require('./shared');
const geocodingService = require('../../../services/geocoding.service');

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
        accuracy: location.horizontal_accuracy ?? location.accuracy ?? null
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

      // If CRITICAL (wrong location), ask if on-site instead of rejecting
      if (anomaly.severity === 'CRITICAL') {
        // Stop tracking while awaiting confirmation
        locationTrackerService.forceStopTracking(user.telegramId);

        // Store state for on-site confirmation
        const userId = user.telegramId.toString();
        awaitingOnsiteConfirmation.set(userId, {
          requestTime: Date.now(),
          user,
          location,
          anomaly
        });

        // Auto-cleanup after 5 minutes
        setTimeout(() => {
          awaitingOnsiteConfirmation.delete(userId);
        }, 5 * 60 * 1000);

        await ctx.reply(
          `📍 Ваше местоположение вне офиса. Вы на объекте?`,
          Keyboards.getOnsiteConfirmationKeyboard()
        );
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
      responseText += `💪 Такое усердие заслуживает уважения!`;
      details = isSunday ? 'sunday_work' : 'saturday_work';
      ratingImpact = 0.0; // No penalty, base 10 points
    } else if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!\n`;
      responseText += `📊 Штраф: 0 (полные ${Config.BASE_POINTS} баллов)`;
      details = 'on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
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
      location.horizontal_accuracy ?? location.accuracy ?? null
    );

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on 5-zone rating
    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

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
 * Process on-site arrival (user confirmed they are at a work site outside the office)
 * @param {Object} ctx - Telegraf context (callback query)
 * @param {Object} onsiteState - State from awaitingOnsiteConfirmation Map
 * @returns {Promise<void>}
 */
async function processOnsiteArrival(ctx, onsiteState) {
  const { user, location } = onsiteState;

  try {
    const now = moment.tz(Config.TIMEZONE);

    // Reverse geocode the location
    const locationName = await geocodingService.reverseGeocode(location.latitude, location.longitude);

    // Parse work schedule
    const workTime = CalculatorService.parseWorkTime(user.workTime);
    if (!workTime) {
      await ctx.editMessageText(
        '❌ К сожалению, в Вашем расписании обнаружена ошибка. Пожалуйста, обратитесь к администратору.'
      );
      return;
    }

    // Check if arrived today
    const status = await sheetsService.getUserStatusToday(user.telegramId);

    // Check if Sunday OR (Saturday AND user doesn't work on Saturday)
    const isSunday = now.day() === 0;
    const isSaturday = now.day() === 6;
    const isDayOff = isSunday || (isSaturday && user.doNotWorkSaturday);

    // Calculate lateness
    const { latenessMinutes, status: latenessStatus } = CalculatorService.calculateLateness(
      workTime.start,
      now
    );

    let responseText = `✅ **Приход отмечен! (на объекте)**\n`;
    responseText += `📍 ${locationName}\n\n`;
    let details = 'on_site, on_time';

    if (isDayOff) {
      const dayName = isSunday ? 'воскресенье' : 'субботу';
      responseText += `🌟 Отличная работа! Вы работаете в ${dayName}!\n`;
      details = `on_site, ${isSunday ? 'sunday_work' : 'saturday_work'}`;
    } else if (latenessStatus === 'ON_TIME') {
      responseText += `🎉 Вы пришли вовремя!\n`;
      responseText += `📊 Штраф: 0 (полные ${Config.BASE_POINTS} баллов)`;
      details = 'on_site, on_time';
    } else if (latenessStatus === 'LATE' || latenessStatus === 'SOFT_LATE') {
      if (status.lateNotified) {
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (Вы предупредили)\n`;
        responseText += `📊 Штраф за опоздание будет рассчитан при отметке`;
        details = `on_site, late_notified, ${latenessMinutes}min`;
      } else {
        responseText += `⚠️ Опоздание: ${CalculatorService.formatTimeDiff(latenessMinutes)} (без предупреждения)\n`;
        responseText += `📊 Штраф: ${Config.LATE_SILENT_PENALTY} баллов`;
        details = `on_site, late_silent, ${latenessMinutes}min`;
      }
    }

    // Log arrival event
    await sheetsService.logEvent(
      user.telegramId,
      user.nameFull,
      'ARRIVAL',
      details,
      0.0
    );

    // Store location data
    await sheetsService.updateArrivalLocation(
      user.telegramId,
      { latitude: location.latitude, longitude: location.longitude },
      location.horizontal_accuracy ?? location.accuracy ?? null
    );

    // Write on-site location name
    await sheetsService.updateOnsiteLocationName(user.telegramId, locationName);

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

    responseText += `\n\n📊 Баллы за сегодня: ${todayPoint} ${pointEmoji}`;

    await ctx.editMessageText(responseText, { parse_mode: 'Markdown' });
    await ctx.reply('Главное меню:', Keyboards.getMainMenu(ctx.from.id));
    logger.info(`On-site arrival logged for ${user.nameFull}: ${details}, location: ${locationName}`);

  } catch (error) {
    logger.error(`Error processing on-site arrival: ${error.message}`);
    await ctx.editMessageText(
      '❌ К сожалению, произошла ошибка при отметке прихода. Пожалуйста, попробуйте снова или обратитесь к администратору.'
    );
  }
}

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
        accuracy: location.horizontal_accuracy ?? location.accuracy ?? null
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

      // If CRITICAL (wrong location - outside geofence), check if on-site user
      if (anomaly.severity === 'CRITICAL' && anomaly.type === 'WRONG_LOCATION') {
        // Check if this user arrived on-site (has Location Name populated)
        let isOnsiteUser = false;
        try {
          const now2 = moment.tz(Config.TIMEZONE);
          const sheetName = now2.format('YYYY-MM-DD');
          const employeeRow = await sheetsService.getCachedDailyRow(sheetName, user.telegramId.toString());
          if (employeeRow) {
            const locationNameValue = employeeRow.get('Location Name') || '';
            isOnsiteUser = locationNameValue.trim() !== '';
          }
        } catch (err) {
          logger.error(`Error checking on-site status for departure: ${err.message}`);
        }

        // Skip fraud detection for on-site users — they are expected to be outside the office
        if (isOnsiteUser) {
          logger.info(`On-site user ${user.nameFull} departing from outside office — allowed`);
        } else {
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
      // Leaving early AND did not work full required hours - apply tiered penalties
      responseText += `⚠️ Ранний уход: ${CalculatorService.formatTimeDiff(earlyMinutes)}\n`;
      details = `early_${earlyMinutes}min` + (departureMessage ? `, msg: ${departureMessage}` : '');

      // Tiered early departure penalty
      const { penalty, violationType } = CalculatorService.determineEarlyDeparturePenalty(earlyMinutes);

      if (penalty === 0) {
        responseText += `📊 Штраф: 0 (менее ${Config.EARLY_MINOR_THRESHOLD} мин)\n`;
      } else {
        responseText += `📊 Штраф за ранний уход: ${penalty} баллов\n`;
      }

      if (departureMessage) {
        responseText += `📝 Причина: ${departureMessage}\n`;
      } else if (Config.REQUIRE_DEPARTURE_MESSAGE) {
        responseText += `⚠️ Ушли без сообщения\n`;
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
      location.horizontal_accuracy ?? location.accuracy ?? null
    );

    // Get today's points
    const updatedStatus = await sheetsService.getUserStatusToday(user.telegramId);
    const todayPoint = updatedStatus.todayPoint || 0;

    // Determine emoji based on 5-zone rating
    const { emoji: pointEmoji } = CalculatorService.getRatingZone(todayPoint);

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

/**
 * Setup location handler for both check-in and checkout
 */
function setupLocationHandler(bot) {
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

  // Handle on-site confirmation callback buttons
  bot.action(/^onsite_confirm:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const choice = ctx.match[1]; // 'yes' or 'no'
      const userId = ctx.from.id.toString();

      const onsiteState = awaitingOnsiteConfirmation.get(userId);

      if (!onsiteState) {
        // State expired or already processed
        await ctx.editMessageText(
          '⏰ Время ожидания истекло. Пожалуйста, попробуйте снова нажав "✅ Пришёл".'
        );
        return;
      }

      // Remove from map (one-time use)
      awaitingOnsiteConfirmation.delete(userId);

      if (choice === 'yes') {
        // Immediately remove buttons and show loading
        await ctx.editMessageText('⏳ Определяем местоположение и отмечаем приход...');
        await processOnsiteArrival(ctx, onsiteState);
      } else {
        // No — show rejection and return to main menu
        await ctx.editMessageText(
          '❌ Отметка прихода отменена.\n\n' +
          'Пожалуйста, убедитесь, что Вы находитесь в офисе перед отметкой прихода.'
        );
        await ctx.reply('Главное меню:', Keyboards.getMainMenu(ctx.from.id));
      }
    } catch (error) {
      logger.error(`Error in on-site confirmation handler: ${error.message}`);
      try {
        await ctx.editMessageText(
          '❌ Произошла ошибка. Пожалуйста, попробуйте снова.'
        );
      } catch (e) {
        // ignore edit failures
      }
    }
  });
}

module.exports = {
  processArrivalWithLocation,
  processOnsiteArrival,
  processDepartureWithLocation,
  handleCheckoutLocation,
  setupLocationHandler
};
