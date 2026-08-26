/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

export {};
jest.mock('axios');
jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());
jest.mock('../src/utils', () => require('./mock-helpers').createUtilsMock());

const axios = require('axios');
const utils = require('../src/utils');
const config = require('../src/config');

const {
  login,
  loginWithRetry,
  verifyRealmExists,
  createOrUpdateRealmWithConfig,
  createOrUpdateClient,
  getClientByClientId,
  createOrUpdateUser,
  getUserByUsername,
  setUserPassword,
  createOrUpdateRole,
  createOrUpdateClientScope,
  getClientScopeByName,
  verifyClientExists,
  verifyUserExists,
  verifyRoleExists,
  verifyClientScopeExists,
} = require('../src/keycloak-api');

const TOKEN = 'test-access-token';
const REALM = 'test-realm';
const KEYCLOAK_URL = 'https://keycloak.example.com';

describe('keycloak-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    test('returns access token on successful login', async () => {
      axios.post.mockResolvedValue({
        data: { access_token: 'my-token' },
      });
      const token = await login(KEYCLOAK_URL, 'admin', 'password');
      expect(token).toBe('my-token');
      expect(axios.post).toHaveBeenCalledWith(
        'https://keycloak.example.com/realms/master/protocol/openid-connect/token',
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 5000,
        }),
      );
    });

    test('throws when response has no access_token', async () => {
      axios.post.mockResolvedValue({ data: {} });
      await expect(login(KEYCLOAK_URL, 'admin', 'password')).rejects.toThrow(
        'Received response without access token',
      );
    });

    test('throws on axios error', async () => {
      axios.post.mockRejectedValue(new Error('network error'));
      await expect(login(KEYCLOAK_URL, 'admin', 'password')).rejects.toThrow('network error');
    });
  });

  describe('loginWithRetry', () => {
    test('delegates to utils.retry with login function', async () => {
      axios.post.mockResolvedValue({ data: { access_token: 'retry-token' } });
      const token = await loginWithRetry(KEYCLOAK_URL, 'admin', 'password');
      expect(utils.retry).toHaveBeenCalledWith(
        expect.any(Function),
        config.API_MAX_RETRIES,
        config.API_RETRY_INTERVAL_MS,
        config.API_RETRY_INTERVAL_MS * 2,
      );
      expect(token).toBe('retry-token');
    });
  });

  describe('verifyRealmExists', () => {
    test('returns true for 200 response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200 });
      const result = await verifyRealmExists(TOKEN, KEYCLOAK_URL, REALM);
      expect(result).toBe(true);
      expect(utils.makeAuthenticatedRequest).toHaveBeenCalledWith(
        'get',
        expect.stringContaining(`/realms/${REALM}`),
        null,
        TOKEN,
      );
    });

    test('returns false for non-200 response (e.g. 404)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 404 });
      const result = await verifyRealmExists(TOKEN, KEYCLOAK_URL, REALM);
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyRealmExists(TOKEN, KEYCLOAK_URL, REALM)).rejects.toThrow('server error');
    });
  });

  describe('createOrUpdateRealmWithConfig', () => {
    test('creates new realm when realm does not exist', async () => {
      // verifyRealmExists returns false (realm does not exist)
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRealmExists
        .mockResolvedValueOnce({ status: 201 }); // create realm

      await createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {
        displayName: 'Test Realm',
      });

      // Second call is the POST to create the realm
      const [method, , data, token] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(data.realm).toBe(REALM);
      expect(data.displayName).toBe('Test Realm');
      expect(token).toBe(TOKEN);
    });

    test('updates existing realm when realm exists', async () => {
      // verifyRealmExists returns true
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200 }) // verifyRealmExists
        .mockResolvedValueOnce({ status: 204 }); // update realm (PUT)

      await createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {
        displayName: 'Updated Realm',
      });

      const [method] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
    });

    test('uses displayName from config when provided', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {
        displayName: 'Custom Display',
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.displayName).toBe('Custom Display');
    });

    test('defaults displayName to "{realmName} Realm"', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {});

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.displayName).toBe(`${REALM} Realm`);
    });

    test('logs client/user counts when present in config', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {
        clients: [{ clientId: 'c1' }, { clientId: 'c2' }],
        users: [{ username: 'u1' }],
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 client(s)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 user(s)'));
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRealmExists
        .mockResolvedValueOnce({ status: 400 }); // create fails

      await expect(createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {})).rejects.toThrow(
        'Unexpected status code when creating realm: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRealmExists
        .mockRejectedValueOnce(new Error('network error'));

      await expect(createOrUpdateRealmWithConfig(TOKEN, KEYCLOAK_URL, REALM, {})).rejects.toThrow(
        'network error',
      );
    });
  });

  describe('createOrUpdateClient', () => {
    test('creates new client (POST) when client does not exist', async () => {
      // getClientByClientId returns null (client not found)
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getClientByClientId
        .mockResolvedValueOnce({ status: 201 }); // create client

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        name: 'My Client',
      });

      const [method, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(data.clientId).toBe('my-client');
    });

    test('updates existing client (PUT) when client exists', async () => {
      const existingClient = { id: 'uuid-123', clientId: 'my-client', name: 'Old' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existingClient] }) // getClientByClientId
        .mockResolvedValueOnce({ status: 204 }); // update client

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        name: 'Updated',
      });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('uuid-123');
    });

    test('passes redirectUris through unchanged (no placeholder replacement)', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        redirectUris: ['https://myapp.com/*', 'https://other.com/*'],
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.redirectUris).toEqual(['https://myapp.com/*', 'https://other.com/*']);
    });

    test('passes webOrigins through unchanged (no placeholder replacement)', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        webOrigins: ['https://myapp.com'],
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.webOrigins).toEqual(['https://myapp.com']);
    });

    test('processes postLogoutRedirectUris into attributes', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        postLogoutRedirectUris: ['https://myapp.com/*', 'https://other.com/logout'],
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.attributes['post.logout.redirect.uris']).toBe(
        'https://myapp.com/*,https://other.com/logout',
      );
    });

    test('merges with existing client config on update', async () => {
      const existingClient = {
        id: 'uuid-123',
        clientId: 'my-client',
        name: 'Old Name',
        existingField: 'preserved',
      };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existingClient] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        name: 'New Name',
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.name).toBe('New Name');
      expect(data.existingField).toBe('preserved');
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 400 });

      await expect(
        createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, { clientId: 'my-client' }),
      ).rejects.toThrow('Unexpected status code: 400');
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockRejectedValueOnce(new Error('request failed'));

      await expect(
        createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, { clientId: 'my-client' }),
      ).rejects.toThrow('request failed');
    });

    test('strips defaultClientScopes/optionalClientScopes from client body', async () => {
      const scope = { id: 'scope-uuid', name: 'my-scope' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getClientByClientId (not found)
        .mockResolvedValueOnce({ status: 201 }) // create client
        .mockResolvedValueOnce({
          // getClientByClientId after create (for UUID lookup)
          status: 200,
          data: [{ id: 'client-uuid', clientId: 'my-client' }],
        })
        .mockResolvedValueOnce({ status: 200, data: [scope] }) // getClientScopeByName
        .mockResolvedValueOnce({ status: 204 }); // attach default scope

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        defaultClientScopes: ['my-scope'],
      });

      const [, , body] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(body.defaultClientScopes).toBeUndefined();
      expect(body.optionalClientScopes).toBeUndefined();
    });

    test('attaches default client scopes via dedicated endpoint on create', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ id: 'client-uuid', clientId: 'my-client' }],
        })
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'scope-uuid', name: 'scope-a' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        defaultClientScopes: ['scope-a'],
      });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[4];
      expect(method).toBe('put');
      expect(url).toContain(`/clients/client-uuid/default-client-scopes/scope-uuid`);
    });

    test('attaches optional client scopes via dedicated endpoint on update', async () => {
      const existingClient = { id: 'client-uuid', clientId: 'my-client' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existingClient] }) // getClientByClientId (exists)
        .mockResolvedValueOnce({ status: 204 }) // update client
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'scope-uuid', name: 'scope-b' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        optionalClientScopes: ['scope-b'],
      });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[3];
      expect(method).toBe('put');
      expect(url).toContain('client-uuid/optional-client-scopes/scope-uuid');
    });

    test('attaches both default and optional scopes when both are provided', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ id: 'client-uuid', clientId: 'my-client' }],
        })
        // default scope lookup + attach
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'default-id', name: 'default-scope' }] })
        .mockResolvedValueOnce({ status: 204 })
        // optional scope lookup + attach
        .mockResolvedValueOnce({
          status: 200,
          data: [{ id: 'optional-id', name: 'optional-scope' }],
        })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        defaultClientScopes: ['default-scope'],
        optionalClientScopes: ['optional-scope'],
      });

      const defaultCall = utils.makeAuthenticatedRequest.mock.calls[4];
      const optionalCall = utils.makeAuthenticatedRequest.mock.calls[6];
      expect(defaultCall[1]).toContain('default-client-scopes/default-id');
      expect(optionalCall[1]).toContain('optional-client-scopes/optional-id');
    });

    test('throws when default scope is not defined at realm level', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ id: 'client-uuid', clientId: 'my-client' }],
        })
        // scope lookup returns no matching scope
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'other', name: 'other-scope' }] });

      await expect(
        createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
          clientId: 'my-client',
          defaultClientScopes: ['missing-scope'],
        }),
      ).rejects.toThrow(/"missing-scope".*not defined at the realm level/);
    });

    test('throws when optional scope is not defined at realm level', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ id: 'client-uuid', clientId: 'my-client' }],
        })
        .mockResolvedValueOnce({ status: 200, data: [] });

      await expect(
        createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
          clientId: 'my-client',
          optionalClientScopes: ['missing'],
        }),
      ).rejects.toThrow(/"missing".*not defined at the realm level/);
    });

    test('does not attach anything when scope arrays are empty', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, KEYCLOAK_URL, REALM, {
        clientId: 'my-client',
        defaultClientScopes: [],
        optionalClientScopes: [],
      });

      // Only two calls: lookup + create. No UUID lookup, no attach.
      expect(utils.makeAuthenticatedRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('getClientByClientId', () => {
    test('returns client when found', async () => {
      const client = { id: 'uuid-1', clientId: 'my-client' };
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [client] });
      const result = await getClientByClientId(TOKEN, KEYCLOAK_URL, REALM, 'my-client');
      expect(result).toEqual(client);
    });

    test('returns null when client not found (empty array)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await getClientByClientId(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBeNull();
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(getClientByClientId(TOKEN, KEYCLOAK_URL, REALM, 'my-client')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('createOrUpdateUser', () => {
    test('creates new user (POST) with all fields', async () => {
      // getUserByUsername returns null
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getUserByUsername (not found)
        .mockResolvedValueOnce({ status: 201 }) // create user
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'user-1', username: 'newuser' }] }) // getUserByUsername after create
        .mockResolvedValueOnce({ status: 204 }); // setUserPassword

      await createOrUpdateUser(
        TOKEN,
        KEYCLOAK_URL,
        REALM,
        {
          username: 'newuser',
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'User',
          enabled: true,
        },
        'password123',
      );

      const [method, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(data.username).toBe('newuser');
      expect(data.email).toBe('new@example.com');
      expect(data.firstName).toBe('New');
      expect(data.lastName).toBe('User');
    });

    test('creates user with only required fields', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'user-2', username: 'minimal' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'minimal' }, 'pw');

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.username).toBe('minimal');
      expect(data.email).toBeUndefined();
      expect(data.firstName).toBeUndefined();
    });

    test('updates existing user (PUT) with merged data', async () => {
      const existingUser = { id: 'user-existing', username: 'testuser', email: 'old@example.com' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existingUser] }) // getUserByUsername
        .mockResolvedValueOnce({ status: 204 }) // update user
        .mockResolvedValueOnce({ status: 204 }); // setUserPassword

      await createOrUpdateUser(
        TOKEN,
        KEYCLOAK_URL,
        REALM,
        {
          username: 'testuser',
          email: 'new@example.com',
        },
        'password',
      );

      const [method, url, data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('user-existing');
      expect(data.email).toBe('new@example.com');
    });

    test('sets password after creating user', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'user-new', username: 'u' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'u' }, 'pw');

      const [method, url, data] = utils.makeAuthenticatedRequest.mock.calls[3];
      expect(method).toBe('put');
      expect(url).toContain('user-new/reset-password');
      expect(data.value).toBe('pw');
    });

    test('sets password after updating user', async () => {
      const existing = { id: 'user-id', username: 'testuser' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existing] })
        .mockResolvedValueOnce({ status: 204 })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'testuser' }, 'newpw');

      const [, url] = utils.makeAuthenticatedRequest.mock.calls[2];
      expect(url).toContain('user-id/reset-password');
    });

    test('throws when created user cannot be retrieved', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getUserByUsername (not found)
        .mockResolvedValueOnce({ status: 201 }) // create user
        .mockResolvedValueOnce({ status: 200, data: [] }); // getUserByUsername returns empty

      await expect(
        createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'ghost' }, 'pw'),
      ).rejects.toThrow('Failed to retrieve user after creation: ghost');
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 400 });

      await expect(
        createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'bad' }, 'pw'),
      ).rejects.toThrow('Unexpected status code: 400');
    });

    test('defaults enabled to true when not specified', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'u1', username: 'x' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateUser(TOKEN, KEYCLOAK_URL, REALM, { username: 'x' }, 'pw');

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.enabled).toBe(true);
    });
  });

  describe('getUserByUsername', () => {
    test('returns user when found', async () => {
      const user = { id: 'u1', username: 'testuser' };
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [user] });
      const result = await getUserByUsername(TOKEN, KEYCLOAK_URL, REALM, 'testuser');
      expect(result).toEqual(user);
    });

    test('returns null when not found (empty array)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await getUserByUsername(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBeNull();
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(getUserByUsername(TOKEN, KEYCLOAK_URL, REALM, 'testuser')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('setUserPassword', () => {
    test('sends reset-password request with correct payload', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 204 });
      await setUserPassword(TOKEN, KEYCLOAK_URL, REALM, 'user-id', 'new-password');

      const [method, url, data, token] = utils.makeAuthenticatedRequest.mock.calls[0];
      expect(method).toBe('put');
      expect(url).toContain('user-id/reset-password');
      expect(data).toEqual({
        type: 'password',
        value: 'new-password',
        temporary: false,
      });
      expect(token).toBe(TOKEN);
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 400 });
      await expect(setUserPassword(TOKEN, KEYCLOAK_URL, REALM, 'user-id', 'pw')).rejects.toThrow(
        'Unexpected status code: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('timeout'));
      await expect(setUserPassword(TOKEN, KEYCLOAK_URL, REALM, 'user-id', 'pw')).rejects.toThrow(
        'timeout',
      );
    });
  });

  describe('createOrUpdateRole', () => {
    test('creates new role (POST) when role does not exist', async () => {
      // verifyRoleExists returns false, then create succeeds
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRoleExists
        .mockResolvedValueOnce({ status: 201 }); // create role

      await createOrUpdateRole(TOKEN, KEYCLOAK_URL, REALM, {
        name: 'admin-role',
        description: 'Admin',
      });

      const [method, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(data.name).toBe('admin-role');
    });

    test('updates existing role (PUT) when role exists', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200 }) // verifyRoleExists
        .mockResolvedValueOnce({ status: 204 }); // update role

      await createOrUpdateRole(TOKEN, KEYCLOAK_URL, REALM, {
        name: 'admin-role',
        description: 'Updated',
      });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('admin-role');
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 400 });

      await expect(
        createOrUpdateRole(TOKEN, KEYCLOAK_URL, REALM, { name: 'bad-role' }),
      ).rejects.toThrow('Unexpected status code: 400');
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockRejectedValueOnce(new Error('network error'));

      await expect(
        createOrUpdateRole(TOKEN, KEYCLOAK_URL, REALM, { name: 'role' }),
      ).rejects.toThrow('network error');
    });
  });

  describe('verifyClientExists', () => {
    test('returns true when client found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'c1', clientId: 'my-client' }],
      });
      const result = await verifyClientExists(TOKEN, KEYCLOAK_URL, REALM, 'my-client');
      expect(result).toBe(true);
    });

    test('returns false when client not found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await verifyClientExists(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyClientExists(TOKEN, KEYCLOAK_URL, REALM, 'client')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('verifyUserExists', () => {
    test('returns true when user found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'u1', username: 'testuser' }],
      });
      const result = await verifyUserExists(TOKEN, KEYCLOAK_URL, REALM, 'testuser');
      expect(result).toBe(true);
    });

    test('returns false when user not found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await verifyUserExists(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyUserExists(TOKEN, KEYCLOAK_URL, REALM, 'user')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('verifyRoleExists', () => {
    test('returns true for 200 response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200 });
      const result = await verifyRoleExists(TOKEN, KEYCLOAK_URL, REALM, 'admin');
      expect(result).toBe(true);
    });

    test('returns false for non-200 response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 404 });
      const result = await verifyRoleExists(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyRoleExists(TOKEN, KEYCLOAK_URL, REALM, 'role')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('getClientScopeByName', () => {
    test('returns scope when found by name', async () => {
      const scope = { id: 'scope-1', name: 'my-scope', protocol: 'openid-connect' };
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'other', name: 'other-scope' }, scope],
      });
      const result = await getClientScopeByName(TOKEN, KEYCLOAK_URL, REALM, 'my-scope');
      expect(result).toEqual(scope);
      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[0];
      expect(method).toBe('get');
      expect(url).toContain(`/realms/${REALM}/client-scopes`);
    });

    test('returns null when not found (empty array)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await getClientScopeByName(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBeNull();
    });

    test('returns null when name does not match any scope', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'a', name: 'not-mine' }],
      });
      const result = await getClientScopeByName(TOKEN, KEYCLOAK_URL, REALM, 'my-scope');
      expect(result).toBeNull();
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(getClientScopeByName(TOKEN, KEYCLOAK_URL, REALM, 'x')).rejects.toThrow(
        'server error',
      );
    });
  });

  describe('createOrUpdateClientScope', () => {
    test('creates new scope (POST) with openid-connect protocol when not found', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getClientScopeByName
        .mockResolvedValueOnce({ status: 201 }); // create

      await createOrUpdateClientScope(TOKEN, KEYCLOAK_URL, REALM, 'my-scope');

      const [method, url, data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(url).toContain(`/realms/${REALM}/client-scopes`);
      expect(data).toMatchObject({ name: 'my-scope', protocol: 'openid-connect' });
    });

    test('updates existing scope (PUT) when scope exists', async () => {
      const existing = { id: 'scope-uuid', name: 'my-scope', protocol: 'openid-connect' };
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [existing] }) // getClientScopeByName
        .mockResolvedValueOnce({ status: 204 }); // update

      await createOrUpdateClientScope(TOKEN, KEYCLOAK_URL, REALM, 'my-scope');

      const [method, url, data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('scope-uuid');
      expect(data.name).toBe('my-scope');
      // Existing fields are preserved on update
      expect(data.id).toBe('scope-uuid');
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 400 });

      await expect(
        createOrUpdateClientScope(TOKEN, KEYCLOAK_URL, REALM, 'bad-scope'),
      ).rejects.toThrow('Unexpected status code: 400');
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockRejectedValueOnce(new Error('network error'));

      await expect(
        createOrUpdateClientScope(TOKEN, KEYCLOAK_URL, REALM, 'my-scope'),
      ).rejects.toThrow('network error');
    });
  });

  describe('verifyClientScopeExists', () => {
    test('returns true when scope found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 's1', name: 'my-scope' }],
      });
      const result = await verifyClientScopeExists(TOKEN, KEYCLOAK_URL, REALM, 'my-scope');
      expect(result).toBe(true);
    });

    test('returns false when scope not found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await verifyClientScopeExists(TOKEN, KEYCLOAK_URL, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyClientScopeExists(TOKEN, KEYCLOAK_URL, REALM, 'scope')).rejects.toThrow(
        'server error',
      );
    });
  });
});
