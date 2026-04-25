/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

jest.mock('node:fs', () => {
  const actual: Record<string, unknown> = jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: jest.fn().mockImplementation((path: string) => {
      // Always return true for the Lambda bundle path check
      if (
        typeof path === 'string' &&
        path.includes('keycloak-config') &&
        path.endsWith('.bundle')
      ) {
        return true;
      }
      // Delegate everything else to the real implementation
      return (actual.existsSync as (p: string) => boolean)(path);
    }),
  };
});

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsSolutionsChecks } from 'cdk-nag';

import { Dataplane, DataplaneConfig } from '../lib/constructs/auth-server/dataplane';
import { OSMLAccount } from '../lib/constructs/types';
import { KeycloakCustomConfig } from '../lib/utils/keycloak-config-loader';
import {
  createTestApp,
  createTestEnvironment,
  createTestVpc,
  generateNagReport,
} from './test-utils';

/**
 * CloudFormation output structure from template.findOutputs()
 */
interface CfnOutput {
  Description?: string;
  Value?: unknown;
  Export?: {
    Name?: string;
  };
}

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

/**
 * Creates a test KeycloakCustomConfig.
 */
function createTestAuthConfig(): KeycloakCustomConfig {
  return {
    realm: 'test-realm',
    enabled: true,
    displayName: 'Test Realm',
    clients: [
      {
        clientId: 'test-client',
        name: 'Test Client',
        publicClient: true,
        authorizationServicesEnabled: false,
      },
    ],
    users: [
      {
        username: 'testuser',
        generatePassword: true,
        email: 'test@example.com',
      },
    ],
  };
}

describe('DataplaneConfig', () => {
  test('uses default values when no config provided', () => {
    const config = new DataplaneConfig();

    expect(config.KEYCLOAK_VERSION).toBe('latest');
    expect(config.KEYCLOAK_ADMIN_USERNAME).toBe('keycloak');
    expect(config.ECS_TASK_CPU).toBe(4096);
    expect(config.ECS_TASK_MEMORY).toBe(8192);
    expect(config.ECS_MIN_CONTAINERS).toBe(2);
    expect(config.ECS_MAX_CONTAINERS).toBe(10);
    expect(config.ECS_CPU_UTILIZATION_TARGET).toBe(75);
    expect(config.JAVA_OPTS).toBe('-server -Xms1024m -Xmx1638m');
    expect(config.DATABASE_INSTANCE_TYPE).toBe('r5.large');
    expect(config.DOMAIN_INTERNET_FACING).toBe(true);
  });

  test('merges provided config with defaults', () => {
    const config = new DataplaneConfig({
      KEYCLOAK_VERSION: '26.0.7',
      ECS_TASK_CPU: 2048,
      DOMAIN_HOSTNAME: 'auth.example.com',
    });

    expect(config.KEYCLOAK_VERSION).toBe('26.0.7');
    expect(config.ECS_TASK_CPU).toBe(2048);
    expect(config.DOMAIN_HOSTNAME).toBe('auth.example.com');
    // Defaults preserved
    expect(config.KEYCLOAK_ADMIN_USERNAME).toBe('keycloak');
    expect(config.ECS_TASK_MEMORY).toBe(8192);
  });

  test('allows setting all domain configuration', () => {
    const config = new DataplaneConfig({
      DOMAIN_HOSTNAME: 'auth.example.com',
      DOMAIN_CERTIFICATE_ARN: 'arn:aws:acm:us-west-2:123456789012:certificate/abc123',
      DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
      DOMAIN_INTERNET_FACING: false,
    });

    expect(config.DOMAIN_HOSTNAME).toBe('auth.example.com');
    expect(config.DOMAIN_CERTIFICATE_ARN).toBe(
      'arn:aws:acm:us-west-2:123456789012:certificate/abc123',
    );
    expect(config.DOMAIN_HOSTED_ZONE_ID).toBe('Z1234567890ABC');
    expect(config.DOMAIN_INTERNET_FACING).toBe(false);
  });
});

