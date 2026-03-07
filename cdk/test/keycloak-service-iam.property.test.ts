/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Property-based test for IAM SSM Scope Consistency.
 *
 * **Property 9: IAM SSM Scope Consistency**
 * For any valid projectName, the ECS task role IAM policy SHALL contain
 * ssm:GetParameter scoped to arn:{partition}:ssm:{region}:{account}:parameter/{projectName}/auth/database/*,
 * and no broader SSM access.
 *
 * **Validates: Requirements 12.1, 12.3**
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { assert, property, string } from 'fast-check';

import { KeycloakService } from '../lib/constructs/auth-server/keycloak-service';

/**
 * Arbitrary that generates valid CDK-safe project name strings.
 */
const projectNameArb = string({ minLength: 1, maxLength: 30 }).filter(
  (s: string) => /^[a-z][a-z0-9-]*$/.test(s) && !s.endsWith('-') && !s.includes('--'),
);

describe('Property 9: IAM SSM Scope Consistency', () => {
  /**
   * **Validates: Requirements 12.1, 12.3**
   *
   * For any valid projectName, the ECS task role has ssm:GetParameter
   * scoped to /{projectName}/auth/database/* and no broader SSM access.
   */
  it('should scope ssm:GetParameter to /{projectName}/auth/database/* for any projectName', () => {
    assert(
      property(projectNameArb, (projectName: string) => {
        const stack = new Stack(undefined, 'TestStack', {
          env: { account: '123456789012', region: 'us-west-2' },
        });
        const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2 });
        const keycloakSecret = new Secret(stack, 'KeycloakSecret');
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

        // Find all IAM policies
        const iamPolicies = Object.entries(resources).filter(
          ([, resource]) => resource.Type === 'AWS::IAM::Policy',
        );

        // Collect all SSM-related policy statements across all policies
        const ssmStatements: Array<Record<string, unknown>> = [];
        for (const [, policy] of iamPolicies) {
          const props = policy.Properties as Record<string, unknown>;
          const policyDoc = props.PolicyDocument as Record<string, unknown>;
          const statements = policyDoc.Statement as Array<Record<string, unknown>>;
          for (const stmt of statements) {
            const actions = stmt.Action;
            const actionsStr = JSON.stringify(actions);
            if (actionsStr.includes('ssm:GetParameter')) {
              ssmStatements.push(stmt);
            }
          }
        }

        // There should be at least one SSM policy statement
        expect(ssmStatements.length).toBeGreaterThanOrEqual(1);

        // Verify the SSM policy is scoped to the database prefix
        const expectedSuffix = `parameter/${projectName}/auth/database/*`;
        const allSsmResources = ssmStatements.flatMap(stmt => {
          const resource = stmt.Resource;
          return Array.isArray(resource) ? resource : [resource];
        });

        const allSsmResourcesStr = JSON.stringify(allSsmResources);

        // The SSM resource ARN should contain the expected database prefix
        expect(allSsmResourcesStr).toContain(expectedSuffix);

        // Verify no broader SSM access (no wildcard-only resources for ssm actions)
        for (const stmt of ssmStatements) {
          const resource = stmt.Resource;
          const resources = Array.isArray(resource) ? resource : [resource];
          for (const r of resources) {
            const rStr = JSON.stringify(r);
            // Should not be just "*" (broad access)
            expect(rStr).not.toBe('"*"');
            // Should not grant access to all SSM parameters
            expect(rStr).not.toMatch(/:parameter\/\*$/);
          }
        }
      }),
      { numRuns: 20 },
    );
  });
});
