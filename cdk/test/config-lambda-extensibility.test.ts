/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

jest.mock('node:fs', () => {
  const actual: Record<string, unknown> = jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: jest.fn().mockImplementation((path: string) => {
      if (
        typeof path === 'string' &&
        path.includes('keycloak-config') &&
        path.endsWith('.bundle')
      ) {
        return true;
      }
      return (actual.existsSync as (p: string) => boolean)(path);
    }),
  };
});

import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { ILayerVersion, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';

import { Dataplane, DataplaneConfig } from '../lib/constructs/auth-server/dataplane';
import { createTestApp, createTestEnvironment, createTestVpc } from './test-utils';

function createDataplaneStack(
  configLambdaProps: {
    layers?: ILayerVersion[];
    environment?: Record<string, string>;
    runtime?: Runtime;
  } = {},
  build: (stack: Stack) => {
    layers?: ILayerVersion[];
    environment?: Record<string, string>;
    runtime?: Runtime;
  } = () => configLambdaProps,
): Template {
  const app = createTestApp();
  const stack = new Stack(app, 'ConfigLambdaExtensibilityStack', {
    env: createTestEnvironment(),
  });
  const vpc = createTestVpc(stack);
  const securityGroup = new SecurityGroup(stack, 'TestSG', { vpc });
  const built = build(stack);

  new Dataplane(stack, 'Dataplane', {
    account: {
      id: '123456789012',
      region: 'us-west-2',
      prodLike: false,
      isAdc: false,
    },
    vpc,
    securityGroup,
    config: new DataplaneConfig({
      KEYCLOAK_WRAPPER_IMAGE: 'example.registry/keycloak:latest',
      KEYCLOAK_WRAPPER_REPOSITORY_ARN: 'arn:aws:ecr:us-west-2:123456789012:repository/keycloak',
      DOMAIN_INTERNET_FACING: false,
    }),
    configLambdaLayers: built.layers,
    configLambdaEnvironment: built.environment,
    configLambdaRuntime: built.runtime,
  });

  return Template.fromStack(stack);
}

interface LambdaFunctionResource {
  Properties: {
    FunctionName?: string;
    Runtime?: string;
    Layers?: unknown[];
    Environment?: { Variables: Record<string, string> };
  };
}

function findConfigFunction(template: Template): LambdaFunctionResource {
  const functions = template.findResources('AWS::Lambda::Function');
  const match = Object.values(functions).find(fn =>
    (fn.Properties?.FunctionName as string | undefined)?.endsWith('AuthConfigLambdaFunction'),
  );
  expect(match).toBeDefined();
  return match as unknown as LambdaFunctionResource;
}

describe('config Lambda extensibility props', () => {
  test('defaults are unchanged when no props are provided', () => {
    const template = createDataplaneStack();
    const fn = findConfigFunction(template);

    expect(fn.Properties.Runtime).toBe(Runtime.NODEJS_24_X.name);
    expect(fn.Properties.Layers).toBeUndefined();
    expect(fn.Properties.Environment).toBeUndefined();
  });

  test('attaches provided layers and environment to the config Lambda', () => {
    const template = createDataplaneStack({}, stack => ({
      layers: [
        LayerVersion.fromLayerVersionArn(
          stack,
          'CaBundleLayer',
          'arn:aws:lambda:us-west-2:123456789012:layer:ca-bundle:1',
        ),
      ],
      environment: { NODE_EXTRA_CA_CERTS: '/opt/ca-bundle.pem' },
    }));
    const fn = findConfigFunction(template);

    expect(fn.Properties.Layers).toHaveLength(1);
    expect(fn.Properties.Environment).toEqual({
      Variables: { NODE_EXTRA_CA_CERTS: '/opt/ca-bundle.pem' },
    });
  });

  test('overrides the config Lambda runtime when provided', () => {
    const template = createDataplaneStack({ runtime: Runtime.NODEJS_20_X });
    const fn = findConfigFunction(template);

    expect(fn.Properties.Runtime).toBe(Runtime.NODEJS_20_X.name);
  });

  test('grants kms:Decrypt restricted to Secrets Manager via-service usage', () => {
    const template = createDataplaneStack();

    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'KmsDecryptViaSecretsManager',
            Action: 'kms:Decrypt',
            Effect: 'Allow',
            Resource: '*',
            Condition: {
              StringEquals: {
                'kms:ViaService': Match.anyValue(),
              },
            },
          }),
        ]),
      },
    });
  });
});
