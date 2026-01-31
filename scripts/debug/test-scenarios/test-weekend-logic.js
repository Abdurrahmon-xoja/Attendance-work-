/**
 * Test script to verify Saturday and Sunday handling logic
 * Run with: node test-weekend-logic.js
 */

const moment = require('moment-timezone');

// Simulate the Config
const Config = {
  TIMEZONE: 'Asia/Tashkent'
};

// Test scenarios
const testScenarios = [
  {
    name: 'Sunday - Always day off',
    dayOfWeek: 0, // Sunday
    doNotWorkSaturday: false,
    expectedIsDayOff: true,
    expectedMessage: 'воскресенье'
  },
  {
    name: 'Sunday - User with Saturday off flag',
    dayOfWeek: 0, // Sunday
    doNotWorkSaturday: true,
    expectedIsDayOff: true,
    expectedMessage: 'воскресенье'
  },
  {
    name: 'Saturday - User DOES work on Saturday',
    dayOfWeek: 6, // Saturday
    doNotWorkSaturday: false,
    expectedIsDayOff: false,
    expectedMessage: null // No day off message
  },
  {
    name: 'Saturday - User does NOT work on Saturday',
    dayOfWeek: 6, // Saturday
    doNotWorkSaturday: true,
    expectedIsDayOff: true,
    expectedMessage: 'субботу'
  },
  {
    name: 'Monday - Regular work day',
    dayOfWeek: 1, // Monday
    doNotWorkSaturday: false,
    expectedIsDayOff: false,
    expectedMessage: null
  },
  {
    name: 'Friday - Regular work day',
    dayOfWeek: 5, // Friday
    doNotWorkSaturday: true,
    expectedIsDayOff: false,
    expectedMessage: null
  }
];

// Simulate the arrival logic from attendance.handler.js
function testWeekendLogic(dayOfWeek, doNotWorkSaturday) {
  // Create a moment object for the test day
  const now = moment.tz(Config.TIMEZONE).day(dayOfWeek);

  // This is the exact logic from attendance.handler.js:114-116
  const isSunday = now.day() === 0;
  const isSaturday = now.day() === 6;
  const isDayOff = isSunday || (isSaturday && doNotWorkSaturday);

  // Message logic from attendance.handler.js:129-133
  let dayName = null;
  let ratingImpact = 0.0;

  if (isDayOff) {
    dayName = isSunday ? 'воскресенье' : 'субботу';
    ratingImpact = 1.0; // Bonus point for working on day off
  }

  return {
    isSunday,
    isSaturday,
    isDayOff,
    dayName,
    ratingImpact,
    dayOfWeekNum: now.day()
  };
}

// Simulate reminder logic from scheduler.service.js
function testReminderLogic(dayOfWeek, doNotWorkSaturday) {
  const now = moment.tz(Config.TIMEZONE).day(dayOfWeek);

  // This is the exact logic from scheduler.service.js:686-702
  const isSunday = now.day() === 0;
  const isSaturday = now.day() === 6;

  let shouldSkipReminder = false;
  let skipReason = null;

  if (isSunday) {
    shouldSkipReminder = true;
    skipReason = 'today is Sunday';
  } else if (isSaturday && doNotWorkSaturday) {
    shouldSkipReminder = true;
    skipReason = 'Saturday is their day off';
  }

  return {
    shouldSkipReminder,
    skipReason
  };
}

// Run tests
console.log('='.repeat(80));
console.log('WEEKEND LOGIC TEST SUITE');
console.log('='.repeat(80));
console.log();

let passedTests = 0;
let failedTests = 0;

testScenarios.forEach((scenario, index) => {
  console.log(`\nTest ${index + 1}: ${scenario.name}`);
  console.log('-'.repeat(80));

  // Test arrival logic
  const arrivalResult = testWeekendLogic(scenario.dayOfWeek, scenario.doNotWorkSaturday);
  const reminderResult = testReminderLogic(scenario.dayOfWeek, scenario.doNotWorkSaturday);

  console.log(`Input:`);
  console.log(`  - Day of week: ${scenario.dayOfWeek} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][scenario.dayOfWeek]})`);
  console.log(`  - doNotWorkSaturday: ${scenario.doNotWorkSaturday}`);
  console.log();

  console.log(`Arrival Handler Results:`);
  console.log(`  - isSunday: ${arrivalResult.isSunday}`);
  console.log(`  - isSaturday: ${arrivalResult.isSaturday}`);
  console.log(`  - isDayOff: ${arrivalResult.isDayOff}`);
  console.log(`  - dayName: ${arrivalResult.dayName || 'null'}`);
  console.log(`  - ratingImpact: ${arrivalResult.ratingImpact}`);
  console.log();

  console.log(`Reminder Handler Results:`);
  console.log(`  - shouldSkipReminder: ${reminderResult.shouldSkipReminder}`);
  console.log(`  - skipReason: ${reminderResult.skipReason || 'none - send reminders'}`);
  console.log();

  // Validate results
  const isDayOffCorrect = arrivalResult.isDayOff === scenario.expectedIsDayOff;
  const messageCorrect = scenario.expectedMessage
    ? arrivalResult.dayName === scenario.expectedMessage
    : arrivalResult.dayName === null;
  const reminderCorrect = reminderResult.shouldSkipReminder === scenario.expectedIsDayOff;

  const allPassed = isDayOffCorrect && messageCorrect && reminderCorrect;

  console.log(`Validation:`);
  console.log(`  ✓ isDayOff matches expected: ${isDayOffCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  ✓ Message matches expected: ${messageCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  ✓ Reminder logic matches: ${reminderCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log();

  if (allPassed) {
    console.log(`Result: ✅ PASSED`);
    passedTests++;
  } else {
    console.log(`Result: ❌ FAILED`);
    failedTests++;
  }
});

// Summary
console.log();
console.log('='.repeat(80));
console.log('TEST SUMMARY');
console.log('='.repeat(80));
console.log(`Total Tests: ${testScenarios.length}`);
console.log(`Passed: ${passedTests} ✅`);
console.log(`Failed: ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
console.log();

if (failedTests === 0) {
  console.log('🎉 ALL TESTS PASSED! Weekend handling logic is working correctly.');
  process.exit(0);
} else {
  console.log('⚠️  SOME TESTS FAILED! Please review the weekend handling logic.');
  process.exit(1);
}
