/**
 * End of Day Archiving Job
 * Runs at 00:00 every day (midnight) to archive the previous day
 * Steps:
 * 1. Handle overnight workers (auto-end at 23:59)
 * 2. Wait 2 minutes for responses
 * 3. Transfer data to monthly report
 * 4. Send report to Telegram group (Excel file)
 * 5. Delete daily sheet
 */

const moment = require('moment-timezone');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sheetsService = require('../../sheets.service');
const Config = require('../../../config');
const logger = require('../../../utils/logger');

// Schedule: Every day at 00:00 (midnight)
const schedule = '0 0 * * *';

/**
 * Handle employees who are still working at midnight
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance
 * @returns {number} Number of overnight workers handled
 */
async function handleOvernightWorkers(dateStr, schedulerService) {
  try {
    const worksheet = await sheetsService.getWorksheet(dateStr);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    let overnightCount = 0;
    const CalculatorService = require('../../calculator.service');
    const { Markup } = require('telegraf');

    for (const row of rows) {
      const name = row.get('Name') || '';
      const telegramId = row.get('TelegramId') || '';
      const whenCome = row.get('When come') || '';
      const leaveTime = row.get('Leave time') || '';

      // Check if person arrived but didn't leave
      if (whenCome.trim() && !leaveTime.trim() && telegramId.trim()) {
        overnightCount++;

        // Set leave time to 23:59 (end of day at midnight)
        const endTime = '23:59';
        row.set('Leave time', endTime);

        // Calculate hours worked
        const arrivalTime = moment.tz(`${dateStr} ${whenCome}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
        const departureTime = moment.tz(`${dateStr} ${endTime}`, 'YYYY-MM-DD HH:mm', Config.TIMEZONE);
        const minutesWorked = departureTime.diff(arrivalTime, 'minutes');
        const hoursWorked = minutesWorked / 60;
        row.set('Hours worked', hoursWorked.toFixed(2));

        await row.save();

        logger.info(`Auto-ended work for overnight worker: ${name} (${telegramId}) at ${endTime}`);

        // FIX #4: Send notification with button using safe method
        if (schedulerService.bot) {
          const tomorrow = moment.tz(dateStr, Config.TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
          const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY');
          const formattedTomorrow = moment.tz(tomorrow, 'YYYY-MM-DD', Config.TIMEZONE).format('DD.MM.YYYY');

          const sent = await schedulerService.sendMessageSafe(
            telegramId,
            `⚠️ Ваше рабочее время автоматически завершено\n\n` +
            `📅 Дата: ${formattedDate}\n` +
            `🕐 Время окончания: ${endTime}\n` +
            `⏱ Отработано: ${CalculatorService.formatTimeDiff(minutesWorked)}\n\n` +
            `Если вы всё ещё работаете ночную смену, нажмите кнопку ниже, чтобы отметить приход на новый день (${formattedTomorrow}):`,
            Markup.inlineKeyboard([
              [Markup.button.callback('✅ Я всё ещё здесь - Отметить приход', `overnight_still_working:${tomorrow}`)]
            ])
          );
          if (!sent) {
            logger.warn(`Could not send overnight notification to ${telegramId} - user blocked or unreachable`);
          }
        }

        // Add delay to avoid rate limiting and network exhaustion
        await new Promise(resolve => setTimeout(resolve, 2000)); // Increased from 500ms to 2s
      }
    }

    logger.info(`Handled ${overnightCount} overnight workers on ${dateStr}`);
    return overnightCount;
  } catch (error) {
    logger.error(`Error handling overnight workers: ${error.message}`);
    return 0;
  }
}

/**
 * Transfer daily data to monthly report
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {boolean} True if successful
 */
async function transferDailyDataToMonthly(dateStr) {
  try {
    const yearMonth = moment.tz(dateStr, Config.TIMEZONE).format('YYYY-MM');
    const reportSheetName = `Report_${yearMonth}`;

    // Ensure monthly report exists
    let monthlySheet = sheetsService.doc.sheetsByTitle[reportSheetName];
    if (!monthlySheet) {
      logger.info(`Creating monthly report ${reportSheetName}`);
      await sheetsService.initializeMonthlyReport(yearMonth);
      monthlySheet = await sheetsService.getWorksheet(reportSheetName);
    } else {
      monthlySheet = await sheetsService.getWorksheet(reportSheetName);
    }

    // Get daily data
    const dailySheet = await sheetsService.getWorksheet(dateStr);
    await dailySheet.loadHeaderRow();
    const dailyRows = await dailySheet.getRows();

    // Load monthly sheet
    await monthlySheet.loadHeaderRow();
    const monthlyRows = await monthlySheet.getRows();

    // Transfer data for each employee
    for (const dailyRow of dailyRows) {
      const telegramId = (dailyRow.get('TelegramId') || '').toString().trim();
      const name = dailyRow.get('Name') || '';

      if (!telegramId && !name) continue;

      // Find employee in monthly report (note: column is 'Telegram ID' not 'Telegram Id')
      let monthlyRow = monthlyRows.find(row => {
        const rowTelegramId = (row.get('Telegram ID') || '').toString().trim();
        const rowName = row.get('Name') || '';
        return (telegramId && rowTelegramId === telegramId) || rowName === name;
      });

      // FIX #5: Auto-add employee to monthly report if missing
      if (!monthlyRow) {
        logger.warn(`Employee ${name} (${telegramId}) not found in monthly report - auto-adding now`);

        try {
          // Get employee info from roster to populate initial data
          const roster = await sheetsService.getWorksheet(Config.SHEET_ROSTER);
          await roster.loadHeaderRow();
          const rosterRows = await roster.getRows();

          let workSchedule = '';
          let company = '';
          let doNotWorkSaturday = false;

          // Find employee in roster
          for (const rosterRow of rosterRows) {
            const rosterTelegramId = (rosterRow.get('Telegram Id') || '').toString().trim();
            const rosterName = (rosterRow.get('Name full') || '').toString().trim();

            if ((telegramId && rosterTelegramId === telegramId) || rosterName === name) {
              workSchedule = rosterRow.get('Work time') || '';
              company = rosterRow.get('Company') || '';
              doNotWorkSaturday = (rosterRow.get('Do not work in Saturday') || '').toString().toLowerCase().trim() === 'yes';
              break;
            }
          }

          // Calculate Total Work Days using same calendar logic as initializeMonthlyReport
          let totalWorkDays = 0;
          const monthStart = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).startOf('month');
          const monthEnd = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).endOf('month');

          for (let day = monthStart.clone(); day.isSameOrBefore(monthEnd); day.add(1, 'day')) {
            const dayOfWeek = day.day();
            if (dayOfWeek === 0) continue; // Skip Sundays
            if (dayOfWeek === 6 && doNotWorkSaturday) continue; // Skip Saturdays if configured
            totalWorkDays++;
          }

          // Calculate Total Hours Required from work schedule
          let dailyHours = 8; // Default
          if (workSchedule && workSchedule !== '-') {
            try {
              const times = workSchedule.split('-');
              const [startHour, startMin] = times[0].trim().split(':').map(Number);
              const [endHour, endMin] = times[1].trim().split(':').map(Number);
              dailyHours = (endHour + endMin / 60) - (startHour + startMin / 60);
            } catch (err) {
              // Use default 8 hours
            }
          }
          const totalHoursRequired = totalWorkDays * dailyHours;

          // Add new row to monthly report
          monthlyRow = await monthlySheet.addRow({
            'Name': name,
            'Telegram ID': telegramId,
            'Company': company,
            'Work Schedule': workSchedule,
            'Total Work Days': totalWorkDays,
            'Days Worked': 0,
            'Days In Office': 0,
            'Days On Site': 0,
            'Days Absent': 0,
            'Days Absent (Notified)': 0,
            'Days Absent (Silent)': 0,
            'On Time Arrivals': 0,
            'Late Arrivals (Notified)': 0,
            'Late Arrivals (Silent)': 0,
            'Early Departures': 0,
            'Early Departures (Worked Full Hours)': 0,
            'Left Before Shift': 0,
            'Total Hours Required': totalHoursRequired.toFixed(2),
            'Total Hours Worked': 0,
            'Total Points': 0,
            'Average Daily Points': 0,
            'Attendance Rate %': 0,
            'On-Time Rate %': 0,
            'Rating (0-10)': 0,
            'Rating Zone': '⚪',
            'Last Updated': ''
          });

          // Add to the monthlyRows array so we can continue processing
          monthlyRows.push(monthlyRow);

          logger.info(`✅ Successfully added ${name} to monthly report ${reportSheetName}`);
        } catch (addError) {
          logger.error(`Failed to auto-add employee ${name} to monthly report: ${addError.message}`);
          continue; // Skip this employee if we can't add them
        }
      }

      // Get daily data
      const hoursWorked = parseFloat(dailyRow.get('Hours worked') || '0');
      const cameOnTime = dailyRow.get('Came on time') || '';
      const absent = dailyRow.get('Absent') || '';
      const whenCome = dailyRow.get('When come') || '';
      const willBeLate = dailyRow.get('will be late') || '';
      const leftEarly = dailyRow.get('Left early') || '';
      const point = parseFloat(dailyRow.get('Point') || '0');
      const penaltyMinutes = parseFloat(dailyRow.get('Penalty minutes') || '0');
      const remainingHours = parseFloat(dailyRow.get('Remaining hours to work') || '0');
      const locationName = (dailyRow.get('Location Name') || '').trim();

      // Get required hours for this day from roster
      // FIXED: Calculate required hours for ALL days, not just days when employee came
      let requiredHoursDaily = 0;
      const workSchedule = monthlyRow.get('Work Schedule') || '';
      if (workSchedule) {
        // Parse work schedule (e.g., "09:00-18:00")
        const scheduleMatch = workSchedule.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
        if (scheduleMatch) {
          const startHour = parseInt(scheduleMatch[1]);
          const startMin = parseInt(scheduleMatch[2]);
          const endHour = parseInt(scheduleMatch[3]);
          const endMin = parseInt(scheduleMatch[4]);
          const startMinutes = startHour * 60 + startMin;
          const endMinutes = endHour * 60 + endMin;
          requiredHoursDaily = (endMinutes - startMinutes) / 60;
        }
      }

      // Update Days Worked
      if (whenCome.trim()) {
        const current = parseInt(monthlyRow.get('Days Worked') || '0');
        monthlyRow.set('Days Worked', current + 1);

        // Update Days In Office / Days On Site based on Location Name
        if (locationName !== '') {
          const currentOnSite = parseInt(monthlyRow.get('Days On Site') || '0');
          monthlyRow.set('Days On Site', currentOnSite + 1);
        } else {
          const currentInOffice = parseInt(monthlyRow.get('Days In Office') || '0');
          monthlyRow.set('Days In Office', currentInOffice + 1);
        }
      }

      // Update Days Absent
      if (absent.toLowerCase() === 'yes' || absent.toLowerCase() === 'true') {
        const current = parseInt(monthlyRow.get('Days Absent') || '0');
        monthlyRow.set('Days Absent', current + 1);

        // Check if notified or silent
        // "will be late" is NOT an absence notification — only a real absence reason counts
        const whyAbsent = dailyRow.get('Why absent') || '';
        const isNoShow = whyAbsent.toLowerCase().includes('no-show');
        if (whyAbsent.trim() && !isNoShow) {
          // Employee provided a real absence reason (e.g. sick, personal) → notified
          const notified = parseInt(monthlyRow.get('Days Absent (Notified)') || '0');
          monthlyRow.set('Days Absent (Notified)', notified + 1);
        } else {
          // No reason, or no-show (including "said late but didn't come") → silent
          const silent = parseInt(monthlyRow.get('Days Absent (Silent)') || '0');
          monthlyRow.set('Days Absent (Silent)', silent + 1);
        }
      }

      // Update On Time / Late Arrivals
      if (whenCome.trim()) {
        if (cameOnTime.toLowerCase() === 'true' || cameOnTime.toLowerCase() === 'yes' || cameOnTime === '') {
          const onTime = parseInt(monthlyRow.get('On Time Arrivals') || '0');
          monthlyRow.set('On Time Arrivals', onTime + 1);
        } else {
          // Late arrival
          if (willBeLate.toLowerCase() === 'yes') {
            const lateNotified = parseInt(monthlyRow.get('Late Arrivals (Notified)') || '0');
            monthlyRow.set('Late Arrivals (Notified)', lateNotified + 1);
          } else {
            const lateSilent = parseInt(monthlyRow.get('Late Arrivals (Silent)') || '0');
            monthlyRow.set('Late Arrivals (Silent)', lateSilent + 1);
          }
        }
      }

      // Update Early Departures
      if (leftEarly.toLowerCase() === 'yes' || leftEarly.toLowerCase() === 'true') {
        const earlyDep = parseInt(monthlyRow.get('Early Departures') || '0');
        monthlyRow.set('Early Departures', earlyDep + 1);
      }

      // Update Total Hours Worked
      const currentHours = parseFloat(monthlyRow.get('Total Hours Worked') || '0');
      monthlyRow.set('Total Hours Worked', (currentHours + hoursWorked).toFixed(2));

      // Update Total Hours Required
      const currentRequired = parseFloat(monthlyRow.get('Total Hours Required') || '0');
      monthlyRow.set('Total Hours Required', (currentRequired + requiredHoursDaily).toFixed(2));

      // Update Total Points
      const currentPoints = parseFloat(monthlyRow.get('Total Points') || '0');
      const totalPoints = currentPoints + point;
      monthlyRow.set('Total Points', totalPoints.toFixed(2));

      // Calculate Attendance Rate %
      const daysWorked = parseInt(monthlyRow.get('Days Worked') || '0');
      const daysAbsent = parseInt(monthlyRow.get('Days Absent') || '0');
      const totalDays = daysWorked + daysAbsent;

      // Calculate Average Daily Points
      const avgDailyPoints = daysWorked > 0 ? totalPoints / daysWorked : 0;
      monthlyRow.set('Average Daily Points', avgDailyPoints.toFixed(2));

      // Update Rating (0-10) — average of points, not accumulation
      const totalWorkDays = parseInt(monthlyRow.get('Total Work Days') || '0');
      const ratingDivisor = totalWorkDays > 0 ? totalWorkDays : (totalDays > 0 ? totalDays : 1);
      const newRating = Math.max(0, Math.min(10, totalPoints / ratingDivisor));
      monthlyRow.set('Rating (0-10)', newRating.toFixed(1));
      const attendanceRate = totalDays > 0 ? ((daysWorked / totalDays) * 100).toFixed(1) : '0.0';
      monthlyRow.set('Attendance Rate %', attendanceRate);

      // Calculate On-Time Rate %
      const onTimeArrivals = parseInt(monthlyRow.get('On Time Arrivals') || '0');
      const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : '0.0';
      monthlyRow.set('On-Time Rate %', onTimeRate);

      // Set Rating Zone (5-zone system)
      const ratingValue = parseFloat(monthlyRow.get('Rating (0-10)') || '0');
      if (ratingValue >= Config.EXCELLENT_ZONE_MIN) {
        monthlyRow.set('Rating Zone', '🟢 Excellent');
      } else if (ratingValue >= Config.GOOD_ZONE_MIN) {
        monthlyRow.set('Rating Zone', '🔵 Good');
      } else if (ratingValue >= Config.ACCEPTABLE_ZONE_MIN) {
        monthlyRow.set('Rating Zone', '🟡 Acceptable');
      } else if (ratingValue >= Config.BAD_ZONE_MIN) {
        monthlyRow.set('Rating Zone', '🟠 Bad');
      } else {
        monthlyRow.set('Rating Zone', '🔴 Unacceptable');
      }

      // Update Last Updated
      monthlyRow.set('Last Updated', moment.tz(Config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss'));

      await monthlyRow.save();
      logger.info(`Updated monthly report for ${name}: +${hoursWorked.toFixed(2)}h/${requiredHoursDaily.toFixed(2)}h required, point: ${point}, rating: ${newRating.toFixed(1)}, avgPts: ${avgDailyPoints.toFixed(2)}, penalty: ${penaltyMinutes}min, location: ${locationName || 'office'}`);
    }

    // Update hours calendar with daily hours and location data
    await sheetsService.updateHoursCalendar(dateStr);

    logger.info(`Successfully transferred data from ${dateStr} to ${reportSheetName}`);
    return true;
  } catch (error) {
    logger.error(`Error transferring daily data to monthly: ${error.message}`);
    return false;
  }
}

/**
 * Send daily report to Telegram group as Excel file
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance
 */
async function sendDailyReportToGroup(dateStr, schedulerService) {
  try {
    if (!schedulerService.bot) {
      logger.error('Bot instance not initialized');
      return;
    }

    if (!Config.DAILY_REPORT_GROUP_ID) {
      logger.warn('DAILY_REPORT_GROUP_ID not configured - skipping group report');
      return;
    }

    const worksheet = await sheetsService.getWorksheet(dateStr);
    await worksheet.loadHeaderRow();
    const rows = await worksheet.getRows();

    if (rows.length === 0) {
      logger.info('No data for daily report');
      return;
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();

    // Get headers
    const headers = worksheet.headerValues;

    // Prepare data array
    const data = [headers]; // First row is headers

    // Add all rows
    for (const row of rows) {
      const rowData = headers.map(header => {
        const value = row.get(header);
        return value !== undefined ? value : '';
      });
      data.push(rowData);
    }

    // Create worksheet from data
    const ws = XLSX.utils.aoa_to_sheet(data);

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, ws, dateStr);

    // Create temporary file path
    const tempDir = os.tmpdir();
    const fileName = `attendance_${dateStr}.xlsx`;
    const filePath = path.join(tempDir, fileName);

    // Write Excel file
    XLSX.writeFile(workbook, filePath);
    logger.info(`Created Excel file: ${filePath}`);

    // Calculate statistics for caption
    let presentCount = 0;
    let lateCount = 0;
    let absentCount = 0;
    let totalHoursWorked = 0;

    for (const row of rows) {
      const whenCome = row.get('When come') || '';
      const absent = row.get('Absent') || '';
      const cameOnTime = row.get('Came on time') || '';
      const hoursWorked = parseFloat(row.get('Hours worked') || '0');

      if (whenCome.trim()) {
        presentCount++;
        totalHoursWorked += hoursWorked;
        if (cameOnTime.toLowerCase() === 'false' || cameOnTime.toLowerCase() === 'no') {
          lateCount++;
        }
      } else if (absent.toLowerCase() === 'yes') {
        absentCount++;
      }
    }

    const formattedDate = moment.tz(dateStr, Config.TIMEZONE).format('DD.MM.YYYY (dddd)');
    const caption =
      `📊 <b>ОТЧЁТ ЗА ${formattedDate.toUpperCase()}</b>\n\n` +
      `✅ Присутствовали: ${presentCount}\n` +
      `⚠️ Опоздали: ${lateCount}\n` +
      `❌ Отсутствовали: ${absentCount}\n` +
      `⏱ Всего часов: ${totalHoursWorked.toFixed(1)}\n\n` +
      `📄 Полный отчёт во вложении\n` +
      `🤖 Данные архивированы автоматически`;

    // Send the Excel file to the group
    await schedulerService.bot.telegram.sendDocument(
      Config.DAILY_REPORT_GROUP_ID,
      { source: filePath, filename: fileName },
      {
        caption: caption,
        parse_mode: 'HTML'
      }
    );

    // Clean up temporary file
    fs.unlink(filePath, (err) => {
      if (err) {
        logger.warn(`Failed to delete temp file ${filePath}: ${err.message}`);
      } else {
        logger.info(`Cleaned up temp file: ${filePath}`);
      }
    });

    logger.info(`Daily report (Excel file) sent to group ${Config.DAILY_REPORT_GROUP_ID}`);
  } catch (error) {
    logger.error(`Error sending daily report to group: ${error.message}`);
    logger.error(error.stack);
  }
}

/**
 * Delete daily sheet from Google Sheets
 * @param {string} dateStr - Date in YYYY-MM-DD format
 */
async function deleteDailySheet(dateStr) {
  try {
    const sheet = sheetsService.doc.sheetsByTitle[dateStr];
    if (!sheet) {
      logger.warn(`Sheet ${dateStr} not found - already deleted?`);
      return;
    }

    await sheet.delete();
    logger.info(`Successfully deleted daily sheet: ${dateStr}`);
  } catch (error) {
    logger.error(`Error deleting daily sheet ${dateStr}: ${error.message}`);
    throw error;
  }
}

/**
 * Handle end of day process for a specific date
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance
 * @param {boolean} manual - If true, skip the 2-minute wait for overnight responses
 */
async function handleEndOfDay(dateStr, schedulerService, manual = false) {
  try {
    logger.info(`=== Starting End-of-Day Process for ${dateStr} ===`);

    // Check if sheet exists
    const sheetExists = sheetsService.doc.sheetsByTitle[dateStr];
    if (!sheetExists) {
      logger.info(`Sheet ${dateStr} doesn't exist - skipping end-of-day process`);
      return;
    }

    // Step 1: Handle overnight workers
    logger.info('Step 1: Handling overnight workers...');
    const overnightWorkers = await handleOvernightWorkers(dateStr, schedulerService);

    // Step 2: Wait 2 minutes for responses (only in automatic mode)
    if (!manual && overnightWorkers > 0) {
      logger.info(`Step 2: Waiting 2 minutes for overnight worker responses...`);
      await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes
    } else if (manual) {
      logger.info('Step 2: Skipped (manual mode)');
    }

    // Step 3: Transfer data to monthly report
    logger.info('Step 3: Transferring data to monthly report...');
    const transferred = await transferDailyDataToMonthly(dateStr);
    if (!transferred) {
      logger.error('Failed to transfer data - ABORTING end-of-day process to prevent data loss');
      return;
    }

    // Step 4: Send report to Telegram group
    logger.info('Step 4: Sending report to Telegram group...');
    await sendDailyReportToGroup(dateStr, schedulerService);

    // Step 5: Delete the daily sheet
    logger.info('Step 5: Deleting daily sheet...');
    await deleteDailySheet(dateStr);

    logger.info(`=== End-of-Day Process Completed for ${dateStr} ===`);
  } catch (error) {
    logger.error(`Error in handleEndOfDay: ${error.message}`);
    throw error;
  }
}

/**
 * Main job execution function
 * @param {Object} schedulerService - Scheduler service instance
 */
async function execute(schedulerService) {
  try {
    const yesterday = moment.tz(Config.TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
    logger.info(`Starting end-of-day archiving for ${yesterday}`);

    await handleEndOfDay(yesterday, schedulerService, false); // false = automatic (with 2-min wait)

    logger.info(`End-of-day archiving completed for ${yesterday}`);
  } catch (error) {
    logger.error(`Error in end-of-day archiving: ${error.message}`);
  }
}

module.exports = {
  schedule,
  execute,
  handleEndOfDay,
  handleOvernightWorkers,
  transferDailyDataToMonthly,
  sendDailyReportToGroup,
  deleteDailySheet,
  name: 'End of Day Archiving',
  description: 'Runs at 00:00 to archive yesterday (overnight workers, transfer to monthly, send report, delete sheet)'
};
