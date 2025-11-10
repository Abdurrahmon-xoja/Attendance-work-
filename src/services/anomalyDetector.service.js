/**
 * Anomaly Detector Service
 * Analyzes location patterns and detects suspicious behavior
 */

const geofenceService = require('./geofence.service');
const Config = require('../config');
const logger = require('../utils/logger');

// Anomaly types
const ANOMALY_TYPES = {
  SUDDEN_JUMP: 'SUDDEN_JUMP',
  LEFT_GEOFENCE: 'LEFT_GEOFENCE',
  MOCK_GPS: 'MOCK_GPS',
  LOW_ACCURACY: 'LOW_ACCURACY',
  STOPPED_SENDING: 'STOPPED_SENDING',
  IMPOSSIBLE_SPEED: 'IMPOSSIBLE_SPEED',
  WRONG_LOCATION: 'WRONG_LOCATION'
};

// Anomaly descriptions
const ANOMALY_DESCRIPTIONS = {
  SUDDEN_JUMP: 'Location jumped more than 500m in less than 30 seconds',
  LEFT_GEOFENCE: 'User left office area during verification',
  MOCK_GPS: 'Mock GPS location detected (Android)',
  LOW_ACCURACY: 'GPS accuracy too low (>50 meters)',
  STOPPED_SENDING: 'Location updates stopped before 5 minutes',
  IMPOSSIBLE_SPEED: 'Movement speed exceeds 100 km/h',
  WRONG_LOCATION: 'Initial check-in location outside office geofence'
};

class AnomalyDetectorService {
  /**
   * Detect sudden jump in location (teleportation)
   * @param {Object} prevLocation - Previous location
   * @param {Object} currLocation - Current location
   * @returns {Object|null} Anomaly object or null
   */
  detectSuddenJump(prevLocation, currLocation) {
    if (!prevLocation || !currLocation) {
      return null;
    }

    // Calculate time difference in seconds
    const timeDiff = (currLocation.timestamp - prevLocation.timestamp) / 1000;

    // Only check if time difference is less than 30 seconds
    if (timeDiff >= 30) {
      return null;
    }

    // Calculate distance
    const distance = geofenceService.calculateDistance(
      prevLocation.latitude,
      prevLocation.longitude,
      currLocation.latitude,
      currLocation.longitude
    );

    // Check if jumped more than MAX_JUMP_DISTANCE_METERS
    const maxJump = Config.MAX_JUMP_DISTANCE_METERS || 500;

    if (distance > maxJump) {
      // Check if both locations are within or near the office geofence
      const prevDistanceFromOffice = geofenceService.calculateDistance(
        prevLocation.latitude,
        prevLocation.longitude,
        Config.OFFICE_LATITUDE,
        Config.OFFICE_LONGITUDE
      );
      const currDistanceFromOffice = geofenceService.calculateDistance(
        currLocation.latitude,
        currLocation.longitude,
        Config.OFFICE_LATITUDE,
        Config.OFFICE_LONGITUDE
      );

      const geofenceRadius = Config.GEOFENCE_RADIUS_METERS || 700;
      const allowedRadius = geofenceRadius + 300; // Allow 300m margin for GPS inaccuracy

      // If BOTH locations are within the allowed area, treat as GPS drift, not fraud
      const bothNearOffice = prevDistanceFromOffice <= allowedRadius &&
                            currDistanceFromOffice <= allowedRadius;

      if (bothNearOffice && distance < 1000) {
        // GPS jump within office area - likely GPS drift, not fraud
        logger.debug(`⚠️ GPS jump detected: ${Math.round(distance)}m in ${Math.round(timeDiff)}s, but both locations near office - treating as normal drift`);
        return null;
      }

      // Otherwise, this is suspicious (either jumping away from office or very large jump)
      return {
        type: ANOMALY_TYPES.SUDDEN_JUMP,
        description: `Location jumped ${Math.round(distance)}m in ${Math.round(timeDiff)}s`,
        severity: 'HIGH',
        data: {
          distance: distance,
          timeDiff: timeDiff,
          from: { lat: prevLocation.latitude, lng: prevLocation.longitude },
          to: { lat: currLocation.latitude, lng: currLocation.longitude }
        }
      };
    }

    return null;
  }

