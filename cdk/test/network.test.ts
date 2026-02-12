/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsSolutionsChecks } from 'cdk-nag';

import { Network, NetworkConfig } from '../lib/constructs/auth-server/network';
import { OSMLAccount } from '../lib/constructs/types';
import { NetworkStack } from '../lib/network-stack';
import {
  createTestApp,
  createTestDeploymentConfig,
  createTestEnvironment,
  generateNagReport,
} from './test-utils';

/**
 * Creates a test OSMLAccount configuration.
 */
function createTestAccount(overrides?: Partial<OSMLAccount>): OSMLAccount {
  return {
    id: '123456789012',
    region: 'us-west-2',
    prodLike: false,
    isAdc: false,
    ...overrides,
  };
}

describe('NetworkConfig', () => {
  test('uses default values when no config provided', () => {
    const config = new NetworkConfig();

    expect(config.VPC_NAME).toBe('auth-server-vpc');
    expect(config.SECURITY_GROUP_NAME).toBe('auth-server-security-group');
    expect(config.MAX_AZS).toBe(2);
    expect(config.VPC_ID).toBeUndefined();
    expect(config.TARGET_SUBNETS).toBeUndefined();
    expect(config.SECURITY_GROUP_ID).toBeUndefined();
  });

  test('merges provided config with defaults', () => {
    const config = new NetworkConfig({
      VPC_NAME: 'custom-vpc',
      MAX_AZS: 3,
    });

    expect(config.VPC_NAME).toBe('custom-vpc');
    expect(config.MAX_AZS).toBe(3);
    // Defaults preserved
    expect(config.SECURITY_GROUP_NAME).toBe('auth-server-security-group');
  });

  test('allows setting VPC_ID for import', () => {
    const config = new NetworkConfig({
      VPC_ID: 'vpc-12345678',
      TARGET_SUBNETS: ['subnet-12345678'],
    });

    expect(config.VPC_ID).toBe('vpc-12345678');
    expect(config.TARGET_SUBNETS).toEqual(['subnet-12345678']);
  });

  test('allows setting SECURITY_GROUP_ID for import', () => {
    const config = new NetworkConfig({
      SECURITY_GROUP_ID: 'sg-12345678',
    });

    expect(config.SECURITY_GROUP_ID).toBe('sg-12345678');
  });
});

describe('Network construct', () => {
  let app: App;
  let stack: Stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
  });

  describe('VPC creation', () => {
    test('creates new VPC with default settings when no VPC provided', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      expect(network.vpc).toBeDefined();
      expect(network.config.VPC_NAME).toBe('auth-server-vpc');

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::EC2::VPC', 1);
    });

    test('creates VPC with custom name', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
        config: new NetworkConfig({ VPC_NAME: 'my-custom-vpc' }),
      });

      expect(network.config.VPC_NAME).toBe('my-custom-vpc');

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::EC2::VPC', {
        Tags: Match.arrayWith([Match.objectLike({ Key: 'Name', Value: 'my-custom-vpc' })]),
      });
    });

    test('creates VPC with public and private subnets', () => {
      new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      const template = Template.fromStack(stack);

      // Should have subnets (2 AZs * 2 subnet types = 4 subnets)
      template.resourceCountIs('AWS::EC2::Subnet', 4);
    });

    test('uses provided VPC when passed as prop', () => {
      const existingVpc = new Vpc(stack, 'ExistingVpc', {
        maxAzs: 2,
      });

      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
        vpc: existingVpc,
      });

      expect(network.vpc).toBe(existingVpc);
    });

    test('prioritizes provided VPC over config VPC_ID', () => {
      const existingVpc = new Vpc(stack, 'ExistingVpc', {
        maxAzs: 2,
      });

      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
        config: new NetworkConfig({ VPC_ID: 'vpc-from-config' }),
        vpc: existingVpc,
      });

      // Should use the provided VPC, not try to import
      expect(network.vpc).toBe(existingVpc);
    });
  });

  describe('VPC flow logs', () => {
    test('creates flow logs with one-month retention', () => {
      new Network(stack, 'Network', {
        account: createTestAccount({ prodLike: false }),
      });

      const template = Template.fromStack(stack);

      // Should have flow log
      template.resourceCountIs('AWS::EC2::FlowLog', 1);

      // Should have log group with ONE_MONTH retention (30 days)
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });

    test('creates flow logs with one-month retention for prod', () => {
      new Network(stack, 'Network', {
        account: createTestAccount({ prodLike: true }),
      });

      const template = Template.fromStack(stack);

      // Should have flow log
      template.resourceCountIs('AWS::EC2::FlowLog', 1);

      // Should have log group with ONE_MONTH retention (30 days)
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });

    test('sets RETAIN removal policy for prod flow log group', () => {
      new Network(stack, 'Network', {
        account: createTestAccount({ prodLike: true }),
      });

      const template = Template.fromStack(stack);

      // Check that the log group has Retain deletion policy
      template.hasResource('AWS::Logs::LogGroup', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    test('sets DESTROY removal policy for non-prod flow log group', () => {
      new Network(stack, 'Network', {
        account: createTestAccount({ prodLike: false }),
      });

      const template = Template.fromStack(stack);

      // Check that the log group has Delete deletion policy
      template.hasResource('AWS::Logs::LogGroup', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('Security group resolution', () => {
    test('creates new security group when no SECURITY_GROUP_ID provided', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      expect(network.securityGroup).toBeDefined();

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for auth server resources',
      });
    });

    test('creates security group with custom name', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
        config: new NetworkConfig({ SECURITY_GROUP_NAME: 'my-custom-sg' }),
      });

      expect(network.config.SECURITY_GROUP_NAME).toBe('my-custom-sg');

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'my-custom-sg',
      });
    });

    test('creates security group with allowAllOutbound', () => {
      new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      const template = Template.fromStack(stack);

      // Security group should have egress rule allowing all outbound
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            CidrIp: '0.0.0.0/0',
            IpProtocol: '-1',
          }),
        ]),
      });
    });
  });

  describe('Exposed properties', () => {
    test('exposes vpc property', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      expect(network.vpc).toBeDefined();
    });

    test('exposes securityGroup property', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      expect(network.securityGroup).toBeDefined();
    });

    test('exposes config property', () => {
      const network = new Network(stack, 'Network', {
        account: createTestAccount(),
      });

      expect(network.config).toBeDefined();
      expect(network.config).toBeInstanceOf(NetworkConfig);
    });
  });
});

