/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { KeycloakStack } from '../lib/keycloak-stack';
import { AppConfig } from '../lib/config/app-config';

describe('KeycloakStack', () => {
  // Create a minimal test config for internal deployment
  const testConfig = new AppConfig('test-keycloak', {
    projectName: 'test-keycloak',
    account: '123456789012',
    region: 'us-west-2',
    isProd: false,
    domain: {
      hostname: 'test-auth.internal.local',
      internetFacing: false, // Set to internal deployment for basic tests
    },
    database: {
      instanceType: 'r5.large',
    },
    keycloak: {
      adminUsername: 'keycloak',
      container: {
        cpu: 1024,
        memory: 2048,
        minCount: 1,
        maxCount: 2,
      },
    },
  });

  test('Stack contains VPC', () => {
    const app = new cdk.App();

    // Create the stack with the test configuration
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });

    // Prepare the stack for assertions
    const template = Template.fromStack(stack);

    // Verify that the stack contains a VPC
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('Stack contains RDS Aurora Cluster', () => {
    const app = new cdk.App();
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });
    const template = Template.fromStack(stack);

    // Verify that the stack contains an RDS cluster
    template.resourceCountIs('AWS::RDS::DBCluster', 1);

    // Verify that the cluster is the correct engine type
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-mysql',
    });
  });

  test('Stack contains ECS Fargate Service', () => {
    const app = new cdk.App();
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });
    const template = Template.fromStack(stack);

    // Verify that the stack contains an ECS service
    template.resourceCountIs('AWS::ECS::Service', 1);

    // Verify that the service uses Fargate launch type
    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
    });
  });

  test('Stack contains Application Load Balancer', () => {
    const app = new cdk.App();
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });
    const template = Template.fromStack(stack);

    // Verify that the stack contains an ALB
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('Stack creates Secrets Manager secrets', () => {
    const app = new cdk.App();
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });
    const template = Template.fromStack(stack);

    // Verify that the stack creates secrets in Secrets Manager (database + keycloak admin secrets)
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  test('Stack creates expected outputs', () => {
    const app = new cdk.App();
    const stack = new KeycloakStack(app, 'TestKeycloakStack', { config: testConfig });
    const template = Template.fromStack(stack);

    // Verify that the stack creates outputs
    template.hasOutput('*', {
      // Using loose matching here since we want to ensure at least one output exists
    });
  });

  describe('InternetFacing Configuration', () => {
    test('Internet-facing deployment requires all domain properties', () => {
      expect(() => {
        new AppConfig('test-keycloak', {
          projectName: 'test-keycloak',
          domain: {
            hostname: 'test-auth.example.com',
            internetFacing: true,
            // Missing hostedZoneId and certificateArn
          },
        });
      }).toThrow('Domain hostedZoneId is required for internet-facing deployments');
    });

    test('Internet-facing deployment with default hostname throws error', () => {
      expect(() => {
        new AppConfig('test-keycloak', {
          projectName: 'test-keycloak',
          domain: {
            hostname: 'auth.example.com', // Default hostname
            internetFacing: true,
            hostedZoneId: 'Z123456789',
            certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test',
          },
        });
      }).toThrow(
        'Domain hostname is required for internet-facing deployments and cannot be the default value',
      );
    });

    test('Internal deployment only requires hostname', () => {
      expect(() => {
        const config = new AppConfig('test-keycloak', {
          projectName: 'test-keycloak',
          domain: {
            hostname: 'internal-auth.local',
            internetFacing: false,
            // hostedZoneId and certificateArn not required
          },
        });
        expect(config.env.domain.hostname).toBe('internal-auth.local');
        expect(config.env.domain.internetFacing).toBe(false);
      }).not.toThrow();
    });

    test('Internal ALB is created correctly', () => {
      const app = new cdk.App();
      const internalConfig = new AppConfig('test-keycloak', {
        projectName: 'test-keycloak',
        domain: {
          hostname: 'internal-auth.local',
          internetFacing: false,
        },
        database: {
          instanceType: 'r5.large',
        },
        keycloak: {
          adminUsername: 'keycloak',
          container: {
            cpu: 1024,
            memory: 2048,
            minCount: 1,
            maxCount: 2,
          },
        },
      });

      const stack = new KeycloakStack(app, 'InternalKeycloakStack', { config: internalConfig });
      const template = Template.fromStack(stack);

      // Verify ALB is created as internal (not internet-facing)
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internal',
      });

      // Verify HTTP listener is created (no HTTPS since no certificate)
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Protocol: 'HTTP',
        Port: 80,
      });

      // Verify no Route53 record is created (no hostedZoneId)
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    test('Internet-facing ALB with HTTPS is created correctly', () => {
      const app = new cdk.App();
      const internetConfig = new AppConfig('test-keycloak', {
        projectName: 'test-keycloak',
        domain: {
          hostname: 'public-auth.example.com',
          internetFacing: true,
          hostedZoneId: 'Z123456789',
          certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert',
        },
        database: {
          instanceType: 'r5.large',
        },
        keycloak: {
          adminUsername: 'keycloak',
          container: {
            cpu: 1024,
            memory: 2048,
            minCount: 1,
            maxCount: 2,
          },
        },
      });

      const stack = new KeycloakStack(app, 'InternetKeycloakStack', { config: internetConfig });
      const template = Template.fromStack(stack);

      // Verify ALB is created as internet-facing
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
      });

      // Verify HTTPS listener is created
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Protocol: 'HTTPS',
        Port: 443,
        Certificates: [
          {
            CertificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert',
          },
        ],
      });

      // Verify Route53 record is created
      template.resourceCountIs('AWS::Route53::RecordSet', 1);
    });

    test('Default internetFacing is true for backward compatibility', () => {
      const config = new AppConfig('test-keycloak', {
        projectName: 'test-keycloak',
        account: '123456789012',
        region: 'us-west-2',
        isProd: false,
        domain: {
          hostname: 'test-auth.example.com',
          hostedZoneId: 'Z123456789',
          certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test',
          // internetFacing not specified, should default to true
        },
        database: {
          instanceType: 'r5.large',
        },
        keycloak: {
          adminUsername: 'keycloak',
          container: {
            cpu: 1024,
            memory: 2048,
            minCount: 1,
            maxCount: 2,
          },
        },
      });

      expect(config.env.domain.internetFacing).toBe(true);
    });
  });
});
