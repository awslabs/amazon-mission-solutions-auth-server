/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Lambda handler for configuring a Keycloak server after deployment
 * Uses Custom Resource framework to integrate with CloudFormation
 */

const config = require('./src/config');
const awsUtils = require('./src/aws-utils');
const keycloakApi = require('./src/keycloak-api');
const healthCheck = require('./src/health-check');
const utils = require('./src/utils');
const configValidation = require('./src/config-validation');

/**
 * Main handler function for the Lambda
 * @param {Object} event - CloudFormation Custom Resource event
 * @returns {Promise<Object>} - Response to CloudFormation
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));

  // Special handling for DELETE events during stack deletion
  // This prevents the function from failing when Keycloak is being deleted
  if (event.RequestType === 'Delete') {
    console.log('Received DELETE event - skipping Keycloak configuration and returning success');
    return createResponse(
      'SUCCESS',
      event.PhysicalResourceId || `KeycloakConfig-${Date.now()}`,
      null,
      {},
    );
  }

  console.log('Keycloak URL:', config.KEYCLOAK_URL);

  try {
    // Wait for Keycloak to be fully ready with health checking
    console.log('Waiting for Keycloak server to be fully ready...');
    await healthCheck.waitForKeycloakHealth();

    // Get admin credentials from AWS Secrets Manager
    const adminCredentials = await awsUtils.getAdminCredentials();

    // Get access token for API calls
    let accessToken;
    try {
      accessToken = await keycloakApi.loginWithRetry(
        adminCredentials.username,
        adminCredentials.password,
      );
      console.log('Successfully authenticated with Keycloak admin API');
    } catch (error) {
      console.error('Failed to log in after maximum retries:', error);
      throw new Error(`Unable to log in to Keycloak after maximum retries: ${error.message}`);
    }

    // Get authentication configuration - this should always exist if the Lambda is invoked
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
    const verificationResults = {
      realmCreated: false,
      clientsCreated: false,
      usersCreated: false,
      rolesCreated: false,
    };

    // Step 1: Create or update the realm with retry for 500 errors
    console.log('Creating/updating realm...');
    try {
      // Use retry wrapper specifically for realm creation due to potential 500 errors
      await utils.retry(
        async () => {
          try {
            await keycloakApi.createOrUpdateRealmWithConfig(accessToken, realmName, authConfig);
            return true;
          } catch (err) {
            // If we get a 500 error, it might be transient - let's retry
            if (err.response && err.response.status === 500) {
              console.log(
                `Got 500 error creating realm, will retry: ${err.response.data?.error || 'unknown_error'}`,
              );
              throw err; // Throw to trigger retry
            }
            // For other errors, propagate immediately without retry
            throw err;
          }
        },
        3, // Max 3 retries
        2000, // Initial delay 2 seconds
        5000, // Max delay 5 seconds
      );

      // Verify realm was created
      const realmExists = await keycloakApi.verifyRealmExists(accessToken, realmName);
      verificationResults.realmCreated = realmExists;
      if (!realmExists) {
        throw new Error(`Failed to verify realm "${realmName}" was created`);
      }
      console.log(`Verified realm "${realmName}" exists`);
    } catch (error) {
      // Error reporting
      console.error('Error creating/verifying realm:', error);

      // Extract more details from the error if available
      let errorDetails = error.message;
      if (error.response) {
        errorDetails += ` - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data || {})}`;
      }

      throw new Error(`Failed to create/verify realm: ${errorDetails}`);
    }

    // Step 2: Process clients from configuration
    console.log('Creating/updating clients...');
    try {
      if (authConfig.clients && authConfig.clients.length > 0) {
        for (const client of authConfig.clients) {
          await keycloakApi.createOrUpdateClient(accessToken, realmName, client);

          // Verify client was created
          const clientExists = await keycloakApi.verifyClientExists(
            accessToken,
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
        verificationResults.clientsCreated = true; // No clients to create is valid
      }
    } catch (error) {
      console.error('Error creating/verifying clients:', error);
      throw new Error(`Failed to create/verify clients: ${error.message}`);
    }

    // Step 3: Process users from configuration
    console.log('Creating/updating users...');
    try {
      if (authConfig.users && authConfig.users.length > 0) {
        for (const user of authConfig.users) {
          // Get or generate password for the user
          const userPassword = await awsUtils.getOrCreateUserPassword(user.username);

          // Create or update the user
          await keycloakApi.createOrUpdateUser(accessToken, realmName, user, userPassword);

          // Verify user was created
          const userExists = await keycloakApi.verifyUserExists(
            accessToken,
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
        verificationResults.usersCreated = true; // No users to create is valid
      }
    } catch (error) {
      console.error('Error creating/verifying users:', error);
      throw new Error(`Failed to create/verify users: ${error.message}`);
    }

    // Step 4: Process roles in the realm configuration (optional)
    console.log('Creating/updating roles...');
    try {
      if (authConfig.roles && authConfig.roles.realm && authConfig.roles.realm.length > 0) {
        for (const role of authConfig.roles.realm) {
          await keycloakApi.createOrUpdateRole(accessToken, realmName, role);

          // Verify role was created
          const roleExists = await keycloakApi.verifyRoleExists(accessToken, realmName, role.name);
          if (!roleExists) {
            throw new Error(`Failed to verify role "${role.name}" was created`);
          }
          console.log(`Verified role "${role.name}" exists`);
        }
        verificationResults.rolesCreated = true;
      } else {
        console.log('No roles defined in configuration');
        verificationResults.rolesCreated = true; // No roles to create is valid
      }
    } catch (error) {
      console.error('Error creating/verifying roles:', error);
      // Roles are not critical, so we'll just log the error and continue
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
        realmName,
        authConfig,
      );
      console.log('Validation Results:', JSON.stringify(validationResults, null, 2));

      if (!validationResults.allValid) {
        const errorMsg = `Validation failed: ${validationResults.failureReason}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    } catch (validationError) {
      console.error('Validation failed:', validationError);
      throw new Error(`Configuration validation failed: ${validationError.message}`);
    }

    console.log('All configuration steps completed and verified successfully');
    console.log('Verification Results:', JSON.stringify(verificationResults, null, 2));

    // Return success to CloudFormation via CDK Provider framework
    return createResponse('SUCCESS', `KeycloakConfig-${Date.now()}`, null, {
      RealmName: realmName,
      WebsiteUri: config.WEBSITE_URI,
      VerificationResults: verificationResults,
    });
  } catch (error) {
    console.error('Lambda execution failed:', error);
    // When using CDK Provider framework, we should throw errors instead of returning FAILED responses
    // The Provider framework will handle the CloudFormation communication
    throw new Error(`Configuration failed: ${error.message}`);
  }
};

/**
 * Create response object for CDK Provider framework
 * The Provider framework handles all CloudFormation communication
 * @param {string} status - SUCCESS or FAILED
 * @param {string} physicalResourceId - Physical resource ID
 * @param {string} [reason] - Reason for failure (optional)
 * @param {Object} [data] - Response data (optional)
 * @returns {Object} - Response object for Provider framework
 */
function createResponse(status, physicalResourceId, reason = null, data = {}) {
  const response = {
    Status: status,
    PhysicalResourceId: physicalResourceId,
  };

  if (reason) {
    response.Reason = reason;
  }

  if (data && Object.keys(data).length > 0) {
    response.Data = data;
  }

  console.log('CDK Provider response:', JSON.stringify(response));
  return response;
}
