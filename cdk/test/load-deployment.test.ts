/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DeploymentConfigError,
  loadDeploymentConfig,
  validateAccountId,
  validateRegion,
  validateSecurityGroupId,
  validateStringField,
  validateVpcId,
} from '../bin/deployment/load-deployment';

// Store original file paths
const deploymentDir = join(__dirname, '..', 'bin', 'deployment');
const deploymentJsonPath = join(deploymentDir, 'deployment.json');

// Backup original files if they exist
let originalDeploymentJson: string | null = null;

describe('load-deployment', () => {
  beforeAll(() => {
    // Backup existing files
    if (existsSync(deploymentJsonPath)) {
      originalDeploymentJson = readFileSync(deploymentJsonPath, 'utf-8');
    }
  });

  afterAll(() => {
    // Restore original files
    if (originalDeploymentJson !== null) {
      writeFileSync(deploymentJsonPath, originalDeploymentJson);
    } else if (existsSync(deploymentJsonPath)) {
      unlinkSync(deploymentJsonPath);
    }
  });

  beforeEach(() => {
    // Clean up test files before each test
    if (existsSync(deploymentJsonPath)) {
      unlinkSync(deploymentJsonPath);
    }
  });

  describe('validateStringField', () => {
    test('returns trimmed string for valid input', () => {
      expect(validateStringField('  hello  ', 'testField')).toBe('hello');
    });

    test('throws error for missing required field', () => {
      expect(() => validateStringField(undefined, 'testField')).toThrow(DeploymentConfigError);
      expect(() => validateStringField(undefined, 'testField')).toThrow(
        'Missing required field: testField',
      );
    });

    test('throws error for null required field', () => {
      expect(() => validateStringField(null, 'testField')).toThrow(DeploymentConfigError);
    });

    test('throws error for non-string value', () => {
      expect(() => validateStringField(123, 'testField')).toThrow(DeploymentConfigError);
      expect(() => validateStringField(123, 'testField')).toThrow(
        "Field 'testField' must be a string, got number",
      );
    });

    test('throws error for empty or whitespace-only required field', () => {
      expect(() => validateStringField('', 'testField')).toThrow(DeploymentConfigError);
      expect(() => validateStringField('   ', 'testField')).toThrow(
        "Field 'testField' cannot be empty or contain only whitespace",
      );
    });

    test('returns empty string for missing optional field', () => {
      expect(validateStringField(undefined, 'testField', false)).toBe('');
    });
  });

  describe('validateAccountId', () => {
    test('returns valid 12-digit account ID', () => {
      expect(validateAccountId('123456789012')).toBe('123456789012');
    });

    test('throws error for account ID with wrong length', () => {
      expect(() => validateAccountId('12345678901')).toThrow(DeploymentConfigError);
      expect(() => validateAccountId('1234567890123')).toThrow(DeploymentConfigError);
    });

    test('throws error for account ID with non-digit characters', () => {
      expect(() => validateAccountId('12345678901a')).toThrow(DeploymentConfigError);
      expect(() => validateAccountId('12345678901a')).toThrow(
        "Invalid AWS account ID format: '12345678901a'. Must be exactly 12 digits.",
      );
    });

    test('throws error for empty account ID', () => {
      expect(() => validateAccountId('')).toThrow(DeploymentConfigError);
    });
  });

  describe('validateRegion', () => {
    test('returns valid AWS region', () => {
      expect(validateRegion('us-east-1')).toBe('us-east-1');
      expect(validateRegion('eu-west-2')).toBe('eu-west-2');
      expect(validateRegion('ap-southeast-1')).toBe('ap-southeast-1');
      expect(validateRegion('us-gov-west-1')).toBe('us-gov-west-1');
    });

    test('throws error for invalid region format', () => {
      expect(() => validateRegion('invalid')).toThrow(DeploymentConfigError);
      expect(() => validateRegion('us_east_1')).toThrow(DeploymentConfigError);
      expect(() => validateRegion('US-EAST-1')).toThrow(DeploymentConfigError);
    });

    test('throws error for empty region', () => {
      expect(() => validateRegion('')).toThrow(DeploymentConfigError);
    });
  });

  describe('validateVpcId', () => {
    test('returns valid VPC ID with 8 hex characters', () => {
      expect(validateVpcId('vpc-12345678')).toBe('vpc-12345678');
    });

    test('returns valid VPC ID with 17 hex characters', () => {
      expect(validateVpcId('vpc-1234567890abcdef0')).toBe('vpc-1234567890abcdef0');
    });

    test('throws error for VPC ID without vpc- prefix', () => {
      expect(() => validateVpcId('12345678')).toThrow(DeploymentConfigError);
    });

    test('throws error for VPC ID with wrong length', () => {
      expect(() => validateVpcId('vpc-1234567')).toThrow(DeploymentConfigError);
      expect(() => validateVpcId('vpc-123456789')).toThrow(DeploymentConfigError);
    });

    test('throws error for VPC ID with invalid characters', () => {
      expect(() => validateVpcId('vpc-1234567g')).toThrow(DeploymentConfigError);
      expect(() => validateVpcId('vpc-1234567g')).toThrow(
        "Invalid VPC ID format: 'vpc-1234567g'. Must start with 'vpc-' followed by 8 or 17 hexadecimal characters.",
      );
    });
  });

  describe('validateSecurityGroupId', () => {
    test('returns valid security group ID with 8 hex characters', () => {
      expect(validateSecurityGroupId('sg-12345678')).toBe('sg-12345678');
    });

    test('returns valid security group ID with 17 hex characters', () => {
      expect(validateSecurityGroupId('sg-1234567890abcdef0')).toBe('sg-1234567890abcdef0');
    });

    test('throws error for security group ID without sg- prefix', () => {
      expect(() => validateSecurityGroupId('12345678')).toThrow(DeploymentConfigError);
    });

    test('throws error for security group ID with wrong length', () => {
      expect(() => validateSecurityGroupId('sg-1234567')).toThrow(DeploymentConfigError);
    });

    test('throws error for security group ID with invalid characters', () => {
      expect(() => validateSecurityGroupId('sg-1234567g')).toThrow(DeploymentConfigError);
      expect(() => validateSecurityGroupId('sg-1234567g')).toThrow(
        "Invalid security group ID format: 'sg-1234567g'. Must start with 'sg-' followed by 8 or 17 hexadecimal characters.",
      );
    });
  });

  describe('loadDeploymentConfig', () => {
    test('throws error when deployment.json is missing', () => {
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Missing deployment.json file');
    });

    test('throws error for invalid JSON syntax', () => {
      writeFileSync(deploymentJsonPath, '{ invalid json }');
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Invalid JSON format in deployment.json');
    });

    test('throws error when deployment.json is not an object', () => {
      writeFileSync(deploymentJsonPath, '"just a string"');
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow(
        'deployment.json must contain a valid JSON object',
      );
    });

    test('throws error for missing projectName', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          account: { id: '123456789012', region: 'us-west-2' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Missing required field: projectName');
    });

    test('throws error for missing account section', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Missing or invalid account section');
    });

    test('throws error for missing account.id', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { region: 'us-west-2' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Missing required field: account.id');
    });

    test('throws error for missing account.region', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Missing required field: account.region');
    });

    test('throws error for invalid account ID format', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: 'invalid', region: 'us-west-2' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Invalid AWS account ID format');
    });

    test('throws error for invalid region format', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'invalid' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Invalid AWS region format');
    });

    test('throws error for invalid VPC ID format in networkConfig', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          networkConfig: { VPC_ID: 'invalid-vpc' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Invalid VPC ID format');
    });

    test('throws error for invalid security group ID format in networkConfig', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          networkConfig: { SECURITY_GROUP_ID: 'invalid-sg' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow('Invalid security group ID format');
    });

    test('throws error when VPC_ID is provided without TARGET_SUBNETS', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          networkConfig: { VPC_ID: 'vpc-12345678' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow(
        'When VPC_ID is provided, TARGET_SUBNETS must also be specified',
      );
    });

    test('throws error when TARGET_SUBNETS is not an array', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          networkConfig: { TARGET_SUBNETS: 'not-an-array' },
        }),
      );
      expect(() => loadDeploymentConfig()).toThrow(DeploymentConfigError);
      expect(() => loadDeploymentConfig()).toThrow(
        "Field 'networkConfig.TARGET_SUBNETS' must be an array",
      );
    });

    test('loads valid configuration with defaults applied', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
        }),
      );

      const config = loadDeploymentConfig();

      expect(config.projectName).toBe('test-project');
      expect(config.account.id).toBe('123456789012');
      expect(config.account.region).toBe('us-west-2');
      // Verify defaults are applied
      expect(config.account.prodLike).toBe(false);
      expect(config.account.isAdc).toBe(false);
      expect(config.networkConfig).toBeUndefined();
      expect(config.dataplaneConfig).toBeUndefined();
    });

    test('loads valid configuration with all fields', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'full-project',
          account: {
            id: '123456789012',
            region: 'eu-west-1',
            prodLike: true,
            isAdc: true,
          },
          networkConfig: {
            VPC_ID: 'vpc-12345678',
            TARGET_SUBNETS: ['subnet-12345678', 'subnet-87654321'],
            SECURITY_GROUP_ID: 'sg-12345678',
          },
          dataplaneConfig: {
            KEYCLOAK_IMAGE: 'quay.io/keycloak/keycloak:latest',
            ECS_TASK_CPU: 4096,
          },
        }),
      );

      const config = loadDeploymentConfig();

      expect(config.projectName).toBe('full-project');
      expect(config.account.id).toBe('123456789012');
      expect(config.account.region).toBe('eu-west-1');
      expect(config.account.prodLike).toBe(true);
      expect(config.account.isAdc).toBe(true);
      expect(config.networkConfig?.VPC_ID).toBe('vpc-12345678');
      expect(config.networkConfig?.TARGET_SUBNETS).toEqual(['subnet-12345678', 'subnet-87654321']);
      expect(config.networkConfig?.SECURITY_GROUP_ID).toBe('sg-12345678');
      expect(config.dataplaneConfig?.KEYCLOAK_IMAGE).toBe('quay.io/keycloak/keycloak:latest');
      expect(config.dataplaneConfig?.ECS_TASK_CPU).toBe(4096);
    });

    test('loads KEYCLOAK_AUTH_CONFIG when present in dataplaneConfig', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          dataplaneConfig: {
            KEYCLOAK_AUTH_CONFIG: {
              realm: 'test-realm',
              enabled: true,
              displayName: 'Test Realm',
              clients: [
                {
                  clientId: 'test-client',
                  publicClient: true,
                  authorizationServicesEnabled: false,
                },
              ],
              users: [],
            },
          },
        }),
      );

      const config = loadDeploymentConfig();
      const authConfig = config.dataplaneConfig?.KEYCLOAK_AUTH_CONFIG;

      expect(authConfig).toBeDefined();
      expect(authConfig?.realm).toBe('test-realm');
      expect(authConfig?.enabled).toBe(true);
      expect(authConfig?.clients).toHaveLength(1);
      expect(authConfig?.clients?.[0].clientId).toBe('test-client');
    });

    test('handles missing KEYCLOAK_AUTH_CONFIG gracefully', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          dataplaneConfig: {
            KEYCLOAK_IMAGE: 'quay.io/keycloak/keycloak:latest',
          },
        }),
      );

      const config = loadDeploymentConfig();

      expect(config.dataplaneConfig?.KEYCLOAK_AUTH_CONFIG).toBeUndefined();
    });

    test('processes placeholder values in KEYCLOAK_AUTH_CONFIG', () => {
      writeFileSync(
        deploymentJsonPath,
        JSON.stringify({
          projectName: 'test-project',
          account: { id: '123456789012', region: 'us-west-2' },
          dataplaneConfig: {
            KEYCLOAK_AUTH_CONFIG: {
              realm: 'test-realm',
              enabled: true,
              clients: [
                {
                  clientId: 'test-client',
                  publicClient: true,
                  authorizationServicesEnabled: false,
                  websiteUri: 'https://example.com',
                  redirectUris: ['__PLACEHOLDER_REDIRECT_URI__'],
                  postLogoutRedirectUris: ['__PLACEHOLDER_REDIRECT_URI__'],
                  webOrigins: ['__PLACEHOLDER_WEB_ORIGIN__'],
                },
              ],
              users: [],
            },
          },
        }),
      );

      const config = loadDeploymentConfig();
      const authConfig = config.dataplaneConfig?.KEYCLOAK_AUTH_CONFIG;

      expect(authConfig?.clients?.[0].redirectUris).toEqual(['https://example.com/*']);
      expect(authConfig?.clients?.[0].postLogoutRedirectUris).toEqual(['https://example.com/*']);
      expect(authConfig?.clients?.[0].webOrigins).toEqual(['https://example.com']);
    });
  });
});
