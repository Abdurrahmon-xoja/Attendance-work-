/**
 * Scheduler Service - Main Entry Point
 * Exports singleton instance for backward compatibility
 */

const SchedulerService = require('./scheduler.service');

// Create and export singleton instance
const schedulerService = new SchedulerService();

module.exports = schedulerService;
