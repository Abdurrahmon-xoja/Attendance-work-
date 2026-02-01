/**
 * Calculator service for attendance-related time and penalty calculations.
 */

const moment = require('moment-timezone');
const Config = require('../config');

class CalculatorService {
  /**
   * Parse work time string like "9:00-18:00" into start and end time objects.
   * @param {string} workTimeStr - Work time string in format "HH:MM-HH:MM"
   * @returns {Object|null} Object with {start, end} moments or null if invalid
   */
  static parseWorkTime(workTimeStr) {
    try {
      if (!workTimeStr || workTimeStr === '-' || workTimeStr === '00:00-00:00') {
        return null;
      }

      const parts = workTimeStr.split('-');
      if (parts.length !== 2) {
        return null;
      }

      const [startStr, endStr] = parts;
      const [startHour, startMin] = startStr.trim().split(':').map(Number);
      const [endHour, endMin] = endStr.trim().split(':').map(Number);

      if (isNaN(startHour) || isNaN(startMin) || isNaN(endHour) || isNaN(endMin)) {
        return null;
      }

      const now = moment.tz(Config.TIMEZONE);
      const start = now.clone().set({ hour: startHour, minute: startMin, second: 0, millisecond: 0 });
      const end = now.clone().set({ hour: endHour, minute: endMin, second: 0, millisecond: 0 });

      return { start, end };
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate lateness in minutes and determine status.
   * @param {moment.Moment} scheduledStart - Scheduled start time
   * @param {moment.Moment} actualArrival - Actual arrival time
   * @param {number} gracePeriodMinutes - Grace period in minutes
   * @returns {Object} Object with {latenessMinutes, status}
   */
  static calculateLateness(scheduledStart, actualArrival, gracePeriodMinutes = null) {
    if (gracePeriodMinutes === null) {
      gracePeriodMinutes = Config.GRACE_PERIOD_MINUTES;
    }

    // Calculate difference
    const diffMinutes = actualArrival.diff(scheduledStart, 'minutes');

    if (diffMinutes <= gracePeriodMinutes) {
      return { latenessMinutes: 0, status: 'ON_TIME' };
    } else if (diffMinutes <= gracePeriodMinutes) {
      return { latenessMinutes: diffMinutes, status: 'SOFT_LATE' };
    } else {
      return { latenessMinutes: diffMinutes, status: 'LATE' };
    }
  }

  /**
   * Calculate penalty time based on lateness using linear formula with cap.
   * Formula: penalty = lateness × multiplier (max: PENALTY_MAX_MINUTES)
   * @param {number} latenessMinutes - Minutes late
   * @param {number} multiplier - Penalty multiplier (default from config)
   * @returns {number} Total penalty minutes to add to work day
   */
  static calculatePenaltyTime(latenessMinutes, multiplier = null) {
    if (multiplier === null) {
      multiplier = Config.PENALTY_MULTIPLIER;
    }

    if (latenessMinutes <= 0) {
      return 0;
    }

    // Calculate penalty with multiplier
    let penalty = Math.floor(latenessMinutes * multiplier);

    // Cap at maximum penalty
    const maxPenalty = Config.PENALTY_MAX_MINUTES;
    if (penalty > maxPenalty) {
      penalty = maxPenalty;
    }

    return penalty;
  }

  /**
   * Calculate required end time including penalty.
   * @param {moment.Moment} scheduledEnd - Scheduled end time
   * @param {number} penaltyMinutes - Penalty minutes to add
   * @returns {moment.Moment} Required end datetime
   */
  static calculateRequiredEndTime(scheduledEnd, penaltyMinutes) {
    return scheduledEnd.clone().add(penaltyMinutes, 'minutes');
  }

  /**
   * Format time difference in human-readable format (Russian).
   * @param {number} minutes - Time difference in minutes
   * @returns {string} Formatted string like "25 мин" or "1 ч 15 мин"
   */
  static formatTimeDiff(minutes) {
    if (minutes < 60) {
      return `${minutes} мин`;
    } else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      if (mins === 0) {
        return `${hours} ч`;
      } else {
        return `${hours} ч ${mins} мин`;
      }
    }
  }

  /**
   * Check if current time is within late notification deadline (15 min after work start).
   * @param {moment.Moment} workStartTime - Person's work start time
   * @param {moment.Moment} currentTime - Time to check
   * @returns {boolean} True if within 15 min after work start, False otherwise
   */
  static isWithinLateDeadline(workStartTime, currentTime = null) {
    if (!currentTime) {
      currentTime = moment.tz(Config.TIMEZONE);
    }

    if (!workStartTime) {
      return false;
    }

    // Deadline is 15 minutes AFTER work start time
    const deadline = workStartTime.clone().add(15, 'minutes');

    return currentTime.isBefore(deadline);
  }

  /**
   * Get rating impact for a violation type.
   * @param {string} violationType - Type of violation
   * @returns {number} Rating points (negative number)
   */
  static calculateRatingImpact(violationType) {
    const impacts = {
      'LATE_NOTIFIED_BEFORE_START': Config.LATE_NOTIFIED_BEFORE_START_PENALTY,
      'LATE_NOTIFIED_AFTER_START': Config.LATE_NOTIFIED_AFTER_START_PENALTY,
      'LATE_NOTIFIED': Config.LATE_NOTIFIED_BEFORE_START_PENALTY, // Legacy: map to before-start
      'LATE_SILENT': Config.LATE_SILENT_PENALTY,
      'LATE_CAME_AFTER_STATED': Config.LATE_CAME_AFTER_STATED_PENALTY,
      'DID_NOT_ARRIVE_AFTER_NOTIFYING': Config.DID_NOT_ARRIVE_PENALTY,
      'ABSENT_NOTIFIED': Config.ABSENT_NOTIFIED_PENALTY,
      'ABSENT_SILENT': Config.ABSENT_PENALTY,
      'EARLY_DEPARTURE_MINOR': Config.EARLY_DEPARTURE_MINOR_PENALTY,
      'EARLY_DEPARTURE_MAJOR': Config.EARLY_DEPARTURE_MAJOR_PENALTY,
      'LEFT_BEFORE_SHIFT': Config.LEFT_BEFORE_SHIFT_PENALTY,
      'LEFT_WITHOUT_MESSAGE': Config.LEFT_WITHOUT_MESSAGE_PENALTY,
      'EARLY_DEPARTURE': Config.EARLY_DEPARTURE_MINOR_PENALTY, // Legacy
      'DUTY_VIOLATION': Config.DUTY_VIOLATION_PENALTY,
      'NO_SHOW': Config.NO_SHOW_PENALTY,
    };
    return impacts[violationType] || 0.0;
  }

  /**
   * Determine arrival penalty type based on notification timing.
   * @param {boolean} wasLateNotified - Whether user pressed "I'll be late"
   * @param {boolean} notifiedBeforeStart - Whether notification was sent before work start
   * @param {boolean} cameAfterStatedTime - Whether user arrived after their stated arrival time
   * @returns {string} Violation type string
   */
  static determineArrivalPenaltyType(wasLateNotified, notifiedBeforeStart, cameAfterStatedTime) {
    if (!wasLateNotified) {
      return 'LATE_SILENT';
    }
    if (cameAfterStatedTime) {
      return 'LATE_CAME_AFTER_STATED';
    }
    if (notifiedBeforeStart) {
      return 'LATE_NOTIFIED_BEFORE_START';
    }
    return 'LATE_NOTIFIED_AFTER_START';
  }

  /**
   * Determine early departure penalty based on minutes early.
   * @param {number} earlyMinutes - How many minutes early the person left
   * @returns {Object} { penalty, violationType } - penalty amount and type
   */
  static determineEarlyDeparturePenalty(earlyMinutes) {
    if (earlyMinutes < Config.EARLY_MINOR_THRESHOLD) {
      return { penalty: 0, violationType: null };
    } else if (earlyMinutes < Config.EARLY_MAJOR_THRESHOLD) {
      return { penalty: Config.EARLY_DEPARTURE_MINOR_PENALTY, violationType: 'EARLY_DEPARTURE_MINOR' };
    } else {
      return { penalty: Config.EARLY_DEPARTURE_MAJOR_PENALTY, violationType: 'EARLY_DEPARTURE_MAJOR' };
    }
  }

  /**
   * Get rating zone and emoji based on rating value (5-zone system).
   * @param {number} rating - Rating value (0-10)
   * @returns {Object} Object with {emoji, zoneName}
   */
  static getRatingZone(rating) {
    if (rating >= Config.EXCELLENT_ZONE_MIN) {
      return { emoji: '🟢', zoneName: 'Отлично' };
    } else if (rating >= Config.GOOD_ZONE_MIN) {
      return { emoji: '🔵', zoneName: 'Хорошо' };
    } else if (rating >= Config.ACCEPTABLE_ZONE_MIN) {
      return { emoji: '🟡', zoneName: 'Допустимо' };
    } else if (rating >= Config.BAD_ZONE_MIN) {
      return { emoji: '🟠', zoneName: 'Плохо' };
    } else {
      return { emoji: '🔴', zoneName: 'Недопустимо' };
    }
  }

  /**
   * Calculate total minutes worked between arrival and departure.
   * @param {moment.Moment} arrivalTime - Arrival datetime
   * @param {moment.Moment} departureTime - Departure datetime
   * @returns {number} Total minutes worked
   */
  static calculateHoursWorked(arrivalTime, departureTime) {
    return departureTime.diff(arrivalTime, 'minutes');
  }

  /**
   * Calculate total required work minutes (scheduled + penalty).
   * @param {moment.Moment} scheduledStart - Scheduled start time
   * @param {moment.Moment} scheduledEnd - Scheduled end time
   * @param {number} penaltyMinutes - Additional penalty minutes
   * @returns {number} Total required minutes
   */
  static calculateRequiredHours(scheduledStart, scheduledEnd, penaltyMinutes = 0) {
    const scheduledMinutes = scheduledEnd.diff(scheduledStart, 'minutes');
    return scheduledMinutes + penaltyMinutes;
  }

  /**
   * Calculate how many minutes early the person left.
   * @param {moment.Moment} departureTime - Actual departure datetime
   * @param {moment.Moment} requiredEndTime - Required end datetime (scheduled + penalty)
   * @returns {number} Minutes left early (positive number), or 0 if left on time or late
   */
  static calculateEarlyDepartureMinutes(departureTime, requiredEndTime) {
    const earlyMinutes = requiredEndTime.diff(departureTime, 'minutes');
    return Math.max(0, earlyMinutes);
  }

  /**
   * Calculate overtime minutes worked beyond required time.
   * @param {moment.Moment} departureTime - Actual departure datetime
   * @param {moment.Moment} requiredEndTime - Required end datetime (scheduled + penalty)
   * @returns {number} Overtime minutes (positive number), or 0 if left early
   */
  static calculateOvertimeMinutes(departureTime, requiredEndTime) {
    const overtimeMinutes = departureTime.diff(requiredEndTime, 'minutes');
    return Math.max(0, overtimeMinutes);
  }

  /**
   * Determine if overtime should be credited.
   * Only credit overtime if there is no penalty time to work off.
   * @param {number} penaltyMinutes - Current penalty minutes to work off
   * @returns {boolean} True if overtime should be credited, False otherwise
   */
  static shouldCreditOvertime(penaltyMinutes) {
    return penaltyMinutes === 0;
  }
}

module.exports = CalculatorService;
