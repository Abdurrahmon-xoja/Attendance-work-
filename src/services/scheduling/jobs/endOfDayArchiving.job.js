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

// Longer retry schedule than the sheets-service default: midnight batches hit
// the per-minute write quota, so 2s/4s/8s/16s/32s rides out the quota window
const retry = (operation) => sheetsService.quotaHandler.retryOperation(operation, 5, 2000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WRITE_THROTTLE_MS = 1100;

// Archive log sheet: one row per date, a timestamp per completed step.
// Makes end-of-day idempotent (safe /endday re-runs, startup catch-up).
const ARCHIVE_LOG_SHEET = '_ArchiveLog';
const ARCHIVE_LOG_HEADERS = ['Date', 'TransferredAt', 'HoursAt', 'ReportSentAt', 'DeletedAt'];

/**
 * Send an alert message to all configured admins
 * @param {Object} schedulerService - Scheduler service instance
 * @param {string} message - Message text
 */
async function notifyAdmins(schedulerService, message) {
  if (!schedulerService || !schedulerService.bot || typeof schedulerService.sendMessageSafe !== 'function') {
    logger.warn(`Cannot notify admins (no bot instance): ${message}`);
    return;
  }
  for (const adminId of Config.ADMIN_TELEGRAM_IDS) {
    try {
      await schedulerService.sendMessageSafe(adminId, message);
    } catch (error) {
      logger.error(`Failed to notify admin ${adminId}: ${error.message}`);
    }
  }
}

/**
 * Get (or create) the archive log row for a date
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Object|null} GoogleSpreadsheetRow for the date, or null on failure
 */
async function getArchiveLogRow(dateStr) {
  try {
    let sheet = sheetsService.doc.sheetsByTitle[ARCHIVE_LOG_SHEET];
    if (!sheet) {
      sheet = await retry(() => sheetsService.doc.addSheet({
        title: ARCHIVE_LOG_SHEET,
        headerValues: ARCHIVE_LOG_HEADERS
      }));
    }
    await retry(() => sheet.loadHeaderRow());
    const rows = await retry(() => sheet.getRows());
    let row = rows.find(r => (r.get('Date') || '').toString().trim() === dateStr);
    if (!row) {
      row = await retry(() => sheet.addRow({ 'Date': dateStr }));
    }
    return row;
  } catch (error) {
    logger.error(`Error accessing archive log: ${error.message}`);
    return null;
  }
}

/**
 * Stamp a step as completed in the archive log
 * @param {Object|null} logRow - Row from getArchiveLogRow (may be null)
 * @param {string} column - One of TransferredAt/HoursAt/ReportSentAt/DeletedAt
 */
async function stampArchiveLog(logRow, column) {
  if (!logRow) return;
  try {
    logRow.set(column, moment.tz(Config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss'));
    await retry(() => logRow.save());
  } catch (error) {
    logger.error(`Error stamping archive log ${column}: ${error.message}`);
  }
}

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

        await retry(() => row.save());

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
    transferDailyDataToMonthly.lastError = null;
    const yearMonth = moment.tz(dateStr, Config.TIMEZONE).format('YYYY-MM');
    const reportSheetName = `Report_${yearMonth}`;

    // Ensure monthly report exists
    let monthlySheet = sheetsService.doc.sheetsByTitle[reportSheetName];
    if (!monthlySheet) {
      logger.info(`Creating monthly report ${reportSheetName}`);
      const initialized = await sheetsService.initializeMonthlyReport(yearMonth);
      if (!initialized) {
        throw new Error(`Failed to initialize monthly report ${reportSheetName}`);
      }
      monthlySheet = await sheetsService.getWorksheet(reportSheetName);
    } else {
      monthlySheet = await sheetsService.getWorksheet(reportSheetName);
    }

    // Get daily data
    const dailySheet = await sheetsService.getWorksheet(dateStr);
    await retry(() => dailySheet.loadHeaderRow());
    const dailyRows = await retry(() => dailySheet.getRows());

    // Load monthly sheet. If a previous month-creation run crashed after
    // creating the sheet but before writing headers (this broke July 2026),
    // the sheet exists but is empty — repair it instead of failing every night.
    try {
      await retry(() => monthlySheet.loadHeaderRow());
    } catch (headerError) {
      if (headerError.message && headerError.message.includes('No values in the header row')) {
        logger.warn(`${reportSheetName} exists but has no header row - repairing via initializeMonthlyReport`);
        const repaired = await sheetsService.initializeMonthlyReport(yearMonth);
        if (!repaired) {
          throw new Error(`Failed to repair broken monthly report ${reportSheetName}`);
        }
        monthlySheet = await sheetsService.getWorksheet(reportSheetName);
        await retry(() => monthlySheet.loadHeaderRow());
      } else {
        throw headerError;
      }
    }
    const monthlyRows = await retry(() => monthlySheet.getRows());

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
          monthlyRow = await retry(() => monthlySheet.addRow({
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
          }));

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

      // Total Hours Required is static — set once when monthly sheet is created, not updated daily

      // Update Total Points
      const currentPoints = parseFloat(monthlyRow.get('Total Points') || '0');
      const totalPoints = currentPoints + point;
      monthlyRow.set('Total Points', totalPoints.toFixed(2));

      // Calculate Attendance Rate %
      const daysWorked = parseInt(monthlyRow.get('Days Worked') || '0');
      const daysAbsent = parseInt(monthlyRow.get('Days Absent') || '0');
      const totalDays = daysWorked + daysAbsent;
      const totalWorkDays = parseInt(monthlyRow.get('Total Work Days') || '0');

      // Calculate Average Daily Points
      const avgDailyPoints = totalDays > 0 ? totalPoints / totalDays : 0;
      monthlyRow.set('Average Daily Points', avgDailyPoints.toFixed(2));

      // Update Rating (0-10) = Total Points / (Days Worked + Days Absent)
      const ratingDivisor = totalDays > 0 ? totalDays : 1;
      const newRating = Math.max(0, Math.min(10, totalPoints / ratingDivisor));
      monthlyRow.set('Rating (0-10)', newRating.toFixed(1));
      const attendanceRate = totalWorkDays > 0 ? ((daysWorked / totalWorkDays) * 100).toFixed(1) : '0.0';
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

      await retry(() => monthlyRow.save());
      await sleep(WRITE_THROTTLE_MS);
      logger.info(`Updated monthly report for ${name}: +${hoursWorked.toFixed(2)}h/${requiredHoursDaily.toFixed(2)}h required, point: ${point}, rating: ${newRating.toFixed(1)}, avgPts: ${avgDailyPoints.toFixed(2)}, penalty: ${penaltyMinutes}min, location: ${locationName || 'office'}`);
    }

    logger.info(`Successfully transferred data from ${dateStr} to ${reportSheetName}`);
    return true;
  } catch (error) {
    transferDailyDataToMonthly.lastError = error.message;
    logger.error(`Error transferring daily data to monthly: ${error.message}`);
    return false;
  }
}

