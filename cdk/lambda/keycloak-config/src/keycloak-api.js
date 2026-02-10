/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Keycloak API functions for the Keycloak Configuration Lambda
 */
const axios = require('axios');
const config = require('./config');
const utils = require('./utils');

/**
 * Get token URL for Keycloak
 * @param {string} baseUrl - The base URL for the Keycloak server
 * @returns {string} - The token URL
 */
function getTokenUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/realms/master/protocol/openid-connect/token`;
}

/**
 * Get URL for a realm in Keycloak
 * @param {string} baseUrl - The base URL for the Keycloak server
 * @param {string} realm - The realm name
 * @returns {string} - The realm URL
 */
function getRealmUrl(baseUrl, realm) {
  return `${utils.getAdminApiUrl(baseUrl)}/realms/${encodeURIComponent(realm)}`;
}

/**
 * Get URL for clients in a realm
 * @param {string} baseUrl - The base URL for the Keycloak server
 * @param {string} realm - The realm name
 * @returns {string} - The clients URL
 */
function getClientsUrl(baseUrl, realm) {
  return `${getRealmUrl(baseUrl, realm)}/clients`;
}

/**
 * Get URL for users in a realm
 * @param {string} baseUrl - The base URL for the Keycloak server
 * @param {string} realm - The realm name
 * @returns {string} - The users URL
 */
function getUsersUrl(baseUrl, realm) {
  return `${getRealmUrl(baseUrl, realm)}/users`;
}

/**
 * Get URL for roles in a realm
 * @param {string} baseUrl - The base URL for the Keycloak server
 * @param {string} realm - The realm name
 * @returns {string} - The roles URL
 */
function getRolesUrl(baseUrl, realm) {
  return `${getRealmUrl(baseUrl, realm)}/roles`;
}

/**
 * Log in to Keycloak and get an access token
 * @param {string} username - Admin username
 * @param {string} password - Admin password
 * @returns {Promise<string>} - The access token
 */
async function login(username, password) {
  try {
    const tokenUrl = getTokenUrl(config.KEYCLOAK_URL);
    console.log(`Logging in to Keycloak at: ${tokenUrl}`);

    const data = {
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
      return response.data.access_token;
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
 * @param {string} username - Admin username
 * @param {string} password - Admin password
 * @returns {Promise<string>} - The access token
 */
async function loginWithRetry(username, password) {
  return utils.retry(
    () => login(username, password),
    config.API_MAX_RETRIES,
    config.API_RETRY_INTERVAL_MS,
    config.API_RETRY_INTERVAL_MS * 2,
  );
}

/**
 * Replace a placeholder value in a list of URIs
 * @param {string[]} uris - List of URI strings
 * @param {string} placeholder - Placeholder to match
 * @param {string|null} replacement - Value to substitute, or null to keep placeholder
 * @returns {string[]} - URIs with placeholders replaced
 */
function replacePlaceholders(uris, placeholder, replacement) {
  return uris.map(uri => (uri === placeholder && replacement ? replacement : uri));
}

/**
 * Create or update a realm
 * @param {string} token - Access token
 * @param {string} realmName - Name of the realm
 * @param {object} realmConfig - Realm configuration
 * @returns {Promise<void>} - Resolves when the realm is created or updated
 */
async function createOrUpdateRealmWithConfig(token, realmName, realmConfig) {
  // Declare outside try block to avoid reference errors in catch block
  let exists = false;

  try {
    // First, check if the realm exists
    exists = await verifyRealmExists(token, realmName);

    // If realm already exists, update it
    if (exists) {
      return await updateExistingRealm(token, realmName, realmConfig);
    }

    // For new realm creation, create a minimal realm first, then add properties
    console.log(`Creating minimal realm: ${realmName}`);

    // Create minimal realm configuration - just the required properties
    const minimalConfig = {
      realm: realmName,
      enabled: true,
      displayName: realmConfig.displayName || `${realmName} Realm`,
    };

    // Important: Use the base admin URL
    const adminUrl = utils.getAdminApiUrl(config.KEYCLOAK_URL);
    const url = `${adminUrl}/realms`;

    console.log(`Request URL (minimal config): ${url}, Method: post`);
    console.log(`Minimal realm config: ${JSON.stringify(minimalConfig)}`);

    // Create the realm with minimal configuration first
    const response = await utils.makeAuthenticatedRequest('post', url, minimalConfig, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully created minimal realm: ${realmName}`);

      // If we have clients and users defined, we'll add them separately
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
 * @param {string} token - Access token
 * @param {string} realmName - Name of the realm
 * @param {object} realmConfig - Realm configuration
 * @returns {Promise<void>} - Resolves when the realm is updated
 */
