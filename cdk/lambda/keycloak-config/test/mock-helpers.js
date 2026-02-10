/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Shared mock factory functions for Keycloak Lambda tests.
 *
 * Each test file still calls jest.mock() per-file (Jest requirement),
 * but the mock *values* come from these factories so the definitions
 * are consistent and easy to override.
 */

function createConfigMock(overrides = {}) {
  return {
    KEYCLOAK_URL: 'https://keycloak.example.com',
    KEYCLOAK_ADMIN_USERNAME: 'keycloak',
    KEYCLOAK_ADMIN_SECRET_ARN:
      'arn:aws:secretsmanager:us-west-2:123456789012:secret:admin',
    WEBSITE_URI: 'https://myapp.example.com',
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

function createUtilsMock(overrides = {}) {
  return {
    sleep: jest.fn().mockResolvedValue(),
    retry: jest.fn((fn) => fn()),
    getHealthCheckUrl: jest.fn((url) => {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/`;
    }),
    getAdminApiUrl: jest.fn((url) => {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/admin`;
    }),
    createHttpsAgent: jest.fn().mockReturnValue(null),
    formatError: jest.fn((err) => err?.message || 'mock error'),
    makeAuthenticatedRequest: jest.fn(),
    ...overrides,
  };
}

function createKeycloakApiMock(overrides = {}) {
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

function createAwsUtilsMock(overrides = {}) {
  return {
    getAdminCredentials: jest.fn(),
    getOrCreateUserPassword: jest.fn(),
    ...overrides,
  };
}

function createHealthCheckMock(overrides = {}) {
  return {
    waitForKeycloakHealth: jest.fn(),
    ...overrides,
  };
}

function createConfigValidationMock(overrides = {}) {
  return {
    performValidation: jest.fn(),
    ...overrides,
  };
}

module.exports = {
  createConfigMock,
  createUtilsMock,
  createKeycloakApiMock,
  createAwsUtilsMock,
  createHealthCheckMock,
  createConfigValidationMock,
};