describe('Dataplane construct', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let securityGroup: SecurityGroup;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });
  });

  describe('Basic creation', () => {
    test('creates Dataplane with all required components', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      expect(dataplane.database).toBeDefined();
      expect(dataplane.keycloakService).toBeDefined();
      expect(dataplane.config).toBeDefined();
    });

    test('creates database construct', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Should have RDS cluster
      template.resourceCountIs('AWS::RDS::DBCluster', 1);

      // Should have database secret
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Description: Match.stringLikeRegexp('.*database.*'),
      });
    });

    test('creates Keycloak service construct', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Should have ECS cluster
      template.resourceCountIs('AWS::ECS::Cluster', 1);

      // Should have ECS service
      template.resourceCountIs('AWS::ECS::Service', 1);

      // Should have Application Load Balancer
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    });

    test('creates Keycloak admin secret', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        projectName: 'test-project',
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'test-project-auth/keycloak-admin',
        Description: Match.stringLikeRegexp('.*Admin credentials.*'),
      });
    });
  });

  describe('Configuration merging', () => {
    test('uses default config when none provided', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      expect(dataplane.config.KEYCLOAK_VERSION).toBe('latest');
      expect(dataplane.config.ECS_TASK_CPU).toBe(4096);
    });

    test('uses provided config values', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          KEYCLOAK_VERSION: '25.0.6',
          ECS_TASK_CPU: 2048,
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      expect(dataplane.config.KEYCLOAK_VERSION).toBe('25.0.6');
      expect(dataplane.config.ECS_TASK_CPU).toBe(2048);
    });
  });

  describe('VPC usage', () => {
    test('uses provided VPC for database', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Database subnet group should reference VPC subnets
      template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
        DBSubnetGroupDescription: Match.anyValue(),
      });
    });

    test('uses provided VPC for ECS service', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // ECS service should have network configuration
      template.hasResourceProperties('AWS::ECS::Service', {
        NetworkConfiguration: Match.objectLike({
          AwsvpcConfiguration: Match.objectLike({
            AssignPublicIp: 'DISABLED',
          }),
        }),
      });
    });
  });

  describe('Conditional config Lambda creation', () => {
    test('does not create config Lambda when KEYCLOAK_AUTH_CONFIG is not provided', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      expect(dataplane.configLambda).toBeUndefined();
    });

    test('creates config Lambda when KEYCLOAK_AUTH_CONFIG is provided', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
          KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
        }),
      });

      expect(dataplane.configLambda).toBeDefined();

      const template = Template.fromStack(stack);

      // Should have Lambda function for config
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs24.x',
      });
    });

    test('custom resource has dependency on KeycloakService', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
          KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
        }),
      });

      // Only the custom resource (not the whole construct) depends on the service
      const customResourceDeps = dataplane.configLambda!.customResource.node.dependencies;
      expect(customResourceDeps.length).toBeGreaterThan(0);
    });
  });

  describe('CloudFormation outputs', () => {
    test('creates LoadBalancerDNS output', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        projectName: 'test-project',
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Check that an output with the expected export name exists
      const outputs = template.findOutputs('*');
      const loadBalancerOutput = Object.values(outputs).find(
        (output: CfnOutput) => output.Export?.Name === 'test-project-LoadBalancerDNS',
      );
      expect(loadBalancerOutput).toBeDefined();
      expect(loadBalancerOutput?.Description).toBe('DNS name of the Application Load Balancer');
    });

    test('creates KeycloakUrl output', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        projectName: 'test-project',
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*');
      const keycloakUrlOutput = Object.values(outputs).find(
        (output: CfnOutput) => output.Export?.Name === 'test-project-KeycloakUrl',
      );
      expect(keycloakUrlOutput).toBeDefined();
      expect(keycloakUrlOutput?.Description).toBe('URL to access Keycloak');
    });

    test('creates KeycloakAdminSecretArn output', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        projectName: 'test-project',
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*');
      const secretArnOutput = Object.values(outputs).find(
        (output: CfnOutput) => output.Export?.Name === 'test-project-KeycloakAdminSecretArn',
      );
      expect(secretArnOutput).toBeDefined();
      expect(secretArnOutput?.Description).toBe('ARN of the Keycloak admin credentials secret');
    });
  });

  describe('Security group ingress rules', () => {
    test('configures database security group to allow connections from app security group', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Should have security group ingress rule for MySQL port
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 3306,
        ToPort: 3306,
      });
    });
  });

  describe('Production settings', () => {
    test('applies prod settings when prodLike is true', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount({ prodLike: true }),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Database should have deletion protection
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        DeletionProtection: true,
      });

      template.hasResource('AWS::RDS::DBCluster', {
        DeletionPolicy: 'Snapshot',
      });
    });

    test('does not apply deletion protection for non-prod', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount({ prodLike: false }),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Database should not have deletion protection
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        DeletionProtection: false,
      });

      template.hasResource('AWS::RDS::DBCluster', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('Project naming', () => {
    test('uses default project name when not provided', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      // Should use 'keycloak' as default project name
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'keycloak-auth/keycloak-admin',
      });
    });

    test('uses provided project name', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        projectName: 'my-auth-server',
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'my-auth-server-auth/keycloak-admin',
      });
    });
  });

  describe('TLS and certificate handling', () => {
    test('throws error when internet-facing without TLS configuration', () => {
      expect(() => {
        new Dataplane(stack, 'Dataplane', {
          account: createTestAccount(),
          vpc,
          securityGroup,
          config: new DataplaneConfig({
            DOMAIN_INTERNET_FACING: true,
            DOMAIN_HOSTNAME: 'auth.example.com',
            // No DOMAIN_CERTIFICATE_ARN and no DOMAIN_HOSTED_ZONE_ID
          }),
        });
      }).toThrow(
        'TLS is required for public-facing deployments. Provide either DOMAIN_CERTIFICATE_ARN ' +
          'or DOMAIN_HOSTED_ZONE_ID (to auto-create an ACM certificate with DNS validation).',
      );
    });

    test('throws error when internet-facing without hostname or zone name', () => {
      expect(() => {
        new Dataplane(stack, 'Dataplane', {
          account: createTestAccount(),
          vpc,
          securityGroup,
          config: new DataplaneConfig({
            DOMAIN_INTERNET_FACING: true,
            // No DOMAIN_HOSTNAME and no DOMAIN_HOSTED_ZONE_NAME
          }),
        });
      }).toThrow(
        'DOMAIN_HOSTNAME or DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_INTERNET_FACING is true (public-facing deployment)',
      );
    });

    test('throws error when hosted zone ID provided without zone name', () => {
      expect(() => {
        new Dataplane(stack, 'Dataplane', {
          account: createTestAccount(),
          vpc,
          securityGroup,
          config: new DataplaneConfig({
            DOMAIN_INTERNET_FACING: true,
            DOMAIN_HOSTNAME: 'auth.example.com',
            DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
            // Missing DOMAIN_HOSTED_ZONE_NAME
          }),
        });
      }).toThrow('DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_HOSTED_ZONE_ID is provided.');
    });

    test('uses provided certificate ARN when specified', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTNAME: 'auth.example.com',
          DOMAIN_CERTIFICATE_ARN: 'arn:aws:acm:us-west-2:123456789012:certificate/abc123',
        }),
      });

      const template = Template.fromStack(stack);

      // Should have HTTPS listener with provided certificate
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        Certificates: [
          {
            CertificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/abc123',
          },
        ],
      });

      // Should NOT create a new certificate
      template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    });

    test('creates ACM certificate when hosted zone provided without certificate ARN', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTNAME: 'auth.example.com',
          DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
          DOMAIN_HOSTED_ZONE_NAME: 'example.com',
          // No DOMAIN_CERTIFICATE_ARN - should auto-create
        }),
      });

      const template = Template.fromStack(stack);

      // Should create ACM certificate
      template.resourceCountIs('AWS::CertificateManager::Certificate', 1);

      // Certificate should have DNS validation
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'auth.example.com',
        ValidationMethod: 'DNS',
      });

      // Should have HTTPS listener
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
      });

      // Certificate should be exposed on the construct
      expect(dataplane.certificate).toBeDefined();
    });

    test('defaults hostname to auth.{zoneName} when only zone name provided', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
          DOMAIN_HOSTED_ZONE_NAME: 'example.com',
          // No DOMAIN_HOSTNAME - should default to auth.example.com
        }),
      });

      const template = Template.fromStack(stack);

      // Certificate should use the derived hostname
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'auth.example.com',
        ValidationMethod: 'DNS',
      });

      // DNS record should use the derived hostname
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'auth.example.com.',
        Type: 'A',
      });

      expect(dataplane.certificate).toBeDefined();
    });

    test('applies DESTROY removal policy to auto-created certificate in non-prod', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount({ prodLike: false }),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
          DOMAIN_HOSTED_ZONE_NAME: 'example.com',
        }),
      });

      const template = Template.fromStack(stack);

      // Certificate should have DESTROY removal policy (DeletionPolicy: Delete)
      template.hasResource('AWS::CertificateManager::Certificate', {
        DeletionPolicy: 'Delete',
      });
    });

    test('applies RETAIN removal policy to auto-created certificate in prod', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount({ prodLike: true }),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
          DOMAIN_HOSTED_ZONE_NAME: 'example.com',
        }),
      });

      const template = Template.fromStack(stack);

      // Certificate should have RETAIN removal policy
      template.hasResource('AWS::CertificateManager::Certificate', {
        DeletionPolicy: 'Retain',
      });
    });

    test('allows HTTP for internal deployments without TLS config', () => {
      // This should NOT throw - internal deployments can use HTTP
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
          // No hostname, no certificate, no hosted zone
        }),
      });

      const template = Template.fromStack(stack);

      // Should have HTTP listener (port 80)
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
      });

      // Should NOT create certificate
      template.resourceCountIs('AWS::CertificateManager::Certificate', 0);

      // Certificate property should be undefined
      expect(dataplane.certificate).toBeUndefined();
    });

    test('creates DNS A record when hosted zone is provided', () => {
      new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: true,
          DOMAIN_HOSTED_ZONE_ID: 'Z1234567890ABC',
          DOMAIN_HOSTED_ZONE_NAME: 'example.com',
        }),
      });

      const template = Template.fromStack(stack);

      // Should create Route53 A record with derived hostname
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'auth.example.com.',
        Type: 'A',
      });
    });
  });
});

