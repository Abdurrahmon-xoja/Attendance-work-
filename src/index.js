/**
 * Main bot entry point.
 * Initializes the bot, registers handlers, and starts polling.
 */

const { Telegraf, session, Scenes } = require('telegraf');
const express = require('express');
const Config = require('./config');
const logger = require('./utils/logger');
const sheetsService = require('./services/sheets.service');
const schedulerService = require('./services/scheduler.service');
const locationTrackerService = require('./services/locationTracker.service');
const anomalyDetectorService = require('./services/anomalyDetector.service');
const { registrationWizard, setupRegistrationHandlers } = require('./bot/handlers/registration.handler');
const { setupAttendanceHandlers } = require('./bot/handlers/attendance'); // Updated to use modular structure
const { sendBusyNotification } = require('./utils/messageHelper');

// Initialize bot
const bot = new Telegraf(Config.BOT_TOKEN);

// Setup session middleware
bot.use(session());

// Create Express app for health checks (required by Render)
const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running!');
});
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    environment: Config.NODE_ENV
  });
});

// Create stage and register scenes
const stage = new Scenes.Stage([registrationWizard]);
bot.use(stage.middleware());

// Error handling middleware
bot.catch((err, ctx) => {
  logger.error(`Error for ${ctx.updateType}: ${err.message}`);
  logger.error(err.stack);

  ctx.reply('❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.')
    .catch(e => logger.error(`Failed to send error message: ${e.message}`));
});

// Setup handlers
setupRegistrationHandlers(bot);
setupAttendanceHandlers(bot);

// Admin command to test busy gif
bot.command('testgif', async (ctx) => {
  const telegramId = ctx.from.id;

  // Check if user is admin
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }

  logger.info(`Admin ${telegramId} testing busy gif`);
  await sendBusyNotification(ctx, 'Тестовое сообщение с гифкой от администратора 🎬');
});

