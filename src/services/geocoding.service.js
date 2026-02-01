/**
 * Geocoding Service
 * Reverse geocodes coordinates to human-readable addresses via OpenStreetMap Nominatim API.
 * Uses Node.js built-in fetch (no external dependencies).
 */

const logger = require('../utils/logger');

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'AttendanceBot/1.0 (Telegram attendance tracking)';
const REQUEST_TIMEOUT_MS = 15000;
const MIN_REQUEST_INTERVAL_MS = 1100; // Nominatim policy: max 1 req/sec

let lastRequestTime = 0;

/**
 * Wait to respect Nominatim rate limit (1 request per second)
 */
async function respectRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const waitMs = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();
}

/**
 * Format Nominatim address into a concise string
 * @param {Object} address - Nominatim address object
 * @returns {string} Formatted address
 */
function formatAddress(address) {
  if (!address) return null;

  const parts = [];

  // Road + house number
  const road = address.road || address.street || '';
  const houseNumber = address.house_number || '';
  if (road) {
    parts.push(houseNumber ? `${road} ${houseNumber}` : road);
  }

  // Neighbourhood / suburb
  const neighbourhood = address.neighbourhood || address.suburb || address.district || '';
  if (neighbourhood) {
    parts.push(neighbourhood);
  }

  // City
  const city = address.city || address.town || address.village || address.hamlet || '';
  if (city) {
    parts.push(city);
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Single attempt to reverse geocode via Nominatim
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string|null>} Address string or null on failure
 */
async function attemptReverseGeocode(lat, lng) {
  await respectRateLimit();

  const url = `${NOMINATIM_BASE_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=ru`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    },
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!response.ok) {
    logger.warn(`Nominatim returned ${response.status} for ${lat},${lng}`);
    return null;
  }

  const data = await response.json();

  if (data.error) {
    logger.warn(`Nominatim error: ${data.error}`);
    return null;
  }

  const formatted = formatAddress(data.address);
  if (formatted) {
    logger.info(`Geocoded ${lat},${lng} → ${formatted}`);
    return formatted;
  }

  // Fallback to display_name if our formatting produced nothing
  if (data.display_name) {
    return data.display_name;
  }

  return null;
}

/**
 * Reverse geocode coordinates to a human-readable address (with 1 retry)
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string>} Address string, or raw coordinates on failure
 */
async function reverseGeocode(lat, lng) {
  const fallback = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptReverseGeocode(lat, lng);
      if (result) return result;
      // null result means API responded but no useful data — no point retrying
      return fallback;
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.warn(`Geocoding timeout for ${lat},${lng} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      } else {
        logger.error(`Geocoding error for ${lat},${lng} (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
      }
      if (attempt === MAX_ATTEMPTS) {
        return fallback;
      }
      // Brief pause before retry
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return fallback;
}

module.exports = {
  reverseGeocode
};
