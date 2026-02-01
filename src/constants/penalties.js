/**
 * Penalty constants for attendance violations
 * Base-10 point system: each day starts at 10 points, penalties are subtracted
 */

module.exports = {
  // Base points for each day
  BASE_POINTS: 10,

  // === ARRIVAL PENALTIES (subtracted from BASE_POINTS) ===
  LATE_NOTIFIED_BEFORE_START: -2,   // Late but notified BEFORE work start time
  LATE_NOTIFIED_AFTER_START: -4,    // Late but notified AFTER work start time
  LATE_SILENT: -4,                   // Late without any notification
  LATE_CAME_AFTER_STATED: -4,       // Arrived later than the stated arrival time
  DID_NOT_ARRIVE_AFTER_NOTIFYING: -10, // Notified late but never arrived

  // === DEPARTURE PENALTIES (additional, subtracted from current total) ===
  EARLY_DEPARTURE_MINOR: -4,        // Left early 10-40 min
  EARLY_DEPARTURE_MAJOR: -6,        // Left early 40+ min
  LEFT_BEFORE_SHIFT: -10,           // Left before shift started (total = 0)

  // Early departure thresholds (minutes)
  EARLY_MINOR_THRESHOLD: 10,        // < 10 min early = no penalty
  EARLY_MAJOR_THRESHOLD: 40,        // >= 40 min early = major penalty

  // === ABSENCE PENALTIES ===
  ABSENT_NOTIFIED: -4,              // Absent but notified HR
  ABSENT_SILENT: -10,               // Absent without notification (total = 0)
  NO_SHOW: -10,                     // Complete no-show (total = 0)

  // === LEGACY (kept for compatibility, not used in new system) ===
  LEFT_WITHOUT_MESSAGE: -4,         // Left without departure message
  DUTY_VIOLATION: -4,               // Duty system violation

  // Penalty Time Calculation
  PENALTY_MULTIPLIER: 0.5,
  PENALTY_ALPHA: 0.25,
  PENALTY_MAX_MINUTES: 240,

  // Violation Types (for consistency)
  VIOLATION_TYPES: {
    LATE_NOTIFIED_BEFORE_START: 'LATE_NOTIFIED_BEFORE_START',
    LATE_NOTIFIED_AFTER_START: 'LATE_NOTIFIED_AFTER_START',
    LATE_SILENT: 'LATE_SILENT',
    LATE_CAME_AFTER_STATED: 'LATE_CAME_AFTER_STATED',
    DID_NOT_ARRIVE_AFTER_NOTIFYING: 'DID_NOT_ARRIVE_AFTER_NOTIFYING',
    ABSENT_NOTIFIED: 'ABSENT_NOTIFIED',
    ABSENT_SILENT: 'ABSENT_SILENT',
    EARLY_DEPARTURE_MINOR: 'EARLY_DEPARTURE_MINOR',
    EARLY_DEPARTURE_MAJOR: 'EARLY_DEPARTURE_MAJOR',
    LEFT_BEFORE_SHIFT: 'LEFT_BEFORE_SHIFT',
    LEFT_WITHOUT_MESSAGE: 'LEFT_WITHOUT_MESSAGE',
    DUTY_VIOLATION: 'DUTY_VIOLATION'
  },

  // Rating Zones (5 levels, applied to daily points AND monthly average)
  RATING_ZONES: {
    EXCELLENT: {
      MIN: 10,
      EMOJI: '🟢',
      NAME_RU: 'Отлично',
      NAME_EN: 'Excellent'
    },
    GOOD: {
      MIN: 8,
      EMOJI: '🔵',
      NAME_RU: 'Хорошо',
      NAME_EN: 'Good'
    },
    ACCEPTABLE: {
      MIN: 5,
      EMOJI: '🟡',
      NAME_RU: 'Допустимо',
      NAME_EN: 'Acceptable'
    },
    BAD: {
      MIN: 3,
      EMOJI: '🟠',
      NAME_RU: 'Плохо',
      NAME_EN: 'Bad'
    },
    UNACCEPTABLE: {
      MIN: 0,
      EMOJI: '🔴',
      NAME_RU: 'Недопустимо',
      NAME_EN: 'Unacceptable'
    }
  }
};
