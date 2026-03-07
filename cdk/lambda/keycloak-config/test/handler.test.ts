/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Unit tests for the CloudFormation Custom Resource Lambda handler.
 *
 * Tests:
 * 1. Handler processes CloudFormation events correctly
 * 2. Handler reads SSM parameters and calls existing config logic
 * 3. Handler throws on SSM read failure
 * 4. Handler idempotency (multiple invocations produce same result)
 * 5. Handler returns success for Delete events
 */

// Mock all dependencies using the shared mock helpers
jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());
jest.mock('../src/aws-utils', () => require('./mock-helpers').createAwsUtilsMock());
jest.mock('../src/keycloak-api', () => require('./mock-helpers').createKeycloakApiMock());
jest.mock('../src/health-check', () => require('./mock-helpers').createHealthCheckMock());
jest.mock('../src/utils', () => require('./mock-helpers').createUtilsMock());
jest.mock('../src/config-validation', () => require('./mock-helpers').createConfigValidationMock());

const config = require('../src/config');
const awsUtils = require('../src/aws-utils');
const keycloakApi = require('../src/keycloak-api');
const healthCheck = require('../src/health-check');
const utils = require('../src/utils');
const configValidation = require('../src/config-validation');

const { handler } = require('../index');

import { CloudFormationCustomResourceEvent } from '../src/types';

/** Create a minimal valid CloudFormation Custom Resource event for testing. */
function createCfnEvent(
  overrides: Partial<CloudFormationCustomResourceEvent> = {},
): CloudFormationCustomResourceEvent {
  return {
    RequestType: 'Create',
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
    ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/test',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test-stack/guid',
    RequestId: 'unique-id-1234',
    ResourceType: 'Custom::KeycloakConfig',
    LogicalResourceId: 'KeycloakConfig',
    ResourceProperties: {},
    ...overrides,
  };
}

/**
 * Configure all mocks for a full successful run (happy path).
 * Individual tests override specific mocks to trigger error paths.
 */
function setupHappyPath() {
  const authConfig: Record<string, unknown> = {
    realm: 'test-realm',
    enabled: true,
    clients: [{ clientId: 'my-client' }],
    users: [{ username: 'my-user' }],
    roles: { realm: [{ name: 'my-role' }] },
  };

  // SSM parameter reads
  awsUtils.getSSMParameter.mockImplementation((name: string) => {
    if (name.endsWith('/keycloak/url')) return Promise.resolve('https://auth.example.com');
    if (name.endsWith('/keycloak/admin-secret-arn'))
      return Promise.resolve('arn:aws:secretsmanager:us-east-1:123456789012:secret:admin-secret');
    return Promise.reject(new Error(`Unknown SSM parameter: ${name}`));
  });

  healthCheck.waitForKeycloakHealth.mockResolvedValue(true);
  awsUtils.getAdminCredentials.mockResolvedValue({
    username: 'admin',
    password: 'admin-pw',
  });
  keycloakApi.loginWithRetry.mockResolvedValue('access-token');
  config.getAuthConfig.mockReturnValue(authConfig);

  // realm
  keycloakApi.createOrUpdateRealmWithConfig.mockResolvedValue(undefined);

  // clients
  keycloakApi.createOrUpdateClient.mockResolvedValue(undefined);
  keycloakApi.verifyClientExists.mockResolvedValue(true);

  // users
  awsUtils.getOrCreateUserPassword.mockResolvedValue('user-pw');
  keycloakApi.createOrUpdateUser.mockResolvedValue(undefined);
  keycloakApi.verifyUserExists.mockResolvedValue(true);

  // roles
  keycloakApi.createOrUpdateRole.mockResolvedValue(undefined);
  keycloakApi.verifyRoleExists.mockResolvedValue(true);

  // validation
  configValidation.performValidation.mockResolvedValue({
    allValid: true,
    details: {},
  });

  // Re-set retry mock (clearAllMocks does not reset mockImplementation)
  utils.retry.mockImplementation((fn: () => unknown) => fn());

  return authConfig;
}

