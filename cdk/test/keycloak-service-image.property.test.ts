/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Property-based test for Image Source Mutual Exclusivity.
 *
 * **Property 8: Image Source Mutual Exclusivity**
 * For any valid image URI string, when wrapperImage is set, the KeycloakService
 * construct SHALL use ContainerImage.fromRegistry() with that URI and SHALL NOT
 * invoke any Docker build. When wrapperImage is not set, the construct SHALL use
 * ContainerImage.fromAsset() with KEYCLOAK_IMAGE as the base image build argument.
 *
 * **Validates: Requirements 11.1, 11.3, 11.4**
 */

import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { assert, property, string, tuple } from 'fast-check';

import { KeycloakService } from '../lib/constructs/auth-server/keycloak-service';

/**
 * Arbitrary that generates valid container image URI strings.
 * Format: registry/repo:tag
 */
const imageUriArb = tuple(
  string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z][a-z0-9.-]*$/.test(s)),
  string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z][a-z0-9-]*$/.test(s)),
  string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-z0-9][a-z0-9.-]*$/.test(s)),
).map(([registry, repo, tag]) => `${registry}.example.com/${repo}:${tag}`);

describe('Property 8: Image Source Mutual Exclusivity', () => {
  /**
   * **Validates: Requirements 11.1, 11.3**
   *
   * When wrapperImage is set, the container definition uses the registry image
   * (no Docker asset build).
   */
  it('should use fromRegistry when wrapperImage is set', () => {
    assert(
      property(imageUriArb, (wrapperImage: string) => {
        const stack = new Stack(undefined, 'TestStack', {
          env: { account: '123456789012', region: 'us-west-2' },
        });
        const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2 });
        const keycloakSecret = new Secret(stack, 'KeycloakSecret');
        const databaseSecret = new Secret(stack, 'DBSecret');

        new KeycloakService(stack, 'KeycloakService', {
          account: { id: '123456789012', region: 'us-west-2', prodLike: false, isAdc: false },
          vpc,
          databaseSecret,
          keycloakSecret,
          wrapperImage,
        });

        const template = Template.fromStack(stack);

        // When wrapperImage is set, the container image should reference the registry URI directly
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
          ContainerDefinitions: [
            {
              Image: wrapperImage,
            },
          ],
        });
      }),
      { numRuns: 20 },
    );
  });

  /**
   * **Validates: Requirements 11.4**
   *
   * When wrapperImage is NOT set, the container definition uses a Docker asset
   * (fromAsset), which produces an ECR image reference in the template.
   */
  it('should use fromAsset when wrapperImage is not set', () => {
    const stack = new Stack(undefined, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2 });
    const keycloakSecret = new Secret(stack, 'KeycloakSecret');
    const databaseSecret = new Secret(stack, 'DBSecret');

    new KeycloakService(stack, 'KeycloakService', {
      account: { id: '123456789012', region: 'us-west-2', prodLike: false, isAdc: false },
      vpc,
      databaseSecret,
      keycloakSecret,
      // wrapperImage NOT set
    });

    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

    // Find the ECS TaskDefinition
    const taskDefs = Object.entries(resources).filter(
      ([, resource]) => resource.Type === 'AWS::ECS::TaskDefinition',
    );
    expect(taskDefs.length).toBe(1);

    const taskDefProps = taskDefs[0][1].Properties as Record<string, unknown>;
    const containerDefs = taskDefProps.ContainerDefinitions as Array<Record<string, unknown>>;
    expect(containerDefs.length).toBeGreaterThan(0);

    const image = containerDefs[0].Image;
    // fromAsset produces a Fn::Sub or Fn::Join referencing the CDK asset ECR repo,
    // NOT a plain string URI. It should NOT be a simple string.
    expect(typeof image).not.toBe('string');
  });
});
