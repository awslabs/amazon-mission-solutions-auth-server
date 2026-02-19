/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());
jest.mock('../src/keycloak-api', () => require('./mock-helpers').createKeycloakApiMock());
jest.mock('../src/utils', () => require('./mock-helpers').createUtilsMock());

const keycloakApi = require('../src/keycloak-api');
const utils = require('../src/utils');

const {
  performValidation,
  validateRealm,
  validateClients,
  validateUsers,
  validateRoles,
} = require('../src/config-validation');

const TOKEN = 'test-access-token';
const REALM = 'test-realm';

describe('config-validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('performValidation', () => {
    function makeRealmConfig(overrides: Record<string, unknown> = {}) {
      return {
        enabled: true,
        clients: [] as unknown[],
        users: [] as unknown[],
        roles: { realm: [] as unknown[] },
        ...overrides,
      };
    }

    beforeEach(() => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: { enabled: true },
      });
    });

    test('returns allValid=true when realm, clients, users, roles all valid', async () => {
      const realmConfig = makeRealmConfig();
      const result = await performValidation(TOKEN, REALM, realmConfig);
      expect(result.allValid).toBe(true);
      expect(result.details.realmValid).toBe(true);
      expect(result.details.clientsValid).toBe(true);
      expect(result.details.usersValid).toBe(true);
      expect(result.details.rolesValid).toBe(true);
    });

    test('returns early with allValid=false when realm validation fails', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 404 });

      const realmConfig = makeRealmConfig();
      const result = await performValidation(TOKEN, REALM, realmConfig);
      expect(result.allValid).toBe(false);
      expect(result.details.realmValid).toBe(false);
      expect(result.failureReason).toContain('not accessible');
    });

    test('returns early with allValid=false when clients validation fails', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue(null);

      const realmConfig = makeRealmConfig({
        clients: [{ clientId: 'missing-client' }],
      });
      const result = await performValidation(TOKEN, REALM, realmConfig);
      expect(result.allValid).toBe(false);
      expect(result.details.realmValid).toBe(true);
      expect(result.details.clientsValid).toBe(false);
      expect(result.failureReason).toContain('missing-client');
    });

    test('returns early with allValid=false when users validation fails', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue(null);

      const realmConfig = makeRealmConfig({
        users: [{ username: 'missing-user' }],
      });
      const result = await performValidation(TOKEN, REALM, realmConfig);
      expect(result.allValid).toBe(false);
      expect(result.details.usersValid).toBe(false);
      expect(result.failureReason).toContain('missing-user');
    });

    test('still returns allValid=true when roles validation fails (non-critical)', async () => {
      keycloakApi.verifyRoleExists.mockResolvedValue(false);

      const realmConfig = makeRealmConfig({
        roles: { realm: [{ name: 'missing-role' }] },
      });
      const result = await performValidation(TOKEN, REALM, realmConfig);
      expect(result.allValid).toBe(true);
      expect(result.details.rolesValid).toBe(true);
    });

    test('catches thrown errors and returns allValid=false with failureReason', async () => {
      // Null realmConfig triggers a TypeError through the realm validation path
      const result = await performValidation(TOKEN, REALM, null);
      expect(result.allValid).toBe(false);
      expect(result.failureReason).toContain('Cannot read properties of null');
    });
  });

  describe('validateRealm', () => {
    test('returns valid=true when realm exists and enabled matches', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: { enabled: true },
      });
      const result = await validateRealm(TOKEN, REALM, { enabled: true });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false when realm GET returns non-200 status', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 404 });
      const result = await validateRealm(TOKEN, REALM, { enabled: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not accessible');
    });

    test('returns valid=false when enabled status mismatches', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: { enabled: false },
      });
      const result = await validateRealm(TOKEN, REALM, { enabled: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('enabled status mismatch');
    });

    test('returns valid=false with reason on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('network fail'));
      const result = await validateRealm(TOKEN, REALM, { enabled: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('network fail');
    });
  });

  describe('validateClients', () => {
    test('returns valid=true when no clients defined in config', async () => {
      const result = await validateClients(TOKEN, REALM, {});
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when clients array is empty', async () => {
      const result = await validateClients(TOKEN, REALM, { clients: [] });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when all clients pass validation', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'my-client',
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: ['https://app.example.com/*'],
        webOrigins: ['https://app.example.com'],
      });

      const result = await validateClients(TOKEN, REALM, {
        clients: [
          {
            clientId: 'my-client',
            publicClient: true,
            standardFlowEnabled: true,
            directAccessGrantsEnabled: false,
            redirectUris: ['https://app.example.com/*'],
            webOrigins: ['https://app.example.com'],
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false when a client is not found', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue(null);
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'ghost' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('"ghost" not found');
    });

    test('returns valid=false when critical property mismatches (publicClient)', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        publicClient: false,
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', publicClient: true }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('publicClient');
    });

    test('returns valid=false when critical property mismatches (standardFlowEnabled)', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        standardFlowEnabled: false,
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', standardFlowEnabled: true }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('standardFlowEnabled');
    });

    test('returns valid=false when critical property mismatches (directAccessGrantsEnabled)', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        directAccessGrantsEnabled: true,
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', directAccessGrantsEnabled: false }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('directAccessGrantsEnabled');
    });

    test('skips property check when expectedClient property is undefined', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        publicClient: false,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1' }],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false when redirectUris are empty on actual client', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        redirectUris: [],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', redirectUris: ['https://app.com/*'] }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('has no redirect URIs');
    });

    test('returns valid=false when redirectUris are missing on actual client', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', redirectUris: ['https://app.com/*'] }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('has no redirect URIs');
    });

    test('returns valid=false when redirectUris contain unprocessed placeholders', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        redirectUris: ['__PLACEHOLDER_REDIRECT_URI__'],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', redirectUris: ['https://app.com/*'] }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('unprocessed placeholders in redirectUris');
    });

    test('returns valid=true when redirectUris are properly processed', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        redirectUris: ['https://app.com/*'],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', redirectUris: ['https://app.com/*'] }],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false when webOrigins are empty on actual client', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        webOrigins: [],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', webOrigins: ['https://app.com'] }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('has no web origins');
    });

    test('returns valid=false when webOrigins contain unprocessed placeholders', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        webOrigins: ['__PLACEHOLDER_WEB_ORIGIN__'],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', webOrigins: ['https://app.com'] }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('unprocessed placeholders in webOrigins');
    });

    test('returns valid=true when webOrigins are properly processed', async () => {
      keycloakApi.getClientByClientId.mockResolvedValue({
        clientId: 'c1',
        webOrigins: ['https://app.com'],
      });
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1', webOrigins: ['https://app.com'] }],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false with reason on thrown error', async () => {
      keycloakApi.getClientByClientId.mockRejectedValue(new Error('api down'));
      const result = await validateClients(TOKEN, REALM, {
        clients: [{ clientId: 'c1' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('api down');
    });
  });

  describe('validateUsers', () => {
    test('returns valid=true when no users defined in config', async () => {
      const result = await validateUsers(TOKEN, REALM, {});
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when users array is empty', async () => {
      const result = await validateUsers(TOKEN, REALM, { users: [] });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when all users pass validation', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue({
        username: 'testuser',
        enabled: true,
        firstName: 'Test',
        lastName: 'User',
      });

      const result = await validateUsers(TOKEN, REALM, {
        users: [
          {
            username: 'testuser',
            enabled: true,
            firstName: 'Test',
            lastName: 'User',
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false when a user is not found', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue(null);
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'ghost' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('"ghost" not found');
    });

    test('returns valid=false when user enabled status mismatches', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue({
        username: 'u1',
        enabled: false,
      });
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'u1', enabled: true }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('enabled status mismatch');
    });

    test('returns valid=false when user firstName mismatches', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue({
        username: 'u1',
        firstName: 'Wrong',
      });
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'u1', firstName: 'Correct' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('firstName mismatch');
    });

    test('returns valid=false when user lastName mismatches', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue({
        username: 'u1',
        lastName: 'Wrong',
      });
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'u1', lastName: 'Correct' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('lastName mismatch');
    });

    test('returns valid=true when optional fields not in expectedUser (skipped)', async () => {
      keycloakApi.getUserByUsername.mockResolvedValue({
        username: 'u1',
        enabled: true,
        firstName: 'Any',
        lastName: 'Name',
      });
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'u1' }],
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=false with reason on thrown error', async () => {
      keycloakApi.getUserByUsername.mockRejectedValue(new Error('db error'));
      const result = await validateUsers(TOKEN, REALM, {
        users: [{ username: 'u1' }],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('db error');
    });
  });

  describe('validateRoles', () => {
    test('returns valid=true when no roles defined in config', async () => {
      const result = await validateRoles(TOKEN, REALM, {});
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when no roles.realm defined', async () => {
      const result = await validateRoles(TOKEN, REALM, { roles: {} });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when roles.realm is empty array', async () => {
      const result = await validateRoles(TOKEN, REALM, { roles: { realm: [] } });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true when all roles exist (logs PASS)', async () => {
      keycloakApi.verifyRoleExists.mockResolvedValue(true);
      const result = await validateRoles(TOKEN, REALM, {
        roles: { realm: [{ name: 'admin' }] },
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true even when a role is missing (logs WARN, non-critical)', async () => {
      keycloakApi.verifyRoleExists.mockResolvedValue(false);
      const result = await validateRoles(TOKEN, REALM, {
        roles: { realm: [{ name: 'missing-role' }] },
      });
      expect(result.valid).toBe(true);
    });

    test('returns valid=true even when error is thrown (non-critical)', async () => {
      keycloakApi.verifyRoleExists.mockRejectedValue(new Error('api fail'));
      const result = await validateRoles(TOKEN, REALM, {
        roles: { realm: [{ name: 'role1' }] },
      });
      expect(result.valid).toBe(true);
    });
  });
});