describe('NetworkStack', () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  test('creates stack with new VPC when no VPC provided', () => {
    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig(),
    });

    expect(stack.network).toBeDefined();
    expect(stack.network.vpc).toBeDefined();

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('uses provided VPC when passed as prop', () => {
    const vpcStack = new Stack(app, 'VpcStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const existingVpc = new Vpc(vpcStack, 'ExistingVpc');

    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig(),
      vpc: existingVpc,
    });

    expect(stack.network).toBeDefined();
    expect(stack.network.vpc).toBe(existingVpc);
  });

  test('creates network construct with default config when none provided', () => {
    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig(),
    });

    expect(stack.network).toBeDefined();
    expect(stack.network.config.VPC_NAME).toBe('auth-server-vpc');
    expect(stack.network.config.SECURITY_GROUP_NAME).toBe('auth-server-security-group');
  });

  test('creates network construct with custom config when provided', () => {
    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig({
        networkConfig: {
          VPC_NAME: 'custom-vpc',
          SECURITY_GROUP_NAME: 'custom-sg',
          MAX_AZS: 3,
        },
      }),
    });

    expect(stack.network).toBeDefined();
    expect(stack.network.config.VPC_NAME).toBe('custom-vpc');
    expect(stack.network.config.SECURITY_GROUP_NAME).toBe('custom-sg');
    expect(stack.network.config.MAX_AZS).toBe(3);
  });

  test('passes account configuration to Network construct', () => {
    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig({
        account: {
          id: '123456789012',
          region: 'us-west-2',
          prodLike: true,
          isAdc: true,
        },
      }),
    });

    expect(stack.network).toBeDefined();

    // Verify prod-like settings are applied (one-month retention)
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });

  test('prioritizes provided VPC prop over deployment config VPC ID', () => {
    const vpcStack = new Stack(app, 'VpcStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const providedVpc = new Vpc(vpcStack, 'ProvidedVpc');

    const stack = new NetworkStack(app, 'TestNetworkStack', {
      env: { account: '123456789012', region: 'us-west-2' },
      deployment: createTestDeploymentConfig({
        networkConfig: {
          VPC_ID: 'vpc-from-config',
          TARGET_SUBNETS: ['subnet-12345678'],
        },
      }),
      vpc: providedVpc,
    });

    // Should use the provided VPC prop
    expect(stack.network.vpc).toBe(providedVpc);
  });
});

describe('cdk-nag Compliance Checks - NetworkStack', () => {
  let stack: NetworkStack;

  beforeAll(() => {
    const app = createTestApp();
    const env = createTestEnvironment();

    stack = new NetworkStack(app, 'NagNetworkStack', {
      env,
      deployment: createTestDeploymentConfig(),
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
