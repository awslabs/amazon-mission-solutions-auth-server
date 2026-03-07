/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Property-based test for Database SSM Parameter Completeness.
 *
 * **Property 1: Database SSM Parameter Completeness**
 * For any valid projectName, after the Database construct is synthesized,
 * the CloudFormation template SHALL contain exactly three SSM StringParameter
 * resources under /{projectName}/auth/database/ with paths endpoint, port,
 * and secret-arn, and their stringValue properties SHALL reference the actual
 * Aurora cluster endpoint hostname, port, and credentials secret ARN respectively.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { assert, property, string } from 'fast-check';

import { Database } from '../lib/constructs/auth-server/database';

/**
 * Arbitrary that generates valid CDK-safe project name strings.
 * Project names must be non-empty, alphanumeric with hyphens,
 * and reasonable length for SSM parameter paths.
 */
const projectNameArb = string({ minLength: 1, maxLength: 30 }).filter(
  (s: string) => /^[a-z][a-z0-9-]*$/.test(s) && !s.endsWith('-') && !s.includes('--'),
);

describe('Property 1: Database SSM Parameter Completeness', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
   *
   * For any valid projectName, the Database construct creates exactly three
   * SSM StringParameter resources with correct paths and value references.
   */
  it('should create exactly three SSM parameters with correct paths and value references for any projectName', () => {
    assert(
      property(projectNameArb, (projectName: string) => {
        const stack = new Stack(undefined, 'TestStack', {
          env: { account: '123456789012', region: 'us-west-2' },
        });
        const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2 });

        new Database(stack, 'Database', {
          vpc,
          projectName,
        });

        const template = Template.fromStack(stack);
        const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

        // Find all SSM StringParameter resources
        const ssmParams = Object.entries(resources).filter(
          ([, resource]) => resource.Type === 'AWS::SSM::Parameter',
        );

        // Exactly three SSM parameters must exist
        expect(ssmParams.length).toBe(3);

        const prefix = `/${projectName}/auth/database`;

        // Extract parameter names from the resources
        const paramProps = ssmParams.map(
          ([, resource]) => resource.Properties as Record<string, unknown>,
        );

        const paramNames = paramProps.map(p => p.Name as string);

        // All three expected paths must be present
        expect(paramNames).toContain(`${prefix}/endpoint`);
        expect(paramNames).toContain(`${prefix}/port`);
        expect(paramNames).toContain(`${prefix}/secret-arn`);

        // Verify endpoint parameter references the cluster endpoint hostname
        const endpointParam = paramProps.find(p => p.Name === `${prefix}/endpoint`);
        expect(endpointParam).toBeDefined();
        // The value should be a Fn::GetAtt reference to the DB cluster endpoint
        const endpointValue = endpointParam!.Value;
        expect(endpointValue).toBeDefined();
        expect(JSON.stringify(endpointValue)).toContain('Endpoint.Address');

        // Verify port parameter references the cluster port
        const portParam = paramProps.find(p => p.Name === `${prefix}/port`);
        expect(portParam).toBeDefined();
        const portValue = portParam!.Value;
        expect(portValue).toBeDefined();
        expect(JSON.stringify(portValue)).toContain('Endpoint.Port');

        // Verify secret-arn parameter references the secret ARN
        const secretArnParam = paramProps.find(p => p.Name === `${prefix}/secret-arn`);
        expect(secretArnParam).toBeDefined();
        const secretArnValue = secretArnParam!.Value;
        expect(secretArnValue).toBeDefined();
        // The value should be a Ref to the secret resource
        expect(JSON.stringify(secretArnValue)).toMatch(/Ref|Fn::GetAtt|secretsmanager/i);
      }),
      { numRuns: 20 },
    );
  });
});
