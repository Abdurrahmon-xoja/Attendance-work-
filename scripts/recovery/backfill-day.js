/**
 * Backfill a missed day: transfer to monthly report + Hours calendar + send
 * Excel archive to the Telegram group. Reuses the end-of-day job's own code,
 * so the _ArchiveLog makes re-runs safe (completed steps are skipped).
 *
 * By default the daily sheet is KEPT for verification. Pass --delete to remove
 * it (only runs when all other steps are already done/successful).
 * Pass --no-archive to skip sending the Excel file to the group.
 *
 * Usage: node scripts/recovery/backfill-day.js 2026-07-01 [--no-archive] [--delete]
 *
 * Safe to run alongside the live bot: no polling is started (no 409 conflict),
 * and messages to employees/admins are suppressed (logged to console instead).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.production') });
const { Telegraf } = require('telegraf');
const sheetsService = require('../../src/services/sheets.service');
const Config = require('../../src/config');
const job = require('../../src/services/scheduling/jobs/endOfDayArchiving.job');

const args = process.argv.slice(2);
const dateStr = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const noArchive = args.includes('--no-archive');
const doDelete = args.includes('--delete');

if (!dateStr) {
  console.error('Usage: node scripts/recovery/backfill-day.js YYYY-MM-DD [--no-archive] [--delete]');
  process.exit(1);
}

async function main() {
  console.log(`=== Backfill ${dateStr} (archive: ${!noArchive}, delete: ${doDelete}) ===`);

  // connect() is not retried by the service itself; ride out per-minute quota
  for (let attempt = 1; ; attempt++) {
    try {
      await sheetsService.connect();
      break;
    } catch (err) {
      if (attempt < 10 && err.message && err.message.includes('429')) {
        console.log(`Connect hit quota (attempt ${attempt}/10), waiting 45s...`);
        await new Promise(r => setTimeout(r, 45000));
      } else {
        throw err;
      }
    }
  }

  if (!sheetsService.doc.sheetsByTitle[dateStr]) {
    console.error(`Daily sheet ${dateStr} not found in spreadsheet - nothing to backfill`);
    process.exit(1);
  }

  // Scheduler-like object: real bot for the group Excel send (bot.telegram
  // works without launching polling), but user/admin messages are suppressed -
  // we must not spam employees about days that ended long ago.
  const runnerScheduler = {
    bot: noArchive ? null : new Telegraf(Config.BOT_TOKEN),
    sendMessageSafe: async (telegramId, message) => {
      console.log(`[suppressed message to ${telegramId}]: ${message.split('\n')[0]}`);
      return true;
    }
  };

  await job.handleEndOfDay(dateStr, runnerScheduler, true, { skipDelete: !doDelete });

  console.log(`=== Backfill ${dateStr} done ===`);
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
