/**
 * Integration test for daily report with late notifications
 * Simulates real daily report generation with actual data
 */

const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

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

// Simulate employee data from Google Sheets
const testEmployees = [
  {
    name: 'Иван Петров',
    cameOnTime: 'Yes',
    whenCome: '09:00',
    leaveTime: '18:00',
    hoursWorked: '9.00',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: 'no',
    willBeLateTime: '',
    point: '1.0'
  },
  {
    name: 'Анна Сидорова',
    cameOnTime: 'No',
    whenCome: '09:30',
    leaveTime: '18:30',
    hoursWorked: '9.00',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: 'yes',
    willBeLateTime: '09:30',
    point: '-0.5'
  },
  {
    name: 'Петр Иванов',
    cameOnTime: '',
    whenCome: '',
    leaveTime: '',
    hoursWorked: '0',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: 'yes',
    willBeLateTime: '10:00',
    point: '0'
  },
  {
    name: 'Мария Смирнова',
    cameOnTime: 'Yes',
    whenCome: '09:00',
    leaveTime: '',
    hoursWorked: '0',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: 'yes',
    willBeLateTime: '60 минут',
    point: '1.0'
  },
  {
    name: 'Алексей Козлов',
    cameOnTime: '',
    whenCome: '',
    leaveTime: '',
    hoursWorked: '0',
    leftEarly: '',
    absent: 'yes',
    whyAbsent: 'Болен',
    willBeLate: '',
    willBeLateTime: '',
    point: '-1.5'
  },
  {
    name: 'Ольга Новикова',
    cameOnTime: 'Yes',
    whenCome: '09:00',
    leaveTime: '16:00',
    hoursWorked: '7.00',
    leftEarly: 'yes',
    absent: '',
    whyAbsent: '',
    willBeLate: '',
    willBeLateTime: '',
    point: '-0.5'
  },
  {
    name: 'Дмитрий Волков',
    cameOnTime: 'No',
    whenCome: '09:45',
    leaveTime: '',
    hoursWorked: '0',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: '',
    willBeLateTime: '',
    point: '-1.0'
  },
  {
    name: 'Елена Морозова',
    cameOnTime: '',
    whenCome: '',
    leaveTime: '',
    hoursWorked: '0',
    leftEarly: '',
    absent: '',
    whyAbsent: '',
    willBeLate: '',
    willBeLateTime: '',
    point: '0'
  }
];

