/**
 * Shared helper functions and state for attendance handlers
 */

const sheetsService = require('../../../services/sheets.service');
const Keyboards = require('../../keyboards/buttons');
const { sendBusyNotification } = require('../../../utils/messageHelper');

// Temporary state: users awaiting location for check-in
// Map<userId, { requestTime, user, checkInData }>
const awaitingLocationForCheckIn = new Map();

// Temporary state: users awaiting location for checkout/departure
// Map<userId, { requestTime, user, checkoutTime, departureType, workTimeData }>
const awaitingLocationForCheckout = new Map();

// Temporary state: users awaiting on-site confirmation after out-of-geofence arrival
// Map<userId, { requestTime, user, location, anomaly }>
const awaitingOnsiteConfirmation = new Map();

/**
 * Get user data or prompt for registration
 */
async function getUserOrPromptRegistration(ctx) {
  const telegramId = ctx.from.id;

  try {
    const user = await sheetsService.findEmployeeByTelegramId(telegramId);

    if (!user) {
      await ctx.reply(
        '❌ К сожалению, Вы не зарегистрированы в системе.\n' +
        'Пожалуйста, используйте команду /start для регистрации.'
      );
      return null;
    }

    return user;
  } catch (error) {
    // Handle quota errors with a friendly message
    if (error.isQuotaError) {
      await sendBusyNotification(ctx);
      return null;
    }

    // Re-throw other errors
    throw error;
  }
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

module.exports = {
  awaitingLocationForCheckIn,
  awaitingLocationForCheckout,
  awaitingOnsiteConfirmation,
  getUserOrPromptRegistration,
  getMainMenuKeyboard
};
