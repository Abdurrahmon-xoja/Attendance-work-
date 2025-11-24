/**
 * Test to verify 5-minute reminder checks work with standard work times
 * Tests work times: 09:00, 10:00, 11:00 (standard hourly schedules)
 * Run with: node test-5min-reminders.js
 */

const moment = require('moment-timezone');

const Config = {
  TIMEZONE: 'Asia/Tashkent'
};

// Simulate 5-minute check schedule
function generate5MinuteChecks(startHour, endHour) {
  const checks = [];
  for (let hour = startHour; hour <= endHour; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      checks.push(`${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`);
    }
  }
  return checks;
}

// Calculate reminder times for a work start time
function calculateReminderTimes(workStartTime) {
  const [hour, minute] = workStartTime.split(':').map(Number);
  const workStart = moment.tz(Config.TIMEZONE).set({ hour, minute, second: 0 });

  return {
    workStart: workStartTime,
    reminder1: workStart.clone().subtract(15, 'minutes').format('HH:mm'),
    reminder2: workStart.format('HH:mm'),
    reminder3: workStart.clone().add(15, 'minutes').format('HH:mm'),
    autoLate: workStart.clone().add(20, 'minutes').format('HH:mm')
  };
}

// Check if a reminder will be caught by 5-minute checks
function willReminderBeCaught(reminderTime, checkSchedule) {
  return checkSchedule.includes(reminderTime);
}

// Test work schedules (typical for this bot)
const testWorkTimes = [
  '09:00',  // 9 AM
  '10:00',  // 10 AM
  '11:00',  // 11 AM
  '14:00',  // 2 PM
  '08:30',  // 8:30 AM (half hour)
  '09:15',  // 9:15 AM (quarter hour)
  '09:07',  // 9:07 AM (edge case - would fail)
  '10:13',  // 10:13 AM (edge case - would fail)
];

console.log('='.repeat(80));
console.log('5-MINUTE REMINDER CHECK VERIFICATION TEST');
console.log('='.repeat(80));
console.log();
console.log('This test verifies that reminders work correctly with 5-minute checks.');
console.log('For your work times (09:00, 10:00, etc.), all reminders should be caught.');
console.log();

// Generate check schedule for 8 AM to 3 PM
const checkSchedule = generate5MinuteChecks(8, 15);

console.log('5-Minute Check Schedule:');
console.log(checkSchedule.slice(0, 20).join(', ') + '...');
console.log();
console.log('='.repeat(80));
console.log();

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

testWorkTimes.forEach((workTime, index) => {
  totalTests++;

  console.log(`\nTest ${index + 1}: Work Start Time = ${workTime}`);
  console.log('-'.repeat(80));

  const reminders = calculateReminderTimes(workTime);

  console.log(`Reminder Schedule:`);
  console.log(`  Reminder 1 (15 min before): ${reminders.reminder1}`);
  console.log(`  Reminder 2 (work starts):   ${reminders.reminder2}`);
  console.log(`  Reminder 3 (15 min after):  ${reminders.reminder3}`);
  console.log(`  Auto-late (20 min after):   ${reminders.autoLate}`);
  console.log();

  // Check each reminder
  const reminder1Caught = willReminderBeCaught(reminders.reminder1, checkSchedule);
  const reminder2Caught = willReminderBeCaught(reminders.reminder2, checkSchedule);
  const reminder3Caught = willReminderBeCaught(reminders.reminder3, checkSchedule);
  const autoLateCaught = willReminderBeCaught(reminders.autoLate, checkSchedule);

  console.log(`5-Minute Check Results:`);
  console.log(`  ${reminder1Caught ? '✅' : '❌'} Reminder 1 at ${reminders.reminder1} ${reminder1Caught ? 'WILL BE SENT' : 'WILL BE MISSED'}`);
  console.log(`  ${reminder2Caught ? '✅' : '❌'} Reminder 2 at ${reminders.reminder2} ${reminder2Caught ? 'WILL BE SENT' : 'WILL BE MISSED'}`);
  console.log(`  ${reminder3Caught ? '✅' : '❌'} Reminder 3 at ${reminders.reminder3} ${reminder3Caught ? 'WILL BE SENT' : 'WILL BE MISSED'}`);
  console.log(`  ${autoLateCaught ? '✅' : '❌'} Auto-late at ${reminders.autoLate} ${autoLateCaught ? 'WILL TRIGGER' : 'WILL BE MISSED'}`);
  console.log();

  const allCaught = reminder1Caught && reminder2Caught && reminder3Caught && autoLateCaught;

  if (allCaught) {
    console.log(`Result: ✅ PASSED - All reminders will work correctly`);
    passedTests++;
  } else {
    console.log(`Result: ❌ FAILED - Some reminders will be missed`);
    console.log(`⚠️  WARNING: Work time ${workTime} is NOT compatible with 5-minute checks!`);
    failedTests++;
  }
});

