/**
 * Backward Compatibility Redirect
 *
 * This file maintains backward compatibility with the old scheduler.service.js location.
 * All functionality has been moved to src/services/scheduling/
 *
 * Structure:
 * - src/services/scheduling/index.js           (main entry - exports singleton)
 * - src/services/scheduling/scheduler.service.js (core scheduler)
 * - src/services/scheduling/jobs/               (individual job modules)
 *
 * This redirect ensures that existing imports continue to work:
 * - require('./services/scheduler.service')
 * - require('../services/scheduler.service')
 * - etc.
 */

module.exports = require('./scheduling');
