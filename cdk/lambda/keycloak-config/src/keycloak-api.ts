/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Keycloak API functions for the Keycloak Configuration Lambda.
 */
import axios from 'axios';

import config = require('./config');
import {
  KeycloakClientConfig,
  KeycloakClientResponse,
  KeycloakRealmConfig,
  KeycloakRoleConfig,
  KeycloakUserConfig,
  KeycloakUserResponse,
} from './types';
import utils = require('./utils');

/**
 * Get token URL for Keycloak
 */
function getTokenUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/realms/master/protocol/openid-connect/token`;
}

/**
 * Get URL for a realm in Keycloak
 */
function getRealmUrl(baseUrl: string, realm: string): string {
  return `${utils.getAdminApiUrl(baseUrl)}/realms/${encodeURIComponent(realm)}`;
}

/**
 * Get URL for clients in a realm
 */
function getClientsUrl(baseUrl: string, realm: string): string {
  return `${getRealmUrl(baseUrl, realm)}/clients`;
}

/**
 * Get URL for users in a realm
 */
function getUsersUrl(baseUrl: string, realm: string): string {
  return `${getRealmUrl(baseUrl, realm)}/users`;
}

/**
 * Get URL for roles in a realm
 */
function getRolesUrl(baseUrl: string, realm: string): string {
  return `${getRealmUrl(baseUrl, realm)}/roles`;
}

/**
 * Log in to Keycloak and get an access token
 */
async function login(keycloakUrl: string, username: string, password: string): Promise<string> {
  try {
    const tokenUrl = getTokenUrl(keycloakUrl);
    console.log(`Logging in to Keycloak at: ${tokenUrl}`);

    const data: Record<string, string> = {
      username,
      password,
      grant_type: 'password',
      client_id: 'admin-cli',
    };

    const response = await axios.post(tokenUrl, new URLSearchParams(data).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: config.API_TIMEOUT_MS,
    });

    if (response.data && response.data.access_token) {
      console.log(`Successfully logged in as ${username}`);
      return response.data.access_token as string;
    } else {
      throw new Error('Received response without access token');
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Login failed: ${errorMessage}`);
    throw error;
  }
}

/**
 * Login with retry logic
 */
async function loginWithRetry(
  keycloakUrl: string,
  username: string,
  password: string,
): Promise<string> {
  return utils.retry(
    () => login(keycloakUrl, username, password),
    config.API_MAX_RETRIES,
    config.API_RETRY_INTERVAL_MS,
    config.API_RETRY_INTERVAL_MS * 2,
  );
}

/**
 * Replace a placeholder value in a list of URIs
 */
function replacePlaceholders(
  uris: string[],
  placeholder: string,
  replacement: string | null,
): string[] {
  return uris.map(uri => (uri === placeholder && replacement ? replacement : uri));
}

/**
 * Create or update a realm
 */