describe('cdk-nag Compliance Checks - Dataplane', () => {
  let stack: Stack;

  beforeAll(() => {
    const app = createTestApp();
    const env = createTestEnvironment();
    stack = new Stack(app, 'NagDataplaneStack', { env });
    const vpc = createTestVpc(stack);
    const securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });

    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
        BACKTRACK_WINDOW_SECONDS: 3600,
        DATABASE_PORT: 3307,
      }),
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

describe('Database SSM parameter publication', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let securityGroup: SecurityGroup;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });
  });

  test('creates SSM parameters for database endpoint, port, and secret-arn', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    // Verify the three database SSM parameters exist with correct paths
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/auth/database/endpoint'),
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/auth/database/port'),
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/auth/database/secret-arn'),
    });
  });

  test('database SSM parameter values reference Aurora cluster properties', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

    // Find all SSM parameters under the database prefix
    const dbSsmParams = Object.entries(resources).filter(([, resource]) => {
      if (resource.Type !== 'AWS::SSM::Parameter') return false;
      const props = resource.Properties as Record<string, unknown>;
      const name = props.Name as string | undefined;
      return name && typeof name === 'string' && name.includes('/auth/database/');
    });

    expect(dbSsmParams.length).toBe(3);

    // Verify endpoint value references the DB cluster endpoint
    const endpointParam = dbSsmParams.find(([, r]) => {
      const props = r.Properties as Record<string, unknown>;
      return (props.Name as string).endsWith('/endpoint');
    });
    expect(endpointParam).toBeDefined();
    const endpointValue = (endpointParam![1].Properties as Record<string, unknown>).Value;
    expect(JSON.stringify(endpointValue)).toContain('Endpoint.Address');

    // Verify port value references the DB cluster port
    const portParam = dbSsmParams.find(([, r]) => {
      const props = r.Properties as Record<string, unknown>;
      return (props.Name as string).endsWith('/port');
    });
    expect(portParam).toBeDefined();
    const portValue = (portParam![1].Properties as Record<string, unknown>).Value;
    expect(JSON.stringify(portValue)).toContain('Endpoint.Port');

    // Verify secret-arn value references the secret
    const secretArnParam = dbSsmParams.find(([, r]) => {
      const props = r.Properties as Record<string, unknown>;
      return (props.Name as string).endsWith('/secret-arn');
    });
    expect(secretArnParam).toBeDefined();
    const secretArnValue = (secretArnParam![1].Properties as Record<string, unknown>).Value;
    expect(JSON.stringify(secretArnValue)).toMatch(/Ref|Fn::GetAtt|secretsmanager/i);
  });

  test('without KEYCLOAK_AUTH_CONFIG, Dataplane has exactly 5 SSM parameters (3 database + 2 keycloak service)', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SSM::Parameter', 5);
  });
});

