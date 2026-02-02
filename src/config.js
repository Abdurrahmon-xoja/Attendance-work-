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
  static DAILY_REPORT_GROUP_ID = process.env.DAILY_REPORT_GROUP_ID || '';

  // Google Sheets Configuration
  static GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';
  static GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  static GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  // Timezone
  static TIMEZONE = process.env.TIMEZONE || 'Asia/Tashkent';

  // Timing Configuration
  static GRACE_PERIOD_MINUTES = parseInt(process.env.GRACE_PERIOD_MINUTES || '15');

  // Base Points (each day starts with this value)
  static BASE_POINTS = parseInt(process.env.BASE_POINTS || '10');

  // Early Departure Thresholds (minutes)
  static EARLY_MINOR_THRESHOLD = parseInt(process.env.EARLY_MINOR_THRESHOLD || '10');
  static EARLY_MAJOR_THRESHOLD = parseInt(process.env.EARLY_MAJOR_THRESHOLD || '40');

  // Penalty Coefficients
  static PENALTY_ALPHA = parseFloat(process.env.PENALTY_ALPHA || '0.25');
  static PENALTY_MULTIPLIER = parseFloat(process.env.PENALTY_MULTIPLIER || '0.5');
  static PENALTY_MAX_MINUTES = parseInt(process.env.PENALTY_MAX_MINUTES || '240');

  // Arrival Penalties
  static LATE_NOTIFIED_BEFORE_START_PENALTY = parseFloat(process.env.LATE_NOTIFIED_BEFORE_START_PENALTY || '-2');
  static LATE_NOTIFIED_AFTER_START_PENALTY = parseFloat(process.env.LATE_NOTIFIED_AFTER_START_PENALTY || '-4');
  static LATE_SILENT_PENALTY = parseFloat(process.env.LATE_SILENT_PENALTY || '-4');
  static LATE_CAME_AFTER_STATED_PENALTY = parseFloat(process.env.LATE_CAME_AFTER_STATED_PENALTY || '-4');
  static DID_NOT_ARRIVE_PENALTY = parseFloat(process.env.DID_NOT_ARRIVE_PENALTY || '-10');

  // Departure Penalties
  static EARLY_DEPARTURE_MINOR_PENALTY = parseFloat(process.env.EARLY_DEPARTURE_MINOR_PENALTY || '-4');
  static EARLY_DEPARTURE_MAJOR_PENALTY = parseFloat(process.env.EARLY_DEPARTURE_MAJOR_PENALTY || '-6');
  static LEFT_BEFORE_SHIFT_PENALTY = parseFloat(process.env.LEFT_BEFORE_SHIFT_PENALTY || '-10');

  // Absence Penalties
  static ABSENT_NOTIFIED_PENALTY = parseFloat(process.env.ABSENT_NOTIFIED_PENALTY || '-4');
  static ABSENT_PENALTY = parseFloat(process.env.ABSENT_PENALTY || '-10');
  static NO_SHOW_PENALTY = parseFloat(process.env.NO_SHOW_PENALTY || '-10');

  // Legacy penalties (kept for compatibility)
  static LATE_NOTIFIED_PENALTY = parseFloat(process.env.LATE_NOTIFIED_PENALTY || '-2');
  static LEFT_WITHOUT_MESSAGE_PENALTY = parseFloat(process.env.LEFT_WITHOUT_MESSAGE_PENALTY || '-4');
  static EARLY_DEPARTURE_PENALTY = parseFloat(process.env.EARLY_DEPARTURE_PENALTY || '-4');
  static DUTY_VIOLATION_PENALTY = parseFloat(process.env.DUTY_VIOLATION_PENALTY || '-4');

  // Rating Thresholds (5 zones)
  static EXCELLENT_ZONE_MIN = parseFloat(process.env.EXCELLENT_ZONE_MIN || '10');
  static GOOD_ZONE_MIN = parseFloat(process.env.GOOD_ZONE_MIN || '8');
  static ACCEPTABLE_ZONE_MIN = parseFloat(process.env.ACCEPTABLE_ZONE_MIN || '5');
  static BAD_ZONE_MIN = parseFloat(process.env.BAD_ZONE_MIN || '3');

  // Legacy zone thresholds (mapped to new system)
  static GREEN_ZONE_MIN = parseFloat(process.env.GREEN_ZONE_MIN || '10');
  static YELLOW_ZONE_MIN = parseFloat(process.env.YELLOW_ZONE_MIN || '8');

  // Location Tracking Configuration
  static TRACKING_DURATION_MINUTES = parseFloat(process.env.TRACKING_DURATION_MINUTES || '5');
  static MIN_UPDATES_FOR_VERIFICATION = parseInt(process.env.MIN_UPDATES_FOR_VERIFICATION || '3');
  static OFFICE_LATITUDE = parseFloat(process.env.OFFICE_LATITUDE || '41.302799');
  static OFFICE_LONGITUDE = parseFloat(process.env.OFFICE_LONGITUDE || '69.314780');
  static GEOFENCE_RADIUS_METERS = parseInt(process.env.GEOFENCE_RADIUS_METERS || '200');
  static MAX_ACCURACY_METERS = parseInt(process.env.MAX_ACCURACY_METERS || '50');
  static MAX_JUMP_DISTANCE_METERS = parseInt(process.env.MAX_JUMP_DISTANCE_METERS || '500');
  static MAX_SPEED_KMH = parseInt(process.env.MAX_SPEED_KMH || '100');
  static UPDATE_TIMEOUT_SECONDS = parseInt(process.env.UPDATE_TIMEOUT_SECONDS || '60');
  static ENABLE_LOCATION_TRACKING = process.env.ENABLE_LOCATION_TRACKING === 'true';

  // Feature Flags
  static REQUIRE_DEPARTURE_MESSAGE = process.env.REQUIRE_DEPARTURE_MESSAGE !== 'false';
  static ENABLE_DUTY_SYSTEM = process.env.ENABLE_DUTY_SYSTEM !== 'false';
  static AUTO_CREATE_DAILY_SHEET = process.env.AUTO_CREATE_DAILY_SHEET === 'true';
  static AUTO_UPDATE_MONTHLY_REPORT = process.env.AUTO_UPDATE_MONTHLY_REPORT !== 'false';
  static ENABLE_WORK_REMINDERS = process.env.ENABLE_WORK_REMINDERS === 'true';
  static ENABLE_AUTO_DEPARTURE = process.env.ENABLE_AUTO_DEPARTURE !== 'false';

  // Auto-Departure Configuration
  static AUTO_DEPARTURE_GRACE_MINUTES = parseInt(process.env.AUTO_DEPARTURE_GRACE_MINUTES || '15');
  static AUTO_DEPARTURE_WARNING_MINUTES = parseInt(process.env.AUTO_DEPARTURE_WARNING_MINUTES || '10');

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
