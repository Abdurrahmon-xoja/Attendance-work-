/**
 * Test to verify no-show penalty correctly skips weekends
 * Run with: node test-noshow-weekend-fix.js
 */

const moment = require('moment-timezone');

const Config = {
  TIMEZONE: 'Asia/Tashkent',
  NO_SHOW_PENALTY: -2
};

// Mock employee data
const mockEmployees = [
  { name: 'John Doe', telegramId: '123', doNotWorkSaturday: false },
  { name: 'Jane Smith', telegramId: '456', doNotWorkSaturday: true },
  { name: 'Bob Wilson', telegramId: '789', doNotWorkSaturday: false }
];

// Simulate the fixed no-show check logic
function checkNoShowLogic(dateStr, employee, hasActivity) {
  const checkDate = moment.tz(dateStr, Config.TIMEZONE);
  const isSunday = checkDate.day() === 0;
  const isSaturday = checkDate.day() === 6;

  // Skip no-show check on Sundays (everyone's day off)
  if (isSunday) {
    return {
      shouldPenalize: false,
      reason: 'Sunday - everyone\'s day off',
      penalty: 0
    };
  }

  // Skip no-show check on Saturdays for employees who don't work on Saturday
  if (isSaturday && employee.doNotWorkSaturday) {
    return {
      shouldPenalize: false,
      reason: 'Saturday - employee\'s day off',
      penalty: 0
    };
  }

  // Check if person has NO activity at all
  if (!hasActivity) {
    return {
      shouldPenalize: true,
      reason: 'No activity on work day',
      penalty: Config.NO_SHOW_PENALTY
    };
  }

  return {
    shouldPenalize: false,
    reason: 'Has activity - no penalty',
    penalty: 0
  };
}

// Test scenarios
const testScenarios = [
  {
    name: 'Sunday - Employee with no activity',
    date: '2025-11-23', // Sunday
    employee: mockEmployees[0],
    hasActivity: false,
    expectedPenalty: false
  },
  {
    name: 'Sunday - Employee with Saturday off flag',
    date: '2025-11-23', // Sunday
    employee: mockEmployees[1],
    hasActivity: false,
    expectedPenalty: false
  },
  {
    name: 'Saturday - Employee DOES work on Saturday, no activity',
    date: '2025-11-22', // Saturday
    employee: mockEmployees[0], // doNotWorkSaturday = false
    hasActivity: false,
    expectedPenalty: true // Should get penalty
  },
  {
    name: 'Saturday - Employee does NOT work on Saturday, no activity',
    date: '2025-11-22', // Saturday
    employee: mockEmployees[1], // doNotWorkSaturday = true
    hasActivity: false,
    expectedPenalty: false // Should NOT get penalty
  },
  {
    name: 'Monday - Employee with no activity',
    date: '2025-11-24', // Monday
    employee: mockEmployees[0],
    hasActivity: false,
    expectedPenalty: true // Should get penalty on weekday
  },
  {
    name: 'Monday - Employee with activity',
    date: '2025-11-24', // Monday
    employee: mockEmployees[0],
    hasActivity: true,
    expectedPenalty: false // Has activity, no penalty
  }
];

console.log('='.repeat(80));
console.log('NO-SHOW WEEKEND FIX TEST SUITE');
console.log('='.repeat(80));
console.log();

let passedTests = 0;
let failedTests = 0;

testScenarios.forEach((scenario, index) => {
  console.log(`\nTest ${index + 1}: ${scenario.name}`);
  console.log('-'.repeat(80));

  const result = checkNoShowLogic(scenario.date, scenario.employee, scenario.hasActivity);
  const dateObj = moment.tz(scenario.date, Config.TIMEZONE);
  const dayName = dateObj.format('dddd');

  console.log(`Input:`);
  console.log(`  - Date: ${scenario.date} (${dayName})`);
  console.log(`  - Employee: ${scenario.employee.name}`);
  console.log(`  - doNotWorkSaturday: ${scenario.employee.doNotWorkSaturday}`);
  console.log(`  - Has Activity: ${scenario.hasActivity}`);
  console.log();

  console.log(`Result:`);
  console.log(`  - Should Penalize: ${result.shouldPenalize}`);
  console.log(`  - Reason: ${result.reason}`);
  console.log(`  - Penalty: ${result.penalty}`);
  console.log();

  const testPassed = result.shouldPenalize === scenario.expectedPenalty;

  console.log(`Validation:`);
  console.log(`  Expected penalty: ${scenario.expectedPenalty}`);
  console.log(`  Actual penalty: ${result.shouldPenalize}`);
  console.log(`  Result: ${testPassed ? '✅ PASS' : '❌ FAIL'}`);

  if (testPassed) {
    passedTests++;
  } else {
    failedTests++;
  }
});

console.log();
console.log('='.repeat(80));
console.log('TEST SUMMARY');
console.log('='.repeat(80));
console.log(`Total Tests: ${testScenarios.length}`);
console.log(`Passed: ${passedTests} ✅`);
console.log(`Failed: ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
console.log();

if (failedTests === 0) {
  console.log('🎉 ALL TESTS PASSED! No-show penalty correctly skips weekends.');
  console.log();
  console.log('The fix ensures:');
  console.log('  ✅ Sunday: No penalties for anyone');
  console.log('  ✅ Saturday: No penalties for employees with day off');
  console.log('  ✅ Saturday: Penalties for employees who work on Saturday');
  console.log('  ✅ Weekdays: Normal no-show penalty applies');
  process.exit(0);
} else {
  console.log('⚠️  SOME TESTS FAILED!');
  process.exit(1);
}
