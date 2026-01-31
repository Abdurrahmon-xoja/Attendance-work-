/**
 * Google Sheets integration service.
 * Handles all interactions with Google Sheets for data storage and retrieval.
 *
 * This is the main entry point that maintains 100% backward compatibility
 * with the original monolithic sheets.service.js file.
 */

const CoreSheetsService = require('./core.service');
const CacheManager = require('./cache.manager');
const QuotaHandler = require('./quota.handler');
const RosterOperations = require('./roster.operations');
const DailyOperations = require('./daily.operations');
const MonthlyOperations = require('./monthly.operations');

class SheetsService {
  constructor() {
    // Initialize core service
    this.coreService = new CoreSheetsService();

    // Initialize cache manager
    this.cacheManager = new CacheManager();

    // Initialize quota handler (static class, just reference)
    this.quotaHandler = QuotaHandler;

    // Initialize operation modules with dependencies
    this.rosterOperations = new RosterOperations(
      this.coreService,
      this.cacheManager,
      this.quotaHandler
    );

    this.dailyOperations = new DailyOperations(
      this.coreService,
      this.cacheManager,
      this.quotaHandler
    );

    this.monthlyOperations = new MonthlyOperations(
      this.coreService,
      this.cacheManager,
      this.quotaHandler,
      this.rosterOperations
    );

    // Expose core properties for backward compatibility
    this.doc = null;
    this.isConnected = false;

    // Expose cache properties for backward compatibility (if needed)
    this._dailySheetCache = this.cacheManager._dailySheetCache;
    this._rosterCache = this.cacheManager._rosterCache;
    this._cacheTimeout = this.cacheManager._cacheTimeout;
    this._pendingInvalidations = this.cacheManager._pendingInvalidations;
    this._activeOperations = this.cacheManager._activeOperations;
    this._initializationLocks = this.cacheManager._initializationLocks;
    this._initializedSheets = this.cacheManager._initializedSheets;
    this._initCacheTimeout = this.cacheManager._initCacheTimeout;
    this._rosterByTelegramIdCache = this.cacheManager._rosterByTelegramIdCache;
    this._dailyRowCache = this.cacheManager._dailyRowCache;

    // Expose _recentEvents from daily operations for backward compatibility
    this._recentEvents = this.dailyOperations._recentEvents;
  }

  // ============================================================================
  // CORE SERVICE METHODS (delegated to CoreSheetsService)
  // ============================================================================

  /**
   * Establish connection to Google Sheets
   */
  async connect() {
    const result = await this.coreService.connect();
    // Sync properties for backward compatibility
    this.doc = this.coreService.doc;
    this.isConnected = this.coreService.isConnected;
    return result;
  }

  /**
   * Get a worksheet by name, create if doesn't exist
   * @param {string} sheetName - Name of the worksheet
   * @returns {Object} Worksheet object
   */
  async getWorksheet(sheetName) {
    return await this.coreService.getWorksheet(sheetName);
  }

  // ============================================================================
  // CACHE MANAGER METHODS (delegated to CacheManager)
  // ============================================================================

  /**
   * Track start of an operation on a sheet
   * @param {string} sheetName - Sheet name
   */
  _startOperation(sheetName) {
    return this.cacheManager._startOperation(sheetName);
  }

  /**
   * Track end of an operation on a sheet
   * @param {string} sheetName - Sheet name
   */
  _endOperation(sheetName) {
    return this.cacheManager._endOperation(sheetName);
  }

  /**
   * Invalidate cache for a specific sheet or all sheets
   * @param {string} sheetName - Optional sheet name to invalidate
   */
  _invalidateCache(sheetName = null) {
    return this.cacheManager._invalidateCache(sheetName);
  }

  /**
   * Check if cached data is still valid
   * @param {number} lastUpdated - Timestamp when data was cached
   * @returns {boolean} True if cache is still valid
   */
  _isCacheValid(lastUpdated) {
    return this.cacheManager._isCacheValid(lastUpdated);
  }

  /**
   * Get cached daily sheet rows or fetch from API if not cached
   * @param {string} sheetName - Sheet name
   * @param {Object} options - Options for getRows (limit, offset)
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
   * Get cached roster data or fetch from API if not cached
   * @param {boolean} buildIndex - Whether to build telegram ID index for faster lookups
   * @returns {Array} Roster rows
   */
  async _getCachedRoster(buildIndex = false) {
    return await this.cacheManager._getCachedRoster(
      buildIndex,
      async (sheetName) => this.coreService.getWorksheet(sheetName),
      async (operation) => this.quotaHandler.retryOperation(operation)
    );
  }