describe('CloudFormation Custom Resource Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CloudFormation event processing', () => {
    test('processes a Create event and returns ProviderResponse on success', async () => {
      setupHappyPath();
      const event = createCfnEvent();

      const result = await handler(event);
      expect(result).toBeDefined();
      expect(result.Status).toBe('SUCCESS');
      expect(result.PhysicalResourceId).toBe('keycloak-config');
      expect(result.Data).toBeDefined();
    });

    test('reads SSM parameters using SSM_PREFIX before processing', async () => {
      setupHappyPath();
      await handler(createCfnEvent());

      expect(awsUtils.getSSMParameter).toHaveBeenCalledWith('/test-project/auth/keycloak/url');
      expect(awsUtils.getSSMParameter).toHaveBeenCalledWith(
        '/test-project/auth/keycloak/admin-secret-arn',
      );
    });

    test('calls waitForKeycloakHealth with the URL from SSM', async () => {
      setupHappyPath();
      await handler(createCfnEvent());

      expect(healthCheck.waitForKeycloakHealth).toHaveBeenCalledWith('https://auth.example.com');
    });

    test('calls getAdminCredentials with the secret ARN from SSM', async () => {
      setupHappyPath();
      await handler(createCfnEvent());

      expect(awsUtils.getAdminCredentials).toHaveBeenCalledWith(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin-secret',
      );
    });

    test('authenticates and configures Keycloak', async () => {
      setupHappyPath();
      await handler(createCfnEvent());

      expect(keycloakApi.loginWithRetry).toHaveBeenCalledWith(
        'https://auth.example.com',
        'admin',
        'admin-pw',
      );
      expect(keycloakApi.createOrUpdateRealmWithConfig).toHaveBeenCalled();
      expect(keycloakApi.createOrUpdateClient).toHaveBeenCalled();
      expect(keycloakApi.createOrUpdateUser).toHaveBeenCalled();
    });
  });

  describe('Delete event handling', () => {
    test('returns success immediately for Delete events', async () => {
      setupHappyPath();
      const event = createCfnEvent({
        RequestType: 'Delete',
        PhysicalResourceId: 'keycloak-config',
      });

      const result = await handler(event);
      expect(result.Status).toBe('SUCCESS');
      expect(result.PhysicalResourceId).toBe('keycloak-config');

      // Should NOT call any Keycloak configuration functions
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
      expect(keycloakApi.loginWithRetry).not.toHaveBeenCalled();
    });

    test('still reads SSM parameters for Delete events', async () => {
      setupHappyPath();
      const event = createCfnEvent({ RequestType: 'Delete' });

      await handler(event);
      expect(awsUtils.getSSMParameter).toHaveBeenCalled();
    });
  });

  describe('SSM read failure', () => {
    test('throws when getSSMParameter fails for keycloak URL', async () => {
      setupHappyPath();
      awsUtils.getSSMParameter.mockRejectedValue(
        new Error('Failed to read SSM parameter /test-project/auth/keycloak/url'),
      );

      await expect(handler(createCfnEvent())).rejects.toThrow('Failed to read SSM parameter');
      // No downstream calls should happen
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
    });

    test('throws when getSSMParameter fails for admin-secret-arn', async () => {
      setupHappyPath();
      awsUtils.getSSMParameter.mockImplementation((name: string) => {
        if (name.endsWith('/keycloak/url')) return Promise.resolve('https://auth.example.com');
        return Promise.reject(new Error('SSM parameter not found'));
      });

      await expect(handler(createCfnEvent())).rejects.toThrow('SSM parameter not found');
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    test('multiple invocations with same config produce same calls', async () => {
      setupHappyPath();
      const event = createCfnEvent();

      // First invocation
      await handler(event);
      const firstCallCounts = {
        realm: keycloakApi.createOrUpdateRealmWithConfig.mock.calls.length,
        client: keycloakApi.createOrUpdateClient.mock.calls.length,
        user: keycloakApi.createOrUpdateUser.mock.calls.length,
        role: keycloakApi.createOrUpdateRole.mock.calls.length,
      };

      jest.clearAllMocks();
      setupHappyPath();

      // Second invocation with same event
      await handler(event);
      const secondCallCounts = {
        realm: keycloakApi.createOrUpdateRealmWithConfig.mock.calls.length,
        client: keycloakApi.createOrUpdateClient.mock.calls.length,
        user: keycloakApi.createOrUpdateUser.mock.calls.length,
        role: keycloakApi.createOrUpdateRole.mock.calls.length,
      };

      // Same number of create-or-update calls each time (idempotent pattern)
      expect(firstCallCounts).toEqual(secondCallCounts);
    });

    test('uses create-or-update pattern for all resources', async () => {
      setupHappyPath();
      await handler(createCfnEvent());

      // Verify create-or-update (not create-only) functions are called
      expect(keycloakApi.createOrUpdateRealmWithConfig).toHaveBeenCalled();
      expect(keycloakApi.createOrUpdateClient).toHaveBeenCalled();
      expect(keycloakApi.createOrUpdateUser).toHaveBeenCalled();
      expect(keycloakApi.createOrUpdateRole).toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    test('throws on login failure', async () => {
      setupHappyPath();
      keycloakApi.loginWithRetry.mockRejectedValue(new Error('auth failed'));

      await expect(handler(createCfnEvent())).rejects.toThrow(
        'Unable to log in to Keycloak after maximum retries',
      );
    });

    test('throws when no auth config is available', async () => {
      setupHappyPath();
      config.getAuthConfig.mockReturnValue(null);

      await expect(handler(createCfnEvent())).rejects.toThrow(
        'No authentication configuration available',
      );
    });

    test('throws on realm creation failure', async () => {
      setupHappyPath();
      utils.retry.mockRejectedValue(new Error('realm creation failed'));

      await expect(handler(createCfnEvent())).rejects.toThrow('Failed to create/verify realm');
    });

    test('throws on validation failure', async () => {
      setupHappyPath();
      configValidation.performValidation.mockResolvedValue({
        allValid: false,
        failureReason: 'realm mismatch',
      });

      await expect(handler(createCfnEvent())).rejects.toThrow('Configuration validation failed');
    });
  });

  describe('Update event handling', () => {
    test('processes Update event same as Create', async () => {
      setupHappyPath();
      const event = createCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: 'keycloak-config',
      });

      const result = await handler(event);
      expect(result.Status).toBe('SUCCESS');
      expect(keycloakApi.createOrUpdateRealmWithConfig).toHaveBeenCalled();
    });
  });
});
