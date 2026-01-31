/**
 * Quota Handler for Google Sheets Service
 * Handles retry logic with exponential backoff for quota errors
 */

const logger = require('../../utils/logger');

class QuotaHandler {
  /**
   * Retry operation with exponential backoff for quota errors
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} initialDelay - Initial delay in ms
   * @returns {Promise} Result of operation
   */
  static async retryOperation(operation, maxRetries = 3, initialDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if it's a quota error (429)
        const isQuotaError = error.message && (
          error.message.includes('429') ||
          error.message.includes('Quota exceeded') ||
          error.message.includes('quota metric')
        );

        // Only retry on quota errors
        if (!isQuotaError || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = initialDelay * Math.pow(2, attempt);
        logger.warn(`Quota error detected, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Check if an error is a quota error
   * @param {Error} error - Error to check
   * @returns {boolean} True if quota error
   */
  static isQuotaError(error) {
    return error.message && (
      error.message.includes('429') ||
      error.message.includes('Quota exceeded') ||
      error.message.includes('quota metric')
    );
  }

  /**
   * Create a quota error object
   * @param {Error} originalError - Original error
   * @returns {Error} Quota error object
   */
  static createQuotaError(originalError) {
    const quotaError = new Error('QUOTA_EXCEEDED');
    quotaError.isQuotaError = true;
    quotaError.originalError = originalError;
    return quotaError;
  }
}

module.exports = QuotaHandler;