describe('KeycloakService SSM and image sourcing', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let securityGroup: SecurityGroup;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });
  });

  test('creates SSM parameters for keycloak url and admin-secret-arn', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/auth/keycloak/url'),
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: Match.stringLikeRegexp('.*/auth/keycloak/admin-secret-arn'),
    });
  });

  test('uses ContainerImage.fromAsset by default (no KEYCLOAK_WRAPPER_IMAGE)', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    // When using fromAsset, the container image in the task definition references a CDK asset
    // (not a registry URI like quay.io or ecr). CDK asset images use a hash-based reference.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: Match.objectLike({
            'Fn::Sub': Match.anyValue(),
          }),
        }),
      ]),
    });
  });

  test('uses ContainerImage.fromRegistry when KEYCLOAK_WRAPPER_IMAGE is set', () => {
    const wrapperImageUri = 'test-registry.example.com/keycloak-wrapper:latest';

    const wrapperStack = new Stack(app, 'WrapperStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const wrapperVpc = new Vpc(wrapperStack, 'TestVpc', { maxAzs: 2 });
    const wrapperSg = new SecurityGroup(wrapperStack, 'TestSG', {
      vpc: wrapperVpc,
      description: 'Test security group',
    });

    new Dataplane(wrapperStack, 'Dataplane', {
      account: createTestAccount(),
      vpc: wrapperVpc,
      securityGroup: wrapperSg,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_WRAPPER_IMAGE: wrapperImageUri,
      }),
    });

    const template = Template.fromStack(wrapperStack);

    // When using fromRegistry, the image is the literal URI string
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: wrapperImageUri,
        }),
      ]),
    });
  });

  test('ECS task role has ssm:GetParameter scoped to database prefix', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    // Verify IAM policy with ssm:GetParameter scoped to database prefix
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;
    const policies = Object.values(resources).filter(r => r.Type === 'AWS::IAM::Policy');
    const hasSsmDbPolicy = policies.some(policy => {
      const doc = (policy.Properties as Record<string, unknown>).PolicyDocument as Record<
        string,
        unknown
      >;
      const statements = (doc.Statement as Record<string, unknown>[]) || [];
      return statements.some(stmt => {
        const action = stmt.Action;
        const resource = JSON.stringify(stmt.Resource || '');
        return action === 'ssm:GetParameter' && resource.includes('/auth/database/*');
      });
    });
    expect(hasSsmDbPolicy).toBe(true);
  });

  test('KC_DB_PASSWORD is injected via ECS Secrets Manager integration', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    // Verify KC_DB_PASSWORD is injected as a secret (not an environment variable)
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({
              Name: 'KC_DB_PASSWORD',
            }),
          ]),
        }),
      ]),
    });
  });

  test('container environment has SSM_PREFIX variable', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
      }),
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({
              Name: 'SSM_PREFIX',
              Value: '/test-project/auth',
            }),
          ]),
        }),
      ]),
    });
  });
});

