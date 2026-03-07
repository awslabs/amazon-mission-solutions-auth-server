/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Health check functions for Keycloak */
import axios from 'axios';

import config = require('./config');
import utils = require('./utils');

/** Basic health check for Keycloak server */
async function isKeycloakHealthy(keycloakUrl: string): Promise<boolean> {
  try {
    const healthUrl = utils.getHealthCheckUrl(keycloakUrl);
    console.log(`Checking Keycloak health at: ${healthUrl}`);

    const response = await axios.get(healthUrl, {
      timeout: config.API_TIMEOUT_MS,
      validateStatus: null,
      // For HTTPS, we might need to handle certificate issues during startup
      httpsAgent: utils.createHttpsAgent(keycloakUrl),
    });

    // Keycloak root path typically returns 200 with HTML content or a redirect
    // Any 2xx or 3xx response indicates the server is running
    if (response.status >= 200 && response.status < 400) {
      console.log(`Health check succeeded: Keycloak responded with status ${response.status}`);
      return true;
    } else {
      console.log(`Health check failed with status: ${response.status}`);
      return false;
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.log(`Health check error: ${errorMessage}`);
    return false;
  }
}

/** Check if Keycloak API is ready for configuration */
async function isKeycloakReadyForConfig(keycloakUrl: string): Promise<boolean> {
  try {
    // First, check basic health
    if (!(await isKeycloakHealthy(keycloakUrl))) {
      return false;
    }

    // Try to get the Keycloak server info which requires a fully operational server
    // This is a more comprehensive readiness check
    const adminUrl = `${utils.getAdminApiUrl(keycloakUrl)}/serverinfo`;
    console.log(`Checking Keycloak server info at: ${adminUrl}`);

    const response = await axios.get(adminUrl, {
      timeout: config.API_TIMEOUT_MS,
      validateStatus: null,
    });

    if (response.status === 200 || response.status === 401) {
      // 200 means we have access (shouldn't happen without auth)
      // 401 means the endpoint exists but we're not authenticated
      // Both indicate the server is ready for configuration
      console.log('Keycloak server is ready for configuration');
      return true;
    } else {
      console.log(`Server info check failed with status: ${response.status}`);
      return false;
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.log(`Server info check error: ${errorMessage}`);
    return false;
  }
}

/** Wait for Keycloak to be ready, with configurable retries */
async function waitForKeycloakHealth(keycloakUrl: string): Promise<boolean> {
  const maxAttempts = config.HEALTH_CHECK_MAX_ATTEMPTS;
  const intervalMs = config.HEALTH_CHECK_INTERVAL_MS;

  console.log(
    `Waiting for Keycloak to be healthy (max ${maxAttempts} attempts, interval ${intervalMs}ms)...`,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Health check attempt ${attempt}/${maxAttempts}...`);

    if (await isKeycloakReadyForConfig(keycloakUrl)) {
      console.log(`Keycloak is ready after ${attempt} attempts`);
      return true;
    }

    if (attempt < maxAttempts) {
      console.log(`Waiting ${intervalMs}ms before next attempt...`);
      await utils.sleep(intervalMs);
    }
  }

  console.error(`Keycloak failed to become ready after ${maxAttempts} attempts`);
  throw new Error(`Keycloak is not ready after ${maxAttempts} health check attempts`);
}

export = {
  isKeycloakHealthy,
  isKeycloakReadyForConfig,
  waitForKeycloakHealth,
};