/**
 * Send daily report to Telegram group as Excel file
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {Object} schedulerService - Scheduler service instance
 * @returns {boolean} True if the report was sent (or legitimately skipped)
 */
async function sendDailyReportToGroup(dateStr, schedulerService) {
  try {
    if (!schedulerService.bot) {
      logger.error('Bot instance not initialized');
      return false;
    }

    if (!Config.DAILY_REPORT_GROUP_ID) {
      logger.warn('DAILY_REPORT_GROUP_ID not configured - skipping group report');
      return true;
    }

    const worksheet = await sheetsService.getWorksheet(dateStr);
    await retry(() => worksheet.loadHeaderRow());
    const rows = await retry(() => worksheet.getRows());

    if (rows.length === 0) {
      logger.info('No data for daily report');
      return true;
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
    return true;
  } catch (error) {
    logger.error(`Error sending daily report to group: ${error.message}`);
    logger.error(error.stack);
    return false;
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
 * @param {Object} options - { skipDelete: true } keeps the daily sheet even on success
 */
async function handleEndOfDay(dateStr, schedulerService, manual = false, options = {}) {
  try {
    logger.info(`=== Starting End-of-Day Process for ${dateStr} ===`);

    // Check if sheet exists
    const sheetExists = sheetsService.doc.sheetsByTitle[dateStr];
    if (!sheetExists) {
      logger.info(`Sheet ${dateStr} doesn't exist - skipping end-of-day process`);
      return;
    }

    // Archive log makes each step idempotent: completed steps are stamped and
    // skipped on re-runs, so /endday and startup catch-up never double-count
    const logRow = await getArchiveLogRow(dateStr);

    if (logRow && logRow.get('TransferredAt')) {
      logger.info(`Steps 1-3 skipped - ${dateStr} already transferred at ${logRow.get('TransferredAt')}`);
    } else {
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
        await notifyAdmins(schedulerService,
          `❗️ Архивация за ${dateStr} НЕ выполнена: перенос в месячный отчёт не удался.\n` +
          `Причина: ${transferDailyDataToMonthly.lastError || 'неизвестно (см. логи)'}\n` +
          `Дневной лист сохранён. Проверьте логи и повторите: /endday ${dateStr}`);
        return;
      }
      await stampArchiveLog(logRow, 'TransferredAt');
    }

    // Step 3b: Update hours calendar
    let hoursOk = !!(logRow && logRow.get('HoursAt'));
    if (hoursOk) {
      logger.info(`Step 3b skipped - hours calendar already updated at ${logRow.get('HoursAt')}`);
    } else {
      logger.info('Step 3b: Updating hours calendar...');
      hoursOk = await sheetsService.updateHoursCalendar(dateStr);
      if (hoursOk) {
        await stampArchiveLog(logRow, 'HoursAt');
      } else {
        logger.error(`Failed to update hours calendar for ${dateStr} - daily sheet will be kept`);
        await notifyAdmins(schedulerService,
          `⚠️ Календарь часов (Hours) за ${dateStr} не обновился. ` +
          `Дневной лист сохранён. Повторите: /endday ${dateStr} или /hourscalendar ${dateStr}`);
      }
    }

    // Step 4: Send report to Telegram group
    let sentOk = !!(logRow && logRow.get('ReportSentAt'));
    if (sentOk) {
      logger.info(`Step 4 skipped - report already sent at ${logRow.get('ReportSentAt')}`);
    } else {
      logger.info('Step 4: Sending report to Telegram group...');
      sentOk = await sendDailyReportToGroup(dateStr, schedulerService);
      if (sentOk) {
        await stampArchiveLog(logRow, 'ReportSentAt');
      } else {
        await notifyAdmins(schedulerService,
          `⚠️ Отчёт (Excel) за ${dateStr} не отправлен в группу. ` +
          `Дневной лист сохранён. Повторите: /endday ${dateStr}`);
      }
    }

    // Step 5: Delete the daily sheet - ONLY when every previous step succeeded,
    // because the daily sheet is the only source for re-running Hours/report
    if (hoursOk && sentOk) {
      if (options.skipDelete) {
        logger.info('Step 5: Skipped (skipDelete) - daily sheet kept');
      } else {
        logger.info('Step 5: Deleting daily sheet...');
        await deleteDailySheet(dateStr);
        await stampArchiveLog(logRow, 'DeletedAt');
      }
      logger.info(`=== End-of-Day Process Completed for ${dateStr} ===`);
    } else {
      logger.warn(`=== End-of-Day Process for ${dateStr} finished with errors - daily sheet kept for retry ===`);
    }
  } catch (error) {
    logger.error(`Error in handleEndOfDay: ${error.message}`);
    await notifyAdmins(schedulerService,
      `❗️ Ошибка архивации за ${dateStr}: ${error.message}\nПовторите: /endday ${dateStr}`);
    throw error;
  }
}

/**
 * Catch up on days that were never archived (e.g. the bot was down at 00:00
 * or a previous run failed). Called shortly after startup.
 * @param {Object} schedulerService - Scheduler service instance
 */
async function catchUpMissedDays(schedulerService) {
  try {
    await retry(() => sheetsService.doc.loadInfo());

    const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');
    const missedDays = Object.keys(sheetsService.doc.sheetsByTitle)
      .filter(title => /^\d{4}-\d{2}-\d{2}$/.test(title) && title < today)
      .sort();

    if (missedDays.length === 0) {
      logger.info('Startup catch-up: no unarchived days found');
      return;
    }

    logger.warn(`Startup catch-up: found unarchived days: ${missedDays.join(', ')}`);
    await notifyAdmins(schedulerService,
      `⚠️ Обнаружены неархивированные дни: ${missedDays.join(', ')}\nЗапускаю архивацию автоматически...`);

    for (const dateStr of missedDays) {
      try {
        await handleEndOfDay(dateStr, schedulerService, true);
      } catch (error) {
        logger.error(`Startup catch-up failed for ${dateStr}: ${error.message}`);
      }
      await sleep(60000); // pause between days to stay clear of API quotas
    }

    logger.info('Startup catch-up finished');
  } catch (error) {
    logger.error(`Error in startup catch-up: ${error.message}`);
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
    await notifyAdmins(schedulerService,
      `❗️ Ночная архивация упала с ошибкой: ${error.message}\nПроверьте логи и /endday при необходимости.`);
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
  catchUpMissedDays,
  notifyAdmins,
  name: 'End of Day Archiving',
  description: 'Runs at 00:00 to archive yesterday (overnight workers, transfer to monthly, send report, delete sheet)'
};