describe('KeycloakConfig custom resource architecture', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let securityGroup: SecurityGroup;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });

    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
      }),
    });
  });

  test('Custom::KeycloakConfig resource exists in template', () => {
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

    const keycloakCustomResources = Object.entries(resources).filter(([, resource]) => {
      const type = resource.Type as string;
      return type === 'Custom::KeycloakConfig';
    });

    expect(keycloakCustomResources).toHaveLength(1);
  });

  test('no SQS queues in template', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 0);
  });

  test('no EventBridge rules in template', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Events::Rule', 0);
  });

  test('no SQS event source mapping in template', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('no CloudWatch alarm for DLQ in template', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  test('Lambda environment has SSM_PREFIX instead of KEYCLOAK_URL/KEYCLOAK_ADMIN_SECRET_ARN', () => {
    const template = Template.fromStack(stack);

    // Verify SSM_PREFIX is set
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          SSM_PREFIX: Match.stringLikeRegexp('.*/auth'),
        }),
      }),
    });

    // Verify KEYCLOAK_URL and KEYCLOAK_ADMIN_SECRET_ARN are NOT in the environment
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;
    const lambdaFunctions = Object.entries(resources).filter(
      ([, resource]) => resource.Type === 'AWS::Lambda::Function',
    );

    for (const [, resource] of lambdaFunctions) {
      const props = resource.Properties as Record<string, unknown>;
      const env = props.Environment as Record<string, unknown> | undefined;
      if (env) {
        const vars = env.Variables as Record<string, unknown> | undefined;
        if (vars) {
          expect(vars).not.toHaveProperty('KEYCLOAK_URL');
          expect(vars).not.toHaveProperty('KEYCLOAK_ADMIN_SECRET_ARN');
        }
      }
    }
  });
});

