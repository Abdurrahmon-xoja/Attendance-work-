/**
 * User model representing an employee in the attendance system
 * Data is stored in Google Sheets "Roster" sheet
 */

class User {
  /**
   * Create a User instance
   * @param {Object} data - User data from Google Sheets
   * @param {number} data.rowNumber - Row number in the Roster sheet
   * @param {string} data.nameFull - Full name of the employee
   * @param {string} data.workTime - Expected work time (e.g., "9:00-18:00")
   * @param {string} data.telegramName - Telegram display name
   * @param {string} data.company - Company name
   * @param {string} data.telegramUsername - Telegram username (@username)
   * @param {string|number} data.telegramId - Telegram user ID
   * @param {boolean} data.doNotWorkSaturday - Whether employee works on Saturdays
   * @param {Object} data._row - Reference to the Google Sheets row object
   */
  constructor(data = {}) {
    this.rowNumber = data.rowNumber || null;
    this.nameFull = data.nameFull || '';
    this.workTime = data.workTime || '';
    this.telegramName = data.telegramName || '';
    this.company = data.company || '';
    this.telegramUsername = data.telegramUsername || '';
    this.telegramId = data.telegramId ? data.telegramId.toString() : '';
    this.doNotWorkSaturday = data.doNotWorkSaturday || false;
    this._row = data._row || null; // Internal reference to Google Sheets row
  }

  /**
   * Get user's work start time
   * @returns {string|null} Start time (e.g., "9:00") or null if not set
   */
  getWorkStartTime() {
    if (!this.workTime) return null;
    const parts = this.workTime.split('-');
    return parts[0]?.trim() || null;
  }

  /**
   * Get user's work end time
   * @returns {string|null} End time (e.g., "18:00") or null if not set
   */
  getWorkEndTime() {
    if (!this.workTime) return null;
    const parts = this.workTime.split('-');
    return parts[1]?.trim() || null;
  }

  /**
   * Check if user is registered (has a telegram ID)
   * @returns {boolean}
   */
  isRegistered() {
    return !!this.telegramId;
  }

  /**
   * Get user's display name (prioritize full name, fallback to telegram name)
   * @returns {string}
   */
  getDisplayName() {
    return this.nameFull || this.telegramName || this.telegramUsername || 'Unknown User';
  }

  /**
   * Check if user should work on a given day
   * @param {moment.Moment} date - Date to check
   * @returns {boolean}
   */
  shouldWorkOnDay(date) {
    const dayOfWeek = date.day();

    // Sunday (0) - nobody works
    if (dayOfWeek === 0) {
      return false;
    }

    // Saturday (6) - depends on user setting
    if (dayOfWeek === 6) {
      return !this.doNotWorkSaturday;
    }

    // Monday-Friday - everyone works
    return true;
  }

  /**
   * Validate user data
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    if (!this.nameFull) {
      errors.push('Full name is required');
    }

    if (!this.telegramId) {
      errors.push('Telegram ID is required');
    }

    if (!this.workTime) {
      errors.push('Work time is required');
    } else if (!this.workTime.includes('-')) {
      errors.push('Work time must be in format "HH:MM-HH:MM"');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      rowNumber: this.rowNumber,
      nameFull: this.nameFull,
      workTime: this.workTime,
      telegramName: this.telegramName,
      company: this.company,
      telegramUsername: this.telegramUsername,
      telegramId: this.telegramId,
      doNotWorkSaturday: this.doNotWorkSaturday
    };
  }
}

module.exports = User;