async function createOrUpdateRealmWithConfig(
  token: string,
  keycloakUrl: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<void> {
  let exists = false;

  try {
    exists = await verifyRealmExists(token, keycloakUrl, realmName);

    if (exists) {
      return await updateExistingRealm(token, keycloakUrl, realmName, realmConfig);
    }

    console.log(`Creating minimal realm: ${realmName}`);

    const minimalConfig = {
      realm: realmName,
      enabled: true,
      displayName: realmConfig.displayName || `${realmName} Realm`,
    };

    const adminUrl = utils.getAdminApiUrl(keycloakUrl);
    const url = `${adminUrl}/realms`;

    console.log(`Request URL (minimal config): ${url}, Method: post`);
    console.log(`Minimal realm config: ${JSON.stringify(minimalConfig)}`);

    const response = await utils.makeAuthenticatedRequest('post', url, minimalConfig, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully created minimal realm: ${realmName}`);

      if (realmConfig.clients && realmConfig.clients.length > 0) {
        console.log(`Will add ${realmConfig.clients.length} client(s) separately`);
      }

      if (realmConfig.users && realmConfig.users.length > 0) {
        console.log(`Will add ${realmConfig.users.length} user(s) separately`);
      }
    } else {
      throw new Error(`Unexpected status code when creating realm: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to ${exists ? 'update' : 'create'} realm: ${errorMessage}`);
    throw error;
  }
}

/**
 * Update an existing realm
 */
async function updateExistingRealm(
  token: string,
  keycloakUrl: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<void> {
  try {
    const baseConfig: Record<string, unknown> = {
      realm: realmName,
      enabled: true,
    };

    const realmProperties = Object.fromEntries(
      Object.entries(realmConfig).filter(([key]) => key !== 'clients' && key !== 'users'),
    );
    const updateConfig = { ...baseConfig, ...realmProperties };

    const adminUrl = utils.getAdminApiUrl(keycloakUrl);
    const url = `${adminUrl}/realms/${realmName}`;

    console.log(`Updating realm: ${realmName}`);
    console.log(`Request URL: ${url}, Method: put`);

    const response = await utils.makeAuthenticatedRequest('put', url, updateConfig, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully updated realm: ${realmName}`);
    } else {
      throw new Error(`Unexpected status code when updating realm: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to update realm: ${errorMessage}`);
    throw error;
  }
}

/**
 * Create or update a client
 */
async function createOrUpdateClient(
  token: string,
  keycloakUrl: string,
  realm: string,
  clientConfig: KeycloakClientConfig,
): Promise<void> {
  let clientExists = false;

  try {
    const clientId = clientConfig.clientId;

    const existingClient = await getClientByClientId(token, keycloakUrl, realm, clientId);
    clientExists = !!existingClient;

    const clientsUrl = getClientsUrl(keycloakUrl, realm);
    const method = clientExists ? ('put' as const) : ('post' as const);
    const url = clientExists ? `${clientsUrl}/${existingClient!.id}` : clientsUrl;

    console.log(`${clientExists ? 'Updating' : 'Creating'} client: ${clientId} in realm: ${realm}`);

    const { websiteUri, postLogoutRedirectUris, ...cleanClientConfig } = clientConfig;

    cleanClientConfig.attributes = cleanClientConfig.attributes || {};

    if (postLogoutRedirectUris && postLogoutRedirectUris.length > 0) {
      const processedUris = replacePlaceholders(
        postLogoutRedirectUris,
        '__PLACEHOLDER_REDIRECT_URI__',
        websiteUri ? `${websiteUri}/*` : null,
      );

      cleanClientConfig.attributes!['post.logout.redirect.uris'] = processedUris.join(',');
      console.log(
        `Processed postLogoutRedirectUris into attributes: ${cleanClientConfig.attributes!['post.logout.redirect.uris']}`,
      );
    }

    if (cleanClientConfig.redirectUris) {
      cleanClientConfig.redirectUris = replacePlaceholders(
        cleanClientConfig.redirectUris,
        '__PLACEHOLDER_REDIRECT_URI__',
        websiteUri ? `${websiteUri}/*` : null,
      );
      console.log(`Processed redirectUris: ${JSON.stringify(cleanClientConfig.redirectUris)}`);
    }

    if (cleanClientConfig.webOrigins) {
      cleanClientConfig.webOrigins = replacePlaceholders(
        cleanClientConfig.webOrigins,
        '__PLACEHOLDER_WEB_ORIGIN__',
        websiteUri || null,
      );
      console.log(`Processed webOrigins: ${JSON.stringify(cleanClientConfig.webOrigins)}`);
    }

    const fullConfig = clientExists
      ? { ...existingClient, ...cleanClientConfig }
      : cleanClientConfig;

    console.log(`Sending client config to Keycloak: ${JSON.stringify(fullConfig, null, 2)}`);

    const response = await utils.makeAuthenticatedRequest(method, url, fullConfig, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully ${clientExists ? 'updated' : 'created'} client: ${clientId}`);
    } else {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to ${clientExists ? 'update' : 'create'} client: ${errorMessage}`);
    throw error;
  }
}

/**
 * Get client by client ID
 */
async function getClientByClientId(
  token: string,
  keycloakUrl: string,
  realm: string,
  clientId: string,
): Promise<KeycloakClientResponse | null> {
  try {
    const clientsUrl = getClientsUrl(keycloakUrl, realm);
    console.log(`Getting client by clientId: ${clientId} in realm: ${realm}`);

    const url = `${clientsUrl}?clientId=${encodeURIComponent(clientId)}`;
    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    if (response.status === 200 && Array.isArray(response.data)) {
      const clients = response.data as KeycloakClientResponse[];
      if (clients.length > 0) {
        console.log(`Found client: ${clientId}`);
        return clients[0];
      }
    }

    console.log(`Client not found: ${clientId}`);
    return null;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error getting client: ${errorMessage}`);
    throw error;
  }
}

/**
 * Create or update a user
 */
async function createOrUpdateUser(
  token: string,
  keycloakUrl: string,
  realm: string,
  userConfig: KeycloakUserConfig,
  password: string,
): Promise<void> {
  let userExists = false;

  try {
    const username = userConfig.username;

    const existingUser = await getUserByUsername(token, keycloakUrl, realm, username);
    userExists = !!existingUser;

    const usersUrl = getUsersUrl(keycloakUrl, realm);
    const method = userExists ? ('put' as const) : ('post' as const);
    const url = userExists ? `${usersUrl}/${existingUser!.id}` : usersUrl;

    console.log(`${userExists ? 'Updating' : 'Creating'} user: ${username} in realm: ${realm}`);

    let userData: Record<string, unknown> = {
      username,
      enabled: userConfig.enabled !== false,
      emailVerified: true,
    };

    if (userConfig.email) userData.email = userConfig.email;
    if (userConfig.firstName) userData.firstName = userConfig.firstName;
    if (userConfig.lastName) userData.lastName = userConfig.lastName;

    if (userExists) {
      userData = { ...existingUser, ...userData };
    }

    const response = await utils.makeAuthenticatedRequest(method, url, userData, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully ${userExists ? 'updated' : 'created'} user: ${username}`);

      let userId: string;
      if (userExists) {
        userId = existingUser!.id;
      } else {
        const createdUser = await getUserByUsername(token, keycloakUrl, realm, username);
        if (!createdUser) throw new Error(`Failed to retrieve user after creation: ${username}`);
        userId = createdUser.id;
      }

      await setUserPassword(token, keycloakUrl, realm, userId, password);
    } else {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to ${userExists ? 'update' : 'create'} user: ${errorMessage}`);
    throw error;
  }
}

/**
 * Get user by username
 */
async function getUserByUsername(
  token: string,
  keycloakUrl: string,
  realm: string,
  username: string,
): Promise<KeycloakUserResponse | null> {
  try {
    const usersUrl = getUsersUrl(keycloakUrl, realm);
    console.log(`Getting user by username: ${username} in realm: ${realm}`);

    const url = `${usersUrl}?username=${encodeURIComponent(username)}&exact=true`;
    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    if (response.status === 200 && Array.isArray(response.data)) {
      const users = response.data as KeycloakUserResponse[];
      if (users.length > 0) {
        console.log(`Found user: ${username}`);
        return users[0];
      }
    }

    console.log(`User not found: ${username}`);
    return null;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error getting user: ${errorMessage}`);
    throw error;
  }
}

