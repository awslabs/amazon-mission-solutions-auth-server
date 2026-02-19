/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

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
  verifyClientExists,
  verifyUserExists,
  verifyRoleExists,
} = require('../src/keycloak-api');

const TOKEN = 'test-access-token';
const REALM = 'test-realm';

describe('keycloak-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    test('returns access token on successful login', async () => {
      axios.post.mockResolvedValue({
        data: { access_token: 'my-token' },
      });
      const token = await login('admin', 'password');
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
      await expect(login('admin', 'password')).rejects.toThrow(
        'Received response without access token',
      );
    });

    test('throws on axios error', async () => {
      axios.post.mockRejectedValue(new Error('network error'));
      await expect(login('admin', 'password')).rejects.toThrow('network error');
    });
  });

  describe('loginWithRetry', () => {
    test('delegates to utils.retry with login function', async () => {
      axios.post.mockResolvedValue({ data: { access_token: 'retry-token' } });
      const token = await loginWithRetry('admin', 'password');
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
      const result = await verifyRealmExists(TOKEN, REALM);
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
      const result = await verifyRealmExists(TOKEN, REALM);
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyRealmExists(TOKEN, REALM)).rejects.toThrow('server error');
    });
  });

  describe('createOrUpdateRealmWithConfig', () => {
    test('creates new realm when realm does not exist', async () => {
      // verifyRealmExists returns false (realm does not exist)
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRealmExists
        .mockResolvedValueOnce({ status: 201 }); // create realm

      await createOrUpdateRealmWithConfig(TOKEN, REALM, {
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

      await createOrUpdateRealmWithConfig(TOKEN, REALM, {
        displayName: 'Updated Realm',
      });

      const [method] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
    });

    test('uses displayName from config when provided', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, REALM, {
        displayName: 'Custom Display',
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.displayName).toBe('Custom Display');
    });

    test('defaults displayName to "{realmName} Realm"', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, REALM, {});

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.displayName).toBe(`${REALM} Realm`);
    });

    test('logs client/user counts when present in config', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateRealmWithConfig(TOKEN, REALM, {
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

      await expect(createOrUpdateRealmWithConfig(TOKEN, REALM, {})).rejects.toThrow(
        'Unexpected status code when creating realm: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRealmExists
        .mockRejectedValueOnce(new Error('network error'));

      await expect(createOrUpdateRealmWithConfig(TOKEN, REALM, {})).rejects.toThrow(
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

      await createOrUpdateClient(TOKEN, REALM, {
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

      await createOrUpdateClient(TOKEN, REALM, {
        clientId: 'my-client',
        name: 'Updated',
      });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('uuid-123');
    });

    test('replaces __PLACEHOLDER_REDIRECT_URI__ in redirectUris', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, REALM, {
        clientId: 'my-client',
        websiteUri: 'https://myapp.com',
        redirectUris: ['__PLACEHOLDER_REDIRECT_URI__', 'https://other.com/*'],
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.redirectUris).toEqual(['https://myapp.com/*', 'https://other.com/*']);
    });

    test('replaces __PLACEHOLDER_WEB_ORIGIN__ in webOrigins', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, REALM, {
        clientId: 'my-client',
        websiteUri: 'https://myapp.com',
        webOrigins: ['__PLACEHOLDER_WEB_ORIGIN__'],
      });

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.webOrigins).toEqual(['https://myapp.com']);
    });

    test('processes postLogoutRedirectUris into attributes', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 });

      await createOrUpdateClient(TOKEN, REALM, {
        clientId: 'my-client',
        websiteUri: 'https://myapp.com',
        postLogoutRedirectUris: ['__PLACEHOLDER_REDIRECT_URI__', 'https://other.com/logout'],
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

      await createOrUpdateClient(TOKEN, REALM, {
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

      await expect(createOrUpdateClient(TOKEN, REALM, { clientId: 'my-client' })).rejects.toThrow(
        'Unexpected status code: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockRejectedValueOnce(new Error('request failed'));

      await expect(createOrUpdateClient(TOKEN, REALM, { clientId: 'my-client' })).rejects.toThrow(
        'request failed',
      );
    });
  });

  describe('getClientByClientId', () => {
    test('returns client when found', async () => {
      const client = { id: 'uuid-1', clientId: 'my-client' };
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [client] });
      const result = await getClientByClientId(TOKEN, REALM, 'my-client');
      expect(result).toEqual(client);
    });

    test('returns null when client not found (empty array)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await getClientByClientId(TOKEN, REALM, 'missing');
      expect(result).toBeNull();
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(getClientByClientId(TOKEN, REALM, 'my-client')).rejects.toThrow('server error');
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

      await createOrUpdateUser(TOKEN, REALM, { username: 'minimal' }, 'pw');

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

      await createOrUpdateUser(TOKEN, REALM, { username: 'u' }, 'pw');

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

      await createOrUpdateUser(TOKEN, REALM, { username: 'testuser' }, 'newpw');

      const [, url] = utils.makeAuthenticatedRequest.mock.calls[2];
      expect(url).toContain('user-id/reset-password');
    });

    test('throws when created user cannot be retrieved', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] }) // getUserByUsername (not found)
        .mockResolvedValueOnce({ status: 201 }) // create user
        .mockResolvedValueOnce({ status: 200, data: [] }); // getUserByUsername returns empty

      await expect(createOrUpdateUser(TOKEN, REALM, { username: 'ghost' }, 'pw')).rejects.toThrow(
        'Failed to retrieve user after creation: ghost',
      );
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 400 });

      await expect(createOrUpdateUser(TOKEN, REALM, { username: 'bad' }, 'pw')).rejects.toThrow(
        'Unexpected status code: 400',
      );
    });

    test('defaults enabled to true when not specified', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200, data: [{ id: 'u1', username: 'x' }] })
        .mockResolvedValueOnce({ status: 204 });

      await createOrUpdateUser(TOKEN, REALM, { username: 'x' }, 'pw');

      const [, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(data.enabled).toBe(true);
    });
  });

  describe('getUserByUsername', () => {
    test('returns user when found', async () => {
      const user = { id: 'u1', username: 'testuser' };
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [user] });
      const result = await getUserByUsername(TOKEN, REALM, 'testuser');
      expect(result).toEqual(user);
    });

    test('returns null when not found (empty array)', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await getUserByUsername(TOKEN, REALM, 'missing');
      expect(result).toBeNull();
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(getUserByUsername(TOKEN, REALM, 'testuser')).rejects.toThrow('server error');
    });
  });

  describe('setUserPassword', () => {
    test('sends reset-password request with correct payload', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 204 });
      await setUserPassword(TOKEN, REALM, 'user-id', 'new-password');

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
      await expect(setUserPassword(TOKEN, REALM, 'user-id', 'pw')).rejects.toThrow(
        'Unexpected status code: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('timeout'));
      await expect(setUserPassword(TOKEN, REALM, 'user-id', 'pw')).rejects.toThrow('timeout');
    });
  });

  describe('createOrUpdateRole', () => {
    test('creates new role (POST) when role does not exist', async () => {
      // verifyRoleExists returns false, then create succeeds
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 }) // verifyRoleExists
        .mockResolvedValueOnce({ status: 201 }); // create role

      await createOrUpdateRole(TOKEN, REALM, { name: 'admin-role', description: 'Admin' });

      const [method, , data] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('post');
      expect(data.name).toBe('admin-role');
    });

    test('updates existing role (PUT) when role exists', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 200 }) // verifyRoleExists
        .mockResolvedValueOnce({ status: 204 }); // update role

      await createOrUpdateRole(TOKEN, REALM, { name: 'admin-role', description: 'Updated' });

      const [method, url] = utils.makeAuthenticatedRequest.mock.calls[1];
      expect(method).toBe('put');
      expect(url).toContain('admin-role');
    });

    test('throws on non-2xx response', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ status: 400 });

      await expect(createOrUpdateRole(TOKEN, REALM, { name: 'bad-role' })).rejects.toThrow(
        'Unexpected status code: 400',
      );
    });

    test('throws on request error', async () => {
      utils.makeAuthenticatedRequest
        .mockResolvedValueOnce({ status: 404 })
        .mockRejectedValueOnce(new Error('network error'));

      await expect(createOrUpdateRole(TOKEN, REALM, { name: 'role' })).rejects.toThrow(
        'network error',
      );
    });
  });

  describe('verifyClientExists', () => {
    test('returns true when client found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'c1', clientId: 'my-client' }],
      });
      const result = await verifyClientExists(TOKEN, REALM, 'my-client');
      expect(result).toBe(true);
    });

    test('returns false when client not found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await verifyClientExists(TOKEN, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyClientExists(TOKEN, REALM, 'client')).rejects.toThrow('server error');
    });
  });

  describe('verifyUserExists', () => {
    test('returns true when user found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({
        status: 200,
        data: [{ id: 'u1', username: 'testuser' }],
      });
      const result = await verifyUserExists(TOKEN, REALM, 'testuser');
      expect(result).toBe(true);
    });

    test('returns false when user not found', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200, data: [] });
      const result = await verifyUserExists(TOKEN, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on error', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyUserExists(TOKEN, REALM, 'user')).rejects.toThrow('server error');
    });
  });

  describe('verifyRoleExists', () => {
    test('returns true for 200 response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 200 });
      const result = await verifyRoleExists(TOKEN, REALM, 'admin');
      expect(result).toBe(true);
    });

    test('returns false for non-200 response', async () => {
      utils.makeAuthenticatedRequest.mockResolvedValue({ status: 404 });
      const result = await verifyRoleExists(TOKEN, REALM, 'missing');
      expect(result).toBe(false);
    });

    test('throws on errors', async () => {
      utils.makeAuthenticatedRequest.mockRejectedValue(new Error('server error'));
      await expect(verifyRoleExists(TOKEN, REALM, 'role')).rejects.toThrow('server error');
    });
  });
});
