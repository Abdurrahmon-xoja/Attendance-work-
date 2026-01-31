/**
 * Penalty constants for attendance violations
 * All penalties are negative rating points
 */

module.exports = {
  // Rating Penalties (negative points)
  LATE_NOTIFIED: -0.5,           // Late but notified HR
  LATE_SILENT: -1.0,              // Late without notification
  ABSENT_NOTIFIED: 0.0,           // Absent but notified (no penalty)
  ABSENT_SILENT: -1.5,            // Absent without notification
  NO_SHOW: -2.0,                  // Complete no-show
  LEFT_WITHOUT_MESSAGE: -0.3,     // Left without departure message
  EARLY_DEPARTURE: -0.5,          // Left before required time
  DUTY_VIOLATION: -1.0,           // Duty system violation

  // Penalty Time Calculation
  PENALTY_MULTIPLIER: 0.5,        // Multiply lateness by this (e.g., 30 min late = 15 min penalty)
  PENALTY_ALPHA: 0.25,            // Alternative penalty coefficient
  PENALTY_MAX_MINUTES: 240,       // Maximum penalty time (4 hours)

  // Violation Types (for consistency)
  VIOLATION_TYPES: {
    LATE_NOTIFIED: 'LATE_NOTIFIED',
    LATE_SILENT: 'LATE_SILENT',
    ABSENT_NOTIFIED: 'ABSENT_NOTIFIED',
    ABSENT_SILENT: 'ABSENT_SILENT',
    LEFT_WITHOUT_MESSAGE: 'LEFT_WITHOUT_MESSAGE',
    EARLY_DEPARTURE: 'EARLY_DEPARTURE',
    DUTY_VIOLATION: 'DUTY_VIOLATION'
  },

  // Rating Zones
  RATING_ZONES: {
    GREEN: {
      MIN: 8.5,
      EMOJI: '🟢',
      NAME_RU: 'Зелёная зона',
      NAME_EN: 'Green Zone'
    },
    YELLOW: {
      MIN: 6.5,
      EMOJI: '🟡',
      NAME_RU: 'Жёлтая зона',
      NAME_EN: 'Yellow Zone'
    },
    RED: {
      MIN: 0,
      EMOJI: '🔴',
      NAME_RU: 'Красная зона',
      NAME_EN: 'Red Zone'
    }
  }
};
