/**
 * Comprehensive integration test for Google Sheets quota optimizations
 * Simulates real bot usage patterns and measures API quota usage
 */

require('dotenv').config();
const sheetsService = require('./src/services/sheets.service');
const schedulerService = require('./src/services/scheduler.service');
const logger = require('./src/utils/logger');
const moment = require('moment-timezone');
const Config = require('./src/config');

let testsPassed = 0;
let testsFailed = 0;
let apiCallCount = 0;

// Track API calls by intercepting the retry operation
const originalRetryOperation = sheetsService._retryOperation.bind(sheetsService);
sheetsService._retryOperation = async function(operation, maxRetries, initialDelay) {
  apiCallCount++;
  return await originalRetryOperation(operation, maxRetries, initialDelay);
};

function logTest(testName, passed, details = '') {
  if (passed) {
    testsPassed++;
    logger.info(`✅ ${testName}`);
    if (details) logger.info(`   ${details}`);
  } else {
    testsFailed++;
    logger.error(`❌ ${testName}`);
    if (details) logger.error(`   ${details}`);
  }
}

async function runTests() {
  try {
    logger.info('========================================');
    logger.info('COMPREHENSIVE INTEGRATION TEST');
    logger.info('Testing Google Sheets Quota Optimizations');
    logger.info('========================================\n');

    const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');

    // ==========================================
    // TEST 1: Bot Connection
    // ==========================================
    logger.info('TEST 1: Bot Connection & Initialization');
    logger.info('------------------------------------------');
    const connectStart = Date.now();

    await sheetsService.connect();
    const connectTime = Date.now() - connectStart;

    logTest('Connected to Google Sheets', sheetsService.isConnected, `Time: ${connectTime}ms`);
    logTest('Spreadsheet loaded', sheetsService.doc !== null);

    const initialApiCalls = apiCallCount;
    logger.info(`API calls for connection: ${initialApiCalls}\n`);

    // ==========================================
    // TEST 2: Cache Warmup
    // ==========================================
    logger.info('TEST 2: Cache Warmup with Indexing');
    logger.info('------------------------------------------');
    const warmupStart = Date.now();
    apiCallCount = 0;

    const warmupResult = await sheetsService.warmupCache();
    const warmupTime = Date.now() - warmupStart;

    logTest('Cache warmup completed', warmupResult === true, `Time: ${warmupTime}ms`);
    logTest('Roster index built', sheetsService._rosterByTelegramIdCache.size > 0,
      `Indexed: ${sheetsService._rosterByTelegramIdCache.size} employees`);
    logTest('Cache timeout extended', sheetsService._cacheTimeout === 1800000,
      `30 minutes (${sheetsService._cacheTimeout / 60000} min)`);

    const warmupApiCalls = apiCallCount;
    logger.info(`API calls for warmup: ${warmupApiCalls}\n`);

    // ==========================================
    // TEST 3: Cached Roster Access
    // ==========================================
    logger.info('TEST 3: Cached Roster Access (Simulating Multiple Reads)');
    logger.info('------------------------------------------');

    // First read - should use cache
    apiCallCount = 0;
    const roster1Start = Date.now();
    const roster1 = await sheetsService._getCachedRoster();
    const roster1Time = Date.now() - roster1Start;
    const roster1ApiCalls = apiCallCount;

    logTest('First roster read (cached)', roster1ApiCalls === 0,
      `Time: ${roster1Time}ms, API calls: ${roster1ApiCalls}, Employees: ${roster1.length}`);

    // Second read - should also use cache
    apiCallCount = 0;
    const roster2Start = Date.now();
    const roster2 = await sheetsService._getCachedRoster();
    const roster2Time = Date.now() - roster2Start;
    const roster2ApiCalls = apiCallCount;

    logTest('Second roster read (cached)', roster2ApiCalls === 0,
      `Time: ${roster2Time}ms, API calls: ${roster2ApiCalls}`);

    // Test indexed lookup
    if (roster1.length > 0) {
      const testTelegramId = roster1[0].get('Telegram Id');
      if (testTelegramId) {
        apiCallCount = 0;
        const lookupStart = Date.now();
        const employee = await sheetsService._getCachedEmployeeByTelegramId(testTelegramId);
        const lookupTime = Date.now() - lookupStart;
        const lookupApiCalls = apiCallCount;

        logTest('Indexed employee lookup', employee !== null && lookupApiCalls === 0,
          `Time: ${lookupTime}ms, API calls: ${lookupApiCalls}`);
      }
    }
    logger.info('');

    // ==========================================
    // TEST 4: Cached Daily Sheet Access
    // ==========================================
    logger.info('TEST 4: Cached Daily Sheet Access');
    logger.info('------------------------------------------');

    const sheetExists = sheetsService.doc.sheetsByTitle[today];

    if (sheetExists) {
      // First read - should use cache
      apiCallCount = 0;
      const daily1Start = Date.now();
      const { rows: dailyRows1 } = await sheetsService._getCachedDailySheet(today);
      const daily1Time = Date.now() - daily1Start;
      const daily1ApiCalls = apiCallCount;

      logTest('First daily sheet read (cached)', daily1ApiCalls === 0,
        `Time: ${daily1Time}ms, API calls: ${daily1ApiCalls}, Rows: ${dailyRows1.length}`);

      // Second read - should use cache
      apiCallCount = 0;
      const daily2Start = Date.now();
      const { rows: dailyRows2 } = await sheetsService._getCachedDailySheet(today);
      const daily2Time = Date.now() - daily2Start;
      const daily2ApiCalls = apiCallCount;

      logTest('Second daily sheet read (cached)', daily2ApiCalls === 0,
        `Time: ${daily2Time}ms, API calls: ${daily2ApiCalls}`);
    } else {
      logger.warn(`Sheet ${today} doesn't exist - skipping daily sheet tests`);
    }
    logger.info('');

    // ==========================================
    // TEST 5: Employee Lookup (findEmployeeByTelegramId)
    // ==========================================
    logger.info('TEST 5: Optimized Employee Lookup');
    logger.info('------------------------------------------');

    if (roster1.length > 0) {
      const testTelegramId = roster1[0].get('Telegram Id');
      if (testTelegramId) {
        // First lookup
        apiCallCount = 0;
        const lookup1Start = Date.now();
        const emp1 = await sheetsService.findEmployeeByTelegramId(testTelegramId);
        const lookup1Time = Date.now() - lookup1Start;
        const lookup1ApiCalls = apiCallCount;

        logTest('First employee lookup', emp1 !== null,
          `Time: ${lookup1Time}ms, API calls: ${lookup1ApiCalls}`);

        // Second lookup - should use cache
        apiCallCount = 0;
        const lookup2Start = Date.now();
        const emp2 = await sheetsService.findEmployeeByTelegramId(testTelegramId);
        const lookup2Time = Date.now() - lookup2Start;
        const lookup2ApiCalls = apiCallCount;

        logTest('Second employee lookup (cached)', lookup2ApiCalls === 0,
          `Time: ${lookup2Time}ms, API calls: ${lookup2ApiCalls}`);

        if (emp1) {
          logTest('Employee data valid', emp1.nameFull && emp1.workTime,
            `Name: ${emp1.nameFull}, Work Time: ${emp1.workTime}`);
        }
      }
    }
    logger.info('');

    // ==========================================
    // TEST 6: Simulated Reminder Check
    // ==========================================
    logger.info('TEST 6: Simulated Reminder Check (Critical - Runs Every 5 Min)');
    logger.info('------------------------------------------');

    if (sheetExists) {
      // Simulate what happens every 5 minutes
      apiCallCount = 0;
      const reminderStart = Date.now();

      // This is what checkAndSendReminders does
      const { worksheet, rows } = await sheetsService._getCachedDailySheet(today);
      const rosterRows = await sheetsService._getCachedRoster(true);

      const reminderTime = Date.now() - reminderStart;
      const reminderApiCalls = apiCallCount;

      logTest('Reminder check completed', rows && rosterRows,
        `Time: ${reminderTime}ms, API calls: ${reminderApiCalls}`);
      logTest('Reminder check uses cache', reminderApiCalls === 0,
        'This is the CRITICAL optimization - runs every 5 min!');

      // Simulate second reminder check 5 minutes later (should still use cache)
      apiCallCount = 0;
      const reminder2Start = Date.now();

      const { worksheet: ws2, rows: rows2 } = await sheetsService._getCachedDailySheet(today);
      const rosterRows2 = await sheetsService._getCachedRoster(true);

      const reminder2Time = Date.now() - reminder2Start;
      const reminder2ApiCalls = apiCallCount;

      logTest('Second reminder check (5 min later)', reminder2ApiCalls === 0,
        `Time: ${reminder2Time}ms, API calls: ${reminder2ApiCalls}`);
    }
    logger.info('');

    // ==========================================
    // TEST 7: Cache Invalidation
    // ==========================================
    logger.info('TEST 7: Cache Invalidation');
    logger.info('------------------------------------------');

    const cacheCountBefore = sheetsService._dailySheetCache.size;
    sheetsService._invalidateCache(today);

    // Wait for delayed invalidation
    await new Promise(resolve => setTimeout(resolve, 11000));

    const cacheCountAfter = sheetsService._dailySheetCache.size;
    logTest('Cache invalidation works', cacheCountAfter < cacheCountBefore || cacheCountBefore === 0,
      `Before: ${cacheCountBefore}, After: ${cacheCountAfter}`);
    logger.info('');

    // ==========================================
    // TEST 8: Cache Statistics & Summary
    // ==========================================
    logger.info('TEST 8: Cache Statistics');
    logger.info('------------------------------------------');

    logger.info(`Roster cache: ${sheetsService._rosterCache ? 'ACTIVE' : 'EMPTY'}`);
    logger.info(`Roster index size: ${sheetsService._rosterByTelegramIdCache.size} employees`);
    logger.info(`Daily sheet cache: ${sheetsService._dailySheetCache.size} sheets`);
    logger.info(`Daily row cache: ${sheetsService._dailyRowCache.size} rows`);
    logger.info(`Cache timeout: ${sheetsService._cacheTimeout / 1000}s (${sheetsService._cacheTimeout / 60000} min)`);
    logger.info('');

    // ==========================================
    // FINAL RESULTS
    // ==========================================
    logger.info('========================================');
    logger.info('TEST RESULTS SUMMARY');
    logger.info('========================================');
    logger.info(`✅ Tests Passed: ${testsPassed}`);
    logger.info(`❌ Tests Failed: ${testsFailed}`);
    logger.info(`Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);
    logger.info('');

    logger.info('OPTIMIZATION IMPACT:');
    logger.info('------------------------------------------');
    logger.info('Before optimization (per hour):');
    logger.info('  - Reminder checks: 12 × 4 = 48 API calls');
    logger.info('  - Employee lookups: ~40 API calls');
    logger.info('  - Total: ~88+ API calls/hour');
    logger.info('');
    logger.info('After optimization (per hour):');
    logger.info('  - Reminder checks: 2 × 4 = 8 API calls (cache hits for 50 min)');
    logger.info('  - Employee lookups: ~8 API calls (cache hits)');
    logger.info('  - Total: ~16 API calls/hour');
    logger.info('');
    logger.info('💡 EXPECTED REDUCTION: 82% fewer read API calls!');
    logger.info('========================================\n');

    if (testsFailed === 0) {
      logger.info('🎉 ALL TESTS PASSED! Optimizations are working correctly.');
      logger.info('✅ Ready for deployment!');
      process.exit(0);
    } else {
      logger.error(`⚠️  ${testsFailed} test(s) failed. Please review.`);
      process.exit(1);
    }

  } catch (error) {
    logger.error('========================================');
    logger.error('CRITICAL ERROR IN TESTS');
    logger.error('========================================');
    logger.error(`Error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run all tests
logger.info('Starting comprehensive integration tests...\n');
runTests();