  /**
   * Get employee from roster by telegram ID using cache
   * @param {string} telegramId - Telegram ID to find
   * @returns {Object|null} Employee data or null
   */
  async _getCachedEmployeeByTelegramId(telegramId) {
    return await this.cacheManager._getCachedEmployeeByTelegramId(
      telegramId,
      async (buildIndex) => this._getCachedRoster(buildIndex)
    );
  }

  /**
   * Get daily row by telegram ID using cache
   * @param {string} sheetName - Sheet name
   * @param {string} telegramId - Telegram ID to find
   * @returns {Object|null} Row object or null
   */
  async getCachedDailyRow(sheetName, telegramId) {
    return await this.cacheManager.getCachedDailyRow(
      sheetName,
      telegramId,
      async (name, opts) => this._getCachedDailySheet(name, opts)
    );
  }

  /**
   * Pre-warm cache on startup to reduce API quota usage
   */
  async warmupCache() {
    return await this.cacheManager.warmupCache(
      async (dateStr) => this.initializeDailySheet(dateStr),
      async (buildIndex) => this._getCachedRoster(buildIndex),
      async (sheetName, options) => this._getCachedDailySheet(sheetName, options)
    );
  }

  // ============================================================================
  // QUOTA HANDLER METHODS (delegated to QuotaHandler)
  // ============================================================================

  /**
   * Retry operation with exponential backoff for quota errors
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} initialDelay - Initial delay in ms
   * @returns {Promise} Result of operation
   */
  async _retryOperation(operation, maxRetries = 3, initialDelay = 1000) {
    return await this.quotaHandler.retryOperation(operation, maxRetries, initialDelay);
  }

  // ============================================================================
  // ROSTER OPERATIONS METHODS (delegated to RosterOperations)
  // ============================================================================

  /**
   * Find employee by Telegram ID in Roster sheet
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByTelegramId(telegramId) {
    return await this.rosterOperations.findEmployeeByTelegramId(telegramId);
  }

  /**
   * Find employee by Telegram username in Roster sheet
   * @param {string} username - User's Telegram username (with or without @)
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByUsername(username) {
    return await this.rosterOperations.findEmployeeByUsername(username);
  }

  /**
   * Find employee by Telegram display name (first name) in Roster sheet
   * @param {string} firstName - User's Telegram first name
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByTelegramName(firstName) {
    return await this.rosterOperations.findEmployeeByTelegramName(firstName);
  }

  /**
   * Get list of employees without Telegram ID (unregistered)
   * @returns {Array} List of employee objects
   */
  async getUnregisteredEmployees() {
    return await this.rosterOperations.getUnregisteredEmployees();
  }

  /**
   * Register employee by updating their Telegram ID in the sheet
   * @param {number} rowNumber - Row number in the sheet
   * @param {number} telegramId - User's Telegram ID
   * @returns {boolean} True if successful, false otherwise
   */
  async registerEmployee(rowNumber, telegramId) {
    return await this.rosterOperations.registerEmployee(rowNumber, telegramId);
  }

  // ============================================================================
  // DAILY OPERATIONS METHODS (delegated to DailyOperations)
  // ============================================================================

  /**
   * Initialize daily attendance sheet with all employees
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful, false otherwise
   */
  async initializeDailySheet(dateStr) {
    return await this.dailyOperations.initializeDailySheet(dateStr);
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
    return await this.dailyOperations.logEvent(telegramId, name, eventType, details, ratingImpact);
  }

  /**
   * Cancel fraudulent arrival and log it
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {Array} anomalies - List of anomalies detected
   * @returns {boolean} True if successful
   */
  async cancelFraudulentArrival(telegramId, name, anomalies = []) {
    return await this.dailyOperations.cancelFraudulentArrival(telegramId, name, anomalies);
  }

  /**
   * Log temporary exit
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {string} reason - Reason for temporary exit
   * @param {number} durationMinutes - Duration in minutes
   * @param {string} exitTime - Exit time
   * @param {string} expectedReturn - Expected return time
   * @returns {boolean} True if successful
   */
  async logTempExit(telegramId, name, reason, durationMinutes, exitTime, expectedReturn) {
    return await this.dailyOperations.logTempExit(telegramId, name, reason, durationMinutes, exitTime, expectedReturn);
  }