  /**
   * Detect if user left office geofence
   * @param {Object} location - Current location with accuracy
   * @returns {Object|null} Anomaly object or null
   */
  detectLeftGeofence(location) {
    if (!location) {
      return null;
    }

    const result = geofenceService.checkOfficeGeofence(location);

    // IMPORTANT: Account for GPS accuracy margin of error
    // Only flag if user is CLEARLY outside the geofence
    // If accuracy is poor (e.g., 495m), we can't be certain where they actually are
    const accuracy = location.accuracy || 0;
    const geofenceRadius = Config.GEOFENCE_RADIUS_METERS || 200;

    // Calculate the confidence margin: distance must exceed (geofence + accuracy) to be certain
    // Example: If distance=207m, accuracy=495m, geofence=200m
    //   → User could be anywhere from -288m to +702m from reported point
    //   → Can't confidently say they left the geofence
    const confidenceMargin = geofenceRadius + accuracy;

    if (!result.isInside && result.distance > confidenceMargin) {
      return {
        type: ANOMALY_TYPES.LEFT_GEOFENCE,
        description: `User is ${geofenceService.formatDistance(result.distance)} from office (outside ${geofenceRadius}m radius, accuracy: ${Math.round(accuracy)}m)`,
        severity: 'HIGH',
        data: {
          distance: result.distance,
          accuracy: accuracy,
          confidenceMargin: confidenceMargin,
          location: { lat: location.latitude, lng: location.longitude }
        }
      };
    }

    return null;
  }

  /**
   * Detect mock GPS (only available on Android via Telegram API)
   * @param {Object} telegramLocation - Telegram location object
   * @returns {Object|null} Anomaly object or null
   */
  detectMockGPS(telegramLocation) {
    // Telegram doesn't expose mock location flag directly
    // This would need to be implemented if Telegram adds this feature
    // For now, we'll rely on other detection methods
    return null;
  }

  /**
   * Detect low GPS accuracy (only flag if user is also moving)
   * @param {number} accuracy - Horizontal accuracy in meters
   * @param {Object} prevLocation - Previous location (optional)
   * @param {Object} currLocation - Current location (optional)
   * @returns {Object|null} Anomaly object or null
   */
  detectLowAccuracy(accuracy, prevLocation = null, currLocation = null) {
    if (!accuracy) {
      return null;
    }

    const maxAccuracy = Config.MAX_ACCURACY_METERS || 50;

    if (accuracy > maxAccuracy) {
      // If we have location history, check if user is actually moving
      if (prevLocation && currLocation) {
        const distance = geofenceService.calculateDistance(
          prevLocation.latitude,
          prevLocation.longitude,
          currLocation.latitude,
          currLocation.longitude
        );

        // If user is stationary (within 50m), poor accuracy is acceptable (GPS drift)
        // Only flag if user is moving significantly (> 50m) with poor accuracy
        const STATIONARY_THRESHOLD = 50; // meters
        if (distance <= STATIONARY_THRESHOLD) {
          // User is stationary, poor accuracy is normal for indoor GPS
          return null;
        }
      }

      return {
        type: ANOMALY_TYPES.LOW_ACCURACY,
        description: `GPS accuracy is ${Math.round(accuracy)}m (threshold: ${maxAccuracy}m) while moving`,
        severity: 'MEDIUM',
        data: {
          accuracy: accuracy,
          threshold: maxAccuracy
        }
      };
    }

    return null;
  }

  /**
   * Detect if location updates stopped (only flag if insufficient data)
   * @param {number} lastUpdateTime - Timestamp of last update
   * @param {number} trackingStartTime - Timestamp when tracking started
   * @param {number} updateCount - Number of updates received
   * @returns {Object|null} Anomaly object or null
   */
  detectStoppedSending(lastUpdateTime, trackingStartTime, updateCount = 0) {
    const now = Date.now();
    const timeSinceLastUpdate = (now - lastUpdateTime) / 1000; // seconds
    const totalTrackingTime = (now - trackingStartTime) / 1000; // seconds
    const requiredDuration = (Config.TRACKING_DURATION_MINUTES || 5) * 60; // seconds
    const minUpdates = Config.MIN_UPDATES_FOR_VERIFICATION || 3;

    // Check if stopped sending before required duration
    // Allow 60 second timeout for updates
    const updateTimeout = Config.UPDATE_TIMEOUT_SECONDS || 60;

    // Only flag as problem if we have insufficient data
    // If we have enough updates (3+), it's OK that they switched apps
    if (totalTrackingTime < requiredDuration && timeSinceLastUpdate > updateTimeout) {
      if (updateCount >= minUpdates) {
        // Have enough data - stopping is acceptable (user likely switched apps)
        return {
          type: ANOMALY_TYPES.STOPPED_SENDING,
          description: `Location updates stopped after ${Math.round(totalTrackingTime)}s, but sufficient data collected (${updateCount} updates)`,
          severity: 'LOW',
          data: {
            timeSinceLastUpdate: timeSinceLastUpdate,
            totalTrackingTime: totalTrackingTime,
            requiredDuration: requiredDuration,
            updateCount: updateCount
          }
        };
      } else {
        // Insufficient data - this is a problem
        return {
          type: ANOMALY_TYPES.STOPPED_SENDING,
          description: `Location updates stopped after ${Math.round(totalTrackingTime)}s with only ${updateCount} updates (minimum: ${minUpdates})`,
          severity: 'HIGH',
          data: {
            timeSinceLastUpdate: timeSinceLastUpdate,
            totalTrackingTime: totalTrackingTime,
            requiredDuration: requiredDuration,
            updateCount: updateCount
          }
        };
      }
    }

    return null;
  }

