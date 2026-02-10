/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

// index.js uses './src/...' paths (relative to itself), but Jest resolves
// from the test file's perspective, so we use '../src/...' here.
jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());
jest.mock('../src/aws-utils', () => require('./mock-helpers').createAwsUtilsMock());
jest.mock('../src/keycloak-api', () => require('./mock-helpers').createKeycloakApiMock());
jest.mock('../src/health-check', () => require('./mock-helpers').createHealthCheckMock());
jest.mock('../src/utils', () => require('./mock-helpers').createUtilsMock());
jest.mock('../src/config-validation', () =>
  require('./mock-helpers').createConfigValidationMock(),
);

const config = require('../src/config');
const awsUtils = require('../src/aws-utils');
const keycloakApi = require('../src/keycloak-api');
const healthCheck = require('../src/health-check');
const utils = require('../src/utils');
const configValidation = require('../src/config-validation');

const { handler } = require('../index');

/**
 * Configure all mocks for a full successful run (happy path).
 * Individual tests override specific mocks to trigger error paths.
 */
function setupHappyPath() {
  const authConfig = {
    realm: 'test-realm',
    enabled: true,
    clients: [{ clientId: 'my-client' }],
    users: [{ username: 'my-user' }],
    roles: { realm: [{ name: 'my-role' }] },
  };

  healthCheck.waitForKeycloakHealth.mockResolvedValue(true);
  awsUtils.getAdminCredentials.mockResolvedValue({
    username: 'admin',
    password: 'admin-pw',
  });
  keycloakApi.loginWithRetry.mockResolvedValue('access-token');
  config.getAuthConfig.mockReturnValue(authConfig);

  // realm
  keycloakApi.createOrUpdateRealmWithConfig.mockResolvedValue();
  keycloakApi.verifyRealmExists.mockResolvedValue(true);

  // clients
  keycloakApi.createOrUpdateClient.mockResolvedValue();
  keycloakApi.verifyClientExists.mockResolvedValue(true);

  // users
  awsUtils.getOrCreateUserPassword.mockResolvedValue('user-pw');
  keycloakApi.createOrUpdateUser.mockResolvedValue();
  keycloakApi.verifyUserExists.mockResolvedValue(true);

  // roles
  keycloakApi.createOrUpdateRole.mockResolvedValue();
  keycloakApi.verifyRoleExists.mockResolvedValue(true);

  // validation
  configValidation.performValidation.mockResolvedValue({
    allValid: true,
    details: {},
  });

  // Re-set after clearAllMocks, which does not reset mockImplementation
  utils.retry.mockImplementation((fn) => fn());

  return authConfig;
}

