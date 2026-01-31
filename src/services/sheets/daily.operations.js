/**
 * Daily Operations for Google Sheets Service
 * Handles all daily sheet operations and attendance tracking
 */

const moment = require('moment-timezone');
const Config = require('../../config');
const logger = require('../../utils/logger');

class DailyOperations {
  constructor(coreService, cacheManager, quotaHandler) {
    this.coreService = coreService;
    this.cacheManager = cacheManager;
    this.quotaHandler = quotaHandler;
    
    // For duplicate event prevention
    this._recentEvents = new Map();
  }

  async initializeDailySheet(dateStr) {
    try {
      const sheetName = dateStr; // e.g., "2025-10-29"

      // FIX #2 & #3: Check if sheet is already known to be initialized (extended cache to reduce API calls)
      const initCache = this.cacheManager._initializedSheets.get(sheetName);
      if (initCache && (Date.now() - initCache.timestamp) < this.cacheManager._initCacheTimeout) {
        logger.debug(`Sheet ${sheetName} already initialized (cached), skipping check`);
        return true;
      }

      // Check if there's already an initialization in progress for this sheet
      if (this.cacheManager._initializationLocks.has(sheetName)) {
        logger.debug(`Sheet ${sheetName} initialization already in progress, waiting...`);
        // Wait for existing initialization to complete
        await this.cacheManager._initializationLocks.get(sheetName);
        return true;
      }

      // Create a lock promise for this initialization
      let releaseLock;
      const lockPromise = new Promise(resolve => { releaseLock = resolve; });
      this.cacheManager._initializationLocks.set(sheetName, lockPromise);

      try {
        // Check if sheet already exists and has data
        // Use cache to avoid redundant API calls
        const existingSheet = this.coreService.doc.sheetsByTitle[sheetName];
        let worksheet = existingSheet || await this.quotaHandler.retryOperation(() => this.coreService.getWorksheet(sheetName));

      // Multi-level check for existing data to prevent accidental re-initialization
      let hasHeaders = false;
      let existingRows = [];
      let headerCheckFailed = false;
      let dataCheckFailed = false;

      // Try to load headers
      try {
        await worksheet.loadHeaderRow();
        const headerValues = worksheet.headerValues || [];
        hasHeaders = headerValues.length > 0;

        if (hasHeaders) {
          existingRows = await worksheet.getRows();
        }

        logger.info(`Sheet ${sheetName} state check: hasHeaders=${hasHeaders}, existingRows=${existingRows.length}, headerValues=${headerValues.length}`);
      } catch (err) {
        logger.warn(`Header detection error for ${sheetName}: ${err.message}`);

        // CRITICAL FIX: Check if this is a quota error
        const isQuotaError = err.message && (
          err.message.includes('429') ||
          err.message.includes('Quota exceeded') ||
          err.message.includes('quota metric')
        );

        if (isQuotaError) {
          headerCheckFailed = true;
        }

        hasHeaders = false;
      }

      // Check if sheet has actual data by trying to get cell values from first data row
      let hasActualData = false;
      if (!hasHeaders) {
        try {
          await worksheet.loadCells('A1:Z2');
          // Check if any cell in first two rows has a value
          for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 26; col++) {
              const cell = worksheet.getCell(row, col);
              if (cell && cell.value) {
                hasActualData = true;
                break;
              }
            }
            if (hasActualData) break;
          }
        } catch (err) {
          logger.warn(`Could not check for actual data: ${err.message}`);

          // CRITICAL FIX: Check if this is a quota error
          const isQuotaError = err.message && (
            err.message.includes('429') ||
            err.message.includes('Quota exceeded') ||
            err.message.includes('quota metric')
          );

          if (isQuotaError) {
            dataCheckFailed = true;
          }
        }
      }

      // CRITICAL FIX: If BOTH checks failed due to quota errors, DO NOT PROCEED
      // Treat this as "sheet state unknown" and assume it exists to prevent duplicates
      if (headerCheckFailed && dataCheckFailed) {
        logger.error(`🚨 CRITICAL: Cannot verify sheet ${sheetName} state due to quota errors - ABORTING initialization to prevent duplicates`);
        logger.info(`Sheet ${sheetName} treated as existing due to quota errors - will retry on next operation`);

        // Mark as initialized in cache to prevent repeated attempts
        this.cacheManager._initializedSheets.set(sheetName, {
          initialized: true,
          timestamp: Date.now()
        });

        return false; // Return false to indicate initialization was skipped
      }

      // CRITICAL SAFETY CHECK: If sheet has actual cell values but headers not detected,
      // treat as existing to prevent data loss
      if (!hasHeaders && hasActualData) {
        logger.warn(`⚠️  SAFETY CHECK: Sheet ${sheetName} has actual data but headers not detected - treating as existing to PREVENT DATA LOSS`);
        hasHeaders = true; // Force true to prevent re-initialization

        // Try to load rows without headers to preserve them
        try {
          existingRows = await worksheet.getRows();
          logger.info(`Loaded ${existingRows.length} existing rows without header detection`);
        } catch (err) {
          logger.error(`Failed to load existing rows: ${err.message}`);
        }
      }

      // OPTIMIZATION: Get all employees from cached roster
      const rosterRows = await this._getCachedRoster();

      // If headers don't exist, initialize the sheet
      if (!hasHeaders) {
        // Resize sheet to fit all columns (we now have 41 columns with auto-departure tracking)
        await worksheet.resize({ rowCount: 1000, columnCount: 47 });

        // Set headers
        await worksheet.setHeaderRow([
          'Name',
          'TelegramId',
          'Came on time',
          'When come',
          'Leave time',
          'Hours worked',
          'Departure Location',
          'Departure Location Accuracy',
          'Departure Verification Status',
          'Departure Anomalies',
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
          'Point',
          'Office Responsible',
          'Arrival Location',
          'Arrival Location Accuracy',
          'Arrival Anomalies',
          'Arrival Verification Status',
          'departure_reminder_sent',
          'auto_departure_warning_sent',
          'work_extension_minutes',
          'extended_work_reminder_sent'
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
              'Departure Location': '',
              'Departure Location Accuracy': '',
              'Departure Verification Status': '',
              'Departure Anomalies': '',
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
              'Point': '',
              'Location': '',
              'Location Accuracy': '',
              'Anomalies Detected': '',
              'Verification Status': ''
            });
          }
        }

