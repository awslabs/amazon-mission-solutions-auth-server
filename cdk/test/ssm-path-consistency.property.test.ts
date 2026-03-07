/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Property-based test for SSM Path Consistency Between Writer and Reader (Lambda).
 *
 * **Property 6: SSM Path Consistency Between Writer and Reader (Lambda)**
 * For any valid SSM_PREFIX value, the Config Lambda SHALL construct SSM parameter
 * paths `{SSM_PREFIX}/keycloak/url` and `{SSM_PREFIX}/keycloak/admin-secret-arn`
 * using the SSM_PREFIX environment variable, matching the paths written by the
 * KeycloakService construct.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3**
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { assert, property, string } from 'fast-check';

import { KeycloakConfig } from '../lib/constructs/auth-server/keycloak-config';
import { KeycloakService } from '../lib/constructs/auth-server/keycloak-service';

// Mock existsSync so the Lambda bundle check passes during synthesis
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn().mockReturnValue(true),
}));

/**
 * Arbitrary that generates valid CDK-safe project name strings.
 * Project names must be non-empty, alphanumeric with hyphens,
 * and reasonable length for SSM parameter paths.
 */
const projectNameArb = string({ minLength: 1, maxLength: 30 }).filter(
  (s: string) => /^[a-z][a-z0-9-]*$/.test(s) && !s.endsWith('-') && !s.includes('--'),
);

describe('Property 6: SSM Path Consistency Between Writer and Reader (Lambda)', () => {
  /**
   * **Validates: Requirements 8.1, 8.2, 8.3**
   *
   * For any valid projectName, the SSM parameter paths written by KeycloakService
   * (`/{projectName}/auth/keycloak/url` and `/{projectName}/auth/keycloak/admin-secret-arn`)
   * match the paths the Lambda constructs from its SSM_PREFIX environment variable
   * (`{SSM_PREFIX}/keycloak/url` and `{SSM_PREFIX}/keycloak/admin-secret-arn`).
   */
  it('should ensure Lambda SSM_PREFIX + suffixes match the SSM paths written by KeycloakService for any projectName', () => {
    assert(
      property(projectNameArb, (projectName: string) => {
        const account = '123456789012';
        const region = 'us-west-2';

        // --- Synthesize KeycloakService to extract written SSM paths ---
        const serviceStack = new Stack(undefined, 'ServiceStack', {
          env: { account, region },
        });
        const serviceVpc = new Vpc(serviceStack, 'Vpc', { maxAzs: 2 });
        const keycloakSecret = new Secret(serviceStack, 'AdminSecret');
        const databaseSecret = new Secret(serviceStack, 'DBSecret');

        new KeycloakService(serviceStack, 'KeycloakService', {
          account: { id: account, region, prodLike: false, isAdc: false },
          vpc: serviceVpc,
          databaseSecret,
          keycloakSecret,
          projectName,
          wrapperImage: 'test-image:latest', // Use pre-built image to skip Docker build
        });

        const serviceTemplate = Template.fromStack(serviceStack);
        const serviceResources = serviceTemplate.toJSON().Resources as Record<
          string,
          Record<string, unknown>
        >;

        // Find SSM StringParameter resources written by KeycloakService
        const writtenSsmParams = Object.entries(serviceResources)
          .filter(([, resource]) => resource.Type === 'AWS::SSM::Parameter')
          .map(([, resource]) => (resource.Properties as Record<string, unknown>).Name as string);

        const expectedPrefix = `/${projectName}/auth`;
        const expectedUrlPath = `${expectedPrefix}/keycloak/url`;
        const expectedSecretArnPath = `${expectedPrefix}/keycloak/admin-secret-arn`;

        // Verify KeycloakService writes both expected SSM parameters
        expect(writtenSsmParams).toContain(expectedUrlPath);
        expect(writtenSsmParams).toContain(expectedSecretArnPath);

        // --- Synthesize KeycloakConfig to extract Lambda SSM_PREFIX env var ---
        const configStack = new Stack(undefined, 'ConfigStack', {
          env: { account, region },
        });
        const configVpc = new Vpc(configStack, 'Vpc', { maxAzs: 2 });
        const configSg = new SecurityGroup(configStack, 'SG', { vpc: configVpc });
        const configSecret = new Secret(configStack, 'AdminSecret');

        new KeycloakConfig(configStack, 'KeycloakConfig', {
          account: { id: account, region, prodLike: false, isAdc: false },
          vpc: configVpc,
          securityGroup: configSg,
          keycloakAdminSecret: configSecret,
          projectName,
        });

        const configTemplate = Template.fromStack(configStack);
        const configResources = configTemplate.toJSON().Resources as Record<
          string,
          Record<string, unknown>
        >;

        // Find the Lambda function resource and extract SSM_PREFIX env var
        const lambdaFunctions = Object.entries(configResources).filter(
          ([, resource]) => resource.Type === 'AWS::Lambda::Function',
        );
        expect(lambdaFunctions.length).toBeGreaterThanOrEqual(1);

        const [, lambdaResource] = lambdaFunctions[0];
        const lambdaProps = lambdaResource.Properties as Record<string, unknown>;
        const envVars = (lambdaProps.Environment as Record<string, unknown>).Variables as Record<
          string,
          string
        >;

        const ssmPrefix = envVars.SSM_PREFIX;
        expect(ssmPrefix).toBeDefined();

        // Verify the Lambda's SSM_PREFIX matches the expected prefix
        expect(ssmPrefix).toBe(expectedPrefix);

        // Verify that SSM_PREFIX + suffixes match the paths written by KeycloakService
        // This is the core property: the reader constructs the same paths the writer creates
        const lambdaUrlPath = `${ssmPrefix}/keycloak/url`;
        const lambdaSecretArnPath = `${ssmPrefix}/keycloak/admin-secret-arn`;

        expect(lambdaUrlPath).toBe(expectedUrlPath);
        expect(lambdaSecretArnPath).toBe(expectedSecretArnPath);

        // Cross-check: Lambda-constructed paths must be in the set of written paths
        expect(writtenSsmParams).toContain(lambdaUrlPath);
        expect(writtenSsmParams).toContain(lambdaSecretArnPath);
      }),
      { numRuns: 20 },
    );
  });
});
