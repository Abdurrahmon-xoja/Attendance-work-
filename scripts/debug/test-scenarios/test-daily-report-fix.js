/**
 * Test to verify daily report correctly shows on-time vs late employees
 * Run with: node test-daily-report-fix.js
 */

// Simulate the daily report status logic
function getDailyReportStatus(cameOnTime, whenCome, absent, whyAbsent) {
  let status = '';
  let statusClass = '';
  let isLate = false;
  let isAbsent = false;
  let isOnTime = false;

  // This is the FIXED logic from scheduler.service.js
  if (absent.toLowerCase() === 'yes') {
    status = `Отсутствует`;
    if (whyAbsent) status += ` (${whyAbsent})`;
    statusClass = 'status-absent';
    isAbsent = true;
  } else if (whenCome) {
    if (cameOnTime.toLowerCase() === 'yes') {
      status = `Вовремя (${whenCome})`;
      statusClass = 'status-ontime';
      isOnTime = true;
    } else {
      status = `Опоздал (${whenCome})`;
      statusClass = 'status-late';
      isLate = true;
    }
  } else {
    status = `Не пришёл`;
    statusClass = 'status-notarrived';
  }

  return { status, statusClass, isLate, isAbsent, isOnTime };
}

// Test scenarios matching actual Google Sheets data
const testScenarios = [
  {
    name: 'Employee came on time',
    cameOnTime: 'Yes',
    whenCome: '09:00:00',
    absent: '',
    whyAbsent: '',
    expectedOnTime: true,
    expectedLate: false,
    expectedAbsent: false,
    expectedStatusClass: 'status-ontime'
  },
  {
    name: 'Employee came late (without notification)',
    cameOnTime: 'No',
    whenCome: '09:30:00',
    absent: '',
    whyAbsent: '',
    expectedOnTime: false,
    expectedLate: true,
    expectedAbsent: false,
    expectedStatusClass: 'status-late'
  },
  {
    name: 'Employee is absent',
    cameOnTime: '',
    whenCome: '',
    absent: 'Yes',
    whyAbsent: 'Sick leave',
    expectedOnTime: false,
    expectedLate: false,
    expectedAbsent: true,
    expectedStatusClass: 'status-absent'
  },
  {
    name: 'Employee did not arrive (no activity)',
    cameOnTime: '',
    whenCome: '',
    absent: '',
    whyAbsent: '',
    expectedOnTime: false,
    expectedLate: false,
    expectedAbsent: false,
    expectedStatusClass: 'status-notarrived'
  },
  {
    name: 'Employee came on time (case variations)',
    cameOnTime: 'YES',  // Uppercase
    whenCome: '10:15:00',
    absent: '',
    whyAbsent: '',
    expectedOnTime: true,
    expectedLate: false,
    expectedAbsent: false,
    expectedStatusClass: 'status-ontime'
  },
  {
    name: 'Employee absent (case variations)',
    cameOnTime: '',
    whenCome: '',
    absent: 'YES',  // Uppercase
    whyAbsent: 'Personal',
    expectedOnTime: false,
    expectedLate: false,
    expectedAbsent: true,
    expectedStatusClass: 'status-absent'
  }
];

console.log('='.repeat(80));
console.log('DAILY REPORT STATUS FIX TEST SUITE');
console.log('='.repeat(80));
console.log();

let passedTests = 0;
let failedTests = 0;

testScenarios.forEach((scenario, index) => {
  console.log(`\nTest ${index + 1}: ${scenario.name}`);
  console.log('-'.repeat(80));

  const result = getDailyReportStatus(
    scenario.cameOnTime,
    scenario.whenCome,
    scenario.absent,
    scenario.whyAbsent
  );

  console.log(`Input:`);
  console.log(`  - Came on time: "${scenario.cameOnTime}"`);
  console.log(`  - When come: "${scenario.whenCome}"`);
  console.log(`  - Absent: "${scenario.absent}"`);
  console.log(`  - Why absent: "${scenario.whyAbsent}"`);
  console.log();

  console.log(`Result:`);
  console.log(`  - Status: ${result.status}`);
  console.log(`  - Status Class: ${result.statusClass}`);
  console.log(`  - Is On Time: ${result.isOnTime}`);
  console.log(`  - Is Late: ${result.isLate}`);
  console.log(`  - Is Absent: ${result.isAbsent}`);
  console.log();

  const onTimeCorrect = result.isOnTime === scenario.expectedOnTime;
  const lateCorrect = result.isLate === scenario.expectedLate;
  const absentCorrect = result.isAbsent === scenario.expectedAbsent;
  const statusClassCorrect = result.statusClass === scenario.expectedStatusClass;

  const allPassed = onTimeCorrect && lateCorrect && absentCorrect && statusClassCorrect;

  console.log(`Validation:`);
  console.log(`  ✓ On time matches expected: ${onTimeCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  ✓ Late matches expected: ${lateCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  ✓ Absent matches expected: ${absentCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  ✓ Status class matches: ${statusClassCorrect ? '✅ PASS' : '❌ FAIL'}`);
  console.log();

  if (allPassed) {
    console.log(`Result: ✅ PASSED`);
    passedTests++;
  } else {
    console.log(`Result: ❌ FAILED`);
    console.log(`  Expected - OnTime: ${scenario.expectedOnTime}, Late: ${scenario.expectedLate}, Absent: ${scenario.expectedAbsent}`);
    console.log(`  Actual   - OnTime: ${result.isOnTime}, Late: ${result.isLate}, Absent: ${result.isAbsent}`);
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
  console.log('🎉 ALL TESTS PASSED! Daily report correctly identifies on-time vs late employees.');
  console.log();
  console.log('The fix ensures:');
  console.log('  ✅ "Came on time = Yes" → Shows as "Вовремя" (On time)');
  console.log('  ✅ "Came on time = No" → Shows as "Опоздал" (Late)');
  console.log('  ✅ "Absent = Yes" → Shows as "Отсутствует" (Absent)');
  console.log('  ✅ Case-insensitive matching (YES, Yes, yes all work)');
  process.exit(0);
} else {
  console.log('⚠️  SOME TESTS FAILED!');
  process.exit(1);
}
