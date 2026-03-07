/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Lambda handler for configuring a Keycloak server after deployment.
 * Triggered by a CloudFormation Custom Resource via the Provider framework.
 * Reads Keycloak connection details from SSM Parameter Store at invocation time.
 */

import awsUtils = require('./src/aws-utils');
import config = require('./src/config');
import configValidation = require('./src/config-validation');
import healthCheck = require('./src/health-check');
import keycloakApi = require('./src/keycloak-api');
import {
  CloudFormationCustomResourceEvent,
  ProviderResponse,
  VerificationResults,
} from './src/types';
import utils = require('./src/utils');

/**
 * Main handler function for the Lambda.
 * Processes CloudFormation Custom Resource events.
 * On success: returns a ProviderResponse with SUCCESS status.
 * On failure: throws an error (Provider framework handles FAILED response).
 */
exports.handler = async (event: CloudFormationCustomResourceEvent): Promise<ProviderResponse> => {
  console.log('Event:', JSON.stringify(event));

  const ssmPrefix = config.SSM_PREFIX;

  // Read Keycloak URL and admin secret ARN from SSM at invocation time
  console.log(`Reading SSM parameters with prefix: ${ssmPrefix}`);
  const keycloakUrl = await awsUtils.getSSMParameter(`${ssmPrefix}/keycloak/url`);
  const adminSecretArn = await awsUtils.getSSMParameter(`${ssmPrefix}/keycloak/admin-secret-arn`);

  console.log('Keycloak URL:', keycloakUrl);

  // Handle DELETE events - return success immediately
  if (event.RequestType === 'Delete') {
    console.log('Delete event received - returning success');
    return {
      Status: 'SUCCESS',
      PhysicalResourceId: event.PhysicalResourceId || 'keycloak-config',
      Data: {},
    };
  }

  // Wait for Keycloak to be fully ready with health checking
  console.log('Waiting for Keycloak server to be fully ready...');
  await healthCheck.waitForKeycloakHealth(keycloakUrl);

  // Get admin credentials from AWS Secrets Manager
  const adminCredentials = await awsUtils.getAdminCredentials(adminSecretArn);

  // Get access token for API calls
  let accessToken: string;
  try {
    accessToken = await keycloakApi.loginWithRetry(
      keycloakUrl,
      adminCredentials.username,
      adminCredentials.password,
    );
    console.log('Successfully authenticated with Keycloak admin API');
  } catch (error: unknown) {
    console.error('Failed to log in after maximum retries:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to log in to Keycloak after maximum retries: ${message}`);
  }

  // Get authentication configuration
  const authConfig = config.getAuthConfig();

  if (!authConfig) {
    console.log('No authentication configuration found - Lambda should not have been invoked');
    throw new Error(
      'No authentication configuration available. Lambda should only run when auth-config.json exists.',
    );
  }

  const realmName = authConfig.realm;
  console.log(`Using realm name: ${realmName}`);

  // Track verification results for each step
  const verificationResults: VerificationResults = {
    realmCreated: false,
    clientsCreated: false,
    usersCreated: false,
    rolesCreated: false,
  };

  // Step 1: Create or update the realm with retry for 500 errors
  console.log('Creating/updating realm...');
  try {
    await utils.retry(
      async () => {
        try {
          await keycloakApi.createOrUpdateRealmWithConfig(
            accessToken,
            keycloakUrl,
            realmName,
            authConfig,
          );
          return true;
        } catch (err: unknown) {
          const errObj = err as Record<string, unknown>;
          if (errObj.response && (errObj.response as { status: number }).status === 500) {
            console.log(
              `Got 500 error creating realm, will retry: ${(errObj.response as { data?: { error?: string } }).data?.error || 'unknown_error'}`,
            );
            throw err;
          }
          throw err;
        }
      },
      3,
      2000,
      5000,
    );

    verificationResults.realmCreated = true;
    console.log(`Verified realm "${realmName}" was created/updated successfully`);
  } catch (error: unknown) {
    console.error('Error creating/verifying realm:', error);

    const errObj = error as Record<string, unknown>;
    let errorDetails = error instanceof Error ? error.message : String(error);
    if (errObj.response) {
      const response = errObj.response as { status: number; data?: Record<string, unknown> };
      errorDetails += ` - Status: ${response.status}, Data: ${JSON.stringify(response.data || {})}`;
    }

    throw new Error(`Failed to create/verify realm: ${errorDetails}`);
  }

  // Step 2: Process clients from configuration
  console.log('Creating/updating clients...');
  try {
    if (authConfig.clients && authConfig.clients.length > 0) {
      for (const client of authConfig.clients) {
        await keycloakApi.createOrUpdateClient(accessToken, keycloakUrl, realmName, client);

        const clientExists = await keycloakApi.verifyClientExists(
          accessToken,
          keycloakUrl,
          realmName,
          client.clientId,
        );
        if (!clientExists) {
          throw new Error(`Failed to verify client "${client.clientId}" was created`);
        }
        console.log(`Verified client "${client.clientId}" exists`);
      }
      verificationResults.clientsCreated = true;
    } else {
      console.log('No clients defined in configuration');
      verificationResults.clientsCreated = true;
    }
  } catch (error: unknown) {
    console.error('Error creating/verifying clients:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create/verify clients: ${message}`);
  }

  // Step 3: Process users from configuration
  console.log('Creating/updating users...');
  try {
    if (authConfig.users && authConfig.users.length > 0) {
      for (const user of authConfig.users) {
        const userPassword = await awsUtils.getOrCreateUserPassword(user.username);
        await keycloakApi.createOrUpdateUser(
          accessToken,
          keycloakUrl,
          realmName,
          user,
          userPassword,
        );

        const userExists = await keycloakApi.verifyUserExists(
          accessToken,
          keycloakUrl,
          realmName,
          user.username,
        );
        if (!userExists) {
          throw new Error(`Failed to verify user "${user.username}" was created`);
        }
        console.log(`Verified user "${user.username}" exists`);
      }
      verificationResults.usersCreated = true;
    } else {
      console.log('No users defined in configuration');
      verificationResults.usersCreated = true;
    }
  } catch (error: unknown) {
    console.error('Error creating/verifying users:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create/verify users: ${message}`);
  }

  // Step 4: Process roles in the realm configuration (optional)
  console.log('Creating/updating roles...');
  try {
    if (authConfig.roles && authConfig.roles.realm && authConfig.roles.realm.length > 0) {
      for (const role of authConfig.roles.realm) {
        await keycloakApi.createOrUpdateRole(accessToken, keycloakUrl, realmName, role);

        const roleExists = await keycloakApi.verifyRoleExists(
          accessToken,
          keycloakUrl,
          realmName,
          role.name,
        );
        if (!roleExists) {
          throw new Error(`Failed to verify role "${role.name}" was created`);
        }
        console.log(`Verified role "${role.name}" exists`);
      }
      verificationResults.rolesCreated = true;
    } else {
      console.log('No roles defined in configuration');
      verificationResults.rolesCreated = true;
    }
  } catch (error) {
    console.error('Error creating/verifying roles:', error);
    console.log('Continuing despite role creation/verification failure');
    verificationResults.rolesCreated = false;
  }

  // Final verification - all critical components must be created successfully
  if (
    !verificationResults.realmCreated ||
    !verificationResults.clientsCreated ||
    !verificationResults.usersCreated
  ) {
    const errorMsg = `Configuration verification failed: Realm created: ${verificationResults.realmCreated}, Clients created: ${verificationResults.clientsCreated}, Users created: ${verificationResults.usersCreated}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Verify the actual configuration matches expected values
  console.log('Running configuration validation...');
  try {
    const validationResults = await configValidation.performValidation(
      accessToken,
      keycloakUrl,
      realmName,
      authConfig,
    );
    console.log('Validation Results:', JSON.stringify(validationResults, null, 2));

    if (!validationResults.allValid) {
      const errorMsg = `Validation failed: ${validationResults.failureReason}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  } catch (validationError: unknown) {
    console.error('Validation failed:', validationError);
    const message =
      validationError instanceof Error ? validationError.message : String(validationError);
    throw new Error(`Configuration validation failed: ${message}`);
  }

  console.log('All configuration steps completed and verified successfully');
  console.log('Verification Results:', JSON.stringify(verificationResults, null, 2));

  return {
    Status: 'SUCCESS',
    PhysicalResourceId: event.PhysicalResourceId || 'keycloak-config',
    Data: {
      RealmName: realmName,
      ConfiguredAt: new Date().toISOString(),
    },
  };
};
