/**
 * Location and geofencing constants
 * GPS coordinates, accuracy thresholds, and anomaly detection parameters
 */

module.exports = {
  // Office Location (Default: Tashkent)
  OFFICE: {
    LATITUDE: 41.302799,
    LONGITUDE: 69.314780,
    NAME: 'Office'
  },

  // Geofencing
  GEOFENCE_RADIUS_METERS: 200,          // Office geofence radius (200m)
  MAX_ACCURACY_METERS: 50,              // Maximum acceptable GPS accuracy (50m)

  // Anomaly Detection Thresholds
  MAX_JUMP_DISTANCE_METERS: 500,        // Maximum distance between updates (500m)
  MAX_SPEED_KMH: 100,                   // Maximum reasonable speed (100 km/h)
  MAX_SPEED_MPS: 27.78,                 // Maximum speed in m/s (100 km/h = 27.78 m/s)

  // Anomaly Types
  ANOMALY_TYPES: {
    LOCATION_MISMATCH: 'LOCATION_MISMATCH',     // Outside geofence
    IMPOSSIBLE_SPEED: 'IMPOSSIBLE_SPEED',       // Moved too fast
    POOR_ACCURACY: 'POOR_ACCURACY',             // GPS accuracy too low
    SUSPICIOUS_JUMP: 'SUSPICIOUS_JUMP',         // Sudden large movement
    TIMEOUT: 'TIMEOUT',                         // Location update timeout
    MULTIPLE_LOCATIONS: 'MULTIPLE_LOCATIONS'    // Multiple inconsistent locations
  },

  // Anomaly Severity Levels
  SEVERITY: {
    CRITICAL: 'CRITICAL',   // Block action
    WARNING: 'WARNING',     // Allow but log
    INFO: 'INFO'           // Informational only
  },

  // Location Source Types
  LOCATION_SOURCE: {
    CHECK_IN: 'CHECK_IN',
    CHECK_OUT: 'CHECK_OUT',
    LIVE_UPDATE: 'LIVE_UPDATE',
    MANUAL: 'MANUAL'
  },

  // Distance Calculation Method
  EARTH_RADIUS_METERS: 6371000,         // Earth radius for Haversine formula

  // Coordinate Precision (for rounding/display)
  COORDINATE_PRECISION: 6,              // Decimal places for lat/lng

  // Location Request Messages
  LOCATION_MESSAGES: {
    REQUEST_CHECK_IN: '📍 Пожалуйста, отправьте вашу геолокацию для регистрации прихода.',
    REQUEST_CHECK_OUT: '📍 Пожалуйста, отправьте вашу геолокацию для регистрации ухода.',
    OUTSIDE_GEOFENCE: '❌ Вы находитесь вне офисной зоны. Регистрация невозможна.',
    POOR_ACCURACY: '⚠️ Точность GPS слишком низкая. Попробуйте еще раз.',
    TIMEOUT: '⏱️ Время ожидания геолокации истекло.'
  }
};
