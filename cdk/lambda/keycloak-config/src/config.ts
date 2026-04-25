/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Configuration settings for Keycloak Lambda */

import { KeycloakRealmConfig } from './types';

/** Get environment variable with validation */
function getEnvVar(
  name: string,
  defaultValue: string | null = null,
  required: boolean = false,
): string | null {
  const value = process.env[name] || defaultValue;

  if (required && (value === null || value === undefined)) {
    throw new Error(`Required environment variable ${name} is not set`);
  }

  return value;
}

// Configuration from environment variables
const config = {
  SSM_PREFIX: getEnvVar('SSM_PREFIX', null, true) as string,
  KEYCLOAK_ADMIN_USERNAME: getEnvVar('KEYCLOAK_ADMIN_USERNAME', 'keycloak') as string,
  AUTH_CONFIG: getEnvVar('AUTH_CONFIG', '{}') as string,
  USER_PASSWORD_SECRETS: getEnvVar('USER_PASSWORD_SECRETS', '{}') as string,
  API_TIMEOUT_MS: parseInt(getEnvVar('API_TIMEOUT_MS', '30000') as string, 10),

  // Health check settings optimized for post-deployment readiness
  HEALTH_CHECK_MAX_ATTEMPTS: parseInt(getEnvVar('HEALTH_CHECK_MAX_ATTEMPTS', '30') as string, 10),
  HEALTH_CHECK_INTERVAL_MS: parseInt(getEnvVar('HEALTH_CHECK_INTERVAL_MS', '20000') as string, 10),

  API_MAX_RETRIES: parseInt(getEnvVar('API_MAX_RETRIES', '10') as string, 10),
  API_RETRY_INTERVAL_MS: parseInt(getEnvVar('API_RETRY_INTERVAL_MS', '20000') as string, 10),
};

/** Parse auth config from environment variable */
function getAuthConfig(): KeycloakRealmConfig | null {
  if (!config.AUTH_CONFIG || config.AUTH_CONFIG === '{}') {
    console.log('No custom authentication configuration provided. Using default configuration.');
    return null;
  }

  try {
    return JSON.parse(config.AUTH_CONFIG) as KeycloakRealmConfig;
  } catch (error: unknown) {
    console.error('Error parsing authentication configuration:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid authentication configuration: ${message}`);
  }
}

/** Parse user password secrets from environment variable */
function getUserPasswordSecrets(): Record<string, string> {
  if (!config.USER_PASSWORD_SECRETS || config.USER_PASSWORD_SECRETS === '{}') {
    console.log('No user password secrets provided.');
    return {};
  }

  try {
    return JSON.parse(config.USER_PASSWORD_SECRETS) as Record<string, string>;
  } catch (error: unknown) {
    console.error('Error parsing user password secrets:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid user password secrets: ${message}`);
  }
}

export = {
  ...config,
  getAuthConfig,
  getUserPasswordSecrets,
};
