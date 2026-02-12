/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

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

    expect(config.KEYCLOAK_IMAGE).toBe('quay.io/keycloak/keycloak:latest');
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
      KEYCLOAK_IMAGE: 'custom-image:v1',
      ECS_TASK_CPU: 2048,
      DOMAIN_HOSTNAME: 'auth.example.com',
    });

    expect(config.KEYCLOAK_IMAGE).toBe('custom-image:v1');
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

      expect(dataplane.config.KEYCLOAK_IMAGE).toBe('quay.io/keycloak/keycloak:latest');
      expect(dataplane.config.ECS_TASK_CPU).toBe(4096);
    });

    test('uses provided config values', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          KEYCLOAK_IMAGE: 'custom-image:v2',
          ECS_TASK_CPU: 2048,
          DOMAIN_INTERNET_FACING: false,
        }),
      });

      expect(dataplane.config.KEYCLOAK_IMAGE).toBe('custom-image:v2');
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

    test('config Lambda has dependencies on service and database', () => {
      const dataplane = new Dataplane(stack, 'Dataplane', {
        account: createTestAccount(),
        vpc,
        securityGroup,
        config: new DataplaneConfig({
          DOMAIN_INTERNET_FACING: false,
          KEYCLOAK_AUTH_CONFIG: createTestAuthConfig(),
        }),
      });

      // Verify dependencies are set
      const configLambdaDeps = dataplane.configLambda!.node.dependencies;
      expect(configLambdaDeps.length).toBeGreaterThan(0);
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
