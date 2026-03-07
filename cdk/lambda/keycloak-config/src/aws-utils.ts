/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * AWS utility functions for the Keycloak Configuration Lambda
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import config = require('./config');
import { AdminCredentials } from './types';

// Create AWS SDK clients
const secretsManager = new SecretsManagerClient();
const ssmClient = new SSMClient();

/**
 * Read a single SSM parameter by name.
 * Throws if the parameter does not exist or cannot be read.
 */
async function getSSMParameter(name: string): Promise<string> {
  try {
    const response = await ssmClient.send(new GetParameterCommand({ Name: name }));

    if (!response.Parameter?.Value) {
      throw new Error(`SSM parameter ${name} has no value`);
    }

    return response.Parameter.Value;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read SSM parameter ${name}: ${message}`);
  }
}

/**
 * Retrieve the admin credentials from AWS Secrets Manager
 */
async function getAdminCredentials(secretArn: string): Promise<AdminCredentials> {
  if (!secretArn) {
    throw new Error('Keycloak admin secret ARN is not provided');
  }

  try {
    console.log(`Retrieving admin credentials from secret: ${secretArn}`);
    const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));

    if (!('SecretString' in response)) {
      throw new Error('Secret is binary and not supported');
    }

    const secretString = response.SecretString!;
    const secretObject = JSON.parse(secretString) as Record<string, string>;

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
  } catch (error: unknown) {
    console.error('Error retrieving admin credentials:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve admin credentials: ${message}`);
  }
}

/**
 * Get or create a user password from AWS Secrets Manager
 */
async function getOrCreateUserPassword(username: string): Promise<string> {
  // Get the ARNs of user password secrets
  const userPasswordSecrets = config.getUserPasswordSecrets();

  const secretArn = userPasswordSecrets[username];
  if (!secretArn) {
    throw new Error(`No secret ARN found for user: ${username}`);
  }

  try {
    console.log(`Retrieving password for user ${username} from secret`);
    const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));

    let password: string;
    if ('SecretString' in response) {
      // For simple string secrets
      if (response.SecretString!.startsWith('{')) {
        try {
          const parsed = JSON.parse(response.SecretString!) as Record<string, string>;
          if (parsed.password) {
            password = parsed.password;
          } else {
            password = response.SecretString!;
          }
        } catch {
          // If not valid JSON, use the raw string as password
          password = response.SecretString!;
        }
      } else {
        password = response.SecretString!;
      }
    } else {
      throw new Error('Binary secrets are not supported');
    }

    return password;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as Error & { name: string }).name === 'ResourceNotFoundException'
    ) {
      console.log(`Secret not found for user ${username}, will be created by CDK`);
      // Return a placeholder for now - actual password will be created by CDK
      return 'placeholder-password-will-be-created-by-cdk';
    }

    console.error(`Error retrieving password for user ${username}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve password for user ${username}: ${message}`);
  }
}

export = {
  getSSMParameter,
  getAdminCredentials,
  getOrCreateUserPassword,
};
