/**
 * Geofence Service
 * Handles geographic calculations for location verification
 */

const Config = require('../config');
const logger = require('../utils/logger');

class GeofenceService {
  /**
   * Calculate distance between two coordinates using Haversine formula
   * @param {number} lat1 - First latitude
   * @param {number} lng1 - First longitude
   * @param {number} lat2 - Second latitude
   * @param {number} lng2 - Second longitude
   * @returns {number} Distance in meters
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const distance = R * c;
    return Math.round(distance * 10) / 10; // Round to 1 decimal place
  }

  /**
   * Check if a location is within a geofence radius
   * @param {Object} location - Location to check { latitude, longitude }
   * @param {Object} center - Center of geofence { latitude, longitude }
   * @param {number} radiusMeters - Radius in meters
   * @returns {boolean} True if within geofence
   */
  isWithinGeofence(location, center, radiusMeters) {
    const distance = this.calculateDistance(
      location.latitude,
      location.longitude,
      center.latitude,
      center.longitude
    );
    return distance <= radiusMeters;
  }

  /**
   * Calculate speed between two locations
   * @param {Object} loc1 - First location { latitude, longitude, timestamp }
   * @param {Object} loc2 - Second location { latitude, longitude, timestamp }
   * @returns {number} Speed in km/h
   */
  calculateSpeed(loc1, loc2) {
    // Calculate distance in meters
    const distance = this.calculateDistance(
      loc1.latitude,
      loc1.longitude,
      loc2.latitude,
      loc2.longitude
    );

    // Calculate time difference in seconds
    const timeDiff = (loc2.timestamp - loc1.timestamp) / 1000;

    if (timeDiff <= 0) {
      return 0;
    }

    // Calculate speed: distance (m) / time (s) = m/s → convert to km/h
    const speedMps = distance / timeDiff;
    const speedKmh = speedMps * 3.6;

    return Math.round(speedKmh * 10) / 10; // Round to 1 decimal place
  }

  /**
   * Get office location from configuration
   * @returns {Object} Office location { latitude, longitude }
   */
  getOfficeLocation() {
    return {
      latitude: Config.OFFICE_LATITUDE,
      longitude: Config.OFFICE_LONGITUDE
    };
  }

  /**
   * Get geofence radius from configuration
   * @returns {number} Radius in meters
   */
  getGeofenceRadius() {
    return Config.GEOFENCE_RADIUS_METERS;
  }

  /**
   * Check if location is within office geofence
   * @param {Object} location - Location to check { latitude, longitude }
   * @returns {Object} { isInside: boolean, distance: number }
   */
  checkOfficeGeofence(location) {
    const officeLocation = this.getOfficeLocation();
    const radius = this.getGeofenceRadius();

    const distance = this.calculateDistance(
      location.latitude,
      location.longitude,
      officeLocation.latitude,
      officeLocation.longitude
    );

    return {
      isInside: distance <= radius,
      distance: distance
    };
  }

  /**
   * Format distance for display
   * @param {number} meters - Distance in meters
   * @returns {string} Formatted distance
   */
  formatDistance(meters) {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(1)}km`;
  }

  /**
   * Validate location coordinates
   * @param {Object} location - Location object
   * @returns {boolean} True if valid
   */
  isValidLocation(location) {
    if (!location || typeof location !== 'object') {
      return false;
    }

    const { latitude, longitude } = location;

    // Check if coordinates exist and are numbers
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return false;
    }

    // Check if coordinates are within valid ranges
    if (latitude < -90 || latitude > 90) {
      return false;
    }

    if (longitude < -180 || longitude > 180) {
      return false;
    }

    return true;
  }
}

// Create and export singleton instance
const geofenceService = new GeofenceService();
module.exports = geofenceService;
