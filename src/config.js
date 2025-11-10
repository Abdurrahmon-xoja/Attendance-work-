/**
 * Configuration module for the attendance bot.
 * Loads environment variables and provides configuration constants.
 */

require('dotenv').config();

class Config {
  // Telegram Bot Configuration
  static BOT_TOKEN = process.env.BOT_TOKEN || '';
  static ADMIN_TELEGRAM_IDS = process.env.ADMIN_TELEGRAM_IDS
    ? process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
    : [];

  // Google Sheets Configuration
  static GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';
  static GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  static GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  // Timezone
  static TIMEZONE = process.env.TIMEZONE || 'Asia/Tashkent';

  // Timing Configuration
  static GRACE_PERIOD_MINUTES = parseInt(process.env.GRACE_PERIOD_MINUTES || '7');
  static LATE_DEADLINE_TIME = process.env.LATE_DEADLINE_TIME || '10:00';
  static LATE_THRESHOLD_HOURS = parseFloat(process.env.LATE_THRESHOLD_HOURS || '1.0');

  // Penalty Coefficients
  static PENALTY_ALPHA = parseFloat(process.env.PENALTY_ALPHA || '0.25');
  static PENALTY_MULTIPLIER = parseFloat(process.env.PENALTY_MULTIPLIER || '0.5');
  static PENALTY_MAX_MINUTES = parseInt(process.env.PENALTY_MAX_MINUTES || '240');
  static LATE_NOTIFIED_PENALTY = parseFloat(process.env.LATE_NOTIFIED_PENALTY || '-0.5');
  static LATE_SILENT_PENALTY = parseFloat(process.env.LATE_SILENT_PENALTY || '-1.0');
  static ABSENT_PENALTY = parseFloat(process.env.ABSENT_PENALTY || '-1.5');
  static NO_SHOW_PENALTY = parseFloat(process.env.NO_SHOW_PENALTY || '-2.0');
  static LEFT_WITHOUT_MESSAGE_PENALTY = parseFloat(process.env.LEFT_WITHOUT_MESSAGE_PENALTY || '-0.3');
  static EARLY_DEPARTURE_PENALTY = parseFloat(process.env.EARLY_DEPARTURE_PENALTY || '-0.5');
  static DUTY_VIOLATION_PENALTY = parseFloat(process.env.DUTY_VIOLATION_PENALTY || '-1.0');

  // Rating Thresholds
  static GREEN_ZONE_MIN = parseFloat(process.env.GREEN_ZONE_MIN || '8.5');
  static YELLOW_ZONE_MIN = parseFloat(process.env.YELLOW_ZONE_MIN || '6.5');

  // Feature Flags
  static REQUIRE_DEPARTURE_MESSAGE = process.env.REQUIRE_DEPARTURE_MESSAGE !== 'false';
  static ENABLE_DUTY_SYSTEM = process.env.ENABLE_DUTY_SYSTEM !== 'false';
  static AUTO_CREATE_DAILY_SHEET = process.env.AUTO_CREATE_DAILY_SHEET === 'true';
  static AUTO_UPDATE_MONTHLY_REPORT = process.env.AUTO_UPDATE_MONTHLY_REPORT !== 'false';
  static ENABLE_WORK_REMINDERS = process.env.ENABLE_WORK_REMINDERS === 'true';

  // Notification Configuration
  static NOTIFICATION_ARRIVAL_MINUS_5 = process.env.NOTIFICATION_ARRIVAL_MINUS_5 !== 'false';
  static NOTIFICATION_ARRIVAL_0 = process.env.NOTIFICATION_ARRIVAL_0 !== 'false';
  static NOTIFICATION_ARRIVAL_PLUS_5 = process.env.NOTIFICATION_ARRIVAL_PLUS_5 !== 'false';
  static NOTIFICATION_DEPARTURE_MINUS_10 = process.env.NOTIFICATION_DEPARTURE_MINUS_10 !== 'false';
  static NOTIFICATION_DEPARTURE_0 = process.env.NOTIFICATION_DEPARTURE_0 !== 'false';
  static NOTIFICATION_DEPARTURE_PLUS_10 = process.env.NOTIFICATION_DEPARTURE_PLUS_10 !== 'false';

  // Weekend Notifications
  static SEND_NOTIFICATIONS_SATURDAY = process.env.SEND_NOTIFICATIONS_SATURDAY !== 'false';
  static SEND_NOTIFICATIONS_SUNDAY = process.env.SEND_NOTIFICATIONS_SUNDAY === 'true';

  // Server Configuration
  static PORT = parseInt(process.env.PORT || '3000');
  static NODE_ENV = process.env.NODE_ENV || 'development';
  static LOG_LEVEL = process.env.LOG_LEVEL || 'info';

  // Sheet Names
  static SHEET_ROSTER = 'Worker info';
  static SHEET_TEAMS = 'Teams';
  static SHEET_SCHEDULE = 'Schedule';
  static SHEET_DUTY = 'Duty';
  static SHEET_DUTY_CHECKLIST = 'DutyChecklist';

  /**
   * Validate that required configuration is present
   * @returns {boolean} True if valid, throws error otherwise
   */
  static validate() {
    if (!this.BOT_TOKEN) {
      throw new Error('BOT_TOKEN is required in .env file');
    }
    if (!this.GOOGLE_SHEETS_ID) {
      throw new Error('GOOGLE_SHEETS_ID is required in .env file');
    }
    if (!this.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is required in .env file');
    }
    if (!this.GOOGLE_PRIVATE_KEY || this.GOOGLE_PRIVATE_KEY === '') {
      throw new Error('GOOGLE_PRIVATE_KEY is required in .env file');
    }
    return true;
  }
}

// Validate configuration on import
Config.validate();

module.exports = Config;
