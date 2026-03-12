/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Utility to load and validate the deployment configuration file.
 *
 * This module provides a strongly typed interface for reading the `deployment.json`
 * configuration, performing required validations, and returning a structured result.
 *
 * Expected structure of `deployment.json`:
 * ```json
 * {
 *   "projectName": "example-stack",
 *   "account": {
 *     "id": "123456789012",
 *     "region": "us-west-2",
 *     "prodLike": false,
 *     "isAdc": false
 *   },
 *   "networkConfig": {
 *     "VPC_ID": "vpc-abc123",
 *     "TARGET_SUBNETS": ["subnet-12345", "subnet-67890"],
 *     "SECURITY_GROUP_ID": "sg-1234567890abcdef0"
 *   },
 *   "dataplaneConfig": {
 *     "KEYCLOAK_VERSION": "latest",
 *     "ECS_TASK_CPU": 4096,
 *     "ECS_TASK_MEMORY": 8192,
 *     "KEYCLOAK_AUTH_CONFIG": {
 *       "realm": "my-realm",
 *       "enabled": true,
 *       "clients": [...],
 *       "users": [...]
 *     }
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataplaneConfig } from '../../lib/constructs/auth-server/dataplane';
import { NetworkConfig } from '../../lib/constructs/auth-server/network';
import { OSMLAccount } from '../../lib/constructs/types';
import { KeycloakCustomConfig } from '../../lib/utils/keycloak-config-loader';

/**
 * Represents the structure of the deployment configuration file.
 */
export interface DeploymentConfig {
  /** Logical name of the project, used for the CDK stack ID. */
  projectName: string;

  /** AWS account configuration. */
  account: OSMLAccount;

  /** Networking configuration. If VPC_ID is provided, an existing VPC will be imported. Otherwise, a new VPC will be created. */
  networkConfig?: NetworkConfig;

  /** Optional Dataplane configuration. Can be a partial config object passed to DataplaneConfig constructor. */
  dataplaneConfig?: Partial<DataplaneConfig>;
}

/**
 * Validation error class for deployment configuration issues.
 */
export class DeploymentConfigError extends Error {
  /**
   * Creates a new DeploymentConfigError.
   *
   * @param message - The error message
   * @param field - Optional field name that caused the error
   */
  constructor(
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'DeploymentConfigError';
  }
}

/**
 * Validates and trims a string field, checking for required value and whitespace.
 *
 * @param value - The value to validate
 * @param fieldName - The name of the field being validated (for error messages)
 * @param isRequired - Whether the field is required (default: true)
 * @returns The trimmed string value
 * @throws {DeploymentConfigError} If validation fails
 */
export function validateStringField(
  value: unknown,
  fieldName: string,
  isRequired: boolean = true,
): string {
  if (value === undefined || value === null) {
    if (isRequired) {
      throw new DeploymentConfigError(`Missing required field: ${fieldName}`, fieldName);
    }
    return '';
  }

  if (typeof value !== 'string') {
    throw new DeploymentConfigError(
      `Field '${fieldName}' must be a string, got ${typeof value}`,
      fieldName,
    );
  }

  const trimmed = value.trim();
  if (isRequired && trimmed === '') {
    throw new DeploymentConfigError(
      `Field '${fieldName}' cannot be empty or contain only whitespace`,
      fieldName,
    );
  }

  return trimmed;
}

/**
 * Validates AWS account ID format.
 *
 * @param accountId - The account ID to validate
 * @returns The validated account ID
 * @throws {DeploymentConfigError} If the account ID format is invalid
 */
export function validateAccountId(accountId: string): string {
  if (!/^\d{12}$/.test(accountId)) {
    throw new DeploymentConfigError(
      `Invalid AWS account ID format: '${accountId}'. Must be exactly 12 digits.`,
      'account.id',
    );
  }
  return accountId;
}

/**
 * Validates AWS region format using pattern matching.
 *
 * @param region - The region to validate
 * @returns The validated region
 * @throws {DeploymentConfigError} If the region format is invalid
 */
export function validateRegion(region: string): string {
  // AWS region pattern: letters/numbers, hyphen, letters/numbers, optional hyphen and numbers
  if (!/^[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) {
    throw new DeploymentConfigError(
      `Invalid AWS region format: '${region}'. Must follow pattern like 'us-east-1', 'eu-west-2', etc.`,
      'account.region',
    );
  }
  return region;
}

/**
 * Validates VPC ID format.
 *
 * @param vpcId - The VPC ID to validate
 * @returns The validated VPC ID
 * @throws {DeploymentConfigError} If the VPC ID format is invalid
 */
export function validateVpcId(vpcId: string): string {
  if (!/^vpc-[a-f0-9]{8}(?:[a-f0-9]{9})?$/.test(vpcId)) {
    throw new DeploymentConfigError(
      `Invalid VPC ID format: '${vpcId}'. Must start with 'vpc-' followed by 8 or 17 hexadecimal characters.`,
      'networkConfig.VPC_ID',
    );
  }
  return vpcId;
}

/**
 * Validates security group ID format.
 *
 * @param securityGroupId - The security group ID to validate
 * @returns The validated security group ID
 * @throws {DeploymentConfigError} If the security group ID format is invalid
 */
export function validateSecurityGroupId(securityGroupId: string): string {
  if (!/^sg-[a-f0-9]{8}(?:[a-f0-9]{9})?$/.test(securityGroupId)) {
    throw new DeploymentConfigError(
      `Invalid security group ID format: '${securityGroupId}'. Must start with 'sg-' followed by 8 or 17 hexadecimal characters.`,
      'networkConfig.SECURITY_GROUP_ID',
    );
  }
  return securityGroupId;
}

/**
 * Module-level flag to track if the deployment config has been loaded and logged.
 * This prevents duplicate logging when the function is called multiple times.
 */
let hasLoggedDeploymentConfig = false;

/**
 * Processes placeholder values in Keycloak auth configuration.
 *
 * @param config - The Keycloak configuration to process
 * @returns The processed configuration with placeholders replaced
 */
function processAuthConfigPlaceholders(config: KeycloakCustomConfig): KeycloakCustomConfig {
  if (config.clients && Array.isArray(config.clients)) {
    config.clients.forEach(client => {
      const websiteUri = client.websiteUri || '*';
      const redirectUri = websiteUri === '*' ? '*' : `${websiteUri}/*`;
      const webOrigin = websiteUri;

      if (client.redirectUris) {
        client.redirectUris = client.redirectUris.map(uri =>
          uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
        );
      }

      if (client.postLogoutRedirectUris) {
        client.postLogoutRedirectUris = client.postLogoutRedirectUris.map(uri =>
          uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
        );
      }

      if (client.webOrigins) {
        client.webOrigins = client.webOrigins.map(origin =>
          origin === '__PLACEHOLDER_WEB_ORIGIN__' ? webOrigin : origin,
        );
      }
    });
  }

  return config;
}

/**
 * Loads and validates the deployment configuration from `deployment/deployment.json`.
 *
 * @returns A validated {@link DeploymentConfig} object
 * @throws {DeploymentConfigError} If the file is missing, malformed, or contains invalid values
 */
