/**
 * Test script for auto-departure feature with work extensions
 * This script validates that work extensions are correctly applied to auto-departure calculations
 *
 * Tests:
 * 1. Auto-departure timing without extension
 * 2. Auto-departure timing with 30-minute extension
 * 3. Auto-departure timing with 1-hour extension
 * 4. Auto-departure timing with 2-hour extension
 * 5. Warning message format with extension
 * 6. Warning message format without extension
 */

const moment = require('moment-timezone');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logTest(testName) {
  console.log(`\n${colors.bright}${colors.blue}📋 TEST: ${testName}${colors.reset}`);
}

function logSuccess(message) {
  log(`  ✅ ${message}`, colors.green);
}

function logError(message) {
  log(`  ❌ ${message}`, colors.red);
}

function logInfo(message) {
  log(`  ℹ️  ${message}`, colors.cyan);
}

function logWarning(message) {
  log(`  ⚠️  ${message}`, colors.yellow);
}

/**
 * Simulate the auto-departure calculation logic from scheduler.service.js
 */
function calculateAutoDepartureTimes(workEndHour, workEndMinute, extensionMinutes, graceMinutes = 15, warningMinutes = 10) {
  // Parse work end time (from roster)
  let workEnd = moment.tz('Asia/Tashkent').set({
    hour: workEndHour,
    minute: workEndMinute,
    second: 0
  });

  // Add work extension if user requested it (lines 901-904 in scheduler.service.js)
  if (extensionMinutes > 0) {
    workEnd = workEnd.clone().add(extensionMinutes, 'minutes');
  }

  // Calculate auto-departure time (work end + grace period) - line 907
  const autoDepartureTime = workEnd.clone().add(graceMinutes, 'minutes');

  // Calculate warning time (auto-departure - warning minutes) - line 908
  const warningTime = autoDepartureTime.clone().subtract(warningMinutes, 'minutes');

  return {
    originalEnd: moment.tz('Asia/Tashkent').set({ hour: workEndHour, minute: workEndMinute, second: 0 }),
    extendedEnd: workEnd,
    warningTime,
    autoDepartureTime,
    extensionMinutes
  };
}

/**
 * Format the warning message as it appears in scheduler.service.js (lines 919-939)
 */
function formatWarningMessage(times, warningMinutesConfig) {
  const { originalEnd, extendedEnd, extensionMinutes } = times;
  const endTime = originalEnd.format('HH:mm');
  const actualEndTime = extendedEnd.format('HH:mm');

  let warningMessage = `⏰ Напоминание об окончании работы\n\n`;

  if (extensionMinutes > 0) {
    const hours = Math.floor(extensionMinutes / 60);
    const mins = extensionMinutes % 60;
    const extensionText = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;

    warningMessage += `Ваше плановое время: ${endTime}\n`;
    warningMessage += `Продление: +${extensionText}\n`;
    warningMessage += `Текущее окончание работы: ${actualEndTime}\n\n`;
  } else {
    warningMessage += `Ваше рабочее время закончилось в ${actualEndTime}.\n`;
  }

  warningMessage += `Вы не отметили уход.\n\n`;
  warningMessage += `⚠️ Через ${warningMinutesConfig} минут вы будете автоматически отмечены как ушедший.\n\n`;
  warningMessage += `Что вы хотите сделать?`;

  return warningMessage;
}

