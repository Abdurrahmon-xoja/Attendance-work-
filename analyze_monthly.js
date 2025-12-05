const XLSX = require('xlsx');

const files = [
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-01.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-02.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-03.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-04.xlsx'
];

// Collect all employee data
const employees = new Map();

files.forEach((file, dayIndex) => {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws);

  data.forEach(row => {
    const name = row.Name;
    if (!name) return;

    if (!employees.has(name)) {
      employees.set(name, {
        name: name,
        telegramId: row.TelegramId || '',
        days: []
      });
    }

    employees.get(name).days.push({
      date: `Dec ${dayIndex + 1}`,
      cameOnTime: row['Came on time'] || '',
      whenCome: row['When come'] || '',
      leaveTime: row['Leave time'] || '',
      hoursWorked: parseFloat(row['Hours worked']) || 0,
      absent: row['Absent'] || '',
      willBeLate: row['will be late'] || '',
      penaltyMinutes: parseFloat(row['Penalty minutes']) || 0,
      point: parseFloat(row['Point']) || 0
    });
  });
});

// Calculate monthly totals
console.log('=== CORRECT MONTHLY CALCULATIONS ===\n');

const results = [];

employees.forEach((emp, name) => {
  let daysWorked = 0;
  let daysAbsent = 0;
  let daysAbsentNotified = 0;
  let daysAbsentSilent = 0;
  let onTimeArrivals = 0;
  let lateNotified = 0;
  let lateSilent = 0;
  let totalHoursWorked = 0;
  let totalPenaltyMinutes = 0;
  let totalPoints = 0;

  emp.days.forEach(day => {
    // Days worked
    if (day.whenCome && day.whenCome.trim && day.whenCome.trim()) {
      daysWorked++;

      // On time / Late
      if (day.cameOnTime === 'Yes' || day.cameOnTime === 'TRUE' || day.cameOnTime === true) {
        onTimeArrivals++;
      } else if (day.cameOnTime === 'No' || day.cameOnTime === 'FALSE' || day.cameOnTime === false) {
        if (day.willBeLate === 'Yes' || day.willBeLate === 'TRUE' || day.willBeLate === true) {
          lateNotified++;
        } else {
          lateSilent++;
        }
      }
    }

    // Days absent
    if (day.absent === 'Yes' || day.absent === 'TRUE' || day.absent === true) {
      daysAbsent++;
      if (day.willBeLate === 'Yes' || day.willBeLate === 'TRUE' || day.willBeLate === true) {
        daysAbsentNotified++;
      } else {
        daysAbsentSilent++;
      }
    }

    totalHoursWorked += day.hoursWorked;
    totalPenaltyMinutes += day.penaltyMinutes;
    totalPoints += day.point;
  });

  const totalDays = emp.days.length;
  const attendanceRate = totalDays > 0 ? ((daysWorked / totalDays) * 100).toFixed(1) : 0;
  const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : 0;

  results.push({
    name,
    telegramId: emp.telegramId,
    daysWorked,
    daysAbsent,
    daysAbsentNotified,
    daysAbsentSilent,
    onTimeArrivals,
    lateNotified,
    lateSilent,
    totalHoursWorked: totalHoursWorked.toFixed(2),
    totalPenaltyMinutes,
    totalPoints,
    attendanceRate,
    onTimeRate
  });

  console.log(`${name}:`);
  console.log(`  Days Worked: ${daysWorked}/${totalDays}`);
  console.log(`  Days Absent: ${daysAbsent} (Notified: ${daysAbsentNotified}, Silent: ${daysAbsentSilent})`);
  console.log(`  On Time: ${onTimeArrivals}, Late Notified: ${lateNotified}, Late Silent: ${lateSilent}`);
  console.log(`  Total Hours: ${totalHoursWorked.toFixed(2)}`);
  console.log(`  Total Penalty: ${totalPenaltyMinutes} min`);
  console.log(`  Total Points: ${totalPoints}`);
  console.log(`  Attendance Rate: ${attendanceRate}%`);
  console.log(`  On-Time Rate: ${onTimeRate}%`);
  console.log('');
});

// Read current monthly report
console.log('\n=== COMPARISON WITH CURRENT MONTHLY REPORT ===\n');
const currentMonthly = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Untitled spreadsheet (1).xlsx');
const monthlyWs = currentMonthly.Sheets['Report_2025-12'];
const monthlyData = XLSX.utils.sheet_to_json(monthlyWs);

monthlyData.slice(0, 5).forEach(row => {
  const correct = results.find(r => r.name.trim() === row.Name.trim());
  if (correct) {
    console.log(`${row.Name}:`);
    console.log(`  CURRENT: Days Worked=${row['Days Worked']}, Hours=${row['Total Hours Worked']}, Points=${row['Total Points']}`);
    console.log(`  CORRECT: Days Worked=${correct.daysWorked}, Hours=${correct.totalHoursWorked}, Points=${correct.totalPoints}`);
    console.log(`  ❌ WRONG!` + (row['Days Worked'] != correct.daysWorked ? ` Days (${row['Days Worked']} vs ${correct.daysWorked})` : '') + (parseFloat(row['Total Hours Worked']) != parseFloat(correct.totalHoursWorked) ? ` Hours (${row['Total Hours Worked']} vs ${correct.totalHoursWorked})` : '') + (row['Total Points'] != correct.totalPoints ? ` Points (${row['Total Points']} vs ${correct.totalPoints})` : ''));
    console.log('');
  }
});
