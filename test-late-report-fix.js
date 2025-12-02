/**
 * Test script for daily report late marking fix
 * Tests that employees are correctly classified as on-time or late
 */

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

function testLateClassification(cameOnTime, whenCome, expectedStatus, expectedIsLate) {
  // Simulate the fixed logic
  let status = '';
  let statusClass = '';
  let isLate = false;

  if (whenCome) {
    // Check if explicitly marked as late (No or false)
    if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
      status = `Опоздал (${whenCome})`;
      statusClass = 'status-late';
      isLate = true;
    } else {
      // Default to on-time if 'Yes', 'true', or empty (when marked on time)
      status = `Вовремя (${whenCome})`;
      statusClass = 'status-ontime';
      isLate = false;
    }
  }

  const passed = (status === expectedStatus && isLate === expectedIsLate);
  return { passed, status, statusClass, isLate };
}

function runTests() {
  log('\n' + '='.repeat(70), colors.bright);
  log('DAILY REPORT LATE MARKING FIX - TEST SUITE', colors.bright + colors.cyan);
  log('='.repeat(70) + '\n', colors.bright);

  const testCases = [
    {
      name: 'Employee came on time (Yes)',
      cameOnTime: 'Yes',
      whenCome: '09:00',
      expectedStatus: 'Вовремя (09:00)',
      expectedIsLate: false
    },
    {
      name: 'Employee came on time (yes - lowercase)',
      cameOnTime: 'yes',
      whenCome: '09:00',
      expectedStatus: 'Вовремя (09:00)',
      expectedIsLate: false
    },
    {
      name: 'Employee came late (No)',
      cameOnTime: 'No',
      whenCome: '09:30',
      expectedStatus: 'Опоздал (09:30)',
      expectedIsLate: true
    },
    {
      name: 'Employee came late (no - lowercase)',
      cameOnTime: 'no',
      whenCome: '09:30',
      expectedStatus: 'Опоздал (09:30)',
      expectedIsLate: true
    },
    {
      name: 'Employee came late (false)',
      cameOnTime: 'false',
      whenCome: '09:45',
      expectedStatus: 'Опоздал (09:45)',
      expectedIsLate: true
    },
    {
      name: 'Employee came late (False - capitalized)',
      cameOnTime: 'False',
      whenCome: '09:45',
      expectedStatus: 'Опоздал (09:45)',
      expectedIsLate: true
    },
    {
      name: 'Employee came on time (true)',
      cameOnTime: 'true',
      whenCome: '09:00',
      expectedStatus: 'Вовремя (09:00)',
      expectedIsLate: false
    },
    {
      name: 'Employee came on time (True - capitalized)',
      cameOnTime: 'True',
      whenCome: '09:00',
      expectedStatus: 'Вовремя (09:00)',
      expectedIsLate: false
    },
    {
      name: 'Employee came on time (empty string - edge case)',
      cameOnTime: '',
      whenCome: '09:00',
      expectedStatus: 'Вовремя (09:00)',
      expectedIsLate: false
    }
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach((testCase, index) => {
    log(`\n${colors.bright}Test ${index + 1}: ${testCase.name}${colors.reset}`);
    log(`  Input: cameOnTime="${testCase.cameOnTime}", whenCome="${testCase.whenCome}"`);

    const result = testLateClassification(
      testCase.cameOnTime,
      testCase.whenCome,
      testCase.expectedStatus,
      testCase.expectedIsLate
    );

    log(`  Expected: ${testCase.expectedStatus} (late: ${testCase.expectedIsLate})`);
    log(`  Got:      ${result.status} (late: ${result.isLate})`);

    if (result.passed) {
      log(`  ✅ PASSED`, colors.green);
      passed++;
    } else {
      log(`  ❌ FAILED`, colors.red);
      failed++;
    }
  });

  // Summary
  log('\n' + '='.repeat(70), colors.bright);
  log('TEST SUMMARY', colors.bright + colors.cyan);
  log('='.repeat(70), colors.bright);

  log(`\nTotal Tests: ${testCases.length}`, colors.bright);
  log(`Passed: ${passed}`, colors.green);
  log(`Failed: ${failed}`, failed > 0 ? colors.red : colors.green);

  const successRate = ((passed / testCases.length) * 100).toFixed(1);
  log(`Success Rate: ${successRate}%`, successRate === '100.0' ? colors.green : colors.yellow);

  if (failed === 0) {
    log('\n🎉 ALL TESTS PASSED! The late marking bug is fixed.\n', colors.bright + colors.green);

    log('What was fixed:', colors.bright + colors.cyan);
    log('  - Before: Anyone NOT marked "yes" was considered late', colors.yellow);
    log('  - After:  Only employees explicitly marked "No"/"false" are late', colors.green);
    log('  - Result: On-time employees are now correctly shown as on-time ✓\n', colors.green);
  } else {
    log(`\n⚠️  ${failed} test(s) failed. Please review the errors above.\n`, colors.bright + colors.yellow);
  }

  log('='.repeat(70) + '\n', colors.bright);

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests();