        logger.info(`Initialized daily sheet ${sheetName} with all employees`);

        // If in dev mode, also initialize/update monthly report
        if (Config.AUTO_UPDATE_MONTHLY_REPORT) {
          const yearMonth = moment.tz(sheetName, Config.TIMEZONE).format('YYYY-MM');
          const reportSheetName = `Report_${yearMonth}`;

          // Check if monthly report exists
          if (!this.coreService.doc.sheetsByTitle[reportSheetName]) {
            logger.info(`Creating monthly report ${reportSheetName} (dev mode)`);
            await this.initializeMonthlyReport(yearMonth);
          }
        }
      } else {
        // Sheet already exists with headers
        // FIX: Disable auto-sync to prevent repeatedly adding employees throughout the day
        // The daily sheet is created once at midnight with all employees from the Roster
        // After that, we should NOT auto-add missing employees, as this causes:
        // 1. Cache invalidation triggers re-initialization
        // 2. Re-initialization adds "missing" employees with empty attendance
        // 3. This creates a cycle where employees are constantly re-added

        logger.info(`Daily sheet ${sheetName} already exists with ${existingRows.length} employee(s) - skipping auto-sync with Roster`);

        // NOTE: If you need to manually add new employees to an existing daily sheet,
        // use the admin command: /create_today_sheet
        // This will trigger a fresh initialization with Roster sync
      }

        // FIX #2 & #3: Mark sheet as initialized in cache
        this.cacheManager._initializedSheets.set(sheetName, {
          initialized: true,
          timestamp: Date.now()
        });

        return true;
      } finally {
        // Release the lock
        this.cacheManager._initializationLocks.delete(sheetName);
        releaseLock();
      }
    } catch (error) {
      logger.error(`Error initializing daily sheet: ${error.message}`);
      // Release the lock on error too
      this.cacheManager._initializationLocks.delete(sheetName);
      return false;
    }
  }
  async logEvent(telegramId, name, eventType, details = '', ratingImpact = 0.0) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD'); // e.g., "2025-10-29"

    try {
      // Track this operation
      this.cacheManager._startOperation(sheetName);

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

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      // Use cached row lookup - O(1) instead of O(n) linear search
      const employeeRow = await this.getCachedDailyRow(sheetName, telegramId.toString());

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
          // OPTIMIZATION: Use cached roster instead of direct API call
          const rosterRows = await this._getCachedRoster();

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
            // OPTIMIZATION: Use cached roster instead of direct API call
            const rosterRows = await this._getCachedRoster();

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
          // OPTIMIZATION: Get employee work time from cached roster
          const rosterRows = await this._getCachedRoster();

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
            // OPTIMIZATION: Get work time from cached roster
            const rosterRows = await this._getCachedRoster();

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
            // Worked full hours - treat as normal departure, no penalty, no early departure flag
            leftEarly = 'No';
            remainingHours = '0';

            // Don't record any early departure reason since they worked their full required hours
            // (Do not set 'Why left early' field at all)

            logger.info(`${name} left at ${now.format('HH:mm')} after working full hours (${actualWorkedMinutes} min). Treated as normal departure.`);
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
    } finally {
      // Track operation end (will trigger delayed cache invalidation)
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Cancel fraudulent arrival (remove check-in if location fraud detected)
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {Array} anomalies - List of anomalies detected
   * @returns {boolean} True if successful
   */
  async cancelFraudulentArrival(telegramId, name, anomalies = []) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      await this.initializeDailySheet(sheetName);
      const worksheet = await this.coreService.getWorksheet(sheetName);
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
        logger.warn(`Employee with telegram_id ${telegramId} not found for fraud rollback`);
        return false;
      }

      // Clear arrival data
      employeeRow.set('When come', '');
      employeeRow.set('Came on time', '');
      employeeRow.set('Penalty minutes', '');
      employeeRow.set('Required end time', '');

      // Mark as absent with fraud attempt note
      employeeRow.set('Absent', 'Yes');
      const anomalyList = anomalies.map(a => a.type).join(', ');
      employeeRow.set('Why absent', `FRAUD ATTEMPT: ${anomalyList}`);

      // Set severe penalty for fraud attempt
      employeeRow.set('Point', '-2.0');

      // Clear location tracking data
      employeeRow.set('Verification Status', 'FRAUD_DETECTED');

      await employeeRow.save();

      logger.warn(`🚨 FRAUD: Cancelled arrival for ${name} (${telegramId}) - Anomalies: ${anomalyList}`);

      // Invalidate cache
      this._invalidateCache(sheetName);

      return true;
    } catch (error) {
      logger.error(`Error cancelling fraudulent arrival: ${error.message}`);
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
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

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
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Log return from temporary exit
   * @param {string} telegramId - User's Telegram ID
   * @param {string} name - User's name
   * @param {string} returnTime - Return time (HH:mm:ss)
   */
  async logTempReturn(telegramId, name, returnTime) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

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
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Get user's status for today (arrival, departure, violations)
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} Status information
   */
  async getUserStatusToday(telegramId) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      // Initialize daily sheet if needed
      await this.initializeDailySheet(sheetName);

      // Use cached row lookup - O(1) instead of O(n) linear search
      const employeeRow = await this.getCachedDailyRow(sheetName, telegramId.toString());

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
  async logDayBalance(telegramId, name, deficitMinutes = 0, surplusMinutes = 0, penaltyMinutes = 0) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      await this.initializeDailySheet(sheetName);
      const worksheet = await this.coreService.getWorksheet(sheetName);
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

      // ✅ FIX: Check if balance already logged to prevent duplicates
      const existingBalanceType = employeeRow.get('Day Balance Type') || '';
      if (existingBalanceType && existingBalanceType.trim() !== '') {
        logger.info(`Day balance already logged for ${name} today (${existingBalanceType}), skipping duplicate`);
        return true; // Return success to prevent retries
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
  async updateArrivalLocation(telegramId, location, accuracy = null) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

      // Find employee row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        logger.warn(`Employee with telegram_id ${telegramId} not found for location update`);
        return false;
      }

      // Store location as "lat,lng"
      const locationStr = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
      employeeRow.set('Arrival Location', locationStr);

      if (accuracy !== null) {
        employeeRow.set('Arrival Location Accuracy', `${accuracy.toFixed(1)}m`);
      } else {
        employeeRow.set('Arrival Location Accuracy', 'unknown');
      }

      // Set initial verification status as "TRACKING"
      employeeRow.set('Arrival Verification Status', 'TRACKING');

      await employeeRow.save();

      logger.info(`Location data updated for telegram_id ${telegramId}: ${locationStr}`);

      return true;
    } catch (error) {
      logger.error(`Error updating arrival location: ${error.message}`);
      return false;
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Update location verification status after tracking completes
   * @param {number} telegramId - User's Telegram ID
   * @param {string} status - Verification status (OK, FLAGGED)
   * @param {Array} anomalies - List of anomaly objects
   * @returns {boolean} True if successful
   */
  async updateLocationVerification(telegramId, status, anomalies = []) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

      // Find employee row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        logger.warn(`Employee with telegram_id ${telegramId} not found for verification update`);
        return false;
      }

      // Update verification status
      employeeRow.set('Arrival Verification Status', status);

      // Store anomalies as comma-separated list
      if (anomalies.length > 0) {
        const anomalyTypes = anomalies.map(a => a.type).join(', ');
        employeeRow.set('Arrival Anomalies', anomalyTypes);
      } else {
        employeeRow.set('Arrival Anomalies', '');
      }

      await employeeRow.save();

      logger.info(`Location verification updated for telegram_id ${telegramId}: ${status}`);
      if (anomalies.length > 0) {
        logger.warn(`  Anomalies: ${anomalies.map(a => a.type).join(', ')}`);
      }

      return true;
    } catch (error) {
      logger.error(`Error updating location verification: ${error.message}`);
      return false;
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Update departure location when user checks out
   * @param {number} telegramId - User's Telegram ID
   * @param {Object} location - Location { latitude, longitude }
   * @param {number} accuracy - GPS accuracy in meters
   * @returns {boolean} True if successful
   */
  async updateDepartureLocation(telegramId, location, accuracy = null) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

      // Find employee row
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

      // Format location as "lat,lng"
      const locationStr = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
      const accuracyStr = accuracy !== null ? `${Math.round(accuracy)}m` : 'unknown';

      // Update departure location columns
      employeeRow.set('Departure Location', locationStr);
      employeeRow.set('Departure Location Accuracy', accuracyStr);
      employeeRow.set('Departure Verification Status', 'TRACKING');

      await employeeRow.save();

      logger.info(`Departure location data updated for telegram_id ${telegramId}: ${locationStr}`);

      return true;
    } catch (error) {
      logger.error(`Error updating departure location: ${error.message}`);
      return false;
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Update departure location verification status after tracking completes
   * @param {number} telegramId - User's Telegram ID
   * @param {string} status - Verification status (OK, FLAGGED)
   * @param {Array} anomalies - List of anomaly objects
   * @returns {boolean} True if successful
   */
  async updateDepartureVerification(telegramId, status, anomalies = []) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this.cacheManager._startOperation(sheetName);

      await this.initializeDailySheet(sheetName);

      // Use cached data to reduce API calls
      const { worksheet, rows } = await this._getCachedDailySheet(sheetName);

      // Find employee row
      let employeeRow = null;
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          employeeRow = row;
          break;
        }
      }

      if (!employeeRow) {
        logger.warn(`Employee with telegram_id ${telegramId} not found for departure verification`);
        return false;
      }

      // Update verification status
      employeeRow.set('Departure Verification Status', status);

      // Format anomalies for display
      if (anomalies.length > 0) {
        const anomalyTypes = anomalies.map(a => a.type).join(', ');
        employeeRow.set('Departure Anomalies', anomalyTypes);
      } else {
        employeeRow.set('Departure Anomalies', 'None');
      }

      await employeeRow.save();

      logger.info(`Departure verification updated for telegram_id ${telegramId}: ${status}`);
      if (anomalies.length > 0) {
        logger.warn(`  Departure Anomalies: ${anomalies.map(a => a.type).join(', ')}`);
      }

      return true;
    } catch (error) {
      logger.error(`Error updating departure verification: ${error.message}`);
      return false;
    } finally {
      this.cacheManager._endOperation(sheetName);
    }
  }

  /**
   * Get location verification status for a user today
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} Verification data
   */
  async getLocationVerification(telegramId) {
    try {
      const now = moment.tz(Config.TIMEZONE);
      const sheetName = now.format('YYYY-MM-DD');

      await this.initializeDailySheet(sheetName);
      const worksheet = await this.coreService.getWorksheet(sheetName);
      await worksheet.loadHeaderRow();
      const rows = await worksheet.getRows();

      // Find employee row
      for (const row of rows) {
        if (row.get('TelegramId')?.toString().trim() === telegramId.toString()) {
          const locationStr = row.get('Location') || '';
          const accuracyStr = row.get('Location Accuracy') || '';
          const anomaliesStr = row.get('Anomalies Detected') || '';
          const status = row.get('Verification Status') || '';

          // Parse location
          let location = null;
          if (locationStr.trim()) {
            const [lat, lng] = locationStr.split(',').map(s => parseFloat(s.trim()));
            if (!isNaN(lat) && !isNaN(lng)) {
              location = { latitude: lat, longitude: lng };
            }
          }

          return {
            hasLocation: location !== null,
            location: location,
            accuracy: accuracyStr ? parseFloat(accuracyStr) : null,
            anomalies: anomaliesStr ? anomaliesStr.split(',').map(s => s.trim()) : [],
            status: status
          };
        }
      }

      return {
        hasLocation: false,
        location: null,
        accuracy: null,
        anomalies: [],
        status: ''
      };
    } catch (error) {
      logger.error(`Error getting location verification: ${error.message}`);
      return {
        hasLocation: false,
        location: null,
        accuracy: null,
        anomalies: [],
        status: ''
      };
    }
  }

  /**
   * Batch save multiple rows in a single API call
   * OPTIMIZATION: Reduces API calls by batching row updates
   * @param {Array} rows - Array of row objects to save
   * @returns {Promise<void>}
   */
  async batchSaveRows(rows) {
    if (!rows || rows.length === 0) {
      return;
    }

    try {
      // Save all rows - google-spreadsheet library will batch them internally
      await this.quotaHandler.retryOperation(async () => {
        await Promise.all(rows.map(row => row.save()));
      });

      logger.debug(`Batch saved ${rows.length} rows`);
    } catch (error) {
      logger.error(`Error batch saving rows: ${error.message}`);
      throw error;
    }
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
}

module.exports = DailyOperations;
