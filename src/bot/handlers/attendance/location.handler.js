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
  awaitingLocationForCheckout
} = require('./shared');

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
}

module.exports = {
  processArrivalWithLocation,
  processDepartureWithLocation,
  handleCheckoutLocation,
  setupLocationHandler
};
