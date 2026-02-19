/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Shared mock factory functions for Keycloak Lambda tests.
 *
 * Each test file still calls jest.mock() per-file (Jest requirement),
 * but the mock *values* come from these factories so the definitions
 * are consistent and easy to override.
 */

import { AppConfig } from '../src/types';

export interface ConfigMock extends AppConfig {
  [key: string]: unknown;
}

export function createConfigMock(overrides: Partial<ConfigMock> = {}): ConfigMock {
  return {
    KEYCLOAK_URL: 'https://keycloak.example.com',
    KEYCLOAK_ADMIN_USERNAME: 'keycloak',
    KEYCLOAK_ADMIN_SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:admin',
    WEBSITE_URI: 'https://myapp.example.com',
    AUTH_CONFIG: '{}',
    USER_PASSWORD_SECRETS: '{}',
    API_TIMEOUT_MS: 5000,
    HEALTH_CHECK_MAX_ATTEMPTS: 3,
    HEALTH_CHECK_INTERVAL_MS: 100,
    API_MAX_RETRIES: 3,
    API_RETRY_INTERVAL_MS: 100,
    getAuthConfig: jest.fn(),
    getUserPasswordSecrets: jest.fn(),
    ...overrides,
  };
}

export function createUtilsMock(overrides: Record<string, unknown> = {}) {
  return {
    sleep: jest.fn().mockResolvedValue(undefined),
    retry: jest.fn((fn: () => unknown) => fn()),
    getHealthCheckUrl: jest.fn((url: string) => {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/`;
    }),
    getAdminApiUrl: jest.fn((url: string) => {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/admin`;
    }),
    createHttpsAgent: jest.fn().mockReturnValue(null),
    formatError: jest.fn((err: unknown) => (err as Error)?.message || 'mock error'),
    makeAuthenticatedRequest: jest.fn(),
    ...overrides,
  };
}

export function createKeycloakApiMock(overrides: Record<string, unknown> = {}) {
  return {
    login: jest.fn(),
    loginWithRetry: jest.fn(),
    createOrUpdateRealmWithConfig: jest.fn(),
    verifyRealmExists: jest.fn(),
    createOrUpdateClient: jest.fn(),
    verifyClientExists: jest.fn(),
    createOrUpdateUser: jest.fn(),
    verifyUserExists: jest.fn(),
    createOrUpdateRole: jest.fn(),
    verifyRoleExists: jest.fn(),
    getClientByClientId: jest.fn(),
    getUserByUsername: jest.fn(),
    setUserPassword: jest.fn(),
    ...overrides,
  };
}

export function createAwsUtilsMock(overrides: Record<string, unknown> = {}) {
  return {
    getAdminCredentials: jest.fn(),
    getOrCreateUserPassword: jest.fn(),
    ...overrides,
  };
}

export function createHealthCheckMock(overrides: Record<string, unknown> = {}) {
  return {
    waitForKeycloakHealth: jest.fn(),
    ...overrides,
  };
}

export function createConfigValidationMock(overrides: Record<string, unknown> = {}) {
  return {
    performValidation: jest.fn(),
    ...overrides,
  };
}
