/**
 * Google Sheets related constants
 * Sheet names, column names, and data structure definitions
 */

module.exports = {
  // Sheet Names
  SHEET_NAMES: {
    ROSTER: 'Worker info',
    TEAMS: 'Teams',
    SCHEDULE: 'Schedule',
    DUTY: 'Duty',
    DUTY_CHECKLIST: 'DutyChecklist'
  },

  // Roster Sheet Columns
  ROSTER_COLUMNS: {
    NAME_FULL: 'Name full',
    WORK_TIME: 'Work time',
    TELEGRAM_NAME: 'Telegram name',
    COMPANY: 'Company',
    TELEGRAM_USERNAME: 'Telegram user name',
    TELEGRAM_ID: 'Telegram Id',
    DO_NOT_WORK_SATURDAY: 'Do not work in Saturday'
  },

  // Daily Sheet Columns
  DAILY_COLUMNS: {
    TELEGRAM_ID: 'TelegramId',
    NAME_FULL: 'Name full',
    ARRIVAL: 'Arrival',
    DEPARTURE: 'Departure',
    STATUS: 'Status',
    MESSAGE: 'Message',
    HOURS_WORKED: 'Hours worked',
    PENALTY_MINUTES: 'Penalty (minutes)',
    POINTS: 'Points',
    RATING: 'Rating',
    WORK_TIME: 'Work time',
    REQUIRED_HOURS: 'Required hours',
    DEFICIT_MINUTES: 'Deficit (minutes)',
    SURPLUS_MINUTES: 'Surplus (minutes)',
    ARRIVAL_LOCATION: 'Arrival Location',
    DEPARTURE_LOCATION: 'Departure Location',
    COMPANY: 'Company'
  },

  // Monthly Report Columns
  MONTHLY_COLUMNS: {
    TELEGRAM_ID: 'TelegramId',
    NAME_FULL: 'Name full',
    TOTAL_WORK_DAYS: 'Total Work Days',
    DAYS_WORKED: 'Days worked',
    DAYS_ABSENT: 'Days absent',
    DAYS_ABSENT_NOTIFIED: 'Days absent (notified)',
    DAYS_ABSENT_SILENT: 'Days absent (silent)',
    ON_TIME_ARRIVALS: 'On-time arrivals',
    LATE_NOTIFIED: 'Late (notified)',
    LATE_SILENT: 'Late (silent)',
    EARLY_DEPARTURES: 'Early departures',
    EARLY_FULL_HOURS: 'Early (full hours)',
    LEFT_BEFORE_SHIFT: 'Left before shift',
    TOTAL_HOURS_WORKED: 'Total hours worked',
    TOTAL_PENALTY_MINUTES: 'Total penalty (minutes)',
    TOTAL_POINTS: 'Total points',
    RATING: 'Rating',
    TOTAL_DEFICIT_MINUTES: 'Total deficit (minutes)',
    TOTAL_SURPLUS_MINUTES: 'Total surplus (minutes)'
  },

  // Column Header Formats
  HEADER_FORMAT: {
    BOLD: true,
    BACKGROUND_COLOR: {
      red: 0.9,
      green: 0.9,
      blue: 0.9
    }
  },

  // Date Format for Daily Sheets
  DATE_FORMAT: 'YYYY-MM-DD',
  MONTH_FORMAT: 'YYYY-MM',

  // Default Values
  DEFAULTS: {
    WORK_TIME: '9:00-18:00',
    DO_NOT_WORK_SATURDAY: 'no',
    STATUS_NOT_ARRIVED: 'Не пришел',
    STATUS_ON_TIME: 'Вовремя',
    EMPTY_CELL: '-'
  },

  // Sheet Properties
  PROPERTIES: {
    ROSTER_ID: 0,           // Roster sheet position
    FREEZE_ROWS: 1,         // Freeze header row
    FREEZE_COLUMNS: 0       // No frozen columns by default
  }
};