export function loadDeploymentConfig(): DeploymentConfig {
  const deploymentPath = join(__dirname, 'deployment.json');

  // Check file existence
  if (!existsSync(deploymentPath)) {
    throw new DeploymentConfigError(
      `Missing deployment.json file at ${deploymentPath}. Please create it by copying deployment.json.example`,
    );
  }

  // Parse JSON
  let parsed: unknown;
  try {
    const rawContent = readFileSync(deploymentPath, 'utf-8');
    parsed = JSON.parse(rawContent) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DeploymentConfigError(`Invalid JSON format in deployment.json: ${error.message}`);
    }
    throw new DeploymentConfigError(
      `Failed to read deployment.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  // Validate top-level structure
  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    throw new DeploymentConfigError('deployment.json must contain a valid JSON object');
  }

  const parsedObj = parsed as Record<string, unknown>;

  // Validate project name
  const projectName = validateStringField(parsedObj.projectName, 'projectName');

  // Validate account section
  if (!parsedObj.account || typeof parsedObj.account !== 'object') {
    throw new DeploymentConfigError(
      'Missing or invalid account section in deployment.json',
      'account',
    );
  }

  const accountObj = parsedObj.account as Record<string, unknown>;

  const accountId = validateAccountId(validateStringField(accountObj.id, 'account.id'));
  const region = validateRegion(validateStringField(accountObj.region, 'account.region'));

  // Parse optional account fields with defaults
  const prodLike = (accountObj.prodLike as boolean | undefined) ?? false;
  const isAdc = (accountObj.isAdc as boolean | undefined) ?? false;

  // Parse and validate networking configuration
  let networkConfig: NetworkConfig | undefined = undefined;
  if (
    parsedObj.networkConfig &&
    typeof parsedObj.networkConfig === 'object' &&
    parsedObj.networkConfig !== null
  ) {
    const networkConfigData = parsedObj.networkConfig as Record<string, unknown>;

    // Validate VPC_ID format if provided
    if (networkConfigData.VPC_ID !== undefined) {
      validateVpcId(validateStringField(networkConfigData.VPC_ID, 'networkConfig.VPC_ID'));
    }

    // Validate TARGET_SUBNETS is an array if provided
    if (networkConfigData.TARGET_SUBNETS !== undefined) {
      if (!Array.isArray(networkConfigData.TARGET_SUBNETS)) {
        throw new DeploymentConfigError(
          "Field 'networkConfig.TARGET_SUBNETS' must be an array",
          'networkConfig.TARGET_SUBNETS',
        );
      }
    }

    // Validate SECURITY_GROUP_ID format if provided
    if (networkConfigData.SECURITY_GROUP_ID !== undefined) {
      validateSecurityGroupId(
        validateStringField(networkConfigData.SECURITY_GROUP_ID, 'networkConfig.SECURITY_GROUP_ID'),
      );
    }

    // Validate that TARGET_SUBNETS is required when VPC_ID is provided
    if (
      networkConfigData.VPC_ID &&
      (!networkConfigData.TARGET_SUBNETS ||
        !Array.isArray(networkConfigData.TARGET_SUBNETS) ||
        networkConfigData.TARGET_SUBNETS.length === 0)
    ) {
      throw new DeploymentConfigError(
        'When VPC_ID is provided, TARGET_SUBNETS must also be specified with at least one subnet ID',
        'networkConfig.TARGET_SUBNETS',
      );
    }

    // Create NetworkConfig instance with all properties passed through
    networkConfig = new NetworkConfig(networkConfigData);
  }

  // Parse optional Dataplane configuration
  let dataplaneConfig: Partial<DataplaneConfig> | undefined = undefined;
  if (
    parsedObj.dataplaneConfig &&
    typeof parsedObj.dataplaneConfig === 'object' &&
    parsedObj.dataplaneConfig !== null
  ) {
    dataplaneConfig = parsedObj.dataplaneConfig as Partial<DataplaneConfig>;

    // Process placeholder values in KEYCLOAK_AUTH_CONFIG if present
    if (dataplaneConfig.KEYCLOAK_AUTH_CONFIG) {
      dataplaneConfig.KEYCLOAK_AUTH_CONFIG = processAuthConfigPlaceholders(
        dataplaneConfig.KEYCLOAK_AUTH_CONFIG,
      );
    }
  }

  const validatedConfig: DeploymentConfig = {
    projectName,
    account: {
      id: accountId,
      region,
      prodLike,
      isAdc,
    },
    networkConfig,
    dataplaneConfig,
  };

  // Log deployment info (prevent duplicate logging)
  if (!hasLoggedDeploymentConfig) {
    console.log(
      `Deploying ${validatedConfig.projectName} to account ${validatedConfig.account.id} in region ${validatedConfig.account.region}`,
    );
    console.log(
      `  prodLike: ${validatedConfig.account.prodLike}, isAdc: ${validatedConfig.account.isAdc}`,
    );
    if (validatedConfig.networkConfig?.VPC_ID) {
      console.log(`  Using existing VPC: ${validatedConfig.networkConfig.VPC_ID}`);
    } else {
      console.log(
        `  Creating new VPC: ${validatedConfig.networkConfig?.VPC_NAME || 'auth-server-vpc'}`,
      );
    }
    if (validatedConfig.dataplaneConfig?.KEYCLOAK_AUTH_CONFIG) {
      console.log(
        `  Auth config loaded: realm=${validatedConfig.dataplaneConfig.KEYCLOAK_AUTH_CONFIG.realm}`,
      );
    }
    hasLoggedDeploymentConfig = true;
  }

  return validatedConfig;
}
