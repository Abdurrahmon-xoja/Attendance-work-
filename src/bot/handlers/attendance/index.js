/**
 * Main attendance handler - combines all attendance-related modules
 * This file re-exports all functions to maintain backward compatibility
 */

const { setupCheckinHandlers } = require('./checkin.handler');
const { setupCheckoutHandlers } = require('./checkout.handler');
const { handleStatus } = require('./status.handler');
const { setupLocationHandler } = require('./location.handler');
const { setupAdminHandlers } = require('./admin.handler');
const {
  getUserOrPromptRegistration,
  getMainMenuKeyboard,
  awaitingLocationForCheckIn,
  awaitingLocationForCheckout,
  awaitingOnsiteConfirmation
} = require('./shared');

/**
 * Setup all attendance handlers
 * This is the main entry point that was originally exported from attendance.handler.js
 */
function setupAttendanceHandlers(bot) {
  // Setup check-in related handlers
  setupCheckinHandlers(bot);

  // Setup checkout/departure related handlers
  setupCheckoutHandlers(bot);

  // Setup location tracking handler
  setupLocationHandler(bot);

  // Setup admin button handlers
  setupAdminHandlers(bot);

  // Setup status handlers
  bot.command('status', async (ctx) => await handleStatus(ctx));
  bot.hears('📋 Мой статус', async (ctx) => await handleStatus(ctx));
}

// Re-export everything for backward compatibility and flexibility
module.exports = {
  setupAttendanceHandlers,
  setupCheckinHandlers,
  setupCheckoutHandlers,
  handleStatus,
  setupLocationHandler,
  getUserOrPromptRegistration,
  getMainMenuKeyboard,
  awaitingLocationForCheckIn,
  awaitingLocationForCheckout,
  awaitingOnsiteConfirmation
};