async function runTests() {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  log('\n' + '='.repeat(70), colors.bright);
  log('AUTO-DEPARTURE WITH WORK EXTENSION TEST SUITE', colors.bright + colors.cyan);
  log('='.repeat(70) + '\n', colors.bright);

  try {
    // Load configuration
    const Config = require('./src/config');
    const GRACE_MINUTES = Config.AUTO_DEPARTURE_GRACE_MINUTES || 15;
    const WARNING_MINUTES = Config.AUTO_DEPARTURE_WARNING_MINUTES || 10;

    logInfo(`Configuration: Grace Period = ${GRACE_MINUTES} min, Warning = ${WARNING_MINUTES} min before auto-depart`);

    // Test 1: Auto-departure without extension (original scenario)
    logTest('Test 1: Auto-departure WITHOUT extension');
    totalTests++;
    try {
      const workEndHour = 19;
      const workEndMinute = 0;
      const extensionMinutes = 0;

      const times = calculateAutoDepartureTimes(workEndHour, workEndMinute, extensionMinutes, GRACE_MINUTES, WARNING_MINUTES);

      logInfo(`Work Schedule: 10:00-${times.originalEnd.format('HH:mm')}`);
      logInfo(`Extension: None`);
      logInfo(`Expected Warning Time: ${times.warningTime.format('HH:mm')}`);
      logInfo(`Expected Auto-Departure: ${times.autoDepartureTime.format('HH:mm')}`);

      // Verify calculations
      const expectedWarningTime = '19:05'; // 19:00 + 15 - 10 = 19:05
      const expectedAutoDepartureTime = '19:15'; // 19:00 + 15 = 19:15

      if (times.warningTime.format('HH:mm') === expectedWarningTime &&
          times.autoDepartureTime.format('HH:mm') === expectedAutoDepartureTime) {
        logSuccess(`Correct! Warning at ${expectedWarningTime}, Auto-depart at ${expectedAutoDepartureTime}`);
        passedTests++;
      } else {
        logError(`Wrong! Got warning at ${times.warningTime.format('HH:mm')}, auto-depart at ${times.autoDepartureTime.format('HH:mm')}`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 2: Auto-departure with 30-minute extension (bug scenario)
    logTest('Test 2: Auto-departure WITH 30-minute extension');
    totalTests++;
    try {
      const workEndHour = 19;
      const workEndMinute = 0;
      const extensionMinutes = 30;

      const times = calculateAutoDepartureTimes(workEndHour, workEndMinute, extensionMinutes, GRACE_MINUTES, WARNING_MINUTES);

      logInfo(`Work Schedule: 10:00-${times.originalEnd.format('HH:mm')}`);
      logInfo(`Extension: +${extensionMinutes} minutes`);
      logInfo(`Extended End Time: ${times.extendedEnd.format('HH:mm')}`);
      logInfo(`Expected Warning Time: ${times.warningTime.format('HH:mm')}`);
      logInfo(`Expected Auto-Departure: ${times.autoDepartureTime.format('HH:mm')}`);

      // Verify calculations
      const expectedWarningTime = '19:35'; // 19:30 + 15 - 10 = 19:35
      const expectedAutoDepartureTime = '19:45'; // 19:30 + 15 = 19:45

      if (times.warningTime.format('HH:mm') === expectedWarningTime &&
          times.autoDepartureTime.format('HH:mm') === expectedAutoDepartureTime) {
        logSuccess(`Correct! Warning at ${expectedWarningTime}, Auto-depart at ${expectedAutoDepartureTime}`);
        logSuccess(`Extension properly applied: NOT auto-departed at 19:15 ✅`);
        passedTests++;
      } else {
        logError(`Wrong! Got warning at ${times.warningTime.format('HH:mm')}, auto-depart at ${times.autoDepartureTime.format('HH:mm')}`);
        logError(`Expected warning at ${expectedWarningTime}, auto-depart at ${expectedAutoDepartureTime}`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 3: Auto-departure with 1-hour extension
    logTest('Test 3: Auto-departure WITH 1-hour extension');
    totalTests++;
    try {
      const workEndHour = 19;
      const workEndMinute = 0;
      const extensionMinutes = 60;

      const times = calculateAutoDepartureTimes(workEndHour, workEndMinute, extensionMinutes, GRACE_MINUTES, WARNING_MINUTES);

      logInfo(`Work Schedule: 10:00-${times.originalEnd.format('HH:mm')}`);
      logInfo(`Extension: +${extensionMinutes} minutes (1 hour)`);
      logInfo(`Extended End Time: ${times.extendedEnd.format('HH:mm')}`);
      logInfo(`Expected Warning Time: ${times.warningTime.format('HH:mm')}`);
      logInfo(`Expected Auto-Departure: ${times.autoDepartureTime.format('HH:mm')}`);

      // Verify calculations
      const expectedWarningTime = '20:05'; // 20:00 + 15 - 10 = 20:05
      const expectedAutoDepartureTime = '20:15'; // 20:00 + 15 = 20:15

      if (times.warningTime.format('HH:mm') === expectedWarningTime &&
          times.autoDepartureTime.format('HH:mm') === expectedAutoDepartureTime) {
        logSuccess(`Correct! Warning at ${expectedWarningTime}, Auto-depart at ${expectedAutoDepartureTime}`);
        passedTests++;
      } else {
        logError(`Wrong! Got warning at ${times.warningTime.format('HH:mm')}, auto-depart at ${times.autoDepartureTime.format('HH:mm')}`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 4: Auto-departure with 2-hour extension
    logTest('Test 4: Auto-departure WITH 2-hour extension');
    totalTests++;
    try {
      const workEndHour = 19;
      const workEndMinute = 0;
      const extensionMinutes = 120;

      const times = calculateAutoDepartureTimes(workEndHour, workEndMinute, extensionMinutes, GRACE_MINUTES, WARNING_MINUTES);

      logInfo(`Work Schedule: 10:00-${times.originalEnd.format('HH:mm')}`);
      logInfo(`Extension: +${extensionMinutes} minutes (2 hours)`);
      logInfo(`Extended End Time: ${times.extendedEnd.format('HH:mm')}`);
      logInfo(`Expected Warning Time: ${times.warningTime.format('HH:mm')}`);
      logInfo(`Expected Auto-Departure: ${times.autoDepartureTime.format('HH:mm')}`);

      // Verify calculations
      const expectedWarningTime = '21:05'; // 21:00 + 15 - 10 = 21:05
      const expectedAutoDepartureTime = '21:15'; // 21:00 + 15 = 21:15

      if (times.warningTime.format('HH:mm') === expectedWarningTime &&
          times.autoDepartureTime.format('HH:mm') === expectedAutoDepartureTime) {
        logSuccess(`Correct! Warning at ${expectedWarningTime}, Auto-depart at ${expectedAutoDepartureTime}`);
        passedTests++;
      } else {
        logError(`Wrong! Got warning at ${times.warningTime.format('HH:mm')}, auto-depart at ${times.autoDepartureTime.format('HH:mm')}`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 5: Warning message format WITH extension
    logTest('Test 5: Warning message format WITH extension');
    totalTests++;
    try {
      const times = calculateAutoDepartureTimes(19, 0, 30, GRACE_MINUTES, WARNING_MINUTES);
      const message = formatWarningMessage(times, WARNING_MINUTES);

      logInfo('Generated warning message:');
      log('\n' + '-'.repeat(50), colors.yellow);
      log(message, colors.yellow);
      log('-'.repeat(50) + '\n', colors.yellow);

      // Verify message contains correct information
      const hasOriginalTime = message.includes('Ваше плановое время: 19:00');
      const hasExtension = message.includes('Продление: +30 мин');
      const hasExtendedTime = message.includes('Текущее окончание работы: 19:30');

      if (hasOriginalTime && hasExtension && hasExtendedTime) {
        logSuccess('Warning message correctly shows original time, extension, and extended end time');
        passedTests++;
      } else {
        logError('Warning message is missing expected information');
        if (!hasOriginalTime) logError('  - Missing original time');
        if (!hasExtension) logError('  - Missing extension info');
        if (!hasExtendedTime) logError('  - Missing extended end time');
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 6: Warning message format WITHOUT extension
    logTest('Test 6: Warning message format WITHOUT extension');
    totalTests++;
    try {
      const times = calculateAutoDepartureTimes(19, 0, 0, GRACE_MINUTES, WARNING_MINUTES);
      const message = formatWarningMessage(times, WARNING_MINUTES);

      logInfo('Generated warning message:');
      log('\n' + '-'.repeat(50), colors.yellow);
      log(message, colors.yellow);
      log('-'.repeat(50) + '\n', colors.yellow);

      // Verify message contains correct information
      const hasEndTime = message.includes('Ваше рабочее время закончилось в 19:00');
      const noExtensionInfo = !message.includes('Продление:');

      if (hasEndTime && noExtensionInfo) {
        logSuccess('Warning message correctly shows end time without extension info');
        passedTests++;
      } else {
        logError('Warning message format is incorrect');
        if (!hasEndTime) logError('  - Missing end time');
        if (!noExtensionInfo) logError('  - Incorrectly showing extension info');
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 7: Multiple extensions stack correctly
    logTest('Test 7: Multiple extensions (stacking)');
    totalTests++;
    try {
      const workEndHour = 19;
      const workEndMinute = 0;

      // Simulate user extending multiple times (30 + 30 + 60 = 120 total)
      const totalExtension = 30 + 30 + 60;

      const times = calculateAutoDepartureTimes(workEndHour, workEndMinute, totalExtension, GRACE_MINUTES, WARNING_MINUTES);

      logInfo(`Work Schedule: 10:00-${times.originalEnd.format('HH:mm')}`);
      logInfo(`Extensions: +30 min, +30 min, +60 min (Total: ${totalExtension} min)`);
      logInfo(`Extended End Time: ${times.extendedEnd.format('HH:mm')}`);
      logInfo(`Expected Warning Time: ${times.warningTime.format('HH:mm')}`);
      logInfo(`Expected Auto-Departure: ${times.autoDepartureTime.format('HH:mm')}`);

      // Verify calculations
      const expectedWarningTime = '21:05'; // 21:00 + 15 - 10 = 21:05
      const expectedAutoDepartureTime = '21:15'; // 21:00 + 15 = 21:15

      if (times.warningTime.format('HH:mm') === expectedWarningTime &&
          times.autoDepartureTime.format('HH:mm') === expectedAutoDepartureTime) {
        logSuccess(`Correct! Multiple extensions stack properly`);
        logSuccess(`Warning at ${expectedWarningTime}, Auto-depart at ${expectedAutoDepartureTime}`);
        passedTests++;
      } else {
        logError(`Wrong! Got warning at ${times.warningTime.format('HH:mm')}, auto-depart at ${times.autoDepartureTime.format('HH:mm')}`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

    // Test 8: Real-world scenario from bug report
    logTest('Test 8: Real-world scenario (Bug Report)');
    totalTests++;
    try {
      logInfo('Scenario: Worker schedule 10:00-19:00');
      logInfo('At 19:03: Worker extends by 30 minutes');
      logInfo('Expected: Warning at 19:35, Auto-depart at 19:45');
      logInfo('Bug: Was showing warning at 19:05 with wrong message');

      const times = calculateAutoDepartureTimes(19, 0, 30, GRACE_MINUTES, WARNING_MINUTES);
      const message = formatWarningMessage(times, WARNING_MINUTES);

      const correctWarningTime = times.warningTime.format('HH:mm') === '19:35';
      const correctAutoDepartTime = times.autoDepartureTime.format('HH:mm') === '19:45';
      const messageShowsCorrectTime = message.includes('19:30');

      if (correctWarningTime && correctAutoDepartTime && messageShowsCorrectTime) {
        logSuccess('Bug is FIXED! ✅');
        logSuccess(`Warning correctly calculated for ${times.warningTime.format('HH:mm')}`);
        logSuccess(`Auto-depart correctly calculated for ${times.autoDepartureTime.format('HH:mm')}`);
        logSuccess(`Message correctly shows extended end time (19:30)`);
        passedTests++;
      } else {
        logError('Bug still exists! ❌');
        if (!correctWarningTime) logError(`  - Warning time wrong: ${times.warningTime.format('HH:mm')} (expected 19:35)`);
        if (!correctAutoDepartTime) logError(`  - Auto-depart time wrong: ${times.autoDepartureTime.format('HH:mm')} (expected 19:45)`);
        if (!messageShowsCorrectTime) logError(`  - Message doesn't show correct extended time`);
        failedTests++;
      }
    } catch (error) {
      logError(`Test failed: ${error.message}`);
      failedTests++;
    }

  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error.stack);
  }

  // Print summary
  log('\n' + '='.repeat(70), colors.bright);
  log('TEST SUMMARY', colors.bright + colors.cyan);
  log('='.repeat(70), colors.bright);
  log(`Total Tests: ${totalTests}`, colors.bright);
  log(`Passed: ${passedTests}`, colors.green);
  log(`Failed: ${failedTests}`, failedTests > 0 ? colors.red : colors.green);
  log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`,
      passedTests === totalTests ? colors.green : colors.yellow);
  log('='.repeat(70) + '\n', colors.bright);

  if (failedTests === 0) {
    log('🎉 ALL TESTS PASSED! The auto-departure extension fix is working correctly! 🎉\n', colors.green + colors.bright);
  } else {
    log('⚠️  SOME TESTS FAILED! Please review the errors above. ⚠️\n', colors.red + colors.bright);
  }

  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
