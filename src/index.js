/**
 * Main bot entry point.
 * Initializes the bot, registers handlers, and starts polling.
 */

const { Telegraf, session, Scenes } = require('telegraf');
const Config = require('./config');
const logger = require('./utils/logger');
const sheetsService = require('./services/sheets.service');
const schedulerService = require('./services/scheduler.service');
const { registrationWizard, setupRegistrationHandlers } = require('./bot/handlers/registration.handler');
const { setupAttendanceHandlers } = require('./bot/handlers/attendance.handler');

// Initialize bot
const bot = new Telegraf(Config.BOT_TOKEN);

// Setup session middleware
bot.use(session());

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

// Start bot
async function start() {
  try {
    // Connect to Google Sheets
    logger.info('Connecting to Google Sheets...');
    await sheetsService.connect();
    logger.info('✅ Google Sheets connected successfully');

    // Start bot
    logger.info('Starting bot...');

    // Launch bot in background and continue initialization
    logger.info('Launching Telegram bot...');

    // Start polling without waiting for connection
    bot.launch({
      allowedUpdates: ['message', 'callback_query']
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

    logger.info('✅ Bot started successfully!');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`🤖 ENVIRONMENT: ${Config.NODE_ENV.toUpperCase()}`);
    logger.info(`📱 Bot Token: ${Config.BOT_TOKEN.substring(0, 15)}...`);
    logger.info(`📊 Google Sheet ID: ${Config.GOOGLE_SHEETS_ID.substring(0, 20)}...`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`Timezone: ${Config.TIMEZONE}`);
    logger.info(`Grace period: ${Config.GRACE_PERIOD_MINUTES} minutes`);
    logger.info(`Late deadline: ${Config.LATE_DEADLINE_TIME}`);
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