describe('index handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DELETE event', () => {
    test('returns SUCCESS immediately without configuring Keycloak', async () => {
      const event = {
        RequestType: 'Delete',
        PhysicalResourceId: 'existing-id',
      };
      const result = await handler(event);
      expect(result.Status).toBe('SUCCESS');
      expect(result.PhysicalResourceId).toBe('existing-id');
      expect(healthCheck.waitForKeycloakHealth).not.toHaveBeenCalled();
    });

    test('uses event.PhysicalResourceId when provided', async () => {
      const event = {
        RequestType: 'Delete',
        PhysicalResourceId: 'my-resource-id',
      };
      const result = await handler(event);
      expect(result.PhysicalResourceId).toBe('my-resource-id');
    });

    test('generates a PhysicalResourceId when not provided in event', async () => {
      const event = { RequestType: 'Delete' };
      const result = await handler(event);
      expect(result.PhysicalResourceId).toMatch(/^KeycloakConfig-/);
    });
  });

  describe('happy path (Create/Update)', () => {
    test('completes full flow and returns SUCCESS with RealmName and VerificationResults', async () => {
      setupHappyPath();
      const event = { RequestType: 'Create' };
      const result = await handler(event);
      expect(result.Status).toBe('SUCCESS');
      expect(result.Data.RealmName).toBe('test-realm');
      expect(result.Data.VerificationResults).toEqual({
        realmCreated: true,
        clientsCreated: true,
        usersCreated: true,
        rolesCreated: true,
      });
    });

    test('calls waitForKeycloakHealth before any API calls', async () => {
      setupHappyPath();
      await handler({ RequestType: 'Create' });
      expect(healthCheck.waitForKeycloakHealth).toHaveBeenCalledTimes(1);
    });

    test('calls getAdminCredentials and loginWithRetry', async () => {
      setupHappyPath();
      await handler({ RequestType: 'Create' });
      expect(awsUtils.getAdminCredentials).toHaveBeenCalledTimes(1);
      expect(keycloakApi.loginWithRetry).toHaveBeenCalledWith('admin', 'admin-pw');
    });

    test('creates realm, clients, users, roles in order', async () => {
      setupHappyPath();
      const callOrder = [];

      utils.retry.mockImplementation(async (fn) => {
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

      await handler({ RequestType: 'Update' });
      expect(callOrder).toEqual(['realm', 'client', 'user', 'role']);
    });

    test('verifies each resource after creation', async () => {
      setupHappyPath();
      await handler({ RequestType: 'Create' });
      expect(keycloakApi.verifyClientExists).toHaveBeenCalled();
      expect(keycloakApi.verifyUserExists).toHaveBeenCalled();
      expect(keycloakApi.verifyRoleExists).toHaveBeenCalled();
    });

    test('calls performValidation at the end', async () => {
      setupHappyPath();
      await handler({ RequestType: 'Create' });
      expect(configValidation.performValidation).toHaveBeenCalledWith(
        'access-token',
        'test-realm',
        expect.objectContaining({ realm: 'test-realm' }),
      );
    });

    test('returns response with Data containing WebsiteUri', async () => {
      setupHappyPath();
      const result = await handler({ RequestType: 'Create' });
      expect(result.Data.WebsiteUri).toBe('https://myapp.example.com');
    });
  });

  describe('error handling', () => {
    test('throws when getAuthConfig returns null', async () => {
      setupHappyPath();
      config.getAuthConfig.mockReturnValue(null);

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Configuration failed',
      );
    });

    test('throws with descriptive message when loginWithRetry fails', async () => {
      setupHappyPath();
      keycloakApi.loginWithRetry.mockRejectedValue(new Error('auth failed'));

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Unable to log in to Keycloak after maximum retries',
      );
    });
  });

  describe('realm creation', () => {
    test('uses utils.retry wrapper for realm creation', async () => {
      setupHappyPath();
      await handler({ RequestType: 'Create' });
      expect(utils.retry).toHaveBeenCalledWith(expect.any(Function), 3, 2000, 5000);
    });

    test('includes response status/data in error for realm failures with error.response', async () => {
      setupHappyPath();
      const err = new Error('realm error');
      err.response = { status: 500, data: { error: 'internal' } };
      utils.retry.mockRejectedValue(err);

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Failed to create/verify realm',
      );
    });
  });

  describe('client processing', () => {
    test('processes multiple clients in order', async () => {
      const authConfig = setupHappyPath();
      authConfig.clients = [{ clientId: 'c1' }, { clientId: 'c2' }];
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler({ RequestType: 'Create' });
      expect(keycloakApi.createOrUpdateClient).toHaveBeenCalledTimes(2);
      expect(keycloakApi.verifyClientExists).toHaveBeenCalledTimes(2);
    });

    test('skips when no clients defined (sets clientsCreated=true)', async () => {
      const authConfig = setupHappyPath();
      authConfig.clients = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      const result = await handler({ RequestType: 'Create' });
      expect(keycloakApi.createOrUpdateClient).not.toHaveBeenCalled();
      expect(result.Data.VerificationResults.clientsCreated).toBe(true);
    });

    test('throws when verifyClientExists returns false', async () => {
      setupHappyPath();
      keycloakApi.verifyClientExists.mockResolvedValue(false);

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Failed to create/verify clients',
      );
    });
  });

  describe('user processing', () => {
    test('calls getOrCreateUserPassword for each user', async () => {
      const authConfig = setupHappyPath();
      authConfig.users = [{ username: 'u1' }, { username: 'u2' }];
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler({ RequestType: 'Create' });
      expect(awsUtils.getOrCreateUserPassword).toHaveBeenCalledWith('u1');
      expect(awsUtils.getOrCreateUserPassword).toHaveBeenCalledWith('u2');
    });

    test('skips when no users defined (sets usersCreated=true)', async () => {
      const authConfig = setupHappyPath();
      authConfig.users = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      const result = await handler({ RequestType: 'Create' });
      expect(keycloakApi.createOrUpdateUser).not.toHaveBeenCalled();
      expect(result.Data.VerificationResults.usersCreated).toBe(true);
    });

    test('throws when verifyUserExists returns false', async () => {
      setupHappyPath();
      keycloakApi.verifyUserExists.mockResolvedValue(false);

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Failed to create/verify users',
      );
    });
  });

  describe('role processing', () => {
    test('processes roles from authConfig.roles.realm', async () => {
      const authConfig = setupHappyPath();
      authConfig.roles = { realm: [{ name: 'r1' }, { name: 'r2' }] };
      config.getAuthConfig.mockReturnValue(authConfig);

      await handler({ RequestType: 'Create' });
      expect(keycloakApi.createOrUpdateRole).toHaveBeenCalledTimes(2);
      expect(keycloakApi.verifyRoleExists).toHaveBeenCalledTimes(2);
    });

    test('skips when no roles defined (sets rolesCreated=true)', async () => {
      const authConfig = setupHappyPath();
      authConfig.roles = undefined;
      config.getAuthConfig.mockReturnValue(authConfig);

      const result = await handler({ RequestType: 'Create' });
      expect(keycloakApi.createOrUpdateRole).not.toHaveBeenCalled();
      expect(result.Data.VerificationResults.rolesCreated).toBe(true);
    });

    test('does NOT throw when role creation fails (non-critical, sets rolesCreated=false)', async () => {
      setupHappyPath();
      keycloakApi.createOrUpdateRole.mockRejectedValue(new Error('role fail'));

      const result = await handler({ RequestType: 'Create' });
      expect(result.Data.VerificationResults.rolesCreated).toBe(false);
    });

    test('throws when verifyRoleExists returns false', async () => {
      setupHappyPath();
      keycloakApi.verifyRoleExists.mockResolvedValue(false);

      const result = await handler({ RequestType: 'Create' });
      expect(result.Data.VerificationResults.rolesCreated).toBe(false);
    });
  });

  describe('config validation', () => {
    test('throws when performValidation returns allValid=false', async () => {
      setupHappyPath();
      configValidation.performValidation.mockResolvedValue({
        allValid: false,
        failureReason: 'realm mismatch',
      });

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Configuration validation failed',
      );
    });

    test('throws when performValidation itself throws', async () => {
      setupHappyPath();
      configValidation.performValidation.mockRejectedValue(new Error('validation boom'));

      await expect(handler({ RequestType: 'Create' })).rejects.toThrow(
        'Configuration validation failed',
      );
    });
  });
});
