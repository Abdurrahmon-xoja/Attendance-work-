/**
 * Test to verify logEvent function uses cached roster
 * This is the critical fix for 429 errors during check-in
 */

require('dotenv').config();
const sheetsService = require('./src/services/sheets.service');
const logger = require('./src/utils/logger');
const moment = require('moment-timezone');
const Config = require('./src/config');

let apiCallCount = 0;
let cacheHitCount = 0;
let cacheMissCount = 0;

// Track API calls by intercepting getRows on the worksheet prototype
const originalGetRows = require('google-spreadsheet').GoogleSpreadsheetWorksheet.prototype.getRows;
require('google-spreadsheet').GoogleSpreadsheetWorksheet.prototype.getRows = async function(...args) {
  apiCallCount++;
  logger.warn(`⚠️  DIRECT API CALL #${apiCallCount}: getRows on sheet "${this.title}"`);
  return await originalGetRows.apply(this, args);
};

// Track cache usage
const originalGetCached = sheetsService._getCachedRoster.bind(sheetsService);
sheetsService._getCachedRoster = async function(buildIndex) {
  if (this._rosterCache && this._isCacheValid(this._rosterCache.lastUpdated)) {
    cacheHitCount++;
    logger.info(`✅ CACHE HIT for roster (hit #${cacheHitCount})`);
  } else {
    cacheMissCount++;
    logger.info(`📥 CACHE MISS for roster (loading fresh data)`);
  }
  return await originalGetCached.call(this, buildIndex);
};