  /**
   * Log temporary return
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {string} returnTime - Return time
   * @returns {boolean} True if successful
   */
  async logTempReturn(telegramId, name, returnTime) {
    return await this.dailyOperations.logTempReturn(telegramId, name, returnTime);
  }

  /**
   * Get user's status for today
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} User's status
   */
  async getUserStatusToday(telegramId) {
    return await this.dailyOperations.getUserStatusToday(telegramId);
  }

  /**
   * Log end-of-day balance calculation
   * @param {number} telegramId - User's Telegram ID
   * @param {string} name - User's full name
   * @param {number} deficitMinutes - Minutes left early
   * @param {number} surplusMinutes - Overtime minutes worked
   * @param {number} penaltyMinutes - Penalty minutes
   * @returns {boolean} True if successful
   */
  async logDayBalance(telegramId, name, deficitMinutes = 0, surplusMinutes = 0, penaltyMinutes = 0) {
    return await this.dailyOperations.logDayBalance(telegramId, name, deficitMinutes, surplusMinutes, penaltyMinutes);
  }

  /**
   * Update arrival location for employee
   * @param {number} telegramId - User's Telegram ID
   * @param {Object} location - Location object
   * @param {number} accuracy - GPS accuracy
   * @returns {boolean} True if successful
   */
  async updateArrivalLocation(telegramId, location, accuracy = null) {
    return await this.dailyOperations.updateArrivalLocation(telegramId, location, accuracy);
  }

  /**
   * Update location verification status
   * @param {number} telegramId - User's Telegram ID
   * @param {string} status - Verification status
   * @param {Array} anomalies - List of anomalies
   * @returns {boolean} True if successful
   */
  async updateLocationVerification(telegramId, status, anomalies = []) {
    return await this.dailyOperations.updateLocationVerification(telegramId, status, anomalies);
  }

  /**
   * Update departure location for employee
   * @param {number} telegramId - User's Telegram ID
   * @param {Object} location - Location object
   * @param {number} accuracy - GPS accuracy
   * @returns {boolean} True if successful
   */
  async updateDepartureLocation(telegramId, location, accuracy = null) {
    return await this.dailyOperations.updateDepartureLocation(telegramId, location, accuracy);
  }

  /**
   * Update departure verification status
   * @param {number} telegramId - User's Telegram ID
   * @param {string} status - Verification status
   * @param {Array} anomalies - List of anomalies
   * @returns {boolean} True if successful
   */
  async updateDepartureVerification(telegramId, status, anomalies = []) {
    return await this.dailyOperations.updateDepartureVerification(telegramId, status, anomalies);
  }

  /**
   * Get location verification data for employee
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object|null} Verification data or null
   */
  async getLocationVerification(telegramId) {
    return await this.dailyOperations.getLocationVerification(telegramId);
  }

  /**
   * Batch save multiple rows
   * @param {Array} rows - Array of row objects to save
   * @returns {boolean} True if successful
   */
  async batchSaveRows(rows) {
    return await this.dailyOperations.batchSaveRows(rows);
  }

  // ============================================================================
  // MONTHLY OPERATIONS METHODS (delegated to MonthlyOperations)
  // ============================================================================

  /**
   * Calculate user's rating for current month
   * @param {number} telegramId - User's Telegram ID
   * @returns {number} Current rating (0-10 scale)
   */
  async getMonthlyRating(telegramId) {
    return await this.monthlyOperations.getMonthlyRating(telegramId);
  }

  /**
   * Get monthly balance (deficit/surplus)
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object} Monthly balance data
   */
  async getMonthlyBalance(telegramId) {
    return await this.monthlyOperations.getMonthlyBalance(telegramId);
  }

  /**
   * Get comprehensive monthly statistics
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object|null} Monthly statistics or null
   */
  async getMonthlyStats(telegramId) {
    return await this.monthlyOperations.getMonthlyStats(telegramId);
  }

  /**
   * Initialize monthly report sheet
   * @param {string} yearMonth - Year and month in YYYY-MM format
   * @returns {boolean} True if successful
   */
  async initializeMonthlyReport(yearMonth) {
    return await this.monthlyOperations.initializeMonthlyReport(yearMonth);
  }

  /**
   * Update monthly report with data from a specific day
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {boolean} True if successful
   */
  async updateMonthlyReport(dateStr) {
    return await this.monthlyOperations.updateMonthlyReport(dateStr);
  }
}

// Create and export singleton instance (same pattern as original)
const sheetsService = new SheetsService();
module.exports = sheetsService;
