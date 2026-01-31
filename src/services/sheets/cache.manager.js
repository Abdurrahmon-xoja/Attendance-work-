/**
 * Cache Manager for Google Sheets Service
 * Handles all caching logic to reduce API quota usage
 */

const logger = require('../../utils/logger');
const Config = require('../../config');

class CacheManager {
  constructor() {
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
   * @param {Function} getWorksheetFn - Function to get worksheet
   * @param {Function} retryOperationFn - Function to retry operations
   * @returns {Object} { worksheet, rows }
   */
  async _getCachedDailySheet(sheetName, options, getWorksheetFn, retryOperationFn) {
    const cacheKey = sheetName + (options.limit ? `:limit${options.limit}` : '');
    const cached = this._dailySheetCache.get(cacheKey);

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached data for sheet: ${sheetName}`);
      return { worksheet: cached.worksheet, rows: cached.rows };
    }

    // Cache miss or expired - fetch from API with retry logic
    logger.debug(`Fetching fresh data for sheet: ${sheetName}${options.limit ? ` (limit: ${options.limit})` : ''}`);

    const worksheet = await retryOperationFn(async () => {
      const ws = await getWorksheetFn(sheetName);
      await ws.loadHeaderRow();
      return ws;
    });

    const rows = await retryOperationFn(async () => {
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
   * @param {Function} getWorksheetFn - Function to get worksheet
   * @param {Function} retryOperationFn - Function to retry operations
   * @returns {Array} Roster rows
   */
  async _getCachedRoster(buildIndex, getWorksheetFn, retryOperationFn) {
    if (this._rosterCache && this._isCacheValid(this._rosterCache.lastUpdated)) {
      logger.debug('Using cached roster data');
      return this._rosterCache.rows;
    }

    // Cache miss or expired - fetch from API
    logger.debug('Fetching fresh roster data');
    const roster = await getWorksheetFn(Config.SHEET_ROSTER);
    await roster.loadHeaderRow();
    const rows = await retryOperationFn(async () => {
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
   * @param {Function} getCachedRosterFn - Function to get cached roster
   * @returns {Object|null} Employee data or null
   */
  async _getCachedEmployeeByTelegramId(telegramId, getCachedRosterFn) {
    const cached = this._rosterByTelegramIdCache.get(telegramId.toString().trim());

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached employee data for telegram ID: ${telegramId}`);
      return cached.data;
    }

    // Cache miss - load roster and build index
    await getCachedRosterFn(true);

    // Try again after building index
    const nowCached = this._rosterByTelegramIdCache.get(telegramId.toString().trim());
    return nowCached ? nowCached.data : null;
  }

  /**
   * OPTIMIZATION: Get daily row by telegram ID using cache
   * @param {string} sheetName - Sheet name
   * @param {string} telegramId - Telegram ID to find
   * @param {Function} getCachedDailySheetFn - Function to get cached daily sheet
   * @returns {Object|null} Row object or null
   */
  async getCachedDailyRow(sheetName, telegramId, getCachedDailySheetFn) {
    const cacheKey = `${sheetName}:${telegramId}`;
    const cached = this._dailyRowCache.get(cacheKey);

    if (cached && this._isCacheValid(cached.lastUpdated)) {
      logger.debug(`Using cached daily row for ${sheetName}:${telegramId}`);
      return cached.row;
    }

    // Cache miss - load all rows and build cache
    const { rows } = await getCachedDailySheetFn(sheetName, {});

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
   * Pre-warm cache on startup to reduce API quota usage
   * OPTIMIZATION: Now also builds telegram ID indexes
   * Initializes today's sheet and loads it into cache
   * @param {Function} initializeDailySheetFn - Function to initialize daily sheet
   * @param {Function} getCachedRosterFn - Function to get cached roster
   * @param {Function} getCachedDailySheetFn - Function to get cached daily sheet
   */
  async warmupCache(initializeDailySheetFn, getCachedRosterFn, getCachedDailySheetFn) {
    try {
      const moment = require('moment-timezone');
      const today = moment.tz(Config.TIMEZONE).format('YYYY-MM-DD');

      logger.info(`Warming up cache for today's sheet: ${today}`);

      // Initialize today's sheet and load it into cache
      await initializeDailySheetFn(today);

      // OPTIMIZATION: Pre-load roster into cache and build telegram ID index
      await getCachedRosterFn(true);
      logger.info(`✅ Roster cache built with ${this._rosterByTelegramIdCache.size} indexed employees`);

      // OPTIMIZATION: Pre-build daily sheet telegram ID index
      const { rows } = await getCachedDailySheetFn(today, {});
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
}

module.exports = CacheManager;
