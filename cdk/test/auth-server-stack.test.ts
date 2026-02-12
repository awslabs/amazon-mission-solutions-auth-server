/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsSolutionsChecks } from 'cdk-nag';

import { DeploymentConfig } from '../bin/deployment/load-deployment';
import { AuthServerStack } from '../lib/auth-server-stack';
import {
  createTestApp,
  createTestDeploymentConfig,
  createTestEnvironment,
  createTestVpc,
  generateNagReport,
} from './test-utils';

describe('AuthServerStack', () => {
  let app: App;
  let vpcStack: Stack;
  let testVpc: Vpc;

  beforeEach(() => {
    app = new App();
    vpcStack = new Stack(app, 'VpcStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    testVpc = new Vpc(vpcStack, 'TestVpc', {
      maxAzs: 2,
    });
  });

  describe('Stack creation with VPC parameter', () => {
    test('creates stack with provided VPC', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();

      const template = Template.fromStack(stack);
      // Should not create a new VPC - uses the provided one
      template.resourceCountIs('AWS::EC2::VPC', 0);
    });

    test('creates Dataplane construct with VPC from props', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();
      expect(stack.dataplane.database).toBeDefined();
      expect(stack.dataplane.keycloakService).toBeDefined();
    });

    test('creates stack with provided security group', () => {
      const testSecurityGroup = new SecurityGroup(vpcStack, 'TestSG', {
        vpc: testVpc,
        description: 'Test security group',
      });

      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
        securityGroup: testSecurityGroup,
      });

      expect(stack.dataplane).toBeDefined();

      const template = Template.fromStack(stack);
      // Should create security group for database but not for dataplane (using provided)
      // The Dataplane creates its own security groups for database and service
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp('.*'),
      });
    });

    test('creates default security group when none provided', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();

      const template = Template.fromStack(stack);
      // Should create a security group for the dataplane
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: `Security group for test-auth-server`,
      });
    });
  });

  describe('Termination protection', () => {
    test('enables termination protection for prod environment', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig({
          account: {
            id: '123456789012',
            region: 'us-west-2',
            prodLike: true,
            isAdc: false,
          },
        }),
        vpc: testVpc,
      });

      expect(stack.terminationProtection).toBe(true);
    });

    test('disables termination protection for non-prod environment', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig({
          account: {
            id: '123456789012',
            region: 'us-west-2',
            prodLike: false,
            isAdc: false,
          },
        }),
        vpc: testVpc,
      });

      expect(stack.terminationProtection).toBe(false);
    });
  });

  describe('Dataplane construct instantiation', () => {
    test('exposes dataplane as public property', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();
      expect(stack.dataplane.database).toBeDefined();
      expect(stack.dataplane.keycloakService).toBeDefined();
    });

    test('creates database construct', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::RDS::DBCluster', 1);
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        Engine: 'aurora-mysql',
      });
    });

    test('creates ECS Fargate service', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::ECS::Service', 1);
      template.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
      });
    });

    test('creates Application Load Balancer', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    });

    test('creates Keycloak config Lambda when KEYCLOAK_AUTH_CONFIG is provided', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig({
          dataplaneConfig: {
            KEYCLOAK_AUTH_CONFIG: {
              realm: 'test-realm',
              enabled: true,
              clients: [],
              users: [],
            },
          },
        }),
        vpc: testVpc,
      });

      expect(stack.dataplane.configLambda).toBeDefined();

      const template = Template.fromStack(stack);
      // Should have Lambda function for Keycloak config
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: Match.stringLikeRegexp('nodejs.*'),
      });
    });

    test('does not create Keycloak config Lambda when KEYCLOAK_AUTH_CONFIG is not provided', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane.configLambda).toBeUndefined();
    });
  });

  describe('Configuration passing', () => {
    test('passes deployment config to Dataplane', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig({
          dataplaneConfig: {
            ECS_TASK_CPU: 2048,
            ECS_TASK_MEMORY: 4096,
          },
        }),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();
      expect(stack.dataplane.config.ECS_TASK_CPU).toBe(2048);
      expect(stack.dataplane.config.ECS_TASK_MEMORY).toBe(4096);
    });

    test('uses default config when dataplaneConfig not provided', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      expect(stack.dataplane).toBeDefined();
      // Should use default values
      expect(stack.dataplane.config.ECS_TASK_CPU).toBe(4096);
      expect(stack.dataplane.config.ECS_TASK_MEMORY).toBe(8192);
    });

    test('sets stack description with project name', () => {
      const customDeployment: DeploymentConfig = {
        projectName: 'my-custom-project',
        account: {
          id: '123456789012',
          region: 'us-west-2',
          prodLike: false,
          isAdc: false,
        },
        dataplaneConfig: {
          DOMAIN_INTERNET_FACING: false,
        },
      };

      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: customDeployment,
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      expect(template.toJSON().Description).toBe('my-custom-project Dataplane');
    });
  });

  describe('CloudFormation outputs', () => {
    test('creates LoadBalancerDNS output', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.hasOutput('*', {
        Description: 'DNS name of the Application Load Balancer',
      });
    });

    test('creates KeycloakUrl output', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.hasOutput('*', {
        Description: 'URL to access Keycloak',
      });
    });

    test('creates KeycloakAdminSecretArn output', () => {
      const stack = new AuthServerStack(app, 'TestAuthServerStack', {
        env: { account: '123456789012', region: 'us-west-2' },
        deployment: createTestDeploymentConfig(),
        vpc: testVpc,
      });

      const template = Template.fromStack(stack);
      template.hasOutput('*', {
        Description: 'ARN of the Keycloak admin credentials secret',
      });
    });
  });
});

describe('cdk-nag Compliance Checks - AuthServerStack', () => {
  let stack: AuthServerStack;

  beforeAll(() => {
    const app = createTestApp();
    const env = createTestEnvironment();
    const vpcStack = new Stack(app, 'NagVpcStack', { env });
    const testVpc = createTestVpc(vpcStack);

    stack = new AuthServerStack(app, 'NagAuthServerStack', {
      env,
      deployment: createTestDeploymentConfig({
        dataplaneConfig: {
          DOMAIN_INTERNET_FACING: false,
          BACKTRACK_WINDOW_SECONDS: 3600,
          DATABASE_PORT: 3307,
          KEYCLOAK_AUTH_CONFIG: {
            realm: 'test-realm',
            enabled: true,
            clients: [],
            users: [
              {
                username: 'testuser',
                generatePassword: true,
                email: 'test@example.com',
              },
            ],
          },
        },
      }),
      vpc: testVpc,
    });

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));

    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    generateNagReport(stack, errors, warnings);
  });

  test('No unsuppressed Errors', () => {
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(errors).toHaveLength(0);
  });

  test('No unsuppressed Warnings', () => {
    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(warnings).toHaveLength(0);
  });
});
