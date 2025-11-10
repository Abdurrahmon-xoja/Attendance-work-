/**
 * Location Tracker Service
 * Manages active location tracking sessions in memory
 */

const anomalyDetectorService = require('./anomalyDetector.service');
const geofenceService = require('./geofence.service');
const Config = require('../config');
const logger = require('../utils/logger');

class LocationTrackerService {
  constructor() {
    // In-memory store for active tracking sessions
    // Map<userId, SessionData>
    this.trackingSessions = new Map();

    // Maximum number of concurrent sessions
    this.MAX_SESSIONS = 500;

    // Maximum location points per session
    this.MAX_LOCATION_POINTS = 60;

    // Start cleanup interval (runs every minute)
    this.startCleanupInterval();
  }

  /**
   * Start a new tracking session
   * @param {number} userId - User's Telegram ID
   * @param {Object} initialLocation - Initial location { latitude, longitude, accuracy }
   * @param {string} userName - User's full name
   * @returns {Object} Session object or error
   */
  startTracking(userId, initialLocation, userName = '') {
    try {
      // Check if user already has an active session
      if (this.trackingSessions.has(userId)) {
        const existingSession = this.trackingSessions.get(userId);
        if (existingSession.isActive) {
          return {
            success: false,
            error: 'ALREADY_TRACKING',
            message: 'User already has an active tracking session'
          };
        }
      }

      // Check if we're at capacity
      if (this.trackingSessions.size >= this.MAX_SESSIONS) {
        logger.warn(`⚠️ Location tracker at capacity: ${this.trackingSessions.size} sessions`);
        // Remove oldest inactive session
        this.removeOldestInactiveSession();
      }

      // Validate initial location
      if (!geofenceService.isValidLocation(initialLocation)) {
        return {
          success: false,
          error: 'INVALID_LOCATION',
          message: 'Invalid location coordinates'
        };
      }

      // Check if initial location is within office geofence
      const initialAnomaly = anomalyDetectorService.detectWrongLocation(initialLocation);

      // Create session
      const session = {
        userId: userId,
        userName: userName,
        startTime: Date.now(),
        lastUpdateTime: Date.now(),
        isActive: true,
        initialLocation: {
          latitude: initialLocation.latitude,
          longitude: initialLocation.longitude,
          accuracy: initialLocation.accuracy || null,
          timestamp: Date.now()
        },
        locationHistory: [
          {
            latitude: initialLocation.latitude,
            longitude: initialLocation.longitude,
            accuracy: initialLocation.accuracy || null,
            timestamp: Date.now()
          }
        ],
        anomalies: initialAnomaly ? [initialAnomaly] : [],
        updateCount: 1,
        finalVerdict: null
      };

      this.trackingSessions.set(userId, session);

      logger.info(`📍 Started location tracking for ${userName} (${userId})`);
      logger.info(`   Initial location: ${initialLocation.latitude.toFixed(6)}, ${initialLocation.longitude.toFixed(6)}`);
      logger.info(`   Accuracy: ${initialLocation.accuracy ? initialLocation.accuracy.toFixed(1) + 'm' : 'unknown'}`);

      if (initialAnomaly) {
        logger.warn(`   ⚠️ Initial anomaly: ${initialAnomaly.type}`);
      }

      return {
        success: true,
        session: session,
        hasInitialAnomaly: !!initialAnomaly,
        initialAnomaly: initialAnomaly
      };

    } catch (error) {
      logger.error(`Error starting tracking session: ${error.message}`);
      return {
        success: false,
        error: 'INTERNAL_ERROR',
        message: error.message
      };
    }
  }

