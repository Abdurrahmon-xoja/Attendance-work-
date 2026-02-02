/**
 * Monthly Operations for Google Sheets Service
 * Handles all monthly report and statistics operations
 */

const moment = require('moment-timezone');
const Config = require('../../config');
const logger = require('../../utils/logger');

class MonthlyOperations {
  constructor(coreService, cacheManager, quotaHandler, rosterOperations) {
    this.coreService = coreService;
    this.cacheManager = cacheManager;
    this.quotaHandler = quotaHandler;
    this.rosterOperations = rosterOperations;
  }

  /**
   * Helper: Find employee by telegram ID (delegates to roster operations)
   * @param {number} telegramId - Telegram ID
   * @returns {Object|null} Employee data
   */
  async findEmployeeByTelegramId(telegramId) {
    return await this.rosterOperations.findEmployeeByTelegramId(telegramId);
  }

  /**
   * Helper: Get cached daily sheet (wrapper for cache manager)
   * @param {string} sheetName - Sheet name
   * @param {Object} options - Options for getRows
   * @returns {Object} { worksheet, rows }
   */
  async _getCachedDailySheet(sheetName, options = {}) {
    return await this.cacheManager._getCachedDailySheet(
      sheetName,
      options,
      async (name) => this.coreService.getWorksheet(name),
      async (operation) => this.quotaHandler.retryOperation(operation)
    );
  }

  /**
   * Helper: Get cached roster (wrapper for cache manager)
   * @param {boolean} buildIndex - Whether to build telegram ID index
   * @returns {Array} Roster rows
   */
  async _getCachedRoster(buildIndex = false) {
    return await this.cacheManager._getCachedRoster(
      buildIndex,
      async (sheetName) => this.coreService.getWorksheet(sheetName),
      async (operation) => this.quotaHandler.retryOperation(operation)
    );
  }

  async getMonthlyRating(telegramId) {
    try {
      // TODO: Implement rating calculation based on daily attendance sheets
      // For now, return 10.0 as default
      return 10.0;
    } catch (error) {
      logger.error(`Error calculating monthly rating: ${error.message}`);
      return 10.0;
    }
  }

  /**
   * Log end-of-day balance calculation (deficit or surplus hours)
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {number} deficitMinutes - Minutes left early (negative balance)
   * @param {number} surplusMinutes - Overtime minutes worked (positive balance)
   * @param {number} penaltyMinutes - Penalty minutes that existed when day ended
   * @returns {boolean} True if successful
   */
  async getMonthlyBalance(telegramId) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');

      let totalDeficit = 0;
      let totalSurplus = 0;

      // Get all daily sheets for this month
      const startOfMonth = moment.tz(Config.TIMEZONE).startOf('month');
      const endOfMonth = moment.tz(Config.TIMEZONE).endOf('month');
      const currentDay = now.date();