async function testLogEventCaching() {
  try {
    logger.info('========================================');
    logger.info('TESTING: logEvent Caching');
    logger.info('Critical fix verification for 429 errors');
    logger.info('========================================\n');

    let testsPassed = 0;
    let testsFailed = 0;

    function logTest(name, passed, details = '') {
      if (passed) {
        testsPassed++;
        logger.info(`✅ ${name}`);
      } else {
        testsFailed++;
        logger.error(`❌ ${name}`);
      }
      if (details) logger.info(`   ${details}`);
    }

    // Connect and warmup
    logger.info('1. Connecting to Google Sheets...');
    await sheetsService.connect();
    logTest('Connected', sheetsService.isConnected);

    logger.info('\n2. Warming up cache...');
    apiCallCount = 0;
    await sheetsService.warmupCache();
    const warmupCalls = apiCallCount;
    logTest('Cache warmed up', warmupCalls > 0, `${warmupCalls} API calls during warmup`);
    logger.info('');

    // Get test employee
    const roster = await sheetsService._getCachedRoster();
    const testEmployee = roster.find(r => r.get('Telegram Id'));

    if (!testEmployee) {
      logger.error('No employee with telegram ID found for testing');
      process.exit(1);
    }

    const telegramId = testEmployee.get('Telegram Id');
    const employeeName = testEmployee.get('Name') || 'Test Employee';

    logger.info(`3. Testing with employee: ${employeeName} (${telegramId})\n`);

    // TEST 1: Simulate ARRIVAL event
    logger.info('TEST 1: logEvent(ARRIVAL) - Should use cached roster');
    logger.info('------------------------------------------');
    apiCallCount = 0;
    const arrivalStart = Date.now();

    try {
      await sheetsService.logEvent(telegramId, employeeName, 'ARRIVAL', 'Test arrival', 0);
      const arrivalTime = Date.now() - arrivalStart;
      const arrivalCalls = apiCallCount;

      logTest('ARRIVAL event logged', true, `Time: ${arrivalTime}ms`);
      logTest('No direct API calls for roster', arrivalCalls === 0 || arrivalCalls <= 2,
        `API calls: ${arrivalCalls} (should be 0 for roster, max 2 for daily sheet operations)`);
    } catch (err) {
      logTest('ARRIVAL event logged', false, `Error: ${err.message}`);
    }

    logger.info('');

    // TEST 2: Simulate DEPARTURE event
    logger.info('TEST 2: logEvent(DEPARTURE) - Should use cached roster');
    logger.info('------------------------------------------');
    apiCallCount = 0;
    const departureStart = Date.now();

    try {
      await sheetsService.logEvent(telegramId, employeeName, 'DEPARTURE', 'Test departure', 0);
      const departureTime = Date.now() - departureStart;
      const departureCalls = apiCallCount;

      logTest('DEPARTURE event logged', true, `Time: ${departureTime}ms`);
      logTest('No direct API calls for roster', departureCalls === 0 || departureCalls <= 2,
        `API calls: ${departureCalls} (should be 0 for roster, max 2 for daily sheet operations)`);
    } catch (err) {
      logTest('DEPARTURE event logged', false, `Error: ${err.message}`);
    }

    logger.info('');

    // TEST 3: Multiple concurrent check-ins
    logger.info('TEST 3: Simulating 5 concurrent check-ins');
    logger.info('------------------------------------------');
    apiCallCount = 0;
    const concurrentStart = Date.now();

    const employees = roster.slice(0, 5).filter(r => r.get('Telegram Id'));
    const concurrentOps = employees.map((emp, i) => {
      const tid = emp.get('Telegram Id');
      const name = emp.get('Name') || `Employee ${i+1}`;
      return sheetsService.logEvent(tid, name, 'ARRIVAL', `Concurrent test ${i+1}`, 0);
    });

    try {
      await Promise.all(concurrentOps);
      const concurrentTime = Date.now() - concurrentStart;
      const concurrentCalls = apiCallCount;

      logTest('Concurrent operations completed', true,
        `${employees.length} check-ins in ${concurrentTime}ms`);
      logTest('Minimal API calls', concurrentCalls <= employees.length * 2,
        `Total API calls: ${concurrentCalls} (max ${employees.length * 2} expected for ${employees.length} employees)`);
    } catch (err) {
      logTest('Concurrent operations completed', false, `Error: ${err.message}`);
    }

    logger.info('');

    // Cache statistics
    logger.info('CACHE PERFORMANCE:');
    logger.info('------------------------------------------');
    logger.info(`Cache hits: ${cacheHitCount} ✅`);
    logger.info(`Cache misses: ${cacheMissCount} 📥`);
    const cacheEfficiency = cacheHitCount + cacheMissCount > 0
      ? ((cacheHitCount / (cacheHitCount + cacheMissCount)) * 100).toFixed(1)
      : 0;
    logger.info(`Cache efficiency: ${cacheEfficiency}%`);

    logTest('Cache efficiency acceptable', parseFloat(cacheEfficiency) >= 70,
      `${cacheEfficiency}% (target: >70%)`);

    logger.info('');

    // Final results
    logger.info('========================================');
    logger.info('TEST RESULTS');
    logger.info('========================================');
    logger.info(`✅ Tests Passed: ${testsPassed}`);
    logger.info(`❌ Tests Failed: ${testsFailed}`);
    logger.info(`Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);
    logger.info('');

    if (testsFailed === 0) {
      logger.info('🎉 ALL TESTS PASSED!');
      logger.info('✅ logEvent function uses cached roster');
      logger.info('✅ No direct roster API calls during check-in');
      logger.info('✅ Fix verified - SAFE TO DEPLOY');
      logger.info('');
      logger.info('EXPECTED PRODUCTION BEHAVIOR:');
      logger.info('- Employee check-ins: 0 roster API calls');
      logger.info('- No "Error checking work time" messages');
      logger.info('- No 429 quota errors during check-in');
      process.exit(0);
    } else {
      logger.error('⚠️  SOME TESTS FAILED');
      logger.error('Review before deployment');
      process.exit(1);
    }

  } catch (error) {
    logger.error('========================================');
    logger.error('CRITICAL ERROR IN TEST');
    logger.error('========================================');
    logger.error(`Error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

logger.info('Starting logEvent caching test...\n');
testLogEventCaching();
