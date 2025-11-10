/**
 * Google Sheets integration service.
 * Handles all interactions with Google Sheets for data storage and retrieval.
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const moment = require('moment-timezone');
const Config = require('../config');
const logger = require('../utils/logger');

class SheetsService {
  constructor() {
    this.doc = null;
    this.isConnected = false;
  }

  /**
   * Establish connection to Google Sheets
   */
  async connect() {
    try {
      const serviceAccountAuth = new JWT({
        email: Config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: Config.GOOGLE_PRIVATE_KEY,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.doc = new GoogleSpreadsheet(Config.GOOGLE_SHEETS_ID, serviceAccountAuth);
      await this.doc.loadInfo();

      this.isConnected = true;
      logger.info('Successfully connected to Google Sheets');
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Google Sheets: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a worksheet by name, create if doesn't exist
   * @param {string} sheetName - Name of the worksheet
   * @returns {Object} Worksheet object
   */
  async getWorksheet(sheetName) {
    try {
      let sheet = this.doc.sheetsByTitle[sheetName];

      if (!sheet) {
        logger.warn(`Worksheet '${sheetName}' not found, creating it...`);
        sheet = await this.doc.addSheet({
          title: sheetName
        });
      }

      return sheet;
    } catch (error) {
      logger.error(`Error getting worksheet '${sheetName}': ${error.message}`);
      throw error;
    }
  }

  /**
   * Find employee by Telegram ID in Roster sheet
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByTelegramId(telegramId) {
    try {
      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rows = await roster.getRows();

      console.log("-------- Rows from Roster Sheet -------");
      console.log(rows);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
          return {
            rowNumber: i + 2, // +2 because header is row 1, and index starts at 0
            nameFull: row.get('Name full') || '',
            workTime: row.get('Work time') || '',
            telegramName: row.get('Telegram name') || '',
            company: row.get('Company') || '',
            telegramUsername: row.get('Telegram user name') || '',
            telegramId: row.get('Telegram Id') || '',
            _row: row
          };
        }
      }
      return null;
    } catch (error) {
      logger.error(`Error finding employee by telegram_id: ${error.message}`);
      return null;
    }
  }

  /**
   * Find employee by Telegram username in Roster sheet
   * @param {string} username - User's Telegram username (with or without @)
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByUsername(username) {
    try {
      if (!username) return null;

      // Ensure username starts with @
      if (!username.startsWith('@')) {
        username = `@${username}`;
      }

      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rows = await roster.getRows();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sheetUsername = (row.get('Telegram user name') || '').trim();
        if (sheetUsername.toLowerCase() === username.toLowerCase()) {
          return {
            rowNumber: i + 2,
            nameFull: row.get('Name full') || '',
            workTime: row.get('Work time') || '',
            telegramName: row.get('Telegram name') || '',
            company: row.get('Company') || '',
            telegramUsername: row.get('Telegram user name') || '',
            telegramId: row.get('Telegram Id') || '',
            _row: row
          };
        }
      }
      return null;
    } catch (error) {
      logger.error(`Error finding employee by username: ${error.message}`);
      return null;
    }
  }

  /**
   * Find employee by Telegram display name (first name) in Roster sheet
   * @param {string} firstName - User's Telegram first name
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByTelegramName(firstName) {
    try {
      if (!firstName) return null;

      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rows = await roster.getRows();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sheetTelegramName = (row.get('Telegram name') || '').trim();

        // Check if Telegram name matches (case-insensitive)
        if (sheetTelegramName.toLowerCase() === firstName.toLowerCase()) {
          // Check if not already registered
          const telegramId = (row.get('Telegram Id') || '').toString().trim();
          if (!telegramId) {
            return {
              rowNumber: i + 2,
              nameFull: row.get('Name full') || '',
              workTime: row.get('Work time') || '',
              telegramName: row.get('Telegram name') || '',
              company: row.get('Company') || '',
              telegramUsername: row.get('Telegram user name') || '',
              telegramId: row.get('Telegram Id') || '',
              _row: row
            };
          }
        }
      }
      return null;
    } catch (error) {
      logger.error(`Error finding employee by Telegram name: ${error.message}`);
      return null;
    }
  }

  /**
   * Get list of employees without Telegram ID (unregistered)
   * @returns {Array} List of employee objects
   */
  async getUnregisteredEmployees() {
    try {
      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rows = await roster.getRows();

      const unregistered = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const telegramId = (row.get('Telegram Id') || '').toString().trim();
        if (!telegramId) {
          unregistered.push({
            rowNumber: i + 2,
            nameFull: row.get('Name full') || '',
            workTime: row.get('Work time') || '',
            telegramName: row.get('Telegram name') || '',
            company: row.get('Company') || '',
            telegramUsername: row.get('Telegram user name') || '',
            _row: row
          });
        }
      }
      return unregistered;
    } catch (error) {
      logger.error(`Error getting unregistered employees: ${error.message}`);
      return [];
    }
  }

  /**
   * Register employee by updating their Telegram ID in the sheet
   * @param {number} rowNumber - Row number in the sheet
   * @param {number} telegramId - User's Telegram ID
   * @returns {boolean} True if successful, false otherwise
   */
  async registerEmployee(rowNumber, telegramId) {
    try {
      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      await roster.loadCells();

      // Get the cell (rowNumber-1 because of 0-index, and we need column F which is index 5)
      const cell = roster.getCell(rowNumber - 1, 5); // Column F (Telegram Id)
      cell.value = telegramId.toString();
      await roster.saveUpdatedCells();

      logger.info(`Registered employee at row ${rowNumber} with telegram_id ${telegramId}`);
      return true;
    } catch (error) {
      logger.error(`Error registering employee: ${error.message}`);
      return false;
    }
  }

  /**
   * Initialize daily attendance sheet with all employees
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful, false otherwise
   */
  async initializeDailySheet(dateStr) {
    try {
      const sheetName = dateStr; // e.g., "2025-10-29"

      // Check if sheet already exists and has data
      // Force refresh to get current sheet state from Google API (prevent stale cache)
      await this.doc.loadInfo();
      let worksheet = await this.getWorksheet(sheetName);

      // Multi-level check for existing data to prevent accidental re-initialization
      let hasHeaders = false;
      let existingRows = [];
      let hasExistingData = false;

      // Check 1: Row count - if sheet has more than 1 row, it has data
      const rowCount = worksheet.rowCount || 0;
      hasExistingData = rowCount > 1; // More than just header row

      // Check 2: Try to load headers
      try {
        await worksheet.loadHeaderRow();
        const headerValues = worksheet.headerValues || [];
        hasHeaders = headerValues.length > 0;

        if (hasHeaders) {
          existingRows = await worksheet.getRows();
        }

        logger.info(`Sheet ${sheetName} state check: hasHeaders=${hasHeaders}, rowCount=${rowCount}, existingRows=${existingRows.length}, headerValues=${headerValues.length}`);
      } catch (err) {
        logger.warn(`Header detection error for ${sheetName}: ${err.message}`);
        hasHeaders = false;
      }

      // CRITICAL SAFETY CHECK: If sheet has rows but headers not detected,
      // treat as existing to prevent data loss
      if (!hasHeaders && hasExistingData) {
        logger.warn(`⚠️  SAFETY CHECK: Sheet ${sheetName} has ${rowCount} rows but headers not detected - treating as existing to PREVENT DATA LOSS`);
        hasHeaders = true; // Force true to prevent re-initialization

        // Try to load rows without headers to preserve them
        try {
          existingRows = await worksheet.getRows();
          logger.info(`Loaded ${existingRows.length} existing rows without header detection`);
        } catch (err) {
          logger.error(`Failed to load existing rows: ${err.message}`);
        }
      }

      // Get all employees from Worker info sheet
      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rosterRows = await roster.getRows();

      // If headers don't exist, initialize the sheet
      if (!hasHeaders) {
        // Resize sheet to fit all columns (we have 29 columns)
        await worksheet.resize({ rowCount: 1000, columnCount: 35 });

        // Set headers
        await worksheet.setHeaderRow([
          'Name',
          'TelegramId',
          'Came on time',
          'When come',
          'Leave time',
          'Hours worked',
          'Remaining hours to work',
          'Left early',
          'Why left early',
          'will be late',
          'will be late will come at',
          'reminder_1_sent',
          'reminder_2_sent',
          'reminder_3_sent',
          'Absent',
          'Why absent',
          'Left temporarily',
          'How long was out',
          'Temp exit time',
          'Temp exit reason',
          'Temp exit duration',
          'Temp exit expected return',
          'Temp exit remind at',
          'Temp exit actual return',
          'Temp exit remind sent',
          'Currently out',
          'Penalty minutes',
          'Required end time',
          'Point'
        ]);
        await worksheet.loadHeaderRow();

        // Add all employees to daily sheet
        for (const row of rosterRows) {
          const nameFull = row.get('Name full') || '';
          const telegramId = row.get('Telegram Id') || '';
          const workTime = row.get('Work time') || '';

          // Only add if name exists
          if (nameFull.trim()) {
            await worksheet.addRow({
              'Name': nameFull,
              'TelegramId': telegramId,
              'Came on time': '',
              'When come': '',
              'Leave time': '',
              'Hours worked': '',
              'Remaining hours to work': '',
              'Left early': '',
              'Why left early': '',
              'will be late': '',
              'will be late will come at': '',
              'reminder_1_sent': 'false',
              'reminder_2_sent': 'false',
              'reminder_3_sent': 'false',
              'Absent': '',
              'Why absent': '',
              'Left temporarily': '',
              'How long was out': '',
              'Temp exit time': '',
              'Temp exit reason': '',
              'Temp exit duration': '',
              'Temp exit expected return': '',
              'Temp exit remind at': '',
              'Temp exit actual return': '',
              'Temp exit remind sent': 'false',
              'Currently out': 'false',
              'Penalty minutes': '',
              'Required end time': '',
              'Point': ''
            });
          }
        }

        logger.info(`Initialized daily sheet ${sheetName} with all employees`);

        // If in dev mode, also initialize/update monthly report
        if (Config.AUTO_UPDATE_MONTHLY_REPORT) {
          const yearMonth = moment.tz(sheetName, Config.TIMEZONE).format('YYYY-MM');
          const reportSheetName = `Report_${yearMonth}`;

          // Check if monthly report exists
          if (!this.doc.sheetsByTitle[reportSheetName]) {
            logger.info(`Creating monthly report ${reportSheetName} (dev mode)`);
            await this.initializeMonthlyReport(yearMonth);
          }
        }
      } else {
        // Sheet already exists with headers - check for new employees to add
        logger.info(`Daily sheet ${sheetName} already exists, checking for new employees...`);

        // Get existing employee IDs and names in the daily sheet
        const existingEmployees = new Set();
        for (const row of existingRows) {
          const telegramId = (row.get('TelegramId') || '').toString().trim();
          const name = (row.get('Name') || '').toString().trim();
          // Track both telegram ID and name to handle employees with and without IDs
          if (telegramId) {
            existingEmployees.add(`id:${telegramId}`);
          }
          if (name) {
            existingEmployees.add(`name:${name}`);
          }
        }

        // Find employees from Roster that are NOT in the daily sheet
        let newEmployeesAdded = 0;
        for (const row of rosterRows) {
          const nameFull = row.get('Name full') || '';
          const telegramId = row.get('Telegram Id') || '';

          // Skip if no name
          if (!nameFull.trim()) {
            continue;
          }

          // Check if this employee is already in the daily sheet
          const hasId = telegramId && existingEmployees.has(`id:${telegramId.toString().trim()}`);
          const hasName = existingEmployees.has(`name:${nameFull.trim()}`);

          if (!hasId && !hasName) {
            // This is a NEW employee not in the daily sheet - add them
            logger.info(`Adding new employee to ${sheetName}: ${nameFull} (ID: ${telegramId || 'none'})`);

            await worksheet.addRow({
              'Name': nameFull,
              'TelegramId': telegramId,
              'Came on time': '',
              'When come': '',
              'Leave time': '',
              'Hours worked': '',
              'Remaining hours to work': '',
              'Left early': '',
              'Why left early': '',
              'will be late': '',
              'will be late will come at': '',
              'reminder_1_sent': 'false',
              'reminder_2_sent': 'false',
              'reminder_3_sent': 'false',
              'Absent': '',
              'Why absent': '',
              'Left temporarily': '',
              'How long was out': '',
              'Temp exit time': '',
              'Temp exit reason': '',
              'Temp exit duration': '',
              'Temp exit expected return': '',
              'Temp exit remind at': '',
              'Temp exit actual return': '',
              'Temp exit remind sent': 'false',
              'Currently out': 'false',
              'Penalty minutes': '',
              'Required end time': '',
              'Point': ''
            });

            newEmployeesAdded++;
          }
        }

        if (newEmployeesAdded > 0) {
          logger.info(`Added ${newEmployeesAdded} new employee(s) to existing daily sheet ${sheetName}`);
        } else {
          logger.info(`No new employees to add to ${sheetName}`);
        }
      }

      return true;
    } catch (error) {
      logger.error(`Error initializing daily sheet: ${error.message}`);
      return false;
    }
  }

  /**
   * Log an event to the daily attendance sheet
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {string} eventType - Event type (ARRIVAL, DEPARTURE, LATE, etc.)
   * @param {string} details - Additional details
   * @param {number} ratingImpact - Impact on rating
   * @returns {boolean} True if successful, false otherwise
   */
  async logEvent(telegramId, name, eventType, details = '', ratingImpact = 0.0) {
    try {
      // Duplicate event prevention: Use in-memory cache to prevent duplicate events within 5 seconds
      if (!this._recentEvents) {
        this._recentEvents = new Map();
      }

      // Create unique key: telegramId-eventType-5secondWindow
      const eventKey = `${telegramId}-${eventType}-${Math.floor(Date.now() / 5000)}`;
      if (this._recentEvents.has(eventKey)) {
        logger.warn(`⚠️  Duplicate event PREVENTED: ${eventType} for ${name} (${telegramId})`);
        return true; // Return success to prevent retries
      }

      // Mark this event as processed
      this._recentEvents.set(eventKey, true);

      // Clean up old entries periodically (keep last 100)
      if (this._recentEvents.size > 100) {
        const firstKey = this._recentEvents.keys().next().value;
        this._recentEvents.delete(firstKey);
      }

      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD'); // e.g., "2025-10-29"

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      // Get the daily sheet
      let worksheet = await this.getWorksheet(sheetName);

      // Load headers (should exist now after initialization)
      try {
        await worksheet.loadHeaderRow();
      } catch (err) {
        logger.error(`Failed to load headers for ${sheetName}: ${err.message}`);
        return false;
      }

      const rows = await worksheet.getRows();

      // Find the employee's row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        logger.warn(`Employee with telegram_id ${telegramId} not found in daily sheet`);
        return false;
      }

      // Update the row based on event type
      if (eventType === 'ARRIVAL') {
        employeeRow.set('When come', now.format('HH:mm:ss'));

        // Determine if came on time by checking work time
        let cameOnTime = 'Yes';
        try {
          // Get employee info from roster to get work time
          const roster = await this.getWorksheet(Config.SHEET_ROSTER);
          await roster.loadHeaderRow();
          const rosterRows = await roster.getRows();

          let workTime = null;
          for (const rosterRow of rosterRows) {
            if (rosterRow.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
              workTime = rosterRow.get('Work time') || '';
              break;
            }
          }

          if (workTime && workTime !== '-') {
            // Parse work time (e.g., "10:00-19:00")
            const times = workTime.split('-');
            const startTime = times[0].trim();
            const endTime = times[1].trim();

            const [startHour, startMinute] = startTime.split(':').map(num => parseInt(num));
            const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));

            // Create moment objects for comparison
            const workStart = moment.tz(Config.TIMEZONE).set({ hour: startHour, minute: startMinute, second: 0 });
            const graceEnd = workStart.clone().add(Config.GRACE_PERIOD_MINUTES, 'minutes');

            // Check if arrived after grace period
            if (now.isAfter(graceEnd)) {
              cameOnTime = 'No';
            }
          }
        } catch (err) {
          logger.error(`Error checking work time: ${err.message}`);
        }

        employeeRow.set('Came on time', cameOnTime);

        // Calculate point based on attendance and penalty time
        let point = 0;
        let penaltyMinutes = 0;
        let requiredEndTime = '';
        const wasLate = employeeRow.get('will be late') || '';

        if (cameOnTime === 'Yes') {
          // Came on time: full point
          point = 1.0;
        } else {
          // Came late - calculate lateness and penalty
          try {
            // Get employee info from roster to get work time
            const roster = await this.getWorksheet(Config.SHEET_ROSTER);
            await roster.loadHeaderRow();
            const rosterRows = await roster.getRows();

            let workTime = null;
            for (const rosterRow of rosterRows) {
              if (rosterRow.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
                workTime = rosterRow.get('Work time') || '';
                break;
              }
            }

            if (workTime && workTime !== '-') {
              // Parse work time (e.g., "10:00-19:00")
              const times = workTime.split('-');
              const startTime = times[0].trim();
              const endTime = times[1].trim();

              const [startHour, startMinute] = startTime.split(':').map(num => parseInt(num));
              const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));

              // Create moment objects
              const workStart = moment.tz(Config.TIMEZONE).set({ hour: startHour, minute: startMinute, second: 0 });
              const workEnd = moment.tz(Config.TIMEZONE).set({ hour: endHour, minute: endMinute, second: 0 });
              const graceEnd = workStart.clone().add(Config.GRACE_PERIOD_MINUTES, 'minutes');

              // Calculate lateness
              const latenessMinutes = Math.max(0, now.diff(graceEnd, 'minutes'));

              if (latenessMinutes > 0) {
                // Only add penalty time if person did NOT notify about being late
                if (wasLate.toLowerCase() !== 'yes') {
                  // Calculate penalty time
                  penaltyMinutes = Math.floor(latenessMinutes * Config.PENALTY_MULTIPLIER);
                  if (penaltyMinutes > Config.PENALTY_MAX_MINUTES) {
                    penaltyMinutes = Config.PENALTY_MAX_MINUTES;
                  }

                  // Calculate required end time (work end + penalty)
                  const requiredEnd = workEnd.clone().add(penaltyMinutes, 'minutes');
                  requiredEndTime = requiredEnd.format('HH:mm');
                } else {
                  // Notified about being late - NO penalty time required!
                  penaltyMinutes = 0;
                  requiredEndTime = ''; // No extended work time
                }
              }
            }
          } catch (err) {
            logger.error(`Error calculating penalty time: ${err.message}`);
          }

          if (wasLate.toLowerCase() === 'yes') {
            // Late but notified: give +1 point (reward for being responsible)
            // NO penalty time required!
            point = 1.0;
          } else {
            // Late without notification: get penalty point AND penalty time
            point = Config.LATE_SILENT_PENALTY;
          }
        }

        employeeRow.set('Point', point.toString());
        employeeRow.set('Penalty minutes', penaltyMinutes.toString());
        employeeRow.set('Required end time', requiredEndTime);

        // Reminder logic is now handled by scheduler with 3-step reminders

        await employeeRow.save();
      } else if (eventType === 'LATE_NOTIFIED') {
        employeeRow.set('will be late', 'Yes');
        if (details) {
          employeeRow.set('will be late will come at', details);
        }
        await employeeRow.save();
      } else if (eventType === 'ABSENT' || eventType === 'ABSENT_NOTIFIED') {
        employeeRow.set('Absent', 'Yes');
        if (details) {
          employeeRow.set('Why absent', details);
        }

        // Calculate point for absence
        // If notified (ABSENT_NOTIFIED), give 1 point (full credit). If silent (ABSENT), apply penalty.
        const point = eventType === 'ABSENT_NOTIFIED' ? 1.0 : Config.ABSENT_PENALTY;
        employeeRow.set('Point', point.toString());

        // Person is absent, stop arrival reminders
        employeeRow.set('reminder_1_sent', 'true');
        employeeRow.set('reminder_2_sent', 'true');
        employeeRow.set('reminder_3_sent', 'true');

        await employeeRow.save();
      } else if (eventType === 'EXTEND') {
        // Person will work overtime
        // Reminder logic is now handled by scheduler
        await employeeRow.save();
      } else if (eventType === 'DEPARTURE') {
        // Person left work, reminders not needed

        // Set leave time
        employeeRow.set('Leave time', now.format('HH:mm:ss'));

        // Get work schedule to check if person is leaving before shift even started
        let workStartTime = null;
        let workEndTime = null;

        try {
          const roster = await this.getWorksheet(Config.SHEET_ROSTER);
          await roster.loadHeaderRow();
          const rosterRows = await roster.getRows();

          let workTime = null;
          for (const rosterRow of rosterRows) {
            if (rosterRow.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
              workTime = rosterRow.get('Work time') || '';
              break;
            }
          }

          if (workTime && workTime !== '-') {
            const times = workTime.split('-');
            const startTime = times[0].trim();
            const endTime = times[1].trim();

            const [startHour, startMinute] = startTime.split(':').map(num => parseInt(num));
            const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));

            workStartTime = moment.tz(Config.TIMEZONE).set({ hour: startHour, minute: startMinute, second: 0 });
            workEndTime = moment.tz(Config.TIMEZONE).set({ hour: endHour, minute: endMinute, second: 0 });
          }
        } catch (err) {
          logger.error(`Error getting work schedule: ${err.message}`);
        }

        // Check if person is leaving BEFORE their work shift even started
        if (workStartTime && now.isBefore(workStartTime)) {
          // Left before shift started!
          logger.warn(`${name} left at ${now.format('HH:mm')} BEFORE work shift starts at ${workStartTime.format('HH:mm')}`);

          employeeRow.set('Hours worked', '0');
          employeeRow.set('Left early', 'Yes - Before shift');

          // Calculate how many hours before shift they left
          const hoursBeforeShift = workStartTime.diff(now, 'minutes') / 60;
          const totalShiftHours = workEndTime.diff(workStartTime, 'minutes') / 60;
          employeeRow.set('Remaining hours to work', totalShiftHours.toFixed(2));

          if (details && details !== 'on_time' && details !== 'On time') {
            employeeRow.set('Why left early', details + ' (before shift started)');
          } else {
            employeeRow.set('Why left early', 'Left before shift started');
          }

          // Severe penalty for leaving before shift
          const currentPoint = parseFloat(employeeRow.get('Point') || '0');
          const leftBeforeShiftPenalty = -1.5; // Severe penalty
          const newPoint = currentPoint + leftBeforeShiftPenalty;

          employeeRow.set('Point', newPoint.toString());
          logger.warn(`Left before shift penalty: ${currentPoint} → ${newPoint}`);

          await employeeRow.save();
          return true;
        }

        // Calculate hours worked and check if worked full required hours
        const whenCome = employeeRow.get('When come') || '';
        let actualWorkedMinutes = 0;
        let workedFullHours = false;

        if (whenCome.trim()) {
          try {
            // Parse arrival time (format: HH:mm:ss)
            const [arriveHour, arriveMinute, arriveSecond] = whenCome.split(':').map(num => parseInt(num));
            const arrivalTime = moment.tz(Config.TIMEZONE)
              .set({ hour: arriveHour, minute: arriveMinute, second: arriveSecond || 0 });

            // Calculate duration in hours
            actualWorkedMinutes = now.diff(arrivalTime, 'minutes');
            const hoursWorked = (actualWorkedMinutes / 60).toFixed(2);

            employeeRow.set('Hours worked', hoursWorked);

            // Check if worked full required hours
            if (workStartTime && workEndTime) {
              const requiredWorkMinutes = workEndTime.diff(workStartTime, 'minutes');
              workedFullHours = actualWorkedMinutes >= requiredWorkMinutes;
            }
          } catch (err) {
            logger.error(`Error calculating hours worked: ${err.message}`);
          }
        }

        // Determine the actual required end time (either penalty time or normal work time)
        let actualRequiredEndTime = null;
        const requiredEndTimeStr = employeeRow.get('Required end time') || '';

        if (requiredEndTimeStr.trim()) {
          // Has penalty time - use it
          try {
            const [reqHour, reqMinute] = requiredEndTimeStr.split(':').map(num => parseInt(num));
            actualRequiredEndTime = moment.tz(Config.TIMEZONE)
              .set({ hour: reqHour, minute: reqMinute, second: 0 });
          } catch (err) {
            logger.error(`Error parsing required end time: ${err.message}`);
          }
        } else {
          // No penalty - use normal work end time from roster
          try {
            const roster = await this.getWorksheet(Config.SHEET_ROSTER);
            await roster.loadHeaderRow();
            const rosterRows = await roster.getRows();

            let workTime = null;
            for (const rosterRow of rosterRows) {
              if (rosterRow.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
                workTime = rosterRow.get('Work time') || '';
                break;
              }
            }

            if (workTime && workTime !== '-') {
              const times = workTime.split('-');
              const endTime = times[1].trim();
              const [endHour, endMinute] = endTime.split(':').map(num => parseInt(num));
              actualRequiredEndTime = moment.tz(Config.TIMEZONE)
                .set({ hour: endHour, minute: endMinute, second: 0 });
            }
          } catch (err) {
            logger.error(`Error getting normal work end time: ${err.message}`);
          }
        }

        // Check if left before required time (early departure)
        let leftEarly = 'No';
        let remainingHours = '0';

        if (actualRequiredEndTime && now.isBefore(actualRequiredEndTime)) {
          leftEarly = 'Yes';

          // Check if person worked full required hours
          if (workedFullHours) {
            // Worked full hours - no penalty, but note they left early
            leftEarly = 'Yes (worked full hours)';
            remainingHours = '0';

            // Store reason if provided
            if (details && details !== 'on_time' && details !== 'On time' && details !== 'Worked full hours (early schedule)') {
              employeeRow.set('Why left early', details);
            } else {
              employeeRow.set('Why left early', 'Worked full hours, early schedule');
            }

            logger.info(`${name} left early but worked full hours: ${actualWorkedMinutes} min. No penalty.`);
          } else {
            // Did NOT work full hours - calculate remaining and apply penalty
            // Calculate remaining hours based on required work hours
            if (workStartTime && workEndTime) {
              const requiredWorkMinutes = workEndTime.diff(workStartTime, 'minutes');
              const remainingMinutes = requiredWorkMinutes - actualWorkedMinutes;
              remainingHours = (remainingMinutes / 60).toFixed(2);
            } else {
              const remainingMinutes = actualRequiredEndTime.diff(now, 'minutes');
              remainingHours = (remainingMinutes / 60).toFixed(2);
            }

            // Store early departure reason if provided
            if (details && details !== 'on_time' && details !== 'On time') {
              employeeRow.set('Why left early', details);
            }

            // Early departure! Add penalty to existing point
            const currentPoint = parseFloat(employeeRow.get('Point') || '0');
            const earlyDeparturePenalty = Config.EARLY_DEPARTURE_PENALTY; // -0.5
            const newPoint = currentPoint + earlyDeparturePenalty; // Accumulate

            employeeRow.set('Point', newPoint.toString());
            logger.warn(`Early departure detected for ${name}: left at ${now.format('HH:mm')}, required until ${actualRequiredEndTime.format('HH:mm')}. Remaining hours: ${remainingHours}. Point: ${currentPoint} → ${newPoint}`);
          }
        } else if (actualRequiredEndTime) {
          // Left on time or later - no remaining hours
          remainingHours = '0';
          logger.info(`${name} left at proper time: ${now.format('HH:mm')} (required: ${actualRequiredEndTime.format('HH:mm')})`);
        } else {
          // No required end time found - this shouldn't happen, but log it
          logger.warn(`${name}: No required end time found for remaining hours calculation`);
          remainingHours = '0';
        }

        // Set the new columns
        employeeRow.set('Left early', leftEarly);
        employeeRow.set('Remaining hours to work', remainingHours);

        await employeeRow.save();
      }

      logger.info(`Logged event: ${eventType} for ${name}`);
      return true;
    } catch (error) {
      logger.error(`Error logging event: ${error.message}`);
      return false;
    }
  }

  /**
   * Log temporary exit
   * @param {string} telegramId - User's Telegram ID
   * @param {string} name - User's name
   * @param {string} reason - Reason for exit
   * @param {number} durationMinutes - Duration in minutes
   * @param {string} exitTime - Exit time (HH:mm:ss)
   * @param {string} expectedReturn - Expected return time (HH:mm:ss)
   */
  async logTempExit(telegramId, name, reason, durationMinutes, exitTime, expectedReturn) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      const worksheet = await this.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find the employee's row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        throw new Error('Employee row not found');
      }

      // Get existing temp exit data (to support multiple exits)
      const existingExitTimes = employeeRow.get('Temp exit time') || '';
      const existingReasons = employeeRow.get('Temp exit reason') || '';
      const existingDurations = employeeRow.get('Temp exit duration') || '';
      const existingExpectedReturns = employeeRow.get('Temp exit expected return') || '';
      const existingRemindAts = employeeRow.get('Temp exit remind at') || '';

      // Calculate remind time (15 minutes before expected return)
      const expectedReturnMoment = moment.tz(expectedReturn, 'HH:mm:ss', Config.TIMEZONE);
      const remindAt = expectedReturnMoment.clone().subtract(15, 'minutes').format('HH:mm:ss');

      // Append new exit data (use semicolon as separator for multiple exits)
      const newExitTimes = existingExitTimes ? `${existingExitTimes}; ${exitTime}` : exitTime;
      const newReasons = existingReasons ? `${existingReasons}; ${reason}` : reason;
      const newDurations = existingDurations ? `${existingDurations}; ${durationMinutes}` : durationMinutes.toString();
      const newExpectedReturns = existingExpectedReturns ? `${existingExpectedReturns}; ${expectedReturn}` : expectedReturn;
      const newRemindAts = existingRemindAts ? `${existingRemindAts}; ${remindAt}` : remindAt;

      // Update temp exit fields
      employeeRow.set('Left temporarily', 'Yes');
      employeeRow.set('Temp exit time', newExitTimes);
      employeeRow.set('Temp exit reason', newReasons);
      employeeRow.set('Temp exit duration', newDurations);
      employeeRow.set('Temp exit expected return', newExpectedReturns);
      employeeRow.set('Temp exit remind at', newRemindAts);
      employeeRow.set('Temp exit remind sent', 'false');
      employeeRow.set('Currently out', 'true');

      await employeeRow.save();

      logger.info(`Temporary exit logged for ${name}: ${reason}, ${durationMinutes} min`);
      return true;
    } catch (error) {
      logger.error(`Error logging temporary exit: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log return from temporary exit
   * @param {string} telegramId - User's Telegram ID
   * @param {string} name - User's name
   * @param {string} returnTime - Return time (HH:mm:ss)
   */
  async logTempReturn(telegramId, name, returnTime) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      const worksheet = await this.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find the employee's row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        throw new Error('Employee row not found');
      }

      // Get exit time to calculate how long they were out
      const exitTimes = employeeRow.get('Temp exit time') || '';
      const existingReturns = employeeRow.get('Temp exit actual return') || '';
      const existingDurations = employeeRow.get('How long was out') || '';

      let minutesOut = 0;

      if (exitTimes) {
        try {
          // Get the last exit time (most recent)
          const exitTimeArray = exitTimes.split('; ');
          const lastExitTime = exitTimeArray[exitTimeArray.length - 1];

          // Parse times (format: HH:mm:ss)
          const exitMoment = moment.tz(lastExitTime, 'HH:mm:ss', Config.TIMEZONE);
          const returnMoment = moment.tz(returnTime, 'HH:mm:ss', Config.TIMEZONE);

          // Calculate difference in minutes
          minutesOut = returnMoment.diff(exitMoment, 'minutes');

          // If negative (crossed midnight), add 24 hours
          if (minutesOut < 0) {
            minutesOut += 24 * 60;
          }
        } catch (err) {
          logger.error(`Error calculating time out: ${err.message}`);
        }
      }

      // Append return time and duration
      const newReturns = existingReturns ? `${existingReturns}; ${returnTime}` : returnTime;
      const durationText = minutesOut > 0 ? `${minutesOut} мин` : '0 мин';
      const newDurations = existingDurations ? `${existingDurations}; ${durationText}` : durationText;

      // Update return fields
      employeeRow.set('Temp exit actual return', newReturns);
      employeeRow.set('Currently out', 'false');
      employeeRow.set('How long was out', newDurations);

      await employeeRow.save();

      logger.info(`Return from temporary exit logged for ${name} at ${returnTime}, was out for ${minutesOut} min`);
      return minutesOut;
    } catch (error) {
      logger.error(`Error logging temporary return: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user's status for today (arrival, departure, violations)
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} Status information
   */
  async getUserStatusToday(telegramId) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      const worksheet = await this.getWorksheet(sheetName);

      // Load headers (should exist now after initialization)
      try {
        await worksheet.loadHeaderRow();
      } catch (err) {
        logger.error(`Failed to load headers for ${sheetName}: ${err.message}`);
        return {
          hasArrived: false,
          arrivalTime: null,
          hasDeparted: false,
          departureTime: null,
          departureMessage: '',
          violations: [],
          lateNotified: false,
          extendNotified: false,
          isAbsent: false,
          todayPoint: 0,
          currentlyOut: false
        };
      }

      const rows = await worksheet.getRows();

      // Find the employee's row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        return {
          hasArrived: false,
          arrivalTime: null,
          hasDeparted: false,
          departureTime: null,
          departureMessage: '',
          violations: [],
          lateNotified: false,
          extendNotified: false,
          isAbsent: false,
          todayPoint: 0,
          currentlyOut: false
        };
      }

      // Read status from the daily sheet
      const whenCome = employeeRow.get('When come') || '';
      const leaveTime = employeeRow.get('Leave time') || '';
      const willBeLate = employeeRow.get('will be late') || '';
      const absent = employeeRow.get('Absent') || '';
      const pointStr = employeeRow.get('Point') || '0';
      const currentlyOut = employeeRow.get('Currently out') || 'false';

      // Parse the point value
      let todayPoint = 0;
      try {
        todayPoint = parseFloat(pointStr) || 0;
      } catch (err) {
        todayPoint = 0;
      }

      const status = {
        hasArrived: whenCome.trim() !== '',
        arrivalTime: whenCome || null,
        hasDeparted: leaveTime.trim() !== '',
        departureTime: leaveTime || null,
        departureMessage: '',
        violations: [],
        lateNotified: willBeLate.toLowerCase() === 'yes',
        extendNotified: false,
        isAbsent: absent.toLowerCase() === 'yes',
        todayPoint: todayPoint,
        currentlyOut: currentlyOut.toLowerCase() === 'true'
      };

      return status;
    } catch (error) {
      logger.error(`Error getting user status: ${error.message}`);
      return {
        hasArrived: false,
        arrivalTime: null,
        hasDeparted: false,
        departureTime: null,
        departureMessage: '',
        violations: [],
        lateNotified: false,
        extendNotified: false,
        currentlyOut: false
      };
    }
  }

  /**
   * Calculate user's rating for current month
   * @param {number} telegramId - User's Telegram ID
   * @returns {number} Current rating (0-10 scale)
   */
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
  async logDayBalance(telegramId, name, deficitMinutes = 0, surplusMinutes = 0, penaltyMinutes = 0) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      await this.initializeDailySheet(sheetName);
      const worksheet = await this.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find employee row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        logger.warn(`Employee with telegram_id ${telegramId} not found in daily sheet for balance logging`);
        return false;
      }

      // Determine balance type and store it
      let balanceType = '';
      let balanceMinutes = 0;

      if (deficitMinutes > 0) {
        balanceType = 'DEFICIT';
        balanceMinutes = -deficitMinutes; // Negative for deficit
      } else if (surplusMinutes > 0 && penaltyMinutes === 0) {
        balanceType = 'SURPLUS';
        balanceMinutes = surplusMinutes; // Positive for surplus
      } else if (surplusMinutes > 0 && penaltyMinutes > 0) {
        balanceType = 'NO_CREDIT';
        balanceMinutes = 0; // Not credited
      } else {
        balanceType = 'COMPLETE';
        balanceMinutes = 0;
      }

      // Add new columns if they don't exist in header
      const headers = worksheet.headerValues;
      if (!headers.includes('Day Balance Type')) {
        await worksheet.setHeaderRow([...headers, 'Day Balance Type', 'Balance Minutes']);
        await worksheet.loadHeaderRow();
      } else if (!headers.includes('Balance Minutes')) {
        await worksheet.setHeaderRow([...headers, 'Balance Minutes']);
        await worksheet.loadHeaderRow();
      }

      // Set balance data
      employeeRow.set('Day Balance Type', balanceType);
      employeeRow.set('Balance Minutes', balanceMinutes.toString());

      await employeeRow.save();

      logger.info(`Day balance logged for ${name}: ${balanceType}, ${balanceMinutes} min`);
      return true;
    } catch (error) {
      logger.error(`Error logging day balance: ${error.message}`);
      return false;
    }
  }

  /**
   * Calculate cumulative time balance for the month (deficit/surplus)
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} Object with totalDeficitMinutes, totalSurplusMinutes, netBalanceMinutes
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
          const dailySheet = this.doc.sheetsByTitle[dateStr];
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
   * Initialize monthly report sheet at the start of each month
   * @param {string} yearMonth - Year and month in YYYY-MM format
   * @returns {boolean} True if successful
   */
  async initializeMonthlyReport(yearMonth) {
    try {
      const sheetName = `Report_${yearMonth}`; // e.g., "Report_2025-10"

      // Check if sheet already exists
      let worksheet = this.doc.sheetsByTitle[sheetName];

      if (!worksheet) {
        logger.info(`Creating monthly report sheet: ${sheetName}`);
        worksheet = await this.doc.addSheet({ title: sheetName });
      }

      // Resize sheet to fit all columns (we have 31 columns)
      await worksheet.resize({ rowCount: 1000, columnCount: 35 });

      // Set headers
      await worksheet.setHeaderRow([
        'Name',
        'Telegram ID',
        'Company',
        'Work Schedule',
        'Total Work Days',
        'Days Worked',
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
        'Hours Deficit/Surplus',
        'Total Penalty Minutes',
        'Total Deficit Minutes',
        'Total Surplus Minutes',
        'Net Balance Minutes',
        'Net Balance (Hours)',
        'Balance Status',
        'Total Points',
        'Average Daily Points',
        'Attendance Rate %',
        'On-Time Rate %',
        'Rating (0-10)',
        'Rating Zone',
        'Last Updated'
      ]);
      await worksheet.loadHeaderRow();

      // Get all employees from roster
      const roster = await this.getWorksheet(Config.SHEET_ROSTER);
      await roster.loadHeaderRow();
      const rows = await roster.getRows();

      // Add all employees to monthly report
      for (const row of rows) {
        const nameFull = row.get('Name full') || '';
        const telegramId = row.get('Telegram Id') || '';
        const company = row.get('Company') || '';
        const workTime = row.get('Work time') || '';

        if (nameFull.trim()) {
          await worksheet.addRow({
            'Name': nameFull,
            'Telegram ID': telegramId,
            'Company': company,
            'Work Schedule': workTime,
            'Total Work Days': 0,
            'Days Worked': 0,
            'Days Absent': 0,
            'Days Absent (Notified)': 0,
            'Days Absent (Silent)': 0,
            'On Time Arrivals': 0,
            'Late Arrivals (Notified)': 0,
            'Late Arrivals (Silent)': 0,
            'Early Departures': 0,
            'Early Departures (Worked Full Hours)': 0,
            'Left Before Shift': 0,
            'Total Hours Required': 0,
            'Total Hours Worked': 0,
            'Hours Deficit/Surplus': 0,
            'Total Penalty Minutes': 0,
            'Total Deficit Minutes': 0,
            'Total Surplus Minutes': 0,
            'Net Balance Minutes': 0,
            'Net Balance (Hours)': '0:00',
            'Balance Status': '⚪ None',
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
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful
   */
  async updateMonthlyReport(dateStr) {
    try {
      const date = moment.tz(dateStr, Config.TIMEZONE);
      const yearMonth = date.format('YYYY-MM');
      const reportSheetName = `Report_${yearMonth}`;

      // Get or create monthly report sheet
      let reportSheet = this.doc.sheetsByTitle[reportSheetName];
      if (!reportSheet) {
        await this.initializeMonthlyReport(yearMonth);
        reportSheet = this.doc.sheetsByTitle[reportSheetName];
      }

      await reportSheet.loadHeaderRow();
      const reportRows = await reportSheet.getRows();

      // Get daily attendance sheet
      const dailySheet = await this.getWorksheet(dateStr);
      await dailySheet.loadHeaderRow();
      const dailyRows = await dailySheet.getRows();

      // Process each employee
      for (const reportRow of reportRows) {
        const telegramId = reportRow.get('Telegram ID') || '';
        if (!telegramId) continue;

        // Find employee in daily sheet
        const dailyRow = dailyRows.find(row =>
          row.get('TelegramId')?.toString().trim() === telegramId.toString()
        );

        if (!dailyRow) continue;

        // Get daily data
        const cameOnTime = dailyRow.get('Came on time') || '';
        const whenCome = dailyRow.get('When come') || '';
        const leaveTime = dailyRow.get('Leave time') || '';
        const hoursWorked = parseFloat(dailyRow.get('Hours worked') || '0');
        const leftEarly = dailyRow.get('Left early') || '';
        const willBeLate = dailyRow.get('will be late') || '';
        const absent = dailyRow.get('Absent') || '';
        const whyAbsent = dailyRow.get('Why absent') || '';
        const penaltyMinutes = parseInt(dailyRow.get('Penalty minutes') || '0');
        const point = parseFloat(dailyRow.get('Point') || '0');

        // Get current values from report
        let totalWorkDays = parseInt(reportRow.get('Total Work Days') || '0');
        let daysWorked = parseInt(reportRow.get('Days Worked') || '0');
        let daysAbsent = parseInt(reportRow.get('Days Absent') || '0');
        let daysAbsentNotified = parseInt(reportRow.get('Days Absent (Notified)') || '0');
        let daysAbsentSilent = parseInt(reportRow.get('Days Absent (Silent)') || '0');
        let onTimeArrivals = parseInt(reportRow.get('On Time Arrivals') || '0');
        let lateNotified = parseInt(reportRow.get('Late Arrivals (Notified)') || '0');
        let lateSilent = parseInt(reportRow.get('Late Arrivals (Silent)') || '0');
        let earlyDepartures = parseInt(reportRow.get('Early Departures') || '0');
        let earlyFullHours = parseInt(reportRow.get('Early Departures (Worked Full Hours)') || '0');
        let leftBeforeShift = parseInt(reportRow.get('Left Before Shift') || '0');
        let totalHoursWorked = parseFloat(reportRow.get('Total Hours Worked') || '0');
        let totalPenaltyMinutes = parseInt(reportRow.get('Total Penalty Minutes') || '0');
        let totalPoints = parseFloat(reportRow.get('Total Points') || '0');

        // Increment total work days
        totalWorkDays++;

        // Update statistics based on daily data
        if (absent.toLowerCase() === 'yes') {
          daysAbsent++;
          if (whyAbsent && whyAbsent.trim()) {
            daysAbsentNotified++;
          } else {
            daysAbsentSilent++;
          }
        } else if (whenCome.trim()) {
          daysWorked++;
          totalHoursWorked += hoursWorked;
          totalPenaltyMinutes += penaltyMinutes;
          totalPoints += point;

          if (cameOnTime.toLowerCase() === 'yes') {
            onTimeArrivals++;
          } else {
            if (willBeLate.toLowerCase() === 'yes') {
              lateNotified++;
            } else {
              lateSilent++;
            }
          }

          if (leftEarly.toLowerCase() === 'yes (worked full hours)') {
            earlyFullHours++;
          } else if (leftEarly.toLowerCase() === 'yes') {
            earlyDepartures++;
          } else if (leftEarly.toLowerCase() === 'yes - before shift') {
            leftBeforeShift++;
          }
        }

        // Calculate hours required (work days × daily hours)
        const workSchedule = reportRow.get('Work Schedule') || '';
        let dailyHours = 8; // Default
        if (workSchedule && workSchedule !== '-') {
          try {
            const times = workSchedule.split('-');
            const [startHour, startMin] = times[0].trim().split(':').map(Number);
            const [endHour, endMin] = times[1].trim().split(':').map(Number);
            dailyHours = (endHour + endMin/60) - (startHour + startMin/60);
          } catch (err) {
            // Use default
          }
        }
        const totalHoursRequired = totalWorkDays * dailyHours;
        const hoursDeficit = totalHoursRequired - totalHoursWorked;

        // Calculate rates
        const attendanceRate = totalWorkDays > 0 ? ((daysWorked / totalWorkDays) * 100).toFixed(1) : 0;
        const onTimeRate = daysWorked > 0 ? ((onTimeArrivals / daysWorked) * 100).toFixed(1) : 0;
        const avgDailyPoints = daysWorked > 0 ? (totalPoints / daysWorked).toFixed(2) : 0;

        // Calculate rating (0-10 scale)
        // Rating = (totalPoints / totalWorkDays) × 10
        const rating = totalWorkDays > 0 ? Math.max(0, Math.min(10, (totalPoints / totalWorkDays) * 10)).toFixed(1) : 0;

        // Determine rating zone
        let ratingZone = '⚪';
        if (rating >= Config.GREEN_ZONE_MIN) {
          ratingZone = '🟢 Green';
        } else if (rating >= Config.YELLOW_ZONE_MIN) {
          ratingZone = '🟡 Yellow';
        } else {
          ratingZone = '🔴 Red';
        }

        // Calculate cumulative balance from all daily sheets this month
        let totalDeficitMinutes = 0;
        let totalSurplusMinutes = 0;

        try {
          // Iterate through all days from start of month to current date
          const startOfMonth = moment.tz(yearMonth, 'YYYY-MM', Config.TIMEZONE).startOf('month');
          const currentDate = moment.tz(dateStr, Config.TIMEZONE);
          const daysToCheck = currentDate.date();

          for (let day = 1; day <= daysToCheck; day++) {
            const checkDate = moment.tz(Config.TIMEZONE).year(startOfMonth.year()).month(startOfMonth.month()).date(day);
            const checkDateStr = checkDate.format('YYYY-MM-DD');

            try {
              const daySheet = this.doc.sheetsByTitle[checkDateStr];
              if (!daySheet) continue;

              await daySheet.loadHeaderRow();
              const dayRows = await daySheet.getRows();

              // Find this employee's row
              const employeeDayRow = dayRows.find(row =>
                row.get('TelegramId')?.toString().trim() === telegramId.toString()
              );

              if (employeeDayRow) {
                const balanceType = employeeDayRow.get('Day Balance Type') || '';
                const balanceMinutes = parseInt(employeeDayRow.get('Balance Minutes') || '0');

                if (balanceType === 'DEFICIT' && balanceMinutes < 0) {
                  totalDeficitMinutes += Math.abs(balanceMinutes);
                } else if (balanceType === 'SURPLUS' && balanceMinutes > 0) {
                  totalSurplusMinutes += balanceMinutes;
                }
              }
            } catch (dayErr) {
              // Sheet doesn't exist or error reading it, skip
              continue;
            }
          }
        } catch (balanceErr) {
          logger.error(`Error calculating balance for ${telegramId}: ${balanceErr.message}`);
        }

        // Calculate net balance
        const netBalanceMinutes = totalSurplusMinutes - totalDeficitMinutes;

        // Format as hours (e.g., "+5:30" or "-3:45")
        const absBalance = Math.abs(netBalanceMinutes);
        const balanceHours = Math.floor(absBalance / 60);
        const balanceMins = absBalance % 60;
        const balanceSign = netBalanceMinutes > 0 ? '+' : (netBalanceMinutes < 0 ? '-' : '');
        const netBalanceFormatted = `${balanceSign}${balanceHours}:${balanceMins.toString().padStart(2, '0')}`;

        // Determine balance status
        let balanceStatus = '⚪ Balanced';
        if (netBalanceMinutes > 60) {
          balanceStatus = '🟢 In Surplus';
        } else if (netBalanceMinutes < -60) {
          balanceStatus = '🔴 In Deficit';
        } else if (netBalanceMinutes > 0) {
          balanceStatus = '🟡 Slight Surplus';
        } else if (netBalanceMinutes < 0) {
          balanceStatus = '🟡 Slight Deficit';
        }

        // Update report row
        reportRow.set('Total Work Days', totalWorkDays);
        reportRow.set('Days Worked', daysWorked);
        reportRow.set('Days Absent', daysAbsent);
        reportRow.set('Days Absent (Notified)', daysAbsentNotified);
        reportRow.set('Days Absent (Silent)', daysAbsentSilent);
        reportRow.set('On Time Arrivals', onTimeArrivals);
        reportRow.set('Late Arrivals (Notified)', lateNotified);
        reportRow.set('Late Arrivals (Silent)', lateSilent);
        reportRow.set('Early Departures', earlyDepartures);
        reportRow.set('Early Departures (Worked Full Hours)', earlyFullHours);
        reportRow.set('Left Before Shift', leftBeforeShift);
        reportRow.set('Total Hours Required', totalHoursRequired.toFixed(2));
        reportRow.set('Total Hours Worked', totalHoursWorked.toFixed(2));
        reportRow.set('Hours Deficit/Surplus', hoursDeficit.toFixed(2));
        reportRow.set('Total Penalty Minutes', totalPenaltyMinutes);
        reportRow.set('Total Deficit Minutes', totalDeficitMinutes);
        reportRow.set('Total Surplus Minutes', totalSurplusMinutes);
        reportRow.set('Net Balance Minutes', netBalanceMinutes);
        reportRow.set('Net Balance (Hours)', netBalanceFormatted);
        reportRow.set('Balance Status', balanceStatus);
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
}

// Create and export singleton instance
const sheetsService = new SheetsService();
module.exports = sheetsService;
