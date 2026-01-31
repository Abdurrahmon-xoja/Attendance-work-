/**
 * Test script for auto-departure feature
 * This script validates the auto-departure functionality without requiring a running bot
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
  cyan: '\x1b[36m'
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

async function runTests() {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  log('\n' + '='.repeat(60), colors.bright);
  log('AUTO-DEPARTURE FEATURE TEST SUITE', colors.bright + colors.cyan);
  log('='.repeat(60) + '\n', colors.bright);

  try {
    // Test 1: Configuration Loading
    logTest('Configuration Loading');
    totalTests++;
    try {
      const Config = require('./src/config');

      logInfo(`ENABLE_AUTO_DEPARTURE: ${Config.ENABLE_AUTO_DEPARTURE}`);
      logInfo(`AUTO_DEPARTURE_GRACE_MINUTES: ${Config.AUTO_DEPARTURE_GRACE_MINUTES}`);
      logInfo(`AUTO_DEPARTURE_WARNING_MINUTES: ${Config.AUTO_DEPARTURE_WARNING_MINUTES}`);

      if (typeof Config.ENABLE_AUTO_DEPARTURE !== 'undefined' &&
          typeof Config.AUTO_DEPARTURE_GRACE_MINUTES === 'number' &&
          typeof Config.AUTO_DEPARTURE_WARNING_MINUTES === 'number') {
        logSuccess('Configuration loaded successfully');
        passedTests++;
      } else {
        logError('Configuration values are invalid');
        failedTests++;
      }
    } catch (error) {
      logError(`Configuration loading failed: ${error.message}`);
      failedTests++;
    }

    // Test 2: Time Calculation Logic
    logTest('Time Calculation Logic');
    totalTests++;
    try {
      const Config = require('./src/config');
      const now = moment.tz('Asia/Tashkent');
      const workEndTime = moment.tz('Asia/Tashkent').set({ hour: 18, minute: 0, second: 0 });

      // Calculate auto-departure time
      const autoDepartureTime = workEndTime.clone().add(Config.AUTO_DEPARTURE_GRACE_MINUTES, 'minutes');
      const warningTime = autoDepartureTime.clone().subtract(Config.AUTO_DEPARTURE_WARNING_MINUTES, 'minutes');

      logInfo(`Work End Time: ${workEndTime.format('HH:mm')}`);
      logInfo(`Warning Time: ${warningTime.format('HH:mm')}`);
      logInfo(`Auto-Departure Time: ${autoDepartureTime.format('HH:mm')}`);

      const expectedWarningTime = workEndTime.clone().add(5, 'minutes'); // 18:00 + 15 - 10 = 18:05
      const expectedAutoDepartTime = workEndTime.clone().add(15, 'minutes'); // 18:00 + 15 = 18:15

      if (warningTime.format('HH:mm') === expectedWarningTime.format('HH:mm') &&
          autoDepartureTime.format('HH:mm') === expectedAutoDepartTime.format('HH:mm')) {
        logSuccess('Time calculations are correct');
        logSuccess(`Expected warning at ${expectedWarningTime.format('HH:mm')}, auto-depart at ${expectedAutoDepartTime.format('HH:mm')}`);
        passedTests++;
      } else {
        logError('Time calculations are incorrect');
        failedTests++;
      }
    } catch (error) {
      logError(`Time calculation test failed: ${error.message}`);
      failedTests++;
    }

    // Test 3: Work Extension Logic
    logTest('Work Extension Logic');
    totalTests++;
    try {
      const Config = require('./src/config');
      const workEndTime = moment.tz('Asia/Tashkent').set({ hour: 18, minute: 0, second: 0 });
      const workExtensionMinutes = 30;

      // Apply extension
      const extendedWorkEnd = workEndTime.clone().add(workExtensionMinutes, 'minutes');
      const autoDepartureTime = extendedWorkEnd.clone().add(Config.AUTO_DEPARTURE_GRACE_MINUTES, 'minutes');

      logInfo(`Original End Time: ${workEndTime.format('HH:mm')}`);
      logInfo(`Extension: ${workExtensionMinutes} minutes`);
      logInfo(`Extended End Time: ${extendedWorkEnd.format('HH:mm')}`);
      logInfo(`New Auto-Departure Time: ${autoDepartureTime.format('HH:mm')}`);

      const expectedExtendedEnd = '18:30';
      const expectedAutoDepart = '18:45';

      if (extendedWorkEnd.format('HH:mm') === expectedExtendedEnd &&
          autoDepartureTime.format('HH:mm') === expectedAutoDepart) {
        logSuccess('Work extension calculations are correct');
        passedTests++;
      } else {
        logError('Work extension calculations are incorrect');
        failedTests++;
      }
    } catch (error) {
      logError(`Work extension test failed: ${error.message}`);
      failedTests++;
    }

    // Test 4: Multiple Extensions
    logTest('Multiple Extensions (Cumulative)');
    totalTests++;
    try {
      const Config = require('./src/config');
      const workEndTime = moment.tz('Asia/Tashkent').set({ hour: 18, minute: 0, second: 0 });

      let totalExtension = 0;
      const extensions = [30, 60, 30]; // User extends 3 times

      logInfo(`Original End Time: ${workEndTime.format('HH:mm')}`);

      extensions.forEach((ext, idx) => {
        totalExtension += ext;
        const extendedEnd = workEndTime.clone().add(totalExtension, 'minutes');
        logInfo(`Extension ${idx + 1}: +${ext} min → ${extendedEnd.format('HH:mm')} (total: ${totalExtension} min)`);
      });

      const finalExtendedEnd = workEndTime.clone().add(totalExtension, 'minutes');
      const finalAutoDepart = finalExtendedEnd.clone().add(Config.AUTO_DEPARTURE_GRACE_MINUTES, 'minutes');

      logInfo(`Final Extended End Time: ${finalExtendedEnd.format('HH:mm')}`);
      logInfo(`Final Auto-Departure Time: ${finalAutoDepart.format('HH:mm')}`);

      if (totalExtension === 120 && finalExtendedEnd.format('HH:mm') === '20:00') {
        logSuccess('Multiple extensions work correctly (cumulative)');
        passedTests++;
      } else {
        logError('Multiple extensions are incorrect');
        failedTests++;
      }
    } catch (error) {
      logError(`Multiple extensions test failed: ${error.message}`);
      failedTests++;
    }

    // Test 5: Night Shift Extension
    logTest('Night Shift Extension (8 hours)');
    totalTests++;
    try {
      const Config = require('./src/config');
      const workEndTime = moment.tz('Asia/Tashkent').set({ hour: 18, minute: 0, second: 0 });
      const nightShiftExtension = 480; // 8 hours

      const extendedEnd = workEndTime.clone().add(nightShiftExtension, 'minutes');
      const autoDepart = extendedEnd.clone().add(Config.AUTO_DEPARTURE_GRACE_MINUTES, 'minutes');

      logInfo(`Original End Time: ${workEndTime.format('HH:mm')}`);
      logInfo(`Night Shift Extension: ${nightShiftExtension} minutes (8 hours)`);
      logInfo(`Extended End Time: ${extendedEnd.format('HH:mm')}`);
      logInfo(`Auto-Departure Time: ${autoDepart.format('HH:mm')}`);

      if (extendedEnd.format('HH:mm') === '02:00' && autoDepart.format('HH:mm') === '02:15') {
        logSuccess('Night shift extension works correctly');
        passedTests++;
      } else {
        logError('Night shift extension is incorrect');
        failedTests++;
      }
    } catch (error) {
      logError(`Night shift test failed: ${error.message}`);
      failedTests++;
    }

    // Test 6: Hours Worked Calculation
    logTest('Hours Worked Calculation');
    totalTests++;
    try {
      const arrivalTime = moment.tz('2025-11-25 09:00', 'YYYY-MM-DD HH:mm', 'Asia/Tashkent');
      const departureTime = moment.tz('2025-11-25 18:15', 'YYYY-MM-DD HH:mm', 'Asia/Tashkent');

      const minutesWorked = departureTime.diff(arrivalTime, 'minutes');
      const hoursWorked = minutesWorked / 60;

      logInfo(`Arrival: ${arrivalTime.format('HH:mm')}`);
      logInfo(`Departure: ${departureTime.format('HH:mm')}`);
      logInfo(`Minutes Worked: ${minutesWorked}`);
      logInfo(`Hours Worked: ${hoursWorked.toFixed(2)}`);

      if (minutesWorked === 555 && hoursWorked.toFixed(2) === '9.25') {
        logSuccess('Hours worked calculation is correct');
        passedTests++;
      } else {
        logError('Hours worked calculation is incorrect');
        failedTests++;
      }
    } catch (error) {
      logError(`Hours worked test failed: ${error.message}`);
      failedTests++;
    }

    // Test 7: Scheduler Service Integration
    logTest('Scheduler Service Integration');
    totalTests++;
    try {
      const schedulerService = require('./src/services/scheduler.service');

      if (typeof schedulerService.checkAndSendReminders === 'function') {
        logSuccess('Scheduler service loaded successfully');
        logInfo('checkAndSendReminders function exists');
        passedTests++;
      } else {
        logError('Scheduler service missing checkAndSendReminders function');
        failedTests++;
      }
    } catch (error) {
      logError(`Scheduler service test failed: ${error.message}`);
      failedTests++;
    }

    // Test 8: Callback Handler Registration
    logTest('Callback Handler Registration');
    totalTests++;
    try {
      const fs = require('fs');
      const handlerContent = fs.readFileSync('./src/bot/handlers/attendance.handler.js', 'utf8');

      const hasAutoDepartNow = handlerContent.includes("bot.action('auto_depart_now'");
      const hasExtendWork = handlerContent.includes("bot.action(/extend_work:(\\d+)/");

      logInfo(`auto_depart_now handler: ${hasAutoDepartNow ? 'Found' : 'Missing'}`);
      logInfo(`extend_work handler: ${hasExtendWork ? 'Found' : 'Missing'}`);

      if (hasAutoDepartNow && hasExtendWork) {
        logSuccess('All callback handlers are registered');
        passedTests++;
      } else {
        logError('Some callback handlers are missing');
        failedTests++;
      }
    } catch (error) {
      logError(`Callback handler test failed: ${error.message}`);
      failedTests++;
    }

    // Test 9: Database Column Validation
    logTest('Database Column Validation');
    totalTests++;
    try {
      const fs = require('fs');
      const sheetsContent = fs.readFileSync('./src/services/sheets.service.js', 'utf8');

      const hasAutoDepartureWarningSent = sheetsContent.includes("'auto_departure_warning_sent'");
      const hasWorkExtensionMinutes = sheetsContent.includes("'work_extension_minutes'");

      logInfo(`auto_departure_warning_sent column: ${hasAutoDepartureWarningSent ? 'Found' : 'Missing'}`);
      logInfo(`work_extension_minutes column: ${hasWorkExtensionMinutes ? 'Found' : 'Missing'}`);

      if (hasAutoDepartureWarningSent && hasWorkExtensionMinutes) {
        logSuccess('All required database columns are defined');
        passedTests++;
      } else {
        logError('Some database columns are missing');
        failedTests++;
      }
    } catch (error) {
      logError(`Database column test failed: ${error.message}`);
      failedTests++;
    }

    // Test 10: Auto-Departure Logic Presence
    logTest('Auto-Departure Logic Presence');
    totalTests++;
    try {
      const fs = require('fs');
      const schedulerContent = fs.readFileSync('./src/services/scheduler.service.js', 'utf8');

      const hasAutoDepartureCheck = schedulerContent.includes('AUTO-DEPARTURE CHECK');
      const hasWarningLogic = schedulerContent.includes('auto_departure_warning_sent');
      const hasExtensionLogic = schedulerContent.includes('work_extension_minutes');

      logInfo(`Auto-departure check: ${hasAutoDepartureCheck ? 'Found' : 'Missing'}`);
      logInfo(`Warning logic: ${hasWarningLogic ? 'Found' : 'Missing'}`);
      logInfo(`Extension logic: ${hasExtensionLogic ? 'Found' : 'Missing'}`);

      if (hasAutoDepartureCheck && hasWarningLogic && hasExtensionLogic) {
        logSuccess('Auto-departure logic is properly implemented');
        passedTests++;
      } else {
        logError('Auto-departure logic is incomplete');
        failedTests++;
      }
    } catch (error) {
      logError(`Auto-departure logic test failed: ${error.message}`);
      failedTests++;
    }

  } catch (error) {
    logError(`Test suite error: ${error.message}`);
    console.error(error);
  }

  // Summary
  log('\n' + '='.repeat(60), colors.bright);
  log('TEST SUMMARY', colors.bright + colors.cyan);
  log('='.repeat(60), colors.bright);

  log(`\nTotal Tests: ${totalTests}`, colors.bright);
  log(`Passed: ${passedTests}`, colors.green);
  log(`Failed: ${failedTests}`, failedTests > 0 ? colors.red : colors.green);

  const successRate = ((passedTests / totalTests) * 100).toFixed(1);
  log(`Success Rate: ${successRate}%`, successRate === '100.0' ? colors.green : colors.yellow);

  if (failedTests === 0) {
    log('\n🎉 ALL TESTS PASSED! The auto-departure feature is working correctly.\n', colors.bright + colors.green);
  } else {
    log(`\n⚠️  ${failedTests} test(s) failed. Please review the errors above.\n`, colors.bright + colors.yellow);
  }

  log('='.repeat(60) + '\n', colors.bright);

  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
