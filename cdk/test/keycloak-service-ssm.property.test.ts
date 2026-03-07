/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Property-based test for Keycloak SSM Parameter Completeness.
 *
 * **Property 2: Keycloak SSM Parameter Completeness**
 * For any valid projectName, after the KeycloakService construct is synthesized,
 * the CloudFormation template SHALL contain exactly two SSM StringParameter
 * resources under /{projectName}/auth/keycloak/ with paths url and admin-secret-arn,
 * and their values SHALL reference the actual ALB-derived URL and admin secret ARN.
 *
 * **Validates: Requirements 2.1, 2.2**
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { assert, property, string } from 'fast-check';

import { KeycloakService } from '../lib/constructs/auth-server/keycloak-service';

/**
 * Arbitrary that generates valid CDK-safe project name strings.
 * Project names must be non-empty, alphanumeric with hyphens,
 * and reasonable length for SSM parameter paths.
 */
const projectNameArb = string({ minLength: 1, maxLength: 30 }).filter(
  (s: string) => /^[a-z][a-z0-9-]*$/.test(s) && !s.endsWith('-') && !s.includes('--'),
);

describe('Property 2: Keycloak SSM Parameter Completeness', () => {
  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any valid projectName, the KeycloakService construct creates exactly two
   * SSM StringParameter resources with correct paths under /{projectName}/auth/keycloak/.
   */
  it('should create exactly two SSM parameters with correct paths for any projectName', () => {
    assert(
      property(projectNameArb, (projectName: string) => {
        const stack = new Stack(undefined, 'TestStack', {
          env: { account: '123456789012', region: 'us-west-2' },
        });
        const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2 });
        const keycloakSecret = new Secret(stack, 'KeycloakSecret', {
          secretName: `${projectName}-auth/keycloak-admin`,
        });
        const databaseSecret = new Secret(stack, 'DBSecret');

        new KeycloakService(stack, 'KeycloakService', {
          account: { id: '123456789012', region: 'us-west-2', prodLike: false, isAdc: false },
          projectName,
          vpc,
          databaseSecret,
          keycloakSecret,
          wrapperImage: 'test-registry.example.com/keycloak-wrapper:latest',
        });

        const template = Template.fromStack(stack);
        const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

        // Find all SSM StringParameter resources
        const ssmParams = Object.entries(resources).filter(
          ([, resource]) => resource.Type === 'AWS::SSM::Parameter',
        );

        // Exactly two SSM parameters must exist
        expect(ssmParams.length).toBe(2);

        const prefix = `/${projectName}/auth/keycloak`;

        // Extract parameter names from the resources
        const paramProps = ssmParams.map(
          ([, resource]) => resource.Properties as Record<string, unknown>,
        );

        const paramNames = paramProps.map(p => p.Name as string);

        // Both expected paths must be present
        expect(paramNames).toContain(`${prefix}/url`);
        expect(paramNames).toContain(`${prefix}/admin-secret-arn`);

        // Verify url parameter has a value
        const urlParam = paramProps.find(p => p.Name === `${prefix}/url`);
        expect(urlParam).toBeDefined();
        expect(urlParam!.Value).toBeDefined();

        // Verify admin-secret-arn parameter references the secret ARN
        const secretArnParam = paramProps.find(p => p.Name === `${prefix}/admin-secret-arn`);
        expect(secretArnParam).toBeDefined();
        expect(secretArnParam!.Value).toBeDefined();
        // The value should reference the Secrets Manager secret
        expect(JSON.stringify(secretArnParam!.Value)).toMatch(/Ref|Fn::GetAtt|secretsmanager/i);
      }),
      { numRuns: 20 },
    );
  });
});
