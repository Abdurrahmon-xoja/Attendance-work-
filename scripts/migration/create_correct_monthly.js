const XLSX = require('xlsx');

const files = [
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-01.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-02.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-03.xlsx',
  '/Users/abdurrahmonxoja/Documents/IT/Telegram/Attandence/Data/attendance_2025-12-04.xlsx'
];

// Read roster for company and work schedule info
const rosterWb = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Untitled spreadsheet (1).xlsx');
const rosterWs = rosterWb.Sheets['Report_2025-12'];
const rosterData = XLSX.utils.sheet_to_json(rosterWs);

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
      // Get roster info
      const rosterRow = rosterData.find(r => r.Name && r.Name.trim() === name.trim());

      employees.set(name, {
        name: name,
        telegramId: row.TelegramId || (rosterRow ? rosterRow['Telegram ID'] : ''),
        company: rosterRow ? rosterRow.Company : '',
        workSchedule: rosterRow ? rosterRow['Work Schedule'] : '',
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
      whyAbsent: row['Why absent'] || '',
      leftEarly: row['Left early'] || '',
      penaltyMinutes: parseFloat(row['Penalty minutes']) || 0,
      point: parseFloat(row['Point']) || 0
    });
  });
});

// Calculate required hours (9 hours default for 9-18, 8.5 for 10-18:30)
function getRequiredHours(schedule) {
  if (!schedule) return 9;
  if (schedule.includes('10:00-18:30')) return 8.5;
  if (schedule.includes('9:00-18:00')) return 9;
  if (schedule.includes('10:00-19:00')) return 9;

  // Parse schedule
  const match = schedule.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (match) {
    const startHour = parseInt(match[1]);
    const startMin = parseInt(match[2]);
    const endHour = parseInt(match[3]);
    const endMin = parseInt(match[4]);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    return (endMinutes - startMinutes) / 60;
  }

  return 9;
}

// Calculate monthly totals
const monthlyRows = [];

employees.forEach((emp, name) => {
  let daysWorked = 0;
  let daysAbsent = 0;
  let daysAbsentNotified = 0;
  let daysAbsentSilent = 0;
  let onTimeArrivals = 0;
  let lateNotified = 0;
  let lateSilent = 0;
  let earlyDepartures = 0;
  let totalHoursWorked = 0;
  let totalHoursRequired = 0;
  let totalPenaltyMinutes = 0;
  let totalPoints = 0;
  let totalDeficitMinutes = 0;
  let totalSurplusMinutes = 0;

  const requiredHoursDaily = getRequiredHours(emp.workSchedule);

  emp.days.forEach(day => {
    // Days worked
    if (day.whenCome && day.whenCome.trim && day.whenCome.trim()) {
      daysWorked++;
      totalHoursRequired += requiredHoursDaily;

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
      if (day.whyAbsent && day.whyAbsent.trim()) {
        daysAbsentNotified++;
      } else {
        daysAbsentSilent++;
      }
    }

    // Early departures
    if (day.leftEarly === 'Yes' || day.leftEarly === 'TRUE' || day.leftEarly === true) {
      earlyDepartures++;
    }

    totalHoursWorked += day.hoursWorked;
    totalPenaltyMinutes += day.penaltyMinutes;
    totalPoints += day.point;

    // Calculate deficit/surplus
    if (day.hoursWorked > 0) {
      const diff = day.hoursWorked - requiredHoursDaily;
      const diffMinutes = Math.round(diff * 60);
      if (diffMinutes < 0) {
        totalDeficitMinutes += Math.abs(diffMinutes);
      } else if (diffMinutes > 0) {
        totalSurplusMinutes += diffMinutes;
      }
    }
  });

  const totalDays = emp.days.length;
  const attendanceRate = totalDays > 0 ? ((daysWorked / totalDays) * 100).toFixed(1) : '0.0';
  const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : '0.0';

  // Net balance
  const netBalanceMinutes = totalSurplusMinutes - totalDeficitMinutes - totalPenaltyMinutes;
  const absMinutes = Math.abs(netBalanceMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = Math.round(absMinutes % 60);
  const sign = netBalanceMinutes < 0 ? '-' : '+';
  const netBalanceHours = `${sign}${hours}:${minutes.toString().padStart(2, '0')}`;

  // Balance status
  let balanceStatus = '⚪ Balanced';
  if (netBalanceMinutes > 60) {
    balanceStatus = '🟢 Surplus';
  } else if (netBalanceMinutes < -60) {
    balanceStatus = '🔴 Deficit';
  }

  // Rating (0-10)
  let rating = Math.max(0, Math.min(10, totalPoints));

  // Rating zone
  let ratingZone = '🔴 Риск';
  if (rating >= 8) {
    ratingZone = '🟢 Отлично';
  } else if (rating >= 5) {
    ratingZone = '🟡 Норма';
  }

  monthlyRows.push({
    'Name': name,
    'Telegram ID': emp.telegramId,
    'Company': emp.company,
    'Work Schedule': emp.workSchedule,
    'Total Work Days': totalDays,
    'Days Worked': daysWorked,
    'Days Absent': daysAbsent,
    'Days Absent (Notified)': daysAbsentNotified,
    'Days Absent (Silent)': daysAbsentSilent,
    'On Time Arrivals': onTimeArrivals,
    'Late Arrivals (Notified)': lateNotified,
    'Late Arrivals (Silent)': lateSilent,
    'Early Departures': earlyDepartures,
    'Early Departures (Worked Full Hours)': 0,
    'Left Before Shift': 0,
    'Total Hours Required': totalHoursRequired.toFixed(2),
    'Total Hours Worked': totalHoursWorked.toFixed(2),
    'Hours Deficit/Surplus': (netBalanceMinutes / 60).toFixed(2),
    'Total Penalty Minutes': totalPenaltyMinutes,
    'Total Deficit Minutes': totalDeficitMinutes,
    'Total Surplus Minutes': totalSurplusMinutes,
    'Net Balance Minutes': netBalanceMinutes,
    'Net Balance (Hours)': netBalanceHours,
    'Balance Status': balanceStatus,
    'Total Points': totalPoints,
    'Average Daily Points': (totalDays > 0 ? (totalPoints / totalDays).toFixed(2) : '0.00'),
    'Attendance Rate %': attendanceRate,
    'On-Time Rate %': onTimeRate,
    'Rating (0-10)': rating.toFixed(1),
    'Rating Zone': ratingZone,
    'Last Updated': '2025-12-05 (CORRECTED)'
  });
});

// Create new workbook
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(monthlyRows);

// Add worksheet to workbook
XLSX.utils.book_append_sheet(wb, ws, 'Report_2025-12');

// Write to file
XLSX.writeFile(wb, '/Users/abdurrahmonxoja/Downloads/Corrected_Monthly_Report_2025-12.xlsx');

console.log('✅ Corrected monthly report created at:');
console.log('/Users/abdurrahmonxoja/Downloads/Corrected_Monthly_Report_2025-12.xlsx');
console.log('');
console.log('Summary of corrections:');
console.log('- Recalculated from all 4 daily sheets (Dec 1-4)');
console.log('- Fixed days worked counts');
console.log('- Fixed total hours worked');
console.log('- Fixed points/ratings');
console.log('- Corrected attendance rates');
console.log('- Fixed on-time rates');