      // Iterate through each day of the month up to today
      for (let day = 1; day <= currentDay; day++) {
        const dateStr = moment.tz(Config.TIMEZONE).set('date', day).format('YYYY-MM-DD');

        try {
          const dailySheet = this.coreService.doc.sheetsByTitle[dateStr];
          if (!dailySheet) continue; // Sheet doesn't exist for this day

          await dailySheet.loadHeaderRow();
          const rows = await dailySheet.getRows();

          // Find employee's row
          for (const row of rows) {
            if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
              const balanceType = row.get('Day Balance Type') || '';
              const balanceMinutes = parseInt(row.get('Balance Minutes') || '0');

              if (balanceType === 'DEFICIT' && balanceMinutes < 0) {
                totalDeficit += Math.abs(balanceMinutes);
              } else if (balanceType === 'SURPLUS' && balanceMinutes > 0) {
                totalSurplus += balanceMinutes;
              }

              break;
            }
          }
        } catch (err) {
          // Day sheet doesn't exist or error reading it, skip
          continue;
        }
      }

      return {
        totalDeficitMinutes: totalDeficit,
        totalSurplusMinutes: totalSurplus,
        netBalanceMinutes: totalSurplus - totalDeficit
      };
    } catch (error) {
      logger.error(`Error calculating monthly balance: ${error.message}`);
      return {
        totalDeficitMinutes: 0,
        totalSurplusMinutes: 0,
        netBalanceMinutes: 0
      };
    }
  }

  /**
   * Get comprehensive monthly statistics from monthly report
   * @param {string} telegramId - Employee's Telegram ID
   * @returns {Object} Monthly statistics
   */
  async getMonthlyStats(telegramId) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const yearMonth = now.format('YYYY-MM');
      const sheetName = `Report_${yearMonth}`;

      // Get monthly report sheet
      const worksheet = this.coreService.doc.sheetsByTitle[sheetName];
      if (!worksheet) {
        logger.warn(`Monthly report sheet not found: ${sheetName}`);
        return null;
      }

      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find employee's row
      for (const row of rows) {
        if (row.get('Telegram ID')?.toString().trim() === telegramId.toString()) {
          // Extract all monthly statistics
          return {
            name: row.get('Name') || '',
            company: row.get('Company') || '',
            workSchedule: row.get('Work Schedule') || '',
            totalWorkDays: parseInt(row.get('Total Work Days') || '0'),
            daysWorked: parseInt(row.get('Days Worked') || '0'),
            daysInOffice: parseInt(row.get('Days In Office') || '0'),
            daysOnSite: parseInt(row.get('Days On Site') || '0'),
            daysAbsent: parseInt(row.get('Days Absent') || '0'),
            daysAbsentNotified: parseInt(row.get('Days Absent (Notified)') || '0'),
            daysAbsentSilent: parseInt(row.get('Days Absent (Silent)') || '0'),
            onTimeArrivals: parseInt(row.get('On Time Arrivals') || '0'),
            lateArrivalsNotified: parseInt(row.get('Late Arrivals (Notified)') || '0'),
            lateArrivalsSilent: parseInt(row.get('Late Arrivals (Silent)') || '0'),
            earlyDepartures: parseInt(row.get('Early Departures') || '0'),
            totalHoursRequired: parseFloat(row.get('Total Hours Required') || '0'),
            totalHoursWorked: parseFloat(row.get('Total Hours Worked') || '0'),
            totalPoints: parseFloat(row.get('Total Points') || '0'),
            averageDailyPoints: parseFloat(row.get('Average Daily Points') || '0'),
            rating: parseFloat(row.get('Rating (0-10)') || '0'),
            ratingZone: row.get('Rating Zone') || '',
            attendanceRate: parseFloat(row.get('Attendance Rate %') || '0'),
            onTimeRate: parseFloat(row.get('On-Time Rate %') || '0'),
            lastUpdated: row.get('Last Updated') || ''
          };
        }
      }

      // Employee not found in monthly report
      logger.warn(`Employee ${telegramId} not found in monthly report ${sheetName}`);
      return null;
    } catch (error) {
      logger.error(`Error getting monthly stats: ${error.message}`);
      return null;
    }
  }

  /**
   * Initialize monthly report sheet at the start of each month
   * @param {string} yearMonth - Year and month in YYYY-MM format
   * @returns {boolean} True if successful
   */
  async initializeMonthlyReport(yearMonth) {
    try {
      const sheetName = `Report_${yearMonth}`; // e.g., "Report_2025-10"

      // Refresh document metadata to ensure sheetsByTitle is up-to-date
      await this.coreService.doc.loadInfo();

      // Check if sheet already exists
      let worksheet = this.coreService.doc.sheetsByTitle[sheetName];

      if (!worksheet) {
        logger.info(`Creating monthly report sheet: ${sheetName}`);
        worksheet = await this.coreService.doc.addSheet({ title: sheetName });
      }

      // Resize sheet to fit all columns
      await worksheet.resize({ rowCount: 1000, columnCount: 30 });

      // Set headers
      await worksheet.setHeaderRow([
        'Name',
        'Telegram ID',
        'Company',
        'Work Schedule',
        'Total Work Days',
        'Days Worked',
        'Days In Office',
        'Days On Site',
        'Days Absent',
        'Days Absent (Notified)',
        'Days Absent (Silent)',
        'On Time Arrivals',
        'Late Arrivals (Notified)',
        'Late Arrivals (Silent)',
        'Early Departures',
        'Early Departures (Worked Full Hours)',
        'Left Before Shift',
        'Total Hours Required',
        'Total Hours Worked',
        'Total Points',
        'Average Daily Points',
        'Attendance Rate %',
        'On-Time Rate %',
        'Rating (0-10)',
        'Rating Zone',
        'Last Updated'
      ]);
      await worksheet.loadHeaderRow();

      // OPTIMIZATION: Get all employees from cached roster
      const rows = await this._getCachedRoster();

      // Add all employees to monthly report
      for (const row of rows) {
        const nameFull = row.get('Name full') || '';
        const telegramId = row.get('Telegram Id') || '';
        const company = row.get('Company') || '';
        const workTime = row.get('Work time') || '';
        const doNotWorkSaturday = (row.get('Do not work in Saturday') || '').toString().toLowerCase().trim() === 'yes';

        if (nameFull.trim()) {
          // Calculate Total Work Days for this employee based on calendar and schedule
          let totalWorkDays = 0;
          const monthStart = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).startOf('month');
          const monthEnd = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).endOf('month');

          // Loop through each day in the month to count work days
          for (let day = monthStart.clone(); day.isSameOrBefore(monthEnd); day.add(1, 'day')) {
            const dayOfWeek = day.day();
            const isSunday = dayOfWeek === 0;
            const isSaturday = dayOfWeek === 6;

            // Skip Sunday for everyone
            if (isSunday) continue;

            // Skip Saturday if user doesn't work on Saturday
            if (isSaturday && doNotWorkSaturday) continue;

            // This is a work day for this employee
            totalWorkDays++;
          }

          // Calculate Total Hours Required based on work schedule
          let dailyHours = 8; // Default
          if (workTime && workTime !== '-') {
            try {
              const times = workTime.split('-');
              const [startHour, startMin] = times[0].trim().split(':').map(Number);
              const [endHour, endMin] = times[1].trim().split(':').map(Number);
              dailyHours = (endHour + endMin/60) - (startHour + startMin/60);
            } catch (err) {
              // Use default 8 hours
            }
          }
          const totalHoursRequired = totalWorkDays * dailyHours;

          await worksheet.addRow({
            'Name': nameFull,
            'Telegram ID': telegramId,
            'Company': company,
            'Work Schedule': workTime,
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
        }
      }

      logger.info(`Monthly report ${sheetName} initialized with all employees`);
      return true;
    } catch (error) {
      logger.error(`Error initializing monthly report: ${error.message}`);
      return false;
    }
  }

  /**
   * Update monthly report with data from a specific day
   * FIX: Now rebuilds from scratch to ensure idempotency (no double-counting)
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful
   */
  async updateMonthlyReport(dateStr) {
    try {
      const date = moment.tz(dateStr, Config.TIMEZONE);
      const yearMonth = date.format('YYYY-MM');
      const reportSheetName = `Report_${yearMonth}`;

      // Refresh document metadata to avoid stale sheet references
      await this.coreService.doc.loadInfo();

      // Get or create monthly report sheet
      let reportSheet = this.coreService.doc.sheetsByTitle[reportSheetName];
      if (!reportSheet) {
        await this.initializeMonthlyReport(yearMonth);
        reportSheet = this.coreService.doc.sheetsByTitle[reportSheetName];
      }

      await reportSheet.loadHeaderRow();
      const reportRows = await reportSheet.getRows();

      // FIX: Get ALL daily sheets for this month to recalculate from scratch
      const startOfMonth = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).startOf('month');
      const currentDate = moment.tz(dateStr, Config.TIMEZONE);
      const daysToCheck = currentDate.date();

      // Collect all daily data for the month
      const dailyDataByEmployee = new Map(); // key: telegramId, value: array of daily records

      for (let day = 1; day <= daysToCheck; day++) {
        const checkDate = moment.tz(Config.TIMEZONE).year(startOfMonth.year()).month(startOfMonth.month()).date(day);
        const checkDateStr = checkDate.format('YYYY-MM-DD');

        try {
          const daySheet = this.coreService.doc.sheetsByTitle[checkDateStr];
          if (!daySheet) continue;

          await daySheet.loadHeaderRow();
          const dayRows = await daySheet.getRows();

          // Collect data for each employee
          for (const dayRow of dayRows) {
            const telegramId = dayRow.get('TelegramId')?.toString().trim();
            if (!telegramId) continue;

            if (!dailyDataByEmployee.has(telegramId)) {
              dailyDataByEmployee.set(telegramId, []);
            }

            dailyDataByEmployee.get(telegramId).push({
              date: checkDateStr,
              cameOnTime: dayRow.get('Came on time') || '',
              whenCome: dayRow.get('When come') || '',
              hoursWorked: parseFloat(dayRow.get('Hours worked') || '0'),
              leftEarly: dayRow.get('Left early') || '',
              willBeLate: dayRow.get('will be late') || '',
              absent: dayRow.get('Absent') || '',
              whyAbsent: dayRow.get('Why absent') || '',
              point: parseFloat(dayRow.get('Point') || '0'),
              locationName: dayRow.get('Location Name') || ''
            });
          }
        } catch (dayErr) {
          // Sheet doesn't exist or error reading it, skip
          logger.debug(`Skipping day ${checkDateStr}: ${dayErr.message}`);
          continue;
        }
      }

      // Process each employee in monthly report
      for (const reportRow of reportRows) {
        const telegramId = reportRow.get('Telegram ID') || '';
        if (!telegramId) continue;

        // FIX: RECALCULATE from scratch instead of incrementing
        let daysWorked = 0;
        let daysAbsent = 0;
        let daysAbsentNotified = 0;
        let daysAbsentSilent = 0;
        let onTimeArrivals = 0;
        let lateNotified = 0;
        let lateSilent = 0;
        let earlyDepartures = 0;
        let earlyFullHours = 0;
        let leftBeforeShift = 0;
        let totalHoursWorked = 0;
        let totalPoints = 0;
        let daysInOffice = 0;
        let daysOnSite = 0;

        // Get employee's Saturday work status for filtering weekend data
        const employee = await this.findEmployeeByTelegramId(telegramId);
        const userDoesNotWorkSaturday = employee?.doNotWorkSaturday || false;

        // Read Total Work Days from the report (already calculated when sheet was created)
        const totalWorkDays = parseInt(reportRow.get('Total Work Days') || '0');

        // Get all daily data for this employee
        const employeeDailyData = dailyDataByEmployee.get(telegramId.toString()) || [];

        // Calculate totals from all daily records
        for (const dayData of employeeDailyData) {
          // Check if this day is a weekend - skip it for stats
          const dayDate = moment.tz(dayData.date, Config.TIMEZONE);
          const isSunday = dayDate.day() === 0;
          const isSaturday = dayDate.day() === 6;

          // Skip Sunday for everyone
          if (isSunday) {
            continue;
          }

          // Skip Saturday if user doesn't work on Saturday
          if (isSaturday && userDoesNotWorkSaturday) {
            continue;
          }

          // This is a valid work day - process the data

          if (dayData.absent.toLowerCase() === 'yes') {
            // Marked as absent
            daysAbsent++;
            totalPoints += dayData.point; // Include absent-day points (6 if notified, 0 if silent)
            // Check if this is a no-show (automated) vs user-provided reason
            const isNoShow = dayData.whyAbsent && dayData.whyAbsent.toLowerCase().includes('no-show');
            if (dayData.whyAbsent && dayData.whyAbsent.trim() && !isNoShow) {
              daysAbsentNotified++;  // User provided a reason
            } else {
              daysAbsentSilent++;    // No reason OR no-show (silent absence)
            }
          } else if (dayData.whenCome.trim()) {
            // Came to work
            daysWorked++;
            if (dayData.locationName.trim() !== '') {
              daysOnSite++;
            } else {
              daysInOffice++;
            }
            totalHoursWorked += dayData.hoursWorked;
            totalPoints += dayData.point;

            if (dayData.cameOnTime.toLowerCase() === 'yes') {
              onTimeArrivals++;
            } else {
              if (dayData.willBeLate.toLowerCase() === 'yes') {
                lateNotified++;
              } else {
                lateSilent++;
              }
            }

            if (dayData.leftEarly.toLowerCase() === 'yes (worked full hours)') {
              earlyFullHours++;
            } else if (dayData.leftEarly.toLowerCase() === 'yes') {
              earlyDepartures++;
            } else if (dayData.leftEarly.toLowerCase() === 'yes - before shift') {
              leftBeforeShift++;
            }
          } else {
            // No activity at all (not marked absent, no arrival)
            // This shouldn't happen if no-show checker runs, but handle it as silent absence
            daysAbsent++;
            daysAbsentSilent++;
            totalPoints += dayData.point; // 0 points for no-show
            logger.warn(`Employee has no activity on work day ${dayData.date} but not marked as absent - counting as silent absence`);
          }

        }

        // Calculate rates
        const attendanceRate = totalWorkDays > 0 ? ((daysWorked / totalWorkDays) * 100).toFixed(1) : 0;
        const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : 0;
        const avgDailyPoints = daysWorked > 0 ? (totalPoints / daysWorked).toFixed(2) : 0;

        // Calculate rating (0-10 scale)
        // Rating = Total Points / (Days Worked + Days Absent)
        const totalTrackedDays = daysWorked + daysAbsent;
        const rating = totalTrackedDays > 0 ? Math.max(0, Math.min(10, totalPoints / totalTrackedDays)).toFixed(1) : 0;

        // Determine rating zone (5-zone system)
        let ratingZone = '⚪';
        const ratingNum = parseFloat(rating);
        if (ratingNum >= Config.EXCELLENT_ZONE_MIN) {
          ratingZone = '🟢 Excellent';
        } else if (ratingNum >= Config.GOOD_ZONE_MIN) {
          ratingZone = '🔵 Good';
        } else if (ratingNum >= Config.ACCEPTABLE_ZONE_MIN) {
          ratingZone = '🟡 Acceptable';
        } else if (ratingNum >= Config.BAD_ZONE_MIN) {
          ratingZone = '🟠 Bad';
        } else {
          ratingZone = '🔴 Unacceptable';
        }

        // Update report row (don't update Total Work Days and Total Hours Required - they're set at creation)
        reportRow.set('Days Worked', daysWorked);
        reportRow.set('Days In Office', daysInOffice);
        reportRow.set('Days On Site', daysOnSite);
        reportRow.set('Days Absent', daysAbsent);
        reportRow.set('Days Absent (Notified)', daysAbsentNotified);
        reportRow.set('Days Absent (Silent)', daysAbsentSilent);
        reportRow.set('On Time Arrivals', onTimeArrivals);
        reportRow.set('Late Arrivals (Notified)', lateNotified);
        reportRow.set('Late Arrivals (Silent)', lateSilent);
        reportRow.set('Early Departures', earlyDepartures);
        reportRow.set('Early Departures (Worked Full Hours)', earlyFullHours);
        reportRow.set('Left Before Shift', leftBeforeShift);
        reportRow.set('Total Hours Worked', totalHoursWorked.toFixed(2));
        reportRow.set('Total Points', totalPoints.toFixed(2));
        reportRow.set('Average Daily Points', avgDailyPoints);
        reportRow.set('Attendance Rate %', attendanceRate);
        reportRow.set('On-Time Rate %', onTimeRate);
        reportRow.set('Rating (0-10)', rating);
        reportRow.set('Rating Zone', ratingZone);
        reportRow.set('Last Updated', moment.tz(Config.TIMEZONE).format('YYYY-MM-DD HH:mm'));

        await reportRow.save();
      }

      logger.info(`Monthly report ${reportSheetName} updated with data from ${dateStr}`);
      return true;
    } catch (error) {
      logger.error(`Error updating monthly report: ${error.message}`);
      return false;
    }
  }

  /**
   * Initialize Hours Calendar sheet for a given month
   * Creates a calendar-style sheet with one column per day showing hours worked and location
   * @param {string} yearMonth - Year and month in YYYY-MM format (e.g. "2026-01")
   * @returns {boolean} True if successful
   */
  async initializeHoursCalendar(yearMonth) {
    try {
      const sheetName = `Hours_${yearMonth}`;

      // Refresh document metadata to avoid stale sheet references
      await this.coreService.doc.loadInfo();

      // Check if sheet already exists
      let worksheet = this.coreService.doc.sheetsByTitle[sheetName];
      if (worksheet) {
        logger.info(`Hours calendar sheet already exists: ${sheetName}`);
        return true;
      }

      logger.info(`Creating hours calendar sheet: ${sheetName}`);

      // Calculate days in month
      const daysInMonth = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).daysInMonth();

      // Create sheet
      worksheet = await this.coreService.doc.addSheet({ title: sheetName });

      // Resize: Name + Telegram ID + day columns
      await worksheet.resize({ rowCount: 1000, columnCount: 2 + daysInMonth });

      // Build headers: Name, Telegram ID, 1, 2, ..., daysInMonth
      const headers = ['Name', 'Telegram ID'];
      for (let d = 1; d <= daysInMonth; d++) {
        headers.push(String(d));
      }
      await worksheet.setHeaderRow(headers);
      await worksheet.loadHeaderRow();

      // Get all employees from cached roster
      const rows = await this._getCachedRoster();

      for (const row of rows) {
        const nameFull = row.get('Name full') || '';
        const telegramId = row.get('Telegram Id') || '';

        if (nameFull.trim()) {
          await worksheet.addRow({
            'Name': nameFull,
            'Telegram ID': telegramId
          });
        }
      }

      logger.info(`Hours calendar ${sheetName} initialized with all employees`);
      return true;
    } catch (error) {
      logger.error(`Error initializing hours calendar: ${error.message}`);
      return false;
    }
  }

  /**
   * Update Hours Calendar with data from a specific day
   * Writes "hours | location" into the day column for each employee who worked
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful
   */
  async updateHoursCalendar(dateStr) {
    try {
      const date = moment.tz(dateStr, Config.TIMEZONE);
      const yearMonth = date.format('YYYY-MM');
      const dayOfMonth = String(date.date()); // column name, e.g. '15'

      const sheetName = `Hours_${yearMonth}`;

      // Refresh document metadata to avoid stale sheet references
      await this.coreService.doc.loadInfo();

      // Get or create the Hours sheet
      let hoursSheet = this.coreService.doc.sheetsByTitle[sheetName];
      if (!hoursSheet) {
        await this.initializeHoursCalendar(yearMonth);
        hoursSheet = this.coreService.doc.sheetsByTitle[sheetName];
      }

      if (!hoursSheet) {
        logger.error(`Failed to get or create hours calendar sheet: ${sheetName}`);
        return false;
      }

      await hoursSheet.loadHeaderRow();
      const hoursRows = await hoursSheet.getRows();

      // Load the daily sheet for dateStr
      const dailySheet = this.coreService.doc.sheetsByTitle[dateStr];
      if (!dailySheet) {
        logger.warn(`Daily sheet ${dateStr} not found for hours calendar update`);
        return false;
      }

      await dailySheet.loadHeaderRow();
      const dailyRows = await dailySheet.getRows();

      // Build a map of telegramId -> hours row for fast lookup
      const hoursRowMap = new Map();
      for (const hRow of hoursRows) {
        const tid = (hRow.get('Telegram ID') || '').toString().trim();
        if (tid) {
          hoursRowMap.set(tid, hRow);
        }
      }

      // Process each employee from the daily sheet
      for (const dailyRow of dailyRows) {
        const telegramId = (dailyRow.get('TelegramId') || '').toString().trim();
        if (!telegramId) continue;

        const point = dailyRow.get('Point') || '0';
        const whenCome = (dailyRow.get('When come') || '').trim();
        const absent = (dailyRow.get('Absent') || '').trim().toLowerCase();

        let cellValue = '';

        if (whenCome) {
          // Employee worked this day
          const hoursWorked = dailyRow.get('Hours worked') || '0';
          const locationName = (dailyRow.get('Location Name') || '').trim();
          const location = locationName !== '' ? 'Site' : 'Office';
          cellValue = `${hoursWorked}h | ${location} | ${point}pt`;
        } else if (absent === 'yes' || absent === 'true') {
          // Employee was absent
          const whyAbsent = (dailyRow.get('Why absent') || '').trim();
          cellValue = whyAbsent ? `Absent (${whyAbsent}) | ${point}pt` : `Absent | ${point}pt`;
        } else {
          // No activity
          cellValue = `No-show | ${point}pt`;
        }

        // Find the employee row in hours sheet
        const hoursRow = hoursRowMap.get(telegramId);
        if (hoursRow) {
          hoursRow.set(dayOfMonth, cellValue);
          await hoursRow.save();
        } else {
          logger.warn(`Employee ${telegramId} not found in hours calendar ${sheetName}`);
        }
      }

      logger.info(`Hours calendar ${sheetName} updated with data from ${dateStr}`);
      return true;
    } catch (error) {
      logger.error(`Error updating hours calendar: ${error.message}`);
      return false;
    }
  }

  /**
   * Update location data for employee's arrival
   * @param {number} telegramId - User's Telegram ID
   * @param {Object} location - Location { latitude, longitude }
   * @param {number} accuracy - GPS accuracy in meters
   * @returns {boolean} True if successful
   */
}

module.exports = MonthlyOperations;
