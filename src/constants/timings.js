/**
 * Timing constants for attendance system
 * All times and durations used throughout the application
 */

module.exports = {
  // Grace Periods
  GRACE_PERIOD_MINUTES: 7,              // Grace period for arrival (7 minutes)
  LATE_NOTIFICATION_DEADLINE_MINUTES: 15, // Deadline to notify about being late (15 min after start)

  // Work Time
  LATE_DEADLINE_TIME: '10:00',          // Default late notification deadline
  LATE_THRESHOLD_HOURS: 1.0,            // Hours late threshold

  // Auto-Departure
  AUTO_DEPARTURE_GRACE_MINUTES: 15,     // Grace period before auto-departure
  AUTO_DEPARTURE_WARNING_MINUTES: 10,   // Warning time before auto-departure

  // Location Tracking
  TRACKING_DURATION_MINUTES: 5,         // How long to track location (5 minutes)
  MIN_UPDATES_FOR_VERIFICATION: 3,      // Minimum location updates needed
  UPDATE_TIMEOUT_SECONDS: 60,           // Timeout for location updates

  // Cache Timeouts
  CACHE_TIMEOUT_MS: 1800000,            // 30 minutes cache validity (1800 seconds)
  INIT_CACHE_TIMEOUT_MS: 1800000,       // 30 minutes for initialization cache

  // Retry Configuration
  RETRY_MAX_ATTEMPTS: 3,                // Maximum retry attempts for API calls
  RETRY_INITIAL_DELAY_MS: 1000,         // Initial delay for retry (1 second)

  // Time Formats
  TIME_FORMAT: 'HH:mm',                 // Time format for display
  DATE_FORMAT: 'YYYY-MM-DD',            // Date format for sheets
  DATETIME_FORMAT: 'YYYY-MM-DD HH:mm:ss', // Full datetime format

  // Status Check Intervals (for reminders/schedulers)
  REMINDER_CHECK_INTERVAL_MINUTES: 1,    // Check for reminders every minute
  STATUS_UPDATE_INTERVAL_MINUTES: 5,     // Update status every 5 minutes

  // Notification Timing Offsets (minutes relative to work time)
  NOTIFICATION_OFFSETS: {
    ARRIVAL_MINUS_5: -5,    // 5 minutes before arrival
    ARRIVAL_0: 0,           // At arrival time
    ARRIVAL_PLUS_5: 5,      // 5 minutes after arrival
    ARRIVAL_PLUS_15: 15,    // 15 minutes after arrival (late deadline)
    DEPARTURE_MINUS_10: -10, // 10 minutes before departure
    DEPARTURE_0: 0,         // At departure time
    DEPARTURE_PLUS_10: 10   // 10 minutes after departure
  }
};
