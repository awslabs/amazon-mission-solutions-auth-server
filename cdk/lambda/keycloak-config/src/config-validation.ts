/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Configuration validation functions for the Keycloak Configuration Lambda
 *
 * This module provides comprehensive validation to ensure that the Keycloak
 * configuration specified in auth-config.json has been properly applied to
 * the running Keycloak server.
 */

import config = require('./config');
import keycloakApi = require('./keycloak-api');
import {
  FullValidationResult,
  KeycloakClientConfig,
  KeycloakClientResponse,
  KeycloakRealmConfig,
  KeycloakUserConfig,
  ValidationResult,
} from './types';
import utils = require('./utils');

/**
 * Perform validation to ensure configuration was applied correctly
 */
async function performValidation(
  accessToken: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<FullValidationResult> {
  const results: FullValidationResult = {
    allValid: true,
    failureReason: '',
    details: {
      realmValid: false,
      clientsValid: false,
      usersValid: false,
      rolesValid: false,
    },
  };

  try {
    console.log('=== Starting Configuration Validation ===');

    // Validate realm configuration
    const realmValidation = await validateRealm(accessToken, realmName, realmConfig);
    results.details.realmValid = realmValidation.valid;
    if (!realmValidation.valid) {
      results.allValid = false;
      results.failureReason = realmValidation.reason!;
      return results;
    }

    // Validate clients
    const clientsValidation = await validateClients(accessToken, realmName, realmConfig);
    results.details.clientsValid = clientsValidation.valid;
    if (!clientsValidation.valid) {
      results.allValid = false;
      results.failureReason = clientsValidation.reason!;
      return results;
    }

    // Validate users
    const usersValidation = await validateUsers(accessToken, realmName, realmConfig);
    results.details.usersValid = usersValidation.valid;
    if (!usersValidation.valid) {
      results.allValid = false;
      results.failureReason = usersValidation.reason!;
      return results;
    }

    // Validate roles (optional)
    const rolesValidation = await validateRoles(accessToken, realmName, realmConfig);
    results.details.rolesValid = rolesValidation.valid;
    // Note: Roles are not critical, so we don't fail on role validation failure

    console.log('=== Validation Completed Successfully ===');
    return results;
  } catch (error: unknown) {
    console.error('Validation failed with error:', error);
    results.allValid = false;
    const message = error instanceof Error ? error.message : String(error);
    results.failureReason = `Validation error: ${message}`;
    return results;
  }
}

/**
 * Validate realm configuration
 */
async function validateRealm(
  accessToken: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<ValidationResult> {
  try {
    console.log(`Validating realm "${realmName}" configuration...`);

    const realmUrl = `${utils.getAdminApiUrl(config.KEYCLOAK_URL)}/realms/${encodeURIComponent(realmName)}`;
    const realmResponse = await utils.makeAuthenticatedRequest('get', realmUrl, null, accessToken);

    if (realmResponse.status !== 200) {
      return {
        valid: false,
        reason: `Realm ${realmName} not accessible (status: ${realmResponse.status})`,
      };
    }

    const actualRealm = realmResponse.data as { enabled: boolean };
    console.log(
      `Realm validation - Expected: enabled=${realmConfig.enabled}, Actual: enabled=${actualRealm.enabled}`,
    );

    if (actualRealm.enabled !== realmConfig.enabled) {
      return {
        valid: false,
        reason: `Realm enabled status mismatch - Expected: ${realmConfig.enabled}, Actual: ${actualRealm.enabled}`,
      };
    }

    console.log(`[PASS] Realm "${realmName}" validation passed`);
    return { valid: true };
  } catch (error: unknown) {
    console.error(`Realm validation error:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `Realm validation error: ${message}`,
    };
  }
}

/**
 * Validate clients configuration
 */
async function validateClients(
  accessToken: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<ValidationResult> {
  try {
    if (!realmConfig.clients || realmConfig.clients.length === 0) {
      console.log('No clients defined in configuration - skipping client validation');
      return { valid: true };
    }

    console.log(`Validating ${realmConfig.clients.length} client(s)...`);

    for (const expectedClient of realmConfig.clients) {
      const clientValidation = await validateSingleClient(accessToken, realmName, expectedClient);
      if (!clientValidation.valid) {
        return clientValidation;
      }
    }

    console.log('[PASS] All clients validation passed');
    return { valid: true };
  } catch (error: unknown) {
    console.error('Clients validation error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `Clients validation error: ${message}`,
    };
  }
}

/**
 * Validate a single client configuration
 */
async function validateSingleClient(
  accessToken: string,
  realmName: string,
  expectedClient: KeycloakClientConfig,
): Promise<ValidationResult> {
  try {
    console.log(`  Validating client "${expectedClient.clientId}"...`);

    const actualClient = await keycloakApi.getClientByClientId(
      accessToken,
      realmName,
      expectedClient.clientId,
    );

    if (!actualClient) {
      return {
        valid: false,
        reason: `Client "${expectedClient.clientId}" not found`,
      };
    }

    // Validate critical client properties
    const criticalProps = [
      'publicClient',
      'standardFlowEnabled',
      'directAccessGrantsEnabled',
    ] as const;
    for (const prop of criticalProps) {
      if (
        expectedClient[prop] !== undefined &&
        actualClient[prop as keyof KeycloakClientResponse] !== expectedClient[prop]
      ) {
        return {
          valid: false,
          reason: `Client "${expectedClient.clientId}" property "${prop}" mismatch - Expected: ${expectedClient[prop]}, Actual: ${actualClient[prop as keyof KeycloakClientResponse]}`,
        };
      }
    }

    // Validate redirect URIs (they should be processed from placeholders)
    if (expectedClient.redirectUris) {
      const redirectValidation = validateClientUriList(
        expectedClient,
        actualClient,
        'redirectUris',
        'redirect URIs',
      );
      if (!redirectValidation.valid) {
        return redirectValidation;
      }
    }

    // Validate web origins
    if (expectedClient.webOrigins) {
      const originsValidation = validateClientUriList(
        expectedClient,
        actualClient,
        'webOrigins',
        'web origins',
      );
      if (!originsValidation.valid) {
        return originsValidation;
      }
    }

    console.log(`  [PASS] Client "${expectedClient.clientId}" validation passed`);
    return { valid: true };
  } catch (error: unknown) {
    console.error(`Client "${expectedClient.clientId}" validation error:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `Client "${expectedClient.clientId}" validation error: ${message}`,
    };
  }
}

/**
 * Validate a URI list property on a client (redirect URIs or web origins)
 */
function validateClientUriList(
  expectedClient: KeycloakClientConfig,
  actualClient: KeycloakClientResponse,
  propertyName: 'redirectUris' | 'webOrigins',
  displayName: string,
): ValidationResult {
  if (!actualClient[propertyName] || actualClient[propertyName]!.length === 0) {
    return {
      valid: false,
      reason: `Client "${expectedClient.clientId}" has no ${displayName}`,
    };
  }

  const hasUnprocessedPlaceholder = actualClient[propertyName]!.some((item: string) =>
    item.includes('__PLACEHOLDER_'),
  );

  if (hasUnprocessedPlaceholder) {
    return {
      valid: false,
      reason: `Client "${expectedClient.clientId}" has unprocessed placeholders in ${propertyName}: ${JSON.stringify(actualClient[propertyName])}`,
    };
  }

  console.log(
    `    [PASS] ${displayName} processed correctly: ${JSON.stringify(actualClient[propertyName])}`,
  );
  return { valid: true };
}

/**
 * Validate users configuration
 */
async function validateUsers(
  accessToken: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<ValidationResult> {
  try {
    if (!realmConfig.users || realmConfig.users.length === 0) {
      console.log('No users defined in configuration - skipping user validation');
      return { valid: true };
    }

    console.log(`Validating ${realmConfig.users.length} user(s)...`);

    for (const expectedUser of realmConfig.users) {
      const userValidation = await validateSingleUser(accessToken, realmName, expectedUser);
      if (!userValidation.valid) {
        return userValidation;
      }
    }

    console.log('[PASS] All users validation passed');
    return { valid: true };
  } catch (error: unknown) {
    console.error('Users validation error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `Users validation error: ${message}`,
    };
  }
}

/**
 * Validate a single user configuration
 */
async function validateSingleUser(
  accessToken: string,
  realmName: string,
  expectedUser: KeycloakUserConfig,
): Promise<ValidationResult> {
  try {
    console.log(`  Validating user "${expectedUser.username}"...`);

    const actualUser = await keycloakApi.getUserByUsername(
      accessToken,
      realmName,
      expectedUser.username,
    );

    if (!actualUser) {
      return {
        valid: false,
        reason: `User "${expectedUser.username}" not found`,
      };
    }

    // Validate user properties
    if (expectedUser.enabled !== undefined && actualUser.enabled !== expectedUser.enabled) {
      return {
        valid: false,
        reason: `User "${expectedUser.username}" enabled status mismatch - Expected: ${expectedUser.enabled}, Actual: ${actualUser.enabled}`,
      };
    }

    if (expectedUser.firstName && actualUser.firstName !== expectedUser.firstName) {
      return {
        valid: false,
        reason: `User "${expectedUser.username}" firstName mismatch - Expected: ${expectedUser.firstName}, Actual: ${actualUser.firstName}`,
      };
    }

    if (expectedUser.lastName && actualUser.lastName !== expectedUser.lastName) {
      return {
        valid: false,
        reason: `User "${expectedUser.username}" lastName mismatch - Expected: ${expectedUser.lastName}, Actual: ${actualUser.lastName}`,
      };
    }

    console.log(`  [PASS] User "${expectedUser.username}" validation passed`);
    return { valid: true };
  } catch (error: unknown) {
    console.error(`User "${expectedUser.username}" validation error:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: `User "${expectedUser.username}" validation error: ${message}`,
    };
  }
}

/**
 * Validate roles configuration
 */
async function validateRoles(
  accessToken: string,
  realmName: string,
  realmConfig: KeycloakRealmConfig,
): Promise<ValidationResult> {
  try {
    if (!realmConfig.roles || !realmConfig.roles.realm || realmConfig.roles.realm.length === 0) {
      console.log('No roles defined in configuration - skipping role validation');
      return { valid: true };
    }

    console.log(`Validating ${realmConfig.roles.realm.length} role(s)...`);

    for (const expectedRole of realmConfig.roles.realm) {
      const roleExists = await keycloakApi.verifyRoleExists(
        accessToken,
        realmName,
        expectedRole.name,
      );
      if (!roleExists) {
        // Roles are not critical, so we'll just log but not fail
        console.warn(`  [WARN] Role "${expectedRole.name}" validation failed - role not found`);
      } else {
        console.log(`  [PASS] Role "${expectedRole.name}" validation passed`);
      }
    }

    console.log('[PASS] Roles validation completed (non-critical)');
    return { valid: true };
  } catch (error) {
    console.error('Roles validation error:', error);
    // Roles are optional, so we don't fail on role validation errors
    console.log('[PASS] Roles validation completed with errors (non-critical)');
    return { valid: true };
  }
}

export = {
  performValidation,
  validateRealm,
  validateClients,
  validateUsers,
  validateRoles,
};
