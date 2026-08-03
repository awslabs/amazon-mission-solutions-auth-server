/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Configuration for the Keycloak Config Lambda.
 *
 * Two categories of values:
 *
 * 1. Environment-only tunables (timeouts and retry limits) — read once at
 *    module load time from environment variables.
 *
 * 2. Per-invocation configuration passed as `Custom::KeycloakConfig`
 *    CloudFormation Custom Resource properties. `loadFromEvent(event)` returns
 *    a normalized {@link ResourceConfig} for the handler to consume directly.
 */

import {
  CloudFormationCustomResourceEvent,
  KeycloakConfigResourceProperties,
  KeycloakRealmConfig,
  ResourceConfig,
} from './types';

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

// Environment-only configuration (timeouts, retry limits).
const envConfig = {
  API_TIMEOUT_MS: parseInt(getEnvVar('API_TIMEOUT_MS', '30000') as string, 10),

  // Health check settings optimized for post-deployment readiness
  HEALTH_CHECK_MAX_ATTEMPTS: parseInt(getEnvVar('HEALTH_CHECK_MAX_ATTEMPTS', '30') as string, 10),
  HEALTH_CHECK_INTERVAL_MS: parseInt(getEnvVar('HEALTH_CHECK_INTERVAL_MS', '20000') as string, 10),

  API_MAX_RETRIES: parseInt(getEnvVar('API_MAX_RETRIES', '10') as string, 10),
  API_RETRY_INTERVAL_MS: parseInt(getEnvVar('API_RETRY_INTERVAL_MS', '20000') as string, 10),
};

/**
 * Extract normalized per-invocation configuration from the incoming
 * CloudFormation Custom Resource event.
 *
 * The shape of `event.ResourceProperties` is a compile-time contract with the
 * CDK `KeycloakConfig` construct — we cast rather than validate field-by-field.
 *
 * `AuthConfig` is transported as a JSON string to preserve primitive types
 * (booleans, numbers) across the CloudFormation Custom Resource wire, which
 * would otherwise stringify every leaf value. We parse it back to a real
 * `KeycloakRealmConfig` here so downstream code sees `enabled: true` as a
 * boolean rather than `"true"`.
 */
function loadFromEvent(event: CloudFormationCustomResourceEvent): ResourceConfig {
  const props = event.ResourceProperties as unknown as KeycloakConfigResourceProperties;

  if (!props.AuthConfig || typeof props.AuthConfig !== 'string') {
    throw new Error('Missing required resource property: AuthConfig');
  }

  let authConfig: KeycloakRealmConfig;
  try {
    authConfig = JSON.parse(props.AuthConfig) as KeycloakRealmConfig;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid resource property AuthConfig: not valid JSON (${message})`);
  }

  if (
    !authConfig ||
    typeof authConfig !== 'object' ||
    Array.isArray(authConfig) ||
    Object.keys(authConfig).length === 0
  ) {
    throw new Error('Missing required resource property: AuthConfig');
  }

  return {
    ssmPrefix: props.SsmPrefix,
    keycloakAdminUsername: props.KeycloakAdminUsername ?? 'keycloak',
    authConfig,
    userPasswordSecrets: props.UserPasswordSecrets ?? {},
  };
}

export = {
  ...envConfig,
  loadFromEvent,
};
