/**
 * Job Registry
 * Exports all job modules for the scheduler
 */

const dailySheetJob = require('./dailySheet.job');
const monthlyReportJob = require('./monthlyReport.job');
const reminderChecksJob = require('./reminderChecks.job');
const noShowCheckJob = require('./noShowCheck.job');
const dailyReportToAdminsJob = require('./dailyReportToAdmins.job');
const monthlyReportToAdminsJob = require('./monthlyReportToAdmins.job');
const endOfDayArchivingJob = require('./endOfDayArchiving.job');

module.exports = {
  dailySheetJob,
  monthlyReportJob,
  reminderChecksJob,
  noShowCheckJob,
  dailyReportToAdminsJob,
  monthlyReportToAdminsJob,
  endOfDayArchivingJob
};
