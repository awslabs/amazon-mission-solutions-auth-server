/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * AWS utility functions for the Keycloak Configuration Lambda
 */
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');
const config = require('./config');

// Create AWS SDK clients
const secretsManager = new SecretsManagerClient();

/**
 * Retrieve the admin credentials from AWS Secrets Manager
 */
async function getAdminCredentials() {
  const secretArn = config.KEYCLOAK_ADMIN_SECRET_ARN;

  if (!secretArn) {
    throw new Error('Keycloak admin secret ARN is not provided in environment variables');
  }

  try {
    console.log(`Retrieving admin credentials from secret: ${secretArn}`);
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );

    if (!('SecretString' in response)) {
      throw new Error('Secret is binary and not supported');
    }

    const secretString = response.SecretString;
    const secretObject = JSON.parse(secretString);

    if (!secretObject.username || !secretObject.password) {
      throw new Error('Admin secret must contain username and password keys');
    }

    // Verify that username matches expected admin username
    if (secretObject.username !== config.KEYCLOAK_ADMIN_USERNAME) {
      console.warn(
        `Username in secret (${secretObject.username}) does not match configured admin username (${config.KEYCLOAK_ADMIN_USERNAME}). Using secret value.`,
      );
    }

    return {
      username: secretObject.username,
      password: secretObject.password,
    };
  } catch (error) {
    console.error('Error retrieving admin credentials:', error);
    throw new Error(`Failed to retrieve admin credentials: ${error.message}`);
  }
}

/**
 * Get or create a user password from AWS Secrets Manager
 * @param {string} username - The username of the user
 * @returns {Promise<string>} - The password for the user
 */
async function getOrCreateUserPassword(username) {
  // Get the ARNs of user password secrets
  const userPasswordSecrets = config.getUserPasswordSecrets();

  const secretArn = userPasswordSecrets[username];
  if (!secretArn) {
    throw new Error(`No secret ARN found for user: ${username}`);
  }

  try {
    console.log(`Retrieving password for user ${username} from secret: ${secretArn}`);
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );

    let password;
    if ('SecretString' in response) {
      // For simple string secrets
      if (response.SecretString.startsWith('{')) {
        try {
          const parsed = JSON.parse(response.SecretString);
          if (parsed.password) {
            password = parsed.password;
          } else {
            password = response.SecretString;
          }
        } catch {
          // If not valid JSON, use the raw string as password
          password = response.SecretString;
        }
      } else {
        password = response.SecretString;
      }
    } else {
      throw new Error('Binary secrets are not supported');
    }

    return password;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.log(`Secret not found for user ${username}, will be created by CDK`);
      // Return a placeholder for now - actual password will be created by CDK
      return 'placeholder-password-will-be-created-by-cdk';
    }

    console.error(`Error retrieving password for user ${username}:`, error);
    throw new Error(`Failed to retrieve password for user ${username}: ${error.message}`);
  }
}

module.exports = {
  getAdminCredentials,
  getOrCreateUserPassword,
};