async function updateExistingRealm(token, realmName, realmConfig) {
  try {
    // Create the config object with defaults
    const baseConfig = {
      realm: realmName,
      enabled: true,
    };

    // Merge with custom config - exclude clients and users which we'll handle separately
    const realmProperties = Object.fromEntries(
      Object.entries(realmConfig).filter(([key]) => key !== 'clients' && key !== 'users'),
    );
    const updateConfig = { ...baseConfig, ...realmProperties };

    const adminUrl = utils.getAdminApiUrl(config.KEYCLOAK_URL);
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {object} clientConfig - Client configuration
 * @returns {Promise<void>} - Resolves when the client is created or updated
 */
async function createOrUpdateClient(token, realm, clientConfig) {
  // Declare outside try block to avoid reference errors in catch block
  let clientExists = false;

  try {
    const clientId = clientConfig.clientId;

    // Check if the client exists
    const existingClient = await getClientByClientId(token, realm, clientId);
    clientExists = !!existingClient;

    const clientsUrl = getClientsUrl(config.KEYCLOAK_URL, realm);
    const method = clientExists ? 'put' : 'post';
    const url = clientExists ? `${clientsUrl}/${existingClient.id}` : clientsUrl;

    console.log(`${clientExists ? 'Updating' : 'Creating'} client: ${clientId} in realm: ${realm}`);

    // Create a clean client config, removing unsupported fields
    // Extract fields that need special handling
    const { websiteUri, postLogoutRedirectUris, ...cleanClientConfig } = clientConfig;

    // Initialize attributes if not present
    cleanClientConfig.attributes = cleanClientConfig.attributes || {};

    // Handle postLogoutRedirectUris - in Keycloak these belong in attributes
    if (postLogoutRedirectUris && postLogoutRedirectUris.length > 0) {
      const processedUris = replacePlaceholders(
        postLogoutRedirectUris,
        '__PLACEHOLDER_REDIRECT_URI__',
        websiteUri ? `${websiteUri}/*` : null,
      );

      // Store as string in attributes as per Keycloak format
      cleanClientConfig.attributes['post.logout.redirect.uris'] = processedUris.join(',');
      console.log(
        `Processed postLogoutRedirectUris into attributes: ${cleanClientConfig.attributes['post.logout.redirect.uris']}`,
      );
    }

    // Handle placeholders in redirectUris
    if (cleanClientConfig.redirectUris) {
      cleanClientConfig.redirectUris = replacePlaceholders(
        cleanClientConfig.redirectUris,
        '__PLACEHOLDER_REDIRECT_URI__',
        websiteUri ? `${websiteUri}/*` : null,
      );
      console.log(`Processed redirectUris: ${JSON.stringify(cleanClientConfig.redirectUris)}`);
    }

    // Handle placeholders in webOrigins
    if (cleanClientConfig.webOrigins) {
      cleanClientConfig.webOrigins = replacePlaceholders(
        cleanClientConfig.webOrigins,
        '__PLACEHOLDER_WEB_ORIGIN__',
        websiteUri || null,
      );
      console.log(`Processed webOrigins: ${JSON.stringify(cleanClientConfig.webOrigins)}`);
    }

    // If updating, merge with existing client config and include ID
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} clientId - Client ID
 * @returns {Promise<object|null>} - The client configuration or null if not found
 */
async function getClientByClientId(token, realm, clientId) {
  try {
    const clientsUrl = getClientsUrl(config.KEYCLOAK_URL, realm);
    console.log(`Getting client by clientId: ${clientId} in realm: ${realm}`);

    const url = `${clientsUrl}?clientId=${encodeURIComponent(clientId)}`;
    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    if (response.status === 200 && Array.isArray(response.data)) {
      const clients = response.data;
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {object} userConfig - User configuration
 * @param {string} password - User password
 * @returns {Promise<void>} - Resolves when the user is created or updated
 */
async function createOrUpdateUser(token, realm, userConfig, password) {
  // Declare outside try block to avoid reference errors in catch block
  let userExists = false;

  try {
    const username = userConfig.username;

    // Check if the user exists
    const existingUser = await getUserByUsername(token, realm, username);
    userExists = !!existingUser;

    const usersUrl = getUsersUrl(config.KEYCLOAK_URL, realm);
    const method = userExists ? 'put' : 'post';
    const url = userExists ? `${usersUrl}/${existingUser.id}` : usersUrl;

    console.log(`${userExists ? 'Updating' : 'Creating'} user: ${username} in realm: ${realm}`);

    // Create user object from config
    let userData = {
      username,
      enabled: userConfig.enabled !== false, // Default to true
      emailVerified: true,
    };

    // Add optional fields if provided
    if (userConfig.email) userData.email = userConfig.email;
    if (userConfig.firstName) userData.firstName = userConfig.firstName;
    if (userConfig.lastName) userData.lastName = userConfig.lastName;

    // If updating, merge with existing user data and include ID
    if (userExists) {
      userData = { ...existingUser, ...userData };
    }

    // Create or update the user
    const response = await utils.makeAuthenticatedRequest(method, url, userData, token);

    if (response.status >= 200 && response.status < 300) {
      console.log(`Successfully ${userExists ? 'updated' : 'created'} user: ${username}`);

      // Get user ID (either from existing user or by looking up the newly created user)
      let userId;
      if (userExists) {
        userId = existingUser.id;
      } else {
        const createdUser = await getUserByUsername(token, realm, username);
        if (!createdUser) throw new Error(`Failed to retrieve user after creation: ${username}`);
        userId = createdUser.id;
      }

      // Set the user's password
      await setUserPassword(token, realm, userId, password);
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} username - Username
 * @returns {Promise<object|null>} - The user or null if not found
 */
async function getUserByUsername(token, realm, username) {
  try {
    const usersUrl = getUsersUrl(config.KEYCLOAK_URL, realm);
    console.log(`Getting user by username: ${username} in realm: ${realm}`);

    const url = `${usersUrl}?username=${encodeURIComponent(username)}&exact=true`;
    const response = await utils.makeAuthenticatedRequest('get', url, null, token);

    if (response.status === 200 && Array.isArray(response.data)) {
      const users = response.data;
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} userId - User ID
 * @param {string} password - Password
 * @returns {Promise<void>} - Resolves when the password is set
 */
async function setUserPassword(token, realm, userId, password) {
  try {
    const usersUrl = getUsersUrl(config.KEYCLOAK_URL, realm);
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {object} roleConfig - Role configuration
 * @returns {Promise<void>} - Resolves when the role is created or updated
 */
async function createOrUpdateRole(token, realm, roleConfig) {
  // Declare outside try block to avoid reference errors in catch block
  let roleExists = false;

  try {
    const roleName = roleConfig.name;

    // Check if the role exists
    roleExists = await verifyRoleExists(token, realm, roleName);

    const rolesUrl = getRolesUrl(config.KEYCLOAK_URL, realm);
    const method = roleExists ? 'put' : 'post';
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @returns {Promise<boolean>} - Whether the realm exists
 */
async function verifyRealmExists(token, realm) {
  try {
    const url = getRealmUrl(config.KEYCLOAK_URL, realm);
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
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} clientId - Client ID
 * @returns {Promise<boolean>} - Whether the client exists
 */
async function verifyClientExists(token, realm, clientId) {
  try {
    const client = await getClientByClientId(token, realm, clientId);
    return !!client;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying client: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a user exists
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} username - Username
 * @returns {Promise<boolean>} - Whether the user exists
 */
async function verifyUserExists(token, realm, username) {
  try {
    const user = await getUserByUsername(token, realm, username);
    return !!user;
  } catch (error) {
    const errorMessage = utils.formatError(error);
    console.error(`Error verifying user: ${errorMessage}`);
    throw error;
  }
}

/**
 * Verify if a role exists
 * @param {string} token - Access token
 * @param {string} realm - Name of the realm
 * @param {string} roleName - Role name
 * @returns {Promise<boolean>} - Whether the role exists
 */
async function verifyRoleExists(token, realm, roleName) {
  try {
    const url = `${getRolesUrl(config.KEYCLOAK_URL, realm)}/${roleName}`;
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

module.exports = {
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
  // Export helper functions needed for validation and testing
  getClientByClientId,
  getUserByUsername,
  setUserPassword,
};
