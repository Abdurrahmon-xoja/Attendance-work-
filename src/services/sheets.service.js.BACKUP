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
    // Cache for daily sheets to reduce API calls
    this._dailySheetCache = new Map(); // key: sheetName, value: { worksheet, rows, lastUpdated }
    this._rosterCache = null; // Cache roster data
    this._cacheTimeout = 1800000; // 1800 seconds (30 minutes) cache validity - increased to reduce API quota usage
    this._pendingInvalidations = new Map(); // Delayed cache invalidation
    this._activeOperations = new Map(); // Track active operations to prevent cache invalidation
    this._initializationLocks = new Map(); // Prevent concurrent sheet initialization
    // FIX #2 & #3: Cache initialization state to prevent redundant checks
    this._initializedSheets = new Map(); // key: sheetName, value: { initialized: true, timestamp }
    this._initCacheTimeout = 1800000; // 1800 seconds (30 minutes) for initialization cache - increased to reduce quota usage
    // OPTIMIZATION: Field-specific caches for frequently accessed data
    this._rosterByTelegramIdCache = new Map(); // key: telegramId, value: { employee data, lastUpdated }
    this._dailyRowCache = new Map(); // key: `${sheetName}:${telegramId}`, value: { row, lastUpdated }
  }

  /**
   * Track start of an operation on a sheet
   * @param {string} sheetName - Sheet name
   */
  _startOperation(sheetName) {
    const current = this._activeOperations.get(sheetName) || 0;
    this._activeOperations.set(sheetName, current + 1);
    logger.debug(`Started operation on ${sheetName} (${current + 1} active)`);
  }

  /**
   * Track end of an operation on a sheet
   * @param {string} sheetName - Sheet name
   */
  _endOperation(sheetName) {
    const current = this._activeOperations.get(sheetName) || 0;
    const newCount = Math.max(0, current - 1);
    this._activeOperations.set(sheetName, newCount);
    logger.debug(`Ended operation on ${sheetName} (${newCount} active)`);

    // Trigger delayed cache invalidation if no operations left
    if (newCount === 0) {
      this._invalidateCache(sheetName);
    }
  }

  /**
   * Retry operation with exponential backoff for quota errors
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} initialDelay - Initial delay in ms
   * @returns {Promise} Result of operation
   */
  async _retryOperation(operation, maxRetries = 3, initialDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if it's a quota error (429)
        const isQuotaError = error.message && (
          error.message.includes('429') ||
          error.message.includes('Quota exceeded') ||
          error.message.includes('quota metric')
        );

        // Only retry on quota errors
        if (!isQuotaError || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = initialDelay * Math.pow(2, attempt);
        logger.warn(`Quota error detected, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
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
   * Pre-warm cache on startup to reduce API quota usage
   * OPTIMIZATION: Now also builds telegram ID indexes
   * Initializes today's sheet and loads it into cache
   */
  async warmupCache() {
    try {
      const moment = require('moment-timezone');
      const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');

      logger.info(`Warming up cache for today's sheet: ${today}`);

      // Initialize today's sheet and load it into cache
      await this.initializeDailySheet(today);

      // OPTIMIZATION: Pre-load roster into cache and build telegram ID index
      await this._getCachedRoster(true);
      logger.info(`✅ Roster cache built with ${this._rosterByTelegramIdCache.size} indexed employees`);

      // OPTIMIZATION: Pre-build daily sheet telegram ID index
      const { rows } = await this._getCachedDailySheet(today);
      let dailyIndexCount = 0;
      for (const row of rows) {
        const tid = row.get('TelegramId');
        if (tid && tid.toString().trim()) {
          const key = `${today}:${tid.toString().trim()}`;
          this._dailyRowCache.set(key, {
            row,
            lastUpdated: Date.now()
          });
          dailyIndexCount++;
        }
      }
      logger.info(`✅ Daily sheet cache built with ${dailyIndexCount} indexed rows`);

      logger.info(`✅ Cache warmed up successfully for ${today}`);
      return true;
    } catch (error) {
      logger.warn(`Failed to warm up cache (non-critical): ${error.message}`);
      // Don't throw - this is a performance optimization, not critical
      return false;
    }
  }

  /**
   * Invalidate cache for a specific sheet or all sheets (with delay to batch multiple writes)
   * OPTIMIZATION: Also clears indexed caches
   * @param {string} sheetName - Optional sheet name to invalidate (or all if not provided)
   */
  _invalidateCache(sheetName = null) {
    if (sheetName) {
      // Don't invalidate if there are active operations on this sheet
      const activeOps = this._activeOperations.get(sheetName) || 0;
      if (activeOps > 0) {
        logger.debug(`Skipping cache invalidation for ${sheetName} - ${activeOps} active operations`);
        return;
      }

      // Cancel any pending invalidation
      if (this._pendingInvalidations.has(sheetName)) {
        clearTimeout(this._pendingInvalidations.get(sheetName));
      }

      // Schedule delayed invalidation (10 seconds - increased for concurrent operations)
      // This allows multiple writes during check-in to complete without repeated cache hits
      const timeoutId = setTimeout(() => {
        // Double-check no active operations before invalidating
        const stillActiveOps = this._activeOperations.get(sheetName) || 0;
        if (stillActiveOps === 0) {
          // Clear sheet cache (including all limit variations)
          for (const key of this._dailySheetCache.keys()) {
            if (key.startsWith(sheetName)) {
              this._dailySheetCache.delete(key);
            }
          }

          // OPTIMIZATION: Clear daily row cache for this sheet
          for (const key of this._dailyRowCache.keys()) {
            if (key.startsWith(`${sheetName}:`)) {
              this._dailyRowCache.delete(key);
            }
          }

          // FIX #2 & #3: Also clear initialization cache for this sheet
          this._initializedSheets.delete(sheetName);
          this._pendingInvalidations.delete(sheetName);
          logger.debug(`Cache invalidated for sheet: ${sheetName} (delayed)`);
        } else {
          logger.debug(`Cache invalidation cancelled for ${sheetName} - operations still active`);
        }
      }, 10000);

      this._pendingInvalidations.set(sheetName, timeoutId);
    } else {
      // Immediate full invalidation
      this._dailySheetCache.clear();
      this._rosterCache = null;
      this._rosterByTelegramIdCache.clear(); // OPTIMIZATION: Clear roster index
      this._dailyRowCache.clear(); // OPTIMIZATION: Clear daily row cache
      // FIX #2 & #3: Also clear initialization cache
      this._initializedSheets.clear();
      logger.debug('All cache invalidated');
    }
  }

  /**
   * Check if cached data is still valid
   * @param {number} lastUpdated - Timestamp when data was cached
   * @returns {boolean} True if cache is still valid
   */
  _isCacheValid(lastUpdated) {
    return (Date.now() - lastUpdated) < this._cacheTimeout;
  }

  /**
   * Get cached daily sheet rows or fetch from API if not cached
   * OPTIMIZATION: Added field filtering to reduce data transfer
   * @param {string} sheetName - Sheet name
   * @param {Object} options - Options for getRows (limit, offset)
   * @returns {Object} { worksheet, rows }
   */
  async _getCachedDailySheet(sheetName, options = {}) {
    const cacheKey = sheetName + (options.limit ? `:limit${options.limit}` : '');
    const cached = this._dailySheetCache.get(cacheKey);

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached data for sheet: ${sheetName}`);
      return { worksheet: cached.worksheet, rows: cached.rows };
    }

    // Cache miss or expired - fetch from API with retry logic
    logger.debug(`Fetching fresh data for sheet: ${sheetName}${options.limit ? ` (limit: ${options.limit})` : ''}`);

    const worksheet = await this._retryOperation(async () => {
      const ws = await this.getWorksheet(sheetName);
      await ws.loadHeaderRow();
      return ws;
    });

    const rows = await this._retryOperation(async () => {
      // OPTIMIZATION: Use options to limit rows fetched
      return await worksheet.getRows(options);
    });

    // Update cache
    this._dailySheetCache.set(cacheKey, {
      worksheet,
      rows,
      lastUpdated: Date.now()
    });

    return { worksheet, rows };
  }

  /**
   * Get cached roster data or fetch from API if not cached
   * OPTIMIZATION: Added option to build telegram ID index
   * @param {boolean} buildIndex - Whether to build telegram ID index for faster lookups
   * @returns {Array} Roster rows
   */
  async _getCachedRoster(buildIndex = false) {
    if (this._rosterCache && this._isCacheValid(this._rosterCache.lastUpdated)) {
      logger.debug('Using cached roster data');
      return this._rosterCache.rows;
    }

    // Cache miss or expired - fetch from API
    logger.debug('Fetching fresh roster data');
    const roster = await this.getWorksheet(Config.SHEET_ROSTER);
    await roster.loadHeaderRow();
    const rows = await this._retryOperation(async () => {
      return await roster.getRows();
    });

    // Update cache
    this._rosterCache = {
      rows,
      lastUpdated: Date.now()
    };

    // OPTIMIZATION: Build telegram ID index if requested
    if (buildIndex) {
      for (const row of rows) {
        const telegramId = row.get('Telegram Id');
        if (telegramId && telegramId.toString().trim()) {
          this._rosterByTelegramIdCache.set(telegramId.toString().trim(), {
            data: {
              name: row.get('Name'),
              telegramId: telegramId,
              workTime: row.get('Work time'),
              role: row.get('Role'),
              doNotWorkSaturday: row.get('Do not work Saturday')?.toLowerCase() === 'yes'
            },
            lastUpdated: Date.now()
          });
        }
      }
      logger.debug(`Built roster index with ${this._rosterByTelegramIdCache.size} entries`);
    }

    return rows;
  }

  /**
   * OPTIMIZATION: Get employee from roster by telegram ID using cache
   * This avoids loading all roster rows for single employee lookups
   * @param {string} telegramId - Telegram ID to find
   * @returns {Object|null} Employee data or null
   */
  async _getCachedEmployeeByTelegramId(telegramId) {
    const cached = this._rosterByTelegramIdCache.get(telegramId.toString().trim());

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached employee data for telegram ID: ${telegramId}`);
      return cached.data;
    }

    // Cache miss - load roster and build index
    const rows = await this._getCachedRoster(true);

    // Try again after building index
    const nowCached = this._rosterByTelegramIdCache.get(telegramId.toString().trim());
    return nowCached ? nowCached.data : null;
  }

  /**
   * OPTIMIZATION: Get daily row by telegram ID using cache
   * @param {string} sheetName - Sheet name
   * @param {string} telegramId - Telegram ID to find
   * @returns {Object|null} Row object or null
   */
  async getCachedDailyRow(sheetName, telegramId) {
    const cacheKey = `${sheetName}:${telegramId}`;
    const cached = this._dailyRowCache.get(cacheKey);

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached daily row for ${sheetName}:${telegramId}`);
      return cached.row;
    }

    // Cache miss - load all rows and build cache
    const { rows } = await this._getCachedDailySheet(sheetName);

    // Build cache for all telegram IDs in this sheet
    for (const row of rows) {
      const tid = row.get('TelegramId');
      if (tid && tid.toString().trim()) {
        const key = `${sheetName}:${tid.toString().trim()}`;
        this._dailyRowCache.set(key, {
          row,
          lastUpdated: Date.now()
        });
      }
    }

    // Return the requested row
    const nowCached = this._dailyRowCache.get(cacheKey);
    return nowCached ? nowCached.row : null;
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
      // OPTIMIZATION: Try indexed cache first (much faster than looping)
      const cachedEmployee = await this._getCachedEmployeeByTelegramId(telegramId);
      if (cachedEmployee) {
        // Found in cache - still need to get full row for _row property
        const rows = await this._getCachedRoster();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
            const doNotWorkSaturday = (row.get('Do not work in Saturday') || '').toString().toLowerCase().trim();
            return {
              rowNumber: i + 2, // +2 because header is row 1, and index starts at 0
              nameFull: row.get('Name full') || '',
              workTime: row.get('Work time') || '',
              telegramName: row.get('Telegram name') || '',
              company: row.get('Company') || '',
              telegramUsername: row.get('Telegram user name') || '',
              telegramId: row.get('Telegram Id') || '',
              doNotWorkSaturday: doNotWorkSaturday === 'yes',
              _row: row
            };
          }
        }
      }

      // Fallback: Load full roster and search (cache will be built)
      const rows = await this._getCachedRoster(true);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.get('Telegram Id')?.toString().trim() === telegramId.toString()) {
          const doNotWorkSaturday = (row.get('Do not work in Saturday') || '').toString().toLowerCase().trim();
          return {
            rowNumber: i + 2, // +2 because header is row 1, and index starts at 0
            nameFull: row.get('Name full') || '',
            workTime: row.get('Work time') || '',
            telegramName: row.get('Telegram name') || '',
            company: row.get('Company') || '',
            telegramUsername: row.get('Telegram user name') || '',
            telegramId: row.get('Telegram Id') || '',
            doNotWorkSaturday: doNotWorkSaturday === 'yes',
            _row: row
          };
        }
      }
      return null;
    } catch (error) {
      // Check if it's a quota error - throw it so caller can handle appropriately
      const isQuotaError = error.message && (
        error.message.includes('429') ||
        error.message.includes('Quota exceeded') ||
        error.message.includes('quota metric')
      );

      if (isQuotaError) {
        logger.warn(`Quota error while finding employee by telegram_id: ${error.message}`);
        // Create a special error to indicate quota issue
        const quotaError = new Error('QUOTA_EXCEEDED');
        quotaError.isQuotaError = true;
        quotaError.originalError = error;
        throw quotaError;
      }

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

      // OPTIMIZATION: Use cached roster
      const rows = await this._getCachedRoster();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sheetUsername = (row.get('Telegram user name') || '').trim();
        if (sheetUsername.toLowerCase() === username.toLowerCase()) {
          const doNotWorkSaturday = (row.get('Do not work in Saturday') || '').toString().toLowerCase().trim();
          return {
            rowNumber: i + 2,
            nameFull: row.get('Name full') || '',
            workTime: row.get('Work time') || '',
            telegramName: row.get('Telegram name') || '',
            company: row.get('Company') || '',
            telegramUsername: row.get('Telegram user name') || '',
            telegramId: row.get('Telegram Id') || '',
            doNotWorkSaturday: doNotWorkSaturday === 'yes',
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

      // OPTIMIZATION: Use cached roster
      const rows = await this._getCachedRoster();

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
      // OPTIMIZATION: Use cached roster
      const rows = await this._getCachedRoster();

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

      // FIX #2 & #3: Check if sheet is already known to be initialized (extended cache to reduce API calls)
      const initCache = this._initializedSheets.get(sheetName);
      if (initCache && (Date.now() - initCache.timestamp) < this._initCacheTimeout) {
        logger.debug(`Sheet ${sheetName} already initialized (cached), skipping check`);
        return true;
      }

      // Check if there's already an initialization in progress for this sheet
      if (this._initializationLocks.has(sheetName)) {
        logger.debug(`Sheet ${sheetName} initialization already in progress, waiting...`);
        // Wait for existing initialization to complete
        await this._initializationLocks.get(sheetName);
        return true;
      }

      // Create a lock promise for this initialization
      let releaseLock;
      const lockPromise = new Promise(resolve => { releaseLock = resolve; });
      this._initializationLocks.set(sheetName, lockPromise);

      try {
        // Check if sheet already exists and has data
        // Use cache to avoid redundant API calls
        const existingSheet = this.doc.sheetsByTitle[sheetName];
        let worksheet = existingSheet || await this._retryOperation(() => this.getWorksheet(sheetName));

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
        this._initializedSheets.set(sheetName, {
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
          if (!this.doc.sheetsByTitle[reportSheetName]) {
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
        this._initializedSheets.set(sheetName, {
          initialized: true,
          timestamp: Date.now()
        });

        return true;
      } finally {
        // Release the lock
        this._initializationLocks.delete(sheetName);
        releaseLock();
      }
    } catch (error) {
      logger.error(`Error initializing daily sheet: ${error.message}`);
      // Release the lock on error too
      this._initializationLocks.delete(sheetName);
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
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD'); // e.g., "2025-10-29"

    try {
      // Track this operation
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      const worksheet = this.doc.sheetsByTitle[sheetName];
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
            daysAbsent: parseInt(row.get('Days Absent') || '0'),
            daysAbsentNotified: parseInt(row.get('Days Absent (Notified)') || '0'),
            daysAbsentSilent: parseInt(row.get('Days Absent (Silent)') || '0'),
            onTimeArrivals: parseInt(row.get('On Time Arrivals') || '0'),
            lateArrivalsNotified: parseInt(row.get('Late Arrivals (Notified)') || '0'),
            lateArrivalsSilent: parseInt(row.get('Late Arrivals (Silent)') || '0'),
            earlyDepartures: parseInt(row.get('Early Departures') || '0'),
            totalHoursRequired: parseFloat(row.get('Total Hours Required') || '0'),
            totalHoursWorked: parseFloat(row.get('Total Hours Worked') || '0'),
            hoursDeficitSurplus: parseFloat(row.get('Hours Deficit/Surplus') || '0'),
            totalPenaltyMinutes: parseInt(row.get('Total Penalty Minutes') || '0'),
            totalDeficitMinutes: parseInt(row.get('Total Deficit Minutes') || '0'),
            totalSurplusMinutes: parseInt(row.get('Total Surplus Minutes') || '0'),
            netBalanceMinutes: parseInt(row.get('Net Balance Minutes') || '0'),
            netBalanceHours: row.get('Net Balance (Hours)') || '+0:00',
            balanceStatus: row.get('Balance Status') || '⚪ Balanced',
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
   * FIX: Now rebuilds from scratch to ensure idempotency (no double-counting)
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
          const daySheet = this.doc.sheetsByTitle[checkDateStr];
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
              leaveTime: dayRow.get('Leave time') || '',
              hoursWorked: parseFloat(dayRow.get('Hours worked') || '0'),
              leftEarly: dayRow.get('Left early') || '',
              willBeLate: dayRow.get('will be late') || '',
              absent: dayRow.get('Absent') || '',
              whyAbsent: dayRow.get('Why absent') || '',
              penaltyMinutes: parseInt(dayRow.get('Penalty minutes') || '0'),
              point: parseFloat(dayRow.get('Point') || '0'),
              balanceType: dayRow.get('Day Balance Type') || '',
              balanceMinutes: parseInt(dayRow.get('Balance Minutes') || '0')
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
        let totalPenaltyMinutes = 0;
        let totalPoints = 0;
        let totalDeficitMinutes = 0;
        let totalSurplusMinutes = 0;

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
            totalHoursWorked += dayData.hoursWorked;
            totalPenaltyMinutes += dayData.penaltyMinutes;
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
            // FIX: No activity at all (not marked absent, no arrival)
            // This shouldn't happen if no-show checker runs, but handle it as silent absence
            daysAbsent++;
            daysAbsentSilent++;
            logger.warn(`Employee has no activity on work day ${dayData.date} but not marked as absent - counting as silent absence`);
          }

          // Accumulate balance minutes
          if (dayData.balanceType === 'DEFICIT' && dayData.balanceMinutes < 0) {
            totalDeficitMinutes += Math.abs(dayData.balanceMinutes);
          } else if (dayData.balanceType === 'SURPLUS' && dayData.balanceMinutes > 0) {
            totalSurplusMinutes += dayData.balanceMinutes;
          }
        }

        // Read Total Hours Required from the report (already calculated when sheet was created)
        const totalHoursRequired = parseFloat(reportRow.get('Total Hours Required') || '0');
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

        // FIX: Balance minutes already calculated above in the daily data loop
        // Calculate net balance
        const netBalanceMinutes = totalSurplusMinutes - totalDeficitMinutes;

        // FIX #3: Convert to numeric hours for Excel (not a formatted string)
        // Excel will display this with custom formatting [h]:mm
        const netBalanceHours = netBalanceMinutes / 60; // Convert to decimal hours

        // Determine balance status
        let balanceStatus = '⚪ Balanced';
        if (netBalanceMinutes > 60) {
          balanceStatus = '🟢 Surplus';
        } else if (netBalanceMinutes < -60) {
          balanceStatus = '🔴 Deficit';
        } else if (netBalanceMinutes > 0) {
          balanceStatus = '🟡 Slight Surplus';
        } else if (netBalanceMinutes < 0) {
          balanceStatus = '🟡 Slight Deficit';
        }

        // Update report row (don't update Total Work Days and Total Hours Required - they're set at creation)
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
        reportRow.set('Total Hours Worked', totalHoursWorked.toFixed(2));
        reportRow.set('Hours Deficit/Surplus', hoursDeficit.toFixed(2));
        reportRow.set('Total Penalty Minutes', totalPenaltyMinutes);
        reportRow.set('Total Deficit Minutes', totalDeficitMinutes);
        reportRow.set('Total Surplus Minutes', totalSurplusMinutes);
        reportRow.set('Net Balance Minutes', netBalanceMinutes);
        reportRow.set('Net Balance (Hours)', netBalanceHours); // FIX: Use numeric value, not formatted string
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

  /**
   * Update location data for employee's arrival
   * @param {number} telegramId - User's Telegram ID
   * @param {Object} location - Location { latitude, longitude }
   * @param {number} accuracy - GPS accuracy in meters
   * @returns {boolean} True if successful
   */
  async updateArrivalLocation(telegramId, location, accuracy = null) {
    const now = moment.tz(Config.TIMEZONE);
    const sheetName = now.format('YYYY-MM-DD');

    try {
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      this._startOperation(sheetName);

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
      this._endOperation(sheetName);
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
      const worksheet = await this.getWorksheet(sheetName);
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
      await this._retryOperation(async () => {
        await Promise.all(rows.map(row => row.save()));
      });

      logger.debug(`Batch saved ${rows.length} rows`);
    } catch (error) {
      logger.error(`Error batch saving rows: ${error.message}`);
      throw error;
    }
  }
}

// Create and export singleton instance
const sheetsService = new SheetsService();
module.exports = sheetsService;
