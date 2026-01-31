/**
 * Models barrel export
 * Provides a single entry point for all data models
 */

const User = require('./User');
const AttendanceRecord = require('./AttendanceRecord');
const WorkSession = require('./WorkSession');

module.exports = {
  User,
  AttendanceRecord,
  WorkSession
};