/**
 * Set user password
 */
async function setUserPassword(
  token: string,
  keycloakUrl: string,
  realm: string,
  userId: string,
  password: string,
): Promise<void> {
  try {
    const usersUrl = getUsersUrl(keycloakUrl, realm);
    console.log(`Setting password for user ID: ${userId} in realm: ${realm}`);

    const url = `${usersUrl}/${userId}/reset-password`;
    const data = {
      type: 'password',
      value: password,
      temporary: false,
    };

    const response = await utils.makeAuthenticatedRequest('put', url, data, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully set password for user ID: ${userId}`);
    } else {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to set password: ${errorMessage}`);
    throw error;
  }
}

/**
 * Create or update a role
 */
async function createOrUpdateRole(
  token: string,
  keycloakUrl: string,
  realm: string,
  roleConfig: KeycloakRoleConfig,
): Promise<void> {
  let roleExists = false;

  try {
    const roleName = roleConfig.name;

    roleExists = await verifyRoleExists(token, keycloakUrl, realm, roleName);

    const rolesUrl = getRolesUrl(keycloakUrl, realm);
    const method = roleExists ? ('put' as const) : ('post' as const);
    const url = roleExists ? `${rolesUrl}/${roleName}` : rolesUrl;

    console.log(`${roleExists ? 'Updating' : 'Creating'} role: ${roleName} in realm: ${realm}`);

    const response = await utils.makeAuthenticatedRequest(method, url, roleConfig, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully ${roleExists ? 'updated' : 'created'} role: ${roleName}`);
    } else {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Failed to ${roleExists ? 'update' : 'create'} role: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a realm exists
 */
async function verifyRealmExists(
  token: string,
  keycloakUrl: string,
  realm: string,
): Promise<boolean> {
  try {
    const url = getRealmUrl(keycloakUrl, realm);
    console.log(`Verifying realm exists: ${realm}`);

    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    const exists = response.status === 200;
    console.log(`Realm ${realm} ${exists ? 'exists' : 'does not exist'}`);
    return exists;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying realm: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a client exists
 */
async function verifyClientExists(
  token: string,
  keycloakUrl: string,
  realm: string,
  clientId: string,
): Promise<boolean> {
  try {
    const client = await getClientByClientId(token, keycloakUrl, realm, clientId);
    return !!client;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying client: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a user exists
 */
async function verifyUserExists(
  token: string,
  keycloakUrl: string,
  realm: string,
  username: string,
): Promise<boolean> {
  try {
    const user = await getUserByUsername(token, keycloakUrl, realm, username);
    return !!user;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying user: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a role exists
 */
async function verifyRoleExists(
  token: string,
  keycloakUrl: string,
  realm: string,
  roleName: string,
): Promise<boolean> {
  try {
    const url = `${getRolesUrl(keycloakUrl, realm)}/${roleName}`;
    console.log(`Verifying role exists: ${roleName}`);

    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    const exists = response.status === 200;
    console.log(`Role ${roleName} ${exists ? 'exists' : 'does not exist'}`);
    return exists;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying role: ${errorMessage}`);
    throw error;
  }
}

export = {
  login,
  loginWithRetry,
  createOrUpdateRealmWithConfig,
  createOrUpdateClient,
  createOrUpdateUser,
  createOrUpdateRole,
  verifyRealmExists,
  verifyClientExists,
  verifyUserExists,
  verifyRoleExists,
  getClientByClientId,
  getUserByUsername,
  setUserPassword,
};
