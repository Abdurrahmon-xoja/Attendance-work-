/**
 * Constants barrel export
 * Provides a single entry point for all constants
 */

const penalties = require('./penalties');
const timings = require('./timings');
const location = require('./location');
const messages = require('./messages');
const sheets = require('./sheets');

module.exports = {
  penalties,
  timings,
  location,
  messages,
  sheets,

  // Re-export commonly used constants for convenience
  PENALTIES: penalties,
  TIMINGS: timings,
  LOCATION: location,
  MESSAGES: messages,
  SHEETS: sheets
};