function generateDailyReport(rows, date) {
  const now = moment.tz('Asia/Tashkent');

  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let leftEarlyCount = 0;
  let notifiedLateCount = 0;

  let employeeRows = '';

  for (const row of rows) {
    const name = row.name || 'N/A';
    const cameOnTime = row.cameOnTime || '';
    const whenCome = row.whenCome || '';
    const leaveTime = row.leaveTime || '';
    const hoursWorked = row.hoursWorked || '0';
    const leftEarly = row.leftEarly || '';
    const absent = row.absent || '';
    const whyAbsent = row.whyAbsent || '';
    const willBeLate = row.willBeLate || '';
    const willBeLateTime = row.willBeLateTime || '';
    const point = row.point || '0';
    const pointNum = parseFloat(point);

    let status = '';
    let statusClass = '';
    let pointClass = '';

    if (absent.toLowerCase() === 'yes') {
      status = `Отсутствует`;
      if (whyAbsent) status += ` (${whyAbsent})`;
      statusClass = 'status-absent';
      absentCount++;
    } else if (whenCome) {
      // Check if explicitly marked as late (No or false)
      if (cameOnTime.toLowerCase() === 'no' || cameOnTime.toLowerCase() === 'false') {
        status = `Опоздал (${whenCome})`;
        statusClass = 'status-late';
        lateCount++;
      } else {
        // Default to on-time if 'Yes', 'true', or empty (when marked on time)
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
        notifiedLateCount++;
      }

      presentCount++;

      if (leaveTime) {
        status += `<br><small>Ушёл: ${leaveTime} (${hoursWorked}ч)`;
        if (leftEarly && leftEarly.toLowerCase().includes('yes')) {
          status += ` - Рано`;
          leftEarlyCount++;
        }
        status += `</small>`;
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
        notifiedLateCount++;
      }
    }

    if (pointNum > 0) {
      pointClass = 'point-good';
    } else if (pointNum === 0) {
      pointClass = 'point-neutral';
    } else {
      pointClass = 'point-bad';
    }

    employeeRows += `
      <tr>
        <td>${name}</td>
        <td class="${statusClass}">${status}</td>
        <td class="${pointClass}">${point}</td>
      </tr>
    `;
  }

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Дневной отчёт - ${date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; text-align: center; }
    .header h1 { font-size: 36px; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .header .date { font-size: 20px; opacity: 0.9; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
    .stat-card { background: white; padding: 25px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; transition: transform 0.3s ease; }
    .stat-card:hover { transform: translateY(-5px); }
    .stat-card .number { font-size: 36px; font-weight: bold; margin-bottom: 10px; }
    .stat-card .label { color: #6c757d; font-size: 14px; }
    .stat-total .number { color: #667eea; }
    .stat-present .number { color: #10b981; }
    .stat-late .number { color: #f59e0b; }
    .stat-absent .number { color: #ef4444; }
    .stat-early .number { color: #8b5cf6; }
    .stat-notified .number { color: #3b82f6; }
    .table-container { padding: 30px; overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 10px; }
    thead th { background: #667eea; color: white; padding: 15px; text-align: left; font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 1px; }
    thead th:first-child { border-radius: 10px 0 0 10px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    tbody tr { background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: all 0.3s ease; }
    tbody tr:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); transform: scale(1.01); }
    tbody td { padding: 20px 15px; border-top: 1px solid #f1f3f5; border-bottom: 1px solid #f1f3f5; }
    tbody td:first-child { font-weight: 600; color: #2d3748; border-left: 1px solid #f1f3f5; border-radius: 10px 0 0 10px; }
    tbody td:last-child { border-right: 1px solid #f1f3f5; border-radius: 0 10px 10px 0; text-align: center; font-weight: bold; font-size: 18px; }
    .status-ontime { color: #10b981; font-weight: 500; }
    .status-late { color: #f59e0b; font-weight: 500; }
    .status-absent { color: #ef4444; font-weight: 500; }
    .status-notarrived { color: #94a3b8; font-weight: 500; }
    .status-waiting { color: #3b82f6; font-weight: 500; }
    .point-good { color: #10b981; }
    .point-neutral { color: #f59e0b; }
    .point-bad { color: #ef4444; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📅 Дневной отчёт</h1>
      <div class="date">${date} • ${now.format('HH:mm:ss')}</div>
    </div>
    <div class="stats">
      <div class="stat-card stat-total"><div class="number">${rows.length}</div><div class="label">Всего сотрудников</div></div>
      <div class="stat-card stat-present"><div class="number">${presentCount}</div><div class="label">Присутствуют</div></div>
      <div class="stat-card stat-late"><div class="number">${lateCount}</div><div class="label">Опоздали</div></div>
      <div class="stat-card stat-notified"><div class="number">${notifiedLateCount}</div><div class="label">Предупредили</div></div>
      <div class="stat-card stat-absent"><div class="number">${absentCount}</div><div class="label">Отсутствуют</div></div>
      <div class="stat-card stat-early"><div class="number">${leftEarlyCount}</div><div class="label">Ушли рано</div></div>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>Сотрудник</th><th>Статус</th><th>Баллы</th></tr></thead>
        <tbody>${employeeRows}</tbody>
      </table>
    </div>
    <div class="footer">Сгенерировано системой учёта посещаемости • ${now.format('DD.MM.YYYY HH:mm:ss')}</div>
  </div>
</body>
</html>`;

  return {
    html,
    stats: {
      total: rows.length,
      present: presentCount,
      late: lateCount,
      notified: notifiedLateCount,
      absent: absentCount,
      leftEarly: leftEarlyCount
    }
  };
}

async function runIntegrationTest() {
  log('\n' + '='.repeat(80), colors.bright);
  log('DAILY REPORT WITH LATE NOTIFICATIONS - INTEGRATION TEST', colors.bright + colors.cyan);
  log('='.repeat(80) + '\n', colors.bright);

  const testDate = '2025-11-25';

  log('📊 Test Data Overview:', colors.bright + colors.blue);
  log('─'.repeat(80));

  testEmployees.forEach((emp, idx) => {
    log(`${idx + 1}. ${emp.name}`, colors.bright);
    log(`   Arrival: ${emp.whenCome || 'Not arrived'}`, emp.whenCome ? colors.green : colors.yellow);
    log(`   On-time: ${emp.cameOnTime || 'N/A'}`);
    log(`   Notified Late: ${emp.willBeLate === 'yes' ? 'YES (' + emp.willBeLateTime + ')' : 'No'}`,
        emp.willBeLate === 'yes' ? colors.blue : colors.reset);
    log(`   Absent: ${emp.absent === 'yes' ? 'YES' : 'No'}`, emp.absent === 'yes' ? colors.red : colors.reset);
    log('');
  });

  log('\n📝 Generating Daily Report...', colors.bright + colors.cyan);

  const report = generateDailyReport(testEmployees, testDate);

  log('\n✅ Report Generated Successfully!', colors.green);
  log('\n📈 Statistics:', colors.bright + colors.magenta);
  log('─'.repeat(80));
  log(`Total Employees:     ${report.stats.total}`, colors.bright);
  log(`Present:             ${report.stats.present}`, colors.green);
  log(`Late:                ${report.stats.late}`, colors.yellow);
  log(`Notified Late:       ${report.stats.notified}`, colors.blue);
  log(`Absent:              ${report.stats.absent}`, colors.red);
  log(`Left Early:          ${report.stats.leftEarly}`, colors.magenta);

  // Save HTML file
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `test_daily_report_${testDate}.html`;
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, report.html, 'utf8');

  log('\n💾 HTML Report Saved:', colors.bright + colors.cyan);
  log(`   ${filepath}`, colors.cyan);

  // Verify critical features
  log('\n🔍 Verification Checks:', colors.bright + colors.cyan);
  log('─'.repeat(80));

  const checks = [
    {
      name: 'Late notification text present',
      test: report.html.includes('⏰ Предупредил об опоздании'),
      expected: true
    },
    {
      name: 'Waiting status present',
      test: report.html.includes('Ожидается'),
      expected: true
    },
    {
      name: 'Notified count in stats',
      test: report.html.includes('Предупредили'),
      expected: true
    },
    {
      name: 'Status-waiting CSS class',
      test: report.html.includes('status-waiting'),
      expected: true
    },
    {
      name: 'Stat-notified CSS class',
      test: report.html.includes('stat-notified'),
      expected: true
    },
    {
      name: 'Notified count matches',
      test: report.stats.notified === 3,
      expected: true
    },
    {
      name: 'Late count correct',
      test: report.stats.late === 2,
      expected: true
    },
    {
      name: 'Present count correct',
      test: report.stats.present === 5,
      expected: true
    }
  ];

  let passedChecks = 0;
  let failedChecks = 0;

  checks.forEach((check, idx) => {
    const passed = check.test === check.expected;
    if (passed) {
      log(`  ${idx + 1}. ✅ ${check.name}`, colors.green);
      passedChecks++;
    } else {
      log(`  ${idx + 1}. ❌ ${check.name}`, colors.red);
      log(`     Expected: ${check.expected}, Got: ${check.test}`, colors.red);
      failedChecks++;
    }
  });

  // Summary
  log('\n' + '='.repeat(80), colors.bright);
  log('TEST SUMMARY', colors.bright + colors.cyan);
  log('='.repeat(80), colors.bright);

  log(`\nTotal Checks: ${checks.length}`, colors.bright);
  log(`Passed: ${passedChecks}`, colors.green);
  log(`Failed: ${failedChecks}`, failedChecks > 0 ? colors.red : colors.green);

  const successRate = ((passedChecks / checks.length) * 100).toFixed(1);
  log(`Success Rate: ${successRate}%`, successRate === '100.0' ? colors.green : colors.yellow);

  if (failedChecks === 0) {
    log('\n🎉 ALL INTEGRATION TESTS PASSED!', colors.bright + colors.green);
    log('\nThe daily report correctly shows:', colors.bright + colors.cyan);
    log('  ✓ Late notification indicator (⏰ Предупредил об опоздании)', colors.green);
    log('  ✓ Expected arrival time for late employees', colors.green);
    log('  ✓ "Ожидается" status for employees who notified but not arrived', colors.green);
    log('  ✓ Notification count in statistics (3 employees notified)', colors.green);
    log('  ✓ Proper styling and CSS classes', colors.green);
    log(`\n📄 Open the HTML file to view the report visually:`, colors.bright + colors.blue);
    log(`   ${filepath}\n`, colors.blue);
  } else {
    log(`\n⚠️  ${failedChecks} check(s) failed.\n`, colors.red);
  }

  log('='.repeat(80) + '\n', colors.bright);

  process.exit(failedChecks > 0 ? 1 : 0);
}

runIntegrationTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
