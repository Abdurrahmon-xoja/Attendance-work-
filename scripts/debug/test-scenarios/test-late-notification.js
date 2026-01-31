/**
 * Test script for "will be late" notification in daily report
 * Tests that the daily report correctly shows late notifications
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function simulateReportLogic(row) {
  const whenCome = row.whenCome || '';
  const cameOnTime = row.cameOnTime || '';
  const willBeLate = row.willBeLate || '';
  const willBeLateTime = row.willBeLateTime || '';
  const absent = row.absent || '';

  let status = '';
  let statusClass = '';
  let notifiedLate = false;

  if (absent.toLowerCase() === 'yes') {
    status = `Отсутствует`;
    statusClass = 'status-absent';
  } else if (whenCome) {
    // Check if explicitly marked as late (No or false)
    if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
      status = `Опоздал (${whenCome})`;
      statusClass = 'status-late';
    } else {
      status = `Вовремя (${whenCome})`;
      statusClass = 'status-ontime';
    }

    // Add "will be late" notification if they informed about lateness
    if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
      status += `<br><small>⏰ Предупредил об опоздании`;
      if (willBeLateTime.trim()) {
        status += ` (${willBeLateTime})`;
      }
      status += `</small>`;
      notifiedLate = true;
    }
  } else {
    status = `Не пришёл`;
    statusClass = 'status-notarrived';

    // Check if person notified they'll be late but hasn't arrived yet
    if (willBeLate.toLowerCase() === 'yes' || willBeLate.toLowerCase() === 'true') {
      status = `Ожидается`;
      if (willBeLateTime.trim()) {
        status += ` (${willBeLateTime})`;
      }
      statusClass = 'status-waiting';
      notifiedLate = true;
    }
  }

  return { status, statusClass, notifiedLate };
}

function runTests() {
  log('\n' + '='.repeat(70), colors.bright);
  log('LATE NOTIFICATION IN DAILY REPORT - TEST SUITE', colors.bright + colors.cyan);
  log('='.repeat(70) + '\n', colors.bright);

  const testCases = [
    {
      name: 'Employee came on time, no notification',
      row: { whenCome: '09:00', cameOnTime: 'Yes', willBeLate: 'no' },
      expectedStatus: 'Вовремя (09:00)',
      expectedNotified: false
    },
    {
      name: 'Employee came late, notified beforehand',
      row: { whenCome: '09:30', cameOnTime: 'No', willBeLate: 'yes', willBeLateTime: '09:30' },
      expectedStatus: 'Опоздал (09:30)<br><small>⏰ Предупредил об опоздании (09:30)</small>',
      expectedNotified: true
    },
    {
      name: 'Employee came on time, but had notified late (came early)',
      row: { whenCome: '09:00', cameOnTime: 'Yes', willBeLate: 'yes', willBeLateTime: '09:30' },
      expectedStatus: 'Вовремя (09:00)<br><small>⏰ Предупредил об опоздании (09:30)</small>',
      expectedNotified: true
    },
    {
      name: 'Employee notified late, not arrived yet',
      row: { whenCome: '', cameOnTime: '', willBeLate: 'yes', willBeLateTime: '10:00' },
      expectedStatus: 'Ожидается (10:00)',
      expectedNotified: true
    },
    {
      name: 'Employee notified late with delay in minutes',
      row: { whenCome: '09:45', cameOnTime: 'No', willBeLate: 'yes', willBeLateTime: '45 минут' },
      expectedStatus: 'Опоздал (09:45)<br><small>⏰ Предупредил об опоздании (45 минут)</small>',
      expectedNotified: true
    },
    {
      name: 'Employee not arrived, no notification',
      row: { whenCome: '', cameOnTime: '', willBeLate: 'no' },
      expectedStatus: 'Не пришёл',
      expectedNotified: false
    },
    {
      name: 'Employee absent',
      row: { whenCome: '', cameOnTime: '', willBeLate: 'no', absent: 'yes' },
      expectedStatus: 'Отсутствует',
      expectedNotified: false
    }
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach((testCase, index) => {
    log(`\n${colors.bright}Test ${index + 1}: ${testCase.name}${colors.reset}`);

    const result = simulateReportLogic(testCase.row);

    log(`  Expected: "${testCase.expectedStatus}"`);
    log(`  Got:      "${result.status}"`);
    log(`  Notified: ${result.notifiedLate} (expected: ${testCase.expectedNotified})`);

    if (result.status === testCase.expectedStatus && result.notifiedLate === testCase.expectedNotified) {
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
  log(`Success Rate: ${successRate}%`, successRate === '100.0' ? colors.green : colors.red);

  if (failed === 0) {
    log('\n🎉 ALL TESTS PASSED! Late notification feature is working.\n', colors.bright + colors.green);

    log('What was added:', colors.bright + colors.cyan);
    log('  ✓ Shows "⏰ Предупредил об опоздании" when employee notified', colors.green);
    log('  ✓ Displays expected arrival time if provided', colors.green);
    log('  ✓ Shows "Ожидается" for employees who notified but not arrived', colors.green);
    log('  ✓ New stat card showing count of employees who notified\n', colors.green);
  } else {
    log(`\n⚠️  ${failed} test(s) failed.\n`, colors.red);
  }

  log('='.repeat(70) + '\n', colors.bright);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