  /**
   * Add a location update to an active session
   * @param {number} userId - User's Telegram ID
   * @param {Object} location - Location { latitude, longitude, accuracy }
   * @returns {Object} Result with anomaly detection
   */
  addLocationUpdate(userId, location) {
    try {
      const session = this.trackingSessions.get(userId);

      if (!session) {
        return {
          success: false,
          error: 'NO_SESSION',
          message: 'No active tracking session found'
        };
      }

      if (!session.isActive) {
        return {
          success: false,
          error: 'SESSION_INACTIVE',
          message: 'Tracking session is no longer active'
        };
      }

      // Validate location
      if (!geofenceService.isValidLocation(location)) {
        logger.warn(`Invalid location update for user ${userId}`);
        return {
          success: false,
          error: 'INVALID_LOCATION',
          message: 'Invalid location coordinates'
        };
      }

      // Create location point
      const locationPoint = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy || null,
        timestamp: Date.now()
      };

      // Add to history (limit size)
      session.locationHistory.push(locationPoint);
      if (session.locationHistory.length > this.MAX_LOCATION_POINTS) {
        session.locationHistory.shift(); // Remove oldest
      }

      session.lastUpdateTime = Date.now();
      session.updateCount++;

      // Get previous location for anomaly detection
      const prevLocation = session.locationHistory.length > 1
        ? session.locationHistory[session.locationHistory.length - 2]
        : null;

      // Detect anomalies in this update
      const newAnomalies = [];

      // Check for sudden jump
      if (prevLocation) {
        const jumpAnomaly = anomalyDetectorService.detectSuddenJump(prevLocation, locationPoint);
        if (jumpAnomaly) {
          newAnomalies.push(jumpAnomaly);
        }

        // Check for impossible speed
        const speedAnomaly = anomalyDetectorService.detectImpossibleSpeed(prevLocation, locationPoint);
        if (speedAnomaly) {
          newAnomalies.push(speedAnomaly);
        }
      }

      // Check if left geofence
      const geofenceAnomaly = anomalyDetectorService.detectLeftGeofence(locationPoint);
      if (geofenceAnomaly) {
        newAnomalies.push(geofenceAnomaly);
      }

      // Check accuracy (only flag if user is also moving)
      if (location.accuracy) {
        const accuracyAnomaly = anomalyDetectorService.detectLowAccuracy(
          location.accuracy,
          prevLocation,
          locationPoint
        );
        if (accuracyAnomaly) {
          newAnomalies.push(accuracyAnomaly);
        }
      }

      // Add new anomalies to session
      if (newAnomalies.length > 0) {
        session.anomalies.push(...newAnomalies);
        logger.warn(`⚠️ Anomalies detected for user ${userId}: ${newAnomalies.map(a => a.type).join(', ')}`);
      }

      // Check if tracking duration completed
      const trackingDuration = (Date.now() - session.startTime) / 1000; // seconds
      const requiredDuration = (Config.TRACKING_DURATION_MINUTES || 5) * 60; // seconds

      const shouldStopTracking = trackingDuration >= requiredDuration;

      return {
        success: true,
        newAnomalies: newAnomalies,
        hasAnomalies: newAnomalies.length > 0,
        totalAnomalies: session.anomalies.length,
        shouldStopTracking: shouldStopTracking,
        trackingProgress: Math.min(100, (trackingDuration / requiredDuration) * 100)
      };

    } catch (error) {
      logger.error(`Error adding location update: ${error.message}`);
      return {
        success: false,
        error: 'INTERNAL_ERROR',
        message: error.message
      };
    }
  }

  /**
   * Stop tracking and finalize session
   * @param {number} userId - User's Telegram ID
   * @param {string} reason - Reason for stopping (COMPLETED, ANOMALY, TIMEOUT)
   * @returns {Object} Final analysis
   */
  stopTracking(userId, reason = 'COMPLETED') {
    try {
      const session = this.trackingSessions.get(userId);

      if (!session) {
        return {
          success: false,
          error: 'NO_SESSION',
          message: 'No tracking session found'
        };
      }

      // Mark as inactive
      session.isActive = false;

      // Perform final analysis
      const analysis = anomalyDetectorService.analyzeSession(session);

      // Store final verdict
      session.finalVerdict = {
        timestamp: Date.now(),
        reason: reason,
        analysis: analysis,
        duration: (Date.now() - session.startTime) / 1000, // seconds
        updateCount: session.updateCount,
        verificationStatus: analysis.hasAnomaly ? 'FLAGGED' : 'OK'
      };

      logger.info(`🛑 Stopped tracking for user ${userId} (${session.userName})`);
      logger.info(`   Reason: ${reason}`);
      logger.info(`   Duration: ${session.finalVerdict.duration.toFixed(0)}s`);
      logger.info(`   Updates: ${session.updateCount}`);
      logger.info(`   Status: ${session.finalVerdict.verificationStatus}`);

      if (analysis.hasAnomaly) {
        logger.warn(`   ⚠️ Anomalies: ${analysis.anomalyCount} - ${analysis.summary}`);
      }

      return {
        success: true,
        session: session,
        analysis: analysis,
        verificationStatus: session.finalVerdict.verificationStatus
      };

    } catch (error) {
      logger.error(`Error stopping tracking: ${error.message}`);
      return {
        success: false,
        error: 'INTERNAL_ERROR',
        message: error.message
      };
    }
  }

  /**
   * Get active session for a user
   * @param {number} userId - User's Telegram ID
   * @returns {Object|null} Session or null
   */
  getSession(userId) {
    return this.trackingSessions.get(userId) || null;
  }

  /**
   * Check if user has an active tracking session
   * @param {number} userId - User's Telegram ID
   * @returns {boolean}
   */
  hasActiveSession(userId) {
    const session = this.trackingSessions.get(userId);
    return session && session.isActive;
  }

  /**
   * Get all active sessions
   * @returns {Array} List of active sessions
   */
  getAllActiveSessions() {
    const activeSessions = [];
    for (const [userId, session] of this.trackingSessions.entries()) {
      if (session.isActive) {
        activeSessions.push(session);
      }
    }
    return activeSessions;
  }

  /**
   * Get session statistics
   * @returns {Object} Statistics
   */
  getStatistics() {
    const allSessions = Array.from(this.trackingSessions.values());
    const activeSessions = allSessions.filter(s => s.isActive);

    return {
      totalSessions: this.trackingSessions.size,
      activeSessions: activeSessions.length,
      inactiveSessions: allSessions.length - activeSessions.length,
      maxSessions: this.MAX_SESSIONS,
      utilizationPercent: (this.trackingSessions.size / this.MAX_SESSIONS * 100).toFixed(1)
    };
  }

  /**
   * Clean up old sessions (auto-run periodically)
   */
  cleanupOldSessions() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    let cleanedCount = 0;

    for (const [userId, session] of this.trackingSessions.entries()) {
      const age = now - session.startTime;

      // Remove sessions older than 10 minutes
      if (age > maxAge) {
        this.trackingSessions.delete(userId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`🧹 Cleaned up ${cleanedCount} old tracking sessions`);
    }
  }

  /**
   * Remove oldest inactive session (for capacity management)
   */
  removeOldestInactiveSession() {
    let oldestSession = null;
    let oldestUserId = null;
    let oldestTime = Date.now();

    for (const [userId, session] of this.trackingSessions.entries()) {
      if (!session.isActive && session.startTime < oldestTime) {
        oldestTime = session.startTime;
        oldestSession = session;
        oldestUserId = userId;
      }
    }

    if (oldestUserId) {
      this.trackingSessions.delete(oldestUserId);
      logger.info(`Removed oldest inactive session for user ${oldestUserId} to make room`);
    }
  }

  /**
   * Start automatic cleanup interval
   */
  startCleanupInterval() {
    // Clean up old sessions every minute
    setInterval(() => {
      this.cleanupOldSessions();
    }, 60 * 1000); // 1 minute

    logger.info('📍 Location tracker cleanup interval started (runs every minute)');
  }

  /**
   * Check for sessions that stopped sending updates
   * This should be called periodically to detect STOPPED_SENDING anomaly
   * @returns {Array} List of user IDs with stopped sessions
   */
  checkForStoppedSessions() {
    const now = Date.now();
    const updateTimeout = (Config.UPDATE_TIMEOUT_SECONDS || 60) * 1000; // milliseconds
    const minUpdates = Config.MIN_UPDATES_FOR_VERIFICATION || 3;
    const stoppedSessions = [];

    for (const [userId, session] of this.trackingSessions.entries()) {
      if (!session.isActive) continue;

      const timeSinceLastUpdate = now - session.lastUpdateTime;
      const trackingDuration = now - session.startTime;
      const requiredDuration = (Config.TRACKING_DURATION_MINUTES || 5) * 60 * 1000; // milliseconds

      // If tracking is still ongoing but no updates received
      if (trackingDuration < requiredDuration && timeSinceLastUpdate > updateTimeout) {
        // Check if we have enough updates to consider verification successful
        const hasEnoughData = session.updateCount >= minUpdates;

        stoppedSessions.push({
          userId: userId,
          userName: session.userName,
          timeSinceLastUpdate: timeSinceLastUpdate / 1000, // seconds
          trackingDuration: trackingDuration / 1000, // seconds
          updateCount: session.updateCount,
          hasEnoughData: hasEnoughData
        });
      }
    }

    return stoppedSessions;
  }

  /**
   * Force stop all sessions for a user (for admin/cleanup)
   * @param {number} userId - User's Telegram ID
   */
  forceStopTracking(userId) {
    const session = this.trackingSessions.get(userId);
    if (session) {
      session.isActive = false;
      logger.info(`🛑 Force stopped tracking for user ${userId}`);
    }
  }

  /**
   * Clear all sessions (for testing/admin)
   */
  clearAllSessions() {
    const count = this.trackingSessions.size;
    this.trackingSessions.clear();
    logger.info(`🧹 Cleared all ${count} tracking sessions`);
  }
}

// Create and export singleton instance
const locationTrackerService = new LocationTrackerService();
module.exports = locationTrackerService;
