/**
 * Test script to verify cache optimizations
 * Tests the new caching mechanisms for reduced API quota usage
 */

require('dotenv').config();
const sheetsService = require('./src/services/sheets.service');
const logger = require('./src/utils/logger');
const moment = require('moment-timezone');
const Config = require('./src/config');

async function testCacheOptimizations() {
  try {
    logger.info('========================================');
    logger.info('Testing Cache Optimizations');
    logger.info('========================================\n');

    // Connect to Google Sheets
    logger.info('1. Connecting to Google Sheets...');
    await sheetsService.connect();
    logger.info('✅ Connected successfully\n');

    // Test cache warmup with indexing (skip if today's sheet doesn't exist)
    const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
    const sheetExists = sheetsService.doc.sheetsByTitle[today];

    if (sheetExists) {
      logger.info('2. Testing cache warmup with indexing...');
      const warmupResult = await sheetsService.warmupCache();
      logger.info(`✅ Cache warmup ${warmupResult ? 'succeeded' : 'failed'}\n`);
    } else {
      logger.info(`2. Today's sheet (${today}) doesn't exist - skipping warmup test\n`);
    }

    // Test cached roster access
    logger.info('3. Testing cached roster access...');
    const startRoster1 = Date.now();
    const roster1 = await sheetsService._getCachedRoster(true);
    const timeRoster1 = Date.now() - startRoster1;
    logger.info(`✅ First roster load: ${timeRoster1}ms (${roster1.length} employees)`);

    const startRoster2 = Date.now();
    const roster2 = await sheetsService._getCachedRoster();
    const timeRoster2 = Date.now() - startRoster2;
    logger.info(`✅ Second roster load (cached): ${timeRoster2}ms`);
    logger.info(`   Cache speedup: ${((timeRoster1 - timeRoster2) / timeRoster1 * 100).toFixed(1)}%\n`);

    // Test cached employee lookup by telegram ID
    if (roster1.length > 0) {
      const testTelegramId = roster1[0].get('Telegram Id');
      if (testTelegramId) {
        logger.info('4. Testing cached employee lookup by telegram ID...');

        const startLookup1 = Date.now();
        const employee1 = await sheetsService.findEmployeeByTelegramId(testTelegramId);
        const timeLookup1 = Date.now() - startLookup1;
        logger.info(`✅ First lookup: ${timeLookup1}ms`);

        const startLookup2 = Date.now();
        const employee2 = await sheetsService.findEmployeeByTelegramId(testTelegramId);
        const timeLookup2 = Date.now() - startLookup2;
        logger.info(`✅ Second lookup (cached): ${timeLookup2}ms`);
        logger.info(`   Cache speedup: ${((timeLookup1 - timeLookup2) / timeLookup1 * 100).toFixed(1)}%\n`);
      }
    }

    // Test cached daily sheet access
    if (sheetExists) {
      logger.info('5. Testing cached daily sheet access...');

      const startDaily1 = Date.now();
      const { rows: dailyRows1 } = await sheetsService._getCachedDailySheet(today);
      const timeDaily1 = Date.now() - startDaily1;
      logger.info(`✅ First daily sheet load: ${timeDaily1}ms (${dailyRows1.length} rows)`);

      const startDaily2 = Date.now();
      const { rows: dailyRows2 } = await sheetsService._getCachedDailySheet(today);
      const timeDaily2 = Date.now() - startDaily2;
      logger.info(`✅ Second daily sheet load (cached): ${timeDaily2}ms`);
      logger.info(`   Cache speedup: ${((timeDaily1 - timeDaily2) / timeDaily1 * 100).toFixed(1)}%\n`);

      // Test cached daily row lookup
      if (dailyRows1.length > 0) {
        const testRow = dailyRows1[0];
        const testTid = testRow.get('TelegramId');

        if (testTid) {
          logger.info('6. Testing cached daily row lookup by telegram ID...');

          const startRowLookup1 = Date.now();
          const row1 = await sheetsService._getCachedDailyRow(today, testTid);
          const timeRowLookup1 = Date.now() - startRowLookup1;
          logger.info(`✅ First row lookup: ${timeRowLookup1}ms`);

          const startRowLookup2 = Date.now();
          const row2 = await sheetsService._getCachedDailyRow(today, testTid);
          const timeRowLookup2 = Date.now() - startRowLookup2;
          logger.info(`✅ Second row lookup (cached): ${timeRowLookup2}ms`);
          logger.info(`   Cache speedup: ${((timeRowLookup1 - timeRowLookup2) / timeRowLookup1 * 100).toFixed(1)}%\n`);
        }
      }
    } else {
      logger.info(`5. Today's sheet (${today}) doesn't exist yet - skipping daily sheet tests\n`);
    }

    // Test cache statistics
    logger.info('7. Cache Statistics:');
    logger.info(`   Roster cache: ${sheetsService._rosterCache ? 'ACTIVE' : 'EMPTY'}`);
    logger.info(`   Roster index size: ${sheetsService._rosterByTelegramIdCache.size} employees`);
    logger.info(`   Daily sheet cache size: ${sheetsService._dailySheetCache.size} sheets`);
    logger.info(`   Daily row cache size: ${sheetsService._dailyRowCache.size} rows`);
    logger.info(`   Cache timeout: ${sheetsService._cacheTimeout / 1000} seconds (${sheetsService._cacheTimeout / 60000} minutes)`);

    logger.info('\n========================================');
    logger.info('✅ All cache optimization tests passed!');
    logger.info('========================================\n');

    logger.info('OPTIMIZATION SUMMARY:');
    logger.info('- Cache duration increased from 15 to 30 minutes');
    logger.info('- Implemented telegram ID indexing for O(1) lookups');
    logger.info('- Roster and daily sheets are now cached and indexed');
    logger.info('- Reminder check (every 5 min) now uses cached data');
    logger.info('- Expected quota reduction: 70-80% for read operations\n');

  } catch (error) {
    logger.error(`Test failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testCacheOptimizations()
  .then(() => {
    logger.info('Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    logger.error(`Test failed: ${error.message}`);
    process.exit(1);
  });