  /**
   * Detect impossible speed (user in vehicle)
   * @param {Object} prevLocation - Previous location
   * @param {Object} currLocation - Current location
   * @returns {Object|null} Anomaly object or null
   */
  detectImpossibleSpeed(prevLocation, currLocation) {
    if (!prevLocation || !currLocation) {
      return null;
    }

    // Calculate time difference
    const timeDiff = (currLocation.timestamp - prevLocation.timestamp) / 1000; // seconds

    // Ignore if updates are too close together (< 3 seconds)
    // Rapid updates in same second cause false positives
    if (timeDiff < 3) {
      return null;
    }

    // Calculate distance and speed
    const distance = geofenceService.calculateDistance(
      prevLocation.latitude,
      prevLocation.longitude,
      currLocation.latitude,
      currLocation.longitude
    );
    const speed = geofenceService.calculateSpeed(prevLocation, currLocation);
    const maxSpeed = Config.MAX_SPEED_KMH || 100;

    // Only flag if speed is exceeded AND distance is significant
    // This prevents false positives from GPS drift/jumps within the office area
    if (speed > maxSpeed) {
      // Check if both locations are within or near the geofence
      const prevDistanceFromOffice = geofenceService.calculateDistance(
        prevLocation.latitude,
        prevLocation.longitude,
        Config.OFFICE_LATITUDE,
        Config.OFFICE_LONGITUDE
      );
      const currDistanceFromOffice = geofenceService.calculateDistance(
        currLocation.latitude,
        currLocation.longitude,
        Config.OFFICE_LATITUDE,
        Config.OFFICE_LONGITUDE
      );

      const geofenceRadius = Config.GEOFENCE_RADIUS_METERS || 700;
      const allowedRadius = geofenceRadius + 300; // Allow 300m margin for GPS inaccuracy

      // If BOTH locations are within the allowed area, treat as GPS drift, not fraud
      const bothNearOffice = prevDistanceFromOffice <= allowedRadius &&
                            currDistanceFromOffice <= allowedRadius;

      if (bothNearOffice && distance < 1000) {
        // GPS jump within office area - likely GPS drift, not fraud
        logger.debug(`⚠️ GPS drift detected: ${Math.round(distance)}m jump, but both locations near office - treating as normal`);
        return null;
      }

      // Otherwise, this is suspicious (either moving away from office or very large jump)
      return {
        type: ANOMALY_TYPES.IMPOSSIBLE_SPEED,
        description: `Movement speed is ${speed.toFixed(1)} km/h (threshold: ${maxSpeed} km/h)`,
        severity: 'HIGH',
        data: {
          speed: speed,
          threshold: maxSpeed,
          distance: distance,
          from: { lat: prevLocation.latitude, lng: prevLocation.longitude },
          to: { lat: currLocation.latitude, lng: currLocation.longitude }
        }
      };
    }

    return null;
  }

  /**
   * Check if initial check-in location is valid
   * @param {Object} location - Initial location with accuracy
   * @returns {Object|null} Anomaly object or null
   */
  detectWrongLocation(location) {
    if (!location) {
      return null;
    }

    const result = geofenceService.checkOfficeGeofence(location);

    // IMPORTANT: Account for GPS accuracy during initial check-in
    // Be lenient with poor GPS accuracy - only reject if CLEARLY outside
    const accuracy = location.accuracy || 0;
    const geofenceRadius = Config.GEOFENCE_RADIUS_METERS || 200;
    const confidenceMargin = geofenceRadius + accuracy;

    logger.debug(`📍 Geofence check: distance=${Math.round(result.distance)}m, limit=${geofenceRadius}m, accuracy=${Math.round(accuracy)}m, margin=${Math.round(confidenceMargin)}m`);

    if (!result.isInside && result.distance > confidenceMargin) {
      logger.warn(`❌ Location REJECTED: ${Math.round(result.distance)}m from office (limit with accuracy: ${Math.round(confidenceMargin)}m)`);

      return {
        type: ANOMALY_TYPES.WRONG_LOCATION,
        description: `Check-in location is ${geofenceService.formatDistance(result.distance)} from office (accuracy: ${Math.round(accuracy)}m)`,
        severity: 'CRITICAL',
        data: {
          distance: result.distance,
          accuracy: accuracy,
          confidenceMargin: confidenceMargin,
          location: { lat: location.latitude, lng: location.longitude }
        }
      };
    }

    logger.debug(`✅ Location ACCEPTED: ${Math.round(result.distance)}m from office (within margin: ${Math.round(confidenceMargin)}m)`);
    return null;
  }