describe('Dataplane decoupling', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let securityGroup: SecurityGroup;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    securityGroup = new SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });
  });

  test('Custom::KeycloakConfig resource has DependsOn to KeycloakService', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
      }),
    });

    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, Record<string, unknown>>;

    // Find the Custom::KeycloakConfig resource
    const customResourceEntries = Object.entries(resources).filter(([, resource]) => {
      const type = resource.Type as string;
      return type === 'Custom::KeycloakConfig';
    });

    expect(customResourceEntries.length).toBe(1);

    // The custom resource should have dependencies (via node.addDependency on KeycloakService)
    const [, customResource] = customResourceEntries[0];
    const dependsOn = customResource.DependsOn as string[] | string | undefined;
    expect(dependsOn).toBeDefined();
  });

  test('no databaseHost, databasePort, or databaseSecret props threaded in template', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
      }),
    });

    const template = Template.fromStack(stack);
    const templateJson = JSON.stringify(template.toJSON());

    // These prop names should not appear anywhere in the synthesized template
    // because they were removed during decoupling
    expect(templateJson).not.toContain('"databaseHost"');
    expect(templateJson).not.toContain('"databasePort"');
    expect(templateJson).not.toContain('"databaseSecret"');
  });

  test('security group ingress rule preserved for MySQL from Keycloak service SG', () => {
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      config: new DataplaneConfig({
        DOMAIN_INTERNET_FACING: false,
        KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
      }),
    });

    const template = Template.fromStack(stack);

    // Database security group should still allow MySQL (3306) from Keycloak service SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 3306,
      ToPort: 3306,
    });
  });
});

describe('ALB WAF', () => {
  function buildStack(config: Partial<DataplaneConfig> = {}): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const vpc = new Vpc(stack, 'TestVpc', { maxAzs: 2 });
    const securityGroup = new SecurityGroup(stack, 'TestSG', { vpc });
    new Dataplane(stack, 'Dataplane', {
      account: createTestAccount(),
      vpc,
      securityGroup,
      projectName: 'test-project',
      config: new DataplaneConfig({ DOMAIN_INTERNET_FACING: false, ...config }),
    });
    return Template.fromStack(stack);
  }

  test('WebACL is created and associated to the ALB by default', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1);
  });

  test('WebACL includes KnownBadInputs and rate-limit rules', () => {
    const template = buildStack();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesKnownBadInputsRuleSet',
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        }),
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Action: { Block: {} },
          Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP' } },
        }),
      ]),
    });
  });

  test('custom REQUESTS_PER_5_MIN is honored', () => {
    const template = buildStack({ DOMAIN_WAF: { REQUESTS_PER_5_MIN: 500 } });
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Statement: { RateBasedStatement: { Limit: 500 } },
        }),
      ]),
    });
  });

  test('WAF is skipped when DOMAIN_WAF.ENABLED is false', () => {
    const template = buildStack({ DOMAIN_WAF: { ENABLED: false } });
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
  });
});
