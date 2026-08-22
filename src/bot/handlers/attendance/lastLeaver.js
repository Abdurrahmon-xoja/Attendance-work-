/**
 * Last-leaver notice
 *
 * When someone marks their departure and nobody else is still checked in at
 * their office, DM them a reminder to check the lights and doors before they go.
 *
 * Scoping rules (deliberate):
 * - Per office, using the daily sheet's "Location Name" column, so emptying
 *   Офис 1 doesn't stay silent just because Офис 2 is still full. Rows without
 *   a location count as the same office — the conservative reading, since an
 *   unknown location might well be the one being locked up.
 * - Someone on a temporary exit still counts as present (their "Leave time" is
 *   empty), so nobody is told they're last while a colleague is out for lunch.
 */

const moment = require('moment-timezone');
const sheetsService = require('../../../services/sheets.service');
const Config = require('../../../config');
const MESSAGES = require('../../../constants/messages');
const logger = require('../../../utils/logger');

// `${date}:${telegramId}` of everyone already told. A departure can travel
// through more than one code path (e.g. the location flow finishing what the
// button started) and must only produce one message.
const notified = new Set();

const cell = (row, header) => (row.get(header) || '').toString().trim();

/**
 * Is this row someone who is at work right now?
 * Arrived, not absent, and hasn't marked a departure.
 */
function isStillAtWork(row) {
  if (!cell(row, 'TelegramId')) return false;
  if (cell(row, 'Absent').toLowerCase() === 'yes') return false;
  if (!cell(row, 'When come')) return false;
  return cell(row, 'Leave time') === '';
}

/**
 * Notify `user` if they were the last person at their office.
 * Never throws — a failure here must not break the departure it follows.
 *
 * @param {Object} telegram - ctx.telegram or bot.telegram
 * @param {Object} user - the employee who just left ({ telegramId, nameFull })
 * @returns {Promise<boolean>} whether the notice was sent
 */
async function notifyIfLastToLeave(telegram, user) {
  if (!Config.ENABLE_LAST_LEAVER_NOTICE) return false;
  if (!telegram || !user || !user.telegramId) return false;

  const now = moment.tz(Config.TIMEZONE);
  const today = now.format('YYYY-MM-DD');
  const telegramId = user.telegramId.toString();
  const key = `${today}:${telegramId}`;

  if (notified.has(key)) return false;

  try {
    // The cached rows are the same objects the departure just wrote to, so this
    // costs no extra Sheets quota on a normal checkout.
    const { rows } = await sheetsService._getCachedDailySheet(today, {});

    const myRow = rows.find((row) => cell(row, 'TelegramId') === telegramId);
    if (!myRow) return false;

    // Only meaningful once this person is actually marked as gone.
    if (!cell(myRow, 'Leave time')) return false;

    const myOffice = cell(myRow, 'Location Name');

    const stillIn = rows.filter((row) => {
      if (cell(row, 'TelegramId') === telegramId) return false;
      if (!isStillAtWork(row)) return false;

      const office = cell(row, 'Location Name');
      // An unknown location on either side is treated as "same place".
      return !myOffice || !office || office === myOffice;
    });

    if (stillIn.length > 0) {
      logger.debug(`Last-leaver: ${stillIn.length} still at ${myOffice || 'work'} after ${user.nameFull} left`);
      return false;
    }

    notified.add(key);

    const officeSuffix = myOffice ? ` из «${myOffice}»` : '';
    await telegram.sendMessage(telegramId, MESSAGES.LAST_LEAVER.replace('{office}', officeSuffix));
    logger.info(`Last-leaver notice sent to ${user.nameFull} (${telegramId})${officeSuffix}`);

    if (Config.LAST_LEAVER_NOTIFY_ADMINS) {
      const summary =
        `🔑 Последним ушёл ${user.nameFull}${officeSuffix} в ${cell(myRow, 'Leave time').slice(0, 5)}`;
      for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
        try {
          await telegram.sendMessage(adminId, summary);
        } catch (err) {
          logger.warn(`Could not send last-leaver summary to admin ${adminId}: ${err.message}`);
        }
      }
    }

    return true;
  } catch (error) {
    logger.error(`Last-leaver check failed for ${telegramId}: ${error.message}`);
    return false;
  }
}

/**
 * Forget who has been notified — used by tests and safe to call any time.
 */
function resetLastLeaverState() {
  notified.clear();
}

module.exports = {
  notifyIfLastToLeave,
  isStillAtWork,
  resetLastLeaverState
};
