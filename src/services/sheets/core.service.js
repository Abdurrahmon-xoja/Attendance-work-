/**
 * Core Google Sheets Service
 * Handles connection and basic worksheet operations
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Config = require('../../config');
const logger = require('../../utils/logger');

class CoreSheetsService {
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
}

module.exports = CoreSheetsService;
