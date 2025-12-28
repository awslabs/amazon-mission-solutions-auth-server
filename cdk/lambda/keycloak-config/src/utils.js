/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Utility functions for Keycloak configuration */

/** Pause execution for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} initialDelay - Starting delay (ms)
 * @param {number} maxDelay - Maximum delay (ms)
 * @param {Function} shouldRetry - Determines if retry should be attempted
 * @returns {Promise<any>}
 */
async function retry(
  fn,
  maxRetries = 5,
  initialDelay = 1000,
  maxDelay = 60000,
  shouldRetry = () => true,
) {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries += 1;

      if (retries > maxRetries || !shouldRetry(error)) {
        console.error(`Retry failed after ${retries} attempts:`, error);
        throw error;
      }

      console.log(`Retry attempt ${retries}/${maxRetries} after ${delay}ms`);

      await sleep(delay);

      // Exponential backoff with a random factor
      delay = Math.min(maxDelay, delay * 1.5 * (1 + Math.random() * 0.2));
    }
  }
}

/** Remove undefined values from object
 * @param {object} obj - Object to clean
 * @returns {object} - Cleaned object
 */
function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(entry => entry[1] !== undefined));
}

/** Format error with response details
 * @param {Error} error - Error object
 * @returns {string} - Formatted message
 */
function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    const data = error.response.data || {};
    const message = data.errorMessage || data.error || JSON.stringify(data);
    return `Status ${error.response.status}: ${message}`;
  } else if (error.request) {
    // The request was made but no response was received
    return `No response received: ${error.message}`;
  } else {
    // Something happened in setting up the request that triggered an Error
    return `Request error: ${error.message}`;
  }
}

/** Get Keycloak health check URL
 * @param {string} baseUrl - Keycloak server URL
 * @returns {string} - Health check endpoint
 */
function getHealthCheckUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/`;
}

/** Get Keycloak admin API URL
 * @param {string} baseUrl - Keycloak server URL
 * @returns {string} - Admin API endpoint
 */
function getAdminApiUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/admin`;
}

/** Create configured HTTPS agent for SSL
 * @returns {object|null} - HTTPS agent or null for HTTP
 */
function createHttpsAgent() {
  const config = require('./config');

  // Only create HTTPS agent for HTTPS URLs
  if (!config.KEYCLOAK_URL.startsWith('https://')) {
    return null;
  }

  const https = require('https');

  // In a production environment, we want proper SSL validation
  // The hostname should match the certificate
  return new https.Agent({
    // Keep connections alive for better performance
    keepAlive: true,
    // Don't reject unauthorized certificates during development/startup
    // In production, this should be true for security
    rejectUnauthorized: true,
  });
}

/** Make authenticated HTTP request
 * @param {string} method - HTTP method (get, post, put, delete)
 * @param {string} url - Request URL
 * @param {object} data - Request body data
 * @param {string} accessToken - Authorization token
 * @returns {Promise<object>} - Response
 */
async function makeAuthenticatedRequest(method, url, data, accessToken) {
  const axios = require('axios');
  const config = require('./config');

  const requestConfig = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: config.API_TIMEOUT_MS,
    validateStatus: status => status < 500, // Don't throw for 4xx errors
    httpsAgent: createHttpsAgent(),
  };

  if (data && (method === 'post' || method === 'put')) {
    requestConfig.data = data;
  }

  try {
    const response = await axios(requestConfig);
    return response;
  } catch (error) {
    console.error(`HTTP request failed: ${method.toUpperCase()} ${url}`, formatError(error));
    throw error;
  }
}

module.exports = {
  sleep,
  retry,
  cleanObject,
  formatError,
  getHealthCheckUrl,
  getAdminApiUrl,
  createHttpsAgent,
  makeAuthenticatedRequest,
};