  /**
   * Analyze a complete tracking session
   * @param {Object} session - Tracking session object
   * @returns {Object} Analysis result
   */
  analyzeSession(session) {
    const anomalies = [];
    const locationHistory = session.locationHistory || [];

    // Check each location update
    for (let i = 0; i < locationHistory.length; i++) {
      const currLocation = locationHistory[i];
      const prevLocation = i > 0 ? locationHistory[i - 1] : null;

      // Check for sudden jump
      if (prevLocation) {
        const jumpAnomaly = this.detectSuddenJump(prevLocation, currLocation);
        if (jumpAnomaly) {
          anomalies.push(jumpAnomaly);
        }

        // Check for impossible speed
        const speedAnomaly = this.detectImpossibleSpeed(prevLocation, currLocation);
        if (speedAnomaly) {
          anomalies.push(speedAnomaly);
        }
      }

      // Check if left geofence
      const geofenceAnomaly = this.detectLeftGeofence(currLocation);
      if (geofenceAnomaly) {
        anomalies.push(geofenceAnomaly);
      }

      // Check accuracy (only flag if user is also moving)
      if (currLocation.accuracy) {
        const accuracyAnomaly = this.detectLowAccuracy(
          currLocation.accuracy,
          prevLocation,
          currLocation
        );
        if (accuracyAnomaly) {
          anomalies.push(accuracyAnomaly);
        }
      }
    }

    // Check if stopped sending
    if (locationHistory.length > 0) {
      const lastLocation = locationHistory[locationHistory.length - 1];
      const stoppedAnomaly = this.detectStoppedSending(
        lastLocation.timestamp,
        session.startTime,
        session.updateCount || locationHistory.length
      );
      if (stoppedAnomaly) {
        anomalies.push(stoppedAnomaly);
      }
    }

    // Determine overall severity
    let overallSeverity = 'NONE';
    let hasCritical = false;
    let hasHigh = false;

    for (const anomaly of anomalies) {
      if (anomaly.severity === 'CRITICAL') {
        hasCritical = true;
      } else if (anomaly.severity === 'HIGH') {
        hasHigh = true;
      }
    }

    if (hasCritical) {
      overallSeverity = 'CRITICAL';
    } else if (hasHigh) {
      overallSeverity = 'HIGH';
    } else if (anomalies.length > 0) {
      overallSeverity = 'MEDIUM';
    }

    return {
      hasAnomaly: anomalies.length > 0,
      anomalyCount: anomalies.length,
      anomalies: anomalies,
      severity: overallSeverity,
      summary: this.generateAnomalySummary(anomalies)
    };
  }

  /**
   * Generate human-readable summary of anomalies
   * @param {Array} anomalies - List of anomalies
   * @returns {string} Summary text
   */
  generateAnomalySummary(anomalies) {
    if (anomalies.length === 0) {
      return 'No anomalies detected';
    }

    const types = [...new Set(anomalies.map(a => a.type))];
    const descriptions = types.map(type => ANOMALY_DESCRIPTIONS[type] || type);

    return descriptions.join('; ');
  }

  /**
   * Format anomaly for user message
   * @param {Object} analysis - Analysis result
   * @returns {string} Formatted message
   */
  formatAnomalyMessage(analysis) {
    if (!analysis.hasAnomaly) {
      return '';
    }

    let message = '⚠️ Attendance verification issue detected:\n\n';

    // Group anomalies by type
    const groupedAnomalies = {};
    for (const anomaly of analysis.anomalies) {
      if (!groupedAnomalies[anomaly.type]) {
        groupedAnomalies[anomaly.type] = [];
      }
      groupedAnomalies[anomaly.type].push(anomaly);
    }

    // Format each type
    for (const [type, anomalies] of Object.entries(groupedAnomalies)) {
      message += `• ${ANOMALY_DESCRIPTIONS[type]}\n`;
      if (anomalies.length > 1) {
        message += `  (Detected ${anomalies.length} times)\n`;
      }
    }

    message += '\nYour manager has been notified.';

    return message;
  }
}

// Export singleton instance
const anomalyDetectorService = new AnomalyDetectorService();
module.exports = anomalyDetectorService;
module.exports.ANOMALY_TYPES = ANOMALY_TYPES;
