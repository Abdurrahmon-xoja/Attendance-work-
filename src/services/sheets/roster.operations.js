/**
 * Roster Operations for Google Sheets Service
 * Handles all roster-related operations (Worker info sheet)
 */

const Config = require('../../config');
const logger = require('../../utils/logger');
const QuotaHandler = require('./quota.handler');

class RosterOperations {
  constructor(coreService, cacheManager, quotaHandler) {
    this.coreService = coreService;
    this.cacheManager = cacheManager;
    this.quotaHandler = quotaHandler;
  }

  /**
   * Find employee by Telegram ID in Roster sheet
   * @param {number} telegramId - User's Telegram ID
   * @returns {Object|null} Employee data or null if not found
   */
  async findEmployeeByTelegramId(telegramId) {
    try {
      // OPTIMIZATION: Try indexed cache first (much faster than looping)
      const cachedEmployee = await this.cacheManager._getCachedEmployeeByTelegramId(
        telegramId,
        async (buildIndex) => this._getCachedRoster(buildIndex)
      );

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
      if (QuotaHandler.isQuotaError(error)) {
        logger.warn(`Quota error while finding employee by telegram_id: ${error.message}`);
        throw QuotaHandler.createQuotaError(error);
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
      const roster = await this.coreService.getWorksheet(Config.SHEET_ROSTER);
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
   * Get cached roster data (wrapper for cache manager)
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

module.exports = RosterOperations;
