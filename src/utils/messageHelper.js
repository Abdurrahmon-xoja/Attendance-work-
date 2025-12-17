/**
 * Helper utilities for sending messages and media.
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Path to the busy GIF
const BUSY_GIF_PATH = path.join(__dirname, '../../../spongebob-busy.mp4');

/**
 * Send busy/overload notification with GIF
 * @param {Object} ctx - Telegraf context
 * @param {string} message - Optional custom message (default: system overload message)
 */
async function sendBusyNotification(ctx, message = null) {
  const defaultMessage =
    '⏳ В данный момент система перегружена, много сотрудников используют бот.\n\n' +
    'Пожалуйста, нажмите кнопку ещё раз через несколько секунд.';

  const messageText = message || defaultMessage;

  try {
    // Check if GIF file exists
    if (!fs.existsSync(BUSY_GIF_PATH)) {
      logger.warn(`Busy GIF not found at ${BUSY_GIF_PATH}, sending message only`);
      await ctx.reply(messageText);
      return;
    }

    // Send GIF first
    await ctx.replyWithVideo(
      { source: BUSY_GIF_PATH },
      { caption: messageText }
    );

    logger.info(`Sent busy notification with GIF to user ${ctx.from.id}`);
  } catch (error) {
    logger.error(`Failed to send busy GIF: ${error.message}`);
    // Fallback to text-only message
    await ctx.reply(messageText);
  }
}

module.exports = {
  sendBusyNotification,
  BUSY_GIF_PATH
};
