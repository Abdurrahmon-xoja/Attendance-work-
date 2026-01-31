/**
 * WorkSession model representing a location tracking session
 * Used for tracking employee location during work hours
 */

class WorkSession {
  /**
   * Create a WorkSession instance
   * @param {Object} data - Session data
   * @param {string|number} data.userId - Telegram user ID
   * @param {string} data.userName - User's full name
   * @param {Date} data.startTime - Session start time
   * @param {Date} data.endTime - Session end time (if ended)
   * @param {Object} data.initialLocation - Initial check-in location
   * @param {number} data.initialLocation.latitude - Latitude
   * @param {number} data.initialLocation.longitude - Longitude
   * @param {number} data.initialLocation.accuracy - GPS accuracy in meters
   * @param {Array} data.locationUpdates - Array of location updates during session
   * @param {boolean} data.isActive - Whether session is currently active
   * @param {Object} data.anomalies - Detected location anomalies
   */
  constructor(data = {}) {
    this.userId = data.userId ? data.userId.toString() : '';
    this.userName = data.userName || '';
    this.startTime = data.startTime || null;
    this.endTime = data.endTime || null;
    this.initialLocation = data.initialLocation || null;
    this.locationUpdates = data.locationUpdates || [];
    this.isActive = data.isActive !== undefined ? data.isActive : true;
    this.anomalies = data.anomalies || {
      hasAnomalies: false,
      detectedAnomalies: []
    };
  }

  /**
   * Add a location update to the session
   * @param {Object} location - Location data
   * @param {number} location.latitude - Latitude
   * @param {number} location.longitude - Longitude
   * @param {number} location.accuracy - GPS accuracy in meters
   * @param {Date} timestamp - Update timestamp
   */
  addLocationUpdate(location, timestamp = new Date()) {
    this.locationUpdates.push({
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy || null,
      timestamp: timestamp
    });
  }

  /**
   * Add an anomaly detection result
   * @param {Object} anomaly - Anomaly data
   * @param {string} anomaly.type - Type of anomaly (LOCATION_MISMATCH, IMPOSSIBLE_SPEED, etc.)
   * @param {string} anomaly.severity - Severity level (CRITICAL, WARNING, INFO)
   * @param {string} anomaly.message - Description of the anomaly
   * @param {Object} anomaly.data - Additional data about the anomaly
   */
  addAnomaly(anomaly) {
    this.anomalies.hasAnomalies = true;
    this.anomalies.detectedAnomalies.push({
      type: anomaly.type,
      severity: anomaly.severity,
      message: anomaly.message,
      data: anomaly.data || {},
      detectedAt: new Date()
    });
  }

  /**
   * End the tracking session
   * @param {Date} endTime - Session end time
   */
  endSession(endTime = new Date()) {
    this.endTime = endTime;
    this.isActive = false;
  }

  /**
   * Get session duration in minutes
   * @returns {number} Duration in minutes
   */
  getDurationMinutes() {
    if (!this.startTime) return 0;

    const end = this.endTime || new Date();
    const durationMs = end - this.startTime;
    return Math.floor(durationMs / 60000); // Convert ms to minutes
  }

  /**
   * Get session duration formatted as "X hours Y minutes"
   * @returns {string}
   */
  getFormattedDuration() {
    const totalMinutes = this.getDurationMinutes();
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) {
      return `${minutes} minutes`;
    }

    if (minutes === 0) {
      return `${hours} hours`;
    }

    return `${hours} hours ${minutes} minutes`;
  }

  /**
   * Get number of location updates received
   * @returns {number}
   */
  getUpdateCount() {
    return this.locationUpdates.length;
  }

  /**
   * Check if session has critical anomalies
   * @returns {boolean}
   */
  hasCriticalAnomalies() {
    if (!this.anomalies.hasAnomalies) return false;

    return this.anomalies.detectedAnomalies.some(
      anomaly => anomaly.severity === 'CRITICAL'
    );
  }

  /**
   * Get all critical anomalies
   * @returns {Array}
   */
  getCriticalAnomalies() {
    if (!this.anomalies.hasAnomalies) return [];

    return this.anomalies.detectedAnomalies.filter(
      anomaly => anomaly.severity === 'CRITICAL'
    );
  }

  /**
   * Get all warning-level anomalies
   * @returns {Array}
   */
  getWarningAnomalies() {
    if (!this.anomalies.hasAnomalies) return [];

    return this.anomalies.detectedAnomalies.filter(
      anomaly => anomaly.severity === 'WARNING'
    );
  }

  /**
   * Get last known location
   * @returns {Object|null}
   */
  getLastKnownLocation() {
    if (this.locationUpdates.length === 0) {
      return this.initialLocation;
    }

    return this.locationUpdates[this.locationUpdates.length - 1];
  }

  /**
   * Calculate average accuracy of GPS readings
   * @returns {number} Average accuracy in meters, or null if no data
   */
  getAverageAccuracy() {
    const accuracies = [];

    if (this.initialLocation?.accuracy) {
      accuracies.push(this.initialLocation.accuracy);
    }

    this.locationUpdates.forEach(update => {
      if (update.accuracy) {
        accuracies.push(update.accuracy);
      }
    });

    if (accuracies.length === 0) return null;

    const sum = accuracies.reduce((a, b) => a + b, 0);
    return Math.round(sum / accuracies.length);
  }

  /**
   * Validate session data
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    if (!this.userId) {
      errors.push('User ID is required');
    }

    if (!this.userName) {
      errors.push('User name is required');
    }

    if (!this.startTime) {
      errors.push('Start time is required');
    }

    if (!this.initialLocation) {
      errors.push('Initial location is required');
    } else {
      if (!this.initialLocation.latitude) {
        errors.push('Initial location latitude is required');
      }
      if (!this.initialLocation.longitude) {
        errors.push('Initial location longitude is required');
      }
    }

    if (this.endTime && this.endTime < this.startTime) {
      errors.push('End time cannot be before start time');
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
      userId: this.userId,
      userName: this.userName,
      startTime: this.startTime,
      endTime: this.endTime,
      initialLocation: this.initialLocation,
      locationUpdates: this.locationUpdates,
      isActive: this.isActive,
      anomalies: this.anomalies,
      durationMinutes: this.getDurationMinutes(),
      updateCount: this.getUpdateCount(),
      averageAccuracy: this.getAverageAccuracy()
    };
  }
}

module.exports = WorkSession;
