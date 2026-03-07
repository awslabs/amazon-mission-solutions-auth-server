/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

// index.ts uses './src/...' paths (relative to itself), but Jest resolves
// from the test file's perspective, so we use '../src/...' here.
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
  keycloakApi.verifyRealmExists.mockResolvedValue(true);

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

  // Re-set after clearAllMocks, which does not reset mockImplementation
  utils.retry.mockImplementation((fn: () => unknown) => fn());

  return authConfig;
}

describe('index handler (CloudFormation Custom Resource)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    test('completes full flow and returns ProviderResponse on success', async () => {
      setupHappyPath();
      const result = await handler(createCfnEvent());
      expect(result).toBeDefined();
      expect(result.Status).toBe('SUCCESS');
      expect(result.PhysicalResourceId).toBe('keycloak-config');
    });

    test('reads SSM parameters before any API calls', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(awsUtils.getSSMParameter).toHaveBeenCalledWith('/test-project/auth/keycloak/url');
      expect(awsUtils.getSSMParameter).toHaveBeenCalledWith(
        '/test-project/auth/keycloak/admin-secret-arn',
      );
    });

    test('calls waitForKeycloakHealth with URL from SSM', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(healthCheck.waitForKeycloakHealth).toHaveBeenCalledTimes(1);
      expect(healthCheck.waitForKeycloakHealth).toHaveBeenCalledWith('https://auth.example.com');
    });

    test('calls getAdminCredentials with secret ARN from SSM and loginWithRetry', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(awsUtils.getAdminCredentials).toHaveBeenCalledWith(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin-secret',
      );
      expect(keycloakApi.loginWithRetry).toHaveBeenCalledWith(
        'https://auth.example.com',
        'admin',
        'admin-pw',
      );
    });

    test('creates realm, clients, users, roles in order', async () => {
      setupHappyPath();
      const callOrder: string[] = [];

      utils.retry.mockImplementation(async (fn: () => unknown) => {
        callOrder.push('realm');
        return fn();
      });
      keycloakApi.createOrUpdateClient.mockImplementation(async () => {
        callOrder.push('client');
      });
      keycloakApi.createOrUpdateUser.mockImplementation(async () => {
        callOrder.push('user');
      });
      keycloakApi.createOrUpdateRole.mockImplementation(async () => {
        callOrder.push('role');
      });

      await handler(createCfnEvent());
      expect(callOrder).toEqual(['realm', 'client', 'user', 'role']);
    });

    test('verifies each resource after creation', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(keycloakApi.verifyClientExists).toHaveBeenCalled();
      expect(keycloakApi.verifyUserExists).toHaveBeenCalled();
      expect(keycloakApi.verifyRoleExists).toHaveBeenCalled();
    });

    test('calls performValidation at the end', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(configValidation.performValidation).toHaveBeenCalledWith(
        'access-token',
        'https://auth.example.com',
        'test-realm',
        expect.objectContaining({ realm: 'test-realm' }),
      );
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
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    test('throws when getAuthConfig returns null', async () => {
      setupHappyPath();
      config.getAuthConfig.mockReturnValue(null);

      await expect(handler(createCfnEvent())).rejects.toThrow(
        'No authentication configuration available',
      );
    });

    test('throws with descriptive message when loginWithRetry fails', async () => {
      setupHappyPath();
      keycloakApi.loginWithRetry.mockRejectedValue(new Error('auth failed'));

      await expect(handler(createCfnEvent())).rejects.toThrow(
        'Unable to log in to Keycloak after maximum retries',
      );
    });

    test('throws when SSM parameter read fails', async () => {
      setupHappyPath();
      awsUtils.getSSMParameter.mockRejectedValue(new Error('SSM read failed'));

      await expect(handler(createCfnEvent())).rejects.toThrow('SSM read failed');
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
    });
  });

  describe('realm creation', () => {
    test('uses utils.retry wrapper for realm creation', async () => {
      setupHappyPath();
      await handler(createCfnEvent());
      expect(utils.retry).toHaveBeenCalledWith(expect.any(Function), 3, 2000, 5000);
    });

    test('includes response status/data in error for realm failures with error.response', async () => {
      setupHappyPath();
      const err = new Error('realm error') as Error & {
        response: { status: number; data: { error: string } };
      };
      err.response = { status: 500, data: { error: 'internal' } };
      utils.retry.mockRejectedValue(err);

      await expect(handler(createCfnEvent())).rejects.toThrow('Failed to create/verify realm');
    });
  });

  describe('client processing', () => {
    test('processes multiple clients in order', async () => {
      const authConfig = setupHappyPath();
      authConfig.clients = [{ clientId: 'c1' }, { clientId: 'c2' }];
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler(createCfnEvent());
      expect(keycloakApi.createOrUpdateClient).toHaveBeenCalledTimes(2);
      expect(keycloakApi.verifyClientExists).toHaveBeenCalledTimes(2);
    });

    test('skips when no clients defined', async () => {
      const authConfig = setupHappyPath();
      authConfig.clients = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      const result = await handler(createCfnEvent());
      expect(result.Status).toBe('SUCCESS');
      expect(keycloakApi.createOrUpdateClient).not.toHaveBeenCalled();
    });

    test('throws when verifyClientExists returns false', async () => {
      setupHappyPath();
      keycloakApi.verifyClientExists.mockResolvedValue(false);

      await expect(handler(createCfnEvent())).rejects.toThrow('Failed to create/verify clients');
    });
  });

  describe('user processing', () => {
    test('calls getOrCreateUserPassword for each user', async () => {
      const authConfig = setupHappyPath();
      authConfig.users = [{ username: 'u1' }, { username: 'u2' }];
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler(createCfnEvent());
      expect(awsUtils.getOrCreateUserPassword).toHaveBeenCalledWith('u1');
      expect(awsUtils.getOrCreateUserPassword).toHaveBeenCalledWith('u2');
    });

    test('skips when no users defined', async () => {
      const authConfig = setupHappyPath();
      authConfig.users = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler(createCfnEvent());
      expect(keycloakApi.createOrUpdateUser).not.toHaveBeenCalled();
    });

    test('throws when verifyUserExists returns false', async () => {
      setupHappyPath();
      keycloakApi.verifyUserExists.mockResolvedValue(false);

      await expect(handler(createCfnEvent())).rejects.toThrow('Failed to create/verify users');
    });
  });

  describe('role processing', () => {
    test('processes roles from authConfig.roles.realm', async () => {
      const authConfig = setupHappyPath();
      authConfig.roles = { realm: [{ name: 'r1' }, { name: 'r2' }] };
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler(createCfnEvent());
      expect(keycloakApi.createOrUpdateRole).toHaveBeenCalledTimes(2);
      expect(keycloakApi.verifyRoleExists).toHaveBeenCalledTimes(2);
    });

    test('skips when no roles defined', async () => {
      const authConfig = setupHappyPath();
      authConfig.roles = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler(createCfnEvent());
      expect(keycloakApi.createOrUpdateRole).not.toHaveBeenCalled();
    });

    test('does NOT throw when role creation fails (non-critical)', async () => {
      setupHappyPath();
      keycloakApi.createOrUpdateRole.mockRejectedValue(new Error('role fail'));

      // Handler should still succeed (roles are non-critical)
      const result = await handler(createCfnEvent());
      expect(result.Status).toBe('SUCCESS');
    });

    test('continues when verifyRoleExists returns false (non-critical)', async () => {
      setupHappyPath();
      keycloakApi.verifyRoleExists.mockResolvedValue(false);

      // Handler should still succeed (roles are non-critical)
      const result = await handler(createCfnEvent());
      expect(result.Status).toBe('SUCCESS');
    });
  });

  describe('config validation', () => {
    test('throws when performValidation returns allValid=false', async () => {
      setupHappyPath();
      configValidation.performValidation.mockResolvedValue({
        allValid: false,
        failureReason: 'realm mismatch',
      });

      await expect(handler(createCfnEvent())).rejects.toThrow('Configuration validation failed');
    });

    test('throws when performValidation itself throws', async () => {
      setupHappyPath();
      configValidation.performValidation.mockRejectedValue(new Error('validation boom'));

      await expect(handler(createCfnEvent())).rejects.toThrow('Configuration validation failed');
    });
  });
});