// Summary
console.log();
console.log('='.repeat(80));
console.log('TEST SUMMARY');
console.log('='.repeat(80));
console.log(`Total Work Times Tested: ${totalTests}`);
console.log(`Compatible (All reminders work): ${passedTests} ✅`);
console.log(`Incompatible (Some reminders missed): ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
console.log();

// Categorize results
const compatibleTimes = [];
const incompatibleTimes = [];

testWorkTimes.forEach((workTime) => {
  const reminders = calculateReminderTimes(workTime);
  const allCaught =
    willReminderBeCaught(reminders.reminder1, checkSchedule) &&
    willReminderBeCaught(reminders.reminder2, checkSchedule) &&
    willReminderBeCaught(reminders.reminder3, checkSchedule) &&
    willReminderBeCaught(reminders.autoLate, checkSchedule);

  if (allCaught) {
    compatibleTimes.push(workTime);
  } else {
    incompatibleTimes.push(workTime);
  }
});

console.log('✅ COMPATIBLE Work Times (5-minute checks work):');
compatibleTimes.forEach(time => {
  console.log(`   - ${time}`);
});
console.log();

if (incompatibleTimes.length > 0) {
  console.log('❌ INCOMPATIBLE Work Times (would need 1-minute checks):');
  incompatibleTimes.forEach(time => {
    console.log(`   - ${time}`);
  });
  console.log();
}

// User's specific case
console.log('='.repeat(80));
console.log('YOUR SPECIFIC CASE');
console.log('='.repeat(80));
console.log();
console.log('Based on your work times (09:00, 10:00):');
console.log();

const userWorkTimes = ['09:00', '10:00'];
let userAllGood = true;

userWorkTimes.forEach(workTime => {
  const reminders = calculateReminderTimes(workTime);
  const allCaught =
    willReminderBeCaught(reminders.reminder1, checkSchedule) &&
    willReminderBeCaught(reminders.reminder2, checkSchedule) &&
    willReminderBeCaught(reminders.reminder3, checkSchedule) &&
    willReminderBeCaught(reminders.autoLate, checkSchedule);

  console.log(`Work Time: ${workTime}`);
  console.log(`  Reminder 1: ${reminders.reminder1} ${willReminderBeCaught(reminders.reminder1, checkSchedule) ? '✅' : '❌'}`);
  console.log(`  Reminder 2: ${reminders.reminder2} ${willReminderBeCaught(reminders.reminder2, checkSchedule) ? '✅' : '❌'}`);
  console.log(`  Reminder 3: ${reminders.reminder3} ${willReminderBeCaught(reminders.reminder3, checkSchedule) ? '✅' : '❌'}`);
  console.log(`  Auto-late:  ${reminders.autoLate} ${willReminderBeCaught(reminders.autoLate, checkSchedule) ? '✅' : '❌'}`);
  console.log();

  if (!allCaught) {
    userAllGood = false;
  }
});

console.log('='.repeat(80));
if (userAllGood) {
  console.log('🎉 SUCCESS! All your work times are compatible with 5-minute checks!');
  console.log();
  console.log('Benefits:');
  console.log('  ✅ All reminders will be sent on time');
  console.log('  ✅ Auto-late marking works correctly');
  console.log('  ✅ API quota reduced by 80%');
  console.log('  ✅ No more quota errors');
  console.log();
  console.log('You can safely use 5-minute checks! 🚀');
  process.exit(0);
} else {
  console.log('⚠️  WARNING! Some of your work times won\'t work with 5-minute checks.');
  console.log('Consider either:');
  console.log('  1. Standardizing work times to round hours (09:00, 10:00, etc.)');
  console.log('  2. Reverting to 1-minute checks');
  console.log('  3. Fixing the code to use time ranges instead of exact matches');
  process.exit(1);
}
