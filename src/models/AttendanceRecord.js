/**
 * AttendanceRecord model representing a day's attendance data
 * Data is stored in daily Google Sheets (format: YYYY-MM-DD)
 */

class AttendanceRecord {
  /**
   * Create an AttendanceRecord instance
   * @param {Object} data - Attendance data from Google Sheets
   * @param {string} data.date - Date in YYYY-MM-DD format
   * @param {string|number} data.telegramId - Telegram user ID
   * @param {string} data.nameFull - Full name of the employee
   * @param {string} data.arrival - Arrival time (HH:MM)
   * @param {string} data.departure - Departure time (HH:MM)
   * @param {string} data.status - Attendance status (On time, Late notified, etc.)
   * @param {string} data.message - Departure message/reason
   * @param {number} data.hoursWorked - Hours worked (decimal)
   * @param {number} data.penaltyMinutes - Penalty minutes
   * @param {number} data.points - Points earned/lost
   * @param {string} data.rating - Rating (A+, A, B, C, etc.)
   * @param {string} data.workTime - Expected work time
   * @param {number} data.requiredHours - Required hours for the day
   * @param {number} data.deficitMinutes - Deficit minutes if left early
   * @param {number} data.surplusMinutes - Surplus minutes if worked extra
   * @param {string} data.arrivalLocation - Arrival GPS coordinates
   * @param {string} data.departureLocation - Departure GPS coordinates
   * @param {string} data.company - Company name
   * @param {Object} data._row - Reference to the Google Sheets row object
   */
  constructor(data = {}) {
    this.date = data.date || '';
    this.telegramId = data.telegramId ? data.telegramId.toString() : '';
    this.nameFull = data.nameFull || '';
    this.arrival = data.arrival || '';
    this.departure = data.departure || '';
    this.status = data.status || '';
    this.message = data.message || '';
    this.hoursWorked = parseFloat(data.hoursWorked) || 0;
    this.penaltyMinutes = parseInt(data.penaltyMinutes) || 0;
    this.points = parseFloat(data.points) || 0;
    this.rating = data.rating || '';
    this.workTime = data.workTime || '';
    this.requiredHours = parseFloat(data.requiredHours) || 0;
    this.deficitMinutes = parseInt(data.deficitMinutes) || 0;
    this.surplusMinutes = parseInt(data.surplusMinutes) || 0;
    this.arrivalLocation = data.arrivalLocation || '';
    this.departureLocation = data.departureLocation || '';
    this.company = data.company || '';
    this._row = data._row || null; // Internal reference to Google Sheets row
  }

  /**
   * Check if user has checked in
   * @returns {boolean}
   */
  hasCheckedIn() {
    return !!this.arrival;
  }

  /**
   * Check if user has checked out
   * @returns {boolean}
   */
  hasCheckedOut() {
    return !!this.departure;
  }

  /**
   * Check if user is currently at work (checked in but not out)
   * @returns {boolean}
   */
  isCurrentlyAtWork() {
    return this.hasCheckedIn() && !this.hasCheckedOut();
  }

  /**
   * Check if record is complete (both arrival and departure)
   * @returns {boolean}
   */
  isComplete() {
    return this.hasCheckedIn() && this.hasCheckedOut();
  }

  /**
   * Check if user was late
   * @returns {boolean}
   */
  wasLate() {
    return this.status.toLowerCase().includes('late') ||
           this.status.toLowerCase().includes('опоздал');
  }

  /**
   * Check if user was absent
   * @returns {boolean}
   */
  wasAbsent() {
    return this.status.toLowerCase().includes('absent') ||
           this.status.toLowerCase().includes('не пришел') ||
           this.status.toLowerCase().includes('no-show');
  }

  /**
   * Check if user was on time
   * @returns {boolean}
   */
  wasOnTime() {
    return this.status.toLowerCase().includes('on time') ||
           this.status.toLowerCase().includes('вовремя');
  }

  /**
   * Check if user left early
   * @returns {boolean}
   */
  leftEarly() {
    return this.deficitMinutes > 0;
  }

  /**
   * Check if user worked overtime
   * @returns {boolean}
   */
  workedOvertime() {
    return this.surplusMinutes > 0;
  }

  /**
   * Get status emoji
   * @returns {string}
   */
  getStatusEmoji() {
    if (this.wasAbsent()) return '❌';
    if (this.wasOnTime()) return '✅';
    if (this.wasLate()) return '⏰';
    return '⚠️';
  }

  /**
   * Get rating emoji
   * @returns {string}
   */
  getRatingEmoji() {
    const rating = this.rating.toUpperCase();
    if (rating.startsWith('A+')) return '🏆';
    if (rating.startsWith('A')) return '⭐';
    if (rating.startsWith('B')) return '👍';
    if (rating.startsWith('C')) return '👎';
    if (rating.startsWith('D')) return '💀';
    return '❓';
  }

  /**
   * Format hours worked as "X.XX hours" or "X hours Y minutes"
   * @param {boolean} detailed - Whether to show detailed format
   * @returns {string}
   */
  formatHoursWorked(detailed = false) {
    if (!detailed) {
      return `${this.hoursWorked.toFixed(2)} hours`;
    }

    const hours = Math.floor(this.hoursWorked);
    const minutes = Math.round((this.hoursWorked - hours) * 60);

    if (minutes === 0) {
      return `${hours} hours`;
    }

    return `${hours} hours ${minutes} minutes`;
  }

  /**
   * Validate attendance record
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    if (!this.date) {
      errors.push('Date is required');
    }

    if (!this.telegramId) {
      errors.push('Telegram ID is required');
    }

    if (!this.nameFull) {
      errors.push('Full name is required');
    }

    if (this.hoursWorked < 0) {
      errors.push('Hours worked cannot be negative');
    }

    if (this.penaltyMinutes < 0) {
      errors.push('Penalty minutes cannot be negative');
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
      date: this.date,
      telegramId: this.telegramId,
      nameFull: this.nameFull,
      arrival: this.arrival,
      departure: this.departure,
      status: this.status,
      message: this.message,
      hoursWorked: this.hoursWorked,
      penaltyMinutes: this.penaltyMinutes,
      points: this.points,
      rating: this.rating,
      workTime: this.workTime,
      requiredHours: this.requiredHours,
      deficitMinutes: this.deficitMinutes,
      surplusMinutes: this.surplusMinutes,
      arrivalLocation: this.arrivalLocation,
      departureLocation: this.departureLocation,
      company: this.company
    };
  }
}

module.exports = AttendanceRecord;