// /endday - Manually trigger end-of-day archiving
bot.command('endday', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  const dateStr = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
  await ctx.reply(`⏳ Запуск архивации за ${dateStr}...`);
  logger.info(`Admin ${telegramId} triggered manual end-of-day for ${dateStr}`);
  try {
    const { handleEndOfDay } = require('./services/scheduling/jobs/endOfDayArchiving.job');
    await handleEndOfDay(dateStr, schedulerService, true);
    await ctx.reply(`✅ Архивация за ${dateStr} завершена!`);
  } catch (error) {
    logger.error(`Error in manual end-of-day: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /monthlyreport - Create monthly report sheet
bot.command('monthlyreport', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  const yearMonth = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM');
  await ctx.reply(`⏳ Создание месячного отчёта за ${yearMonth}...`);
  logger.info(`Admin ${telegramId} triggered monthly report for ${yearMonth}`);
  try {
    await sheetsService.initializeMonthlyReport(yearMonth);
    await ctx.reply(`✅ Лист Report_${yearMonth} создан!`);
  } catch (error) {
    logger.error(`Error creating monthly report: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /updatereport - Recalculate monthly report from daily sheets
bot.command('updatereport', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  const dateStr = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
  await ctx.reply(`⏳ Пересчёт месячного отчёта по данным за ${dateStr}...`);
  logger.info(`Admin ${telegramId} triggered monthly report update for ${dateStr}`);
  try {
    await sheetsService.updateMonthlyReport(dateStr);
    const yearMonth = moment.tz(dateStr, Config.TIMEZONE).format('YYYY-MM');
    await ctx.reply(`✅ Report_${yearMonth} пересчитан!`);
  } catch (error) {
    logger.error(`Error updating monthly report: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /noshow - Manually trigger no-show check
bot.command('noshow', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  const dateStr = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
  await ctx.reply(`⏳ Проверка отсутствующих за ${dateStr}...`);
  logger.info(`Admin ${telegramId} triggered no-show check for ${dateStr}`);
  try {
    const { checkAndMarkNoShows } = require('./services/scheduling/jobs/noShowCheck.job');
    const count = await checkAndMarkNoShows(dateStr, schedulerService);
    await ctx.reply(`✅ Проверка завершена! Отмечено no-show: ${count || 0}`);
  } catch (error) {
    logger.error(`Error in manual no-show check: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /createsheet - Manually create daily sheet
bot.command('createsheet', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  const dateStr = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
  await ctx.reply(`⏳ Создание дневного листа за ${dateStr}...`);
  logger.info(`Admin ${telegramId} triggered daily sheet creation for ${dateStr}`);
  try {
    await sheetsService.initializeDailySheet(dateStr);
    await ctx.reply(`✅ Дневной лист ${dateStr} создан!`);
  } catch (error) {
    logger.error(`Error creating daily sheet: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /hourscalendar - Create or update Hours Calendar sheet
bot.command('hourscalendar', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  const args = ctx.message.text.split(' ');
  const moment = require('moment-timezone');
  // Accept either YYYY-MM (init only) or YYYY-MM-DD (init + update day)
  const param = args[1] || moment.tz(Config.TIMEZONE).format('YYYY-MM');
  const isFullDate = /^\d{4}-\d{2}-\d{2}$/.test(param);
  const yearMonth = isFullDate
    ? moment.tz(param, Config.TIMEZONE).format('YYYY-MM')
    : param;

  logger.info(`Admin ${telegramId} triggered hours calendar for ${param}`);

  try {
    if (isFullDate) {
      await ctx.reply(`⏳ Обновление календаря часов за ${param}...`);
      await sheetsService.initializeHoursCalendar(yearMonth);
      await sheetsService.updateHoursCalendar(param);
      await ctx.reply(`✅ Hours_${yearMonth} обновлён данными за ${param}!`);
    } else {
      await ctx.reply(`⏳ Создание календаря часов за ${yearMonth}...`);
      await sheetsService.initializeHoursCalendar(yearMonth);
      await ctx.reply(`✅ Лист Hours_${yearMonth} создан!`);
    }
  } catch (error) {
    logger.error(`Error in hours calendar command: ${error.message}`);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// /adminhelp - Show admin commands
bot.command('adminhelp', async (ctx) => {
  const telegramId = ctx.from.id;
  if (!Config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    await ctx.reply('❌ Эта команда доступна только администраторам.');
    return;
  }
  await ctx.reply(
    `🔧 КОМАНДЫ АДМИНИСТРАТОРА\n\n` +
    `/createsheet [YYYY-MM-DD] — Создать дневной лист\n` +
    `/monthlyreport [YYYY-MM] — Создать лист месячного отчёта\n` +
    `/updatereport [YYYY-MM-DD] — Пересчитать отчёт из дневных листов\n` +
    `/hourscalendar [YYYY-MM или YYYY-MM-DD] — Календарь часов (создать / обновить день)\n` +
    `/endday [YYYY-MM-DD] — Архивация дня (ночные → отчёт → Excel → удаление)\n` +
    `/noshow [YYYY-MM-DD] — Проверка no-show\n` +
    `/testgif — Тест гифки\n` +
    `/adminhelp — Эта справка`
  );
});

// Live Location Handler - processes location updates during tracking
const handleLocationUpdate = async (ctx) => {
  try {
    // IMPORTANT: Convert to string to match type used in tracking sessions
    const userId = ctx.from.id.toString();

    // Only process if location tracking is enabled
    if (!Config.ENABLE_LOCATION_TRACKING) {
      return;
    }

    const location = ctx.message?.location || ctx.update?.edited_message?.location;

    if (!location) {
      return;
    }

    // Check if user has an active tracking session
    if (!locationTrackerService.hasActiveSession(userId)) {
      return;
    }

    // Add location update to session
    const result = locationTrackerService.addLocationUpdate(userId, {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy ?? null
    });

    if (!result.success) {
      logger.error(`Failed to add location update for user ${userId}: ${result.error}`);
      return;
    }

    const session = locationTrackerService.getSession(userId);
    const updateNum = session ? session.updateCount : '?';
    logger.info(`📍 Live location update #${updateNum} from user ${userId}: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} (accuracy: ${location.horizontal_accuracy != null ? location.horizontal_accuracy.toFixed(1) + 'm' : 'unknown'})`);

    // Check if anomalies detected
    if (result.hasAnomalies && result.newAnomalies.length > 0) {
      logger.warn(`⚠️ New anomalies detected for user ${userId}: ${result.newAnomalies.map(a => a.type).join(', ')}`);

      // Stop tracking immediately if CRITICAL anomalies only (not HIGH - too sensitive)
      const hasCritical = result.newAnomalies.some(a => a.severity === 'CRITICAL');

      if (hasCritical) {
        // Stop tracking and finalize
        const stopResult = locationTrackerService.stopTracking(userId, 'ANOMALY');

        if (stopResult.success) {
          const session = stopResult.session;
          const analysis = stopResult.analysis;

          // Get user info
          const user = await sheetsService.findEmployeeByTelegramId(userId);
          const userName = user ? user.nameFull : `User ${userId}`;

          // CRITICAL: Cancel fraudulent arrival - remove check-in from sheets
          await sheetsService.cancelFraudulentArrival(
            userId,
            userName,
            analysis.anomalies
          );

          // Update Google Sheets with verification status
          await sheetsService.updateLocationVerification(
            userId,
            'FLAGGED',
            analysis.anomalies
          );

          // Send alert to user
          const alertMessage = `🚨 ОТМЕТКА ПРИХОДА ОТКЛОНЕНА - ОБНАРУЖЕНО НАРУШЕНИЕ\n\n` +
            anomalyDetectorService.formatAnomalyMessage(analysis) +
            `\n\n⛔ Ваша отметка прихода была ОТМЕНЕНА, и Вы отмечены как ОТСУТСТВУЮЩИЙ.\n` +
            `Штраф: -2.0 балла\n\n` +
            `Пожалуйста, срочно обратитесь к руководителю.`;
          await ctx.reply(alertMessage);

          // Notify admins
          if (Config.ADMIN_TELEGRAM_IDS && Config.ADMIN_TELEGRAM_IDS.length > 0) {
            const adminMessage = `🚨 ПРЕДУПРЕЖДЕНИЕ О НАРУШЕНИИ - ОТМЕТКА ПРИХОДА ОТМЕНЕНА\n\n` +
              `Сотрудник: ${userName}\n` +
              `User ID: ${userId}\n` +
              `Аномалии: ${analysis.anomalyCount}\n` +
              `Серьезность: ${analysis.severity}\n\n` +
              `${analysis.summary}\n\n` +
              `⚠️ Приход УДАЛЕН из листа посещаемости.\n` +
              `Отмечен как ОТСУТСТВУЮЩИЙ с попыткой нарушения.`;

            for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
              try {
                await bot.telegram.sendMessage(adminId, adminMessage);
              } catch (err) {
                logger.error(`Failed to send admin alert to ${adminId}: ${err.message}`);
              }
            }
          }

          logger.warn(`🚨 FRAUD DETECTED: Cancelled arrival for user ${userId} (${userName})`);
        }
      }
    }

    // Check if tracking duration completed
    if (result.shouldStopTracking) {
      // Stop tracking and finalize
      const stopResult = locationTrackerService.stopTracking(userId, 'COMPLETED');

      if (stopResult.success) {
        const session = stopResult.session;
        const analysis = stopResult.analysis;

        // Update Google Sheets with final verification status
        await sheetsService.updateLocationVerification(
          userId,
          analysis.hasAnomaly ? 'FLAGGED' : 'OK',
          analysis.anomalies
        );

        logger.info(`✅ Location tracking completed for user ${userId}: ${stopResult.verificationStatus}`);

        // Notify user of completion
        if (!analysis.hasAnomaly) {
          // Successful verification
          await ctx.reply(
            `✅ **Проверка местоположения завершена!**\n\n` +
            `Ваше местоположение успешно подтверждено.\n` +
            `Аномалий не обнаружено. Спасибо! 🎉`,
            { parse_mode: 'Markdown' }
          );
        }

        // If anomalies found, notify user and admins
        if (analysis.hasAnomaly) {
          const user = await sheetsService.findEmployeeByTelegramId(userId);
          const userName = user ? user.nameFull : `User ${userId}`;

          // Check if CRITICAL severity - requires fraud action
          const hasCriticalAtEnd = analysis.severity === 'CRITICAL';

          if (hasCriticalAtEnd) {
            // FRAUD DETECTED: Cancel arrival
            await sheetsService.cancelFraudulentArrival(
              userId,
              userName,
              analysis.anomalies
            );

            // Send fraud alert to user
            const alertMessage = `🚨 ОТМЕТКА ПРИХОДА ОТКЛОНЕНА - ОБНАРУЖЕНО НАРУШЕНИЕ\n\n` +
              anomalyDetectorService.formatAnomalyMessage(analysis) +
              `\n\n⛔ Ваша отметка прихода была ОТМЕНЕНА, и Вы отмечены как ОТСУТСТВУЮЩИЙ.\n` +
              `Штраф: -2.0 балла\n\n` +
              `Пожалуйста, срочно обратитесь к руководителю.`;
            await ctx.reply(alertMessage);

            // Notify admins about fraud
            if (Config.ADMIN_TELEGRAM_IDS && Config.ADMIN_TELEGRAM_IDS.length > 0) {
              const adminMessage = `🚨 ПРЕДУПРЕЖДЕНИЕ О НАРУШЕНИИ - ОТМЕТКА ПРИХОДА ОТМЕНЕНА\n\n` +
                `Сотрудник: ${userName}\n` +
                `User ID: ${userId}\n` +
                `Аномалии: ${analysis.anomalyCount}\n` +
                `Серьезность: ${analysis.severity}\n\n` +
                `${analysis.summary}\n\n` +
                `⚠️ Приход УДАЛЕН из листа посещаемости.\n` +
                `Отмечен как ОТСУТСТВУЮЩИЙ с попыткой нарушения.`;

              for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
                try {
                  await bot.telegram.sendMessage(adminId, adminMessage);
                } catch (err) {
                  logger.error(`Failed to send fraud alert to ${adminId}: ${err.message}`);
                }
              }
            }

            logger.warn(`🚨 FRAUD DETECTED: Cancelled arrival for user ${userId} (${userName})`);
          } else {
            // Minor anomalies - just warn but keep check-in
            // Send alert to user
            const alertMessage = anomalyDetectorService.formatAnomalyMessage(analysis);
            await ctx.reply(alertMessage);

            // Notify admins
            if (Config.ADMIN_TELEGRAM_IDS && Config.ADMIN_TELEGRAM_IDS.length > 0) {
              const adminMessage = `⚠️ Проблема с проверкой местоположения\n\n` +
                `Сотрудник: ${userName}\n` +
                `User ID: ${userId}\n` +
                `Аномалии: ${analysis.anomalyCount}\n` +
                `Серьезность: ${analysis.severity}\n\n` +
                `${analysis.summary}`;

              for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
                try {
                  await bot.telegram.sendMessage(adminId, adminMessage);
                } catch (err) {
                  logger.error(`Failed to send admin notification to ${adminId}: ${err.message}`);
                }
              }
            }
          }
        }
      }
    }

  } catch (error) {
    logger.error(`Error processing location update: ${error.message}`);
    logger.error(error.stack);
  }
};

// Register handlers for both new and edited location messages
bot.on('location', handleLocationUpdate);

// Handle edited messages (live location updates)
bot.on('edited_message', async (ctx) => {
  // Check if edited message contains location
  if (ctx.update.edited_message && ctx.update.edited_message.location) {
    await handleLocationUpdate(ctx);
  }
});

// Periodic check for stopped location updates (runs every 30 seconds)
if (Config.ENABLE_LOCATION_TRACKING) {
  setInterval(async () => {
    const stoppedSessions = locationTrackerService.checkForStoppedSessions();

    if (stoppedSessions.length > 0) {
      logger.warn(`⚠️ Found ${stoppedSessions.length} sessions with stopped updates`);

      // Handle each stopped session
      for (const stopped of stoppedSessions) {
        const stopResult = locationTrackerService.stopTracking(stopped.userId, 'TIMEOUT');

        if (stopResult.success) {
          const analysis = stopResult.analysis;

          // Check if we have enough data despite timeout
          if (stopped.hasEnoughData) {
            // Has enough updates - consider it successful despite early stop
            await sheetsService.updateLocationVerification(
              stopped.userId,
              'OK',
              analysis.anomalies
            ).catch(err => {
              logger.error(`Failed to update verification for stopped session ${stopped.userId}: ${err.message}`);
            });

            // Notify user of success
            bot.telegram.sendMessage(
              parseInt(stopped.userId),
              `✅ Проверка местоположения завершена!\n\nПолучено ${stopped.updateCount} обновлений местоположения. Проверка прошла успешно! 🎉`
            ).catch(err => {
              logger.error(`Failed to notify user ${stopped.userId}: ${err.message}`);
            });

            logger.info(`✅ Verified user ${stopped.userId} with ${stopped.updateCount} updates (stopped early but sufficient data)`);
          } else {
            // Insufficient data - flag as problem
            await sheetsService.updateLocationVerification(
              stopped.userId,
              'FLAGGED',
              analysis.anomalies
            ).catch(err => {
              logger.error(`Failed to update verification for stopped session ${stopped.userId}: ${err.message}`);
            });

            // Notify user
            bot.telegram.sendMessage(
              parseInt(stopped.userId),
              `⚠️ Отслеживание местоположения остановлено слишком рано.\n\nПолучено только ${stopped.updateCount} обновлений (минимум: ${Config.MIN_UPDATES_FOR_VERIFICATION}).\n\nПожалуйста, держите Telegram открытым во время отметки прихода.`
            ).catch(err => {
              logger.error(`Failed to notify user ${stopped.userId}: ${err.message}`);
            });

            logger.warn(`Handled stopped session for user ${stopped.userId} - insufficient data`);
          }
        }
      }
    }
  }, 30 * 1000); // Every 30 seconds
}

// Start bot
async function start() {
  try {
    // Connect to Google Sheets
    logger.info('Connecting to Google Sheets...');
    await sheetsService.connect();
    logger.info('✅ Google Sheets connected successfully');

    // Pre-warm cache to reduce API quota usage on startup
    logger.info('Pre-warming cache for today\'s sheet...');
    await sheetsService.warmupCache();

    // Start bot
    logger.info('Starting bot...');

    // Launch bot in background and continue initialization
    logger.info('Launching Telegram bot...');

    // Start polling without waiting for connection
    bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query', 'edited_message']
    }).then(() => {
      logger.info('✅ Telegram bot connected and polling');
    }).catch((err) => {
      logger.error(`Bot launch error: ${err.message}`);
    });

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    logger.info('✅ Bot initialization started');

    // Initialize scheduler
    schedulerService.init(bot);

    // Start HTTP server for Render health checks
    const PORT = Config.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🌐 HTTP server listening on port ${PORT}`);
    });

    logger.info('✅ Bot started successfully!');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`🤖 ENVIRONMENT: ${Config.NODE_ENV.toUpperCase()}`);
    logger.info(`📱 Bot Token: ${Config.BOT_TOKEN.substring(0, 15)}...`);
    logger.info(`📊 Google Sheet ID: ${Config.GOOGLE_SHEETS_ID.substring(0, 20)}...`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`Timezone: ${Config.TIMEZONE}`);
    logger.info(`Grace period: ${Config.GRACE_PERIOD_MINUTES} minutes`);
    logger.info(`Auto-create daily sheet: ${Config.AUTO_CREATE_DAILY_SHEET ? 'ON' : 'OFF (dev mode)'}`);
    logger.info(`Work reminders: ${Config.ENABLE_WORK_REMINDERS ? 'ON' : 'OFF'}`);
    logger.info('Bot is now running. Press Ctrl+C to stop.');

  } catch (error) {
    logger.error(`Fatal error during startup: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Graceful stop
process.once('SIGINT', () => {
  logger.info('Received SIGINT, stopping bot...');
  schedulerService.stop();
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping bot...');
  schedulerService.stop();
  bot.stop('SIGTERM');
});

// Start the bot
start();
