/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Configuration settings for Keycloak Lambda */

/** Get environment variable with validation */
function getEnvVar(name, defaultValue = null, required = false) {
  const value = process.env[name] || defaultValue;

  if (required && (value === null || value === undefined)) {
    throw new Error(`Required environment variable ${name} is not set`);
  }

  return value;
}

// Configuration from environment variables
const config = {
  KEYCLOAK_URL: getEnvVar('KEYCLOAK_URL', null, true),
  KEYCLOAK_ADMIN_USERNAME: getEnvVar('KEYCLOAK_ADMIN_USERNAME', 'keycloak'),
  KEYCLOAK_ADMIN_SECRET_ARN: getEnvVar('KEYCLOAK_ADMIN_SECRET_ARN', null, true),
  WEBSITE_URI: getEnvVar('WEBSITE_URI', '*'),
  AUTH_CONFIG: getEnvVar('AUTH_CONFIG', '{}'),
  USER_PASSWORD_SECRETS: getEnvVar('USER_PASSWORD_SECRETS', '{}'),
  API_TIMEOUT_MS: parseInt(getEnvVar('API_TIMEOUT_MS', '30000'), 10),

  // Health check settings optimized for post-deployment readiness
  HEALTH_CHECK_MAX_ATTEMPTS: parseInt(getEnvVar('HEALTH_CHECK_MAX_ATTEMPTS', '30'), 10),
  HEALTH_CHECK_INTERVAL_MS: parseInt(getEnvVar('HEALTH_CHECK_INTERVAL_MS', '20000'), 10),

  API_MAX_RETRIES: parseInt(getEnvVar('API_MAX_RETRIES', '10'), 10),
  API_RETRY_INTERVAL_MS: parseInt(getEnvVar('API_RETRY_INTERVAL_MS', '20000'), 10),
};

/** Parse auth config from environment variable */
function getAuthConfig() {
  if (!config.AUTH_CONFIG || config.AUTH_CONFIG === '{}') {
    console.log('No custom authentication configuration provided. Using default configuration.');
    return null;
  }

  try {
    return JSON.parse(config.AUTH_CONFIG);
  } catch (error) {
    console.error('Error parsing authentication configuration:', error);
    throw new Error(`Invalid authentication configuration: ${error.message}`);
  }
}

/** Parse user password secrets from environment variable */
function getUserPasswordSecrets() {
  if (!config.USER_PASSWORD_SECRETS || config.USER_PASSWORD_SECRETS === '{}') {
    console.log('No user password secrets provided.');
    return {};
  }

  try {
    return JSON.parse(config.USER_PASSWORD_SECRETS);
  } catch (error) {
    console.error('Error parsing user password secrets:', error);
    throw new Error(`Invalid user password secrets: ${error.message}`);
  }
}

module.exports = {
  ...config,
  getAuthConfig,
  getUserPasswordSecrets,
};
